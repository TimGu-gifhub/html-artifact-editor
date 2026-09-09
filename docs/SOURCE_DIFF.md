# 冻结候选的源码 Diff

日期：2026-09-09，HAE-011 第六阶段。已提供纯核心 Diff、有限 Worker、Main 文档读取器与可信 Workspace IPC；正常产品入口和 Diff 面板仍未接入。这里的 Diff 是已应用草稿相对于打开/最近保存基线的实际源码替换，不代表磁盘文件目前仍未被其他程序修改。

## 字节与范围

[buildSourceDiff](../src/core/patch/source-diff.ts) 先使用既有 Patch 编译器验证源索引、目标、范围、编码、完整候选 hash 和树结构。用于显示的字符串直接从本次冻结原始/候选字节切出，不用逻辑 Text 值代替，不重新编码出一份不同的展示候选。

[SourceDiff](../src/contracts/source-diff.ts) 包含：

| 字段 | 语义 |
| --- | --- |
| baseHash / candidateHash | 完整原始基线和冻结候选的 SHA-256 |
| baseSize / candidateSize | 两份完整文件的 UTF-8 字节数，包括文件 BOM |
| unchangedBytes | 所有替换范围外保留的字节总数 |
| changes | 按源位置排序的完整净 Text 替换，最多 1000 项，不静默截断 |
| changes[].nodeId | 本次源基线中的 Text 身份，仅供对应变更摘要 |
| before / after | 各自文件中的 startByte/endByte 和原始源码 text；endByte 为不包含的右边界 |
| lineEnding | 本次替换片段采用 lf/crlf/cr 中的哪一种 |
| mixedLineEndings / leadingLfCompensation | 旧片段有混合行尾，或 pre/listing 首行 LF 补偿产生额外源码换行 |

before/after 的范围各自针对 baseHash/candidateHash；较早修改变长后，下游 after 位置会变化，不能把它当作原文件位置。清空 Text 的 after 范围可以为空；无净变更时 changes 为空、两个 hash 相同、所有字节均为 unchangedBytes。A→B→C 展示 A→C，回到基线恢复原实体拼写。

HAE-011 第七阶段也允许已证明的历史 Text 恢复产生空 before、非空 after；仅插入该 Text 时 unchangedBytes 等于完整基线大小。证明来自 Main 保留的最初来源与新基线的完整结构/字节核验，不能由显示范围本身授权。Draft/Diff Worker 会重建该证明；窗口历史命令现由 Main/InputController 接入，见 [逻辑历史](HISTORY.md)。

每个完整目标片段中的词法变化均保留，例如数字实体转为实际 Unicode 字符、`<` 重新编码为 `&lt;`、CRLF 改为目标换行风格。片段内开头的 U+FEFF 不会被误当作文件 BOM 删除。用原始文件未修改片段与所有 after.text 按 UTF-8 编码拼接，必须能重建完整候选字节。

这些内容是可信 UI 的只读显示数据。渲染 text 必须使用文字节点，不能作为 HTML 执行；换行/不可见字符应按实际源码显示。所有文件操作仍只接受 Main 保留的权限与版本，任何写入命令均不接收 Diff 的路径、范围或替换字节。Preview、同源其他窗口、子框架和旧连接均无此读取权限。

## Worker 与文档生命周期

[prepareSourceDiff](../src/main/draft/source-diff.ts) 使用独立 diff-worker，限制为 256 MiB old generation、32 MiB young generation、8 MiB stack 和 5 秒期限。源与候选沿用既有 5 MiB 文件限制；这些上限是保护值，尚非全尺寸性能验收结论。Core 和 contracts 使用纯 UTF-8 处理，不依赖 DOM、Node 编码对象或 OS。

Main 在派发前固定原始/候选字节及预期范围。Worker 返回后，除严格 schema/大小/hash 外，再逐项比对所有节点、范围、原始/候选切片及换行标记，拒绝同长度但不同内容、隐藏替换、错误来源或错误编码提示的结果。

