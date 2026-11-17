'use strict';

const fs = require('fs');
const path = require('path');

const MEDIA_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|tiff?|emf|wmf)$/i;

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/tiff': 'tif',
};

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function normalizeZipTarget(baseDir, target) {
  const clean = String(target || '').replace(/\\/g, '/');
  if (clean.startsWith('/')) return clean.slice(1);
  return path.posix.normalize(path.posix.join(baseDir, clean));
}

function parseRelsMap(xmlText, baseDir = 'word') {
  const map = new Map();
  const relRe = /<Relationship\b[^>]*>/gi;
  let m;
  while ((m = relRe.exec(xmlText))) {
    const tag = m[0];
    const id = tag.match(/\bId\s*=\s*["']([^"']+)["']/i)?.[1];
    const target = tag.match(/\bTarget\s*=\s*["']([^"']+)["']/i)?.[1];
    const mode = tag.match(/\bTargetMode\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!id || !target || /^External$/i.test(mode || '')) continue;
    map.set(id, normalizeZipTarget(baseDir, target));
  }
  return map;
}

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseDocxStyleHeadingLevels(zip) {
  const stylesEntry = zip.getEntry('word/styles.xml');
  const styleMap = new Map();
  if (stylesEntry) {
    const xml = stylesEntry.getData().toString('utf8');
    const styleRe = /<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/gi;
    let m;
    while ((m = styleRe.exec(xml))) {
      const attrs = m[1];
      const body = m[2];
      const type = attrs.match(/\bw:type\s*=\s*["']([^"']+)["']/i)?.[1];
      if (type && type.toLowerCase() !== 'paragraph') continue;
      const id = attrs.match(/\bw:styleId\s*=\s*["']([^"']+)["']/i)?.[1];
      if (!id) continue;
      const name = body.match(/<w:name\b[^>]*\bw:val\s*=\s*["']([^"']+)["']/i)?.[1] || '';
      const basedOn = body.match(/<w:basedOn\b[^>]*\bw:val\s*=\s*["']([^"']+)["']/i)?.[1] || '';
      const outRaw = body.match(/<w:outlineLvl\b[^>]*\bw:val\s*=\s*["'](\d+)["']/i)?.[1];
      const outlineLvl = outRaw !== undefined ? Number(outRaw) : null;
      styleMap.set(id, { name, basedOn, outlineLvl });
    }
  }

  const cache = new Map();
  const resolveLevel = (styleId, depth = 0) => {
    if (!styleId || depth > 10) return 0;
    if (cache.has(styleId)) return cache.get(styleId);
    let lvl = 0;
    const meta = styleMap.get(styleId);
    if (meta) {
      if (meta.outlineLvl !== null && meta.outlineLvl >= 0 && meta.outlineLvl <= 8) {
        lvl = meta.outlineLvl + 1;
      } else {
        const nm = meta.name.match(/^(?:heading|标题)\s*([1-9])$/i);
        if (nm) lvl = Number(nm[1]);
        else if (meta.basedOn) lvl = resolveLevel(meta.basedOn, depth + 1);
      }
    }
    if (!lvl) {
      const sm = String(styleId).match(/^(?:heading|h|标题)\s*([1-9])$/i);
      if (sm) lvl = Number(sm[1]);
    }
    cache.set(styleId, lvl);
    return lvl;
  };
  return resolveLevel;
}

function scanDocxParagraphs(docXml) {
  const paragraphs = [];
  const tagRe = /<\/?w:p(?:\s[^>]*)?>/gi;
  let depth = 0;
  let startIdx = -1;
  let m;
  while ((m = tagRe.exec(docXml))) {
    const tag = m[0];
    if (tag.startsWith('</')) {
      if (depth > 0) {
        depth--;
        if (depth === 0 && startIdx >= 0) {
          paragraphs.push(docXml.slice(startIdx, m.index + tag.length));
          startIdx = -1;
        }
      }
    } else if (!tag.endsWith('/>')) {
      if (depth === 0) startIdx = m.index;
      depth++;
    }
  }
  return paragraphs;
}

function extractDocxParagraphText(pXml) {
  const clean = pXml.replace(/<w:tab\b[^>]*\/?>/gi, '<w:t> </w:t>');
  const parts = [];
  const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi;
  let m;
  while ((m = tRe.exec(clean))) {
    parts.push(decodeXmlEntities(m[1]));
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function inspectDocx(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext === 'doc') {
    throw new Error('暂不支持旧版 .doc 二进制格式，请在 Word/WPS 中「另存为 .docx」后再提取');
  }
  const AdmZip = require('adm-zip');
  let zip;
  try {
    zip = new AdmZip(filePath);
  } catch {
    throw new Error('无法解析该 .docx 文件（可能已损坏或并非标准 Word 文档）');
  }

  const entries = zip.getEntries();
  const entryMap = new Map();
  const mediaEntries = [];

  for (const e of entries) {
    const name = String(e.entryName || '').replace(/\\/g, '/');
    entryMap.set(name, e);
    if (!e.isDirectory && /^word\/media\//i.test(name) && e.header.size > 0) {
      mediaEntries.push(e);
    }
  }

  mediaEntries.sort((a, b) => naturalCompare(a.entryName, b.entryName));

  // 读取主文档关系以按文章出现顺序排列图片并解析章节结构
  const relsEntry = entryMap.get('word/_rels/document.xml.rels');
  const relsMap = relsEntry ? parseRelsMap(relsEntry.getData().toString('utf8'), 'word') : new Map();
  const docEntry = entryMap.get('word/document.xml');
  const resolveStyleLevel = parseDocxStyleHeadingLevels(zip);

  const orderedNames = [];
  const seen = new Set();
  const sectionMetaByEntry = new Map();
  const sections = [];
  let hasRealHeading = false;

  if (docEntry && relsMap.size) {
    const docXml = docEntry.getData().toString('utf8');
    const paragraphs = scanDocxParagraphs(docXml);
    const parsedParas = paragraphs.map((pXml) => {
      const pPr = pXml.match(/<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/i)?.[1] || '';
      const outLvlRaw = pPr.match(/<w:outlineLvl\b[^>]*\bw:val\s*=\s*["'](\d+)["']/i)?.[1];
      const styleId = pPr.match(/<w:pStyle\b[^>]*\bw:val\s*=\s*["']([^"']+)["']/i)?.[1] || '';
      let level = 0;
      if (outLvlRaw !== undefined) {
        const n = Number(outLvlRaw);
        if (n >= 0 && n <= 8) level = n + 1;
      }
      if (!level && styleId) level = resolveStyleLevel(styleId);
      const text = extractDocxParagraphText(pXml);

      const mediaTargets = [];
      const refRe = /\b(?:r:embed|r:id)\s*=\s*["']([^"']+)["']/gi;
      let rm;
      while ((rm = refRe.exec(pXml))) {
        const target = relsMap.get(rm[1]);
        if (target && /^word\/media\//i.test(target) && entryMap.has(target)) {
          mediaTargets.push(target);
        }
      }
      return { text, level: level > 6 ? 6 : level, mediaTargets };
    });

    const styledHeadingCount = parsedParas.filter((p) => p.level > 0 && p.text).length;
    if (styledHeadingCount < 2) {
      for (const p of parsedParas) {
        if (p.level > 0 || p.mediaTargets.length || !p.text || p.text.length > 60) continue;
        if (/^第[一二三四五六七八九十百零\d]+[章节篇部分卷](?:[\s：:、.].*)?$/.test(p.text)) {
          p.level = /^第[一二三四五六七八九十百零\d]+节/.test(p.text) ? 2 : 1;
        } else if (/^\d+(?:\.\d+){1,2}\s+\S+/.test(p.text)) {
          p.level = Math.min(3, (p.text.match(/\./g) || []).length + 1);
        }
      }
    }

    const stack = [];
    let secSeq = 0;
    let implicitSec = null;

    for (const p of parsedParas) {
      if (p.level > 0 && p.text) {
        hasRealHeading = true;
        while (stack.length && stack[stack.length - 1].level >= p.level) stack.pop();
        const sec = {
          id: `sec_${++secSeq}`,
          title: p.text,
          level: p.level,
          parentId: stack.length ? stack[stack.length - 1].id : null,
          directImageCount: 0,
          imageCount: 0,
        };
        sections.push(sec);
        stack.push(sec);
      }

      for (const target of p.mediaTargets) {
        if (seen.has(target)) continue;
        seen.add(target);
        orderedNames.push(target);

        let curStack = stack;
        if (!curStack.length) {
          if (!implicitSec) {
            implicitSec = {
              id: 'sec_0',
              title: '封面 / 前言（首个标题之前）',
              level: 1,
              parentId: null,
              directImageCount: 0,
              imageCount: 0,
            };
            sections.unshift(implicitSec);
          }
          curStack = [implicitSec];
        }
        const curSec = curStack[curStack.length - 1];
        curSec.directImageCount++;
        for (const s of curStack) s.imageCount++;
        sectionMetaByEntry.set(target, {
          sectionId: curSec.id,
          sectionTitle: curSec.title,
          ancestorSectionIds: curStack.map((s) => s.id),
          ancestorTitles: curStack.map((s) => s.title),
        });
      }
    }
  }

  // 补充页眉/页脚/批注/文本框等其余 media
  let extraSec = null;
  for (const e of mediaEntries) {
    const name = String(e.entryName || '').replace(/\\/g, '/');
    if (!seen.has(name)) {
      seen.add(name);
      orderedNames.push(name);
      if (hasRealHeading) {
        if (!extraSec) {
          extraSec = {
            id: 'sec_extra',
            title: '页眉 / 页脚 / 其他区域',
            level: 1,
            parentId: null,
            directImageCount: 0,
            imageCount: 0,
          };
          sections.push(extraSec);
        }
        extraSec.directImageCount++;
        extraSec.imageCount++;
        sectionMetaByEntry.set(name, {
          sectionId: extraSec.id,
          sectionTitle: extraSec.title,
          ancestorSectionIds: [extraSec.id],
          ancestorTitles: [extraSec.title],
        });
      }
    }
  }

  const items = orderedNames.map((entryName) => {
    const e = entryMap.get(entryName);
    const filename = path.posix.basename(entryName);
    const imgExt = path.posix.extname(filename).slice(1).toLowerCase() || 'png';
    const secMeta = sectionMetaByEntry.get(entryName) || {};
    return {
      kind: 'docxMedia',
      entryName,
      filename,
      ext: imgExt,
      size: e.header.size || 0,
      isVectorLegacy: imgExt === 'emf' || imgExt === 'wmf',
      sectionId: secMeta.sectionId || '',
      sectionTitle: secMeta.sectionTitle || '',
      ancestorSectionIds: secMeta.ancestorSectionIds || [],
      ancestorTitles: secMeta.ancestorTitles || [],
    };
  });

  const vectorCount = items.filter((i) => i.isVectorLegacy).length;
  return {
    docType: 'docx',
    items,
    sections: hasRealHeading ? sections : [],
    stats: {
      total: items.length,
      imageCount: items.length,
      rasterCount: items.length - vectorCount,
      vectorCount,
      videoCount: 0,
      audioCount: 0,
    },
  };
}

const PPT_VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'm4v', 'flv', 'mpg', 'mpeg']);
const PPT_AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma']);

function inspectPptx(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext === 'ppt') {
    throw new Error('暂不支持旧版 .ppt 二进制格式，请在 PowerPoint/WPS 中「另存为 .pptx」后再处理');
  }
  const AdmZip = require('adm-zip');
  let zip;
  try {
    zip = new AdmZip(filePath);
  } catch {
    throw new Error('无法解析该 .pptx 文件（可能已损坏或并非标准 PowerPoint 演示文稿）');
  }

  const entries = zip.getEntries();
  const entryMap = new Map();
  const mediaEntries = [];

  for (const e of entries) {
    const name = String(e.entryName || '').replace(/\\/g, '/');
    entryMap.set(name, e);
    if (!e.isDirectory && /^ppt\/media\//i.test(name) && e.header.size > 0) {
      mediaEntries.push(e);
    }
  }

  mediaEntries.sort((a, b) => naturalCompare(a.entryName, b.entryName));

  // 读取 presentation.xml 按幻灯片顺序扫描每页引用的媒体资源
  const presRelsEntry = entryMap.get('ppt/_rels/presentation.xml.rels');
  const presRelsMap = presRelsEntry ? parseRelsMap(presRelsEntry.getData().toString('utf8'), 'ppt') : new Map();
  const presEntry = entryMap.get('ppt/presentation.xml');
  const slidePaths = [];
  const seenSlides = new Set();

  if (presEntry && presRelsMap.size) {
    const presXml = presEntry.getData().toString('utf8');
    const sldRe = /<p:sldId\b[^>]*\br:id\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let m;
    while ((m = sldRe.exec(presXml))) {
      const target = presRelsMap.get(m[1]);
      if (target && entryMap.has(target) && !seenSlides.has(target)) {
        seenSlides.add(target);
        slidePaths.push(target);
      }
    }
  }

  // 若未解析出 sldId，兜底按 ppt/slides/slide*.xml 自然排序
  if (!slidePaths.length) {
    for (const name of [...entryMap.keys()].sort(naturalCompare)) {
      if (/^ppt\/slides\/slide\d+\.xml$/i.test(name)) slidePaths.push(name);
    }
  }

  const orderedNames = [];
  const seenMedia = new Set();
  const sectionMetaByEntry = new Map();
  const sections = [];

  for (let sIdx = 0; sIdx < slidePaths.length; sIdx++) {
    const slidePath = slidePaths[sIdx];
    const baseName = path.posix.basename(slidePath);
    const relsPath = `ppt/slides/_rels/${baseName}.rels`;
    const slideRelsEntry = entryMap.get(relsPath);
    const slideXml = entryMap.get(slidePath)?.getData().toString('utf8') || '';

    // 提取本页标题占位符文本
    let slideTitle = '';
    const spRe = /<p:sp\b[\s\S]*?<\/p:sp>/gi;
    let spm;
    while ((spm = spRe.exec(slideXml))) {
      if (/<p:ph\b[^>]*\btype\s*=\s*["'](?:title|ctrTitle)["']/i.test(spm[0])) {
        const texts = [];
        const tRe = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi;
        let tm;
        while ((tm = tRe.exec(spm[0]))) texts.push(decodeXmlEntities(tm[1]));
        slideTitle = texts.join('').replace(/\s+/g, ' ').trim();
        if (slideTitle) break;
      }
    }
    const sec = {
      id: `slide_${sIdx + 1}`,
      title: slideTitle ? `第 ${sIdx + 1} 页：${slideTitle}` : `第 ${sIdx + 1} 页`,
      level: 1,
      parentId: null,
      directImageCount: 0,
      imageCount: 0,
    };
    sections.push(sec);

    if (!slideRelsEntry) continue;
    const slideRels = parseRelsMap(slideRelsEntry.getData().toString('utf8'), 'ppt/slides');

    const recordSlideTarget = (target) => {
      if (!target || !/^ppt\/media\//i.test(target) || !entryMap.has(target) || seenMedia.has(target)) return;
      seenMedia.add(target);
      orderedNames.push(target);
      sec.directImageCount++;
      sec.imageCount++;
      sectionMetaByEntry.set(target, {
        sectionId: sec.id,
        sectionTitle: sec.title,
        ancestorSectionIds: [sec.id],
        ancestorTitles: [sec.title],
      });
    };

    const refRe = /\b(?:r:embed|r:link|r:id)\s*=\s*["']([^"']+)["']/gi;
    let rm;
    while ((rm = refRe.exec(slideXml))) {
      recordSlideTarget(slideRels.get(rm[1]));
    }
    // 兼容未在 XML 正文正则捕获但存在于该页 .rels 中的媒体
    for (const target of slideRels.values()) {
      recordSlideTarget(target);
    }
  }

  // 补充母版、版式、备注页、主题等其余 ppt/media
  let extraSlideSec = null;
  for (const e of mediaEntries) {
    const name = String(e.entryName || '').replace(/\\/g, '/');
    if (!seenMedia.has(name)) {
      seenMedia.add(name);
      orderedNames.push(name);
      if (!extraSlideSec) {
        extraSlideSec = {
          id: 'slide_extra',
          title: '母版 / 版式 / 其他资源',
          level: 1,
          parentId: null,
          directImageCount: 0,
          imageCount: 0,
        };
        sections.push(extraSlideSec);
      }
      extraSlideSec.directImageCount++;
      extraSlideSec.imageCount++;
      sectionMetaByEntry.set(name, {
        sectionId: extraSlideSec.id,
        sectionTitle: extraSlideSec.title,
        ancestorSectionIds: [extraSlideSec.id],
        ancestorTitles: [extraSlideSec.title],
      });
    }
  }

  const items = orderedNames.map((entryName) => {
    const e = entryMap.get(entryName);
    const filename = path.posix.basename(entryName);
    const mediaExt = path.posix.extname(filename).slice(1).toLowerCase() || 'png';
    const mediaKind = PPT_VIDEO_EXTS.has(mediaExt)
      ? 'video'
      : (PPT_AUDIO_EXTS.has(mediaExt) ? 'audio' : 'image');
    const secMeta = sectionMetaByEntry.get(entryName) || {};
    return {
      kind: 'pptxMedia',
      mediaKind,
      entryName,
      filename,
      ext: mediaExt,
      size: e.header.size || 0,
      isVectorLegacy: mediaExt === 'emf' || mediaExt === 'wmf',
      sectionId: secMeta.sectionId || '',
      sectionTitle: secMeta.sectionTitle || '',
      ancestorSectionIds: secMeta.ancestorSectionIds || [],
      ancestorTitles: secMeta.ancestorTitles || [],
    };
  });

  const videoCount = items.filter((i) => i.mediaKind === 'video').length;
  const audioCount = items.filter((i) => i.mediaKind === 'audio').length;
  const imageItems = items.filter((i) => i.mediaKind === 'image');
  const vectorCount = imageItems.filter((i) => i.isVectorLegacy).length;

  return {
    docType: 'pptx',
    items,
    sections: sections.length > 1 ? sections : [],
    stats: {
      total: items.length,
      imageCount: imageItems.length,
      rasterCount: imageItems.length - vectorCount,
      vectorCount,
      videoCount,
      audioCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Markdown 图片语法 / HTML <img> / Base64 Data URI / 内联 <svg> 解析
// ---------------------------------------------------------------------------

function blankFencedCodeBlocks(text) {
  const parts = text.split(/(\r?\n)/);
  let fence = null;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (!fence) {
      if (m) {
        fence = { ch: m[1][0], len: m[1].length };
        parts[i] = ' '.repeat(line.length);
      }
    } else {
      parts[i] = ' '.repeat(line.length);
      const closeRe = new RegExp(`^\\s{0,3}${fence.ch}{${fence.len},}\\s*$`);
      if (closeRe.test(line)) fence = null;
    }
  }
  return parts.join('');
}

function parseMarkdownTarget(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('<')) {
    const end = trimmed.indexOf('>');
    if (end > 1) return trimmed.slice(1, end).trim();
  }
  // 去掉末尾可选的 "title" / 'title' / (title)
  const titleMatch = trimmed.match(/^(\S+?)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/);
  if (titleMatch) return titleMatch[1];
  return trimmed.split(/\s+/)[0];
}

function scanInlineMdImages(cleanText) {
  const results = [];
  let i = 0;
  while (i < cleanText.length) {
    const idx = cleanText.indexOf('![', i);
    if (idx === -1) break;
    // 读取 alt 文本到 ]
    let j = idx + 2;
    while (j < cleanText.length && cleanText[j] !== ']') {
      if (cleanText[j] === '\\' && j + 1 < cleanText.length) j += 2;
      else if (cleanText[j] === '\n') break;
      else j++;
    }
    if (j >= cleanText.length || cleanText[j] !== ']') {
      i = idx + 2;
      continue;
    }
    const alt = cleanText.slice(idx + 2, j).trim();
    if (cleanText[j + 1] !== '(') {
      i = j + 1;
      continue;
    }
    // 扫描匹配的 )，支持嵌套括号和 <...>
    let k = j + 2;
    let depth = 1;
    let inAngle = false;
    let quote = null;
    while (k < cleanText.length && depth > 0) {
      const ch = cleanText[k];
      if (ch === '\n' && !quote) break;
      if (quote) {
        if (ch === '\\' && k + 1 < cleanText.length) { k += 2; continue; }
        if (ch === quote) quote = null;
      } else if (inAngle) {
        if (ch === '>') inAngle = false;
      } else {
        if (ch === '<' && cleanText.slice(j + 2, k).trim() === '') inAngle = true;
        else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
      k++;
    }
    if (depth === 0) {
      const inner = cleanText.slice(j + 2, k - 1);
      const target = parseMarkdownTarget(inner);
      if (target) {
        results.push({ index: idx, end: k, alt, target, source: 'markdown' });
      }
      i = k;
    } else {
      i = idx + 2;
    }
  }
  return results;
}

function classifyTarget(rawTarget, alt, mdDir, extra = {}) {
  const target = String(rawTarget || '').trim();
  if (!target) return null;

  if (/^data:image\//i.test(target)) {
    const headerMatch = target.match(/^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?,([\s\S]*)$/i);
    if (!headerMatch) return null;
    const mime = headerMatch[1].toLowerCase();
    const isBase64 = /;base64,/i.test(target.slice(0, target.indexOf(',') + 1));
    const ext = MIME_EXT[mime] || mime.split('/')[1].replace(/\+xml$/, '') || 'png';
    return {
      kind: 'dataUri',
      target,
      alt,
      mime,
      isBase64,
      payload: headerMatch[2],
      ext,
      ...extra,
    };
  }

  if (/^(https?:)?\/\//i.test(target)) {
    const url = target.startsWith('//') ? `https:${target}` : target;
    let urlExt = '';
    try {
      const u = new URL(url);
      const m = u.pathname.match(MEDIA_EXT_RE);
      if (m) urlExt = m[1].toLowerCase().replace('jpeg', 'jpg');
    } catch {}
    return {
      kind: 'remote',
      target: url,
      alt,
      ext: urlExt || 'png',
      ...extra,
    };
  }

  // 本地路径（支持 file:/// URI、URL 编码 %20、Windows/POSIX 相对或绝对路径）
  let localRef = target;
  if (/^file:\/\//i.test(localRef)) {
    localRef = localRef.replace(/^file:\/\/(?:localhost)?\/?/i, '');
    if (!/^[a-z]:/i.test(localRef) && !localRef.startsWith('/')) localRef = '/' + localRef;
  }

  const candidates = [];
  const stripped = localRef.split(/[?#]/)[0];
  candidates.push(localRef);
  if (stripped !== localRef) candidates.push(stripped);
  try {
    const decoded = decodeURIComponent(stripped);
    if (decoded !== stripped) candidates.push(decoded);
  } catch {}

  let resolvedPath = '';
  let exists = false;
  for (const c of candidates) {
    const abs = path.isAbsolute(c) ? path.normalize(c) : path.resolve(mdDir, c);
    if (!resolvedPath) resolvedPath = abs;
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        resolvedPath = abs;
        exists = true;
        break;
      }
    } catch {}
  }

  const ext = path.extname(resolvedPath).slice(1).toLowerCase().replace('jpeg', 'jpg') || 'png';
  return {
    kind: 'local',
    target,
    resolvedPath,
    exists,
    alt,
    ext,
    ...extra,
  };
}

function scanMarkdownImages(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const mdDir = path.dirname(filePath);
  const clean = blankFencedCodeBlocks(raw);

  // 收集参考式链接定义: [id]: url "title"
  const refDefs = new Map();
  const defRe = /^\s{0,3}\[([^\]]+)\]:\s*(<[^>\n]+>|[^\s]+)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*$/gm;
  let dm;
  while ((dm = defRe.exec(clean))) {
    const id = dm[1].trim().toLowerCase();
    const url = parseMarkdownTarget(dm[2]);
    if (id && url && !refDefs.has(id)) refDefs.set(id, url);
  }

  const hits = [];
  const occupied = []; // 避免在同一偏移区间重复匹配

  // 1. 行内 Markdown 图片 ![alt](url)
  for (const h of scanInlineMdImages(clean)) {
    hits.push(h);
    occupied.push([h.index, h.end]);
  }

  const overlaps = (start, end) => occupied.some(([a, b]) => start < b && end > a);

  // 2. 参考式 Markdown 图片 ![alt][id] / ![id][] / ![id]
  const refImgRe = /!\[([^\]]*)\](?:\[([^\]]*)\])?/g;
  let rm;
  while ((rm = refImgRe.exec(clean))) {
    if (overlaps(rm.index, rm.index + rm[0].length)) continue;
    const after = clean[rm.index + rm[0].length];
    if (after === '(') continue;
    const refId = (rm[2] !== undefined ? (rm[2] || rm[1]) : rm[1]).trim().toLowerCase();
    const url = refDefs.get(refId);
    if (url) {
      hits.push({ index: rm.index, end: rm.index + rm[0].length, alt: rm[1].trim(), target: url, source: 'md-ref' });
      occupied.push([rm.index, rm.index + rm[0].length]);
    }
  }

  // 3. HTML <img ... src="...">
  const imgTagRe = /<img\b[^>]*>/gi;
  let im;
  while ((im = imgTagRe.exec(clean))) {
    const tag = im[0];
    const srcMatch = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
    if (!srcMatch) continue;
    const src = (srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? '').trim();
    if (!src) continue;
    const altMatch = tag.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    hits.push({
      index: im.index,
      end: im.index + tag.length,
      alt: (altMatch?.[1] ?? altMatch?.[2] ?? '').trim(),
      target: src,
      source: 'html-img',
    });
  }

  // 4. 内联 <svg ...>...</svg>
  const svgTagRe = /<svg\b[^>]*>[\s\S]*?<\/svg>/gi;
  let sm;
  while ((sm = svgTagRe.exec(clean))) {
    hits.push({
      index: sm.index,
      end: sm.index + sm[0].length,
      kind: 'inlineSvg',
      svgCode: raw.slice(sm.index, sm.index + sm[0].length),
      alt: 'inline-svg',
      ext: 'svg',
      source: 'inline-svg',
    });
  }

  hits.sort((a, b) => a.index - b.index);

  // 扫描 Markdown 章节标题（已屏蔽代码块）
  const mdHeadings = [];
  const headingLineRe = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*$/gm;
  let hm;
  while ((hm = headingLineRe.exec(clean))) {
    const title = hm[2].trim();
    if (title) {
      mdHeadings.push({ index: hm.index, level: hm[1].length, title });
    }
  }

  const sections = [];
  const stack = [];
  let secSeq = 0;
  let implicitSec = null;
  let hPtr = 0;

  const items = [];
  for (const h of hits) {
    while (hPtr < mdHeadings.length && mdHeadings[hPtr].index <= h.index) {
      const hd = mdHeadings[hPtr++];
      while (stack.length && stack[stack.length - 1].level >= hd.level) stack.pop();
      const sec = {
        id: `sec_${++secSeq}`,
        title: hd.title,
        level: hd.level,
        parentId: stack.length ? stack[stack.length - 1].id : null,
        directImageCount: 0,
        imageCount: 0,
      };
      sections.push(sec);
      stack.push(sec);
    }

    let curStack = stack;
    if (mdHeadings.length && !curStack.length) {
      if (!implicitSec) {
        implicitSec = {
          id: 'sec_0',
          title: '正文开头（首个标题之前）',
          level: 1,
          parentId: null,
          directImageCount: 0,
          imageCount: 0,
        };
        sections.unshift(implicitSec);
      }
      curStack = [implicitSec];
    }

    const secExtra = curStack.length
      ? {
          sectionId: curStack[curStack.length - 1].id,
          sectionTitle: curStack[curStack.length - 1].title,
          ancestorSectionIds: curStack.map((s) => s.id),
          ancestorTitles: curStack.map((s) => s.title),
        }
      : { sectionId: '', sectionTitle: '', ancestorSectionIds: [], ancestorTitles: [] };

    const item = h.kind === 'inlineSvg'
      ? { ...h, ...secExtra }
      : classifyTarget(h.target, h.alt, mdDir, { source: h.source, ...secExtra });

    if (item) {
      items.push(item);
      if (curStack.length) {
        curStack[curStack.length - 1].directImageCount++;
        for (const s of curStack) s.imageCount++;
      }
    }
  }

  // 把最后一个含图章节之后的标题也补齐（方便用户在目录树里看到完整大纲）
  while (hPtr < mdHeadings.length) {
    const hd = mdHeadings[hPtr++];
    while (stack.length && stack[stack.length - 1].level >= hd.level) stack.pop();
    const sec = {
      id: `sec_${++secSeq}`,
      title: hd.title,
      level: hd.level,
      parentId: stack.length ? stack[stack.length - 1].id : null,
      directImageCount: 0,
      imageCount: 0,
    };
    sections.push(sec);
    stack.push(sec);
  }

  const stats = {
    total: items.length,
    local: items.filter((i) => i.kind === 'local' && i.exists).length,
    missing: items.filter((i) => i.kind === 'local' && !i.exists).length,
    dataUri: items.filter((i) => i.kind === 'dataUri').length,
    inlineSvg: items.filter((i) => i.kind === 'inlineSvg').length,
    remote: items.filter((i) => i.kind === 'remote').length,
  };

  return {
    docType: 'md',
    items,
    sections: mdHeadings.length ? sections : [],
    stats,
  };
}

const DOCX_CT_MAP = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  m4v: 'video/x-m4v',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
};

function relsBaseDir(relsPath) {
  const norm = String(relsPath || '').replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/_rels/');
  if (idx >= 0) return norm.slice(0, idx);
  return '';
}

function allocUniqueMediaEntry(usedSet, desiredFilename, mediaPrefix = 'word/media') {
  const cleanName = path.posix.basename(String(desiredFilename || 'image.png'));
  const ext = path.posix.extname(cleanName);
  const stem = path.posix.basename(cleanName, ext) || 'image';
  const prefix = String(mediaPrefix || 'word/media').replace(/\/+$/, '');
  let candidate = `${prefix}/${cleanName}`;
  let idx = 1;
  while (usedSet.has(candidate.toLowerCase())) {
    candidate = `${prefix}/${stem}_${idx++}${ext}`;
  }
  usedSet.add(candidate.toLowerCase());
  return candidate;
}

function rewriteDocxMediaTargets(zip, renameMap) {
  if (!renameMap || !renameMap.size) return 0;
  let updatedFiles = 0;
  const lowerMap = new Map();
  for (const [k, v] of renameMap.entries()) {
    lowerMap.set(k.replace(/\\/g, '/').toLowerCase(), v.replace(/\\/g, '/'));
  }

  for (const entry of zip.getEntries()) {
    const entryName = String(entry.entryName || '').replace(/\\/g, '/');
    if (entry.isDirectory || !/\.rels$/i.test(entryName)) continue;
    const xml = entry.getData().toString('utf8');
    const baseDir = relsBaseDir(entryName);
    let changed = false;
    const nextXml = xml.replace(/<Relationship\b[^>]*>/gi, (tag) => {
      const mode = tag.match(/\bTargetMode\s*=\s*["']([^"']+)["']/i)?.[1];
      if (/^External$/i.test(mode || '')) return tag;
      const targetMatch = tag.match(/\bTarget\s*=\s*(["'])([^"']+)\1/i);
      if (!targetMatch) return tag;
      const absTarget = normalizeZipTarget(baseDir, targetMatch[2]);
      const nextAbs = lowerMap.get(absTarget.toLowerCase());
      if (!nextAbs) return tag;
      const relTarget = baseDir ? path.posix.relative(baseDir, nextAbs) : nextAbs;
      changed = true;
      return tag.replace(/\bTarget\s*=\s*(["'])([^"']+)\1/i, `Target=${targetMatch[1]}${relTarget}${targetMatch[1]}`);
    });
    if (changed) {
      zip.updateFile(entry.entryName, Buffer.from(nextXml, 'utf8'));
      updatedFiles++;
    }
  }
  return updatedFiles;
}

function ensureDocxContentTypes(zip, extensions = [], renameMap = null) {
  const ctEntry = zip.getEntry('[Content_Types].xml');
  if (!ctEntry) return;
  let xml = ctEntry.getData().toString('utf8');
  let changed = false;

  if (renameMap && renameMap.size) {
    for (const [oldPath, newPath] of renameMap.entries()) {
      const oldPart = '/' + oldPath.replace(/^\/+/, '');
      const newPart = '/' + newPath.replace(/^\/+/, '');
      const newExt = path.posix.extname(newPath).slice(1).toLowerCase();
      const newCt = DOCX_CT_MAP[newExt];
      const escaped = oldPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const overrideRe = new RegExp(`<Override\\b[^>]*\\bPartName\\s*=\\s*["']${escaped}["'][^>]*>`, 'gi');
      if (overrideRe.test(xml)) {
        xml = xml.replace(overrideRe, (tag) => {
          let out = tag.replace(new RegExp(escaped, 'gi'), newPart);
          if (newCt) out = out.replace(/\bContentType\s*=\s*["'][^"']+["']/i, `ContentType="${newCt}"`);
          return out;
        });
        changed = true;
      }
    }
  }

  for (const rawExt of extensions) {
    const ext = String(rawExt || '').replace(/^\./, '').toLowerCase();
    const ct = DOCX_CT_MAP[ext];
    if (!ct) continue;
    const hasDefault = new RegExp(`<Default\\b[^>]*\\bExtension\\s*=\\s*["']${ext}["']`, 'i').test(xml);
    if (!hasDefault) {
      xml = xml.replace(/<\/Types\s*>/i, `  <Default Extension="${ext}" ContentType="${ct}"/>\n</Types>`);
      changed = true;
    }
  }

  if (changed) {
    zip.updateFile('[Content_Types].xml', Buffer.from(xml, 'utf8'));
  }
}

function updateExtentAttr(tag, newHeightFn) {
  const cxMatch = tag.match(/\bcx\s*=\s*["'](\d+)["']/i);
  const cyMatch = tag.match(/\bcy\s*=\s*["'](\d+)["']/i);
  if (!cxMatch || !cyMatch) return { tag, changed: false };
  const cx = Number(cxMatch[1]);
  const oldCy = Number(cyMatch[1]);
  if (!(cx > 0)) return { tag, changed: false };
  const newCy = Math.max(1, Math.round(newHeightFn(cx)));
  if (newCy === oldCy) return { tag, changed: false };
  const nextTag = tag.replace(/\bcy\s*=\s*(["'])\d+\1/i, `cy=$1${newCy}$1`);
  return { tag: nextTag, changed: nextTag !== tag };
}

function updateOoxmlImageSizesKeepWidth(zip, sizeMapByEntry) {
  if (!sizeMapByEntry || !sizeMapByEntry.size) return 0;

  let updatedContainers = 0;
  const entries = zip.getEntries();

  for (const relsEntry of entries) {
    const relsName = String(relsEntry.entryName || '').replace(/\\/g, '/');
    if (relsEntry.isDirectory) continue;
    const rm = relsName.match(/^(.+)\/_rels\/([^/]+\.xml)\.rels$/i);
    if (!rm) continue;

    const baseDir = rm[1];
    const xmlPath = `${baseDir}/${rm[2]}`;
    const xmlEntry = zip.getEntry(xmlPath);
    if (!xmlEntry || xmlEntry.isDirectory) continue;

    const relsMap = parseRelsMap(relsEntry.getData().toString('utf8'), baseDir);
    const rIdSizeMap = new Map();
    for (const [rId, absTarget] of relsMap.entries()) {
      const dims = sizeMapByEntry.get(absTarget.toLowerCase());
      if (dims && dims.width > 0 && dims.height > 0) {
        rIdSizeMap.set(rId, dims);
      }
    }
    if (!rIdSizeMap.size) continue;

    let xml = xmlEntry.getData().toString('utf8');
    let xmlChanged = false;

    // 1. Word DrawingML: <wp:inline> / <wp:anchor>
    xml = xml.replace(/<wp:(inline|anchor)\b[^>]*>[\s\S]*?<\/wp:\1>/gi, (block) => {
      const blipMatch = block.match(/<a:blip\b[^>]*\b(?:r:embed|r:link)\s*=\s*["']([^"']+)["'][^>]*>/i);
      if (!blipMatch) return block;
      const dims = rIdSizeMap.get(blipMatch[1]);
      if (!dims) return block;

      let nextBlock = block;
      let blockChanged = false;
      const heightForWidth = (cx) => (cx * dims.height) / dims.width;

      nextBlock = nextBlock.replace(/<wp:extent\b[^>]*>/i, (extTag) => {
        const res = updateExtentAttr(extTag, heightForWidth);
        if (res.changed) blockChanged = true;
        return res.tag;
      });

      nextBlock = nextBlock.replace(/(<pic:spPr\b[\s\S]*?<a:xfrm\b[\s\S]*?)(<a:ext\b[^>]*>)/i, (_m, prefix, extTag) => {
        const res = updateExtentAttr(extTag, heightForWidth);
        if (res.changed) blockChanged = true;
        return `${prefix}${res.tag}`;
      });

      if (blockChanged) {
        xmlChanged = true;
        updatedContainers++;
      }
      return nextBlock;
    });

    // 2. PPT DrawingML: <p:pic>
    xml = xml.replace(/<p:pic\b[^>]*>[\s\S]*?<\/p:pic>/gi, (block) => {
      const blipMatch = block.match(/<a:blip\b[^>]*\b(?:r:embed|r:link)\s*=\s*["']([^"']+)["'][^>]*>/i);
      if (!blipMatch) return block;
      const dims = rIdSizeMap.get(blipMatch[1]);
      if (!dims) return block;

      let blockChanged = false;
      const heightForWidth = (cx) => (cx * dims.height) / dims.width;
      const nextBlock = block.replace(/(<p:spPr\b[\s\S]*?<a:xfrm\b[\s\S]*?)(<a:ext\b[^>]*>)/i, (_m, prefix, extTag) => {
        const res = updateExtentAttr(extTag, heightForWidth);
        if (res.changed) blockChanged = true;
        return `${prefix}${res.tag}`;
      });

      if (blockChanged) {
        xmlChanged = true;
        updatedContainers++;
      }
      return nextBlock;
    });

    // 3. Word VML fallback: <v:shape ... style="...width:300pt;height:200pt...">...<v:imagedata r:id="..."/>
    xml = xml.replace(/<v:shape\b[^>]*>[\s\S]*?<\/v:shape>/gi, (block) => {
      const imgMatch = block.match(/<v:imagedata\b[^>]*\b(?:r:id|o:relid)\s*=\s*["']([^"']+)["'][^>]*>/i);
      if (!imgMatch) return block;
      const dims = rIdSizeMap.get(imgMatch[1]);
      if (!dims) return block;

      const nextBlock = block.replace(/(<v:shape\b[^>]*\bstyle\s*=\s*)(["'])([^"']*)\2/i, (full, prefix, q, styleStr) => {
        const wMatch = styleStr.match(/\bwidth\s*:\s*([\d.]+)([a-z%]*)/i);
        const hMatch = styleStr.match(/\bheight\s*:\s*([\d.]+)([a-z%]*)/i);
        if (!wMatch || !hMatch) return full;
        const wVal = parseFloat(wMatch[1]);
        if (!(wVal > 0)) return full;
        const newHVal = Number(((wVal * dims.height) / dims.width).toFixed(2));
        const unit = hMatch[2] || wMatch[2] || '';
        const nextStyle = styleStr.replace(/\bheight\s*:\s*[\d.]+[a-z%]*/i, `height:${newHVal}${unit}`);
        if (nextStyle === styleStr) return full;
        xmlChanged = true;
        updatedContainers++;
        return `${prefix}${q}${nextStyle}${q}`;
      });
      return nextBlock;
    });

    if (xmlChanged) {
      zip.updateFile(xmlPath, Buffer.from(xml, 'utf8'));
    }
  }

  return updatedContainers;
}

function inspectDocument(filePath) {
  const ext = path.extname(String(filePath || '')).slice(1).toLowerCase();
  if (ext === 'docx' || ext === 'doc') return inspectDocx(filePath);
  if (ext === 'pptx' || ext === 'ppt') return inspectPptx(filePath);
  if (ext === 'md' || ext === 'markdown') return scanMarkdownImages(filePath);
  throw new Error(`不支持的文档格式：.${ext || '未知'}`);
}

module.exports = {
  inspectDocx,
  inspectPptx,
  scanMarkdownImages,
  inspectDocument,
  allocUniqueMediaEntry,
  rewriteDocxMediaTargets,
  ensureDocxContentTypes,
  updateOoxmlImageSizesKeepWidth,
};
