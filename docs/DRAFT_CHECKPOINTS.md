# 草稿检查点与恢复候选

日期：2026-09-09；HAE-011 第六阶段。已实现纯核心逻辑编辑意图、Main 私有检查点存储、可选窗口持久化端口，以及最新点选择、会话结束标记、窗口离开协调与恢复安装，执行记录见 [HAE-011](implementation/HAE-011.md)。调用者须为 Main；正常产品入口与恢复界面尚未接入。检查点成功仅表示该版本的私有证据完成写入和回读，不表示 HTML 已保存。

## 1. 来源与恢复权限

[captureTextIntents](../src/core/history/checkpoint.ts) 重新验证完整 SourceIndex 和 PatchCandidate，核对基线、身份、补丁、候选完整 hash；同步固定逻辑编辑后才开始异步存储。每项仅保留 nodeId、expectedText、newText、rawSliceHash、contextFingerprint，不保存可执行 offset、替换字节、选择器或路径。

[rebuildCheckpoint](../src/core/history/checkpoint.ts) 使用 Main 当前提供的原始字节和新 SourceIdentity 重新解析完整源码树，核验 Text 是否可编辑、旧文字、源码片段 hash 和上下文，再从新索引生成字节范围与编码。实体、Unicode、换行及结构检查沿用 [Patch 引擎](../src/core/patch/engine.ts)，完整结果必须等于检查点 resultHash。重复目标、动态/只读节点、非规范文本、伪造范围或不匹配的基线均拒绝，不执行全局文字替换。

[createDraftCheckpointStore](../src/main/storage/checkpoints.ts) 接受 Main 在打开文件时固定的 SaveSource。持久化仍可保留这个基线的草稿，即使外部程序已修改 HTML；外部变化会阻止后续恢复。恢复须重新授权当前文件，匹配 targetKey、原始 hash 和 dev/ino/mtimeNs/ctimeNs，并在重建前后重新验证当前版本。返回的候选仅在内存中，调用本方法不会安装 Preview、应用编辑或写回 HTML。

## 2. 私有格式与写入结果

每次写入创建独立 UUID 目录，依次创建并同步三个不可覆盖文件：

| 文件 | 内容与校验 |
| --- | --- |
| record.json | 严格 v1 schema：checkpointId、sessionId、draftRevision、createdAt、targetKey、显示名称、文件身份、baseHash/baseSize、resultHash、逻辑 intents |
| baseline.bin | 打开时完整原始字节，最多 5 MiB；大小和 hash 必须与 record 相同 |
| complete.json | v1 seal，关联 checkpointId 及 record.json 的完整 hash；最后写入 |
| retired.json（可选） | 会话结束时追加的 v1 标记，绑定所在检查点 ID/recordHash、sessionId、结束修订、discarded/copied 原因和时间；最多 2 KiB，严格七字段 |

[schema](../src/contracts/draft-checkpoint.ts) 拒绝未知版本、额外字段、路径/offset、重复目标及无效标识。sessionId 是 Main 为一条文档草稿序列分配的 UUID；该序列的 draftRevision 为正整数并严格递增，不能复用于另一文件或内容。最多 1,000 项净文字意图，单项新文字最多 128 Ki 个 UTF-16 code units；实际编码与完整候选仍受核心 5 MiB 限制。record.json 最多 24 MiB，seal 最多 1 KiB。JSON 和原始字节均只在应用私有存储内，Preview 无读取权限。

写入沿用持有文件句柄、sync、完整回读 hash 和目录身份复核；最后再次加载并重建候选。记录不依赖前一检查点，失败不会覆盖或删除旧点。文件 sync 与进程强杀测试不证明断电后目录元数据的持久性。

