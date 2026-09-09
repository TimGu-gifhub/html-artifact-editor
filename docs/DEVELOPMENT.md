# 开发与工具链

日期：2026-09-09。范围：HAE-001 至 HAE-004 基础实验，HAE-005 的草稿、可信 IPC、另存与文档/窗口保护，HAE-008 的目录资源，以及 HAE-010 的 Windows 保存事务和窗口基线重建实验。

## 固定版本

| 项目 | 版本 / 范围 | 依据 |
| --- | --- | --- |
| 开发 Node.js | 24.14.1（24 LTS 系列） | `.nvmrc`；本地验证版本 |
| npm | 11.19.1 | packageManager、engines 与本地开发环境同步固定 |
| Electron | 44.2.0，2026-09-03 稳定版 | [该版本发布记录](https://github.com/electron/electron/releases/tag/v44.2.0) |
| 内嵌 Chromium | 152.0.7977.76 | [Electron 官方版本表](https://releases.electronjs.org/)；smoke.json 另记录实际值 |
| 内嵌 Node.js | 24.20.0 | 同上，与开发机 Node 分开记录 |
| React / React DOM | 19.2.8 | package.json 与 package-lock.json |
| TypeScript | 6.0.3 | strict；保留稳定 AST API 做边界检查 |
| Vite | 8.2.2 | 独立入口构建；不依赖本地开发服务器 |
| parse5 / entities | 8.0.1 / 8.1.0 | 纯核心 HTML5 解析；精确锁定，原始 MIT / BSD-2-Clause 声明保留 |
| 单元测试 | Node 内置 node:test | 无额外测试框架、浏览器下载 |
| 文档检查 | Python 3.10+ | 无第三方 Python 依赖 |
| Windows 替换助手 | .NET Framework 4.x / C# 5 | 使用本机 Framework64/v4.0.30319/csc.exe 编译仓库源码；未引入 npm 原生扩展 |

截至核对日，Electron 团队支持 [最近三个稳定主版本](https://www.electronjs.org/docs/latest/tutorial/electron-timelines#version-support-policy)，44 属于支持范围。更新 Electron 时重新核对安全更新、最低 OS、内嵌版本与两平台回归。

Electron 44 官方平台下限为 [Windows 10、macOS Ventura 13](https://github.com/electron/electron/tree/v44.2.0#platform-support)。本项目目标是 Windows 10/11 x64 与 macOS 13+ arm64；官方支持不等于本项目已完成最低版本实测。

## 安装、开发与构建

在仓库根目录，使用上述 Node/npm 版本：

```sh
npm ci
npm run dev
```

单个 package.json 和 package-lock.json；直接依赖全部精确版本。`npm ci` 会执行 Electron 自带的 `install-electron`，下载锁定版本的当前平台二进制并使用上游校验值。首次安装需访问 npm/GitHub；安装成功后的验证壳运行不依赖联网。[Electron 安装机制](https://www.electronjs.org/docs/latest/tutorial/installation#binary-download-step)。

`dev` = 构建后启动；修改源码后关闭窗口并重新执行。暂不提供 watch/HMR。`npm start` 只运行已有构建。不要使用 `--ignore-scripts` 跳过安装步骤后直接推断运行时已可用。

Windows 构建需要 SystemRoot 下的 .NET Framework 64 位 C# 编译器；缺少时明确失败，不下载或提交替代二进制。`build` 从源码生成 out/native/ReplaceHelper.exe，单元/存储测试另生成只用于自制文件的 out/storage-test/StorageFixture.exe。其他 OS 跳过原生构建并报告覆盖不支持；这不代表 macOS 保存已实现。安装打包如何携带助手、目标机 .NET Framework 和 Windows 10 验收仍待完成。

| 命令 | 产物或检查 |
| --- | --- |
| `npm run build` | 八个 JS/页面构建目标，另构建 Windows 原生替换助手 |
| `npm run build:main` | out/main/index.cjs |
| `npm run build:native` | Windows .NET Framework 编译原生替换助手；其他 OS 明示不支持 |
| `npm run build:preload:ui` | out/preload/ui/index.cjs，独立单文件 CJS |
| `npm run build:preload:preview` | out/preload/preview/index.cjs，独立单文件 CJS |
| `npm run build:ui` | out/ui，React 渲染器 |
| `npm run build:preview` | out/preview，固定静态样例 |
| `npm run typecheck` | 核心、主进程、preload、UI 四套 strict 编译边界；仅 preload/渲染器含 DOM 类型 |
| `npm run check:boundaries` | AST 检查跨层 import/export/动态加载与核心平台全局变量 |
| `npm test` | 契约、分层、资源路径/句柄/快照/撤销、UTF-8、源码索引、纯字节 Patch 与拒绝反例 |
| `npm run test:smoke` | 已构建应用的 Electron 冒烟，独立 out/smoke 入口 |
| `npm run test:security` | 已构建 preload 的真实项目协议、两种模式、恶意请求和 IPC 测试；独立 out/security 入口 |
| `npm run test:mapping` | 构建 worker/preload/mapping，真实 Chromium 树、原生点击、世代/对象失效与解析故障实验 |
| `npm run test:patch` | 生成自制候选文件并在真实 Chromium 重开；验证纯文本、清空、变长、pre 空行与资源不变，不是应用 Save |
| `npm run test:draft` | 原生选字、worker、Main 草稿、隔离 Text 修改、独占新文件另存/重开及异步故障；选择器以测试回调替代，不代表原生对话框验收 |
| `npm run test:editor` | 真实 UI preload/IPC、来源/参数/重复请求拒绝、逐次另存结果、主框架导航与 renderer 崩溃保留；不含产品控件或真实 IME |
| `npm run test:workspace` | 新文档完整准备后替换、旧输入保留、window.close 事件、另存后关闭、取消/失败/未知结果；选择和确认仍为测试回调 |
| `npm run test:session` | 同一窗口的可信 IPC/文档身份/预览/关闭，挂载回滚、旧请求拒绝、UI 崩溃重连与未返回选择器撤销；不是产品控件验收 |
| `npm run test:project` | 生产 preload/IPC 上的目录授权、嵌套资源、CSP/API 诊断、入口切换/另存/撤销及根目录替换；选择器仍为 Main 测试回调 |
| `npm run test:storage` | Electron 内嵌 Node 执行真实文件准备、Windows 原生替换/备份恢复、权限/占用、事务故障及进程强杀；仅覆盖自制临时 HTML，无产品窗口 |
| `npm run test:save-session` | Windows 真实 Electron 窗口、生产 IPC、原文件保存/重建、崩溃/未知结果/外部冲突/清理警告；无产品控件或真实 IME |
| `npm run preview` | 构建后打开原生文件选择器，以禁用页面脚本的模式只读预览 |
| `npm run preview:interactive` | 同上，允许本地脚本执行，仍无编辑或保存能力 |
| `npm run preview:directory` | 原生选择根目录及其中 HTML，保留嵌套相对资源路径；只读校稿预览，诊断输出到终端 |
| `npm run preview:directory:interactive` | 同上，允许本地脚本；CSP 阻断的在线 API 也进入诊断，无编辑/保存能力 |
| `npm run diagnostics` | 本机实际 OS/架构与 Node/npm；历史 runner 字段在本地通常为 null |
| `npm run licenses` | 更新依赖清单，复制原始声明至 out/licenses |
| `npm run licenses:check` | 清单与锁文件比对，核验/复制声明 |
| `npm run check` | 类型 → 边界 → 单元测试 → 构建 → 内置冒烟 → 项目安全 → 源码映射 → Patch 重开 → 草稿另存 → 编辑器 IPC → 文档生命周期 → 统一窗口会话 → 目录资源 → 内嵌 Node 存储 → Windows 保存会话 → 许可证 |

另运行 `python tools/check_docs.py` 与 `git diff --check`。构建目录、安装器、测试截图与临时 profile 均被忽略；不得提交个人 HTML 或私有诊断材料。

## 运行边界与证据

验证壳在 BrowserWindow 中展示启动状态，在 WebContentsView 中展示内置只读样例。UI/Preview 使用不同内存 session、协议源与 preload。只服务构建产物内存白名单，无用户文件打开或写入能力。Preview 的页面脚本由严格响应头 CSP 禁止；隔离 preload 不暴露页面 API。

smoke 记录 preload 实际报告的 sandbox/contextIsolation、页面 Node 能力缺失、源/session 分离、脚本阻断、外部请求/弹窗阻断、尺寸跟随和子视图销毁。截图前会短暂显示不抢焦点的测试窗口，然后自动关闭。报告位于 `test-results/smoke.json`，记录基线 commit 及工作区是否有修改；截图仅是该内置样例的视觉证据。测试 profile 留在 `test-results/profile`，不作为公开 artifact 上传。

HAE-002 的 `preview` / `preview:interactive` 使用独立原生选择器与 WebContentsView，项目文件协议与生命周期由 Main 管理；`dev` 内置壳及 React UI 保持原样。HAE-003 为静态入口增加源码映射与点击诊断；这些正常入口仍不启用草稿、保存、备份或恢复。产品视觉稿仍需 HAE-007 选择，后续产品前端按 Kimi 分工执行。映射/安全实现由主开发代理负责；不把测试页面标为产品设计。测试入口及故意增强的攻击 preload 不从应用入口导入，没有页面可开启的测试开关。

`test-results/mapping.json` 记录运行版本、commit/工作区、25 份自制 HTML 的 SHA-256 与 10 组映射断言；`mapping-repeated.png` 是渲染辅助证据。纯核心校验全部合法 Unicode 标量、字节边界和 10,000 行索引。支持/拒绝表与故障注入见 [HAE-003](implementation/HAE-003.md)。解析上限为 5 MiB、100,000 个规范化节点、256 层；Main worker 有 5 秒期限和 V8 堆限制，超时/取消等待 worker 终止后返回。它不是整个进程的硬内存上限，也不是 HAE-013 性能验收。

HAE-004 增加纯核心内存 Patch 候选：64 KiB UTF-8 新文字、1,000 个净补丁、5 MiB 输出上限。无变化和还原基线文字保留原始实体拼写；失败不改变已有候选。`test-results/patch.json` 与 `patch-candidate.png` 记录 4 组真实 Chromium 重开断言及自制文件 hash。测试仅创建新的临时候选文件，原 HTML/CSS/JS 不变；没有覆盖保存、备份或恢复实现。详细 API、pre 首换行及限制见 [HAE-004](implementation/HAE-004.md)。

## 项目资源范围

HAE-005 的 `test:draft` 执行 20 组草稿/输入/另存断言，`test:editor` 执行 9 组真实 IPC 与 renderer 失效检查，`test:workspace` 执行 7 组文档替换、window.close 和保存结果检查，`test:session` 执行 10 组统一窗口/文档身份/视图回滚/崩溃重连与原生 resize 故障检查。报告在 `test-results/draft.json`、`editor.json`、`workspace.json` 和 `session.json`，均记录实际版本与文件 hash；135 项单元检查包含真实文件故障、协议和异步离开/激活反例。composing 标志不代表真实 IME；未知新文件或视图结果保留现场，尚无恢复界面。正常 `dev` / `preview` 入口仍只读；见 [阶段记录](implementation/HAE-005.md)、[编辑器接口](EDITOR_BRIDGE.md)、[文档生命周期](WORKSPACE_LIFECYCLE.md) 与 [统一窗口会话](WORKSPACE_SESSION.md)。

HAE-008 的 `test:project` 增加 8 组真实目录资源/诊断/入口切换实验与 6 项单元检查，该阶段发布时共 141 单元、55 源文件边界。`test-results/project.json` 记录实际版本、八组结果、0 次回环 TCP 连接与七份完整文件 hash。文件/对话框选择由 Main 测试回调控制，诊断面板和人工对话框操作未验收；详见 [阶段记录](implementation/HAE-008.md)。

HAE-010 第一阶段增加 10 项真实存储/进程测试，当时共 151 单元、59 源文件边界。`test:storage` 在 Electron 内嵌 Node 下重跑同一存储文件，必须有明确的测试计数且无失败/跳过；报告 `test-results/storage-runtime.json` 与日志记录真实版本。仅测试子进程使用 ELECTRON_RUN_AS_NODE，正常应用仍使用既有启动器。基线/备份/准备记录、六个真实强杀点、重启只读检查和保留限制见 [保存事务合同](SAVE_PREPARATION.md) 与 [HAE-010](implementation/HAE-010.md)；第一阶段没有覆盖能力。

第二阶段将明确的 Main commit 连到 Windows ReplaceFileW 和 committed 日志，新增 11 项事务测试；当前完整门槛的版本/数量见 [HAE-010 阶段记录](implementation/HAE-010.md)。内嵌测试在 Windows 运行两份存储测试文件，并记录 nativeReplacement=included；其他 OS 仅运行准备测试且标为 unsupported。实际只读/ACL/占用、旧式及保护 DACL、命名数据流、四处 Main 强杀、结果未知与清理失败均单独断言；正常应用接线和恢复界面仍待完成。

第三阶段的 `test:save-session` 用实际 Main 会话与生产 UI preload 接通保存，十组实验通过，包括连续保存后旧 ID 拒绝、清空节点、同文外部改写、保存中关闭保护、实际 renderer 崩溃和重建/清理故障。`test-results/save-session.json` 记录系统/运行时、源提交与工作区差异、结果和完整文件 hash。无控件测试页面不代表产品 UI，接口 composing 标志不代表实际 IME；此命令当前要求 Windows，其他平台明确拒绝。全量及最后定向回归的分开计数见 [HAE-010](implementation/HAE-010.md)。

第四阶段新增 `tests/unit/save-recovery.test.mjs`，验证 Main 备份恢复的 v1/v2 记录、当前文件再次备份、实际恢复/反向恢复、来源损坏/换名/同文改写、外部冲突、互斥、故障和三个真实 Main 强杀点。Windows 的 `test:storage` 现在在 Electron 内嵌 Node 执行准备、提交、恢复三份测试文件；其他平台仍只重跑准备文件并标记原生替换 unsupported，不据此宣称恢复已在其他平台验证。恢复向导和持久化草稿仍待接入。

单文件原生选择器以 HTML 父目录为根；目录入口先明确授权根，再选择根内 HTML，切换入口保留原根身份。两种方式都不接受页面消息中的路径。入口必须为有效 UTF-8，保持 BOM、换行、实体拼写与原 CSP 的原始字节。根内的可服务资源对本地脚本可读，请使用独立项目文件夹。

| 类型 / 行为 | 当前规则 |
| --- | --- |
| HTML | 只服务授权入口快照；其他 HTML 与目录列表拒绝 |
| CSS / 图片 / 字体 | CSS、PNG/JPEG/GIF/WebP/AVIF/ICO/SVG、WOFF/WOFF2/TTF/OTF；本地相对路径与 CSS import 可用 |
| JavaScript | 仅交互模式允许本地 js/mjs、模块与内联脚本；不允许 eval，不绕过原页 CSP |
| 网络与嵌入 | HTTP(S)/WebSocket、localhost/LAN、远程资源、frame、worker、data/blob、媒体和对象均拒绝；当前不会还原依赖这些能力的页面 |
| 私有文件 / 路径 | 隐藏路径、backups/recovery/drafts/credentials/secrets、node_modules、非白名单扩展名拒绝；符号链接、junction、硬链接、ADS、UNC/设备路径、DOS 别名、尾部点/空格、二次编码拒绝 |
| 大小与预算 | 入口 5 MiB、单资源 16 MiB、同时读取最多 8 项、每代累计响应字节 128 MiB；15 秒启动保护。属于初始保护值，尚非性能验收结论 |
| 诊断 | Main 内最多 100 项按类型/脱敏目标去重，超过标记 truncated；缺失/CSP 阻断等原因可经可信 IPC 读取。保留远程协议/主机/路径或允许的项目相对路径，移除查询/凭据/fragment，不含本机绝对路径；产品面板仍待完成 |

两种模式的开发入口均为只读验证，退出不保存。若依赖项被拒绝，保持源文件不变；不自动下载、改写或扩大根目录。取消/失败的打开保留控制器原会话，成功切换创建新 session 并撤销旧权限。编辑集成实验的目录切换另受 Workspace 输入/确认规则约束。诊断的 CSP 事件源和隐私边界见 [目录资源合同](PROJECT_RESOURCES.md)。原生选择器人工操作、Windows 10/macOS、网络盘和云同步目录尚未验收。

`test-results/security.json` 记录本次 commit/工作区、运行版本、自制样例 SHA-256、10 组已执行断言与零网络连接结果；`security-proofread.png` / `security-interactive.png` / `security-preview.png` 是忽略的渲染截图。预览原生文件输入被取消、下载事件被 preventDefault，以及主/子 frame 保存调用无 handler 均有执行断言；输出中的两条 `No handler registered for 'hae:save'` 是预期负向证据。详见 [HAE-002 记录](implementation/HAE-002.md)。

## 本地检查和平台待验项

按维护者要求，不使用 GitHub Actions/CI；仓库 Actions 已关闭，工作流配置已从本地源文件中移除。上述检查保留为本地命令，结果与截图存入被忽略的 `test-results/`，不自动上传。`npm ci` 用于按锁文件安装依赖，并非启用 GitHub CI。

| 目标环境 | 执行方式 | 当前验证状态 |
| --- | --- | --- |
| Windows 11 x64 | 本机运行相同锁文件和固定工具链的检查 | 已有 HAE-001 至 HAE-005 及 HAE-008 后台集成阶段记录，不能代替产品验收 |
| Windows 10 x64 | 对应实机或隔离 VM 运行同一检查和验收 | 待验证，不能由 Windows 11 结果代替 |
| macOS 13+ arm64 | Apple Silicon Mac 本地构建、检查与人工验收 | 当前没有 Mac 实测结果 |

每次验证保留实际 OS/架构、工具链版本、commit、工作区状态及 `platform.json` / `smoke.json`。macOS 最低版本、Windows 10、IME、DPI、键盘、安装器与维护者人工验收仍待执行；不把无人可执行的远端作业作为前置条件。

## 环境排错

- Electron 下载失败：检查正常 TLS/代理与网络，重试 `npm ci`；不关闭证书校验，不改用不受支持版本。
- npm 子进程提示找不到 node/tsc，但 PowerShell 能找到：检查继承的 PATH 是否异常过长。可在新终端使用仅含本次工具链所需目录的进程级 PATH；不修改系统 PATH。本次本地验证采用此方式隔离宿主环境问题。
- 内嵌终端继承 `ELECTRON_RUN_AS_NODE`：启动脚本仅对子进程移除此标志，确保运行真正 Electron。
- 启动超时或冒烟失败：保留 failed/running 报告并返回非零退出码；即使 Electron 意外以 0 退出，也不能误报通过。修复后重新构建和执行检查。
