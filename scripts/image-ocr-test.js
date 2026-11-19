'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Resvg } = require('@resvg/resvg-js');
const { FFMPEG, cancelTask, executeTask, probe } = require('../ffmpeg');

function picture(text, background = '#fff') {
  return new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="340"><rect width="900" height="340" fill="${background}"/>${text}</svg>`,
    { font: { loadSystemFonts: true } },
  ).render().asPng();
}

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vgt-image-ocr-test-'));
  try {
    const mixed = path.join(temp, '截图.png');
    const englishPng = path.join(temp, 'english.png');
    const english = path.join(temp, '截图.webp');
    const blank = path.join(temp, '空白.png');
    const outputDir = path.join(temp, '结果');
    await fs.writeFile(mixed, picture('<text x="60" y="105" font-family="Microsoft YaHei" font-size="48">本地离线文档</text><text x="60" y="220" font-family="Segoe UI" font-size="42">OCR TEXT 2026</text>', 'none'));
    await fs.writeFile(englishPng, picture('<text x="60" y="120" font-family="Segoe UI" font-size="48">TEST OCR 2026</text>'));
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', englishPng, '-c:v', 'libwebp', '-lossless', '1', '-frames:v', '1', english], { windowsHide: true });
    await fs.writeFile(blank, picture(''));
    const original = await fs.readFile(mixed);
    const prefs = { __outputMode: 'custom', __outputDir: outputDir, __noOverwrite: true };
    const [a, b] = await Promise.all([
      executeTask('image-ocr-mixed', 'imageOcr', { input: mixed, ...prefs }),
      executeTask('image-ocr-english', 'imageOcr', { input: english, ocrLang: 'en', ...prefs }),
    ]);
    assert.equal(a.imageOcrSummary.lineCount, 2);
    assert.equal(a.imageOcrSummary.text, '本地离线文档\nOCR TEXT 2026');
    assert.equal(b.imageOcrSummary.text, 'TEST OCR 2026');
    assert.notEqual(a.output, b.output);
    for (const result of [a, b]) {
      assert.equal(path.dirname(result.output), outputDir);
      assert.equal(path.extname(result.output), '.txt');
      assert.equal(await fs.readFile(result.output, 'utf8'), `${result.imageOcrSummary.text}\n`);
      assert.equal((await probe(result.output)).docType, 'txt');
    }
    assert.deepEqual(await fs.readFile(mixed), original);

    const existing = path.join(temp, 'existing.txt');
    await fs.writeFile(existing, 'keep me');
    await assert.rejects(executeTask('image-ocr-blank', 'imageOcr', { input: blank, output: existing }), /未识别到文字/);
    const id = 'image-ocr-cancel';
    await assert.rejects(executeTask(id, 'imageOcr', { input: mixed, output: existing }, (value) => {
      if (value >= 0.3) cancelTask(id);
    }), /任务已取消/);
    assert.equal(await fs.readFile(existing, 'utf8'), 'keep me');
    console.log('IMAGE_OCR_OK Chinese and English, concurrent TXT export, blank image and cancellation');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
