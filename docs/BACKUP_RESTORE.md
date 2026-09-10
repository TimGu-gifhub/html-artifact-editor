# 窗口中的备份恢复

日期：2026-09-10；HAE-010 第六阶段。Main 备份服务与统一 Workspace 已接通，真实 Electron 生产 transport 可列出当前文件的备份并请求单独确认恢复。HAE-009 已接入正常应用、产品备份列表及单独的原生确认；本合同不代表 M2 人工验收。

## 接口与权限

[createBackupRestorer](../src/main/storage/backups.ts) 使用 Main 已拥有的保存 store。Workspace 的可选 `backups` 端口与 `reviewBackup` 决策回调由 Main 安装；未安装时返回 BACKUP_RESTORE_UNAVAILABLE。文件路径、当前版本、原始备份字节、原生助手路径和事务句柄均留在 Main。

| 可信接口 | 行为 |
| --- | --- |
| `listBackups(documentId)` | 核验当前源版本后只读枚举同一 targetKey 的完整有效备份；返回绑定 documentId 的元数据 |
| `restoreBackup(documentId, stateRevision, reference)` | 按当前窗口/文档版本请求恢复；reference 严格为 transactionId 和 intentHash，不是路径或任意字节 |

[备份元数据](../src/contracts/backup.ts) 仅含 reference、创建时间、字节数和完整 hash；列表另含 locked/reviewRequired。它不返回私有记录、文件身份、targetKey、备份内容或绝对路径。prepared/cancelled/replacing/committed 的完整备份都可列出，记录不完整/损坏则提示检查；列出不等于当前可以提交。目录、字节和记录数沿用 [存储配额](SAVE_PREPARATION.md)，同一目标最多返回 20 项；Workspace 同时只运行一个列表读取，相同文档的并发请求共用结果，换文档后的旧结果拒绝。

命令继续使用 [可信主框架 transport](WORKSPACE_SESSION.md)。Preview 没有备份能力，renderer 不能传 path、bytes、force、备份元数据或确认决定。备份选择只定位 Main 私有命名空间中的已验证记录，不扩大项目授权。

## 单独确认与冻结

1. 当前映射/历史必须可用，输入协调器须空闲。组合输入、未应用输入和已应用但未保存的净变化分别拒绝为 INPUT_COMPOSING、UNAPPLIED_INPUT、UNSAVED_CHANGES；不隐式 Apply、丢弃或另存。
2. Main 在询问前读取并固定源文件及备份的版本。来源 proof 持续保留 intent/backup 的目录身份、文件版本和 hash；不能在确认后重新读取并悄悄采纳另一个同内容版本。
3. `backupReview` 包含随机 reviewId、documentId、当前显示文件名/hash 及所选备份元数据。Main 的 `reviewBackup` 回调只接受绑定同一 reviewId 的 restore/cancel 决定。回调取消、迟到或期间输入改变不创建恢复事务、不写 HTML。
4. 确认 restore 后，InputController 进入 leaving，阻止编辑、保存、打开和窗口关闭。先排空当前私有持久化队列；已有编辑历史时，最新干净检查点的修订/hash 必须精确匹配。未确认或清理待处理则阻止替换；事务开始前失败释放输入，保留历史与证据。
5. 调用已固定 proof 的准备闭包，重新核验备份和当前版本；创建并独立回读恢复前文件的完整备份，再通过既有 Windows 原生事务替换。

当前文件已等于所选备份时返回 unchanged，不显示恢复成功、不创建事务、不重置历史。原有 requiresReview 状态先行阻止请求，不能用无变化检查消除遗留故障。

## 结果与新基线

恢复替换的是完整 backup.bin 字节，保持其中 BOM、行尾、实体、注释及其他源码。新 v2 intent 的 restoreOf 绑定来源记录，恢复前当前文件成为新 backup.bin，可在另一次明确恢复中使用。原记录不删除、不消费，锁、配额、冲突检查及平台限制沿用 [保存事务](SAVE_PREPARATION.md)。历史 ACL/命名数据流不在备份中；平台适配器继续保护当前文件元数据。

Main 必须核验实际文件版本与 committed 记录，再用相同项目授权重新读取、解析并建立全新映射。原生试挂载前后再次核验文件/提交证明及新映射，全部通过才发布新的 current.id，并结束旧文档。原请求的 documentId 仍指向旧文档，不能误认成新文档的操作结果。

整份备份恢复建立新的干净逻辑历史；不迁移旧 Text 身份、偏移、lineage 或 Undo/Redo。旧私有历史仍作为证据保留，版本校验阻止自动回放；新文档中的后续编辑/Undo/Save 仍走正常路径。恢复前状态可通过本次新建的反向备份再次明确恢复。

`lastSave.operation` 为 backup-restore；status/outcome 成功值为 backup-restored，与只恢复草稿的 restored 区分。未开始的取消为 cancelled；失败/未知和基线重建失败分别报告 failed/unknown/rebase-required。已开始但无法确认的事务或已提交但未能安装的新文档保留旧窗口、冻结输入和全部证据，以 requiresReview 阻止盲目重试。核验恢复成功后的清理警告保留 ok=true，与文件失败分开报告。

renderer 撤销在确认期间立即结束等待；迟到确认没有效果。准备完成但未开始 commit 时可取消并保留私有证据。开始 commit 后，Main 独立核验结果并完成新基线，即便原 renderer 已崩溃；重新连接只读取当前状态，不再次写文件。

## 验证范围

[六项存储审查测试](../tests/unit/backup-review.test.mjs) 覆盖元数据/字节副本、错误目标/引用、intent/backup 同文改写、当前源版本变化、取消与平台端口缺失。[十四组真实窗口实验](../tests/save-session/backup.ts) 覆盖生产 preload/IPC、Windows 恢复和再次保存、草稿保护、过期确认、持久化排空、实际 renderer 崩溃、未知结果、原生挂载失败、提交后外部改写和清理警告。完整执行记录见 [HAE-010](implementation/HAE-010.md)。

实验使用自制报告、空白可信 transport 页面及 Main 确认回调；没有产品控件或真实 IME/原生确认对话框验收。当前窗口故障后的处置、部分事务/锁、跨会话备份清理、Windows 10/macOS、真实磁盘满和断电仍待完成。
