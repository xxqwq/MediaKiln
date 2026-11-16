'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpeg = require('./ffmpeg');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
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
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => console.log('[main] renderer loaded OK'));
  win.webContents.on('render-process-gone', (_e, details) => console.error('[main] renderer gone:', details.reason));
}

app.whenReady().then(() => {
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

const VIDEO_EXT = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'ts', 'm4v'];

// 各功能对应的文件选择过滤器（multi: 是否允许多选）
const FILE_FILTERS = {
  videoToGif: { exts: VIDEO_EXT },
  gifToVideo: { exts: ['gif'] },
  toWebp: { exts: [...VIDEO_EXT, 'gif'] },
  convertVideo: { exts: VIDEO_EXT },
  compressGif: { exts: ['gif'] },
  gifText: { exts: ['gif'] },
  compressTarget: { exts: [...VIDEO_EXT, 'gif'] },
  trimVideo: { exts: VIDEO_EXT },
  mergeVideos: { exts: VIDEO_EXT, multi: true },
  videoCrop: { exts: [...VIDEO_EXT, 'gif'] },
  videoBlur: { exts: [...VIDEO_EXT, 'gif'] },
  aspectPad: { exts: [...VIDEO_EXT, 'gif'] },
  watermark: { exts: [...VIDEO_EXT, 'gif'] },
  rotateFlip: { exts: [...VIDEO_EXT, 'gif'] },
  reverse: { exts: [...VIDEO_EXT, 'gif'] },
  changeSpeed: { exts: [...VIDEO_EXT, 'gif'] },
  extractAudio: { exts: [...VIDEO_EXT, 'mp3', 'm4a', 'wav', 'flac'] },
  audioAdjust: { exts: VIDEO_EXT },
  addMusic: { exts: VIDEO_EXT },
  snapshot: { exts: [...VIDEO_EXT, 'gif'] },
  imagesTo: { exts: ['jpg', 'jpeg', 'png', 'webp', 'bmp'], multi: true },
  // 第二文件（背景音乐 / 水印图片）
  audioFile: { exts: ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg'] },
  imageFile: { exts: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] },
};

ipcMain.handle('pick-file', async (_e, feature, kind) => {
  const cfg = FILE_FILTERS[kind || feature] || { exts: ['*'] };
  const filters = [
    { name: '支持的文件', extensions: cfg.exts },
    { name: '所有文件', extensions: ['*'] },
  ];
  const properties = ['openFile'];
  if (cfg.multi) properties.push('multiSelections');
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties, filters });
  if (canceled || !filePaths.length) return null;
  return cfg.multi ? filePaths : filePaths[0];
});

ipcMain.handle('probe', async (_e, filePath) => {
  try {
    return { ok: true, info: await ffmpeg.probe(filePath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 批量探测（合并/图片序列用）
ipcMain.handle('probe-multi', async (_e, filePaths) => {
  const results = [];
  for (const p of filePaths) {
    try {
      results.push({ path: p, info: await ffmpeg.probe(p) });
    } catch {
      results.push({ path: p, info: null });
    }
  }
  return results;
});

// 提取首帧为 dataURL（可视化裁剪画布用）
ipcMain.handle('first-frame', (_e, filePath) => {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg.FFMPEG, [
      '-hide_banner', '-ss', '0.1', '-i', filePath,
      '-vf', 'scale=400:-2', '-frames:v', '1', '-f', 'image2', 'pipe:1',
    ], { windowsHide: true });
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
  const send = (channel, payload) => win?.webContents.send(channel, { taskId, ...payload });
  try {
    const result = await ffmpeg.executeTask(taskId, feature, params, (ratio) => {
      send('task:progress', { ratio });
    });
    const payload = {
      output: result.output,
      outputType: result.outputType || 'file',
      targetReached: result.targetReached,
      targetMB: result.targetMB,
    };
    send('task:done', payload);
    return { ok: true, taskId, ...payload };
  } catch (err) {
    const cancelled = err.message === '任务已取消';
    send(cancelled ? 'task:cancelled' : 'task:error', { error: err.message });
    return { ok: false, cancelled, error: err.message, taskId };
  }
});

ipcMain.handle('task:cancel', (_e, taskId) => ffmpeg.cancelTask(taskId));

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
