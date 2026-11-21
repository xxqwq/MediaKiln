'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeKey } = require('./registry');

function usageError(msg) {
  const err = new Error(msg);
  err.exitCode = 2;
  return err;
}

function isNegativeNumberToken(token) {
  return typeof token === 'string' && /^-\d+(?:\.\d+)?$/.test(token);
}

/**
 * 轻量命令行解析器：
 * - 支持 --key value / --key=value / -k value / boolean 开关 / --no-xxx / -- 位置分隔
 * - 正确处理负数值（如 --threshold -35 / --brightness -0.15）
 */
function parseArgv(argv, { booleanFlags = [], multiFlags = [], shortMap = {} } = {}) {
  const boolSet = new Set(booleanFlags.map(normalizeKey));
  const multiSet = new Set(multiFlags.map(normalizeKey));

  const positionals = [];
  const options = []; // 保序记录 { name, rawName, value }
  const optionMap = new Map(); // normalizedName -> value | value[]

  const pushOpt = (rawName, canonicalName, value) => {
    const norm = normalizeKey(canonicalName);
    options.push({ name: canonicalName, rawName, norm, value });
    if (multiSet.has(norm)) {
      if (!optionMap.has(norm)) optionMap.set(norm, []);
      optionMap.get(norm).push(value);
    } else {
      optionMap.set(norm, value);
    }
  };

  let afterDoubleDash = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (afterDoubleDash) {
      positionals.push(tok);
      continue;
    }
    if (tok === '--') {
      afterDoubleDash = true;
      continue;
    }

    if (tok.startsWith('--') && tok.length > 2) {
      const body = tok.slice(2);
      const eqIdx = body.indexOf('=');
      if (eqIdx !== -1) {
        const name = body.slice(0, eqIdx);
        const val = body.slice(eqIdx + 1);
        pushOpt(`--${name}`, name, val);
        continue;
      }
      const norm = normalizeKey(body);
      if (boolSet.has(norm)) {
        pushOpt(tok, body, true);
        continue;
      }
      if (body.startsWith('no-') && boolSet.has(normalizeKey(body.slice(3)))) {
        pushOpt(tok, body.slice(3), false);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-' && !isNegativeNumberToken(next))) {
        throw usageError(`参数 ${tok} 缺少取值`);
      }
      i++;
      pushOpt(tok, body, next);
      continue;
    }

    if (tok.startsWith('-') && tok.length > 1 && !isNegativeNumberToken(tok)) {
      const shortKey = tok.slice(1);
      const mapped = shortMap[shortKey];
      if (!mapped) {
        throw usageError(`未知短参数：${tok}`);
      }
      const norm = normalizeKey(mapped);
      if (boolSet.has(norm)) {
        pushOpt(tok, mapped, true);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-' && !isNegativeNumberToken(next))) {
        throw usageError(`参数 ${tok} 缺少取值`);
      }
      i++;
      pushOpt(tok, mapped, next);
      continue;
    }

    positionals.push(tok);
  }

  return {
    positionals,
    options,
    get(name) {
      return optionMap.get(normalizeKey(name));
    },
    getAll(name) {
      const v = optionMap.get(normalizeKey(name));
      if (v === undefined) return [];
      return Array.isArray(v) ? v : [v];
    },
    has(name) {
      return optionMap.has(normalizeKey(name));
    },
  };
}

function parseTimeSec(raw) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) throw new Error(`无效时间值：${raw}`);
    return raw;
  }
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('时间值不能为空');
  if (/^\d+(?:\.\d+)?s?$/i.test(s)) {
    return parseFloat(s);
  }
  const hm = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s$/i);
  if (hm) {
    return (parseInt(hm[1] || '0', 10) * 3600) + (parseInt(hm[2] || '0', 10) * 60) + parseFloat(hm[3]);
  }
  const parts = s.split(':');
  if (parts.length === 2 || parts.length === 3) {
    const nums = parts.map((p) => Number(p));
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) {
      throw new Error(`无效时间格式：${raw}（示例：12.5、01:20 或 00:01:20.5）`);
    }
    return nums.length === 2
      ? nums[0] * 60 + nums[1]
      : nums[0] * 3600 + nums[1] * 60 + nums[2];
  }
  throw new Error(`无效时间格式：${raw}（示例：12.5、01:20 或 00:01:20.5）`);
}

