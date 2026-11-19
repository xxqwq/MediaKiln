'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const iconv = (() => {
  try { return require('iconv-lite'); } catch { return null; }
})();
const { executeTask, cancelTask, probe } = require('../ffmpeg');

// 构造合法 GBK / GB18030 编码测试字节（“你好字幕” + SRT 时间轴）
function makeGbkSrtBuffer() {
  // “你好字幕”在 GBK 中的编码: C4 E3 BA C3 D7 D6 C4 BB
  const prefix = Buffer.from('1\r\n00:00:01,000 --> 00:00:03,500\r\n', 'ascii');
  const zh = iconv ? iconv.encode('你好字幕', 'gbk') : Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xd7, 0xd6, 0xc4, 0xbb]);
  const suffix = Buffer.from('\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\nSecond line\r\n', 'ascii');
  return Buffer.concat([prefix, zh, suffix]);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt-subtitle-test-'));
  try {
    const srtPath = path.join(dir, 'sample.srt');
    const vttPath = path.join(dir, 'sample.vtt');
    const assPath = path.join(dir, 'sample.ass');
    const gbkPath = path.join(dir, 'gbk.srt');
    const badPath = path.join(dir, 'broken.srt');

    fs.writeFileSync(srtPath, [
      '1',
      '00:00:01,000 --> 00:00:02,500',
      '<i>第一句</i> {\\an8}带标签',
      '',
      '2',
      '00:00:03,000 --> 00:00:05,250',
      '第二句保留 a < b 符号',
      '',
    ].join('\n'), 'utf8');

    fs.writeFileSync(vttPath, [
      'WEBVTT',
      '',
      'NOTE 注释块应忽略',
      '00:00:01.000 --> 00:00:02.000',
      '不能被当作台词',
      '',
      'STYLE',
      '::cue { color: yellow; }',
      '',
      '00:10.500 --> 00:13.000 align:start position:10%',
      '<c.cyan>短时间戳 VTT</c>',
      '',
    ].join('\n'), 'utf8');

    fs.writeFileSync(assPath, [
      '[Script Info]',
      'Title: Test ASS',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:05.00,0:00:08.50,Default,,0,0,0,,{\\pos(100,200)}第二条后排时间\\N含逗号, 测试',
      'Dialogue: 0,0:00:01.20,0:00:03.40,Default,,0,0,0,,第一条提前出现',
      '',
    ].join('\n'), 'utf8');

    fs.writeFileSync(gbkPath, makeGbkSrtBuffer());
    fs.writeFileSync(badPath, '这里面没有任何有效的时间轴\n只有普通文字', 'utf8');

    // 1. probe() 离线探针识别字幕类型与条数
    const probedAss = await probe(assPath);
    assert.equal(probedAss.isDoc, true);
    assert.equal(probedAss.docType, 'subtitle');
    assert.equal(probedAss.subFormat, 'ass');
    assert.equal(probedAss.cueCount, 2);

    const probedGbk = await probe(gbkPath);
    assert.equal(probedGbk.cueCount, 2);

    // 2. SRT -> VTT + 正向偏移 + 清理标签（保留数学 < 符号）
    const outVtt = path.join(dir, 'out.vtt');
    const r1 = await executeTask('sub-srt-vtt', 'subtitleConvert', {
      input: srtPath, format: 'vtt', shiftSec: 1.5, stripTags: 'yes', output: outVtt,
    });
    assert.equal(r1.subtitleConvertSummary.cueCount, 2);
    const vttText = fs.readFileSync(outVtt, 'utf8');
    assert(vttText.startsWith('WEBVTT'));
    assert(vttText.includes('00:00:02.500 --> 00:00:04.000'));
    assert(vttText.includes('第一句 带标签'));
    assert(vttText.includes('第二句保留 a < b 符号'));

    // 3. ASS -> SRT（按时间重排、保留逗号与换行、清理特效标签）
    const outAssSrt = path.join(dir, 'from_ass.srt');
    const r2 = await executeTask('sub-ass-srt', 'subtitleConvert', {
      input: assPath, format: 'srt', shiftSec: 0, stripTags: 'yes', output: outAssSrt,
    });
    assert.equal(r2.subtitleConvertSummary.cueCount, 2);
    const assSrt = fs.readFileSync(outAssSrt, 'utf8');
    const idxFirst = assSrt.indexOf('第一条提前出现');
    const idxSecond = assSrt.indexOf('含逗号, 测试');
    assert(idxFirst > 0 && idxSecond > idxFirst, 'ASS 转换应按开始时间排序且保留逗号');
    assert(assSrt.includes('第二条后排时间\r\n含逗号, 测试'));

    // 4. VTT -> SRT（忽略 NOTE / STYLE，支持 MM:SS.mmm）
    const outVttSrt = path.join(dir, 'from_vtt.srt');
    const r3 = await executeTask('sub-vtt-srt', 'subtitleConvert', {
      input: vttPath, format: 'srt', shiftSec: -11, stripTags: 'yes', output: outVttSrt,
    });
    assert.equal(r3.subtitleConvertSummary.cueCount, 1);
    const vttSrt = fs.readFileSync(outVttSrt, 'utf8');
    assert(vttSrt.includes('00:00:00,000 --> 00:00:02,000'), '负偏移截断起点应钳制为 0');
    assert(!vttSrt.includes('不能被当作台词'));

    // 5. GBK 编码字幕自动转 UTF-8 + TXT 台词导出（带与不带时间戳）
    const outTxt = path.join(dir, 'gbk_lines.txt');
    const r4 = await executeTask('sub-gbk-txt', 'subtitleConvert', {
      input: gbkPath, format: 'txt', shiftSec: 0, stripTags: 'yes', txtTimestamps: 'yes', output: outTxt,
    });
    assert.equal(r4.subtitleConvertSummary.encoding, 'gb18030');
    const txtContent = fs.readFileSync(outTxt, 'utf8');
    assert(txtContent.includes('[00:00:01] 你好字幕'));

    // 6. 偏移后全丢弃拦截、无效文件拦截、防同路径覆盖与取消
    await assert.rejects(executeTask('sub-same', 'subtitleConvert', { input: srtPath, output: srtPath }), /不同的输出位置/);
    await assert.rejects(executeTask('sub-bad', 'subtitleConvert', { input: badPath, output: path.join(dir, 'bad.srt') }), /未识别到有效字幕/);
    await assert.rejects(executeTask('sub-drop-all', 'subtitleConvert', { input: srtPath, shiftSec: -20, output: path.join(dir, 'empty.srt') }), /没有剩余有效字幕/);

    const cancelOut = path.join(dir, 'cancel.srt');
    const cancelId = 'sub-cancel-test';
    const pending = executeTask(cancelId, 'subtitleConvert', {
      input: srtPath, format: 'vtt', output: cancelOut,
    }, (ratio) => {
      if (ratio > 0 && ratio < 1) cancelTask(cancelId);
    });
    await assert.rejects(pending, /任务已取消/);
    assert.equal(fs.existsSync(cancelOut), false);

    console.log('SUBTITLE_TEST_OK');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
