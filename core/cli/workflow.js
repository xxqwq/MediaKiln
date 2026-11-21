'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const workflowCache = require('../workflow-cache');
const { mapConcurrent } = require('../utils');
const { normalizeKey } = require('./registry');
const { expandInputGlobs } = require('./args');

function cloneJson(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function uniqueExportPath(targetPath, noOverwrite) {
  if (!noOverwrite || !fs.existsSync(targetPath)) return targetPath;
  const ext = path.extname(targetPath);
  const stem = targetPath.slice(0, targetPath.length - ext.length);
  let i = 1;
  while (fs.existsSync(`${stem}_${i}${ext}`)) i++;
  return `${stem}_${i}${ext}`;
}

function uniqueExportDir(baseDir, folderName, noOverwrite) {
  const cleanName = String(folderName || 'workflow_export').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'workflow_export';
  const cand = path.join(baseDir, cleanName);
  if (!noOverwrite || !fs.existsSync(cand)) return cand;
  let i = 1;
  while (fs.existsSync(path.join(baseDir, `${cleanName}_${i}`))) i++;
  return path.join(baseDir, `${cleanName}_${i}`);
}

function resolveWorkflowGraph(catalog, target) {
  const raw = String(target || '').trim();
  if (!raw) throw new Error('请指定工作流 JSON 文件路径或内置模板 ID');

  const resolvedFile = path.resolve(raw);
  if (fs.existsSync(resolvedFile) && fs.statSync(resolvedFile).isFile()) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(resolvedFile, 'utf8'));
    } catch (err) {
      throw new Error(`工作流 JSON 解析失败（${resolvedFile}）：${err.message}`);
    }
    const graph = parsed?.graph && Array.isArray(parsed.graph.nodes) ? parsed.graph : parsed;
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      throw new Error(`无效的工作流 JSON 结构（缺少 nodes 或 edges）：${resolvedFile}`);
    }
    return {
      source: 'file',
      sourcePath: resolvedFile,
      id: path.basename(resolvedFile, path.extname(resolvedFile)),
      name: graph.name || path.basename(resolvedFile, path.extname(resolvedFile)),
      desc: parsed.desc || '',
      graph: cloneJson(graph),
    };
  }

  // 按序号（1..N）匹配
  if (/^\d+$/.test(raw)) {
    const idx = parseInt(raw, 10) - 1;
    if (idx >= 0 && idx < catalog.templates.length) {
      const tpl = catalog.templates[idx];
      return {
        source: 'template',
        id: tpl.id,
        name: tpl.name,
        desc: tpl.desc,
        category: tpl.category,
        graph: cloneJson(tpl.graph),
      };
    }
  }

  // 按模板 ID / 名称匹配
  const norm = normalizeKey(raw);
  const tpl = catalog.templates.find(
    (t) => t.id === raw || normalizeKey(t.id) === norm || normalizeKey(t.name) === norm,
  );
  if (tpl) {
    return {
      source: 'template',
      id: tpl.id,
      name: tpl.name,
      desc: tpl.desc,
      category: tpl.category,
      graph: cloneJson(tpl.graph),
    };
  }

  throw new Error(`未找到工作流文件或内置模板："${raw}"（运行 mediakiln workflow list 查看可用模板）`);
}

function getDownstreamAcceptExts(graph, registry, nodeId) {
  const exts = [];
  for (const e of graph.edges || []) {
    if (e.fromNode !== nodeId) continue;
    const toNode = (graph.nodes || []).find((n) => n.id === e.toNode);
    const toDef = toNode && registry.getDef(toNode.type);
    const inPort = toDef?.inputs?.find((p) => p.id === e.toPort);
    if (inPort?.accept?.length) exts.push(...inPort.accept);
  }
  return Array.from(new Set(exts.map((x) => String(x).toLowerCase())));
}

