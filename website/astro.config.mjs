// @ts-check
import { defineConfig } from 'astro/config';

// 部署目标自动识别：
// - Cloudflare Pages（构建时自动注入 CF_PAGES=1）：站点位于域名根路径 /
// - GitHub Pages 项目页：https://xxqwq.github.io/usefulTools/
// 也可通过环境变量 SITE_URL / BASE_PATH 显式覆盖（例如绑定自定义域名后 SITE_URL=https://example.com）
const isCloudflare = !!process.env.CF_PAGES;

const site = process.env.SITE_URL
  || (isCloudflare ? process.env.CF_PAGES_URL : undefined)
  || 'https://xxqwq.github.io';
const base = process.env.BASE_PATH || (isCloudflare ? '/' : '/usefulTools');

export default defineConfig({
  site,
  base,
  trailingSlash: 'ignore',
  build: { inlineStylesheets: 'auto' },
  devToolbar: { enabled: false },
});