| 结果 | Main 含义 |
| --- | --- |
| persisted | 此次或同版本既有完整检查点已回读、重建并核验；结果带准确 draftRevision、resultHash 和 checkpointId |
| failed | 未确认形成完整新检查点；可能保留部分文件和锁，不清空内存草稿 |
| unknown | seal 写入已开始但未确认完整结果；重读证据后才能判断，不自动回放 |
| cleanupPending | 与上述状态独立；只移除仍能证明属于本次写入的锁，清理失败保留证据；不能把已确认 persisted 改报未持久化 |

相同 sessionId/revision/base/result/文件身份的重试，可独立验证既有完整点并返回同一 ID；未完成点保留，符合相同修订绑定时可用新 UUID 重试。旧修订、同修订另一候选拒绝。同一会话的所有修订必须使用同一目标、基线和文件身份；已有结束标记时禁止该会话继续写入。记录头或结束标记损坏、归属不明时停止写入，不能绕过证据创建另一份“成功”。

## 3. 与保存共用锁和配额

草稿与 [保存事务](SAVE_PREPARATION.md) 必须放在同一个 Main 私有目录。传入保存存储作提交核验时，两者核对完整目录身份链；不同目录被拒绝，不接收来自页面的路径。两类写入共用 active.lock：保存准备未结束时草稿拒绝，草稿写入未结束时保存拒绝。锁仅协调合作实例；遗留锁不按时间、PID 或候选 hash 自动解除。

每目标合计最多 20 份草稿/保存记录，整个目录合计 200 MiB，根最多枚举 512 项。保存目录最多七个已知文件，草稿目录最多上述四个。配额在同一锁内计算，包含不完整和已结束会话的证据；不自动删除最后备份或旧检查点。达到限制明确失败。结束标记追加到既有目录，不占新记录名额，但仍需 2 KiB 的容量余量。清理流程尚未实现；连续长时间校稿可能达到此限制，不能当作可无限持续编辑的产品验收。

两种 scan 分别列出自己的原始记录；检查点 scan 只返回身份、修订、hash 和变更数量等摘要，不提供恢复决策。会话分类与最新候选须用第 6 节的 catalog/restoreLatest。归零后的完整检查点保留零项 intents 和原始 resultHash，不会自动退回旧的有修改点。

## 4. 保存后的去重

重启先验证检查点本身，再检查 Main 当前授权的目标。基线完整 hash 与文件版本均相同才为 baseline-matches；错误目标、不可读或版本冲突分别拒绝恢复。仅与 resultHash 相同只能报告 candidate-on-disk，不能当成已保存。

若保存存储存在完整 committed 事务，其目标、旧基线 hash/身份和新 hash 均与检查点对应，并且该 committed 记录的实际新文件版本与当前目标一致，才为 committed-matches。restoreCandidate 对此返回 DRAFT_ALREADY_SAVED，避免保存后、草稿退役前崩溃导致再次应用。实际替换却缺少提交证据、外部重写相同候选字节或保存记录无法读取，都不能冒充这个结果。该分类本身不删除或消费任何记录。

## 5. Apply 持久化与会话协调

Main 给 [createWorkspaceSession](../src/main/workspace/session.ts) 提供同目录的 checkpoints 端口后，每份文档创建独立 [持久化队列](../src/main/draft/persistence.ts)，固定打开时 SaveSource、SourceIndex 和 checkpointSessionId。普通打开时它等于文档会话 ID；恢复时沿用原持久化序列，UI 文档身份独立更新。没有此端口时 current.persistence=null；正常产品入口尚未安装这个端口。

确认成功且确有变化的 Apply 同步固定候选后异步启动私有写入。no-op、验证拒绝或 Preview 应用结果 unknown 都不会冒充已确认版本；回到原文的变更仍排入零净变化检查点。队列最多保留一个正在写的候选和一个最新待写候选，后来的 Apply 替代尚未开始的中间版本，不取消或覆盖已经开始的写入。

