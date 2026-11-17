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
  ipcMain.handle('wf:scan-dir', () => ({ ok: true, files: [] }));
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
      if (paletteCount !== 58) throw new Error('侧栏工作流节点数异常: ' + paletteCount);

      // 2. 依次载入 7 套模板并校验节点、连线、可视区域与 HUD 避让
      const tplCount = window.VGT.wfTemplates.WORKFLOW_TEMPLATES.length;
      if (tplCount !== 7) throw new Error('预设模板数量异常: ' + tplCount);

      for (let i = 0; i < tplCount; i++) {
        window.VGT.wfController.__loadTemplate(i);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const g = window.VGT.wfController.__getGraph();
        const cards = [...document.querySelectorAll('#wf-nodes .wf-node')];
        const domNodes = cards.length;
        const domWires = document.querySelectorAll('#wf-wire-layer .wf-wire-path').length;
        if (domNodes !== g.nodes.length) {
          throw new Error('模板 ' + i + ' 节点 DOM 数量不一致: ' + domNodes + ' vs ' + g.nodes.length);
        }
        if (domWires !== g.edges.length) {
          throw new Error('模板 ' + i + ' 连线 SVG 数量不一致: ' + domWires + ' vs ' + g.edges.length);
        }
        const vp = document.getElementById('wf-viewport').getBoundingClientRect();
        const hud = document.querySelector('.wf-zoom-hud')?.getBoundingClientRect();
        for (const c of cards) {
          const r = c.getBoundingClientRect();
          if (r.left < vp.left - 1 || r.right > vp.right + 1 || r.top < vp.top - 1 || r.bottom > vp.bottom + 1) {
            throw new Error('模板 ' + i + ' 节点超出视口: ' + c.dataset.nodeId);
          }
          if (hud && !(r.right < hud.left || r.left > hud.right || r.bottom < hud.top || r.top > hud.bottom)) {
            throw new Error('模板 ' + i + ' 节点被右下角 HUD 遮挡: ' + c.dataset.nodeId);
          }
        }
      }

      // 3. 校验侧栏节点名称无截断
      const truncatedNav = [...document.querySelectorAll('#nav .wf-node-tpl .nav-name')]
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => el.textContent);
      if (truncatedNav.length) {
        throw new Error('侧栏节点名称被截断: ' + truncatedNav.join(', '));
      }

      // 4. 测试从侧栏点击高节点（GIF 压缩）完整可见不裁切
      document.getElementById('wf-btn-clear').click();
      document.getElementById('wf-zoom-fit').click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const tallBtn = [...document.querySelectorAll('#nav .wf-node-tpl')].find(
        (b) => b.querySelector('.nav-name')?.textContent === 'GIF 压缩'
      );
      if (!tallBtn) throw new Error('未找到 GIF 压缩 节点按钮');
      tallBtn.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const vpAfterAdd = document.getElementById('wf-viewport').getBoundingClientRect();
      const addedRect = document.querySelector('#wf-nodes .wf-node')?.getBoundingClientRect();
      if (!addedRect || addedRect.left < vpAfterAdd.left - 1 || addedRect.right > vpAfterAdd.right + 1 ||
          addedRect.top < vpAfterAdd.top - 1 || addedRect.bottom > vpAfterAdd.bottom + 1) {
        throw new Error('新增高节点超出画布可视区域');
      }

      // 5. 校验全部 58 个节点的标题与端口标签无截断
      document.getElementById('wf-btn-clear').click();
      for (const btn of document.querySelectorAll('#nav .wf-node-tpl')) btn.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const card of document.querySelectorAll('#wf-nodes .wf-node')) {
        const titleEl = card.querySelector('.wf-node-title');
        if (titleEl && titleEl.scrollWidth > titleEl.clientWidth + 1) {
          throw new Error('节点标题被截断: ' + titleEl.textContent);
        }
        for (const p of card.querySelectorAll('.wf-port-label')) {
          if (p.scrollWidth > p.clientWidth + 1) {
            throw new Error('节点端口标签被截断: ' + p.textContent);
          }
        }
      }

      // 6. 测试自动整理布局按钮
      window.VGT.wfController.__loadTemplate(0);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      document.getElementById('wf-btn-layout').click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      // 7. 切换回单工具模式
      modeBtnSingle.click();
      await new Promise((r) => setTimeout(r, 80));
      const singleItems = document.querySelectorAll('#nav .nav-item:not(.wf-node-tpl)').length;
      if (singleItems !== 49) throw new Error('单工具模式导航恢复异常: ' + singleItems);

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
