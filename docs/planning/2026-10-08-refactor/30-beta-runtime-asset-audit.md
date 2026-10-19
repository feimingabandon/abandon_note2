# BR-02：57 项非 Vitest 资产静态审查与改写指导

本阶段只审阅测试源码、完整断言/业务等待与生产消费者，并提出具体改法。没有运行测试、构建或 GUI，没有修改生产实现、测试实现或 manifest。不能把本文视为 57 项测试通过，也不能据此宣布客户端已可发布。

范围固定来自 `tmp/beta-readiness/audit/static-review-first-batch.json` 的 `pending` 且 `runtime != vitest`：49 项 Electron、7 项 Qt、1 项 Node。已经 reviewed 的资产及 DB7 不重复审查。精确逐项底稿、完整断言调用、等待谓词、skip、清理/时序行号、源 hash 和消费者映射保存在 `tmp/beta-readiness/audit/runtime-static-review.json`。

所有决策只改变后续工作的指导：原 manifest 的 pending/reviewed 状态本轮不变。Qt 宏使用平衡括号提取，以保留 lambda 中的分号和嵌套表达式；QSKIP 与断言分开。静态调用位置数不是运行断言数，循环、数据行、分支和 helper 均会改变实际数量。

## 需要先落实的测试层问题

1. **Qt GUI 复制场景隔离。** `native_capture/tests/ui_test.cpp` 的 copy 分支调用生产写/读剪贴板，但 main 创建普通 QApplication，没有 `clipboard_test.cpp` 的独立 WindowStation/Desktop。运行会改变用户剪贴板。将该输出链放进 test-owned 隔离 station/desktop 子进程，并保留 CaptureEngine output 和像素断言；真实桌面捕获 case 仍单独运行。不要在失败后用覆盖用户剪贴板的方式假装恢复。
2. **真实重启表述。** `settings-scroll-memory` 和 `view-visibility-shortcut` 已有父 runner 顺序创建不同子进程、共享同一个 profile 的链。`ui-responsive` 的 restart 分支只靠 `UI_RESP_PROFILE/UI_RESP_RESTART`，本仓库没有自动双进程驱动；`almanac-weather` 的 reopening 分支亦依赖外部 profile。保留分支保护，但默认单次执行不能报“真重启通过”。若需要门槛，新增自管父 runner：第一次真实保存、等待完整退出、第二次相同 profile 不重 seed、记录两个 PID、读回 literal 预期。
3. **日报范围与导出区分。** `daily-report` 校验预览数量、TXT/Excel选择及日期面板，未实际点击导出、读取 TXT/XLSX 内容。先更正覆盖范围；真实导出保护需使用自有临时目录，走生产 export IPC/service，校验格式、所选行与内容，再清理文件。不得将现有 dialog pass 借用于“文件已验收”。
4. **Windows 通知探针失败清理。** `reminder-native-acceptance` 会注册自有 AppID/CLSID/protocol，当前 cleanup 主要在成功路径。后续将全部注册、子进程与通知放进 try/finally，失败保留日志/包取证仍须移除自有注册和通知。只清理本测试创建且核对过身份的资源，不动用户或其他应用。缺 rcedit、缓存或交互桌面是环境阻塞。
5. **缩略图行为与 benchmark 分离。** `thumbnail-benchmark` 的 4 个有效行为保护必须保留；100次 elapsed 只是测量。拆成相关改动的局部缓存测试与 opt-in benchmark，并增加 finally/owned profile 清理；没有性能阈值就不能报告客户性能合格。
6. **原生与 GPU 证据边界。** `window-control-drag` 明确 `disable-gpu`，验证直接 IPC 拖动事务和截图崩溃恢复，不能推断自然拖窗卡顿的 GPU 根因。窗口层级资产应同时保留独立 Win32 读口：主窗/Overlay band、相对 order、可见且相交的中间窗。仅被测同步API返回值不足以区分真实漂移与观测问题。

## 统一改写规则

改写顺序为先保存现有业务保护，再改 harness/映射，最后按相关功能运行。缺结果 adapter、cleanup 记录或环境依赖均不能直接定为业务失败，更不能据此删除测试。

- 每个 case 写明用户/后台/Windows事件的现实入口、独立 oracle 和模拟部分。单人软件不为理论瞬时无限操作增加业务复杂性；重复回调、请求迟到、进程退出及系统重排仍是可达生命周期场景。
- 接统一 recorder/lifecycle：记录 case 开始/断言/业务完成、实际退出码及 cleanup complete/failed/preserved。父子进程分别有完成证据，父 runner 必须等待自有 child 退出；没有业务 completion 的退出不借成通过。
- 必需的 Qt case QSKIP 是未覆盖；可选视觉样本导出 skip 不是业务失败。保存 junit/txt 的 case 名、skip原因和当前显示环境，不只检查 ctest/应用 exit 0。
- 所有 patch、IPC replacement、FileReader/fetch/geolocation、监听器、timer、快捷键预约和自有helper需在 finally 释放/恢复。cleanup失败单独记录，不覆盖原业务错误，也不抹成complete。删除/移动必须先验证最终绝对路径属于本次 owned profile。
- 从实际 Vue/生产消费者补叶sourceDeps；测试加载 `out/main` 或 UI fixture 不意味着只列启动文件或 helper 就能正确选择范围。新增映射先核对该 case 真正依赖，不把全部 index.js 或工作区原有 dirty 当默认全量依据。
- 把带业务要求的 until/waitUntil 谓词保留下来，或改为 recorder 的明确断言。`month-day-preview-status` 与 `month-event-text-color` 仅各有2个外层assert，但等待谓词保护了完整行为链，不能按数量判为无用。
- 动画验证按开始/中间/结束阶段和最终无残留节点，失败留下 frames 与实际时长。固定pause只作等待；截图artifact只有保存结果，未自动证明视觉审美。
- Qt DesktopLayout/geometryChanged fixture、powerMonitor.emit、display hooks、Chromium force-device-scale-factor/字体比例各标清模拟边界；不把它们称真实OS拔屏、混合DPI、休眠或锁屏。
- 大型月视图/窗口矩阵先增加case可选择入口和“至少选中一个case”保护；按领域建立有等价oracle的替代资产。替代已静态审查并运行验收后，才能删旧资产对应片段。当前没有整项资产可直接删除的证据。

## 逐项结论