function parseSegments(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('--segments 不能为空');
  if (s.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(s);
    } catch (err) {
      throw new Error(`--segments JSON 解析失败：${err.message}`);
    }
    if (!Array.isArray(parsed) || !parsed.length) {
      throw new Error('--segments 需为非空数组');
    }
    return parsed.map((seg) => {
      const start = parseTimeSec(seg.start);
      const end = parseTimeSec(seg.end);
      if (end <= start) throw new Error(`无效时间段：${start} ~ ${end}（结束时间须大于开始时间）`);
      return { start, end };
    });
  }

  const parts = s.split(/[;,]+/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) throw new Error('--segments 至少需要一个时间段，如 "0-5,10-15"');
  return parts.map((part) => {
    const idx = part.indexOf('-');
    if (idx === -1) throw new Error(`无效时间段 "${part}"，格式应为 "开始-结束"，例如 "0-5,10-15"`);
    const start = parseTimeSec(part.slice(0, idx));
    const end = parseTimeSec(part.slice(idx + 1));
    if (end <= start) throw new Error(`无效时间段 "${part}"（结束时间须大于开始时间）`);
    return { start, end };
  });
}

function parseCrop(raw, info = {}, { deferPixelConversion = false } = {}) {
  let obj = null;
  if (raw && typeof raw === 'object') {
    obj = raw;
  } else {
    const s = String(raw ?? '').trim();
    if (!s) throw usageError('--crop 不能为空');
    if (s.startsWith('{')) {
      try {
        obj = JSON.parse(s);
      } catch (err) {
        throw usageError(`--crop JSON 解析失败：${err.message}`);
      }
    } else {
      const nums = s.split(/[,\s:x]+/).filter(Boolean).map(Number);
      if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) {
        throw usageError(`无效 --crop 格式："${s}"，应为 "x,y,w,h"（例如 "0.1,0.1,0.8,0.8" 或像素 "100,50,640,360"）`);
      }
      obj = { x: nums[0], y: nums[1], w: nums[2], h: nums[3] };
    }
  }

  let { x, y, w, h } = obj;
  x = Number(x);
  y = Number(y);
  w = Number(w);
  h = Number(h);
  if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0) {
    throw usageError(`无效裁剪区域：x=${x}, y=${y}, w=${w}, h=${h}`);
  }

  // 若任意坐标大于 1，按像素值自动换算为 0~1 相对比例
  if (x > 1 || y > 1 || w > 1 || h > 1) {
    if (deferPixelConversion) {
      return { x, y, w, h, __pixel: true };
    }
    const srcW = Number(info?.width) || 0;
    const srcH = Number(info?.height) || 0;
    if (srcW <= 0 || srcH <= 0) {
      throw usageError('输入文件缺少宽高信息，无法将像素裁剪坐标转换为比例，请改用 0~1 比例坐标');
    }
    x = Math.min(1, x / srcW);
    y = Math.min(1, y / srcH);
    w = Math.min(1 - x, w / srcW);
    h = Math.min(1 - y, h / srcH);
  }

  if (w <= 0 || h <= 0) throw usageError('裁剪区域宽高不能为 0');
  return { x, y, w, h };
}

function globToRegex(pattern) {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else if (/[.+^${}()|[\]\\]/.test(ch)) re += '\\' + ch;
    else re += ch;
  }
  re += '$';
  return new RegExp(re, process.platform === 'win32' ? 'i' : '');
}

