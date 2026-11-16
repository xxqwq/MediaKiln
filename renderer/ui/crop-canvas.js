'use strict';

window.VGT = window.VGT || {};

window.VGT.initCropCanvas = async function initCropCanvas(ctxApi) {
  const { $, getFile, getCurrentFeature } = ctxApi;
  const file = getFile();
  if (!file) return;

  const canvas = $('crop-canvas');
  const status = $('crop-status');
  const scrub = $('crop-frame-time');
  const scrubLabel = $('crop-frame-label');
  const fromVidBtn = $('crop-from-vid');
  const ratioRow = $('crop-ratios');
  const ctx = canvas.getContext('2d');
  const round1 = (n) => Math.round(n * 10) / 10;

  let currentImg = null;
  let rect = null;
  let dragging = null;
  let lockRatio = 0;

  const redraw = () => {
    if (!currentImg) return;
    ctx.drawImage(currentImg, 0, 0, canvas.width, canvas.height);
    if (rect) {
      const [x, y, w, h] = [rect.x * canvas.width, rect.y * canvas.height, rect.w * canvas.width, rect.h * canvas.height];
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(0, 0, canvas.width, y);
      ctx.fillRect(0, y + h, canvas.width, canvas.height - y - h);
      ctx.fillRect(0, y, x, h);
      ctx.fillRect(x + w, y, canvas.width - x - w, h);
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
    }
  };

  const loadFrame = async (tSec) => {
    status.textContent = '正在加载参考画面…';
    const dataUrl = await window.api.firstFrame(file.path, file.info?.isImage ? 0 : tSec);
    if (!dataUrl) {
      status.textContent = '无法加载画面预览，请换一个文件';
      return;
    }
    const img = new Image();
    img.onload = () => {
      currentImg = img;
      const scale = Math.min(1, 520 / img.width);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      redraw();
      status.textContent = window.__crop
        ? `已选 ${Math.round(window.__crop.w * file.info.width)} × ${Math.round(window.__crop.h * file.info.height)} 像素`
        : (file.info?.isImage
          ? '拖动鼠标框出区域'
          : '拖动鼠标框出区域（如首帧黑屏可拖动上方参考帧条）');
    };
    img.src = dataUrl;
  };

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };

  canvas.onmousedown = (e) => {
    if (!currentImg) return;
    const [nx, ny] = pos(e);
    dragging = { x0: nx, y0: ny };
    e.preventDefault();
  };
  canvas.onmousemove = (e) => {
    if (!dragging || !currentImg) return;
    const [nx, ny] = pos(e);
    let dx = nx - dragging.x0;
    let dy = ny - dragging.y0;
    if (lockRatio > 0 && file.info.width && file.info.height) {
      const normRatio = lockRatio * (file.info.height / file.info.width);
      const sx = dx >= 0 ? 1 : -1;
      const sy = dy >= 0 ? 1 : -1;
      let aw = Math.abs(dx);
      let ah = aw / normRatio;
      const maxW = sx > 0 ? 1 - dragging.x0 : dragging.x0;
      const maxH = sy > 0 ? 1 - dragging.y0 : dragging.y0;
      if (ah > maxH) { ah = maxH; aw = ah * normRatio; }
      if (aw > maxW) { aw = maxW; ah = aw / normRatio; }
      dx = sx * aw;
      dy = sy * ah;
    }
    const ex = dragging.x0 + dx;
    const ey = dragging.y0 + dy;
    rect = {
      x: Math.min(dragging.x0, ex), y: Math.min(dragging.y0, ey),
      w: Math.abs(dx), h: Math.abs(dy),
    };
    const pw = Math.round(rect.w * file.info.width);
    const ph = Math.round(rect.h * file.info.height);
    status.textContent = `框选中：${pw} × ${ph} 像素`;
    redraw();
  };
  canvas.onmouseup = () => {
    if (dragging && rect && rect.w > 0.02 && rect.h > 0.02) {
      window.__crop = rect;
      const pw = Math.round(rect.w * file.info.width);
      const ph = Math.round(rect.h * file.info.height);
      const px = Math.round(rect.x * file.info.width);
      const py = Math.round(rect.y * file.info.height);
      status.textContent = `已选 ${pw} × ${ph} 像素 · 起点 (${px}, ${py})（原图 ${file.info.width}×${file.info.height}）`;
    } else {
      window.__crop = null;
      status.textContent = '选区太小，请重新拖动';
    }
    dragging = null;
  };

  $('crop-reset').onclick = () => {
    rect = null;
    window.__crop = null;
    status.textContent = '尚未选择区域';
    redraw();
  };

  if (ratioRow && getCurrentFeature()?.id === 'videoCrop') {
    ratioRow.querySelectorAll('.chip').forEach((chip) => {
      chip.onclick = () => {
        ratioRow.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
        chip.classList.add('on');
        lockRatio = parseFloat(chip.dataset.ratio) || 0;
      };
    });
  }

  let scrubTimer = null;
  if (scrub) {
    scrub.oninput = () => {
      if (scrubLabel) scrubLabel.textContent = `${scrub.value}s`;
      clearTimeout(scrubTimer);
      scrubTimer = setTimeout(() => loadFrame(parseFloat(scrub.value)), 160);
    };
  }
  if (fromVidBtn) {
    fromVidBtn.onclick = () => {
      const v = document.querySelector('#preview-box video');
      const t = v ? round1(v.currentTime || 0) : 0;
      if (scrub) scrub.value = t;
      if (scrubLabel) scrubLabel.textContent = `${t}s`;
      loadFrame(t);
    };
  }

  const initT = scrub ? parseFloat(scrub.value) : 0.1;
  await loadFrame(initT);
};
