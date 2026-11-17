'use strict';
// 冒烟测试：生成测试视频与 GIF，逐一执行 7 个功能并校验输出
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { probe, executeTask, FFMPEG } = require('../ffmpeg');

const TMP_ROOT = path.join(__dirname, 'smoke');
if (fs.existsSync(TMP_ROOT)) {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  if (fs.existsSync(TMP_ROOT) && process.platform === 'win32') {
    spawnSync('cmd', ['/d', '/s', '/c', `rd /s /q "${TMP_ROOT}"`], { stdio: 'ignore' });
  }
}
const TMP = path.join(TMP_ROOT, `run_${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });

function run(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-y', ...args], { stdio: 'pipe' });
  if (r.status !== 0) throw new Error('生成测试素材失败: ' + r.stderr.toString().slice(-500));
}

const testVideo = path.join(TMP, 'test.mp4');
const testGif = path.join(TMP, 'test.gif');

console.log('生成测试视频 (10s, 1280x720, 有音轨)…');
run(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=10',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', testVideo]);

console.log('生成测试 GIF…');
run(['-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=15:duration=4', testGif]);

let failed = 0;

async function test(name, feature, params, check) {
  try {
    const t0 = Date.now();
    const { output } = await executeTask('test', feature, params, () => {});
    // 目录输出（帧序列）检查内容非空；文件输出检查 size>0
    const isDir = fs.statSync(output).isDirectory();
    if (isDir) {
      if (!fs.readdirSync(output).length) throw new Error('输出目录为空');
    } else if (fs.statSync(output).size === 0) {
      throw new Error('输出文件为空');
    }
    const info = isDir ? { width: 0, height: 0, duration: 0, hasAudio: false } : await probe(output);
    const ms = Date.now() - t0;
    await check?.(info);
    console.log(`  ✅ ${name}  (${ms}ms, ${Math.round(fs.statSync(output).size / 1024)}KB${isDir ? ', 目录' : `, ${info.width}x${info.height}, ${info.duration.toFixed(1)}s, 音轨:${info.hasAudio}`})`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

(async () => {
  console.log('\n开始逐一测试功能:\n');

  await test('1. 视频→GIF (片段 2-6s)', 'videoToGif', {
    input: testVideo, start: 2, duration: 4, end: 6, fps: 12, width: 480, colors: 128,
  }, (i) => { if (i.width !== 480) throw new Error(`宽度 ${i.width} 应为 480`); });

  await test('2. GIF→MP4', 'gifToVideo', {
    input: testGif, format: 'mp4', totalDuration: 4,
  }, (i) => { if (i.hasAudio) throw new Error('GIF 转出不应有音轨'); });

  await test('3. GIF→WebM', 'gifToVideo', {
    input: testGif, format: 'webm', totalDuration: 4,
  });

  await test('4. GIF 压缩', 'compressGif', {
    input: testGif, width: 320, fps: 10, colors: 64, totalDuration: 4,
  });

  await test('5. 格式转换 MP4→WebM (720p)', 'convertVideo', {
    input: testVideo, format: 'webm', height: 720, quality: 'medium', totalDuration: 10,
  }, (i) => { if (i.height !== 720) throw new Error(`高度 ${i.height} 应为 720`); });

  await test('6. 格式转换 MP4→MKV', 'convertVideo', {
    input: testVideo, format: 'mkv', height: 0, quality: 'low', totalDuration: 10,
  });

  await test('7. 截取-无损 (3s起, 4s长)', 'trimVideo', {
    input: testVideo, start: 3, duration: 4, precise: false,
  }, (i) => { if (Math.abs(i.duration - 4) > 0.6) throw new Error(`时长 ${i.duration} 应约 4s`); });

  await test('8. 截取-精确', 'trimVideo', {
    input: testVideo, start: 1.5, duration: 2.5, precise: true,
  }, (i) => { if (Math.abs(i.duration - 2.5) > 0.3) throw new Error(`时长 ${i.duration} 应约 2.5s`); });

  await test('9. 变速 2x (含音轨)', 'changeSpeed', {
    input: testVideo, speed: 2, hasAudio: true, totalDuration: 5,
  }, (i) => { if (Math.abs(i.duration - 5) > 0.5) throw new Error(`时长 ${i.duration} 应约 5s`); });

  await test('10. 变速 0.5x (无音轨 GIF)', 'changeSpeed', {
    input: testGif, speed: 0.5, hasAudio: false, totalDuration: 8,
  });

  await test('11. 提取音频 MP3', 'extractAudio', {
    input: testVideo, format: 'mp3', totalDuration: 10,
  }, (i) => { if (!i.hasAudio) throw new Error('MP3 应有音频流'); });

  await test('12. 提取音频 M4A / WAV', 'extractAudio', {
    input: testVideo, format: 'wav', totalDuration: 10,
  });

  // ============ 第二批：新功能 ============

  // 测试素材：第二个短视频（用于合并）、测试音乐、测试图片
  const testVideo2 = path.join(TMP, 'test2.mp4');
  const testMusic = path.join(TMP, 'music.mp3');
  const img1 = path.join(TMP, 'img1.png');
  const img2 = path.join(TMP, 'img2.png');
  const img3 = path.join(TMP, 'img3.png');
  console.log('生成第二批测试素材…');
  run(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', testVideo2]);
  run(['-f', 'lavfi', '-i', 'sine=frequency=600:duration=30', '-c:a', 'libmp3lame', testMusic]);
  for (let i = 1; i <= 3; i++) {
    run(['-f', 'lavfi', '-i', `testsrc2=size=${400 + i * 40}x300:rate=1:duration=1`,
      '-frames:v', '1', path.join(TMP, `img${i}.png`)]);
  }

  await test('13. 倒放 GIF', 'reverse', {
    input: testGif, mode: 'reverse', totalDuration: 4,
  });

  await test('14. 往复循环 MP4 (boomerang)', 'reverse', {
    input: testVideo, mode: 'boomerang', hasAudio: true, totalDuration: 10,
  }, (i) => { if (Math.abs(i.duration - 20) > 1.5) throw new Error(`时长 ${i.duration} 应约 20s`); });

  await test('15. 倒放视频 (含音轨)', 'reverse', {
    input: testVideo, mode: 'reverse', hasAudio: true, totalDuration: 10,
  }, (i) => { if (!i.hasAudio) throw new Error('倒放应保留音轨'); });

  await test('16. 旋转 90° MP4', 'rotateFlip', {
    input: testVideo, mode: 'r90', totalDuration: 10,
  }, (i) => { if (i.width !== 720 || i.height !== 1280) throw new Error(`应为 720x1280，得到 ${i.width}x${i.height}`); });

  await test('17. 左右镜像 GIF', 'rotateFlip', {
    input: testGif, mode: 'hflip', totalDuration: 4,
  }, (i) => { if (i.width !== 480) throw new Error(`宽度 ${i.width} 应保持 480`); });

  await test('18. WebP 动图', 'toWebp', {
    input: testVideo, start: 0, duration: 3, fps: 12, width: 480, quality: 75, totalDuration: 10,
  }, async () => {
    const out = path.join(TMP, 'test_webp.webp');
    const png = path.join(TMP, 'webp_check.png');
    const r = spawnSync(FFMPEG, ['-y', '-i', out, '-frames:v', '1', png], { stdio: 'pipe' });
    if (r.status !== 0) throw new Error('WebP 解码失败');
    const info = await probe(png);
    if (info.width !== 480) throw new Error(`宽度 ${info.width} 应为 480`);
  });

  await test('19. 静音', 'audioAdjust', {
    input: testVideo, mode: 'mute', totalDuration: 10,
  }, (i) => { if (i.hasAudio) throw new Error('静音后不应有音轨'); });

  await test('20. 音量 3x', 'audioAdjust', {
    input: testVideo, mode: 'volume', volume: 3, totalDuration: 10,
  });

  await test('21. 淡入淡出', 'audioAdjust', {
    input: testVideo, mode: 'fade', fadeIn: 1, fadeOut: 2, totalDuration: 10,
  }, (i) => { if (Math.abs(i.duration - 10) > 0.5) throw new Error('时长不应变化'); });

  await test('22. 单帧截图 PNG', 'snapshot', {
    input: testVideo, mode: 'single', at: 5, format: 'png',
  }, (i) => { if (i.width !== 1280) throw new Error('截图应为原分辨率'); });

  await test('23. 帧序列导出', 'snapshot', {
    input: testVideo, mode: 'seq', every: 1, start: 0, duration: 0, totalDuration: 10,
  }, () => {
    const dir = path.join(TMP, 'test_帧导出');
    const n = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).length;
    if (n < 8) throw new Error(`应导出约 10 张，实际 ${n} 张`);
  });

  await test('24. GIF 加中文文字', 'gifText', {
    input: testGif, text: '测试文字:Hello,100%[\']', pos: 'bottom', size: 'medium', color: 'yellow',
    height: 270, totalDuration: 4,
  });

  await test('25. 画面裁剪 MP4 (中裁 640x360)', 'videoCrop', {
    input: testVideo, crop: { w: 640, h: 360, x: 320, y: 180 }, srcW: 1280, srcH: 720, totalDuration: 10,
  }, (i) => { if (i.width !== 640 || i.height !== 360) throw new Error(`应为 640x360，得到 ${i.width}x${i.height}`); });

  await test('26. 背景音乐-替换', 'addMusic', {
    input: testVideo, music: testMusic, mode: 'replace', musicVolume: 1, hasAudio: true, totalDuration: 10,
  }, (i) => { if (!i.hasAudio) throw new Error('应有音轨'); });

  await test('27. 背景音乐-混合', 'addMusic', {
    input: testVideo, music: testMusic, mode: 'mix', musicVolume: 0.5, hasAudio: true, totalDuration: 10,
  }, (i) => { if (!i.hasAudio) throw new Error('应有音轨'); });

  await test('28. 无损合并 (6s+6s)', 'mergeVideos', {
    files: [testVideo, testVideo2],
  }, (i) => { if (Math.abs(i.duration - 16) > 1.5) throw new Error(`时长 ${i.duration} 应约 16s`); });

  await test('29. 图片→GIF (3张不同尺寸)', 'imagesTo', {
    files: [img1, img2, img3], format: 'gif', fps: 8,
    sizes: { [img1]: { w: 440, h: 300 }, [img2]: { w: 480, h: 300 }, [img3]: { w: 520, h: 300 } },
  }, (i) => { if (i.width !== 520) throw new Error(`宽度 ${i.width} 应为最大 520`); });

  await test('30. 图片→MP4', 'imagesTo', {
    files: [img1, img2, img3], format: 'mp4', fps: 4,
    sizes: { [img1]: { w: 440, h: 300 }, [img2]: { w: 480, h: 300 }, [img3]: { w: 520, h: 300 } },
  });

  await test('31. 视频压到 2MB', 'compressTarget', {
    input: testVideo, targetMB: 2, hasAudio: true, totalDuration: 10,
  }, () => {
    const out = path.join(TMP, 'test_2MB.mp4');
    const mb = fs.statSync(out).size / 1024 / 1024;
    if (mb > 2.2) throw new Error(`压到 ${mb.toFixed(2)}MB，超过 2MB 目标`);
  });

  await test('32. GIF 压到 0.3MB', 'compressTarget', {
    input: testGif, targetMB: 0.3, width: 480, fps: 15, hasAudio: false, totalDuration: 4,
  }, () => {
    const out = path.join(TMP, 'test_min.gif');
    const mb = fs.statSync(out).size / 1024 / 1024;
    if (mb > 0.33) throw new Error(`压到 ${mb.toFixed(3)}MB，超过 0.3MB 目标`);
  });

  await test('33. GIF 压缩-极限体积且不放大', 'compressGif', {
    input: testGif, width: 800, srcW: 480, fps: 24, srcFps: 15, colors: 64, dither: 'small', totalDuration: 4,
  }, (i) => { if (i.width !== 480) throw new Error(`不应放大，期望 480 实际 ${i.width}`); });

  await test('34. 局部高斯模糊 MP4', 'videoBlur', {
    input: testVideo, crop: { w: 300, h: 180, x: 100, y: 80 }, srcW: 1280, srcH: 720, mode: 'blur', strength: 'strong', totalDuration: 10,
  }, (i) => { if (i.width !== 1280 || i.height !== 720) throw new Error('分辨率不应改变'); });

  await test('35. 局部像素马赛克 GIF', 'videoBlur', {
    input: testGif, crop: { w: 160, h: 100, x: 40, y: 40 }, srcW: 480, srcH: 270, mode: 'mosaic', strength: 'medium', totalDuration: 4,
  }, (i) => { if (i.width !== 480) throw new Error('GIF 宽度不应改变'); });

  await test('36. 横竖屏适配 9:16 模糊背景 MP4', 'aspectPad', {
    input: testVideo, ratio: '9:16', bg: 'blur', totalDuration: 10,
  }, (i) => { if (i.width !== 1080 || i.height !== 1920) throw new Error(`应为 1080x1920，实际 ${i.width}x${i.height}`); });

  await test('37. 横竖屏适配 1:1 模糊背景 GIF', 'aspectPad', {
    input: testGif, ratio: '1:1', bg: 'blur', totalDuration: 4,
  }, (i) => { if (i.width !== 480 || i.height !== 480) throw new Error(`应为 480x480，实际 ${i.width}x${i.height}`); });

  await test('38. 添加文字水印 MP4', 'watermark', {
    input: testVideo, mode: 'text', text: '水印Test:100%', pos: 'br', size: 'medium', opacity: '0.7', srcW: 1280, srcH: 720, totalDuration: 10,
  }, (i) => { if (!i.hasAudio) throw new Error('应保留音轨'); });

  await test('39. 添加图片水印 MP4', 'watermark', {
    input: testVideo, mode: 'image', image: img1, pos: 'tl', size: 'small', opacity: '0.6', srcW: 1280, srcH: 720, totalDuration: 10,
  }, (i) => { if (i.width !== 1280) throw new Error('分辨率应保持 1280'); });

  const testDiffRes = path.join(TMP, 'test_diff.mp4');
  run(['-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=24:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', testDiffRes]);
  await test('40. 兼容合并 (跨分辨率+无音轨混拼)', 'mergeVideos', {
    files: [testVideo, testDiffRes],
    mode: 'compat',
    infos: [
      { width: 1280, height: 720, hasAudio: true, duration: 10 },
      { width: 640, height: 480, hasAudio: false, duration: 3 },
    ],
  }, (i) => { if (i.width !== 1280 || Math.abs(i.duration - 13) > 1.5) throw new Error(`合并结果异常: ${i.width}x${i.height}, ${i.duration}s`); });

  await test('41. GIF 压缩-进阶选项(50%缩放/逐帧调色/降噪/倍速/截段)', 'compressGif', {
    input: testGif, width: 'p50', fps: 'p50', colors: 64, dither: 'floyd',
    statsMode: 'single', denoise: 'light', diffMode: 'none', speed: 1.5, loop: -1,
    start: 0.5, duration: 2, srcW: 480, srcFps: 15, totalDuration: 4,
  }, (i) => { if (i.width !== 240) throw new Error(`50% 缩放应为 240，实际 ${i.width}`); });

  // ============ 第三批：开源工具箱全套拓展功能 ============

  await test('42. 无损换容器 MP4→MOV', 'convertVideo', {
    input: testVideo, mode: 'copy', format: 'mov', totalDuration: 10,
  }, (i) => { if (i.width !== 1280 || !i.hasAudio) throw new Error('无损换容器参数异常'); });

  await test('43. GIF 去重复帧压缩 (mpdecimate)', 'compressGif', {
    input: testGif, width: 480, fps: 12, colors: 64, dedup: 'yes', totalDuration: 4,
  });

  await test('44. 绿幕抠像透明 GIF', 'chromaGif', {
    input: (() => {
      const green = path.join(TMP, 'green.mp4');
      run(['-f', 'lavfi', '-i', 'color=c=0x00ff00:size=320x240:rate=15:duration=2',
        '-f', 'lavfi', '-i', 'color=c=0xff0000:size=80x80:rate=15:duration=2',
        '-filter_complex', '[0:v][1:v]overlay=(W-w)/2:(H-h)/2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', green]);
      return green;
    })(),
    color: '#00ff00', similarity: 0.2, blend: 0.08, width: 320, fps: 12, totalDuration: 2,
  }, (i) => { if (i.width !== 320) throw new Error(`抠像 GIF 宽应为 320，实际 ${i.width}`); });

  await test('45. 进度条 + 圆角透明 GIF 装饰', 'decorateMedia', {
    input: testGif, progressBar: 'bottom', barColor: '#22d3ee', barHeight: 6,
    rounded: 24, srcW: 480, srcH: 270, totalDuration: 4,
  });

  await test('46. 进度条 + 圆角边框 MP4 装饰', 'decorateMedia', {
    input: testVideo2, progressBar: 'top', barColor: '#f43f5e', barHeight: 8,
    rounded: 32, bgColor: '#000000', srcW: 1280, srcH: 720, totalDuration: 6,
  }, (i) => { if (i.width !== 1280 || !i.hasAudio) throw new Error('MP4 装饰异常'); });

  await test('47. 智能切分长视频-均分3段(精确)', 'splitVideo', {
    input: testVideo2, mode: 'count', count: 3, precise: true, hasAudio: true, totalDuration: 6,
  }, () => {
    const dir = path.join(TMP, 'test2_切片');
    const parts = fs.readdirSync(dir).filter((f) => f.endsWith('.mp4'));
    if (parts.length !== 3) throw new Error(`应切出 3 段，实际 ${parts.length} 段`);
  });

  await test('48. 智能切分长视频-固定时长(无损)', 'splitVideo', {
    input: testVideo, mode: 'duration', every: 4, precise: false, hasAudio: true, totalDuration: 10,
  }, () => {
    const dir = path.join(TMP, 'test_切片');
    const parts = fs.readdirSync(dir).filter((f) => f.endsWith('.mp4'));
    if (parts.length < 2) throw new Error(`切片数量过少: ${parts.length}`);
  });

  await test('49. 多段剪辑-删掉中间片段 (精确)', 'multiCut', {
    input: testVideo, mode: 'remove', precise: true,
    segments: [{ start: 2, end: 5 }, { start: 7, end: 8 }],
    hasAudio: true, totalDuration: 10,
  }, (i) => { if (Math.abs(i.duration - 6) > 0.8) throw new Error(`删掉4s后应剩约6s，实际 ${i.duration}s`); });

  await test('50. 多段剪辑-保留多段拼接 (无损)', 'multiCut', {
    input: testVideo, mode: 'keep', precise: false,
    segments: [{ start: 0, end: 2 }, { start: 6, end: 8 }],
    hasAudio: true, totalDuration: 10,
  }, (i) => { if (i.duration < 2.5) throw new Error(`多段拼接时长异常: ${i.duration}s`); });

  const letterbox = path.join(TMP, 'letterbox.mp4');
  run(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=4',
    '-vf', 'pad=640:480:0:60:black', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', letterbox]);
  await test('51. 自动去黑边 (640x480 上下黑边 → 640x360)', 'autoCrop', {
    input: letterbox, srcW: 640, srcH: 480, totalDuration: 4,
  }, (i) => { if (i.height >= 460) throw new Error(`黑边未被裁除，高度仍为 ${i.height}`); });

  await test('52. 分屏对比 (左右 hstack)', 'pipSplit', {
    input: testVideo, second: testVideo2, mode: 'hstack', audioMode: 'first',
    srcW: 1280, srcH: 720, hasAudio: true, secondHasAudio: true, totalDuration: 10,
  }, (i) => { if (i.width !== 2560 || i.height !== 720) throw new Error(`左右分屏应为 2560x720，实际 ${i.width}x${i.height}`); });

  await test('53. 画中画 (右下角小窗 + 混合声音)', 'pipSplit', {
    input: testVideo, second: testGif, mode: 'pip', pipPos: 'br', pipScale: '0.25', audioMode: 'mix',
    srcW: 1280, srcH: 720, hasAudio: true, secondHasAudio: false, totalDuration: 10,
  }, (i) => { if (i.width !== 1280) throw new Error('画中画尺寸异常'); });

  await test('54. 调色微调与防抖 (MP4)', 'colorStab', {
    input: testVideo2, brightness: 0.1, contrast: 1.2, saturation: 1.3,
    sharpen: 'light', stabilize: 'deshake', totalDuration: 6,
  }, (i) => { if (i.width !== 1280) throw new Error('调色尺寸异常'); });

  await test('55. 音频-人声降噪 & 响度标准化', 'audioAdjust', {
    input: testVideo2, mode: 'denoise', hasAudio: true, totalDuration: 6,
  }, (i) => { if (!i.hasAudio) throw new Error('降噪后应有音轨'); });

  await test('56. 音频-响度标准化 (loudnorm)', 'audioAdjust', {
    input: testVideo, mode: 'loudnorm', hasAudio: true, totalDuration: 10,
  }, (i) => { if (!i.hasAudio) throw new Error('标准化后应有音轨'); });

  const srtFile = path.join(TMP, 'sub.srt');
  fs.writeFileSync(srtFile, '1\n00:00:00,200 --> 00:00:03,500\n测试字幕 Hello Subtitle\n', 'utf8');
  await test('57. 硬字幕压制 (SRT 烧录)', 'subtitleTool', {
    input: testVideo2, mode: 'burn', subtitle: srtFile, fontSize: 24, marginV: 24, totalDuration: 6,
  }, (i) => { if (i.width !== 1280) throw new Error('字幕烧录输出异常'); });

  const mkvWithSub = path.join(TMP, 'with_sub.mkv');
  run(['-i', testVideo2, '-i', srtFile, '-c:v', 'copy', '-c:a', 'copy', '-c:s', 'srt', mkvWithSub]);
  await test('58. 提取内嵌字幕 (.srt)', 'subtitleTool', {
    input: mkvWithSub, mode: 'extract', subIndex: 0, hasSubtitles: true, totalDuration: 6,
  }, () => {
    const out = path.join(TMP, 'with_sub_字幕.srt');
    const txt = fs.readFileSync(out, 'utf8');
    if (!txt.includes('Hello Subtitle')) throw new Error('提取的字幕内容不匹配');
  });

  await test('59. GIF 逐帧全部拆解', 'snapshot', {
    input: testGif, mode: 'all', totalDuration: 4,
  }, () => {
    const dir = path.join(TMP, 'test_全部帧');
    const n = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).length;
    if (n < 30) throw new Error(`4s@15fps 应拆出约60帧，实际 ${n}`);
  });

  await test('60. 九宫格预览墙 (3x3 + 时间戳)', 'contactSheet', {
    input: testVideo, layout: '3x3', cellWidth: 320, timestamps: 'yes', format: 'jpg', totalDuration: 10,
  }, (i) => { if (i.width < 960) throw new Error(`3x3 宽度应 >= 960，实际 ${i.width}`); });

  const metaVid = path.join(TMP, 'with_meta.mp4');
  run(['-i', testVideo2, '-c', 'copy', '-metadata', 'title=SecretCamera', '-metadata', 'comment=GPS_LOC', metaVid]);
  await test('61. 清除隐私元数据 + 自定义 output 子目录', 'stripMeta', {
    input: metaVid, totalDuration: 6, __outputMode: 'subdir',
  }, () => {
    const out = path.join(TMP, 'output', 'with_meta_去元数据.mp4');
    if (!fs.existsSync(out)) throw new Error('output 子目录未生效');
    const pr = spawnSync(path.join(path.dirname(FFMPEG), 'ffprobe.exe'), ['-v', 'quiet', '-show_format', out]);
    if (pr.stdout.toString().includes('SecretCamera')) throw new Error('元数据未被清除');
  });

  // 此时 TMP/test_clip.mp4 已存在（用例 7/8 生成），开启 __noOverwrite 应自动生成 _1.mp4 而不覆盖
  await test('62. 防覆盖编号：已存在同名输出文件时自动 _1 递增', 'trimVideo', {
    input: testVideo, start: 0, duration: 2, precise: false, __noOverwrite: true,
  }, () => {
    const out1 = path.join(TMP, 'test_clip_1.mp4');
    if (!fs.existsSync(out1)) throw new Error('防覆盖自动编号 _1.mp4 未生成');
  });

  // 此时 TMP/test_全部帧 已存在（用例 59 生成），开启 __noOverwrite 应自动生成 _1 目录
  await test('63. 防覆盖编号：已存在同名输出文件夹时自动 _1 递增', 'snapshot', {
    input: testGif, mode: 'all', totalDuration: 4, __noOverwrite: true,
  }, () => {
    const dir1 = path.join(TMP, 'test_全部帧_1');
    if (!fs.existsSync(dir1)) throw new Error('防覆盖自动编号 _1 文件夹未生成');
    const n = fs.readdirSync(dir1).filter((f) => f.endsWith('.png')).length;
    if (n < 30) throw new Error(`_1 文件夹内帧数异常: ${n}`);
  });

  // ============ 第四批：图片模块与通用工具图片兼容 ============

  const alphaImg = path.join(TMP, 'alpha_src.png');
  run(['-f', 'lavfi', '-i', 'color=c=0x00000000:size=600x400:rate=1:duration=1',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=1:duration=1',
    '-filter_complex', '[0:v]format=rgba[bg];[1:v]format=rgba[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2',
    '-frames:v', '1', alphaImg]);

  await test('64. 图片格式转换 PNG→WebP (限制最长边 400)', 'imageConvert', {
    input: alphaImg, format: 'webp', quality: 'medium', resizeMode: 'maxSide', maxSide: 400, stripMeta: 'yes',
  }, (i) => { if (i.width !== 400 || !i.isImage) throw new Error(`应为 400px 图片，实际 ${i.width} isImage=${i.isImage}`); });

  await test('65. 图片格式转换 透明PNG→JPG (白底防变黑)', 'imageConvert', {
    input: alphaImg, format: 'jpg', quality: 'high', resizeMode: 'keep', bgColor: '#ffffff', stripMeta: 'yes',
  }, (i) => { if (i.width !== 600 || i.height !== 400) throw new Error(`尺寸异常 ${i.width}x${i.height}`); });

  await test('66. 图片 PNG 8-bit 调色板量化瘦身', 'imageConvert', {
    input: img1, format: 'png', quality: 'png8', resizeMode: 'percent', percent: 50, stripMeta: 'yes',
  }, (i) => { if (i.width !== 220) throw new Error(`50% 缩放后应为 220，实际 ${i.width}`); });

  await test('67. 图片转 Windows ICO 图标 (128x128)', 'imageConvert', {
    input: alphaImg, format: 'ico', icoSize: 128, stripMeta: 'yes',
  }, (i) => { if (i.width !== 128 || i.height !== 128) throw new Error(`ICO 尺寸应为 128x128，实际 ${i.width}x${i.height}`); });

  await test('68. 图片转 AVIF', 'imageConvert', {
    input: img2, format: 'avif', quality: 'medium', resizeMode: 'keep', stripMeta: 'yes',
  }, (i) => { if (i.width !== 480) throw new Error(`AVIF 尺寸异常 ${i.width}`); });

  const bigPhoto = path.join(TMP, 'big_photo.png');
  run(['-f', 'lavfi', '-i', 'testsrc2=size=1200x900:rate=1:duration=1', '-frames:v', '1', bigPhoto]);
  await test('69. 图片压缩到指定体积 (目标 80KB JPG)', 'imageCompressTarget', {
    input: bigPhoto, targetKB: 80, format: 'jpg', bgColor: '#ffffff', srcW: 1200, srcH: 900,
  }, () => {
    const out = path.join(TMP, 'big_photo_80KB.jpg');
    const kb = fs.statSync(out).size / 1024;
    if (kb > 85) throw new Error(`压缩后 ${kb.toFixed(1)}KB，超出 80KB 目标`);
  });

  await test('70. 多图纵向长图拼接 (3张不同尺寸)', 'imageStitch', {
    files: [img1, img2, img3],
    infos: [{ width: 440, height: 300 }, { width: 480, height: 300 }, { width: 520, height: 300 }],
    mode: 'vertical', gap: 10, format: 'jpg', bgColor: '#ffffff',
  }, (i) => { if (i.width !== 540 || i.height < 900) throw new Error(`长图拼接尺寸异常 ${i.width}x${i.height}`); });

  await test('71. 多图 2×2 网格拼图 (3张图自动补位)', 'imageStitch', {
    files: [img1, img2, img3],
    infos: [{ width: 440, height: 300 }, { width: 480, height: 300 }, { width: 520, height: 300 }],
    mode: 'grid', cols: 2, fit: 'cover', cellRatio: '1:1', cellSize: 300, gap: 8, format: 'png', bgColor: 'transparent',
  }, (i) => { if (i.width < 600 || i.height < 600) throw new Error(`网格拼图尺寸异常 ${i.width}x${i.height}`); });

  await test('72. 九宫格切图 (3×3 导出 9 张)', 'imageSplit', {
    input: bigPhoto, mode: '3x3', format: 'png', srcW: 1200, srcH: 900,
  }, () => {
    const dir = path.join(TMP, 'big_photo_切图');
    const slices = fs.readdirSync(dir).filter((f) => f.endsWith('.png'));
    if (slices.length !== 9) throw new Error(`应切出 9 张，实际 ${slices.length}`);
  });

  const whiteBgImg = path.join(TMP, 'white_bg.png');
  run(['-f', 'lavfi', '-i', 'color=c=white:size=300x300:rate=1:duration=1',
    '-f', 'lavfi', '-i', 'color=c=red:size=100x100:rate=1:duration=1',
    '-filter_complex', '[0:v][1:v]overlay=(W-w)/2:(H-h)/2', '-frames:v', '1', whiteBgImg]);
  await test('73. 纯色抠图透明 PNG (白底→透明)', 'imageCutout', {
    input: whiteBgImg, color: '#ffffff', similarity: 0.18, blend: 0.06, format: 'png',
  }, (i) => { if (i.width !== 300 || i.height !== 300) throw new Error('抠图尺寸异常'); });

  await test('74. 图片圆角与边框留白', 'imageFrame', {
    input: img2, rounded: 32, padding: 24, format: 'png', bgColor: 'transparent', srcW: 480, srcH: 300,
  }, (i) => { if (i.width !== 528 || i.height !== 348) throw new Error(`加边框后应为 528x348，实际 ${i.width}x${i.height}`); });

  await test('75. 画面裁剪兼容静态图片 (精确奇数像素)', 'videoCrop', {
    input: bigPhoto, crop: { w: 401, h: 301, x: 100, y: 100 }, srcW: 1200, srcH: 900,
  }, (i) => { if (i.width !== 401 || i.height !== 301) throw new Error(`应为 401x301，实际 ${i.width}x${i.height}`); });

  await test('76. 局部马赛克打码兼容静态图片', 'videoBlur', {
    input: bigPhoto, crop: { w: 200, h: 150, x: 50, y: 50 }, srcW: 1200, srcH: 900, mode: 'mosaic', strength: 'strong',
  }, (i) => { if (i.width !== 1200 || i.height !== 900) throw new Error('图片尺寸不应变化'); });

  await test('77. 比例适配 1:1 模糊背景兼容静态图片', 'aspectPad', {
    input: img2, ratio: '1:1', bg: 'blur',
  }, (i) => { if (i.width !== 1080 || i.height !== 1080) throw new Error(`应为 1080x1080，实际 ${i.width}x${i.height}`); });

  await test('78. 添加文字水印兼容静态图片', 'watermark', {
    input: bigPhoto, mode: 'text', text: 'PhotoWaterMark', pos: 'br', size: 'medium', opacity: '0.7', srcW: 1200, srcH: 900,
  }, (i) => { if (i.width !== 1200) throw new Error('水印图尺寸异常'); });

  await test('79. 旋转 90° & 调色兼容静态图片', 'rotateFlip', {
    input: img2, mode: 'r90',
  }, (i) => { if (i.width !== 300 || i.height !== 480) throw new Error(`旋转后应为 300x480，实际 ${i.width}x${i.height}`); });

  // SVG 矢量模块测试
  const testSvg = path.join(TMP, 'sample.svg');
  fs.writeFileSync(testSvg, `<?xml version="1.0" encoding="UTF-8"?>
<!-- editor comment to strip -->
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
  <metadata>Created by Editor</metadata>
  <g>
    <rect x="10.000" y="10.000" width="80.1234" height="80.5678" rx="12" fill="#6366f1"/>
    <circle cx="150" cy="50" r="35" fill="#22d3ee"/>
  </g>
</svg>`, 'utf8');

  const svgProbeInfo = await probe(testSvg);
  if (!svgProbeInfo.isSvg || svgProbeInfo.width !== 200 || svgProbeInfo.height !== 100) {
    throw new Error(`SVG probe 异常: ${JSON.stringify(svgProbeInfo)}`);
  }

  await test('80. SVG→PNG (2× 倍率透明输出)', 'svgToRaster', {
    input: testSvg, format: 'png', scaleMode: 'scale', scale: 2, bgColor: 'transparent',
  }, (i) => { if (i.width !== 400 || i.height !== 200) throw new Error(`应为 400x200，实际 ${i.width}x${i.height}`); });

  await test('81. SVG→JPG (指定宽度 600 + 白底)', 'svgToRaster', {
    input: testSvg, format: 'jpg', scaleMode: 'width', width: 600, quality: 'high', bgColor: '#ffffff',
  }, (i) => { if (i.width !== 600 || i.height !== 300) throw new Error(`应为 600x300，实际 ${i.width}x${i.height}`); });

  await test('82. SVG→WebP (限制最长边 300)', 'svgToRaster', {
    input: testSvg, format: 'webp', scaleMode: 'maxSide', maxSide: 300, quality: 'medium', bgColor: 'transparent',
  }, (i) => { if (i.width !== 300 || i.height !== 150) throw new Error(`应为 300x150，实际 ${i.width}x${i.height}`); });

  await test('83. SVG→ICO (64×64)', 'svgToRaster', {
    input: testSvg, format: 'ico', scaleMode: 'original', icoSize: 64, bgColor: 'transparent',
  }, (i) => { if (i.width !== 64 || i.height !== 64) throw new Error(`ICO 应为 64x64，实际 ${i.width}x${i.height}`); });

  await test('84. SVG 压缩优化 (SVGO 瘦身)', 'svgOptimize', {
    input: testSvg, preset: 'default', floatPrecision: 2, multipass: true, keepViewBox: true, stripDims: false,
  }, (i) => {
    const optPath = path.join(TMP, 'sample_opt.svg');
    const rawSz = fs.statSync(testSvg).size;
    const optSz = fs.statSync(optPath).size;
    if (!i.isSvg || optSz >= rawSz) throw new Error(`优化后未缩小: ${rawSz} -> ${optSz}`);
  });

  await test('85. 位图→SVG (黑白单色剪影描摹)', 'imageToSvg', {
    input: whiteBgImg, mode: 'bw', smooth: 'medium', transparentBg: 'alpha', maxDim: 400, noiseFilter: 8, optimizeSvg: true,
  }, (i) => {
    const outPath = path.join(TMP, 'white_bg_vector.svg');
    const txt = fs.readFileSync(outPath, 'utf8');
    if (!i.isSvg || !/<path/i.test(txt)) throw new Error('黑白描摹未生成有效 <path>');
  });

  await test('86. 位图→SVG (多彩插画矢量描摹)', 'imageToSvg', {
    input: img2, mode: 'poster', colors: 8, smooth: 'medium', transparentBg: 'none', maxDim: 400, noiseFilter: 8, optimizeSvg: true,
  }, (i) => {
    if (!i.isSvg || i.width !== 400) throw new Error(`多彩描摹 SVG 信息异常: ${JSON.stringify(i)}`);
  });

  // 文档提取图片测试（Word .docx & Markdown .md）
  const AdmZip = require('adm-zip');
  const testDocx = path.join(TMP, 'sample.docx');
  const docZip = new AdmZip();
  docZip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>', 'utf8'));
  docZip.addFile('word/_rels/document.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/second.jpg"/>
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/first.png"/>
</Relationships>`, 'utf8'));
  docZip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body><w:p><w:r><w:drawing r:embed="rId2"/></w:r><w:r><w:drawing r:embed="rId1"/></w:r></w:p></w:body>
