'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Windows 中文字体（微软雅黑），drawtext 用
const FONT = 'C\\:/Windows/Fonts/msyh.ttc';

const IMG_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif'];
const SVG_EXTS = ['svg'];
const DOC_EXTS = ['docx', 'pptx', 'md', 'markdown'];
const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'ts', 'm4v'];

function isImagePath(filePath) {
  const ext = path.extname(String(filePath || '')).slice(1).toLowerCase();
  return IMG_EXTS.includes(ext);
}

function isSvgPath(filePath) {
  const ext = path.extname(String(filePath || '')).slice(1).toLowerCase();
  return ext === 'svg';
}

function isDocPath(filePath) {
  const ext = path.extname(String(filePath || '')).slice(1).toLowerCase();
  return DOC_EXTS.includes(ext);
}

function parseSvgDims(svgText) {
  const tag = String(svgText || '').match(/<svg\b[^>]*>/i)?.[0] || '';
  const parseLen = (attr) => {
    const m = tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, 'i'));
    if (!m) return 0;
    const raw = m[1].trim();
    if (raw.endsWith('%')) return 0;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  };
  let width = parseLen('width');
  let height = parseLen('height');
  const vb = tag.match(/\bviewBox\s*=\s*["']([^"']+)["']/i);
  if (vb) {
    const nums = vb[1].trim().split(/[\s,]+/).map(Number);
    if (nums.length === 4 && nums.every(Number.isFinite) && nums[2] > 0 && nums[3] > 0) {
      if (!width && height) width = Math.round(height * (nums[2] / nums[3]));
      else if (width && !height) height = Math.round(width * (nums[3] / nums[2]));
      else if (!width && !height) {
        width = Math.round(nums[2]);
        height = Math.round(nums[3]);
      }
    }
  }
  return { width, height };
}

const num = (v, fallback) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function normalizeHexColor(raw, fallback = '000000') {
  const cleaned = String(raw || fallback).trim().replace(/^#|^0x/i, '');
  if (/^[0-9a-f]{6}$/i.test(cleaned)) return cleaned.toLowerCase();
  return fallback;
}

// 变速时 atempo 每级只支持 0.5~2，链式级联覆盖 0.25~4
function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s > 2.0) { parts.push('atempo=2.0'); s /= 2.0; }
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  parts.push(`atempo=${s.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`);
  return parts.join(',');
}

function scaleFilter(width) {
  return `scale=${width}:-2:flags=lanczos`;
}

// 输入文件扩展名 → 安全输出容器
function videoExt(inputPath) {
  const ext = path.extname(inputPath).slice(1).toLowerCase();
  return ['mp4', 'mkv', 'mov', 'webm'].includes(ext) ? ext : 'mp4';
}

// 静态图片输出扩展名（保留原格式，jpeg 统一为 jpg，bmp 转 png 或保持 bmp）
function imageExt(inputPath) {
  const ext = path.extname(inputPath).slice(1).toLowerCase();
  if (ext === 'jpeg') return 'jpg';
  if (['jpg', 'png', 'webp', 'bmp', 'avif'].includes(ext)) return ext;
  return 'png';
}

// 静态图片编码参数（单帧输出，透明图转 JPG/BMP 自动垫底色）
function imageCodecArgs(fmt, { quality = 'high', qv = null } = {}) {
  if (fmt === 'jpg' || fmt === 'jpeg') {
    const q = qv ?? ({ high: 2, medium: 5, low: 10 }[quality] || 3);
    return ['-c:v', 'mjpeg', '-q:v', String(q), '-update', '1', '-frames:v', '1'];
  }
  if (fmt === 'webp') {
    const q = qv ?? ({ high: 90, medium: 75, low: 55 }[quality] || 82);
    return ['-c:v', 'libwebp', '-lossless', '0', '-compression_level', '5', '-q:v', String(q), '-frames:v', '1'];
  }
  if (fmt === 'avif') {
    const crf = qv ?? ({ high: 22, medium: 30, low: 38 }[quality] || 28);
    return ['-c:v', 'libaom-av1', '-still-picture', '1', '-crf', String(crf), '-cpu-used', '6', '-pix_fmt', 'yuv420p', '-frames:v', '1'];
  }
  if (fmt === 'bmp') {
    return ['-c:v', 'bmp', '-update', '1', '-frames:v', '1'];
  }
  if (fmt === 'ico') {
    return ['-frames:v', '1'];
  }
  return ['-c:v', 'png', '-compression_level', '9', '-update', '1', '-frames:v', '1'];
}

