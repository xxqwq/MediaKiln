(() => {
'use strict';

window.VGT = window.VGT || {};

const imgExts = () => window.VGT.IMG_EXTS || ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif'];

function resolveBgColor(v, fallback = '#ffffff') {
  if (v.bgMode === 'transparent') return 'transparent';
  if (v.bgMode === 'black') return '#000000';
  if (v.bgMode === 'white') return '#ffffff';
  if (v.bgMode === 'dark') return '#0f1115';
  if (v.bgMode === 'custom') return v.bgCustom || fallback;
  return fallback;
}

window.VGT.IMAGE_FEATURES = [
  {
    id: 'imageConvert', group: '图片', icon: '🖼️', name: '格式转换与压缩', desc: 'JPG / PNG / WebP / AVIF / BMP / ICO 互转，支持缩放与 PNG 8位瘦身',
    accept: imgExts(),
    fields: [
      { key: 'format', label: '目标格式', type: 'chips', def: 'webp',
        options: [
          ['webp', 'WebP（推荐）'],
          ['jpg', 'JPG'],
          ['png', 'PNG'],
          ['avif', 'AVIF（极小）'],
          ['ico', 'ICO 图标'],
          ['bmp', 'BMP'],
        ] },
      { key: 'quality', label: '画质 / 压缩模式', type: 'chips', def: 'high',
        options: [
          ['high', '高画质'],
          ['medium', '均衡（推荐）'],
          ['low', '体积优先'],
          ['png8', 'PNG 量化瘦身 (8-bit)'],
        ],
        showIf: (v) => v.format !== 'bmp' && v.format !== 'ico' },
      { key: 'icoSize', label: '图标尺寸', type: 'chips', def: '256',
        options: [['32', '32×32'], ['48', '48×48'], ['64', '64×64'], ['128', '128×128'], ['256', '256×256（推荐）']],
        showIf: (v) => v.format === 'ico' },
      { key: 'resizeMode', label: '尺寸调整', type: 'chips', def: 'keep',
        options: [['keep', '保持原尺寸'], ['maxSide', '限制最长边'], ['percent', '按比例缩放'], ['width', '指定宽度']],
        showIf: (v) => v.format !== 'ico' },
      { key: 'maxSide', label: '最长边上限 (px)', type: 'select', def: '1920',
        options: [['2560', '2560 px (2K)'], ['1920', '1920 px (1080p)'], ['1280', '1280 px'], ['1080', '1080 px'], ['800', '800 px'], ['512', '512 px']],
        showIf: (v) => v.format !== 'ico' && v.resizeMode === 'maxSide' },
      { key: 'percent', label: '缩放比例', type: 'chips', def: '50',
        options: [['75', '75%'], ['50', '50%'], ['25', '25%']],
        showIf: (v) => v.format !== 'ico' && v.resizeMode === 'percent' },
      { key: 'customWidth', label: '目标宽度 (px，高度等比)', type: 'number', def: '1080', min: 16, max: 8192, step: 2,
        showIf: (v) => v.format !== 'ico' && v.resizeMode === 'width' },
      { key: 'bgColor', label: '透明底填充色（转 JPG / BMP 时生效）', type: 'color', def: '#ffffff',
        presets: [['#ffffff', '纯白'], ['#000000', '纯黑']],
        showIf: (v) => v.format === 'jpg' || v.format === 'bmp' },
      { key: 'stripMeta', label: '隐私保护', type: 'chips', def: 'yes',
        options: [['yes', '同时清除 EXIF/GPS'], ['no', '保留元数据']] },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        format: v.format,
        quality: v.format === 'png' ? v.quality : (v.quality === 'png8' ? 'medium' : v.quality),
        icoSize: v.icoSize,
        resizeMode: v.resizeMode,
        maxSide: v.maxSide,
        percent: v.percent,
        customWidth: v.customWidth,
        bgColor: v.bgColor,
        stripMeta: v.stripMeta,
      };
    },
  },
  {
    id: 'imageCompressTarget', group: '图片', icon: '🎯', name: '压缩到指定体积 (KB)', desc: '二分搜索最佳画质并自适应缩图，精确满足证件照/网站上传限制',
    accept: imgExts(),
    fields: [
      { key: 'targetKB', label: '目标体积上限 (KB)', type: 'number', def: '200', min: 20, max: 10240, step: 10,
        presets: [['100', '100 KB'], ['200', '200 KB（证件照）'], ['500', '500 KB'], ['1024', '1 MB'], ['2048', '2 MB']] },
      { key: 'format', label: '输出格式', type: 'chips', def: 'auto',
        options: [['auto', '智能选择（推荐）'], ['jpg', 'JPG（通用）'], ['webp', 'WebP（清晰最小）'], ['png', 'PNG（保留透明）']] },
      { key: 'bgColor', label: '透明转 JPG 垫底色', type: 'color', def: '#ffffff',
        presets: [['#ffffff', '纯白'], ['#000000', '纯黑']],
        showIf: (v) => v.format === 'jpg' },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        targetKB: v.targetKB,
        format: v.format,
        bgColor: v.bgColor,
        srcW: ctx.file.info.width,
        srcH: ctx.file.info.height,
      };
    },
  },
  {
    id: 'imageStitch', group: '图片', icon: '🧩', name: '长图拼接 / 拼图', desc: '多张图片竖向长图拼接、横向拼接或 2~4 列网格拼图（支持调序）',
    accept: imgExts(), multi: true,
    fields: [
      { key: 'mode', label: '拼接方式', type: 'chips', def: 'vertical',
        options: [['vertical', '纵向长图'], ['horizontal', '横向拼接'], ['grid', '网格拼图']] },
      { key: 'cols', label: '网格列数', type: 'chips', def: '2',
        options: [['2', '2 列'], ['3', '3 列'], ['4', '4 列']],
        showIf: (v) => v.mode === 'grid' },
      { key: 'fit', label: '格子填充方式', type: 'chips', def: 'cover',
        options: [['cover', '居中裁切填满'], ['contain', '完整留白显示']],
        showIf: (v) => v.mode === 'grid' },
      { key: 'cellRatio', label: '格子比例', type: 'chips', def: '1:1',
        options: [['1:1', '1:1 正方形'], ['4:3', '4:3 横图'], ['3:4', '3:4 竖图']],
        showIf: (v) => v.mode === 'grid' },
      { key: 'gap', label: '图片间距 (px)', type: 'chips', def: '8',
        options: [['0', '无缝 (0px)'], ['8', '细缝 (8px)'], ['16', '适中 (16px)'], ['24', '宽边距 (24px)']] },
      { key: 'format', label: '输出格式', type: 'chips', def: 'jpg',
        options: [['jpg', 'JPG（分享方便）'], ['png', 'PNG（无损）'], ['webp', 'WebP']] },
      { key: 'bgMode', label: '间距与底色', type: 'chips', def: 'white',
        options: [['white', '纯白'], ['black', '纯黑'], ['dark', '深灰'], ['transparent', '透明（PNG/WebP）'], ['custom', '自定义…']] },
      { key: 'bgCustom', label: '自定义底色', type: 'color', def: '#ffffff',
        showIf: (v) => v.bgMode === 'custom' },
    ],
    collect(v, ctx) {
      const sizes = {};
      for (const f of ctx.files) sizes[f.path] = { w: f.info?.width || 0, h: f.info?.height || 0 };
      return {
        files: ctx.files.map((f) => f.path),
        infos: ctx.files.map((f) => f.info),
        sizes,
        mode: v.mode,
        cols: v.cols,
        fit: v.fit,
        cellRatio: v.cellRatio,
        gap: v.gap,
        format: v.format,
        bgColor: resolveBgColor(v, '#ffffff'),
      };
    },
  },
  {
    id: 'imageSplit', group: '图片', icon: '✂️', name: '九宫格切图 / 长图切片', desc: '将图片切成 3×3 九宫格、2×2 四宫格，或将超长图按段/高度切分',
    accept: imgExts(),
    fields: [
      { key: 'mode', label: '切分模式', type: 'chips', def: '3x3',
        options: [
          ['3x3', '3×3 九宫格'],
          ['2x2', '2×2 四宫格'],
          ['3x1', '3×1 横向三图'],
          ['1x3', '1×3 纵向三图'],
          ['longCount', '长图均分 N 段'],
          ['longHeight', '长图按高度切分'],
        ] },
      { key: 'count', label: '切分张数', type: 'number', def: '4', min: 2, max: 20, step: 1,
        presets: [['2', '2 张'], ['3', '3 张'], ['4', '4 张'], ['6', '6 张']],
        showIf: (v) => v.mode === 'longCount' },
      { key: 'sliceHeight', label: '每张高度 (px)', type: 'number', def: '1280', min: 100, max: 8000, step: 40,
        presets: [['1080', '1080 px'], ['1280', '1280 px'], ['1920', '1920 px']],
        showIf: (v) => v.mode === 'longHeight' },
      { key: 'format', label: '导出格式', type: 'chips', def: 'png',
        options: [['png', 'PNG（无损）'], ['jpg', 'JPG'], ['webp', 'WebP']] },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        mode: v.mode,
        count: v.count,
        sliceHeight: v.sliceHeight,
        format: v.format,
        srcW: ctx.file.info.width,
        srcH: ctx.file.info.height,
      };
    },
  },
  {
    id: 'imageCutout', group: '图片', icon: '🪄', name: '纯色抠图透明 PNG', desc: '抠除白底、绿幕或纯色背景，导出透明底 PNG/WebP（支持取色吸管）',
    accept: imgExts(),
    fields: [
      { key: 'color', label: '要抠除的背景色', type: 'color', def: '#ffffff', eyedropper: true,
        presets: [['#ffffff', '纯白底'], ['#00ff00', '绿幕'], ['#0000ff', '蓝幕'], ['#000000', '纯黑底']] },
      { key: 'similarity', label: '色彩容差', type: 'range', def: '0.18', min: 0.02, max: 0.5, step: 0.02, unit: '',
        presets: [['0.08', '严谨 0.08'], ['0.18', '适中 0.18'], ['0.3', '宽松 0.3']] },
      { key: 'blend', label: '边缘羽化', type: 'range', def: '0.06', min: 0, max: 0.3, step: 0.02, unit: '',
        presets: [['0', '无'], ['0.06', '柔和 0.06'], ['0.16', '强羽化']] },
      { key: 'format', label: '输出格式', type: 'chips', def: 'png',
        options: [['png', '透明 PNG（推荐）'], ['webp', '透明 WebP']] },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        color: v.color,
        similarity: v.similarity,
        blend: v.blend,
        format: v.format,
      };
    },
  },
  {
    id: 'imageFrame', group: '图片', icon: '⬜', name: '圆角与边框留白', desc: '为图片添加抗锯齿圆角（支持透明底）或相框外边距留白',
    accept: imgExts(),
    fields: [
      { key: 'rounded', label: '圆角半径 (px)', type: 'chips', def: '24',
        options: [['0', '直角'], ['16', '小圆角 16'], ['24', '中圆角 24'], ['48', '大圆角 48'], ['96', '超大 96']] },
      { key: 'padding', label: '外边框留白 (px)', type: 'chips', def: '24',
        options: [['0', '无边框'], ['16', '窄边 16'], ['24', '适中 24'], ['48', '相框 48'], ['80', '宽画框 80']] },
      { key: 'format', label: '输出格式', type: 'chips', def: 'png',
        options: [['png', 'PNG（支持透明角）'], ['webp', 'WebP（支持透明角）'], ['jpg', 'JPG（纯色底）']] },
      { key: 'bgMode', label: '边框 / 角落底色', type: 'chips', def: 'transparent',
        options: [['transparent', '透明底'], ['white', '纯白'], ['black', '纯黑'], ['custom', '自定义…']],
        showIf: (v) => v.format !== 'jpg' },
      { key: 'bgCustom', label: '自定义底色', type: 'color', def: '#ffffff',
        showIf: (v) => v.bgMode === 'custom' || v.format === 'jpg' },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        rounded: v.rounded,
        padding: v.padding,
        format: v.format,
        bgColor: v.format === 'jpg' ? (v.bgCustom || '#ffffff') : resolveBgColor(v, '#ffffff'),
        srcW: ctx.file.info.width,
        srcH: ctx.file.info.height,
      };
    },
  },
];
})();
