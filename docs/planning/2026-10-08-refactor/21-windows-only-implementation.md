# Windows 专用平台清理

## 授权、基线与保留行为

用户确认软件只在 Windows 运行，macOS 的设置、运行代码、打包入口和资源均应剔除；Apple 参考 UI 保留。先完成 [20 七项修复](20-s7-fixes-implementation.md) 验收，再执行本阶段。沿用 `tmp/windows-only/before/` 的共同恢复基线；实施前另存七项已修复版本，平台回退不得取消缺陷修复。

本阶段保留 Windows 10/11 x64、现有 Apple 材质/圆角/图标/动效、内置美术字体、提醒三种方式、窗口 ABI、更新下载政策和业务数据。第三方依赖锁文件中的跨平台可选包不是产品运行支持，不手工删除。历史复查、日志及测试证据保留原意。发布工作流用于校验/上传的 Ubuntu runner 不等于 Linux 桌面目标。

## 具体修改顺序

1. **启动守门**：bootstrap 在动态加载业务前拒绝非 win32；守门模块可独立验证。native runtime compatibility 对非 Windows 必须明确失败，不能返回 success。保留 Windows 原生 ABI 检查及故障提示。
2. **运行分支**：删除 bridge 的 macOS/vibrancy 能力、initialize 成功分支，blur-runtime 的 setVibrancy，主窗口 vibrancy/Linux fallback 与 Dock activate 生命周期。排查非 Windows resize fallback，避免留下可启动的兼容路径。
3. **提醒**：移除 macOS 系统通知禁用文案与 platform 策略参数；shared reminder mask 继续校验合法 bits。同步 ReminderService、NotificationService、scheduler、note commands、业务 IPC、preload 和测试。Windows 发送失败仍保留降级和日志。
4. **快捷键**：只接受 Windows Control/Super/Alt/Shift；metaKey 表示 Super，界面显示 Win。移除 Command/Option 别名、Mac 符号格式与 platform 参数，同步录制器、设置预览、调用方和相关单元测试。继续拒绝 Windows 保留组合与非法键。
5. **打包与 CI**：删除 `electron-builder.mac.yml`、`build/entitlements.mac.plist`、`build/icon.icns`、两个 build:mac 入口和 macos-14 CI job。native plan 仅 win32 x64，过滤采用 Windows 二进制允许列表；validator 仍拒绝非目标、缺 DLL/plugin、开发文件泄漏和损坏 ASAR。图标生成只输出 PNG/ICO。测试选择器拒绝 unsupported 平台，不再宣称转交 Mac 的职责。
6. **产品说明与 Renderer**：设置 Tooltip/帮助说明仅 Windows10/11；移除专用 OS CSS 属性、SF Mono 平台 fallback 和 macOS 抗锯齿规则。Apple 外观分支与设计注释可以保留，修改前完整遵守 UI_DESIGN_STANDARD。设备系统分类删除 mac 分支；更新 unsupported 平台负例，但不扩大更新政策。
7. **登记与收尾**：同步资产依赖、源码映射、当前 README/测试说明和 AGENTS 平台边界。扫描 active src/scripts/tests/config 的 darwin/vibrancy/icns/Mac 运行分支，逐一分类 Apple 风格、历史证据、第三方依赖与未删除内容，不能仅靠关键词清零判断成功。

## 测试规则与完成条件

按实际修改运行平台守门、native runtime、package-native-config、security-hardening、notification-policy、reminder-service、scheduler、shortcut、app-update、CI selection/manifest 等具体测试；必要构建及真实提醒/快捷键/native/window 专项另行明确。仅删除 Mac 专用测试，保留 Windows 故障与非法平台负对照。对动态调用方用检索与静态 lint 核查签名，不能只依赖源码文本断言。

完成条件：非 Windows 在业务启动前退出；只有 Windows x64 打包计划和 CI 桌面目标；产品帮助/设置没有 Mac 运行承诺；所有相应调用方一致；Apple 风格不变；局部测试、实际 runner 的业务断言和产物来源有效。没有实际打安装包时必须明确保留安装/发布风险。

## 回退