| # | 资产 | 决策 | 业务保护与改写重点 |
| --- | --- | --- | --- |
| 1 | `native_capture/tests/clipboard_test.cpp` | 保留，适配结果 | 剪贴板 DIB/PNG、窗口关闭后数据、占用失败；保留隔离剪贴板设计及全部像素/占用断言 |
| 2 | `native_capture/tests/core_test.cpp` | 保留，适配结果 | 图像格式、几何、绘制、裁剪、undo/redo、内存限制；保留 literal oracle 与异常文件输入 |
| 3 | `native_capture/tests/pin_halo_test.cpp` | 保留，适配结果 | 贴图外围 Halo 原生几何、输入透传、层级、资源；保留原生 oracle |
| 4 | `native_capture/tests/polish_test.cpp` | 保留，拆 benchmark | 参数持久化、工具反馈、保存、绘制成本；保留真实子进程重载链 |
| 5 | `native_capture/tests/selection_test.cpp` | 保留，适配结果 | 选区几何、吸附、跨屏映射与贴图；保留逻辑多屏 fixture |
| 6 | `native_capture/tests/ui_test.cpp` | 先改隔离，保留行为 | 截图 UI、中文文本、输出、贴图预算、socket会话及桌面捕获；运行前隔离 copy 场景到独立 WindowStation/Desktop 的 test-owned 子进程 |
| 7 | `native_capture/tests/ux_test.cpp` | 保留，适配结果 | 标注 chrome、布局、键盘、输出视觉样本；保留布局和导出行为 |
| 8 | `tests/almanac-weather-electron.mjs` | 保留行为，改 harness/映射 | 宜忌/天气来源、缓存、隐藏退避和跨视图 UI；保留缓存/隐藏/跨视图业务 |
| 9 | `tests/attachment-loading-electron.mjs` | 保留行为，改 harness/映射 | 图片载入、预览、读取迟到与保存阻塞；保留迟到/加载保护 |
| 10 | `tests/attachment-storage-electron.mjs` | 保留 | 附件保存/删除、失败回滚及 staging 恢复；保留现有 recorder 资产 |
| 11 | `tests/blur-z-order-electron.mjs` | 保留行为，改 harness/映射 | 毛玻璃几何/层级同步与插入窗口；保留独立 Win32 主窗/Overlay比较 |
| 12 | `tests/calendar-font-electron.mjs` | 保留行为，改 harness/映射 | 月/周字大小与布局可容纳性；保留可读性/overflow保护 |
| 13 | `tests/daily-report-electron.mjs` | 保留行为，改 harness/映射 | 报表日期范围预览、TXT/Excel选择、动态日期面板；保留范围与日期面板保护 |
| 14 | `tests/dock-trigger-electron.mjs` | 保留行为，改 harness/映射 | 四边/触发模式、原生边缘监听、全屏避让与生命周期；保留native四边及资源generation保护 |
| 15 | `tests/draft-dialog-ui-electron.mjs` | 保留行为，改 harness/映射 | 未保存草稿退出/切换确认弹窗布局和遮挡；保留草稿确认真实业务入口 |
| 16 | `tests/first-use-notice-electron.mjs` | 保留行为，改 harness/映射 | 首次须知流程、支持页与设置持久化；保留既定首次流程和捐赠/统计产品策略 |
| 17 | `tests/help-center-electron.mjs` | 保留行为，改 harness/映射 | 帮助导航、查询、阅读位置和页面布局；保留真实帮助使用路径 |
| 18 | `tests/list-minimal-mode-electron.mjs` | 保留行为，改 harness/映射 | 极简便签、布局与跨页面状态；保留极简视觉/设置契约 |
| 19 | `tests/logging-actions-electron.mjs` | 保留，父任务负责 | 日志查看/导出、尾批flush、脱敏和force-destroy证据；保留现有规范lifecycle |
| 20 | `tests/main-view-enhancements-electron.mjs` | 保留行为，改 harness/映射 | 多视图增强、日期/天气呈现与工具栏；保留增强使用入口 |
| 21 | `tests/maturity-electron.mjs` | 保留行为，改 harness/映射 | 编辑退出/取消、草稿保护、后台写入冲突与生命周期；保留数据不覆盖/草稿保护 |
| 22 | `tests/maturity-regressions-electron.mjs` | 保留行为，改 harness/映射 | 未保存编辑/恢复和冲突回归；保留旧缺陷的外显行为保护 |
| 23 | `tests/month-context-menu-electron.mjs` | 保留行为，改 harness/映射 | 日期/便签菜单、新建/预览、完成/删除和日期计数；保留菜单到数据动作 |
| 24 | `tests/month-day-preview-status-electron.mjs` | 保留行为，改 harness/映射 | 全天预览完成动作与月历/按钮联动；保留所有业务wait predicate |
| 25 | `tests/month-event-text-color-electron.mjs` | 保留行为，改 harness/映射 | 日历横条/详情选区颜色保存与呈现；保留DB ranges+两个显示面独立对照 |
| 26 | `tests/month-view-electron.mjs` | 保留行为，改 harness/映射 | 月视图综合布局、导航、新建编辑、状态、设置与窗口组合；先保留所有行为 |
| 27 | `tests/note-draft-conflict-ui-electron.mjs` | 保留行为，改 harness/映射 | 有附件的编辑草稿冲突与恢复选项；保留不覆盖数据/附件草稿 |
| 28 | `tests/note-duration-electron.mjs` | 保留行为，改 harness/映射 | V0数据迁移、持续日期/直到完成、提醒唤醒不破坏草稿；保留迁移后真实GUI链和reveal草稿保护 |
| 29 | `tests/note-list-animation-electron.mjs` | 保留行为，改 harness/映射 | 列表进入/退出/反向动画、重复节点和清理；保留最终节点/动画清理 |
| 30 | `tests/note-list-completion-electron.mjs` | 保留行为，改 harness/映射 | 完成/重开分组排序与分页无重复；保留完成行为/分页ID独立oracle |
| 31 | `tests/note-list-toolbar-electron.mjs` | 保留行为，改 harness/映射 | 时间线/自定义/标签分组、inline面板及退出期间hover空间；保留当前工具栏产品契约及panelLeaving保护 |
| 32 | `tests/note-text-color-electron.mjs` | 保留行为，改 harness/映射 | 正文选区颜色与范围保存/清除；保留ranges数据与显示双oracle |
| 33 | `tests/notice-admin-electron.mjs` | 保留，可选工具专项 | 公告管理authoring/draft/publish及桌面预览；保留管理工具opt-in |
| 34 | `tests/notice-markdown-electron.mjs` | 保留行为，改 harness/映射 | 公告 Markdown、XSS、图片失败和浮层键盘/布局；保留XSS/HTTPS图片/keyboard保护 |
| 35 | `tests/quick-note-edit-electron.mjs` | 保留行为，改 harness/映射 | 快速编辑保存、空输入、冲突和丢焦关闭；保留错误/失焦/冲突后的草稿 |
| 36 | `tests/recurring-preview-electron.mjs` | 保留行为，改 harness/映射 | 循环模板预览与真实便签区分、日期面板可操作状态；保留预览不可当真实便签修改的契约 |
| 37 | `tests/reminder-native-acceptance.cjs` | 改清理，可选原生专项 | Windows通知显示、热/冷协议激活和独立身份注册；将注册/launch/运行包在try/finally有界ownedcleanup |
| 38 | `tests/reminders-electron.mjs` | 保留行为，改 harness/映射 | 提醒列表、稍后/完成、调度/托盘/非法sender及唤醒；保留真实popup/DB/授权和reveal |
| 39 | `tests/settings-scroll-memory-electron.mjs` | 保留行为，改 harness/映射 | 设置滚动/诊断折叠本次会话记忆、布局、search和浮层；保留真实双进程reset而非改为reload |
| 40 | `tests/template-quarterly-electron.mjs` | 保留行为，改 harness/映射 | 季度模板rule、预览、编辑、保存与相关设置；保留季度规则保存/预览与编辑行为 |
| 41 | `tests/thumbnail-benchmark-electron.mjs` | 保留行为，拆 benchmark | 缩略图尺寸、并发去重、文件变更失效、删除null及计时；保留4行为保护并拆为局部功能资产 |
| 42 | `tests/titlebar-icon-scale-electron.mjs` | 保留行为，改 harness/映射 | Apple/Fluent导航风格、白SVG与150%图标设置；保留Apple视觉和Windows风格设置 |
| 43 | `tests/ui-components-electron.mjs` | 保留行为，改 harness/映射 | 通用UI控件布局、键盘、焦点与状态；保留组件契约 |
| 44 | `tests/ui-feedback-app-electron.mjs` | 保留行为，改 harness/映射 | 真实应用状态反馈动画、遮挡与残留节点；保留反馈/最终清理 |
| 45 | `tests/ui-feedback-electron.mjs` | 保留行为，改 harness/映射 | UI反馈组件、进出动画和忙碌/错误/成功；保留独立组件反馈 |
| 46 | `tests/ui-responsive-electron.mjs` | 保留行为，改 harness/映射 | 共享UI比例、窄布局、标题命中和日历浮层；保留布局/missing controls防护 |
| 47 | `tests/view-visibility-shortcut-electron.mjs` | 保留行为，改 harness/映射 | 快捷键录制、禁用会话、冲突/retry、托盘、跨视图和重启恢复；保留真实child restart与会话禁用契约 |
| 48 | `tests/wallpaper-storage-electron.mjs` | 保留 | 壁纸源去重、保存/删除事务、staging恢复及隐私计量；保留规范recorder/storage保护 |
| 49 | `tests/weather-settings-electron.mjs` | 保留行为，改 harness/映射 | 地区选择滚动/布局、首次启用、设备位置失败与网络粗定位；保留底部向上展开/省市切换清滚动及一次保存保护 |
| 50 | `tests/week-day-panel-electron.mjs` | 保留行为，改 harness/映射 | 周日期菜单、预览、快速新建和显式日期列表开关；保留周视图明确panel契约 |
| 51 | `tests/week-view-electron.mjs` | 保留行为，改 harness/映射 | 周导航、继承月视图几何/设置、日期选择及动画；保留月份/周各自panel设置与初次继承差别 |
| 52 | `tests/window-border-electron.mjs` | 保留行为，改 harness/映射 | 窗口边框默认关闭/开启持久化/跨视图样式；保留默认/开关样式 |
| 53 | `tests/window-control-drag-electron.mjs` | 保留行为，改 harness/映射 | 层级切换锁/解锁后拖动事务及12截图崩溃组合恢复；保留锁/解锁位置和helper崩溃生命期 |
| 54 | `tests/window-frame-electron.mjs` | 保留行为，改 harness/映射 | 透明frameless style与四边移动的尺寸不漂移；保留四边尺寸不变量 |
| 55 | `tests/window-state-matrix-electron.mjs` | 保留行为，改 harness/映射 | 贴边/层级/锁/视图/缩略/截图和系统事件组合；保留window组合真实状态 |
| 56 | `tests/window-z-order-electron.mjs` | 保留行为，改 harness/映射 | 真实置底锚定、overlay和无关reorder事件过滤；保留独立相对order与desktop位于main下面的oracle |
| 57 | `tests/window-z-order-recovery-electron.mjs` | 保留行为，改 harness/映射 | 层级瞬时/永久失效、show重入、同mode重应用和blur同步；保留失败不得持久化/同moderepair/重入保护 |

## 每项后续实施指导

### 1. native_capture/tests/clipboard_test.cpp

