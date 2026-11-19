'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const REPLACE_IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif', 'gif', 'tif', 'tiff']);

function collectCandidateImages(replaceDir, replaceFiles) {
  const candidates = [];
  const seen = new Set();
  const addFile = (filePath, priorityBoost = 0) => {
    const abs = path.resolve(filePath);
    const key = abs.toLowerCase();
    if (seen.has(key)) return;
    let st;
    try { st = fs.statSync(abs); } catch { return; }
    if (!st.isFile()) return;
    const ext = path.extname(abs).slice(1).toLowerCase();
    if (!REPLACE_IMG_EXTS.has(ext)) return;
    seen.add(key);
    candidates.push({
      path: abs,
      filename: path.basename(abs),
      stem: path.basename(abs, path.extname(abs)),
      ext,
      mtimeMs: st.mtimeMs,
      ctimeMs: st.ctimeMs,
      size: st.size,
      priorityBoost,
    });
  };

  if (Array.isArray(replaceFiles)) {
    for (const f of replaceFiles) if (typeof f === 'string' && f) addFile(f, 2);
  }

  if (replaceDir && fs.existsSync(replaceDir)) {
    const scanDir = (dir, boost) => {
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (name.startsWith('.')) continue;
        addFile(path.join(dir, name), boost);
      }
    };
    scanDir(replaceDir, 0);
    const subOut = path.join(replaceDir, 'output');
    if (fs.existsSync(subOut)) scanDir(subOut, 1);
  }

  return candidates;
}

function readManifestNear(replaceDir, replaceFiles) {
  const dirsToCheck = [];
  if (replaceDir) {
    dirsToCheck.push(replaceDir);
    dirsToCheck.push(path.dirname(replaceDir));
  }
  const firstFile = Array.isArray(replaceFiles)
    ? replaceFiles.find((file) => typeof file === 'string' && file)
    : null;
  if (firstFile) {
    const d = path.dirname(firstFile);
    dirsToCheck.push(d);
    dirsToCheck.push(path.dirname(d));
  }
  for (const dir of dirsToCheck) {
    if (!dir) continue;
    const mp = path.join(dir, '.vgt-manifest.json');
    try {
      if (fs.existsSync(mp)) {
        return JSON.parse(fs.readFileSync(mp, 'utf8'));
      }
    } catch {}
  }
  return null;
}

function fingerprintReplacements({ replaceDir = '', replaceFiles = [] } = {}) {
  const candidates = collectCandidateImages(replaceDir, replaceFiles);
  const manifest = readManifestNear(replaceDir, replaceFiles);
  const files = candidates.map(({ path, mtimeMs, ctimeMs, size, priorityBoost }) => [path, mtimeMs, ctimeMs, size, priorityBoost]);
  return createHash('sha256').update(JSON.stringify({ files, manifest })).digest('hex');
}

module.exports = { collectCandidateImages, readManifestNear, fingerprintReplacements };
