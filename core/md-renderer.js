'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const hljs = require('highlight.js');
const { registerCancelableTask, throwIfTaskCancelled, writeTaskOutput } = require('./runner');

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resolveAssetSrc(rawSrc, baseDir) {
  const src = String(rawSrc || '').trim();
  if (!src) return src;
  if (/^(https?:|data:|file:|mailto:|#)/i.test(src)) return src;
  let cleaned = src;
  if (cleaned.startsWith('<') && cleaned.endsWith('>')) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return pathToFileURL(path.resolve(baseDir || process.cwd(), cleaned)).href;
}

function extractInlineImagesAndCode(text, baseDir) {
  // 先保护行内代码 `...`
  const codeSpans = [];
  let out = String(text || '').replace(/(`+)([^`]*?)\1/g, (_m, _ticks, code) => {
    const idx = codeSpans.length;
    codeSpans.push(`<code>${escapeHtml(code.trim())}</code>`);
    return `\u0000CODE${idx}\u0000`;
  });

  // 保护转义字符 \* 等
  const escapes = [];
  out = out.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, (_m, ch) => {
    const idx = escapes.length;
    escapes.push(escapeHtml(ch));
    return `\u0000ESC${idx}\u0000`;
  });

  // 图片 ![alt](url "title")
  out = out.replace(/!\[([^\]]*)\]\(([^)\n]+)\)/g, (_m, alt, rawTarget) => {
    let target = rawTarget.trim();
    let title = '';
    const tm = target.match(/^(.+?)\s+(?:"([^"]*)"|'([^']*)')\s*$/);
    if (tm) {
      target = tm[1].trim();
      title = tm[2] ?? tm[3] ?? '';
    }
    const resolved = resolveAssetSrc(target, baseDir);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    const idx = codeSpans.length;
    codeSpans.push(`<img src="${escapeHtml(resolved)}" alt="${escapeHtml(alt)}"${titleAttr} />`);
    return `\u0000CODE${idx}\u0000`;
  });

  // 链接 [text](url "title")
  out = out.replace(/\[([^\]]+)\]\(([^)\n]+)\)/g, (_m, label, rawTarget) => {
    let target = rawTarget.trim();
    let title = '';
    const tm = target.match(/^(.+?)\s+(?:"([^"]*)"|'([^']*)')\s*$/);
    if (tm) {
      target = tm[1].trim();
      title = tm[2] ?? tm[3] ?? '';
    }
    const href = resolveAssetSrc(target, baseDir);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    const idx = codeSpans.length;
    codeSpans.push(`<a href="${escapeHtml(href)}"${titleAttr}>${formatInlineRich(label, baseDir)}</a>`);
    return `\u0000CODE${idx}\u0000`;
  });

  // 保留常见安全内联 HTML 标签（<img> <br> <kbd> <sub> <sup> <mark>）
  const htmlTags = [];
  out = out.replace(/<(img\b[^>]*|br\s*\/?|hr\s*\/?|\/?(?:kbd|sub|sup|mark|strong|em|b|i|u|s|del|code|span|a)\b[^>]*)>/gi, (m, inner) => {
    let tag = m;
    if (/^img\b/i.test(inner)) {
      tag = m.replace(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i, (_sm, d, s) => {
        const val = d ?? s ?? '';
        return `src="${escapeHtml(resolveAssetSrc(val, baseDir))}"`;
      });
    }
    const idx = htmlTags.length;
    htmlTags.push(tag);
    return `\u0000TAG${idx}\u0000`;
  });

  out = escapeHtml(out);
  out = out
    .replace(/\*\*\*([\s\S]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/___([\s\S]+?)___/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([\s\S]+?)__/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+?)\*/g, '<em>$1</em>')
    .replace(/(^|[^a-zA-Z0-9])_([^_\n]+?)_(?=[^a-zA-Z0-9]|$)/g, '$1<em>$2</em>')
    .replace(/~~([\s\S]+?)~~/g, '<del>$1</del>');

  out = out.replace(/\u0000TAG(\d+)\u0000/g, (_m, i) => htmlTags[Number(i)] || '');
  out = out.replace(/\u0000ESC(\d+)\u0000/g, (_m, i) => escapes[Number(i)] || '');
  out = out.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => codeSpans[Number(i)] || '');
  return out;
}

