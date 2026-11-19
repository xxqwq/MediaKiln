'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PDFDocument, PDFRawStream, decodePDFRawStream } = require('pdf-lib');
const { executeTask, cancelTask, FFMPEG } = require('../ffmpeg');

async function readPageOperators(file, index) {
  const doc = await PDFDocument.load(fs.readFileSync(file));
  const streams = doc.getPage(index).node.Contents();
  return Array.from({ length: streams.size() }, (_, i) => {
    const stream = streams.lookup(i, PDFRawStream);
    return Buffer.from(decodePDFRawStream(stream).decode());
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt-pdf-target-'));
  try {
    const image = path.join(tmp, 'picture.jpg');
    const fixture = spawnSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'mandelbrot=size=2400x1600:rate=1', '-frames:v', '1', '-q:v', '1', image,
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(fixture.status, 0, fixture.stderr);

    const doc = await PDFDocument.create();
    const firstPage = doc.addPage();
    firstPage.drawText('This text remains selectable.', { x: 25, y: 750, size: 14 });
    const embedded = await doc.embedJpg(fs.readFileSync(image));
    firstPage.drawImage(embedded, { x: 25, y: 180, width: 540, height: 360 });
    doc.addPage().drawText('Page two remains present.');
    const original = Buffer.from(await doc.save());
    const input = path.join(tmp, 'input.pdf');
    fs.writeFileSync(input, original);
    const run = (name, options, onProgress) => executeTask(`pdf-target-${name}`, 'pdfCompress', {
      input, output: path.join(tmp, `${name}.pdf`), ...options,
    }, onProgress);

    const copy = await run('already-small', { targetBytes: original.length });
    assert.equal(copy.pdfCompressSummary.targetReached, true);
    assert.equal(copy.pdfCompressSummary.compressedImages, 0);
    assert.deepEqual(fs.readFileSync(copy.output), original);

    const preset = await run('preset', { preset: 'balanced' });
    assert.equal(preset.pdfCompressSummary.targetReached, undefined);
    assert(preset.pdfCompressSummary.newSize < original.length);
    const targetBytes = Math.floor(preset.pdfCompressSummary.newSize / 2);
    const target = await run('target', { targetBytes });
    assert.equal(target.pdfCompressSummary.targetBytes, targetBytes);
    assert.equal(target.pdfCompressSummary.targetReached, true);
    assert.equal(target.pdfCompressSummary.compressedImages, 1);
    assert.equal(target.pdfCompressSummary.pageCount, 2);
    assert.equal(fs.statSync(target.output).size, target.pdfCompressSummary.newSize);
    assert(fs.statSync(target.output).size <= targetBytes);
    assert.deepEqual(await readPageOperators(target.output, 0), await readPageOperators(input, 0));
    assert.deepEqual(await readPageOperators(target.output, 1), await readPageOperators(input, 1));

    const oversized = await run('above-limit', { targetBytes: 32 });
    assert.equal(oversized.pdfCompressSummary.targetReached, false);
    assert(oversized.pdfCompressSummary.newSize <= target.pdfCompressSummary.newSize);

    await assert.rejects(run('invalid', { targetBytes: 0 }), /目标大小/);
    assert(!fs.existsSync(path.join(tmp, 'invalid.pdf')));
    await assert.rejects(run('same-path', { targetBytes, output: input }), /不能覆盖输入 PDF/);
    assert.deepEqual(fs.readFileSync(input), original);

    const existing = path.join(tmp, 'cancelled.pdf');
    fs.writeFileSync(existing, 'existing output');
    await assert.rejects(run('cancelled', { targetBytes: 32 }, (ratio) => {
      if (ratio > 0.1 && ratio < 1) assert(cancelTask('pdf-target-cancelled'));
    }), /任务已取消/);
    assert.equal(fs.readFileSync(existing, 'utf8'), 'existing output');

    console.log(`PDF_TARGET_SIZE_OK ${original.length} → ${target.pdfCompressSummary.newSize} bytes (limit ${targetBytes})`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