function expandInputGlobs(patterns) {
  const out = [];
  for (const raw of patterns || []) {
    const str = String(raw || '').trim();
    if (!str) continue;
    if (!/[*?]/.test(str)) {
      out.push(path.resolve(str));
      continue;
    }
    const dirPart = path.dirname(str);
    const basePart = path.basename(str);
    if (/[*?]/.test(dirPart)) {
      throw new Error(`通配符仅支持文件名部分，不支持目录级通配符：${str}`);
    }
    const resolvedDir = path.resolve(dirPart);
    if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
      throw new Error(`未找到匹配目录：${resolvedDir}`);
    }
    const rx = globToRegex(basePart);
    const matches = fs.readdirSync(resolvedDir, { withFileTypes: true })
      .filter((ent) => ent.isFile() && rx.test(ent.name))
      .map((ent) => ent.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      .map((name) => path.join(resolvedDir, name));
    if (!matches.length) {
      throw new Error(`通配符未匹配到任何文件：${str}`);
    }
    out.push(...matches);
  }
  return out;
}

function findCustomPairKey(schema, key) {
  const exactMap = {
    width: 'customWidth',
    fps: 'customFps',
    imageMaxSide: 'imageCustomMaxSide',
    gifMaxSide: 'gifCustomMaxSide',
    gifFps: 'gifCustomFps',
    videoMaxSide: 'videoCustomMaxSide',
  };
  const cand = exactMap[key];
  if (!cand) return '';
  return schema.params.some((p) => p.key === cand) ? cand : '';
}