function formatInlineRich(text, baseDir) {
  return extractInlineImagesAndCode(text, baseDir);
}

function splitTableCells(line) {
  let s = String(line || '').trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += s[i];
    }
  }
  cells.push(cur.trim());
  return cells;
}

function parseTableAlignments(sepLine) {
  if (!sepLine || !sepLine.includes('|') && !sepLine.includes('-')) return null;
  const rawCells = splitTableCells(sepLine);
  if (!rawCells.length) return null;
  const aligns = [];
  for (const c of rawCells) {
    if (!/^:?-{2,}:?$/.test(c)) return null;
    if (c.startsWith(':') && c.endsWith(':')) aligns.push('center');
    else if (c.endsWith(':')) aligns.push('right');
    else aligns.push('left');
  }
  return aligns;
}

function renderListBlock(lines, startIdx, baseDir) {
  const getIndent = (line) => (line.match(/^(\s*)/)?.[1] || '').replace(/\t/g, '  ').length;
  const parseItemMarker = (line) => {
    const u = line.match(/^(\s*)([-*+])\s+(.*)$/);
    if (u) return { indent: getIndent(line), ordered: false, content: u[3] };
    const o = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (o) return { indent: getIndent(line), ordered: true, start: Number(o[2]), content: o[3] };
    return null;
  };

  const first = parseItemMarker(lines[startIdx]);
  if (!first) return null;

  const baseIndent = first.indent;
  const ordered = first.ordered;
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && first.start && first.start !== 1 ? ` start="${first.start}"` : '';
  const items = [];
  let i = startIdx;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // 查看空行后是否仍是同级列表项
      let look = i + 1;
      while (look < lines.length && !lines[look].trim()) look++;
      const nxt = look < lines.length ? parseItemMarker(lines[look]) : null;
      if (nxt && nxt.indent >= baseIndent && (nxt.indent > baseIndent || nxt.ordered === ordered)) {
        i = look;
        continue;
      }
      break;
    }

    const m = parseItemMarker(line);
    if (m && m.indent === baseIndent && m.ordered === ordered) {
      let itemBody = m.content;
      let taskHtml = '';
      const taskM = itemBody.match(/^\[([ xX])\]\s+(.*)$/);
      if (taskM) {
        const checked = taskM[1].toLowerCase() === 'x';
        taskHtml = `<input type="checkbox" disabled${checked ? ' checked' : ''} /> `;
        itemBody = taskM[2];
      }
      const subParts = [taskHtml + formatInlineRich(itemBody, baseDir)];
      i++;

      while (i < lines.length) {
        const subLine = lines[i];
        if (!subLine.trim()) break;
        const subM = parseItemMarker(subLine);
        if (subM) {
          if (subM.indent > baseIndent) {
            const subList = renderListBlock(lines, i, baseDir);
            if (subList) {
              subParts.push(subList.html);
              i = subList.nextIdx;
              continue;
            }
          }
          break;
        }
        if (getIndent(subLine) > baseIndent) {
          subParts.push(formatInlineRich(subLine.trim(), baseDir));
          i++;
        } else {
          break;
        }
      }
      items.push(`<li>${subParts.join('\n')}</li>`);
    } else if (m && m.indent > baseIndent) {
      const subList = renderListBlock(lines, i, baseDir);
      if (subList && items.length) {
        items[items.length - 1] = items[items.length - 1].replace(/<\/li>$/, `${subList.html}</li>`);
        i = subList.nextIdx;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  return {
    html: `<${tag}${startAttr}>\n${items.join('\n')}\n</${tag}>`,
    nextIdx: i,
  };
}

function renderMarkdownBody(mdText, baseDir) {
  let raw = String(mdText || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  // 去掉 YAML front-matter
  let frontMeta = null;
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (fmMatch) {
    const titleM = fmMatch[1].match(/^\s*title\s*:\s*(.+)$/mi);
    if (titleM) frontMeta = { title: titleM[1].trim().replace(/^["']|["']$/g, '') };
    raw = raw.slice(fmMatch[0].length);
  }

  const lines = raw.split('\n');
  const blocks = [];
  let title = frontMeta?.title || '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // 围栏代码块 ```lang
    const fenceM = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^\s`~]*)/);
    if (fenceM) {
      const ch = fenceM[1][0];
      const len = fenceM[1].length;
      const lang = (fenceM[2] || '').trim();
      const closeRe = new RegExp(`^\\s{0,3}${ch}{${len},}\\s*$`);
      const codeLines = [];
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const badge = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
      const source = codeLines.join('\n');
      const language = lang.toLowerCase();
      const code = hljs.getLanguage(language) ? hljs.highlight(source, { language, ignoreIllegals: true }).value : escapeHtml(source);
      blocks.push(`<div class="code-wrap">${badge}<pre><code>${code}</code></pre></div>`);
      continue;
    }

    // 标题 # ... ######
    const hMatch = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (hMatch) {
      const lvl = hMatch[1].length;
      const headingText = hMatch[2].trim();
      if (!title && lvl === 1) title = headingText.replace(/[*_`~[\]]/g, '').trim();
      blocks.push(`<h${lvl}>${formatInlineRich(headingText, baseDir)}</h${lvl}>`);
      i++;
      continue;
    }

    // 分割线 --- / *** / ___
    if (/^\s{0,3}(?:-\s*-\s*-+|\*\s*\*\s*\*+|_\s*_\s*_+)[\s\-*_]*$/.test(line)) {
      blocks.push('<hr />');
      i++;
      continue;
    }

    // 引用与 GFM Callouts (> [!NOTE] 等)
    if (/^\s{0,3}>\s?/.test(line)) {
      const qLines = [];
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
        qLines.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i++;
      }
      const calloutM = qLines[0]?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
      if (calloutM) {
        const kind = calloutM[1].toLowerCase();
        const labelMap = { note: '说明 NOTE', tip: '提示 TIP', important: '重要 IMPORTANT', warning: '警告 WARNING', caution: '注意 CAUTION' };
        const rest = [calloutM[2], ...qLines.slice(1)].filter(Boolean).join('\n');
        const innerHtml = renderMarkdownBody(rest, baseDir).html;
        blocks.push(`<div class="callout callout-${kind}"><div class="callout-title">${labelMap[kind] || calloutM[1]}</div>${innerHtml}</div>`);
      } else {
        const innerHtml = renderMarkdownBody(qLines.join('\n'), baseDir).html;
        blocks.push(`<blockquote>${innerHtml}</blockquote>`);
      }
      continue;
    }

    // GFM 表格
    if (line.includes('|') && i + 1 < lines.length) {
      const aligns = parseTableAlignments(lines[i + 1]);
      if (aligns) {
        const headers = splitTableCells(line);
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          rows.push(splitTableCells(lines[i]));
          i++;
        }
        const ths = headers.map((h, idx) => `<th style="text-align:${aligns[idx] || 'left'}">${formatInlineRich(h, baseDir)}</th>`).join('');
        const trs = rows.map((r) => {
          const tds = aligns.map((al, idx) => `<td style="text-align:${al}">${formatInlineRich(r[idx] || '', baseDir)}</td>`).join('');
          return `<tr>${tds}</tr>`;
        }).join('\n');
        blocks.push(`<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`);
        continue;
      }
    }

    // 有序 / 无序列表
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      const listRes = renderListBlock(lines, i, baseDir);
      if (listRes) {
        blocks.push(listRes.html);
        i = listRes.nextIdx;
        continue;
      }
    }

    // 原生块级 SVG / HTML
    if (/^\s*<svg\b/i.test(line)) {
      const svgLines = [line];
      if (!/<\/svg>/i.test(line)) {
        i++;
        while (i < lines.length) {
          svgLines.push(lines[i]);
          if (/<\/svg>/i.test(lines[i])) break;
          i++;
        }
      }
      i++;
      blocks.push(`<div class="svg-block">${svgLines.join('\n')}</div>`);
      continue;
    }

    // 普通段落
    const paraLines = [];
    while (
      i < lines.length
      && lines[i].trim()
      && !/^\s{0,3}(#{1,6}\s+|```|~~~|>\s?|[-*+]\s+|\d+\.\s+|(?:-\s*-\s*-+|\*\s*\*\s*\*+|_\s*_\s*_+)\s*$)/.test(lines[i])
      && !(lines[i].includes('|') && i + 1 < lines.length && parseTableAlignments(lines[i + 1]))
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }
    const paraJoined = paraLines.join('\n').replace(/  \n/g, '<br />\n').replace(/\n/g, ' ');
    blocks.push(`<p>${formatInlineRich(paraJoined, baseDir)}</p>`);
  }

  return { html: blocks.join('\n'), title };
}

