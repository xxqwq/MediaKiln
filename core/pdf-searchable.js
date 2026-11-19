'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { setImmediate: yieldToTasks } = require('timers/promises');
const {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  TextRenderingMode,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSpacing,
  setCharacterSqueeze,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  setTextRise,
  setWordSpacing,
  showText,
} = require('pdf-lib');
const { parsePageRange, renderPdfPagesToPngs } = require('./pdf-engine');
const { cleanOcrLineText, hasSearchablePageText, loadPdfSafe, runWinRtOcrOnImages } = require('./pdf-office');
const { throwIfTaskCancelled, writeTaskOutput } = require('./runner');

const PAGES_PER_BATCH = 16;

function unicodeHex(character) {
  return Buffer.from(character, 'utf16le').swap16().toString('hex').toUpperCase();
}

function makeUnicodeMap(characters) {
  const entries = characters.map((character, index) => {
    const code = (index + 1).toString(16).padStart(2, '0');
    return `<${code}> <${unicodeHex(character)}>`;
  });
  const map = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /VGTSearchUnicode def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<01> <FF>',
    'endcodespacerange',
  ];
  for (let offset = 0; offset < entries.length; offset += 100) {
    const batch = entries.slice(offset, offset + 100);
    map.push(`${batch.length} beginbfchar`, ...batch, 'endbfchar');
  }
  map.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  return map.join('\n');
}

function registerSearchFont(context, characters, blankGlyph) {
  // Empty Type 3 glyphs carry measured selections and Unicode without a system font.
  const glyphNames = characters.map((_, index) => `g${index + 1}`);
  const charProcs = Object.fromEntries(glyphNames.map((name) => [name, blankGlyph]));
  const toUnicode = context.register(context.flateStream(makeUnicodeMap(characters)));
  return context.register(context.obj({
    Type: 'Font',
    Subtype: 'Type3',
    FontBBox: [0, -200, 1000, 800],
    FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
    CharProcs: charProcs,
    Encoding: { Type: 'Encoding', Differences: [1, ...glyphNames] },
    FirstChar: 1,
    LastChar: glyphNames.length,
    Widths: glyphNames.map(() => 1000),
    Resources: {},
    ToUnicode: toUnicode,
  }));
}

function displayPageGeometry(page) {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const x = Math.max(media.x, crop.x);
  const y = Math.max(media.y, crop.y);
  const width = Math.min(media.x + media.width, crop.x + crop.width) - x;
  const height = Math.min(media.y + media.height, crop.y + crop.height) - y;
  if (width <= 0 || height <= 0) throw new Error('PDF 页面没有有效的可见区域');
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  // Origin is the displayed bottom-left. The axes transform back to PDF page coordinates.
  switch (rotation) {
    case 90:
      return { width: height, height: width, origin: [x + width, y], right: [0, 1], up: [-1, 0] };
    case 180:
      return { width, height, origin: [x + width, y + height], right: [-1, 0], up: [0, -1] };
    case 270:
      return { width: height, height: width, origin: [x, y + height], right: [0, -1], up: [1, 0] };
    default:
      return { width, height, origin: [x, y], right: [1, 0], up: [0, 1] };
  }
}

function normalizeLines(rawLines) {
  const lines = [];
  for (const raw of rawLines) {
    const text = cleanOcrLineText(raw.text).replace(/[\x00-\x1f\x7f]/g, '');
    if (!text || !Array.isArray(raw.bounds) || raw.bounds.length !== 4 || !raw.bounds.every(Number.isFinite)) continue;
    const [left, top, right, bottom] = raw.bounds.map((value) => Math.min(Math.max(value, 0), 1));
    if (right > left && bottom > top) lines.push({ text: [...text], left, top, right, bottom });
  }
  return lines;
}

