'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
let AsyncLocalStorageCls = null;
try {
  ({ AsyncLocalStorage: AsyncLocalStorageCls } = require('async_hooks'));
} catch {}
const { isImagePath, isSvgPath, isDocPath, isHtmlPath, parseSvgDims, mapConcurrent } = require('./utils');
const { inspectDocument } = require('./doc-parser');
const { resolveBinDir, ensureBinaries: ensureFfmpegBinaries } = require('./ffmpeg-bin');

// 使用项目自带的新版 ffmpeg（gyan 9.0.2）。
// 不用 ffmpeg-static：其内置的 ffmpeg 6.1 存在动画 WebP 编码缺陷（输出文件损坏）。
// 开发态位于 <项目>/bin/（缺失时自动从内置 .br 解压）；打包后由 extraResources 放在 <exe目录>/resources/bin/。
const binDir = resolveBinDir();

const FFMPEG = path.join(binDir, 'ffmpeg.exe');
const FFPROBE = path.join(binDir, 'ffprobe.exe');

// 尝试在加载阶段自动补全（仅当存在内置 .br 压缩包时解压，不会在缺少二进制时直接抛错）
try {
  ensureFfmpegBinaries({ strict: false });
} catch {}

function ensureBinaries(opts) {
  return ensureFfmpegBinaries({ strict: true, ...opts });
}

function assertBinaries() {
  ensureBinaries();
}

// ---------------------------------------------------------------------------
// ffprobe：读取媒体信息（SVG 通过 XML/Resvg 读取，DOCX/MD 通过文档解析读取）
// ---------------------------------------------------------------------------

function probeDoc(filePath) {
  const size = fs.statSync(filePath).size;
  const parsed = inspectDocument(filePath);
  return {
    duration: 0,
    size,
    width: 0,
    height: 0,
    fps: 0,
    isImage: false,
    isSvg: false,
    isDoc: true,
    docType: parsed.docType,
    imageCount: parsed.stats.imageCount ?? parsed.stats.total,
    videoCount: parsed.stats.videoCount || 0,
    docStats: parsed.stats,
    sections: parsed.sections || [],
    hasAudio: false,
    hasSubtitles: false,
    subCount: 0,
  };
}

function probeSvg(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  if (!/<svg[\s>]/i.test(text)) {
    throw new Error('无效的 SVG 文件（未找到 <svg> 标签）');
  }
  const size = fs.statSync(filePath).size;
  let { width, height } = parseSvgDims(text);
  if (!width || !height) {
    try {
      const { Resvg } = require('@resvg/resvg-js');
      const r = new Resvg(text);
      width = r.width || width || 300;
      height = r.height || height || 150;
    } catch {
      width = width || 300;
      height = height || 150;
    }
  }
  return {
    duration: 0,
    size,
    width,
    height,
    fps: 0,
    isImage: true,
    isSvg: true,
    hasAudio: false,
    hasSubtitles: false,
    subCount: 0,
  };
}

