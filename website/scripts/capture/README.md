# 官网截图与对比素材生成

在仓库根目录运行（先关闭正在运行的工具箱）：

```powershell
node website\scripts\capture\prepare-media.cjs   # 仅当 media/src 源图更新时需要：重新生成演示视频/图片/文档
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
node_modules\electron\dist\electron.exe website\scripts\capture\capture.cjs
```

`capture.cjs` 复用真实 `main.js`（真实 IPC + FFmpeg），截图输出到 `website/public/screenshots/*.webp`，前后对比素材与 `meta.json` 输出到 `website/public/compare/`。
可选环境变量：`CAPTURE_ONLY=svg,cutout`（只跑部分步骤：video, gif, svg, cutout, replacebg, batch, doc, workflow；gif 依赖 video，batch 会用到 cutout/replacebg 的输出）、`CAPTURE_SCALE=1`、`CAPTURE_TMP=D:\temp\vgt-capture`（userData 与原始 PNG）、`CAPTURE_WORK=D:\演示素材`（演示素材工作目录，路径会出现在截图中；结束后自动删除，设 `CAPTURE_KEEP=1` 保留）。
