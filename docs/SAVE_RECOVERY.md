# 保存中断后的明确处置

日期：2026-09-10；HAE-010 第五阶段。Main 可在重新取得同一 Electron profile、存储没有活动文档或事务后，审查一个完整保存事务留下的锁。明确选择保留重新授权的当前文件后，保存审查证据并释放准确匹配的旧锁；不执行旧 Save、不写 HTML，也不把未确认结果改记为已提交。正常产品入口和恢复控件仍待接入。

## 授权与结果

[prepareSaveRecovery](../src/main/storage/save-recovery.ts) 只供 Main 调用：传入当前 userData 的直接私有子目录、新授权且固定完整版本的 SaveSource，以及可信安装位置的原生助手路径。准备检查 profile 进程锁与 [目录占用注册表](../src/main/storage/draft-ownership.ts)，审查期间排除新文档、检查点写入/结束和 Save；已开始但未确认结束的本进程 Save 不释放占用，需要进程结束后重新审查。没有 renderer 路径、helper、解锁或恢复方法。

准备返回冻结的摘要及 cancel / commit。准备和取消不写 HTML 或私有事务证据；commit 必须明确传入 `keep-current`，绑定准备时的源文件和证据版本。重复 commit 共用一个 Promise，开始后 cancel 返回 false。新确认不能覆盖旧审查记录，也不能根据 PID、时间或文件同文猜测旧操作已经退出。

| observed | 证据所支持的含义 | 完成处置后的限制 |
| --- | --- | --- |
| baseline-matches | 当前完整字节和文件版本仍匹配原基线 | 可按既有验证恢复已持久化草稿；不自动重新保存 |
| committed-matches | 严格 committed/replacing 记录、候选 hash 与当前结果身份一致 | 既有 v2 历史恢复可重新证明并建立干净基线；不重复回放 |
| candidate-on-disk | 字节匹配候选，但没有对应的已验证提交证据 | 保持未确认，不能制造 committed 或恢复旧历史 |
| conflict | 当前文件与已记录的版本/结果冲突 | 保留当前文件和旧证据，不能将旧草稿直接回放到它 |

后两类的 keep-current 是一次新的明确决定，不是对旧 Save 成功的确认。之后如需恢复旧备份，仍须通过 [prepareRestore](SAVE_PREPARATION.md#main-显式备份恢复)，把当时重新授权的当前文件先备份，再显式替换。恢复审查本身没有重试旧事务或覆盖当前文件的路径。

## 原生占用检查

确认时 [Windows guard](../src/platform/windows-recovery-guard.ts) 运行同一可信 [助手](../src/platform/windows/ReplaceHelper.cs) 的独立 review 模式。它只以 OPEN_EXISTING / GENERIC_READ / FILE_SHARE_READ 打开授权 HTML，核验完整 hash、身份、目录链及最终路径，并持续持有文件和目录句柄直到私有审查结束。现存写入/删除句柄使打开失败；持有期间也拒绝新的写入和换名。共享约束见 [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)。

review 协议只有 guarded 和 reviewed 回执以及 finish-review 指令，绑定内部事务 UUID 和固定源版本；不接受 replace、candidate 或任意操作名。该分支不创建 sidecar、不改权限、不写或删除 HTML。输出上限 8 KiB、总时限 30 秒；异常会终止助手并等待退出，Main 不会在未等待自身工作结束时释放目录占用。开始私有写入前及最终移除锁前仍复核 guard、profile、当前文件和证据。

这不是对同权限敌对进程的全面强 CAS。Windows 文件共享标志不覆盖全部元数据修改，路径操作与最终检查仍存在平台边界；不把本节点描述为历史 ACL/ADS 的恢复或断电持久性保证。当前只提供 Windows 本地固定驱动器的 guard，其他平台明确拒绝。

## 持久记录与崩溃窗口

只接受严格 `{version, transactionId, targetKey}` 保存锁和完整有效的 prepared / cancelled / replacing / committed 事务。原有 intent、backup、candidate、prepared 及相关阶段记录均核验；缺失、损坏、混合文件、错误目标、其他无法归类记录和检查点/结束事务锁拒绝。既有 v1 普通保存与 v2 备份恢复记录保持兼容。

[审查记录格式](../src/contracts/save-resolution.ts) 在私有根追加 `save-resolution-<id>.json`（最多 16 KiB）：版本、事务/目标 ID、决定、观测分类、当前源 hash/大小/身份、原锁文本及版本、原事务目录身份和每个固定文件的 hash/大小/身份。它没有绝对路径或页面 offset，不复制原始 HTML 到 renderer。

[执行器](../src/main/storage/resolve-save.ts) 在原生 guard 内，先独占创建、sync、回读审查记录，再追加并验证 `save-resolution-<id>.complete.json`（最多 1 KiB），最后只移除仍精确匹配的 active.lock。完成标记绑定审查记录 hash，表示明确决定已记录；锁尚在时仍须再次审查才能释放。原事务目录、备份、候选、历史和原生 sidecar 全部保留。

在审查记录或完成标记已完整落盘后中断，可通过新的明确确认继续，前提是当前文件、原锁、原事务及已有审查记录仍完全匹配。锁移除后，普通读取不再要求重新处理该锁，但也不会因此把 candidate-on-disk/conflict 改为 committed。返回 resolved 仅表示本次处置已完成；完成后的回调/guard 收尾异常附警告。开始私有变更前失败返回 failed，开始后未确认返回 unknown。

两份审查记录持续保留，计入共享 200 MiB / 512 项预算；不占每目标 20 个草稿/保存事务名额。[读取器](../src/main/storage/save-resolutions.ts) 在普通 Save 与检查点枚举/写入前验证记录、完成标记及原事务的固定文件版本。部分、孤立、损坏或被替换的审查证据阻止新写入与恢复；不得删掉它们绕过限制。未来清理必须同时保护审查记录与其原事务，不能只删除其中一端。

## 验证与未完成项

[存储实验](../tests/unit/save-resolution.test.mjs) 使用真实文件、Windows 助手和被强杀的子进程，覆盖准备/取消、完整各阶段、文件占用、改写/冲突、审查中断以及单独备份恢复。底层 profile 回调替身不代替进程所有权验证；[Electron 进程实验](../tests/history/save-recovery-child.ts) 另外验证真实 profile 竞争、强杀后 Main 接管、生产文档历史恢复/Undo，以及提交未确认时拒绝旧历史回放。完整执行证据见 [HAE-010](implementation/HAE-010.md)。

未完成：部分保存事务、空锁、部分/冲突审查记录的后续处置，活动窗口内存状态的暂停/解冻，结束事务锁，跨会话/备份/sidecar 清理，产品恢复向导。Windows 10/macOS、真实 IME/对话框/报告操作、磁盘满/断电与全尺寸性能仍待验收；M2 保持未完成。
