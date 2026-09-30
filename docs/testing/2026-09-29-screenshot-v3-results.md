# 截图与贴图 v3：交互修复、工具栏改版与局部验收

日期：2026-09-29。对应 [v2 交互审查 R01–R07](../research/2026-09-29-capture-v2-ux-review.md)。保留 Qt Widgets + Electron 架构；本轮修改产品代码并更新本地 `native_capture/deploy/AbandonCapture.exe`，没有提交、制作安装包或发布。

用户正在接收另一台电脑传输的数据，本轮不操作传输程序、共享目录、网络配置，也不进行桌面鼠标键盘验收。所有图像证据来自合成画布。后台 Electron 专项只管理本次创建的测试进程。

## 实现与审查对应

| 条目 | 本轮改动 | 对应证据 |
| --- | --- | --- |
| R01 原位贴图 | 截图输出传递选区屏幕矩形与所属屏幕，贴图使用原来的显示位置和尺寸；剪贴板贴图以鼠标为中心并约束到工作区；关闭恢复沿用保存的视图。可放入工作区的图片保持完整可见，超大图片另行约束 | Qt 核心的负坐标/越界几何测试；`pinDocumentHandoffAndRecovery` 断言截图选区与初始贴图窗口矩形相同 |
| R02 参数失焦 | 数字和字体输入期间保留焦点；Enter/Escape 明确结束参数输入并返回编辑器；菜单、颜色窗口保留自己的键盘操作 | `parametersKeepFocusAndValues` 通过实际焦点控件逐字输入 24；菜单方向键专项 |
| R03 连续擦除 | 画笔、荧光笔、橡皮擦的普通拖动始终开始新笔画；Alt 拖动当前对象才进入移动/缩放。光标提示与该规则一致 | `continuousStrokes` 验证两笔交叠时仍有两个对象，第一笔不发生位移 |
| R04 裁剪效果一致 | 裁剪时保留马赛克/模糊的已取样像素，同时保留底图、命令和撤销/重做。用户明确改动当前效果时重新取样；缓存纳入图像预算，超过上限拒绝创建 | `cropPreservesEffectsAndHistory` 比较像素、两次裁剪、撤销后裁剪再重做、擦除和清空；`editedCroppedEffectResamples` |
| R05 文字变换 | 拖角同比缩放文字及字号，提供旋转圆柄，Shift 吸附角度/缩放时恢复水平；命中测试与控制柄使用同一变换。输入使用可变换的 Qt 文字控件，导出采用相同的 QTextDocument 排版；透明输入预览保留底图，避免重复绘制当前文字 | `textHandlesAndRotatedHit`、`textInputTransformsWithDocument`，以及文字输入/提交预览 |
| R06 参数保持 | 当前编辑器内按工具保持线宽/效果强度，切换后不再强制恢复为 3 或 12。字号、颜色沿用编辑器状态 | 参数保持用例：矩形 24、橡皮擦 35 往返切换；未增加跨进程参数持久化 |
| R07 键盘语义 | 1 顺时针、2 逆时针；画布中 Tab 切换直线/箭头；当前标注的方向键微调不再移动外层选区或贴图。工具按钮仍可用 Space/Enter 激活，菜单保留方向键，绘制中 Space 不打断笔画 | 有焦点和可见工具栏的 Tab/Space 用例；贴图旋转与标注回归 |

## 工具栏与外观

- 新增 `CaptureAppearance`，使用项目自绘的矢量 `QIconEngine`，在目标设备分辨率下绘制统一的轮廓、线宽和端点，不再依赖 Unicode 图标或固定分辨率源位图；没有引入额外的 Qt 模块、图标字体或第三方软件。
- 绘图与撤销/重做在左侧；贴图、保存、更多、取消和完成在右侧。“复制并完成”用明确的蓝色主按钮；低频操作进入更多菜单。贴图编辑中的按钮提示区分复制与结束标注。
- 参数按工具显示；颜色使用色块与选中环，精确数值保留键盘输入。字体和角度仅在文字工具中显示。窄屏时输出区换行，保证贴图/保存/取消/完成可见。
- 原生面板从宿主背景色和文字色派生表面、边线与悬停色，强调色保持语义蓝；Electron 在启动、操作和设置更新时传递颜色。主题色变更不会修改图片中的标注颜色。
- 保留浮层稳定的不透明表面与克制的圆角/边线，在复杂背景上可读；不是系统毛玻璃或 Apple 原生控件。不同角的贴图缩放光标已区分，旋转时保持窗口中心。
- 全屏选区等情况下，尺寸提示会避让工具栏；Space 显隐工具栏的行为保留。
- 工具栏空白区域消费鼠标事件，避免点击空白处穿透到底图产生误画，已有回归断言。

