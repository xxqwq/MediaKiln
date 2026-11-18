// 生成社交分享图 public/og-image.png（1200×630）：标题 + 真实软件截图
// 用法（仓库根目录）：node_modules\electron\dist\electron.exe website\scripts\dev\make-og.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const WEB = path.resolve(__dirname, '..', '..');
const data = JSON.parse(fs.readFileSync(path.join(WEB, 'src', 'data', 'app-data.json'), 'utf8'));
const shot = path.join(WEB, 'public', 'screenshots', 'single-video-to-gif.webp');
const out = path.join(WEB, 'public', 'og-image.png');

app.setPath('userData', path.join(os.tmpdir(), 'vgt-make-og'));

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:1200px;height:630px;overflow:hidden;background:#090a0e;color:#ececef;
    font-family:"Segoe UI Variable Display","Segoe UI","Microsoft YaHei UI","Microsoft YaHei",sans-serif;position:relative}
  .glow{position:absolute;width:900px;height:600px;left:-200px;top:-300px;border-radius:50%;
    background:radial-gradient(closest-side,rgba(124,116,255,.55),transparent);filter:blur(40px)}
  .glow2{position:absolute;width:600px;height:500px;right:-100px;bottom:-250px;border-radius:50%;
    background:radial-gradient(closest-side,rgba(103,199,230,.3),transparent);filter:blur(40px)}
  .left{position:absolute;left:72px;top:84px;width:520px}
  .brand{display:flex;align-items:center;gap:14px;font-size:26px;font-weight:700}
  .logo{width:52px;height:52px;border-radius:15px;display:grid;place-items:center;color:#fff;
    background:linear-gradient(135deg,#8d86ff,#6a61f5 55%,#4fb3d9 120%)}
  h1{margin-top:44px;font-size:50px;line-height:1.22;font-weight:800;letter-spacing:-.01em;white-space:nowrap}
  .g{background:linear-gradient(100deg,#fff,#c9c5ff 40%,#67c7e6);-webkit-background-clip:text;color:transparent}
  p{margin-top:24px;font-size:23px;color:#a1a3ad;line-height:1.55}
  .chips{margin-top:34px;display:flex;gap:10px;flex-wrap:wrap}
  .chips span{font-size:18px;padding:7px 14px;border-radius:999px;border:1px solid rgba(124,116,255,.4);background:rgba(124,116,255,.14);color:#d6d3ff}
  .shot{position:absolute;left:640px;top:96px;width:760px;border-radius:14px;overflow:hidden;
    border:1px solid rgba(255,255,255,.14);box-shadow:0 30px 80px -10px rgba(0,0,0,.8)}
  .shot img{display:block;width:100%}
</style></head><body>
  <div class="glow"></div><div class="glow2"></div>
  <div class="left">
    <div class="brand"><span class="logo"><svg viewBox="0 0 24 24" width="30" height="30" fill="none"><rect x="3" y="5" width="18" height="14" rx="3.5" stroke="currentColor" stroke-width="1.9"/><path d="M10.2 9.4v5.2a.5.5 0 0 0 .76.43l4.2-2.6a.5.5 0 0 0 0-.86l-4.2-2.6a.5.5 0 0 0-.76.43z" fill="currentColor"/></svg></span>${data.app.name}</div>
    <h1>视频 · GIF · 图片 · 文档<br><span class="g">本地一站搞定</span></h1>
    <p>${data.stats.features} 个功能 · ${data.stats.nodes} 节点工作流<br>不联网、不上传，免费开源</p>
    <div class="chips"><span>100% 离线</span><span>批量处理</span><span>GPU 加速</span></div>
  </div>
  <div class="shot"><img src="${pathToFileURL(shot).href}"></div>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 630, useContentSize: true, webPreferences: { webSecurity: false } });
  const tmp = path.join(os.tmpdir(), 'vgt-og.html');
  fs.writeFileSync(tmp, html, 'utf8');
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 800));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1200, height: 630 });
  fs.writeFileSync(out, img.resize({ width: 1200, height: 630 }).toPNG());
  console.log('OG_OK', out);
  app.exit(0);
});
