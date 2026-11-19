'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const {
  num,
  imageCodecArgs,
} = require('../core/utils');
const {
  defaultOutput,
  probe,
  runFfmpeg,
  runFfmpegBinary,
  registerCancelableTask,
  throwIfTaskCancelled,
  writeTaskOutput,
} = require('../core/runner');

const SVG_WORKER_PATH = path.join(__dirname, '..', 'core', 'svg-worker.js');

function runSvgWorker(taskId, op, payload) {
  throwIfTaskCancelled(taskId);
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(SVG_WORKER_PATH, {
        workerData: { op, payload },
      });
    } catch (err) {
      return reject(Object.assign(err, { __workerSpawnFailed: true }));
    }

    let settled = false;
    let cancelled = false;

    const cleanup = registerCancelableTask(taskId, () => {
      cancelled = true;
      worker.terminate().catch(() => {});
    });

    worker.once('message', (msg) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (cancelled) {
        reject(new Error('任务已取消'));
      } else if (msg && msg.ok) {
        resolve(msg);
      } else {
        reject(new Error(msg?.error || 'SVG Worker 处理失败'));
      }
    });

    worker.once('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cancelled ? new Error('任务已取消') : err);
    });

    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (cancelled) {
        reject(new Error('任务已取消'));
      } else if (code !== 0) {
        reject(new Error(`SVG Worker 异常退出（退出码 ${code}）`));
      } else {
        reject(new Error('SVG Worker 未返回结果'));
      }
    });
  });
}

async function runSvgOp(taskId, op, payload) {
  try {
    return await runSvgWorker(taskId, op, payload);
  } catch (err) {
    if (!err?.__workerSpawnFailed) throw err;
    const fallback = require('../core/svg-worker');
    if (op === 'renderSvgToPng') return { ok: true, png: fallback.renderSvgToPng(payload) };
    if (op === 'optimizeSvg') return { ok: true, data: await fallback.optimizeSvgText(payload.svgText, payload) };
    if (op === 'traceRgbaToSvg') return { ok: true, data: await fallback.traceRgbaToSvg(payload) };
    throw err;
  }
}

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
      const svgText = fs.readFileSync(p.input, 'utf8');
      if (!/<svg[\s>]/i.test(svgText)) {
        throw new Error('无效的 SVG 文件（未找到 <svg> 标签）');
      }

      const needOpaque = ext === 'jpg' || ext === 'bmp';

      onProgress?.(0.45);
      const res = await runSvgOp(taskId, 'renderSvgToPng', {
        svgText,
        scaleMode: p.scaleMode || 'scale',
        scale: p.scale,
        width: p.width,
        maxSide: p.maxSide,
        bgColor: p.bgColor || 'transparent',
        ext,
      });
      const pngBuf = Buffer.from(res.png);

      if (ext === 'png') {
        writeTaskOutput(output, pngBuf);
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

function svgOptimize(p) {
  const output = p.output || defaultOutput(p.input, 'opt', 'svg');

  return {
    output,
    async run(taskId, onProgress) {
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
      const res = await runSvgOp(taskId, 'optimizeSvg', {
        svgText: raw,
        preset,
        floatPrecision: precision,
        multipass: p.multipass !== false && p.multipass !== 'false',
        keepViewBox: p.keepViewBox !== false && p.keepViewBox !== 'false',
        stripDims: p.stripDims === true || p.stripDims === 'true',
        pretty,
      });

      writeTaskOutput(output, res.data);
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
      const res = await runSvgOp(taskId, 'traceRgbaToSvg', {
        rgbaBuf: Uint8Array.from(rgbaBuf.subarray(0, expected)),
        width: w,
        height: h,
        mode: p.mode || 'poster',
        transparentBg: p.transparentBg || 'alpha',
        colors: p.colors,
        smooth: p.smooth || 'medium',
        noiseFilter: p.noiseFilter,
        optimizeSvg: p.optimizeSvg !== false && p.optimizeSvg !== 'false',
      });

      writeTaskOutput(output, res.data);
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
