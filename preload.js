'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  // Electron 32+ 已移除 File.path，用 webUtils 拿拖入文件的磁盘路径
  getPath: (file) => webUtils.getPathForFile(file),
  onProgress: (cb) => ipcRenderer.on('task:progress', (_e, payload) => cb(payload)),
  onDone: (cb) => ipcRenderer.on('task:done', (_e, payload) => cb(payload)),
  onError: (cb) => ipcRenderer.on('task:error', (_e, payload) => cb(payload)),
  onCancelled: (cb) => ipcRenderer.on('task:cancelled', (_e, payload) => cb(payload)),
});
