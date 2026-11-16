'use strict';

// ---------------------------------------------------------------------------
// 功能定义：字段配置驱动 UI（group 用于侧栏分组）
// ---------------------------------------------------------------------------

const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'ts', 'm4v'];
const IMG_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp'];

const FEATURES = [
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
      const t = readTimes(ctx.file);
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
      const t = readTimes(ctx.file);
      const whole = t.duration >= ctx.file.info.duration - 0.05;
      return {
        input: ctx.file.path, start: t.start,
        duration: whole ? 0 : t.duration, // 整段时不传 -t
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
      { key: 'height', label: '分辨率', type: 'select', def: '0',
        options: [['0', '保持原始'], ['1080', '1080p'], ['720', '720p'], ['480', '480p']],
        showIf: (v) => v.mode !== 'copy' },
      { key: 'quality', label: '画质', type: 'chips', def: 'medium',
        options: [['high', '高'], ['medium', '中（推荐）'], ['low', '低（文件小）']],
        showIf: (v) => v.mode !== 'copy' },
    ],
    collect(v, ctx) {
      return { input: ctx.file.path, mode: v.mode, format: v.format, height: v.height, quality: v.quality, totalDuration: ctx.file.info.duration };
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
        const t = readTimes(ctx.file);
        const whole = t.duration >= ctx.file.info.duration - 0.05;
        params.start = t.start;
        params.duration = whole ? 0 : t.duration;
      }
      return params;
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
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path, targetMB: v.targetMB,
        width: ctx.file.info.width, fps: ctx.file.info.fps,
        hasAudio: ctx.file.info.hasAudio, totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'chromaGif', group: 'GIF 编辑', icon: '🪄', name: '绿幕抠像透明 GIF', desc: '抠除绿幕/纯色背景，生成透明底表情包 GIF',
    accept: [...VIDEO_EXTS, 'gif'],
    fields: [
      { key: 'color', label: '要抠除的背景色', type: 'color', def: '#00ff00',
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
      const t = readTimes(ctx.file);
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
    id: 'mergeVideos', group: '剪辑', icon: '🔗', name: '视频合并', desc: '多个视频拼接：支持同规格无损或跨格式兼容合并',
    accept: VIDEO_EXTS, multi: true,
    fields: [
      { key: 'mode', label: '合并模式', type: 'chips', def: 'fast',
        options: [['fast', '无损极速（需同规格）'], ['compat', '兼容模式（自动统一分辨率）']] },
    ],
    collect(v, ctx) {
      return {
        files: ctx.files.map((f) => f.path),
        mode: v.mode,
        infos: ctx.files.map((f) => f.info),
      };
    },
  },
  {
    id: 'videoCrop', group: '剪辑', icon: '🔲', name: '画面裁剪', desc: '在画面上拉框，裁掉多余区域',
    accept: [...VIDEO_EXTS, 'gif'], noBatch: true,
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
    id: 'videoBlur', group: '剪辑', icon: '🫥', name: '局部打码 / 模糊', desc: '在画面上拉框遮挡水印、人脸或隐私区域',
    accept: [...VIDEO_EXTS, 'gif'], noBatch: true,
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
    id: 'aspectPad', group: '剪辑', icon: '📐', name: '横竖屏比例适配', desc: '一键转 9:16 / 16:9 / 1:1，支持模糊背景填充',
    accept: [...VIDEO_EXTS, 'gif'],
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
    id: 'colorStab', group: '剪辑', icon: '🎨', name: '调色微调与防抖', desc: '调节亮度、对比度、饱和度、锐化，并支持轻量画面防抖',
    accept: [...VIDEO_EXTS, 'gif'],
    fields: [
      { key: 'brightness', label: '亮度', type: 'range', def: '0', min: -0.5, max: 0.5, step: 0.05, unit: '',
        presets: [['-0.15', '变暗'], ['0', '原图'], ['0.15', '提亮']] },
      { key: 'contrast', label: '对比度', type: 'range', def: '1', min: 0.5, max: 2, step: 0.05, unit: '',
        presets: [['0.8', '柔和'], ['1', '原图'], ['1.25', '通透']] },
      { key: 'saturation', label: '饱和度', type: 'range', def: '1', min: 0, max: 2.5, step: 0.05, unit: '',
        presets: [['0', '黑白'], ['1', '原色'], ['1.4', '鲜艳']] },
      { key: 'sharpen', label: '画面锐化', type: 'chips', def: 'none',
        options: [['none', '关闭'], ['light', '轻度锐化'], ['strong', '强力锐化']] },
      { key: 'stabilize', label: '防抖稳定', type: 'chips', def: 'none',
        options: [['none', '关闭'], ['deshake', '开启轻量防抖']] },
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
    id: 'rotateFlip', group: '剪辑', icon: '🔁', name: '旋转 / 翻转', desc: '转 90°/180° 或水平/垂直镜像',
    accept: [...VIDEO_EXTS, 'gif'],
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
    id: 'extractAudio', group: '音频', icon: '🎵', name: '提取音频', desc: '把视频里的声音存成 MP3 / M4A / WAV',
    accept: [...VIDEO_EXTS, 'mp3', 'm4a', 'wav', 'flac'],
    fields: [
      { key: 'format', label: '音频格式', type: 'chips', def: 'mp3',
        options: [['mp3', 'MP3（通用）'], ['m4a', 'M4A（音质好）'], ['wav', 'WAV（无损）']] },
    ],
    collect(v, ctx) {
      return { input: ctx.file.path, format: v.format, totalDuration: ctx.file.info.duration };
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
    id: 'addMusic', group: '音频', icon: '🎼', name: '添加背景音乐', desc: '替换原声或混合，音乐自动循环',
    accept: VIDEO_EXTS,
    fields: [
      { type: 'secondFile', key: 'music', kind: 'audioFile', label: '音乐文件', placeholder: '选择 MP3 / WAV / M4A…' },
      { key: 'mode', label: '混音方式', type: 'chips', def: 'replace',
        options: [['replace', '替换原声'], ['mix', '与原声混合']] },
      { key: 'musicVolume', label: '音乐音量', type: 'select', def: '1',
        options: [['0.3', '0.3x（轻音乐）'], ['0.5', '0.5x'], ['1', '1x（原音量）'], ['1.5', '1.5x']],
        showIf: (v) => v.mode === 'mix' },
    ],
    collect(v, ctx) {
      const music = window.__secondFile;
      if (!music) throw new Error('请先选择背景音乐文件');
      return {
        input: ctx.file.path, music, mode: v.mode, musicVolume: v.musicVolume,
        hasAudio: ctx.file.info.hasAudio, totalDuration: ctx.file.info.duration,
      };
    },
  },

  // ================= 工具 =================
  {
    id: 'watermark', group: '工具', icon: '🏷️', name: '添加水印', desc: '加文字或图片 Logo 水印（视频与 GIF 通用）',
    accept: [...VIDEO_EXTS, 'gif'],
    fields: [
      { key: 'mode', label: '水印类型', type: 'chips', def: 'text', options: [['text', '文字水印'], ['image', '图片 Logo']] },
      { key: 'text', label: '水印文字', type: 'text', def: '', placeholder: '输入水印文字…', showIf: (v) => v.mode === 'text' },
      { type: 'secondFile', key: 'image', kind: 'imageFile', label: '水印图片', placeholder: '选择 PNG / JPG 透明图标…', showIf: (v) => v.mode === 'image' },
      { key: 'pos', label: '位置', type: 'chips', def: 'br', options: [['br', '右下角'], ['bl', '左下角'], ['tr', '右上角'], ['tl', '左上角'], ['center', '居中']] },
      { key: 'size', label: '大小', type: 'chips', def: 'medium', options: [['small', '小'], ['medium', '中'], ['large', '大']] },
      { key: 'opacity', label: '透明度', type: 'chips', def: '0.7', options: [['0.4', '浅 (40%)'], ['0.7', '适中 (70%)'], ['1', '不透明']] },
    ],
    collect(v, ctx) {
      if (v.mode === 'image' && !window.__secondFile) throw new Error('请先选择水印图片');
      return {
        input: ctx.file.path, mode: v.mode, text: v.text, image: window.__secondFile,
        pos: v.pos, size: v.size, opacity: v.opacity,
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
        const t = readTimes(ctx.file);
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
    accept: [...VIDEO_EXTS, 'gif', 'mp3', 'm4a', 'wav', 'flac', ...IMG_EXTS],
    fields: [],
    collect(v, ctx) {
      return { input: ctx.file.path, totalDuration: ctx.file.info.duration };
    },
  },
  {
    id: 'imagesTo', group: '工具', icon: '🖼️', name: '图片合成视频', desc: '多张图片合成 GIF 或 MP4（按文件名排序）',
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

const GROUP_ORDER = ['转换', 'GIF 编辑', '剪辑', '音频', '工具'];

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let currentFeature = FEATURES[0];
let file = null;              // 单文件模式：{ path, info }
let files = null;             // 合并类多文件功能：[{ path, info }]
let batchFiles = null;        // 批量队列：[{ path, info, status, progress, output, outputType, outSize, targetReached, targetMB, error }]
let batchRunningIndex = -1;   // 当前正在处理的批量索引
let batchAborted = false;     // 批量中断标志
let running = false;
let currentTaskId = null;

window.__crop = null;       // 可视化裁剪（归一化 {x,y,w,h}）
window.__secondFile = null; // 第二文件路径（配乐/水印/分屏/字幕）
window.__secondInfo = null; // 第二文件探测信息
window.__segments = [];     // 多段剪辑时间段列表 [{ start, end }]

let prefOutputMode = localStorage.getItem('vgt_out_mode') || 'same';
let prefOutputDir = localStorage.getItem('vgt_out_dir') || '';
let prefHwAccel = localStorage.getItem('vgt_hw') || 'cpu';
if (prefOutputMode === 'custom' && !prefOutputDir) prefOutputMode = 'same';

function withGlobalPrefs(params) {
  return {
    ...params,
    __outputMode: prefOutputMode,
    __outputDir: prefOutputMode === 'custom' ? prefOutputDir : '',
    __hwAccel: prefHwAccel,
  };
}

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// 侧栏导航（按组渲染）
// ---------------------------------------------------------------------------

function renderNav() {
  const nav = $('nav');
  nav.innerHTML = '';
  for (const g of GROUP_ORDER) {
    const label = document.createElement('div');
    label.className = 'nav-group';
    label.textContent = g;
    nav.appendChild(label);
    for (const f of FEATURES.filter((x) => x.group === g)) {
      const btn = document.createElement('button');
      btn.className = 'nav-item' + (f === currentFeature ? ' active' : '');
      btn.dataset.id = f.id;
      btn.innerHTML = `<span class="nav-icon">${f.icon}</span><span class="nav-name">${f.name}</span>`;
      btn.onclick = () => {
        if (running) return toast('有任务正在进行中', true);
        selectFeature(f);
      };
      nav.appendChild(btn);
    }
  }
}

function selectFeature(f) {
  currentFeature = f;
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.id === f.id));
  $('feature-title').textContent = f.name;
  $('feature-desc').textContent = f.desc;
  const extsText = f.accept.map((e) => e.toUpperCase()).join(' / ');
  if (f.multi) {
    $('dz-hint').textContent = `支持多选，可一次拖入多个文件合并（${extsText}）`;
  } else if (f.noBatch) {
    $('dz-hint').textContent = `支持格式：${extsText}（需交互标记，仅支持单文件）`;
  } else {
    $('dz-hint').textContent = `支持单文件，也可多选或拖入多个文件批量处理（${extsText}）`;
  }
  clearFile();
}

// ---------------------------------------------------------------------------
// 参数面板
// ---------------------------------------------------------------------------

function renderParams() {
  window.__crop = null;
  window.__secondFile = null;
  window.__secondInfo = null;
  window.__segments = [];
  const box = $('params');
  box.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'param-grid';
  const hasVideo = !!document.querySelector('#preview-box video');

  for (const field of currentFeature.fields) {
    const wrap = document.createElement('div');
    wrap.className = 'field' + (field.fullWidth ? ' field-full' : '');
    if (field.key) wrap.dataset.fieldKey = field.key;
    if (field.showIf) wrap.dataset.showIf = '1';

    if (field.type === 'times') {
      const pickHtml = hasVideo
        ? `<div class="chip-row"><button class="chip" id="pick-t-start">⏮ 设为起点</button><button class="chip" id="pick-t-end">⏭ 设为终点</button></div>`
        : '';
      wrap.innerHTML = `
        <label>时间段（秒）</label>
        <div class="times-row">
          <input type="number" id="t-start" value="0" min="0" step="0.1" />
          <span class="times-sep">→</span>
          <input type="number" id="t-end" value="0" min="0" step="0.1" />
        </div>
        <div class="chip-row" id="times-chips"></div>${pickHtml}`;
    } else if (field.type === 'multiSegments') {
      wrap.innerHTML = `<label>时间段列表（秒）</label>
        <div class="seg-list" id="seg-list"></div>
        <div class="chip-row">
          <button class="chip" id="seg-add">+ 添加片段</button>
        </div>`;
    } else if (field.type === 'select') {
      wrap.innerHTML = `<label>${field.label}</label>
        <select data-key="${field.key}">${field.options.map(([v, l]) => `<option value="${v}" ${v === field.def ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    } else if (field.type === 'chips') {
      wrap.innerHTML = `<label>${field.label}</label>
        <div class="chip-row" data-key="${field.key}">
          ${field.options.map(([v, l]) => `<button class="chip ${v === field.def ? 'on' : ''}" data-val="${v}">${l}</button>`).join('')}
        </div>`;
    } else if (field.type === 'range') {
      const unit = field.unit ?? 'x';
      wrap.innerHTML = `<label>${field.label}：<span class="range-val" data-range-key="${field.key}">${field.def}${unit}</span></label>
        <input type="range" data-key="${field.key}" data-unit="${unit}" min="${field.min}" max="${field.max}" step="${field.step}" value="${field.def}" />
        <div class="chip-row">
          ${field.presets.map(([v, l]) => `<button class="chip preset" data-val="${v}">${l}</button>`).join('')}
        </div>`;
    } else if (field.type === 'color') {
      const presetsHtml = field.presets
        ? field.presets.map(([v, l]) => `<button class="chip preset" data-val="${v}">${l}</button>`).join('')
        : '';
      wrap.innerHTML = `<label>${field.label}</label>
        <div class="color-row">
          <input type="color" data-key="${field.key}" value="${field.def || '#00ff00'}" />
          ${presetsHtml}
        </div>`;
    } else if (field.type === 'text') {
      wrap.innerHTML = `<label>${field.label}</label>
        <input type="text" data-key="${field.key}" placeholder="${field.placeholder || ''}" value="${field.def || ''}" />`;
    } else if (field.type === 'number') {
      const maxAttr = field.max !== undefined ? ` max="${field.max}"` : '';
      const presetsHtml = field.presets
        ? `<div class="chip-row">${field.presets.map(([v, l]) => `<button class="chip preset ${v === field.def ? 'on' : ''}" data-val="${v}">${l}</button>`).join('')}</div>`
        : '';
      const videoPickHtml = field.withVideoTime && hasVideo
        ? `<div class="chip-row"><button class="chip" id="pick-video-time">📍 取当前播放时间</button></div>`
        : '';
      wrap.innerHTML = `<label>${field.label}</label>
        <input type="number" data-key="${field.key}" value="${field.def}" min="${field.min ?? 0}"${maxAttr} step="${field.step || 1}" />${presetsHtml}${videoPickHtml}`;
    } else if (field.type === 'secondFile') {
      wrap.innerHTML = `<label>${field.label}</label>
        <div class="second-file">
          <button class="btn btn-ghost btn-sm" id="pick-second" data-kind="${field.kind || 'audioFile'}">📁 选择${field.label}</button>
          <span class="muted second-name" id="second-name">${field.placeholder || '未选择'}</span>
        </div>`;
    } else if (field.type === 'cropCanvas') {
      wrap.innerHTML = `<label>${field.label || '拖动鼠标框出要保留的区域'}</label>
        <div class="crop-wrap"><canvas id="crop-canvas"></canvas></div>
        <div class="chip-row"><button class="chip" id="crop-reset">重置选区</button></div>
        <div class="muted crop-status" id="crop-status">尚未选择区域</div>`;
    }
    grid.appendChild(wrap);
  }
  box.appendChild(grid);
  if (!currentFeature.fields.length) box.classList.add('hidden');
  else box.classList.remove('hidden');

  // 下拉框变化时同步显隐
  box.querySelectorAll('select[data-key]').forEach((sel) => {
    sel.onchange = syncVisibility;
  });

  // 单选 chips 行为（含预设联动）
  box.querySelectorAll('.chip-row[data-key]').forEach((row) => {
    const fieldDef = currentFeature.fields.find((f) => f.key === row.dataset.key);
    row.querySelectorAll('.chip').forEach((chip) => {
      chip.onclick = () => {
        row.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
        chip.classList.add('on');
        const presetValues = fieldDef?.applyPresets?.[chip.dataset.val];
        if (presetValues) {
          for (const [k, val] of Object.entries(presetValues)) {
            const targetEl = box.querySelector(`[data-key="${k}"]`);
            if (!targetEl) continue;
            if (targetEl.classList.contains('chip-row')) {
              targetEl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.val === val));
            } else {
              targetEl.value = val;
            }
          }
        }
        syncVisibility();
      };
    });
  });

  // 滑条通用逻辑（倍速 / 抠像容差 / 调色等）
  box.querySelectorAll('input[type="range"][data-key]').forEach((range) => {
    const unit = range.dataset.unit ?? '';
    const valEl = box.querySelector(`.range-val[data-range-key="${range.dataset.key}"]`);
    const updateLabel = () => { if (valEl) valEl.textContent = `${range.value}${unit}`; };
    range.oninput = updateLabel;
    range.closest('.field').querySelectorAll('.chip.preset').forEach((chip) => {
      chip.onclick = () => {
        range.value = chip.dataset.val;
        updateLabel();
      };
    });
  });

  // 颜色选择器预设联动
  box.querySelectorAll('input[type="color"][data-key]').forEach((picker) => {
    const fieldWrap = picker.closest('.field');
    const chips = fieldWrap?.querySelectorAll('.chip.preset');
    if (!chips?.length) return;
    const syncColorChips = () => {
      const cur = picker.value.toLowerCase();
      chips.forEach((c) => c.classList.toggle('on', c.dataset.val.toLowerCase() === cur));
    };
    picker.addEventListener('input', syncColorChips);
    chips.forEach((chip) => {
      chip.onclick = () => {
        picker.value = chip.dataset.val;
        syncColorChips();
      };
    });
    syncColorChips();
  });

  // 数字输入框预设联动
  box.querySelectorAll('input[type="number"][data-key]').forEach((input) => {
    const fieldWrap = input.closest('.field');
    const chips = fieldWrap?.querySelectorAll('.chip.preset');
    if (!chips?.length) return;
    const syncChips = () => {
      chips.forEach((c) => c.classList.toggle('on', parseFloat(c.dataset.val) === parseFloat(input.value)));
    };
    input.addEventListener('input', syncChips);
    chips.forEach((chip) => {
      chip.onclick = () => {
        input.value = chip.dataset.val;
        syncChips();
      };
    });
  });

  // 播放器选点按钮
  const getVidTime = () => {
    const v = document.querySelector('#preview-box video');
    return v ? round1(v.currentTime || 0) : 0;
  };
  const pickStart = box.querySelector('#pick-t-start');
  const pickEnd = box.querySelector('#pick-t-end');
  if (pickStart) {
    pickStart.onclick = () => {
      const t = getVidTime();
      $('t-start').value = t;
      if (parseFloat($('t-end').value) <= t && file?.info.duration) $('t-end').value = round1(file.info.duration);
    };
  }
  if (pickEnd) {
    pickEnd.onclick = () => {
      const t = getVidTime();
      $('t-end').value = t;
    };
  }
  const pickVideoTime = box.querySelector('#pick-video-time');
  if (pickVideoTime) {
    pickVideoTime.onclick = () => {
      const input = pickVideoTime.closest('.field')?.querySelector('input[type="number"]');
      if (input) input.value = getVidTime();
    };
  }

  // 多片段列表编辑器
  const segListEl = box.querySelector('#seg-list');
  if (segListEl) {
    const dur = file?.info.duration || 0;
    window.__segments = [{ start: 0, end: dur > 0 ? round1(Math.min(dur, 5)) : 5 }];

    const renderSegs = () => {
      segListEl.innerHTML = '';
      window.__segments.forEach((seg, idx) => {
        const row = document.createElement('div');
        row.className = 'seg-row';
        row.innerHTML = `
          <span class="seg-idx">片段 #${idx + 1}</span>
          <input type="number" class="seg-start" value="${seg.start}" min="0" step="0.1" />
          <span class="times-sep">→</span>
          <input type="number" class="seg-end" value="${seg.end}" min="0" step="0.1" />
          ${hasVideo ? '<button class="batch-btn seg-pick-s" title="用当前播放时间设为起点">⏮</button><button class="batch-btn seg-pick-e" title="用当前播放时间设为终点">⏭</button>' : ''}
          ${window.__segments.length > 1 ? '<button class="batch-btn seg-rm" title="删除该段">✕</button>' : ''}
        `;
        const sIn = row.querySelector('.seg-start');
        const eIn = row.querySelector('.seg-end');
        sIn.oninput = () => { seg.start = parseFloat(sIn.value) || 0; };
        eIn.oninput = () => { seg.end = parseFloat(eIn.value) || 0; };
        const ps = row.querySelector('.seg-pick-s');
        const pe = row.querySelector('.seg-pick-e');
        if (ps) ps.onclick = () => { const t = getVidTime(); seg.start = t; sIn.value = t; };
        if (pe) pe.onclick = () => { const t = getVidTime(); seg.end = t; eIn.value = t; };
        const rm = row.querySelector('.seg-rm');
        if (rm) rm.onclick = () => { window.__segments.splice(idx, 1); renderSegs(); };
        segListEl.appendChild(row);
      });
    };

    renderSegs();
    box.querySelector('#seg-add').onclick = () => {
      const last = window.__segments[window.__segments.length - 1];
      const nextStart = last ? round1(last.end) : 0;
      const nextEnd = dur > 0 ? round1(Math.min(dur, nextStart + 5)) : round1(nextStart + 5);
      window.__segments.push({ start: nextStart, end: Math.max(nextEnd, round1(nextStart + 1)) });
      renderSegs();
    };
  }

  // 第二文件选择
  const pickSecond = box.querySelector('#pick-second');
  if (pickSecond) {
    pickSecond.onclick = async () => {
      const kind = pickSecond.dataset.kind || 'audioFile';
      const p = await window.api.pickFile(currentFeature.id, kind);
      if (p) {
        window.__secondFile = p;
        window.__secondInfo = null;
        const name = $('second-name');
        name.textContent = p.split(/[\\/]/).pop();
        name.title = p;
        name.classList.remove('muted');
        if (kind === 'videoGifFile') {
          const res = await window.api.probe(p);
          if (res.ok) window.__secondInfo = res.info;
        }
      }
    };
  }

  // 裁剪画布
  if (box.querySelector('#crop-canvas')) initCropCanvas();

  syncVisibility();
}

// 根据 showIf 显隐字段
function syncVisibility() {
  const values = collectFieldValues();
  for (const field of currentFeature.fields) {
    if (!field.showIf) continue;
    let target = null;
    if (field.key) {
      target = document.querySelector(`#params .field[data-field-key="${field.key}"]`);
    } else if (field.type === 'times') {
      target = document.querySelector('#t-start')?.closest('.field');
    }
    if (target) target.style.display = field.showIf(values) ? '' : 'none';
  }
}

function readChips(key) {
  const row = document.querySelector(`.chip-row[data-key="${key}"]`);
  const on = row?.querySelector('.chip.on');
  return on ? on.dataset.val : null;
}

function readTimes(targetFile = file) {
  const start = parseFloat($('t-start')?.value) || 0;
  let end = parseFloat($('t-end')?.value) || 0;
  const dur = targetFile?.info.duration || 0;
  if (end <= start) end = dur || start + 1;
  return { start, end, duration: Math.max(end - start, 0.1) };
}

const round1 = (n) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// 可视化裁剪画布
// ---------------------------------------------------------------------------

async function initCropCanvas() {
  const canvas = $('crop-canvas');
  const status = $('crop-status');
  const dataUrl = await window.api.firstFrame(file.path);
  if (!dataUrl) {
    status.textContent = '无法加载画面预览，请换一个文件';
    return;
  }
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, 520 / img.width);
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    const ctx = canvas.getContext('2d');
    let rect = null; // 归一化
    let dragging = null;

    const redraw = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      if (rect) {
        const [x, y, w, h] = [rect.x * canvas.width, rect.y * canvas.height, rect.w * canvas.width, rect.h * canvas.height];
        ctx.fillStyle = 'rgba(0,0,0,.55)';
        // 选区外围四块遮罩
        ctx.fillRect(0, 0, canvas.width, y);
        ctx.fillRect(0, y + h, canvas.width, canvas.height - y - h);
        ctx.fillRect(0, y, x, h);
        ctx.fillRect(x + w, y, canvas.width - x - w, h);
        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);
      }
    };
    redraw();

    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
        Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
    };
    canvas.onmousedown = (e) => {
      const [nx, ny] = pos(e);
      dragging = { x0: nx, y0: ny };
      e.preventDefault();
    };
    canvas.onmousemove = (e) => {
      if (!dragging) return;
      const [nx, ny] = pos(e);
      rect = {
        x: Math.min(dragging.x0, nx), y: Math.min(dragging.y0, ny),
        w: Math.abs(nx - dragging.x0), h: Math.abs(ny - dragging.y0),
      };
      redraw();
    };
    canvas.onmouseup = () => {
      if (dragging && rect && rect.w > 0.02 && rect.h > 0.02) {
        window.__crop = rect;
        const pw = Math.round(rect.w * file.info.width), ph = Math.round(rect.h * file.info.height);
        status.textContent = `已选 ${pw} × ${ph} 像素（原图 ${file.info.width}×${file.info.height}）`;
      } else {
        window.__crop = null;
        status.textContent = '选区太小，请重新拖动';
      }
      dragging = null;
    };
    $('crop-reset').onclick = () => {
      rect = null; window.__crop = null;
      status.textContent = '尚未选择区域';
      redraw();
    };
  };
  img.src = dataUrl;
}

