# 草稿检查点与恢复候选

日期：2026-09-09；HAE-011 第三阶段。已实现纯核心逻辑编辑意图、Main 私有检查点存储、可选窗口持久化端口，以及 Main 最新点选择和会话结束标记，执行记录见 [HAE-011](implementation/HAE-011.md)。调用者须为 Main；正常产品入口与恢复界面尚未接入。检查点成功仅表示该版本的私有证据完成写入和回读，不表示 HTML 已保存。

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

Main 给 [createWorkspaceSession](../src/main/workspace/session.ts) 提供同目录的 checkpoints 端口后，每份文档创建独立 [持久化队列](../src/main/draft/persistence.ts)，固定打开时 SaveSource、SourceIndex 和文档会话 ID。没有此端口时 current.persistence=null；正常产品入口尚未安装这个端口。

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

文档关闭先阻止新输入和排队，再等待已开始写入及正常待写候选排空，之后关闭 Preview；失败停止状态不会因关闭自动重试。此等待不是“所有最新草稿均已持久化”的保证：失败版本仍由状态明确报告，脏文档离开继续要求既有明确决定。当前 Workspace 离开流程尚未调用下面的结束标记接口，不能据此直接提供完整的重启恢复选择流程。

## 6. 会话目录与最新恢复候选

catalog 按 sessionId 分组，只返回 Main 元数据，不保留整批意图或源字节。选择依据是最大的 draftRevision；createdAt 只作记录，不能用时钟顺序替代修订顺序。同一会话混用目标/基线/文件身份、最高修订出现不同 resultHash 时为 ambiguous。最高修订只有部分或损坏记录时为 incomplete/invalid，不回退旧点；相同绑定和结果的完整重试可替代同修订未完成尝试。

完整最新点按净意图区分 dirty/clean；只有精确提交证明才为 saved，只有有效结束标记才为 retired。targetState 单独说明当前授权目标的 baseline-matches、conflict、candidate-on-disk、unavailable 等状态。归属不明的记录头或损坏的结束标记同时列入 unclassified，设置 reviewRequired，避免损坏的标记锚点使旧会话重新成为可恢复草稿。locked 独立报告遗留或活动锁。

restoreLatest(sessionId, source, index) 只为 dirty 且 baseline-matches 的最新完整点重建内存候选；有锁或无法归类的证据则拒绝。重建前后重新选择，并要求检查点 ID、修订、记录 hash 和完整候选 hash 一致。明确读取某个点的 restoreCandidate 仍须 Main 授权和源版本复核，也拒绝已结束会话及无法归类的证据；它仅用于提取候选，不能拿旧点读取绕过正常最新点决策。两个接口均不安装 Preview、不写 HTML、不解除锁。

## 7. 明确结束一个持久化会话

Main retire(source, sessionId, draftRevision, reason) 的前置条件是：已取得明确丢弃决定或已核验的另存副本结果，冻结该会话的新编辑并排空写入。接口不接收页面提供的路径，也不自行作离开决定。当前还没有接入 Workspace 的丢弃/另存离开流程。

持有共用锁后，核对所有会话记录与打开时 SaveSource 的目标、基线和文件身份一致；结束修订不得低于已记录的最大修订。选择最高修订的记录头为锚点，追加不可覆盖的 retired.json，再 sync、回读并验证锚点和标记。锚点可属于尚未完成的检查点，因为丢弃私有意图不要求其已经形成可恢复候选。源 HTML 在外部变化后仍可明确丢弃旧意图，此操作不验证或覆盖外部新内容。

retired 表示标记已核验；没有该会话记录返回 empty，不生成持久的会话结束证明。标记开始写入后未获确认返回 unknown，更早失败返回 failed；cleanupPending 单独报告锁清理。相同会话/修订/原因的完整标记可确认重试，不重写它；部分、损坏或冲突标记要求检查，不能自动覆盖。完整标记禁止该会话所有旧点恢复和后续写入；新会话仍须独立授权。保存原文件的 saved 分类继续使用 committed 证据，不接受 reason=saved 的替代标记。

结束操作保留原 record/baseline/seal 和全部 HTML 字节，不释放记录配额。后续清理必须先处理该会话其他记录，不能先移除结束标记及其锚点而留下旧点，否则会丢失会话已结束的证据。当前没有任何自动裁剪、删除或遗留锁处理。

## 8. 后续接线与验收

仍待实现离开决定与结束标记协调、恢复列表与 Preview 安装、历史/跨保存撤销重做、源码 Diff 及正常产品状态控件。未应用输入仍是既有 Main 内存状态；没有持久化它，也没有持久化未获 Preview 确认的 uncertainCandidate。解析重建目前由 Main 调用纯核心，Worker 接线与性能预算仍需验证。

证据使用自制文件，覆盖完整候选字节、外部冲突、记录损坏、写入异常、实际进程强杀与原生保存去重。未执行正常产品 UI、真实 IME、Windows 10/macOS、真实磁盘满或断电验收；HAE-011 和 M2 保持未完成。
