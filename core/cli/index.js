'use strict';

const fs = require('fs');
const path = require('path');
const { mapConcurrent } = require('../utils');
const {
  loadCliCatalog,
  findFeature,
  suggestFeatures,
  describeFeatureOptions,
  normalizeKey,
} = require('./registry');
const {
  parseArgv,
  expandInputGlobs,
  resolveToolNodeParams,
} = require('./args');
const {
  resolveWorkflowGraph,
  runWorkflowCommand,
} = require('./workflow');

class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 2;
  }
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatDuration(sec) {
  const s = Number(sec) || 0;
  if (s <= 0) return '0s';
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)}s`;
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(1);
  return `${m}m${rem}s`;
}

function readPackageMeta(appRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  } catch {
    return { name: 'MediaKiln', version: '0.1.0' };
  }
}

function renderMainHelp(pkg, catalog) {
  return [
    `MediaKiln CLI v${pkg.version} — 本地离线多媒体与文档命令行工具（共 ${catalog.features.length} 个工具 / ${catalog.templates.length} 套工作流模板）`,
    '',
    '用法:',
    '  mediakiln <子命令> [参数...]',
    '  mediakiln run <工具ID> <输入文件...> [工具参数...] [通用选项]',
    '  mediakiln <工具ID> <输入文件...> [工具参数...] [通用选项]   (run 快捷写法)',
    '',
    '子命令:',
    '  list                     列出全部可用工具（支持 --group / --search / --batch-only / --json）',
    '  info <工具ID>            查看指定工具的全部参数、可选值、默认值与示例',
    '  run <工具ID> <输入...>   运行单个工具（支持单文件、多文件合并、通配符与目录批量处理）',
    '  probe <文件...>          探测视频、动图、图片、SVG、PDF、Office 文档或字幕信息',
    '  hw                       探测本机可用 GPU 硬件编码器（NVENC / QSV / AMF）',
    '  workflow <list|info|run> 查看或运行工作流 JSON / 内置模板（简写：wf）',
    '  help                     显示此帮助信息',
    '',
    'run 常用选项:',
    '  -o, --output <路径>      指定输出文件路径（单任务）或输出目录',
    '  --out-dir <目录>         强制指定输出目录',
    '  --out-mode <模式>        输出位置：same（同目录，默认）| subdir（output 子目录）| custom',
    '  --no-overwrite           防覆盖重名（自动追加 _1、_2 编号）',
    '  --hw <模式>              视频硬件加速：cpu（默认）| auto | nvenc | qsv | amf',
    '  -c, --concurrency <N>    批量处理并发数（图片/SVG 默认 3，其余默认 1）',
    '  --params-json <JSON>     以 JSON 对象传入工具参数',
    '  --continue-on-error      批量任务中单文件出错时继续处理其余文件',
    '  --json                   以结构化 JSON 输出到 stdout（便于脚本与自动化集成）',
    '  -q, --quiet              静默 stderr 进度输出',
    '',
    '常用示例:',
    '  mediakiln list --group 图片',
    '  mediakiln info videoToGif',
    '  mediakiln run videoToGif demo.mp4 --start 1 --end 5 --fps 15 --width 640 -o out.gif',
    '  mediakiln run imageConvert *.png --format webp --quality high -o ./webp_out',
    '  mediakiln run pdfMerge a.pdf b.pdf -o merged.pdf',
    '  mediakiln probe demo.mp4 --json',
    '  mediakiln workflow list',
    '  mediakiln workflow run tpl_video_to_gif_pro -i demo.mp4 -o ./out',
    '',
  ].join('\n');
}

function renderToolInfo(schema) {
  const lines = [];
  const tags = [];
  if (schema.multi) tags.push('多文件合并');
  else if (schema.batch) tags.push('支持批量');
  else tags.push('单文件');

  lines.push(`${schema.featureId}  (${schema.name})  [${schema.group} · ${tags.join(' / ')}]`);
  lines.push(`说明: ${schema.desc}`);
  lines.push(`支持格式: ${schema.accept.map((e) => `.${e}`).join(', ')}`);
  lines.push('');

  if (schema.params.length) {
    lines.push('可用参数:');
    for (const p of schema.params) {
      const aliasText = p.aliases?.length ? ` (${p.aliases.join(', ')})` : '';
      const defStr = p.defaultValue === '' || p.defaultValue === undefined
        ? ''
        : (typeof p.defaultValue === 'object' ? JSON.stringify(p.defaultValue) : String(p.defaultValue));
      const defText = defStr !== '' ? ` [默认: ${defStr}]` : '';
      lines.push(`  ${p.flag}${aliasText}${defText}`);
      lines.push(`      ${p.label}`);
      if (p.options?.length) {
        const optList = p.options.map((o) => `${o.value}(${o.label})`).join(', ');
        lines.push(`      可选值: ${optList}`);
      }
    }
    lines.push('');
  } else {
    lines.push('可用参数: （无额外必填参数，直接传入输入文件即可）');
    lines.push('');
  }

  const sampleExt = schema.accept[0] || 'mp4';
  const sampleIn = schema.multi ? `a.${sampleExt} b.${sampleExt}` : `input.${sampleExt}`;
  lines.push('示例:');
  lines.push(`  mediakiln run ${schema.featureId} ${sampleIn} -o ./out`);
  return lines.join('\n') + '\n';
}

function renderWorkflowHelp() {
  return [
    '用法:',
    '  mediakiln workflow list [--json]',
    '  mediakiln workflow info <模板ID|工作流.json> [--json]',
    '  mediakiln workflow run <模板ID|工作流.json> [选项]',
    '',
    'workflow run 选项:',
    '  -i, --input <路径|节点ID=路径>  绑定输入文件、通配符或文件夹（可多次指定）',
    '  -o, --output <目录>             覆盖导出目标目录（同 --out-dir）',
    '  --param <节点ID.参数名=值>      动态覆盖任意节点参数（可多次指定，也支持 工具ID.参数名=值）',
    '  --target <节点ID>               仅运行至指定节点及其上游依赖',
    '  --suffix <后缀>                 为导出文件名追加后缀',
    '  --no-overwrite / --overwrite    防覆盖自动编号或覆盖同名文件',
    '  --hw <模式>                     硬件加速：cpu（默认）| auto | nvenc | qsv | amf',
    '  --cache-dir <目录>              指定持久化增量缓存目录（默认使用隔离临时目录并在结束时清理）',
    '  --json                          以 JSON 格式输出结果',
    '  -q, --quiet                     静默进度日志',
    '',
    '示例:',
    '  mediakiln workflow list',
    '  mediakiln workflow info tpl_video_to_gif_pro',
    '  mediakiln workflow run tpl_video_to_gif_pro -i demo.mp4 -o ./out --param compressGif.colors=64',
    '  mediakiln workflow run my-flow.json -i n1=clip.mp4 -i n2=bgm.mp3 -o ./out',
    '',
  ].join('\n');
}

function collectRunInputs(rawPatterns, acceptExts) {
  const expanded = expandInputGlobs(rawPatterns);
  const acceptSet = new Set((acceptExts || []).map((e) => {
    const lower = String(e).toLowerCase();
    return lower === 'jpeg' ? 'jpg' : lower;
  }));
  const allowAll = !acceptSet.size || acceptSet.has('*');

  const files = [];
  for (const p of expanded) {
    if (!fs.existsSync(p)) {
      throw new CliUsageError(`输入文件不存在：${p}`);
    }
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      const matched = fs.readdirSync(p, { withFileTypes: true })
        .filter((ent) => ent.isFile() && !ent.name.startsWith('.'))
        .map((ent) => path.join(p, ent.name))
        .filter((full) => {
          if (allowAll) return true;
          const ext = path.extname(full).slice(1).toLowerCase();
          return acceptSet.has(ext === 'jpeg' ? 'jpg' : ext);
        })
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      if (!matched.length) {
        throw new CliUsageError(`目录中未找到兼容格式的输入文件：${p}`);
      }
      files.push(...matched);
    } else {
      files.push(p);
    }
  }
  return files;
}

function resolveOutputTarget({ rawOutput, rawOutDir, rawOutMode, isBatchMultiTask }) {
  if (rawOutDir) {
    return {
      __outputMode: 'custom',
      __outputDir: path.resolve(rawOutDir),
      __explicitOutput: '',
    };
  }
  if (rawOutput) {
    const str = String(rawOutput).trim();
    const resolved = path.resolve(str);
    const endsWithSep = /[\\/]$/.test(str);
    const existsAsDir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
    const hasExt = Boolean(path.extname(resolved));

    if (isBatchMultiTask) {
      if (!endsWithSep && !existsAsDir && hasExt) {
        throw new CliUsageError(`批量处理多个文件时，-o/--output 必须是输出目录而非单个文件：${str}`);
      }
      return {
        __outputMode: 'custom',
        __outputDir: resolved,
        __explicitOutput: '',
      };
    }

    if (endsWithSep || existsAsDir || !hasExt) {
      return {
        __outputMode: 'custom',
        __outputDir: resolved,
        __explicitOutput: '',
      };
    }
    return {
      __outputMode: 'custom',
      __outputDir: path.dirname(resolved),
      __explicitOutput: resolved,
    };
  }

  const mode = rawOutMode || 'same';
  if (!['same', 'subdir', 'custom'].includes(mode)) {
    throw new CliUsageError(`无效的 --out-mode："${mode}"，可选值：same | subdir | custom`);
  }
  return {
    __outputMode: mode,
    __outputDir: '',
    __explicitOutput: '',
  };
}

function normalizeHwOption(raw) {
  const v = String(raw || 'cpu').trim().toLowerCase();
  const valid = new Set([
    'cpu', 'auto', 'nvenc', 'qsv', 'amf',
    'h264_nvenc', 'h264_qsv', 'h264_amf',
    'hevc_nvenc', 'hevc_qsv', 'hevc_amf',
    'av1_nvenc', 'av1_qsv', 'av1_amf',
  ]);
  if (!valid.has(v)) {
    throw new CliUsageError(`无效的 --hw 值："${raw}"，可选值：cpu | auto | nvenc | qsv | amf`);
  }
  return v;
}

function createProgressPrinter({ jsonMode, quiet }) {
  const enabled = !jsonMode && !quiet;
  const isTTY = Boolean(process.stderr.isTTY);
  let lastLineLen = 0;
  let lastPct = -1;

  return {
    log(msg) {
      if (!enabled) return;
      if (isTTY && lastLineLen > 0) {
        process.stderr.write('\r' + ' '.repeat(lastLineLen) + '\r');
        lastLineLen = 0;
      }
      process.stderr.write(`${msg}\n`);
      lastPct = -1;
    },
    progress(label, ratio) {
      if (!enabled) return;
      const pct = Math.max(0, Math.min(100, Math.round((Number(ratio) || 0) * 100)));
      if (pct === lastPct) return;
      lastPct = pct;
      if (isTTY) {
        const barLen = 20;
        const filled = Math.round((pct / 100) * barLen);
        const bar = '#'.repeat(filled) + '-'.repeat(barLen - filled);
        const text = `  [${bar}] ${String(pct).padStart(3)}% ${label}`;
        process.stderr.write('\r' + text.padEnd(lastLineLen, ' '));
        lastLineLen = text.length;
      }
    },
    finishLine() {
      if (!enabled || !isTTY || lastLineLen === 0) return;
      process.stderr.write('\r' + ' '.repeat(lastLineLen) + '\r');
      lastLineLen = 0;
      lastPct = -1;
    },
  };
}

function describeOutputSize(outputPath, outputType) {
  try {
    if (!outputPath || !fs.existsSync(outputPath)) return null;
    if (outputType === 'dir' || fs.statSync(outputPath).isDirectory()) {
      const count = fs.readdirSync(outputPath).filter((f) => !f.startsWith('.')).length;
      return { isDir: true, fileCount: count };
    }
    return { isDir: false, size: fs.statSync(outputPath).size };
  } catch {
    return null;
  }
}

async function handleListCommand(argv, catalog) {
  const parsed = parseArgv(argv, {
    booleanFlags: ['json', 'batch-only', 'multi-only', 'help'],
    shortMap: { g: 'group', s: 'search', h: 'help' },
  });
  if (parsed.get('help')) {
    process.stdout.write([
      '用法: mediakiln list [--group <分组>] [--search <关键词>] [--batch-only] [--multi-only] [--json]',
      `可用分组: ${catalog.groupOrder.join(', ')}`,
      '',
    ].join('\n'));
    return 0;
  }

  const groupFilter = parsed.get('group') ? String(parsed.get('group')).trim() : '';
  const search = parsed.get('search') ? String(parsed.get('search')).trim().toLowerCase() : '';
  const batchOnly = Boolean(parsed.get('batch-only'));
  const multiOnly = Boolean(parsed.get('multi-only'));
  const jsonMode = Boolean(parsed.get('json'));

  let list = catalog.features.map((f) => ({
    id: f.id,
    group: f.group,
    name: f.name,
    desc: f.desc,
    accept: f.accept,
    multi: !!f.multi,
    noBatch: !!f.noBatch,
    batch: !f.multi && !f.noBatch,
  }));

  if (groupFilter) {
    list = list.filter((f) => f.group.toLowerCase().includes(groupFilter.toLowerCase()));
  }
  if (search) {
    list = list.filter((f) => (
      f.id.toLowerCase().includes(search)
      || f.name.toLowerCase().includes(search)
      || f.desc.toLowerCase().includes(search)
      || f.accept.some((e) => e.toLowerCase().includes(search))
    ));
  }
  if (batchOnly) list = list.filter((f) => f.batch);
  if (multiOnly) list = list.filter((f) => f.multi);

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ total: list.length, features: list }, null, 2) + '\n');
    return 0;
  }

  if (!list.length) {
    process.stdout.write('未找到匹配的工具。\n');
    return 0;
  }

  const byGroup = new Map();
  for (const g of catalog.groupOrder) byGroup.set(g, []);
  for (const f of list) {
    if (!byGroup.has(f.group)) byGroup.set(f.group, []);
    byGroup.get(f.group).push(f);
  }

  const lines = [`共 ${list.length} 个工具：\n`];
  for (const [group, items] of byGroup.entries()) {
    if (!items.length) continue;
    lines.push(`[${group}] (${items.length})`);
    for (const f of items) {
      const modeTag = f.multi ? '[多文件]' : (f.batch ? '[批量]  ' : '[单文件]');
      lines.push(`  ${f.id.padEnd(22)} ${modeTag} ${f.name} — ${f.desc}`);
    }
    lines.push('');
  }
  lines.push('提示: 运行 mediakiln info <工具ID> 查看该工具的全部参数与示例。');
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

async function handleInfoCommand(argv, catalog) {
  const parsed = parseArgv(argv, {
    booleanFlags: ['json', 'help'],
    shortMap: { h: 'help' },
  });
  const toolQuery = parsed.positionals[0];
  if (!toolQuery || parsed.get('help')) {
    throw new CliUsageError('用法: mediakiln info <工具ID> [--json]');
  }
  const feature = findFeature(catalog, toolQuery);
  if (!feature) {
    const suggestions = suggestFeatures(catalog, toolQuery);
    const hint = suggestions.length
      ? `\n你可能想找：${suggestions.map((f) => `${f.id} (${f.name})`).join(', ')}`
      : '';
    throw new CliUsageError(`未知工具："${toolQuery}"${hint}`);
  }
  const def = catalog.registry.getDef(`feat.${feature.id}`);
  const schema = describeFeatureOptions(def, feature);

  if (parsed.get('json')) {
    const clean = {
      featureId: schema.featureId,
      name: schema.name,
      group: schema.group,
      desc: schema.desc,
      accept: schema.accept,
      multi: schema.multi,
      batch: schema.batch,
      params: schema.params.map((p) => ({
        key: p.key,
        flag: p.flag,
        aliases: p.aliases,
        kind: p.kind,
        label: p.label,
        defaultValue: p.defaultValue,
        ...(p.options ? { options: p.options } : {}),
      })),
    };
    process.stdout.write(JSON.stringify(clean, null, 2) + '\n');
    return 0;
  }

  process.stdout.write(renderToolInfo(schema));
  return 0;
}

async function handleProbeCommand(argv, ffmpeg) {
  const parsed = parseArgv(argv, {
    booleanFlags: ['json', 'help'],
    shortMap: { h: 'help' },
  });
  if (parsed.get('help') || !parsed.positionals.length) {
    throw new CliUsageError('用法: mediakiln probe <文件...> [--json]');
  }
  const files = expandInputGlobs(parsed.positionals);
  for (const f of files) {
    if (!fs.existsSync(f)) throw new CliUsageError(`文件不存在：${f}`);
  }

  const results = await mapConcurrent(files, 6, async (filePath) => {
    try {
      const info = await ffmpeg.probe(filePath);
      return { path: filePath, ok: true, info };
    } catch (err) {
      return { path: filePath, ok: false, error: err.message };
    }
  });

  if (parsed.get('json')) {
    process.stdout.write(JSON.stringify(results.length === 1 ? results[0] : results, null, 2) + '\n');
    return results.every((r) => r.ok) ? 0 : 1;
  }

  for (const r of results) {
    if (!r.ok) {
      process.stdout.write(`[失败] ${r.path}: ${r.error}\n`);
      continue;
    }
    const i = r.info;
    const attrs = [`大小 ${formatBytes(i.size)}`];
    if (i.width && i.height) attrs.push(`尺寸 ${i.width}x${i.height}`);
    if (i.duration > 0) attrs.push(`时长 ${formatDuration(i.duration)}`);
    if (i.fps > 0) attrs.push(`${i.fps} fps`);
    if (i.docType) attrs.push(`类型 ${i.docType}`);
    if (i.pageCount) attrs.push(`${i.pageCount} 页`);
    if (i.cueCount) attrs.push(`${i.cueCount} 条字幕 (${i.encoding || 'utf-8'})`);
    if (i.imageCount) attrs.push(`${i.imageCount} 张图`);
    if (i.videoCount) attrs.push(`${i.videoCount} 个视频`);
    if (i.hasAudio) attrs.push('含音频');
    if (i.hasSubtitles && !i.docType) attrs.push(`含 ${i.subCount} 轨字幕`);
    process.stdout.write(`${r.path}\n  ${attrs.join(' | ')}\n`);
  }
  return results.every((r) => r.ok) ? 0 : 1;
}

async function handleHwCommand(argv, ffmpeg) {
  const parsed = parseArgv(argv, {
    booleanFlags: ['json', 'help'],
    shortMap: { h: 'help' },
  });
  if (parsed.get('help')) {
    process.stdout.write('用法: mediakiln hw [--json]\n探测本机可用的视频硬件编码器。\n');
    return 0;
  }
  const hw = await ffmpeg.detectHwEncoders();
  if (parsed.get('json')) {
    process.stdout.write(JSON.stringify(hw, null, 2) + '\n');
    return 0;
  }
  if (!hw.available.length) {
    process.stdout.write('未检测到可用的 GPU 硬件编码器，将使用 CPU 编码。\n');
    return 0;
  }
  process.stdout.write([
    `可用硬件编码器 (${hw.available.length}): ${hw.available.join(', ')}`,
    `推荐 H.264: ${hw.primary || 'CPU (libx264)'}`,
    `推荐 HEVC : ${hw.primaryHevc || 'CPU (libx265)'}`,
    `推荐 AV1  : ${hw.primaryAv1 || 'CPU (libaom-av1)'}`,
    '',
  ].join('\n'));
  return 0;
}

async function handleRunCommand(argv, catalog, ffmpeg) {
  const GLOBAL_BOOL_FLAGS = ['no-overwrite', 'overwrite', 'json', 'quiet', 'continue-on-error', 'help'];
  const GLOBAL_MULTI_FLAGS = ['input', 'replace-file', 'replace-files'];
  const GLOBAL_OPTION_KEYS = new Set([
    'output', 'outdir', 'outmode', 'nooverwrite', 'overwrite',
    'hw', 'concurrency', 'paramsjson', 'continueonerror',
    'json', 'quiet', 'help', 'input',
  ]);

  const parsed = parseArgv(argv, {
    booleanFlags: GLOBAL_BOOL_FLAGS,
    multiFlags: GLOBAL_MULTI_FLAGS,
    shortMap: {
      o: 'output',
      i: 'input',
      c: 'concurrency',
      q: 'quiet',
      h: 'help',
    },
  });

  const toolQuery = parsed.positionals[0];
  if (!toolQuery) {
    throw new CliUsageError('用法: mediakiln run <工具ID> <输入文件...> [工具参数...] [通用选项]');
  }

  const feature = findFeature(catalog, toolQuery);
  if (!feature) {
    const suggestions = suggestFeatures(catalog, toolQuery);
    const hint = suggestions.length
      ? `\n你可能想找：${suggestions.map((f) => `${f.id} (${f.name})`).join(', ')}`
      : '';
    throw new CliUsageError(`未知工具："${toolQuery}"${hint}`);
  }

  const def = catalog.registry.getDef(`feat.${feature.id}`);
  const schema = describeFeatureOptions(def, feature);
  if (parsed.get('help')) {
    process.stdout.write(renderToolInfo(schema));
    return 0;
  }

  const rawInputs = [...parsed.getAll('input'), ...parsed.positionals.slice(1)];
  if (!rawInputs.length) {
    throw new CliUsageError(`请提供至少一个输入文件（运行 mediakiln info ${feature.id} 查看用法）`);
  }
  const inputFiles = collectRunInputs(rawInputs, feature.accept);
  if (!inputFiles.length) {
    throw new CliUsageError('未找到有效的输入文件');
  }

  const jsonMode = Boolean(parsed.get('json'));
  const quiet = Boolean(parsed.get('quiet'));
  const continueOnError = Boolean(parsed.get('continue-on-error'));
  const noOverwrite = parsed.has('overwrite')
    ? !parsed.get('overwrite')
    : Boolean(parsed.get('no-overwrite'));
  const hwAccel = normalizeHwOption(parsed.get('hw') || 'cpu');
  const paramsJson = parsed.get('params-json') ? String(parsed.get('params-json')) : '';
  const isBatchMultiTask = !feature.multi && inputFiles.length > 1;

  const outSettings = resolveOutputTarget({
    rawOutput: parsed.get('output'),
    rawOutDir: parsed.get('out-dir'),
    rawOutMode: parsed.get('out-mode'),
    isBatchMultiTask,
  });

  const rawToolOptions = parsed.options.filter((opt) => !GLOBAL_OPTION_KEYS.has(opt.norm));

  // 先做一次静态参数校验（即使尚未 probe，可提前发现拼写错误/无效枚举值；像素裁剪延后到 probe 后转换）
  const precheck = resolveToolNodeParams(schema, rawToolOptions, { paramsJson, deferCrop: true });

  // 预先探测辅助文件元信息（例如 pipSplit 的 second 视频是否含音频）
  const secondaryPayloads = {};
  for (const [portKey, secFile] of precheck.secondaryFiles.entries()) {
    let secInfo = {};
    try { secInfo = await ffmpeg.probe(secFile); } catch {}
    secondaryPayloads[portKey] = { paths: [secFile], infos: [secInfo] };
  }

  const printer = createProgressPrinter({ jsonMode, quiet });

  const buildGlobalParams = () => ({
    __outputMode: outSettings.__outputMode,
    __outputDir: outSettings.__outputDir,
    ...(outSettings.__explicitOutput ? { __explicitOutput: outSettings.__explicitOutput } : {}),
    __noOverwrite: noOverwrite,
    __hwAccel: hwAccel,
  });

  // 1. 多文件合并类工具（如 mergeVideos / audioMerge / imagesTo / imageStitch / imagesToPdf / pdfMerge）
  if (feature.multi) {
    const probed = await mapConcurrent(inputFiles, 6, async (p) => {
      try {
        return { path: p, info: await ffmpeg.probe(p) };
      } catch {
        return { path: p, info: {} };
      }
    });
    const resolved = resolveToolNodeParams(schema, rawToolOptions, {
      paramsJson,
      fileInfo: probed[0]?.info || {},
    });
    const node = { type: `feat.${feature.id}`, params: resolved.params };
    const taskParams = {
      ...catalog.registry.buildNodeTaskParams(node, probed[0], secondaryPayloads, probed),
      ...buildGlobalParams(),
    };

    const t0 = Date.now();
    printer.log(`[${feature.id}] 开始处理 ${inputFiles.length} 个文件...`);
    const taskId = `cli_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const result = await ffmpeg.executeTask(taskId, feature.id, taskParams, (ratio) => {
      printer.progress(`${feature.name} (${inputFiles.length} 文件)`, ratio);
    });
    printer.finishLine();

    const durationMs = Date.now() - t0;
    const outStat = describeOutputSize(result.output, result.outputType);
    const payload = {
      ok: true,
      feature: feature.id,
      inputs: inputFiles,
      output: result.output,
      outputType: result.outputType || 'file',
      ...(outStat?.size !== undefined ? { outputSize: outStat.size } : {}),
      ...(outStat?.fileCount !== undefined ? { fileCount: outStat.fileCount } : {}),
      ...(result.targetReached !== undefined ? { targetReached: result.targetReached } : {}),
      durationMs,
    };

    if (jsonMode) {
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    } else {
      const sizeText = outStat?.isDir
        ? `${outStat.fileCount} 个文件`
        : (outStat?.size !== undefined ? formatBytes(outStat.size) : '');
      process.stdout.write(`完成 (${(durationMs / 1000).toFixed(2)}s)${sizeText ? ` · ${sizeText}` : ''}\n${result.output}\n`);
    }
    return 0;
  }

  // 2. 单文件 / 批量多文件工具
  const defaultConcurrency = (feature.group === '图片' || feature.group === 'SVG') ? 3 : 1;
  const rawConc = parsed.get('concurrency');
  const concurrency = rawConc !== undefined
    ? Math.max(1, Math.min(8, parseInt(rawConc, 10) || 1))
    : defaultConcurrency;
  const actualConc = inputFiles.length > 1 ? Math.min(concurrency, inputFiles.length) : 1;

  const tAll = Date.now();
  if (inputFiles.length > 1) {
    printer.log(`[${feature.id}] 批量处理 ${inputFiles.length} 个文件（并发 ${actualConc}）...`);
  }

  let abortRemaining = false;
  const itemResults = new Array(inputFiles.length);

  await mapConcurrent(
    inputFiles.map((filePath, index) => ({ filePath, index })),
    actualConc,
    async ({ filePath, index }) => {
      if (abortRemaining) return;
      const t0 = Date.now();
      const baseName = path.basename(filePath);
      try {
        let info = {};
        try { info = await ffmpeg.probe(filePath); } catch {}
        const resolved = resolveToolNodeParams(schema, rawToolOptions, {
          paramsJson,
          fileInfo: info,
        });
        const node = { type: `feat.${feature.id}`, params: resolved.params };
        const taskParams = {
          ...catalog.registry.buildNodeTaskParams(node, { path: filePath, info }, secondaryPayloads, []),
          ...buildGlobalParams(),
          ...(inputFiles.length > 1 ? { __batchItem: true } : {}),
        };
        const taskId = `cli_${Date.now()}_${index}_${Math.floor(Math.random() * 1e6)}`;
        const result = await ffmpeg.executeTask(taskId, feature.id, taskParams, (ratio) => {
          if (actualConc === 1) {
            printer.progress(baseName, ratio);
          }
        });
        if (actualConc === 1) printer.finishLine();

        const durationMs = Date.now() - t0;
        const outStat = describeOutputSize(result.output, result.outputType);
        const summaryFields = {};
        if (result && typeof result === 'object') {
          for (const [k, v] of Object.entries(result)) {
            if (k.endsWith('Summary') && v !== undefined) summaryFields[k] = v;
          }
        }
        itemResults[index] = {
          ok: true,
          input: filePath,
          output: result.output,
          outputType: result.outputType || 'file',
          ...(outStat?.size !== undefined ? { outputSize: outStat.size } : {}),
          ...(outStat?.fileCount !== undefined ? { fileCount: outStat.fileCount } : {}),
          ...(result.targetReached !== undefined ? { targetReached: result.targetReached } : {}),
          ...summaryFields,
          durationMs,
        };
        if (inputFiles.length > 1) {
          printer.log(`  [${index + 1}/${inputFiles.length}] 完成 ${baseName} -> ${path.basename(result.output)} (${(durationMs / 1000).toFixed(2)}s)`);
        }
      } catch (err) {
        if (actualConc === 1) printer.finishLine();
        itemResults[index] = {
          ok: false,
          input: filePath,
          error: err.message,
          cancelled: err.message === '任务已取消',
          durationMs: Date.now() - t0,
        };
        if (inputFiles.length > 1) {
          printer.log(`  [${index + 1}/${inputFiles.length}] 失败 ${baseName}: ${err.message}`);
        }
        if (!continueOnError) {
          abortRemaining = true;
          if (err.message === '任务已取消') {
            ffmpeg.cancelAllTasks();
          }
          if (inputFiles.length === 1) throw err;
        }
      }
    },
  );

  const completed = itemResults.filter(Boolean);
  const succeeded = completed.filter((r) => r.ok);
  const failed = completed.filter((r) => !r.ok);
  const totalMs = Date.now() - tAll;

  if (inputFiles.length === 1) {
    const single = succeeded[0];
    const payload = {
      ...single,
      feature: feature.id,
    };
    if (jsonMode) {
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    } else {
      const sizeText = single.fileCount !== undefined
        ? `${single.fileCount} 个文件`
        : (single.outputSize !== undefined ? formatBytes(single.outputSize) : '');
      process.stdout.write(`完成 (${(single.durationMs / 1000).toFixed(2)}s)${sizeText ? ` · ${sizeText}` : ''}\n${single.output}\n`);
    }
    return 0;
  }

  const batchPayload = {
    ok: failed.length === 0 && succeeded.length === inputFiles.length,
    feature: feature.id,
    total: inputFiles.length,
    succeeded: succeeded.length,
    failed: failed.length,
    durationMs: totalMs,
    results: completed,
  };

  if (jsonMode) {
    process.stdout.write(JSON.stringify(batchPayload, null, 2) + '\n');
  } else {
    process.stdout.write(
      `批量处理结束：成功 ${succeeded.length}/${inputFiles.length}${failed.length ? `，失败 ${failed.length}` : ''}（耗时 ${(totalMs / 1000).toFixed(2)}s）\n`,
    );
    for (const r of succeeded) {
      process.stdout.write(`  OK  ${r.output}\n`);
    }
    for (const r of failed) {
      process.stdout.write(`  ERR ${r.input}: ${r.error}\n`);
    }
  }
  return failed.length === 0 && succeeded.length === inputFiles.length ? 0 : 1;
}

