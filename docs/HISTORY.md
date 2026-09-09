# 逻辑历史与保存后的来源重建

日期：2026-09-10；HAE-011 第七至十二阶段。已实现纯核心历史、保存点重建、私有逻辑记录的验证/往返、隔离 Preview 空 Text 安装及历史文字确认，以及真实 Worker、Windows 保存事务和 Chromium 实验。Main 文档、输入协调、可信 Workspace 历史命令、完整历史磁盘格式、精确提交后的历史恢复与旧检查点清理已接通；正常入口与产品控件仍待接入。此文件不代表 M2 验收完成。

## 逻辑操作与确认

[createTextHistory](../src/core/history/timeline.ts) 管理最初来源、当前保存基线、操作序列和游标。一次确认 Apply 形成一个 `{target, before, after}`；target 是最初来源中的逻辑 Text 身份，不能作为当前文件的写入位置。sourceTarget/logicalTarget 根据本次重建结果换算为当前源身份。

| 接口 | 行为与限制 |
| --- | --- |
| prepareEdit | 使用当前源身份、基线和期望文字验证新候选，准备一个操作组；不推进当前历史 |
| prepareMove | 准备 undo/redo 的反向或正向文字候选，重新核验当前来源；无相应操作时拒绝 |
| commit | 只接受该历史实例签发、仍属于当前修订、尚未消费的准备结果；Main 必须先取得 Preview 的明确确认 |
| summary | 返回可撤销/重做数量、修订、基线与候选 hash、净变更状态；不提供写盘权限 |
| capture | 返回已确认记录和最初来源字节的副本；本方法没有文件 I/O |
| rebaseSaved | 验证传入字节精确等于冻结候选，用新源身份返回干净基线的新历史实例；保留操作及重做分支 |

A→B→C 的净 Patch 仍为 A→C；回到当前保存点恢复该基线的原始实体拼写。无变化 Apply 不新增历史，不清除 Redo。新分支只在 commit 成功后丢弃游标之后的操作；取消、验证失败、未确认或迟到结果均不推进历史。旧实例或复制出的准备对象不能被另一实例提交。

保存后的 Undo 只生成未保存候选；下一次明确 Save 才可写 HTML。保存点可位于历史中间，保存不会自动清空 Redo。新分支即使移除了曾保存操作所在的重做分支，当前磁盘基线仍由独立 savedValues 保留。修改目标之外的字节与资源继续受 Patch 和文件事务规则约束。

rebaseSaved 是纯内存操作，不能检查磁盘提交记录。Main 必须先确认实际 committed 结果、当前文件身份/hash 和 verifySaved，再准备新映射并发布新历史。旧实例继续保留原来源与候选作为证据；失败/未知不能仅凭文件内容相同便推进保存点。Main 窗口保存已按此顺序接入，成功后创建新的持久化序列并记录完整干净历史点。

## 空 Text 的来源证明

普通解析的 Text 必须具有非空、连续的源码范围。清空并保存后，Chromium/parse5 会移除该 Text；历史记录不能把旧 offset 或旧 nodeId 强行套到新文件。

[createHistorySource](../src/core/history/source.ts) 接受 Main 保留的最初来源字节、已保存逻辑值和当前完整字节，执行以下核验：

1. 重新解析两份完整来源；历史目标必须是原来源中可编辑的静态 Text。校验解析错误集合、完整非 Text 结构、父子顺序、属性、注释、脚本及所有当前 Text 值。只允许已知清空目标在当前树中缺席。
2. 按原来源中可编辑 Text 分段，用新解析出的存活 Text 范围核对整份当前文件。每一个 Text 外的字面源码片段必须逐字节相同；从未修改的 Text 连原实体拼写也必须相同。
3. 缺席目标的插入点只能落在上述完整分段核验确定的边界，不能靠搜索同名文字或选择器猜测。边界再通过当前 UTF-8 映射换算成 code-unit 位置，拒绝代理项中点。
4. 给空目标生成新的源节点身份、当前范围和上下文证明。SourceIndex 的内部 lineage 保留最初来源与逻辑值；每次编译重新执行整套证明，不把缓存的空范围当作授权。

只有此证明产生的空目标允许 `startByte === endByte`。它仍使用纯文本编码、输出大小、未修改字节、重解析和完整语义树检查；普通 SourceIndex 或伪造空节点继续拒绝。多个空目标不会把后续节点编号偏移误当作另一个同文目标。清空导致解析器移动其他节点时仍拒绝，例如缺少明确 body 边界的某些首段与注释组合。

