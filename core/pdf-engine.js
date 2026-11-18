'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { spawn } = require('child_process');
const { registerCancelableTask, unregisterTask } = require('./runner');
const { writeBufferAtomically } = require('./utils');

const activePdfTasks = new Map(); // taskId -> ChildProcess

function cancelPdfTask(taskId) {
  const child = activePdfTasks.get(taskId);
  if (child) {
    child.__cancelled = true;
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch {}
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. 页码范围解析器
// ---------------------------------------------------------------------------

function parsePageRange(rangeStr, totalPages) {
  const total = Math.floor(Number(totalPages) || 0);
  if (total < 1) {
    throw new Error('PDF 总页数无效，无法解析页码范围');
  }
  const raw = String(rangeStr || '').trim();
  if (!raw || raw.toLowerCase() === 'all') {
    const all = [];
    for (let i = 1; i <= total; i++) all.push(i);
    return all;
  }

  const normalized = raw.replace(/[，、]/g, ',').replace(/[～~—–]/g, '-');
  const tokens = normalized.split(',').map((s) => s.trim());
  if (tokens.some((t) => !t)) {
    throw new Error(`页码范围格式有误（"${raw}"），请使用如 1-3, 5, 8- 的格式`);
  }

  const seen = new Set();
  const result = [];
  const addPage = (p) => {
    if (!seen.has(p)) {
      seen.add(p);
      result.push(p);
    }
  };

  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) {
      const n = parseInt(tok, 10);
      if (n < 1 || n > total) {
        throw new Error(`页码 ${n} 超出总页数范围（1-${total}）`);
      }
      addPage(n);
      continue;
    }

    const m = tok.match(/^(\d+)\s*-\s*(\d*)$/);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : total;
      if (start < 1 || start > total) {
        throw new Error(`起始页 ${start} 超出总页数范围（1-${total}）`);
      }
      if (end < 1 || end > total) {
        throw new Error(`结束页 ${end} 超出总页数范围（1-${total}）`);
      }
      if (start > end) {
        throw new Error(`页码范围 "${tok}" 无效：起始页不能大于结束页`);
      }
      for (let p = start; p <= end; p++) addPage(p);
      continue;
    }

    throw new Error(`无法识别的页码范围 "${tok}"，请使用如 1-3, 5, 8- 的格式`);
  }

  if (!result.length) {
    throw new Error('未解析出任何有效页码');
  }
  return result;
}

// JPEG 页面 PDF 组装
function getJpegDimensions(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 4 < buf.length) {
    while (pos < buf.length && buf[pos] !== 0xff) pos++;
    while (pos < buf.length && buf[pos] === 0xff) pos++;
    if (pos >= buf.length) break;
    const marker = buf[pos++];
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (pos + 2 > buf.length) break;
    const segLen = buf.readUInt16BE(pos);
    if (segLen < 2 || pos + segLen > buf.length) break;
    if (marker >= 0xc0 && marker <= 0xc3 && segLen >= 7) {
      const h = buf.readUInt16BE(pos + 3);
      const w = buf.readUInt16BE(pos + 5);
      if (w > 0 && h > 0) return { width: w, height: h };
    }
    pos += segLen;
  }
  return null;
}

