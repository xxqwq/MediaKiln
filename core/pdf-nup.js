'use strict';

const fs = require('fs/promises');
const path = require('path');
const { PDFDocument, EncryptedPDFError, degrees, rgb } = require('pdf-lib');
const { parsePageRange } = require('./pdf-engine');
const { registerCancelableTask, throwIfTaskCancelled, writeTaskOutput } = require('./runner');

const A4_PORTRAIT = [595.28, 841.89];
const A4_LANDSCAPE = [841.89, 595.28];
const VALID_LAYOUTS = new Set([2, 4, 6, 9]);

function resolveNupGrid(layout, orientation = 'auto', isSourceLandscape = false) {
  const n = Number(layout);
  const perSheet = VALID_LAYOUTS.has(n) ? n : 4;
  const orient = ['auto', 'a4p', 'a4l'].includes(orientation) ? orientation : 'auto';

  let sheetOrient = orient;
  if (sheetOrient === 'auto') {
    if (perSheet === 2 || perSheet === 6) {
      sheetOrient = isSourceLandscape ? 'a4p' : 'a4l';
    } else {
      sheetOrient = isSourceLandscape ? 'a4l' : 'a4p';
    }
  }

  const isLandscape = sheetOrient === 'a4l';
  const [sheetW, sheetH] = isLandscape ? A4_LANDSCAPE : A4_PORTRAIT;
  let cols;
  let rows;
  if (perSheet === 2) {
    cols = isLandscape ? 2 : 1;
    rows = isLandscape ? 1 : 2;
  } else if (perSheet === 4) {
    cols = 2;
    rows = 2;
  } else if (perSheet === 6) {
    cols = isLandscape ? 3 : 2;
    rows = isLandscape ? 2 : 3;
  } else {
    cols = 3;
    rows = 3;
  }

  return { perSheet, cols, rows, sheetW, sheetH, sheetOrient };
}

function getVisibleBox(page) {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const interLeft = Math.max(media.x, crop.x);
  const interBottom = Math.max(media.y, crop.y);
  const interRight = Math.min(media.x + media.width, crop.x + crop.width);
  const interTop = Math.min(media.y + media.height, crop.y + crop.height);

  const validInter = interRight > interLeft && interTop > interBottom;
  const left = validInter ? interLeft : media.x;
  const bottom = validInter ? interBottom : media.y;
  const right = validInter ? interRight : (media.x + media.width);
  const top = validInter ? interTop : (media.y + media.height);
  const boxW = Math.max(1, right - left);
  const boxH = Math.max(1, top - bottom);

  const rawRot = ((page.getRotation().angle % 360) + 360) % 360;
  const rotation = [0, 90, 180, 270].includes(rawRot) ? rawRot : 0;
  const sideways = rotation === 90 || rotation === 270;

  return {
    left,
    bottom,
    right,
    top,
    boxW,
    boxH,
    rotation,
    visualW: sideways ? boxH : boxW,
    visualH: sideways ? boxW : boxH,
  };
}

function parseMargin(value) {
  if (value === undefined || value === null || value === '') return 24;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('拼版边距必须为非负数');
  }
  return Math.min(n, 80);
}