lineage 不是外部输入能力或已认证的文件来源。最初字节须来自 Main 保留的打开快照，或已验证文件身份、schema、hash 的私有历史记录；页面和 UI 不能提交这些字节、值或位置。

## 隔离 Preview 的空 Text 与历史操作

Main [createPreviewMapping](../src/main/preview/source-mapping.ts) 可在第四参数接收内部 lineage。有限 Parser Worker 重建来源证明后，Main 保留最初字节/逻辑值的不可变副本，只把新树及已证明的 emptyTextIndices 发给隔离 preload。索引指向本次预期树，不是 HTML 范围、选择器或页面可提交的写入位置。

[安装合同](../src/contracts/mapping.ts) 限定最多 1000 个有序、唯一的空位置，必须是新的空 Text 身份、HTML 父元素、可编辑且无只读原因。[registry](../src/preview/node-registry.ts) 先省略这些位置匹配整个真实 DOM；匹配失败、绑定前发生过 DOM 改动、Shadow DOM、生成内容等不受支持的目标都在插入前拒绝。全部目标先验证父对象和后继兄弟对象，再同步逐个插入空 Text；观察器保持连接，每次只消费这一个新增 Text 对应的 childList 记录。随后重新匹配完整树，才登记对象并发布 ready。仅发送增强后的树不能创建空节点。

Main `applyHistory(mappingRevision, change)` 接收已准备的单 Text 历史变更。它与普通 Apply、首次恢复和编辑 guard 互斥；当前映射版本、节点旧值和规范文字必须一致。隔离侧独立检查真实 Text 对象、连接关系、根、旧值和生成内容，然后核对唯一 characterData 记录。该操作不要求目标被点击选中，因此可以恢复没有可点击文字的空节点；成功后清空选择并推进映射版本。普通 Apply 和首次恢复也同步更新 Main 保留的旧值。

此方法不生成 Patch、不推进逻辑历史、不处理未应用输入，也不写 HTML。调用方须先冻结版本并验证 Worker 候选，再等待 applied 才 commit 历史；rejected 保留原记录，unknown 必须同时保留旧历史和待确认候选，映射失效后不能自动重试。编辑 token 存在时映射原语直接拒绝；上层 InputController 在完成候选准备后才可释放干净输入，并核对释放造成的唯一版本变化。此通道仅在 Main 与隔离 preload 间使用；可信 UI 使用另一个严格的 Workspace history 命令，页面没有 API。

## 私有记录与边界

HistoryRecord 是严格的 v1 **历史记录**，与现有 v1 **草稿检查点**是不同类型：

| 字段 | 含义 |
| --- | --- |
| version | 当前历史 schema 为 1，额外字段和未知版本拒绝 |
| originHash / originSize | 单独保留的最初来源字节的完整 hash/大小 |
| baseHash / baseSize | 当前保存基线的完整 hash/大小 |
| candidateHash | 按游标重建的完整未保存候选 hash |
| revision / cursor | 当前历史修订与已应用操作数量 |
| operations | 完整当前分支的前后逻辑文字，包含 Redo 部分 |
| savedValues | 当前保存点已经涉及的逻辑 Text 值，与历史游标独立 |

恢复须验证所有操作的前后值链，再按当前游标重建候选并核对完整 hash。记录不含可执行 offset、路径、选择器、替换字节或序列化 DOM。最初来源与基线各最多 5 MiB；最多 1000 个操作、1000 个历史目标，每个方向的文字均受 64 KiB UTF-8 限制。操作文本加各目标最大保存点文本的预留预算最多 8 MiB，确保 Undo 后保存不会才发现历史容量不足。超过限制明确拒绝新操作，保留已有历史，不静默裁掉旧记录。

这些记录现由 v2 草稿检查点保存：record.json 绑定完整历史与逻辑净意图，origin.bin 保留最初字节，baseline.bin 保留当前保存基线，最后写入 complete.json。恢复重新验证整个逻辑链、来源证明、净意图与候选 hash；详见 [检查点格式](DRAFT_CHECKPOINTS.md)。旧 v1 草稿格式继续拒绝 lineage；恢复 v1 时保持原净变更行为并返回 history=null，不凭空推断过往顺序。

## Main 文档与可信历史命令

[历史控制器](../src/main/draft/history.ts) 将解析、历史重放、候选计算及保存点准备交给有限 Worker：5 秒、256/32/8 MiB 资源预算，一次一个活动任务，结束前确认 Worker 终止。终止失败阻止新增历史 Worker、原文件 Save 和文档成功清理；新打开在创建 Preview 前拒绝，避免累积视图。Main 仅接受本实例签发的单次计划；确认 Preview 后才替换历史、候选和修订。未知结果保留旧历史以及 uncertainHistory/uncertainCandidate，不排队持久化这个未确认操作。

