# 统一窗口会话

日期：2026-09-10；HAE-005 第五阶段，包含 HAE-008 的目录/诊断与 HAE-010 的显式保存、备份恢复扩展。Main 已把文档管理、可信 IPC、原生预览挂载、Windows 保存与基线重建、关闭保护组装成一个服务，由真实 Electron 自动实验驱动。正常应用入口仍只读，尚无产品校稿控件、诊断面板或保存/恢复界面；原生目录/入口选择器适配器已提供，人工操作仍待验收。此阶段不是 M2 验收。

## 单一文档身份

[createWorkspaceSession](../src/main/workspace/session.ts) 在加载可信 UI 前安装。调用者负责安全的 BrowserWindow、应用资源协议和 Main 回调；会话内部只有一个 Workspace，其 current 同时决定输入/草稿、预览视图和命令目标。会话不从 renderer 接收文件路径或视图边界。

后续 Kimi 前端应调用 `haeWorkspace`，类型在 [workspace-editor.ts](../src/contracts/workspace-editor.ts)。旧 `haeEditor` 保留给单文档自动实验；同一 WebContents 只能安装一个 Main transport，未安装的接口不能调用文件或文档服务。

| 方法 | 合同 |
| --- | --- |
| `read()` | 建立连接并读取 WorkspaceSnapshot，尚未打开时 current=null |
| `listRecovery()` | 读取有界、无路径的恢复摘要；dirty 不保证所选源文件仍可恢复 |
| `restore(recoverySessionId, stateRevision, sourceMode?)` | Main 重新授权 file（默认）或 directory，核验最新记录并准备新映射；旧文档离开保护仍适用，成功只恢复草稿，不写 HTML |
| `open(stateRevision)` | 按窗口状态版本请求 Main 文件选择器，完整准备后处理旧文档离开确认 |
| `openDirectory(stateRevision)` | Main 先选择并固定根目录身份，再选择根内 HTML；取消任一步保持当前文档 |
| `switchEntry(documentId, stateRevision)` | 只在操作所属 current 文档的既有根内选择入口，不能自动重新授权或接受 UI 路径 |
| `readDiff(documentId, draftRevision, candidateHash)` | 读取指定已应用候选的完整源码 Diff；不改变输入、不写检查点或 HTML，过期结果拒绝 |
| `save(documentId, stateRevision, review?)` | Main 显式保存已应用候选并重建基线；review 绑定所显示 Diff 的 draftRevision/candidateHash，过期确认拒绝；未应用输入/组合态拒绝，不隐式 Apply |
| `listBackups(documentId)` | 只读列出当前目标的完整备份元数据，绑定 documentId，不返回私有字节/路径；并发列表读取有界 |
| `restoreBackup(documentId, stateRevision, reference)` | Main 固定 transactionId/intentHash 所指备份并单独询问确认；拒绝组合态、未应用/未保存变化，排空干净点后执行恢复及新基线核验 |
| `retryPersistence(documentId, draftRevision)` | 只重试当前文档最新已应用草稿的私有检查点；不接受路径/候选、不写 HTML，完成状态经 read/onState 读取 |
| `edit(documentId, value)` | documentId 必须是该操作所属快照的 current.id；value 只允许 begin/change/apply/resolve/history/save-copy 的精确 schema |
| `onState(listener)` | 返回取消订阅函数；先订阅再 read；最多 32 个订阅，通知只含纯状态 |

documentId 必须随用户操作一起捕获，不能在迟到回调中自动换成新文件 ID。即便新旧文档恰有相同输入 revision，旧 ID 也会以 STALE_DOCUMENT 拒绝，不调用新文件的输入或选择器。编辑值仍须通过 [输入合同](../src/contracts/input.ts)；文件身份不能替代 Text 身份、editToken 和版本核验。

