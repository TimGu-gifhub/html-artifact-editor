# 保存准备中断的明确放弃

日期：2026-09-10；HAE-010 第八阶段。Windows 产品的“检查上次中断”现在也能处理意图完整、原文件仍严格匹配的保存准备中断。它保留全部残留文件，记录单独确认的决定，再移除精确匹配的旧锁。HTML 不变，旧 Save 或备份恢复不会被重放；之后仍需独立恢复草稿和复核保存。

## 接受条件

Main 核验固定私有目录里的准确保存锁后，[准备验证器](../src/main/storage/incomplete-save.ts) 只接受同一事务内完整有效的 intent.json。普通保存 intent v1 和备份恢复 intent v2 都适用；新授权的当前 HTML 必须匹配 intent 的 targetKey、完整旧 hash、大小和文件版本。

- intent 后尚未创建 backup.bin，可以明确放弃。
- backup.bin 可以缺少或部分写入。实际准备时，已存在字节必须是新授权原始字节的准确前缀；完整备份必须匹配旧 hash/大小。
- candidate.bin 出现前，备份必须完整。候选不能超过声明大小；达到完整大小时必须匹配新 hash，部分候选只作为保留证据，永远不是恢复或保存来源。
- prepared.json 出现前，备份与候选都必须完整。只接受标准 prepared 记录的严格字节前缀；完整 prepared 走既有完整事务处置。
- cancelled.json、replacing.json、committed.json、混合文件或未知文件出现时，新分支拒绝。缺少/损坏意图、错误字节顺序、任意损坏的 prepared、当前文件改写（含同文改写）和版本冲突仍被阻止。

Main 继续通过 [既有保存处置](SAVE_RECOVERY.md) 的 profile/目录占用排除、单独原生确认和 Windows 只读 guard 工作。准备与取消零写入；确认前后重新核验源、原锁、事务目录及全部残留文件。renderer 不提供路径、版本选择、替换决定或清理权限。

## 持久证据

[SaveResolution v2](../src/contracts/save-resolution.ts) 使用同一对 save-resolution 文件和完整标记。v1 表示完整保存事务的 keep-current；v2 只表示原文件仍匹配时，对未完成准备的明确放弃。v2 的 observed 固定为 baseline-matches，证据只可包含上述四个准备文件，必须有完整意图。它不构成 prepared、cancelled 或 committed 保存日志。

[读取器](../src/main/storage/save-resolutions.ts) 核验原锁文本/hash、事务目录身份、固定文件清单与每项大小/hash/版本，再核对 v2 的意图、原基线与写入顺序。它不根据记录重开用户路径；残留字节被严格绑定为已确认的原证据。部分/孤立/损坏/被替换的处置记录或标记，仍阻止普通写入和恢复。

执行顺序继续是独占写入审查记录、sync/回读、写入完整标记、sync/回读，最后删除准确旧锁。记录或标记完整落盘后再次中断，必须在新进程重新授权和确认；部分记录不得删除或覆盖后重试。unknown 或收尾警告仍保留窗口、证据和进程所有权。

[保存扫描](../src/main/storage/preparation.ts) 将完整封印的 v2 事务列为 abandoned，保留其原始目录和意图元数据。原始 inspect 仍返回原文件本身的 incomplete/invalid 状态，不补造准备记录；[备份列表](../src/main/storage/backups.ts) 不把 abandoned 项提供为恢复来源。已有完整备份仍可独立选择和重新确认。

所有残留文件、决定和标记继续计入原 200 MiB / 512 项及每目标 20 条保存/草稿预算。本功能不释放容量、不删除原事务或 sidecar；未来清理必须整体保护这些证据与引用。旧草稿恢复仍由检查点的原基线和映射证明决定，不能由 abandoned 分类授权回放。

## 验证与剩余工作

[存储测试](../tests/unit/save-resolution.test.mjs) 覆盖实际进程强杀的各准备步骤、前缀/顺序拒绝、取消和源版本变化、处置再次中断、损坏标记、再次 Save，以及备份恢复准备中断。窗口测试沿用 [产品中断流程](../tests/product/interruption.test.mjs)，通过实际控件重新确认、恢复和保存；原生选择/确认由 Main 测试回调提供。实际结果见 [HAE-010 第八阶段](implementation/HAE-010.md)。

没有完整意图的早期中断、结束事务旧锁、部分/冲突处置记录、活动未知会话解除冻结和跨会话/备份清理仍待实现。维护者报告、真实 IME/原生对话框、Windows 10、磁盘满/断电仍待验收；M2 保持未完成。
