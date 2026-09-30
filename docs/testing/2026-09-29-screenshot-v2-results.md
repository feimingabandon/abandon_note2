# 截图/贴图 v2 实现与专项验证

日期：2026-09-29。范围：[交互基线 v2](../research/2026-09-28-screenshot-core-design.md) 的核心实现；继续使用 C++20 / Qt 6.8.3 + Electron 宿主。没有引入第三方截图软件或复制其品牌资源。

本轮已修改产品代码并更新本地 `native_capture/deploy`。核心新增路径的自动化通过；这不代表 Snipaste 免费版实机体验、所有 T/UX 条件或全部 Windows 硬件验收完成。没有创建提交、安装包或发布。旧包不含本轮改动。

## 实现

- `ImageDocument`：冻结底图与透明标注层分开。100 步之后的标注归档到标注层，橡皮擦和清空仍不破坏底图。支持裁剪后携带命令转为贴图、内容旋转/镜像，导出与窗口透明度/显示缩放无关。
- `AnnotationEditor`：截图/贴图共享同一编辑器、图标工具栏和参数控件。矩形、椭圆、直线、折线、箭头、画笔、荧光笔、文字、马赛克、模糊、橡皮擦；当前图案松开后可移位、调整尺寸/参数，右键完成，重做恢复为当前可编辑对象。历史对象不提供任意点击重编辑。
- 文字：多行中文输入事件、颜色、字体、字号、框大小、移位与旋转；Ctrl+Enter 结束输入，当前文字双击可继续输入。Esc 优先处理输入法预编辑与当前图案。界面文字输入框保持可阅读方向，输出按文档变换渲染。
- `CaptureOverlay`：双击/Enter/Ctrl+C 复制完成，中键/Ctrl+T 贴图；Ctrl+A/F 全屏；方向键移动、Ctrl 扩边、Shift 缩边；拖选时 Space 临时移动，平时 Space 显隐工具栏。支持窗口/控件检测、Tab 切换、放大镜、HEX/RGB 取色、WASD 移动系统光标和 R 恢复上次成功区域。显示配置变化清除旧区域。
- `DesktopTargets`：在显示截图浮层前记录窗口顺序及矩形。后台 Windows UI Automation 只读取控件矩形，设置 provider 超时并限制并发、树深度与子项遍历；不读取控件文字。识别失败或 provider 卡住时保留手动框选。
- `PinWindow`：Space/E 打开同一工具栏；边/角等比缩放，普通滚轮/+/- 缩放，Ctrl+滚轮/加减改变透明度，中键恢复两者，方向键物理像素移位，1/2 旋转、3/4 镜像、Shift+双击缩略图、Shift 拖动吸附。编辑态输入优先于窗口操作。
- 会话：隐藏、关闭、销毁分开；只保留最近一张关闭的文档及大小/位置/透明度/缩略图/置顶状态。恢复时关闭鼠标穿透，托盘另有取消所有贴图穿透入口。关闭记录计入 10 张与 512 MiB 图像预算。应用退出全部释放，不跨启动恢复贴图。
- `SaveActions`：截图和贴图使用同一保存逻辑。Ctrl+Shift+S 首次询问目录；后续保存到明确配置目录，失效目录报错且保留内容。目录设置保存在宿主用户数据的 `capture-tmp/capture-settings.ini`；托盘和贴图菜单可修改。
- 业务入口保留：来源便签/背景使用工具栏按钮或 Ctrl+Enter；普通 Enter 按统一截图习惯复制。全局 Ctrl+N/B 创建图文便签/用作背景。Job 对象和管道生命周期约束保留。

图像预算为保守的应用层工作区估算，并不是进程 RSS 的硬上限；Qt 控件、编解码器、GPU、短期复制和系统 clipboard 占用不等于持久文档大小。长时间资源压力仍需另测。

## 已运行结果

