# 架构决策记录

日期：2026-09-08。下列“采用”表示计划基线采用；不代表软件已实现或通过验证。候选项在对应实验结束后补充结果。

2026-09-09 实施更新：静态定位见 ADR-011，纯字节候选见 ADR-012；文件事务仍待验证。

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

## ADR-011：静态完整树核对与对象身份登记

**HAE-003 实验通过，采用为初始静态范围。** 固定 parse5 8.0.1，开启 sourceCodeLocationInfo 和 scriptingEnabled；后者与保留 JS 引擎、通过 CSP 禁止脚本的 Chromium 校稿环境一致。完整比较规范化树的顺序、父子关系、命名空间、属性、doctype/兼容模式、注释、template.content 和 Text 值，再在隔离世界登记 Text 对象身份。源码字节范围、旧片段 hash 与上下文指纹始终由 Main 的源索引提供。

连续范围必须独立解码成相同的单 Text。缺失范围、重叠、非连续合并、特殊上下文拒绝；parse5 未报告错误的 formatting element 克隆也检测并拒绝。其他解析错误使整页只读，缺少 doctype 可在兼容模式一致时核对。重复文字与重复 id 通过完整树和不同源码范围区分；不使用全局 replace、selector 或页面传来的偏移授权。

从 DOMContentLoaded 开始观察变化；绑定后同时登记对象身份、校验 generation/revision 并同步排空 MutationObserver 记录。相同值重建、移走再放回、拆分再合并都使会话映射失效。JS 交互视图不安装映射；Shadow DOM 和伪元素文字保守只读。身份确认是瞬时检查，不是写租约，后续应用草稿需新的同步验证/修改合同。

代价是部分浏览器能够显示的 HTML 暂不能选字；不因追求可编辑覆盖率放弃准确性。Main 使用可终止 worker 执行解析，V8 堆限制和超时不等于整个进程的硬内存限制。原始库许可随构建保留。10 组真实 Electron 检查、支持矩阵、失败反例与平台限制见 [HAE-003 记录](implementation/HAE-003.md)；尚无 Patch、保存、产品 UI 或实机人工验收。

## ADR-012：验证完整候选后才改变内存 Patch 状态

**HAE-004 已实施。** 纯核心从重新核验的冻结源索引生成每节点一份净 Patch。全部范围、旧片段 hash、上下文、新文字编码和结果大小核验后，拼接原字节片段与替换字节，独立比较未改片段，并重新解析整树。除指定 Text 改值或清空外，结构、属性、脚本及其他文本必须保持一致；任何失败保留原候选。

代价是每次计算需要重解析候选；交互接入使用可取消任务，性能门槛留到 HAE-013。收益是 UI Diff 和保存可以引用同一冻结结果，不在确认后重新生成另一份输出。A→B→A 与无操作保留原实体词法；pre/listing 起始换行按已证明上下文补偿，并以真实 Chromium 重开验证。本节点交付核心状态，Main 集成另见 ADR-013；撤销历史、保存点和覆盖事务仍待完成。详见 [HAE-004](implementation/HAE-004.md)。

## ADR-013：先验证候选，再同步应用草稿；M1 仅创建新文件

**HAE-005 第一段实验通过。** Main 在有期限和取消的 worker 中验证完整候选，再向隔离 registry 发出绑定当前选择的文本命令；registry 同步验证对象、版本和旧值后赋值，观察器始终连接并精确消费本次唯一记录。Main 必须取得对应 requestId 和递增版本的可信确认才发布候选；未知结果保留已知/待确认候选并停止重试。

M1 另存仅在已授权目录独占创建新 HTML，经 flush、回读 hash 与路径/句柄身份检查返回结果。已有文件始终拒绝，创建后失败保留现场；不移动原入口保存点或清空草稿。该边界保留相对资源关系，并避免在 HAE-010 备份/journal/冲突/恢复未完成时开放覆盖。代价是暂不跨目录复制资源，未知结果尚需后续恢复 UI，且不承诺对外部进程的强 CAS 或断电持久性。当前只有自动实验入口，产品 UI 和原生操作验收仍待完成，详见 [HAE-005](implementation/HAE-005.md)。

## ADR-014：固定编辑目标，单独保存未应用输入

**HAE-005 第二段后台实验通过。** 可信调用方须先取得隔离 registry 确认的编辑 token，才创建 Main 输入记录。持有 token 时，原生点击与跨节点选区成为待处理意图，不能移动正在编辑的目标；确认意图时检查最新 sequence。应用沿用原 Text 对象，继续验证映射、旧值和当前 revision。开始/结束确认超时会撤销权限并保留数据。

输入文本、已应用值、输入 revision 和 composing 单独保存在 Main；更新输入不产生 Patch，组合态不响应应用级操作。应用失败不覆盖输入，放弃不产生 Patch；应用并切换先提交旧目标草稿，再接受新意图。新意图若已出现，后一步拒绝并保留已应用结果。该合同为后续 Kimi 前端提供稳定数据边界，不能替代真实组合事件、焦点、原生关闭对话框或崩溃持久化。见 [HAE-005 阶段记录](implementation/HAE-005.md)。

## ADR-015：编辑器接口绑定实际页面与逐次保存结果

HAE-005 第三段采用 WebContents 局部 IPC，固定可信顶层页面、会话及 InputController。Main 严格核对来源与命令 schema，随机连接身份和递增 sequence 拒绝旧请求；连接标识只在 preload 内部使用。页面导航或崩溃撤销接口，Main 草稿独立保留。此实现遵循 [Electron 的 IPC 来源校验要求](https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages)，并在本地 Electron 44.2.0 执行来源反例。

每次 saveCopy 独立返回 cancelled/created/failed/unknown，取消不能误用历史成功记录，失败与未知不能返回成功。选择器前后检查会话，文件路径只来自 Main；尚未提供更换文档、窗口关闭保护或重启恢复协议。公开方法、前端交接和验证限制见 [接口合同](EDITOR_BRIDGE.md)。
