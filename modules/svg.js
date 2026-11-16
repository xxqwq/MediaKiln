'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  num,
  normalizeHexColor,
  imageCodecArgs,
  parseSvgDims,
} = require('../core/utils');
const {
  defaultOutput,
  probe,
  runFfmpeg,
  runFfmpegBinary,
} = require('../core/runner');

// ---------------------------------------------------------------------------
// 1. SVG → 位图（Resvg 矢量渲染 + FFmpeg 格式编码）
// ---------------------------------------------------------------------------

function svgToRaster(p) {
  const fmt = p.format || 'png';
  const ext = fmt === 'jpeg' ? 'jpg' : fmt;
  const output = p.output || defaultOutput(p.input, 'svg_out', ext);

  return {
    output,
    async run(taskId, onProgress) {
      onProgress?.(0.1);
      const { Resvg } = require('@resvg/resvg-js');
      const svgText = fs.readFileSync(p.input, 'utf8');
      if (!/<svg[\s>]/i.test(svgText)) {
        throw new Error('无效的 SVG 文件（未找到 <svg> 标签）');
      }

      const scaleMode = p.scaleMode || 'scale';
      let fitTo = { mode: 'original' };

      if (scaleMode === 'scale') {
        const zoom = Math.max(0.25, Math.min(16, num(p.scale, 2)));
        fitTo = { mode: 'zoom', value: zoom };
      } else if (scaleMode === 'width') {
        const w = Math.max(16, Math.min(8192, Math.round(num(p.width, 1024))));
        fitTo = { mode: 'width', value: w };
      } else if (scaleMode === 'maxSide') {
        const maxSide = Math.max(16, Math.min(8192, Math.round(num(p.maxSide, 1920))));
        const base = new Resvg(svgText);
        const bw = base.width || parseSvgDims(svgText).width || 300;
        const bh = base.height || parseSvgDims(svgText).height || 150;
        fitTo = { mode: bw >= bh ? 'width' : 'height', value: maxSide };
      }

      const needOpaque = ext === 'jpg' || ext === 'bmp';
      let bg = p.bgColor || 'transparent';
      if (needOpaque && bg === 'transparent') bg = 'ffffff';

      const opts = { fitTo };
      if (bg !== 'transparent') {
        opts.background = '#' + normalizeHexColor(bg, 'ffffff');
      }

      onProgress?.(0.45);
      const resvg = new Resvg(svgText, opts);
      const rendered = resvg.render();
      const pngBuf = rendered.asPng();

      if (ext === 'png') {
        fs.writeFileSync(output, pngBuf);
        onProgress?.(1);
        return { output };
      }

      const tmpPng = path.join(os.tmpdir(), `vgt_svg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`);
      fs.writeFileSync(tmpPng, pngBuf);
      onProgress?.(0.7);
      try {
        const args = ['-i', tmpPng];
        if (ext === 'ico') {
          const icoSize = Math.max(16, Math.min(256, Math.round(num(p.icoSize, 256))));
          args.push(
            '-vf',
            `scale=${icoSize}:${icoSize}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${icoSize}:${icoSize}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba`,
          );
        } else if (needOpaque) {
          args.push('-pix_fmt', 'yuv420p');
        }
        args.push(...imageCodecArgs(ext, { quality: p.quality || 'high' }), output);
        await runFfmpeg(taskId, args, { onProgress: (r) => onProgress?.(0.7 + r * 0.3) });
      } finally {
        fs.unlink(tmpPng, () => {});
      }
      onProgress?.(1);
      return { output };
    },
  };
}

// ---------------------------------------------------------------------------
// 2. SVG 压缩与优化（SVGO v4）
// ---------------------------------------------------------------------------

async function optimizeSvgText(svgText, {
  preset = 'default',
  floatPrecision = 2,
  multipass = true,
  keepViewBox = true,
  stripDims = false,
  pretty = false,
} = {}) {
  const { optimize } = await import('svgo');
  const overrides = {};
  if (keepViewBox) {
    // SVGO v4 默认保留 viewBox，显式配置防止关闭
  } else {
    overrides.removeViewBox = true;
  }
  if (preset === 'default') {
    overrides.cleanupIds = false;
  }

  const plugins = [
    {
      name: 'preset-default',
      params: { overrides },
    },
  ];
  if (stripDims) plugins.push('removeDimensions');

  const res = optimize(svgText, {
    multipass: !!multipass,
    floatPrecision: Math.max(0, Math.min(6, Math.round(num(floatPrecision, 2)))),
    js2svg: pretty ? { indent: 2, pretty: true } : { pretty: false },
    plugins,
  });
  return res.data;
}

function svgOptimize(p) {
  const output = p.output || defaultOutput(p.input, 'opt', 'svg');

  return {
    output,
    async run(_taskId, onProgress) {
      onProgress?.(0.15);
      const raw = fs.readFileSync(p.input, 'utf8');
      if (!/<svg[\s>]/i.test(raw)) {
        throw new Error('无效的 SVG 文件（未找到 <svg> 标签）');
      }

      const preset = p.preset || 'default';
      const pretty = preset === 'pretty';
      const precision = preset === 'aggressive'
        ? Math.min(2, num(p.floatPrecision, 1))
        : num(p.floatPrecision, 2);

      onProgress?.(0.5);
      const optimized = await optimizeSvgText(raw, {
        preset,
        floatPrecision: precision,
        multipass: p.multipass !== false && p.multipass !== 'false',
        keepViewBox: p.keepViewBox !== false && p.keepViewBox !== 'false',
        stripDims: p.stripDims === true || p.stripDims === 'true',
        pretty,
      });

      fs.writeFileSync(output, optimized, 'utf8');
      onProgress?.(1);
      return { output };
    },
  };
}

