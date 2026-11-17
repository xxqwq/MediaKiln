'use strict';

// 官网截图 & 前后对比素材生成脚本：复用真实 main.js（真实 IPC + 真实 FFmpeg 处理），驱动渲染进程并截图。
// 用法（仓库根目录，先确保没有工具箱实例在运行）：
//   pwsh:  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
//          node_modules\electron\dist\electron.exe website\scripts\capture\capture.cjs
// 可选环境变量：CAPTURE_TMP（临时目录，默认 D:\temp\vgt-capture）、CAPTURE_SCALE（设备缩放，默认 1）、
//               CAPTURE_ONLY（逗号分隔的步骤名，只跑部分步骤，如 "svg,cutout"）。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const electron = require('electron');
const { app, BrowserWindow, dialog, nativeImage, Notification } = electron;

const ROOT = path.resolve(__dirname, '../../..');
const WEB = path.resolve(__dirname, '../..');
const MEDIA = path.join(__dirname, 'media');
const SHOTS = path.join(WEB, 'public', 'screenshots');
const COMPARE = path.join(WEB, 'public', 'compare');
const FFMPEG = path.join(ROOT, 'bin', 'ffmpeg.exe');
const TMP = process.env.CAPTURE_TMP || 'D:\\temp\\vgt-capture';
// 演示素材工作目录：其路径会显示在界面「输出路径」里，因此用一个中性的目录名，避免出现开发者路径/用户名
const WORK = process.env.CAPTURE_WORK || 'D:\\演示素材';
const WORK_MARK = path.join(WORK, '.vgt-capture');
const PNG_DIR = path.join(TMP, 'png');
const USERDATA = path.join(TMP, 'userData');
const SCALE = Number(process.env.CAPTURE_SCALE || 1);
const ONLY = (process.env.CAPTURE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const W = 1440;
const H = 900;

// ---------------------------------------------------------------------------
// 准备临时目录与演示素材（中文文件名更贴近真实用户场景）
// ---------------------------------------------------------------------------
fs.rmSync(TMP, { recursive: true, force: true });
if (fs.existsSync(WORK)) {
  // 只清理本脚本自己创建的目录（带标记文件），防止误删用户同名文件夹
  if (!fs.existsSync(WORK_MARK)) {
    console.error(`[capture] ${WORK} 已存在且不是本脚本创建的，请通过 CAPTURE_WORK 指定其他目录`);
    process.exit(1);
  }
  fs.rmSync(WORK, { recursive: true, force: true });
}
for (const d of [WORK, PNG_DIR, USERDATA, SHOTS, COMPARE]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(WORK_MARK, 'created by website/scripts/capture/capture.cjs\n');

const F = {
  video: ['city.mp4', '海滨小镇黄昏.mp4'],
  greenVideo: ['greenscreen.mp4', '绿幕狐狸.mp4'],
  green: ['greenscreen.jpg', '绿幕狐狸.jpg'],
  logo: ['logo.png', '品牌Logo.png'],
  landscape: ['landscape.jpg', '海滨小镇.jpg'],
  product: ['product.jpg', '拿铁咖啡.jpg'],
  bgm: ['bgm.m4a', '轻快配乐.m4a'],
  doc: ['brochure.docx', '品牌宣传素材.docx'],
};
const P = {};
for (const [k, [src, dst]] of Object.entries(F)) {
  P[k] = path.join(WORK, dst);
  fs.copyFileSync(path.join(MEDIA, src), P[k]);
}

app.commandLine.appendSwitch('force-device-scale-factor', String(SCALE));
app.setPath('userData', USERDATA);

// 文件选择对话框改为脚本预置路径；关闭系统通知，避免截图过程弹出 Windows 通知
let nextPick = null;
dialog.showOpenDialog = async () => (nextPick ? { canceled: false, filePaths: nextPick } : { canceled: true, filePaths: [] });
try { Notification.isSupported = () => false; } catch {}

require(path.join(ROOT, 'main.js'));

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win = null;
const log = (...a) => console.log('[capture]', ...a);

function js(code) {
  return win.webContents.executeJavaScript(`(async () => { ${code} })()`);
}

const HELPERS = `
window.__cap = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  raf: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  async waitFor(fn, timeout = 60000, label = '') {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch {}
      await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error('等待超时: ' + label);
  },
  $: (s) => document.querySelector(s),
  visible(sel) { const el = document.querySelector(sel); return !!el && !el.classList.contains('hidden') && el.offsetParent !== null; },
  nav(id) {
    const el = document.querySelector('#nav .nav-item[data-id="' + id + '"]');
    if (!el) throw new Error('未找到功能 ' + id);
    el.click();
  },
  chip(key, val) {
    const el = document.querySelector('#params .field[data-field-key="' + key + '"] .chip[data-val="' + val + '"]');
    if (!el) throw new Error('未找到选项 ' + key + '=' + val);
    el.click();
  },
  setInput(sel, val) {
    const el = document.querySelector(sel);
    if (!el) throw new Error('未找到输入 ' + sel);
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },
  setSelect(key, val) { this.setInput('#params select[data-key="' + key + '"]', val); },
  setColor(key, val) { this.setInput('#params input[type="color"][data-key="' + key + '"]', val); },
  hideToast() { document.getElementById('toast').classList.add('hidden'); },
  async run(timeout = 180000) {
    document.getElementById('btn-run').click();
    await this.sleep(300);
    await this.waitFor(() => !document.getElementById('result-card').classList.contains('hidden')
      && document.getElementById('btn-cancel').classList.contains('hidden'), timeout, '处理结果');
    const rc = document.getElementById('result-card');
    if (rc.classList.contains('err') || rc.classList.contains('error')) throw new Error('任务失败: ' + rc.innerText);
    return { cls: rc.className, text: rc.innerText.slice(0, 300), out: rc.querySelector('.result-path')?.textContent || '' };
  },
  async imgsLoaded(root = document) {
    const imgs = [...root.querySelectorAll('img')].filter((i) => i.offsetParent !== null);
    await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; }))));
  },
};
true;`;

async function loadFiles(featureId, paths, expectName) {
  nextPick = paths;
  await js(`
    __cap.nav(${JSON.stringify(featureId)});
    await __cap.sleep(150);
    if (__cap.visible('#file-card')) document.getElementById('btn-replace').click();
    else document.getElementById('dropzone').click();
    await __cap.waitFor(() => __cap.visible('#action-bar') && __cap.visible('#params')
      && document.getElementById('file-name').textContent.includes(${JSON.stringify(expectName)}), 30000, '载入文件');
    await __cap.sleep(400);
  `);
  nextPick = null;
}

function toWebp(png, out) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', png, '-c:v', 'libwebp', '-quality', '85', '-compression_level', '6', out]);
}

const produced = [];
async function shot(name) {
  await js(`__cap.hideToast(); await __cap.imgsLoaded(); await __cap.raf();`);
  await sleep(350);
  const img = await win.webContents.capturePage();
  const png = path.join(PNG_DIR, name + '.png');
  fs.writeFileSync(png, img.toPNG());
  const out = path.join(SHOTS, name + '.webp');
  toWebp(png, out);
  const sz = img.getSize();
  produced.push(`${path.relative(WEB, out)}  ${sz.width}x${sz.height}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
  log('shot', name, sz.width + 'x' + sz.height);
}

function sampleCornerColor(file) {
  const img = nativeImage.createFromPath(file);
  const crop = img.crop({ x: 4, y: 4, width: 24, height: 24 });
  const buf = crop.toBitmap(); // BGRA
  let r = 0; let g = 0; let b = 0;
  const n = buf.length / 4;
  for (let i = 0; i < buf.length; i += 4) { b += buf[i]; g += buf[i + 1]; r += buf[i + 2]; }
  const hex = (v) => Math.round(v / n).toString(16).padStart(2, '0');
  return '#' + hex(r) + hex(g) + hex(b);
}

const compareMeta = [];
function addCompare(id, title, feature, beforeSrc, beforeName, afterSrc, afterName) {
  const b = path.join(COMPARE, beforeName);
  const a = path.join(COMPARE, afterName);
  fs.copyFileSync(beforeSrc, b);
  fs.copyFileSync(afterSrc, a);
  compareMeta.push({
    id, title,
    before: `/compare/${beforeName}`,
    after: `/compare/${afterName}`,
    beforeBytes: fs.statSync(b).size,
    afterBytes: fs.statSync(a).size,
    feature,
  });
}

const want = (step) => !ONLY.length || ONLY.includes(step);

async function scrollMain(to) {
  await js(`
    const m = document.getElementById('single-main');
    const t = ${JSON.stringify(to)};
    if (t === 'top') m.scrollTop = 0;
    else if (t === 'bottom') m.scrollTop = m.scrollHeight;
    else {
      const el = document.querySelector(t);
      if (el) m.scrollTop += el.getBoundingClientRect().top - m.getBoundingClientRect().top - 16;
    }
    await __cap.raf();
  `);
}

// ---------------------------------------------------------------------------
// 截图步骤
// ---------------------------------------------------------------------------
let gifBefore = null;
let cutoutOut = null;
let bgOut = null;

const STEPS = {
  async video() {
    await loadFiles('videoToGif', [P.video], '海滨小镇黄昏');
    await js(`
      const v = await __cap.waitFor(() => document.querySelector('#preview-box video'), 10000, 'video');
      if (v.readyState < 2) await new Promise((r) => { v.onloadeddata = r; setTimeout(r, 5000); });
      v.currentTime = 3.2;
      await new Promise((r) => { v.onseeked = r; setTimeout(r, 3000); });
      __cap.setInput('#t-start', '0.5');
      __cap.setInput('#t-end', '4.5');
      __cap.setSelect('fps', '12');
      __cap.setSelect('width', '480');
      __cap.setSelect('colors', '128');
      // 展开「放大预览」让画面更饱满
      const zb = document.getElementById('btn-zoom-preview');
      if (zb && !zb.classList.contains('hidden') && !document.getElementById('file-card').classList.contains('preview-large')) zb.click();
      await __cap.sleep(600);
    `);
    await scrollMain('top');
    await shot('single-video-to-gif');
    const r = await js(`return await __cap.run(240000);`);
    log('videoToGif ->', r.out);
    gifBefore = r.out.trim();
  },

  async gif() {
    if (!gifBefore || !fs.existsSync(gifBefore)) throw new Error('缺少 GIF 源（先运行 video 步骤）');
    await loadFiles('compressGif', [gifBefore], path.basename(gifBefore));
    await js(`__cap.chip('preset', 'extreme'); await __cap.sleep(100); __cap.setSelect('width', '480');`);
    const r = await js(`return await __cap.run(240000);`);
    log('compressGif ->', r.out, r.text.split('\n')[0]);
    addCompare('gif', 'GIF 压缩', 'compressGif', gifBefore, 'gif-before.gif', r.out.trim(), 'gif-after.gif');
    await js(`const b = document.getElementById('btn-compare'); if (b) b.click(); await __cap.sleep(600);`);
    await scrollMain('#result-card');
    await sleep(1200);
    await shot('gif-compress-result');
  },

  async svg() {
    await loadFiles('imageToSvg', [P.logo], '品牌Logo');
    await js(`
      __cap.chip('mode', 'poster');
      await __cap.sleep(100);
      __cap.chip('colors', '8');
      __cap.chip('transparentBg', 'white');
      __cap.chip('maxDim', '1200');
    `);
    const r = await js(`return await __cap.run(180000);`);
    log('imageToSvg ->', r.out);
    addCompare('vector', '图片转 SVG 矢量', 'imageToSvg', P.logo, 'vector-before.png', r.out.trim(), 'vector-after.svg');
    // SVG 在灯箱中按 82% 显示，卷帘模式下与原图无法对齐，因此这里用并排模式
    await js(`
      document.getElementById('btn-zoom-compare').click();
      await __cap.sleep(500);
      document.querySelector('[data-act="mode-side"]')?.click();
      await __cap.sleep(800);
    `);
    await shot('svg-compare-side');
    await js(`document.getElementById('lb-close')?.click(); await __cap.sleep(300);`);
  },

  async cutout() {
    const key = sampleCornerColor(P.green);
    log('green key color', key);
    await loadFiles('imageCutout', [P.green], '绿幕狐狸');
    await js(`
      __cap.setColor('color', ${JSON.stringify(key)});
      __cap.setInput('#params input[type="range"][data-key="similarity"]', '0.2');
      __cap.setInput('#params input[type="range"][data-key="blend"]', '0.1');
    `);
    const r = await js(`return await __cap.run(120000);`);
    log('imageCutout ->', r.out);
    cutoutOut = r.out.trim();
    const jpgBefore = P.green;
    addCompare('cutout', '纯色 / 绿幕抠图透明', 'imageCutout', jpgBefore, 'cutout-before.jpg', cutoutOut, 'cutout-after.png');
    await js(`document.getElementById('btn-compare').click(); await __cap.sleep(700);`);
    await scrollMain('#params');
    await sleep(800);
    await shot('image-cutout');
    // 放大对比弹窗：卷帘模式（左绿幕原图 / 右透明结果）
    await js(`
      document.getElementById('btn-zoom-compare').click();
      await __cap.sleep(500);
      document.querySelector('[data-act="mode-slider"]')?.click();
      await __cap.sleep(900);
    `);
    await shot('single-result-compare');
    await js(`document.getElementById('lb-close')?.click(); await __cap.sleep(300);`);
  },

  async replacebg() {
    const key = sampleCornerColor(P.green);
    await loadFiles('imageReplaceBg', [P.green], '绿幕狐狸');
    await js(`
      __cap.chip('bgType', 'gradient');
      await __cap.sleep(100);
      __cap.chip('gradStart', '#0ea5e9');
      __cap.chip('gradEnd', '#a855f7');
      __cap.chip('gradDir', 'tlbr');
      __cap.chip('fgMode', 'colorkey');
      await __cap.sleep(100);
      __cap.setColor('keyColor', ${JSON.stringify(key)});
      __cap.setInput('#params input[type="range"][data-key="similarity"]', '0.2');
      __cap.chip('format', 'jpg');
    `);
    const r = await js(`return await __cap.run(120000);`);
    log('imageReplaceBg ->', r.out);
    bgOut = r.out.trim();
    addCompare('bg', '图片更换背景', 'imageReplaceBg', P.green, 'bg-before.jpg', bgOut, 'bg-after.jpg');
    await js(`document.getElementById('btn-compare').click(); await __cap.sleep(700);`);
    await scrollMain('bottom');
    await sleep(800);
    await shot('image-replace-bg');
  },

  async batch() {
    const list = [P.landscape, P.product, P.logo, P.green];
    if (cutoutOut && fs.existsSync(cutoutOut)) list.push(cutoutOut);
    if (bgOut && fs.existsSync(bgOut)) list.push(bgOut);
    await loadFiles('imageConvert', list, '批量队列');
    await js(`__cap.chip('format', 'webp'); __cap.chip('quality', 'medium'); __cap.chip('resizeMode', 'maxSide');`);
    const r = await js(`return await __cap.run(240000);`);
    log('batch imageConvert ->', r.text.split('\n')[0]);
    await scrollMain('#file-card');
    await sleep(600);
    await shot('batch-queue');
  },

  async doc() {
    await loadFiles('docExtractImages', [P.doc], '品牌宣传素材');
    const r = await js(`return await __cap.run(120000);`);
    log('docExtractImages ->', r.text.split('\n')[0]);
    await scrollMain('#result-card');
    await sleep(1000);
    await shot('doc-extract-images');
  },

  async workflow() {
    // 文件夹扫描模板用的混合素材目录（位图 + SVG + 动图）
    const mixDir = path.join(WORK, '混合素材');
    fs.mkdirSync(mixDir, { recursive: true });
    for (const p of [P.landscape, P.product, P.logo, P.green]) fs.copyFileSync(p, path.join(mixDir, path.basename(p)));
    const svgOut = path.join(WORK, '品牌Logo_vector.svg');
    if (fs.existsSync(svgOut)) fs.copyFileSync(svgOut, path.join(mixDir, '品牌Logo.svg'));
    if (gifBefore && fs.existsSync(gifBefore)) fs.copyFileSync(gifBefore, path.join(mixDir, '海滨小镇动图.gif'));

    // 预置各模板输入节点的演示文件（仅修改渲染进程内存中的模板数据，不改源码）
    const byId = {
      tpl_video_to_gif_pro: { n1: P.video },
      tpl_vertical_short_bgm: { n1: P.video, n2: P.bgm },
      tpl_doc_roundtrip: { n1: P.doc },
      tpl_chroma_sticker: { n1: P.greenVideo },
      tpl_logo_vector_ico: { n1: P.logo },
      tpl_video_frames_grid: { n1: P.video },
    };
    const ids = await js(`
      document.getElementById('mode-btn-workflow').click();
      await __cap.sleep(400);
      const T = window.VGT.wfTemplates.WORKFLOW_TEMPLATES;
      const byId = ${JSON.stringify(byId)};
      T.forEach((t) => {
        const map = byId[t.id] || {};
        for (const n of t.graph.nodes) {
          if (n.type === 'io.loadFile') n.params = { ...n.params, filePath: map[n.id] || ${JSON.stringify(P.video)} };
          else if (n.type === 'io.loadBatch') n.params = { ...n.params, filePaths: ${JSON.stringify([P.landscape, P.product, P.logo])} };
          else if (n.type === 'io.loadFolder') n.params = { ...n.params, dirPath: ${JSON.stringify(mixDir)} };
        }
      });
      return T.map((t) => t.id);
    `);
    for (const f of fs.readdirSync(SHOTS)) {
      if (/^wf-template-\d+\.webp$/.test(f)) fs.unlinkSync(path.join(SHOTS, f));
    }
    for (let i = 0; i < ids.length; i++) {
      await js(`
        window.VGT.wfController.__loadTemplate(${i});
        await __cap.raf();
        await __cap.sleep(1500);
        // 输入节点载入视频预览后会变高，若与相邻节点重叠则点「自动整理」
        const rects = [...document.querySelectorAll('#wf-nodes .wf-node')].map((n) => n.getBoundingClientRect());
        const overlap = rects.some((a, x) => rects.some((b, y) => x < y
          && a.left < b.right - 2 && b.left < a.right - 2 && a.top < b.bottom - 2 && b.top < a.bottom - 2));
        if (overlap) { document.getElementById('wf-btn-layout').click(); await __cap.raf(); await __cap.sleep(600); }
        document.getElementById('wf-zoom-fit').click();
        await __cap.raf();
        await __cap.sleep(500);
      `);
      await shot(`wf-${ids[i]}`);
    }
    // 模板 0：真实运行整条工作流后截图
    await js(`
      window.VGT.wfController.__loadTemplate(0);
      await __cap.sleep(1500);
      document.getElementById('wf-btn-run').click();
      await __cap.sleep(800);
      await __cap.waitFor(() => !window.VGT.wfController.isRunning(), 300000, '工作流运行');
      await __cap.sleep(1500);
      document.getElementById('wf-zoom-fit').click();
      await __cap.raf();
      await __cap.sleep(600);
    `);
    await shot('workflow-canvas');
    await js(`document.getElementById('mode-btn-single').click(); await __cap.sleep(300);`);
  },
};

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  try {
    for (let i = 0; i < 100 && !BrowserWindow.getAllWindows().length; i++) await sleep(100);
    win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('主窗口未创建（是否已有工具箱实例在运行？）');
    if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) log('renderer error:', message); });
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(W, H);
    win.center();
    await sleep(800);
    await js(HELPERS);
    await js(`await __cap.waitFor(() => document.querySelectorAll('#nav .nav-item').length > 10, 10000, 'nav');`);

    for (const [name, fn] of Object.entries(STEPS)) {
      if (!want(name)) continue;
      log('=== step', name);
      try {
        await fn();
      } catch (err) {
        log(`步骤 ${name} 失败:`, err.message);
        await js(`__cap.hideToast(); document.getElementById('lb-close')?.click();`).catch(() => {});
      }
    }

    if (compareMeta.length) {
      const metaFile = path.join(COMPARE, 'meta.json');
      let merged = compareMeta;
      if (ONLY.length && fs.existsSync(metaFile)) {
        const old = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        const ids = new Set(compareMeta.map((m) => m.id));
        merged = [...old.filter((m) => !ids.has(m.id)), ...compareMeta];
      }
      const order = ['vector', 'cutout', 'gif', 'bg'];
      merged.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      fs.writeFileSync(metaFile, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    }
    log('完成，截图：\n' + produced.join('\n'));
    log('对比素材：\n' + compareMeta.map((m) => `${m.id}: ${m.beforeBytes} -> ${m.afterBytes}`).join('\n'));
    if (!process.env.CAPTURE_KEEP) {
      try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
    }
    app.exit(0);
  } catch (err) {
    console.error('[capture] 失败:', err);
    app.exit(1);
  }
});
