'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  num,
  even,
  normalizeHexColor,
  imageCodecArgs,
  writeRoundedMaskPgm,
  writeGradientPpm,
} = require('../core/utils');
const {
  probe,
  runFfmpeg,
  runFfmpegBinary,
  defaultOutput,
  defaultDirOutput,
  stampOutput,
} = require('../core/runner');

// 透明图转 JPG / BMP 时铺底色（类似 Sharp .flatten）
function buildFlattenChain(inLabel, outLabel, bgHex) {
  return `[${inLabel}]format=rgba,split[__fg][__bgsrc];[__bgsrc]drawbox=x=0:y=0:w=iw:h=ih:color=0x${bgHex}@1:t=fill[__bg];[__bg][__fg]overlay=0:0:shortest=1,format=rgb24[${outLabel}]`;
}

function needsOpaqueBg(fmt) {
  return fmt === 'jpg' || fmt === 'jpeg' || fmt === 'bmp';
}

// ---------------------------------------------------------------------------
// 1. 图片格式转换 & 尺寸缩放 & 体积压缩（参考 Sharp + Squoosh）
// ---------------------------------------------------------------------------
function imageConvert(p) {
  const fmt = ['jpg', 'png', 'webp', 'avif', 'bmp', 'ico'].includes(p.format) ? p.format : 'webp';
  const output = defaultOutput(p.input, fmt === 'ico' ? 'icon' : '转换', fmt);
  const bgHex = normalizeHexColor(p.bgColor, 'ffffff');
  const stripMeta = p.stripMeta !== 'no';

  if (fmt === 'ico') {
    const icoSize = Math.min(Math.max(Math.round(num(p.icoSize, 256)), 16), 256);
    const vf = `scale=${icoSize}:${icoSize}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${icoSize}:${icoSize}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba`;
    const args = ['-i', p.input, '-vf', vf];
    if (stripMeta) args.push('-map_metadata', '-1');
    args.push(...imageCodecArgs('ico'), output);
    return { output, steps: [{ args, totalDuration: 0 }] };
  }

  const vfParts = [];
  const resizeMode = p.resizeMode || 'keep';
  if (resizeMode === 'maxSide') {
    const maxS = Math.min(Math.max(Math.round(num(p.maxSide, 1920)), 32), 8192);
    vfParts.push(`scale='min(${maxS},iw)':'min(${maxS},ih)':force_original_aspect_ratio=decrease:flags=lanczos`);
  } else if (resizeMode === 'percent') {
    const pct = Math.min(Math.max(num(p.percent, 50), 10), 100) / 100;
    vfParts.push(`scale='max(1,round(iw*${pct.toFixed(2)}))':'max(1,round(ih*${pct.toFixed(2)}))':flags=lanczos`);
  } else if (resizeMode === 'width') {
    const w = Math.min(Math.max(Math.round(num(p.customWidth, 1080)), 16), 8192);
    vfParts.push(`scale=${w}:-1:flags=lanczos`);
  }

  const quality = p.quality || 'high';

  // PNG 8-bit 调色板量化（类似 pngquant，体积可降 50%~75%）
  if (fmt === 'png' && quality === 'png8') {
    const palette = path.join(os.tmpdir(), `vgt_imgpal_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`);
    const scaleChain = vfParts.length ? `${vfParts.join(',')},` : '';
    const genArgs = ['-i', p.input, '-vf', `${scaleChain}palettegen=max_colors=256:stats_mode=single:reserve_transparent=1`, '-update', '1', '-frames:v', '1', palette];
    const useArgs = ['-i', p.input, '-i', palette, '-filter_complex', `[0:v]${scaleChain}format=rgba[img];[img][1:v]paletteuse=dither=bayer:bayer_scale=3:alpha_threshold=128`];
    if (stripMeta) useArgs.push('-map_metadata', '-1');
    useArgs.push('-c:v', 'png', '-compression_level', '9', '-update', '1', '-frames:v', '1', output);
    return {
      output,
      cleanup: [palette],
      steps: [
        { args: genArgs, totalDuration: 0, from: 0, to: 0.4 },
        { args: useArgs, totalDuration: 0, from: 0.4, to: 1 },
      ],
    };
  }

  const args = ['-i', p.input];
  if (needsOpaqueBg(fmt)) {
    const pre = vfParts.length ? `[0:v]${vfParts.join(',')}[__scaled];` : '';
    const inLbl = vfParts.length ? '__scaled' : '0:v';
    const fc = `${pre}${buildFlattenChain(inLbl, 'vout', bgHex)}`;
    args.push('-filter_complex', fc, '-map', '[vout]');
  } else if (vfParts.length) {
    args.push('-vf', vfParts.join(','));
  }

  if (stripMeta) args.push('-map_metadata', '-1');
  args.push(...imageCodecArgs(fmt, { quality }), output);
  return { output, steps: [{ args, totalDuration: 0 }] };
}

