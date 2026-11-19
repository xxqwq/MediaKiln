'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const {
  FONT,
  IMG_EXTS,
  AUDIO_EXTS,
  isImagePath,
  num,
  even,
  atempoChain,
  scaleFilter,
  videoExt,
  imageExt,
  imageCodecArgs,
  writeConcatList,
  gifPlan,
  writeRoundedMaskPgm,
} = require('../core/utils');
const {
  probe,
  runFfmpeg,
  runFfmpegCapture,
  commitOutput,
  copyTaskOutput,
  videoCodecArgs,
  defaultOutput,
  defaultDirOutput,
  stampOutput,
} = require('../core/runner');

function audioCodecArgs(format, bitrate = '192k') {
  return ({
    mp3: ['-c:a', 'libmp3lame', '-b:a', bitrate],
    m4a: ['-c:a', 'aac', '-b:a', bitrate],
    aac: ['-c:a', 'aac', '-b:a', bitrate],
    wav: ['-c:a', 'pcm_s16le'],
    flac: ['-c:a', 'flac'],
    ogg: ['-c:a', 'libvorbis', '-b:a', bitrate],
    opus: ['-c:a', 'libopus', '-b:a', bitrate],
  }[format] || ['-c:a', 'libmp3lame', '-b:a', bitrate]);
}

function resolveVideoCodecArgs(p, { crf = 23, preset = 'medium', codec = 'h264' } = {}) {
  const raw = videoCodecArgs(p, { crf, preset, codec });
  if (codec === 'hevc') {
    let out;
    if (raw.includes('libx264')) {
      out = ['-c:v', 'libx265', '-crf', String(crf), '-preset', preset, '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1'];
    } else if (raw.includes('h264_nvenc')) {
      out = raw.map((a) => (a === 'h264_nvenc' ? 'hevc_nvenc' : a));
    } else if (raw.includes('h264_qsv')) {
      out = raw.map((a) => (a === 'h264_qsv' ? 'hevc_qsv' : a));
    } else if (raw.includes('h264_amf')) {
      out = raw.map((a) => (a === 'h264_amf' ? 'hevc_amf' : a));
    } else {
      out = [...raw];
    }
    if (!out.includes('-tag:v')) out.push('-tag:v', 'hvc1');
    return out;
  }
  if (codec === 'av1') {
    const isH264Fallback = raw.includes('libx264')
      || raw.includes('h264_nvenc')
      || raw.includes('h264_qsv')
      || raw.includes('h264_amf');
    if (isH264Fallback) {
      return ['-c:v', 'libaom-av1', '-crf', String(crf + 10), '-b:v', '0', '-cpu-used', '6', '-row-mt', '1', '-pix_fmt', 'yuv420p'];
    }
    return [...raw];
  }
  return raw;
}

