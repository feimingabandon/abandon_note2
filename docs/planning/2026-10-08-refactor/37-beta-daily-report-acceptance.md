# 37：日报导出专项窄修与验收指导

日期：2026-10-10。产品边界为 Windows 10/11 x64、单机单人。此阶段仅修改 `tests/daily-report-ipc.test.js`、`tests/daily-report-electron.mjs`，保留已有保护并补足实际可达的导出边界；不修改生产 owner、manifest、执行 mode 映射或 domain 范围。运行由根代理统一串行安排，本稿初始状态为准备与实现，不表示测试通过。

## 一、恢复点与已有保护

恢复目录：`tmp/beta-readiness/daily-report-before-20261010-152343-928`，两份原文件及 `restore.json` 已保存。

| 原文件                    | SHA256                                                             |
| ------------------------- | ------------------------------------------------------------------ |
| daily-report-ipc.test.js  | `750522d99281094d4d361d3be2c9132a7cdc9d68f5a36b2a2c9e1b478452e1d6` |
| daily-report-electron.mjs | `6d67457b94bca2b24b7170129b921fd8b6db3a7c3bd117072d0da3b1b5d7f58b` |

IPC 原正例必须保持真实 XLSX 写入与 ExcelJS 回读、完成状态及中文内容的原 expect。GUI 原双日期控件、默认 TXT、单日/两日预览、两个 DatePicker 的真实键盘操作、Excel 格式切换、五/六/五行月份及窗口边界断言必须保留。静态验收通过 AST 提取完整 expect/assert 表达式及 DatePicker helper 调用，按 multiset 对照恢复点，不能以新的简化断言替代旧保护。

## 二、IPC 定向增强

真实 `registerDailyReportIpcHandlers` 为三个接口先执行主窗口 sender 授权：preview、export、open-export-folder。测试仅 mock 数据库候选查询及 Electron 的 dialog/shell；`fs/promises` 的 access/writeFile 用带调用记录的真实实现，文件编码与写入失败仍来自操作系统。

1. 三个当前接口各调用一次 outsider sender，均明确拒绝。输入使用正常日期与便签 ID，不使用 IPC 洪泛；核对 SQL 查询、保存对话框、文件 access/write、shell 均没有调用，隔离输出目录保持为空。
2. 正常授权下用户取消保存，即使返回了 filePath 仍不写文件；允许生产现有的导出前重读行为，不误要求取消前不能查询。核对取消结果、保存对话框与输出目录，取消不能建立“最近成功导出”位置。
3. 先真实成功导出，再把第二个保存目标设为测试自有目录，使真实 writeFile 因目标为目录而拒绝。失败不得改写先前成功文件；随后打开最近导出位置必须仍指向先前成功文件，不能指向失败目标。不得 mock 一个预设 writeFile error 后声称完成真实文件失败验证。

## 三、真实 GUI 导出与证据

GUI 使用 `createElectronGuiResultLifecycle` 的独立 attempt/profile、实际应用主窗口、真实 preload/IPC、真实 SQLite 与实际报表生成器。仅系统 `showSaveDialog` 返回受控保存路径，不替换 renderer API、IPC handler 或导出 buffer。文件全部写入 attempt evidence 的自有子目录；不访问或写入剪贴板。

- 在原日期/预览保护全部完成后，从两日预览中取消昨天便签，只选择今天，通过真实“TXT/导出 TXT”按钮导出；独立读取 UTF-8 BOM 和完整文本，固定中文内容、日期范围、状态及生效时间，并确认未导出取消选择的便签。
- 关闭真实导出成功确认框、重新从标题栏打开报表，将日期恢复到昨天至今天，取消今天便签，只选择昨天，通过真实“Excel/导出 Excel”按钮导出；ExcelJS 独立读取实际 XLSX，核对列头、只有一条正确便签、状态、是否完成、时间与持续天数。
- 增加一个范围外便签作为正常边界负例，保持原单日 1 条与两日 2 条期待不变。文件期待来自测试种子数据和固定文本，不能调用生产生成函数计算期待值。
- 保存两个导出文件、独立回读摘要与 SHA256、系统保存对话框调用、最终 GUI 状态/截图。失败时保留 profile、已写文件、当前模态/日期/勾选现场；由生命周期统一执行正常 app.quit 与 cleanup 协议，不手写提前 process.exit 或删除失败现场。

日期助手继续使用独立 strict assert。结果 recorder 只累计本套件实际调用的 lifecycle.assert；不推算或补填助手断言数量，摘要仅记录哪次助手完整返回。此专项不证明实际 Windows 保存对话框点击、系统 Excel 程序展示、混合 DPI、多屏、剪贴板或用户硬件卡顿根因。