// ---------------------------------------------------------------------------
// 文件选择与预览
// ---------------------------------------------------------------------------

async function useFile(p) {
  return useFiles([p]);
}

async function useFiles(paths, append = false) {
  if (!paths?.length) return;

  const valid = [];
  const skipped = [];
  for (const p of paths) {
    const ext = p.split('.').pop().toLowerCase();
    if (currentFeature.accept.includes(ext)) valid.push(p);
    else skipped.push(ext);
  }
  if (!valid.length) {
    return toast(`该功能不支持 .${skipped[0]} 文件`, true);
  }
  if (skipped.length) {
    toast(`已跳过 ${skipped.length} 个不支持的文件`, true);
  }

  // 合并类多文件功能（视频合并 / 图片合成视频）
  if (currentFeature.multi) {
    const prevPaths = append && files?.length ? files.map((f) => f.path) : [];
    const seen = new Set(prevPaths);
    const toAdd = append ? valid.filter((p) => !seen.has(p)) : valid;
    if (append && !toAdd.length) return toast('所选文件已在列表中');

    const infos = await window.api.probeMulti(toAdd);
    if (infos.some((i) => !i.info)) return toast('部分文件无法读取，请检查格式', true);
    files = append ? [...(files || []), ...infos] : infos;
    file = null;
    batchFiles = null;
    $('batch-list').classList.add('hidden');
    $('batch-list').innerHTML = '';
    $('btn-add-more').classList.remove('hidden');
    $('btn-replace').textContent = '重选文件';
    renderMultiCard();
    if (!append) renderParams();
    $('action-bar').classList.remove('hidden');
    $('result-card').classList.add('hidden');
    $('btn-run').textContent = '开始转换';
    return;
  }

  // 仅单文件功能（需在预览图框选：裁剪 / 打码）
  if (currentFeature.noBatch) {
    if (valid.length > 1) toast('该功能需在预览图框选区域，已选取第一个文件', true);
    const res = await window.api.probe(valid[0]);
    if (!res.ok) return toast(res.error, true);
    file = { path: valid[0], info: res.info };
    files = null;
    batchFiles = null;
    $('batch-list').classList.add('hidden');
    $('btn-add-more').classList.add('hidden');
    $('btn-replace').textContent = '换一个文件';
    renderFileCard(valid[0].split('.').pop().toLowerCase());
    renderParams();
    $('action-bar').classList.remove('hidden');
    $('result-card').classList.add('hidden');
    $('btn-run').textContent = '开始转换';
    prefillTimes(res.info);
    return;
  }

  // 可批量功能：先汇总列表（支持单文件转批量、批量追加）
  const wasSingle = !!file && !batchFiles;
  const wasBatch = !!batchFiles?.length;
  const existingPaths = append
    ? (batchFiles ? batchFiles.map((b) => b.path) : (file ? [file.path] : []))
    : [];
  const seen = new Set(existingPaths);
  const targetPaths = append ? valid.filter((p) => !seen.has(p)) : valid;
  if (append && !targetPaths.length) return toast('所选文件已在队列中');

  const totalCount = existingPaths.length + targetPaths.length;

  // 单文件模式
  if (totalCount === 1) {
    const singlePath = targetPaths[0];
    const res = await window.api.probe(singlePath);
    if (!res.ok) return toast(res.error, true);
    file = { path: singlePath, info: res.info };
    files = null;
    batchFiles = null;
    $('batch-list').classList.add('hidden');
    $('batch-list').innerHTML = '';
    $('btn-add-more').classList.remove('hidden');
    $('btn-replace').textContent = '换一个文件';
    renderFileCard(singlePath.split('.').pop().toLowerCase());
    renderParams();
    $('action-bar').classList.remove('hidden');
    $('result-card').classList.add('hidden');
    $('btn-run').textContent = '开始转换';
    prefillTimes(res.info);
    return;
  }

  // 批量模式（>= 2 个文件）
  const newProbes = await window.api.probeMulti(targetPaths);
  const badCount = newProbes.filter((i) => !i.info).length;
  const readable = newProbes.filter((i) => i.info);
  if (!readable.length) return toast('所选文件无法读取，请检查格式', true);
  if (badCount) toast(`已忽略 ${badCount} 个无法读取的文件`, true);

  let prevItems = [];
  if (append) {
    if (batchFiles?.length) {
      prevItems = batchFiles;
    } else if (file) {
      prevItems = [{ path: file.path, info: file.info, status: 'pending', progress: 0 }];
    }
  }
  const combined = [
    ...prevItems,
    ...readable.map((i) => ({ path: i.path, info: i.info, status: 'pending', progress: 0 })),
  ];

  // 追加后如果因忽略损坏文件仍只有 1 个有效文件，退回单文件模式
  if (combined.length === 1) {
    return useFiles([combined[0].path]);
  }

  file = null;
  files = null;
  batchFiles = combined;
  $('btn-add-more').classList.remove('hidden');
  $('btn-replace').textContent = '重选文件';
  renderBatchHeader();
  renderBatchList();
  // 初次进入批量模式或从单文件切入批量时重绘参数面板（隐藏播放器选点按钮）
  if (!append || wasSingle || !wasBatch) {
    renderParams();
  }
  $('action-bar').classList.remove('hidden');
  $('result-card').classList.add('hidden');
  $('btn-run').textContent = `开始批量处理 (${batchFiles.length})`;
}

