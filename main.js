'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification, clipboard, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const hotfix = require('./core/hotfix');

let win = null;
let activeRoot = __dirname;
let currentFfmpeg = null;
let currentFileFilters = null;
let bootConfirmTimer = null;

function loadRuntimeFromRoot(rootDir) {
  const nextFfmpeg = require(path.join(rootDir, 'ffmpeg.js'));
  const nextFilters = require(path.join(rootDir, 'core', 'file-filters.js'));
  return { ffmpeg: nextFfmpeg, filters: nextFilters };
}

function getFfmpeg() {
  if (!currentFfmpeg) {
    const loaded = loadRuntimeFromRoot(activeRoot);
    currentFfmpeg = loaded.ffmpeg;
    currentFileFilters = loaded.filters;
  }
  return currentFfmpeg;
}

function getFileFilters() {
  if (!currentFileFilters) getFfmpeg();
  return currentFileFilters;
}

function activateRuntimeRoot(newRoot, version) {
  const prevRoot = activeRoot;
  const prevFfmpeg = currentFfmpeg;
  const prevFilters = currentFileFilters;
  try {
    if (prevRoot && prevRoot !== __dirname) {
      hotfix.clearRequireCacheUnderRoot(prevRoot);
    } else {
      hotfix.clearRequireCacheUnderRoot(path.join(__dirname, 'core'));
      hotfix.clearRequireCacheUnderRoot(path.join(__dirname, 'modules'));
      delete require.cache[require.resolve(path.join(__dirname, 'ffmpeg.js'))];
    }
    const loaded = loadRuntimeFromRoot(newRoot);
    activeRoot = newRoot;
    currentFfmpeg = loaded.ffmpeg;
    currentFileFilters = loaded.filters;
    if (version) hotfix.activateAppliedRoot(newRoot, version);
    return { ok: true };
  } catch (err) {
    activeRoot = prevRoot;
    currentFfmpeg = prevFfmpeg;
    currentFileFilters = prevFilters;
    throw err;
  }
}

function scheduleBootConfirm() {
  clearTimeout(bootConfirmTimer);
  bootConfirmTimer = setTimeout(() => {
    try { hotfix.confirmBoot(); } catch {}
  }, 1500);
}

function getStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    const data = JSON.parse(fs.readFileSync(getStateFile(), 'utf8'));
    if (data && typeof data.width === 'number' && typeof data.height === 'number') {
      return {
        width: Math.max(960, data.width),
        height: Math.max(640, data.height),
        x: typeof data.x === 'number' ? data.x : undefined,
        y: typeof data.y === 'number' ? data.y : undefined,
        maximized: !!data.maximized,
      };
    }
  } catch {}
  return { width: 1180, height: 780 };
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    const maximized = win.isMaximized();
    const bounds = maximized ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(getStateFile(), JSON.stringify({ ...bounds, maximized }), 'utf8');
  } catch {}
}

function createWindow() {
  const state = loadWindowState();
  win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (state.maximized) win.maximize();
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(activeRoot, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    console.log('[main] renderer loaded OK:', activeRoot);
    scheduleBootConfirm();
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] renderer gone:', details.reason);
    clearTimeout(bootConfirmTimer);
    const st = hotfix.getStatus();
    if (st?.isHotfix) {
      const rolled = hotfix.rollbackToPrevious(st.activeVersion);
      if (rolled?.activeRoot && rolled.activeRoot !== activeRoot) {
        try {
          activateRuntimeRoot(rolled.activeRoot, rolled.activeVersion);
          if (win && !win.isDestroyed()) {
            win.loadFile(path.join(activeRoot, 'renderer', 'index.html'));
          }
        } catch {}
      }
    }
  });

  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWindowState, 250);
  };
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);

  win.on('close', (e) => {
    saveWindowState();
    if (getFfmpeg().hasRunningTasks()) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['继续在后台处理', '停止任务并退出'],
        defaultId: 0,
        cancelId: 0,
        title: '有任务正在运行',
        message: '当前还有视频/GIF 处理任务未完成，关闭窗口会中断处理。确定要退出吗？',
      });
      if (choice === 0) {
        e.preventDefault();
        return;
      }
      getFfmpeg().cancelAllTasks();
    }
  });
}

