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
];
})();