## 四、接线、执行与停止规则

最终精确 mode：`electron-real-app-daily-report-selected-range-txt-xlsx-export`。helper/mode/manifest 接线由根代理统一维护，本代理没有直接修改。以下为本次静态核对的依赖建议，精确数组保存在 `tmp/beta-readiness/audit/daily-report-static-preservation.json` 的 `registryHandoff`；数组描述已核对的报表路径及原日期/模态保护，不冒充整个应用启动 import 闭包。

| 目标                      | 直接依赖                                                                 | 应补的实际间接归属                                                                                                                                                                                                                                                                                                                                                                    | buildJobs                                |
| ------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| daily-report-ipc.test.js  | register-daily-report-ipc.js 已登记                                      | ipc-authorization.js、services/daily-report.js、shared/calendar/calendar-date-rules.js；db-notes 为 mock 边界，不能标成真实 SQL 验收                                                                                                                                                                                                                                                  | 无                                       |
| daily-report-electron.mjs | date-picker-keyboard.mjs 与 electron-gui-result-lifecycle.mjs 已自动登记 | test-result-recorder.cjs；main/index、日报 IPC/授权/服务、db-notes/connection/runtime/schema、query 的 operation-performance；preload/index；App、DailyReportButton/Dialog、DatePicker、ConfirmDialog、AppModalShell、BaseButton；实际 modalFocus/modalBlur/modalQueue/anchoredPopover/popoverMotion/inputComposition、useQueuedModal/usePopoverLifecycle；shared calendar-date-rules | 保持现有 build-app，不新增其它构建 owner |

GUI 既有 runtime prerequisites 为 windows-desktop、Electron ABI 兼容 better-sqlite3、blur-engine-abi-22、capture-qt-deployment 与 electron-runtime。应用启动会预热截图 helper，不能因本专项不点击截图就删除已登记的真实启动前提。

运行安排：先单独 `daily-report-ipc.test.js`；再执行 GUI 必需的 Electron 构建与 `daily-report-electron.mjs`，固定 Node、去 Volta PATH，真实 Electron 一开始在沙箱外执行。以标准 result 的业务完成、实际断言、退出码、证据完整与 cleanup 为准。构建/GUI 未获执行时段前不启动；不运行 npm test 或全量窗口回归。

如果新用例揭示生产失败，保存具体输入、返回、文件/数据库/界面证据，先给出最窄 owner 与修复方案；不得修改期待适配错误输出，或扩大为其它功能/全量重构。如果原有日期 helper 或生命周期失败，保留原保护和现场，区分业务失败与缓存/GPU/权限等启动环境阻塞。

## 五、实现与验收状态

已完成两测试的上述窄范围实现：保留原 XLSX 正例，新增三接口授权、取消与真实写失败保护；GUI 使用独立 profile/lifecycle，保留原日期/预览/动态面板测试，并通过真实操作导出两个不同选中子集。仅系统保存对话框响应受控，测试种子库及两个输出文件均真实。

已执行 `tmp/beta-readiness/audit/daily-report-static-preservation.cjs`。同名 JSON 的 `accepted=true`：IPC 原 **4 处 expect**、GUI 原 **7 处 assert** 完整 AST 表达式均保留，原日期助手 callsite 也保留。原助手在开始/结束两个日期循环执行，但一个静态 callsite 不能当作一次或多次运行断言；新断言的静态数量也不当作运行通过率。该脚本只解析测试文本并核对依赖路径，不导入生产函数执行。

GUI 当前通过 lifecycle 统一 finish/正常 app.quit；移除原 process.exit、app.exit 与失败立即 rm 的自写退出分支。成功/失败摘要分别记录预期及实际存在的导出文件；失败采集当前日期、勾选范围、模态文本，profile 和已经产生的文件保留。两个自建 SQLite 连接均由 finally 关闭，系统保存对话框在 finish 的 restore 中恢复。最终截图前请求实际前台渲染帧，不据此宣称真实硬件性能已经验收。

本次局部 Prettier check、ESLint（max-warnings=0）、静态保全与限定文件 git diff --check 均已完成、退出码 0；现在可交根代理集中串行验收。**当前未运行 Vitest、Electron 构建、GUI、全量测试或全量窗口回归。** `gui-final.png`、`gui-evidence.json`、`daily-report-exports/*.txt/*.xlsx` 与 `daily-report-export-readback.json` 是运行时计划产物，目前不声称已经生成或通过。运行后须回填标准 attempt 目录、业务断言/退出码、文件回读与 cleanup；若实际失败仍按第四节停止规则处理。
