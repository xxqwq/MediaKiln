# 项目协作规则

## 功能改动同步官网

- 新增、修改或下线桌面端功能时，在同一轮同步检查并更新 `website/`。
- 功能清单、数量和工作流模板沿用 `website/scripts/extract-app-data.mjs` 从应用源码生成。按需更新官网手写文案、截图和下载信息。
- 交付前运行 `npm run build --prefix website`，核对相关功能和链接。发布时核验线上页面并报告验证范围。