</w:document>`, 'utf8'));
  docZip.addFile('word/media/first.png', fs.readFileSync(img1));
  docZip.addFile('word/media/second.jpg', fs.readFileSync(bigPhoto));
  docZip.writeZip(testDocx);

  const docxProbe = await probe(testDocx);
  if (!docxProbe.isDoc || docxProbe.docType !== 'docx' || docxProbe.imageCount !== 2) {
    throw new Error(`DOCX probe 异常: ${JSON.stringify(docxProbe)}`);
  }

  await test('87. Word (.docx) 识别并按文档顺序提取图片', 'docExtractImages', {
    input: testDocx, naming: 'order', remoteMode: 'skip', includeSvg: true, dedupe: true,
  }, () => {
    const dir = path.join(TMP, 'sample_提取图片');
    const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
    if (files.length !== 2 || !files[0].startsWith('01_second') || !files[1].startsWith('02_first')) {
      throw new Error(`DOCX 提取顺序异常: ${JSON.stringify(files)}`);
    }
    if (!fs.existsSync(path.join(dir, '.vgt-manifest.json'))) {
      throw new Error('缺少 .vgt-manifest.json 映射文件');
    }
  });

  const mdAsset = path.join(TMP, 'md space asset.png');
  fs.copyFileSync(alphaImg, mdAsset);
  const b64Png = fs.readFileSync(img1).toString('base64');
  const testMd = path.join(TMP, 'notes.md');
  fs.writeFileSync(testMd, `# 测试文档
