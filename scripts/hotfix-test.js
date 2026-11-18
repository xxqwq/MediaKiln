'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const hotfix = require('../core/hotfix');
const { buildHotfix } = require('./build-hotfix');

const ROOT = path.resolve(__dirname, '..');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeMockFetch(routes) {
  return async function mockFetch(url) {
    const cleanUrl = String(url).split('?')[0];
    const hit = routes[cleanUrl];
    if (!hit) {
      return { ok: false, status: 404, async json() { return {}; }, async arrayBuffer() { return new ArrayBuffer(0); } };
    }
    if (typeof hit.text === 'string') return { ok: true, async text() { return hit.text; } };
    if (hit.json) {
      return {
        ok: true,
        status: 200,
        async json() { return hit.json; },
      };
    }
    const buf = hit.buffer;
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(buf.length) : null) },
      async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
    };
  };
}

function createFakeBundleZip({ version = '0.9.9', minShellVersion = '0.1.0', extraFiles = {} }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const zip = new AdmZip();
  const filesSha256 = {};

  const addReal = (rel) => {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    filesSha256[rel] = hotfix.sha256Buffer(buf);
    zip.addFile(rel, buf);
  };
  addReal('ffmpeg.js');
  addReal('core/runner.js');
  addReal('core/utils.js');
  addReal('core/svg-worker.js');
  addReal('core/pdf-engine.js');
  addReal('core/md-renderer.js');
  addReal('core/doc-parser.js');
  addReal('core/ffmpeg-bin.js');
  addReal('core/file-filters.js');
  addReal('modules/video.js');
  addReal('modules/image.js');
  addReal('modules/svg.js');
  addReal('modules/document.js');
  addReal('renderer/index.html');

  for (const [rel, content] of Object.entries(extraFiles)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    filesSha256[rel] = hotfix.sha256Buffer(buf);
    zip.addFile(rel, buf);
  }

  const meta = {
    version,
    shellVersion: String(pkg.shellVersion || pkg.version),
    minShellVersion,
    builtAt: new Date().toISOString(),
    filesSha256,
  };
  zip.addFile('bundle-meta.json', Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
  return zip.toBuffer();
}

async function run() {
  const tmpOut = makeTempDir('vgt-hotfix-out-');
  const tmpUserData = makeTempDir('vgt-hotfix-ud-');
  const tmpShellUpgrade = makeTempDir('vgt-hotfix-shell-');
  const tmpSignedOut = makeTempDir('vgt-hotfix-sigout-');
  const tmpSignedUserData = makeTempDir('vgt-hotfix-sigud-');

  try {
    // 1. 打包测试
    const built = buildHotfix({ outDir: tmpOut, notes: '测试热更新发布说明' });
    assert(fs.existsSync(built.bundlePath), 'bundle zip should exist');
    assert(fs.existsSync(built.manifestPath), 'manifest json should exist');
    assert(built.bundleSize > 10000 && built.bundleSize < 2 * 1024 * 1024, `unexpected bundle size: ${built.bundleSize}`);

    const builtZip = new AdmZip(built.bundlePath);
    const entryNames = builtZip.getEntries().map((e) => e.entryName);
    assert(entryNames.includes('ffmpeg.js'), 'bundle must include ffmpeg.js');
    assert(entryNames.includes('core/svg-worker.js'), 'bundle must include core/svg-worker.js');
    assert(entryNames.includes('core/pdf-engine.js'), 'bundle must include core/pdf-engine.js');
    assert(entryNames.includes('core/md-renderer.js'), 'bundle must include core/md-renderer.js');
    assert(entryNames.includes('core/file-filters.js'), 'bundle must include core/file-filters.js');
    assert(entryNames.includes('renderer/index.html'), 'bundle must include renderer/index.html');
    assert(!entryNames.includes('core/hotfix.js'), 'bundle must NOT include core/hotfix.js');
    console.log(`[1/8] buildHotfix OK (${(built.bundleSize / 1024).toFixed(1)} KB, ${built.fileCount} files)`);

    // 2. 初始化测试
    const legacyDir = path.join(tmpUserData, 'hotfix');
    fs.mkdirSync(legacyDir);
    const legacyState = path.join(legacyDir, 'state.json');
    fs.writeFileSync(legacyState, '{"activeVersion":"2.1.10"}');
    const st0 = hotfix.initHotfix({ shellRoot: ROOT, userDataDir: tmpUserData });
    assert.strictEqual(st0.isHotfix, false);
    assert.strictEqual(st0.activeRoot, ROOT);
    assert.strictEqual(fs.readFileSync(legacyState, 'utf8'), '{"activeVersion":"2.1.10"}');
    console.log('[2/8] initHotfix baseline OK');

    // 3. 检查更新状态分支测试
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const curVer = pkg.version;
    const bundle099 = createFakeBundleZip({ version: '0.9.9', minShellVersion: pkg.shellVersion || curVer });
    const sha099 = hotfix.sha256Buffer(bundle099);

    const manifestUrl = 'https://example.test/hotfix-manifest.json';
    const bundleUrl = 'https://example.test/hotfix-bundle-0.9.9.zip';

    const upToDateRes = await hotfix.checkForUpdates({
      mirror: 'official',
      manifestUrl,
      fetchImpl: makeMockFetch({
        [manifestUrl]: {
          json: {
            version: curVer,
            minShellVersion: curVer,
            bundleUrl,
            bundleSha256: sha099,
          },
        },
      }),
    });
    assert.strictEqual(upToDateRes.status, 'up-to-date');

    const shellUpgradeRes = await hotfix.checkForUpdates({
      mirror: 'official',
      manifestUrl,
      fetchImpl: makeMockFetch({
        [manifestUrl]: {
          json: {
            version: '0.99.0',
            minShellVersion: '0.99.0',
            bundleUrl,
            bundleSha256: sha099,
          },
        },
      }),
    });
    assert.strictEqual(shellUpgradeRes.status, 'shell-upgrade-required');

    const availRes = await hotfix.checkForUpdates({
      mirror: 'official',
      manifestUrl,
      fetchImpl: makeMockFetch({
        [manifestUrl]: {
          json: {
            version: '0.9.9',
            minShellVersion: pkg.shellVersion || curVer,
            bundleUrl,
            bundleSize: bundle099.length,
            bundleSha256: sha099,
            notes: '测试新版本',
          },
        },
      }),
    });
    assert.strictEqual(availRes.status, 'hotfix-available');

    // 真实入口先从发布列表中选 0.x，再读取同一版本的清单。
    const feedText = `<feed>
      <entry><id>tag:github.com,2008:Repository/123/v2.1.10</id></entry>
      <entry><id>tag:github.com,2008:Repository/123/v0.9.8</id></entry>
      <entry><id>tag:github.com,2008:Repository/123/v0.9.9</id></entry>
    </feed>`;
    const feedRoutes = {
      [hotfix.PREVIEW_RELEASE_FEED_URL]: { text: feedText },
      [`https://github.com/${hotfix.GITHUB_REPO}/releases/download/v0.9.9/hotfix-manifest.json`]: { json: availRes.manifest },
    };
    const feedCheck = await hotfix.checkForUpdates({ mirror: 'official', fetchImpl: makeMockFetch(feedRoutes) });
    assert.strictEqual(feedCheck.status, 'hotfix-available');
    assert.strictEqual(feedCheck.manifest.version, '0.9.9');
    const mismatchedVersion = { ...availRes.manifest, version: '0.9.8' };
    await assert.rejects(() => hotfix.checkForUpdates({
      mirror: 'official',
      fetchImpl: makeMockFetch({
        ...feedRoutes,
        [`https://github.com/${hotfix.GITHUB_REPO}/releases/download/v0.9.9/hotfix-manifest.json`]: { json: mismatchedVersion },
      }),
    }), /版本与发布标签不一致/);
    await assert.rejects(() => hotfix.downloadAndInstall({ ...availRes.manifest, version: '2.1.10' }), /0.x 测试版/);
    console.log('[3/8] checkForUpdates branches OK');

    // 4. SHA-256 篡改拒绝 + 路径穿越拒绝
    await assert.rejects(
      () => hotfix.downloadAndInstall(
        { ...availRes.manifest, bundleSha256: '0'.repeat(64) },
        { mirror: 'official', fetchImpl: makeMockFetch({ [bundleUrl]: { buffer: bundle099 } }) },
      ),
      /SHA-256/,
    );

    const evilZip = new AdmZip();
    evilZip.addFile('core/x.js', Buffer.from('bad'));
    evilZip.getEntry('core/x.js').entryName = 'core/../evil.js';
    const evilBuf = evilZip.toBuffer();
    await assert.rejects(
      () => hotfix.downloadAndInstall(
        { ...availRes.manifest, bundleSha256: hotfix.sha256Buffer(evilBuf) },
        { mirror: 'official', fetchImpl: makeMockFetch({ [bundleUrl]: { buffer: evilBuf } }) },
      ),
      /非法路径/,
    );
    assert.strictEqual(hotfix.getStatus().isHotfix, false);
    console.log('[4/8] SHA-256 & zip-slip guard OK');

    // 5. 合法热更新下载、解压、外部目录 require() 与 FFmpeg 路径解析
    let loadedFfmpegFromHotfix = null;
    const applyRes = await hotfix.downloadAndInstall(availRes.manifest, {
      mirror: 'official',
      fetchImpl: makeMockFetch({ [bundleUrl]: { buffer: bundle099 } }),
      validateBundleFn: (stagingDir) => {
        const ff = require(path.join(stagingDir, 'ffmpeg.js'));
        const filters = require(path.join(stagingDir, 'core', 'file-filters.js'));
        assert(typeof ff.executeTask === 'function', 'executeTask must exist');
        assert(typeof ff.probe === 'function', 'probe must exist');
        assert(filters.FILE_FILTERS?.videoToGif, 'FILE_FILTERS must exist');
        assert(fs.existsSync(ff.FFMPEG), `FFMPEG path from hotfix must resolve: ${ff.FFMPEG}`);
        loadedFfmpegFromHotfix = ff;
      },
    });
    assert.strictEqual(applyRes.ok, true);
    assert.strictEqual(applyRes.version, '0.9.9');
    assert(loadedFfmpegFromHotfix);

    // 模拟冷启动 + confirmBoot
    hotfix.confirmBoot('0.9.9');
    const stAfterBoot = hotfix.initHotfix({ shellRoot: ROOT, userDataDir: tmpUserData });
    assert.strictEqual(stAfterBoot.isHotfix, true);
    assert.strictEqual(stAfterBoot.effectiveVersion, '0.9.9');
    hotfix.confirmBoot('0.9.9');
    console.log('[5/8] downloadAndInstall + external module/bin resolution + confirmBoot OK');

    // 6. 模拟启动未确认即崩溃 -> 自动回滚并标坏
    const stCrashInit = hotfix.initHotfix({ shellRoot: ROOT, userDataDir: tmpUserData });
    assert.strictEqual(stCrashInit.isHotfix, true); // 设置 pendingVersion = 0.9.9，故意不调用 confirmBoot()

    const stRecovered = hotfix.initHotfix({ shellRoot: ROOT, userDataDir: tmpUserData });
    assert.strictEqual(stRecovered.isHotfix, false);
    assert.strictEqual(stRecovered.rolledBackFrom, '0.9.9');
    assert(stRecovered.badVersions.includes('0.9.9'));

    const skippedRes = await hotfix.checkForUpdates({
      mirror: 'official',
      manifestUrl,
      fetchImpl: makeMockFetch({
        [manifestUrl]: { json: availRes.manifest },
      }),
    });
    assert.strictEqual(skippedRes.status, 'skipped-bad');
    console.log('[6/8] crash-loop auto-rollback & badVersions skip OK');

    // 7. 新版安装包覆盖旧热更新（builtinVersion >= activeVersion）
    fs.writeFileSync(
      path.join(tmpShellUpgrade, 'package.json'),
      JSON.stringify({ version: '0.10.0', shellVersion: '0.10.0' }),
    );
    const stShellUpgraded = hotfix.initHotfix({ shellRoot: tmpShellUpgrade, userDataDir: tmpUserData });
    assert.strictEqual(stShellUpgraded.isHotfix, false);
    assert.strictEqual(stShellUpgraded.effectiveVersion, '0.10.0');
    console.log('[7/8] builtin shell upgrade precedence OK');

    // 8. Ed25519 清单签名构建与校验测试
    const { publicKey: publicKeyPem, privateKey: privateKeyPem } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const signedBuild = buildHotfix({
      outDir: tmpSignedOut,
      notes: '签名测试版本',
      privateKeyPem,
    });
    assert(signedBuild.manifest.signature && signedBuild.manifest.signature.length > 20, 'signed manifest must include signature');
    assert.strictEqual(hotfix.verifyManifestSignature(signedBuild.manifest, publicKeyPem), true);

    hotfix.initHotfix({ shellRoot: ROOT, userDataDir: tmpSignedUserData });
    const bundle098 = createFakeBundleZip({ version: '0.9.8', minShellVersion: pkg.shellVersion || curVer });
    const signedManifest = {
      version: '0.9.8',
      minShellVersion: pkg.shellVersion || curVer,
      bundleUrl: 'https://example.test/hotfix-bundle-0.9.8.zip',
      bundleSize: bundle098.length,
      bundleSha256: hotfix.sha256Buffer(bundle098),
      notes: '签名验证测试',
    };
    signedManifest.signature = hotfix.signManifest(signedManifest, privateKeyPem);

    const signedCheck = await hotfix.checkForUpdates({
      mirror: 'official',
      manifestUrl,
      publicKeyPem,
      requireSignature: true,
      fetchImpl: makeMockFetch({ [manifestUrl]: { json: signedManifest } }),
    });
    assert.strictEqual(signedCheck.status, 'hotfix-available');

    const signedApply = await hotfix.downloadAndInstall(signedManifest, {
      mirror: 'official',
      publicKeyPem,
      requireSignature: true,
      fetchImpl: makeMockFetch({ [signedManifest.bundleUrl]: { buffer: bundle098 } }),
    });
    assert.strictEqual(signedApply.ok, true);
    assert.strictEqual(signedApply.version, '0.9.8');

    // 篡改 bundleSha256 应触发签名校验失败
    await assert.rejects(
      () => hotfix.checkForUpdates({
        mirror: 'official',
        manifestUrl,
        publicKeyPem,
        requireSignature: true,
        fetchImpl: makeMockFetch({
          [manifestUrl]: { json: { ...signedManifest, bundleSha256: 'a'.repeat(64) } },
        }),
      }),
      /签名校验失败/,
    );
    await assert.rejects(
      () => hotfix.downloadAndInstall(
        { ...signedManifest, bundleSha256: 'a'.repeat(64) },
        { mirror: 'official', publicKeyPem, requireSignature: true, fetchImpl: makeMockFetch({ [signedManifest.bundleUrl]: { buffer: bundle098 } }) },
      ),
      /签名校验失败/,
    );

    // 伪造签名应触发签名校验失败
    await assert.rejects(
      () => hotfix.checkForUpdates({
        mirror: 'official',
        manifestUrl,
        publicKeyPem,
        requireSignature: true,
        fetchImpl: makeMockFetch({
          [manifestUrl]: { json: { ...signedManifest, signature: Buffer.from('forged-signature').toString('base64') } },
        }),
      }),
      /签名校验失败/,
    );

    // 缺失签名且 requireSignature: true 应被拒绝
    const unsignedManifest = { ...signedManifest };
    delete unsignedManifest.signature;
    await assert.rejects(
      () => hotfix.checkForUpdates({
        mirror: 'official',
        manifestUrl,
        publicKeyPem,
        requireSignature: true,
        fetchImpl: makeMockFetch({ [manifestUrl]: { json: unsignedManifest } }),
      }),
      /签名校验失败/,
    );
    await assert.rejects(
      () => hotfix.downloadAndInstall(
        unsignedManifest,
        { mirror: 'official', publicKeyPem, requireSignature: true, fetchImpl: makeMockFetch({ [signedManifest.bundleUrl]: { buffer: bundle098 } }) },
      ),
      /签名校验失败/,
    );
    console.log('[8/8] Ed25519 manifest signature verification & tamper rejection OK');

    console.log('HOTFIX_TEST_OK');
  } finally {
    fs.rmSync(tmpOut, { recursive: true, force: true });
    fs.rmSync(tmpUserData, { recursive: true, force: true });
    fs.rmSync(tmpShellUpgrade, { recursive: true, force: true });
    fs.rmSync(tmpSignedOut, { recursive: true, force: true });
    fs.rmSync(tmpSignedUserData, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
