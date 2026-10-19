# B7a 截图期间主窗口恢复指导与实际结果

日期：2026-10-09。关联 D-012、R-009/R-010、T-009/T-010、C-008/C-012。

## 1. 边界与基线

本批仅移交截图业务与主窗口之间的恢复状态，不重写 CaptureHost、CaptureCoordinator、CaptureAssetStore、worker、Qt 协议或原生输入。基线为 `tmp/refactor-baselines/B7a-capture-window-2026-10-09T01-47-27-779Z`，HEAD 为 `4fbc52be1c688dba9cf23fbbd51539606efbf381`；dirty 文件以基线清单为准。

读取范围为原 index 的 screenshot 状态、快捷键、CaptureCoordinator 三回调、Dock 暂停/恢复、主窗口隐藏/显示及业务接收者流程。原生资源、delivery ACK、文件归属仍由原有捕获模块负责。本批未修改 C++、ABI 18 或 preload API。

## 2. 怎样修改与接线

1. 新建 `src/main/capture/capture-window-integration.js`，唯一拥有一次截图的 restoration ticket：原窗口对象、可见状态、焦点状态以及是否由本次截图隐藏。
2. `begin()` 幂等创建 ticket，暂停 Dock，仅按原 hide 偏好隐藏原来可见的主窗口；不保存另一份可写 screenshot 状态。
3. `finish()` 先释放 ticket 与 Dock 暂停，再检查退出及当前窗口身份。仅恢复本次隐藏的窗口和原有焦点；原来隐藏的窗口不因取消而显示。业务已打开但未接受时恢复原隐藏状态，业务接受后保留有意的显示。
4. index 的三个 capture 回调委托 owner；快捷键及 test hook 统一读取 `isActive()`，删除四个旧 screenshot 全局。业务 reveal 的既有检查与动作继续经窄端口接入。
5. 不把 Host/assets/ACK 状态复制给新模块，不将每次结束统一改为 show/focus；替换或正在退出的主窗口不被旧 ticket 复活。

index 由主入口代理独占编辑，主代理完成新 owner、局部测试与真实业务专项；所有消费者已同步接线。

## 3. 实际验证

| 验证 | 实际结果 | 证据 |
|---|---|---|
| `capture-window-integration.test.js`、`capture-coordinator.test.js`、`deferred-window-restore.test.js` | 20 个局部用例通过 | `tmp/b7a-capture-window-unit-results.json` |
| 本批新 owner 与测试 lint | 退出 0 | 本批命令记录 |
| `capture-business-electron.mjs` | 原始退出 0，18/18 实际断言，无 skip，结果 accepted，证据及清理 complete | `tmp/test-runs/2026-10-09T02-02-59-961Z-G4zHjn` |

真实专项启动当前主应用、实际 preload/renderer、BrowserWindow、磁盘 SQLite、附件目录及实际 capture engine 运行前置。覆盖可见来源捕获时隐藏及取消恢复、原隐藏窗口取消不显示、接受来源业务后保留显示，以及笔记/背景业务交付。产物来自 B4a/B6a/B7a 共享稳定 build，冻结执行记录包含 out 哈希；临时执行器明确 `certifiedReuse=false`，不伪称具备完整可复用来源证书。

该专项的有效模式为 `electron-real-app-capture-business-synthetic-transport`：图像交付使用合成输出，不能证明 Qt overlay 的真实鼠标/键盘输入、剪贴板或多屏坐标。`ABANDON_CAPTURE_REAL_INPUT=1` 会报告独立 native-input 模式，本次未执行，也未混入 synthetic 模式的通过结论。

## 4. 测试处置与剩余风险

保留 capture coordinator、资源及生命周期保护，仅为本次恢复所有权增加行为测试。原 capture-business 增加实际断言 recorder、独立 profile 与真实退出后清理报告；不以脚本退出 0 单独作为通过证据。

未运行全量回归、Qt 全组、客户机器、安装包、真实输入或长期共存验证。本次专项没有证明 B4a 偶发 blur overlay 层级不收敛的根因，该风险仍记录于窗口指导。

## 5. 回退与检查表

回退须成组恢复 owner、index 回调/快捷键/test hook、专项 mode/adapter 及测试，恢复文件从本批基线取出到临时路径后人工比对；不得 reset/clean 全工作区。仅清理本次拥有的 profile/会话目录和子进程，保留失败与验证证据。

- [x] 一次恢复 ticket 的唯一写入者已移交。
- [x] 正常、取消、业务接受/拒绝、替换窗口、退出与幂等分支有对应保护。
- [x] 真实业务专项有断言数量、模式、原始退出、证据与清理结果。
- [x] 协议、preload、ABI 与来源键位保持原行为。
- [ ] 原生真实输入、多屏及客户环境验证留给对应任务。