保护：剪贴板 DIB/PNG、窗口关闭后数据、占用失败。静态显式断言位置 20；另提取业务等待调用 0；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：Win32 剪贴板格式与读回像素；销毁 HWND 后仍可读；另线程占用时 false。
- 真实入口：直接生产 DesktopCapture 写/读图；真实 Windows 剪贴板和独立线程。
- 模拟边界：独立 WindowStation/Desktop 隔离，不是当前用户桌面；不验证第三方应用粘贴。
- 时钟/重启：真实 HWND 销毁/线程占用；没有应用主进程重启。
- 清理证据：独立 station/desktop 及 RAII 释放；还需结果记录证明释放与测试完成。
- 生产消费者：`native_capture/platform/windows/DesktopCapture.cpp`。
- 后续改法：1) 保留隔离剪贴板设计及全部像素/占用断言；2) 适配 Qt junit 的 case 和 exit/cleanup，不将缺结果适配算业务失败。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 2. native_capture/tests/core_test.cpp

保护：图像格式、几何、绘制、裁剪、undo/redo、内存限制。静态显式断言位置 46；另提取业务等待调用 0；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literal QRect/size/像素与文件格式；裁剪同实现比较只作 metamorphic 补充。
- 真实入口：生产 ImageDocument、readImage/saveImage、boundedSelection 等函数。
- 模拟边界：QImage 合成/临时文件，无真实屏幕与 GUI；大尺寸用于拒绝输入而非用户高频操作。
- 时钟/重启：无 GUI 时序及重启；不宣称截图桌面能力。
- 清理证据：QTemporaryDir/值对象局部资源；需统一 Qt 完成结果。
- 生产消费者：`native_capture/engine/ImageDocument.cpp`。
- 后续改法：1) 保留 literal oracle 与异常文件输入；2) 同实现 render/copy 不单独算独立保护；3) Qt case/skipped 单独记录。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 3. native_capture/tests/pin_halo_test.cpp

保护：贴图外围 Halo 原生几何、输入透传、层级、资源。静态显式断言位置 55；另提取业务等待调用 0；Qt skip 1。这些是源码位置，不是运行结果。

- 独立 oracle：Win32 rect/style/owner/hit test/GDI 计数与采样像素。
- 真实入口：生产 PinWindow/PinHalo + 真 HWND、用户桌面表面。
- 模拟边界：截图 artifact 不等于人眼视觉合格；锁桌面时 QSKIP；仅现有 OS 显示配置。
- 时钟/重启：QTRY/qWait 等待原生更新；GDI 回收循环为生命周期保护，非客户帧率证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`native_capture/engine/PinHalo.cpp`、`native_capture/engine/PinWindow.cpp`、`native_capture/engine/CaptureAppearance.cpp`。
- 后续改法：1) 保留原生 oracle；2) 每 case 记录 QSKIP 原因和显示环境；3) 将视觉导出与必需业务通过分开。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 4. native_capture/tests/polish_test.cpp

保护：参数持久化、工具反馈、保存、绘制成本。静态显式断言位置 73；另提取业务等待调用 0；Qt skip 1。这些是源码位置，不是运行结果。

- 独立 oracle：真实 QSettings 文件及子进程重载值；文件像素/焦点/提示状态。
- 真实入口：生产 AnnotationEditor/CaptureFeedback/SaveActions/CaptureEngine。
- 模拟边界：部分画布 fixture；4K elapsed 是本机 benchmark；native feedback 锁桌面可 skip。
- 时钟/重启：QProcess 子进程重载 QSettings 确是真进程验证；并非整个 Electron 应用重启。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`native_capture/engine/AnnotationEditor.cpp`、`native_capture/engine/CaptureFeedback.cpp`、`native_capture/engine/SaveActions.cpp`、`native_capture/engine/CaptureEngine.cpp`。
- 后续改法：1) 保留真实子进程重载链；2) 计时 benchmark 独立为可选资产，不以本机阈值断言所有机器流畅；3) skip 独立报告。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 5. native_capture/tests/selection_test.cpp

保护：选区几何、吸附、跨屏映射与贴图。静态显式断言位置 73；另提取业务等待调用 0；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literal 桌面/坐标 fixture、真实 HWND physical rect、控件识别。
- 真实入口：生产 CaptureOverlay/DesktopLayout/SelectionSnap/PinWindow。
- 模拟边界：两个 monitor/DPI2 是 DesktopLayout fixture；OS 本机仍为现有屏幕；不能称真实混合 DPI。
- 时钟/重启：合成 Qt 指针/键与部分真实 Win32 位置读取；无真实 OS 拓扑切换。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`native_capture/engine/CaptureOverlay.cpp`、`native_capture/engine/DesktopLayout.cpp`、`native_capture/engine/SelectionSnap.cpp`、`native_capture/engine/PinWindow.cpp`。
- 后续改法：1) 保留逻辑多屏 fixture；2) metadata 明确虚拟拓扑/真实 HWND；3) 另列真实拔屏和混合 DPI 的客户内测缺口。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 6. native_capture/tests/ui_test.cpp

保护：截图 UI、中文文本、输出、贴图预算、socket会话及桌面捕获。静态显式断言位置 209；另提取业务等待调用 0；Qt skip 1。这些是源码位置，不是运行结果。

- 独立 oracle：文件 PNG 像素、literal UI 状态/容量、QLocalSocket 消息、真实窗口/desktop capture。
- 真实入口：生产 CaptureEngine/AnnotationEditor/CaptureOverlay/PinWindow/SaveActions。
- 模拟边界：geometryChanged 为 invokeMethod 注入；锁桌面 QSKIP；复制场景当前写普通用户剪贴板。
- 时钟/重启：QTRY 真实等待；拓扑改变通过 Qt invokeMethod 注入，非真拔屏。
- 清理证据：场景有 qScopeGuard/QTemporaryDir/pin销毁；main 普通 QApplication 无 station 隔离，copy 会改变用户剪贴板。
- 生产消费者：`native_capture/engine/CaptureEngine.cpp`、`native_capture/engine/AnnotationEditor.cpp`、`native_capture/engine/CaptureOverlay.cpp`、`native_capture/engine/PinWindow.cpp`、`native_capture/engine/SaveActions.cpp`。
- 后续改法：1) 运行前隔离 copy 场景到独立 WindowStation/Desktop 的 test-owned 子进程；2) 保留 CaptureEngine 输出链与像素保护；3) 将用户桌面 capture 与隔离剪贴板 case 分开执行；4) 明确 socket 同进程/本地通信边界；5) skip 不计 passed。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 7. native_capture/tests/ux_test.cpp

保护：标注 chrome、布局、键盘、输出视觉样本。静态显式断言位置 53；另提取业务等待调用 0；Qt skip 1。这些是源码位置，不是运行结果。

- 独立 oracle：literal widget 布局/状态、合成图像/导出；视觉 PNG 仅待查看证据。
- 真实入口：生产 AnnotationEditor/CaptureAppearance/ImageDocument，CTest offscreen。
- 模拟边界：offscreen 不证明 Windows 桌面/输入；CAPTURE_UX_EVIDENCE 未设时可选样本 QSKIP。
- 时钟/重启：合成 Qt events；无应用重启、DWM 或真实多屏验证。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`native_capture/engine/AnnotationEditor.cpp`、`native_capture/engine/CaptureAppearance.cpp`、`native_capture/engine/ImageDocument.cpp`。
- 后续改法：1) 保留布局和导出行为；2) optional evidence skip 与 required cases 分开；3) 不将 offscreen 归为原生桌面验收。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 8. tests/almanac-weather-electron.mjs

保护：宜忌/天气来源、缓存、隐藏退避和跨视图 UI。静态显式断言位置 56；另提取业务等待调用 67；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：UI literal 文本/日期、请求次数、缓存内容与隐藏后是否继续请求。
- 真实入口：真实应用 Vue/SQLite；生产 WeatherService + 实际 weather registrar。
- 模拟边界：fetchImpl 返回 fixture、控制 now；reopening 依赖外部 profile；未自动驱动双进程。
- 时钟/重启：now 推进验证缓存调度；Date.now 在 provider 数据时间仍是真时钟；profile reopening 没有仓库自动双进程驱动证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/almanac/DateContextSummary.vue`、`src/renderer/src/components/almanac/DateContextPopover.vue`、`src/renderer/src/components/list/NoteList.vue`、`src/renderer/src/components/month/MonthWorkspace.vue`、`src/main/services/weather-service.js`、`src/main/ipc/register-weather-ipc.js`、`src/main/services/weather-refresh-controller.js`。
- 后续改法：1) 保留缓存/隐藏/跨视图业务；2) 补实际 Vue/sourceDeps；3) 恢复测试安装的 handlers 和监听器；4) 若声称 restart 增加自管同 profile 双进程驱动，否则改为 persisted-profile reopen 分支。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 9. tests/attachment-loading-electron.mjs

保护：图片载入、预览、读取迟到与保存阻塞。静态显式断言位置 17；另提取业务等待调用 33；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：DOM loading/disabled + literal 数量/草稿状态及保存后附件。
- 真实入口：用户文件选择/真实 ImagePicker/NoteEditor；真实 preload IPC被受控延后。
- 模拟边界：hold IPC 和 FileReader prototype 模拟慢读取，不是磁盘设备吞吐。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/note/ImagePicker.vue`、`src/renderer/src/components/note/NoteEditor.vue`、`src/renderer/src/components/note/NoteImagePreview.vue`。
- 后续改法：1) 保留迟到/加载保护；2) 在 finally 恢复 FileReader/IPC patch、监听器与测试 profile；3) 补 recorder 业务完成和清理证据。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 10. tests/attachment-storage-electron.mjs