// 单实例：重复启动时退出自己，并让已有窗口还原、聚焦
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

app.whenReady().then(() => {
  if (!gotSingleLock) return;
  try {
    const status = hotfix.initHotfix({
      shellRoot: __dirname,
      userDataDir: app.getPath('userData'),
    });
    activeRoot = status.activeRoot || __dirname;
    try {
      activateRuntimeRoot(activeRoot);
    } catch (err) {
      console.error('[main] hotfix load failed, rolling back to builtin:', err);
      const rolled = hotfix.rollbackToPrevious(status.activeVersion);
      activeRoot = rolled?.activeRoot || __dirname;
      activateRuntimeRoot(activeRoot);
    }
  } catch (err) {
    console.error('[main] hotfix init failed:', err);
    activeRoot = __dirname;
    activateRuntimeRoot(__dirname);
  }

  try {
    getFfmpeg().ensureBinaries();
  } catch (err) {
    console.error('[main] ensureBinaries failed:', err);
    dialog.showErrorBox('FFmpeg 初始化失败', err.message);
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('pick-file', async (_e, feature, kind) => {
  const { FILE_FILTERS, SINGLE_ONLY } = getFileFilters();
  const targetKey = kind || feature;
  const cfg = FILE_FILTERS[targetKey] || { exts: ['*'] };
  const filters = [
    { name: '支持的文件', extensions: cfg.exts },
    { name: '所有文件', extensions: ['*'] },
  ];
  const properties = ['openFile'];
  const allowMulti = cfg.multi || !SINGLE_ONLY.has(targetKey);
  if (allowMulti) properties.push('multiSelections');
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties, filters });
  if (canceled || !filePaths.length) return null;
  return allowMulti ? filePaths : filePaths[0];
});

ipcMain.handle('pick-dir', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths.length) return null;
  return filePaths[0];
});

ipcMain.handle('detect-hw', async () => {
  try {
    return await getFfmpeg().detectHwEncoders();
  } catch {
    return { available: [], primary: null };
  }
});

