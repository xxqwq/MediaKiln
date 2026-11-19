'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Resvg } = require('@resvg/resvg-js');
const { PDFDocument, degrees } = require('pdf-lib');
const { cancelTask, executeTask } = require('../ffmpeg');

function extractText(file, page) {
  return execFileSync('pdftotext', ['-f', page, '-l', page, '-enc', 'UTF-8', file, '-'], { encoding: 'utf8' }).trim();
}

function render(file, page) {
  return execFileSync('pdftoppm', ['-f', page, '-l', page, '-r', '96', '-singlefile', '-png', file]);
}

function wordPosition(file, page, word) {
  const xml = execFileSync('pdftotext', ['-f', page, '-l', page, '-cropbox', '-bbox', file, '-'], { encoding: 'utf8' });
  const boxes = [...xml.matchAll(/<word xMin="([^"]+)" yMin="([^"]+)" xMax="([^"]+)" yMax="([^"]+)"[^>]*>([^<]*)<\/word>/g)];
  const match = boxes.find((box) => box[5] === word);
  assert(match, `Page ${page} is missing a box for ${word}`);
  return match.slice(1, 5).map(Number);
}

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vgt-searchable-test-'));
  try {
    const original = path.join(directory, 'original.pdf');
    const output = path.join(directory, 'searchable.pdf');
    const scan = new Resvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="340"><rect width="900" height="340" fill="#fff"/><text x="60" y="110" font-family="Microsoft YaHei" font-size="48">本地离线文档识别</text><text x="60" y="210" font-family="Segoe UI" font-size="42">Searchable PDF 2026</text></svg>',
      { font: { loadSystemFonts: true } },
    ).render().asPng();
    const doc = await PDFDocument.create();
    const image = await doc.embedPng(scan);
    doc.addPage([720, 360]).drawText('Native document text', { x: 50, y: 280, size: 24 });
    doc.addPage([720, 360]).drawImage(image, { x: 50, y: 40, width: 620, height: 260 });
    doc.addPage([360, 270]);
    const rotated = doc.addPage([360, 720]);
    rotated.setCropBox(20, 25, 320, 670);
    rotated.setRotation(degrees(90));
    rotated.drawImage(image, { x: 312, y: 50, width: 610, height: 275, rotate: degrees(90) });
    await fs.writeFile(original, await doc.save());
    const originalBytes = await fs.readFile(original);

    const progress = [];
    const result = await executeTask('search-all', 'pdfSearchable', { input: original, output }, (value) => progress.push(value));
    assert.equal(result.output, output);
    assert.deepEqual(result.pdfSearchableSummary, { pageCount: 4, processedPages: 4, ocrPages: 2, textPages: 1, blankPages: 1 });
    assert.equal(progress.at(-1), 1);
    assert(progress.every((value, index) => index === 0 || value >= progress[index - 1] - Number.EPSILON));
    assert.equal(extractText(output, '1'), 'Native document text');
    for (const number of ['2', '4']) {
      assert.equal(extractText(original, number), '');
      const text = extractText(output, number);
      assert.match(text.replace(/\s/g, ''), /本地离线文档/);
      assert.match(text, /Searchable PDF 2026/);
    }
    for (const [page, x, y] of [['2', 92, 205], ['4', 66, 171]]) {
      const [left, top, right, bottom] = wordPosition(output, page, 'Searchable');
      assert(Math.abs(left - x) < 15 && top <= y && bottom >= y, `Page ${page} search text bounds: ${[left, top, right, bottom]}`);
    }
    assert.equal(extractText(output, '3'), '');
    for (const number of ['1', '2', '3', '4']) assert(render(original, number).equals(render(output, number)));
    assert((await fs.readFile(original)).equals(originalBytes));

    const partial = path.join(directory, 'partial.pdf');
    const partialResult = await executeTask('search-partial', 'pdfSearchable', { input: original, output: partial, pageRange: '2' });
    assert.equal(partialResult.pdfSearchableSummary.processedPages, 1);
    assert.match(extractText(partial, '2'), /Searchable PDF 2026/);
    assert.equal(extractText(partial, '4'), '');

    const repeated = path.join(directory, 'repeated.pdf');
    const repeatedResult = await executeTask('search-repeat', 'pdfSearchable', { input: output, output: repeated, pageRange: '1,2,4' });
    assert.equal(repeatedResult.pdfSearchableSummary.ocrPages, 0);
    assert.equal(repeatedResult.pdfSearchableSummary.textPages, 3);
    assert((await fs.readFile(repeated)).equals(await fs.readFile(output)));
    await assert.rejects(executeTask('search-overwrite', 'pdfSearchable', { input: original, output: original }), /与原 PDF 不同/);

    const cancelled = path.join(directory, 'cancelled.pdf');
    await fs.writeFile(cancelled, 'existing file');
    const taskId = 'search-cancellation-check';
    await assert.rejects(executeTask(taskId, 'pdfSearchable', { input: original, output: cancelled }, () => cancelTask(taskId)), /任务已取消/);
    assert.equal(await fs.readFile(cancelled, 'utf8'), 'existing file');
    console.log('PDF OCR: Chinese and English search text, unchanged page rendering, page ranges, repeat use, and cancellation verified');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