const builders = {
  // ============================ 转换 ============================

  // 1. 视频 → GIF（palettegen 两遍编码，画质最佳）
  videoToGif(p) {
    const output = defaultOutput(p.input, 'gif', 'gif');
    const fps = Math.min(Math.max(num(p.fps, 15), 5), 50);
    const width = Math.min(Math.max(num(p.width, 480), 64), 1920);
    const colors = Math.min(Math.max(num(p.colors, 128), 16), 256);
    const start = Math.max(num(p.start, 0), 0);
    const dur = num(p.duration, 0);
    const total = dur > 0 ? dur : num(p.totalDuration, 0);
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
        '-movflags', '+faststart',
      );
    } else {
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
    const fps = Math.min(Math.max(num(p.fps, 15), 5), 60);
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

  // 4. 视频格式转换（支持重编码 & 无损秒转封装，支持 H.264 / HEVC / AV1）
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

    const vcodec = ['h264', 'hevc', 'av1'].includes(p.vcodec) ? p.vcodec : 'h264';
    if (format === 'mov' && vcodec === 'av1') {
      throw new Error('MOV 容器不支持 AV1 编码，请选 MP4 / MKV / WebM 或切换 H.265');
    }
    const output = defaultOutput(p.input, format, format);
    const res = num(p.height, 0);
    const crf = { high: 18, medium: 23, low: 28 }[p.quality] || 23;
    const vf = res > 0 ? `scale=-2:${res}` : null;
    const args = ['-i', p.input];
    if (vf) args.push('-vf', vf);
    if (format === 'webm') {
      if (vcodec === 'av1') {
        args.push('-c:v', 'libaom-av1', '-crf', String(crf + 10), '-b:v', '0', '-cpu-used', '6', '-row-mt', '1',
          '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '128k');
      } else {
        args.push('-c:v', 'libvpx-vp9', '-crf', String(crf + 8), '-b:v', '0', '-row-mt', '1',
          '-c:a', 'libopus', '-b:a', '128k');
      }
    } else {
      args.push(...resolveVideoCodecArgs(p, { crf, preset: 'medium', codec: vcodec }), '-c:a', 'aac', '-b:a', '128k');
      if (format === 'mp4' || format === 'mov') args.push('-movflags', '+faststart');
    }
    return {
      output,
      steps: [{ args: [...args, output], totalDuration: num(p.totalDuration, 0) }],
    };
  },

  // ============================ GIF 编辑 ============================

  // 3. GIF 压缩
  compressGif(p) {
    const output = defaultOutput(p.input, 'compressed', 'gif');
    const srcFps = num(p.srcFps, 0);
    const srcW = num(p.srcW, 0);

    let fps;
    if (p.fps === 'p50') {
      fps = Math.min(50, Math.max(1, Math.round(((srcFps > 0 ? srcFps : 12) * 0.5) * 10) / 10));
    } else if (p.fps === 'custom') {
      fps = Math.min(Math.max(num(p.customFps, 10), 1), 50);
    } else {
      fps = Math.min(Math.max(num(p.fps, 12), 1), 50);
      if (srcFps > 0) fps = Math.min(fps, Math.min(srcFps, 50));
    }

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

    const start = Math.max(num(p.start, 0), 0);
    const dur = num(p.duration, 0);
    const seg = dur > 0 ? ['-ss', String(start), '-t', String(dur)] : (start > 0 ? ['-ss', String(start)] : []);
    const baseDur = dur > 0 ? dur : num(p.totalDuration, 0);
    const totalDuration = baseDur / speed;

    const vfParts = [];
    if (speed !== 1) vfParts.push(`setpts=PTS/${speed}`);
    vfParts.push(`fps=${fps}`, scaleFilter(width));
    if (p.denoise === 'light') vfParts.push('hqdn3d=2:1.5:3:2');
    else if (p.denoise === 'strong') vfParts.push('hqdn3d=4:3:6:4');
    if (p.dedup === 'yes') vfParts.push('mpdecimate');
    const vf = vfParts.join(',');

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

  // GIF 截取（支持按时间段与按帧序号截取，保留透明通道与两遍调色板）
  trimGif(p) {
    const output = defaultOutput(p.input, 'clip', 'gif');
    const colors = Math.min(Math.max(num(p.colors, 256), 16), 256);
    const fps = num(p.fps, 0);
    const loop = p.loop !== undefined ? parseInt(p.loop, 10) : 0;
    const totalDuration = num(p.totalDuration, 0);
    const vfParts = [];
    let estDuration = 0;

    if (p.mode === 'frames') {
      const nbFrames = Math.max(0, Math.round(num(p.nbFrames, 0)));
      const startFrame = Math.max(1, Math.round(num(p.startFrame, 1)));
      let endFrame = Math.max(1, Math.round(num(p.endFrame, startFrame)));
      if (nbFrames > 0 && startFrame > nbFrames) {
        throw new Error(`起始帧 (${startFrame}) 不能超过 GIF 总帧数 (${nbFrames})`);
      }
      if (nbFrames > 0) endFrame = Math.min(endFrame, nbFrames);
      if (endFrame < startFrame) {
        throw new Error('结束帧不能小于起始帧');
      }
      vfParts.push(`trim=start_frame=${startFrame - 1}:end_frame=${endFrame}`, 'setpts=PTS-STARTPTS');
      const srcFps = num(p.srcFps, 0) || 12;
      estDuration = (endFrame - startFrame + 1) / srcFps;
    } else {
      const start = Math.max(num(p.start, 0), 0);
      const dur = num(p.duration, 0);
      if (dur <= 0) throw new Error('截取时长必须大于 0');
      if (totalDuration > 0 && start >= totalDuration) {
        throw new Error('开始时间不能大于或等于 GIF 总时长');
      }
      const actualDur = totalDuration > 0 ? Math.min(dur, totalDuration - start) : dur;
      vfParts.push(`trim=start=${start}:duration=${dur}`, 'setpts=PTS-STARTPTS');
      estDuration = actualDur;
    }

    if (fps > 0) {
      vfParts.push(`fps=${Math.min(Math.max(fps, 1), 50)}`);
    }

    return gifPlan({
      input: p.input,
      output,
      colors,
      dither: 'bayer:bayer_scale=5',
      statsMode: 'diff',
      diffMode: 'rectangle',
      reserveTransparent: true,
      loop: Number.isFinite(loop) ? loop : 0,
      totalDuration: estDuration,
      vf: vfParts.join(','),
    });
  },

  // GIF 加文字
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
      const duration = num(p.totalDuration, 0);
      if (duration <= 0) throw new Error('无法读取视频时长');
      const output = defaultOutput(p.input, `${targetMB}MB`, 'mp4');
      const audioKbps = p.hasAudio ? 128 : 0;
      const totalKbps = (targetMB * 8192) / duration * 0.95;
      const videoKbps = Math.max(64, Math.round(totalKbps - audioKbps));
      const args = ['-i', p.input];
      if (p.vcodec === 'hevc') {
        const probeArgs = resolveVideoCodecArgs(p, { crf: 23, preset: 'medium', codec: 'hevc' });
        const encIdx = probeArgs.indexOf('-c:v');
        const enc = encIdx >= 0 ? probeArgs[encIdx + 1] : 'libx265';
        const brArgs = [
          '-b:v', `${videoKbps}k`,
          '-maxrate', `${Math.round(videoKbps * 1.5)}k`,
          '-bufsize', `${videoKbps * 2}k`,
          '-pix_fmt', 'yuv420p',
          '-tag:v', 'hvc1',
        ];
        if (enc === 'hevc_nvenc') {
          args.push('-c:v', 'hevc_nvenc', '-preset', 'p4', ...brArgs);
        } else if (enc === 'hevc_qsv') {
          args.push('-c:v', 'hevc_qsv', '-preset', 'medium', ...brArgs);
        } else if (enc === 'hevc_amf') {
          args.push('-c:v', 'hevc_amf', '-quality', 'balanced', '-rc', 'vbr_peak', ...brArgs);
        } else {
          args.push('-c:v', 'libx265', '-preset', 'medium', ...brArgs);
        }
      } else {
        args.push(
          '-c:v', 'libx264', '-b:v', `${videoKbps}k`, '-maxrate', `${Math.round(videoKbps * 1.5)}k`,
          '-bufsize', `${videoKbps * 2}k`, '-preset', 'medium', '-pix_fmt', 'yuv420p',
        );
      }
      if (p.hasAudio) args.push('-c:a', 'aac', '-b:a', '128k');
      args.push('-movflags', '+faststart', output);
      return {
        output,
        steps: [{ args, totalDuration: duration }],
      };
    }

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
              copyTaskOutput(tmpOut, output);
              onProgress?.(1);
              return { output, targetReached: true, targetMB };
            }
          }
          if (bestFile) copyTaskOutput(bestFile, output);
          onProgress?.(1);
          return { output, targetReached: bestSize <= targetBytes, targetMB };
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      },
    };
  },

  // ============================ 剪辑 ============================

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

  mergeVideos(p) {
    const files = p.files || [];
    if (files.length < 2) throw new Error('请至少选择 2 个文件');

    if (p.mode === 'xfade') {
      const output = stampOutput(files[0], '转场合并', 'mp4');
      const allowedTrans = ['fade', 'fadeblack', 'fadewhite', 'slideleft', 'slideright', 'wiperight', 'circleopen', 'dissolve'];
      const transition = allowedTrans.includes(p.transition) ? p.transition : 'fade';
      const reqDur = Math.min(Math.max(num(p.transDur, 0.8), 0.15), 3);

      const buildXfadeArgs = (infos, outTarget) => {
        const durs = infos.map((i) => num(i?.duration, 0));
        const minDur = Math.min(...durs);
        if (minDur < 0.25) {
          throw new Error('转场拼接要求每个视频片段时长不少于 0.25 秒');
        }
        const T = Math.min(reqDur, Math.max(0.12, minDur * 0.4));
        const W = even(Math.max(num(infos[0]?.width, 1280), 320));
        const H = even(Math.max(num(infos[0]?.height, 720), 240));
        const anyAudio = infos.some((i) => i?.hasAudio);

        const inputArgs = [];
        const fcParts = [];
        files.forEach((f, idx) => {
          inputArgs.push('-i', f);
          fcParts.push(`[${idx}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30,settb=AVTB,format=yuv420p[v${idx}]`);
          if (anyAudio) {
            if (infos[idx]?.hasAudio) {
              fcParts.push(`[${idx}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${idx}]`);
            } else {
              fcParts.push(`anullsrc=r=44100:cl=stereo:d=${durs[idx].toFixed(3)}[a${idx}]`);
            }
          }
        });

        let prevV = 'v0';
        let cumDur = durs[0];
        for (let idx = 1; idx < files.length; idx++) {
          const offset = Math.max(0, cumDur - T);
          const outV = idx === files.length - 1 ? 'v' : `vx${idx}`;
          fcParts.push(`[${prevV}][v${idx}]xfade=transition=${transition}:duration=${T.toFixed(3)}:offset=${offset.toFixed(3)}[${outV}]`);
          prevV = outV;
          cumDur = offset + durs[idx];
        }

        if (anyAudio) {
          let prevA = 'a0';
          for (let idx = 1; idx < files.length; idx++) {
            const outA = idx === files.length - 1 ? 'a' : `ax${idx}`;
            fcParts.push(`[${prevA}][a${idx}]acrossfade=d=${T.toFixed(3)}:c1=tri:c2=tri[${outA}]`);
            prevA = outA;
          }
        }

        const args = [...inputArgs, '-filter_complex', fcParts.join(';'), '-map', '[v]'];
        if (anyAudio) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '128k');
        args.push(...videoCodecArgs(p), '-movflags', '+faststart', outTarget);
        return { args, totalDuration: cumDur };
      };

      const provided = p.infos || [];
      const hasAllDurs = files.every((_, idx) => num(provided[idx]?.duration, 0) > 0);
      if (hasAllDurs) {
        const { args, totalDuration } = buildXfadeArgs(provided, output);
        return { output, steps: [{ args, totalDuration }] };
      }

      return {
        output,
        async run(taskId, onProgress) {
          const resolvedInfos = await Promise.all(files.map(async (f, idx) => {
            if (num(provided[idx]?.duration, 0) > 0) return provided[idx];
            return probe(f);
          }));
          const ext = path.extname(output);
          const tmpOut = `${output.slice(0, output.length - ext.length)}.tmp-${crypto.randomBytes(4).toString('hex')}${ext}`;
          const { args, totalDuration } = buildXfadeArgs(resolvedInfos, tmpOut);
          try {
            await runFfmpeg(taskId, args, { totalDuration, onProgress });
            commitOutput(tmpOut, output);
            return { output };
          } finally {
            await fs.promises.rm(tmpOut, { force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
          }
        },
      };
    }

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
        totalDuration: 0,
      }],
    };
  },

  // 画面裁剪（支持视频 / GIF / 静态图片）
  videoCrop(p) {
    const { w, h, x, y } = p.crop || {};
    if (!w || !h || w < 16 || h < 16) throw new Error('请先在画面上拉出裁剪区域');
    const ext = path.extname(p.input).slice(1).toLowerCase();

    if (isImagePath(p.input)) {
      const srcW = Math.max(Math.round(num(p.srcW, w)), 16);
      const srcH = Math.max(Math.round(num(p.srcH, h)), 16);
      const cw = Math.max(2, Math.min(Math.round(w), srcW));
      const ch = Math.max(2, Math.min(Math.round(h), srcH));
      const cx = Math.max(0, Math.min(Math.round(x), srcW - cw));
      const cy = Math.max(0, Math.min(Math.round(y), srcH - ch));
      const imgFmt = imageExt(p.input);
      const output = defaultOutput(p.input, 'crop', imgFmt);
      return {
        output,
        steps: [{
          args: ['-i', p.input, '-vf', `crop=${cw}:${ch}:${cx}:${cy}`, ...imageCodecArgs(imgFmt, { quality: 'high' }), output],
          totalDuration: 0,
        }],
      };
    }

    const cw = even(w), ch = even(h);
    const cx = even(Math.min(x, num(p.srcW, cw) - cw)), cy = even(Math.min(y, num(p.srcH, ch) - ch));
    const crop = `crop=${cw}:${ch}:${cx}:${cy}`;
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

  // 局部打码 / 模糊 / 去台标（支持视频 / GIF / 静态图片）
  videoBlur(p) {
    const { w, h, x, y } = p.crop || {};
    if (!w || !h || w < 16 || h < 16) throw new Error('请先在画面上拖出要处理的区域');
    const isImg = isImagePath(p.input);
    const align = isImg ? (n) => Math.max(2, Math.round(n)) : even;
    const srcW = Math.max(num(p.srcW, w), 16);
    const srcH = Math.max(num(p.srcH, h), 16);

    if (p.mode === 'delogo') {
      const x1 = Math.min(srcW - 1, Math.max(3, Math.round(x + w)));
      const y1 = Math.min(srcH - 1, Math.max(3, Math.round(y + h)));
      const dx = Math.max(1, Math.min(Math.round(x), x1 - 2));
      const dy = Math.max(1, Math.min(Math.round(y), y1 - 2));
      const dw = x1 - dx;
      const dh = y1 - dy;
      const delogo = `delogo=x=${dx}:y=${dy}:w=${dw}:h=${dh}`;
      if (isImg) {
        const imgFmt = imageExt(p.input);
        const output = defaultOutput(p.input, 'delogo', imgFmt);
        const vf = (imgFmt === 'png' || imgFmt === 'webp' || imgFmt === 'avif') ? `format=rgba,${delogo}` : delogo;
        return {
          output,
          steps: [{
            args: ['-i', p.input, '-vf', vf, ...imageCodecArgs(imgFmt, { quality: 'high' }), output],
            totalDuration: 0,
          }],
        };
      }
      const ext = path.extname(p.input).slice(1).toLowerCase();
      const total = num(p.totalDuration, 0);
      if (ext === 'gif') {
        return gifPlan({
          input: p.input, output: defaultOutput(p.input, 'delogo', 'gif'),
          colors: 256, totalDuration: total, vf: `format=rgba,${delogo}`,
        });
      }
      const output = defaultOutput(p.input, 'delogo', videoExt(p.input));
      return {
        output,
        steps: [{
          args: ['-i', p.input, '-vf', delogo, ...videoCodecArgs(p), '-c:a', 'copy', output],
          totalDuration: total,
        }],
      };
    }

    const cw = align(Math.min(Math.max(16, w), srcW));
    const ch = align(Math.min(Math.max(16, h), srcH));
    const cx = Math.max(0, Math.min(isImg ? Math.round(x) : even(x), srcW - cw));
    const cy = Math.max(0, Math.min(isImg ? Math.round(y) : even(y), srcH - ch));

    const strong = p.strength === 'strong';
    let effect;
    if (p.mode === 'mosaic') {
      const block = strong ? 24 : 14;
      const mw = Math.max(2, align(Math.round(cw / block)));
      const mh = Math.max(2, align(Math.round(ch / block)));
      effect = `scale=${mw}:${mh}:flags=area,scale=${cw}:${ch}:flags=neighbor`;
    } else {
      const maxR = Math.max(2, Math.floor(Math.min(cw, ch) / 4));
      const r = Math.min(strong ? 24 : 12, maxR);
      const cr = Math.max(1, Math.min(Math.floor(r / 2), maxR));
      effect = `boxblur=lr=${r}:lp=2:cr=${cr}:cp=2`;
    }

    if (isImg) {
      const imgFmt = imageExt(p.input);
      const output = defaultOutput(p.input, 'blur', imgFmt);
      const fc = `[0:v]format=rgba,split[base][roi];[roi]crop=${cw}:${ch}:${cx}:${cy},${effect}[b];[base][b]overlay=${cx}:${cy}[v]`;
      return {
        output,
        steps: [{
          args: ['-i', p.input, '-filter_complex', fc, '-map', '[v]', ...imageCodecArgs(imgFmt, { quality: 'high' }), output],
          totalDuration: 0,
        }],
      };
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

  // 横竖屏比例适配（支持视频 / GIF / 静态图片）
  aspectPad(p) {
    const ext = path.extname(p.input).slice(1).toLowerCase();
    const isGif = ext === 'gif';
    const isImg = isImagePath(p.input);
    const sizes = isGif
      ? { '9:16': [480, 854], '16:9': [640, 360], '1:1': [480, 480], '4:3': [640, 480], '3:4': [480, 640] }
      : { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080], '4:3': [1440, 1080], '3:4': [1080, 1440] };
    const [W, H] = sizes[p.ratio] || sizes['9:16'];
    const bg = ['blur', 'black', 'white'].includes(p.bg) ? p.bg : 'blur';
    const total = num(p.totalDuration, 0);

    if (isImg) {
      const imgFmt = imageExt(p.input);
      const output = defaultOutput(p.input, 'ratio', imgFmt);
      if (bg !== 'blur') {
        const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${bg},setsar=1`;
        return {
          output,
          steps: [{ args: ['-i', p.input, '-vf', vf, ...imageCodecArgs(imgFmt, { quality: 'high' }), output], totalDuration: 0 }],
        };
      }
      const fc = `[0:v]format=rgba,split[bg][fg];[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=25:3[bg2];[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1[v]`;
      return {
        output,
        steps: [{ args: ['-i', p.input, '-filter_complex', fc, '-map', '[v]', ...imageCodecArgs(imgFmt, { quality: 'high' }), output], totalDuration: 0 }],
      };
    }

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

  // 添加水印（支持视频 / GIF / 静态图片，含全屏斜向平铺防盗水印）
  watermark(p) {
    const ext = path.extname(p.input).slice(1).toLowerCase();
    const isGif = ext === 'gif';
    const isImg = isImagePath(p.input);
    const total = num(p.totalDuration, 0);
    const opacity = Math.min(Math.max(num(p.opacity, 0.7), 0.1), 1);
    const size = p.size || 'medium';
    const pos = p.pos || 'br';
    const wmColorHex = ({ white: '#ffffff', yellow: '#facc15', black: '#111827', gray: '#cbd5e1' }[p.wmColor]) || '#ffffff';
    const shadowHex = p.wmColor === 'black' ? '#ffffff' : 'black';

    if (pos === 'tiled') {
      if (p.mode === 'image') {
        const wmImg = p.image;
        if (!wmImg) throw new Error('请先选择水印图片');
      } else if (!String(p.text || '').trim()) {
        throw new Error('请输入水印文字');
      }

      const degRaw = Number(p.tileAngle);
      const deg = [-45, -30, 0, 30, 45].includes(degRaw) ? degRaw : -30;
      const rad = ((deg * Math.PI) / 180).toFixed(4);
      const density = p.tileDensity || 'normal';

      const outExt = isImg ? imageExt(p.input) : (isGif ? 'gif' : videoExt(p.input));
      const output = defaultOutput(p.input, '平铺水印', outExt);

      return {
        output,
        outputType: 'file',
        async run(taskId, onProgress) {
          onProgress?.(0.05);
          let W = num(p.srcW, 0);
          let H = num(p.srcH, 0);
          let dur = total;
          if (!W || !H || (!isImg && dur <= 0)) {
            const info = await probe(p.input);
            W = info.width || W || 720;
            H = info.height || H || 720;
            if (!isImg) dur = info.duration || dur;
          }
          W = even(Math.max(W, 64));
          H = even(Math.max(H, 64));

          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_wmtile_'));
          const tilePng = path.join(tmpDir, 'wm_tiled.png');
          const outFileExt = path.extname(output);
          const tmpOut = `${output.slice(0, output.length - outFileExt.length)}.tmp-${crypto.randomBytes(4).toString('hex')}${outFileExt}`;
          fs.mkdirSync(path.dirname(output), { recursive: true });

          try {
            const span = even(Math.ceil(Math.hypot(W, H) * 1.45));
            const gap = ({ sparse: 180, normal: 110, dense: 56 }[density]) || 110;

            if (p.mode === 'image') {
              const wmRatio = { small: 0.12, medium: 0.18, large: 0.26 }[size] || 0.18;
              const wmW = even(Math.max(32, W * wmRatio));
              const wmMeta = await probe(p.image).catch(() => null);
              const wmAspect = wmMeta?.width && wmMeta?.height ? wmMeta.height / wmMeta.width : 0.6;
              const cellW = even(wmW + gap);
              const cellH = even(Math.round(wmW * wmAspect) + gap);
              const cols = Math.max(2, Math.ceil(span / cellW) + 1);
              const rows = Math.max(2, Math.ceil(span / cellH) + 1);
              const fcTile = `[0:v]scale=${wmW}:-1:flags=lanczos,format=rgba,colorchannelmixer=aa=${opacity},pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,loop=${cols * rows}:size=1:start=0,tile=${cols}x${rows},rotate=${rad}:ow=${span}:oh=${span}:fillcolor=0x00000000,crop=${W}:${H}:(${span}-${W})/2:(${span}-${H})/2,format=rgba[wm]`;
              await runFfmpeg(taskId, [
                '-i', p.image, '-filter_complex', fcTile, '-map', '[wm]',
                '-frames:v', '1', '-update', '1', tilePng,
              ], { totalDuration: 0 });
            } else {
              const text = String(p.text || '').trim();
              const textFile = path.join(tmpDir, 'wm_text.txt');
              fs.writeFileSync(textFile, text, 'utf8');
              const textFileArg = textFile.replace(/\\/g, '/').replace(/:/g, '\\:');
              const fontsize = Math.max(18, even(H / ({ small: 30, medium: 20, large: 13 }[size] || 20)));
              const textChars = Math.max(3, [...text].length);
              const cellW = even(Math.min(span, Math.max(200, Math.round(fontsize * textChars * 0.95) + gap)));
              const cellH = even(Math.min(span, Math.max(96, Math.round(fontsize * 2.2) + Math.round(gap * 0.8))));
              const cols = Math.max(2, Math.ceil(span / cellW) + 1);
              const rows = Math.max(2, Math.ceil(span / cellH) + 1);
              const drawtext = `drawtext=fontfile='${FONT}':textfile='${textFileArg}':fontsize=${fontsize}:fontcolor=${wmColorHex}@${opacity}:shadowcolor=${shadowHex}@${(opacity * 0.45).toFixed(2)}:shadowx=1:shadowy=1:x=(w-text_w)/2:y=(h-text_h)/2:expansion=none`;
              const vfTile = `${drawtext},loop=${cols * rows}:size=1:start=0,tile=${cols}x${rows},rotate=${rad}:ow=${span}:oh=${span}:fillcolor=0x00000000,crop=${W}:${H}:(${span}-${W})/2:(${span}-${H})/2,format=rgba`;
              await runFfmpeg(taskId, [
                '-f', 'lavfi', '-i', `color=c=black@0.0:s=${cellW}x${cellH}:d=1,format=rgba`,
                '-vf', vfTile, '-frames:v', '1', '-update', '1', tilePng,
              ], { totalDuration: 0 });
            }

            onProgress?.(0.2);

            if (isImg) {
              const fc = '[0:v][1:v]overlay=0:0:shortest=1[v]';
              await runFfmpeg(taskId, [
                '-i', p.input, '-i', tilePng, '-filter_complex', fc, '-map', '[v]',
                ...imageCodecArgs(outExt, { quality: 'high' }), tmpOut,
              ], { totalDuration: 0 });
            } else if (isGif) {
              const plan = gifPlan({
                input: p.input,
                output: tmpOut,
                extraInputs: ['-i', tilePng],
                fc: '[0:v][1:v]overlay=0:0:eof_action=repeat[x]',
                colors: 256,
                totalDuration: dur,
              });
              try {
                for (const step of plan.steps) {
                  await runFfmpeg(taskId, step.args, {
                    ...step,
                    from: 0.2 + step.from * 0.8,
                    to: 0.2 + step.to * 0.8,
                    onProgress,
                  });
                }
              } finally {
                for (const f of plan.cleanup || []) {
                  try { fs.unlinkSync(f); } catch {}
                }
              }
            } else {
              const fc = '[0:v][1:v]overlay=0:0:eof_action=repeat[v]';
              await runFfmpeg(taskId, [
                '-i', p.input, '-i', tilePng, '-filter_complex', fc, '-map', '[v]', '-map', '0:a?',
                ...videoCodecArgs(p), '-c:a', 'copy', tmpOut,
              ], { totalDuration: dur, from: 0.2, to: 1, onProgress });
            }

            commitOutput(tmpOut, output);
            onProgress?.(1);
            return { output, outputType: 'file' };
          } finally {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
            await fs.promises.rm(tmpOut, { force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
          }
        },
      };
    }

    if (p.mode === 'image') {
      const wmImg = p.image;
      if (!wmImg) throw new Error('请先选择水印图片');
      const srcW = Math.max(num(p.srcW, 720), 64);
      const wmRatio = { small: 0.12, medium: 0.18, large: 0.26 }[size] || 0.18;
      const wmW = even(Math.max(32, srcW * wmRatio));
      const overlayPos = {
        br: 'W-w-24:H-h-24', bl: '24:H-h-24', tr: 'W-w-24:24', tl: '24:24', center: '(W-w)/2:(H-h)/2',
      }[pos] || 'W-w-24:H-h-24';

      if (isImg) {
        const imgFmt = imageExt(p.input);
        const output = defaultOutput(p.input, 'wm', imgFmt);
        const fc = `[1:v]scale=${wmW}:-1:flags=lanczos,format=rgba,colorchannelmixer=aa=${opacity}[wm];[0:v][wm]overlay=${overlayPos}[v]`;
        return {
          output,
          steps: [{
            args: ['-i', p.input, '-i', wmImg, '-filter_complex', fc, '-map', '[v]', ...imageCodecArgs(imgFmt, { quality: 'high' }), output],
            totalDuration: 0,
          }],
        };
      }
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
    const drawtext = `drawtext=fontfile='${FONT}':textfile='${textFileArg}':fontsize=${fontsize}:fontcolor=${wmColorHex}@${opacity}:shadowcolor=${shadowHex}@${(opacity * 0.7).toFixed(2)}:shadowx=2:shadowy=2:${textPos}:expansion=none`;

    if (isImg) {
      const imgFmt = imageExt(p.input);
      const output = defaultOutput(p.input, 'wm', imgFmt);
      return {
        output,
        cleanup: [textFile],
        steps: [{
          args: ['-i', p.input, '-vf', drawtext, ...imageCodecArgs(imgFmt, { quality: 'high' }), output],
          totalDuration: 0,
        }],
      };
    }
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

  // 旋转 / 翻转（支持视频 / GIF / 静态图片）
  rotateFlip(p) {
    const vfMap = {
      r90: 'transpose=1', r270: 'transpose=2', r180: 'transpose=1,transpose=1',
      hflip: 'hflip', vflip: 'vflip',
    };
    const vf = vfMap[p.mode];
    if (!vf) throw new Error('请选择旋转方式');
    if (isImagePath(p.input)) {
      const imgFmt = imageExt(p.input);
      const output = defaultOutput(p.input, 'rot', imgFmt);
      return {
        output,
        steps: [{ args: ['-i', p.input, '-vf', vf, ...imageCodecArgs(imgFmt, { quality: 'high' }), output], totalDuration: 0 }],
      };
    }
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

  // 6. 变速
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

  extractAudio(p) {
    const allowed = ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus'];
    const format = allowed.includes(p.format) ? p.format : 'mp3';
    const output = defaultOutput(p.input, 'audio', format);
    const codecArgs = format === 'mp3'
      ? ['-c:a', 'libmp3lame', '-q:a', '2']
      : audioCodecArgs(format, p.bitrate || '192k');
    if (format === 'opus') codecArgs.push('-ar', '48000');
    return {
      output,
      steps: [{
        args: ['-i', p.input, '-vn', ...codecArgs, output],
        totalDuration: num(p.totalDuration, 0),
      }],
    };
  },

  audioConvert(p) {
    const allowed = ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus'];
    const format = allowed.includes(p.format) ? p.format : 'mp3';
    const bitrate = ['64k', '96k', '128k', '192k', '256k', '320k'].includes(p.bitrate) ? p.bitrate : '192k';
    const sr = String(p.sampleRate || '0');
    const ch = String(p.channels || '0');
    const output = defaultOutput(p.input, '转码', format);
    const args = ['-i', p.input, '-vn', ...audioCodecArgs(format, bitrate)];
    if (format === 'opus') {
      const opusSrMap = { '8000': '8000', '12000': '12000', '16000': '16000', '22050': '24000', '24000': '24000', '44100': '48000', '48000': '48000' };
      args.push('-ar', opusSrMap[sr] || '48000');
    } else if (['48000', '44100', '24000', '16000'].includes(sr)) {
      args.push('-ar', sr);
    }
    if (ch === '1' || ch === '2') args.push('-ac', ch);
    args.push(output);
    return {
      output,
      steps: [{ args, totalDuration: num(p.totalDuration, 0) }],
    };
  },

  audioTrim(p) {
    const ext = path.extname(String(p.input || '')).slice(1).toLowerCase();
    const outExt = ext === 'aac' ? 'm4a' : (AUDIO_EXTS.includes(ext) ? ext : 'mp3');
    const start = Math.max(num(p.start, 0), 0);
    const dur = num(p.duration, 0);
    if (dur <= 0) throw new Error('截取时长必须大于 0');
    const fi = Math.min(Math.max(num(p.fadeIn, 0), 0), dur / 2);
    const fo = Math.min(Math.max(num(p.fadeOut, 0), 0), dur / 2);
    const vol = Math.min(Math.max(num(p.volume, 1), 0.1), 5);
    const hasFilter = fi > 0 || fo > 0 || Math.abs(vol - 1) > 0.01;
    const output = defaultOutput(p.input, 'clip', outExt);
    const args = ['-ss', String(start), '-i', p.input, '-t', String(dur), '-map', '0:a:0'];
    if (!p.precise && !hasFilter && ext !== 'aac') {
      args.push('-c:a', 'copy');
    } else {
      const af = [];
      if (Math.abs(vol - 1) > 0.01) af.push(`volume=${vol.toFixed(2)}`);
      if (fi > 0) af.push(`afade=t=in:st=0:d=${fi.toFixed(2)}`);
      if (fo > 0) af.push(`afade=t=out:st=${Math.max(0, dur - fo).toFixed(2)}:d=${fo.toFixed(2)}`);
      if (af.length) args.push('-af', af.join(','));
      args.push(...audioCodecArgs(outExt, '192k'));
      if (outExt === 'opus') args.push('-ar', '48000');
    }
    args.push(output);
    return {
      output,
      steps: [{ args, totalDuration: dur }],
    };
  },

  audioMerge(p) {
    const files = p.files || [];
    if (files.length < 2) throw new Error('请至少选择 2 个音频文件');
    const allowed = ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus'];
    const format = allowed.includes(p.format) ? p.format : 'mp3';
    const mode = p.mode === 'crossfade' ? 'crossfade' : 'concat';
    const reqFade = Math.min(Math.max(num(p.fadeDur, 1), 0.2), 5);
    const output = stampOutput(files[0], mode === 'crossfade' ? '淡入拼接' : '合并', format);

    return {
      output,
      async run(taskId, onProgress) {
        const infos = [];
        for (let i = 0; i < files.length; i++) {
          const cached = p.infos?.[i];
          if (cached && num(cached.duration, 0) > 0) {
            infos.push(cached);
          } else {
            infos.push(await probe(files[i]));
          }
          onProgress?.(0.1 * ((i + 1) / files.length));
        }
        const durs = infos.map((inf) => Math.max(0, num(inf?.duration, 0)));
        const inputArgs = [];
        const fcParts = [];
        files.forEach((f, idx) => {
          inputArgs.push('-i', f);
          fcParts.push(`[${idx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${idx}]`);
        });

        let totalDur = durs.reduce((s, d) => s + d, 0);
        if (mode === 'crossfade') {
          const minDur = Math.min(...durs);
          if (minDur < 0.3) throw new Error('交叉淡入拼接要求每个音频时长不少于 0.3 秒');
          const T = Math.min(reqFade, Math.max(0.1, minDur * 0.4));
          let prev = 'a0';
          for (let idx = 1; idx < files.length; idx++) {
            const outLbl = idx === files.length - 1 ? 'outa' : `ax${idx}`;
            fcParts.push(`[${prev}][a${idx}]acrossfade=d=${T.toFixed(3)}:c1=tri:c2=tri[${outLbl}]`);
            prev = outLbl;
          }
          totalDur = Math.max(0.1, totalDur - T * (files.length - 1));
        } else {
          const refs = files.map((_, idx) => `[a${idx}]`).join('');
          fcParts.push(`${refs}concat=n=${files.length}:v=0:a=1[outa]`);
        }

        const encArgs = audioCodecArgs(format, '192k');
        if (format === 'opus') encArgs.push('-ar', '48000');
        await runFfmpeg(taskId, [
          ...inputArgs,
          '-filter_complex', fcParts.join(';'),
          '-map', '[outa]',
          ...encArgs,
          output,
        ], { totalDuration: totalDur, from: 0.1, to: 1, onProgress });
        onProgress?.(1);
        return { output };
      },
    };
  },

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

  addMusic(p) {
    const music = p.music;
    if (!music) throw new Error('请先选择音乐文件');
    const output = defaultOutput(p.input, '配乐', 'mp4');
    const vol = Math.min(Math.max(num(p.musicVolume, 1), 0.1), 3);
    let args;
    if (p.mode === 'mix') {
      if (!p.hasAudio) throw new Error('原视频没有音轨，无法混合，请选择"替换"');
      const fc = p.ducking === 'yes'
        ? `[0:a]volume=1.0,asplit[va][sc];[1:a]volume=${vol}[ma];[ma][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[ducked];[va][ducked]amix=inputs=2:duration=first:dropout_transition=2[a]`
        : `[0:a]volume=1.0[va];[1:a]volume=${vol}[ma];[va][ma]amix=inputs=2:duration=first:dropout_transition=2[a]`;
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

  // 一键智能去静音（自动检测并裁剪停顿气口，支持视频与纯音频，音画帧级同步）
  removeSilence(p) {
    const ext = path.extname(String(p.input || '')).slice(1).toLowerCase();
    const isAudioByExt = AUDIO_EXTS.includes(ext);
    const outExt = isAudioByExt ? (ext === 'aac' ? 'm4a' : ext) : videoExt(p.input);
    const output = defaultOutput(p.input, '去静音', outExt);
    const threshold = Math.min(Math.max(num(p.threshold, -35), -60), -10);
    const minSilence = Math.min(Math.max(num(p.minSilence, 0.4), 0.1), 5);
    const padding = Math.min(Math.max(num(p.padding, 0.12), 0), 1);

    return {
      output,
      outputType: 'file',
      async run(taskId, onProgress) {
        onProgress?.(0.03);
        const info = await probe(p.input);
        if (!info.hasAudio && !isAudioByExt) {
          throw new Error('该视频不包含音轨，无法检测静音片段');
        }
        const audioOnly = isAudioByExt || (!info.width || !info.height);
        const totalDur = Math.max(num(info.duration, 0), num(p.totalDuration, 0));
        if (totalDur <= 0) {
          throw new Error('无法读取媒体时长');
        }

        onProgress?.(0.1);
        const stderr = await runFfmpegCapture(taskId, [
          '-i', p.input,
          '-af', `silencedetect=noise=${threshold}dB:d=${minSilence}`,
          '-f', 'null', '-',
        ]);
        onProgress?.(0.25);

        const silences = [];
        let curStart = null;
        const re = /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g;
        let m;
        while ((m = re.exec(stderr)) !== null) {
          const val = Math.max(0, Math.min(totalDur, parseFloat(m[2])));
          if (m[1] === 'start') {
            if (curStart === null) curStart = val;
          } else if (curStart !== null) {
            if (val > curStart) silences.push({ start: curStart, end: val });
            curStart = null;
          }
        }
        if (curStart !== null && totalDur > curStart) {
          silences.push({ start: curStart, end: totalDur });
        }

        const rawSpeech = [];
        let cursor = 0;
        for (const s of silences) {
          if (s.start > cursor + 0.005) {
            rawSpeech.push({ start: cursor, end: s.start });
          }
          cursor = Math.max(cursor, s.end);
        }
        if (totalDur > cursor + 0.005) {
          rawSpeech.push({ start: cursor, end: totalDur });
        }

        const padded = rawSpeech
          .map((seg) => ({
            start: Math.max(0, seg.start - padding),
            end: Math.min(totalDur, seg.end + padding),
          }))
          .sort((a, b) => a.start - b.start);

        const merged = [];
        for (const seg of padded) {
          if (!merged.length || seg.start - merged[merged.length - 1].end >= 0.05) {
            merged.push({ ...seg });
          } else {
            merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, seg.end);
          }
        }

        const intervals = merged.filter((seg) => seg.end - seg.start >= 0.06);
        if (!intervals.length) {
          throw new Error('整段媒体均为静音，未检测到有效人声片段（可尝试调低静音阈值如 -45dB）');
        }

        const outFileExt = path.extname(output);
        const tmpOut = `${output.slice(0, output.length - outFileExt.length)}.tmp-${crypto.randomBytes(4).toString('hex')}${outFileExt}`;
        fs.mkdirSync(path.dirname(output), { recursive: true });

        // 几乎无静音被裁掉时直接快速无损复制
        if (intervals.length === 1 && intervals[0].start <= 0.04 && intervals[0].end >= totalDur - 0.08) {
          try {
            if (ext === outExt) {
              fs.copyFileSync(p.input, tmpOut);
            } else {
              await runFfmpeg(taskId, ['-i', p.input, '-c', 'copy', tmpOut], {
                totalDuration: totalDur, from: 0.3, to: 1, onProgress,
              });
            }
            commitOutput(tmpOut, output);
            onProgress?.(1);
            return {
              output,
              outputType: 'file',
              silenceSummary: {
                origDuration: totalDur,
                newDuration: totalDur,
                removedCount: 0,
                savedSec: 0,
              },
            };
          } finally {
            await fs.promises.rm(tmpOut, { force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
          }
        }

        const newDuration = intervals.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
        const silencesCount = (intervals.length - 1)
          + (intervals[0].start > 0.05 ? 1 : 0)
          + (intervals[intervals.length - 1].end < totalDur - 0.05 ? 1 : 0);

        const buildArgsForBatch = (segs, outTarget) => {
          const fcParts = [];
          const concatRefs = [];
          segs.forEach((seg, i) => {
            const s = seg.start.toFixed(3);
            const e = seg.end.toFixed(3);
            if (audioOnly) {
              fcParts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
              concatRefs.push(`[a${i}]`);
            } else {
              fcParts.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${i}]`);
              fcParts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
              concatRefs.push(`[v${i}][a${i}]`);
            }
          });

          if (audioOnly) {
            fcParts.push(`${concatRefs.join('')}concat=n=${segs.length}:v=0:a=1[outa]`);
            const audioEnc = outExt === 'mp3'
              ? ['-c:a', 'libmp3lame', '-q:a', '2']
              : (outExt === 'ogg' ? ['-c:a', 'libvorbis', '-q:a', '5'] : audioCodecArgs(outExt === 'aac' ? 'm4a' : outExt, '192k'));
            if (outExt === 'opus') audioEnc.push('-ar', '48000');
            return ['-i', p.input, '-filter_complex', fcParts.join(';'), '-map', '[outa]', ...audioEnc, outTarget];
          }

          fcParts.push(`${concatRefs.join('')}concat=n=${segs.length}:v=1:a=1[outv][outa]`);
          const vEnc = outExt === 'webm'
            ? ['-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '128k']
            : [...videoCodecArgs(p, { crf: 20, preset: 'fast' }), '-c:a', 'aac', '-b:a', '160k',
              ...((outExt === 'mp4' || outExt === 'mov') ? ['-movflags', '+faststart'] : [])];
          return ['-i', p.input, '-filter_complex', fcParts.join(';'), '-map', '[outv]', '-map', '[outa]', ...vEnc, outTarget];
        };

        onProgress?.(0.3);
        const tmpDir = intervals.length > 25 ? fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_sil_')) : null;
        try {
          if (intervals.length <= 25) {
            await runFfmpeg(taskId, buildArgsForBatch(intervals, tmpOut), {
              totalDuration: newDuration, from: 0.3, to: 1, onProgress,
            });
          } else {
            const batchSize = 20;
            const batches = [];
            for (let i = 0; i < intervals.length; i += batchSize) {
              batches.push(intervals.slice(i, i + batchSize));
            }
            const chunkFiles = [];
            for (let b = 0; b < batches.length; b++) {
              const segs = batches[b];
              const chunkPath = path.join(tmpDir, `chunk_${String(b).padStart(3, '0')}.${outExt}`);
              const chunkDur = segs.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
              const lo = 0.3 + (0.62 * b) / batches.length;
              const hi = 0.3 + (0.62 * (b + 1)) / batches.length;
              await runFfmpeg(taskId, buildArgsForBatch(segs, chunkPath), {
                totalDuration: chunkDur, from: lo, to: hi, onProgress,
              });
              chunkFiles.push(chunkPath);
            }
            const listFile = path.join(tmpDir, 'list.txt');
            fs.writeFileSync(listFile, chunkFiles.map((f) => `file '${f.replaceAll("'", "'\\''")}'`).join('\n'), 'utf8');
            await runFfmpeg(taskId, ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', tmpOut], {
              totalDuration: newDuration, from: 0.92, to: 1, onProgress,
            });
          }

          commitOutput(tmpOut, output);
          onProgress?.(1);
          return {
            output,
            outputType: 'file',
            silenceSummary: {
              origDuration: totalDur,
              newDuration,
              removedCount: silencesCount,
              savedSec: Math.max(0, totalDur - newDuration),
            },
          };
        } finally {
          if (tmpDir) {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
          }
          await fs.promises.rm(tmpOut, { force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
        }
      },
    };
  },

  // ============================ 工具 ============================

  snapshot(p) {
    if (p.mode === 'all') {
      const dir = defaultDirOutput(p.input, '全部帧');
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
      const dir = defaultDirOutput(p.input, '帧导出');
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

  imagesTo(p) {
    const files = p.files || [];
    if (files.length < 2) throw new Error('请至少选择 2 张图片');
    const format = p.format === 'mp4' ? 'mp4' : 'gif';
    const fps = Math.min(Math.max(num(p.fps, 8), 1), format === 'mp4' ? 60 : 50);

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

    steps.forEach((s, i) => { s.from = i / steps.length; s.to = (i + 1) / steps.length; });

    return { output, steps, cleanupDirs: [tmpDir] };
  },

  splitVideo(p) {
    const D = num(p.totalDuration, 0);
    if (D <= 0) throw new Error('无法读取视频时长');
    const fmt = videoExt(p.input);
    const dir = defaultDirOutput(p.input, '切片');
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

  multiCut(p) {
    const D = num(p.totalDuration, 0);
    if (D <= 0) throw new Error('无法读取视频时长');
    const raw = (p.segments || [])
      .map((s) => ({ start: Math.max(0, num(s.start, 0)), end: Math.min(D, num(s.end, 0)) }))
      .filter((s) => s.end - s.start >= 0.08)
      .sort((a, b) => a.start - b.start);
    if (!raw.length) throw new Error('请至少添加一个有效的起止时间段');

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
          if (isGif) {
            copyTaskOutput(p.input, output);
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

  chromaGif(p) {
    const output = defaultOutput(p.input, '透明', 'gif');
    const rawColor = String(p.color || '#00ff00').trim();
    const color = '0x' + rawColor.replace(/^#|^0x/i, '').slice(0, 6).padStart(6, '0');
    const sim = Math.min(Math.max(num(p.similarity, 0.2), 0.01), 0.6).toFixed(2);
    const blend = Math.min(Math.max(num(p.blend, 0.08), 0), 0.4).toFixed(2);
    const fps = Math.min(Math.max(num(p.fps, 12), 4), 50);
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

  // APNG / GIF / 雪碧图序列帧互转
  animSprite(p) {
    const mode = ['toApng', 'apngToGif', 'toSprite', 'fromSprite'].includes(p.mode) ? p.mode : 'toApng';
    const D = num(p.totalDuration, 0);

    if (mode === 'toApng') {
      const fps = Math.min(Math.max(num(p.fps, 15), 1), 60);
      const w = num(p.width, 480);
      const output = defaultOutput(p.input, '动图', 'apng');
      const vfParts = [`fps=${fps}`];
      if (w > 0) vfParts.push(scaleFilter(even(w)));
      vfParts.push('format=rgba');
      const seg = [];
      if (num(p.start, 0) > 0) seg.push('-ss', String(num(p.start, 0)));
      if (num(p.duration, 0) > 0) seg.push('-t', String(num(p.duration, 0)));
      return {
        output,
        steps: [{
          args: [...seg, '-i', p.input, '-vf', vfParts.join(','), '-plays', '0', '-f', 'apng', '-c:v', 'apng', output],
          totalDuration: num(p.duration, 0) > 0 ? num(p.duration, 0) : D,
        }],
      };
    }

    if (mode === 'apngToGif') {
      const fps = num(p.fps, 15);
      const w = num(p.width, 0);
      const colors = Math.min(Math.max(Math.round(num(p.colors, 256)), 16), 256);
      const output = defaultOutput(p.input, '动图', 'gif');
      const vfParts = [];
      if (fps > 0) vfParts.push(`fps=${Math.min(Math.max(fps, 1), 50)}`);
      if (w > 0) vfParts.push(scaleFilter(even(w)));
      vfParts.push('format=rgba');
      return gifPlan({
        input: p.input,
        output,
        colors,
        statsMode: 'diff',
        diffMode: 'none',
        reserveTransparent: true,
        totalDuration: D,
        vf: vfParts.join(','),
      });
    }

    if (mode === 'toSprite') {
      const fps = Math.min(Math.max(num(p.fps, 10), 1), 60);
      const maxFrames = Math.min(Math.max(Math.round(num(p.maxFrames, 36)), 2), 120);
      const cellW = num(p.cellWidth, 160);
      const colsReq = Math.round(num(p.cols, 5));
      const layout = p.layout === 'row' ? 'row' : 'grid';
      const output = defaultOutput(p.input, '雪碧图', 'png');

      return {
        output,
        async run(taskId, onProgress) {
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_spr_'));
          try {
            const vfParts = [`fps=${fps}`];
            if (cellW > 0) vfParts.push(scaleFilter(even(Math.max(32, cellW))));
            vfParts.push('format=rgba');
            const framePattern = path.join(tmpDir, 'f_%04d.png');
            await runFfmpeg(taskId, [
              '-i', p.input,
              '-vf', vfParts.join(','),
              '-frames:v', String(maxFrames),
              framePattern,
            ], { totalDuration: D, from: 0, to: 0.7, onProgress });

            const frames = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.png')).sort();
            if (!frames.length) throw new Error('未能从媒体中提取到任何视频帧');
            const N = frames.length;
            const cols = layout === 'row' ? N : Math.min(N, Math.max(1, colsReq));
            const rows = Math.ceil(N / cols);

            await runFfmpeg(taskId, [
              '-framerate', '1',
              '-i', framePattern,
              '-vf', `format=rgba,tile=${cols}x${rows}:padding=0:margin=0:color=black@0`,
              '-frames:v', '1',
              '-c:v', 'png',
              '-update', '1',
              output,
            ], { totalDuration: 0, from: 0.7, to: 1, onProgress });
            onProgress?.(1);
            return {
              output,
              animSpriteSummary: { mode: 'toSprite', cols, rows, frames: N },
            };
          } finally {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
          }
        },
      };
    }

    // fromSprite: 雪碧图切分合成 GIF 或 APNG
    const cols = Math.min(Math.max(Math.round(num(p.cols, 5)), 1), 120);
    const rows = Math.min(Math.max(Math.round(num(p.rows, 4)), 1), 20);
    const totalCells = cols * rows;
    const reqFrames = Math.round(num(p.frameCount, 0));
    const frameCount = reqFrames > 0 ? Math.min(reqFrames, totalCells) : totalCells;
    if (frameCount < 2) throw new Error('雪碧图至少需要 2 帧才能合成动图');
    if (frameCount > 400) throw new Error('请输入不超过 400 的有效总帧数');
    const outFormat = p.outFormat === 'apng' ? 'apng' : 'gif';
    const fps = Math.min(Math.max(num(p.fps, 10), 1), outFormat === 'apng' ? 60 : 50);
    const output = defaultOutput(p.input, '动图', outFormat);

    return {
      output,
      async run(taskId, onProgress) {
        const info = (num(p.srcW, 0) > 0 && num(p.srcH, 0) > 0) ? { width: num(p.srcW, 0), height: num(p.srcH, 0) } : await probe(p.input);
        const W = Math.max(2, num(info.width, 0));
        const H = Math.max(2, num(info.height, 0));
        const cw = Math.floor(W / cols);
        const ch = Math.floor(H / rows);
        if (cw < 4 || ch < 4) throw new Error('雪碧图按指定行列划分后单帧尺寸过小，请检查行列数');

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_fspr_'));
        try {
          const splitLabels = Array.from({ length: frameCount }, (_, i) => `[s${i}]`).join('');
          const fcParts = [`[0:v]format=rgba,split=${frameCount}${splitLabels}`];
          const concatRefs = [];
          for (let i = 0; i < frameCount; i++) {
            const c = i % cols;
            const r = Math.floor(i / cols);
            const x = c * cw;
            const y = r * ch;
            fcParts.push(`[s${i}]crop=${cw}:${ch}:${x}:${y}[c${i}]`);
            concatRefs.push(`[c${i}]`);
          }
          fcParts.push(`${concatRefs.join('')}concat=n=${frameCount}:v=1:a=0[outseq]`);

          if (outFormat === 'apng') {
            await runFfmpeg(taskId, [
              '-i', p.input,
              '-filter_complex', `${fcParts.join(';')};[outseq]setpts=N/(${fps}*TB)[outv]`,
              '-map', '[outv]',
              '-plays', '0',
              '-f', 'apng',
              '-c:v', 'apng',
              output,
            ], { totalDuration: frameCount / fps, from: 0, to: 1, onProgress });
            onProgress?.(1);
            return {
              output,
              animSpriteSummary: { mode: 'fromSprite', cols, rows, frames: frameCount, outFormat },
            };
          }

          const framePattern = path.join(tmpDir, 'f_%04d.png');
          await runFfmpeg(taskId, [
            '-i', p.input,
            '-filter_complex', fcParts.join(';'),
            '-map', '[outseq]',
            '-fps_mode', 'passthrough',
            framePattern,
          ], { totalDuration: 0, from: 0, to: 0.4, onProgress });

          const plan = gifPlan({
            input: framePattern,
            seg: ['-framerate', String(fps)],
            output,
            colors: 256,
            statsMode: 'diff',
            diffMode: 'none',
            reserveTransparent: true,
            totalDuration: frameCount / fps,
            vf: 'format=rgba',
          });
          try {
            for (const step of plan.steps) {
              await runFfmpeg(taskId, step.args, {
                totalDuration: step.totalDuration,
                from: 0.4 + 0.6 * (step.from || 0),
                to: 0.4 + 0.6 * (step.to || 1),
                onProgress,
              });
            }
          } finally {
            for (const f of plan.cleanup || []) fs.unlink(f, () => {});
          }
          onProgress?.(1);
          return {
            output,
            animSpriteSummary: { mode: 'fromSprite', cols, rows, frames: frameCount, outFormat },
          };
        } finally {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        }
      },
    };
  },

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

  subtitleConvert(p) {
    const ext = path.extname(String(p.input || '')).slice(1).toLowerCase();
    if (!['srt', 'vtt', 'ass', 'ssa'].includes(ext)) {
      throw new Error('请选择字幕文件 (.srt / .vtt / .ass / .ssa)');
    }
    const format = ['srt', 'vtt', 'txt'].includes(p.format) ? p.format : 'srt';
    const shiftSec = p.shiftSec === undefined || p.shiftSec === '' ? 0 : Number(p.shiftSec);
    if (!Number.isFinite(shiftSec) || shiftSec < -86400 || shiftSec > 86400) {
      throw new Error('时间轴偏移必须在 -86400 到 86400 秒之间');
    }
    const suffix = format === 'txt' ? '台词' : (shiftSec !== 0 ? '同步' : '转换');
    const output = p.output || defaultOutput(p.input, suffix, format);

    return {
      output,
      outputType: 'file',
      async run(taskId, onProgress) {
        const { convertSubtitleFile } = require('../core/subtitle');
        const res = await convertSubtitleFile(p.input, output, {
          format,
          shiftSec,
          stripTags: p.stripTags,
          txtTimestamps: p.txtTimestamps,
          taskId,
          onProgress,
        });
        return {
          output,
          outputType: 'file',
          subtitleConvertSummary: res,
        };
      },
    };
  },

  // 画面调色与防抖（支持视频 / GIF / 静态图片）
  colorStab(p) {
    const isImg = isImagePath(p.input);
    const brightness = Math.min(Math.max(num(p.brightness, 0), -0.5), 0.5);
    const contrast = Math.min(Math.max(num(p.contrast, 1), 0.5), 2);
    const saturation = Math.min(Math.max(num(p.saturation, 1), 0), 3);
    const vfParts = [];
    if (!isImg && p.stabilize === 'deshake') vfParts.push('deshake');
    if (brightness !== 0 || contrast !== 1 || saturation !== 1) {
      vfParts.push(`eq=brightness=${brightness.toFixed(2)}:contrast=${contrast.toFixed(2)}:saturation=${saturation.toFixed(2)}`);
    }
    if (p.sharpen === 'light') vfParts.push('unsharp=5:5:0.6:5:5:0.0');
    else if (p.sharpen === 'strong') vfParts.push('unsharp=5:5:1.2:5:5:0.0');

    if (!vfParts.length) throw new Error(isImg ? '请至少调整一项色彩或锐化参数' : '请至少调整一项画面参数或开启防抖');
    const vf = vfParts.join(',');
    const ext = path.extname(p.input).slice(1).toLowerCase();
    const D = num(p.totalDuration, 0);

    if (isImg) {
      const imgFmt = imageExt(p.input);
      const output = defaultOutput(p.input, '调色', imgFmt);
      return {
        output,
        steps: [{ args: ['-i', p.input, '-vf', vf, ...imageCodecArgs(imgFmt, { quality: 'high' }), output], totalDuration: 0 }],
      };
    }

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

  // 视频淡入淡出（片头/片尾黑场或白场渐隐，音画同步）
  videoFade(p) {
    const D = num(p.totalDuration, 0);
    if (D <= 0) throw new Error('无法读取视频时长');
    let fi = Math.max(0, num(p.fadeIn, 0));
    let fo = Math.max(0, num(p.fadeOut, 0));
    if (fi <= 0 && fo <= 0) throw new Error('请至少开启片头淡入或片尾淡出');
    if (fi + fo > D * 0.95) {
      const scale = (D * 0.95) / (fi + fo);
      fi *= scale;
      fo *= scale;
    }

    const color = p.color === 'white' ? 'white' : 'black';
    const vfParts = [];
    const afParts = [];
    if (fi > 0) {
      vfParts.push(`fade=t=in:st=0:d=${fi.toFixed(2)}:color=${color}`);
      afParts.push(`afade=t=in:st=0:d=${fi.toFixed(2)}`);
    }
    if (fo > 0) {
      const outStart = Math.max(0, D - fo);
      vfParts.push(`fade=t=out:st=${outStart.toFixed(2)}:d=${fo.toFixed(2)}:color=${color}`);
      afParts.push(`afade=t=out:st=${outStart.toFixed(2)}:d=${fo.toFixed(2)}`);
    }

    const ext = path.extname(p.input).slice(1).toLowerCase();
    if (ext === 'gif') {
      return gifPlan({
        input: p.input,
        output: defaultOutput(p.input, '渐隐', 'gif'),
        colors: 256,
        totalDuration: D,
        vf: `format=rgb24,${vfParts.join(',')}`,
      });
    }

    const output = defaultOutput(p.input, '渐隐', videoExt(p.input));
    const args = ['-i', p.input, '-vf', vfParts.join(','), ...videoCodecArgs(p)];
    if (p.hasAudio) {
      if (p.syncAudio !== 'no' && afParts.length) {
        args.push('-af', afParts.join(','), '-c:a', 'aac', '-b:a', '192k');
      } else {
        args.push('-c:a', 'copy');
      }
    }
    args.push(output);
    return {
      output,
      steps: [{ args, totalDuration: D }],
    };
  },

  // 一键画面滤镜 + 暗角（支持视频 / GIF / 静态图片）
  videoFilter(p) {
    const isImg = isImagePath(p.input);
    const presetMap = {
      cinema: 'colorbalance=rs=.12:gs=-.02:bs=-.12:rm=.04:gm=0:bm=-.04:rh=.08:gh=.02:bh=-.08,eq=contrast=1.12:saturation=1.18',
      vintage: 'colorchannelmixer=.88:.16:.04:0:.04:.86:.10:0:.02:.14:.72:0,eq=brightness=0.02:contrast=1.08:saturation=0.82',
      fresh: 'eq=brightness=0.06:contrast=0.95:saturation=0.92:gamma=1.06,colorbalance=rs=-.04:gs=.03:bs=.08:rh=-.02:gh=.02:bh=.05',
      warm: 'colorbalance=rs=.10:gs=.04:bs=-.08:rm=.08:gm=.02:bm=-.06,eq=brightness=0.03:saturation=1.15',
      cool: 'colorbalance=rs=-.08:gs=0:bs=.12:rm=-.06:gm=.01:bm=.10,eq=contrast=1.06:saturation=0.95',
      bw: 'hue=s=0,eq=contrast=1.22:brightness=-0.02',
      vivid: 'eq=contrast=1.10:saturation=1.32:brightness=0.02,unsharp=5:5:0.4:5:5:0.0',
    };
    const preset = p.preset || 'cinema';
    const vignette = p.vignette || 'none';
    const sharpen = p.sharpen || 'none';

    const vfParts = [];
    if (presetMap[preset]) vfParts.push(presetMap[preset]);
    if (vignette === 'light') vfParts.push('vignette=PI/5');
    else if (vignette === 'strong') vfParts.push('vignette=PI/3.2');
    if (sharpen === 'light') vfParts.push('unsharp=5:5:0.5:5:5:0.0');

    if (!vfParts.length) throw new Error('请至少选择一种滤镜风格或开启暗角');
    const ext = path.extname(p.input).slice(1).toLowerCase();
    const D = num(p.totalDuration, 0);

    if (isImg) {
      const imgFmt = imageExt(p.input);
      const output = defaultOutput(p.input, '滤镜', imgFmt);
      const preFmt = (imgFmt === 'png' || imgFmt === 'webp') ? 'format=rgba,' : 'format=rgb24,';
      return {
        output,
        steps: [{ args: ['-i', p.input, '-vf', preFmt + vfParts.join(','), ...imageCodecArgs(imgFmt, { quality: 'high' }), output], totalDuration: 0 }],
      };
    }

    if (ext === 'gif') {
      return gifPlan({
        input: p.input,
        output: defaultOutput(p.input, '滤镜', 'gif'),
        colors: 256,
        totalDuration: D,
        vf: `format=rgb24,${vfParts.join(',')}`,
      });
    }

    const output = defaultOutput(p.input, '滤镜', videoExt(p.input));
    return {
      output,
      steps: [{
        args: ['-i', p.input, '-vf', vfParts.join(','), ...videoCodecArgs(p), '-c:a', 'copy', output],
        totalDuration: D,
      }],
    };
  },

  // 视频加标题 / 花字栏（胶囊底条 / 描边字 / 电影上下黑边 / 顶部标题栏）
  videoText(p) {
    const rawText = String(p.text || '').replace(/\\n/g, '\n').trim();
    if (!rawText) throw new Error('请输入要添加的标题或文字');

    const srcH = Math.max(num(p.srcH, 720), 64);
    const sizeDiv = { small: 24, medium: 16, large: 11, xlarge: 8 }[p.size] || 16;
    const fontsize = Math.max(18, even(srcH / sizeDiv));
    const colorMap = {
      white: '#ffffff',
      yellow: '#fde047',
      cyan: '#22d3ee',
      coral: '#fb7185',
      black: '#111827',
    };
    const fontColor = colorMap[p.color] || '#ffffff';
    const isBlack = p.color === 'black';
    const pos = ['top', 'center', 'bottom'].includes(p.pos) ? p.pos : 'bottom';
    const style = ['pill', 'shadow', 'cinema', 'banner'].includes(p.style) ? p.style : 'pill';

    let enableExpr = '';
    if (p.timing === 'intro3') {
      enableExpr = ":enable='between(t,0,3)'";
    } else if (p.timing === 'custom') {
      const s = Math.max(0, num(p.start, 0));
      const e = Math.max(s + 0.1, num(p.end, s + 3));
      enableExpr = `:enable='between(t,${s.toFixed(2)},${e.toFixed(2)})'`;
    }

    const textFile = path.join(os.tmpdir(), `vgt_vtext_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`);
    fs.writeFileSync(textFile, rawText, 'utf8');
    const textFileArg = textFile.replace(/\\/g, '/').replace(/:/g, '\\:');

    let vf;
    if (style === 'cinema') {
      const barH = even(Math.max(fontsize * 2.1, srcH * 0.14));
      const yExpr = pos === 'top'
        ? `(${barH}-text_h)/2`
        : (pos === 'center' ? '(h-text_h)/2' : `h-${barH}+(${barH}-text_h)/2`);
      const textCol = isBlack ? '#ffffff' : fontColor;
      vf = `pad=iw:ih+${barH * 2}:0:${barH}:black,drawtext=fontfile='${FONT}':textfile='${textFileArg}':fontsize=${fontsize}:fontcolor=${textCol}:x=(w-text_w)/2:y=${yExpr}:expansion=none${enableExpr}`;
    } else if (style === 'banner') {
      const barH = even(Math.max(fontsize * 2.1, srcH * 0.13));
      const boxCol = isBlack ? 'white@0.86' : '#0f172a@0.78';
      vf = `drawbox=x=0:y=0:w=iw:h=${barH}:color=${boxCol}:t=fill${enableExpr},drawtext=fontfile='${FONT}':textfile='${textFileArg}':fontsize=${fontsize}:fontcolor=${fontColor}:x=(w-text_w)/2:y=(${barH}-text_h)/2:expansion=none${enableExpr}`;
    } else if (style === 'shadow') {
      const yExpr = { top: 'h*0.07', center: '(h-text_h)/2', bottom: 'h-text_h-h*0.08' }[pos];
      const borderCol = isBlack ? 'white' : 'black';
      vf = `drawtext=fontfile='${FONT}':textfile='${textFileArg}':fontsize=${fontsize}:fontcolor=${fontColor}:borderw=3:bordercolor=${borderCol}:shadowcolor=black@0.6:shadowx=2:shadowy=2:x=(w-text_w)/2:y=${yExpr}:expansion=none${enableExpr}`;
    } else {
      const yExpr = { top: 'h*0.07', center: '(h-text_h)/2', bottom: 'h-text_h-h*0.08' }[pos];
      const boxCol = isBlack ? 'white@0.88' : 'black@0.68';
      const padBox = Math.max(10, Math.round(fontsize * 0.42));
      vf = `drawtext=fontfile='${FONT}':textfile='${textFileArg}':fontsize=${fontsize}:fontcolor=${fontColor}:box=1:boxcolor=${boxCol}:boxborderw=${padBox}:x=(w-text_w)/2:y=${yExpr}:expansion=none${enableExpr}`;
    }

    const output = defaultOutput(p.input, '标题', videoExt(p.input));
    return {
      output,
      cleanup: [textFile],
      steps: [{
        args: ['-i', p.input, '-vf', vf, ...videoCodecArgs(p), '-c:a', 'copy', output],
        totalDuration: num(p.totalDuration, 0),
      }],
    };
  },

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

  videoCover(p) {
    const source = p.source === 'frame' ? 'frame' : 'image';
    if (source === 'image' && !p.coverImage) {
      throw new Error('请先选择要嵌入的封面图片');
    }
    const outExt = path.extname(String(p.input || '')).slice(1).toLowerCase();
    if (!['mp4', 'm4v'].includes(outExt)) throw new Error('请选择 MP4 或 M4V 视频');
    const output = defaultOutput(p.input, '封面', outExt);
    const at = Math.max(0, num(p.at, 0));

    return {
      output,
      async run(taskId, onProgress) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_cover_'));
        const cover = path.join(tmpDir, 'cover.jpg');
        const staged = path.join(path.dirname(output), `.vgt-cover-${crypto.randomUUID()}.${outExt}`);
        try {
          const coverInput = source === 'image'
            ? ['-i', p.coverImage]
            : ['-ss', String(at), '-i', p.input];
          await runFfmpeg(taskId, [
            ...coverInput, '-map', '0:V:0',
            '-vf', "scale='max(2,min(1920,trunc(iw/2)*2))':-2",
            '-c:v', 'mjpeg', '-pix_fmt', 'yuvj420p', '-q:v', '2', '-frames:v', '1', '-update', '1', cover,
          ], { totalDuration: 0, from: 0, to: 0.15, onProgress });
          if (!fs.existsSync(cover)) throw new Error('未提取到封面画面，请检查时间点');
          await runFfmpeg(taskId, [
            '-i', p.input, '-i', cover,
            '-map', '1:v:0', '-map', '0:V', '-map', '0:a?', '-map', '0:s?',
            '-map_metadata', '0', '-map_chapters', '0', '-c', 'copy',
            '-disposition:v:0', 'attached_pic',
            '-movflags', '+faststart', '-f', 'mp4', staged,
          ], { totalDuration: num(p.totalDuration, 0), from: 0.15, to: 1, onProgress });
          commitOutput(staged, output);
          return { output };
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          await fs.promises.rm(staged, { force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
        }
      },
    };
  },

  stripMeta(p) {
    const ext = path.extname(p.input).slice(1).toLowerCase();
    const isGifOrImg = ext === 'gif' || IMG_EXTS.includes(ext);
    const outExt = isGifOrImg
      ? (ext === 'jpeg' ? 'jpg' : ext)
      : (AUDIO_EXTS.includes(ext) ? (ext === 'aac' ? 'm4a' : ext) : videoExt(p.input));
    const output = defaultOutput(p.input, '去元数据', outExt);
    const isImage2Single = ['png', 'jpg', 'jpeg', 'bmp'].includes(ext);
    const args = isGifOrImg
      ? ['-i', p.input, '-map_metadata', '-1', ...(isImage2Single ? ['-update', '1', '-frames:v', '1'] : []), output]
      : ['-i', p.input, '-map', '0', '-c', 'copy', '-map_metadata', '-1', '-fflags', '+bitexact', output];

    return {
      output,
      steps: [{ args, totalDuration: num(p.totalDuration, 0) }],
    };
  },
};

module.exports = builders;
