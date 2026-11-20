'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

const { probe, executeTask, cancelTask, fingerprintReplacements, FFMPEG } = require('../ffmpeg');
const regFactory = require('../renderer/workflow/node-registry');
const engineMod = require('../renderer/workflow/engine');
const tplMod = require('../renderer/workflow/templates');

// 严禁写入 C: 盘，测试产物与工作流缓存全部在 F: 盘项目目录内
const ROOT = path.resolve(__dirname, '..');
const TEST_ROOT = process.env.VGT_TEST_ROOT || path.join(ROOT, 'scripts', 'smoke_wf');
fs.mkdirSync(TEST_ROOT, { recursive: true });
const RUN_ROOT = fs.mkdtempSync(path.join(TEST_ROOT, 'run-'));
const TMP = path.join(RUN_ROOT, 'media');
const CACHE_ROOT = path.join(RUN_ROOT, 'cache');
const OUT_DIR = path.join(TMP, 'exported');

fs.mkdirSync(OUT_DIR, { recursive: true });

// 在 Node 环境中加载 renderer/features/*.js 以收集全部 43 个子功能定义
function loadAllFeatures() {
  global.window = {
    VGT: {
      params: {
        readTimes: () => ({ start: 0, end: 1, duration: 1 }),
      },
    },
  };
  require('../renderer/features/video-gif');
  require('../renderer/features/image');
  require('../renderer/features/svg');
  require('../renderer/features/document');
  const v = global.window.VGT;
  return [
    ...v.VIDEO_FEATURES,
    ...v.IMAGE_FEATURES,
    ...v.SVG_FEATURES,
    ...v.DOC_FEATURES,
  ];
}

function runFfmpegSync(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-y', ...args], { stdio: 'pipe' });
  if (r.status !== 0) {
    throw new Error('生成测试素材失败: ' + r.stderr.toString().slice(-500));
  }
}

