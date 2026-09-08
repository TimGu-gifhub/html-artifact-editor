# 源码定位与 Patch 规范

版本：schema 1 设计基线。HAE-003/004 已实现静态索引与纯字节 Patch 候选；HAE-005 第一段已验证 Main 草稿和独占新文件另存，产品接线与 HAE-010 覆盖事务仍待实现。

## 1. 保存不变量

1. 保存依据是磁盘读取的原始 Buffer 与经确认的文本操作，不是 `outerHTML`、`innerHTML` 或 parse5 serializer 的整页结果。
2. 只替换核验过的、不重叠的原始文本字节范围。其余字节顺序和内容完全不变；附属资源文件哈希不变。
3. 每个补丁绑定 documentId、generation、baseHash、目标 nodeId、旧范围与旧片段哈希。选择器和旧文字搜索都不足以定位。
4. 定位、编码、磁盘冲突、备份或权限校验失败时停止写入，保留草稿；不自动转成整页导出。
5. 任何编辑器标记、选择层和运行时状态都不写入 HTML。后续版本同样遵守此约束。

“精确”指未修改范围的字节完全保持。首版可以替换一个完整 Text 节点的源码片段，片段内部的实体拼写可能重新编码；不声称编辑一个字时整个目标片段内其他词法写法也一定保持。UI Diff 必须呈现这些实际差异。

## 2. 源快照

Main 创建并持有以下数据，Preview 无权伪造或扩展范围：

```ts
type SourceSnapshot = {
  schemaVersion: 1;
  projectId: string;
  documentId: string;
  generation: number;
  fileIdentity: string;       // Main 中保存真实文件身份与授权句柄
  baseHash: string;           // 完整原始字节 SHA-256
  encoding: 'utf-8';
  hasBom: boolean;
  bytes: Uint8Array;
  text: string;               // 严格解码；明确是否已剥离 BOM
  nodes: Map<string, TextSource>;
};

type TextSource = {
  nodeId: string;
  startCodeUnit: number;      // 解析输入中的 UTF-16 code-unit 下标
  endCodeUnit: number;        // 右开区间
  startByte: number;          // 原始 Buffer 下标，包含 BOM 偏移修正
  endByte: number;
  rawSliceHash: string;
  decodedText: string;        // 实体解码与 HTML 换行规则后的 DOM 值
  contextFingerprint: string;
  parentTag: string;
  namespace: 'html';
  consumesLeadingLf: boolean; // pre/listing 标签后起始 Text 范围的首 LF 消费规则
  editable: boolean;
  readOnlyReason?: string;
};
```

无效 UTF-8 必须拒绝覆盖，不能让解码器的替换字符悄悄进入输出。首版不支持 UTF-16/GBK 自动转换。若解析输入剥离 3 字节 UTF-8 BOM，所有映射必须补偿 BOM；原文件是否含 BOM 不变。

HAE-003 的实际纯核心类型为 `SourceIndex` / `TextSource`（[实现](../src/core/parser/source-index.ts)）。`identity` 组织 projectId/documentId/generation，`nodes` 为只读数组并携带 treeIndex；Main 自行按 nodeId 查找。字节属性每次返回副本，源树、身份与文本描述冻结。文件身份由 Main 授权层单独持有，不进入纯核心。上面的 SourceSnapshot 是后续保存会话的组合设计，不能把尚未组合的 fileIdentity 字段或 Map 作为当前接口。

## 3. DOM 到源码的可行性验证

### 首版保证路径：脚本关闭的静态校稿

候选策略是比较 parse5 规范化树与 Chromium 静态 DOM 的结构路径、命名空间、父子节点序列和解码后 Text 值，再将 Text 对象身份映射至 Main 中的 nodeId。使用隔离世界 WeakMap 保存映射，不改原始标记和属性。

parse5 与 Chromium 必须使用一致的脚本解析语义（例如 noscript），同一快照、同一编码和同一 HTML 输入。并非所有 HTML 都有一一映射：隐式元素、foster parenting、相邻文本合并、解析错误和不连续源码片段都要显式验证。不连续或多对一范围直接只读，禁止用猜测补全。

可编辑检查至少包括：

