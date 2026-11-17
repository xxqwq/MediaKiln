(() => {
  'use strict';

  window.VGT = window.VGT || {};

  const STORAGE_CURRENT_KEY = 'vgt_wf_current_v1';
  const STORAGE_SAVED_KEY = 'vgt_wf_saved_v1';

  const storageApi = {
    loadCurrent() {
      try {
        return JSON.parse(localStorage.getItem(STORAGE_CURRENT_KEY) || 'null');
      } catch {
        return null;
      }
    },
    saveCurrent(graph) {
      try {
        localStorage.setItem(STORAGE_CURRENT_KEY, JSON.stringify(graph));
      } catch {}
    },
    list() {
      try {
        const arr = JSON.parse(localStorage.getItem(STORAGE_SAVED_KEY) || '[]');
        return Array.isArray(arr) ? arr : [];
      } catch {
        return [];
      }
    },
    saveItem(name, graph) {
      const list = storageApi.list();
      const id = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const item = {
        id,
        name,
        updatedAt: Date.now(),
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        graph: JSON.parse(JSON.stringify({ ...graph, name })),
      };
      list.unshift(item);
      localStorage.setItem(STORAGE_SAVED_KEY, JSON.stringify(list.slice(0, 50)));
      return item;
    },
    removeItem(id) {
      const next = storageApi.list().filter((x) => x.id !== id);
      localStorage.setItem(STORAGE_SAVED_KEY, JSON.stringify(next));
      return next;
    },
  };
  window.VGT.wfStorage = storageApi;

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtSize(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  function toFileUrl(p) {
    return encodeURI('file:///' + String(p || '').replace(/\\/g, '/'));
  }

  function extOf(p) {
    const m = String(p || '').match(/\.([^.\\/]+)$/);
    return m ? m[1].toLowerCase() : '';
  }

  function initWorkflowCanvas(containerEl, bridge) {
    const reg = window.VGT.wfRegistry;
    const engineMod = window.VGT.wfEngine;
    const tplMod = window.VGT.wfTemplates;
    const modals = window.VGT.wfModals;

    const cacheStore = new Map();
    const runner = engineMod.createWorkflowRunner({ registry: reg, cacheStore });

    // -----------------------------------------------------------------------
    // 编辑器状态
    // -----------------------------------------------------------------------
    const DEFAULT_NODE_W = 336;
    let graph = { version: 1, name: '新建工作流', nodes: [], edges: [] };
    let view = { panX: 40, panY: 40, zoom: 0.92 };
    let userAdjustedView = false;
    let selectedNodes = new Set();
    let selectedEdgeId = null;
    let nodeStates = new Map(); // nodeId -> { status, progress, payload, errorMsg, savedPaths, targetDir }
    let nodeEls = new Map(); // nodeId -> HTMLElement
    let wireHover = null;
    let activeController = null;
    let isRunning = false;
    let spacePressed = false;
    let draggingWire = null; // { fromNode, fromPort, exts, x0, y0, x1, y1 }
    let popupEl = null;
    let ctxMenuEl = null;

    const undoStack = [];
    const redoStack = [];
    let nextIdSeq = 1;

    const allocNodeId = () => `n${Date.now().toString(36)}_${nextIdSeq++}`;
    const allocEdgeId = () => `e${Date.now().toString(36)}_${nextIdSeq++}`;

    // -----------------------------------------------------------------------
    // 骨架 DOM 构建
    // -----------------------------------------------------------------------
    containerEl.innerHTML = `
      <header class="wf-toolbar">
        <div class="wf-toolbar-left">
          <input type="text" id="wf-name-input" class="wf-name-input" value="新建工作流" title="编辑当前工作流名称" />
          <button class="btn btn-ghost btn-sm" id="wf-btn-tpl">📋 模板 / 存档</button>
          <button class="btn btn-ghost btn-sm" id="wf-btn-import">📥 导入</button>
          <button class="btn btn-ghost btn-sm" id="wf-btn-export">📤 导出</button>
          <button class="btn btn-ghost btn-sm" id="wf-btn-layout" title="按拓扑层级自动整理节点位置">🧹 自动整理</button>
          <button class="btn btn-ghost btn-sm" id="wf-btn-clear">🗑️ 清空</button>
        </div>
        <div class="wf-toolbar-right">
          <span class="wf-progress-pill hidden" id="wf-progress-pill"></span>
          <button class="btn btn-ghost btn-sm" id="wf-btn-cache" title="点击清理 .workflow_cache 中间产物缓存">🧹 缓存 0 B</button>
          <button class="btn btn-ghost btn-sm" id="wf-btn-force" title="忽略缓存从头重新执行所有节点">↻ 强制重跑</button>
          <button class="btn btn-primary btn-sm" id="wf-btn-run">▶ 运行工作流</button>
          <button class="btn btn-danger btn-sm hidden" id="wf-btn-stop">⏹ 停止运行</button>
        </div>
      </header>
      <div class="wf-viewport" id="wf-viewport">
        <div class="wf-stage" id="wf-stage">
          <svg class="wf-wires" id="wf-wires" width="1" height="1">
            <defs id="wf-wire-defs"></defs>
            <g id="wf-wire-layer"></g>
            <path class="wf-wire-preview hidden" id="wf-wire-preview"></path>
          </svg>
          <div class="wf-nodes" id="wf-nodes"></div>
        </div>
        <div class="wf-empty-guide hidden" id="wf-empty-guide">
          <h2>🕸️ 欢迎使用节点式工作流画布</h2>
          <p>
            从左侧节点库点击或拖入子功能到画布，连接端口串联多步音视频/图片/SVG/文档流水线。<br />
            也可以直接把电脑里的文件拖进画布，或从预设模板一键开始！
          </p>
          <div class="wf-empty-actions">
            <button class="btn btn-primary btn-sm" id="wf-guide-tpl">✨ 载入预设模板</button>
            <button class="btn btn-ghost btn-sm" id="wf-guide-add-load">📂 添加「加载文件」节点</button>
            <button class="btn btn-ghost btn-sm" id="wf-guide-add-demo">🎞️ 载入视频转 GIF 示例流</button>
          </div>
        </div>
        <div class="wf-zoom-hud">
          <canvas class="wf-minimap" id="wf-minimap" width="170" height="110" title="小地图：点击或拖拽跳转视图"></canvas>
          <div class="wf-zoom-bar">
            <button id="wf-zoom-out" title="缩小">－</button>
            <span class="wf-zoom-readout" id="wf-zoom-readout">92%</span>
            <button id="wf-zoom-in" title="放大">＋</button>
            <button id="wf-zoom-fit" title="适应全部节点">⊡ 适应</button>
          </div>
        </div>
      </div>
    `;

    const vpEl = containerEl.querySelector('#wf-viewport');
    const stageEl = containerEl.querySelector('#wf-stage');
    const wireLayerEl = containerEl.querySelector('#wf-wire-layer');
    const wireDefsEl = containerEl.querySelector('#wf-wire-defs');
    const wirePreviewEl = containerEl.querySelector('#wf-wire-preview');
    const nodesLayerEl = containerEl.querySelector('#wf-nodes');
    const guideEl = containerEl.querySelector('#wf-empty-guide');
    const nameInput = containerEl.querySelector('#wf-name-input');
    const progressPill = containerEl.querySelector('#wf-progress-pill');
    const cacheBtn = containerEl.querySelector('#wf-btn-cache');
    const runBtn = containerEl.querySelector('#wf-btn-run');
    const forceBtn = containerEl.querySelector('#wf-btn-force');
    const stopBtn = containerEl.querySelector('#wf-btn-stop');
    const minimapCanvas = containerEl.querySelector('#wf-minimap');
    const zoomHudEl = containerEl.querySelector('.wf-zoom-hud');
    const zoomReadout = containerEl.querySelector('#wf-zoom-readout');

    // -----------------------------------------------------------------------
    // 历史快照 & 持久化
    // -----------------------------------------------------------------------
    function snapshotUndo() {
      undoStack.push(JSON.stringify(graph));
      if (undoStack.length > 40) undoStack.shift();
      redoStack.length = 0;
    }

    function persistCurrent() {
      storageApi.saveCurrent(graph);
    }

    function undo() {
      if (isRunning || !undoStack.length) return;
      redoStack.push(JSON.stringify(graph));
      const prev = JSON.parse(undoStack.pop());
      graph = tplMod.normalizeGraphData(prev, reg);
      selectedNodes.clear();
      selectedEdgeId = null;
      persistCurrent();
      renderAll();
      bridge.toast('已撤销');
    }

    function redo() {
      if (isRunning || !redoStack.length) return;
      undoStack.push(JSON.stringify(graph));
      const nxt = JSON.parse(redoStack.pop());
      graph = tplMod.normalizeGraphData(nxt, reg);
      selectedNodes.clear();
      selectedEdgeId = null;
      persistCurrent();
      renderAll();
      bridge.toast('已重做');
    }

    // -----------------------------------------------------------------------
    // 坐标转换 & 视口控制
    // -----------------------------------------------------------------------
    function screenToCanvas(clientX, clientY) {
      const r = vpEl.getBoundingClientRect();
      return {
        x: (clientX - r.left - view.panX) / view.zoom,
        y: (clientY - r.top - view.panY) / view.zoom,
      };
    }

    function applyViewTransform() {
      stageEl.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
      vpEl.style.backgroundPosition = `${view.panX}px ${view.panY}px, ${view.panX}px ${view.panY}px`;
      const s1 = 24 * view.zoom;
      const s2 = 120 * view.zoom;
      vpEl.style.backgroundSize = `${s1}px ${s1}px, ${s2}px ${s2}px`;
      zoomReadout.textContent = `${Math.round(view.zoom * 100)}%`;
      drawMinimap();
    }

    function zoomAt(nextZoom, clientX, clientY) {
      userAdjustedView = true;
      const clamped = Math.min(2.2, Math.max(0.25, nextZoom));
      const r = vpEl.getBoundingClientRect();
      const px = clientX ?? (r.left + r.width / 2);
      const py = clientY ?? (r.top + r.height / 2);
      const before = screenToCanvas(px, py);
      view.zoom = clamped;
      view.panX = (px - r.left) - before.x * view.zoom;
      view.panY = (py - r.top) - before.y * view.zoom;
      applyViewTransform();
    }

    function getGraphBounds() {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of graph.nodes) {
        const el = nodeEls.get(n.id);
        const w = el?.offsetWidth || DEFAULT_NODE_W;
        const h = el?.offsetHeight || 220;
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + w);
        maxY = Math.max(maxY, n.y + h);
      }
      return { minX, minY, maxX, maxY };
    }

    function fitView() {
      if (!graph.nodes.length) {
        view = { panX: 40, panY: 40, zoom: 1 };
        applyViewTransform();
        return;
      }
      const r = vpEl.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const { minX, minY, maxX, maxY } = getGraphBounds();
      const bw = Math.max(100, maxX - minX);
      const bh = Math.max(100, maxY - minY);
      const padX = 28;
      const padTop = 24;
      const padBottom = 28;
      let scale = Math.min(1.05, Math.max(0.25, Math.min((r.width - padX * 2) / bw, (r.height - padTop - padBottom) / bh)));
      let panX = (r.width - bw * scale) / 2 - minX * scale;
      let panY = padTop + (r.height - padTop - padBottom - bh * scale) / 2 - minY * scale;

      // 避免右下角小地图/缩放栏遮挡节点
      const hudW = (zoomHudEl?.offsetWidth || 172) + 24;
      const hudH = (zoomHudEl?.offsetHeight || 150) + 24;
      const rightEdge = panX + maxX * scale;
      const bottomEdge = panY + maxY * scale;
      if (rightEdge > r.width - hudW && bottomEdge > r.height - hudH) {
        const maxBottom = r.height - hudH;
        const shiftedY = maxBottom - maxY * scale;
        if (shiftedY + minY * scale >= 16) {
          panY = shiftedY;
        } else {
          const availH = Math.max(180, r.height - padTop - hudH);
          scale = Math.min(scale, Math.max(0.25, availH / bh));
          panX = (r.width - bw * scale) / 2 - minX * scale;
          panY = padTop + (availH - bh * scale) / 2 - minY * scale;
        }
      }

      view.zoom = scale;
      view.panX = panX;
      view.panY = panY;
      applyViewTransform();
    }

    function ensureNodeVisible(node) {
      if (!node) return;
      const r = vpEl.getBoundingClientRect();
      const el = nodeEls.get(node.id);
      if (!r.width || !r.height || !el) return;
      const nw = el.offsetWidth || DEFAULT_NODE_W;
      const nh = el.offsetHeight || 220;
      const hudW = (zoomHudEl?.offsetWidth || 172) + 24;
      const hudH = (zoomHudEl?.offsetHeight || 150) + 24;
      const pad = 20;

      // 若单个节点在当前缩放下比可视区域还高/宽，自动适当缩小确保完整展示
      const maxAvailW = Math.max(220, r.width - pad * 2);
      const maxAvailH = Math.max(220, r.height - pad * 2);
      if (nw * view.zoom > maxAvailW || nh * view.zoom > maxAvailH) {
        view.zoom = Math.max(0.35, Math.min(view.zoom, maxAvailW / nw, maxAvailH / nh));
      }

      // 尽量把新节点放在视口完整可见范围内（且避开右下角 HUD）
      const visLeft = -view.panX / view.zoom + pad / view.zoom;
      const visTop = -view.panY / view.zoom + pad / view.zoom;
      const visRight = (-view.panX + r.width - pad) / view.zoom;
      const visBottom = (-view.panY + r.height - pad) / view.zoom;
      const maxXInVis = Math.max(visLeft, visRight - nw);
      const maxYInVis = Math.max(visTop, visBottom - nh);

      node.x = Math.round(Math.min(maxXInVis, Math.max(visLeft, node.x)));
      node.y = Math.round(Math.min(maxYInVis, Math.max(visTop, node.y)));

      const screenR = node.x * view.zoom + view.panX + nw * view.zoom;
      const screenB = node.y * view.zoom + view.panY + nh * view.zoom;
      if (screenR > r.width - hudW && screenB > r.height - hudH) {
        const altY = Math.round((-view.panY + r.height - hudH) / view.zoom - nh);
        if (altY >= visTop) node.y = altY;
      }

      el.style.left = `${node.x}px`;
      el.style.top = `${node.y}px`;
      applyViewTransform();
      renderWires();
    }

    // -----------------------------------------------------------------------
    // 缓存体积显示
    // -----------------------------------------------------------------------
    async function refreshCacheInfo() {
      try {
        const info = await window.api.wfCacheInfo();
        cacheBtn.textContent = `🧹 缓存 ${fmtSize(info?.sizeBytes || 0)}`;
        cacheBtn.title = `缓存目录：${info?.dir || ''}\n共 ${info?.fileCount || 0} 个中间文件（点击清空）`;
      } catch {}
    }

    // -----------------------------------------------------------------------
    // 端口位置与 SVG 贝塞尔曲线渲染
    // -----------------------------------------------------------------------
    function getPortCanvasPos(nodeId, portId, isOutput) {
      const node = graph.nodes.find((n) => n.id === nodeId);
      const el = nodeEls.get(nodeId);
      if (!node || !el) return null;
      const dot = el.querySelector(`.wf-port-dot[data-port="${portId}"][data-dir="${isOutput ? 'out' : 'in'}"]`);
      if (!dot) {
        return {
          x: node.x + (isOutput ? (el.offsetWidth || DEFAULT_NODE_W) : 0),
          y: node.y + 52,
        };
      }
      const dotRect = dot.getBoundingClientRect();
      const stageRect = stageEl.getBoundingClientRect();
      return {
        x: (dotRect.left + dotRect.width / 2 - stageRect.left) / view.zoom,
        y: (dotRect.top + dotRect.height / 2 - stageRect.top) / view.zoom,
      };
    }

    function bezierPath(x0, y0, x1, y1) {
      const dx = Math.max(52, Math.abs(x1 - x0) * 0.5);
      return `M ${x0} ${y0} C ${x0 + dx} ${y0}, ${x1 - dx} ${y1}, ${x1} ${y1}`;
    }

    function renderWires() {
      wireLayerEl.innerHTML = '';
      wireDefsEl.innerHTML = '';

      for (const edge of graph.edges) {
        const p0 = getPortCanvasPos(edge.fromNode, edge.fromPort, true);
        const p1 = getPortCanvasPos(edge.toNode, edge.toPort, false);
        if (!p0 || !p1) continue;

        const fromNode = graph.nodes.find((n) => n.id === edge.fromNode);
        const toNode = graph.nodes.find((n) => n.id === edge.toNode);
        const toDef = toNode ? reg.getDef(toNode.type) : null;
        const outSpec = fromNode ? reg.getNodeOutputSpec(graph, edge.fromNode, edge.fromPort) : null;
        const inPort = toDef?.inputs?.find((i) => i.id === edge.toPort);

        const c1 = reg.PORT_TYPES[outSpec?.typeId || 'any']?.color || '#94a3b8';
        const c2 = reg.PORT_TYPES[inPort?.typeId || 'any']?.color || '#94a3b8';

        const gradId = `wg_${edge.id}`;
        // 避免渐变盒宽/高为 0 时 SVG userSpaceOnUse 渲染不可见（垂直线或水平线时 x1===x2 或 y1===y2）
        const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
        grad.setAttribute('id', gradId);
        grad.setAttribute('gradientUnits', 'userSpaceOnUse');
        grad.setAttribute('x1', String(p0.x));
        grad.setAttribute('y1', String(p0.y));
        grad.setAttribute('x2', String(p1.x === p0.x ? p1.x + 1 : p1.x));
        grad.setAttribute('y2', String(p1.y === p0.y ? p1.y + 1 : p1.y));
        grad.innerHTML = `<stop offset="0%" stop-color="${c1}" /><stop offset="100%" stop-color="${c2}" />`;
        wireDefsEl.appendChild(grad);

        const d = bezierPath(p0.x, p0.y, p1.x, p1.y);
        const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hit.setAttribute('d', d);
        hit.setAttribute('class', 'wf-wire-hit');
        hit.dataset.edgeId = edge.id;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        const st = nodeStates.get(edge.toNode)?.status;
        const cls = ['wf-wire-path'];
        if (edge.id === selectedEdgeId) cls.push('selected');
        if (st === 'running') cls.push('running');
        path.setAttribute('class', cls.join(' '));
        path.setAttribute('stroke', `url(#${gradId})`);

        hit.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          selectedEdgeId = edge.id;
          selectedNodes.clear();
          syncSelectionClasses();
          renderWires();
        });
        hit.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          removeEdge(edge.id);
        });

        wireLayerEl.appendChild(hit);
        wireLayerEl.appendChild(path);
      }

      if (draggingWire) {
        wirePreviewEl.classList.remove('hidden');
        wirePreviewEl.setAttribute('d', bezierPath(draggingWire.x0, draggingWire.y0, draggingWire.x1, draggingWire.y1));
      } else {
        wirePreviewEl.classList.add('hidden');
      }
      drawMinimap();
    }

    function drawMinimap() {
      const ctx = minimapCanvas.getContext('2d');
      const W = minimapCanvas.width;
      const H = minimapCanvas.height;
      ctx.clearRect(0, 0, W, H);
      if (!graph.nodes.length) return;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of graph.nodes) {
        const el = nodeEls.get(n.id);
        const nw = el?.offsetWidth || DEFAULT_NODE_W;
        const nh = el?.offsetHeight || 220;
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + nw);
        maxY = Math.max(maxY, n.y + nh);
      }
      const vr = vpEl.getBoundingClientRect();
      const vx0 = -view.panX / view.zoom;
      const vy0 = -view.panY / view.zoom;
      const vx1 = vx0 + vr.width / view.zoom;
      const vy1 = vy0 + vr.height / view.zoom;
      minX = Math.min(minX, vx0) - 80;
      minY = Math.min(minY, vy0) - 80;
      maxX = Math.max(maxX, vx1) + 80;
      maxY = Math.max(maxY, vy1) + 80;

      const scale = Math.min(W / Math.max(1, maxX - minX), H / Math.max(1, maxY - minY));
      const ox = (W - (maxX - minX) * scale) / 2;
      const oy = (H - (maxY - minY) * scale) / 2;
      const tx = (x) => ox + (x - minX) * scale;
      const ty = (y) => oy + (y - minY) * scale;

      ctx.strokeStyle = 'rgba(148,163,184,0.35)';
      ctx.lineWidth = 1;
      for (const e of graph.edges) {
        const na = graph.nodes.find((n) => n.id === e.fromNode);
        const nb = graph.nodes.find((n) => n.id === e.toNode);
        if (!na || !nb) continue;
        const naw = nodeEls.get(na.id)?.offsetWidth || DEFAULT_NODE_W;
        ctx.beginPath();
        ctx.moveTo(tx(na.x + naw), ty(na.y + 50));
        ctx.lineTo(tx(nb.x), ty(nb.y + 50));
        ctx.stroke();
      }

      for (const n of graph.nodes) {
        const el = nodeEls.get(n.id);
        const nw = el?.offsetWidth || DEFAULT_NODE_W;
        const nh = el?.offsetHeight || 180;
        const st = nodeStates.get(n.id)?.status;
        ctx.fillStyle = selectedNodes.has(n.id)
          ? '#22d3ee'
          : (st === 'done' ? '#34d399' : (st === 'error' ? '#f87171' : '#6366f1'));
        ctx.fillRect(tx(n.x), ty(n.y), Math.max(6, nw * scale), Math.max(4, nh * scale));
      }

      ctx.strokeStyle = 'rgba(34,211,238,0.85)';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(tx(vx0), ty(vy0), (vx1 - vx0) * scale, (vy1 - vy0) * scale);
    }

    // -----------------------------------------------------------------------
    // 节点与连线增删改查
    // -----------------------------------------------------------------------
    function addNode(type, x, y, presetParams = null) {
      const def = reg.getDef(type);
      if (!def) return null;
      snapshotUndo();
      const node = {
        id: allocNodeId(),
        type,
        x: Math.round(x),
        y: Math.round(y),
        collapsed: false,
        bypass: false,
        params: { ...def.defaultParams(), ...(presetParams || {}) },
      };
      graph.nodes.push(node);
      selectedNodes = new Set([node.id]);
      selectedEdgeId = null;
      persistCurrent();
      renderAll();
      return node;
    }

    function removeNodes(ids) {
      if (isRunning) return bridge.toast('任务运行中，暂不可删除节点', true);
      const set = new Set(ids);
      if (!set.size) return;
      snapshotUndo();
      graph.nodes = graph.nodes.filter((n) => !set.has(n.id));
      graph.edges = graph.edges.filter((e) => !set.has(e.fromNode) && !set.has(e.toNode));
      for (const id of set) {
        selectedNodes.delete(id);
        nodeStates.delete(id);
        cacheStore.delete(id);
      }
      persistCurrent();
      renderAll();
    }

    function removeEdge(edgeId) {
      if (isRunning) return bridge.toast('任务运行中，暂不可删除连线', true);
      const edge = graph.edges.find((e) => e.id === edgeId);
      if (!edge) return;
      snapshotUndo();
      graph.edges = graph.edges.filter((e) => e.id !== edgeId);
      if (selectedEdgeId === edgeId) selectedEdgeId = null;
      runner.invalidateNodeAndDownstream(graph, edge.toNode);
      persistCurrent();
      renderNodeDynamicPorts();
      renderWires();
    }

    function connectPorts(fromNode, fromPort, toNode, toPort) {
      const check = reg.canConnect(graph, fromNode, fromPort, toNode, toPort);
      if (!check.ok) {
        bridge.toast(check.reason, true);
        return false;
      }
      const toNodeObj = graph.nodes.find((n) => n.id === toNode);
      const toDef = reg.getDef(toNodeObj.type);
      const inPortDef = toDef.inputs.find((p) => p.id === toPort);
      snapshotUndo();
      if (!inPortDef.multiConnect) {
        graph.edges = graph.edges.filter((e) => !(e.toNode === toNode && e.toPort === toPort));
      }
      graph.edges.push({ id: allocEdgeId(), fromNode, fromPort, toNode, toPort });
      runner.invalidateNodeAndDownstream(graph, toNode);
      persistCurrent();
      renderNodeDynamicPorts();
      renderNodeFieldsVisibility(toNode);
      renderWires();
      return true;
    }

    function syncSelectionClasses() {
      for (const [nid, el] of nodeEls.entries()) {
        el.classList.toggle('selected', selectedNodes.has(nid));
      }
    }

    // -----------------------------------------------------------------------
    // 节点渲染与内嵌参数控件
    // -----------------------------------------------------------------------
    function buildNodeCard(node) {
      const def = reg.getDef(node.type);
      if (!def) return null;

      const el = document.createElement('div');
      el.className = 'wf-node'
        + (selectedNodes.has(node.id) ? ' selected' : '')
        + (node.collapsed ? ' collapsed' : '')
        + (node.bypass ? ' bypassed' : '');
      el.dataset.nodeId = node.id;
      el.style.left = `${node.x}px`;
      el.style.top = `${node.y}px`;

      const groupColor = reg.GROUP_META[def.group]?.color || '#6366f1';

      const head = document.createElement('div');
      head.className = 'wf-node-head';
      head.innerHTML = `
        <span class="wf-node-accent" style="background:${groupColor}"></span>
        <span class="wf-node-icon">${def.icon}</span>
        <span class="wf-node-title" title="${esc(def.desc)}">${esc(def.name)}</span>
        <span class="wf-node-badge" data-badge>待运行</span>
        <button class="wf-node-hbtn" data-act="collapse" title="折叠 / 展开">${node.collapsed ? '▸' : '▾'}</button>
        <button class="wf-node-hbtn" data-act="remove" title="删除节点">✕</button>
      `;

      head.addEventListener('mousedown', (e) => {
        if (e.target.closest('.wf-node-hbtn')) return;
        e.stopPropagation();
        closePopups();
        if (!selectedNodes.has(node.id)) {
          if (!e.shiftKey) selectedNodes.clear();
          selectedNodes.add(node.id);
          selectedEdgeId = null;
          syncSelectionClasses();
          renderWires();
        }
        const startClientX = e.clientX;
        const startClientY = e.clientY;
        const moveTargets = Array.from(selectedNodes).map((id) => {
          const n = graph.nodes.find((x) => x.id === id);
          return n ? { node: n, sx: n.x, sy: n.y } : null;
        }).filter(Boolean);
        let moved = false;

        const onMove = (ev) => {
          const dx = (ev.clientX - startClientX) / view.zoom;
          const dy = (ev.clientY - startClientY) / view.zoom;
          if (!moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
            snapshotUndo();
            moved = true;
          }
          if (!moved) return;
          for (const t of moveTargets) {
            t.node.x = Math.round(t.sx + dx);
            t.node.y = Math.round(t.sy + dy);
            const nel = nodeEls.get(t.node.id);
            if (nel) {
              nel.style.left = `${t.node.x}px`;
              nel.style.top = `${t.node.y}px`;
            }
          }
          renderWires();
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          if (moved) persistCurrent();
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });

      head.querySelector('[data-act="collapse"]').onclick = (e) => {
        e.stopPropagation();
        node.collapsed = !node.collapsed;
        el.classList.toggle('collapsed', node.collapsed);
        e.currentTarget.textContent = node.collapsed ? '▸' : '▾';
        persistCurrent();
        renderWires();
      };
      head.querySelector('[data-act="remove"]').onclick = (e) => {
        e.stopPropagation();
        removeNodes([node.id]);
      };

      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!selectedNodes.has(node.id)) {
          selectedNodes = new Set([node.id]);
          syncSelectionClasses();
        }
        openNodeContextMenu(node, e.clientX, e.clientY);
      });

      el.appendChild(head);

      // 端口与主体包裹层（折叠时一起隐藏）
      const bodyWrap = document.createElement('div');
      bodyWrap.className = 'wf-node-ports-body';

      // 左右端口区
      const portsRow = document.createElement('div');
      portsRow.className = 'wf-ports';
      const inCol = document.createElement('div');
      inCol.className = 'wf-ports-col in';
      for (const inp of def.inputs || []) {
        const pColor = reg.PORT_TYPES[inp.typeId]?.color || '#94a3b8';
        const row = document.createElement('div');
        row.className = 'wf-port-row in';
        row.innerHTML = `<div class="wf-port-dot" data-node="${node.id}" data-port="${inp.id}" data-dir="in" style="background:${pColor}" title="输入端口：${esc(inp.label)} (${inp.accept.includes('*') ? '任意' : inp.accept.slice(0, 6).join('/')})"></div><span class="wf-port-label">${esc(inp.label)}${inp.multiConnect ? ' ⊕' : ''}</span>`;
        const dot = row.querySelector('.wf-port-dot');
        dot.addEventListener('mousedown', (e) => onPortMouseDown(e, node.id, inp.id, false));
        dot.addEventListener('mouseup', (e) => onPortMouseUp(e, node.id, inp.id, false));
        inCol.appendChild(row);
      }

      const outCol = document.createElement('div');
      outCol.className = 'wf-ports-col out';
      for (const outp of def.outputs || []) {
        const dyn = reg.getNodeOutputSpec(graph, node.id, outp.id);
        const pColor = reg.PORT_TYPES[dyn?.typeId || outp.typeId]?.color || '#94a3b8';
        const row = document.createElement('div');
        row.className = 'wf-port-row out';
        row.innerHTML = `<div class="wf-port-dot" data-node="${node.id}" data-port="${outp.id}" data-dir="out" style="background:${pColor}" title="输出端口：${esc(outp.label)}"></div><span class="wf-port-label">${esc(outp.label)}</span>`;
        const dot = row.querySelector('.wf-port-dot');
        dot.addEventListener('mousedown', (e) => onPortMouseDown(e, node.id, outp.id, true));
        dot.addEventListener('mouseup', (e) => onPortMouseUp(e, node.id, outp.id, true));
        outCol.appendChild(row);
      }
      portsRow.appendChild(inCol);
      portsRow.appendChild(outCol);
      bodyWrap.appendChild(portsRow);

      // 参数控件区
      if (def.fields?.length) {
        const body = document.createElement('div');
        body.className = 'wf-node-body';
        renderNodeFields(node, def, body);
        bodyWrap.appendChild(body);
      }

      // 预览 / 错误反馈占位区
      const previewArea = document.createElement('div');
      previewArea.className = 'wf-node-preview hidden';
      previewArea.dataset.previewBox = '1';
      bodyWrap.appendChild(previewArea);

      if (node.type === 'io.loadFile' && node.params?.filePath && !nodeStates.has(node.id)) {
        const p = node.params.filePath;
        window.api.probe(p).then((r) => {
          if (r.ok && node.params.filePath === p && !nodeStates.has(node.id)) {
            nodeStates.set(node.id, {
              status: 'done',
              progress: 1,
              payload: { kind: 'single', paths: [p], infos: [r.info], originPath: p },
            });
            updateNodeStateUI(node.id);
          }
        }).catch(() => {});
      }

      if (node.type === 'io.loadBatch' && node.params?.filePaths?.length && !nodeStates.has(node.id)) {
        const ps = node.params.filePaths.slice();
        window.api.probeMulti(ps).then((resList) => {
          const valid = resList.filter((x) => x.info);
          if (valid.length && !nodeStates.has(node.id)) {
            nodeStates.set(node.id, {
              status: 'done',
              progress: 1,
              payload: { kind: 'list', paths: valid.map((v) => v.path), infos: valid.map((v) => v.info), originPath: valid[0].path },
            });
            updateNodeStateUI(node.id);
          }
        }).catch(() => {});
      }

      el.appendChild(bodyWrap);
      updateNodeStateUI(node.id, el);
      return el;
    }

    function onParamsChanged(node, reRenderDynamic = true) {
      runner.invalidateNodeAndDownstream(graph, node.id);
      persistCurrent();
      renderNodeFieldsVisibility(node.id);
      if (reRenderDynamic) {
        renderNodeDynamicPorts();
        renderWires();
      }
    }

    function shouldFieldSpanFull(field, totalFields) {
      if (totalFields < 4) return true;
      if ([
        'wfFilePicker', 'wfBatchPicker', 'wfDirPicker',
        'cropCanvas', 'multiSegments', 'secondFile', 'replaceSource',
        'times', 'text', 'color',
      ].includes(field.type)) return true;
      if (field.type === 'chips') {
        const opts = field.options || [];
        const totalChars = opts.reduce((s, [, l]) => s + String(l || '').length, 0);
        if (opts.length > 3 || totalChars > 12 || opts.some(([, l]) => String(l || '').length > 6)) return true;
        return false;
      }
      if (field.type === 'select') {
        const opts = field.options || [];
        if (opts.some(([, l]) => String(l || '').length > 18)) return true;
        return false;
      }
      return false;
    }

    function renderNodeFields(node, def, body) {
      body.innerHTML = '';
      const p = node.params;
      const totalFields = def.fields.length;

      for (const field of def.fields) {
        const fw = document.createElement('div');
        fw.className = 'wf-field' + (shouldFieldSpanFull(field, totalFields) ? ' wf-field-full' : '');
        if (field.key) fw.dataset.fieldKey = field.key;
        if (field.type === 'times') fw.dataset.fieldKey = '__times';

        if (field.type === 'wfFilePicker') {
          const curPath = p.filePath || '';
          const fname = curPath ? curPath.split(/[\\/]/).pop() : '未选择文件（点击选择或拖入）';
          fw.innerHTML = `
            <div class="wf-file-box">
              <button class="btn btn-ghost btn-sm" data-pick-single>📁 选择文件</button>
              <span class="wf-file-name ${curPath ? '' : 'empty'}" title="${esc(curPath)}">${esc(fname)}</span>
            </div>`;
          fw.querySelector('[data-pick-single]').onclick = async () => {
            const picked = await window.api.pickFile('anyMediaSingle');
            const chosen = Array.isArray(picked) ? picked[0] : picked;
            if (!chosen) return;
            await assignSingleFileToNode(node, chosen);
          };
        } else if (field.type === 'wfBatchPicker') {
          const paths = Array.isArray(p.filePaths) ? p.filePaths : [];
          fw.innerHTML = `
            <div class="wf-file-box">
              <button class="btn btn-ghost btn-sm" data-pick-batch>+ 多选文件</button>
              <button class="btn btn-ghost btn-sm" data-pick-dir>📂 选文件夹</button>
              <span class="muted" style="font-size:11px">共 ${paths.length} 个</span>
            </div>
            ${paths.length ? `<div class="wf-batch-mini">${paths.slice(0, 8).map((fp, i) => `
              <div class="wf-batch-mini-row">
                <span title="${esc(fp)}">${i + 1}. ${esc(fp.split(/[\\/]/).pop())}</span>
                <button class="batch-btn" data-rm-batch="${i}" title="移除">✕</button>
              </div>`).join('')}${paths.length > 8 ? `<div class="muted" style="font-size:10.5px">… 还有 ${paths.length - 8} 个文件</div>` : ''}</div>` : ''}`;
          fw.querySelector('[data-pick-batch]').onclick = async () => {
            const picked = await window.api.pickFile('anyMedia');
            const list = Array.isArray(picked) ? picked : (picked ? [picked] : []);
            if (!list.length) return;
            await assignBatchFilesToNode(node, list, false);
          };
          fw.querySelector('[data-pick-dir]').onclick = async () => {
            const dir = await window.api.pickDir();
            if (!dir) return;
            const files = await window.api.listDir(dir, 300);
            if (!files.length) return bridge.toast('所选文件夹内没有可用文件', true);
            await assignBatchFilesToNode(node, files, false);
          };
          fw.querySelectorAll('[data-rm-batch]').forEach((btn) => {
            btn.onclick = () => {
              const idx = Number(btn.dataset.rmBatch);
              p.filePaths = paths.filter((_, j) => j !== idx);
              onParamsChanged(node);
              rerenderNodeBody(node);
            };
          });
        } else if (field.type === 'wfDirPicker') {
          const dir = p.customDir || '';
          fw.innerHTML = `
            <div class="wf-field-label"><span>${esc(field.label)}</span></div>
            <div class="wf-file-box">
              <button class="btn btn-ghost btn-sm" data-pick-out-dir>📁 选择目录</button>
              <span class="wf-file-name ${dir ? '' : 'empty'}" title="${esc(dir)}">${esc(dir || '未选择')}</span>
            </div>`;
          fw.querySelector('[data-pick-out-dir]').onclick = async () => {
            const picked = await window.api.pickDir();
            if (!picked) return;
            p.customDir = picked;
            onParamsChanged(node, false);
            rerenderNodeBody(node);
          };
        } else if (field.type === 'select') {
          const val = p[field.key] ?? field.def;
          fw.innerHTML = `
            <div class="wf-field-label"><span>${esc(field.label)}</span></div>
            <select>${field.options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
          fw.querySelector('select').onchange = (e) => {
            p[field.key] = e.target.value;
            onParamsChanged(node);
          };
        } else if (field.type === 'chips') {
          const val = String(p[field.key] ?? field.def);
          fw.innerHTML = `
            <div class="wf-field-label"><span>${esc(field.label)}</span></div>
            <div class="wf-chips">${field.options.map(([v, l]) => `<button class="wf-chip ${String(v) === val ? 'on' : ''}" data-val="${esc(v)}">${esc(l)}</button>`).join('')}</div>`;
          fw.querySelectorAll('.wf-chip').forEach((chip) => {
            chip.onclick = () => {
              p[field.key] = chip.dataset.val;
              fw.querySelectorAll('.wf-chip').forEach((c) => c.classList.toggle('on', c === chip));
              if (field.applyPresets?.[chip.dataset.val]) {
                Object.assign(p, field.applyPresets[chip.dataset.val]);
                rerenderNodeBody(node);
              }
              onParamsChanged(node);
            };
          });
        } else if (field.type === 'range') {
          const unit = field.unit ?? 'x';
          const val = p[field.key] ?? field.def;
          fw.innerHTML = `
            <div class="wf-field-label"><span>${esc(field.label)}</span><span data-range-readout>${val}${unit}</span></div>
            <input type="range" min="${field.min}" max="${field.max}" step="${field.step}" value="${val}" />`;
          const range = fw.querySelector('input[type="range"]');
          const readout = fw.querySelector('[data-range-readout]');
          range.oninput = () => {
            p[field.key] = range.value;
            readout.textContent = `${range.value}${unit}`;
            onParamsChanged(node, false);
          };
        } else if (field.type === 'number') {
          const val = p[field.key] ?? field.def;
          fw.innerHTML = `
            <div class="wf-field-label"><span>${esc(field.label)}</span></div>
            <input type="number" value="${esc(val)}" min="${field.min ?? 0}" ${field.max !== undefined ? `max="${field.max}"` : ''} step="${field.step || 1}" />`;
          fw.querySelector('input').oninput = (e) => {
            p[field.key] = e.target.value;
            onParamsChanged(node, false);
          };
        } else if (field.type === 'text') {
          const val = p[field.key] ?? field.def ?? '';
          fw.innerHTML = `
            <div class="wf-field-label"><span>${esc(field.label)}</span></div>
            <input type="text" placeholder="${esc(field.placeholder || '')}" value="${esc(val)}" />`;
          fw.querySelector('input').oninput = (e) => {
            p[field.key] = e.target.value;
            onParamsChanged(node, false);
          };
        } else if (field.type === 'color') {
          const val = /^#[0-9a-f]{6}$/i.test(p[field.key] || '') ? p[field.key] : (field.def || '#00ff00');
          fw.innerHTML = `
            <div class="wf-field-label"><span>${esc(field.label)}</span></div>
            <div class="wf-color-row">
              <input type="color" value="${val}" />
              ${(field.presets || []).map(([cv, cl]) => `<button class="wf-chip" data-cval="${cv}">${esc(cl)}</button>`).join('')}
            </div>`;
          const picker = fw.querySelector('input[type="color"]');
          picker.oninput = () => {
            p[field.key] = picker.value;
            onParamsChanged(node, false);
          };
          fw.querySelectorAll('[data-cval]').forEach((btn) => {
            btn.onclick = () => {
              picker.value = btn.dataset.cval;
              p[field.key] = btn.dataset.cval;
              onParamsChanged(node, false);
            };
          });
        } else if (field.type === 'times') {
          fw.innerHTML = `
            <div class="wf-field-label"><span>时间段（秒，终点 0=整段）</span></div>
            <div class="wf-times-row">
              <input type="number" data-ts min="0" step="0.1" value="${p.tStart ?? 0}" />
              <span>→</span>
              <input type="number" data-te min="0" step="0.1" value="${p.tEnd ?? 0}" />
            </div>`;
          fw.querySelector('[data-ts]').oninput = (e) => { p.tStart = parseFloat(e.target.value) || 0; onParamsChanged(node, false); };
          fw.querySelector('[data-te]').oninput = (e) => { p.tEnd = parseFloat(e.target.value) || 0; onParamsChanged(node, false); };
        } else if (field.type === 'cropCanvas') {
          const c = p.crop || { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
          fw.innerHTML = `
            <div class="wf-field-label"><span>${esc(field.label || '区域设置')}</span></div>
            <button class="btn btn-ghost btn-sm" data-open-crop>🎯 打开可视化框选弹窗</button>
            <div class="muted" style="font-size:11px" data-crop-txt>当前：X ${Math.round(c.x * 100)}% Y ${Math.round(c.y * 100)}% · ${Math.round(c.w * 100)}%×${Math.round(c.h * 100)}%</div>`;
          fw.querySelector('[data-open-crop]').onclick = async () => {
            const previewFile = await findUpstreamSampleFile(node.id);
            modals.openCropModal({
              node,
              previewFile,
              isCrop: def.featureId === 'videoCrop',
              onSave: (nextCrop) => {
                p.crop = nextCrop;
                const txt = fw.querySelector('[data-crop-txt]');
                if (txt) txt.textContent = `当前：X ${Math.round(nextCrop.x * 100)}% Y ${Math.round(nextCrop.y * 100)}% · ${Math.round(nextCrop.w * 100)}%×${Math.round(nextCrop.h * 100)}%`;
                onParamsChanged(node, false);
              },
            });
          };
        } else if (field.type === 'multiSegments') {
          const segs = Array.isArray(p.segments) ? p.segments : [];
          fw.innerHTML = `
            <div class="wf-field-label"><span>时间片段（已设 ${segs.length} 段）</span></div>
            <button class="btn btn-ghost btn-sm" data-open-segs>🎞️ 播放器打点设置片段</button>`;
          fw.querySelector('[data-open-segs]').onclick = async () => {
            const previewFile = await findUpstreamSampleFile(node.id);
            modals.openSegmentsModal({
              node,
              previewFile,
              onSave: (nextSegs) => {
                p.segments = nextSegs;
                onParamsChanged(node, false);
                rerenderNodeBody(node);
              },
            });
          };
        } else if (field.type === 'secondFile') {
          const localKey = `__local_${field.key || 'second'}`;
          const curLocal = p[localKey] || '';
          fw.innerHTML = `
            <div class="wf-field-label"><span>${esc(field.label)}</span></div>
            <div class="wf-file-box">
              <button class="btn btn-ghost btn-sm" data-pick-sec>📁 选文件</button>
              <span class="wf-file-name ${curLocal ? '' : 'empty'}" title="${esc(curLocal)}">${esc(curLocal ? curLocal.split(/[\\/]/).pop() : '可连线或手选')}</span>
            </div>`;
          fw.querySelector('[data-pick-sec]').onclick = async () => {
            const picked = await window.api.pickFile(def.featureId, field.kind || 'audioFile');
            const chosen = Array.isArray(picked) ? picked[0] : picked;
            if (!chosen) return;
            p[localKey] = chosen;
            onParamsChanged(node, false);
            rerenderNodeBody(node);
          };
        } else if (field.type === 'replaceSource') {
          const localSrc = p.__local_replaceSource;
          const label = localSrc ? `本地：${localSrc}` : '优先使用左侧「替换图片」连线';
          fw.innerHTML = `
            <div class="wf-field-label"><span>${esc(field.label)}</span></div>
            <div class="wf-file-box">
              <button class="btn btn-ghost btn-sm" data-pick-repdir>📁 选文件夹</button>
              <span class="wf-file-name empty">${esc(label)}</span>
            </div>`;
          fw.querySelector('[data-pick-repdir]').onclick = async () => {
            const dir = await window.api.pickDir();
            if (!dir) return;
            p.__local_replaceSource = dir;
            onParamsChanged(node, false);
            rerenderNodeBody(node);
          };
        }

        body.appendChild(fw);
      }

      renderNodeFieldsVisibility(node.id, body);
    }

    function rerenderNodeBody(node) {
      const el = nodeEls.get(node.id);
      const def = reg.getDef(node.type);
      const body = el?.querySelector('.wf-node-body');
      if (body && def) {
        renderNodeFields(node, def, body);
        renderWires();
      }
    }

    function renderNodeFieldsVisibility(nodeId, explicitBody = null) {
      const node = graph.nodes.find((n) => n.id === nodeId);
      const def = node ? reg.getDef(node.type) : null;
      const body = explicitBody || nodeEls.get(nodeId)?.querySelector('.wf-node-body');
      if (!node || !def || !body) return;

      const upSpec = def.inputs?.[0] ? reg.getUpstreamSpecForPort(graph, nodeId, def.inputs[0].id) : null;
      const isImage = !!(upSpec?.exts?.length && upSpec.exts.every((e) => reg.IMG_EXTS.includes(e)));
      const ctx = { isImage };
      const vals = node.params || {};

      for (const field of def.fields) {
        if (!field.showIf) continue;
        const key = field.type === 'times' ? '__times' : field.key;
        const target = body.querySelector(`.wf-field[data-field-key="${key}"]`);
        if (target) target.style.display = field.showIf(vals, ctx) ? '' : 'none';
      }
    }

    function renderNodeDynamicPorts() {
      for (const node of graph.nodes) {
        const def = reg.getDef(node.type);
        const el = nodeEls.get(node.id);
        if (!def || !el) continue;
        for (const outp of def.outputs || []) {
          const dyn = reg.getNodeOutputSpec(graph, node.id, outp.id);
          const color = reg.PORT_TYPES[dyn?.typeId || outp.typeId]?.color || '#94a3b8';
          const dot = el.querySelector(`.wf-port-dot[data-port="${outp.id}"][data-dir="out"]`);
          if (dot) dot.style.background = color;
        }
      }
    }

    // -----------------------------------------------------------------------
    // 节点运行状态 & 底部预览抽屉
    // -----------------------------------------------------------------------
    function updateNodeStateUI(nodeId, explicitEl = null) {
      const el = explicitEl || nodeEls.get(nodeId);
      const node = graph.nodes.find((n) => n.id === nodeId);
      if (!el || !node) return;
      const st = nodeStates.get(nodeId);

      el.classList.remove('state-running', 'state-done', 'state-cached', 'state-error');
      const badge = el.querySelector('[data-badge]');
      const previewArea = el.querySelector('[data-preview-box]');
      if (!badge || !previewArea) return;

      if (node.bypass && (!st || st.status === 'bypassed')) {
        badge.className = 'wf-node-badge bypassed';
        badge.textContent = '⏭ 旁路';
      } else if (!st) {
        badge.className = 'wf-node-badge';
        badge.textContent = '待运行';
      } else if (st.status === 'pending') {
        badge.className = 'wf-node-badge';
        badge.textContent = '排队中';
      } else if (st.status === 'running') {
        el.classList.add('state-running');
        badge.className = 'wf-node-badge running';
        badge.textContent = `${Math.round((st.progress || 0) * 100)}%`;
      } else if (st.status === 'cached') {
        el.classList.add('state-cached');
        badge.className = 'wf-node-badge cached';
        badge.textContent = '⚡ 缓存';
      } else if (st.status === 'done') {
        el.classList.add('state-done');
        badge.className = 'wf-node-badge done';
        const firstSize = st.payload?.infos?.[0]?.size;
        badge.textContent = st.savedPaths?.length
          ? `✅ 已导出 ${st.savedPaths.length}`
          : (firstSize ? `✅ ${fmtSize(firstSize)}` : '✅ 完成');
      } else if (st.status === 'error') {
        el.classList.add('state-error');
        badge.className = 'wf-node-badge error';
        badge.textContent = '❌ 失败';
      } else if (st.status === 'cancelled') {
        badge.className = 'wf-node-badge error';
        badge.textContent = '已取消';
      }

      // 渲染预览区内容
      if (st?.status === 'error' && st.errorMsg) {
        previewArea.classList.remove('hidden');
        previewArea.innerHTML = `<div class="wf-node-error-box">${esc(st.errorMsg)}</div>`;
      } else if (st?.payload?.kind === 'compare') {
        previewArea.classList.remove('hidden');
        const bExt = extOf(st.payload.beforePath);
        const aExt = extOf(st.payload.afterPath);
        const renderThumb = (p, e) => {
          if (['mp4', 'webm', 'mkv', 'mov', 'm4v'].includes(e)) return `<video src="${toFileUrl(p)}" muted preload="metadata"></video>`;
          return `<img${e === 'svg' ? ' class="is-svg"' : ''} src="${toFileUrl(p)}" />`;
        };
        const bSize = st.payload.beforeInfo?.size || 0;
        const aSize = st.payload.afterInfo?.size || 0;
        const diffTxt = bSize && aSize
          ? `大小 ${fmtSize(bSize)} → ${fmtSize(aSize)}（${aSize <= bSize ? `-${Math.round((1 - aSize / bSize) * 100)}%` : `+${Math.round((aSize / bSize - 1) * 100)}%`}）`
          : '';
        previewArea.innerHTML = `
          <div class="wf-compare-thumbs">
            <div class="wf-compare-cell">${renderThumb(st.payload.beforePath, bExt)}<div>处理前</div></div>
            <div class="wf-compare-cell">${renderThumb(st.payload.afterPath, aExt)}<div>处理后</div></div>
          </div>
          ${diffTxt ? `<div class="wf-node-preview-meta"><span>${esc(diffTxt)}</span></div>` : ''}
          <div class="wf-node-preview-ops">
            <button class="wf-mini-btn" data-open-compare>⛶ 卷帘 / 并排放大对比</button>
          </div>
        `;
        previewArea.querySelector('[data-open-compare]').onclick = () => {
          window.VGT.lightbox?.openCompare({
            srcPath: st.payload.beforePath,
            srcExt: bExt,
            srcMeta: bSize ? fmtSize(bSize) : '',
            outPath: st.payload.afterPath,
            outExt: aExt,
            outMeta: aSize ? fmtSize(aSize) : '',
            initialMode: 'slider',
          });
        };
      } else if (st?.payload?.paths?.length) {
        const firstPath = st.payload.paths[0];
        const firstInfo = st.payload.infos?.[0] || {};
        const ext = extOf(firstPath);
        const count = st.payload.paths.length;
        const isImgLike = ['gif', 'webp', 'ico', 'svg', ...reg.IMG_EXTS].includes(ext);
        const isVideo = ['mp4', 'webm', 'mkv', 'mov', 'm4v'].includes(ext);
        const isAudio = reg.AUDIO_EXTS.includes(ext);

        let mediaHtml = '';
        const bustUrl = `${toFileUrl(firstPath)}?t=${Date.now()}`;
        if (isImgLike) {
          mediaHtml = `<div class="wf-node-preview-media"><img${ext === 'svg' ? ' class="is-svg"' : ''} src="${bustUrl}" alt="预览" /></div>`;
        } else if (isVideo) {
          mediaHtml = `<div class="wf-node-preview-media"><video src="${bustUrl}" controls preload="metadata"></video></div>`;
        } else if (isAudio) {
          mediaHtml = `<div class="wf-node-preview-media"><audio src="${bustUrl}" controls preload="metadata"></audio></div>`;
        }

        const dimText = firstInfo.width ? `${firstInfo.width}×${firstInfo.height}` : '';
        const sizeText = firstInfo.size ? fmtSize(firstInfo.size) : '';
        const countText = count > 1 ? `共 ${count} 个文件` : (firstPath.split(/[\\/]/).pop());

        previewArea.classList.remove('hidden');
        previewArea.innerHTML = `
          ${mediaHtml}
          <div class="wf-node-preview-meta">
            <span title="${esc(firstPath)}">${esc(countText)}</span>
            <span>${esc([dimText, sizeText].filter(Boolean).join(' · '))}</span>
          </div>
          <div class="wf-node-preview-ops">
            ${isImgLike || isVideo ? '<button class="wf-mini-btn" data-op="zoom">⛶ 放大</button>' : ''}
            <button class="wf-mini-btn" data-op="locate">📂 定位</button>
            ${node.type !== 'io.save' && node.type !== 'io.loadFile' && node.type !== 'io.loadBatch'
              ? '<button class="wf-mini-btn" data-op="save-as">💾 另存</button>'
              : ''}
            <button class="wf-mini-btn" data-op="to-single" title="将该节点结果发送回单工具模式">🛠️ 发回单工具</button>
          </div>
        `;

        const zoomBtn = previewArea.querySelector('[data-op="zoom"]');
        if (zoomBtn) {
          zoomBtn.onclick = () => {
            if (count > 1 && isImgLike) {
              window.VGT.lightbox?.openSingle({
                list: st.payload.paths.map((p) => ({ path: p, label: p.split(/[\\/]/).pop() })),
                index: 0,
              });
            } else {
              window.VGT.lightbox?.openSingle({
                path: firstPath,
                label: firstPath.split(/[\\/]/).pop(),
                meta: sizeText,
              });
            }
          };
        }
        previewArea.querySelector('[data-op="locate"]').onclick = () => {
          if (st.targetDir && count > 1) window.api.openFolder(st.targetDir);
          else window.api.showInFolder(firstPath);
        };
        const saveAsBtn = previewArea.querySelector('[data-op="save-as"]');
        if (saveAsBtn) {
          saveAsBtn.onclick = async () => {
            const dir = await window.api.pickDir();
            if (!dir) return;
            const res = await window.api.wfExportFiles({
              files: st.payload.paths,
              originInputPath: st.payload.originPath || firstPath,
              outMode: 'custom',
              customDir: dir,
              noOverwrite: true,
              exportAsFolder: count > 1,
              manifestDir: st.payload.manifestDir || '',
            });
            if (res.ok) bridge.toast(`已另存 ${res.savedPaths.length} 个文件到 ${res.targetDir}`);
            else bridge.toast(res.error || '另存失败', true);
          };
        }
        previewArea.querySelector('[data-op="to-single"]').onclick = () => {
          bridge.sendToSingle(st.payload.paths);
        };
      } else {
        previewArea.classList.add('hidden');
        previewArea.innerHTML = '';
      }
      renderWires();
    }

    // -----------------------------------------------------------------------
    // 连线交互与拖线松手智能建节点
    // -----------------------------------------------------------------------
    function highlightCompatibleInputPorts(fromExts, fromNodeId) {
      for (const node of graph.nodes) {
        const el = nodeEls.get(node.id);
        const def = reg.getDef(node.type);
        if (!el || !def) continue;
        for (const inp of def.inputs || []) {
          const dot = el.querySelector(`.wf-port-dot[data-port="${inp.id}"][data-dir="in"]`);
          if (!dot) continue;
          const ok = node.id !== fromNodeId && reg.hasIntersection(fromExts, inp.accept);
          dot.classList.toggle('compatible', ok);
          dot.classList.toggle('incompatible', !ok);
        }
      }
    }

    function clearPortHighlights() {
      nodesLayerEl.querySelectorAll('.wf-port-dot').forEach((d) => {
        d.classList.remove('compatible', 'incompatible');
      });
    }

    function onPortMouseDown(e, nodeId, portId, isOutput) {
      e.stopPropagation();
      e.preventDefault();
      closePopups();

      let srcNode = nodeId;
      let srcPort = portId;
      if (!isOutput) {
        // 如果点击的是已有连线的单输入端口，支持拔下线头重连
        const existing = graph.edges.find((ed) => ed.toNode === nodeId && ed.toPort === portId);
        if (!existing) return;
        srcNode = existing.fromNode;
        srcPort = existing.fromPort;
        removeEdge(existing.id);
      }

      const startPos = getPortCanvasPos(srcNode, srcPort, true);
      if (!startPos) return;
      const outSpec = reg.getNodeOutputSpec(graph, srcNode, srcPort);
      const exts = outSpec?.exts || ['*'];

      draggingWire = {
        fromNode: srcNode,
        fromPort: srcPort,
        exts,
        x0: startPos.x,
        y0: startPos.y,
        x1: startPos.x,
        y1: startPos.y,
      };
      highlightCompatibleInputPorts(exts, srcNode);
      renderWires();

      const onMove = (ev) => {
        const cp = screenToCanvas(ev.clientX, ev.clientY);
        draggingWire.x1 = cp.x;
        draggingWire.y1 = cp.y;
        renderWires();
      };

      const onUp = (ev) => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        const wireState = draggingWire;
        draggingWire = null;
        clearPortHighlights();
        renderWires();

        const targetDot = ev.target?.closest?.('.wf-port-dot[data-dir="in"]');
        if (targetDot) {
          connectPorts(wireState.fromNode, wireState.fromPort, targetDot.dataset.node, targetDot.dataset.port);
          return;
        }

        // 若拖出距离足够且在空白处松手，弹出兼容节点智能快捷菜单
        const dist = Math.hypot(wireState.x1 - wireState.x0, wireState.y1 - wireState.y0);
        if (dist > 28 && !ev.target?.closest?.('.wf-node')) {
          openQuickNodeMenu(ev.clientX, ev.clientY, {
            filterExts: wireState.exts,
            autoConnectFrom: { nodeId: wireState.fromNode, portId: wireState.fromPort },
          });
        }
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    function onPortMouseUp(_e, _nodeId, _portId, _isOutput) {
      // 由全局 mouseup 捕获处理
    }

    // -----------------------------------------------------------------------
    // 快捷搜索添加节点菜单 & 节点右键上下文菜单
    // -----------------------------------------------------------------------
    function closePopups() {
      if (popupEl) { popupEl.remove(); popupEl = null; }
      if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
    }

    function openQuickNodeMenu(clientX, clientY, opts = {}) {
      closePopups();
      const menu = document.createElement('div');
      menu.className = 'wf-popup-menu';
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      menu.style.left = `${Math.min(clientX, vw - 270)}px`;
      menu.style.top = `${Math.min(clientY, vh - 370)}px`;
      menu.innerHTML = `
        <input type="text" class="wf-popup-search" placeholder="${opts.filterExts ? '搜索兼容的下一步节点…' : '搜索并添加节点…'}" />
        <div class="wf-popup-list"></div>
      `;
      document.body.appendChild(menu);
      popupEl = menu;

      const searchInp = menu.querySelector('.wf-popup-search');
      const listEl = menu.querySelector('.wf-popup-list');
      const candidates = opts.filterExts
        ? reg.findCompatibleNodesForOutput(opts.filterExts)
        : reg.getAllDefs().map((def) => ({ def, targetPort: def.inputs?.[0] || null }));

      const renderList = () => {
        const q = searchInp.value.trim().toLowerCase();
        listEl.innerHTML = '';
        for (const g of reg.GROUP_ORDER) {
          const items = candidates.filter(({ def }) => def.group === g && (
            !q
            || def.name.toLowerCase().includes(q)
            || def.desc.toLowerCase().includes(q)
            || def.group.toLowerCase().includes(q)
          ));
          if (!items.length) continue;
          const gl = document.createElement('div');
          gl.className = 'wf-popup-group';
          gl.textContent = g;
          listEl.appendChild(gl);
          for (const item of items) {
            const btn = document.createElement('button');
            btn.className = 'wf-popup-item';
            btn.innerHTML = `<span>${item.def.icon}</span><span>${esc(item.def.name)}</span>`;
            btn.onclick = () => {
              const pt = screenToCanvas(clientX, clientY);
              const created = addNode(item.def.type, pt.x, pt.y - 30);
              if (created && opts.autoConnectFrom && item.targetPort) {
                connectPorts(
                  opts.autoConnectFrom.nodeId,
                  opts.autoConnectFrom.portId,
                  created.id,
                  item.targetPort.id,
                );
              }
              if (created) ensureNodeVisible(created);
              closePopups();
            };
            listEl.appendChild(btn);
          }
        }
        if (!listEl.children.length) {
          listEl.innerHTML = '<div class="muted" style="padding:14px;text-align:center;font-size:12px">没有匹配的兼容节点</div>';
        }
      };

      searchInp.oninput = renderList;
      renderList();
      setTimeout(() => searchInp.focus(), 10);
    }

    function openNodeContextMenu(node, clientX, clientY) {
      closePopups();
      const def = reg.getDef(node.type);
      const st = nodeStates.get(node.id);
      const menu = document.createElement('div');
      menu.className = 'wf-ctx-menu';
      menu.style.left = `${Math.min(clientX, window.innerWidth - 205)}px`;
      menu.style.top = `${Math.min(clientY, window.innerHeight - 230)}px`;

      const items = [
        { label: '▶ 运行到此节点', act: () => runWorkflow({ targetNodeId: node.id }) },
        ...(!def?.isIo || node.type === 'io.listPick' ? [{
          label: node.bypass ? '✅ 恢复启用此节点' : '⏭ 旁路跳过 (Ctrl+B)',
          act: () => toggleBypassSelected(),
        }] : []),
        { label: '📑 复制节点 (Ctrl+D)', act: () => duplicateSelected() },
        ...(st?.payload?.paths?.length ? [{
          label: '🛠️ 发送结果到单工具',
          act: () => bridge.sendToSingle(st.payload.paths),
        }] : (def && !def.isIo ? [{
          label: '🛠️ 在单工具模式打开此功能',
          act: () => bridge.openFeatureInSingle(def.featureId),
        }] : [])),
        { sep: true },
        { label: '🗑️ 删除节点 (Del)', danger: true, act: () => removeNodes(Array.from(selectedNodes)) },
      ];

      for (const it of items) {
        if (it.sep) {
          const sep = document.createElement('div');
          sep.className = 'wf-ctx-sep';
          menu.appendChild(sep);
          continue;
        }
        const btn = document.createElement('button');
        btn.className = `wf-ctx-item${it.danger ? ' danger' : ''}`;
        btn.textContent = it.label;
        btn.onclick = () => { closePopups(); it.act(); };
        menu.appendChild(btn);
      }
      document.body.appendChild(menu);
      ctxMenuEl = menu;
    }

    // -----------------------------------------------------------------------
    // 快捷键操作（旁路 / 复制 / 向上游追溯参考画面）
    // -----------------------------------------------------------------------
    function toggleBypassSelected() {
      if (!selectedNodes.size) return;
      snapshotUndo();
      for (const nid of selectedNodes) {
        const n = graph.nodes.find((x) => x.id === nid);
        if (!n) continue;
        const def = reg.getDef(n.type);
        if (def?.isIo && n.type !== 'io.listPick') continue;
        n.bypass = !n.bypass;
        runner.invalidateNodeAndDownstream(graph, n.id);
        const el = nodeEls.get(n.id);
        if (el) {
          el.classList.toggle('bypassed', n.bypass);
          updateNodeStateUI(n.id, el);
        }
      }
      persistCurrent();
      renderNodeDynamicPorts();
      renderWires();
    }

    function duplicateSelected() {
      if (!selectedNodes.size) return;
      snapshotUndo();
      const idMap = new Map();
      const newIds = [];
      for (const nid of selectedNodes) {
        const orig = graph.nodes.find((x) => x.id === nid);
        if (!orig) continue;
        const copy = {
          ...JSON.parse(JSON.stringify(orig)),
          id: allocNodeId(),
          x: orig.x + 36,
          y: orig.y + 36,
        };
        graph.nodes.push(copy);
        idMap.set(orig.id, copy.id);
        newIds.push(copy.id);
      }
      for (const e of [...graph.edges]) {
        if (idMap.has(e.fromNode) && idMap.has(e.toNode)) {
          graph.edges.push({
            id: allocEdgeId(),
            fromNode: idMap.get(e.fromNode),
            fromPort: e.fromPort,
            toNode: idMap.get(e.toNode),
            toPort: e.toPort,
          });
        }
      }
      selectedNodes = new Set(newIds);
      persistCurrent();
      renderAll();
    }

    // 向上游查找一个已加载或已运行的样本文件，供裁剪/打码/多段弹窗预览使用
    async function findUpstreamSampleFile(nodeId, visited = new Set()) {
      if (visited.has(nodeId)) return null;
      visited.add(nodeId);
      const st = nodeStates.get(nodeId);
      if (st?.payload?.paths?.length) {
        return { path: st.payload.paths[0], info: st.payload.infos?.[0] || {} };
      }
      const n = graph.nodes.find((x) => x.id === nodeId);
      if (n?.type === 'io.loadFile' && n.params?.filePath) {
        const r = await window.api.probe(n.params.filePath);
        if (r.ok) return { path: n.params.filePath, info: r.info };
      }
      if (n?.type === 'io.loadBatch' && n.params?.filePaths?.length) {
        const r = await window.api.probe(n.params.filePaths[0]);
        if (r.ok) return { path: n.params.filePaths[0], info: r.info };
      }
      const inEdges = graph.edges.filter((e) => e.toNode === nodeId);
      for (const e of inEdges) {
        const found = await findUpstreamSampleFile(e.fromNode, visited);
        if (found) return found;
      }
      return null;
    }

    async function assignSingleFileToNode(node, filePath) {
      if (!isRunning) {
        const res = await window.api.probe(filePath);
        if (!res.ok) return bridge.toast(res.error || '无法读取该文件', true);
        node.params.filePath = filePath;
        const payload = { kind: 'single', paths: [filePath], infos: [res.info], originPath: filePath };
        nodeStates.set(node.id, { status: 'done', progress: 1, payload });
        onParamsChanged(node);
        rerenderNodeBody(node);
        updateNodeStateUI(node.id);
      }
    }

    async function assignBatchFilesToNode(node, paths, append = false) {
      const probed = await window.api.probeMulti(paths);
      const valid = probed.filter((x) => x.info);
      if (!valid.length) return bridge.toast('所选文件无法读取', true);
      const prev = append && Array.isArray(node.params.filePaths) ? node.params.filePaths : [];
      const seen = new Set(prev);
      const next = [...prev, ...valid.map((v) => v.path).filter((p) => !seen.has(p))];
      node.params.filePaths = next;
      const payload = {
        kind: 'list',
        paths: valid.map((v) => v.path),
        infos: valid.map((v) => v.info),
        originPath: next[0],
      };
      nodeStates.set(node.id, { status: 'done', progress: 1, payload });
      onParamsChanged(node);
      rerenderNodeBody(node);
      updateNodeStateUI(node.id);
    }

    // -----------------------------------------------------------------------
    // 画布全量渲染
    // -----------------------------------------------------------------------
    function renderAll() {
      nameInput.value = graph.name || '未命名工作流';
      nodesLayerEl.innerHTML = '';
      nodeEls.clear();

      for (const node of graph.nodes) {
        const card = buildNodeCard(node);
        if (card) {
          nodesLayerEl.appendChild(card);
          nodeEls.set(node.id, card);
        }
      }

      guideEl.classList.toggle('hidden', graph.nodes.length > 0);
      renderNodeDynamicPorts();
      applyViewTransform();
      // 等待一帧让浏览器计算各端口坐标后再连线
      requestAnimationFrame(() => renderWires());
    }

    // -----------------------------------------------------------------------
    // 运行工作流
    // -----------------------------------------------------------------------
    function setRunningUI(on) {
      isRunning = on;
      runBtn.classList.toggle('hidden', on);
      forceBtn.classList.toggle('hidden', on);
      stopBtn.classList.toggle('hidden', !on);
      progressPill.classList.toggle('hidden', !on);
      if (!on) window.api.setProgressBar(-1);
    }

    async function runWorkflow({ targetNodeId = null, forceRun = false } = {}) {
      if (isRunning) return;
      if (!graph.nodes.length) return bridge.toast('画布中还没有任何节点', true);

      setRunningUI(true);
      progressPill.textContent = '准备执行工作流…';

      const prefs = bridge.getGlobalPrefs();
      const runtime = {
        probe: (p) => window.api.probe(p),
        probeMulti: (ps) => window.api.probeMulti(ps),
        listDir: (d, lim) => window.api.listDir(d, lim),
        statMulti: (ps) => window.api.wfStatMulti(ps),
        allocNodeDir: (opts) => window.api.wfAllocNodeDir(opts),
        exportFiles: (opts) => window.api.wfExportFiles(opts),
        cancelTask: (tid) => window.api.cancelTask(tid),
        startTask(feature, params, onTid, onProg) {
          let tidKnown = false;
          bridge.setActiveTaskCallbacks(onTid, (ratio, tid) => {
            if (!tidKnown && tid) {
              tidKnown = true;
              onTid?.(tid);
            }
            onProg?.(ratio);
          });
          return window.api.startTask(feature, params).finally(() => {
            bridge.clearActiveTaskCallbacks();
          });
        },
      };

      const { controller, promise } = runner.execute(graph, runtime, {
        targetNodeId,
        forceRun,
        hwAccel: prefs.hwAccel,
        globalOutputMode: prefs.outputMode,
        globalOutputDir: prefs.outputDir,
        onNodeState(nid, stateObj) {
          nodeStates.set(nid, stateObj);
          updateNodeStateUI(nid);
        },
        onOverallProgress(ratio, text) {
          progressPill.textContent = text;
          window.api.setProgressBar(Math.max(0, Math.min(1, ratio)));
        },
      });
      activeController = controller;

      try {
        const res = await promise;
        const { summary } = res;
        window.api.notifyDone(
          '工作流执行完成',
          `执行 ${summary.executed} 个，命中缓存 ${summary.cached} 个${summary.exportedFiles.length ? `，导出 ${summary.exportedFiles.length} 个文件` : ''}`,
        );
        const noSaveHint = !targetNodeId && !graph.nodes.some((n) => n.type === 'io.save')
          ? '（未连接「保存/导出」节点，结果仅在节点内预览，可点另存或接入保存节点落盘）'
          : '';
        bridge.toast(`✅ 工作流完成：执行 ${summary.executed} · 缓存 ${summary.cached}${summary.exportedFiles.length ? ` · 导出 ${summary.exportedFiles.length} 项` : ''}${noSaveHint}`);
      } catch (err) {
        if (err.message === '工作流已取消' || err.message === '任务已取消') {
          bridge.toast('已停止运行工作流', true);
        } else {
          bridge.toast(err.message || '工作流运行出错', true);
        }
      } finally {
        activeController = null;
        setRunningUI(false);
        refreshCacheInfo();
        renderWires();
      }
    }

    // -----------------------------------------------------------------------
    // 画布视口事件（平移、框选、缩放、拖放文件与节点）
    // -----------------------------------------------------------------------
    function bindViewportEvents() {
      vpEl.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        zoomAt(view.zoom * factor, e.clientX, e.clientY);
      }, { passive: false });

      vpEl.addEventListener('mousedown', (e) => {
        closePopups();
        if (e.target.closest('.wf-node') || e.target.closest('.wf-zoom-hud') || e.target.closest('.wf-empty-guide')) return;

        // Shift + 左键拉框多选
        if (e.button === 0 && e.shiftKey) {
          const sx = e.clientX;
          const sy = e.clientY;
          const box = document.createElement('div');
          box.className = 'wf-marquee';
          vpEl.appendChild(box);
          const vrect = vpEl.getBoundingClientRect();

          const onMove = (ev) => {
            const x = Math.min(sx, ev.clientX) - vrect.left;
            const y = Math.min(sy, ev.clientY) - vrect.top;
            const w = Math.abs(ev.clientX - sx);
            const h = Math.abs(ev.clientY - sy);
            box.style.left = `${x}px`;
            box.style.top = `${y}px`;
            box.style.width = `${w}px`;
            box.style.height = `${h}px`;
          };
          const onUp = (ev) => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            box.remove();
            const p0 = screenToCanvas(Math.min(sx, ev.clientX), Math.min(sy, ev.clientY));
            const p1 = screenToCanvas(Math.max(sx, ev.clientX), Math.max(sy, ev.clientY));
            selectedNodes.clear();
            for (const n of graph.nodes) {
              const el = nodeEls.get(n.id);
              const nw = el?.offsetWidth || DEFAULT_NODE_W;
              const nh = el?.offsetHeight || 200;
              if (n.x + nw >= p0.x && n.x <= p1.x && n.y + nh >= p0.y && n.y <= p1.y) {
                selectedNodes.add(n.id);
              }
            }
            syncSelectionClasses();
            renderWires();
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
          return;
        }

        // 左键空白处拖拽 / 中键 / Space+左键：平移画布
        if (e.button === 0 || e.button === 1 || spacePressed) {
          userAdjustedView = true;
          selectedNodes.clear();
          selectedEdgeId = null;
          syncSelectionClasses();
          renderWires();

          const startX = e.clientX;
          const startY = e.clientY;
          const baseX = view.panX;
          const baseY = view.panY;
          vpEl.classList.add('panning');

          const onMove = (ev) => {
            view.panX = baseX + (ev.clientX - startX);
            view.panY = baseY + (ev.clientY - startY);
            applyViewTransform();
          };
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            vpEl.classList.remove('panning');
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }
      });

      vpEl.addEventListener('dblclick', (e) => {
        if (e.target.closest('.wf-node') || e.target.closest('.wf-zoom-hud') || e.target.closest('.wf-empty-guide')) return;
        openQuickNodeMenu(e.clientX, e.clientY);
      });

      vpEl.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.wf-node') || e.target.closest('.wf-zoom-hud')) return;
        e.preventDefault();
        openQuickNodeMenu(e.clientX, e.clientY);
      });

      // 从左侧栏拖入节点或从桌面拖入媒体文件
      vpEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        vpEl.classList.add('dragover');
      });
      vpEl.addEventListener('dragleave', (e) => {
        if (!vpEl.contains(e.relatedTarget)) vpEl.classList.remove('dragover');
      });
      vpEl.addEventListener('drop', async (e) => {
        e.preventDefault();
        vpEl.classList.remove('dragover');
        const pt = screenToCanvas(e.clientX, e.clientY);
        const nodeType = e.dataTransfer?.getData('application/x-vgt-node');
        if (nodeType) {
          const created = addNode(nodeType, pt.x - DEFAULT_NODE_W / 2, pt.y - 30);
          ensureNodeVisible(created);
          return;
        }
        const files = e.dataTransfer?.files;
        if (files?.length) {
          const paths = [...files].map((f) => window.api.getPath(f)).filter(Boolean);
          if (!paths.length) return;
          if (paths.length === 1) {
            const node = addNode('io.loadFile', pt.x - DEFAULT_NODE_W / 2, pt.y - 30);
            if (node) await assignSingleFileToNode(node, paths[0]);
            ensureNodeVisible(node);
          } else {
            const node = addNode('io.loadBatch', pt.x - DEFAULT_NODE_W / 2, pt.y - 30);
            if (node) await assignBatchFilesToNode(node, paths, false);
            ensureNodeVisible(node);
          }
        }
      });

      // 小地图点击跳转
      minimapCanvas.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        if (!graph.nodes.length) return;
        userAdjustedView = true;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of graph.nodes) {
          const el = nodeEls.get(n.id);
          const nw = el?.offsetWidth || DEFAULT_NODE_W;
          const nh = el?.offsetHeight || 220;
          minX = Math.min(minX, n.x);
          minY = Math.min(minY, n.y);
          maxX = Math.max(maxX, n.x + nw);
          maxY = Math.max(maxY, n.y + nh);
        }
        const vr = vpEl.getBoundingClientRect();
        const vx0 = -view.panX / view.zoom;
        const vy0 = -view.panY / view.zoom;
        const vx1 = vx0 + vr.width / view.zoom;
        const vy1 = vy0 + vr.height / view.zoom;
        minX = Math.min(minX, vx0) - 80;
        minY = Math.min(minY, vy0) - 80;
        maxX = Math.max(maxX, vx1) + 80;
        maxY = Math.max(maxY, vy1) + 80;
        const W = minimapCanvas.width;
        const H = minimapCanvas.height;
        const scale = Math.min(W / Math.max(1, maxX - minX), H / Math.max(1, maxY - minY));
        const ox = (W - (maxX - minX) * scale) / 2;
        const oy = (H - (maxY - minY) * scale) / 2;
        const mr = minimapCanvas.getBoundingClientRect();
        const cx = minX + (e.clientX - mr.left - ox) / scale;
        const cy = minY + (e.clientY - mr.top - oy) / scale;
        view.panX = vr.width / 2 - cx * view.zoom;
        view.panY = vr.height / 2 - cy * view.zoom;
        applyViewTransform();
      });
    }

    // -----------------------------------------------------------------------
    // 顶部工具栏与空画布引导事件
    // -----------------------------------------------------------------------
    function loadGraph(rawGraph, msg) {
      if (isRunning) return bridge.toast('任务运行中，请先停止', true);
      snapshotUndo();
      graph = tplMod.normalizeGraphData(rawGraph, reg);
      selectedNodes.clear();
      selectedEdgeId = null;
      nodeStates.clear();
      cacheStore.clear();
      userAdjustedView = false;
      persistCurrent();
      renderAll();
      fitView();
      requestAnimationFrame(() => {
        fitView();
        renderWires();
      });
      if (msg) bridge.toast(msg);
    }

    nameInput.oninput = () => {
      graph.name = nameInput.value.trim() || '未命名工作流';
      persistCurrent();
    };

    const openTemplates = () => {
      modals.openTemplatesModal({
        templates: tplMod.WORKFLOW_TEMPLATES,
        savedList: storageApi.list(),
        currentName: graph.name,
        onLoadTemplate: (tpl) => loadGraph(tpl.graph, `已载入模板「${tpl.name}」`),
        onSaveCurrent: (name) => {
          graph.name = name;
          nameInput.value = name;
          persistCurrent();
          storageApi.saveItem(name, graph);
          bridge.toast(`已保存工作流「${name}」`);
        },
        onLoadSaved: (id) => {
          const found = storageApi.list().find((x) => x.id === id);
          if (found) loadGraph(found.graph, `已打开「${found.name}」`);
        },
        onDeleteSaved: (id) => {
          storageApi.removeItem(id);
          bridge.toast('已删除存档');
        },
        onExportJson: async () => {
          const r = await window.api.wfExportJson({
            defaultName: graph.name || 'workflow',
            content: JSON.stringify(graph, null, 2),
          });
          if (r?.ok) bridge.toast(`已导出到 ${r.filePath.split(/[\\/]/).pop()}`);
        },
        onImportJson: async () => {
          const r = await window.api.wfImportJson();
          if (r?.canceled) return false;
          if (!r?.ok) {
            bridge.toast(r?.error || '导入失败', true);
            return false;
          }
          loadGraph(r.data, `已导入工作流「${r.data?.name || '未命名'}」`);
          return true;
        },
      });
    };

    containerEl.querySelector('#wf-btn-tpl').onclick = openTemplates;
    containerEl.querySelector('#wf-guide-tpl').onclick = openTemplates;
    containerEl.querySelector('#wf-guide-add-load').onclick = () => {
      const created = addNode('io.loadFile', 160, 160);
      ensureNodeVisible(created);
    };
    containerEl.querySelector('#wf-guide-add-demo').onclick = () => loadGraph(tplMod.WORKFLOW_TEMPLATES[0].graph, '已载入视频转 GIF 示例流');

    containerEl.querySelector('#wf-btn-import').onclick = async () => {
      const r = await window.api.wfImportJson();
      if (r?.canceled) return;
      if (!r?.ok) return bridge.toast(r?.error || '导入失败', true);
      loadGraph(r.data, `已导入「${r.data?.name || '工作流'}」`);
    };
    containerEl.querySelector('#wf-btn-export').onclick = async () => {
      const r = await window.api.wfExportJson({
        defaultName: graph.name || 'workflow',
        content: JSON.stringify(graph, null, 2),
      });
      if (r?.ok) bridge.toast(`已导出配置到 ${r.filePath.split(/[\\/]/).pop()}`);
    };
    containerEl.querySelector('#wf-btn-layout').onclick = () => {
      if (!graph.nodes.length) return;
      snapshotUndo();
      const heights = new Map();
      for (const [id, el] of nodeEls.entries()) heights.set(id, el.offsetHeight || 220);
      tplMod.autoLayoutGraph(graph, heights);
      userAdjustedView = false;
      persistCurrent();
      renderAll();
      fitView();
      requestAnimationFrame(() => {
        fitView();
        renderWires();
      });
      bridge.toast('已自动整理画布布局');
    };
    containerEl.querySelector('#wf-btn-clear').onclick = () => {
      if (isRunning) return bridge.toast('任务运行中，无法清空', true);
      if (!graph.nodes.length) return;
      snapshotUndo();
      graph = { version: 1, name: '新建工作流', nodes: [], edges: [] };
      selectedNodes.clear();
      selectedEdgeId = null;
      nodeStates.clear();
      cacheStore.clear();
      userAdjustedView = false;
      persistCurrent();
      renderAll();
    };
    cacheBtn.onclick = async () => {
      const res = await window.api.wfClearCache();
      if (!res.ok) return bridge.toast(res.error || '清理失败', true);
      cacheStore.clear();
      for (const [nid, st] of nodeStates.entries()) {
        if (st.status === 'cached' || st.status === 'done') {
          nodeStates.delete(nid);
        }
      }
      renderAll();
      refreshCacheInfo();
      bridge.toast('已清空工作流中间缓存');
    };
    runBtn.onclick = () => runWorkflow({ forceRun: false });
    forceBtn.onclick = () => runWorkflow({ forceRun: true });
    stopBtn.onclick = () => activeController?.cancel();

    containerEl.querySelector('#wf-zoom-out').onclick = () => zoomAt(view.zoom / 1.18);
    containerEl.querySelector('#wf-zoom-in').onclick = () => zoomAt(view.zoom * 1.18);
    containerEl.querySelector('#wf-zoom-fit').onclick = () => {
      userAdjustedView = false;
      fitView();
      renderWires();
    };

    // -----------------------------------------------------------------------
    // 对外暴露给 app.js 的控制接口
    // -----------------------------------------------------------------------
    function renderSidebarPalette(navEl, searchQuery) {
      navEl.innerHTML = '';
      const tip = document.createElement('div');
      tip.className = 'wf-palette-tip';
      tip.textContent = '💡 点击或拖拽节点到右侧画布；拖线到空白处松手可智能续接';
      navEl.appendChild(tip);

      const q = String(searchQuery || '').trim().toLowerCase();
      const all = reg.getAllDefs();
      let shown = 0;

      for (const g of reg.GROUP_ORDER) {
        const items = all.filter((d) => d.group === g && (
          !q
          || d.name.toLowerCase().includes(q)
          || d.desc.toLowerCase().includes(q)
          || d.group.toLowerCase().includes(q)
          || d.type.toLowerCase().includes(q)
        ));
        if (!items.length) continue;

        const gl = document.createElement('div');
        gl.className = 'nav-group';
        gl.textContent = g;
        navEl.appendChild(gl);

        for (const def of items) {
          const btn = document.createElement('button');
          btn.className = 'nav-item wf-node-tpl';
          btn.draggable = true;
          btn.title = def.desc;
          btn.innerHTML = `<span class="nav-icon">${def.icon}</span><span class="nav-name">${esc(def.name)}</span><span class="nav-add-badge">+ 添加</span>`;
          btn.onclick = () => {
            const r = vpEl.getBoundingClientRect();
            const pt = screenToCanvas(r.left + r.width * 0.25, r.top + r.height * 0.14);
            const idx = graph.nodes.length;
            const colStep = (idx % 3) * 44;
            const rowStep = (Math.floor(idx / 3) % 3) * 32;
            const created = addNode(def.type, pt.x + colStep, pt.y + rowStep);
            ensureNodeVisible(created);
          };
          btn.ondragstart = (e) => {
            e.dataTransfer.setData('application/x-vgt-node', def.type);
            e.dataTransfer.effectAllowed = 'copy';
          };
          navEl.appendChild(btn);
          shown++;
        }
      }

      if (!shown) {
        const empty = document.createElement('div');
        empty.className = 'nav-empty';
        empty.textContent = '没有匹配的节点';
        navEl.appendChild(empty);
      }
    }

    async function receiveFilesFromSingle(paths) {
      if (!paths?.length) return;
      const r = vpEl.getBoundingClientRect();
      const pt = r.width
        ? screenToCanvas(r.left + 80, r.top + 80)
        : { x: 80, y: 120 };
      const offset = (graph.nodes.length % 5) * 32;
      if (paths.length === 1) {
        const n = addNode('io.loadFile', pt.x + offset, pt.y + offset);
        if (n) await assignSingleFileToNode(n, paths[0]);
        ensureNodeVisible(n);
      } else {
        const n = addNode('io.loadBatch', pt.x + offset, pt.y + offset);
        if (n) await assignBatchFilesToNode(n, paths, false);
        ensureNodeVisible(n);
      }
      bridge.toast(`已将 ${paths.length} 个文件载入画布节点`);
    }

    function handleKeyDown(e) {
      if (e.isComposing) return false;
      const tag = document.activeElement?.tagName;
      const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag);
      const mod = e.ctrlKey || e.metaKey;

      if (e.code === 'Space' && !inInput) {
        spacePressed = true;
      }
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        if (!isRunning) runWorkflow({ forceRun: false });
        return true;
      }
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        openTemplates();
        return true;
      }
      if (inInput) return false;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return true;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return true;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateSelected();
        return true;
      }
      if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleBypassSelected();
        return true;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedNodes.size) {
          e.preventDefault();
          removeNodes(Array.from(selectedNodes));
          return true;
        }
        if (selectedEdgeId) {
          e.preventDefault();
          removeEdge(selectedEdgeId);
          return true;
        }
      }
      if (e.key === 'Escape') {
        closePopups();
      }
      return false;
    }

    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space') spacePressed = false;
    });
    document.addEventListener('mousedown', (e) => {
      if (popupEl && !popupEl.contains(e.target)) closePopups();
      if (ctxMenuEl && !ctxMenuEl.contains(e.target)) closePopups();
    });

    if (typeof ResizeObserver !== 'undefined') {
      let prevW = 0;
      let prevH = 0;
      const ro = new ResizeObserver(() => {
        const r = vpEl.getBoundingClientRect();
        if (!r.width || !r.height) {
          prevW = 0;
          prevH = 0;
          return;
        }
        const becameVisible = prevW === 0 || prevH === 0;
        const resized = Math.abs(r.width - prevW) > 4 || Math.abs(r.height - prevH) > 4;
        prevW = r.width;
        prevH = r.height;
        if ((becameVisible || (resized && !userAdjustedView)) && graph.nodes.length) {
          fitView();
          renderWires();
        }
      });
      ro.observe(vpEl);
    }

    // 初始化载入本地画布或默认示例
    bindViewportEvents();
    const saved = storageApi.loadCurrent();
    if (saved && Array.isArray(saved.nodes)) {
      graph = tplMod.normalizeGraphData(saved, reg);
    } else {
      graph = tplMod.normalizeGraphData(tplMod.WORKFLOW_TEMPLATES[0].graph, reg);
      persistCurrent();
    }
    renderAll();
    refreshCacheInfo();

    return {
      renderSidebarPalette,
      receiveFilesFromSingle,
      handleKeyDown,
      onActivated() {
        refreshCacheInfo();
        userAdjustedView = false;
        renderAll();
        fitView();
        requestAnimationFrame(() => {
          fitView();
          renderWires();
        });
      },
      isRunning: () => isRunning,
      cancelRunning: () => activeController?.cancel(),
      // 暴露测试与自检辅助 API
      __getGraph: () => graph,
      __loadTemplate: (idx) => {
        const tpl = tplMod.WORKFLOW_TEMPLATES[idx];
        if (tpl) loadGraph(tpl.graph);
      },
    };
  }

  window.VGT.workflowCanvas = { initWorkflowCanvas };
})();