// ---------------------------------------------------------------------------
// 3. 图片转 SVG 矢量（FFmpeg 采样 RGBA + ImageTracerJS 轮廓描摹 + SVGO 精简）
// ---------------------------------------------------------------------------

function imageToSvg(p) {
  const output = p.output || defaultOutput(p.input, 'vector', 'svg');

  return {
    output,
    async run(taskId, onProgress) {
      onProgress?.(0.08);
      const info = await probe(p.input);
      if (!info.width || !info.height) {
        throw new Error('无法读取源图片的尺寸');
      }

      const maxDim = Math.max(128, Math.min(2400, Math.round(num(p.maxDim, 800))));
      const scale = Math.min(1, maxDim / Math.max(info.width, info.height));
      const w = Math.max(2, Math.round(info.width * scale));
      const h = Math.max(2, Math.round(info.height * scale));

      onProgress?.(0.2);
      const rgbaBuf = await runFfmpegBinary(taskId, [
        '-i', p.input,
        '-vf', `scale=${w}:${h}:flags=lanczos,format=rgba`,
        '-frames:v', '1',
        '-f', 'rawvideo',
        '-pix_fmt', 'rgba',
        'pipe:1',
      ]);

      const expected = w * h * 4;
      if (rgbaBuf.length < expected) {
        throw new Error('解码图片像素失败');
      }

      onProgress?.(0.45);
      const data = new Uint8ClampedArray(rgbaBuf.buffer, rgbaBuf.byteOffset, expected);
      const mode = p.mode || 'poster';
      const bgMode = p.transparentBg || 'alpha';
      const customColors = num(p.colors, 0);

      // 透明度与黑白二值预处理
      if (mode === 'bw') {
        const thresh = 148;
        const keepWhite = bgMode === 'none';
        for (let i = 0; i < data.length; i += 4) {
          const a = data[i + 3];
          if (a < 128) {
            data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
            data[i + 3] = keepWhite ? 255 : 0;
            continue;
          }
          const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          if (lum >= thresh) {
            data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
            data[i + 3] = keepWhite ? 255 : 0;
          } else {
            data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255;
          }
        }
      } else if (bgMode === 'white') {
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] > 238 && data[i + 1] > 238 && data[i + 2] > 238) {
            data[i + 3] = 0;
          }
        }
      } else if (bgMode === 'none') {
        for (let i = 0; i < data.length; i += 4) {
          const a = data[i + 3] / 255;
          if (a < 1) {
            data[i] = Math.round(data[i] * a + 255 * (1 - a));
            data[i + 1] = Math.round(data[i + 1] * a + 255 * (1 - a));
            data[i + 2] = Math.round(data[i + 2] * a + 255 * (1 - a));
            data[i + 3] = 255;
          }
        }
      }

      const smoothMap = {
        low: { ltres: 0.5, qtres: 0.5, blurradius: 0 },
        medium: { ltres: 1, qtres: 1, blurradius: 0 },
        high: { ltres: 2.2, qtres: 2.2, blurradius: 2 },
      };
      const sm = smoothMap[p.smooth || 'medium'] || smoothMap.medium;
      const pathomit = Math.max(0, Math.min(100, Math.round(num(p.noiseFilter, 8))));

      const ImageTracer = require('imagetracerjs');
      let tracerOpts = {
        viewbox: true,
        strokewidth: 0,
        linefilter: false,
        pathomit,
        ltres: sm.ltres,
        qtres: sm.qtres,
        blurradius: sm.blurradius,
        blurdelta: 20,
        roundcoords: 2,
      };

      if (mode === 'bw') {
        tracerOpts = {
          ...tracerOpts,
          colorsampling: 0,
          numberofcolors: 2,
          colorquantcycles: 1,
          pal: [
            { r: 0, g: 0, b: 0, a: 255 },
            { r: 255, g: 255, b: 255, a: bgMode === 'none' ? 255 : 0 },
          ],
          linefilter: true,
        };
      } else if (mode === 'pixel') {
        tracerOpts = {
          ...tracerOpts,
          numberofcolors: customColors > 0 ? customColors : 16,
          ltres: 0.01,
          qtres: 0.01,
          pathomit: 0,
          blurradius: 0,
          roundcoords: 0,
        };
      } else {
        const defaultColors = mode === 'detailed' ? 24 : 8;
        tracerOpts = {
          ...tracerOpts,
          colorsampling: 2,
          numberofcolors: customColors > 0 ? customColors : defaultColors,
          colorquantcycles: 3,
          mincolorratio: 0,
        };
      }

      onProgress?.(0.65);
      let svgStr = ImageTracer.imagedataToSVG({ width: w, height: h, data }, tracerOpts);

      // 补充 width/height 与 viewBox 共存，确保所有桌面看图器与网页都能正确识别原始比例
      svgStr = svgStr.replace(/<svg\b/, `<svg width="${w}" height="${h}"`);

      if (p.optimizeSvg !== false && p.optimizeSvg !== 'false') {
        onProgress?.(0.85);
        svgStr = await optimizeSvgText(svgStr, {
          preset: 'default',
          floatPrecision: 2,
          multipass: true,
          keepViewBox: true,
          stripDims: false,
          pretty: false,
        });
      }

      fs.writeFileSync(output, svgStr, 'utf8');
      onProgress?.(1);
      return { output };
    },
  };
}

module.exports = {
  svgToRaster,
  svgOptimize,
  imageToSvg,
};
