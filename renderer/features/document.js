(() => {
'use strict';

window.VGT = window.VGT || {};

window.VGT.DOC_FEATURES = [
  {
    id: 'docCompressImages', group: '文档', icon: '🗜️', name: 'Word / PPT 一键压缩瘦身',
    desc: '自动识别 Word (.docx) 和 PPT (.pptx) 内的图片（含 PPT 内嵌视频），支持按指定章节/页或全文原位压缩并完整保留文字与排版',
    accept: ['docx', 'pptx'],
    fields: [
      { key: 'sectionIds', label: '压缩范围（按章节 / 页）', type: 'docSections', actionWord: '压缩', emptyTarget: 'Word / PPT 文档', fullWidth: true },
      { key: 'preset', label: '压缩强度', type: 'chips', def: 'balanced',
        options: [
          ['high', '高画质轻压'],
          ['balanced', '均衡压缩（推荐）'],
          ['extreme', '极限瘦身'],
        ] },
      { key: 'maxSide', label: '图片/视频分辨率上限', type: 'chips', def: '1920',
        options: [
          ['0', '保持原像素'],
          ['2560', '2560 px (2K)'],
          ['1920', '1920 px (1080p，推荐)'],
          ['1280', '1280 px (小巧)'],
        ] },
      { key: 'formatMode', label: '图片编码格式', type: 'chips', def: 'auto',
        options: [
          ['auto', '智能（不透明图转JPG / 透明保PNG，推荐）'],
          ['keep', '严格保留原图片格式'],
          ['jpg', '全部转 JPG（体积最小）'],
        ] },
      { key: 'videoMode', label: 'PPT 内嵌视频处理', type: 'chips', def: 'compress',
        options: [
          ['compress', '同步压缩内嵌视频（仅 PPT，推荐）'],
          ['keep', '仅压缩图片，保留视频原样'],
        ] },
    ],
    collect(v, ctx) {
      const params = {
        input: ctx.file.path,
        preset: v.preset,
        maxSide: v.maxSide,
        formatMode: v.formatMode,
        videoMode: v.videoMode,
      };
      const sections = ctx.file?.info?.sections;
      if (Array.isArray(sections) && sections.length > 0 && Array.isArray(window.__docSelectedSectionIds)) {
        if (!window.__docSelectedSectionIds.length) {
          throw new Error('请至少勾选一个要压缩的章节或页面');
        }
        if (window.__docSelectedSectionIds.length < sections.length) {
          params.sectionIds = window.__docSelectedSectionIds.slice();
        }
      }
      return params;
    },
  },
  {
    id: 'docExtractImages', group: '文档', icon: '📑', name: 'Word / PPT / MD 提取图片',
    desc: '识别 Word (.docx)、PPT (.pptx) 和 Markdown (.md) 中的图片、Base64 与内联 SVG，支持单张发给其他工具或改完放回原位',
    accept: ['docx', 'pptx', 'md', 'markdown'],
    fields: [
      { key: 'sectionIds', label: '提取范围（按章节 / 页）', type: 'docSections', fullWidth: true },
      { key: 'naming', label: '导出文件命名', type: 'chips', def: 'order',
        options: [
          ['order', '按文档顺序编号 (01_原名，推荐)'],
          ['original', '保留原文件名'],
        ] },
      { key: 'pptMedia', label: 'PPT 内嵌音视频', type: 'chips', def: 'images',
        options: [
          ['images', '仅提取图片（推荐）'],
          ['all', '图片 + 内嵌音视频一起提取'],
        ] },
      { key: 'remoteMode', label: 'Markdown 网络图片 (http/https)', type: 'chips', def: 'skip',
        options: [
          ['skip', '仅识别本地 / 内嵌图（最快）'],
          ['download', '同时下载网络图片'],
        ] },
      { key: 'includeSvg', label: 'SVG 矢量图', type: 'chips', def: 'yes',
        options: [['yes', '一并提取 SVG'], ['no', '仅提取位图']] },
      { key: 'dedupe', label: '重复图片', type: 'chips', def: 'yes',
        options: [['yes', '自动去重（推荐）'], ['no', '保留全部引用']] },
    ],
    collect(v, ctx) {
      const params = {
        input: ctx.file.path,
        naming: v.naming,
        pptMedia: v.pptMedia,
        remoteMode: v.remoteMode,
        includeSvg: v.includeSvg === 'yes',
        dedupe: v.dedupe === 'yes',
      };
      const sections = ctx.file?.info?.sections;
      if (Array.isArray(sections) && sections.length > 0 && Array.isArray(window.__docSelectedSectionIds)) {
        if (!window.__docSelectedSectionIds.length) {
          throw new Error('请至少勾选一个要提取的章节或页面');
        }
        if (window.__docSelectedSectionIds.length < sections.length) {
          params.sectionIds = window.__docSelectedSectionIds.slice();
        }
      }
      return params;
    },
  },
  {
    id: 'docRepackImages', group: '文档', icon: '📥', name: '图片放回 Word / PPT 原位',
    desc: '将提取并处理/压缩/打码后的图片按原位置自动替换回 Word (.docx) 或 PPT (.pptx)，格式变更也会自动修复文档引用',
    accept: ['docx', 'pptx'], noBatch: true,
    fields: [
      { type: 'replaceSource', label: '修改/压缩后的图片', fullWidth: true,
        placeholder: '请选择提取并处理后的文件夹，或直接多选替换图片' },
      { key: 'sizeMode', label: '版面尺寸处理', type: 'chips', def: 'keepWidth', fullWidth: true,
        options: [
          ['keepWidth', '保持原显示宽度，按新图比例自适应高度（防拉伸，推荐）'],
          ['keepBox', '保持原固定宽高框（仅适合长宽比相同的图）'],
        ] },
    ],
    collect(v, ctx) {
      const src = window.__secondFile;
      if (!src || (!src.dir && !src.files?.length)) {
        throw new Error('请先选择修改/压缩后的图片文件夹或替换图片');
      }
      return {
        input: ctx.file.path,
        replaceDir: src.dir || '',
        replaceFiles: src.files || [],
        sizeMode: v.sizeMode || 'keepWidth',
      };
    },
  },
  {
    id: 'docCleanupMedia', group: '文档', icon: '🧹', name: 'Word / PPT 清理冗余与去重',
    desc: '深度扫描所有 XML 关系，一键移除 Word (.docx) / PPT (.pptx) 中未被正文引用的孤立隐藏媒体，并对重复嵌入图片按 SHA-256 去重瘦身',
    accept: ['docx', 'pptx'],
    fields: [
      { key: 'removeOrphans', label: '孤立/隐藏媒体清理', type: 'chips', def: 'yes',
        options: [
          ['yes', '移除未被引用的残留媒体（推荐）'],
          ['no', '保留未引用媒体'],
        ] },
      { key: 'dedupeMedia', label: '重复图片去重', type: 'chips', def: 'yes',
        options: [
          ['yes', '合并内容相同的重复图片（推荐）'],
          ['no', '保留重复副本'],
        ] },
    ],
    collect(v, ctx) {
      if (v.removeOrphans === 'no' && v.dedupeMedia === 'no') {
        throw new Error('请至少启用“移除未引用媒体”或“合并重复图片”中的一项');
      }
      return {
        input: ctx.file.path,
        removeOrphans: v.removeOrphans !== 'no',
        dedupeMedia: v.dedupeMedia !== 'no',
      };
    },
  },
  {
    id: 'docStyleImages', group: '文档', icon: '✨', name: 'Word / PPT 图片统一美化',
    desc: '无需逐张导出再回填，一键为 Word (.docx) / PPT (.pptx) 指定章节或全篇图片统一添加抗锯齿圆角、纯色边框或文字水印',
    accept: ['docx', 'pptx'],
    fields: [
      { key: 'sectionIds', label: '处理范围（按章节 / 页）', type: 'docSections', actionWord: '美化', emptyTarget: 'Word / PPT 文档', fullWidth: true },
      { key: 'frameMode', label: '圆角与边框效果', type: 'chips', def: 'rounded', fullWidth: true,
        options: [
          ['rounded', '抗锯齿圆角（透明角）'],
          ['roundedBorder', '圆角 + 纯色相框'],
          ['border', '纯色外边框'],
          ['none', '不改圆角/边框（仅加水印）'],
        ] },
      { key: 'radius', label: '圆角半径 (px)', type: 'chips', def: '24',
        options: [['12', '微圆 12px'], ['24', '标准 24px'], ['40', '大圆角 40px']],
        showIf: (v) => v.frameMode === 'rounded' || v.frameMode === 'roundedBorder' },
      { key: 'borderWidth', label: '边框宽度 (px)', type: 'chips', def: '16',
        options: [['8', '细框 8px'], ['16', '标准 16px'], ['32', '宽相框 32px']],
        showIf: (v) => v.frameMode === 'border' || v.frameMode === 'roundedBorder' },
      { key: 'borderColor', label: '边框颜色', type: 'color', def: '#ffffff',
        presets: [['#ffffff', '纯白'], ['#e2e8f0', '浅灰'], ['#1e293b', '深蓝灰'], ['#000000', '纯黑']],
        showIf: (v) => v.frameMode === 'border' || v.frameMode === 'roundedBorder' },
      { key: 'wmText', label: '统一文字水印（可选，留空不加）', type: 'text', def: '',
        placeholder: '如：内部资料 · 严禁外传（支持任意中文）' },
      { key: 'wmPos', label: '水印位置', type: 'chips', def: 'br',
        options: [['br', '右下角'], ['bl', '左下角'], ['tl', '左上角'], ['tr', '右上角'], ['center', '居中']],
        showIf: (v) => String(v.wmText || '').trim().length > 0 },
      { key: 'wmSize', label: '水印字号', type: 'chips', def: 'medium',
        options: [['small', '小号'], ['medium', '中号（推荐）'], ['large', '大号']],
        showIf: (v) => String(v.wmText || '').trim().length > 0 },
      { key: 'wmOpacity', label: '水印透明度', type: 'range', def: 0.45, min: 0.1, max: 1, step: 0.05, unit: '',
        presets: [['0.25', '淡印 0.25'], ['0.45', '适中 0.45'], ['0.75', '醒目 0.75']],
        showIf: (v) => String(v.wmText || '').trim().length > 0 },
      { key: 'wmColor', label: '水印文字颜色', type: 'chips', def: 'white',
        options: [['white', '白色带描边'], ['black', '黑色'], ['gray', '浅灰']],
        showIf: (v) => String(v.wmText || '').trim().length > 0 },
    ],
    collect(v, ctx) {
      const wmText = String(v.wmText || '').trim();
      if (!wmText && v.frameMode === 'none') {
        throw new Error('请输入水印文字，或选择圆角 / 边框美化效果');
      }
      const params = {
        input: ctx.file.path,
        frameMode: v.frameMode || 'rounded',
        radius: v.radius || '24',
        borderWidth: v.borderWidth || '16',
        borderColor: v.borderColor || '#ffffff',
        wmText,
        wmPos: v.wmPos || 'br',
        wmSize: v.wmSize || 'medium',
        wmOpacity: v.wmOpacity ?? '0.45',
        wmColor: v.wmColor || 'white',
      };
      const sections = ctx.file?.info?.sections;
      if (Array.isArray(sections) && sections.length > 0 && Array.isArray(window.__docSelectedSectionIds)) {
        if (!window.__docSelectedSectionIds.length) {
          throw new Error('请至少勾选一个要美化的章节或页面');
        }
        if (window.__docSelectedSectionIds.length < sections.length) {
          params.sectionIds = window.__docSelectedSectionIds.slice();
        }
      }
      return params;
    },
  },
  {
    id: 'mdOrganizeImages', group: '文档', icon: '📝', name: 'Markdown 图片整理',
    desc: '将 Markdown (.md) 中的图床/本地/Base64/内联 SVG 统一归拢到本地目录，或全部内嵌为单文件 Base64，也支持安全清理资源子目录中未引用的孤立图片',
    accept: ['md', 'markdown'],
    fields: [
      { key: 'action', label: '整理模式', type: 'chips', def: 'localize', fullWidth: true,
        options: [
          ['localize', '📦 一键本地化（收集到 assets 并重写路径）'],
          ['inlineBase64', '🧩 全部转为 Base64 内嵌（生成单文件）'],
          ['cleanUnused', '🗑️ 清理未引用图片（仅扫资源子目录）'],
        ] },
      { key: 'assetsDirName', label: '本地图片子文件夹名称', type: 'text', def: 'assets',
        placeholder: '默认 assets',
        showIf: (v) => v.action === 'localize' },
      { key: 'remoteMode', label: '网络图片 (http/https)', type: 'chips', def: 'download',
        options: [
          ['download', '下载并处理（推荐）'],
          ['skip', '保持网络链接不变'],
        ],
        showIf: (v) => v.action !== 'cleanUnused' },
      { key: 'inlineSvgMode', label: '内联 <svg> 代码块', type: 'chips', def: 'extract',
        options: [
          ['extract', '转为独立 .svg 图片引用'],
          ['keep', '保留正文内联 <svg>'],
        ],
        showIf: (v) => v.action === 'localize' },
      { key: 'cleanAction', label: '未引用图片处理方式', type: 'chips', def: 'move',
        options: [
          ['move', '移入 _已清理冗余 文件夹（安全可恢复，推荐）'],
          ['delete', '直接从磁盘删除'],
        ],
        showIf: (v) => v.action === 'cleanUnused' },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        action: v.action || 'localize',
        assetsDirName: v.assetsDirName || 'assets',
        remoteMode: v.remoteMode || 'download',
        inlineSvgMode: v.inlineSvgMode || 'extract',
        cleanAction: v.cleanAction || 'move',
      };
    },
  },
  {
    id: 'docToPdf', group: '文档', icon: '🖨️', name: 'MD / HTML 排版转 PDF',
    desc: '离线导出 Markdown 或本地 HTML，支持标题目录、代码高亮、表格与页码',
    accept: ['md', 'markdown', 'html', 'htm'],
    fields: [
      { key: 'theme', label: '排版主题（MD 生效）', type: 'chips', def: 'clean',
        options: [
          ['clean', '✨ 现代简洁（推荐）'],
          ['github', '📘 GitHub 文档'],
          ['warm', '📖 暖纸阅读'],
          ['dark', '🌙 深色极客'],
        ] },
      { key: 'pageSize', label: '纸张尺寸', type: 'chips', def: 'a4p',
        options: [
          ['a4p', 'A4 竖向（推荐）'],
          ['a4l', 'A4 横向'],
          ['letter', 'Letter 美式'],
        ] },
      { key: 'margin', label: '页边距', type: 'chips', def: 'normal',
        options: [
          ['narrow', '窄边距'],
          ['normal', '标准（推荐）'],
          ['wide', '宽边距'],
        ] },
      { key: 'pageNumbers', label: '页脚页码', type: 'chips', def: 'yes',
        options: [
          ['yes', '显示页码'],
          ['no', '隐藏页码'],
        ] },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        theme: v.theme || 'clean',
        pageSize: v.pageSize || 'a4p',
        margin: v.margin || 'normal',
        pageNumbers: v.pageNumbers || 'yes',
      };
    },
  },
  {
    id: 'wordToPdf', group: '文档', icon: '📘', name: 'Word 转 PDF',
    desc: '离线将 Word (.docx / .doc) 高清转换为带书签大纲的矢量 PDF，优先调用本机 Office / WPS / LibreOffice 原生引擎，未安装时自动回退内置排版引擎',
    accept: ['docx', 'doc'],
    fields: [
      { key: 'engine', label: '转换引擎', type: 'chips', def: 'auto', fullWidth: true,
        options: [
          ['auto', '⚡ 智能双引擎（优先本机 Office/WPS，自动回退内置，推荐）'],
          ['builtin', '🧩 内置离线引擎（免装 Office，可改纸张/边距/页码）'],
          ['office', '🏛️ 仅使用本机 Office / WPS / LibreOffice'],
        ] },
      { key: 'pageSize', label: '纸张尺寸（内置引擎生效）', type: 'chips', def: 'auto',
        options: [
          ['auto', '跟随 Word 原页面（推荐）'],
          ['a4p', 'A4 竖向'],
          ['a4l', 'A4 横向'],
          ['letter', 'Letter 美式'],
        ],
        showIf: (v) => v.engine !== 'office' },
      { key: 'margin', label: '页边距（内置引擎生效）', type: 'chips', def: 'auto',
        options: [
          ['auto', '跟随原边距'],
          ['normal', '标准 15mm'],
          ['narrow', '窄边距 10mm'],
          ['wide', '宽边距 22mm'],
        ],
        showIf: (v) => v.engine !== 'office' },
      { key: 'pageNumbers', label: '页脚页码（内置引擎生效）', type: 'chips', def: 'no',
        options: [
          ['no', '不额外添加'],
          ['yes', '底部居中显示页码'],
        ],
        showIf: (v) => v.engine !== 'office' },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        engine: v.engine || 'auto',
        pageSize: v.pageSize || 'auto',
        margin: v.margin || 'auto',
        pageNumbers: v.pageNumbers || 'no',
      };
    },
  },
  {
    id: 'pdfToWord', group: '文档', icon: '📝', name: 'PDF 转 Word',
    desc: '离线将 PDF 转为可编辑 Word (.docx)，自动重建表格、提取内嵌配图与双栏顺序；遇扫描件自动启用 Windows 离线 OCR 识别中英文',
    accept: ['pdf'],
    fields: [
      { key: 'mode', label: '转换模式', type: 'chips', def: 'editable', fullWidth: true,
        options: [
          ['editable', '📝 智能可编辑文档（还原表格/配图/双栏，无文字页自动 OCR）'],
          ['ocr', '🔍 扫描件全文离线 OCR 识别转 Word'],
          ['layout', '🖼️ 逐页版面保真 Word（原样嵌图防跑版）'],
        ] },
      { key: 'ocrLang', label: 'OCR 识别语言', type: 'chips', def: 'auto',
        options: [
          ['auto', '中英混排自动（推荐）'],
          ['zh', '简体中文优先'],
          ['en', '纯英文'],
        ],
        showIf: (v) => v.mode !== 'layout' },
      { key: 'keepPageBreak', label: '原文档分页', type: 'chips', def: 'yes',
        options: [
          ['yes', '每页保留分页符'],
          ['no', '合并为连续正文流'],
        ],
        showIf: (v) => v.mode !== 'layout' },
      { key: 'dpiScale', label: '渲染清晰度', type: 'chips', def: '2',
        options: [
          ['1.5', '1.5× 标准'],
          ['2', '2× 高清（推荐）'],
          ['3', '3× 超清'],
        ],
        showIf: (v) => v.mode === 'layout' },
      { key: 'pageRange', label: '页码范围（留空转换全部页）', type: 'text', def: '',
        placeholder: '例如：1-3, 5（留空为全部页面）' },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        mode: v.mode || 'editable',
        ocrLang: v.ocrLang || 'auto',
        keepPageBreak: v.keepPageBreak || 'yes',
        dpiScale: v.dpiScale || '2',
        pageRange: String(v.pageRange || '').trim(),
      };
    },
  },
  {
    id: 'pdfCompress', group: '文档', icon: '🗜️', name: 'PDF 压缩瘦身',
    desc: '按画质档位或目标大小压缩 PDF，保留可选中文字，也可选择全页栅格化',
    accept: ['pdf'],
    fields: [
      { key: 'preset', label: '压缩模式', type: 'chips', def: 'balanced', fullWidth: true,
        options: [
          ['high', '高画质轻压（保留文字矢量）'],
          ['balanced', '均衡压缩（保留文字，推荐）'],
          ['target', '按目标大小'],
          ['extreme', '极限瘦身（大幅压缩内嵌图）'],
          ['raster', '扫描化极限压缩（全页转图重压）'],
        ] },
      { key: 'maxSide', label: '内嵌图片像素上限', type: 'chips', def: '1920',
        options: [
          ['0', '保持原像素'],
          ['2560', '2560 px'],
          ['1920', '1920 px（推荐）'],
          ['1280', '1280 px（小巧）'],
        ],
        showIf: (v) => v.preset !== 'raster' && v.preset !== 'target' },
      { key: 'targetMB', label: '目标大小（MB）', type: 'number', def: '2', min: 0.01, max: 1024, step: 0.01,
        presets: [['1', '1 MB'], ['2', '2 MB'], ['5', '5 MB'], ['10', '10 MB']],
        showIf: (v) => v.preset === 'target' },
      { key: 'rasterDpi', label: '栅格化清晰度', type: 'chips', def: '150',
        options: [
          ['200', '200 DPI（清晰）'],
          ['150', '150 DPI（均衡推荐）'],
          ['110', '110 DPI（极小体积）'],
        ],
        showIf: (v) => v.preset === 'raster' },
    ],
    collect(v, ctx) {
      if (v.preset === 'target') {
        const mb = Number(v.targetMB);
        if (!Number.isFinite(mb) || mb < 0.01 || mb > 1024) throw new Error('请输入 0.01–1024 MB 的目标大小');
        return { input: ctx.file.path, targetBytes: Math.round(mb * 1_000_000) };
      }
      return {
        input: ctx.file.path,
        preset: v.preset || 'balanced',
        maxSide: v.maxSide ?? '1920',
        rasterDpi: v.rasterDpi || '150',
      };
    },
  },
  {
    id: 'pdfSearchable', group: '文档', icon: '🔍', name: '扫描件转可搜索 PDF',
    desc: '离线识别扫描页，添加可搜索和复制的文字，保留原页面外观',
    accept: ['pdf'],
    fields: [
      { key: 'ocrLang', label: '识别语言', type: 'chips', def: 'auto',
        options: [['auto', '中英混排'], ['zh', '简体中文优先'], ['en', '英文']] },
      { key: 'pageRange', label: '页码范围（留空处理全部页）', type: 'text', def: '', placeholder: '例如 1-3, 5' },
    ],
    collect(v, ctx) {
      return { input: ctx.file.path, ocrLang: v.ocrLang || 'auto', pageRange: String(v.pageRange || '').trim() };
    },
  },
  {
    id: 'pdfCrop', group: '文档', icon: '✂️', name: 'PDF 批量裁白边',
    desc: '自动检测扫描件和课件的页面白边，预览后批量裁剪，保留文字和矢量内容',
    accept: ['pdf'],
    fields: [
      { key: 'padding', label: '保留边距（pt）', type: 'number', def: '12', min: 0, max: 144, step: 1,
        presets: [['0', '贴紧内容'], ['12', '窄边距'], ['24', '宽边距']] },
      { key: 'pageRange', label: '页码范围（留空处理全部页）', type: 'text', def: '', placeholder: '例如 1-3, 5' },
      { type: 'pdfCropPreview', fullWidth: true },
    ],
    collect(v, ctx) {
      const padding = Number(v.padding ?? 12);
      if (v.padding === '' || !Number.isFinite(padding) || padding < 0 || padding > 144) {
        throw new Error('请输入 0–144 pt 的保留边距');
      }
      return { input: ctx.file.path, padding, pageRange: String(v.pageRange || '').trim() };
    },
  },
  {
    id: 'pdfRotate', group: '文档', icon: '🔁', name: 'PDF 页面旋转',
    desc: '无损旋转 PDF 全部页面或指定页码范围（顺时针 90° / 逆时针 90° / 180° 翻转），不损失清晰度',
    accept: ['pdf'],
    fields: [
      { key: 'direction', label: '旋转方向', type: 'chips', def: 'cw90', fullWidth: true,
        options: [
          ['cw90', '↻ 顺时针旋转 90°'],
          ['ccw90', '↺ 逆时针旋转 90°'],
          ['180', '🔁 旋转 180°'],
        ] },
      { key: 'pageRange', label: '作用页码（留空旋转全部页）', type: 'text', def: '',
        placeholder: '例如：1-3, 5（留空为全部页面）' },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        direction: v.direction || 'cw90',
        pageRange: String(v.pageRange || '').trim(),
      };
    },
  },
  {
    id: 'pdfWatermark', group: '文档', icon: '🏷️', name: 'PDF 水印与页码',
    desc: '离线为 PDF 批量叠加全屏斜向平铺/居中/角落文字水印（支持任意中文），或添加页脚/页眉页码',
    accept: ['pdf'],
    fields: [
      { key: 'contentMode', label: '添加内容', type: 'chips', def: 'watermark', fullWidth: true,
        options: [
          ['watermark', '🏷️ 添加文字水印'],
          ['pageNum', '📄 添加页码'],
          ['both', '✨ 水印 + 页码一起加'],
        ] },
      { key: 'wmText', label: '水印文字（支持任意中文）', type: 'text', def: '内部资料 · 严禁外传',
        placeholder: '如：仅供审核 · 请勿外传',
        showIf: (v) => v.contentMode !== 'pageNum' },
      { key: 'wmStyle', label: '水印布局', type: 'chips', def: 'tiled',
        options: [
          ['tiled', '全屏斜向平铺（防盗印推荐）'],
          ['center', '页面居中斜印'],
          ['br', '右下角标'],
          ['tr', '右上角标'],
        ],
        showIf: (v) => v.contentMode !== 'pageNum' },
      { key: 'wmColor', label: '水印颜色', type: 'color', def: '#64748b',
        presets: [['#64748b', '商务灰'], ['#dc2626', '警示红'], ['#2563eb', '品牌蓝'], ['#0f172a', '深黑']],
        showIf: (v) => v.contentMode !== 'pageNum' },
      { key: 'wmOpacity', label: '水印透明度', type: 'range', def: 0.28, min: 0.08, max: 0.85, step: 0.02, unit: '',
        presets: [['0.15', '淡印 0.15'], ['0.28', '适中 0.28'], ['0.5', '醒目 0.5']],
        showIf: (v) => v.contentMode !== 'pageNum' },
      { key: 'wmSize', label: '水印字号', type: 'chips', def: 'medium',
        options: [['small', '小号'], ['medium', '中号（推荐）'], ['large', '大号']],
        showIf: (v) => v.contentMode !== 'pageNum' },
      { key: 'numFormat', label: '页码格式', type: 'chips', def: 'slash',
        options: [
          ['slash', '1 / N'],
          ['zh', '第 1 / N 页'],
          ['dash', '- 1 -'],
        ],
        showIf: (v) => v.contentMode !== 'watermark' },
      { key: 'numPos', label: '页码位置', type: 'chips', def: 'bc',
        options: [['bc', '底部居中'], ['br', '底部靠右'], ['tc', '顶部居中']],
        showIf: (v) => v.contentMode !== 'watermark' },
      { key: 'numStart', label: '封面处理', type: 'chips', def: '1',
        options: [
          ['1', '从第 1 页开始编号'],
          ['2', '跳过第 1 页（第 2 页起标 1）'],
        ],
        showIf: (v) => v.contentMode !== 'watermark' },
      { key: 'pageRange', label: '作用页码范围（留空为全部页）', type: 'text', def: '',
        placeholder: '例如：2-10（留空为全部页面）' },
    ],
    collect(v, ctx) {
      const contentMode = v.contentMode || 'watermark';
      const wmText = String(v.wmText || '').trim();
      if (contentMode !== 'pageNum' && !wmText) {
        throw new Error('请输入要添加的水印文字');
      }
      return {
        input: ctx.file.path,
        contentMode,
        wmText,
        wmStyle: v.wmStyle || 'tiled',
        wmColor: v.wmColor || '#64748b',
        wmOpacity: v.wmOpacity ?? '0.28',
        wmSize: v.wmSize || 'medium',
        numFormat: v.numFormat || 'slash',
        numPos: v.numPos || 'bc',
        numStart: v.numStart || '1',
        pageRange: String(v.pageRange || '').trim(),
      };
    },
  },
  {
    id: 'imagesToPdf', group: '文档', icon: '📄', name: '多图合并为 PDF',
    desc: '将多张扫描件/截图/照片离线高清合成为单份 PDF 文档，支持 A4 竖向、A4 横向及按图片原始尺寸自适应页面，支持上下调整页面顺序',
    accept: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif'], multi: true,
    fields: [
      { key: 'pageSize', label: '页面纸张尺寸', type: 'chips', def: 'a4p',
        options: [
          ['a4p', 'A4 竖向（595×842 pt，推荐）'],
          ['a4l', 'A4 横向（842×595 pt）'],
          ['fit', '按每张图片原尺寸自适应'],
        ] },
      { key: 'margin', label: '页面留白边距', type: 'chips', def: '20',
        options: [
          ['0', '无边距 (0 pt)'],
          ['20', '标准边距 (20 pt)'],
          ['36', '宽边距 (36 pt)'],
        ] },
      { key: 'quality', label: '清晰度与体积', type: 'chips', def: 'high',
        options: [
          ['high', '高清原画'],
          ['medium', '均衡清晰（推荐）'],
          ['low', '轻量分享'],
        ] },
      { key: 'bgColor', label: '透明图垫底背景色', type: 'color', def: '#ffffff',
        presets: [['#ffffff', '纯白'], ['#000000', '纯黑']] },
    ],
    collect(v, ctx) {
      return {
        files: ctx.files.map((f) => f.path),
        pageSize: v.pageSize || 'a4p',
        margin: v.margin ?? '20',
        quality: v.quality || 'high',
        bgColor: v.bgColor || '#ffffff',
      };
    },
  },
  {
    id: 'pdfToImages', group: '文档', icon: '🖼️', name: 'PDF 转图片 / 长图',
    desc: '将 PDF 文档离线高清渲染为逐页独立图片或一键拼接为纵向阅读长图，支持自定义页码范围',
    accept: ['pdf'],
    fields: [
      { key: 'mode', label: '导出方式', type: 'chips', def: 'pages',
        options: [
          ['pages', '📂 逐页导出图片文件夹（推荐）'],
          ['longImage', '📜 拼接为单张纵向长图'],
        ] },
      { key: 'format', label: '图片格式', type: 'chips', def: 'png',
        options: [
          ['png', 'PNG（文字最锐利，推荐）'],
          ['jpg', 'JPG（体积小）'],
          ['webp', 'WebP（高清轻量）'],
        ] },
      { key: 'dpiScale', label: '渲染清晰度', type: 'chips', def: '2',
        options: [
          ['1.5', '1.5× 标准 (150 DPI)'],
          ['2', '2× 高清 (200 DPI，推荐)'],
          ['3', '3× 超清印刷 (300 DPI)'],
        ] },
      { key: 'pageRange', label: '页码范围（留空导出全部页）', type: 'text', def: '',
        placeholder: '例如：1-3, 5, 8-10（留空为全部页面）' },
    ],
    collect(v, ctx) {
      return {
        input: ctx.file.path,
        mode: v.mode || 'pages',
        format: v.format || 'png',
        dpiScale: v.dpiScale || '2',
        pageRange: String(v.pageRange || '').trim(),
      };
    },
  },
  {
    id: 'pdfMerge', group: '文档', icon: '📚', name: 'PDF 页面整理 / 合并',
    desc: '用页面缩略图拖拽重排、旋转或删页，也可把多份 PDF 整理成一份',
    accept: ['pdf'], multi: true,
    fields: [],
    collect(_v, ctx) {
      if (Array.isArray(ctx.pdfPages)) {
        if (!ctx.pdfPages.length) throw new Error('请至少保留一页 PDF');
        return { files: ctx.files.map((f) => f.path), pages: ctx.pdfPages };
      }
      if (!ctx.files || ctx.files.length < 2) {
        throw new Error('请至少选择 2 份 PDF 文件进行合并');
      }
      return { files: ctx.files.map((f) => f.path) };
    },
  },
  {
    id: 'pdfSplit', group: '文档', icon: '✂️', name: 'PDF 拆分 / 重排',
    desc: '按输入顺序提取或重排页面、删除指定页，或按固定页数拆分为多份 PDF',
    accept: ['pdf'],
    fields: [
      { key: 'mode', label: '拆分模式', type: 'chips', def: 'extract', fullWidth: true,
        options: [
          ['extract', '提取 / 重排页面'],
          ['remove', '🗑️ 删除指定页并保留其余页'],
          ['burst', '📂 按固定页数拆分为多个 PDF'],
        ] },
      { key: 'pageRange', label: '页码范围', type: 'text', def: '1',
        placeholder: '例如 3, 1-2，按 3 → 1 → 2 输出',
        showIf: (v) => v.mode !== 'burst' },
      { key: 'everyN', label: '每几页拆成一份 PDF', type: 'number', def: '1', min: 1, max: 500, step: 1,
        presets: [['1', '每 1 页一份'], ['2', '每 2 页一份'], ['5', '每 5 页一份'], ['10', '每 10 页一份']],
        showIf: (v) => v.mode === 'burst' },
    ],
    collect(v, ctx) {
      const mode = v.mode || 'extract';
      const pageRange = String(v.pageRange || '').trim();
      if (mode !== 'burst' && !pageRange) {
        throw new Error('请输入要处理的页码范围（例如：1-3, 5）');
      }
      return {
        input: ctx.file.path,
        mode,
        pageRange,
        everyN: v.everyN || '1',
      };
    },
  },
];
})();