![本地图1](./img1.png)
![含空格本地图](<./md space asset.png> "title")
<img src="data:image/png;base64,${b64Png}" alt="b64_chart" />
![参考图][refimg]
![远程图](https://example.com/remote.png)
<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>

\`\`\`markdown
![代码里的示例图不该被误识别](fake.png)
\`\`\`

[refimg]: ./img2.png
`, 'utf8');

  const mdProbe = await probe(testMd);
  if (!mdProbe.isDoc || mdProbe.docType !== 'md' || mdProbe.docStats.local !== 3 || mdProbe.docStats.dataUri !== 1 || mdProbe.docStats.inlineSvg !== 1 || mdProbe.docStats.remote !== 1) {
    throw new Error(`MD probe 异常: ${JSON.stringify(mdProbe)}`);
  }

  await test('88. Markdown (.md) 识别并提取本地/Base64/内联SVG图片', 'docExtractImages', {
    input: testMd, naming: 'order', remoteMode: 'skip', includeSvg: true, dedupe: true,
  }, () => {
    const dir = path.join(TMP, 'notes_提取图片');
    const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
    if (files.length !== 5) {
      throw new Error(`MD 应导出 5 张图，实际 ${files.length}: ${JSON.stringify(files)}`);
    }
  });

  // 89. Word 一键压缩瘦身 (docCompressImages)
  const bigPng = path.join(TMP, 'big_screen.png');
  run(['-f', 'lavfi', '-i', 'testsrc2=size=1600x1000:duration=0.1', '-frames:v', '1', bigPng]);
  const heavyDocx = path.join(TMP, 'heavy.docx');
  const heavyZip = new AdmZip();
  heavyZip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>', 'utf8'));
  heavyZip.addFile('word/_rels/document.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/screen.png"/>
</Relationships>`, 'utf8'));
  heavyZip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body><w:p><w:r><w:drawing r:embed="rId1"/></w:r></w:p></w:body>
</w:document>`, 'utf8'));
  heavyZip.addFile('word/media/screen.png', fs.readFileSync(bigPng));
  heavyZip.writeZip(heavyDocx);

  await test('89. Word (.docx) 一键压缩瘦身并放回原位', 'docCompressImages', {
    input: heavyDocx, preset: 'balanced', maxSide: '1280', formatMode: 'auto',
  }, (i) => {
    const outDocx = path.join(TMP, 'heavy_已压缩.docx');
    const origSz = fs.statSync(heavyDocx).size;
    const newSz = fs.statSync(outDocx).size;
    if (!i.isDoc || i.imageCount !== 1 || newSz >= origSz) {
      throw new Error(`Word 压缩未有效减小体积: ${origSz} -> ${newSz}, probe=${JSON.stringify(i)}`);
    }
    const checkZip = new AdmZip(outDocx);
    const relsXml = checkZip.getEntry('word/_rels/document.xml.rels').getData().toString('utf8');
    if (!/media\/screen\.jpg/i.test(relsXml)) {
      throw new Error(`格式转 JPG 后 rels 未同步更新: ${relsXml}`);
    }
  });

  // 90. 提取图片处理后放回 Word 原位 (docRepackImages)
  const extractDir = path.join(TMP, 'sample_提取图片');
  const editedImg = path.join(extractDir, '01_second_压缩.jpg');
  fs.copyFileSync(img2, editedImg);
  await test('90. 提取后修改的图片放回 Word 原位', 'docRepackImages', {
    input: testDocx, replaceDir: extractDir,
  }, (i) => {
    const repackedDocx = path.join(TMP, 'sample_已回填.docx');
    if (!i.isDoc || i.imageCount !== 2) {
      throw new Error(`回填后 DOCX probe 异常: ${JSON.stringify(i)}`);
    }
    const z = new AdmZip(repackedDocx);
    const embedded = z.getEntry('word/media/second.jpg')?.getData();
    if (!embedded || !embedded.equals(fs.readFileSync(img2))) {
      throw new Error('回填后的 word/media/second.jpg 内容未更新为修改版图片');
    }
  });

  // 91. PPT (.pptx) 按幻灯片顺序提取图片
  const testPptx = path.join(TMP, 'deck.pptx');
  const heavyClipMov = path.join(TMP, 'clip.mov');
  run(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=2', '-c:v', 'mjpeg', '-q:v', '2', heavyClipMov]);
  const pptZip = new AdmZip();
  pptZip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="mov" ContentType="video/quicktime"/></Types>', 'utf8'));
  pptZip.addFile('ppt/_rels/presentation.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>`, 'utf8'));
  pptZip.addFile('ppt/presentation.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>
</p:presentation>`, 'utf8'));
  pptZip.addFile('ppt/slides/_rels/slide1.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/pic_b.png"/>
</Relationships>`, 'utf8'));
  pptZip.addFile('ppt/slides/slide1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree><p:pic><p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic></p:spTree></p:cSld>
</p:sld>`, 'utf8'));
  pptZip.addFile('ppt/slides/_rels/slide2.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/pic_a.jpg"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="../media/clip.mov"/>
</Relationships>`, 'utf8'));
  pptZip.addFile('ppt/slides/slide2.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree><p:pic><p:blipFill><a:blip r:embed="rId1"/><a:videoFile r:link="rId2"/></p:blipFill></p:pic></p:spTree></p:cSld>
</p:sld>`, 'utf8'));
  pptZip.addFile('ppt/media/pic_a.jpg', fs.readFileSync(img2));
  pptZip.addFile('ppt/media/pic_b.png', fs.readFileSync(bigPng));
  pptZip.addFile('ppt/media/clip.mov', fs.readFileSync(heavyClipMov));
  pptZip.writeZip(testPptx);

  const pptxProbe = await probe(testPptx);
  if (!pptxProbe.isDoc || pptxProbe.docType !== 'pptx' || pptxProbe.imageCount !== 2 || pptxProbe.videoCount !== 1) {
    throw new Error(`PPTX probe 异常: ${JSON.stringify(pptxProbe)}`);
  }

  await test('91. PPT (.pptx) 按幻灯片顺序提取图片', 'docExtractImages', {
    input: testPptx, naming: 'order', pptMedia: 'images', remoteMode: 'skip', includeSvg: true, dedupe: true,
  }, () => {
    const dir = path.join(TMP, 'deck_提取图片');
    const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
    if (files.length !== 2 || !files[0].startsWith('01_pic_b') || !files[1].startsWith('02_pic_a')) {
      throw new Error(`PPTX 提取顺序异常: ${JSON.stringify(files)}`);
    }
    if (!fs.existsSync(path.join(dir, '.vgt-manifest.json'))) {
      throw new Error('PPT 提取缺少 .vgt-manifest.json');
    }
  });

  // 92. PPT (.pptx) 一键压缩瘦身（图片 + 内嵌视频）
  await test('92. PPT (.pptx) 一键压缩瘦身（图片+视频）', 'docCompressImages', {
    input: testPptx, preset: 'balanced', maxSide: '1280', formatMode: 'auto', videoMode: 'compress',
  }, (i) => {
    const outPptx = path.join(TMP, 'deck_已压缩.pptx');
    const origSz = fs.statSync(testPptx).size;
    const newSz = fs.statSync(outPptx).size;
    if (!i.isDoc || i.docType !== 'pptx' || i.imageCount !== 2 || newSz >= origSz) {
      throw new Error(`PPT 压缩未有效减小体积: ${origSz} -> ${newSz}, probe=${JSON.stringify(i)}`);
    }
    const z = new AdmZip(outPptx);
    const r1 = z.getEntry('ppt/slides/_rels/slide1.xml.rels').getData().toString('utf8');
    const r2 = z.getEntry('ppt/slides/_rels/slide2.xml.rels').getData().toString('utf8');
    if (!/\.\.\/media\/pic_b\.jpg/i.test(r1) || !/\.\.\/media\/clip\.mp4/i.test(r2)) {
      throw new Error(`PPT 压缩后 rels 未同步更新: r1=${r1} r2=${r2}`);
    }
  });

  // 93. 提取图片修改后放回 PPT 原位
  const pptExtractDir = path.join(TMP, 'deck_提取图片');
  fs.copyFileSync(img2, path.join(pptExtractDir, '01_pic_b_已改.jpg'));
  await test('93. 提取后修改的图片放回 PPT 原位', 'docRepackImages', {
    input: testPptx, replaceDir: pptExtractDir,
  }, (i) => {
    const repackedPptx = path.join(TMP, 'deck_已回填.pptx');
    if (!i.isDoc || i.docType !== 'pptx' || i.imageCount !== 2) {
      throw new Error(`回填后 PPTX probe 异常: ${JSON.stringify(i)}`);
    }
    const z = new AdmZip(repackedPptx);
    const embedded = z.getEntry('ppt/media/pic_b.jpg')?.getData();
    if (!embedded || !embedded.equals(fs.readFileSync(img2))) {
      throw new Error('回填后的 ppt/media/pic_b.jpg 内容未更新为修改版图片');
    }
  });

  // 94. GIF 截取（按时间段 1.0s~2.5s）
  await test('94. GIF 截取 (按时间段 1.0s~2.5s)', 'trimGif', {
    input: testGif, mode: 'time', start: 1, duration: 1.5, fps: 0, colors: 256, loop: 0, totalDuration: 4,
  }, (i) => {
    if (Math.abs(i.duration - 1.5) > 0.25) throw new Error(`截取后时长 ${i.duration}s 应约为 1.5s`);
  });

  // 95. GIF 截取（按帧序号 第 5~19 帧 = 15 帧）
  await test('95. GIF 截取 (按帧序号 5~19 帧)', 'trimGif', {
    input: testGif, mode: 'frames', startFrame: 5, endFrame: 19, fps: 0, colors: 128, loop: -1, srcFps: 15, nbFrames: 60, totalDuration: 4,
  }, (i) => {
    if (i.nbFrames !== 15) throw new Error(`应截取 15 帧，实际 ${i.nbFrames} 帧`);
  });

  // 96. PPT (.pptx) 按指定页/章节提取图片
  const slide2OutDir = path.join(TMP, 'deck_slide2_提取图片');
  await test('96. PPT (.pptx) 按指定页提取图片', 'docExtractImages', {
    input: testPptx, output: slide2OutDir, naming: 'order', pptMedia: 'images', sectionIds: ['slide_2'],
  }, () => {
    const files = fs.readdirSync(slide2OutDir).filter((f) => !f.startsWith('.'));
    if (files.length !== 1 || !files[0].startsWith('01_pic_a')) {
      throw new Error(`按页提取结果异常: ${JSON.stringify(files)}`);
    }
  });

  // 97. 图片更换背景（白底抠除换证件蓝底）
  await test('97. 图片更换背景 (白底→纯蓝底)', 'imageReplaceBg', {
    input: whiteBgImg, bgType: 'solid', bgColor: '#438edb', fgMode: 'auto', keyColor: '#ffffff', cutoutScope: 'edge', similarity: 0.18, blend: 0.06, format: 'png',
  }, (i) => { if (i.width !== 300 || i.height !== 300) throw new Error(`换背景尺寸异常: ${i.width}x${i.height}`); });

  // 98. 图片更换背景（透明PNG叠加自定义背景图片）
  const cutoutPng = path.join(TMP, 'white_bg_透明抠图.png');
  await test('98. 图片更换背景 (透明图→自定义图片背景)', 'imageReplaceBg', {
    input: cutoutPng, bgType: 'image', bgImage: bigPhoto, bgFit: 'cover', fgMode: 'auto', format: 'jpg',
  }, (i) => { if (i.width !== 300 || i.height !== 300) throw new Error(`图片背景尺寸异常: ${i.width}x${i.height}`); });

  // 99. 图片更换背景（以背景图原宽高为画布，不裁剪背景）
  await test('99. 图片更换背景 (背景原宽高不裁剪)', 'imageReplaceBg', {
    input: cutoutPng, bgType: 'image', bgImage: bigPhoto, bgFit: 'bgOriginal', fgScale: 'fitAuto', fgPos: 'bottom', fgMode: 'keepAlpha', format: 'png',
  }, (i) => { if (i.width !== 1200 || i.height !== 900) throw new Error(`背景原宽高模式尺寸应为 1200x900，实际: ${i.width}x${i.height}`); });

  // 100. PPT (.pptx) 按指定页压缩（仅压缩第2页，第1页图片保持原样）
  const pptSlide2Cmp = path.join(TMP, 'deck_slide2_已压缩.pptx');
  await test('100. PPT (.pptx) 按指定页压缩', 'docCompressImages', {
    input: testPptx, output: pptSlide2Cmp, preset: 'balanced', maxSide: '1280', formatMode: 'auto', videoMode: 'compress', sectionIds: ['slide_2'],
  }, () => {
    const z = new AdmZip(pptSlide2Cmp);
    const picB = z.getEntry('ppt/media/pic_b.png')?.getData();
    if (!picB || !picB.equals(fs.readFileSync(bigPng))) {
      throw new Error('未选中的第1页图片 pic_b.png 不应被压缩或改名');
    }
    if (!z.getEntry('ppt/media/clip.mp4')) {
      throw new Error('所选第2页的 clip.mov 应已被压缩为 clip.mp4');
    }
  });

  // 101. Word (.docx) 按指定章节压缩（仅压缩第二章，第一章图片保持原样）
  const secDocx = path.join(TMP, 'sectioned_cmp.docx');
  const secDocZip = new AdmZip();
  secDocZip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/contenttypes">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`, 'utf8'));
  secDocZip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`, 'utf8'));
  secDocZip.addFile('word/_rels/document.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/sec1.png"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/sec2.png"/>
</Relationships>`, 'utf8'));
  secDocZip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:r><w:t>第一章 背景</w:t></w:r></w:p>
    <w:p><w:r><w:drawing r:embed="rId1"/></w:r></w:p>
    <w:p><w:r><w:t>第二章 实验</w:t></w:r></w:p>
    <w:p><w:r><w:drawing r:embed="rId2"/></w:r></w:p>
  </w:body>
