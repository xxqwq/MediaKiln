'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  inspectDocument,
  allocUniqueMediaEntry,
  rewriteDocxMediaTargets,
  ensureDocxContentTypes,
  updateOoxmlImageSizesKeepWidth,
  findReferencedOoxmlMedia,
  removeDocxContentTypeOverrides,
  scanMarkdownForRewrite,
  applyTextReplacements,
} = require('../core/doc-parser');
const { FONT, num, normalizeHexColor, imageCodecArgs, writeRoundedMaskPgm } = require('../core/utils');
const { probe, runFfmpeg, defaultOutput, defaultDirOutput, stampOutput, throwIfTaskCancelled, commitOutput, writeTaskOutput, copyTaskOutput } = require('../core/runner');
const {
  parsePageRange,
  getPdfPageCount,
  renderPdfPagesToPngs,
  buildPdfFromJpegPages,
  getJpegDimensions,
  mergePdfFiles,
  organizePdfPages,
  extractPdfPages,
  splitPdfIntoChunks,
} = require('../core/pdf-engine');
const { collectCandidateImages, readManifestNear } = require('../core/doc-replacements');
const { convertDocToPdf } = require('../core/md-renderer');
const {
  convertWordToPdf,
  convertPdfToWord,
  compressPdfFile,
  rotatePdfPages,
  watermarkAndNumberPdf,
} = require('../core/pdf-office');

async function runWithConcurrency(items, concurrency, worker) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let nextIdx = 0;
  let cancelErr = null;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (!cancelErr) {
        const idx = nextIdx++;
        if (idx >= items.length) break;
        try {
          results[idx] = await worker(items[idx], idx);
        } catch (err) {
          if (err && err.message === '任务已取消') {
            cancelErr = err;
            throw err;
          }
          throw err;
        }
      }
    }),
  );
  if (cancelErr) throw cancelErr;
  return results;
}

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

const RASTER_MEDIA_EXTS = new Set(['png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff', 'webp']);
const VIDEO_MEDIA_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'm4v', 'flv', 'mpg', 'mpeg']);
const WORD_SAFE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff']);

