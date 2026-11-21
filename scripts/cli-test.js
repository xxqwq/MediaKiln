'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');
const { FFMPEG, probe } = require('../ffmpeg');

const ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(ROOT, 'cli.js');
const TEST_BASE = process.env.VGT_TEST_ROOT || path.join(ROOT, 'scripts', 'smoke_cli');
fs.mkdirSync(TEST_BASE, { recursive: true });
const WORK = fs.mkdtempSync(path.join(TEST_BASE, 'run-'));

function runCli(args, { env = {} } = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: WORK,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 90000,
  });
}

function runFfmpeg(args) {
  const res = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`ffmpeg 生成素材失败: ${res.stderr}`);
  }
}

let passed = 0;
let failed = 0;

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name}\n     ${err.stack || err.message}`);
  }
}

async function prepareFixtures() {
  const mediaDir = path.join(WORK, 'fixtures');
  fs.mkdirSync(mediaDir, { recursive: true });

  const mp4Path = path.join(mediaDir, 'sample.mp4');
  runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc=duration=2.5:size=320x240:rate=20',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    mp4Path,
  ]);

  const img1 = path.join(mediaDir, 'pic_01.png');
  const img2 = path.join(mediaDir, 'pic_02.png');
  const wmImg = path.join(mediaDir, 'badge.png');
  runFfmpeg(['-f', 'lavfi', '-i', 'color=c=royalblue:s=160x120', '-frames:v', '1', '-update', '1', img1]);
  runFfmpeg(['-f', 'lavfi', '-i', 'color=c=tomato:s=160x120', '-frames:v', '1', '-update', '1', img2]);
  runFfmpeg(['-f', 'lavfi', '-i', 'color=c=white:s=40x40', '-frames:v', '1', '-update', '1', wmImg]);

  const svgPath = path.join(mediaDir, 'logo.svg');
  fs.writeFileSync(svgPath, [
    '<!-- comment to remove -->',
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">',
    '  <g></g>',
    '  <rect x="8.0000" y="8.0000" width="112.0000" height="112.0000" rx="24" fill="#6366f1"/>',
    '  <circle cx="64" cy="64" r="28" fill="#ffffff"/>',
    '</svg>',
  ].join('\n'), 'utf8');

  const pdfA = path.join(mediaDir, 'doc_a.pdf');
  const pdfB = path.join(mediaDir, 'doc_b.pdf');
  for (const [p, count] of [[pdfA, 1], [pdfB, 2]]) {
    const doc = await PDFDocument.create();
    for (let i = 0; i < count; i++) doc.addPage([400, 300]);
    fs.writeFileSync(p, await doc.save());
  }

  const srtPath = path.join(mediaDir, 'sub.srt');
  fs.writeFileSync(srtPath, [
    '1',
    '00:00:02,000 --> 00:00:04,500',
    'Hello MediaKiln CLI',
    '',
  ].join('\n'), 'utf8');

  const mdPath = path.join(mediaDir, 'note.md');
  fs.writeFileSync(mdPath, [
    '# MediaKiln CLI 排版测试',
    '',
    '这是一份通过命令行离线生成的 **PDF** 测试文档。',
    '',
    '- 支持 Markdown 排版',
    '- 支持无头 PDF 打印',
    '',
    '```js',
    'console.log("hello mediakiln");',
    '```',
  ].join('\n'), 'utf8');

  return { mediaDir, mp4Path, img1, img2, wmImg, svgPath, pdfA, pdfB, srtPath, mdPath };
}

