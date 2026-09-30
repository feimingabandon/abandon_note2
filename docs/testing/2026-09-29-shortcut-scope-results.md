# 截图快捷键收敛、总开关与贴图功能删减

日期：2026-09-29。范围仅限本轮快捷键、贴图删减和截图画质评估；保留工作区其他未提交修改。本轮未提交 Git、未生成安装包、未发布。

## 当前行为

- 截图默认 F1，可录制和清空；已保存的按键保持原值，不强制覆盖。
- 删除剪贴板贴图、显示/隐藏全部贴图的全局快捷键及设置项，旧数据库行被忽略。这两个动作仍可通过托盘执行。
- 托盘“禁用全部快捷键 / 开启全部快捷键”统一控制应用注册的全局快捷键（截图、视图显示），开关持久化到 application 作用域。禁用后释放按键、忽略残留回调；修改按键、结束录制和重新初始化不会绕过开关。启用时占用冲突在设置中显示，其他动作继续可用。
- 恢复默认设置会重启全局快捷键、恢复截图默认 F1，并刷新托盘文案。窗口内编辑/复制等按键不受全局开关影响。
- 删除贴图鼠标穿透以及关闭全部贴图的菜单、原生命令和实现。单张关闭/销毁、最近关闭恢复保持可用；完全退出便签仍回收全部贴图。装饰光晕仍不拦截鼠标。
- 开发目录中的 Qt 组件已经更新。正在运行的 Electron 主进程需要重启，才能使用新的托盘菜单和快捷键逻辑。

## 已执行验证

| 验证 | 结果与范围 |
| --- | --- |
| Vitest 指定 6 文件 | 71 passed：`capture-shortcut.test.js`、`view-visibility-shortcut-service.test.js`、`view-visibility-shortcut-ui.test.js`、`capture-recorder-owner.test.js`、`application-settings.test.js`、`settings-schema.test.js` |
| ESLint | 本轮变更的 JS/Vue 和测试文件通过；后续 reset 修改的两个文件再次通过 |
| electron-vite build | 通过，包含最终托盘重置同步修复 |
| CMake | `AbandonCapture`、`capture_ui_tests`、`capture_pin_halo_tests`、`capture_core_tests` 构建通过 |
| Electron `shortcuts` 专项 | 通过；隔离 SQLite 配置、保存的禁用状态启动、实际 globalShortcut 注册/释放/冲突、禁用期间更新与取消录制、残留回调抑制、设置状态同步、旧快捷键移除、托盘入口、恢复默认后开关和文案同步 |
| Qt 贴图指定用例 | `pinTransformsEditingAndDisplay`、`pinDocumentHandoffAndRecovery`、`pinLimitsAndOriginalPixels`：5 passed（含 init/cleanup），覆盖变换/编辑/恢复及显示缩放不改变底图像素 |
| Qt 编码指定用例 | `formats`：3 passed（含 init/cleanup），PNG 像素往返、JPEG 透明底转白、支持格式和错误路径 |
| Qt 光晕专项 | 最终 7 passed、1 skipped。几何、随窗口变换、显隐/销毁、资源清理及衰减检查通过；真实桌面命中与屏幕像素检查因锁屏未验收 |

光晕首次原生命中断言失败后，诊断得到命中窗口为 explorer.exe 的 `LockScreenBackstopFrame`，测试背景矩形及输入状态正常；随后用引擎现有的交互桌面检查确认处于锁屏状态。测试已增加明确的锁屏前置条件，跳过项不计为通过。用户解锁后需重跑原生命中项及真实输入截图专项。

证据目录：[shortcut-scope](evidence/2026-09-29-shortcut-scope/)。保留首次失败和诊断日志；最终结果见 `halo-final.txt`、`pins.txt`、`formats.txt` 和 `electron-shortcuts.json`。

新组件源文件与部署文件 SHA256 一致：`310F26894EA168C39709E75FB946E3C2B5D90468643C714DC5FA153BB0B08A85`。替换时只结束了路径及父进程均核实属于本仓库的截图 helper，保留 Electron 主进程。首次复制因 helper 尚未完全退出而被占用，等待退出后复制成功并校验哈希；见 `deployment.json`。

## 画质核对与建议

- Windows `DesktopCapture.cpp` 使用显示器实际物理尺寸和 BitBlt 读取 32 位图像；选区裁剪保留物理像素，多屏合成不按逻辑 DPI 缩小。窗口显示大小、贴图透明度不改变导出的图像尺寸。
- 复制使用原像素图像；PNG 为无损编码。`ImageDocument.cpp::saveImage` 的 JPEG 质量固定为 95，属于有损编码。PNG 的编码参数不意味着像素损失。截图送入 Electron 的 PNG 校验也不重新缩放或编码。
- 当前没有用户可调的画质/放大设置。本轮只做评估，未增加 JPEG 调节或超分辨率功能。
- 建议默认继续使用“原始尺寸 + PNG”；如要控制文件体积，可增加 JPEG 质量选择。另可提供明确标注的“放大导出”，保持宽高比，避免把区域截图拉伸成固定屏幕比例。
- 例如全屏为 1920×1080，则直接截图也是 1920×1080；裁剪区域按区域实际尺寸输出。插值放大到 2560×1440 或 3840×2160 只能增加像素数量，无法恢复原本未渲染的细节。AI 超分可能补错文字或 UI，不能称为原生 4K。真实更多细节需要源内容本身以更高分辨率渲染/导出。
- 当前 GDI 路径针对普通 SDR/8 位画面；未验收 HDR、广色域或原始 10 位色彩，不承诺所有显示模式下颜色完全等同。

## 未覆盖

未运行全量回归、`npm test` 或窗口全矩阵。本轮没有完成解锁后的真实按键触发截图、实际桌面光晕命中复验、物理双屏/混合 DPI、Windows 10 和安装包验收。后续测试安装包继续使用[双屏用户验收单](capture-multimonitor-user-checklist.md)，不把模拟布局或本轮代码测试当作双屏实机通过。
