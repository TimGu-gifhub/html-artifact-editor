# 可信编辑器接口

日期：2026-09-09；HAE-005 第三阶段。当前为独立自动实验中的真实 preload/IPC 接线，正常应用没有调用此 Main bridge，也没有产品校稿控件。Kimi 前端须在维护者选定视觉方案后接入，见 [产品设计](PRODUCT_DESIGN.md) 和 [分工规则](AI_WORKFLOW.md)。

## 权限与生命周期

[Main bridge](../src/main/editor/bridge.ts) 由 Main 在加载可信页面前安装，绑定指定 WebContents、其 Session、一个 InputController、Main 选择器回调和已授权的新文件 writer。首次有效握手固定主框架，来源必须精确等于 `editor://app/index.html`，随后每条命令仍检查实际 contents/session/frame/URL。子框架、同源其他窗口和 Preview 均无权限。

每次 bridge 有独立随机连接 ID，preload 内部保存；命令携带严格递增的安全整数 sequence，Main 使用常数空间拒绝重复和旧请求。请求不可携带路径、选择器、源码范围、任意 IPC channel 或强制覆盖选项。UI 中的 editToken 仅代表当前输入所属的已核验 Text，并非文件权限。

主框架导航（包括重载）、renderer 崩溃和销毁撤销 bridge。Main 的输入、已知候选和文件结果继续保留；选择器返回时重新检查连接，已失效就不启动写入。已开始的写入不得中断或盲目重试。更换文档和重建页面须由后续 Main 窗口协调层处理，不得让前端通过重新握手自动绕过未保存保护。

## 公开方法

类型在 [editor.ts](../src/contracts/editor.ts)，纯状态在 [input.ts](../src/contracts/input.ts)。可信页面只能调用 `haeEditor` 的以下方法；没有通用 invoke、文件系统对象或事件来源对象。

| 方法 | 输入与行为 |
| --- | --- |
| `read()` | 首次建立连接并读取状态；未安装或已撤销时返回 EDITOR_DISCONNECTED |
| `begin({selection, draftRevision})` | 使用当前快照中的选择和草稿版本；等待 Main 确认编辑目标后才允许输入 |
| `change({editToken, inputRevision, newText, composing})` | 输入 revision 必须为上次加一；只保存未应用文本，不创建 Patch |
| `apply({editToken, inputRevision})` | 使用已确认的当前输入版本；同步隔离对象验证成功后才发布草稿 |
| `resolve({editToken, inputRevision, decision, intentSequence})` | decision 为 stay/discard/apply；匹配最新意图，继续编辑、放弃输入或应用原目标后切换 |
| `saveCopy(stateRevision)` | 检查当前状态、组合态和未应用输入，然后调用 Main 选择器；不接受文件路径 |
| `onState(listener)` | 回调只收到 InputSnapshot，返回取消订阅函数；先订阅再 read，最多 32 个订阅 |

命令返回 `{ok, code, state, copy}`。code 为固定错误码；未知内部错误统一为 EDITOR_COMMAND_FAILED，不传原始异常或机器路径。state 为最近收到的 Main 状态；transport 断开时可能只有先前缓存，前端应停用操作并保留本地输入，不能把缓存当成连接仍有效的证明。

`copy` 只说明**本次请求**：取消为 `{status: 'cancelled'}`；创建、失败或未知结果含 status、显示名称、expectedHash 和平台错误码。failed/unknown 同时令 ok=false，分别为 COPY_FAILED / COPY_OUTCOME_UNKNOWN。其他命令、打开选择器前的拒绝或异常，其 copy 为 null。不能只看 ok 或状态中的历史 lastCopy 就提示保存成功；只有本次 copy.status=created 才表示该副本已核验，原入口保存点仍未改变。

## 前端接入约束

先订阅状态，再读取初始快照；按 stateRevision 接受更新。preload 已过滤乱序和旧会话通知，回调异常不能影响 Main 状态。输入控件必须保留本地文字和版本，在异步返回前不能用旧快照覆盖后来输入；busy、过期或失败也不能清空用户文字。

输入法组合事件须显式同步 composing，组合期间禁止应用级 Enter/Escape/另存/切换/关闭。开始编辑、应用与处理切换均等待确认；如需排队发送输入，只能保留最新输入并按明确版本重发，不能自动重试应用或写文件。Main 检查不能替代真实 IME、焦点、快捷键和可访问性验证。

当前 snapshot 无源码字节范围或 OS 路径，包含选择、输入、意图、净变更、草稿阶段和另存显示结果。Preview 的文本只能作为数据呈现，前端不得用 innerHTML 插入；不得自行定位源文件、移动未应用输入到新目标或在 Apply/取消时保存 HTML。

## 已执行与未验证

`npm run test:editor` 使用真正 Electron preload、contextBridge 和 WebContents IPC，自制无控件页面与 HTML，包含九组来源/调用/文件结果/生命周期实验。伪造请求使用独立测试 preload；该探针不进入默认八目标构建。子框架反例使用真实子框架对象核对 Main guard，并确认页面没有 API，不宣称开启了子框架 Node 能力。

导航与 renderer 崩溃已真实执行；Main 存活时保留输入不等于 Main 崩溃、断电或磁盘恢复。保存选择器仍由测试回调代替；产品控件、真实 IME、原生对话框和维护者操作尚未验收。报告和字节 hash 在忽略的 `test-results/editor.json`，完整阶段证据见 [HAE-005](implementation/HAE-005.md)。