写入失败/未知保留上次确认的持久化修订以及最新内存草稿，停止自动启动后续写入；新的 Apply 只更新待写候选，不自动重试。可信 UI 的 retryPersistence(documentId, draftRevision) 必须针对仍为当前文档的最新修订，只重试该冻结候选。已有清理待处理状态禁止重试；不解除遗留锁、不回放 HTML。重试启动成功只表示请求被接受，最后写入状态通过 read/onState 读取。

`current.persistence` 的 [纯状态](../src/contracts/persistence.ts) 与输入版本独立：

| 字段 | 含义 |
| --- | --- |
| status | idle / writing / persisted / failed / unknown；描述当前队列结果，不等于原 HTML 保存状态 |
| draftRevision | 最新已确认 Apply 的草稿修订，初始为 1 |
| writingRevision / queuedRevision | 正在写与尚未开始的最新修订；无则为 null |
| persisted | 最后实际确认的 draftRevision/resultHash；从未确认则为 null |
| code / cleanupPending / canRetry | 有界错误、私有锁清理状态及当前是否接受重试 |

较旧写入成功时只更新 persisted 中的确切修订；如果最新候选仍在写，status 保持 writing。如果清理失败阻止较新候选，显示 failed，同时保留较旧 persisted 和 cleanupPending。不能仅凭 persisted 非空就把最新草稿显示成已持久化。后台通知推进 Workspace 状态版本，不推进 InputSnapshot.stateRevision，因而不撤销同一文字输入或离开确认的内容证明。

显式 Save 先使输入/草稿进入保存互斥，再等待当前队列结束本轮写入，才取得共用存储锁。私有检查点失败不会禁止另一个显式、经完整备份与版本复核的 Save；遗留锁仍会拒绝保存。成功重建建立新的持久化会话，后续 Apply 使用新原始字节。UI renderer 崩溃不停止 Main 已开始的检查点写入；重连读取同一状态。

Workspace 的打开/入口切换/原生关闭在离开决定仍有效时冻结当前输入，进入 committing，等待已开始写入及正常待写候选排空。后台失败不会因离开自动重试。无净修改且曾经 Apply 的文档，必须确认最新修订和完整候选 hash 对应的归零检查点；否则报告 DRAFT_PERSISTENCE_REQUIRED，保留原窗口并释放输入冻结，用户可显式重试最新修订。这个分支不虚构丢弃决定或结束标记。

明确丢弃或已验证另存副本后，先同步试挂载新视图（关闭时移除旧视图），再调用第 7 节的 retire，核验结果后发布新 current，最后关闭旧文档。挂载失败或写标记前撤销，回滚并保持旧输入可用；标记失败/未知则回滚视图、保留旧输入/候选/源证据，冻结后续 Apply/Save/Open/Close 和持久化重试，等待恢复。窗口只在完整 closed 结果后销毁，不以私有文件已出现推定成功。

lastDeparture 提供 documentId/status/code/cleanupPending/requiresReview，不含路径、检查点 ID 或文本字节。status 为 clean/retired/empty/failed/unknown；已核验的结束结果附有清理警告时仍可完成切换或关闭，但未清理锁继续阻止后续操作。标记开始后 UI renderer 崩溃不撤销已经授权的磁盘决定；Main 继续核验并完成切换，重连读取结果。若这时视图状态也不确定，保留已结束的旧会话证据并要求恢复，不将新视图宣称为已安装。

## 6. 会话目录与最新恢复候选

catalog 按 sessionId 分组，只返回 Main 元数据，不保留整批意图或源字节。选择依据是最大的 draftRevision；createdAt 只作记录，不能用时钟顺序替代修订顺序。同一会话混用目标/基线/文件身份、最高修订出现不同 resultHash 时为 ambiguous。最高修订只有部分或损坏记录时为 incomplete/invalid，不回退旧点；相同绑定和结果的完整重试可替代同修订未完成尝试。

