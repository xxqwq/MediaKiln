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
} = require('../core/utils');
const {
  runFfmpeg,
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

module.exports = {
  imageConvert,
  imageCompressTarget,
  imageStitch,
  imageSplit,
  imageCutout,
  imageFrame,
};
