# B4 窗口运行域实施指导与证据

2026-10-09。按 B4a → b → c → d → e → f 移交状态、计时器、监听、事务和完整消费者。每节仅在实际验证完成后更新状态；没有运行全量窗口矩阵、ABI升级、打包或发布。

## B4a：BlurRuntime / ZOrderRuntime

状态：所有权及消费者已迁移，局部与指定真实场景完成；一次真实Overlay确认不收敛保留为未定根因的瞬态风险。

恢复来源：`tmp/refactor-baselines/B4a-2026-10-09/index.js`，含 B3a/b/c/d、Q001 的已接线结果。回退须成组恢复入口、两个runtime、source-read定位与native-leaf测试，不覆盖随后各B4子域。

`windows/blur-runtime.js` 是 blurConfig/caps/initialized/failed/errors/diagnostic/reentry和窗口监听唯一owner；对外只读getter、setRequestedConfig/disableConfig/clearFailure/restoreFailure等受控命令。Presentation的重建也交它处理，不再外写initialized。初始化、首次配置失败销毁回滚、健康失效回退/持久化顺序保持。监听一次安装，窗口closed和runtime destroy释放自己的回调。

`windows/z-order-runtime.js` 是mode/pendingMode/change节流/retry timer/attempt/exhaustion唯一owner。完整 apply→真实confirm→write→refresh/broadcast、native失败和持久化失败两种rollback移动一起。pending模式在刷新中保留。后续Dock/Presentation通过读mode和apply/reassert/cancel端口使用，不另缓存mode。ABI18、DLL/C++保持；没有改变原生同步规则。

迁移方法采用AST确定函数/单一变量/实际IPC边界，移动原函数体，逐项转换自由状态为明确窄端口；不依赖字符串随意剪切嵌套代码。外部所有blur配置/失败state写点改受控命令；普通settings值和revision仍唯一归SettingsRuntime。旧可写字段均从index移除。

实际验证：

- `native-leaf-runtime.test.js` 五行为场景：readonly config/监听释放，失败状态受控回填，pending刷新、confirm-before-persist，apply失败rollback，retry timer层级改变取消。
- 加 `blur-settings-main-wiring.test.js`、`window-z-order-main-wiring.test.js`、`view-visibility-shortcut-ui.test.js`，四文件13项通过；后者同步capture恢复owner的getter fixture。测试初版误假定产品默认层级normal，改显式seed normal，保留产品默认top。
- 新runtime/入口/上述改动五文件ESLint通过。没有把bridge mock当实际native证据。
- 必要app build退出0：`tmp/b4a-b6a-b7a-app-build.log`，含本批+已接capture owner+当时Tag renderer；协作后冻结out。
- 真实 `native-leaf-runtime-electron.mjs`，mode `electron-main-app-native-leaf-state`，glass off/on × normal/top/bottom，实际 enabled/requestedMatches/anchored/Overlay healthy/zOrderSynchronized/renderer快照一致。最终 fresh profile `tmp/test-evidence/B4a-native-leaf-2026-10-09T09-59-16`，raw退出0、completed=true、52/52、evidence/cleanup complete。
- 第一attempt `09-56-41` 是专项预期错误：成功禁用返回success=true，不能把effectiveEnabled=false当操作失败；修测试后再执行。
- 第二attempt `09-57-51` 是真实确认失败：33已完成断言通过，但glass=true normal→top时topmost/bottom均匹配、Overlay健康但层级未同步，产品拒绝提交并回退；completed=false/raw退出1。保留完整日志/现场，没有弱化confirm、延时掩盖或改native。fresh通过不证明该瞬态根因或所有环境稳定，后续受影响native专项仍须记录失败与恢复。

后续修改指导：B4b只能通过Dock自己的暂停/restore/read接口调用叶能力；B4d不能直接写blur initialized或controller的operation；B4f统一背景请求版本/失败补偿，但调用blur受控命令，不接管第二份native状态。所有回退保留现有apply-confirm-persist门槛。

## B4b–f：完整实施指导与当前状态

当前状态：**B4b–f 生产迁移、局部验证及末节指定真实桌面专项已完成并accepted**。以下实施清单保留只读核对时的边界和修改方法；“拟新增”和旧入口行号属于当时计划，不能用来否定末节的实际迁移记录。共享run仍须逐job核验，不因B4相关专项通过便宣称全部项目或发布验证完成。

授权历史：2026-10-09，最初 business admission 生产补丁因用户前期准备限制被自动审批拒绝，随后暂停生产、测试和配置代码写入，仅补指导。用户之后明确授权真正修改并连续完成全部批次，才恢复实施。已实施的 B4a 与 capture 证据独立保留，不能替代后续子批验收。

拒绝前 B4b 尚无生产改动。只生成了 `tmp/b4b-inspect.cjs`、`tmp/b4b-names.json`、`tmp/b4b-functions.txt` 用于 AST 枚举顶层函数和自由依赖，没有生成 DockRuntime、迁移入口、修改测试或构建。未运行本节列出的计划测试。

本文行号以只读核对时的 `src/main/index.js` 为定位参考，执行前应按函数名重新定位，不能依靠会随前置批次漂移的固定行号剪切。一次迁移必须核对 declaration、assignment、read、IPC、窗口监听、启动、关闭、测试 hook 和 source-read 消费者，不能只搜索函数调用。

### B4b：DockRuntime

#### 实际边界与目标文件

拟新增 `src/main/window-motion/dock-runtime.js`，入口只组装一次并委托；复用现有 `window-motion/index.js` 后端、`DockTransitionState`、`dock-config.js`、`dock-display-rebuild.js`、`dock-health.js`、`DockNativeStatusObserver`。不另造动画、native 监视器或第二个 WindowMotionBackend。

当前实现横跨入口 285–326、832–857、1366–1395、1483–1830、2253–3306、4386–4457，以及 createWindow、view navigation、scheduler 与 shutdown 的消费者。按五个审阅步骤实施：状态和会话 → 可见态和几何 → hide/show → native event/cleanup → display/power。中间阶段只标具体职责完成，最终所有写点移交之后才标 B4b 完成。

唯一移交状态：

| 状态组 | 必须一起移交的资源 |
| --- | --- |
| 可见态 | `dockSide`、`isDockHidden`、`cachedWorkArea` |
| 动画 | `slideAnimTimer`、`isSliding`、`dockSlideStartedAt`、`pendingSlideCallback`、`dockTransitionState` |
| 延迟隐藏 | `hideTimer`、`pendingDockHideRequestedAt` |
| 会话 | `dockMotionSession`、`dockSessionSequence`，包括冻结 stableBounds/workArea/motionPlan、代次、mode、handlePositionPermille |
| 原生边缘 | `windowMotionBackend`、`edgeMonitorMessageId`、`nativeEdgeCleanupPending`、`nativeEdgeCleanupTimer` |
| 暂停 | `dockInteractionSuspendCount`，保留当前计数语义，token 化是另一个变更 |
| 几何补偿 | `suppressDockGeometryPersistenceUntil`、`dockGeometryReconcileTimer` |
| 显示器/电源 | `dockDisplayChangeTimer`、`pendingDockDisplayChanges`、`dockDisplayListeners`、`dockPowerListeners` |
| 诊断 | `dockNativeStatusObserver` 和 `diagnosticState.subscribe` 的返回取消订阅函数 |

所有 Dock 专用常量随状态移动，包括 20px snap、2 DIP trigger、50ms poll、200ms slide/leave delay、4 DIP overshoot、1000ms geometry suppression、5000ms slide health 上限、native cleanup 重试上限、deep observer 250ms。迁移不改变常量或降级门槛。

完整函数清单：