function addSearchText(page, lines, blankGlyph) {
  const context = page.doc.context;
  const groups = [];
  const encoding = new Map();
  for (const line of lines) {
    for (const character of line.text) {
      if (encoding.has(character)) continue;
      if (!groups.length || groups.at(-1).length === 255) groups.push([]);
      const group = groups.at(-1);
      group.push(character);
      encoding.set(character, { group: groups.length - 1, code: group.length });
    }
  }

  const resources = page.node.Resources()?.clone() || context.obj({});
  const fontName = PDFName.of('Font');
  const existingFonts = resources.lookupMaybe(fontName, PDFDict);
  resources.set(fontName, existingFonts?.clone() || context.obj({}));
  page.node.set(PDFName.of('Resources'), resources);
  const contents = page.node.Contents();
  if (contents instanceof PDFArray) page.node.set(PDFName.of('Contents'), contents.clone());
  const keys = groups.map((group) => page.node.newFontDictionary('VGTSearch', registerSearchFont(context, group, blankGlyph)));
  const { width, height, origin, right, up } = displayPageGeometry(page);

  const operators = [
    pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible),
    setCharacterSpacing(0), setWordSpacing(0), setCharacterSqueeze(100), setTextRise(0),
  ];
  for (const line of lines) {
    const lineHeight = (line.bottom - line.top) * height;
    const advance = ((line.right - line.left) * width) / line.text.length;
    const baseline = (1 - line.bottom) * height + 0.2 * lineHeight;
    const start = line.left * width;
    operators.push(setTextMatrix(
      right[0] * advance, right[1] * advance, up[0] * lineHeight, up[1] * lineHeight,
      origin[0] + right[0] * start + up[0] * baseline,
      origin[1] + right[1] * start + up[1] * baseline,
    ));
    const runs = [];
    for (const character of line.text) {
      const { group, code } = encoding.get(character);
      if (runs.at(-1)?.group !== group) runs.push({ group, codes: [] });
      runs.at(-1).codes.push(code);
    }
    for (const run of runs) {
      operators.push(setFontAndSize(keys[run.group], 1), showText(PDFHexString.of(Buffer.from(run.codes).toString('hex'))));
    }
  }
  page.pushOperators(...operators, endText(), popGraphicsState());
}

async function makePdfSearchable(inputPath, outputPath, { taskId, onProgress, ocrLang, pageRange } = {}) {
  throwIfTaskCancelled(taskId);
  const source = await fs.promises.stat(inputPath, { bigint: true });
  const target = await fs.promises.stat(outputPath, { bigint: true }).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (target && source.dev === target.dev && source.ino === target.ino) {
    throw new Error('请选择与原 PDF 不同的输出文件');
  }
  const { doc, rawBuffer } = await loadPdfSafe(inputPath);
  const pageCount = doc.getPageCount();
  const selected = parsePageRange(pageRange, pageCount);
  const missingText = [];
  for (const [index, pageNumber] of selected.entries()) {
    if (index % PAGES_PER_BATCH === 0) await yieldToTasks();
    throwIfTaskCancelled(taskId);
    if (!hasSearchablePageText(doc.getPage(pageNumber - 1))) missingText.push(pageNumber);
    onProgress?.(0.09 * (index + 1) / selected.length);
  }

  let ocrPages = 0;
  let blankGlyph;
  if (missingText.length) {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vgt_pdf_search_'));
    try {
      for (let offset = 0; offset < missingText.length; offset += PAGES_PER_BATCH) {
        const pages = missingText.slice(offset, offset + PAGES_PER_BATCH);
        const span = 0.85 * pages.length / missingText.length;
        const progress = (fraction) => onProgress?.(0.09 + 0.85 * offset / missingText.length + span * fraction);
        throwIfTaskCancelled(taskId);
        const pngs = await renderPdfPagesToPngs(inputPath, temp, {
          pages, scale: 2, taskId, onProgress: (value) => progress(0.45 * value),
        });
        if (pngs.length !== pages.length) throw new Error('部分 PDF 页面未能渲染，无法完成识别');
        const recognized = await runWinRtOcrOnImages(pngs, {
          ocrLang, taskId, includeBounds: true, onProgress: (value) => progress(0.45 + 0.5 * value),
        });
        if (recognized.length !== pages.length) throw new Error('识别结果与 PDF 页数不匹配');
        for (const [index, pageNumber] of pages.entries()) {
          throwIfTaskCancelled(taskId);
          const lines = normalizeLines(recognized[index]);
          if (lines.length) {
            blankGlyph ??= doc.context.register(doc.context.flateStream('1000 0 0 -200 1000 800 d1\n'));
            addSearchText(doc.getPage(pageNumber - 1), lines, blankGlyph);
            ocrPages++;
          }
          progress(0.95 + 0.05 * (index + 1) / pages.length);
        }
        for (const png of pngs) await fs.promises.unlink(png);
      }
    } finally {
      await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }

  throwIfTaskCancelled(taskId);
  const output = ocrPages ? await doc.save({ updateFieldAppearances: false }) : rawBuffer;
  throwIfTaskCancelled(taskId);
  writeTaskOutput(outputPath, output);
  onProgress?.(1);
  return {
    output: outputPath,
    pageCount,
    processedPages: selected.length,
    ocrPages,
    textPages: selected.length - missingText.length,
    blankPages: missingText.length - ocrPages,
  };
}

module.exports = { makePdfSearchable };
