'use strict';
// 验证 WebP 文件能否被 Chromium（Electron/浏览器内核）正常解码显示
const { app, BrowserWindow } = require('electron');
const path = require('path');
const file = process.argv[2];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 300, height: 100 });
  const url = 'file:///' + path.resolve(file).replace(/\\/g, '/');
  await win.loadURL(`data:text/html,<script>var i=new Image();i.src="${url}";i.onload=()=>{document.title="OK "+i.naturalWidth+"x"+i.naturalHeight};i.onerror=()=>{document.title="FAIL"};document.body.appendChild(i);</script>`);
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    const title = win.webContents.getTitle();
    if (title !== 'data:,') { console.log('Chromium result:', title); app.exit(0); return; }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log('Chromium result: TIMEOUT');
  app.exit(1);
});
