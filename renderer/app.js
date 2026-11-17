'use strict';

const IMG_EXTS = window.VGT.IMG_EXTS;
const FEATURES = [
  ...window.VGT.VIDEO_FEATURES,
  ...window.VGT.IMAGE_FEATURES,
  ...(window.VGT.SVG_FEATURES || []),
  ...(window.VGT.DOC_FEATURES || []),
];
const GROUP_ORDER = ['转换', 'GIF 编辑', '图片', 'SVG', '文档', '剪辑', '音频', '工具'];

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let currentFeature = FEATURES[0];
let appMode = 'single'; // 'single' | 'workflow'
let wfController = null;
let wfTaskProgressCb = null;
let file = null;
let files = null;
let batchFiles = null;
let batchRunningIndex = -1;
let batchAborted = false;
let running = false;
let currentTaskId = null;

window.__crop = null;
window.__secondFile = null;
window.__secondInfo = null;
window.__segments = [];

let prefOutputMode = localStorage.getItem('vgt_out_mode') || 'same';
let prefOutputDir = localStorage.getItem('vgt_out_dir') || '';
let prefHwAccel = localStorage.getItem('vgt_hw') || 'cpu';
let prefNoOverwrite = localStorage.getItem('vgt_no_overwrite') !== '0';
let navSearchQuery = '';
let favFeatureIds = (() => {
  try { return JSON.parse(localStorage.getItem('vgt_favs') || '[]'); } catch { return []; }
})();
if (prefOutputMode === 'custom' && !prefOutputDir) prefOutputMode = 'same';

function withGlobalPrefs(params, extra = {}) {
  return {
    ...params,
    __outputMode: prefOutputMode,
    __outputDir: prefOutputMode === 'custom' ? prefOutputDir : '',
    __hwAccel: prefHwAccel,
    __noOverwrite: prefNoOverwrite,
    ...extra,
  };
}

const $ = (id) => document.getElementById(id);
const round1 = window.VGT.params.round1;
const collectFieldValues = window.VGT.params.collectFieldValues;

const paramsCtrl = window.VGT.params.createParamsController({
  $,
  getCurrentFeature: () => currentFeature,
  getFile: () => file,
  getBatchFiles: () => batchFiles,
  toast,
  prefillTimes,
});

function renderParams() {
  paramsCtrl.renderParams();
}

// ---------------------------------------------------------------------------
// 侧栏导航（搜索 + 常用置顶 + 按组渲染）
// ---------------------------------------------------------------------------

function saveFavs() {
  localStorage.setItem('vgt_favs', JSON.stringify(favFeatureIds));
}

function makeNavItem(f) {
  const btn = document.createElement('button');
  btn.className = 'nav-item' + (f === currentFeature ? ' active' : '');
  btn.dataset.id = f.id;
  const isFav = favFeatureIds.includes(f.id);
  btn.innerHTML = `<span class="nav-icon">${f.icon}</span><span class="nav-name">${f.name}</span><span class="nav-fav${isFav ? ' on' : ''}" title="${isFav ? '取消置顶' : '置顶到常用'}">${isFav ? '★' : '☆'}</span>`;
  btn.onclick = (e) => {
    if (e.target.classList.contains('nav-fav')) {
      e.stopPropagation();
      if (favFeatureIds.includes(f.id)) favFeatureIds = favFeatureIds.filter((id) => id !== f.id);
      else favFeatureIds = [...favFeatureIds, f.id];
      saveFavs();
      renderNav();
      return;
    }
    if (running) return toast('有任务正在进行中', true);
    selectFeature(f);
  };
  return btn;
}

function renderNav() {
  const nav = $('nav');
  if (appMode === 'workflow' && wfController) {
    wfController.renderSidebarPalette(nav, navSearchQuery);
    return;
  }
  nav.innerHTML = '';
  const q = navSearchQuery.trim().toLowerCase();
  const match = (f) => !q
    || f.name.toLowerCase().includes(q)
    || f.desc.toLowerCase().includes(q)
    || f.group.toLowerCase().includes(q)
    || f.id.toLowerCase().includes(q);

  let totalShown = 0;

  if (!q && favFeatureIds.length) {
    const favItems = favFeatureIds.map((id) => FEATURES.find((x) => x.id === id)).filter(Boolean);
    if (favItems.length) {
      const label = document.createElement('div');
      label.className = 'nav-group';
      label.textContent = '⭐ 常用';
      nav.appendChild(label);
      favItems.forEach((f) => { nav.appendChild(makeNavItem(f)); totalShown++; });
    }
  }

  for (const g of GROUP_ORDER) {
    const items = FEATURES.filter((x) => x.group === g && match(x));
    if (!items.length) continue;
    const label = document.createElement('div');
    label.className = 'nav-group';
    label.textContent = g;
    nav.appendChild(label);
    for (const f of items) {
      nav.appendChild(makeNavItem(f));
      totalShown++;
    }
  }

  if (!totalShown) {
    const empty = document.createElement('div');
    empty.className = 'nav-empty';
    empty.textContent = '没有匹配的功能';
    nav.appendChild(empty);
  }
}

function updateFeatureHint(f) {
  const extsText = f.accept.map((e) => e.toUpperCase()).join(' / ');
  if (f.multi) {
    $('dz-hint').textContent = `支持多选，可一次拖入多个文件拼接/合并（${extsText}）`;
  } else if (f.noBatch) {
    $('dz-hint').textContent = `支持格式：${extsText}（需交互标记，仅支持单文件）`;
  } else {
    $('dz-hint').textContent = `支持单文件，也可多选或拖入多个文件批量处理（${extsText}）`;
  }
}

function selectFeature(f, { forceClear = false } = {}) {
  const prevFeature = currentFeature;
  currentFeature = f;
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.id === f.id));
  $('feature-title').textContent = f.name;
  $('feature-desc').textContent = f.desc;
  updateFeatureHint(f);

  if (forceClear || f === prevFeature) {
    if (forceClear) clearFile();
    return;
  }

  if (file && !f.multi) {
    const ext = file.path.split('.').pop().toLowerCase();
    if (f.accept.includes(ext)) {
      $('btn-add-more').classList.toggle('hidden', !!f.noBatch);
      $('btn-replace').textContent = '换一个文件';
      $('result-card').classList.add('hidden');
      $('btn-run').textContent = '开始转换';
      renderParams();
      prefillTimes(file.info);
      toast('已保留当前文件');
      return;
    }
  }

  if (batchFiles?.length && !f.multi && !f.noBatch) {
    const allOk = batchFiles.every((b) => f.accept.includes(b.path.split('.').pop().toLowerCase()));
    if (allOk) {
      batchFiles.forEach((b) => { b.status = 'pending'; b.progress = 0; b.output = null; b.error = null; });
      $('result-card').classList.add('hidden');
      renderBatchHeader();
      renderBatchList();
      renderParams();
      $('btn-run').textContent = `开始批量处理 (${batchFiles.length})`;
      toast('已保留当前批量队列');
      return;
    }
  }

  clearFile();
}

// ---------------------------------------------------------------------------
// 文件选择与预览
// ---------------------------------------------------------------------------

async function useFile(p) {
  return useFiles([p]);
}

async function useFiles(paths, append = false) {
  if (!paths?.length) return;

  const valid = [];
  const skipped = [];
  for (const p of paths) {
    const ext = p.split('.').pop().toLowerCase();
    if (currentFeature.accept.includes(ext)) valid.push(p);
    else skipped.push(ext);
  }
  if (!valid.length) {
    return toast(`该功能不支持 .${skipped[0]} 文件`, true);
  }
  if (skipped.length) {
    toast(`已跳过 ${skipped.length} 个不支持的文件`, true);
  }

  if (currentFeature.multi) {
    const prevPaths = append && files?.length ? files.map((f) => f.path) : [];
    const seen = new Set(prevPaths);
    const toAdd = append ? valid.filter((p) => !seen.has(p)) : valid;
    if (append && !toAdd.length) return toast('所选文件已在列表中');

    const infos = await window.api.probeMulti(toAdd);
    if (infos.some((i) => !i.info)) return toast('部分文件无法读取，请检查格式', true);
    files = append ? [...(files || []), ...infos] : infos;
    file = null;
    batchFiles = null;
    $('btn-zoom-preview').classList.add('hidden');
    $('file-card').classList.remove('preview-large');
    $('btn-add-more').classList.remove('hidden');
    $('btn-replace').textContent = '重选文件';
    renderMultiCard();
    if (!append) renderParams();
    $('action-bar').classList.remove('hidden');
    $('result-card').classList.add('hidden');
    $('btn-run').textContent = '开始转换';
    return;
  }

  if (currentFeature.noBatch) {
    if (valid.length > 1) toast('该功能需交互标记，已选取第一个文件', true);
    const res = await window.api.probe(valid[0]);
    if (!res.ok) return toast(res.error, true);
    file = { path: valid[0], info: res.info };
    files = null;
    batchFiles = null;
    $('batch-list').classList.add('hidden');
    $('btn-add-more').classList.add('hidden');
    $('btn-replace').textContent = '换一个文件';
    renderFileCard(valid[0].split('.').pop().toLowerCase());
    renderParams();
    $('action-bar').classList.remove('hidden');
    $('result-card').classList.add('hidden');
    $('btn-run').textContent = '开始转换';
    prefillTimes(res.info);
    return;
  }

  const wasSingle = !!file && !batchFiles;
  const wasBatch = !!batchFiles?.length;
  const existingPaths = append
    ? (batchFiles ? batchFiles.map((b) => b.path) : (file ? [file.path] : []))
    : [];
  const seen = new Set(existingPaths);
  const targetPaths = append ? valid.filter((p) => !seen.has(p)) : valid;
  if (append && !targetPaths.length) return toast('所选文件已在队列中');

  const totalCount = existingPaths.length + targetPaths.length;

  if (totalCount === 1) {
    const singlePath = targetPaths[0];
    const res = await window.api.probe(singlePath);
    if (!res.ok) return toast(res.error, true);
    file = { path: singlePath, info: res.info };
    files = null;
    batchFiles = null;
    $('batch-list').classList.add('hidden');
    $('batch-list').innerHTML = '';
    $('btn-add-more').classList.remove('hidden');
    $('btn-replace').textContent = '换一个文件';
    renderFileCard(singlePath.split('.').pop().toLowerCase());
    renderParams();
    $('action-bar').classList.remove('hidden');
    $('result-card').classList.add('hidden');
    $('btn-run').textContent = '开始转换';
    prefillTimes(res.info);
    return;
  }

  const newProbes = await window.api.probeMulti(targetPaths);
  const badCount = newProbes.filter((i) => !i.info).length;
  const readable = newProbes.filter((i) => i.info);
  if (!readable.length) return toast('所选文件无法读取，请检查格式', true);
  if (badCount) toast(`已忽略 ${badCount} 个无法读取的文件`, true);

  let prevItems = [];
  if (append) {
    if (batchFiles?.length) prevItems = batchFiles;
    else if (file) prevItems = [{ path: file.path, info: file.info, status: 'pending', progress: 0 }];
  }
  const combined = [
    ...prevItems,
    ...readable.map((i) => ({ path: i.path, info: i.info, status: 'pending', progress: 0 })),
  ];

  if (combined.length === 1) {
    return useFiles([combined[0].path]);
  }

  file = null;
  files = null;
  batchFiles = combined;
  $('btn-zoom-preview').classList.add('hidden');
  $('file-card').classList.remove('preview-large');
  $('btn-add-more').classList.remove('hidden');
  $('btn-replace').textContent = '重选文件';
  renderBatchHeader();
  renderBatchList();
  if (!append || wasSingle || !wasBatch) {
    renderParams();
  }
  $('action-bar').classList.remove('hidden');
  $('result-card').classList.add('hidden');
  $('btn-run').textContent = `开始批量处理 (${batchFiles.length})`;
}

