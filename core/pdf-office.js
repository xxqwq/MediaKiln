'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFRawStream,
  PDFNumber,
  PDFBool,
  PDFHexString,
  PDFString,
  EncryptedPDFError,
  decodePDFRawStream,
  degrees,
  rgb,
  StandardFonts,
} = require('pdf-lib');
const { Resvg } = require('@resvg/resvg-js');
const {
  parsePageRange,
  getPdfPageCount,
  renderPdfPagesToPngs,
  buildPdfFromJpegPages,
  getJpegDimensions,
} = require('./pdf-engine');
const { renderHtmlFileToPdf } = require('./md-renderer');
const { probe, runFfmpeg, registerCancelableTask, throwIfTaskCancelled, writeTaskOutput } = require('./runner');
const { cleanOcrLineText, runWinRtOcrOnImages } = require('./image-ocr');
const { normalizeHexColor } = require('./utils');

// ---------------------------------------------------------------------------
// 通用辅助函数
// ---------------------------------------------------------------------------

function escapeXml(str) {
  return String(str ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

function normalizeZipTarget(baseDir, target) {
  const clean = String(target || '').replace(/\\/g, '/');
  if (clean.startsWith('/')) return clean.slice(1);
  return path.posix.normalize(path.posix.join(baseDir, clean));
}

async function loadPdfSafe(filePath, { ignoreEncryption = false } = {}) {
  try {
    const buf = await fs.promises.readFile(filePath);
    const doc = await PDFDocument.load(buf, {
      updateMetadata: false,
      ignoreEncryption,
    });
    if (doc.isEncrypted) {
      throw new Error('该 PDF 文件受密码或权限加密保护，暂无法直接处理');
    }
    if (!doc.getPageCount()) {
      throw new Error('PDF 文档不包含任何页面');
    }
    return { doc, rawBuffer: buf };
  } catch (err) {
    if (err instanceof EncryptedPDFError || /encrypted/i.test(err?.message || '')) {
      throw new Error('该 PDF 文件已加密保护，暂无法直接处理', { cause: err });
    }
    throw err;
  }
}

function getEffectivePageSize(page) {
  const { width, height } = page.getSize();
  const angle = ((page.getRotation().angle % 360) + 360) % 360;
  if (angle === 90 || angle === 270) {
    return { width: height, height: width, rawWidth: width, rawHeight: height, angle };
  }
  return { width, height, rawWidth: width, rawHeight: height, angle };
}

// ---------------------------------------------------------------------------
// 1. Word (.docx) → HTML → 矢量 PDF
// ---------------------------------------------------------------------------

function findTagEnd(xml, startIdx) {
  let quote = '';
  for (let i = startIdx; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function getTagAttr(attrs, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = String(attrs || '').match(re);
  return m ? decodeXmlEntities(m[1] ?? m[2] ?? '') : '';
}

// 按平衡深度提取顶层子元素（支持同标签嵌套如嵌套表格/嵌套段落）
function extractBalancedElements(xml, targetTagSet) {
  const results = [];
  const tagRe = /<\/?([a-zA-Z0-9_:-]+)(?=[\s/>])/g;
  let depth = 0;
  let activeTag = '';
  let startIdx = -1;
  let attrs = '';
  let m;

  while ((m = tagRe.exec(xml))) {
    const isClose = xml[m.index + 1] === '/';
    const tagName = m[1];
    const endIdx = findTagEnd(xml, m.index);
    if (endIdx < 0) break;
    tagRe.lastIndex = endIdx + 1;

    if (depth === 0) {
      if (!isClose && targetTagSet.has(tagName)) {
        const selfClose = xml[endIdx - 1] === '/';
        const openAttrs = xml.slice(m.index + 1 + tagName.length, selfClose ? endIdx - 1 : endIdx);
        if (selfClose) {
          results.push({ tag: tagName, attrs: openAttrs, inner: '', raw: xml.slice(m.index, endIdx + 1) });
        } else {
          depth = 1;
          activeTag = tagName;
          startIdx = m.index;
          attrs = openAttrs;
        }
      }
      continue;
    }

    if (tagName === activeTag) {
      if (isClose) {
        depth--;
        if (depth === 0) {
          const innerStart = findTagEnd(xml, startIdx) + 1;
          results.push({
            tag: activeTag,
            attrs,
            inner: xml.slice(innerStart, m.index),
            raw: xml.slice(startIdx, endIdx + 1),
          });
          activeTag = '';
          startIdx = -1;
          attrs = '';
        }
      } else {
        const selfClose = xml[endIdx - 1] === '/';
        if (!selfClose) depth++;
      }
    }
  }
  return results;
}

function readXmlBool(xml, tagName) {
  const m = String(xml || '').match(new RegExp(`<${tagName}\\b([^>]*)\\/?>`, 'i'));
  if (!m) return undefined;
  const val = getTagAttr(m[1], 'w:val').toLowerCase();
  if (val === '0' || val === 'false' || val === 'off' || val === 'none') return false;
  return true;
}

function parseRunPropsXml(rPrXml) {
  if (!rPrXml) return {};
  const res = {};
  const b = readXmlBool(rPrXml, 'w:b');
  if (b !== undefined) res.bold = b;
  const i = readXmlBool(rPrXml, 'w:i');
  if (i !== undefined) res.italic = i;
  const uMatch = rPrXml.match(/<w:u\b([^>]*)\/?>/i);
  if (uMatch) {
    const val = getTagAttr(uMatch[1], 'w:val').toLowerCase();
    res.underline = val !== 'none' && val !== 'false' && val !== '0';
  }
  const strike = readXmlBool(rPrXml, 'w:strike');
  const dstrike = readXmlBool(rPrXml, 'w:dstrike');
  if (strike !== undefined || dstrike !== undefined) res.strike = !!(strike || dstrike);
  const szMatch = rPrXml.match(/<w:sz\b[^>]*\bw:val\s*=\s*["'](\d+)["']/i);
  if (szMatch) res.fontSizePt = Number(szMatch[1]) / 2;
  const colorMatch = rPrXml.match(/<w:color\b[^>]*\bw:val\s*=\s*["']([^"']+)["']/i);
  if (colorMatch && /^[0-9a-f]{6}$/i.test(colorMatch[1])) res.color = `#${colorMatch[1]}`;
  const shdMatch = rPrXml.match(/<w:shd\b[^>]*\bw:fill\s*=\s*["']([^"']+)["']/i);
  if (shdMatch && /^[0-9a-f]{6}$/i.test(shdMatch[1])) res.bgColor = `#${shdMatch[1]}`;
  const hlMatch = rPrXml.match(/<w:highlight\b[^>]*\bw:val\s*=\s*["']([^"']+)["']/i);
  if (hlMatch && hlMatch[1] && hlMatch[1] !== 'none') res.highlight = hlMatch[1];
  const vaMatch = rPrXml.match(/<w:vertAlign\b[^>]*\bw:val\s*=\s*["']([^"']+)["']/i);
  if (vaMatch) res.vertAlign = vaMatch[1];
  const rStyleMatch = rPrXml.match(/<w:rStyle\b[^>]*\bw:val\s*=\s*["']([^"']+)["']/i);
  if (rStyleMatch) res.rStyle = rStyleMatch[1];
  return res;
}

function parseParaPropsXml(pPrXml) {
  if (!pPrXml) return {};
  const res = {};
  const styleM = pPrXml.match(/<w:pStyle\b[^>]*\bw:val\s*=\s*["']([^"']+)["']/i);
  if (styleM) res.styleId = styleM[1];
  const outM = pPrXml.match(/<w:outlineLvl\b[^>]*\bw:val\s*=\s*["'](\d+)["']/i);
  if (outM) res.outlineLvl = Number(outM[1]);
  const jcM = pPrXml.match(/<w:jc\b[^>]*\bw:val\s*=\s*["']([^"']+)["']/i);
  if (jcM) res.jc = jcM[1].toLowerCase();
  const indM = pPrXml.match(/<w:ind\b([^>]*)\/?>/i);
  if (indM) {
    const fl = Number(getTagAttr(indM[1], 'w:firstLine'));
    const left = Number(getTagAttr(indM[1], 'w:left') || getTagAttr(indM[1], 'w:start'));
    if (Number.isFinite(fl) && fl > 0) res.firstLinePt = fl / 20;
    if (Number.isFinite(left) && left > 0) res.leftPt = left / 20;
  }
  const spM = pPrXml.match(/<w:spacing\b([^>]*)\/?>/i);
  if (spM) {
    const before = Number(getTagAttr(spM[1], 'w:before'));
    const after = Number(getTagAttr(spM[1], 'w:after'));
    const line = Number(getTagAttr(spM[1], 'w:line'));
    const lineRule = getTagAttr(spM[1], 'w:lineRule').toLowerCase();
    if (Number.isFinite(before) && before >= 0) res.beforePt = before / 20;
    if (Number.isFinite(after) && after >= 0) res.afterPt = after / 20;
    if (Number.isFinite(line) && line > 0 && (!lineRule || lineRule === 'auto')) {
      res.lineHeight = Math.min(2.6, Math.max(1.15, line / 240));
    }
  }
  if (/<w:pageBreakBefore\b/i.test(pPrXml)) {
    const val = readXmlBool(pPrXml, 'w:pageBreakBefore');
    if (val !== false) res.pageBreakBefore = true;
  }
  const shdM = pPrXml.match(/<w:shd\b[^>]*\bw:fill\s*=\s*["']([^"']+)["']/i);
  if (shdM && /^[0-9a-f]{6}$/i.test(shdM[1])) res.bgColor = `#${shdM[1]}`;
  const bdrBottom = pPrXml.match(/<w:pBdr\b[^>]*>[\s\S]*?<w:bottom\b([^>]*)\/?>/i);
  if (bdrBottom) {
    const bVal = getTagAttr(bdrBottom[1], 'w:val').toLowerCase();
    if (bVal && bVal !== 'none' && bVal !== 'nil') res.borderBottom = true;
  }
  const numPr = pPrXml.match(/<w:numPr\b[^>]*>([\s\S]*?)<\/w:numPr>/i)?.[1];
  if (numPr) {
    const numId = numPr.match(/<w:numId\b[^>]*\bw:val\s*=\s*["'](\d+)["']/i)?.[1];
    const ilvl = numPr.match(/<w:ilvl\b[^>]*\bw:val\s*=\s*["'](\d+)["']/i)?.[1] || '0';
    if (numId && numId !== '0') {
      res.numId = numId;
      res.ilvl = Number(ilvl) || 0;
    }
  }
  const rPr = pPrXml.match(/<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/i)?.[1];
  if (rPr) res.rPr = parseRunPropsXml(rPr);
  return res;
}

function parseDocxStyles(zip) {
  const entry = zip.getEntry('word/styles.xml');
  const defaultRPr = {};
  const defaultPPr = {};
  const styles = new Map();

  if (entry) {
    const xml = entry.getData().toString('utf8');
    const docDef = xml.match(/<w:docDefaults\b[^>]*>([\s\S]*?)<\/w:docDefaults>/i)?.[1] || '';
    const rDef = docDef.match(/<w:rPrDefault\b[^>]*>[\s\S]*?<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/i)?.[1];
    const pDef = docDef.match(/<w:pPrDefault\b[^>]*>[\s\S]*?<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/i)?.[1];
    if (rDef) Object.assign(defaultRPr, parseRunPropsXml(rDef));
    if (pDef) Object.assign(defaultPPr, parseParaPropsXml(pDef));

    const styleBlocks = extractBalancedElements(xml, new Set(['w:style']));
    for (const sb of styleBlocks) {
      const id = getTagAttr(sb.attrs, 'w:styleId');
      if (!id) continue;
      const type = getTagAttr(sb.attrs, 'w:type').toLowerCase() || 'paragraph';
      const name = sb.inner.match(/<w:name\b[^>]*\bw:val\s*=\s*["']([^"']+)["']/i)?.[1] || '';
      const basedOn = sb.inner.match(/<w:basedOn\b[^>]*\bw:val\s*=\s*["']([^"']+)["']/i)?.[1] || '';
      const pPrXml = sb.inner.match(/<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/i)?.[1] || '';
      const rPrXml = sb.inner.match(/<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/i)?.[1] || '';
      styles.set(id, {
        id,
        type,
        name,
        basedOn,
        pPr: parseParaPropsXml(pPrXml),
        rPr: parseRunPropsXml(rPrXml),
      });
    }
  }

  const paraCache = new Map();
  const resolveParaStyle = (styleId, depth = 0) => {
    if (!styleId || depth > 10) return { pPr: { ...defaultPPr }, rPr: { ...defaultRPr }, headingLevel: 0 };
    if (paraCache.has(styleId)) return paraCache.get(styleId);
    const meta = styles.get(styleId);
    if (!meta) return { pPr: { ...defaultPPr }, rPr: { ...defaultRPr }, headingLevel: 0 };
    const parent = meta.basedOn ? resolveParaStyle(meta.basedOn, depth + 1) : { pPr: { ...defaultPPr }, rPr: { ...defaultRPr }, headingLevel: 0 };
    const pPr = { ...parent.pPr, ...meta.pPr };
    const rPr = { ...parent.rPr, ...meta.rPr };
    let headingLevel = parent.headingLevel || 0;
    if (meta.pPr.outlineLvl !== undefined && meta.pPr.outlineLvl >= 0 && meta.pPr.outlineLvl <= 8) {
      headingLevel = Math.min(6, meta.pPr.outlineLvl + 1);
    } else {
      const nm = meta.name.match(/^(?:heading|标题)\s*([1-6])$/i) || styleId.match(/^(?:heading|h|标题)\s*([1-6])$/i);
      if (nm) headingLevel = Number(nm[1]);
    }
    const resolved = { pPr, rPr, headingLevel };
    paraCache.set(styleId, resolved);
    return resolved;
  };

  const resolveCharStyle = (styleId, depth = 0) => {
    if (!styleId || depth > 10) return {};
    const meta = styles.get(styleId);
    if (!meta) return {};
    const parent = meta.basedOn ? resolveCharStyle(meta.basedOn, depth + 1) : {};
    return { ...parent, ...meta.rPr };
  };

  return { defaultRPr, defaultPPr, resolveParaStyle, resolveCharStyle };
}

function parseDocxNumbering(zip) {
  const entry = zip.getEntry('word/numbering.xml');
  const numMap = new Map();
  if (!entry) return numMap;
  const xml = entry.getData().toString('utf8');

  const absMap = new Map();
  for (const abs of extractBalancedElements(xml, new Set(['w:abstractNum']))) {
    const absId = getTagAttr(abs.attrs, 'w:abstractNumId');
    if (!absId) continue;
    const lvls = new Map();
    for (const lvl of extractBalancedElements(abs.inner, new Set(['w:lvl']))) {
      const ilvl = Number(getTagAttr(lvl.attrs, 'w:ilvl') || '0');
      const fmt = lvl.inner.match(/<w:numFmt\b[^>]*\bw:val\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase() || 'decimal';
      lvls.set(ilvl, fmt === 'bullet' ? 'ul' : 'ol');
    }
    absMap.set(absId, lvls);
  }

  for (const numEl of extractBalancedElements(xml, new Set(['w:num']))) {
    const numId = getTagAttr(numEl.attrs, 'w:numId');
    const absId = numEl.inner.match(/<w:abstractNumId\b[^>]*\bw:val\s*=\s*["']([^"']+)["']/i)?.[1];
    if (numId && absId && absMap.has(absId)) {
      numMap.set(numId, absMap.get(absId));
    }
  }
  return numMap;
}

function parseDocxRels(zip) {
  const entry = zip.getEntry('word/_rels/document.xml.rels');
  const map = new Map();
  if (!entry) return map;
  const xml = entry.getData().toString('utf8');
  const relRe = /<Relationship\b([^>]*?)\s*\/?>/gi;
  let m;
  while ((m = relRe.exec(xml))) {
    const attrs = m[1];
    const id = getTagAttr(attrs, 'Id');
    const target = getTagAttr(attrs, 'Target');
    const mode = getTagAttr(attrs, 'TargetMode');
    if (!id || !target) continue;
    const external = /^External$/i.test(mode);
    map.set(id, {
      external,
      target: external ? target : normalizeZipTarget('word', target),
    });
  }
  return map;
}

function buildDocxHtmlDocument(docxPath, mediaOutDir = null, opts = {}) {
  const ext = path.extname(String(docxPath || '')).slice(1).toLowerCase();
  if (ext === 'doc') {
    throw new Error('暂不支持旧版 .doc 二进制格式，请先在 Word/WPS 中另存为 .docx');
  }
  if (ext !== 'docx') {
    throw new Error('请选择 Word (.docx) 文档');
  }

  let zip;
  try {
    zip = new AdmZip(docxPath);
  } catch {
    throw new Error('无法解析该 Word 文档（文件可能已损坏或并非有效 .docx）');
  }

  const docEntry = zip.getEntry('word/document.xml');
  if (!docEntry) {
    throw new Error('该 .docx 缺少正文内容（word/document.xml）');
  }

  const docXml = docEntry.getData().toString('utf8');
  const relsMap = parseDocxRels(zip);
  const styleCtx = parseDocxStyles(zip);
  const numMap = parseDocxNumbering(zip);

  // 页面尺寸与边距解析（1440 twips = 1 inch）
  const sectPrMatches = docXml.match(/<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>/gi);
  const lastSectPr = sectPrMatches ? sectPrMatches[sectPrMatches.length - 1] : '';
  const pgSzAttrs = lastSectPr.match(/<w:pgSz\b([^>]*)\/?>/i)?.[1] || '';
  const pgMarAttrs = lastSectPr.match(/<w:pgMar\b([^>]*)\/?>/i)?.[1] || '';

  const rawW = Number(getTagAttr(pgSzAttrs, 'w:w')) || 11906;
  const rawH = Number(getTagAttr(pgSzAttrs, 'w:h')) || 16838;
  const orient = getTagAttr(pgSzAttrs, 'w:orient').toLowerCase();
  let widthIn = rawW / 1440;
  let heightIn = rawH / 1440;
  let landscape = orient === 'landscape' || widthIn > heightIn;

  if (opts.pageSize === 'a4p') {
    widthIn = 8.27;
    heightIn = 11.69;
    landscape = false;
  } else if (opts.pageSize === 'a4l') {
    widthIn = 11.69;
    heightIn = 8.27;
    landscape = true;
  } else if (opts.pageSize === 'letter') {
    widthIn = 8.5;
    heightIn = 11;
    landscape = false;
  }

  const clampMargin = (v, defIn) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return defIn;
    return Math.min(2.2, Math.max(0.25, n / 1440));
  };
  let marginsIn = {
    top: clampMargin(getTagAttr(pgMarAttrs, 'w:top'), 0.85),
    right: clampMargin(getTagAttr(pgMarAttrs, 'w:right'), 0.9),
    bottom: clampMargin(getTagAttr(pgMarAttrs, 'w:bottom'), 0.85),
    left: clampMargin(getTagAttr(pgMarAttrs, 'w:left'), 0.9),
  };
  if (opts.margin === 'narrow') {
    marginsIn = { top: 0.39, right: 0.39, bottom: 0.39, left: 0.39 };
  } else if (opts.margin === 'normal') {
    marginsIn = { top: 0.59, right: 0.59, bottom: 0.59, left: 0.59 };
  } else if (opts.margin === 'wide') {
    marginsIn = { top: 0.87, right: 0.87, bottom: 0.87, left: 0.87 };
  }

  const extractedImages = new Map();
  let imageCounter = 0;
  let tableCounter = 0;
  let docTitle = '';

  const resolveImageSrc = (rId) => {
    const rel = relsMap.get(rId);
    if (!rel || rel.external) return '';
    const entryName = rel.target;
    if (extractedImages.has(entryName)) return extractedImages.get(entryName);
    const entry = zip.getEntry(entryName);
    if (!entry) return '';
    const imgExt = path.posix.extname(entryName).slice(1).toLowerCase();
    if (imgExt === 'emf' || imgExt === 'wmf') return '';
    const buf = entry.getData();
    imageCounter++;
    let src = '';
    if (mediaOutDir) {
      fs.mkdirSync(mediaOutDir, { recursive: true });
      const fileName = `media_${String(imageCounter).padStart(4, '0')}.${imgExt || 'png'}`;
      const diskPath = path.join(mediaOutDir, fileName);
      fs.writeFileSync(diskPath, buf);
      src = pathToFileURL(diskPath).href;
    } else {
      const mime = imgExt === 'jpg' || imgExt === 'jpeg' ? 'image/jpeg' : `image/${imgExt || 'png'}`;
      src = `data:${mime};base64,${buf.toString('base64')}`;
    }
    extractedImages.set(entryName, src);
    return src;
  };

  const renderOmmlInner = (xml) => {
    const nodes = extractBalancedElements(
      xml,
      new Set(['m:r', 'm:t', 'm:f', 'm:sSup', 'm:sSub', 'm:sSubSup', 'm:rad', 'm:nary', 'm:d', 'm:m', 'm:limLow', 'm:limUpp']),
    );
    if (!nodes.length) {
      return escapeHtml(decodeXmlEntities(String(xml || '').replace(/<[^>]+>/g, ''))).trim();
    }
    const out = [];
    for (const node of nodes) {
      const tag = node.tag.toLowerCase();
      if (tag === 'm:r' || tag === 'm:t') {
        if (tag === 'm:t') {
          out.push(escapeHtml(decodeXmlEntities(node.inner)));
        } else {
          const ts = extractBalancedElements(node.inner, new Set(['m:t', 'w:t']));
          out.push(ts.map((t) => escapeHtml(decodeXmlEntities(t.inner))).join(''));
        }
      } else if (tag === 'm:f') {
        const numEl = extractBalancedElements(node.inner, new Set(['m:num']))[0];
        const denEl = extractBalancedElements(node.inner, new Set(['m:den']))[0];
        const nHtml = numEl ? renderOmmlInner(numEl.inner) : '';
        const dHtml = denEl ? renderOmmlInner(denEl.inner) : '';
        out.push(`(${nHtml})/(${dHtml})`);
      } else if (tag === 'm:ssup' || tag === 'm:ssub' || tag === 'm:ssubsup') {
        const parts = extractBalancedElements(node.inner, new Set(['m:e', 'm:sub', 'm:sup']));
        const baseEl = parts.find((p) => p.tag.toLowerCase() === 'm:e');
        const subEl = parts.find((p) => p.tag.toLowerCase() === 'm:sub');
        const supEl = parts.find((p) => p.tag.toLowerCase() === 'm:sup');
        let frag = baseEl ? renderOmmlInner(baseEl.inner) : '';
        if (subEl) frag += `<sub>${renderOmmlInner(subEl.inner)}</sub>`;
        if (supEl) frag += `<sup>${renderOmmlInner(supEl.inner)}</sup>`;
        out.push(frag);
      } else if (tag === 'm:rad') {
        const parts = extractBalancedElements(node.inner, new Set(['m:deg', 'm:e']));
        const degEl = parts.find((p) => p.tag.toLowerCase() === 'm:deg');
        const eEl = parts.find((p) => p.tag.toLowerCase() === 'm:e');
        const degHtml = degEl ? renderOmmlInner(degEl.inner).trim() : '';
        const baseHtml = eEl ? renderOmmlInner(eEl.inner) : '';
        out.push(`${degHtml ? `<sup>${degHtml}</sup>` : ''}√(${baseHtml})`);
      } else if (tag === 'm:nary') {
        const chr = node.inner.match(/<m:chr\b[^>]*\bm:val\s*=\s*["']([^"']+)["']/i)?.[1] || '∑';
        const parts = extractBalancedElements(node.inner, new Set(['m:sub', 'm:sup', 'm:e']));
        const subEl = parts.find((p) => p.tag.toLowerCase() === 'm:sub');
        const supEl = parts.find((p) => p.tag.toLowerCase() === 'm:sup');
        const eEl = parts.find((p) => p.tag.toLowerCase() === 'm:e');
        let frag = escapeHtml(decodeXmlEntities(chr));
        if (subEl) frag += `<sub>${renderOmmlInner(subEl.inner)}</sub>`;
        if (supEl) frag += `<sup>${renderOmmlInner(supEl.inner)}</sup>`;
        if (eEl) frag += ` ${renderOmmlInner(eEl.inner)}`;
        out.push(frag);
      } else if (tag === 'm:d') {
        const beg = node.inner.match(/<m:begChr\b[^>]*\bm:val\s*=\s*["']([^"']*)["']/i)?.[1] ?? '(';
        const end = node.inner.match(/<m:endChr\b[^>]*\bm:val\s*=\s*["']([^"']*)["']/i)?.[1] ?? ')';
        const es = extractBalancedElements(node.inner, new Set(['m:e']));
        out.push(`${escapeHtml(decodeXmlEntities(beg))}${es.map((e) => renderOmmlInner(e.inner)).join(', ')}${escapeHtml(decodeXmlEntities(end))}`);
      } else if (tag === 'm:m') {
        const rows = extractBalancedElements(node.inner, new Set(['m:mr']));
        const rowStr = rows.map((mr) => {
          const cells = extractBalancedElements(mr.inner, new Set(['m:e']));
          return cells.map((c) => renderOmmlInner(c.inner)).join(', ');
        }).join('; ');
        out.push(`[${rowStr}]`);
      } else if (tag === 'm:limlow' || tag === 'm:limupp') {
        const eEl = extractBalancedElements(node.inner, new Set(['m:e']))[0];
        const limEl = extractBalancedElements(node.inner, new Set(['m:lim']))[0];
        const eHtml = eEl ? renderOmmlInner(eEl.inner) : '';
        const lHtml = limEl ? renderOmmlInner(limEl.inner) : '';
        out.push(tag === 'm:limlow' ? `${eHtml}<sub>${lHtml}</sub>` : `${eHtml}<sup>${lHtml}</sup>`);
      }
    }
    return out.join('');
  };

  const renderOmmlXml = (ommlRaw) => {
    const inner = renderOmmlInner(ommlRaw).trim();
    if (!inner) return '';
    return `<span class="docx-math">${inner}</span>`;
  };

  const renderRunXml = (runXml, inheritedRPr = {}) => {
    const rPrXml = runXml.match(/<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/i)?.[1] || '';
    const localRPr = parseRunPropsXml(rPrXml);
    const charStyleRPr = localRPr.rStyle ? styleCtx.resolveCharStyle(localRPr.rStyle) : {};
    const merged = { ...styleCtx.defaultRPr, ...inheritedRPr, ...charStyleRPr, ...localRPr };

    const styles = [];
    if (merged.fontSizePt) styles.push(`font-size:${merged.fontSizePt}pt`);
    if (merged.color) styles.push(`color:${merged.color}`);
    if (merged.bgColor) styles.push(`background:${merged.bgColor}`);
    if (merged.highlight) styles.push(`background:${escapeHtml(merged.highlight)}`);
    if (merged.bold) styles.push('font-weight:700');
    if (merged.italic) styles.push('font-style:italic');
    if (merged.underline && merged.strike) styles.push('text-decoration:underline line-through');
    else if (merged.underline) styles.push('text-decoration:underline');
    else if (merged.strike) styles.push('text-decoration:line-through');

    const renderDrawingOrPict = (inner) => {
      const rendered = [];
      const txbxList = extractBalancedElements(inner, new Set(['w:txbxContent']));
      if (txbxList.length) {
        for (const txbx of txbxList) {
          const boxHtml = renderContainerXml(txbx.inner).trim();
          if (boxHtml && boxHtml.replace(/<[^>]+>/g, '').trim()) {
            rendered.push(`<div class="docx-textbox">${boxHtml}</div>`);
          }
        }
      }
      const embedId = inner.match(/<a:blip\b[^>]*\br:embed\s*=\s*["']([^"']+)["']/i)?.[1]
        || inner.match(/<v:imagedata\b[^>]*\br:id\s*=\s*["']([^"']+)["']/i)?.[1];
      if (embedId) {
        const src = resolveImageSrc(embedId);
        if (src) {
          const extM = inner.match(/<wp:extent\b([^>]*)\/?>/i)?.[1] || '';
          const cx = Number(getTagAttr(extM, 'cx'));
          const sizeStyle = Number.isFinite(cx) && cx > 0
            ? `width:${(cx / 12700).toFixed(1)}pt;max-width:100%;height:auto;`
            : 'max-width:100%;height:auto;';
          rendered.push(`<img src="${escapeHtml(src)}" style="${sizeStyle}" alt="" />`);
        }
      }
      return rendered.join('');
    };

    const parts = [];
    const blockParts = [];
    const runInner = runXml.replace(/^\s*<w:r\b[^>]*>/i, '').replace(/<\/w:r>\s*$/i, '');
    const tokens = extractBalancedElements(
      runInner,
      new Set(['w:t', 'w:tab', 'w:br', 'w:cr', 'w:drawing', 'w:pict', 'mc:AlternateContent']),
    );
    for (const tok of tokens) {
      const tag = tok.tag.toLowerCase();
      const attrs = tok.attrs || '';
      const inner = tok.inner || '';
      if (tag === 'w:t') {
        let text = escapeHtml(decodeXmlEntities(inner));
        if (/preserve/i.test(attrs)) {
          text = text.replace(/  +/g, (sp) => '&nbsp;'.repeat(sp.length - 1) + ' ');
        }
        parts.push(text);
      } else if (tag === 'w:tab') {
        parts.push('<span class="docx-tab"></span>');
      } else if (tag === 'w:br' || tag === 'w:cr') {
        const brType = getTagAttr(attrs, 'w:type').toLowerCase();
        if (brType === 'page') {
          blockParts.push('<div class="page-break"></div>');
        } else {
          parts.push('<br />');
        }
      } else if (tag === 'w:drawing' || tag === 'w:pict') {
        const outHtml = renderDrawingOrPict(inner);
        if (outHtml) {
          if (outHtml.includes('<div class="docx-textbox">')) blockParts.push(outHtml);
          else parts.push(outHtml);
        }
      } else if (tag === 'mc:alternatecontent') {
        const choice = extractBalancedElements(inner, new Set(['mc:Choice']))[0];
        const fallback = extractBalancedElements(inner, new Set(['mc:Fallback']))[0];
        const branchInner = (choice || fallback)?.inner || '';
        if (branchInner) {
          const branchDraws = extractBalancedElements(branchInner, new Set(['w:drawing', 'w:pict']));
          for (const bd of branchDraws) {
            const outHtml = renderDrawingOrPict(bd.inner);
            if (outHtml) {
              if (outHtml.includes('<div class="docx-textbox">')) blockParts.push(outHtml);
              else parts.push(outHtml);
            }
          }
        }
      }
    }

    const content = parts.join('');
    let inlineHtml = '';
    if (content) {
      let html = content;
      if (merged.vertAlign === 'superscript') html = `<sup>${html}</sup>`;
      else if (merged.vertAlign === 'subscript') html = `<sub>${html}</sub>`;
      inlineHtml = styles.length ? `<span style="${styles.join(';')}">${html}</span>` : html;
    }
    return inlineHtml + blockParts.join('');
  };

  const renderParaInline = (pXml, inheritedRPr = {}) => {
    const children = extractBalancedElements(pXml, new Set(['w:r', 'w:hyperlink', 'w:ins', 'm:oMathPara', 'm:oMath']));
    const out = [];
    for (const ch of children) {
      if (ch.tag === 'w:r') {
        out.push(renderRunXml(ch.raw, inheritedRPr));
      } else if (ch.tag === 'w:hyperlink') {
        const rId = getTagAttr(ch.attrs, 'r:id');
        const rel = rId ? relsMap.get(rId) : null;
        const innerRuns = extractBalancedElements(ch.inner, new Set(['w:r', 'm:oMath']));
        const innerHtml = innerRuns.map((r) => (r.tag === 'w:r' ? renderRunXml(r.raw, inheritedRPr) : renderOmmlXml(r.inner))).join('');
        if (rel?.external && /^(https?:|mailto:)/i.test(rel.target)) {
          out.push(`<a href="${escapeHtml(rel.target)}">${innerHtml}</a>`);
        } else {
          out.push(innerHtml);
        }
      } else if (ch.tag === 'w:ins') {
        const innerRuns = extractBalancedElements(ch.inner, new Set(['w:r', 'm:oMath']));
        out.push(innerRuns.map((r) => (r.tag === 'w:r' ? renderRunXml(r.raw, inheritedRPr) : renderOmmlXml(r.inner))).join(''));
      } else if (ch.tag === 'm:oMathPara' || ch.tag === 'm:oMath') {
        out.push(renderOmmlXml(ch.inner));
      }
    }
    return out.join('');
  };

  const renderParagraph = (pXml, { inTable = false } = {}) => {
    const pPrXml = pXml.match(/<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/i)?.[1] || '';
    const localPPr = parseParaPropsXml(pPrXml);
    const styleInfo = localPPr.styleId ? styleCtx.resolveParaStyle(localPPr.styleId) : { pPr: { ...styleCtx.defaultPPr }, rPr: { ...styleCtx.defaultRPr }, headingLevel: 0 };
    const pPr = { ...styleInfo.pPr, ...localPPr };
    const inheritedRPr = { ...styleInfo.rPr, ...(localPPr.rPr || {}) };

    let headingLevel = styleInfo.headingLevel || 0;
    if (localPPr.outlineLvl !== undefined && localPPr.outlineLvl >= 0 && localPPr.outlineLvl <= 8) {
      headingLevel = Math.min(6, localPPr.outlineLvl + 1);
    }

    const inlineHtml = renderParaInline(pXml, inheritedRPr);
    const plainText = inlineHtml.replace(/<[^>]+>/g, '').trim();
    if (!docTitle && headingLevel === 1 && plainText) {
      docTitle = plainText;
    }

    const css = [];
    if (pPr.jc) {
      const jcMap = { left: 'left', center: 'center', right: 'right', both: 'justify', distribute: 'justify' };
      if (jcMap[pPr.jc]) css.push(`text-align:${jcMap[pPr.jc]}`);
    }
    if (pPr.firstLinePt) css.push(`text-indent:${pPr.firstLinePt.toFixed(1)}pt`);
    if (pPr.leftPt && !pPr.numId) css.push(`margin-left:${pPr.leftPt.toFixed(1)}pt`);
    if (pPr.beforePt !== undefined) css.push(`margin-top:${pPr.beforePt.toFixed(1)}pt`);
    if (pPr.afterPt !== undefined) css.push(`margin-bottom:${pPr.afterPt.toFixed(1)}pt`);
    if (pPr.lineHeight) css.push(`line-height:${pPr.lineHeight.toFixed(2)}`);
    if (pPr.bgColor) css.push(`background:${pPr.bgColor};padding:4px 8px;border-radius:4px`);
    if (pPr.borderBottom) css.push('border-bottom:1px solid #cbd5e1;padding-bottom:4px');

    const styleAttr = css.length ? ` style="${css.join(';')}"` : '';
    const breakHtml = pPr.pageBreakBefore ? '<div class="page-break"></div>' : '';

    if (!inTable && pPr.numId) {
      const listKind = numMap.get(pPr.numId)?.get(pPr.ilvl || 0) || 'ul';
      return {
        kind: 'listItem',
        listKind,
        ilvl: pPr.ilvl || 0,
        breakHtml,
        html: `<li${styleAttr}>${inlineHtml || '&nbsp;'}</li>`,
      };
    }

    if (headingLevel >= 1 && headingLevel <= 6 && plainText) {
      return {
        kind: 'block',
        html: `${breakHtml}<h${headingLevel}${styleAttr}>${inlineHtml}</h${headingLevel}>`,
      };
    }

    if (!inlineHtml) {
      return {
        kind: 'block',
        html: `${breakHtml}<p class="empty-p"${styleAttr}>&nbsp;</p>`,
      };
    }

    return {
      kind: 'block',
      html: `${breakHtml}<p${styleAttr}>${inlineHtml}</p>`,
    };
  };

  const renderTable = (tblXml) => {
    tableCounter++;
    const rows = extractBalancedElements(tblXml, new Set(['w:tr']));
    const logicalRows = [];
    const activeVMerge = []; // colIdx -> originCell

    for (const tr of rows) {
      const tcs = extractBalancedElements(tr.inner, new Set(['w:tc']));
      const rowCells = [];
      let colIdx = 0;

      for (const tc of tcs) {
        const tcPr = tc.inner.match(/<w:tcPr\b[^>]*>([\s\S]*?)<\/w:tcPr>/i)?.[1] || '';
        const span = Math.max(1, Number(tcPr.match(/<w:gridSpan\b[^>]*\bw:val\s*=\s*["'](\d+)["']/i)?.[1]) || 1);
        const vMergeM = tcPr.match(/<w:vMerge\b([^>]*)\/?>/i);
        const vMergeMode = vMergeM ? (getTagAttr(vMergeM[1], 'w:val').toLowerCase() === 'restart' ? 'restart' : 'continue') : '';

        if (vMergeMode === 'continue' && activeVMerge[colIdx]) {
          activeVMerge[colIdx].rowspan += 1;
          colIdx += span;
          continue;
        }

        const fill = tcPr.match(/<w:shd\b[^>]*\bw:fill\s*=\s*["']([^"']+)["']/i)?.[1];
        const vAlign = tcPr.match(/<w:vAlign\b[^>]*\bw:val\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
        const children = extractBalancedElements(tc.inner, new Set(['w:p', 'w:tbl']));
        const cellInner = children.map((ch) => (ch.tag === 'w:tbl' ? renderTable(ch.raw) : renderParagraph(ch.raw, { inTable: true }).html)).join('');

        const cellObj = {
          colspan: span,
          rowspan: 1,
          bgColor: fill && /^[0-9a-f]{6}$/i.test(fill) ? `#${fill}` : '',
          vAlign: vAlign === 'center' ? 'middle' : (vAlign === 'bottom' ? 'bottom' : 'top'),
          html: cellInner || '&nbsp;',
        };
        rowCells.push(cellObj);

        if (vMergeMode === 'restart') {
          activeVMerge[colIdx] = cellObj;
        } else {
          activeVMerge[colIdx] = null;
        }
        colIdx += span;
      }
      logicalRows.push(rowCells);
    }

    const trsHtml = logicalRows.map((cells, rowIdx) => {
      const tds = cells.map((c) => {
        const tag = rowIdx === 0 ? 'th' : 'td';
        const attrs = [];
        if (c.colspan > 1) attrs.push(`colspan="${c.colspan}"`);
        if (c.rowspan > 1) attrs.push(`rowspan="${c.rowspan}"`);
        const st = [`vertical-align:${c.vAlign}`];
        if (c.bgColor) st.push(`background:${c.bgColor}`);
        attrs.push(`style="${st.join(';')}"`);
        return `<${tag} ${attrs.join(' ')}>${c.html}</${tag}>`;
      }).join('');
      return `<tr>${tds}</tr>`;
    }).join('\n');

    return `<table class="docx-table"><tbody>${trsHtml}</tbody></table>`;
  };

  const renderContainerXml = (containerXml) => {
    const nodes = extractBalancedElements(containerXml, new Set(['w:p', 'w:tbl', 'w:sdt']));
    const out = [];
    let openList = null;

    const flushList = () => {
      if (openList) {
        out.push(`</${openList}>`);
        openList = null;
      }
    };

    for (const node of nodes) {
      if (node.tag === 'w:sdt') {
        flushList();
        const sdtContent = node.inner.match(/<w:sdtContent\b[^>]*>([\s\S]*?)<\/w:sdtContent>/i)?.[1] || node.inner;
        out.push(renderContainerXml(sdtContent));
        continue;
      }
      if (node.tag === 'w:tbl') {
        flushList();
        out.push(renderTable(node.raw));
        continue;
      }
      const pRes = renderParagraph(node.raw);
      if (pRes.kind === 'listItem') {
        if (pRes.breakHtml) {
          flushList();
          out.push(pRes.breakHtml);
        }
        if (openList !== pRes.listKind) {
          flushList();
          openList = pRes.listKind;
          out.push(`<${openList} class="docx-list">`);
        }
        out.push(pRes.html);
      } else {
        flushList();
        out.push(pRes.html);
      }
    }
    flushList();
    return out.join('\n');
  };

  const resolveHeaderFooterHtml = (tagName, wrapperTag, clsName) => {
    const refs = extractBalancedElements(lastSectPr, new Set([tagName]));
    if (!refs.length) return '';
    const pick = refs.find((r) => getTagAttr(r.attrs, 'w:type').toLowerCase() === 'default') || refs[0];
    const rId = getTagAttr(pick.attrs, 'r:id');
    const rel = rId ? relsMap.get(rId) : null;
    if (!rel || rel.external) return '';
    const entry = zip.getEntry(rel.target);
    if (!entry) return '';
    const xml = entry.getData().toString('utf8');
    const rootTag = tagName.includes('header') ? 'w:hdr' : 'w:ftr';
    const rootEl = extractBalancedElements(xml, new Set([rootTag]))[0];
    const innerXml = rootEl ? rootEl.inner : xml;
    const html = renderContainerXml(innerXml).trim();
    const plain = html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim();
    if (!plain && !/<img\b/i.test(html)) return '';
    return `<${wrapperTag} class="${clsName}">${html}</${wrapperTag}>`;
  };

  const bodyXml = docXml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/i)?.[1] || docXml;
  const bodyHtml = renderContainerXml(bodyXml);
  const headerHtml = resolveHeaderFooterHtml('w:headerReference', 'header', 'docx-header');
  const footerHtml = resolveHeaderFooterHtml('w:footerReference', 'footer', 'docx-footer');
  const title = docTitle || path.basename(docxPath, path.extname(docxPath));

  const wMm = (widthIn * 25.4).toFixed(1);
  const hMm = (heightIn * 25.4).toFixed(1);
  const mtMm = (marginsIn.top * 25.4).toFixed(1);
  const mrMm = (marginsIn.right * 25.4).toFixed(1);
  const mbMm = (marginsIn.bottom * 25.4).toFixed(1);
  const mlMm = (marginsIn.left * 25.4).toFixed(1);

  const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page {
      size: ${wMm}mm ${hMm}mm;
      margin: ${mtMm}mm ${mrMm}mm ${mbMm}mm ${mlMm}mm;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      color: #111827;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      font-family: "Microsoft YaHei UI", "PingFang SC", "SimSun", "Segoe UI", sans-serif;
      font-size: 11pt;
      line-height: 1.65;
    }
    .docx-body { width: 100%; word-wrap: break-word; }
    .docx-header {
      margin: 0 0 10pt;
      padding-bottom: 4pt;
      border-bottom: 1px solid #e2e8f0;
      font-size: 9pt;
      color: #64748b;
    }
    .docx-footer {
      margin: 14pt 0 0;
      padding-top: 4pt;
      border-top: 1px solid #e2e8f0;
      font-size: 9pt;
      color: #64748b;
    }
    .docx-textbox {
      margin: 6pt 0 8pt;
      padding: 8pt 10pt;
      border: 1px solid #cbd5e1;
      border-left: 3pt solid #3b82f6;
      background: #f8fafc;
      border-radius: 4pt;
    }
    .docx-math {
      font-family: "Cambria Math", "Times New Roman", serif;
      font-style: italic;
      padding: 0 2pt;
    }
    h1, h2, h3, h4, h5, h6 {
      color: #0f172a;
      font-weight: 700;
      line-height: 1.35;
      margin: 1.1em 0 0.45em;
      break-after: avoid;
      page-break-after: avoid;
    }
    h1 { font-size: 20pt; }
    h2 { font-size: 16pt; }
    h3 { font-size: 13.5pt; }
    h4 { font-size: 12pt; }
    p { margin: 0 0 6pt; }
    p.empty-p { margin: 0 0 3pt; line-height: 1.1; }
    a { color: #2563eb; text-decoration: underline; }
    img { max-width: 100%; height: auto; vertical-align: middle; }
    .docx-tab { display: inline-block; width: 2em; }
    .page-break { break-before: page; page-break-before: always; height: 0; margin: 0; }
    ul.docx-list, ol.docx-list { margin: 4pt 0 8pt; padding-left: 1.8em; }
    ul.docx-list li, ol.docx-list li { margin: 2pt 0; }
    table.docx-table {
      width: 100%;
      border-collapse: collapse;
      margin: 8pt 0 12pt;
      font-size: 10pt;
      table-layout: auto;
    }
    table.docx-table tr { break-inside: avoid; page-break-inside: avoid; }
    table.docx-table th, table.docx-table td {
      border: 1px solid #cbd5e1;
      padding: 5pt 7pt;
      text-align: left;
    }
    table.docx-table th { background: #f1f5f9; font-weight: 700; }
    table.docx-table td p { margin: 0 0 3pt; }
    table.docx-table td p:last-child { margin-bottom: 0; }
  </style>
</head>
<body>
  <article class="docx-body">${headerHtml}${bodyHtml}${footerHtml}</article>
</body>
</html>`;

  return {
    html: fullHtml,
    title,
    pageConfig: { widthIn, heightIn, landscape, marginsIn },
    imageCount: imageCounter,
    tableCount: tableCounter,
  };
}

let officeComCircuitBroken = false;

function findLibreOfficeBinary() {
  if (process.env.VGT_DISABLE_LIBREOFFICE === '1') return '';
  const envBin = String(process.env.VGT_SOFFICE_PATH || '').trim();
  if (envBin && fs.existsSync(envBin)) return envBin;
  const fixedCandidates = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ];
  for (const cand of fixedCandidates) {
    try {
      if (fs.existsSync(cand)) return cand;
    } catch {}
  }
  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const p = path.join(dir, 'soffice.exe');
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return '';
}

function tryConvertViaLibreOffice(inputPath, outputPath, { taskId = null, timeoutMs = 20000 } = {}) {
  throwIfTaskCancelled(taskId);
  const soffice = findLibreOfficeBinary();
  if (!soffice) return Promise.resolve({ ok: false, reason: 'not_found' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_lo_'));
  const ext = path.extname(String(inputPath || '')).toLowerCase() || '.docx';
  const stagedIn = path.join(tmpDir, `input${ext}`);
  const outDir = path.join(tmpDir, 'out');
  const profileDir = path.join(tmpDir, 'profile');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  fs.copyFileSync(inputPath, stagedIn);

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const args = [
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      '--headless',
      '--norestore',
      '--nolockcheck',
      '--nodefault',
      '--nofirststartwizard',
      '--convert-to', 'pdf',
      '--outdir', outDir,
      stagedIn,
    ];
    const child = spawn(soffice, args, { windowsHide: true });

    const killChild = () => {
      if (child.pid) {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } catch {}
      }
    };

    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        killChild();
      }
    }, Math.max(3000, Number(timeoutMs) || 20000));

    const release = registerCancelableTask(taskId, () => {
      cancelled = true;
      killChild();
      return true;
    });

    const cleanup = () => {
      clearTimeout(timer);
      release();
      try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch {}
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: false, reason: err?.message || 'spawn_error' });
    });

    child.on('close', () => {
      if (settled) return;
      settled = true;
      if (cancelled) {
        cleanup();
        return resolve({ ok: false, cancelled: true, reason: 'cancelled' });
      }
      if (timedOut) {
        cleanup();
        return resolve({ ok: false, timedOut: true, reason: 'timeout' });
      }
      try {
        const expected = path.join(outDir, 'input.pdf');
        const pdfFile = fs.existsSync(expected)
          ? expected
          : fs.readdirSync(outDir).map((f) => path.join(outDir, f)).find((f) => f.toLowerCase().endsWith('.pdf'));
        if (pdfFile && fs.existsSync(pdfFile)) {
          const buf = fs.readFileSync(pdfFile);
          if (buf.length > 64 && buf.subarray(0, 5).toString('ascii') === '%PDF-') {
            cleanup();
            return resolve({ ok: true, engineUsed: 'libreoffice', pdfBuf: buf });
          }
        }
      } catch (err) {
        cleanup();
        return resolve({ ok: false, reason: err?.message || 'read_error' });
      }
      cleanup();
      resolve({ ok: false, reason: 'no_output' });
    });
  });
}

function tryConvertViaOfficeCom(inputPath, { taskId = null, timeoutMs = 10000 } = {}) {
  throwIfTaskCancelled(taskId);
  if (process.env.VGT_DISABLE_OFFICE_COM === '1') {
    return Promise.resolve({ ok: false, reason: 'disabled' });
  }
  if (officeComCircuitBroken) {
    return Promise.resolve({ ok: false, broken: true, reason: 'circuit_broken' });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_com_'));
  const ext = path.extname(String(inputPath || '')).toLowerCase() || '.docx';
  const stagedIn = path.join(tmpDir, `input${ext}`);
  const outPdf = path.join(tmpDir, 'output.pdf');
  fs.copyFileSync(inputPath, stagedIn);

  const psScript = `
$ErrorActionPreference = 'Stop'
$inPath = $env:VGT_OFFICE_IN
$outPath = $env:VGT_OFFICE_OUT
$hasWord = Test-Path 'Registry::HKEY_CLASSES_ROOT\\Word.Application'
$hasKwps = Test-Path 'Registry::HKEY_CLASSES_ROOT\\KWPS.Application'
$hasWps  = Test-Path 'Registry::HKEY_CLASSES_ROOT\\Wps.Application'
if (-not ($hasWord -or $hasKwps -or $hasWps)) {
  [Console]::Out.WriteLine('NO_OFFICE_COM')
  exit 2
}
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class VgtOfficeWin32 {
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@
$candidates = @()
if ($hasWord) { $candidates += @{ ProgId = 'Word.Application'; Proc = 'WINWORD'; Engine = 'word' } }
if ($hasKwps) { $candidates += @{ ProgId = 'KWPS.Application'; Proc = 'wps'; Engine = 'wps' } }
if ($hasWps)  { $candidates += @{ ProgId = 'Wps.Application';  Proc = 'wps'; Engine = 'wps' } }
$lastErr = ''
foreach ($cand in $candidates) {
  $app = $null
  $doc = $null
  $appPid = [uint32]0
  try {
    $before = @(Get-Process -Name $cand.Proc -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    $app = New-Object -ComObject $cand.ProgId
    try { $app.Visible = $false } catch {}
    try { $app.DisplayAlerts = 0 } catch {}
    try { $app.AutomationSecurity = 3 } catch {}
    try {
      $hwnd = [IntPtr]$app.Hwnd
      if ($hwnd -ne [IntPtr]::Zero) {
        [void][VgtOfficeWin32]::GetWindowThreadProcessId($hwnd, [ref]$appPid)
      }
    } catch {}
    if ($appPid -eq 0) {
      $after = @(Get-Process -Name $cand.Proc -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
      $diff = @($after | Where-Object { $before -notcontains $_ })
      if ($diff.Count -gt 0) { $appPid = [uint32]$diff[0] }
    }
    if ($appPid -gt 0) {
      [Console]::Out.WriteLine("OFFICE_PID:$appPid")
      [Console]::Out.Flush()
    }
    try {
      $doc = $app.Documents.Open($inPath, $false, $true, $false, '', '', $false, '', '', 0, 0, $false, $false, 0, $true)
    } catch {
      $doc = $app.Documents.Open($inPath, $false, $true)
    }
    try {
      $doc.ExportAsFixedFormat($outPath, 17, $false, 0, 0, 1, 1, 0, $true, $true, 1)
    } catch {
      try {
        $doc.ExportAsFixedFormat($outPath, 17)
      } catch {
        $doc.SaveAs($outPath, 17)
      }
    }
    if (Test-Path $outPath) {
      [Console]::Out.WriteLine("ENGINE_USED:$($cand.Engine)")
      [Console]::Out.Flush()
      exit 0
    }
    $lastErr = 'Office did not produce PDF output'
  } catch {
    $lastErr = $_.Exception.Message
  } finally {
    if ($doc) {
      try { $doc.Close(0) } catch {}
      try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc) } catch {}
    }
    if ($app) {
      try { $app.Quit(0) } catch {}
      try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) } catch {}
    }
    if ($appPid -gt 0) {
      Start-Sleep -Milliseconds 150
      $still = Get-Process -Id $appPid -ErrorAction SilentlyContinue
      if ($still) {
        try { Stop-Process -Id $appPid -Force -ErrorAction SilentlyContinue } catch {}
      }
    }
  }
}
[Console]::Error.WriteLine($lastErr)
exit 1
`;
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let trackedOfficePid = 0;
    let engineUsed = 'word';
    let lineBuf = '';
    let stderr = '';

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        windowsHide: true,
        env: { ...process.env, VGT_OFFICE_IN: stagedIn, VGT_OFFICE_OUT: outPdf },
      },
    );

    const killAll = () => {
      if (trackedOfficePid > 0) {
        try { spawn('taskkill', ['/pid', String(trackedOfficePid), '/T', '/F'], { windowsHide: true }); } catch {}
      }
      if (child.pid) {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {}
      }
    };

    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        officeComCircuitBroken = true;
        killAll();
      }
    }, Math.max(2000, Number(timeoutMs) || 10000));

    const release = registerCancelableTask(taskId, () => {
      cancelled = true;
      killAll();
      return true;
    });

    const handleLine = (line) => {
      const mPid = line.match(/^OFFICE_PID:(\d+)$/);
      if (mPid) trackedOfficePid = parseInt(mPid[1], 10) || 0;
      const mEng = line.match(/^ENGINE_USED:(word|wps)$/);
      if (mEng) engineUsed = mEng[1];
    };

    child.stdout.on('data', (chunk) => {
      lineBuf += chunk.toString('utf8');
      const lines = lineBuf.split(/\r?\n/);
      lineBuf = lines.pop() || '';
      for (const l of lines) {
        if (l.trim()) handleLine(l.trim());
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });

    const cleanup = () => {
      clearTimeout(timer);
      release();
      try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch {}
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: false, reason: err?.message || 'spawn_error' });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (lineBuf.trim()) handleLine(lineBuf.trim());
      if (cancelled) {
        cleanup();
        return resolve({ ok: false, cancelled: true, reason: 'cancelled' });
      }
      if (timedOut) {
        cleanup();
        return resolve({ ok: false, timedOut: true, broken: true, reason: 'timeout' });
      }
      if (code === 0 && fs.existsSync(outPdf)) {
        try {
          const buf = fs.readFileSync(outPdf);
          if (buf.length > 64 && buf.subarray(0, 5).toString('ascii') === '%PDF-') {
            cleanup();
            return resolve({ ok: true, engineUsed, pdfBuf: buf });
          }
        } catch (err) {
          cleanup();
          return resolve({ ok: false, reason: err?.message || 'read_error' });
        }
      }
      cleanup();
      resolve({ ok: false, reason: stderr.trim() || `exit_${code}` });
    });
  });
}

async function convertWordToPdfNative(inputPath, opts = {}) {
  const loRes = await tryConvertViaLibreOffice(inputPath, null, {
    taskId: opts.taskId,
    timeoutMs: opts.libreTimeoutMs,
  });
  if (loRes.ok || loRes.cancelled) return loRes;

  const comRes = await tryConvertViaOfficeCom(inputPath, {
    taskId: opts.taskId,
    timeoutMs: opts.comTimeoutMs,
  });
  return comRes;
}

async function convertWordToPdfBuiltin(inputPath, outputPath, opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_word2pdf_'));
  try {
    const mediaDir = path.join(tmpDir, 'media');
    const rendered = buildDocxHtmlDocument(inputPath, mediaDir, opts);
    const htmlPath = path.join(tmpDir, 'document.html');
    fs.writeFileSync(htmlPath, rendered.html, 'utf8');

    await renderHtmlFileToPdf(htmlPath, outputPath, {
      customPageSize: {
        widthIn: rendered.pageConfig.widthIn,
        heightIn: rendered.pageConfig.heightIn,
        landscape: rendered.pageConfig.landscape,
      },
      customMarginsIn: rendered.pageConfig.marginsIn,
      pageNumbers: opts.pageNumbers || 'no',
      taskId: opts.taskId,
    });

    const pageCount = await getPdfPageCount(outputPath);
    return {
      output: outputPath,
      title: rendered.title,
      pageCount,
      imageCount: rendered.imageCount,
      tableCount: rendered.tableCount,
      engineUsed: 'builtin',
      outputSize: fs.statSync(outputPath).size,
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch {}
  }
}

async function convertWordToPdf(inputPath, outputPath, opts = {}) {
  const ext = path.extname(String(inputPath || '')).slice(1).toLowerCase();
  if (ext !== 'docx' && ext !== 'doc') {
    throw new Error('请选择 Word (.docx / .doc) 文档');
  }

  const engine = ['auto', 'builtin', 'office'].includes(opts.engine) ? opts.engine : 'auto';
  const title = path.basename(inputPath, path.extname(inputPath));

  const commitNativePdf = (nativeRes) => {
    writeTaskOutput(outputPath, nativeRes.pdfBuf);
  };

  if (ext === 'doc') {
    if (engine === 'builtin') {
      throw new Error('旧版 .doc 二进制格式需使用本机 Office / WPS / LibreOffice 引擎（请将转换引擎设为“智能双引擎”或另存为 .docx）');
    }
    const nativeRes = await convertWordToPdfNative(inputPath, opts);
    if (nativeRes.cancelled) throw new Error('任务已取消');
    if (nativeRes.ok) {
      commitNativePdf(nativeRes);
      const pageCount = await getPdfPageCount(outputPath);
      return {
        output: outputPath,
        title,
        pageCount,
        imageCount: 0,
        tableCount: 0,
        engineUsed: nativeRes.engineUsed,
        outputSize: nativeRes.pdfBuf.length,
      };
    }
    throw new Error('转换旧版 .doc 需本机已激活可用的 Microsoft Word、WPS 或 LibreOffice；当前未检测到可用组件或组件无响应，请先另存为 .docx');
  }

  if (engine === 'office') {
    const nativeRes = await convertWordToPdfNative(inputPath, opts);
    if (nativeRes.cancelled) throw new Error('任务已取消');
    if (nativeRes.ok) {
      commitNativePdf(nativeRes);
      const pageCount = await getPdfPageCount(outputPath);
      return {
        output: outputPath,
        title,
        pageCount,
        imageCount: 0,
        tableCount: 0,
        engineUsed: nativeRes.engineUsed,
        outputSize: nativeRes.pdfBuf.length,
      };
    }
    if (nativeRes.broken) {
      throw new Error('本机 Office / WPS 组件无响应已自动保护终止，请关闭弹窗或切换为「智能双引擎 / 内置离线引擎」');
    }
    throw new Error('未检测到可用的本机 Word / WPS / LibreOffice 原生引擎，请切换为「智能双引擎」或「内置离线引擎」');
  }

  const hasCustomLayout = (opts.pageSize && opts.pageSize !== 'auto')
    || (opts.margin && opts.margin !== 'auto')
    || opts.pageNumbers === 'yes';

  if (engine === 'auto' && !hasCustomLayout) {
    const nativeRes = await convertWordToPdfNative(inputPath, opts);
    if (nativeRes.cancelled) throw new Error('任务已取消');
    if (nativeRes.ok) {
      commitNativePdf(nativeRes);
      const pageCount = await getPdfPageCount(outputPath);
      return {
        output: outputPath,
        title,
        pageCount,
        imageCount: 0,
        tableCount: 0,
        engineUsed: nativeRes.engineUsed,
        outputSize: nativeRes.pdfBuf.length,
      };
    }
  }

  return convertWordToPdfBuiltin(inputPath, outputPath, opts);
}

// ---------------------------------------------------------------------------
// 2. PDF → Word (.docx)：原生文本提取 + WinRT 离线 OCR + 版面保真模式
// ---------------------------------------------------------------------------

const WIN_ANSI_EXTRA = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

function decodeWinAnsiBytes(buf) {
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    out += String.fromCodePoint(WIN_ANSI_EXTRA[b] || b);
  }
  return out;
}

function decodeHexToUnicode(hexStr) {
  const clean = String(hexStr || '').replace(/\s+/g, '');
  if (!clean) return '';
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  const buf = Buffer.from(padded, 'hex');
  if (buf.length === 1) return String.fromCharCode(buf[0]);
  const chars = [];
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const u1 = buf.readUInt16BE(i);
    if (u1 >= 0xd800 && u1 <= 0xdbff && i + 3 < buf.length) {
      const u2 = buf.readUInt16BE(i + 2);
      if (u2 >= 0xdc00 && u2 <= 0xdfff) {
        chars.push(String.fromCodePoint(((u1 - 0xd800) << 10) + (u2 - 0xdc00) + 0x10000));
        i += 2;
        continue;
      }
    }
    chars.push(String.fromCharCode(u1));
  }
  return chars.join('');
}

function incrementUnicodeStr(baseStr, offset) {
  if (!offset || !baseStr) return baseStr;
  const cps = Array.from(baseStr).map((c) => c.codePointAt(0));
  cps[cps.length - 1] += offset;
  return String.fromCodePoint(...cps);
}

function parseToUnicodeCMap(cmapText) {
  const map = new Map();
  const codeLengths = new Set();

  const csRe = /begincodespacerange\s+([\s\S]*?)\s+endcodespacerange/g;
  let cm;
  while ((cm = csRe.exec(cmapText))) {
    const pairs = cm[1].match(/<[0-9a-fA-F]+>/g) || [];
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const hex = pairs[i].slice(1, -1).replace(/\s+/g, '');
      if (hex.length >= 2) codeLengths.add(Math.ceil(hex.length / 2));
    }
  }

  const bfCharRe = /beginbfchar\s+([\s\S]*?)\s+endbfchar/g;
  while ((cm = bfCharRe.exec(cmapText))) {
    const tokens = cm[1].match(/<[0-9a-fA-F]+>/g) || [];
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const src = tokens[i].slice(1, -1).toUpperCase();
      const dst = decodeHexToUnicode(tokens[i + 1].slice(1, -1));
      map.set(src, dst);
      codeLengths.add(Math.ceil(src.length / 2));
    }
  }

  const bfRangeRe = /beginbfrange\s+([\s\S]*?)\s+endbfrange/g;
  while ((cm = bfRangeRe.exec(cmapText))) {
    const body = cm[1];
    const entryRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:\[([\s\S]*?)\]|<([0-9a-fA-F]+)>)/g;
    let em;
    while ((em = entryRe.exec(body))) {
      const startHex = em[1].toUpperCase();
      const endHex = em[2].toUpperCase();
      const startCode = parseInt(startHex, 16);
      const endCode = parseInt(endHex, 16);
      const hexLen = Math.max(startHex.length, 2);
      const byteLen = Math.ceil(hexLen / 2);
      codeLengths.add(byteLen);
      if (endCode < startCode || endCode - startCode > 65536) continue;

      if (em[3] !== undefined) {
        const arrHex = em[3].match(/<[0-9a-fA-F]+>/g) || [];
        for (let i = 0; i < arrHex.length && startCode + i <= endCode; i++) {
          const k = (startCode + i).toString(16).toUpperCase().padStart(hexLen, '0');
          map.set(k, decodeHexToUnicode(arrHex[i].slice(1, -1)));
        }
      } else if (em[4] !== undefined) {
        const baseDst = decodeHexToUnicode(em[4]);
        for (let code = startCode; code <= endCode; code++) {
          const k = code.toString(16).toUpperCase().padStart(hexLen, '0');
          map.set(k, incrementUnicodeStr(baseDst, code - startCode));
        }
      }
    }
  }

  const lengths = Array.from(codeLengths).filter((l) => l > 0).sort((a, b) => b - a);
  if (!lengths.length) lengths.push(1);
  return { map, lengths };
}

function decodePdfStreamSafe(rawStream) {
  if (!(rawStream instanceof PDFRawStream)) return null;
  try {
    return Buffer.from(decodePDFRawStream(rawStream).decode());
  } catch {
    try {
      const filter = rawStream.dict.lookup(PDFName.of('Filter'));
      if (filter === PDFName.of('FlateDecode')) {
        return zlib.inflateSync(rawStream.contents);
      }
      if (!filter) return Buffer.from(rawStream.contents);
    } catch {}
  }
  return null;
}

function buildFontDecoder(context, fontDict) {
  if (!(fontDict instanceof PDFDict)) {
    return (buf) => decodeWinAnsiBytes(buf);
  }

  const toUniObj = fontDict.lookup(PDFName.of('ToUnicode'));
  let cmap = null;
  if (toUniObj instanceof PDFRawStream) {
    const decoded = decodePdfStreamSafe(toUniObj);
    if (decoded) {
      cmap = parseToUnicodeCMap(decoded.toString('latin1'));
    }
  }

  const encObj = fontDict.lookup(PDFName.of('Encoding'));
  const isIdentity = encObj instanceof PDFName && /Identity/i.test(encObj.asString());

  return (buf) => {
    if (!buf || !buf.length) return '';
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      return decodeHexToUnicode(buf.subarray(2).toString('hex'));
    }
    if (cmap && cmap.map.size > 0) {
      let out = '';
      for (let i = 0; i < buf.length;) {
        let matched = false;
        for (const len of cmap.lengths) {
          if (i + len <= buf.length) {
            const hex = buf.subarray(i, i + len).toString('hex').toUpperCase();
            if (cmap.map.has(hex)) {
              out += cmap.map.get(hex);
              i += len;
              matched = true;
              break;
            }
          }
        }
        if (!matched) {
          if (isIdentity && i + 1 < buf.length) {
            out += String.fromCharCode(buf.readUInt16BE(i));
            i += 2;
          } else {
            out += decodeWinAnsiBytes(buf.subarray(i, i + 1));
            i += 1;
          }
        }
      }
      return out;
    }
    return decodeWinAnsiBytes(buf);
  };
}

function tokenizePdfContent(buf) {
  const tokens = [];
  const len = buf.length;
  let i = 0;

  const isWs = (c) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c || c === 0x00;
  const isDelim = (c) =>
    c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;

  while (i < len) {
    const c = buf[i];
    if (isWs(c)) {
      i++;
      continue;
    }
    if (c === 0x25) {
      while (i < len && buf[i] !== 0x0a && buf[i] !== 0x0d) i++;
      continue;
    }
    if (c === 0x28) {
      // 字面量字符串 (...)
      i++;
      let depth = 1;
      const bytes = [];
      while (i < len && depth > 0) {
        const ch = buf[i++];
        if (ch === 0x5c) {
          if (i >= len) break;
          const esc = buf[i++];
          if (esc === 0x6e) bytes.push(0x0a);
          else if (esc === 0x72) bytes.push(0x0d);
          else if (esc === 0x74) bytes.push(0x09);
          else if (esc === 0x62) bytes.push(0x08);
          else if (esc === 0x66) bytes.push(0x0c);
          else if (esc === 0x0d) {
            if (i < len && buf[i] === 0x0a) i++;
          } else if (esc === 0x0a) {
            // 行延续忽略
          } else if (esc >= 0x30 && esc <= 0x37) {
            let oct = String.fromCharCode(esc);
            for (let k = 0; k < 2 && i < len && buf[i] >= 0x30 && buf[i] <= 0x37; k++) {
              oct += String.fromCharCode(buf[i++]);
            }
            bytes.push(parseInt(oct, 8) & 0xff);
          } else {
            bytes.push(esc);
          }
        } else if (ch === 0x28) {
          depth++;
          bytes.push(ch);
        } else if (ch === 0x29) {
          depth--;
          if (depth > 0) bytes.push(ch);
        } else {
          bytes.push(ch);
        }
      }
      tokens.push({ type: 'str', value: Buffer.from(bytes) });
      continue;
    }
    if (c === 0x3c) {
      if (i + 1 < len && buf[i + 1] === 0x3c) {
        tokens.push({ type: 'op', value: '<<' });
        i += 2;
      } else {
        i++;
        let hex = '';
        while (i < len && buf[i] !== 0x3e) {
          const ch = buf[i++];
          if (!isWs(ch)) hex += String.fromCharCode(ch);
        }
        if (i < len && buf[i] === 0x3e) i++;
        if (hex.length % 2 === 1) hex += '0';
        tokens.push({ type: 'str', value: Buffer.from(hex, 'hex') });
      }
      continue;
    }
    if (c === 0x3e) {
      if (i + 1 < len && buf[i + 1] === 0x3e) {
        tokens.push({ type: 'op', value: '>>' });
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (c === 0x5b || c === 0x5d) {
      tokens.push({ type: c === 0x5b ? '[' : ']', value: String.fromCharCode(c) });
      i++;
      continue;
    }
    if (c === 0x2f) {
      i++;
      let name = '';
      while (i < len && !isWs(buf[i]) && !isDelim(buf[i])) {
        name += String.fromCharCode(buf[i++]);
      }
      tokens.push({ type: 'name', value: name });
      continue;
    }

    let word = '';
    while (i < len && !isWs(buf[i]) && !isDelim(buf[i])) {
      word += String.fromCharCode(buf[i++]);
    }
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) {
      tokens.push({ type: 'num', value: parseFloat(word) });
    } else if (word) {
      tokens.push({ type: 'op', value: word });
    }
  }
  return tokens;
}

function mulMat(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

function applyMat(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const PNG_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32Buf(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = PNG_CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, dataBuf) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(dataBuf.length >>> 0, 0);
  const crcInput = Buffer.concat([typeBuf, dataBuf]);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32Buf(crcInput), 0);
  return Buffer.concat([lenBuf, crcInput, crcBuf]);
}

function encodeRawToPngBuffer(rawPixels, width, height, channels) {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const ch = channels === 1 || channels === 4 ? channels : 3;
  const stride = w * ch;
  if (!rawPixels || rawPixels.length < stride * h) return null;

  const colorType = ch === 1 ? 0 : (ch === 4 ? 6 : 2);
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const scanlines = Buffer.allocUnsafe((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const dstOff = y * (stride + 1);
    const srcOff = y * stride;
    scanlines[dstOff] = 0;
    rawPixels.copy(scanlines, dstOff + 1, srcOff, srcOff + stride);
  }

  const idat = zlib.deflateSync(scanlines, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', idat),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function rgbFloatToHex(r, g, b) {
  const rr = Math.min(255, Math.max(0, Math.round(r * 255)));
  const gg = Math.min(255, Math.max(0, Math.round(g * 255)));
  const bb = Math.min(255, Math.max(0, Math.round(b * 255)));
  const lum = (0.299 * rr + 0.587 * gg + 0.114 * bb) / 255;
  if (lum < 0.14 || lum > 0.82) return '';
  return [rr, gg, bb].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function estimateTextWidthPt(text, fontSize) {
  const fsPt = Math.max(4, Number(fontSize) || 11);
  let sum = 0;
  for (const ch of String(text || '')) {
    const cp = ch.codePointAt(0) || 32;
    if (cp === 32 || cp === 9) sum += 0.30;
    else if (cp >= 0x2e80) sum += 0.98;
    else if (cp >= 65 && cp <= 90) sum += 0.62;
    else if ('ilI.,:;\'!|'.includes(ch)) sum += 0.32;
    else if ('mwMW@#%&'.includes(ch)) sum += 0.78;
    else sum += 0.52;
  }
  return Math.max(fsPt * 0.25, sum * fsPt);
}

function getPageFontMeta(context, resourcesDict) {
  const metaMap = new Map();
  if (!(resourcesDict instanceof PDFDict)) return metaMap;
  const fontDict = resourcesDict.lookup(PDFName.of('Font'));
  if (!(fontDict instanceof PDFDict)) return metaMap;
  for (const [k, v] of fontDict.entries()) {
    const keyName = k instanceof PDFName ? k.decodeText() : String(k).replace(/^\//, '');
    const resolved = context.lookup(v);
    let baseFont = '';
    if (resolved instanceof PDFDict) {
      const bf = resolved.lookup(PDFName.of('BaseFont'));
      if (bf instanceof PDFName) baseFont = bf.decodeText();
      if (!baseFont) {
        const descArr = resolved.lookup(PDFName.of('DescendantFonts'));
        if (descArr instanceof PDFArray && descArr.size() > 0) {
          const desc = context.lookup(descArr.get(0));
          const dbf = desc instanceof PDFDict ? desc.lookup(PDFName.of('BaseFont')) : null;
          if (dbf instanceof PDFName) baseFont = dbf.decodeText();
        }
      }
    }
    const isBold = /(?:bold|heavy|black|semibold|demi|simhei|heiti)/i.test(baseFont);
    metaMap.set(keyName, {
      decode: buildFontDecoder(context, resolved),
      isBold,
      baseFont,
    });
  }
  return metaMap;
}

function resolveColorSpaceInfo(context, csObj) {
  if (!csObj) return { kind: 'rgb', channels: 3 };
  if (csObj instanceof PDFName) {
    const name = csObj.decodeText();
    if (name === 'DeviceGray' || name === 'CalGray') return { kind: 'gray', channels: 1 };
    if (name === 'DeviceCMYK') return { kind: 'cmyk', channels: 4 };
    return { kind: 'rgb', channels: 3 };
  }
  if (csObj instanceof PDFArray && csObj.size() > 0) {
    const head = context.lookup(csObj.get(0));
    const headName = head instanceof PDFName ? head.decodeText() : '';
    if (headName === 'ICCBased' && csObj.size() > 1) {
      const profile = context.lookup(csObj.get(1));
      if (profile instanceof PDFRawStream) {
        const nObj = profile.dict.lookup(PDFName.of('N'));
        const n = nObj instanceof PDFNumber ? nObj.asNumber() : 3;
        if (n === 1) return { kind: 'gray', channels: 1 };
        if (n === 4) return { kind: 'cmyk', channels: 4 };
      }
      return { kind: 'rgb', channels: 3 };
    }
    if (headName === 'CalGray') return { kind: 'gray', channels: 1 };
    if (headName === 'CalRGB') return { kind: 'rgb', channels: 3 };
    if (headName === 'Indexed' && csObj.size() >= 4) {
      const baseInfo = resolveColorSpaceInfo(context, context.lookup(csObj.get(1)));
      const lookupObj = context.lookup(csObj.get(3));
      let palette = null;
      if (lookupObj instanceof PDFRawStream) {
        palette = decodePdfStreamSafe(lookupObj);
      } else if (lookupObj instanceof PDFHexString || lookupObj instanceof PDFString || typeof lookupObj?.asBytes === 'function') {
        palette = Buffer.from(lookupObj.asBytes());
      }
      if (palette && (baseInfo.channels === 1 || baseInfo.channels === 3)) {
        return { kind: 'indexed', channels: 1, baseChannels: baseInfo.channels, palette };
      }
    }
  }
  return { kind: 'rgb', channels: 3 };
}

function decodePdfImageXObject(context, xo, imageCache) {
  if (!(xo instanceof PDFRawStream)) return null;
  if (imageCache.has(xo)) return imageCache.get(xo);

  const cacheAndReturn = (val) => {
    imageCache.set(xo, val);
    return val;
  };

  try {
    const dict = xo.dict;
    if (dict.lookup(PDFName.of('Subtype')) !== PDFName.of('Image')) return cacheAndReturn(null);
    if (dict.lookup(PDFName.of('ImageMask')) === PDFBool.True) return cacheAndReturn(null);

    const wObj = dict.lookup(PDFName.of('Width'));
    const hObj = dict.lookup(PDFName.of('Height'));
    const w = wObj instanceof PDFNumber ? Math.round(wObj.asNumber()) : 0;
    const h = hObj instanceof PDFNumber ? Math.round(hObj.asNumber()) : 0;
    if (w < 16 || h < 16 || w * h > 40000000) return cacheAndReturn(null);

    const filterObj = dict.lookup(PDFName.of('Filter'));
    const filterName = filterObj instanceof PDFName
      ? filterObj.decodeText()
      : (filterObj instanceof PDFArray && filterObj.size() === 1 && filterObj.get(0) instanceof PDFName
        ? filterObj.get(0).decodeText()
        : '');

    const sMaskObj = dict.lookup(PDFName.of('SMask'));
    const csInfo = resolveColorSpaceInfo(context, dict.lookup(PDFName.of('ColorSpace')));

    if (filterName === 'DCTDecode' && !(sMaskObj instanceof PDFRawStream) && csInfo.kind !== 'cmyk') {
      const jpgBuf = Buffer.from(xo.contents);
      const dims = getJpegDimensions(jpgBuf);
      if (dims && dims.width > 0 && dims.height > 0) {
        return cacheAndReturn({ buffer: jpgBuf, ext: 'jpg', pixW: dims.width, pixH: dims.height });
      }
    }

    const bpcObj = dict.lookup(PDFName.of('BitsPerComponent'));
    const bpc = bpcObj instanceof PDFNumber ? bpcObj.asNumber() : 8;
    if (bpc !== 8) return cacheAndReturn(null);

    const decoded = decodePdfStreamSafe(xo);
    if (!decoded) return cacheAndReturn(null);

    const expectedBytes = w * h * csInfo.channels;
    if (decoded.length < expectedBytes) return cacheAndReturn(null);

    let outChannels = csInfo.channels === 1 && csInfo.kind !== 'indexed' ? 1 : 3;
    let rgbOrGray;

    if (csInfo.kind === 'indexed') {
      const bc = csInfo.baseChannels || 3;
      outChannels = bc;
      rgbOrGray = Buffer.allocUnsafe(w * h * bc);
      const pal = csInfo.palette;
      const maxIdx = Math.max(0, Math.floor(pal.length / bc) - 1);
      for (let p = 0; p < w * h; p++) {
        const idx = Math.min(maxIdx, decoded[p]);
        const sOff = idx * bc;
        const dOff = p * bc;
        for (let k = 0; k < bc; k++) rgbOrGray[dOff + k] = pal[sOff + k] || 0;
      }
    } else if (csInfo.kind === 'cmyk') {
      outChannels = 3;
      rgbOrGray = Buffer.allocUnsafe(w * h * 3);
      for (let p = 0; p < w * h; p++) {
        const s = p * 4;
        const d = p * 3;
        const c = decoded[s] / 255;
        const m = decoded[s + 1] / 255;
        const y = decoded[s + 2] / 255;
        const k = decoded[s + 3] / 255;
        rgbOrGray[d] = Math.round(255 * (1 - c) * (1 - k));
        rgbOrGray[d + 1] = Math.round(255 * (1 - m) * (1 - k));
        rgbOrGray[d + 2] = Math.round(255 * (1 - y) * (1 - k));
      }
    } else {
      rgbOrGray = decoded.subarray(0, expectedBytes);
    }

    let finalPixels = rgbOrGray;
    let finalChannels = outChannels;

    if (sMaskObj instanceof PDFRawStream) {
      const mwObj = sMaskObj.dict.lookup(PDFName.of('Width'));
      const mhObj = sMaskObj.dict.lookup(PDFName.of('Height'));
      const mbpcObj = sMaskObj.dict.lookup(PDFName.of('BitsPerComponent'));
      const mw = mwObj instanceof PDFNumber ? Math.round(mwObj.asNumber()) : 0;
      const mh = mhObj instanceof PDFNumber ? Math.round(mhObj.asNumber()) : 0;
      const mbpc = mbpcObj instanceof PDFNumber ? mbpcObj.asNumber() : 8;
      if (mw === w && mh === h && mbpc === 8) {
        const alphaBuf = decodePdfStreamSafe(sMaskObj);
        if (alphaBuf && alphaBuf.length >= w * h) {
          const rgba = Buffer.allocUnsafe(w * h * 4);
          for (let p = 0; p < w * h; p++) {
            const d = p * 4;
            if (outChannels === 1) {
              const g = rgbOrGray[p];
              rgba[d] = g;
              rgba[d + 1] = g;
              rgba[d + 2] = g;
            } else {
              const s = p * 3;
              rgba[d] = rgbOrGray[s];
              rgba[d + 1] = rgbOrGray[s + 1];
              rgba[d + 2] = rgbOrGray[s + 2];
            }
            rgba[d + 3] = alphaBuf[p];
          }
          finalPixels = rgba;
          finalChannels = 4;
        }
      }
    }

    const pngBuf = encodeRawToPngBuffer(finalPixels, w, h, finalChannels);
    if (!pngBuf) return cacheAndReturn(null);
    return cacheAndReturn({ buffer: pngBuf, ext: 'png', pixW: w, pixH: h });
  } catch {
    return cacheAndReturn(null);
  }
}

function extractPageStructuredElements(
  context,
  streamBuf,
  resourcesDict,
  baseCtm = [1, 0, 0, 1, 0, 0],
  depth = 0,
  imageCache = new Map(),
  textOnly = false,
) {
  const fragments = [];
  const hSegments = [];
  const vSegments = [];
  const images = [];

  const fontMeta = getPageFontMeta(context, resourcesDict);
  const xObjDict = resourcesDict instanceof PDFDict ? resourcesDict.lookup(PDFName.of('XObject')) : null;
  const tokens = tokenizePdfContent(streamBuf);

  const stack = [];
  let ctm = baseCtm.slice();
  const stateStack = [];
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  let tl = 0;
  let curFont = '';
  let curFontSize = 11;
  let fillColorHex = '';
  let textRenderMode = 0;

  let pathOps = [];
  let curPt = null;
  let subStart = null;

  const flushSubpathToSegments = ({ close = false, stroke = false, fill = false } = {}) => {
    if (!pathOps.length) {
      curPt = null;
      subStart = null;
      return;
    }

    const pushSegment = (p1, p2) => {
      const dx = Math.abs(p1[0] - p2[0]);
      const dy = Math.abs(p1[1] - p2[1]);
      if (dy <= 1.5 && dx >= 12) {
        hSegments.push({ y: (p1[1] + p2[1]) / 2, x1: Math.min(p1[0], p2[0]), x2: Math.max(p1[0], p2[0]) });
      } else if (dx <= 1.5 && dy >= 8) {
        vSegments.push({ x: (p1[0] + p2[0]) / 2, y1: Math.min(p1[1], p2[1]), y2: Math.max(p1[1], p2[1]) });
      }
    };

    const polyPts = [];
    for (const item of pathOps) {
      if (item.kind === 'line') {
        if (stroke) {
          const a = applyMat(ctm, item.x1, item.y1);
          const b = applyMat(ctm, item.x2, item.y2);
          pushSegment(a, b);
        } else if (fill) {
          polyPts.push(applyMat(ctm, item.x1, item.y1), applyMat(ctm, item.x2, item.y2));
        }
      } else if (item.kind === 'rect') {
        const corners = [
          applyMat(ctm, item.x, item.y),
          applyMat(ctm, item.x + item.w, item.y),
          applyMat(ctm, item.x + item.w, item.y + item.h),
          applyMat(ctm, item.x, item.y + item.h),
        ];
        const minX = Math.min(corners[0][0], corners[1][0], corners[2][0], corners[3][0]);
        const maxX = Math.max(corners[0][0], corners[1][0], corners[2][0], corners[3][0]);
        const minY = Math.min(corners[0][1], corners[1][1], corners[2][1], corners[3][1]);
        const maxY = Math.max(corners[0][1], corners[1][1], corners[2][1], corners[3][1]);
        const rw = maxX - minX;
        const rh = maxY - minY;
        if (fill && rh > 0 && rh <= 3.5 && rw >= 15) {
          hSegments.push({ y: (minY + maxY) / 2, x1: minX, x2: maxX });
        } else if (fill && rw > 0 && rw <= 3.5 && rh >= 10) {
          vSegments.push({ x: (minX + maxX) / 2, y1: minY, y2: maxY });
        } else if (stroke) {
          pushSegment(corners[0], corners[1]);
          pushSegment(corners[1], corners[2]);
          pushSegment(corners[2], corners[3]);
          pushSegment(corners[3], corners[0]);
        }
      }
    }

    if (stroke && close && curPt && subStart) {
      pushSegment(applyMat(ctm, curPt[0], curPt[1]), applyMat(ctm, subStart[0], subStart[1]));
    }

    if (fill && !stroke && polyPts.length >= 4 && polyPts.length <= 12) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const [px, py] of polyPts) {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
      const rw = maxX - minX;
      const rh = maxY - minY;
      if (rh > 0 && rh <= 3.5 && rw >= 15) {
        hSegments.push({ y: (minY + maxY) / 2, x1: minX, x2: maxX });
      } else if (rw > 0 && rw <= 3.5 && rh >= 10) {
        vSegments.push({ x: (minX + maxX) / 2, y1: minY, y2: maxY });
      }
    }

    pathOps.length = 0;
    curPt = null;
    subStart = null;
  };

  const pushDecodedText = (text) => {
    if (!text) return;
    const total = mulMat(tm, ctm);
    const effSize = Math.max(4, Math.hypot(total[0], total[1]) * curFontSize || Math.abs(curFontSize));
    const widthPt = estimateTextWidthPt(text, effSize);
    const meta = fontMeta.get(curFont);
    fragments.push({
      id: 0,
      text,
      x: total[4],
      y: total[5],
      width: widthPt,
      endX: total[4] + widthPt,
      fontSize: effSize,
      bold: !!(meta?.isBold || textRenderMode === 2),
      colorHex: textRenderMode === 3 ? '' : fillColorHex,
    });
    const textSpaceAdv = widthPt / Math.max(0.1, Math.hypot(total[0], total[1]));
    tm = mulMat([1, 0, 0, 1, textSpaceAdv, 0], tm);
  };

  const pushFrag = (rawBytes) => {
    const meta = fontMeta.get(curFont);
    const decoder = meta?.decode || ((b) => decodeWinAnsiBytes(b));
    pushDecodedText(decoder(rawBytes));
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === '[') {
      const arr = [];
      let j = i + 1;
      while (j < tokens.length && tokens[j].type !== ']') {
        arr.push(tokens[j]);
        j++;
      }
      stack.push({ type: 'array', value: arr });
      i = j;
      continue;
    }
    if (tok.type !== 'op') {
      stack.push(tok);
      continue;
    }

    const op = tok.value;
    if (op === 'q') {
      stateStack.push({
        ctm: ctm.slice(),
        fillColorHex,
        curFont,
        curFontSize,
        tl,
        textRenderMode,
      });
    } else if (op === 'Q') {
      if (stateStack.length) {
        const st = stateStack.pop();
        ctm = st.ctm;
        fillColorHex = st.fillColorHex;
        curFont = st.curFont;
        curFontSize = st.curFontSize;
        tl = st.tl;
        textRenderMode = st.textRenderMode;
      }
    } else if (op === 'cm' && stack.length >= 6) {
      const vals = stack.splice(-6).map((t) => Number(t.value) || 0);
      ctm = mulMat(vals, ctm);
    } else if ((op === 'rg' || op === 'scn' || op === 'sc') && stack.length >= 3) {
      const vals = stack.slice(-3).map((t) => Number(t.value));
      if (vals.every(Number.isFinite)) fillColorHex = rgbFloatToHex(vals[0], vals[1], vals[2]);
    } else if (op === 'g' && stack.length >= 1) {
      const gray = Number(stack[stack.length - 1]?.value);
      if (Number.isFinite(gray)) fillColorHex = rgbFloatToHex(gray, gray, gray);
    } else if (op === 'k' && stack.length >= 4) {
      const [c, m, y, k] = stack.slice(-4).map((t) => Number(t.value) || 0);
      fillColorHex = rgbFloatToHex((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));
    } else if (op === 'm' && stack.length >= 2) {
      const py = Number(stack.pop()?.value) || 0;
      const px = Number(stack.pop()?.value) || 0;
      curPt = [px, py];
      subStart = [px, py];
    } else if (op === 'l' && stack.length >= 2) {
      const py = Number(stack.pop()?.value) || 0;
      const px = Number(stack.pop()?.value) || 0;
      if (curPt) pathOps.push({ kind: 'line', x1: curPt[0], y1: curPt[1], x2: px, y2: py });
      curPt = [px, py];
    } else if ((op === 'c' || op === 'v' || op === 'y') && stack.length >= 2) {
      const py = Number(stack.pop()?.value) || 0;
      const px = Number(stack.pop()?.value) || 0;
      curPt = [px, py];
    } else if (op === 'h') {
      if (curPt && subStart) {
        pathOps.push({ kind: 'line', x1: curPt[0], y1: curPt[1], x2: subStart[0], y2: subStart[1] });
        curPt = subStart.slice();
      }
    } else if (op === 're' && stack.length >= 4) {
      const rh = Number(stack.pop()?.value) || 0;
      const rw = Number(stack.pop()?.value) || 0;
      const ry = Number(stack.pop()?.value) || 0;
      const rx = Number(stack.pop()?.value) || 0;
      pathOps.push({ kind: 'rect', x: rx, y: ry, w: rw, h: rh });
      curPt = [rx, ry];
      subStart = [rx, ry];
    } else if (op === 'S') {
      flushSubpathToSegments({ close: false, stroke: true, fill: false });
    } else if (op === 's') {
      flushSubpathToSegments({ close: true, stroke: true, fill: false });
    } else if (op === 'f' || op === 'F' || op === 'f*') {
      flushSubpathToSegments({ close: false, stroke: false, fill: true });
    } else if (op === 'B' || op === 'B*') {
      flushSubpathToSegments({ close: false, stroke: true, fill: true });
    } else if (op === 'b' || op === 'b*') {
      flushSubpathToSegments({ close: true, stroke: true, fill: true });
    } else if (op === 'n') {
      pathOps.length = 0;
      curPt = null;
      subStart = null;
    } else if (op === 'BT') {
      tm = [1, 0, 0, 1, 0, 0];
      tlm = [1, 0, 0, 1, 0, 0];
    } else if (op === 'Tf' && stack.length >= 2) {
      const sz = stack.pop();
      const nm = stack.pop();
      curFont = String(nm?.value || '');
      curFontSize = Number(sz?.value) || 11;
    } else if (op === 'TL' && stack.length >= 1) {
      tl = Number(stack.pop()?.value) || 0;
    } else if (op === 'Tr' && stack.length >= 1) {
      textRenderMode = Number(stack.pop()?.value) || 0;
    } else if (op === 'Tm' && stack.length >= 6) {
      const vals = stack.splice(-6).map((t) => Number(t.value) || 0);
      tm = vals.slice();
      tlm = vals.slice();
    } else if ((op === 'Td' || op === 'TD') && stack.length >= 2) {
      const ty = Number(stack.pop()?.value) || 0;
      const tx = Number(stack.pop()?.value) || 0;
      if (op === 'TD') tl = -ty;
      tlm = mulMat([1, 0, 0, 1, tx, ty], tlm);
      tm = tlm.slice();
    } else if (op === 'T*') {
      tlm = mulMat([1, 0, 0, 1, 0, -tl], tlm);
      tm = tlm.slice();
    } else if (op === 'Tj' && stack.length >= 1) {
      const s = stack.pop();
      if (s?.type === 'str') pushFrag(s.value);
    } else if (op === "'" && stack.length >= 1) {
      const s = stack.pop();
      tlm = mulMat([1, 0, 0, 1, 0, -tl], tlm);
      tm = tlm.slice();
      if (s?.type === 'str') pushFrag(s.value);
    } else if (op === '"' && stack.length >= 3) {
      const s = stack.pop();
      stack.pop();
      stack.pop();
      tlm = mulMat([1, 0, 0, 1, 0, -tl], tlm);
      tm = tlm.slice();
      if (s?.type === 'str') pushFrag(s.value);
    } else if (op === 'TJ' && stack.length >= 1) {
      const arrTok = stack.pop();
      if (arrTok?.type === 'array') {
        const meta = fontMeta.get(curFont);
        const decoder = meta?.decode || ((b) => decodeWinAnsiBytes(b));
        let tjText = '';
        for (const item of arrTok.value) {
          if (item.type === 'str') {
            tjText += decoder(item.value);
          } else if (item.type === 'num') {
            const gapEm = -Number(item.value) / 1000;
            if (gapEm >= 1.1) {
              if (tjText) pushDecodedText(tjText);
              tjText = '';
              tm = mulMat([1, 0, 0, 1, gapEm * curFontSize, 0], tm);
            } else if (gapEm >= 0.18 && tjText && !tjText.endsWith(' ')) {
              tjText += ' ';
            }
          }
        }
        pushDecodedText(tjText);
      }
    } else if (op === 'Do' && stack.length >= 1) {
      const nameTok = stack.pop();
      if (xObjDict instanceof PDFDict && nameTok?.value) {
        const xo = xObjDict.lookup(PDFName.of(nameTok.value));
        if (xo instanceof PDFRawStream) {
          const subtype = xo.dict.lookup(PDFName.of('Subtype'));
          if (subtype === PDFName.of('Image')) {
            const corners = [
              applyMat(ctm, 0, 0),
              applyMat(ctm, 1, 0),
              applyMat(ctm, 0, 1),
              applyMat(ctm, 1, 1),
            ];
            const minX = Math.min(corners[0][0], corners[1][0], corners[2][0], corners[3][0]);
            const maxX = Math.max(corners[0][0], corners[1][0], corners[2][0], corners[3][0]);
            const minY = Math.min(corners[0][1], corners[1][1], corners[2][1], corners[3][1]);
            const maxY = Math.max(corners[0][1], corners[1][1], corners[2][1], corners[3][1]);
            const dispW = maxX - minX;
            const dispH = maxY - minY;
            if (!textOnly && dispW >= 14 && dispH >= 14) {
              const decodedImg = decodePdfImageXObject(context, xo, imageCache);
              if (decodedImg) {
                images.push({
                  kind: 'image',
                  x: minX,
                  x2: maxX,
                  y: minY,
                  yBot: minY,
                  yTop: maxY,
                  dispW,
                  dispH,
                  pixW: decodedImg.pixW,
                  pixH: decodedImg.pixH,
                  buffer: decodedImg.buffer,
                  ext: decodedImg.ext,
                  xoRef: xo,
                });
              }
            }
          } else if (depth < 2 && subtype === PDFName.of('Form')) {
            const subBuf = decodePdfStreamSafe(xo);
            if (subBuf) {
              const subRes = xo.dict.lookup(PDFName.of('Resources')) || resourcesDict;
              const matArr = xo.dict.lookup(PDFName.of('Matrix'));
              let formMat = [1, 0, 0, 1, 0, 0];
              if (matArr instanceof PDFArray && matArr.size() === 6) {
                formMat = [0, 1, 2, 3, 4, 5].map((idx) => {
                  const n = matArr.lookup(idx);
                  return n instanceof PDFNumber ? n.asNumber() : 0;
                });
              }
              const subResEls = extractPageStructuredElements(
                context,
                subBuf,
                subRes,
                mulMat(formMat, ctm),
                depth + 1,
                imageCache,
                textOnly,
              );
              fragments.push(...subResEls.fragments);
              hSegments.push(...subResEls.hSegments);
              vSegments.push(...subResEls.vSegments);
              images.push(...subResEls.images);
            }
          }
        }
      }
    }
    stack.length = 0;
  }

  if (depth === 0) {
    fragments.forEach((f, idx) => { f.id = idx + 1; });
  }

  return { fragments, hSegments, vSegments, images };
}

function getPageContentsBuffer(context, pageNode) {
  const contents = pageNode.Contents();
  if (!contents) return Buffer.alloc(0);
  const parts = [];
  if (contents instanceof PDFRawStream) {
    const d = decodePdfStreamSafe(contents);
    if (d) parts.push(d);
  } else if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const item = context.lookup(contents.get(i));
      const d = decodePdfStreamSafe(item);
      if (d) parts.push(d);
    }
  }
  return parts.length ? Buffer.concat(parts.map((b) => Buffer.concat([b, Buffer.from('\n')]))) : Buffer.alloc(0);
}

function isGarbledText(text) {
  const trimmed = String(text || '').replace(/\s+/g, '');
  if (!trimmed) return true;
  const badChars = (trimmed.match(/[\uE000-\uF8FF\uFFFD\x00-\x08\x0E-\x1F]/g) || []).length;
  return badChars / trimmed.length > 0.2;
}

function hasSearchablePageText(page) {
  const context = page.doc.context;
  const content = getPageContentsBuffer(context, page.node);
  if (!content.length) return false;
  const { fragments } = extractPageStructuredElements(
    context, content, page.node.Resources(), undefined, 0, undefined, true,
  );
  return !isGarbledText(fragments.map((fragment) => fragment.text).join(''));
}

function groupFragmentsToVisualLines(fragments) {
  if (!fragments.length) return [];
  const sorted = fragments.slice().sort((a, b) => (Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x));
  const lines = [];
  for (const f of sorted) {
    const tol = Math.max(3, (f.fontSize || 11) * 0.45);
    const lastLine = lines[lines.length - 1];
    if (lastLine && Math.abs(lastLine.y - f.y) <= tol) {
      lastLine.items.push(f);
      lastLine.maxFont = Math.max(lastLine.maxFont, f.fontSize || 11);
    } else {
      lines.push({ y: f.y, items: [f], maxFont: f.fontSize || 11 });
    }
  }
  for (const ln of lines) ln.items.sort((a, b) => a.x - b.x);
  return lines;
}

function joinLineItemsToRuns(items) {
  const sorted = items.slice().sort((a, b) => a.x - b.x);
  const runs = [];
  let prevEndX = null;
  let plain = '';

  const appendRun = (txt, bold, colorHex) => {
    if (!txt) return;
    const last = runs[runs.length - 1];
    if (last && last.bold === !!bold && last.colorHex === (colorHex || '')) {
      last.text += txt;
    } else {
      runs.push({ text: txt, bold: !!bold, colorHex: colorHex || '' });
    }
    plain += txt;
  };

  for (const it of sorted) {
    const clean = String(it.text || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    if (!clean) continue;
    const fsPt = it.fontSize || 11;
    if (prevEndX !== null && it.x - prevEndX > fsPt * 0.28 && !plain.endsWith(' ') && !clean.startsWith(' ')) {
      appendRun(' ', runs[runs.length - 1]?.bold || false, runs[runs.length - 1]?.colorHex || '');
    }
    appendRun(clean, !!it.bold, it.colorHex || '');
    const w = it.width || estimateTextWidthPt(clean, fsPt);
    prevEndX = Math.max(prevEndX || 0, it.x + w);
  }

  return {
    text: plain.replace(/\s+/g, ' ').trim(),
    runs,
  };
}

function fragmentsToDocxBlocks(fragments) {
  const rawLines = groupFragmentsToVisualLines(fragments);
  if (!rawLines.length) return [];

  const textLines = rawLines
    .map((ln) => {
      const { text, runs } = joinLineItemsToRuns(ln.items);
      const minX = ln.items.reduce((m, it) => Math.min(m, it.x), Infinity);
      const maxX = ln.items.reduce((m, it) => Math.max(m, it.endX || (it.x + estimateTextWidthPt(it.text, it.fontSize))), -Infinity);
      return {
        text,
        runs,
        y: ln.y,
        x: Number.isFinite(minX) ? minX : 0,
        endX: Number.isFinite(maxX) ? maxX : 0,
        fontSize: ln.maxFont,
      };
    })
    .filter((l) => l.text);

  if (!textLines.length) return [];

  const sizes = textLines.map((l) => l.fontSize).sort((a, b) => a - b);
  const bodySize = sizes[Math.floor(sizes.length / 2)] || 11;

  const blocks = [];
  let curPara = null;

  const flushPara = () => {
    if (curPara && curPara.text) {
      blocks.push(curPara);
      curPara = null;
    }
  };

  for (let i = 0; i < textLines.length; i++) {
    const ln = textLines[i];
    const isHeading = ln.fontSize >= bodySize * 1.28 && ln.text.length <= 60;
    const heading = isHeading ? (ln.fontSize >= bodySize * 1.6 ? 1 : 2) : 0;

    if (heading > 0) {
      flushPara();
      blocks.push({
        kind: 'para',
        heading,
        text: ln.text,
        runs: ln.runs,
        yTop: ln.y + ln.fontSize,
        yBot: ln.y,
        x: ln.x,
        x2: ln.endX,
      });
      continue;
    }

    const prev = i > 0 ? textLines[i - 1] : null;
    const gap = prev ? Math.abs(prev.y - ln.y) : 0;
    const lineStep = Math.max(12, ln.fontSize * 1.55);

    if (!curPara || gap > lineStep * 1.35 || /^[•·\-*]|\d+[.、)）]/.test(ln.text)) {
      flushPara();
      curPara = {
        kind: 'para',
        heading: 0,
        text: ln.text,
        runs: ln.runs.map((r) => ({ ...r })),
        yTop: ln.y + ln.fontSize,
        yBot: ln.y,
        x: ln.x,
        x2: ln.endX,
      };
    } else {
      const needSpace = /[a-zA-Z0-9]$/.test(curPara.text) && /^[a-zA-Z0-9]/.test(ln.text);
      if (needSpace) {
        const lastRun = curPara.runs[curPara.runs.length - 1];
        if (lastRun) lastRun.text += ' ';
        curPara.text += ' ';
      }
      curPara.text += ln.text;
      for (const r of ln.runs) {
        const last = curPara.runs[curPara.runs.length - 1];
        if (last && last.bold === r.bold && last.colorHex === r.colorHex) {
          last.text += r.text;
        } else {
          curPara.runs.push({ ...r });
        }
      }
      curPara.yBot = Math.min(curPara.yBot, ln.y);
      curPara.x = Math.min(curPara.x, ln.x);
      curPara.x2 = Math.max(curPara.x2, ln.endX);
    }
  }
  flushPara();
  return blocks;
}

function mergeAxisSegments(rawSegs, isHorizontal) {
  const segs = rawSegs.map((s) => (isHorizontal
    ? { pos: s.y, a: Math.min(s.x1, s.x2), b: Math.max(s.x1, s.x2) }
    : { pos: s.x, a: Math.min(s.y1, s.y2), b: Math.max(s.y1, s.y2) }));
  segs.sort((u, v) => (Math.abs(u.pos - v.pos) > 2.2 ? u.pos - v.pos : u.a - v.a));

  const merged = [];
  for (const s of segs) {
    let joined = false;
    for (let i = merged.length - 1; i >= 0; i--) {
      const m = merged[i];
      if (Math.abs(m.pos - s.pos) > 2.5) break;
      if (s.a <= m.b + 4 && s.b >= m.a - 4) {
        m.pos = (m.pos + s.pos) / 2;
        m.a = Math.min(m.a, s.a);
        m.b = Math.max(m.b, s.b);
        joined = true;
        break;
      }
    }
    if (!joined) merged.push({ ...s });
  }
  return merged.map((m) => (isHorizontal
    ? { y: m.pos, x1: m.a, x2: m.b }
    : { x: m.pos, y1: m.a, y2: m.b }));
}

function clusterCoords(values, tol = 4) {
  if (!values.length) return [];
  const sorted = values.slice().sort((a, b) => a - b);
  const clusters = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const cur = clusters[clusters.length - 1];
    if (sorted[i] - cur[cur.length - 1] <= tol) cur.push(sorted[i]);
    else clusters.push([sorted[i]]);
  }
  return clusters.map((c) => c.reduce((s, v) => s + v, 0) / c.length);
}

function mergeCloseSortedAxis(coords, minGap, descending = false) {
  if (!coords.length) return [];
  const sorted = coords.slice().sort((a, b) => (descending ? b - a : a - b));
  const out = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i] - out[out.length - 1]) >= minGap) out.push(sorted[i]);
  }
  return out;
}

function extractTablesFromPage(fragments, hSegments, vSegments, pageWidth) {
  const consumedIds = new Set();
  const tables = [];

  const hMerged = mergeAxisSegments(hSegments, true).filter((s) => s.x2 - s.x1 >= 12);
  const vMerged = mergeAxisSegments(vSegments, false).filter((s) => s.y2 - s.y1 >= 8);

  // 1. 有框网格表格识别（支持合并单元格 gridSpan / vMerge）
  if (hMerged.length >= 3 && vMerged.length >= 3) {
    const tol = 4.5;
    const hAdj = hMerged.map(() => []);
    const vAdj = vMerged.map(() => []);
    for (let hi = 0; hi < hMerged.length; hi++) {
      const h = hMerged[hi];
      for (let vi = 0; vi < vMerged.length; vi++) {
        const v = vMerged[vi];
        if (v.x >= h.x1 - tol && v.x <= h.x2 + tol && h.y >= v.y1 - tol && h.y <= v.y2 + tol) {
          hAdj[hi].push(vi);
          vAdj[vi].push(hi);
        }
      }
    }

    const seenH = new Uint8Array(hMerged.length);
    const seenV = new Uint8Array(vMerged.length);

    for (let startH = 0; startH < hMerged.length; startH++) {
      if (seenH[startH] || !hAdj[startH].length) continue;
      const compH = [];
      const compV = [];
      const q = [{ t: 'h', idx: startH }];
      seenH[startH] = 1;

      while (q.length) {
        const cur = q.shift();
        if (cur.t === 'h') {
          compH.push(hMerged[cur.idx]);
          for (const vi of hAdj[cur.idx]) {
            if (!seenV[vi]) {
              seenV[vi] = 1;
              q.push({ t: 'v', idx: vi });
            }
          }
        } else {
          compV.push(vMerged[cur.idx]);
          for (const hi of vAdj[cur.idx]) {
            if (!seenH[hi]) {
              seenH[hi] = 1;
              q.push({ t: 'h', idx: hi });
            }
          }
        }
      }

      const rawRowsY = clusterCoords(compH.map((s) => s.y), 4.5);
      const rawColsX = clusterCoords(compV.map((s) => s.x), 4.5);
      const rowYs = mergeCloseSortedAxis(rawRowsY, 8, true);
      const colXs = mergeCloseSortedAxis(rawColsX, 12, false);
      const numRows = rowYs.length - 1;
      const numCols = colXs.length - 1;
      if (numRows < 2 || numCols < 2) continue;

      const xMin = colXs[0];
      const xMax = colXs[numCols];
      const yMax = rowYs[0];
      const yMin = rowYs[numRows];
      if (xMax - xMin < 36 || yMax - yMin < 20) continue;

      const hasVDivider = (colBoundaryX, yTop, yBot) => {
        const need = Math.max(4, (yTop - yBot) * 0.45);
        for (const v of compV) {
          if (Math.abs(v.x - colBoundaryX) <= 5) {
            const ov = Math.min(v.y2, yTop + 3) - Math.max(v.y1, yBot - 3);
            if (ov >= need) return true;
          }
        }
        return false;
      };

      const hasHDivider = (rowBoundaryY, xL, xR) => {
        const need = Math.max(6, (xR - xL) * 0.45);
        for (const h of compH) {
          if (Math.abs(h.y - rowBoundaryY) <= 5) {
            const ov = Math.min(h.x2, xR + 3) - Math.max(h.x1, xL - 3);
            if (ov >= need) return true;
          }
        }
        return false;
      };

      const cellFrags = Array.from({ length: numRows }, () => Array.from({ length: numCols }, () => []));
      const tableFragIds = [];
      for (const f of fragments) {
        if (consumedIds.has(f.id)) continue;
        const fx = f.x + Math.min(f.width || 6, 12) * 0.4;
        const fy = f.y + (f.fontSize || 10) * 0.3;
        if (fx < xMin - 4 || fx > xMax + 4 || fy < yMin - 4 || fy > yMax + 4) continue;

        let rIdx = -1;
        for (let r = 0; r < numRows; r++) {
          if (fy <= rowYs[r] + 3 && fy >= rowYs[r + 1] - 3) {
            rIdx = r;
            break;
          }
        }
        let cIdx = -1;
        for (let c = 0; c < numCols; c++) {
          if (fx >= colXs[c] - 3 && fx <= colXs[c + 1] + 3) {
            cIdx = c;
            break;
          }
        }
        if (rIdx >= 0 && cIdx >= 0) {
          cellFrags[rIdx][cIdx].push(f);
          tableFragIds.push(f.id);
        }
      }

      const visited = Array.from({ length: numRows }, () => new Uint8Array(numCols));
      const rows = Array.from({ length: numRows }, () => []);
      let nonEmptyCells = 0;

      for (let r = 0; r < numRows; r++) {
        for (let c = 0; c < numCols; c++) {
          if (visited[r][c]) continue;
          let colSpan = 1;
          while (c + colSpan < numCols && !hasVDivider(colXs[c + colSpan], rowYs[r], rowYs[r + 1])) {
            colSpan++;
          }
          let rowSpan = 1;
          while (r + rowSpan < numRows) {
            const divY = rowYs[r + rowSpan];
            const split = hasHDivider(divY, colXs[c], colXs[c + colSpan]);
            if (split) break;
            if (c > 0 && !hasVDivider(colXs[c], rowYs[r + rowSpan], rowYs[r + rowSpan + 1])) break;
            if (c + colSpan < numCols && !hasVDivider(colXs[c + colSpan], rowYs[r + rowSpan], rowYs[r + rowSpan + 1])) break;
            rowSpan++;
          }

          const mergedFrags = [];
          for (let rr = r; rr < r + rowSpan; rr++) {
            for (let cc = c; cc < c + colSpan; cc++) {
              visited[rr][cc] = 1;
              mergedFrags.push(...cellFrags[rr][cc]);
            }
          }

          const blocks = fragmentsToDocxBlocks(mergedFrags);
          if (blocks.length) nonEmptyCells++;

          rows[r].push({
            colSpan,
            vMerge: rowSpan > 1 ? 'restart' : '',
            blocks,
          });
          for (let rr = r + 1; rr < r + rowSpan; rr++) {
            rows[rr].push({
              colSpan,
              vMerge: 'continue',
              blocks: [],
            });
          }
        }
      }

      if (nonEmptyCells < 2) continue;
      for (const fid of tableFragIds) consumedIds.add(fid);

      const colWidthsPt = [];
      for (let c = 0; c < numCols; c++) colWidthsPt.push(Math.max(18, colXs[c + 1] - colXs[c]));

      tables.push({
        kind: 'table',
        yTop: yMax,
        yBot: yMin,
        x: xMin,
        x2: xMax,
        colWidthsPt,
        rows,
        borderStyle: 'grid',
      });
    }
  }

  // 2. 无竖线/三线表对齐多列表格识别（带严格双栏文章防误判机制）
  const remFrags = fragments.filter((f) => !consumedIds.has(f.id));
  const rawLines = groupFragmentsToVisualLines(remFrags);
  const splitLines = rawLines.map((ln) => {
    const segs = [];
    let curItems = [];
    let prevEnd = null;
    for (const it of ln.items) {
      const clean = String(it.text || '').trim();
      if (!clean) continue;
      const fsPt = it.fontSize || 11;
      const w = it.width || estimateTextWidthPt(it.text, fsPt);
      if (prevEnd !== null && it.x - prevEnd >= Math.max(18, ln.maxFont * 1.6)) {
        segs.push({ items: curItems });
        curItems = [it];
      } else {
        curItems.push(it);
      }
      prevEnd = Math.max(prevEnd || 0, it.x + w);
    }
    if (curItems.length) segs.push({ items: curItems });

    const normSegs = segs.map((s) => {
      const { text, runs } = joinLineItemsToRuns(s.items);
      const sx = s.items.reduce((m, it) => Math.min(m, it.x), Infinity);
      const ex = s.items.reduce((m, it) => Math.max(m, it.endX || (it.x + estimateTextWidthPt(it.text, it.fontSize))), -Infinity);
      return { text, runs, x: sx, x2: ex, items: s.items };
    }).filter((s) => s.text);

    return { y: ln.y, maxFont: ln.maxFont, segs: normSegs };
  }).filter((l) => l.segs.length > 0);

  let runStart = -1;
  const candidateRuns = [];
  for (let i = 0; i <= splitLines.length; i++) {
    const ln = splitLines[i];
    const okMulti = ln && ln.segs.length >= 2;
    const stepOk = okMulti && runStart >= 0
      ? Math.abs(splitLines[i - 1].y - ln.y) <= Math.max(24, ln.maxFont * 3.2)
      : true;
    if (okMulti && stepOk) {
      if (runStart < 0) runStart = i;
    } else {
      if (runStart >= 0 && i - runStart >= 3) {
        candidateRuns.push(splitLines.slice(runStart, i));
      }
      runStart = okMulti ? i : -1;
    }
  }

  for (const run of candidateRuns) {
    const yTop = run[0].y + run[0].maxFont;
    const yBot = run[run.length - 1].y;
    const hasNearbyRule = hMerged.some(
      (h) => h.y <= yTop + 18 && h.y >= yBot - 18 && (h.x2 - h.x1) >= (pageWidth || 595) * 0.25,
    );

    const allStartX = [];
    for (const ln of run) for (const seg of ln.segs) allStartX.push(seg.x);
    const colAnchors = mergeCloseSortedAxis(clusterCoords(allStartX, 16), 24, false);
    if (colAnchors.length < 2) continue;

    // 防双栏文章误判为两列表格
    const segLens = [];
    const segWidths = [];
    for (const ln of run) {
      for (const seg of ln.segs) {
        segLens.push(seg.text.length);
        segWidths.push(seg.x2 - seg.x);
      }
    }
    segLens.sort((a, b) => a - b);
    const medLen = segLens[Math.floor(segLens.length / 2)] || 0;
    const maxSegW = Math.max(...segWidths, 0);

    if (colAnchors.length === 2 && !hasNearbyRule) {
      const compactTwoCol = medLen <= 16 && maxSegW < (pageWidth || 595) * 0.28;
      if (!compactTwoCol) continue;
    }

    const numCols = colAnchors.length;
    const colEdgesRight = new Array(numCols).fill(0);
    const rows = [];
    const runFragIds = [];
    let matchedRows = 0;

    for (const ln of run) {
      const rowCells = Array.from({ length: numCols }, () => []);
      for (const seg of ln.segs) {
        let bestC = 0;
        let bestDist = Infinity;
        for (let c = 0; c < numCols; c++) {
          const d = Math.abs(seg.x - colAnchors[c]);
          if (d < bestDist) {
            bestDist = d;
            bestC = c;
          }
        }
        rowCells[bestC].push(seg);
        colEdgesRight[bestC] = Math.max(colEdgesRight[bestC], seg.x2);
      }
      const populatedCols = rowCells.filter((rc) => rc.length > 0).length;
      if (populatedCols >= 2) matchedRows++;
      rows.push(rowCells.map((rc) => {
        if (!rc.length) return { colSpan: 1, vMerge: '', blocks: [] };
        const cellFrags = rc.flatMap((s) => s.items);
        for (const it of cellFrags) runFragIds.push(it.id);
        return {
          colSpan: 1,
          vMerge: '',
          blocks: fragmentsToDocxBlocks(cellFrags),
        };
      }));
    }

    if (matchedRows < Math.ceil(run.length * 0.7)) continue;
    for (const fid of runFragIds) consumedIds.add(fid);

    const colWidthsPt = colAnchors.map((ax, idx) => {
      const nextAx = idx + 1 < numCols ? colAnchors[idx + 1] : Math.max(colEdgesRight[idx] + 12, ax + 80);
      return Math.max(36, nextAx - ax);
    });
    const xMin = colAnchors[0];
    const xMax = Math.max(...colEdgesRight, colAnchors[numCols - 1] + 60);

    tables.push({
      kind: 'table',
      yTop,
      yBot,
      x: xMin,
      x2: xMax,
      colWidthsPt,
      rows,
      borderStyle: hasNearbyRule ? 'threeLine' : 'grid',
    });
  }

  return { tables, consumedIds };
}

function buildTextElementsWithColumns(fragments, pageBox) {
  if (!fragments.length) return { hasColumns: false, gutterX: 0, elements: [] };
  const pageLeft = pageBox?.x || 0;
  const pageWidth = pageBox?.width || 595;

  const rawLines = groupFragmentsToVisualLines(fragments);
  const segLines = rawLines.map((ln) => {
    const bodyFs = ln.maxFont || 11;
    const splitGap = Math.max(18, bodyFs * 1.8);
    const segs = [];
    let cur = [];
    let prevEnd = null;
    for (const it of ln.items) {
      const w = it.width || estimateTextWidthPt(it.text, it.fontSize || bodyFs);
      if (prevEnd !== null && it.x - prevEnd >= splitGap) {
        segs.push(cur);
        cur = [it];
      } else {
        cur.push(it);
      }
      prevEnd = Math.max(prevEnd || 0, it.x + w);
    }
    if (cur.length) segs.push(cur);

    const segBoxes = segs.map((items) => {
      const x1 = items.reduce((m, it) => Math.min(m, it.x), Infinity);
      const x2 = items.reduce((m, it) => Math.max(m, it.endX || (it.x + estimateTextWidthPt(it.text, it.fontSize))), -Infinity);
      return { x1, x2, items };
    });

    return { y: ln.y, maxFont: bodyFs, segBoxes };
  });

  // 在页面中缝 [38%..62%] 扫描最佳双栏分割线
  let bestGutter = 0;
  let bestScore = 0;
  for (let frac = 0.40; frac <= 0.601; frac += 0.025) {
    const gx = pageLeft + pageWidth * frac;
    let dualLines = 0;
    let leftOnly = 0;
    let rightOnly = 0;
    let crossing = 0;

    for (const ln of segLines) {
      let hasLeft = false;
      let hasRight = false;
      let hasCross = false;
      for (const sb of ln.segBoxes) {
        if (sb.x1 < gx - 10 && sb.x2 > gx + 10) hasCross = true;
        else if (sb.x2 <= gx + 6) hasLeft = true;
        else if (sb.x1 >= gx - 6) hasRight = true;
      }
      if (hasCross) crossing++;
      else if (hasLeft && hasRight) dualLines++;
      else if (hasLeft) leftOnly++;
      else if (hasRight) rightOnly++;
    }

    const leftTotal = dualLines + leftOnly;
    const rightTotal = dualLines + rightOnly;
    if (dualLines >= 4 && leftTotal >= 4 && rightTotal >= 4 && crossing <= Math.max(2, dualLines * 0.45)) {
      const score = dualLines * 3 + Math.min(leftTotal, rightTotal) - crossing * 4;
      if (score > bestScore) {
        bestScore = score;
        bestGutter = gx;
      }
    }
  }

  if (!bestGutter) {
    return {
      hasColumns: false,
      gutterX: 0,
      elements: fragmentsToDocxBlocks(fragments),
    };
  }

  const elements = [];
  for (const it of fragments) it.__colFlag = 'unassigned';
  const spanFrags = [];
  const leftFrags = [];
  const rightFrags = [];

  for (const ln of segLines) {
    const hasCross = ln.segBoxes.some((sb) => sb.x1 < bestGutter - 10 && sb.x2 > bestGutter + 10);
    if (hasCross) {
      for (const sb of ln.segBoxes) spanFrags.push(...sb.items);
    } else {
      for (const sb of ln.segBoxes) {
        if (sb.x2 <= bestGutter + 6) leftFrags.push(...sb.items);
        else rightFrags.push(...sb.items);
      }
    }
  }

  const spanBlocks = fragmentsToDocxBlocks(spanFrags);
  const leftBlocks = fragmentsToDocxBlocks(leftFrags).map((b) => ({ ...b, __col: 'left' }));
  const rightBlocks = fragmentsToDocxBlocks(rightFrags).map((b) => ({ ...b, __col: 'right' }));
  elements.push(...spanBlocks, ...leftBlocks, ...rightBlocks);

  return {
    hasColumns: true,
    gutterX: bestGutter,
    elements,
  };
}

function arrangePageElementsInReadingOrder({ colResult, tables, images, pageBox }) {
  const pageLeft = pageBox?.x || 0;
  const pageWidth = pageBox?.width || 595;
  const pageHeight = pageBox?.height || 842;
  const hasNativeContent = colResult.elements.length > 0 || tables.length > 0;

  // 若页面已有原生文本/表格，过滤掉覆盖整页 >=90% 的扫描底纹背景图，保留真正插图
  const filteredImages = images.filter((img) => {
    if (!hasNativeContent) return true;
    const isFullBg = img.dispW >= pageWidth * 0.9 && img.dispH >= pageHeight * 0.9;
    return !isFullBg;
  });

  if (!colResult.hasColumns) {
    return [...colResult.elements, ...tables, ...filteredImages]
      .sort((a, b) => (b.yTop || 0) - (a.yTop || 0));
  }

  const gx = colResult.gutterX || (pageLeft + pageWidth / 2);
  const spanningItems = [];
  const leftItems = [];
  const rightItems = [];

  for (const el of colResult.elements) {
    if (el.__col === 'left') leftItems.push(el);
    else if (el.__col === 'right') rightItems.push(el);
    else spanningItems.push(el);
  }
  for (const tb of tables) {
    if (tb.x2 <= gx + 10) leftItems.push(tb);
    else if (tb.x >= gx - 10) rightItems.push(tb);
    else spanningItems.push(tb);
  }
  for (const img of filteredImages) {
    if (img.x2 <= gx + 10) leftItems.push(img);
    else if (img.x >= gx - 10) rightItems.push(img);
    else spanningItems.push(img);
  }

  spanningItems.sort((a, b) => (b.yTop || 0) - (a.yTop || 0));
  leftItems.sort((a, b) => (b.yTop || 0) - (a.yTop || 0));
  rightItems.sort((a, b) => (b.yTop || 0) - (a.yTop || 0));

  // 使用通栏元素纵向切分分界带，每带内先左栏后右栏
  const ordered = [];
  let upperY = Infinity;
  const emitBand = (lowerY) => {
    const inBand = (it) => (it.yTop || 0) <= upperY && (it.yTop || 0) > lowerY;
    const bandLeft = leftItems.filter(inBand);
    const bandRight = rightItems.filter(inBand);
    ordered.push(...bandLeft, ...bandRight);
  };

  for (const sp of spanningItems) {
    emitBand(sp.yTop || 0);
    ordered.push(sp);
    upperY = sp.yBot ?? sp.yTop ?? upperY;
  }
  emitBand(-Infinity);

  return ordered;
}

function ocrLinesToDocxBlocks(lines) {
  if (!Array.isArray(lines) || !lines.length) return [];
  const cleaned = lines
    .map((l) => ({ text: cleanOcrLineText(l.text), x: Number(l.x) || 0, y: Number(l.y) || 0, h: Math.max(8, Number(l.h) || 18) }))
    .filter((l) => l.text)
    .sort((a, b) => (Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x));
  if (!cleaned.length) return [];

  const heights = cleaned.map((l) => l.h).sort((a, b) => a - b);
  const bodyH = heights[Math.floor(heights.length / 2)] || 18;

  const blocks = [];
  let curText = '';
  let prev = null;

  const flush = () => {
    if (curText) {
      blocks.push({ heading: 0, text: curText });
      curText = '';
    }
  };

  for (const ln of cleaned) {
    if (ln.h >= bodyH * 1.35 && ln.text.length <= 45) {
      flush();
      blocks.push({ heading: ln.h >= bodyH * 1.7 ? 1 : 2, text: ln.text });
      prev = null;
      continue;
    }
    const gap = prev ? ln.y - (prev.y + prev.h) : 0;
    if (!curText || gap > Math.max(12, prev.h * 0.9) || /^[•·\-*]|\d+[.、)）]/.test(ln.text)) {
      flush();
      curText = ln.text;
    } else {
      const needSpace = /[a-zA-Z0-9]$/.test(curText) && /^[a-zA-Z0-9]/.test(ln.text);
      curText += (needSpace ? ' ' : '') + ln.text;
    }
    prev = ln;
  }
  flush();
  return blocks;
}

function buildDocxArchive({ bodyXml, mediaFiles = [], title = 'Document', pageWidthTwips = 11906, pageHeightTwips = 16838, marginTwips = 1440 }) {
  const zip = new AdmZip();

  const mediaExtensions = Array.from(new Set(mediaFiles.map((m) => m.ext)));
  const mediaTypes = mediaExtensions.map((ext) => {
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext || 'png'}`;
    return `<Default Extension="${ext}" ContentType="${mime}"/>`;
  }).join('');

  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${mediaTypes}
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`, 'utf8'));

  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`, 'utf8'));

  const nowIso = new Date().toISOString();
  zip.addFile('docProps/core.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(title)}</dc:title>
  <dc:creator>MediaKiln</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:created>
</cp:coreProperties>`, 'utf8'));

  zip.addFile('docProps/app.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>MediaKiln</Application>
</Properties>`, 'utf8'));

  zip.addFile('word/styles.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Calibri" w:eastAsia="微软雅黑" w:hAnsi="Calibri"/>
        <w:sz w:val="22"/>
        <w:szCs w:val="22"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="120" w:line="300" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
  </w:style>
</w:styles>`, 'utf8'));

  const relEntries = [
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    ...mediaFiles.map((m) => `<Relationship Id="${m.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.filename}"/>`),
  ];

  zip.addFile('word/_rels/document.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${relEntries.join('\n  ')}
</Relationships>`, 'utf8'));

  for (const m of mediaFiles) {
    zip.addFile(`word/media/${m.filename}`, m.buffer);
  }

  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    ${bodyXml}
    <w:sectPr>
      <w:pgSz w:w="${pageWidthTwips}" w:h="${pageHeightTwips}"/>
      <w:pgMar w:top="${marginTwips}" w:right="${marginTwips}" w:bottom="${marginTwips}" w:left="${marginTwips}"/>
    </w:sectPr>
  </w:body>
</w:document>`, 'utf8'));

  return zip.toBuffer();
}

function renderParagraphRunsOoxml(blk, { forceBold = false, compact = false } = {}) {
  const runs = Array.isArray(blk.runs) && blk.runs.length
    ? blk.runs
    : [{ text: blk.text || '', bold: false, colorHex: '' }];

  const runsXml = runs
    .filter((r) => r && r.text)
    .map((r) => {
      const rPrParts = [];
      if (forceBold || r.bold) rPrParts.push('<w:b/>');
      if (r.colorHex && /^[0-9A-F]{6}$/i.test(r.colorHex)) {
        rPrParts.push(`<w:color w:val="${r.colorHex}"/>`);
      }
      const rPr = rPrParts.length ? `<w:rPr>${rPrParts.join('')}</w:rPr>` : '';
      return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(r.text)}</w:t></w:r>`;
    })
    .join('');

  if (!runsXml) return '<w:p><w:r><w:t xml:space="preserve"> </w:t></w:r></w:p>';

  const pPrParts = [];
  if (blk.heading >= 1 && blk.heading <= 3) {
    pPrParts.push(`<w:pStyle w:val="Heading${blk.heading}"/>`);
  } else if (compact) {
    pPrParts.push('<w:spacing w:before="0" w:after="40" w:line="260" w:lineRule="auto"/>');
  }
  const pPr = pPrParts.length ? `<w:pPr>${pPrParts.join('')}</w:pPr>` : '';
  return `<w:p>${pPr}${runsXml}</w:p>`;
}

function renderTableOoxml(tbl, maxTableTwips) {
  const rawWidths = Array.isArray(tbl.colWidthsPt) && tbl.colWidthsPt.length ? tbl.colWidthsPt : [120, 120];
  const rawTotalPt = rawWidths.reduce((s, w) => s + Math.max(18, w), 0) || 240;
  const colTwips = rawWidths.map((w) => Math.max(360, Math.round((Math.max(18, w) / rawTotalPt) * maxTableTwips)));
  const sumTwips = colTwips.reduce((s, w) => s + w, 0);
  if (colTwips.length && sumTwips !== maxTableTwips) {
    colTwips[colTwips.length - 1] += maxTableTwips - sumTwips;
  }

  const isThreeLine = tbl.borderStyle === 'threeLine';
  const bordersXml = isThreeLine
    ? `<w:tblBorders>
        <w:top w:val="single" w:sz="10" w:space="0" w:color="334155"/>
        <w:left w:val="none" w:sz="0" w:space="0" w:color="auto"/>
        <w:bottom w:val="single" w:sz="10" w:space="0" w:color="334155"/>
        <w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/>
        <w:insideH w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>
        <w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/>
      </w:tblBorders>`
    : `<w:tblBorders>
        <w:top w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
        <w:left w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
        <w:bottom w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
        <w:right w:val="single" w:sz="6" w:space="0" w:color="CBD5E1"/>
        <w:insideH w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>
        <w:insideV w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>
      </w:tblBorders>`;

  const gridColsXml = colTwips.map((w) => `<w:gridCol w:w="${w}"/>`).join('');

  const trsXml = (tbl.rows || []).map((rowCells, rowIdx) => {
    let colCursor = 0;
    const tcsXml = rowCells.map((cell) => {
      const span = Math.max(1, Number(cell.colSpan) || 1);
      let cellW = 0;
      for (let k = 0; k < span && colCursor + k < colTwips.length; k++) {
        cellW += colTwips[colCursor + k];
      }
      if (!cellW) cellW = 720;
      colCursor += span;

      const tcPrParts = [`<w:tcW w:w="${cellW}" w:type="dxa"/>`];
      if (span > 1) tcPrParts.push(`<w:gridSpan w:val="${span}"/>`);
      if (cell.vMerge === 'restart') tcPrParts.push('<w:vMerge w:val="restart"/>');
      else if (cell.vMerge === 'continue') tcPrParts.push('<w:vMerge/>');
      if (rowIdx === 0 && cell.vMerge !== 'continue') {
        tcPrParts.push('<w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/>');
      }
      tcPrParts.push('<w:vAlign w:val="center"/>');

      let innerXml = '';
      if (cell.vMerge === 'continue' || !cell.blocks?.length) {
        innerXml = '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:p>';
      } else {
        innerXml = cell.blocks
          .map((b) => renderParagraphRunsOoxml(b, { forceBold: rowIdx === 0, compact: true }))
          .join('');
      }
      return `<w:tc><w:tcPr>${tcPrParts.join('')}</w:tcPr>${innerXml}</w:tc>`;
    }).join('');
    return `<w:tr>${tcsXml}</w:tr>`;
  }).join('\n      ');

  return `<w:tbl>
      <w:tblPr>
        <w:tblW w:w="${maxTableTwips}" w:type="dxa"/>
        ${bordersXml}
        <w:tblLayout w:type="fixed"/>
        <w:tblCellMar>
          <w:top w:w="70" w:type="dxa"/>
          <w:left w:w="110" w:type="dxa"/>
          <w:bottom w:w="70" w:type="dxa"/>
          <w:right w:w="110" w:type="dxa"/>
        </w:tblCellMar>
      </w:tblPr>
      <w:tblGrid>${gridColsXml}</w:tblGrid>
      ${trsXml}
    </w:tbl><w:p><w:pPr><w:spacing w:before="0" w:after="80"/></w:pPr></w:p>`;
}

function buildTextPagesDocxBuffer(docPages, title, keepPageBreak = true) {
  const pageWidthTwips = 11906;
  const pageHeightTwips = 16838;
  const marginTwips = 1440;
  const contentWidthTwips = pageWidthTwips - marginTwips * 2;
  const maxW_Emu = Math.round(contentWidthTwips * 635);
  const maxH_Emu = Math.round((pageHeightTwips - marginTwips * 2) * 0.85 * 635);

  const mediaFiles = [];
  const mediaByXo = new Map();
  let nextMediaSeq = 1;
  let nextDocPrId = 1;
  let totalTables = 0;
  let placedImages = 0;

  const ensureMediaRel = (imgEl) => {
    if (imgEl.xoRef && mediaByXo.has(imgEl.xoRef)) {
      return mediaByXo.get(imgEl.xoRef);
    }
    const seq = nextMediaSeq++;
    const rId = `rIdImg${seq}`;
    const ext = imgEl.ext === 'jpg' ? 'jpg' : 'png';
    const filename = `image_${String(seq).padStart(4, '0')}.${ext}`;
    mediaFiles.push({ rId, filename, ext, buffer: imgEl.buffer });
    const entry = { rId, filename };
    if (imgEl.xoRef) mediaByXo.set(imgEl.xoRef, entry);
    return entry;
  };

  const parts = [];
  for (let i = 0; i < docPages.length; i++) {
    if (i > 0 && keepPageBreak) {
      parts.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    }
    const pg = docPages[i];
    const items = pg.elements || pg.blocks || [];
    if (!items.length) {
      parts.push('<w:p><w:r><w:t xml:space="preserve"> </w:t></w:r></w:p>');
      continue;
    }

    for (const el of items) {
      if (el.kind === 'table') {
        totalTables++;
        parts.push(renderTableOoxml(el, contentWidthTwips));
      } else if (el.kind === 'image') {
        const rel = ensureMediaRel(el);
        const rawEmuW = Math.max(12700, Math.round((el.dispW || el.pixW * 0.75 || 200) * 12700));
        const rawEmuH = Math.max(12700, Math.round((el.dispH || el.pixH * 0.75 || 150) * 12700));
        const scale = Math.min(1, maxW_Emu / rawEmuW, maxH_Emu / rawEmuH);
        const cx = Math.max(12700, Math.round(rawEmuW * scale));
        const cy = Math.max(12700, Math.round(rawEmuH * scale));
        const docPrId = nextDocPrId++;
        placedImages++;

        parts.push(`<w:p>
      <w:pPr><w:jc w:val="center"/><w:spacing w:before="80" w:after="120"/></w:pPr>
      <w:r>
        <w:drawing>
          <wp:inline distT="0" distB="0" distL="0" distR="0">
            <wp:extent cx="${cx}" cy="${cy}"/>
            <wp:docPr id="${docPrId}" name="${rel.filename}"/>
            <a:graphic>
              <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:pic>
                  <pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${rel.filename}"/><pic:cNvPicPr/></pic:nvPicPr>
                  <pic:blipFill>
                    <a:blip r:embed="${rel.rId}"/>
                    <a:stretch><a:fillRect/></a:stretch>
                  </pic:blipFill>
                  <pic:spPr>
                    <a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
                    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                  </pic:spPr>
                </pic:pic>
              </a:graphicData>
            </a:graphic>
          </wp:inline>
        </w:drawing>
      </w:r>
    </w:p>`);
      } else {
        parts.push(renderParagraphRunsOoxml(el));
      }
    }
  }

  return {
    buffer: buildDocxArchive({
      bodyXml: parts.join('\n    '),
      mediaFiles,
      title,
      pageWidthTwips,
      pageHeightTwips,
      marginTwips,
    }),
    tableCount: totalTables,
    imageCount: placedImages,
  };
}

function buildLayoutPagesDocxBuffer(pageItems, title) {
  const pageWidthTwips = 11906; // A4 210mm
  const pageHeightTwips = 16838; // A4 297mm
  const marginTwips = 720; // 0.5 in
  const maxW_Emu = Math.round((pageWidthTwips - marginTwips * 2) * 635);
  const maxH_Emu = Math.round((pageHeightTwips - marginTwips * 2) * 635);

  const mediaFiles = [];
  const parts = [];

  for (let i = 0; i < pageItems.length; i++) {
    if (i > 0) {
      parts.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    }
    const item = pageItems[i];
    const rId = `rIdImg${i + 1}`;
    const filename = `page_${String(i + 1).padStart(4, '0')}.jpg`;
    mediaFiles.push({ rId, filename, ext: 'jpg', buffer: item.jpgBuf });

    const scale = Math.min(maxW_Emu / Math.max(1, item.width), maxH_Emu / Math.max(1, item.height));
    const cx = Math.max(12700, Math.round(item.width * scale));
    const cy = Math.max(12700, Math.round(item.height * scale));
    const docPrId = i + 1;

    parts.push(`<w:p>
      <w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/></w:pPr>
      <w:r>
        <w:drawing>
          <wp:inline distT="0" distB="0" distL="0" distR="0">
            <wp:extent cx="${cx}" cy="${cy}"/>
            <wp:docPr id="${docPrId}" name="${filename}"/>
            <a:graphic>
              <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:pic>
                  <pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${filename}"/><pic:cNvPicPr/></pic:nvPicPr>
                  <pic:blipFill>
                    <a:blip r:embed="${rId}"/>
                    <a:stretch><a:fillRect/></a:stretch>
                  </pic:blipFill>
                  <pic:spPr>
                    <a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
                    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                  </pic:spPr>
                </pic:pic>
              </a:graphicData>
            </a:graphic>
          </wp:inline>
        </w:drawing>
      </w:r>
    </w:p>`);
  }

  return buildDocxArchive({
    bodyXml: parts.join('\n    '),
    mediaFiles,
    title,
    pageWidthTwips,
    pageHeightTwips,
    marginTwips,
  });
}

async function convertPdfToWord(inputPath, outputPath, opts = {}) {
  const mode = ['editable', 'ocr', 'layout'].includes(opts.mode) ? opts.mode : 'editable';
  const ocrLang = ['auto', 'zh', 'en'].includes(opts.ocrLang) ? opts.ocrLang : 'auto';
  const keepPageBreak = opts.keepPageBreak !== 'no' && opts.keepPageBreak !== false;
  const dpiScale = Math.min(Math.max(Number(opts.dpiScale) || 2, 1.5), 3);
  const pageRange = String(opts.pageRange || '').trim();
  const taskId = opts.taskId || null;
  const onProgress = opts.onProgress || null;

  onProgress?.(0.05);
  const { doc } = await loadPdfSafe(inputPath);
  const totalPages = doc.getPageCount();
  const targetPages = parsePageRange(pageRange, totalPages);
  const title = path.basename(inputPath, path.extname(inputPath));

  if (mode === 'layout') {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_pdf2word_lay_'));
    try {
      const pngs = await renderPdfPagesToPngs(inputPath, tmpDir, {
        pages: targetPages,
        scale: dpiScale,
        taskId,
        onProgress: (r) => onProgress?.(0.08 + r * 0.5),
      });

      const pageItems = [];
      for (let i = 0; i < pngs.length; i++) {
        const jpgPath = path.join(tmpDir, `page_${i + 1}.jpg`);
        await runFfmpeg(taskId, [
          '-i', pngs[i],
          '-filter_complex',
          '[0:v]setsar=1,format=rgba,split[__fg][__bgsrc];[__bgsrc]drawbox=x=0:y=0:w=iw:h=ih:color=0xffffff@1:t=fill[__bg];[__bg][__fg]overlay=0:0:shortest=1:format=rgb,format=rgb24[vout]',
          '-map', '[vout]',
          '-map_metadata', '-1',
          '-c:v', 'mjpeg', '-q:v', '3', '-update', '1', '-frames:v', '1',
          jpgPath,
        ], { totalDuration: 0 });
        const jpgBuf = fs.readFileSync(jpgPath);
        let dims = getJpegDimensions(jpgBuf);
        if (!dims) {
          const info = await probe(jpgPath);
          dims = { width: info.width || 1000, height: info.height || 1400 };
        }
        pageItems.push({ jpgBuf, width: dims.width, height: dims.height });
        onProgress?.(0.6 + (0.3 * (i + 1)) / pngs.length);
      }

      const docxBuf = buildLayoutPagesDocxBuffer(pageItems, title);
      writeTaskOutput(outputPath, docxBuf);
      onProgress?.(1);
      return {
        output: outputPath,
        pageCount: targetPages.length,
        totalPages,
        nativePages: 0,
        ocrPages: 0,
        tableCount: 0,
        imageCount: pageItems.length,
        mode,
        outputSize: docxBuf.length,
      };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  const docPages = [];
  const needOcrIndices = [];
  let nativePages = 0;

  if (mode === 'editable') {
    const context = doc.context;
    const allPages = doc.getPages();
    const imageCache = new Map();

    for (let idx = 0; idx < targetPages.length; idx++) {
      const pNum = targetPages[idx];
      const page = allPages[pNum - 1];
      const cropBox = page.getCropBox() || page.getMediaBox();
      const pageBox = {
        x: cropBox?.x || 0,
        y: cropBox?.y || 0,
        width: cropBox?.width || 595,
        height: cropBox?.height || 842,
      };
      const resources = page.node.Resources()
        || context.lookup(page.node.getInheritableAttribute(PDFName.of('Resources')));
      const buf = getPageContentsBuffer(context, page.node);
      const parsed = buf.length
        ? extractPageStructuredElements(context, buf, resources, [1, 0, 0, 1, 0, 0], 0, imageCache)
        : { fragments: [], hSegments: [], vSegments: [], images: [] };

      const { tables, consumedIds } = extractTablesFromPage(
        parsed.fragments,
        parsed.hSegments,
        parsed.vSegments,
        pageBox.width,
      );
      const remFrags = parsed.fragments.filter((f) => !consumedIds.has(f.id));
      const colResult = buildTextElementsWithColumns(remFrags, pageBox);

      const nativeTextParts = [
        ...colResult.elements.map((e) => e.text || ''),
        ...tables.flatMap((t) => t.rows.flatMap((r) => r.flatMap((c) => (c.blocks || []).map((b) => b.text || '')))),
      ];
      const fullText = nativeTextParts.join('');
      const hasReadableText = fullText.trim().length > 0 && !isGarbledText(fullText);

      if (!hasReadableText) {
        docPages.push({ pageNum: pNum, pageBox, elements: [], rawImages: parsed.images });
        needOcrIndices.push(idx);
      } else {
        const ordered = arrangePageElementsInReadingOrder({
          colResult,
          tables,
          images: parsed.images,
          pageBox,
        });
        docPages.push({ pageNum: pNum, elements: ordered });
        nativePages++;
      }
      onProgress?.(0.08 + (0.25 * (idx + 1)) / targetPages.length);
    }
  } else {
    for (let idx = 0; idx < targetPages.length; idx++) {
      docPages.push({ pageNum: targetPages[idx], blocks: [] });
      needOcrIndices.push(idx);
    }
  }

  let ocrPages = 0;
  if (needOcrIndices.length) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_pdf2word_ocr_'));
    try {
      const ocrPageNums = needOcrIndices.map((idx) => targetPages[idx]);
      const pngs = await renderPdfPagesToPngs(inputPath, tmpDir, {
        pages: ocrPageNums,
        scale: 2,
        taskId,
        onProgress: (r) => onProgress?.(0.35 + r * 0.25),
      });
      const ocrResults = await runWinRtOcrOnImages(pngs, {
        ocrLang,
        taskId,
        onProgress: (r) => onProgress?.(0.6 + r * 0.32),
      });
      for (let i = 0; i < needOcrIndices.length; i++) {
        const idx = needOcrIndices[i];
        const ocrBlocks = ocrLinesToDocxBlocks(ocrResults[i] || []);
        const pg = docPages[idx];
        if (pg.rawImages?.length) {
          const pw = pg.pageBox?.width || 595;
          const ph = pg.pageBox?.height || 842;
          const nonScanImgs = ocrBlocks.length
            ? pg.rawImages.filter((img) => img.dispW * img.dispH < pw * ph * 0.8)
            : pg.rawImages;
          pg.elements = [...ocrBlocks, ...nonScanImgs];
        } else {
          pg.blocks = ocrBlocks;
        }
        ocrPages++;
      }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  const built = buildTextPagesDocxBuffer(docPages, title, keepPageBreak);
  writeTaskOutput(outputPath, built.buffer);
  onProgress?.(1);

  return {
    output: outputPath,
    pageCount: targetPages.length,
    totalPages,
    nativePages,
    ocrPages,
    tableCount: built.tableCount,
    imageCount: built.imageCount,
    mode,
    outputSize: built.buffer.length,
  };
}

// ---------------------------------------------------------------------------
// 3. PDF 压缩瘦身
// ---------------------------------------------------------------------------

async function reencodePdfImage(taskId, candidate, tmpDir, index, { limitSide, quality }) {
  const { obj, w, h, channels, kind } = candidate;
  const source = path.join(tmpDir, `src_${index}.${kind === 'dct' ? 'jpg' : 'raw'}`);
  const output = path.join(tmpDir, 'candidate.jpg');
  const inputArgs = [];
  if (kind === 'flate') {
    inputArgs.push('-f', 'rawvideo', '-pixel_format', channels === 1 ? 'gray' : 'rgb24', '-video_size', `${w}x${h}`);
  }
  if (!fs.existsSync(source)) {
    if (kind === 'dct') {
      fs.writeFileSync(source, obj.contents);
    } else {
      const expectedBytes = w * h * channels;
      if (!Number.isSafeInteger(expectedBytes)) return null;
      const pixels = zlib.inflateSync(obj.contents, { maxOutputLength: expectedBytes });
      if (pixels.length !== expectedBytes) return null;
      fs.writeFileSync(source, pixels);
    }
  }
  const filter = limitSide > 0
    ? `scale='min(${limitSide},iw)':'min(${limitSide},ih)':force_original_aspect_ratio=decrease:flags=lanczos,format=yuvj420p`
    : 'format=yuvj420p';
  await runFfmpeg(taskId, [
    ...inputArgs, '-i', source, '-vf', filter,
    '-map_metadata', '-1', '-c:v', 'mjpeg', '-q:v', String(quality), '-update', '1', '-frames:v', '1', output,
  ], { totalDuration: 0 });
  return fs.readFileSync(output);
}

async function compressPdfFile(inputPath, outputPath, opts = {}) {
  const preset = ['high', 'balanced', 'extreme', 'raster'].includes(opts.preset) ? opts.preset : 'balanced';
  const maxSideNum = Math.max(0, Math.round(Number(opts.maxSide) || 0));
  const rasterDpi = Math.min(Math.max(Number(opts.rasterDpi) || 150, 72), 300);
  const taskId = opts.taskId || null;
  const onProgress = opts.onProgress || null;
  const targetBytes = opts.targetBytes;
  const hasTarget = targetBytes !== undefined;
  if (hasTarget && (!Number.isSafeInteger(targetBytes) || targetBytes <= 0)) {
    throw new Error('目标大小必须为正整数（字节）');
  }
  if (hasTarget && preset === 'raster') {
    throw new Error('按目标大小压缩需要使用保留文字的模式');
  }
  if (fs.existsSync(outputPath)) {
    const source = fs.realpathSync(inputPath);
    const destination = fs.realpathSync(outputPath);
    const sameFile = process.platform === 'win32'
      ? source.toLowerCase() === destination.toLowerCase() : source === destination;
    if (sameFile) throw new Error('压缩输出不能覆盖输入 PDF');
  }

  onProgress?.(0.05);
  throwIfTaskCancelled(taskId);
  const { doc, rawBuffer } = await loadPdfSafe(inputPath);
  const origSize = rawBuffer.length;
  const pageCount = doc.getPageCount();
  const finish = (buffer, compressedImages, skippedShrink) => {
    throwIfTaskCancelled(taskId);
    writeTaskOutput(outputPath, buffer);
    onProgress?.(1);
    return {
      output: outputPath,
      pageCount,
      origSize,
      newSize: buffer.length,
      compressedImages,
      mode: preset,
      skippedShrink,
      ...(hasTarget && { targetBytes, targetReached: buffer.length <= targetBytes }),
    };
  };

  if (hasTarget && origSize <= targetBytes) return finish(rawBuffer, 0, true);

  if (preset === 'raster') {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_pdf_raster_'));
    try {
      const scale = rasterDpi / 96;
      const pngs = await renderPdfPagesToPngs(inputPath, tmpDir, {
        scale,
        taskId,
        onProgress: (r) => onProgress?.(0.08 + r * 0.55),
      });
      const pages = [];
      for (let i = 0; i < pngs.length; i++) {
        const jpgPath = path.join(tmpDir, `comp_${i + 1}.jpg`);
        await runFfmpeg(taskId, [
          '-i', pngs[i],
          '-filter_complex',
          '[0:v]setsar=1,format=rgba,split[__fg][__bgsrc];[__bgsrc]drawbox=x=0:y=0:w=iw:h=ih:color=0xffffff@1:t=fill[__bg];[__bg][__fg]overlay=0:0:shortest=1:format=rgb,format=rgb24[vout]',
          '-map', '[vout]',
          '-map_metadata', '-1', '-c:v', 'mjpeg', '-q:v', '7', '-update', '1', '-frames:v', '1', jpgPath,
        ], { totalDuration: 0 });
        const jpgBuf = fs.readFileSync(jpgPath);
        let dims = getJpegDimensions(jpgBuf);
        if (!dims) {
          const info = await probe(jpgPath);
          dims = { width: info.width || 800, height: info.height || 1000 };
        }
        pages.push({ jpgBuf, width: dims.width, height: dims.height });
        onProgress?.(0.65 + (0.28 * (i + 1)) / pngs.length);
      }
      const pdfBuf = buildPdfFromJpegPages(pages, { pageSize: 'fit', margin: 0 });
      return finish(pdfBuf, pages.length, false);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  const quality = preset === 'high' ? 4 : (preset === 'extreme' ? 12 : 7);
  const limitSide = opts.maxSide !== undefined
    ? maxSideNum
    : (preset === 'high' ? 2560 : (preset === 'extreme' ? 1280 : 1920));

  let bestBuffer = rawBuffer;
  let bestImageCount = 0;
  const save = async (compressedImages) => {
    throwIfTaskCancelled(taskId);
    const buffer = Buffer.from(await doc.save({ useObjectStreams: true }));
    if (buffer.length < bestBuffer.length) {
      bestBuffer = buffer;
      bestImageCount = compressedImages;
    }
  };
  if (hasTarget) {
    await save(0);
    if (bestBuffer.length <= targetBytes) return finish(bestBuffer, 0, bestBuffer === rawBuffer);
  }

  const candidates = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (dict.lookup(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    if (dict.has(PDFName.of('SMask')) || dict.has(PDFName.of('Mask')) || dict.has(PDFName.of('Decode'))) continue;
    const imgMask = dict.lookup(PDFName.of('ImageMask'));
    if (imgMask === PDFBool.True) continue;

    const cs = dict.lookup(PDFName.of('ColorSpace'));
    if (cs !== PDFName.of('DeviceRGB') && cs !== PDFName.of('DeviceGray')) continue;

    const filter = dict.lookup(PDFName.of('Filter'));
    const wObj = dict.lookup(PDFName.of('Width'));
    const hObj = dict.lookup(PDFName.of('Height'));
    const w = wObj instanceof PDFNumber ? wObj.asNumber() : 0;
    const h = hObj instanceof PDFNumber ? hObj.asNumber() : 0;
    if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 32 || h < 32) continue;

    if (filter === PDFName.of('DCTDecode') && obj.contents.length > 20 * 1024) {
      candidates.push({ kind: 'dct', ref, obj, w, h });
    } else if (filter === PDFName.of('FlateDecode') && obj.contents.length > 10 * 1024) {
      const bpc = dict.lookup(PDFName.of('BitsPerComponent'));
      if (!(bpc instanceof PDFNumber) || bpc.asNumber() !== 8) continue;
      const dp = dict.lookup(PDFName.of('DecodeParms'));
      if (dp instanceof PDFDict) {
        const pred = dp.lookup(PDFName.of('Predictor'));
        if (pred instanceof PDFNumber && pred.asNumber() > 1) continue;
      }
      candidates.push({ kind: 'flate', ref, obj, w, h, channels: cs === PDFName.of('DeviceGray') ? 1 : 3 });
    }
  }

  if (!candidates.length) {
    if (!hasTarget) await save(0);
    return finish(bestBuffer, bestImageCount, bestBuffer === rawBuffer);
  }

  // ponytail: 固定几档搜索，控制大文档的处理时间；每一档都从原图重新编码。
  const attempts = [{ limitSide, quality }];
  if (hasTarget) {
    for (const [side, increment] of [[1280, 4], [960, 10], [640, 17]]) {
      attempts.push({ limitSide: Math.min(limitSide, side), quality: quality + increment });
    }
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_pdf_comp_'));
  const totalEncodes = candidates.length * attempts.length;
  let encodes = 0;
  let compressedImages = 0;
  try {
    for (const attempt of attempts) {
      let changed = false;
      for (const [index, candidate] of candidates.entries()) {
        throwIfTaskCancelled(taskId);
        const { ref, obj } = candidate;
        const current = doc.context.lookup(ref);
        let encoded;
        try {
          encoded = await reencodePdfImage(taskId, candidate, tmpDir, index, attempt);
        } catch (err) {
          if (err.message === '任务已取消') throw err;
        }
        const dims = encoded && getJpegDimensions(encoded);
        const threshold = hasTarget ? current.contents.length : obj.contents.length * 0.92;
        if (dims && encoded.length < threshold) {
          const dict = obj.dict.clone();
          dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
          dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
          dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
          dict.set(PDFName.of('Width'), PDFNumber.of(dims.width));
          dict.set(PDFName.of('Height'), PDFNumber.of(dims.height));
          dict.delete(PDFName.of('DecodeParms'));
          doc.context.assign(ref, PDFRawStream.of(dict, encoded));
          if (current === obj) compressedImages++;
          changed = true;
        }
        encodes++;
        onProgress?.(0.1 + 0.8 * encodes / totalEncodes);
      }
      if (changed || !hasTarget) await save(compressedImages);
      if (hasTarget && bestBuffer.length <= targetBytes) break;
    }
    return finish(bestBuffer, bestImageCount, bestBuffer === rawBuffer);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// 4. PDF 页面旋转
// ---------------------------------------------------------------------------

async function rotatePdfPages(inputPath, outputPath, opts = {}) {
  const direction = ['cw90', 'ccw90', '180'].includes(opts.direction) ? opts.direction : 'cw90';
  const delta = direction === 'ccw90' ? 270 : (direction === '180' ? 180 : 90);
  const pageRange = String(opts.pageRange || '').trim();
  const onProgress = opts.onProgress || null;

  onProgress?.(0.1);
  const { doc } = await loadPdfSafe(inputPath);
  const totalPages = doc.getPageCount();
  const targetPages = parsePageRange(pageRange, totalPages);
  const allPages = doc.getPages();

  for (const pNum of targetPages) {
    const page = allPages[pNum - 1];
    const cur = ((page.getRotation().angle % 360) + 360) % 360;
    page.setRotation(degrees((cur + delta) % 360));
  }

  onProgress?.(0.8);
  const outBuf = await doc.save({ useObjectStreams: false });
  writeTaskOutput(outputPath, outBuf);
  onProgress?.(1);

  return {
    output: outputPath,
    totalPages,
    rotatedCount: targetPages.length,
    angle: delta,
    outputSize: outBuf.length,
  };
}

// ---------------------------------------------------------------------------
// 5. PDF 水印与页码
// ---------------------------------------------------------------------------

function renderTextPngWithResvg(text, { fontSize = 42, colorHex = '64748b', opacity = 1, bold = true } = {}) {
  const cleanText = String(text || '').trim();
  const approxWidth = Math.max(120, Math.ceil(cleanText.length * fontSize * 1.15 + fontSize * 1.2));
  const height = Math.ceil(fontSize * 1.6);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${approxWidth}" height="${height}" viewBox="0 0 ${approxWidth} ${height}">
    <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle"
      font-family="Microsoft YaHei, Microsoft YaHei UI, SimHei, Segoe UI, sans-serif"
      font-size="${fontSize}" font-weight="${bold ? '700' : '500'}"
      fill="#${colorHex}" fill-opacity="${opacity}">${escapeXml(cleanText)}</text>
  </svg>`;
  const r = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'Microsoft YaHei' } });
  const rendered = r.render();
  return { png: rendered.asPng(), width: rendered.width, height: rendered.height };
}

async function watermarkAndNumberPdf(inputPath, outputPath, opts = {}) {
  const contentMode = ['watermark', 'pageNum', 'both'].includes(opts.contentMode) ? opts.contentMode : 'watermark';
  const hasWatermark = contentMode === 'watermark' || contentMode === 'both';
  const hasPageNumbers = contentMode === 'pageNum' || contentMode === 'both';
  const wmText = String(opts.wmText || '').trim();
  if (hasWatermark && !wmText) {
    throw new Error('请输入要添加的水印文字');
  }

  const wmStyle = ['tiled', 'center', 'br', 'tr'].includes(opts.wmStyle) ? opts.wmStyle : 'tiled';
  const wmColorHex = normalizeHexColor(opts.wmColor, '64748b');
  const wmOpacity = Math.min(Math.max(Number(opts.wmOpacity) || 0.28, 0.08), 0.9);
  const wmSize = ['small', 'medium', 'large'].includes(opts.wmSize) ? opts.wmSize : 'medium';
  const numFormat = ['slash', 'zh', 'dash'].includes(opts.numFormat) ? opts.numFormat : 'slash';
  const numPos = ['bc', 'br', 'tc'].includes(opts.numPos) ? opts.numPos : 'bc';
  const skipCover = String(opts.numStart || '1') === '2';
  const pageRange = String(opts.pageRange || '').trim();
  const onProgress = opts.onProgress || null;

  onProgress?.(0.08);
  const { doc } = await loadPdfSafe(inputPath);
  const totalPages = doc.getPageCount();
  const targetPages = parsePageRange(pageRange, totalPages);
  const allPages = doc.getPages();

  let wmImg = null;
  let wmScalePtW = 0;
  let wmScalePtH = 0;
  if (hasWatermark) {
    const basePtSize = wmSize === 'small' ? 14 : (wmSize === 'large' ? 28 : 20);
    const resvgFontPx = basePtSize * 3;
    const rendered = renderTextPngWithResvg(wmText, {
      fontSize: resvgFontPx,
      colorHex: wmColorHex,
      opacity: 1,
      bold: true,
    });
    wmImg = await doc.embedPng(rendered.png);
    wmScalePtW = rendered.width / 3;
    wmScalePtH = rendered.height / 3;
  }

  let helvFont = null;
  if (hasPageNumbers && numFormat !== 'zh') {
    helvFont = await doc.embedFont(StandardFonts.Helvetica);
  }

  const targetSet = new Set(targetPages);
  const displayTotal = skipCover ? Math.max(1, totalPages - 1) : totalPages;

  for (let idx = 0; idx < totalPages; idx++) {
    const pageNum = idx + 1;
    if (!targetSet.has(pageNum)) continue;
    const page = allPages[idx];
    const { width, height } = page.getSize();

    if (hasWatermark && wmImg) {
      if (wmStyle === 'tiled') {
        const stepX = Math.max(190, wmScalePtW + 70);
        const stepY = Math.max(145, wmScalePtH + 95);
        for (let y = 40; y < height + 40; y += stepY) {
          const rowOffset = Math.floor(y / stepY) % 2 === 1 ? stepX * 0.45 : 0;
          for (let x = -40 + rowOffset; x < width + 60; x += stepX) {
            page.drawImage(wmImg, {
              x,
              y,
              width: wmScalePtW,
              height: wmScalePtH,
              opacity: wmOpacity,
              rotate: degrees(35),
            });
          }
        }
      } else if (wmStyle === 'center') {
        const maxDiagW = Math.min(width, height) * 0.78;
        const scale = wmScalePtW > 0 ? Math.min(1.6, maxDiagW / wmScalePtW) : 1;
        const drawW = wmScalePtW * scale;
        const drawH = wmScalePtH * scale;
        const rad = (35 * Math.PI) / 180;
        const cx = width / 2;
        const cy = height / 2;
        page.drawImage(wmImg, {
          x: cx - (drawW * Math.cos(rad) - drawH * Math.sin(rad)) / 2,
          y: cy - (drawW * Math.sin(rad) + drawH * Math.cos(rad)) / 2,
          width: drawW,
          height: drawH,
          opacity: wmOpacity,
          rotate: degrees(35),
        });
      } else {
        const margin = 20;
        const drawW = Math.min(wmScalePtW, width * 0.48);
        const drawH = wmScalePtW > 0 ? (wmScalePtH * drawW) / wmScalePtW : wmScalePtH;
        const x = Math.max(margin, width - drawW - margin);
        const y = wmStyle === 'tr' ? Math.max(margin, height - drawH - margin) : margin;
        page.drawImage(wmImg, {
          x,
          y,
          width: drawW,
          height: drawH,
          opacity: wmOpacity,
        });
      }
    }

    if (hasPageNumbers && !(skipCover && pageNum === 1)) {
      const dispNum = skipCover ? pageNum - 1 : pageNum;
      const label = numFormat === 'zh'
        ? `第 ${dispNum} / ${displayTotal} 页`
        : (numFormat === 'dash' ? `- ${dispNum} -` : `${dispNum} / ${displayTotal}`);
      const marginX = 28;
      const yBottom = 18;
      const yTop = Math.max(30, height - 28);

      if (numFormat === 'zh') {
        const renderedNum = renderTextPngWithResvg(label, {
          fontSize: 25,
          colorHex: '475569',
          opacity: 0.92,
          bold: false,
        });
        const numImg = await doc.embedPng(renderedNum.png);
        const drawW = renderedNum.width / 2.5;
        const drawH = renderedNum.height / 2.5;
        const x = numPos === 'br'
          ? Math.max(marginX, width - drawW - marginX)
          : Math.max(10, (width - drawW) / 2);
        const y = numPos === 'tc' ? yTop - drawH / 2 : yBottom;
        page.drawImage(numImg, { x, y, width: drawW, height: drawH });
      } else {
        const fontSize = 10;
        const textW = helvFont.widthOfTextAtSize(label, fontSize);
        const x = numPos === 'br'
          ? Math.max(marginX, width - textW - marginX)
          : Math.max(10, (width - textW) / 2);
        const y = numPos === 'tc' ? yTop : yBottom;
        page.drawText(label, {
          x,
          y,
          size: fontSize,
          font: helvFont,
          color: rgb(0.28, 0.33, 0.41),
        });
      }
    }

    onProgress?.(0.15 + (0.75 * (idx + 1)) / totalPages);
  }

  const outBuf = await doc.save({ useObjectStreams: false });
  writeTaskOutput(outputPath, outBuf);
  onProgress?.(1);

  return {
    output: outputPath,
    totalPages,
    affectedCount: targetPages.length,
    hasWatermark,
    hasPageNumbers,
    outputSize: outBuf.length,
  };
}

module.exports = {
  buildDocxHtmlDocument,
  hasSearchablePageText,
  loadPdfSafe,
  convertWordToPdf,
  convertPdfToWord,
  compressPdfFile,
  rotatePdfPages,
  watermarkAndNumberPdf,
};
