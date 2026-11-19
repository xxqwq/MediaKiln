# 官网（website/）

「MediaKiln」的产品官网，基于 [Astro](https://astro.build) 构建的纯静态站点，主要托管于 **腾讯云 EdgeOne Pages**（兼容 Cloudflare Pages / Vercel / GitHub Pages）。

## 本地开发

```bash
cd website
npm install
npm run dev        # http://localhost:4321/
npm run build      # 输出到 website/dist
npm run preview    # 预览构建结果
```

## 数据来源（自动同步）

`npm run dev` / `npm run build` 会先执行 `scripts/extract-app-data.mjs`，直接从桌面应用源码中提取数据，生成 `src/data/app-data.json`：

| 官网内容 | 来源 |
|---|---|
| 功能清单、分类、批量标记 | `renderer/features/*.js` |
| 工作流节点数量、端口 | `renderer/workflow/node-registry.js` |
| 预设模板流程图 | `renderer/workflow/templates.js` |
| 版本号 | 根目录 `package.json` |

因此应用新增功能或模板后，官网无需手动修改。下载按钮在浏览器端还会请求 GitHub API，自动切换到最新 Release 的直链；请求失败时回退到构建时的版本号。

## 素材

| 目录 | 内容 |
|---|---|
| `public/screenshots/` | 真实软件截图（WebP），由 `scripts/capture/capture.cjs` 驱动 Electron 自动截取 |
| `public/compare/` | 处理前后对比素材与 `meta.json`，全部为本软件真实处理结果 |

重新截图见 [`scripts/capture/README.md`](scripts/capture/README.md)。素材文件不存在时，对应的板块会自动隐藏，不会出现破图。

`scripts/dev/shoot-site.cjs` 用来自检官网视觉效果：先启动 `npm run dev`，然后在仓库根目录执行 `node_modules\electron\dist\electron.exe website\scripts\dev\shoot-site.cjs`（可通过环境变量 `SHOOT_W=390` 截取移动端），截图输出到 `scripts/dev/shots/`。

## 部署（腾讯云 EdgeOne Pages，推荐）

官网默认构建为根路径 `/`，**不依赖 GitHub Actions**。`website/edgeone.json` 已配置好构建命令、输出目录、`Node 22.11.0` 以及安全/静态资源缓存响应头。

### 方式一：关联 GitHub 仓库自动部署（推荐）

1. 登录 [腾讯云 EdgeOne 控制台](https://console.cloud.tencent.com/edgeone/pages)，进入 **Pages** → **创建项目** → **连接 Git 仓库**，授权并选择 `xxqwq/usefulTools`。
2. 构建与基础配置：

   | 项目 | 值 |
   |---|---|
   | 生产分支 | `main` |
   | 加速区域 | **全球可用区（含中国大陆）**（域名已 ICP 备案即可选此项） |
   | 根目录（Root Directory） | `website` |
   | 框架预设 | `Astro` |
   | 构建命令 | `npm run build`（`edgeone.json` 已指定，保持默认或填此值） |
   | 输出目录 | `dist` |
   | Node.js 版本 | `22.11.0`（或控制台中的 `22.x`） |
   | 环境变量 | `SITE_URL` = `https://你的域名`（用于 `canonical` 与分享图地址） |

3. 部署成功后，进入项目 **域名管理 → 添加自定义域名**，填入你的已备案域名，按控制台指引配置 CNAME 解析并开启自动 HTTPS 证书。
4. 之后每次推送到 `main`，EdgeOne Pages 都会自动重新构建并刷新边缘缓存。

> **注意**：`根目录` 必须填写 `website`（仓库根目录的 `package.json` 是 Electron 主应用）；EdgeOne 会克隆整个仓库并切换到 `website` 执行构建，因此脚本可以正常读取上级目录的 `renderer/` 和根目录 `package.json`。

### 方式二：本地 CLI 一键部署

如果不希望关联 GitHub，也可以在本地直接通过腾讯云 EdgeOne CLI 部署（会自动按 `edgeone.json` 构建并上传）：

```bash
cd website
npm run deploy:eo     # 首次会自动打开浏览器登录腾讯云中国站；可通过 EO_PROJECT / SITE_URL 覆盖项目名和域名
```

---

## 其他可选部署方式

- **Vercel**：同样可连接 GitHub，根目录填 `website`，无需额外配置即可自动识别 Astro 并构建；`astro.config.mjs` 会自动读取 `VERCEL_PROJECT_PRODUCTION_URL`。
- **Cloudflare Pages**：根目录填 `website`、构建命令 `npm run build`、输出目录 `dist`、`NODE_VERSION=22`，响应头配置在 `public/_headers`；或本地执行 `npm run deploy:cf`。
- **GitHub Pages**：`.github/workflows/pages.yml` 目前保留为手动触发。如需改用 GitHub Pages 自动部署，取消其中 `push` / `release` 触发器的注释，并在仓库 **Settings → Pages** 中将 Source 设为 **GitHub Actions** 即可（构建时工作流会自动传入 `BASE_PATH`）。
