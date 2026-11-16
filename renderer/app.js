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
      const t = readTimes();
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
      const t = readTimes();
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
    id: 'convertVideo', group: '转换', icon: '📦', name: '格式转换', desc: 'MP4 / MKV / WebM 互转，可选分辨率与画质',
    accept: VIDEO_EXTS,
    fields: [
      { key: 'format', label: '目标格式', type: 'chips', def: 'mp4', options: [['mp4', 'MP4'], ['mkv', 'MKV'], ['webm', 'WebM']] },
      { key: 'height', label: '分辨率', type: 'select', def: '0',
        options: [['0', '保持原始'], ['1080', '1080p'], ['720', '720p'], ['480', '480p']] },
      { key: 'quality', label: '画质', type: 'chips', def: 'medium', options: [['high', '高'], ['medium', '中（推荐）'], ['low', '低（文件小）']] },
    ],
    collect(v, ctx) {
      return { input: ctx.file.path, format: v.format, height: v.height, quality: v.quality, totalDuration: ctx.file.info.duration };
    },
  },

  // ================= GIF 编辑 =================
  {
    id: 'compressGif', group: 'GIF 编辑', icon: '🗜️', name: 'GIF 压缩', desc: '降宽降帧重新调色，显著减小体积',
    accept: ['gif'],
    fields: [
      { key: 'width', label: '宽度', type: 'select', def: '480',
        options: [['320', '320 px（最小）'], ['480', '480 px（推荐）'], ['0', '保持原宽']] },
      { key: 'fps', label: '帧率', type: 'select', def: '12',
        options: [['8', '8 fps'], ['10', '10 fps'], ['12', '12 fps（推荐）'], ['0', '保持原帧率']] },
      { key: 'colors', label: '颜色数', type: 'select', def: '128',
        options: [['32', '32 色（极小）'], ['64', '64 色'], ['128', '128 色（推荐）'], ['256', '256 色']] },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        width: v.width === '0' ? ctx.file.info.width : v.width,
        fps: v.fps === '0' ? (ctx.file.info.fps || 12) : v.fps,
        colors: v.colors, totalDuration: ctx.file.info.duration,
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
    id: 'compressTarget', group: 'GIF 编辑', icon: '🎯', name: '压缩到目标大小', desc: '自动压到指定体积以内（微信 25MB / 邮件附件等）',
    accept: [...VIDEO_EXTS, 'gif'],
    fields: [
      { key: 'targetMB', label: '目标大小 (MB)', type: 'chips', def: '25',
        options: [['8', '8 MB'], ['25', '25 MB（微信）'], ['50', '50 MB'], ['100', '100 MB']] },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path, targetMB: v.targetMB,
        width: ctx.file.info.width, fps: ctx.file.info.fps,
        hasAudio: ctx.file.info.hasAudio, totalDuration: ctx.file.info.duration,
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
      const t = readTimes();
      return { input: ctx.file.path, start: t.start, duration: t.duration, precise: v.precise === 'precise' };
    },
  },
  {
    id: 'mergeVideos', group: '剪辑', icon: '🔗', name: '视频合并', desc: '多个视频无损拼接（需同分辨率/编码）',
    accept: VIDEO_EXTS, multi: true,
    fields: [],
    collect(v, ctx) {
      return { files: ctx.files.map((f) => f.path) };
    },
  },
  {
    id: 'videoCrop', group: '剪辑', icon: '🔲', name: '画面裁剪', desc: '在画面上拉框，裁掉多余区域',
    accept: [...VIDEO_EXTS, 'gif'],
    fields: [{ type: 'cropCanvas' }],
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
      { key: 'speed', label: '倍速', type: 'range', def: '1.5', min: 0.25, max: 4, step: 0.05,
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
    id: 'audioAdjust', group: '音频', icon: '🔊', name: '音频调整', desc: '静音、调音量、淡入淡出（画面不重编码）',
    accept: VIDEO_EXTS,
    fields: [
      { key: 'mode', label: '处理方式', type: 'chips', def: 'mute',
        options: [['mute', '静音（去掉声音）'], ['volume', '调整音量'], ['fade', '淡入淡出']] },
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
        totalDuration: ctx.file.info.duration,
      };
    },
  },
  {
    id: 'addMusic', group: '音频', icon: '🎼', name: '添加背景音乐', desc: '替换原声或混合，音乐自动循环',
    accept: VIDEO_EXTS,
    fields: [
      { type: 'secondFile', key: 'music', label: '音乐文件', placeholder: '选择 MP3 / WAV / M4A…' },
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
    id: 'snapshot', group: '工具', icon: '📸', name: '视频截图', desc: '截取某一帧为图片，或按间隔导出帧序列',
    accept: [...VIDEO_EXTS, 'gif'],
    fields: [
      { key: 'mode', label: '模式', type: 'chips', def: 'single',
        options: [['single', '单张截图'], ['seq', '帧序列导出']] },
      { key: 'at', label: '时间点（秒）', type: 'number', def: '1', min: 0, step: 0.1,
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
      if (v.mode === 'seq') {
        const t = readTimes();
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
let file = null;          // 单文件功能：{ path, info }
let files = null;         // 多文件功能：[{ path, info }]
let running = false;
let currentTaskId = null;

window.__crop = null;     // 可视化裁剪（归一化 {x,y,w,h}）
window.__secondFile = null; // 背景音乐路径

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
  $('dz-hint').textContent = f.multi
    ? `支持多选，可一次拖入多个文件（${f.accept.map((e) => e.toUpperCase()).join(' / ')}）`
    : `支持格式：${f.accept.map((e) => e.toUpperCase()).join(' / ')}`;
  clearFile();
}

// ---------------------------------------------------------------------------
// 参数面板
// ---------------------------------------------------------------------------

function renderParams() {
  window.__crop = null;
  window.__secondFile = null;
  const box = $('params');
  box.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'param-grid';

  for (const field of currentFeature.fields) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    if (field.showIf) wrap.dataset.showIf = '1';

    if (field.type === 'times') {
      wrap.innerHTML = `
        <label>时间段（秒）</label>
        <div class="times-row">
          <input type="number" id="t-start" value="0" min="0" step="0.1" />
          <span class="times-sep">→</span>
          <input type="number" id="t-end" value="0" min="0" step="0.1" />
        </div>
        <div class="chip-row" id="times-chips"></div>`;
    } else if (field.type === 'select') {
      wrap.innerHTML = `<label>${field.label}</label>
        <select data-key="${field.key}">${field.options.map(([v, l]) => `<option value="${v}" ${v === field.def ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    } else if (field.type === 'chips') {
      wrap.innerHTML = `<label>${field.label}</label>
        <div class="chip-row" data-key="${field.key}">
          ${field.options.map(([v, l]) => `<button class="chip ${v === field.def ? 'on' : ''}" data-val="${v}">${l}</button>`).join('')}
        </div>`;
    } else if (field.type === 'range') {
      wrap.innerHTML = `<label>${field.label}：<span class="range-val" id="speed-val">${field.def}x</span></label>
        <input type="range" data-key="${field.key}" min="${field.min}" max="${field.max}" step="${field.step}" value="${field.def}" id="speed-range" />
        <div class="chip-row">
          ${field.presets.map(([v, l]) => `<button class="chip preset" data-val="${v}">${l}</button>`).join('')}
        </div>`;
    } else if (field.type === 'text') {
      wrap.innerHTML = `<label>${field.label}</label>
        <input type="text" data-key="${field.key}" placeholder="${field.placeholder || ''}" value="${field.def || ''}" />`;
    } else if (field.type === 'number') {
      wrap.innerHTML = `<label>${field.label}</label>
        <input type="number" data-key="${field.key}" value="${field.def}" min="${field.min ?? 0}" step="${field.step || 1}" />`;
    } else if (field.type === 'secondFile') {
      wrap.innerHTML = `<label>${field.label}</label>
        <div class="second-file">
          <button class="btn btn-ghost btn-sm" id="pick-second">📁 选择${field.label}</button>
          <span class="muted second-name" id="second-name">${field.placeholder || '未选择'}</span>
        </div>`;
    } else if (field.type === 'cropCanvas') {
      wrap.innerHTML = `<label>拖动鼠标框出要保留的区域</label>
        <div class="crop-wrap"><canvas id="crop-canvas"></canvas></div>
        <div class="chip-row"><button class="chip" id="crop-reset">重置选区</button></div>
        <div class="muted crop-status" id="crop-status">尚未选择区域</div>`;
    }
    grid.appendChild(wrap);
  }
  box.appendChild(grid);
  if (!currentFeature.fields.length) box.classList.add('hidden');
  else box.classList.remove('hidden');

  // 单选 chips 行为
  box.querySelectorAll('.chip-row[data-key]').forEach((row) => {
    row.querySelectorAll('.chip').forEach((chip) => {
      chip.onclick = () => {
        row.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
        chip.classList.add('on');
        syncVisibility();
      };
    });
  });

  // 倍速滑条
  const range = box.querySelector('#speed-range');
  if (range) {
    range.oninput = () => { $('speed-val').textContent = `${range.value}x`; };
    box.querySelectorAll('.chip.preset').forEach((chip) => {
      chip.onclick = () => {
        range.value = chip.dataset.val;
        $('speed-val').textContent = `${chip.dataset.val}x`;
      };
    });
  }

  // 第二文件选择
  const pickSecond = box.querySelector('#pick-second');
  if (pickSecond) {
    pickSecond.onclick = async () => {
      const p = await window.api.pickFile(currentFeature.id, 'audioFile');
      if (p) {
        window.__secondFile = p;
        const name = $('second-name');
        name.textContent = p.split(/[\\/]/).pop();
        name.title = p;
        name.classList.remove('muted');
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
      target = document.querySelector(`#params [data-key="${field.key}"]`)?.closest('.field');
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

function readTimes() {
  const start = parseFloat($('t-start')?.value) || 0;
  let end = parseFloat($('t-end')?.value) || 0;
  const dur = file?.info.duration || 0;
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

async function useFiles(paths) {
  if (!paths?.length) return;
  const ext = paths[0].split('.').pop().toLowerCase();
  if (!currentFeature.accept.includes(ext)) {
    return toast(`该功能不支持 .${ext} 文件`, true);
  }

  if (currentFeature.multi) {
    const infos = await window.api.probeMulti(paths);
    files = infos;
    file = null;
    if (infos.some((i) => !i.info)) return toast('部分文件无法读取，请检查格式', true);
    renderMultiCard();
    renderParams();
    $('action-bar').classList.remove('hidden');
    $('result-card').classList.add('hidden');
    return;
  }

  const res = await window.api.probe(paths[0]);
  if (!res.ok) return toast(res.error, true);
  file = { path: paths[0], info: res.info };
  files = null;
  renderFileCard(ext);
  renderParams();
  $('action-bar').classList.remove('hidden');
  $('result-card').classList.add('hidden');

  // 预填时间段
  const tEnd = $('t-end');
  if (tEnd && res.info.duration > 0) {
    $('t-start').value = 0;
    tEnd.value = round1(Math.min(res.info.duration, 10));
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
      chips.appendChild(mk('整段', 0, round1(res.info.duration)));
      if (res.info.duration > 5) chips.appendChild(mk('前 5 秒', 0, 5));
      if (res.info.duration > 10) chips.appendChild(mk('前 10 秒', 0, 10));
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
    box.innerHTML = `<video src="${url}" muted preload="metadata"></video>`;
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

function clearFile() {
  file = null;
  files = null;
  window.__crop = null;
  window.__secondFile = null;
  $('file-card').classList.add('hidden');
  $('params').classList.add('hidden');
  $('action-bar').classList.add('hidden');
  $('result-card').classList.add('hidden');
  $('dropzone').classList.remove('hidden');
  $('preview-box').style.display = '';
}

// ---------------------------------------------------------------------------
// 执行任务
// ---------------------------------------------------------------------------

async function runTask() {
  const ctx = currentFeature.multi ? { files } : { file };
  if (currentFeature.multi ? !files?.length : !file) return;
  if (running) return;
  let params;
  try {
    params = await currentFeature.collect(collectFieldValues(), ctx);
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

async function showSuccess(res) {
  const name = res.output.split(/[\\/]/).pop();
  let line;
  if (res.outputType === 'dir') {
    const count = await window.api.countDir(res.output);
    line = `✅ 已导出 ${count} 张图片到文件夹`;
  } else {
    const outSize = await window.api.statFile(res.output);
    line = `✅ 完成：${name}（${fmtSize(outSize)}）`;
    if (currentFeature.id === 'compressGif' && file?.info.size) {
      const pct = Math.max(0, Math.round((1 - outSize / file.info.size) * 100));
      line = `✅ 压缩完成：${fmtSize(file.info.size)} → ${fmtSize(outSize)}，节省 ${pct}%`;
    }
    if (currentFeature.id === 'compressTarget') {
      const srcSize = file?.info.size || 0;
      const pct = srcSize ? Math.max(0, Math.round((1 - outSize / srcSize) * 100)) : 0;
      line += srcSize ? `（原 ${fmtSize(srcSize)}，减小 ${pct}%）` : '';
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
  // range 的数值
  const range = document.querySelector('#params input[type="range"][data-key]');
  if (range) values[range.dataset.key] = parseFloat(range.value);
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
    const p = await window.api.pickFile(currentFeature.id);
    if (p) useFiles(Array.isArray(p) ? p : [p]);
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
    // 多文件功能接受全部；单文件功能取第一个
    useFiles(currentFeature.multi ? paths : [paths[0]]);
  });

  $('btn-run').onclick = runTask;
  $('btn-cancel').onclick = () => {
    if (currentTaskId) window.api.cancelTask(currentTaskId);
  };
}

window.addEventListener('DOMContentLoaded', () => {
  renderNav();
  selectFeature(FEATURES[0]);
  bindEvents();
  window.api.onProgress(({ taskId, ratio }) => {
    currentTaskId = taskId;
    if (running) setProgress(ratio);
  });
});
