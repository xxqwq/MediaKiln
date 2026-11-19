'use strict';

const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const GITHUB_REPO = 'xxqwq/usefulTools';
const PREVIEW_RELEASE_FEED_URL = `https://github.com/${GITHUB_REPO}/releases.atom`;
const PREVIEW_VERSION = /^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

const DEFAULT_PUBLIC_KEY_PEM = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEA1NRvVSaNif1dptxq0H5crJq0bFky3FXizJnCAVCEbvQ=',
  '-----END PUBLIC KEY-----',
].join('\n');

const MIRROR_PREFIXES = {
  official: '',
  ghproxy: 'https://gh-proxy.com/',
  ghfast: 'https://ghfast.top/',
};

const SIGNED_MANIFEST_FILE = '.vgt-signed-manifest.json';

const REQUIRED_BUNDLE_FILES = [
  'ffmpeg.js',
  'bundle-meta.json',
  'core/runner.js',
  'core/file-filters.js',
  'renderer/index.html',
];

const ALLOWED_ZIP_ENTRY_RE = /^(ffmpeg\.js|bundle-meta\.json|(core|modules|renderer)\/.+)$/;

let _hookedNodeModules = false;
let _ctx = null;

function parseSemver(v) {
  const clean = String(v || '').trim().replace(/^v/i, '').split(/[+-]/)[0];
  if (!clean) return null;
  const parts = clean.split('.').map((n) => parseInt(n, 10));
  if (parts.length < 1 || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return String(a || '').localeCompare(String(b || ''));
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

function ensureShellNodeModulesHook(shellRoot) {
  if (_hookedNodeModules) return;
  const shellNodeModules = path.join(shellRoot, 'node_modules');
  const origNodeModulePaths = Module._nodeModulePaths;
  Module._nodeModulePaths = function patchedNodeModulePaths(from) {
    const paths = origNodeModulePaths.call(this, from);
    if (!paths.includes(shellNodeModules)) paths.push(shellNodeModules);
    return paths;
  };
  _hookedNodeModules = true;
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(262144);
    let n = 0;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(n === buf.length ? buf : buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function defaultState() {
  return {
    activeVersion: null,
    previousVersion: null,
    pendingVersion: null,
    badVersions: [],
    lastCheckedAt: 0,
  };
}

function loadState(stateFile) {
  const raw = readJsonSafe(stateFile);
  if (!raw || typeof raw !== 'object') return defaultState();
  return {
    activeVersion: PREVIEW_VERSION.test(raw.activeVersion) ? raw.activeVersion : null,
    previousVersion: PREVIEW_VERSION.test(raw.previousVersion) ? raw.previousVersion : null,
    pendingVersion: PREVIEW_VERSION.test(raw.pendingVersion) ? raw.pendingVersion : null,
    badVersions: Array.isArray(raw.badVersions) ? raw.badVersions.filter((x) => typeof x === 'string') : [],
    lastCheckedAt: Number.isFinite(raw.lastCheckedAt) ? raw.lastCheckedAt : 0,
  };
}

function saveState() {
  if (!_ctx) return;
  writeJsonAtomic(_ctx.stateFile, _ctx.state);
}

function getReleaseDir(version) {
  return path.join(_ctx.releasesDir, version);
}

function validateBundleDir(dir, shellVersion, publicKeyPem = _ctx?.publicKeyPem || DEFAULT_PUBLIC_KEY_PEM) {
  try {
    if (!dir || !fs.lstatSync(dir).isDirectory()) throw new Error('热更新目录无效');
    const receiptPath = path.join(dir, SIGNED_MANIFEST_FILE);
    const metaPath = path.join(dir, 'bundle-meta.json');
    if (!fs.lstatSync(receiptPath).isFile() || !fs.lstatSync(metaPath).isFile()) {
      throw new Error('热更新签名记录或元数据无效');
    }
    const receipt = normalizeManifest(readJsonSafe(receiptPath));
    requireSignedManifest(receipt, publicKeyPem);
    const metadata = fs.readFileSync(metaPath);
    if (sha256Buffer(metadata) !== receipt.bundleMetaSha256) throw new Error('包内元数据校验失败');
    const meta = JSON.parse(metadata.toString('utf8'));
    if (meta.version !== receipt.version || meta.minShellVersion !== receipt.minShellVersion) {
      throw new Error('包内版本号与签名清单不一致');
    }
    if (compareSemver(receipt.minShellVersion, shellVersion) > 0) {
      throw new Error('需要主程序壳版本 >= ' + receipt.minShellVersion);
    }
    const expected = new Map(Object.entries(meta.filesSha256 || {}));
    for (const rel of REQUIRED_BUNDLE_FILES) {
      if (rel !== 'bundle-meta.json' && !expected.has(rel)) throw new Error('缺少必要文件: ' + rel);
    }
    const checkFiles = (folder, prefix = '') => {
      for (const ent of fs.readdirSync(folder, { withFileTypes: true })) {
        const rel = prefix + ent.name;
        const full = path.join(folder, ent.name);
        if (!prefix && [SIGNED_MANIFEST_FILE, 'bundle-meta.json'].includes(ent.name)) continue;
        if (ent.isDirectory() && (prefix || ['core', 'modules', 'renderer'].includes(ent.name))) {
          checkFiles(full, rel + '/');
        } else if (!ent.isFile() || !expected.has(rel) || sha256File(full) !== expected.get(rel)) {
          throw new Error('校验文件不通过: ' + rel);
        } else {
          expected.delete(rel);
        }
      }
    };
    checkFiles(dir);
    if (expected.size) throw new Error('热更新包缺少签名清单中的文件');
    return { ok: true, meta };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function pruneReleases() {
  if (!_ctx) return;
  try {
    if (fs.existsSync(_ctx.tmpDir)) {
      for (const name of fs.readdirSync(_ctx.tmpDir)) {
        fs.rmSync(path.join(_ctx.tmpDir, name), { recursive: true, force: true });
      }
    }
  } catch {}
  try {
    if (!fs.existsSync(_ctx.releasesDir)) return;
    const keep = new Set([_ctx.state.activeVersion, _ctx.state.previousVersion].filter(Boolean));
    for (const name of fs.readdirSync(_ctx.releasesDir)) {
      if (!keep.has(name)) {
        fs.rmSync(path.join(_ctx.releasesDir, name), { recursive: true, force: true });
      }
    }
  } catch {}
}

function initHotfix({ shellRoot, userDataDir, publicKeyPem = DEFAULT_PUBLIC_KEY_PEM }) {
  const pkg = readJsonSafe(path.join(shellRoot, 'package.json')) || {};
  const builtinVersion = String(pkg.version || '0.0.0').replace(/^v/i, '');
  const shellVersion = String(pkg.shellVersion || builtinVersion).replace(/^v/i, '');

  process.env.VGT_APP_ROOT = shellRoot;
  ensureShellNodeModulesHook(shellRoot);

  const hotfixDir = path.join(userDataDir, 'hotfix-signed-v0');
  const releasesDir = path.join(hotfixDir, 'releases');
  const tmpDir = path.join(hotfixDir, 'tmp');
  const stateFile = path.join(hotfixDir, 'state.json');

  for (const dir of [hotfixDir, releasesDir, tmpDir]) {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.lstatSync(dir).isDirectory()) throw new Error('热更新目录不能使用链接');
  }

  const state = loadState(stateFile);
  let stateDirty = false;
  let rolledBackFrom = null;

  // 若上次启动热更新未完成确认即崩溃退出，自动标坏并回退
  if (state.pendingVersion) {
    rolledBackFrom = state.pendingVersion;
    if (!state.badVersions.includes(state.pendingVersion)) {
      state.badVersions.push(state.pendingVersion);
    }
    if (state.activeVersion === state.pendingVersion) {
      state.activeVersion = state.previousVersion && !state.badVersions.includes(state.previousVersion)
        ? state.previousVersion
        : null;
    }
    state.pendingVersion = null;
    stateDirty = true;
  }

  // 若已安装新版完整 .exe（版本号 >= 热更新版本），自动让位给内置版本
  if (state.activeVersion && compareSemver(state.activeVersion, builtinVersion) <= 0) {
    state.activeVersion = null;
    state.previousVersion = null;
    stateDirty = true;
  }
  if (state.previousVersion && compareSemver(state.previousVersion, builtinVersion) <= 0) {
    state.previousVersion = null;
    stateDirty = true;
  }

  let activeRoot = shellRoot;
  let activeMeta = null;

  if (state.activeVersion) {
    if (state.badVersions.includes(state.activeVersion)) {
      state.activeVersion = null;
      stateDirty = true;
    } else {
      const candidateDir = path.join(releasesDir, state.activeVersion);
      const check = validateBundleDir(candidateDir, shellVersion, publicKeyPem);
      if (check.ok && check.meta.version === state.activeVersion) {
        activeRoot = candidateDir;
        activeMeta = check.meta;
        state.pendingVersion = state.activeVersion;
        stateDirty = true;
      } else {
        if (!state.badVersions.includes(state.activeVersion)) {
          state.badVersions.push(state.activeVersion);
        }
        state.activeVersion = null;
        stateDirty = true;
      }
    }
  }

  _ctx = {
    shellRoot,
    userDataDir,
    hotfixDir,
    releasesDir,
    tmpDir,
    stateFile,
    builtinVersion,
    shellVersion,
    publicKeyPem,
    installing: false,
    state,
    activeRoot,
    activeMeta,
    rolledBackFrom,
    pendingRestart: false,
  };

  if (stateDirty) saveState();
  pruneReleases();

  return getStatus();
}

function confirmBoot(version) {
  if (!_ctx) return;
  const target = version || _ctx.state.pendingVersion || _ctx.state.activeVersion;
  if (_ctx.state.pendingVersion && (!target || _ctx.state.pendingVersion === target)) {
    _ctx.state.pendingVersion = null;
    saveState();
    pruneReleases();
  }
}

function getActiveRoot() {
  return _ctx ? _ctx.activeRoot : null;
}

function getStatus() {
  if (!_ctx) return null;
  const isHotfix = Boolean(_ctx.state.activeVersion && _ctx.activeRoot !== _ctx.shellRoot);
  const effectiveVersion = isHotfix ? _ctx.state.activeVersion : _ctx.builtinVersion;
  return {
    builtinVersion: _ctx.builtinVersion,
    shellVersion: _ctx.shellVersion,
    activeVersion: isHotfix ? _ctx.state.activeVersion : null,
    effectiveVersion,
    previousVersion: _ctx.state.previousVersion,
    isHotfix,
    activeRoot: _ctx.activeRoot,
    shellRoot: _ctx.shellRoot,
    hotfixDir: _ctx.hotfixDir,
    badVersions: [..._ctx.state.badVersions],
    rolledBackFrom: _ctx.rolledBackFrom,
    pendingRestart: _ctx.pendingRestart,
    lastCheckedAt: _ctx.state.lastCheckedAt,
  };
}

function stripMirrorPrefix(rawUrl) {
  const s = String(rawUrl || '').trim();
  for (const prefix of Object.values(MIRROR_PREFIXES)) {
    if (prefix && s.startsWith(prefix)) return s.slice(prefix.length);
  }
  return s;
}

function applyMirrorPrefix(rawUrl, mirrorId) {
  const clean = stripMirrorPrefix(rawUrl);
  const prefix = MIRROR_PREFIXES[mirrorId] || '';
  if (!prefix) return clean;
  return `${prefix}${clean}`;
}

function buildCandidateUrls(rawUrl, mirrorPref = 'auto', preferredMirror = '') {
  const clean = stripMirrorPrefix(rawUrl);
  if (mirrorPref && mirrorPref !== 'auto' && Object.prototype.hasOwnProperty.call(MIRROR_PREFIXES, mirrorPref)) {
    return [{ mirror: mirrorPref, url: applyMirrorPrefix(clean, mirrorPref) }];
  }
  const order = [];
  if (preferredMirror && Object.prototype.hasOwnProperty.call(MIRROR_PREFIXES, preferredMirror)) {
    order.push(preferredMirror);
  }
  for (const m of ['official', 'ghproxy', 'ghfast']) {
    if (!order.includes(m)) order.push(m);
  }
  return order.map((m) => ({ mirror: m, url: applyMirrorPrefix(clean, m) }));
}

function getDefaultFetch() {
  try {
    const { net } = require('electron');
    if (net && typeof net.fetch === 'function') return net.fetch.bind(net);
  } catch {}
  return globalThis.fetch.bind(globalThis);
}

function withCacheBuster(u) {
  const sep = u.includes('?') ? '&' : '?';
  return `${u}${sep}t=${Date.now()}`;
}

function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('更新清单格式无效');
  const version = String(raw.version || '').trim().replace(/^v/i, '');
  if (!PREVIEW_VERSION.test(version)) throw new Error('更新清单必须使用 0.x 测试版版本号');
  const minShellVersion = String(raw.minShellVersion || '0.0.0').trim().replace(/^v/i, '');
  if (!PREVIEW_VERSION.test(minShellVersion)) throw new Error('更新清单的主程序版本号无效');
  const bundleUrl = String(raw.bundleUrl || '').trim();
  const bundleSha256 = String(raw.bundleSha256 || '').trim().toLowerCase();
  return {
    version,
    minShellVersion,
    publishedAt: String(raw.publishedAt || ''),
    notes: String(raw.notes || ''),
    bundleName: String(raw.bundleName || `hotfix-bundle-${version}.zip`),
    bundleUrl,
    bundleSize: Number(raw.bundleSize) || 0,
    bundleSha256,
    bundleMetaSha256: String(raw.bundleMetaSha256 || '').trim().toLowerCase(),
    signature: String(raw.signature || '').trim(),
    fullReleaseUrl: String(raw.fullReleaseUrl || `https://github.com/${GITHUB_REPO}/releases/tag/v${version}`),
    portableAssetUrl: String(raw.portableAssetUrl || ''),
    setupAssetUrl: String(raw.setupAssetUrl || ''),
  };
}

function buildManifestSignPayload(manifest) {
  const m = normalizeManifest(manifest);
  return JSON.stringify([
    'vgt-hotfix-v2', m.version, m.minShellVersion, m.bundleSha256, m.bundleMetaSha256,
    m.bundleSize, m.bundleName, m.bundleUrl, m.fullReleaseUrl, m.portableAssetUrl,
    m.setupAssetUrl, m.publishedAt, m.notes,
  ]);
}

function signManifest(manifest, privateKeyPem) {
  if (!privateKeyPem) throw new Error('缺少 Ed25519 私钥');
  const payload = Buffer.from(buildManifestSignPayload(manifest), 'utf8');
  const keyObj = privateKeyPem instanceof crypto.KeyObject ? privateKeyPem : crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, payload, keyObj).toString('base64');
}

function verifyManifestSignature(manifest, publicKeyPem) {
  try {
    const sigB64 = String(manifest?.signature || '').trim();
    if (!sigB64) return false;
    const pub = publicKeyPem || DEFAULT_PUBLIC_KEY_PEM;
    if (!pub) return false;
    const payload = Buffer.from(buildManifestSignPayload(manifest), 'utf8');
    const sigBuf = Buffer.from(sigB64, 'base64');
    const keyObj = crypto.createPublicKey(pub);
    return crypto.verify(null, payload, keyObj, sigBuf);
  } catch {
    return false;
  }
}

function requireSignedManifest(manifest, publicKeyPem) {
  if (!verifyManifestSignature(manifest, publicKeyPem)
    || !/^[a-f0-9]{64}$/.test(manifest.bundleMetaSha256)
    || !/^[a-f0-9]{64}$/.test(manifest.bundleSha256)) {
    throw new Error('热更新清单 Ed25519 签名校验失败');
  }
}

async function fetchManifestFrom(candidate, { timeoutMs, fetchImpl, discoverPreview }) {
  const fetchFn = fetchImpl || getDefaultFetch();
  const signal = AbortSignal.timeout(timeoutMs);
  let url = candidate.url;
  let expectedVersion;
  if (discoverPreview) {
    // GitHub 的 latest 路由跳过测试版。Atom 发布列表包含测试版。
    const feed = await fetchFn(withCacheBuster(url), {
      headers: { Accept: 'application/atom+xml', 'User-Agent': 'vgt-hotfix-client' },
      signal,
    });
    if (!feed.ok) throw new Error(`读取测试版发布列表失败（HTTP ${feed.status}）`);
    const xml = await feed.text();
    const ids = xml.matchAll(/<id>tag:github\.com,2008:Repository\/\d+\/v(0\.\d+\.\d+)<\/id>/g);
    for (const [, version] of ids) {
      if (PREVIEW_VERSION.test(version) && (!expectedVersion || compareSemver(version, expectedVersion) > 0)) {
        expectedVersion = version;
      }
    }
    if (!expectedVersion) throw new Error('发布列表中没有 0.x 测试版');
    url = applyMirrorPrefix(`https://github.com/${GITHUB_REPO}/releases/download/v${expectedVersion}/hotfix-manifest.json`, candidate.mirror);
  }
  const res = await fetchFn(withCacheBuster(url), {
    headers: { Accept: 'application/json', 'User-Agent': 'vgt-hotfix-client' },
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.json();
  const manifest = normalizeManifest(raw);
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new Error('测试版清单版本与发布标签不一致');
  }
  return { manifest, mirror: candidate.mirror };
}

async function checkForUpdates(opts = {}) {
  if (!_ctx) throw new Error('hotfix 未初始化');
  const mirrorPref = opts.mirror || 'auto';
  const manifestUrl = opts.manifestUrl || process.env.VGT_HOTFIX_MANIFEST_URL;
  const candidates = buildCandidateUrls(manifestUrl || PREVIEW_RELEASE_FEED_URL, mirrorPref);
  const fetchImpl = opts.fetchImpl;
  const timeoutMs = Number(opts.timeoutMs) || 7000;
  const fetchCandidate = async (candidate) => {
    const result = await fetchManifestFrom(candidate, {
      timeoutMs, fetchImpl, discoverPreview: !manifestUrl,
    });
    requireSignedManifest(result.manifest, _ctx.publicKeyPem);
    return result;
  };

  const hit = candidates.length === 1
    ? await fetchCandidate(candidates[0])
    : await Promise.any(candidates.map(fetchCandidate));

  _ctx.state.lastCheckedAt = Date.now();
  saveState();

  const status = getStatus();
  const { manifest, mirror } = hit;

  if (compareSemver(manifest.version, status.effectiveVersion) <= 0) {
    return {
      ok: true,
      status: 'up-to-date',
      current: status,
      manifest,
      mirror,
    };
  }

  if (_ctx.state.badVersions.includes(manifest.version) && !opts.ignoreBad) {
    return {
      ok: true,
      status: 'skipped-bad',
      current: status,
      manifest,
      mirror,
    };
  }

  if (compareSemver(manifest.minShellVersion, status.shellVersion) > 0) {
    return {
      ok: true,
      status: 'shell-upgrade-required',
      current: status,
      manifest,
      mirror,
    };
  }

  if (!manifest.bundleUrl || !/^[a-f0-9]{64}$/.test(manifest.bundleSha256)) {
    return {
      ok: true,
      status: 'shell-upgrade-required',
      current: status,
      manifest,
      mirror,
    };
  }

  return {
    ok: true,
    status: 'hotfix-available',
    current: status,
    manifest,
    mirror,
  };
}

async function downloadToFile(url, destFile, { timeoutMs = 45000, onProgress, fetchImpl } = {}) {
  const fetchFn = fetchImpl || getDefaultFetch();
  const res = await fetchFn(url, {
    headers: { 'User-Agent': 'vgt-hotfix-client' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);

  const totalHeader = Number(res.headers?.get?.('content-length') || 0);
  fs.mkdirSync(path.dirname(destFile), { recursive: true });

  if (!res.body || typeof res.body.getReader !== 'function') {
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    fs.writeFileSync(destFile, buf);
    onProgress?.({ received: buf.length, total: totalHeader || buf.length, ratio: 1 });
    return buf.length;
  }

  const reader = res.body.getReader();
  const ws = fs.createWriteStream(destFile);
  let received = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        received += value.length;
        if (!ws.write(Buffer.from(value))) {
          await new Promise((resolve, reject) => {
            ws.once('drain', resolve);
            ws.once('error', reject);
          });
        }
        onProgress?.({
          received,
          total: totalHeader || 0,
          ratio: totalHeader > 0 ? Math.min(1, received / totalHeader) : 0,
        });
      }
    }
    await new Promise((resolve, reject) => {
      ws.end(resolve);
      ws.once('error', reject);
    });
    return received;
  } catch (err) {
    try { ws.destroy(); } catch {}
    fs.rmSync(destFile, { force: true });
    throw err;
  }
}

function extractBundleZip(zipPath, stagingDir) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  if (!entries.length) throw new Error('热更新压缩包为空');

  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  const resolvedRoot = path.resolve(stagingDir);

  for (const ent of entries) {
    const norm = String(ent.entryName || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!norm) continue;
    if (norm.startsWith('/') || norm.includes('..') || /^[a-zA-Z]:/.test(norm)) {
      throw new Error(`热更新包包含非法路径: ${norm}`);
    }
    if (!ALLOWED_ZIP_ENTRY_RE.test(norm)) {
      if (ent.isDirectory && /^(core|modules|renderer)$/.test(norm)) continue;
      throw new Error(`热更新包包含未授权目录: ${norm}`);
    }
    if (norm === 'core/hotfix.js') continue;

    const destPath = path.resolve(resolvedRoot, norm);
    if (destPath !== resolvedRoot && !destPath.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`热更新路径越界: ${norm}`);
    }
    if (ent.isDirectory) {
      fs.mkdirSync(destPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, ent.getData());
    }
  }
}

async function downloadAndInstall(manifestInput, opts = {}) {
  if (!_ctx) throw new Error('hotfix 未初始化');
  const manifest = normalizeManifest(manifestInput);
  requireSignedManifest(manifest, _ctx.publicKeyPem);
  if (_ctx.installing) throw new Error('已有热更新正在安装');
  if (compareSemver(manifest.version, getStatus().effectiveVersion) <= 0) {
    throw new Error('只能安装比当前版本更新的热更新');
  }
  if (compareSemver(manifest.minShellVersion, _ctx.shellVersion) > 0) {
    throw new Error(`当前壳版本 ${_ctx.shellVersion} 过旧，需先安装主程序 >= ${manifest.minShellVersion}`);
  }
  if (!manifest.bundleUrl || !/^[a-f0-9]{64}$/.test(manifest.bundleSha256)) {
    throw new Error('更新清单缺少有效的 bundleUrl 或 SHA-256 校验值');
  }

  const mirrorPref = opts.mirror || 'auto';
  const candidates = buildCandidateUrls(manifest.bundleUrl, mirrorPref, opts.preferredMirror || '');
  const zipPath = path.join(_ctx.tmpDir, `hotfix-${manifest.version}-${Date.now()}.zip`);
  const stagingDir = path.join(_ctx.releasesDir, `.staging-${manifest.version}-${Date.now()}`);
  const finalDir = getReleaseDir(manifest.version);

  _ctx.installing = true;
  try {
    let lastErr = null;
    let downloaded = false;
    for (const cand of candidates) {
      try {
        opts.onProgress?.({ stage: 'downloading', mirror: cand.mirror, ratio: 0, received: 0, total: manifest.bundleSize });
        await downloadToFile(cand.url, zipPath, {
          timeoutMs: Number(opts.timeoutMs) || 45000,
          fetchImpl: opts.fetchImpl,
          onProgress: (p) => {
            const total = p.total || manifest.bundleSize || 0;
            const ratio = total > 0 ? Math.min(1, p.received / total) : p.ratio;
            opts.onProgress?.({ stage: 'downloading', mirror: cand.mirror, received: p.received, total, ratio });
          },
        });
        downloaded = true;
        break;
      } catch (err) {
        lastErr = err;
        fs.rmSync(zipPath, { force: true });
      }
    }
    if (!downloaded) {
      throw new Error(`热更新包下载失败: ${lastErr?.message || '网络不可用'}`);
    }

    opts.onProgress?.({ stage: 'verifying', ratio: 1 });
    const actualSha = sha256File(zipPath);
    if (actualSha !== manifest.bundleSha256) {
      throw new Error(`热更新包 SHA-256 校验失败（期望 ${manifest.bundleSha256.slice(0, 12)}，实际 ${actualSha.slice(0, 12)}）`);
    }

    opts.onProgress?.({ stage: 'extracting', ratio: 1 });
    extractBundleZip(zipPath, stagingDir);
    writeJsonAtomic(path.join(stagingDir, SIGNED_MANIFEST_FILE), manifest);

    const validation = validateBundleDir(stagingDir, _ctx.shellVersion);
    if (!validation.ok) {
      throw new Error(validation.error);
    }

    if (typeof opts.validateBundleFn === 'function') {
      try {
        await opts.validateBundleFn(stagingDir);
      } finally {
        clearRequireCacheUnderRoot(stagingDir);
      }
    }

    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, finalDir);

    const prev = _ctx.state.activeVersion && _ctx.state.activeVersion !== manifest.version
      ? _ctx.state.activeVersion
      : _ctx.state.previousVersion;

    _ctx.state.previousVersion = prev || null;
    _ctx.state.activeVersion = manifest.version;
    _ctx.state.pendingVersion = null;
    _ctx.state.badVersions = _ctx.state.badVersions.filter((v) => v !== manifest.version);
    _ctx.activeRoot = finalDir;
    _ctx.activeMeta = validation.meta;
    saveState();

    return {
      ok: true,
      version: manifest.version,
      releaseDir: finalDir,
      meta: validation.meta,
    };
  } finally {
    _ctx.installing = false;
    fs.rmSync(zipPath, { force: true });
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function activateAppliedRoot(releaseDir, version) {
  if (!_ctx) return;
  _ctx.activeRoot = releaseDir;
  _ctx.state.activeVersion = version;
  _ctx.state.pendingVersion = version;
  _ctx.pendingRestart = false;
  saveState();
}

function setPendingRestart(flag) {
  if (!_ctx) return;
  _ctx.pendingRestart = !!flag;
}

function rollbackToBuiltin() {
  if (!_ctx) throw new Error('hotfix 未初始化');
  _ctx.state.activeVersion = null;
  _ctx.state.previousVersion = null;
  _ctx.state.pendingVersion = null;
  _ctx.activeRoot = _ctx.shellRoot;
  _ctx.activeMeta = null;
  _ctx.pendingRestart = false;
  saveState();
  pruneReleases();
  return getStatus();
}

function rollbackToPrevious(errVersion) {
  if (!_ctx) return null;
  if (errVersion && !_ctx.state.badVersions.includes(errVersion)) {
    _ctx.state.badVersions.push(errVersion);
  }
  let targetRoot = _ctx.shellRoot;
  let nextActive = null;

  if (_ctx.state.previousVersion && !_ctx.state.badVersions.includes(_ctx.state.previousVersion)) {
    const prevDir = getReleaseDir(_ctx.state.previousVersion);
    const validation = validateBundleDir(prevDir, _ctx.shellVersion);
    if (validation.ok && validation.meta.version === _ctx.state.previousVersion) {
      targetRoot = prevDir;
      nextActive = _ctx.state.previousVersion;
    }
  }
  _ctx.state.activeVersion = nextActive;
  _ctx.state.previousVersion = null;
  _ctx.state.pendingVersion = null;
  _ctx.activeRoot = targetRoot;
  _ctx.pendingRestart = false;
  saveState();
  return getStatus();
}

function clearRequireCacheUnderRoot(rootDir) {
  if (!rootDir) return;
  const resolved = path.resolve(rootDir);
  const hotfixSelf = path.resolve(__filename);
  for (const key of Object.keys(require.cache)) {
    const resolvedKey = path.resolve(key);
    if (resolvedKey === hotfixSelf) continue;
    if (resolvedKey.startsWith(resolved + path.sep)) {
      delete require.cache[key];
    }
  }
}

module.exports = {
  GITHUB_REPO,
  PREVIEW_RELEASE_FEED_URL,
  DEFAULT_PUBLIC_KEY_PEM,
  MIRROR_PREFIXES,
  parseSemver,
  compareSemver,
  sha256Buffer,
  sha256File,
  buildManifestSignPayload,
  signManifest,
  verifyManifestSignature,
  ensureShellNodeModulesHook,
  initHotfix,
  confirmBoot,
  getActiveRoot,
  getStatus,
  applyMirrorPrefix,
  buildCandidateUrls,
  checkForUpdates,
  downloadAndInstall,
  validateBundleDir,
  activateAppliedRoot,
  setPendingRestart,
  rollbackToBuiltin,
  rollbackToPrevious,
  clearRequireCacheUnderRoot,
};
