'use strict';

const fs = require('fs/promises');
const path = require('path');
const { registerCancelableTask, throwIfTaskCancelled, writeTaskOutput } = require('./runner');

const VALID_SUB_EXTS = new Set(['srt', 'vtt', 'ass', 'ssa']);

function decodeSubtitleBuffer(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new Error('字幕文件内容无效');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8-bom' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('gb18030').decode(buf), encoding: 'gb18030' };
  }
}

function normalizeNewlines(text) {
  return String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function parseSrtOrVttTimestamp(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const hours = m[1] !== undefined ? Number(m[1]) : 0;
  const mins = Number(m[2]);
  const secs = Number(m[3]);
  if (mins >= 60 || secs >= 60) return null;
  const ms = Number((m[4] || '0').padEnd(3, '0'));
  return ((hours * 3600 + mins * 60 + secs) * 1000) + ms;
}

function parseAssTimestamp(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{1,3}):(\d{2}):(\d{2})[.:](\d{1,2})$/);
  if (!m) return null;
  const hours = Number(m[1]);
  const mins = Number(m[2]);
  const secs = Number(m[3]);
  if (mins >= 60 || secs >= 60) return null;
  const cs = Number(m[4].padEnd(2, '0'));
  return ((hours * 3600 + mins * 60 + secs) * 1000) + cs * 10;
}

function parseCueTimelineLine(line) {
  const m = String(line || '').match(/^(.+?)\s*-->\s*(.+)$/);
  if (!m) return null;
  const startRaw = m[1].trim().split(/\s+/)[0];
  const endRaw = m[2].trim().split(/\s+/)[0];
  const startMs = parseSrtOrVttTimestamp(startRaw);
  const endMs = parseSrtOrVttTimestamp(endRaw);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return { startMs, endMs };
}

function parseSrt(text) {
  const blocks = normalizeNewlines(text).split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const arrowIdx = lines.findIndex((l) => l.includes('-->'));
    if (arrowIdx < 0) continue;
    const timing = parseCueTimelineLine(lines[arrowIdx]);
    if (!timing) continue;
    const body = lines.slice(arrowIdx + 1).join('\n').trim();
    if (!body) continue;
    cues.push({ startMs: timing.startMs, endMs: timing.endMs, text: body });
  }
  return cues;
}

function parseVtt(text) {
  const blocks = normalizeNewlines(text).split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const first = (lines[0] || '').trim();
    if (!first || /^WEBVTT\b/i.test(first) || /^(?:NOTE|STYLE|REGION)(?:\s|$)/i.test(first)) {
      continue;
    }
    const arrowIdx = lines.findIndex((l) => l.includes('-->'));
    if (arrowIdx < 0) continue;
    const timing = parseCueTimelineLine(lines[arrowIdx]);
    if (!timing) continue;
    const body = lines.slice(arrowIdx + 1).join('\n').trim();
    if (!body) continue;
    cues.push({ startMs: timing.startMs, endMs: timing.endMs, text: body });
  }
  return cues;
}

function parseAss(text) {
  const lines = normalizeNewlines(text).split('\n');
  let inEvents = false;
  let startIdx = 1;
  let endIdx = 2;
  let textIdx = 9;
  const cues = [];
  let seq = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';')) continue;
    const secMatch = line.match(/^\[([^\]]+)\]$/);
    if (secMatch) {
      inEvents = secMatch[1].trim().toLowerCase() === 'events';
      continue;
    }
    if (!inEvents && !/^Dialogue\s*:/i.test(line)) continue;

    if (/^Format\s*:/i.test(line)) {
      const cols = line.replace(/^Format\s*:/i, '').split(',').map((c) => c.trim().toLowerCase());
      const s = cols.indexOf('start');
      const e = cols.indexOf('end');
      const t = cols.indexOf('text');
      if (s >= 0 && e >= 0 && t > Math.max(s, e)) {
        startIdx = s;
        endIdx = e;
        textIdx = t;
      }
      continue;
    }

    if (/^Dialogue\s*:/i.test(line)) {
      const body = line.replace(/^Dialogue\s*:\s*/i, '');
      const parts = [];
      let rest = body;
      let ok = true;
      for (let i = 0; i < textIdx; i++) {
        const comma = rest.indexOf(',');
        if (comma < 0) {
          ok = false;
          break;
        }
        parts.push(rest.slice(0, comma));
        rest = rest.slice(comma + 1);
      }
      if (!ok) continue;
      parts.push(rest);

      const startMs = parseAssTimestamp(parts[startIdx]);
      const endMs = parseAssTimestamp(parts[endIdx]);
      if (startMs === null || endMs === null || endMs <= startMs) continue;

      const rawText = parts[textIdx]
        .replace(/\\N/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\\h/g, ' ')
        .trim();
      if (!rawText) continue;
      cues.push({ startMs, endMs, text: rawText, _seq: seq++ });
    }
  }

  cues.sort((a, b) => (a.startMs - b.startMs) || (a.endMs - b.endMs) || (a._seq - b._seq));
  return cues.map(({ startMs, endMs, text: cueText }) => ({ startMs, endMs, text: cueText }));
}