每份文档最多一个活动 Worker 和一份已完成缓存。同一冻结候选及修订的并发读取共用任务；更新的有效请求取消旧任务，等待它终止后才开始新任务。结果返回时再次核验候选对象、hash、修订和草稿阶段；过期或忙碌结果不进入缓存。读取不改变输入版本，不触发 Apply、选择器、检查点或 HTML 写入。

UI renderer 丢失不必取消这项有限只读计算，重连仍可读取同一文档的结果；文档关闭则取消任务并等待实际终止。Worker 缺失/崩溃/超时会返回固定错误，保留草稿并允许新的显式读取。终止操作失败单独报告 SOURCE_DIFF_STOP_FAILED，禁止启动另一个 Worker，并让文档清理失败；不能把资源状态不明报告为成功释放。文档关闭同时等待持久化队列与 Diff 任务结算，成功后才释放 Preview 和会话占用。

## IPC 与保存确认

通过 [Workspace API](WORKSPACE_SESSION.md) 调用：

```ts
const response = await haeWorkspace.readDiff(documentId, draftRevision, candidateHash);
if (!response.ok || !response.diff) throw new Error(response.code ?? 'SOURCE_DIFF_UNAVAILABLE');
// response.diff carries documentId, draftRevision and the complete SourceDiff.
const shown = response.diff;
await haeWorkspace.save(documentId, latestStateRevision, {
  draftRevision: shown.draftRevision,
  candidateHash: shown.candidateHash,
});
```

调用者须处理错误，并按自身保存的操作身份使用结果；上例仅展示参数。返回快照可能已经推进，diff.documentId/draftRevision/candidateHash 仍说明本次显示数据所属的文档和候选，不能在迟到回调中替换成另一份文档的身份。

`readDiff` 只读取已确认 Apply 的候选。未应用输入或组合输入不会被混入 Diff，返回 WorkspaceSnapshot 仍准确保留 hasUnappliedInput/composing。Save 的原有未应用输入、组合态、文件冲突、备份与事务校验均继续有效。Diff 的打开时基线不替代对磁盘当前版本的复核。

save 的第三个参数 review 可选，用于把“确认这份 Diff”的操作绑定到已显示的修订和候选 hash。携带 review 时，任何修订/hash 不符均在启动保存事务前以 STALE_SOURCE_DIFF 拒绝；即使后来回到相同字节，也不能复用旧修订。两个参数的普通 Save 仍保存它所绑定的当前冻结草稿，不作“已查看 Diff”的声明；产品中从 Diff 发起的保存必须携带实际显示的 review。

保存成功后建立新 SourceIndex/映射，新的 Diff 针对新基线生成，旧文档身份拒绝。失败或未知保存按既有规则保留候选与恢复证据；此 Diff 接口不解除遗留锁，不取代备份/草稿恢复，也不提供历史操作。

## 验证边界

[纯核心与协议测试](../tests/unit/source-diff.test.mjs) 用独立期望值核验实体、Unicode/BOM、混合行尾、pre 首行 LF、长度变化/清空、1000 项完整输出，以及用 Diff 重建全部候选字节。[读取器测试](../tests/unit/source-diff-reader.test.mjs) 验证合并、缓存、取消、修订竞争与终止失败；[Worker 测试](../tests/unit/source-diff-worker.test.mjs) 验证同长度伪造、遗漏、缺失/崩溃和实际 5 秒超时终止。

`npm run test:source-diff` 用真实 Electron 的生产 preload/IPC 与自制空白可信页面验证读取、恢复草稿、未应用/组合标志、旧确认拒绝、归零、renderer 重连/旧文档拒绝，以及 Windows 显式保存的完整字节和外部冲突。它不是产品面板、真实 IME、原生对话框或人工接受结果；Windows 10/macOS、满尺寸性能、真实磁盘满和断电仍未验收。窗口历史/撤销和 v2 完整检查点已由 HAE-011 接通；产品控件与提交后未重建的恢复协调仍待实现，HAE-011 与 M2 保持未完成。
