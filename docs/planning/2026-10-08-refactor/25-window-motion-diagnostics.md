# 窗口运动诊断：日志边界、实施与验收指导

更新时间：2026-10-10。状态：日志实施及本机局部验收完成；原运动卡顿根因未确认，运动算法未修改。

用户要求先保留拖动窗口与贴边隐藏的运动实现，核对日常/深度日志归属，并增加能帮助定位根因的证据。本阶段只改观察和必要日志恢复，不调整拖动、动画或窗口同步算法，不以诊断就绪声称卡顿已修复。

## 1. 已核实事实与剩余边界

当前日志框架已具备日常/临时深度模式、源头许可、懒 metadata、有限内存聚合、Worker 异步文件处理、运输预算、错误去重、近期现场、保留池和导出缺失标记。总体架构合理，不需要因两个窗口问题重新实现整套日志系统。

本轮确认了三类缺口：

1. 旧拖动日志只能显示开始/结束、次数和失败；不能拆解持续移动的 RAF、交付、主进程、原生等待和快照耗时。通用性能汇总也没有覆盖两个实际原生移动/快照入口。
2. 正常 `titlebar.drag.renderer` 默认作为 event 日常落盘，而主进程已有事务摘要。本轮将其改为有限 trace；正常 Dock 生命周期的完整诊断快照仅在深度生成，日常原生观察使用小摘要。业务必需的几何校验和错误现场保留，没有证据证明原快照开销造成了卡顿。
3. `log-writer-client.js` 在首次重启后 60 秒内再次故障时，不会安排任何未来恢复。写入器可能直到重启应用一直不可用，影响后续证据保存。

旧日志和固定回调次数只说明可疑链路或延迟放大。开始握手通常很快不能证明持续拖动流畅；指针次数与移动次数不同可能来自 RAF 合并和重复坐标，不能直接叫丢帧。之前的毛玻璃层级修复不代表运动卡顿已修。

## 2. 文件与职责

| 文件                                                                                                  | 本轮职责                                                                        |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `src/renderer/src/utils/windowDragDiagnostics.js`                                                     | 只观察既有指针、RAF、发送、结束；管理渲染批次及校准握手                         |
| `AppTitlebar.vue` / `src/preload/index.js`                                                            | 观察点接入、可选诊断参数传输；旧一参调用继续有效                                |
| `src/shared/window-motion-metrics.js`                                                                 | 固定名称/数量的分桶、慢样本、交付时间区间计算                                   |
| `src/main/logging/window-motion-diagnostics.js`                                                       | 深度许可、5 秒聚合、native 租约、结束/停止/导出尾批及释放                       |
| `window-drag-controller.js` / `dock-runtime.js`                                                       | 原处理链旁路计量，保持返回、原异常处理和恢复回调                                |
| `src/main/bridge/blur_bridge.js` / `performance-diagnostics.js`                                       | 原移动/快照边界计量、native 绑定及导出/退出提交                                 |
| `native_blur/window_motion_diagnostics.cpp/.h`                                                        | QPC 阶段统计、有限关联/慢样本、只读批次导出                                     |
| `native_blur/blur_api.cpp` / `blur_engine.cpp/.h`                                                     | 只在既有移动、barrier、STA、快照点观察，不增加业务等待                          |
| `src/shared/native-abi-version.js` / native 头 / CMake                                                | ABI22 同步、包含新源；DLL 与 app 必须重建并匹配                                 |
| `src/main/logging/log-writer-client.js`                                                               | 限频恢复继续排程、关闭时取消；不改变队列和一次重发预算                          |
| `native_blur/tests/window_motion_diagnostics_test.cpp` / `tests/window-motion-diagnostics-native.mjs` | 独立 collector 原生测试与显式验收入口；CMake test target 排除在普通产品构建之外 |
| `scripts/test-manifest.cjs` / `scripts/run-focused-tests.cjs`                                         | 新资产和直接消费者登记、独立原生结果模式；保持默认局部测试选择                  |

所有文件定位以仓库根目录为基准。没有数据库迁移、长期设置、远程上传或 UI/CSS 风格修改。

## 3. 修改顺序与保留约束

### M001：恢复写入器