- 配置/能力：`getDockRuntimeConfig`、`getDockRuntimeCapability`、`reconcileDockRuntimeConfig`。
- cleanup：`scheduleNativeEdgeCleanup`、`beginNativeEdgeCleanup`、`finishNativeEdgeCleanup`、`attemptNativeEdgeCleanup`。
- 暂停/延迟：`beginDockInteractionSuspension`、`endDockInteractionSuspension`、`cancelPendingDockHide`，以及当前 `window-hover` 完整 body。
- native event：`attachNativeEdgeMonitorMessageHook`、`detachNativeEdgeMonitorMessageHook`、`handleNativeEdgeMonitorMessage`、`applyDockPersistentHandlePosition`。
- 几何：`suppressDockGeometryPersistence`、`isDockGeometryPersistenceSuppressed`、`isDockTransitionActive`、`boundsEqual`、`scheduleDockGeometryReconciliation`、`createStableDockBounds`、`updateWorkArea`、`setDockPosition`。
- 诊断/恢复：`getDockDiagnosticSnapshot`、`getDockNativeObserverContext`、`runDockHealthCheck`、`resetDockState`、`restoreDockWindowToVisiblePosition`、`runPendingSlideCallback`、`emergencyRestoreDock`。
- display/power：`rebuildFullscreenDockSessionAfterDisplayChange`、`handleDockDisplayTopologyChange`、`attachDockDisplayListeners`、`detachDockDisplayListeners`、`handleDockPowerBoundary`、`attachDockPowerListeners`、`detachDockPowerListeners`。
- visible/hide/show：`detectDockSide`、`syncVisibleDockSide`、`snapToEdge`、`slideTo`、`doHide`、`doShow`。

`boundsEqual` 当前仅供 Dock 内部 reconciliation/topology 使用，直接成为本模块私有函数即可。`setDockPosition` 实际同时被普通标题栏拖动和 compact drag 使用，应保留受控 `movePosition(position, motionPlan)` 能力；它必须继续只移动、不提交宽高，并验证 motion expectedSize 与 Electron content size，不能替换成 `setBounds`。

#### 注入端口和受控输出

建议 constructor 接收：窗口 getter；screen/powerMonitor；只读 view/profile/settings；isLocked/isQuitting/isCompact；普通 geometry 的 readStable/setStable/readSuppression/markDirty/markSaved；persistValues；只读 blur state 与 B4a operation/sync 端口；z-order mode/apply/reassert；logger；诊断政策订阅。不得反向 import index 或拿可写 SettingsRuntime/BlurRuntime 内部对象。

公开接口按真实消费者收敛，名字可统一，语义不得省略：

| 接口 | 合约 |
| --- | --- |
| `attachWindow(window)` / `releaseWindow(window)` | 创建同一 backend、安装/解除该 HWND 消息 hook；identity 检查阻止旧窗口释放新窗口资源 |
| `start()` / `prepareShutdown()` / `dispose()` | app 级 display/power/diagnostic 监听一次安装；停止 pending 工作并释放自己的资源；不移除其他服务监听 |
| `config()` / `capability()` / `snapshot()` | 纯只读 DTO；保留现有诊断字段/坐标单位；不能回传可写 session/backend 清理引用 |
| `readStableSessionBounds()` / `setWorkArea(area)` | 外部读冻结 stableBounds 副本；外部缓存工作区写点进入受控命令 |
| `isHidden()` / `isSliding()` / `side()` / `isTransitionActive()` | 消费者按需查询，入口不缓存一份 mirror |
| `isCleanupPending()` / `readCleanupStatus()` | 返回 boolean 或 generation/attempts 等诊断 DTO，不把 pending backend 暴露为可写对象 |
| `suspend(source)` / `resume(source)` | 保留计数与恢复顺序，截图/标题栏/compact 各自释放自己取得的暂停 |
| `cancelPendingHide(source)` / `handleHover(isHovering)` | timer/request time 的所有写点进入 owner；IPC 入口只校验 sender 后委托 |
| `syncVisible(options)` / `hide()` / `show(source)` | 不改变当前触发条件或 show queue 规则 |
| `restoreVisible()` / `reset(options)` / `recover(source,cause,options)` | 包括动画取消、临时层级恢复、native cleanup 登记和普通 geometry 回填 |
| `movePosition(position,plan)` / `captureMotionBounds()` / `isMoving()` | 供 drag/compact/native blur 用的窄 motion 能力；不要求消费者持有整个 backend |
| `healthCheck()` / `reconcileConfig(previous,source)` | scheduler/写协调只调用，不接管状态 |

若 B4a BlurRuntime 迁移过渡时确需 backend getter，应明确只读消费且不能创建、替换或自行 disarm；最终将它收敛为 capture/sync 所需小端口。不能让新模块构造时同步读取尚未初始化的 SettingsRuntime、ShutdownCoordinator 或 PresentationRuntime；相互依赖用 lazy closures，首次实际读取在初始化完成之后。

#### 外部写点和完整消费者

1. `createWindow` 的 backend 赋值与 attach hook（当前 2058–2059）改 `attachWindow(createdWindow)`；host closed cleanup 的 reset/unhook/backend=null（2208–2210）合并为 identity-aware `releaseWindow(createdWindow)`。不能只移 backend 创建而留下入口归属。
2. createWindow 的 resize/move/moved 对 `isMoving` 的判断改窄查询；窗口 show/minimize/restore 通过 Dock 命令获取 snapshot/同步/健康检查。窗口级监听由 host 安装边界保持一次，runtime 释放自己增加的 hook。
3. view present（3489）与 rollback（3606）的 `cachedWorkArea = ...` 改 `setWorkArea`；普通几何 provider（843）改 `readStableSessionBounds`。topology 内部 cache 更新随完整函数移动。
4. `toggleWindow`、shortcut、hideToTray、startup renderer-ready、diagnostic export、runtime settings provider、scheduler dockHealthTask、测试 hook 改只读方法/受控命令。测试 hook 的 `screenshotCaptureActive` 兼容字段仍来自 CaptureWindowIntegration，不能迁回 Dock。
5. `CaptureWindowIntegration` 的 suspend/resume/hide/reassert lazy closures 使用新 Dock 命令；B4c/d/e 使用同一实例，不能在各模块再 new 一个 Dock。
6. `window-hover` 保留 `event.sender === currentWindow.webContents` 的入口鉴权，完整 delay/cursor 二次验证/state revalidation 进入 `handleHover`。执行前再次检测 activeEdges/nearest side/lock/suspend/cleanup，不能只捕获 200ms 前的 side。
7. `diagnosticState.subscribe` 当前未保存 unsubscribe，迁移后 owner 保存并在 dispose 释放。display/power 是 app 级监听，窗口 hook 是 HWND 级监听，窗口 close 不应意外拆掉整个 app 的电源能力。
8. shutdown geometry 阶段与 dock-timers 阶段不再直接写 timer。只读已确认 `blur_bridge.destroy()`（599–607）在 `finally Blur_Destroy` 之前调用 `WindowMotion_DisarmEdgeMonitor(0)`；现有 native-blur 阶段已经有全局 disarm 兜底，不能称当前完全未释放边缘线程。需要补的证据是 disarm 返回/worker终态，以及 JS owner 的 observer/订阅/迟到callback。明确 prepare/terminal 两阶段：DB/native 仍有效时禁止新 hide/清理 pending/停止 observer与display/power；若 owner 自己执行必要 disarm，后续全局兜底须保持幂等；DB/native teardown 后的末尾 dispose 不再次触发native初始化/移动。做有界退出复现后才决定是否改变阶段顺序，不能凭迁移把 cleanup timeout 宣称 completed；必要顺序调整单列为已证实生命周期修复，不混作无行为改变抽取。

#### 必须保留的失败恢复与精确验证

