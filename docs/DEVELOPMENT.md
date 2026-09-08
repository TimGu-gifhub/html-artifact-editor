# 开发与工具链

日期：2026-09-08。范围：HAE-001 工具链及 HAE-002 独立只读项目预览验证入口。

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
| 单元测试 | Node 内置 node:test | 无额外测试框架、浏览器下载 |
| 文档检查 | Python 3.10+ | 无第三方 Python 依赖 |

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

| 命令 | 产物或检查 |
| --- | --- |
| `npm run build` | 六个构建目标，包含独立 out/preview-tool 入口 |
| `npm run build:main` | out/main/index.cjs |
| `npm run build:preload:ui` | out/preload/ui/index.cjs，独立单文件 CJS |
| `npm run build:preload:preview` | out/preload/preview/index.cjs，独立单文件 CJS |
| `npm run build:ui` | out/ui，React 渲染器 |
| `npm run build:preview` | out/preview，固定静态样例 |
| `npm run typecheck` | 纯核心、主进程/preload、UI 三套 strict 编译边界 |
| `npm run check:boundaries` | AST 检查跨层 import/export/动态加载与核心平台全局变量 |
| `npm test` | 契约、边界、资源路径/句柄/快照/撤销测试；没有 Patch 算法测试 |
| `npm run test:smoke` | 已构建应用的 Electron 冒烟，独立 out/smoke 入口 |
| `npm run test:security` | 已构建 preload 的真实项目协议、两种模式、恶意请求和 IPC 测试；独立 out/security 入口 |
| `npm run preview` | 构建后打开原生文件选择器，以禁用页面脚本的模式只读预览 |
| `npm run preview:interactive` | 同上，允许本地脚本执行，仍无编辑或保存能力 |
| `npm run diagnostics` | 本机实际 OS/架构与 Node/npm；历史 runner 字段在本地通常为 null |
| `npm run licenses` | 更新依赖清单，复制原始声明至 out/licenses |
| `npm run licenses:check` | 清单与锁文件比对，核验/复制声明 |
| `npm run check` | 类型 → 边界 → 单元测试 → 构建 → 内置冒烟 → 项目安全测试 → 许可证 |

另运行 `python tools/check_docs.py` 与 `git diff --check`。构建目录、安装器、测试截图与临时 profile 均被忽略；不得提交个人 HTML 或私有诊断材料。

## 运行边界与证据

验证壳在 BrowserWindow 中展示启动状态，在 WebContentsView 中展示内置只读样例。UI/Preview 使用不同内存 session、协议源与 preload。只服务构建产物内存白名单，无用户文件打开或写入能力。Preview 的页面脚本由严格响应头 CSP 禁止；隔离 preload 不暴露页面 API。

smoke 记录 preload 实际报告的 sandbox/contextIsolation、页面 Node 能力缺失、源/session 分离、脚本阻断、外部请求/弹窗阻断、尺寸跟随和子视图销毁。截图前会短暂显示不抢焦点的测试窗口，然后自动关闭。报告位于 `test-results/smoke.json`，记录基线 commit 及工作区是否有修改；截图仅是该内置样例的视觉证据。测试 profile 留在 `test-results/profile`，不作为公开 artifact 上传。

HAE-002 的 `preview` / `preview:interactive` 使用独立原生选择器与 WebContentsView，项目文件协议与生命周期由 Main 管理；`dev` 内置壳及 React UI 保持原样。没有源码映射、草稿、保存、备份或恢复。产品视觉稿仍需 HAE-007 选择，后续产品前端按 Kimi 分工执行。本任务没有调用 Kimi，也没有把安全测试页面标为产品设计。测试入口及其故意增强的攻击 preload 不从应用入口导入，没有页面可开启的测试开关。

## 项目资源范围

原生选择器选中的 HTML 及其父目录为授权范围，不接受页面消息中的路径。入口必须为有效 UTF-8，保持 BOM、换行、实体拼写与原 CSP 的原始字节。根内的可服务资源对本地脚本可读，请使用独立项目文件夹。

