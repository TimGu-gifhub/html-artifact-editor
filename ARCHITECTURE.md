# 技术架构

状态：产品架构设计基线；HAE-001/002 已加入工具链和独立只读预览，HAE-003 已验证静态树与源码索引。版本、执行范围和未测项见 [开发说明](docs/DEVELOPMENT.md) 与 [HAE-003 交付记录](docs/implementation/HAE-003.md)。产品编辑与保存流程仍待实现。

## 1. 技术选型

| 层 | 选择 | 理由与边界 |
| --- | --- | --- |
| 桌面宿主 | Electron，实施时选仍受支持的稳定版本 | 自带 Chromium，Windows/macOS 共用渲染核心；承担体积和更新成本 |
| 编辑器 UI | React + TypeScript strict | UI 状态明确，减少草稿、保存和异步响应错配 |
| UI 基础组件 | 优先 Radix 无样式可访问组件，视觉方案后再定样式 | 不把主题库、重型编辑器或整站模板作为前置依赖 |
| 构建 | Vite 8.2.2 独立入口；Forge 打包延后 | 主进程、两个 preload、UI/Preview 分别构建；安装器仍在 HAE-015 |
| HTML 解析 | parse5，开启 sourceCodeLocationInfo | 获得源码位置，不使用 serializer 保存整份文档 |
| 修改引擎 | 自研纯 TypeScript 的字节范围替换 | 核心不依赖 DOM、Electron 或操作系统判断 |
| 会话模型 | 显式 reducer / 状态机 + 版本化 IPC 数据结构 | 先采用最小状态管理，不同时引入多个状态库 |
| 文件与持久化 | Main 中封装 Node fs，JSON 日志 + 原始备份 | 单文件事务；首版不引入数据库 |
| 验证 | 纯核心测试 + Electron 集成/E2E + 人工实机 | E2E 驱动候选 Playwright Electron API，M1 验证适配性 |

