'use strict';
// 冒烟测试：生成测试视频与 GIF，逐一执行 7 个功能并校验输出
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { probe, executeTask, FFMPEG } = require('../ffmpeg');

const TMP = path.join(__dirname, 'smoke');
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

  console.log(failed ? `\n❌ ${failed} 个用例失败` : '\n🎉 全部通过');
  process.exit(failed ? 1 : 0);
})();
