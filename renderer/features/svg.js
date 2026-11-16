(() => {
'use strict';

window.VGT = window.VGT || {};

const imgExts = () => window.VGT.IMG_EXTS || ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif'];

function resolveBgColor(v, fallback = 'transparent') {
  if (v.bgMode === 'transparent') return 'transparent';
  if (v.bgMode === 'white') return '#ffffff';
  if (v.bgMode === 'black') return '#000000';
  if (v.bgMode === 'custom') return v.bgCustom || '#ffffff';
  return fallback;
}

window.VGT.SVG_FEATURES = [
  {
    id: 'svgToRaster', group: 'SVG', icon: '📐', name: 'SVG 转位图', desc: '将 SVG 矢量图高清渲染为 PNG / WebP / JPG / ICO / AVIF / BMP，支持倍率与透明背景',
    accept: ['svg'],
    fields: [
      { key: 'format', label: '目标格式', type: 'chips', def: 'png',
        options: [
          ['png', 'PNG（无损透明，推荐）'],
          ['webp', 'WebP'],
          ['jpg', 'JPG'],
          ['ico', 'ICO 图标'],
          ['avif', 'AVIF'],
          ['bmp', 'BMP'],
        ] },
      { key: 'scaleMode', label: '导出尺寸', type: 'chips', def: 'scale',
        options: [
          ['scale', '按倍率缩放'],
          ['width', '指定宽度'],
          ['maxSide', '限制最长边'],
          ['original', '原始尺寸 (1×)'],
        ],
        showIf: (v) => v.format !== 'ico' },
      { key: 'scale', label: '渲染倍率', type: 'chips', def: '2',
        options: [['1', '1×'], ['2', '2×（高清推荐）'], ['3', '3×'], ['4', '4×（超清）']],
        showIf: (v) => v.format !== 'ico' && v.scaleMode === 'scale' },
      { key: 'width', label: '目标宽度 (px，高度等比)', type: 'number', def: '1024', min: 16, max: 8192, step: 2,
        presets: [['256', '256 px'], ['512', '512 px'], ['1024', '1024 px'], ['2048', '2048 px']],
        showIf: (v) => v.format !== 'ico' && v.scaleMode === 'width' },
      { key: 'maxSide', label: '最长边像素 (px)', type: 'number', def: '1920', min: 16, max: 8192, step: 2,
        presets: [['512', '512 px'], ['1024', '1024 px'], ['1920', '1920 px'], ['4096', '4096 px']],
        showIf: (v) => v.format !== 'ico' && v.scaleMode === 'maxSide' },
      { key: 'icoSize', label: 'ICO 图标尺寸', type: 'chips', def: '256',
        options: [['32', '32×32'], ['48', '48×48'], ['64', '64×64'], ['128', '128×128'], ['256', '256×256（推荐）']],
        showIf: (v) => v.format === 'ico' },
      { key: 'quality', label: '编码画质', type: 'chips', def: 'high',
        options: [['high', '高画质'], ['medium', '均衡'], ['low', '体积优先']],
        showIf: (v) => ['jpg', 'webp', 'avif'].includes(v.format) },
      { key: 'bgMode', label: '背景填充', type: 'chips', def: 'transparent',
        options: [['transparent', '透明背景'], ['white', '纯白'], ['black', '纯黑'], ['custom', '自定义…']],
        showIf: (v) => v.format !== 'jpg' && v.format !== 'bmp' },
      { key: 'bgCustom', label: '自定义背景色', type: 'color', def: '#ffffff',
        showIf: (v) => v.bgMode === 'custom' || v.format === 'jpg' || v.format === 'bmp' },
    ],
    collect(v, ctx) {
      const needOpaque = v.format === 'jpg' || v.format === 'bmp';
      return {
        input: ctx.file.path,
        format: v.format,
        scaleMode: v.format === 'ico' ? 'original' : v.scaleMode,
        scale: v.scale,
        width: v.width,
        maxSide: v.maxSide,
        icoSize: v.icoSize,
        quality: v.quality,
        bgColor: needOpaque && v.bgMode === 'transparent' ? (v.bgCustom || '#ffffff') : resolveBgColor(v),
      };
    },
  },
  {
    id: 'svgOptimize', group: 'SVG', icon: '⚡', name: 'SVG 压缩优化', desc: '基于 SVGO 清理冗余元数据、注释、空组与多余小数位，保留矢量清晰度大幅瘦身',
    accept: ['svg'],
    fields: [
      { key: 'preset', label: '优化策略', type: 'chips', def: 'default',
        options: [
          ['default', '标准安全瘦身（推荐）'],
          ['aggressive', '深度极限压缩'],
          ['pretty', '清理并格式化缩进'],
        ] },
      { key: 'floatPrecision', label: '坐标小数精度', type: 'chips', def: '2',
        options: [['1', '1 位（最小）'], ['2', '2 位（推荐）'], ['3', '3 位（精细）'], ['4', '4 位']] },
      { key: 'keepViewBox', label: 'viewBox 属性', type: 'chips', def: 'yes',
        options: [['yes', '保留 viewBox（推荐）'], ['no', '允许移除']] },
      { key: 'stripDims', label: '固定宽高属性', type: 'chips', def: 'no',
        options: [['no', '保留 width/height'], ['yes', '移除（自适应缩放）']] },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        preset: v.preset,
        floatPrecision: v.floatPrecision,
        multipass: true,
        keepViewBox: v.keepViewBox === 'yes',
        stripDims: v.stripDims === 'yes',
      };
    },
  },
  {
    id: 'imageToSvg', group: 'SVG', icon: '✒️', name: '图片转 SVG 矢量', desc: '位图自动描摹转为可无限放大的 SVG 矢量图（适合 Logo / 图标 / 线稿 / 扁平插画）',
    accept: imgExts(),
    fields: [
      { key: 'mode', label: '矢量化风格', type: 'chips', def: 'bw',
        options: [
          ['bw', '黑白单色剪影（Logo/线稿推荐）'],
          ['poster', '扁平色块（图标/卡通）'],
          ['detailed', '多彩插画（24 色）'],
          ['pixel', '像素格矢量'],
        ] },
      { key: 'colors', label: '色彩层数', type: 'chips', def: 'auto',
        options: [['auto', '跟随风格'], ['4', '4 色'], ['8', '8 色'], ['16', '16 色'], ['24', '24 色'], ['32', '32 色']],
        showIf: (v) => v.mode !== 'bw' },
      { key: 'smooth', label: '边缘平滑度', type: 'chips', def: 'medium',
        options: [['low', '高贴合'], ['medium', '均衡（推荐）'], ['high', '圆润平滑']],
        showIf: (v) => v.mode !== 'pixel' },
      { key: 'transparentBg', label: '背景处理', type: 'chips', def: 'alpha',
        options: [
          ['alpha', '保留透明 / 去黑白底（推荐）'],
          ['white', '去除纯白背景'],
          ['none', '保留完整不透明底'],
        ] },
      { key: 'maxDim', label: '采样解析度上限', type: 'chips', def: '800',
        options: [['400', '400 px（极速）'], ['800', '800 px（推荐）'], ['1200', '1200 px'], ['1600', '1600 px（精细）']] },
      { key: 'noiseFilter', label: '去碎点阈值', type: 'chips', def: '8',
        options: [['0', '保留全部细节'], ['8', '常规去噪（推荐）'], ['24', '强力去噪']] },
      { key: 'optimizeSvg', label: '生成后体积优化', type: 'chips', def: 'yes',
        options: [['yes', '自动 SVGO 精简（推荐）'], ['no', '保留原始描摹路径']] },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        mode: v.mode,
        colors: v.colors === 'auto' ? 0 : v.colors,
        smooth: v.smooth,
        transparentBg: v.transparentBg,
        maxDim: v.maxDim,
        noiseFilter: v.noiseFilter,
        optimizeSvg: v.optimizeSvg === 'yes',
      };
    },
  },
];
})();
