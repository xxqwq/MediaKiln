((root, factory) => {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VGT = root.VGT || {};
    root.VGT.wfRegistry = factory(root.VGT);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'ts', 'm4v'];
  const IMG_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif'];
  const RASTER_OUT_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif', 'ico'];
  const SVG_EXTS = ['svg'];
  const AUDIO_EXTS = ['mp3', 'm4a', 'wav', 'flac', 'aac', 'ogg', 'opus'];
  const SUB_EXTS = ['srt', 'ass', 'ssa', 'vtt'];
  const HTML_EXTS = ['html', 'htm'];
  const DOC_EXTS = ['docx', 'doc', 'pptx', 'md', 'markdown', ...HTML_EXTS];
  const OOXML_EXTS = ['docx', 'pptx'];
  const PDF_EXTS = ['pdf'];
  const ALL_SUPPORTED_EXTS = Array.from(new Set([
    ...VIDEO_EXTS, 'gif', 'apng', ...RASTER_OUT_EXTS, ...SVG_EXTS, ...AUDIO_EXTS, ...SUB_EXTS, ...DOC_EXTS, ...PDF_EXTS,
  ]));

  const PORT_TYPES = {
    video:    { id: 'video',    label: '视频',     color: '#818cf8', exts: VIDEO_EXTS },
    gif:      { id: 'gif',      label: 'GIF',      color: '#f472b6', exts: ['gif'] },
    image:    { id: 'image',    label: '图片',     color: '#34d399', exts: RASTER_OUT_EXTS },
    svg:      { id: 'svg',      label: 'SVG',      color: '#fbbf24', exts: SVG_EXTS },
    audio:    { id: 'audio',    label: '音频',     color: '#22d3ee', exts: AUDIO_EXTS },
    subtitle: { id: 'subtitle', label: '字幕',     color: '#a78bfa', exts: SUB_EXTS },
    doc:      { id: 'doc',      label: '文档',     color: '#60a5fa', exts: DOC_EXTS },
    pdf:      { id: 'pdf',      label: 'PDF',      color: '#f87171', exts: PDF_EXTS },
    anim:     { id: 'anim',     label: '视频/动图', color: '#e879f9', exts: [...VIDEO_EXTS, 'gif', 'apng'] },
    visual:   { id: 'visual',   label: '视觉媒体', color: '#38bdf8', exts: [...VIDEO_EXTS, 'gif', 'apng', ...IMG_EXTS] },
    any:      { id: 'any',      label: '任意媒体', color: '#94a3b8', exts: ['*'] },
  };

  const GROUP_META = {
    '输入 / 输出': { color: '#22d3ee', icon: '📥' },
    '转换':       { color: '#818cf8', icon: '🔄' },
    'GIF 编辑':   { color: '#f472b6', icon: '✨' },
    '图片':       { color: '#34d399', icon: '🖼️' },
    'SVG':        { color: '#fbbf24', icon: '✒️' },
    '文档':       { color: '#60a5fa', icon: '📑' },
    '剪辑':       { color: '#a78bfa', icon: '✂️' },
    '音频':       { color: '#2dd4bf', icon: '🎵' },
    '工具':       { color: '#fb923c', icon: '🛠️' },
  };

  const GROUP_ORDER = ['输入 / 输出', '转换', 'GIF 编辑', '图片', 'SVG', '文档', '剪辑', '音频', '工具'];

  function extOf(filePath) {
    const m = String(filePath || '').match(/\.([^.\\/]+)$/);
    return m ? m[1].toLowerCase() : '';
  }

  function hasIntersection(extsA, extsB) {
    if (!extsA?.length || !extsB?.length) return false;
    if (extsA.includes('*') || extsB.includes('*')) return true;
    const setB = new Set(extsB.map((e) => (e === 'jpeg' ? 'jpg' : e)));
    return extsA.some((e) => setB.has(e === 'jpeg' ? 'jpg' : e));
  }

  function inferPortTypeId(exts) {
    if (!exts || !exts.length || exts.includes('*')) return 'any';
    const norm = Array.from(new Set(exts.map((e) => (e === 'jpeg' ? 'jpg' : e.toLowerCase()))));
    if (norm.every((e) => e === 'gif')) return 'gif';
    if (norm.every((e) => e === 'svg')) return 'svg';
    if (norm.every((e) => e === 'pdf')) return 'pdf';
    if (norm.every((e) => AUDIO_EXTS.includes(e))) return 'audio';
    if (norm.every((e) => SUB_EXTS.includes(e))) return 'subtitle';
    if (norm.every((e) => DOC_EXTS.includes(e))) return 'doc';
    if (norm.every((e) => RASTER_OUT_EXTS.includes(e))) return 'image';
    if (norm.every((e) => VIDEO_EXTS.includes(e))) return 'video';
    if (norm.every((e) => VIDEO_EXTS.includes(e) || e === 'gif' || e === 'apng')) return 'anim';
    if (norm.every((e) => VIDEO_EXTS.includes(e) || e === 'gif' || e === 'apng' || RASTER_OUT_EXTS.includes(e))) return 'visual';
    return 'any';
  }

  function resolveBgColor(v, fallback = '#ffffff') {
    if (v.bgMode === 'transparent') return 'transparent';
    if (v.bgMode === 'black') return '#000000';
    if (v.bgMode === 'white') return '#ffffff';
    if (v.bgMode === 'dark') return '#0f1115';
    if (v.bgMode === 'custom') return v.bgCustom || fallback;
    return fallback;
  }

  // 根据功能接受格式推断主输入端口类型
  function buildFeatureInputs(feature) {
    const id = feature.id;
    const primaryExts = feature.accept.slice();
    const primaryTypeId = inferPortTypeId(primaryExts);

    const inputs = [{
      id: feature.multi ? 'files' : 'input',
      label: feature.multi ? '多个文件' : '主输入',
      typeId: primaryTypeId,
      accept: primaryExts,
      multiConnect: !!feature.multi,
      required: true,
    }];

    if (id === 'pipSplit') {
      inputs.push({
        id: 'second',
        label: '副画面',
        typeId: 'anim',
        accept: [...VIDEO_EXTS, 'gif'],
        multiConnect: false,
        required: false, // 允许节点内回退选文件
      });
    } else if (id === 'addMusic') {
      inputs.push({
        id: 'music',
        label: '背景音乐',
        typeId: 'audio',
        accept: AUDIO_EXTS,
        multiConnect: false,
        required: false,
      });
    } else if (id === 'watermark') {
      inputs.push({
        id: 'image',
        label: '水印图(可选)',
        typeId: 'image',
        accept: ['png', 'jpg', 'jpeg', 'webp', 'bmp'],
        multiConnect: false,
        required: false,
      });
    } else if (id === 'imageReplaceBg') {
      inputs.push({
        id: 'bgImage',
        label: '背景图(可选)',
        typeId: 'image',
        accept: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif'],
        multiConnect: false,
        required: false,
      });
    } else if (id === 'subtitleTool') {
      inputs.push({
        id: 'subtitle',
        label: '字幕文件',
        typeId: 'subtitle',
        accept: SUB_EXTS,
        multiConnect: false,
        required: false,
      });
    } else if (id === 'videoCover') {
      inputs.push({
        id: 'coverImage',
        label: '封面图(可选)',
        typeId: 'image',
        accept: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif'],
        multiConnect: false,
        required: false,
      });
    } else if (id === 'docRepackImages') {
      inputs.push({
        id: 'replaceSource',
        label: '替换图片',
        typeId: 'image',
        accept: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif', 'gif', 'tif', 'tiff'],
        multiConnect: true,
        required: false,
      });
    }
    return inputs;
  }

  // 静态默认输出端口（动态变化见 getDynamicOutputSpec）
  function buildFeatureOutputs(feature) {
    const spec = getFeatureStaticOutputMeta(feature.id);
    return [{
      id: 'out',
      label: spec.isList ? '文件列表' : '输出',
      typeId: inferPortTypeId(spec.exts),
      exts: spec.exts,
      isList: spec.isList,
    }];
  }

  function getFeatureStaticOutputMeta(id) {
    switch (id) {
      case 'videoToGif':
      case 'compressGif':
      case 'trimGif':
      case 'gifText':
      case 'chromaGif':
        return { exts: ['gif'], isList: false };
      case 'animSprite':
        return { exts: ['apng', 'gif', 'png'], isList: false };
      case 'gifToVideo':
        return { exts: ['mp4', 'webm'], isList: false };
      case 'toWebp':
        return { exts: ['webp'], isList: false };
      case 'convertVideo':
        return { exts: ['mp4', 'mkv', 'mov', 'webm'], isList: false };
      case 'compressTarget':
        return { exts: ['mp4', 'gif'], isList: false };
      case 'decorateMedia':
        return { exts: [...VIDEO_EXTS, 'gif'], isList: false };
      case 'imageConvert':
        return { exts: ['webp', 'jpg', 'png', 'avif', 'ico', 'bmp'], isList: false };
      case 'imageCompressTarget':
        return { exts: ['jpg', 'webp', 'png'], isList: false };
      case 'imageStitch':
        return { exts: ['jpg', 'png', 'webp'], isList: false };
      case 'imageSplit':
        return { exts: ['png', 'jpg', 'webp'], isList: true };
      case 'imageCutout':
        return { exts: ['png', 'webp'], isList: false };
      case 'imageReplaceBg':
        return { exts: ['png', 'jpg', 'webp'], isList: false };
      case 'imageFrame':
        return { exts: ['png', 'webp', 'jpg'], isList: false };
      case 'imageCanvas':
        return { exts: ['jpg', 'png', 'webp'], isList: false };
      case 'svgToRaster':
        return { exts: ['png', 'webp', 'jpg', 'ico', 'avif', 'bmp'], isList: false };
      case 'svgOptimize':
      case 'imageToSvg':
        return { exts: ['svg'], isList: false };
      case 'docCompressImages':
      case 'docRepackImages':
      case 'docCleanupMedia':
      case 'docStyleImages':
        return { exts: ['docx', 'pptx'], isList: false };
      case 'mdOrganizeImages':
        return { exts: ['md', 'markdown'], isList: false };
      case 'docToPdf':
      case 'wordToPdf':
      case 'pdfCompress':
      case 'pdfSearchable':
      case 'pdfCrop':
      case 'pdfRotate':
      case 'pdfWatermark':
      case 'imagesToPdf':
      case 'pdfMerge':
      case 'pdfSplit':
        return { exts: ['pdf'], isList: false };
      case 'pdfToWord':
        return { exts: ['docx'], isList: false };
      case 'pdfToImages':
        return { exts: ['png', 'jpg', 'webp'], isList: true };
      case 'docExtractImages':
        return { exts: [...IMG_EXTS, 'gif', 'svg', ...VIDEO_EXTS, ...AUDIO_EXTS], isList: true };
      case 'removeSilence':
        return { exts: [...VIDEO_EXTS, ...AUDIO_EXTS], isList: false };
      case 'trimVideo':
      case 'multiCut':
      case 'mergeVideos':
      case 'subtitleTool':
      case 'audioAdjust':
        return { exts: [...VIDEO_EXTS, 'srt'], isList: false };
      case 'videoText':
        return { exts: VIDEO_EXTS, isList: false };
      case 'splitVideo':
        return { exts: ['mp4', 'mkv', 'mov', 'webm'], isList: true };
      case 'pipSplit':
      case 'addMusic':
        return { exts: ['mp4'], isList: false };
      case 'videoCover':
        return { exts: ['mp4', 'm4v'], isList: false };
      case 'videoCrop':
      case 'videoBlur':
      case 'aspectPad':
      case 'colorStab':
      case 'videoFilter':
      case 'rotateFlip':
      case 'watermark':
        return { exts: [...VIDEO_EXTS, 'gif', ...IMG_EXTS], isList: false };
      case 'autoCrop':
      case 'videoFade':
      case 'reverse':
      case 'changeSpeed':
        return { exts: [...VIDEO_EXTS, 'gif'], isList: false };
      case 'extractAudio':
      case 'audioConvert':
      case 'audioMerge':
        return { exts: ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus'], isList: false };
      case 'audioTrim':
        return { exts: AUDIO_EXTS, isList: false };
      case 'snapshot':
        return { exts: ['png', 'jpg'], isList: false };
      case 'contactSheet':
        return { exts: ['jpg', 'png'], isList: false };
      case 'stripMeta':
        return { exts: [...VIDEO_EXTS, 'gif', ...AUDIO_EXTS, ...IMG_EXTS], isList: false };
      case 'imagesTo':
        return { exts: ['gif', 'mp4'], isList: false };
      default:
        return { exts: ['*'], isList: false };
    }
  }

  // 根据节点当前参数与上游输入动态计算输出端口格式
  function getDynamicOutputSpec(node, upstreamExts = null, upstreamIsList = false, portId = null) {
    const p = node.params || {};
    if (node.type === 'io.loadFile') {
      const pathStr = p.filePath || '';
      if (pathStr) {
        const e = extOf(pathStr);
        const exts = e ? [e === 'jpeg' ? 'jpg' : e] : ['*'];
        return { exts, typeId: inferPortTypeId(exts), isList: false };
      }
      return { exts: ['*'], typeId: 'any', isList: false };
    }
    if (node.type === 'io.loadBatch') {
      const paths = Array.isArray(p.filePaths) ? p.filePaths : [];
      if (paths.length) {
        const exts = Array.from(new Set(paths.map(extOf).filter(Boolean).map((e) => (e === 'jpeg' ? 'jpg' : e))));
        if (exts.length) return { exts, typeId: inferPortTypeId(exts), isList: true };
      }
      const filterMap = {
        all: ['*'],
        video: VIDEO_EXTS,
        image: IMG_EXTS,
        gif: ['gif'],
        svg: SVG_EXTS,
        audio: AUDIO_EXTS,
        doc: DOC_EXTS,
        pdf: PDF_EXTS,
      };
      const exts = filterMap[p.filterKind || 'all'] || ['*'];
      return { exts, typeId: inferPortTypeId(exts), isList: true };
    }
    if (node.type === 'io.loadFolder') {
      const filterMap = {
        all: ALL_SUPPORTED_EXTS,
        videoAnim: [...VIDEO_EXTS, 'gif', 'apng'],
        image: RASTER_OUT_EXTS,
        gif: ['gif'],
        svg: SVG_EXTS,
        audio: AUDIO_EXTS,
        doc: DOC_EXTS,
        pdf: PDF_EXTS,
      };
      const exts = filterMap[p.filterKind || 'all'] || ALL_SUPPORTED_EXTS;
      return { exts, typeId: inferPortTypeId(exts), isList: true };
    }
    if (node.type === 'io.listPick') {
      const mode = p.pickMode || 'first';
      const isSingle = mode === 'first' || mode === 'last' || mode === 'index';
      let exts = upstreamExts && upstreamExts.length ? upstreamExts : ['*'];
      if (mode === 'rasterOnly') exts = IMG_EXTS;
      else if (mode === 'svgOnly') exts = SVG_EXTS;
      else if (mode === 'videoOnly') exts = VIDEO_EXTS;
      else if (mode === 'pdfOnly') exts = PDF_EXTS;
      return { exts, typeId: inferPortTypeId(exts), isList: !isSingle };
    }
    if (node.type === 'io.routeType') {
      const gifToImg = p.gifBucket === 'images';
      const imgExts = gifToImg ? [...RASTER_OUT_EXTS, 'gif'] : RASTER_OUT_EXTS;
      const animExts = gifToImg ? [...VIDEO_EXTS, 'apng'] : [...VIDEO_EXTS, 'gif', 'apng'];
      if (portId === 'images') return { exts: imgExts, typeId: 'image', isList: true };
      if (portId === 'svgs') return { exts: SVG_EXTS, typeId: 'svg', isList: true };
      if (portId === 'anims') return { exts: animExts, typeId: 'anim', isList: true };
      if (portId === 'others') return { exts: [...AUDIO_EXTS, ...SUB_EXTS, ...DOC_EXTS, ...PDF_EXTS], typeId: 'any', isList: true };
      return null;
    }
    if (node.type === 'io.routeCondition') {
      const exts = upstreamExts && upstreamExts.length ? upstreamExts : ['*'];
      return { exts, typeId: inferPortTypeId(exts), isList: upstreamIsList };
    }
    if (node.type === 'io.preview') {
      const exts = upstreamExts && upstreamExts.length ? upstreamExts : ['*'];
      return { exts, typeId: inferPortTypeId(exts), isList: upstreamIsList };
    }
    if (node.type === 'io.compare' || node.type === 'io.save') {
      return null;
    }

    const fid = node.type.startsWith('feat.') ? node.type.slice(5) : node.type;
    if (node.bypass && upstreamExts?.length) {
      return { exts: upstreamExts, typeId: inferPortTypeId(upstreamExts), isList: upstreamIsList };
    }

    const passthroughFromUpstream = (allowedExts, forceList = null) => {
      let exts = allowedExts;
      if (upstreamExts?.length && !upstreamExts.includes('*')) {
        const matched = upstreamExts.filter((e) => allowedExts.includes(e === 'jpeg' ? 'jpg' : e));
        if (matched.length) exts = matched;
      }
      return {
        exts,
        typeId: inferPortTypeId(exts),
        isList: forceList !== null ? forceList : upstreamIsList,
      };
    };

    switch (fid) {
      case 'videoToGif':
      case 'compressGif':
      case 'trimGif':
      case 'gifText':
      case 'chromaGif':
        return { exts: ['gif'], typeId: 'gif', isList: upstreamIsList };
      case 'animSprite': {
        const mode = p.mode || 'toApng';
        if (mode === 'toApng') return { exts: ['apng'], typeId: 'anim', isList: upstreamIsList };
        if (mode === 'apngToGif') return { exts: ['gif'], typeId: 'gif', isList: upstreamIsList };
        if (mode === 'toSprite') return { exts: ['png'], typeId: 'image', isList: upstreamIsList };
        const outFmt = p.outFormat === 'apng' ? 'apng' : 'gif';
        return { exts: [outFmt], typeId: outFmt === 'apng' ? 'anim' : 'gif', isList: upstreamIsList };
      }
      case 'gifToVideo': {
        const fmt = p.format === 'webm' ? 'webm' : 'mp4';
        return { exts: [fmt], typeId: 'video', isList: upstreamIsList };
      }
      case 'toWebp':
        return { exts: ['webp'], typeId: 'image', isList: upstreamIsList };
      case 'convertVideo': {
        const fmt = p.format || 'mp4';
        return { exts: [fmt], typeId: 'video', isList: upstreamIsList };
      }
      case 'compressTarget':
        return passthroughFromUpstream(['mp4', 'gif']);
      case 'decorateMedia':
        return passthroughFromUpstream([...VIDEO_EXTS, 'gif']);
      case 'imageConvert': {
        const fmt = p.format || 'webp';
        return { exts: [fmt], typeId: 'image', isList: upstreamIsList };
      }
      case 'imageCompressTarget': {
        const fmt = p.format && p.format !== 'auto' ? [p.format] : ['jpg', 'webp', 'png'];
        return { exts: fmt, typeId: 'image', isList: upstreamIsList };
      }
      case 'imageStitch': {
        const fmt = p.format || 'jpg';
        return { exts: [fmt], typeId: 'image', isList: false };
      }
      case 'imageSplit': {
        const fmt = p.format || 'png';
        return { exts: [fmt], typeId: 'image', isList: true };
      }
      case 'imageCutout': {
        const fmt = p.format || 'png';
        return { exts: [fmt], typeId: 'image', isList: upstreamIsList };
      }
      case 'imageReplaceBg': {
        const fmt = p.format || 'png';
        return { exts: [fmt], typeId: 'image', isList: upstreamIsList };
      }
      case 'imageFrame': {
        const fmt = p.format || 'png';
        return { exts: [fmt], typeId: 'image', isList: upstreamIsList };
      }
      case 'imageCanvas': {
        const fmt = p.format || 'jpg';
        return { exts: [fmt], typeId: 'image', isList: upstreamIsList };
      }
      case 'svgToRaster': {
        const fmt = p.format || 'png';
        return { exts: [fmt], typeId: 'image', isList: upstreamIsList };
      }
      case 'svgOptimize':
      case 'imageToSvg':
        return { exts: ['svg'], typeId: 'svg', isList: upstreamIsList };
      case 'docCompressImages':
      case 'docRepackImages':
      case 'docCleanupMedia':
      case 'docStyleImages':
        return passthroughFromUpstream(OOXML_EXTS);
      case 'mdOrganizeImages':
        return passthroughFromUpstream(['md', 'markdown']);
      case 'docToPdf':
      case 'wordToPdf':
      case 'pdfCompress':
      case 'pdfSearchable':
      case 'pdfCrop':
      case 'pdfRotate':
      case 'pdfWatermark':
        return { exts: ['pdf'], typeId: 'pdf', isList: upstreamIsList };
      case 'pdfToWord':
        return { exts: ['docx'], typeId: 'doc', isList: upstreamIsList };
      case 'imagesToPdf':
      case 'pdfMerge':
        return { exts: ['pdf'], typeId: 'pdf', isList: false };
      case 'pdfToImages': {
        const fmt = p.format || 'png';
        return { exts: [fmt], typeId: 'image', isList: (p.mode || 'pages') === 'pages' ? true : upstreamIsList };
      }
      case 'pdfSplit':
        return { exts: ['pdf'], typeId: 'pdf', isList: p.mode === 'burst' ? true : upstreamIsList };
      case 'docExtractImages': {
        const exts = p.includeSvg === 'no' ? [...IMG_EXTS, 'gif'] : [...IMG_EXTS, 'gif', 'svg'];
        return { exts, typeId: inferPortTypeId(exts), isList: true };
      }
      case 'removeSilence':
        return passthroughFromUpstream([...VIDEO_EXTS, ...AUDIO_EXTS]);
      case 'trimVideo':
      case 'multiCut':
      case 'videoText':
      case 'audioAdjust':
        return passthroughFromUpstream(VIDEO_EXTS);
      case 'splitVideo':
        return passthroughFromUpstream(VIDEO_EXTS, true);
      case 'mergeVideos':
        return { exts: (p.mode === 'compat' || p.mode === 'xfade') ? ['mp4'] : VIDEO_EXTS, typeId: 'video', isList: false };
      case 'pipSplit':
      case 'addMusic':
        return { exts: ['mp4'], typeId: 'video', isList: upstreamIsList };
      case 'videoCover':
        return passthroughFromUpstream(['mp4', 'm4v']);
      case 'subtitleTool':
        if (p.mode === 'extract') return { exts: ['srt'], typeId: 'subtitle', isList: upstreamIsList };
        return passthroughFromUpstream(VIDEO_EXTS);
      case 'videoCrop':
      case 'videoBlur':
      case 'aspectPad':
      case 'colorStab':
      case 'videoFilter':
      case 'rotateFlip':
      case 'watermark':
        return passthroughFromUpstream([...VIDEO_EXTS, 'gif', ...IMG_EXTS]);
      case 'autoCrop':
      case 'videoFade':
      case 'reverse':
      case 'changeSpeed':
        return passthroughFromUpstream([...VIDEO_EXTS, 'gif']);
      case 'extractAudio':
      case 'audioConvert': {
        const fmt = p.format || 'mp3';
        return { exts: [fmt], typeId: 'audio', isList: upstreamIsList };
      }
      case 'audioTrim':
        return passthroughFromUpstream(AUDIO_EXTS);
      case 'audioMerge': {
        const fmt = p.format || 'mp3';
        return { exts: [fmt], typeId: 'audio', isList: false };
      }
      case 'snapshot': {
        if ((p.mode || 'single') === 'single') {
          const fmt = p.format === 'jpg' ? 'jpg' : 'png';
          return { exts: [fmt], typeId: 'image', isList: upstreamIsList };
        }
        return { exts: ['png'], typeId: 'image', isList: true };
      }
      case 'contactSheet': {
        const fmt = p.format === 'png' ? 'png' : 'jpg';
        return { exts: [fmt], typeId: 'image', isList: upstreamIsList };
      }
      case 'stripMeta':
        return passthroughFromUpstream([...VIDEO_EXTS, 'gif', ...AUDIO_EXTS, ...IMG_EXTS]);
      case 'imagesTo': {
        const fmt = p.format === 'mp4' ? 'mp4' : 'gif';
        return { exts: [fmt], typeId: fmt === 'gif' ? 'gif' : 'video', isList: false };
      }
      default:
        return { exts: ['*'], typeId: 'any', isList: upstreamIsList };
    }
  }

  // 为所有功能生成工作流节点可用的初始参数（避开模块空参抛错）
  function buildDefaultParams(feature) {
    const defaults = {};
    for (const field of feature.fields || []) {
      if (field.type === 'times') {
        defaults.tStart = 0;
        defaults.tEnd = 0; // 0 代表自动取完整时长（由 buildNodeTaskParams 处理）
      } else if (field.type === 'multiSegments') {
        defaults.segments = [{ start: 0, end: 5 }];
      } else if (field.type === 'cropCanvas') {
        defaults.crop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
      } else if (field.type === 'secondFile' || field.type === 'replaceSource') {
        defaults[`__local_${field.key || 'second'}`] = '';
      } else if (field.type === 'docSections') {
        defaults.sectionKeyword = '';
      } else if (field.key) {
        defaults[field.key] = field.def ?? '';
      }
    }
    // 防止默认空值执行失败
    if (feature.id === 'gifText' && !defaults.text) defaults.text = '工作流字幕';
    if (feature.id === 'videoText' && !defaults.text) defaults.text = '精彩片段标题';
    if (feature.id === 'watermark' && !defaults.text) defaults.text = 'Watermark';
    if (feature.id === 'colorStab') defaults.contrast = '1.1';
    if (feature.id === 'convertVideo' && !defaults.vcodec) defaults.vcodec = 'h264';
    if (feature.id === 'compressTarget' && !defaults.vcodec) defaults.vcodec = 'h264';
    if (feature.id === 'removeSilence') {
      if (defaults.threshold === undefined) defaults.threshold = '-35';
      if (defaults.minSilence === undefined) defaults.minSilence = '0.4';
      if (defaults.padding === undefined) defaults.padding = '0.12';
    }
    if (feature.id === 'pdfToImages') {
      if (defaults.mode === undefined) defaults.mode = 'pages';
      if (defaults.format === undefined) defaults.format = 'png';
      if (defaults.dpiScale === undefined) defaults.dpiScale = '2';
      if (defaults.pageRange === undefined) defaults.pageRange = '';
    }
    if (feature.id === 'pdfSplit') {
      if (defaults.mode === undefined) defaults.mode = 'extract';
      if (defaults.pageRange === undefined) defaults.pageRange = '1';
      if (defaults.everyN === undefined) defaults.everyN = '1';
    }
    if (feature.id === 'pdfWatermark' && !defaults.wmText) {
      defaults.wmText = '内部资料 · 严禁外传';
    }
    return defaults;
  }

  // 适配部分功能在工作流节点卡片内增加自定义参数或默认提示
  function adaptFeatureFields(feature) {
    const fields = [];
    for (const f of feature.fields || []) {
      if (f.type === 'pdfCropPreview') {
        continue;
      } else if (f.type === 'secondFile') {
        fields.push({
          ...f,
          label: `${f.label}（未连线时本地回退）`,
        });
      } else if (f.type === 'replaceSource') {
        fields.push({
          ...f,
          label: `${f.label}（建议直接连线上游，或手动选文件夹）`,
        });
      } else if (f.type === 'docSections') {
        fields.push({
          key: 'sectionKeyword',
          label: `指定章节（关键词，留空${f.actionWord || '处理'}全部）`,
          type: 'text',
          def: '',
          placeholder: '如：第3章、实验结果（支持逗号分隔）',
        });
      } else {
        fields.push({ ...f });
      }
    }
    if (feature.id === 'convertVideo' && !fields.some((f) => f.key === 'vcodec')) {
      fields.push({
        key: 'vcodec',
        label: '视频编码',
        type: 'chips',
        def: 'h264',
        options: [['h264', 'H.264'], ['hevc', 'HEVC'], ['av1', 'AV1']],
        showIf: (v) => v.mode !== 'copy',
      });
    }
    if (feature.id === 'compressTarget' && !fields.some((f) => f.key === 'vcodec')) {
      fields.push({
        key: 'vcodec',
        label: '视频编码',
        type: 'chips',
        def: 'h264',
        options: [['h264', 'H.264'], ['hevc', 'HEVC']],
      });
    }
    return fields;
  }

  const IO_NODES = [
    {
      type: 'io.loadFile',
      isIo: true,
      group: '输入 / 输出',
      icon: '📂',
      name: '加载文件',
      desc: '选择一个或多个待处理的视频 / GIF / 图片 / SVG / 音频 / 文档作为工作流起点',
      inputs: [],
      outputs: [{ id: 'media', label: '媒体输出', typeId: 'any', exts: ['*'], isList: false }],
      fields: [
        { key: 'filePath', type: 'wfFilePicker', label: '输入文件' },
      ],
      defaultParams: () => ({ filePath: '' }),
    },
    {
      type: 'io.loadBatch',
      isIo: true,
      group: '输入 / 输出',
      icon: '📚',
      name: '批量加载文件',
      desc: '一次选择多个文件（或批量读取目录中的素材），以列表形式驱动下游批处理节点',
      inputs: [],
      outputs: [{ id: 'media', label: '文件列表', typeId: 'any', exts: ['*'], isList: true }],
      fields: [
        {
          key: 'filterKind',
          label: '预期媒体类型',
          type: 'select',
          def: 'all',
          options: [
            ['all', '全部媒体类型'],
            ['video', '仅视频'],
            ['image', '仅图片'],
            ['gif', '仅 GIF'],
            ['svg', '仅 SVG'],
            ['audio', '仅音频'],
            ['doc', '仅文档'],
            ['pdf', 'PDF 文档'],
          ],
        },
        { key: 'filePaths', type: 'wfBatchPicker', label: '文件列表' },
      ],
      defaultParams: () => ({ filterKind: 'all', filePaths: [] }),
    },
    {
      type: 'io.loadFolder',
      isIo: true,
      group: '输入 / 输出',
      icon: '📁',
      name: '文件夹扫描',
      desc: '自动扫描指定文件夹内的全部媒体或文档（支持递归子目录与格式过滤），驱动整目录自动批处理',
      inputs: [],
      outputs: [{ id: 'media', label: '文件列表', typeId: 'any', exts: ALL_SUPPORTED_EXTS, isList: true }],
      fields: [
        { key: 'dirPath', type: 'wfFolderScanPicker', label: '目标文件夹' },
        {
          key: 'recursive',
          label: '扫描范围',
          type: 'chips',
          def: 'no',
          options: [
            ['no', '仅当前目录'],
            ['yes', '包含子目录'],
          ],
        },
        {
          key: 'filterKind',
          label: '筛选媒体类型',
          type: 'select',
          def: 'all',
          options: [
            ['all', '全部支持格式'],
            ['image', '仅图片'],
            ['videoAnim', '仅视频与 GIF'],
            ['gif', '仅 GIF'],
            ['svg', '仅 SVG'],
            ['audio', '仅音频'],
            ['doc', '仅文档'],
            ['pdf', 'PDF 文档'],
          ],
        },
      ],
      defaultParams: () => ({ dirPath: '', recursive: 'no', filterKind: 'all' }),
    },
    {
      type: 'io.listPick',
      isIo: true,
      group: '输入 / 输出',
      icon: '🗂️',
      name: '列表筛选 / 取项',
      desc: '从上游多文件列表（如文档提取图、视频拆帧）中按索引取出单个或筛选指定格式',
      inputs: [{ id: 'items', label: '文件列表', typeId: 'any', accept: ['*'], multiConnect: false, required: true }],
      outputs: [{ id: 'out', label: '筛选结果', typeId: 'any', exts: ['*'], isList: false }],
      fields: [
        {
          key: 'pickMode',
          label: '筛选方式',
          type: 'select',
          def: 'first',
          options: [
            ['first', '取第 1 个（转为单文件）'],
            ['last', '取最后 1 个（转为单文件）'],
            ['index', '取指定序号（转为单文件）'],
            ['rasterOnly', '仅保留位图列表'],
            ['svgOnly', '仅保留 SVG 列表'],
            ['videoOnly', '仅保留视频列表'],
            ['pdfOnly', '仅 PDF 文档'],
          ],
        },
        {
          key: 'index',
          label: '序号（从 1 开始）',
          type: 'number',
          def: '1',
          min: 1,
          max: 999,
          step: 1,
          showIf: (v) => v.pickMode === 'index',
        },
      ],
      defaultParams: () => ({ pickMode: 'first', index: '1' }),
    },
    {
      type: 'io.routeType',
      isIo: true,
      group: '输入 / 输出',
      icon: '🔀',
      name: '按格式分流',
      desc: '将混合素材列表自动拆分为位图、SVG、视频/GIF 与其他文件 4 路输出；空分支自动跳过不报错',
      inputs: [{ id: 'items', label: '混合输入', typeId: 'any', accept: ['*'], multiConnect: true, required: true }],
      outputs: [
        { id: 'images', label: '位图图片', typeId: 'image', exts: RASTER_OUT_EXTS, isList: true },
        { id: 'svgs', label: 'SVG 矢量', typeId: 'svg', exts: SVG_EXTS, isList: true },
        { id: 'anims', label: '视频 / 动图', typeId: 'anim', exts: [...VIDEO_EXTS, 'gif', 'apng'], isList: true },
        { id: 'others', label: '音频 / 文档等', typeId: 'any', exts: [...AUDIO_EXTS, ...SUB_EXTS, ...DOC_EXTS, ...PDF_EXTS], isList: true },
      ],
      fields: [
        {
          key: 'gifBucket',
          label: 'GIF 动图归类',
          type: 'chips',
          def: 'anims',
          options: [
            ['anims', '视频/GIF 路'],
            ['images', '位图路'],
          ],
        },
      ],
      defaultParams: () => ({ gifBucket: 'anims' }),
    },
    {
      type: 'io.routeCondition',
      isIo: true,
      group: '输入 / 输出',
      icon: '⚖️',
      name: '条件分流',
      desc: '按文件体积、画面尺寸、横竖屏方向或文件名关键词将媒体拆分为「符合 / 不符合」两路处理',
      inputs: [{ id: 'items', label: '媒体输入', typeId: 'any', accept: ['*'], multiConnect: true, required: true }],
      outputs: [
        { id: 'matched', label: '✅ 符合条件', typeId: 'any', exts: ['*'], isList: true },
        { id: 'unmatched', label: '↩️ 不符合', typeId: 'any', exts: ['*'], isList: true },
      ],
      fields: [
        {
          key: 'rule',
          label: '判断条件',
          type: 'select',
          def: 'sizeGtKB',
          options: [
            ['sizeGtKB', '体积大于指定 KB'],
            ['sizeLtKB', '体积小于指定 KB'],
            ['widthGt', '画面宽度大于 (px)'],
            ['landscape', '横屏画面 (宽 > 高)'],
            ['portrait', '竖屏画面 (高 > 宽)'],
            ['nameMatch', '文件名包含关键词'],
            ['hasAudio', '视频包含音轨'],
          ],
        },
        {
          key: 'threshold',
          label: '阈值（KB 或 px）',
          type: 'number',
          def: '500',
          min: 1,
          max: 1048576,
          step: 10,
          showIf: (v) => ['sizeGtKB', 'sizeLtKB', 'widthGt'].includes(v.rule || 'sizeGtKB'),
        },
        {
          key: 'keyword',
          label: '文件名关键词（逗号分隔）',
          type: 'text',
          def: '',
          placeholder: '如：banner, 封面',
          showIf: (v) => v.rule === 'nameMatch',
        },
      ],
      defaultParams: () => ({ rule: 'sizeGtKB', threshold: '500', keyword: '' }),
    },
    {
      type: 'io.preview',
      isIo: true,
      group: '输入 / 输出',
      icon: '👁️',
      name: '预览检查',
      desc: '检查中间节点的视频/GIF/图片输出效果，支持弹窗放大查看并向后透传',
      inputs: [{ id: 'media', label: '媒体输入', typeId: 'any', accept: ['*'], multiConnect: false, required: true }],
      outputs: [{ id: 'out', label: '透传输出', typeId: 'any', exts: ['*'], isList: false }],
      fields: [],
      defaultParams: () => ({}),
    },
    {
      type: 'io.compare',
      isIo: true,
      group: '输入 / 输出',
      icon: '🔍',
      name: '前后对比',
      desc: '接入处理前后两个视觉节点，支持体积对比与一键启动卷帘/并排放大对比弹窗',
      inputs: [
        { id: 'before', label: '处理前', typeId: 'visual', accept: [...VIDEO_EXTS, 'gif', 'apng', ...RASTER_OUT_EXTS, 'svg'], multiConnect: false, required: true },
        { id: 'after', label: '处理后', typeId: 'visual', accept: [...VIDEO_EXTS, 'gif', 'apng', ...RASTER_OUT_EXTS, 'svg'], multiConnect: false, required: true },
      ],
      outputs: [],
      fields: [],
      defaultParams: () => ({}),
    },
    {
      type: 'io.save',
      isIo: true,
      group: '输入 / 输出',
      icon: '💾',
      name: '保存 / 导出',
      desc: '将上游最终结果写入目标目录（支持多条分支同时接入汇总导出；中间节点仅留缓存）',
      inputs: [{ id: 'media', label: '待导出结果', typeId: 'any', accept: ['*'], multiConnect: true, required: true }],
      outputs: [],
      fields: [
        {
          key: 'outMode',
          label: '导出目录',
          type: 'select',
          def: 'global',
          options: [
            ['global', '跟随全局输出设置'],
            ['same', '源文件同目录'],
            ['subdir', '源文件 output 子目录'],
            ['custom', '自定义文件夹…'],
          ],
        },
        {
          key: 'customDir',
          label: '目标文件夹',
          type: 'wfDirPicker',
          showIf: (v) => v.outMode === 'custom',
        },
        {
          key: 'suffix',
          label: '追加文件名后缀（可选）',
          type: 'text',
          def: '',
          placeholder: '如 _final（留空保持上游命名）',
        },
        {
          key: 'exportAsFolder',
          label: '多文件导出方式',
          type: 'chips',
          def: 'auto',
          options: [
            ['auto', '多文件建子文件夹'],
            ['flat', '直接平铺输出'],
          ],
        },
        {
          key: 'noOverwrite',
          label: '防覆盖重名',
          type: 'chips',
          def: 'yes',
          options: [
            ['yes', '自动加编号'],
            ['no', '覆盖同名'],
          ],
        },
      ],
      defaultParams: () => ({
        outMode: 'global',
        customDir: '',
        suffix: '',
        exportAsFolder: 'auto',
        noOverwrite: 'yes',
      }),
    },
  ];

  function createRegistry(featuresList) {
    const list = Array.isArray(featuresList) ? featuresList : [];
    const featuresById = new Map(list.map((feature) => [feature.id, feature]));
    const defs = new Map();
    const orderedDefs = [];

    for (const io of IO_NODES) {
      defs.set(io.type, io);
      orderedDefs.push(io);
    }

    for (const f of list) {
      const nodeType = `feat.${f.id}`;
      const def = {
        type: nodeType,
        featureId: f.id,
        isIo: false,
        multi: !!f.multi,
        noBatch: !!f.noBatch,
        group: f.group,
        icon: f.icon,
        name: f.id === 'pdfMerge' ? 'PDF 合并' : f.name,
        desc: f.id === 'pdfMerge' ? '按输入顺序将多份 PDF 合并为一份' : f.desc,
        accept: f.accept.slice(),
        inputs: buildFeatureInputs(f),
        outputs: buildFeatureOutputs(f),
        fields: adaptFeatureFields(f),
        defaultParams: () => buildDefaultParams(f),
      };
      defs.set(nodeType, def);
      orderedDefs.push(def);
    }

    function getDef(type) {
      return defs.get(type) || null;
    }

    function getAllDefs() {
      return orderedDefs.slice();
    }

    // 沿图静态解析某节点的上游输出扩展名（用于连线类型提示与实时校验）
    function getUpstreamSpecForPort(graph, nodeId, portId, visited = new Set()) {
      const edge = (graph.edges || []).find((e) => e.toNode === nodeId && e.toPort === portId);
      if (!edge) return null;
      return getNodeOutputSpec(graph, edge.fromNode, edge.fromPort, visited);
    }

    function getNodeOutputSpec(graph, nodeId, portId, visited = new Set()) {
      if (visited.has(nodeId)) return null;
      const node = (graph.nodes || []).find((n) => n.id === nodeId);
      if (!node) return null;
      const def = getDef(node.type);
      if (!def || !def.outputs?.length) return null;

      const nextVisited = new Set(visited);
      nextVisited.add(nodeId);

      let upExts = null;
      let upIsList = false;
      const mainInPort = def.inputs?.[0];
      if (mainInPort) {
        const upEdges = (graph.edges || []).filter((e) => e.toNode === nodeId && e.toPort === mainInPort.id);
        if (upEdges.length) {
          const collected = [];
          for (const ue of upEdges) {
            const sp = getNodeOutputSpec(graph, ue.fromNode, ue.fromPort, nextVisited);
            if (sp?.exts?.length) collected.push(...sp.exts);
            if (sp?.isList) upIsList = true;
          }
          if (collected.length) upExts = Array.from(new Set(collected));
        }
      }

      const dyn = getDynamicOutputSpec(node, upExts, upIsList, portId);
      if (dyn) return dyn;
      const outPort = def.outputs.find((o) => o.id === portId) || def.outputs[0];
      return { exts: outPort.exts, typeId: outPort.typeId, isList: !!outPort.isList };
    }

    // 有向环检测：判断从 startNodeId 出发能否到达 targetNodeId
    function isReachable(graph, startNodeId, targetNodeId) {
      if (startNodeId === targetNodeId) return true;
      const adj = new Map();
      for (const e of graph.edges || []) {
        if (!adj.has(e.fromNode)) adj.set(e.fromNode, []);
        adj.get(e.fromNode).push(e.toNode);
      }
      const q = [startNodeId];
      const seen = new Set([startNodeId]);
      while (q.length) {
        const cur = q.shift();
        for (const nxt of adj.get(cur) || []) {
          if (nxt === targetNodeId) return true;
          if (!seen.has(nxt)) {
            seen.add(nxt);
            q.push(nxt);
          }
        }
      }
      return false;
    }

    function canConnect(graph, fromNodeId, fromPortId, toNodeId, toPortId) {
      if (fromNodeId === toNodeId) return { ok: false, reason: '不能连接节点自身' };
      const fromNode = (graph.nodes || []).find((n) => n.id === fromNodeId);
      const toNode = (graph.nodes || []).find((n) => n.id === toNodeId);
      if (!fromNode || !toNode) return { ok: false, reason: '节点不存在' };

      const fromDef = getDef(fromNode.type);
      const toDef = getDef(toNode.type);
      if (!fromDef || !toDef) return { ok: false, reason: '未知节点类型' };

      const outPort = fromDef.outputs?.find((o) => o.id === fromPortId);
      const inPort = toDef.inputs?.find((i) => i.id === toPortId);
      if (!outPort || !inPort) return { ok: false, reason: '端口无效' };

      if (isReachable(graph, toNodeId, fromNodeId)) {
        return { ok: false, reason: '禁止形成循环连线' };
      }

      const dup = (graph.edges || []).some(
        (e) => e.fromNode === fromNodeId && e.fromPort === fromPortId && e.toNode === toNodeId && e.toPort === toPortId,
      );
      if (dup) return { ok: false, reason: '连线已存在' };

      const outSpec = getNodeOutputSpec(graph, fromNodeId, fromPortId);
      const outExts = outSpec?.exts || outPort.exts;
      if (!hasIntersection(outExts, inPort.accept)) {
        return { ok: false, reason: '输出与输入文件格式不兼容' };
      }
      return { ok: true };
    }

    // 列出与指定源端口输出兼容的所有候选目标节点（用于拖线松手智能新建节点菜单）
    function findCompatibleNodesForOutput(outExts) {
      const results = [];
      for (const def of orderedDefs) {
        if (!def.inputs?.length) continue;
        const matchedPorts = def.inputs.filter((inPort) => hasIntersection(outExts, inPort.accept));
        if (matchedPorts.length) {
          results.push({ def, targetPort: matchedPorts[0], allPorts: matchedPorts });
        }
      }
      return results;
    }

    function resolveReplacementSource(localSrc, linked) {
      if (linked?.paths?.length) {
        return { replaceDir: linked.manifestDir || linked.sourceDir || '', replaceFiles: linked.paths };
      }
      if (localSrc && typeof localSrc === 'object') {
        return { replaceDir: localSrc.dir || '', replaceFiles: Array.isArray(localSrc.files) ? localSrc.files : [] };
      }
      return { replaceDir: typeof localSrc === 'string' ? localSrc : '', replaceFiles: [] };
    }

    // 纯函数构造传给 executeTask 的后端参数，彻底脱离全局 DOM
    function buildNodeTaskParams(node, primaryItem, secondaryPayloads = {}, multiItems = []) {
      const fid = node.type.startsWith('feat.') ? node.type.slice(5) : node.type;
      const v = node.params || {};
      const info = primaryItem?.info || {};
      const inputPath = primaryItem?.path || '';
      const dur = Number(info.duration) || 0;

      const readNodeTimes = () => {
        const s = Math.max(0, parseFloat(v.tStart) || 0);
        let e = parseFloat(v.tEnd);
        if (!Number.isFinite(e) || e <= s) e = dur > s ? dur : s + 1;
        return { start: s, end: e, duration: Math.max(e - s, 0.1) };
      };

      const secPath = (portKey) => {
        const linked = secondaryPayloads[portKey];
        if (linked?.paths?.length) return linked.paths[0];
        return v[`__local_${portKey}`] || '';
      };

      const secInfo = (portKey) => {
        const linked = secondaryPayloads[portKey];
        if (linked?.infos?.length) return linked.infos[0] || {};
        return {};
      };

      switch (fid) {
        case 'videoToGif': {
          const t = readNodeTimes();
          return {
            input: inputPath,
            start: t.start,
            duration: t.duration,
            end: t.end,
            fps: v.fps || '15',
            width: v.width === '0' ? info.width : (v.width || '480'),
            colors: v.colors || '128',
          };
        }
        case 'gifToVideo':
          return { input: inputPath, format: v.format || 'mp4', totalDuration: dur };
        case 'toWebp': {
          const t = readNodeTimes();
          const whole = dur > 0 ? t.duration >= dur - 0.05 : true;
          return {
            input: inputPath,
            start: t.start,
            duration: whole ? 0 : t.duration,
            totalDuration: dur,
            fps: v.fps || '15',
            width: v.width === '0' ? info.width : (v.width || '480'),
            quality: v.quality || '75',
          };
        }
        case 'compressGif': {
          const params = {
            input: inputPath,
            width: v.width === '0' ? info.width : (v.width || '480'),
            customWidth: v.customWidth || '400',
            fps: v.fps === '0' ? (info.fps || 12) : (v.fps || '12'),
            customFps: v.customFps || '10',
            colors: v.colors || '128',
            dither: v.dither || 'bayer5',
            statsMode: v.statsMode || 'diff',
            denoise: v.denoise || 'none',
            dedup: v.dedup || 'no',
            diffMode: v.diffMode || 'rectangle',
            speed: v.speed || '1',
            loop: v.loop || '0',
            srcW: info.width,
            srcFps: info.fps,
            totalDuration: dur,
          };
          if (v.useTrim === 'yes') {
            const t = readNodeTimes();
            const whole = dur > 0 ? t.duration >= dur - 0.05 : true;
            params.start = t.start;
            params.duration = whole ? 0 : t.duration;
          }
          return params;
        }
        case 'trimGif': {
          const mode = v.mode || 'time';
          if (mode === 'frames') {
            return {
              input: inputPath,
              mode: 'frames',
              startFrame: v.startFrame ?? '1',
              endFrame: v.endFrame ?? '15',
              fps: v.fps === '0' ? 0 : (v.fps || 0),
              colors: v.colors || '256',
              loop: v.loop ?? '0',
              srcFps: info.fps,
              nbFrames: info.nbFrames || 0,
              totalDuration: dur,
            };
          }
          const t = readNodeTimes();
          return {
            input: inputPath,
            mode: 'time',
            start: t.start,
            duration: t.duration,
            fps: v.fps === '0' ? 0 : (v.fps || 0),
            colors: v.colors || '256',
            loop: v.loop ?? '0',
            totalDuration: dur,
          };
        }
        case 'gifText':
          return {
            input: inputPath,
            text: v.text,
            pos: v.pos || 'bottom',
            size: v.size || 'medium',
            color: v.color || 'white',
            height: info.height,
            totalDuration: dur,
          };
        case 'compressTarget':
          return {
            input: inputPath,
            targetMB: v.targetMB || '5',
            vcodec: v.vcodec || 'h264',
            width: info.width,
            fps: info.fps,
            hasAudio: info.hasAudio,
            totalDuration: dur,
          };
        case 'chromaGif':
          return {
            input: inputPath,
            color: v.color || '#00ff00',
            similarity: v.similarity ?? '0.2',
            blend: v.blend ?? '0.08',
            width: v.width || '480',
            fps: v.fps || '12',
            totalDuration: dur,
          };
        case 'decorateMedia':
          return {
            input: inputPath,
            progressBar: v.progressBar || 'bottom',
            barColor: v.barColor || '#22d3ee',
            barHeight: v.barHeight || '6',
            rounded: v.rounded ?? '24',
            bgColor: v.bgColor || '#000000',
            srcW: info.width,
            srcH: info.height,
            totalDuration: dur,
          };
        case 'trimVideo': {
          const t = readNodeTimes();
          return {
            input: inputPath,
            start: t.start,
            duration: t.duration,
            precise: v.precise === 'precise',
          };
        }
        case 'multiCut': {
          const segs = Array.isArray(v.segments) ? v.segments : [];
          if (!segs.length) throw new Error('请在「多段保留/删片段」节点中设置至少一个时间段');
          return {
            input: inputPath,
            mode: v.mode || 'remove',
            precise: v.precise === 'precise',
            segments: segs,
            hasAudio: info.hasAudio,
            totalDuration: dur,
          };
        }
        case 'splitVideo':
          return {
            input: inputPath,
            mode: v.mode || 'duration',
            every: v.every || '30',
            count: v.count || '3',
            precise: v.precise === 'precise',
            hasAudio: info.hasAudio,
            totalDuration: dur,
          };
        case 'mergeVideos':
          return {
            files: multiItems.map((m) => m.path),
            mode: v.mode || 'fast',
            transition: v.transition || 'fade',
            transDur: v.transDur || '0.8',
            infos: multiItems.map((m) => m.info || {}),
          };
        case 'videoCrop': {
          const c = v.crop;
          if (!c || !c.w || !c.h) throw new Error('请先在「画面裁剪」节点上设置裁剪区域');
          const srcW = info.width || 1280;
          const srcH = info.height || 720;
          return {
            input: inputPath,
            crop: {
              w: Math.round(c.w * srcW),
              h: Math.round(c.h * srcH),
              x: Math.round(c.x * srcW),
              y: Math.round(c.y * srcH),
            },
            srcW,
            srcH,
            totalDuration: dur,
          };
        }
        case 'autoCrop':
          return { input: inputPath, srcW: info.width, srcH: info.height, totalDuration: dur };
        case 'videoBlur': {
          const c = v.crop;
          if (!c || !c.w || !c.h) throw new Error('请先在「局部打码」节点上设置打码区域');
          const srcW = info.width || 1280;
          const srcH = info.height || 720;
          return {
            input: inputPath,
            crop: {
              w: Math.round(c.w * srcW),
              h: Math.round(c.h * srcH),
              x: Math.round(c.x * srcW),
              y: Math.round(c.y * srcH),
            },
            srcW,
            srcH,
            mode: v.mode || 'blur',
            strength: v.strength || 'medium',
            totalDuration: dur,
          };
        }
        case 'aspectPad':
          return { input: inputPath, ratio: v.ratio || '9:16', bg: v.bg || 'blur', totalDuration: dur };
        case 'pipSplit': {
          const second = secPath('second');
          if (!second) throw new Error('请连接「副画面」端口或在节点内选择第二个视频/GIF');
          return {
            input: inputPath,
            second,
            mode: v.mode || 'hstack',
            pipPos: v.pipPos || 'br',
            pipScale: v.pipScale || '0.25',
            audioMode: v.audioMode || 'first',
            srcW: info.width,
            srcH: info.height,
            hasAudio: info.hasAudio,
            secondHasAudio: !!secInfo('second').hasAudio,
            totalDuration: dur,
          };
        }
        case 'colorStab':
          return {
            input: inputPath,
            brightness: v.brightness ?? '0',
            contrast: v.contrast ?? '1.1',
            saturation: v.saturation ?? '1',
            sharpen: v.sharpen || 'none',
            stabilize: v.stabilize || 'none',
            totalDuration: dur,
          };
        case 'videoFilter':
          return {
            input: inputPath,
            preset: v.preset || 'cinema',
            vignette: v.vignette || 'light',
            sharpen: v.sharpen || 'none',
            totalDuration: dur,
          };
        case 'videoFade':
          return {
            input: inputPath,
            fadeIn: v.fadeIn ?? '1',
            fadeOut: v.fadeOut ?? '1',
            color: v.color || 'black',
            syncAudio: v.syncAudio || 'yes',
            hasAudio: info.hasAudio,
            totalDuration: dur,
          };
        case 'videoText':
          return {
            input: inputPath,
            text: v.text,
            style: v.style || 'pill',
            pos: v.pos || 'bottom',
            size: v.size || 'medium',
            color: v.color || 'white',
            timing: v.timing || 'all',
            start: v.start ?? '0',
            end: v.end ?? '5',
            srcH: info.height,
            totalDuration: dur,
          };
        case 'rotateFlip':
          return { input: inputPath, mode: v.mode || 'r90', totalDuration: dur };
        case 'reverse':
          return { input: inputPath, mode: v.mode || 'reverse', hasAudio: info.hasAudio, totalDuration: dur };
        case 'changeSpeed':
          return { input: inputPath, speed: v.speed ?? '1.5', hasAudio: info.hasAudio, totalDuration: dur };
        case 'extractAudio':
          return { input: inputPath, format: v.format || 'mp3', totalDuration: dur };
        case 'audioAdjust':
          return {
            input: inputPath,
            mode: v.mode || 'mute',
            volume: v.volume || '2',
            fadeIn: v.fadeIn || '1',
            fadeOut: v.fadeOut || '1',
            hasAudio: info.hasAudio,
            totalDuration: dur,
          };
        case 'addMusic': {
          const music = secPath('music');
          if (!music) throw new Error('请连接「背景音乐」端口或在节点内选择音乐文件');
          return {
            input: inputPath,
            music,
            mode: v.mode || 'replace',
            musicVolume: v.musicVolume || '1',
            ducking: v.ducking || 'no',
            hasAudio: info.hasAudio,
            totalDuration: dur,
          };
        }
        case 'watermark': {
          const wmImg = v.mode === 'image' ? secPath('image') : '';
          if (v.mode === 'image' && !wmImg) throw new Error('请连接「水印图」端口或在节点内选择水印图片');
          return {
            input: inputPath,
            mode: v.mode || 'text',
            text: v.text,
            image: wmImg,
            pos: v.pos || 'br',
            wmColor: v.wmColor,
            tileAngle: v.tileAngle,
            tileDensity: v.tileDensity,
            size: v.size || 'medium',
            opacity: v.opacity || '0.7',
            srcW: info.width,
            srcH: info.height,
            totalDuration: dur,
          };
        }
        case 'subtitleTool': {
          const mode = v.mode || 'burn';
          const subtitle = mode === 'burn' ? secPath('subtitle') : '';
          if (mode === 'burn' && !subtitle) throw new Error('请连接「字幕文件」端口或在节点内选择字幕');
          return {
            input: inputPath,
            mode,
            subtitle,
            fontSize: v.fontSize || '22',
            marginV: v.marginV || '24',
            subIndex: v.subIndex || '0',
            hasSubtitles: info.hasSubtitles,
            totalDuration: dur,
          };
        }
        case 'snapshot': {
          const mode = v.mode || 'single';
          if (mode === 'all') return { input: inputPath, mode: 'all', totalDuration: dur };
          if (mode === 'seq') {
            const t = readNodeTimes();
            const whole = dur > 0 ? t.duration >= dur - 0.05 : true;
            return {
              input: inputPath,
              mode: 'seq',
              every: v.every || '1',
              start: t.start,
              duration: whole ? 0 : t.duration,
              totalDuration: dur,
            };
          }
          return { input: inputPath, mode: 'single', at: v.at ?? '1', format: v.format || 'png' };
        }
        case 'contactSheet':
          return {
            input: inputPath,
            layout: v.layout || '3x3',
            cellWidth: v.cellWidth || '400',
            timestamps: v.timestamps || 'yes',
            format: v.format || 'jpg',
            totalDuration: dur,
          };
        case 'stripMeta':
          return { input: inputPath, totalDuration: dur };
        case 'imagesTo': {
          const sizes = {};
          for (const m of multiItems) sizes[m.path] = { w: m.info?.width || 0, h: m.info?.height || 0 };
          return {
            files: multiItems.map((m) => m.path),
            format: v.format || 'gif',
            fps: v.fps || '8',
            sizes,
          };
        }
        case 'imageConvert':
          return {
            input: inputPath,
            format: v.format || 'webp',
            quality: (v.format || 'webp') === 'png' ? (v.quality || 'high') : (v.quality === 'png8' ? 'medium' : (v.quality || 'high')),
            icoSize: v.icoSize || '256',
            resizeMode: v.resizeMode || 'keep',
            maxSide: v.maxSide || '1920',
            percent: v.percent || '50',
            customWidth: v.customWidth || '1080',
            bgColor: v.bgColor || '#ffffff',
            stripMeta: v.stripMeta || 'yes',
          };
        case 'imageCompressTarget':
          return {
            input: inputPath,
            targetKB: v.targetKB || '200',
            format: v.format || 'auto',
            bgColor: v.bgColor || '#ffffff',
            srcW: info.width,
            srcH: info.height,
          };
        case 'imageStitch': {
          const sizes = {};
          for (const m of multiItems) sizes[m.path] = { w: m.info?.width || 0, h: m.info?.height || 0 };
          return {
            files: multiItems.map((m) => m.path),
            infos: multiItems.map((m) => m.info || {}),
            sizes,
            mode: v.mode || 'vertical',
            cols: v.cols || '2',
            fit: v.fit || 'cover',
            cellRatio: v.cellRatio || '1:1',
            gap: v.gap ?? '8',
            format: v.format || 'jpg',
            bgColor: resolveBgColor(v, '#ffffff'),
          };
        }
        case 'imageSplit':
          return {
            input: inputPath,
            mode: v.mode || '3x3',
            count: v.count || '4',
            sliceHeight: v.sliceHeight || '1280',
            format: v.format || 'png',
            srcW: info.width,
            srcH: info.height,
          };
        case 'imageCutout':
          return {
            input: inputPath,
            color: v.color || '#ffffff',
            similarity: v.similarity ?? '0.18',
            blend: v.blend ?? '0.06',
            format: v.format || 'png',
          };
        case 'imageReplaceBg': {
          const bgType = v.bgType || 'solid';
          const bgImage = bgType === 'image' ? secPath('bgImage') : '';
          if (bgType === 'image' && !bgImage) {
            throw new Error('请连接「背景图」端口或在节点内选择背景图片');
          }
          return {
            input: inputPath,
            bgType,
            bgColor: v.bgColor || '#438edb',
            gradStart: v.gradStart || '#6366f1',
            gradEnd: v.gradEnd || '#22d3ee',
            gradDir: v.gradDir || 'tlbr',
            bgImage,
            bgFit: v.bgFit || 'bgOriginal',
            fgScale: v.fgScale || 'fitAuto',
            fgPos: v.fgPos || 'center',
            fgMode: v.fgMode || 'auto',
            keyColor: v.keyColor || '#ffffff',
            cutoutScope: v.cutoutScope || 'edge',
            similarity: v.similarity ?? '0.18',
            blend: v.blend ?? '0.06',
            format: v.format || 'png',
          };
        }
        case 'imageFrame': {
          const fmt = v.format || 'png';
          return {
            input: inputPath,
            rounded: v.rounded ?? '24',
            padding: v.padding ?? '24',
            format: fmt,
            bgColor: fmt === 'jpg' ? (v.bgCustom || '#ffffff') : resolveBgColor(v, '#ffffff'),
            srcW: info.width,
            srcH: info.height,
          };
        }
        case 'svgToRaster': {
          const fmt = v.format || 'png';
          const needOpaque = fmt === 'jpg' || fmt === 'bmp';
          const bg = resolveBgColor({ bgMode: v.bgMode || 'transparent', bgCustom: v.bgCustom }, 'transparent');
          return {
            input: inputPath,
            format: fmt,
            scaleMode: fmt === 'ico' ? 'original' : (v.scaleMode || 'scale'),
            scale: v.scale || '2',
            width: v.width || '1024',
            maxSide: v.maxSide || '1920',
            icoSize: v.icoSize || '256',
            quality: v.quality || 'high',
            bgColor: needOpaque && bg === 'transparent' ? (v.bgCustom || '#ffffff') : bg,
          };
        }
        case 'svgOptimize':
          return {
            input: inputPath,
            preset: v.preset || 'default',
            floatPrecision: v.floatPrecision || '2',
            multipass: true,
            keepViewBox: (v.keepViewBox || 'yes') === 'yes',
            stripDims: (v.stripDims || 'no') === 'yes',
          };
        case 'imageToSvg':
          return {
            input: inputPath,
            mode: v.mode || 'bw',
            colors: !v.colors || v.colors === 'auto' ? 0 : v.colors,
            smooth: v.smooth || 'medium',
            transparentBg: v.transparentBg || 'alpha',
            maxDim: v.maxDim || '800',
            noiseFilter: v.noiseFilter ?? '8',
            optimizeSvg: (v.optimizeSvg || 'yes') === 'yes',
          };
        case 'docCompressImages':
          return {
            input: inputPath,
            preset: v.preset || 'balanced',
            maxSide: v.maxSide || '1920',
            formatMode: v.formatMode || 'auto',
            videoMode: v.videoMode || 'compress',
            sectionKeyword: v.sectionKeyword || '',
          };
        case 'docExtractImages':
          return {
            input: inputPath,
            naming: v.naming || 'order',
            pptMedia: v.pptMedia || 'images',
            remoteMode: v.remoteMode || 'skip',
            includeSvg: (v.includeSvg || 'yes') === 'yes',
            dedupe: (v.dedupe || 'yes') === 'yes',
            sectionKeyword: v.sectionKeyword || '',
          };
        case 'docRepackImages': {
          const { replaceDir, replaceFiles } = resolveReplacementSource(v.__local_replaceSource, secondaryPayloads.replaceSource);
          if (!replaceDir && !replaceFiles.length) {
            throw new Error('请连接「替换图片」端口或在节点内选择替换文件夹');
          }
          return { input: inputPath, replaceDir, replaceFiles, sizeMode: v.sizeMode || 'keepWidth' };
        }
        case 'docCleanupMedia':
          return {
            input: inputPath,
            removeOrphans: (v.removeOrphans || 'yes') !== 'no',
            dedupeMedia: (v.dedupeMedia || 'yes') !== 'no',
          };
        case 'docStyleImages':
          return {
            input: inputPath,
            frameMode: v.frameMode || 'rounded',
            radius: v.radius || '24',
            borderWidth: v.borderWidth || '16',
            borderColor: v.borderColor || '#ffffff',
            wmText: String(v.wmText || '').trim(),
            wmPos: v.wmPos || 'br',
            wmSize: v.wmSize || 'medium',
            wmOpacity: v.wmOpacity ?? '0.45',
            wmColor: v.wmColor || 'white',
            sectionKeyword: v.sectionKeyword || '',
          };
        case 'mdOrganizeImages':
          return {
            input: inputPath,
            action: v.action || 'localize',
            assetsDirName: v.assetsDirName || 'assets',
            remoteMode: v.remoteMode || 'download',
            inlineSvgMode: v.inlineSvgMode || 'extract',
            cleanAction: v.cleanAction || 'move',
          };
        case 'imagesToPdf':
          return {
            files: multiItems.map((m) => m.path),
            pageSize: v.pageSize || 'a4p',
            margin: v.margin ?? '20',
            quality: v.quality || 'high',
            bgColor: v.bgColor || '#ffffff',
          };
        case 'removeSilence':
          return {
            input: inputPath,
            threshold: v.threshold ?? '-35',
            minSilence: v.minSilence ?? '0.4',
            padding: v.padding ?? '0.12',
            totalDuration: dur,
          };
        case 'pdfToImages':
          return {
            input: inputPath,
            mode: v.mode || 'pages',
            format: v.format || 'png',
            dpiScale: v.dpiScale ?? '2',
            pageRange: v.pageRange || '',
          };
        case 'pdfMerge':
          return {
            files: multiItems.map((m) => m.path),
          };
        case 'pdfSplit':
          return {
            input: inputPath,
            mode: v.mode || 'extract',
            pageRange: v.pageRange ?? '1',
            everyN: v.everyN ?? '1',
          };
        case 'convertVideo':
        case 'animSprite':
        case 'audioConvert':
        case 'audioTrim':
        case 'audioMerge':
        case 'imageCanvas':
        case 'videoCover':
        case 'docToPdf':
        case 'wordToPdf':
        case 'pdfToWord':
        case 'pdfCompress':
        case 'pdfSearchable':
        case 'pdfCrop':
        case 'pdfRotate':
        case 'pdfWatermark':
          return featuresById.get(fid).collect(v, {
            file: { path: inputPath, info: { ...info, duration: dur } },
            files: multiItems,
            times: fid === 'audioTrim' ? readNodeTimes() : undefined,
            coverImage: fid === 'videoCover' ? secPath('coverImage') : undefined,
          });
        default:
          throw new Error(`未实现的节点功能：${fid}`);
      }
    }

    return {
      PORT_TYPES,
      GROUP_META,
      GROUP_ORDER,
      VIDEO_EXTS,
      IMG_EXTS,
      SVG_EXTS,
      AUDIO_EXTS,
      SUB_EXTS,
      DOC_EXTS,
      PDF_EXTS,
      ALL_SUPPORTED_EXTS,
      extOf,
      hasIntersection,
      inferPortTypeId,
      getDef,
      getAllDefs,
      getDynamicOutputSpec,
      getNodeOutputSpec,
      getUpstreamSpecForPort,
      canConnect,
      findCompatibleNodesForOutput,
      buildNodeTaskParams,
      resolveReplacementSource,
    };
  }

  // 在浏览器环境加载时自动从 window.VGT.*_FEATURES 构造单例注册表
  if (typeof window !== 'undefined' && typeof module === 'undefined') {
    const vgt = (typeof globalThis !== 'undefined' ? globalThis.VGT : window.VGT) || {};
    const combined = [
      ...(vgt.VIDEO_FEATURES || []),
      ...(vgt.IMAGE_FEATURES || []),
      ...(vgt.SVG_FEATURES || []),
      ...(vgt.DOC_FEATURES || []),
    ];
    const reg = createRegistry(combined);
    reg.createRegistry = createRegistry;
    return reg;
  }

  return { createRegistry, PORT_TYPES, GROUP_META, GROUP_ORDER, extOf, hasIntersection };
});