const THEME_CSS = {
  clean: {
    pageBg: '#ffffff',
    text: '#1e293b',
    muted: '#64748b',
    heading: '#0f172a',
    accent: '#4f46e5',
    border: '#e2e8f0',
    codeBg: '#f8fafc',
    inlineCodeBg: '#f1f5f9',
    quoteBg: '#f8fafc',
    tableHeadBg: '#f1f5f9',
    tableStripe: '#f8fafc',
  },
  github: {
    pageBg: '#ffffff',
    text: '#1f2328',
    muted: '#59636e',
    heading: '#1f2328',
    accent: '#0969da',
    border: '#d0d7de',
    codeBg: '#f6f8fa',
    inlineCodeBg: 'rgba(175,184,193,0.2)',
    quoteBg: '#ffffff',
    tableHeadBg: '#f6f8fa',
    tableStripe: '#f6f8fa',
  },
  warm: {
    pageBg: '#fbf8f1',
    text: '#3b3228',
    muted: '#7a6b5d',
    heading: '#261e16',
    accent: '#b45309',
    border: '#e7decb',
    codeBg: '#f3ede0',
    inlineCodeBg: '#efe7d6',
    quoteBg: '#f6f1e6',
    tableHeadBg: '#efe7d6',
    tableStripe: '#f7f2e7',
  },
  dark: {
    pageBg: '#0f172a',
    text: '#e2e8f0',
    muted: '#94a3b8',
    heading: '#f8fafc',
    accent: '#818cf8',
    border: '#334155',
    codeBg: '#1e293b',
    inlineCodeBg: '#1e293b',
    quoteBg: '#172033',
    tableHeadBg: '#1e293b',
    tableStripe: '#162033',
  },
};