返回 `{ok, code, state, documentId, copy, outcome, recovery, diff, backups}`：state 是窗口最新快照；documentId 说明本次文档命令的目标，copy 说明本次编辑请求；outcome 包含 opened/restored/cancelled，以及保存的 saved/unchanged/rebase-required 和整份备份恢复的 backup-restored。recovery/backups 仅在对应列表成功时返回摘要；diff 仅在读取成功时返回所请求的文档/修订/候选及完整源码切片，其余为 null 或未提供。保存或备份恢复成功后，返回的 documentId 仍是请求的旧目标，state.current.id 已是新基线文档。状态可能已前进，不能把旧请求结果提示到另一份文档。只有本次 copy.status=created 表示副本核验成功，原入口保存点不变。授权拒绝返回 RESOURCE_BLOCKED；未列入公开错误集的内部异常使用固定 WORKSPACE_COMMAND_FAILED，不泄漏路径或原始错误。

备份恢复使用独立的 backupReview 与 Main reviewBackup 回调，精确确认、版本固定和冻结/新历史合同见 [窗口备份恢复](BACKUP_RESTORE.md)。成功值 backup-restored 表示 HTML 已恢复并完成新基线核验；草稿恢复的 restored 不写 HTML。lastSave.operation=backup-restore 标记本次结果来源；故障与清理警告沿用保存结果规则。

Diff 基于打开/最近保存时的原始字节和同一冻结候选，由有限 Worker 计算；不包含未应用输入。UI 必须按文字显示原始源码，不执行它，范围仅用于显示，不能作为文件写入权限。产品从 Diff 发起 Save 时须携带实际显示的 review；即使后来候选 hash 相同，旧修订也不能确认新保存。该校验不替代磁盘冲突、备份或输入保护。完整字段、缓存、取消与错误合同见 [源码 Diff](SOURCE_DIFF.md)。

`current.project` 是只读显示摘要：根目录名称、根内相对 entry 和有界 resources 诊断。诊断变化也推进 Workspace 状态版本并经 onState 发送。它不含本机绝对路径、目录身份或授权对象；entry/诊断 target 不能回传为文件操作参数。具体类型、脱敏和截断规则见 [目录资源合同](PROJECT_RESOURCES.md)。

传输复用 [统一来源检查](../src/main/editor/transport.ts)：指定 WebContents、Session、精确 `editor://app/index.html`、握手后固定的真实主框架、随机连接 ID 和递增 sequence。Preview、子框架、同源其他窗口、旧连接及重放无权限。preload 内部保留连接身份，过滤旧版本和外来状态；不存在通用 invoke、force、dispose、路径或任意 channel 方法。

## 切换与故障

文档替换顺序为：独立完成候选准备 → 核验离开决定 → 同步挂载新预览 → 最终核验操作及旧输入 → 发布新 current → 关闭旧文档。启用 checkpoints 时，在试挂载前冻结输入并排空写入，明确丢弃/已核验副本须在试挂载后确认结束标记，再发布新 current；原窗口在整个过程中保留。订阅通知仅报告状态，不承担必须成功的挂载工作。

[PreviewHost](../src/platform/preview-host.ts) 拥有原生子视图附着关系；Workspace 拥有输入、预览内容和清理。新增视图、设置尺寸或移除旧视图失败时，先恢复旧视图再拒绝提交。成功挂载后若最终权限核验失败，调用回滚；旧输入、候选及文档 ID 不改变。原生缩放/回滚无法确定结果时，设置 cleanupPending 并阻止 Apply、Save、Open 和 Close，保留现场。Main 可保留晚到的 change 输入；当前没有用户可操作的视图故障恢复流程。

打开/确认期间允许当前文档的晚到 change，使旧离开决定失效；begin/apply/resolve/save-copy 在 Workspace 非 idle 时拒绝。原文件保存及重建、离开决定的 committing 阶段也拒绝 change，防止冻结候选之后接受新输入。Main holdDeparture 将 InputController 置于 leaving，只保留原输入和映射，不关闭它们；预检或挂载失败可释放冻结，标记结果不确定则保留冻结。此方法没有 renderer 命令。组合态和版本约束继续有效。HAE-008 的目录打开/入口切换复用同一路径；编辑窗口内的交互预览切换仍待接入。

导航、重载、renderer 崩溃和销毁撤销连接，取消未开始结束标记的打开/确认等待，不销毁 Main 当前输入。未返回的另存选择器也可结束等待；迟到路径或异常被消费，不启动后续写入。已经授权并开始的保存或结束标记不因 UI 失效而中断或重试，Main 继续核验其结果。

