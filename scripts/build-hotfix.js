'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const opts = {
    outDir: path.join(ROOT, 'release'),
    notes: '',
    repo: 'xxqwq/usefulTools',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out-dir' && argv[i + 1]) opts.outDir = path.resolve(argv[++i]);
    else if (a === '--notes' && argv[i + 1]) opts.notes = argv[++i];
    else if (a === '--repo' && argv[i + 1]) opts.repo = argv[++i];
  }
  return opts;
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function walkFiles(baseDir, relPrefix, list, { excludeRel = new Set() } = {}) {
  if (!fs.existsSync(baseDir)) return;
  const entries = fs.readdirSync(baseDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(baseDir, ent.name);
    const rel = `${relPrefix}/${ent.name}`;
    if (ent.isDirectory()) {
      walkFiles(full, rel, list, { excludeRel });
    } else if (ent.isFile()) {
      if (!excludeRel.has(rel)) list.push({ full, rel });
    }
  }
}

function resolveGitNotes(version) {
  try {
    const tagsRaw = execFileSync('git', ['tag', '--sort=-v:refname'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const tags = tagsRaw ? tagsRaw.split(/\r?\n/).filter((t) => t && t !== `v${version}`) : [];
    const range = tags.length ? `${tags[0]}..HEAD` : '-n5';
    const args = tags.length
      ? ['log', range, '--pretty=format:- %s']
      : ['log', '-n', '5', '--pretty=format:- %s'];
    const out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
    const lines = out.split(/\r?\n/).filter((l) => !/^-\s*chore:\s*release\s+v/i.test(l));
    return lines.slice(0, 8).join('\n');
  } catch {
    return '';
  }
}

function buildHotfix(opts = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = String(pkg.version || '').replace(/^v/i, '');
  const shellVersion = String(pkg.shellVersion || version).replace(/^v/i, '');
  const outDir = opts.outDir || path.join(ROOT, 'release');
  const repo = opts.repo || 'xxqwq/usefulTools';

  const items = [];
  const ffmpegEntry = path.join(ROOT, 'ffmpeg.js');
  if (fs.existsSync(ffmpegEntry)) {
    items.push({ full: ffmpegEntry, rel: 'ffmpeg.js' });
  }
  walkFiles(path.join(ROOT, 'core'), 'core', items, { excludeRel: new Set(['core/hotfix.js']) });
  walkFiles(path.join(ROOT, 'modules'), 'modules', items);
  walkFiles(path.join(ROOT, 'renderer'), 'renderer', items);

  const filesSha256 = {};
  const zip = new AdmZip();

  for (const item of items) {
    const buf = fs.readFileSync(item.full);
    filesSha256[item.rel] = sha256Buffer(buf);
    zip.addFile(item.rel, buf);
  }

  const builtAt = new Date().toISOString();
  const bundleMeta = {
    version,
    shellVersion,
    minShellVersion: shellVersion,
    builtAt,
    fileCount: items.length,
    filesSha256,
  };
  zip.addFile('bundle-meta.json', Buffer.from(JSON.stringify(bundleMeta, null, 2) + '\n', 'utf8'));

  fs.mkdirSync(outDir, { recursive: true });
  const bundleName = `hotfix-bundle-${version}.zip`;
  const bundlePath = path.join(outDir, bundleName);
  zip.writeZip(bundlePath);

  const zipBuf = fs.readFileSync(bundlePath);
  const bundleSha256 = sha256Buffer(zipBuf);
  const notes = opts.notes || resolveGitNotes(version) || `v${version} 功能更新与细节优化`;
  const tag = `v${version}`;

  const manifest = {
    version,
    minShellVersion: shellVersion,
    publishedAt: builtAt,
    notes,
    bundleName,
    bundleUrl: `https://github.com/${repo}/releases/download/${tag}/${bundleName}`,
    bundleSize: zipBuf.length,
    bundleSha256,
    fullReleaseUrl: `https://github.com/${repo}/releases/tag/${tag}`,
    portableAssetUrl: `https://github.com/${repo}/releases/download/${tag}/video-gif-toolbox-${version}-portable.exe`,
    setupAssetUrl: `https://github.com/${repo}/releases/download/${tag}/video-gif-toolbox-${version}-setup.exe`,
  };

  const manifestPath = path.join(outDir, 'hotfix-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  return {
    version,
    minShellVersion: shellVersion,
    fileCount: items.length,
    bundleName,
    bundlePath,
    bundleSize: zipBuf.length,
    bundleSha256,
    manifestPath,
    manifest,
  };
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  const res = buildHotfix(opts);
  console.log(
    `[hotfix-build] v${res.version} (minShell >= ${res.minShellVersion}) · ${res.fileCount} files · ${(res.bundleSize / 1024).toFixed(1)} KB -> ${res.bundlePath}`,
  );
  console.log(`[hotfix-build] manifest -> ${res.manifestPath}`);
}

module.exports = { buildHotfix };
