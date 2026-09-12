# 隐藏静态内容校稿

2026-09-11。沿用方案 B，为预先写在 HTML 中、通过 `hidden` 属性隐藏的内容提供“显示隐藏内容”开关。常见场景是标签页切换前无法看见的第二、第三块正文。此功能只临时改变校稿视图，不执行标签切换脚本，不增加可编辑内容种类。

在工具栏或“更多操作”选择“显示隐藏内容”，再滚动到展开的正文中选字修改。完成后可“恢复原显示”，或按原有流程勾选复核并保存。新文档默认恢复原始显隐；保存后的文件仍用原有页面脚本切换标签。此开关的边界不等于所有模式切换的边界：先浏览再校稿的渐显、CSS 显隐与问答延续另见 [当前显示补充](CURRENT_VIEW.md)，正常流程无需先用本开关。

## 合同

- Main 从已核验的 SourceIndex 查找带 `hidden` 且包含受支持非空白 Text 的 HTML 元素。表单、脚本、template、SVG/Shadow DOM 等原有只读或拒绝规则不变；仅 CSS `display:none`、关闭的 details、脚本运行后才产生的内容不在本阶段范围内。
- Main 根据整树生成仅含数字位置的有限 CSS 路径，只改变屏幕显示。路径不接受页面或 UI 输入，不是选择或写盘依据；所有文字修改仍须通过原有对象映射、版本与字节 Patch 核验。
- CSS 通过 Chromium 独立样式句柄注入，不修改 DOM 属性、class、节点结构或源码样式。最多 200 个目标、256 KiB 规则，超限整体拒绝，不提供部分成功。展开采用块级显示，表格和列表采用对应显示类型。
- 使用可撤回的 author-origin 样式，在私有隔离 world 1003 中执行固定、只读的显隐检查。检查只接受 Main 生成的数字路径与随机样式标记，不运行页面函数、不开放桥、不授予补丁权限。所有目标确实可见后才发布已展开；页面样式阻止展开时，核验精确撤回后报告不可用。撤回时检查随机标记已消失，避免原生 Promise 成功但样式仍在的误报。
- 可信 UI 命令只有当前 documentId、workspace stateRevision 和 enabled。先排空实际输入窗口，重取最新修订；Main 再检查静态模式、映射就绪、空闲输入，持有 InputController 离开保护直到同一次原生操作完成。组合输入、未预览文本、重复请求、旧文档、只读预览和活动退出均拒绝。
- 窗口、文档或命令失效后，只撤回该原生视图内的精确样式句柄。迟到结果不改变新文档状态；关闭和桥销毁等待已经接受的操作。无法确认样式操作时报告 unknown 状态，不声称已收起，也不自动重试。
- 默认关闭。取消展开或切换显示不写 HTML、不增加文字历史；已有草稿和复核仍保留。保存/打开/恢复的新文档使用默认显隐，可再次展开；模式切换可按 [就地校稿合同](CONTEXTUAL_EDIT.md) 保留已验证的预置面板，不继承“全部展开”开关。再次展开前先在同一输入保护内撤回延续样式。展开状态不写入检查点或恢复记录。
- 样式只在 `@media screen` 生效；PDF 仍遵循原页面打印规则。保存保留原始 `hidden`、class、脚本和样式字节，独立浏览器中的原有标签切换继续生效。

本机 Electron 44.2.0 回归曾复现 user-origin 样式在 `removeInsertedCSS` 完成后仍生效，因此本实现使用 author-origin，并验证实际插入/撤回结果。不会为覆盖任意原页面样式而修改 DOM、关闭 CSP 或启用页面脚本。样式限制导致的已确认撤回与无法确认原生结果分别报告 unavailable 和 uncertain。

## 前端交接

Kimi 负责方案 B 中的入口、状态提示与防重复/排空输入流程。允许改动 `src/ui/app.tsx`、新增 `src/ui/hidden-content-flow.ts`、新增 `tests/product/ui-hidden-content.mjs`，必要时可调整 `src/ui/shell.css`。禁止改动 contracts、Main、core、preload、platform、构建与依赖。主代理负责这些底层合同及独立真实窗口、保存与字节测试。

`DesktopState.hiddenContent` 提供 `{ documentId, count, enabled, busy, available, uncertain, limited }`；旧状态没有该字段时视为不可用。主窗口通过 `haeDesktop.request({ kind: 'hidden-content', documentId, stateRevision, enabled })` 请求；错误码包括 `HIDDEN_CONTENT_BUSY`、`HIDDEN_CONTENT_UNAVAILABLE`、`HIDDEN_CONTENT_FAILED`，以及原有输入/只读/陈旧修订错误。原生浮窗显示状态但不拥有此命令。

人工仍需验收自己的标签页与中文输入、原生保存对话框。脚本只读预览中的动态交互和静态展开是不同能力；此功能不承诺任意运行中页面都可修改。

## 验证入口

`npm run test:product-hidden` 使用真实产品 React、生产 preload/IPC、隔离 Preview、Workers 和 Windows Save，覆盖展开/撤回、Unicode 与实体字节、复核保留、打印媒体、模式往返、窄窗、长文件名、组合态拒绝与原页面样式阻挡后的撤回。原生选择由 Main 测试回调驱动，组合事件为合成事件。实际执行记录及人工边界见 [HAE-009](implementation/HAE-009.md)。
