# BR-03 真实运动诊断开销专项指导

日期：2026-10-10。状态：先建立本指导，再新增专项代码；尚未构建或运行，不预填通过。

## 1. 要解决的问题

内测章程32要求比较真实应用日常与深度排查的运动成本。旧 `tests/logging-overhead-electron.mjs` 是自建 HTML、合成 wheel 和刷新 fixture，其有效参考数据保留，但不能替代生产主窗口、真实标题栏拖动、毛玻璃配对移动与贴边动画的比较。

新增 `tests/logging-motion-overhead-electron.mjs`，只修改测试与本指导。生产运动算法、日常/深度策略、采集器实现和 UI 均保持当前版本。登记、模式白名单和功能域由本批主代理统一接线；不要与其他子批同时写 manifest。

## 2. 固定环境与可达负载

- 使用 `out/main/index.js` 和实际主进程 chunk，真实 sandbox preload、renderer、SQLite、Windows 原生 DLL、毛玻璃 Overlay 和 Chromium/GPU，不能在测试中关闭 GPU。
- 使用结果生命周期创建的独立 profile。远程通知和资料上传关闭，首次须知已读；不读写正式资料，不改剪贴板、安装身份或开机自启。
- 同一列表主窗口，固定 Apple 标题栏、normal 层级、毛玻璃开启、direct 左边缘、窗口尺寸和同一个可用工作区。
- 建立60条短文本便签，这是单人可积累的轻量资料规模。实际 API 创建后用只读 SQLite 回读数目与 ID，并观察真实列表显示；运行中不继续增删资料。
- 六轮固定顺序：日常、深度、日常、深度、日常、深度。每轮先预热，再执行相同拖动和两次隐藏/显露。不把固定六轮样本当弱机长期或客户全环境保证。
- 屏幕/DPI/工作区在进入每轮时核对；实际 DPI 来自 Electron/Windows，不强制缩放或伪造多屏。需要左边缘可暴露和本应用前台；缺条件准确报告，不能跳过后计通过。

## 3. 真实运动输入与独立判据

### 3.1 标题栏

读取实际 `.app-titlebar-interaction-surface` 几何，验证命中。使用 Chromium `sendInputEvent(mouseDown/mouseMove/mouseUp)` 并用 `screen.dipToScreenPoint` 转换后 `SetCursorPos` 对齐真实光标，复用现有标题栏专项的可靠输入方式。旁路观察 trusted pointerdown/up，不能用派发 DOM PointerEvent 代替输入，也不能替换生产拖动函数。

移动按固定16ms节奏往返180 DIP；每步记录发送时间和真实 BrowserWindow bounds。不能每步等待窗口追上鼠标后才发下一步，那会掩盖慢路径并使两模式负载不同。终点须收敛，pointerup 后 Dock 悬挂状态须释放。注入输入属于受控自动化，不等于用户手动卡顿，也不读取 DWM 呈现帧。

### 3.2 贴边

把同一窗口设到真实工作区左边，真实鼠标移入内容后移到窗外；记录 document 的 trusted mouseenter/mouseleave。隐藏由原有 hover IPC、200ms防误触等待和200ms动画自行触发，测试不得调用 `dockCommands.hide/show` 或直接 invoke hover。

隐藏终点用真实窗口 bounds和轻量资源状态轮询判定，再读取一次完整 Dock snapshot，确认 `isDockHidden`、`mainAtHiddenTarget`、monitor存活和对应generation。鼠标移到工作区左边缘后由真实原生 monitor消息显露；终点确认窗口回到屏内、session/monitor清理。耗时包含既有200ms等待和轮询分辨率，不把总耗时说成纯动画耗时。

完整 native snapshot只在操作终点读取，避免测试逐帧快照产生额外采集。读取自身也有成本；该共同成本计入受控测量，清楚记录边界。

## 4. 计量区间与原始样本

每轮预热后通过实际导出入口freeze并flush，保存预热导出。获取文件与诊断状态基线；然后依次测量拖动、贴边和整轮。运动区间不导出、不调用系统诊断、不人工block，不人为暂停生产周期采集。

保存每步输入、实际窗口边界、hide/show时间、轮询次数、端点状态；保存两个阶段和整轮的资源原始端点。运动后的导出耗时单列，不能混入运动耗时再说是输入延迟。