预览：[浅色工具栏](evidence/2026-09-29-capture-v3/toolbar-light.png)、[深色工具栏](evidence/2026-09-29-capture-v3/toolbar-dark.png)、[复杂背景](evidence/2026-09-29-capture-v3/complex.png)、[旋转文字输入](evidence/2026-09-29-capture-v3/text-input.png)、[文字提交后的控制框](evidence/2026-09-29-capture-v3/text-committed.png)。上述图片均已查看。

## 已运行验证

环境：本机 Windows 11、MSVC、Qt 6.8.3。Qt 图像与交互测试使用 `QT_QPA_PLATFORM=offscreen`；字体预览显式载入系统字体，仅用于测试。

| 验证 | 最终结果 | 证据 |
| --- | --- | --- |
| C++ 编译 | 退出码 0 | [build.txt](evidence/2026-09-29-capture-v3/build.txt) |
| `capture_core_tests` | 9 passed，0 failed/skip | [core.txt](evidence/2026-09-29-capture-v3/core.txt) |
| 新增 `capture_ux_tests` | 11 passed，0 failed/skip | [ux.txt](evidence/2026-09-29-capture-v3/ux.txt) |
| `capture_ui_tests` 指定的相关用例 | 39 passed，0 failed/skip | [ui.txt](evidence/2026-09-29-capture-v3/ui.txt) |
| `tests/capture-coordinator.test.js` | 9 passed | [coordinator.txt](evidence/2026-09-29-capture-v3/coordinator.txt) |
| 新增后台 Electron 宿主专项 | 退出码 0；预热单进程、主题命令、IPC 断开退出、重启、主动关闭、Job 宿主异常退出回收 | [host-summary.json](evidence/2026-09-29-capture-v3/host-summary.json)、[host.txt](evidence/2026-09-29-capture-v3/host.txt) |
| electron-vite build | 退出码 0 | [electron-build.txt](evidence/2026-09-29-capture-v3/electron-build.txt) |
| 本轮相关 JS 的 ESLint、已跟踪改动的 diff 空白检查 | 退出码 0 | 对主进程接入、协调器、新测试与运行器指定文件运行 |

Qt 数量包含各组的 init/cleanup。UI 专项明确只运行：`newTools`、`completionGestures`、`selectionPrecisionAndSpace`、`currentObjectParametersAndHistory`、`textDraftParametersAndReopen`、`pinTransformsEditingAndDisplay`、`pinDocumentHandoffAndRecovery`、`interruptedAnnotation`、`selectionAndExport`、`resizeHandles`、`annotationToolsAndChineseInput`。

首轮新 UX 测试发现窄屏输出按钮被折叠，已改为输出区换行后通过。新后台宿主测试最初因入口顶层等待 `app.whenReady()` 未完成初始化；已改为就绪后的异步入口，结束的仅是命令行和可执行路径均匹配本次测试的两个测试进程。最终有效结果以运行器记录的真实退出码与业务断言为准。Qt offscreen 字体目录/尺寸提示警告没有影响最终断言；预览已确认中文字形正常。

## 本地组件与复验入口

更新前确认没有运行中的该部署路径截图进程，没有终止便签或其他应用。构建文件与部署文件 SHA256 一致：

`FF18F09AE7BAC64397B57B55D89DB070CAAFF23B21942DF8A8641E217E63F913`

[部署校验](evidence/2026-09-29-capture-v3/deployment.json)。最终后台宿主运行目录：`tmp/test-runs/2026-09-29T05-11-00-984Z-YzpCvA`，使用与部署相同的 EXE 和 Qt 依赖副本。

后台 Electron 复验入口为 `scripts/run-electron-window-tests.cjs capture-host`，可使用 `ABANDON_CAPTURE_TEST_DIRECTORY` 指定独立组件目录。必须用仓库 AGENTS.md 指定的 Node 运行时，并将它的目录放在 PATH 首位；Qt 测试需要 Qt bin 与插件路径。新增 UX 测试可通过 `CAPTURE_UX_EVIDENCE` 指定合成预览目录。

## 未运行与验收边界

- 未运行 `npm test`、窗口框架完整矩阵或全项目回归。
- 未运行会覆盖桌面/发送真实输入的 `capture-lifecycle-electron.mjs`、`capture-business-electron.mjs`；后台宿主专项不等价于这两个真实桌面业务专项。
- 未重新运行真实 Windows 剪贴板、UI Automation、显示配置变化专项；本轮没有修改这些平台实现。
- 多显示器与混合 DPI、100%/125%/150%/200% 的实际窗口切换、真实中文 IME 候选窗、Windows 10、安装包及长时间/4K 性能仍待桌面可用时专项验证。纯几何与图标 DPR 测试不能替代这些条件。
- 没有启动 Snipaste 做并排实机比较，不声称已完整复刻免费版。当前对象编辑范围仍为最近创建/重做的标注，不扩展为专业版式任意旧对象选择。
- 本轮范围是截图/贴图的上述交互与外观，保持完整退出时快捷键、贴图和 helper 一同退出；未增加 OCR、分组或跨重启贴图历史。
