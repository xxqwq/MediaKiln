// 构建前从桌面应用源码中提取功能注册表、工作流节点与模板，生成官网数据（单一事实来源，避免手动同步）
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..', '..');
const RENDERER = path.join(APP_ROOT, 'renderer');
const OUT_FILE = path.resolve(__dirname, '..', 'src', 'data', 'app-data.json');
const require = createRequire(import.meta.url);

const GITHUB_REPO = 'xxqwq/MediaKiln';

// 1. 在沙箱中执行浏览器端功能注册脚本（IIFE 挂载到 window.VGT）
const sandbox = { window: { VGT: {} }, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const file of ['video-gif.js', 'image.js', 'svg.js', 'document.js']) {
  const code = fs.readFileSync(path.join(RENDERER, 'features', file), 'utf8');
  vm.runInContext(code, sandbox, { filename: file });
}
const VGT = sandbox.window.VGT;
const rawFeatures = [
  ...(VGT.VIDEO_FEATURES || []),
  ...(VGT.IMAGE_FEATURES || []),
  ...(VGT.SVG_FEATURES || []),
  ...(VGT.DOC_FEATURES || []),
];

// 与 renderer/app.js 中保持一致的分组顺序
const GROUP_ORDER = ['转换', 'GIF 编辑', '图片', 'SVG', '文档', '剪辑', '音频', '工具'];

const features = rawFeatures.map((f) => ({
  id: f.id,
  group: f.group,
  icon: f.icon,
  name: f.name,
  desc: f.desc,
  accept: Array.from(f.accept || []),
  multi: !!f.multi,
  noBatch: !!f.noBatch,
  batch: !f.multi && !f.noBatch,
}));

// 2. 工作流节点注册表与模板（UMD 模块，可直接 require）
const registryMod = require(path.join(RENDERER, 'workflow', 'node-registry.js'));
const templatesMod = require(path.join(RENDERER, 'workflow', 'templates.js'));
const registry = registryMod.createRegistry(rawFeatures);
const allDefs = registry.getAllDefs();

const portOf = (p) => ({ id: p.id, label: p.label, type: p.typeId || 'any' });
const nodes = allDefs.map((d) => ({
  type: d.type,
  group: d.group,
  icon: d.icon,
  name: d.name,
  isIo: !!d.isIo,
  inputs: (d.inputs || []).map(portOf),
  outputs: (d.outputs || []).map(portOf),
}));
const nodeByType = new Map(nodes.map((n) => [n.type, n]));

const templates = templatesMod.WORKFLOW_TEMPLATES.map((t) => ({
  id: t.id,
  name: t.name,
  desc: t.desc,
  category: t.category,
  graph: {
    name: t.graph.name,
    nodes: t.graph.nodes.map((n) => {
      const def = nodeByType.get(n.type) || {};
      return {
        id: n.id, type: n.type, x: n.x, y: n.y, name: def.name || n.type, icon: def.icon || '•', group: def.group || '', isIo: !!def.isIo,
        inputs: (def.inputs || []).map((p) => ({ id: p.id, label: p.label, type: p.type })),
        outputs: (def.outputs || []).map((p) => ({ id: p.id, label: p.label, type: p.type })),
      };
    }),
    edges: t.graph.edges.map((e) => ({ from: e.fromNode, fromPort: e.fromPort, to: e.toNode, toPort: e.toPort })),
  },
}));

const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));

// 3. 最新包含桌面安装包的已发布 Release（跳过仅包含热更新包的 -HotfixOnly Release）
async function fetchLatestRelease() {
  try {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'vgt-website-build' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=10`, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    const j = (Array.isArray(list) ? list : []).find((r) =>
      !r.draft && r.prerelease && /^v0\.\d+\.\d+$/.test(r.tag_name)
        && ['setup', 'portable'].every((kind) => (r.assets || []).some(
          (a) => a.name === `mediakiln-${r.tag_name.slice(1)}-${kind}.exe`
            || a.name === `video-gif-toolbox-${r.tag_name.slice(1)}-${kind}.exe`,
        )));
    if (!j) return null;
    return {
      tag: j.tag_name,
      version: String(j.tag_name || '').replace(/^v/, ''),
      publishedAt: j.published_at,
      assets: (j.assets || []).map((a) => ({ name: a.name, label: a.label || '', size: a.size, url: a.browser_download_url })),
    };
  } catch (err) {
    console.warn(`[extract] 获取最新 Release 失败（${err.message}），构建期将使用 v${pkg.shellVersion || pkg.version} 确定性下载直链回退`);
    return null;
  }
}
const latestRelease = await fetchLatestRelease();

const data = {
  generatedAt: new Date().toISOString(),
  app: {
    name: 'MediaKiln',
    productName: pkg.build?.productName || 'MediaKiln',
    version: pkg.version,
    shellVersion: pkg.shellVersion || pkg.version,
    description: pkg.description,
    license: pkg.license,
    repo: GITHUB_REPO,
    electron: (pkg.devDependencies?.electron || '').replace(/^[^\d]*/, ''),
    ffmpeg: '9.0.2',
  },
  latestRelease,
  groupOrder: GROUP_ORDER,
  groupMeta: registryMod.GROUP_META,
  portTypes: Object.fromEntries(Object.entries(registryMod.PORT_TYPES).map(([k, v]) => [k, { label: v.label, color: v.color }])),
  stats: {
    features: features.length,
    groups: new Set(features.map((f) => f.group)).size,
    batchFeatures: features.filter((f) => f.batch).length,
    nodes: nodes.length,
    ioNodes: nodes.filter((n) => n.isIo).length,
    templates: templates.length,
    formats: new Set(features.flatMap((f) => f.accept)).size,
  },
  features,
  nodes,
  templates,
};

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log(`[extract] v${data.app.version}（最新 Release：${latestRelease?.tag || '未知'}） · ${data.stats.features} 功能 / ${data.stats.groups} 分类 / ${data.stats.nodes} 节点 / ${data.stats.templates} 模板 → ${path.relative(process.cwd(), OUT_FILE)}`);