`reloadUI()` 仅供 Main 在旧 bridge 已撤销后使用，固定加载应用 UI 并建立新连接。它读取 Main 当前已结算的文档状态，不自行 Apply、Save、放弃输入或清除 composing；原操作已完成切换时会读到新文档。前端仍须保存未确认的本地文字并处理真实 IME/焦点。Main 崩溃、系统强杀或断电不受此内存保留机制保障，持久化恢复属于 HAE-010/011。

原生关闭复用 [文档与窗口生命周期](WORKSPACE_LIFECYCLE.md)，同一 current 上处理取消、放弃或明确另存后关闭。覆盖保存进行中拒绝关闭；离开确认尚未提供覆盖保存选项，不开放绕过恢复的强制关闭命令。

## 原文件保存与新基线

Main 创建 [OriginalSaver](../src/main/storage/original.ts) 并通过会话的可选 saveOriginal 端口安装；没有此端口时 canSave=false，显式请求返回 SAVE_PLATFORM_UNSUPPORTED。打开文档时就捕获 [SaveSource](../src/platform/save-source.ts) 的字节、目录链、文件身份与时间戳，不能等到保存时才取版本。外部程序改写后恢复相同字节也必须报告 FILE_CHANGED。

WorkspaceSnapshot 新增 canSave 和 lastSave。canSave 仅在有效映射、存在已应用净变更、没有未应用输入/组合态、窗口空闲且无待处理故障时为 true；它不替代 Main 执行时的版本核验。无净变化的 save 返回 unchanged，不创建私有记录、不写 HTML。lastSave 包含 documentId/status/code/cleanupPending/requiresReview，不包含路径、候选字节、事务方法或可复用写权限。

| 保存状态 | 含义与后续限制 |
| --- | --- |
| saved | 新文件 hash/身份、committed 记录、新文档映射均核验通过；新草稿无净变更，旧文档/Text 身份失效 |
| rebase-required | 磁盘事务已提交，但重建或挂载失败/发现外部改写；旧源、候选与 Main 事务引用保留，不能用旧偏移再次保存 |
| failed | 已知失败，保留输入/候选；requiresReview 决定是否等待恢复，准备前冲突仍可继续编辑草稿 |
| unknown | 无法确定提交结果，保留证据并阻止再次覆盖，不自动重试 |
| cancelled / unchanged | 未开始替换，或没有净变更；不更新基线 |

InputController 与 DraftSession 在整个文件操作期间互斥；已提交或未知的旧草稿进入保护状态，只有成功安装新文档才结束旧会话。重建沿用原 Main 项目授权，保留上级共享资源范围；重新解析与 Chromium 静态树映射后，再检查新源版本和 committed 记录，原生挂载前后均确认新映射仍为 ready。正常重建期间保持 saving，不先发布临时的恢复错误。HAE-011 的历史重建先核验实际已提交文件，再由 Worker 准备保存点；新映射通过完整来源证明安装已清空的 Text，不能复用旧 offset。新文档保留 Undo/Redo，草稿修订随保存点继续递增；可选持久化端口异步写入新的完整干净点。

已核验 saved 但锁/sidecar 清理失败时，命令仍为 ok=true、outcome=saved；lastSave 显示 cleanupPending 和警告，下一次覆盖等待恢复。UI 撤销若发生在准备阶段，Main 取消尚未开始的替换；若已经开始 commit，则继续核对磁盘和重建，即便原 renderer Promise 无法返回。重载后的 UI 读取 Main 当前状态，不触发第二次写盘。Main/系统强杀后的恢复仍需持久化流程，不能用 renderer 崩溃重连代替。

## 执行证据

HAE-011 的可选 Main checkpoints 端口为每份文档建立一个独立持久化队列；确认改变文字的 Apply、Undo、Redo 连同完整历史自动排队，失败保留输入并停止自动重试。current.persistence 传递准确的最新/写入中/待写/已持久化修订和错误，后台变化不推进输入版本。Save 在输入互斥期间等待私有写入结束，关闭文档等待队列排空；UI 崩溃不终止 Main 写入。没有配置端口时状态为 null，正常应用尚未安装端口。完整语义与记录退役、恢复列表等限制见 [草稿检查点](DRAFT_CHECKPOINTS.md)。

