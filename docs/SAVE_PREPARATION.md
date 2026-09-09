# 保存事务与私有证据

日期：2026-09-09；HAE-010 第四阶段。准备服务创建私有备份、候选和记录；明确调用 Main 的 commit 才进入 Windows 原生替换。现通过 Workspace 的可选 Main 端口和可信 save 命令验证保存及新基线，另提供 Main 显式备份恢复事务；正常产品窗口与恢复向导尚未接入。`prepared` 表示准备证据可读，不表示 HTML 已保存，也不是可以跨异步步骤复用的替换权限。执行范围见 [阶段记录](implementation/HAE-010.md)。

## Main 调用边界

[openSaveSource](../src/platform/save-source.ts) 只接受 Main 已授权的 HTML 路径和打开时的原始字节；复制字节，核对完整 hash、实际目录链、普通文件/单一链接、dev/ino、mtimeNs/ctimeNs。后续 verify 重读同一路径并复核版本；外部写入、换回原字节、删除、硬链接或目录替换均阻止准备。targetKey 是文件系统规范路径的 SHA-256，不使用全局大小写折叠猜测 Windows 目录规则。

[createSavePreparationStore](../src/main/storage/preparation.ts) 由 Main 指定应用私有数据下的专用、已存在目录；不能使用预览项目根或 UI 传入的路径。新建子目录不递归，目录身份和实际路径持续复核；Preview 的 userData/sessionData 排除规则继续适用。

`prepare(source, candidate)` 的 candidate 来自 Main 已核验的纯字节 Patch 流程。此存储层检查 baseHash、结果 hash、大小并复制候选，不能替代源码映射和 Patch 语义核验。无净变化不创建事务。返回 failed 或 prepared，prepared 含 Main 可用的 cancel/commit 方法；失败不清除调用者的原输入/候选。

第三个工厂参数是 Main 创建的 [平台替换适配器](../src/platform/windows-replacement.ts)。Windows 工厂只接受可信安装目录中的 ReplaceHelper.exe 绝对路径，固定并复核其字节；禁止从工作目录猜测、从 journal 或页面取得执行路径。未提供适配器时 commit 返回 SAVE_PLATFORM_UNSUPPORTED，仍可取消。

[OriginalSaver](../src/main/storage/original.ts) 组合 prepare/cancel/commit，并为提交结果提供 Main 私有的 verifySaved 回调。Workspace 在打开文档时捕获 SaveSource，显式保存冻结的草稿；UI 撤销只能取消尚未开始的替换，已开始的 commit 必须继续确认结果。只有新文档的源版本、结果 hash、committed 记录和映射全部通过才发布 saved；重建失败保留旧候选，清理警告与失败分开。renderer 仅能传 documentId 和状态版本，不接触 store、回调、记录目录或任意文件路径。状态合同见 [统一窗口会话](WORKSPACE_SESSION.md)。

## 准备顺序

1. 复核源文件版本，以 O_EXCL 在专用私有目录创建 `active.lock`；同一存储目录全局串行，第二实例拒绝。同一对象还拒绝重复请求。
2. 检查现有记录与预算，创建随机 transactionId 子目录。
3. 独占创建 `intent.json`：版本、事务 ID、targetKey、显示文件名、身份/时间戳、旧/新 hash 与字节数、创建时间；没有绝对路径或页面偏移。
4. 独占写 `backup.bin`，保持句柄写入、sync、回读 hash 和身份；再独立读取一次备份核验。
5. 再检查源文件；独占写 `candidate.bin` 并同样回读核验。
6. 独占写 `prepared.json`，包含原 intent 文件的 hash；重新读取完整证据与源版本，通过后才返回 prepared。

文件保留原始 BOM、行尾和实体字节；候选直接使用已核验的完整结果，不重新序列化 DOM 或重新编码。私有文件请求模式 0600、目录 0700；这不是 Windows ACL 保密性或目录项断电持久性的验收结论。