1. 保存写入器与对应测试的当前快照。
2. 引入唯一恢复 timer，按上次实际重启计算剩余 60 秒冷却时间；构造失败也继续安排未来恢复。
3. Worker 同次 error/exit 不重复排程；close 开始即停止恢复并清除 timer。
4. 保留 3 MiB 容量、512 KiB 优先额度、后台退避及未确认批次最多重发一次。
5. 使用假的 Worker/时钟对照旧源码与修后源码；直接测试验证连续故障、构造失败和关闭。

### M002：渲染与主进程链路

1. 正常标题栏指针事件改 trace，警告/错误仍保存为日常异常。
2. 深度时在现有指针/RAF点累计，发送时携带 dragId/captureId/seq 与可选时钟边界；日常不读取运动计时的单调时钟、不发详细 packet，必要的策略有效期检查仍存在。
3. 主进程处理旧 bool 与诊断 object 返回；renderer 必须准确读取 `started`，不得以 object 真值把拒绝当成功。
4. 根据握手计算偏移区间，未握手、过期或不可能区间明确缺失；不假设不同进程时钟相同。
5. 观察处理、坐标准备、移动/校验和已有返回边界，保持重复坐标过滤、成功状态提交及原失败结果。
6. 任何计量 getter、时钟、计数或 sink 失败均旁路，不能把实际移动成功变成失败、不能漏恢复回调。

### M003：原生阶段

1. 租约仅随深度开启，native 自身有最长 30 分钟到期；停止关闭租约但不丢未提交尾批。
2. 在原有 `EndDeferWindowPos`、`SendMessageTimeoutW`、`SyncGeometryFromParent`、Visual 更新、移动后快照周围读取 QPC。
3. 保留 `SWP_NOSIZE`、双窗口提交、同步 barrier、默认 50 ms 上限和原 fallback。不增加 HWND 查询、消息、移动或等待。
4. 使用数值序号关联 STA 服务，不能向跨线程消息传发送者栈指针。
5. 移动路径仅尝试获取统计锁，竞争时丢观察并计数；批次序列化在专门 drain 时进行。
6. 诊断操作保存/恢复 Win32 LastError。不能为计量清零业务线程错误；失败后错误值与前值相同则标记可能旧值。
7. 同步 ABI22、导出绑定、CMake 与构建输入，重建匹配 DLL/app 后再做真实窗口验收。

### M004：结束、导出与资源

1. 5 秒、拖动/动画结束、模式停止/到期及卸载提交有限批次；模式切换后的尾批保留采集时身份。
2. 进行中 recorder 注册到全局提交集合；finish 退出集合并释放 timer/订阅。
3. 导出冻结时 flush 所有运动 recorder 和 native；顶层 `exportRequestId` 让截止时刻之后生成的补交批次进入该次导出。
4. native 关闭租约 setter 抛错也必须继续提交旧批、清 timer/policy；dispose 必须继续退订。模式停止后的策略订阅保留，以支持以后重新开启深度。
5. 导出先核对真实 JSONL 字段，再判断源头采集与运输的完整性；不能只测试采集器原始对象。
6. 观察源失效发出有限的 `window.motion-diagnostics` 警告；已有运输完整标记不替代各运动来源的采样完整性。渲染时钟失效的已有尾批仍尽力提交，未知时间填 `null`，附 `observationFailures`。

## 4. 日常与深度归属

| 内容                                     | 日常                  | 深度                              |
| ---------------------------------------- | --------------------- | --------------------------------- |
| 拖动/贴边事务摘要、开始/结束/结果        | 继续保存              | 相同                              |
| 移动失败、捕获丢失、窗口不同步及必要现场 | 保存，去重/限次       | 相同                              |
| 正常标题栏指针过程                       | 主进程近期 trace ring | 详细 trace 落盘                   |
| 输入、RAF、交付、处理、移动/校验耗时     | 新计量关闭            | 原回调内累计，5 秒或结束/导出提交 |
| native barrier、STA、Visual、快照耗时    | 租约关闭              | 有界分桶及最多 6 个慢样本         |
| 通用 CPU/内存/主线程性能                 | 低频 30 秒            | 5 秒，不代表 GPU 呈现频率         |

渲染侧最多 8 个慢样本，主进程最多 16 个阶段/计数名与 6 个慢样本。native 服务关联容量为 128；锁竞争、遗漏和关联缺失必须保留其语义。公共单 metric 上限 64 KiB，还受 producer 额度及整理节点/深度/键/数组上限约束。

## 5. 读日志与形成根因的方法

先看导出 `diagnostic-complete`、mode/captureId、保留范围和来源能力，再按相同现场的区间查看四类记录。`complete: true` 仅表示已有运输/提交/解析未报告缺失，不保证每个业务阶段都有完整采样。