async function nupPdfPages(inputPath, outputPath, opts = {}) {
  const input = await fs.realpath(inputPath);
  const output = await fs.realpath(outputPath).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
    return path.resolve(outputPath);
  });
  const pathKey = (file) => (process.platform === 'win32' ? file.toLowerCase() : file);
  if (pathKey(input) === pathKey(output)) {
    throw new Error('请选择与原文件不同的输出位置');
  }

  const margin = parseMargin(opts.margin);
  const gap = Math.max(0, Math.round(margin * 0.5));
  const border = opts.border === 'yes' || opts.border === true;
  const order = opts.order === 'col' ? 'col' : 'row';
  const taskId = opts.taskId;
  const onProgress = opts.onProgress || null;

  const release = registerCancelableTask(taskId, () => {});
  try {
    throwIfTaskCancelled(taskId);
    onProgress?.(0.05);

    const sourceBytes = await fs.readFile(input);
    let srcDoc;
    try {
      srcDoc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
      if (srcDoc.isEncrypted) {
        throw new Error('该 PDF 文件受密码或权限加密保护，暂无法直接处理');
      }
    } catch (err) {
      if (err instanceof EncryptedPDFError || /encrypted/i.test(err?.message || '')) {
        throw new Error('该 PDF 文件受密码或权限加密保护，暂无法直接处理', { cause: err });
      }
      throw err;
    }

    const totalPages = srcDoc.getPageCount();
    if (!totalPages) {
      throw new Error('PDF 文档不包含任何页面');
    }

    const selected = parsePageRange(opts.pageRange, totalPages);
    const firstBox = getVisibleBox(srcDoc.getPage(selected[0] - 1));
    const isSourceLandscape = firstBox.visualW > firstBox.visualH;
    const grid = resolveNupGrid(opts.layout, opts.orientation, isSourceLandscape);

    const outDoc = await PDFDocument.create();
    const sheetCount = Math.ceil(selected.length / grid.perSheet);
    const cellW = (grid.sheetW - margin * 2 - gap * (grid.cols - 1)) / grid.cols;
    const cellH = (grid.sheetH - margin * 2 - gap * (grid.rows - 1)) / grid.rows;
    if (cellW <= 10 || cellH <= 10) {
      throw new Error('拼版边距过大，请调小边距后重试');
    }

    onProgress?.(0.1);
    for (let sheetIdx = 0; sheetIdx < sheetCount; sheetIdx++) {
      throwIfTaskCancelled(taskId);
      const outPage = outDoc.addPage([grid.sheetW, grid.sheetH]);
      const chunk = selected.slice(sheetIdx * grid.perSheet, (sheetIdx + 1) * grid.perSheet);

      for (let k = 0; k < chunk.length; k++) {
        throwIfTaskCancelled(taskId);
        const col = order === 'col' ? Math.floor(k / grid.rows) : (k % grid.cols);
        const row = order === 'col' ? (k % grid.rows) : Math.floor(k / grid.cols);
        const cellX = margin + col * (cellW + gap);
        const cellY = grid.sheetH - margin - (row + 1) * cellH - row * gap;

        const srcPage = srcDoc.getPage(chunk[k] - 1);
        const geom = getVisibleBox(srcPage);
        const scale = Math.min(cellW / geom.visualW, cellH / geom.visualH);
        const drawW = geom.visualW * scale;
        const drawH = geom.visualH * scale;
        const bx = cellX + (cellW - drawW) / 2;
        const by = cellY + (cellH - drawH) / 2;

        if (srcPage.node.Contents()) {
          const emb = await outDoc.embedPage(srcPage, {
            left: geom.left,
            bottom: geom.bottom,
            right: geom.right,
            top: geom.top,
          });

          let drawOpts;
          if (geom.rotation === 90) {
            drawOpts = { x: bx, y: by + drawH, xScale: scale, yScale: scale, rotate: degrees(-90) };
          } else if (geom.rotation === 180) {
            drawOpts = { x: bx + drawW, y: by + drawH, xScale: scale, yScale: scale, rotate: degrees(180) };
          } else if (geom.rotation === 270) {
            drawOpts = { x: bx + drawW, y: by, xScale: scale, yScale: scale, rotate: degrees(90) };
          } else {
            drawOpts = { x: bx, y: by, xScale: scale, yScale: scale, rotate: degrees(0) };
          }
          outPage.drawPage(emb, drawOpts);
        }

        if (border) {
          outPage.drawRectangle({
            x: bx,
            y: by,
            width: drawW,
            height: drawH,
            borderColor: rgb(0.75, 0.78, 0.82),
            borderWidth: 0.6,
          });
        }
      }

      onProgress?.(0.1 + 0.8 * ((sheetIdx + 1) / sheetCount));
    }

    throwIfTaskCancelled(taskId);
    const outBuf = await outDoc.save({ useObjectStreams: false });
    throwIfTaskCancelled(taskId);
    writeTaskOutput(outputPath, outBuf);
    onProgress?.(1);

    return {
      output: outputPath,
      totalPages,
      selectedPages: selected.length,
      outputPages: sheetCount,
      perSheet: grid.perSheet,
      cols: grid.cols,
      rows: grid.rows,
      sheetWidth: grid.sheetW,
      sheetHeight: grid.sheetH,
      outputSize: outBuf.length,
    };
  } finally {
    release();
  }
}

module.exports = {
  nupPdfPages,
  resolveNupGrid,
};
