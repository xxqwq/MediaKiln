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
export const latestReleaseUrl = `${repoUrl}/releases/latest`;

/** 构建时获取到的最新已发布 Release（可能为 null） */
export const release = (appData as { latestRelease?: { tag: string; version: string; publishedAt?: string; assets: { name: string; size: number; url: string }[] } | null }).latestRelease || null;

/** 页面上展示的“可下载版本”：优先使用已发布的 Release，避免显示尚未发布的开发版本号 */
export const dlVersion = release?.version || app.version;

/** 下载直链：找到 Release 资源则直连，否则回退到 Releases 最新页（运行时脚本还会再次刷新） */
export const assetUrl = (kind: 'setup' | 'portable') =>
  release?.assets.find((a) => new RegExp(`-${kind}\\.exe$`, 'i').test(a.name))?.url || latestReleaseUrl;

export const assetName = (kind: 'setup' | 'portable') =>
  release?.assets.find((a) => new RegExp(`-${kind}\\.exe$`, 'i').test(a.name))?.name || `video-gif-toolbox-${dlVersion}-${kind}.exe`;

export const assetSize = (kind: 'setup' | 'portable') =>
  release?.assets.find((a) => new RegExp(`-${kind}\\.exe$`, 'i').test(a.name))?.size || 0;

export const fmtBytes = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`;
};
