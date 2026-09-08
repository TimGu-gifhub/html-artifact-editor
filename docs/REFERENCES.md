# 设计资料来源

核对日期：2026-09-08。以下为官方技术依据；支持范围、估算和交互设计是本项目的设计判断，尚未经实现验证。

| 资料 | 对计划的用途 |
| --- | --- |
| [Electron 平台支持](https://github.com/electron/electron#platform-support) | 核对 Windows 10+、macOS Ventura+ 及架构；本项目首期只验收 x64 Windows 与 arm64 Mac |
| [Electron 发布与支持政策](https://www.electronjs.org/docs/latest/tutorial/electron-timelines) | 实施时选择仍受支持的稳定版本并定期复核 |
| [WebContentsView API](https://www.electronjs.org/docs/latest/api/web-contents-view) | 嵌入隔离预览视图的框架入口 |
| [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security) | 隔离、沙箱、来源校验、导航和能力最小化的基础 |
| [Electron protocol API](https://www.electronjs.org/docs/latest/api/protocol) | 自定义协议的注册时机、session 范围与资源处理 |
| [parse5 ParserOptions](https://parse5.js.org/interfaces/parse5.ParserOptions.html) | 开启源码位置信息；隐式元素可能没有位置 |
| [parse5 Location](https://parse5.js.org/interfaces/parse5.Token.Location.html) | 字符下标及右开区间，不能直接替代 UTF-8 字节偏移 |
| [Electron Code Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing) | Windows 签名和 macOS 签名/公证的准备工作 |
| [MIT：Open Source Initiative](https://opensource.org/license/mit) | 许可证类型与标准正文说明 |
| [GitHub MIT 许可证模板](https://api.github.com/licenses/mit) | 根目录 LICENSE 的标准正文来源 |

产品需求来自维护者提供的前期讨论，公开文档只整理需求与方案，不复制私人聊天或其他项目资料。前期曾比较过现成编辑器，但本计划不依赖未经重新核对的竞品成熟度、星标数或许可证结论。

静态映射算法、字节保存不变量、首版模式划分、时间窗口和性能预算均为本项目推导，不是上述库提供的保证。实现时必须留下验证结果和版本信息。