保护：附件保存/删除、失败回滚及 staging 恢复。静态显式断言位置 30；另提取业务等待调用 0；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：真实 SQLite 行数/引用与真实磁盘文件存在/内容；recorder 30静态断言位置。
- 真实入口：生产 db-images/db-schema，隔离 profile 和真实 filesystem。
- 模拟边界：故障注入后重入恢复是恢复函数验证，未 kill 后冷启动。
- 时钟/重启：受控文件故障+恢复函数重入，无真实进程崩溃重启。
- 清理证据：已有 recorder finally、profile cleanup failed/preserved/complete；保留错误或取证目录的真实状态。
- 生产消费者：`src/main/db/db-images.js`、`src/main/db/db-schema.js`、`src/main/db/db.js`、`src/main/db/attachment-recovery.js`。
- 后续改法：1) 保留现有 recorder 资产；2) 只补缺失叶sourceDeps和明确故障/冷启动边界；3) 不因 DB7 接近就删实际文件保护。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 11. tests/blur-z-order-electron.mjs

保护：毛玻璃几何/层级同步与插入窗口。静态显式断言位置 20；另提取业务等待调用 6；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：真实 GetWindowRect 主窗/Overlay 与 interloper；同步API仅辅助健康指标。
- 真实入口：独立 Electron HWND + koffi 真实 blur_engine DLL/Win32。
- 模拟边界：与 app menu 的层级事务不同；某恢复允许显式同步，不能说纯自动修复全已证明。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`native_blur/blur_engine.cpp`、`native_blur/window_z_order.cpp`。
- 后续改法：1) 保留独立 Win32 主窗/Overlay比较；2) 把自动恢复与显式 repair 拆开命名；3) cleanup关闭自有 HWND与卸载/释放 DLL；4) 不从本地通过推断客户偶发根因。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 12. tests/calendar-font-electron.mjs

保护：月/周字大小与布局可容纳性。静态显式断言位置 5；另提取业务等待调用 4；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：computed font/scrollOverflow/DOM bounding rect 与设定值。
- 真实入口：真实应用 settings + month/week Vue。
- 模拟边界：字体设置/窗口尺寸不等于 OS DPI 或多屏。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/month/MonthWorkspace.vue`、`src/renderer/src/components/month/MonthCalendarGrid.vue`、`src/renderer/src/components/system/SettingsPanel.vue`。
- 后续改法：1) 保留可读性/overflow保护；2) 补当前消费者sourceDeps；3) 给wait/动画诊断和cleanup结果；4) 明确布局缩放边界。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 13. tests/daily-report-electron.mjs

保护：报表日期范围预览、TXT/Excel选择、动态日期面板。静态显式断言位置 7；另提取业务等待调用 19；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：1/2条预览、两个日期控件、格式标签、五/六行布局和键盘helper。
- 真实入口：真实 DailyReportDialog + 日期选择器 + DB/preload查询。
- 模拟边界：未实际点击导出按钮或核对TXT/XLSX文件。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：app.quit/quit 事件移除自有profile，catch明确Crashpad占用但当前无统一cleanup结果。
- 生产消费者：`src/renderer/src/components/report/DailyReportDialog.vue`、`src/renderer/src/components/ui/DatePicker.vue`、`src/main/services/daily-report.js`、`src/main/ipc/register-daily-report-ipc.js`。
- 后续改法：1) 保留范围与日期面板保护；2) 将当前名称/metadata限于 dialog preview；3) 若内测门槛需GUI真实导出，新增临时文件入口与TXT/XLSX内容oracle，不伪报此资产覆盖；4) quit清理失败需记录。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 14. tests/dock-trigger-electron.mjs

保护：四边/触发模式、原生边缘监听、全屏避让与生命周期。静态显式断言位置 138；另提取业务等待调用 43；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：真实 native physical rect、SetCursorPos/input、generation/monitor状态与自有fullscreen窗。
- 真实入口：独立 Electron native edge monitor + DLL + 自有fullscreen子进程。
- 模拟边界：部分直接调用 native callback/hooks；单机循环证明生命期，非客户贴边卡顿原因。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/main/window-motion/native-edge-monitor.js`、`src/main/window-motion/dock-runtime.js`、`native_blur/window_motion_edge_monitor.cpp`、`native_blur/window_motion_diagnostics.cpp`。
- 后续改法：1) 保留native四边及资源generation保护；2) 分组入口使局部改动只选择对应case；3) finally恢复原鼠标并结束自有fullscreen/helper；4) 真实事件和直接调用分别记录；5) 不得把卡顿已解决写为结论。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 15. tests/draft-dialog-ui-electron.mjs

保护：未保存草稿退出/切换确认弹窗布局和遮挡。静态显式断言位置 8；另提取业务等待调用 14；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literal文案、modal边界/inert/焦点与视口几何。
- 真实入口：真实应用编辑草稿->main guard->EditingDraftDialog。
- 模拟边界：DOM click/脚本文本输入而非物理键盘；截图artifact不是独立视觉验收。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/system/EditingDraftDialog.vue`、`src/renderer/src/components/ui/ConfirmDialog.vue`、`src/main/windows/editing-draft-guard.js`。
- 后续改法：1) 保留草稿确认真实业务入口；2) 补guard和dialog deps；3) 加入统一结果/清理；4) 动画等待用阶段谓词并保留失败截图。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 16. tests/first-use-notice-electron.mjs

保护：首次须知流程、支持页与设置持久化。静态显式断言位置 19；另提取业务等待调用 6；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literal步骤、滚动/布局、保存noticeVersion及流程结束。
- 真实入口：真实 FirstUseNoticeDialog/应用状态。
- 模拟边界：预设DB控制首次状态；无真实支付/外部捐赠操作。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/system/FirstUseNoticeDialog.vue`、`src/renderer/src/composables/useWorkspaceNotices.js`。
- 后续改法：1) 保留既定首次流程和捐赠/统计产品策略；2) case结果分步；3) 恢复profile并记录cleanup；4) 不因Mac视觉误删Apple界面保护。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 17. tests/help-center-electron.mjs

保护：帮助导航、查询、阅读位置和页面布局。静态显式断言位置 17；另提取业务等待调用 11；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literal标签/命中项、scrollTop和键盘/焦点的可观察结果。
- 真实入口：真实应用 HelpPage/helper数据和组件。
- 模拟边界：阅读位置主要同renderer生命周期，不能自动声称整个app重启记忆。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/help/HelpPage.vue`、`src/renderer/src/components/help/help-search.js`、`src/renderer/src/components/help/help-quick-links.js`。
- 后续改法：1) 保留真实帮助使用路径；2) 将fixture标签变动和业务失败区分；3) 消费者/cleanup适配；4) 滚动等待阶段化。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 18. tests/list-minimal-mode-electron.mjs

保护：极简便签、布局与跨页面状态。静态显式断言位置 9；另提取业务等待调用 25；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：DOM visible内容/尺寸、设置snapshot和DB状态。
- 真实入口：真实SettingsPanel->NoteList/NoteCard。
- 模拟边界：数据预seed；不是大数据吞吐/多用户场景。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/list/NoteList.vue`、`src/renderer/src/components/list/NoteCard.vue`、`src/renderer/src/components/system/SettingsPanel.vue`。
- 后续改法：1) 保留极简视觉/设置契约；2) 补sourceDeps；3) 按实际模式变化的case运行；4) 统一结果与自有profile清理。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 19. tests/logging-actions-electron.mjs

保护：日志查看/导出、尾批flush、脱敏和force-destroy证据。静态显式断言位置 50；另提取业务等待调用 28；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：真实应用日志文件/JSON脱敏内容与writer状态、业务complete/partial。
- 真实入口：生产日志UI + main logging，当前已接 electron-gui-result-lifecycle。
- 模拟边界：force-destroy专门产生partial；不能因为退出码0或窗口消失就认为full completion。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：规范 GUI lifecycle 已在当前源码；具体通过/cleanup状态由父任务运行证据决定。
- 生产消费者：`src/renderer/src/components/system/LogViewerDialog.vue`、`src/renderer/src/components/system/SettingsPanel.vue`、`src/main/logging/logger.js`、`src/main/logging/diagnostic-controller.js`。
- 后续改法：1) 保留现有规范lifecycle；2) 父任务负责修改/运行，此批不改；3) 底稿保留审查初/现hash；4) 按business completion和cleanup判定结果。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 20. tests/main-view-enhancements-electron.mjs