CPU使用 `process.cpuUsage()` 主进程microseconds差分，以及 `app.getAppMetrics()` 累计CPU秒数差分。后一项必须按 `pid + creationTime`匹配，记录新增/退出进程、累计回退与缺字段。百分比是单逻辑核，不是整机CPU，不把GPU进程CPU说成GPU利用率；缺数据保持null，不伪零。

内存保存每进程 workingSet/private KiB、主进程 `process.memoryUsage()`字节和前后变化。只读文件库存保存 app/detail JSONL各文件字节、记录数和SHA256；记录采样后生产freeze/flush产生的尾批成本，明确日志量区间包含边界flush。JSONL解析错误、文件减少或意外轮转必须可见，不能只给正数。

每轮保存 `motion-overhead-samples.json`，并在完成后保存 `motion-overhead-comparison.json`：各模式3轮的中位数、范围、均值、深度减日常及比例；同时保留原始数据、顺序和配对差值。无约定预算，因此耗时/CPU/内存数字本身不是通过阈值。统计不证明因果，不虚构零开销。

## 5. 采集器状态、尾批和准确失败

每次开启深度后确认真实policy与主renderer producer的appliedEpoch，writer ready且无丢失、拒绝或写错误。每轮运动前后确认模式没有因成本/额度自行退回日常；若退回，记录reason并使该比较无效，不能将日常运行误记深度。

真实 native collector没有无副作用的lease查询口。测量中不直接drain抢走生产数据。深度状态来自生产日志的 native JSON `enabled`、generation、observations、coverage、stages，与实际policy联合记录；不是mock状态。

通过生产 `window.api.exportLogs`，仅受控保存对话框的目标，完整执行controller.freeze、renderer补交、main/native flush、Worker快照与JSONL导出。检查最终 `diagnostic-complete.complete`、窗口提交状态、writer/ring准确性；运动日志须包含对应capture的main、renderer、dock和native真实非空计量。保留freeze request ID与尾批记录，不能只查“有某scope”。

另作一次短活动拖动：在mouseUp之前导出，验证主/renderer/native未满周期尾批具有同一export截止身份。这次导出不纳入开销样本，并不替代正常结束的完整性验证。日常样本不能新增深度motion records。

停止深度后先走生产stop/freeze，再读取同一DLL `WindowMotion_DrainDiagnosticsJson`：保存完整原始JSON并确认 `enabled=false`。此时才直接drain，若出现残尾如实保存而不丢弃；不能在运动测量中调用、不能设置lease。停止后的日常运动不得新增motion记录。

生产导出complete只覆盖其声明的运输/存储完整性；native coverage丢样须单独记录。不能把二者合并称全采样完整，也不放宽coverage字段制造通过。环境启动失败和业务断言分别报告。

## 6. 完成、清理和恢复

使用 `createElectronGuiResultLifecycle`，受管理attempt唯一result、mode、business completion与正常quit。最终证据包含原始JSONL、文件库存、raw samples、比较统计、GUI证据和原生停止状态；发生失败也落盘已收集样本，不能只写预期结果。

任何异常均在finally释放鼠标按钮、移除旁路监听、恢复受控dialog和原光标；先停止深度、关闭Dock配置，使原有owner收尾，再由生命周期销毁本测试窗口并正常quit。runner删除自己拥有profile；直接运行保留profile与证据。不得终止正式应用、覆盖其他attempt或清理非本测试路径。

后续仅构建该真实app专项必要的app/native，然后经focused入口明确运行新文件。先静态语法/格式/登记校验，不自动跑全量；原synthetic参考专项保持原样。父代理负责实际运行，本子批没有执行测试或构建。

恢复只删除本批新增的测试与本指导，并同步撤销父代理相应mode/manifest/domain接线；不动旧开销资产、生产代码和既有脏修改。不能以回退删除运行失败证据。

## 7. 仍需测试群验证

自然拖动或贴边卡顿、DWM实际呈现、弱机长期负载、实际Windows10/11差异、真实双屏/混合DPI/拔屏和客户后台软件仍属现场任务。受控同机运动开销即使全部有效，也不能声称客户根因已找到或卡顿修复。