function resolveMarginSpec(marginKey) {
  if (marginKey === 'narrow') return { mm: '10mm', inches: 0.39 };
  if (marginKey === 'wide') return { mm: '22mm', inches: 0.87 };
  return { mm: '15mm', inches: 0.59 };
}

function buildStyledHtmlDocument(mdText, opts = {}) {
  const themeKey = THEME_CSS[opts.theme] ? opts.theme : 'clean';
  const t = THEME_CSS[themeKey];
  const marginSpec = resolveMarginSpec(opts.margin);
  const pageSizeCss = opts.pageSize === 'a4l'
    ? 'A4 landscape'
    : (opts.pageSize === 'letter' ? 'Letter' : 'A4 portrait');
  const { html: bodyHtml, title } = renderMarkdownBody(mdText, opts.baseDir);
  const docTitle = title || opts.fallbackTitle || 'Document';
  const baseHref = opts.baseDir ? `<base href="${escapeHtml(pathToFileURL(opts.baseDir + path.sep).href)}" />` : '';

  const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  ${baseHref}
  <title>${escapeHtml(docTitle)}</title>
  <style>
    @page {
      size: ${pageSizeCss};
      margin: ${marginSpec.mm};
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: ${t.pageBg};
      color: ${t.text};
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      font-family: "Microsoft YaHei UI", "PingFang SC", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 14.5px;
      line-height: 1.75;
    }
    .doc-body {
      max-width: 100%;
      margin: 0 auto;
      word-wrap: break-word;
    }
    h1, h2, h3, h4, h5, h6 {
      color: ${t.heading};
      font-weight: 700;
      line-height: 1.35;
      margin: 1.35em 0 0.55em;
      break-after: avoid;
      page-break-after: avoid;
    }
    h1 { font-size: 2em; margin-top: 0; padding-bottom: 0.35em; border-bottom: 2px solid ${t.border}; }
    h2 { font-size: 1.5em; padding-bottom: 0.25em; border-bottom: 1px solid ${t.border}; }
    h3 { font-size: 1.22em; }
    h4 { font-size: 1.05em; }
    p { margin: 0.7em 0; }
    a { color: ${t.accent}; text-decoration: none; border-bottom: 1px solid ${t.border}; }
    img, svg { max-width: 100%; height: auto; border-radius: 6px; }
    p > img:only-child { display: block; margin: 1em auto; }
    hr { border: none; border-top: 1px solid ${t.border}; margin: 1.6em 0; }
    blockquote {
      margin: 1em 0;
      padding: 0.6em 1em;
      border-left: 4px solid ${t.accent};
      background: ${t.quoteBg};
      color: ${t.muted};
      border-radius: 0 6px 6px 0;
    }
    blockquote p { margin: 0.35em 0; }
    code {
      font-family: "Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace;
      font-size: 0.88em;
      background: ${t.inlineCodeBg};
      padding: 2px 6px;
      border-radius: 4px;
    }
    .code-wrap {
      position: relative;
      margin: 1em 0;
      break-inside: avoid;
    }
    .code-lang {
      position: absolute;
      top: 6px;
      right: 10px;
      font-size: 11px;
      color: ${t.muted};
      font-family: Consolas, monospace;
      text-transform: uppercase;
    }
    pre {
      margin: 0;
      padding: 14px 16px;
      background: ${t.codeBg};
      border: 1px solid ${t.border};
      border-radius: 8px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.55;
    }
    pre code {
      background: none;
      padding: 0;
      font-size: 13px;
    }
    ul, ol { margin: 0.65em 0; padding-left: 1.65em; }
    li { margin: 0.25em 0; }
    li input[type="checkbox"] { margin-right: 6px; accent-color: ${t.accent}; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1.1em 0;
      font-size: 13.5px;
      break-inside: avoid;
    }
    th, td {
      border: 1px solid ${t.border};
      padding: 8px 12px;
    }
    th {
      background: ${t.tableHeadBg};
      color: ${t.heading};
      font-weight: 600;
    }
    tbody tr:nth-child(even) { background: ${t.tableStripe}; }
    .callout {
      margin: 1em 0;
      padding: 10px 14px;
      border-radius: 8px;
      border-left: 4px solid ${t.accent};
      background: ${t.quoteBg};
      break-inside: avoid;
    }
    .callout-title {
      font-weight: 700;
      font-size: 13px;
      margin-bottom: 4px;
      color: ${t.accent};
    }
    .callout-warning { border-left-color: #f59e0b; }
    .callout-warning .callout-title { color: #d97706; }
    .callout-caution { border-left-color: #ef4444; }
    .callout-caution .callout-title { color: #dc2626; }
    .callout-tip { border-left-color: #10b981; }
    .callout-tip .callout-title { color: #059669; }
    .svg-block { margin: 1em 0; text-align: center; }
    .hljs-keyword, .hljs-selector-tag, .hljs-title { color: ${t.accent}; font-weight: 600; }
    .hljs-string, .hljs-regexp { color: ${themeKey === 'dark' ? '#86efac' : '#166534'}; }
    .hljs-number, .hljs-literal, .hljs-attr { color: ${themeKey === 'dark' ? '#fcd34d' : '#92400e'}; }
    .hljs-comment { color: ${t.muted}; font-style: italic; }
  </style>
</head>
<body>
  <article class="doc-body">${bodyHtml}</article>
</body>
</html>`;

  return { html: fullHtml, title: docTitle };
}

function resolveElectronRuntime() {
  const appRoot = path.resolve(__dirname, '..');
  const isPackagedAsar = __dirname.includes('app.asar');
  const buildResult = (exe) => {
    if (!exe || !fs.existsSync(exe)) return null;
    const base = path.basename(exe).toLowerCase();
    const isDevElectron = base === 'electron.exe' || base === 'electron';
    return {
      exe,
      argsPrefix: isDevElectron && !isPackagedAsar ? [appRoot] : [],
    };
  };

  if (process.env.VGT_ELECTRON_EXE) {
    const r = buildResult(process.env.VGT_ELECTRON_EXE);
    if (r) return r;
  }
  if (process.versions?.electron && process.env.ELECTRON_RUN_AS_NODE) {
    const r = buildResult(process.execPath);
    if (r) return r;
  }
  try {
    const electronPath = require('electron');
    if (typeof electronPath === 'string') {
      const r = buildResult(electronPath);
      if (r) return r;
    }
  } catch {}
  return null;
}

function resolveSystemBrowser() {
  const candidates = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function killChildTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    killer.on('error', () => { try { child.kill(); } catch {} });
  } else {
    try { child.kill('SIGKILL'); } catch {}
  }
}

async function renderHtmlViaElectronHelper(htmlPath, outputPath, opts, runtime) {
  throwIfTaskCancelled(opts.taskId);
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_cli_pdf_'));
  const tempPdf = path.join(jobDir, 'out.pdf');
  const profileDir = path.join(jobDir, 'profile');
  const jobJsonPath = path.join(jobDir, 'job.json');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(jobJsonPath, JSON.stringify({
    htmlPath: path.resolve(htmlPath),
    outputPath: tempPdf,
    profileDir,
    opts: {
      pageSize: opts.pageSize,
      margin: opts.margin,
      pageNumbers: opts.pageNumbers,
      customMarginsIn: opts.customMarginsIn,
      customPageSize: opts.customPageSize,
    },
  }), 'utf8');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  let interruption = '';
  let child = null;
  let timeout = null;
  const release = registerCancelableTask(opts.taskId, () => {
    interruption = '任务已取消';
    killChildTree(child);
  });

  try {
    await new Promise((resolve, reject) => {
      child = spawn(runtime.exe, [...runtime.argsPrefix, '--cli-render-pdf', jobJsonPath], {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
      timeout = setTimeout(() => {
        interruption = '文档转换 PDF 超时';
        killChildTree(child);
      }, 65000);
      child.on('error', reject);
      child.on('close', (code) => {
        if (interruption) return reject(new Error(interruption));
        if (code === 0 && fs.existsSync(tempPdf)) return resolve();
        const detail = stderr.split(/\r?\n/).filter((l) => l.trim()).slice(-4).join('\n');
        reject(new Error(`PDF 排版渲染失败（退出码 ${code}）${detail ? '：' + detail : ''}`));
      });
    });

    throwIfTaskCancelled(opts.taskId);
    const pdfBuf = fs.readFileSync(tempPdf);
    if (!pdfBuf.length) throw new Error('PDF 排版渲染结果为空');
    writeTaskOutput(outputPath, pdfBuf);
  } finally {
    clearTimeout(timeout);
    release();
    try { fs.rmSync(jobDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch {}
  }
}

async function renderHtmlViaChromiumHeadless(htmlPath, outputPath, opts, browserExe) {
  throwIfTaskCancelled(opts.taskId);
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_cli_edgepdf_'));
  const tempPdf = path.join(jobDir, 'out.pdf');
  const profileDir = path.join(jobDir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--user-data-dir=${profileDir}`,
    `--print-to-pdf=${tempPdf}`,
  ];
  if (opts.pageNumbers !== 'yes') {
    args.push('--no-pdf-header-footer');
  }
  args.push(pathToFileURL(path.resolve(htmlPath)).href);

  let interruption = '';
  let child = null;
  let timeout = null;
  const release = registerCancelableTask(opts.taskId, () => {
    interruption = '任务已取消';
    killChildTree(child);
  });

  try {
    await new Promise((resolve, reject) => {
      child = spawn(browserExe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
      timeout = setTimeout(() => {
        interruption = '文档转换 PDF 超时';
        killChildTree(child);
      }, 65000);
      child.on('error', reject);
      child.on('close', (code) => {
        if (interruption) return reject(new Error(interruption));
        if (code === 0 && fs.existsSync(tempPdf)) return resolve();
        const detail = stderr.split(/\r?\n/).filter((l) => l.trim()).slice(-3).join('\n');
        reject(new Error(`浏览器无头打印 PDF 失败（退出码 ${code}）${detail ? '：' + detail : ''}`));
      });
    });

    throwIfTaskCancelled(opts.taskId);
    const pdfBuf = fs.readFileSync(tempPdf);
    if (!pdfBuf.length) throw new Error('PDF 排版渲染结果为空');
    writeTaskOutput(outputPath, pdfBuf);
  } finally {
    clearTimeout(timeout);
    release();
    try { fs.rmSync(jobDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch {}
  }
}

async function renderHtmlFileToPdf(htmlPath, outputPath, opts = {}) {
  throwIfTaskCancelled(opts.taskId);
  let electronMod = null;
  try {
    electronMod = require('electron');
  } catch {}
  const BrowserWindow = electronMod && typeof electronMod === 'object' ? electronMod.BrowserWindow : null;
  const session = electronMod && typeof electronMod === 'object' ? electronMod.session : null;
  if (!BrowserWindow || !session) {
    const runtime = resolveElectronRuntime();
    if (runtime) {
      return renderHtmlViaElectronHelper(htmlPath, outputPath, opts, runtime);
    }
    const browserExe = resolveSystemBrowser();
    if (browserExe) {
      return renderHtmlViaChromiumHeadless(htmlPath, outputPath, opts, browserExe);
    }
    throw new Error('未找到可用的 PDF 排版渲染器（请安装 MediaKiln 桌面端或 Microsoft Edge）');
  }
  const printSession = session.fromPartition('vgt-pdf-print');
  // 打印本地文档，不允许文档发起网络请求、下载或打开其他页面。
  printSession.webRequest.onBeforeRequest(({ url }, callback) => {
    const allowed = /^(?:file:\/\/\/(?!\/)|data:|blob:|about:blank$)/i.test(url);
    callback({ cancel: !allowed });
  });
  printSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const pdfWin = new BrowserWindow({
    show: false,
    webPreferences: {
      session: printSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
    },
  });
  pdfWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  pdfWin.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  const denyDownload = (event, _item, contents) => {
    if (contents === pdfWin.webContents) event.preventDefault();
  };
  printSession.on('will-download', denyDownload);
  let interruption = '';
  const interrupt = (message) => {
    interruption = message;
    if (!pdfWin.isDestroyed()) pdfWin.destroy();
  };
  const release = registerCancelableTask(opts.taskId, () => interrupt('任务已取消'));
  const timeout = setTimeout(() => interrupt('文档转换 PDF 超时'), 60000);
  try {
    await pdfWin.loadFile(htmlPath);
    const footer = opts.pageNumbers === 'yes';
    const margin = parseFloat(resolveMarginSpec(opts.margin).mm) / 25.4;
    const cm = opts.customMarginsIn;
    const margins = footer
      ? (cm
        ? {
            top: Math.max(0.25, Number(cm.top) || margin),
            bottom: Math.max(0.45, Number(cm.bottom) || margin),
            left: Math.max(0.2, Number(cm.left) || margin),
            right: Math.max(0.2, Number(cm.right) || margin),
          }
        : { top: margin, bottom: margin, left: margin, right: margin })
      : { top: 0, bottom: 0, left: 0, right: 0 };

    const cp = opts.customPageSize;
    let pageSizeOpt = opts.pageSize === 'letter' ? 'Letter' : 'A4';
    let landscapeOpt = opts.pageSize === 'a4l';
    if (cp && Number(cp.widthIn) > 0 && Number(cp.heightIn) > 0) {
      const wIn = Math.max(1, Number(cp.widthIn));
      const hIn = Math.max(1, Number(cp.heightIn));
      landscapeOpt = typeof cp.landscape === 'boolean' ? cp.landscape : wIn > hIn;
      pageSizeOpt = { width: Math.min(wIn, hIn), height: Math.max(wIn, hIn) };
    }

    const pdf = await pdfWin.webContents.printToPDF({
      landscape: landscapeOpt,
      pageSize: pageSizeOpt,
      printBackground: true,
      generateTaggedPDF: true,
      generateDocumentOutline: true,
      preferCSSPageSize: !footer,
      margins,
      displayHeaderFooter: footer,
      ...(footer ? {
        headerTemplate: '<span></span>',
        footerTemplate: '<div style="width:100%;font-size:9px;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      } : {}),
    });
    if (interruption) throw new Error(interruption);
    if (opts.directWrite) {
      fs.writeFileSync(outputPath, pdf);
    } else {
      writeTaskOutput(outputPath, pdf);
    }
  } catch (error) {
    if (interruption) throw new Error(interruption, { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
    release();
    printSession.removeListener('will-download', denyDownload);
    if (!pdfWin.isDestroyed()) pdfWin.destroy();
  }
}

async function convertDocToPdf(inputPath, outputPath, opts = {}) {
  const ext = path.extname(String(inputPath || '')).slice(1).toLowerCase();
  const baseDir = path.dirname(path.resolve(inputPath));
  const stem = path.basename(inputPath, path.extname(inputPath));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgt_doc2pdf_'));

  try {
    const htmlPath = path.join(tmpDir, 'render.html');
    let title = stem;

    if (ext === 'html' || ext === 'htm') {
      let rawHtml = fs.readFileSync(inputPath, 'utf8');
      if (!/<base\b/i.test(rawHtml)) {
        const baseTag = `<base href="${escapeHtml(pathToFileURL(baseDir + path.sep).href)}" />`;
        rawHtml = /<head\b[^>]*>/i.test(rawHtml)
          ? rawHtml.replace(/<head\b[^>]*>/i, (m) => `${m}\n  ${baseTag}`)
          : `${baseTag}\n${rawHtml}`;
      }
      const marginSpec = resolveMarginSpec(opts.margin);
      const pageSizeCss = opts.pageSize === 'a4l' ? 'A4 landscape' : (opts.pageSize === 'letter' ? 'Letter' : 'A4 portrait');
      const printStyle = `<style>@page { size: ${pageSizeCss}; margin: ${marginSpec.mm}; } html, body { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }</style>`;
      rawHtml = /<\/head>/i.test(rawHtml)
        ? rawHtml.replace(/<\/head>/i, `${printStyle}\n</head>`)
        : `${printStyle}\n${rawHtml}`;
      fs.writeFileSync(htmlPath, rawHtml, 'utf8');
    } else {
      const mdText = fs.readFileSync(inputPath, 'utf8');
      const rendered = buildStyledHtmlDocument(mdText, {
        theme: opts.theme || 'clean',
        pageSize: opts.pageSize || 'a4p',
        margin: opts.margin || 'normal',
        baseDir,
        fallbackTitle: stem,
      });
      title = rendered.title;
      fs.writeFileSync(htmlPath, rendered.html, 'utf8');
    }

    await renderHtmlFileToPdf(htmlPath, outputPath, {
      pageSize: opts.pageSize || 'a4p',
      margin: opts.margin || 'normal',
      pageNumbers: opts.pageNumbers || 'no',
      taskId: opts.taskId,
    });

    return {
      output: outputPath,
      title,
      outputSize: fs.statSync(outputPath).size,
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = {
  renderMarkdownBody,
  buildStyledHtmlDocument,
  renderHtmlFileToPdf,
  convertDocToPdf,
};