保留 arm 成功才 hide；arm timeout 登记 generation cleanup 后保持可见；旧 generation event 不得 show 新会话；handle move 只更新当前 session、不写设置，新 hide 重新居中；hide 中的 show 先排队，hide 完成优先消费 queue，再显示 persistent handle；临时置顶最终恢复，bottom 动画不提升层级；disarm 失败故障开放、后续 cleanup 阻止新 hide/导航；minimize 几何不当成真实越界；Fullscreen metrics 仅相关 display、先冻结 handle 位置，再停止旧代次，在屏外重建；普通 display/power 恢复可见后只重建 side，不自动再次 hide；compact 暂态绝不补偿写主视图 geometry。

测试选择分步登记，禁止一步运行全部窗口/native 测试：

- 状态/queue：`dock-transition-state.test.js`；补 owner 行为保护验证重复 start/release、queued show 与旧 callback、暂停余额，不写镜像实现测试。
- 配置/可见态：`dock-config.test.js`、`dock-edge.test.js`；只在这些规则/接线实际移动时纳入。`dock-main-wiring.test.js` 的每项有效语义移到 owner 或对应装配，保留 atomic Dock IPC、renderer allowlist、timer 复核和必要授权断言。
- geometry/health：`dock-health.test.js`，B3b provider变化对应 `window-geometry-persistence.test.js`；fake clock 验 suppress/reconcile 不覆盖 compact 暂态且用户立即移动最终能持久化。
- native observer/display：`dock-native-status-observer.test.js`、`dock-display-rebuild.test.js`；补实际 owner subscription/listener identity释放、旧 event、disarm失败/重试终态、相关 display 过滤。
- **真实 app 验证缺口：** `dock-trigger-electron.mjs` 直接创建测试窗口并 koffi 调 DLL，不消费 `out/main` 的 DockRuntime 装配。保留它对 DLL 的价值，但 B4b 应新增一个精确 app Dock 生命周期场景，或为现有真正 app 专项增加明确可选 scenario：current renderer/preload 配置边缘 → hover delayed hide → native代次/worker/terminal bounds → show during hide/真实唤出 → suspend/config变更取消 →窗口释放。断言持久化 stable geometry、suspend余额、hook/timer/native worker 终态；只运行所选模式/边缘，不带 Qt crash 矩阵。
- display/power 的事件注入可证明回调恢复链，不等同真实拔屏/混合DPI/休眠；真实硬件场景按条件单列，未执行时明确残余风险。

只读发现的旧 source-read 问题：`dock-main-wiring` 仍要求 `mainWindow.on(...)` 和入口 `screenshotCaptureActive = true/false`，而当前 host/capture 已改 getter/owner。B4b 改定位时必须逐条替换成当前 owner 行为和入口真实委托，不能全删断言或将多个文件拼接后假装同一函数内顺序。此次没有运行该文件，因此没有失败数或通过数。

通过后记录恢复来源、精确文件/场景、raw code、completed、实际 assertion、evidence和cleanup。回退 DockRuntime、index 全部写点/消费者、相关 source-read与app专项、manifest 映射同批恢复；后续已有 B4c/f 使用新接口时按依赖倒序，不能直接用 B4a index 覆盖全入口。

### B4c：WindowDragController

当前状态：已迁移，局部行为验证通过；具体结果见末节。指导：新增 `src/main/windows/window-drag-controller.js`，原入口 489–490 与 588–753 的标题栏会话整体移交。普通 geometry state仍归B3b；compact drag属于B4d，不能一起塞进普通drag owner。

唯一状态为 `titlebarDragSession`、`titlebarDockSuspended`；会话内 dragId/time/origin/electronBounds/lastPosition/frozen motionPlan/moved/updateCount/failureLogged 全部移交，含 normalized diagnostics。完整 `beginTitlebarWindowDrag`、`updateTitlebarWindowDrag`、`endTitlebarWindowDrag` 随状态迁移。`resolvedDragPoint` 与 `dipBoundsToPhysical` 是标题栏和 compact 共用纯坐标适配，拟提取 `windows/window-drag-coordinates.js`，只封装现有 screen API 与数值归一化，不创建第三份会话。整个 DIP rectangle 继续使用同一个 display 的 `screen.dipToScreenRect`，不能独立换算四个角。

注入 getWindow、screen、isLocked、presentation readonly mode/active、Dock suspend/resume/captureMotion/movePosition、geometry schedule、z-order mode/readNative/reassert、logger。API 为 begin/update/end/cancel/releaseWindow/isActive/readSnapshot；snapshot只给数据副本，end/cancel/release共享唯一收口，不由每调用方自减暂停计数。

外部消费者必须改齐：

1. `titlebar-window:begin-drag/update-drag/end-drag`；update sender过滤保留；preload payload/return 不变。
2. createWindow 两个 move与moved监听不再读入口 session，改 `drag.isActive()`。
3. B4d compact commit 前结束普通拖动、B4e navigation reset后结束、shutdown geometry阶段收口。
4. host closed release应释放当前窗取得的Dock暂停，不让旧session恢复到新窗口；窗口destroy路径无条件“读native成功”不可假设。
5. `presentation-mode-architecture.test.js` 的 drag生命周期日志/nativeZOrderBefore/After定位改新owner；renderer pointercapture与按钮规则仍读原renderer，不因main迁移删保护。

保持 begin 的 lock/compact/window/重复拒绝顺序；native capture失败不取得暂停；update只移动不提交宽高；一次会话失败日志不逐帧刷；end先清active再resumeDock，再按moved schedule ordinary geometry，bottom reassert后记录前后native状态。完成/取消重复调用不得多释放暂停。若窗口销毁或shutdown收口需要修改现有行为，先补有界失败复现再单列修复，不声称纯抽取已证明全部失败路径。

最小验证：owner单元验证begin拒绝/移动/no-op/一次failure/幂等end/释放身份、暂停余额；正常开始后销毁window覆盖无残余session。平台默认只选择 `titlebar-native-drag-electron.mjs`：它消费真实app/renderer/preload、Chromium trusted input、两种标题栏样式与normal/top/bottom、真实lock按钮。`window-control-drag-electron.mjs` 后半附带12 screenshot crash组合，不能因普通drag抽取自动运行；如需要其lock→unlock场景，先登记明确子场景选择再运行，保留原完整显式回归入口。

实际native断言应包含尺寸不变、位置变化、释放后正常geometry写入与 bottom enabled/requestedMatches/anchored，而不是只看 renderer class。B4a已有Overlay偶发不收敛仍保留，拖动通过不能称其根因修复。

回退 controller/共享坐标适配/index所有读和结束路径/相关tests与manifest一起恢复；不能只复制 begin函数回入口却遗留新owner的暂停状态。

### B4d：PresentationRuntime

当前状态：已迁移，局部行为验证通过；退出迟到 ACK 缺陷单独复现并修复，见末节。指导：新增 `src/main/windows/presentation-runtime.js`，**复用现有 `PresentationModeController`**。controller继续拥有committedMode/desiredMode/desiredContext/operationId/operation/requestPromise；runtime拥有Electron/native/renderer适配与compact会话，不另建controller或desiredMode镜像。

完整状态：`compactExpandedBounds`、`stableCompactBounds`、`compactDragSession`、`compactDockSuspended`、`presentationRendererWaiters`、`acknowledgedPresentationOperations`、`compactResizePersistenceTimer`、`pendingCompactResizeBounds`。把 506–571、1022–1319 的supported/active/snapshot/broadcast/ACK/waiter、commit/recover/enter/exit、compact drag、尺寸保存与flush全部迁移。共享坐标适配用B4c同一实现。

