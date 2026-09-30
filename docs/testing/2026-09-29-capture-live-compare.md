# Snipaste 商店版定位与真实窗口补验

日期：2026-09-29。用户已结束数据传输，并明确允许使用桌面。

## 对标软件

用户提供的关于窗口显示 Snipaste 免费版 2.11.3（2026-01-18）、64 位、微软商店版。通过本机包信息和进程确认安装目录为：

`C:\Program Files\WindowsApps\45479liulios.17062D84F7C46_2.11.300.0_x64__p7pnf6hceqser`

包版本为 `2.11.300.0`，应用执行别名为 `%LOCALAPPDATA%\Microsoft\WindowsApps\Snipaste.exe`。无须用户寻找目录、修改 WindowsApps 权限或重新安装软件。本轮没有修改 Snipaste 配置。

## 已完成的局部补验

使用现有构建与部署版本，二者 SHA256 为 `FF18F09AE7BAC64397B57B55D89DB070CAAFF23B21942DF8A8641E217E63F913`。没有修改产品代码或重新构建。

| 专项 | 结果 | 证据与边界 |
| --- | --- | --- |
| Qt Windows 原生窗口 | 6 passed，0 failed，0 skipped；含 init/cleanup | [日志](evidence/2026-09-29-capture-live-compare/native-ui.txt)。4 个业务用例：`nativeControlDetection`、`pinTransformsEditingAndDisplay`、`pinDocumentHandoffAndRecovery`、`realDesktopSessionAndPins`。使用 Windows 平台与合成画布，QTest 事件不能替代真实鼠标手感/IME 验收 |
| Electron 生命周期 | passed，退出码 0 | [日志](evidence/2026-09-29-capture-live-compare/lifecycle.txt)。真实桌面捕获、取消仅结束一次、崩溃恢复、IPC 断开退出、Job 父进程异常结束回收、正常退出 |
| Electron 业务交付 | passed，退出码 0 | [日志](evidence/2026-09-29-capture-live-compare/business.txt)。独立配置验证快捷键冲突/录制、全局新建草稿、原草稿接收、草稿退出保护、背景裁剪取消；使用合成图像传输，未启用真实按键驱动 |

[运行器结果](evidence/2026-09-29-capture-live-compare/electron-summary.json)。使用 AGENTS.md 指定的 Node，原生专项从一开始在适合桌面访问的环境运行。测试只管理自己的临时数据与辅助进程。

## 对照尚未完成的原因

Windows Computer Use 的 `list_windows` / `list_apps` 没有返回 Snipaste 的可操作窗口。按官方[命令行说明](https://docs.snipaste.com/command-line-options)尝试显示托盘菜单及用项目合成图片创建贴图后，仍无可观察窗口；命令退出码 0 不能证明操作成功。不能据此断言 Snipaste 自身功能失效。

另外建立独立 Electron 合成画布时，日志已经记录 `ready`、`shown`，自动化清单仍未返回其窗口。重置 JavaScript 会话并重新初始化后结果未变。未绕过此问题猜测桌面坐标，也未操作用户的便签、文件管理器或传输程序。已请求用户保持 Snipaste 首选项窗口打开；观察连接恢复后继续对照。

用户此次提供的是“关于”窗口，没有包含贴图周围的扩散边缘。因此尚未实机确认其颜色、半径、激活/失焦差别，当前不能把它定义成已测量的黑色阴影或蓝色外发光。产品现有 `PinWindow::paintEvent` 仍是蓝色实线边框。

## 对先前口头评估的修正

此前回复把“直接选择任意旧标注再编辑”列为免费版对标缺口不准确。仓库已有[官方资料对照](../research/2026-09-29-snipaste-free-gap-review.md)明确区分：直接选择旧标注是专业版能力，免费版可通过撤销/重做重新编辑当前图案。本轮验收不把专业版能力算作免费版缺口。

## 后续针对性验收

1. Snipaste 与当前产品使用同一合成图片，在浅色、深色背景比较贴图常态、激活、失焦及编辑状态。
2. 修改边缘效果时，保证图像内容原位、原尺寸；阴影不写入复制/保存输出，不误拦截底层窗口点击。
3. 对照拖动、四边四角缩放、滚轮缩放、透明度、中键重置、编辑/结束及关闭/恢复。
4. 实机检查多屏混合 DPI、中文输入法候选框、屏幕边缘及快捷键焦点。

本轮没有运行全量回归、安装包、Windows 10 或长时间性能测试。没有提交、打包、发布，也没有宣称完成 Snipaste 体验对齐。
