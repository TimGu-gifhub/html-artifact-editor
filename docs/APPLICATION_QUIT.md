# 应用退出协调

日期：2026-09-10；HAE-005 第七阶段。Main 可把应用退出与持久化窗口的同一关闭决定、文件事务和清理结果连通。真实 Electron 进程实验已执行；正常应用验证壳尚未安装此服务，产品菜单、确认控件和真实 IME 验收仍待完成。

## Main 安装

取得 [持久化会话](PERSISTENT_STARTUP.md) 后，在加载可信 UI、接受操作之前调用 [bindWorkspaceQuit](../src/main/workspace/quit.ts)，传入对应 BrowserWindow、runtime 和固定错误码的 reportError 回调。一个进程只允许安装一次，生命周期随 Main 进程结束；它面向当前 Windows 单窗口应用，没有通用退出、任意窗口关闭或 force IPC。

协调器订阅 before-quit、will-quit 和 window-all-closed。尚未确认可退出时同步 preventDefault，等待同一个 requestQuit；完成后才再次调用 app.quit。最后一个原生窗口关闭也必须经过这一等待，不使用窗口数为零推断后台清理完成。依据为 [Electron 应用事件](https://www.electronjs.org/docs/latest/api/app#event-before-quit) 与 [最后窗口关闭行为](https://www.electronjs.org/docs/latest/api/app#event-window-all-closed)。

Main requestQuit 返回 quitting、cancelled 或 blocked；quitting 表示已向 Electron 发出经过核验的退出请求，实际进程退出仍需外部观察。ready 只表示此窗口已经销毁且 runtime.dispose 已成功，busy 表示仍在处理请求；应用激活/重建入口不得在 busy 或 ready 时创建新窗口。检测到其他未纳入此会话的 BrowserWindow 时，返回 APP_QUIT_OTHER_WINDOWS，不替它们作关闭决定。重复安装返回 APP_QUIT_ALREADY_BOUND。

## 关闭决定与保存

持久化窗口的原生 close 与 Main requestClose 共用一个 Promise，返回 closed、cancelled 或 blocked。未应用输入和未保存草稿继续使用既有 Main review：取消、明确放弃或明确另存；本阶段不把“退出”解释为隐式覆盖保存。组合态、失效确认、记录错误和未知草稿仍拒绝关闭。

Workspace.waitForSave 仅供 Main 加入已经接受的原文件保存或已确认备份恢复，返回那一次操作的不可变结果；它不开始新保存，也不等待未获确认的备份对话框或其他选择器。保存成功、backup-restored 或无变化且没有清理警告时，重新检查当前文档的关闭条件；failed、unknown、cancelled、rebase-required、缺少结果或清理警告均停止本次退出，以 WINDOW_SAVE_UNSETTLED 保留窗口。Save 本身的成功与警告分类不变。

若在等待后又有输入，关闭检查使用当前文档/版本并重新询问；旧退出请求不会自动重放 Save。已知提交前冲突后，用户可发起新的明确关闭决定；未知结果和未处理证据仍按原合同拒绝盲目继续。单文档旧实验可保留即时拒绝忙碌状态的行为，持久化工厂固定启用等待。

明确另存后再取消文件选择，保留已经应用的草稿，窗口继续存在。实际副本回读核验通过后，才可确认对应会话的结束标记并退出。源 HTML 和资源不因这条另存流程被覆盖。

## 清理屏障

Workspace 确认 closed 后，持久化工厂先执行 runtime.dispose，再销毁原生窗口。输入/候选清理、历史/Diff Worker、检查点写入、各代已接受 IPC 命令和存储所有权核验都须完成；这个屏障由 Main 安装，不能由 renderer 或调用者替换。

清理失败时，原生窗口仍保留。清理屏障开始前另装一个仅拒绝关闭的监听，即使普通 guard/IPC 已拆除，再次点击原生关闭也不会绕过失败；只在清理成功或窗口实际销毁时移除此监听。已经确认的放弃决定不会被伪造为取消或重新启用旧编辑；界面可能已经断开，原有证据和运行实例占用继续保留，等待后续产品故障处理。重复请求不能通过重新 dispose 清除已缓存的失败。

如果窗口已被 Main/API 强制销毁，应用协调器仍等待原 dispose 的结果；确认改变的草稿可以继续完成私有持久化，未获得放弃决定时不补写结束标记。失败时进程保持存活并报告 APP_QUIT_CLEANUP_REQUIRED，没有隐藏的 app.exit 后备路径。

Windows 系统关机/重启/注销不保证触发这些 app 退出事件，app.exit、系统强杀和断电也不能由该协调器拦截。已持久化记录仍须按恢复合同核验；本阶段不声明这些平台事件已经验收。[Electron 退出事件限制](https://www.electronjs.org/docs/latest/api/app#event-will-quit)。

## 已执行的证据

`npm run test:quit` 在独立 Electron 子进程中运行 13 组自制样例：原生最后窗口关闭、重复 app.quit/close 与取消/组合标志、另存取消和成功、保存成功/冲突/替换后未知结果、备份恢复期间退出、检查点排空/明确退役、退役故障、Main 存储仍占用、强制销毁窗口后的排空、额外窗口/重复绑定拒绝，以及真实 renderer 崩溃使旧确认失效。

成功场景观察真正的 will-quit 与进程正常结束；受阻场景先断言没有 will-quit、窗口/证据仍在，随后由测试 harness 显式结束子进程。后者不是产品成功退出，也不是生产 force 方法。父进程核验所有退出前断言已执行，再独立比较原 HTML、CSS 和明确另存文件的完整字节。输入法测试只使用 composing 标志，菜单/对话框仍由 Main 回调驱动。

报告在忽略的 test-results/quit.json，含每组退出类型、实际 OS/运行版本、基线 commit/工作区和字节 hash。每个子进程 25 秒，总套件 90 秒；超时、异常或缺少结束证据均失败。Worker、IPC 和原生助手的生产期限未改变。实现证据见 [HAE-005](implementation/HAE-005.md)。