function applyWorkflowOverrides(graph, catalog, {
  inputs = [],
  outDir = '',
  noOverwrite = null,
  suffix = null,
  paramOverrides = [],
} = {}) {
  const nodes = graph.nodes || [];
  const inputNodes = nodes
    .filter((n) => ['io.loadFile', 'io.loadBatch', 'io.loadFolder'].includes(n.type))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));

  const namedBindings = [];
  const positionalBindings = [];

  for (const rawIn of inputs) {
    const str = String(rawIn || '').trim();
    if (!str) continue;
    const eqIdx = str.indexOf('=');
    // 排除 Windows 盘符路径（例如 C:\... 不含 =）
    if (eqIdx > 0 && !/[\\/]/.test(str.slice(0, eqIdx))) {
      const targetId = str.slice(0, eqIdx).trim();
      const val = str.slice(eqIdx + 1).trim();
      namedBindings.push({ targetId, val });
    } else {
      positionalBindings.push(str);
    }
  }

  const bindNodeValue = (node, rawPaths) => {
    node.params = node.params || {};
    const expanded = expandInputGlobs(Array.isArray(rawPaths) ? rawPaths : [rawPaths]);
    if (!expanded.length) throw new Error(`节点 ${node.id} 的输入路径为空`);
    for (const p of expanded) {
      if (!fs.existsSync(p)) throw new Error(`输入路径不存在：${p}`);
    }
    if (node.type === 'io.loadFolder') {
      const target = expanded[0];
      if (!fs.statSync(target).isDirectory()) {
        throw new Error(`输入节点 ${node.id}（文件夹扫描）需要文件夹路径，但收到文件：${target}`);
      }
      node.params.dirPath = target;
      return;
    }
    if (node.type === 'io.loadBatch') {
      const files = [];
      for (const p of expanded) {
        if (fs.statSync(p).isDirectory()) {
          const entries = fs.readdirSync(p, { withFileTypes: true })
            .filter((ent) => ent.isFile() && !ent.name.startsWith('.'))
            .map((ent) => path.join(p, ent.name))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
          files.push(...entries);
        } else {
          files.push(p);
        }
      }
      if (!files.length) throw new Error(`输入节点 ${node.id} 未找到任何有效文件`);
      node.params.filePaths = files;
      return;
    }
    // io.loadFile
    const first = expanded[0];
    if (fs.statSync(first).isDirectory()) {
      throw new Error(`输入节点 ${node.id}（单文件输入）需要文件路径，但收到文件夹：${first}`);
    }
    node.params.filePath = first;
  };

  const boundNodeIds = new Set();

  // 1. 先处理显式 nodeId=path 绑定
  for (const b of namedBindings) {
    const node = nodes.find((n) => n.id === b.targetId);
    if (!node || !['io.loadFile', 'io.loadBatch', 'io.loadFolder'].includes(node.type)) {
      throw new Error(`工作流中未找到输入节点 "${b.targetId}"（可用输入节点：${inputNodes.map((n) => n.id).join(', ') || '无'}）`);
    }
    bindNodeValue(node, b.val.split(',').map((x) => x.trim()).filter(Boolean));
    boundNodeIds.add(node.id);
  }

  // 2. 再处理位置输入绑定
  const unboundInputs = inputNodes.filter((n) => !boundNodeIds.has(n.id));
  if (positionalBindings.length && unboundInputs.length) {
    if (unboundInputs.length === 1 && unboundInputs[0].type === 'io.loadBatch') {
      bindNodeValue(unboundInputs[0], positionalBindings);
      boundNodeIds.add(unboundInputs[0].id);
    } else if (unboundInputs.length === 1) {
      bindNodeValue(unboundInputs[0], positionalBindings[0]);
      boundNodeIds.add(unboundInputs[0].id);
    } else {
      // 多个输入节点：优先按类型与下游接受格式智能匹配，再按顺序回退
      const remainingNodes = unboundInputs.slice();
      for (const rawPath of positionalBindings) {
        if (!remainingNodes.length) break;
        const expanded = expandInputGlobs([rawPath]);
        const sample = expanded[0];
        if (!fs.existsSync(sample)) throw new Error(`输入路径不存在：${sample}`);
        const isDir = fs.statSync(sample).isDirectory();
        const ext = path.extname(sample).slice(1).toLowerCase();

        let pickIdx = -1;
        if (isDir) {
          pickIdx = remainingNodes.findIndex((n) => n.type === 'io.loadFolder');
        }
        if (pickIdx === -1 && !isDir && ext) {
          pickIdx = remainingNodes.findIndex((n) => {
            if (n.type === 'io.loadFolder') return false;
            const accept = getDownstreamAcceptExts(graph, catalog.registry, n.id);
            return accept.length && !accept.includes('*') && accept.includes(ext === 'jpeg' ? 'jpg' : ext);
          });
        }
        if (pickIdx === -1) {
          pickIdx = remainingNodes.findIndex((n) => (isDir ? n.type !== 'io.loadFile' : n.type !== 'io.loadFolder'));
        }
        if (pickIdx === -1) pickIdx = 0;

        const targetNode = remainingNodes.splice(pickIdx, 1)[0];
        bindNodeValue(targetNode, expanded);
        boundNodeIds.add(targetNode.id);
      }
    }
  }

  // 3. 覆盖 io.save 节点导出设置
  if (outDir) {
    const resolvedOut = path.resolve(outDir);
    for (const n of nodes) {
      if (n.type === 'io.save') {
        n.params = n.params || {};
        n.params.outMode = 'custom';
        n.params.customDir = resolvedOut;
      }
    }
  }
  if (noOverwrite !== null) {
    for (const n of nodes) {
      if (n.type === 'io.save') {
        n.params = n.params || {};
        n.params.noOverwrite = noOverwrite ? 'yes' : 'no';
      }
    }
  }
  if (suffix !== null) {
    for (const n of nodes) {
      if (n.type === 'io.save') {
        n.params = n.params || {};
        n.params.suffix = String(suffix);
      }
    }
  }

  // 4. 动态参数覆盖：--param nodeId.key=val 或 --param featureId.key=val
  for (const expr of paramOverrides) {
    const str = String(expr || '').trim();
    const eqIdx = str.indexOf('=');
    if (eqIdx <= 0) {
      throw new Error(`--param 格式应为 "节点ID.参数名=值"，收到："${str}"`);
    }
    const lhs = str.slice(0, eqIdx).trim();
    const val = str.slice(eqIdx + 1);
    const dotIdx = lhs.indexOf('.');
    if (dotIdx <= 0 || dotIdx === lhs.length - 1) {
      throw new Error(`--param 左侧格式应为 "节点ID.参数名"，收到："${lhs}"`);
    }
    const nodeKey = lhs.slice(0, dotIdx).trim();
    const paramKey = lhs.slice(dotIdx + 1).trim();

    let matched = nodes.filter((n) => n.id === nodeKey);
    if (!matched.length) {
      const normKey = normalizeKey(nodeKey);
      matched = nodes.filter((n) => {
        const fid = n.type.startsWith('feat.') ? n.type.slice(5) : n.type;
        return normalizeKey(fid) === normKey;
      });
    }
    if (!matched.length) {
      throw new Error(`--param 未找到节点 "${nodeKey}"（工作流节点：${nodes.map((n) => `${n.id}(${n.type})`).join(', ')}）`);
    }
    if (matched.length > 1) {
      throw new Error(`--param 匹配到多个节点（${matched.map((n) => n.id).join(', ')}），请改用具体节点 ID`);
    }
    const node = matched[0];
    node.params = node.params || {};
    node.params[paramKey] = val;
  }

  return graph;
}