function extractPdfPagesCount(text) {
  let maxCount = 0;
  let m;
  const re1 = /\/Type\s*\/Pages\b(?:(?!endobj)[\s\S]){0,4096}?\/Count\s+(\d+)/g;
  while ((m = re1.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (n > maxCount) maxCount = n;
  }
  const re2 = /\/Count\s+(\d+)(?:(?!endobj)[\s\S]){0,1024}?\/Type\s*\/Pages\b/g;
  while ((m = re2.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (n > maxCount) maxCount = n;
  }
  return maxCount;
}

async function probePdf(filePath) {
  const PDF_SMALL_LIMIT = 16 * 1024 * 1024;
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    const size = stat.size;

    const headProbe = Buffer.allocUnsafe(Math.min(1024, size));
    let headRead = 0;
    if (headProbe.length > 0) {
      const r = await fh.read(headProbe, 0, headProbe.length, 0);
      headRead = r.bytesRead;
    }
    if (headRead < 5 || headProbe.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('无效的 PDF 文件（缺少 %PDF- 文件头）');
    }

    let pageCount = 0;
    if (size <= PDF_SMALL_LIMIT) {
      const buf = await fs.promises.readFile(filePath);
      const text = buf.toString('latin1');
      const pageMatches = text.match(/\/Type\s*\/Page\b(?!s)/g);
      pageCount = pageMatches ? pageMatches.length : 0;
      if (!pageCount) {
        pageCount = extractPdfPagesCount(text);
      }
    } else {
      // 大文件：先检查首尾 512KB 中的 /Type /Pages ... /Count N，避免整文件读入内存
      const edgeSize = Math.min(512 * 1024, size);
      const edgeBuf = Buffer.allocUnsafe(edgeSize);
      const hRes = await fh.read(edgeBuf, 0, edgeSize, 0);
      pageCount = extractPdfPagesCount(edgeBuf.subarray(0, hRes.bytesRead).toString('latin1'));

      if (!pageCount && size > edgeSize) {
        const tailPos = Math.max(0, size - edgeSize);
        const tRes = await fh.read(edgeBuf, 0, edgeSize, tailPos);
        pageCount = extractPdfPagesCount(edgeBuf.subarray(0, tRes.bytesRead).toString('latin1'));
      }

      // 回退到固定块流式扫描，内存恒定 ~1MB
      if (!pageCount) {
        const CHUNK_SIZE = 1024 * 1024;
        const OVERLAP = 64;
        const chunkBuf = Buffer.allocUnsafe(CHUNK_SIZE + OVERLAP);
        let pos = 0;
        let carryLen = 0;
        let countedPages = 0;
        let maxPages = 0;
        while (pos < size) {
          const toRead = Math.min(CHUNK_SIZE, size - pos);
          const { bytesRead } = await fh.read(chunkBuf, carryLen, toRead, pos);
          if (bytesRead <= 0) break;
          const totalLen = carryLen + bytesRead;
          const hasMore = pos + bytesRead < size;
          const scanEnd = hasMore ? totalLen - OVERLAP : totalLen;
          const text = chunkBuf.subarray(0, totalLen).toString('latin1');
          const re = /\/Type\s*\/Page\b(?!s)/g;
          let m;
          while ((m = re.exec(text)) !== null) {
            if (m.index < scanEnd) countedPages++;
          }
          const c = extractPdfPagesCount(text);
          if (c > maxPages) maxPages = c;
          if (hasMore && totalLen >= OVERLAP) {
            chunkBuf.copy(chunkBuf, 0, totalLen - OVERLAP, totalLen);
            carryLen = OVERLAP;
          } else {
            carryLen = 0;
          }
          pos += bytesRead;
        }
        pageCount = countedPages || maxPages;
      }
    }

    return {
      duration: 0,
      size,
      width: 0,
      height: 0,
      fps: 0,
      isImage: false,
      isSvg: false,
      isDoc: true,
      docType: 'pdf',
      pageCount,
      imageCount: 0,
      videoCount: 0,
      hasAudio: false,
      hasSubtitles: false,
      subCount: 0,
    };
  } finally {
    await fh.close().catch(() => {});
  }
}

function probeHtml(filePath) {
  const size = fs.statSync(filePath).size;
  return {
    duration: 0,
    size,
    width: 0,
    height: 0,
    fps: 0,
    isImage: false,
    isSvg: false,
    isDoc: true,
    docType: 'html',
    imageCount: 0,
    videoCount: 0,
    hasAudio: false,
    hasSubtitles: false,
    subCount: 0,
  };
}

function probe(filePath) {
  const ext = path.extname(String(filePath || '')).slice(1).toLowerCase();
  if (ext === 'pdf') {
    return probePdf(filePath);
  }
  if (isHtmlPath(filePath)) {
    return Promise.resolve().then(() => probeHtml(filePath));
  }
  if (isDocPath(filePath) || ext === 'doc' || ext === 'ppt') {
    return Promise.resolve().then(() => probeDoc(filePath));
  }
  if (isSvgPath(filePath)) {
    return Promise.resolve().then(() => probeSvg(filePath));
  }
  return new Promise((resolve, reject) => {
    assertBinaries();
    const child = spawn(FFPROBE, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format', '-show_streams',
      filePath,
    ]);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', () => {
      try {
        const info = JSON.parse(out);
        const video = (info.streams || []).find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
          || (info.streams || []).find((s) => s.codec_type === 'video');
        let duration = parseFloat(info.format?.duration) || parseFloat(video?.duration) || 0;
        const fmtName = String(info.format?.format_name || '');
        const isApng = ext === 'apng' || /\bapng\b/.test(fmtName);
        const isImg = !isApng && (isImagePath(filePath) || (duration === 0 && /_pipe$|image2|webp|bmp|png|jpeg/.test(fmtName)));

        let fps = 0;
        if (!isImg) {
          const fr = video?.avg_frame_rate || video?.r_frame_rate;
          if (fr && fr !== '0/0') {
            const [n, d] = fr.split('/').map(Number);
            if (n > 0 && d > 0) fps = n / d;
          }
        }
        const subCount = (info.streams || []).filter((s) => s.codec_type === 'subtitle').length;
        const nbFrames = parseInt(video?.nb_frames, 10) || 0;
        if (duration === 0 && isApng && fps > 0 && nbFrames > 0) {
          duration = nbFrames / fps;
        }
        resolve({
          duration,
          size: parseInt(info.format?.size, 10) || 0,
          width: video?.width || 0,
          height: video?.height || 0,
          fps: isImg ? 0 : Math.round(fps * 100) / 100,
          nbFrames: isImg ? 0 : nbFrames,
          isImage: isImg,
          ...(isApng ? { isApng: true } : {}),
          isSvg: false,
          pixFmt: video?.pix_fmt || '',
          hasAudio: !isImg && (info.streams || []).some((s) => s.codec_type === 'audio'),
          hasSubtitles: subCount > 0,
          subCount,
        });
      } catch (e) {
        reject(new Error('无法读取该文件的媒体信息'));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// ffmpeg 执行器：进度解析 + 可取消
// ---------------------------------------------------------------------------

const runningTasks = new Map(); // taskId -> child process

function runFfmpeg(taskId, argsList, { totalDuration = 0, from = 0, to = 1, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostats', '-progress', 'pipe:1', '-y', ...argsList];
    const child = spawn(FFMPEG, args, { windowsHide: true });
    runningTasks.set(taskId, child);

    let stderrTail = '';
    let cancelled = false;

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const m = text.match(/out_time_us=(\d+)/) || text.match(/out_time_ms=(\d+)/);
      if (m && totalDuration > 0) {
        const ratio = from + (to - from) * Math.min(1, parseInt(m[1], 10) / 1e6 / totalDuration);
        onProgress?.(Math.min(ratio, 1));
      }
      if (text.includes('progress=end')) onProgress?.(to);
    });

    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });

    runningTasks.get(taskId).__cancel = () => { cancelled = true; };

    child.on('error', (err) => {
      runningTasks.delete(taskId);
      reject(err);
    });

    child.on('close', (code) => {
      runningTasks.delete(taskId);
      if (cancelled) {
        reject(new Error('任务已取消'));
      } else if (code === 0) {
        resolve();
      } else {
        const lines = stderrTail.split('\n').filter((l) => l.trim()).slice(-3).join('\n');
        reject(new Error(`ffmpeg 失败（退出码 ${code}）：\n${lines || '未知错误'}`));
      }
    });
  });
}

