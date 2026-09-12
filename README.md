# HTML Artifact Editor

**本地离线的 HTML 成品修订器：在页面上选中文字，精确修改源文件。**

A local-first desktop editor for precise text corrections in existing HTML artifacts.

AI 生成报告、仪表盘或展示页后，人可以直接校对标题、日期、段落和表格文字。项目的核心目标是：只改变用户确认的文本范围，保留其余 HTML、CSS、JavaScript 和资源文件。

> **当前状态：Windows 产品工作台开发预览。** 正常入口已连接真实文件选择、静态文字校稿、实时草稿预览、逐条/全选复核、源码 Diff、备份保存与撤销/重做。采用维护者选定的方案 B，校稿栏可以隐藏或拆为独立浮窗，并提供 PDF 打印预览与导出。实际执行范围和未测项见 [HAE-009 交付记录](docs/implementation/HAE-009.md)。

**已具备：**

- 点击支持的静态文字，在原位置直接输入，短暂停顿后自动更新预览；HTML 仍须明确复核保存。
- “显示隐藏内容”可临时展开预先存在的隐藏正文，用于校稿标签页后续内容；保存保留原始显隐和标签脚本。当前支持范围与页面样式限制见 [隐藏静态内容校稿](docs/HIDDEN_CONTENT.md)。
- “浏览”切到目标标签后，返回“编辑文字”可保留经核验的预置正文与位置，直接点击原文修改；工具栏可打开复核并全选保存，保存后仍保留当前面板。侧栏和浮窗为可选载体。范围见 [浏览后就地校稿](docs/CONTEXTUAL_EDIT.md)。
- 浏览中已显现的渐显正文、已展开问答和本地提交后显示的预置提示，可经完整源码核验后继续原位校稿。显示只作用于当前屏幕；脚本生成/改写的正文仍只读，范围与后续计划见 [当前显示补充](docs/CURRENT_VIEW.md)。
- 查看真实原文/新文，逐条或全选确认；再次修改某条会取消该条的复核标记，保存前核对最新源码 Diff。
- 隐藏校稿栏扩展预览；拆卸为原生独立窗口，收回时保留同一文档与输入。
- 从当前草稿生成 A4/Letter PDF，选择横向和背景；查看器与导出使用同一份字节，导出不保存 HTML。首版仅创建新 PDF，不覆盖已有文件。
- 明确授权项目目录和入口；从“更多操作”切换同一目录内的 HTML，保留草稿离开确认；提供资源诊断、另存 HTML、私有草稿持久化/恢复和经单独确认的整份备份恢复。
- 恢复草稿时可重新选择“HTML 文件”或“项目目录”。子目录中的报告可通过明确重选项目根目录恢复共享资源；默认文件方式使用 HTML 所在文件夹，不自动扩大授权。
- 重启后可从“更多操作 → 检查上次中断”重新选择原文件，核验并单独确认完整保存事务、原文件未变且意图完整的保存准备中断，或检查点清理中断。处置保留当前 HTML 和残留证据；不重放未确认保存。范围见 [产品中断检查](docs/INTERRUPTION_WORKFLOW.md)。
- 在工作台内切换静态校稿与脚本只读预览，保留目录授权；返回时重建源码映射，动态页面文字不进入草稿。干净历史可继续撤销/重做，脏草稿先处理取消、放弃或另存。
- Windows 保存先备份，再执行原生替换并回读核验；失败或未知结果保留草稿和证据，阻止盲目重试。
- 保存结果未知或保存后重建失败时，可把已确认草稿另存为独立新 HTML；原保存故障与证据继续保留，副本成功不自动解除冻结。范围见 [保存故障草稿保全](docs/SAVE_FAILURE_COPY.md)。
- 在打开文档前，可用“更多操作 → 清理本地记录”检查并单独确认删除应用的全部草稿、历史和备份，释放记录额度。清理不修改项目文件；完整清单的中断可在重启后重新核对并确认继续。范围见 [本地记录清理](docs/RECORD_CLEANUP.md)。

**尚不能：** 保证任意页面上的全部文字都可编辑。只有能唯一对应源码且上下文受支持的静态 Text 可以修改；脚本生成文字、表单/按钮、Canvas、SVG 和歧义结构不属于当前保证范围。脚本只读模式不能编辑、保存或生成草稿 PDF，需返回静态校稿操作。安装包、Mac 保存、部分/损坏记录的故障处置、活动未知会话解除冻结及选择性保留历史/备份的清理尚未交付。

