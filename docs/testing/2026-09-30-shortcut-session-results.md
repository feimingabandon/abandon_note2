# 2026-09-30 临时禁用快捷键与托盘状态

## 最终行为

- 禁用状态只保留在当前主进程内存中，不再读写数据库中的 `shortcuts:enabled`。旧版本保存的禁用值被忽略，自定义截图和视图显示快捷键继续持久化。
- 完整退出并重启后恢复启用；隐藏到托盘、切换列表/月/周视图、设置刷新、取消录制和恢复默认设置均不结束本次临时禁用。
- 托盘菜单固定显示“禁用全部快捷键（本次运行）”，禁用时勾选，启用时取消勾选。
- 禁用时使用应用图标加红色减号角标，悬停显示“便签 · 快捷键已禁用（重启恢复）”；启用时恢复正常图标和提示。角标在启动时生成并缓存，提供 16/20/24/32/40/48 像素表示。
- 保留工作区同期提醒功能的托盘基础图标接入，未改动提醒业务逻辑。

## 验证

1. 五个指定 Vitest 文件共 **69 项通过**：`application-settings.test.js`、`settings-schema.test.js`、`capture-shortcut.test.js`、`view-visibility-shortcut-service.test.js`、`view-visibility-shortcut-ui.test.js`。
2. `tests/view-visibility-shortcut-electron.mjs` 在 Windows 沙箱外串行启动两个真实 Electron 主进程，使用同一个隔离配置目录。第一轮种入旧版禁用值，确认启动仍启用；验证菜单复选状态、真实 Tray 图标调用、提示、全部注册注销、冲突、录制、设置同步、恢复默认、视图切换和托盘隐藏恢复。结束时保存自定义按键并保持禁用；第二轮确认自动启用、保留按键且实际注册成功。
3. Electron/Vue 生产构建通过，`git diff --check` 通过。
4. 指定源码与测试文件 ESLint 为 0 错误。最后检查时 `src/main/index.js` 中同期提醒功能的新增代码仍有 11 项 Prettier 警告，未格式化其他工作的代码；本轮快捷键改动无格式警告。
5. 检查实际传给 Tray 的禁用图标，红色减号角标可见；恢复启用后图标 PNG 与原图一致。

日志与图标证据：`tmp/shortcut-session-20260930/`，包含 `build.txt`、`electron.txt`、`lint.txt`、`tray-enabled.png` 和 `tray-disabled.png`。

## 范围限制

- 未运行全项目回归、Windows 10 或真实混合 DPI 显示器测试；多尺寸图标不等同于实机多 DPI 验收。
- 已更新 `tests/capture-package-smoke.cjs` 的重启预期，但未重新打包或执行安装包专项。
- 本轮没有改动 renderer 界面，没有提交、安装或发布。