async function handleWorkflowCommand(argv, appRoot, catalog, ffmpeg, registerController) {
  const sub = argv[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    process.stdout.write(renderWorkflowHelp());
    return 0;
  }

  if (sub === 'list') {
    const parsed = parseArgv(argv.slice(1), { booleanFlags: ['json', 'help'], shortMap: { h: 'help' } });
    if (parsed.get('help')) {
      process.stdout.write('用法: mediakiln workflow list [--json]\n');
      return 0;
    }
    const items = catalog.templates.map((t, idx) => ({
      index: idx + 1,
      id: t.id,
      name: t.name,
      category: t.category,
      desc: t.desc,
      nodeCount: t.graph?.nodes?.length || 0,
      inputs: (t.graph?.nodes || [])
        .filter((n) => ['io.loadFile', 'io.loadBatch', 'io.loadFolder'].includes(n.type))
        .map((n) => ({ id: n.id, type: n.type })),
    }));
    if (parsed.get('json')) {
      process.stdout.write(JSON.stringify({ total: items.length, templates: items }, null, 2) + '\n');
      return 0;
    }
    const lines = [`内置工作流模板 (${items.length} 套)：\n`];
    for (const item of items) {
      lines.push(`  ${String(item.index)}. ${item.id.padEnd(26)} [${item.category}] ${item.name}`);
      lines.push(`     ${item.desc}`);
      lines.push(`     输入节点: ${item.inputs.map((x) => `${x.id}(${x.type})`).join(', ') || '无'}`);
    }
    lines.push('\n运行示例: mediakiln workflow run tpl_video_to_gif_pro -i demo.mp4 -o ./out');
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  }

  if (sub === 'info') {
    const parsed = parseArgv(argv.slice(1), { booleanFlags: ['json', 'help'], shortMap: { h: 'help' } });
    const target = parsed.positionals[0];
    if (!target || parsed.get('help')) {
      throw new CliUsageError('用法: mediakiln workflow info <模板ID|工作流.json> [--json]');
    }
    const resolved = resolveWorkflowGraph(catalog, target);
    const nodes = resolved.graph.nodes.map((n) => {
      const def = catalog.registry.getDef(n.type);
      return {
        id: n.id,
        type: n.type,
        name: def?.name || n.type,
        params: n.params || {},
      };
    });
    if (parsed.get('json')) {
      process.stdout.write(JSON.stringify({
        source: resolved.source,
        id: resolved.id,
        name: resolved.name,
        desc: resolved.desc,
        nodes,
        edges: resolved.graph.edges,
      }, null, 2) + '\n');
      return 0;
    }
    const lines = [
      `${resolved.name} (${resolved.id}) [${resolved.source === 'template' ? '内置模板' : resolved.sourcePath}]`,
      ...(resolved.desc ? [`说明: ${resolved.desc}`] : []),
      '',
      `节点列表 (${nodes.length}):`,
      ...nodes.map((n) => `  ${n.id.padEnd(6)} ${n.type.padEnd(24)} ${n.name}`),
      '',
    ];
    process.stdout.write(lines.join('\n'));
    return 0;
  }

  if (sub === 'run') {
    const parsed = parseArgv(argv.slice(1), {
      booleanFlags: ['no-overwrite', 'overwrite', 'json', 'quiet', 'help'],
      multiFlags: ['input', 'param'],
      shortMap: { i: 'input', o: 'output', p: 'param', q: 'quiet', h: 'help' },
    });
    if (parsed.get('help') || !parsed.positionals.length) {
      process.stdout.write(renderWorkflowHelp());
      return parsed.get('help') ? 0 : 2;
    }
    const target = parsed.positionals[0];
    const inputs = [...parsed.getAll('input'), ...parsed.positionals.slice(1)];
    const outDir = parsed.get('out-dir') || parsed.get('output') || '';
    const noOverwrite = parsed.has('overwrite')
      ? !parsed.get('overwrite')
      : (parsed.has('no-overwrite') ? Boolean(parsed.get('no-overwrite')) : null);
    const suffix = parsed.has('suffix') ? String(parsed.get('suffix')) : null;
    const hwAccel = normalizeHwOption(parsed.get('hw') || 'cpu');
    const cacheDir = parsed.get('cache-dir') ? String(parsed.get('cache-dir')) : '';
    const targetNodeId = parsed.get('target') ? String(parsed.get('target')) : null;
    const paramOverrides = parsed.getAll('param');
    const jsonMode = Boolean(parsed.get('json'));
    const quiet = Boolean(parsed.get('quiet'));

    const t0 = Date.now();
    const res = await runWorkflowCommand({
      appRoot,
      catalog,
      ffmpeg,
      target,
      inputs,
      outDir,
      noOverwrite,
      suffix,
      hwAccel,
      cacheDir,
      targetNodeId,
      paramOverrides,
      jsonMode,
      quiet,
      registerController,
    });
    const durationMs = Date.now() - t0;

    if (jsonMode) {
      process.stdout.write(JSON.stringify({ ...res, durationMs }, null, 2) + '\n');
    } else {
      process.stdout.write(
        `工作流完成 (${(durationMs / 1000).toFixed(2)}s)：执行 ${res.summary.executed} 个节点，导出 ${res.outputs.length} 个文件\n`,
      );
      for (const f of res.outputs) {
        process.stdout.write(`  ${f}\n`);
      }
    }
    return 0;
  }

  throw new CliUsageError(`未知 workflow 子命令："${sub}"（支持 list / info / run）`);
}