function prefillTimes(info) {
  const tEnd = $('t-end');
  if (tEnd && info.duration > 0) {
    $('t-start').value = 0;
    tEnd.value = round1(Math.min(info.duration, 10));
    const chips = $('times-chips');
    if (chips) {
      chips.innerHTML = '';
      const mk = (label, s, e) => {
        const b = document.createElement('button');
        b.className = 'chip';
        b.textContent = label;
        b.onclick = () => { $('t-start').value = s; tEnd.value = e; };
        return b;
      };
      chips.appendChild(mk('整段', 0, round1(info.duration)));
      if (info.duration > 5) chips.appendChild(mk('前 5 秒', 0, 5));
      if (info.duration > 10) chips.appendChild(mk('前 10 秒', 0, 10));
    }
  }
}

function renderFileCard(ext) {
  const info = file.info;
  $('dropzone').classList.add('hidden');
  $('file-card').classList.remove('hidden');
  $('file-name').textContent = file.path.split(/[\\/]/).pop();
  $('file-name').title = file.path;

  const parts = [];
  if (info.width) parts.push(`分辨率 ${info.width}×${info.height}`);
  if (info.duration > 0) parts.push(`时长 ${fmtDur(info.duration)}`);
  if (info.fps > 0) parts.push(`${Math.round(info.fps)} fps`);
  parts.push(`大小 ${fmtSize(info.size)}`);
  parts.push(info.hasAudio ? '含音轨' : '无音轨');
  $('file-info').textContent = parts.join(' · ');

  const box = $('preview-box');
  box.innerHTML = '';
  box.style.display = '';
  const url = encodeURI('file:///' + file.path.replace(/\\/g, '/'));
  if (ext === 'gif' || ext === 'webp' || IMG_EXTS.includes(ext)) {
    box.innerHTML = `<img src="${url}" alt="预览" />`;
  } else if (['mp4', 'webm', 'mkv', 'mov', 'm4v'].includes(ext)) {
    box.innerHTML = `<video src="${url}" controls preload="metadata"></video>`;
  } else {
    box.innerHTML = `<div class="no-preview">🎧</div>`;
  }
}