注入 host window getter、screen、isLocked、getSettings、普通geometry persistStable/get/set、resolveExpandedViewBounds、Dock restore/reset/suspend/resume/move/capture、普通drag end、B4a blur sync/hide与zorder端口、applyResolvedWindowRuntime、persistValues、logger、sender安全入口。原 `operation.targetBounds = ...` 两处应变成内部受控适配，建议controller增加 `setOperationTargetBounds(operationId,bounds)`：只有匹配当前operation ID才能设置copy并通知state；返回false处理stale。不向外暴露可写controller；snapshot deep-copy operation.context/targetBounds中实际可变字段。该新方法若实施，须在controller精确测试覆盖stale ID/副本，不能把API封装当行为证明。

建议公开方法：`initialize(window,expandedBounds)`、`snapshot/isActive/isCompact/isBusy`、`enter/exit/request`、`acknowledgeRenderer(sender,operationId)`、`begin/update/endDrag`、`handleResize(bounds)/finishResize`、`flushSize(source)`、`settled()`、`releaseWindow(window)`、`prepareShutdown()`。内部commit/recover不外露。是否公开request由真实消费者决定，避免入口重新组装perform/recover。

外部写点/消费者：

1. createWindow 的 controller.initialize、expanded/stableCompact初值（2012–2014）改 `initialize(createdWindow,normalBounds)`。
2. resize监听的stableCompact赋值与schedule（2133–2135）改 `handleResize(window.getBounds())`，normal分支仍由B3b处理。
3. `window-set-bounds` sender/finite/min/max/lock/busy/DockTransition验证保留；compact提交后的赋值（4177–4178）改runtime命令；普通bounds不转为compact尺寸事务。
4. presentation IPC、renderer ACK、compact menu可见条件与exit callback改runtime；菜单组装可留B7a，但不持controller。
5. mainSettings/diagnostics/test hook只读snapshot；Dock ordinary geometry guard、weather guard、viewVisibility/notification/tray恢复、B4e视图切换只用readonly/exit/settled。
6. host closed清waiter/ACK（2204–2206）移release；shutdown compact timer/flush改prepareShutdown。计时器必须取消且最后pending size按DB仍开放的阶段flush。

顺序保持：compact前 restoreDock/reset/end普通drag → 保存expanded稳定几何 → 一次取得compact暂停 → 以cursor所在workArea约束compact bounds → 通知renderer目标 → hide父窗/Overlay → ACK → minimum size/真实setBounds → show与blur同步/native层级确认。expanded反向恢复历史expanded位置、普通stableBounds、释放compact暂停；compact尺寸仅写compactWidth/Height，无posX/posY或compact坐标写入主geometry。失败发force-expanded、恢复normalBounds/最小尺寸、释放自己暂停、同步native和focus。快速反转由原controller串行消费latest intent。

当前close cleanup会resolve ACK waiters；执行前必须独立验证“等待ACK期间destroy/导航/shutdown”终态。不得因把waiter Map搬入模块就说晚到commit已阻断；若需取消operation、增加window身份checkpoint或拒绝waiter，先用受控Promise证明原缺陷，再做局部修复并更新契约。initialize在requestPromise未结束时原本会拒绝，应维持或单列有证据修复。

精确验证：`presentation-mode-controller.test.js`（当前仅latest intent与失败回expanded两例）、`window-compact-geometry.test.js`、迁移后的 `presentation-mode-architecture.test.js` 和必要owner lifecycle测试。architecture 当前仍含旧mainWindow/newBrowserWindow计数等结构定位，需区分：host构造数量定位host；compact/size事务定位runtime；写协调定位B4f；导航定位B4e；renderer契约继续定位原组件。不能简单把count改0使保护失效。

真实 `presentation-mode-electron.mjs` 已消费app，包含同BrowserWindow/HWND、紧凑尺寸/idle保存/展开恢复、ACK失败与视图导航/native blur。若其默认范围超出本次迁移，先增加明确scenario并登记“compact-lifecycle”与必要导航场景，禁止顺带窗口合集。结果记录actual HWND/geometry/sql/native health及cleanup；未覆盖硬件mixedDPI/多屏/真实系统边界列残余风险。

回退 runtime/controller受控target API/坐标适配/所有外部事件和IPC/source-read定位同批；顺序依赖B4e须倒序恢复。

### B4e：MainViewNavigation

当前状态：已迁移，局部行为验证通过；退出过程中回退加载迟到显示缺陷单独复现并修复，见末节。指导：新增 `src/main/windows/main-view-navigation.js`。唯一拥有 `activeViewMode`、`switchingMainView`、`checkingViewDrafts`、`pendingMainViewRendererReady`、`queuedViewSwitch`，包括ready timer/promise与身份、最后背景延迟目标。不要扩大“背景忙时最后目标”成所有busy都排队：当前草稿检查/切换中会拒绝请求，该产品行为迁移保留。

完整函数/适配：`getActiveWindowName/Profile`、`resolveActiveViewWindowBounds`、`getActiveRendererLocation`、`begin/acknowledge/cancelMainViewRendererReadyWait`、`loadActiveViewIntoWindow`、`hideMainWindowForViewNavigation`、`prepareMainWindowPresentationForView`、`prepareBlurRuntimeForActiveViewNavigation`、`presentActiveViewInExistingWindow`、`switchMainView`、`switchMainViewFromTray`；`view:switch`实际调度和`renderer-ready` filter/显示完成也由同一导航owner承担，入口只鉴权/参数验证。`mainWindowPresentationTiming`属于load/show会话，不宜仍让index直接写，请并入导航owner或明确host timing受控端口，不能两份time镜像。

注入 host get/load/readIdentity；screen；settingsRuntime唯一reset/refresh/read/snapshot能力与application/view repository；普通geometry；Dock readonly cleanup/stableBounds和restore/reset/setWorkArea；drag end；Presentation exit/settled；B4a初始化/临时hide/restore与zorder；confirmEditingDrafts；tray refresh；notification pending reveal；logger。renderer URL/ROOT/isDev/profile是静态配置。background未迁时只读 `isInFlight`和单一 `onSettled`订阅，B4f替换注入，不反向import。

API建议：initializeActiveView(mode)、readActiveMode/scope/profile、isSwitching/isCheckingDrafts、resolveInitialBounds/location、requestSwitch(mode,context)、acknowledgeRenderer(sender,viewMode)、load/present、cancelPendingLoad(error)、onBackgroundSettled、releaseWindow/dispose。只公开真正外部需要的load/present；load轮次内部产生。readiness不新增另一份active mode。

所有外部写点：启动读取activeView（3800）改initialize；settings runtime getViewMode、repository scope getter、main diagnostics/log context、tray三种mode、business IPC getViewMode、window profile、ready/switch IPC均改导航读口；geometry.canSchedule改navigation.isSwitching。shutdown isViewDraftCheckActive改读口，hostclosed改releaseWindow。当前background finally取/清queuedViewSwitch并setImmediate调用导航（4557–4560）必须整体删除，改“背景只通知收敛、导航自己消费唯一queued target”。

关键顺序：

1. shutdown/草稿检查gate → 若compact，等待exit且showWhenDone=false → same mode仅show → 草稿flush/冲突授权 → native cleanup gate → 背景inFlight则保存最后deferred target。
2. 读取source持久化候选与sourceDisplay → restore/reset Dock → disarm timeout取消，不改scope → end普通drag → cancel geometry debounce → prepareViewSettingsForSwitch保存source pending geometry与必要target initialization。
3. hide同一BrowserWindow/Overlay → activeMode变更 → SettingsRuntime resetForView/refresh → 用目标独立geometry/workArea设置同一窗口 → host.load +匹配ready两者完成 → writeActiveView → rebuildTray。
4. 失败取消ready，恢复previousMode/settings/source bounds/display、加载旧renderer、恢复activeView存储和tray；双重失败记录fatal并显示可用窗，不销毁建新窗口。
5. `view:switch`回复当前renderer后下一event loop导航，finally向仍存活原sender发`view:switch-finished`，保留取消解除UI busy。回复true只是接收，不是最终切换成功。
6. ready过滤current sender、pending window与mode、activeMode；晚到旧view不能show/resolve。保留旧renderer安全只读例外，不扩大写授权。

