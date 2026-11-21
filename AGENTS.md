# 项目协作规则

## 功能改动同步官网与 README

- 新增、修改或下线桌面端功能、工作流节点/模板、测试脚本或代码结构时，在同一轮同步检查并更新 `README.md` 与 `website/`。
- `README.md` 需保持功能清单、数量统计（功能数/批量数/节点数/模板数）、开发测试命令及代码结构与源码一致。
- 官网的功能清单、数量和工作流模板沿用 `website/scripts/extract-app-data.mjs` 从应用源码生成。按需更新官网手写文案、截图和下载信息。
- 交付前运行 `npm run build --prefix website`，核对相关功能和链接。发布时核验线上页面并报告验证范围。

## 版本号与发布规范

- 公开测试阶段统一使用 `0.x.y` 版本号（Git Tag 与 GitHub Release 为 `v0.x.y`，标记为 Pre-release）；除非用户明确确认升至 `1.0.0+` 正式版，否则不得发布或创建非 `0.x.y` 的版本号、Tag 或 Release（避免误用 `-Bump major`）。
- 发版前必须核对 `package.json` 的 `version` 与 `shellVersion`、Git Tag、GitHub Release 标题/附件/更新日志链接、`hotfix-manifest.json` 及官网（`website/scripts/extract-app-data.mjs`）是否全部一致。
- 仅做业务热更新时递增 `version` 并保持 `shellVersion` 不变；涉及主进程/依赖/壳变更时同步递增 `shellVersion` 并发布完整安装包。