function buildPdfFromJpegPages(pages, { pageSize = 'a4p', margin = 20 } = {}) {
  const n = pages.length;
  const totalObjs = 2 + n * 3;
  const kidsRefs = [];
  for (let i = 0; i < n; i++) kidsRefs.push(`${3 + i * 3} 0 R`);

  const chunks = [];
  const offsets = new Array(totalObjs + 1).fill(0);
  let byteLen = 0;

  const pushBuf = (b) => {
    chunks.push(b);
    byteLen += b.length;
  };
  const pushAscii = (s) => pushBuf(Buffer.from(s, 'latin1'));

  pushAscii('%PDF-1.4\n');
  pushBuf(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const writeObj = (id, bodyParts) => {
    offsets[id] = byteLen;
    pushAscii(`${id} 0 obj\n`);
    for (const part of bodyParts) {
      if (Buffer.isBuffer(part)) pushBuf(part);
      else pushAscii(part);
    }
    pushAscii('\nendobj\n');
  };

  writeObj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  writeObj(2, [`<< /Type /Pages /Kids [ ${kidsRefs.join(' ')} ] /Count ${n} >>`]);

  for (let i = 0; i < n; i++) {
    const { jpgBuf, width, height } = pages[i];
    const pageObjId = 3 + i * 3;
    const cntObjId = 4 + i * 3;
    const imgObjId = 5 + i * 3;

    let pageW;
    let pageH;
    if (pageSize === 'a4p') {
      pageW = 595.28;
      pageH = 841.89;
    } else if (pageSize === 'a4l') {
      pageW = 841.89;
      pageH = 595.28;
    } else {
      pageW = width * 0.75 + margin * 2;
      pageH = height * 0.75 + margin * 2;
    }

    const availW = Math.max(10, pageW - margin * 2);
    const availH = Math.max(10, pageH - margin * 2);
    const scale = Math.min(availW / width, availH / height);
    const drawW = width * scale;
    const drawH = height * scale;
    const drawX = (pageW - drawW) / 2;
    const drawY = (pageH - drawH) / 2;

    const contentStr = `q\n${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${drawX.toFixed(2)} ${drawY.toFixed(2)} cm\n/Im0 Do\nQ\n`;
    const contentBuf = Buffer.from(contentStr, 'latin1');

    writeObj(pageObjId, [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)}] /Resources << /XObject << /Im0 ${imgObjId} 0 R >> >> /Contents ${cntObjId} 0 R >>`,
    ]);
    writeObj(cntObjId, [
      `<< /Length ${contentBuf.length} >>\nstream\n`,
      contentBuf,
      '\nendstream',
    ]);
    writeObj(imgObjId, [
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpgBuf.length} >>\nstream\n`,
      jpgBuf,
      '\nendstream',
    ]);
  }

  const xrefOffset = byteLen;
  pushAscii(`xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`);
  for (let id = 1; id <= totalObjs; id++) {
    pushAscii(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }
  pushAscii(`trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Windows WinRT 离线 PDF 渲染
// ---------------------------------------------------------------------------

function runPowerShellPdfScript(psScript, envVars, taskId, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      {
        windowsHide: true,
        env: { ...process.env, ...envVars },
      },
    );
    if (taskId) {
      activePdfTasks.set(taskId, child);
      registerCancelableTask?.(taskId, () => cancelPdfTask(taskId));
    }

    let stdout = '';
    let stderr = '';
    let lineBuf = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      lineBuf += text;
      const lines = lineBuf.split(/\r?\n/);
      lineBuf = lines.pop() || '';
      for (const l of lines) {
        if (l.trim()) onLine?.(l.trim());
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8000);
    });

    child.on('error', (err) => {
      if (taskId) {
        activePdfTasks.delete(taskId);
        unregisterTask?.(taskId);
      }
      reject(err);
    });

    child.on('close', (code) => {
      if (taskId) {
        activePdfTasks.delete(taskId);
        unregisterTask?.(taskId);
      }
      if (lineBuf.trim()) onLine?.(lineBuf.trim());
      if (child.__cancelled) {
        return reject(new Error('任务已取消'));
      }
      if (code === 0) {
        return resolve(stdout);
      }
      reject(new Error(stderr.trim() || `WinRT PDF 执行失败（退出码 ${code}）`));
    });
  });
}

async function readPdfDocument(file) {
  try {
    const data = await fs.promises.readFile(file);
    const doc = await PDFDocument.load(data, { updateMetadata: false, throwOnInvalidObject: true });
    if (!doc.getPageCount()) throw new Error('文档没有页面');
    return doc;
  } catch (error) {
    throw new Error(`无法读取 PDF「${path.basename(file)}」：${error.message}`, { cause: error });
  }
}

async function getPdfPageCount(file) {
  return (await readPdfDocument(file)).getPageCount();
}

async function renderPdfViaWinRt(absInput, outDir, pages, scale, taskId, onProgress) {
  fs.mkdirSync(outDir, { recursive: true });
  const pagesCsv = pages && pages.length ? pages.join(',') : '';

  const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfPageRenderOptions,Windows.Data.Pdf,ContentType=WindowsRuntime] | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
})[0]
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
})[0]

function AwaitOp($op, [Type]$t) {
  $task = $asTaskGeneric.MakeGenericMethod($t).Invoke($null, @($op))
  $task.Wait()
  return $task.Result
}
function AwaitAct($act) {
  $task = $asTaskAction.Invoke($null, @($act))
  $task.Wait()
}

$inPath  = $env:VGT_PDF_INPUT
$outDir  = $env:VGT_PDF_OUTDIR
$scale   = [double]$env:VGT_PDF_SCALE
$rawPages = $env:VGT_PDF_PAGES

$file = AwaitOp ([Windows.Storage.StorageFile]::GetFileFromPathAsync($inPath)) ([Windows.Storage.StorageFile])
$pdf  = AwaitOp ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$totalPages = [int]$pdf.PageCount

if ([string]::IsNullOrWhiteSpace($rawPages)) {
  $pageList = @(1..$totalPages)
} else {
  $pageList = $rawPages.Split(',') | ForEach-Object { [int]$_.Trim() }
}

$count = $pageList.Count
for ($idx = 0; $idx -lt $count; $idx++) {
  $pNum = $pageList[$idx]
  if ($pNum -lt 1 -or $pNum -gt $totalPages) {
    throw "Page $pNum out of range (1..$totalPages)"
  }
  $page = $pdf.GetPage([uint32]($pNum - 1))
  try {
    $destW = [uint32][Math]::Min(6000, [Math]::Max(200, [Math]::Round($page.Size.Width * $scale)))
    $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $opts.DestinationWidth = $destW
    $memStream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    try {
      AwaitAct ($page.RenderToStreamAsync($memStream, $opts))
      $null = AwaitOp ($memStream.FlushAsync()) ([bool])
      $memStream.Seek(0)
      $netStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($memStream.GetInputStreamAt(0))
      try {
        $outName = "page_{0:D4}.png" -f ($idx + 1)
        $outFile = [System.IO.Path]::Combine($outDir, $outName)
        $fs = [System.IO.File]::Create($outFile)
        try {
          $netStream.CopyTo($fs)
        } finally {
          $fs.Dispose()
        }
      } finally {
        $netStream.Dispose()
      }
    } finally {
      $memStream.Dispose()
    }
  } finally {
    $page.Dispose()
  }
  [Console]::Out.WriteLine("PAGE_DONE:$($idx + 1)/$count")
  [Console]::Out.Flush()
}
`;

  const generatedFiles = [];
  await runPowerShellPdfScript(
    psScript,
    {
      VGT_PDF_INPUT: absInput,
      VGT_PDF_OUTDIR: outDir,
      VGT_PDF_SCALE: String(scale),
      VGT_PDF_PAGES: pagesCsv,
    },
    taskId,
    (line) => {
      const m = line.match(/^PAGE_DONE:(\d+)\/(\d+)$/);
      if (m) {
        const done = parseInt(m[1], 10);
        const total = Math.max(1, parseInt(m[2], 10));
        onProgress?.(done / total);
      }
    },
  );

  const count = pages && pages.length
    ? pages.length
    : fs.readdirSync(outDir).filter((f) => /^page_\d{4}\.png$/i.test(f)).length;

  for (let i = 1; i <= count; i++) {
    const fp = path.join(outDir, `page_${String(i).padStart(4, '0')}.png`);
    if (fs.existsSync(fp)) generatedFiles.push(fp);
  }
  if (!generatedFiles.length) {
    throw new Error('WinRT 未能导出任何 PDF 页面图像');
  }
  return generatedFiles;
}

async function renderPdfPagesToPngs(pdfPath, outDir, { pages = null, scale = 2, taskId = null, onProgress = null } = {}) {
  const safeScale = Math.min(Math.max(Number(scale) || 2, 1), 4);
  return renderPdfViaWinRt(path.resolve(pdfPath), outDir, pages, safeScale, taskId, onProgress);
}

async function appendPdfPages(destination, source, indices) {
  const pages = await destination.copyPages(source, indices);
  for (const page of pages) destination.addPage(page);
}

async function writePdf(doc, outputPath) {
  const data = await doc.save({ useObjectStreams: false });
  writeBufferAtomically(outputPath, data);
  return { output: outputPath, pageCount: doc.getPageCount(), outputSize: data.length };
}

async function mergePdfFiles(files, outputPath, { onProgress } = {}) {
  if (!Array.isArray(files) || files.length < 2) throw new Error('请至少选择 2 个 PDF 文件进行合并');
  const destination = await PDFDocument.create();
  for (let i = 0; i < files.length; i++) {
    const source = await readPdfDocument(files[i]);
    await appendPdfPages(destination, source, source.getPageIndices());
    onProgress?.(0.9 * (i + 1) / files.length);
  }
  const result = await writePdf(destination, outputPath);
  onProgress?.(1);
  return result;
}

async function extractPdfPages(pdfPath, pageNumbers, outputPath, { onProgress } = {}) {
  const source = await readPdfDocument(pdfPath);
  const destination = await PDFDocument.create();
  await appendPdfPages(destination, source, pageNumbers.map((page) => page - 1));
  onProgress?.(0.7);
  const result = await writePdf(destination, outputPath);
  onProgress?.(1);
  return result;
}

async function splitPdfIntoChunks(pdfPath, chunks, outDir, { onProgress } = {}) {
  const source = await readPdfDocument(pdfPath);
  const padLen = Math.max(3, String(chunks.length).length);
  const files = [];
  let totalSize = 0;
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(outDir), '.vgt-pdf-split-'));
  try {
    for (let i = 0; i < chunks.length; i++) {
      const name = `part_${String(i + 1).padStart(padLen, '0')}.pdf`;
      const destination = await PDFDocument.create();
      await appendPdfPages(destination, source, chunks[i].map((page) => page - 1));
      const result = await writePdf(destination, path.join(staging, name));
      files.push(path.join(outDir, name));
      totalSize += result.outputSize;
      onProgress?.(0.9 * (i + 1) / chunks.length);
    }
    fs.renameSync(staging, outDir);
    return { files, totalSize };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = {
  parsePageRange,
  getPdfPageCount,
  renderPdfPagesToPngs,
  buildPdfFromJpegPages,
  getJpegDimensions,
  mergePdfFiles,
  extractPdfPages,
  splitPdfIntoChunks,
  cancelPdfTask,
};