Q005边界：整页load、同mode reload、同document remount是不同身份。加入generation/document令牌之前先复现同mode迟到ready能否越过当前load gate；不能仅因B4e设计有轮次就修改preload协议或把问题说已修。任何新增令牌应main/preload/renderer共同登记、明确旧消息兼容与超时，相关sender矩阵一起验证。

最小测试：`view-switch-geometry-order.test.js`的有效顺序移为owner行为（source SQL早于scope变更/load、Dock cleanup失败不切换、rollback恢复），保留入口实际委托与单window结构保护；`editing-draft-guard.test.js`/对应session文件只按受影响草稿边界选择，不能跑整个DB库；导航owner用受控load/ready/背景Promise验拒绝、latest background target、timeout、same-mode、旧sender与rollback。真实app选明确list→month→week及rollback/draft取消场景，可在settings-queue/presentation已有真正app专项中登记相关scene；week仍使用MonthApp能力，但持久化scope独立。断言同BrowserWindow/HWND、scope rows/geometry与最终renderer存在，不能仅await IPC=true。

回退navigation/index/profile/scope/ready/草稿与背景收敛通知、测试manifest同批，B4f已有订阅先断开/倒序恢复。不得把新queued目标与旧背景finally并存。

### B4f：SettingsWriteCoordinator 与 BackgroundSettingsCoordinator

当前状态：已迁移，局部行为验证通过；背景请求排空已接退出阶段，真实 native 启用与导航竞争专项另记。指导：新增 `src/main/settings/settings-write-coordinator.js`、`src/main/settings/background-settings-coordinator.js`。SettingsRuntime继续唯一拥有values/revision/session shortcut gate；两个coordinator都不复制resolvedSettings、activeViewMode或snapshot。

#### 通用写协调的完整事务边界

完整迁移 `persistSettingValues`、`persistSettingValue`（当前1401–1453），包括 diagnostic observation/currentOperation verification、before/after SQL evidence、application/view分流、refresh、窗口/blur/Dock副作用、snapshot与broadcast。注入 repository/scope/schema/app-ID集合、SettingsRuntimerefresh、window/blur/Dock端口、snapshot/broadcast、diagnostic上下文。返回仍为广播出去的同一完整snapshot。

顺序保持 serialize/validate全部entries → scope与diagnostic ticket → before rows → 按原view/application顺序写 → after evidence → refresh revision → window副作用 → blur/css tint副作用（`applyBlurRuntime=false`尊重初始化已完成）→ Dock reconcile → snapshot/broadcast。一般persist当前跨scope两笔并非自动事务，不能顺带改成全局事务并声称重构无行为改变；Q001 reset已单独改成repository跨scope事务，要继续调用现有 `resetCurrentViewSettings` 而非退回旧clear API。

所有persist消费者保留一个写协调实例：renderer ID allowlist、Dock atomic set config、geometry reconciliation、compact尺寸、lock、壁纸、blur以及窗口/外观设置。不把renderer权限迁进底层serializer扩大所有ID可写。应用write保持repository既有白名单；shortcuts.enabled保持SettingsRuntime会话状态、autoStart仍OS回读，无新DB镜像。

#### 背景owner与闭合竞争

唯一状态：`blurConfigRequestRevision`、`wallpaperActivationRevision`、`blurSettingsRequestsInFlight`，以及190ms退场等待的pending timer/settlement订阅（若改为owner管理）。**queuedViewSwitch归B4e**，背景owner不保存第二个target。完整移动 `set-blur-config` body（4462–4564）、`wallpapers:activate/disable/delete`（4575–4622）、`persistWallpaperState`、`deactivateWallpaperForGlass`、`restoreSuspendedWallpaper`；wallpaper查询/usage/library装配可作为此owner窄读能力，资源存储仍调用db-wallpapers既有实现，不把asset staging代码搬进设置coordinator。

注入只读SettingsRuntime/scope/activeMode；B4a readonly state + setRequestedConfig/clearFailure/restoreFailure/disableConfig/init/diagnostic；通用write；same-scope direct write/refresh用于原deactivate路径；wallpaper repository（markUsed/delete/list/data/thumbnail/save等按需要）；窗口bounds read、独立view设置读、snapshot/broadcast。`setBlur/activateWallpaper/disableWallpaper/deleteWallpaper`返回DTO/异常/IPC payload不变。`isInFlight`只读，`subscribeSettled`只通知从有未完成请求→零的收敛；导航自行选择最后目标，避免background→navigation→background递归环。

原行为链必须保留：

1. setBlur准入先inFlight++并捕获request revision/activation revision与独立requestedConfig；先deactivateWallpaper并broadcast退场，再等待190ms，保持导航仍在原scope。
2. 等待后旧revision请求不覆盖最新请求；若没有新wallpaper且最终blur未开启，按原条件恢复自己挂起的wallpaper；若wallpaper superseded不反向恢复旧选择。latest请求恢复自己的config快照，不能被deactivate后的DB旧blur值刷新覆盖。
3. enable未初始化则init；失败config禁用；通用write四个blur字段，init成功skip重复apply；立即health检查后返回实际runtime；失败必要时restore悬挂wallpaper。
4. wallpaper activate先markUsed记录，然后捕获blur failure/诊断/revisions；三个互斥setting同一个view SQLite batch提交，advance两revision使旧blur等待失效；提交失败restore failure/revisions并抛原错误，不拆三次persist。markUsed独立事务的既有lastUsed副作用不能臆称也已回滚；若要改变需单列产品/存储语义。
5. wallpaper delete按所有view usage和scope清选择、DB/files原提交/补偿顺序；只有删除成功且当前活动view受影响才refresh/broadcast，不能用await前的activeView镜像写错scope。
6. finally精确inFlight--，零时发布settled，导航回到下一event loop消费queued目标。提前return/抛错同样收敛，不抛二次错误掩盖业务失败。

#### 迁移前必须独立核查的失败边界

计划时发现190ms等待尚无本模块持有的停止/排空能力，不能据此宣称已经发生客户故障。实际迁移保留190ms产品退场行为，新增请求准入停止与完整异步请求集合；退出在数据库关闭前等待已准入请求完成。受控验证停在退场 gate 时 seal 新请求、已接受请求仍完整写入后才排空，详见末节；没有改为超时后提前关库或取消资产补偿。

普通write跨scope局部提交风险不与Q001 reset混淆。公共写口改动影响广，但采用精确ID/path映射而非全量：从真实改动到settings/runtime/blur/Dock/compact的必要场景挑选，有未映射先报告，不fallback all。

精确验证计划：

- `blur-settings-main-wiring.test.js` 的 CSS tint/opacity触发apply语义移到write owner并保留入口接线；owner行为测试使用受控repository/native，验证serialize前无写、scope分流/顺序、skipApply、window/Dock副作用与同snapshot广播，不把mock当真实SQLite/native证据。
- 背景owner用受控退场Promise和write故障验证 blur enable→disable、blur→wallpaper、多个blur请求、activate失败回填、最终inFlight=0与settled一次，以及B4e只消费最后deferred view。fake timer只用于竞争/清理测试，不代替产品190ms退场动画验证。
- `wallpaper-storage-electron.mjs`按实际涉及的delete/clear-selection/failed commit选择；asset staging/backup不变时不自动跑attachment全部场景。
- 真实app新增或登记精确background-navigation场景：原view wallpaper+blur异步互斥、同时month/week请求、SQL scope/revision/final snapshot/actual native有效状态、失败恢复，继续通过actual enabled/requestedMatches/anchored/Overlay health确认。`settings-queue-electron.mjs`的metadata明确nativeBlurEnableVerified=false，当前证明设置排队/reset，不可冒充这条原生启用证据。
- final验证新代码与实际IPC之外，source-read仍存在的所有被移函数定位清单：blur-settings-main-wiring、presentation-mode-architecture、dock-main-wiring、view-switch-geometry-order、必要diagnostic-noise、shortcut guard等逐条核对；不能只Vitest related/changed自动发现。