| 记录/指标                                                | 能回答的内容                                   | 不能直接推断的内容                    |
| -------------------------------------------------------- | ---------------------------------------------- | ------------------------------------- |
| renderer `dispatchAge`                                   | Chromium 事件时间到处理回调的年龄              | OS 输入硬件/系统投递的完整延迟        |
| renderer `scheduleWait`、`latestPointerAge`              | 既有 RAF 等待及最新输入到发送年龄              | DWM 呈现或显示器 FPS                  |
| renderer `coalescedPointers`、`updateIntervals`          | 合并输入及发出更新节奏                         | 次数差等于丢帧；平均次数等于真实 FPS  |
| main `deliveryLowerBound/UpperBound`、`clockUncertainty` | 校准允许的一次交付耗时范围                     | 全部耗时都是主线程排队；精确单向延迟  |
| main `telemetryHandling`、`coordinateConversion`         | 诊断参数处理与既有坐标准备分别计时             | 排除全部计量自身开销的纯函数基准      |
| main/Dock `moveAndValidation`                            | 原移动、已有后置快照/校验返回的耗时            | 画面已显示到用户面前                  |
| native `endDefer`                                        | 原双窗口位置批提交耗时                         | 只能是某一个窗口线程造成              |
| native `barrier`、`staGeometry/staSetPosition/staVisual` | 同步等待和匹配 STA 服务/Visual 更新各耗时      | 默认上限 50 ms 等于每次实际等待 50 ms |
| native `nonServiceWaitMs`                                | 成功 barrier 内完整包含匹配服务时的残差        | 纯队列等待时间                        |
| native `snapshot`、HWND/snapshotEvidence                 | 既有原生边界查询时长、返回时实际边界及目标匹配 | DWM 实际呈现时刻、肉眼流畅度          |
| Dock `callbackInterval/callbackLateBy/animationElapsed`  | 回调节奏、请求间隔之外的迟到、整段动画耗时     | 已确认初始阻塞根因                    |

`actualPositionErrorPx` 在 `coordinateSpace=physical` 时单位为物理像素；Electron 逻辑坐标后端按 DIP 判读，不能混合比较。查不到位置或时间必须按 unavailable 分析，不能当零耗时/零偏差。

渲染与主进程 packet 共用 seq；native 自有 seq。native 内部移动/barrier/服务/后续快照可关联，跨层通过 capture、区间和目标坐标交叉判断，不能直接把两种 seq 等同。深度在拖动中途开启时可能没有完整握手，需以缺失状态分析，必要时重新开始一段拖动。

当某阶段出现耗时突增，先确认它与用户卡顿、处理滞后和实际 HWND 更新出现在同一现场；再做同版本、同环境、单变量 A/B/A/B。毛玻璃开启、关闭但已初始化、从未初始化应分开，不能以开关关闭就排除原生双窗口路径。日志能缩小可验证假设，不自动提供因果证明。

## 6. 指定局部验证与完成条件

| 验证范围                                                          | 文件/专项                                                                                                                                       | 实际结果                                                               |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 写入器限频恢复、唯一 timer、构造失败、关闭、一次重发              | `tests/log-writer-client.test.js`                                                                                                               | 5 用例通过，纳入 7 文件 79 用例通过批次                                |
| 主/native source gate、尾批、预算、时钟/状态/cleanup故障、导出    | `tests/window-motion-diagnostics.test.js`                                                                                                       | 通过，纳入 7 文件 79 用例批次                                          |
| renderer source gate、校准、旧响应、合并、深度中途开启、停止/卸载 | `tests/window-drag-diagnostics.test.js`                                                                                                         | 19 用例通过，纳入同批次                                                |
| 原业务重复过滤/状态提交/失败返回、Dock恢复                        | `tests/window-drag-controller.test.js`、`tests/dock-runtime.test.js`                                                                            | 通过，纳入同批次                                                       |
| 性能导出/退出提交接入、ABI同步                                    | `tests/performance-diagnostics.test.js`、`tests/native-runtime-gate.test.js`                                                                    | 通过，纳入同批次                                                       |
| 性能归因、登记及选择                                              | `tests/performance-attribution.test.js`、`tests/test-manifest.test.js`、`tests/test-selection.test.js`                                          | 3 文件 82 用例通过；旧 DB fixture 见下文                               |
| 最终登记、选择、窄原生入口、日志噪声                              | `tests/test-manifest.test.js`、`tests/test-selection.test.js`、`tests/run-focused-tests.test.js`、`tests/diagnostic-noise-and-location.test.js` | 4 文件 91 用例通过，与上一批有重复文件                                 |
| 原生 LastError、租约、返回时刻分类、有界聚合                      | `tests/window-motion-diagnostics-native.mjs` → 独立 C++ collector                                                                               | 108 原生断言通过，Node/Electron wrapper 8 条结果校验通过               |
| 同ABI22 native/app构建、真实拖动、deep/daily日志/中途导出         | `tests/titlebar-native-drag-electron.mjs`                                                                                                       | 最终 179/179 断言通过，7 个真实输入场景，正常退出/鼠标恢复完整         |
| 同域原生层级保护                                                  | `tests/native-leaf-runtime-electron.mjs`                                                                                                        | 最终 598/598 断言通过，ABI22；毛玻璃开/关及 normal/top/bottom 重复切换 |
| 贴边计量与资源释放保护                                            | `tests/dock-runtime-electron.mjs`                                                                                                               | 最终 46/46 断言通过；命令驱动真实窗口，不冒充物理鼠标/显示器移除       |

