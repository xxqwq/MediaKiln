# MediaKiln

MediaKiln 是一款 Windows 本地离线多媒体与文档处理桌面应用，基于 Electron + FFmpeg 9.0.2。全部处理均在本机完成，无需联网、不上传任何文件；成品安装包与源码仓库均已内置 FFmpeg，开箱即用。

## 下载与使用

### 方式一：直接下载安装包（推荐）
当前提供 **0.x 公开测试版**。在 GitHub Releases 选择最新的 0.x 版本，可下载「安装版」或免安装的「便携版」。旧的 2.x 构建仍可从历史记录查看。 [下载公开测试版](https://github.com/xxqwq/MediaKiln/releases)

### 方式二：源码运行（需 Node.js 18+）
1. 克隆仓库或下载源码 ZIP 后解压。
2. 双击根目录 `启动工具箱.bat`（首次会自动执行 `npm install` 并解压内置 FFmpeg），或手动执行：
   ```bash
   npm install          # 自动安装依赖并从 bin/*.exe.br 解压内置 FFmpeg（建议国内环境配置 npmmirror / ELECTRON_MIRROR）
   npm start            # 启动应用（若 bin/*.exe 缺失，首次启动时也会自动解压还原）
   ```

---

## 核心特性

- **🛠️ 单工具模式 & 🕸️ 节点画布模式**：顶部/侧栏一键切换「单工具」快速处理与「节点画布」可视化工作流编排，支持参数面板一键「🕸️ 带参数入画布」、命名参数预设保存以及全局 `Ctrl+V` 粘贴剪贴板截图/文件。
- **🕸️ 节点画布工作流**：
  - 提供 **82 个节点**（9 个输入、输出与分流节点，加上 73 个功能节点）和 **7 套模板**。
  - 支持连接类型校验、**多分支 DAG 并行调度与并发 List-Map**、**文件夹递归扫描**、**按格式/条件多路分流**（含 PDF 专属路由、空分支自动跳过、多分支汇总导出）、**画布分组注释便签**、节点 Bypass 旁路跳过、**增量智能缓存**（自动容量与过期清理、支持自定义缓存目录）以及工作流 JSON 导入导出。
- **📦 批量队列处理**：**63 个功能**支持一次选择或拖入多个文件批量处理（图片/SVG 队列自动 3 路并发加速，支持随时 `+ 添加文件`、移除队列项、独立定位输出文件与中途取消）。
- **🔍 放大预览与对比**：处理完成后点击预览图或「⛶ 放大对比」，支持**并排同步缩放/平移**与**卷帘对比**（支持视频、GIF、位图与 SVG 矢量 vs 位图）。
- **⚡ 轻量级业务热更新**要求 Ed25519 发布签名，并用 SHA-256 校验下载与本地缓存。启动异常时回滚。客户端壳升级需要下载完整程序。
- **⚙️ 全局输出与硬件加速**：支持设置输出位置（源文件同目录 / `output` 子目录 / 自定义文件夹）、防覆盖自动编号，以及视频硬件编码加速（支持 **H.264 / H.265(HEVC) / AV1**，自动检测 NVIDIA NVENC / Intel QSV / AMD AMF 与 CPU 回退）。

---

## 功能清单（73 个，8 大类）

### 转换
| 功能 | 说明 |
|---|---|
| 🎞️ 视频转 GIF | 选时间段、帧率（最高 50 fps）、宽度、颜色数；调色板两遍编码，画质好 |
| 🎬 GIF 转视频 | 转 MP4（`yuv420p`，手机可播）或 WebM |
| 🖼️ WebP 动图 | 视频/GIF 转动画 WebP，比 GIF 小 30~50%，最高支持 60 fps |
| 📦 格式转换 | MP4 / MKV / MOV / WebM 互转，支持无损秒级换容器及 H.264 / H.265(HEVC) / AV1 编码 |

### GIF 编辑
| 功能 | 说明 |
|---|---|
| 🗜️ GIF 压缩 | 4 套一键预设（轻压/均衡/极限瘦身/微信表情包）、固定/百分比/自定义宽度与帧率（最高 50 fps）、6 种抖动、降噪、去重复帧（mpdecimate）、调色板模式、帧间差分、倍速与循环次数 |
| ✂️ GIF 截取 | 按时间段（带定格帧预览条）或帧序号精确截取 GIF 片段，自动保留透明背景与原画质 |
| 💬 GIF 加文字 | 打字幕、配梗文字（微软雅黑，支持任意中文与特殊字符） |
| 🎯 压缩到目标大小 | 视频（支持 H.264 / H.265 码率法一遍到位）或 GIF（最多 7 轮迭代），支持 1/2/5/10(Discord)/25(微信)/50MB 预设及自定义 0.2~500MB |
| 🪄 绿幕抠像透明 GIF | 抠除绿幕/蓝幕/纯色背景，支持容差与边缘羽化，生成透明底表情包 GIF |
| ✨ 进度条 / 圆角装饰 | 给 GIF 或视频添加顶部/底部播放进度条，或抗锯齿圆角边框（GIF 自动保留透明角） |
| 🧩 APNG / 雪碧图互转 | GIF 与 APNG 互转，按帧导出 PNG 雪碧图，或将雪碧图合成为 GIF / APNG |

### 图片
| 功能 | 说明 |
|---|---|
| 🖼️ 格式转换与压缩 | JPG / PNG / WebP / AVIF / BMP / ICO 互转，支持缩放、PNG 8-bit 调色板量化瘦身、透明转 JPG 自动垫底色、清除 EXIF |
| 🔍 图片 OCR 识字 | 离线识别截图和照片中的中英文，支持预览、复制和批量导出 UTF-8 TXT，使用 Windows 已安装的识别语言包 |
| 🎯 压缩到指定体积 (KB) | 二分搜索最佳画质并自适应缩图，精确压到 100KB / 200KB / 500KB / 1MB 等限制以内 |
| 🧩 长图拼接 / 拼图 | 多张图片纵向长图拼接、横向拼接或 2~4 列网格拼图（支持调序、间距与底色） |
| ✂️ 九宫格切图 / 长图切片 | 一键切为 `3×3` 九宫格 / `2×2` / `3×1` / `1×3`，或将超长图按段/高度切分导出 |
| 🪄 纯色抠图透明 PNG | 抠除白底、绿幕或纯色背景（支持吸管取色），导出透明底 PNG / WebP |
| 🎨 图片更换背景 | 一键抠除纯色底或直接复用透明图，更换纯色、渐变或自定义图片背景；支持以背景图原宽高为画布不裁剪及九方位摆位 |
| ⬜ 圆角与边框留白 | 为图片添加抗锯齿圆角（支持透明底）或相框外边距留白 |
| 🛍️ 电商主图 / 标准画布 | 按电商、社交平台或头像规格统一尺寸，支持留白、居中裁切和模糊背景 |

### SVG
| 功能 | 说明 |
|---|---|
| 📐 SVG 转位图 | 基于 Resvg 引擎（Worker 线程异步执行，可随时取消）将 SVG 高清渲染为 PNG / WebP / JPG / ICO / AVIF / BMP |
| ⚡ SVG 压缩优化 | 基于 SVGO 清理冗余元数据、注释、空组与多余小数位，保留矢量清晰度大幅瘦身 |
| ✒️ 图片转 SVG 矢量 | 基于轮廓描摹与色彩量化（ImageTracerJS + SVGO Worker 线程）将位图转为可无限放大的 SVG |

### 文档
| 功能 | 说明 |
|---|---|
| 🗜️ Word / PPT 一键压缩瘦身 | 自动识别 `.docx` / `.pptx` 内所有图片（含 PPT 内嵌视频），支持按指定章节/页或全篇并发原位压缩，完整保留文字与幻灯片排版 |
| 📑 Word / PPT / MD 提取图片 | 识别 `.docx` / `.pptx` 内嵌媒体和 `.md` 本地引用/Base64/内联 SVG/网络图片，支持按指定章节/页提取、选图替换（含剪贴板贴截图）与单张发给其他工具 |
| 📥 图片放回 Word / PPT 原位 | 将提取并修改/压缩/打码后的图片自动匹配放回原 `.docx` / `.pptx` 对应位置（默认保持原显示宽度按比例自适应高度防拉伸，并自动更新格式引用） |
| 🧹 Word / PPT 清理冗余与去重 | 深度扫描所有 XML 关系，一键移除未被引用的孤立隐藏媒体，并对重复嵌入图片按 SHA-256 去重重写关系瘦身 |
| ✨ Word / PPT 图片统一美化 | 一键为 `.docx` / `.pptx` 指定章节或全篇图片批量添加抗锯齿圆角、纯色边框或中文字体水印 |
| 📝 Markdown 图片整理 | 将 `.md` 中的网络图/本地图/Base64/内联 SVG 一键归拢至 `assets/` 并重写相对路径、全部内嵌为单文件 Base64，或安全清理资源子目录未使用图片 |
| 🖨️ MD / HTML 排版转 PDF | 离线导出 Markdown 和本地 HTML，支持 PDF 目录、代码高亮、表格与页码 |
| 📘 Word 转 PDF | 离线将 `.docx` / `.doc` 高清转换为矢量 PDF，智能优先调用本机 Office / WPS / LibreOffice 原生引擎并自动回退内置排版引擎（保留文本框/公式/表格/图片与大纲书签） |
| 📝 PDF 转 Word | 离线将 PDF 转为可编辑 `.docx`，自动重建可编辑表格 `<w:tbl>`、提取内嵌配图混排并识别双栏阅读顺序；扫描件自动启用 Windows 离线 OCR 中英文识别 |
| 🗜️ PDF 压缩瘦身 | 按画质档位或目标大小压缩并保留可选中文字，也可选择全页栅格化 |
| 🔍 扫描件转可搜索 PDF | 离线 OCR 为扫描页添加可搜索和复制的文字层，并保留页面画面 |
| ✂️ PDF 批量裁白边 | 预览自动检测的裁剪框，按指定边距批量裁去页边空白，保留文字和矢量内容 |
| 🔁 PDF 页面旋转 | 无损旋转 PDF 全部或指定页码范围（顺时针 90° / 逆时针 90° / 180°） |
| 🗂️ PDF 多页拼版 | 按 2 合 1 / 4 合 1 / 6 合 1 / 9 合 1 矢量拼版到 A4 纸张（智能匹配横竖向与边距框线） |
| 🏷️ PDF 水印与页码 | 为 PDF 批量叠加全屏斜向平铺/居中/角落中文水印，或添加页脚/页眉页码（支持跳过封面） |
| 📄 多图合并为 PDF | 将多张图片离线合成为单份 PDF 1.4 文档，支持 A4 竖向 / A4 横向 / 按每张图片原尺寸自适应与三档画质 |
| 🖼️ PDF 转图片 / 长图 | 基于系统原生渲染离线将 PDF 导出为逐页高清图片（PNG/JPG/WebP），或拼接为单张纵向长图（支持指定页码范围与倍率） |
| 📚 PDF 页面整理 / 合并 | 用缩略图拖拽重排、旋转、移除或恢复页面，也可以把多份 PDF 整理成一份 |
| ✂️ PDF 拆分 / 重排 | 按输入顺序提取或重排页面，例如 `3, 1-2`。也可删除指定页或按固定页数拆分 |

### 剪辑
| 功能 | 说明 |
|---|---|
| ✂️ 视频截取 | 无损模式秒级完成；精确模式重编码帧级对齐；支持播放器当前画面一键设为起止点 |
| 🎞️ 多段保留 / 删片段 | 标记多个时间段，支持保留拼接或删掉中间广告片段（无损极速 / 精确重编码） |
| 🔪 智能切分长视频 | 按固定时长切片或均匀切分成 N 段，导出到文件夹 |
| 🔗 视频合并 | 支持无损极速拼接（同规格）、兼容拼接（自动统一分辨率）与转场拼接（交叉叠化/黑场白场过渡/推拉/擦除等 `xfade` 声画转场） |
| 🔲 画面裁剪 | 预览图上拖框选区，所见即所得（视频 / GIF / 图片通用） |
| 🧲 自动去黑边 | 多点采样自动检测视频/GIF 上下左右黑边并一键裁除（支持批量） |
| 🫥 局部打码 / 去台标 | 预览图拖框遮挡水印、人脸或隐私，支持高斯模糊、像素马赛克与去固定台标（视频 / GIF / 图片通用） |
| 📐 横竖屏比例适配 | 一键转 `9:16` / `16:9` / `1:1` / `4:3` / `3:4`，支持高斯模糊背景填充或纯色底（视频 / GIF / 图片通用） |
| 🪟 分屏对比 / 画中画 | 两个视频/GIF 左右/上下并排对比，或叠加角落画中画小窗，音源可选 |
| 🎨 调色微调与防抖 | 亮度、对比度、饱和度、锐化（unsharp）与轻量画面防抖（deshake），调色功能视频/GIF/图片通用 |
| 🎭 一键画面滤镜 | 电影青橙、复古胶片、日系清新、温暖阳光、清冷蓝调、高反差黑白、鲜明通透预设与四周暗角（视频 / GIF / 图片通用） |
| 🌓 视频淡入淡出 | 片头黑/白场渐入、片尾渐出，支持音画同步淡入淡出（支持视频与 GIF） |
| 🔤 视频加标题字幕 | 胶囊底条、描边立体字、电影上下黑边标题、顶部醒目标题栏，支持中文换行与全程/片头前3秒/自定义时段显示 |
| 🔁 旋转 / 翻转 | 90°/180°/镜像，视频 / GIF / 图片都支持 |
| ◀️ 倒放 / 往复 | 倒放，或"正放+倒放"boomerang 循环 |
| ⚡ 变速 | 0.25x ~ 4x，画面 setpts + 音频 atempo 级联，声画同步 |

### 音频
| 功能 | 说明 |
|---|---|
| 🎵 提取音频 | 存为 MP3 / M4A / WAV |
| 🎚️ 音频格式转换 | MP3、M4A、WAV、FLAC、OGG、OPUS 互转，可调码率、采样率和声道 |
| ✂️ 音频截取 | 选时段后无损截取，或精确截取并调整淡入、淡出和音量 |
| 🔗 音频合并拼接 | 按顺序拼接多段音频，可用交叉淡入淡出衔接 |
| 🔊 音频调整 | 静音、调音量、淡入淡出、人声降噪（highpass + afftdn）、EBU R128 响度标准化（画面不重编码） |
| 🎼 添加背景音乐 | 替换原声或混合，支持人声出现时自动压低配乐 |
| 🎧 自动去静音 / 剪气口 | 自动识别口播/网课/会议录音录像中的停顿与静音片段并精准剪除，保持声画同步自然 |

### 工具
| 功能 | 说明 |
|---|---|
| 🏷️ 添加水印 | 支持单点或全屏平铺文字和图片水印，可调角度、密度和透明度 |
| 📷 设置视频封面 | 从画面取帧或选择图片，嵌入视频封面，保留原音视频流 |
| 💬 硬字幕压制 / 提取 | 导入 `.srt`/`.ass`/`.vtt` 烧录进画面，或提取视频内嵌字幕为 `.srt` |
| 🔄 字幕转换与同步 | SRT / VTT / ASS 互转与导出纯文本台词，支持时间轴整体偏移校正、清理标签与 GBK 自动转 UTF-8 |
| 📸 视频截图 / 拆帧 | 单帧截图（PNG/JPG，支持取当前播放时间）、按间隔导出，或逐帧无损拆解全部原始帧 |
| 🗂️ 九宫格预览墙 | 均匀抽帧拼成 `2×2` / `3×3` / `4×4` / `5×4` 缩略图概览墙（可选时间戳角标） |
| 🛡️ 清除隐私元数据 | 无损剥离视频/音频/图片中的设备型号、GPS 定位等 EXIF/Metadata |
| 🎞️ 图片合成视频 | 多张图片（可不同尺寸）合成 GIF 或 MP4，自动黑边居中对齐 |

---

## 开发与测试

```bash
npm install                              # 安装依赖并自动从 bin/*.exe.br 解压 FFmpeg
npm start                                # 启动 Electron 应用
node scripts/smoke-test.js               # 冒烟测试（自动生成素材，覆盖主要媒体与文档功能）
node scripts/workflow-test.js            # 工作流引擎与真实媒体/PDF 流水线端到端测试（15 项）
node scripts/hotfix-test.js              # 热更新打包、SHA-256 + Ed25519 签名校验与崩溃回滚测试（8 项）
node scripts/architecture-safety-test.js # 缓存隔离、路径安全与并发执行器校验
node scripts/pdf-crop-test.js            # PDF 裁白边（旋转页/已有裁剪框/空白页/取消）测试
node scripts/pdf-nup-test.js             # PDF 多页拼版（旋转页/智能横竖向/边界/取消）测试
node scripts/subtitle-test.js            # 字幕互转、时间轴偏移、编码识别与取消测试
node scripts/media-practical-test.js     # GIF/WebP/APNG 高帧率与去台标（delogo）实测
node scripts/pdf-target-size-test.js     # PDF 目标大小压缩测试
node scripts/pdf-searchable-test.js      # PDF 扫描件离线 OCR 可搜索文字层测试
node scripts/image-ocr-test.js           # 图片中英文识别、批量导出、空白图和取消测试
npm run build --prefix website           # 提取最新功能/节点/模板数据并构建官网静态站点
npm run hotfix:build                     # 仅生成几百 KB 的热更新包与清单到 release/
npm run dist                             # 打包便携版 + 安装版到 release/
npm run release                          # 一键发布（支持 -Bump patch/minor/major 与 -HotfixOnly）
```

签名构建从 `VGT_HOTFIX_PRIVATE_KEY` 读取私钥文件路径或私钥内容。发布包使用与客户端内置公钥匹配的 Ed25519 私钥。

> 若在无头环境下运行 Electron UI 自检（`scripts/workflow-ui-check.js`），请先清空环境变量 `ELECTRON_RUN_AS_NODE` 后再用 `node_modules\electron\dist\electron.exe scripts\workflow-ui-check.js` 启动。

## 代码结构

```
main.js                 Electron 主进程：窗口越界防护、热更新加载调度、剪贴板读取、工作流缓存磁盘检测与自动清理
ffmpeg.js               统一门面：组合 core 与 modules，保持 IPC 调用接口兼容
启动工具箱.bat          Windows 源码一键启动脚本（自动清理 ELECTRON_RUN_AS_NODE 并在缺依赖时安装）
core/
  ├── hotfix.js         业务热更新管理器：镜像拉取、Ed25519 签名 + SHA-256 与路径穿越校验、崩溃自回滚
  ├── file-filters.js   文件选择过滤器与单/多选规则（支持随热更新同步新增功能）
  ├── ffmpeg-bin.js     内置 FFmpeg 路径解析、Brotli 自动解压与 SHA-256 校验
  ├── runner.js         ffprobe / ffmpeg / SVG / PDF / 文档探测与 AsyncLocalStorage 并发安全执行器
  ├── md-renderer.js    Markdown / HTML 离线排版引擎（目录、代码高亮、表格与页码导出）
  ├── pdf-engine.js     零依赖离线 PDF 引擎（WinRT 高清渲染 + 纯 Node XRef/ObjStm 无损合并与拆分）
  ├── pdf-office.js     离线 Word ↔ PDF 互转（DOCX/PDF 解析 + WinRT OCR）与 PDF 压缩/旋转/水印页码引擎
  ├── pdf-crop.js       PDF 留白检测、裁剪框预览与批量裁白边引擎
  ├── pdf-nup.js        PDF 矢量多页拼版（2/4/6/9 合 1）与智能横竖版匹配引擎
  ├── pdf-searchable.js PDF 扫描件离线 OCR 可搜索文字层合成引擎
  ├── subtitle.js       字幕解析（SRT/VTT/ASS/SSA）、GBK/UTF-16 自动转码与时间轴同步引擎
  ├── image-ocr.js      图片和 PDF 共用的 Windows 离线文字识别
  ├── svg-worker.js     SVG 渲染 / 压缩 / 位图矢量化 Worker 子线程（不阻塞主进程且支持立即取消）
  ├── doc-parser.js     DOCX / PPTX / MD 媒体解析、冗余关系扫描与提取
  ├── doc-replacements.js DOCX / PPTX 图片替换回填规则、Manifest 匹配与指纹校验
  ├── workflow-cache.js 工作流节点隔离缓存目录分配、所有权标记与安全清理
  └── utils.js          动态系统字体探测、滤镜拼装、并发池 mapConcurrent、GIF 调色板与 PGM 遮罩工具
modules/                功能实现：video.js、image.js、svg.js、document.js
preload.js              contextBridge 安全桥接（含安全 toFileUrl 编码与 webUtils.getPathForFile 拖拽路径获取）
renderer/
  ├── app.js            单工具主界面、并发批量队列、全局 Ctrl+V 粘贴与工作流桥接
  ├── features/         73 个功能注册表（video-gif.js、image.js、svg.js、document.js）
  ├── ui/               参数面板（含命名预设与带参数入画布）、裁剪画布、放大对比弹窗、PDF 工具面板、热更新弹窗
  └── workflow/         节点画布、并行 DAG 执行引擎、82 个节点与 7 套模板
bin/                    内置 FFmpeg 9.0.2（gyan.dev）：仓库内置 .br 压缩包（每件 ~28MB）与 binaries.json；安装/启动自动解压，打包时经 extraResources 释放
scripts/                ensure-ffmpeg.js、build-hotfix.js、hotfix-test.js、architecture-safety-test.js、pdf-crop-test.js、pdf-nup-test.js、subtitle-test.js、media-practical-test.js、pdf-target-size-test.js、pdf-searchable-test.js、image-ocr-test.js、smoke-test.js、workflow-test.js、workflow-ui-check.js、webp-check.js、release.ps1
website/                产品官网（Astro 静态站点，构建时自动读取功能/节点/模板注册表；见 website/README.md）
```

## 技术备注

- **为什么自带 FFmpeg 9.0.2 而不用 `ffmpeg-static`**：后者内置的 FFmpeg 6.1 存在动画 WebP 编码缺陷（输出文件损坏，Chromium 也无法解码），且 9.0 对 filtergraph 引号解析更严格。项目已针对 9.0 适配：GIF 加文字走 `textfile`（免疫特殊字符）、字幕烧录走 ASCII 临时副本（规避 Windows 盘符与中文路径转义坑）、圆角装饰用 JS 生成抗锯齿 PGM 遮罩叠加（比逐像素 `geq` 快数十倍）。
- **如何解决 GitHub 100 MB 单文件限制**：`ffmpeg.exe` 与 `ffprobe.exe` 原始体积各约 100.5 MB，仓库内以 Brotli 压缩包（[ffmpeg.exe.br](bin/ffmpeg.exe.br) 约 28.3 MB、[ffprobe.exe.br](bin/ffprobe.exe.br) 约 28.2 MB）+ [binaries.json](bin/binaries.json) 形式保存；`npm install` 或应用启动时本地秒级解压并校验完整性，打包成品仅复制最终 `.exe` 至 `resources/bin/`。
- **无损截取策略**：使用输出端 seek（`-i` 在 `-ss` 前），时长精确；起点若不在关键帧，个别播放器开头可能短暂定格，需要完美开头建议使用「精确」模式。
- **目标大小压缩策略**：视频按 `duration` 反推码率（含 5% 容器开销余量）；GIF 为迭代降参（宽度/帧率/颜色/抖动逐级收紧，最多 7 轮），极复杂的动画可能压不到极小目标，会保留体积最小一轮的结果并提示。