回退write/background/index IPC与函数、B4e settled订阅和queued归属、B4a受控状态消费者、storage返回协议、相关tests/manifest一起；SettingsRuntime/B1repository及Q001已成立修复不能被入口旧恢复文件覆盖。每小步回退先冻结源码基线，记录输入来源，再执行下一步，不重跑早期迁移脚本覆盖后续批次。

### 跨批完成门槛与验证边界

生产迁移、局部验证、真实桌面专项分别记录。模块真实存在、mutable写点归唯一owner、完整消费者已接且局部验证通过后可记录生产迁移完成；必要桌面证据完整之前不能写全部验收完成。指导写完不代表迁移或测试已完成。

前期暂停期间只执行读取与AST枚举；授权后的实际unit/lint及桌面执行见下文。前文B4a有效13项局部/52项实际native证据保持，Overlay确认失败也保持。未执行全量测试、完整回归、打包、发布、ABI/C++/DLL改动。真实硬件mixedDPI、多显示器拔插/休眠、installed客户机器和长时间稳定性仍不由这些本地结果覆盖。

执行时Windows统一显式Node和去Volta PATH；真实Electron/native首次即沙箱外；桌面和out由一个负责者冻结/串行。GUI Electron不能只以PowerShell调用返回码判完成，使用runner正式adapter或 `Start-Process -Wait -PassThru`并重定向stdout/stderr，核completed/实际assertions/evidence/cleanup与进程终态。保留首次失败，不以fresh重跑通过解释native偶发失败根因。

## 授权后 B4b–f 实际实施记录

以下记录对应2026-10-09授权后迁移的当前源码。生产源在 B7a 入口接线、两只读 integration hook 加入后冻结；随后只更新文档，由父代理统一构建、冻结 out 与串行执行桌面专项。尚未得到实际退出码及完整证据的 GUI 项目不能预填通过。

### 迁移与恢复输入

| 子批 | 新的唯一 owner | 执行前恢复来源 |
| --- | --- | --- |
| B4b | `src/main/window-motion/dock-runtime.js` | `tmp/refactor-baselines/B4b-2026-10-09T02-33-14.363Z/`，含 index 与前置 BlurRuntime |
| B4c | `src/main/windows/window-drag-controller.js`、`window-drag-coordinates.js` | `tmp/refactor-baselines/B4c-2026-10-09T02-38-38.577Z/index.js` |
| B4d | `src/main/windows/presentation-runtime.js`，复用原 controller | `tmp/refactor-baselines/B4d-2026-10-09T02-42-04.075Z/index.js` |
| B4e | `src/main/windows/main-view-navigation.js` | `tmp/refactor-baselines/B4e-2026-10-09T02-46-55.499Z/index.js` |
| B4f | `src/main/settings/settings-write-coordinator.js`、`background-settings-coordinator.js` | `tmp/refactor-baselines/B4f-2026-10-09T02-52-40.432Z/index.js` |
| B7a 入口消费 | FeatureRuntime、NotificationActivation、MainTrayController、BusinessMutationAdmission 的唯一实例 | `tmp/refactor-baselines/B7a-entry-2026-10-09T03-03-53.614Z/index.js` |

执行脚本 `tmp/b4b-migrate.cjs` 至 `tmp/b4f-migrate.cjs` 和 `tmp/b7a-entry-migrate.cjs` 仅用于追溯。不得重跑：它们记录当时的输入并写完整入口，重跑会覆盖后续 owner 和其他代理成果。回退必须依据上表倒序、成组恢复当前子批的入口委托、完整 owner、测试定位和manifest；不能用早期整份入口覆盖已成立的 B1/B3/Q001 修复。

### B4b 的实际所有权

DockRuntime整体接管 config/capability、side/hidden/sliding、session/generation/backend、slide/hide/geometry/cleanup/display计时器、native消息hook、display/power listeners、native observer和诊断政策取消订阅。入口 createWindow attach、closed release、navigation工作区与普通geometry读口、hover、tray、scheduler、capture和shutdown均消费同一实例。

`getDockDiagnosticSnapshot()` 返回深复制数据，外部不能通过stableBounds/motionPlan写回会话；`cleanupStatus`仅返回数据。BlurRuntime使用 `isWindowMoving` 查询，不持有Dock backend。`prepareShutdown`在DB/native仍有效时reset/disarm、停止自己的timer/listener/observer/policy；末尾 `dispose` 释放hook与引用。global native destroy仍是最后兜底，未改变ABI18或原生确认标准。

五个新增行为场景验证 queued show 先于persistent handle、嵌套暂停取消延迟hide、旧代次trigger拒绝与session-local handle、disarm失败cleanup阻止新hide、幂等终态与资源释放。加七个直接相关Dock/geometry文件，早期8文件65/65；最终与其他B4子域合跑结果另列。实际app owner装配由 `dock-runtime-electron.mjs` 验证，直接DLL专项不能替代该证据。

### B4c 的实际所有权

WindowDragController接管普通标题栏session与暂停，begin/update/end/isActive/releaseWindow完整移交；会话保留真实window身份并拒绝错窗更新。end先清active和唯一暂停，按moved调度普通geometry，再执行bottom重申和前后native诊断。compact drag仍在PresentationRuntime。

坐标统一由 `createWindowDragCoordinates(screen)` 提供，整矩形继续调用 `dipToScreenRect`；无效point继续回落到系统cursor。入口move/moved guard、三个IPC、compact/navigation/shutdown结束路径和closed顺序均接该owner。五个新增行为场景通过。真实标题栏专项增强的是实际UI拖动和native结果，未用source文本代替GUI。

### B4d 的实际所有权及独立退出修复

PresentationRuntime接管expanded/compact bounds、compact drag和Dock暂停、ready waiters/ACK集合、compact尺寸timer/pending，复用唯一PresentationModeController的mode/latest intent/operation/promise。controller增加受控 `setOperationTargetBounds(id,bounds)`，只允许当前operation id、复制目标bounds并发布状态；snapshot深复制operation，外部不再写operation对象。

独立复现：`tmp/refactor-baselines/B4d-shutdown-review/result.json` 实际执行旧owner并隔离DB/native/window端口。live window进入compact、匹配ACK未到、prepareShutdown后再到ACK，旧实现仍返回compact提交成功，并调用setBounds/show/native/focus；暂停已释放为0。它是owner生命周期证明，不是GUI或客户机器证明。

先补失败用例，`tmp/B4d-late-ack-before.json`记录4通过1失败（退出后ACK仍被接受）。随后最小修复：terminal stopping gate；waiter可拒绝；prepareShutdown拒绝全部waiter并清ACK；await ACK后复核stopping与真实window；recover/show/drag/resize/late timer停止gate；closed取消pending而非冒充渲染完成。取消错误明确为 `PRESENTATION_CANCELLED`。

入口onBegin在草稿批准后立即prepareShutdown，不能等待capture/remote期间继续compact提交。新 `presentation-settlement` 退出阶段在DB关闭前等待controller活动promise，仅上述取消码记录正常cancelled；其他失败仍记失败。compact尺寸仍在DB开放时flush；只释放自身Dock暂停一次。新增五行为场景覆盖正常ACK/尺寸flush、超时回expanded、closed取消以及live-window退出迟到ACK，最终全部通过。

