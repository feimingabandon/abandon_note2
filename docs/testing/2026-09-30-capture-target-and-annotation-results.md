# 2026-09-30 标注外框与窗口识别修复

## 范围与原因

本轮只修改 Qt 截图模块的两处实现以及对应测试，保留工作区原有改动。未改动 Electron / Vue 界面，未提交、安装或发布。

- 标注虚线来自 `AnnotationEditor::paintHandles()`：所有当前标注都会绘制包围盒的虚线轮廓。这是编辑界面辅助线，原先也不进入导出图片。现在去掉该轮廓，保留控制点、文字旋转柄及编辑状态。
- 本机只读窗口枚举发现，Z 序顶部存在 `GameViewerServer` 的 `GameViewerPrivateWindowClass` 窗口，范围为 `(0,0)-(1920,1080)`，扩展样式为 `0x0A0800A8`，包含 `WS_EX_LAYERED | WS_EX_TRANSPARENT`。旧代码将这个全屏鼠标穿透层作为首个候选，导致后面的实际窗口无法被命中。没有操作、关闭或修改该进程。
- `desktopTargets()` 现在跳过同时具有上述两个样式的窗口；正常交互的分层窗口、工具窗口和全屏应用继续保留。单独的 `WS_EX_TRANSPARENT` 只代表绘制顺序，不作为排除依据。

窗口候选同时用于自动识别和边缘吸附，因此过滤在统一的原生枚举处处理。控件识别仍通过 Windows UI Automation 完成；第三方软件不提供子控件时仍回退到窗口范围。

## 复现与测试

证据目录：`tmp/capture-target-fix-20260930/`。

新增测试先在未修复实现上运行，再在修复后复跑：

- `selection-before.txt`：透明穿透层被错误保留，以及在它下面的 `500×300` 实际窗口被误识别成 `1920×1080`，两项均失败。
- `handles-before.txt`：矩形、椭圆、直线、折线、箭头、画笔、荧光笔、马赛克、模糊、橡皮擦，十项均检测到控制点之外的外框像素。
- 修复后的 `selection-after.txt`、`handles-after.txt` 全部通过。

最终验证在 Windows 11、单屏 1920×1080、100% 缩放下执行。原生窗口测试和 Electron 测试在沙箱外串行运行。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| Qt Release 构建及工作区部署 | 通过 | `build.txt` |
| `capture_selection_tests` 全套 | 29 通过 | `selection.txt` |
| `capture_ux_tests` 全套，包含合成视觉导出 | 21 通过 | `ux.txt`、`visuals/` |
| `capture_ui_tests` 相关编辑、撤销、输出、贴图及中文输入用例 | 36 通过 | `ui.txt` |
| `capture_polish_tests` 识别重试、过期回调、回退、提示与非交互反馈窗口用例 | 6 通过 | `polish.txt` |
| `tests/capture-lifecycle-electron.mjs` | 7 个业务检查通过 | `lifecycle.txt` |
| 改动审查与 `git diff --check` | 通过 | 两处产品实现与修改前快照对比 |

Qt 计数包含各测试程序的初始化和清理项。新窗口识别用例使用真正的 Win32 顶层穿透窗口、Qt 窗口与按钮，通过生产代码枚举候选和 UI Automation 查找控件，没有注入目标矩形。

新绘制用例逐像素确认控制点以外无额外轮廓，并验证结束编辑后辅助点消失、图片内容不变。已有用例继续验证移动、缩放、撤销、重做、文字旋转和导出。

Electron 检查覆盖单实例预热、真实桌面截图、取消只通知一次、崩溃恢复、IPC 断开退出、父进程强制结束后 Job 清理、正常退出。使用隔离测试配置，Node 使用指定缓存运行时并设置子进程 PATH。

`native_capture/build/bin/AbandonCapture.exe` 和 `native_capture/deploy/AbandonCapture.exe` 的 SHA256 均为：

`8DB5B737480CD6B3CB30A4C6D0181C765EA5DF73027472E50D6725AAF9E55139`

构建部署的 Qt 翻译扫描有路径警告；offscreen 测试有字体目录提示，均未导致退出失败。工作区部署组件已通过实际 Electron 启动验证。

## 未覆盖

- 未重新运行全项目回归，本轮只覆盖上述两处修复的相关专项。
- 未验证真实双屏 / 混合 DPI、Windows 10、所有第三方 UI Automation provider。
- 没有生成新安装包或更新既有安装。修复已进入工作区开发版截图组件。
