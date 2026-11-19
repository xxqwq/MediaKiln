((root, factory) => {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VGT = root.VGT || {};
    root.VGT.wfEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const MEDIA_OUT_EXTS = new Set([
    'mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'ts', 'm4v',
    'gif', 'apng', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif', 'ico',
    'svg', 'mp3', 'm4a', 'wav', 'flac', 'aac', 'ogg', 'opus', 'srt',
    'docx', 'pptx', 'md', 'markdown', 'txt', 'html', 'htm', 'pdf',
  ]);

  function extOf(p) {
    const m = String(p || '').match(/\.([^.\\/]+)$/);
    return m ? m[1].toLowerCase() : '';
  }

  function stableStringify(val) {
    if (val === null || typeof val !== 'object') return JSON.stringify(val);
    if (Array.isArray(val)) return '[' + val.map(stableStringify).join(',') + ']';
    const keys = Object.keys(val).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(val[k])).join(',') + '}';
  }

  function hashString(str) {
    let h1 = 0x811c9dc5;
    let h2 = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 ^= ch;
      h1 = Math.imul(h1, 0x01000193);
      h2 ^= (ch + i);
      h2 = Math.imul(h2, 0x01000193);
    }
    return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'));
  }

  function naturalSort(paths) {
    return paths.slice().sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }));
  }

  // Kahn 拓扑排序（同层按节点 y 坐标从上到下排序，确保多线汇聚顺序与视觉上下一致）
  function topologicalSort(graph, targetNodeId = null) {
    const allNodes = graph.nodes || [];
    const allEdges = graph.edges || [];
    const nodeMap = new Map(allNodes.map((n) => [n.id, n]));

    let activeIds;
    if (targetNodeId) {
      if (!nodeMap.has(targetNodeId)) throw new Error('目标节点不存在');
      activeIds = new Set([targetNodeId]);
      const queue = [targetNodeId];
      while (queue.length) {
        const cur = queue.shift();
        for (const e of allEdges) {
          if (e.toNode === cur && nodeMap.has(e.fromNode) && !activeIds.has(e.fromNode)) {
            activeIds.add(e.fromNode);
            queue.push(e.fromNode);
          }
        }
      }
    } else {
      activeIds = new Set(allNodes.map((n) => n.id));
    }

    const inDeg = new Map();
    const outAdj = new Map();
    for (const id of activeIds) {
      inDeg.set(id, 0);
      outAdj.set(id, []);
    }

    for (const e of allEdges) {
      if (activeIds.has(e.fromNode) && activeIds.has(e.toNode)) {
        outAdj.get(e.fromNode).push(e.toNode);
        inDeg.set(e.toNode, inDeg.get(e.toNode) + 1);
      }
    }

    const ready = [];
    for (const [id, deg] of inDeg.entries()) {
      if (deg === 0) ready.push(id);
    }
    const sortReady = () => ready.sort((a, b) => {
      const na = nodeMap.get(a);
      const nb = nodeMap.get(b);
      return (na.y - nb.y) || (na.x - nb.x);
    });
    sortReady();

    const order = [];
    while (ready.length) {
      const cur = ready.shift();
      order.push(cur);
      for (const nxt of outAdj.get(cur) || []) {
        const nd = inDeg.get(nxt) - 1;
        inDeg.set(nxt, nd);
        if (nd === 0) {
          ready.push(nxt);
          sortReady();
        }
      }
    }

    if (order.length !== activeIds.size) {
      throw new Error('工作流中存在循环连线，请检查并断开环路后重试');
    }
    return order;
  }

  function applyListPick(payload, params) {
    const mode = params?.pickMode || 'first';
    const paths = payload?.paths || [];
    const infos = payload?.infos || [];
    if (!paths.length) throw new Error('上游输入列表为空，无法筛选');

    if (mode === 'first') {
      return {
        ...payload,
        kind: 'single',
        paths: [paths[0]],
        infos: [infos[0] || {}],
      };
    }
    if (mode === 'last') {
      const idx = paths.length - 1;
      return {
        ...payload,
        kind: 'single',
        paths: [paths[idx]],
        infos: [infos[idx] || {}],
      };
    }
    if (mode === 'index') {
      const n = Math.max(1, Math.round(parseFloat(params.index) || 1));
      const idx = Math.min(n - 1, paths.length - 1);
      return {
        ...payload,
        kind: 'single',
        paths: [paths[idx]],
        infos: [infos[idx] || {}],
      };
    }

    const predMap = {
      rasterOnly: (p) => ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif', 'ico'].includes(extOf(p)),
      svgOnly: (p) => extOf(p) === 'svg',
      videoOnly: (p) => ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'ts', 'm4v'].includes(extOf(p)),
      pdfOnly: (p) => extOf(p) === 'pdf',
    };
    const pred = predMap[mode] || (() => true);
    const nextPaths = [];
    const nextInfos = [];
    paths.forEach((p, i) => {
      if (pred(p)) {
        nextPaths.push(p);
        nextInfos.push(infos[i] || {});
      }
    });
    if (!nextPaths.length) throw new Error('按当前筛选条件没有匹配的文件');
    return {
      ...payload,
      kind: 'list',
      paths: nextPaths,
      infos: nextInfos,
    };
  }

  const FOLDER_FILTER_EXTS = {
    all: [
      'mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'ts', 'm4v',
      'gif', 'apng', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif', 'ico',
      'svg', 'mp3', 'm4a', 'wav', 'flac', 'aac', 'ogg', 'opus',
      'srt', 'ass', 'ssa', 'vtt', 'docx', 'pptx', 'md', 'markdown', 'txt', 'html', 'htm', 'pdf',
    ],
    videoAnim: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'ts', 'm4v', 'gif', 'apng'],
    image: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif', 'ico'],
    gif: ['gif'],
    svg: ['svg'],
    audio: ['mp3', 'm4a', 'wav', 'flac', 'aac', 'ogg', 'opus'],
    doc: ['docx', 'pptx', 'md', 'markdown', 'txt', 'html', 'htm'],
    pdf: ['pdf'],
  };

  function applyRouteType(payload, params) {
    const gifToImg = params?.gifBucket === 'images';
    const rasterExts = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif', 'ico']);
    const animExts = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'ts', 'm4v', 'apng']);
    if (gifToImg) rasterExts.add('gif');
    else animExts.add('gif');

    const buckets = {
      images: { paths: [], infos: [] },
      svgs: { paths: [], infos: [] },
      anims: { paths: [], infos: [] },
      others: { paths: [], infos: [] },
    };

    (payload.paths || []).forEach((p, idx) => {
      const ext = extOf(p);
      const info = payload.infos?.[idx] || {};
      let key = 'others';
      if (rasterExts.has(ext)) key = 'images';
      else if (ext === 'svg') key = 'svgs';
      else if (animExts.has(ext)) key = 'anims';
      buckets[key].paths.push(p);
      buckets[key].infos.push(info);
    });

    const mkPort = (b) => ({
      kind: b.paths.length > 1 ? 'list' : (b.paths.length === 1 ? 'single' : 'list'),
      paths: b.paths,
      infos: b.infos,
      originPath: b.paths[0] || payload.originPath || '',
      manifestDir: payload.manifestDir || '',
      sourceDocx: payload.sourceDocx || '',
    });

    const portPayloads = {
      images: mkPort(buckets.images),
      svgs: mkPort(buckets.svgs),
      anims: mkPort(buckets.anims),
      others: mkPort(buckets.others),
    };

    return {
      kind: 'list',
      paths: payload.paths || [],
      infos: payload.infos || [],
      originPath: payload.originPath || payload.paths?.[0] || '',
      manifestDir: payload.manifestDir || '',
      sourceDocx: payload.sourceDocx || '',
      portPayloads,
      branchCounts: {
        images: buckets.images.paths.length,
        svgs: buckets.svgs.paths.length,
        anims: buckets.anims.paths.length,
        others: buckets.others.paths.length,
      },
    };
  }

  function applyRouteCondition(payload, params, fileStatMap) {
    const rule = params?.rule || 'sizeGtKB';
    const threshold = Number(params?.threshold) || 0;
    const keywords = String(params?.keyword || '')
      .split(/[,，]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const matched = { paths: [], infos: [] };
    const unmatched = { paths: [], infos: [] };

    (payload.paths || []).forEach((p, idx) => {
      const info = payload.infos?.[idx] || {};
      const st = fileStatMap?.get(p);
      const sizeBytes = Number(info.size) || Number(st?.size) || 0;
      const w = Number(info.width) || 0;
      const h = Number(info.height) || 0;
      const baseName = String(p).split(/[\\/]/).pop()?.toLowerCase() || '';

      let ok = false;
      if (rule === 'sizeGtKB') ok = sizeBytes > threshold * 1024;
      else if (rule === 'sizeLtKB') ok = sizeBytes < threshold * 1024;
      else if (rule === 'widthGt') ok = w > threshold;
      else if (rule === 'landscape') ok = w > 0 && h > 0 && w > h;
      else if (rule === 'portrait') ok = w > 0 && h > 0 && h > w;
      else if (rule === 'nameMatch') ok = keywords.length ? keywords.some((kw) => baseName.includes(kw)) : false;
      else if (rule === 'hasAudio') ok = !!info.hasAudio;

      const dest = ok ? matched : unmatched;
      dest.paths.push(p);
      dest.infos.push(info);
    });

    const mkPort = (b) => ({
      kind: b.paths.length > 1 ? 'list' : (b.paths.length === 1 ? 'single' : 'list'),
      paths: b.paths,
      infos: b.infos,
      originPath: b.paths[0] || payload.originPath || '',
      manifestDir: payload.manifestDir || '',
      sourceDocx: payload.sourceDocx || '',
    });

    return {
      kind: 'list',
      paths: payload.paths || [],
      infos: payload.infos || [],
      originPath: payload.originPath || payload.paths?.[0] || '',
      manifestDir: payload.manifestDir || '',
      sourceDocx: payload.sourceDocx || '',
      portPayloads: {
        matched: mkPort(matched),
        unmatched: mkPort(unmatched),
      },
      branchCounts: {
        matched: matched.paths.length,
        unmatched: unmatched.paths.length,
      },
    };
  }

  function createWorkflowRunner({ registry, cacheStore }) {
    const store = cacheStore || new Map(); // nodeId -> { sig, payload, savedPaths? }

    function execute(graph, runtime, options = {}) {
      const {
        targetNodeId = null,
        forceRun = false,
        hwAccel = 'cpu',
        globalOutputMode = 'same',
        globalOutputDir = '',
        onNodeState = () => {},
        onOverallProgress = () => {},
        onTaskStart = () => {},
      } = options;

      let aborted = false;
      const activeTaskIds = new Set();

      const controller = {
        cancel() {
          aborted = true;
          for (const tid of Array.from(activeTaskIds)) {
            try { runtime.cancelTask?.(tid); } catch {}
          }
        },
        isCancelled() {
          return aborted;
        },
      };

      const runPromise = (async () => {
        const order = topologicalSort(graph, targetNodeId);
        const nodeMap = new Map((graph.nodes || []).map((n) => [n.id, n]));
        const edges = graph.edges || [];

        if (!order.length) throw new Error('画布中还没有任何节点');

        // 收集本地引用文件与文件夹扫描结果，一次 stat 校验源文件修改时间与大小
        const localFilesToStat = [];
        const folderScanMap = new Map();
        for (const nid of order) {
          const n = nodeMap.get(nid);
          if (n.type === 'io.loadFile' && n.params?.filePath) localFilesToStat.push(n.params.filePath);
          if (n.type === 'io.loadBatch' && Array.isArray(n.params?.filePaths)) localFilesToStat.push(...n.params.filePaths);
          if (n.type === 'io.loadFolder' && n.params?.dirPath) {
            const exts = FOLDER_FILTER_EXTS[n.params.filterKind || 'all'] || FOLDER_FILTER_EXTS.all;
            const scanRes = await runtime.scanDir?.({
              dirPath: n.params.dirPath,
              recursive: n.params.recursive === 'yes',
              extensions: exts,
              limit: 500,
            });
            folderScanMap.set(nid, scanRes || { ok: false, error: '当前环境不支持文件夹扫描', files: [] });
            if (scanRes?.ok && Array.isArray(scanRes.files)) {
              localFilesToStat.push(...scanRes.files);
            }
          }
          for (const [k, val] of Object.entries(n.params || {})) {
            if (k.startsWith('__local_') && typeof val === 'string' && val) localFilesToStat.push(val);
          }
        }
        const statList = localFilesToStat.length
          ? await runtime.statMulti(Array.from(new Set(localFilesToStat)))
          : [];
        const fileStatMap = new Map(statList.map((s) => [s.path, s]));

        const outputs = new Map(); // nodeId -> payload
        const signatures = new Map(); // nodeId -> sig string
        const summary = { executed: 0, cached: 0, bypassed: 0, skipped: 0, exportedFiles: [] };

        const resolveEdgePayload = (edge) => {
          const up = outputs.get(edge.fromNode);
          if (!up) return null;
          if (up.portPayloads && edge.fromPort && Object.prototype.hasOwnProperty.call(up.portPayloads, edge.fromPort)) {
            return up.portPayloads[edge.fromPort];
          }
          return up;
        };

        const collectEdgesPayload = (edgeList) => {
          const paths = [];
          const infos = [];
          let originPath = '';
          let manifestDir = '';
          let sourceDocx = '';
          let kind = 'list';
          let meta = null;
          for (const e of edgeList) {
            const up = resolveEdgePayload(e);
            if (!up?.paths?.length) continue;
            if (!originPath && up.originPath) originPath = up.originPath;
            if (!manifestDir && up.manifestDir) manifestDir = up.manifestDir;
            if (!sourceDocx && up.sourceDocx) sourceDocx = up.sourceDocx;
            if (!meta && up.meta) meta = up.meta;
            if (edgeList.length === 1 && up.kind === 'single') kind = 'single';
            up.paths.forEach((p, idx) => {
              paths.push(p);
              infos.push(up.infos?.[idx] || {});
            });
          }
          if (!originPath && paths.length) originPath = paths[0];
          return { kind: paths.length > 1 ? 'list' : kind, paths, infos, originPath, manifestDir, sourceDocx, meta };
        };

        let completedCount = 0;
        const nodeProgress = new Map(); // nid -> 0..1

        const computeOverallRatio = () => {
          let inFlight = 0;
          for (const r of nodeProgress.values()) inFlight += r;
          return Math.min(1, (completedCount + inFlight) / order.length);
        };

        const markNodeSkipped = (nid, node, sig, def) => {
          const emptyPayload = {
            kind: 'list',
            paths: [],
            infos: [],
            skipped: true,
            ...(def.outputs?.length > 1 ? { portPayloads: Object.fromEntries(def.outputs.map((o) => [o.id, { kind: 'list', paths: [], infos: [] }])) } : {}),
          };
          summary.skipped++;
          outputs.set(nid, emptyPayload);
          store.set(nid, { sig, payload: emptyPayload });
          nodeProgress.delete(nid);
          completedCount++;
          onNodeState(nid, { status: 'skipped', progress: 1, payload: emptyPayload });
          onOverallProgress(computeOverallRatio(), `⏭ 空分支跳过 (${completedCount}/${order.length}) · ${def.name}`);
        };

        for (const nid of order) {
          onNodeState(nid, { status: 'pending', progress: 0 });
        }

        const MAX_CONCURRENT_NODES = 3;
        const HEAVY_GROUPS = new Set(['转换', 'GIF 编辑', '剪辑', '音频']);

        const activeIds = new Set(order);
        const inDeg = new Map();
        const outAdj = new Map();
        for (const id of activeIds) {
          inDeg.set(id, 0);
          outAdj.set(id, []);
        }
        for (const e of edges) {
          if (activeIds.has(e.fromNode) && activeIds.has(e.toNode)) {
            outAdj.get(e.fromNode).push(e.toNode);
            inDeg.set(e.toNode, inDeg.get(e.toNode) + 1);
          }
        }

        const ready = [];
        for (const [id, deg] of inDeg.entries()) {
          if (deg === 0) ready.push(id);
        }
        const sortReady = () => ready.sort((a, b) => {
          const na = nodeMap.get(a);
          const nb = nodeMap.get(b);
          return ((na?.y || 0) - (nb?.y || 0)) || ((na?.x || 0) - (nb?.x || 0));
        });
        sortReady();

        const isHeavyNode = (nid) => {
          const n = nodeMap.get(nid);
          const d = n ? registry.getDef(n.type) : null;
          return !!(d && !n.bypass && HEAVY_GROUPS.has(d.group));
        };

        const runNode = async (nid) => {
          if (aborted) throw new Error('工作流已取消');
          const node = nodeMap.get(nid);
          const def = registry.getDef(node.type);
          if (!def) throw new Error(`未知节点类型：${node.type}`);

          // 收集该节点的上游输入连线（按源节点 y 坐标排序以保障多连汇聚顺序稳定）
          const inEdgesByPort = new Map();
          for (const inPort of def.inputs || []) {
            const matched = edges
              .filter((e) => e.toNode === nid && e.toPort === inPort.id)
              .sort((a, b) => {
                const na = nodeMap.get(a.fromNode);
                const nb = nodeMap.get(b.fromNode);
                return ((na?.y || 0) - (nb?.y || 0)) || ((na?.x || 0) - (nb?.x || 0));
              });
            inEdgesByPort.set(inPort.id, matched);
          }

          // 计算确定性签名
          const upstreamSigs = {};
          for (const [portId, elist] of inEdgesByPort.entries()) {
            upstreamSigs[portId] = elist.map((e) => {
              const pRes = resolveEdgePayload(e);
              return `${e.fromNode}:${e.fromPort}:${signatures.get(e.fromNode) || ''}:${pRes?.paths?.length || 0}`;
            });
          }
          const localStatsSig = {};
          if (node.type === 'io.loadFile' && node.params?.filePath) {
            const st = fileStatMap.get(node.params.filePath);
            localStatsSig.file = st ? `${st.size}:${st.mtimeMs}` : 'missing';
          } else if (node.type === 'io.loadBatch' && Array.isArray(node.params?.filePaths)) {
            localStatsSig.files = node.params.filePaths.map((p) => {
              const st = fileStatMap.get(p);
              return st ? `${p}:${st.size}:${st.mtimeMs}` : `${p}:missing`;
            });
          } else if (node.type === 'io.loadFolder' && node.params?.dirPath) {
            const scanRes = folderScanMap.get(nid);
            localStatsSig.folderFiles = scanRes?.ok
              ? scanRes.files.map((p) => {
                  const st = fileStatMap.get(p);
                  return st ? `${p}:${st.size}:${st.mtimeMs}` : `${p}:missing`;
                })
              : 'scan-error';
          } else {
            for (const [k, val] of Object.entries(node.params || {})) {
              if (k.startsWith('__local_') && typeof val === 'string' && val) {
                const st = fileStatMap.get(val);
                localStatsSig[k] = st ? `${st.size}:${st.mtimeMs}` : 'missing';
              }
            }
          }

          if (node.type === 'feat.docRepackImages' && !node.bypass) {
            const linked = collectEdgesPayload(inEdgesByPort.get('replaceSource') || []);
            const source = registry.resolveReplacementSource(node.params?.__local_replaceSource, linked);
            if (source.replaceDir || source.replaceFiles.length) {
              localStatsSig.replacements = await runtime.fingerprintReplacements(source);
            }
          }

          const sig = hashString(stableStringify({
            type: node.type,
            bypass: !!node.bypass,
            params: node.params || {},
            hwAccel,
            globalOut: node.type === 'io.save' && node.params?.outMode === 'global' ? `${globalOutputMode}:${globalOutputDir}` : '',
            upstreamSigs,
            localStatsSig,
          }));
          signatures.set(nid, sig);

          // 校验缓存命中（io.save 需确认目标导出文件仍存在；skipped 与多端口路由也支持缓存命中）
          const cached = store.get(nid);
          if (!forceRun && cached && cached.sig === sig && cached.payload) {
            if (cached.payload.skipped) {
              outputs.set(nid, cached.payload);
              summary.skipped++;
              completedCount++;
              onNodeState(nid, { status: 'skipped', progress: 1, payload: cached.payload });
              onOverallProgress(computeOverallRatio(), `⏭ 空分支跳过 (${completedCount}/${order.length}) · ${def.name}`);
              return;
            }
            const checkPaths = node.type === 'io.save' && cached.savedPaths?.length
              ? cached.savedPaths
              : (cached.payload.paths || []);
            if (checkPaths.length) {
              const diskStats = await runtime.statMulti(checkPaths);
              const allAlive = diskStats.length === checkPaths.length && diskStats.every((s) => s.exists && !s.isDirectory && s.size > 0);
              if (allAlive) {
                outputs.set(nid, cached.payload);
                summary.cached++;
                if (node.type === 'io.save' && cached.savedPaths) {
                  summary.exportedFiles.push(...cached.savedPaths);
                }
                completedCount++;
                onNodeState(nid, {
                  status: 'cached',
                  progress: 1,
                  payload: cached.payload,
                  savedPaths: cached.savedPaths,
                  targetDir: cached.targetDir,
                });
                onOverallProgress(computeOverallRatio(), `⚡ 命中缓存 (${completedCount}/${order.length}) · ${def.name}`);
                return;
              }
            }
          }

          nodeProgress.set(nid, 0);
          onNodeState(nid, { status: 'running', progress: 0 });
          onOverallProgress(computeOverallRatio(), `正在执行 (${completedCount + 1}/${order.length}) · ${def.name}`);

          const reportNodeProgress = (r) => {
            const clamped = Math.max(0, Math.min(1, r || 0));
            nodeProgress.set(nid, clamped);
            onNodeState(nid, { status: 'running', progress: clamped });
            onOverallProgress(
              computeOverallRatio(),
              `正在执行 (${completedCount + 1}/${order.length}) ${Math.round(clamped * 100)}% · ${def.name}`,
            );
          };

          let resultPayload = null;
          let savedPaths = null;
          let targetDir = null;

          // ---------- 1. I/O 与路由节点 ----------
          if (node.type === 'io.loadFile') {
            const p = node.params?.filePath;
            if (!p) throw new Error('请先选择输入文件');
            const st = fileStatMap.get(p);
            if (!st?.exists) throw new Error(`输入文件不存在：${p}`);
            const res = await runtime.probe(p);
            if (!res.ok) throw new Error(res.error || '无法读取输入文件信息');
            resultPayload = {
              kind: 'single',
              paths: [p],
              infos: [res.info],
              originPath: p,
            };
          } else if (node.type === 'io.loadBatch') {
            const list = Array.isArray(node.params?.filePaths) ? node.params.filePaths : [];
            if (!list.length) throw new Error('请先选择至少 1 个输入文件');
            const probed = await runtime.probeMulti(list);
            const valid = probed.filter((i) => i.info);
            if (!valid.length) throw new Error('批量加载的文件均无法读取，请检查格式');
            resultPayload = {
              kind: 'list',
              paths: valid.map((v) => v.path),
              infos: valid.map((v) => v.info),
              originPath: valid[0].path,
            };
          } else if (node.type === 'io.loadFolder') {
            const dir = node.params?.dirPath;
            if (!dir) throw new Error('请先选择要扫描的文件夹');
            const scanRes = folderScanMap.get(nid);
            if (!scanRes?.ok) throw new Error(scanRes?.error || '无法扫描所选文件夹');
            if (!scanRes.files.length) throw new Error('所选文件夹内没有符合条件的媒体或文档');
            const probed = await runtime.probeMulti(scanRes.files);
            const valid = probed.filter((i) => i.info);
            if (!valid.length) throw new Error('文件夹内扫描到的文件均无法读取，请检查格式');
            resultPayload = {
              kind: 'list',
              paths: valid.map((v) => v.path),
              infos: valid.map((v) => v.info),
              originPath: valid[0].path,
            };
          } else if (node.type === 'io.listPick') {
            const upEdges = inEdgesByPort.get('items') || [];
            if (!upEdges.length) throw new Error('请先连接上游输入');
            const upPayload = collectEdgesPayload(upEdges);
            if (!upPayload.paths.length) {
              markNodeSkipped(nid, node, sig, def);
              return;
            }
            resultPayload = node.bypass ? upPayload : applyListPick(upPayload, node.params);
          } else if (node.type === 'io.routeType') {
            const upEdges = inEdgesByPort.get('items') || [];
            if (!upEdges.length) throw new Error('请先连接上游输入');
            const upPayload = collectEdgesPayload(upEdges);
            if (!upPayload.paths.length) {
              markNodeSkipped(nid, node, sig, def);
              return;
            }
            resultPayload = applyRouteType(upPayload, node.params);
          } else if (node.type === 'io.routeCondition') {
            const upEdges = inEdgesByPort.get('items') || [];
            if (!upEdges.length) throw new Error('请先连接上游输入');
            const upPayload = collectEdgesPayload(upEdges);
            if (!upPayload.paths.length) {
              markNodeSkipped(nid, node, sig, def);
              return;
            }
            resultPayload = node.bypass
              ? {
                  ...upPayload,
                  portPayloads: {
                    matched: { ...upPayload },
                    unmatched: { kind: 'list', paths: [], infos: [] },
                  },
                  branchCounts: { matched: upPayload.paths.length, unmatched: 0 },
                }
              : applyRouteCondition(upPayload, node.params, fileStatMap);
          } else if (node.type === 'io.preview') {
            const upEdges = inEdgesByPort.get('media') || [];
            if (!upEdges.length) throw new Error('请先连接要预览的节点');
            const upPayload = collectEdgesPayload(upEdges);
            if (!upPayload.paths.length) {
              markNodeSkipped(nid, node, sig, def);
              return;
            }
            resultPayload = upPayload;
          } else if (node.type === 'io.compare') {
            const eBefore = inEdgesByPort.get('before')?.[0];
            const eAfter = inEdgesByPort.get('after')?.[0];
            if (!eBefore || !eAfter) throw new Error('请同时连接「处理前」与「处理后」两个端口');
            const pBefore = resolveEdgePayload(eBefore);
            const pAfter = resolveEdgePayload(eAfter);
            if (!pBefore?.paths?.length || !pAfter?.paths?.length) {
              markNodeSkipped(nid, node, sig, def);
              return;
            }
            resultPayload = {
              kind: 'compare',
              paths: pAfter.paths,
              infos: pAfter.infos,
              beforePath: pBefore.paths[0],
              beforeInfo: pBefore.infos[0] || {},
              afterPath: pAfter.paths[0],
              afterInfo: pAfter.infos[0] || {},
              originPath: pAfter.originPath || pBefore.originPath,
            };
          } else if (node.type === 'io.save') {
            const upEdges = inEdgesByPort.get('media') || [];
            if (!upEdges.length) throw new Error('请先连接待导出的上游节点');
            const upPayload = collectEdgesPayload(upEdges);
            if (!upPayload.paths.length) {
              markNodeSkipped(nid, node, sig, def);
              return;
            }
            const p = node.params || {};
            const outMode = p.outMode === 'global' ? globalOutputMode : (p.outMode || 'same');
            const customDir = p.outMode === 'global' ? globalOutputDir : (p.customDir || '');
            const exp = await runtime.exportFiles({
              files: upPayload.paths,
              originInputPath: upPayload.originPath || upPayload.paths[0],
              outMode,
              customDir,
              suffix: p.suffix || '',
              noOverwrite: p.noOverwrite !== 'no',
              exportAsFolder: p.exportAsFolder !== 'flat' && upPayload.paths.length > 1,
              manifestDir: upPayload.manifestDir || '',
            });
            if (!exp.ok) throw new Error(exp.error || '文件导出失败');
            savedPaths = exp.savedPaths;
            targetDir = exp.targetDir;
            summary.exportedFiles.push(...savedPaths);
            resultPayload = {
              ...upPayload,
              paths: savedPaths,
              originPath: upPayload.originPath,
            };
          } else {
            // ---------- 2. 功能节点 ----------
            const primaryPort = def.inputs[0];
            const primaryEdges = inEdgesByPort.get(primaryPort.id) || [];
            if (!primaryEdges.length) {
              throw new Error(`节点「${def.name}」缺少主输入连线`);
            }

            const combinedPrimary = collectEdgesPayload(primaryEdges);
            if (!combinedPrimary.paths.length) {
              markNodeSkipped(nid, node, sig, def);
              return;
            }

            // 旁路模式：直接将主输入原样透传
            if (node.bypass) {
              resultPayload = combinedPrimary;
              summary.bypassed++;
              outputs.set(nid, resultPayload);
              store.set(nid, { sig, payload: resultPayload });
              nodeProgress.delete(nid);
              completedCount++;
              onNodeState(nid, { status: 'bypassed', progress: 1, payload: resultPayload });
              onOverallProgress(computeOverallRatio(), `⏭ 已旁路 (${completedCount}/${order.length}) · ${def.name}`);
              return;
            }

            // 收集副端口输入
            const secondaryPayloads = {};
            for (let i = 1; i < def.inputs.length; i++) {
              const sp = def.inputs[i];
              const sedges = inEdgesByPort.get(sp.id) || [];
              if (sedges.length) {
                const combinedSec = collectEdgesPayload(sedges);
                if (combinedSec.paths.length) {
                  secondaryPayloads[sp.id] = {
                    paths: combinedSec.paths,
                    infos: combinedSec.infos,
                    manifestDir: combinedSec.manifestDir,
                    sourceDir: combinedSec.sourceDir || '',
                  };
                }
              }
            }

            // 展平主输入（单文件 / 列表 / 多连汇聚）
            const primaryItems = combinedPrimary.paths.map((p, idx) => ({
              path: p,
              info: combinedPrimary.infos?.[idx] || {},
            }));
            const originPath = combinedPrimary.originPath || primaryItems[0].path;
            const manifestDir = combinedPrimary.manifestDir || '';
            const sourceDocx = combinedPrimary.sourceDocx || '';

            // 为本节点分配非 C 盘工作流缓存目录
            const alloc = await runtime.allocNodeDir({
              subKey: `${nid}_${sig.slice(0, 8)}`,
              manifestDir,
            });
            const nodeCacheDir = alloc.dir;

            const runSingleTask = async (taskParams, progCb) => {
              let myTid = null;
              try {
                const res = await runtime.startTask(
                  def.featureId,
                  {
                    ...taskParams,
                    __outputMode: 'custom',
                    __outputDir: nodeCacheDir,
                    __hwAccel: hwAccel,
                    __noOverwrite: true,
                    __batchItem: true,
                  },
                  (tid) => {
                    if (tid) {
                      myTid = tid;
                      activeTaskIds.add(tid);
                      if (aborted) {
                        try { runtime.cancelTask?.(tid); } catch {}
                      }
                    }
                    onTaskStart?.(tid);
                  },
                  progCb,
                );
                if (res.cancelled || aborted) throw new Error('工作流已取消');
                if (!res.ok) throw new Error(res.error || `${def.name} 处理失败`);
                return res;
              } finally {
                if (myTid) activeTaskIds.delete(myTid);
              }
            };

            if (def.multi) {
              // 多文件合并/拼图/合成视频
              const taskParams = registry.buildNodeTaskParams(node, primaryItems[0], secondaryPayloads, primaryItems);
              const res = await runSingleTask(taskParams, reportNodeProgress);
              const probeRes = await runtime.probe(res.output);
              resultPayload = {
                kind: 'single',
                paths: [res.output],
                infos: [probeRes.ok ? probeRes.info : {}],
                originPath,
                meta: res,
              };
            } else if (primaryItems.length > 1) {
              // 列表输入 → 自动对列表内兼容文件批处理（List Map），图片/SVG 节点支持最多 3 路并发并严格保序
              const acceptSet = new Set(def.accept.map((e) => (e === 'jpeg' ? 'jpg' : e)));
              const slots = new Array(primaryItems.length);
              const itemProgress = new Float64Array(primaryItems.length);
              const listConcurrency = (def.group === '图片' || def.group === 'SVG') ? 3 : 1;
              let nextIdx = 0;
              let processedCount = 0;

              const updateListProg = () => {
                let sum = 0;
                for (let i = 0; i < itemProgress.length; i++) sum += itemProgress[i];
                reportNodeProgress(sum / primaryItems.length);
              };

              const listWorker = async () => {
                while (true) {
                  if (aborted) throw new Error('工作流已取消');
                  const idx = nextIdx++;
                  if (idx >= primaryItems.length) break;
                  const item = primaryItems[idx];
                  const itemExt = extOf(item.path);
                  const normExt = itemExt === 'jpeg' ? 'jpg' : itemExt;
                  if (!acceptSet.has(normExt)) {
                    // 非兼容后缀跳过处理并透传原文件，避免中断链路
                    slots[idx] = { paths: [item.path], infos: [item.info] };
                    itemProgress[idx] = 1;
                    updateListProg();
                    continue;
                  }

                  const itemParams = registry.buildNodeTaskParams(node, item, secondaryPayloads, []);
                  const res = await runSingleTask(itemParams, (r) => {
                    itemProgress[idx] = Math.max(0, Math.min(1, r || 0));
                    updateListProg();
                  });
                  processedCount++;
                  if (res.outputType === 'dir') {
                    const dirFiles = res.extractSummary?.files?.length
                      ? res.extractSummary.files
                      : naturalSort(await runtime.listDir(res.output, 500)).filter((f) => MEDIA_OUT_EXTS.has(extOf(f)));
                    const probed = dirFiles.length ? await runtime.probeMulti(dirFiles) : [];
                    slots[idx] = {
                      paths: probed.map((pr) => pr.path),
                      infos: probed.map((pr) => pr.info || {}),
                    };
                  } else {
                    const pr = await runtime.probe(res.output);
                    slots[idx] = {
                      paths: [res.output],
                      infos: [pr.ok ? pr.info : {}],
                    };
                  }
                  itemProgress[idx] = 1;
                  updateListProg();
                }
              };

              await Promise.all(
                Array.from({ length: Math.min(listConcurrency, primaryItems.length) }, () => listWorker()),
              );

              if (!processedCount) {
                throw new Error(`列表中的文件格式均与「${def.name}」不兼容`);
              }
              const outPaths = [];
              const outInfos = [];
              for (const s of slots) {
                if (!s) continue;
                outPaths.push(...s.paths);
                outInfos.push(...s.infos);
              }
              resultPayload = {
                kind: 'list',
                paths: outPaths,
                infos: outInfos,
                originPath,
                manifestDir: manifestDir ? nodeCacheDir : '',
                sourceDocx,
              };
            } else {
              // 单文件处理
              const item = primaryItems[0];
              const itemExt = extOf(item.path);
              const normExt = itemExt === 'jpeg' ? 'jpg' : itemExt;
              const acceptSet = new Set(def.accept.map((e) => (e === 'jpeg' ? 'jpg' : e)));
              if (!acceptSet.has(normExt)) {
                throw new Error(`输入文件 (.${itemExt}) 与节点「${def.name}」不兼容`);
              }
              const taskParams = registry.buildNodeTaskParams(node, item, secondaryPayloads, []);
              const res = await runSingleTask(taskParams, reportNodeProgress);

              if (res.outputType === 'dir') {
                const rawFiles = res.extractSummary?.files?.length
                  ? res.extractSummary.files
                  : naturalSort(await runtime.listDir(res.output, 500)).filter((f) => MEDIA_OUT_EXTS.has(extOf(f)));
                if (!rawFiles.length) throw new Error(`节点「${def.name}」未生成输出文件`);
                const probed = await runtime.probeMulti(rawFiles);
                resultPayload = {
                  kind: 'list',
                  paths: probed.map((x) => x.path),
                  infos: probed.map((x) => x.info || {}),
                  originPath,
                  sourceDir: res.output,
                  manifestDir: def.featureId === 'docExtractImages' ? res.output : '',
                  sourceDocx: res.extractSummary?.sourceDocx || sourceDocx,
                  meta: res,
                };
              } else {
                const pr = await runtime.probe(res.output);
                resultPayload = {
                  kind: 'single',
                  paths: [res.output],
                  infos: [pr.ok ? pr.info : {}],
                  originPath,
                  meta: res,
                };
              }
            }
          }

          summary.executed++;
          outputs.set(nid, resultPayload);
          store.set(nid, { sig, payload: resultPayload, savedPaths, targetDir });
          nodeProgress.delete(nid);
          completedCount++;
          onNodeState(nid, {
            status: 'done',
            progress: 1,
            payload: resultPayload,
            savedPaths,
            targetDir,
          });
          onOverallProgress(computeOverallRatio(), `✅ 完成 (${completedCount}/${order.length}) · ${def.name}`);
        };

        await new Promise((resolve, reject) => {
          let activeCount = 0;
          let heavyActive = false;
          let firstError = null;
          let settled = false;

          const finishIfDone = () => {
            if (settled) return;
            if (activeCount === 0 && (aborted || firstError || ready.length === 0)) {
              settled = true;
              if (firstError) reject(firstError);
              else if (aborted) reject(new Error('工作流已取消'));
              else resolve();
            }
          };

          const pump = () => {
            if (settled) return;
            if (aborted || firstError) {
              finishIfDone();
              return;
            }

            while (activeCount < MAX_CONCURRENT_NODES && ready.length > 0) {
              const idx = ready.findIndex((nid) => !heavyActive || !isHeavyNode(nid));
              if (idx === -1) break;
              const [nid] = ready.splice(idx, 1);
              const usesHeavy = isHeavyNode(nid);
              if (usesHeavy) heavyActive = true;
              activeCount++;

              runNode(nid)
                .then(() => {
                  if (!aborted && !firstError) {
                    for (const nxt of outAdj.get(nid) || []) {
                      const nd = inDeg.get(nxt) - 1;
                      inDeg.set(nxt, nd);
                      if (nd === 0) ready.push(nxt);
                    }
                    sortReady();
                  }
                })
                .catch((err) => {
                  const wasAborted = aborted;
                  const isCancel = wasAborted || err.message === '工作流已取消' || err.message === '任务已取消';
                  nodeProgress.delete(nid);
                  onNodeState(nid, {
                    status: isCancel ? 'cancelled' : 'error',
                    progress: 0,
                    errorMsg: err.message,
                  });
                  if (!firstError) firstError = err;
                  if (!aborted) {
                    aborted = true;
                    for (const tid of Array.from(activeTaskIds)) {
                      try { runtime.cancelTask?.(tid); } catch {}
                    }
                  }
                })
                .finally(() => {
                  activeCount--;
                  if (usesHeavy) heavyActive = false;
                  pump();
                  finishIfDone();
                });
            }

            finishIfDone();
          };

          pump();
        });

        return { outputs, summary, order };
      })();

      return { controller, promise: runPromise };
    }

    return {
      execute,
      getCached(nodeId) {
        return store.get(nodeId) || null;
      },
      invalidateNodeAndDownstream(graph, startNodeId) {
        const adj = new Map();
        for (const e of graph.edges || []) {
          if (!adj.has(e.fromNode)) adj.set(e.fromNode, []);
          adj.get(e.fromNode).push(e.toNode);
        }
        const q = [startNodeId];
        const visited = new Set([startNodeId]);
        while (q.length) {
          const cur = q.shift();
          store.delete(cur);
          for (const nxt of adj.get(cur) || []) {
            if (!visited.has(nxt)) {
              visited.add(nxt);
              q.push(nxt);
            }
          }
        }
        return Array.from(visited);
      },
      clearCache() {
        store.clear();
      },
    };
  }

  return {
    topologicalSort,
    createWorkflowRunner,
    hashString,
    stableStringify,
  };
});
