# 任务计划：DOCX 导出连续编号（含多级编号）

## 目标
修改 markdown-editor.html，使其导出 DOCX 时使用 Word 原生自动编号（而非文本前缀），实现连续且不可编辑的多级编号。

## 当前阶段
完成

## 各阶段
### 阶段 1：需求与发现
- [x] 理解用户意图
- [x] 分析 sample.html 实现原理
- [x] 分析 markdown-editor.html 当前实现
- [x] 将发现记录到 findings.md
- **状态：** complete

### 阶段 2：规划与结构
- [x] 确定技术方案
- [x] 记录决策及理由
- **状态：** complete

### 阶段 3：实现
- [x] 添加 numbering 配置定义（orderedConfig / bulletConfig）
- [x] 修改 OL 处理：用 Word 自动编号替代文本前缀
- [x] 修改 UL 处理：改用 numbering reference
- [x] 修改块引用内列表处理（BLOCKQUOTE 递归调用已天然支持）
- [x] 更新 Document 构造函数添加 numbering 配置
- [x] 移除不再需要的计数器逻辑
- **状态：** complete

### 阶段 4：测试与验证
- [x] 代码验证：7 项检查全部通过
- [x] Git diff 确认：98 insertions / 6 deletions，改动最小
- [ ] 浏览器中实际测试 DOCX 导出（建议测试含多级编号的 Markdown 内容）
- **状态：** pending（需用户在浏览器中验证）

## 变更摘要
| 变更 | 说明 |
|------|------|
| orderedConfig | 3 级有序编号（DECIMAL → LOWER_LETTER → LOWER_ROMAN） |
| bulletConfig | 4 级项目符号（• ○ ■ •）|
| OL 处理 | 移除文本前缀，改用 numbering reference |
| UL 处理 | 移除 bullet 属性，改用 numbering reference |
| Document 构造 | 添加 numbering: { config: [...] } |
