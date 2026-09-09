# 草稿检查点与恢复候选

日期：2026-09-09；HAE-011 第一阶段。已实现纯核心逻辑编辑意图与 Main 私有检查点存储，执行记录见 [HAE-011](implementation/HAE-011.md)。调用者须为 Main；当前没有接入每次 Apply、窗口恢复或产品状态提示。检查点成功仅表示该版本的私有证据完成写入和回读，不表示 HTML 已保存。

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

[schema](../src/contracts/draft-checkpoint.ts) 拒绝未知版本、额外字段、路径/offset、重复目标及无效标识。sessionId 是 Main 为一条文档草稿序列分配的 UUID；该序列的 draftRevision 为正整数并严格递增，不能复用于另一文件或内容。最多 1,000 项净文字意图，单项新文字最多 128 Ki 个 UTF-16 code units；实际编码与完整候选仍受核心 5 MiB 限制。record.json 最多 24 MiB，seal 最多 1 KiB。JSON 和原始字节均只在应用私有存储内，Preview 无读取权限。

写入沿用持有文件句柄、sync、完整回读 hash 和目录身份复核；最后再次加载并重建候选。记录不依赖前一检查点，失败不会覆盖或删除旧点。文件 sync 与进程强杀测试不证明断电后目录元数据的持久性。

| 结果 | Main 含义 |
| --- | --- |
| persisted | 此次或同版本既有完整检查点已回读、重建并核验；结果带准确 draftRevision、resultHash 和 checkpointId |
| failed | 未确认形成完整新检查点；可能保留部分文件和锁，不清空内存草稿 |
| unknown | seal 写入已开始但未确认完整结果；重读证据后才能判断，不自动回放 |
| cleanupPending | 与上述状态独立；只移除仍能证明属于本次写入的锁，清理失败保留证据；不能把已确认 persisted 改报未持久化 |

相同 sessionId/revision/base/result/文件身份的重试，可独立验证既有完整点并返回同一 ID；未完成点保留，符合相同修订绑定时可用新 UUID 重试。旧修订、同修订另一候选拒绝。记录头已损坏或归属不明时停止写入，不能绕过证据创建另一份“成功”。

## 3. 与保存共用锁和配额

草稿与 [保存事务](SAVE_PREPARATION.md) 必须放在同一个 Main 私有目录。传入保存存储作提交核验时，两者核对完整目录身份链；不同目录被拒绝，不接收来自页面的路径。两类写入共用 active.lock：保存准备未结束时草稿拒绝，草稿写入未结束时保存拒绝。锁仅协调合作实例；遗留锁不按时间、PID 或候选 hash 自动解除。

每目标合计最多 20 份草稿/保存记录，整个目录合计 200 MiB，根最多枚举 512 项。保存目录最多七个已知文件，草稿目录只有上述三个。配额在同一锁内计算，包含不完整证据；不自动删除最后备份或旧检查点。达到限制明确失败。当前尚无清理/退役流程，接入高频 Apply 前必须完成串行队列、保留策略与失败状态提示。

两种 scan 分别列出自己的记录；检查点列表仅返回身份、修订、hash 和变更数量等摘要。它不选取“最新可恢复点”，也不会在较新点不完整或为空时自动退回旧的有修改点。归零后的完整检查点保留零项 intents 和原始 resultHash，恢复这个明确选择的点得到原基线。最新点选择、明确丢弃后的退役和 UI 确认仍需后续实现。

## 4. 保存后的去重

重启先验证检查点本身，再检查 Main 当前授权的目标。基线完整 hash 与文件版本均相同才为 baseline-matches；错误目标、不可读或版本冲突分别拒绝恢复。仅与 resultHash 相同只能报告 candidate-on-disk，不能当成已保存。

若保存存储存在完整 committed 事务，其目标、旧基线 hash/身份和新 hash 均与检查点对应，并且该 committed 记录的实际新文件版本与当前目标一致，才为 committed-matches。restoreCandidate 对此返回 DRAFT_ALREADY_SAVED，避免保存后、草稿退役前崩溃导致再次应用。实际替换却缺少提交证据、外部重写相同候选字节或保存记录无法读取，都不能冒充这个结果。该分类本身不删除或消费任何记录。

## 5. 后续接线与验收

尚未实现每次 Apply 的异步串行/合并队列、最新已持久化版本与错误提示、重试/退出等待、丢弃或保存后的记录退役、恢复列表与 Preview 安装、历史/跨保存撤销重做和源码 Diff。未应用输入仍是既有 Main 内存状态；本阶段没有持久化它。解析重建目前由 Main 调用纯核心，Worker 接线与性能预算仍需验证。

证据使用自制文件，覆盖完整候选字节、外部冲突、记录损坏、写入异常、实际进程强杀与原生保存去重。未执行正常产品 UI、真实 IME、Windows 10/macOS、真实磁盘满或断电验收；HAE-011 和 M2 保持未完成。
