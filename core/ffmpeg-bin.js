'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BINARIES = ['ffmpeg.exe', 'ffprobe.exe'];
const EXTRACTED_META_FILE = '.extracted.json';

function resolveBinDir() {
  const hasBin = (dir) => BINARIES.some(
    (name) => fs.existsSync(path.join(dir, name)) || fs.existsSync(path.join(dir, `${name}.br`)),
  );
  if (process.env.VGT_RESOURCES_PATH) {
    const resBin = path.join(process.env.VGT_RESOURCES_PATH, 'bin');
    if (hasBin(resBin)) return resBin;
  }
  if (__dirname.includes('app.asar')) {
    if (process.resourcesPath) {
      return path.join(process.resourcesPath, 'bin');
    }
    const m = __dirname.match(/^(.*?)[\\/]app\.asar(?:[\\/]|$)/i);
    if (m && m[1]) {
      return path.join(m[1], 'bin');
    }
  }
  if (process.resourcesPath && !process.defaultApp) {
    const resBin = path.join(process.resourcesPath, 'bin');
    if (hasBin(resBin)) return resBin;
  }
  if (process.env.VGT_APP_ROOT) {
    const appBin = path.join(process.env.VGT_APP_ROOT, 'bin');
    if (hasBin(appBin)) return appBin;
  }
  return path.join(__dirname, '..', 'bin');
}

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readManifest(binDir) {
  return readJsonSafe(path.join(binDir, 'binaries.json'));
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function isBinaryValid(exePath, name, expected, extractedMeta, { verify = false } = {}) {
  if (!fs.existsSync(exePath)) return false;
  let stat;
  try {
    stat = fs.statSync(exePath);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size < 1024 * 1024) return false;
  if (extractedMeta?.[name]?.brSize && expected?.brSize && extractedMeta[name].brSize !== expected.brSize) {
    return false;
  }
  if (verify && expected?.sha256 && expected?.size === stat.size && sha256File(exePath) !== expected.sha256) {
    return false;
  }
  return true;
}

function writeExtractedMeta(binDir, extractedMeta) {
  try {
    fs.writeFileSync(path.join(binDir, EXTRACTED_META_FILE), JSON.stringify(extractedMeta, null, 2) + '\n', 'utf8');
  } catch {}
}

function extractBinary(binDir, name, expected, logger) {
  const exePath = path.join(binDir, name);
  const brPath = path.join(binDir, `${name}.br`);
  if (!fs.existsSync(brPath)) return null;

  logger?.(`[ffmpeg-bin] 正在解压内置 ${name}...`);
  const compressed = fs.readFileSync(brPath);
  const raw = zlib.brotliDecompressSync(compressed);
  if (expected?.size && raw.length !== expected.size) {
    throw new Error(`内置 ${name} 解压体积异常（期望 ${expected.size} 字节，实际 ${raw.length} 字节）`);
  }
  if (expected?.sha256 && sha256Buffer(raw) !== expected.sha256) {
    throw new Error(`内置 ${name} SHA-256 校验失败，请检查 ${path.basename(brPath)} 是否完整`);
  }

  fs.mkdirSync(binDir, { recursive: true });
  const tmpPath = path.join(binDir, `${name}.tmp.${process.pid}.${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, raw);
    try {
      fs.renameSync(tmpPath, exePath);
    } catch (err) {
      if (isBinaryValid(exePath, name, expected, null, { verify: false })) {
        return { brSize: compressed.length, exeSize: raw.length };
      }
      throw err;
    }
  } finally {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }
  logger?.(`[ffmpeg-bin] 已就绪 ${name} (${(raw.length / 1048576).toFixed(1)} MB)`);
  return { brSize: compressed.length, exeSize: raw.length };
}

function ensureBinaries({ force = false, verify = false, strict = true, logger = null } = {}) {
  const binDir = resolveBinDir();
  const manifest = readManifest(binDir);
  const metaPath = path.join(binDir, EXTRACTED_META_FILE);
  const extractedMeta = readJsonSafe(metaPath) || {};
  let metaDirty = false;
  const missing = [];

  for (const name of BINARIES) {
    const exePath = path.join(binDir, name);
    const expected = manifest?.[name];
    if (!force && isBinaryValid(exePath, name, expected, extractedMeta, { verify })) continue;

    const extracted = extractBinary(binDir, name, expected, logger);
    if (extracted) {
      extractedMeta[name] = extracted;
      metaDirty = true;
    } else if (!isBinaryValid(exePath, name, expected, null, { verify: false })) {
      missing.push(name);
    }
  }

  if (metaDirty) {
    writeExtractedMeta(binDir, extractedMeta);
  }

  if (strict && missing.length) {
    throw new Error(
      `ffmpeg 二进制缺失（${missing.join('、')}）：${binDir} 目录需要包含 ffmpeg.exe 和 ffprobe.exe`,
    );
  }

  return { binDir, ready: missing.length === 0, missing };
}

module.exports = {
  BINARIES,
  resolveBinDir,
  readManifest,
  sha256Buffer,
  sha256File,
  ensureBinaries,
};
