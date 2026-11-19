import fs from 'node:fs';
import path from 'node:path';
import appData from '../data/app-data.json';

export const data = appData;
export const app = appData.app;

const BASE = import.meta.env.BASE_URL.replace(/\/?$/, '/');

/** 拼接站点内资源路径（兼容 GitHub Pages 子路径） */
export const url = (p: string) => BASE + p.replace(/^\//, '');

const PUBLIC_DIR = path.resolve(process.cwd(), 'public');

/** 构建时判断 public/ 下素材是否存在，避免出现破图 */
export const hasAsset = (p: string) => fs.existsSync(path.join(PUBLIC_DIR, p));

/** 读取 public/ 下 JSON（不存在返回 fallback） */
export function readPublicJson<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, p), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export const repoUrl = `https://github.com/${app.repo}`;
export const releasesUrl = `${repoUrl}/releases`;

/** 构建时获取到的最新已发布 Release（可能为 null） */
export const release = (appData as {
  latestRelease?: {
    tag: string;
    version: string;
    publishedAt?: string;
    assets: { name: string; label?: string; size: number; url: string }[];
  } | null;
}).latestRelease || null;

/** 页面上展示的“可下载版本”：优先使用已发布的 Release，避免显示尚未发布的开发版本号 */
export const dlVersion = release?.version || (app as { shellVersion?: string }).shellVersion || app.version;

function findAsset(kind: 'setup' | 'portable') {
  const nameRe = kind === 'setup' ? /(-setup|安装版)\.exe$/i : /(-portable|便携版)\.exe$/i;
  const labelRe = kind === 'setup' ? /安装版/i : /便携版/i;
  return release?.assets.find((a) => nameRe.test(a.name) || labelRe.test(a.label || ''));
}

/** 下载直链：优先取 Release 资产直链，构建期离线/限流时回退到确定性的 GitHub 下载直链（运行时脚本还会再次刷新） */
export const assetUrl = (kind: 'setup' | 'portable') =>
  findAsset(kind)?.url || `https://github.com/${app.repo}/releases/download/v${dlVersion}/video-gif-toolbox-${dlVersion}-${kind}.exe`;

export const assetName = (kind: 'setup' | 'portable') =>
  findAsset(kind)?.label || findAsset(kind)?.name || `MediaKiln-${dlVersion}-${kind === 'setup' ? '安装版' : '便携版'}.exe`;

export const assetSize = (kind: 'setup' | 'portable') =>
  findAsset(kind)?.size || 0;

export const mirrorPrefixes = {
  official: '',
  ghproxy: 'https://gh-proxy.com/',
  ghfast: 'https://ghfast.top/',
} as const;

export const fmtBytes = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`;
};
