# 目录入口与资源诊断

日期：2026-09-10。Main 的目录授权、入口切换和诊断已接入统一窗口会话，并提供原生选择器适配器及只读开发入口。产品目录打开、入口切换及诊断面板已接入；编辑窗口内的模式切换与人工对话框验收仍待完成，执行记录见 [HAE-008](implementation/HAE-008.md)。

## 授权与入口

单文件打开仍只授权 HTML 所在文件夹。目录打开先由 Main 原生对话框取得项目根，核验实际本地目录和 dev/ino 身份，再选择根内的 `.html` / `.htm` 入口。第二个对话框的 defaultPath 只方便定位，选择根外文件仍会被 Main 拒绝；不能从 UI 接受 root、path 或 entry 参数。

[DirectoryGrant / ProjectGrant](../src/main/protocol/project-files.ts) 只存在于 Main。入口是根内相对路径，切换入口复用最初的根身份；目录被移动或替换后拒绝读取/打开，不把同名新目录重新视为已授权。目录别名、符号链接/junction、硬链接、隐藏/私有路径和非白名单类型仍拒绝；应用 userData/sessionData 始终加入排除范围。权限边界沿用路径链与已打开句柄的前后核验，不能宣称对同等 OS 权限的敌对进程提供内核原子授权。

`artifact://<session-id>/<relative-path>` 保留入口层级，浏览器按正常规则解析相对路径和 `<base>`，每次读取仍受同一根约束。协议只服务当前 HTML 的原始字节快照及允许的 CSS/JS/图片/字体，不列目录、不读其他 HTML、不改写资源。页面脚本可读取根内允许的资源，因此应使用独立项目文件夹。完整类型、大小、并发与累计预算见 [开发说明](DEVELOPMENT.md)。

## 窗口操作与输入

可信接口新增 `openDirectory(stateRevision)` 与 `switchEntry(documentId, stateRevision)`，严格 schema 不接受路径。详情见 [统一窗口会话](WORKSPACE_SESSION.md)。两步选择均可取消；UI 连接撤销取消 Main 等待，迟到的根目录答复不会打开第二个对话框或替换文档。

产品通过“更多操作 → 切换目录内 HTML…”调用后者；单文件打开授权的所在目录也可复用。动作先固定当前 documentId，排空实际校稿窗口的输入，再取最新 stateRevision；文档已变、排空失败或组合态就取消。菜单中的目录名称/相对入口只作普通文本显示。入口选择和离开确认沿用 Main 流程，不自动保存或扩大目录授权。

入口切换使用已有 Workspace：先准备候选，再处理未应用输入/草稿，最后核验并挂载；旧确认和旧文档请求不能命中新文档。composing 或忙碌时不打开选择器。取消、越界或失败保留旧输入/候选/预览，一次只发布一个 current 文档。未知另存结果或视图状态的限制不会因目录选择而绕过。

当前另存仍只独占创建入口所在文件夹内的新 HTML 兄弟文件，不把整个预览根变成写入范围，也不复制资源或自动切换保存点。显式重开该副本时可保留同一根，验证相对资源；覆盖保存属于 HAE-010。

## 诊断合同

[ProjectSummary](../src/contracts/resources.ts) 含根名称、根内相对 entry 和 resources；它们仅用于显示，不授予读写权限。resources 含只读 items 与 truncated，记录格式为 `{id, target, resourceType, reason}`。诊断变化推进 Workspace 版本，经现有可信 IPC/onState 传输；Preview 没有编辑器或诊断查询桥。

| 字段 | 当前规则 |
| --- | --- |
| resourceType | document、stylesheet、script、image、font、fetch、frame、media、websocket、other |
| reason | RESOURCE_BLOCKED、RESOURCE_MISSING、RESOURCE_LIMIT、RESOURCE_CHANGED、RESOURCE_READ_FAILED、RESOURCE_LOAD_FAILED、CSP_BLOCKED |
| 本地 target | `project:/根内相对路径`；禁止的 artifact 路径仅显示 `project:/[blocked path]` |
| 远程 target | HTTP(S)/WS(S) 的协议、主机和路径；移除凭据、查询与 fragment，最多 2,048 字符 |
| 其他 target | file/data/blob 等只保留协议与 `[blocked]`；非法或超过 8,192 字符的 URL 为 `[invalid URL]`；内联/eval 只显示固定类别，不采集代码 |
| 数量与去重 | 按类型和脱敏 target 合并，最多 100 项，id 稳定；超出或请求关联表超过 256 项时标记 truncated |
| 原因合并 | 具体缺失/改变/超限证据保留，不被后到的通用加载失败覆盖；已关闭会话不再通知 |

前端必须把 target 当作普通文本显示；不能将其插入 HTML、自动下载、打开链接、重试联网或反向用作文件路径。截断表示诊断不完整，不表示其余资源加载成功。本地缺失、权限和读取失败只在可信诊断中区分，协议仍向用户页面返回无细节的拒绝响应。

诊断从 Main 协议/webRequest 和既有安全调试连接的只读事件汇合。实际测试发现 `connect-src` 阻断 fetch 时可能没有 Network 事件，因此同时使用 Audits 的非 report-only CSP issue；网络/CDP 事件不提供写入授权。观察器在加载用户页前启用，安装失败即拒绝本次预览，关闭时移除监听。没有启用 bypassCSP、网络或额外页面桥。

此实现依赖锁定的 Electron 44.2.0 / Chromium 152 行为；CDP Audits 属于实验接口，升级必须重跑 CSP/API 和来源反例。[Electron Debugger](https://www.electronjs.org/docs/latest/api/debugger)、[CDP Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/)、[CDP Audits](https://chromedevtools.github.io/devtools-protocol/tot/Audits/)。

## 可运行入口

```sh
npm run preview:directory
npm run preview:directory:interactive
npm run test:project
```

前两条由原生选择器取得根和入口，分别禁用/允许本地脚本，诊断写入开发终端；均只读。第三条以自制文件和 Main 选择回调驱动真实 Electron，结果在忽略的 `test-results/project.json`。自动实验不替代产品面板、原生对话框、真实 IME 或维护者报告的验收。