// 构造与 main.js 一致的 Node 运行时桥接器
function createNodeRuntime() {
  return {
    async probe(p) {
      try {
        return { ok: true, info: await probe(p) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    async probeMulti(paths) {
      const results = [];
      for (const p of paths) {
        try {
          results.push({ path: p, info: await probe(p) });
        } catch {
          results.push({ path: p, info: null });
        }
      }
      return results;
    },
    listDir(dirPath, limit = 500) {
      try {
        return fs.readdirSync(dirPath)
          .filter((f) => !f.startsWith('.'))
          .slice(0, limit)
          .map((f) => path.join(dirPath, f));
      } catch {
        return [];
      }
    },
    scanDir(opts = {}) {
      const dirPath = opts.dirPath;
      const recursive = !!opts.recursive;
      const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 500));
      const extSet = Array.isArray(opts.extensions) && opts.extensions.length
        ? new Set(opts.extensions.map((e) => String(e).toLowerCase().replace(/^\./, '')))
        : null;
      if (!dirPath || !fs.existsSync(dirPath)) return { ok: false, error: '文件夹不存在', files: [] };
      const results = [];
      const walk = (dir) => {
        if (results.length >= limit) return;
        let entries = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
        for (const ent of entries) {
          if (results.length >= limit) break;
          if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            if (recursive) walk(full);
          } else if (ent.isFile()) {
            const ext = path.extname(ent.name).slice(1).toLowerCase();
            if (!extSet || extSet.has(ext)) results.push(full);
          }
        }
      };
      walk(dirPath);
      return { ok: true, files: results };
    },
    fingerprintReplacements,
    statMulti(filePaths) {
      return (filePaths || []).map((p) => {
        try {
          const st = fs.statSync(p);
          return { path: p, exists: true, isDirectory: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs };
        } catch {
          return { path: p, exists: false, isDirectory: false, size: 0, mtimeMs: 0 };
        }
      });
    },
    allocNodeDir(opts = {}) {
      fs.mkdirSync(CACHE_ROOT, { recursive: true });
      const cleanKey = String(opts.subKey || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      const dir = path.join(CACHE_ROOT, `node_${cleanKey}`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      if (opts.manifestDir) {
        const srcManifest = path.join(opts.manifestDir, '.vgt-manifest.json');
        if (fs.existsSync(srcManifest)) {
          fs.copyFileSync(srcManifest, path.join(dir, '.vgt-manifest.json'));
        }
      }
      return { ok: true, dir };
    },
    exportFiles(opts = {}) {
      const files = (opts.files || []).filter((f) => f && fs.existsSync(f));
      if (!files.length) return { ok: false, error: '没有可导出的文件' };
      const baseRef = opts.originInputPath || files[0];
      let targetDir = opts.outMode === 'custom' && opts.customDir
        ? opts.customDir
        : (opts.outMode === 'subdir' ? path.join(path.dirname(baseRef), 'output') : path.dirname(baseRef));
      fs.mkdirSync(targetDir, { recursive: true });
      const savedPaths = [];
      for (const src of files) {
        const ext = path.extname(src);
        const stem = path.basename(src, ext);
        const dest = path.join(targetDir, `${stem}${opts.suffix || ''}${ext}`);
        fs.copyFileSync(src, dest);
        savedPaths.push(dest);
      }
      return { ok: true, savedPaths, targetDir };
    },
    cancelTask(tid) {
      return cancelTask(tid);
    },
    async startTask(feature, params, onTid, onProg) {
      const taskId = `wf_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      onTid?.(taskId);
      try {
        const res = await executeTask(taskId, feature, params, onProg);
        return { ok: true, taskId, ...res };
      } catch (err) {
        return { ok: false, taskId, cancelled: err.message === '任务已取消', error: err.message };
      }
    },
  };
}

let passed = 0;
let failed = 0;

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}\n     ${err.stack || err.message}`);
  }
}

(async () => {
  console.log('=== 工作流引擎与真实媒体流水线端到端测试 ===\n');
  assert(!/^c:/i.test(CACHE_ROOT), `缓存目录不能在 C 盘: ${CACHE_ROOT}`);

  const features = loadAllFeatures();
  const reg = regFactory.createRegistry(features);
  const runtime = createNodeRuntime();

  await step('1. 节点注册表完整性（9 个 I/O + 73 个子功能 = 82 个节点）', () => {
    const all = reg.getAllDefs();
    assert.strictEqual(features.length, 73);
    assert.strictEqual(all.length, 82);
    assert.deepStrictEqual(
      all.filter((def) => !def.isIo).map((def) => def.type).sort(),
      features.map((feature) => `feat.${feature.id}`).sort(),
    );
    for (const def of all) {
      assert(def.type && def.name && def.group, `节点定义字段缺失: ${def.type}`);
      const dp = def.defaultParams();
      assert(dp && typeof dp === 'object', `defaultParams 异常: ${def.type}`);
    }
  });

  await step('新增工具节点可从画布获取执行参数', () => {
    const build = (id, params, primary, attached, multi) => {
      const type = `feat.${id}`;
      return reg.buildNodeTaskParams({ type, params: { ...reg.getDef(type).defaultParams(), ...params } }, primary, attached, multi);
    };
    const audio = { path: 'voice.wav', info: { duration: 5 } };
    const image = { path: 'image.png', info: { width: 128, height: 72 } };
    const video = { path: 'clip.mp4', info: { duration: 5, width: 128, height: 72, hasAudio: true } };
    assert.equal(build('audioConvert', { bitrate: '64k' }, audio).bitrate, '64k');
    assert.equal(build('audioTrim', { tStart: '1', tEnd: '3' }, audio).duration, 2);
    assert.deepStrictEqual(build('audioMerge', {}, null, {}, [audio, audio]).files, ['voice.wav', 'voice.wav']);
    assert.equal(build('animSprite', { mode: 'fromSprite' }, image).srcW, 128);
    assert.equal(build('imageCanvas', { bgMode: 'black' }, image).bgColor, '#000000');
    assert.deepStrictEqual(build('imageOcr', { ocrLang: 'en' }, image), { input: image.path, ocrLang: 'en' });
    assert.deepStrictEqual(reg.getDynamicOutputSpec({ type: 'feat.imageOcr' }, ['png'], true), { exts: ['txt'], typeId: 'doc', isList: true });
    assert.equal(build('videoCover', {}, video, { coverImage: { paths: ['image.png'] } }).coverImage, 'image.png');
    assert.equal(build('docToPdf', {}, { path: 'readme.md' }).input, 'readme.md');
    assert.equal(build('wordToPdf', { pageSize: 'a4l' }, { path: 'report.docx' }).pageSize, 'a4l');
    assert.equal(build('pdfToWord', { mode: 'ocr' }, { path: 'scan.pdf' }).mode, 'ocr');
    assert.equal(build('pdfCompress', { preset: 'extreme' }, { path: 'big.pdf' }).preset, 'extreme');
    assert.equal(build('pdfCompress', { preset: 'target', targetMB: '2' }, { path: 'big.pdf' }).targetBytes, 2_000_000);
    assert.equal(build('pdfSearchable', { ocrLang: 'zh' }, { path: 'scan.pdf' }).ocrLang, 'zh');
    assert.deepStrictEqual(build('pdfCrop', { padding: '0', pageRange: '2-3' }, { path: 'doc.pdf' }), {
      input: 'doc.pdf', padding: 0, pageRange: '2-3',
    });
    assert.equal(build('pdfRotate', { direction: 'ccw90' }, { path: 'doc.pdf' }).direction, 'ccw90');
    assert.deepStrictEqual(build('pdfNup', { layout: '6', orientation: 'a4l', margin: '12', border: 'no', order: 'col', pageRange: '1-6' }, { path: 'doc.pdf' }), {
      input: 'doc.pdf', layout: '6', orientation: 'a4l', margin: '12', border: 'no', order: 'col', pageRange: '1-6',
    });
    assert.deepStrictEqual(reg.getDynamicOutputSpec({ type: 'feat.pdfNup' }, ['pdf'], true), { exts: ['pdf'], typeId: 'pdf', isList: true });
    assert.deepStrictEqual(build('subtitleConvert', { format: 'vtt', shiftSec: '1.5', stripTags: 'no', txtTimestamps: 'yes' }, { path: 'sub.srt' }), {
      input: 'sub.srt', format: 'vtt', shiftSec: '1.5', stripTags: 'no', txtTimestamps: 'yes',
    });
    assert.deepStrictEqual(reg.getDynamicOutputSpec({ type: 'feat.subtitleConvert', params: { format: 'vtt' } }, ['srt'], false), { exts: ['vtt'], typeId: 'subtitle', isList: false });
    assert.deepStrictEqual(reg.getDynamicOutputSpec({ type: 'feat.subtitleConvert', params: { format: 'txt' } }, ['ass'], true), { exts: ['txt'], typeId: 'doc', isList: true });
    assert.equal(build('pdfWatermark', { contentMode: 'both' }, { path: 'doc.pdf' }).wmText, '内部资料 · 严禁外传');
    assert.equal(build('addMusic', { ducking: 'yes' }, video, { music: { paths: ['voice.wav'] } }).ducking, 'yes');
    assert.equal(build('watermark', { pos: 'tiled', tileAngle: '0' }, video).tileAngle, '0');
    const gifRatio = build('videoToGif', { width: 'p50' }, video);
    assert.equal(gifRatio.width, 'p50');
    assert.equal(gifRatio.srcW, 128);
    const gifCustom = build('videoToGif', { width: 'custom', customWidth: '720' }, video);
    assert.equal(gifCustom.width, 'custom');
    assert.equal(gifCustom.customWidth, '720');
    assert.equal(gifCustom.srcW, 128);
    const gifKeep = build('videoToGif', { width: '0' }, video);
    assert.equal(gifKeep.width, '0');
    assert.equal(gifKeep.srcW, 128);
  });

  await step('单工具与画布共用格式转换校验', async () => {
    const options = { mode: 'encode', format: 'mov', vcodec: 'av1', height: '0', quality: 'medium' };
    const file = { path: 'clip.mp4', info: { duration: 1 } };
    const fromSingleTool = features.find(({ id }) => id === 'convertVideo').collect(options, { file });
    const fromWorkflow = reg.buildNodeTaskParams({ type: 'feat.convertVideo', params: options }, file);
    assert.deepStrictEqual(fromSingleTool, fromWorkflow);
    await assert.rejects(executeTask('wf-invalid-codec', 'convertVideo', fromWorkflow), /MOV 容器不支持 AV1/);
  });

  await step('2. 连线校验（自连/环路/不兼容格式拒绝 & 动态输出推断）', () => {
    const g = {
      nodes: [
        { id: 'n1', type: 'io.loadFile', x: 0, y: 0, params: { filePath: 'a.mp4' } },
        { id: 'n2', type: 'feat.extractAudio', x: 300, y: 0, params: { format: 'mp3' } },
        { id: 'n3', type: 'feat.svgOptimize', x: 600, y: 0, params: {} },
        { id: 'n4', type: 'feat.trimVideo', x: 300, y: 200, params: {} },
        { id: 'n5', type: 'feat.subtitleTool', x: 600, y: 200, params: { mode: 'extract' } },
      ],
      edges: [
        { id: 'e1', fromNode: 'n1', fromPort: 'media', toNode: 'n2', toPort: 'input' },
        { id: 'e2', fromNode: 'n1', fromPort: 'media', toNode: 'n4', toPort: 'input' },
      ],
    };
    assert.strictEqual(reg.canConnect(g, 'n1', 'media', 'n1', 'media').ok, false, '应拒绝自连');
    assert.strictEqual(reg.canConnect(g, 'n2', 'out', 'n3', 'input').ok, false, '音频输出不应连给 SVG 优化');
    assert.strictEqual(reg.canConnect(g, 'n4', 'out', 'n1', 'media').ok, false, '不存在输入端口应拒绝');

    const cycleGraph = {
      nodes: [
        { id: 'a', type: 'feat.trimVideo', x: 0, y: 0, params: {} },
        { id: 'b', type: 'feat.rotateFlip', x: 300, y: 0, params: {} },
      ],
      edges: [{ id: 'e', fromNode: 'a', fromPort: 'out', toNode: 'b', toPort: 'input' }],
    };
    assert.strictEqual(reg.canConnect(cycleGraph, 'b', 'out', 'a', 'input').ok, false, '应拒绝形成有向环');

    const subSpecExtract = reg.getNodeOutputSpec(g, 'n5', 'out');
    assert.deepStrictEqual(subSpecExtract.exts, ['srt'], '字幕提取模式动态输出应为 srt');
    g.nodes[4].params.mode = 'burn';
    const subSpecBurn = reg.getNodeOutputSpec(g, 'n5', 'out');
    assert(subSpecBurn.exts.includes('mp4'), '字幕烧录模式动态输出应包含视频格式');
  });

  await step('3. 7 套预设模板通过 normalizeGraphData 与拓扑排序校验', () => {
    assert.strictEqual(tplMod.WORKFLOW_TEMPLATES.length, 7);
    for (const tpl of tplMod.WORKFLOW_TEMPLATES) {
      const norm = tplMod.normalizeGraphData(tpl.graph, reg);
      assert.strictEqual(norm.nodes.length, tpl.graph.nodes.length, `模板 ${tpl.id} 节点数丢失`);
      assert.strictEqual(norm.edges.length, tpl.graph.edges.length, `模板 ${tpl.id} 连线数丢失`);
      const order = engineMod.topologicalSort(norm);
      assert.strictEqual(order.length, norm.nodes.length, `模板 ${tpl.id} 拓扑排序不完整`);
    }
  });

  // 准备真实媒体素材（全部在 F: 盘 scripts/smoke_wf 下）
  console.log('\n正在生成工作流测试媒体素材…');
  const testMp4 = path.join(TMP, 'clip1.mp4');
  const testMp4B = path.join(TMP, 'clip2.mp4');
  const bigPng = path.join(TMP, 'big_screen.png');
  const testDocx = path.join(TMP, 'sample_wf.docx');

  runFfmpegSync([
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', testMp4,
  ]);
  runFfmpegSync([
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', testMp4B,
  ]);
  runFfmpegSync(['-f', 'lavfi', '-i', 'testsrc2=size=1280x800:duration=0.1', '-frames:v', '1', bigPng]);

  const docxZip = new AdmZip();
  docxZip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>', 'utf8'));
  docxZip.addFile('word/_rels/document.xml.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/screen.png"/></Relationships>', 'utf8'));
  docxZip.addFile('word/document.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:drawing r:embed="rId1"/></w:r></w:p></w:body></w:document>', 'utf8'));
  docxZip.addFile('word/media/screen.png', fs.readFileSync(bigPng));
  docxZip.writeZip(testDocx);

  const cacheStore = new Map();
  const runner = engineMod.createWorkflowRunner({ registry: reg, cacheStore });

  const flow1 = tplMod.normalizeGraphData({
    name: '流水线1',
    nodes: [
      { id: 'n1', type: 'io.loadFile', x: 0, y: 0, params: { filePath: testMp4 } },
      { id: 'n2', type: 'feat.trimVideo', x: 300, y: 0, params: { tStart: 0.5, tEnd: 2.5, precise: 'precise' } },
      { id: 'n3', type: 'feat.watermark', x: 600, y: 0, params: { mode: 'text', text: 'WF-Test', pos: 'br', size: 'medium', opacity: '0.7' } },
      { id: 'n4', type: 'feat.videoToGif', x: 900, y: 0, params: { tStart: 0, tEnd: 0, fps: '12', width: '480', colors: '128' } },
      { id: 'n5', type: 'feat.compressGif', x: 1200, y: 0, params: { width: '480', fps: '10', colors: '128', dither: 'bayer5', statsMode: 'diff', denoise: 'none', dedup: 'no', diffMode: 'rectangle', speed: '1', loop: '0', useTrim: 'no' } },
      { id: 'n6', type: 'io.save', x: 1500, y: 0, params: { outMode: 'custom', customDir: OUT_DIR, suffix: '_wf1', exportAsFolder: 'flat', noOverwrite: 'no' } },
    ],
    edges: [
      { id: 'e1', fromNode: 'n1', fromPort: 'media', toNode: 'n2', toPort: 'input' },
      { id: 'e2', fromNode: 'n2', fromPort: 'out', toNode: 'n3', toPort: 'input' },
      { id: 'e3', fromNode: 'n3', fromPort: 'out', toNode: 'n4', toPort: 'input' },
      { id: 'e4', fromNode: 'n4', fromPort: 'out', toNode: 'n5', toPort: 'input' },
      { id: 'e5', fromNode: 'n5', fromPort: 'out', toNode: 'n6', toPort: 'media' },
    ],
  }, reg);

  await step('4. 真实流水线 1（视频→截取→水印→转GIF→压缩→导出）', async () => {
    const filesBeforeInSrcDir = fs.readdirSync(TMP);
    const { promise } = runner.execute(flow1, runtime, { hwAccel: 'cpu' });
    const res = await promise;
    assert.strictEqual(res.summary.executed, 6);
    assert.strictEqual(res.summary.exportedFiles.length, 1);
    const outGif = res.summary.exportedFiles[0];
    assert(fs.existsSync(outGif) && fs.statSync(outGif).size > 0, '导出 GIF 应非空');
    const info = await probe(outGif);
    assert.strictEqual(info.width, 480, `导出 GIF 宽度应为 480，实际 ${info.width}`);
    // 确认中间节点未在源文件目录留下临时输出
    const filesAfterInSrcDir = fs.readdirSync(TMP);
    assert.deepStrictEqual(filesBeforeInSrcDir, filesAfterInSrcDir, '中间缓存不应污染源文件目录');
    // 确认中间产物全部写入非 C 盘 .workflow_cache
    const n4Out = res.outputs.get('n4').paths[0];
    assert(n4Out.startsWith(CACHE_ROOT), `中间节点产物应写入 ${CACHE_ROOT}，实际 ${n4Out}`);
  });

  await step('5. 增量智能缓存验证（仅改末端压缩参数，前 4 节点全部秒级命中缓存）', async () => {
    flow1.nodes[4].params.colors = '64';
    const { promise } = runner.execute(flow1, runtime, { hwAccel: 'cpu' });
    const res = await promise;
    assert.strictEqual(res.summary.cached, 4, `应命中 4 个上游缓存，实际 ${res.summary.cached}`);
    assert.strictEqual(res.summary.executed, 2, `应只执行 2 个受影响节点，实际 ${res.summary.executed}`);
  });

  await step('6. 真实流水线 2（Word 提取图片→批处理转 JPG→Manifest 自动匹配写回原位）', async () => {
    const flowDoc = tplMod.normalizeGraphData({
      name: 'Word提取压缩回填',
      nodes: [
        { id: 'd1', type: 'io.loadFile', x: 0, y: 100, params: { filePath: testDocx } },
        { id: 'd2', type: 'feat.docExtractImages', x: 300, y: 0, params: { naming: 'order', pptMedia: 'images', remoteMode: 'skip', includeSvg: 'yes', dedupe: 'yes' } },
        { id: 'd3', type: 'feat.imageConvert', x: 600, y: 0, params: { format: 'jpg', quality: 'medium', resizeMode: 'maxSide', maxSide: '1280', bgColor: '#ffffff', stripMeta: 'yes' } },
        { id: 'd4', type: 'feat.docRepackImages', x: 900, y: 100, params: {} },
        { id: 'd5', type: 'io.save', x: 1200, y: 100, params: { outMode: 'custom', customDir: OUT_DIR, suffix: '_wf_repack', exportAsFolder: 'flat', noOverwrite: 'no' } },
      ],
      edges: [
        { id: 'de1', fromNode: 'd1', fromPort: 'media', toNode: 'd2', toPort: 'input' },
        { id: 'de2', fromNode: 'd2', fromPort: 'out', toNode: 'd3', toPort: 'input' },
        { id: 'de3', fromNode: 'd1', fromPort: 'media', toNode: 'd4', toPort: 'input' },
        { id: 'de4', fromNode: 'd3', fromPort: 'out', toNode: 'd4', toPort: 'replaceSource' },
        { id: 'de5', fromNode: 'd4', fromPort: 'out', toNode: 'd5', toPort: 'media' },
      ],
    }, reg);

    const { promise } = runner.execute(flowDoc, runtime, { hwAccel: 'cpu' });
    const res = await promise;
    const outDocx = res.summary.exportedFiles[0];
    assert(fs.existsSync(outDocx), '应成功导出回填后的 docx');
    const z = new AdmZip(outDocx);
    const relsXml = z.getEntry('word/_rels/document.xml.rels').getData().toString('utf8');
    assert(/media\/screen\.jpg/i.test(relsXml), `docx 媒体关系未更新为 jpg: ${relsXml}`);
    assert(fs.statSync(outDocx).size < fs.statSync(testDocx).size, '回填压缩 JPG 后文档体积应显著减小');
  });

  await step('回填图片原位修改后，工作流重新生成文档', async () => {
    const replaceDir = path.join(TMP, 'local-replacements');
    fs.mkdirSync(replaceDir);
    const image = path.join(replaceDir, 'screen.png');
    const renderImage = (color) => runFfmpegSync(['-f', 'lavfi', '-i', `color=${color}:s=64x64`, '-frames:v', '1', image]);
    renderImage('red');
    const target = tplMod.normalizeGraphData({
      name: '本地图片回填',
      nodes: [
        { id: 'local-doc', type: 'io.loadFile', x: 0, y: 0, params: { filePath: testDocx } },
        { id: 'local-repack', type: 'feat.docRepackImages', x: 300, y: 0, params: { __local_replaceSource: replaceDir } },
      ],
      edges: [{ id: 'local-edge', fromNode: 'local-doc', fromPort: 'media', toNode: 'local-repack', toPort: 'input' }],
    }, reg);
    const getImage = (result) => new AdmZip(result.outputs.get('local-repack').paths[0]).readFile('word/media/screen.png');
    const first = await runner.execute(target, runtime).promise;
    assert.deepEqual(getImage(first), fs.readFileSync(image));
    const cached = await runner.execute(target, runtime).promise;
    assert.equal(cached.summary.cached, 2);
    const dirStat = fs.statSync(replaceDir);
    renderImage('blue');
    fs.utimesSync(replaceDir, dirStat.atime, dirStat.mtime);
    const updated = await runner.execute(target, runtime).promise;
    assert.equal(updated.summary.executed, 1);
    assert.deepEqual(getImage(updated), fs.readFileSync(image));
    assert.notDeepEqual(getImage(updated), getImage(first));
  });

  await step('7. 真实流水线 3（双视频多线汇聚合并 + 归一化裁剪 + Bypass 旁路跳过）', async () => {
    const flowMerge = tplMod.normalizeGraphData({
      name: '合并裁剪旁路流',
      nodes: [
        { id: 'm1', type: 'io.loadFile', x: 0, y: 0, params: { filePath: testMp4 } },
        { id: 'm2', type: 'io.loadFile', x: 0, y: 200, params: { filePath: testMp4B } },
        { id: 'm3', type: 'feat.mergeVideos', x: 300, y: 100, params: { mode: 'compat' } },
        { id: 'm4', type: 'feat.videoCrop', x: 600, y: 100, params: { crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } } },
        { id: 'm5', type: 'feat.rotateFlip', x: 900, y: 100, bypass: true, params: { mode: 'r90' } },
        { id: 'm6', type: 'io.save', x: 1200, y: 100, params: { outMode: 'custom', customDir: OUT_DIR, suffix: '_wf_merge', exportAsFolder: 'flat', noOverwrite: 'no' } },
      ],
      edges: [
        { id: 'me1', fromNode: 'm1', fromPort: 'media', toNode: 'm3', toPort: 'files' },
        { id: 'me2', fromNode: 'm2', fromPort: 'media', toNode: 'm3', toPort: 'files' },
        { id: 'me3', fromNode: 'm3', fromPort: 'out', toNode: 'm4', toPort: 'input' },
        { id: 'me4', fromNode: 'm4', fromPort: 'out', toNode: 'm5', toPort: 'input' },
        { id: 'me5', fromNode: 'm5', fromPort: 'out', toNode: 'm6', toPort: 'media' },
      ],
    }, reg);

    const { promise } = runner.execute(flowMerge, runtime, { hwAccel: 'cpu' });
    const res = await promise;
    assert.strictEqual(res.summary.bypassed, 1, '应有 1 个旁路节点');
    const outVid = res.summary.exportedFiles[0];
    const info = await probe(outVid);
    // 640x360 裁剪 0.5x0.5 = 320x180，旁路 rotateFlip(r90) 未执行所以应保持横向 320x180，合并总长 7s
    assert.strictEqual(info.width, 320, `裁剪+旁路后宽度应为 320，实际 ${info.width}`);
    assert.strictEqual(info.height, 180, `裁剪+旁路后高度应为 180，实际 ${info.height}`);
    assert(Math.abs(info.duration - 7) < 0.8, `合并后总时长应约 7s，实际 ${info.duration}`);
  });

  await step('8. 真实流水线 4（多图合成 PDF + Word 清理冗余→图片美化）', async () => {
    const imgB = path.join(TMP, 'small_page.png');
    runFfmpegSync(['-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=0.1', '-frames:v', '1', imgB]);

    const flowPdf = tplMod.normalizeGraphData({
      name: '多图转PDF',
      nodes: [
        { id: 'p1', type: 'io.loadBatch', x: 0, y: 0, params: { filterKind: 'image', filePaths: [bigPng, imgB] } },
        { id: 'p2', type: 'feat.imagesToPdf', x: 300, y: 0, params: { pageSize: 'fit', margin: '10', quality: 'medium', bgColor: '#ffffff' } },
        { id: 'p3', type: 'io.save', x: 600, y: 0, params: { outMode: 'custom', customDir: OUT_DIR, suffix: '_wf_pdf', exportAsFolder: 'flat', noOverwrite: 'no' } },
      ],
      edges: [
        { id: 'pe1', fromNode: 'p1', fromPort: 'media', toNode: 'p2', toPort: 'files' },
        { id: 'pe2', fromNode: 'p2', fromPort: 'out', toNode: 'p3', toPort: 'media' },
      ],
    }, reg);

    const { promise: pdfProm } = runner.execute(flowPdf, runtime, { hwAccel: 'cpu' });
    const pdfRes = await pdfProm;
    const outPdf = pdfRes.summary.exportedFiles[0];
    assert(fs.existsSync(outPdf) && outPdf.endsWith('.pdf'), '应成功导出 PDF 文件');
    const pdfInfo = await probe(outPdf);
    assert.strictEqual(pdfInfo.docType, 'pdf');
    assert.strictEqual(pdfInfo.pageCount, 2, `PDF 应有 2 页，实际 ${pdfInfo.pageCount}`);

    const flowDocStyle = tplMod.normalizeGraphData({
      name: 'Word清理与美化',
      nodes: [
        { id: 'ds1', type: 'io.loadFile', x: 0, y: 0, params: { filePath: testDocx } },
        { id: 'ds2', type: 'feat.docCleanupMedia', x: 300, y: 0, params: { removeOrphans: 'yes', dedupeMedia: 'yes' } },
        { id: 'ds3', type: 'feat.docStyleImages', x: 600, y: 0, params: { frameMode: 'roundedBorder', radius: '16', borderWidth: '12', borderColor: '#ffffff', wmText: '工作流测试' } },
        { id: 'ds4', type: 'io.save', x: 900, y: 0, params: { outMode: 'custom', customDir: OUT_DIR, suffix: '_wf_styled', exportAsFolder: 'flat', noOverwrite: 'no' } },
      ],
      edges: [
        { id: 'dse1', fromNode: 'ds1', fromPort: 'media', toNode: 'ds2', toPort: 'input' },
        { id: 'dse2', fromNode: 'ds2', fromPort: 'out', toNode: 'ds3', toPort: 'input' },
        { id: 'dse3', fromNode: 'ds3', fromPort: 'out', toNode: 'ds4', toPort: 'media' },
      ],
    }, reg);

    const { promise: docProm } = runner.execute(flowDocStyle, runtime, { hwAccel: 'cpu' });
    const docRes = await docProm;
    const outStyledDocx = docRes.summary.exportedFiles[0];
    assert(fs.existsSync(outStyledDocx) && outStyledDocx.endsWith('.docx'), '应成功导出美化后的 docx');
    const docInfo = await probe(outStyledDocx);
    assert.strictEqual(docInfo.imageCount, 1);
  });

  await step('9. 文件夹扫描 + 按格式分流 + 条件分流 + 空分支跳过 + 多分支汇聚导出', async () => {
    const mixDir = path.join(TMP, 'mix_folder');
    const subDir = path.join(mixDir, 'nested');
    const routeOutDir = path.join(TMP, 'route_exported');
    fs.mkdirSync(subDir, { recursive: true });
    fs.mkdirSync(routeOutDir, { recursive: true });

    const bigImg = path.join(mixDir, 'hero_wide.png');
    const smallImg = path.join(subDir, 'thumb_small.png');
    const svgFile = path.join(subDir, 'logo.svg');
    fs.copyFileSync(bigPng, bigImg);
    runFfmpegSync(['-f', 'lavfi', '-i', 'color=c=red:s=200x120:d=0.1', '-frames:v', '1', smallImg]);
    fs.writeFileSync(svgFile, '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect x="0" y="0" width="120" height="120" fill="#3366ff"/><!-- comment --></svg>', 'utf8');

    const nodeStatesLog = new Map();
    const flowRoute = tplMod.normalizeGraphData({
      name: '目录混合素材分流',
      nodes: [
        { id: 'r1', type: 'io.loadFolder', x: 0, y: 200, params: { dirPath: mixDir, recursive: 'yes', filterKind: 'all' } },
        { id: 'r2', type: 'io.routeType', x: 340, y: 200, params: { gifBucket: 'anims' } },
        // images 分支再按宽度 > 500 条件分流
        { id: 'r3', type: 'io.routeCondition', x: 680, y: 60, params: { rule: 'widthGt', threshold: '500', keyword: '' } },
        { id: 'r4', type: 'feat.imageConvert', x: 1020, y: 0, params: { format: 'webp', quality: 'medium', resizeMode: 'keep', maxSide: '1920', bgColor: '#ffffff', stripMeta: 'yes' } },
        { id: 'r5', type: 'feat.imageFrame', x: 1020, y: 180, params: { rounded: '16', padding: '8', format: 'png', bgMode: 'transparent' } },
        // svgs 分支
        { id: 'r6', type: 'feat.svgOptimize', x: 680, y: 320, params: { preset: 'default', floatPrecision: '2', keepViewBox: 'yes', stripDims: 'no' } },
        // anims 为空分支（目录中没有视频/GIF），应自动跳过而非报错
        { id: 'r7', type: 'feat.compressTarget', x: 680, y: 520, params: { targetMB: '2' } },
        // 多分支汇聚同一个保存节点
        { id: 'r8', type: 'io.save', x: 1380, y: 220, params: { outMode: 'custom', customDir: routeOutDir, suffix: '_rt', exportAsFolder: 'flat', noOverwrite: 'no' } },
      ],
      edges: [
        { id: 're1', fromNode: 'r1', fromPort: 'media', toNode: 'r2', toPort: 'items' },
        { id: 're2', fromNode: 'r2', fromPort: 'images', toNode: 'r3', toPort: 'items' },
        { id: 're3', fromNode: 'r3', fromPort: 'matched', toNode: 'r4', toPort: 'input' },
        { id: 're4', fromNode: 'r3', fromPort: 'unmatched', toNode: 'r5', toPort: 'input' },
        { id: 're5', fromNode: 'r2', fromPort: 'svgs', toNode: 'r6', toPort: 'input' },
        { id: 're6', fromNode: 'r2', fromPort: 'anims', toNode: 'r7', toPort: 'input' },
        { id: 're7', fromNode: 'r4', fromPort: 'out', toNode: 'r8', toPort: 'media' },
        { id: 're8', fromNode: 'r5', fromPort: 'out', toNode: 'r8', toPort: 'media' },
        { id: 're9', fromNode: 'r6', fromPort: 'out', toNode: 'r8', toPort: 'media' },
        { id: 're10', fromNode: 'r7', fromPort: 'out', toNode: 'r8', toPort: 'media' },
      ],
    }, reg);

    const { promise } = runner.execute(flowRoute, runtime, {
      hwAccel: 'cpu',
      onNodeState(nid, st) {
        nodeStatesLog.set(nid, st);
      },
    });
    const res = await promise;
    assert.strictEqual(res.summary.skipped, 1, `空分支 r7 应被跳过 1 次，实际 ${res.summary.skipped}`);
    assert.strictEqual(nodeStatesLog.get('r7')?.status, 'skipped', 'r7 状态应为 skipped');
    assert.deepStrictEqual(res.outputs.get('r2').branchCounts, { images: 2, svgs: 1, anims: 0, others: 0 });
    assert.deepStrictEqual(res.outputs.get('r3').branchCounts, { matched: 1, unmatched: 1 });
    assert.strictEqual(res.summary.exportedFiles.length, 3, `多分支汇总应导出 3 个文件，实际 ${res.summary.exportedFiles.length}`);
    assert(res.summary.exportedFiles.some((p) => p.endsWith('.webp')), '大图分支应导出 webp');
    assert(res.summary.exportedFiles.some((p) => p.endsWith('.png')), '小图分支应导出 png');
    assert(res.summary.exportedFiles.some((p) => p.endsWith('.svg')), 'SVG 分支应导出 svg');
  });

  await step('10. PDF 闭环流水线（多图合成→合并→提取拆分→转长图）与 DAG 多分支并行执行', async () => {
    const pdfFlowDir = path.join(TMP, 'pdf_wf_out');
    fs.mkdirSync(pdfFlowDir, { recursive: true });
    const imgP1 = path.join(TMP, 'pdf_p1.png');
    const imgP2 = path.join(TMP, 'pdf_p2.png');
    runFfmpegSync(['-f', 'lavfi', '-i', 'color=c=navy:s=400x300:d=0.1', '-frames:v', '1', imgP1]);
    runFfmpegSync(['-f', 'lavfi', '-i', 'color=c=teal:s=400x300:d=0.1', '-frames:v', '1', imgP2]);

    const flowPdfLoop = tplMod.normalizeGraphData({
      name: 'PDF闭环与并行分支',
      nodes: [
        // 两个独立上游分支应并行构建两份 PDF
        { id: 'pl1', type: 'io.loadBatch', x: 0, y: 0, params: { filterKind: 'image', filePaths: [bigPng, imgP1] } },
        { id: 'pl2', type: 'io.loadBatch', x: 0, y: 240, params: { filterKind: 'image', filePaths: [imgP2] } },
        { id: 'pl3', type: 'feat.imagesToPdf', x: 300, y: 0, params: { pageSize: 'fit', margin: '0', quality: 'medium', bgColor: '#ffffff' } },
        { id: 'pl4', type: 'feat.imagesToPdf', x: 300, y: 240, params: { pageSize: 'fit', margin: '0', quality: 'medium', bgColor: '#ffffff' } },
        // 汇聚合并成 3 页 PDF
        { id: 'pl5', type: 'feat.pdfMerge', x: 600, y: 120, params: {} },
        // 提取第 1,3 页为 2 页 PDF
        { id: 'pl6', type: 'feat.pdfSplit', x: 900, y: 120, params: { mode: 'extract', pageRange: '1,3' } },
        // 转纵向长图
        { id: 'pl7', type: 'feat.pdfToImages', x: 1200, y: 120, params: { mode: 'longImage', format: 'jpg', dpiScale: '1.5', pageRange: '' } },
        { id: 'pl8', type: 'io.save', x: 1500, y: 120, params: { outMode: 'custom', customDir: pdfFlowDir, suffix: '_pdflong', exportAsFolder: 'flat', noOverwrite: 'no' } },
      ],
      edges: [
        { id: 'ple1', fromNode: 'pl1', fromPort: 'media', toNode: 'pl3', toPort: 'files' },
        { id: 'ple2', fromNode: 'pl2', fromPort: 'media', toNode: 'pl4', toPort: 'files' },
        { id: 'ple3', fromNode: 'pl3', fromPort: 'out', toNode: 'pl5', toPort: 'files' },
        { id: 'ple4', fromNode: 'pl4', fromPort: 'out', toNode: 'pl5', toPort: 'files' },
        { id: 'ple5', fromNode: 'pl5', fromPort: 'out', toNode: 'pl6', toPort: 'input' },
        { id: 'ple6', fromNode: 'pl6', fromPort: 'out', toNode: 'pl7', toPort: 'input' },
        { id: 'ple7', fromNode: 'pl7', fromPort: 'out', toNode: 'pl8', toPort: 'media' },
      ],
    }, reg);

    const { promise } = runner.execute(flowPdfLoop, runtime, { hwAccel: 'cpu' });
    const res = await promise;
    assert.strictEqual(res.summary.exportedFiles.length, 1);
    const longImg = res.summary.exportedFiles[0];
    assert(fs.existsSync(longImg) && longImg.endsWith('.jpg'), 'PDF 转长图应导出 JPG');
    const info = await probe(longImg);
    assert(info.isImage && info.height > info.width, `PDF 2 页纵向长图尺寸异常: ${info.width}x${info.height}`);
  });

  await step('11. 类 iLovePDF 流水线（PDF 旋转→水印页码→压缩瘦身→转可编辑 Word）', async () => {
    const officeOutDir = path.join(TMP, 'pdf_office_wf_out');
    fs.mkdirSync(officeOutDir, { recursive: true });
    const { PDFDocument, StandardFonts } = require('pdf-lib');
    const srcPdf = path.join(TMP, 'office_src.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const p1 = doc.addPage([595, 842]);
    p1.drawText('Workflow Office Pipeline 2026', { x: 60, y: 760, size: 22, font });
    p1.drawText('Automated PDF rotate, watermark, compress and convert to Word.', { x: 60, y: 710, size: 12, font });
    fs.writeFileSync(srcPdf, await doc.save());

    const flowOffice = tplMod.normalizeGraphData({
      name: 'PDF办公批处理流',
      nodes: [
        { id: 'o1', type: 'io.loadFile', x: 0, y: 0, params: { filePath: srcPdf } },
        { id: 'o2', type: 'feat.pdfRotate', x: 300, y: 0, params: { direction: 'cw90', pageRange: '' } },
        { id: 'o3', type: 'feat.pdfWatermark', x: 600, y: 0, params: { contentMode: 'both', wmText: '工作流测试', wmStyle: 'center', wmColor: '#64748b', wmOpacity: '0.28', wmSize: 'medium', numFormat: 'slash', numPos: 'bc', numStart: '1', pageRange: '' } },
        { id: 'o4', type: 'feat.pdfCompress', x: 900, y: 0, params: { preset: 'balanced', maxSide: '1920', rasterDpi: '150' } },
        { id: 'o5', type: 'feat.pdfToWord', x: 1200, y: 0, params: { mode: 'editable', ocrLang: 'auto', keepPageBreak: 'yes', dpiScale: '2', pageRange: '' } },
        { id: 'o6', type: 'io.save', x: 1500, y: 0, params: { outMode: 'custom', customDir: officeOutDir, suffix: '_office', exportAsFolder: 'flat', noOverwrite: 'no' } },
      ],
      edges: [
        { id: 'oe1', fromNode: 'o1', fromPort: 'media', toNode: 'o2', toPort: 'input' },
        { id: 'oe2', fromNode: 'o2', fromPort: 'out', toNode: 'o3', toPort: 'input' },
        { id: 'oe3', fromNode: 'o3', fromPort: 'out', toNode: 'o4', toPort: 'input' },
        { id: 'oe4', fromNode: 'o4', fromPort: 'out', toNode: 'o5', toPort: 'input' },
        { id: 'oe5', fromNode: 'o5', fromPort: 'out', toNode: 'o6', toPort: 'media' },
      ],
    }, reg);

    const { promise } = runner.execute(flowOffice, runtime, { hwAccel: 'cpu' });
    const res = await promise;
    assert.strictEqual(res.summary.exportedFiles.length, 1);
    const outDocx = res.summary.exportedFiles[0];
    assert(fs.existsSync(outDocx) && outDocx.endsWith('.docx'), 'PDF 转 Word 应导出 .docx');
    const z = new AdmZip(outDocx);
    const docXml = z.getEntry('word/document.xml').getData().toString('utf8');
    assert(docXml.includes('Workflow Office Pipeline 2026'), '导出的 Word 应保留原文标题');
  });

  await step('12. PDF 多页拼版与字幕转换节点流水线端到端执行', async () => {
    const newNodesOutDir = path.join(TMP, 'new_nodes_wf_out');
    fs.mkdirSync(newNodesOutDir, { recursive: true });
    const { PDFDocument, StandardFonts } = require('pdf-lib');
    const srcPdf = path.join(TMP, 'nup_wf_src.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    for (let i = 1; i <= 4; i++) {
      const p = doc.addPage([595, 842]);
      p.drawText(`Slide ${i}`, { x: 80, y: 740, size: 24, font });
    }
    fs.writeFileSync(srcPdf, await doc.save());

    const srcSub = path.join(TMP, 'sub_wf_src.srt');
    fs.writeFileSync(srcSub, '1\n00:00:01,000 --> 00:00:03,000\n<i>Hello</i> {\\an8}World\n', 'utf8');

    const flowNew = tplMod.normalizeGraphData({
      name: '拼版与字幕工作流',
      nodes: [
        { id: 'n1', type: 'io.loadFile', x: 0, y: 0, params: { filePath: srcPdf } },
        { id: 'n2', type: 'feat.pdfNup', x: 300, y: 0, params: { layout: '4', orientation: 'auto', margin: '24', border: 'yes', order: 'row', pageRange: '' } },
        { id: 'n3', type: 'io.loadFile', x: 0, y: 200, params: { filePath: srcSub } },
        { id: 'n4', type: 'feat.subtitleConvert', x: 300, y: 200, params: { format: 'vtt', shiftSec: '1', stripTags: 'yes', txtTimestamps: 'no' } },
        { id: 'n5', type: 'io.save', x: 600, y: 100, params: { outMode: 'custom', customDir: newNodesOutDir, suffix: '', exportAsFolder: 'flat', noOverwrite: 'no' } },
      ],
      edges: [
        { id: 'e1', fromNode: 'n1', fromPort: 'media', toNode: 'n2', toPort: 'input' },
        { id: 'e2', fromNode: 'n2', fromPort: 'out', toNode: 'n5', toPort: 'media' },
        { id: 'e3', fromNode: 'n3', fromPort: 'media', toNode: 'n4', toPort: 'input' },
        { id: 'e4', fromNode: 'n4', fromPort: 'out', toNode: 'n5', toPort: 'media' },
      ],
    }, reg);

    const { promise } = runner.execute(flowNew, runtime, { hwAccel: 'cpu' });
    const res = await promise;
    assert.strictEqual(res.summary.exportedFiles.length, 2);
    const outPdf = res.summary.exportedFiles.find((f) => f.endsWith('.pdf'));
    const outVtt = res.summary.exportedFiles.find((f) => f.endsWith('.vtt'));
    assert(outPdf && fs.existsSync(outPdf), '工作流应导出拼版 PDF');
    assert(outVtt && fs.existsSync(outVtt), '工作流应导出 VTT 字幕');
    const nupDoc = await PDFDocument.load(fs.readFileSync(outPdf));
    assert.strictEqual(nupDoc.getPageCount(), 1, '4 页拼 4 合 1 应输出 1 页 PDF');
    const vttBody = fs.readFileSync(outVtt, 'utf8');
    assert(vttBody.includes('00:00:02.000 --> 00:00:04.000') && vttBody.includes('Hello World'));
  });

  // 清理测试素材与中间缓存
  fs.rmSync(RUN_ROOT, { recursive: true, force: true });

  console.log(`\n工作流测试汇总：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