function prefillTimes(info) {
  const tEnd = $('t-end');
  if (tEnd && info.duration > 0) {
    $('t-start').value = 0;
    tEnd.value = round1(Math.min(info.duration, 10));
    const chips = $('times-chips');
    if (chips) {
      chips.innerHTML = '';
      const mk = (label, s, e) => {
        const b = document.createElement('button');
        b.className = 'chip';
        b.textContent = label;
        b.onclick = () => { $('t-start').value = s; tEnd.value = e; };
        return b;
      };
      chips.appendChild(mk('整段', 0, round1(info.duration)));
      if (info.duration > 1.5 && info.duration <= 10) {
        const mid = round1(info.duration / 2);
        chips.appendChild(mk('前半段', 0, mid));
        chips.appendChild(mk('后半段', mid, round1(info.duration)));
      }
      if (info.duration > 5) chips.appendChild(mk('前 5 秒', 0, 5));
      if (info.duration > 10) chips.appendChild(mk('前 10 秒', 0, 10));
    }
  }
  if (info.nbFrames > 0) {
    const sf = document.querySelector('#params input[data-key="startFrame"]');
    const ef = document.querySelector('#params input[data-key="endFrame"]');
    if (sf) sf.max = String(info.nbFrames);
    if (ef) {
      ef.max = String(info.nbFrames);
      const lbl = ef.closest('.field')?.querySelector('label');
      if (lbl) lbl.textContent = `结束帧（含该帧，共 ${info.nbFrames} 帧）`;
      let hasSavedEf = false;
      try {
        const saved = JSON.parse(localStorage.getItem(`vgt_params_${currentFeature.id}`) || 'null');
        hasSavedEf = saved && saved.endFrame !== undefined;
      } catch {}
      if (!hasSavedEf) ef.value = String(info.nbFrames);
    }
  }
}

function renderFileCard(ext) {
  const info = file.info;
  const isDoc = !!info.isDoc;
  const isImg = !isDoc && (info.isImage || ext === 'svg' || IMG_EXTS.includes(ext));
  $('dropzone').classList.add('hidden');
  $('file-card').classList.remove('hidden');
  $('file-name').textContent = file.path.split(/[\\/]/).pop();
  $('file-name').title = file.path;

  const parts = [];
  if (isDoc) {
    parts.push(
      info.docType === 'docx'
        ? 'Word 文档 (.docx)'
        : (info.docType === 'pptx'
          ? 'PPT 演示文稿 (.pptx)'
          : (info.docType === 'pdf' ? 'PDF 文档 (.pdf)' : 'Markdown 文档')),
    );
    const st = info.docStats || {};
    if (info.docType === 'pdf') {
      parts.push(`共 ${info.pageCount || 0} 页`);
    } else if (info.docType === 'md' && info.imageCount > 0) {
      const sub = [];
      if (st.local) sub.push(`本地 ${st.local}`);
      if (st.dataUri) sub.push(`Base64 ${st.dataUri}`);
      if (st.inlineSvg) sub.push(`SVG ${st.inlineSvg}`);
      if (st.remote) sub.push(`网络 ${st.remote}`);
      if (st.missing) sub.push(`路径缺失 ${st.missing}`);
      parts.push(`识别到 ${info.imageCount} 处图片${sub.length ? `（${sub.join(' · ')}）` : ''}`);
    } else if (info.docType === 'pptx') {
      const extra = [];
      if (st.videoCount) extra.push(`视频 ${st.videoCount}`);
      if (st.audioCount) extra.push(`音频 ${st.audioCount}`);
      parts.push(`识别到 ${info.imageCount || 0} 张图片${extra.length ? ` · ${extra.join(' · ')}` : ''}`);
    } else {
      parts.push(`识别到 ${info.imageCount || 0} 张图片`);
    }
  } else {
    if (info.isSvg) parts.push('SVG 矢量图');
    if (info.width) parts.push(`分辨率 ${info.width}×${info.height}`);
    if (!isImg && info.duration > 0) parts.push(`时长 ${fmtDur(info.duration)}`);
    if (!isImg && info.fps > 0) parts.push(`${Math.round(info.fps)} fps`);
    if (ext === 'gif' && info.nbFrames > 0) parts.push(`${info.nbFrames} 帧`);
  }
  parts.push(`大小 ${fmtSize(info.size)}`);
  if (!isDoc && !isImg && !['mp3', 'm4a', 'wav', 'flac'].includes(ext)) {
    parts.push(info.hasAudio ? '含音轨' : '无音轨');
  }
  $('file-info').textContent = parts.join(' · ');

  const box = $('preview-box');
  box.innerHTML = '';
  box.style.display = '';
  const url = encodeURI('file:///' + file.path.replace(/\\/g, '/'));
  const zoomBtn = $('btn-zoom-preview');
  if (isDoc) {
    const icon = info.docType === 'docx' ? '📘' : (info.docType === 'pptx' ? '📊' : (info.docType === 'pdf' ? '📄' : '📝'));
    box.innerHTML = `<div class="no-preview">${icon}</div>`;
    zoomBtn.classList.add('hidden');
  } else if (ext === 'gif' || ext === 'webp' || ext === 'svg' || IMG_EXTS.includes(ext)) {
    box.innerHTML = `<img${ext === 'svg' ? ' class="is-svg"' : ''} src="${url}" alt="预览" />`;
    zoomBtn.classList.remove('hidden');
  } else if (['mp4', 'webm', 'mkv', 'mov', 'm4v'].includes(ext)) {
    box.innerHTML = `<video src="${url}" controls preload="metadata"></video>`;
    zoomBtn.classList.remove('hidden');
  } else {
    box.innerHTML = `<div class="no-preview">🎧</div>`;
    zoomBtn.classList.add('hidden');
  }
}

function renderMultiCard() {
  $('dropzone').classList.add('hidden');
  $('file-card').classList.remove('hidden');
  $('preview-box').style.display = 'none';
  $('btn-zoom-preview').classList.add('hidden');
  $('file-card').classList.remove('preview-large');

  const names = files.map((f) => f.path.split(/[\\/]/).pop());
  $('file-name').textContent = `已选 ${files.length} 个文件（可上下调整顺序）`;
  $('file-name').title = files.map((f) => f.path).join('\n');
  const totalSize = files.reduce((s, f) => s + (f.info?.size || 0), 0);
  const totalDur = files.reduce((s, f) => s + (f.info?.duration || 0), 0);
  const shown = names.slice(0, 4).join('、') + (names.length > 4 ? ` 等 ${names.length} 个` : '');
  $('file-info').textContent = `${shown} · 总大小 ${fmtSize(totalSize)}` + (totalDur > 0 ? ` · 总时长 ${fmtDur(totalDur)}` : '');

  const listEl = $('batch-list');
  listEl.classList.remove('hidden');
  listEl.innerHTML = '';
  files.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'batch-item';

    const nameEl = document.createElement('div');
    nameEl.className = 'batch-name';
    nameEl.textContent = `${idx + 1}. ${item.path.split(/[\\/]/).pop()}`;
    nameEl.title = item.path;
    row.appendChild(nameEl);

    const metaParts = [];
    if (item.info?.width) metaParts.push(`${item.info.width}×${item.info.height}`);
    if (item.info?.duration > 0) metaParts.push(fmtDur(item.info.duration));
    metaParts.push(fmtSize(item.info?.size));
    const metaEl = document.createElement('div');
    metaEl.className = 'batch-meta';
    metaEl.textContent = metaParts.join(' · ');
    row.appendChild(metaEl);

    const upBtn = document.createElement('button');
    upBtn.className = 'batch-btn';
    upBtn.textContent = '↑';
    upBtn.title = '上移';
    upBtn.disabled = idx === 0;
    upBtn.onclick = () => {
      if (running || idx === 0) return;
      [files[idx - 1], files[idx]] = [files[idx], files[idx - 1]];
      renderMultiCard();
    };
    row.appendChild(upBtn);

    const downBtn = document.createElement('button');
    downBtn.className = 'batch-btn';
    downBtn.textContent = '↓';
    downBtn.title = '下移';
    downBtn.disabled = idx === files.length - 1;
    downBtn.onclick = () => {
      if (running || idx === files.length - 1) return;
      [files[idx], files[idx + 1]] = [files[idx + 1], files[idx]];
      renderMultiCard();
    };
    row.appendChild(downBtn);

    const rmBtn = document.createElement('button');
    rmBtn.className = 'batch-btn';
    rmBtn.textContent = '✕';
    rmBtn.title = '移除';
    rmBtn.onclick = () => {
      if (running) return;
      const remaining = files.filter((_, j) => j !== idx);
      if (!remaining.length) return clearFile();
      files = remaining;
      renderMultiCard();
    };
    row.appendChild(rmBtn);

    listEl.appendChild(row);
  });
}

