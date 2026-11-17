'use strict';

// 无头 Electron UI 校验脚本：加载真实 renderer/index.html 与 preload.js，检查 CSP、控制台错误及双模式/画布/模板渲染
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function registerStubIpc() {
  ipcMain.handle('detect-hw', () => ({ available: [], primary: null }));
  ipcMain.handle('wf:cache-info', () => ({ dir: path.join(ROOT, '.workflow_cache'), sizeBytes: 0, fileCount: 0 }));
  ipcMain.handle('wf:clear-cache', () => ({ ok: true }));
  ipcMain.handle('wf:alloc-node-dir', (_e, o) => ({ ok: true, dir: path.join(ROOT, '.workflow_cache', o?.subKey || 'test') }));
  ipcMain.handle('wf:stat-multi', () => []);
  ipcMain.handle('probe', () => ({ ok: false, error: 'stub' }));
  ipcMain.handle('probe-multi', () => []);
  ipcMain.on('set-progress-bar', () => {});
  ipcMain.on('notify-done', () => {});
}

app.whenReady().then(async () => {
  registerStubIpc();

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 820,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 3) {
      errors.push(`[console:${level}] ${message} (${sourceId}:${line})`);
    }
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    errors.push(`[render-gone] ${details.reason}`);
  });

  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));

  try {
    const result = await win.webContents.executeJavaScript(`(async () => {
      await new Promise((r) => setTimeout(r, 120));
      const modeBtnWf = document.getElementById('mode-btn-workflow');
      const modeBtnSingle = document.getElementById('mode-btn-single');
      if (!modeBtnWf || !modeBtnSingle) throw new Error('模式切换按钮缺失');

      // 1. 切换到节点画布模式
      modeBtnWf.click();
      await new Promise((r) => setTimeout(r, 120));
      const paletteCount = document.querySelectorAll('#nav .wf-node-tpl').length;
      if (paletteCount !== 50) throw new Error('侧栏工作流节点数异常: ' + paletteCount);

      // 2. 依次载入 6 套模板并校验节点、连线与自动整理
      const tplCount = window.VGT.wfTemplates.WORKFLOW_TEMPLATES.length;
      if (tplCount !== 6) throw new Error('预设模板数量异常: ' + tplCount);

      for (let i = 0; i < tplCount; i++) {
        window.VGT.wfController.__loadTemplate(i);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const g = window.VGT.wfController.__getGraph();
        const domNodes = document.querySelectorAll('#wf-nodes .wf-node').length;
        const domWires = document.querySelectorAll('#wf-wire-layer .wf-wire-path').length;
        if (domNodes !== g.nodes.length) {
          throw new Error('模板 ' + i + ' 节点 DOM 数量不一致: ' + domNodes + ' vs ' + g.nodes.length);
        }
        if (domWires !== g.edges.length) {
          throw new Error('模板 ' + i + ' 连线 SVG 数量不一致: ' + domWires + ' vs ' + g.edges.length);
        }
      }

      // 3. 测试自动整理布局按钮
      document.getElementById('wf-btn-layout').click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      // 4. 切换回单工具模式
      modeBtnSingle.click();
      await new Promise((r) => setTimeout(r, 80));
      const singleItems = document.querySelectorAll('#nav .nav-item:not(.wf-node-tpl)').length;
      if (singleItems < 44) throw new Error('单工具模式导航恢复异常: ' + singleItems);

      return { paletteCount, tplCount, singleItems };
    })()`);

    if (errors.length) {
      console.error('渲染进程出现错误:\n' + errors.join('\n'));
      app.exit(1);
      return;
    }
    console.log('WORKFLOW_UI_OK', JSON.stringify(result));
    app.exit(0);
  } catch (err) {
    console.error('UI 校验失败:', err.message);
    if (errors.length) console.error(errors.join('\n'));
    app.exit(1);
  }
});
