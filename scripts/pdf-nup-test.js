'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument, degrees, rgb } = require('pdf-lib');
const { executeTask, cancelTask, ensureBinaries } = require('../ffmpeg');
const { runFfmpegBinary } = require('../core/runner');
const { renderPdfPagesToPngs } = require('../core/pdf-engine');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function readPngRgba(pngPath, taskId) {
  const buf = await fs.readFile(pngPath);
  assert(buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIGNATURE), 'PNG 文件头无效');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const pixels = await runFfmpegBinary(taskId, [
    '-loglevel', 'error', '-i', pngPath,
    '-frames:v', '1', '-pix_fmt', 'rgba', '-c:v', 'rawvideo', '-threads', '1', '-f', 'rawvideo', 'pipe:1',
  ]);
  assert.equal(pixels.length, width * height * 4);
  return {
    width,
    height,
    at(fx, fy) {
      const px = Math.max(0, Math.min(width - 1, Math.round(fx * (width - 1))));
      const py = Math.max(0, Math.min(height - 1, Math.round(fy * (height - 1))));
      const idx = (py * width + px) * 4;
      return [pixels[idx], pixels[idx + 1], pixels[idx + 2], pixels[idx + 3]];
    },
  };
}

function assertSizeClose(actual, expected, msg) {
  assert(Math.abs(actual - expected) < 0.5, `${msg}: ${actual} vs ${expected}`);
}