先退出应用，从本阶段前快照仅恢复平台修改文件及删除资源，避免覆盖七项修复或其他 dirty。数据 schema 18 无须因平台回退降级；不得删 journal/附件恢复证据。build/out 的旧平台产物不能与当前源混用，回退后按来源重新构建。本阶段不创建发行包、tag 或远端动作。

## 实际状态

七项修复完成后，已从 `tmp/windows-only/s7-accepted/` 开始实施本阶段。macOS 运行和构建支持清理已落盘，Apple 风格界面保留。Windows 原生层级专项仍有一个明确失败，因此不能声明全部运行验收通过。

### 实施范围与调用方核对

- 启动入口仍由 `electron.vite.config.mjs` 指向 bootstrap；平台守门在日志初始化、业务动态 import 及数据打开前拒绝非 win32，退出码为1。bridge 的非 Windows compatibility 明确失败，已删除 Mac vibrancy/能力与初始化成功分支。主窗口不再保留 Mac Dock activate、vibrancy或非 Windows resize fallback。
- 提醒策略、通道规范化、服务、scheduler、feature装配、note commands、业务IPC及preload已同步移除Mac平台参数与禁用规则；Windows富通知、无noteId普通通知、失败降级、三种提醒方式和能力对象保留。
- 全局快捷键录制、规范化及显示只接受 Control/Super/Alt/Shift；Meta录制成Super、展示为Win。删除Command/Option及Mac符号别名；局部Ctrl快捷键不再响应Meta。设置、帮助及录制器调用一致，保留Windows保留键和注册冲突保护。
- 删除Mac builder配置、entitlements、ICNS图标与两个Mac构建script。CI桌面目标仅Windows x64；native plan与beforePack用目标允许列表，打包validator保留ABI/capture检查并拒绝错误目标的原生文件。Windows Qt的 `qicns.dll` 是合法Windows插件，保留。
- 当前README、隐私/测试说明、AGENTS、资产登记和源码消费者映射已同步。内置字体、Apple材质/圆角/标题栏、PNG/ICO美术资源与更新/统计产品决策保留。第三方锁文件未人为裁剪。

全仓受控扫描的剩余匹配已分类：AppTitlebar三处macOS设计注释与UI标准属于视觉参照；CI三项删除资产仅处理D状态并拒绝重新引入；测试Darwin/非Windows名称用于拒绝负例；历史报告保留当时真实结论。没有活动Mac运行成功分支、构建入口或平台资源。删除支持不要求篡改历史证据或第三方可选依赖。

### 实际局部验证

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 启动守门/native gate/leaf/update/sandbox五个具体unit | 35/35 | `tmp/windows-only/root-platform-unit.json` |
| 清空handler五个unit | 5/5 | `tmp/windows-only/business-clear-unit.json` |
| 提醒/device及直接消费者九个unit | 57/57 | `tmp/windows-only/reminder-green-unit.json` |
| 快捷键/帮助/设置布局九个unit | 45/45 | `tmp/windows-only/renderer-unit-green-final.json` |
| package/security/CI/入口四个unit | 71/71；正式runner四项目标accepted | `tmp/test-runs/2026-10-09T07-34-06-403Z-VObSEo` |
| 最终manifest/focused/CI三个unit | 93/93；包含与上行重复的CI18例，不相加成唯一用例总数 | `tmp/windows-only/final-registry-unit.json` |
| Windows当前app必要构建 | exit0，输入/工具链provenance verified | `tmp/test-runs/2026-10-09T07-39-50-892Z-hXq5tc` |
| 实际SQLite/文件/Reminder清空协调 | 58/58、accepted、证据/清理complete；通知传输受控，无OS toast | 同上business-clear |
| 实际app feature/窗口/托盘/准入 | 67/67、accepted、证据/清理complete | 同上feature-runtime |
| 设置写队列及实际Renderer | 63/63、accepted、证据/清理complete | 同上settings-queue |
| 提醒legacy Electron专项 | exit0、完成marker齐全、独占profile已清理；不冒称统一accepted认证或精确计数 | `tmp/windows-only/reminders-attempt-2WVwWg/result.json` |
| 快捷键legacy Electron专项 | 三child冲突/会话/同profile重启完成、exit0、marker齐全、独占profile已清理 | `tmp/windows-only/shortcuts-attempt-ILVF5y/result.json` |
| 原生毛玻璃/层级实际app专项 | **失败，exit1，accepted=false，completed=false**；前33个记录断言通过不等于整项通过 | 同上native-leaf-runtime |