function sanitizeBase(raw, fallback = 'image') {
  const cleaned = String(raw || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
  return cleaned || fallback;
}

function allocUniquePath(dir, stem, ext, usedSet) {
  const cleanExt = String(ext || 'png').replace(/^\./, '').toLowerCase() || 'png';
  let candidate = `${stem}.${cleanExt}`;
  let idx = 1;
  while (usedSet.has(candidate.toLowerCase()) || fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}_${idx++}.${cleanExt}`;
  }
  usedSet.add(candidate.toLowerCase());
  return path.join(dir, candidate);
}

function decodeDataUri(item) {
  if (item.isBase64) {
    return Buffer.from(item.payload.replace(/\s+/g, ''), 'base64');
  }
  try {
    return Buffer.from(decodeURIComponent(item.payload), 'utf8');
  } catch {
    return Buffer.from(item.payload, 'utf8');
  }
}

async function downloadRemoteImage(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    headers: { 'User-Agent': 'MediaKiln/0.1' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (ct && !ct.startsWith('image/') && ct !== 'application/octet-stream') {
    throw new Error(`非图片类型 (${ct})`);
  }
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (!buf.length) throw new Error('空响应');
  const extFromCt = MIME_EXT[ct];
  return { buf, extFromCt };
}

function inferNameFromItem(item, index) {
  if (item.kind === 'docxMedia' || item.kind === 'pptxMedia') {
    const ext = path.posix.extname(item.filename).slice(1).toLowerCase() || item.ext || 'png';
    const base = path.posix.basename(item.filename, path.posix.extname(item.filename));
    return { stem: sanitizeBase(base, `media_${index + 1}`), ext };
  }
  if (item.kind === 'local') {
    const ext = path.extname(item.resolvedPath).slice(1).toLowerCase() || item.ext || 'png';
    const base = path.basename(item.resolvedPath, path.extname(item.resolvedPath));
    return { stem: sanitizeBase(base, `image_${index + 1}`), ext };
  }
  if (item.kind === 'remote') {
    let base = '';
    let ext = item.ext || 'png';
    try {
      const u = new URL(item.target);
      const rawName = decodeURIComponent(path.posix.basename(u.pathname || ''));
      const rawExt = path.posix.extname(rawName).slice(1).toLowerCase();
      if (rawExt) ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
      base = rawName ? path.posix.basename(rawName, path.posix.extname(rawName)) : '';
    } catch {}
    return { stem: sanitizeBase(base || item.alt, `web_${index + 1}`), ext };
  }
  if (item.kind === 'inlineSvg') {
    return { stem: sanitizeBase(item.alt && item.alt !== 'inline-svg' ? item.alt : `inline_svg_${index + 1}`), ext: 'svg' };
  }
  return { stem: sanitizeBase(item.alt, `embedded_${index + 1}`), ext: item.ext || 'png' };
}

function isAlphaPixFmt(pixFmt) {
  const f = String(pixFmt || '').toLowerCase();
  return f.includes('rgba') || f.includes('bgra') || f.includes('yuva') || f.includes('ya') || f.includes('pal8') || f.includes('abgr') || f.includes('argb');
}

async function compressRasterFile(taskId, srcPath, origExt, { maxSide, preset, formatMode }, tmpDir, idx) {
  const info = await probe(srcPath);
  const w = info.width || 0;
  const h = info.height || 0;
  if (!w || !h) return null;

  const hasAlpha = origExt === 'png' && isAlphaPixFmt(info.pixFmt);
  let targetFmt;
  if (formatMode === 'keep') {
    targetFmt = (origExt === 'jpeg' || origExt === 'jpg') ? 'jpg' : (origExt === 'png' ? 'png' : 'jpg');
  } else if (formatMode === 'jpg') {
    targetFmt = 'jpg';
  } else {
    targetFmt = hasAlpha ? 'png' : 'jpg';
  }

  const outPath = path.join(tmpDir, `out_${idx}.${targetFmt}`);
  const vfParts = [];
  if (maxSide > 0 && Math.max(w, h) > maxSide) {
    vfParts.push(`scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease:flags=lanczos`);
  }

  if (targetFmt === 'png') {
    if (preset === 'high') {
      const args = ['-i', srcPath];
      if (vfParts.length) args.push('-vf', vfParts.join(','));
      args.push('-map_metadata', '-1', '-c:v', 'png', '-compression_level', '9', '-update', '1', '-frames:v', '1', outPath);
      await runFfmpeg(taskId, args, { totalDuration: 0 });
    } else {
      const palPath = path.join(tmpDir, `pal_${idx}.png`);
      const scaleChain = vfParts.length ? `${vfParts.join(',')},` : '';
      const maxColors = preset === 'extreme' ? 128 : 256;
      await runFfmpeg(taskId, [
        '-i', srcPath,
        '-vf', `${scaleChain}palettegen=max_colors=${maxColors}:stats_mode=single:reserve_transparent=1`,
        '-update', '1', '-frames:v', '1', palPath,
      ], { totalDuration: 0 });
      await runFfmpeg(taskId, [
        '-i', srcPath, '-i', palPath,
        '-filter_complex', `[0:v]${scaleChain}format=rgba[img];[img][1:v]paletteuse=dither=bayer:bayer_scale=3:alpha_threshold=128`,
        '-map_metadata', '-1', '-c:v', 'png', '-compression_level', '9', '-update', '1', '-frames:v', '1', outPath,
      ], { totalDuration: 0 });
    }
  } else {
    const qv = preset === 'high' ? 3 : (preset === 'extreme' ? 9 : 5);
    const args = ['-i', srcPath];
    if (hasAlpha) {
      const scaleChain = vfParts.length ? `${vfParts.join(',')},` : '';
      args.push(
        '-filter_complex',
        `[0:v]${scaleChain}format=rgba,split[__fg][__bgsrc];[__bgsrc]drawbox=x=0:y=0:w=iw:h=ih:color=0xffffff@1:t=fill[__bg];[__bg][__fg]overlay=0:0:shortest=1,format=rgb24[out]`,
        '-map', '[out]',
      );
    } else {
      const chain = [...vfParts, 'format=rgb24'];
      args.push('-vf', chain.join(','));
    }
    args.push('-map_metadata', '-1', ...imageCodecArgs('jpg', { qv }), outPath);
    await runFfmpeg(taskId, args, { totalDuration: 0 });
  }

  const buf = fs.readFileSync(outPath);
  return { ext: targetFmt, buf };
}

async function compressEmbeddedVideoFile(taskId, srcPath, { maxSide, preset }, tmpDir, idx) {
  const info = await probe(srcPath);
  const w = info.width || 0;
  const h = info.height || 0;
  if (!w || !h) return null;

  const crf = preset === 'high' ? '22' : (preset === 'extreme' ? '30' : '26');
  const outPath = path.join(tmpDir, `vout_${idx}.mp4`);
  const vfParts = [];
  if (maxSide > 0 && Math.max(w, h) > maxSide) {
    vfParts.push(`scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease:flags=lanczos`);
  }
  vfParts.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');

  const args = [
    '-i', srcPath,
    '-vf', vfParts.join(','),
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', crf,
    '-pix_fmt', 'yuv420p',
  ];
  if (info.hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push('-an');
  }
  args.push('-map_metadata', '-1', '-movflags', '+faststart', outPath);

  await runFfmpeg(taskId, args, { totalDuration: info.duration || 0 });
  const buf = fs.readFileSync(outPath);
  return { ext: 'mp4', buf };
}

function filterDocumentItemsBySection(parsed, sectionIds = [], sectionKeyword = '') {
  const allItems = parsed.items || [];
  let items = allItems;
  let sectionTitlesUsed = [];

  if (sectionIds.length) {
    const selSet = new Set(sectionIds);
    items = allItems.filter((it) => selSet.has(it.sectionId));
    sectionTitlesUsed = (parsed.sections || []).filter((s) => selSet.has(s.id)).map((s) => s.title);
  } else if (sectionKeyword) {
    const keywords = sectionKeyword.split(/[,，]+/).map((k) => k.trim()).filter(Boolean);
    items = allItems.filter((it) => {
      const titles = [it.sectionTitle, ...(it.ancestorTitles || [])].filter(Boolean);
      return titles.some((t) => {
        const tl = t.toLowerCase();
        return keywords.some((kw) => tl.includes(kw));
      });
    });
    sectionTitlesUsed = (parsed.sections || [])
      .filter((s) => {
        const sl = s.title.toLowerCase();
        return keywords.some((kw) => sl.includes(kw));
      })
      .map((s) => s.title);
  }

  return {
    items,
    sectionFiltered: Boolean(sectionIds.length || sectionKeyword),
    sectionTitlesUsed,
  };
}

function docExtractImages(p) {
  const outDir = p.output || defaultDirOutput(p.input, '提取图片');
  const naming = p.naming || 'order';
  const remoteMode = p.remoteMode || 'skip';
  const dedupe = p.dedupe !== false && p.dedupe !== 'false';
  const includeSvg = p.includeSvg !== false && p.includeSvg !== 'false';
  const pptMedia = p.pptMedia || 'images';
  const sectionIds = Array.isArray(p.sectionIds) ? p.sectionIds.filter(Boolean) : [];
  const sectionKeyword = String(p.sectionKeyword || '').trim().toLowerCase();

  return {
    output: outDir,
    outputType: 'dir',
    async run(_taskId, onProgress) {
      onProgress?.(0.08);
      const parsed = inspectDocument(p.input);
      const allItems = parsed.items || [];
      if (!allItems.length) {
        throw new Error(parsed.docType === 'pptx' ? '该 PPT 中未识别到任何图片或媒体资源' : '该文档中未识别到任何图片');
      }

      const {
        items,
        sectionFiltered,
        sectionTitlesUsed,
      } = filterDocumentItemsBySection(parsed, sectionIds, sectionKeyword);

      if (sectionFiltered && !items.length) {
        throw new Error('所选章节中未找到任何图片或媒体资源');
      }

      let zip = null;
      if (parsed.docType === 'docx' || parsed.docType === 'pptx') {
        const AdmZip = require('adm-zip');
        zip = new AdmZip(p.input);
      }

      const seenKey = new Set();
      const usedNames = new Set();
      const savedFiles = [];
      const manifestItems = [];
      let createdDir = false;
      const ensureDir = () => {
        if (!createdDir) {
          fs.mkdirSync(outDir, { recursive: true });
          createdDir = true;
        }
      };

      const summary = {
        docType: parsed.docType,
        totalFound: items.length,
        savedCount: 0,
        docxCount: 0,
        pptxCount: 0,
        pptAvCount: 0,
        pptAvSkipped: 0,
        localCount: 0,
        dataUriCount: 0,
        inlineSvgCount: 0,
        remoteDownloaded: 0,
        remoteSkipped: 0,
        missingLocal: 0,
        failedRemote: 0,
        svgSkipped: 0,
      };

      const padLen = Math.max(2, String(items.length).length);

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        onProgress?.(0.1 + (0.88 * (i + 1)) / items.length);

        if (item.kind === 'pptxMedia' && item.mediaKind !== 'image' && pptMedia !== 'all') {
          summary.pptAvSkipped++;
          continue;
        }

        const isSvgItem = item.ext === 'svg' || item.kind === 'inlineSvg';
        if (isSvgItem && !includeSvg) {
          summary.svgSkipped++;
          continue;
        }

        if (item.kind === 'remote' && remoteMode !== 'download') {
          summary.remoteSkipped++;
          continue;
        }

        if (item.kind === 'local' && !item.exists) {
          summary.missingLocal++;
          continue;
        }

        if (dedupe) {
          const key = item.kind === 'docxMedia'
            ? `docx:${item.entryName}`
            : item.kind === 'pptxMedia'
              ? `pptx:${item.entryName}`
              : item.kind === 'local'
                ? `local:${item.resolvedPath.toLowerCase()}`
                : item.kind === 'remote'
                  ? `remote:${item.target}`
                  : item.kind === 'dataUri'
                    ? `data:${item.mime}:${item.payload.slice(0, 64)}:${item.payload.length}`
                    : `svg:${item.svgCode}`;
          if (seenKey.has(key)) continue;
          seenKey.add(key);
        }

        let buf = null;
        let { stem, ext } = inferNameFromItem(item, i);

        try {
          if (item.kind === 'docxMedia' || item.kind === 'pptxMedia') {
            const entry = zip.getEntry(item.entryName);
            if (!entry) continue;
            buf = entry.getData();
            if (item.kind === 'docxMedia') summary.docxCount++;
            else if (item.mediaKind === 'image') summary.pptxCount++;
            else summary.pptAvCount++;
          } else if (item.kind === 'local') {
            buf = fs.readFileSync(item.resolvedPath);
            summary.localCount++;
          } else if (item.kind === 'dataUri') {
            buf = decodeDataUri(item);
            summary.dataUriCount++;
          } else if (item.kind === 'inlineSvg') {
            buf = Buffer.from(item.svgCode, 'utf8');
            summary.inlineSvgCount++;
          } else if (item.kind === 'remote') {
            const dl = await downloadRemoteImage(item.target);
            buf = dl.buf;
            if (dl.extFromCt) ext = dl.extFromCt;
            summary.remoteDownloaded++;
          }
        } catch {
          if (item.kind === 'remote') summary.failedRemote++;
          continue;
        }

        if (!buf || !buf.length) continue;

        ensureDir();
        const orderPrefix = `${String(savedFiles.length + 1).padStart(padLen, '0')}_`;
        const finalStem = naming === 'original' ? stem : `${orderPrefix}${stem}`;
        const dest = allocUniquePath(outDir, finalStem, ext, usedNames);
        fs.writeFileSync(dest, buf);
        savedFiles.push(dest);

        if (item.kind === 'docxMedia' || (item.kind === 'pptxMedia' && item.mediaKind === 'image')) {
          const savedName = path.basename(dest);
          manifestItems.push({
            index: savedFiles.length,
            savedName,
            stem: path.basename(savedName, path.extname(savedName)),
            entryName: item.entryName,
            origFilename: item.filename,
          });
        }
      }

      summary.savedCount = savedFiles.length;
      if (!savedFiles.length) {
        const hints = [];
        if (summary.remoteSkipped) hints.push(`${summary.remoteSkipped} 个网络图片（当前设为跳过，可切换为“同时下载网络图片”）`);
        if (summary.missingLocal) hints.push(`${summary.missingLocal} 个本地图片路径在磁盘上不存在`);
        if (summary.failedRemote) hints.push(`${summary.failedRemote} 个网络图片下载失败`);
        if (summary.svgSkipped) hints.push(`${summary.svgSkipped} 个 SVG（当前已跳过）`);
        if (summary.pptAvSkipped) hints.push(`${summary.pptAvSkipped} 个 PPT 音视频（当前设为仅提取图片）`);
        throw new Error(`未提取到可保存的媒体文件${hints.length ? `：${hints.join('，')}` : ''}`);
      }

      const isOoxml = parsed.docType === 'docx' || parsed.docType === 'pptx';
      if (isOoxml && manifestItems.length) {
        fs.writeFileSync(
          path.join(outDir, '.vgt-manifest.json'),
          JSON.stringify({
            version: 1,
            docType: parsed.docType,
            sourceDocx: path.resolve(p.input),
            createdAt: Date.now(),
            items: manifestItems,
          }, null, 2),
          'utf8',
        );
      }

      onProgress?.(1);
      return {
        output: outDir,
        outputType: 'dir',
        extractSummary: {
          ...summary,
          sourceDocx: isOoxml ? path.resolve(p.input) : '',
          sectionFiltered: Boolean(sectionIds.length || sectionKeyword),
          sectionTitles: sectionTitlesUsed,
          files: savedFiles,
        },
      };
    },
  };
}

function docCompressImages(p) {
  const ext = path.extname(String(p.input || '')).slice(1).toLowerCase();
  if (ext === 'doc') {
    throw new Error('暂不支持旧版 .doc 二进制格式，请在 Word/WPS 中「另存为 .docx」后再压缩');
  }
  if (ext === 'ppt') {
    throw new Error('暂不支持旧版 .ppt 二进制格式，请在 PowerPoint/WPS 中「另存为 .pptx」后再压缩');
  }
  const isPpt = ext === 'pptx';
  const docLabel = isPpt ? 'PPT' : 'Word';
  const mediaPrefix = isPpt ? 'ppt/media' : 'word/media';
  const mediaRe = isPpt ? /^ppt\/media\//i : /^word\/media\//i;
  const output = p.output || defaultOutput(p.input, '已压缩', isPpt ? 'pptx' : 'docx', p);
  const preset = p.preset || 'balanced';
  const maxSide = Math.max(0, Math.round(num(p.maxSide, 1920)));
  const formatMode = p.formatMode || 'auto';
  const compressVideo = isPpt && p.videoMode !== 'keep';
  const sectionIds = Array.isArray(p.sectionIds) ? p.sectionIds.filter(Boolean) : [];
  const sectionKeyword = String(p.sectionKeyword || '').trim().toLowerCase();

  return {
    output,
    async run(taskId, onProgress) {
      onProgress?.(0.05);
      let selectedEntrySet = null;
      let sectionFiltered = false;
      let sectionTitlesUsed = [];

      if (sectionIds.length || sectionKeyword) {
        const parsed = inspectDocument(p.input);
        const filtered = filterDocumentItemsBySection(parsed, sectionIds, sectionKeyword);
        sectionFiltered = filtered.sectionFiltered;
        sectionTitlesUsed = filtered.sectionTitlesUsed;
        if (!filtered.items.length) {
          throw new Error('所选章节或页面中未找到任何图片或媒体资源');
        }
        selectedEntrySet = new Set(
          filtered.items
            .map((it) => String(it.entryName || '').toLowerCase())
            .filter(Boolean),
        );
      }

      const AdmZip = require('adm-zip');
      let zip;
      try {
        zip = new AdmZip(p.input);
      } catch {
        throw new Error(`无法解析该 .${isPpt ? 'pptx' : 'docx'} 文件（可能已损坏或并非标准 ${docLabel} 文档）`);
      }

      const origSize = fs.statSync(p.input).size;
      const allEntries = zip.getEntries();
      const usedMediaSet = new Set();
      const targets = [];

      for (const e of allEntries) {
        const entryName = String(e.entryName || '').replace(/\\/g, '/');
        if (e.isDirectory || !mediaRe.test(entryName)) continue;
        usedMediaSet.add(entryName.toLowerCase());
        if (selectedEntrySet && !selectedEntrySet.has(entryName.toLowerCase())) continue;
        const mExt = path.posix.extname(entryName).slice(1).toLowerCase();
        if (e.header.size > 0 && RASTER_MEDIA_EXTS.has(mExt)) {
          targets.push({ kind: 'image', entry: e, entryName, origExt: mExt });
        } else if (compressVideo && e.header.size > 0 && VIDEO_MEDIA_EXTS.has(mExt)) {
          targets.push({ kind: 'video', entry: e, entryName, origExt: mExt });
        }
      }

      if (!targets.length) {
        if (sectionFiltered) {
          throw new Error(`所选章节或页面中未找到可压缩的位图图片${isPpt ? '或视频' : ''}（可能仅含矢量图${isPpt && !compressVideo ? '或已设跳过视频' : ''}）`);
        }
        throw new Error(`该 ${docLabel} 文档内未找到可压缩的位图图片${isPpt ? '或视频' : ''}（可能仅含文字或 EMF/WMF 矢量图）`);
      }

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_doc_cmp_'));
      const renameMap = new Map();
      const usedExts = new Set();
      let compressedCount = 0;
      let videoCompressedCount = 0;
      let skippedCount = 0;

      try {
        const origBufs = targets.map((t) => t.entry.getData());
        const results = new Array(targets.length).fill(null);
        let completedCount = 0;

        const processOne = async (idx) => {
          const t = targets[idx];
          const origBuf = origBufs[idx];
          const tmpIn = path.join(tmpDir, `in_${idx}.${t.origExt}`);
          fs.writeFileSync(tmpIn, origBuf);

          let res = null;
          try {
            if (t.kind === 'video') {
              res = await compressEmbeddedVideoFile(taskId, tmpIn, { maxSide, preset }, tmpDir, idx);
            } else {
              res = await compressRasterFile(taskId, tmpIn, t.origExt, { maxSide, preset, formatMode }, tmpDir, idx);
            }
          } catch (err) {
            if (err.message === '任务已取消') throw err;
            res = null;
          }
          results[idx] = res;
          completedCount++;
          onProgress?.(0.08 + (0.86 * completedCount) / targets.length);
        };

        const imageIndices = [];
        const videoIndices = [];
        for (let i = 0; i < targets.length; i++) {
          if (targets[i].kind === 'video') videoIndices.push(i);
          else imageIndices.push(i);
        }

        await runWithConcurrency(imageIndices, 3, processOne);
        for (const vIdx of videoIndices) {
          await processOne(vIdx);
        }

        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          const origBuf = origBufs[i];
          const res = results[i];

          if (!res || !res.buf || res.buf.length >= origBuf.length) {
            skippedCount++;
          } else {
            compressedCount++;
            if (t.kind === 'video') videoCompressedCount++;
            usedExts.add(res.ext);
            const normOldExt = t.origExt === 'jpeg' ? 'jpg' : t.origExt;
            if (res.ext === normOldExt || (res.ext === 'jpg' && t.origExt === 'jpeg')) {
              zip.updateFile(t.entry.entryName, res.buf);
            } else {
              const oldBase = path.posix.basename(t.entryName, path.posix.extname(t.entryName));
              usedMediaSet.delete(t.entryName.toLowerCase());
              const newEntryName = allocUniqueMediaEntry(usedMediaSet, `${oldBase}.${res.ext}`, mediaPrefix);
              zip.deleteFile(t.entry.entryName);
              zip.addFile(newEntryName, res.buf);
              renameMap.set(t.entryName, newEntryName);
            }
          }
        }

        if (renameMap.size) {
          rewriteDocxMediaTargets(zip, renameMap);
          ensureDocxContentTypes(zip, [...usedExts], renameMap);
        }

        fs.mkdirSync(path.dirname(output), { recursive: true });
        writeTaskOutput(output, zip.toBuffer());
        onProgress?.(1);

        const newSize = fs.statSync(output).size;
        return {
          output,
          docCompressSummary: {
            docType: isPpt ? 'pptx' : 'docx',
            totalMedia: targets.length,
            compressedCount,
            videoCompressedCount,
            skippedCount,
            origSize,
            newSize,
            sectionFiltered,
            sectionTitles: sectionTitlesUsed,
          },
        };
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    },
  };
}

function docRepackImages(p) {
  const ext = path.extname(String(p.input || '')).slice(1).toLowerCase();
  if (ext === 'doc') {
    throw new Error('暂不支持旧版 .doc 二进制格式，请先另存为 .docx');
  }
  if (ext === 'ppt') {
    throw new Error('暂不支持旧版 .ppt 二进制格式，请先另存为 .pptx');
  }
  const isPpt = ext === 'pptx';
  const docLabel = isPpt ? 'PPT' : 'Word';
  const mediaPrefix = isPpt ? 'ppt/media' : 'word/media';
  const mediaRe = isPpt ? /^ppt\/media\//i : /^word\/media\//i;
  const output = p.output || defaultOutput(p.input, '已回填', isPpt ? 'pptx' : 'docx', p);
  const replaceDir = p.replaceDir || '';
  const replaceFiles = Array.isArray(p.replaceFiles) ? p.replaceFiles : [];
  const sizeMode = p.sizeMode || 'keepWidth';
  if (!replaceDir && !replaceFiles.length) {
    throw new Error('请先选择修改/压缩后的图片文件夹或图片文件');
  }

  return {
    output,
    async run(taskId, onProgress) {
      onProgress?.(0.06);
      const AdmZip = require('adm-zip');
      let zip;
      try {
        zip = new AdmZip(p.input);
      } catch {
        throw new Error(`无法解析该 .${isPpt ? 'pptx' : 'docx'} 文件（可能已损坏或并非标准 ${docLabel} 文档）`);
      }

      const candidates = collectCandidateImages(replaceDir, replaceFiles);
      if (!candidates.length) {
        throw new Error('所选文件夹或列表中未找到可用的图片文件');
      }

      const manifest = readManifestNear(replaceDir, replaceFiles);
      const manifestCreatedAt = manifest?.createdAt || 0;
      const manifestByEntry = new Map();
      const manifestStemSet = new Set();
      const manifestFileSet = new Set();
      for (const m of manifest?.items || []) {
        if (m.entryName) manifestByEntry.set(m.entryName.toLowerCase(), m);
        if (m.stem) manifestStemSet.add(m.stem.toLowerCase());
        if (m.savedName) manifestFileSet.add(m.savedName.toLowerCase());
      }
      const isCandOwnedByManifest = (cFileLower, cStemLower) => {
        if (manifestFileSet.has(cFileLower) || manifestStemSet.has(cStemLower)) return true;
        for (const ms of manifestStemSet) {
          if (cStemLower.startsWith(`${ms}_`) || cStemLower.startsWith(`${ms}-`)) return true;
        }
        return false;
      };

      const mediaEntries = [];
      const usedMediaSet = new Set();
      for (const e of zip.getEntries()) {
        const entryName = String(e.entryName || '').replace(/\\/g, '/');
        if (e.isDirectory || !mediaRe.test(entryName)) continue;
        usedMediaSet.add(entryName.toLowerCase());
        mediaEntries.push({ entry: e, entryName, filename: path.posix.basename(entryName) });
      }

      if (!mediaEntries.length) {
        throw new Error(`目标 ${docLabel} 文档中不包含 ${mediaPrefix} 图片资源`);
      }

      const scoreCandidateForEntry = (cand, me, mInfo) => {
        const cStemLower = cand.stem.toLowerCase();
        const cFileLower = cand.filename.toLowerCase();
        const mStem = mInfo?.stem?.toLowerCase();
        const mSaved = mInfo?.savedName?.toLowerCase();
        const origStem = path.posix.basename(me.filename, path.posix.extname(me.filename)).toLowerCase();
        const origFile = me.filename.toLowerCase();

        let matchTier = 0;
        if (mInfo) {
          if (cFileLower === mSaved) matchTier = 2; // 未改名原提取文件
          else if (cStemLower === mStem) matchTier = 3; // 同前缀换了扩展名（如 .png -> .jpg）
          else if (cStemLower.startsWith(`${mStem}_`) || cStemLower.startsWith(`${mStem}-`)) matchTier = 4; // 压缩/处理输出后缀
        }
        if (!matchTier && !(manifestByEntry.size > 0 && !mInfo && isCandOwnedByManifest(cFileLower, cStemLower))) {
          if (cFileLower === origFile) matchTier = 2;
          else if (cStemLower === origStem || cStemLower.startsWith(`${origStem}_`)) matchTier = 3;
          else {
            const stripped = cStemLower.replace(/^\d+_/, '');
            if (stripped === origStem || stripped.startsWith(`${origStem}_`)) matchTier = 3;
          }
        }
        if (!matchTier) return 0;

        // 同级优先：显式传入/output子目录 > 修改时间更新 > 文件名匹配度
        const modifiedBonus = manifestCreatedAt && cand.mtimeMs > manifestCreatedAt + 500 ? 10 : 0;
        return matchTier * 100 + cand.priorityBoost * 20 + modifiedBonus;
      };

      const matches = [];
      for (const me of mediaEntries) {
        const mInfo = manifestByEntry.get(me.entryName.toLowerCase());
        let best = null;
        let bestScore = 0;
        for (const cand of candidates) {
          const s = scoreCandidateForEntry(cand, me, mInfo);
          if (s > bestScore || (s === bestScore && best && cand.mtimeMs > best.mtimeMs)) {
            best = cand;
            bestScore = s;
          }
        }
        if (best) matches.push({ media: me, cand: best });
      }

      if (!matches.length) {
        throw new Error(`未能将所选图片匹配回 ${docLabel} 内的原有图片（请确保保留了提取时的文件名前缀，如 01_image1）`);
      }

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_doc_repack_'));
      const renameMap = new Map();
      const sizeMapByEntry = new Map();
      const usedExts = new Set();
      let replacedCount = 0;
      let unchangedCount = 0;
      let resizedCount = 0;

      try {
        for (let i = 0; i < matches.length; i++) {
          const { media, cand } = matches[i];
          const origBuf = media.entry.getData();
          let newBuf = fs.readFileSync(cand.path);
          let newExt = cand.ext === 'jpeg' ? 'jpg' : cand.ext;
          let probedInfo = null;

          // 若工具输出了 WebP / AVIF，自动转为 Office 原生兼容的 PNG/JPG
          if (!WORD_SAFE_EXTS.has(newExt)) {
            probedInfo = await probe(cand.path);
            const hasAlpha = isAlphaPixFmt(probedInfo.pixFmt);
            newExt = hasAlpha ? 'png' : 'jpg';
            const tmpOut = path.join(tmpDir, `repack_${i}.${newExt}`);
            const args = ['-i', cand.path];
            if (newExt === 'jpg') {
              args.push('-vf', 'format=rgb24', ...imageCodecArgs('jpg', { qv: 3 }));
            } else {
              args.push('-c:v', 'png', '-compression_level', '9', '-update', '1', '-frames:v', '1');
            }
            args.push(tmpOut);
            await runFfmpeg(taskId, args, { totalDuration: 0 });
            newBuf = fs.readFileSync(tmpOut);
          }

          const origExt = path.posix.extname(media.entryName).slice(1).toLowerCase();
          const normOrigExt = origExt === 'jpeg' ? 'jpg' : origExt;
          if (newExt === normOrigExt && newBuf.equals(origBuf)) {
            unchangedCount++;
          } else {
            replacedCount++;
            usedExts.add(newExt);
            if (sizeMode === 'keepWidth') {
              try {
                const dimInfo = probedInfo || await probe(cand.path);
                if (dimInfo?.width > 0 && dimInfo?.height > 0) {
                  sizeMapByEntry.set(media.entryName.toLowerCase(), {
                    width: dimInfo.width,
                    height: dimInfo.height,
                  });
                }
              } catch {}
            }
            if (newExt === normOrigExt || (newExt === 'jpg' && origExt === 'jpeg')) {
              zip.updateFile(media.entry.entryName, newBuf);
            } else {
              const oldBase = path.posix.basename(media.entryName, path.posix.extname(media.entryName));
              usedMediaSet.delete(media.entryName.toLowerCase());
              const newEntryName = allocUniqueMediaEntry(usedMediaSet, `${oldBase}.${newExt}`, mediaPrefix);
              zip.deleteFile(media.entry.entryName);
              zip.addFile(newEntryName, newBuf);
              renameMap.set(media.entryName, newEntryName);
            }
          }

          onProgress?.(0.1 + (0.85 * (i + 1)) / matches.length);
        }

        if (sizeMode === 'keepWidth' && sizeMapByEntry.size) {
          resizedCount = updateOoxmlImageSizesKeepWidth(zip, sizeMapByEntry);
        }

        if (renameMap.size) {
          rewriteDocxMediaTargets(zip, renameMap);
          ensureDocxContentTypes(zip, [...usedExts], renameMap);
        }

        fs.mkdirSync(path.dirname(output), { recursive: true });
        writeTaskOutput(output, zip.toBuffer());
        onProgress?.(1);

        const origSize = fs.statSync(p.input).size;
        const newSize = fs.statSync(output).size;
        return {
          output,
          docRepackSummary: {
            docType: isPpt ? 'pptx' : 'docx',
            matchedCount: matches.length,
            replacedCount,
            unchangedCount,
            resizedCount,
            sizeMode,
            origSize,
            newSize,
          },
        };
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Word / PPT 清理冗余孤立媒体与重复图片去重
// ---------------------------------------------------------------------------
function docCleanupMedia(p) {
  const ext = path.extname(String(p.input || '')).slice(1).toLowerCase();
  if (ext === 'doc') {
    throw new Error('暂不支持旧版 .doc 二进制格式，请在 Word/WPS 中「另存为 .docx」后再清理');
  }
  if (ext === 'ppt') {
    throw new Error('暂不支持旧版 .ppt 二进制格式，请在 PowerPoint/WPS 中「另存为 .pptx」后再清理');
  }
  const isPpt = ext === 'pptx';
  const docLabel = isPpt ? 'PPT' : 'Word';
  const mediaPrefix = isPpt ? 'ppt/media' : 'word/media';
  const mediaRe = isPpt ? /^ppt\/media\//i : /^word\/media\//i;
  const output = p.output || defaultOutput(p.input, '已清理', isPpt ? 'pptx' : 'docx');
  const removeOrphans = p.removeOrphans !== false && p.removeOrphans !== 'no' && p.removeOrphans !== 'false';
  const dedupeMedia = p.dedupeMedia !== false && p.dedupeMedia !== 'no' && p.dedupeMedia !== 'false';

  if (!removeOrphans && !dedupeMedia) {
    throw new Error('请至少启用“清理孤立媒体”或“重复媒体去重”中的一项');
  }

  return {
    output,
    async run(_taskId, onProgress) {
      onProgress?.(0.08);
      const AdmZip = require('adm-zip');
      let zip;
      try {
        zip = new AdmZip(p.input);
      } catch {
        throw new Error(`无法解析该 .${isPpt ? 'pptx' : 'docx'} 文件（可能已损坏或并非标准 ${docLabel} 文档）`);
      }

      const origSize = fs.statSync(p.input).size;
      const mediaEntries = zip.getEntries()
        .filter((e) => !e.isDirectory && mediaRe.test(String(e.entryName || '').replace(/\\/g, '/')))
        .sort((a, b) => String(a.entryName).localeCompare(String(b.entryName), undefined, { numeric: true, sensitivity: 'base' }));

      if (!mediaEntries.length) {
        throw new Error(`该 ${docLabel} 文档中不包含任何 ${mediaPrefix} 媒体资源`);
      }

      const referencedSet = findReferencedOoxmlMedia(zip, mediaPrefix);
      const deletedPaths = [];
      const renameMap = new Map();
      const seenHashes = new Map();
      let orphanCount = 0;
      let dedupeCount = 0;
      let freedBytes = 0;

      for (let i = 0; i < mediaEntries.length; i++) {
        const e = mediaEntries[i];
        const entryName = String(e.entryName || '').replace(/\\/g, '/');
        const buf = e.getData();

        if (removeOrphans && !referencedSet.has(entryName.toLowerCase())) {
          zip.deleteFile(e.entryName);
          deletedPaths.push(entryName);
          orphanCount++;
          freedBytes += buf.length;
        } else if (dedupeMedia) {
          const mExt = path.posix.extname(entryName).slice(1).toLowerCase();
          const normExt = mExt === 'jpeg' ? 'jpg' : mExt;
          const hash = crypto.createHash('sha256').update(buf).digest('hex');
          const key = `${hash}:${normExt}`;
          const canonical = seenHashes.get(key);
          if (canonical) {
            zip.deleteFile(e.entryName);
            deletedPaths.push(entryName);
            renameMap.set(entryName, canonical);
            dedupeCount++;
            freedBytes += buf.length;
          } else {
            seenHashes.set(key, entryName);
          }
        }
        onProgress?.(0.15 + (0.72 * (i + 1)) / mediaEntries.length);
      }

      if (renameMap.size) {
        rewriteDocxMediaTargets(zip, renameMap);
      }
      if (deletedPaths.length) {
        removeDocxContentTypeOverrides(zip, deletedPaths);
      }

      fs.mkdirSync(path.dirname(output), { recursive: true });
      writeTaskOutput(output, zip.toBuffer());
      onProgress?.(1);

      const newSize = fs.statSync(output).size;
      return {
        output,
        docCleanupSummary: {
          docType: isPpt ? 'pptx' : 'docx',
          totalBefore: mediaEntries.length,
          totalAfter: mediaEntries.length - deletedPaths.length,
          orphanCount,
          dedupeCount,
          freedBytes,
          origSize,
          newSize,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Word / PPT 图片统一美化（圆角 / 边框 / 文字水印，支持指定章节）
// ---------------------------------------------------------------------------
function docStyleImages(p) {
  const ext = path.extname(String(p.input || '')).slice(1).toLowerCase();
  if (ext === 'doc') {
    throw new Error('暂不支持旧版 .doc 二进制格式，请在 Word/WPS 中「另存为 .docx」后再处理');
  }
  if (ext === 'ppt') {
    throw new Error('暂不支持旧版 .ppt 二进制格式，请在 PowerPoint/WPS 中「另存为 .pptx」后再处理');
  }
  const isPpt = ext === 'pptx';
  const docLabel = isPpt ? 'PPT' : 'Word';
  const mediaPrefix = isPpt ? 'ppt/media' : 'word/media';
  const mediaRe = isPpt ? /^ppt\/media\//i : /^word\/media\//i;
  const output = p.output || defaultOutput(p.input, '已美化', isPpt ? 'pptx' : 'docx');

  const wmText = String(p.wmText || '').trim();
  const wmPos = ['tl', 'tr', 'bl', 'br', 'center'].includes(p.wmPos) ? p.wmPos : 'br';
  const wmSize = ['small', 'medium', 'large'].includes(p.wmSize) ? p.wmSize : 'medium';
  const wmOpacity = Math.min(Math.max(num(p.wmOpacity, 0.45), 0.1), 1).toFixed(2);
  const wmColor = ['white', 'black', 'gray'].includes(p.wmColor) ? p.wmColor : 'white';
  const frameMode = ['none', 'rounded', 'roundedBorder', 'border'].includes(p.frameMode) ? p.frameMode : 'rounded';
  const radiusRaw = Math.min(Math.max(Math.round(num(p.radius, 24)), 2), 300);
  const borderWidth = (frameMode === 'border' || frameMode === 'roundedBorder')
    ? Math.min(Math.max(Math.round(num(p.borderWidth, 16)), 2), 200)
    : 0;
  const borderHex = normalizeHexColor(p.borderColor, 'ffffff');
  const sectionIds = Array.isArray(p.sectionIds) ? p.sectionIds.filter(Boolean) : [];
  const sectionKeyword = String(p.sectionKeyword || '').trim().toLowerCase();

  if (!wmText && frameMode === 'none') {
    throw new Error('请输入水印文字，或选择圆角 / 边框美化效果');
  }

  return {
    output,
    async run(taskId, onProgress) {
      onProgress?.(0.05);
      let selectedEntrySet = null;
      let sectionFiltered = false;
      let sectionTitlesUsed = [];

      if (sectionIds.length || sectionKeyword) {
        const parsed = inspectDocument(p.input);
        const filtered = filterDocumentItemsBySection(parsed, sectionIds, sectionKeyword);
        sectionFiltered = filtered.sectionFiltered;
        sectionTitlesUsed = filtered.sectionTitlesUsed;
        if (!filtered.items.length) {
          throw new Error('所选章节或页面中未找到任何图片资源');
        }
        selectedEntrySet = new Set(
          filtered.items
            .map((it) => String(it.entryName || '').toLowerCase())
            .filter(Boolean),
        );
      }

      const AdmZip = require('adm-zip');
      let zip;
      try {
        zip = new AdmZip(p.input);
      } catch {
        throw new Error(`无法解析该 .${isPpt ? 'pptx' : 'docx'} 文件（可能已损坏或并非标准 ${docLabel} 文档）`);
      }

      const origSize = fs.statSync(p.input).size;
      const usedMediaSet = new Set();
      const targets = [];

      for (const e of zip.getEntries()) {
        const entryName = String(e.entryName || '').replace(/\\/g, '/');
        if (e.isDirectory || !mediaRe.test(entryName)) continue;
        usedMediaSet.add(entryName.toLowerCase());
        if (selectedEntrySet && !selectedEntrySet.has(entryName.toLowerCase())) continue;
        const mExt = path.posix.extname(entryName).slice(1).toLowerCase();
        if (e.header.size > 0 && RASTER_MEDIA_EXTS.has(mExt)) {
          targets.push({ entry: e, entryName, origExt: mExt });
        }
      }

      if (!targets.length) {
        throw new Error(sectionFiltered
          ? '所选章节或页面中未找到可美化的位图图片'
          : `该 ${docLabel} 文档内未找到可美化的位图图片（可能仅含文字或 EMF/WMF 矢量图）`);
      }

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_doc_style_'));
      const renameMap = new Map();
      const sizeMapByEntry = new Map();
      const usedExts = new Set();
      let styledCount = 0;

      let wmTextFile = '';
      let wmTextFileArg = '';
      if (wmText) {
        wmTextFile = path.join(tmpDir, 'watermark.txt');
        fs.writeFileSync(wmTextFile, wmText, 'utf8');
        wmTextFileArg = wmTextFile.replace(/\\/g, '/').replace(/:/g, '\\:');
      }

      try {
        const origBufs = targets.map((t) => t.entry.getData());
        const results = new Array(targets.length).fill(null);
        let completedCount = 0;

        await runWithConcurrency(
          targets.map((_, idx) => idx),
          3,
          async (i) => {
            const t = targets[i];
            const tmpIn = path.join(tmpDir, `in_${i}.${t.origExt}`);
            fs.writeFileSync(tmpIn, origBufs[i]);

            let info;
            try {
              info = await probe(tmpIn);
            } catch {
              info = null;
            }
            const W = info?.width || 0;
            const H = info?.height || 0;
            if (W < 8 || H < 8) {
              completedCount++;
              onProgress?.(0.08 + (0.84 * completedCount) / targets.length);
              return;
            }

            const normOrigExt = t.origExt === 'jpeg' ? 'jpg' : t.origExt;
            const needRounded = frameMode === 'rounded' || frameMode === 'roundedBorder';
            const needTransparentCorners = frameMode === 'rounded';
            const origHasAlpha = normOrigExt === 'png' && isAlphaPixFmt(info.pixFmt);

            let outExt;
            if (needTransparentCorners) {
              outExt = 'png';
            } else if (WORD_SAFE_EXTS.has(normOrigExt)) {
              outExt = normOrigExt;
            } else {
              outExt = origHasAlpha ? 'png' : 'jpg';
            }

            const outPath = path.join(tmpDir, `out_${i}.${outExt}`);
            const extraInputs = [];
            let chain = '[0:v]setsar=1,format=rgba[v0]';
            let last = 'v0';

            if (wmText) {
              const sizeK = { small: 26, medium: 17, large: 11 }[wmSize] || 17;
              const fontsize = Math.max(14, Math.min(72, Math.round(Math.min(W, H) / sizeK)));
              const margin = Math.max(10, Math.round(fontsize * 0.6));
              const posExpr = {
                tl: `x=${margin}:y=${margin}`,
                tr: `x=w-text_w-${margin}:y=${margin}`,
                bl: `x=${margin}:y=h-text_h-${margin}`,
                br: `x=w-text_w-${margin}:y=h-text_h-${margin}`,
                center: 'x=(w-text_w)/2:y=(h-text_h)/2',
              }[wmPos] || `x=w-text_w-${margin}:y=h-text_h-${margin}`;

              const borderOp = Math.min(1, Number(wmOpacity) * 0.75).toFixed(2);
              const colorArgs = wmColor === 'black'
                ? `fontcolor=black@${wmOpacity}:borderw=1:bordercolor=white@${borderOp}`
                : (wmColor === 'gray'
                  ? `fontcolor=#e2e8f0@${wmOpacity}:borderw=2:bordercolor=black@${borderOp}`
                  : `fontcolor=white@${wmOpacity}:borderw=2:bordercolor=black@${borderOp}`);

              chain += `;[${last}]drawtext=fontfile='${FONT}':textfile='${wmTextFileArg}':fontsize=${fontsize}:${colorArgs}:${posExpr}:expansion=none[vwm]`;
              last = 'vwm';
            }

            if (needRounded) {
              const r = Math.min(radiusRaw, Math.floor(Math.min(W, H) / 2));
              const maskFile = path.join(tmpDir, `mask_${i}.pgm`);
              writeRoundedMaskPgm(maskFile, W, H, r);
              extraInputs.push('-i', maskFile);
              chain += `;[1:v]format=gray[msk];[${last}][msk]alphamerge[vrnd]`;
              last = 'vrnd';
            }

            const outW = W + borderWidth * 2;
            const outH = H + borderWidth * 2;
            if (borderWidth > 0) {
              chain += `;[${last}]pad=${outW}:${outH}:${borderWidth}:${borderWidth}:color=0x${borderHex}ff[vpad]`;
              last = 'vpad';
              // 边框模式为纯色背景，把内侧圆角透明区域也用边框色铺平，视觉如相框
              chain += `;[${last}]format=rgba,split[__fg][__bgsrc];[__bgsrc]drawbox=x=0:y=0:w=iw:h=ih:color=0x${borderHex}@1:t=fill[__bg];[__bg][__fg]overlay=0:0:shortest=1[vflat]`;
              last = 'vflat';
            }

            if (outExt === 'jpg' || outExt === 'bmp') {
              chain += `;[${last}]format=rgba,split[__jfg][__jbgsrc];[__jbgsrc]drawbox=x=0:y=0:w=iw:h=ih:color=0x${borderWidth > 0 ? borderHex : 'ffffff'}@1:t=fill[__jbg];[__jbg][__jfg]overlay=0:0:shortest=1,format=rgb24[vout]`;
            } else {
              chain += `;[${last}]format=rgba[vout]`;
            }

            await runFfmpeg(taskId, [
              '-i', tmpIn,
              ...extraInputs,
              '-filter_complex', chain,
              '-map', '[vout]',
              '-map_metadata', '-1',
              ...imageCodecArgs(outExt, { quality: 'high' }),
              outPath,
            ], { totalDuration: 0 });

            results[i] = {
              newBuf: fs.readFileSync(outPath),
              outExt,
              normOrigExt,
              outW,
              outH,
            };
            completedCount++;
            onProgress?.(0.08 + (0.84 * completedCount) / targets.length);
          },
        );

        for (let i = 0; i < targets.length; i++) {
          const itemRes = results[i];
          if (!itemRes) continue;
          const t = targets[i];
          const { newBuf, outExt, normOrigExt, outW, outH } = itemRes;

          styledCount++;
          usedExts.add(outExt);

          if (borderWidth > 0) {
            sizeMapByEntry.set(t.entryName.toLowerCase(), { width: outW, height: outH });
          }

          if (outExt === normOrigExt || (outExt === 'jpg' && t.origExt === 'jpeg')) {
            zip.updateFile(t.entry.entryName, newBuf);
          } else {
            const oldBase = path.posix.basename(t.entryName, path.posix.extname(t.entryName));
            usedMediaSet.delete(t.entryName.toLowerCase());
            const newEntryName = allocUniqueMediaEntry(usedMediaSet, `${oldBase}.${outExt}`, mediaPrefix);
            zip.deleteFile(t.entry.entryName);
            zip.addFile(newEntryName, newBuf);
            renameMap.set(t.entryName, newEntryName);
          }
        }

        if (!styledCount) {
          throw new Error('未能处理任何有效位图图片（可能图片尺寸过小或已损坏）');
        }

        if (sizeMapByEntry.size) {
          updateOoxmlImageSizesKeepWidth(zip, sizeMapByEntry);
        }
        if (renameMap.size) {
          rewriteDocxMediaTargets(zip, renameMap);
          ensureDocxContentTypes(zip, [...usedExts], renameMap);
        }

        fs.mkdirSync(path.dirname(output), { recursive: true });
        writeTaskOutput(output, zip.toBuffer());
        onProgress?.(1);

        const newSize = fs.statSync(output).size;
        return {
          output,
          docStyleSummary: {
            docType: isPpt ? 'pptx' : 'docx',
            styledCount,
            totalImages: targets.length,
            watermarked: !!wmText,
            frameMode,
            sectionFiltered,
            sectionTitles: sectionTitlesUsed,
            origSize,
            newSize,
          },
        };
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 6. Markdown 图片整理（一键本地化 / 转 Base64 内嵌 / 清理未使用图）
// ---------------------------------------------------------------------------
const EXT_TO_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