function suggestParamNames(schema, rawName) {
  const norm = normalizeKey(rawName);
  const scored = [];
  for (const p of schema.params) {
    const cand = normalizeKey(p.key);
    let score = 0;
    if (cand.startsWith(norm) || norm.startsWith(cand)) score = 100;
    else if (cand.includes(norm) || norm.includes(cand)) score = 60;
    else {
      let hits = 0;
      for (const ch of new Set(norm)) if (cand.includes(ch)) hits++;
      if (hits >= Math.max(2, Math.floor(norm.length * 0.6))) score = hits * 5;
    }
    if (score > 0) scored.push({ flag: p.flag, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map((s) => s.flag);
}

/**
 * 将 CLI 参数与可选的 --params-json 合并到工具的 node.params，并校验合法性。
 */
function resolveToolNodeParams(schema, rawToolOptions, { paramsJson = '', fileInfo = null, deferCrop = false } = {}) {
  const params = { ...schema.defaults };
  const explicitKeys = new Set();
  const secondaryFiles = new Map(); // portKey -> filePath
  let replaceDir = '';
  const replaceFiles = [];
  let durationOverride = null;
  let cropRaw = null;
  let hasTimeOverride = false;

  const applyEntry = (rawKey, rawVal) => {
    const norm = normalizeKey(rawKey);
    const desc = schema.aliasMap.get(norm);
    if (!desc) {
      const suggestions = suggestParamNames(schema, rawKey);
      const hint = suggestions.length ? `，你是不是想输入：${suggestions.join(', ')}` : '';
      throw usageError(`工具 "${schema.featureId}" 不支持参数 "--${rawKey}"${hint}（运行 mediakiln info ${schema.featureId} 查看全部参数）`);
    }

    if (desc.key === '__duration') {
      durationOverride = parseTimeSec(rawVal);
      hasTimeOverride = true;
      return;
    }
    if (desc.kind === 'time') {
      params[desc.key] = parseTimeSec(rawVal);
      explicitKeys.add(desc.key);
      hasTimeOverride = true;
      return;
    }
    if (desc.kind === 'segments') {
      params.segments = parseSegments(rawVal);
      explicitKeys.add('segments');
      return;
    }
    if (desc.kind === 'crop') {
      cropRaw = rawVal;
      explicitKeys.add('crop');
      return;
    }
    if (desc.kind === 'file') {
      const resolved = path.resolve(String(rawVal || ''));
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new Error(`辅助文件不存在（${desc.flag}）：${resolved}`);
      }
      params[desc.key] = resolved;
      secondaryFiles.set(desc.portKey, resolved);
      explicitKeys.add(desc.key);
      return;
    }
    if (desc.key === '__replaceDir') {
      const resolved = path.resolve(String(rawVal || ''));
      if (!fs.existsSync(resolved)) {
        throw new Error(`替换路径不存在（${desc.flag}）：${resolved}`);
      }
      if (fs.statSync(resolved).isDirectory()) {
        replaceDir = resolved;
      } else {
        replaceFiles.push(resolved);
      }
      return;
    }
    if (desc.key === '__replaceFiles') {
      const items = String(rawVal || '').split(',').map((x) => x.trim()).filter(Boolean);
      for (const item of expandInputGlobs(items)) {
        if (!fs.existsSync(item) || !fs.statSync(item).isFile()) {
          throw new Error(`替换图片不存在：${item}`);
        }
        replaceFiles.push(item);
      }
      return;
    }
    if (desc.key === '__bgColorAlias') {
      const strVal = String(rawVal || '').trim();
      if (['transparent', 'white', 'black', 'dark'].includes(strVal.toLowerCase())) {
        params.bgMode = strVal.toLowerCase();
      } else {
        params.bgMode = 'custom';
        params.bgCustom = strVal;
      }
      explicitKeys.add('bgMode');
      explicitKeys.add('bgCustom');
      return;
    }

    const strVal = String(rawVal ?? '');

    // 先处理快捷预设联动（仅填充用户未显式覆盖的其他字段）
    if (desc.applyPresets && Object.prototype.hasOwnProperty.call(desc.applyPresets, strVal)) {
      const presetPatch = desc.applyPresets[strVal];
      for (const [pk, pv] of Object.entries(presetPatch)) {
        if (!explicitKeys.has(pk)) {
          params[pk] = pv;
        }
      }
    }

    // 处理 select/chips 含 'custom' 选项时的数字直传自动展开（如 --width 720 -> width='custom', customWidth='720'）
    if (desc.options && desc.options.length) {
      const allowedValues = desc.options.map((o) => o.value);
      if (!allowedValues.includes(strVal)) {
        const customPairKey = findCustomPairKey(schema, desc.key);
        if (customPairKey && allowedValues.includes('custom') && /^\d+(?:\.\d+)?$/.test(strVal)) {
          params[desc.key] = 'custom';
          params[customPairKey] = strVal;
          explicitKeys.add(desc.key);
          explicitKeys.add(customPairKey);
          return;
        }
        if (desc.key === 'bgMode' && allowedValues.includes('custom') && /^#?[0-9a-f]{3,8}$/i.test(strVal)) {
          params.bgMode = 'custom';
          params.bgCustom = strVal.startsWith('#') ? strVal : `#${strVal}`;
          explicitKeys.add('bgMode');
          explicitKeys.add('bgCustom');
          return;
        }
        throw usageError(
          `参数 ${desc.flag} 的取值 "${strVal}" 无效，可选值：${allowedValues.join(' | ')}`,
        );
      }
    }

    params[desc.key] = strVal;
    explicitKeys.add(desc.key);
  };

  if (paramsJson) {
    let parsed;
    try {
      parsed = JSON.parse(paramsJson);
    } catch (err) {
      throw new Error(`--params-json 解析失败：${err.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--params-json 必须是 JSON 对象');
    }
    for (const [k, v] of Object.entries(parsed)) {
      applyEntry(k, v);
    }
  }

  for (const item of rawToolOptions) {
    applyEntry(item.name, item.value);
  }

  if (durationOverride !== null) {
    const startSec = Number(params.tStart) || 0;
    params.tEnd = startSec + durationOverride;
  }

  if (schema.featureId === 'compressGif' && hasTimeOverride && !explicitKeys.has('useTrim')) {
    params.useTrim = 'yes';
  }

  if (schema.featureId === 'docRepackImages' && (replaceDir || replaceFiles.length)) {
    params.__local_replaceSource = { dir: replaceDir, files: replaceFiles };
  }

  if (cropRaw !== null) {
    params.crop = parseCrop(cropRaw, fileInfo, { deferPixelConversion: deferCrop });
  }

  return { params, secondaryFiles, cropRaw };
}

module.exports = {
  parseArgv,
  parseTimeSec,
  parseSegments,
  parseCrop,
  expandInputGlobs,
  resolveToolNodeParams,
};
