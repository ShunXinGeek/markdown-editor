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
