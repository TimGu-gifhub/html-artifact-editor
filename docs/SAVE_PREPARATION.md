# 保存准备与私有证据

日期：2026-09-09；HAE-010 第一阶段。此服务只创建私有备份、候选和准备记录，没有覆盖、rename、恢复写盘或 renderer 接口，尚未接入正常应用。`prepared` 表示准备证据可读，不表示 HTML 已保存，也不是可以跨异步步骤复用的替换权限。执行范围见 [阶段记录](implementation/HAE-010.md)。

## Main 调用边界

[openSaveSource](../src/platform/save-source.ts) 只接受 Main 已授权的 HTML 路径和打开时的原始字节；复制字节，核对完整 hash、实际目录链、普通文件/单一链接、dev/ino、mtimeNs/ctimeNs。后续 verify 重读同一路径并复核版本；外部写入、换回原字节、删除、硬链接或目录替换均阻止准备。targetKey 是文件系统规范路径的 SHA-256，不使用全局大小写折叠猜测 Windows 目录规则。

[createSavePreparationStore](../src/main/storage/preparation.ts) 由 Main 指定应用私有数据下的专用、已存在目录；不能使用预览项目根或 UI 传入的路径。新建子目录不递归，目录身份和实际路径持续复核；Preview 的 userData/sessionData 排除规则继续适用。

`prepare(source, candidate)` 的 candidate 来自 Main 已核验的纯字节 Patch 流程。此存储层检查 baseHash、结果 hash、大小并复制候选，不能替代源码映射和 Patch 语义核验。无净变化不创建事务。返回 failed 或 prepared，prepared 仅含 Main 可用的取消方法；失败不清除原输入/候选，本模块也不持有或改变它们。

## 准备顺序

1. 复核源文件版本，以 O_EXCL 在专用私有目录创建 `active.lock`；同一存储目录全局串行，第二实例拒绝。同一对象还拒绝重复请求。
2. 检查现有记录与预算，创建随机 transactionId 子目录。
3. 独占创建 `intent.json`：版本、事务 ID、targetKey、显示文件名、身份/时间戳、旧/新 hash 与字节数、创建时间；没有绝对路径或页面偏移。
4. 独占写 `backup.bin`，保持句柄写入、sync、回读 hash 和身份；再独立读取一次备份核验。
5. 再检查源文件；独占写 `candidate.bin` 并同样回读核验。
6. 独占写 `prepared.json`，包含原 intent 文件的 hash；重新读取完整证据与源版本，通过后才返回 prepared。

文件保留原始 BOM、行尾和实体字节；候选直接使用已核验的完整结果，不重新序列化 DOM 或重新编码。私有文件请求模式 0600、目录 0700；这不是 Windows ACL 保密性或目录项断电持久性的验收结论。

正常取消独占写 `cancelled.json`，然后只删除本调用拥有且内容/身份仍匹配的锁；备份、候选和记录全部保留。重复取消共用同一结果；取消失败或锁被改动时保留锁。准备失败后可释放本调用已验证的锁，但不删除部分证据；创建锁本身出现未知结果时也不会猜测删除。

实际进程终止会留下锁，即使它是空文件。不按 PID、时间或记录状态自动解除，不盲目重试。完整恢复流程和安全解除遗留锁是后续阶段；此阶段不提供用户可绕过的 force/unlock 命令。

## 重启只读检查

`scan()` 只枚举有界私有命名空间，报告 records、locked、unrecognized；不会从 journal 自动打开用户文件。每项记录可用 `inspect(transactionId, readTarget?)` 检查。readTarget 只能由 Main 对已重新选择/授权的源文件提供，不接受记录内的路径。目标尚未选择时状态为 unavailable。

| 状态 | 含义；均不触发写盘 |
| --- | --- |
| incomplete / invalid | 准备文件缺少，或 schema/大小/身份/hash/记录关联不成立；保留证据 |
| unavailable / wrong-target | 尚未取得可读授权目标，或重新选择的规范路径键不同 |
| baseline-matches | 目标 key、旧 hash、dev/ino 与两个时间戳均匹配 |
| candidate-on-disk | 相同目标的当前 hash 等于候选；不能据此标记 committed 或自动重试 |
| conflict | 目标内容或文件版本不同，包括外部改写后恢复旧字节 |

intent/seal 严格按 [纯 schema](../src/contracts/save-record.ts) 检查；JSON 最多 16 KiB，原始文件/候选各最多 5 MiB。最多每目标 20 项记录、私有存储 200 MiB，根枚举最多 512 项，每事务最多 5 个已知文件。预算检查在全局锁内，不自动裁剪未完成证据或最后备份；清理界面仍待实现。

此协议保障已执行的普通本地磁盘样例。同一私有目录的合作实例锁不约束其他应用、独立 profile 或敌对本地进程；路径复核到操作之间仍有 OS 竞态。文件 sync 的效果依赖 OS/设备，O_EXCL 对网络文件系统也有边界，因此进程强杀证据不等于断电、网络盘或所有文件系统验证。[Node 文件刷新](https://nodejs.org/api/fs.html#filehandlesync)、[文件打开标志](https://nodejs.org/api/fs.html#file-system-flags)。

## 后续接线

下一阶段需要把这些记录连接到同目录临时文件、替换前最后复核、平台替换/ACL、目标回读与 committed 记录，再处理保存基线和映射更新。持久化未保存编辑意图、恢复向导、遗留锁处理、实际磁盘满/占用/权限与人工验收仍待完成。当前没有这些路径，不能用 prepared 代替成功保存。