function renderMultiCard() {
  $('dropzone').classList.add('hidden');
  $('file-card').classList.remove('hidden');
  $('preview-box').style.display = 'none';
  const names = files.map((f) => f.path.split(/[\\/]/).pop());
  $('file-name').textContent = `${files.length} 个文件`;
  $('file-name').title = files.map((f) => f.path).join('\n');
  const totalSize = files.reduce((s, f) => s + (f.info?.size || 0), 0);
  const totalDur = files.reduce((s, f) => s + (f.info?.duration || 0), 0);
  const shown = names.slice(0, 4).join('、') + (names.length > 4 ? ` 等 ${names.length} 个` : '');
  $('file-info').textContent = `${shown} · 总大小 ${fmtSize(totalSize)}` + (totalDur > 0 ? ` · 总时长 ${fmtDur(totalDur)}` : '');
}

function outModeText() {
  if (prefOutputMode === 'subdir') return 'output 子目录';
  if (prefOutputMode === 'custom' && prefOutputDir) return `自定义目录 (${prefOutputDir.split(/[\\/]/).pop() || prefOutputDir})`;
  return '各源文件同目录';
}

function renderBatchHeader() {
  $('dropzone').classList.add('hidden');
  $('file-card').classList.remove('hidden');
  $('preview-box').style.display = 'none';
  $('file-name').textContent = `批量队列 · ${batchFiles.length} 个文件`;
  $('file-name').title = batchFiles.map((f) => f.path).join('\n');
  const totalSize = batchFiles.reduce((s, f) => s + (f.info?.size || 0), 0);
  const totalDur = batchFiles.reduce((s, f) => s + (f.info?.duration || 0), 0);
  $('file-info').textContent = `顺序处理 · 总大小 ${fmtSize(totalSize)}`
    + (totalDur > 0 ? ` · 总时长 ${fmtDur(totalDur)}` : '')
    + ` · 输出保存至${outModeText()}`;
}

