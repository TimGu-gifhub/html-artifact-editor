# 纯核心边界

HAE-001 仅建立目录与检查门槛，没有解析、修改或保存算法。

此目录只能依赖自身与 `src/contracts`；当前不允许任何外部包。
`tsconfig.core.json` 不加载 DOM、Node 或 Electron 类型，`check:boundaries`
检查 import、export、动态 import、require 与跨层路径。引入 parse5 时在对应任务
明确增加纯解析依赖，不引入平台分支。文件 I/O 留在 Main/storage，OS 差异留在 platform。
