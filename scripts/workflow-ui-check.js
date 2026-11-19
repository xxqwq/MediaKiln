'use strict';

// 无头 Electron UI 校验脚本：加载真实 renderer/index.html 与 preload.js，检查 CSP、控制台错误及双模式/画布/模板渲染
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('path');
const { cancelTask, executeTask, probe } = require('../ffmpeg');
const { PDFDocument } = require('pdf-lib');
const { getPdfPageCount } = require('../core/pdf-engine');
const { buildStyledHtmlDocument } = require('../core/md-renderer');

const ROOT = path.resolve(__dirname, '..');
const WF_SMOKE_ROOT = process.env.VGT_TEST_ROOT || path.join(ROOT, 'scripts', 'smoke_wf');
fs.mkdirSync(WF_SMOKE_ROOT, { recursive: true });
const PROFILE = fs.mkdtempSync(path.join(WF_SMOKE_ROOT, 'ui-check-'));
app.setPath('userData', PROFILE);
app.disableHardwareAcceleration();
const exportedPdfs = new Map();

async function checkImageOcr(win) {
  const { Resvg } = require('@resvg/resvg-js');
  const files = ['OCR 样本一.png', 'OCR 样本二.png'].map((name) => path.join(PROFILE, name));
  for (const [index, file] of files.entries()) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300"><rect width="900" height="300" fill="#fff"/><text x="60" y="100" font-family="Microsoft YaHei" font-size="46">本地离线文档</text><text x="60" y="210" font-family="Segoe UI" font-size="42">OCR TEXT ${2026 + index}</text></svg>`;
    await fs.promises.writeFile(file, new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng());
  }

  await win.webContents.executeJavaScript(`(async (inputs) => {
    document.querySelector('#nav [data-id="imageOcr"]').click();
    await useFiles([inputs[0]]);
    await runTask();
    const expected = '本地离线文档\\nOCR TEXT 2026';
    const preview = document.querySelector('.result-ocr-text');
    if (preview?.textContent !== expected) throw new Error('图片 OCR 结果预览异常');
    let copied;
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text) => { copied = text; } });
    try {
      await document.getElementById('btn-copy-ocr').onclick();
      if (copied !== expected) throw new Error('复制文字使用了错误内容');
    } finally {
      delete navigator.clipboard.writeText;
    }
    await useFiles(inputs);
    await runTask();
    if (document.querySelectorAll('#batch-list .batch-status.ok').length !== inputs.length) throw new Error('批量识字未全部导出');
  })(${JSON.stringify(files)})`);

  for (const file of files) {
    const stem = path.basename(file, '.png');
    const txt = await fs.promises.readFile(path.join(PROFILE, `${stem}_识别文字.txt`), 'utf8');
    assert.match(txt, /本地离线文档/);
  }
}