第四阶段增加 lastDeparture，其 documentId/status/code/cleanupPending/requiresReview 只报告离开时的私有记录结果。状态为 clean/retired/empty/failed/unknown；标记失败或未知保持窗口和全部证据，requiresReview 阻止继续修改或盲目重试。无净修改时若最后的归零检查点未确认，DRAFT_PERSISTENCE_REQUIRED 允许用户显式重试该检查点后重新关闭。有效标记但清理失败仍可完成已授权的切换/关闭，并保留独立警告；后续恢复界面仍待实现。

`npm run test:session` 使用真实 BrowserWindow、WebContentsView、生产 preload/IPC 与 Main 会话；测试专用 probe 只发送反例请求，不进入默认八目标构建。自制无控件的可信页面不代表产品 UI，也没有 Kimi 前端实现声明。

已执行十组检查：空会话/来源拒绝；标题与重复单元格修改及独立字节副本；三处真实视图操作故障；确认与晚到 IPC 输入竞争；换文档后旧请求拒绝及副本重开；实际 renderer 崩溃后重连；未返回另存选择器撤销；状态/schema/重放反例；同会话 window.close 取消和另存关闭；原生 resize 事件的尺寸故障保留与阻止操作。

报告在忽略的 `test-results/session.json`，包含实际系统/Electron 版本、源提交加工作区差异标记、十组结果和五份完整文件 SHA-256。另有四项 Workspace 激活/回滚/连接撤销单元反例与一项窗口命令 schema 测试。完整范围见 [HAE-005](implementation/HAE-005.md)。原生选择器、维护者点击系统关闭按钮、真实 IME、独立报告和产品体验仍待验收。

HAE-008 另用生产 preload/IPC 执行八组目录/共享资源/诊断/输入保护/副本重开/只读脚本/撤销/根替换检查，见 [阶段记录](implementation/HAE-008.md)。`haeWorkspace` 当时从四个方法扩展为六个；HAE-010 新增 save 后为七个，HAE-011 增加 retryPersistence 后为八个，权限仍由 Main 保留的授权与文档身份决定。

`npm run test:save-session` 已在 Windows 11 / Electron 44.2.0 执行十组真实窗口、生产 preload/IPC 和原生替换测试：连续保存/清空节点/项目根保留、组合态及未应用输入、保存互斥/关闭、打开后同文外部改写、准备时和替换后 renderer 崩溃、未知结果、原生挂载失败、提交后外部改写、提交后的清理警告。报告为忽略的 `test-results/save-session.json`；完整文件 hash、实际版本、限制和全量门槛见 [HAE-010](implementation/HAE-010.md)。测试的空白可信页面不是产品界面，composing 标志不是实际中文 IME 验收。

HAE-011 第二阶段将该命令扩充至 16 组，新增六组启用 checkpoints 端口的实验：连续 Apply 与慢写合并、精确持久化状态、Save 共用锁等待与新基线、失败/显式重试、实际 renderer 崩溃后继续写入、归零后原生关闭等待，以及检查点失败后显式保存。完整证据和未实现的生命周期/恢复范围见 [HAE-011](implementation/HAE-011.md)。

第四阶段再加入 [十组窗口离开实验](../tests/save-session/departure.ts)：关闭排空与结束标记、三处挂载失败、取消/失效确认与核验副本、三处结束写入异常、标记开始前后两次实际 renderer 崩溃、归零失败与显式重试、清理警告。源 HTML/CSS 与候选按独立期望字节核对；每个等待仍有界，保存会话整套运行上限扩为 90 秒。

第五阶段将恢复摘要与新 Preview 安装接入相同生产 transport，方法数为十个。恢复延续原 checkpointSessionId 和修订，生成新的 UI 文档身份，不重复写检查点；挂载前后验证源文件及同一最新记录。新文档的映射在准备完成后由自身生命周期管理，旧 chooser 的撤销不会在已经开始的离开提交期间销毁它。`npm run test:recovery` 执行独立 Electron 进程占用/强杀、真实恢复与后续编辑、原记录结束、授权取消/错误来源、原生挂载回滚、动态支持范围拒绝、源变化及新记录竞态、Windows 恢复后保存去重。完整合同与失败边界见 [草稿检查点](DRAFT_CHECKPOINTS.md)；空白 transport 页面、测试选择器回调仍不代替产品 UI 和人工验收。