完成条件：日常不启用新增高频计量；深度可判读各阶段/缺失/误差；停止/到期/结束/导出保留尾批；所有异常仍保留原业务语义；关闭后资源释放；单条记录经真实整理/运输/编码后仍可解析且预算内；同 ABI22 构建下真实专项确认没有引入移动、几何或层级回归。采样完整与实际不卡顿分别验收。

命令从第一条开始使用固定 Codex Node，并过滤 Volta PATH。真实 Electron/Windows 桌面测试直接在能访问桌面与用户缓存的合适环境运行。必要 native/app 构建属于对应专项前置，不默认运行 `npm test` 或 `test:window-frame:win`。

## 7. 恢复与证据

修改前快照保存在 `tmp/motion-diagnostics/before`，已有文件不覆盖。写入器确定缺口的纯内存前后对照保存在 `tmp/motion-diagnostics/writer-recovery-before-after.json`；修后模拟只证明创建了未来恢复 Worker，最终 ready 由直接单元覆盖，不能拿它当真实 Electron 故障验收。

回退时仅恢复本轮文件与匹配的 DLL/app 产物，恢复旧 ABI 与桥接绑定必须同时进行。不得整体 reset/clean 当前脏工作区，不删除历史失败、用户数据或其他代理/用户修改。单独撤回诊断实现也不能留下新 ABI 绑定到旧 DLL。

本轮日志审查修复写入器冷却恢复、导出尾批遗漏、观察异常隔离及原生服务返回时刻分类。原生 ABI 从 21 同步为 22；DLL 和 Electron main/preload/renderer 构建成功。指定修改文件 ESLint 与格式检查通过。

### 7.1 实测归因与失败保留

- 真实拖动时在 test-only 主进程监听器加入一次 90 ms 阻塞。导出实际记录的交付区间为 90.08–90.82 ms，移动及已有校验最大 1.93 ms、native barrier 最大 0.416 ms、STA 最大 0.327 ms，未把交付等待误归到原生移动。
- 在真实 Chromium 指针流的既有 RAF 前加入一次 90 ms 渲染阻塞。渲染 `scheduleWait.maxMs=90.1`，与另一段主进程延迟区分。
- 贴边动画开启后阻塞主线程 90 ms。现有 13 次回调全部完成，`callbackInterval.maxMs=90.56`、`callbackLateBy.maxMs=74.56`，移动与校验最大 2.91 ms，整段动画 324.31 ms。计量没有修改 13 回调的原算法。
- 进行中的拖动导出保存三层未满 5 秒的尾批，main/native 带匹配 `exportRequestId`；实际 JSONL 的 `diagnostic-complete.complete=true`，字段经过 preload、整理、Worker 编码及导出仍可判读。该标记不证明 DWM 呈现或运动采样无缺失。
- 首次 unit 发现 DB timing fixture 过时：摘要现有 notes、reminders、tags、attachments 共 4 次各 80 ms fake 读取，而旧测试只按 3 次计。已核对源码并断言具体查询顺序，期望改为外层 320 ms、hydration 240 ms，没有修改数据库查询实现或删除测试。
- 两次渲染注入失败均保留。第一次监听器在业务监听器之后注册，实际阻塞下一批输入；第二次以 Chromium 合成 mouseMove 的 `buttons` 做门槛，注入没有执行。最终把注入监听放在真实 pointerdown 捕获阶段，保证它先于组件注册下一次 pointermove 观察；维持 `scheduleWait>=70 ms` 的原强度断言，没有放宽断言。
- 独立 review 发现 service 在 barrier 返回后、ring 匹配前完成时会误标“返回时可用”。已按完成 QPC 与返回 QPC 分类，缺失边界保持未知，并由独立原生测试验证；业务 flags、等待和返回不变。