可信 Workspace 使用 `edit(documentId, {kind: "history", value: {stateRevision, draftRevision, direction}})`，direction 仅 undo/redo，不接受目标、路径、offset 或文本。InputSnapshot.history 仅显示撤销/重做数量和可用状态。组合输入、未应用输入、原生待处理选择意图和过期版本均拒绝；阶段为 history 时禁止其他输入命令。干净输入只能在候选准备后释放，期间原生选择变化仍使请求失效。实际键盘、焦点和输入法控件路由属于后续产品前端。

新文档默认启用历史；可选 checkpoints 端口持久化完整历史。确认变化的 Apply、Undo、Redo 将同一冻结候选/历史/修订排入队列，no-op 不清除重做分支。Save 先排空写入并核验实际 committed 文件，随后建立新映射和保存点；历史修订连续递增，新持久化序列异步记录干净点。恢复干净 v2 点只安装历史和 Redo，不回放旧脏点；重新授权、最新点/源版本复查与所有权规则保持。

如果原生提交完成、但新干净历史点尚未持久化即崩溃，旧点仍按精确 committed 证据标为 saved 并禁止重复应用。Main prepareRecovery 现在可为最新 saved v2 点验证唯一提交记录与当前文件版本，把完整历史重建到实际已保存字节上，候选必须与新基线逐字节相同且没有补丁。窗口先持久化新的干净历史点，再安装已证明的空 Text 和历史；后续 Undo 仍为未保存变更。完整顺序见 [检查点恢复](DRAFT_CHECKPOINTS.md)。

新的或既有的后续会话记录阻止经旧 saved 入口回退，包括干净、不完整和已结束记录；记录归属不明也拒绝。旧 v1 没有完整历史，不能使用此转换。提交证据缺失、歧义、改变或文件版本变化，以及遗留锁和新点写入失败均保留证据，不自动重试或释放锁。准备后取消仍保留已经形成的新干净点；正常入口与产品故障处理尚未接入。

同一活动序列的 v2 点现在按 [检查点清理合同](CHECKPOINT_COMPACTION.md) 保留最近两个完整修订。每个点包含完整逻辑链与 Redo，删除更旧完整点不裁掉撤销历史。失败/歧义点、其他序列、结束锚点及保存备份继续保留；清理中断保留锁和剩余证据，不自动续删或解锁。

Main 在全部文档与存储事务结束后，可按 [清理中断恢复](COMPACTION_RECOVERY.md) 核验并明确完成旧点清理，再安装最新完整草稿/历史。原锁和清理记录先保存到有界恢复记录；无法核验的证据继续保留，不能从较旧点回退或自动解锁。

## 执行证据与下一步

完整 Save 留下的旧锁可通过 [新的 keep-current 决定](SAVE_RECOVERY.md) 处置。审查记录不提升原事务证据：精确 committed 仍可通过既有流程建立干净历史，只有 candidate 字节或外部冲突时继续拒绝旧历史回放。真实 Electron 新进程分别覆盖这两条分支，后一条可独立恢复备份并先备份当前文件。

[来源测试](../tests/unit/history-source.test.mjs) 与 [历史测试](../tests/unit/text-history.test.mjs) 覆盖重复文字、多个空目标、Unicode/BOM/实体、pre 与混合行尾、一万行来源、变长后的新范围、保存点/分支、迟到/伪造准备、损坏记录及容量。新历史候选由既有 Draft/Diff Worker 重建；[Electron 保存实验](../tests/history/main.ts) 验证显式保存、取消、外部冲突、未知结果，以及 Chromium 重开后的字节/文字安全。[预览实验](../tests/history/preview.ts) 验证缺席 Text 的安装、反向文字确认、原生选择与编辑锁、确认丢失、来源/DOM 变化及外来确认拒绝。新增 [窗口/进程实验](../tests/history/workspace.ts) 通过真实 Workspace IPC 调用历史、验证未应用/组合标志保护、Windows 保存/空 Text/干净及脏检查点恢复、确认丢失，并强杀独立 Electron 进程后用新进程恢复 Redo。它们使用自制文件和空白可信传输页面，没有产品控件。具体命令、结果及首次失败证据见 [HAE-011](implementation/HAE-011.md)。

下一步处理恢复失败后的明确决策、遗留锁与跨会话/备份/失败证据的安全清理。产品界面仍须由 Kimi 在选稿后实施。真实 IME/对话框/报告、Windows 10/macOS、全尺寸性能、实际磁盘满和断电均未验收；HAE-011 与 M2 保持未完成。
