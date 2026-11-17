'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
  BINARIES,
  resolveBinDir,
  sha256Buffer,
  ensureBinaries,
} = require('../core/ffmpeg-bin');

function packBinaries(quality = 11) {
  const binDir = resolveBinDir();
  const manifest = {};

  for (const name of BINARIES) {
    const exePath = path.join(binDir, name);
    if (!fs.existsSync(exePath)) {
      throw new Error(`找不到 ${exePath}，无法生成压缩包`);
    }
    const raw = fs.readFileSync(exePath);
    console.log(`[ensure-ffmpeg] 正在 Brotli (quality=${quality}) 压缩 ${name} (${(raw.length / 1048576).toFixed(2)} MB)...`);
    const compressed = zlib.brotliCompressSync(raw, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality },
    });
    const brPath = path.join(binDir, `${name}.br`);
    fs.writeFileSync(brPath, compressed);
    manifest[name] = {
      size: raw.length,
      sha256: sha256Buffer(raw),
      brSize: compressed.length,
    };
    console.log(`[ensure-ffmpeg] 生成 ${name}.br (${(compressed.length / 1048576).toFixed(2)} MB)`);
  }

  const manifestPath = path.join(binDir, 'binaries.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`[ensure-ffmpeg] 已写入 ${manifestPath}`);
}

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args);
  if (flags.has('--pack')) {
    const qArg = args.find((a) => a.startsWith('--quality='));
    const quality = qArg ? Math.max(1, Math.min(11, parseInt(qArg.split('=')[1], 10) || 11)) : 11;
    packBinaries(quality);
    return;
  }

  const force = flags.has('--force');
  const res = ensureBinaries({
    force,
    verify: true,
    strict: true,
    logger: (msg) => console.log(msg),
  });
  if (res.ready && !force) {
    console.log(`[ensure-ffmpeg] FFmpeg 二进制已就绪：${res.binDir}`);
  }
}

main();