正常取消独占写 `cancelled.json`，然后只删除本调用拥有且内容/身份仍匹配的锁；备份、候选和记录全部保留。重复取消共用同一结果；取消失败或锁被改动时保留锁。准备失败后可释放本调用已验证的锁，但不删除部分证据；创建锁本身出现未知结果时也不会猜测删除。

实际进程终止会留下锁，即使它是空文件。不按 PID、时间或记录状态自动解除，不盲目重试。第五阶段为完整事务提供 [保留重新授权当前文件的明确处置](SAVE_RECOVERY.md)，在新决定与原生占用保护下释放精确匹配的旧保存锁；空锁、部分事务和通用 force/unlock 仍不支持。

## Windows 显式提交

1. Main 重读私有锁、intent、原始备份及候选，核对与本次准备固定的 hash 一致。
2. 适配器检查源版本和整个目录链，使用 O_EXCL 写同目录 `.hae-<transactionId>.tmp`，sync 并核对完整字节和身份。这个命名空间只接受内部 UUID，没有一般项目文件删除方法。
3. [原生助手](../src/platform/windows/ReplaceHelper.cs) 固定目录链的身份并保持拒绝删除的目录句柄；根驱动器除外。源文件句柄禁止并发写入，要求读取、写入、删除和 DACL 维护权限，复核版本/hash、创建时间、安全描述符和附加数据流。只读属性、重解析点、多硬链接、离线占位和不支持位置均拒绝。
4. 助手校验临时候选，并用 CREATE_NEW 预留 `.hae-<transactionId>.backup` 空文件；已有名称拒绝。报告 ready 后等待 Main，不自行替换。Main 再次检查证据与源文件，独占写入、sync、复核 `replacing.json` 后才发送 replace。
5. 助手最后检查源路径/句柄、候选和备份预留身份，调用同卷 ReplaceFileW，flags 为 0；不先删除原 HTML，不使用忽略 ACL/合并错误的选项，也不做不安全的 rename 回退。任何调用后的失败均为 unknown。[微软替换语义](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew)。
6. 助手保持新目标拒绝写入/删除的读取句柄，核对候选身份/新 hash、被移走的原文件/旧 hash、创建时间、DACL、所有者/组及命名数据流。Main 再独立回读同一目标，核对助手报告的身份和新 hash，独占写 `committed.json` 并 sync、回读、关联检查；完成后才向助手确认 commit。
7. 助手只通过仍持有的旧文件句柄标记删除已经核验的 `.backup`，Main 只删除仍属于自己的私有锁。私有 backup.bin、candidate.bin 和全部 journal 保留。HTML 已提交但清理失败时返回 committed + cleanupPending；不误报成未保存，也不自动启动第二次替换。

commit 同步固定唯一 Promise；重复调用共用结果。启动后不能用 cancel 写入虚假的取消记录。已开始的提交即使在替换前已知失败，也保留锁和证据，由后续恢复流程处理。助手协议为带版本/随机事务 token 的有限 JSON 行，顺序和字段校验、输出上限 8 KiB、总时限 30 秒；断开或协议异常先终止助手并等待退出，再返回。替换指令发出后没有完整结果就是 unknown；若 Main 已验证 committed，随后失联只意味着清理待处理。