async function checkPdfTools(win) {
  const first = path.join(PROFILE, '原 PDF.pdf');
  const second = path.join(PROFILE, '附录.pdf');
  for (const [file, widths] of [[first, [400, 410, 420]], [second, [450]]]) {
    const doc = await PDFDocument.create();
    widths.forEach((width, index) => doc.addPage([width, 500]).drawText(`Sample ${width} page ${index + 1}`, { x: 120, y: 260 }));
    await fs.promises.writeFile(file, await doc.save());
  }

  await win.webContents.executeJavaScript(`(async (first, second) => {
    const el = (id) => document.getElementById(id);
    const query = (selector) => document.querySelector(selector);
    const cards = () => [...document.querySelectorAll('.pdf-page-card')];
    const selectFeatureById = (id) => query('#nav [data-id="' + id + '"]').click();
    const control = (id) => query('[data-control="' + id + '"]').click();
    const assert = (expected, message) => { if (!expected) throw new Error(message); };
    const until = async (test, message) => {
      const untilTime = Date.now() + 20000;
      while (!test()) {
        if (Date.now() >= untilTime) throw new Error(message);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };

    selectFeatureById('pdfMerge');
    await useFiles([first]);
    await until(() => cards().length === 3 && cards().every((card) => card.querySelector('img').naturalWidth), 'PDF 缩略图未加载');
    cards()[1].click();
    control('earlier');
    assert(cards()[0].dataset.pageId === '0-2', '按钮未能前移页面');
    await useFiles([second], true);
    await until(() => cards().length === 4, '添加 PDF 后页数不正确');
    assert(cards()[0].dataset.pageId === '0-2', '添加 PDF 后丢失已有编辑');
    const transfer = new DataTransfer();
    const drag = (name, card) => card.dispatchEvent(new DragEvent(name, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    drag('dragstart', cards()[3]);
    drag('dragover', cards()[0]);
    drag('drop', cards()[0]);
    assert(cards()[0].dataset.pageId === '1-1', '缩略图拖拽未改变顺序');
    control('rotate-right');
    assert(cards()[0].querySelector('img').style.transform === 'rotate(90deg)', '旋转未体现在预览');
    cards()[2].click();
    control('remove');
    assert(cards().length === 3, '移除页面失败');
    control('restore');
    assert(cards().length === 4 && cards()[2].dataset.pageId === '0-1', '恢复页面失败');
    control('remove');
    el('btn-run').click();
    await until(() => el('result-card').textContent.includes('PDF 页面整理完成'), '页面整理未导出');

    selectFeatureById('pdfCrop');
    await useFiles([first]);
    query('.pdf-crop-controls button').click();
    await until(() => query('.pdf-crop-preview img').naturalWidth && !query('.pdf-crop-outline').hidden, '裁剪范围未显示');
    query('.pdf-crop-controls input').value = '2';
    query('.pdf-crop-controls input').dispatchEvent(new Event('input', { bubbles: true }));
    assert(query('.pdf-crop-preview').hidden, '切换预览页后仍显示旧裁剪范围');
    el('btn-run').click();
    await until(() => el('result-card').textContent.includes('裁去 3 / 3 页白边'), '批量裁剪未导出');

    selectFeatureById('pdfCompress');
    query('[data-key="preset"] [data-val="target"]').click();
    assert(query('[data-key="targetMB"]').closest('.field').style.display !== 'none', '目标大小输入未出现');
    el('btn-run').click();
    await until(() => el('result-card').textContent.includes('已达到 2 MB 目标'), '目标压缩未报告结果');
  })(${JSON.stringify(first)}, ${JSON.stringify(second)})`);

  const organized = await PDFDocument.load(await fs.promises.readFile(exportedPdfs.get('pdfMerge')));
  assert.deepEqual(organized.getPages().map((page) => [page.getWidth(), page.getRotation().angle]), [[450, 90], [410, 0], [420, 0]]);
  const cropped = await PDFDocument.load(await fs.promises.readFile(exportedPdfs.get('pdfCrop')));
  assert(cropped.getPages().every((page) => page.getCropBox().width < page.getWidth()));
  const form = await PDFDocument.create();
  const page = form.addPage([350, 430]);
  form.addPage([300, 420]);
  const field = form.getForm().createTextField('field');
  field.addToPage(page, { x: 15, y: 20, width: 80, height: 20 });
  field.setText('preserved');
  const formPath = path.join(PROFILE, 'form.pdf');
  const formOutput = path.join(PROFILE, 'form-organized.pdf');
  await fs.promises.writeFile(formPath, await form.save());
  const formPages = [{ fileIndex: 0, page: 2, rotation: 0 }, { fileIndex: 0, page: 1, rotation: 90 }];
  await executeTask('form-organize', 'pdfMerge', { files: [formPath], pages: formPages, output: formOutput });
  const organizedForm = await PDFDocument.load(await fs.promises.readFile(formOutput));
  assert.equal(organizedForm.getForm().getTextField('field').getText(), 'preserved');
  assert.deepEqual(organizedForm.getPages().map((p) => p.getWidth()), [300, 350]);
  await assert.rejects(executeTask('form-extract', 'pdfMerge', {
    files: [formPath], pages: formPages.slice(1), output: path.join(PROFILE, 'form-extract.pdf'),
  }), /可填写表单/);
}

