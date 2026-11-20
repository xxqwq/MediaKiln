(() => {
'use strict';

const PAGE_BATCH = 20;
const THUMBNAIL_LIMIT = 120;
let previewSerial = 0;

function createPreviewRequest() {
  let activeId;
  return {
    async run(input, options) {
      const id = `pdf-preview-${Date.now()}-${++previewSerial}`;
      activeId = id;
      try {
        const result = await window.api.startTask('pdfPreview', { input, ...options, __batchItem: true, __clientTaskId: id });
        if (!result.ok) throw new Error(result.error || 'PDF 预览已取消');
        return result.pdfPreviewSummary;
      } finally {
        if (activeId === id) activeId = undefined;
      }
    },
    cancel() {
      if (activeId) window.api.cancelTask(activeId).catch(() => {});
      activeId = undefined;
    },
  };
}

function createOrganizer(container, exportButton, isRunning) {
  const request = createPreviewRequest();
  const thumbnails = new Map();
  const loadedFiles = new Set();
  let files = [];
  let pages = [];
  let removed = [];
  let selected;
  let dragging;
  let block = 0;
  let revision = 0;
  let loading = false;
  let error = '';
  let thumbnailWork;
  let grid;
  let thumbSize = ['sm', 'md', 'lg'].includes(localStorage.getItem('vgt_pdf_thumb_size'))
    ? localStorage.getItem('vgt_pdf_thumb_size')
    : 'md';

  function dispose() {
    revision++;
    request.cancel();
    thumbnails.clear();
    loadedFiles.clear();
    files = [];
    pages = [];
    removed = [];
    selected = undefined;
    dragging = undefined;
    block = 0;
    error = '';
    loading = false;
    thumbnailWork = undefined;
    grid = undefined;
  }

  function visiblePages() {
    return pages.slice(block * PAGE_BATCH, (block + 1) * PAGE_BATCH);
  }

  function updateThumbnails() {
    for (const tile of grid?.querySelectorAll('.pdf-page-card') || []) {
      const image = thumbnails.get(tile.dataset.pageId);
      const img = tile.querySelector('img');
      const placeholder = tile.querySelector('.pdf-thumb-placeholder');
      if (image) {
        img.src = image;
        img.hidden = false;
        placeholder.hidden = true;
      } else if (image === null) {
        placeholder.textContent = '预览不可用';
      }
    }
  }

  function loadThumbnails() {
    if (thumbnailWork || loading || error || isRunning()) return;
    const first = visiblePages().find((item) => !thumbnails.has(item.id));
    if (!first) return;
    const pending = visiblePages().filter((item) => item.fileIndex === first.fileIndex && !thumbnails.has(item.id)).slice(0, 6);
    const version = revision;
    const work = async () => {
      let images;
      try {
        const result = await request.run(files[first.fileIndex], { pages: pending.map(({ page }) => page) });
        images = result.images;
      } catch {}
      if (version !== revision) return;
      pending.forEach((item, index) => thumbnails.set(item.id, images?.[index] || null));
      const visibleIds = new Set(visiblePages().map(({ id }) => id));
      for (const id of thumbnails.keys()) {
        if (thumbnails.size <= THUMBNAIL_LIMIT) break;
        if (!visibleIds.has(id)) thumbnails.delete(id);
      }
      updateThumbnails();
    };
    thumbnailWork = work().finally(() => {
      if (version !== revision) return;
      thumbnailWork = undefined;
      loadThumbnails();
    });
  }

  function select(item, follow = false) {
    selected = item;
    if (follow) block = Math.floor(pages.indexOf(item) / PAGE_BATCH);
    render();
  }

  function move(item, to) {
    const from = pages.indexOf(item);
    if (isRunning() || from < 0 || to < 0 || to >= pages.length || from === to) return;
    pages.splice(from, 1);
    pages.splice(to, 0, item);
    select(item, true);
  }

  function rotate(delta) {
    selected.rotation = (selected.rotation + delta + 360) % 360;
    render();
  }

  function remove(index) {
    removed.push({ item: selected, index });
    pages.splice(index, 1);
    select(pages[Math.min(index, pages.length - 1)], true);
  }

  function restore() {
    const { item, index } = removed.pop();
    pages.splice(index, 0, item);
    select(item, true);
  }

  function render() {
    const focused = container.contains(document.activeElement) ? document.activeElement : null;
    const panel = document.createElement('section');
    panel.className = 'pdf-organizer';
    panel.innerHTML = `<div class="pdf-organizer-head">
      <div class="pdf-organizer-title"><strong>页面顺序</strong><span class="muted" role="status"></span></div>
      <div class="pdf-page-tools" role="group" aria-label="所选页面操作"></div>
    </div><div class="pdf-page-grid" role="list" aria-label="PDF 页面"></div><div class="pdf-page-nav"></div>`;
    container.replaceChildren(panel);
    grid = panel.querySelector('.pdf-page-grid');
    grid.dataset.size = thumbSize;
    const status = panel.querySelector('[role="status"]');
    const disabled = loading || !!error || isRunning();
    exportButton.disabled = disabled || !pages.length;
    status.textContent = loading ? '正在读取 PDF…' : (error || `${pages.length} 页待导出`);
    if (loading || error) return;

    function control(parent, key, label, inactive, action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-ghost btn-sm';
      button.dataset.control = key;
      button.textContent = label;
      button.disabled = disabled || inactive;
      button.onclick = action;
      parent.append(button);
    }

    const index = pages.indexOf(selected);
    const tools = panel.querySelector('.pdf-page-tools');
    control(tools, 'earlier', '前移', index <= 0, () => move(selected, index - 1));
    control(tools, 'later', '后移', index < 0 || index >= pages.length - 1, () => move(selected, index + 1));
    control(tools, 'rotate-left', '左转', index < 0, () => rotate(-90));
    control(tools, 'rotate-right', '右转', index < 0, () => rotate(90));
    control(tools, 'remove', '移除', index < 0 || pages.length <= 1, () => remove(index));
    control(tools, 'restore', '恢复移除', !removed.length, restore);

    const sizeGroup = document.createElement('span');
    sizeGroup.className = 'pdf-size-group';
    sizeGroup.setAttribute('role', 'group');
    sizeGroup.setAttribute('aria-label', '缩略图大小');
    for (const [sz, lbl] of [['sm', '小'], ['md', '中'], ['lg', '大']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `batch-btn pdf-size-btn${thumbSize === sz ? ' on' : ''}`;
      b.dataset.pdfSize = sz;
      b.textContent = lbl;
      b.title = `缩略图尺寸：${lbl}`;
      b.onclick = () => {
        thumbSize = sz;
        grid.dataset.size = sz;
        try { localStorage.setItem('vgt_pdf_thumb_size', sz); } catch {}
        sizeGroup.querySelectorAll('.pdf-size-btn').forEach((btn) => btn.classList.toggle('on', btn === b));
      };
      sizeGroup.append(b);
    }
    tools.append(sizeGroup);

    visiblePages().forEach((item, offset) => {
      const card = document.createElement('button');
      const name = files[item.fileIndex].split(/[\\/]/).pop();
      const position = block * PAGE_BATCH + offset + 1;
      card.type = 'button';
      card.className = 'pdf-page-card';
      card.dataset.pageId = item.id;
      card.draggable = !disabled;
      card.disabled = disabled;
      card.title = `原第 ${item.page} 页 · ${name}`;
      card.setAttribute('aria-pressed', String(selected === item));
      card.setAttribute('aria-label', `输出第 ${position} 页，${card.title}${item.rotation ? `，已旋转 ${item.rotation}°` : ''}`);
      card.innerHTML = `<span class="pdf-page-thumb"><img alt="" hidden draggable="false"><span class="pdf-thumb-placeholder">第 ${item.page} 页</span></span>
        <span class="pdf-page-caption"><span class="pdf-page-position">${position}</span><span class="pdf-page-origin"></span></span>`;
      card.querySelector('img').style.transform = `rotate(${item.rotation}deg)`;
      card.querySelector('.pdf-page-origin').textContent = card.title;
      card.onclick = () => select(item);
      card.ondragstart = (event) => {
        dragging = item;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', item.id);
      };
      card.ondragend = () => { dragging = undefined; };
      card.ondragover = (event) => {
        if (!dragging) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        card.classList.toggle('drop-target', dragging !== item);
      };
      card.ondragleave = () => card.classList.remove('drop-target');
      card.ondrop = (event) => {
        if (!dragging) return;
        event.preventDefault();
        event.stopPropagation();
        card.classList.remove('drop-target');
        move(dragging, position - 1);
        dragging = undefined;
      };
      const wrapper = document.createElement('div');
      wrapper.setAttribute('role', 'listitem');
      wrapper.append(card);
      grid.append(wrapper);
    });

    if (pages.length > PAGE_BATCH) {
      const nav = panel.querySelector('.pdf-page-nav');
      control(nav, 'prev', '上一组', block === 0, () => { block--; render(); });
      const range = document.createElement('span');
      range.textContent = `${block * PAGE_BATCH + 1}–${Math.min((block + 1) * PAGE_BATCH, pages.length)} / ${pages.length}`;
      nav.append(range);
      control(nav, 'next', '下一组', (block + 1) * PAGE_BATCH >= pages.length, () => { block++; render(); });
    }
    if (focused) {
      const matching = focused.dataset.control && panel.querySelector(`[data-control="${focused.dataset.control}"]`);
      const selectedCard = selected && grid.querySelector(`[data-page-id="${selected.id}"]`);
      (matching && !matching.disabled ? matching : selectedCard)?.focus({ preventScroll: true });
    }
    updateThumbnails();
    loadThumbnails();
  }

  async function load(sources, append) {
    if (!append) dispose();
    const version = ++revision;
    request.cancel();
    thumbnailWork = undefined;
    files = [...sources];
    loading = true;
    error = '';
    render();
    try {
      for (const [fileIndex, input] of files.entries()) {
        if (loadedFiles.has(input)) continue;
        const { pageCount } = await request.run(input, { mode: 'count' });
        if (version !== revision) return;
        for (let page = 1; page <= pageCount; page++) {
          pages.push({ id: `${fileIndex}-${page}`, fileIndex, page, rotation: 0 });
        }
        loadedFiles.add(input);
      }
      selected ??= pages[0];
    } catch (err) {
      if (version === revision) error = err.message;
    } finally {
      if (version === revision) {
        loading = false;
        render();
      }
    }
  }

  return {
    load, dispose, render,
    getPlan() {
      if (loading || error) throw new Error(error || '请等待读取 PDF');
      return pages.map(({ fileIndex, page, rotation }) => ({ fileIndex, page, rotation }));
    },
  };
}

function mountCropPreview(container, file) {
  if (!file) return;
  container.innerHTML = `<div class="pdf-crop-controls">
    <label>预览页码 <input type="number" min="1" step="1" value="1" aria-label="裁剪预览页码"></label>
    <button type="button" class="btn btn-ghost btn-sm">预览裁剪</button><span class="muted" role="status"></span>
  </div><div class="pdf-crop-preview" hidden><img alt="裁剪前的 PDF 页面"><span class="pdf-crop-outline" hidden></span></div>`;
  const request = createPreviewRequest();
  const pageInput = container.querySelector('input');
  if (file.info?.pageCount) pageInput.max = file.info.pageCount;
  const button = container.querySelector('button');
  const status = container.querySelector('[role="status"]');
  const preview = container.querySelector('.pdf-crop-preview');
  const outline = preview.querySelector('.pdf-crop-outline');
  const params = document.getElementById('params');
  let revision = 0;
  const invalidate = () => {
    revision++;
    request.cancel();
    preview.hidden = true;
    button.disabled = false;
    status.textContent = '';
  };
  pageInput.oninput = invalidate;
  params.querySelector('[data-key="padding"]')?.addEventListener('input', invalidate);
  params.querySelector('[data-key="padding"]')?.closest('.field')?.querySelector('.chip-row')?.addEventListener('click', invalidate);
  button.onclick = async () => {
    const page = Number(pageInput.value);
    const rawPadding = params.querySelector('[data-key="padding"]')?.value ?? '12';
    const padding = Number(rawPadding);
    if (!Number.isSafeInteger(page) || page < 1 || (pageInput.max && page > Number(pageInput.max))) {
      status.textContent = '请输入有效页码';
      return;
    }
    if (!rawPadding || !Number.isFinite(padding) || padding < 0 || padding > 144) {
      status.textContent = '请输入 0–144 pt 的保留边距';
      return;
    }
    invalidate();
    const version = revision;
    button.disabled = true;
    status.textContent = '正在检测白边…';
    try {
      const { image, bounds } = await request.run(file.path, { mode: 'crop', page, padding });
      if (version !== revision || !container.isConnected) return;
      preview.querySelector('img').src = image;
      outline.hidden = !bounds;
      if (bounds) {
        const { left, top, right, bottom } = bounds;
        outline.style.inset = `${top * 100}% ${(1 - right) * 100}% ${(1 - bottom) * 100}% ${left * 100}%`;
      }
      status.textContent = bounds ? '框内为保留区域' : '该页无可裁白边';
      preview.hidden = false;
    } catch (err) {
      if (version === revision) status.textContent = err.message;
    } finally {
      if (version === revision) button.disabled = false;
    }
  };
}

window.VGT.pdfTools = { createOrganizer, mountCropPreview };
})();