async function main() {
  await ensureBinaries();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vgt-pdf-nup-test-'));
  try {
    const srcPortrait = path.join(dir, 'portrait.pdf');
    const srcLandscape = path.join(dir, 'landscape.pdf');
    const docP = await PDFDocument.create();

    const crop = { x: 20, y: 30, width: 260, height: 360 };
    const pageSpecs = [
      { angle: 0, base: rgb(0.86, 0.16, 0.16), mark: rgb(0.12, 0.12, 0.12) },
      { angle: 90, base: rgb(0.16, 0.72, 0.24), mark: rgb(0.12, 0.12, 0.12) },
      { angle: 180, base: rgb(0.16, 0.32, 0.86), mark: rgb(0.12, 0.12, 0.12) },
      { angle: 270, base: rgb(0.92, 0.75, 0.12), mark: rgb(0.12, 0.12, 0.12) },
    ];
    for (let i = 0; i < pageSpecs.length; i++) {
      const spec = pageSpecs[i];
      const page = docP.addPage([320, 440]);
      page.setMediaBox(-10, -18, 340, 480);
      page.setCropBox(crop.x, crop.y, crop.width, crop.height);
      page.setRotation(degrees(spec.angle));
      page.drawRectangle({ ...crop, color: spec.base });
      // 在未旋转 CropBox 底部画深色标识块，用于校验 0/90/180/270 方向正确映射
      page.drawRectangle({ x: crop.x, y: crop.y, width: crop.width, height: 110, color: spec.mark });
      page.drawText(`Page ${i + 1}`, { x: 100, y: 260, size: 18, color: rgb(1, 1, 1) });
    }
    docP.addPage([320, 440]); // 第 5 页空白页
    await fs.writeFile(srcPortrait, await docP.save());

    const docL = await PDFDocument.create();
    for (let i = 0; i < 2; i++) {
      const p = docL.addPage([800, 450]);
      p.drawRectangle({ x: 0, y: 0, width: 800, height: 450, color: rgb(0.2, 0.45, 0.8) });
      p.drawText(`Slide ${i + 1}`, { x: 60, y: 220, size: 28, color: rgb(1, 1, 1) });
    }
    await fs.writeFile(srcLandscape, await docL.save());

    // 1. 4 合 1 (auto -> A4 竖向), 5 页输出 2 页
    const out4 = path.join(dir, 'out4.pdf');
    const res4 = await executeTask('nup-4', 'pdfNup', {
      input: srcPortrait, layout: '4', orientation: 'auto', margin: '24', border: 'yes', order: 'row', output: out4,
    });
    assert.equal(res4.pdfSummary.pageCount, 2);
    assert.equal(res4.pdfSummary.selectedPages, 5);
    assert.equal(res4.pdfSummary.perSheet, 4);

    const loaded4 = await PDFDocument.load(await fs.readFile(out4));
    assert.equal(loaded4.getPageCount(), 2);
    assertSizeClose(loaded4.getPage(0).getWidth(), 595.28, '4-up A4 竖向宽度');
    assertSizeClose(loaded4.getPage(0).getHeight(), 841.89, '4-up A4 竖向高度');

    // 渲染第 1 页并采样四个象限的颜色与旋转标识方向
    const pngs = await renderPdfPagesToPngs(out4, dir, { pages: [1], scale: 1.5 });
    const img = await readPngRgba(pngs[0], 'nup-pixel-check');
    // 左上象限 (rot=0): 上半为红，下半为深色标记
    const q1Top = img.at(0.26, 0.16);
    const q1Bot = img.at(0.26, 0.40);
    assert(q1Top[0] > 180 && q1Top[1] < 80, `左上象限应为红色: ${q1Top}`);
    assert(q1Bot[0] < 60 && q1Bot[1] < 60 && q1Bot[2] < 60, `左上象限下方应为深色标记: ${q1Bot}`);

    // 右上象限 (rot=90 顺时针): 左侧为深色标记，右侧为绿
    const q2Left = img.at(0.57, 0.26);
    const q2Right = img.at(0.86, 0.26);
    assert(q2Left[0] < 60 && q2Left[1] < 60 && q2Left[2] < 60, `右上象限左侧应为深色标记: ${q2Left}`);
    assert(q2Right[1] > 140 && q2Right[0] < 80, `右上象限右侧应为绿色: ${q2Right}`);

    // 左下象限 (rot=180): 上半为深色标记，下半为蓝
    const q3Top = img.at(0.26, 0.60);
    const q3Bot = img.at(0.26, 0.84);
    assert(q3Top[0] < 60 && q3Top[1] < 60 && q3Top[2] < 60, `左下象限上方应为深色标记: ${q3Top}`);
    assert(q3Bot[2] > 180 && q3Bot[0] < 80, `左下象限下方应为蓝色: ${q3Bot}`);

    // 右下象限 (rot=270 顺时针): 左侧为黄，右侧为深色标记
    const q4Left = img.at(0.62, 0.74);
    const q4Right = img.at(0.89, 0.74);
    assert(q4Left[0] > 190 && q4Left[1] > 150 && q4Left[2] < 80, `右下象限左侧应为黄色: ${q4Left}`);
    assert(q4Right[0] < 60 && q4Right[1] < 60 && q4Right[2] < 60, `右下象限右侧应为深色标记: ${q4Right}`);

    // 2. 2 合 1 智能方向切换：竖版源 -> A4 横向；横版源 -> A4 竖向
    const out2p = path.join(dir, 'out2_from_p.pdf');
    await executeTask('nup-2p', 'pdfNup', {
      input: srcPortrait, layout: '2', orientation: 'auto', output: out2p,
    });
    const d2p = await PDFDocument.load(await fs.readFile(out2p));
    assert.equal(d2p.getPageCount(), 3);
    assertSizeClose(d2p.getPage(0).getWidth(), 841.89, '竖版 2合1 应为 A4 横向');

    const out2l = path.join(dir, 'out2_from_l.pdf');
    await executeTask('nup-2l', 'pdfNup', {
      input: srcLandscape, layout: '2', orientation: 'auto', output: out2l,
    });
    const d2l = await PDFDocument.load(await fs.readFile(out2l));
    assert.equal(d2l.getPageCount(), 1);
    assertSizeClose(d2l.getPage(0).getWidth(), 595.28, '横版 2合1 应为 A4 竖向');

    // 3. 6合1、9合1、列优先与页码范围筛选
    const out6 = path.join(dir, 'out6.pdf');
    const res6 = await executeTask('nup-6', 'pdfNup', {
      input: srcPortrait, layout: '6', orientation: 'a4l', margin: '12', border: 'no', order: 'col', pageRange: '1-4', output: out6,
    });
    assert.equal(res6.pdfSummary.pageCount, 1);
    assert.equal(res6.pdfSummary.selectedPages, 4);

    const out9 = path.join(dir, 'out9.pdf');
    const res9 = await executeTask('nup-9', 'pdfNup', {
      input: srcPortrait, layout: '9', orientation: 'a4p', output: out9,
    });
    assert.equal(res9.pdfSummary.pageCount, 1);

    // 4. 异常拦截与取消安全检查
    await assert.rejects(executeTask('nup-same', 'pdfNup', { input: srcPortrait, output: srcPortrait }), /不同的输出位置/);
    await assert.rejects(executeTask('nup-bad-range', 'pdfNup', { input: srcPortrait, pageRange: '99', output: path.join(dir, 'bad1.pdf') }), /超出总页数/);
    await assert.rejects(executeTask('nup-bad-margin', 'pdfNup', { input: srcPortrait, margin: -2, output: path.join(dir, 'bad2.pdf') }), /非负数/);

    const cancelledOut = path.join(dir, 'cancelled.pdf');
    const cancelId = 'nup-cancel-test';
    const pending = executeTask(cancelId, 'pdfNup', {
      input: srcPortrait, layout: '4', output: cancelledOut,
    }, (progress) => {
      if (progress > 0 && progress < 1) cancelTask(cancelId);
    });
    await assert.rejects(pending, /任务已取消/);
    await assert.rejects(fs.access(cancelledOut), { code: 'ENOENT' });

    console.log('PDF_NUP_TEST_OK');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
