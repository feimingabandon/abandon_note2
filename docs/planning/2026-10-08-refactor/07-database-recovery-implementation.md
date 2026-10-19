# B3c / B5b 数据库生命周期与附件恢复实施记录

日期：2026-10-09。对应实施汇总 §10 B3c、§12 B5b 的独立 DB 域。本域已实施并通过下述局部验证；应用层清空准入、草稿/提醒/便利贴及窗口接线随后已在 [16](16-b7a-feature-and-clear-guidance.md) 完成，最终58磁盘/40真实app证据见 [04 §25](04-implementation-plan.md#25-明确授权后恢复实施2026-10-09)。本记录的原DB验证仍只签其具体范围。

## 1. 范围和最终拥有者

| 模块                     | 最终职责与端口                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `db-connection.js`       | 唯一可写连接句柄。getDb 保留已初始化要求；新增只读 getDbIfInitialized，供生命周期和兼容门面查询                                           |
| `db-runtime.js`          | initializeDatabase({ userDataPath })、closeDatabase；候选连接配置/备份/迁移完成后才安装；没有另一份可写 DB 镜像                           |
| `attachment-recovery.js` | 整体拥有 staging/添加/删除/reset 的扫描、判断、幂等恢复、现场保留及 onRecovery；显式 userDataPath、resolveAttachmentPath                  |
| `business-data-reset.js` | resetBusinessData({ userDataPath })：完整文件暂存、同步 SQL、失败补偿、提交标记与异步清理；不持有窗口/renderer/platform runtime           |
| `db.js`                  | 兼容旧 initDatabase/closeDatabase/getDb、设置 repository 与恢复/清空入口；仅在门面解析 Electron userData/图片路径，具体操作不再塞在门面内 |

应用主入口由父代理将 initDatabase() 接为 `initDatabase({ userDataPath: app.getPath('userData') })`。门面无参用法继续支持旧脚本，getDb 仍返回当前连接或 null；业务 DB 模块继续从同一 db-connection 取连接，没有新增容器/数据库实例。

初始化次序保留：打开 userData/app.db → WAL → synchronous NORMAL → cache_size -8000 → foreign_keys ON → 迁移前备份 → schema/版本 → 发布连接。失败关闭候选并清引用。正常 close 关闭成功后清引用；无连接可重复 close。

新增明确的生命周期保护：已有已安装连接时 initializeDatabase 拒绝重入，不打开或覆盖第二连接。正常产品主入口原本只有一个 init 调用；本保护在独立单元与真实 SQLite 中验证。没有修改 schema、迁移脚本、数据库文件名、用户路径或迁移版本 17。

## 2. 恢复/业务清空的完整操作

恢复保留 operation.json/target.json/committed、.attachments-staging、.attachments-deleting-reset-\*、attachments 的原布局和顺序。删除未提交时按仍存在 DB 行恢复 payload；添加未提交的最终孤儿文件清理；已提交附件保留；未知/冲突/失败现场保留。reset 未提交且业务行仍在时恢复旧附件目录，committed 或业务数据已清时只清 pending。onRecovery 的事件语义保持。

清空保留原顺序：重命名附件到本次唯一目录 → 同步事务按 desktop_stickies/template_tags/note_tags/note_attachments/note_templates/notes/tags 清理 → SQL失败恢复目录 → 成功写 committed → 异步删除 pending。SQLite 事务内没有 await。app_settings 和 OS 自启不受影响。

提交后 marker/异步清理错误继续记录且保持业务成功，留 pending 给下次恢复。新 reset 模块提供窄 removeDirectory 依赖端口，默认原 fs/promises.rm；真实 SQL/文件专项只替换最后清理，证明故障不会把已经提交的清空改报失败。门面不向 renderer 暴露该依赖。

index 的应用层清空协调没有被数据库子代理改动。clear-note-data 的草稿、renderer generation、reminder/sticky 和广播仍应在其主进程/renderer 批次一起验收；设置 reset 的 scope/geometry timer/dirty/UI 队列也未在本 DB 拆分时改成新语义。

## 3. 测试处置和实际结果

| 验证                                                  | 实际结果                                                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 修改前 attachment-storage-electron.mjs                | 30/30 实际断言，退出 0，证据/清理 complete                                                                           |
| database-runtime.test.js 与诊断文件中唯一相关恢复断言 | 4 passed；诊断文件另外 4 项本批未选、skipped，未算作通过                                                             |
| 本批九个实际代码/测试文件 ESLint --no-cache           | 退出 0；格式化仅本批文件                                                                                             |
| database-runtime-db.mjs                               | 25/25 实际断言，退出 0，证据/清理 complete                                                                           |
| attachment-storage-electron.mjs 改后                  | 30/30 实际断言，退出 0，证据/清理 complete                                                                           |
| attachment-recovery-reset-electron.mjs                | 控制器 18/18；独立 seed 子进程 2/2、recover 子进程 19/19，各退出 0/完整报告；不把子计数重复合并到控制器报告          |
| settings-repository-db.mjs 兼容验证                   | 39/39 实际断言，退出 0，证据/清理 complete                                                                           |
| 所有权、消费者、源码/空白与进程核对                   | 唯一 db-connection 句柄；门面无 let db/new Database；schema/backup 文件未修改；本次相关进程无残留；diff --check 通过 |

生命周期真实保护包括 actual WAL/pragmas、业务与设置同连接、关闭重开、第二 init 拒绝、V7 废弃 Dock 行清理前的实际 VACUUM 备份和备份原值、未来 schema 拒绝/引用清除/可重开。普通关闭重开仍是同一进程，不能说成完整主应用两轮重启。

双进程恢复使用同一个隔离的真实磁盘 profile。seed 子进程手工构造与原协议一致的“附件已移出、业务 SQL 尚未提交”快照，然后不调用 closeDatabase 而结束进程；recover 子进程重新打开实际 WAL DB，恢复并重复运行证明幂等。随后实际 clearNoteData 的 SQL trigger 故障验证事务/文件补偿，实际 SQL 提交后清理端口故障验证“业务成功 + pending待恢复”，再次恢复证明已提交数据不被重新还原。该场景是人为构造中断快照，不声称已逐个崩溃点杀进程或覆盖断电故障。

既有诊断测试的附件源码读取位置从 db.js 改到真实 attachment-recovery.js，原 onRecovery 保护没有删除。没有删除已有测试。backend-integration.mjs 没有改动/执行，其 broad 业务断言不会被本次独立来源/恢复验证冒充为通过。

## 4. 证据、运行环境和剩余边界

- 恢复基线：`tmp/refactor-baselines/B3c-B5b-2026-10-09T09-09-45`，保存本批前八个源码/保护文件，包括已完成 B1 的 db.js 和 settings-repository-db.mjs。
- 修改前附件证据：`tmp/test-evidence/B3c-B5b-baseline-2026-10-09T09-11-18`。
- 最终四专项证据：`tmp/test-evidence/B3c-B5b-verified-2026-10-09T09-19-34`；1 lifecycle、2 原附件、3 双进程 recovery/reset、4 设置兼容。3 内保留 child-seed.json/child-recover.json/child-counts.json 及原始 stdout/stderr。
- 各专项逐项新 attempt/runToken/profile，核对 suite/token、raw exit、completed、非零实际断言、失败/跳过与证据/清理状态。没有把 intentional cleanup fault 的日志误报成产品失败。
- Node/Vitest/ESLint 从第一条命令显式使用指定 runtime 并去 Volta PATH；正常 Electron 全部从第一次在沙箱外执行。没有 app/native/Qt 构建、GUI矩阵、全量测试、打包/安装/发布。

未覆盖：真实主应用清空时在途截图/保存/renderer慢查询、Q-004 的 MonthWorkspace clear/remount 旧结果、提醒/便利贴最终 UI、设置 reset 第二 scope 失败、硬断电/任意崩溃点、外部文件占用/磁盘不足/权限变化及 macOS。对应应用层/存储/renderer 子批次须补实际证据，不能因 DB 域通过而跳过。

## 5. 后续接线和回退步骤

父代理登记：database-runtime.test.js 为 unit；database-runtime-db.mjs 为 database/electron、模式 `electron-ready-disk-sqlite-runtime-migration`；attachment-recovery-reset-electron.mjs 为 database/storage/electron、模式 `electron-disk-attachment-recovery-reset-two-process`。两专项只消费当前源模块和 Electron SQLite ABI，无 app/native 构建依赖。诊断源码读取映射更新为新 recovery 文件。

回退本域时，先停止本次仓库测试/开发进程，恢复此基线 files/ 下的 db.js、db-connection.js 和诊断测试，再撤除 db-runtime/attachment-recovery/business-data-reset 与三新增测试及父登记。主入口注入 userDataPath 是兼容参数，旧无参实现忽略额外参数；若连 B1 一起退回，应按 B1 的独立恢复链同步恢复窄 repository/runtime/消费者。

不要把基线 app.db 复制覆盖最新用户资料，不倒退 schema，不删除用户 attachments。恢复源码后重新生成匹配 app out；pending 协议未改变，可继续由匹配恢复实现处理。若后续 batch 已依赖新模块，回退依赖批和接口一起进行，不能只删除新文件或覆盖父代理随后对 index 的修改。
