'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { registerCancelableTask, throwIfTaskCancelled } = require('./runner');

function runPowerShellOcrScript(psScript, envVars, taskId, onLine) {
  throwIfTaskCancelled(taskId);
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      {
        windowsHide: true,
        env: { ...process.env, ...envVars },
      },
    );
    const release = registerCancelableTask(taskId, () => {
      child.__cancelled = true;
      if (!child.pid) return;
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', () => child.kill());
    });

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
      release();
      reject(err);
    });

    child.on('close', (code) => {
      release();
      if (lineBuf.trim()) onLine?.(lineBuf.trim());
      if (child.__cancelled) return reject(new Error('任务已取消'));
      if (code === 0) return resolve(stdout);
      reject(new Error(stderr.trim() || `WinRT OCR 执行失败（退出码 ${code}）`));
    });
  });
}

function cleanOcrLineText(text) {
  return String(text || '')
    .replace(/([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])\s+(?=[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

async function runWinRtOcrOnImages(imagePaths, { ocrLang = 'auto', taskId = null, onProgress = null, includeBounds = false } = {}) {
  if (!imagePaths.length) return [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_ocr_'));
  const listPath = path.join(tmpDir, 'images.json');
  const outJsonPath = path.join(tmpDir, 'ocr_result.json');

  const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.FileAccessMode,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapTransform,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapPixelFormat,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapAlphaMode,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.ExifOrientationMode,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.ColorManagementMode,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime] | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
})[0]
function AwaitOp($op, [Type]$t) {
  $task = $asTaskGeneric.MakeGenericMethod($t).Invoke($null, @($op))
  try { $task.Wait() } catch {
    throw ("Windows OCR {0} failed (0x{1:X8})" -f $t.Name, $_.Exception.GetBaseException().HResult)
  }
  return $task.Result
}

$avail = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages)
if ($avail.Count -eq 0) {
  throw '系统未安装任何 Windows 离线 OCR 语言包'
}

$langMode = $env:VGT_OCR_LANG
$chosenLang = $null
if ($langMode -eq 'en') {
  $chosenLang = $avail | Where-Object { $_.LanguageTag -like 'en*' } | Select-Object -First 1
} else {
  $chosenLang = $avail | Where-Object { $_.LanguageTag -like 'zh-Hans*' } | Select-Object -First 1
  if (-not $chosenLang) {
    $chosenLang = $avail | Where-Object { $_.LanguageTag -like 'zh*' } | Select-Object -First 1
  }
}

$engine = $null
if ($chosenLang) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($chosenLang)
}
if (-not $engine) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if (-not $engine) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($avail[0])
}
if (-not $engine) {
  throw '无法初始化 Windows 离线 OCR 引擎'
}

$maxDim = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension
$pathsRaw = [System.IO.File]::ReadAllText($env:VGT_OCR_LIST, [System.Text.UTF8Encoding]::new($false))
$imgPaths = @((ConvertFrom-Json $pathsRaw).paths)
$total = [Math]::Max(1, $imgPaths.Count)
$pagesOut = @()

for ($idx = 0; $idx -lt $imgPaths.Count; $idx++) {
  $imgPath = [string]$imgPaths[$idx]
  $file = AwaitOp ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imgPath)) ([Windows.Storage.StorageFile])
  $stream = AwaitOp ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = AwaitOp ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $pw = [int]$decoder.PixelWidth
    $ph = [int]$decoder.PixelHeight
    if ($pw -gt $maxDim -or $ph -gt $maxDim) {
      $scale = [Math]::Min($maxDim / [double]$pw, $maxDim / [double]$ph)
      $tr = New-Object Windows.Graphics.Imaging.BitmapTransform
      $tr.ScaledWidth = [uint32][Math]::Max(1, [Math]::Floor($pw * $scale))
      $tr.ScaledHeight = [uint32][Math]::Max(1, [Math]::Floor($ph * $scale))
      $bmp = AwaitOp ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $tr, [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation, [Windows.Graphics.Imaging.ColorManagementMode]::ColorManageToSRgb)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    } else {
      $bmp = AwaitOp ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    }
    try {
      $res = AwaitOp ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
      $lines = @()
      foreach ($ln in $res.Lines) {
        $words = @($ln.Words)
        $r = if ($words.Count -gt 0) { $words[0].BoundingRect } else { $null }
        $line = @{
          text = [string]$ln.Text
          x = if ($r) { [double]$r.X } else { 0 }
          y = if ($r) { [double]$r.Y } else { 0 }
          h = if ($r) { [double]$r.Height } else { 18 }
        }
        if ($env:VGT_OCR_BOUNDS -eq '1' -and $r) {
          $left = [double]$r.X
          $top = [double]$r.Y
          $right = [double]$r.X + $r.Width
          $bottom = [double]$r.Y + $r.Height
          foreach ($word in $words) {
            $box = $word.BoundingRect
            $left = [Math]::Min($left, $box.X)
            $top = [Math]::Min($top, $box.Y)
            $right = [Math]::Max($right, $box.X + $box.Width)
            $bottom = [Math]::Max($bottom, $box.Y + $box.Height)
          }
          $line.bounds = @(
            ($left / $bmp.PixelWidth), ($top / $bmp.PixelHeight),
            ($right / $bmp.PixelWidth), ($bottom / $bmp.PixelHeight)
          )
        }
        $lines += $line
      }
      $pagesOut += @{ lines = $lines }
    } finally {
      $bmp.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
  [Console]::Out.WriteLine("OCR_DONE:$($idx + 1)/$total")
  [Console]::Out.Flush()
}

$payload = @{ pages = $pagesOut }
$json = ConvertTo-Json -InputObject $payload -Depth 6
[System.IO.File]::WriteAllText($env:VGT_OCR_OUT, $json, [System.Text.UTF8Encoding]::new($false))
`;

  try {
    fs.writeFileSync(listPath, JSON.stringify({ paths: imagePaths.map((p) => path.resolve(p)) }), 'utf8');
    await runPowerShellOcrScript(
      psScript,
      {
        VGT_OCR_LIST: listPath,
        VGT_OCR_OUT: outJsonPath,
        VGT_OCR_LANG: ocrLang || 'auto',
        VGT_OCR_BOUNDS: includeBounds ? '1' : '0',
      },
      taskId,
      (line) => {
        const m = line.match(/^OCR_DONE:(\d+)\/(\d+)$/);
        if (m) {
          onProgress?.(parseInt(m[1], 10) / Math.max(1, parseInt(m[2], 10)));
        }
      },
    );

    const parsed = JSON.parse(fs.readFileSync(outJsonPath, 'utf8'));
    const pages = Array.isArray(parsed?.pages) ? parsed.pages : [];
    return pages.map((pg) => (Array.isArray(pg?.lines) ? pg.lines : []));
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { cleanOcrLineText, runWinRtOcrOnImages };
