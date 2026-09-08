# HAE-002 自制安全样例

本目录中的 HTML、CSS、JavaScript 与 SVG 均为本项目自制，采用仓库 MIT 许可证，不含用户资料或第三方页面。

- `index.html`：中文/Emoji/实体、CSS import、图片/字体、内联/外部/模块脚本、SVG 事件、Canvas、Shadow DOM 与文件输入。
- `assets/`：自制样式、模块与矩形 SVG。TTF 由 `tests/security/test-font.ts` 在忽略的测试目录中生成，只含一个矩形 A 字形，没有外部字体依赖。
- 测试入口复制本目录到 `test-results/`，生成原 CSP、隐藏目录/恢复目录哨兵及授权资源；逐文件记录源码 SHA-256，结束后比较全部字节。
- 校稿模式的脚本不执行；交互模式可生成页面内容。当前所有节点均为只读，没有源码可写性结论。

路径/文件身份竞态由 Node 文件测试注入；网络连接、脚本、权限与 IPC 使用真实 Electron。完整执行和未测范围见仓库 `docs/implementation/HAE-002.md`。
