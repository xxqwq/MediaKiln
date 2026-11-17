# 官网（website/）

「视频 · GIF 工具箱」的产品官网，基于 [Astro](https://astro.build) 构建的纯静态站点，部署在 GitHub Pages。

## 本地开发

```bash
cd website
npm install
npm run dev        # http://localhost:4321/usefulTools/
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

## 部署（Cloudflare Pages）

官网托管在 Cloudflare Pages，构建在 Cloudflare 侧完成，**不依赖 GitHub Actions**。`astro.config.mjs` 会通过 Cloudflare 自动注入的 `CF_PAGES` 环境变量识别部署环境，并把站点路径切换到根路径 `/`。

### 方式一：关联 GitHub 仓库自动部署（推荐）

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/) → **Workers 和 Pages** → **创建** → **Pages** → **连接到 Git**，授权并选择 `xxqwq/usefulTools`。
2. 构建设置：

   | 项目 | 值 |
   |---|---|
   | 生产分支 | `main` |
   | 框架预设 | `Astro` |
   | 构建命令 | `npm run build` |
   | 构建输出目录 | `dist` |
   | 根目录（高级） | `website` |
   | 环境变量 | `NODE_VERSION` = `22`；`SITE_URL` = `https://<项目名>.pages.dev`（绑定自定义域名后改成正式域名） |

3. 保存并部署。之后每次推送到 `main` 都会自动重新构建，推送到其他分支会生成预览地址。

> 构建时脚本会读取上级目录的 `renderer/` 和 `package.json`。Cloudflare 会克隆整个仓库，所以设置根目录为 `website` 不影响读取。

### 方式二：本地一键上传

```bash
cd website
npm run deploy:cf     # 首次会打开浏览器登录 Cloudflare；默认项目名 video-gif-toolbox
```

可通过环境变量 `CF_PROJECT` 修改项目名，通过 `SITE_URL` 指定正式域名。

### 改回 GitHub Pages

`.github/workflows/pages.yml` 保留了 GitHub Pages 部署流程，目前只能手动触发。如需改用 GitHub Pages 自动部署，取消其中 `push` / `release` 触发器的注释，并在仓库 **Settings → Pages** 中将 Source 设为 **GitHub Actions** 即可。
