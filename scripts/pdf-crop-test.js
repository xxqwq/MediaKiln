'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument, degrees, rgb } = require('pdf-lib');
const { cropPdfMargins, previewPdfCrop } = require('../core/pdf-crop');
const { cancelTask, ensureBinaries } = require('../core/runner');

const crop = { x: 20, y: 30, width: 260, height: 360 };
const ink = { x: 90, y: 155, width: 110, height: 70 };
const padding = 12;

function dimensionsClose(actual, expected) {
  for (const key of ['x', 'y', 'width', 'height']) {
    assert(Math.abs(actual[key] - expected[key]) < 3, `${key}: ${actual[key]} vs ${expected[key]}`);
  }
}

async function main() {
  await ensureBinaries();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vgt-pdf-crop-test-'));
  try {
    const input = path.join(dir, 'input.pdf');
    const cropped = path.join(dir, 'cropped.pdf');
    const unchanged = path.join(dir, 'unchanged.pdf');
    const cancelled = path.join(dir, 'cancelled.pdf');
    const doc = await PDFDocument.create();
    for (const angle of [0, 90, 180, 270]) {
      const page = doc.addPage([320, 440]);
      page.setMediaBox(-10, -18, 340, 480);
      page.setCropBox(crop.x, crop.y, crop.width, crop.height);
      page.setRotation(degrees(angle));
      page.drawRectangle({ ...ink, color: rgb(0.1, 0.2, 0.7) });
      page.drawText('Vector text', { x: 100, y: 180, size: 12, color: rgb(1, 1, 1) });
    }
    doc.addPage([320, 440]);
    doc.addPage([320, 440]).drawRectangle({ x: 0, y: 0, width: 320, height: 440, color: rgb(0.95, 0.95, 0.95) });
    const source = await doc.save();
    await fs.writeFile(input, source);

    const preview = await previewPdfCrop(input, { page: 2, padding });
    assert(preview.image.subarray(1, 4).equals(Buffer.from('PNG')));
    assert(preview.bounds && preview.bounds.top > 0 && preview.bounds.right < 1);
    const tighterPreview = await previewPdfCrop(input, { page: 2, padding: 0 });
    assert(tighterPreview.bounds.left > preview.bounds.left && tighterPreview.bounds.top > preview.bounds.top);
    const blankPreview = await previewPdfCrop(input, { page: 5 });
    assert.equal(blankPreview.bounds, null);

    const result = await cropPdfMargins(input, cropped, { pageRange: '4,2,1,3,5,6', padding });
    assert.deepEqual(result, { output: cropped, pageCount: 6, processedPages: 6, croppedPages: 4 });
    const saved = await PDFDocument.load(await fs.readFile(cropped));
    for (const [index, angle] of [0, 90, 180, 270].entries()) {
      const page = saved.getPage(index);
      assert.equal(page.getRotation().angle, angle);
      dimensionsClose(page.getCropBox(), {
        x: ink.x - padding, y: ink.y - padding,
        width: ink.width + padding * 2, height: ink.height + padding * 2,
      });
      const originalPage = doc.getPage(index);
      assert.deepEqual(page.getMediaBox(), originalPage.getMediaBox());
      const originalStream = originalPage.node.Contents().lookup(0).getContents();
      const savedStream = page.node.Contents().lookup(0).getContents();
      assert(Buffer.from(savedStream).equals(Buffer.from(originalStream)), '页面内容流应保留原有矢量与文字');
    }
    const rotatedBox = saved.getPage(1).getCropBox();
    assert(Math.abs((rotatedBox.x - crop.x) / crop.width - preview.bounds.top) < 1e-8);
    assert(Math.abs((rotatedBox.y - crop.y) / crop.height - preview.bounds.left) < 1e-8);
    assert.deepEqual(saved.getPage(4).getCropBox(), doc.getPage(4).getCropBox());
    assert.deepEqual(saved.getPage(5).getCropBox(), doc.getPage(5).getCropBox());

    const noChange = await cropPdfMargins(input, unchanged, { pageRange: '5-6', padding });
    assert.equal(noChange.croppedPages, 0);
    assert.deepEqual(await fs.readFile(unchanged), Buffer.from(source));
    await assert.rejects(cropPdfMargins(input, input), /不同的输出位置/);
    await assert.rejects(previewPdfCrop(input, { page: 7 }), /页码/);
    await assert.rejects(previewPdfCrop(input, { padding: -1 }), /非负数/);

    const taskId = 'pdf-crop-cancellation-test';
    await assert.rejects(cropPdfMargins(input, cancelled, {
      taskId, pageRange: '1', onProgress(progress) {
        if (progress > 0.9) assert(cancelTask(taskId));
      },
    }), /任务已取消/);
    await assert.rejects(fs.access(cancelled), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(input), Buffer.from(source));
    console.log('PDF 裁白边检查通过（旋转页和已有裁剪框、预览、正文内容、空白页及取消）。');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