</w:document>`, 'utf8'));
  secDocZip.addFile('word/media/sec1.png', fs.readFileSync(bigPhoto));
  secDocZip.addFile('word/media/sec2.png', fs.readFileSync(bigPng));
  secDocZip.writeZip(secDocx);

  const secDocxCmp = path.join(TMP, 'sectioned_sec2_已压缩.docx');
  await test('101. Word (.docx) 按指定章节压缩', 'docCompressImages', {
    input: secDocx, output: secDocxCmp, preset: 'balanced', maxSide: '1280', formatMode: 'auto', sectionKeyword: '第二章',
  }, () => {
    const z = new AdmZip(secDocxCmp);
    const sec1Data = z.getEntry('word/media/sec1.png')?.getData();
    if (!sec1Data || !sec1Data.equals(fs.readFileSync(bigPhoto))) {
      throw new Error('未选中的第一章图片 word/media/sec1.png 应保持原样不变');
    }
    const sec2Orig = fs.readFileSync(bigPng).length;
    const sec2New = (z.getEntry('word/media/sec2.jpg') || z.getEntry('word/media/sec2.png'))?.getData();
    if (!sec2New || sec2New.length >= sec2Orig) {
      throw new Error(`所选第二章图片应已被压缩，原 ${sec2Orig}B，现 ${sec2New?.length || 0}B`);
    }
  });

  // 102. Word (.docx) 清理孤立冗余媒体与重复图片去重 (docCleanupMedia)
  const dirtyDocx = path.join(TMP, 'dirty_cleanup.docx');
  const dirtyZip = new AdmZip();
  dirtyZip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/media/orphan.png" ContentType="image/png"/>
</Types>`, 'utf8'));
  dirtyZip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`, 'utf8'));
  dirtyZip.addFile('word/_rels/document.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/dup_a.png"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/dup_b.png"/>
</Relationships>`, 'utf8'));
  dirtyZip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:r><w:drawing r:embed="rId1"/></w:r></w:p>
    <w:p><w:r><w:drawing r:embed="rId2"/></w:r></w:p>
  </w:body>
