# 检查点清理中断后的显式恢复

日期：2026-09-10；HAE-011 第十二阶段。Main 可在进程重启或全部文档关闭后，核验并明确继续一次中断的 [检查点清理](CHECKPOINT_COMPACTION.md)，随后通过既有恢复接口重建最新草稿。准备、取消和完成清理都不写 HTML；正常产品入口与恢复控件仍未接入。

## 入口与互斥

[prepareCompactionRecovery](../src/main/storage/compaction-recovery.ts) 只供 Electron Main 使用，参数为已配置的私有目录及重新授权、固定当前版本的 SaveSource。目录必须是当前 userData 的直接子目录，完整身份链继续通过平台检查；其他 profile、项目目录或更深的目录拒绝。Main 取得并持续核验 Electron 进程锁，相关 API 见 [requestSingleInstanceLock](https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelockadditionaldata) 与 [hasSingleInstanceLock](https://www.electronjs.org/docs/latest/api/app#apphassingleinstancelock)。

[私有目录占用注册表](../src/main/storage/draft-ownership.ts) 同时记录活动文档、检查点写入/结束事务、已准备的 Save 与恢复审查。取得恢复审查占用前，这些活动必须全部结束；审查期间拒绝新文档占用和存储写入。已经开始但尚未确认结束的 Save 保留占用。这里不根据 PID、时间戳或源文件同文来判断进程是否退出，也没有通用 force/unlock 方法。

准备返回只供 Main 持有的计划与名称、会话、最新修订、待处理旧点数量等摘要。调用者须在取消或放弃审查时调用 cancel 释放占用；准备仅作有界读取，取消不写任何文件。commit 对同一计划只执行一次并共用 Promise；开始后 cancel 返回 false，不撤销已开始的磁盘操作。新的计划必须重新核验全部证据，不能复用旧 UI 确认。

## 可处理的证据

只接受严格的 v1 compaction.json 和检查点写入锁。锁中必须是规范的 checkpointId；它须对应最新保留点，或当前尚不存在的 UUID（写新点前先腾出容量的情况）。Save/结束事务锁、空锁、没有对应清理记录的锁均不适用。

两个保留点必须仍是同一会话、同一授权目标和原基线的完整 v2 检查点，来源/完整历史与 recordHash 均通过重建校验；最新组须无歧义且未结束，没有更高修订。授权目标的完整 hash、大小、文件身份/版本在准备、确认和每次移除前后重新检查。较新记录、外部同文改写、损坏的保留点或无法归类的其他证据使计划失效。

旧点只允许原记录指定目录下、按原删除顺序剩下的固定文件后缀，或已清空/已移除的目录。每个仍在的文件都核对原完整 hash、大小、版本与目录身份。目录换名、文件替换、未知文件和异常缺口均拒绝。其他会话、失败记录、结束锚点和 Save 备份保持原样。

## 持久记录与完成顺序

[严格格式](../src/contracts/compaction-resolution.ts) 在原私有根下追加两份文件：

| 文件 | 内容与约束 |
| --- | --- |
| `compaction-<id>.json` | 最多 128 KiB；版本、compactionId、createdAt、原 journal/lock 的准确 UTF-8 文本与 hash/大小/文件版本。文本必须解析为对应的严格格式，不能夹带路径或强制参数 |
| `compaction-<id>.complete.json` | 最多 1 KiB；版本、compactionId、前一文件的完整 hash、complete 阶段。只证明所选旧点的移除已核验，不表示 HTML 保存或新草稿写入 |

两份文件均独占创建、同步和回读，不覆盖失败尝试。原始 journal 与锁有了完整可读副本后，才继续旧点删除；每一步复查 profile、授权目标、两个保留点、原锁和已形成的恢复记录。所有旧目录确认消失后，先写并核验 complete，再移除仍是原版本的 compaction.json，最后移除仍是原版本的 active.lock。文件删除继续使用固定名称和非递归平台方法。

两份追加记录持续保留，计入 200 MiB 字节预算和 512 项枚举预算；不占“每目标 20 项草稿/保存记录”的名额。写恢复记录和完成标记前都检查剩余容量。普通 catalog、检查点写入和 Save 验证这些记录：完整已结束记录可正常保留，部分/损坏/孤立记录阻止写入和恢复，不能忽略它们释放空间。已结束记录是历史证据，之后正常清理可以移除它所曾保护的旧检查点。

## 中断与返回值

[执行器](../src/main/storage/resolve-compaction.ts) 返回 resolved / failed / unknown 及有界错误。resolved 要求完成标记已核验、原清理记录和准确匹配的锁均已移除；之后的回调失败只附警告，不改报未完成。failed 表示本次确认尚未开始磁盘变更；开始记录/删除后未获确认则为 unknown，保留仍存在的证据。

原 compaction.json 仍在时，新的显式计划必须同时匹配其内容/版本与已有恢复记录。原 journal 已移除而锁仍在时，只接受有有效 complete 的恢复记录，并重新核验源文件、保留点和全部旧目录确已消失，再移除对应旧锁。完成标记与锁副本使这一中断窗口可继续处理，不能凭“journal 不见了”直接解锁。锁已经移除后，普通最新草稿恢复正常工作；读取或启动本身不会继续删除。

恢复记录或 complete 本身写入不完整、当前文件冲突、较新检查点、其他未知记录以及无精确清理证据的旧锁继续保留，需要后续故障处理。当前不提供活动文档的暂停/解冻、Save/结束事务旧锁处置、跨会话/备份清理，也不自动删除恢复审查记录。

## 验证边界

[存储实验](../tests/unit/compaction-resolution.test.mjs) 覆盖准备/取消零写入、实际存储事务互斥、重写与损坏拒绝、中途失败后再次明确处理，以及三个真实进程强杀点。底层 Node 测试使用 profile 检查回调替身，不能证明 Electron 进程占用；[真实窗口与进程实验](../tests/history/workspace.ts) 另外执行真实 profile 竞争拒绝、进程退出后的 Main 恢复、生产 Workspace 恢复/Undo/Windows Save 及源文件/CSS 完整字节核对。

实现仍是合作实例协议及路径式文件操作，不声称对同权限敌对进程的强 CAS。Windows 10/macOS、真实对话框与 IME、产品恢复界面、磁盘满/断电及全尺寸性能均未验收。实际执行结果见 [HAE-011](implementation/HAE-011.md)，M2 保持未完成。