function renderBatchList() {
  const listEl = $('batch-list');
  if (!batchFiles?.length) {
    listEl.classList.add('hidden');
    listEl.innerHTML = '';
    return;
  }
  listEl.classList.remove('hidden');
  listEl.innerHTML = '';

  batchFiles.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'batch-item';
    row.dataset.idx = String(idx);

    const nameEl = document.createElement('div');
    nameEl.className = 'batch-name';
    nameEl.textContent = `${idx + 1}. ${item.path.split(/[\\/]/).pop()}`;
    nameEl.title = item.path;
    row.appendChild(nameEl);

    const metaParts = [];
    if (item.info?.width) metaParts.push(`${item.info.width}×${item.info.height}`);
    if (item.info?.duration > 0) metaParts.push(fmtDur(item.info.duration));
    metaParts.push(fmtSize(item.info?.size));
    const metaEl = document.createElement('div');
    metaEl.className = 'batch-meta';
    metaEl.textContent = metaParts.join(' · ');
    row.appendChild(metaEl);

    const statusEl = document.createElement('div');
    statusEl.className = 'batch-status';
    if (item.status === 'running') {
      statusEl.classList.add('run');
      statusEl.textContent = `处理中 ${Math.round((item.progress || 0) * 100)}%`;
    } else if (item.status === 'done') {
      statusEl.classList.add('ok');
      if (item.outputType === 'dir') {
        statusEl.textContent = '✅ 已导出';
      } else if (currentFeature.id === 'compressGif' && item.info?.size && item.outSize) {
        const pct = Math.round((1 - item.outSize / item.info.size) * 100);
        statusEl.textContent = pct > 0
          ? `✅ ${fmtSize(item.outSize)} (-${pct}%)`
          : `✅ ${fmtSize(item.outSize)}`;
      } else {
        statusEl.textContent = `✅ ${fmtSize(item.outSize)}`;
      }
      statusEl.title = item.output || '';
    } else if (item.status === 'error') {
      statusEl.classList.add('err');
      statusEl.textContent = '❌ 失败';
      statusEl.title = item.error || '处理失败';
    } else if (item.status === 'cancelled') {
      statusEl.classList.add('err');
      statusEl.textContent = '已取消';
    } else {
      statusEl.textContent = '待处理';
    }
    row.appendChild(statusEl);

    if (item.status === 'done' && item.output) {
      const locBtn = document.createElement('button');
      locBtn.className = 'batch-btn';
      locBtn.textContent = '定位';
      locBtn.onclick = () =>
        item.outputType === 'dir' ? window.api.openFolder(item.output) : window.api.showInFolder(item.output);
      row.appendChild(locBtn);
    } else if (!running) {
      const rmBtn = document.createElement('button');
      rmBtn.className = 'batch-btn';
      rmBtn.textContent = '✕';
      rmBtn.title = '从队列移除';
      rmBtn.onclick = () => {
        if (running) return;
        const remaining = batchFiles.filter((_, j) => j !== idx);
        if (!remaining.length) return clearFile();
        if (remaining.length === 1) return useFiles([remaining[0].path]);
        batchFiles = remaining;
        renderBatchHeader();
        renderBatchList();
        $('btn-run').textContent = `开始批量处理 (${batchFiles.length})`;
      };
      row.appendChild(rmBtn);
    }

    listEl.appendChild(row);
  });
}

