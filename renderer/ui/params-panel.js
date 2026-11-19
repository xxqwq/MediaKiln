(() => {
'use strict';

window.VGT = window.VGT || {};

const SAVABLE_TYPES = new Set(['select', 'chips', 'range', 'color', 'number', 'text']);
const round1 = (n) => Math.round(n * 10) / 10;
const escHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function readChips(key) {
  const row = document.querySelector(`.chip-row[data-key="${key}"]`);
  const on = row?.querySelector('.chip.on');
  return on ? on.dataset.val : null;
}

function collectFieldValues() {
  const values = {};
  document.querySelectorAll('#params [data-key]').forEach((el) => {
    if (el.classList.contains('chip-row')) values[el.dataset.key] = readChips(el.dataset.key);
    else values[el.dataset.key] = el.value;
  });
  document.querySelectorAll('#params input[type="range"][data-key]').forEach((range) => {
    values[range.dataset.key] = parseFloat(range.value);
  });
  return values;
}

function loadSavedParams(featureId) {
  try { return JSON.parse(localStorage.getItem(`vgt_params_${featureId}`) || 'null'); } catch { return null; }
}

function loadUserPresets(featureId) {
  try {
    const list = JSON.parse(localStorage.getItem(`vgt_presets_${featureId}`) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveUserPresets(featureId, presets) {
  try {
    localStorage.setItem(`vgt_presets_${featureId}`, JSON.stringify(presets));
    return true;
  } catch {
    return false;
  }
}

function extractSavableValues(feature) {
  const vals = collectFieldValues();
  const data = {};
  for (const field of feature.fields) {
    if (field.key && SAVABLE_TYPES.has(field.type) && vals[field.key] !== undefined) {
      data[field.key] = vals[field.key];
    }
  }
  return data;
}

function saveCurrentParams(feature) {
  const data = extractSavableValues(feature);
  try { localStorage.setItem(`vgt_params_${feature.id}`, JSON.stringify(data)); } catch {}
}

function createParamsController(appCtx) {
  const { $, getCurrentFeature, getFile, getBatchFiles, toast, prefillTimes } = appCtx;
  const activePresetByFeature = new Map();

  const isContextImage = () => {
    const file = getFile();
    if (file?.info?.isImage) return true;
    const batch = getBatchFiles();
    if (batch?.length && batch.every((b) => b.info?.isImage)) return true;
    return false;
  };

  const isContextGif = () => {
    const file = getFile();
    if (file?.path) return file.path.toLowerCase().endsWith('.gif');
    const batch = getBatchFiles();
    if (batch?.length && batch.every((b) => b.path.toLowerCase().endsWith('.gif'))) return true;
    return false;
  };

  function syncVisibility() {
    const currentFeature = getCurrentFeature();
    const values = collectFieldValues();
    const ctx = { isImage: isContextImage(), isGif: isContextGif() };
    for (const field of currentFeature.fields) {
      if (!field.showIf) continue;
      let target = null;
      if (field.key) {
        target = document.querySelector(`#params .field[data-field-key="${field.key}"]`);
      } else if (field.type === 'times') {
        target = document.querySelector('#t-start')?.closest('.field');
      }
      if (target) target.style.display = field.showIf(values, ctx) ? '' : 'none';
    }
  }

  function renderParams({ preserveInputState = false } = {}) {
    const currentFeature = getCurrentFeature();
    const file = getFile();

    if (!preserveInputState) {
      window.__crop = null;
      window.__secondFile = window.__pendingSecondFile || null;
      window.__pendingSecondFile = null;
      window.__secondInfo = null;
      window.__segments = [];
      window.__docSelectedSectionIds = null;
    }
    const box = $('params');
    box.innerHTML = '';

    if (currentFeature.fields.length) {
      const presets = loadUserPresets(currentFeature.id);
      let activePresetId = activePresetByFeature.get(currentFeature.id) || '';
      if (activePresetId && !presets.some((p) => p.id === activePresetId)) {
        activePresetId = '';
        activePresetByFeature.delete(currentFeature.id);
      }

      const head = document.createElement('div');
      head.className = 'params-head';
      const optsHtml = [
        `<option value="">选择已存预设 (${presets.length})…</option>`,
        ...presets.map((p) => `<option value="${escHtml(p.id)}" ${p.id === activePresetId ? 'selected' : ''}>${escHtml(p.name)}</option>`),
      ].join('');
      head.innerHTML = `
        <span>参数设置</span>
        <div class="params-head-actions">
          <select class="preset-select${presets.length ? '' : ' hidden'}" id="user-preset-select" aria-label="应用预设">${optsHtml}</select>
          <button type="button" class="batch-btn${activePresetId ? '' : ' hidden'}" id="btn-del-preset" aria-label="删除当前选中的预设" title="删除当前选中的预设">🗑</button>
          <button type="button" class="batch-btn" id="btn-save-preset" title="将当前参数保存为命名预设">💾 存为预设</button>
          <button type="button" class="batch-btn" id="btn-reset-params" title="清除本功能已记忆的参数">↺ 恢复默认</button>
          <button type="button" class="batch-btn" id="btn-params-to-wf" title="携带当前参数发送到节点工作流画布">🕸️ 带参数入画布</button>
        </div>`;
      box.appendChild(head);

      const saveRow = document.createElement('div');
      saveRow.className = 'preset-save-row hidden';
      saveRow.id = 'preset-save-row';
      saveRow.innerHTML = `
        <input type="text" id="preset-name-input" class="preset-name-input" aria-label="预设名称" placeholder="预设名称" maxlength="40" />
        <button type="button" class="batch-btn preset-confirm" id="btn-preset-confirm">保存</button>
        <button type="button" class="batch-btn" id="btn-preset-cancel">取消</button>
      `;
      box.appendChild(saveRow);
    }

    const grid = document.createElement('div');
    grid.className = 'param-grid';
    const hasVideo = !!document.querySelector('#preview-box video');
    const hasAudioPlayer = !!document.querySelector('#preview-box audio');
    const saved = loadSavedParams(currentFeature.id);

    for (const field of currentFeature.fields) {
      const wrap = document.createElement('div');
      wrap.className = 'field' + (field.fullWidth ? ' field-full' : '');
      if (field.key) wrap.dataset.fieldKey = field.key;
      if (field.showIf) wrap.dataset.showIf = '1';

      let initVal = field.def;
      if (saved && field.key && saved[field.key] !== undefined && SAVABLE_TYPES.has(field.type)) {
        initVal = String(saved[field.key]);
      }

      if (field.type === 'times') {
        const dur = file?.info?.duration || 0;
        const canGifScrub = !hasVideo && !hasAudioPlayer && file && !file.info?.isImage && dur > 0.2;
        const pickHtml = hasVideo || hasAudioPlayer
          ? `<div class="chip-row"><button class="chip" id="pick-t-start">⏮ 设为起点</button><button class="chip" id="pick-t-end">⏭ 设为终点</button></div>`
          : (canGifScrub
            ? `<div class="gif-scrub-box">
                 <div class="gif-scrub-row">
                   <span>定格预览</span>
                   <input type="range" id="gif-scrub-range" min="0" max="${round1(dur)}" step="0.1" value="0" />
                   <span id="gif-scrub-time" class="range-val">0s</span>
                 </div>
                 <div class="gif-scrub-preview">
                   <img id="gif-scrub-img" class="hidden" alt="GIF 帧预览" />
                   <span class="muted" id="gif-scrub-tip">拖动滑块可查看任意时间点画面并设为起止点</span>
                 </div>
                 <div class="chip-row">
                   <button class="chip" id="pick-t-start">⏮ 设为起点</button>
                   <button class="chip" id="pick-t-end">⏭ 设为终点</button>
                 </div>
               </div>`
            : '');
        wrap.innerHTML = `
          <label>时间段（秒）</label>
          <div class="times-row">
            <input type="number" id="t-start" value="0" min="0" step="0.1" />
            <span class="times-sep">→</span>
            <input type="number" id="t-end" value="0" min="0" step="0.1" />
          </div>
          <div class="chip-row" id="times-chips"></div>${pickHtml}`;
      } else if (field.type === 'multiSegments') {
        wrap.innerHTML = `<label>时间段列表（秒）</label>
          <div class="seg-list" id="seg-list"></div>
          <div class="chip-row">
            <button class="chip" id="seg-add">+ 添加片段</button>
          </div>`;
      } else if (field.type === 'select') {
        const validVal = field.options.some(([v]) => v === initVal) ? initVal : field.def;
        wrap.innerHTML = `<label>${field.label}</label>
          <select data-key="${field.key}">${field.options.map(([v, l]) => `<option value="${v}" ${v === validVal ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
      } else if (field.type === 'chips') {
        const validVal = field.options.some(([v]) => v === initVal) ? initVal : field.def;
        wrap.innerHTML = `<label>${field.label}</label>
          <div class="chip-row" data-key="${field.key}">
            ${field.options.map(([v, l]) => `<button class="chip ${v === validVal ? 'on' : ''}" data-val="${v}">${l}</button>`).join('')}
          </div>`;
      } else if (field.type === 'range') {
        const unit = field.unit ?? 'x';
        const n = parseFloat(initVal);
        const val = Number.isFinite(n) ? Math.min(Math.max(n, field.min), field.max) : field.def;
        wrap.innerHTML = `<label>${field.label}：<span class="range-val" data-range-key="${field.key}">${val}${unit}</span></label>
          <input type="range" data-key="${field.key}" data-unit="${unit}" min="${field.min}" max="${field.max}" step="${field.step}" value="${val}" />
          <div class="chip-row">
            ${field.presets.map(([v, l]) => `<button class="chip preset" data-val="${v}">${l}</button>`).join('')}
          </div>`;
      } else if (field.type === 'color') {
        const val = /^#[0-9a-f]{6}$/i.test(initVal || '') ? initVal : (field.def || '#00ff00');
        const presetsHtml = field.presets
          ? field.presets.map(([v, l]) => `<button class="chip preset" data-val="${v}">${l}</button>`).join('')
          : '';
        const eyeBtn = field.eyedropper && file
          ? `<button class="chip" data-eye-key="${field.key}">🪄 画面取色</button>`
          : '';
        const eyeBox = field.eyedropper && file
          ? `<div class="eyedropper-box hidden" id="eyedropper-box-${field.key}"></div>`
          : '';
        wrap.innerHTML = `<label>${field.label}</label>
          <div class="color-row">
            <input type="color" data-key="${field.key}" value="${val}" />
            ${presetsHtml}${eyeBtn}
          </div>${eyeBox}`;
      } else if (field.type === 'text') {
        const val = saved && field.key && saved[field.key] !== undefined ? String(saved[field.key]) : (field.def || '');
        wrap.innerHTML = `<label>${field.label}</label>
          <input type="text" data-key="${field.key}" placeholder="${field.placeholder || ''}" value="${val.replace(/"/g, '&quot;')}" />`;
      } else if (field.type === 'number') {
        const val = saved && field.key && saved[field.key] !== undefined ? saved[field.key] : field.def;
        const maxAttr = field.max !== undefined ? ` max="${field.max}"` : '';
        const presetsHtml = field.presets
          ? `<div class="chip-row">${field.presets.map(([v, l]) => `<button class="chip preset ${String(v) === String(val) ? 'on' : ''}" data-val="${v}">${l}</button>`).join('')}</div>`
          : '';
        const videoPickHtml = field.withVideoTime && hasVideo
          ? `<div class="chip-row"><button class="chip" id="pick-video-time">📍 取当前播放时间</button></div>`
          : '';
        wrap.innerHTML = `<label>${field.label}</label>
          <input type="number" data-key="${field.key}" value="${val}" min="${field.min ?? 0}"${maxAttr} step="${field.step || 1}" />${presetsHtml}${videoPickHtml}`;
      } else if (field.type === 'secondFile') {
        wrap.innerHTML = `<label>${field.label}</label>
          <div class="second-file">
            <button class="btn btn-ghost btn-sm" id="pick-second" data-kind="${field.kind || 'audioFile'}">📁 选择${field.label}</button>
            <span class="muted second-name" id="second-name">${field.placeholder || '未选择'}</span>
          </div>`;
      } else if (field.type === 'replaceSource') {
        const cur = window.__secondFile;
        const curText = cur?.files?.length
          ? `已选 ${cur.files.length} 张替换图片（${cur.files.map((p) => p.split(/[\\/]/).pop()).slice(0, 3).join('、')}${cur.files.length > 3 ? '…' : ''}）`
          : (cur?.dir ? `已选文件夹：${cur.dir}` : (field.placeholder || '未选择'));
        wrap.innerHTML = `<label>${field.label}</label>
          <div class="second-file">
            <button class="btn btn-ghost btn-sm" id="pick-replace-dir">📁 选择图片文件夹</button>
            <button class="btn btn-ghost btn-sm" id="pick-replace-files">🖼️ 选择替换图片</button>
            <span class="${cur ? '' : 'muted '}second-name" id="second-name" title="${cur?.dir || (cur?.files || []).join('\n')}">${curText}</span>
          </div>`;
      } else if (field.type === 'cropCanvas') {
        const dur = file?.info.duration || 0;
        const scrubHtml = dur > 0.3
          ? `<div class="crop-time-row">
               <span>参考帧</span>
               <input type="range" id="crop-frame-time" min="0" max="${Math.max(0.1, round1(dur - 0.1))}" step="0.1" value="${Math.min(0.5, round1(dur / 2))}" />
               <span id="crop-frame-label">${Math.min(0.5, round1(dur / 2))}s</span>
               ${hasVideo ? '<button class="chip" id="crop-from-vid">📷 取当前播放帧</button>' : ''}
             </div>`
          : '';
        const ratioHtml = currentFeature.id === 'videoCrop'
          ? `<div class="chip-row" id="crop-ratios">
               <button class="chip on" data-ratio="0">自由比例</button>
               <button class="chip" data-ratio="${16 / 9}">16:9</button>
               <button class="chip" data-ratio="${9 / 16}">9:16</button>
               <button class="chip" data-ratio="1">1:1</button>
               <button class="chip" data-ratio="${4 / 3}">4:3</button>
             </div>`
          : '';
        wrap.innerHTML = `<label>${field.label || '拖动鼠标框出要保留的区域'}</label>
          <div class="crop-tools">${scrubHtml}${ratioHtml}</div>
          <div class="crop-wrap"><canvas id="crop-canvas"></canvas></div>
          <div class="chip-row"><button class="chip" id="crop-reset">重置选区</button></div>
          <div class="muted crop-status" id="crop-status">尚未选择区域</div>`;
      } else if (field.type === 'pdfCropPreview') {
        wrap.classList.add('pdf-crop-field');
        wrap.hidden = !file;
      } else if (field.type === 'docSections') {
        const sections = file?.info?.sections || [];
        const actionWord = field.actionWord || '提取';
        const emptyTarget = field.emptyTarget || 'Word / PPT / Markdown 文档';
        if (!file) {
          wrap.innerHTML = `<label>${field.label}</label>
            <div class="doc-sections-empty muted">导入单个 ${emptyTarget}后可在此勾选指定章节或页面（批量模式下${actionWord}全部章节）</div>`;
        } else if (!sections.length) {
          const mdHint = emptyTarget.includes('Markdown') ? ' / Markdown # 标题' : '';
          const emptyMsg = file.info?.docType === 'pptx'
            ? `当前 PPT 仅 1 页，将${actionWord}全部媒体资源`
            : `未检测到章节标题（如 Word 标题样式 / “第X章”${mdHint}），将${actionWord}文档全部图片`;
          wrap.innerHTML = `<label>${field.label}</label>
            <div class="doc-sections-empty muted">${emptyMsg}</div>`;
        } else {
          window.__docSelectedSectionIds = sections.map((s) => s.id);
          const rowsHtml = sections.map((s) => {
            const indent = Math.min(5, Math.max(0, (s.level || 1) - 1));
            const countText = s.imageCount > 0
              ? (s.imageCount !== s.directImageCount ? `直属 ${s.directImageCount} / 共 ${s.imageCount} 图` : `${s.imageCount} 图`)
              : '0 图';
            const emptyCls = s.imageCount === 0 ? ' is-empty' : '';
            return `<label class="doc-sec-item${emptyCls}" data-sec-row="${escHtml(s.id)}" style="padding-left:${10 + indent * 16}px">
              <input type="checkbox" class="doc-sec-check" data-sec-id="${escHtml(s.id)}" checked />
              <span class="doc-sec-title" title="${escHtml(s.title)}">${escHtml(s.title)}</span>
              <span class="doc-sec-count${s.imageCount > 0 ? ' has-img' : ''}">${countText}</span>
            </label>`;
          }).join('');
          wrap.innerHTML = `<label>${field.label}</label>
            <div class="doc-sections-box" id="doc-sections-box" data-action-word="${escHtml(actionWord)}">
              <div class="doc-sec-toolbar">
                <input type="text" id="doc-sec-search" class="doc-sec-search" placeholder="筛选章节 / 页面名称…" />
                <button type="button" class="batch-btn" id="doc-sec-all">全选</button>
                <button type="button" class="batch-btn" id="doc-sec-with-img" title="只保留含图片或媒体的章节">仅选有图</button>
                <button type="button" class="batch-btn" id="doc-sec-none">清空</button>
                <label class="doc-sec-cascade" title="勾选/取消父章节时连带其子章节"><input type="checkbox" id="doc-sec-cascade" checked /> 连带子章节</label>
              </div>
              <div class="doc-sec-summary" id="doc-sec-summary"></div>
              <div class="doc-sec-list" id="doc-sec-list">${rowsHtml}</div>
            </div>`;
        }
      }
      grid.appendChild(wrap);
    }
    box.appendChild(grid);
    const pdfCropPreview = grid.querySelector('.pdf-crop-field');
    if (pdfCropPreview) window.VGT.pdfTools.mountCropPreview(pdfCropPreview, file);
    if (!currentFeature.fields.length) box.classList.add('hidden');
    else box.classList.remove('hidden');

    const persist = () => saveCurrentParams(currentFeature);

    const presetSelect = box.querySelector('#user-preset-select');
    const delPresetBtn = box.querySelector('#btn-del-preset');
    const savePresetBtn = box.querySelector('#btn-save-preset');
    const saveRow = box.querySelector('#preset-save-row');
    const presetNameInput = box.querySelector('#preset-name-input');
    const presetConfirmBtn = box.querySelector('#btn-preset-confirm');
    const presetCancelBtn = box.querySelector('#btn-preset-cancel');
    const paramsToWfBtn = box.querySelector('#btn-params-to-wf');

    const refreshPresetBar = () => {
      if (!presetSelect) return;
      const list = loadUserPresets(currentFeature.id);
      const activeId = activePresetByFeature.get(currentFeature.id) || '';
      presetSelect.innerHTML = [
        `<option value="">选择已存预设 (${list.length})…</option>`,
        ...list.map((p) => `<option value="${escHtml(p.id)}" ${p.id === activeId ? 'selected' : ''}>${escHtml(p.name)}</option>`),
      ].join('');
      presetSelect.classList.toggle('hidden', list.length === 0);
      if (delPresetBtn) delPresetBtn.classList.toggle('hidden', !activeId || !list.some((p) => p.id === activeId));
    };

    if (presetSelect) {
      presetSelect.onchange = () => {
        const chosenId = presetSelect.value;
        if (!chosenId) {
          activePresetByFeature.delete(currentFeature.id);
          if (delPresetBtn) delPresetBtn.classList.add('hidden');
          return;
        }
        const preset = loadUserPresets(currentFeature.id).find((p) => p.id === chosenId);
        if (!preset) return;
        const prevStart = $('t-start')?.value;
        const prevEnd = $('t-end')?.value;
        try { localStorage.setItem(`vgt_params_${currentFeature.id}`, JSON.stringify(preset.values || {})); }
        catch { toast('无法应用预设', true); return; }
        activePresetByFeature.set(currentFeature.id, preset.id);
        renderParams({ preserveInputState: true });
        if (file?.info) prefillTimes(file.info);
        if (prevStart !== undefined && $('t-start')) $('t-start').value = prevStart;
        if (prevEnd !== undefined && $('t-end')) $('t-end').value = prevEnd;
        toast(`已应用预设「${preset.name}」`);
      };
    }

    if (delPresetBtn) {
      delPresetBtn.onclick = () => {
        const activeId = activePresetByFeature.get(currentFeature.id);
        if (!activeId) return;
        const list = loadUserPresets(currentFeature.id);
        const target = list.find((p) => p.id === activeId);
        const next = list.filter((p) => p.id !== activeId);
        if (!saveUserPresets(currentFeature.id, next)) {
          toast('无法删除预设', true);
          return;
        }
        activePresetByFeature.delete(currentFeature.id);
        refreshPresetBar();
        toast(target ? `已删除预设「${target.name}」` : '已删除预设');
      };
    }

    if (savePresetBtn && saveRow && presetNameInput) {
      const closeSaveRow = () => {
        saveRow.classList.add('hidden');
        presetNameInput.value = '';
      };
      const commitSavePreset = () => {
        const name = presetNameInput.value.trim();
        if (!name) {
          toast('请输入预设名称', true);
          presetNameInput.focus();
          return;
        }
        const values = extractSavableValues(currentFeature);
        const existing = loadUserPresets(currentFeature.id);
        if (existing.some((p) => p.name === name)) {
          toast('此预设名称已存在', true);
          return;
        }
        if (existing.length >= 20) {
          toast('此工具已保存 20 个预设，请先删除一个', true);
          return;
        }
        const id = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const entry = { id, name, values, createdAt: Date.now() };
        if (!saveUserPresets(currentFeature.id, [entry, ...existing])) {
          toast('无法保存预设', true);
          return;
        }
        activePresetByFeature.set(currentFeature.id, id);
        closeSaveRow();
        refreshPresetBar();
        toast(`已保存预设「${name}」`);
      };
      savePresetBtn.onclick = () => {
        const opening = saveRow.classList.contains('hidden');
        saveRow.classList.toggle('hidden', !opening);
        if (opening) {
          presetNameInput.value = '';
          presetNameInput.focus();
        }
      };
      presetConfirmBtn?.addEventListener('click', commitSavePreset);
      presetCancelBtn?.addEventListener('click', closeSaveRow);
      presetNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          commitSavePreset();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeSaveRow();
        }
      });
    }

    if (paramsToWfBtn) {
      paramsToWfBtn.onclick = () => {
        const fv = collectFieldValues();
        if ($('t-start')) fv.tStart = parseFloat($('t-start').value) || 0;
        if ($('t-end')) fv.tEnd = parseFloat($('t-end').value) || 0;
        if (window.__crop) fv.crop = { ...window.__crop };
        if (Array.isArray(window.__segments) && window.__segments.length) {
          fv.segments = window.__segments.map((s) => ({ ...s }));
        }
        appCtx.onSendFeatureToWorkflow?.(currentFeature, fv);
      };
    }

    const resetBtn = box.querySelector('#btn-reset-params');
    if (resetBtn) {
      resetBtn.onclick = () => {
        activePresetByFeature.delete(currentFeature.id);
        localStorage.removeItem(`vgt_params_${currentFeature.id}`);
        renderParams();
        if (file?.info) prefillTimes(file.info);
        toast('已恢复默认参数');
      };
    }

    box.querySelectorAll('select[data-key]').forEach((sel) => {
      sel.onchange = () => { syncVisibility(); persist(); };
    });
    box.querySelectorAll('input[type="text"][data-key]').forEach((inp) => {
      inp.addEventListener('input', persist);
    });

    box.querySelectorAll('.chip-row[data-key]').forEach((row) => {
      const fieldDef = currentFeature.fields.find((f) => f.key === row.dataset.key);
      row.querySelectorAll('.chip').forEach((chip) => {
        chip.onclick = () => {
          row.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
          chip.classList.add('on');
          const presetValues = fieldDef?.applyPresets?.[chip.dataset.val];
          if (presetValues) {
            for (const [k, val] of Object.entries(presetValues)) {
              const targetEl = box.querySelector(`[data-key="${k}"]`);
              if (!targetEl) continue;
              if (targetEl.classList.contains('chip-row')) {
                targetEl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.val === val));
              } else {
                targetEl.value = val;
                targetEl.dispatchEvent(new Event('input'));
              }
            }
          }
          syncVisibility();
          persist();
        };
      });
    });

    box.querySelectorAll('input[type="range"][data-key]').forEach((range) => {
      const unit = range.dataset.unit ?? '';
      const valEl = box.querySelector(`.range-val[data-range-key="${range.dataset.key}"]`);
      const updateLabel = () => { if (valEl) valEl.textContent = `${range.value}${unit}`; persist(); };
      range.oninput = updateLabel;
      range.closest('.field').querySelectorAll('.chip.preset').forEach((chip) => {
        chip.onclick = () => {
          range.value = chip.dataset.val;
          updateLabel();
        };
      });
    });

    box.querySelectorAll('input[type="color"][data-key]').forEach((picker) => {
      const fieldWrap = picker.closest('.field');
      const chips = fieldWrap?.querySelectorAll('.chip.preset');
      const syncColorChips = () => {
        const cur = picker.value.toLowerCase();
        chips?.forEach((c) => c.classList.toggle('on', c.dataset.val.toLowerCase() === cur));
      };
      picker.addEventListener('input', () => { syncColorChips(); persist(); });
      chips?.forEach((chip) => {
        chip.onclick = () => {
          picker.value = chip.dataset.val;
          syncColorChips();
          persist();
        };
      });
      syncColorChips();

      const eyeBtn = fieldWrap?.querySelector(`[data-eye-key="${picker.dataset.key}"]`);
      const eyeBox = fieldWrap?.querySelector(`#eyedropper-box-${picker.dataset.key}`);
      if (eyeBtn && eyeBox && file) {
        eyeBtn.onclick = async () => {
          const opening = eyeBox.classList.contains('hidden');
          eyeBox.classList.toggle('hidden');
          if (!opening || eyeBox.dataset.loaded) return;
          eyeBox.innerHTML = '<div class="muted" style="font-size:12px">正在加载画面…</div>';
          const v = document.querySelector('#preview-box video');
          const t = file.info?.isImage
            ? 0
            : (v ? round1(v.currentTime || 0) : Math.min(0.5, round1((file.info.duration || 0) / 2)));
          const dataUrl = await window.api.firstFrame(file.path, t);
          if (!dataUrl) {
            eyeBox.innerHTML = '<div class="muted" style="font-size:12px">无法提取画面</div>';
            return;
          }
          const img = new Image();
          img.onload = () => {
            eyeBox.innerHTML = '<div class="muted" style="font-size:11.5px;margin-bottom:6px">点击画面任意位置即可吸取背景颜色：</div><canvas class="eyedropper-canvas"></canvas>';
            const c = eyeBox.querySelector('canvas');
            c.width = img.width;
            c.height = img.height;
            const cctx = c.getContext('2d');
            cctx.drawImage(img, 0, 0);
            eyeBox.dataset.loaded = '1';
            c.onclick = (e) => {
              const r = c.getBoundingClientRect();
              const px = Math.min(c.width - 1, Math.max(0, Math.floor((e.clientX - r.left) * (c.width / r.width))));
              const py = Math.min(c.height - 1, Math.max(0, Math.floor((e.clientY - r.top) * (c.height / r.height))));
              const [red, green, blue] = cctx.getImageData(px, py, 1, 1).data;
              const hex = '#' + [red, green, blue].map((x) => x.toString(16).padStart(2, '0')).join('');
              picker.value = hex;
              syncColorChips();
              persist();
              toast(`已吸取颜色 ${hex}`);
            };
          };
          img.src = dataUrl;
        };
      }
    });

    box.querySelectorAll('input[type="number"][data-key]').forEach((input) => {
      const fieldWrap = input.closest('.field');
      const chips = fieldWrap?.querySelectorAll('.chip.preset');
      const syncChips = () => {
        chips?.forEach((c) => c.classList.toggle('on', parseFloat(c.dataset.val) === parseFloat(input.value)));
        persist();
      };
      input.addEventListener('input', syncChips);
      chips?.forEach((chip) => {
        chip.onclick = () => {
          input.value = chip.dataset.val;
          syncChips();
        };
      });
    });

    const gifScrubRange = box.querySelector('#gif-scrub-range');
    const getVidTime = () => {
      const v = document.querySelector('#preview-box video, #preview-box audio');
      if (v) return round1(v.currentTime || 0);
      if (gifScrubRange) return round1(parseFloat(gifScrubRange.value) || 0);
      return 0;
    };
    if (gifScrubRange && file) {
      const scrubTimeEl = box.querySelector('#gif-scrub-time');
      const scrubImg = box.querySelector('#gif-scrub-img');
      const scrubTip = box.querySelector('#gif-scrub-tip');
      const dur = file.info?.duration || 0;
      let scrubTimer = null;
      let scrubReqId = 0;
      const loadGifFrame = async (tSec) => {
        const reqId = ++scrubReqId;
        const safeT = Math.min(Math.max(0, tSec), Math.max(0, dur - 0.05));
        const dataUrl = await window.api.firstFrame(file.path, safeT);
        if (reqId !== scrubReqId || !dataUrl || !scrubImg) return;
        scrubImg.src = dataUrl;
        scrubImg.classList.remove('hidden');
        if (scrubTip) scrubTip.classList.add('hidden');
      };
      gifScrubRange.oninput = () => {
        const t = round1(parseFloat(gifScrubRange.value) || 0);
        if (scrubTimeEl) scrubTimeEl.textContent = `${t}s`;
        clearTimeout(scrubTimer);
        scrubTimer = setTimeout(() => loadGifFrame(t), 120);
      };
      if (currentFeature.id === 'trimGif') {
        loadGifFrame(0);
      }
    }
    const pickStart = box.querySelector('#pick-t-start');
    const pickEnd = box.querySelector('#pick-t-end');
    if (pickStart) {
      pickStart.onclick = () => {
        const t = getVidTime();
        $('t-start').value = t;
        if (parseFloat($('t-end').value) <= t && file?.info.duration) $('t-end').value = round1(file.info.duration);
      };
    }
    if (pickEnd) {
      pickEnd.onclick = () => {
        const t = getVidTime();
        $('t-end').value = t;
        if (parseFloat($('t-start').value) >= t) $('t-start').value = 0;
      };
    }
    const pickVideoTime = box.querySelector('#pick-video-time');
    if (pickVideoTime) {
      pickVideoTime.onclick = () => {
        const input = pickVideoTime.closest('.field')?.querySelector('input[type="number"]');
        if (input) { input.value = getVidTime(); input.dispatchEvent(new Event('input')); }
      };
    }

    const segListEl = box.querySelector('#seg-list');
    if (segListEl) {
      const dur = file?.info.duration || 0;
      if (!window.__segments.length) {
        window.__segments = [{ start: 0, end: dur > 0 ? round1(Math.min(dur, 5)) : 5 }];
      }

      const renderSegs = () => {
        segListEl.innerHTML = '';
        window.__segments.forEach((seg, idx) => {
          const row = document.createElement('div');
          row.className = 'seg-row';
          row.innerHTML = `
            <span class="seg-idx">片段 #${idx + 1}</span>
            <input type="number" class="seg-start" value="${seg.start}" min="0" step="0.1" />
            <span class="times-sep">→</span>
            <input type="number" class="seg-end" value="${seg.end}" min="0" step="0.1" />
            ${hasVideo ? '<button class="batch-btn seg-pick-s" title="用当前播放时间设为起点">⏮</button><button class="batch-btn seg-pick-e" title="用当前播放时间设为终点">⏭</button>' : ''}
            ${window.__segments.length > 1 ? '<button class="batch-btn seg-rm" title="删除该段">✕</button>' : ''}
          `;
          const sIn = row.querySelector('.seg-start');
          const eIn = row.querySelector('.seg-end');
          sIn.oninput = () => { seg.start = parseFloat(sIn.value) || 0; };
          eIn.oninput = () => { seg.end = parseFloat(eIn.value) || 0; };
          const ps = row.querySelector('.seg-pick-s');
          const pe = row.querySelector('.seg-pick-e');
          if (ps) ps.onclick = () => { const t = getVidTime(); seg.start = t; sIn.value = t; };
          if (pe) pe.onclick = () => { const t = getVidTime(); seg.end = t; eIn.value = t; };
          const rm = row.querySelector('.seg-rm');
          if (rm) rm.onclick = () => { window.__segments.splice(idx, 1); renderSegs(); };
          segListEl.appendChild(row);
        });
      };

      renderSegs();
      box.querySelector('#seg-add').onclick = () => {
        const last = window.__segments[window.__segments.length - 1];
        const nextStart = last ? round1(last.end) : 0;
        const nextEnd = dur > 0 ? round1(Math.min(dur, nextStart + 5)) : round1(nextStart + 5);
        window.__segments.push({ start: nextStart, end: Math.max(nextEnd, round1(nextStart + 1)) });
        renderSegs();
      };
    }

    const pickSecond = box.querySelector('#pick-second');
    if (pickSecond) {
      pickSecond.onclick = async () => {
        const kind = pickSecond.dataset.kind || 'audioFile';
        const p = await window.api.pickFile(currentFeature.id, kind);
        if (p) {
          window.__secondFile = p;
          window.__secondInfo = null;
          const name = $('second-name');
          name.textContent = p.split(/[\\/]/).pop();
          name.title = p;
          name.classList.remove('muted');
          if (kind === 'videoGifFile') {
            const res = await window.api.probe(p);
            if (res.ok) window.__secondInfo = res.info;
          }
        }
      };
    }

    const pickReplaceDir = box.querySelector('#pick-replace-dir');
    if (pickReplaceDir) {
      pickReplaceDir.onclick = async () => {
        const dir = await window.api.pickDir();
        if (!dir) return;
        window.__secondFile = { dir, files: [] };
        const name = $('second-name');
        name.textContent = `已选文件夹：${dir}`;
        name.title = dir;
        name.classList.remove('muted');
      };
    }

    const pickReplaceFiles = box.querySelector('#pick-replace-files');
    if (pickReplaceFiles) {
      pickReplaceFiles.onclick = async () => {
        const picked = await window.api.pickFile(currentFeature.id, 'replaceImageFiles');
        const list = Array.isArray(picked) ? picked : (picked ? [picked] : []);
        if (!list.length) return;
        window.__secondFile = { dir: '', files: list };
        const name = $('second-name');
        name.textContent = `已选 ${list.length} 张替换图片（${list.map((p) => p.split(/[\\/]/).pop()).slice(0, 3).join('、')}${list.length > 3 ? '…' : ''}）`;
        name.title = list.join('\n');
        name.classList.remove('muted');
      };
    }

    const docSecBox = box.querySelector('#doc-sections-box');
    if (docSecBox && file?.info?.sections?.length) {
      const sections = file.info.sections;
      const childrenMap = new Map();
      for (const s of sections) {
        if (!s.parentId) continue;
        if (!childrenMap.has(s.parentId)) childrenMap.set(s.parentId, []);
        childrenMap.get(s.parentId).push(s.id);
      }
      const getDescendantIds = (rootId) => {
        const res = [];
        const queue = [...(childrenMap.get(rootId) || [])];
        while (queue.length) {
          const cid = queue.shift();
          res.push(cid);
          const sub = childrenMap.get(cid);
          if (sub?.length) queue.push(...sub);
        }
        return res;
      };

      const checkEls = new Map();
      const rowEls = new Map();
      docSecBox.querySelectorAll('.doc-sec-check').forEach((cb) => {
        checkEls.set(cb.dataset.secId, cb);
      });
      docSecBox.querySelectorAll('.doc-sec-item').forEach((row) => {
        rowEls.set(row.dataset.secRow, row);
      });

      const summaryEl = docSecBox.querySelector('#doc-sec-summary');
      const cascadeEl = docSecBox.querySelector('#doc-sec-cascade');
      const searchEl = docSecBox.querySelector('#doc-sec-search');

      const actionWord = docSecBox.dataset.actionWord || '提取';
      const unitWord = actionWord === '压缩' ? '项媒体' : '张图';
      const syncDocSections = () => {
        const selected = [];
        let imgEst = 0;
        for (const s of sections) {
          if (checkEls.get(s.id)?.checked) {
            selected.push(s.id);
            imgEst += s.directImageCount || 0;
          }
        }
        window.__docSelectedSectionIds = selected;
        if (summaryEl) {
          summaryEl.textContent = selected.length
            ? `已选 ${selected.length} / ${sections.length} 项（预计${actionWord} ${imgEst} ${unitWord}）`
            : `⚠️ 尚未选择任何章节（共 ${sections.length} 项）`;
          summaryEl.classList.toggle('is-warn', selected.length === 0);
        }
      };

      checkEls.forEach((cb, secId) => {
        cb.onchange = () => {
          if (cascadeEl?.checked) {
            const desc = getDescendantIds(secId);
            for (const dId of desc) {
              const dCb = checkEls.get(dId);
              if (dCb) dCb.checked = cb.checked;
            }
          }
          syncDocSections();
        };
      });

      const isVisibleRow = (secId) => {
        const r = rowEls.get(secId);
        return r && !r.classList.contains('hidden');
      };

      docSecBox.querySelector('#doc-sec-all').onclick = () => {
        for (const s of sections) {
          if (isVisibleRow(s.id)) {
            const cb = checkEls.get(s.id);
            if (cb) cb.checked = true;
          }
        }
        syncDocSections();
      };
      docSecBox.querySelector('#doc-sec-with-img').onclick = () => {
        for (const s of sections) {
          if (isVisibleRow(s.id)) {
            const cb = checkEls.get(s.id);
            if (cb) cb.checked = (s.directImageCount || 0) > 0;
          }
        }
        syncDocSections();
      };
      docSecBox.querySelector('#doc-sec-none').onclick = () => {
        const hasFilter = !!(searchEl?.value || '').trim();
        for (const s of sections) {
          if (!hasFilter || isVisibleRow(s.id)) {
            const cb = checkEls.get(s.id);
            if (cb) cb.checked = false;
          }
        }
        syncDocSections();
      };
      if (searchEl) {
        searchEl.oninput = () => {
          const q = searchEl.value.trim().toLowerCase();
          for (const s of sections) {
            const row = rowEls.get(s.id);
            if (row) row.classList.toggle('hidden', !!q && !s.title.toLowerCase().includes(q));
          }
        };
      }
      syncDocSections();
    }

    if (box.querySelector('#crop-canvas')) {
      window.VGT.initCropCanvas({ $, getFile, getCurrentFeature });
    }

    syncVisibility();
  }

  return { renderParams, syncVisibility };
}

window.VGT.params = {
  readChips,
  collectFieldValues,
  createParamsController,
  round1,
  readTimes(targetFile) {
    const start = parseFloat(document.getElementById('t-start')?.value) || 0;
    let end = parseFloat(document.getElementById('t-end')?.value) || 0;
    const dur = targetFile?.info.duration || 0;
    if (end <= start) end = dur || start + 1;
    return { start, end, duration: Math.max(end - start, 0.1) };
  },
};
})();