保护：多视图增强、日期/天气呈现与工具栏。静态显式断言位置 27；另提取业务等待调用 13；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literal DOM文案/布局与当前数据对应关系。
- 真实入口：真实 NoteList/MonthWorkspace/DateContext组件。
- 模拟边界：共享calendar/weather函数作为expected时需literal补充；不是OS显示验证。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/list/NoteList.vue`、`src/renderer/src/components/month/MonthWorkspace.vue`、`src/renderer/src/components/almanac/DateContextSummary.vue`。
- 后续改法：1) 保留增强使用入口；2) expected不只调用生产同规则，保留literal日期/文案；3) 补真实组件deps；4) 结果/cleanup适配。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 21. tests/maturity-electron.mjs

保护：编辑退出/取消、草稿保护、后台写入冲突与生命周期。静态显式断言位置 16；另提取业务等待调用 38；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：DB内容/版本与UI草稿保留、确认/取消的literal结果。
- 真实入口：真实editor->preload->repository及main editing guard。
- 模拟边界：concurrent body为测试IPC模拟外部/后台写；非多用户服务器并发。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/note/NoteEditor.vue`、`src/renderer/src/components/note/QuickNoteContentEditor.vue`、`src/renderer/src/composables/useDraftProtection.js`、`src/main/windows/editing-draft-guard.js`。
- 后续改法：1) 保留数据不覆盖/草稿保护；2) 每个冲突注明后台或另一个自有窗口的可达触发；3) ownedkeys清理；4) mega场景按行为拆分后再考虑替代删除。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 22. tests/maturity-regressions-electron.mjs

保护：未保存编辑/恢复和冲突回归。静态显式断言位置 10；另提取业务等待调用 16；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：UI草稿、确认操作和DB最终文字，literal预期。
- 真实入口：真实应用editor及editing guard。
- 模拟边界：部分直接IPC及localStorage操作；reload不等于main重启。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/note/NoteEditor.vue`、`src/renderer/src/components/note/QuickNoteContentEditor.vue`、`src/renderer/src/composables/useDraftProtection.js`、`src/main/windows/editing-draft-guard.js`。
- 后续改法：1) 保留旧缺陷的外显行为保护；2) 与maturity逐case等价比对后才可移除重复；3) 禁止先删；4) record completion/cleanup。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 23. tests/month-context-menu-electron.mjs

保护：日期/便签菜单、新建/预览、完成/删除和日期计数。静态显式断言位置 21；另提取业务等待调用 34；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literal菜单项与不同业务动作后DOM/DB的数量和状态。
- 真实入口：真实月历右键处理链->MonthWorkspace/menu/preload。
- 模拟边界：DOM dispatched context event/seed；真实处理链但非所有Windows物理输入。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/month/MonthWorkspace.vue`、`src/renderer/src/components/month/MonthCalendarGrid.vue`、`src/renderer/src/components/month/MonthDayPanel.vue`。
- 后续改法：1) 保留菜单到数据动作；2) 共同helper不能把日期计数oracle简化为同owner计算；3) 补leaf deps、recorder和cleanup。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 24. tests/month-day-preview-status-electron.mjs

保护：全天预览完成动作与月历/按钮联动。静态显式断言位置 2；另提取业务等待调用 7；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：等待谓词校验日期菜单->预览->完成->月历样式/按钮同步；不是仅2外层assert。
- 真实入口：真实MonthCalendarGrid/day preview/MonthWorkspace及保存。
- 模拟边界：DOM synthetic click；无真实物理鼠标；deadline谓词也是真实业务保护。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/month/MonthWorkspace.vue`、`src/renderer/src/components/month/MonthCalendarGrid.vue`、`src/renderer/src/components/month/MonthDayPanel.vue`。
- 后续改法：1) 保留所有业务wait predicate；2) 在recorder明确拆成scenario/断言而非靠assert计数删测试；3) 补deps与cleanup。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 25. tests/month-event-text-color-electron.mjs

保护：日历横条/详情选区颜色保存与呈现。静态显式断言位置 2；另提取业务等待调用 8；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：等待谓词核对DB color ranges和详情/横条CSS；2外层assert不代表只有2业务检查。
- 真实入口：真实MonthEventBar选区->NoteTextColorPopover->preload/DB。
- 模拟边界：selection/DOM事件注入；没有物理拖选与真实多DPI。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/month/MonthEventBar.vue`、`src/renderer/src/components/note/NoteTextColorPopover.vue`、`src/renderer/src/utils/textSelection.js`。
- 后续改法：1) 保留DB ranges+两个显示面独立对照；2) 显式记录waiting断言；3) 补deps和profile清理。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 26. tests/month-view-electron.mjs

保护：月视图综合布局、导航、新建编辑、状态、设置与窗口组合。静态显式断言位置 184；另提取业务等待调用 100；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literal日期/菜单/DOM/DB与部分Win32/style几何；184静态assert + 100wait调用位置。
- 真实入口：真实应用月历/编辑器/设置/main/native。
- 模拟边界：显示拓扑通过测试调用注入；renderer reload记忆不等于apprestart；单个mega资产宽于多数改动。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/month/MonthWorkspace.vue`、`src/renderer/src/components/month/MonthCalendarGrid.vue`、`src/renderer/src/components/month/MonthCalendarToolbar.vue`、`src/renderer/src/composables/useCalendarWorkspaceModel.js`、`src/main/windows/main-view-navigation.js`、`src/main/windows/main-window-host.js`。
- 后续改法：1) 先保留所有行为；2) 按导航/编辑/设置/窗口分别形成可选择case；3) 建立逐case替代oracle才删旧mega对应片段；4) metadata区分mock topology与real native；5) 不默认全量。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 27. tests/note-draft-conflict-ui-electron.mjs

保护：有附件的编辑草稿冲突与恢复选项。静态显式断言位置 4；另提取业务等待调用 7；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：真实DB冲突版本、UI保留草稿/错误及可操作恢复。
- 真实入口：NoteEditor saveNoteDraft真实preload/repository。
- 模拟边界：测试直接IPC制造版本变化；后台/另一编辑入口可达，非无穷并发。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/note/NoteEditor.vue`、`src/renderer/src/composables/useDraftProtection.js`、`src/renderer/src/components/note/ImagePicker.vue`。
- 后续改法：1) 保留不覆盖数据/附件草稿；2) 来源变化的fixture明确现实入口；3) 使每wait/action记录case结果；4) 补cleanup。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 28. tests/note-duration-electron.mjs

保护：V0数据迁移、持续日期/直到完成、提醒唤醒不破坏草稿。静态显式断言位置 18；另提取业务等待调用 33；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：迁移backup/关系与literal duration状态、日历范围和草稿不变。
- 真实入口：真实应用旧DB初始化->GUI编辑/列表日历->notification reveal。
- 模拟边界：老DBseed/协议调用；不证明真人点击系统toast；DB7有相近底层保护但GUI链不同。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/note/NoteEditor.vue`、`src/renderer/src/components/month/MonthWorkspace.vue`、`src/renderer/src/components/list/NoteList.vue`、`src/main/services/notification-activation.js`、`src/main/db/db-schema.js`。
- 后续改法：1) 保留迁移后真实GUI链和reveal草稿保护；2) 重叠仅候选逐case等价后替代，不能直接删；3) 明确系统通知模拟；4) 补result/cleanup。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 29. tests/note-list-animation-electron.mjs

保护：列表进入/退出/反向动画、重复节点和清理。静态显式断言位置 20；另提取业务等待调用 8；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：WAAPI frames/playState、DOM重复/clones数量和最终清理。
- 真实入口：真实NoteList和useNotePresenceMotion。
- 模拟边界：采样/延后动画是fixture；不证明自然窗口拖动帧率。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/list/NoteList.vue`、`src/renderer/src/composables/useNotePresenceMotion.js`。
- 后续改法：1) 保留最终节点/动画清理；2) 等待阶段条件代替盲目时点，失败保存frames；3) 记录跑机实际时序；4) 不列为拖窗卡顿已修复。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 30. tests/note-list-completion-electron.mjs

保护：完成/重开分组排序与分页无重复。静态显式断言位置 12；另提取业务等待调用 7；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：41项seed后的literal顺序/ID去重、状态/分组变化。
- 真实入口：真实NoteList状态按钮->DB + timeline/tag分页模型。
- 模拟边界：seed正常数量；并发请求/后台change不等于多用户并发一致性。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/list/NoteList.vue`、`src/renderer/src/composables/useTimelineListModel.js`、`src/renderer/src/composables/useTagGroupListModel.js`。
- 后续改法：1) 保留完成行为/分页ID独立oracle；2) 只做单人正常操作和可达后台更新；3) 补model deps与result/cleanup。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 31. tests/note-list-toolbar-electron.mjs

保护：时间线/自定义/标签分组、inline面板及退出期间hover空间。静态显式断言位置 22；另提取业务等待调用 8；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literal标签、hover和面板exit前后DOM/几何/焦点。
- 真实入口：真实FilterTabs/NoteList工具栏交互。
- 模拟边界：鼠标/DOM输入方式按源码记录；不能证明物理设备/全部刷新率。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/ui/FilterTabs.vue`、`src/renderer/src/components/list/NoteList.vue`。
- 后续改法：1) 保留当前工具栏产品契约及panelLeaving保护；2) 补两组件deps；3) 等待动画完成并保留阶段断言；4) cleanup结果适配。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 32. tests/note-text-color-electron.mjs

