# 选区吸附与跨屏截图：实现和专项验证

日期：2026-09-29。用户要求先修复选区与多屏相关问题，真实双屏条件暂缺，后续提供测试安装包给有双屏的用户验收。本轮不作真实混合 DPI 双屏已通过的结论。

## 完成的行为

- 手动框选、移动选区、八向调整增加边缘吸附；候选为可见窗口边缘和显示器边界。按前后遮挡关系排除隐藏边缘，正反向框选均支持。阈值按鼠标所在屏幕换算为约 6 个逻辑像素。
- 按住 Ctrl 临时绕过吸附，松开恢复；方向键仍按输出图像的物理像素微调，Space 拖动仍可用。绘图工具不应用选区吸附。拖动过程中隐藏操作栏，完成后显示。
- 所有显示器在遮罩出现前完成采集，按 Windows 原生物理坐标拼接为一张桌面画布。跨屏选区、标注和导出使用同一图像坐标，不对不同 DPI 的屏幕图像重新缩放。负坐标、错位和竖向布局可处理，未被屏幕覆盖的区域在 PNG 中透明。
- Ctrl+A/F 选择鼠标所在显示器；跨屏截图通过拖选完成。操作栏在选区结束的显示器内放置，后续跨屏悬停不改变其位置；提示框可按所在屏幕宽度换行，放大镜按所在显示器边界避让。
- 截图转贴图采用选区的原始物理位置。贴图拖动与缩放改用窗口客户区到桌面的物理坐标，避免 Qt 多屏逻辑坐标间隙被计入拖动量；跨两个显示器的贴图不会在松手时被强制移到一块屏幕。
- 显示器配置变化仍取消旧截图、清空上次选区；不可见贴图约束回可用显示区域。本轮增加了模拟配置变化事件的验证。
- 本地诊断增加 `capture.ready` 显示器物理/逻辑矩形。Electron 仅接受最多 16 组数值矩形，忽略额外字段；不记录图片或原生消息全文。
- 虚拟桌面包围矩形最多 128 MiB，包含屏幕间空隙。采集临时缓冲、合成画布和已有贴图在分配前受 512 MiB 图像预算约束；超限明确报错，不自动降采样。

主要代码：[SelectionSnap.cpp](../../native_capture/engine/SelectionSnap.cpp)、[DesktopLayout.cpp](../../native_capture/engine/DesktopLayout.cpp)、[CaptureOverlay.cpp](../../native_capture/engine/CaptureOverlay.cpp)、[CaptureEngine.cpp](../../native_capture/engine/CaptureEngine.cpp)、[PinWindow.cpp](../../native_capture/engine/PinWindow.cpp)、[DesktopTargets.cpp](../../native_capture/platform/windows/DesktopTargets.cpp)、[CaptureCoordinator.js](../../src/main/capture/CaptureCoordinator.js)。沿用已有 Qt、Windows 运行库。

## 已运行的局部测试

环境：Windows 11，Qt 6.8.3，MSVC。除共享编辑器专项使用 offscreen 外，Qt 测试使用 Windows 原生窗口。缩放通过测试进程的 `QT_SCALE_FACTOR` 设置，未改变系统显示设置。

| 专项 | 结果 | 证据 |
| --- | --- | --- |
| 最终原生构建 | 退出码 0 | [build-verified.txt](evidence/2026-09-29-selection-desktop/build-verified.txt) |
| 选区/合成布局，100% | 23 passed，0 failed/skip | [verified-1.txt](evidence/2026-09-29-selection-desktop/verified-1.txt) |
| 选区/合成布局，125% | 23 passed，0 failed/skip | [verified-1.25.txt](evidence/2026-09-29-selection-desktop/verified-1.25.txt) |
| 选区/合成布局，150% | 23 passed，0 failed/skip | [verified-1.5.txt](evidence/2026-09-29-selection-desktop/verified-1.5.txt) |
| 选区/合成布局，175% | 23 passed，0 failed/skip | [verified-1.75.txt](evidence/2026-09-29-selection-desktop/verified-1.75.txt) |
| 选区/合成布局，200% | 23 passed，0 failed/skip | [verified-2.txt](evidence/2026-09-29-selection-desktop/verified-2.txt) |
| 相关 Qt UI 会话 | 15 passed，0 failed/skip | [verified-ui.txt](evidence/2026-09-29-selection-desktop/verified-ui.txt) |
| 光晕，100% / 125% | 每档 8 passed，0 failed/skip | [100%](evidence/2026-09-29-selection-desktop/final-halo-1.txt)、[125%](evidence/2026-09-29-selection-desktop/final-halo-1.25.txt) |
| 共享标注编辑器 | 10 passed，0 failed，1 skipped | [final-ux.txt](evidence/2026-09-29-selection-desktop/final-ux.txt) |
| `tests/capture-coordinator.test.js` | 10 passed，退出码 0 | 本轮 Vitest 输出；包含布局诊断字段过滤和过期会话拒绝 |
| Electron 必需构建 | 退出码 0 | [electron-build.txt](evidence/2026-09-29-selection-desktop/electron-build.txt) |
| Electron 生命周期专项 | passed，退出码 0 | [lifecycle.txt](evidence/2026-09-29-selection-desktop/lifecycle.txt) |
| Electron 业务专项，真实桌面输入 | passed，退出码 0 | [business.txt](evidence/2026-09-29-selection-desktop/business.txt)、[运行器结果](evidence/2026-09-29-selection-desktop/electron-summary.json) |
| 修改的 C++ 格式与 JS ESLint | 退出码 0 | 仅本轮涉及文件 |

