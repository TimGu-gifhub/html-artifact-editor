# HTML Artifact Editor

**本地离线的 HTML 成品修订器：在页面上选中文字，精确修改源文件。**

A local-first desktop editor for precise text corrections in existing HTML artifacts.

AI 生成报告、仪表盘或展示页后，人可以直接校对标题、日期、段落和表格文字。项目的核心目标是：只改变用户确认的文本范围，保留其余 HTML、CSS、JavaScript 和资源文件。

> **当前状态：目录资源与校稿窗口的集成实验。** HAE-001 至 HAE-004 已验证工具链、隔离预览、静态映射与纯字节 Patch；HAE-005 已连接统一 Main 窗口中的输入、可信 IPC、另存/重开、视图回滚与关闭保护。HAE-008 新增明确选择项目根和入口、保留授权的入口切换，以及缺失/CSP 阻断资源的实时诊断。正常应用入口仍只读，尚无产品校稿/诊断面板、覆盖保存、备份恢复或安装包；HAE-005/008 与 M2 尚未整体完成，见 [校稿阶段记录](docs/implementation/HAE-005.md) 与 [目录阶段记录](docs/implementation/HAE-008.md)。

HAE-010 已连接 [保存事务与窗口会话实验](docs/implementation/HAE-010.md)：私有备份/候选、合作实例锁、Windows 原生替换、结果回读与提交记录，经可信 IPC 显式保存后重新解析并建立新基线。失败或未知结果保留草稿与证据；Main 可检查重启记录，并显式恢复经验证的备份，恢复前再次备份当前文件。尚未接入正常应用，恢复向导、遗留锁处理和产品验收仍待完成；Main 跨保存历史接线见 HAE-011。

HAE-011 已实现 [私有草稿检查点与会话持久化实验](docs/implementation/HAE-011.md)：确认变化的 Apply 通过有界队列异步写入，准确报告已持久化版本，失败保留草稿并等待显式重试。Main 按修订选择最新点，明确丢弃/另存离开时等待并核验会话结束标记；较新不完整点或净变更归零不会恢复旧脏点。可信 IPC 可读取恢复摘要，重新授权并核验文件后，将草稿装入新映射窗口，继续原持久化序列；精确提交版本阻止重复应用。正常入口、产品恢复控件、失败后的处理、跨会话/备份清理及产品历史/Diff 面板尚未完成。

第六阶段已提供 [冻结候选的源码 Diff](docs/SOURCE_DIFF.md)：可信接口读取实际替换源码、UTF-8 范围及换行信息，显示数据可重建完整候选；从 Diff 确认保存时绑定其修订与 hash，过期确认拒绝。正常应用仍没有 Diff 面板或编辑控件，产品历史控件仍待接入。

第七阶段已实现 [逻辑历史与保存后的来源重建](docs/HISTORY.md)：准备/确认操作组、撤销/重做分支和保存点；清空后保存的 Text 通过新基线的完整结构与字节证明重新定位。第八阶段将证明接入隔离 Preview，核对真实 DOM 后安装空 Text，并按当前版本确认历史文字操作。真实 Worker、Windows 事务与原生预览实验已覆盖这些路径；第九阶段已接入 Main 文档/InputController 与可信 Workspace 历史命令，并以 v2 私有检查点保存操作链、Redo 和保存点；空 Text 可在验证保存后重建，并通过进程重启恢复实验。第十阶段补齐原生提交完成、干净历史点尚未落盘时的恢复：验证精确提交与当前文件，先形成新的干净历史点，再安装窗口；已有后续记录则阻止旧入口回退。组合标志、未应用输入或未确认结果阻止历史推进。正常入口和产品控件仍待接入，当前产品尚不能操作撤销/重做。

第十一阶段加入 [已被替代检查点的清理](docs/CHECKPOINT_COMPACTION.md)：同一活动 v2 会话保留最近两个完整点及全部逻辑历史，连续逐项持久化可超过旧 20 点上限。删除前保留有界记录，失败/强杀保留锁与现场；其他会话、失败记录和保存备份继续保留，整体配额与恢复失败处理仍需后续完善。