- Text 有单一、连续、有效源码范围，位于支持的 HTML 上下文。
- 规范化路径及父子结构唯一匹配；重复文本可以通过不同唯一范围区分。
- 原始片段按相同上下文解码后与预期 DOM Text 值相同。
- 没有跨 frame、Shadow DOM、SVG、属性、raw-text 或表单当前值边界。
- 当前对象身份、generation、revision 与选择时一致。非编辑器引发的节点变化使该映射失效。

HAE-003 必须构造失败样例，验证“拒绝不确定定位”是否工作。若完整静态树映射在预算内未通过，先限于无解析错误的普通块级元素单 Text 子节点，并在支持矩阵中记录缩减。不能以全局 replace 或 nth-child 猜测替代。

实施结果见 [HAE-003](implementation/HAE-003.md) 与 [决策记录 ADR-011](DECISIONS.md)。Main 将预期整树发送到隔离 preload；返回的 selection 仅含绑定身份、递增 revision 与 nodeId（或 null），不接受路径、偏移或目标文字。校稿 parse5 与 Chromium 均按 scripting-enabled 语义解析，但 CSP 禁止页面脚本执行。DOMContentLoaded 后至绑定前也监视变化；绑定后 MutationObserver、takeRecords 和 Text 对象登记共同拒绝外部更改，包括改回相同文字。

`validateSelection` 仅证明请求执行时的选择/对象状态，不是可跨异步步骤复用的写租约。HAE-005 第一段的 `applyText` 在 Main worker 验证完整候选后，要求隔离 registry 同步核对身份、当前选择版本、对象和旧值，再更新 Text.data。观察器始终连接，预先排空外部记录，赋值后只消费本次唯一的目标 characterData 记录。没有页面 bridge 或 registry 写盘方法；未知结果保留前后候选并禁止重试，见 [阶段记录](implementation/HAE-005.md)。

### JS 交互预览

首版 JS 模式只读。MutationObserver 和文字相等不能单独证明原文来源；观察器看不到完整脚本所有权，重新渲染会更换对象，脚本可以生成与源码相同的文本。动态页可写需单独的源关联、生命周期、重载后持久性证明；本计划不假设该问题已解决。

## 4. Unicode、实体和换行

parse5 下标针对解析字符串；不得直接切 UTF-8 Buffer。实现一份 UTF-16 code-unit 边界到原始 UTF-8 字节边界的线性索引，包含 BOM 修正。代理对中间位置不是可替换边界；索引与 Buffer 切片必须用中文、组合字符、Emoji、BOM、CRLF 样例对照验证。

普通 HTML Text 的新文字以纯文本编码：`&` → `&amp;`，`<` → `&lt;`，`>` → `&gt;`；不能把用户输入插入为 HTML。输入中的 NUL 和非法代理项拒绝。首版拒绝 script、style、textarea、title、xmp 等特殊解析上下文；HTML 属性与 SVG/XML 有独立规则，不能复用本编码器。

实体名称、数字实体和 CRLF 与 DOM Text 值可能不同，旧片段校验必须同时保留原始字节与解码值。替换整个 Text 片段时，片段内部实体允许采用上述确定编码；NBSP 保留其语义字符。不能对整个 HTML 解码、规范化或格式化。

新输入先统一为逻辑 LF；输出目标片段新增换行采用该片段原有单一换行风格，否则采用文档统计得到的风格，平局取 LF。混合换行片段在 Diff 中明确展示重编码结果；目标范围外混合行尾严格保持。样例必须覆盖 `pre` 和普通段落的不同视觉空白行为。

HAE-004 已实现上述规则。HTML 的 pre/listing 会消费紧接开始标签的第一个 LF；parse5 在多 LF token 上可能把被消费的首 LF 也算入 Text 范围。仅当父标签、首子节点和源 startTag.endOffset 共同证明这一上下文时，索引按消费一个 LF 校验原始片段；若新文字以 LF 起始，编码器补一个会被消费的换行。已经位于目标范围之外的前缀保持原始字节。`consumesLeadingLf` 和 `leadingLfCompensation` 是权威索引/补丁字段，不能由页面指定；六组真实 Chromium 反例见 [HAE-004](implementation/HAE-004.md)。

## 5. 编辑命令与 Patch

Preview 只能报告选择。来自可信 UI 的编辑命令也只传 nodeId、新文字和版本，不允许传任意文件路径或字节范围：