### B4e 的实际所有权及独立退出修复

导航唯一持有mode/switching/checkingDrafts、pending ready与timeout、queued background target、presentation timing。SettingsRuntime/window profile/日志/tray/business IPC/geometry读取同一导航状态；`view:switch`和`renderer-ready`实际调度移交。背景只通知settled，导航自己在下一event loop消费最后目标，保留其他busy拒绝的产品语义。

独立复现：`tmp/refactor-baselines/B4e-shutdown-review/result.json`在目标加载失败、恢复加载挂起时dispose live window，迟到恢复仍触发 `logger.fatal` 和show。修复进入、compact等待后、草稿等待后、load后、恢复load后、ready和deferred callback的终态gate。退出后不写active scope、不rebuild、不show、不记正常退出为恢复fatal。入口closed调用 `releaseWindow(createdWindow)`，统一取消pending、timing和queued target，避免只取消ready而遗留目标。

八个行为场景覆盖source SQL早于新scope/load、最后背景目标、旧mode/sender ACK拒绝、草稿与cleanup取消、加载回退、慢草稿被退出越过、background callback被退出越过、恢复load被退出越过。Q005同mode迟到ready/document身份未独立修复，仍按前述边界单列，不能凭模块拆分宣称解决。

### B4f 的实际所有权与排空

SettingsWriteCoordinator整体保留serialize全部ID、diagnostic SQL before/after、原view/application写序、refresh、window、blur/CSS tint、Dock、同snapshot返回/广播。普通跨scope写仍是原有两笔，未借重构将其宣称原子；Q001 reset继续使用既有跨scope事务。三个行为场景验证写序/同snapshot、全部ID验证早于任何写入、skip native重复apply仍refresh/broadcast。

BackgroundSettingsCoordinator接管两个revision、blur inFlight、完整blur IPC、wallpaper deactivate/restore/activate/delete/save/library装配、失败回填及已准入异步请求集合。190ms退场仍保留；Set跟踪完整request而非只跟踪SQL或blur count。`preventNewRequests()`封闭新请求；`settled()`直到全部已准入请求包括save/delete与补偿完成才返回。导航判断仍只读blur inFlight，不扩大原产品busy行为。

入口onBegin封闭背景准入，`background-settings` async阶段在DB关闭前排空。四个行为场景验证enable→disable恢复旧wallpaper、enable→新wallpaper不回填旧选择、activate SQL失败恢复failure/revisions、退出seal且等待完整旧write。mock只证明owner与写序；真正SQLite、renderer退场及native启用由新增 `background-navigation-electron.mjs` 单独验收，settings-queue的nativeBlurEnableVerified=false限制继续保留。

### B7a/admission 的入口接线

旧notification/reminder/trayReminder/sticky/weather/scheduler/tray instance和pending notification字段及对应完整body已从入口移交。FeatureRuntime的五个领域DTO与延迟读provider接线，不镜像child service字段；sticky→window runtime→reminders→scheduler及weather位置保留。MainTrayController只读具名sticky/capture命令，NotificationActivation唯一拥有早期protocol action/reveal；Settings广播经FeatureRuntime更新weather/popup。

`registerBusinessIpcHandlers`注入同一admission.run。`clear-note-data`整个handler交 `businessAdmission.clear`，包含排空之后counts查询、DB/files清理、reminder刷新、sticky runtime丢弃、renderer草稿清理与广播及失败结果；没有在drain前统计或把最后清理留在gate外。shutdown在草稿批准的onBegin seal admission、dispose notification、stop scheduler；`business-mutations`阶段具备必需 `enabled: () => true`，排空完整mutation及clear后才清库。

最后sticky清理使用明确 `disposeStickyAfterDrain`，只有stopped、shutdown drain完成、pending=0、没有clearTask的同步cleanup scope可落最后debounce bounds。普通dispose/clear discard不取得该权限，禁止async cleanup扩张退出准入。FeatureRuntime完整partial-start ledger、weather/power/scheduler监听和child services由自身释放，入口按既有DB/native/log顺序调用。相关独立owner测试及真实feature专项由负责该域的代理记录，不混入下面51项数字。

### 最终局部验证与source-read消费

`tmp/b4b-f-b7a-unit-final.json` raw退出0，11个精确文件 **51/51**，无全量命令。分项：DockRuntime5、WindowDragController5、PresentationRuntime5、Navigation8、SettingsWrite3、Background4、presentation architecture8、view-switch geometry1、blur-settings wiring1、shortcut UI3、dock wiring8。

source-read按实际owner迁定位：architecture解析确切FunctionDeclaration，函数不存在立即失败，构造数读MainWindowHost，commit/size/lock/ACK读PresentationRuntime，drag日志读WindowDragController，geometry读DockRuntime，write读SettingsWriteCoordinator，switch读Navigation；renderer契约保持原组件。view-switch、blur-settings、dock-main均读新owner；shortcut保护运行实际入口函数并注入navigation.isSwitching。未将全文拼接伪造同一函数先后关系，未把单window计数改0以弱化保护。

入口、七个B4新模块和五个改动source-read文件ESLint零error/零warning。诊断与native-runtime-gate旧定位由父代理独立适配及验证。随后仅加入background/navigation两只读integration snapshot hook供真实专项观测，生产逻辑不变。没有再次执行全量unit、全量窗口矩阵或发布验证。

构建前窄点复核恢复sticky错误消息原payload：window live guard后直接发送 `{ type: 'error', text }`，不借通用app message helper添加duration。该callback属于FeatureRuntime的window port，实际sticky error处理仍由child负责。入口ESLint通过；直接相关 `feature-runtime.test.js` 的现有行为验证结果见 `tmp/b7a-sticky-error-port-unit.json`，与上述51项分开统计。之后再次冻结生产源及注释，避免真实桌面来源漂移。

纯注释清理的批量首字符串边界脚本曾被自动审批拒绝，原因是可能误删生产逻辑；脚本未执行。sticky接线和必要测试别名改用显式小补丁完成。第一轮生产冻结期间保留入口orphan历史注释；第二次构建前按下文明确小补丁及AST等价核验完成清理，没有使用该被拒绝脚本。

### 真实桌面结果登记位置

初写本节时，父代理尚在统一构建与串行安排相关专项，因此当时没有预填通过。随后得到正式raw退出、completed/assertions/evidence/cleanup、进程终态和源码来源，实际结果登记在下文。B4a前述已通过和未解释的真实Overlay确认失败都继续保留。

### 首次共享构建后的真实启动失败与最小修复

首次共享app build成功，但真实application/background/calendar专项均在启动期失败：`Cannot access 'mainViewNavigation' before initialization`。保留原attempt `tmp/test-runs/2026-10-09T03-17-06-973Z-lpK69s/`各result.json，build stack定位 `index-Ck8jhyQ0.js:24887`。该错误发生在业务断言之前，不能将构建成功或进程启动当作专项通过；它是当前入口构造顺序缺陷，不是Volta/GPU/缓存运行环境阻塞。

根因：`createSettingsRuntime`构造时立即调用getViewMode创建schema默认值，而闭包访问尚未完成const初始化的Navigation。额外逐项检查factory参数绑定与构造同步读取，发现三个随后同样会失败的eager alias：Geometry的isDockGeometryPersistenceSuppressed，以及Dock与WindowDrag各自的isCompactPresentationActive；它们都来自后置const解构。

保留唯一owner的最小修复：SettingsRuntime允许可选不可变 `initialViewMode` schema seed，入口传 `VIEW_MODES.LIST`；省略seed的已有调用仍读取getViewMode，兼容既有API。seed只创建初始化默认settings，不新增activeMode字段或可写镜像；refresh始终向Navigation读取动态mode。bootstrap仍在DB就绪后先 `initializeActiveView(storedMode)` 再 `resetForView(actualMode)`、refresh。上述三个参数改成调用唯一Dock/Presentation实例的窄lazy closure。