保护：正文选区颜色与范围保存/清除。静态显式断言位置 10；另提取业务等待调用 17；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literal ranges/文本CSS/DB保存与清除。
- 真实入口：真实NoteCard/NoteTextColorPopover、preload和DB。
- 模拟边界：脚本选区/事件；不是Windows物理拖选。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/list/NoteCard.vue`、`src/renderer/src/components/note/NoteTextColorPopover.vue`、`src/renderer/src/utils/textSelection.js`。
- 后续改法：1) 保留ranges数据与显示双oracle；2) 用实际消费者映射；3) cleanup和显式业务case适配。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 33. tests/notice-admin-electron.mjs

保护：公告管理authoring/draft/publish及桌面预览。静态显式断言位置 16；另提取业务等待调用 21；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：本地隔离Python/backend/admin-web实际接口和DOM结果。
- 真实入口：自有localhost backend/preview子进程和管理UI。
- 模拟边界：只在localhost发布fixture；不涉及正式公告；非客户端日常功能门槛。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：需统一收口自有Python/preview/server监听/临时目录；不终止无关进程。
- 生产消费者：`src/renderer/src/components/markdown/notice-markdown.js`。
- 后续改法：1) 保留管理工具opt-in；2) 关闭自有server/browser且结果记cleanup；3) client beta不因无tooling环境默认阻塞；4) 不误称完整生产服务验收。
- 适用门槛：不适用默认客户端内测门槛；公告管理工具改动时专项运行。

### 34. tests/notice-markdown-electron.mjs

保护：公告 Markdown、XSS、图片失败和浮层键盘/布局。静态显式断言位置 13；另提取业务等待调用 9；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literal被转义内容/安全link属性与布局/滚动/错误占位。
- 真实入口：真实notice-markdown和fixture组件，本地HTTP预览。
- 模拟边界：fixture渲染器不等于完整app远程公告拉取；网络失败受控。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/markdown/notice-markdown.js`、`src/renderer/src/components/markdown/notice-markdown.css`、`src/renderer/src/components/system/RemoteNoticeDialog.vue`。
- 后续改法：1) 保留XSS/HTTPS图片/keyboard保护；2) 补组件和CSS映射；3) 关闭fixture server与自有窗；4) 不要把无远程服务当测试失败。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 35. tests/quick-note-edit-electron.mjs

保护：快速编辑保存、空输入、冲突和丢焦关闭。静态显式断言位置 12；另提取业务等待调用 18；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：DB最终正文/备注与UI草稿/错误/关闭的literal结果。
- 真实入口：真实QuickNoteContentEditor->updateNote version check。
- 模拟边界：模拟慢promise和直接背景IPC；不是无限用户操作。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/note/QuickNoteContentEditor.vue`、`src/renderer/src/composables/useDraftProtection.js`。
- 后续改法：1) 保留错误/失焦/冲突后的草稿；2) 恢复所有hold和监听；3) 映射真实composable；4) 业务与cleanup双结果。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 36. tests/recurring-preview-electron.mjs

保护：循环模板预览与真实便签区分、日期面板可操作状态。静态显式断言位置 10；另提取业务等待调用 10；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literal预览kind、真实ID/计数/disabled状态和UI动作。
- 真实入口：真实calendar data与MonthWorkspace/MonthEventBar。
- 模拟边界：DBseed循环规则；不是实际等数月观察调度。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/month/MonthWorkspace.vue`、`src/renderer/src/components/month/MonthEventBar.vue`、`src/main/calendar/calendar-service.js`、`src/main/calendar/recurring-note-preview.js`、`src/main/db/db-templates.js`、`src/main/services/recurrence-rules.js`。
- 后续改法：1) 保留预览不可当真实便签修改的契约；2) 核对实际循环生成生产deps；3) 测试时钟与日期样本明确；4) 补结果/cleanup。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 37. tests/reminder-native-acceptance.cjs

保护：Windows通知显示、热/冷协议激活和独立身份注册。静态显式断言位置 5；另提取业务等待调用 4；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：实际通知show与warm/cold child marker/状态文件；无真人toast click。
- 真实入口：copy Electron + rcedit自有ProductName/AppID/CLSID/protocol + Start-Process。
- 模拟边界：用户桌面注册/通知是有影响的opt-in；不证明真人点击Action Center或用户机器权限。
- 时钟/重启：实际热进程激活和冷子进程重新启动，是真进程证据；没有真人点击toast。
- 清理证据：目前注册cleanup主要在成功路径；失败后可能遗留独立probe注册/通知/目录，需要try/finally。
- 生产消费者：`src/main/services/NotificationService.js`、`src/main/services/notification-activation.js`、`src/shared/reminder-protocol.js`。
- 后续改法：1) 将注册/launch/运行包在try/finally有界ownedcleanup；2) 失败保留取证但清理自有注册和通知；3) 缺rcedit/缓存/交互桌面归环境阻塞；4) 不得称真人toast点击已验收。
- 适用门槛：显式Windows通知原生验收专项；不因小改默认启动，也不替代内测用户点击确认。

### 38. tests/reminders-electron.mjs

保护：提醒列表、稍后/完成、调度/托盘/非法sender及唤醒。静态显式断言位置 60；另提取业务等待调用 49；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：SQLite提醒状态、popup/tray/主窗的literal结果及权限拒绝。
- 真实入口：真实ReminderWindow/ReminderApp + preload/DB；受控scheduler/nativeAction。
- 模拟边界：调度时间与native action受控；无真人toast点击；并发为后台事件/重复单人动作。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/ReminderApp.vue`、`src/main/services/ReminderService.js`、`src/main/services/ReminderWindow.js`、`src/main/services/TrayReminderController.js`、`src/main/services/notification-activation.js`。
- 后续改法：1) 保留真实popup/DB/授权和reveal；2) 注明scheduler/nativeAction模拟边界；3) ownedprofile/helpercleanup；4) 把等待谓词分case记录。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 39. tests/settings-scroll-memory-electron.mjs

保护：设置滚动/诊断折叠本次会话记忆、布局、search和浮层。静态显式断言位置 25；另提取业务等待调用 17；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literal scrollTop/expanded、焦点/控件几何；顺序两个真实child共用profile。
- 真实入口：父runner spawn remember/restart ->真实SettingsPanel三视图。
- 模拟边界：壁纸/背景用CSS pattern；不是真实图片/GPU/DWM；实际重启只保护本次会话reset语义。
- 时钟/重启：父进程依次spawn两个不同应用进程，共用同profile，restart case不重新seed；是真应用重启。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/system/SettingsPanel.vue`、`src/renderer/src/composables/useSettingsSearch.js`、`src/renderer/src/components/system/SettingsControlPopover.vue`、`src/renderer/src/utils/smoothScroll.js`。
- 后续改法：1) 保留真实双进程reset而非改为reload；2) parent和每child都写case/completion；3) finally等待child退出后清理ownedprofile；4) visual artifact与业务断言分开。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 40. tests/template-quarterly-electron.mjs

保护：季度模板rule、预览、编辑、保存与相关设置。静态显式断言位置 28；另提取业务等待调用 17；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literal rule序列/DB内容/下一次日期与UI选项。
- 真实入口：真实TemplateForm/TemplatePage->preload/模板DB。
- 模拟边界：日期推进/DBseed而非等一季；使用生产规则expected需保留literal期望。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/template/TemplateForm.vue`、`src/renderer/src/components/template/TemplatePage.vue`、`src/renderer/src/components/template/TemplateFrequencySelector.vue`、`src/main/db/db-templates.js`、`src/main/services/recurrence-rules.js`。
- 后续改法：1) 保留季度规则保存/预览与编辑行为；2) 固定代表性季度日期literal oracle；3) 补叶deps和cleanup；4) 重复保护只有等价后合并。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 41. tests/thumbnail-benchmark-electron.mjs

保护：缩略图尺寸、并发去重、文件变更失效、删除null及计时。静态显式断言位置 4；另提取业务等待调用 0；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：4业务assert：尺寸、promise identity、变化/删除结果；100次elapsed仅benchmark。
- 真实入口：生产db-images thumbnail +真实临时图片/nativeImage文件。
- 模拟边界：耗时无普适通过阈值；并发是UI重复读取/缓存请求而非人类百次瞬时操作。
- 时钟/重启：performance elapsed只作观测，无性能通过阈值；非应用重启。
- 清理证据：临时userData文件缺规范finally删除/cleanup证据。
- 生产消费者：`src/main/db/db-images.js`。
- 后续改法：1) 保留4行为保护并拆为局部功能资产；2) 100次benchmark为opt-in信息，独立命名；3) 增加finally真实资源/ownedprofile cleanup；4) 不得因为benchmark非门槛而删缓存失效保护。
- 适用门槛：4缓存行为纳入相关功能门槛；计时benchmark仅opt-in且不能等同用户性能合格。

### 42. tests/titlebar-icon-scale-electron.mjs

保护：Apple/Fluent导航风格、白SVG与150%图标设置。静态显式断言位置 15；另提取业务等待调用 19；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literal风格/SVG/尺寸及共享setting snapshot。
- 真实入口：真实AppTitlebar/SettingsPanel跨视图。
- 模拟边界：Apple属于视觉设计；比例setting不等于OS显示DPI。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/system/AppTitlebar.vue`、`src/renderer/src/components/system/SettingsPanel.vue`、`src/renderer/src/components/ui/AppIcon.vue`。
- 后续改法：1) 保留Apple视觉和Windows风格设置；2) 不因平台清理删除；3) 补sourceDeps、shared setting oracle和cleanup。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 43. tests/ui-components-electron.mjs