</w:document>`, 'utf8'));
  dirtyZip.addFile('word/media/dup_a.png', fs.readFileSync(bigPng));
  dirtyZip.addFile('word/media/dup_b.png', fs.readFileSync(bigPng));
  dirtyZip.addFile('word/media/orphan.png', fs.readFileSync(bigPhoto));
  dirtyZip.writeZip(dirtyDocx);

  const cleanedDocx = path.join(TMP, 'dirty_已清理.docx');
  await test('102. Word (.docx) 清理孤立冗余媒体与重复图片去重', 'docCleanupMedia', {
    input: dirtyDocx, output: cleanedDocx, removeOrphans: true, dedupeMedia: true,
  }, (i) => {
    if (!i.isDoc || i.imageCount !== 1) {
      throw new Error(`清理后应仅剩 1 份唯一有效图片，实际 ${JSON.stringify(i)}`);
    }
    const z = new AdmZip(cleanedDocx);
    if (z.getEntry('word/media/orphan.png') || z.getEntry('word/media/dup_b.png') || !z.getEntry('word/media/dup_a.png')) {
      throw new Error('清理后媒体条目不符合预期');
    }
    const rels = z.getEntry('word/_rels/document.xml.rels').getData().toString('utf8');
    if (/media\/dup_b\.png/i.test(rels) || !/Id="rId2"[^>]*Target="media\/dup_a\.png"/i.test(rels)) {
      throw new Error(`去重后 rels 未重写 rId2 -> media/dup_a.png: ${rels}`);
    }
    const ct = z.getEntry('[Content_Types].xml').getData().toString('utf8');
    if (/\/word\/media\/orphan\.png/i.test(ct)) {
      throw new Error('[Content_Types].xml 未移除已删 orphan Override');
    }
  });

  // 103. Word (.docx) 指定章节图片统一美化（圆角边框 + 中文水印）
  const styledDocx = path.join(TMP, 'sectioned_sec2_已美化.docx');
  await test('103. Word (.docx) 指定章节图片统一美化（圆角边框+中文水印）', 'docStyleImages', {
    input: secDocx, output: styledDocx,
    frameMode: 'roundedBorder', radius: 20, borderWidth: 16, borderColor: '#ffffff',
    wmText: '内部资料·严禁外传', wmPos: 'br', wmSize: 'medium', wmOpacity: '0.5', wmColor: 'white',
    sectionKeyword: '第二章',
  }, async () => {
    const z = new AdmZip(styledDocx);
    const sec1Data = z.getEntry('word/media/sec1.png')?.getData();
    if (!sec1Data || !sec1Data.equals(fs.readFileSync(bigPhoto))) {
      throw new Error('未选中的第一章图片 sec1.png 应保持原样不变');
    }
    const sec2Entry = z.getEntry('word/media/sec2.png');
    if (!sec2Entry) throw new Error('美化后的 word/media/sec2.png 缺失');
    const sec2Tmp = path.join(TMP, 'sec2_styled_check.png');
    fs.writeFileSync(sec2Tmp, sec2Entry.getData());
    const sec2Info = await probe(sec2Tmp);
    // bigPng 为 1600x1000，加上 borderWidth=16 双边应为 1632x1032
    if (sec2Info.width !== 1632 || sec2Info.height !== 1032) {
      throw new Error(`加边框美化后 sec2 尺寸应为 1632x1032，实际 ${sec2Info.width}x${sec2Info.height}`);
    }
  });

  // 104. Markdown 图片整理（一键本地化 + 清理资源子目录未使用图 + Base64 单文件内嵌）
  const mdOrgDir = path.join(TMP, 'md_organize');
  fs.mkdirSync(mdOrgDir, { recursive: true });
  const mdSrcImg = path.join(TMP, 'md_outside_src.png');
  fs.copyFileSync(img1, mdSrcImg);
  const siblingKeepImg = path.join(mdOrgDir, 'sibling_keep.png');
  fs.copyFileSync(img2, siblingKeepImg);
  const mdOrgInput = path.join(mdOrgDir, 'doc.md');
  fs.writeFileSync(mdOrgInput, `# 整理测试