function outModeText() {
  if (prefOutputMode === 'subdir') return 'output 子目录';
  if (prefOutputMode === 'custom' && prefOutputDir) return `自定义目录 (${prefOutputDir.split(/[\\/]/).pop() || prefOutputDir})`;
  return '各源文件同目录';
}

function renderBatchHeader() {
  $('dropzone').classList.add('hidden');
  $('file-card').classList.remove('hidden');
  $('preview-box').style.display = 'none';
  $('file-name').textContent = `批量队列 · ${batchFiles.length} 个文件`;
  $('file-name').title = batchFiles.map((f) => f.path).join('\n');
  const totalSize = batchFiles.reduce((s, f) => s + (f.info?.size || 0), 0);
  const totalDur = batchFiles.reduce((s, f) => s + (f.info?.duration || 0), 0);
  $('file-info').textContent = `顺序处理 · 总大小 ${fmtSize(totalSize)}`
    + (totalDur > 0 ? ` · 总时长 ${fmtDur(totalDur)}` : '')
    + ` · 输出保存至${outModeText()}`;
}

function renderBatchList() {
  const listEl = $('batch-list');
  if (!batchFiles?.length) {
    listEl.classList.add('hidden');
    listEl.innerHTML = '';
    return;
  }
  listEl.classList.remove('hidden');
  listEl.innerHTML = '';

  const showPctIds = new Set(['compressGif', 'imageConvert', 'imageCompressTarget', 'compressTarget', 'svgOptimize', 'imageToSvg', 'docCompressImages', 'docRepackImages', 'docCleanupMedia']);

  batchFiles.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'batch-item';
    row.dataset.idx = String(idx);

    const nameEl = document.createElement('div');
    nameEl.className = 'batch-name';
    nameEl.textContent = `${idx + 1}. ${item.path.split(/[\\/]/).pop()}`;
    nameEl.title = item.path;
    row.appendChild(nameEl);

    const metaParts = [];
    if (item.info?.isDoc) metaParts.push(`${item.info.imageCount || 0} 张图`);
    if (item.info?.width) metaParts.push(`${item.info.width}×${item.info.height}`);
    if (item.info?.duration > 0) metaParts.push(fmtDur(item.info.duration));
    metaParts.push(fmtSize(item.info?.size));
    const metaEl = document.createElement('div');
    metaEl.className = 'batch-meta';
    metaEl.textContent = metaParts.join(' · ');
    row.appendChild(metaEl);

    const statusEl = document.createElement('div');
    statusEl.className = 'batch-status';
    if (item.status === 'running') {
      statusEl.classList.add('run');
      statusEl.textContent = `处理中 ${Math.round((item.progress || 0) * 100)}%`;
    } else if (item.status === 'done') {
      statusEl.classList.add('ok');
      if (item.outputType === 'dir') {
        statusEl.textContent = item.extractSummary
          ? `✅ 提取 ${item.extractSummary.savedCount} 张图`
          : '✅ 已导出';
      } else if (showPctIds.has(currentFeature.id) && item.info?.size && item.outSize) {
        const pct = Math.round((1 - item.outSize / item.info.size) * 100);
        statusEl.textContent = pct > 0
          ? `✅ ${fmtSize(item.outSize)} (-${pct}%)`
          : `✅ ${fmtSize(item.outSize)}`;
      } else {
        statusEl.textContent = `✅ ${fmtSize(item.outSize)}`;
      }
      statusEl.title = item.output || '';
    } else if (item.status === 'error') {
      statusEl.classList.add('err');
      statusEl.textContent = '❌ 失败';
      statusEl.title = item.error || '处理失败';
    } else if (item.status === 'cancelled') {
      statusEl.classList.add('err');
      statusEl.textContent = '已取消';
    } else {
      statusEl.textContent = '待处理';
    }
    row.appendChild(statusEl);

    if (item.status === 'done' && item.output) {
      const locBtn = document.createElement('button');
      locBtn.className = 'batch-btn';
      locBtn.textContent = '定位';
      locBtn.onclick = () =>
        item.outputType === 'dir' ? window.api.openFolder(item.output) : window.api.showInFolder(item.output);
      row.appendChild(locBtn);
    } else if (!running) {
      const rmBtn = document.createElement('button');
      rmBtn.className = 'batch-btn';
      rmBtn.textContent = '✕';
      rmBtn.title = '从队列移除';
      rmBtn.onclick = () => {
        if (running) return;
        const remaining = batchFiles.filter((_, j) => j !== idx);
        if (!remaining.length) return clearFile();
        if (remaining.length === 1) return useFiles([remaining[0].path]);
        batchFiles = remaining;
        renderBatchHeader();
        renderBatchList();
        $('btn-run').textContent = `开始批量处理 (${batchFiles.length})`;
      };
      row.appendChild(rmBtn);
    }

    listEl.appendChild(row);
  });
}

function clearFile() {
  file = null;
  files = null;
  batchFiles = null;
  batchRunningIndex = -1;
  batchAborted = false;
  window.__crop = null;
  window.__secondFile = null;
  window.__secondInfo = null;
  window.__segments = [];
  $('file-card').classList.add('hidden');
  $('file-card').classList.remove('preview-large');
  $('btn-zoom-preview').classList.add('hidden');
  $('btn-zoom-preview').textContent = '⛶ 放大预览';
  $('batch-list').classList.add('hidden');
  $('batch-list').innerHTML = '';
  $('btn-add-more').classList.add('hidden');
  $('btn-replace').textContent = '换一个文件';
  $('params').classList.add('hidden');
  $('action-bar').classList.add('hidden');
  $('result-card').classList.add('hidden');
  $('dropzone').classList.remove('hidden');
  $('preview-box').style.display = '';
  $('btn-run').textContent = '开始转换';
}

// ---------------------------------------------------------------------------
// 执行任务
// ---------------------------------------------------------------------------

let taskStartTime = 0;

function fmtEta(ratio) {
  if (!taskStartTime || ratio < 0.03 || ratio >= 0.99) return '';
  const elapsed = (Date.now() - taskStartTime) / 1000;
  if (elapsed < 1.5) return '';
  const rem = Math.max(1, Math.round((elapsed * (1 - ratio)) / ratio));
  return ` · 预计剩余 ${fmtDur(rem)}`;
}

async function runTask() {
  if (running) return;
  if (batchFiles?.length) return runBatchTask();

  const ctx = currentFeature.multi ? { files } : { file };
  if (currentFeature.multi ? !files?.length : !file) return;
  let params;
  try {
    params = withGlobalPrefs(await currentFeature.collect(collectFieldValues(), ctx));
  } catch (err) {
    return toast(err.message, true);
  }
  taskStartTime = Date.now();
  setRunning(true);
  $('result-card').classList.add('hidden');
  setProgress(0, '处理中…');

  const res = await window.api.startTask(currentFeature.id, params);
  setRunning(false);

  if (res.ok) {
    window.api.notifyDone('处理完成', `${currentFeature.name}：${res.output.split(/[\\/]/).pop()}`);
    await showSuccess(res);
  } else if (!res.cancelled) {
    showResult('err', `❌ 转换失败\n${escHtml(res.error)}`);
  }
}

async function runBatchTask() {
  const fieldValues = collectFieldValues();
  try {
    await currentFeature.collect(fieldValues, { file: batchFiles[0] });
  } catch (err) {
    return toast(err.message, true);
  }

  for (const item of batchFiles) {
    item.status = 'pending';
    item.progress = 0;
    item.output = null;
    item.outputType = null;
    item.outSize = 0;
    item.error = null;
  }

  batchAborted = false;
  batchRunningIndex = 0;
  taskStartTime = Date.now();
  setRunning(true);
  $('result-card').classList.add('hidden');
  renderBatchList();

  try {
    for (let i = 0; i < batchFiles.length; i++) {
      if (batchAborted) {
        batchFiles[i].status = 'cancelled';
        continue;
      }
      batchRunningIndex = i;
      const item = batchFiles[i];
      item.status = 'running';
      item.progress = 0;
      renderBatchList();

      const name = item.path.split(/[\\/]/).pop();
      window.api.setProgressBar(i / batchFiles.length);
      setProgress(i / batchFiles.length, `批量处理 (${i + 1}/${batchFiles.length}) 0% · ${name}${fmtEta(i / batchFiles.length)}`);

      let itemParams;
      try {
        itemParams = withGlobalPrefs(await currentFeature.collect(fieldValues, { file: item }), { __batchItem: true });
      } catch (err) {
        item.status = 'error';
        item.error = err.message;
        renderBatchList();
        continue;
      }

      const res = await window.api.startTask(currentFeature.id, itemParams);
      if (res.cancelled || batchAborted) {
        item.status = 'cancelled';
        batchAborted = true;
        for (let k = i + 1; k < batchFiles.length; k++) batchFiles[k].status = 'cancelled';
        break;
      } else if (res.ok) {
        item.status = 'done';
        item.output = res.output;
        item.outputType = res.outputType || 'file';
        item.outSize = item.outputType === 'dir' ? 0 : await window.api.statFile(res.output);
        item.targetReached = res.targetReached;
        item.targetMB = res.targetMB;
        item.extractSummary = res.extractSummary;
      } else {
        item.status = 'error';
        item.error = res.error || '处理失败';
      }
    }
  } finally {
    window.api.setProgressBar(-1);
  }

  batchRunningIndex = -1;
  currentTaskId = null;
  setRunning(false);
  renderBatchList();
  showBatchSummary();

  if (!batchAborted) {
    const doneCount = batchFiles.filter((b) => b.status === 'done').length;
    const errCount = batchFiles.filter((b) => b.status === 'error').length;
    window.api.notifyDone(
      '批量处理完成',
      errCount ? `${doneCount} 个成功，${errCount} 个失败` : `共 ${doneCount} 个文件全部处理完成`,
    );
  }
}

