# 文档与窗口生命周期

日期：2026-09-09；HAE-005 第四阶段。当前是 Main 服务和原生 window.close 事件的自动实验。正常应用入口仍只读；此模块、[编辑器 bridge](EDITOR_BRIDGE.md) 与 Kimi 前端尚未组成用户可操作窗口。

## 打开与替换

[prepareDocument](../src/main/workspace/document.ts) 接受 Main 选择器提供的路径，在独立会话中完成预览、映射检查、草稿、输入控制器和授权 writer 的初始化。任何一步失败都会关闭这个候选，不能先关闭当前编辑页。源映射检查拒绝的内容仍按现有只读规则处理，不因打开流程扩大支持范围。

[Workspace](../src/main/workspace/controller.ts) 一次处理一个打开或关闭请求，持有递增状态版本。打开前检查版本、组合态、正在进行的应用/保存和未知结果；不符合条件就不打开选择器。取消选择不分配候选。新文档准备完成后，若旧文档有未应用输入或净变更，再发出离开确认。

确认包含随机 reviewId、当前/下一文件显示名、输入状态版本和变更摘要。只接受同一 reviewId 的 cancel/discard/save-copy。放弃或另存前重新检查输入、草稿版本与候选 hash；确认期间有新文字到达，旧确认拒绝，保留新输入。干净文档可以直接替换，但提交前仍做最终状态核验。

提交 current 的替换是 Main 同一任务中的同步动作，然后关闭旧输入和旧预览。所有结果在清理和状态回到 idle 后返回；不把半途 committing 快照当成完成状态。若旧文档 teardown 失败，保留引用并设置 cleanupPending，阻止继续创建更多文档；这不是文件恢复界面。

## 离开动作

| 决定 | 已实现行为 |
| --- | --- |
| cancel | 保留当前输入、草稿和预览，关闭待替换候选；不调用 Apply 或写文件 |
| discard | 确认仍适用时放弃旧会话，切换到已准备文档或关闭；不创建 Patch、不写 HTML |
| save-copy | 明确应用旧目标的未应用文字，再打开 Main 另存选择器；只有本次 created 且 hash 与当前候选相符才离开 |

选择另存后再取消文件选择器，会保留此前明确应用的草稿并留在旧窗口；不会写 HTML。原文件或已有文件不允许覆盖。failed/unknown 结果保留旧会话，unknown 还阻止打开其他文档，等待后续恢复处理。新副本不改变原入口保存点，不能称为完成 M2 的覆盖保存。

## 原生窗口与关闭

[bindWorkspaceWindow](../src/main/workspace/window.ts) 在 close 事件中同步 preventDefault，再请求 Workspace 检查。等待期间的重复关闭共用一个决定；取消、组合态、忙碌、失败或未知结果都保持窗口。Workspace 完成 closed 后才销毁原生窗口。

dispose 仅用于进程/测试的强制清理，保留当前对象引用并取消尚未提交的准备；等待选择/确认的回调也响应取消，迟到答复和异常被消费，不会重新触发操作。不能暴露为用户关闭或 renderer 的 force 命令。系统强杀/Main 崩溃/断电仍需要 HAE-010 的持久化与恢复，内存引用不能提供此保障。

## API 与接线边界

纯类型与确认 schema 在 [workspace.ts](../src/contracts/workspace.ts)。Main 使用 open(expectedRevision, chooser)、requestClose(expectedRevision)、snapshot/onState；路径和选择器函数均留在 Main，不进入纯状态。review 与 chooseCopy 回调由后续应用层实现，真实 UI 仍须先同步未应用输入、结束 IME，并按当前 revision 作出决定。

该阶段仅协调静态校稿文档的打开/关闭；JS 模式切换、目录选择、资源诊断面板、UI 页面/bridge 重建和视图挂载失败恢复仍需应用接线。不得直接用只读 PreviewController 替换正在编辑的文档；其预览成功即销毁旧页的语义不足以保护后续映射初始化。

## 验证范围

`npm run test:workspace` 在 Electron 44.2.0 中执行七组真实预览、源解析深度失败、确认竞争、另存/重开和 window.close 事件实验；保存前后按独立完整字节期望核对，原 HTML/CSS 均未改变。创建文件后注入错误时，部分文件、草稿及原窗口保留，后续打开被阻止。报告为忽略的 `test-results/workspace.json`。

另有十一项单元反例，含解析准备取消、旧确认、清理失败、不返回的选择/确认回调和强制清理后的迟到结果，见 [状态测试](../tests/unit/workspace.test.mjs) 与 [Electron 实验](../tests/workspace/main.ts)。文件选择和用户决定采用测试回调；没有维护者点击原生关闭按钮、真实对话框或 IME 操作记录。HAE-005 和 M2 仍未整体通过。