function clearFile() {
  file = null;
  files = null;
  batchFiles = null;
  batchRunningIndex = -1;
  batchAborted = false;
  window.__crop = null;
  window.__secondFile = null;
  window.__secondInfo = null;
  window.__segments = [];
  $('file-card').classList.add('hidden');
  $('batch-list').classList.add('hidden');
  $('batch-list').innerHTML = '';
  $('btn-add-more').classList.add('hidden');
  $('btn-replace').textContent = '换一个文件';
  $('params').classList.add('hidden');
  $('action-bar').classList.add('hidden');
  $('result-card').classList.add('hidden');
  $('dropzone').classList.remove('hidden');
  $('preview-box').style.display = '';
  $('btn-run').textContent = '开始转换';
}

// ---------------------------------------------------------------------------
// 执行任务
// ---------------------------------------------------------------------------

async function runTask() {
  if (running) return;
  if (batchFiles?.length) return runBatchTask();

  const ctx = currentFeature.multi ? { files } : { file };
  if (currentFeature.multi ? !files?.length : !file) return;
  let params;
  try {
    params = withGlobalPrefs(await currentFeature.collect(collectFieldValues(), ctx));
  } catch (err) {
    return toast(err.message, true);
  }
  setRunning(true);
  $('result-card').classList.add('hidden');
  setProgress(0, '处理中…');

  const res = await window.api.startTask(currentFeature.id, params);
  setRunning(false);

  if (res.ok) {
    await showSuccess(res);
  } else if (!res.cancelled) {
    showResult('err', `❌ 转换失败\n${res.error}`);
  }
}