| 类型 / 行为 | 当前规则 |
| --- | --- |
| HTML | 只服务授权入口快照；其他 HTML 与目录列表拒绝 |
| CSS / 图片 / 字体 | CSS、PNG/JPEG/GIF/WebP/AVIF/ICO/SVG、WOFF/WOFF2/TTF/OTF；本地相对路径与 CSS import 可用 |
| JavaScript | 仅交互模式允许本地 js/mjs、模块与内联脚本；不允许 eval，不绕过原页 CSP |
| 网络与嵌入 | HTTP(S)/WebSocket、localhost/LAN、远程资源、frame、worker、data/blob、媒体和对象均拒绝；当前不会还原依赖这些能力的页面 |
| 私有文件 / 路径 | 隐藏路径、backups/recovery/drafts/credentials/secrets、node_modules、非白名单扩展名拒绝；符号链接、junction、硬链接、ADS、UNC/设备路径、DOS 别名、尾部点/空格、二次编码拒绝 |
| 大小与预算 | 入口 5 MiB、单资源 16 MiB、同时读取最多 8 项、每代累计响应字节 128 MiB；15 秒启动保护。属于初始保护值，尚非性能验收结论 |
| 诊断 | Main 内最多 100 条阻断记录，只保留协议/主机摘要，不保留 URL 路径、查询或凭据；产品诊断界面留到 HAE-008 |

两种模式均为只读验证，退出不保存。若依赖项被拒绝，保持源文件不变；不自动下载、改写或扩大根目录。取消/失败的打开保留控制器原会话，成功切换创建新 session 并撤销旧权限。原生选择器人工操作、Windows 10/macOS、网络盘和云同步目录尚未验收。

`test-results/security.json` 记录本次 commit/工作区、运行版本、自制样例 SHA-256、10 组已执行断言与零网络连接结果；`security-proofread.png` / `security-interactive.png` / `security-preview.png` 是忽略的渲染截图。预览原生文件输入被取消、下载事件被 preventDefault，以及主/子 frame 保存调用无 handler 均有执行断言；输出中的两条 `No handler registered for 'hae:save'` 是预期负向证据。详见 [HAE-002 记录](implementation/HAE-002.md)。

## 本地检查和平台待验项

按维护者要求，不使用 GitHub Actions/CI；仓库 Actions 已关闭，工作流配置已从本地源文件中移除。上述检查保留为本地命令，结果与截图存入被忽略的 `test-results/`，不自动上传。`npm ci` 用于按锁文件安装依赖，并非启用 GitHub CI。

| 目标环境 | 执行方式 | 当前验证状态 |
| --- | --- | --- |
| Windows 11 x64 | 本机运行相同锁文件和固定工具链的检查 | 已有 HAE-001/002 本地执行记录，不能代替产品验收 |
| Windows 10 x64 | 对应实机或隔离 VM 运行同一检查和验收 | 待验证，不能由 Windows 11 结果代替 |
| macOS 13+ arm64 | Apple Silicon Mac 本地构建、检查与人工验收 | 当前没有 Mac 实测结果 |

每次验证保留实际 OS/架构、工具链版本、commit、工作区状态及 `platform.json` / `smoke.json`。macOS 最低版本、Windows 10、IME、DPI、键盘、安装器与维护者人工验收仍待执行；不把无人可执行的远端作业作为前置条件。

## 环境排错

- Electron 下载失败：检查正常 TLS/代理与网络，重试 `npm ci`；不关闭证书校验，不改用不受支持版本。
- npm 子进程提示找不到 node/tsc，但 PowerShell 能找到：检查继承的 PATH 是否异常过长。可在新终端使用仅含本次工具链所需目录的进程级 PATH；不修改系统 PATH。本次本地验证采用此方式隔离宿主环境问题。
- 内嵌终端继承 `ELECTRON_RUN_AS_NODE`：启动脚本仅对子进程移除此标志，确保运行真正 Electron。
- 启动超时或冒烟失败：保留 failed/running 报告并返回非零退出码；即使 Electron 意外以 0 退出，也不能误报通过。修复后重新构建和执行检查。
