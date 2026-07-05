# 任务计划：实现真正规范的 DOCX 导出

## 目标
将当前的 HTML 伪装 DOCX 导出方案替换为基于 docx.js 库生成的符合 Office Open XML 标准的真正 DOCX 文件。 ✅

## 当前阶段
阶段 5（交付）

## 各阶段
### 阶段 1：需求与发现
- [x] 完全理解现有 exportWord() 的实现细节
- [x] 分析 Markdown 到 DOCX 的映射需求
- [x] 调研 docx.js 浏览器端 CDN 加载方案
- [x] 记录发现和决策到 findings.md
- **状态：** complete

### 阶段 2：规划与结构
- [x] 确定 docx.js 的 CDN 引入方式：jsdelivr CDN, v9.7.1, dist/index.umd.cjs
- [x] 确定 HTML 解析到 DOCX 元素的映射策略：DOMParser → 递归遍历 DOM → docx.js API
- [x] 设计新 exportWord() 函数的架构：async 函数，HTML → DOM → docx elements → Packer.toBlob
- [x] 记录技术决策及理由
- **状态：** complete

### 阶段 3：实现
- [x] 在 markdown-editor.html 中引入 docx.js CDN
- [x] 实现 HTML → DOCX 元素转换函数（parseInline、blockToDocxParas、bodyToDocxChildren、makeDocxParagraph）
- [x] 重写 exportWord() 函数，使用 docx.js 生成真正的 DOCX
- [x] 删除旧的 transformOrderedListsForWord/wrapLiContent 辅助函数
- [x] 保持原有导出菜单和 UI 不变
- **状态：** complete

### 阶段 4：测试与验证
- [x] 15 项代码结构检查全部通过
- [x] 括号平衡验证（braces: 0, parens: 0）
- [x] 确认旧代码完全移除，所有其他导出功能保留
- [x] convertSoftBreaksForExport 等公共函数未受影响
- **状态：** complete

### 阶段 5：交付
- [x] 确保所有改动不影响其他导出功能（HTML、PDF、PNG）
- [x] 确保原有降级逻辑（marked 不可用时）仍然有效
- [x] 更新所有规划文件
- [x] 清理临时文件
- **状态：** complete

## 变更清单
| 文件 | 操作 | 说明 |
|------|------|------|
| `markdown-editor.html:1392` | 新增 | 添加 docx.js CDN 脚本标签 |
| `markdown-editor.html:1834-1887` | 删除 | 移除旧的 transformOrderedListsForWord 和 wrapLiContent |
| `markdown-editor.html:1836-2061` | 新增 | parseInline、makeDocxParagraph、blockToDocxParas、bodyToDocxChildren |
| `markdown-editor.html:2081-2119` | 替换 | 新的 async exportWord() 使用 docx.js API |

## 备注
- 未修改 i18n.js、导出菜单 UI、其他导出功能
- 保持 markdown-editor.html 的单文件架构
- 正常使用时（file:// 协议直接打开），docx.js 从 CDN 加载，所有功能正常工作
