# 已被替代检查点的有界清理

日期：2026-09-10；HAE-011 第十一阶段。此流程让同一 Main 文档持续写入完整历史检查点，避免每次 Apply 永久增加一个记录名额。正常产品入口仍只读；本合同不代表恢复故障界面或 M2 验收完成。

## 清理范围

只有 Main 当前持有 sessionId 所有权、正在写入 v2 完整历史的序列会触发清理。每个 v2 点独立保存原始来源、当前基线、完整操作链、保存点和 Redo，不依赖旧点拼接。保留最近两个无歧义的完整修订，以及这两个修订的重复完整尝试；只清理更低修订的完整 v2 点。

不完整、损坏或同修订结果/历史冲突的记录继续保留。最新修订不完整时不清理旧完整点；出现结束标记则禁止该序列继续写入。其他会话、旧 v1 点、所有保存事务和备份都不在自动删除范围内。因此 [结束标记](DRAFT_CHECKPOINTS.md) 的锚点及 [saved 历史恢复](HISTORY.md) 的后续会话证据不会被这个流程移除。

没有文档所有权的 Main 存储读写/诊断接口仍保持原记录保留方式，不会因读取或直接重试就自动清理。所有权由 [文档准备](../src/main/workspace/document.ts) 取得，不接受 Preview 提供的会话或路径能力。

## 锁与容量

[检查点写入器](../src/main/storage/checkpoints.ts) 沿用当前 active.lock 完成写入与清理，Save、其他写入者和第二进程不能插入这个合作事务。通常先确认新点完整写入/回读，再清理被替代的旧点；已有旧序列达到容量时，可先依据其最近两个完整点清理，再写新点。后续新写入失败仍保留这两个既有点。

每目标合计 20 项保存/草稿记录、私有目录 200 MiB、根枚举 512 项的限制保留。清理记录也必须在剩余字节预算内，不能为清理绕过配额。正常单个活动序列可保持两个完整点并持续编辑；保存备份、其他序列、失败/歧义记录及历史本身的 1000 操作/8 MiB 限制仍会消耗容量，需要后续明确的生命周期管理。

## 删除前的记录

[compaction schema](../src/contracts/checkpoint-compaction.ts) 是私有 v1 格式，独占创建根目录的 compaction.json，最多 64 KiB：

| 字段 | 约束 |
| --- | --- |
| compactionId / sessionId / createdAt | 内部 UUID、当前序列及记录时间；不按时间推断最新点 |
| retained | 两个完整锚点的 checkpointId、recordHash、draftRevision；按修订递减 |
| obsolete | 1–18 个更低修订的完整点；绑定其 ID、recordHash、修订和实际目录 dev/ino |
| obsolete.files | 固定顺序的 origin.bin、baseline.bin、complete.json、record.json；每个文件的大小、完整 hash、dev/ino/mtimeNs/ctimeNs |

schema 拒绝额外字段、路径、重复 ID、错误修订关系、未知文件名及无效身份。记录没有可执行 HTML 偏移、绝对路径、任意文件名或强制删除参数。保留点与待删除点在准备时都通过完整私有检查点重建校验；journal 写入、sync、回读并核验之后，才开始删除。

## 执行与复核

[Main 清理器](../src/main/storage/checkpoint-compaction.ts) 在每次移除前核验当前锁、清理记录以及两个保留点，包括完整历史/来源校验和未结束状态。[平台适配器](../src/platform/checkpoint-removal.ts) 只接受已检查私有根下的 UUID 直接子目录和四个固定文件名；核对文件内容、大小、完整版本、目录链和目录身份后逐个移除。record.json 最后删除，目录只能在为空且仍是原目录时移除。没有递归删除、通配符、任意路径或项目 HTML 删除方法。

所有列出的旧目录确认消失后，才删除本次仍有准确身份/hash 的 compaction.json，最后由原写入者释放自己的锁。已删除的旧点不再计入记录数或字节数，保留点的原始字节不修改。所用 [Node unlink](https://nodejs.org/api/fs.html#fspromisesunlinkpath) 与 [空目录移除](https://nodejs.org/api/fs.html#fspromisesrmdirpath-options) 是路径操作；这些复核和合作锁不构成对同权限敌对进程的强 CAS，最后检查与 OS 操作之间仍存在竞态。也不把文件 sync 或进程强杀等同于断电后的目录元数据持久性。

## 失败与中断

新检查点已经确认写入后，清理失败仍返回该准确修订的 persisted，同时设置 cleanupPending 和 DRAFT_COMPACTION_FAILED / DRAFT_COMPACTION_UNKNOWN；不会把较新内存草稿说成已持久化。清理记录开始写入或删除已开始而结果未确认时，保留锁和仍存在的清理记录，停止自动写入与普通重试。最终记录已移除但完成回调未确认时仍保留锁，不重建已删除记录或自动解锁。后来确认的 Apply 可以继续留在 Main 内存队列，原文件 Save 仍受实际锁阻止。

如果在新点写入前为容量执行清理并失败，新点不报告 persisted。部分/损坏清理记录或残留空目录在 catalog 中要求检查，恢复不会绕过它们。重启只做有界读取，不自动继续删除、移走记录、解除旧锁或猜测清理已经完成。原请求关闭只有在 Worker/队列/视图确认结束后才释放会话占用；磁盘锁和故障证据继续保留。

## 验证范围

[存储测试](../tests/unit/checkpoint-compaction.test.mjs) 验证超过旧 20 点上限的连续写入、全部 Undo/Redo、预先满额序列、其他会话/结束锚点/备份/不完整与歧义证据保留、八个清理故障边界、文件/目录替换拒绝和三个进程强杀点。[窗口实验](../tests/history/workspace.ts) 通过生产 IPC 逐项持久化 24 次 Apply、恢复完整历史、Undo 后显式 Windows Save，以及后台清理失败的准确状态与停止写入行为。

实际命令与结果记录在 [HAE-011 交付记录](implementation/HAE-011.md)。测试使用自制文件和专用临时私有目录；Windows 10/macOS、真实磁盘满/断电、满尺寸交互性能和产品恢复界面仍未验收。

第十二阶段提供 [中断后的显式恢复](COMPACTION_RECOVERY.md)：重新核验 profile、无活动文档/事务、授权源文件与精确锁/清理证据后，Main 可以继续指定清理。先保存原记录与锁的副本，完成旧目录移除后封存完成标记，最后移除原 journal 和对应锁；取消只读，读取/重启不自动执行。未知锁或部分恢复记录继续保留，正常产品控件尚未接入。
