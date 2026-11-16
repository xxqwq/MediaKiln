'use strict';

const IMG_EXTS = window.VGT.IMG_EXTS;
const FEATURES = [...window.VGT.VIDEO_FEATURES, ...window.VGT.IMAGE_FEATURES, ...(window.VGT.SVG_FEATURES || [])];
const GROUP_ORDER = ['转换', 'GIF 编辑', '图片', 'SVG', '剪辑', '音频', '工具'];

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let currentFeature = FEATURES[0];
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
      if (info.duration > 5) chips.appendChild(mk('前 5 秒', 0, 5));
      if (info.duration > 10) chips.appendChild(mk('前 10 秒', 0, 10));
    }
  }
}

function renderFileCard(ext) {
  const info = file.info;
  const isImg = info.isImage || ext === 'svg' || IMG_EXTS.includes(ext);
  $('dropzone').classList.add('hidden');
  $('file-card').classList.remove('hidden');
  $('file-name').textContent = file.path.split(/[\\/]/).pop();
  $('file-name').title = file.path;

  const parts = [];
  if (info.isSvg) parts.push('SVG 矢量图');
  if (info.width) parts.push(`分辨率 ${info.width}×${info.height}`);
  if (!isImg && info.duration > 0) parts.push(`时长 ${fmtDur(info.duration)}`);
  if (!isImg && info.fps > 0) parts.push(`${Math.round(info.fps)} fps`);
  parts.push(`大小 ${fmtSize(info.size)}`);
  if (!isImg && !['mp3', 'm4a', 'wav', 'flac'].includes(ext)) {
    parts.push(info.hasAudio ? '含音轨' : '无音轨');
  }
  $('file-info').textContent = parts.join(' · ');

  const box = $('preview-box');
  box.innerHTML = '';
  box.style.display = '';
  const url = encodeURI('file:///' + file.path.replace(/\\/g, '/'));
  const zoomBtn = $('btn-zoom-preview');
  if (ext === 'gif' || ext === 'webp' || ext === 'svg' || IMG_EXTS.includes(ext)) {
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

  const showPctIds = new Set(['compressGif', 'imageConvert', 'imageCompressTarget', 'compressTarget', 'svgOptimize', 'imageToSvg']);

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
        statusEl.textContent = '✅ 已导出';
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
    if (['compressGif', 'compressTarget', 'imageConvert', 'imageCompressTarget', 'svgOptimize'].includes(currentFeature.id)) {
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
  showResult(kind, `${title}<div class="result-actions">${openBtnHtml}<button class="btn btn-ghost btn-sm" id="btn-again">重新准备</button></div>`);

  if (firstOut) {
    $('btn-open').onclick = () =>
      firstOut.outputType === 'dir'
        ? window.api.openFolder(firstOut.output)
        : window.api.showInFolder(firstOut.output);
  }
  $('btn-again').onclick = () => {
    useFiles(batchFiles.map((b) => b.path)).then(() => {});
  };
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
  if (res.outputType === 'dir') {
    const count = await window.api.countDir(res.output);
    const unitLabel = currentFeature.id === 'splitVideo' ? '个片段' : (currentFeature.id === 'imageSplit' ? '张切图' : '张图片');
    line = `✅ 已导出 ${count} ${unitLabel}到文件夹`;
  } else {
    outSize = await window.api.statFile(res.output);
    line = `✅ 完成：${escHtml(name)}（${fmtSize(outSize)}）`;
    if ((currentFeature.id === 'compressGif' || currentFeature.id === 'imageConvert' || currentFeature.id === 'svgOptimize') && file?.info.size) {
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
  if (res.outputType === 'dir') {
    if (currentFeature.id !== 'splitVideo') {
      thumbPaths = (await window.api.listDir(res.output, 16))
        .filter((p) => ['png', 'jpg', 'jpeg', 'webp'].includes(p.split('.').pop().toLowerCase()));
      if (thumbPaths.length) {
        previewHtml = `<div class="result-preview-wrap" id="result-preview-wrap"><div class="result-thumb-strip">${
          thumbPaths.slice(0, 9).map((p, idx) => {
            const u = encodeURI('file:///' + p.replace(/\\/g, '/'));
            const fn = escHtml(p.split(/[\\/]/).pop());
            return `<img src="${u}" data-thumb-idx="${idx}" title="点击放大查看：${fn}" alt="${fn}" />`;
          }).join('')
        }</div></div>`;
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

  const handoffFeatures = res.outputType === 'file'
    ? FEATURES.filter((f) => !f.multi && f.id !== currentFeature.id && f.accept.includes(outExt))
    : [];
  const handoffHtml = handoffFeatures.length
    ? `<div class="result-handoff">
         <span class="muted" style="font-size:12px">➡️ 继续处理此结果：</span>
         <select id="handoff-feature">
           ${handoffFeatures.map((f) => `<option value="${f.id}">${f.icon} ${escHtml(f.name)}</option>`).join('')}
         </select>
         <button class="btn btn-ghost btn-sm" id="btn-handoff">发送处理</button>
       </div>`
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
    <button class="btn btn-ghost btn-sm" id="btn-again">再来一次</button></div>${handoffHtml}`);

  $('btn-open').onclick = () =>
    res.outputType === 'dir' ? window.api.openFolder(res.output) : window.api.showInFolder(res.output);
  $('btn-again').onclick = () => {
    if (currentFeature.multi || !file?.path) return clearFile();
    useFile(file.path).then(() => {});
  };

  const openSingleLightbox = (idx = 0) => {
    if (thumbPaths.length) {
      window.VGT.lightbox?.openSingle({
        list: thumbPaths.map((p) => ({ path: p, label: p.split(/[\\/]/).pop() })),
        index: idx,
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

  const bindPreviewClicks = (comparing) => {
    const wrap = $('result-preview-wrap');
    if (!wrap) return;
    if (thumbPaths.length) {
      wrap.querySelectorAll('img[data-thumb-idx]').forEach((img) => {
        img.onclick = () => openSingleLightbox(Number(img.dataset.thumbIdx) || 0);
      });
      return;
    }
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

  if (handoffFeatures.length) {
    $('btn-handoff').onclick = async () => {
      if (running) return toast('有任务正在进行中', true);
      const target = FEATURES.find((f) => f.id === $('handoff-feature').value);
      if (!target) return;
      selectFeature(target, { forceClear: true });
      await useFile(res.output);
      toast(`已将结果发送至「${target.name}」`);
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
    e.preventDefault();
    dz.classList.add('dragover');
  });
  document.body.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) dz.classList.remove('dragover');
  });
  document.body.addEventListener('drop', async (e) => {
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
  renderNav();
  selectFeature(FEATURES[0]);
  bindEvents();
  window.api.onProgress(({ taskId, ratio }) => {
    currentTaskId = taskId;
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
