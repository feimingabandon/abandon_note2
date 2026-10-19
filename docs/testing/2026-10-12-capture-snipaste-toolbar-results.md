# Snipaste 结构工具栏重做与验证记录

日期：2026-10-12。方案见 [工具栏重做方案](../planning/2026-10-12-capture-snipaste-toolbar-rework.md)。本记录替代当天早先工具分组/参数浮层版本的 UI 结论。

用户解锁测试会话后已完成复验：Qt UI/UX/参数专项共 93 项通过，0 失败、0 跳过；最终部署版的 Electron 真实截图生命周期 7 项通过。此前桌面与隔离剪贴板阻塞已解除。输入法候选窗口和多屏等未覆盖边界仍见下文。

## 当前实现

- 依据已查看的 [Snipaste 官方标注示例](https://i.v2ex.co/746553IP.png)，工具为一级图标，参数为自动出现的下方二级栏。
- 矩形、椭圆、箭头、直线、画笔、荧光笔、文字、马赛克和橡皮擦均有独立按钮。箭头在直线之前，不进入菜单；折线仍不提供公开入口。
- 常用按钮完整区域响应点击，至少 32×30 逻辑像素。选中状态有浅蓝底与蓝色图标；颜色/粗细等直接操作，不再先点击一个参数按钮。
- 参数改变保留输入焦点；Enter/Escape 返回画布；组合输入期间的 Escape/Enter 只处理输入法组合。工具栏空白不触发绘图，参数栏不会吃掉下一次画布拖动。
- 解锁复验发现，Qt 字体组合框拥有键盘焦点，而内部输入框可能接收预编辑事件。现将组合状态同步到所属输入控件，并用实际焦点拥有者发送按键；组合框/内部输入框分别接收预编辑时的 Escape、Enter 共 4 种情况均通过。此前仅要求焦点必须等于内部输入框的断言也已改为验证实际焦点保留。
- 窄空间把输出操作分行；参数内容可以内部横向滚动，避免数值、字体和马赛克方式挤入工具栏溢出菜单。
- 主工具栏使用单一的自绘背景与 4px 小圆角，取消重复 CSS 轮廓；同时设置实际子控件/Windows 窗口区域的圆角裁切。独立工具窗清理透明背景；菜单使用相同半径和实际区域裁切。
- 清除已不用的 CapturePopover 源码和构建依赖，更新原生帮助及 README。
- 快速复制快捷键、托盘提醒、连续马赛克与圆形擦除保持此前已授权的行为。

## 构建与部署

最终 Windows 原生构建通过，日志 `tmp/capture-snipaste-20261012/final-build-unlocked.txt`。

工作区 `native_capture/deploy/AbandonCapture.exe` 已原子替换，新构建与部署的 SHA256 都为：

`3CC87981BF994DB84F96D6EBEC2AD7AAAC5A7EFFAA02B3E4304284E7F9C13954`

构建与部署的 capture_host.dll 哈希也一致且内容未变化。详细记录 `tmp/capture-snipaste-20261012/deploy-hashes-unlocked.json`。

直接覆盖首次被占用的 EXE 时失败，因此没有结束正在运行的应用或截图进程。随后使用保留备份的原子文件替换，旧文件保存在 `tmp/capture-snipaste-20261012/before/AbandonCapture.exe`。解锁后的输入法修复再次原子更新，修复前版本保存在 `ime-focus-before/AbandonCapture.exe`，对应源码快照也保留。

运行中的工作区开发版仍预热着旧截图引擎；正常退出并重新启动开发版后，才会加载新 UI。本轮未关闭用户贴图、未重启用户应用、未打包或发布。

## 实际测试结果

| 专项 | 当前结果 | 证据 |
| --- | --- | --- |
| 原生构建 | 通过 | `final-build-unlocked.txt` |
| Qt capture_ux，最终版 | 31 通过，0 失败、0 跳过 | `native-unlocked-final/capture_ux.txt` |
| Qt capture_polish | 14 通过，0 失败、0 跳过 | `native-unlocked-final/capture_polish.txt` |
| Qt capture_ui | 48 通过，0 失败、0 跳过 | `native-unlocked-final/capture_ui.txt` |
| Electron 后台宿主集成 | 6 项通过，退出码 0 | `host-1/result.json` |
| Electron 最终部署版真实截图生命周期 | 7 项通过，退出码 0 | `lifecycle-unlocked/result.json` |
| 差异空白检查 | git diff --check 通过 | 当前源码 |
| C++ 格式 | clang-format，现有源码按本轮快照差异范围处理 | 当前源码 |

上述证据都在 `tmp/capture-snipaste-20261012/`。Qt 数量包含初始化和清理，跳过不能算作通过。

后台宿主测试只验证预热单进程、主题命令、IPC 断开退出、重启、正常退出和父进程结束后的 Job 回收，不启动截图、不向桌面注入输入、不访问用户剪贴板。

实际截图生命周期测试使用合成底图覆盖显示器，验证真实桌面截图就绪、取消只完成一次、崩溃恢复、IPC 断开退出、父进程结束后的 Job 回收及正常关闭。它只管理自己的进程和测试数据。

已执行完整按钮边缘点击、箭头直接绘制、参数输入后第一笔立即绘制、组合输入期间焦点保留，以及截图内子控件和贴图独立工具窗的四角背景像素检查。原生屏幕像素证据：`visuals-unlocked-final/native-toolbar-corners.png`；四角确实透出测试底图。

## 早期阻塞及未覆盖边界

早期测试会话 ID 2 返回 SessionFlags=0（锁定），相关结果见 `native-2/` 至 `native-4/`。用户解锁后的查询成功、SessionFlags=1（未锁定），证据 `desktop-state.json`；最终复验没有跳过这些用例。

早期锁定时产生的空焦点和非合成底图像素不代表产品通过或失败。最终验收以解锁后未跳过的业务断言为准。

早期 capture_ui 的复制反馈用例在测试专用窗口站中失败，直接诊断 OpenClipboard 返回 Win32 ERROR_ACCESS_DENIED（5），隔离绑定和清理成功。原始诊断位于 `C:/Users/Admin/AppData/Local/Temp/capture-ui-feedback-copy-ulOoUc/`。解锁后该用例通过，包含实际图像写入、读取校验和反馈窗口生命周期；没有为此修改产品剪贴板实现，也没有访问或替换用户交互桌面的剪贴板。

最终合成预览在 `visuals-unlocked-final/`，已查看纯白、纯黑和复杂底图。`toolbar-composite-*.png` 保留周围底图像素；独立工具窗另有上述真实 Windows 屏幕像素断言。

未完成本机 Snipaste 2.11.3 实机操作对照：Computer Use 未返回其窗口，启动授权超时。使用的官方示例是历史示意图；没有宣称与当前商店版逐像素相同。

未执行全项目回归、npm test、test:window-frame:win、安装包验证。Windows 10、真实混合 DPI 多屏和真实输入法候选窗口仍未覆盖；输入法专项使用模拟预编辑事件，不代表真实候选窗口验收。本轮源码只影响原生截图 UI，未重复运行此前不变的 JS/设置测试。
