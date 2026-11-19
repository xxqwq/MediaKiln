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
    id: 'imageOcr', group: '图片', icon: '🔍', name: '图片 OCR 识字',
    desc: '离线识别截图和照片中的中英文，可直接复制或批量导出 TXT',
    accept: imgExts(),
    fields: [
      { key: 'ocrLang', label: '识别语言', type: 'chips', def: 'auto',
        options: [['auto', '中英混排'], ['zh', '简体中文优先'], ['en', '英文优先']] },
    ],
    collect(v, ctx) {
      return { input: ctx.file.path, ocrLang: v.ocrLang || 'auto' };
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
    id: 'imageReplaceBg', group: '图片', icon: '🎨', name: '图片更换背景', desc: '为透明图或纯色底图片（如证件照白/蓝/红底、产品图）更换纯色、渐变或自定义图片背景',
    accept: imgExts(),
    fields: [
      { key: 'bgType', label: '新背景类型', type: 'chips', def: 'solid',
        options: [['solid', '纯色背景（证件照/白底）'], ['gradient', '渐变背景'], ['image', '自定义图片背景']] },
      { key: 'bgColor', label: '新背景颜色', type: 'color', def: '#438edb',
        presets: [['#ffffff', '纯白'], ['#438edb', '证件蓝'], ['#e60012', '证件红'], ['#000000', '纯黑'], ['#f3f4f6', '浅灰']],
        showIf: (v) => v.bgType === 'solid' },
      { key: 'gradStart', label: '渐变起始色', type: 'color', def: '#6366f1',
        presets: [['#6366f1', '靛紫'], ['#0ea5e9', '天蓝'], ['#f43f5e', '玫红'], ['#ffffff', '柔白']],
        showIf: (v) => v.bgType === 'gradient' },
      { key: 'gradEnd', label: '渐变结束色', type: 'color', def: '#22d3ee',
        presets: [['#22d3ee', '青蓝'], ['#a855f7', '紫罗兰'], ['#f59e0b', '暖橙'], ['#cbd5e1', '银灰']],
        showIf: (v) => v.bgType === 'gradient' },
      { key: 'gradDir', label: '渐变方向', type: 'chips', def: 'tlbr',
        options: [['tb', '从上到下 ↓'], ['lr', '从左到右 →'], ['tlbr', '左上→右下 ↘'], ['radial', '中心径向 ◉']],
        showIf: (v) => v.bgType === 'gradient' },
      { type: 'secondFile', key: 'bgImage', kind: 'imageFile', label: '背景图片', placeholder: '请选择用作背景的图片…',
        showIf: (v) => v.bgType === 'image' },
      { key: 'bgFit', label: '画布与背景适配方式', type: 'chips', def: 'bgOriginal', fullWidth: true,
        options: [
          ['bgOriginal', '以背景图原宽高为画布（不裁剪背景，推荐）'],
          ['cover', '以原图尺寸铺满裁切'],
          ['stretch', '以原图尺寸拉伸填满'],
          ['contain', '以原图尺寸完整居中'],
        ],
        showIf: (v) => v.bgType === 'image' },
      { key: 'fgScale', label: '前景图大小（背景原尺寸模式）', type: 'chips', def: 'fitAuto',
        options: [
          ['fitAuto', '原宽高放入（仅超框时等比缩进，推荐）'],
          ['contain', '等比适配背景大小'],
          ['keep', '严格保持前景原像素宽高'],
        ],
        showIf: (v) => v.bgType === 'image' && v.bgFit === 'bgOriginal' },
      { key: 'fgPos', label: '前景图放置位置', type: 'chips', def: 'center',
        options: [
          ['center', '正居中'],
          ['bottom', '底端居中（人物/商品）'],
          ['tl', '左上角'],
          ['tr', '右上角'],
          ['bl', '左下角'],
          ['br', '右下角'],
        ],
        showIf: (v) => v.bgType === 'image' && v.bgFit === 'bgOriginal' },
      { key: 'fgMode', label: '原图背景识别', type: 'chips', def: 'auto', fullWidth: true,
        options: [
          ['auto', '智能识别（透明图直换 / 纯色底自动抠除，推荐）'],
          ['keepAlpha', '原图已是透明底（仅填新底）'],
          ['colorkey', '强制按指定色抠图再换底'],
        ] },
      { key: 'keyColor', label: '待替换的原背景色', type: 'color', def: '#ffffff', eyedropper: true,
        presets: [['#ffffff', '白底'], ['#438edb', '证件蓝'], ['#e60012', '证件红'], ['#00ff00', '绿幕'], ['#000000', '黑底']],
        showIf: (v) => v.fgMode !== 'keepAlpha' },
      { key: 'cutoutScope', label: '抠图保护范围', type: 'chips', def: 'edge',
        options: [
          ['edge', '边缘连通抠图（保护主体内同色，推荐）'],
          ['global', '全局同色抠图（含镂空内部）'],
        ],
        showIf: (v) => v.fgMode !== 'keepAlpha' },
      { key: 'similarity', label: '背景容差', type: 'range', def: '0.18', min: 0.02, max: 0.5, step: 0.02, unit: '',
        presets: [['0.08', '严谨 0.08'], ['0.18', '适中 0.18'], ['0.3', '宽松 0.3']],
        showIf: (v) => v.fgMode !== 'keepAlpha' },
      { key: 'blend', label: '边缘羽化', type: 'range', def: '0.06', min: 0, max: 0.3, step: 0.02, unit: '',
        presets: [['0', '无'], ['0.06', '柔和 0.06'], ['0.16', '强羽化']],
        showIf: (v) => v.fgMode !== 'keepAlpha' },
      { key: 'format', label: '输出格式', type: 'chips', def: 'png',
        options: [['png', 'PNG（高清无损，推荐）'], ['jpg', 'JPG（通用小巧）'], ['webp', 'WebP']] },
    ],
    collect(v, ctx) {
      if (v.bgType === 'image' && !window.__secondFile) {
        throw new Error('请先选择背景图片');
      }
      return {
        input: ctx.file.path,
        bgType: v.bgType,
        bgColor: v.bgColor,
        gradStart: v.gradStart,
        gradEnd: v.gradEnd,
        gradDir: v.gradDir,
        bgImage: v.bgType === 'image' ? window.__secondFile : '',
        bgFit: v.bgFit,
        fgScale: v.fgScale,
        fgPos: v.fgPos,
        fgMode: v.fgMode,
        keyColor: v.keyColor,
        cutoutScope: v.cutoutScope,
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
  {
    id: 'imageCanvas', group: '图片', icon: '🛍️', name: '电商主图 / 标准画布', desc: '一键套用淘宝/小红书/头像标准尺寸画布，支持留白、满铺裁切或背景虚化填充',
    accept: imgExts(),
    fields: [
      { key: 'preset', label: '画布尺寸', type: 'select', def: '800x800',
        options: [
          ['800x800', '800×800（电商白底主图，推荐）'],
          ['1000x1000', '1000×1000（高清方图）'],
          ['1080x1440', '1080×1440（小红书 3:4 竖图）'],
          ['1200x1600', '1200×1600（高清 3:4 海报）'],
          ['1080x1080', '1080×1080（Ins/海报方图）'],
          ['512x512', '512×512（头像/图标）'],
          ['custom', '自定义宽高…'],
        ] },
      { key: 'customW', label: '自定义宽度 (px)', type: 'number', def: '1080', min: 64, max: 4096, step: 2,
        showIf: (v) => v.preset === 'custom' },
      { key: 'customH', label: '自定义高度 (px)', type: 'number', def: '1080', min: 64, max: 4096, step: 2,
        showIf: (v) => v.preset === 'custom' },
      { key: 'fit', label: '构图适配方式', type: 'chips', def: 'contain',
        options: [
          ['contain', '完整居中留白（推荐）'],
          ['cover', '居中铺满裁切'],
          ['blur', '同图模糊延伸填充'],
        ] },
      { key: 'marginPct', label: '四周留白安全边距', type: 'chips', def: '5',
        options: [['0', '0%（贴边）'], ['5', '5%（微留白）'], ['10', '10%（电商留白）'], ['15', '15%（宽留白）']],
        showIf: (v) => v.fit !== 'cover' },
      { key: 'format', label: '输出格式', type: 'chips', def: 'jpg',
        options: [['jpg', 'JPG（电商通用）'], ['png', 'PNG（可透明底）'], ['webp', 'WebP（高清轻量）']] },
      { key: 'bgMode', label: '背景颜色', type: 'chips', def: 'white',
        options: [['white', '纯白底'], ['black', '纯黑底'], ['transparent', '透明（PNG/WebP）'], ['custom', '自定义…']],
        showIf: (v) => v.fit === 'contain' },
      { key: 'bgCustom', label: '自定义背景色', type: 'color', def: '#ffffff',
        showIf: (v) => v.fit === 'contain' && v.bgMode === 'custom' },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        preset: v.preset || '800x800',
        customW: v.customW,
        customH: v.customH,
        fit: v.fit || 'contain',
        marginPct: v.marginPct ?? '5',
        format: v.format || 'jpg',
        bgColor: resolveBgColor(v, '#ffffff'),
      };
    },
  },
];
})();