// ---------------------------------------------------------------------------
// 2. 图片压缩到指定体积（KB）（二分画质搜索 + 自适应缩放，参考 Squoosh）
// ---------------------------------------------------------------------------
function imageCompressTarget(p) {
  const targetKB = Math.min(Math.max(num(p.targetKB, 200), 20), 10240);
  const targetBytes = Math.round(targetKB * 1024);
  const srcExt = path.extname(p.input).slice(1).toLowerCase();
  let fmt = p.format || 'auto';
  if (fmt === 'auto') {
    fmt = (srcExt === 'png' || srcExt === 'webp' || srcExt === 'avif') ? 'webp' : 'jpg';
  }
  if (!['jpg', 'webp', 'png'].includes(fmt)) fmt = 'jpg';

  const output = defaultOutput(p.input, `${Math.round(targetKB)}KB`, fmt);
  const srcW = Math.max(num(p.srcW, 1200), 32);
  const bgHex = normalizeHexColor(p.bgColor, 'ffffff');

  return {
    output,
    async run(taskId, onProgress) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_cimg_'));
      let bestFile = null;
      let bestSize = Infinity;
      let bestQualFile = null; // 在目标体积内画质最高的结果
      let roundIdx = 0;

      const encodeAttempt = async (scaleRatio, qParam) => {
        const idx = roundIdx++;
        const tmpOut = path.join(tmpDir, `try_${idx}.${fmt}`);
        const targetW = Math.max(32, Math.round(srcW * scaleRatio));
        const scaleVf = scaleRatio < 0.999 ? `scale=${targetW}:-1:flags=lanczos` : null;
        const args = ['-i', p.input];

        if (fmt === 'png') {
          const pal = path.join(tmpDir, `pal_${idx}.png`);
          const pre = scaleVf ? `${scaleVf},` : '';
          await runFfmpeg(taskId, ['-i', p.input, '-vf', `${pre}palettegen=max_colors=${qParam}:stats_mode=single:reserve_transparent=1`, '-update', '1', '-frames:v', '1', pal]);
          await runFfmpeg(taskId, ['-i', p.input, '-i', pal, '-filter_complex', `[0:v]${pre}format=rgba[s];[s][1:v]paletteuse=dither=bayer:bayer_scale=3:alpha_threshold=128`, '-map_metadata', '-1', '-c:v', 'png', '-compression_level', '9', '-update', '1', '-frames:v', '1', tmpOut]);
        } else {
          if (needsOpaqueBg(fmt)) {
            const pre = scaleVf ? `[0:v]${scaleVf}[__sc];` : '';
            const fc = `${pre}${buildFlattenChain(scaleVf ? '__sc' : '0:v', 'vout', bgHex)}`;
            args.push('-filter_complex', fc, '-map', '[vout]');
          } else if (scaleVf) {
            args.push('-vf', scaleVf);
          }
          args.push('-map_metadata', '-1', ...imageCodecArgs(fmt, { qv: qParam }), tmpOut);
          await runFfmpeg(taskId, args);
        }

        const sz = fs.existsSync(tmpOut) ? fs.statSync(tmpOut).size : 0;
        if (sz > 0 && sz < bestSize) {
          bestSize = sz;
          bestFile = tmpOut;
        }
        return { file: tmpOut, size: sz };
      };

      try {
        const scales = [1, 0.85, 0.7, 0.55, 0.4, 0.25];
        for (let sIdx = 0; sIdx < scales.length; sIdx++) {
          const scale = scales[sIdx];
          onProgress?.(Math.min(0.95, sIdx / scales.length));

          if (fmt === 'jpg') {
            // mjpeg q:v 2 (最高画质) ~ 31 (最低画质)
            // 先测最低画质 q=28 是否能压进目标；若不能则直接缩小尺寸
            const minCheck = await encodeAttempt(scale, 28);
            if (minCheck.size > targetBytes) continue;
            bestQualFile = minCheck.file;
            let lo = 2, hi = 28;
            while (lo <= hi) {
              const mid = Math.floor((lo + hi) / 2);
              const res = await encodeAttempt(scale, mid);
              if (res.size > 0 && res.size <= targetBytes) {
                bestQualFile = res.file;
                hi = mid - 1; // 尝试更高画质（更小的 q）
              } else {
                lo = mid + 1;
              }
            }
            break;
          } else if (fmt === 'webp') {
            // libwebp q:v 95 (最高) ~ 10 (最低)
            const minCheck = await encodeAttempt(scale, 15);
            if (minCheck.size > targetBytes) continue;
            bestQualFile = minCheck.file;
            let lo = 15, hi = 95;
            while (lo <= hi) {
              const mid = Math.ceil((lo + hi) / 2);
              const res = await encodeAttempt(scale, mid);
              if (res.size > 0 && res.size <= targetBytes) {
                bestQualFile = res.file;
                lo = mid + 1; // 尝试更高画质（更大的 q）
              } else {
                hi = mid - 1;
              }
            }
            break;
          } else {
            // PNG 调色板档位：256 / 128 / 64 / 32 色
            for (const c of [256, 128, 64, 32]) {
              const res = await encodeAttempt(scale, c);
              if (res.size > 0 && res.size <= targetBytes) {
                bestQualFile = res.file;
                break;
              }
            }
            if (bestQualFile) break;
          }
        }

        const chosen = bestQualFile || bestFile;
        if (!chosen) throw new Error('图片压缩失败');
        fs.copyFileSync(chosen, output);
        const finalSize = fs.statSync(output).size;
        onProgress?.(1);
        return {
          output,
          targetReached: finalSize <= targetBytes,
          targetKB: Math.round(targetKB),
        };
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 3. 多图拼接 / 拼图（长图拼接 / 网格拼图，参考 ImageMagick montage）
// ---------------------------------------------------------------------------
function imageStitch(p) {
  const files = p.files || [];
  if (files.length < 2) throw new Error('请至少选择 2 张图片');

  const mode = ['vertical', 'horizontal', 'grid'].includes(p.mode) ? p.mode : 'vertical';
  const fmt = ['jpg', 'png', 'webp'].includes(p.format) ? p.format : 'jpg';
  const gap = Math.min(Math.max(Math.round(num(p.gap, 8)), 0), 80);
  const rawBg = p.bgColor || '#ffffff';
  const transparent = rawBg === 'transparent' && !needsOpaqueBg(fmt);
  const bgHex = transparent ? '00000000' : `${normalizeHexColor(rawBg, 'ffffff')}ff`;
  const solidHex = normalizeHexColor(rawBg === 'transparent' ? 'ffffff' : rawBg, 'ffffff');

  const output = stampOutput(files[0], mode === 'grid' ? '拼图' : '长图', fmt);
  const infos = p.infos || [];
  const widths = files.map((f, i) => num(infos[i]?.width, 0) || num(p.sizes?.[f]?.w, 0) || 1080);
  const heights = files.map((f, i) => num(infos[i]?.height, 0) || num(p.sizes?.[f]?.h, 0) || 1080);

  const inputArgs = [];
  files.forEach((f) => inputArgs.push('-i', f));
  const parts = [];
  let extraIdx = files.length;

  if (mode === 'vertical') {
    const targetW = Math.min(Math.max(...widths, 320), 2400);
    const labels = [];
    files.forEach((_f, i) => {
      const padGap = gap > 0 && i < files.length - 1 ? `,pad=${targetW}:ih+${gap}:0:0:color=0x${bgHex}` : '';
      parts.push(`[${i}:v]scale=${targetW}:-1:flags=lanczos,setsar=1,format=rgba${padGap}[s${i}]`);
      labels.push(`[s${i}]`);
    });
    parts.push(`${labels.join('')}vstack=inputs=${files.length}[stitched]`);
  } else if (mode === 'horizontal') {
    const targetH = Math.min(Math.max(...heights, 320), 2400);
    const labels = [];
    files.forEach((_f, i) => {
      const padGap = gap > 0 && i < files.length - 1 ? `,pad=iw+${gap}:${targetH}:0:0:color=0x${bgHex}` : '';
      parts.push(`[${i}:v]scale=-1:${targetH}:flags=lanczos,setsar=1,format=rgba${padGap}[s${i}]`);
      labels.push(`[s${i}]`);
    });
    parts.push(`${labels.join('')}hstack=inputs=${files.length}[stitched]`);
  } else {
    const cols = Math.min(Math.max(Math.round(num(p.cols, 2)), 2), 4);
    const rows = Math.ceil(files.length / cols);
    const cellW = Math.min(Math.max(Math.round(num(p.cellSize, 600)), 160), 1200);
    const cellH = p.cellRatio === '4:3'
      ? Math.round(cellW * 0.75)
      : (p.cellRatio === '3:4' ? Math.round(cellW * 4 / 3) : cellW);
    const fit = p.fit === 'contain' ? 'contain' : 'cover';

    const rowLabels = [];
    for (let r = 0; r < rows; r++) {
      const colLabels = [];
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const padRight = gap > 0 && c < cols - 1 ? gap : 0;
        const padBottom = gap > 0 && r < rows - 1 ? gap : 0;
        const gapFilter = (padRight || padBottom)
          ? `,pad=${cellW + padRight}:${cellH + padBottom}:0:0:color=0x${bgHex}`
          : '';
        if (idx < files.length) {
          const fitFilter = fit === 'cover'
            ? `scale=${cellW}:${cellH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${cellW}:${cellH}`
            : `scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=0x${bgHex}`;
          parts.push(`[${idx}:v]${fitFilter},setsar=1,format=rgba${gapFilter}[g${r}_${c}]`);
        } else {
          inputArgs.push('-f', 'lavfi', '-i', `color=c=0x${bgHex}:s=${cellW}x${cellH}`);
          parts.push(`[${extraIdx}:v]format=rgba${gapFilter}[g${r}_${c}]`);
          extraIdx++;
        }
        colLabels.push(`[g${r}_${c}]`);
      }
      if (cols === 1) {
        rowLabels.push(colLabels[0]);
      } else {
        parts.push(`${colLabels.join('')}hstack=inputs=${cols}[row${r}]`);
        rowLabels.push(`[row${r}]`);
      }
    }
    if (rows === 1) {
      parts.push(`${rowLabels[0]}copy[stitched]`);
    } else {
      parts.push(`${rowLabels.join('')}vstack=inputs=${rows}[stitched]`);
    }
  }

  if (gap > 0) {
    parts.push(`[stitched]pad=iw+${gap * 2}:ih+${gap * 2}:${gap}:${gap}:color=0x${bgHex}[padded]`);
  }
  const finalSrc = gap > 0 ? 'padded' : 'stitched';
  if (needsOpaqueBg(fmt)) {
    parts.push(buildFlattenChain(finalSrc, 'vout', solidHex));
  } else {
    parts.push(`[${finalSrc}]format=rgba[vout]`);
  }

  const args = [
    ...inputArgs,
    '-filter_complex', parts.join(';'),
    '-map', '[vout]',
    ...imageCodecArgs(fmt, { quality: 'high' }),
    output,
  ];
  return { output, steps: [{ args, totalDuration: 0 }] };
}

// ---------------------------------------------------------------------------
// 4. 九宫格切图 / 长图切片（参考 ImageMagick -crop）
// ---------------------------------------------------------------------------
function imageSplit(p) {
  const W = Math.round(num(p.srcW, 0));
  const H = Math.round(num(p.srcH, 0));
  if (W < 4 || H < 4) throw new Error('无法读取图片尺寸');

  const fmt = ['png', 'jpg', 'webp'].includes(p.format) ? p.format : 'png';
  const dir = defaultDirOutput(p.input, '切图');
  fs.mkdirSync(dir, { recursive: true });

  const rects = [];
  const mode = p.mode || '3x3';

  if (mode === 'longCount') {
    const n = Math.min(Math.max(Math.round(num(p.count, 3)), 2), 20);
    const baseH = Math.floor(H / n);
    if (baseH < 2) throw new Error('图片高度过小，无法按该数量切分');
    for (let i = 0; i < n; i++) {
      const y = i * baseH;
      const h = i === n - 1 ? (H - y) : baseH;
      rects.push({ x: 0, y, w: W, h });
    }
  } else if (mode === 'longHeight') {
    const sliceH = Math.min(Math.max(Math.round(num(p.sliceHeight, 1280)), 100), 8000);
    if (H <= sliceH) throw new Error(`图片高度（${H}px）未超过切片高度（${sliceH}px）`);
    for (let y = 0; y < H; y += sliceH) {
      rects.push({ x: 0, y, w: W, h: Math.min(sliceH, H - y) });
    }
  } else {
    const [cols, rows] = ({ '3x3': [3, 3], '2x2': [2, 2], '3x1': [3, 1], '1x3': [1, 3] }[mode]) || [3, 3];
    const tileW = Math.floor(W / cols);
    const tileH = Math.floor(H / rows);
    if (tileW < 2 || tileH < 2) throw new Error('图片尺寸过小，无法完成网格切分');
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        rects.push({ x: c * tileW, y: r * tileH, w: tileW, h: tileH });
      }
    }
  }

  const splitLabels = rects.map((_, i) => `[s${i}]`).join('');
  const cropParts = rects.map((rc, i) => `[s${i}]crop=${rc.w}:${rc.h}:${rc.x}:${rc.y}[o${i}]`);
  const fc = `[0:v]split=${rects.length}${splitLabels};${cropParts.join(';')}`;

  const args = ['-i', p.input, '-filter_complex', fc];
  rects.forEach((_, i) => {
    const outFile = path.join(dir, `slice_${String(i + 1).padStart(2, '0')}.${fmt}`);
    args.push('-map', `[o${i}]`, ...imageCodecArgs(fmt, { quality: 'high' }), outFile);
  });

  return {
    output: dir,
    outputType: 'dir',
    steps: [{ args, totalDuration: 0 }],
  };
}

