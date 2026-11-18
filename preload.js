'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function toFileUrl(filePath) {
  if (!filePath) return '';
  const normalized = String(filePath).replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/');
  const encoded = parts.map((seg, idx) => (idx === 0 && /^[a-zA-Z]:$/.test(seg) ? seg : encodeURIComponent(seg)));
  return 'file:///' + encoded.join('/');
}

contextBridge.exposeInMainWorld('api', {
  pickFile: (feature, kind) => ipcRenderer.invoke('pick-file', feature, kind),
  pickDir: () => ipcRenderer.invoke('pick-dir'),
  detectHw: () => ipcRenderer.invoke('detect-hw'),
  probe: (filePath) => ipcRenderer.invoke('probe', filePath),
  probeMulti: (filePaths) => ipcRenderer.invoke('probe-multi', filePaths),
  firstFrame: (filePath, timeSec) => ipcRenderer.invoke('first-frame', filePath, timeSec),
  startTask: (feature, params) => ipcRenderer.invoke('task:start', { feature, params }),
  cancelTask: (taskId) => ipcRenderer.invoke('task:cancel', taskId),
  setProgressBar: (ratio) => ipcRenderer.send('set-progress-bar', ratio),
  notifyDone: (title, body) => ipcRenderer.send('notify-done', title, body),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  openFolder: (dirPath) => ipcRenderer.invoke('open-folder', dirPath),
  statFile: (filePath) => ipcRenderer.invoke('stat-file', filePath),
  countDir: (dirPath) => ipcRenderer.invoke('count-dir', dirPath),
  listDir: (dirPath, limit) => ipcRenderer.invoke('list-dir', dirPath, limit),
  copyImage: (filePath) => ipcRenderer.invoke('copy-image', filePath),
  pickSingleImage: () => ipcRenderer.invoke('pick-single-image'),
  replaceExtractedImage: (opts) => ipcRenderer.invoke('replace-extracted-image', opts),
  readClipboardMedia: () => ipcRenderer.invoke('clipboard:read-media'),
  startDrag: (filePath) => ipcRenderer.send('start-drag', filePath),
  toFileUrl,
  // Electron 32+ 已移除 File.path，用 webUtils 拿拖入文件的磁盘路径
  getPath: (file) => webUtils.getPathForFile(file),
  wfCacheInfo: () => ipcRenderer.invoke('wf:cache-info'),
  wfClearCache: () => ipcRenderer.invoke('wf:clear-cache'),
  wfSetCacheDir: (dir) => ipcRenderer.invoke('wf:set-cache-dir', dir),
  wfPruneCache: (opts) => ipcRenderer.invoke('wf:prune-cache', opts),
  wfAllocNodeDir: (opts) => ipcRenderer.invoke('wf:alloc-node-dir', opts),
  wfStatMulti: (filePaths) => ipcRenderer.invoke('wf:stat-multi', filePaths),
  wfScanDir: (opts) => ipcRenderer.invoke('wf:scan-dir', opts),
  wfExportFiles: (opts) => ipcRenderer.invoke('wf:export-files', opts),
  wfExportJson: (opts) => ipcRenderer.invoke('wf:export-json', opts),
  wfImportJson: () => ipcRenderer.invoke('wf:import-json'),
  hotfixStatus: () => ipcRenderer.invoke('hotfix:status'),
  hotfixCheck: (opts) => ipcRenderer.invoke('hotfix:check', opts),
  hotfixApply: (opts) => ipcRenderer.invoke('hotfix:apply', opts),
  hotfixReloadNow: () => ipcRenderer.invoke('hotfix:reload-now'),
  hotfixRelaunch: () => ipcRenderer.invoke('hotfix:relaunch'),
  hotfixRollback: () => ipcRenderer.invoke('hotfix:rollback'),
  openExternal: (url) => ipcRenderer.invoke('hotfix:open-external', url),
  onHotfixProgress: (cb) => ipcRenderer.on('hotfix:progress', (_e, payload) => cb(payload)),
  onProgress: (cb) => ipcRenderer.on('task:progress', (_e, payload) => cb(payload)),
  onDone: (cb) => ipcRenderer.on('task:done', (_e, payload) => cb(payload)),
  onError: (cb) => ipcRenderer.on('task:error', (_e, payload) => cb(payload)),
  onCancelled: (cb) => ipcRenderer.on('task:cancelled', (_e, payload) => cb(payload)),
});
