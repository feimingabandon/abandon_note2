# 未完成便签移至今天：局部验证记录

日期：2026-10-15。仅覆盖本次恢复功能，未将工作区原有未提交改动纳入全量验证。

## 已实现规则

- 周/月共用工具栏入口，支持昨天、最近 3 天、全部历史和自选历史区间；按原生效自然日查询，不受当前日历月份或周范围限制。
- 历史进行中、未删除的真实便签均可预览；只有 `duration_kind=single_day` 可移动。指定天数、持续到完成保留正文和常显禁用原因。手动设置历史日期及已生成循环实例适用相同规则；未来预约和只读循环预览不移动。
- 全选覆盖所有分页的可移动项，支持逐项排除。主进程提交时重校资格、范围和当天日期；只更新原记录的 `effective_at`、`updated_at`，保留创建/完成时间、标签、附件和既有提醒，不补发生效提醒。
- “每天自动移至今天”默认关闭，全局持久化；开启立即检查昨天，之后由主进程统一调度器在启动、跨日、休眠恢复时检查，每个自然日通常一次。关闭再开启可主动重新检查。更早的历史便签由手动功能处理。
- 日历业务模态沿用队列和背景 inert。自动设置保存和后台刷新暂时禁用焦点控件后，会恢复面板内焦点或关闭后的入口焦点。

## 最终结果

| 验证 | 结果 |
| --- | --- |
| 12 个直接相关 Vitest 文件 | 131 项通过；最终 UI 修改后重跑其中 2 文件、10 项通过（不重复计数） |
| `tests/historical-note-move-db.mjs` | 64/64 断言通过，真实磁盘 SQLite、重开库，退出码 0 |
| `tests/historical-note-move-electron.mjs` | 71/71 断言通过，真实主进程、preload、周/月窗口，退出码 0 |
| 应用构建 | 正式入口最终构建通过，构建输入与工具链校验通过 |
| 修改文件局部 ESLint、已跟踪修改文件 diff whitespace 检查 | 通过 |

单元测试文件：

- `tests/historical-note-move-rules.test.js`
- `tests/automatic-note-move.test.js`
- `tests/historical-note-move-ui.test.js`
- `tests/note-duration-mode.test.js`
- `tests/feature-runtime.test.js`
- `tests/application-settings.test.js`
- `tests/settings-schema.test.js`
- `tests/help-search.test.js`
- `tests/diagnostic-actions.test.js`
- `tests/calendar-workspace-model.test.js`
- `tests/test-manifest.test.js`
- `tests/run-focused-tests.test.js`

数据库专项验证混合持续方式、千条 ID 与分页、全选排除、主进程提交重校、跨午夜拒绝旧预览、事务回滚、提醒/标签/附件保持、自动昨日范围及重开库去重、生产 IPC 授权和退出写入闸门。

窗口专项验证零可移动仍可打开、禁用原因常显、全选跳过禁用项、从其他月份移动后定位今天、当天完整列表同步、周视图开启自动开关立即移动、月/周设置共享和磁盘持久化、Escape、焦点恢复、背景 inert、纯白/纯黑/模拟复杂背景及 620×550、150% 缩放布局。月历横条容量不足时，通过当天完整日期列表核对移动后的记录。

## 可审计证据

- 数据库正式结果：`tmp/test-runs/2026-10-15T02-51-50-313Z-0wwc2z/`。
- 最终窗口及构建正式结果：`tmp/test-runs/2026-10-15T03-17-20-238Z-Qp6iK0/`，`verifiedPassed=2`，无失败、阻塞或未验证项。
- 窗口断言报告：上述目录下 `tests_historical-note-move-electron.mjs-Bs3han/standalone.json`；`completed=true`、`cleanup.status=complete`。
- 同目录保留 `gui-evidence.json`、`gui-final.png` 以及 `historical-move-{white,black,complex,narrow}.png`。

受限沙箱的 realpath 权限曾阻止 Vitest 载入；最终有效验证均使用显式 bundled Node 路径和无 Volta 优先项的 PATH，并在沙箱外运行所需专项。一次并行 Vitest 写入缓存使构建输入校验拒绝继续，已串行重跑；只以上述最终结果作为通过证据。

## 未覆盖范围

- 未运行 `npm test`、全量回归或发布验证。
- 未执行真实跨午夜长时间待机、系统睡眠硬件唤醒或主进程重启 GUI 场景；日期边界、重开数据库及调度入口由受控测试覆盖。
- 未执行物理鼠标输入、多显示器/DPI、安装/升级或打包验证。复杂背景为窗口内模拟背景。
