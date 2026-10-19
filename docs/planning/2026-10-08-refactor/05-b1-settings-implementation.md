# B1 设置存储、快照与单一状态实施记录

日期：2026-10-09。范围：汇总指导 §8 的 B1a/B1b/B1c；本域已实施并通过下述局部验证。其他批次不由本记录判定完成。

## 1. 实际修改与保留的产品契约

| 文件                                        | 实际职责和修改                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/db/db-settings-repository.js`     | 接管四个 app_settings 操作：getAllSettings、setSettingsBatch、clearSettings、clearAllSettings；每次取得 db-connection 的同一已安装连接                        |
| `src/main/db/db.js`                         | 暂兼容 re-export 四操作；本批仍保留数据库初始化/关闭及附件/业务清空，后续 B3c/B5b 独立迁移                                                                    |
| `src/main/settings/application-settings.js` | 改用窄 repository；应用 scope、周视图首次继承、历史回读、应用设置名单及序列化保持                                                                             |
| `src/main/settings/settings-runtime.js`     | 纯 assembleResolvedSettings；独占 resolved values、revision 和 shortcuts 会话启用状态；提供 refresh/resetForView/setShortcutsEnabled/advanceRevision/snapshot |
| `src/main/index.js`                         | 全部设置读消费者改只读 runtime.values；初始化、切换/恢复、快捷键开关、重试、OS autoStart 的全部写点委托 runtime；保留完整 persistSettingValues 协调           |

数据库主键仍为 `(window_name, key)`，不会因 type 不同另插一行。app_settings schema、路径 `userData/app.db`、WAL/pragmas、持久化默认值均未变。shortcuts.enabled 仍是本次进程会话开关；旧持久行继续被忽略，应用重启默认启用。

运行值递归冻结，外部消费者不能通过引用写回；发给 renderer 的 values 是深拷贝。runtime provider 只读取 OS/快捷键/Dock/blur 有效状态，不启动服务。RemoteCoordinator 仅读 remote，CaptureCoordinator.syncTheme 仅读 css；weather 已取得 clone；ReminderWindow 取得完整 snapshot。

## 2. 所有权和副作用次序

原 index 的三份可写状态已全部移除：resolvedSettings、settingsRevision、globalShortcutsEnabled。全量消费者检索确认没有 runtime.values 属性写点。新 runtime 的内部值、版本及会话门禁由其方法单独写入。

刷新保持原顺序：读 application → 读当前 view → 组装并发布运行值 → 同步 blurConfig → 同步 Capture 主题 → 增加 revision。读失败时值和 revision 都保留；原同步副作用失败时，发布后的值保留且 revision 尚未增加，已有失败语义不改。

persistSettingValues 原函数与本批恢复基线逐字一致：验证/序列化 → 原 view SQL → 原 application SQL → 设置证据回读 → refresh → window → 按需 blur → 按需 Dock → snapshot → 广播。各 scope 内事务保持；未将跨 scope/reset 改为新事务，也未拆碎背景协调。完整背景写协调仍按 B4f 迁移。

## 3. 测试处置及实际验证

原 application-settings 单元只迁移 mock import 到窄 repository；window-z-order 的有效优先级断言只更新唯一 settings getter 路径。没有删除旧测试。新增测试以独立值/结果为预期，不按新实现逐行镜像。

| 验证                                                                                                                                | 结果与证明边界                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 改前五文件 application-settings、settings-schema、blur-settings-main-wiring、view-switch-geometry-order、window-z-order-main-wiring | 58 用例通过，退出 0                                                                           |
| 改后以上五文件及 settings-runtime.test.js                                                                                           | 六文件 65 用例通过，退出 0；七新用例覆盖组装、次序、revision、只读/快照、session、读/同步失败 |
| 本批十个实际代码/测试文件 ESLint --no-cache                                                                                         | 退出 0；仅格式化实际本批文件                                                                  |
| settings-repository-db.mjs                                                                                                          | 正常 Electron ready、真实 app.db；39/39 实际断言通过、退出 0、证据/清理 complete              |
| 唯一必要 electron-vite app 构建                                                                                                     | 指定 Node/去 Volta PATH，退出 0；未重编 native/Qt                                             |
| settings-runtime-electron.mjs                                                                                                       | 实际主应用、真实 preload IPC、list→month→week；30/30 实际断言通过、退出 0、证据/清理 complete |
| 状态/协调源码核对和 git diff --check                                                                                                | 旧可写名称全部消失，runtime.values 无写点；完整 persist 函数保持；本批 diff 空白检查通过      |

真实 SQLite 覆盖同连接/facade 函数身份、主键冲突更新、scope 隔离、NULL/序列化、created_at 保留、批次第二行故障回滚、磁盘关闭重开、周继承标记及清 scope 不影响业务行。关闭重开在同一 Electron 进程完成，不能扩展为真实应用两轮重启验证。

真实页面覆盖共享设置 mutation、广播同 revision 快照、只读 refresh 版本不增、复用同 BrowserWindow、session pause 跨视图及 reset 保持。主入口执行实际 native compatibility gate；窗口成功初始化且 CaptureHost ready。ABI 18 和已有 native/Qt 产物只作为实际运行前置，本批未完成它们的完整源码/工具链来源认证。

### 3.1 首失败、重试与证据

- 恢复基线：`tmp/refactor-baselines/B1-2026-10-09T08-51-29`，包含九个原文件、副本及 SHA-256；新文件列表记录在 baseline.json。
- SQLite 首次 PowerShell GUI 启动提前返回，没有原始进程退出码；其后来出现的完整报告不作为最终有效执行。有效新 attempt：`tmp/test-evidence/B1-settings-2026-10-09T08-57-56`，Node spawnSync 确认实际退出 0。
- GUI 首 attempt：`tmp/test-evidence/B1-gui-2026-10-09T09-03-42`。测试 fixture 从 executeJavaScript 返回取消订阅函数，不能跨进程克隆；completed=false，即使 raw exit0 也没有判通过。修正 fixture 为 void 后新 attempt：`tmp/test-evidence/B1-gui-2026-10-09T09-05-17`。
- 最终 GUI verifier 同时检查 suite/runToken、completed、总数/通过/失败/跳过、证据与清理；不是仅看退出码。首失败 profile 和报告保留，没有改产品来适配错误 fixture。
- ownership-verification.json、implementation-hashes.json 放在恢复目录；实际进程检索没有残留本次 Electron/AbandonCapture 进程。

全部 Node/Vitest/ESLint/electron-vite 使用 `C:/Users/Admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`。Vitest 从第一次在已知合适的沙箱外执行，避免前轮已知 realpath EPERM；真实 Electron 也从第一次使用沙箱外环境。

## 4. 后续如何改及停止条件

1. 父调度更新新测试登记：settings-runtime.test.js 为 unit；settings-repository-db.mjs 为 database/electron、无需 app 构建；settings-runtime-electron.mjs 为 gui/electron，必要 app 构建和 native gate/Capture 运行前置保留。两专项模式分别是 `electron-ready-disk-sqlite-reopen-settings` 与 `electron-main-app-settings-cross-view`。
2. B3c 将数据库 init/close 移到唯一 DatabaseRuntime，连接生命周期失败/引用清除和磁盘迁移仍需新真实契约；本批 facade 与 repository 共用同一个 db-connection。
3. B4f 整体迁移 persist 背景事务协调，须一起保留证据、scope 顺序、窗口/blur/Dock、广播与失败恢复；不能只搬 SQL 或把三个副作用分给独立写入者。
4. B6c 继续 renderer settings queue 的版本、UI回填/失败、reset 的 scope 与 timer/dirty 行为核查。Q-001 第二 scope 失败尚未形成业务失败门槛，本批不附带改为跨 scope 全成全败。

未运行全量测试、完整 GUI/原生窗口矩阵、安装/打包/发布、macOS、多显示器/长时运行、真实主进程两轮重启。OS autoStart 的写入、副作用失败后最终 UI、reset 第二 scope 故障、wallpaper/blur 实际桌面背景协调留在其后续相关批次。本批结果不能替代这些证据。

## 5. 回退与交接

回退应先停止本仓库本次测试/开发进程，再从恢复目录 `files/` 恢复 db.js、application-settings、index、两个迁移测试；删除本批新增 repository/runtime/三个测试（如已被后续批依赖，改按后续恢复链整体退回）。db-connection 本批未修改。schema/用户数据不需要迁移回退。

回退 index 与 settings-runtime 必须成组，不留下已委托入口搭配缺失模块；application-settings mock 与窄 repository import 同步恢复。已有 B0d runner/CI 不随本批回退；父更新的 manifest 条目应随实际恢复范围同步。回退 app 源码后重新生成匹配 out，不能继续消费本批构建产物。不要覆盖其他代理/用户随后修改的文件。

index 的 B1 状态移交已完成并交回父代理管理。后续独立 DB 批次仍由数据库子代理处理 db.js；不会再修改 index。