function runFfmpegCapture(taskId, argsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-y', ...argsList], { windowsHide: true });
    runningTasks.set(taskId, child);
    let stderr = '';
    let cancelled = false;
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-16000); });
    runningTasks.get(taskId).__cancel = () => { cancelled = true; };
    child.on('error', (err) => { runningTasks.delete(taskId); reject(err); });
    child.on('close', (code) => {
      runningTasks.delete(taskId);
      if (cancelled) return reject(new Error('任务已取消'));
      if (code === 0) return resolve(stderr);
      const lines = stderr.split('\n').filter((l) => l.trim()).slice(-3).join('\n');
      reject(new Error(`ffmpeg 失败（退出码 ${code}）：\n${lines || '未知错误'}`));
    });
  });
}

function runFfmpegBinary(taskId, argsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-y', ...argsList], { windowsHide: true });
    runningTasks.set(taskId, child);
    const chunks = [];
    let stderr = '';
    let cancelled = false;
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-8000); });
    runningTasks.get(taskId).__cancel = () => { cancelled = true; };
    child.on('error', (err) => { runningTasks.delete(taskId); reject(err); });
    child.on('close', (code) => {
      runningTasks.delete(taskId);
      if (cancelled) return reject(new Error('任务已取消'));
      if (code === 0) return resolve(Buffer.concat(chunks));
      const lines = stderr.split('\n').filter((l) => l.trim()).slice(-3).join('\n');
      reject(new Error(`ffmpeg 失败（退出码 ${code}）：\n${lines || '未知错误'}`));
    });
  });
}