各变更域具体文件严格lint/语法/格式及diff检查通过。主代理查看提醒窄窗、大字体、复杂壁纸与快捷键冲突黑色背景截图，Apple参考外观、三通道及文案保留。快捷键真实注册与窗口层级由Win32查询，录制/动作触发仍使用KeyboardEvent及integration hooks，不能称为物理组合键认证。提醒专项不证明真实toast按钮/协议关联或冷启动。

### 原生失败及后续处置

正式失败位于 `tmp/test-runs/2026-10-09T07-39-50-892Z-hXq5tc/tests_native-leaf-runtime-electron.mjs-08Lnwo/standalone.json`，失败profile与日志保留。glass=false的normal/top/bottom全部完成，glass=true的normal完成，在normal→top的第五次IPC抛出“窗口层级未能同步”。日志显示实际主窗口topmost正确、置底已解除、blur healthy/initialized正确，但 `zOrderSynchronized=false`，非Dock隐藏/滑动场景。

该表现与09指导中历史Overlay失败同型。`z-order-runtime.js`相对S7快照不变；blur-runtime/bridge本阶段Windows调用路径未改变。只能确认旧问题仍可复现，不能据此宣称已确定原生根因，也不能归咎于平台删除。保留原断言，不延长等待赌绿、不忽略不同步、不改历史失败为通过。后续先采集实际parent/Overlay band、可见性、位置及夹在两者间的HWND链，按证据决定窄修；修改native运行语义需同步ABI、重建DLL并重新核验真实状态。

随后仅在tmp增加隔离采样包装器，动态导入完全不变的正式native-leaf脚本，读取Win32状态、不调用setter、不增加等待、不改断言。独立诊断 `tmp/windows-only/overlay-attempt-qZzEl0/result.json`：原脚本exit0、completed=true、52/52，probe-end完整、28次采样、无probe错误、测试/out/DLL哈希前后不变。profile与证据有意保留。全局窗口链达到256项安全上限，虽然看到一个Overlay匹配，但不能据截断链认证唯一性或完整顺序，分类保持inconclusive。采样本身可能影响调度；这次诊断既未复现失败也没有确立原生根因，**不替换首次正式失败、不认证问题修复、不登记accepted通过**。未修改native或ABI，也未重建DLL。后续应先改进有界精确Overlay枚举并捕获实际失败；若仍缺STA处理完成证据，再按专门指导加最小原生诊断、同步ABI和必要构建，不能按猜测修改排层算法。

### 恢复资料与未执行范围

`tmp/windows-only/final-audit.json`记录相对S7基线的实际文件增量、验证结果及十个S7关键owner的逐字节保留检查。最终阶段快照按 `tmp/windows-only/save-stage.cjs windows-only-complete` 保存；目录名表示本阶段源代码清理快照，不是全部原生专项通过认证。各域具体实现、红绿与恢复哈希位于 `tmp/windows-only/{package,reminder,renderer}-implementation.md`。

最终只读生命周期复核未发现本轮启动绕过、删参调用遗漏或S7回退，范围与三个基线原生cleanup/no-op分支的消费者分类见 `tmp/windows-only/final-lifecycle-audit.md`。阶段四份文档66个Markdown文件目标存在；该检查不认证anchor语义或所有历史文案。当前app的完整源码/依赖、output、工具链及环境闭包经正式runner同一normalizedEnvironment再次核对，verified且changedSections为空。临时audit最初缺少proofDirectory参数、随后未采用runner环境规范化产生的两次检查失败分别保留于 `audit-invalid-descriptor.json`、`audit-unnormalized-environment.json`，它们是审计工具调用错误，不是业务断言失败，不修改正式build proof。

未运行npm test、全量窗口矩阵、完整回归、Qt全集、云端CI或发布验证；未打安装包、安装/升级/卸载、tag、commit、push、发布或部署。未覆盖Windows10真机、多屏/混合DPI、物理快捷键、toast冷启/点击、真实休眠/Explorer恢复、客户安全软件和长期运行。上述事项与原生同步失败不能因本阶段支持清理完成而消账。