// concat demuxer 的 list 文件（路径中的单引号需转义）
function writeConcatList(files) {
  const list = path.join(os.tmpdir(), `vgt_concat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`);
  fs.writeFileSync(list, files.map((f) => `file '${f.replaceAll("'", "'\\''")}'`).join('\n'), 'utf8');
  return list;
}

// GIF 两遍编码（palettegen/paletteuse）通用计划
function gifPlan({ input, output, vf, fc, extraInputs = [], colors = 128, seg = [], totalDuration = 0, statsMode = 'diff', dither = 'bayer:bayer_scale=5', diffMode = 'rectangle', loop = 0, reserveTransparent = false }) {
  const palette = path.join(os.tmpdir(), `vgt_palette_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`);
  const ditherOpt = dither === 'none' ? 'dither=none' : `dither=${dither}`;
  const diffOpt = diffMode === 'none' ? '' : `:diff_mode=${diffMode}`;
  const transGen = reserveTransparent ? ':reserve_transparent=1' : '';
  const transUse = reserveTransparent ? ':alpha_threshold=128' : '';
  const loopArgs = loop !== undefined && loop !== null ? ['-loop', String(loop)] : [];
  const baseInputs = [...seg, '-i', input, ...extraInputs];
  const palIdx = 1 + extraInputs.filter((a) => a === '-i').length;
  const genStep = fc
    ? {
        args: [...baseInputs, '-filter_complex', `${fc};[x]palettegen=max_colors=${colors}:stats_mode=${statsMode}${transGen}`, palette],
        totalDuration, from: 0, to: 0.3,
      }
    : {
        args: [...baseInputs, '-vf', `${vf},palettegen=max_colors=${colors}:stats_mode=${statsMode}${transGen}`, palette],
        totalDuration, from: 0, to: 0.3,
      };
  const useGraph = fc
    ? `${fc};[x][${palIdx}:v]paletteuse=${ditherOpt}${diffOpt}${transUse}`
    : `[0:v]${vf}[x];[x][${palIdx}:v]paletteuse=${ditherOpt}${diffOpt}${transUse}`;
  return {
    output,
    cleanup: [palette],
    steps: [
      genStep,
      {
        args: [...baseInputs, '-i', palette, '-filter_complex', useGraph, ...loopArgs, output],
        totalDuration, from: 0.3, to: 1,
      },
    ],
  };
}

// 生成圆角抗锯齿灰度遮罩 (.pgm)
function writeRoundedMaskPgm(filePath, w, h, r) {
  const header = Buffer.from(`P5\n${w} ${h}\n255\n`, 'ascii');
  const data = Buffer.alloc(w * h, 255);
  const rad = Math.min(r, Math.floor(Math.min(w, h) / 2));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx = 0;
      let dy = 0;
      if (x < rad && y < rad) { dx = rad - x; dy = rad - y; }
      else if (x >= w - rad && y < rad) { dx = x - (w - 1 - rad); dy = rad - y; }
      else if (x < rad && y >= h - rad) { dx = rad - x; dy = y - (h - 1 - rad); }
      else if (x >= w - rad && y >= h - rad) { dx = x - (w - 1 - rad); dy = y - (h - 1 - rad); }
      else continue;
      const dist = Math.hypot(dx, dy);
      if (dist >= rad + 0.5) data[y * w + x] = 0;
      else if (dist > rad - 0.5) data[y * w + x] = Math.round((rad + 0.5 - dist) * 255);
    }
  }
  fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

module.exports = {
  FONT,
  IMG_EXTS,
  SVG_EXTS,
  DOC_EXTS,
  VIDEO_EXTS,
  isImagePath,
  isSvgPath,
  isDocPath,
  parseSvgDims,
  num,
  even,
  normalizeHexColor,
  atempoChain,
  scaleFilter,
  videoExt,
  imageExt,
  imageCodecArgs,
  writeConcatList,
  gifPlan,
  writeRoundedMaskPgm,
};