环境：本机 Windows 11、MSVC、Qt 6.8.3。桌面捕获测试先覆盖所有显示器为合成画布；业务使用临时 profile/数据库，剪贴板专项使用隔离窗口站。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| C++ 构建与本地 Qt 部署 | 通过 | [build.txt](evidence/2026-09-29-capture-v2/build.txt) |
| `capture_core` | 7 passed，0 failed/skip | [core.txt](evidence/2026-09-29-capture-v2/core.txt) |
| `capture_ui` | 45 passed，0 failed/skip | [ui.txt](evidence/2026-09-29-capture-v2/ui.txt) |
| `capture_clipboard` | 5 passed，0 failed/skip | [clipboard.txt](evidence/2026-09-29-capture-v2/clipboard.txt) |
| `tests/capture-coordinator.test.js` | 8 passed | 本轮显式指定文件运行 Vitest，退出码 0 |
| Electron 生命周期 | 通过 | [lifecycle.txt](evidence/2026-09-29-capture-v2/lifecycle.txt) |
| Electron 真实按键业务 | 通过 | [business.txt](evidence/2026-09-29-capture-v2/business.txt) |
| electron-vite build | 通过 | 本轮构建退出码 0，`tmp/capture-v2-electron-build.log` |
| 本轮 JS 修改的 ESLint | 通过 | `src/main/index.js`、两个 Electron 专项、合成桌面 fixture，退出码 0 |

Qt 数量包含每组的 init/cleanup。第一次新增 UI 用例有一次比较失败：Qt 对组合旋转/镜像输出的像素格式不同；归一到 ARGB32 后逐像素比较通过，未删去旋转/镜像断言。[首次记录](evidence/2026-09-29-capture-v2/ui-first-run.txt) 保留。

最新 Electron 运行目录：`tmp/test-runs/2026-09-29T03-40-48-831Z-F2IEJV/`。[退出码汇总](evidence/2026-09-29-capture-v2/electron-summary.json)。

引擎 SHA256：`CB43109AA83BD548FDD22A9111B12BC255C664F540C01A093FB9E13880EC53CE`。

构建器仍打印 Qt translations 路径警告；本构建显式使用 `--no-translations`，已用部署后的 EXE 完成 Electron 专项。没有把此警告当作平台/安装验证通过证据。

## UX 覆盖与限制

| 条目 | 本轮覆盖 | 未完成条件 |
| --- | --- | --- |
| UX01 完成手势 | 双击、Enter、中键、源入口 Ctrl+Enter 的动作和输出像素 | Snipaste 连续实机对照 |
| UX02 选区精度 | 反向选择、八手柄、Space 临时移动、Ctrl/Shift 边界、逻辑尺寸变化后的像素移动 | 实际混合 DPI/多屏输入矩阵 |
| UX03 自动检测/精度工具 | 测试窗口内真实 UI Automation 按钮识别；上次区域恢复代码与合成坐标用例 | 浏览器/其他应用控件兼容性；真实取色/多屏光标对照；显示器热拔插 |
| UX04 工具栏 | 图标、选中态、就地参数，窄窗口输出可达；[合成预览](evidence/2026-09-29-capture-v2/toolbar.png) | 悬停/光标/间距和 Snipaste 逐项视觉对照 |
| UX05 标注/历史 | 新旧全部工具、当前对象调整、Shift 方形、右键保留、Ctrl+Y、清空、效果强度和橡皮擦像素断言 | 各工具全部修饰键组合的实机矩阵 |
| UX06 文字/IME | 模拟中文多行提交、参数改变保持内容、重开输入、旋转、右键完成、撤销 | 微软/第三方输入法候选窗口、旋转贴图输入框视觉体验 |
| UX07 贴图编辑 | 截图文档交接、继续标注、撤销重做、旋转/镜像后的坐标与导出像素 | 多种缩放下文字交互实测 |
| UX08 贴图交互 | 缩放/透明度分离、中键复位、内容变换、缩略图和穿透恢复 | 八边角缩放、吸附阈值、遮挡情况下的真实输入矩阵 |
| UX09 会话 | 显隐保状态、关闭恢复文档和显示状态、销毁不可恢复、恢复记录计入数量、Job/断线/正常退出 | 连续多小时与高内存压力；参考软件贴图键/关闭历史优先级 |
| UX10 连续体验 | 本应用真实按键全局/便签/背景链路；保存取消、快速保存失败、负 ACK 保留标注 | Snipaste 免费版同版本/同画布的完整逐步对照尚未运行 |

没有运行项目全量回归（`npm test` / 全窗口矩阵），没有生成新版测试安装包；Windows 10、干净机器、HDR、混合 DPI、远程桌面和特殊图形环境仍未验证。不能用旧安装包结果覆盖本轮二进制。