**当前风险：** 自动验证使用自制文件和 Main 控制的选择/确认回调；真实 Windows 输入法、原生选择器、Windows 10、DPI/读屏、多显示器和维护者报告验收仍需执行。M2 尚未整体验收，不能由单元测试或截图推定完成。

[HAE-012 产品自动验收](docs/implementation/HAE-012.md) 已通过五处修改后的实际 Main 强杀/恢复、复核保存、独立 Edge 重开、撤销后再次保存、整份备份恢复，以及外部冲突后的草稿另存。[HAE-008 产品入口与模式切换](docs/implementation/HAE-008.md) 已补充取消、越界、浮窗、窄窗、模式往返和空文字历史回归。遗留故障处理仍待补齐，维护者独立校稿仍待验收。

## 核心流程

打开本地 HTML → 点击支持的文字 → 输入并自动预览 → 勾选复核变更 → 确认源码 Diff → 备份并保存 → 独立重新打开核对。

- 本地运行，无需账号、云服务或 AI API；预览默认阻断网络请求。
- 只替换已经验证的文字范围，保留其余 HTML、CSS、JavaScript、BOM、换行和资源字节。
- Escape 取消尚未预览输入；已预览内容用“还原本段”或撤销恢复。只有显式保存或单独确认的备份恢复覆盖 HTML。
- Electron + React + TypeScript，共用编辑核心；当前产品装配要求 Windows，平台目标与未验收项见 [开发说明](docs/DEVELOPMENT.md)。

底层依据包括 [统一会话](docs/WORKSPACE_SESSION.md)、[保存事务](docs/SAVE_PREPARATION.md)、[草稿检查点](docs/DRAFT_CHECKPOINTS.md)、[逻辑历史](docs/HISTORY.md)、[固定存储启动](docs/PERSISTENT_STARTUP.md) 与 [应用退出](docs/APPLICATION_QUIT.md)。实时输入、复核、窗口归属和 PDF 合同见 [产品工作台](docs/LIVE_WORKBENCH.md)；文字支持范围见 [PRD](PRD.md) 和 [Patch 规范](docs/PATCH_SPEC.md)。

## 阅读顺序

| 文档 | 回答的问题 |
| --- | --- |
| [PRD](PRD.md) | 为谁解决什么问题，哪些支持、哪些只读、哪些不做 |
| [产品与交互设计](docs/PRODUCT_DESIGN.md) | 点击、编辑、取消、中文输入、保存失败和关闭窗口如何工作 |
| [架构](ARCHITECTURE.md) | 渲染隔离、模块职责、文件权限和技术选型 |
| [Patch 规范](docs/PATCH_SPEC.md) | 如何定位文本、保护原始字节、处理冲突与恢复 |
| [路线图](ROADMAP.md) | 最小闭环、MVP、双平台 Alpha 和稳定版的顺序与估算 |
| [任务清单](docs/BACKLOG.md) | 每项任务的依赖、产物、验收条件和 GitHub Issue |
| [测试计划](docs/TEST_PLAN.md) | 如何证明功能可用、源码未误改、失败不会丢数据 |
| [风险与决策](docs/RISKS.md) | 哪些技术问题必须先验证，失败如何缩小范围 |
| [架构决策记录](docs/DECISIONS.md) | 为什么选择这些技术，哪些仍然是候选方案 |
| [AI 开发流程](docs/AI_WORKFLOW.md) | AI 如何按小任务推进，人工负责哪些判断 |
| [发布计划](docs/RELEASE.md) | 打包、签名、真实机器验证和公开发布条件 |
| [资料来源](docs/REFERENCES.md) | 经核对的官方技术资料及方案推导边界 |

## 开发状态与时间目标

| 阶段 | 目标时间，按可连续投入的工作日估算 | 完成条件 |
| --- | --- | --- |
| 首个最小闭环 | 1–3 天，属于 M1 内部检查点 | 自制静态样例打开、选字、修改、另存并重新打开 |
| M1 可行性验证 | 累计 2–4 天 | 源码映射、字节修改、预览隔离的技术门槛通过 |
| M2 可用 MVP | 累计 5–10 天 | Windows 上真实离线报告的修改、备份、冲突、撤销和恢复验收 |
| M3 双平台 Alpha | 累计 2–4 周 | Windows 与 Apple Silicon Mac 的打包和实机验收 |
| M4 v1.0 | 累计 4–8 周 | 扩充语料、修复真实使用问题，达到稳定版门槛 |