### 7.2 证据定位

路径均相对仓库根；成功、失败 attempt 不互相覆盖。

| 证据                                          | 位置                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 首轮构建/Dock/层级通过、RAF 注入首失败        | `tmp/test-runs/2026-10-10T02-38-11-642Z-EseM8s`                                              |
| 构建复用确认、渲染注入未执行的第二失败        | `tmp/test-runs/2026-10-10T02-43-33-076Z-5ogaAx`                                              |
| 原生 collector 构建/结果，108 条原生断言      | `tmp/test-runs/2026-10-10T02-47-20-295Z-S1vhvL`                                              |
| 最终真实拖动 179 条断言、截图、归因及中途导出 | `tmp/motion-diagnostics/final-titlebar-5add0c4a2ece4cf78d7cac34662511c9`                     |
| 最终 Dock 46 条断言、快照与计量               | `tmp/motion-diagnostics/final-dock-runtime-electron-da4756d191ed44b5a93cfcbc1e600b8b`        |
| 最终 ABI22 原生层级 598 条断言与恢复现场      | `tmp/motion-diagnostics/final-native-leaf-runtime-electron-5e6273a6f4b04e4bbdee10446d02bc6d` |
| 本轮文件/当前 DLL 与 app 哈希、构建说明       | `tmp/motion-diagnostics/final-source-hashes.json`                                            |

最终三项 GUI 专项在同 ABI22 DLL 下串行直接调用 Electron，并使用独立受管理 profile、run token 和结果文件。它们未省略产品窗口初始化与原断言；直接调用未生成新的 app 构建复用证明，不能把这些结果当作允许无检查复用 out 的凭据。所有最终退出码为 0，`completed=true`、`cleanup=complete`、没有 skipped。

### 7.3 后续指定命令

从第一条起使用固定 Node，任何派生子进程也使用过滤后的 PATH：

```powershell
$motionNode = 'C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$env:PATH = [IO.Path]::GetDirectoryName($motionNode) + ';' + (($env:PATH -split ';' | Where-Object { $_ -notmatch 'Volta' }) -join ';')
& $motionNode node_modules/vitest/vitest.mjs run tests/window-motion-diagnostics.test.js tests/window-drag-diagnostics.test.js tests/window-drag-controller.test.js tests/dock-runtime.test.js tests/performance-diagnostics.test.js tests/native-runtime-gate.test.js tests/log-writer-client.test.js
& $motionNode scripts/run-test-entry.cjs focused --file tests/window-motion-diagnostics-native.mjs
& $motionNode scripts/run-test-entry.cjs window --file tests/titlebar-native-drag-electron.mjs --file tests/dock-runtime-electron.mjs --file tests/native-leaf-runtime-electron.mjs
```

最后一条的真实窗口测试只在可访问 Windows 桌面/用户缓存的环境执行，选择三个文件及其必要构建，不扩大为全量。默认 build-app 与 native build 不会运行 collector test；独立 collector wrapper 只显式构建 `window_motion_diagnostics_test` 目标，不建真实 HWND。

用户现场操作：设置 → 查看日志 → 开启深度排查（10 分钟）；分别复现拖动、贴边隐藏/显示，记录毛玻璃和层级组合、肉眼卡顿时刻；及时停止并导出。先排除缺失/时钟/覆盖，再用上面的阶段证据设计单变量 A/B/A/B。遇到 HWND 与视觉表现不一致，应另行采集 ETW/PresentMon/DWM/GPU 证据，当前日志不能单独证明显示合成根因。

未覆盖：全量回归、安装/发布验证、客户机器、高刷新率视觉呈现、弱机长期运行、多屏/DPI、远程桌面及系统休眠交错。诊断新增开销需要局部实测；未测不能宣称零开销。未收集到自然卡顿与单变量恢复证据前，拖动/贴边卡顿根因仍未确认。