完整最新点按净意图区分 dirty/clean；只有精确提交证明才为 saved，只有有效结束标记才为 retired。targetState 单独说明当前授权目标的 baseline-matches、conflict、candidate-on-disk、unavailable 等状态。归属不明的记录头或损坏的结束标记同时列入 unclassified，设置 reviewRequired，避免损坏的标记锚点使旧会话重新成为可恢复草稿。locked 独立报告遗留或活动锁。

restoreLatest(sessionId, source, index) 只为 dirty 且 baseline-matches 的最新完整点重建内存候选；有锁或无法归类的证据则拒绝。重建前后重新选择，并要求检查点 ID、修订、记录 hash 和完整候选 hash 一致。明确读取某个点的 restoreCandidate 仍须 Main 授权和源版本复核，也拒绝已结束会话及无法归类的证据；它仅用于提取候选，不能拿旧点读取绕过正常最新点决策。两个接口均不安装 Preview、不写 HTML、不解除锁。

## 7. 明确结束一个持久化会话

Main retire(source, sessionId, draftRevision, reason) 的前置条件是：已取得明确丢弃决定或已核验的另存副本结果，冻结该会话的新编辑并排空写入。接口不接收页面提供的路径，也不自行作离开决定。可选 Workspace checkpoints 端口已经按第 5 节顺序接入；取消或失效的确认、取消另存选择器、仅做进程清理都不写结束标记。

持有共用锁后，核对所有会话记录与打开时 SaveSource 的目标、基线和文件身份一致；结束修订不得低于已记录的最大修订。选择最高修订的记录头为锚点，追加不可覆盖的 retired.json，再 sync、回读并验证锚点和标记。锚点可属于尚未完成的检查点，因为丢弃私有意图不要求其已经形成可恢复候选。源 HTML 在外部变化后仍可明确丢弃旧意图，此操作不验证或覆盖外部新内容。

retired 表示标记已核验；没有该会话记录返回 empty，不生成持久的会话结束证明。标记开始写入后未获确认返回 unknown，更早失败返回 failed；cleanupPending 单独报告锁清理。相同会话/修订/原因的完整标记可确认重试，不重写它；部分、损坏或冲突标记要求检查，不能自动覆盖。完整标记禁止该会话所有旧点恢复和后续写入；新会话仍须独立授权。保存原文件的 saved 分类继续使用 committed 证据，不接受 reason=saved 的替代标记。

结束操作保留原 record/baseline/seal 和全部 HTML 字节，不释放记录配额。后续清理必须先处理该会话其他记录，不能先移除结束标记及其锚点而留下旧点，否则会丢失会话已结束的证据。当前没有任何自动裁剪、删除或遗留锁处理。

## 8. 恢复到窗口

可信 [Workspace API](WORKSPACE_SESSION.md) 的 listRecovery 返回 [纯摘要](../src/contracts/recovery.ts)：entries 中只有 sessionId/name/draftRevision/status/active，另有 locked/reviewRequired。不含路径、目标键、检查点 ID、字节或写入位置；多个并发列表请求共用一次进行中的扫描。未选择源文件时不能核验提交或当前基线，dirty 只说明检查点有净意图，不能直接显示成“可恢复”或“尚未保存”。active 是扫描结束时 Main 的会话占用摘要，恢复时仍重新检查。

restore(sessionId, stateRevision, sourceMode) 要求明确 Main 选择器授权，sourceMode 为 file 或 directory，preload 默认 file；不从记录推导路径，也不把 UI 字符串当作目录权限。单文件模式仍以 HTML 父目录为根，目录模式重新选择根与入口。当前窗口仍适用原有离开确认、版本、组合态、输入冻结和故障保护。