// ---------------------------------------------------------------------------
// 5. 纯色抠图 → 透明 PNG / WebP
// ---------------------------------------------------------------------------
function imageCutout(p) {
  const fmt = p.format === 'webp' ? 'webp' : 'png';
  const output = defaultOutput(p.input, '透明抠图', fmt);
  const color = '0x' + normalizeHexColor(p.color, '00ff00');
  const sim = Math.min(Math.max(num(p.similarity, 0.18), 0.01), 0.6).toFixed(2);
  const blend = Math.min(Math.max(num(p.blend, 0.06), 0), 0.4).toFixed(2);
  const vf = `format=rgba,colorkey=${color}:${sim}:${blend}`;
  return {
    output,
    steps: [{
      args: ['-i', p.input, '-vf', vf, ...imageCodecArgs(fmt, { quality: 'high' }), output],
      totalDuration: 0,
    }],
  };
}

// ---------------------------------------------------------------------------
// 6. 图片圆角与边框留白
// ---------------------------------------------------------------------------
function imageFrame(p) {
  const W = Math.max(Math.round(num(p.srcW, 0)), 16);
  const H = Math.max(Math.round(num(p.srcH, 0)), 16);
  const pad = Math.min(Math.max(Math.round(num(p.padding, 24)), 0), 300);
  const rounded = Math.min(Math.max(Math.round(num(p.rounded, 24)), 0), Math.floor(Math.min(W, H) / 2));
  if (pad === 0 && rounded === 0) throw new Error('请至少设置圆角半径或边框留白之一');

  let fmt = ['png', 'webp', 'jpg'].includes(p.format) ? p.format : 'png';
  const rawBg = p.bgColor || 'transparent';
  const transparent = rawBg === 'transparent' && !needsOpaqueBg(fmt);
  const solidHex = normalizeHexColor(rawBg === 'transparent' ? 'ffffff' : rawBg, 'ffffff');
  const output = defaultOutput(p.input, '圆角边框', fmt);

  const extraInputs = [];
  const cleanup = [];
  let chain = '[0:v]format=rgba[v0]';
  let last = 'v0';

  if (rounded > 0) {
    const maskFile = path.join(os.tmpdir(), `vgt_imask_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.pgm`);
    writeRoundedMaskPgm(maskFile, W, H, rounded);
    cleanup.push(maskFile);
    extraInputs.push('-i', maskFile);
    chain += `;[1:v]format=gray[msk];[${last}][msk]alphamerge[vrnd]`;
    last = 'vrnd';
  }

  const outW = W + pad * 2;
  const outH = H + pad * 2;
  const bgColorArg = transparent ? '0x00000000' : `0x${solidHex}ff`;
  if (pad > 0) {
    chain += `;[${last}]pad=${outW}:${outH}:${pad}:${pad}:color=${bgColorArg}[vpad]`;
    last = 'vpad';
  }

  if (needsOpaqueBg(fmt)) {
    chain += `;${buildFlattenChain(last, 'vout', solidHex)}`;
  } else if (!transparent) {
    chain += `;${buildFlattenChain(last, 'vout', solidHex)}`;
  } else {
    chain += `;[${last}]format=rgba[vout]`;
  }

  return {
    output,
    cleanup,
    steps: [{
      args: ['-i', p.input, ...extraInputs, '-filter_complex', chain, '-map', '[vout]', ...imageCodecArgs(fmt, { quality: 'high' }), output],
      totalDuration: 0,
    }],
  };
}