ipcMain.handle('probe', async (_e, filePath) => {
  try {
    return { ok: true, info: await getFfmpeg().probe(filePath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 批量探测（合并/图片序列/批量处理用）
ipcMain.handle('probe-multi', async (_e, filePaths) => {
  const ff = getFfmpeg();
  const results = [];
  for (const p of filePaths) {
    try {
      results.push({ path: p, info: await ff.probe(p) });
    } catch {
      results.push({ path: p, info: null });
    }
  }
  return results;
});

// 提取指定时间点画面为 dataURL（可视化裁剪 / 打码 / 吸管取色用；静态图片不传 -ss）
ipcMain.handle('first-frame', (_e, filePath, timeSec = 0.1) => {
  return new Promise((resolve) => {
    const ff = getFfmpeg();
    const { IMG_EXT } = getFileFilters();
    try {
      ff.ensureBinaries();
    } catch {
      return resolve(null);
    }
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const isImg = IMG_EXT.includes(ext);
    const t = !isImg && Number.isFinite(parseFloat(timeSec)) ? Math.max(0, parseFloat(timeSec)) : 0;
    const args = ['-hide_banner'];
    if (t > 0) args.push('-ss', t.toFixed(2));
    args.push('-i', filePath, '-vf', "scale='min(640,iw)':-1", '-frames:v', '1', '-f', 'image2', 'pipe:1');
    const child = spawn(ff.FFMPEG, args, { windowsHide: true });
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0 || !chunks.length) return resolve(null);
      resolve(`data:image/png;base64,${Buffer.concat(chunks).toString('base64')}`);
    });
  });
});

ipcMain.handle('task:start', async (_e, { feature, params }) => {
  const taskId = `t${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const send = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, { taskId, ...payload });
  };
  send('task:progress', { ratio: 0 });
  if (win && !win.isDestroyed() && !params?.__batchItem) win.setProgressBar(0);
  try {
    const result = await getFfmpeg().executeTask(taskId, feature, params, (ratio) => {
      send('task:progress', { ratio });
      if (win && !win.isDestroyed() && !params?.__batchItem) {
        win.setProgressBar(Math.max(0, Math.min(1, ratio)));
      }
    });
    const payload = {
      output: result.output,
      outputType: result.outputType || 'file',
      targetReached: result.targetReached,
      targetMB: result.targetMB,
      ...(result.extractSummary ? { extractSummary: result.extractSummary } : {}),
      ...(result.docCompressSummary ? { docCompressSummary: result.docCompressSummary } : {}),
      ...(result.docRepackSummary ? { docRepackSummary: result.docRepackSummary } : {}),
      ...(result.docCleanupSummary ? { docCleanupSummary: result.docCleanupSummary } : {}),
      ...(result.docStyleSummary ? { docStyleSummary: result.docStyleSummary } : {}),
      ...(result.mdOrganizeSummary ? { mdOrganizeSummary: result.mdOrganizeSummary } : {}),
      ...(result.pdfSummary ? { pdfSummary: result.pdfSummary } : {}),
    };
    if (win && !win.isDestroyed() && !params?.__batchItem) win.setProgressBar(-1);
    send('task:done', payload);
    return { ok: true, taskId, ...payload };
  } catch (err) {
    const cancelled = err.message === '任务已取消';
    if (win && !win.isDestroyed() && !params?.__batchItem) win.setProgressBar(-1);
    send(cancelled ? 'task:cancelled' : 'task:error', { error: err.message });
    return { ok: false, cancelled, error: err.message, taskId };
  }
});

ipcMain.handle('task:cancel', (_e, taskId) => getFfmpeg().cancelTask(taskId));

ipcMain.on('set-progress-bar', (_e, ratio) => {
  if (win && !win.isDestroyed()) {
    win.setProgressBar(typeof ratio === 'number' && ratio >= 0 ? Math.min(1, ratio) : -1);
  }
});

ipcMain.on('notify-done', (_e, title, body) => {
  if (win && !win.isDestroyed() && !win.isFocused() && Notification.isSupported()) {
    new Notification({ title: title || '视频 · GIF 工具箱', body: body || '处理已完成' }).show();
  }
});

ipcMain.handle('show-in-folder', (_e, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('open-folder', (_e, dirPath) => {
  shell.openPath(dirPath);
});

ipcMain.handle('stat-file', (_e, filePath) => {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
});

// 统计目录内文件数（帧序列导出用）
ipcMain.handle('count-dir', (_e, dirPath) => {
  try {
    return fs.readdirSync(dirPath).filter((f) => !f.startsWith('.')).length;
  } catch {
    return 0;
  }
});

ipcMain.handle('list-dir', (_e, dirPath, limit = 6) => {
  try {
    return fs.readdirSync(dirPath)
      .filter((f) => !f.startsWith('.'))
      .slice(0, limit)
      .map((f) => path.join(dirPath, f));
  } catch {
    return [];
  }
});

ipcMain.handle('copy-image', (_e, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: '文件不存在' };
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (ext === 'svg') {
      clipboard.writeText(fs.readFileSync(filePath, 'utf8'));
      return { ok: true, mode: 'svg-text' };
    }
    const img = nativeImage.createFromPath(filePath);
    if (!img.isEmpty()) {
      clipboard.writeImage(img);
      return { ok: true, mode: 'image' };
    }
    return { ok: false, error: '当前图片格式暂不支持直接复制位图' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

const REPLACE_IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif', 'gif', 'tif', 'tiff']);

ipcMain.handle('pick-single-image', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择用于替换的截图或图片',
    properties: ['openFile'],
    filters: [
      { name: '图片文件', extensions: [...REPLACE_IMG_EXTS] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  return res.canceled ? null : res.filePaths[0];
});

function readClipboardFilePath() {
  try {
    const raw = clipboard.readBuffer('FileNameW');
    if (raw && raw.length >= 2) {
      const decoded = raw.toString('utf16le').split('\0')[0].trim();
      if (decoded && fs.existsSync(decoded)) return decoded;
    }
  } catch {}
  try {
    const txt = clipboard.readText().trim().replace(/^"(.*)"$/, '$1');
    if (txt && fs.existsSync(txt) && fs.statSync(txt).isFile()) return txt;
  } catch {}
  return '';
}

ipcMain.handle('replace-extracted-image', (_e, opts = {}) => {
  try {
    const targetPath = path.resolve(String(opts.targetPath || ''));
    if (!targetPath || !fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
      return { ok: false, error: '目标提取图片文件不存在' };
    }

    let buf = null;
    let newExt = 'png';

    if (opts.sourcePath) {
      const srcPath = path.resolve(String(opts.sourcePath));
      if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) {
        return { ok: false, error: '所选替换图片不存在' };
      }
      const ext = path.extname(srcPath).slice(1).toLowerCase();
      if (!REPLACE_IMG_EXTS.has(ext)) {
        return { ok: false, error: `不支持的图片格式 (.${ext || '未知'})` };
      }
      buf = fs.readFileSync(srcPath);
      newExt = ext === 'jpeg' ? 'jpg' : ext;
    } else if (opts.fromClipboard) {
      const clipImg = clipboard.readImage();
      if (clipImg && !clipImg.isEmpty()) {
        buf = clipImg.toPNG();
        newExt = 'png';
      } else {
        const clipFile = readClipboardFilePath();
        if (clipFile) {
          const ext = path.extname(clipFile).slice(1).toLowerCase();
          if (!REPLACE_IMG_EXTS.has(ext)) {
            return { ok: false, error: `剪贴板中的文件不是支持的图片格式 (.${ext || '未知'})` };
          }
          buf = fs.readFileSync(clipFile);
          newExt = ext === 'jpeg' ? 'jpg' : ext;
        }
      }
      if (!buf || !buf.length) {
        return { ok: false, error: '剪贴板里没有截图或图片（请先截图复制，或直接把截图拖到卡片上）' };
      }
    } else {
      return { ok: false, error: '未提供替换图片来源' };
    }

    const dir = path.dirname(targetPath);
    const stem = path.basename(targetPath, path.extname(targetPath));
    const oldExt = path.extname(targetPath).slice(1).toLowerCase();
    const normOldExt = oldExt === 'jpeg' ? 'jpg' : oldExt;
    const newPath = newExt === normOldExt ? targetPath : path.join(dir, `${stem}.${newExt}`);

    fs.writeFileSync(newPath, buf);
    if (path.resolve(newPath).toLowerCase() !== path.resolve(targetPath).toLowerCase() && fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
    return { ok: true, newPath, replacedName: path.basename(newPath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

const FALLBACK_DRAG_ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
);

ipcMain.on('start-drag', (e, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return;
    let icon = nativeImage.createFromPath(filePath);
    if (icon.isEmpty()) icon = FALLBACK_DRAG_ICON;
    else icon = icon.resize({ width: 64, quality: 'good' });
    e.sender.startDrag({ file: filePath, icon });
  } catch {}
});

// ---------------------------------------------------------------------------
// 节点工作流缓存与导入导出 IPC
// ---------------------------------------------------------------------------

function isCDrivePath(p) {
  return /^c:/i.test(path.resolve(String(p || '')));
}

function getWorkflowCacheDir() {
  const candidates = [];
  if (app.isPackaged) {
    const exeDir = path.dirname(process.execPath);
    if (!isCDrivePath(exeDir)) candidates.push(path.join(exeDir, '.workflow_cache'));
  } else {
    if (!isCDrivePath(__dirname)) candidates.push(path.join(__dirname, '.workflow_cache'));
  }
  if (fs.existsSync('D:\\')) {
    candidates.push('D:\\temp\\vgt-workflow-cache');
  }
  if (app.isPackaged) {
    candidates.push(path.join(app.getPath('temp'), 'vgt-workflow-cache'));
    candidates.push(path.join(app.getPath('userData'), 'workflow_cache'));
  } else if (!candidates.length) {
    candidates.push(path.join(__dirname, '.workflow_cache'));
  }

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probeFile = path.join(dir, `.probe_${process.pid}`);
      fs.writeFileSync(probeFile, '1');
      fs.unlinkSync(probeFile);
      return dir;
    } catch {}
  }
  const fallback = app.isPackaged
    ? path.join(app.getPath('temp'), 'vgt-workflow-cache')
    : path.join(__dirname, '.workflow_cache');
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

function statDirRecursive(dir) {
  let sizeBytes = 0;
  let fileCount = 0;
  const walk = (cur) => {
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        try {
          sizeBytes += fs.statSync(full).size;
          fileCount++;
        } catch {}
      }
    }
  };
  walk(dir);
  return { sizeBytes, fileCount };
}

function uniqueExportPath(targetPath, noOverwrite) {
  if (!noOverwrite || !fs.existsSync(targetPath)) return targetPath;
  const ext = path.extname(targetPath);
  const stem = targetPath.slice(0, targetPath.length - ext.length);
  let i = 1;
  while (fs.existsSync(`${stem}_${i}${ext}`)) i++;
  return `${stem}_${i}${ext}`;
}

function uniqueExportDir(baseDir, folderName, noOverwrite) {
  const cleanName = String(folderName || 'workflow_export').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'workflow_export';
  let cand = path.join(baseDir, cleanName);
  if (!noOverwrite || !fs.existsSync(cand)) return cand;
  let i = 1;
  while (fs.existsSync(path.join(baseDir, `${cleanName}_${i}`))) i++;
  return path.join(baseDir, `${cleanName}_${i}`);
}

ipcMain.handle('wf:cache-info', () => {
  const dir = getWorkflowCacheDir();
  const { sizeBytes, fileCount } = statDirRecursive(dir);
  return { dir, sizeBytes, fileCount };
});

ipcMain.handle('wf:clear-cache', () => {
  if (getFfmpeg().hasRunningTasks()) {
    return { ok: false, error: '有任务正在运行，无法清理缓存' };
  }
  const dir = getWorkflowCacheDir();
  try {
    for (const name of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
    fs.mkdirSync(dir, { recursive: true });
    return { ok: true, dir };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('wf:alloc-node-dir', (_e, opts = {}) => {
  const cacheRoot = getWorkflowCacheDir();
  const rawKey = String(opts.subKey || `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  const cleanKey = rawKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'node';
  const dir = path.join(cacheRoot, `node_${cleanKey}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  if (opts.manifestDir) {
    const srcManifest = path.join(opts.manifestDir, '.vgt-manifest.json');
    if (fs.existsSync(srcManifest)) {
      try {
        fs.copyFileSync(srcManifest, path.join(dir, '.vgt-manifest.json'));
      } catch {}
    }
  }
  return { ok: true, dir };
});

ipcMain.handle('wf:stat-multi', (_e, filePaths) => {
  const list = Array.isArray(filePaths) ? filePaths : [];
  return list.map((p) => {
    try {
      const st = fs.statSync(p);
      return { path: p, exists: true, isDirectory: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return { path: p, exists: false, isDirectory: false, size: 0, mtimeMs: 0 };
    }
  });
});

ipcMain.handle('wf:scan-dir', (_e, opts = {}) => {
  const dirPath = String(opts.dirPath || '').trim();
  if (!dirPath || !fs.existsSync(dirPath)) {
    return { ok: false, error: '所选文件夹不存在', files: [] };
  }
  try {
    if (!fs.statSync(dirPath).isDirectory()) {
      return { ok: false, error: '目标路径不是文件夹', files: [] };
    }
  } catch (err) {
    return { ok: false, error: err.message, files: [] };
  }

  const recursive = !!opts.recursive;
  const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 500));
  const rawExts = Array.isArray(opts.extensions) ? opts.extensions.map((e) => String(e).toLowerCase()) : ['*'];
  const allowAll = !rawExts.length || rawExts.includes('*');
  const extSet = new Set(rawExts);
  if (extSet.has('jpg')) extSet.add('jpeg');
  if (extSet.has('md')) extSet.add('markdown');

  const files = [];
  let truncated = false;
  const walk = (curDir) => {
    if (files.length >= limit) { truncated = true; return; }
    let entries;
    try { entries = fs.readdirSync(curDir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    for (const ent of entries) {
      if (files.length >= limit) { truncated = true; return; }
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const full = path.join(curDir, ent.name);
      if (ent.isDirectory()) {
        if (recursive) walk(full);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).slice(1).toLowerCase();
        if (allowAll || (ext && extSet.has(ext))) {
          files.push(full);
        }
      }
    }
  };
  walk(dirPath);
  return { ok: true, dir: dirPath, files, truncated };
});

ipcMain.handle('wf:export-files', (_e, opts = {}) => {
  const files = Array.isArray(opts.files) ? opts.files.filter((f) => f && fs.existsSync(f)) : [];
  if (!files.length) return { ok: false, error: '没有可导出的输出文件' };

  const baseRef = opts.originInputPath || files[0];
  let targetDir;
  if (opts.outMode === 'custom' && opts.customDir) {
    targetDir = opts.customDir;
  } else if (opts.outMode === 'subdir') {
    targetDir = path.join(path.dirname(baseRef), 'output');
  } else {
    targetDir = path.dirname(baseRef);
  }
  fs.mkdirSync(targetDir, { recursive: true });

  const noOverwrite = opts.noOverwrite !== false;
  const prefix = String(opts.prefix || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const suffix = String(opts.suffix || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  let destDir = targetDir;

  if (opts.exportAsFolder && files.length > 1) {
    const defaultFolder = opts.folderName
      || `${path.basename(baseRef, path.extname(baseRef))}_工作流输出`;
    destDir = uniqueExportDir(targetDir, defaultFolder, noOverwrite);
    fs.mkdirSync(destDir, { recursive: true });
  }

  const savedPaths = [];
  let totalSize = 0;
  for (const src of files) {
    const ext = path.extname(src);
    const stem = path.basename(src, ext);
    const outName = `${prefix}${stem}${suffix}${ext}`;
    const dest = uniqueExportPath(path.join(destDir, outName), noOverwrite);
    if (path.resolve(src).toLowerCase() === path.resolve(dest).toLowerCase()) {
      savedPaths.push(dest);
      totalSize += fs.statSync(dest).size;
      continue;
    }
    fs.copyFileSync(src, dest);
    savedPaths.push(dest);
    try { totalSize += fs.statSync(dest).size; } catch {}
  }

  if (opts.manifestDir) {
    const manifestSrc = path.join(opts.manifestDir, '.vgt-manifest.json');
    if (fs.existsSync(manifestSrc)) {
      try { fs.copyFileSync(manifestSrc, path.join(destDir, '.vgt-manifest.json')); } catch {}
    }
  }

  return { ok: true, savedPaths, targetDir: destDir, totalSize };
});

ipcMain.handle('wf:export-json', async (_e, opts = {}) => {
  const defaultName = String(opts.defaultName || 'workflow').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') + '.json';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出工作流配置',
    defaultPath: defaultName,
    filters: [{ name: '工作流 JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  fs.writeFileSync(filePath, String(opts.content || '{}'), 'utf8');
  return { ok: true, filePath };
});

ipcMain.handle('wf:import-json', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '导入工作流配置',
    properties: ['openFile'],
    filters: [{ name: '工作流 JSON', extensions: ['json'] }, { name: '所有文件', extensions: ['*'] }],
  });
  if (canceled || !filePaths.length) return { canceled: true };
  const filePath = filePaths[0];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { ok: true, filePath, data };
  } catch (err) {
    return { ok: false, error: `JSON 解析失败：${err.message}` };
  }
});

// ---------------------------------------------------------------------------
// 业务热更新 IPC
// ---------------------------------------------------------------------------

ipcMain.handle('hotfix:status', () => hotfix.getStatus());

ipcMain.handle('hotfix:check', async (_e, opts = {}) => {
  try {
    return await hotfix.checkForUpdates(opts);
  } catch (err) {
    return { ok: false, error: err?.message || '检查更新失败' };
  }
});

ipcMain.handle('hotfix:apply', async (_e, opts = {}) => {
  try {
    const manifest = opts.manifest;
    if (!manifest) return { ok: false, error: '缺少更新清单参数' };

    const sendProgress = (p) => {
      if (win && !win.isDestroyed()) win.webContents.send('hotfix:progress', p);
    };

    const res = await hotfix.downloadAndInstall(manifest, {
      mirror: opts.mirror || 'auto',
      preferredMirror: opts.preferredMirror || '',
      onProgress: sendProgress,
      validateBundleFn: (stagingDir) => {
        const loaded = loadRuntimeFromRoot(stagingDir);
        if (!loaded?.ffmpeg?.executeTask || !loaded?.filters?.FILE_FILTERS) {
          throw new Error('热更新包缺少有效的任务执行器或文件过滤器');
        }
      },
    });

    if (getFfmpeg().hasRunningTasks()) {
      hotfix.setPendingRestart(true);
      return { ok: true, version: res.version, busy: true, needsReload: true, status: hotfix.getStatus() };
    }

    activateRuntimeRoot(res.releaseDir, res.version);
    if (win && !win.isDestroyed()) {
      setTimeout(() => {
        if (win && !win.isDestroyed()) {
          win.loadFile(path.join(activeRoot, 'renderer', 'index.html'));
        }
      }, 150);
    }
    return { ok: true, version: res.version, reloaded: true, status: hotfix.getStatus() };
  } catch (err) {
    return { ok: false, error: err?.message || '热更新安装失败' };
  }
});

ipcMain.handle('hotfix:reload-now', () => {
  if (getFfmpeg().hasRunningTasks()) {
    return { ok: false, error: '有任务正在运行，请等待任务结束后再刷新生效' };
  }
  const st = hotfix.getStatus();
  if (!st?.activeRoot) return { ok: false, error: '没有可生效的更新目录' };
  try {
    activateRuntimeRoot(st.activeRoot, st.activeVersion);
    if (win && !win.isDestroyed()) {
      win.loadFile(path.join(activeRoot, 'renderer', 'index.html'));
    }
    return { ok: true };
  } catch (err) {
    const rolled = hotfix.rollbackToPrevious(st.activeVersion);
    if (rolled?.activeRoot) {
      activateRuntimeRoot(rolled.activeRoot, rolled.activeVersion);
    }
    return { ok: false, error: `加载新版本失败，已自动回滚：${err.message}` };
  }
});

ipcMain.handle('hotfix:relaunch', () => {
  if (getFfmpeg().hasRunningTasks()) {
    return { ok: false, error: '有任务正在运行，无法立即重启' };
  }
  app.relaunch();
  app.exit(0);
  return { ok: true };
});

ipcMain.handle('hotfix:rollback', () => {
  if (getFfmpeg().hasRunningTasks()) {
    return { ok: false, error: '有任务正在运行，请等待任务结束后再回滚' };
  }
  try {
    const st = hotfix.rollbackToBuiltin();
    activateRuntimeRoot(st.activeRoot);
    if (win && !win.isDestroyed()) {
      win.loadFile(path.join(activeRoot, 'renderer', 'index.html'));
    }
    return { ok: true, status: st };
  } catch (err) {
    return { ok: false, error: err?.message || '回滚失败' };
  }
});

ipcMain.handle('hotfix:open-external', async (_e, targetUrl) => {
  const u = String(targetUrl || '').trim();
  if (!/^https:\/\//i.test(u)) return { ok: false, error: '仅允许打开 HTTPS 链接' };
  await shell.openExternal(u);
  return { ok: true };
});

