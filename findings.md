# 发现与决策

## 需求
- 将 markdown-editor.html 的 DOCX 导出从"HTML 伪 DOCX"改为真正的 Office Open XML 格式
- 最小改动原则：只改动 exportWord() 及其直接依赖的辅助函数
- 不引入构建工具或 npm 依赖管理，保持单文件可独立运行

## 研究发现

### 当前实现分析
- `exportWord()` 在 markdown-editor.html:1888（旧位置）
- 使用 `marked.parse()` 将 Markdown 渲染为 HTML
- `transformOrderedListsForWord()` 添加 mso-list 属性（Word HTML 私有扩展）
- 最终用 Blob 保存 HTML 字符串，MIME 设为 `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- 本质上是 HTML 文件 + .docx 后缀 + 误导性 MIME 类型

### docx.js 库调研
- `docx` (npm v9.7.1) 是最成熟的浏览器端 DOCX 生成库
- CDN 地址：`https://cdn.jsdelivr.net/npm/docx@9.7.1/dist/index.umd.cjs`（已验证可用，200 OK）
- 暴露全局 `docx` 对象，包含 `Document`、`Paragraph`、`TextRun`、`Table`、`Packer` 等
- 使用 JSZip 内部打包 ZIP，输出标准的 OOXML 格式
- 生成的 .docx 文件可通过 `Packer.toBlob()` 获取 Blob

### Markdown 元素 → DOCX 元素映射
| Markdown 元素 | DOCX 元素 | docx.js API |
|---|---|---|
| H1-H6 | 标题段落 | `HeadingLevel.HEADING_1` ~ `HEADING_6` |
| 段落 (p) | 普通段落 | `new Paragraph({ children: [...] })` |
| 粗体/斜体 | TextRun 属性 | `new TextRun({ text, bold, italics })` |
| 无序列表 (ul) | Bullet list | `paragraph.bullet: { level }` |
| 有序列表 (ol) | 手动编号 | 前缀 "N. " + 段落缩进 |
| 代码块 (pre/code) | 带底色的代码段落 | `TextRun({ font: "Consolas" })` + `Paragraph.shading` |
| 行内代码 | 等宽字体 | `TextRun({ font: "Consolas", shading })` |
| 表格 (table) | 表格 | `new Table({ rows: [...] })` |
| 引用 (blockquote) | 缩进+左边框段落 | `makeDocxParagraph` + `border.left` |
| 链接 (a) | 超链接 | `new ExternalHyperlink()` |
| 图片 (img) | 内嵌图片/占位文本 | `ImageRun`（成功时）或灰色占位文字（失败时） |
| 分割线 (hr) | 底部边框段落 | `Paragraph.border.bottom` |

### 图片处理策略
- 网络图片：通过 fetch 获取并嵌入为 ImageRun
- 本地图片（base64 data URI）：直接解码嵌入
- 无法加载的图片：回退为灰色斜体占位文本 `[图片: xxx]`

## 技术决策
| 决策 | 理由 |
|------|------|
| 使用 jsdelivr CDN 加载 docx.js | unpkg 404；jsdelivr 返回 200 |
| 版本锁定 9.7.1 | npm latest |
| DOMParser + 递归 DOM 遍历 | 复用现有 marked 渲染 |
| 图片异步 fetch 嵌入 | 支持 data URI 和网络 URL |
| exportWord 改为 async | Packer.toBlob 和图片 fetch 需要异步 |
| 有序列表使用手动编号 | 避免 docx.js numbering config 的复杂性 |
| makeDocxParagraph 辅助函数 | 在引用块上下文中统一应用左边框+缩进 |

### 实现架构
```
Markdown → marked.parse() → HTML → DOMParser → DOM body →
  bodyToDocxChildren() → blockToDocxParas() → makeDocxParagraph() →
  docx.Document → Packer.toBlob() → download .docx

内联元素：parseInline(node) → TextRun[] / ExternalHyperlink[]
```

## 遇到的问题
| 问题 | 解决方案 |
|------|---------|
| PowerShell 字符串转义复杂 | 改用 Python 脚本进行文件操作 |
| apply_patch 编码匹配失败 | 使用 Python `str.replace` + 文件 I/O |
| 沙箱浏览器无法加载外部 CDN | 使用代码结构检查（15项）验证正确性 |
| 沙箱浏览器 file:// 被阻止 | 使用本地 HTTP 服务器（python -m http.server） |

## 资源
- docx.js 文档：https://docx.js.org/
- docx.js CDN：https://cdn.jsdelivr.net/npm/docx@9.7.1/dist/index.umd.cjs
- docx.js GitHub：https://github.com/dolanmedia/docx