function parseSubtitle(text, ext = '') {
  const norm = normalizeNewlines(text);
  const cleanExt = String(ext || '').replace(/^\./, '').toLowerCase();

  let primary;
  if (/^\s*WEBVTT\b/i.test(norm) || (cleanExt === 'vtt' && !/\[Events\]/i.test(norm))) {
    primary = 'vtt';
  } else if (cleanExt === 'ass' || cleanExt === 'ssa' || /^\s*\[Events\]/im.test(norm) || /^\s*Dialogue\s*:/im.test(norm)) {
    primary = 'ass';
  } else {
    primary = 'srt';
  }

  const runners = { srt: parseSrt, vtt: parseVtt, ass: parseAss };
  const order = [primary, 'srt', 'vtt', 'ass'].filter((k, i, arr) => arr.indexOf(k) === i);
  for (const kind of order) {
    const parsed = runners[kind](norm);
    if (parsed.length) return { cues: parsed, format: kind };
  }
  return { cues: [], format: primary };
}

function cleanSubtitleText(text) {
  const stripped = String(text || '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/<\/?(?:[a-zA-Z][a-zA-Z0-9.:-]*)(?:\s[^>]*)?>/g, '');
  return stripped
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function pad2(n) {
  return String(Math.floor(n)).padStart(2, '0');
}

function pad3(n) {
  return String(Math.floor(n)).padStart(3, '0');
}

function splitMs(ms) {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3600000);
  const mins = Math.floor((clamped % 3600000) / 60000);
  const secs = Math.floor((clamped % 60000) / 1000);
  const millis = clamped % 1000;
  return { hours, mins, secs, millis };
}

function formatSrtTimestamp(ms) {
  const { hours, mins, secs, millis } = splitMs(ms);
  return `${pad2(hours)}:${pad2(mins)}:${pad2(secs)},${pad3(millis)}`;
}

function formatVttTimestamp(ms) {
  const { hours, mins, secs, millis } = splitMs(ms);
  return `${pad2(hours)}:${pad2(mins)}:${pad2(secs)}.${pad3(millis)}`;
}

function formatShortTimestamp(ms) {
  const { hours, mins, secs } = splitMs(ms);
  return `${pad2(hours)}:${pad2(mins)}:${pad2(secs)}`;
}

function formatSrt(cues) {
  return cues
    .map((c, idx) => `${idx + 1}\r\n${formatSrtTimestamp(c.startMs)} --> ${formatSrtTimestamp(c.endMs)}\r\n${c.text.replace(/\n/g, '\r\n')}`)
    .join('\r\n\r\n') + '\r\n';
}

function formatVtt(cues) {
  return 'WEBVTT\r\n\r\n' + cues
    .map((c) => `${formatVttTimestamp(c.startMs)} --> ${formatVttTimestamp(c.endMs)}\r\n${c.text.replace(/\n/g, '\r\n')}`)
    .join('\r\n\r\n') + '\r\n';
}

function formatTxt(cues, { timestamps = false } = {}) {
  return cues
    .map((c) => (timestamps
      ? `[${formatShortTimestamp(c.startMs)}] ${c.text.replace(/\s*\n\s*/g, ' ')}`
      : c.text.replace(/\n/g, '\r\n')))
    .join('\r\n') + '\r\n';
}

async function inspectSubtitle(filePath) {
  const ext = path.extname(String(filePath || '')).slice(1).toLowerCase();
  const buf = await fs.readFile(filePath);
  const { text, encoding } = decodeSubtitleBuffer(buf);
  const parsed = parseSubtitle(text, ext);
  return {
    cueCount: parsed.cues.length,
    subFormat: ext || parsed.format,
    encoding,
  };
}

async function convertSubtitleFile(inputPath, outputPath, opts = {}) {
  const ext = path.extname(String(inputPath || '')).slice(1).toLowerCase();
  if (!VALID_SUB_EXTS.has(ext)) {
    throw new Error('请选择字幕文件 (.srt / .vtt / .ass / .ssa)');
  }

  const input = await fs.realpath(inputPath);
  const output = await fs.realpath(outputPath).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
    return path.resolve(outputPath);
  });
  const pathKey = (file) => (process.platform === 'win32' ? file.toLowerCase() : file);
  if (pathKey(input) === pathKey(output)) {
    throw new Error('请选择与原文件不同的输出位置');
  }

  const targetFormat = ['srt', 'vtt', 'txt'].includes(opts.format) ? opts.format : 'srt';
  const shiftSec = opts.shiftSec === undefined || opts.shiftSec === '' ? 0 : Number(opts.shiftSec);
  if (!Number.isFinite(shiftSec) || shiftSec < -86400 || shiftSec > 86400) {
    throw new Error('时间轴偏移必须在 -86400 到 86400 秒之间');
  }
  const stripTags = opts.stripTags !== 'no' && opts.stripTags !== false;
  const txtTimestamps = opts.txtTimestamps === 'yes' || opts.txtTimestamps === true;
  const taskId = opts.taskId;
  const onProgress = opts.onProgress || null;

  const release = registerCancelableTask(taskId, () => {});
  try {
    throwIfTaskCancelled(taskId);
    onProgress?.(0.1);

    const rawBuf = await fs.readFile(input);
    throwIfTaskCancelled(taskId);
    const { text, encoding } = decodeSubtitleBuffer(rawBuf);
    const { cues, format: sourceFormat } = parseSubtitle(text, ext);
    if (!cues.length) {
      throw new Error('未识别到有效字幕条目，请检查字幕文件内容');
    }

    onProgress?.(0.45);
    const shiftMs = Math.round(shiftSec * 1000);
    const transformed = [];
    let droppedCount = 0;

    for (const cue of cues) {
      throwIfTaskCancelled(taskId);
      const rawEnd = cue.endMs + shiftMs;
      if (rawEnd <= 0) {
        droppedCount++;
        continue;
      }
      const startMs = Math.max(0, cue.startMs + shiftMs);
      const endMs = Math.max(startMs + 1, rawEnd);
      const nextText = stripTags ? cleanSubtitleText(cue.text) : cue.text.trim();
      if (!nextText) continue;
      transformed.push({ startMs, endMs, text: nextText });
    }

    if (!transformed.length) {
      throw new Error('时间轴偏移或清理标签后没有剩余有效字幕');
    }

    onProgress?.(0.75);
    let outText;
    if (targetFormat === 'vtt') outText = formatVtt(transformed);
    else if (targetFormat === 'txt') outText = formatTxt(transformed, { timestamps: txtTimestamps });
    else outText = formatSrt(transformed);

    throwIfTaskCancelled(taskId);
    writeTaskOutput(outputPath, Buffer.from(outText, 'utf8'));
    onProgress?.(1);

    return {
      output: outputPath,
      sourceFormat,
      targetFormat,
      cueCount: transformed.length,
      originalCount: cues.length,
      droppedCount,
      shiftSec,
      encoding,
      outputSize: Buffer.byteLength(outText, 'utf8'),
    };
  } finally {
    release();
  }
}

module.exports = {
  convertSubtitleFile,
  inspectSubtitle,
  parseSubtitle,
  decodeSubtitleBuffer,
  cleanSubtitleText,
};