window.__docRepackCtx = null;

async function copyImageToClipboard(filePath) {
  const r = await window.api.copyImage(filePath);
  if (r?.ok) toast(r.mode === 'svg-text' ? '已复制 SVG 代码到剪贴板' : '已复制图片到剪贴板，可直接粘贴');
  else toast(r?.error || '复制失败', true);
}

async function sendPathsToFeature(paths, featureId, keepDocCtx = true) {
  if (running) return toast('有任务正在进行中', true);
  const target = FEATURES.find((f) => f.id === featureId);
  if (!target) return;
  const matched = (paths || []).filter((p) => target.accept.includes(p.split('.').pop().toLowerCase()));
  if (!matched.length) return toast('所选图片格式与目标功能不兼容', true);
  const savedCtx = keepDocCtx ? window.__docRepackCtx : null;
  selectFeature(target, { forceClear: true });
  window.__docRepackCtx = savedCtx;
  await useFiles(matched);
  toast(`已发送 ${matched.length} 张图片至「${target.name}」`);
}

async function jumpToDocRepack({ docxPath, files: repFiles = [], dir = '' }) {
  if (running) return toast('有任务正在进行中', true);
  const target = FEATURES.find((f) => f.id === 'docRepackImages');
  if (!target || !docxPath) return;
  const docLabel = docxPath.toLowerCase().endsWith('.pptx') ? 'PPT' : 'Word';
  window.__pendingSecondFile = { dir, files: repFiles };
  selectFeature(target, { forceClear: true });
  await useFile(docxPath);
  toast(`已载入原 ${docLabel} 与替换图，点击「开始转换」即可写回`);
}

function getHandoffPoolForExts(extsSet, count, excludeId) {
  const prio = (g) => (g === '图片' ? 0 : (g === 'SVG' ? 1 : 2));
  return FEATURES
    .filter((f) => (!f.noBatch || count === 1) && !(f.multi && count < 2) && f.id !== excludeId && f.accept.some((e) => extsSet.has(e)))
    .sort((a, b) => prio(a.group) - prio(b.group));
}