![外部图](../md_outside_src.png)
<img src="data:image/png;base64,${b64Png}" alt="b64" />
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="14" fill="blue"/></svg>
![远程保留](https://example.com/keep.png)

\`\`\`markdown
![代码里不要动](https://example.com/fake.png)
\`\`\`
`, 'utf8');

  const mdLocalizedOut = path.join(mdOrgDir, 'doc_已本地化.md');
  await test('104a. Markdown 图片整理 - 一键本地化', 'mdOrganizeImages', {
    input: mdOrgInput, output: mdLocalizedOut, action: 'localize', assetsDirName: 'assets', remoteMode: 'skip', inlineSvgMode: 'extract',
  }, () => {
    const body = fs.readFileSync(mdLocalizedOut, 'utf8');
    if (/data:image\/png;base64,/.test(body) || /<svg\b/i.test(body)) {
      throw new Error('Base64 与内联 SVG 应已被本地化并重写路径');
    }
    if (!body.includes('![代码里不要动](https://example.com/fake.png)')) {
      throw new Error('围栏代码块内容不应被误修改');
    }
    const assetsDir = path.join(mdOrgDir, 'assets');
    const saved = fs.readdirSync(assetsDir);
    if (saved.length < 3) {
      throw new Error(`assets 目录应包含至少 3 个本地化资源文件，实际 ${JSON.stringify(saved)}`);
    }
  });

  const orphanInAssets = path.join(mdOrgDir, 'assets', 'orphan_unused.png');
  fs.copyFileSync(img2, orphanInAssets);
  await test('104b. Markdown 图片整理 - 安全清理未使用图片', 'mdOrganizeImages', {
    input: mdLocalizedOut, action: 'cleanUnused', cleanAction: 'move',
  }, () => {
    if (fs.existsSync(orphanInAssets)) {
      throw new Error('assets/orphan_unused.png 应已被移入 _已清理冗余');
    }
    if (!fs.existsSync(siblingKeepImg)) {
      throw new Error('同级目录中的非资源子目录图片 sibling_keep.png 不应被误删或移动');
    }
    const trashDir = path.join(mdOrgDir, '_已清理冗余');
    if (!fs.existsSync(trashDir) || !fs.readdirSync(trashDir).length) {
      throw new Error('_已清理冗余 目录应包含被移走的冗余图片');
    }
  });

  const mdInlineOut = path.join(mdOrgDir, 'doc_内嵌图.md');
  await test('104c. Markdown 图片整理 - 转 Base64 单文件内嵌', 'mdOrganizeImages', {
    input: mdLocalizedOut, output: mdInlineOut, action: 'inlineBase64', remoteMode: 'skip',
  }, () => {
    const body = fs.readFileSync(mdInlineOut, 'utf8');
    if (!/data:image\/png;base64,/.test(body) || !/data:image\/svg\+xml;base64,/.test(body)) {
      throw new Error('Base64 内嵌模式未正确生成 png 与 svg+xml Data URI');
    }
  });

  // 105. 多图合并为 PDF (imagesToPdf)
  const outPdf = path.join(TMP, 'merged_doc.pdf');
  await test('105. 多图合并为 PDF (A4竖向)', 'imagesToPdf', {
    files: [img1, bigPhoto, img2], output: outPdf, pageSize: 'a4p', margin: 20, quality: 'medium', bgColor: '#ffffff',
  }, (i) => {
    if (!i.isDoc || i.docType !== 'pdf' || i.pageCount !== 3) {
      throw new Error(`PDF probe 异常: ${JSON.stringify(i)}`);
    }
    const raw = fs.readFileSync(outPdf).toString('latin1');
    if (!raw.startsWith('%PDF-1.4') || !raw.trim().endsWith('%%EOF')) {
      throw new Error('生成的 PDF 文件头尾结构不完整');
    }
  });

  // 106. 转场合并 (mergeVideos xfade，自动探测时长模式 & 叠化转场)
  await test('106. 转场合并 MP4 (xfade 叠化)', 'mergeVideos', {
    files: [testVideo, testVideo2], mode: 'xfade', transition: 'fade', transDur: 1,
  }, (i) => {
    // 10s + 6s - 1s 转场重叠 ≈ 15s
    if (!i.hasAudio) throw new Error('转场合并后应保留音轨');
    if (Math.abs(i.duration - 15) > 0.8) throw new Error(`转场合并时长 ${i.duration} 应约 15s`);
  });

  // 107. 视频淡入淡出 MP4 (黑场 + 音画同步)
  await test('107. 视频淡入淡出 MP4', 'videoFade', {
    input: testVideo, fadeIn: 1, fadeOut: 1.5, color: 'black', syncAudio: 'yes',
    hasAudio: true, totalDuration: 10,
  }, (i) => {
    if (!i.hasAudio) throw new Error('应保留音轨');
    if (Math.abs(i.duration - 10) > 0.4) throw new Error(`时长应约为 10s，实际 ${i.duration}`);
  });

  // 108. GIF 淡入淡出 (白场)
  await test('108. GIF 白场淡入淡出', 'videoFade', {
    input: testGif, fadeIn: 0.5, fadeOut: 0.5, color: 'white', syncAudio: 'no',
    hasAudio: false, totalDuration: 4,
  });

  // 109. 一键画面滤镜 MP4 (电影青橙 + 轻度暗角)
  await test('109. 一键画面滤镜 MP4 (电影青橙+暗角)', 'videoFilter', {
    input: testVideo, preset: 'cinema', vignette: 'light', sharpen: 'none', totalDuration: 10,
  }, (i) => {
    if (i.width !== 1280 || !i.hasAudio) throw new Error('分辨率与音轨应完整保留');
  });

  // 110a. 一键画面滤镜 GIF (复古胶片)
  await test('110a. 一键画面滤镜 GIF (复古胶片)', 'videoFilter', {
    input: testGif, preset: 'vintage', vignette: 'none', sharpen: 'light', totalDuration: 4,
  });

  // 110b. 一键画面滤镜 PNG (黑白+强暗角)
  await test('110b. 一键画面滤镜 PNG (黑白+强暗角)', 'videoFilter', {
    input: img1, preset: 'bw', vignette: 'strong', sharpen: 'none', totalDuration: 0,
  }, (i) => {
    if (!i.isImage || i.width <= 0) throw new Error('滤镜输出图片无效');
  });

  // 111. 视频加标题 - 胶囊底条 + 仅片头前 3 秒
  await test('111. 视频加标题 MP4 (胶囊底条+定时)', 'videoText', {
    input: testVideo, text: '片头标题:测试100%', style: 'pill', pos: 'bottom', size: 'medium',
    color: 'yellow', timing: 'intro3', srcH: 720, totalDuration: 10,
  }, (i) => {
    if (i.width !== 1280 || i.height !== 720 || !i.hasAudio) throw new Error('尺寸或音轨异常');
  });

  // 112. 视频加标题 - 电影上下黑边模式（高度应增加）
  await test('112. 视频加标题 MP4 (电影上下黑边)', 'videoText', {
    input: testVideo, text: 'Cinema Title\\n第二行副标题', style: 'cinema', pos: 'bottom', size: 'large',
    color: 'white', timing: 'all', srcH: 720, totalDuration: 10,
  }, (i) => {
    if (i.height <= 720) throw new Error(`电影黑边模式高度应大于 720，实际 ${i.height}`);
  });

  // 113. 视频加标题 - 顶部醒目标题栏 + 自定义时段
  await test('113. 视频加标题 MP4 (顶部标题栏+自定义时段)', 'videoText', {
    input: testVideo, text: '重点片段提示', style: 'banner', pos: 'top', size: 'medium',
    color: 'cyan', timing: 'custom', start: 1, end: 4, srcH: 720, totalDuration: 10,
  }, (i) => {
    if (i.width !== 1280 || i.height !== 720) throw new Error('顶部标题栏尺寸应保持 1280x720');
  });

  console.log(failed ? `\n❌ ${failed} 个用例失败` : '\n🎉 全部通过');
  process.exit(failed ? 1 : 0);
})();