构造期逐项复核：MainWindowHost、capture/notification/admission、ZOrder、geometry、drag/coordinates、Presentation、Navigation、write/background、tray、draft/deferred restore/bootstrap/shutdown均只保存相应provider或初始化自己资源；Blur只检测平台能力；Dock构造observer与诊断policy订阅，订阅回调只设置observer interval、不读后置state；Feature构造自己的Scheduler并赋固定notification capability，其余child初始化仍在app启动阶段。没有为了绕TDZ移动业务启动、提前读DB或把Navigation state搬回入口。

先补必要regression：schema seed允许Navigation尚未初始化，refresh必须读取后来的实际month owner；入口AST检查直接引用的lexical binding不能早于声明，函数provider保留为lazy。`tmp/b4-initialization-tdz-before.json`记录17项15通过2失败；修后 `tmp/b4-initialization-tdz-after.json` raw退出0，SettingsRuntime/architecture/Dock/drag/Navigation五文件 **35/35**。它们与前述51项存在重叠，不能相加宣称独立总项数。入口、SettingsRuntime与两个改动测试ESLint零error/零warning；独立AST扫描eager后置lexical引用结果为空。

修后再次冻结生产源及注释，入口SHA256 `C2EF7A6EE395778757328F82CD7BAC53ED2AC61F46F12A43CAA4FC7AF761A82E`。父代理已先终止精确runner PID与其capture子树，保留失败现场，再统一重建及执行原专项。只有重新构建后完成的实际GUI断言才可计为最终验收，本节不预填重跑结果。

第二次构建之前，父代理允许将确定孤立/错位的旧注释一次清理：使用两份显式apply_patch仅移除已迁走的blur/Dock/geometry/navigation说明和空字段注释，保留实际入口函数附近语义说明。与 `tmp/b4-entry-before-comment-cleanup.js` 对比，173→113个comment nodes，153个Program节点数量不变，代码token序列完全相同；AST排除comments/loc/start/end以及Babel extra.parenStart/trailingComma位置元数据后完全相同，证据 `tmp/B4-comment-only-ast-equivalence.json`。首轮AST比较将parenStart视为语义导致false，精确diff确认只是注释删除引起的绝对字符offset；没有因此更改生产逻辑。入口ESLint通过，architecture现9/9，证据 `tmp/B4-comment-source-guard.json`。

纯注释清理后的最终入口SHA256 `70ae0005c888f60e4d32566e7fa40688470dce3a4e6515600c5613e3b255cd58`，交父代理与Reminder域修复一并统一重建。此后继续冻结生产源及注释。

## 最终 B4 真实桌面专项结果

共享新run：`tmp/test-runs/2026-10-09T03-28-40-290Z-oElUD0/`。`build-app-qxZs1f/result.json`退出0、accepted=true；build business provenance verified，输入及工具链closure与已完成构建匹配。该证明只确认构建来源，实际Electron/native能力依赖下列独立业务断言。

逐项读取result.json与standalone.json：以下均raw退出0、completed=true、全部断言通过、0失败/跳过、accepted=true、evidence/cleanup complete、terminationIncomplete=false、无timeout/launch error。由父代理串行运行；本轮文档更新没有更改生产源码、测试或out。

| 所属子批/专项 | 实际通过断言 | 该run下的证据目录 |
| --- | --- | --- |
| B4b DockRuntime真实app接线 | 38/38 | `tests_dock-runtime-electron.mjs-yxAgwU/` |
| B4c 标题栏真实窗口拖动 | 137/137 | `tests_titlebar-native-drag-electron.mjs-GqlmuL/` |
| B4d 单窗口Presentation | 89/89 | `tests_presentation-mode-electron.mjs-ZWBNFc/` |
| B4e/f 背景请求与导航/native互斥 | 62/62 | `tests_background-navigation-electron.mjs-CO2JvI/` |
| B1/B4f 三视图settings runtime消费者 | 36/36 | `tests_settings-runtime-electron.mjs-KPtbpB/` |
| B1/Q001/B4f settings queue/reset | 50/50 | `tests_settings-queue-electron.mjs-YI6qUp/` |
| B4a native leaf最终入口再次确认 | 52/52 | `tests_native-leaf-runtime-electron.mjs-6Lrq2q/` |

Dock mode为 `electron-real-app-dock-owner-native-state`：实际BrowserWindow/native ABI18、left场景和owner命令驱动。证明新owner已被真实app装配、真实native状态与资源收口；metadata明确realPointerInput=false、realDisplayRemoval=false，不能将受控display/power回放写成物理拔插、真实鼠标或多显示器验证。

标题栏mode为 `electron-ready-real-app-titlebar-native-drag`：真实窗口、Chromium mouse input、已定位物理cursor、native DPI转换；覆盖实际拖动与native结果，正常will-quit、窗口关闭与helper/profile清理完整。它不是客户机器证据，不能外推mixed-DPI或所有Windows桌面环境。

Presentation mode为 `electron-ready-real-app-presentation-mode`：同一HWND compact/expanded、resize仅持久化compact尺寸、ordinary geometry、drag、tray/view导航及native blur geometry。gui-evidence记录实际丢弃一次匹配ready ACK（operation 1），验证超时回expanded、同窗口恢复、native继续健康和Dock暂停余额；其它compact/resize/drag/expand/navigation路径验证暂停取得与释放。metadata确认真实窗口/磁盘DB/nativeDComp，syntheticPointerEvents=true、nativePointerDrag=false、chromiumGpuDisabled=true、mainProcessRestart=false；原GPU生产路径与重启持久性不在本专项证明范围。

Background-navigation mode为 `electron-ready-real-app-background-navigation`：真实preload、磁盘SQLite、产品190ms壁纸退场、真实native blur enable。gui-evidence记录等待时inFlight=1、queuedTarget=week，blurCompletion实测203ms且native effectiveEnabled=true；month→week最后目标被唯一导航消费，只有week实际did-navigate、同HWND，main背景SQL没有被错误写入target scope。真实SQLite trigger让week wallpaper activate原子setting batch失败，验证DB/config/Settings revision及background request/activation revisions补偿，native glass仍healthy、inFlight/pendingRequests=0、queuedTarget=null。markUsed保留其独立事务既有副作用，不声称也回滚。metadata明确mixedDpi=false、mainProcessRestart=false。

settings-runtime验证list/month/week当前source消费者，不含main进程重启；settings-queue验证真实renderer/preload/SQLite与second-view-scope-delete trigger故障下reset原子行为，OS autoStart未修改，nativeBlurEnableVerified=false。它的50项继续只证明设置队列/reset；上面的background-navigation nativeBlurEnableVerified=true才补足背景启用竞争证据。

native-leaf在最终入口再次52/52，覆盖actual native启用/配置/几何/层级确认。本地fresh通过仍不能解释先前B4a第二attempt的真实Overlay `zOrderSynchronized=false` 瞬态失败；旧失败证据与客户机器、mixed-DPI、多显示器拔插/休眠、installed环境及长时运行风险继续保留。

共享run当时总体 **16/17 jobs** accepted，唯一Feature脚本clone fixture中断修正后，在 `tmp/test-runs/2026-10-09T03-34-16-718Z-ygxBDo` 正式app来源复核及单项40/40 accepted；详见 [16](16-b7a-feature-and-clear-guidance.md) 与 [04 §25](04-implementation-plan.md#25-明确授权后恢复实施2026-10-09)。原共享run整体仍为失败，不改写历史。这不撤销上表各专项独立accepted结果。没有运行全量测试、完整回归、打包或发布。
