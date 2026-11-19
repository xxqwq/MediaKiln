'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { PDFDocument, PDFName, PDFNumber } = require('pdf-lib');
const { parsePageRange, renderPdfPagesToPngs } = require('./pdf-engine');
const { runFfmpegBinary, registerCancelableTask, throwIfTaskCancelled, writeTaskOutput } = require('./runner');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DEFAULT_PADDING = 12;
const BATCH_SIZE = 8;
const MAX_ANALYSIS_SIDE = 1024;

function pageGeometry(page) {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const left = Math.max(media.x, crop.x);
  const bottom = Math.max(media.y, crop.y);
  const right = Math.min(media.x + media.width, crop.x + crop.width);
  const top = Math.min(media.y + media.height, crop.y + crop.height);
  const width = right - left;
  const height = top - bottom;
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  if (width <= 0 || height <= 0 || rotation % 90) return null;
  const unit = page.node.lookupMaybe(PDFName.of('UserUnit'), PDFNumber)?.asNumber();
  const sideways = rotation === 90 || rotation === 270;
  return {
    left, bottom, width, height, rotation,
    unit: unit > 0 ? unit : 1,
    visualWidth: sideways ? height : width,
    visualHeight: sideways ? width : height,
  };
}

function findInkBounds(pixels, width, height) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0, offset = 0; y < height; y++) {
    for (let x = 0; x < width; x++, offset += 4) {
      const darkestChannel = Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      if ((255 - darkestChannel) * pixels[offset + 3] < 6 * 255) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  return right < 0 ? null : { left, top, right, bottom };
}

async function analyzePage(imagePath, image, geometry, padding, taskId) {
  if (!geometry) return null;
  if (image.length < 24 || !image.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('无法读取 PDF 页面预览');
  }
  const imageWidth = image.readUInt32BE(16);
  const imageHeight = image.readUInt32BE(20);
  if (!imageWidth || !imageHeight) throw new Error('PDF 页面预览尺寸无效');

  // 渲染区域与页面裁剪框不一致时，无法安全换算坐标。
  const expectedHeight = imageWidth * geometry.visualHeight / geometry.visualWidth;
  if (Math.abs(imageHeight - expectedHeight) > Math.max(2, imageHeight * 0.01)) return null;
  const scale = Math.min(1, MAX_ANALYSIS_SIDE / Math.max(imageWidth, imageHeight));
  const width = Math.max(1, Math.round(imageWidth * scale));
  const height = Math.max(1, Math.round(imageHeight * scale));
  const pixels = await runFfmpegBinary(taskId, [
    '-loglevel', 'error', '-i', imagePath,
    '-vf', `scale=${width}:${height}:flags=area`, '-frames:v', '1',
    '-pix_fmt', 'rgba', '-c:v', 'rawvideo', '-threads', '1', '-f', 'rawvideo', 'pipe:1',
  ]);
  if (pixels.length !== width * height * 4) throw new Error('无法分析 PDF 页面像素');
  const ink = findInkBounds(pixels, width, height);
  if (!ink) return null;

  const padX = padding / (geometry.visualWidth * geometry.unit);
  const padY = padding / (geometry.visualHeight * geometry.unit);
  // 多保留一个分析像素，避免切到抗锯齿边缘。
  const bounds = {
    left: Math.max(0, (ink.left - 1) / width - padX),
    top: Math.max(0, (ink.top - 1) / height - padY),
    right: Math.min(1, (ink.right + 2) / width + padX),
    bottom: Math.min(1, (ink.bottom + 2) / height + padY),
  };
  return bounds.left || bounds.top || bounds.right < 1 || bounds.bottom < 1 ? bounds : null;
}

function setCropBox(page, geometry, bounds) {
  const { left, top, right, bottom } = bounds;
  let x0, y0, x1, y1;
  switch (geometry.rotation) {
    case 90: [x0, y0, x1, y1] = [top, left, bottom, right]; break;
    case 180: [x0, y0, x1, y1] = [1 - right, top, 1 - left, bottom]; break;
    case 270: [x0, y0, x1, y1] = [1 - bottom, 1 - right, 1 - top, 1 - left]; break;
    default: [x0, y0, x1, y1] = [left, 1 - bottom, right, 1 - top];
  }
  page.setCropBox(
    geometry.left + x0 * geometry.width,
    geometry.bottom + y0 * geometry.height,
    (x1 - x0) * geometry.width,
    (y1 - y0) * geometry.height,
  );
}

function parsePadding(value) {
  const padding = Number(value ?? DEFAULT_PADDING);
  if (!Number.isFinite(padding) || padding < 0) throw new Error('保留边距必须为非负数');
  return padding;
}

async function withCropSource(inputPath, taskId, run) {
  const release = registerCancelableTask(taskId, () => {});
  let temp;
  try {
    throwIfTaskCancelled(taskId);
    const source = await fs.readFile(inputPath);
    const doc = await PDFDocument.load(source, { updateMetadata: false, throwOnInvalidObject: true });
    if (!doc.getPageCount()) throw new Error('PDF 文档不包含任何页面');
    throwIfTaskCancelled(taskId);
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vgt_pdf_crop_'));
    // 每个渲染批次基于同一份快照，避免原文件在处理时被替换。
    const snapshot = path.join(temp, 'source.pdf');
    await fs.writeFile(snapshot, source);
    return await run({ doc, source, snapshot, temp });
  } finally {
    release();
    if (temp) await fs.rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
}

async function cropPdfMargins(inputPath, outputPath, { taskId, onProgress, pageRange, padding } = {}) {
  const keepPadding = parsePadding(padding);
  const input = await fs.realpath(inputPath);
  const output = await fs.realpath(outputPath).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
    return path.resolve(outputPath);
  });
  const pathKey = (file) => process.platform === 'win32' ? file.toLowerCase() : file;
  if (pathKey(input) === pathKey(output)) throw new Error('请选择与原文件不同的输出位置');

  return withCropSource(input, taskId, async ({ doc, source, snapshot, temp }) => {
    const pageCount = doc.getPageCount();
    const selected = parsePageRange(pageRange, pageCount);
    let croppedPages = 0;
    onProgress?.(0.05);
    for (let offset = 0; offset < selected.length; offset += BATCH_SIZE) {
      const batch = selected.slice(offset, offset + BATCH_SIZE);
      const images = await renderPdfPagesToPngs(snapshot, temp, { pages: batch, scale: 1, taskId });
      if (images.length !== batch.length) throw new Error('PDF 页面预览不完整，未应用裁剪');
      for (const [index, file] of images.entries()) {
        throwIfTaskCancelled(taskId);
        const page = doc.getPage(batch[index] - 1);
        const geometry = pageGeometry(page);
        const bounds = await analyzePage(file, await fs.readFile(file), geometry, keepPadding, taskId);
        if (bounds) {
          setCropBox(page, geometry, bounds);
          croppedPages++;
        }
        await fs.unlink(file);
        onProgress?.(0.05 + 0.9 * (offset + index + 1) / selected.length);
      }
    }
    throwIfTaskCancelled(taskId);
    const bytes = croppedPages ? await doc.save({ updateFieldAppearances: false }) : source;
    throwIfTaskCancelled(taskId);
    writeTaskOutput(outputPath, bytes);
    onProgress?.(1);
    return { output: outputPath, pageCount, processedPages: selected.length, croppedPages };
  });
}

async function previewPdfCrop(inputPath, { taskId, page = 1, padding } = {}) {
  const pageNumber = Number(page);
  const keepPadding = parsePadding(padding);
  return withCropSource(inputPath, taskId, async ({ doc, snapshot, temp }) => {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > doc.getPageCount()) {
      throw new Error(`请选择 1 至 ${doc.getPageCount()} 之间的页码`);
    }
    const [file] = await renderPdfPagesToPngs(snapshot, temp, { pages: [pageNumber], scale: 1, taskId });
    const image = await fs.readFile(file);
    const bounds = await analyzePage(file, image, pageGeometry(doc.getPage(pageNumber - 1)), keepPadding, taskId);
    throwIfTaskCancelled(taskId);
    return { image, bounds };
  });
}

module.exports = { cropPdfMargins, previewPdfCrop };
