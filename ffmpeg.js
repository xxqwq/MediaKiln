'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 使用项目自带的新版 ffmpeg（gyan 9.0.2）。
// 不用 ffmpeg-static：其内置的 ffmpeg 6.1 存在动画 WebP 编码缺陷（输出文件损坏）。
// 开发态位于 <项目>/bin/；打包后由 extraResources 放在 <exe目录>/resources/bin/。
const binDir = __dirname.includes('app.asar')
  ? path.join(process.resourcesPath, 'bin')
  : path.join(__dirname, 'bin');

const FFMPEG = path.join(binDir, 'ffmpeg.exe');
const FFPROBE = path.join(binDir, 'ffprobe.exe');

function assertBinaries() {
  if (!fs.existsSync(FFMPEG) || !fs.existsSync(FFPROBE)) {
    throw new Error(`ffmpeg 二进制缺失：${binDir} 目录需要包含 ffmpeg.exe 和 ffprobe.exe`);
  }
}

// Windows 中文字体（微软雅黑），drawtext 用
const FONT = 'C\\:/Windows/Fonts/msyh.ttc';

// ---------------------------------------------------------------------------
// ffprobe：读取媒体信息
// ---------------------------------------------------------------------------

function probe(filePath) {
  return new Promise((resolve, reject) => {
    assertBinaries();
    const child = spawn(FFPROBE, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format', '-show_streams',
      filePath,
    ]);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', () => {
      try {
        const info = JSON.parse(out);
        const video = (info.streams || []).find((s) => s.codec_type === 'video');
        // GIF 等容器的 format.duration 可能缺失，回退到流时长
        let fps = 0;
        const fr = video?.avg_frame_rate || video?.r_frame_rate;
        if (fr && fr !== '0/0') {
          const [n, d] = fr.split('/').map(Number);
          if (n > 0 && d > 0) fps = n / d;
        }
        const subCount = (info.streams || []).filter((s) => s.codec_type === 'subtitle').length;
        resolve({
          duration: parseFloat(info.format?.duration) || parseFloat(video?.duration) || 0,
          size: parseInt(info.format?.size, 10) || 0,
          width: video?.width || 0,
          height: video?.height || 0,
          fps: Math.round(fps * 100) / 100,
          hasAudio: (info.streams || []).some((s) => s.codec_type === 'audio'),
          hasSubtitles: subCount > 0,
          subCount,
        });
      } catch (e) {
        reject(new Error('无法读取该文件的媒体信息'));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// ffmpeg 执行器：进度解析 + 可取消
// ---------------------------------------------------------------------------

const runningTasks = new Map(); // taskId -> child process

function runFfmpeg(taskId, argsList, { totalDuration = 0, from = 0, to = 1, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostats', '-progress', 'pipe:1', '-y', ...argsList];
    const child = spawn(FFMPEG, args, { windowsHide: true });
    runningTasks.set(taskId, child);

    let stderrTail = '';
    let cancelled = false;

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      // -progress 输出形如 out_time_us=123456 / progress=continue
      const m = text.match(/out_time_us=(\d+)/) || text.match(/out_time_ms=(\d+)/);
      if (m && totalDuration > 0) {
        const ratio = from + (to - from) * Math.min(1, parseInt(m[1], 10) / 1e6 / totalDuration);
        onProgress?.(Math.min(ratio, 1));
      }
      if (text.includes('progress=end')) onProgress?.(to);
    });

    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });

    const cancel = () => { cancelled = true; };
    runningTasks.get(taskId).__cancel = cancel;

    child.on('error', (err) => {
      runningTasks.delete(taskId);
      reject(err);
    });

    child.on('close', (code) => {
      runningTasks.delete(taskId);
      if (cancelled) {
        reject(new Error('任务已取消'));
      } else if (code === 0) {
        resolve();
      } else {
        const lines = stderrTail.split('\n').filter((l) => l.trim()).slice(-3).join('\n');
        reject(new Error(`ffmpeg 失败（退出码 ${code}）：\n${lines || '未知错误'}`));
      }
    });
  });
}