function registerCancelableTask(taskId, cancelFn) {
  if (!taskId || typeof cancelFn !== 'function') return;
  runningTasks.set(taskId, { isCustom: true, cancel: cancelFn });
}

function unregisterTask(taskId) {
  const entry = runningTasks.get(taskId);
  if (entry && entry.isCustom) {
    runningTasks.delete(taskId);
  }
}

function cancelTask(taskId) {
  const entry = runningTasks.get(taskId);
  if (!entry) return false;
  if (entry.isCustom) {
    runningTasks.delete(taskId);
    try {
      entry.cancel?.();
    } catch {}
    return true;
  }
  entry.__cancel?.();
  spawn('taskkill', ['/pid', String(entry.pid), '/T', '/F'], { windowsHide: true });
  return true;
}

function hasRunningTasks() {
  return runningTasks.size > 0;
}

function cancelAllTasks() {
  for (const id of [...runningTasks.keys()]) {
    cancelTask(id);
  }
}

// ---------------------------------------------------------------------------
// 输出路径上下文与防覆盖（AsyncLocalStorage 并发安全）
// ---------------------------------------------------------------------------

const outCtxStorage = AsyncLocalStorageCls ? new AsyncLocalStorageCls() : null;
let _fallbackOutCtx = null;

function getCurrentOutCtx(explicitCtx) {
  if (explicitCtx !== undefined) return explicitCtx;
  return outCtxStorage ? (outCtxStorage.getStore() || null) : _fallbackOutCtx;
}

function resolveOutDir(inputPath, explicitCtx) {
  const ctx = getCurrentOutCtx(explicitCtx);
  const baseDir = path.dirname(inputPath);
  if (!ctx) return baseDir;
  if (ctx.mode === 'custom' && ctx.dir) {
    fs.mkdirSync(ctx.dir, { recursive: true });
    return ctx.dir;
  }
  if (ctx.mode === 'subdir') {
    const sub = path.join(baseDir, 'output');
    fs.mkdirSync(sub, { recursive: true });
    return sub;
  }
  return baseDir;
}

function uniquePath(targetPath, explicitCtx) {
  const ctx = getCurrentOutCtx(explicitCtx);
  if (!ctx?.noOverwrite || !fs.existsSync(targetPath)) return targetPath;
  const ext = path.extname(targetPath);
  const stem = targetPath.slice(0, targetPath.length - ext.length);
  let i = 1;
  while (fs.existsSync(`${stem}_${i}${ext}`)) i++;
  return `${stem}_${i}${ext}`;
}