function createTestDocxWithRichContent(outDocxPath, imgBuffer) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
</Types>`, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`, 'utf8'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/chart.png"/>
</Relationships>`, 'utf8'));
  zip.addFile('word/styles.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
</w:styles>`, 'utf8'));
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Word 转 PDF 离线测试标题</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/><w:color w:val="2563EB"/></w:rPr><w:t>加粗蓝色正文段落，含内嵌表格与图片。</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>跨两列表头</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>单元格 A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>单元格 B</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:p><w:r><w:drawing><wp:inline><wp:extent cx="1524000" cy="762000"/><a:graphic><a:graphicData><a:blip r:embed="rIdImg1"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`, 'utf8'));
  zip.addFile('word/media/chart.png', imgBuffer);
  zip.writeZip(outDocxPath);
}

async function checkDocumentExport() {
  let requests = 0;
  const server = http.createServer((_req, res) => { requests++; res.end('unexpected request'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const remote = `http://127.0.0.1:${server.address().port}`;
  const md = '# 示例文档\n\n## 章节\n\n```js\nconst value = 123;\n```\n';
  const html = `<!doctype html><h1>本地 HTML</h1><img src="${remote}/image"><script>fetch('${remote}/script')</script>`;
  assert.match(buildStyledHtmlDocument(md).html, /hljs-keyword/);
  try {
    for (const [ext, body] of [['md', md], ['html', html]]) {
      const input = path.join(PROFILE, `测试文档.${ext}`);
      const output = path.join(PROFILE, `打印-${ext}.pdf`);
      fs.writeFileSync(input, body, 'utf8');
      const result = await executeTask(`print-${ext}`, 'docToPdf', { input, output, pageNumbers: 'yes' });
      assert.equal(result.output, output);
      assert.equal(await getPdfPageCount(output), 1);
      if (ext === 'md') assert.match(fs.readFileSync(output, 'latin1'), /\/Outlines\b/);
    }
    const { Resvg } = require('@resvg/resvg-js');
    const pngBuf = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#2563eb"/></svg>').render().asPng();
    const docxIn = path.join(PROFILE, 'word测试.docx');
    const docxPdfOut = path.join(PROFILE, 'word测试.pdf');
    createTestDocxWithRichContent(docxIn, pngBuf);
    const wordRes = await executeTask('word-to-pdf', 'wordToPdf', { input: docxIn, output: docxPdfOut, engine: 'builtin', pageNumbers: 'yes' });
    assert.equal(wordRes.output, docxPdfOut);
    assert.equal(wordRes.wordToPdfSummary?.engineUsed, 'builtin');
    assert((await getPdfPageCount(docxPdfOut)) >= 1);
    assert.match(fs.readFileSync(docxPdfOut, 'latin1'), /\/Outlines\b/);
    const prevDisableCom = process.env.VGT_DISABLE_OFFICE_COM;
    process.env.VGT_DISABLE_OFFICE_COM = '1';
    try {
      const docxAutoOut = path.join(PROFILE, 'word自动回退.pdf');
      const autoRes = await executeTask('word-to-pdf-auto', 'wordToPdf', { input: docxIn, output: docxAutoOut, engine: 'auto' });
      assert.equal(autoRes.output, docxAutoOut);
      assert.equal(autoRes.wordToPdfSummary?.engineUsed, 'builtin');
      assert((await getPdfPageCount(docxAutoOut)) >= 1);
    } finally {
      if (prevDisableCom === undefined) delete process.env.VGT_DISABLE_OFFICE_COM;
      else process.env.VGT_DISABLE_OFFICE_COM = prevDisableCom;
    }
    assert.equal(requests, 0, '文档转 PDF 不应访问网络');
  } finally {
    server.close();
  }
}