Windows 的 ReplaceFileW 会升级某些旧式 ACL 的继承格式。实现比较实际 ACE 字节、顺序、所有者/组及保护等控制位，仅忽略格式标记 SE_DACL_AUTO_INHERITED；不忽略 ACE 的 inherited 位。发现差异时，在结果句柄禁止删除且目录句柄固定的范围内，通过 SetFileSecurityW 仅恢复原 DACL，再完整复核。该兼容 API 已被微软标记为 obsolete；采用它是因为实测推荐的 SetSecurityInfo 会重算这些继承位。此处不提升权限、不修改目录权限，不使用对文件不推荐的 SetKernelObjectSecurity。[文件安全 API](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-setfilesecurityw)、[继承传播规则](https://learn.microsoft.com/en-us/windows/win32/secauthz/automatic-propagation-of-inheritable-aces)。

数据流通过句柄枚举并读取后比对，最多 128 项、名称缓冲 64 KiB、命名流总字节 5 MiB；原有 Zone.Identifier 等流保留，临时候选额外带命名流则拒绝。流信息由文件系统提供，不能当作所有文件系统支持的承诺。[数据流结构](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_stream_info)。SACL 审计、对象 ID、短文件名、EFS/压缩卷和其他元数据未独立验收。

本阶段原生替换仅接受 Windows 本地固定驱动器。源/临时/备份叶子在 ReplaceFileW 时必须允许删除或关闭句柄，因此最后复核到 OS 操作之间仍有换名竞态；ACL/属性及命名流也不能靠普通共享标志完全锁定。结果复核失败保留原始证据并报告未知，不宣称强 CAS。权限还原发生在替换后，崩溃可能停在权限格式合并之后；恢复检查尚不具备完整元数据还原功能。

## 重启只读检查

`scan()` 只枚举有界私有命名空间，报告 records、locked、unrecognized；不会从 journal 自动打开用户文件。每项记录可用 `inspect(transactionId, readTarget?)` 检查。readTarget 只能由 Main 对已重新选择/授权的源文件提供，不接受记录内的路径。目标尚未选择时状态为 unavailable。

| 状态 | 含义；均不触发写盘 |
| --- | --- |
| incomplete / invalid | 准备文件缺少，或 schema/大小/身份/hash/记录关联不成立；保留证据 |
| unavailable / wrong-target | 尚未取得可读授权目标，或重新选择的规范路径键不同 |
| baseline-matches | 目标 key、旧 hash、dev/ino 与两个时间戳均匹配 |
| candidate-on-disk | 相同目标的当前 hash 等于候选；不能据此标记 committed 或自动重试 |
| committed-matches | 完整 committed 记录关联原 intent，当前目标同时匹配新 hash 与记录的 dev/ino/mtimeNs/ctimeNs |
| conflict | 目标内容或文件版本不同，包括外部改写后恢复旧字节 |

intent/seal/commit 严格按 [纯 schema](../src/contracts/save-record.ts) 检查；普通 intent 为 v1，恢复 intent 为 v2，增加精确的 restoreOf 字段；seal/commit 仍用 v1 并绑定各自 intent 的完整 hash。JSON 最多 16 KiB，原始文件/候选各最多 5 MiB。阶段为 incomplete/invalid/prepared/cancelled/replacing/committed；committed 必须有关联的 replacing，不能与 cancelled 并存。JSON 中没有绝对路径、ACL 或恢复写入权限。最多每目标合计 20 项保存/草稿记录、私有存储合计 200 MiB，根枚举最多 512 项，每保存事务最多 7 个已知文件。预算检查在全局锁内，不自动裁剪未完成证据或最后备份；清理界面仍待实现。

HAE-011 的 [检查点清理](CHECKPOINT_COMPACTION.md) 可在草稿写入持有同一锁时，释放该活动 v2 序列较旧完整点的容量，保留两个完整修订和全部逻辑历史；它不移除保存事务、备份或其他会话。Save 本身不触发该流程。残留 active.lock 或 compaction.json 继续阻止保存准备，不通过忽略文件或推断进程退出解除保护。

[清理中断恢复](COMPACTION_RECOVERY.md) 另有明确 Main 审查，限定检查点锁和完整清理证据。Save 准备至取消/确认完成期间在同一目录注册活动占用，阻止这种审查介入；已开始但未确认结束的提交继续保留占用。恢复审查持有目录时也拒绝新 Save。完整 compaction 恢复记录保留并计入字节/枚举预算；部分、孤立或损坏记录阻止准备。这不提供 Save 自身遗留锁或原生 sidecar 的处置方法。

HAE-011 的 [草稿检查点](DRAFT_CHECKPOINTS.md) 共用同一私有目录和 active.lock；其 record.json/baseline.bin/complete.json、v2 的 origin.bin 及可选 retired.json 独立 schema 也计入上述总配额，结束标记不释放记录名额。保存 scan 跳过可归类的草稿目录；混合文件、未知文件名或无法验证归属的记录头阻止新的准备，损坏证据仍计入配额。Main 通过目录身份链防止将不同存储目录的提交证据混配。现有普通 v1 和恢复 v2 记录保持可读，提交阶段与替换协议未变。HAE-011 可用唯一精确提交证据将最新 saved v2 历史重建到当前文件版本；该恢复只形成新的私有干净点，不调用替换助手，不回放已保存候选，也不解除遗留锁。

此协议保障已执行的普通本地磁盘样例。同一私有目录的合作实例锁不约束其他应用、独立 profile 或敌对本地进程；路径复核到操作之间仍有 OS 竞态。文件 sync 的效果依赖 OS/设备，O_EXCL 对网络文件系统也有边界，因此进程强杀证据不等于断电、网络盘或所有文件系统验证。[Node 文件刷新](https://nodejs.org/api/fs.html#filehandlesync)、[文件打开标志](https://nodejs.org/api/fs.html#file-system-flags)。

## Main 显式备份恢复

`prepareRestore(source, transactionId)` 只允许 Main 传入刚刚授权并固定当前版本的 SaveSource，以及选择的备份事务 ID。它不根据记录中的显示名称重新打开文件。来源须为完整、有效的 prepared/cancelled/replacing/committed 记录，targetKey 必须与当前目标相同；损坏、缺失、未知 schema、错误目标、软硬链接或本次授权/读取后的身份变化均拒绝。已有全局锁仍会阻止恢复，不按记录阶段、时间或文件 hash 自动解锁。

恢复先读取并验证来源记录、backup.bin 及相关 seal/commit，固定其目录身份、intent/backup 文件版本、完整 hash 与原字节；在准备完成和替换前后复核。外部程序即使重写相同备份字节，也不能冒充固定的来源版本。用户后续 UI 确认必须绑定当前文档/状态版本；这个 Main 方法不提供绕过确认的 renderer 路径接口。

新事务与普通保存使用同一锁、配额、备份及 Windows 替换流程：先把当前源文件作为新 backup.bin 写入并独立回读，才允许替换为所选旧备份。候选为备份的完整原始字节，保留 BOM、行尾、实体及所有旧源码；这是用户显式恢复整份备份，不是编辑时序列化 DOM。新 intent 的 `version: 2` 与 `restoreOf: {transactionId, intentHash}` 记录备份来源，拒绝额外路径/force 参数及自引用。新记录自身保留恢复前后完整字节，检查时不递归依赖无限历史链。

返回值仍为 failed 或 prepared；prepared 含新 intent、cancel/commit。取消不修改 HTML；当前字节已经等于备份时返回 SAVE_NO_CHANGES，既不写记录也不解除其他遗留状态。恢复失败/未知保留新旧证据，重复 commit 共用结果；缺少平台适配器仍明确拒绝替换。恢复产生的“恢复前备份”可用于下一次显式恢复，已用过的备份不被删除或消费。

本阶段恢复的是 HTML 主数据流的原始字节，平台替换保留当前文件的创建时间/ACL/附加数据流；历史 ACL/数据流不在 backup.bin 中，不能声称将其恢复到过去。尚无正常应用恢复窗口、备份恢复后的会话接线、未保存编辑意图回放或残留 sidecar 清理。完整保存事务的旧锁另由 [明确审查](SAVE_RECOVERY.md) 处理，其审查记录和原事务共同保留并计入配额；部分审查证据阻止普通 Save/检查点写入。真实磁盘满、断电与平台限制仍适用。

## 后续接线

下一阶段需要处理正常产品窗口、跨保存的逻辑历史、持久化未保存编辑意图、恢复向导、遗留锁和残留 sidecar 的安全处理。已执行普通 NTFS 文件、真实只读/写权限拒绝、外部文件占用、进程强杀以及窗口保存/重建；真实磁盘满、断电、Windows 10/macOS、网络/云同步盘与产品人工验收仍待完成，不能用存储测试代替可用 MVP。