[HAE-007 视觉候选](docs/design/hae-007/README.md) 已提供三种可运行布局，用同一份自制报告演示校稿和状态切换，等待维护者选稿。它们只修改内存中的演示数据，不代表桌面应用已实现编辑或保存；实际检查见 [候选稿交付记录](docs/implementation/HAE-007.md)。

## 计划中的核心流程

打开本地 HTML → 浏览页面 → 选择可编辑文字 → 修改草稿 → 查看差异 → 保存 → 用浏览器重新打开验证。

- 本地运行，无需账号、云服务或 AI API；预览默认阻断网络请求。
- 对有明确源码位置的静态文本进行局部替换，不重新序列化整个 DOM。
- 取消编辑不写入磁盘；保存前检查文件变化，保存时生成可恢复备份。
- 撤销、重做、变更列表和源码差异共同帮助校对。
- Electron + React + TypeScript，共用编辑核心；Windows 10/11 x64 优先，macOS 13+ Apple Silicon 同步验证。

以上均为**目标能力**。动态生成文字、Canvas、复杂 SVG、跨节点富文本、框架源码和页面布局编辑不属于首版保证范围。详见 [产品范围](PRD.md) 和 [源码修改规范](docs/PATCH_SPEC.md)。

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

`dev` 先构建再启动，只显示内置样例；修改源码后关闭窗口并重新执行。当前不提供热更新。已构建后可直接 `npm start`。

只读项目预览使用独立验证入口：

```sh
npm run preview
npm run preview:interactive
npm run preview:directory
npm run preview:directory:interactive
```

前两条命令以 HTML 所在文件夹为根；后两条先选择项目文件夹，再选择其中的 HTML，可加载根内的共享资源。`interactive` 允许本地脚本，其余入口禁用页面脚本。根内允许的预览资源可被本地脚本读取，请选择独立项目目录。诊断输出到开发终端；入口没有编辑、保存、诊断面板或产品模式切换控件。兼容限制见 [目录资源合同](docs/PROJECT_RESOURCES.md)；原生选择器的人工验收仍待执行。

校稿入口在开发终端输出映射状态；点击支持的文字可看到 Main 核验的 nodeId、generation、revision 与字节范围。页面没有桥，也不写文件。交互入口不创建映射。

```sh
npm run check
python tools/check_docs.py
git diff --check
```

命令、依赖版本、输出边界与环境排错见 [开发说明](docs/DEVELOPMENT.md)，许可证见 [依赖清单](docs/DEPENDENCIES.md)。本项目不使用 GitHub CI，仓库 Actions 已关闭；构建、测试、启动冒烟和文档检查在本地执行，平台可用性由对应 Windows/Mac 实机验收。`npm ci` 是锁定依赖安装命令，继续保留。

## AI 辅助开发与致谢

本项目在需求梳理、架构设计、代码实现、测试和文档编写过程中，使用了 **ChatGPT / Codex** 与 **Kimi / Kimi Code** 辅助开发。感谢以下公司及其研究、产品与工程团队提供的模型和工具：

- **[OpenAI](https://openai.com/)**：感谢 **ChatGPT、Codex 和 GPT 系列模型（含本阶段实际使用的 GPT-6）**，为项目规划、核心实现、代码审查与文档完善提供帮助；本阶段 Codex（GPT-6）参与 Main 历史、持久化、提交后的恢复协调、检查点清理、集成测试与合同更新。
- **[月之暗面（Moonshot AI）](https://www.moonshot.ai/)**：感谢 **Kimi、Kimi Code 和 [Kimi K3 模型](https://www.kimi.ai/blog/kimi-k3)**，支持了[前端视觉候选的设计、实现与修正](docs/implementation/HAE-007.md)。

AI 用于开发辅助，应用本身保持本地离线，不依赖云端模型或 AI API。开发分工、实际调用记录与人工复核要求见 [AI 开发流程](docs/AI_WORKFLOW.md)。

## License

本项目采用 [MIT License](LICENSE)。项目原创代码和文档允许按许可证条款使用、修改和分发；引入的第三方依赖仍须保留其各自许可证和声明。用户打开的 HTML 及资源不会因为被本工具编辑而改变其版权或许可证。
