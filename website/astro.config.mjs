// @ts-check
import { defineConfig } from 'astro/config';

// 站点默认部署在域名根路径 /，可直接用于 Vercel、腾讯云 EdgeOne Pages、Cloudflare Pages 等平台。
// - SITE_URL：正式访问地址（用于 canonical 和分享卡片），建议在部署平台的环境变量中设置
// - BASE_PATH：子路径部署时使用，例如 GitHub Pages 项目页为 /usefulTools（.github/workflows/pages.yml 会自动传入）
const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined;

const site = process.env.SITE_URL
  || vercelUrl
  || process.env.CF_PAGES_URL
  || 'https://xxqwq.github.io';
const base = process.env.BASE_PATH || '/';

export default defineConfig({
  site,
  base,
  trailingSlash: 'ignore',
  build: { inlineStylesheets: 'auto' },
  devToolbar: { enabled: false },
});
