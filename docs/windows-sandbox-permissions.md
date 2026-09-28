# Windows 安装目录的沙箱权限

Electron 43 的受限进程需要读取安装目录中的程序和 Chromium 资源。
本次故障通过为实际安装目录添加 `S-1-15-2-2` 的可继承读取/执行权限恢复，
不需要修改数据库、移除中文路径或关闭 GPU / 沙箱。原始 ACL 为什么缺少权限仍未查明。

## 安装行为

`electron-builder.win.yml` 引用 `build/windows/installer.nsh`，在文件解压完成后、首次启动前调用
`build/windows/sandbox-permissions.ps1 -Mode Repair`。新装、覆盖安装和升级均经过此钩子。

1. 检查实际 `$INSTDIR` 的应用布局，拒绝盘符根目录和目录树中的重解析点（如目录联接）。
2. 将安装目录及全部子项的原 DACL 保存为本地 JSON 报告；备份写入失败则不修改权限。
3. 遇到已识别的读取/执行拒绝规则，或缺少授权且禁止继承的子项，停止处理，不重置权限。
4. 仅对安装目录执行 `icacls <目录> /grant *S-1-15-2-2:(OI)(CI)(RX)`；保留原 ACL 和所有者。
5. 重新读取全部子项，验证所需 Allow 规则及已识别的 Deny 规则。成功才继续安装流程。

报告使用安装器临时目录中独立生成的文件（内容为 JSON，扩展名可能为 `.tmp`），
路径显示在安装详情和失败提示中。保留报告后再清理临时文件。
报告包含原 DACL 中的账户 SID，仅在本地保存；诊断摘要不包含完整 DACL 或账户 SID。
如果授权后验证失败，报告保留修改前的 DACL，不自动回滚或删除 Deny。

失败时交互式安装器显示提示，静默安装器返回 `1603`，两者都不执行自动启动。
文件可能已经解压、快捷方式和卸载信息可能已经写入；这不是安装事务回滚。
处理报告指出的原因后重新运行安装器。脚本不修改安装目录以外的父目录或用户数据权限。

## 诊断导出

打包后脚本位于 `resources/diagnostics/sandbox-permissions.ps1`。
导出诊断时调用 `Inspect`，将 `sandboxPermissions` 加入系统快照，读取根目录、可执行文件、
`icudtl.dat`、`resources`、`resources/app.asar` 和 `locales` 的 ACL 摘要。
它不修改权限；PowerShell 被策略阻止或超时时，导出保留错误说明，其他诊断仍可导出。
应用启动不执行权限修复。

`hasRequiredAllow` 和 `hasKnownReadExecuteDeny` 是 ACL 规则检查，不是对真实 Chromium 令牌的
完整有效访问权限计算。缺少指定 Allow 不单独证明一定会崩溃；其他组的拒绝规则、安全软件、
系统策略等也需要结合崩溃日志分析。手动复制的免安装目录不会经过 NSIS 修复钩子。

## 专项验证

遵守 `AGENTS.md` 的 Node 路径要求；Windows 专项在正常桌面权限环境执行，
每个脚本只创建和操作仓库 `tmp/` 下独立的测试目录，并保留证据。

- Vitest：`tests/windows-sandbox-permissions.test.js`、`tests/system-diagnostics.test.js`、`tests/package-native-config.test.js`。
- Windows PowerShell 5.1：`tests/sandbox-permissions-win.ps1 -Workspace <仓库绝对路径>`。
  验证中文和特殊字符路径、只读导出、完整备份、继承、重复执行、升级新文件、Deny、禁止继承、联接、缺失文件及备份失败。
- Windows PowerShell 5.1：`tests/sandbox-installer-win.ps1 -Workspace <仓库绝对路径> -Makensis <makensis.exe>`。
  编译生产钩子并静默安装到测试目录，验证重复安装、成功后续步骤、失败 `1603` 和不启动。
  不写正式应用的注册表、快捷方式或卸载信息。
- Windows PowerShell 5.1：`tests/sandbox-electron-win.ps1 -Workspace <仓库绝对路径>`。
  使用 Electron 副本、最小 ASAR 和独立用户数据目录，修复后无启动参数运行，
  验证页面加载、JavaScript、渲染进程沙箱和 GPU 沙箱；这不等于受影响电脑上的完整应用复测。
- Node：`tests/sandbox-diagnostics-win.cjs <Windows 测试包的 win-unpacked 目录>`。
  验证生产 JS 采集器读取打包内的脚本，安装了 PowerShell 7 时还验证它的模块路径不会干扰 Windows PowerShell 5.1。
- 构建当前应用，并以 `--publish never` 和独立输出目录生成 Windows NSIS 测试包。

本机验证环境为 Windows 11。最终验收仍需受影响的 Windows 10 电脑使用新安装包安装/覆盖升级，
托盘彻底退出后多次双击冷启动，并检查点击、拖动及新诊断日志。
正式安装器的交互式提示、标准用户提权、多用户安装及企业策略限制也需相应环境验证。
