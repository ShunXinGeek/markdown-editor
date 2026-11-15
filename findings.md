# 发现与决策

## 需求
在 markdown-editor.html 导出 DOCX 时，生成连续且不可编辑的多级编号（Word 原生 auto-numbering），类似 sample.html 已有的功能。

## 研究发现

### sample.html 实现原理
- 使用 `marked.lexer()` 解析 Markdown tokens
- 定义 `orderedConfig`：3 级编号（DECIMAL→LOWER_LETTER→LOWER_ROMAN）
- 定义 `bulletConfig`：4 级项目符号
- 每个列表项段落设置 `numbering: { reference: "xxx", level: level }`
- Document 构造函数传入 `numbering: { config: [bulletConfig, orderedConfig] }`
- Word 原生处理编号连续性，无需手动计数

### markdown-editor.html 当前实现
- 使用 `marked.parse()` → HTML → `blockToDocxParas()` 转换
- OL：手动生成文本前缀 "1. "、"1.1. " 等作为 TextRun（可编辑的文本）
- UL：使用 `bullet: { level }` 属性
- 使用 `numberingState` 对象手动追踪计数器和路径
- Document 构造函数没有 numbering 配置

### 关键差异
- sample.html：tkens → DOCX（直接）
- markdown-editor.html：Markdown → HTML → DOCX（间接）
- markdown-editor.html 的架构（HTML DOM 中间层）仍然可以支持 numbering，因为只需在段落级别设置 numbering 属性即可

## 技术决策
| 决策 | 理由 |
|------|------|
| 保留 HTML→DOCX 架构 | 改动最小，HTML DOM 中间层不影响 numbering 设置 |
| 复用 sample.html 的 numbering 配置 | 已验证正确，格式一致 |
| OL/UL 统一使用 numbering reference | 替代现有的文本前缀和 bullet 属性 |
| 移除 numberingState | Word 原生处理编号，不再需要手动计数 |
| 仅修改 blockToDocxParas + exportWord 函数 | 最小改动原则 |

## 资源
- sample.html 第 2330-2830 行：完整 DOCX 导出实现
- markdown-editor.html 第 1899-2150 行：当前 DOCX 导出实现

---

## 视觉/浏览器发现
- 无需浏览器测试，改动仅涉及 DOCX 导出逻辑

---

# 2026-11-15 文档与仓库同步发现

- ARCHITECTURE.md 描述仍停留在早期单文档/localStorage 流程；当前代码新增 IndexedDB 草稿、工作区、附件、模块化渲染与静态构建，应按实际代码修订。
- README、现有测试与按钮审查/复测报告记录了 11 月 14 至 15 日的工作区变更与验证结果；Git 历史没有该五日窗口提交，不能把文件修改时间冒称为提交时间。
- `dist/`、`node_modules/`、`test-results/` 已忽略；仍须检查 `debug.log` 与 `.netlify/` 等本机文件，避免误上传。
- GitHub 远端 `origin/master` 与本地 HEAD 都是 `5cab07a`，没有远端先行改动。工作区源码、配置、测试、vendor 文件均为拟上传的程序更新。
- 现行脚本加载顺序：随仓库发布的 Marked、DOMPurify、i18n、草稿/附件/工作区/列表/渲染模块，再执行 HTML 内联控制器；KaTeX、Mermaid、docx、PNG 库按需并校验完整性。
- HTTP(S) 使用 IndexedDB 及修订号比对保存；`file:` 或 IndexedDB 不可用时只支持 localStorage 单文档回退。附件采用内容 SHA-256 命名、存入数据库，工作区备份校验清单及附件。预览使用 DOMPurify 净化和异步渲染代次控制。
- `build-static.py` 校验 vendor SHA-384，输出 `dist/`、`_headers`（CSP）及离线 ZIP；Netlify 使用根目录 `netlify.toml`。测试覆盖 Chromium、Firefox、Python 代理。生成目录与本机日志不属于发布源码。