[prepareDocument](../src/main/workspace/document.ts) 生成新 Preview 和 SourceIndex，claim 原持久化序列，再由 resolveLatest 取得最新完整 dirty 候选及 Main 私有核验函数。恢复时重查原始文件身份/hash、逻辑目标和完整候选字节；只接收第 6 节的最新点。隔离 registry 的 [restore 协议](../src/contracts/mapping-restore.ts) 只允许 revision=1、无选择或编辑锁的新映射，一批最多 1000 个唯一 Text、每项新文本 64 Ki UTF-16 单元，整批有源大小限制；不含路径或 offset。所有 DOM 目标与旧值在第一次赋值前核验，保持 MutationObserver 开启并逐项核对实际 Text 写入，完成后映射修订变为 2。它不是页面 API，也不伪造用户点击。

Main 只在收到准确确认后发布内存候选；恢复批次若失败或未知，关闭尚未发布的视图并保留原私有记录，不写 HTML。未知异常可能已经改变候选视图的一部分，不能把内部 DOM 操作宣称为原子事务。安装前后再次核验源版本、最新记录 ID/修订/记录 hash 和完整候选 hash；较新检查点或外部文件变化使安装失败。旧草稿的结束标记已确认而新恢复证明失效时，回滚到保留的旧视图，准确保留 retired 状态和故障原因，冻结旧输入并要求恢复，不把新视图报成已安装。

恢复成功时 current.id、source/mapping 身份均为新值；checkpointSessionId 和草稿修订沿用原记录。队列以已核验候选初始化 persisted，不立即重写检查点；下一次有变化的 Apply 推进原修订序列，之后丢弃也结束该原序列，避免旧点再次出现。显式 Save 继续走备份/提交事务，并以实际 committed 新文件版本阻止重复恢复；保存后使用新基线和新的持久化会话。

持久文档准备通过 [Electron profile 所有权](../src/platform/editor-profile.ts) 排除同 userData 的另一编辑进程；其底层 API 见 [Electron 官方文档](https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelockadditionaldata)。[Main 所有权注册表](../src/main/storage/draft-ownership.ts) 按完整私有目录身份链和 sessionId 排除本进程另一窗口/存储对象。进程锁由 Electron 持有至退出，不按 PID/时间删除锁；会话占用只在文档和队列关闭成功后释放。底层只读提取/存储测试端口不自动取得文档所有权；此约束适用于合作的持久编辑进程，并不防御其他同权限程序直接修改私有文件。

打开请求的 abort 只管理准备过程。准备完成交给 Workspace 后，文档持有独立映射生命周期；取消未开始的切换仍由 Workspace 关闭候选，而结束标记开始后的 UI 崩溃不会关闭即将安装的映射。真实 renderer 崩溃测试现已进一步验证重连后仍能选择并 Apply。

## 9. 后续接线与验收

HAE-011 第七阶段提供独立的 [逻辑历史记录](HISTORY.md)，但尚未扩展本文件的私有磁盘格式。现有 v1 检查点导入/导出拒绝带 lineage 的来源，以 DRAFT_HISTORY_UNSUPPORTED 阻止遗漏最初来源证明和 Undo/Redo 分支；Main 存储在获取锁或创建文件前报告失败。正常 Workspace 仍使用原草稿机制。不能把历史记录的内存/JSON 往返称为完整历史的磁盘持久化或重启产品验收。

仍待实现产品恢复控件、结束操作失败后的处理、历史/跨保存撤销重做、产品 Diff 面板及正常产品入口。源码 Diff 的只读数据与保存确认已接入，见 [源码 Diff](SOURCE_DIFF.md)。结束失败/未知时保留的冻结会话目前不能由用户在产品中继续处理；没有强制离开、自动解锁或绕过标记的重试。未应用输入仍是既有 Main 内存状态；没有持久化它，也没有持久化未获 Preview 确认的 uncertainCandidate。检查点候选重建仍由 Main 调用纯核心，Worker 接线与性能预算尚需验证。

证据使用自制文件，覆盖完整候选字节、外部冲突、记录损坏、写入异常、实际进程强杀与原生保存去重。未执行正常产品 UI、真实 IME、Windows 10/macOS、真实磁盘满或断电验收；HAE-011 和 M2 保持未完成。