function showBatchSummary() {
  const doneItems = batchFiles.filter((b) => b.status === 'done');
  const errItems = batchFiles.filter((b) => b.status === 'error');
  const cancelItems = batchFiles.filter((b) => b.status === 'cancelled');

  let title;
  let kind = 'ok';
  if (batchAborted) {
    kind = 'err';
    title = `⚠️ 批量处理已取消：已完成 ${doneItems.length} 个，取消 ${cancelItems.length} 个`
      + (errItems.length ? `，失败 ${errItems.length} 个` : '');
  } else if (errItems.length) {
    kind = 'err';
    title = `⚠️ 批量处理完成：${doneItems.length} 个成功，${errItems.length} 个失败（鼠标悬停“❌ 失败”可看原因）`;
  } else {
    title = `✅ 批量处理全部完成：共 ${doneItems.length} 个文件`;
    if (['compressGif', 'compressTarget', 'imageConvert', 'imageCompressTarget', 'svgOptimize', 'docCompressImages', 'docCleanupMedia'].includes(currentFeature.id)) {
      const totalIn = doneItems.reduce((s, b) => s + (b.info?.size || 0), 0);
      const totalOut = doneItems.reduce((s, b) => s + (b.outSize || 0), 0);
      if (totalIn > 0 && totalOut > 0 && totalOut < totalIn) {
        const pct = Math.round((1 - totalOut / totalIn) * 100);
        title += `（总体积 ${fmtSize(totalIn)} → ${fmtSize(totalOut)}，共节省 ${pct}%）`;
      }
    }
  }

  const firstOut = doneItems[0];
  const openBtnHtml = firstOut
    ? `<button class="btn btn-ghost btn-sm" id="btn-open">打开输出目录</button>`
    : '';
  const canRepack = doneItems.length
    && window.__docRepackCtx?.docxPath
    && currentFeature.id !== 'docCompressImages'
    && currentFeature.id !== 'docRepackImages'
    && doneItems.every((d) => d.outputType !== 'dir' && ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif', 'gif'].includes(String(d.output || '').split('.').pop().toLowerCase()));
  const repackDocName = canRepack ? window.__docRepackCtx.docxPath.split(/[\\/]/).pop() : '';
  const repackDocLabel = canRepack && window.__docRepackCtx.docxPath.toLowerCase().endsWith('.pptx') ? 'PPT' : 'Word';
  const repackBtnHtml = canRepack
    ? `<button class="btn btn-ghost btn-sm btn-repack-word" id="btn-repack-word">📥 将这 ${doneItems.length} 张结果放回原 ${repackDocLabel} (${escHtml(repackDocName)})</button>`
    : '';

  showResult(kind, `${title}<div class="result-actions">${openBtnHtml}<button class="btn btn-ghost btn-sm" id="btn-again">重新准备</button><button class="btn btn-ghost btn-sm" id="btn-batch-send-wf">🕸️ 结果发往画布</button>${repackBtnHtml}</div>`);

  if (firstOut) {
    $('btn-open').onclick = () =>
      firstOut.outputType === 'dir'
        ? window.api.openFolder(firstOut.output)
        : window.api.showInFolder(firstOut.output);
  }
  $('btn-again').onclick = () => {
    useFiles(batchFiles.map((b) => b.path)).then(() => {});
  };
  if ($('btn-batch-send-wf')) {
    $('btn-batch-send-wf').onclick = () => {
      const outPaths = doneItems.filter((d) => d.outputType !== 'dir' && d.output).map((d) => d.output);
      if (!outPaths.length) return toast('没有可发送的输出文件', true);
      sendFilesToWorkflow(outPaths);
    };
  }
  if (canRepack && $('btn-repack-word')) {
    $('btn-repack-word').onclick = () => {
      jumpToDocRepack({
        docxPath: window.__docRepackCtx.docxPath,
        files: doneItems.map((d) => d.output),
      });
    };
  }
}

function renderMediaTag(filePath, ext) {
  const url = encodeURI('file:///' + filePath.replace(/\\/g, '/'));
  if (['gif', 'webp', 'ico', 'svg', ...IMG_EXTS].includes(ext)) {
    return `<img${ext === 'svg' ? ' class="is-svg"' : ''} src="${url}" alt="预览" />`;
  }
  if (['mp4', 'webm', 'mkv', 'mov', 'm4v'].includes(ext)) return `<video src="${url}" controls preload="metadata"></video>`;
  if (['mp3', 'm4a', 'wav', 'flac', 'aac', 'ogg'].includes(ext)) return `<audio src="${url}" controls preload="metadata"></audio>`;
  return '';
}

async function showSuccess(res) {
  const name = res.output.split(/[\\/]/).pop();
  const outExt = res.output.split('.').pop().toLowerCase();
  let line;
  let outSize = 0;

  if (currentFeature.id === 'docExtractImages') {
    window.__docRepackCtx = res.extractSummary?.sourceDocx
      ? { docxPath: res.extractSummary.sourceDocx, extractDir: res.output }
      : null;
  }

  if (res.outputType === 'dir') {
    const count = await window.api.countDir(res.output);
    const unitLabel = currentFeature.id === 'splitVideo' ? '个片段' : (currentFeature.id === 'imageSplit' ? '张切图' : '张图片');
    line = `✅ 已导出 ${count} ${unitLabel}到文件夹`;
    if (res.extractSummary) {
      const es = res.extractSummary;
      const details = [];
      if (es.docxCount) details.push(`Word 内嵌 ${es.docxCount}`);
      if (es.pptxCount) details.push(`PPT 图片 ${es.pptxCount}`);
      if (es.pptAvCount) details.push(`PPT 音视频 ${es.pptAvCount}`);
      if (es.localCount) details.push(`本地文件 ${es.localCount}`);
      if (es.dataUriCount) details.push(`Base64 ${es.dataUriCount}`);
      if (es.inlineSvgCount) details.push(`内联 SVG ${es.inlineSvgCount}`);
      if (es.remoteDownloaded) details.push(`网络下载 ${es.remoteDownloaded}`);
      const secScope = es.sectionFiltered && es.sectionTitles?.length
        ? `（仅所选 ${es.sectionTitles.length} 个章节：${escHtml(es.sectionTitles.slice(0, 2).join('、'))}${es.sectionTitles.length > 2 ? ' 等' : ''}）`
        : '';
      line = `✅ 已从文档${secScope}识别并导出 ${es.savedCount} 个媒体文件` + (details.length ? `（${details.join(' · ')}）` : '');
      const notes = [];
      if (es.remoteSkipped) notes.push(`跳过网络图 ${es.remoteSkipped} 张`);
      if (es.missingLocal) notes.push(`本地路径不存在 ${es.missingLocal} 处`);
      if (es.failedRemote) notes.push(`下载失败 ${es.failedRemote} 张`);
      if (es.pptAvSkipped) notes.push(`未提取 PPT 音视频 ${es.pptAvSkipped} 个`);
      if (notes.length) line += `<br /><span class="muted" style="font-size:12px">ℹ️ ${notes.join(' · ')}</span>`;
    }
  } else {
    outSize = await window.api.statFile(res.output);
    line = `✅ 完成：${escHtml(name)}（${fmtSize(outSize)}）`;
    if (res.docCompressSummary) {
      const ds = res.docCompressSummary;
      const docLbl = ds.docType === 'pptx' ? 'PPT' : 'Word';
      const vNote = ds.videoCompressedCount ? `，含视频 ${ds.videoCompressedCount} 个` : '';
      const secScope = ds.sectionFiltered && ds.sectionTitles?.length
        ? `（仅所选 ${ds.sectionTitles.length} 个章节：${escHtml(ds.sectionTitles.slice(0, 2).join('、'))}${ds.sectionTitles.length > 2 ? ' 等' : ''}）`
        : '';
      if (ds.newSize < ds.origSize) {
        const pct = Math.round((1 - ds.newSize / ds.origSize) * 100);
        line = `✅ ${docLbl}${secScope} 压缩完成：${fmtSize(ds.origSize)} → ${fmtSize(ds.newSize)}，节省 ${pct}%（已压缩 ${ds.compressedCount}/${ds.totalMedia} 项媒体${vNote}）`;
      } else {
        line = `✅ ${docLbl}${secScope} 处理完成：${fmtSize(ds.origSize)} → ${fmtSize(ds.newSize)}（所选范围内媒体已接近最优，尝试降低分辨率上限或切换“极限瘦身”）`;
      }
    } else if (res.docRepackSummary) {
      const rs = res.docRepackSummary;
      const docLbl = rs.docType === 'pptx' ? 'PPT' : 'Word';
      const delta = rs.newSize < rs.origSize
        ? `，节省 ${Math.round((1 - rs.newSize / rs.origSize) * 100)}%`
        : '';
      const resizeNote = rs.resizedCount > 0 ? `，保持原宽度并自适应 ${rs.resizedCount} 处高度` : '';
      line = `✅ 已将 ${rs.replacedCount} 张图片放回 ${docLbl} 原位（匹配 ${rs.matchedCount} 处${resizeNote}，${fmtSize(rs.origSize)} → ${fmtSize(rs.newSize)}${delta}）`;
    } else if (res.docCleanupSummary) {
      const cs = res.docCleanupSummary;
      const docLbl = cs.docType === 'pptx' ? 'PPT' : 'Word';
      const pct = cs.origSize > 0 && cs.newSize < cs.origSize
        ? `，节省 ${Math.round((1 - cs.newSize / cs.origSize) * 100)}%`
        : '';
      const parts = [];
      if (cs.orphanCount) parts.push(`移除未引用孤立媒体 ${cs.orphanCount} 项`);
      if (cs.dedupeCount) parts.push(`去重合并重复图 ${cs.dedupeCount} 项`);
      const detail = parts.length ? parts.join(' · ') : '未发现孤立或重复媒体，已重构整理';
      line = `✅ ${docLbl} 清理完成：${detail}（媒体 ${cs.totalBefore} → ${cs.totalAfter} 项，${fmtSize(cs.origSize)} → ${fmtSize(cs.newSize)}${pct}）`;
    } else if (res.docStyleSummary) {
      const ss = res.docStyleSummary;
      const docLbl = ss.docType === 'pptx' ? 'PPT' : 'Word';
      const secScope = ss.sectionFiltered && ss.sectionTitles?.length
        ? `（仅所选 ${ss.sectionTitles.length} 个章节：${escHtml(ss.sectionTitles.slice(0, 2).join('、'))}${ss.sectionTitles.length > 2 ? ' 等' : ''}）`
        : '';
      const tags = [];
      if (ss.frameMode === 'rounded') tags.push('圆角');
      else if (ss.frameMode === 'roundedBorder') tags.push('圆角+相框');
      else if (ss.frameMode === 'border') tags.push('纯色边框');
      if (ss.watermarked) tags.push('文字水印');
      line = `✅ ${docLbl}${secScope} 图片美化完成：已处理 ${ss.styledCount} / ${ss.totalImages} 张图片（${tags.join(' + ')}，${fmtSize(ss.newSize)}）`;
    } else if (res.mdOrganizeSummary) {
      const ms = res.mdOrganizeSummary;
      if (ms.action === 'cleanUnused') {
        line = ms.cleanedCount > 0
          ? `✅ Markdown 未使用图片清理完成：扫描 ${ms.scannedCount} 张，已${ms.cleanAction === 'delete' ? '删除' : '移入 _已清理冗余'} ${ms.cleanedCount} 张（释放 ${fmtSize(ms.freedBytes)}）`
          : `✅ Markdown 资源子目录已检查（共 ${ms.scannedCount} 张图，均在正文中被引用）`;
      } else if (ms.action === 'inlineBase64') {
        line = `✅ Markdown 单文件内嵌完成：共将 ${ms.rewrittenCount} 处图片转为 Base64 内嵌（输出 ${fmtSize(outSize)}）`;
        const notes = [];
        if (ms.downloadedCount) notes.push(`网络下载 ${ms.downloadedCount} 张`);
        if (ms.missingLocal) notes.push(`本地缺失 ${ms.missingLocal} 处`);
        if (ms.failedRemote) notes.push(`下载失败 ${ms.failedRemote} 张`);
        if (notes.length) line += `<br /><span class="muted" style="font-size:12px">ℹ️ ${notes.join(' · ')}</span>`;
      } else {
        const sub = [];
        if (ms.copiedLocalCount) sub.push(`收集本地图 ${ms.copiedLocalCount}`);
        if (ms.downloadedCount) sub.push(`下载网络图 ${ms.downloadedCount}`);
        if (ms.decodedDataCount) sub.push(`还原 Base64 ${ms.decodedDataCount}`);
        if (ms.extractedSvgCount) sub.push(`导出 SVG ${ms.extractedSvgCount}`);
        line = `✅ Markdown 本地化完成：共重写 ${ms.rewrittenCount} 处图片引用` + (sub.length ? `（${sub.join(' · ')}）` : '');
        const notes = [];
        if (ms.missingLocal) notes.push(`本地路径缺失 ${ms.missingLocal} 处`);
        if (ms.failedRemote) notes.push(`下载失败 ${ms.failedRemote} 张`);
        if (notes.length) line += `<br /><span class="muted" style="font-size:12px">ℹ️ ${notes.join(' · ')}</span>`;
      }
    } else if (res.pdfSummary) {
      const ps = res.pdfSummary;
      const modeName = ps.pageSize === 'a4l' ? 'A4 横向' : (ps.pageSize === 'fit' ? '按原图尺寸自适应' : 'A4 竖向');
      line = `✅ PDF 合成完成：共 ${ps.pageCount} 页（${modeName}，${fmtSize(outSize)}）`;
    } else if ((currentFeature.id === 'compressGif' || currentFeature.id === 'imageConvert' || currentFeature.id === 'svgOptimize') && file?.info.size) {
      if (outSize < file.info.size) {
        const pct = Math.round((1 - outSize / file.info.size) * 100);
        line = `✅ 处理完成：${fmtSize(file.info.size)} → ${fmtSize(outSize)}，节省 ${pct}%`;
      } else if (currentFeature.id === 'compressGif') {
        line = `✅ 处理完成：${fmtSize(file.info.size)} → ${fmtSize(outSize)}（未比原图更小，可尝试降低宽度/帧率或选“极限瘦身”）`;
      } else {
        line = `✅ 完成：${escHtml(name)}（${fmtSize(file.info.size)} → ${fmtSize(outSize)}）`;
      }
    }
    if (currentFeature.id === 'compressTarget' || currentFeature.id === 'imageCompressTarget') {
      const srcSize = file?.info.size || 0;
      const pct = srcSize ? Math.max(0, Math.round((1 - outSize / srcSize) * 100)) : 0;
      line += srcSize ? `（原 ${fmtSize(srcSize)}，减小 ${pct}%）` : '';
      if (res.targetReached === false) {
        const targetLabel = res.targetKB ? `${res.targetKB} KB` : `${res.targetMB} MB`;
        line += `<br />⚠️ 已尽力压至最小 ${fmtSize(outSize)}，仍略高于 ${targetLabel} 目标`;
      }
    }
  }

  let previewHtml = '';
  let canCompare = false;
  let hasVisualOut = false;
  let srcExt = '';
  let thumbPaths = [];
  const repackSrcPath = res.extractSummary?.sourceDocx || window.__docRepackCtx?.docxPath || '';
  const repackDocLabel = repackSrcPath.toLowerCase().endsWith('.pptx') ? 'PPT' : 'Word';
  const canRepackDir = res.outputType === 'dir' && !!res.extractSummary?.sourceDocx;
  if (res.outputType === 'dir') {
    if (currentFeature.id !== 'splitVideo') {
      const previewExts = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg']);
      const rawList = res.extractSummary?.files?.length
        ? res.extractSummary.files
        : await window.api.listDir(res.output, 200);
      thumbPaths = rawList.filter((p) => previewExts.has(p.split('.').pop().toLowerCase()));
      if (thumbPaths.length) {
        const shownThumbs = thumbPaths.slice(0, 300);
        const hasSvgThumb = shownThumbs.some((p) => p.toLowerCase().endsWith('.svg'));
        const hasRasterThumb = shownThumbs.some((p) => !p.toLowerCase().endsWith('.svg'));
        const moreHtml = thumbPaths.length > shownThumbs.length
          ? `<div class="muted" style="font-size:12px;margin-top:6px">还有 ${thumbPaths.length - shownThumbs.length} 张未展开，可点击下方「打开文件夹」查看全部</div>`
          : '';
        const toolbarHint = canRepackDir
          ? `已选 ${shownThumbs.length} / ${shownThumbs.length} 张（点「🔄 换图 / 📋 贴截图」或直接把截图拖到对应卡片上即可替换，最后点下方「📥 改完放回原 ${repackDocLabel}」）`
          : `已选 ${shownThumbs.length} / ${shownThumbs.length} 张（可直接勾选发给其他工具，或拖拽单图到外部软件）`;
        previewHtml = `
          <div class="result-preview-wrap" id="result-preview-wrap">
            <div class="result-thumb-toolbar">
              <span class="muted" id="thumb-sel-count">${toolbarHint}</span>
              <button class="batch-btn" id="thumb-sel-all">全选</button>
              <button class="batch-btn" id="thumb-sel-none">全不选</button>
              ${hasRasterThumb && hasSvgThumb ? '<button class="batch-btn" id="thumb-sel-raster">仅位图</button><button class="batch-btn" id="thumb-sel-svg">仅 SVG</button>' : ''}
            </div>
            <div class="result-thumb-grid">
              ${shownThumbs.map((p, idx) => {
                const u = encodeURI('file:///' + p.replace(/\\/g, '/'));
                const fn = escHtml(p.split(/[\\/]/).pop());
                const isSvg = p.toLowerCase().endsWith('.svg');
                const replaceOpsHtml = canRepackDir
                  ? `<div class="result-thumb-ops result-thumb-ops-replace">
                      <button class="thumb-op-btn" data-thumb-replace="${idx}" title="选择本地截图或图片直接替换此位置">🔄 换图</button>
                      <button class="thumb-op-btn" data-thumb-paste="${idx}" title="粘贴剪贴板里的截图直接替换此位置">📋 贴截图</button>
                    </div>`
                  : '';
                return `<div class="result-thumb-card selected" data-thumb-card="${idx}">
                  <input type="checkbox" class="result-thumb-check" data-thumb-check="${idx}" checked title="勾选此图" />
                  <div class="result-thumb-img-wrap" data-thumb-idx="${idx}" draggable="true" title="点击放大查看 / 拖出到外部软件：${fn}">
                    <img${isSvg ? ' class="is-svg"' : ''} src="${u}" alt="${fn}" loading="lazy" draggable="false" />
                  </div>
                  <div class="result-thumb-name" title="${escHtml(p)}">${fn}</div>
                  <div class="result-thumb-ops">
                    <button class="thumb-op-btn primary" data-thumb-send="${idx}" title="只发送这张图到下方选中的工具">↗ 发此图</button>
                    <button class="thumb-op-btn" data-thumb-copy="${idx}" title="复制图片到剪贴板">📋</button>
                    <button class="thumb-op-btn" data-thumb-loc="${idx}" title="在文件夹中定位">📂</button>
                  </div>
                  ${replaceOpsHtml}
                </div>`;
              }).join('')}
            </div>
            ${moreHtml}
          </div>`;
      }
    }
  } else {
    const outTag = renderMediaTag(res.output, outExt);
    if (outTag) {
      hasVisualOut = ['gif', 'webp', 'ico', 'svg', ...IMG_EXTS, 'mp4', 'webm', 'mkv', 'mov', 'm4v'].includes(outExt);
      previewHtml = `<div class="result-preview-wrap" id="result-preview-wrap"><div class="result-media-card">${outTag}</div></div>`;
      if (file?.path) {
        srcExt = file.path.split('.').pop().toLowerCase();
        const isSrcVisual = ['gif', 'webp', 'svg', ...IMG_EXTS, 'mp4', 'webm', 'mkv', 'mov', 'm4v'].includes(srcExt);
        canCompare = hasVisualOut && isSrcVisual;
      }
    }
  }

  let handoffFeatures = [];
  if (res.outputType === 'file') {
    handoffFeatures = FEATURES.filter((f) => !f.multi && f.id !== currentFeature.id && f.accept.includes(outExt));
  } else if (thumbPaths.length) {
    const outExts = new Set(thumbPaths.map((p) => p.split('.').pop().toLowerCase()));
    handoffFeatures = getHandoffPoolForExts(outExts, thumbPaths.length, currentFeature.id);
  }

  const canRepackSingle = res.outputType === 'file'
    && !!window.__docRepackCtx?.docxPath
    && currentFeature.id !== 'docCompressImages'
    && currentFeature.id !== 'docRepackImages'
    && ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif', 'gif'].includes(outExt);

  const handoffHtml = handoffFeatures.length
    ? `<div class="result-handoff" id="result-handoff">
         <span class="muted" id="handoff-label" style="font-size:12px">${res.outputType === 'dir' ? `➡️ 发送所选 ${thumbPaths.length} 张图片到：` : '➡️ 继续处理此结果：'}</span>
         <select id="handoff-feature">
           ${handoffFeatures.map((f) => `<option value="${f.id}">${f.icon} ${escHtml(f.name)}</option>`).join('')}
         </select>
         <button class="btn btn-ghost btn-sm" id="btn-handoff">${res.outputType === 'dir' ? `批量发送 (${thumbPaths.length})` : '发送处理'}</button>
         ${canRepackDir ? `<button class="btn btn-ghost btn-sm btn-repack-word" id="btn-repack-dir" title="如果你已在文件夹里修改/压缩了图片，点此一键放回原 ${repackDocLabel}">📥 改完放回原 ${repackDocLabel}</button>` : ''}
       </div>`
    : '';

  const repackSingleBtn = canRepackSingle
    ? `<button class="btn btn-ghost btn-sm btn-repack-word" id="btn-repack-single">📥 放回原 ${repackDocLabel} (${escHtml(window.__docRepackCtx.docxPath.split(/[\\/]/).pop())})</button>`
    : '';

  const compareBtnHtml = canCompare
    ? `<button class="btn btn-ghost btn-sm" id="btn-compare">🔍 对比原文件</button>
       <button class="btn btn-ghost btn-sm" id="btn-zoom-compare">⛶ 放大对比</button>`
    : (hasVisualOut || thumbPaths.length
      ? `<button class="btn btn-ghost btn-sm" id="btn-zoom-result">⛶ 放大查看</button>`
      : '');

  showResult('ok', `${line}<div class="result-path">${escHtml(res.output)}</div>${previewHtml}<div class="result-actions">
    <button class="btn btn-ghost btn-sm" id="btn-open">${res.outputType === 'dir' ? '打开文件夹' : '打开所在文件夹'}</button>
    ${compareBtnHtml}
    ${repackSingleBtn}
    <button class="btn btn-ghost btn-sm" id="btn-result-send-wf">🕸️ 结果发往画布</button>
    <button class="btn btn-ghost btn-sm" id="btn-again">再来一次</button></div>${handoffHtml}`);

  $('btn-open').onclick = () =>
    res.outputType === 'dir' ? window.api.openFolder(res.output) : window.api.showInFolder(res.output);
  if ($('btn-result-send-wf')) {
    $('btn-result-send-wf').onclick = async () => {
      if (res.outputType === 'dir') {
        const list = thumbPaths.length ? thumbPaths : await window.api.listDir(res.output, 200);
        if (!list.length) return toast('输出目录为空', true);
        await sendFilesToWorkflow(list);
      } else {
        await sendFilesToWorkflow([res.output]);
      }
    };
  }
  $('btn-again').onclick = () => {
    if (currentFeature.multi || !file?.path) return clearFile();
    useFile(file.path).then(() => {});
  };
  if ($('btn-repack-single')) {
    $('btn-repack-single').onclick = () => {
      jumpToDocRepack({ docxPath: window.__docRepackCtx.docxPath, files: [res.output] });
    };
  }
  if ($('btn-repack-dir')) {
    $('btn-repack-dir').onclick = () => {
      jumpToDocRepack({ docxPath: res.extractSummary.sourceDocx, dir: res.output });
    };
  }

  const openSingleLightbox = (idx = 0) => {
    if (thumbPaths.length) {
      const allSinglePool = getHandoffPoolForExts(
        new Set(thumbPaths.map((p) => p.split('.').pop().toLowerCase())),
        1,
        currentFeature.id,
      );
      window.VGT.lightbox?.openSingle({
        list: thumbPaths.map((p) => ({ path: p, label: p.split(/[\\/]/).pop() })),
        index: idx,
        handoff: {
          features: allSinglePool,
          onSend: (p, fid) => sendPathsToFeature([p], fid, true),
          onCopy: copyImageToClipboard,
        },
      });
    } else if (hasVisualOut) {
      window.VGT.lightbox?.openSingle({
        path: res.output,
        label: name,
        meta: outSize ? fmtSize(outSize) : '',
      });
    }
  };

  const openCompareLightbox = (initialMode = 'side') => {
    if (!canCompare) return openSingleLightbox(0);
    window.VGT.lightbox?.openCompare({
      srcPath: file.path,
      srcExt,
      srcMeta: file.info?.size ? fmtSize(file.info.size) : '',
      outPath: res.output,
      outExt,
      outMeta: outSize ? fmtSize(outSize) : '',
      initialMode,
    });
  };

  if (thumbPaths.length) {
    const shownThumbs = thumbPaths.slice(0, 300);
    const getSelectedPaths = () => {
      const checks = [...document.querySelectorAll('.result-thumb-check')];
      return checks.filter((c) => c.checked).map((c) => shownThumbs[Number(c.dataset.thumbCheck)]).filter(Boolean);
    };

    const syncThumbSelectionUI = () => {
      const checks = [...document.querySelectorAll('.result-thumb-check')];
      checks.forEach((c) => {
        const card = c.closest('.result-thumb-card');
        if (card) card.classList.toggle('selected', c.checked);
      });
      const selected = getSelectedPaths();
      const countEl = $('thumb-sel-count');
      if (countEl) {
        countEl.textContent = canRepackDir
          ? `已选 ${selected.length} / ${shownThumbs.length} 张（点「🔄 换图 / 📋 贴截图」或拖截图到卡片上即可替换，最后点下方「📥 改完放回原 ${repackDocLabel}」）`
          : `已选 ${selected.length} / ${shownThumbs.length} 张（可直接勾选发给其他工具，或拖拽单图到外部软件）`;
      }
      const selEl = $('handoff-feature');
      const btnEl = $('btn-handoff');
      const lblEl = $('handoff-label');
      if (selEl && btnEl && lblEl) {
        const prevVal = selEl.value;
        const extsSet = new Set((selected.length ? selected : shownThumbs).map((p) => p.split('.').pop().toLowerCase()));
        const pool = getHandoffPoolForExts(extsSet, selected.length || shownThumbs.length, currentFeature.id);
        selEl.innerHTML = pool.map((f) => `<option value="${f.id}">${f.icon} ${escHtml(f.name)}</option>`).join('');
        if (pool.some((f) => f.id === prevVal)) selEl.value = prevVal;
        if (selected.length === 1) {
          lblEl.textContent = '➡️ 发送所选 1 张图片到：';
          btnEl.textContent = '发送这 1 张';
          btnEl.disabled = !pool.length;
        } else if (selected.length > 1) {
          lblEl.textContent = `➡️ 发送所选 ${selected.length} 张图片到：`;
          btnEl.textContent = `批量发送 (${selected.length})`;
          btnEl.disabled = !pool.length;
        } else {
          lblEl.textContent = '➡️ 请先勾选上方图片：';
          btnEl.textContent = '发送处理 (0)';
          btnEl.disabled = true;
        }
      }
    };

    document.querySelectorAll('.result-thumb-check').forEach((chk) => {
      chk.onchange = syncThumbSelectionUI;
    });
    if ($('thumb-sel-all')) {
      $('thumb-sel-all').onclick = () => {
        document.querySelectorAll('.result-thumb-check').forEach((c) => { c.checked = true; });
        syncThumbSelectionUI();
      };
    }
    if ($('thumb-sel-none')) {
      $('thumb-sel-none').onclick = () => {
        document.querySelectorAll('.result-thumb-check').forEach((c) => { c.checked = false; });
        syncThumbSelectionUI();
      };
    }
    if ($('thumb-sel-raster')) {
      $('thumb-sel-raster').onclick = () => {
        document.querySelectorAll('.result-thumb-check').forEach((c) => {
          const p = shownThumbs[Number(c.dataset.thumbCheck)] || '';
          c.checked = !p.toLowerCase().endsWith('.svg');
        });
        syncThumbSelectionUI();
      };
    }
    if ($('thumb-sel-svg')) {
      $('thumb-sel-svg').onclick = () => {
        document.querySelectorAll('.result-thumb-check').forEach((c) => {
          const p = shownThumbs[Number(c.dataset.thumbCheck)] || '';
          c.checked = p.toLowerCase().endsWith('.svg');
        });
        syncThumbSelectionUI();
      };
    }

    const wrap = $('result-preview-wrap');
    wrap?.querySelectorAll('[data-thumb-idx]').forEach((el) => {
      const idx = Number(el.dataset.thumbIdx) || 0;
      el.onclick = () => openSingleLightbox(idx);
      el.ondragstart = (e) => {
        e.preventDefault();
        if (shownThumbs[idx]) window.api.startDrag(shownThumbs[idx]);
      };
    });
    wrap?.querySelectorAll('[data-thumb-send]').forEach((btn) => {
      btn.onclick = () => {
        const p = shownThumbs[Number(btn.dataset.thumbSend)];
        if (!p) return;
        const ext = p.split('.').pop().toLowerCase();
        const chosenId = $('handoff-feature')?.value;
        const chosenFeat = FEATURES.find((f) => f.id === chosenId);
        let fid = chosenId;
        if (!chosenFeat || !chosenFeat.accept.includes(ext) || (chosenFeat.multi)) {
          const fallback = getHandoffPoolForExts(new Set([ext]), 1, currentFeature.id)[0];
          fid = fallback?.id;
        }
        if (fid) sendPathsToFeature([p], fid, true);
      };
    });
    wrap?.querySelectorAll('[data-thumb-copy]').forEach((btn) => {
      btn.onclick = () => {
        const p = shownThumbs[Number(btn.dataset.thumbCopy)];
        if (p) copyImageToClipboard(p);
      };
    });
    wrap?.querySelectorAll('[data-thumb-loc]').forEach((btn) => {
      btn.onclick = () => {
        const p = shownThumbs[Number(btn.dataset.thumbLoc)];
        if (p) window.api.showInFolder(p);
      };
    });

    if (canRepackDir) {
      const applyCardReplace = async (idx, opts) => {
        const targetPath = shownThumbs[idx];
        if (!targetPath) return;
        const r = await window.api.replaceExtractedImage({ targetPath, ...opts });
        if (!r?.ok) {
          toast(r?.error || '替换图片失败', true);
          return;
        }
        thumbPaths[idx] = r.newPath;
        shownThumbs[idx] = r.newPath;
        const card = wrap?.querySelector(`[data-thumb-card="${idx}"]`);
        if (card) {
          card.classList.add('replaced');
          const imgEl = card.querySelector('.result-thumb-img-wrap img');
          if (imgEl) {
            imgEl.classList.toggle('is-svg', r.newPath.toLowerCase().endsWith('.svg'));
            imgEl.src = `${encodeURI('file:///' + r.newPath.replace(/\\/g, '/'))}?t=${Date.now()}`;
            imgEl.alt = r.replacedName;
          }
          const nameEl = card.querySelector('.result-thumb-name');
          if (nameEl) {
            nameEl.textContent = r.replacedName;
            nameEl.title = r.newPath;
          }
          if (!card.querySelector('.result-thumb-badge')) {
            const badge = document.createElement('span');
            badge.className = 'result-thumb-badge';
            badge.textContent = '已换';
            card.appendChild(badge);
          }
        }
        syncThumbSelectionUI();
        toast(`已替换「${r.replacedName}」，最后点下方「📥 改完放回原 ${repackDocLabel}」即可写回`);
      };

      wrap?.querySelectorAll('[data-thumb-replace]').forEach((btn) => {
        btn.onclick = async () => {
          const idx = Number(btn.dataset.thumbReplace);
          const srcPath = await window.api.pickSingleImage();
          if (srcPath) await applyCardReplace(idx, { sourcePath: srcPath });
        };
      });

      wrap?.querySelectorAll('[data-thumb-paste]').forEach((btn) => {
        btn.onclick = async () => {
          const idx = Number(btn.dataset.thumbPaste);
          await applyCardReplace(idx, { fromClipboard: true });
        };
      });

      wrap?.querySelectorAll('.result-thumb-card[data-thumb-card]').forEach((card) => {
        const idx = Number(card.dataset.thumbCard);
        card.addEventListener('dragover', (e) => {
          if (!e.dataTransfer?.files?.length) return;
          e.preventDefault();
          e.stopPropagation();
          card.classList.add('drag-over');
        });
        card.addEventListener('dragleave', () => {
          card.classList.remove('drag-over');
        });
        card.addEventListener('drop', async (e) => {
          const files = e.dataTransfer?.files;
          if (!files?.length) return;
          e.preventDefault();
          e.stopPropagation();
          card.classList.remove('drag-over');
          const filePath = window.api.getPath(files[0]);
          if (filePath) await applyCardReplace(idx, { sourcePath: filePath });
        });
      });
    }

    if (handoffFeatures.length) {
      $('btn-handoff').onclick = async () => {
        const selected = getSelectedPaths();
        if (!selected.length) return toast('请至少勾选 1 张图片', true);
        await sendPathsToFeature(selected, $('handoff-feature').value, true);
      };
    }
    syncThumbSelectionUI();
  }

  const bindPreviewClicks = (comparing) => {
    const wrap = $('result-preview-wrap');
    if (!wrap || thumbPaths.length) return;
    wrap.querySelectorAll('.result-media-card img').forEach((img) => {
      img.title = comparing ? '点击放大对比细节（支持滚轮缩放与卷帘对比）' : '点击放大查看细节';
      img.onclick = () => (comparing ? openCompareLightbox('side') : openSingleLightbox(0));
    });
  };

  bindPreviewClicks(false);

  if ($('btn-zoom-result')) {
    $('btn-zoom-result').onclick = () => openSingleLightbox(0);
  }

  if (canCompare) {
    let comparing = false;
    $('btn-zoom-compare').onclick = () => openCompareLightbox('side');
    $('btn-compare').onclick = () => {
      comparing = !comparing;
      const wrap = $('result-preview-wrap');
      if (!wrap) return;
      if (comparing) {
        wrap.innerHTML = `<div class="result-preview-grid">
          <div class="result-media-card"><div class="result-media-label">原文件（点击放大对比）</div>${renderMediaTag(file.path, srcExt)}</div>
          <div class="result-media-card"><div class="result-media-label">输出结果（点击放大对比）</div>${renderMediaTag(res.output, outExt)}</div>
        </div>`;
        $('btn-compare').textContent = '🔍 仅看结果';
      } else {
        wrap.innerHTML = `<div class="result-media-card">${renderMediaTag(res.output, outExt)}</div>`;
        $('btn-compare').textContent = '🔍 对比原文件';
      }
      bindPreviewClicks(comparing);
    };
  }

  if (!thumbPaths.length && handoffFeatures.length && $('btn-handoff')) {
    $('btn-handoff').onclick = async () => {
      if (running) return toast('有任务正在进行中', true);
      await sendPathsToFeature([res.output], $('handoff-feature').value, true);
    };
  }
}

function setRunning(on) {
  running = on;
  $('btn-run').classList.toggle('hidden', on);
  $('btn-cancel').classList.toggle('hidden', !on);
  $('progress-area').classList.toggle('hidden', !on);
  if (!on) {
    taskStartTime = 0;
    setProgress(0);
  }
}

function setProgress(ratio, text) {
  $('progress-fill').style.width = `${Math.round(ratio * 100)}%`;
  $('progress-text').textContent = text || `进度 ${Math.round(ratio * 100)}%`;
}

function showResult(kind, html) {
  const card = $('result-card');
  card.className = `result-card ${kind}`;
  card.innerHTML = html;
  card.classList.remove('hidden');
}

let toastTimer = null;
function toast(msg, warn = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast${warn ? ' warn' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtSize(bytes) {
  if (!bytes) return '-';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fmtDur(sec) {
  if (sec < 60) return `${round1(sec)} 秒`;
  const m = Math.floor(sec / 60);
  return `${m} 分 ${Math.round(sec % 60)} 秒`;
}

// ---------------------------------------------------------------------------
// 双模式切换与工作流画布桥接
// ---------------------------------------------------------------------------

function switchAppMode(nextMode) {
  if (nextMode === appMode) return;
  if (running || wfController?.isRunning?.()) {
    toast('当前有任务正在运行中，请先等待完成或停止', true);
    return;
  }
  appMode = nextMode;
  localStorage.setItem('vgt_app_mode', appMode);
  $('mode-btn-single').classList.toggle('active', appMode === 'single');
  $('mode-btn-workflow').classList.toggle('active', appMode === 'workflow');
  $('single-main').classList.toggle('hidden', appMode !== 'single');
  $('workflow-main').classList.toggle('hidden', appMode !== 'workflow');
  $('nav-search').placeholder = appMode === 'workflow'
    ? '搜索节点（点击或拖入画布）'
    : '搜索功能（gif / 图片 / svg / word / md…）';
  $('sidebar-foot').textContent = appMode === 'workflow'
    ? '滚轮缩放 · 拖线松手建节点 · Ctrl+Enter 运行'
    : '本地 FFmpeg 9.0 · Ctrl+O 选文件 · 空格播放';
  renderNav();
  if (appMode === 'workflow') {
    wfController?.onActivated?.();
  }
}

async function sendFilesToWorkflow(paths) {
  if (!paths?.length) return;
  switchAppMode('workflow');
  await wfController?.receiveFilesFromSingle?.(paths);
}

function initWorkflowBridge() {
  if (!window.VGT.workflowCanvas) return;
  const bridge = {
    toast,
    getGlobalPrefs() {
      return {
        outputMode: prefOutputMode,
        outputDir: prefOutputMode === 'custom' ? prefOutputDir : '',
        hwAccel: prefHwAccel,
        noOverwrite: prefNoOverwrite,
      };
    },
    setActiveTaskCallbacks(_onTid, onProg) {
      wfTaskProgressCb = onProg || null;
    },
    clearActiveTaskCallbacks() {
      wfTaskProgressCb = null;
    },
    async sendToSingle(paths) {
      if (!paths?.length) return;
      const ext = paths[0].split('.').pop().toLowerCase();
      const target = FEATURES.find((f) => !f.multi && f.accept.includes(ext))
        || FEATURES.find((f) => f.accept.includes(ext))
        || FEATURES[0];
      switchAppMode('single');
      selectFeature(target, { forceClear: true });
      await useFiles(paths);
      toast(`已发送 ${paths.length} 个文件到「${target.name}」`);
    },
    openFeatureInSingle(featureId) {
      const target = FEATURES.find((f) => f.id === featureId);
      if (!target) return;
      switchAppMode('single');
      selectFeature(target);
    },
  };
  window.VGT.appBridge = bridge;
  wfController = window.VGT.workflowCanvas.initWorkflowCanvas($('workflow-main'), bridge);
  window.VGT.wfController = wfController;

  $('mode-btn-single').onclick = () => switchAppMode('single');
  $('mode-btn-workflow').onclick = () => switchAppMode('workflow');
  if ($('btn-send-wf')) {
    $('btn-send-wf').onclick = () => {
      if (files?.length) return sendFilesToWorkflow(files.map((f) => f.path));
      if (batchFiles?.length) return sendFilesToWorkflow(batchFiles.map((b) => b.path));
      if (file?.path) return sendFilesToWorkflow([file.path]);
      toast('请先选择要发送的文件', true);
    };
  }
}

// ---------------------------------------------------------------------------
// 事件绑定与启动
// ---------------------------------------------------------------------------

function bindEvents() {
  $('nav-search').oninput = (e) => {
    navSearchQuery = e.target.value;
    renderNav();
  };

  $('btn-zoom-preview').onclick = () => {
    const large = $('file-card').classList.toggle('preview-large');
    $('btn-zoom-preview').textContent = large ? '🗗 缩小预览' : '⛶ 放大预览';
  };

  $('dropzone').onclick = async () => {
    const p = await window.api.pickFile(currentFeature.id);
    if (p) useFiles(Array.isArray(p) ? p : [p]);
  };
  $('btn-replace').onclick = async () => {
    if (running) return toast('有任务正在进行中', true);
    const p = await window.api.pickFile(currentFeature.id);
    if (p) useFiles(Array.isArray(p) ? p : [p]);
  };
  $('btn-add-more').onclick = async () => {
    if (running) return toast('有任务正在进行中', true);
    const p = await window.api.pickFile(currentFeature.id);
    if (p) useFiles(Array.isArray(p) ? p : [p], true);
  };

  const dz = $('dropzone');
  document.body.addEventListener('dragover', (e) => {
    if (appMode === 'workflow') return;
    e.preventDefault();
    dz.classList.add('dragover');
  });
  document.body.addEventListener('dragleave', (e) => {
    if (appMode === 'workflow') return;
    if (!e.relatedTarget) dz.classList.remove('dragover');
  });
  document.body.addEventListener('drop', async (e) => {
    if (appMode === 'workflow') return;
    e.preventDefault();
    dz.classList.remove('dragover');
    if (running) return toast('有任务正在进行中', true);
    const list = e.dataTransfer?.files;
    if (!list?.length) return;
    const paths = [...list].map((f) => window.api.getPath(f)).filter(Boolean);
    if (!paths.length) return;
    useFiles(paths);
  });

  $('btn-run').onclick = runTask;
  $('btn-cancel').onclick = () => {
    if (batchFiles?.length && running) batchAborted = true;
    if (currentTaskId) window.api.cancelTask(currentTaskId);
  };

  document.addEventListener('keydown', (e) => {
    if (appMode === 'workflow') {
      wfController?.handleKeyDown?.(e);
      return;
    }
    if (e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      if (running) return toast('有任务正在进行中', true);
      ($('file-card').classList.contains('hidden') ? $('dropzone') : $('btn-replace')).click();
      return;
    }
    if (mod && e.key === 'Enter') {
      if (!running && !$('action-bar').classList.contains('hidden')) {
        e.preventDefault();
        runTask();
      }
      return;
    }
    const tag = document.activeElement?.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(tag)) return;

    const vid = document.querySelector('#preview-box video');
    if (!vid) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (vid.paused) vid.play().catch(() => {});
      else vid.pause();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = e.shiftKey ? 5 : 1;
      const dur = Number.isFinite(vid.duration) ? vid.duration : 1e9;
      vid.currentTime = Math.max(0, Math.min(dur, vid.currentTime + (e.key === 'ArrowRight' ? step : -step)));
    }
  });
}

function initGlobalPrefs() {
  const modeSel = $('pref-out-mode');
  const dirBtn = $('pref-out-dir-btn');
  const hwSel = $('pref-hw');
  const noOverwriteChk = $('pref-no-overwrite');

  const syncOutPrefUi = () => {
    modeSel.value = prefOutputMode;
    if (prefOutputMode === 'custom' && prefOutputDir) {
      dirBtn.classList.remove('hidden');
      dirBtn.textContent = `📁 ${prefOutputDir.split(/[\\/]/).pop() || prefOutputDir}`;
      dirBtn.title = prefOutputDir;
    } else {
      dirBtn.classList.add('hidden');
    }
    if (batchFiles?.length) renderBatchHeader();
  };

  modeSel.onchange = async () => {
    const val = modeSel.value;
    if (val === 'custom') {
      const picked = await window.api.pickDir();
      if (!picked) {
        modeSel.value = prefOutputMode;
        return;
      }
      prefOutputMode = 'custom';
      prefOutputDir = picked;
      localStorage.setItem('vgt_out_dir', picked);
    } else {
      prefOutputMode = val;
    }
    localStorage.setItem('vgt_out_mode', prefOutputMode);
    syncOutPrefUi();
  };

  dirBtn.onclick = async () => {
    const picked = await window.api.pickDir();
    if (!picked) return;
    prefOutputDir = picked;
    localStorage.setItem('vgt_out_dir', picked);
    syncOutPrefUi();
  };

  hwSel.value = prefHwAccel;
  hwSel.onchange = () => {
    prefHwAccel = hwSel.value;
    localStorage.setItem('vgt_hw', prefHwAccel);
  };

  if (noOverwriteChk) {
    noOverwriteChk.checked = prefNoOverwrite;
    noOverwriteChk.onchange = () => {
      prefNoOverwrite = noOverwriteChk.checked;
      localStorage.setItem('vgt_no_overwrite', prefNoOverwrite ? '1' : '0');
    };
  }

  syncOutPrefUi();

  window.api.detectHw().then((hw) => {
    if (!hw) return;
    const avail = new Set(hw.available || []);
    const autoOpt = hwSel.querySelector('option[value="auto"]');
    if (autoOpt) {
      autoOpt.textContent = hw.primary
        ? `自动检测 GPU (${hw.primary.replace('h264_', '').toUpperCase()})`
        : '自动检测 GPU（未检测到，将用 CPU）';
    }
    ['h264_nvenc', 'h264_qsv', 'h264_amf'].forEach((id) => {
      const opt = hwSel.querySelector(`option[value="${id}"]`);
      if (opt) opt.textContent = opt.textContent + (avail.has(id) ? ' ✓' : '（不可用）');
    });
  }).catch(() => {});
}

window.addEventListener('DOMContentLoaded', () => {
  initGlobalPrefs();
  initWorkflowBridge();
  renderNav();
  selectFeature(FEATURES[0]);
  bindEvents();
  const lastMode = localStorage.getItem('vgt_app_mode');
  if (lastMode === 'workflow') switchAppMode('workflow');

  window.api.onProgress(({ taskId, ratio }) => {
    currentTaskId = taskId;
    if (wfTaskProgressCb) {
      wfTaskProgressCb(ratio, taskId);
      return;
    }
    if (!running) return;
    if (batchFiles?.length && batchRunningIndex >= 0 && batchRunningIndex < batchFiles.length) {
      const item = batchFiles[batchRunningIndex];
      item.progress = ratio;
      const overall = (batchRunningIndex + ratio) / batchFiles.length;
      const name = item.path.split(/[\\/]/).pop();
      setProgress(
        overall,
        `批量处理 (${batchRunningIndex + 1}/${batchFiles.length}) ${Math.round(ratio * 100)}% · ${name}${fmtEta(overall)}`,
      );
      window.api.setProgressBar(overall);
      const statusEl = document.querySelector(`#batch-list .batch-item[data-idx="${batchRunningIndex}"] .batch-status`);
      if (statusEl) statusEl.textContent = `处理中 ${Math.round(ratio * 100)}%`;
    } else {
      setProgress(ratio, `处理中 ${Math.round(ratio * 100)}%${fmtEta(ratio)}`);
    }
  });
});
