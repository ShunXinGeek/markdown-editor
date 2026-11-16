<div align="center">

# Markdown 编辑器

一款在浏览器里「即开即用」的 Markdown 写作工具。<br>
**无安装、无账号、无订阅，你的文字只属于你。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)[![纯前端](https://img.shields.io/badge/Architecture-Pure%20Frontend-success)](./markdown-editor.html)[![多语言](https://img.shields.io/badge/I18N-10%20Languages-orange)](./i18n.js)

</div>

---

## 🌟 为什么做这个工具？

AI 时代，Markdown 这件事，本该足够简单。

作为一个喜欢死磕 Prompt、Agent、Skills 的 Vibe Coding 开发者，我用过太多的 Markdown 工具：有的太重，有的订阅太贵，有的动不动就云端同步你的内容。我只想打开浏览器，输入文字，看到排版，然后把它带走。

于是有了这个编辑器。

下载项目并保留 HTML 及配套资源，双击 HTML 即可开始写作。草稿保存在当前浏览器，断网仍可编辑、预览基础 Markdown 和导出原文。它几乎支持 Codex、Claude Code、Openclaw 等市面上所有的 Agent，无论是 AGENTS.md 还是 Skill.md，你都可以通过它完成设计。

> 如果你也相信：AI 时代，markdown 就是第一语言。欢迎你来用、来改、来 Star。

---

## ✨ 功能特性

### 🚀 即开即用，极简使用

- 双击 `markdown-editor.html` 即可运行，需保留相邻 JavaScript 文件和 `vendor/` 目录。
- 基础编辑和预览随页面发布。公式、Mermaid、Word 和 PNG 使用按需加载的资源。未缓存时需要联网。

### 🖊️ 完整的 Markdown 体验
- **拖拽导入**：直接把文件拖进来。
- **实时预览**：左侧写作，右侧同步预览。
- **双栏/单栏/纯预览布局**：支持「编辑 + 预览」「仅编辑」「仅预览」三种模式，自由切换。
- **源码模式**：右侧也可直接编辑 Markdown 源码，与左侧共享正文。
- **拖拽分栏**：拖动中间分隔线调整编辑区与预览区比例，位置自动记忆。

### 🛠️ 丰富的编辑工具

| 功能 | 说明 |
|------|------|
| 标题 | H1-H6 快速插入 |
| 文本样式 | 加粗、斜体、下划线、删除线、上标、下标 |
| 列表 | 无序列表、有序列表、任务列表 |
| 引用与代码 | 引用块、行内代码、代码块 |
| 链接与图片 | 支持 URL 插入与本地图片 Base64 嵌入 |
| 表格 | 可视化 8×8 表格选择器 |
| 查找替换 | 支持查找下一个、替换、全部替换 |

### 🌐 多语言支持（10 种语言）

内置 `i18n.js`，支持：**简体中文、繁体中文、English、日本語、한국어、Español、Français、Deutsch、Русский、Português**。

语言状态会持久化到 `localStorage`，下次打开自动沿用。

### 🎨 深色 / 浅色主题

- 一键切换深色/浅色模式，主题偏好自动保存。
- 所有颜色使用 CSS 变量定义，扩展或覆盖都非常方便。

### 💾 本地自动保存

- 编辑暂停后自动保存。点击「保存」或按 Ctrl+S 可立即提交。
- HTTP(S) 页面优先将正文、文件名和修订号保存到 IndexedDB。旧草稿首次打开时迁移，原记录作为回退保留。直接打开文件或 IndexedDB 不可用时，使用浏览器提供的本地存储。
- 遇到配额、权限或标签页冲突时，状态栏会提示。可以通过「导出 Markdown」下载当前稿，再处理冲突或刷新。
- 浏览器配置、站点地址或打开方式不同，草稿存储空间也可能不同。换地址或设备前请导出重要文档。

### 📤 多格式导出

| 格式 | 说明 |
|------|------|
| `.md` | 原始 Markdown 文件 |
| `.html` | 独立 HTML 文件，可直接在浏览器打开 |
| `.docx` | Word 文档（可直接在 office 里打开） |
| `.pdf` | 调用浏览器，打印为 PDF |
| `.png` | 长图导出，支持 9:16、4:5、3:4、1:1、16:9 多种比例，适合小红书、公众号、Instagram 分享 |

### ⌨️ 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl + S` | 保存 |
| `Ctrl + Z` | 撤销 |
| `Ctrl + Y` / `Ctrl + Shift + Z` | 重做 |
| `Ctrl + B` | 加粗 |
| `Ctrl + I` | 斜体 |
| `Ctrl + U` | 下划线 |
| `Ctrl + K` | 插入链接 |
| `Ctrl + Shift + K` | 插入图片 |
| `Ctrl + F` | 查找替换 |
| `Tab` | 插入 4 空格缩进。按 Esc 后再按 Tab 可离开编辑区 |

---

## 🛠️ 技术架构

### 技术栈

- **纯原生前端**：HTML5 + CSS3 + Vanilla JavaScript，无框架依赖。
- **Markdown 渲染**：`marked.js`
- **数学公式**：`KaTeX`（支持 `$...$` 行内公式和 `$$...$$` 块级公式）
- **图表渲染**：`Mermaid 10`支持思维导图和流程图
- **图片导出**：`dom-to-image-more`
- **本地代理**：`Python 3` + `http.server`（可选，用于网页转 Markdown）

### 核心设计

```
┌─────────────────────────────────────────────────────────────┐
│                    markdown-editor.html                      │
│  ┌──────────────┐         ┌──────────────┐                  │
│  │  Editor      │  同步   │  Preview     │                  │
│  │  (textarea)  │ ──────▶ │  (marked.js) │                  │
│  └──────────────┘         └──────────────┘                  │
│         │                         │                         │
│         ▼                         ▼                         │
│   localStorage               KaTeX / Mermaid               │
│         │                         │                         │
│         ▼                         ▼                         │
│   自动保存 / 状态恢复        公式 / 图表渲染               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                   web-to-md-proxy.py (可选)
                    经配对的公开网页抓取
```
---

## 📁 项目结构

```
.
├── markdown-editor.html    # 主编辑器
├── i18n.js                 # 多语言字典（10 种语言）
├── draft-storage.js       # 草稿迁移与存储
├── render-content.js      # Markdown 净化、公式和图表预处理
├── vendor/                # 随站点发布的核心依赖、许可证和校验值
├── build-static.py        # 组装静态站点发布目录
├── web-to-md-proxy.py      # 本地代理脚本（可选）
├── LICENSE                 # MIT 开源协议
└── README.md               # 本文件
```

---

## 🚀 快速开始

### 方式一：直接打开（最简单）

```bash
# 克隆项目
git clone <your-repo-url>

# 直接双击打开
markdown-editor.html
```

### 方式二：本地服务器（推荐）

```bash
cd markdown-editor

# Python 3
python -m http.server 8080

# 或 Node.js
npx serve .

# 打开浏览器访问
open http://localhost:8080/markdown-editor.html
```

### 方式三：使用本地代理（网页转 Markdown）

```bash
# 仅需 Python 3，默认监听 127.0.0.1:8765
python web-to-md-proxy.py

# 托管版或不同本地端口，额外允许编辑器的准确来源
python web-to-md-proxy.py --origin https://你的编辑器域名
```

---

勾选「使用本地代理」，粘贴终端显示的本次配对令牌。默认允许双击打开的编辑器及本机 8080 端口的静态页面。令牌重启后更新，网页抓取限于公开 HTTP(S) 地址。也可以在同一弹窗直接粘贴网页 HTML。使用公共代理时，编辑器会先显示要发送的完整网址和服务商并请求确认。

### 生成静态发布产物

运行 `python build-static.py`。脚本核对所附依赖的完整性，并将运行文件、许可证及安全响应头写入 `dist/`。Netlify 从该目录发布，首页重写至编辑器。可运行 `python -m http.server 8080 --directory dist` 后访问 `http://127.0.0.1:8080/markdown-editor.html` 检查产物。

Netlify 项目 `md-editor-app` 以 GitHub 仓库 `ShunXinGeek/markdown-editor` 的 `master` 为生产分支。推送到该分支会触发生产构建，构建成功后自动发布。

---

## 整理编号

在 [Netlify 网页版](https://md-editor-app.netlify.app/) 打开「模型设置」，选择供应商，填写个人 API Key 和支持 JSON 对象输出的模型 ID，再测试连接并保存。测试及分析由本站的 `/api/numbering` 转发给供应商，密钥仅保存在当前浏览器标签页的会话中。网页端支持预填的供应商地址。部署者可在 Netlify 的函数运行环境中用 `MARKDOWN_NUMBERING_ALLOWED_BASE_URLS` 配置其他可信的 HTTPS Base URL，多个地址用英文逗号分隔。

本机编号服务使用兼容 Chat Completions 的模型接口。先构建并启动服务：

```powershell
python build-static.py
python numbering-model.py
```

从终端显示的回环地址打开编辑器（默认 `http://127.0.0.1:8080/`）。在「模型设置」选择供应商，确认自动填入的 Base URL，输入 API Key 和支持 JSON 对象输出的模型 ID，再测试连接并保存。密钥仅保存在当前浏览器标签页的会话中。选「自定义」可填写其他兼容地址，回环地址上的模型可使用 HTTP 和空密钥。

已有服务端配置可选「使用服务端默认配置」，继续使用 `MARKDOWN_NUMBERING_MODEL`、`MARKDOWN_NUMBERING_API_KEY` 和 `MARKDOWN_NUMBERING_API_URL`。此模式使用 JSON Schema 结构化输出，环境变量中的 API 地址填写完整的 `/chat/completions` 地址。

可在「模型设置」的「编号选项」中编辑提示词。点击「整理编号」，确认发送范围后在右侧查看完整文档。展开「编号建议」可按列表层级调整样式和待确认项。「应用编号」把结果写入草稿。同一份草稿内容仍与应用结果一致时，可点击「撤回」恢复应用前的内容。使用者可从「导出」菜单手动把右侧修正预览导出为 Word 或 PDF。

候选项超过单批上限时，编辑器自动分批分析。网页版每批最多 40 处，本机版每批最多 240 处。后续批次会带上前面的列表层级，全部完成后生成整篇编号预览。模型分析只接收编号、结构线索和候选项的有限摘录。已有编号结果随草稿保存，编辑器可以在离线时继续渲染这些结果。

## 本地文档、离线包与导出

- 「恢复点」保留最近 10 个版本，另有 16 MiB 的单文档历史预算。可预览、下载或恢复为新修订。出现标签页冲突时可下载两份内容。
- 「文档」可新建、切换、按标题、标签或正文搜索，以及导出和恢复整个本地工作区。还原遇到同一 ID 时保留副本。
- 默认的 Markdown 下载会嵌入本地图片。「正文和附件 ZIP」将图片单独打包。导入此 ZIP 时校验附件内容。旧版内嵌图片仍可打开，也可从「恢复点」提取为附件。
- 从导出菜单下载离线包并解压。直接打开 HTML 可离线编辑、渲染公式和 Mermaid。需持久保存多个文档和附件时，请在解包目录运行 `python -m http.server 8080`，并通过 `http://localhost:8080/markdown-editor.html` 打开。Word 与 PNG 的可选导出库仍按需加载。
- 左侧显示 Markdown 源码行号。预览中的各级列表统一左对齐，默认使用小四号字。长文会合并相邻的预览任务，也可手动暂停预览。
- 「导出版式」控制 Word 和 PDF 的纸张与页边距。PDF 的最终设置可由浏览器打印界面调整。PNG 支持按预设页高分片，多个分片以按顺序编号的 ZIP 下载。

## 回归测试

安装 Node.js 24 和 Python 3.13，然后运行：

```sh
npm ci
npx playwright install chromium firefox
npm run test:release
```

Linux CI 额外安装浏览器系统依赖。测试使用临时浏览器上下文和本地代理样例，构建到 `dist/` 并检查 CSP、依赖校验值、五种导出及草稿、离线、附件、工作区和键盘行为。

---

## 🤝 参与贡献

这个项目诞生于「自己用着顺手」的需求，但我相信它还能更好。

如果你有任何想法——新功能、Bug 修复、界面优化、语言补充、文档改进——都非常欢迎：

1. Fork 本仓库
2. 创建你的特性分支：`git checkout -b feature/AmazingFeature`
3. 提交更改：`git commit -m 'Add some AmazingFeature'`
4. 推送分支：`git push origin feature/AmazingFeature`
5. 提交 Pull Request

---

## 📜 开源协议

本项目基于 [MIT License](LICENSE) 开源。

你可以自由使用、修改、分发，如需商用请获取授权。只希望你在某个安静的午后，用它写出让自己满意的文章时，能想起这个项目的起点。


---

<div align="center">

### 如果它帮到了你，给个 ⭐ 吧。

**写得好，比什么都重要。**

</div>
