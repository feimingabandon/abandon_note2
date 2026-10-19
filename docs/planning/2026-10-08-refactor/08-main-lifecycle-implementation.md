# B3d 主进程生命周期实施记录

2026-10-09。B3d 的入口、所有权移交和指定验证已完成；B4/B7 后续移交的服务装配仍沿下述窄端口接入，不回迁退出状态。

## 1. 范围和恢复来源

实际文件：`src/main/application/bootstrap.js`、`shutdown-coordinator.js`、`src/main/index.js`、`src/main/services/remote/remote-coordinator.js`；对应 `application-lifecycle.test.js`、`remote-shutdown.test.js`、`application-lifecycle-electron.mjs`，以及 `view-visibility-shortcut-ui.test.js` 的实际 getter/退出端口 fixture。

Remote 修复前恢复来源：`tmp/refactor-baselines/B3d-remote-2026-10-09T09-29-26`。B3a/B3b 交接后的入口恢复来源：`tmp/refactor-baselines/B3d-entry-2026-10-09T09-34-34`。恢复时须成组恢复入口、内部 bootstrap/shutdown、remote 和相关消费者，不能覆盖其他代理随后新增的设置/renderer/业务命令工作。外层 `src/main/bootstrap.js` 仍是 electron-vite 实际入口，未替换其早期日志与动态 import 失败处理。未修改 ABI 18、C++、数据库 schema、用户路径。

## 2. 成立的风险修复

Q-002 在产品修改前用 deferred 请求复现。失败报告 `B3d-remote-.../remote-failure.json`：8 项失败；其中 health、retirement、pending-end、notice 四项明确观察到关闭后的存储访问，其余项同时含新接口/有界等待/终态预期，不将八项都表述为独立已证实缺陷。

RemoteCoordinator 现在拥有 terminal `stopped` gate 和自己的 `stopPromise`。每个 health/补报/通知 await 后复核 gate；设备信息收集后取消尚未发出的启动上传。退出开始先 `preventStartup()`，capture 清理后仍顺序执行 remote stop。入口对所有已创建 coordinator 执行 stop，覆盖没有 session 的 health/补报阶段。

`stop({ timeoutMs: 1600 })` 保留先持久化 queue、再等待 session-start、再报告退出的顺序；同一 promise 重入复用。completed/timeout 返回后禁止后续 DB 回调，超时保留排队资料供下一进程补报。入口不再拥有第二个 Promise.race/timer。网络请求本身仍保留 RemoteClient 既有超时；gate 保证迟到不能改存储，不宣称所有网络请求立即中止。没有连接真实远程服务验证其服务器端行为。

Q-003 当前 logger 已在 B0c 加入 `will-quit → closeLogs(1000) → app.exit` 屏障，writer 已有 sequence 目标与 incomplete。定向核验后保留该机制，未因 index 末尾 flush 未 await 而宣称必丢日志。两次真实应用进程均在退出后读到最后 shutdown-complete 记录一次。writer 超时的 incomplete 用既有 log-writer-client 局部断言保护；未证明强杀/断电绝不丢日志。

## 3. 唯一所有者与顺序

ApplicationBootstrap 拥有启动 promise、phase、停止 gate 和已进入阶段表；支持 database、storage-recovery、capture 的真实 async 阶段。关闭前停止新的阶段；已进入的存储操作必须收敛，之后才允许 DB 关闭。资源构造和 IPC 依赖注入留在入口装配中，后续 B7a 按功能移交；入口不再自建 startup promise 状态。

ShutdownCoordinator 拥有 quitting、草稿审批/在途检查、trigger、开始时间、活动阶段和完成账本。草稿取消不执行任何资源清理，后续仍可再次退出；重复 before-quit 不重复 dispose。异步阶段维持 capture → remote(1600ms) → diagnostic → startup-settlement，再进入 geometry → scheduler/reminder/shortcut/capture/sticky → DB → native → Dock timer → tray → logs。各同步资源阶段独立记录失败，使一个 dispose 抛错不会阻止其他实际拥有资源的释放；没有改成 Promise.all。

普通 geometry 仅调用 B3b 的唯一 owner；compact/Dock timer 暂沿明确阶段委托，B4 各域接管时替换该阶段，不复制 state。最终日志屏障仍归 logger。所有原退出 bool/trigger/capture/remote/diagnostic 标记已从 index 移除；消费者统一查询 coordinator 的只读方法。

## 4. 验证和证据

- Remote 修复：`remote-shutdown.test.js` + `remote-health-cache.test.js`，13 项通过；覆盖正常缓存/正式retirement/正常queue-success和各迟到/有界/幂等路径。
- 生命周期及消费者：精确执行 application-lifecycle、remote-shutdown、remote-health-cache、view-visibility-shortcut-ui、log-writer-client 五文件，27 项通过。startup就绪前取消、在途阶段取消、部分失败、草稿取消/retry、重入、单服务失败、DB晚关都有独立行为预期。
- 本批七文件 ESLint 通过；新增 Electron 脚本 lint 通过。仅格式化本批文件；入口启动装配嵌套变化所需缩进同步。
- 必要稳定 app build 由协作代理执行退出0：`tmp/refactor-baselines/B6a-2026-10-09-list/timeline-app-build.log`，包含本批入口。此为即时来源匹配，不冒充跨期 reuse-verified 证书。
- 真实 `application-lifecycle-electron.mjs`：mode `electron-main-app-shutdown-two-process`；`tmp/test-evidence/B3d-lifecycle-2026-10-09T09-41-44/result.json` completed=true，32/32 实际断言，evidence/cleanup complete。normal 和 reentrant 两个独立 PID/日志 session；真实应用/capture就绪、退出0、最终记录一次、capture/remote/diagnostic/DB/native/tray完成、DB重新打开 integrity=ok。各子进程原始输出和shutdown记录单独保存。事后核对无 electron/helper 残留。

指定 Node runtime 和去 Volta PATH 从第一条验证命令即使用。受限命令环境本轮进程创建前连续报 helper setup refresh；沙箱外执行有效结果。Vitest/真实 Electron 均按 AGENTS 选择合适环境，环境阻塞不记代码失败。

没有运行 npm test、窗口全矩阵、全量回归、发布验证、打包或发布。未覆盖强杀/断电、用户电脑、服务器端退出幂等、所有真实初始失败点。真实正常/重入退出不能代替所有桌面功能回归。

## 5. 后续接线指导

1. B4 runtime 销除旧 compact/Dock/drag/blur timer/state 时，在同一子批替换对应 geometry/native/Dock 清理阶段；保留实际资源阶段结果与单 owner。
2. B7a 按已创建阶段迁 feature/tray/capture，仍通过 enabled/run/cleanup 窄口进入 coordinator；不要反向 import index 或另建退出 gate。
3. 新 startup await 必须通过 runStage 或显式 checkpoint，并确保 DB 清理前的 settlement 含该已开始操作；不能通过 catch 吞取消后继续创建资源。
4. 结构断言随实际消费者定位迁移，保留动作/权限/终态保护，不恢复旧 mainWindow 或 isQuitting writable mirror。
5. 若调整日志关闭机制，必须重新验证有界等待/incomplete与真实进程最后记录，不仅检查 raw exit0。
