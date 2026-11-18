'use strict';

const Module = require('module');
const path = require('path');
const { isMainThread, parentPort, workerData } = require('worker_threads');

if (!isMainThread && process.env.VGT_APP_ROOT) {
  const shellNodeModules = path.join(process.env.VGT_APP_ROOT, 'node_modules');
  const origNodeModulePaths = Module._nodeModulePaths;
  Module._nodeModulePaths = function patchedNodeModulePaths(from) {
    const paths = origNodeModulePaths.call(this, from);
    if (!paths.includes(shellNodeModules)) paths.push(shellNodeModules);
    return paths;
  };
}

const { num, normalizeHexColor, parseSvgDims } = require('./utils');

function renderSvgToPng({
  svgText,
  scaleMode = 'scale',
  scale = 2,
  width = 1024,
  maxSide = 1920,
  bgColor = 'transparent',
  ext = 'png',
}) {
  const { Resvg } = require('@resvg/resvg-js');

  let fitTo = { mode: 'original' };
  if (scaleMode === 'scale') {
    const zoom = Math.max(0.25, Math.min(16, num(scale, 2)));
    fitTo = { mode: 'zoom', value: zoom };
  } else if (scaleMode === 'width') {
    const w = Math.max(16, Math.min(8192, Math.round(num(width, 1024))));
    fitTo = { mode: 'width', value: w };
  } else if (scaleMode === 'maxSide') {
    const maxS = Math.max(16, Math.min(8192, Math.round(num(maxSide, 1920))));
    const base = new Resvg(svgText);
    const bw = base.width || parseSvgDims(svgText).width || 300;
    const bh = base.height || parseSvgDims(svgText).height || 150;
    fitTo = { mode: bw >= bh ? 'width' : 'height', value: maxS };
  }

  const needOpaque = ext === 'jpg' || ext === 'bmp';
  let bg = bgColor || 'transparent';
  if (needOpaque && bg === 'transparent') bg = 'ffffff';

  const opts = { fitTo };
  if (bg !== 'transparent') {
    opts.background = '#' + normalizeHexColor(bg, 'ffffff');
  }

  const resvg = new Resvg(svgText, opts);
  const rendered = resvg.render();
  return Buffer.from(rendered.asPng());
}

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
  if (!keepViewBox) {
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

async function traceRgbaToSvg({
  rgbaBuf,
  width,
  height,
  mode = 'poster',
  transparentBg = 'alpha',
  colors = 0,
  smooth = 'medium',
  noiseFilter = 8,
  optimizeSvg = true,
}) {
  const w = width;
  const h = height;
  const expected = w * h * 4;
  const src = new Uint8ClampedArray(rgbaBuf.buffer, rgbaBuf.byteOffset, expected);
  const data = new Uint8ClampedArray(src);

  const bgMode = transparentBg || 'alpha';
  const customColors = num(colors, 0);

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
  const sm = smoothMap[smooth || 'medium'] || smoothMap.medium;
  const pathomit = Math.max(0, Math.min(100, Math.round(num(noiseFilter, 8))));

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

  let svgStr = ImageTracer.imagedataToSVG({ width: w, height: h, data }, tracerOpts);
  svgStr = svgStr.replace(/<svg\b/, `<svg width="${w}" height="${h}"`);

  if (optimizeSvg) {
    svgStr = await optimizeSvgText(svgStr, {
      preset: 'default',
      floatPrecision: 2,
      multipass: true,
      keepViewBox: true,
      stripDims: false,
      pretty: false,
    });
  }

  return svgStr;
}

if (!isMainThread && parentPort) {
  (async () => {
    try {
      const { op, payload } = workerData || {};
      if (op === 'renderSvgToPng') {
        const png = renderSvgToPng(payload);
        parentPort.postMessage({ ok: true, png });
      } else if (op === 'optimizeSvg') {
        const data = await optimizeSvgText(payload.svgText, payload);
        parentPort.postMessage({ ok: true, data });
      } else if (op === 'traceRgbaToSvg') {
        const data = await traceRgbaToSvg(payload);
        parentPort.postMessage({ ok: true, data });
      } else {
        throw new Error(`未知 SVG Worker 操作: ${op}`);
      }
    } catch (err) {
      parentPort.postMessage({ ok: false, error: err?.message || String(err) });
    }
  })();
} else {
  module.exports = {
    renderSvgToPng,
    optimizeSvgText,
    traceRgbaToSvg,
  };
}
