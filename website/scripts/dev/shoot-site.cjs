// 用 Electron 渲染官网并分段截图，便于自检视觉效果（参数用环境变量传递：Electron 会拦截命令行里的 URL 参数）
// 用法: $env:SHOOT_URL='http://localhost:4321/'; $env:SHOOT_OUT='...'; $env:SHOOT_W='1440'; electron website/scripts/dev/shoot-site.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const target = process.env.SHOOT_URL || 'http://localhost:4321/';
const outDir = process.env.SHOOT_OUT || path.join(__dirname, 'shots');
const w = process.env.SHOOT_W || '1440';
// 独立 userData，避免与正在运行的其他 Electron 实例争用缓存目录
app.setPath('userData', path.join(require('os').tmpdir(), 'vgt-shoot-site'));
const WIDTH = Number(w);
const HEIGHT = WIDTH < 800 ? 860 : 900;

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({ show: false, width: WIDTH, height: HEIGHT, webPreferences: { offscreen: false } });
  const errs = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errs.push(msg); });
  await win.loadURL(target);
  await new Promise((r) => setTimeout(r, 1500));
  // 让所有 reveal 元素可见
  await win.webContents.executeJavaScript(`document.querySelectorAll('.reveal').forEach(e=>e.classList.add('in')); document.documentElement.style.scrollBehavior='auto'; 0`);
  const total = await win.webContents.executeJavaScript('document.documentElement.scrollHeight');
  let i = 0;
  for (let y = 0; y < total; y += HEIGHT) {
    await win.webContents.executeJavaScript(`window.scrollTo(0, ${y}); 0`);
    await new Promise((r) => setTimeout(r, 450));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `w${WIDTH}-${String(i++).padStart(2, '0')}.png`), img.toPNG());
  }
  console.log('SHOTS', i, 'height', total);
  if (errs.length) console.log('CONSOLE:', errs.join('\n'));
  app.exit(0);
});