```ts
type ApplyTextDraft = {
  projectId: string;
  documentId: string;
  generation: number;
  nodeId: string;
  selectionRevision: number;
  newText: string;
};

type TextPatch = {
  schemaVersion: 1;
  identity: { projectId: string; documentId: string; generation: number };
  baseHash: string;
  nodeId: string;
  startByte: number;
  endByte: number;
  oldSliceHash: string;
  contextFingerprint: string;
  expectedText: string;
  newText: string;
  lineEnding: '\n' | '\r\n' | '\r';
  mixedLineEndings: boolean;
  leadingLfCompensation: boolean;
  replacementBytes: Uint8Array;
};
```

Main 从权威索引生成 TextPatch，并重新校验上下文、范围、旧片段和输入限制。持久化恢复记录只存经过校验的逻辑字段与哈希；读取任何 JSON 同样按不可信输入校验 schema、大小、路径映射和版本。

同一 nodeId 连续编辑合并为针对保存基线的一份净补丁；历史仍保留每次“应用”的操作组。A→B→C 最终保存 A→C；A→B→A 取消净补丁。不同节点基于同一份不可变基线，直到保存后统一重建索引，不能增量猜测所有下游 offset。

HAE-004 的实际纯核心入口为 [createPatchEngine / buildPatchCandidate](../src/core/patch/engine.ts)。上面的 ApplyTextDraft 是规划形式；HAE-005 第一段实际 Main 命令为精确三个字段的 `DraftApply { selection: MappingSelection, draftRevision, newText }`，其 selection 包含完整映射身份、revision 和 nodeId。核心 `TextChange` 精确包含 `identity`、`baseHash`、`nodeId`、`expectedText` 和 `newText`。其中 expectedText 是当前内存候选文字，用来拒绝过期输入；TextPatch.expectedText 则始终是原始基线的解码文字。Main 验证选择版本/来源，从自身状态获取旧值，不能直接向页面开放核心 API。

engine 初始重新解析并核对源索引；apply 在全部候选校验成功后才更新内存状态。无变化返回原候选，同节点改回基线文字移除净 Patch 并保留原实体拼写。失败保留上一候选。`PatchCandidate` 包含冻结身份、baseHash/resultHash、只读 patches 与返回副本的 bytes；没有文件 I/O、DOM 操作、历史或保存点。限制为每节点 64 KiB UTF-8 新文字、1,000 个净 Patch 和 5 MiB 输出，替换字节总预算也受限。后续交互接入应在可取消任务中运行这些同步核心计算。

## 6. 结果构造与验证

1. 验证全部补丁绑定相同快照、范围合法且不重叠，旧片段哈希一致。
2. 按原始 startByte 升序，依次拼接原始未改 Buffer 切片和 replacementBytes；也可从尾部替换，但不得使用已变长的 offset 继续索引旧内容。
3. 重新解析候选输出，验证目标解码 Text 为新值；结构、属性、脚本和样式 token 没有意外变化。
4. 独立比较每段未改原始 Buffer 切片与输出对应片段；首版保护边界由直接字节断言证明。
5. UI Diff 由即将写入的候选字节生成。Diff 与写盘使用同一冻结结果；禁止在用户确认后再重新编码成另一份结果。

HAE-004 已验证 1–4，并冻结可供第 5 步使用的候选结果；尚无产品 Diff 或写盘入口。整树核对仅忽略目标 Text 的新值、清空后消失的 Text 及随之变化的索引编号；其他父子结构、属性、注释、脚本/样式文字和未选 Text 必须一致。清空后再次输入仍基于同一旧范围，不能拿新候选的变长 offset 回写原基线。

目标节点改为空字符串后，内存编辑会话保留该 Text 对象；保存重解析时空节点可能不再存在。清空选择并保留逻辑历史，恢复该节点必须重新生成经验证的相反操作，不能把旧 nodeId 强行复用。

## 7. 保存事务

HAE-005 的 M1 简化另存已实现为独占创建同目录新 HTML：冻结当前候选，选择目标后用 O_EXCL 打开并保留句柄，写入/flush/回读 hash，核对目录链与叶子身份。取消零写入；已有文件一律拒绝；创建后的任何异常标记 unknown 并保留现场。另存不清空原入口草稿或移动保存点，不复制资源或自动切换入口。下面的覆盖备份、journal、恢复与保存点事务仍是 HAE-010 设计，不能用新文件实验代替。

