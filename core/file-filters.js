'use strict';

const VIDEO_EXT = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'ts', 'm4v'];

const ALL_MEDIA_EXT = [...VIDEO_EXT, 'gif'];
const ALL_VISUAL_EXT = [...ALL_MEDIA_EXT, 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif'];
const AUDIO_EXT = ['mp3', 'm4a', 'wav', 'flac'];
const IMG_EXT = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif'];
const SVG_EXT = ['svg'];
const DOC_EXT = ['docx', 'pptx', 'md', 'markdown'];

// 各功能对应的文件选择过滤器（multi: 是否允许多选）
const FILE_FILTERS = {
  videoToGif: { exts: VIDEO_EXT },
  gifToVideo: { exts: ['gif'] },
  toWebp: { exts: ALL_MEDIA_EXT },
  convertVideo: { exts: VIDEO_EXT },
  compressGif: { exts: ['gif'] },
  trimGif: { exts: ['gif'] },
  gifText: { exts: ['gif'] },
  compressTarget: { exts: ALL_MEDIA_EXT },
  chromaGif: { exts: ALL_MEDIA_EXT },
  decorateMedia: { exts: ALL_MEDIA_EXT },
  // 图片专属模块
  imageConvert: { exts: IMG_EXT },
  imageCompressTarget: { exts: IMG_EXT },
  imageStitch: { exts: IMG_EXT, multi: true },
  imageSplit: { exts: IMG_EXT },
  imageCutout: { exts: IMG_EXT },
  imageReplaceBg: { exts: IMG_EXT },
  imageFrame: { exts: IMG_EXT },
  // SVG 矢量模块
  svgToRaster: { exts: SVG_EXT },
  svgOptimize: { exts: SVG_EXT },
  imageToSvg: { exts: IMG_EXT },
  // 文档模块
  docCompressImages: { exts: ['docx', 'pptx'] },
  docExtractImages: { exts: DOC_EXT },
  docRepackImages: { exts: ['docx', 'pptx'] },
  docCleanupMedia: { exts: ['docx', 'pptx'] },
  docStyleImages: { exts: ['docx', 'pptx'] },
  mdOrganizeImages: { exts: ['md', 'markdown'] },
  imagesToPdf: { exts: IMG_EXT, multi: true },
  // 剪辑 / 工具（兼容静态图片）
  trimVideo: { exts: VIDEO_EXT },
  multiCut: { exts: VIDEO_EXT },
  splitVideo: { exts: VIDEO_EXT },
  mergeVideos: { exts: VIDEO_EXT, multi: true },
  videoCrop: { exts: ALL_VISUAL_EXT },
  autoCrop: { exts: ALL_MEDIA_EXT },
  videoBlur: { exts: ALL_VISUAL_EXT },
  aspectPad: { exts: ALL_VISUAL_EXT },
  pipSplit: { exts: ALL_MEDIA_EXT },
  colorStab: { exts: ALL_VISUAL_EXT },
  videoFilter: { exts: ALL_VISUAL_EXT },
  videoFade: { exts: ALL_MEDIA_EXT },
  videoText: { exts: ALL_VISUAL_EXT },
  watermark: { exts: ALL_VISUAL_EXT },
  subtitleTool: { exts: VIDEO_EXT },
  rotateFlip: { exts: ALL_VISUAL_EXT },
  reverse: { exts: ALL_MEDIA_EXT },
  changeSpeed: { exts: ALL_MEDIA_EXT },
  extractAudio: { exts: [...VIDEO_EXT, ...AUDIO_EXT] },
  audioAdjust: { exts: VIDEO_EXT },
  addMusic: { exts: VIDEO_EXT },
  snapshot: { exts: ALL_MEDIA_EXT },
  contactSheet: { exts: VIDEO_EXT },
  stripMeta: { exts: [...ALL_MEDIA_EXT, ...AUDIO_EXT, ...IMG_EXT] },
  imagesTo: { exts: IMG_EXT, multi: true },
  // 第二文件（背景音乐 / 水印图片 / 分屏副视频 / 外挂字幕 / 替换图片）
  audioFile: { exts: ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg'] },
  imageFile: { exts: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif'] },
  replaceImageFiles: { exts: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif', 'gif', 'tif', 'tiff'], multi: true },
  videoGifFile: { exts: ALL_MEDIA_EXT },
  subFile: { exts: ['srt', 'ass', 'ssa', 'vtt'] },
  anyMedia: { exts: [...VIDEO_EXT, 'gif', ...IMG_EXT, ...SVG_EXT, ...AUDIO_EXT, 'srt', 'ass', 'ssa', 'vtt', ...DOC_EXT], multi: true },
  anyMediaSingle: { exts: [...VIDEO_EXT, 'gif', ...IMG_EXT, ...SVG_EXT, ...AUDIO_EXT, 'srt', 'ass', 'ssa', 'vtt', ...DOC_EXT] },
};

const SINGLE_ONLY = new Set([
  'videoCrop',
  'videoBlur',
  'multiCut',
  'audioFile',
  'imageFile',
  'videoGifFile',
  'subFile',
  'anyMediaSingle',
]);

module.exports = {
  VIDEO_EXT,
  ALL_MEDIA_EXT,
  ALL_VISUAL_EXT,
  AUDIO_EXT,
  IMG_EXT,
  SVG_EXT,
  DOC_EXT,
  FILE_FILTERS,
  SINGLE_ONLY,
};