保护：通用UI控件布局、键盘、焦点与状态。静态显式断言位置 32；另提取业务等待调用 0；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literal尺寸/控件值/ARIA/focus与合成interaction结果。
- 真实入口：Electron ui-fixture加载真实Vue通用组件。
- 模拟边界：fixture state/API不等于完整app IPC/DB；Chromium scale-factor不是真OS多屏。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/ui/BaseButton.vue`、`src/renderer/src/components/ui/AppToggle.vue`、`src/renderer/src/components/ui/StyledSelect.vue`、`src/renderer/src/components/ui/FontSizeInput.vue`、`src/renderer/src/components/ui/DateTimePicker.vue`、`src/renderer/src/components/ui/TimePicker.vue`、`src/renderer/src/components/ui/MonthDayPicker.vue`、`src/renderer/src/components/ui/DatePicker.vue`、`src/renderer/src/components/ui/DateRangePicker.vue`、`src/renderer/src/components/weather/ChinaAreaCascader.vue`、`src/renderer/src/composables/useMessage.js`、`src/renderer/src/utils/popoverMotion.js`。
- 后续改法：1) 保留组件契约；2) 把fixture实际import的全部叶组件映射sourceDeps；3) 标component-fixture runtime；4) 结果/cleanup不借用app fullpass。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 44. tests/ui-feedback-app-electron.mjs

保护：真实应用状态反馈动画、遮挡与残留节点。静态显式断言位置 19；另提取业务等待调用 7；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：DOM状态、frames样本/clip和最终无ghost。
- 真实入口：真实App/NoteList/NoteCard反馈链。
- 模拟边界：固定时刻/frames采样依赖宿主；不是拖窗/贴边系统性能。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/list/NoteList.vue`、`src/renderer/src/components/list/NoteCard.vue`、`src/renderer/src/composables/useNotePresenceMotion.js`。
- 后续改法：1) 保留反馈/最终清理；2) 动画阶段采样诊断host预算；3) 源码映射和profileclean完成；4) 不把偶发样本少当业务失败。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 45. tests/ui-feedback-electron.mjs

保护：UI反馈组件、进出动画和忙碌/错误/成功。静态显式断言位置 33；另提取业务等待调用 0；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literal组件state/animation DOM/focus/clear。
- 真实入口：Electron ui-fixture真实Vue组件+受控状态。
- 模拟边界：fixture没main DB/IPC，scale设置只改Chromium布局。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/note/NoteDurationField.vue`、`src/renderer/src/components/ui/StyledSelect.vue`、`src/renderer/src/components/ui/FontSizeInput.vue`、`src/renderer/src/components/ui/TagSelector.vue`、`src/renderer/src/components/weather/ChinaAreaCascader.vue`、`src/renderer/src/components/month/MonthCalendarToolbar.vue`、`src/renderer/src/components/note/QuickNoteContentEditor.vue`、`src/renderer/src/components/ui/AppModalShell.vue`、`src/renderer/src/components/note/ScreenshotPicker.vue`、`src/renderer/src/composables/useMessage.js`、`src/renderer/src/composables/useNotePresenceMotion.js`。
- 后续改法：1) 保留独立组件反馈；2) 映射fixture import全部消费者；3) 标明mock api；4) 需要业务链的保护由ui-feedback-app单独承担。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 46. tests/ui-responsive-electron.mjs

保护：共享UI比例、窄布局、标题命中和日历浮层。静态显式断言位置 23；另提取业务等待调用 13；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literalroot font/setting/ui rect+真实input click；restart分支只读已有profile。
- 真实入口：真实应用SettingsPanel/AppTitlebar/calendar UI。
- 模拟边界：UI_RESP_RESTART外部flag决定分支，仓库没有自动同profile两进程driver；默认不证明restart。
- 时钟/重启：本文件无spawn/relaunch；UI_RESP_PROFILE+UI_RESP_RESTART提供手动二次启动分支，官方单次调用未自动证明真重启。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/system/SettingsPanel.vue`、`src/renderer/src/components/system/AppTitlebar.vue`、`src/renderer/src/components/month/MonthCalendarToolbar.vue`、`src/renderer/src/utils/applySettingsSnapshot.js`。
- 后续改法：1) 保留布局/missing controls防护；2) 为restart增加父runner写入->退出->同profile新进程->读回oracle并record PID，或更正分支标题/metadata；3) 将forcedscale与OSDPI区分；4) cleanupownedprofile。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 47. tests/view-visibility-shortcut-electron.mjs

保护：快捷键录制、禁用会话、冲突/retry、托盘、跨视图和重启恢复。静态显式断言位置 80；另提取业务等待调用 34；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：真实 globalShortcut.isRegistered、tray值/UI/DB与literaldisabled/restart状态。
- 真实入口：父runner三个真实child，生产globalShortcut和真实preload/settings。
- 模拟边界：部分trigger通过hooks而非OS物理按键；冲突由测试进程预约key模拟系统拒绝。
- 时钟/重启：父runner顺序startup-conflict/session/restart，共用session->restartprofile，是实进程；60schilddeadline为防卡死。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/main/services/view-visibility-shortcut.js`、`src/main/tray/shortcut-status.js`、`src/main/tray/main-tray-controller.js`、`src/renderer/src/components/ui/ShortcutRecorder.vue`、`src/renderer/src/components/system/SettingsPanel.vue`。
- 后续改法：1) 保留真实child restart与会话禁用契约；2) 每child/assert和退出写规范结果；3) 捕获失败注销自有按键/恢复录制；4) cleanup所有child/profile；5) 注明synthetictrigger边界。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 48. tests/wallpaper-storage-electron.mjs

保护：壁纸源去重、保存/删除事务、staging恢复及隐私计量。静态显式断言位置 40；另提取业务等待调用 0；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：真实SQLite数量/共享源路径、真实文件/thumbnail及诊断无base64/path。
- 真实入口：生产db-wallpapers + nativeImage/filesystem +隔离profile。
- 模拟边界：故障注入+cleanup重入，不是真kill后冷启动；并发是同机异步存储。
- 时钟/重启：受控文件故障及恢复函数重入，非main冷重启。
- 清理证据：现有recorder finally记录cleanup failed/preserved/complete及profile；不抹除清理失败。
- 生产消费者：`src/main/db/db-wallpapers.js`、`src/main/db/db-schema.js`、`src/main/logging/operation-performance.js`。
- 后续改法：1) 保留规范recorder/storage保护；2) 缺叶deps补齐；3) 明确profilepreserved/failed；4) 如需冷启动另设子进程，不借用当前恢复重入的pass。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 49. tests/weather-settings-electron.mjs

保护：地区选择滚动/布局、首次启用、设备位置失败与网络粗定位。静态显式断言位置 24；另提取业务等待调用 7；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：真实点击坐标/column scrollTop、literalregion/坐标和error文案/定位options。
- 真实入口：真实ChinaAreaCascader/WeatherSettings->preload settings。
- 模拟边界：设备geolocation/fetch受控；不证明真实GPS/IP provider、权限面板或公网可用。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/weather/ChinaAreaCascader.vue`、`src/renderer/src/components/weather/WeatherSettings.vue`、`src/renderer/src/utils/weatherSelectionPath.js`。
- 后续改法：1) 保留底部向上展开/省市切换清滚动及一次保存保护；2) 恢复geolocation/fetch patch；3) leaf deps+completion/cleanup；4) 公网另列手动内测。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 50. tests/week-day-panel-electron.mjs

