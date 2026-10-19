# 截图 UI 与交互实施结果

日期：2026-10-12。实施方案见 [修改方案](../planning/2026-10-12-capture-ui-interaction-plan.md)。

此后用户指出工具菜单和圆角的实际问题，工具栏已重新实现。当前 UI 与最新验证状态以 [Snipaste 工具栏重做记录](2026-10-12-capture-snipaste-toolbar-results.md) 为准；下文是之前版本的历史结果。

## 完成的修改

- 移除公开折线工具。矩形/椭圆、直线/箭头、画笔/荧光笔分别归入下拉分组；按钮本体使用该分组本次最后选择的工具。
- 截图、来源页面截图和贴图共用轻量单行工具栏。图标常态透明，蓝色图标表达选择；复制为紧凑完成操作，颜色、尺寸、字体及马赛克参数移到按需浮层。
- 参数浮层采用 180ms 进入、140ms 退出的淡入淡出和 4px 位移，支持快速反向、屏幕边缘避让、内部滚动、键盘遍历和焦点恢复。子菜单保留 Qt 原生键盘行为并统一主题及圆角。
- Escape 优先关闭内层菜单或参数浮层；参数输入时保持焦点。外部点击关闭浮层并消费该次点击，避免误画。模拟输入法预编辑期间的 Escape 不关闭浮层。
- 保留上一轮连续马赛克、圆形擦除、准确命中及撤销行为；模糊不再占独立入口。马赛克默认涂抹，同时在参数中保留区域覆盖，笔刷范围与颗粒大小独立。
- 新增默认 Ctrl+F1 的“快速截图复制”：框选松开后复制图像并退出；F1 继续正常编辑。遵守现有快捷键总开关、录制暂停和占用提示；来源便签截图仍使用编辑模式。
- 快速模式复制失败时保留选区，用 Enter/Ctrl+C 重试，Escape 取消；已有截图进行中时，其他快捷键不会替换它的模式。
- 托盘“查看便签提醒”改为“待处理提醒（数量）”，放在主窗口入口后，零条禁用。它用于重新打开当前仍待处理的提醒窗口，关闭提醒窗口不会自动确认这些提醒。
- 同步设置说明、帮助文本和原生组件说明。

原有未提交工作保留；本轮开始时的相关文件快照在 `tmp/capture-ui-20261012/before/`。

## 验证

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 局部 Vitest，8 个文件 | 103 通过 | `tmp/capture-ui-20261012/unit-2.txt` |
| Qt capture_ui | 48 通过 | `tmp/capture-ui-20261012/native-verified/capture_ui.txt` |
| Qt capture_ux | 28 通过 | `tmp/capture-ui-20261012/native-verified/capture_ux.txt` |
| Qt capture_polish | 14 通过 | `tmp/capture-ui-20261012/native-verified/capture_polish.txt` |
| Qt capture_selection | 29 通过 | `tmp/capture-ui-20261012/native-verified/capture_selection.txt` |
| Qt capture_clipboard | 5 通过 | `tmp/capture-ui-20261012/native-verified/capture_clipboard.txt` |
| Electron 实际应用业务集成 | 25 个断言通过 | `tmp/capture-ui-20261012/electron-attempt-2/result.json` |
| 最终原生组件的 Electron 生命周期 | 7 项通过，进程退出码 0 | `tmp/capture-ui-20261012/lifecycle-verified/result.json` |
| Electron Vite 应用构建 | 通过 | `tmp/capture-ui-20261012/app-build.txt` |
| 最终 JS/Vue/测试文件 Prettier、ESLint | 通过，无警告 | `tmp/capture-ui-20261012/format-final.txt`、`lint-final.txt` |
| C++ 格式、差异空白检查 | 任务改动范围使用 clang-format；git diff --check 通过 | 本轮文件及任务快照 |
| 原生构建与工作区部署产物 | EXE 和 DLL 的 SHA256 分别一致 | `tmp/capture-ui-20261012/deploy-hashes.json` |

Qt 计数包含各套测试的初始化和清理。最终五套 Qt 专项均在 Windows 11 上运行，退出码为 0，无失败或跳过。

Vitest 文件：`capture-shortcut.test.js`、`capture-coordinator.test.js`、`settings-schema.test.js`、`application-settings.test.js`、`main-tray-controller.test.js`、`reminder-service.test.js`、`feature-runtime.test.js`、`view-visibility-shortcut-ui.test.js`。

Electron 业务集成运行真实应用、窗口、数据库、preload 和 IPC，验证快捷键设置与录制暂停、快速模式回调、完成恢复及来源草稿边界；图像输出使用合成传输，它不证明原生指针或剪贴板操作。原生实际剪贴板写入由 Qt 的独立 Windows 窗口站子进程验证，不覆盖用户交互桌面的剪贴板。

生命周期集成使用合成桌面底图，验证真实桌面捕获、取消只完成一次、崩溃恢复、IPC 断开退出、父进程结束后的 Job 清理和正常关闭。

选区专项曾出现一次识别等待超时，同版独立重跑通过；测试夹具随后同步真实光标与检测坐标，最终五套联合执行通过。生产窗口识别逻辑未为此修改。

## 视觉检查与使用提示

最终证据在 `tmp/capture-ui-20261012/visuals-verified/`。已检查纯白、纯黑和复杂合成底图下的工具栏、分组菜单、参数浮层、马赛克及圆形擦除，并补齐明暗主题下的字体/方式下拉箭头。

本机 Ctrl+F1 的即时注册检查返回 `registered:false`，即该组合当前不可用，不能据此确定占用程序。产品默认保持 Ctrl+F1；用户可以释放占用后重试，或在设置中重新绑定。证据：`tmp/capture-ui-20261012/shortcut-availability.txt`。

工作区原生截图组件与应用构建已更新。本轮未打安装包、未发布。

## 未执行和未覆盖

- 未执行全项目回归、`npm test` 或 `test:window-frame:win`。
- 未在 Windows 10 上复验。
- 未完成真实多显示器混合 DPI 的鼠标和菜单操作验收；合成布局测试不替代该验收。
- 输入法验证使用模拟预编辑事件，未覆盖真实 Windows 输入法候选窗口交互。
- 未验证安装版升级、安装包或客户机器上的行为。
