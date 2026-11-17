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
    'gif', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif', 'ico',
    'svg', 'mp3', 'm4a', 'wav', 'flac', 'aac', 'ogg', 'srt',
    'docx', 'pptx', 'md', 'markdown', 'pdf',
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
      let activeTaskId = null;

      const controller = {
        cancel() {
          aborted = true;
          if (activeTaskId) {
            try { runtime.cancelTask?.(activeTaskId); } catch {}
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

        // 收集本地引用文件，一次 stat 校验源文件修改时间与大小
        const localFilesToStat = [];
        for (const nid of order) {
          const n = nodeMap.get(nid);
          if (n.type === 'io.loadFile' && n.params?.filePath) localFilesToStat.push(n.params.filePath);
          if (n.type === 'io.loadBatch' && Array.isArray(n.params?.filePaths)) localFilesToStat.push(...n.params.filePaths);
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
        const summary = { executed: 0, cached: 0, bypassed: 0, exportedFiles: [] };

        for (const nid of order) {
          onNodeState(nid, { status: 'pending', progress: 0 });
        }

        for (let stepIdx = 0; stepIdx < order.length; stepIdx++) {
          if (aborted) throw new Error('工作流已取消');
          const nid = order[stepIdx];
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
            upstreamSigs[portId] = elist.map((e) => `${e.fromNode}:${e.fromPort}:${signatures.get(e.fromNode) || ''}`);
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
          } else {
            for (const [k, val] of Object.entries(node.params || {})) {
              if (k.startsWith('__local_') && typeof val === 'string' && val) {
                const st = fileStatMap.get(val);
                localStatsSig[k] = st ? `${st.size}:${st.mtimeMs}` : 'missing';
              }
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

          // 校验缓存命中（io.save 需确认目标导出文件仍存在）
          const cached = store.get(nid);
          if (!forceRun && cached && cached.sig === sig && cached.payload?.paths?.length) {
            const checkPaths = node.type === 'io.save' && cached.savedPaths?.length
              ? cached.savedPaths
              : cached.payload.paths;
            const diskStats = await runtime.statMulti(checkPaths);
            const allAlive = diskStats.length === checkPaths.length && diskStats.every((s) => s.exists && !s.isDirectory && s.size > 0);
            if (allAlive) {
              outputs.set(nid, cached.payload);
              summary.cached++;
              if (node.type === 'io.save' && cached.savedPaths) {
                summary.exportedFiles.push(...cached.savedPaths);
              }
              onNodeState(nid, {
                status: 'cached',
                progress: 1,
                payload: cached.payload,
                savedPaths: cached.savedPaths,
                targetDir: cached.targetDir,
              });
              onOverallProgress((stepIdx + 1) / order.length, `⚡ 命中缓存 (${stepIdx + 1}/${order.length}) · ${def.name}`);
              continue;
            }
          }

          onNodeState(nid, { status: 'running', progress: 0 });
          const baseOverall = stepIdx / order.length;
          const spanOverall = 1 / order.length;
          onOverallProgress(baseOverall, `正在执行 (${stepIdx + 1}/${order.length}) · ${def.name}`);

          const reportNodeProgress = (r) => {
            const clamped = Math.max(0, Math.min(1, r || 0));
            onNodeState(nid, { status: 'running', progress: clamped });
            onOverallProgress(
              baseOverall + spanOverall * clamped,
              `正在执行 (${stepIdx + 1}/${order.length}) ${Math.round(clamped * 100)}% · ${def.name}`,
            );
          };

          try {
            let resultPayload = null;
            let savedPaths = null;
            let targetDir = null;

            // ---------- 1. I/O 专用节点 ----------
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
            } else if (node.type === 'io.listPick') {
              const upEdge = inEdgesByPort.get('items')?.[0];
              if (!upEdge) throw new Error('请先连接上游输入');
              const upPayload = outputs.get(upEdge.fromNode);
              resultPayload = node.bypass ? upPayload : applyListPick(upPayload, node.params);
            } else if (node.type === 'io.preview') {
              const upEdge = inEdgesByPort.get('media')?.[0];
              if (!upEdge) throw new Error('请先连接要预览的节点');
              resultPayload = outputs.get(upEdge.fromNode);
            } else if (node.type === 'io.compare') {
              const eBefore = inEdgesByPort.get('before')?.[0];
              const eAfter = inEdgesByPort.get('after')?.[0];
              if (!eBefore || !eAfter) throw new Error('请同时连接「处理前」与「处理后」两个端口');
              const pBefore = outputs.get(eBefore.fromNode);
              const pAfter = outputs.get(eAfter.fromNode);
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
              const upEdge = inEdgesByPort.get('media')?.[0];
              if (!upEdge) throw new Error('请先连接待导出的上游节点');
              const upPayload = outputs.get(upEdge.fromNode);
              if (!upPayload?.paths?.length) throw new Error('上游节点没有可导出的文件');
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

              // 旁路模式：直接将主输入原样透传
              if (node.bypass) {
                const firstUp = outputs.get(primaryEdges[0].fromNode);
                if (primaryEdges.length === 1) {
                  resultPayload = firstUp;
                } else {
                  const mergedPaths = [];
                  const mergedInfos = [];
                  for (const pe of primaryEdges) {
                    const up = outputs.get(pe.fromNode);
                    mergedPaths.push(...(up.paths || []));
                    mergedInfos.push(...(up.infos || []));
                  }
                  resultPayload = {
                    kind: mergedPaths.length > 1 ? 'list' : 'single',
                    paths: mergedPaths,
                    infos: mergedInfos,
                    originPath: firstUp.originPath,
                  };
                }
                summary.bypassed++;
                outputs.set(nid, resultPayload);
                store.set(nid, { sig, payload: resultPayload });
                onNodeState(nid, { status: 'bypassed', progress: 1, payload: resultPayload });
                onOverallProgress((stepIdx + 1) / order.length, `⏭ 已旁路 (${stepIdx + 1}/${order.length}) · ${def.name}`);
                continue;
              }

              // 收集副端口输入
              const secondaryPayloads = {};
              for (let i = 1; i < def.inputs.length; i++) {
                const sp = def.inputs[i];
                const sedges = inEdgesByPort.get(sp.id) || [];
                if (sedges.length) {
                  const combinedPaths = [];
                  const combinedInfos = [];
                  let sManifestDir = '';
                  let sSourceDir = '';
                  for (const se of sedges) {
                    const sup = outputs.get(se.fromNode);
                    if (sup?.paths?.length) {
                      combinedPaths.push(...sup.paths);
                      combinedInfos.push(...(sup.infos || []));
                    }
                    if (!sManifestDir && sup?.manifestDir) sManifestDir = sup.manifestDir;
                    if (!sSourceDir && sup?.sourceDir) sSourceDir = sup.sourceDir;
                  }
                  secondaryPayloads[sp.id] = {
                    paths: combinedPaths,
                    infos: combinedInfos,
                    manifestDir: sManifestDir,
                    sourceDir: sSourceDir,
                  };
                }
              }

              // 展平主输入（单文件 / 列表 / 多连汇聚）
              const primaryItems = [];
              let originPath = '';
              let manifestDir = '';
              let sourceDocx = '';
              for (const pe of primaryEdges) {
                const up = outputs.get(pe.fromNode);
                if (!originPath && up?.originPath) originPath = up.originPath;
                if (!manifestDir && up?.manifestDir) manifestDir = up.manifestDir;
                if (!sourceDocx && up?.sourceDocx) sourceDocx = up.sourceDocx;
                (up?.paths || []).forEach((p, idx) => {
                  primaryItems.push({ path: p, info: up.infos?.[idx] || {} });
                });
              }
              if (!primaryItems.length) throw new Error(`节点「${def.name}」上游没有可用文件`);
              if (!originPath) originPath = primaryItems[0].path;

              // 为本节点分配非 C 盘工作流缓存目录
              const alloc = await runtime.allocNodeDir({
                subKey: `${nid}_${sig.slice(0, 8)}`,
                manifestDir,
              });
              const nodeCacheDir = alloc.dir;

              const runSingleTask = async (taskParams, progCb) => {
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
                    activeTaskId = tid;
                    onTaskStart?.(tid);
                  },
                  progCb,
                );
                activeTaskId = null;
                if (res.cancelled || aborted) throw new Error('工作流已取消');
                if (!res.ok) throw new Error(res.error || `${def.name} 处理失败`);
                return res;
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
                // 列表输入 → 自动对列表内兼容文件逐项批处理（List Map）
                const acceptSet = new Set(def.accept.map((e) => (e === 'jpeg' ? 'jpg' : e)));
                const outPaths = [];
                const outInfos = [];
                let processedCount = 0;

                for (let idx = 0; idx < primaryItems.length; idx++) {
                  if (aborted) throw new Error('工作流已取消');
                  const item = primaryItems[idx];
                  const itemExt = extOf(item.path);
                  const normExt = itemExt === 'jpeg' ? 'jpg' : itemExt;
                  if (!acceptSet.has(normExt)) {
                    // 非兼容后缀（例如文档提取出的 SVG 经过仅处理位图的压缩节点）跳过处理并透传原文件，避免中断链路
                    outPaths.push(item.path);
                    outInfos.push(item.info);
                    continue;
                  }

                  const itemParams = registry.buildNodeTaskParams(node, item, secondaryPayloads, []);
                  const res = await runSingleTask(itemParams, (r) => {
                    reportNodeProgress((idx + r) / primaryItems.length);
                  });
                  processedCount++;
                  if (res.outputType === 'dir') {
                    const dirFiles = res.extractSummary?.files?.length
                      ? res.extractSummary.files
                      : naturalSort(await runtime.listDir(res.output, 500)).filter((f) => MEDIA_OUT_EXTS.has(extOf(f)));
                    const probed = dirFiles.length ? await runtime.probeMulti(dirFiles) : [];
                    for (const pr of probed) {
                      outPaths.push(pr.path);
                      outInfos.push(pr.info || {});
                    }
                  } else {
                    const pr = await runtime.probe(res.output);
                    outPaths.push(res.output);
                    outInfos.push(pr.ok ? pr.info : {});
                  }
                }
                if (!processedCount) {
                  throw new Error(`列表中的文件格式均与「${def.name}」不兼容`);
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
            onNodeState(nid, {
              status: 'done',
              progress: 1,
              payload: resultPayload,
              savedPaths,
              targetDir,
            });
            onOverallProgress((stepIdx + 1) / order.length, `✅ 完成 (${stepIdx + 1}/${order.length}) · ${def.name}`);
          } catch (err) {
            const isCancel = aborted || err.message === '工作流已取消' || err.message === '任务已取消';
            onNodeState(nid, {
              status: isCancel ? 'cancelled' : 'error',
              progress: 0,
              errorMsg: err.message,
            });
            throw err;
          }
        }

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