保护：周日期菜单、预览、快速新建和显式日期列表开关。静态显式断言位置 11；另提取业务等待调用 12；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literal menu/selected date、空预览disabled、panel不隐式打开/重复不收起。
- 真实入口：真实week MonthWorkspace共用日期UI/preload。
- 模拟边界：helper注入计数/DOM事件；不是新OS双屏测试。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/month/MonthWorkspace.vue`、`src/renderer/src/components/month/MonthCalendarToolbar.vue`、`src/renderer/src/components/month/MonthDayPanel.vue`。
- 后续改法：1) 保留周视图明确panel契约；2) 仍记录所有businesswait；3) 完整映射共用组件和model；4) cleanup证据适配。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 51. tests/week-view-electron.mjs

保护：周导航、继承月视图几何/设置、日期选择及动画。静态显式断言位置 25；另提取业务等待调用 21；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literal7格/2row/标签/几何、41和33panel值、forward keyframes。
- 真实入口：真实week应用->共用MonthWorkspace/model->settings/main geometry。
- 模拟边界：当前真实display读取但未实际换DPI/屏幕；动画固定采样需宿主预算。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/month/MonthWorkspace.vue`、`src/renderer/src/components/month/MonthCalendarToolbar.vue`、`src/renderer/src/composables/useCalendarWorkspaceModel.js`、`src/renderer/src/composables/useCalendarWorkspacePreferences.js`、`src/main/windows/main-view-navigation.js`、`src/main/windows/window-geometry-persistence.js`。
- 后续改法：1) 保留月份/周各自panel设置与初次继承差别；2) 拆 navigation/setting/geometry选择case；3) 输出真实displaymeta；4) 按动画阶段oracle；5) cleanup。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 52. tests/window-border-electron.mjs

保护：窗口边框默认关闭/开启持久化/跨视图样式。静态显式断言位置 7；另提取业务等待调用 6；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literal0px/开关/snapshot与computed边线。
- 真实入口：真实SettingsPanel->applySettingsSnapshot->窗口Vue边线。
- 模拟边界：CSS边线验证非原生nonclient frame或DWM。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/renderer/src/components/system/SettingsPanel.vue`、`src/renderer/src/utils/applySettingsSnapshot.js`。
- 后续改法：1) 保留默认/开关样式；2) 补消费者和主题CSSdeps；3) 记录quitcleanup失败；4) 不与window-frame资产混同。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 53. tests/window-control-drag-electron.mjs

保护：层级切换锁/解锁后拖动事务及12截图崩溃组合恢复。静态显式断言位置 25；另提取业务等待调用 10；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：literal真实getBounds/isMovable、capturePID终止后suspension清零/可再触发。
- 真实入口：真实应用preload begin/update/end +真实Qthelper+nativeblur。
- 模拟边界：pointer坐标直接IPC注入；显式disable-gpu；不是自然鼠标拖动平滑度或GPU根因。
- 时钟/重启：等待真实Qtready、终止自有QtPID，再验主窗恢复；未重启Electron应用；disable-gpu缩小证据范围。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/main/windows/window-drag-controller.js`、`src/main/windows/z-order-runtime.js`、`src/main/capture/capture-window-integration.js`、`src/main/window-motion/dock-runtime.js`。
- 后续改法：1) 保留锁/解锁位置和helper崩溃生命期；2) metadata清楚disable-gpu；3) 仅杀自有helper并finally释放监听/状态；4) 记录profileownedmode及cleanup；5) 客户性能留内测日志。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 54. tests/window-frame-electron.mjs

保护：透明frameless style与四边移动的尺寸不漂移。静态显式断言位置 22；另提取业务等待调用 0；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：Win32 GetWindowLongPtr WS_THICKFRAME、physical window/workarea与尺寸不变量。
- 真实入口：独立真实Electron HWND +生产WindowMotion DLL。
- 模拟边界：200循环直接DLL位置，不是人类连续拖动或系统多DPI切换。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：finally window.destroy并app.exit；尚无统一business/cleanuprecorder。
- 生产消费者：`native_blur/window_motion_diagnostics.cpp`、`src/main/windows/window-profiles.js`、`src/main/window-motion/index.js`。
- 后续改法：1) 保留四边尺寸不变量；2) 短代表性行为为默认专项，长循环仅明确稳定性组合；3) 记录displayDPI/ABI和cleanup；4) 不得当客户拖动性能已解决。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 55. tests/window-state-matrix-electron.mjs

保护：贴边/层级/锁/视图/缩略/截图和系统事件组合。静态显式断言位置 38；另提取业务等待调用 8；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：真实HWND保持、GetWindowLongPtr、physicalbounds、worker/suspension及QtcrashPID。
- 真实入口：真实main/native和Qthelper；有case正则过滤。
- 模拟边界：display/power/lock events直接hooks/emit注入；Promise.all极快动作是后台重入保护非人类输入速度。
- 时钟/重启：powerMonitor.emit不是Windows真实休眠/锁屏；真实Qt重启有PID变化证据；动画deadline不是性能保证。
- 清理证据：finally恢复originalCursor、reset和quit；root/profile未规范cleanup/preserve状态，matrix JSON是自制报告。
- 生产消费者：`src/main/window-motion/dock-runtime.js`、`src/main/window-motion/dock-display-rebuild.js`、`src/main/windows/z-order-runtime.js`、`src/main/windows/presentation-mode-controller.js`、`src/main/capture/capture-window-integration.js`。
- 后续改法：1) 保留window组合真实状态；2) 每case列现实trigger和模拟event；3) 规范recorder读取每case而非仅总exit；4) require至少选中1case；5) 分组局部入口，不默认全矩阵；6) 恢复原cursor/取消session/ownedprofilecleanup。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 56. tests/window-z-order-electron.mjs

保护：真实置底锚定、overlay和无关reorder事件过滤。静态显式断言位置 25；另提取业务等待调用 5；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：Win32窗口相对order/desktop host与main，native计数只作事件预算补充。
- 真实入口：独立Electron HWND/ordinaryWnd + DLL +自有event emitter child。
- 模拟边界：注入合成事件/窗口；阈值依赖当前host，不能推断客户全部桌面环境。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`native_blur/window_z_order.cpp`、`native_blur/blur_engine.cpp`。
- 后续改法：1) 保留独立相对order与desktop位于main下面的oracle；2) 计数预算保存事件明细；3) finally结束ownedchild/窗；4) metadata区分模拟EVENT与实际系统重排；5) 规范结果。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

### 57. tests/window-z-order-recovery-electron.mjs

保护：层级瞬时/永久失效、show重入、同mode重应用和blur同步。静态显式断言位置 26；另提取业务等待调用 7；Qt skip 0。这些是源码位置，不是运行结果。

- 独立 oracle：Win32 WS_EX_TOPMOST、native enabled/requested/anchored、设置rollback及稳定HWND。
- 真实入口：真实三视图应用menu/preload/native；patch Electron setAlwaysOnTop/isAlwaysOnTop造失效。
- 模拟边界：人工drop/confirm/show回调注入是可达竞态的模型，不证明客户故障现场；Blur_IsZOrderSynchronized仍是被测API指标。
- 时钟/重启：单次进程中的真实 UI/IPC 等待；固定 pause 是等待实现，不是性能或应用重启证据。
- 清理证据：有隔离资源/退出路径的源码证据，缺少统一且可核验的 cleanup completion；不能据此报告已清理。
- 生产消费者：`src/main/windows/z-order-runtime.js`、`src/main/windows/main-view-navigation.js`、`src/main/bridge/blur_bridge.js`、`native_blur/window_z_order.cpp`、`native_blur/blur_engine.cpp`。
- 后续改法：1) 保留失败不得持久化/同moderepair/重入保护；2) 所有Electron方法patch放finally恢复；3) 补Overlay相对order独立读口而非仅同步API；4) recordfailurelayers/cleanupownedprofile；5) 真实用户偶发根因仍用日志反复验证。
- 适用门槛：候选客户端功能门槛；完成结果/清理适配后由父任务按功能范围选择运行。

## 验收与本轮边界

后续每批只选择修改功能相关的资产及必要构建/集成。矩阵、benchmark、通知注册和公告管理工具有自己的范围；普通小改不能触发它们的全量入口。用户明确要求发布验证时，按内测门槛统一组织结果，但仍将真实硬件/用户体验未覆盖项单列。

本轮执行了源码读取、JS AST解析、Qt平衡宏提取、57项集合及消费者路径核对、指导/JSON静态一致性检查；未执行任何 Vitest、Electron/Qt/Node测试、构建、GUI、全量回归或发布操作。所有57项 runtimeEvidence 均为 not-executed-in-this-audit。

尚未覆盖：真实混合DPI/多屏拔插、用户GPU/驱动/刷新率、自然拖窗/贴边卡顿现场、真人toast点击、系统真实休眠/锁屏、安装包升级/重启和长时间使用。这些不能用fixture或缺result adapter的状态顶替。按用户既定策略，拖窗/贴边性能根因由本次内测用户和深度日志继续验证。

审查期间只有 `tests/logging-actions-electron.mjs` 相对初提取snapshot发生hash漂移；JSON保存两份hash与最新断言，修改/运行结果以父任务证据为准。其他资产未由本审查修改。
