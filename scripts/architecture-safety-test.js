'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PDFDocument } = require('pdf-lib');
const { executeTask, cancelTask, hasRunningTasks, FFMPEG } = require('../ffmpeg');
const { createExecutor, defaultOutput, writeTaskOutput } = require('../core/runner');
const cache = require('../core/workflow-cache');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt-safety-'));
  try {
    const parent = path.join(tmp, 'selected-folder');
    fs.mkdirSync(parent);
    const note = path.join(parent, 'note.docx');
    fs.writeFileSync(note, 'user content');
    const root = cache.openCache(parent);
    const unrelated = path.join(root, 'node_unowned');
    fs.mkdirSync(unrelated);
    const first = cache.allocateNodeDir(root, 'same');
    const second = cache.allocateNodeDir(root, 'same');
    assert.notEqual(first, second);
    fs.symlinkSync(parent, path.join(first, 'outside'), 'junction');
    assert.deepEqual(cache.ownedNodeDirs(root).sort(), [first, second].sort());
    assert.equal(cache.removeNodeDir(root, unrelated), false);
    for (const dir of cache.ownedNodeDirs(root)) assert(cache.removeNodeDir(root, dir));
    assert.equal(fs.readFileSync(note, 'utf8'), 'user content');
    assert(fs.existsSync(unrelated));
    const collisionParent = path.join(tmp, 'cache-name-collision');
    fs.mkdirSync(path.join(collisionParent, path.basename(root)), { recursive: true });
    assert.throws(() => cache.openCache(collisionParent), /缓存子目录/);

    const mediaPaths = ['red', 'blue'].map((color) => {
      const name = path.join(tmp, color, 'same.png');
      fs.mkdirSync(path.dirname(name));
      const generated = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', `color=${color}:s=64x64`, '-frames:v', '1', '-update', '1', name], { encoding: 'utf8' });
      assert.equal(generated.status, 0, generated.stderr);
      return name;
    });
    const settings = { __noOverwrite: true, __outputMode: 'custom', __outputDir: path.join(tmp, 'output') };
    const conversions = await Promise.all(mediaPaths.map((input, i) =>
      executeTask(`safety-image-${i}`, 'imageConvert', { ...settings, input, format: 'png' })));
    assert.equal(new Set(conversions.map(({ output }) => output)).size, 2);
    assert.notDeepEqual(...conversions.map(({ output }) => fs.readFileSync(output)));

    let unblock;
    const deferred = new Promise((resolve) => { unblock = resolve; });
    const makeFile = createExecutor({
      testWrite(p) {
        const output = defaultOutput(p.input, 'result', 'txt');
        return { output, async run() { await deferred; writeTaskOutput(output, 'new'); } };
      },
    });
    const competing = makeFile('safety-occupied', 'testWrite', { ...settings, input: note });
    const occupied = path.join(settings.__outputDir, 'note_result.txt');
    fs.writeFileSync(occupied, 'existing');
    unblock();
    await assert.rejects(competing, { code: 'EEXIST' });
    assert.equal(fs.readFileSync(occupied, 'utf8'), 'existing');

    const pdf = await PDFDocument.create();
    pdf.addPage();
    const bytes = await pdf.save();
    const files = ['one.pdf', 'two.pdf'].map((name) => {
      const file = path.join(tmp, name);
      fs.writeFileSync(file, bytes);
      return file;
    });
    const output = path.join(tmp, 'merged.pdf');
    const pending = executeTask('safety-pdf', 'pdfMerge', { files, output });
    assert(hasRunningTasks(), '应跟踪整个 PDF 任务');
    assert(cancelTask('safety-pdf'), '应接受取消');
    assert(hasRunningTasks(), '应在取消清理完成前保持忙碌');
    await assert.rejects(pending, /任务已取消/);
    assert.equal(hasRunningTasks(), false);
    assert.equal(fs.existsSync(output), false);

    const successful = await executeTask('safety-pdf-retry', 'pdfMerge', { files, output }, (ratio) => {
      if (ratio === 1) assert.equal(cancelTask('safety-pdf-retry'), false, '已经写出的结果不可取消');
    });
    assert.equal(successful.pdfSummary.pageCount, 2);
    console.log('ARCHITECTURE_SAFETY_OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
