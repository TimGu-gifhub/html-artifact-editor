# 统一窗口会话

日期：2026-09-09；HAE-005 第五阶段。Main 已把文档管理、可信 IPC、原生预览挂载和关闭保护组装成一个服务，由真实 Electron 自动实验驱动。正常应用入口仍只读，尚无产品校稿控件、原生编辑对话框或覆盖保存；此阶段不是 M2 验收。

## 单一文档身份

[createWorkspaceSession](../src/main/workspace/session.ts) 在加载可信 UI 前安装。调用者负责安全的 BrowserWindow、应用资源协议和 Main 回调；会话内部只有一个 Workspace，其 current 同时决定输入/草稿、预览视图和命令目标。会话不从 renderer 接收文件路径或视图边界。

后续 Kimi 前端应调用 `haeWorkspace`，类型在 [workspace-editor.ts](../src/contracts/workspace-editor.ts)。旧 `haeEditor` 保留给单文档自动实验；同一 WebContents 只能安装一个 Main transport，未安装的接口不能调用文件或文档服务。

| 方法 | 合同 |
| --- | --- |
| `read()` | 建立连接并读取 WorkspaceSnapshot，尚未打开时 current=null |
| `open(stateRevision)` | 按窗口状态版本请求 Main 文件选择器，完整准备后处理旧文档离开确认 |
| `edit(documentId, value)` | documentId 必须是该操作所属快照的 current.id；value 只允许 begin/change/apply/resolve/save-copy 的既有精确 schema |
| `onState(listener)` | 返回取消订阅函数；先订阅再 read；最多 32 个订阅，通知只含纯状态 |

documentId 必须随用户操作一起捕获，不能在迟到回调中自动换成新文件 ID。即便新旧文档恰有相同输入 revision，旧 ID 也会以 STALE_DOCUMENT 拒绝，不调用新文件的输入或选择器。编辑值仍须通过 [输入合同](../src/contracts/input.ts)；文件身份不能替代 Text 身份、editToken 和版本核验。

返回 `{ok, code, state, documentId, copy, outcome}`：state 是窗口最新快照；documentId/copy 说明本次编辑请求，outcome 仅说明本次 open 的 opened/cancelled。状态可能已前进到另一份文档，不能把旧 copy 成功提示到新文档。只有本次 copy.status=created 表示副本核验成功，原入口保存点不变。打开失败的内部异常使用固定 WORKSPACE_COMMAND_FAILED，不泄漏路径或原始错误。

传输复用 [统一来源检查](../src/main/editor/transport.ts)：指定 WebContents、Session、精确 `editor://app/index.html`、握手后固定的真实主框架、随机连接 ID 和递增 sequence。Preview、子框架、同源其他窗口、旧连接及重放无权限。preload 内部保留连接身份，过滤旧版本和外来状态；不存在通用 invoke、force、dispose、路径或任意 channel 方法。

## 切换与故障

文档替换顺序为：独立完成候选准备 → 核验离开决定 → 同步挂载新预览 → 最终核验操作及旧输入 → 发布新 current → 关闭旧文档。订阅通知仅报告状态，不承担必须成功的挂载工作。

[PreviewHost](../src/platform/preview-host.ts) 拥有原生子视图附着关系；Workspace 拥有输入、预览内容和清理。新增视图、设置尺寸或移除旧视图失败时，先恢复旧视图再拒绝提交。成功挂载后若最终权限核验失败，调用回滚；旧输入、候选及文档 ID 不改变。原生缩放/回滚无法确定结果时，设置 cleanupPending 并阻止 Apply、Save、Open 和 Close，保留现场。Main 可保留晚到的 change 输入；当前没有用户可操作的视图故障恢复流程。

打开/确认期间允许当前文档的晚到 change，使旧离开决定失效；begin/apply/resolve/save-copy 在 Workspace 非 idle 时拒绝。InputController 自身的 busy、组合态和版本约束继续有效。交互预览和目录入口切换尚未接入该会话。

导航、重载、renderer 崩溃和销毁撤销连接，取消未提交的打开/确认等待，不销毁 Main 当前输入。未返回的另存选择器也可结束等待；迟到路径或异常被消费，不启动后续写入。已经开始的文件写入不因 UI 失效而中断或重试。

`reloadUI()` 仅供 Main 在旧 bridge 已撤销后使用，固定加载应用 UI 并建立新连接。它恢复同一文档的 Main 状态，不自动 Apply、Save、放弃输入或清除 composing；前端仍须保存未确认的本地文字并处理真实 IME/焦点。Main 崩溃、系统强杀或断电不受此内存保留机制保障，持久化恢复属于 HAE-010。

原生关闭复用 [文档与窗口生命周期](WORKSPACE_LIFECYCLE.md)，同一 current 上处理取消、放弃或明确另存后关闭。退出尚未具有覆盖保存、备份和 journal，不开放绕过恢复的强制关闭命令。

## 执行证据

`npm run test:session` 使用真实 BrowserWindow、WebContentsView、生产 preload/IPC 与 Main 会话；测试专用 probe 只发送反例请求，不进入默认八目标构建。自制无控件的可信页面不代表产品 UI，也没有 Kimi 前端实现声明。

已执行十组检查：空会话/来源拒绝；标题与重复单元格修改及独立字节副本；三处真实视图操作故障；确认与晚到 IPC 输入竞争；换文档后旧请求拒绝及副本重开；实际 renderer 崩溃后重连；未返回另存选择器撤销；状态/schema/重放反例；同会话 window.close 取消和另存关闭；原生 resize 事件的尺寸故障保留与阻止操作。

报告在忽略的 `test-results/session.json`，包含实际系统/Electron 版本、源提交加工作区差异标记、十组结果和五份完整文件 SHA-256。另有四项 Workspace 激活/回滚/连接撤销单元反例与一项窗口命令 schema 测试。完整范围见 [HAE-005](implementation/HAE-005.md)。原生选择器、维护者点击系统关闭按钮、真实 IME、独立报告和产品体验仍待验收。