// ---------------------------------------------------------------------------
// 7. 图片更换背景（纯色 / 渐变 / 自定义图片，支持透明图直换 & 边缘连通抠图护主体）
// ---------------------------------------------------------------------------
function applyPixelCutout(rawBuf, W, H, { keyColor, similarity, blend, scope }) {
  const N = W * H;
  const keyHex = normalizeHexColor(keyColor, 'ffffff');
  const kr = parseInt(keyHex.slice(0, 2), 16);
  const kg = parseInt(keyHex.slice(2, 4), 16);
  const kb = parseInt(keyHex.slice(4, 6), 16);

  const sim = Math.min(Math.max(num(similarity, 0.18), 0.01), 0.6);
  const bl = Math.min(Math.max(num(blend, 0.06), 0), 0.4);
  const maxDist = Math.sqrt(3 * 255 * 255);
  const simDist = sim * maxDist;
  const maxFeatherDist = (sim + bl) * maxDist;
  const featherSpan = Math.max(1e-6, maxFeatherDist - simDist);
  const simSq = simDist * simDist;
  const featherSq = maxFeatherDist * maxFeatherDist;

  const distSqAt = (idx) => {
    const off = idx * 4;
    const dr = rawBuf[off] - kr;
    const dg = rawBuf[off + 1] - kg;
    const db = rawBuf[off + 2] - kb;
    return dr * dr + dg * dg + db * db;
  };

  if (scope === 'global') {
    for (let i = 0; i < N; i++) {
      const aOff = i * 4 + 3;
      const origA = rawBuf[aOff];
      if (!origA) continue;
      const d2 = distSqAt(i);
      if (d2 <= simSq) {
        rawBuf[aOff] = 0;
      } else if (bl > 0 && d2 < featherSq) {
        const t = (Math.sqrt(d2) - simDist) / featherSpan;
        rawBuf[aOff] = Math.round(origA * Math.max(0, Math.min(1, t)));
      }
    }
    return;
  }

  // 边缘连通抠图（BFS 从四边扩散，保护主体内部同色如白衬衫/眼睛等不被误抠）
  const visited = new Uint8Array(N);
  const queue = new Int32Array(N);
  let head = 0;
  let tail = 0;

  const trySeed = (idx) => {
    if (visited[idx]) return;
    const origA = rawBuf[idx * 4 + 3];
    if (origA < 10 || distSqAt(idx) <= simSq) {
      visited[idx] = 1;
      queue[tail++] = idx;
    }
  };

  for (let x = 0; x < W; x++) {
    trySeed(x);
    if (H > 1) trySeed((H - 1) * W + x);
  }
  for (let y = 1; y < H - 1; y++) {
    trySeed(y * W);
    if (W > 1) trySeed(y * W + (W - 1));
  }

  while (head < tail) {
    const idx = queue[head++];
    rawBuf[idx * 4 + 3] = 0;
    const x = idx % W;
    const y = (idx - x) / W;

    if (x > 0) trySeed(idx - 1);
    if (x + 1 < W) trySeed(idx + 1);
    if (y > 0) trySeed(idx - W);
    if (y + 1 < H) trySeed(idx + W);
  }

  if (bl > 0 && tail > 0) {
    const feathered = new Uint8Array(N);
    const band1 = [];
    const checkFeather = (nIdx, minKeep) => {
      if (visited[nIdx] || feathered[nIdx]) return false;
      const aOff = nIdx * 4 + 3;
      const origA = rawBuf[aOff];
      if (!origA) return false;
      const d2 = distSqAt(nIdx);
      if (d2 >= featherSq) return false;
      feathered[nIdx] = 1;
      const t = (Math.sqrt(d2) - simDist) / featherSpan;
      rawBuf[aOff] = Math.round(origA * Math.max(minKeep, Math.min(1, t)));
      return true;
    };

    for (let q = 0; q < tail; q++) {
      const idx = queue[q];
      const x = idx % W;
      const y = (idx - x) / W;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          const nIdx = ny * W + nx;
          if (checkFeather(nIdx, 0)) band1.push(nIdx);
        }
      }
    }

    for (let i = 0; i < band1.length; i++) {
      const idx = band1[i];
      const x = idx % W;
      const y = (idx - x) / W;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          checkFeather(ny * W + nx, 0.35);
        }
      }
    }
  }
}