单文件事务设计，不承诺跨多个文件原子性。普通本地磁盘是保证验证范围，网络盘和云同步目录先作为条件支持。

1. 冻结操作集，取得应用内该文件的排他写锁；同一应用的第二实例不能并发保存。
2. 检查授权、实际路径/文件身份、权限和磁盘当前 hash。任何不符进入 conflict。
3. 在应用私有存储中写入原始字节备份、旧/新 hash、目标身份和事务 journal；flush，回读备份 hash。备份失败时原文件零写入。
4. 在目标同一目录创建独占临时文件，写入候选完整字节，flush，校验 hash，并按平台保留必要文件权限/元数据。临时文件名不得覆盖已有文件。
5. 再次校验目标身份与旧 hash；通过平台适配层执行替换。禁止先删除原文件再移动临时文件。
6. 回读目标并校验新 hash，更新 journal 为 committed、刷新基线和映射。只有此时可显示“已保存”。
7. 删除本事务确认可清理的临时项，保留备份。清理失败不将已经成功的保存改称失败，记录待清理状态。

Node rename 在 Windows 被占用、杀毒软件介入、权限/ACL、大小写路径与不同文件系统上行为不同，必须通过故障注入验证平台封装。若所选封装不能满足要求，相关环境保持只读/另存，不能把“写临时文件再 rename”直接宣称为所有平台的断电安全。

外部程序不遵守本应用锁时，最后检查到替换之间仍有竞态；MVP 不自动合并并发编辑。保存前后检测、原始备份和事件日志降低风险，但不保证对不合作写入者的强 CAS。HAE-010 应优先验证可用文件锁/身份检查并记录残余窗口；UI 明示冲突，不以 watcher 代替重读。

## 8. 失败与重启恢复

| 失败时点 | 源文件可能状态 | 恢复动作 |
| --- | --- | --- |
| 备份前/备份失败 | 原文件未改 | 保留草稿，可重试或另存 |
| 临时写入中/替换前 | 原文件未改，可能有临时文件 | 校验 journal 与身份后重试；仅清理本事务临时项 |
| 替换后、提交记录前 | 可能是旧内容或完整新内容 | 回读与 oldHash/newHash 比较，判定后再操作 |
| 新 hash 不符/外部程序随后写入 | 结果不确定 | 进入 SAVE_OUTCOME_UNKNOWN，保留所有证据，不重复覆盖 |
| 已提交、恢复草稿清理失败 | 新文件已保存 | 用 committed journal 去重，不把旧草稿再次应用 |

journal、备份、恢复草稿位于应用私有数据目录，以 projectId/documentId/transactionId 组织，Preview 不能读取。默认候选保留上限为每文档最近 20 份且总容量 200 MiB；不自动删除最后一份有效备份或未完成事务，达到限制时通知清理。上限在实测后确认。

源文件与恢复记录 schema 不兼容、文件身份改变、基线 hash 变化时，不自动回放草稿。用户可查看、复制修改文字或另存到新文件。备份恢复前也要备份当前源文件。

## 9. 撤销、重做与保存点

撤销单位是一次“应用文字”，不是输入法每个事件。当前未应用输入使用输入控件自身撤销。保存成功建立新保存点；应用级撤销已保存操作会产生新的未保存变更，下次显式保存才写盘。

历史保存逻辑文本操作与足够的前后来源信息；每次保存重新构建基线后的反向补丁必须重新验证节点和结构。不能把旧字节位置用于新文件。重做在新分支编辑后失效。MVP 持久化恢复草稿和当前会话历史；跨应用重启的无限撤销不属于保证范围。

## 10. 必须通过的核心实验

- 10,000 行 HTML 中间修改一段中文，BOM、混合行尾、脚本、注释、属性和其他文本字节不变。
- 十处相同文字只改用户选定的一处；含 Emoji 的前置文字不造成 offset 偏移。
- `&amp;`、`&#xA0;`、`<strong>`、隐式 tbody、解析纠错等样例能正确定位或明确拒绝。
- 输入 `<script>alert(1)</script>` 结果为文字，重新打开不执行新代码。
- 两处文本长度同时变化、同一节点多次编辑、清空、撤销、保存后撤销均正确。
- 保存中模拟权限、磁盘、占用、外部修改和进程终止；原文件可判定或进入明确恢复状态。

详细用例编号见 [测试计划](TEST_PLAN.md)。