这是小范围、AI 主导开发的条件估算，并非交付承诺；源码映射验证失败、Mac 设备和签名准备可能改变日历时间。详细假设见 [路线图](ROADMAP.md)。

## 参与项目

已建立 [5 个里程碑](https://github.com/TimGu-gifhub/html-artifact-editor/milestones) 和 [20 个实施 Issues](https://github.com/TimGu-gifhub/html-artifact-editor/issues)。从 [本地任务清单](docs/BACKLOG.md) 选择一个依赖已满足的任务；首次实施从 [HAE-001](https://github.com/TimGu-gifhub/html-artifact-editor/issues/1) 开始。提交前阅读 [贡献指南](CONTRIBUTING.md)；AI 开发工具还需阅读 [AGENTS.md](AGENTS.md)。

开发环境固定为 Node.js 24.14.1、npm 11.19.1；文档检查另需 Python 3.10+。

```sh
npm ci
npm run dev
```

`dev` 先构建再启动产品工作台，使用“打开 HTML”或“打开目录”选择文件；修改源码后关闭窗口并重新执行。当前不提供热更新。已构建后可直接 `npm start`。

Windows 开发启动请使用独立终端。某些 MSIX 打包的开发工具会重定向子进程的 AppData，触发 `STORAGE_LOCATION_CHANGED`；这种启动环境当前不支持，不能通过放宽目录校验或更换恢复目录绕过。已验证普通桌面会话中的正常入口启动，详见 [启动排错](docs/DEVELOPMENT.md#启动环境与-appdata-重定向)。

工作台的“只读预览”按钮或“更多操作”可以切换模式；返回时重新加载源文件，详见 [模式合同](docs/MODE_SWITCH.md)。独立只读验证入口仍保留：

```sh
npm run preview
npm run preview:interactive
npm run preview:directory
npm run preview:directory:interactive
```

前两条命令以 HTML 所在文件夹为根；后两条先选择项目文件夹，再选择其中的 HTML，可加载根内的共享资源。`interactive` 允许本地脚本，其余入口禁用页面脚本。根内允许的预览资源可被本地脚本读取，请选择独立项目目录。诊断输出到开发终端；入口没有编辑、保存、诊断面板或产品模式切换控件。兼容限制见 [目录资源合同](docs/PROJECT_RESOURCES.md)；原生选择器的人工验收仍待执行。

上述静态只读验证入口在开发终端输出映射状态；点击支持的文字可看到 Main 核验的 nodeId、generation、revision 与字节范围。页面没有桥，也不写文件。交互入口不创建映射。

```sh
npm run check
python tools/check_docs.py
git diff --check
```

命令、依赖版本、输出边界与环境排错见 [开发说明](docs/DEVELOPMENT.md)，许可证见 [依赖清单](docs/DEPENDENCIES.md)。本项目不使用 GitHub CI，仓库 Actions 已关闭；构建、测试、启动冒烟和文档检查在本地执行，平台可用性由对应 Windows/Mac 实机验收。`npm ci` 是锁定依赖安装命令，继续保留。

## AI 辅助开发与致谢

本项目在需求梳理、架构设计、代码实现、测试和文档编写过程中，使用了 **ChatGPT / Codex** 与 **Kimi / Kimi Code** 辅助开发。感谢以下公司及其研究、产品与工程团队提供的模型和工具：

- **[OpenAI](https://openai.com/)**：感谢 **ChatGPT、Codex 和 GPT 系列模型（含本阶段实际使用的 GPT-6）**，为项目规划、核心实现、代码审查与文档完善提供帮助；本阶段 Codex（GPT-6）参与 Main 历史、持久化、启动与退出协调、提交后的恢复协调、检查点清理及其中断恢复、保存锁审查与原生占用保护，以及产品 Main 装配、浮窗/PDF 隔离、文件导出、独立集成测试，以及目录恢复的代码复核/进程中断/原生保存/Edge 回归与合同更新。
- **[月之暗面（Moonshot AI）](https://www.moonshot.ai/)**：感谢 **Kimi、Kimi Code 和 [Kimi K3 模型](https://www.kimi.com/news/kimi-k3)**，支持了[前端视觉候选的设计、实现与修正](docs/implementation/HAE-007.md)，并通过 Kimi Code CLI **0.42.0** 实际完成[方案 B 产品 UI、原位输入、实时预览和交互修正](docs/implementation/HAE-009.md)、[目录内入口切换、模式切换、只读交互状态与菜单修正](docs/implementation/HAE-008.md)，以及[目录恢复选项与异步交互保护](docs/implementation/HAE-011.md)；完整别名为 `kimi-code/k3`，实际配置模型为 `k3`。

AI 用于开发辅助，应用本身保持本地离线，不依赖云端模型或 AI API。开发分工、实际调用记录与人工复核要求见 [AI 开发流程](docs/AI_WORKFLOW.md)。

本次产品中断检查由 Kimi Code / Kimi K3 实现界面、原生确认文案与焦点修正，Codex（GPT-6）实现 Main 编排、关闭保护、合同及独立进程/文件验证；感谢月之暗面与 OpenAI 的上述工具和模型。实际调用和未测边界见 [HAE-010 第七阶段](docs/implementation/HAE-010.md)。

本地记录清理继续由 Kimi Code CLI 0.42.0 / Kimi K3（`kimi-code/k3` / `k3`）实际完成方案 B 菜单、流程状态和原生确认文案；Codex（GPT-6）实现私有清单、精确删除、Main 生命周期及独立文件/进程验证。感谢月之暗面与 OpenAI 的这些工具和模型，执行范围见 [HAE-011 第十六阶段](docs/implementation/HAE-011.md)。

准备阶段中断的后续扩展由 Codex（GPT-6）完成 Main 验证、版本化证据、备份分类及独立故障/产品测试，界面沿用此前 Kimi K3 的实现。感谢 OpenAI 与月之暗面及上述模型对这些阶段的实际帮助，详见 [HAE-010 第八阶段](docs/implementation/HAE-010.md)。

隐藏静态内容校稿由 Kimi Code CLI 0.42.0 / Kimi K3（`kimi-code/k3` / `k3`）实际完成方案 B 控件、异步输入保护、状态文案及长文件名布局修正；Codex（GPT-6）实现有限展示规则、Main 校验、样式撤回及独立产品/字节验证。感谢月之暗面、OpenAI 及上述工具和模型，详见 [HAE-009 后续交付](docs/implementation/HAE-009.md)。

浏览后就地校稿由 Kimi Code CLI 0.42.0 / Kimi K3 实际完成浏览/编辑控件、精确边框 Canvas、小窗与一次性聚焦；Codex（GPT-6）负责源子树证明、Main 展示交接、隔离与窗口集成、字节及真实产品验证。感谢月之暗面、OpenAI 及上述工具和模型，交付范围见 [HAE-009](docs/implementation/HAE-009.md)。

原位输入与当前显示补充继续由 Kimi Code CLI 0.42.0 / Kimi K3（`kimi-code/k3` / `k3`）实际完成输入 UI、复核入口及渐显/问答/部分保留提示；Codex（GPT-6）完成 Main 源码证明、屏幕样式、隔离本地提交、文件保护及独立原生验证。感谢月之暗面与 OpenAI 的上述模型和工具。具体调用、验证与人工边界见 [HAE-009 第四、五阶段](docs/implementation/HAE-009.md)。

保存故障草稿保全由 Kimi Code CLI 0.42.0 / Kimi K3（`kimi-code/k3` / `k3`）实际完成冻结输入、自动操作暂停及相关 UI 测试；Codex（GPT-6）负责冻结候选的独立副本、Main 输入排空与保存保护、独立文件/窗口验证及文档。感谢月之暗面、OpenAI 及上述工具和模型，详见 [HAE-010 第九阶段](docs/implementation/HAE-010.md)。

## License

本项目采用 [MIT License](LICENSE)。项目原创代码和文档允许按许可证条款使用、修改和分发；引入的第三方依赖仍须保留其各自许可证和声明。用户打开的 HTML 及资源不会因为被本工具编辑而改变其版权或许可证。
