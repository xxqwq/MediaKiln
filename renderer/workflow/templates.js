((root, factory) => {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VGT = root.VGT || {};
    root.VGT.wfTemplates = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const WORKFLOW_TEMPLATES = [
    {
      id: 'tpl_video_to_gif_pro',
      name: '🎞️ 视频截取 + 水印 + 压缩 GIF 动图',
      desc: '从长视频截取精彩片段 → 叠加水印 → 转调色板 GIF → 极限瘦身压缩 → 分支对比并导出',
      category: '视频 / GIF',
      graph: {
        name: '视频转精品压缩 GIF',
        nodes: [
          { id: 'n1', type: 'io.loadFile', x: 60, y: 180, params: { filePath: '' } },
          { id: 'n2', type: 'feat.trimVideo', x: 440, y: 180, params: { tStart: 0, tEnd: 6, precise: 'precise' } },
          { id: 'n3', type: 'feat.watermark', x: 820, y: 180, params: { mode: 'text', text: '@工具箱', pos: 'br', size: 'medium', opacity: '0.75' } },
          { id: 'n4', type: 'feat.videoToGif', x: 1200, y: 180, params: { tStart: 0, tEnd: 0, fps: '15', width: '480', colors: '128' } },
          { id: 'n5', type: 'feat.compressGif', x: 1580, y: 120, params: { preset: 'balanced', width: '480', fps: '12', colors: '128', dither: 'bayer5', statsMode: 'diff', denoise: 'none', dedup: 'no', diffMode: 'rectangle', speed: '1', loop: '0', useTrim: 'no' } },
          { id: 'n6', type: 'io.compare', x: 1960, y: 60, params: {} },
          { id: 'n7', type: 'io.save', x: 1960, y: 290, params: { outMode: 'global', customDir: '', suffix: '', exportAsFolder: 'auto', noOverwrite: 'yes' } },
        ],
        edges: [
          { id: 'e1', fromNode: 'n1', fromPort: 'media', toNode: 'n2', toPort: 'input' },
          { id: 'e2', fromNode: 'n2', fromPort: 'out', toNode: 'n3', toPort: 'input' },
          { id: 'e3', fromNode: 'n3', fromPort: 'out', toNode: 'n4', toPort: 'input' },
          { id: 'e4', fromNode: 'n4', fromPort: 'out', toNode: 'n5', toPort: 'input' },
          { id: 'e5', fromNode: 'n2', fromPort: 'out', toNode: 'n6', toPort: 'before' },
          { id: 'e6', fromNode: 'n5', fromPort: 'out', toNode: 'n6', toPort: 'after' },
          { id: 'e7', fromNode: 'n5', fromPort: 'out', toNode: 'n7', toPort: 'media' },
        ],
      },
    },
    {
      id: 'tpl_vertical_short_bgm',
      name: '📱 横屏去黑边转 9:16 竖屏 + 配背景音乐',
      desc: '自动检测并裁掉视频黑边 → 模糊背景适配 9:16 竖屏 → 混入背景音乐 → 导出成品 MP4',
      category: '短视频剪辑',
      graph: {
        name: '横屏转 9:16 配乐短视频',
        nodes: [
          { id: 'n1', type: 'io.loadFile', x: 60, y: 100, params: { filePath: '' } },
          { id: 'n2', type: 'io.loadFile', x: 60, y: 340, params: { filePath: '' } },
          { id: 'n3', type: 'feat.autoCrop', x: 440, y: 100, params: {} },
          { id: 'n4', type: 'feat.aspectPad', x: 820, y: 100, params: { ratio: '9:16', bg: 'blur' } },
          { id: 'n5', type: 'feat.addMusic', x: 1200, y: 200, params: { mode: 'replace', musicVolume: '1' } },
          { id: 'n6', type: 'io.save', x: 1580, y: 200, params: { outMode: 'global', customDir: '', suffix: '_竖屏', exportAsFolder: 'auto', noOverwrite: 'yes' } },
        ],
        edges: [
          { id: 'e1', fromNode: 'n1', fromPort: 'media', toNode: 'n3', toPort: 'input' },
          { id: 'e2', fromNode: 'n3', fromPort: 'out', toNode: 'n4', toPort: 'input' },
          { id: 'e3', fromNode: 'n4', fromPort: 'out', toNode: 'n5', toPort: 'input' },
          { id: 'e4', fromNode: 'n2', fromPort: 'media', toNode: 'n5', toPort: 'music' },
          { id: 'e5', fromNode: 'n5', fromPort: 'out', toNode: 'n6', toPort: 'media' },
        ],
      },
    },
    {
      id: 'tpl_doc_roundtrip',
      name: '📑 Word / PPT 提取图片 → 批量瘦身 → 自动写回原位',
      desc: '提取文档内嵌图片 → 批量压缩为 JPG 瘦身 → 自动按 Manifest 精确匹配回填到原 Word / PPT',
      category: '办公文档',
      graph: {
        name: '文档图片提取压缩并回填',
        nodes: [
          { id: 'n1', type: 'io.loadFile', x: 60, y: 200, params: { filePath: '' } },
          { id: 'n2', type: 'feat.docExtractImages', x: 440, y: 80, params: { naming: 'order', pptMedia: 'images', remoteMode: 'skip', includeSvg: 'yes', dedupe: 'yes' } },
          { id: 'n3', type: 'feat.imageConvert', x: 820, y: 80, params: { format: 'jpg', quality: 'medium', resizeMode: 'maxSide', maxSide: '1920', bgColor: '#ffffff', stripMeta: 'yes' } },
          { id: 'n4', type: 'feat.docRepackImages', x: 1200, y: 180, params: {} },
          { id: 'n5', type: 'io.save', x: 1580, y: 180, params: { outMode: 'global', customDir: '', suffix: '_瘦身回填', exportAsFolder: 'auto', noOverwrite: 'yes' } },
        ],
        edges: [
          { id: 'e1', fromNode: 'n1', fromPort: 'media', toNode: 'n2', toPort: 'input' },
          { id: 'e2', fromNode: 'n2', fromPort: 'out', toNode: 'n3', toPort: 'input' },
          { id: 'e3', fromNode: 'n1', fromPort: 'media', toNode: 'n4', toPort: 'input' },
          { id: 'e4', fromNode: 'n3', fromPort: 'out', toNode: 'n4', toPort: 'replaceSource' },
          { id: 'e5', fromNode: 'n4', fromPort: 'out', toNode: 'n5', toPort: 'media' },
        ],
      },
    },
    {
      id: 'tpl_chroma_sticker',
      name: '🪄 绿幕抠像 → 圆角装饰 → 表情包定额压缩',
      desc: '绿幕视频一键抠成透明底 GIF → 叠加圆角透明边框 → 自动压到指定 MB 以内适配微信/Discord',
      category: '表情包 / 特效',
      graph: {
        name: '绿幕透明表情包制作流',
        nodes: [
          { id: 'n1', type: 'io.loadFile', x: 60, y: 160, params: { filePath: '' } },
          { id: 'n2', type: 'feat.chromaGif', x: 440, y: 160, params: { color: '#00ff00', similarity: '0.2', blend: '0.08', width: '480', fps: '12' } },
          { id: 'n3', type: 'feat.decorateMedia', x: 820, y: 160, params: { progressBar: 'none', barColor: '#22d3ee', barHeight: '6', rounded: '24', bgColor: '#000000' } },
          { id: 'n4', type: 'feat.compressTarget', x: 1200, y: 160, params: { targetMB: '1' } },
          { id: 'n5', type: 'io.preview', x: 1580, y: 160, params: {} },
          { id: 'n6', type: 'io.save', x: 1960, y: 160, params: { outMode: 'global', customDir: '', suffix: '_表情包', exportAsFolder: 'auto', noOverwrite: 'yes' } },
        ],
        edges: [
          { id: 'e1', fromNode: 'n1', fromPort: 'media', toNode: 'n2', toPort: 'input' },
          { id: 'e2', fromNode: 'n2', fromPort: 'out', toNode: 'n3', toPort: 'input' },
          { id: 'e3', fromNode: 'n3', fromPort: 'out', toNode: 'n4', toPort: 'input' },
          { id: 'e4', fromNode: 'n4', fromPort: 'out', toNode: 'n5', toPort: 'media' },
          { id: 'e5', fromNode: 'n5', fromPort: 'out', toNode: 'n6', toPort: 'media' },
        ],
      },
    },
    {
      id: 'tpl_logo_vector_ico',
      name: '✒️ 白底图抠图 → SVG 矢量精简 + ICO 图标双路导出',
      desc: '纯白底 Logo 抠透明 → 描摹转矢量 SVG → SVGO 优化瘦身，同时分出两路保存 SVG 与 256px ICO 图标',
      category: '图片 / SVG',
      graph: {
        name: 'Logo 矢量与 ICO 双路生成',
        nodes: [
          { id: 'n1', type: 'io.loadFile', x: 60, y: 180, params: { filePath: '' } },
          { id: 'n2', type: 'feat.imageCutout', x: 440, y: 180, params: { color: '#ffffff', similarity: '0.18', blend: '0.06', format: 'png' } },
          { id: 'n3', type: 'feat.imageToSvg', x: 820, y: 150, params: { mode: 'poster', colors: 'auto', smooth: 'medium', transparentBg: 'alpha', maxDim: '800', noiseFilter: '8', optimizeSvg: 'yes' } },
          { id: 'n4', type: 'feat.svgOptimize', x: 1200, y: 180, params: { preset: 'default', floatPrecision: '2', keepViewBox: 'yes', stripDims: 'no' } },
          { id: 'n5', type: 'io.save', x: 1580, y: 60, params: { outMode: 'global', customDir: '', suffix: '_矢量', exportAsFolder: 'auto', noOverwrite: 'yes' } },
          { id: 'n6', type: 'feat.svgToRaster', x: 1580, y: 310, params: { format: 'ico', scaleMode: 'original', scale: '2', icoSize: '256', quality: 'high', bgMode: 'transparent' } },
          { id: 'n7', type: 'io.save', x: 1960, y: 310, params: { outMode: 'global', customDir: '', suffix: '_图标', exportAsFolder: 'auto', noOverwrite: 'yes' } },
        ],
        edges: [
          { id: 'e1', fromNode: 'n1', fromPort: 'media', toNode: 'n2', toPort: 'input' },
          { id: 'e2', fromNode: 'n2', fromPort: 'out', toNode: 'n3', toPort: 'input' },
          { id: 'e3', fromNode: 'n3', fromPort: 'out', toNode: 'n4', toPort: 'input' },
          { id: 'e4', fromNode: 'n4', fromPort: 'out', toNode: 'n5', toPort: 'media' },
          { id: 'e5', fromNode: 'n4', fromPort: 'out', toNode: 'n6', toPort: 'input' },
          { id: 'e6', fromNode: 'n6', fromPort: 'out', toNode: 'n7', toPort: 'media' },
        ],
      },
    },
    {
      id: 'tpl_video_frames_grid',
      name: '📸 视频抽帧 → 3×3 网格高清拼图墙',
      desc: '按时间间隔将视频导出为多帧 PNG → 自动送入拼图节点生成 3×3 高清网格概览图并预览导出',
      category: '视频 / 图片',
      graph: {
        name: '视频抽帧拼图工作流',
        nodes: [
          { id: 'n1', type: 'io.loadFile', x: 60, y: 160, params: { filePath: '' } },
          { id: 'n2', type: 'feat.snapshot', x: 440, y: 160, params: { mode: 'seq', every: '1', tStart: 0, tEnd: 0 } },
          { id: 'n3', type: 'feat.imageStitch', x: 820, y: 120, params: { mode: 'grid', cols: '3', fit: 'cover', cellRatio: '4:3', gap: '8', format: 'jpg', bgMode: 'dark' } },
          { id: 'n4', type: 'io.preview', x: 1200, y: 160, params: {} },
          { id: 'n5', type: 'io.save', x: 1580, y: 160, params: { outMode: 'global', customDir: '', suffix: '_拼图', exportAsFolder: 'auto', noOverwrite: 'yes' } },
        ],
        edges: [
          { id: 'e1', fromNode: 'n1', fromPort: 'media', toNode: 'n2', toPort: 'input' },
          { id: 'e2', fromNode: 'n2', fromPort: 'out', toNode: 'n3', toPort: 'files' },
          { id: 'e3', fromNode: 'n3', fromPort: 'out', toNode: 'n4', toPort: 'media' },
          { id: 'e4', fromNode: 'n4', fromPort: 'out', toNode: 'n5', toPort: 'media' },
        ],
      },
    },
  ];

  // DAG 最长路径分层排版算法，自动将杂乱画布整理为整洁的左→右流水线
  function autoLayoutGraph(graph, nodeHeightsMap = null) {
    const nodes = graph.nodes || [];
    const edges = graph.edges || [];
    if (!nodes.length) return graph;

    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const inAdj = new Map();
    const outAdj = new Map();
    const inDeg = new Map();
    for (const n of nodes) {
      inAdj.set(n.id, []);
      outAdj.set(n.id, []);
      inDeg.set(n.id, 0);
    }
    for (const e of edges) {
      if (nodeMap.has(e.fromNode) && nodeMap.has(e.toNode)) {
        outAdj.get(e.fromNode).push(e.toNode);
        inAdj.get(e.toNode).push(e.fromNode);
        inDeg.set(e.toNode, inDeg.get(e.toNode) + 1);
      }
    }

    const col = new Map();
    const ready = [];
    for (const [id, d] of inDeg.entries()) {
      if (d === 0) {
        ready.push(id);
        col.set(id, 0);
      }
    }

    const visited = new Set();
    while (ready.length) {
      const cur = ready.shift();
      visited.add(cur);
      const curCol = col.get(cur) || 0;
      for (const nxt of outAdj.get(cur) || []) {
        col.set(nxt, Math.max(col.get(nxt) || 0, curCol + 1));
        const nd = inDeg.get(nxt) - 1;
        inDeg.set(nxt, nd);
        if (nd === 0) ready.push(nxt);
      }
    }

    // 兜底：若存在孤立环等极端情况
    for (const n of nodes) {
      if (!visited.has(n.id)) col.set(n.id, col.get(n.id) || 0);
    }

    const cols = new Map();
    for (const n of nodes) {
      const c = col.get(n.id) || 0;
      if (!cols.has(c)) cols.set(c, []);
      cols.get(c).push(n);
    }

    const colNums = Array.from(cols.keys()).sort((a, b) => a - b);
    const startX = 70;
    const colGap = 384;
    const startY = 80;
    const rowGap = 36;

    for (const c of colNums) {
      const group = cols.get(c);
      // 根据上一列父节点的平均 y 坐标排序，减少连线交叉
      group.sort((a, b) => {
        const avgParentY = (node) => {
          const parents = inAdj.get(node.id) || [];
          if (!parents.length) return node.y || 0;
          return parents.reduce((s, pid) => s + (nodeMap.get(pid)?.y || 0), 0) / parents.length;
        };
        const da = avgParentY(a);
        const db = avgParentY(b);
        return (da - db) || ((a.y || 0) - (b.y || 0));
      });

      let curY = startY;
      for (const n of group) {
        n.x = startX + c * colGap;
        n.y = curY;
        const estH = nodeHeightsMap?.get(n.id) || 230;
        curY += estH + rowGap;
      }
    }
    return graph;
  }

  // 导入/读档时的结构标准化与安全校验
  function normalizeGraphData(raw, registry) {
    const obj = raw && typeof raw === 'object' ? raw : {};
    const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : '未命名工作流';
    const rawNodes = Array.isArray(obj.nodes) ? obj.nodes : [];
    const rawEdges = Array.isArray(obj.edges) ? obj.edges : [];

    const nodes = [];
    const validIds = new Set();
    for (const n of rawNodes) {
      if (!n || typeof n !== 'object' || !n.id || !n.type) continue;
      if (registry && !registry.getDef(n.type)) continue;
      const def = registry?.getDef(n.type);
      const baseParams = def ? def.defaultParams() : {};
      const cleanNode = {
        id: String(n.id),
        type: String(n.type),
        x: Number.isFinite(Number(n.x)) ? Number(n.x) : 80,
        y: Number.isFinite(Number(n.y)) ? Number(n.y) : 80,
        collapsed: !!n.collapsed,
        bypass: !!n.bypass,
        params: { ...baseParams, ...(n.params && typeof n.params === 'object' ? n.params : {}) },
      };
      nodes.push(cleanNode);
      validIds.add(cleanNode.id);
    }

    const edges = [];
    const seenEdges = new Set();
    for (const e of rawEdges) {
      if (!e || typeof e !== 'object') continue;
      const fromNode = String(e.fromNode || '');
      const fromPort = String(e.fromPort || '');
      const toNode = String(e.toNode || '');
      const toPort = String(e.toPort || '');
      if (!validIds.has(fromNode) || !validIds.has(toNode) || fromNode === toNode) continue;
      const sig = `${fromNode}:${fromPort}->${toNode}:${toPort}`;
      if (seenEdges.has(sig)) continue;
      if (registry) {
        const tempGraph = { nodes, edges };
        const chk = registry.canConnect(tempGraph, fromNode, fromPort, toNode, toPort);
        if (!chk.ok) continue;
      }
      seenEdges.add(sig);
      edges.push({
        id: String(e.id || `e_${edges.length + 1}_${Date.now()}`),
        fromNode,
        fromPort,
        toNode,
        toPort,
      });
    }

    return {
      version: 1,
      name,
      nodes,
      edges,
    };
  }

  return {
    WORKFLOW_TEMPLATES,
    autoLayoutGraph,
    normalizeGraphData,
  };
});
