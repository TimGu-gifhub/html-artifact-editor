# 实施任务清单

本文件由 [backlog.json](backlog.json) 生成。范围变更先修改 JSON，再运行 `python tools/render_backlog.py`；GitHub Issues 记录实时执行状态。

当前所有应用任务均为待实现；本表链接不代表任务已经完成。M1–M4 构成文本产品路线，M5 是独立后续提案。

## 任务总览

| ID | 任务 | 里程碑 | 优先级 | 依赖 | GitHub |
| --- | --- | --- | --- | --- | --- |
| HAE-001 | 初始化 Electron 工具链与模块边界 | M1 | P0 | 无 | [#1](https://github.com/TimGu-gifhub/html-artifact-editor/issues/1) |
| HAE-002 | 实现隔离预览、项目资源协议与离线策略 | M1 | P0 | HAE-001 | [#2](https://github.com/TimGu-gifhub/html-artifact-editor/issues/2) |
| HAE-003 | 验证静态 DOM 到源码文本的唯一映射 | M1 | P0 | HAE-001、HAE-002 | [#3](https://github.com/TimGu-gifhub/html-artifact-editor/issues/3) |
| HAE-004 | 实现保留原始字节的纯文本 Patch 引擎 | M1 | P0 | HAE-001 | [#4](https://github.com/TimGu-gifhub/html-artifact-editor/issues/4) |
| HAE-005 | 串起 Windows 最小校稿闭环 | M1 | P0 | HAE-002、HAE-003、HAE-004 | [#5](https://github.com/TimGu-gifhub/html-artifact-editor/issues/5) |
| HAE-006 | 执行 Apple Silicon Mac 早期可行性冒烟 | M1 | P1 | HAE-001、HAE-004 | [#6](https://github.com/TimGu-gifhub/html-artifact-editor/issues/6) |
| HAE-007 | 确定产品视觉方案与完整交互状态 | M2 | P1 | HAE-001 | [#7](https://github.com/TimGu-gifhub/html-artifact-editor/issues/7) |
| HAE-008 | 实现目录入口、相对资源与离线诊断 | M2 | P1 | HAE-002、HAE-005 | [#8](https://github.com/TimGu-gifhub/html-artifact-editor/issues/8) |
| HAE-009 | 实现文本草稿、中文输入与选择交互 | M2 | P0 | HAE-003、HAE-007 | [#9](https://github.com/TimGu-gifhub/html-artifact-editor/issues/9) |
| HAE-010 | 实现安全保存、冲突、备份与崩溃恢复 | M2 | P0 | HAE-004、HAE-008 | [#10](https://github.com/TimGu-gifhub/html-artifact-editor/issues/10) |
| HAE-011 | 实现历史、保存点、源码 Diff 与草稿持久化 | M2 | P0 | HAE-004、HAE-009、HAE-010 | [#11](https://github.com/TimGu-gifhub/html-artifact-editor/issues/11) |
| HAE-012 | 完成 Windows 可用 MVP 验收 | M2 | P0 | HAE-005、HAE-008、HAE-009、HAE-010、HAE-011 | [#12](https://github.com/TimGu-gifhub/html-artifact-editor/issues/12) |
| HAE-013 | 扩充兼容性、安全语料与性能基准 | M3 | P0 | HAE-002、HAE-003、HAE-004、HAE-010 | [#13](https://github.com/TimGu-gifhub/html-artifact-editor/issues/13) |
| HAE-014 | 完成 macOS 交互对齐与跨平台可访问性 | M3 | P1 | HAE-006、HAE-009、HAE-010、HAE-011 | [#14](https://github.com/TimGu-gifhub/html-artifact-editor/issues/14) |
| HAE-015 | 准备 Windows/Mac 打包、许可与签名流程 | M3 | P1 | HAE-001、HAE-012、HAE-014 | [#15](https://github.com/TimGu-gifhub/html-artifact-editor/issues/15) |
| HAE-016 | 执行双平台 Alpha 发布验收 | M3 | P0 | HAE-012、HAE-013、HAE-014、HAE-015 | [#16](https://github.com/TimGu-gifhub/html-artifact-editor/issues/16) |
| HAE-017 | 基于真实校稿任务完成 v1.0 稳定化 | M4 | P1 | HAE-016 | [#17](https://github.com/TimGu-gifhub/html-artifact-editor/issues/17) |
| HAE-018 | 提案：受控 CSS 变量修改 | M5 | P2 | HAE-017 | [#18](https://github.com/TimGu-gifhub/html-artifact-editor/issues/18) |
| HAE-019 | 提案：本地图片替换与资源事务 | M5 | P2 | HAE-017 | [#19](https://github.com/TimGu-gifhub/html-artifact-editor/issues/19) |
| HAE-020 | 提案：外部 AI 的局部修改建议 | M5 | P2 | HAE-017 | [#20](https://github.com/TimGu-gifhub/html-artifact-editor/issues/20) |

## M1 · 可行性验证

验证静态源码映射、字节 Patch 与隔离预览；最小闭环目标 1–3 天，M1 累计 2–4 个工作日。全部为条件估算。

### HAE-001 · 初始化 Electron 工具链与模块边界

建立单包、单锁文件的可复现开发基础，验证可信 UI 与预览可以独立构建。

优先级：P0；领域：platform；依赖：无。

[打开 GitHub Issue #1](https://github.com/TimGu-gifhub/html-artifact-editor/issues/1)

**范围**

- src/contracts、src/main、src/preload、src/core、src/platform 的最小边界
- 版本锁定、开发/构建/测试命令、Windows 与 Mac 本地核心检查

**产物**

- 运行时与依赖版本记录、许可证清单
- 启动与构建说明、可复现的本地检查记录

**验收条件**

- [ ] 选择仍受支持的 Electron 稳定版并记录对应 Chromium、Node 和最低 OS。
- [ ] 本地启动/构建成功；代码尚未具备的功能不出现在能力声明中。
- [ ] 核心不依赖 Electron、DOM 或 OS 判断；UI 与 Preview 分别构建 preload。
- [ ] 记录本地验证的实际 OS/架构；没有可用 Mac 环境时保留明确的待验证项。

验证用例：T-01

参考文档：[ARCHITECTURE.md](../ARCHITECTURE.md)、[docs/DECISIONS.md](DECISIONS.md)。

### HAE-002 · 实现隔离预览、项目资源协议与离线策略

用户 HTML 可在隔离视图中显示，校稿禁用脚本，交互预览只读；没有任意文件或网络能力。

优先级：P0；领域：security；依赖：HAE-001。

[打开 GitHub Issue #2](https://github.com/TimGu-gifhub/html-artifact-editor/issues/2)

**范围**

- src/main/protocol 与 session 生命周期
- Preview 安全配置、权限/导航/IPC 拒绝路径

**产物**

- 两种预览模式的最小实现
- 恶意路径、网络和 IPC 负向样例

**验收条件**

- [ ] nodeIntegration 关闭，contextIsolation、sandbox、webSecurity 开启，页面无高权限桥。
- [ ] 根目录内允许的 CSS/图片/字体可读，越界路径与私有恢复目录不可读。
- [ ] HTTP(S)、WebSocket、localhost/LAN、弹窗、下载和外部协议均被拒绝。
- [ ] 所有 IPC 校验 senderFrame、会话与 schema；旧会话和子 frame 不能触发保存。

验证用例：S-01、S-02、S-03、S-04、S-05、T-08

参考文档：[ARCHITECTURE.md](../ARCHITECTURE.md)、[PRD.md](../PRD.md)。

### HAE-003 · 验证静态 DOM 到源码文本的唯一映射

证明被点击 Text 节点可以关联唯一、连续的源码范围；失败样例明确只读。

优先级：P0；领域：core；依赖：HAE-001、HAE-002。

[打开 GitHub Issue #3](https://github.com/TimGu-gifhub/html-artifact-editor/issues/3)

**范围**

- src/core/parser 与 src/preview 节点索引
- 映射策略 ADR、支持范围反例

**产物**

- 规范化树与节点身份的映射实验
- 成功/拒绝样例和源码映射决策记录

**验收条件**

- [ ] 十处重复文字仅定位选定的一处，不依靠全局 replace 或单一 selector。
- [ ] 嵌套标签、隐式 tbody、相邻 Text、解析纠错与 noscript 按相同语义校验或拒绝。
- [ ] 不同 generation、对象身份或外部 DOM 变更使旧选择失效。
- [ ] 两轮实验失败时缩减支持范围并更新 PRD，禁止以整页序列化降级。

验证用例：T-03、T-04、T-08、T-13

参考文档：[docs/PATCH_SPEC.md](PATCH_SPEC.md)、[docs/RISKS.md](RISKS.md)、[docs/DECISIONS.md](DECISIONS.md)。

### HAE-004 · 实现保留原始字节的纯文本 Patch 引擎

从冻结基线生成候选输出，只修改已验证 Text 字节范围。

优先级：P0；领域：core；依赖：HAE-001。

[打开 GitHub Issue #4](https://github.com/TimGu-gifhub/html-artifact-editor/issues/4)

**范围**

- src/core/parser 的 UTF-8/UTF-16 映射
- src/core/patch 的编码、范围和结果验证

**产物**

- 纯核心补丁 API
- 独立 Buffer 不变量测试

**验收条件**

- [ ] 10,000 行文件只改选定范围；其他字节、脚本、属性和资源保持不变。
- [ ] BOM、Emoji、中文、组合字符、CRLF/混合行尾与实体处理有准确字节断言。
- [ ] 多节点变长修改、同节点净补丁、空文本与无变化不造成位置漂移。
- [ ] 非法编码、重叠范围、旧值不符和危险上下文被拒绝；粘贴标签只生成文字。

验证用例：T-02、T-05、T-06、T-07、T-11

参考文档：[docs/PATCH_SPEC.md](PATCH_SPEC.md)。

### HAE-005 · 串起 Windows 最小校稿闭环

用最小技术验证程序完成打开、选字、修改、另存和浏览器复核，先证明链路。

优先级：P0；领域：platform；依赖：HAE-002、HAE-003、HAE-004。

[打开 GitHub Issue #5](https://github.com/TimGu-gifhub/html-artifact-editor/issues/5)

**范围**

- 跨模块接线与自制静态报告
- 技术验收记录，不扩展产品 UI 功能

**产物**

- 可运行的最小实验构建
- 前后字节 Diff 与独立浏览器复核证据

**验收条件**

- [ ] 标题和单元格文字可经唯一映射修改并另存到新文件。
- [ ] 取消操作不改原文件；事务保障未完成时不开放覆盖保存。
- [ ] 重新打开另存文件显示正确文字，未修改源码保持一致。
- [ ] 清楚标记实验版本和不支持项，不宣称可用 MVP。

验证用例：T-01、T-02、T-03、T-20

参考文档：[ROADMAP.md](../ROADMAP.md)、[docs/TEST_PLAN.md](TEST_PLAN.md)。

### HAE-006 · 执行 Apple Silicon Mac 早期可行性冒烟

在核心阶段暴露 Mac 构建、架构与文件行为问题，不等待 Windows 全部完成。

优先级：P1；领域：platform；依赖：HAE-001、HAE-004。

[打开 GitHub Issue #6](https://github.com/TimGu-gifhub/html-artifact-editor/issues/6)

**范围**

- Mac 核心测试和最小启动
- 平台差异记录

**产物**

- Apple Silicon Mac 环境与版本记录
- 核心字节测试及预览启动证据

**验收条件**

- [ ] 使用与 Windows 相同的核心和锁文件，记录 macOS、arm64 与 Chromium 版本。
- [ ] 执行核心字节测试与中文/空格路径读取。
- [ ] 具备预览模块后补做打开与另存冒烟；不能以核心测试代替 UI 验收。
- [ ] 无设备时记录 pending 和后续依赖，不伪造通过，Windows 可继续推进。

验证用例：T-01、T-05、T-20

参考文档：[docs/TEST_PLAN.md](TEST_PLAN.md)、[docs/RELEASE.md](RELEASE.md)。

## M2 · 可用 MVP

Windows 完整校稿、目录资源、中文输入、Diff、备份、冲突、撤销与恢复。累计目标 5–10 个工作日，须有真实用户验收。

### HAE-007 · 确定产品视觉方案与完整交互状态

围绕报告校稿主任务选择一个视觉方案，明确状态与可信输入位置后再实现产品 UI。

优先级：P1；领域：design；依赖：HAE-001。

[打开 GitHub Issue #7](https://github.com/TimGu-gifhub/html-artifact-editor/issues/7)

**范围**

- 工具栏、预览、校稿侧栏、变更面板
- 正常、只读、草稿、冲突、窄窗口状态

**产物**

- 三种同任务视觉方案及选定方案
- 组件/焦点/文案/尺寸状态清单

**验收条件**

- [ ] 维护者选择一个视觉方向，记录为后续实现目标。
- [ ] 所有状态符合交互合同，操作不要求用户理解源码映射实现。
- [ ] 静态校稿与 JS 只读预览的差异可见，模式切换保护草稿。
- [ ] 可信侧栏为 MVP 输入方案；原位浮层未通过原生层级与 IME 验证前不作为前提。

验证用例：T-09、T-16、T-18、T-19

参考文档：[docs/PRODUCT_DESIGN.md](PRODUCT_DESIGN.md)。

### HAE-008 · 实现目录入口、相对资源与离线诊断

用户能够打开实际 HTML 项目并理解资源缺失，所有资源仍受授权根限制。

优先级：P1；领域：platform；依赖：HAE-002、HAE-005。

[打开 GitHub Issue #8](https://github.com/TimGu-gifhub/html-artifact-editor/issues/8)

**范围**

- 项目对话框、入口切换、资源诊断
- 相对路径、base、中文路径处理

**产物**

- 单文件/目录入口流程
- 被阻断与缺失资源诊断面板

**验收条件**

- [ ] 选择根目录与 HTML 入口，CSS/JS/图片/字体按允许范围加载。
- [ ] 不自动扩大目录授权，越界链接、隐藏配置和私有状态不可服务。
- [ ] 远程 CDN 或在线 API 被阻断并列出 URL/类型，不自动联网。
- [ ] 切换入口或取消对话框保持当前输入/草稿规则；一次仅编辑一个 HTML。

验证用例：T-01、T-13、T-14、S-01、S-04、S-05

参考文档：[PRD.md](../PRD.md)、[ARCHITECTURE.md](../ARCHITECTURE.md)。

### HAE-009 · 实现文本草稿、中文输入与选择交互

用户在页面选中准确文字，在可信控件修改，应用/取消与中文输入不会串目标或丢内容。

优先级：P0；领域：ui；依赖：HAE-003、HAE-007。

[打开 GitHub Issue #9](https://github.com/TimGu-gifhub/html-artifact-editor/issues/9)

**范围**

- src/ui 校稿输入、选择高亮与焦点
- 输入法、纯文本粘贴、异步选择世代

**产物**

- 主路径与错误状态 UI
- Windows IME 与交互记录

**验收条件**

- [ ] 应用形成一个操作组，取消零 HTML 写入，失焦保留尚未应用输入。
- [ ] IME 期间 Enter/Escape/保存/关闭不触发应用级动作，输入框撤销优先。
- [ ] 跨节点选择只读；纯文本粘贴、换行、空文本和上限有明确规则。
- [ ] 过期选择不串项目，滚动/缩放/DPI 高亮正确，不改变原 DOM 结构。

验证用例：T-07、T-09、T-10、T-13、T-18

参考文档：[docs/PRODUCT_DESIGN.md](PRODUCT_DESIGN.md)、[docs/PATCH_SPEC.md](PATCH_SPEC.md)。

### HAE-010 · 实现安全保存、冲突、备份与崩溃恢复

源文件覆盖可验证、可恢复，失败和结果不确定时绝不静默丢弃草稿或重复覆盖。

优先级：P0；领域：storage；依赖：HAE-004、HAE-008。

[打开 GitHub Issue #10](https://github.com/TimGu-gifhub/html-artifact-editor/issues/10)

**范围**

- src/main/storage 平台事务封装
- 备份/journal、身份/hash 检查、另存与恢复

**产物**

- 保存事务与恢复向导
- 各故障节点的实际文件结果记录

**验收条件**

- [ ] 备份回读校验成功后才允许替换，写入结果 hash 校验后才显示已保存。
- [ ] 外部变更、第二实例、权限、空间不足与文件占用被处理，原文件可判定或进入恢复状态。
- [ ] 任意事务节点强制终止后能通过 old/new hash 判断，不盲目重试。
- [ ] 不先删原文件；记录跨平台 rename/ACL/锁的测试和不合作外部写入者的竞态限制。

验证用例：T-14、T-15、T-16、T-17、S-06、S-07、S-08、S-09

参考文档：[docs/PATCH_SPEC.md](PATCH_SPEC.md)、[docs/RISKS.md](RISKS.md)。

### HAE-011 · 实现历史、保存点、源码 Diff 与草稿持久化

让用户看清将要保存的实际差异，撤销/重做与恢复始终对应正确源基线。

优先级：P0；领域：core；依赖：HAE-004、HAE-009、HAE-010。

[打开 GitHub Issue #11](https://github.com/TimGu-gifhub/html-artifact-editor/issues/11)

**范围**

- src/core/history 与变更面板
- 应用私有恢复记录和保存后重基线

**产物**

- 逻辑历史及净补丁计算
- Diff、恢复记录与清理规则

**验收条件**

- [ ] A→B→C 只保存 A→C，回到基线清除净变更；新编辑清除重做分支。
- [ ] 保存后撤销形成新的未保存变更，必须重新验证目标，不能复用旧 offset。
- [ ] Diff 使用同一冻结候选字节，展示实体重新编码等实际变化。
- [ ] 重启恢复先校验 schema/文件身份/hash；私有记录不暴露给页面，不重复应用已提交事务。

验证用例：T-11、T-12、T-13、T-17、S-05、S-08

参考文档：[docs/PATCH_SPEC.md](PATCH_SPEC.md)、[docs/PRODUCT_DESIGN.md](PRODUCT_DESIGN.md)。

### HAE-012 · 完成 Windows 可用 MVP 验收

让维护者独立完成真实脱敏报告的完整校稿任务，并区分自动检查与产品验收。

优先级：P0；领域：qa；依赖：HAE-005、HAE-008、HAE-009、HAE-010、HAE-011。

[打开 GitHub Issue #12](https://github.com/TimGu-gifhub/html-artifact-editor/issues/12)

**范围**

- 主流程 E2E、Windows 人工任务
- MVP 能力与限制文档

**产物**

- 标题/日期/三处表格校稿证据
- 取消、冲突、撤销、重启恢复和浏览器复核记录

**验收条件**

- [ ] 维护者独立打开、修改、查看 Diff、保存、重开并确认结果。
- [ ] 取消零写入、冲突拒绝覆盖、失败保留草稿、撤销与恢复通过。
- [ ] 自动门槛通过且无已知 P0/P1，原始源码未改范围和资源哈希一致。
- [ ] 标明实际 Windows 版本、架构、输入法与未测项；不把此结果扩展成 Mac 验收。

验证用例：T-01、T-09、T-10、T-12、T-15、T-16、T-17、T-20

参考文档：[docs/TEST_PLAN.md](TEST_PLAN.md)、[ROADMAP.md](../ROADMAP.md)。

## M3 · 双平台 Alpha

固定语料回归、Windows x64 与 macOS arm64 实机、打包与签名准备。累计目标 2–4 周；未测平台保持未验收。

### HAE-013 · 扩充兼容性、安全语料与性能基准

在固定、可复现、可公开的语料中验证支持与拒绝边界，并测量资源预算。

优先级：P0；领域：qa；依赖：HAE-002、HAE-003、HAE-004、HAE-010。

[打开 GitHub Issue #13](https://github.com/TimGu-gifhub/html-artifact-editor/issues/13)

**范围**

- 自制/合法许可 fixtures
- 负向安全、异常数据和性能基准

**产物**

- 带来源、hash、可编辑预期的语料目录
- 基准硬件/版本、p50/p95 与限制报告

**验收条件**

- [ ] 覆盖 Tailwind/Bootstrap 离线输出、图表只读、SVG、框架、iframe、Shadow DOM、缺失 CDN 和编码。
- [ ] 错误来源、路径、IPC、网络、资源耗尽样例不能越权或误改。
- [ ] 至少 20 次基准，记录 OS/硬件/缓存/规模，明确性能目标与实际差距。
- [ ] 用固定语料分子分母报告覆盖，不宣称任意 HTML 或未经测量的 90%。

验证用例：T-02、T-04、T-05、T-06、T-08、S-01、S-02、S-03、S-04、S-05、S-10

参考文档：[docs/TEST_PLAN.md](TEST_PLAN.md)、[docs/REFERENCES.md](REFERENCES.md)。

### HAE-014 · 完成 macOS 交互对齐与跨平台可访问性

在 Apple Silicon Mac 验证同一核心流程，修复平台输入、窗口、权限和展示问题。

优先级：P1；领域：platform；依赖：HAE-006、HAE-009、HAE-010、HAE-011。

[打开 GitHub Issue #14](https://github.com/TimGu-gifhub/html-artifact-editor/issues/14)

**范围**

- src/platform、窗口与菜单
- 双平台 DPI/焦点/屏幕阅读器验证

**产物**

- Mac 完整链路实机记录
- 双平台交互差异和修复

**验收条件**

- [ ] Mac 执行打开、修改、取消、保存/冲突、撤销、重启恢复与浏览器复核。
- [ ] Cmd 快捷键、中文 IME、Retina、原生菜单、文件权限和焦点正常。
- [ ] 验证 Windows 多 DPI 和最小窗口，Narrator/VoiceOver 核心路径可用。
- [ ] 核心不新增 OS 分支；设备不可用保持待验收，不以其他环境的本地检查替代。

验证用例：T-10、T-12、T-15、T-16、T-17、T-18、T-19、T-20

参考文档：[docs/PRODUCT_DESIGN.md](PRODUCT_DESIGN.md)、[docs/TEST_PLAN.md](TEST_PLAN.md)。

### HAE-015 · 准备 Windows/Mac 打包、许可与签名流程

产出可审查的平台安装包、校验和及分发说明，明确签名和设备条件。

优先级：P1；领域：release；依赖：HAE-001、HAE-012、HAE-014。

[打开 GitHub Issue #15](https://github.com/TimGu-gifhub/html-artifact-editor/issues/15)

**范围**

- Forge/本地打包配置与发布清单
- 第三方许可、签名/公证配置与文档

**产物**

- Windows x64 安装包与 Mac arm64 DMG 的构建记录
- 校验和、依赖许可/组件清单和签名状态

**验收条件**

- [ ] 产物来自同一 commit 和锁文件，干净环境可核验构建过程。
- [ ] 验证安装、启动、保存、卸载和本地数据保留行为。
- [ ] 凭据通过适当秘密存储提供，不提交证书或私钥；缺少条件明确阻塞对应分发。
- [ ] 未签名实验产物明确标记，不冒充正式版，也不建议全局关闭系统安全。

验证用例：T-01、T-10、T-15、T-17、T-20

参考文档：[docs/RELEASE.md](RELEASE.md)、[SECURITY.md](../SECURITY.md)。

### HAE-016 · 执行双平台 Alpha 发布验收

只对已有完整证据的平台发布 Alpha，保持能力与限制声明准确。

优先级：P0；领域：qa；依赖：HAE-012、HAE-013、HAE-014、HAE-015。

[打开 GitHub Issue #16](https://github.com/TimGu-gifhub/html-artifact-editor/issues/16)

**范围**

- 固定 commit 最终回归
- 发布说明、已知问题与人工复核

**产物**

- Alpha 验收记录和可审查产物集合
- 支持矩阵、限制、恢复说明

**验收条件**

- [ ] 所有 P0/P1 清零，固定样例和安全负向用例通过。
- [ ] Windows 10/11 x64 与 Mac arm64 分别记录真实验收，未测目标不称支持。
- [ ] 校验和、签名状态、许可证和发布说明与实际产物一致。
- [ ] 维护者确认后按本次发布授权执行；设备/签名缺口不被勾为完成。

验证用例：T-20、S-01、S-02、S-06、S-07、S-08、S-09

参考文档：[docs/RELEASE.md](RELEASE.md)、[docs/TEST_PLAN.md](TEST_PLAN.md)。

## M4 · v1.0 稳定化

固定版本真实校稿试用、故障恢复、性能和正式分发证据。累计目标 4–8 周，依赖真实反馈与发布条件。

### HAE-017 · 基于真实校稿任务完成 v1.0 稳定化

用真实新增样例、连续使用与恢复反馈巩固文本产品，不扩大编辑种类。

优先级：P1；领域：qa；依赖：HAE-016。

[打开 GitHub Issue #17](https://github.com/TimGu-gifhub/html-artifact-editor/issues/17)

**范围**

- 真实任务反馈、缺陷和性能
- 用户文档、恢复/清理和正式分发门槛

**产物**

- 至少两轮固定版本真实任务记录
- v1.0 支持矩阵、使用与恢复文档

**验收条件**

- [ ] 新脱敏样例中定位正确或明确只读，不通过扩大危险范围提高成功率。
- [ ] 无已知 P0/P1，回归语料和性能预算有明确结果。
- [ ] 备份/草稿清理、日志隐私和失败恢复与文档一致。
- [ ] 每个正式目标都有实机和签名证据，维护者完成发布复核。

验证用例：T-17、T-19、T-20、S-08、S-09、S-10

参考文档：[PRD.md](../PRD.md)、[docs/RELEASE.md](RELEASE.md)。

## M5 · 后续探索

CSS 变量、图片替换与外部 AI Patch 的独立提案；不属于 MVP 承诺，不设置截止日期。

### HAE-018 · 提案：受控 CSS 变量修改

探索小范围主题调整，先说明变量来源、影响范围与回退，不实现通用 CSS 编辑器。

优先级：P2；领域：design；依赖：HAE-017。

[打开 GitHub Issue #18](https://github.com/TimGu-gifhub/html-artifact-editor/issues/18)

**范围**

- 独立 PRD/ADR 与最小实验

**产物**

- 变量来源与作用域规范
- 是否继续实施的证据

**验收条件**

- [ ] 区分内联/外部样式、变量继承、覆盖与媒体查询，明确不支持项。
- [ ] 提案显示受影响对象与源码 Diff，不写多个文件来猜测效果。
- [ ] 保留文本产品不变量，失败可回退。
- [ ] 未获得明确范围决定前只交付提案，不加入 MVP。

验证用例：提案阶段；实施前新增针对性验证方案。

参考文档：[ROADMAP.md](../ROADMAP.md)、[docs/DECISIONS.md](DECISIONS.md)。

### HAE-019 · 提案：本地图片替换与资源事务

研究图片路径、复制与恢复合同，避免把单文件保存擅自扩为多文件写入。

优先级：P2；领域：storage；依赖：HAE-017。

[打开 GitHub Issue #19](https://github.com/TimGu-gifhub/html-artifact-editor/issues/19)

**范围**

- 资源引用与多文件事务 ADR

**产物**

- 图片替换的交互与安全提案
- 失败恢复和资源许可方案

**验收条件**

- [ ] 区分 img/srcset/CSS 背景和 data URL，明确支持子集。
- [ ] 说明跨目录、覆盖同名文件、相对路径与备份行为。
- [ ] 多文件事务、资源许可和清理有验证设计。
- [ ] 没有明确范围决定时不实现到主产品。

验证用例：提案阶段；实施前新增针对性验证方案。

参考文档：[ROADMAP.md](../ROADMAP.md)、[docs/PATCH_SPEC.md](PATCH_SPEC.md)。

### HAE-020 · 提案：外部 AI 的局部修改建议

探索外部 AI 只提出修改意图，由相同验证链路和用户决定是否应用。

优先级：P2；领域：design；依赖：HAE-017。

[打开 GitHub Issue #20](https://github.com/TimGu-gifhub/html-artifact-editor/issues/20)

**范围**

- 提案 schema、隐私与人工确认设计

**产物**

- AI 提案与执行边界 ADR
- 无云依赖的核心兼容方案

**验收条件**

- [ ] AI 不能取得任意文件、Shell 或绕过校验的能力。
- [ ] 每条提案绑定来源和旧值，展示 Diff，用户确认后才进入草稿。
- [ ] 是否发送内容和使用何种服务必须由用户明确选择。
- [ ] 核心编辑器保持离线可用，不将 AI 纳入 MVP 依赖。

验证用例：提案阶段；实施前新增针对性验证方案。

参考文档：[ROADMAP.md](../ROADMAP.md)、[docs/DECISIONS.md](DECISIONS.md)。