const ASSET_IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|tiff?)$/i;

function isSubPath(parentDir, childPath) {
  const rel = path.relative(path.resolve(parentDir), path.resolve(childPath));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function listImagesInAssetDir(rootDir) {
  const results = [];
  const skipDirNames = new Set(['_已清理冗余', 'output', '.git', 'node_modules']);
  const walk = (cur) => {
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (!skipDirNames.has(ent.name) && !ent.name.startsWith('.')) walk(full);
      } else if (ent.isFile() && ASSET_IMG_EXT_RE.test(ent.name)) {
        results.push(path.resolve(full));
      }
    }
  };
  walk(rootDir);
  return results;
}

function mdOrganizeImages(p) {
  const ext = path.extname(String(p.input || '')).slice(1).toLowerCase();
  if (ext !== 'md' && ext !== 'markdown') {
    throw new Error('仅支持 Markdown (.md / .markdown) 文件');
  }
  const action = ['localize', 'inlineBase64', 'cleanUnused'].includes(p.action) ? p.action : 'localize';
  const assetsDirName = sanitizeBase(p.assetsDirName || 'assets', 'assets').replace(/\s+/g, '_') || 'assets';
  const remoteMode = p.remoteMode === 'skip' ? 'skip' : 'download';
  const inlineSvgMode = p.inlineSvgMode === 'keep' ? 'keep' : 'extract';
  const cleanAction = p.cleanAction === 'delete' ? 'delete' : 'move';

  let defaultSuffix = '已本地化';
  if (action === 'inlineBase64') defaultSuffix = '内嵌图';
  else if (action === 'cleanUnused') defaultSuffix = '已清理';

  const output = action === 'cleanUnused'
    ? (p.output || p.input)
    : (p.output || defaultOutput(p.input, defaultSuffix, ext));

  return {
    output,
    async run(_taskId, onProgress) {
      onProgress?.(0.08);

      if (action === 'cleanUnused') {
        const parsed = inspectDocument(p.input);
        const mdDir = path.dirname(path.resolve(p.input));
        const mdStem = path.basename(p.input, path.extname(p.input));

        const referencedSet = new Set();
        const assetRoots = new Set();

        for (const item of parsed.items || []) {
          if (item.kind === 'local' && item.exists && item.resolvedPath) {
            const abs = path.resolve(item.resolvedPath);
            referencedSet.add(abs.toLowerCase());
            const itemDir = path.dirname(abs);
            if (isSubPath(mdDir, itemDir)) {
              const relSeg = path.relative(mdDir, itemDir).split(path.sep)[0];
              if (relSeg && relSeg !== '_已清理冗余' && relSeg !== 'output') {
                assetRoots.add(path.join(mdDir, relSeg));
              }
            }
          }
        }

        for (const candName of ['assets', 'images', 'img', 'media', `${mdStem}.assets`, `${mdStem}_assets`]) {
          const candDir = path.join(mdDir, candName);
          try {
            if (fs.existsSync(candDir) && fs.statSync(candDir).isDirectory()) {
              assetRoots.add(path.resolve(candDir));
            }
          } catch {}
        }

        if (!assetRoots.size) {
          throw new Error('未在文档同级目录发现资源子文件夹（如 assets / images / .assets），为保护同级其他文件不会扫描文档根目录');
        }

        const diskImages = [];
        for (const root of assetRoots) {
          diskImages.push(...listImagesInAssetDir(root));
        }

        const unused = diskImages.filter((fp) => !referencedSet.has(fp.toLowerCase()));
        let freedBytes = 0;
        let trashDir = '';
        let cleanedCount = 0;

        for (let i = 0; i < unused.length; i++) {
          const src = unused[i];
          const sz = (() => { try { return fs.statSync(src).size; } catch { return 0; } })();
          freedBytes += sz;
          if (cleanAction === 'delete') {
            fs.unlinkSync(src);
          } else {
            if (!trashDir) {
              trashDir = path.join(mdDir, '_已清理冗余');
              fs.mkdirSync(trashDir, { recursive: true });
            }
            const stem = path.basename(src, path.extname(src));
            const fExt = path.extname(src).slice(1);
            const dest = allocUniquePath(trashDir, stem, fExt, new Set());
            fs.renameSync(src, dest);
          }
          cleanedCount++;
          onProgress?.(0.2 + (0.7 * (i + 1)) / Math.max(1, unused.length));
        }

        if (output !== p.input) {
          fs.mkdirSync(path.dirname(output), { recursive: true });
          copyTaskOutput(p.input, output);
        }
        onProgress?.(1);

        return {
          output,
          mdOrganizeSummary: {
            action,
            cleanAction,
            scannedCount: diskImages.length,
            cleanedCount,
            freedBytes,
            trashDir,
          },
        };
      }

      // action === 'localize' | 'inlineBase64'
      const scan = scanMarkdownForRewrite(p.input);
      const tokens = scan.tokens || [];
      if (!tokens.length) {
        throw new Error('该 Markdown 文档中未识别到任何图片');
      }

      const outDir = path.dirname(path.resolve(output));
      const targetAssetsDir = path.join(outDir, assetsDirName);
      const usedAssetNames = new Set();
      const dedupeLocalMap = new Map();
      const remoteCache = new Map();
      const patches = [];

      let rewrittenCount = 0;
      let downloadedCount = 0;
      let copiedLocalCount = 0;
      let decodedDataCount = 0;
      let extractedSvgCount = 0;
      let failedRemote = 0;
      let missingLocal = 0;

      const formatPatchReplacement = (tok, nextUrl) => {
        if (tok.kind === 'inlineSvg') {
          return `![${tok.alt || 'inline-svg'}](${nextUrl})`;
        }
        if (tok.source === 'html-img' && tok.needsQuotes) {
          return `"${nextUrl}"`;
        }
        if ((tok.source === 'markdown' || tok.source === 'md-ref-def') && tok.wrapAngle) {
          return `<${nextUrl}>`;
        }
        return nextUrl;
      };

      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        const item = tok.item;
        onProgress?.(0.1 + (0.82 * (i + 1)) / tokens.length);

        let buf = null;
        let itemExt = item.ext || 'png';
        let mime = EXT_TO_MIME[itemExt] || 'image/png';

        if (item.kind === 'local') {
          if (!item.exists || !item.resolvedPath) {
            missingLocal++;
            continue;
          }
          if (action === 'localize') {
            // 如果本地图已经在目标 assets 目录内，直接更新相对路径
            if (isSubPath(targetAssetsDir, item.resolvedPath) || path.dirname(path.resolve(item.resolvedPath)).toLowerCase() === path.resolve(targetAssetsDir).toLowerCase()) {
              const relPosix = path.relative(outDir, item.resolvedPath).replace(/\\/g, '/');
              patches.push({
                start: tok.replaceStart,
                end: tok.replaceEnd,
                replacement: formatPatchReplacement(tok, relPosix.includes(' ') && !tok.wrapAngle && tok.source !== 'html-img' ? `<${relPosix}>` : relPosix),
              });
              continue;
            }
            buf = fs.readFileSync(item.resolvedPath);
            const cacheKey = `local:${path.resolve(item.resolvedPath).toLowerCase()}`;
            if (dedupeLocalMap.has(cacheKey)) {
              const cachedRel = dedupeLocalMap.get(cacheKey);
              patches.push({ start: tok.replaceStart, end: tok.replaceEnd, replacement: formatPatchReplacement(tok, cachedRel) });
              rewrittenCount++;
              continue;
            }
          } else {
            buf = fs.readFileSync(item.resolvedPath);
            mime = EXT_TO_MIME[itemExt] || 'image/png';
          }
        } else if (item.kind === 'dataUri') {
          if (action === 'inlineBase64') continue; // 已是 Data URI
          buf = decodeDataUri(item);
          decodedDataCount++;
        } else if (item.kind === 'inlineSvg') {
          if (action === 'localize' && inlineSvgMode === 'keep') continue;
          buf = Buffer.from(item.svgCode, 'utf8');
          itemExt = 'svg';
          mime = 'image/svg+xml';
          if (action === 'localize') extractedSvgCount++;
        } else if (item.kind === 'remote') {
          if (remoteMode !== 'download') continue;
          const url = item.target;
          if (remoteCache.has(url)) {
            const cached = remoteCache.get(url);
            buf = cached.buf;
            itemExt = cached.ext;
            mime = cached.mime;
          } else {
            try {
              const dl = await downloadRemoteImage(url);
              buf = dl.buf;
              if (dl.extFromCt) itemExt = dl.extFromCt;
              mime = EXT_TO_MIME[itemExt] || 'image/png';
              remoteCache.set(url, { buf, ext: itemExt, mime });
              downloadedCount++;
            } catch {
              failedRemote++;
              continue;
            }
          }
        }

        if (!buf || !buf.length) continue;

        if (action === 'inlineBase64') {
          const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
          patches.push({
            start: tok.replaceStart,
            end: tok.replaceEnd,
            replacement: formatPatchReplacement(tok, dataUri),
          });
          rewrittenCount++;
        } else {
          fs.mkdirSync(targetAssetsDir, { recursive: true });
          const info = inferNameFromItem(item, i);
          const cleanStem = sanitizeBase(info.stem, `img_${i + 1}`).replace(/\s+/g, '_') || `img_${i + 1}`;
          const destPath = allocUniquePath(targetAssetsDir, cleanStem, itemExt, usedAssetNames);
          fs.writeFileSync(destPath, buf);
          if (item.kind === 'local') copiedLocalCount++;

          const relPosix = path.relative(outDir, destPath).replace(/\\/g, '/');
          if (item.kind === 'local' && item.resolvedPath) {
            dedupeLocalMap.set(`local:${path.resolve(item.resolvedPath).toLowerCase()}`, relPosix);
          } else if (item.kind === 'remote') {
            dedupeLocalMap.set(`remote:${item.target}`, relPosix);
          }

          patches.push({
            start: tok.replaceStart,
            end: tok.replaceEnd,
            replacement: formatPatchReplacement(tok, relPosix),
          });
          rewrittenCount++;
        }
      }

      const nextBody = applyTextReplacements(scan.raw, patches);
      fs.mkdirSync(outDir, { recursive: true });
      writeTaskOutput(output, (scan.hasBom ? '\uFEFF' : '') + nextBody);
      onProgress?.(1);

      return {
        output,
        mdOrganizeSummary: {
          action,
          totalFound: tokens.length,
          rewrittenCount,
          downloadedCount,
          copiedLocalCount,
          decodedDataCount,
          extractedSvgCount,
          failedRemote,
          missingLocal,
          assetsDir: action === 'localize' && rewrittenCount > 0 ? targetAssetsDir : '',
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 7. 多图合并为 PDF（纯 Node PDF 1.4 组装 + FFmpeg JPEG 归一化）
// ---------------------------------------------------------------------------
function imagesToPdf(p) {
  const files = Array.isArray(p.files) ? p.files.filter(Boolean) : [];
  if (!files.length) throw new Error('请至少选择 1 张图片');

  const pageSize = ['a4p', 'a4l', 'fit'].includes(p.pageSize) ? p.pageSize : 'a4p';
  const margin = Math.min(Math.max(Math.round(num(p.margin, 20)), 0), 120);
  const quality = ['high', 'medium', 'low'].includes(p.quality) ? p.quality : 'high';
  const qv = quality === 'low' ? 9 : (quality === 'medium' ? 5 : 2);
  const bgHex = normalizeHexColor(p.bgColor, 'ffffff');
  const output = p.output || stampOutput(files[0], '合并文档', 'pdf');

  return {
    output,
    async run(taskId, onProgress) {
      onProgress?.(0.05);
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_img_pdf_'));
      try {
        const pages = [];
        for (let i = 0; i < files.length; i++) {
          const src = files[i];
          const tmpJpg = path.join(tmpDir, `page_${i}.jpg`);
          await runFfmpeg(taskId, [
            '-i', src,
            '-filter_complex',
            `[0:v]setsar=1,format=rgba,split[__fg][__bgsrc];[__bgsrc]drawbox=x=0:y=0:w=iw:h=ih:color=0x${bgHex}@1:t=fill[__bg];[__bg][__fg]overlay=0:0:shortest=1,format=yuvj420p[vout]`,
            '-map', '[vout]',
            '-map_metadata', '-1',
            '-c:v', 'mjpeg',
            '-q:v', String(qv),
            '-update', '1',
            '-frames:v', '1',
            tmpJpg,
          ], { totalDuration: 0 });

          const jpgBuf = fs.readFileSync(tmpJpg);
          let dims = getJpegDimensions(jpgBuf);
          if (!dims) {
            const info = await probe(tmpJpg);
            dims = { width: info.width || 800, height: info.height || 600 };
          }
          pages.push({ jpgBuf, width: dims.width, height: dims.height });
          onProgress?.(0.08 + (0.8 * (i + 1)) / files.length);
        }

        const pdfBuf = buildPdfFromJpegPages(pages, { pageSize, margin });
        fs.mkdirSync(path.dirname(output), { recursive: true });
        writeTaskOutput(output, pdfBuf);
        onProgress?.(1);

        return {
          output,
          pdfSummary: {
            pageCount: pages.length,
            pageSize,
            outputSize: pdfBuf.length,
          },
        };
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 8. PDF 转图片（逐页导出 / 纵向拼接长图）
// ---------------------------------------------------------------------------
function readPngWidth(pngPath) {
  try {
    const fd = fs.openSync(pngPath, 'r');
    const hdr = Buffer.alloc(24);
    const bytesRead = fs.readSync(fd, hdr, 0, 24, 0);
    fs.closeSync(fd);
    if (bytesRead === 24 && hdr[0] === 0x89 && hdr[1] === 0x50 && hdr[2] === 0x4e && hdr[3] === 0x47) {
      return hdr.readUInt32BE(16);
    }
  } catch {}
  return 0;
}

function pdfToImages(p) {
  const ext = path.extname(String(p.input || '')).slice(1).toLowerCase();
  if (ext !== 'pdf') {
    throw new Error('请选择 PDF (.pdf) 文件');
  }
  const mode = p.mode === 'longImage' ? 'longImage' : 'pages';
  const format = ['png', 'jpg', 'webp'].includes(p.format) ? p.format : 'png';
  const dpiScale = Math.min(Math.max(num(p.dpiScale, 2), 1), 4);
  const pageRange = String(p.pageRange || '').trim();
  const gap = Math.min(Math.max(Math.round(num(p.gap, 0)), 0), 200);
  const output = mode === 'pages'
    ? (p.output || defaultDirOutput(p.input, 'PDF转图片'))
    : (p.output || defaultOutput(p.input, 'PDF长图', format));
  const outputType = mode === 'pages' ? 'dir' : 'file';

  return {
    output,
    outputType,
    async run(taskId, onProgress) {
      onProgress?.(0.03);
      const totalPages = await getPdfPageCount(p.input);
      throwIfTaskCancelled(taskId);
      const pages = parsePageRange(pageRange, totalPages);
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_pdf_img_'));

      try {
        const pngs = await renderPdfPagesToPngs(p.input, tmpDir, {
          pages,
          scale: dpiScale,
          taskId,
          onProgress: (r) => onProgress?.(0.05 + r * 0.65),
        });

        if (mode === 'pages') {
          fs.mkdirSync(output, { recursive: true });
          const padLen = Math.max(3, String(pngs.length).length);
          const outFiles = [];

          for (let i = 0; i < pngs.length; i++) {
            const dest = path.join(output, `${String(i + 1).padStart(padLen, '0')}.${format}`);
            if (format === 'png') {
              fs.copyFileSync(pngs[i], dest);
            } else if (format === 'jpg') {
              await runFfmpeg(taskId, [
                '-i', pngs[i],
                '-filter_complex',
                '[0:v]setsar=1,format=rgba,split[__fg][__bgsrc];[__bgsrc]drawbox=x=0:y=0:w=iw:h=ih:color=0xffffff@1:t=fill[__bg];[__bg][__fg]overlay=0:0:shortest=1:format=rgb,format=rgb24[vout]',
                '-map', '[vout]',
                '-map_metadata', '-1',
                ...imageCodecArgs('jpg', { quality: 'high' }),
                dest,
              ], { totalDuration: 0 });
            } else {
              await runFfmpeg(taskId, [
                '-i', pngs[i],
                '-vf', 'setsar=1,format=rgba',
                '-map_metadata', '-1',
                ...imageCodecArgs('webp', { quality: 'high' }),
                dest,
              ], { totalDuration: 0 });
            }
            outFiles.push(dest);
            onProgress?.(0.7 + (0.3 * (i + 1)) / pngs.length);
          }

          onProgress?.(1);
          return {
            output,
            outputType: 'dir',
            pdfToImagesSummary: {
              totalPages,
              exportedCount: outFiles.length,
              mode,
              format,
              files: outFiles,
            },
          };
        }

        // mode === 'longImage'
        const widths = [];
        for (const fp of pngs) {
          let w = readPngWidth(fp);
          if (!w) {
            const info = await probe(fp);
            w = info.width || 1000;
          }
          widths.push(w);
        }
        const maxW = Math.max(16, ...widths);

        const outExt = path.extname(output);
        const tmpOut = `${output.slice(0, output.length - outExt.length)}.tmp-${crypto.randomBytes(4).toString('hex')}${outExt}`;
        fs.mkdirSync(path.dirname(output), { recursive: true });

        try {
          const stitchList = async (items, targetPath, targetFmt, addTrailGapFlags) => {
            if (items.length === 1) {
              const args = ['-i', items[0]];
              if (targetFmt === 'jpg') {
                args.push(
                  '-filter_complex',
                  `[0:v]setsar=1,scale=${maxW}:-1:flags=lanczos,format=rgba,split[__fg][__bgsrc];[__bgsrc]drawbox=x=0:y=0:w=iw:h=ih:color=0xffffff@1:t=fill[__bg];[__bg][__fg]overlay=0:0:shortest=1:format=rgb,format=rgb24[vout]`,
                  '-map', '[vout]',
                );
              } else {
                args.push('-vf', `setsar=1,scale=${maxW}:-1:flags=lanczos,format=rgba`);
              }
              args.push('-map_metadata', '-1', ...imageCodecArgs(targetFmt, { quality: 'high' }), targetPath);
              await runFfmpeg(taskId, args, { totalDuration: 0 });
              return;
            }

            const inputArgs = [];
            const fcParts = [];
            const stackRefs = [];
            items.forEach((fp, idx) => {
              inputArgs.push('-i', fp);
              const padTail = addTrailGapFlags[idx] && gap > 0 ? `,pad=iw:ih+${gap}:0:0:color=0xffffff` : '';
              fcParts.push(
                `[${idx}:v]setsar=1,scale=${maxW}:-1:flags=lanczos,format=rgba,split[__fg${idx}][__bgsrc${idx}];[__bgsrc${idx}]drawbox=x=0:y=0:w=iw:h=ih:color=0xffffff@1:t=fill[__bg${idx}];[__bg${idx}][__fg${idx}]overlay=0:0:shortest=1:format=rgb${padTail}[p${idx}]`,
              );
              stackRefs.push(`[p${idx}]`);
            });
            const finalFmt = targetFmt === 'jpg' ? 'rgb24' : 'rgba';
            fcParts.push(`${stackRefs.join('')}vstack=inputs=${items.length},format=${finalFmt}[vout]`);
            await runFfmpeg(taskId, [
              ...inputArgs,
              '-filter_complex', fcParts.join(';'),
              '-map', '[vout]',
              '-map_metadata', '-1',
              ...imageCodecArgs(targetFmt, { quality: 'high' }),
              targetPath,
            ], { totalDuration: 0 });
          };

          const batchSize = 15;
          if (pngs.length <= batchSize) {
            const flags = pngs.map((_, idx) => idx < pngs.length - 1);
            await stitchList(pngs, tmpOut, format, flags);
          } else {
            let current = pngs.map((fp, idx) => ({ fp, needsGap: idx < pngs.length - 1 }));
            let round = 0;
            while (current.length > batchSize) {
              const next = [];
              for (let i = 0; i < current.length; i += batchSize) {
                const slice = current.slice(i, i + batchSize);
                const stripPath = path.join(tmpDir, `strip_${round}_${i}.png`);
                await stitchList(
                  slice.map((s) => s.fp),
                  stripPath,
                  'png',
                  slice.map((s) => s.needsGap),
                );
                next.push({ fp: stripPath, needsGap: false });
              }
              current = next;
              round++;
            }
            await stitchList(
              current.map((s) => s.fp),
              tmpOut,
              format,
              current.map((s) => s.needsGap),
            );
          }

          commitOutput(tmpOut, output);
          onProgress?.(1);
          return {
            output,
            outputType: 'file',
            pdfToImagesSummary: {
              totalPages,
              exportedCount: pngs.length,
              mode,
              format,
              files: [output],
            },
          };
        } finally {
          await fs.promises.rm(tmpOut, { force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
        }
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 9. PDF 合并
// ---------------------------------------------------------------------------
function pdfMerge(p) {
  const pages = p.pages;
  const files = Array.isArray(p.files) ? (pages === undefined ? p.files.filter(Boolean) : p.files) : [];
  if (pages === undefined && files.length < 2) {
    throw new Error('请至少选择 2 个 PDF 文件进行合并');
  }
  if (!files.length || files.some((file) => typeof file !== 'string' || path.extname(file).toLowerCase() !== '.pdf')) {
    throw new Error('请选择 PDF 文件');
  }
  const output = p.output || stampOutput(files[0], pages === undefined ? 'PDF合并' : 'PDF页面整理', 'pdf');
  if (files.some((file) => path.resolve(file).toLowerCase() === path.resolve(output).toLowerCase())) {
    throw new Error('输出文件不能与源 PDF 相同');
  }

  return {
    output,
    outputType: 'file',
    async run(taskId, onProgress) {
      const res = pages === undefined
        ? await mergePdfFiles(files, output, { taskId, onProgress })
        : await organizePdfPages(files, pages, output, { onProgress });
      return {
        output,
        outputType: 'file',
        pdfSummary: {
          action: pages === undefined ? 'merge' : 'organize',
          fileCount: files.length,
          pageCount: res.pageCount,
          outputSize: res.outputSize,
        },
      };
    },
  };
}

function pdfPreview(p) {
  if (typeof p.input !== 'string' || !path.isAbsolute(p.input) || path.extname(p.input).toLowerCase() !== '.pdf') {
    throw new Error('请选择 PDF 文件');
  }
  return {
    async run(taskId) {
      if (p.mode === 'count') {
        return { pdfPreviewSummary: { pageCount: await getPdfPageCount(p.input) } };
      }
      if (p.mode === 'crop') {
        const { previewPdfCrop } = require('../core/pdf-crop');
        const { image, bounds } = await previewPdfCrop(p.input, { taskId, page: p.page, padding: p.padding });
        return { pdfPreviewSummary: { image: `data:image/png;base64,${image.toString('base64')}`, bounds } };
      }
      if (!Array.isArray(p.pages) || !p.pages.length || p.pages.length > 6
        || p.pages.some((page) => !Number.isSafeInteger(page) || page < 1)) {
        throw new Error('缩略图页码无效');
      }
      const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vgt_pdf_previews_'));
      try {
        const paths = await renderPdfPagesToPngs(p.input, tmpDir, { pages: p.pages, previewSide: 300, taskId });
        const images = await Promise.all(paths.map(async (file) => `data:image/png;base64,${(await fs.promises.readFile(file)).toString('base64')}`));
        return { pdfPreviewSummary: { images } };
      } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 10. PDF 拆分 / 提取 / 删除指定页
// ---------------------------------------------------------------------------
function pdfSplit(p) {
  const ext = path.extname(String(p.input || '')).slice(1).toLowerCase();
  if (ext !== 'pdf') {
    throw new Error('请选择 PDF (.pdf) 文件');
  }
  const mode = ['extract', 'remove', 'burst'].includes(p.mode) ? p.mode : 'extract';
  const pageRange = String(p.pageRange || '').trim();
  const everyN = Math.max(1, Math.round(num(p.everyN, 1)));
  const output = mode === 'burst'
    ? (p.output || defaultDirOutput(p.input, 'PDF拆分'))
    : (p.output || defaultOutput(p.input, mode === 'remove' ? '删页' : '提取页', 'pdf'));
  const outputType = mode === 'burst' ? 'dir' : 'file';

  if (mode === 'extract' && !pageRange) {
    throw new Error('请输入要提取的页码范围（如 1-3, 5）');
  }
  if (mode === 'remove' && !pageRange) {
    throw new Error('请输入要删除的页码范围（如 2, 4-6）');
  }

  return {
    output,
    outputType,
    async run(taskId, onProgress) {
      onProgress?.(0.05);
      const totalPages = await getPdfPageCount(p.input);
      throwIfTaskCancelled(taskId);

      if (mode === 'extract') {
        const keepPages = parsePageRange(pageRange, totalPages);
        const res = await extractPdfPages(p.input, keepPages, output, { taskId, onProgress });
        return {
          output,
          outputType: 'file',
          pdfSummary: {
            action: mode,
            totalPages,
            pageCount: res.pageCount,
            fileCount: 1,
            outputSize: res.outputSize,
          },
        };
      }

      if (mode === 'remove') {
        const removeSet = new Set(parsePageRange(pageRange, totalPages));
        const keepPages = [];
        for (let i = 1; i <= totalPages; i++) {
          if (!removeSet.has(i)) keepPages.push(i);
        }
        if (!keepPages.length) {
          throw new Error('删除所选页码后没有剩余页面');
        }
        const res = await extractPdfPages(p.input, keepPages, output, { taskId, onProgress });
        return {
          output,
          outputType: 'file',
          pdfSummary: {
            action: mode,
            totalPages,
            pageCount: res.pageCount,
            fileCount: 1,
            outputSize: res.outputSize,
          },
        };
      }

      // mode === 'burst'
      const chunks = [];
      for (let i = 1; i <= totalPages; i += everyN) {
        const chunk = [];
        for (let j = i; j < i + everyN && j <= totalPages; j++) {
          chunk.push(j);
        }
        chunks.push(chunk);
      }
      const res = await splitPdfIntoChunks(p.input, chunks, output, { taskId, onProgress });
      onProgress?.(1);
      return {
        output,
        outputType: 'dir',
        pdfSummary: {
          action: mode,
          totalPages,
          pageCount: totalPages,
          fileCount: res.files.length,
          outputSize: res.totalSize,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 11. Markdown / HTML 转精美排版 PDF
// ---------------------------------------------------------------------------
function docToPdf(p) {
  const ext = path.extname(String(p.input || '')).slice(1).toLowerCase();
  if (!['md', 'markdown', 'html', 'htm'].includes(ext)) {
    throw new Error('请选择 Markdown (.md) 或 HTML (.html / .htm) 文件');
  }
  const theme = ['clean', 'github', 'warm', 'dark'].includes(p.theme) ? p.theme : 'clean';
  const pageSize = ['a4p', 'a4l', 'letter'].includes(p.pageSize) ? p.pageSize : 'a4p';
  const margin = ['narrow', 'normal', 'wide'].includes(p.margin) ? p.margin : 'normal';
  const pageNumbers = p.pageNumbers === 'yes' ? 'yes' : 'no';
  const output = p.output || defaultOutput(p.input, '排版PDF', 'pdf');

  return {
    output,
    outputType: 'file',
    async run(taskId, onProgress) {
      onProgress?.(0.15);
      const res = await convertDocToPdf(p.input, output, {
        theme,
        pageSize,
        margin,
        pageNumbers,
        taskId,
      });
      onProgress?.(1);
      return {
        output,
        outputType: 'file',
        docToPdfSummary: {
          title: res.title,
          theme,
          pageSize,
          margin,
          pageNumbers,
          outputSize: res.outputSize,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 12. Word (.docx / .doc) 转矢量 PDF（双引擎：本机 Office/WPS/LibreOffice + 内置排版引擎）
// ---------------------------------------------------------------------------
function wordToPdf(p) {
  const ext = path.extname(String(p.input || '')).slice(1).toLowerCase();
  if (ext !== 'docx' && ext !== 'doc') {
    throw new Error('请选择 Word (.docx / .doc) 文件');
  }
  const engine = ['auto', 'builtin', 'office'].includes(p.engine) ? p.engine : 'auto';
  const pageSize = ['auto', 'a4p', 'a4l', 'letter'].includes(p.pageSize) ? p.pageSize : 'auto';
  const margin = ['auto', 'narrow', 'normal', 'wide'].includes(p.margin) ? p.margin : 'auto';
  const pageNumbers = p.pageNumbers === 'yes' ? 'yes' : 'no';
  const output = p.output || defaultOutput(p.input, '转PDF', 'pdf');

  return {
    output,
    outputType: 'file',
    async run(taskId, onProgress) {
      onProgress?.(0.15);
      const res = await convertWordToPdf(p.input, output, {
        engine,
        pageSize,
        margin,
        pageNumbers,
        taskId,
      });
      onProgress?.(1);
      return {
        output,
        outputType: 'file',
        wordToPdfSummary: {
          title: res.title,
          pageCount: res.pageCount,
          imageCount: res.imageCount,
          tableCount: res.tableCount,
          engineUsed: res.engineUsed || 'builtin',
          outputSize: res.outputSize,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 13. PDF 转 Word (.docx)（表格/配图/双栏重构 + WinRT OCR + 版面保真）
// ---------------------------------------------------------------------------
function pdfToWord(p) {
  const ext = path.extname(String(p.input || '')).slice(1).toLowerCase();
  if (ext !== 'pdf') {
    throw new Error('请选择 PDF (.pdf) 文件');
  }
  const mode = ['editable', 'ocr', 'layout'].includes(p.mode) ? p.mode : 'editable';
  const ocrLang = ['auto', 'zh', 'en'].includes(p.ocrLang) ? p.ocrLang : 'auto';
  const keepPageBreak = p.keepPageBreak === 'no' ? 'no' : 'yes';
  const dpiScale = Math.min(Math.max(num(p.dpiScale, 2), 1.5), 3);
  const pageRange = String(p.pageRange || '').trim();
  const output = p.output || defaultOutput(p.input, '转Word', 'docx');

  return {
    output,
    outputType: 'file',
    async run(taskId, onProgress) {
      const res = await convertPdfToWord(p.input, output, {
        mode,
        ocrLang,
        keepPageBreak,
        dpiScale,
        pageRange,
        taskId,
        onProgress,
      });
      return {
        output,
        outputType: 'file',
        pdfToWordSummary: {
          mode: res.mode,
          pageCount: res.pageCount,
          totalPages: res.totalPages,
          nativePages: res.nativePages,
          ocrPages: res.ocrPages,
          tableCount: res.tableCount || 0,
          imageCount: res.imageCount || 0,
          outputSize: res.outputSize,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 14. PDF 压缩瘦身
// ---------------------------------------------------------------------------
function pdfCompress(p) {
  const ext = path.extname(String(p.input || '')).slice(1).toLowerCase();
  if (ext !== 'pdf') {
    throw new Error('请选择 PDF (.pdf) 文件');
  }
  const targetBytes = p.targetBytes;
  const preset = targetBytes !== undefined ? 'balanced'
    : (['high', 'balanced', 'extreme', 'raster'].includes(p.preset) ? p.preset : 'balanced');
  const maxSide = p.maxSide !== undefined ? Math.max(0, Math.round(num(p.maxSide, 1920))) : undefined;
  const rasterDpi = Math.min(Math.max(num(p.rasterDpi, 150), 72), 300);
  const output = p.output || defaultOutput(p.input, 'PDF压缩', 'pdf');

  return {
    output,
    outputType: 'file',
    async run(taskId, onProgress) {
      const res = await compressPdfFile(p.input, output, {
        preset,
        maxSide,
        rasterDpi,
        targetBytes,
        taskId,
        onProgress,
      });
      return {
        output,
        outputType: 'file',
        targetReached: res.targetReached,
        targetMB: res.targetBytes === undefined ? undefined : res.targetBytes / 1_000_000,
        pdfCompressSummary: {
          mode: res.mode,
          pageCount: res.pageCount,
          origSize: res.origSize,
          newSize: res.newSize,
          compressedImages: res.compressedImages,
          skippedShrink: res.skippedShrink,
          targetBytes: res.targetBytes,
          targetReached: res.targetReached,
        },
      };
    },
  };
}

function pdfSearchable(p) {
  if (path.extname(String(p.input || '')).toLowerCase() !== '.pdf') throw new Error('请选择 PDF 文件');
  const output = p.output || defaultOutput(p.input, '可搜索', 'pdf');
  return {
    output,
    outputType: 'file',
    async run(taskId, onProgress) {
      const { makePdfSearchable } = require('../core/pdf-searchable');
      const { output: _, ...pdfSearchableSummary } = await makePdfSearchable(p.input, output, {
        taskId, onProgress, ocrLang: p.ocrLang, pageRange: p.pageRange,
      });
      return { output, outputType: 'file', pdfSearchableSummary };
    },
  };
}

function pdfCrop(p) {
  if (path.extname(String(p.input || '')).toLowerCase() !== '.pdf') throw new Error('请选择 PDF 文件');
  const output = p.output || defaultOutput(p.input, '裁白边', 'pdf');
  return {
    output,
    outputType: 'file',
    async run(taskId, onProgress) {
      const { cropPdfMargins } = require('../core/pdf-crop');
      const { output: _, ...pdfCropSummary } = await cropPdfMargins(p.input, output, {
        taskId, onProgress, padding: p.padding, pageRange: p.pageRange,
      });
      return { output, outputType: 'file', pdfCropSummary };
    },
  };
}

// ---------------------------------------------------------------------------
// 15. PDF 页面旋转
// ---------------------------------------------------------------------------
function pdfRotate(p) {
  const ext = path.extname(String(p.input || '')).slice(1).toLowerCase();
  if (ext !== 'pdf') {
    throw new Error('请选择 PDF (.pdf) 文件');
  }
  const direction = ['cw90', 'ccw90', '180'].includes(p.direction) ? p.direction : 'cw90';
  const pageRange = String(p.pageRange || '').trim();
  const output = p.output || defaultOutput(p.input, '旋转PDF', 'pdf');

  return {
    output,
    outputType: 'file',
    async run(_taskId, onProgress) {
      const res = await rotatePdfPages(p.input, output, {
        direction,
        pageRange,
        onProgress,
      });
      return {
        output,
        outputType: 'file',
        pdfSummary: {
          action: 'rotate',
          totalPages: res.totalPages,
          rotatedCount: res.rotatedCount,
          angle: res.angle,
          pageCount: res.totalPages,
          outputSize: res.outputSize,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 16. PDF 水印与页码
// ---------------------------------------------------------------------------
function pdfWatermark(p) {
  const ext = path.extname(String(p.input || '')).slice(1).toLowerCase();
  if (ext !== 'pdf') {
    throw new Error('请选择 PDF (.pdf) 文件');
  }
  const contentMode = ['watermark', 'pageNum', 'both'].includes(p.contentMode) ? p.contentMode : 'watermark';
  const wmText = String(p.wmText || '').trim();
  if ((contentMode === 'watermark' || contentMode === 'both') && !wmText) {
    throw new Error('请输入要添加的水印文字');
  }
  const output = p.output || defaultOutput(p.input, contentMode === 'pageNum' ? '加页码' : '加水印', 'pdf');

  return {
    output,
    outputType: 'file',
    async run(_taskId, onProgress) {
      const res = await watermarkAndNumberPdf(p.input, output, {
        contentMode,
        wmText,
        wmStyle: p.wmStyle || 'tiled',
        wmColor: p.wmColor || '#64748b',
        wmOpacity: p.wmOpacity ?? '0.28',
        wmSize: p.wmSize || 'medium',
        numFormat: p.numFormat || 'slash',
        numPos: p.numPos || 'bc',
        numStart: p.numStart || '1',
        pageRange: String(p.pageRange || '').trim(),
        onProgress,
      });
      return {
        output,
        outputType: 'file',
        pdfSummary: {
          action: 'watermark',
          contentMode,
          totalPages: res.totalPages,
          affectedCount: res.affectedCount,
          pageCount: res.totalPages,
          outputSize: res.outputSize,
        },
      };
    },
  };
}

module.exports = {
  docExtractImages,
  docCompressImages,
  docRepackImages,
  docCleanupMedia,
  docStyleImages,
  mdOrganizeImages,
  docToPdf,
  wordToPdf,
  pdfToWord,
  pdfCompress,
  pdfSearchable,
  pdfCrop,
  pdfRotate,
  pdfWatermark,
  imagesToPdf,
  pdfToImages,
  pdfMerge,
  pdfSplit,
  pdfPreview,
};
