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

const ALL_MEDIA_EXT = [...VIDEO_EXT, 'gif'];
const AUDIO_EXT = ['mp3', 'm4a', 'wav', 'flac'];
const IMG_EXT = ['jpg', 'jpeg', 'png', 'webp', 'bmp'];

// 各功能对应的文件选择过滤器（multi: 是否允许多选）
const FILE_FILTERS = {
  videoToGif: { exts: VIDEO_EXT },
  gifToVideo: { exts: ['gif'] },
  toWebp: { exts: ALL_MEDIA_EXT },
  convertVideo: { exts: VIDEO_EXT },
  compressGif: { exts: ['gif'] },
  gifText: { exts: ['gif'] },
  compressTarget: { exts: ALL_MEDIA_EXT },
  chromaGif: { exts: ALL_MEDIA_EXT },
  decorateMedia: { exts: ALL_MEDIA_EXT },
  trimVideo: { exts: VIDEO_EXT },
  multiCut: { exts: VIDEO_EXT },
  splitVideo: { exts: VIDEO_EXT },
  mergeVideos: { exts: VIDEO_EXT, multi: true },
  videoCrop: { exts: ALL_MEDIA_EXT },
  autoCrop: { exts: ALL_MEDIA_EXT },
  videoBlur: { exts: ALL_MEDIA_EXT },
  aspectPad: { exts: ALL_MEDIA_EXT },
  pipSplit: { exts: ALL_MEDIA_EXT },
  colorStab: { exts: ALL_MEDIA_EXT },
  watermark: { exts: ALL_MEDIA_EXT },
  subtitleTool: { exts: VIDEO_EXT },
  rotateFlip: { exts: ALL_MEDIA_EXT },
  reverse: { exts: ALL_MEDIA_EXT },
  changeSpeed: { exts: ALL_MEDIA_EXT },
  extractAudio: { exts: [...VIDEO_EXT, ...AUDIO_EXT] },
  audioAdjust: { exts: VIDEO_EXT },
  addMusic: { exts: VIDEO_EXT },
  snapshot: { exts: ALL_MEDIA_EXT },
  contactSheet: { exts: VIDEO_EXT },
  stripMeta: { exts: [...ALL_MEDIA_EXT, ...AUDIO_EXT, ...IMG_EXT] },
  imagesTo: { exts: IMG_EXT, multi: true },
  // 第二文件（背景音乐 / 水印图片 / 分屏副视频 / 外挂字幕）
  audioFile: { exts: ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg'] },
  imageFile: { exts: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] },
  videoGifFile: { exts: ALL_MEDIA_EXT },
  subFile: { exts: ['srt', 'ass', 'ssa', 'vtt'] },
};

const SINGLE_ONLY = new Set(['videoCrop', 'videoBlur', 'multiCut', 'audioFile', 'imageFile', 'videoGifFile', 'subFile']);

ipcMain.handle('pick-file', async (_e, feature, kind) => {
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
    return await ffmpeg.detectHwEncoders();
  } catch {
    return { available: [], primary: null };
  }
});

ipcMain.handle('probe', async (_e, filePath) => {
  try {
    return { ok: true, info: await ffmpeg.probe(filePath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 批量探测（合并/图片序列/批量处理用）
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
  send('task:progress', { ratio: 0 });
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
