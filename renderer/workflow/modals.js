(() => {
  'use strict';

  window.VGT = window.VGT || {};

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  function toFileUrl(p) {
    return encodeURI('file:///' + String(p || '').replace(/\\/g, '/'));
  }

  // ---------------------------------------------------------------------------
  // 1. 可视化裁剪 / 局部打码弹窗
  // ---------------------------------------------------------------------------
  function openCropModal({ node, previewFile, isCrop = true, onSave }) {
    const overlay = document.createElement('div');
    overlay.className = 'wf-modal-overlay';

    const curCrop = node.params?.crop || { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
    let rect = { ...curCrop };
    let activeFile = previewFile || null;
    let currentImg = null;
    let dragging = null;
    let lockRatio = 0;

    overlay.innerHTML = `
      <div class="wf-modal-dialog wf-modal-lg" role="dialog" aria-modal="true">
        <div class="wf-modal-head">
          <div class="wf-modal-title">${isCrop ? '🔲 画面裁剪选区' : '🫥 局部打码 / 模糊选区'}</div>
          <button class="wf-modal-close" title="关闭 (Esc)">✕</button>
        </div>
        <div class="wf-modal-body">
          <div class="wf-modal-toolbar">
            <button class="btn btn-ghost btn-sm" id="wf-crop-pick">📁 选择参考画面文件</button>
            <span class="muted" id="wf-crop-file-label">${activeFile ? esc(activeFile.path.split(/[\\/]/).pop()) : '未检测到上游画面（可临时选择本地视频/图片预览，或手动输坐标）'}</span>
          </div>
          <div class="wf-crop-scrub hidden" id="wf-crop-scrub-row">
            <span>参考帧时间</span>
            <input type="range" id="wf-crop-time" min="0" max="10" step="0.1" value="0.5" />
            <span id="wf-crop-time-val">0.5s</span>
          </div>
          ${isCrop ? `<div class="wf-crop-ratios" id="wf-crop-ratios">
            <button class="chip on" data-ratio="0">自由比例</button>
            <button class="chip" data-ratio="${16 / 9}">16:9</button>
            <button class="chip" data-ratio="${9 / 16}">9:16</button>
            <button class="chip" data-ratio="1">1:1</button>
            <button class="chip" data-ratio="${4 / 3}">4:3</button>
          </div>` : ''}
          <div class="wf-crop-stage">
            <canvas id="wf-crop-canvas"></canvas>
            <div class="wf-crop-empty" id="wf-crop-empty">请选择参考文件或先运行上游节点获取画面预览</div>
          </div>
          <div class="wf-crop-nums">
            <label>左 X (%) <input type="number" id="wf-c-x" min="0" max="98" step="1" value="${Math.round(rect.x * 100)}" /></label>
            <label>上 Y (%) <input type="number" id="wf-c-y" min="0" max="98" step="1" value="${Math.round(rect.y * 100)}" /></label>
            <label>宽 W (%) <input type="number" id="wf-c-w" min="2" max="100" step="1" value="${Math.round(rect.w * 100)}" /></label>
            <label>高 H (%) <input type="number" id="wf-c-h" min="2" max="100" step="1" value="${Math.round(rect.h * 100)}" /></label>
          </div>
          <div class="muted" id="wf-crop-status" style="font-size:12px"></div>
        </div>
        <div class="wf-modal-foot">
          <button class="btn btn-ghost btn-sm" id="wf-crop-reset">重置为默认</button>
          <div style="flex:1"></div>
          <button class="btn btn-ghost btn-sm" id="wf-crop-cancel">取消</button>
          <button class="btn btn-primary btn-sm" id="wf-crop-ok">确定应用选区</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const canvas = overlay.querySelector('#wf-crop-canvas');
    const ctx = canvas.getContext('2d');
    const emptyEl = overlay.querySelector('#wf-crop-empty');
    const statusEl = overlay.querySelector('#wf-crop-status');
    const scrubRow = overlay.querySelector('#wf-crop-scrub-row');
    const scrub = overlay.querySelector('#wf-crop-time');
    const scrubVal = overlay.querySelector('#wf-crop-time-val');
    const xIn = overlay.querySelector('#wf-c-x');
    const yIn = overlay.querySelector('#wf-c-y');
    const wIn = overlay.querySelector('#wf-c-w');
    const hIn = overlay.querySelector('#wf-c-h');

    const syncNums = () => {
      xIn.value = Math.round(rect.x * 100);
      yIn.value = Math.round(rect.y * 100);
      wIn.value = Math.round(rect.w * 100);
      hIn.value = Math.round(rect.h * 100);
    };

    const updateStatus = () => {
      const iw = activeFile?.info?.width;
      const ih = activeFile?.info?.height;
      if (iw && ih) {
        statusEl.textContent = `当前选区：${Math.round(rect.w * iw)} × ${Math.round(rect.h * ih)} px · 起点 (${Math.round(rect.x * iw)}, ${Math.round(rect.y * ih)})（参考图 ${iw}×${ih}）`;
      } else {
        statusEl.textContent = `归一化选区：X ${Math.round(rect.x * 100)}%，Y ${Math.round(rect.y * 100)}%，W ${Math.round(rect.w * 100)}%，H ${Math.round(rect.h * 100)}%`;
      }
    };

    const redraw = () => {
      if (!currentImg) return;
      ctx.drawImage(currentImg, 0, 0, canvas.width, canvas.height);
      const [rx, ry, rw, rh] = [rect.x * canvas.width, rect.y * canvas.height, rect.w * canvas.width, rect.h * canvas.height];
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, canvas.width, ry);
      ctx.fillRect(0, ry + rh, canvas.width, canvas.height - ry - rh);
      ctx.fillRect(0, ry, rx, rh);
      ctx.fillRect(rx + rw, ry, canvas.width - rx - rw, rh);
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 2;
      ctx.strokeRect(rx, ry, rw, rh);
    };

    const loadPreviewFrame = async (tSec = 0.2) => {
      if (!activeFile?.path) {
        canvas.style.display = 'none';
        emptyEl.style.display = '';
        scrubRow.classList.add('hidden');
        updateStatus();
        return;
      }
      const dur = activeFile.info?.duration || 0;
      if (dur > 0.3) {
        scrubRow.classList.remove('hidden');
        scrub.max = Math.max(0.1, round1(dur - 0.1));
      } else {
        scrubRow.classList.add('hidden');
      }
      statusEl.textContent = '正在加载参考画面…';
      const dataUrl = await window.api.firstFrame(activeFile.path, activeFile.info?.isImage ? 0 : tSec);
      if (!dataUrl) {
        canvas.style.display = 'none';
        emptyEl.style.display = '';
        statusEl.textContent = '无法读取该文件的参考帧，可更换文件或使用下方百分比输入';
        return;
      }
      const img = new Image();
      img.onload = () => {
        currentImg = img;
        const scale = Math.min(1, 640 / img.width, 380 / img.height);
        canvas.width = Math.max(120, Math.round(img.width * scale));
        canvas.height = Math.max(90, Math.round(img.height * scale));
        canvas.style.display = 'block';
        emptyEl.style.display = 'none';
        redraw();
        updateStatus();
      };
      img.src = dataUrl;
    };

    const getCanvasPos = (e) => {
      const r = canvas.getBoundingClientRect();
      return [
        Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
        Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
      ];
    };

    canvas.onmousedown = (e) => {
      if (!currentImg) return;
      const [nx, ny] = getCanvasPos(e);
      dragging = { x0: nx, y0: ny };
      e.preventDefault();
    };
    canvas.onmousemove = (e) => {
      if (!dragging || !currentImg) return;
      const [nx, ny] = getCanvasPos(e);
      let dx = nx - dragging.x0;
      let dy = ny - dragging.y0;
      const iw = activeFile?.info?.width || currentImg.width;
      const ih = activeFile?.info?.height || currentImg.height;
      if (lockRatio > 0 && iw && ih) {
        const normRatio = lockRatio * (ih / iw);
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
      rect = {
        x: Math.min(dragging.x0, dragging.x0 + dx),
        y: Math.min(dragging.y0, dragging.y0 + dy),
        w: Math.max(0.02, Math.abs(dx)),
        h: Math.max(0.02, Math.abs(dy)),
      };
      syncNums();
      redraw();
      updateStatus();
    };
    window.addEventListener('mouseup', () => { dragging = null; });

    [xIn, yIn, wIn, hIn].forEach((inp) => {
      inp.oninput = () => {
        const x = Math.min(0.98, Math.max(0, (parseFloat(xIn.value) || 0) / 100));
        const y = Math.min(0.98, Math.max(0, (parseFloat(yIn.value) || 0) / 100));
        const w = Math.min(1 - x, Math.max(0.02, (parseFloat(wIn.value) || 20) / 100));
        const h = Math.min(1 - y, Math.max(0.02, (parseFloat(hIn.value) || 20) / 100));
        rect = { x, y, w, h };
        redraw();
        updateStatus();
      };
    });

    overlay.querySelectorAll('#wf-crop-ratios .chip').forEach((chip) => {
      chip.onclick = () => {
        overlay.querySelectorAll('#wf-crop-ratios .chip').forEach((c) => c.classList.remove('on'));
        chip.classList.add('on');
        lockRatio = parseFloat(chip.dataset.ratio) || 0;
      };
    });

    let scrubTimer = null;
    scrub.oninput = () => {
      scrubVal.textContent = `${scrub.value}s`;
      clearTimeout(scrubTimer);
      scrubTimer = setTimeout(() => loadPreviewFrame(parseFloat(scrub.value)), 160);
    };

    overlay.querySelector('#wf-crop-pick').onclick = async () => {
      const picked = await window.api.pickFile(isCrop ? 'videoCrop' : 'videoBlur');
      const p = Array.isArray(picked) ? picked[0] : picked;
      if (!p) return;
      const res = await window.api.probe(p);
      if (!res.ok) return;
      activeFile = { path: p, info: res.info };
      overlay.querySelector('#wf-crop-file-label').textContent = p.split(/[\\/]/).pop();
      await loadPreviewFrame(0.2);
    };

    overlay.querySelector('#wf-crop-reset').onclick = () => {
      rect = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
      syncNums();
      redraw();
      updateStatus();
    };

    const close = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.wf-modal-close').onclick = close;
    overlay.querySelector('#wf-crop-cancel').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    overlay.querySelector('#wf-crop-ok').onclick = () => {
      onSave?.({ ...rect });
      close();
    };

    loadPreviewFrame(0.2);
  }

  // ---------------------------------------------------------------------------
  // 2. 多段保留 / 删片段弹窗
  // ---------------------------------------------------------------------------
  function openSegmentsModal({ node, previewFile, onSave }) {
    const overlay = document.createElement('div');
    overlay.className = 'wf-modal-overlay';
    const segs = Array.isArray(node.params?.segments) && node.params.segments.length
      ? node.params.segments.map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 5 }))
      : [{ start: 0, end: 5 }];
    let activeFile = previewFile || null;

    overlay.innerHTML = `
      <div class="wf-modal-dialog" role="dialog" aria-modal="true">
        <div class="wf-modal-head">
          <div class="wf-modal-title">🎞️ 多段保留 / 删片段时间段设置</div>
          <button class="wf-modal-close" title="关闭 (Esc)">✕</button>
        </div>
        <div class="wf-modal-body">
          <div class="wf-modal-toolbar">
            <button class="btn btn-ghost btn-sm" id="wf-seg-pick">📁 选择参考视频</button>
            <span class="muted" id="wf-seg-file-label">${activeFile ? esc(activeFile.path.split(/[\\/]/).pop()) : '未检测到上游视频（可直接手填秒数，或选本地视频打点）'}</span>
          </div>
          <div class="wf-seg-video-wrap ${activeFile ? '' : 'hidden'}" id="wf-seg-video-wrap">
            <video id="wf-seg-video" controls preload="metadata" ${activeFile ? `src="${toFileUrl(activeFile.path)}"` : ''}></video>
          </div>
          <div class="seg-list" id="wf-seg-list"></div>
          <div class="chip-row" style="margin-top:8px">
            <button class="chip" id="wf-seg-add">+ 添加片段</button>
          </div>
        </div>
        <div class="wf-modal-foot">
          <div style="flex:1"></div>
          <button class="btn btn-ghost btn-sm" id="wf-seg-cancel">取消</button>
          <button class="btn btn-primary btn-sm" id="wf-seg-ok">保存时间段</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const listEl = overlay.querySelector('#wf-seg-list');
    const vidEl = overlay.querySelector('#wf-seg-video');
    const vidWrap = overlay.querySelector('#wf-seg-video-wrap');

    const getTime = () => round1(vidEl?.currentTime || 0);

    const renderSegs = () => {
      listEl.innerHTML = '';
      segs.forEach((seg, idx) => {
        const row = document.createElement('div');
        row.className = 'seg-row';
        row.innerHTML = `
          <span class="seg-idx">片段 #${idx + 1}</span>
          <input type="number" class="seg-start" value="${seg.start}" min="0" step="0.1" />
          <span class="times-sep">→</span>
          <input type="number" class="seg-end" value="${seg.end}" min="0" step="0.1" />
          <button class="batch-btn seg-pick-s" title="用当前播放时间设为起点">⏮</button>
          <button class="batch-btn seg-pick-e" title="用当前播放时间设为终点">⏭</button>
          ${segs.length > 1 ? '<button class="batch-btn seg-rm" title="删除该段">✕</button>' : ''}
        `;
        const sIn = row.querySelector('.seg-start');
        const eIn = row.querySelector('.seg-end');
        sIn.oninput = () => { seg.start = parseFloat(sIn.value) || 0; };
        eIn.oninput = () => { seg.end = parseFloat(eIn.value) || 0; };
        row.querySelector('.seg-pick-s').onclick = () => {
          const t = getTime();
          seg.start = t;
          sIn.value = t;
        };
        row.querySelector('.seg-pick-e').onclick = () => {
          const t = getTime();
          seg.end = t;
          eIn.value = t;
        };
        const rm = row.querySelector('.seg-rm');
        if (rm) rm.onclick = () => { segs.splice(idx, 1); renderSegs(); };
        listEl.appendChild(row);
      });
    };
    renderSegs();

    overlay.querySelector('#wf-seg-add').onclick = () => {
      const last = segs[segs.length - 1];
      const nextS = last ? round1(last.end) : 0;
      segs.push({ start: nextS, end: round1(nextS + 5) });
      renderSegs();
    };

    overlay.querySelector('#wf-seg-pick').onclick = async () => {
      const picked = await window.api.pickFile('multiCut');
      const p = Array.isArray(picked) ? picked[0] : picked;
      if (!p) return;
      const res = await window.api.probe(p);
      if (!res.ok) return;
      activeFile = { path: p, info: res.info };
      overlay.querySelector('#wf-seg-file-label').textContent = p.split(/[\\/]/).pop();
      vidEl.src = toFileUrl(p);
      vidWrap.classList.remove('hidden');
    };

    const close = () => {
      try { vidEl?.pause(); } catch {}
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.wf-modal-close').onclick = close;
    overlay.querySelector('#wf-seg-cancel').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    overlay.querySelector('#wf-seg-ok').onclick = () => {
      onSave?.(segs);
      close();
    };
  }

  // ---------------------------------------------------------------------------
  // 3. 工作流模板库与我的存档管理弹窗
  // ---------------------------------------------------------------------------
  function openTemplatesModal({
    templates,
    savedList,
    currentName,
    onLoadTemplate,
    onSaveCurrent,
    onLoadSaved,
    onDeleteSaved,
    onExportJson,
    onImportJson,
  }) {
    const overlay = document.createElement('div');
    overlay.className = 'wf-modal-overlay';
    let tab = 'templates';

    overlay.innerHTML = `
      <div class="wf-modal-dialog wf-modal-lg" role="dialog" aria-modal="true">
        <div class="wf-modal-head">
          <div class="wf-modal-title">📋 工作流模板库 & 本地存档</div>
          <button class="wf-modal-close" title="关闭 (Esc)">✕</button>
        </div>
        <div class="wf-modal-tabs">
          <button class="wf-tab active" data-tab="templates">✨ 预设模板 (${templates.length})</button>
          <button class="wf-tab" data-tab="saved">💾 我的本地存档 (<span id="wf-saved-count">${savedList.length}</span>)</button>
          <div style="flex:1"></div>
          <button class="btn btn-ghost btn-sm" id="wf-mod-import">📥 导入 .json</button>
          <button class="btn btn-ghost btn-sm" id="wf-mod-export">📤 导出 .json</button>
        </div>
        <div class="wf-modal-body" id="wf-tpl-body"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    const body = overlay.querySelector('#wf-tpl-body');
    const savedCountEl = overlay.querySelector('#wf-saved-count');

    const close = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    const renderBody = () => {
      if (tab === 'templates') {
        body.innerHTML = `<div class="wf-tpl-grid">
          ${templates.map((t) => `
            <div class="wf-tpl-card">
              <div class="wf-tpl-cat">${esc(t.category)} · ${t.graph.nodes.length} 个节点</div>
              <div class="wf-tpl-name">${esc(t.name)}</div>
              <div class="wf-tpl-desc">${esc(t.desc)}</div>
              <div class="wf-tpl-actions">
                <button class="btn btn-primary btn-sm" data-load-tpl="${esc(t.id)}">载入此工作流</button>
              </div>
            </div>
          `).join('')}
        </div>`;
        body.querySelectorAll('[data-load-tpl]').forEach((btn) => {
          btn.onclick = () => {
            const tpl = templates.find((x) => x.id === btn.dataset.loadTpl);
            if (tpl) {
              onLoadTemplate?.(tpl);
              close();
            }
          };
        });
      } else {
        const list = onLoadSaved ? (window.VGT.wfStorage?.list?.() || savedList) : savedList;
        savedCountEl.textContent = String(list.length);
        body.innerHTML = `
          <div class="wf-save-bar">
            <input type="text" id="wf-save-name-inp" placeholder="输入工作流名称…" value="${esc(currentName || '我的工作流')}" />
            <button class="btn btn-primary btn-sm" id="wf-save-now-btn">💾 保存当前画布到列表</button>
          </div>
          <div class="wf-saved-list">
            ${list.length ? list.map((item) => `
              <div class="wf-saved-row">
                <div class="wf-saved-info">
                  <div class="wf-saved-name">${esc(item.name)}</div>
                  <div class="wf-saved-meta">${item.nodeCount} 个节点 · ${item.edgeCount} 条连线 · 保存于 ${new Date(item.updatedAt).toLocaleString()}</div>
                </div>
                <div class="wf-saved-ops">
                  <button class="btn btn-primary btn-sm" data-open-saved="${esc(item.id)}">打开</button>
                  <button class="btn btn-ghost btn-sm" data-del-saved="${esc(item.id)}">删除</button>
                </div>
              </div>
            `).join('') : '<div class="muted" style="text-align:center;padding:30px">暂无保存的工作流，上方输入名称即可保存当前画布</div>'}
          </div>
        `;
        body.querySelector('#wf-save-now-btn').onclick = () => {
          const name = body.querySelector('#wf-save-name-inp').value.trim() || '未命名工作流';
          onSaveCurrent?.(name);
          renderBody();
        };
        body.querySelectorAll('[data-open-saved]').forEach((btn) => {
          btn.onclick = () => {
            onLoadSaved?.(btn.dataset.openSaved);
            close();
          };
        });
        body.querySelectorAll('[data-del-saved]').forEach((btn) => {
          btn.onclick = () => {
            onDeleteSaved?.(btn.dataset.delSaved);
            renderBody();
          };
        });
      }
    };

    overlay.querySelectorAll('.wf-tab').forEach((tBtn) => {
      tBtn.onclick = () => {
        tab = tBtn.dataset.tab;
        overlay.querySelectorAll('.wf-tab').forEach((x) => x.classList.toggle('active', x === tBtn));
        renderBody();
      };
    });
    overlay.querySelector('#wf-mod-import').onclick = async () => {
      const ok = await onImportJson?.();
      if (ok) close();
    };
    overlay.querySelector('#wf-mod-export').onclick = () => onExportJson?.();
    overlay.querySelector('.wf-modal-close').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };

    renderBody();
  }

  window.VGT.wfModals = {
    openCropModal,
    openSegmentsModal,
    openTemplatesModal,
  };
})();
