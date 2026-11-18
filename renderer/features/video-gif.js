(() => {
'use strict';

window.VGT = window.VGT || {};

const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'ts', 'm4v'];
const IMG_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif'];
const AUDIO_EXTS = ['mp3', 'm4a', 'wav', 'flac', 'aac', 'ogg', 'opus'];

window.VGT.VIDEO_EXTS = VIDEO_EXTS;
window.VGT.IMG_EXTS = IMG_EXTS;
window.VGT.AUDIO_EXTS = AUDIO_EXTS;

const rt = (f) => window.VGT.params.readTimes(f);

window.VGT.VIDEO_FEATURES = [
  // ================= 转换 =================
  {
    id: 'videoToGif', group: '转换', icon: '🎞️', name: '视频转 GIF', desc: '选段转高质量动图（调色板两遍编码）',
    accept: VIDEO_EXTS,
    fields: [
      { type: 'times' },
      { key: 'fps', label: '帧率', type: 'select', def: '15',
        options: [['10', '10 fps（体积小）'], ['12', '12 fps'], ['15', '15 fps（推荐）'], ['20', '20 fps'], ['24', '24 fps（流畅）']] },
      { key: 'width', label: '宽度', type: 'select', def: '480',
        options: [['320', '320 px'], ['480', '480 px（推荐）'], ['640', '640 px'], ['800', '800 px'], ['0', '保持原宽']] },
      { key: 'colors', label: '颜色数', type: 'select', def: '128',
        options: [['64', '64 色（最小）'], ['128', '128 色（推荐）'], ['256', '256 色（最佳画质）']] },
    ],
    collect(v, ctx) {
      const t = rt(ctx.file);
      return {
        input: ctx.file.path, start: t.start, duration: t.duration, end: t.end,
        fps: v.fps, width: v.width === '0' ? ctx.file.info.width : v.width, colors: v.colors,
      };
    },
  },
  {
    id: 'gifToVideo', group: '转换', icon: '🎬', name: 'GIF 转视频', desc: '转成 MP4（手机可播）或 WebM',
    accept: ['gif'],
    fields: [
      { key: 'format', label: '输出格式', type: 'chips', def: 'mp4', options: [['mp4', 'MP4（推荐）'], ['webm', 'WebM（更小）']] },
    ],
    collect(v, ctx) {
      return { input: ctx.file.path, format: v.format, totalDuration: ctx.file.info.duration };
    },
  },
  {
    id: 'toWebp', group: '转换', icon: '🖼️', name: 'WebP 动图', desc: '视频/GIF 转动画 WebP，比 GIF 小 30~50%',
    accept: [...VIDEO_EXTS, 'gif'],
    fields: [
      { type: 'times' },
      { key: 'fps', label: '帧率', type: 'select', def: '15',
        options: [['10', '10 fps'], ['15', '15 fps（推荐）'], ['20', '20 fps'], ['24', '24 fps']] },
      { key: 'width', label: '宽度', type: 'select', def: '480',
        options: [['320', '320 px'], ['480', '480 px（推荐）'], ['640', '640 px'], ['0', '保持原宽']] },
      { key: 'quality', label: '画质', type: 'chips', def: '75', options: [['60', '体积优先'], ['75', '均衡（推荐）'], ['90', '画质优先']] },
    ],
    collect(v, ctx) {
      const t = rt(ctx.file);
      const whole = t.duration >= ctx.file.info.duration - 0.05;
      return {
        input: ctx.file.path, start: t.start,
        duration: whole ? 0 : t.duration,
        totalDuration: ctx.file.info.duration,
        fps: v.fps, width: v.width === '0' ? ctx.file.info.width : v.width, quality: v.quality,
      };
    },
  },
  {
    id: 'convertVideo', group: '转换', icon: '📦', name: '格式转换', desc: 'MP4 / MKV / MOV / WebM 互转，支持无损秒转封装与画质调节',
    accept: VIDEO_EXTS,
    fields: [
      { key: 'mode', label: '转换方式', type: 'chips', def: 'encode',
        options: [['encode', '重编码（可调画质/分辨率）'], ['copy', '无损换容器（秒级零损失）']] },
      { key: 'format', label: '目标格式', type: 'chips', def: 'mp4',
        options: [['mp4', 'MP4'], ['mkv', 'MKV'], ['mov', 'MOV'], ['webm', 'WebM（仅重编码）']] },
      { key: 'vcodec', label: '视频编码', type: 'chips', def: 'h264',
        options: [['h264', 'H.264（兼容性最佳，默认）'], ['hevc', 'H.265 / HEVC（体积省 40%）'], ['av1', 'AV1（新一代高压缩）']],
        showIf: (v) => v.mode !== 'copy' },
      { key: 'height', label: '分辨率', type: 'select', def: '0',
        options: [['0', '保持原始'], ['1080', '1080p'], ['720', '720p'], ['480', '480p']],
        showIf: (v) => v.mode !== 'copy' },
      { key: 'quality', label: '画质', type: 'chips', def: 'medium',
        options: [['high', '高'], ['medium', '中（推荐）'], ['low', '低（文件小）']],
        showIf: (v) => v.mode !== 'copy' },
    ],
    collect(v, ctx) {
      const vcodec = v.vcodec || 'h264';
      if (v.mode !== 'copy' && v.format === 'mov' && vcodec === 'av1') {
        throw new Error('MOV 容器不支持 AV1 编码，请选 MP4 / MKV / WebM 或切换 H.265');
      }
      return { input: ctx.file.path, mode: v.mode, format: v.format, vcodec, height: v.height, quality: v.quality, totalDuration: ctx.file.info.duration };
    },
  },

  // ================= GIF 编辑 =================
  {
    id: 'compressGif', group: 'GIF 编辑', icon: '🗜️', name: 'GIF 压缩', desc: '支持预设一键压缩、比例缩放、去噪去重复帧、抖动与调色板精细控制',
    accept: ['gif'],
    fields: [
      { key: 'preset', label: '快捷预设（点击后仍可继续微调）', type: 'chips', def: 'balanced', fullWidth: true,
        options: [
          ['light', '✨ 高画质轻压'],
          ['balanced', '⚖️ 日常均衡（推荐）'],
          ['extreme', '🔥 极限瘦身'],
          ['sticker', '💬 微信表情包'],
        ],
        applyPresets: {
          light:    { width: '0',   fps: '0',  colors: '256', dither: 'bayer3', statsMode: 'diff', denoise: 'none',  dedup: 'no',  diffMode: 'rectangle', speed: '1' },
          balanced: { width: '480', fps: '12', colors: '128', dither: 'bayer5', statsMode: 'diff', denoise: 'none',  dedup: 'no',  diffMode: 'rectangle', speed: '1' },
          extreme:  { width: '320', fps: '8',  colors: '32',  dither: 'none',   statsMode: 'diff', denoise: 'light', dedup: 'yes', diffMode: 'rectangle', speed: '1' },
          sticker:  { width: '240', fps: '8',  colors: '64',  dither: 'none',   statsMode: 'diff', denoise: 'none',  dedup: 'yes', diffMode: 'rectangle', speed: '1' },
        },
      },
      { key: 'width', label: '宽度 / 缩放', type: 'select', def: '480',
        options: [
          ['0', '保持原宽 (100%)'],
          ['p75', '按比例 75%'],
          ['p50', '按比例 50%（宽高减半）'],
          ['p30', '按比例 30%'],
          ['1080', '最大 1080 px'],
          ['800', '最大 800 px'],
          ['640', '最大 640 px'],
          ['480', '最大 480 px（推荐）'],
          ['320', '最大 320 px'],
          ['240', '最大 240 px（表情包）'],
          ['160', '最大 160 px（缩略图）'],
          ['custom', '自定义宽度…'],
        ] },
      { key: 'customWidth', label: '自定义宽度 (px)', type: 'number', def: '400', min: 32, max: 1920, step: 2,
        showIf: (v) => v.width === 'custom' },
      { key: 'fps', label: '帧率 (FPS)', type: 'select', def: '12',
        options: [
          ['0', '保持原帧率'],
          ['p50', '帧率减半（50% 抽帧）'],
          ['24', '24 fps（流畅）'],
          ['20', '20 fps'],
          ['15', '15 fps'],
          ['12', '12 fps（推荐）'],
          ['10', '10 fps'],
          ['8', '8 fps（较小）'],
          ['6', '6 fps'],
          ['5', '5 fps'],
          ['3', '3 fps（幻灯片）'],
          ['custom', '自定义帧率…'],
        ] },
      { key: 'customFps', label: '自定义帧率 (1~30)', type: 'number', def: '10', min: 1, max: 30, step: 1,
        showIf: (v) => v.fps === 'custom' },
      { key: 'colors', label: '调色板颜色数', type: 'select', def: '128',
        options: [
          ['256', '256 色（画质最好）'],
          ['128', '128 色（推荐）'],
          ['64', '64 色（体积明显减小）'],
          ['32', '32 色（卡通/简图）'],
          ['16', '16 色（极限压缩）'],
          ['8', '8 色（极简）'],
        ] },
      { key: 'dither', label: '抖动算法', type: 'select', def: 'bayer5',
        options: [
          ['none', '无抖动（体积最小，纯色最清晰）'],
          ['bayer5', 'Bayer 轻量（推荐均衡）'],
          ['bayer3', 'Bayer 细腻'],
          ['bayer1', 'Bayer 高细腻'],
          ['floyd', 'Floyd-Steinberg（渐变更自然）'],
          ['sierra', 'Sierra2_4a（高画质）'],
        ] },
      { key: 'speed', label: '播放倍速', type: 'select', def: '1',
        options: [
          ['1', '原速 (1x)'],
          ['1.25', '1.25x（微加速）'],
          ['1.5', '1.5x（加速省帧）'],
          ['2', '2x（快放减半体积）'],
          ['0.75', '0.75x（慢放）'],
        ] },
      { key: 'statsMode', label: '调色板统计方式', type: 'chips', def: 'diff',
        options: [['diff', '动态优先（推荐）'], ['full', '全局色彩'], ['single', '逐帧调色（画质最佳）']] },
      { key: 'denoise', label: '降噪优化', type: 'chips', def: 'none',
        options: [['none', '关闭'], ['light', '轻度去噪（更省体积）'], ['strong', '强力去噪']] },
      { key: 'dedup', label: '去重复帧', type: 'chips', def: 'no',
        options: [['no', '保留全部帧'], ['yes', '去除静止重复帧']] },
      { key: 'diffMode', label: '帧间压缩', type: 'chips', def: 'rectangle',
        options: [['rectangle', '局部矩形差分（推荐）'], ['none', '整帧刷新（高兼容）']] },
      { key: 'loop', label: '循环方式', type: 'chips', def: '0',
        options: [['0', '无限循环'], ['-1', '只播 1 次'], ['1', '循环 2 次']] },
      { key: 'useTrim', label: '截取片段', type: 'chips', def: 'no',
        options: [['no', '整段压缩'], ['yes', '只压缩指定时间段']] },
      { type: 'times', showIf: (v) => v.useTrim === 'yes' },
    ],
    collect(v, ctx) {
      const params = {
        input: ctx.file.path,
        width: v.width === '0' ? ctx.file.info.width : v.width,
        customWidth: v.customWidth,
        fps: v.fps === '0' ? (ctx.file.info.fps || 12) : v.fps,
        customFps: v.customFps,
        colors: v.colors, dither: v.dither,
        statsMode: v.statsMode, denoise: v.denoise, dedup: v.dedup,
        diffMode: v.diffMode, speed: v.speed, loop: v.loop,
        srcW: ctx.file.info.width, srcFps: ctx.file.info.fps,
        totalDuration: ctx.file.info.duration,
      };
      if (v.useTrim === 'yes') {
        const t = rt(ctx.file);
        const whole = t.duration >= ctx.file.info.duration - 0.05;
        params.start = t.start;
        params.duration = whole ? 0 : t.duration;
      }
      return params;
    },
  },
  {
    id: 'trimGif', group: 'GIF 编辑', icon: '✂️', name: 'GIF 截取', desc: '按时间段或帧序号截取 GIF 片段（自动保留透明背景与原画质）',
    accept: ['gif'],
    fields: [
      { key: 'mode', label: '截取方式', type: 'chips', def: 'time',
        options: [['time', '按时间段（秒）'], ['frames', '按帧序号']] },
      { type: 'times', showIf: (v) => v.mode !== 'frames' },
      { key: 'startFrame', label: '起始帧（从 1 开始）', type: 'number', def: '1', min: 1, step: 1,
        showIf: (v) => v.mode === 'frames' },
      { key: 'endFrame', label: '结束帧（含该帧）', type: 'number', def: '15', min: 1, step: 1,
        showIf: (v) => v.mode === 'frames' },
      { key: 'fps', label: '帧率', type: 'select', def: '0',
        options: [['0', '保持原帧率（推荐）'], ['24', '24 fps'], ['20', '20 fps'], ['15', '15 fps'], ['12', '12 fps'], ['10', '10 fps'], ['8', '8 fps']] },
      { key: 'colors', label: '调色板颜色数', type: 'select', def: '256',
        options: [['256', '256 色（原画质，推荐）'], ['128', '128 色（均衡）'], ['64', '64 色（体积更小）']] },
      { key: 'loop', label: '循环方式', type: 'chips', def: '0',
        options: [['0', '无限循环'], ['-1', '只播 1 次'], ['1', '循环 2 次']] },
    ],
    collect(v, ctx) {
      if (v.mode === 'frames') {
        return {
          input: ctx.file.path,
          mode: 'frames',
          startFrame: v.startFrame,
          endFrame: v.endFrame,
          fps: v.fps === '0' ? 0 : v.fps,
          colors: v.colors,
          loop: v.loop,
          srcFps: ctx.file.info.fps,
          nbFrames: ctx.file.info.nbFrames || 0,
          totalDuration: ctx.file.info.duration,
        };
      }
      const t = rt(ctx.file);
      return {
        input: ctx.file.path,
        mode: 'time',
        start: t.start,
        duration: t.duration,
        fps: v.fps === '0' ? 0 : v.fps,
        colors: v.colors,
        loop: v.loop,
        totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'gifText', group: 'GIF 编辑', icon: '💬', name: 'GIF 加文字', desc: '给 GIF 打字幕、配梗文字（支持中文）',
    accept: ['gif'],
    fields: [
      { key: 'text', label: '文字内容', type: 'text', def: '', placeholder: '输入要显示的文字…' },
      { key: 'pos', label: '位置', type: 'chips', def: 'bottom', options: [['top', '顶部'], ['center', '居中'], ['bottom', '底部']] },
      { key: 'size', label: '字号', type: 'chips', def: 'medium', options: [['small', '小'], ['medium', '中（推荐）'], ['large', '大']] },
      { key: 'color', label: '颜色', type: 'chips', def: 'white', options: [['white', '白字黑边'], ['yellow', '黄字黑边'], ['black', '黑字白边']] },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path, text: v.text, pos: v.pos, size: v.size,
        color: v.color === 'black' ? 'black' : v.color,
        height: ctx.file.info.height, totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'compressTarget', group: 'GIF 编辑', icon: '🎯', name: '压缩到目标大小', desc: '自动压到指定体积以内（支持微信 / Discord 预设及自定义 0.2~500 MB）',
    accept: [...VIDEO_EXTS, 'gif'],
    fields: [
      { key: 'targetMB', label: '目标大小 (MB)', type: 'number', def: '5', min: 0.2, max: 500, step: 0.1,
        presets: [['1', '1 MB'], ['2', '2 MB'], ['5', '5 MB'], ['10', '10 MB（Discord）'], ['25', '25 MB（微信）'], ['50', '50 MB']] },
      { key: 'vcodec', label: '视频编码（GIF 自动忽略）', type: 'chips', def: 'h264',
        options: [['h264', 'H.264（默认兼容）'], ['hevc', 'H.265 / HEVC（小体积更清晰）']],
        showIf: (_v, ctx) => !ctx?.isImage && !ctx?.isGif },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path, targetMB: v.targetMB,
        vcodec: v.vcodec || 'h264',
        width: ctx.file.info.width, fps: ctx.file.info.fps,
        hasAudio: ctx.file.info.hasAudio, totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'chromaGif', group: 'GIF 编辑', icon: '🪄', name: '绿幕抠像透明 GIF', desc: '抠除绿幕/纯色背景，生成透明底表情包 GIF',
    accept: [...VIDEO_EXTS, 'gif'],
    fields: [
      { key: 'color', label: '要抠除的背景色', type: 'color', def: '#00ff00', eyedropper: true,
        presets: [['#00ff00', '绿幕'], ['#0000ff', '蓝幕'], ['#ffffff', '纯白'], ['#000000', '纯黑']] },
      { key: 'similarity', label: '色彩容差', type: 'range', def: '0.2', min: 0.02, max: 0.5, step: 0.02, unit: '',
        presets: [['0.1', '严谨 0.1'], ['0.2', '适中 0.2'], ['0.32', '宽松 0.32']] },
      { key: 'blend', label: '边缘羽化', type: 'range', def: '0.08', min: 0, max: 0.3, step: 0.02, unit: '',
        presets: [['0', '无'], ['0.08', '柔和 0.08'], ['0.18', '强羽化']] },
      { key: 'width', label: '输出宽度', type: 'select', def: '480',
        options: [['240', '240 px（表情包）'], ['320', '320 px'], ['480', '480 px（推荐）'], ['640', '640 px']] },
      { key: 'fps', label: '帧率', type: 'select', def: '12',
        options: [['8', '8 fps'], ['12', '12 fps（推荐）'], ['15', '15 fps'], ['20', '20 fps']] },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path, color: v.color, similarity: v.similarity, blend: v.blend,
        width: v.width, fps: v.fps, totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'decorateMedia', group: 'GIF 编辑', icon: '✨', name: '进度条 / 圆角装饰', desc: '给 GIF 或视频加顶部/底部播放进度条或圆角透明边框',
    accept: [...VIDEO_EXTS, 'gif'],
    fields: [
      { key: 'progressBar', label: '播放进度条', type: 'chips', def: 'bottom',
        options: [['none', '不加'], ['bottom', '底部进度条'], ['top', '顶部进度条']] },
      { key: 'barColor', label: '进度条颜色', type: 'color', def: '#22d3ee',
        presets: [['#22d3ee', '青色'], ['#6366f1', '靛蓝'], ['#f43f5e', '玫红'], ['#ffffff', '纯白']],
        showIf: (v) => v.progressBar !== 'none' },
      { key: 'barHeight', label: '进度条高度 (px)', type: 'select', def: '6',
        options: [['4', '4 px（细）'], ['6', '6 px（推荐）'], ['10', '10 px（粗）']],
        showIf: (v) => v.progressBar !== 'none' },
      { key: 'rounded', label: '圆角半径', type: 'chips', def: '24',
        options: [['0', '直角'], ['16', '小圆角 16px'], ['24', '中圆角 24px'], ['48', '大圆角 48px']] },
      { key: 'bgColor', label: '视频圆角外底色（GIF 自动透明）', type: 'color', def: '#000000',
        presets: [['#000000', '纯黑'], ['#ffffff', '纯白'], ['#0f1115', '深灰']],
        showIf: (v) => v.rounded !== '0' },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        progressBar: v.progressBar, barColor: v.barColor, barHeight: v.barHeight,
        rounded: v.rounded, bgColor: v.bgColor,
        srcW: ctx.file.info.width, srcH: ctx.file.info.height,
        totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'animSprite', group: 'GIF 编辑', icon: '🧩', name: 'APNG / 雪碧图互转', desc: '视频/GIF 转全彩半透明 APNG，APNG 转 GIF，或导出/还原游戏开发雪碧图 (Sprite Sheet)',
    accept: [...VIDEO_EXTS, 'gif', 'apng', ...IMG_EXTS],
    fields: [
      { key: 'mode', label: '转换方向', type: 'chips', def: 'toApng', fullWidth: true,
        options: [
          ['toApng', '🎬 视频/GIF → APNG 动图'],
          ['apngToGif', '🖼️ APNG → GIF 动图'],
          ['toSprite', '🧩 动图/视频 → 雪碧图 PNG'],
          ['fromSprite', '🔁 雪碧图 PNG → GIF / APNG'],
        ] },
      { key: 'fps', label: '帧率 (FPS)', type: 'select', def: '12',
        options: [['8', '8 fps'], ['10', '10 fps'], ['12', '12 fps（推荐）'], ['15', '15 fps'], ['20', '20 fps'], ['24', '24 fps']] },
      { key: 'width', label: '输出宽度', type: 'select', def: '480',
        options: [['0', '保持原宽'], ['320', '320 px'], ['480', '480 px（推荐）'], ['640', '640 px'], ['800', '800 px']],
        showIf: (v) => v.mode === 'toApng' || v.mode === 'apngToGif' },
      { key: 'colors', label: 'GIF 调色板颜色数', type: 'chips', def: '256',
        options: [['64', '64 色'], ['128', '128 色'], ['256', '256 色（推荐）']],
        showIf: (v) => v.mode === 'apngToGif' },
      { key: 'layout', label: '雪碧图排列', type: 'chips', def: 'grid',
        options: [['grid', '多行网格（推荐）'], ['row', '单行水平排列']],
        showIf: (v) => v.mode === 'toSprite' },
      { key: 'cols', label: '每行列数', type: 'number', def: '5', min: 1, max: 120, step: 1,
        presets: [['4', '4 列'], ['5', '5 列'], ['6', '6 列'], ['8', '8 列']],
        showIf: (v) => (v.mode === 'toSprite' && v.layout !== 'row') || v.mode === 'fromSprite' },
      { key: 'rows', label: '雪碧图行数', type: 'number', def: '4', min: 1, max: 20, step: 1,
        presets: [['2', '2 行'], ['3', '3 行'], ['4', '4 行'], ['5', '5 行']],
        showIf: (v) => v.mode === 'fromSprite' },
      { key: 'cellWidth', label: '单格宽度 (px)', type: 'select', def: '160',
        options: [['120', '120 px'], ['160', '160 px（推荐）'], ['240', '240 px'], ['320', '320 px'], ['0', '保持原宽']],
        showIf: (v) => v.mode === 'toSprite' },
      { key: 'maxFrames', label: '最多抽取帧数', type: 'number', def: '36', min: 2, max: 120, step: 1,
        presets: [['16', '16 帧'], ['25', '25 帧'], ['36', '36 帧'], ['60', '60 帧']],
        showIf: (v) => v.mode === 'toSprite' },
      { key: 'frameCount', label: '有效总帧数（0 = 按行列全满）', type: 'number', def: '0', min: 0, max: 400, step: 1,
        showIf: (v) => v.mode === 'fromSprite' },
      { key: 'outFormat', label: '合成目标格式', type: 'chips', def: 'gif',
        options: [['gif', 'GIF 动图'], ['apng', 'APNG 无损透明动图']],
        showIf: (v) => v.mode === 'fromSprite' },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        mode: v.mode || 'toApng',
        fps: v.fps || '12',
        width: v.width ?? '480',
        colors: v.colors || '256',
        layout: v.layout || 'grid',
        cols: v.cols || '5',
        rows: v.rows || '4',
        cellWidth: v.cellWidth ?? '160',
        maxFrames: v.maxFrames || '36',
        frameCount: v.frameCount || '0',
        outFormat: v.outFormat || 'gif',
        srcW: ctx.file.info.width,
        srcH: ctx.file.info.height,
        totalDuration: ctx.file.info.duration,
      };
    },
  },

  // ================= 剪辑 =================
  {
    id: 'trimVideo', group: '剪辑', icon: '✂️', name: '视频截取', desc: '剪出片段：无损模式秒级完成',
    accept: VIDEO_EXTS,
    fields: [
      { type: 'times' },
      { key: 'precise', label: '截取模式', type: 'chips', def: 'fast',
        options: [['fast', '无损（快，对齐关键帧）'], ['precise', '精确（重编码，帧级准确）']] },
    ],
    collect(v, ctx) {
      const t = rt(ctx.file);
      return { input: ctx.file.path, start: t.start, duration: t.duration, precise: v.precise === 'precise' };
    },
  },
  {
    id: 'multiCut', group: '剪辑', icon: '🎞️', name: '多段保留 / 删片段', desc: '标记多个时间段：保留拼接或删掉中间广告片段',
    accept: VIDEO_EXTS, noBatch: true,
    fields: [
      { key: 'mode', label: '处理方式', type: 'chips', def: 'remove',
        options: [['remove', '删掉选中片段（保留其余拼接）'], ['keep', '只保留选中片段（拼成一条）']] },
      { key: 'precise', label: '切分模式', type: 'chips', def: 'fast',
        options: [['fast', '无损（极速）'], ['precise', '精确（帧准）']] },
      { type: 'multiSegments', fullWidth: true },
    ],
    collect(v, ctx) {
      const segs = window.__segments || [];
      if (!segs.length) throw new Error('请至少添加一个时间段');
      return {
        input: ctx.file.path, mode: v.mode, precise: v.precise === 'precise',
        segments: segs, hasAudio: ctx.file.info.hasAudio, totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'splitVideo', group: '剪辑', icon: '🔪', name: '智能切分长视频', desc: '按固定时长切片，或均匀切分成 N 段（导出到文件夹）',
    accept: VIDEO_EXTS,
    fields: [
      { key: 'mode', label: '切分方式', type: 'chips', def: 'duration',
        options: [['duration', '按固定时长切片'], ['count', '均分成 N 段']] },
      { key: 'every', label: '每段时长（秒）', type: 'number', def: '30', min: 1, max: 3600, step: 1,
        presets: [['15', '15 秒'], ['30', '30 秒'], ['60', '1 分钟'], ['180', '3 分钟']],
        showIf: (v) => v.mode === 'duration' },
      { key: 'count', label: '切分段数', type: 'number', def: '3', min: 2, max: 50, step: 1,
        presets: [['2', '2 段'], ['3', '3 段'], ['4', '4 段'], ['5', '5 段']],
        showIf: (v) => v.mode === 'count' },
      { key: 'precise', label: '切片模式', type: 'chips', def: 'fast',
        options: [['fast', '无损（极速）'], ['precise', '精确（段数严格准确）']] },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path, mode: v.mode, every: v.every, count: v.count,
        precise: v.precise === 'precise', hasAudio: ctx.file.info.hasAudio,
        totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'mergeVideos', group: '剪辑', icon: '🔗', name: '视频合并', desc: '多个视频拼接：支持同规格无损、兼容合并或叠化/滑动转场拼接',
    accept: VIDEO_EXTS, multi: true,
    fields: [
      { key: 'mode', label: '合并模式', type: 'chips', def: 'fast',
        options: [['fast', '无损极速（需同规格）'], ['compat', '兼容拼接（统一分辨率）'], ['xfade', '转场拼接（叠化/滑动）']] },
      { key: 'transition', label: '转场效果', type: 'select', def: 'fade',
        options: [
          ['fade', '交叉叠化（通用推荐）'],
          ['fadeblack', '黑场过渡'],
          ['fadewhite', '白场闪白过渡'],
          ['slideleft', '向左滑动切换'],
          ['slideright', '向右滑动切换'],
          ['wiperight', '从左向右擦除'],
          ['circleopen', '圆形扩散展开'],
          ['dissolve', '像素溶解'],
        ],
        showIf: (v) => v.mode === 'xfade' },
      { key: 'transDur', label: '转场时长（秒）', type: 'chips', def: '0.8',
        options: [['0.4', '0.4 秒'], ['0.8', '0.8 秒（推荐）'], ['1.2', '1.2 秒'], ['1.8', '1.8 秒']],
        showIf: (v) => v.mode === 'xfade' },
    ],
    collect(v, ctx) {
      return {
        files: ctx.files.map((f) => f.path),
        mode: v.mode,
        transition: v.transition,
        transDur: v.transDur,
        infos: ctx.files.map((f) => f.info),
      };
    },
  },
  {
    id: 'videoCrop', group: '剪辑', icon: '🔲', name: '画面裁剪', desc: '在画面上拉框，裁掉多余区域（视频 / GIF / 图片通用）',
    accept: [...VIDEO_EXTS, 'gif', ...IMG_EXTS], noBatch: true,
    fields: [{ type: 'cropCanvas', label: '拖动鼠标框出要保留的区域' }],
    collect(v, ctx) {
      const c = window.__crop;
      if (!c) throw new Error('请先在预览图上拖出裁剪区域');
      return {
        input: ctx.file.path,
        crop: {
          w: Math.round(c.w * ctx.file.info.width), h: Math.round(c.h * ctx.file.info.height),
          x: Math.round(c.x * ctx.file.info.width), y: Math.round(c.y * ctx.file.info.height),
        },
        srcW: ctx.file.info.width, srcH: ctx.file.info.height,
        totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'autoCrop', group: '剪辑', icon: '🧲', name: '自动去黑边', desc: '自动检测视频/GIF 上下左右黑边并一键裁除（支持批量）',
    accept: [...VIDEO_EXTS, 'gif'],
    fields: [],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        srcW: ctx.file.info.width, srcH: ctx.file.info.height,
        totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'videoBlur', group: '剪辑', icon: '🫥', name: '局部打码 / 模糊', desc: '在画面上拉框遮挡水印、人脸或隐私区域（视频 / GIF / 图片通用）',
    accept: [...VIDEO_EXTS, 'gif', ...IMG_EXTS], noBatch: true,
    fields: [
      { type: 'cropCanvas', label: '拖动鼠标框出要打码的区域' },
      { key: 'mode', label: '打码方式', type: 'chips', def: 'blur', options: [['blur', '高斯模糊'], ['mosaic', '像素马赛克']] },
      { key: 'strength', label: '强度', type: 'chips', def: 'medium', options: [['medium', '适中'], ['strong', '强力']] },
    ],
    collect(v, ctx) {
      const c = window.__crop;
      if (!c) throw new Error('请先在预览图上拖出打码区域');
      return {
        input: ctx.file.path,
        crop: {
          w: Math.round(c.w * ctx.file.info.width), h: Math.round(c.h * ctx.file.info.height),
          x: Math.round(c.x * ctx.file.info.width), y: Math.round(c.y * ctx.file.info.height),
        },
        srcW: ctx.file.info.width, srcH: ctx.file.info.height,
        mode: v.mode, strength: v.strength,
        totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'aspectPad', group: '剪辑', icon: '📐', name: '横竖屏比例适配', desc: '一键转 9:16 / 16:9 / 1:1，支持模糊背景填充（视频 / GIF / 图片通用）',
    accept: [...VIDEO_EXTS, 'gif', ...IMG_EXTS],
    fields: [
      { key: 'ratio', label: '目标比例', type: 'chips', def: '9:16',
        options: [['9:16', '9:16 竖屏'], ['16:9', '16:9 横屏'], ['1:1', '1:1 方形'], ['4:3', '4:3'], ['3:4', '3:4']] },
      { key: 'bg', label: '空白填充', type: 'chips', def: 'blur',
        options: [['blur', '模糊背景（推荐）'], ['black', '纯黑底'], ['white', '纯白底']] },
    ],
    collect(v, ctx) {
      return { input: ctx.file.path, ratio: v.ratio, bg: v.bg, totalDuration: ctx.file.info.duration };
    },
  },
  {
    id: 'pipSplit', group: '剪辑', icon: '🪟', name: '分屏对比 / 画中画', desc: '两个视频或 GIF 左右/上下并排对比，或叠加角落小窗',
    accept: [...VIDEO_EXTS, 'gif'],
    fields: [
      { type: 'secondFile', key: 'second', kind: 'videoGifFile', label: '副画面（右/下/小窗）', placeholder: '选择第二个视频或 GIF…' },
      { key: 'mode', label: '排版模式', type: 'chips', def: 'hstack',
        options: [['hstack', '左右分屏'], ['vstack', '上下分屏'], ['pip', '画中画小窗']] },
      { key: 'pipPos', label: '小窗位置', type: 'chips', def: 'br',
        options: [['br', '右下角'], ['bl', '左下角'], ['tr', '右上角'], ['tl', '左上角']],
        showIf: (v) => v.mode === 'pip' },
      { key: 'pipScale', label: '小窗比例', type: 'chips', def: '0.25',
        options: [['0.2', '20%'], ['0.25', '25%（推荐）'], ['0.33', '33%']],
        showIf: (v) => v.mode === 'pip' },
      { key: 'audioMode', label: '声音来源', type: 'chips', def: 'first',
        options: [['first', '保留主视频'], ['second', '用副视频'], ['mix', '双声混合'], ['mute', '静音']] },
    ],
    collect(v, ctx) {
      if (!window.__secondFile) throw new Error('请先选择第二个对比/画中画文件');
      return {
        input: ctx.file.path, second: window.__secondFile,
        mode: v.mode, pipPos: v.pipPos, pipScale: v.pipScale, audioMode: v.audioMode,
        srcW: ctx.file.info.width, srcH: ctx.file.info.height,
        hasAudio: ctx.file.info.hasAudio,
        secondHasAudio: !!window.__secondInfo?.hasAudio,
        totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'colorStab', group: '剪辑', icon: '🎨', name: '调色微调与防抖', desc: '调节亮度、对比度、饱和度、锐化，视频还支持轻量画面防抖',
    accept: [...VIDEO_EXTS, 'gif', ...IMG_EXTS],
    fields: [
      { key: 'brightness', label: '亮度', type: 'range', def: '0', min: -0.5, max: 0.5, step: 0.05, unit: '',
        presets: [['-0.15', '变暗'], ['0', '原图'], ['0.15', '提亮']] },
      { key: 'contrast', label: '对比度', type: 'range', def: '1', min: 0.5, max: 2, step: 0.05, unit: '',
        presets: [['0.8', '柔和'], ['1', '原图'], ['1.25', '通透']] },
      { key: 'saturation', label: '饱和度', type: 'range', def: '1', min: 0, max: 2.5, step: 0.05, unit: '',
        presets: [['0', '黑白'], ['1', '原色'], ['1.4', '鲜艳']] },
      { key: 'sharpen', label: '画面锐化', type: 'chips', def: 'none',
        options: [['none', '关闭'], ['light', '轻度锐化'], ['strong', '强力锐化']] },
      { key: 'stabilize', label: '防抖稳定（视频/GIF）', type: 'chips', def: 'none',
        options: [['none', '关闭'], ['deshake', '开启轻量防抖']],
        showIf: (_v, ctx) => !ctx?.isImage },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        brightness: v.brightness, contrast: v.contrast, saturation: v.saturation,
        sharpen: v.sharpen, stabilize: v.stabilize,
        totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'videoFilter', group: '剪辑', icon: '🎭', name: '一键画面滤镜', desc: '电影青橙、复古胶片、日系清新、黑白高反差等一键色调预设与暗角（视频 / GIF / 图片通用）',
    accept: [...VIDEO_EXTS, 'gif', ...IMG_EXTS],
    fields: [
      { key: 'preset', label: '滤镜风格', type: 'chips', def: 'cinema', fullWidth: true,
        options: [
          ['cinema', '电影青橙'],
          ['vintage', '复古胶片'],
          ['fresh', '日系清新'],
          ['warm', '温暖阳光'],
          ['cool', '清冷蓝调'],
          ['bw', '高反差黑白'],
          ['vivid', '鲜明通透'],
          ['none', '仅加暗角'],
        ] },
      { key: 'vignette', label: '四周暗角', type: 'chips', def: 'light',
        options: [['none', '关闭'], ['light', '轻度暗角（推荐）'], ['strong', '电影重暗角']] },
      { key: 'sharpen', label: '细节清晰度', type: 'chips', def: 'none',
        options: [['none', '保持原画'], ['light', '轻微锐化']] },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        preset: v.preset, vignette: v.vignette, sharpen: v.sharpen,
        totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'videoFade', group: '剪辑', icon: '🌓', name: '视频淡入淡出', desc: '片头黑/白屏渐入、片尾渐出，可选音画同步淡入淡出（支持视频与 GIF）',
    accept: [...VIDEO_EXTS, 'gif'],
    fields: [
      { key: 'fadeIn', label: '片头淡入（秒）', type: 'chips', def: '1',
        options: [['0', '不淡入'], ['0.5', '0.5 秒'], ['1', '1 秒（推荐）'], ['1.5', '1.5 秒'], ['2', '2 秒'], ['3', '3 秒']] },
      { key: 'fadeOut', label: '片尾淡出（秒）', type: 'chips', def: '1',
        options: [['0', '不淡出'], ['0.5', '0.5 秒'], ['1', '1 秒（推荐）'], ['1.5', '1.5 秒'], ['2', '2 秒'], ['3', '3 秒']] },
      { key: 'color', label: '过渡底色', type: 'chips', def: 'black',
        options: [['black', '黑场渐隐（经典）'], ['white', '白场渐隐']] },
      { key: 'syncAudio', label: '声音同步淡入淡出', type: 'chips', def: 'yes',
        options: [['yes', '音画同步（推荐）'], ['no', '仅处理画面']] },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        fadeIn: v.fadeIn, fadeOut: v.fadeOut, color: v.color, syncAudio: v.syncAudio,
        hasAudio: ctx.file.info.hasAudio,
        totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'videoText', group: '剪辑', icon: '🔤', name: '视频加标题字幕', desc: '加胶囊底条、描边花字、电影上下黑边或顶部标题栏（支持中文与按时段显示）',
    accept: VIDEO_EXTS,
    fields: [
      { key: 'text', label: '标题 / 花字内容（支持 \\n 换行）', type: 'text', def: '', placeholder: '输入要显示的标题或字幕…' },
      { key: 'style', label: '显示样式', type: 'chips', def: 'pill', fullWidth: true,
        options: [['pill', '胶囊底条（推荐）'], ['shadow', '描边立体字'], ['cinema', '电影黑边标题'], ['banner', '顶部醒目标题栏']] },
      { key: 'pos', label: '显示位置', type: 'chips', def: 'bottom',
        options: [['top', '顶部'], ['center', '居中'], ['bottom', '底部']],
        showIf: (v) => v.style !== 'banner' },
      { key: 'size', label: '字号大小', type: 'chips', def: 'medium',
        options: [['small', '小'], ['medium', '中（推荐）'], ['large', '大'], ['xlarge', '特大']] },
      { key: 'color', label: '文字颜色', type: 'chips', def: 'white',
        options: [['white', '经典白'], ['yellow', '醒目黄'], ['cyan', '科技青'], ['coral', '活力红'], ['black', '黑字']] },
      { key: 'timing', label: '显示时段', type: 'chips', def: 'all',
        options: [['all', '全程显示'], ['intro3', '仅片头前 3 秒'], ['custom', '自定义时间段']] },
      { key: 'start', label: '开始时间（秒）', type: 'number', def: '0', min: 0, step: 0.5,
        showIf: (v) => v.timing === 'custom' },
      { key: 'end', label: '结束时间（秒）', type: 'number', def: '5', min: 0.1, step: 0.5,
        showIf: (v) => v.timing === 'custom' },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        text: v.text, style: v.style, pos: v.pos, size: v.size, color: v.color,
        timing: v.timing, start: v.start, end: v.end,
        srcH: ctx.file.info.height,
        totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'rotateFlip', group: '剪辑', icon: '🔁', name: '旋转 / 翻转', desc: '转 90°/180° 或水平/垂直镜像（视频 / GIF / 图片通用）',
    accept: [...VIDEO_EXTS, 'gif', ...IMG_EXTS],
    fields: [
      { key: 'mode', label: '方式', type: 'chips', def: 'r90',
        options: [['r90', '右转 90°'], ['r270', '左转 90°'], ['r180', '转 180°'], ['hflip', '左右镜像'], ['vflip', '上下镜像']] },
    ],
    collect(v, ctx) {
      return { input: ctx.file.path, mode: v.mode, totalDuration: ctx.file.info.duration };
    },
  },
  {
    id: 'reverse', group: '剪辑', icon: '◀️', name: '倒放 / 往复', desc: '倒着播放，或"正放+倒放"无缝循环',
    accept: [...VIDEO_EXTS, 'gif'],
    fields: [
      { key: 'mode', label: '模式', type: 'chips', def: 'reverse',
        options: [['reverse', '倒放'], ['boomerang', '往复循环（正放+倒放）']] },
    ],
    collect(v, ctx) {
      return { input: ctx.file.path, mode: v.mode, hasAudio: ctx.file.info.hasAudio, totalDuration: ctx.file.info.duration };
    },
  },
  {
    id: 'changeSpeed', group: '剪辑', icon: '⚡', name: '变速', desc: '0.25x ~ 4x，画面声音同步变速',
    accept: [...VIDEO_EXTS, 'gif'],
    fields: [
      { key: 'speed', label: '倍速', type: 'range', def: '1.5', min: 0.25, max: 4, step: 0.05, unit: 'x',
        presets: [['0.5', '0.5x'], ['1.5', '1.5x'], ['2', '2x'], ['3', '3x'], ['4', '4x']] },
    ],
    collect(v, ctx) {
      return { input: ctx.file.path, speed: v.speed, hasAudio: ctx.file.info.hasAudio, totalDuration: ctx.file.info.duration };
    },
  },

  // ================= 音频 =================
  {
    id: 'extractAudio', group: '音频', icon: '🎵', name: '提取音频', desc: '把视频或音频里的声音存成 MP3 / M4A / WAV / FLAC / OGG / OPUS',
    accept: [...VIDEO_EXTS, ...AUDIO_EXTS],
    fields: [
      { key: 'format', label: '音频格式', type: 'chips', def: 'mp3',
        options: [['mp3', 'MP3（通用）'], ['m4a', 'M4A（音质好）'], ['wav', 'WAV（无损）'], ['flac', 'FLAC（无损压缩）'], ['ogg', 'OGG'], ['opus', 'OPUS（极小）']] },
    ],
    collect(v, ctx) {
      return { input: ctx.file.path, format: v.format, totalDuration: ctx.file.info.duration };
    },
  },
  {
    id: 'audioConvert', group: '音频', icon: '🎚️', name: '音频格式转换', desc: 'MP3 / M4A / WAV / FLAC / OGG / OPUS 互转，支持码率、采样率与声道调节',
    accept: AUDIO_EXTS,
    fields: [
      { key: 'format', label: '目标格式', type: 'chips', def: 'mp3',
        options: [['mp3', 'MP3'], ['m4a', 'M4A'], ['wav', 'WAV（无损）'], ['flac', 'FLAC（无损）'], ['ogg', 'OGG'], ['opus', 'OPUS（超省体积）']] },
      { key: 'bitrate', label: '音频码率', type: 'chips', def: '192k',
        options: [['64k', '64 kb/s'], ['96k', '96 kb/s'], ['128k', '128 kb/s'], ['192k', '192 kb/s'], ['256k', '256 kb/s'], ['320k', '320 kb/s']],
        showIf: (v) => !['wav', 'flac'].includes(v.format) },
      { key: 'sampleRate', label: '采样率', type: 'select', def: '0',
        options: [['0', '保持原始（推荐）'], ['48000', '48000 Hz（视频/播客标准）'], ['44100', '44100 Hz（CD 标准）'], ['24000', '24000 Hz（语音）'], ['16000', '16000 Hz（轻量识别）']] },
      { key: 'channels', label: '声道数', type: 'chips', def: '0',
        options: [['0', '保持原始'], ['2', '双声道立体声'], ['1', '单声道（语音体积减半）']] },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        format: v.format || 'mp3',
        bitrate: v.bitrate || '192k',
        sampleRate: v.sampleRate || '0',
        channels: v.channels || '0',
        totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'audioTrim', group: '音频', icon: '✂️', name: '音频截取', desc: '裁剪音频片段：支持无损秒剪或开启淡入淡出、音量调节',
    accept: AUDIO_EXTS,
    fields: [
      { type: 'times' },
      { key: 'precise', label: '截取模式', type: 'chips', def: 'fast',
        options: [['fast', '无损极速（推荐）'], ['precise', '重编码精确截取']] },
      { key: 'fadeIn', label: '开头淡入（秒）', type: 'chips', def: '0',
        options: [['0', '无'], ['0.5', '0.5 秒'], ['1', '1 秒'], ['2', '2 秒'], ['3', '3 秒']] },
      { key: 'fadeOut', label: '结尾淡出（秒）', type: 'chips', def: '0',
        options: [['0', '无'], ['0.5', '0.5 秒'], ['1', '1 秒'], ['2', '2 秒'], ['3', '3 秒']] },
      { key: 'volume', label: '音量调节', type: 'chips', def: '1',
        options: [['0.5', '0.5x'], ['1', '原音量'], ['1.5', '1.5x'], ['2', '2x']] },
    ],
    collect(v, ctx) {
      const t = ctx.times || rt(ctx.file);
      return {
        input: ctx.file.path,
        start: t.start,
        duration: t.duration,
        precise: v.precise === 'precise',
        fadeIn: v.fadeIn || '0',
        fadeOut: v.fadeOut || '0',
        volume: v.volume || '1',
      };
    },
  },
  {
    id: 'audioMerge', group: '音频', icon: '🔗', name: '音频合并拼接', desc: '多段音频无缝顺序串联，或开启交叉淡入淡出平滑衔接（支持调整顺序）',
    accept: AUDIO_EXTS, multi: true,
    fields: [
      { key: 'mode', label: '拼接方式', type: 'chips', def: 'concat',
        options: [['concat', '直接顺序拼接（推荐）'], ['crossfade', '交叉淡入柔和过渡']] },
      { key: 'fadeDur', label: '过渡淡入时长（秒）', type: 'chips', def: '1',
        options: [['0.5', '0.5 秒'], ['1', '1 秒（推荐）'], ['2', '2 秒'], ['3', '3 秒']],
        showIf: (v) => v.mode === 'crossfade' },
      { key: 'format', label: '输出格式', type: 'chips', def: 'mp3',
        options: [['mp3', 'MP3'], ['m4a', 'M4A'], ['wav', 'WAV（无损）'], ['flac', 'FLAC（无损）'], ['ogg', 'OGG'], ['opus', 'OPUS']] },
    ],
    collect(v, ctx) {
      return {
        files: ctx.files.map((f) => f.path),
        infos: ctx.files.map((f) => f.info),
        mode: v.mode || 'concat',
        fadeDur: v.fadeDur || '1',
        format: v.format || 'mp3',
      };
    },
  },
  {
    id: 'audioAdjust', group: '音频', icon: '🔊', name: '音频调整', desc: '静音、调音量、淡入淡出、人声降噪、响度标准化（画面不重编码）',
    accept: VIDEO_EXTS,
    fields: [
      { key: 'mode', label: '处理方式', type: 'chips', def: 'mute',
        options: [
          ['mute', '静音（去掉声音）'],
          ['volume', '调整音量'],
          ['fade', '淡入淡出'],
          ['denoise', '人声降噪'],
          ['loudnorm', '响度标准化'],
        ] },
      { key: 'volume', label: '音量倍数', type: 'select', def: '2',
        options: [['0.5', '0.5x（减半）'], ['1.5', '1.5x'], ['2', '2x（翻倍）'], ['3', '3x'], ['5', '5x']],
        showIf: (v) => v.mode === 'volume' },
      { key: 'fadeIn', label: '淡入时长（秒）', type: 'select', def: '1',
        options: [['0.5', '0.5 秒'], ['1', '1 秒'], ['2', '2 秒'], ['3', '3 秒']],
        showIf: (v) => v.mode === 'fade' },
      { key: 'fadeOut', label: '淡出时长（秒）', type: 'select', def: '1',
        options: [['0.5', '0.5 秒'], ['1', '1 秒'], ['2', '2 秒'], ['3', '3 秒']],
        showIf: (v) => v.mode === 'fade' },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path, mode: v.mode,
        volume: v.volume, fadeIn: v.fadeIn, fadeOut: v.fadeOut,
        hasAudio: ctx.file.info.hasAudio,
        totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'removeSilence', group: '音频', icon: '🎧', name: '自动去静音 / 剪气口', desc: '智能识别口播视频或录音中的静音停顿与气口并自动剪除拼接，声画精准同步',
    accept: [...VIDEO_EXTS, ...AUDIO_EXTS],
    fields: [
      { key: 'threshold', label: '静音判定阈值', type: 'chips', def: '-35',
        options: [['-30', '-30 dB（环境较吵）'], ['-35', '-35 dB（日常口播，推荐）'], ['-40', '-40 dB（安静录音）'], ['-45', '-45 dB（仅切极静段）']] },
      { key: 'minSilence', label: '最短静音时长', type: 'chips', def: '0.4',
        options: [['0.25', '0.25 秒（紧凑快节奏）'], ['0.4', '0.4 秒（自然口播，推荐）'], ['0.6', '0.6 秒（保留短停顿）'], ['1.0', '1.0 秒（仅删长空白）']] },
      { key: 'padding', label: '气口缓冲留白', type: 'chips', def: '0.12',
        options: [['0.05', '0.05 秒（干脆）'], ['0.12', '0.12 秒（自然不吞字，推荐）'], ['0.25', '0.25 秒（舒缓）']] },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        threshold: v.threshold || '-35',
        minSilence: v.minSilence || '0.4',
        padding: v.padding || '0.12',
        totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'addMusic', group: '音频', icon: '🎼', name: '添加背景音乐', desc: '替换原声或混合，支持人声自动闪避（压低伴奏），音乐自动循环',
    accept: VIDEO_EXTS,
    fields: [
      { type: 'secondFile', key: 'music', kind: 'audioFile', label: '音乐文件', placeholder: '选择 MP3 / WAV / M4A / FLAC / OPUS…' },
      { key: 'mode', label: '混音方式', type: 'chips', def: 'replace',
        options: [['replace', '替换原声'], ['mix', '与原声混合']] },
      { key: 'musicVolume', label: '音乐音量', type: 'select', def: '1',
        options: [['0.3', '0.3x（轻音乐）'], ['0.5', '0.5x'], ['1', '1x（原音量）'], ['1.5', '1.5x']],
        showIf: (v) => v.mode === 'mix' },
      { key: 'ducking', label: '人声智能闪避（广播级混音）', type: 'chips', def: 'no',
        options: [['no', '普通等比例混合'], ['yes', '说话时自动压低背景音（推荐口播）']],
        showIf: (v) => v.mode === 'mix' },
    ],
    collect(v, ctx) {
      const music = window.__secondFile;
      if (!music) throw new Error('请先选择背景音乐文件');
      return {
        input: ctx.file.path, music, mode: v.mode, musicVolume: v.musicVolume,
        ducking: v.ducking || 'no',
        hasAudio: ctx.file.info.hasAudio, totalDuration: ctx.file.info.duration,
      };
    },
  },

  // ================= 工具 =================
  {
    id: 'watermark', group: '工具', icon: '🏷️', name: '添加水印', desc: '加文字或图片 Logo 水印，支持四角、居中或全屏倾斜防盗平铺（视频 / GIF / 图片通用）',
    accept: [...VIDEO_EXTS, 'gif', ...IMG_EXTS],
    fields: [
      { key: 'mode', label: '水印类型', type: 'chips', def: 'text', options: [['text', '文字水印'], ['image', '图片 Logo']] },
      { key: 'text', label: '水印文字', type: 'text', def: '', placeholder: '输入水印文字…', showIf: (v) => v.mode === 'text' },
      { type: 'secondFile', key: 'image', kind: 'imageFile', label: '水印图片', placeholder: '选择 PNG / JPG 透明图标…', showIf: (v) => v.mode === 'image' },
      { key: 'pos', label: '位置', type: 'chips', def: 'br', options: [['br', '右下角'], ['bl', '左下角'], ['tr', '右上角'], ['tl', '左上角'], ['center', '居中'], ['tiled', '全屏平铺']] },
      { key: 'wmColor', label: '文字颜色', type: 'chips', def: 'white',
        options: [['white', '经典白'], ['yellow', '醒目黄'], ['black', '深黑'], ['gray', '半灰']],
        showIf: (v) => v.mode === 'text' },
      { key: 'tileAngle', label: '平铺倾斜角', type: 'chips', def: '-30',
        options: [['-30', '-30°（推荐）'], ['-45', '-45°'], ['0', '0° 水平'], ['30', '30°']],
        showIf: (v) => v.pos === 'tiled' },
      { key: 'tileDensity', label: '平铺密度', type: 'chips', def: 'normal',
        options: [['sparse', '稀疏'], ['normal', '适中（推荐）'], ['dense', '密集防盗']],
        showIf: (v) => v.pos === 'tiled' },
      { key: 'size', label: '大小', type: 'chips', def: 'medium', options: [['small', '小'], ['medium', '中'], ['large', '大']] },
      { key: 'opacity', label: '透明度', type: 'chips', def: '0.7', options: [['0.4', '浅 (40%)'], ['0.7', '适中 (70%)'], ['1', '不透明']] },
    ],
    collect(v, ctx) {
      if (v.mode === 'image' && !window.__secondFile) throw new Error('请先选择水印图片');
      return {
        input: ctx.file.path, mode: v.mode, text: v.text, image: window.__secondFile,
        pos: v.pos, wmColor: v.wmColor || 'white',
        tileAngle: v.tileAngle || '-30', tileDensity: v.tileDensity || 'normal',
        size: v.size, opacity: v.opacity,
        srcW: ctx.file.info.width, srcH: ctx.file.info.height,
        totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'subtitleTool', group: '工具', icon: '💬', name: '硬字幕压制 / 提取', desc: '导入 SRT/ASS/VTT 烧录进画面，或提取视频内嵌字幕为 SRT',
    accept: VIDEO_EXTS,
    fields: [
      { key: 'mode', label: '操作模式', type: 'chips', def: 'burn',
        options: [['burn', '烧录外挂字幕'], ['extract', '提取内嵌字幕 (.srt)']] },
      { type: 'secondFile', key: 'subtitle', kind: 'subFile', label: '字幕文件', placeholder: '选择 .srt / .ass / .vtt…',
        showIf: (v) => v.mode === 'burn' },
      { key: 'fontSize', label: 'SRT 字号', type: 'select', def: '22',
        options: [['16', '16（小）'], ['22', '22（推荐）'], ['28', '28（大）'], ['36', '36（超大）']],
        showIf: (v) => v.mode === 'burn' },
      { key: 'marginV', label: '底部边距 (px)', type: 'number', def: '24', min: 4, max: 200, step: 4,
        showIf: (v) => v.mode === 'burn' },
      { key: 'subIndex', label: '字幕轨序号（默认第 1 条 = 0）', type: 'number', def: '0', min: 0, max: 10, step: 1,
        showIf: (v) => v.mode === 'extract' },
    ],
    collect(v, ctx) {
      if (v.mode === 'burn' && !window.__secondFile) throw new Error('请先选择字幕文件 (.srt / .ass / .vtt)');
      return {
        input: ctx.file.path, mode: v.mode, subtitle: window.__secondFile,
        fontSize: v.fontSize, marginV: v.marginV, subIndex: v.subIndex,
        hasSubtitles: ctx.file.info.hasSubtitles, totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'videoCover', group: '工具', icon: '📷', name: '设置视频封面', desc: '为 MP4 / M4V 写入指定画面或图片作为封面，保留原音视频流',
    accept: ['mp4', 'm4v'],
    fields: [
      { key: 'source', label: '封面来源', type: 'chips', def: 'image',
        options: [['image', '🖼️ 使用自定义图片'], ['frame', '🎞️ 提取视频某一帧']] },
      { type: 'secondFile', key: 'coverImage', kind: 'imageFile', label: '封面图片', placeholder: '选择 JPG / PNG / WebP 封面图…',
        showIf: (v) => v.source !== 'frame' },
      { key: 'at', label: '封面画面时间点（秒）', type: 'number', def: '0', min: 0, step: 0.1, withVideoTime: true,
        showIf: (v) => v.source === 'frame' },
    ],
    collect(v, ctx) {
      const coverImage = v.source === 'frame' ? '' : (ctx.coverImage ?? window.__secondFile);
      if (v.source !== 'frame' && !coverImage) throw new Error('请选择或连接封面图片');
      return {
        input: ctx.file.path,
        source: v.source || 'image',
        coverImage,
        at: v.at || '0',
        totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'snapshot', group: '工具', icon: '📸', name: '视频截图 / 拆帧', desc: '单帧截图、按间隔导出，或逐帧无损拆解 GIF/视频全部原始帧',
    accept: [...VIDEO_EXTS, 'gif'],
    fields: [
      { key: 'mode', label: '模式', type: 'chips', def: 'single',
        options: [['single', '单张截图'], ['seq', '按间隔导出'], ['all', '逐帧全部拆解']] },
      { key: 'at', label: '时间点（秒）', type: 'number', def: '1', min: 0, step: 0.1, withVideoTime: true,
        showIf: (v) => v.mode === 'single' },
      { key: 'format', label: '图片格式', type: 'chips', def: 'png',
        options: [['png', 'PNG（无损）'], ['jpg', 'JPG（小）']],
        showIf: (v) => v.mode === 'single' },
      { key: 'every', label: '导出间隔', type: 'select', def: '1',
        options: [['0.1', '每 0.1 秒'], ['0.2', '每 0.2 秒'], ['0.5', '每 0.5 秒'], ['1', '每 1 秒'], ['2', '每 2 秒']],
        showIf: (v) => v.mode === 'seq' },
      { type: 'times', showIf: (v) => v.mode === 'seq' },
    ],
    collect(v, ctx) {
      if (v.mode === 'all') {
        return { input: ctx.file.path, mode: 'all', totalDuration: ctx.file.info.duration };
      }
      if (v.mode === 'seq') {
        const t = rt(ctx.file);
        return {
          input: ctx.file.path, mode: 'seq', every: v.every,
          start: t.start,
          duration: t.duration >= ctx.file.info.duration - 0.05 ? 0 : t.duration,
          totalDuration: ctx.file.info.duration,
        };
      }
      return { input: ctx.file.path, mode: 'single', at: v.at, format: v.format };
    },
  },
  {
    id: 'contactSheet', group: '工具', icon: '🗂️', name: '九宫格预览墙', desc: '把视频均匀截图拼成 3×3 / 4×4 等缩略图概览墙（可选时间戳）',
    accept: VIDEO_EXTS,
    fields: [
      { key: 'layout', label: '网格布局', type: 'chips', def: '3x3',
        options: [['2x2', '2×2 (4张)'], ['3x3', '3×3 (9张，推荐)'], ['4x4', '4×4 (16张)'], ['5x4', '5×4 (20张)']] },
      { key: 'cellWidth', label: '单格宽度', type: 'select', def: '400',
        options: [['240', '240 px'], ['320', '320 px'], ['400', '400 px（推荐）'], ['560', '560 px']] },
      { key: 'timestamps', label: '时间戳角标', type: 'chips', def: 'yes',
        options: [['yes', '显示时间'], ['no', '纯画面']] },
      { key: 'format', label: '输出格式', type: 'chips', def: 'jpg',
        options: [['jpg', 'JPG（体积小）'], ['png', 'PNG（高清）']] },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path, layout: v.layout, cellWidth: v.cellWidth,
        timestamps: v.timestamps, format: v.format, totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'stripMeta', group: '工具', icon: '🛡️', name: '清除隐私元数据', desc: '无损剥离视频/音频/图片中的设备型号、GPS定位等隐私信息',
    accept: [...VIDEO_EXTS, 'gif', ...AUDIO_EXTS, ...IMG_EXTS],
    fields: [],
    collect(v, ctx) {
      return { input: ctx.file.path, totalDuration: ctx.file.info.duration };
    },
  },
  {
    id: 'imagesTo', group: '工具', icon: '🎞️', name: '图片合成视频', desc: '多张图片合成 GIF 或 MP4（按列表顺序）',
    accept: IMG_EXTS, multi: true,
    fields: [
      { key: 'format', label: '输出', type: 'chips', def: 'gif', options: [['gif', 'GIF 动图'], ['mp4', 'MP4 视频']] },
      { key: 'fps', label: '每张停留', type: 'select', def: '8',
        options: [['4', '0.25 秒'], ['8', '0.125 秒'], ['2', '0.5 秒'], ['1', '1 秒']] },
    ],
    collect(v, ctx) {
      const sizes = {};
      for (const f of ctx.files) sizes[f.path] = { w: f.info?.width || 0, h: f.info?.height || 0 };
      return { files: ctx.files.map((f) => f.path), format: v.format, fps: v.fps, sizes };
    },
  },
];
})();