第六阶段增加 readDiff，生产 API 共十一个方法，Save 可携带 Diff review。`npm run test:source-diff` 执行八组真实 Electron 实验：干净只读、恢复后的完整词法差异、未应用/组合态保护、新修订拒绝旧确认、净变更归零、renderer 重连/旧文档拒绝，以及 Windows 保存字节一致性和外部冲突。文档清理同时等待 Diff Worker 终止和持久化排空；终止失败保留占用，不报告释放成功。产品面板、历史与真实 IME 仍待接入。

第十一阶段在同一持久化队列的写入锁内加入 [旧检查点清理](CHECKPOINT_COMPACTION.md)。活动 v2 序列保留最近两个完整点及全部 Undo/Redo；新点已核验但清理失败时保留准确的 persisted 修订与 cleanupPending，后来的 Apply 只更新最新内存待写项，不冒充已写盘。后台通知不推进输入版本；实际遗留锁继续阻止 Save 和恢复，产品故障处理仍待实现。

HAE-010 第六阶段新增 listBackups/restoreBackup 后，生产 API 共十三个方法。`test:save-session` 新增十四组 [备份窗口实验](../tests/save-session/backup.ts)，共四十组通过；仍在原有 90 秒上限内运行。包括单独确认、净变化/组合标志保护、精确干净点、实际 renderer 崩溃、Windows 替换与再次保存、重建失败和清理警告。没有产品控件、真实 IME 或原生备份确认对话框验收。

## 历史命令与保存后的恢复

完整保存事务留下的锁也可在重启后由 Main [明确处置](SAVE_RECOVERY.md)：新授权的当前文件在 Windows 只读 guard 下保持固定，先保留决定和原事务证明，再结束旧锁。verified commit 可继续既有干净历史恢复；candidate-on-disk/conflict 保持原分类，不能借审查记录回放旧历史。此方法不解冻原活动窗口，也没有可信 IPC/产品控件；单独恢复旧备份仍需新的显式事务。

文档清理中断的旧锁现在有 [独立 Main 恢复合同](COMPACTION_RECOVERY.md)，仅在同一 profile 的全部文档与存储事务已经结束后接受明确审查。原窗口仍有内存输入时不能调用它释放占用；取消不写盘，确认完成后可再通过现有 restore/重新授权安装最新草稿。此 Main 方法没有可信 UI/Preview 入口，产品恢复面板、活动窗口暂停/解冻和未持久化输入的处置仍待实现。

`edit` 的 history 值严格为 `{stateRevision, draftRevision, direction}`；direction 为 undo/redo。它绑定调用时的文档、输入及已确认草稿版本，不接受目标 Text 或源码位置。InputSnapshot.history 为 null 表示旧 v1 恢复会话没有完整历史；否则仅提供 undoCount/redoCount/canUndo/canRedo。

InputController 在组合态、未应用输入或原生切换意图待处理时拒绝历史命令。准备候选后才可释放干净编辑锁，冻结期间若出现原生映射变化则拒绝；获得 isolated Preview 的 applied 后才推进历史并持久化。未知结果保留旧记录及待确认候选，禁止盲重试。历史 Worker、Diff 和私有队列都须完成关闭，文档才释放占用。

重新授权后可恢复 dirty v2 或含完整历史的 clean v2 点；后者不会重新应用旧脏候选。v1 净意图恢复保持兼容但不会猜测旧操作顺序。原生提交已完成但新干净点尚未落盘时，Main 可按唯一精确 committed 记录将 saved v2 历史重建为新基线上的干净候选，先持久化再安装，并同时持有原请求与新序列的所有权。已有后续记录、提交证据不足或新点写入失败时拒绝安装并保留证据；可信错误仅新增 DRAFT_SAVED_HISTORY_SUPERSEDED / DRAFT_SAVED_HISTORY_UNCONFIRMED，不增加页面权限或 API 方法。完整合同和未验收项见 [逻辑历史](HISTORY.md) 与 [检查点](DRAFT_CHECKPOINTS.md)。产品快捷键、焦点路由、真实 IME 和历史控件仍待选稿后的前端实现。
