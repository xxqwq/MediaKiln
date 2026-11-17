// 图片 / 视频放大查看与对比弹窗（支持滚轮缩放、拖拽平移、并排同步对比、卷帘对比）
(() => {
  window.VGT = window.VGT || {};

  const IMG_LIKE = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif', 'gif', 'ico', 'svg']);

  function toFileUrl(filePath) {
    return encodeURI('file:///' + String(filePath || '').replace(/\\/g, '/'));
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function extOf(p) {
    return String(p || '').split('.').pop().toLowerCase();
  }

  function fmtDim(img) {
    return img && img.naturalWidth ? `${img.naturalWidth}×${img.naturalHeight}` : '';
  }

  let modal = null;
  let state = null;

  function ensureModal() {
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'vgt-lightbox';
    modal.className = 'lb-overlay hidden';
    modal.innerHTML = `
      <div class="lb-dialog" role="dialog" aria-modal="true">
        <div class="lb-toolbar">
          <div class="lb-title" id="lb-title"></div>
          <div class="lb-controls" id="lb-controls"></div>
          <button class="lb-close" id="lb-close" title="关闭 (Esc)">✕</button>
        </div>
        <div class="lb-body" id="lb-body"></div>
        <div class="lb-footer" id="lb-footer"></div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('#lb-close').onclick = close;
    modal.addEventListener('click', (e) => {
      if (e.target === modal) close();
    });
    document.addEventListener('keydown', onKeyDown);
    return modal;
  }

  function onKeyDown(e) {
    if (!state || !modal || modal.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === '+' || e.key === '=') {
      if (state.isImageLike) {
        e.preventDefault();
        setZoom(state.zoom * 1.25);
      }
    } else if (e.key === '-' || e.key === '_') {
      if (state.isImageLike) {
        e.preventDefault();
        setZoom(state.zoom / 1.25);
      }
    } else if (e.key === '0') {
      if (state.isImageLike) {
        e.preventDefault();
        resetTransform();
      }
    } else if (e.key === 'ArrowLeft' && state.list?.length > 1) {
      e.preventDefault();
      stepList(-1);
    } else if (e.key === 'ArrowRight' && state.list?.length > 1) {
      e.preventDefault();
      stepList(1);
    }
  }

  function close() {
    if (!modal) return;
    modal.querySelectorAll('video').forEach((v) => {
      try { v.pause(); } catch {}
    });
    modal.classList.add('hidden');
    state = null;
  }

  function clampZoom(z) {
    return Math.max(0.25, Math.min(12, z));
  }

  function setZoom(nextZoom, resetPanIfFit = true) {
    if (!state) return;
    state.zoom = clampZoom(nextZoom);
    if (resetPanIfFit && state.zoom <= 1.01 && Math.abs(state.zoom - 1) < 0.05) {
      state.zoom = 1;
      state.panX = 0;
      state.panY = 0;
    }
    applyTransform();
    updateZoomBadge();
  }

  function resetTransform() {
    if (!state) return;
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    applyTransform();
    updateZoomBadge();
  }

  function applyTransform() {
    if (!modal || !state) return;
    const t = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    modal.querySelectorAll('.lb-zoom-target').forEach((el) => {
      el.style.transform = t;
    });
    modal.querySelectorAll('.lb-pan-stage').forEach((el) => {
      el.style.cursor = state.zoom > 1 ? 'grab' : (state.mode === 'slider' ? 'ew-resize' : 'zoom-in');
    });
  }

  function updateZoomBadge() {
    const badge = modal?.querySelector('#lb-zoom-readout');
    if (badge && state) badge.textContent = `${Math.round(state.zoom * 100)}%`;
  }

  function stepList(delta) {
    if (!state?.list?.length) return;
    state.index = (state.index + delta + state.list.length) % state.list.length;
    const item = state.list[state.index];
    state.srcPath = item.path;
    state.srcLabel = item.label || item.path.split(/[\\/]/).pop();
    state.srcMeta = item.meta || '';
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    renderContent();
  }

  function renderToolbar() {
    const titleEl = modal.querySelector('#lb-title');
    const ctrlEl = modal.querySelector('#lb-controls');

    if (state.kind === 'compare') {
      titleEl.textContent = state.mode === 'slider' ? '卷帘对比（原文件 vs 输出结果）' : '并排放大对比（原文件 vs 输出结果）';
    } else {
      const idxText = state.list?.length > 1 ? ` (${state.index + 1}/${state.list.length})` : '';
      titleEl.textContent = `${state.srcLabel || '放大预览'}${idxText}`;
    }

    const parts = [];
    if (state.kind === 'compare' && state.isImageLike) {
      parts.push(
        `<div class="lb-seg">
          <button class="lb-btn ${state.mode === 'side' ? 'active' : ''}" data-act="mode-side">并排对比</button>
          <button class="lb-btn ${state.mode === 'slider' ? 'active' : ''}" data-act="mode-slider">卷帘对比</button>
        </div>`,
      );
    }

    if (state.isImageLike) {
      parts.push(
        `<div class="lb-seg">
          <button class="lb-btn" data-act="zoom-out" title="缩小 (-)">－</button>
          <span class="lb-zoom-readout" id="lb-zoom-readout">${Math.round(state.zoom * 100)}%</span>
          <button class="lb-btn" data-act="zoom-in" title="放大 (+)">＋</button>
        </div>
        <button class="lb-btn" data-act="zoom-fit" title="适应窗口 (0)">适应</button>
        <button class="lb-btn" data-act="zoom-2x">200%</button>
        <button class="lb-btn" data-act="zoom-4x">400%</button>
        <button class="lb-btn" data-act="zoom-1to1" title="按原始 1:1 像素显示">1:1 像素</button>`,
      );
    } else if (state.kind === 'compare') {
      parts.push(
        `<button class="lb-btn" data-act="vid-sync-play">▶ 同步播放 / 暂停</button>
        <button class="lb-btn" data-act="vid-sync-reset">↺ 同步归零</button>`,
      );
    }

    if (state.list?.length > 1) {
      parts.push(
        `<div class="lb-seg">
          <button class="lb-btn" data-act="prev">← 上一张</button>
          <button class="lb-btn" data-act="next">下一张 →</button>
        </div>`,
      );
    }

    ctrlEl.innerHTML = parts.join('');
    ctrlEl.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => handleAction(btn.dataset.act);
    });
  }

  function handleAction(act) {
    if (!state) return;
    if (act === 'mode-side') {
      state.mode = 'side';
      renderContent();
    } else if (act === 'mode-slider') {
      state.mode = 'slider';
      renderContent();
    } else if (act === 'zoom-out') {
      setZoom(state.zoom / 1.35);
    } else if (act === 'zoom-in') {
      setZoom(state.zoom * 1.35);
    } else if (act === 'zoom-fit') {
      resetTransform();
    } else if (act === 'zoom-2x') {
      state.zoom = 2;
      applyTransform();
      updateZoomBadge();
    } else if (act === 'zoom-4x') {
      state.zoom = 4;
      applyTransform();
      updateZoomBadge();
    } else if (act === 'zoom-1to1') {
      const img = modal.querySelector('.lb-zoom-target');
      const stage = modal.querySelector('.lb-pan-stage');
      if (img && stage && img.naturalWidth && img.clientWidth) {
        const ratio = img.naturalWidth / img.clientWidth;
        state.zoom = clampZoom(ratio);
        state.panX = 0;
        state.panY = 0;
        applyTransform();
        updateZoomBadge();
      }
    } else if (act === 'prev') {
      stepList(-1);
    } else if (act === 'next') {
      stepList(1);
    } else if (act === 'vid-sync-play') {
      const vids = [...modal.querySelectorAll('video')];
      if (!vids.length) return;
      const anyPaused = vids.some((v) => v.paused);
      vids.forEach((v) => {
        if (anyPaused) v.play().catch(() => {});
        else v.pause();
      });
    } else if (act === 'vid-sync-reset') {
      modal.querySelectorAll('video').forEach((v) => {
        v.currentTime = 0;
      });
    }
  }

  function renderContent() {
    renderToolbar();
    const body = modal.querySelector('#lb-body');
    const footer = modal.querySelector('#lb-footer');

    if (state.kind === 'compare') {
      if (state.isImageLike && state.mode === 'slider') {
        const pct = state.splitPct ?? 50;
        body.innerHTML = `
          <div class="lb-slider-stage lb-pan-stage" id="lb-slider-stage">
            <div class="lb-slider-layer lb-checker">
              <img class="lb-zoom-target ${state.outExt === 'svg' ? 'lb-is-svg' : ''}" id="lb-img-out" src="${toFileUrl(state.outPath)}" alt="输出结果" draggable="false" />
            </div>
            <div class="lb-slider-layer lb-checker lb-slider-before" id="lb-slider-before" style="clip-path: inset(0 ${100 - pct}% 0 0);">
              <img class="lb-zoom-target ${state.srcExt === 'svg' ? 'lb-is-svg' : ''}" id="lb-img-src" src="${toFileUrl(state.srcPath)}" alt="原文件" draggable="false" />
            </div>
            <div class="lb-badge lb-badge-left" id="lb-badge-src">原文件${state.srcMeta ? ` · ${esc(state.srcMeta)}` : ''}</div>
            <div class="lb-badge lb-badge-right" id="lb-badge-out">输出结果${state.outMeta ? ` · ${esc(state.outMeta)}` : ''}</div>
            <div class="lb-divider" id="lb-divider" style="left: ${pct}%;">
              <div class="lb-divider-handle">⇄</div>
            </div>
          </div>
        `;
        bindSliderInteractions();
      } else {
        body.innerHTML = `
          <div class="lb-compare-grid">
            <div class="lb-pane">
              <div class="lb-pane-head">
                <span class="lb-pane-tag">原文件</span>
                <span class="lb-pane-meta" id="lb-meta-src">${esc(state.srcMeta || '')}</span>
              </div>
              <div class="lb-pane-stage lb-pan-stage lb-checker">
                ${renderTag(state.srcPath, state.srcExt, 'lb-img-src')}
              </div>
            </div>
            <div class="lb-pane">
              <div class="lb-pane-head">
                <span class="lb-pane-tag out">输出结果</span>
                <span class="lb-pane-meta" id="lb-meta-out">${esc(state.outMeta || '')}</span>
              </div>
              <div class="lb-pane-stage lb-pan-stage lb-checker">
                ${renderTag(state.outPath, state.outExt, 'lb-img-out')}
              </div>
            </div>
          </div>
        `;
        if (state.isImageLike) bindPanZoom();
      }

      attachMetaLoaders();
      footer.textContent = state.isImageLike
        ? '提示：滚轮缩放细节（两侧同步缩放） · 拖拽画面同步平移 · Esc 关闭 · 0 复位'
        : '提示：可点击上方“同步播放 / 暂停”对比两段视频画面差异 · Esc 关闭';
    } else {
      body.innerHTML = `
        <div class="lb-single-stage lb-pan-stage lb-checker">
          ${renderTag(state.srcPath, extOf(state.srcPath), 'lb-img-single')}
        </div>
      `;
      if (state.isImageLike) bindPanZoom();
      attachSingleMetaLoader();
      if (state.isImageLike && state.handoff) {
        const ext = extOf(state.srcPath);
        const compatible = (state.handoff.features || []).filter((f) => f.accept?.includes(ext));
        const optsHtml = compatible.map((f) => `<option value="${f.id}">${f.icon} ${esc(f.name)}</option>`).join('');
        footer.innerHTML = `
          <div class="lb-footer-row">
            <span class="lb-footer-tip">滚轮缩放 · 拖拽平移 · Esc 关闭${state.list?.length > 1 ? ' · ←/→ 切换' : ''}</span>
            <div class="lb-footer-actions">
              <button class="lb-btn" id="lb-copy-img">📋 复制图片</button>
              ${compatible.length ? `<select class="lb-select" id="lb-handoff-sel">${optsHtml}</select><button class="lb-btn active" id="lb-handoff-btn">↗ 发送此图到工具</button>` : ''}
            </div>
          </div>`;
        const copyBtn = footer.querySelector('#lb-copy-img');
        if (copyBtn) copyBtn.onclick = () => state.handoff.onCopy?.(state.srcPath);
        const sendBtn = footer.querySelector('#lb-handoff-btn');
        const sel = footer.querySelector('#lb-handoff-sel');
        if (sendBtn && sel) {
          const handoffRef = state.handoff;
          const capturedPath = state.srcPath;
          sendBtn.onclick = () => {
            const fid = sel.value;
            close();
            handoffRef.onSend?.(capturedPath, fid);
          };
        }
      } else {
        footer.textContent = state.isImageLike
          ? `提示：滚轮缩放 · 拖拽平移 · Esc 关闭${state.list?.length > 1 ? ' · ←/→ 切换图片' : ''}`
          : '提示：按 Esc 关闭预览';
      }
    }

    applyTransform();
  }

  function renderTag(filePath, ext, id) {
    const url = toFileUrl(filePath);
    if (IMG_LIKE.has(ext)) {
      const svgCls = ext === 'svg' ? ' lb-is-svg' : '';
      return `<img class="lb-zoom-target${svgCls}" id="${id}" src="${url}" alt="预览" draggable="false" />`;
    }
    return `<video id="${id}" src="${url}" controls preload="metadata"></video>`;
  }

  function attachMetaLoaders() {
    const srcImg = modal.querySelector('#lb-img-src');
    const outImg = modal.querySelector('#lb-img-out');
    const update = (el, targetId, prefix, baseMeta) => {
      if (!el || el.tagName !== 'IMG') return;
      const fill = () => {
        const dim = fmtDim(el);
        const text = [dim, baseMeta].filter(Boolean).join(' · ');
        const target = modal.querySelector(targetId);
        if (!target) return;
        target.textContent = prefix ? `${prefix}${text ? ` · ${text}` : ''}` : text;
      };
      if (el.complete && el.naturalWidth) fill();
      else el.addEventListener('load', fill, { once: true });
    };

    if (state.mode === 'slider') {
      update(srcImg, '#lb-badge-src', '原文件', state.srcMeta);
      update(outImg, '#lb-badge-out', '输出结果', state.outMeta);
    } else {
      update(srcImg, '#lb-meta-src', '', state.srcMeta);
      update(outImg, '#lb-meta-out', '', state.outMeta);
    }
  }

  function attachSingleMetaLoader() {
    const img = modal.querySelector('#lb-img-single');
    if (!img || img.tagName !== 'IMG') return;
    const fill = () => {
      if (!state) return;
      const titleEl = modal.querySelector('#lb-title');
      const idxText = state.list?.length > 1 ? ` (${state.index + 1}/${state.list.length})` : '';
      const dim = fmtDim(img);
      const extra = [dim, state.srcMeta].filter(Boolean).join(' · ');
      titleEl.textContent = `${state.srcLabel || '放大预览'}${idxText}${extra ? ` — ${extra}` : ''}`;
    };
    if (img.complete && img.naturalWidth) fill();
    else img.addEventListener('load', fill, { once: true });
  }

  function bindPanZoom() {
    modal.querySelectorAll('.lb-pan-stage').forEach((stage) => {
      stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
        setZoom(state.zoom * factor, false);
      }, { passive: false });

      stage.addEventListener('dblclick', () => {
        if (state.zoom > 1.05) resetTransform();
        else {
          state.zoom = 2.5;
          applyTransform();
          updateZoomBadge();
        }
      });

      stage.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.lb-divider')) return;
        if (state.mode === 'slider' && state.zoom <= 1.01) return;
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const basePanX = state.panX;
        const basePanY = state.panY;
        stage.style.cursor = 'grabbing';

        const onMove = (ev) => {
          state.panX = basePanX + (ev.clientX - startX);
          state.panY = basePanY + (ev.clientY - startY);
          applyTransform();
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          applyTransform();
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });
    });
  }

  function bindSliderInteractions() {
    bindPanZoom();
    const stage = modal.querySelector('#lb-slider-stage');
    const divider = modal.querySelector('#lb-divider');
    const before = modal.querySelector('#lb-slider-before');
    if (!stage || !divider || !before) return;

    const updateSplit = (clientX) => {
      const rect = stage.getBoundingClientRect();
      if (!rect.width) return;
      const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
      state.splitPct = pct;
      divider.style.left = `${pct}%`;
      before.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    };

    const startDrag = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      updateSplit(e.clientX);
      const onMove = (ev) => updateSplit(ev.clientX);
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };

    divider.addEventListener('mousedown', startDrag);
    stage.addEventListener('mousedown', (e) => {
      if (state.zoom <= 1.01) startDrag(e);
    });
  }

  window.VGT.lightbox = {
    openSingle({ path, label, meta = '', list = null, index = 0, handoff = null }) {
      ensureModal();
      const target = list?.[index] || { path, label, meta };
      const ext = extOf(target.path);
      state = {
        kind: 'single',
        mode: 'single',
        srcPath: target.path,
        srcLabel: target.label || target.path.split(/[\\/]/).pop(),
        srcMeta: target.meta || '',
        list,
        index,
        handoff,
        isImageLike: IMG_LIKE.has(ext),
        zoom: 1,
        panX: 0,
        panY: 0,
      };
      modal.classList.remove('hidden');
      renderContent();
    },

    openCompare({ srcPath, srcExt, srcMeta = '', outPath, outExt, outMeta = '', initialMode = 'side' }) {
      ensureModal();
      const sExt = srcExt || extOf(srcPath);
      const oExt = outExt || extOf(outPath);
      const isImg = IMG_LIKE.has(sExt) && IMG_LIKE.has(oExt);
      state = {
        kind: 'compare',
        mode: isImg ? initialMode : 'side',
        srcPath,
        srcExt: sExt,
        srcMeta,
        outPath,
        outExt: oExt,
        outMeta,
        isImageLike: isImg,
        splitPct: 50,
        zoom: 1,
        panX: 0,
        panY: 0,
      };
      modal.classList.remove('hidden');
      renderContent();
    },

    close,
  };
})();
