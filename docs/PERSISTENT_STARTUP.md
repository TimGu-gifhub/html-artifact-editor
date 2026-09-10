# 持久化窗口启动

日期：2026-09-10；HAE-005 第六阶段。Main 可用一个入口装配固定私有目录、Windows 保存、草稿检查点、备份恢复及统一 Workspace。HAE-009 已在正常 Windows 产品入口调用此工厂；原先的 test:startup 仍为独立 Main 实验，产品证据另见 [HAE-009](implementation/HAE-009.md)。

## 调用与目录

[createPersistentWorkspaceSession](../src/main/workspace/persistent-session.ts) 只由 Main 调用。先注册协议、启用 sandbox，等待 Electron ready；以既有 securePreferences、可信 UI preload 和独立应用 session 创建尚未导航的 BrowserWindow，安装此服务后才加载 EDITOR_URL。outputRoot 必须来自可信安装位置，原生助手固定为其 native/ReplaceHelper.exe；不接受 renderer 提供的路径、服务实现或存储位置。

Main 提供既有 chooseOpen、chooseCopy、review、reviewBackup、projectChoices、bounds 和 reportError 回调。新增 onStorageStep 是 Main 实验故障/等待注入点，不是 IPC 方法。保存、检查点和备份服务由工厂统一安装，调用者不能通过这些端口替换。返回的 storage 是 Main 私有的检查/维护引用，只能在该运行实例的生命周期内使用；原有维护合同仍要求排除活动文档和存储事务。

第七阶段增加 Main requestClose：原生关闭和应用退出共用既有 review，等待已接受的 Save/备份恢复结果，并在批准关闭后先完成 runtime.dispose 再销毁窗口。等待与清理屏障由工厂固定安装，调用者不能替换，renderer 没有新增方法。完整语义见 [应用退出协调](APPLICATION_QUIT.md)。

固定位置为 Electron userData 的直接子目录 **workspace-records**。工厂先获取 Electron profile 的进程锁，再核验目录链和身份；仅在不存在时创建已核验父目录下的已知直接子目录。文件、链接、目录替换、权限失败均报错，不迁移、不清空，也不随机换一个目录逃避旧证据。保存、草稿、结束标记、清理/恢复记录继续共用原 active.lock、身份注册表和配额，原记录格式不变。

HAE-009 正常入口实测发现，MSIX 宿主子进程的 AppData 虚拟化也可能使逻辑 userData 与真实位置不一致；此时拒绝启动，不放宽目录合同。普通 Explorer 桌面会话启动同一构建已通过。开发应使用独立 Windows 终端，详见 [启动排错](DEVELOPMENT.md#启动环境与-appdata-重定向)。

同一进程在异步启动前同步占用运行实例；第二次启动或第二个窗口返回 EDITOR_RUNTIME_ACTIVE。实际 profile 锁排除其他 Electron 进程。已持有的锁绑定此前确认的 userData，修改路径不能把旧锁当作新 profile 的所有权；运行期间 userData/sessionData 与锁状态须保持一致。独立 profile 不构成全机器文件互斥，原有文件版本、冲突和备份校验仍必须执行。

启动本身不选择项目、不恢复草稿、不改 HTML、不解除旧锁。旧记录通过既有 listRecovery/restore 等入口显式处理；无法识别的目录项使 listRecovery 返回 DRAFT_STORAGE_REVIEW_REQUIRED，recovery=null，文件原样保留。恢复摘要没有路径、私有字节或写入权限。

## 关闭与占用

dispose 是 Main teardown，不能代替用户的取消、放弃、另存或原生关闭决定。重复调用共用同一完成结果，窗口 closed 事件也加入这一结果。处理顺序为：

1. 同步撤销 bridge，拒绝新命令，取消尚未返回的选择/确认；移除视图及关闭事件接线。
2. Workspace 等待已开始的打开准备、保存/备份事务和候选清理，再关闭当前文档。不会以一个迟到成功发布新文档。
3. 等待各代 bridge 已接受的命令；UI 重建前的旧连接也须排空，迟到返回不重新取得页面权限。
4. 等待文档历史/Diff Worker、检查点队列和 Preview 完成清理。只有没有未知草稿、未知副本、待审查结果或清理失败，且存储身份注册表没有剩余文档/事务时，才解除进程内实例占用。

准备中的 Save 在关闭后完成私有取消和锁释放，原 HTML 不变。已经替换的 Save 继续核验提交记录；窗口已销毁、无法安装新基线时保留 rebase-required、旧源和候选，不报告普通保存完成。无法确定清理或结果时，dispose 拒绝并保留实例占用，后续启动不能绕过；工厂不自动重试或删除证据。

Electron profile 的 OS 锁由 Main 进程持有，工厂不会在窗口之间释放它。Main 可安装应用退出协调器，将 before-quit、will-quit 和最后窗口关闭连到同一关闭/排空结果；HAE-009 正常入口已安装该服务，产品没有绕过窗口决定的强退菜单。app.exit、强杀、OS 关机和断电不能靠异步窗口回调保证排空，已持久化记录须按既有恢复合同核验。

## 执行范围

`npm run test:startup` 构建独立 startup/startup-child 入口、生产 preload/Worker 与源码编译的 Windows 助手。自制空白可信页面只承担 transport，预览和文件均为测试样例，没有产品样式或输入控件；不改变默认应用构建入口。

11 组真实 Windows Electron 实验覆盖：固定目录被文件占据时保留、异步重复启动/窗口互斥、五处校稿和完整 Diff/保存/干净历史、重开后 Undo/保存/备份恢复、销毁窗口时排空检查点、准备中 Save 的关闭取消、修改 userData 拒绝、独立进程竞争/强杀后恢复、原生替换后销毁窗口的提交核对、未知存储项保留，以及清理不确定时保留占用。另有单元反例验证迟到准备、未知保存结果及 bridge 多命令排空。

报告位于忽略的 test-results/startup.json，记录实际 OS、Electron/Chromium/Node、基线 commit/工作区与独立字节 hash。已验证本机 Windows 11 x64；Windows 10、macOS、真实 IME/对话框/退出菜单和维护者报告仍待验收。固定目录容量耗尽、跨会话清理、产品恢复失败处理仍须后续工作。详见 [阶段记录](implementation/HAE-005.md)、[窗口会话](WORKSPACE_SESSION.md)、[检查点](DRAFT_CHECKPOINTS.md) 与 [保存事务](SAVE_PREPARATION.md)。