Electron 的平台与版本支持参照 [官方仓库](https://github.com/electron/electron#platform-support) 和 [发布政策](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)。版本号不在计划中凭空固定；实施 PR 必须记录 Electron、Chromium、Node、包管理器版本与锁文件，两个系统使用同一核心依赖版本。

parse5 能提供源码位置，但解析器隐式创建的元素可能没有位置，位置下标也不是可直接用于 UTF-8 Buffer 的字节偏移。[ParserOptions](https://parse5.js.org/interfaces/parse5.ParserOptions.html)、[Location](https://parse5.js.org/interfaces/parse5.Token.Location.html)。字节映射是本项目必须额外实现和验证的逻辑。

## 2. 进程与信任边界

```mermaid
flowchart TD
    User[用户的打开与保存操作] --> UI[可信编辑器 UI]
    UI --> Bridge[窄 IPC 桥与运行时 schema 校验]
    Bridge --> Main[主进程：会话、权限、保存事务]
    Main --> Core[纯核心：解析、定位验证、字节 Patch、历史]
    Main --> Files[用户授权的 HTML 文件]
    Main --> Recovery[应用私有备份与草稿]
    Main --> Protocol[项目只读资源协议]
    Protocol --> Preview[隔离的 WebContentsView]
    Preview --> Inspector[隔离世界中的选择与几何信息]
    Inspector --> Main
```

可信 UI 在 `BrowserWindow` 中运行；用户 HTML 由独立 `WebContentsView` 承载，不能加载编辑器页面、配置、备份或本地任意文件。UI 和 Preview 使用不同 session 与不同协议源。生命周期、销毁和尺寸由 Main 管理。[WebContentsView 官方 API](https://www.electronjs.org/docs/latest/api/web-contents-view)。

### 预览安全基线

- `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true`；禁用 webviewTag、实验特性和不安全混合内容。
- Preview preload 只在隔离世界维护选择注册表与发回有限信息；不向页面主世界暴露文件、保存、Shell 或原始 `ipcRenderer`。
- Main 校验 sender 的 webContents、senderFrame、项目会话、源、会话世代和 payload；页面传来的路径、offset、旧值和选择器都不能成为写盘授权。
- Preview 与任何子 frame 均不得直接发起保存。只有可信 UI 的显式操作可请求 Main 保存其已验证的草稿集合。
- 默认拒绝权限请求、下载、新窗口、外部导航、弹窗和设备访问；不自动调用系统浏览器或外部协议。
- UI 使用严格 CSP。Preview 保留原页 CSP；校稿模式关闭脚本，交互模式仅执行被离线资源策略允许的本地脚本。不得通过关闭 webSecurity 或绕过 CSP 恢复兼容性。

上述边界参考 [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)；应用级协议、来源校验和模式切换规则是本项目设计，仍须以负向测试验证。

### 自定义协议与目录授权

采用 `artifact://<session-id>/<relative-path>` 作为预览资源入口，`editor://app/` 作为可信 UI 源。随机 session-id 只用于隔离和定位，不是唯一权限证明。处理器只能使用 Main 内登记的根目录与允许入口。

协议在对应 session 上注册。`standard`、`secure`、Fetch 支持等能力按 CSS、模块脚本、本地资源测试的最小需要启用；不启用 bypassCSP 和 Service Worker。注册时机及 session 规则参考 [protocol API](https://www.electronjs.org/docs/latest/api/protocol)。

项目路径处理必须拒绝 NUL、遍历路径、编码后的穿越、UNC/设备路径、Windows ADS 和越界符号链接/junction。解码后规范化并核验 realpath 位于根内，读取时验证实际目标身份，防止检查后链接被替换。只按资源请求读取，不提供列目录、任意磁盘路径读取或任何写接口。以路径分隔符边界判断，不能仅用字符串前缀。

根目录内的本地页面脚本可能读取该根中的可服务资源，因此打开文件时需说明授权根范围，建议采用独立项目文件夹。`.git`、应用状态、备份、凭据文件、隐藏配置以及非预览用途的文件类型不在可服务清单；同根可服务资源仍不应放入秘密。初期对白名单资源类型建立用例，新增类型需评估读取范围。

HTTP(S)、WebSocket、远程字体、在线 API、`file://`、外部协议、表单提交和导航在预览网络层默认拒绝。`data:` 图片等内存资源按 MIME 限制；`blob:` 不得获得磁盘或网络扩权。`<base>` 解析后仍执行相同根边界。不得把 localhost 或局域网地址当成离线可信资源。

单文件打开默认根为所在文件夹；用户通过可信文件对话框才能选择更大的根。切换项目撤销旧会话所有资源与 IPC 能力。内存 session 不复用其他项目的 Cookie、缓存或存储。

## 3. 模块边界与未来目录

HAE-001 已创建各顶层模块和内置验证壳；下表的业务子模块仍是后续任务目标。

| 目录 | 职责 | 禁止依赖 |
| --- | --- | --- |
| `src/core/parser/` | UTF-8 解码、源码索引和位置映射 | Electron、DOM、文件系统 |
| `src/core/patch/` | 补丁前置检查、编码、Buffer 结果计算 | UI、OS 分支、网络 |
| `src/core/history/` | 操作组、保存点、撤销重做 | 直接磁盘写入 |
| `src/contracts/` | schema、错误码、DTO、协议版本 | 平台和 UI 具体实现 |
| `src/main/projects/` | 文件选择、授权、会话生命周期 | 来自 Preview 的任意路径授权 |
| `src/main/storage/` | 备份、事务、锁、恢复、清理 | 页面脚本执行 |
| `src/main/protocol/` | 项目资源与离线请求策略 | 通用 HTTP 代理、任意路径服务器 |
| `src/preload/` | 可信 UI 桥、预览隔离世界观察器，分别构建 | 共享给页面的高权限 API |
| `src/preview/` | 命中测试、几何、节点注册与只读原因 | 自行决定写入 offset |
| `src/ui/` | 工具栏、画布周边、草稿、Diff、错误恢复 | Node fs、原始 IPC |
| `src/platform/` | 菜单、快捷键、窗口、对话框平台差异 | 分叉核心 Patch 算法 |
| `tests/fixtures/` | 自制或有许可的正常/恶意/崩溃样例 | 用户原始业务文件 |

先采用一个包、一个锁文件；等真实依赖边界需要时再拆 monorepo。大型库、数据库、插件系统、自动更新均不是 MVP 前提。

## 4. 核心数据流

1. Main 通过原生对话框取得入口和项目根，生成 projectId、documentId、generation。
2. Main 读取原始 Buffer，校验 UTF-8、大小、文件身份和 hash；只读构建 SourceSnapshot。
3. Core 解析并创建可支持静态 Text 范围索引。超过大小/复杂度预算时取消并给出只读原因。
4. 校稿 Preview 加载同一快照内容，脚本禁用；DOM 与 parse5 的映射必须通过 HAE-003。交互 Preview 可运行本地 JS，但首版不接受其内容写回。
5. 选择器发送 nodeId 和选择世代等有限信息；Main 用自己的索引校验 nodeId。CSS selector 仅作 UI 提示。
6. 可信 UI 编辑纯文本草稿。应用草稿只更新受控预览文本和历史，不写 HTML。
7. 可信 UI 保存时，Main 串行化该文件事务，复核基线、备份、生成字节结果、替换并回读验证。
8. 成功后重新解析新基线，重新创建 nodeId；历史逻辑保留，旧选择和旧 offset 全部失效。

完整补丁格式、重基线、写盘故障和崩溃恢复见 [Patch 规范](docs/PATCH_SPEC.md)。

## 5. 并发、状态与错误

每个项目持有一份 Main 权威状态：`empty / loading / clean / editing / dirty / saving / conflict / error / closing`。草稿输入另有 `composing` 标记。每个异步响应携带 projectId、documentId、generation、requestId；过期响应被忽略，不能切回旧项目或误标“已保存”。

每个文件只允许一个保存事务；保存时冻结提交快照并暂时禁止新编辑，页面仍可滚动。外部监听只是提示，保存前必须重新读取和校验磁盘。应用内多窗口/多进程写入需协调锁；对不合作的外部写入者仍有文件系统竞态，不能把 read-hash-rename 宣称为完整 CAS。

大文档解析与 Diff 计算应放入有资源上限、可超时终止的工作线程，避免阻塞主进程；只传入冻结字节与纯核心参数，不执行页面脚本。工作线程用于计算隔离和取消，不等同于浏览器权限沙箱。预览无响应时 Main 能销毁该 WebContentsView 并保留编辑草稿。

结构化错误码至少包含 `UNSUPPORTED_ENCODING`、`UNMAPPABLE_NODE`、`STALE_SELECTION`、`FILE_CHANGED`、`BACKUP_FAILED`、`WRITE_FAILED`、`SAVE_OUTCOME_UNKNOWN`、`RESOURCE_BLOCKED`。面向用户的短提示和动作见交互文档；日志默认不包含完整页面文字或绝对路径。

## 6. 验证和待决策项

优先验证三个问题：源码映射准确性、未改字节不变、预览无越权通道。它们不通过时先收缩支持范围，不继续扩展 UI 能力。

WebContentsView 是独立原生视图，可能覆盖 BrowserWindow 内的 DOM 弹层。选区编辑控件默认放在可信侧栏；原位编辑浮层作为候选，必须验证跨 DPI、滚动、缩放、窗口尺寸、IME 候选框和可访问性。不可为实现浮层把文件能力暴露给 Preview。

React/TypeScript/Vite 版本已在 HAE-001 锁定，使用 Node 自带测试运行器与独立 Electron 冒烟入口。HAE-003 锁定 parse5 并验证静态映射；Radix、Forge、产品 E2E 驱动与跨平台替换仍待对应任务验证。

### HAE-001 验证壳的具体边界

`npm run dev` 保留构建时自带的验证壳，通过各 session 内的精确 URL → 内存内容映射返回资源。`editor://app/` 与随机 `artifact://…/` 分离。UI 桥只有只读启动信息；Preview 页面没有桥，preload 只报告固定启动诊断，Main 校验 sender、session、主 frame、完整源 URL 和 payload，收到后撤销该监听器。

Electron 44.2.0 本地实验中 `javascript: false` 阻止了 Preview preload 初始化。因此保留隔离 preload 所需的引擎，使用响应头 `script-src 'none'` 禁止校稿页脚本；不启用 bypassCSP，沙箱、上下文隔离和 webSecurity 全部开启。HAE-002 已验证原 CSP 叠加、脚本入口与子 frame 拒绝；HAE-003 采用 scriptingEnabled=true 并通过 noscript 对照，不能把 CSP 禁止执行等同于解析器 scriptingEnabled=false。

### HAE-002 项目预览的实施边界

- Main 原生选择器只授予所选 HTML 的父目录，项目 protocol 只注册在新的内存 session 中。入口为固定 UTF-8 原始字节快照，资源按请求只读；请求解码一次，拒绝私有路径、非白名单类型、符号链接/junction、硬链接与 Windows 路径别名。读取前后的路径链、realpath 与打开句柄的 dev/ino、大小和时间戳必须一致。
- 校稿以 CSP 禁用全部页面脚本；交互允许本地 classic/module/inline 脚本，不允许 eval。两者都没有选区写回或保存 API。原始 HTML 不删 CSP、不插入标记、不做整页序列化。
- 网络层拒绝非当前 artifact 域的请求，并将 session 设为 offline；权限、外部导航、弹窗、下载、frame、worker、data/blob 资源均拒绝。资源兼容白名单和大小/并发上限见开发说明；这是有意收缩的初始范围。
- WebRTC 不完全受 URL 请求过滤控制。Main 在可信空白页启动后、加载用户字节前，通过 [Electron Debugger](https://www.electronjs.org/docs/latest/api/debugger) 和 [CDP Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/) 的文档创建钩子，在所有 frame 中不可重定义地关闭 WebRTC/WebTransport、文件选择 API 和打印，拦截文件拖放，并取消 HTML 文件输入的原生选择器。该钩子没有页面桥，不开放命令给页面；未设置 bypassCSP。保护安装失败或调试连接意外断开会撤销资源并关闭预览，正常销毁先撤销以避免重入。相关 API 依赖锁定 Electron/Chromium，升级时必须重跑负向用例。
- `PreviewController` 只接受 Main 路径与模式。成功切换先替换权威引用并同步撤销旧权限，销毁旧 WebContents 和清空存储；失败保留旧预览，过期/取消请求不可回填。IPC 目前仅有严格的只读启动确认，Main 验证 contents、session、senderFrame、源 URL、世代、模式和 schema。

路径与句柄复核覆盖已执行的文件替换、junction 替换和读中写入用例，不能冒称为所有文件系统上的内核原子授权或抵御拥有同等 OS 权限的敌对本地进程。网络盘、云同步、Mac 文件系统与更多竞态语料尚未验收；不因此开放任何写入。

### HAE-003 静态源码映射

纯核心复制并严格解码 UTF-8，生成含 BOM 修正的 UTF-16→字节边界索引，再由 parse5 8.0.1 生成规范化整树与连续文本范围。SHA-256 由 Main 的 Node crypto 注入；纯核心不使用 DOM、Electron 或文件系统。

Main 在有超时、取消和 V8 堆限制的 worker 中解析同一入口快照，将预期树发往隔离 preload。preload 核对父子顺序、元素/属性/命名空间、注释、doctype、template.content 和解码 Text；完全一致后登记 WeakMap<Text, nodeId>。没有源码标记、页面桥或 DOM 序列化保存。

DOMContentLoaded 后即观察变化，takeRecords 防止同一任务里的变更绕过校验。选择消息绑定 documentId、baseHash、session/generation 和递增 revision；Main 另外核对 sender、session、主 frame、完整 URL 与已知节点。`validateSelection` 是瞬时检查，后续草稿操作不能把它当作跨异步写租约。实际拒绝表见 [HAE-003](docs/implementation/HAE-003.md)。
