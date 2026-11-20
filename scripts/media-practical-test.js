'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { executeTask, probe, ensureBinaries, FFMPEG } = require('../ffmpeg');
const videoBuilders = require('../modules/video');

function runBin(args) {
  const res = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || `ffmpeg failed with ${res.status}`);
}

function extractGifDelaysCs(gifPath) {
  const buf = fs.readFileSync(gifPath);
  const delays = [];
  for (let i = 0; i < buf.length - 6; i++) {
    if (buf[i] === 0x21 && buf[i + 1] === 0xf9 && buf[i + 2] === 0x04) {
      delays.push(buf.readUInt16LE(i + 4));
    }
  }
  return delays;
}

async function main() {
  ensureBinaries();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt-media-practical-'));
  try {
    const mp4 = path.join(dir, 'src60.mp4');
    const gif50 = path.join(dir, 'src50.gif');
    const png1 = path.join(dir, 'img1.png');
    const png2 = path.join(dir, 'img2.png');
    const png3 = path.join(dir, 'img3.png');
    const jpgOdd = path.join(dir, 'odd.jpg');

    runBin(['-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=60:duration=0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4]);
    runBin(['-i', mp4, '-vf', 'fps=50,split[a][b];[a]palettegen[p];[b][p]paletteuse', gif50]);
    runBin(['-f', 'lavfi', '-i', 'color=c=red@0.8:s=96x64', '-vf', 'format=rgba', '-frames:v', '1', '-update', '1', png1]);
    runBin(['-f', 'lavfi', '-i', 'color=c=green@0.8:s=96x64', '-vf', 'format=rgba', '-frames:v', '1', '-update', '1', png2]);
    runBin(['-f', 'lavfi', '-i', 'color=c=blue@0.8:s=96x64', '-vf', 'format=rgba', '-frames:v', '1', '-update', '1', png3]);
    runBin(['-f', 'lavfi', '-i', 'color=c=blue@1:s=97x65', '-vf', 'drawbox=x=10:y=10:w=20:h=15:color=white:t=fill', '-frames:v', '1', '-update', '1', jpgOdd]);

    // 1. 视频转 GIF 支持 50 / 33 fps
    const r50 = await executeTask('mp-gif50', 'videoToGif', {
      input: mp4, start: 0, duration: 0.4, fps: 50, width: 96, colors: 128,
      output: path.join(dir, 'out50.gif'),
    });
    const d50 = extractGifDelaysCs(r50.output);
    assert(d50.length >= 18, `50fps GIF 帧数不足: ${d50.length}`);
    assert(d50.every((d) => d === 2), `50fps GIF 延迟应全为 2cs: ${JSON.stringify(d50)}`);

    const r33 = await executeTask('mp-gif33', 'videoToGif', {
      input: mp4, start: 0, duration: 0.4, fps: 33, width: 96, colors: 128,
      output: path.join(dir, 'out33.gif'),
    });
    const d33 = extractGifDelaysCs(r33.output);
    assert(d33.length >= 12, `33fps GIF 帧数不足: ${d33.length}`);
    assert(d33.every((d) => d === 3), `33fps GIF 延迟应全为 3cs: ${JSON.stringify(d33)}`);

    // 1b. 视频转 GIF 多档 / 按比例 / 自定义 / 保持原宽宽度
    const rRatioWithSrc = await executeTask('mp-gif-p50-src', 'videoToGif', {
      input: mp4, start: 0, duration: 0.4, fps: 15, width: 'p50', srcW: 96, colors: 128,
    });
    assert.equal((await probe(rRatioWithSrc.output)).width, 48, 'p50 (with srcW) 输出宽度应为 48');

    const rRatioNoSrc = await executeTask('mp-gif-p50-nosrc', 'videoToGif', {
      input: mp4, start: 0, duration: 0.4, fps: 15, width: 'p50', colors: 128,
    });
    assert.equal((await probe(rRatioNoSrc.output)).width, 48, 'p50 (without srcW) 输出宽度应为 48');

    const rCustomEven = await executeTask('mp-gif-custom-even', 'videoToGif', {
      input: mp4, start: 0, duration: 0.4, fps: 15, width: 'custom', customWidth: 140, colors: 128,
    });
    assert.equal((await probe(rCustomEven.output)).width, 140, 'customWidth 140 输出宽度应为 140');

    const rCustomOdd = await executeTask('mp-gif-custom-odd', 'videoToGif', {
      input: mp4, start: 0, duration: 0.4, fps: 15, width: 'custom', customWidth: 141, colors: 128,
    });
    assert.equal((await probe(rCustomOdd.output)).width, 142, 'customWidth 141 应偶对齐为 142');

    const rKeepNoSrc = await executeTask('mp-gif-keep-nosrc', 'videoToGif', {
      input: mp4, start: 0, duration: 0.4, fps: 15, width: '0', colors: 128,
    });
    assert.equal((await probe(rKeepNoSrc.output)).width, 96, '保持原宽 (without srcW) 输出宽度应为 96');

    const plan2560 = videoBuilders.videoToGif({ input: mp4, width: 'custom', customWidth: 2560 });
    assert(plan2560.steps[0].args.join(' ').includes('scale=2560:-2:flags=lanczos'), '2560 customWidth 应生成对应 scale');
    const planClamp = videoBuilders.videoToGif({ input: mp4, width: 'custom', customWidth: 5000 });
    assert(planClamp.steps[0].args.join(' ').includes('scale=3840:-2:flags=lanczos'), '超过 3840 的 customWidth 应限制为 3840');

    // 2. GIF 压缩保持 50fps 与自定义 50fps
    const gifInfo = await probe(gif50);
    assert(gifInfo.fps >= 49, `探测 50fps GIF 帧率异常: ${gifInfo.fps}`);
    const compKeep = await executeTask('mp-comp-keep', 'compressGif', {
      input: gif50, width: 96, fps: gifInfo.fps, srcFps: gifInfo.fps, srcW: 96,
      colors: 128, dither: 'bayer5', statsMode: 'diff', diffMode: 'rectangle',
      totalDuration: gifInfo.duration, output: path.join(dir, 'comp_keep.gif'),
    });
    const dKeep = extractGifDelaysCs(compKeep.output);
    assert(dKeep.every((d) => d === 2), `GIF 压缩保持原帧率未保留 50fps: ${JSON.stringify(dKeep)}`);

    const compCustom = await executeTask('mp-comp-custom', 'compressGif', {
      input: gif50, width: 96, fps: 'custom', customFps: 50, srcFps: gifInfo.fps, srcW: 96,
      colors: 128, dither: 'bayer5', statsMode: 'diff', diffMode: 'rectangle',
      totalDuration: gifInfo.duration, output: path.join(dir, 'comp_custom.gif'),
    });
    assert(extractGifDelaysCs(compCustom.output).every((d) => d === 2));

    // 3. GIF 截取 50 fps
    const trim50 = await executeTask('mp-trim50', 'trimGif', {
      input: gif50, mode: 'time', start: 0, duration: 0.3, fps: 50, colors: 256,
      totalDuration: gifInfo.duration, output: path.join(dir, 'trim50.gif'),
    });
    assert(extractGifDelaysCs(trim50.output).every((d) => d === 2));

    // 4. WebP 60 fps
    const webp60 = await executeTask('mp-webp60', 'toWebp', {
      input: mp4, start: 0, duration: 0.4, fps: 60, width: 96, quality: 75,
      totalDuration: 0.4, output: path.join(dir, 'out60.webp'),
    });
    assert(fs.statSync(webp60.output).size > 200);

    // 5. APNG 60 fps -> GIF 50 fps
    const apng60 = await executeTask('mp-apng60', 'animSprite', {
      input: mp4, mode: 'toApng', fps: 60, width: 96, totalDuration: 0.4,
      output: path.join(dir, 'out60.apng'),
    });
    const apngInfo = await probe(apng60.output);
    assert(apngInfo.isApng && apngInfo.fps >= 55, `APNG 60fps 异常: ${JSON.stringify(apngInfo)}`);

    const apng2gif = await executeTask('mp-apng2gif', 'animSprite', {
      input: apng60.output, mode: 'apngToGif', fps: 50, width: 96, colors: 256,
      totalDuration: apngInfo.duration, output: path.join(dir, 'apng2gif50.gif'),
    });
    assert(extractGifDelaysCs(apng2gif.output).every((d) => d === 2));

    // 6. 图片合成 GIF 50 fps
    const imgs50 = await executeTask('mp-imgs50', 'imagesTo', {
      files: [png1, png2, png3], format: 'gif', fps: 50,
      sizes: { [png1]: { w: 96, h: 64 }, [png2]: { w: 96, h: 64 }, [png3]: { w: 96, h: 64 } },
      output: path.join(dir, 'imgs50.gif'),
    });
    assert(extractGifDelaysCs(imgs50.output).every((d) => d === 2));

    // 7. 局部去台标 (delogo)，包含贴边与全屏边界保护
    const delogoCases = [
      ['mp4-normal', mp4, { x: 20, y: 15, w: 30, h: 20 }, 96, 64, 'dl_norm.mp4'],
      ['mp4-tl', mp4, { x: 0, y: 0, w: 30, h: 20 }, 96, 64, 'dl_tl.mp4'],
      ['mp4-br', mp4, { x: 66, y: 44, w: 30, h: 20 }, 96, 64, 'dl_br.mp4'],
      ['mp4-full', mp4, { x: 0, y: 0, w: 96, h: 64 }, 96, 64, 'dl_full.mp4'],
      ['gif-tl', gif50, { x: 0, y: 0, w: 30, h: 20 }, 96, 64, 'dl_gif.gif'],
      ['png-rgba', png1, { x: 0, y: 0, w: 30, h: 20 }, 96, 64, 'dl_png.png'],
      ['jpg-odd', jpgOdd, { x: 0, y: 0, w: 97, h: 65 }, 97, 65, 'dl_odd.jpg'],
    ];
    for (const [label, input, crop, srcW, srcH, outName] of delogoCases) {
      const res = await executeTask(`mp-delogo-${label}`, 'videoBlur', {
        input, crop, srcW, srcH, mode: 'delogo', totalDuration: 0.4,
        output: path.join(dir, outName),
      });
      const outInfo = await probe(res.output);
      assert.equal(outInfo.width, srcW, `${label} 输出宽度异常`);
      assert.equal(outInfo.height, srcH, `${label} 输出高度异常`);
    }

    console.log('MEDIA_PRACTICAL_TEST_OK');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