Qt 数量包含 init/cleanup。共享编辑器跳过的是可选 `syntheticVisualEvidence` 预览文件导出，八个业务测试均通过；offscreen 字体/窗口能力警告保留在日志中。

选区专项使用真实 HWND 验证正/负坐标覆盖范围、贴图物理落点和拖动/缩放；用两块合成画布模拟屏幕，在接缝两侧检查单像素纹理和标注导出，测试工具栏及提示框可达性。对不同缩放、错位、竖屏、物理间隙逐像素比较原始输入；这不意味着机器拥有两块真实显示器。

Qt UI 选跑：`selectionPrecisionAndSpace`、`selectionAndExport`、`resizeHandles`、`completionGestures`、`pinTransformsEditingAndDisplay`、`pinDocumentHandoffAndRecovery`、`systemCloseCleansUpAllOverlays`、`annotationToolsAndChineseInput`、`displayChangeCancelsSessionAndRecoversPin`、`realDesktopSessionAndPins`。

Electron 使用 `scripts/run-electron-window-tests.cjs capture`，`ABANDON_CAPTURE_REAL_INPUT=1`。验证辅助进程生命周期、异常恢复、父进程突然终止、系统关闭截图后重新进入、快捷键冲突/录制、截图新建便签、已有草稿追加、草稿退出保护和背景裁剪取消。使用隔离测试资料和测试画布。

开发过程发现并修正 Qt 在 ShowEvent 后重新应用缓存位置的问题，最终在 `show()` 返回后设置原生像素位置。早期日志保留；验证结论以上表为准。另一次失败是测试把 HWND 移到 100000 坐标导致 Windows 裁限；改为实际屏幕外 1000 像素的有效坐标后验证了回收行为。

## 本地更新

最终构建与部署组件 `AbandonCapture.exe` 的 SHA256 均为：

`711AD570FD1635BF530ADA4A5CEA060887A5E070B822865499D40217FB3F9AB0`

[部署证据](evidence/2026-09-29-selection-desktop/deployment-verified.json)。开发版后来启动并占用了组件，按用户此前授权，仅结束了核实属于本仓库 Electron 的截图辅助进程并替换文件，便签主进程未结束。下一次截图会通过现有崩溃恢复路径启动新版组件。

光晕、共享编辑器、Electron 结果在最后一处提示框换行修正前取得；最后修改只涉及截图提示框布局，已在最终五档选区专项和 Qt UI 专项再次验证。

## 未覆盖与后续试包

- 未执行全项目测试、Windows 窗口框架完整矩阵或不相关模块回归。
- 无真实双屏硬件，尚未验证真实混合 DPI 跨屏鼠标事件/字体尺寸、显示器拔插、旋转、主副屏切换和长时间拖动。模拟配置事件不等于真实拔插。
- 未验证 Windows 10、HDR/不同色彩空间、超大桌面性能及此次修改的安装包环境。
- 本轮未制作或分发测试安装包、未发布正式版。后续按[双屏用户验收单](capture-multimonitor-user-checklist.md)生成本地测试包并让用户反馈。该清单包含发包前依赖/隔离资料验证、环境记录、操作步骤和日志反馈格式。

实现已具备跨屏截图路径，真实双屏体验继续标记为待验收。