async function runBatchTask() {
  const fieldValues = collectFieldValues();
  // 先用首个文件校验参数是否完整（如文字内容、背景音乐等）
  try {
    await currentFeature.collect(fieldValues, { file: batchFiles[0] });
  } catch (err) {
    return toast(err.message, true);
  }

  for (const item of batchFiles) {
    item.status = 'pending';
    item.progress = 0;
    item.output = null;
    item.outputType = null;
    item.outSize = 0;
    item.error = null;
  }

  batchAborted = false;
  batchRunningIndex = 0;
  setRunning(true);
  $('result-card').classList.add('hidden');
  renderBatchList();

  for (let i = 0; i < batchFiles.length; i++) {
    if (batchAborted) {
      batchFiles[i].status = 'cancelled';
      continue;
    }
    batchRunningIndex = i;
    const item = batchFiles[i];
    item.status = 'running';
    item.progress = 0;
    renderBatchList();

    const name = item.path.split(/[\\/]/).pop();
    setProgress(i / batchFiles.length, `批量处理 (${i + 1}/${batchFiles.length}) 0% · ${name}`);

    let itemParams;
    try {
      itemParams = withGlobalPrefs(await currentFeature.collect(fieldValues, { file: item }));
    } catch (err) {
      item.status = 'error';
      item.error = err.message;
      renderBatchList();
      continue;
    }

    const res = await window.api.startTask(currentFeature.id, itemParams);
    if (res.cancelled || batchAborted) {
      item.status = 'cancelled';
      batchAborted = true;
      for (let k = i + 1; k < batchFiles.length; k++) batchFiles[k].status = 'cancelled';
      break;
    } else if (res.ok) {
      item.status = 'done';
      item.output = res.output;
      item.outputType = res.outputType || 'file';
      item.outSize = item.outputType === 'dir' ? 0 : await window.api.statFile(res.output);
      item.targetReached = res.targetReached;
      item.targetMB = res.targetMB;
    } else {
      item.status = 'error';
      item.error = res.error || '处理失败';
    }
  }

  batchRunningIndex = -1;
  currentTaskId = null;
  setRunning(false);
  renderBatchList();
  showBatchSummary();
}

function showBatchSummary() {
  const doneItems = batchFiles.filter((b) => b.status === 'done');
  const errItems = batchFiles.filter((b) => b.status === 'error');
  const cancelItems = batchFiles.filter((b) => b.status === 'cancelled');

  let title;
  let kind = 'ok';
  if (batchAborted) {
    kind = 'err';
    title = `⚠️ 批量处理已取消：已完成 ${doneItems.length} 个，取消 ${cancelItems.length} 个`
      + (errItems.length ? `，失败 ${errItems.length} 个` : '');
  } else if (errItems.length) {
    kind = 'err';
    title = `⚠️ 批量处理完成：${doneItems.length} 个成功，${errItems.length} 个失败（鼠标悬停“❌ 失败”可看原因）`;
  } else {
    title = `✅ 批量处理全部完成：共 ${doneItems.length} 个文件`;
    if (currentFeature.id === 'compressGif' || currentFeature.id === 'compressTarget') {
      const totalIn = doneItems.reduce((s, b) => s + (b.info?.size || 0), 0);
      const totalOut = doneItems.reduce((s, b) => s + (b.outSize || 0), 0);
      if (totalIn > 0 && totalOut > 0 && totalOut < totalIn) {
        const pct = Math.round((1 - totalOut / totalIn) * 100);
        title += `（总体积 ${fmtSize(totalIn)} → ${fmtSize(totalOut)}，共节省 ${pct}%）`;
      }
    }
  }

  const firstOut = doneItems[0];
  const openBtnHtml = firstOut
    ? `<button class="btn btn-ghost btn-sm" id="btn-open">打开输出目录</button>`
    : '';
  showResult(kind, `${title}<div class="result-actions">${openBtnHtml}<button class="btn btn-ghost btn-sm" id="btn-again">重新准备</button></div>`);

  if (firstOut) {
    $('btn-open').onclick = () =>
      firstOut.outputType === 'dir'
        ? window.api.openFolder(firstOut.output)
        : window.api.showInFolder(firstOut.output);
  }
  $('btn-again').onclick = () => {
    useFiles(batchFiles.map((b) => b.path)).then(() => {});
  };
}

async function showSuccess(res) {
  const name = res.output.split(/[\\/]/).pop();
  let line;
  if (res.outputType === 'dir') {
    const count = await window.api.countDir(res.output);
    const unitLabel = currentFeature.id === 'splitVideo' ? '个片段' : '张图片';
    line = `✅ 已导出 ${count} ${unitLabel}到文件夹`;
  } else {
    const outSize = await window.api.statFile(res.output);
    line = `✅ 完成：${name}（${fmtSize(outSize)}）`;
    if (currentFeature.id === 'compressGif' && file?.info.size) {
      if (outSize < file.info.size) {
        const pct = Math.round((1 - outSize / file.info.size) * 100);
        line = `✅ 压缩完成：${fmtSize(file.info.size)} → ${fmtSize(outSize)}，节省 ${pct}%`;
      } else {
        line = `✅ 处理完成：${fmtSize(file.info.size)} → ${fmtSize(outSize)}（未比原图更小，可尝试降低宽度/帧率或选“极限瘦身”）`;
      }
    }
    if (currentFeature.id === 'compressTarget') {
      const srcSize = file?.info.size || 0;
      const pct = srcSize ? Math.max(0, Math.round((1 - outSize / srcSize) * 100)) : 0;
      line += srcSize ? `（原 ${fmtSize(srcSize)}，减小 ${pct}%）` : '';
      if (res.targetReached === false) {
        line += `<br />⚠️ 已尽力压至最小 ${fmtSize(outSize)}，仍略高于 ${res.targetMB} MB 目标`;
      }
    }
  }
  showResult('ok', `${line}<div class="result-path">${res.output}</div><div class="result-actions">
    <button class="btn btn-ghost btn-sm" id="btn-open">${res.outputType === 'dir' ? '打开文件夹' : '打开所在文件夹'}</button>
    <button class="btn btn-ghost btn-sm" id="btn-again">再来一次</button></div>`);
  $('btn-open').onclick = () =>
    res.outputType === 'dir' ? window.api.openFolder(res.output) : window.api.showInFolder(res.output);
  $('btn-again').onclick = () => {
    if (currentFeature.multi) return clearFile();
    useFile(file.path).then(() => {});
  };
}