function imageReplaceBg(p) {
  const fmt = ['png', 'jpg', 'webp'].includes(p.format) ? p.format : 'png';
  const bgType = ['solid', 'gradient', 'image'].includes(p.bgType) ? p.bgType : 'solid';
  const fgMode = ['auto', 'keepAlpha', 'colorkey'].includes(p.fgMode) ? p.fgMode : 'auto';
  const cutoutScope = p.cutoutScope === 'global' ? 'global' : 'edge';
  const bgFit = ['bgOriginal', 'cover', 'stretch', 'contain'].includes(p.bgFit) ? p.bgFit : 'cover';
  const fgScale = ['fitAuto', 'contain', 'keep'].includes(p.fgScale) ? p.fgScale : 'fitAuto';
  const fgPos = ['center', 'bottom', 'tl', 'tr', 'bl', 'br'].includes(p.fgPos) ? p.fgPos : 'center';

  if (bgType === 'image' && (!p.bgImage || !fs.existsSync(p.bgImage))) {
    throw new Error('请先选择有效的背景图片');
  }

  const output = defaultOutput(p.input, '换背景', fmt);

  return {
    output,
    async run(taskId, onProgress) {
      onProgress?.(0.08);
      const info = await probe(p.input);
      const W = Math.round(num(info.width, 0));
      const H = Math.round(num(info.height, 0));
      if (W < 2 || H < 2) throw new Error('无法读取图片尺寸');

      const rawBuf = await runFfmpegBinary(taskId, [
        '-i', p.input,
        '-f', 'rawvideo',
        '-pix_fmt', 'rgba',
        'pipe:1',
      ]);
      onProgress?.(0.35);

      const expectedLen = W * H * 4;
      if (!rawBuf || rawBuf.length < expectedLen) {
        throw new Error('解码图片像素失败，请检查文件是否损坏');
      }

      let shouldCutout = fgMode === 'colorkey';
      if (fgMode === 'auto') {
        let hasAlpha = false;
        for (let i = 3; i < expectedLen; i += 4) {
          if (rawBuf[i] < 250) {
            hasAlpha = true;
            break;
          }
        }
        shouldCutout = !hasAlpha;
      }

      if (shouldCutout) {
        applyPixelCutout(rawBuf, W, H, {
          keyColor: p.keyColor || '#ffffff',
          similarity: p.similarity,
          blend: p.blend,
          scope: cutoutScope,
        });
      }
      onProgress?.(0.62);

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_repbg_'));
      try {
        const fgRawPath = path.join(tmpDir, 'fg.raw');
        fs.writeFileSync(fgRawPath, rawBuf.subarray(0, expectedLen));

        const args = ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', `${W}x${H}`, '-i', fgRawPath];
        let fc = '';

        if (bgType === 'solid') {
          const bgHex = normalizeHexColor(p.bgColor, '438edb');
          fc = `color=c=0x${bgHex}:s=${W}x${H},format=rgba[bg];[bg][0:v]overlay=0:0:shortest=1`;
        } else if (bgType === 'gradient') {
          const gradPpm = path.join(tmpDir, 'grad.ppm');
          const gw = Math.min(W, 640);
          const gh = Math.max(2, Math.round(H * (gw / W)));
          writeGradientPpm(gradPpm, gw, gh, p.gradStart || '#6366f1', p.gradEnd || '#22d3ee', p.gradDir || 'tlbr');
          args.push('-i', gradPpm);
          fc = `[1:v]scale=${W}:${H}:flags=bicubic,format=rgba[bg];[bg][0:v]overlay=0:0:shortest=1`;
        } else if (bgFit === 'bgOriginal') {
          args.push('-i', p.bgImage);
          const xyMap = {
            center: 'x=(W-w)/2:y=(H-h)/2',
            bottom: 'x=(W-w)/2:y=H-h',
            tl: 'x=0:y=0',
            tr: 'x=W-w:y=0',
            bl: 'x=0:y=H-h',
            br: 'x=W-w:y=H-h',
          };
          const xyExpr = xyMap[fgPos] || xyMap.center;
          if (fgScale === 'keep') {
            fc = `[1:v]setsar=1,format=rgba[bg];[0:v]setsar=1[fg];[bg][fg]overlay=${xyExpr}:shortest=1`;
          } else {
            const scaleTarget = fgScale === 'contain' ? 'w=rw:h=rh' : "w='min(iw,rw)':h='min(ih,rh)'";
            fc = `[1:v]setsar=1,format=rgba,split[bg][bgref];[0:v][bgref]scale=${scaleTarget}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1[fg];[bg][fg]overlay=${xyExpr}:shortest=1`;
          }
        } else {
          args.push('-i', p.bgImage);
          const padColor = needsOpaqueBg(fmt) ? '0xffffff' : '0x00000000';
          let bgFilter;
          if (bgFit === 'stretch') {
            bgFilter = `scale=${W}:${H}:flags=lanczos`;
          } else if (bgFit === 'contain') {
            bgFilter = `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${padColor}`;
          } else {
            bgFilter = `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}`;
          }
          fc = `[1:v]${bgFilter},setsar=1,format=rgba[bg];[bg][0:v]overlay=0:0:shortest=1`;
        }

        if (needsOpaqueBg(fmt)) {
          fc += ',format=rgb24[vout]';
        } else {
          fc += ',format=rgba[vout]';
        }

        args.push(
          '-filter_complex', fc,
          '-map', '[vout]',
          '-map_metadata', '-1',
          ...imageCodecArgs(fmt, { quality: 'high' }),
          output,
        );

        await runFfmpeg(taskId, args, { totalDuration: 0 });
        onProgress?.(1);
        return { output };
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 8. 标准尺寸画布 / 电商主图 & 社媒头像框
// ---------------------------------------------------------------------------
function imageCanvas(p) {
  const presetMap = {
    '800x800': [800, 800],
    '1000x1000': [1000, 1000],
    '1080x1440': [1080, 1440],
    '1200x1600': [1200, 1600],
    '1080x1080': [1080, 1080],
    '512x512': [512, 512],
  };
  let W;
  let H;
  if (p.preset && presetMap[p.preset]) {
    [W, H] = presetMap[p.preset];
  } else {
    W = Math.min(Math.max(Math.round(num(p.customW, 1080)), 64), 4096);
    H = Math.min(Math.max(Math.round(num(p.customH, 1080)), 64), 4096);
  }

  const fit = ['contain', 'cover', 'blur'].includes(p.fit) ? p.fit : 'contain';
  const fmt = ['jpg', 'png', 'webp'].includes(p.format) ? p.format : 'jpg';
  const marginPct = fit === 'cover' ? 0 : Math.min(Math.max(num(p.marginPct, 0), 0), 30);
  const innerW = Math.max(16, Math.round(W * (1 - (2 * marginPct) / 100)));
  const innerH = Math.max(16, Math.round(H * (1 - (2 * marginPct) / 100)));

  const rawBg = p.bgColor || '#ffffff';
  const transparent = fit === 'contain' && rawBg === 'transparent' && !needsOpaqueBg(fmt);
  const solidHex = normalizeHexColor(rawBg === 'transparent' ? 'ffffff' : rawBg, 'ffffff');
  const output = defaultOutput(p.input, `${W}x${H}`, fmt);

  let fc;
  if (fit === 'cover') {
    fc = `[0:v]format=rgba,scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1[fg];`;
    if (rawBg === 'transparent' && !needsOpaqueBg(fmt)) {
      fc += '[fg]format=rgba[vout]';
    } else {
      fc += buildFlattenChain('fg', 'vout', solidHex);
    }
  } else if (fit === 'blur') {
    const outFmt = needsOpaqueBg(fmt) ? 'format=rgb24' : 'format=rgba';
    fc = `[0:v]format=rgba,split[bsrc][fsrc];`
      + `[bsrc]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},boxblur=25:3,setsar=1[bg];`
      + `[fsrc]scale=${innerW}:${innerH}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1[fg];`
      + `[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1,${outFmt}[vout]`;
  } else if (transparent) {
    fc = `[0:v]format=rgba,scale=${innerW}:${innerH}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setsar=1,format=rgba[vout]`;
  } else {
    const outFmt = needsOpaqueBg(fmt) ? 'format=rgb24' : 'format=rgba';
    fc = `[0:v]format=rgba,scale=${innerW}:${innerH}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setsar=1[fg];`
      + `[fg]split[fg1][bgsrc];`
      + `[bgsrc]drawbox=x=0:y=0:w=iw:h=ih:color=0x${solidHex}@1:t=fill[bg];`
      + `[bg][fg1]overlay=0:0:shortest=1,${outFmt}[vout]`;
  }

  return {
    output,
    steps: [{
      args: ['-i', p.input, '-filter_complex', fc, '-map', '[vout]', '-map_metadata', '-1', ...imageCodecArgs(fmt, { quality: 'high' }), output],
      totalDuration: 0,
    }],
  };
}

module.exports = {
  imageConvert,
  imageCompressTarget,
  imageStitch,
  imageSplit,
  imageCutout,
  imageReplaceBg,
  imageFrame,
  imageCanvas,
};
