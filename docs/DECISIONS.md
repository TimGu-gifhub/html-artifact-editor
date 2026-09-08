# 架构决策记录

日期：2026-09-08。下列“采用”表示计划基线采用；不代表软件已实现或通过验证。候选项在对应实验结束后补充结果。

## ADR-001：采用 Electron 与同版本 Chromium

**采用。** 项目核心是渲染现有 HTML 并定位文字，Windows/macOS 共用 Chromium 的价值高于最小安装包体积。比较过 Tauri 系统 WebView 的路线，本项目优先渲染语义的一致性；不承诺不同 OS 字体、DPI 和原生控件的像素一致。

代价是安装包、内存与运行时更新责任。Windows 10/11 x64、macOS 13+ arm64 是首期验证目标；每次固定版本都重新核对 [Electron 平台支持](https://github.com/electron/electron#platform-support)，不把计划最低版本永久写死。

## ADR-002：原始字节为源，parse5 只提供索引

**采用。** 精确修改要保留未选源码，不能保存浏览器当前 DOM 或重新序列化整份 AST。parse5 提供位置，核心自行实现 UTF-16 到字节映射、范围校验和 Buffer 拼接。

代价是需维护支持矩阵、实体规则和完整错误路径。收益是字节不变量可独立测试。验证任务 HAE-003/004；参照 [parse5 源码位置信息](https://parse5.js.org/interfaces/parse5.ParserOptions.html)。

## ADR-003：可信 UI 与用户 HTML 分离

**采用。** BrowserWindow 承载编辑器，WebContentsView 承载用户 HTML；使用独立源/session、隔离 preload 和 Main 权威状态。页面只能报告选择，不能授权文件读写。

代价是原生视图尺寸、层级与焦点协调。MVP 输入优先可信侧栏；不为浮层降低隔离要求。参照 [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security) 和 [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)。

## ADR-004：离线默认、静态校稿与交互预览分开

**采用为首版保守边界，待产品实测。** 静态校稿关闭页面脚本并使用验证映射；本地脚本交互预览只读。两种模式都默认阻断网络，不自动下载 CDN。

这是对初步讨论中“JS 正常执行且都能安全编辑”的收紧：任意运行时文字的来源与持久化目标无法单凭 DOM 判断。代价是部分动态页面在校稿时不完整，切换要重新加载；好处是可先交付可证明的小范围。若 HAE-003 提供可靠新证据，再单独决定扩展，而不是默默放开。

## ADR-005：显式保存、备份和单文件事务

**采用。** 应用草稿与写盘分开；只在保存时修改 HTML。备份与恢复记录在应用私有目录，Preview 不可读。首版不自动合并外部变更，也不做多文件原子保存。

候选平台封装仍需验证。常规 rename 不自动等于跨 OS 的掉电安全或强 CAS；HAE-010 必须记录实测和残余竞态。

## ADR-006：React/TypeScript 单包结构，最小依赖

**HAE-001 已实施工具链部分。** 单包、单 npm 锁文件；Electron 44.2.0、React 19.2.8、TypeScript 6.0.3、Vite 8.2.2。纯核心不依赖 UI 和 Electron；平台分支仅在适配层。版本详情、许可证和未测项见 [开发说明](DEVELOPMENT.md)。

构建用 Vite JavaScript API 分别产出 Main、UI preload、Preview preload、UI 与 Preview；每个 preload 为单文件 CJS，沙箱中不加载共享 chunk。开发启动同样读取本地构建产物，无 HTTP/HMR 服务。代价是修改后需重启。Forge 的 [Vite 插件仍标记为实验性](https://www.electronforge.io/config/plugins/vite)，当前没有安装器任务，留到 HAE-015 评估。

测试采用 Node 自带测试运行器与独立 Electron 主进程冒烟入口，暂不引入 Vitest/Playwright/Radix。TypeScript 6 保留稳定编译器 AST API，用于模块边界检查；迁移 TypeScript 7 的原生工具链及新 API 留作独立升级。新增依赖仍须说明必要性、替代方案和维护代价。

## ADR-007：MIT 开源与透明能力状态

**采用，MIT 由项目维护者指定。** 仓库原创代码和文档使用根目录 [LICENSE](../LICENSE)。第三方许可单独保留；用户的输入内容保持其原许可证。当前只发布规划仓库，不创建误导性的应用 Release。

MIT 正文采用 [GitHub MIT 模板](https://api.github.com/licenses/mit)，许可类型参照 [OSI MIT 条目](https://opensource.org/license/mit)。

## ADR-008：AI 以验收结果驱动开发

**采用。** 一个 Issue 对应有限范围、依赖、产物、自动与人工证据。AI 不自行扩展为网页搭建器，不以测试数或截图替代可用性，也不把设备不可用标成通过。

默认单写入者逐项推进；若另有明确的并行安排，须先划分文件与接口所有权，合并后统一验证。详见 [AI 开发流程](AI_WORKFLOW.md)。

## ADR-009：前端使用 Kimi 最新正式可用模型

**采用，维护者于 2026-09-08 指定。** 前端 UI 设计、组件、样式、交互与可访问性改动使用 Kimi 最新正式可用模型。当前核对基线为 Kimi K3，完整 Kimi Code CLI 别名为 `kimi-code/k3`；依据为 [Kimi 官方模型说明](https://www.kimi.ai/blog/kimi-k3) 与 [CLI 模型配置文档](https://moonshotai.github.io/kimi-code/en/configuration/config-files)。

每项前端任务启动前重新核对，并记录实际模型与执行证据；任务中保持版本一致，不静默替换模型。主开发代理负责纯核心、保存、安全、集成和独立复核，混合任务先划分前端文件与接口，默认只有一个写入者。

此决策规定开发分工，应用技术栈和离线能力保持既定设计；不增加应用内模型调用。实际 Kimi 任务仍须完成完整交互验证，模型配置存在不等于已完成模型调用或前端验收。详见 [AI 开发流程](AI_WORKFLOW.md)。

## ADR-010：使用本地检查与人工验收，取消 GitHub CI

**采用，维护者于 2026-09-08 指定。** 不使用 GitHub Actions/CI；关闭仓库 Actions，移除文档和工具链工作流配置。保留 `npm run check`、`python tools/check_docs.py` 和 `git diff --check` 等本地检查，`npm ci` 继续作为锁定依赖安装命令。

Windows/macOS 的构建、冒烟、权限与 UI 验收在实际目标环境完成，记录 commit、工具链、OS/架构、命令、结果与未测项。远端 CI 不作为任务、合并或发布门槛；没有 Mac 设备时相应验收仍为待执行。此决策取消远端执行方式，保留源码保护、安全检查和真实用户验收标准。