function registerStubIpc() {
  ipcMain.handle('detect-hw', () => ({ available: [], primary: null }));
  ipcMain.handle('wf:cache-info', () => ({ dir: path.join(ROOT, '.workflow_cache'), sizeBytes: 0, fileCount: 0 }));
  ipcMain.handle('wf:clear-cache', () => ({ ok: true }));
  ipcMain.handle('wf:alloc-node-dir', (_e, o) => ({ ok: true, dir: path.join(ROOT, '.workflow_cache', o?.subKey || 'test') }));
  ipcMain.handle('wf:stat-multi', () => []);
  ipcMain.handle('wf:scan-dir', () => ({ ok: true, files: [] }));
  const isFixture = (file) => path.dirname(file) === PROFILE && /\.(pdf|png|txt)$/.test(file);
  ipcMain.handle('probe', async (_e, p) => (p === 'F:\\stub.mp4'
    ? { ok: true, info: { duration: 5, width: 640, height: 360, fps: 24, size: 10240, isImage: false, hasAudio: true } }
    : (isFixture(p) ? { ok: true, info: await probe(p) } : { ok: false, error: 'stub' })));
  ipcMain.handle('probe-multi', (_e, ps) => Promise.all((ps || []).map(async (p) => ({
    path: p,
    info: p === 'F:\\stub.mp4' ? { duration: 5, width: 640, height: 360, fps: 24, size: 10240, isImage: false, hasAudio: true } : (isFixture(p) ? await probe(p) : null),
  }))));
  ipcMain.handle('task:start', async (_e, { feature, params }) => {
    try {
      const result = await executeTask(params.__clientTaskId || `test-${feature}`, feature, params);
      if (result.output) exportedPdfs.set(feature, result.output);
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('task:cancel', (_e, id) => cancelTask(id));
  ipcMain.handle('stat-file', (_e, file) => fs.statSync(file).size);
  ipcMain.handle('hotfix:status', () => ({ builtinVersion: '0.1.0', shellVersion: '0.1.0', effectiveVersion: '0.1.0', isHotfix: false }));
  ipcMain.handle('hotfix:check', () => ({ ok: true, status: 'up-to-date' }));
  ipcMain.on('set-progress-bar', () => {});
  ipcMain.on('notify-done', () => {});
  ipcMain.handle('wf:set-cache-dir', () => ({ ok: true, dir: path.join(ROOT, '.workflow_cache') }));
  ipcMain.handle('wf:prune-cache', () => ({ ok: true, removedCount: 0, freedBytes: 0 }));
  ipcMain.handle('clipboard:read-media', () => ({ ok: false, error: 'stub' }));
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
      if (paletteCount !== 82) throw new Error('侧栏工作流节点数异常: ' + paletteCount);

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

      // 5. 校验所有节点的标题与端口标签无截断，并测试注释便签创建
      document.getElementById('wf-btn-clear').click();
      document.getElementById('wf-btn-note')?.click();
      if (!document.querySelectorAll('#wf-notes .wf-note').length) {
        throw new Error('画布注释便签未能创建');
      }
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

      // 7. 切换回单工具模式并校验 56 个功能、自定义预设保存及「带参数入画布」
      await window.VGT.appBridge.sendToSingle(['F:\\\\stub.mp4']);
      await new Promise((r) => setTimeout(r, 80));
      const singleItems = document.querySelectorAll('#nav .nav-item:not(.wf-node-tpl)').length;
      if (singleItems !== 73) throw new Error('单工具模式导航恢复异常: ' + singleItems);

      const setFps = (value) => {
        const input = document.querySelector('#params select[data-key="fps"]');
        input.value = value;
        input.dispatchEvent(new Event('change'));
      };
      setFps('20');
      document.getElementById('btn-save-preset')?.click();
      const presetInp = document.getElementById('preset-name-input');
      if (!presetInp) throw new Error('预设名称输入框缺失');
      presetInp.value = '自检预设A';
      document.getElementById('btn-preset-confirm')?.click();
      const presetSel = document.getElementById('user-preset-select');
      if (!presetSel || presetSel.classList.contains('hidden')) throw new Error('保存预设后下拉框未显示');
      setFps('10');
      presetSel.dispatchEvent(new Event('change'));
      if (document.querySelector('#params select[data-key="fps"]').value !== '20') {
        throw new Error('应用预设未恢复之前保存的帧率');
      }
      document.getElementById('btn-del-preset')?.click();
      if (!document.getElementById('user-preset-select').classList.contains('hidden')) throw new Error('已删除的预设仍在列表中');

      // 测试带参数入画布桥接
      document.getElementById('btn-params-to-wf')?.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (document.getElementById('workflow-main').classList.contains('hidden')) {
        throw new Error('点击带参数入画布后未切换到工作流模式');
      }
      modeBtnSingle.click();
      await new Promise((r) => setTimeout(r, 60));

      // 8. 校验热更新弹窗开启与关闭
      const updBtn = document.getElementById('btn-check-update');
      if (!updBtn) throw new Error('热更新按钮缺失');
      updBtn.click();
      await new Promise((r) => setTimeout(r, 80));
      const updModal = document.getElementById('update-modal');
      if (!updModal) throw new Error('热更新弹窗未能打开');
      if (!updModal.textContent.includes('公开测试版') || !updModal.textContent.includes('v0.1.0')) {
        throw new Error('应用未显示公开测试版版本号');
      }
      document.getElementById('upd-x-close')?.click();
      await new Promise((r) => setTimeout(r, 40));
      if (document.getElementById('update-modal')) throw new Error('热更新弹窗未能关闭');

      return { paletteCount, tplCount, singleItems, updaterChecked: true, presetAndBridgeChecked: true };
    })()`);

    await checkPdfTools(win);
    await checkImageOcr(win);
    if (errors.length) {
      console.error('渲染进程出现错误:\n' + errors.join('\n'));
      app.exit(1);
      return;
    }
    await checkDocumentExport();
    console.log('WORKFLOW_UI_OK', JSON.stringify({ ...result, documentExportChecked: true, pdfToolsChecked: true, imageOcrChecked: true }));
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
    app.exit(0);
  } catch (err) {
    console.error('UI 校验失败:', err.message);
    if (errors.length) console.error(errors.join('\n'));
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
    app.exit(1);
  }
});