function defaultOutput(inputPath, suffix, ext) {
  const dir = resolveOutDir(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  return uniquePath(path.join(dir, `${base}_${suffix}.${ext}`));
}

function defaultDirOutput(inputPath, suffix) {
  const dir = resolveOutDir(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  return uniquePath(path.join(dir, `${base}_${suffix}`));
}

function stampOutput(inputPath, prefix, ext) {
  const dir = resolveOutDir(inputPath);
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return uniquePath(path.join(dir, `${prefix}_${ts}.${ext}`));
}

// ---------------------------------------------------------------------------
// 硬件编码器探测
// ---------------------------------------------------------------------------

let _hwCache = null;

function testHwEncoder(enc) {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x64:d=0.1',
      '-frames:v', '1', '-c:v', enc, '-pix_fmt', 'yuv420p', '-f', 'null', '-',
    ], { windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(false); }, 3000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

async function detectHwEncoders() {
  if (_hwCache) return _hwCache;
  assertBinaries();
  const candidates = [
    'h264_nvenc', 'h264_qsv', 'h264_amf',
    'hevc_nvenc', 'hevc_qsv', 'hevc_amf',
    'av1_nvenc', 'av1_qsv', 'av1_amf',
  ];
  const flags = await mapConcurrent(candidates, 3, (enc) => testHwEncoder(enc));
  const available = candidates.filter((_, idx) => flags[idx]);
  _hwCache = {
    available,
    primary: available.find((e) => e.startsWith('h264_')) || null,
    primaryHevc: available.find((e) => e.startsWith('hevc_')) || null,
    primaryAv1: available.find((e) => e.startsWith('av1_')) || null,
  };
  return _hwCache;
}

function resolveHwVendor(hw) {
  if (!hw || hw === 'cpu') return null;
  if (hw === 'auto') return 'auto';
  if (hw === 'nvenc' || hw.endsWith('_nvenc')) return 'nvenc';
  if (hw === 'qsv' || hw.endsWith('_qsv')) return 'qsv';
  if (hw === 'amf' || hw.endsWith('_amf')) return 'amf';
  return null;
}

function videoCodecArgs(p, { crf = 20, preset = 'medium', codec } = {}) {
  const vcodec = codec || p?.vcodec || 'h264';
  const rawHw = p?.__hwAccel || 'cpu';
  const vendor = resolveHwVendor(rawHw);

  const pickVendorEncoder = (prefix, primaryKey) => {
    if (!vendor) return null;
    if (vendor === 'auto') return _hwCache?.[primaryKey] || null;
    const cand = `${prefix}_${vendor}`;
    if (_hwCache && !_hwCache.available.includes(cand)) return null;
    return cand;
  };

  if (vcodec === 'hevc') {
    const enc = pickVendorEncoder('hevc', 'primaryHevc');
    if (enc === 'hevc_nvenc') {
      return ['-c:v', 'hevc_nvenc', '-preset', 'p4', '-cq', String(crf + 2), '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1'];
    }
    if (enc === 'hevc_qsv') {
      return ['-c:v', 'hevc_qsv', '-preset', preset === 'fast' ? 'veryfast' : 'medium', '-global_quality', String(crf + 2), '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1'];
    }
    if (enc === 'hevc_amf') {
      return ['-c:v', 'hevc_amf', '-quality', preset === 'fast' ? 'speed' : 'balanced', '-rc', 'cqp', '-qp_i', String(crf + 2), '-qp_p', String(crf + 2), '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1'];
    }
    return ['-c:v', 'libx265', '-crf', String(crf + 4), '-preset', preset, '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1'];
  }

  if (vcodec === 'av1') {
    const enc = pickVendorEncoder('av1', 'primaryAv1');
    if (enc === 'av1_nvenc') {
      return ['-c:v', 'av1_nvenc', '-preset', 'p4', '-cq', String(crf + 4), '-pix_fmt', 'yuv420p'];
    }
    if (enc === 'av1_qsv') {
      return ['-c:v', 'av1_qsv', '-preset', preset === 'fast' ? 'veryfast' : 'medium', '-global_quality', String(crf + 4), '-pix_fmt', 'yuv420p'];
    }
    if (enc === 'av1_amf') {
      return ['-c:v', 'av1_amf', '-quality', preset === 'fast' ? 'speed' : 'balanced', '-rc', 'cqp', '-qp_i', String(crf + 4), '-qp_p', String(crf + 4), '-pix_fmt', 'yuv420p'];
    }
    return ['-c:v', 'libaom-av1', '-crf', String(crf + 10), '-b:v', '0', '-cpu-used', '6', '-row-mt', '1', '-pix_fmt', 'yuv420p'];
  }

  let hw = rawHw;
  if (hw === 'auto') hw = _hwCache?.primary || 'cpu';
  if (hw === 'h264_nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', String(crf), '-pix_fmt', 'yuv420p'];
  }
  if (hw === 'h264_qsv') {
    return ['-c:v', 'h264_qsv', '-preset', preset === 'fast' ? 'veryfast' : 'medium', '-global_quality', String(crf), '-pix_fmt', 'yuv420p'];
  }
  if (hw === 'h264_amf') {
    return ['-c:v', 'h264_amf', '-quality', preset === 'fast' ? 'speed' : 'balanced', '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf), '-pix_fmt', 'yuv420p'];
  }
  return ['-c:v', 'libx264', '-crf', String(crf), '-preset', preset, '-pix_fmt', 'yuv420p'];
}

// ---------------------------------------------------------------------------
// 任务执行分发器
// ---------------------------------------------------------------------------

// 单文件输出的 steps 型任务：把最后一步里的最终输出路径换成同目录临时文件（保留扩展名，ffmpeg 靠它推断容器格式），
// 返回临时路径；无法确定「args 里恰好出现一次 plan.output 且它是文件」时返回 null，保持原行为。
function swapOutputToTemp(plan) {
  const out = plan.output;
  if (typeof out !== 'string' || plan.outputType === 'dir' || out.includes('%')) return null;
  const hits = [];
  for (const step of plan.steps) {
    step.args.forEach((a, i) => { if (a === out) hits.push({ step, i }); });
  }
  if (hits.length !== 1) return null;
  const { step, i } = hits[0];
  if (step !== plan.steps[plan.steps.length - 1] || step.args[i - 1] === '-i') return null;
  try {
    if (fs.statSync(out).isDirectory()) return null;
  } catch {}
  const ext = path.extname(out);
  const tmp = `${out.slice(0, out.length - ext.length)}.tmp-${crypto.randomBytes(4).toString('hex')}${ext}`;
  step.args[i] = tmp;
  return tmp;
}

function createExecutor(builders) {
  return async function executeTask(taskId, feature, params, onProgress) {
    assertBinaries();
    const builder = builders[feature];
    if (!builder) throw new Error(`未知功能：${feature}`);

    if (params?.__hwAccel && params.__hwAccel !== 'cpu' && !_hwCache) {
      await detectHwEncoders().catch(() => {});
    }

    const outCtx = (params?.__outputMode || params?.__noOverwrite)
      ? { mode: params.__outputMode || 'same', dir: params.__outputDir || '', noOverwrite: !!params.__noOverwrite }
      : null;

    const runWithOutCtx = (fn) => {
      if (outCtxStorage) return outCtxStorage.run(outCtx, fn);
      const prev = _fallbackOutCtx;
      _fallbackOutCtx = outCtx;
      return Promise.resolve().then(fn).finally(() => { _fallbackOutCtx = prev; });
    };

    return runWithOutCtx(async () => {
      const plan = builder(params);

      if (plan.run) {
        const result = await plan.run(taskId, onProgress);
        return result || { output: plan.output };
      }

      const tmpOut = swapOutputToTemp(plan);
      try {
        for (const step of plan.steps) {
          await runFfmpeg(taskId, step.args, { ...step, onProgress });
        }
        if (tmpOut) fs.renameSync(tmpOut, plan.output);
      } finally {
        // 失败/取消时删除临时文件；taskkill 后句柄可能稍晚释放，重试几次且不抛错
        if (tmpOut) await fs.promises.rm(tmpOut, { force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
        for (const f of plan.cleanup || []) {
          fs.unlink(f, () => {});
        }
        for (const d of plan.cleanupDirs || []) {
          fs.rmSync(d, { recursive: true, force: true });
        }
      }
      return { output: plan.output, outputType: plan.outputType };
    });
  };
}

module.exports = {
  FFMPEG,
  FFPROBE,
  ensureBinaries,
  probe,
  runFfmpeg,
  runFfmpegCapture,
  runFfmpegBinary,
  registerCancelableTask,
  unregisterTask,
  cancelTask,
  hasRunningTasks,
  cancelAllTasks,
  detectHwEncoders,
  videoCodecArgs,
  resolveOutDir,
  uniquePath,
  defaultOutput,
  defaultDirOutput,
  stampOutput,
  createExecutor,
};