function chooseTempCacheParent(preferredDir, appRoot) {
  const candidates = [];
  if (preferredDir) {
    const root = path.parse(path.resolve(preferredDir)).root;
    if (root && !/^c:/i.test(root) && fs.existsSync(root)) {
      candidates.push(path.join(path.resolve(preferredDir), '.vgt-cli-cache'));
    }
  }
  if (appRoot && !/^c:/i.test(path.resolve(appRoot)) && !String(appRoot).includes('app.asar')) {
    candidates.push(path.join(appRoot, '.workflow_cache', 'cli-runs'));
  }
  if (fs.existsSync('D:\\')) {
    candidates.push('D:\\temp\\vgt-cli-cache');
  }
  candidates.push(path.join(os.tmpdir(), 'vgt-cli-cache'));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {}
  }
  return os.tmpdir();
}

function createCliWorkflowRuntime({ ffmpeg, cacheRoot }) {
  const allocatedDirs = [];

  return {
    allocatedDirs,
    async probe(filePath) {
      try {
        return { ok: true, info: await ffmpeg.probe(filePath) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    async probeMulti(filePaths) {
      const list = Array.isArray(filePaths) ? filePaths : [];
      return mapConcurrent(list, 6, async (p) => {
        try {
          return { path: p, info: await ffmpeg.probe(p) };
        } catch {
          return { path: p, info: null };
        }
      });
    },
    listDir(dirPath, limit = 500) {
      try {
        return fs.readdirSync(dirPath)
          .filter((f) => !f.startsWith('.'))
          .slice(0, limit)
          .map((f) => path.join(dirPath, f));
      } catch {
        return [];
      }
    },
    scanDir(opts = {}) {
      const dirPath = String(opts.dirPath || '').trim();
      if (!dirPath || !fs.existsSync(dirPath)) {
        return { ok: false, error: '所选文件夹不存在', files: [] };
      }
      if (!fs.statSync(dirPath).isDirectory()) {
        return { ok: false, error: '目标路径不是文件夹', files: [] };
      }
      const recursive = !!opts.recursive;
      const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 500));
      const rawExts = Array.isArray(opts.extensions) ? opts.extensions.map((e) => String(e).toLowerCase()) : ['*'];
      const allowAll = !rawExts.length || rawExts.includes('*');
      const extSet = new Set(rawExts);
      if (extSet.has('jpg')) extSet.add('jpeg');
      if (extSet.has('md')) extSet.add('markdown');

      const files = [];
      let truncated = false;
      const walk = (curDir) => {
        if (files.length >= limit) { truncated = true; return; }
        let entries;
        try { entries = fs.readdirSync(curDir, { withFileTypes: true }); } catch { return; }
        entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
        for (const ent of entries) {
          if (files.length >= limit) { truncated = true; return; }
          if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
          const full = path.join(curDir, ent.name);
          if (ent.isDirectory()) {
            if (recursive) walk(full);
          } else if (ent.isFile()) {
            const ext = path.extname(ent.name).slice(1).toLowerCase();
            if (allowAll || (ext && extSet.has(ext))) {
              files.push(full);
            }
          }
        }
      };
      walk(dirPath);
      return { ok: true, dir: dirPath, files, truncated };
    },
    fingerprintReplacements: (source = {}) => ffmpeg.fingerprintReplacements({
      replaceDir: typeof source.replaceDir === 'string' ? source.replaceDir : '',
      replaceFiles: Array.isArray(source.replaceFiles) ? source.replaceFiles : [],
    }),
    statMulti(filePaths) {
      return (Array.isArray(filePaths) ? filePaths : []).map((p) => {
        try {
          const st = fs.statSync(p);
          return { path: p, exists: true, isDirectory: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs };
        } catch {
          return { path: p, exists: false, isDirectory: false, size: 0, mtimeMs: 0 };
        }
      });
    },
    allocNodeDir(opts = {}) {
      const dir = workflowCache.allocateNodeDir(cacheRoot, opts.subKey);
      allocatedDirs.push(dir);
      if (opts.manifestDir) {
        const srcManifest = path.join(opts.manifestDir, '.vgt-manifest.json');
        if (fs.existsSync(srcManifest)) {
          try { fs.copyFileSync(srcManifest, path.join(dir, '.vgt-manifest.json')); } catch {}
        }
      }
      return { ok: true, dir };
    },
    exportFiles(opts = {}) {
      const files = Array.isArray(opts.files) ? opts.files.filter((f) => f && fs.existsSync(f)) : [];
      if (!files.length) return { ok: false, error: '没有可导出的输出文件' };

      const baseRef = opts.originInputPath || files[0];
      let targetDir;
      if (opts.outMode === 'custom' && opts.customDir) {
        targetDir = opts.customDir;
      } else if (opts.outMode === 'subdir') {
        targetDir = path.join(path.dirname(baseRef), 'output');
      } else {
        targetDir = path.dirname(baseRef);
      }
      fs.mkdirSync(targetDir, { recursive: true });

      const noOverwrite = opts.noOverwrite !== false;
      const prefix = String(opts.prefix || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      const suffix = String(opts.suffix || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      let destDir = targetDir;

      if (opts.exportAsFolder && files.length > 1) {
        const defaultFolder = opts.folderName
          || `${path.basename(baseRef, path.extname(baseRef))}_工作流输出`;
        destDir = uniqueExportDir(targetDir, defaultFolder, noOverwrite);
        fs.mkdirSync(destDir, { recursive: true });
      }

      const savedPaths = [];
      let totalSize = 0;
      for (const src of files) {
        const ext = path.extname(src);
        const stem = path.basename(src, ext);
        const outName = `${prefix}${stem}${suffix}${ext}`;
        const dest = uniqueExportPath(path.join(destDir, outName), noOverwrite);
        if (path.resolve(src).toLowerCase() === path.resolve(dest).toLowerCase()) {
          savedPaths.push(dest);
          try { totalSize += fs.statSync(dest).size; } catch {}
          continue;
        }
        fs.copyFileSync(src, dest);
        savedPaths.push(dest);
        try { totalSize += fs.statSync(dest).size; } catch {}
      }

      if (opts.manifestDir) {
        const manifestSrc = path.join(opts.manifestDir, '.vgt-manifest.json');
        if (fs.existsSync(manifestSrc)) {
          try { fs.copyFileSync(manifestSrc, path.join(destDir, '.vgt-manifest.json')); } catch {}
        }
      }

      return { ok: true, savedPaths, targetDir: destDir, totalSize };
    },
    cancelTask(tid) {
      return ffmpeg.cancelTask(tid);
    },
    async startTask(feature, params, onTid, onProg) {
      const taskId = `cli_wf_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      onTid?.(taskId);
      try {
        const res = await ffmpeg.executeTask(taskId, feature, params, onProg);
        return { ok: true, taskId, ...res };
      } catch (err) {
        return { ok: false, taskId, cancelled: err.message === '任务已取消', error: err.message };
      }
    },
  };
}

async function runWorkflowCommand({
  appRoot,
  catalog,
  ffmpeg,
  target,
  inputs = [],
  outDir = '',
  noOverwrite = null,
  suffix = null,
  hwAccel = 'cpu',
  cacheDir = '',
  targetNodeId = null,
  paramOverrides = [],
  jsonMode = false,
  quiet = false,
  registerController = null,
}) {
  const wfEngine = require(path.join(appRoot, 'renderer', 'workflow', 'engine.js'));
  const resolved = resolveWorkflowGraph(catalog, target);
  const graph = applyWorkflowOverrides(resolved.graph, catalog, {
    inputs,
    outDir,
    noOverwrite,
    suffix,
    paramOverrides,
  });

  const isTempCache = !cacheDir;
  let tempRunContainer = '';
  let cacheRoot = '';
  if (cacheDir) {
    cacheRoot = workflowCache.openCache(path.resolve(cacheDir));
  } else {
    const parent = chooseTempCacheParent(outDir, appRoot);
    tempRunContainer = fs.mkdtempSync(path.join(parent, 'run-'));
    cacheRoot = workflowCache.openCache(tempRunContainer);
  }

  const runtime = createCliWorkflowRuntime({ ffmpeg, cacheRoot });
  const runner = wfEngine.createWorkflowRunner({ registry: catalog.registry });
  const log = (msg) => {
    if (!jsonMode && !quiet) process.stderr.write(`${msg}\n`);
  };

  log(`[workflow] 运行：${resolved.name} (${graph.nodes.length} 个节点)`);

  try {
    const { controller, promise } = runner.execute(graph, runtime, {
      targetNodeId: targetNodeId || null,
      forceRun: false,
      hwAccel,
      globalOutputMode: outDir ? 'custom' : 'same',
      globalOutputDir: outDir ? path.resolve(outDir) : '',
      onNodeState(nid, state) {
        const node = graph.nodes.find((n) => n.id === nid);
        const def = node && catalog.registry.getDef(node.type);
        const label = `${nid} · ${def?.name || node?.type || nid}`;
        if (state.status === 'running' && (state.progress === 0 || state.progress === undefined)) {
          log(`  -> 开始 ${label}`);
        } else if (state.status === 'done') {
          const count = state.savedPaths?.length || state.payload?.paths?.length || 0;
          log(`  [完成] ${label}${count ? ` (${count} 项)` : ''}`);
        } else if (state.status === 'cached') {
          log(`  [缓存] ${label}`);
        } else if (state.status === 'skipped') {
          log(`  [跳过] ${label}`);
        } else if (state.status === 'error') {
          log(`  [失败] ${label}: ${state.errorMsg || '未知错误'}`);
        }
      },
    });
    registerController?.(controller);

    const execResult = await promise;
    const exportedFiles = execResult.summary.exportedFiles.slice();

    // 若图中无 io.save 节点且用户指定了 -o，则将终端节点产物复制到 -o
    const hasSaveNode = graph.nodes.some((n) => n.type === 'io.save');
    if (!hasSaveNode && outDir) {
      const hasOutgoing = new Set((graph.edges || []).map((e) => e.fromNode));
      const sinkFiles = [];
      for (const nid of execResult.order) {
        if (hasOutgoing.has(nid)) continue;
        const payload = execResult.outputs.get(nid);
        if (payload?.paths?.length) sinkFiles.push(...payload.paths);
      }
      if (sinkFiles.length) {
        const exp = runtime.exportFiles({
          files: sinkFiles,
          originInputPath: sinkFiles[0],
          outMode: 'custom',
          customDir: path.resolve(outDir),
          suffix: suffix || '',
          noOverwrite: noOverwrite !== false,
          exportAsFolder: false,
        });
        if (exp.ok && exp.savedPaths?.length) {
          exportedFiles.push(...exp.savedPaths);
        }
      }
    }

    return {
      ok: true,
      workflow: {
        source: resolved.source,
        id: resolved.id,
        name: resolved.name,
      },
      summary: {
        ...execResult.summary,
        exportedFiles,
      },
      outputs: exportedFiles,
    };
  } finally {
    if (isTempCache && tempRunContainer) {
      try { fs.rmSync(tempRunContainer, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch {}
    }
  }
}

module.exports = {
  resolveWorkflowGraph,
  applyWorkflowOverrides,
  createCliWorkflowRuntime,
  runWorkflowCommand,
};
