'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GROUP_ORDER = ['转换', 'GIF 编辑', '图片', 'SVG', '文档', '剪辑', '音频', '工具'];

const catalogCache = new Map();

function toKebab(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

function normalizeKey(str) {
  return String(str || '').trim().toLowerCase().replace(/[-_\s]+/g, '');
}

function loadCliCatalog(appRoot) {
  const root = path.resolve(appRoot || path.join(__dirname, '..', '..'));
  if (catalogCache.has(root)) return catalogCache.get(root);

  const rendererDir = path.join(root, 'renderer');
  const sandbox = {
    window: {
      VGT: {
        params: {
          readTimes: () => ({ start: 0, end: 1, duration: 1 }),
        },
      },
    },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  for (const file of ['video-gif.js', 'image.js', 'svg.js', 'document.js']) {
    const filePath = path.join(rendererDir, 'features', file);
    const code = fs.readFileSync(filePath, 'utf8');
    vm.runInContext(code, sandbox, { filename: filePath });
  }

  const vgt = sandbox.window.VGT;
  const features = [
    ...(vgt.VIDEO_FEATURES || []),
    ...(vgt.IMAGE_FEATURES || []),
    ...(vgt.SVG_FEATURES || []),
    ...(vgt.DOC_FEATURES || []),
  ];

  const regFactory = require(path.join(rendererDir, 'workflow', 'node-registry.js'));
  const templatesMod = require(path.join(rendererDir, 'workflow', 'templates.js'));
  const registry = regFactory.createRegistry(features);

  const featuresById = new Map();
  const normalizedFeatureMap = new Map();
  for (const f of features) {
    featuresById.set(f.id, f);
    normalizedFeatureMap.set(normalizeKey(f.id), f);
    if (f.name) normalizedFeatureMap.set(normalizeKey(f.name), f);
  }

  const catalog = {
    root,
    features,
    featuresById,
    normalizedFeatureMap,
    registry,
    templates: templatesMod.WORKFLOW_TEMPLATES || [],
    groupOrder: GROUP_ORDER,
  };
  catalogCache.set(root, catalog);
  return catalog;
}

function findFeature(catalog, query) {
  if (!query) return null;
  if (catalog.featuresById.has(query)) return catalog.featuresById.get(query);
  const norm = normalizeKey(query);
  if (catalog.normalizedFeatureMap.has(norm)) return catalog.normalizedFeatureMap.get(norm);
  return null;
}

function suggestFeatures(catalog, query, limit = 5) {
  const norm = normalizeKey(query);
  if (!norm) return [];
  const scored = [];
  for (const f of catalog.features) {
    const nid = normalizeKey(f.id);
    const nname = normalizeKey(f.name);
    let score = 0;
    if (nid.startsWith(norm) || nname.startsWith(norm)) score = 100;
    else if (nid.includes(norm) || nname.includes(norm)) score = 70;
    else if (norm.includes(nid)) score = 50;
    else {
      // 简单共享字符比对
      let hits = 0;
      for (const ch of new Set(norm)) {
        if (nid.includes(ch)) hits++;
      }
      if (hits >= Math.max(3, Math.floor(norm.length * 0.6))) score = hits * 5;
    }
    if (score > 0) scored.push({ feature: f, score });
  }
  scored.sort((a, b) => b.score - a.score || a.feature.id.localeCompare(b.feature.id));
  return scored.slice(0, limit).map((s) => s.feature);
}

function describeFeatureOptions(def, feature) {
  const defaults = def.defaultParams ? def.defaultParams() : {};
  const params = [];
  const aliasMap = new Map(); // normalizedFlag -> descriptor
  const registerAliases = (desc, names) => {
    for (const n of names) {
      if (!n) continue;
      aliasMap.set(normalizeKey(n), desc);
    }
  };

  for (const field of def.fields || []) {
    if (field.type === 'groupHeader') continue;

    if (field.type === 'times') {
      const startDesc = {
        key: 'tStart',
        flag: '--start',
        aliases: ['--t-start', '--tStart'],
        kind: 'time',
        label: '起始时间（秒或 hh:mm:ss）',
        defaultValue: defaults.tStart ?? 0,
      };
      const endDesc = {
        key: 'tEnd',
        flag: '--end',
        aliases: ['--t-end', '--tEnd'],
        kind: 'time',
        label: '结束时间（秒或 hh:mm:ss，0 表示到末尾）',
        defaultValue: defaults.tEnd ?? 0,
      };
      const durDesc = {
        key: '__duration',
        flag: '--duration',
        aliases: ['--dur'],
        kind: 'time',
        label: '截取时长（秒，与 --start 组合自动计算 --end）',
        defaultValue: '',
      };
      params.push(startDesc, endDesc, durDesc);
      registerAliases(startDesc, ['start', 'tStart', 't-start']);
      registerAliases(endDesc, ['end', 'tEnd', 't-end']);
      registerAliases(durDesc, ['duration', 'dur']);
      continue;
    }

    if (field.type === 'multiSegments') {
      const desc = {
        key: 'segments',
        flag: '--segments',
        aliases: [],
        kind: 'segments',
        label: '时间段列表（如 "0-5,10-15" 或 JSON）',
        defaultValue: defaults.segments || [{ start: 0, end: 5 }],
      };
      params.push(desc);
      registerAliases(desc, ['segments']);
      continue;
    }

    if (field.type === 'cropCanvas') {
      const desc = {
        key: 'crop',
        flag: '--crop',
        aliases: [],
        kind: 'crop',
        label: '选区 "x,y,w,h"（0~1 比例或像素坐标，或 JSON）',
        defaultValue: defaults.crop || { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
      };
      params.push(desc);
      registerAliases(desc, ['crop']);
      continue;
    }

    if (field.type === 'secondFile') {
      const key = field.key || 'second';
      const flag = `--${toKebab(key)}`;
      const desc = {
        key: `__local_${key}`,
        portKey: key,
        flag,
        aliases: key !== toKebab(key) ? [`--${key}`] : [],
        kind: 'file',
        label: field.label || `辅助文件 (${key})`,
        defaultValue: '',
        required: def.inputs?.find((p) => p.id === key)?.required || false,
      };
      params.push(desc);
      registerAliases(desc, [key, toKebab(key), `__local_${key}`]);
      continue;
    }

    if (field.type === 'replaceSource') {
      const dirDesc = {
        key: '__replaceDir',
        flag: '--replace-dir',
        aliases: ['--replace-source', '--replaceDir'],
        kind: 'dir',
        label: '替换图片所在文件夹路径',
        defaultValue: '',
      };
      const fileDesc = {
        key: '__replaceFiles',
        flag: '--replace-file',
        aliases: ['--replace-files', '--replaceFile'],
        kind: 'fileList',
        label: '指定替换图片文件（可多次传入或逗号分隔）',
        defaultValue: [],
      };
      params.push(dirDesc, fileDesc);
      registerAliases(dirDesc, ['replace-dir', 'replaceDir', 'replace-source', 'replaceSource']);
      registerAliases(fileDesc, ['replace-file', 'replaceFile', 'replace-files', 'replaceFiles']);
      continue;
    }

    if (!field.key) continue;
    const flag = `--${toKebab(field.key)}`;
    const options = Array.isArray(field.options)
      ? field.options.map((opt) => (Array.isArray(opt) ? { value: String(opt[0]), label: String(opt[1] ?? opt[0]) } : { value: String(opt), label: String(opt) }))
      : null;

    const desc = {
      key: field.key,
      flag,
      aliases: field.key !== toKebab(field.key) ? [`--${field.key}`] : [],
      kind: field.type || 'text',
      label: field.label || field.key,
      defaultValue: defaults[field.key] ?? field.def ?? '',
      options,
      applyPresets: field.applyPresets || null,
      min: field.min,
      max: field.max,
    };
    params.push(desc);
    registerAliases(desc, [field.key, toKebab(field.key)]);
  }

  // 若存在 bgMode + bgCustom，允许用户直接使用 --bg-color 作为便捷别名
  const hasBgMode = params.some((p) => p.key === 'bgMode');
  const hasBgCustom = params.some((p) => p.key === 'bgCustom');
  if (hasBgMode && hasBgCustom && !aliasMap.has('bgcolor')) {
    const bgColorAlias = {
      key: '__bgColorAlias',
      flag: '--bg-color',
      aliases: ['--bgColor'],
      kind: 'color',
      label: '快捷设置自定义背景色（自动切到 bgMode=custom）',
      defaultValue: '',
      hidden: true,
    };
    registerAliases(bgColorAlias, ['bg-color', 'bgColor']);
  }

  return {
    featureId: feature.id,
    name: def.name,
    group: def.group,
    desc: def.desc,
    accept: def.accept,
    multi: !!def.multi,
    noBatch: !!def.noBatch,
    batch: !def.multi && !def.noBatch,
    params,
    aliasMap,
    defaults,
  };
}

module.exports = {
  GROUP_ORDER,
  toKebab,
  normalizeKey,
  loadCliCatalog,
  findFeature,
  suggestFeatures,
  describeFeatureOptions,
};
