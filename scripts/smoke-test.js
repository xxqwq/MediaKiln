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

  console.log(failed ? `\n❌ ${failed} 个用例失败` : '\n🎉 全部通过');
  process.exit(failed ? 1 : 0);
})();