function collectFieldValues() {
  const values = {};
  document.querySelectorAll('#params [data-key]').forEach((el) => {
    if (el.classList.contains('chip-row')) values[el.dataset.key] = readChips(el.dataset.key);
    else values[el.dataset.key] = el.value;
  });
  document.querySelectorAll('#params input[type="range"][data-key]').forEach((range) => {
    values[range.dataset.key] = parseFloat(range.value);
  });
  return values;
}

function setRunning(on) {
  running = on;
  $('btn-run').classList.toggle('hidden', on);
  $('btn-cancel').classList.toggle('hidden', !on);
  $('progress-area').classList.toggle('hidden', !on);
  if (!on) setProgress(0);
}

function setProgress(ratio, text) {
  $('progress-fill').style.width = `${Math.round(ratio * 100)}%`;
  $('progress-text').textContent = text || `进度 ${Math.round(ratio * 100)}%`;
}

function showResult(kind, html) {
  const card = $('result-card');
  card.className = `result-card ${kind}`;
  card.innerHTML = html;
  card.classList.remove('hidden');
}

let toastTimer = null;
function toast(msg, warn = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast${warn ? ' warn' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function fmtSize(bytes) {
  if (!bytes) return '-';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fmtDur(sec) {
  if (sec < 60) return `${round1(sec)} 秒`;
  const m = Math.floor(sec / 60);
  return `${m} 分 ${Math.round(sec % 60)} 秒`;
}

// ---------------------------------------------------------------------------
// 事件绑定与启动
// ---------------------------------------------------------------------------

function bindEvents() {
  $('dropzone').onclick = async () => {
    const p = await window.api.pickFile(currentFeature.id);
    if (p) useFiles(Array.isArray(p) ? p : [p]);
  };
  $('btn-replace').onclick = async () => {
    if (running) return toast('有任务正在进行中', true);
    const p = await window.api.pickFile(currentFeature.id);
    if (p) useFiles(Array.isArray(p) ? p : [p]);
  };
  $('btn-add-more').onclick = async () => {
    if (running) return toast('有任务正在进行中', true);
    const p = await window.api.pickFile(currentFeature.id);
    if (p) useFiles(Array.isArray(p) ? p : [p], true);
  };

  const dz = $('dropzone');
  document.body.addEventListener('dragover', (e) => {
    e.preventDefault();
    dz.classList.add('dragover');
  });
  document.body.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) dz.classList.remove('dragover');
  });
  document.body.addEventListener('drop', async (e) => {
    e.preventDefault();
    dz.classList.remove('dragover');
    if (running) return toast('有任务正在进行中', true);
    const list = e.dataTransfer?.files;
    if (!list?.length) return;
    const paths = [...list].map((f) => window.api.getPath(f)).filter(Boolean);
    if (!paths.length) return;
    useFiles(paths);
  });

  $('btn-run').onclick = runTask;
  $('btn-cancel').onclick = () => {
    if (batchFiles?.length && running) batchAborted = true;
    if (currentTaskId) window.api.cancelTask(currentTaskId);
  };
}

function initGlobalPrefs() {
  const modeSel = $('pref-out-mode');
  const dirBtn = $('pref-out-dir-btn');
  const hwSel = $('pref-hw');

  const syncOutPrefUi = () => {
    modeSel.value = prefOutputMode;
    if (prefOutputMode === 'custom' && prefOutputDir) {
      dirBtn.classList.remove('hidden');
      dirBtn.textContent = `📁 ${prefOutputDir.split(/[\\/]/).pop() || prefOutputDir}`;
      dirBtn.title = prefOutputDir;
    } else {
      dirBtn.classList.add('hidden');
    }
    if (batchFiles?.length) renderBatchHeader();
  };

  modeSel.onchange = async () => {
    const val = modeSel.value;
    if (val === 'custom') {
      const picked = await window.api.pickDir();
      if (!picked) {
        modeSel.value = prefOutputMode;
        return;
      }
      prefOutputMode = 'custom';
      prefOutputDir = picked;
      localStorage.setItem('vgt_out_dir', picked);
    } else {
      prefOutputMode = val;
    }
    localStorage.setItem('vgt_out_mode', prefOutputMode);
    syncOutPrefUi();
  };

  dirBtn.onclick = async () => {
    const picked = await window.api.pickDir();
    if (!picked) return;
    prefOutputDir = picked;
    localStorage.setItem('vgt_out_dir', picked);
    syncOutPrefUi();
  };

  hwSel.value = prefHwAccel;
  hwSel.onchange = () => {
    prefHwAccel = hwSel.value;
    localStorage.setItem('vgt_hw', prefHwAccel);
  };

  syncOutPrefUi();

  window.api.detectHw().then((hw) => {
    if (!hw) return;
    const avail = new Set(hw.available || []);
    const autoOpt = hwSel.querySelector('option[value="auto"]');
    if (autoOpt) {
      autoOpt.textContent = hw.primary
        ? `自动检测 GPU (${hw.primary.replace('h264_', '').toUpperCase()})`
        : '自动检测 GPU（未检测到，将用 CPU）';
    }
    ['h264_nvenc', 'h264_qsv', 'h264_amf'].forEach((id) => {
      const opt = hwSel.querySelector(`option[value="${id}"]`);
      if (opt) opt.textContent = opt.textContent + (avail.has(id) ? ' ✓' : '（不可用）');
    });
  }).catch(() => {});
}

window.addEventListener('DOMContentLoaded', () => {
  initGlobalPrefs();
  renderNav();
  selectFeature(FEATURES[0]);
  bindEvents();
  window.api.onProgress(({ taskId, ratio }) => {
    currentTaskId = taskId;
    if (!running) return;
    if (batchFiles?.length && batchRunningIndex >= 0 && batchRunningIndex < batchFiles.length) {
      const item = batchFiles[batchRunningIndex];
      item.progress = ratio;
      const overall = (batchRunningIndex + ratio) / batchFiles.length;
      const name = item.path.split(/[\\/]/).pop();
      setProgress(overall, `批量处理 (${batchRunningIndex + 1}/${batchFiles.length}) ${Math.round(ratio * 100)}% · ${name}`);
      const statusEl = document.querySelector(`#batch-list .batch-item[data-idx="${batchRunningIndex}"] .batch-status`);
      if (statusEl) statusEl.textContent = `处理中 ${Math.round(ratio * 100)}%`;
    } else {
      setProgress(ratio);
    }
  });
});
