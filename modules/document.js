'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  inspectDocument,
  allocUniqueMediaEntry,
  rewriteDocxMediaTargets,
  ensureDocxContentTypes,
  updateOoxmlImageSizesKeepWidth,
} = require('../core/doc-parser');
const { num, imageCodecArgs } = require('../core/utils');
const { probe, runFfmpeg, defaultOutput, defaultDirOutput } = require('../core/runner');

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
const REPLACE_IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif', 'gif', 'tif', 'tiff']);

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
    headers: { 'User-Agent': 'VideoGifToolbox/2.1' },
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
        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          const origBuf = t.entry.getData();
          const tmpIn = path.join(tmpDir, `in_${i}.${t.origExt}`);
          fs.writeFileSync(tmpIn, origBuf);

          let res = null;
          try {
            if (t.kind === 'video') {
              res = await compressEmbeddedVideoFile(taskId, tmpIn, { maxSide, preset }, tmpDir, i);
            } else {
              res = await compressRasterFile(taskId, tmpIn, t.origExt, { maxSide, preset, formatMode }, tmpDir, i);
            }
          } catch (err) {
            if (err.message === '任务已取消') throw err;
            res = null;
          }

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

          onProgress?.(0.08 + (0.86 * (i + 1)) / targets.length);
        }

        if (renameMap.size) {
          rewriteDocxMediaTargets(zip, renameMap);
          ensureDocxContentTypes(zip, [...usedExts], renameMap);
        }

        fs.mkdirSync(path.dirname(output), { recursive: true });
        zip.writeZip(output);
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

function collectCandidateImages(replaceDir, replaceFiles) {
  const candidates = [];
  const seen = new Set();
  const addFile = (filePath, priorityBoost = 0) => {
    const abs = path.resolve(filePath);
    const key = abs.toLowerCase();
    if (seen.has(key)) return;
    let st;
    try { st = fs.statSync(abs); } catch { return; }
    if (!st.isFile()) return;
    const ext = path.extname(abs).slice(1).toLowerCase();
    if (!REPLACE_IMG_EXTS.has(ext)) return;
    seen.add(key);
    candidates.push({
      path: abs,
      filename: path.basename(abs),
      stem: path.basename(abs, path.extname(abs)),
      ext,
      mtimeMs: st.mtimeMs,
      priorityBoost,
    });
  };

  if (Array.isArray(replaceFiles)) {
    for (const f of replaceFiles) addFile(f, 2);
  }

  if (replaceDir && fs.existsSync(replaceDir)) {
    const scanDir = (dir, boost) => {
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (name.startsWith('.')) continue;
        addFile(path.join(dir, name), boost);
      }
    };
    scanDir(replaceDir, 0);
    const subOut = path.join(replaceDir, 'output');
    if (fs.existsSync(subOut)) scanDir(subOut, 1);
  }

  return candidates;
}

function readManifestNear(replaceDir, replaceFiles) {
  const dirsToCheck = [];
  if (replaceDir) {
    dirsToCheck.push(replaceDir);
    dirsToCheck.push(path.dirname(replaceDir));
  }
  if (Array.isArray(replaceFiles) && replaceFiles.length) {
    const d = path.dirname(replaceFiles[0]);
    dirsToCheck.push(d);
    dirsToCheck.push(path.dirname(d));
  }
  for (const dir of dirsToCheck) {
    if (!dir) continue;
    const mp = path.join(dir, '.vgt-manifest.json');
    try {
      if (fs.existsSync(mp)) {
        return JSON.parse(fs.readFileSync(mp, 'utf8'));
      }
    } catch {}
  }
  return null;
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
        zip.writeZip(output);
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

module.exports = {
  docExtractImages,
  docCompressImages,
  docRepackImages,
};