function cancelTask(taskId) {
  const child = runningTasks.get(taskId);
  if (child) {
    child.__cancel?.();
    // Windows 下用 taskkill 连同子进程一起结束，更可靠
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

const num = (v, fallback) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

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

// 输出目录上下文（由 executeTask 在调用 builder 时设置：same / subdir / custom）
let _outCtx = null;
function resolveOutDir(inputPath) {
  const baseDir = path.dirname(inputPath);
  if (!_outCtx) return baseDir;
  if (_outCtx.mode === 'custom' && _outCtx.dir) {
    fs.mkdirSync(_outCtx.dir, { recursive: true });
    return _outCtx.dir;
  }
  if (_outCtx.mode === 'subdir') {
    const sub = path.join(baseDir, 'output');
    fs.mkdirSync(sub, { recursive: true });
    return sub;
  }
  return baseDir;
}

// 输出文件默认与输入同目录，加后缀避免覆盖
function defaultOutput(inputPath, suffix, ext) {
  const dir = resolveOutDir(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(dir, `${base}_${suffix}.${ext}`);
}

function stampOutput(inputPath, prefix, ext) {
  const dir = resolveOutDir(inputPath);
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return path.join(dir, `${prefix}_${ts}.${ext}`);
}

// 硬件编码器探测（缓存结果，避免每次重复拉起进程）
let _hwCache = null;
function testHwEncoder(enc) {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x64:d=0.1',
      '-frames:v', '1', '-c:v', enc, '-pix_fmt', 'yuv420p', '-f', 'null', '-',
    ], { windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(false); }, 3000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

async function detectHwEncoders() {
  if (_hwCache) return _hwCache;
  assertBinaries();
  const candidates = ['h264_nvenc', 'h264_qsv', 'h264_amf'];
  const available = [];
  for (const enc of candidates) {
    if (await testHwEncoder(enc)) available.push(enc);
  }
  _hwCache = { available, primary: available[0] || null };
  return _hwCache;
}

// 视频常用编码参数（根据 __hwAccel 优先走 GPU，回退 libx264）
const X264 = ['-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p'];
const X264_FAST = ['-c:v', 'libx264', '-crf', '20', '-preset', 'fast', '-pix_fmt', 'yuv420p'];

function videoCodecArgs(p, { crf = 20, preset = 'medium' } = {}) {
  let hw = p?.__hwAccel || 'cpu';
  if (hw === 'auto') hw = _hwCache?.primary || 'cpu';
  if (hw === 'h264_nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', String(crf), '-pix_fmt', 'yuv420p'];
  }
  if (hw === 'h264_qsv') {
    return ['-c:v', 'h264_qsv', '-preset', preset === 'fast' ? 'veryfast' : 'medium', '-global_quality', String(crf), '-pix_fmt', 'yuv420p'];
  }
  if (hw === 'h264_amf') {
    return ['-c:v', 'h264_amf', '-quality', preset === 'fast' ? 'speed' : 'balanced', '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf), '-pix_fmt', 'yuv420p'];
  }
  return ['-c:v', 'libx264', '-crf', String(crf), '-preset', preset, '-pix_fmt', 'yuv420p'];
}

// 输入文件扩展名 → 安全输出容器
function videoExt(inputPath) {
  const ext = path.extname(inputPath).slice(1).toLowerCase();
  return ['mp4', 'mkv', 'mov', 'webm'].includes(ext) ? ext : 'mp4';
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

// ---------------------------------------------------------------------------
// 功能命令构建器
// 每个返回 { output, steps: [{ args, totalDuration, from, to }], cleanup?, run? }
// 带 run 的为动态计划（如迭代压缩），由 executeTask 直接调用
// ---------------------------------------------------------------------------

const builders = {
  // ============================ 转换 ============================

  // 1. 视频 → GIF（palettegen 两遍编码，画质最佳）
  videoToGif(p) {
    const output = defaultOutput(p.input, 'gif', 'gif');
    const fps = Math.min(Math.max(num(p.fps, 15), 5), 30);
    const width = Math.min(Math.max(num(p.width, 480), 64), 1920);
    const colors = Math.min(Math.max(num(p.colors, 128), 16), 256);
    const start = Math.max(num(p.start, 0), 0);
    const dur = num(p.duration, 0);
    const total = dur > 0 ? dur : num(p.totalDuration, 0);
    // dur<=0 表示转换整段，不传 -t
    const seg = dur > 0 ? ['-ss', String(start), '-t', String(dur)] : ['-ss', String(start)];
    return gifPlan({
      input: p.input, output, colors, seg, totalDuration: total,
      vf: `fps=${fps},${scaleFilter(width)}`,
    });
  },

  // 2. GIF → 视频（MP4 保证手机可播 / WebM 体积更小）
  gifToVideo(p) {
    const format = p.format === 'webm' ? 'webm' : 'mp4';
    const output = defaultOutput(p.input, format, format);
    const args = ['-i', p.input];
    if (format === 'mp4') {
      args.push(
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1',
        ...videoCodecArgs(p, { crf: 20, preset: 'medium' }),
        '-movflags', '+faststart'
      );
    } else {
      // GIF 解码为 bgra/rgb24，vp9 不接受，需先转 yuv420p
      args.push('-vf', 'format=yuv420p', '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1');
    }
    return {
      output,
      steps: [{ args: [...args, output], totalDuration: num(p.totalDuration, 0) }],
    };
  },

  // 视频 → WebP 动图（比 GIF 小 30~50%）
  toWebp(p) {
    const output = defaultOutput(p.input, 'webp', 'webp');
    const fps = Math.min(Math.max(num(p.fps, 15), 5), 30);
    const width = Math.min(Math.max(num(p.width, 480), 64), 1920);
    const quality = Math.min(Math.max(num(p.quality, 75), 30), 100);
    const start = Math.max(num(p.start, 0), 0);
    const dur = num(p.duration, 0);
    const total = dur > 0 ? dur : num(p.totalDuration, 0);
    const seg = dur > 0 ? ['-ss', String(start), '-t', String(dur)] : ['-ss', String(start)];
    return {
      output,
      steps: [{
        args: [...seg, '-i', p.input,
          '-vf', `fps=${fps},${scaleFilter(width)}`,
          '-c:v', 'libwebp', '-lossless', '0', '-compression_level', '5',
          '-q:v', String(quality), '-loop', '0', '-an', output],
        totalDuration: total,
      }],
    };
  },

  // 4. 视频格式转换（支持重编码 & 无损秒转封装）
  convertVideo(p) {
    const isCopy = p.mode === 'copy';
    const format = ['mp4', 'mkv', 'mov', 'webm'].includes(p.format) ? p.format : 'mp4';
    if (isCopy) {
      if (format === 'webm') throw new Error('无损换容器仅支持 MP4 / MKV / MOV，WebM 请选“重编码”');
      const output = defaultOutput(p.input, 'remux', format);
      const args = ['-i', p.input, '-c', 'copy'];
      if (format === 'mp4' || format === 'mov') args.push('-movflags', '+faststart');
      return {
        output,
        steps: [{ args: [...args, output], totalDuration: num(p.totalDuration, 0) }],
      };
    }

    const output = defaultOutput(p.input, format, format);
    const res = num(p.height, 0); // 0 = 保持原始
    const crf = { high: 18, medium: 23, low: 28 }[p.quality] || 23;
    const vf = res > 0 ? `scale=-2:${res}` : null;
    const args = ['-i', p.input];
    if (vf) args.push('-vf', vf);
    if (format === 'webm') {
      args.push('-c:v', 'libvpx-vp9', '-crf', String(crf + 8), '-b:v', '0', '-row-mt', '1',
        '-c:a', 'libopus', '-b:a', '128k');
    } else {
      args.push(...videoCodecArgs(p, { crf, preset: 'medium' }), '-c:a', 'aac', '-b:a', '128k');
      if (format === 'mp4' || format === 'mov') args.push('-movflags', '+faststart');
    }
    return {
      output,
      steps: [{ args: [...args, output], totalDuration: num(p.totalDuration, 0) }],
    };
  },

  // ============================ GIF 编辑 ============================

  // 3. GIF 压缩（尺寸/比例/帧率/颜色/抖动/统计模式/去噪/去重复帧/倍速/循环/片段裁剪）
  compressGif(p) {
    const output = defaultOutput(p.input, 'compressed', 'gif');
    const srcFps = num(p.srcFps, 0);
    const srcW = num(p.srcW, 0);

    // 帧率：支持百分比减半、固定值、自定义
    let fps;
    if (p.fps === 'p50') {
      fps = Math.max(1, Math.round(((srcFps > 0 ? srcFps : 12) * 0.5) * 10) / 10);
    } else if (p.fps === 'custom') {
      fps = Math.min(Math.max(num(p.customFps, 10), 1), 30);
    } else {
      fps = Math.min(Math.max(num(p.fps, 12), 1), 30);
      if (srcFps > 0) fps = Math.min(fps, srcFps);
    }

    // 宽度：支持百分比缩放、固定宽度、自定义宽度
    let width;
    if (p.width === 'p75' || p.width === 'p50' || p.width === 'p30') {
      const ratio = { p75: 0.75, p50: 0.5, p30: 0.3 }[p.width];
      width = (srcW > 0 ? srcW : 480) * ratio;
    } else if (p.width === 'custom') {
      width = num(p.customWidth, 400);
    } else {
      width = num(p.width, 480);
      if (srcW > 0) width = Math.min(width, srcW);
    }
    width = even(Math.min(Math.max(width, 32), 1920));

    const colors = Math.min(Math.max(num(p.colors, 128), 4), 256);
    const ditherMap = {
      none: 'none',
      small: 'none',
      bayer5: 'bayer:bayer_scale=5',
      balanced: 'bayer:bayer_scale=5',
      bayer3: 'bayer:bayer_scale=3',
      quality: 'bayer:bayer_scale=2',
      bayer1: 'bayer:bayer_scale=1',
      floyd: 'floyd_steinberg',
      sierra: 'sierra2_4a',
    };
    const dither = ditherMap[p.dither] || 'bayer:bayer_scale=5';
    const statsMode = ['diff', 'full', 'single'].includes(p.statsMode) ? p.statsMode : 'diff';
    const diffMode = p.diffMode === 'none' ? 'none' : 'rectangle';
    const speed = Math.min(Math.max(num(p.speed, 1), 0.5), 2.5);
    const loop = p.loop !== undefined ? parseInt(p.loop, 10) : 0;

    // 片段裁剪（可选）
    const start = Math.max(num(p.start, 0), 0);
    const dur = num(p.duration, 0);
    const seg = dur > 0 ? ['-ss', String(start), '-t', String(dur)] : (start > 0 ? ['-ss', String(start)] : []);
    const baseDur = dur > 0 ? dur : num(p.totalDuration, 0);
    const totalDuration = baseDur / speed;

    // 滤镜链：可选变速 -> 帧率 -> 缩放 -> 可选降噪 -> 可选去重复帧
    const vfParts = [];
    if (speed !== 1) vfParts.push(`setpts=PTS/${speed}`);
    vfParts.push(`fps=${fps}`, scaleFilter(width));
    if (p.denoise === 'light') vfParts.push('hqdn3d=2:1.5:3:2');
    else if (p.denoise === 'strong') vfParts.push('hqdn3d=4:3:6:4');
    if (p.dedup === 'yes') vfParts.push('mpdecimate');
    const vf = vfParts.join(',');

    // single 模式为逐帧调色板，需单遍 split + paletteuse=new=1
    if (statsMode === 'single') {
      const ditherOpt = dither === 'none' ? 'dither=none' : `dither=${dither}`;
      const diffOpt = diffMode === 'none' ? '' : `:diff_mode=${diffMode}`;
      const fc = `[0:v]${vf},split[s1][s2];[s1]palettegen=max_colors=${colors}:stats_mode=single[p];[s2][p]paletteuse=${ditherOpt}:new=1${diffOpt}`;
      return {
        output,
        steps: [{
          args: [...seg, '-i', p.input, '-filter_complex', fc, '-loop', String(Number.isFinite(loop) ? loop : 0), output],
          totalDuration,
        }],
      };
    }

    return gifPlan({
      input: p.input, output, colors, dither, statsMode, diffMode,
      loop: Number.isFinite(loop) ? loop : 0, seg, totalDuration, vf,
    });
  },

  // GIF 加文字（drawtext + textfile：文字写入临时文件，免疫逗号/冒号/括号等特殊字符）
  gifText(p) {
    const text = String(p.text || '').trim();
    if (!text) throw new Error('请输入要添加的文字');
    const output = defaultOutput(p.input, 'text', 'gif');
    const h = num(p.height, 0);
    if (h <= 0) throw new Error('无法读取 GIF 尺寸');
    const sizeK = { small: 18, medium: 11, large: 7 }[p.size] || 11;
    const fontsize = Math.max(14, even(h / sizeK));
    const color = { white: 'white', yellow: 'yellow', black: 'black' }[p.color] || 'white';
    const yExpr = { top: '20', center: '(h-text_h)/2', bottom: 'h-text_h-30' }[p.pos] || 'h-text_h-30';

    // 文字内容写临时文件；filter 内路径需正斜杠 + 盘符冒号转义
    const textFile = path.join(os.tmpdir(), `vgt_text_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`);
    fs.writeFileSync(textFile, text, 'utf8');
    const textFileArg = textFile.replace(/\\/g, '/').replace(/:/g, '\\:');

    const drawtext = `drawtext=fontfile='${FONT}':textfile='${textFileArg}':fontsize=${fontsize}:fontcolor=${color}:borderw=3:bordercolor=${color === 'black' ? 'white' : 'black'}:x=(w-text_w)/2:y=${yExpr}:expansion=none`;
    const plan = gifPlan({
      input: p.input, output, colors: 256, totalDuration: num(p.totalDuration, 0),
      vf: drawtext,
    });
    plan.cleanup = [...(plan.cleanup || []), textFile];
    return plan;
  },

  // 压缩到目标大小（视频按码率精确控制；GIF 迭代降参并保留最优结果）
  compressTarget(p) {
    const targetMB = Math.min(Math.max(num(p.targetMB, 25), 0.2), 500);
    const isGif = path.extname(p.input).slice(1).toLowerCase() === 'gif';

    if (!isGif) {
      // ---- 视频：duration 反推码率，一遍到位 ----
      const duration = num(p.totalDuration, 0);
      if (duration <= 0) throw new Error('无法读取视频时长');
      const output = defaultOutput(p.input, `${targetMB}MB`, 'mp4');
      const audioKbps = p.hasAudio ? 128 : 0;
      // 目标总码率（kbps）× 0.95 容器开销安全系数
      const totalKbps = (targetMB * 8192) / duration * 0.95;
      const videoKbps = Math.max(64, Math.round(totalKbps - audioKbps));
      const args = ['-i', p.input,
        '-c:v', 'libx264', '-b:v', `${videoKbps}k`, '-maxrate', `${Math.round(videoKbps * 1.5)}k`,
        '-bufsize', `${videoKbps * 2}k`, '-preset', 'medium', '-pix_fmt', 'yuv420p'];
      if (p.hasAudio) args.push('-c:a', 'aac', '-b:a', '128k');
      args.push('-movflags', '+faststart', output);
      return {
        output,
        steps: [{ args, totalDuration: duration }],
      };
    }

    // ---- GIF：迭代尝试，参数逐级收紧（后期关闭抖动以大幅压体积） ----
    const output = defaultOutput(p.input, 'min', 'gif');
    const origW = Math.max(num(p.width, 480), 48);
    const origFps = Math.max(num(p.fps, 12), 1);
    const capFps = (target) => Math.min(origFps, Math.max(1, target));
    const capW = (wk, maxW = origW) => even(Math.max(48, Math.min(origW, maxW, origW * wk)));
    const attempts = [
      { colors: 256, fps: origFps, w: even(origW), dither: 'bayer:bayer_scale=5' },
      { colors: 128, fps: capFps(Math.max(4, origFps * 0.8)), w: capW(0.85), dither: 'bayer:bayer_scale=5' },
      { colors: 64, fps: capFps(Math.max(4, origFps * 0.65)), w: capW(0.7), dither: 'bayer:bayer_scale=5' },
      { colors: 64, fps: capFps(Math.max(3, origFps * 0.5)), w: capW(0.55), dither: 'none' },
      { colors: 32, fps: capFps(Math.max(3, origFps * 0.45)), w: capW(0.42), dither: 'none' },
      { colors: 16, fps: capFps(5), w: capW(0.32), dither: 'none' },
      { colors: 16, fps: capFps(4), w: capW(0.25, 240), dither: 'none' },
    ];
    const targetBytes = targetMB * 1024 * 1024;
    const totalDuration = num(p.totalDuration, 0);

    return {
      output,
      async run(taskId, onProgress) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_cgif_'));
        let bestFile = null;
        let bestSize = Infinity;
        try {
          for (let i = 0; i < attempts.length; i++) {
            const a = attempts[i];
            const tmpOut = path.join(tmpDir, `try_${i}.gif`);
            const plan = gifPlan({
              input: p.input, output: tmpOut, colors: a.colors, dither: a.dither,
              totalDuration,
              vf: `fps=${a.fps.toFixed(1)},${scaleFilter(a.w)}`,
            });
            // 每轮迭代占整体进度的等分
            const lo = i / attempts.length, hi = (i + 1) / attempts.length;
            try {
              for (const step of plan.steps) {
                await runFfmpeg(taskId, step.args, {
                  totalDuration: step.totalDuration,
                  from: lo + (hi - lo) * (step.from || 0),
                  to: lo + (hi - lo) * (step.to || 1),
                  onProgress,
                });
              }
            } finally {
              for (const f of plan.cleanup) fs.unlink(f, () => {});
            }
            const size = fs.existsSync(tmpOut) ? fs.statSync(tmpOut).size : 0;
            if (size > 0 && size < bestSize) {
              bestSize = size;
              bestFile = tmpOut;
            }
            if (size > 0 && size <= targetBytes) {
              fs.copyFileSync(tmpOut, output);
              onProgress?.(1);
              return { output, targetReached: true, targetMB };
            }
          }
          if (bestFile) fs.copyFileSync(bestFile, output);
          onProgress?.(1);
          return { output, targetReached: bestSize <= targetBytes, targetMB };
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      },
    };
  },

  // ============================ 剪辑 ============================

  // 5. 视频截取（默认无损复制，秒级完成；精确模式重编码保证帧准）
  // -ss 放在 -i 之后（输出端 seek）：复制模式时长准确；重编码模式帧级精确
  trimVideo(p) {
    const fmt = videoExt(p.input);
    const output = defaultOutput(p.input, 'clip', fmt);
    const start = Math.max(num(p.start, 0), 0);
    const dur = num(p.duration, 0);
    if (dur <= 0) throw new Error('截取时长必须大于 0');
    const args = ['-i', p.input, '-ss', String(start), '-t', String(dur)];
    if (p.precise) {
      args.push(...videoCodecArgs(p, { crf: 20, preset: 'fast' }), '-c:a', 'aac');
    } else {
      args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
    }
    return {
      output,
      steps: [{ args: [...args, output], totalDuration: dur }],
    };
  },

  // 视频合并（无损 concat demuxer / 兼容模式自动统一分辨率与音轨）
  mergeVideos(p) {
    const files = p.files || [];
    if (files.length < 2) throw new Error('请至少选择 2 个文件');

    if (p.mode === 'compat') {
      const output = stampOutput(files[0], '合并', 'mp4');
      const infos = p.infos || [];
      const W = even(Math.max(num(infos[0]?.width, 1280), 320));
      const H = even(Math.max(num(infos[0]?.height, 720), 240));
      const anyAudio = infos.some((i) => i?.hasAudio);
      const totalDuration = infos.reduce((s, i) => s + num(i?.duration, 0), 0);

      const inputArgs = [];
      const fcParts = [];
      const concatInputs = [];
      files.forEach((f, idx) => {
        inputArgs.push('-i', f);
        fcParts.push(`[${idx}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30,format=yuv420p[v${idx}]`);
        if (anyAudio) {
          if (infos[idx]?.hasAudio) {
            fcParts.push(`[${idx}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${idx}]`);
          } else {
            const d = Math.max(0.1, num(infos[idx]?.duration, 1));
            fcParts.push(`anullsrc=r=44100:cl=stereo:d=${d.toFixed(2)}[a${idx}]`);
          }
          concatInputs.push(`[v${idx}][a${idx}]`);
        } else {
          concatInputs.push(`[v${idx}]`);
        }
      });

      if (anyAudio) {
        fcParts.push(`${concatInputs.join('')}concat=n=${files.length}:v=1:a=1[v][a]`);
      } else {
        fcParts.push(`${concatInputs.join('')}concat=n=${files.length}:v=1:a=0[v]`);
      }

      const args = [...inputArgs, '-filter_complex', fcParts.join(';'), '-map', '[v]'];
      if (anyAudio) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '128k');
      args.push(...videoCodecArgs(p), '-movflags', '+faststart', output);
      return {
        output,
        steps: [{ args, totalDuration }],
      };
    }

    const fmt = videoExt(files[0]);
    const output = stampOutput(files[0], '合并', fmt);
    const list = writeConcatList(files);
    return {
      output,
      cleanup: [list],
      steps: [{
        args: ['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', output],
        totalDuration: 0, // 复制模式无意义，靠 progress=end 兜底
      }],
    };
  },

  // 画面裁剪（可视化拉框）
  videoCrop(p) {
    const { w, h, x, y } = p.crop || {};
    if (!w || !h || w < 16 || h < 16) throw new Error('请先在画面上拉出裁剪区域');
    const cw = even(w), ch = even(h);
    const cx = even(Math.min(x, num(p.srcW, cw) - cw)), cy = even(Math.min(y, num(p.srcH, ch) - ch));
    const crop = `crop=${cw}:${ch}:${cx}:${cy}`;
    const ext = path.extname(p.input).slice(1).toLowerCase();
    if (ext === 'gif') {
      return gifPlan({
        input: p.input, output: defaultOutput(p.input, 'crop', 'gif'),
        colors: 256, totalDuration: num(p.totalDuration, 0), vf: crop,
      });
    }
    const output = defaultOutput(p.input, 'crop', videoExt(p.input));
    return {
      output,
      steps: [{
        args: ['-i', p.input, '-vf', crop, ...videoCodecArgs(p), '-c:a', 'copy', output],
        totalDuration: num(p.totalDuration, 0),
      }],
    };
  },

  // 局部打码 / 模糊（遮水印、人脸、隐私区域，视频与 GIF 通用）
  videoBlur(p) {
    const { w, h, x, y } = p.crop || {};
    if (!w || !h || w < 16 || h < 16) throw new Error('请先在画面上拖出要打码的区域');
    const srcW = Math.max(num(p.srcW, w), 16);
    const srcH = Math.max(num(p.srcH, h), 16);
    const cw = even(Math.min(Math.max(16, w), srcW));
    const ch = even(Math.min(Math.max(16, h), srcH));
    const cx = even(Math.max(0, Math.min(x, srcW - cw)));
    const cy = even(Math.max(0, Math.min(y, srcH - ch)));

    const strong = p.strength === 'strong';
    let effect;
    if (p.mode === 'mosaic') {
      const block = strong ? 24 : 14;
      const mw = Math.max(2, even(Math.round(cw / block)));
      const mh = Math.max(2, even(Math.round(ch / block)));
      effect = `scale=${mw}:${mh}:flags=area,scale=${cw}:${ch}:flags=neighbor`;
    } else {
      const maxR = Math.max(2, Math.floor(Math.min(cw, ch) / 4));
      const r = Math.min(strong ? 24 : 12, maxR);
      const cr = Math.max(1, Math.min(Math.floor(r / 2), maxR));
      effect = `boxblur=lr=${r}:lp=2:cr=${cr}:cp=2`;
    }

    const ext = path.extname(p.input).slice(1).toLowerCase();
    const total = num(p.totalDuration, 0);
    if (ext === 'gif') {
      const fc = `[0:v]format=rgba,split[base][roi];[roi]crop=${cw}:${ch}:${cx}:${cy},${effect}[b];[base][b]overlay=${cx}:${cy}[x]`;
      return gifPlan({
        input: p.input, output: defaultOutput(p.input, 'blur', 'gif'),
        colors: 256, totalDuration: total, fc,
      });
    }
    const output = defaultOutput(p.input, 'blur', videoExt(p.input));
    const fc = `[0:v]split[base][roi];[roi]crop=${cw}:${ch}:${cx}:${cy},${effect}[b];[base][b]overlay=${cx}:${cy}[v]`;
    return {
      output,
      steps: [{
        args: ['-i', p.input, '-filter_complex', fc, '-map', '[v]', '-map', '0:a?', ...videoCodecArgs(p), '-c:a', 'copy', output],
        totalDuration: total,
      }],
    };
  },

  // 横竖屏比例适配（9:16 / 16:9 / 1:1 / 4:3 / 3:4，支持模糊背景或纯色填充）
  aspectPad(p) {
    const ext = path.extname(p.input).slice(1).toLowerCase();
    const isGif = ext === 'gif';
    const sizes = isGif
      ? { '9:16': [480, 854], '16:9': [640, 360], '1:1': [480, 480], '4:3': [640, 480], '3:4': [480, 640] }
      : { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080], '4:3': [1440, 1080], '3:4': [1080, 1440] };
    const [W, H] = sizes[p.ratio] || sizes['9:16'];
    const bg = ['blur', 'black', 'white'].includes(p.bg) ? p.bg : 'blur';
    const total = num(p.totalDuration, 0);

    if (bg !== 'blur') {
      const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${bg},setsar=1`;
      if (isGif) {
        return gifPlan({ input: p.input, output: defaultOutput(p.input, 'ratio', 'gif'), colors: 256, totalDuration: total, vf });
      }
      const output = defaultOutput(p.input, 'ratio', videoExt(p.input));
      return {
        output,
        steps: [{ args: ['-i', p.input, '-vf', vf, ...videoCodecArgs(p), '-c:a', 'copy', output], totalDuration: total }],
      };
    }

    if (isGif) {
      const fc = `[0:v]format=rgba,split[bg][fg];[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:3[bg2];[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1[x]`;
      return gifPlan({ input: p.input, output: defaultOutput(p.input, 'ratio', 'gif'), colors: 256, totalDuration: total, fc });
    }
    const output = defaultOutput(p.input, 'ratio', videoExt(p.input));
    const fc = `[0:v]format=yuv420p,split[bg][fg];[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=25:3[bg2];[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1[v]`;
    return {
      output,
      steps: [{
        args: ['-i', p.input, '-filter_complex', fc, '-map', '[v]', '-map', '0:a?', ...videoCodecArgs(p), '-c:a', 'copy', output],
        totalDuration: total,
      }],
    };
  },

  // 添加水印（文字水印 / 图片水印）
  watermark(p) {
    const ext = path.extname(p.input).slice(1).toLowerCase();
    const isGif = ext === 'gif';
    const total = num(p.totalDuration, 0);
    const opacity = Math.min(Math.max(num(p.opacity, 0.7), 0.1), 1);
    const size = p.size || 'medium';
    const pos = p.pos || 'br';

    if (p.mode === 'image') {
      const wmImg = p.image;
      if (!wmImg) throw new Error('请先选择水印图片');
      const srcW = Math.max(num(p.srcW, 720), 64);
      const wmRatio = { small: 0.12, medium: 0.18, large: 0.26 }[size] || 0.18;
      const wmW = even(Math.max(32, srcW * wmRatio));
      const overlayPos = {
        br: 'W-w-24:H-h-24', bl: '24:H-h-24', tr: 'W-w-24:24', tl: '24:24', center: '(W-w)/2:(H-h)/2',
      }[pos] || 'W-w-24:H-h-24';

      if (isGif) {
        const fc = `[1:v]scale=${wmW}:-2,format=rgba,colorchannelmixer=aa=${opacity}[wm];[0:v][wm]overlay=${overlayPos}[x]`;
        return gifPlan({
          input: p.input, output: defaultOutput(p.input, 'wm', 'gif'),
          extraInputs: ['-i', wmImg], fc, colors: 256, totalDuration: total,
        });
      }
      const output = defaultOutput(p.input, 'wm', videoExt(p.input));
      const fc = `[1:v]scale=${wmW}:-2,format=rgba,colorchannelmixer=aa=${opacity}[wm];[0:v][wm]overlay=${overlayPos}[v]`;
      return {
        output,
        steps: [{
          args: ['-i', p.input, '-i', wmImg, '-filter_complex', fc, '-map', '[v]', '-map', '0:a?', ...videoCodecArgs(p), '-c:a', 'copy', output],
          totalDuration: total,
        }],
      };
    }

    const text = String(p.text || '').trim();
    if (!text) throw new Error('请输入水印文字');
    const srcH = Math.max(num(p.srcH, 720), 64);
    const fontsize = Math.max(16, even(srcH / ({ small: 28, medium: 18, large: 12 }[size] || 18)));
    const textPos = {
      br: 'x=w-text_w-24:y=h-text_h-24',
      bl: 'x=24:y=h-text_h-24',
      tr: 'x=w-text_w-24:y=24',
      tl: 'x=24:y=24',
      center: 'x=(w-text_w)/2:y=(h-text_h)/2',
    }[pos] || 'x=w-text_w-24:y=h-text_h-24';

    const textFile = path.join(os.tmpdir(), `vgt_wm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`);
    fs.writeFileSync(textFile, text, 'utf8');
    const textFileArg = textFile.replace(/\\/g, '/').replace(/:/g, '\\:');
    const drawtext = `drawtext=fontfile='${FONT}':textfile='${textFileArg}':fontsize=${fontsize}:fontcolor=white@${opacity}:shadowcolor=black@${(opacity * 0.7).toFixed(2)}:shadowx=2:shadowy=2:${textPos}:expansion=none`;

    if (isGif) {
      const plan = gifPlan({
        input: p.input, output: defaultOutput(p.input, 'wm', 'gif'),
        colors: 256, totalDuration: total, vf: drawtext,
      });
      plan.cleanup = [...(plan.cleanup || []), textFile];
      return plan;
    }
    const output = defaultOutput(p.input, 'wm', videoExt(p.input));
    return {
      output,
      cleanup: [textFile],
      steps: [{
        args: ['-i', p.input, '-vf', drawtext, ...videoCodecArgs(p), '-c:a', 'copy', output],
        totalDuration: total,
      }],
    };
  },

  // 旋转 / 翻转
  rotateFlip(p) {
    const vfMap = {
      r90: 'transpose=1', r270: 'transpose=2', r180: 'transpose=1,transpose=1',
      hflip: 'hflip', vflip: 'vflip',
    };
    const vf = vfMap[p.mode];
    if (!vf) throw new Error('请选择旋转方式');
    const ext = path.extname(p.input).slice(1).toLowerCase();
    if (ext === 'gif') {
      return gifPlan({
        input: p.input, output: defaultOutput(p.input, 'rot', 'gif'),
        colors: 256, totalDuration: num(p.totalDuration, 0), vf,
      });
    }
    const output = defaultOutput(p.input, 'rot', videoExt(p.input));
    return {
      output,
      steps: [{
        args: ['-i', p.input, '-vf', vf, ...videoCodecArgs(p), '-c:a', 'copy', output],
        totalDuration: num(p.totalDuration, 0),
      }],
    };
  },

  // 倒放 / 往复循环（boomerang）
  reverse(p) {
    const boomerang = p.mode === 'boomerang';
    const ext = path.extname(p.input).slice(1).toLowerCase();
    const total = num(p.totalDuration, 0);

    if (ext === 'gif') {
      const outGif = defaultOutput(p.input, boomerang ? 'boomerang' : 'reverse', 'gif');
      // 单遍 filter graph：倒放（或正放+倒放拼接）后再做调色板
      const fc = boomerang
        ? '[0:v]split[s1][s2];[s2]reverse[r];[s1][r]concat=n=2:v=1[c];[c]split[c1][c2];[c1]palettegen=max_colors=256[p];[c2][p]paletteuse=dither=bayer:bayer_scale=5'
        : '[0:v]reverse[c];[c]split[c1][c2];[c1]palettegen=max_colors=256[p];[c2][p]paletteuse=dither=bayer:bayer_scale=5';
      return {
        output: outGif,
        steps: [{
          args: ['-i', p.input, '-filter_complex', fc, outGif],
          totalDuration: boomerang ? total * 2 : total,
        }],
      };
    }

    // 视频：倒放保留音轨（areverse）；往复丢弃音轨（倒放音频无意义）
    const output = defaultOutput(p.input, boomerang ? 'boomerang' : 'reverse', videoExt(p.input));
    if (boomerang) {
      const fc = '[0:v]split[s1][s2];[s2]reverse[r];[s1][r]concat=n=2:v=1[c]';
      return {
        output,
        steps: [{
          args: ['-i', p.input, '-filter_complex', fc, '-map', '[c]', ...videoCodecArgs(p), output],
          totalDuration: total * 2,
        }],
      };
    }
    const args = ['-i', p.input, '-vf', 'reverse'];
    if (p.hasAudio) args.push('-af', 'areverse', '-c:a', 'aac');
    args.push(...videoCodecArgs(p));
    return {
      output,
      steps: [{ args: [...args, output], totalDuration: total }],
    };
  },

  // 6. 变速（0.25x ~ 4x，画面 setpts + 音频 atempo 级联，声画同步）
  changeSpeed(p) {
    const output = defaultOutput(p.input, `${p.speed}x`, videoExt(p.input));
    const speed = Math.min(Math.max(num(p.speed, 1), 0.25), 4);
    if (speed === 1) throw new Error('速度为 1x，无需变速');
    const vFilter = `[0:v]setpts=PTS/${speed}[v]`;
    const args = ['-i', p.input];
    if (p.hasAudio) {
      const fc = `${vFilter};[0:a]${atempoChain(speed)}[a]`;
      args.push('-filter_complex', fc, '-map', '[v]', '-map', '[a]');
    } else {
      args.push('-vf', `setpts=PTS/${speed}`);
    }
    if (videoExt(p.input) === 'webm') {
      args.push('-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-row-mt', '1');
      if (p.hasAudio) args.push('-c:a', 'libopus');
    } else {
      args.push(...videoCodecArgs(p));
      if (p.hasAudio) args.push('-c:a', 'aac', '-b:a', '128k');
    }
    return {
      output,
      steps: [{ args: [...args, output], totalDuration: num(p.totalDuration, 0) / speed }],
    };
  },

  // ============================ 音频 ============================

  // 7. 提取音频
  extractAudio(p) {
    const format = ['mp3', 'm4a', 'wav'].includes(p.format) ? p.format : 'mp3';
    const output = defaultOutput(p.input, 'audio', format);
    const codecArgs = {
      mp3: ['-c:a', 'libmp3lame', '-q:a', '2'],
      m4a: ['-c:a', 'aac', '-b:a', '192k'],
      wav: ['-c:a', 'pcm_s16le'],
    }[format];
    return {
      output,
      steps: [{
        args: ['-i', p.input, '-vn', ...codecArgs, output],
        totalDuration: num(p.totalDuration, 0),
      }],
    };
  },

  // 音频调整（静音 / 音量 / 淡入淡出 / 人声降噪 / 响度标准化），视频流直接复制不重编码
  audioAdjust(p) {
    const output = defaultOutput(p.input, 'audio_adj', videoExt(p.input));
    const D = num(p.totalDuration, 0);
    let args;
    if (p.mode === 'mute') {
      args = ['-i', p.input, '-c:v', 'copy', '-an'];
    } else {
      if (p.hasAudio === false) throw new Error('该视频没有音轨，无法调整音频');
      if (p.mode === 'volume') {
        const vol = Math.min(Math.max(num(p.volume, 2), 0.1), 10);
        args = ['-i', p.input, '-c:v', 'copy', '-af', `volume=${vol}`, '-c:a', 'aac', '-b:a', '192k'];
      } else if (p.mode === 'fade') {
        if (D <= 0) throw new Error('无法读取视频时长');
        const fi = Math.min(num(p.fadeIn, 1), D / 2);
        const fo = Math.min(num(p.fadeOut, 1), D / 2);
        args = ['-i', p.input, '-c:v', 'copy',
          '-af', `afade=t=in:st=0:d=${fi},afade=t=out:st=${Math.max(0, D - fo).toFixed(2)}:d=${fo}`,
          '-c:a', 'aac', '-b:a', '192k'];
      } else if (p.mode === 'denoise') {
        args = ['-i', p.input, '-c:v', 'copy', '-af', 'highpass=f=80,afftdn=nf=-25', '-c:a', 'aac', '-b:a', '192k'];
      } else if (p.mode === 'loudnorm') {
        args = ['-i', p.input, '-c:v', 'copy', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k'];
      } else {
        throw new Error('请选择处理方式');
      }
    }
    return {
      output,
      steps: [{ args: [...args, output], totalDuration: D }],
    };
  },

  // 添加背景音乐（替换原声或混合，音乐自动循环，音量可调）
  addMusic(p) {
    const music = p.music;
    if (!music) throw new Error('请先选择音乐文件');
    const output = defaultOutput(p.input, '配乐', 'mp4');
    const vol = Math.min(Math.max(num(p.musicVolume, 1), 0.1), 3);
    let args;
    if (p.mode === 'mix') {
      if (!p.hasAudio) throw new Error('原视频没有音轨，无法混合，请选择"替换"');
      const fc = `[0:a]volume=1.0[va];[1:a]volume=${vol}[ma];[va][ma]amix=inputs=2:duration=first:dropout_transition=2[a]`;
      args = ['-i', p.input, '-stream_loop', '-1', '-i', music,
        '-filter_complex', fc, '-map', '0:v', '-map', '[a]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest'];
    } else {
      args = ['-i', p.input, '-stream_loop', '-1', '-i', music,
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest'];
    }
    return {
      output,
      steps: [{ args: [...args, output], totalDuration: num(p.totalDuration, 0) }],
    };
  },

  // ============================ 工具 ============================

  // 视频截图（单帧 / 间隔序列 / 逐帧拆解全部原始帧）
  snapshot(p) {
    if (p.mode === 'all') {
      const dir = defaultOutput(p.input, '全部帧', 'png').replace(/\.png$/, '');
      fs.mkdirSync(dir, { recursive: true });
      return {
        output: dir, outputType: 'dir',
        steps: [{
          args: ['-i', p.input, '-fps_mode', 'passthrough', path.join(dir, 'frame_%05d.png')],
          totalDuration: num(p.totalDuration, 0),
        }],
      };
    }
    if (p.mode === 'seq') {
      const dir = defaultOutput(p.input, '帧导出', 'png').replace(/\.png$/, '');
      fs.mkdirSync(dir, { recursive: true });
      const every = Math.min(Math.max(num(p.every, 1), 0.1), 60);
      const start = Math.max(num(p.start, 0), 0);
      const dur = num(p.duration, 0);
      const args = ['-i', p.input];
      if (start > 0) args.unshift('-ss', String(start));
      if (dur > 0) args.push('-t', String(dur));
      args.push('-vf', `fps=${(1 / every).toFixed(4)}`, path.join(dir, 'frame_%04d.png'));
      return {
        output: dir, outputType: 'dir',
        steps: [{ args, totalDuration: dur > 0 ? dur : num(p.totalDuration, 0) }],
      };
    }
    const t = Math.max(num(p.at, 0), 0);
    const fmt = p.format === 'jpg' ? 'jpg' : 'png';
    const output = defaultOutput(p.input, `at_${t.toFixed(1)}s`, fmt);
    const args = ['-ss', String(t), '-i', p.input, '-frames:v', '1'];
    if (fmt === 'jpg') args.push('-q:v', '2');
    return {
      output,
      steps: [{ args: [...args, output], totalDuration: t }],
    };
  },

  // 图片序列 → GIF / MP4
  // 尺寸不一致的图片直接 concat 会触发 ffmpeg 9 的 filter 热重配置 bug，
  // 因此先逐张统一尺寸（黑边居中）存临时序列，再用 image2 序列输入合成（帧参数恒定）
  imagesTo(p) {
    const files = p.files || [];
    if (files.length < 2) throw new Error('请至少选择 2 张图片');
    const fps = Math.min(Math.max(num(p.fps, 8), 1), 30);
    const format = p.format === 'mp4' ? 'mp4' : 'gif';

    // 最大宽高（偶数化）作为统一画布
    const W = even(Math.max(...files.map((f) => num(p.sizes?.[f]?.w, 0) || 0), 2));
    const H = even(Math.max(...files.map((f) => num(p.sizes?.[f]?.h, 0) || 0), 2));
    if (W < 2 || H < 2) throw new Error('无法读取图片尺寸');
    const padVf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:-1:-1:color=black,setsar=1,format=rgb24`;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_imgs_'));
    const seqPattern = path.join(tmpDir, 'seq%03d.png');
    const steps = files.map((f, i) => ({
      args: ['-i', f, '-vf', padVf, '-update', '1', '-frames:v', '1',
        path.join(tmpDir, `seq${String(i + 1).padStart(3, '0')}.png`)],
      totalDuration: 0,
    }));

    const output = stampOutput(files[0], '合成', format);
    const totalDuration = files.length / fps;
    const inputArgs = ['-framerate', String(fps), '-i', seqPattern];

    if (format === 'gif') {
      const palette = path.join(tmpDir, 'pal.png');
      steps.push({ args: [...inputArgs, '-vf', 'palettegen=max_colors=256', palette], totalDuration });
      steps.push({
        args: [...inputArgs, '-i', palette, '-filter_complex', '[0:v][1:v]paletteuse=dither=bayer:bayer_scale=5', output],
        totalDuration,
      });
    } else {
      steps.push({ args: [...inputArgs, ...videoCodecArgs(p), output], totalDuration });
    }

    // 步骤均分总进度
    steps.forEach((s, i) => { s.from = i / steps.length; s.to = (i + 1) / steps.length; });

    return { output, steps, cleanupDirs: [tmpDir] };
  },

  // ============================ 拓展实用功能 ============================

  // 智能切分长视频（按固定时长 / 均分 N 段，导出到目录）
  splitVideo(p) {
    const D = num(p.totalDuration, 0);
    if (D <= 0) throw new Error('无法读取视频时长');
    const fmt = videoExt(p.input);
    const dir = defaultOutput(p.input, '切片', 'dir').replace(/\.dir$/, '');
    fs.mkdirSync(dir, { recursive: true });

    let segDur;
    let count;
    if (p.mode === 'count') {
      count = Math.min(Math.max(Math.round(num(p.count, 3)), 2), 50);
      segDur = D / count;
    } else {
      segDur = Math.min(Math.max(num(p.every, 30), 1), 3600);
      count = Math.max(1, Math.ceil(D / segDur));
    }

    if (!p.precise) {
      return {
        output: dir, outputType: 'dir',
        steps: [{
          args: ['-i', p.input, '-c', 'copy', '-map', '0',
            '-f', 'segment', '-segment_time', segDur.toFixed(3), '-reset_timestamps', '1',
            path.join(dir, `part_%03d.${fmt}`)],
          totalDuration: D,
        }],
      };
    }

    const steps = [];
    for (let i = 0; i < count; i++) {
      const start = i * segDur;
      const len = Math.min(segDur, Math.max(0.1, D - start));
      if (len < 0.05) break;
      const outPart = path.join(dir, `part_${String(i + 1).padStart(3, '0')}.${fmt}`);
      const args = ['-i', p.input, '-ss', start.toFixed(3), '-t', len.toFixed(3),
        ...videoCodecArgs(p, { crf: 20, preset: 'fast' })];
      if (p.hasAudio) args.push('-c:a', 'aac', '-b:a', '128k');
      args.push(outPart);
      steps.push({ args, totalDuration: len });
    }
    steps.forEach((s, i) => { s.from = i / steps.length; s.to = (i + 1) / steps.length; });
    return { output: dir, outputType: 'dir', steps };
  },

  // 多片段保留 / 删中间片段
  multiCut(p) {
    const D = num(p.totalDuration, 0);
    if (D <= 0) throw new Error('无法读取视频时长');
    const raw = (p.segments || [])
      .map((s) => ({ start: Math.max(0, num(s.start, 0)), end: Math.min(D, num(s.end, 0)) }))
      .filter((s) => s.end - s.start >= 0.08)
      .sort((a, b) => a.start - b.start);
    if (!raw.length) throw new Error('请至少添加一个有效的起止时间段');

    // 合并重叠时间段
    const merged = [];
    for (const s of raw) {
      if (!merged.length || s.start > merged[merged.length - 1].end) {
        merged.push({ ...s });
      } else {
        merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, s.end);
      }
    }

    let kept = merged;
    if (p.mode === 'remove') {
      kept = [];
      let cursor = 0;
      for (const s of merged) {
        if (s.start - cursor >= 0.08) kept.push({ start: cursor, end: s.start });
        cursor = Math.max(cursor, s.end);
      }
      if (D - cursor >= 0.08) kept.push({ start: cursor, end: D });
      if (!kept.length) throw new Error('删除所选片段后没有剩余画面');
    }

    const fmt = videoExt(p.input);
    const output = defaultOutput(p.input, p.mode === 'remove' ? '去片段' : '多段拼接', fmt);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_mcut_'));
    const segFiles = [];
    const steps = [];

    kept.forEach((seg, i) => {
      const dur = seg.end - seg.start;
      const segFile = path.join(tmpDir, `seg_${String(i).padStart(3, '0')}.${fmt}`);
      segFiles.push(segFile);
      const args = ['-i', p.input, '-ss', seg.start.toFixed(3), '-t', dur.toFixed(3)];
      if (p.precise) {
        args.push(...videoCodecArgs(p, { crf: 20, preset: 'fast' }));
        if (p.hasAudio) args.push('-c:a', 'aac', '-b:a', '128k');
      } else {
        args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
      }
      args.push(segFile);
      steps.push({ args, totalDuration: dur });
    });

    const listFile = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(listFile, segFiles.map((f) => `file '${f.replaceAll("'", "'\\''")}'`).join('\n'), 'utf8');
    steps.push({
      args: ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', output],
      totalDuration: 0,
    });
    steps.forEach((s, i) => { s.from = i / steps.length; s.to = (i + 1) / steps.length; });

    return { output, steps, cleanupDirs: [tmpDir] };
  },

  // 自动去黑边（cropdetect 多点采样联合边框）
  autoCrop(p) {
    const ext = path.extname(p.input).slice(1).toLowerCase();
    const isGif = ext === 'gif';
    const output = defaultOutput(p.input, '去黑边', isGif ? 'gif' : videoExt(p.input));
    const srcW = num(p.srcW, 0);
    const srcH = num(p.srcH, 0);
    const D = num(p.totalDuration, 0);

    return {
      output,
      async run(taskId, onProgress) {
        const samplePoints = D > 2 && !isGif
          ? [D * 0.15, D * 0.5, D * 0.8]
          : [0];
        let minX = Infinity, minY = Infinity, maxR = 0, maxB = 0;

        for (let i = 0; i < samplePoints.length; i++) {
          const t = samplePoints[i];
          const args = t > 0
            ? ['-ss', t.toFixed(2), '-i', p.input, '-frames:v', '4', '-vf', 'cropdetect=24:2:0', '-f', 'null', '-']
            : ['-i', p.input, '-frames:v', '8', '-vf', 'cropdetect=24:2:0', '-f', 'null', '-'];
          const stderr = await runFfmpegCapture(taskId, args);
          const matches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
          for (const m of matches) {
            const cw = parseInt(m[1], 10);
            const ch = parseInt(m[2], 10);
            const cx = parseInt(m[3], 10);
            const cy = parseInt(m[4], 10);
            if (cw >= 16 && ch >= 16) {
              minX = Math.min(minX, cx);
              minY = Math.min(minY, cy);
              maxR = Math.max(maxR, cx + cw);
              maxB = Math.max(maxB, cy + ch);
            }
          }
          onProgress?.(0.15 * ((i + 1) / samplePoints.length));
        }

        let cropFilter = null;
        if (Number.isFinite(minX) && maxR > minX && maxB > minY) {
          const cw = even(maxR - minX);
          const ch = even(maxB - minY);
          const cx = even(minX);
          const cy = even(minY);
          if (cw >= 16 && ch >= 16 && (!srcW || cw < srcW - 2 || ch < srcH - 2)) {
            cropFilter = `crop=${cw}:${ch}:${cx}:${cy}`;
          }
        }

        if (!cropFilter) {
          // 画面本身无黑边时直接无损复制（或转出），避免在批量队列报错中断
          if (isGif) {
            fs.copyFileSync(p.input, output);
          } else {
            await runFfmpeg(taskId, ['-i', p.input, '-c', 'copy', output], {
              totalDuration: D, from: 0.15, to: 1, onProgress,
            });
          }
          onProgress?.(1);
          return { output };
        }

        if (isGif) {
          const plan = gifPlan({ input: p.input, output, colors: 256, totalDuration: D, vf: cropFilter });
          try {
            for (const step of plan.steps) {
              await runFfmpeg(taskId, step.args, {
                totalDuration: step.totalDuration,
                from: 0.15 + 0.85 * (step.from || 0),
                to: 0.15 + 0.85 * (step.to || 1),
                onProgress,
              });
            }
          } finally {
            for (const f of plan.cleanup || []) fs.unlink(f, () => {});
          }
        } else {
          await runFfmpeg(taskId, ['-i', p.input, '-vf', cropFilter, ...videoCodecArgs(p), '-c:a', 'copy', output], {
            totalDuration: D, from: 0.15, to: 1, onProgress,
          });
        }
        onProgress?.(1);
        return { output };
      },
    };
  },

  // 分屏对比 / 画中画
  pipSplit(p) {
    const second = p.second;
    if (!second) throw new Error('请先选择第二个对比/画中画文件');
    const mode = ['hstack', 'vstack', 'pip'].includes(p.mode) ? p.mode : 'hstack';
    const output = defaultOutput(p.input, mode === 'pip' ? '画中画' : '分屏', 'mp4');
    const srcW = even(Math.max(num(p.srcW, 1280), 64));
    const srcH = even(Math.max(num(p.srcH, 720), 64));

    let fc;
    if (mode === 'hstack') {
      const targetH = even(Math.min(srcH, 1080));
      fc = `[0:v]scale=-2:${targetH},setsar=1[v0];[1:v]scale=-2:${targetH},setsar=1[v1];[v0][v1]hstack=inputs=2:shortest=1,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[v]`;
    } else if (mode === 'vstack') {
      const targetW = even(Math.min(srcW, 1920));
      fc = `[0:v]scale=${targetW}:-2,setsar=1[v0];[1:v]scale=${targetW}:-2,setsar=1[v1];[v0][v1]vstack=inputs=2:shortest=1,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[v]`;
    } else {
      const ratio = Math.min(Math.max(num(p.pipScale, 0.25), 0.12), 0.5);
      const pipW = even(Math.max(64, srcW * ratio));
      const posMap = {
        br: 'W-w-24:H-h-24', bl: '24:H-h-24', tr: 'W-w-24:24', tl: '24:24',
      };
      const overlayPos = posMap[p.pipPos] || 'W-w-24:H-h-24';
      fc = `[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[base];[1:v]scale=${pipW}:-2,setsar=1[sub];[base][sub]overlay=${overlayPos}:shortest=1,format=yuv420p[v]`;
    }

    const args = ['-i', p.input, '-i', second];
    const audioMode = p.audioMode || 'first';
    let mapAudio = null;
    if (audioMode === 'mix' && p.hasAudio && p.secondHasAudio) {
      fc += ';[0:a][1:a]amix=inputs=2:duration=shortest:dropout_transition=2[a]';
      mapAudio = '[a]';
    } else if (audioMode === 'second' && p.secondHasAudio) {
      mapAudio = '1:a';
    } else if (audioMode !== 'mute' && p.hasAudio) {
      mapAudio = '0:a';
    } else if (audioMode !== 'mute' && p.secondHasAudio) {
      mapAudio = '1:a';
    }

    args.push('-filter_complex', fc, '-map', '[v]');
    if (mapAudio) args.push('-map', mapAudio, '-c:a', 'aac', '-b:a', '128k');
    args.push(...videoCodecArgs(p), '-movflags', '+faststart', output);

    return {
      output,
      steps: [{ args, totalDuration: num(p.totalDuration, 0) }],
    };
  },

  // 绿幕 / 纯色抠像透明 GIF
  chromaGif(p) {
    const output = defaultOutput(p.input, '透明', 'gif');
    const rawColor = String(p.color || '#00ff00').trim();
    const color = '0x' + rawColor.replace(/^#|^0x/i, '').slice(0, 6).padStart(6, '0');
    const sim = Math.min(Math.max(num(p.similarity, 0.2), 0.01), 0.6).toFixed(2);
    const blend = Math.min(Math.max(num(p.blend, 0.08), 0), 0.4).toFixed(2);
    const fps = Math.min(Math.max(num(p.fps, 12), 4), 25);
    const width = even(Math.min(Math.max(num(p.width, 480), 64), 1080));
    const vf = `fps=${fps},${scaleFilter(width)},format=rgba,colorkey=${color}:${sim}:${blend}`;

    return gifPlan({
      input: p.input, output, colors: 128,
      dither: 'bayer:bayer_scale=5',
      statsMode: 'full',
      diffMode: 'none',
      reserveTransparent: true,
      totalDuration: num(p.totalDuration, 0),
      vf,
    });
  },

  // 动图/视频进度条与圆角装饰
  decorateMedia(p) {
    const ext = path.extname(p.input).slice(1).toLowerCase();
    const isGif = ext === 'gif';
    const W = even(Math.max(num(p.srcW, 480), 32));
    const H = even(Math.max(num(p.srcH, 270), 32));
    const D = Math.max(num(p.totalDuration, 0), 0.1);
    const progressBar = ['top', 'bottom'].includes(p.progressBar) ? p.progressBar : 'none';
    const rounded = Math.min(Math.max(Math.round(num(p.rounded, 0)), 0), Math.floor(Math.min(W, H) / 2));
    if (progressBar === 'none' && rounded === 0) {
      throw new Error('请至少开启“进度条”或“圆角边框”之一');
    }

    const barH = Math.min(Math.max(Math.round(num(p.barHeight, 6)), 2), Math.floor(H / 4));
    const barColor = '0x' + String(p.barColor || '#22d3ee').replace(/^#|^0x/i, '').slice(0, 6).padStart(6, '0');
    const bgHex = '0x' + String(p.bgColor || '#000000').replace(/^#|^0x/i, '').slice(0, 6).padStart(6, '0');

    const extraInputs = [];
    const cleanup = [];
    let chain = '[0:v]format=rgba[v0]';
    let lastLabel = 'v0';

    if (progressBar !== 'none') {
      const barY = progressBar === 'top' ? 0 : H - barH;
      const idx = 1 + extraInputs.filter((a) => a === '-i').length;
      extraInputs.push('-f', 'lavfi', '-i', `color=c=${barColor}:s=${W}x${barH}:r=30`);
      chain += `;[${lastLabel}][${idx}:v]overlay=x='-W+(W*t/${D.toFixed(3)})':y=${barY}:shortest=1[vbar]`;
      lastLabel = 'vbar';
    }

    if (rounded > 0) {
      const maskFile = path.join(os.tmpdir(), `vgt_mask_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.pgm`);
      writeRoundedMaskPgm(maskFile, W, H, rounded);
      cleanup.push(maskFile);
      const maskIdx = 1 + extraInputs.filter((a) => a === '-i').length;
      extraInputs.push('-loop', '1', '-i', maskFile);
      chain += `;[${maskIdx}:v]format=gray[msk];[${lastLabel}][msk]alphamerge=shortest=1[vmask]`;
      lastLabel = 'vmask';
    }

    if (isGif) {
      const output = defaultOutput(p.input, '装饰', 'gif');
      const fc = `${chain};[${lastLabel}]copy[x]`;
      const plan = gifPlan({
        input: p.input, output, extraInputs, fc,
        colors: 256, diffMode: rounded > 0 ? 'none' : 'rectangle',
        reserveTransparent: rounded > 0, totalDuration: D,
      });
      plan.cleanup = [...(plan.cleanup || []), ...cleanup];
      return plan;
    }

    const output = defaultOutput(p.input, '装饰', videoExt(p.input));
    if (rounded > 0) {
      const bgIdx = 1 + extraInputs.filter((a) => a === '-i').length;
      extraInputs.push('-f', 'lavfi', '-i', `color=c=${bgHex}:s=${W}x${H}:r=30`);
      chain += `;[${bgIdx}:v][${lastLabel}]overlay=0:0:shortest=1,format=yuv420p[vout]`;
    } else {
      chain += `;[${lastLabel}]format=yuv420p[vout]`;
    }

    return {
      output,
      cleanup,
      steps: [{
        args: ['-i', p.input, ...extraInputs, '-filter_complex', chain, '-map', '[vout]', '-map', '0:a?', ...videoCodecArgs(p), '-c:a', 'copy', output],
        totalDuration: D,
      }],
    };
  },

  // 硬字幕压制 & 内嵌字幕提取
  subtitleTool(p) {
    if (p.mode === 'extract') {
      if (p.hasSubtitles === false) throw new Error('该视频没有内嵌字幕流，无法提取');
      const output = defaultOutput(p.input, '字幕', 'srt');
      const streamIdx = Math.max(0, Math.round(num(p.subIndex, 0)));
      return {
        output,
        steps: [{
          args: ['-i', p.input, '-map', `0:s:${streamIdx}`, output],
          totalDuration: num(p.totalDuration, 0),
        }],
      };
    }

    const sub = p.subtitle;
    if (!sub) throw new Error('请先选择外挂字幕文件 (.srt / .ass / .vtt)');
    const subExt = path.extname(sub).toLowerCase() || '.srt';
    const tmpSub = path.join(os.tmpdir(), `vgt_sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${subExt}`);
    fs.copyFileSync(sub, tmpSub);
    const subArg = tmpSub.replace(/\\/g, '/').replace(/:/g, '\\:');

    const fontSize = Math.min(Math.max(Math.round(num(p.fontSize, 22)), 10), 72);
    const marginV = Math.min(Math.max(Math.round(num(p.marginV, 24)), 4), 200);
    const vf = subExt === '.ass'
      ? `ass='${subArg}'`
      : `subtitles='${subArg}':force_style='FontName=Microsoft YaHei,FontSize=${fontSize},MarginV=${marginV}'`;

    const output = defaultOutput(p.input, '字幕', videoExt(p.input));
    return {
      output,
      cleanup: [tmpSub],
      steps: [{
        args: ['-i', p.input, '-vf', vf, ...videoCodecArgs(p), '-c:a', 'copy', output],
        totalDuration: num(p.totalDuration, 0),
      }],
    };
  },

  // 画面调色与防抖（亮度/对比度/饱和度/锐化/防抖）
  colorStab(p) {
    const brightness = Math.min(Math.max(num(p.brightness, 0), -0.5), 0.5);
    const contrast = Math.min(Math.max(num(p.contrast, 1), 0.5), 2);
    const saturation = Math.min(Math.max(num(p.saturation, 1), 0), 3);
    const vfParts = [];
    if (p.stabilize === 'deshake') vfParts.push('deshake');
    if (brightness !== 0 || contrast !== 1 || saturation !== 1) {
      vfParts.push(`eq=brightness=${brightness.toFixed(2)}:contrast=${contrast.toFixed(2)}:saturation=${saturation.toFixed(2)}`);
    }
    if (p.sharpen === 'light') vfParts.push('unsharp=5:5:0.6:5:5:0.0');
    else if (p.sharpen === 'strong') vfParts.push('unsharp=5:5:1.2:5:5:0.0');

    if (!vfParts.length) throw new Error('请至少调整一项画面参数或开启防抖');
    const vf = vfParts.join(',');
    const ext = path.extname(p.input).slice(1).toLowerCase();
    const D = num(p.totalDuration, 0);

    if (ext === 'gif') {
      return gifPlan({ input: p.input, output: defaultOutput(p.input, '调色', 'gif'), colors: 256, totalDuration: D, vf });
    }
    const output = defaultOutput(p.input, '调色', videoExt(p.input));
    return {
      output,
      steps: [{
        args: ['-i', p.input, '-vf', vf, ...videoCodecArgs(p), '-c:a', 'copy', output],
        totalDuration: D,
      }],
    };
  },

  // 视频缩略图预览墙（九宫格 / 雪碧图）
  contactSheet(p) {
    const D = num(p.totalDuration, 0);
    if (D <= 0) throw new Error('无法读取视频时长');
    const [cols, rows] = (p.layout || '3x3').split('x').map((n) => Math.min(Math.max(parseInt(n, 10) || 3, 2), 6));
    const totalTiles = cols * rows;
    const cellW = even(Math.min(Math.max(num(p.cellWidth, 400), 160), 960));
    const fmt = p.format === 'png' ? 'png' : 'jpg';
    const output = defaultOutput(p.input, `预览墙_${cols}x${rows}`, fmt);

    const sampleFps = (totalTiles / Math.max(D, 0.2)).toFixed(5);
    const vfParts = [`fps=${sampleFps}`, `scale=${cellW}:-2:flags=lanczos`];
    if (p.timestamps !== 'no') {
      vfParts.push(`drawtext=fontfile='${FONT}':text='%{pts\\:hms}':x=10:y=h-th-10:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=4`);
    }
    vfParts.push(`tile=${cols}x${rows}:padding=8:margin=8:color=0x111318`);

    const args = ['-i', p.input, '-vf', vfParts.join(','), '-frames:v', '1'];
    if (fmt === 'jpg') args.push('-q:v', '2');
    args.push(output);

    return {
      output,
      steps: [{ args, totalDuration: D }],
    };
  },

  // 清除隐私元数据（无损剥离 EXIF / GPS / 设备型号）
  stripMeta(p) {
    const ext = path.extname(p.input).slice(1).toLowerCase();
    const isGifOrImg = ext === 'gif' || ['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext);
    const outExt = isGifOrImg ? ext : (['mp3', 'm4a', 'wav', 'flac'].includes(ext) ? ext : videoExt(p.input));
    const output = defaultOutput(p.input, '去元数据', outExt);
    const args = isGifOrImg
      ? ['-i', p.input, '-map_metadata', '-1', output]
      : ['-i', p.input, '-map', '0', '-c', 'copy', '-map_metadata', '-1', '-fflags', '+bitexact', output];

    return {
      output,
      steps: [{ args, totalDuration: num(p.totalDuration, 0) }],
    };
  },
};

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

// 运行 ffmpeg 并捕获 stderr（用于 cropdetect 等探测类命令）
function runFfmpegCapture(taskId, argsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-y', ...argsList], { windowsHide: true });
    runningTasks.set(taskId, child);
    let stderr = '';
    let cancelled = false;
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-16000); });
    runningTasks.get(taskId).__cancel = () => { cancelled = true; };
    child.on('error', (err) => { runningTasks.delete(taskId); reject(err); });
    child.on('close', (code) => {
      runningTasks.delete(taskId);
      if (cancelled) return reject(new Error('任务已取消'));
      if (code === 0) return resolve(stderr);
      const lines = stderr.split('\n').filter((l) => l.trim()).slice(-3).join('\n');
      reject(new Error(`ffmpeg 失败（退出码 ${code}）：\n${lines || '未知错误'}`));
    });
  });
}

// 执行一个任务：构建命令 → （动态计划或静态步骤）→ 清理临时文件
async function executeTask(taskId, feature, params, onProgress) {
  assertBinaries();
  const builder = builders[feature];
  if (!builder) throw new Error(`未知功能：${feature}`);

  if (params?.__hwAccel === 'auto' && !_hwCache) {
    await detectHwEncoders().catch(() => {});
  }

  _outCtx = params?.__outputMode ? { mode: params.__outputMode, dir: params.__outputDir } : null;
  let plan;
  try {
    plan = builder(params);
  } finally {
    _outCtx = null;
  }

  if (plan.run) {
    const result = await plan.run(taskId, onProgress);
    return result || { output: plan.output };
  }

  try {
    for (const step of plan.steps) {
      await runFfmpeg(taskId, step.args, { ...step, onProgress });
    }
  } finally {
    for (const f of plan.cleanup || []) {
      fs.unlink(f, () => {});
    }
    for (const d of plan.cleanupDirs || []) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
  return { output: plan.output, outputType: plan.outputType };
}

module.exports = { probe, executeTask, cancelTask, detectHwEncoders, FFMPEG };