async function main(argv, { appRoot } = {}) {
  const root = path.resolve(appRoot || process.env.VGT_APP_ROOT || path.join(__dirname, '..', '..'));
  const pkg = readPackageMeta(root);
  const catalog = loadCliCatalog(root);
  const ffmpeg = require(path.join(root, 'ffmpeg.js'));

  const args = Array.isArray(argv) ? argv.slice() : [];
  const cmd = args[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(renderMainHelp(pkg, catalog));
    return 0;
  }

  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    const jsonMode = args.includes('--json');
    if (jsonMode) {
      process.stdout.write(JSON.stringify({
        name: pkg.build?.productName || 'MediaKiln',
        version: pkg.version,
        features: catalog.features.length,
        templates: catalog.templates.length,
      }, null, 2) + '\n');
    } else {
      process.stdout.write(`MediaKiln v${pkg.version}\n`);
    }
    return 0;
  }

  let activeWfController = null;
  let cancelledBySignal = false;
  const onSignal = () => {
    if (cancelledBySignal) return;
    cancelledBySignal = true;
    process.stderr.write('\n[MediaKiln] 收到中断信号，正在取消进行中的任务...\n');
    try { activeWfController?.cancel?.(); } catch {}
    try { ffmpeg.cancelAllTasks(); } catch {}
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const jsonRequested = args.includes('--json');

  try {
    let code = 0;
    const normCmd = normalizeKey(cmd);
    if (normCmd === 'list' || normCmd === 'ls') {
      code = await handleListCommand(args.slice(1), catalog);
    } else if (normCmd === 'info' || normCmd === 'describe') {
      code = await handleInfoCommand(args.slice(1), catalog);
    } else if (normCmd === 'probe') {
      code = await handleProbeCommand(args.slice(1), ffmpeg);
    } else if (normCmd === 'hw' || normCmd === 'hwaccel') {
      code = await handleHwCommand(args.slice(1), ffmpeg);
    } else if (normCmd === 'run') {
      code = await handleRunCommand(args.slice(1), catalog, ffmpeg);
    } else if (normCmd === 'workflow' || normCmd === 'wf') {
      code = await handleWorkflowCommand(args.slice(1), root, catalog, ffmpeg, (ctrl) => {
        activeWfController = ctrl;
      });
    } else if (findFeature(catalog, cmd)) {
      // 快捷写法：mediakiln <toolId> <inputs...>
      code = await handleRunCommand(args, catalog, ffmpeg);
    } else {
      const suggestions = suggestFeatures(catalog, cmd, 3);
      const hint = suggestions.length
        ? `\n你是不是想运行工具：${suggestions.map((f) => f.id).join(', ')}？`
        : '';
      throw new CliUsageError(`未知命令或工具："${cmd}"${hint}\n运行 mediakiln --help 查看全部用法。`);
    }
    return cancelledBySignal ? 130 : code;
  } catch (err) {
    if (cancelledBySignal || err?.message === '任务已取消' || err?.message === '工作流已取消') {
      if (jsonRequested) {
        process.stdout.write(JSON.stringify({ ok: false, cancelled: true, error: '任务已取消' }, null, 2) + '\n');
      } else {
        process.stderr.write('[MediaKiln] 任务已取消\n');
      }
      return 130;
    }
    const exitCode = typeof err?.exitCode === 'number' ? err.exitCode : 1;
    if (jsonRequested) {
      process.stdout.write(JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2) + '\n');
    } else {
      process.stderr.write(`[错误] ${err?.message || err}\n`);
    }
    return exitCode;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

module.exports = {
  main,
  CliUsageError,
};