(async () => {
  console.log('=== MediaKiln CLI 端到端测试 ===\n');
  assert(!/^c:/i.test(WORK), `测试目录不应位于 C 盘: ${WORK}`);

  try {
    const fx = await prepareFixtures();

    await step('1. --version / list / info / 别名查找', () => {
      const ver = runCli(['--version', '--json']);
      assert.strictEqual(ver.status, 0, ver.stderr);
      const verJson = JSON.parse(ver.stdout);
      assert.strictEqual(verJson.features, 73);
      assert.strictEqual(verJson.templates, 7);

      const listRes = runCli(['list', '--json']);
      assert.strictEqual(listRes.status, 0, listRes.stderr);
      const listJson = JSON.parse(listRes.stdout);
      assert.strictEqual(listJson.total, 73);

      const infoRes = runCli(['info', 'video-to-gif', '--json']);
      assert.strictEqual(infoRes.status, 0, infoRes.stderr);
      const infoJson = JSON.parse(infoRes.stdout);
      assert.strictEqual(infoJson.featureId, 'videoToGif');
      assert(infoJson.params.some((p) => p.flag === '--fps'));
      assert(infoJson.params.some((p) => p.flag === '--start'));
    });

    await step('2. probe 多类型文件探测（视频/图片/SVG/PDF）', () => {
      const res = runCli(['probe', fx.mp4Path, fx.img1, fx.svgPath, fx.pdfB, '--json']);
      assert.strictEqual(res.status, 0, res.stderr);
      const arr = JSON.parse(res.stdout);
      assert.strictEqual(arr.length, 4);
      assert(arr[0].ok && arr[0].info.width === 320 && arr[0].info.duration > 2);
      assert(arr[1].ok && arr[1].info.width === 160 && arr[1].info.isImage);
      assert(arr[2].ok && arr[2].info.isSvg && arr[2].info.width === 128);
      assert(arr[3].ok && arr[3].info.docType === 'pdf' && arr[3].info.pageCount === 2);
    });

    await step('3. 单工具快捷运行 + 精确输出路径 + 自定义宽度自动展开', async () => {
      const outGif = path.join(WORK, 'custom_out', 'clip.gif');
      const res = runCli([
        'videoToGif', fx.mp4Path,
        '--start', '00:00.5',
        '--duration', '1.2',
        '--fps', '10',
        '--width', '200',
        '--colors', '64',
        '-o', outGif,
        '--json',
      ]);
      assert.strictEqual(res.status, 0, res.stderr || res.stdout);
      const out = JSON.parse(res.stdout);
      assert.strictEqual(out.ok, true);
      assert.strictEqual(path.resolve(out.output), path.resolve(outGif));
      assert(fs.existsSync(outGif) && fs.statSync(outGif).size > 500);
      const info = await probe(outGif);
      assert.strictEqual(info.width, 200);
    });

    await step('4. 负数参数值解析（subtitleConvert --shift-sec -1.5 与 colorStab --brightness -0.1）', () => {
      const outVtt = path.join(WORK, 'shifted.vtt');
      const r1 = runCli([
        'run', 'subtitleConvert', fx.srtPath,
        '--format', 'vtt',
        '--shift-sec', '-1.5',
        '-o', outVtt,
        '--json',
      ]);
      assert.strictEqual(r1.status, 0, r1.stderr || r1.stdout);
      const vttText = fs.readFileSync(outVtt, 'utf8');
      assert(vttText.includes('00:00:00.500 --> 00:00:03.000'), `意外时间轴:\n${vttText}`);

      const outImg = path.join(WORK, 'darker.png');
      const r2 = runCli([
        'run', 'colorStab', fx.img1,
        '--brightness', '-0.1',
        '--contrast', '1.05',
        '-o', outImg,
        '--json',
      ]);
      assert.strictEqual(r2.status, 0, r2.stderr || r2.stdout);
      assert(fs.existsSync(outImg));
    });

    await step('5. 通配符批量并发转换 + --no-overwrite 防覆盖自动编号', () => {
      const batchDir = path.join(WORK, 'batch_webp');
      const globPat = path.join(fx.mediaDir, 'pic_*.png');
      const r1 = runCli([
        'run', 'imageConvert', globPat,
        '--format', 'webp',
        '--quality', 'medium',
        '-o', batchDir,
        '-c', '2',
        '--json',
      ]);
      assert.strictEqual(r1.status, 0, r1.stderr || r1.stdout);
      const j1 = JSON.parse(r1.stdout);
      assert.strictEqual(j1.ok, true);
      assert.strictEqual(j1.total, 2);
      assert.strictEqual(j1.succeeded, 2);
      for (const item of j1.results) assert(fs.existsSync(item.output));

      // 再次执行并开启 --no-overwrite，应自动追加 _1
      const r2 = runCli([
        'run', 'imageConvert', globPat,
        '--format', 'webp',
        '--no-overwrite',
        '-o', batchDir,
        '--json',
      ]);
      assert.strictEqual(r2.status, 0, r2.stderr || r2.stdout);
      const j2 = JSON.parse(r2.stdout);
      assert.strictEqual(j2.succeeded, 2);
      assert(j2.results.every((item) => /_1\.webp$/i.test(item.output)));
    });

    await step('6. 多文件合并（pdfMerge）与像素裁剪（videoCrop）与辅助图片水印（watermark）', async () => {
      const mergedPdf = path.join(WORK, 'merged.pdf');
      const rPdf = runCli(['run', 'pdfMerge', fx.pdfA, fx.pdfB, '-o', mergedPdf, '--json']);
      assert.strictEqual(rPdf.status, 0, rPdf.stderr || rPdf.stdout);
      const pdfInfo = await probe(mergedPdf);
      assert.strictEqual(pdfInfo.pageCount, 3);

      const croppedPng = path.join(WORK, 'cropped.png');
      const rCrop = runCli(['run', 'videoCrop', fx.img1, '--crop', '20,10,80,60', '-o', croppedPng, '--json']);
      assert.strictEqual(rCrop.status, 0, rCrop.stderr || rCrop.stdout);
      const cropInfo = await probe(croppedPng);
      assert.strictEqual(cropInfo.width, 80);
      assert.strictEqual(cropInfo.height, 60);

      const wmOut = path.join(WORK, 'watermarked.png');
      const rWm = runCli([
        'run', 'watermark', fx.img1,
        '--mode', 'image',
        '--image', fx.wmImg,
        '--pos', 'br',
        '-o', wmOut,
        '--json',
      ]);
      assert.strictEqual(rWm.status, 0, rWm.stderr || rWm.stdout);
      assert(fs.existsSync(wmOut) && fs.statSync(wmOut).size > 200);
    });

    await step('7. SVG 渲染与优化（svgToRaster / svgOptimize）+ applyPresets 预设联动（compressGif）', async () => {
      const rasterPng = path.join(WORK, 'logo_256.png');
      const rSvg1 = runCli([
        'run', 'svgToRaster', fx.svgPath,
        '--format', 'png',
        '--scale-mode', 'width',
        '--width', '256',
        '-o', rasterPng,
        '--json',
      ]);
      assert.strictEqual(rSvg1.status, 0, rSvg1.stderr || rSvg1.stdout);
      const rInfo = await probe(rasterPng);
      assert.strictEqual(rInfo.width, 256);

      const optSvg = path.join(WORK, 'logo_opt.svg');
      const rSvg2 = runCli(['run', 'svgOptimize', fx.svgPath, '-o', optSvg, '--json']);
      assert.strictEqual(rSvg2.status, 0, rSvg2.stderr || rSvg2.stdout);
      const optText = fs.readFileSync(optSvg, 'utf8');
      assert(!optText.includes('comment to remove'));

      const srcGif = path.join(WORK, 'custom_out', 'clip.gif');
      const compGif = path.join(WORK, 'sticker.gif');
      const rGif = runCli(['run', 'compressGif', srcGif, '--preset', 'sticker', '-o', compGif, '--json']);
      assert.strictEqual(rGif.status, 0, rGif.stderr || rGif.stdout);
      assert(fs.existsSync(compGif));
    });

    await step('8. 无头 Markdown 排版转 PDF（docToPdf）', async () => {
      const outPdf = path.join(WORK, 'note.pdf');
      const res = runCli([
        'run', 'docToPdf', fx.mdPath,
        '--theme', 'clean',
        '--page-numbers', 'yes',
        '-o', outPdf,
        '--json',
      ]);
      assert.strictEqual(res.status, 0, res.stderr || res.stdout);
      const out = JSON.parse(res.stdout);
      assert.strictEqual(out.ok, true);
      assert(fs.existsSync(outPdf) && fs.statSync(outPdf).size > 1000);
      const pdfInfo = await probe(outPdf);
      assert.strictEqual(pdfInfo.docType, 'pdf');
      assert(pdfInfo.pageCount >= 1);
    });

    await step('9. 工作流命令行：list / info / 内置模板运行 / 自定义 JSON 运行', () => {
      const wl = runCli(['workflow', 'list', '--json']);
      assert.strictEqual(wl.status, 0, wl.stderr);
      assert.strictEqual(JSON.parse(wl.stdout).total, 7);

      const wi = runCli(['wf', 'info', 'tpl_video_to_gif_pro', '--json']);
      assert.strictEqual(wi.status, 0, wi.stderr);
      assert.strictEqual(JSON.parse(wi.stdout).id, 'tpl_video_to_gif_pro');

      const wfOutDir = path.join(WORK, 'wf_tpl_out');
      const wr = runCli([
        'workflow', 'run', 'tpl_video_to_gif_pro',
        '-i', fx.mp4Path,
        '-o', wfOutDir,
        '--param', 'compressGif.colors=64',
        '--json',
      ]);
      assert.strictEqual(wr.status, 0, wr.stderr || wr.stdout);
      const wj = JSON.parse(wr.stdout);
      assert.strictEqual(wj.ok, true);
      assert(wj.outputs.length >= 1 && fs.existsSync(wj.outputs[0]));

      // 自定义导出工作流 JSON
      const customFlowPath = path.join(WORK, 'my_flow.json');
      const customGraph = {
        name: 'CLI 图片转换流水线',
        nodes: [
          { id: 'n1', type: 'io.loadFile', x: 0, y: 0, params: { filePath: '' } },
          { id: 'n2', type: 'feat.imageConvert', x: 200, y: 0, params: { format: 'jpg', quality: 'high' } },
          { id: 'n3', type: 'io.save', x: 400, y: 0, params: { outMode: 'global', suffix: '_cli' } },
        ],
        edges: [
          { id: 'e1', fromNode: 'n1', fromPort: 'out', toNode: 'n2', toPort: 'input' },
          { id: 'e2', fromNode: 'n2', fromPort: 'out', toNode: 'n3', toPort: 'media' },
        ],
      };
      fs.writeFileSync(customFlowPath, JSON.stringify(customGraph, null, 2), 'utf8');
      const customOutDir = path.join(WORK, 'wf_custom_out');
      const wr2 = runCli(['wf', 'run', customFlowPath, '-i', fx.img1, '-o', customOutDir, '--json']);
      assert.strictEqual(wr2.status, 0, wr2.stderr || wr2.stdout);
      const wj2 = JSON.parse(wr2.stdout);
      assert.strictEqual(wj2.ok, true);
      assert(wj2.outputs.length === 1 && /_cli\.jpg$/i.test(wj2.outputs[0]) && fs.existsSync(wj2.outputs[0]));
    });

    await step('10. 参数错误与退出码校验', () => {
      const badTool = runCli(['run', 'notATool', fx.img1]);
      assert.strictEqual(badTool.status, 2);

      const badParam = runCli(['run', 'videoToGif', fx.mp4Path, '--fpx', '15']);
      assert.strictEqual(badParam.status, 2);
      assert(badParam.stderr.includes('--fps'), `应包含参数推荐，实际: ${badParam.stderr}`);

      const badBatchOut = runCli(['run', 'imageConvert', fx.img1, fx.img2, '-o', path.join(WORK, 'single.webp')]);
      assert.strictEqual(badBatchOut.status, 2);
    });

    console.log(`\n结果: ${passed} 项通过, ${failed} 项失败`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    try { fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
})();
