# 审查准备与后续修改指导

版本：v1，2026-10-08

阶段：S3 审查准备

状态：原S3方案保留；16个R分类审查、成立缺陷修复、测试处置和本次收尾已完成，见 [15数据审查](15-b7b-data-review.md)、[17运行域/测试审查](17-b7b-runtime-review-and-test-disposition.md)。历史暂停见 [04 §24](04-implementation-plan.md#24-全部批次准备完成与代码暂停时的真实状态)，最终结果见§25。下文原S3未执行描述仅作历史记录；静态读取和局部证据不代表每条源码语义/全部功能验收。

阶段索引：[README.md](README.md)

测试规则：[01-testing-guide.md](01-testing-guide.md)

解耦方案：[02-decoupling-guide.md](02-decoupling-guide.md)

## 1. 目标、基线与授权边界

本阶段回答：以何种方式审查当前项目；优先核查哪些链路；如何判断问题成立；确认后怎样修改、验证和回退。R 条目是审查任务，不是预先认定的 16 个 Bug，也不要求每个条目都产生代码修改。

本轮读取基线：`4fbc52be1c688dba9cf23fbbd51539606efbf381`。开始时 `git status --short` 为空。该检查点已经包含前期 UI、原生截图、测试资产及 S1/S2 文档；本轮不创建提交、不推送。实施前重新核对 HEAD、工作区与产物，不能假设文件一直不变。

S1/S2 中 `1111ce29dc57f8459a3f6f783eedad4d92b563c5` 是编写时的历史基线，包含当时工作区内容；同日归档说明见 [重构前检查点](../../testing/2026-10-08-pre-refactor-checkpoint.md)。不把旧基线说明改写成当前运行验收结论。

本轮实际做了前两阶段指导复核、关键链路源码阅读、代表性测试断言阅读、Git 文件清单与引用定位。读取重点包括：

- 主进程设置分流、默认重置、壁纸/blur 协调、IPC 注册、数据清空、退出阶段与应用窗口权限。
- SQLite schema、迁移备份、连接、附件/壁纸提交恢复、草稿版本复核、提醒轮次与循环模板。
- App/MonthApp 启动与卸载、SettingsPanel 的写入/重置保护、NoteList 与 MonthWorkspace 的查询失效和导航。
- 截图宿主/协调/资产、Windows Job 所有权、原生层级事件与 ABI；网络更新/远程/天气、Markdown、日报与日志退出。
- IPC 授权、循环规则、壁纸故障恢复、展示模式架构及列表动画等代表性测试；lint/build/CI 的配置与入口。

S2 的 286 文件 AST/静态相对依赖图提供结构线索；AST 解析不等于逐行语义审查。本轮没有重新逐条验收 131 个 Vitest 文件、69 个 MJS 专项和 7 个 Qt 程序的全部断言，也没有完成所有 C++ 分支的运行核验。输出截断的读取不能登记为完整文件审查，未读分支继续保留在相应 R 条目中。

本轮只新增本指导并更新阶段索引。不修改生产代码、测试、配置、AGENTS.md、构建脚本或 CI，不删除测试，不运行测试/lint/构建/Electron/Qt/安装或发布。S4 合并 T/D/R 并确定批次后，才进入 S5。

文中源码路径相对于仓库根 `C:/addFile/idea/项目/abandon/abandon_note2`。文件数、注册数、历史通过数均不能替代当前代码的覆盖或验收。

## 2. 采用什么审查方式

### 2.1 三种范围分别承担什么责任

| 审查方式 | 本项目的用途 | 完成证据 |
|---|---|---|
| 当前快照的功能链路审查 | 重大重构后重新核对实际规则、状态所有者、跨进程与存储边界 | 具体规则、生产路径、失败路径、现有保护与待验证项 |
| 本批 diff 与受影响消费者审查 | S5 每批改动核对旧/新实现以及调用方、preload、native、测试、配置接线 | 本批文件清单、前后行为对照、相关调用方 |
| 专项验证与故障复现 | 对数据、竞争、原生、UI 或交付风险证明实际结果 | 与当前源码/产物对应的业务断言、结果和环境 |

不只看 diff，因为已有问题和旧保护可能在未修改文件中；不把全部旧改动自动并入某一小批测试。完整快照阅读负责审查范围，测试执行仍以本批真实功能边界和必要依赖为准。

### 2.2 每条链路的六步阅读

1. 写清已确认的产品契约：前提、动作、结果、禁止结果、保留差异。
2. 从入口向下追踪：UI/快捷键/托盘/通知 → preload/IPC → 服务 → DB/文件/native，再追踪返回、广播与界面回填。
3. 为 state、timer、listener、waiter、Promise、worker、文件、连接和 HWND 找到创建者、唯一写入接口和释放路径。
4. 从每个 await、外部回调、文件/SQL 提交点向前后追踪：操作期间谁还能修改；取消、重入、失效和退出如何处理。
5. 反向核对消费者与测试预期：结果形状、错误含义、scope、单位、状态位、事件 reason 是否一致；期望依据是否独立。
6. 将结论写成“确认/排除/保留待验证”，附证据、条件式修复、相关 T/D/C、最小验证和回退；未确认规则不擅自固化。

对两个功能域交叉的操作，要读完整操作，不在文件边界处停止。例如草稿保存包含 SQL、附件、标签、提醒和广播；截图结束包含 ACK、资产释放和主窗口恢复；默认重置包含写入排空、持久化和系统状态回读。

### 2.3 工具和自动检查的使用规则

- 用 `rg` 查定义、消费者、IPC 字符串、SQL、原生导出和测试读取路径；用语法树核对 import、注册和接口形状。搜索结果只作为定位，不证明被搜到的代码可达或正确。
- ESLint/格式检查用于可机械验证的规范；实际执行留在 S5，以本批具体文件为参数，不执行会写缓存/源码的广域 format 或 lint。
- 静态图检查依赖方向；另列 IPC、回调、状态和生命周期耦合。没有静态 import 环不能推出没有运行期循环。
- 人工链路阅读负责时间、事务、规则和资源；自动审查工具可辅助提出候选，不能替代调用方复核或复现。
- 当前不强制引入新扫描器、类型系统、全局状态库、审查插件或大规模依赖升级。发现依赖相关问题时先核对 lockfile、实际用途和可达版本，再提出局部方案。
- 每批验证先说明选择的测试、必要构建和环境。公共模块影响不明时列明范围风险，不能自动升级为全量。

### 2.4 证据与结论分开记录

| 证据类别 | 能支持的结论 | 不能直接支持的结论 |
|---|---|---|
| 静态事实 | 某写入分两次提交；某 await 后安装监听；某断言匹配注释 | 用户已遇到错误、泄漏频率或客户机器根因 |
| 可达性/调用链证据 | 输入和状态能进入相关分支；现有上游保护是否阻断 | 故障实际发生、持久化或原生效果正确 |
| 定向复现 | 固定条件下目标业务断言失败/通过 | 其他 Windows、安装包、所有窗口组合都正确 |
| 平台/进程证据 | 真实 DB 文件重开、两轮主进程、原生读回或实际输入 | 仅凭 renderer 设置、模拟通知、同进程对象重建得出的泛化结论 |
| 客户环境证据 | 指定版本/设备/步骤下的日志、诊断和复现 | 未采集证据的机器、旧包与当前源码相同 |

本轮主要提供静态事实与审查任务。凡依赖异步竞争、系统状态或故障注入的结论，保留“待复现”，不预填测试通过。

### 2.5 问题分级和类别

| 级别 | 确认问题后的处理原则 |
|---|---|
| P0 | 可导致严重数据破坏或明确越权的紧急问题；先限制影响并单独修复 |
| P1 | 核心数据一致性、可靠保存/恢复、常用功能不可用或关键安全边界错误 |
| P2 | 特定条件下的功能错误、竞争、资源残留、性能退化或误导性测试 |
| P3 | 可维护性、局部重复、命名/注释或不影响功能的规范问题 |

严重程度必须由触发条件、可达性、影响和保护措施决定。R 条目的“优先核查”是审查顺序，不是预判 P0/P1。

结论同时标明类别：产品缺陷、验证缺陷、结构/规范改进、环境阻塞、产品规则待确认。环境在业务断言前失败不能算代码失败；文件很长、重复代码或存在 catch 本身也不等于缺陷。

## 3. 审查范围与责任地图

本轮 Git 清单计数：src/main 101、preload 6、shared 24、renderer/src 161、native_blur 18、native_capture 40、tests 220、scripts 15、.github 2、build 6 个跟踪文件。这些集合包含供应商/数据/资产/辅助文件；计数用途是登记范围，不是“全部代码已审完”或测试数量。测试资产统一清单仍以 S1 为入口。

| 功能/层 | 必须覆盖的文件族 | 归属 |
|---|---|---|
| 数据模型、版本、初始化 | db-schema、db-migration-backup、db-connection、db.js、业务 db-* | R-001/R-002/R-003/R-004/R-006 |
| 笔记/标签/文字颜色/图片/草稿/清空 | db-notes、db-tags、db-images、attachment/tag/text-color/scheduling rules；register-business-ipc；编辑器与 useDraftProtection | R-002/R-004/R-011 |
| 周期模板与日期 | db-templates、recurrence、recurrence-rules、scheduler、guard、recurring-note-preview、shared/calendar | R-005/R-006/R-013 |
| 启动、退出与服务装配 | bootstrap、index、native-runtime-gate、windows、tray、shortcut services | R-007/R-008/R-010/R-016 |
| 主窗口、紧凑、层级、停靠/拖动 | index、presentation controller、window-bounds、window-motion、blur_bridge、native_blur | R-008/R-012 |
| 截图/贴图与资源 | capture 的 host/coordinator/assets/worker；native_capture 的 host/platform/engine、Qt 测试和输入驱动 | R-009/R-010/R-016 |
| 便利贴与提醒专属窗口 | sticky、ReminderService/Window、NotificationService、TrayReminderController、reminder rules/protocol；各自 preload/入口 | R-006/R-007/R-010/R-012 |
| IPC 与不可信输入 | 四组 register-*-ipc、logging IPC/diagnostic、preload、renderer HTML/CSP、Markdown/外链 | R-010/R-013/R-014 |
| 页面运行、列表/月周、搜索/编辑/模板 | App、MonthApp、入口、list/month/note/template 组件、composables/utils | R-004/R-005/R-011/R-012 |
| 设置、背景与系统应用 | settings-schema、application-settings、index、SettingsPanel、weather/wallpaper 设置 | R-003/R-008/R-011/R-012 |
| 天气、日历节假日/黄历、远程/更新/首次使用 | calendar、weather、remote、app-update、notice/onboarding 组件与页面调用方 | R-013 |
| 日报、日志/诊断、长期运行 | daily-report/IPC/Dialog；main/logging、preload diagnostic、shared sanitize、renderer diagnostics | R-014 |
| 模块边界与编码规范 | 所有本仓库维护源码，eslint/editor/formatter 约定 | R-015 |
| 验证和交付 | tests、test-manifest/runner/入口、vitest、electron-vite、native CMake/build、builder、installer、CI/release/lockfile | R-016 |

供应商日历、地区数据、字体、图像和生成产物登记来源、许可证和加载边界；不按本地代码风格重写。若具体样本显示错误，再定位供应商规则或本地适配。此仓库的远程客户端审查不代表生产服务器端已经审查或部署。

覆盖账本在后续实际审查中按“文件/符号 → 已读路径 → 契约 → R → 结论 → 待查分支”填写；必须保留未读/未验证项。仅统计搜索命中、依赖遍历或 lint 成功不允许关闭文件审查。

## 4. 本轮静态复核：已存在的保护与待核查边界

以下定位以当前基线为准，实施时刷新。E 是源码定位编号，不是运行证据。

| 证据 | 定位 | 已确认事实 | S4 的处理依据 |
|---|---|---|---|
| E-001 | db-schema.js:9、312、396；db-migration-backup.js:33 | schema 版本为 17，按版本和列/表补齐迁移，拒绝更高版本；部分破坏性旧迁移前有 VACUUM 备份 | R-001 核查支持范围与备份边界；不把所有版本迁移都宣称已实测 |
| E-002 | db-wallpapers.js:128、420、562；wallpaper-storage-electron.mjs:127 | final-cleanup 错误被捕获并保留恢复目录；现有专项注入删除最终清理失败后仍检查业务成功和后续恢复 | 保留该语义与保护；不是已确认的“清理失败导致提交失败”问题 |
| E-003 | db-images.js:132、365；db.js:318；register-business-ipc.js:373 | 附件清理吸收非 ENOENT 错误；删除/清空包含提交前恢复；草稿事务内再次核对 editVersion | R-002/R-004 核查全路径及并发；不能因为 IPC 代码多就拆散事务 |
| E-004 | index.js:1779、1797、5001；application-settings.js:242、253 | 单 scope batch 是事务；通用持久化与默认重置的应用/视图写入分开提交 | 跨 scope 原子性和失败回填待验证；不能把当前同 scope 的壁纸互斥写入误判为分离提交 |
| E-005 | SettingsPanel.vue:1254、1389、1535 | 重置阻断 watcher、取消未发队列并等待四类在途写入；挂载部分有 componentUnmounted 保护 | 保留现有排空/卸载保护；核查 await 后新增写入和错误回填 |
| E-006 | remote-coordinator.js:95、207、271；remote-client.js:9、43；index.js:5798 | stop 等待 sessionStartPromise；会话请求有超时；退出远程阶段最多等待 1600ms，随后进入诊断及 DB 关闭 | 迟到回调是否在 DB 关闭后执行、start 是否在退出后继续待复现；已有 session-end 持久队列，不能直接声称退出记录必丢 |
| E-007 | App.vue:410、532；MonthApp.vue:331、362；MonthWorkspace.vue:331、978；NoteList.vue:1536 | App/Month 有 await 后订阅/ready；月周查询有 sequence，卸载片段未统一使 sequence 失效；列表卸载显式递增相关序号 | R-011 要区分整页文档销毁与同文档组件卸载；不从片段直接宣称生产泄漏 |
| E-008 | ipc-authorization.js:1、14；diagnostic-controller.js:79；register-calendar-ipc.js 的 onStaleSender | 业务权限按当前 webContents；诊断另查主 frame；只读旧 sender 有显式取消特例 | R-010 核对每通道窗口/frame/时点；未证明有不可信 frame 可达，不预判越权 |
| E-009 | capture/CaptureCoordinator.js:54、212；CaptureAssetStore.js:44；CaptureHost.js:43、77 | 当前窗口 sender 检查、active/receiver 复核、资产归属与尺寸限制、随机管道/握手和消息上限已存在 | R-009/R-010 核查 ACK、资源释放与实际输入；不重建整套截图协议 |
| E-010 | scheduler.js:204；recurrence.js:66、144；db-templates.js:366；db-reminders.js:95 | 调度器同步分发；模板独立事务，提交后才记录 JS 结果；模板默认失败阈值 3；提醒延后有轮次幂等保护 | 保留不同层次失败阈值及同步/异步边界；异步任务须自己负责重入和完成证据 |
| E-011 | presentation-mode-architecture.test.js:129；note-list-motion.test.js:13；security-hardening.test.js:8 | 源码测试同时包含边界约束和内部函数名/注释/精确 CSS 文本 | R-016 按断言判别价值，不能将所有源码测试一起删除或一起迁移 |
| E-012 | notice-markdown.js:5、8、39；app-update.js:106、161；daily-report IPC:40 | Markdown 禁原始 HTML、清理 URL；更新 URL 有固定目标/主机路径；报表导出重新读数据后打开对话框 | 现有安全与可用性设计保留；对话框期间快照规则、外链策略和错误边界继续核查 |
| E-013 | logger.js:467；index.js:5961 | flushLogs 返回 Promise 和 incomplete 状态，before-quit 最终同步段直接发起 flush | 是否在进程结束前得到最终确认待实测；不能用“无报错”判为完整落盘 |
| E-014 | native-abi-version.js:7；blur_bridge.js:187；native-runtime-gate.js；native_capture/host/capture_host.cpp:29 | blur ABI 为 18，桥接精确校验；截图宿主通过 Job 管理进程所有权 | 结构迁移维持兼容；修改导出或运行语义才按 native 契约同步版本/产物 |

这些事实与待核查问题不替代逐项审查。发现已有保护且可达性被阻断时，记录排除依据；不要为产生更多问题而扩大重构。

## 5. 文件级审查与条件式修改条目

全部 R 条目当前为“方案已准备，完整审查/复现待执行”。各项列出的测试是现有代表入口，实际按本批契约挑选；不是要求一次跑完该项全部文件。需要新增测试时先遵守 T-002/T-006 的准入与去重规则，拟新增名称在 S4 确定。

### R-001：数据库 schema、迁移与持久化边界

**依据/范围：** E-001；db/db.js、db-connection.js、db-schema.js、db-migration-backup.js 与各业务表。优先核查；对应 D-008、T-007、C-001。

**审查步骤：**

1. 登记支持的旧版本/结构；分开 fresh DB、真实旧结构 V0、受支持旧版本、当前版本与高于 17 的库。
2. 对每个迁移核对输入结构、行数/关系、默认值、索引、触发器、user_version、幂等性和失败回滚；高版本拒绝发生在修改前。
3. 核对 WAL 下的备份是否来自 SQLite 一致快照；已有同名备份的来源和重复迁移行为，不能只复制正在使用的主 db 文件。
4. 将 init/close、失败后的引用清除、恢复扫描与服务启动顺序串起来；确认部分初始化失败不遗留可访问旧连接。

**确认后怎样改：** 仅修改成立的迁移/连接缺陷；迁移条件应识别实际结构，DB 模块保持同一连接所有者。必要的 schema/数据变更单列批次和兼容步骤；纯解耦不递增 schema。未知旧结构先登记，不自动修复用户库。

**验证/完成：** 参考 backend-integration.mjs、reminder-database-integration.mjs、maturity-db.mjs；使用 fixture 副本验证行/关系/触发器/回滚，并重开磁盘库。要声称进程恢复，增加真实两轮进程证据。每项迁移有已验证或明确未覆盖状态。

**回退：** 同步恢复迁移与所有消费者；涉及数据变更先保留原库/WAL 一致快照和资源目录，在隔离数据上演练。代码回退不能代替数据库恢复。

### R-002：附件/壁纸的跨资源事务与恢复

**依据/范围：** E-002/E-003；db-images.js、db-wallpapers.js、db.js 的恢复/清空、register-business-ipc.js；截图到附件/背景的消费者。优先核查；D-006/D-007/D-008、T-007、C-002/C-004。

**审查步骤：**

1. 为 add/delete/purge/reset/save wallpaper 逐步列出 staging、manifest、rename、SQL、committed 标志、清理和广播；记录各点失败后的 DB/文件状态。
2. 核查 SQL 回滚时文件逆序补偿，成功后清理失败只留下可恢复状态；区分业务提交失败和后台清理失败。
3. 核查同原图去重/删除的串行队列、纯图片便签至少一张、附件属于目标便签、壁纸被多个视图引用；清空与在途保存互不复活旧数据。
4. 区分应用受控目录、输入路径与恢复 manifest；操作只影响已登记资产。审查 Windows 文件占用和中断恢复，不通过递归删除整个用户目录验证。

**确认后怎样改：** 完整操作移入 D-007 命令，保留同步 SQLite 事务；大文件写入在事务前异步完成，事务内只做必要的小型同步动作。不要在 better-sqlite3 transaction 中加入 await。补偿失败保留原始错误、恢复资料和明确结果，不能用新错误掩盖已提交事实。E-002 当前保护不需要因本项而重写。

**验证/完成：** attachment-storage-electron.mjs、wallpaper-storage-electron.mjs、note-draft-conflict-electron.mjs；按成立风险选提交前/后故障、并发、引用和恢复场景。重启恢复需真实进程终止/再启动，而不是只调用 cleanup 函数。数据和资产对应、允许遗留项及下次清理可追踪。

**回退：** 代码/命令/测试/恢复扫描一起回退；保留 staging/manifest 和数据库备份，不清理未解释的恢复目录。

### R-003：设置 scope、键、快照、重置与系统实际状态

**依据/范围：** E-004/E-005；settings-schema.js、application-settings.js、db.js、index.js 的设置 handler、applySettingsSnapshot.js、SettingsPanel.vue 和各页面监听。优先核查；D-003/D-006/D-008/D-011、T-007/T-009、C-003/C-007。

**审查步骤：**

1. 每个设置列清 logical id → type/key → application/main/month/week scope → 默认/允许值 → renderer allowlist → runtime 应用 → 广播 → 重启读取。
2. 按真实主键 ON CONFLICT(window_name,key) 检查键唯一性，不假定 type 参与主键。shortcut enabled 保持会话开关；OS 自启动按系统回读。
3. 核对批写调用是否混合 scope；壁纸/blur 互斥当前同 scope。默认重置分别更新 application 和当前 view，第二步失败时的 DB/内存/UI 行为待故障复现。
4. 核对 queued/inFlight、reset gate、旧响应、面板卸载和再次打开；读取设置/回填不能触发写入；当前视图重置不清除其他视图。
5. 设置意图、运行能力、原生有效状态与确认后的持久化分别判断；检查失败时 UI 能得到实际快照。

**确认后怎样改：** 如果确认复合操作需要全成全败，使用同一连接的窄复合 repository 事务提交 application/view；runtime 应用和广播在提交后，失败反馈按实际 DB/OS 状态回读。不把所有单项写入升级成全局队列；明确重置时取消未发写入、等待在途写入、失效旧回填。保留现有 ID/键/scope 与产品策略。

**验证/完成：** application-settings.test.js、settings-schema.test.js、weather-settings-electron.mjs、dock-settings-ui.test.js；故障注入/写入乱序、分视图隔离、重置与真实主进程重启按相关契约补足。每个新/迁移设置贯通上述整条路径。

**回退：** repository、IPC、schema 映射、队列及消费者成组回退；本项优先维持旧数据格式，若改键必须另列数据迁移。

### R-004：笔记状态、草稿版本、标签与资源归属

**依据/范围：** E-003；db-notes.js、db-tags.js、db-reminders.js、register-business-ipc.js、useDraftProtection.js、editing-draft-guard.js；编辑器/快速编辑/图片/文字颜色调用方。优先核查；D-007/D-008/D-010、T-007、C-002/C-004/C-009。

**审查步骤：**

1. 核对 initialized/in_progress/completed/deleted 转移、有效/完成时间、duration、remark、文字颜色与标签规则；UI 禁止行为在主进程也受保护。
2. 草稿先核对版本，附件异步暂存后事务内再次核对；失败不能覆盖获胜者的内容/标签/附件/提醒。
3. 草稿会话只在同主进程重载/视图切换保留；新主进程清理旧会话。不以“更稳妥”为由改成跨启动自动恢复。
4. 编辑 busy、localStorage 失败、退出/视图草稿确认、取消/导航/窗口销毁均有明确阻断和释放。
5. 业务清空后 active form/卸载 flush 不复活草稿；核对 index.js:5551 已区分业务已清空但草稿清理失败的提示，不误当数据库回滚。

**确认后怎样改：** 统一版本契约并保留事务内复核；命令层负责完整提交/补偿，renderer 保留原草稿并提示冲突，不能偷偷重试覆盖。必要时引入明确 generation/operation ID，避免清空后的旧异步完成重新写入；先核对已有 generation 保护。

**验证/完成：** editing-draft-session.test.js、editing-draft-guard.test.js、note-draft-conflict-electron.mjs、note-draft-conflict-ui-electron.mjs，以及所改 note-duration/remark/text-color 专项。胜败双方 DB/文件/UI、重载/新进程和清空后不复活分别有证据。

**回退：** 版本生成与所有提交消费者、命令/资产补偿一起回退；保留未保存草稿和测试资料，不恢复已清空的生产业务数据。

### R-005：循环模板、日期与调度故障保护

**依据/范围：** E-010；services/recurrence*.js、scheduler.js、template-scheduler-guard.js、db-templates.js、recurring-note-preview.js、shared 日期/调度规则与 TemplateForm/Workspace。优先核查；D-007/D-010/D-012、T-008、C-005/C-009。

**审查步骤：**

1. 独立样本核对本地自然日、季度/月末/闰年、范围边界、暂停/恢复/修改/删除、预览与真正生成；必要时区分夏令时与 Asia/Shanghai。
2. 保留“历史节点跳过、仅补当天到时节点”，新实例为快照；上一未完成实例替换规则与已完成实例保留规则分别验。
3. 多次 startup/recovery/resume/tick 不重复生成；模板处理、旧实例替换、next_run、提醒和失败记录按现有事务边界核对。
4. 分开单模板默认连续失败 3 次、TemplateSchedulerGuard 服务保护、Scheduler task 自身 maxFailures；不统一成一个阈值。
5. Scheduler 为同步分发，异步天气等任务的重入/拒绝/性能完成由自身负责；不能将 tick 正常返回当全部异步任务完成。

**确认后怎样改：** 规则修复集中于实际规则源和 DB 命令，预览/表单共享确认后的契约；保持事务提交后才记录不可回滚的结果/通知。只有证据证明同步调度接口不足才另列接口迁移，不因存在 Promise 一次改成异步全局调度器。

**验证/完成：** recurrence-rules.test.js、template-scheduler-guard.test.js、scheduler.test.js、recurring-preview-db.mjs、template-quarterly-electron.mjs；按所改规则用独立固定日期、重复调度、rollback/失败阈值核验。真实休眠/时间改变留平台证据。

**回退：** 规则、预览、模板数据库状态与消费者共同恢复；保留模板/实例关系，避免重新启动时批量补发历史便签。

### R-006：提醒轮次、多通道与系统激活

**依据/范围：** E-010；ReminderService/Window、NotificationService、TrayReminderController、db-reminders、reminder-rules/protocol、notification-policy/guard、ReminderApp 与专属 preload。优先核查；D-007/D-012、T-008/T-009、C-004/C-006。

**审查步骤：**

1. 核对 active/pending/snoozed/cancelled、parent round、delivered/dismissed channels 与尝试次数；旧提醒操作不可影响新轮次。
2. 延后/编辑、完成/删除/关闭提醒时，同步 DB、弹窗、托盘与系统通知；重复激活不能生成第二个子轮次。
3. send/show 调用成功与用户确实看到系统通知分开记录；失败事件有界重试，退出/销毁后的回调不能再写 DB。
4. protocol、第二实例、服务未就绪队列、系统激活参数、专属窗口崩溃/重建按真实窗口责任核对。

**确认后怎样改：** 轮次变更保持事务与预期轮次校验；每个展示渠道错误隔离，不能让已提交提醒变更变成数据库失败。保留 macOS 现有通知策略与应用内降级，修复只涉及成立的渠道/激活边界。

**验证/完成：** reminder-service.test.js、reminder-database-integration.mjs、reminders-electron.mjs、reminder-native-acceptance.cjs；真实系统通知/退出再激活另列。同进程模拟激活不能称为重启/系统接受验证。

**回退：** 服务/DB/通知协议/preload/窗口接线一起恢复；不得删除持久轮次或已排队动作来消除失败。

### R-007：启动、退出、在途操作与日志落盘

**依据/范围：** E-006/E-013；bootstrap.js、index.js 的启动/退出、remote-coordinator/client、scheduler、捕获/诊断服务、logger/writer、数据库连接和窗口 recovery。优先核查；D-002/D-008/D-012、T-005/T-007/T-009/T-010、C-001/C-004/C-007/C-008/C-010/C-013。

**审查步骤：**

1. 画出可重入退出阶段：草稿批准 → 截图 dispose → 远程有界等待 → 诊断 freeze → 几何/服务/DB/native/托盘/log；退出取消不能进入清理。
2. 对启动中退出、连续 before-quit、单服务失败、renderer 崩溃与系统 session-end 核对标志和一次性释放；新操作何时不再准入。
3. 远程 start/health/pull/sessionStart 等待与 1600ms 退出窗口相互核对；timeout 不是取消，晚到结果是否还访问已关闭 DB/窗口。
4. logger flush 的 Promise、incomplete 和 writer 所有权与进程结束顺序核对，明确允许的退出时限和未落盘结果。
5. 同步 SQL 与异步文件/worker/network 在 DB 关闭前后各归谁管理；不能把所有 dispose 并行化。

**确认后怎样改：** 在 D-002 中提供小型 shutdown gate 和阶段拥有者；若复现迟到访问，给相关请求增加取消或生命周期 generation，并保护 DB 回调。超时后保留补报/恢复资料，不能通过无限等待阻止退出。日志阶段如需调整，使用有界等待和明确 incomplete，保持诊断先提交、日志最后收尾的含义。

**验证/完成：** editing-draft-guard.test.js、capture-lifecycle-electron.mjs、remote-health-cache.test.js、logging-actions-electron.mjs、log-writer-client.test.js；补充启动中退出/慢网络/日志队列的最小定向场景。记录阶段、资源终态与最后业务断言；每种超时/失败都有可解释结果。

**回退：** 启动与退出接线成组恢复；先恢复旧生命周期顺序，再恢复相应模块；不通过终止无关 Electron/Codex 或删除用户缓存回退。

### R-008：窗口、展示、停靠、坐标与原生层级

**依据/范围：** E-014；index.js、windows、window-bounds、window-motion、blur_bridge、native_blur，WindowPresentation/CompactIsland/ResizeHandles/AppTitlebar 与相关设置。优先核查；D-004/D-005/D-006、T-009、C-003/C-007/C-009。

**审查步骤：**

1. 主窗口一个 BrowserWindow 承载 list/month/week，周视图为 MonthApp week mode；导航与展示模式分开，维持 draft/busy/blur/cleanup 等门禁。
2. compact 的 committed/desired/operation、退出恢复、ACK 超时与锁定；只持久化约定尺寸，不能增加 enabled 或旧位置持久化。
3. physical pixel、Electron DIP、CSS/uiScale 各有来源与转换；跨屏、负坐标、workArea、缩放、显示器变化后重建 geometry/dock。
4. native requested/effective/confirmed 分开；层级先 apply、真实 confirm，再持久化，失败回退。检查 enabled/requestedMatches/anchored 和相关 blur health。
5. generation、暂停计数、拖动会话、edge monitor、事件 hook、窗口销毁与 Explorer/显示器/休眠恢复各有配对释放；无关 reorder 不应触发持续重同步。

**确认后怎样改：** 复用 PresentationModeController 和已有 motion 规则；修复在真实状态所有者/平台适配，不通过 renderer checkbox 伪造成功。不基于行数重写 C++；若改 native 导出或运行语义，同步 ABI、桥接、DLL 与打包校验，保持坐标不变量。

**验证/完成：** presentation-mode-controller.test.js、presentation-mode-electron.mjs、dock-display-rebuild.test.js、dock-trigger-electron.mjs、window-control-drag-electron.mjs、window-z-order-recovery-electron.mjs 及对应定向测试。只选本批所需场景；多屏/混合 DPI/真实层级/系统事件必须有桌面证据，window-state-matrix-electron.mjs 不能自动作为每次局部入口。

**回退：** controller/适配/接线成组回退；native 修改时 ABI、源码、DLL、产物与测试共同恢复，确认文件未被本项目进程占用。数据库中的稳定位置和暂态停靠位置分别保留。

### R-009：截图协议、来源动作、ACK 与宿主资源

**依据/范围：** E-009/E-014；main/capture、useScreenCapture、来源编辑/背景组件，native_capture 的 host/platform/engine 和输入驱动。优先核查；D-005/D-012、T-009/T-010、C-002/C-007/C-008/C-012。

**审查步骤：**

1. 核对 pending/active/sessionId/token/deliveryId/receiver 的转移，重复截图 busy、旧会话/重复 ACK/来源消失和错误消息均有确定结果。
2. 保留来源截图主动作返回来源页面，Enter/双击执行来源动作、Ctrl+C 复制；全局截图仍默认复制。来源“便签/背景”行为分别验。
3. worker 解码、PNG 文件、会话目录/尺寸上限、协议消息上限、管道握手、异常进程退出/启动中 dispose 的释放和错误反馈完整。
4. 捕获开始时的原始可见/焦点、业务 accepted/opened、来源取消和贴图存活决定主窗口恢复；不能所有结束都 show/focus。
5. Qt overlay/editor/selection/ImageDocument/clipboard/pin 与 DesktopCapture 的图像坐标、透明度、撤销/重做、输入和所有权分别审查；模拟完成消息不代表真实选择/编辑/复制。
6. 宿主仅管理自身 Job/句柄/进程，正常/崩溃退出不遗留拥有的 helper/贴图；release 失败后资料可追踪。

**确认后怎样改：** 首轮调整成立的协调/生命周期边界，复用当前 Host/Coordinator/AssetStore 与 Qt 分层。若改协议，两端版本/消息/测试一起迁移；来源动作与产品键位不随解耦变化。资源上限和所有权判断留在主进程/native 边界，不能依赖 renderer 自律。

**验证/完成：** capture-coordinator.test.js、capture-assets.test.js、capture-image-worker.test.js、capture-host-electron.mjs、capture-lifecycle-electron.mjs、capture-business-electron.mjs；Qt 对应 native_capture/tests 下 core_test.cpp、selection_test.cpp、ui_test.cpp、clipboard_test.cpp、pin_halo_test.cpp、ux_test.cpp、polish_test.cpp 所生成的程序和实际输入按修改范围选。记录 simulated/real-input 模式、ACK/终态、窗口恢复与已清理资源。

**回退：** JS/native 协议、preload、worker、部署文件与相关测试共同回退；清理仅限当前测试拥有的目录/Job，不按进程名批量结束其他程序。

### R-010：IPC、preload、窗口能力与输入安全

**依据/范围：** E-008/E-009/E-012；所有 IPC 注册、preload 的 index/sticky/reminder/diagnostic、窗口 webPreferences/导航/CSP、附件/截图/导出路径、原生激活与外链。优先核查；D-001/D-007/D-012、T-010、C-008/C-010/C-012。

**审查步骤：**

1. 以 S2 附录的 146 个字面注册及 ReminderWindow 别名为定位起点，补充动态注册、on/handle/别名和移除；先检查通道存在/重复，再审查能力。
2. 建立 API → 通道 → 授权窗口/frame → payload 校验 → 服务 → 返回/订阅/解绑矩阵。实际 getApplicationWindows 当前仅主窗口，不根据函数名称推断提醒/便利贴也有便签业务权限。
3. 区分 main、sticky 自身 entry、reminder 自身窗口、诊断 producer、截图接收者；旧 sender 只在确认的只读取消特例放行，写入不沿用该例外。
4. await 前后的窗口/会话身份是否需要复核；查 frame 可达性、iframe/导航限制后再判断是否存在越权，不因一个 helper 未查 frame 就宣布漏洞。
5. 对 ID、枚举、日期、数组/数量、字符串/二进制大小、所有权、路径、URL 做边界核对；非法输入在产生不可回滚副作用前拒绝。
6. sandbox/contextIsolation/nodeIntegration、will-navigate/redirect/window-open、地理权限范围、生产与测试 flag 分支、preload 单文件构建约束一起检查。

**确认后怎样改：** 保留 logging IPC wrapper 和明确 API；将通用授权与通道特例分开，参数校验使用共享纯规则或服务入口。异步请求只增加必要的身份/generation 复核；不暴露任意 invoke/send、任意 shell/文件路径或全部 context。导出目标由真实保存对话框获得，不把用户授权导出的路径与内部附件路径混为一种规则。

**验证/完成：** ipc-authorization.test.js、ipc-arguments.test.js、calendar-ipc.test.js、weather-ipc.test.js、daily-report-ipc.test.js、security-hardening.test.js、sticky-diagnostic-ipc.test.js 和相关 Electron 跨窗口专项。非法 sender/payload 的测试要断言没有写 DB/文件/调用 native；静态 webPreferences/CSP 检查另标证明范围。

**回退：** 通道、payload/返回、preload 导出、handler wrapper 和消费者一起恢复；保留现有能力限制，不以关闭 sandbox/GPU/webSecurity 解决验证阻塞。

### R-011：页面/组件异步生命周期与列表/月周查询

**依据/范围：** E-005/E-007；App/MonthApp、SettingsPanel、NoteList、MonthWorkspace、编辑器/预览与 useSlidingWorkspace/useNotePresenceMotion 等 composables。优先核查；D-009/D-010/D-011、T-007/T-010、C-003/C-004/C-009/C-010。

**审查步骤：**

1. 分别登记 query revision、parent page generation、load/pagination/tag group/weather sequence、动画 ticket 与组件生命周期；不同序号不能只合并为一个公共变量。
2. 慢查询先发后回、filter/sort/tag/月份/周切换、重复刷新/删除/完成与分页同时发生时，旧结果不覆盖新状态。
3. 核对 onMounted await 后的订阅/ready/焦点/DOM 写入，onUnmounted 如何阻断在途延续；区分整页导航销毁 JS context 与同文档组件卸载。
4. month transitioning 拒绝新导航、week pending target/selection、list pending mode 与动画协作分别保留。
5. 卸载/反向动画/取消后的 finally 不清理当前新操作；modal、panel、scroll anchor、退出副本和 focus frame 各归属明确。
6. 数据清空、view 替换和设置回填可使在途请求失效；旧结果既不重建已关闭组件，也不发 rendererReady 给错误视图。

**确认后怎样改：** 按 D-009/D-010/D-011 提取小型 runtime/model；在实际拥有者增加 disposed 或 generation，让 await 后注册前/写入前检查。复用现有 unsubscribe/cancel/dispose，避免重复监听；后台业务提交可以完成但结果必须按当前生命周期处理。保留 App/Month 的壁纸缓存/释放与更新展示差异，确认规则前不统一。

**验证/完成：** queued-modal-lifecycle.test.js、sliding-workspace.test.js、note-list-refresh-electron.mjs、note-list-animation-electron.mjs、note-list-tag-refresh-electron.mjs、note-list-completion-electron.mjs、month-view-electron.mjs、week-view-electron.mjs 等按改动选择。可控延迟验证卸载前后 listener/ready/DOM 写入计数；真实 Chromium 验焦点、动画帧/裁剪与快速反向。仅有空 DOM 截图或源码序号字符串不能关闭竞争风险。

**回退：** composable、组件状态和订阅/DOM hooks 成组回退；保持原查询参数、导航策略与 motion contract，不撤销用户本批之外 UI 改动。

### R-012：UI 设计标准、交互、响应式与可访问性

**依据/范围：** docs/UI_DESIGN_STANDARD.md、tokens.css、所有控件/浮层/面板/主题和页面布局；App/Month/Reminder/Sticky 的实际窗口。按改动核查；D-004/D-009/D-010/D-011、T-010、C-007/C-009。

**审查步骤：**

1. 实施任何 renderer 界面/CSS/主题/控件/浮层改动前完整阅读 [UI 标准](../../UI_DESIGN_STANDARD.md)。检查全局令牌、层级、边线/背景和语义例外，不在拆组件时建立新灰色/边线体系。
2. 界面具体行为按时间线、自定义、标签分组、月/周、紧凑、编辑/创建、设置/天气/壁纸/通知分别核对；标签排序、折叠/分页、状态动作和相邻黄历/天气不能重叠。
3. 面板退出、hover collapse、popover 定位/viewport 约束、外部点击/ESC、keyboard selection、pointer capture/lost capture/blur、输入法 composition 和焦点恢复有匹配责任。
4. 在支持 uiScale、标题栏图标缩放、字号、窄窗口/小屏、壁纸/blur/透明背景下检查命中区域、遮挡、滚动与选择。按代表状态组合减少无效笛卡尔积。
5. role/name/focus/tab order、禁用/loading/inert 和错误反馈可观察；用实际行为核验，不通过新增 aria-label 或快照数量替代可访问性。

**确认后怎样改：** 优先共用令牌/现有交互 helper，业务控件保持自己的确认规则。局部语义/绘图例外按 AGENTS.md 在代码注释解释；样式抽取一并迁移 scoped 归属、搜索锚点、DOM hook 和退出动画，不顺带改文案/布局产品规则。

**验证/完成：** ui-interaction-standard.test.js、action-bar-accessibility.test.js、ui-scale.test.js、ui-responsive-electron.mjs、ui-components-electron.mjs、note-list-toolbar-electron.mjs 及对应浮层专项；按本批选真实页面/尺寸/状态，必要时逐帧。低风险纯文案/注释整理不新建镜像测试。

**回退：** 组件/令牌/样式/hooks/测试同步回退，保留已验证的 UI 标准；视觉问题不能通过调低字号/遮蔽控件规避验收。

### R-013：天气、日历数据、远程通知、更新和产品策略

**依据/范围：** E-006/E-012；weather-service/refresh-controller/rules、calendar/holiday/almanac、remote-client/coordinator/DB、app-update、notice markdown、onboarding 和各页面调用方。按边界优先核查；D-009/D-012、T-008/T-010、C-005/C-009/C-010/C-012。

**审查步骤：**

1. 地区恢复真实选择路径、缓存 fresh/stale、自动/手动限频、Retry-After、无网络/无效响应、generation、关闭开关/换地区后的旧响应分别核查。
2. 日历日期、节假日导入/下载、黄历时效和 recurring preview 用独立固定样本，数据来源/适配/vendor 版本分开；当天刷新不能无界重发所有查询。
3. 远程启动只按现有 receive/upload 决策，健康 unavailable/incompatible/retired、cursor/sequence/重复通知/本地阅读状态/session-end 补报和退出竞争完整。
4. Markdown 原始 HTML 禁用、URL/图片规则、内容长度和转义；外链主进程校验与 CSP/浏览器打开一并读。
5. 更新 semver/平台架构/目标产物、失败降级/直链来源、固定 GitCode/GitHub 入口；返回 renderer 的选择与随后打开链接的版本一致。
6. 首次使用/捐赠/统计时机、通知策略、更新路径及 App/Month 差异属于产品规则；不能以“最佳实践”替换明确的现有选择。

**确认后怎样改：** 对可达输入/响应缺陷在规则/服务/协调拥有者修复，保留缓存和 generation 保护；取消/退役/退出后的结果不再回写当前状态。只有确认允许的规则才扩大外链或更新来源。不新增完整备份恢复、远程服务部署、自动更新安装或 macOS 发布范围。

**验证/完成：** weather-service.test.js、weather-refresh-controller.test.js、weather-selection-path.test.js、holiday-data-service.test.js、almanac-engine.test.js、remote-health-cache.test.js、app-update.test.js、notice-markdown.test.js 与对应 Electron 页面测试按实际改动选。网络使用本地 fixture/确定性替身；真实服务兼容性单列，不能由 fixture 通过推出线上健康。

**回退：** 服务/cache/规则/DB cursor 与页面显示协议一起恢复；保留用户已读状态/设备选择和旧有效缓存，不清除全部缓存来掩盖错误。

### R-014：日报、诊断、隐私和性能证据

**依据/范围：** E-012/E-013；daily-report、register-daily-report-ipc、DailyReportDialog、main/logging、preload diagnostic、shared sanitize/policy、renderer evidence/performance、thumbnail-cache。按风险核查；D-002/D-007/D-010/D-012、T-005/T-010、C-009/C-011/C-013。

**审查步骤：**

1. 日报自然日/持续日期/完成日期、status/排序、去重、366 天限制、选择 ID 与导出文本/Excel 内容一致。
2. 当前导出在保存对话框前读取查询结果；对话框期间数据变动属于需要明确的快照规则。先确定“点击导出时快照”或“落盘时最新”的产品预期，再判断是否需再次查询。
3. 取消/目标写入失败/截断/打开位置失败分别反馈；xlsx 的单元格类型与用户文本保持数据语义，导出用户授权目录。
4. 日志/诊断不记录正文/备注/剪贴板/token/base64/本地路径的泄露形态；按字段、错误对象/字符串、重复抑制和 renderer 来源查完整路径，保留关联 ID 和必要状态。
5. writer 失败/重启/排队/backpressure、采样/预算/丢弃/flush/incomplete 与导出证据完整性核对；本地 JSONL/导出是现有路径，不默认上传。
6. 性能要有数据规模、测量窗口、环境与主/renderer/native 归因；滚动/列表/缩略图/日志共存、长期资源增长采用针对性基线，不能单靠函数耗时宣称客户卡顿根因。

**确认后怎样改：** 分开计算/快照/选择/落盘与 UI 反馈，保护独立日期规则；日志只调整成立的脱敏/队列/退出问题，保留完整度标记。性能先定位证据，再局部改变缓存、批量或渲染策略；不为每个路径加入高频日志，不擅自设机器无关的性能阈值。

**验证/完成：** daily-report.test.js、daily-report-ipc.test.js、daily-report-electron.mjs、ipc-arguments.test.js、diagnostic-evidence.test.js、log-store.test.js、log-writer-client.test.js、logging-worker-asar-electron.mjs；thumbnail-benchmark-electron.mjs、logging-overhead-electron.mjs 仅针对性能任务选择。断言导出内容/字节、敏感字段遗漏、证据完整度和资源趋势，报告未覆盖 soak/客户设备。

**回退：** 导出格式/IPC/页面与日志 schema/消费者/worker 同步恢复；保留已有诊断文件，不能删失败日志使结果变绿。

### R-015：依赖方向、模块接口、编码规范与可维护性

**依据/范围：** S2 结构分析及全部本地维护源码；eslint.config.mjs、.editorconfig 与既有代码约定。按实际修改核查；D-001 至 D-012、T-006/T-012，与对应业务 C 契约绑定。

**审查步骤：**

1. 核对 main/shared/preload/renderer/native 的依赖方向；共享规则不能依赖 Electron/DOM/存储，服务不能反向依赖主入口；IPC/native/回调状态环需人工检查。
2. 每个模块有明确责任、输入/结果/错误、资源所有者与 install/start/dispose；不接受能读写全部 globals 的巨型 context，不用多层透传包装证明“解耦完成”。
3. 配置意图/生效/确认、Promise 状态、generation 和 snapshot 使用一致命名；必要 JSDoc 说明协议、单位、字段/生命周期，注释解释约束而非重复函数。
4. 错误处理分提交前失败、提交后展示/清理失败、取消/过期和环境阻塞；catch 有明确恢复/报告/传播责任，保留原始错误和 action 关联。
5. 时间/枚举/输入规则有共享来源；DTO 与内部可变 Map/timer 分开；监听、引用计数、worker 所有权与重复安装可查。
6. 可接受的业务差异、vendor/生成源码和当前框架风格不机械统一；没有行为的文案/格式调整不制造大量新增测试。

**确认后怎样改：** 规范变更附着实际迁移的文件，复用现有 helper/controller/服务；跨文件重命名、错误协议、命名统一单列真实消费者和验收，不同时大规模 format/TypeScript/Pinia/DI/event-bus 或依赖升级。稳定外部接口先通过兼容委托迁移，最后清除旧入口。

**验证/完成：** 后续对本批具体文件运行必要 lint/静态边界和所属业务保护；接口/依赖检查涵盖 mjs/CJS/Vue/动态入口，不能从一个 lint glob 推断全部语言都审过。完成条件是职责和所有者减少隐式依赖且消费者兼容，不以行数减少衡量。

**回退：** 本批新模块、入口委托、消费者、规范配置/测试一起回退，恢复明确接口；不格式化或重置其他用户变更。

### R-016：测试有效性、构建依赖、CI 与交付

**依据/范围：** E-011/E-014、S1 已确认入口问题；tests、test-manifest/runner/入口、vitest、electron-vite、native CMake/build、builder/base/win/mac、installer/sandbox、validate-packaged-app 与 CI/release。优先核查；全部相关 D、T-001 至 T-012、C-001 至 C-013。

**审查步骤：**

1. 按断言登记契约、独立预期、生产边界、故障检测能力、mock 范围、环境和不能证明的内容；不是按文件名直接决定保留/删除。
2. E-011 中注释文本/内部函数名精确断言列为改写候选；CSP/禁止依赖/安全 whitelist/明确 UI 约束可以保留结构化静态保护。真实窗口行为由对应实际测试承担。
3. 找无断言/未 await、目标分支未执行、只检查 mock 自己返回、用被测实现生成 expected、错误被 catch 后仍 process.exit(0)、跳过/超时/重试伪通过等情况；逐项引用证据，不预判所有专项都有问题。
4. 文件清单与 runnable/helper/fixture/native 角色完整，source-read dependencies 不被 related/changed 漏掉；本批选择说明排除理由，缺失映射不能退化为全量默认。
5. build 依赖/来源 hash/ABI、preload 单文件、worker ASAR、Qt runtime/plugins/licenses、通知身份/安装依赖按包内实际位置核对；源码配置正确不等于包正确。
6. 普通 CI 的适用范围与发布验证分开设计；默认本地 focused 规则和 CI 策略分别说明。Windows sandbox RX 修复保留限定路径/最小权限与运行期只读诊断。
7. 删除旧测试必须有可恢复基线和等价必要保护；缺陷复现先失败于业务断言，再确认修复后通过。低影响可逆变化不新增镜像测试。

**确认后怎样改：** 按 T-002/T-003/T-004/T-005/T-006/T-011 迁移登记、明确参数入口、构建依赖和结果协议；重复/无效断言先有处置依据，必要保护建好再删。CI/发布工作流只在 S4/S5 明确范围内改，不因本指导自动执行或发布。

**验证/完成：** test-manifest.test.js、test-runner.test.js、package-native-config.test.js、native-runtime-gate.test.js、security-hardening.test.js 以及被改契约的具体文件。安装/升级/卸载、本地测试包和真实原生输入按任务选择；受限环境启动错误只标环境阻塞。通过必须同时有有效退出码、目标断言完成、跳过/完整度和产物来源。

**回退：** 测试/manifest/runner/入口/CI/构建依赖按实际 diff 恢复，保留首次失败证据。恢复旧测试不能误覆盖已有删除与用户改动；包/原生产物回退保持源码/ABI 对应。

## 6. 高风险待验证项的具体操作配方

这些配方是 S5 的验证设计，本轮没有执行或新增测试。先核对现有保护是否充分，充分则引用证据，不重复生成。

### 6.1 跨 scope 重置的失败点（R-003）

1. 在隔离 SQLite 文件中准备 application/main/month/week 的不同值；记录 DB 和 resolved snapshot。
2. 针对默认重置，仅在应用级已完成、当前 view 清理前注入故障；另测第一步失败。不要对生产库实施注入。
3. 比较 DB、内存/UI、runtime 与返回结果；记录当前行为，再依产品契约判断是否要求全部回滚或明确部分完成。
4. 若要求全成全败，修复将两组 SQL 放在同一连接事务，runtime/broadcast 留在提交后；验证所有 scope、失败回滚和重开。
5. 同 scope 壁纸互斥/停靠批写保留原子保护，不能为复现本问题拆散原事务。

### 6.2 退出期间的迟到远程结果和日志确认（R-007）

1. 用可控请求挂住 health/startSession/pullNotices/endSession，分别覆盖尚无 sessionId、有启动 Promise、已有 session 三种状态。
2. 发起退出，记录草稿批准、capture、远程 1600ms、diagnostic、DB close、writer flush 的顺序；释放响应的时点在各阶段前后分别控制。
3. 断言退出门禁后不再启动新服务/会话；DB 关闭后不写入，persisted session-end 队列仍可下次处理；失败不变成未处理拒绝。
4. 如有 late-write，给实际拥有者加 shutdown generation/取消/安全回调，不能仅忽略所有错误或无限等待。
5. 日志另验最后请求确认/incomplete；超时/丢弃明确报告。真进程退出以文件/下一轮读取验证，不能用同进程 flush mock 证明落盘。

### 6.3 页面 await 和月周卸载（R-011）

1. 在同一文档挂载目标组件，将 settings/calendar/notice 请求延迟；在 resolve 前卸载，再挂载新实例。
2. 释放旧请求，检查旧实例是否安装订阅、发 ready、安排 RAF/动画/焦点或修改全局 CSS；使用生产挂载方式核对该场景是否可达。
3. 再独立覆盖整页 list/month/week 导航：旧文档销毁不直接等同于同文档卸载；主进程检查 current sender/view generation。
4. 修复后保持月导航拒绝与周导航 pending 规则；旧操作 finally 不能解除新操作的 busy。
5. 在真实 Chromium 对 DOM/焦点/动画检查；单元场景只证明受控生命周期。

### 6.4 提交、故障、恢复和清空竞争（R-002/R-004）

1. 按操作阶段选择 manifest 前/后、rename 前/后、SQL commit 前/后、final cleanup 的故障点。
2. DB 未提交时检查原记录和原文件恢复；已提交时检查业务结果和允许遗留 staging，下一次恢复完成。
3. 延迟附件写入，期间另一请求修改同便签、清空数据或退出；验证失败者不覆盖成功者，清空不被旧提交/卸载草稿复活。
4. 同进程调用恢复函数只标“恢复算法验证”；另用隔离两轮进程验证异常终止后的磁盘/资源一致性。
5. 保留 E-002 既有清理失败测试，不为了重构替换成“所有异常都必须 reject”。

### 6.5 IPC 能力与先拒绝再副作用（R-010）

1. 对被改通道列 current main、old main、sticky、reminder、unknown sender、main/sub-frame、销毁/导航后的身份。
2. 先查实际可达性和现有导航/CSP 限制，再以受控请求验证权限，不从 mock 中虚构可利用路径。
3. 错误 ID/枚举/大小/资源归属在 DB/file/native spy 或真实资源上断言无副作用；合法通道返回/订阅/解绑保持兼容。
4. 只读 stale 取消与写入拒绝分别断言，专属窗口不获得全部主业务权限。
5. real Electron 用于证明跨进程/窗口边界，单元 mock 用于证明 wrapper 的拒绝顺序。

### 6.6 源码断言的处置（R-016）

1. 从 E-011 每条 assertion 写出保护的契约；无法说明故障检测价值的注释/内部名匹配登记为候选。
2. 保留架构禁止依赖/CSP/UI 标准等有效静态约束，能解析结构时替换脆弱文本。
3. 检查是否已有 pointer capture/blur/卸载、窗口 resize、动画/裁剪的运行测试，确认覆盖实际故障后再迁移/删重复断言。
4. 不通过删除断言/加 skip/扩大 timeout 达到绿色；新版断言预期必须来自产品/规则样本。
5. 将删除理由、替代保护和 source-read 路径同步到 T-002/T-006，局部选择时人工核对。

## 7. T/D/R 合并关系与建议核查顺序

### 7.1 防遗漏映射

| R 条目 | D 条目 | T 条目 | C 契约 |
|---|---|---|---|
| R-001 | D-008 | T-001/T-007 | C-001 |
| R-002 | D-006/D-007/D-008 | T-006/T-007 | C-002/C-004 |
| R-003 | D-003/D-006/D-008/D-011 | T-007/T-009 | C-003/C-007 |
| R-004 | D-007/D-008/D-010 | T-007 | C-002/C-004/C-009 |
| R-005 | D-007/D-010/D-012 | T-008 | C-005/C-009 |
| R-006 | D-007/D-012 | T-008/T-009 | C-004/C-006 |
| R-007 | D-002/D-008/D-012 | T-005/T-007/T-009/T-010 | C-001/C-004/C-007/C-008/C-010/C-013 |
| R-008 | D-004/D-005/D-006 | T-009 | C-003/C-007/C-009 |
| R-009 | D-005/D-012 | T-009/T-010 | C-002/C-007/C-008/C-012 |
| R-010 | D-001/D-007/D-012 | T-010 | C-008/C-010/C-012 |
| R-011 | D-009/D-010/D-011 | T-007/T-010 | C-003/C-004/C-009/C-010 |
| R-012 | D-004/D-009/D-010/D-011 | T-010 | C-007/C-009 |
| R-013 | D-009/D-012 | T-008/T-010 | C-005/C-009/C-010/C-012 |
| R-014 | D-002/D-007/D-010/D-012 | T-005/T-010 | C-009/C-011/C-013 |
| R-015 | 对应实际迁移的 D-001 至 D-012 | T-006/T-012 | 对应被改功能的 C |
| R-016 | 对应实际迁移的 D | T-001 至 T-012 | C-001 至 C-013 |

表中的交叉关系不能变成“每次运行所有相关测试”。每批选择由实际文件/契约、现有测试内容和必要跨层证据共同确定。一个成立问题涉及多个 R 时保留一个问题记录并多处引用，避免重复修复。

### 7.2 核查顺序

1. 刷新基线/产品契约/覆盖账本（T-001/T-002、D-001），先核验 R-016 的关键保护可用性。
2. R-001 至 R-007 和 R-010 的数据/权限/退出路径优先；先做静态可达性核对，后续只对仍成立的风险设计复现。
3. R-008/R-009 在窗口/native/截图迁移前完成对应接口与状态核查。
4. R-011/R-012 在 renderer runtime/model/SettingsPanel 抽取前核对生命周期与真实交互。
5. R-013/R-014 随受影响功能审查，保留有意产品策略；性能/安装/客户环境项独立登记。
6. R-015/R-016 贯穿每批 diff 与验收；所有发现进入 S4 合并，先明确保护/依赖，再决定代码改动顺序。

这些是审查优先级，不是 S5 最终批次。S4 应将 R 与 S2 B0–B7 合并：确认缺陷优先最小修复与保护；纯迁移保持行为；涉及同一事务/状态所有者的条目合并，避免分别重写相同入口。

### 7.3 S4 必须明确的决策

- 复合 application/view 写入及默认重置是否要求全成全败；若只是单 scope 调用，不扩大实现。
- 生命周期 gate/迟到回调是否需要调整、哪些请求归属，以及有界退出/日志 incomplete 的产品要求。
- App/Month 壁纸缓存/释放和更新展示时机是否统一；未确认差异继续保留。
- 报表快照的时间点；不能在已有异步对话框中无意改变用户选择/预览含义。
- 哪些测试断言有独立检测价值、需要迁移、可删除、待核验；高风险保护不足时先补最小充分保护。
- 原生源码/导出/运行语义是否真实需要改；若需要，明确 ABI/包/桌面验证依赖。
- 每个未复现候选是继续核查、纳入局部验证还是有证据排除；不全部标成必须重构。

## 8. 后续实际问题记录与验证协议

### 8.1 单个发现的记录字段

| 字段 | 必填内容 |
|---|---|
| 关联 | R/T/D/C；同一问题避免重复编号和重复修复 |
| 状态/类别 | 待核查/已确认/已排除/待规则/待环境/已修复/已验证；问题/测试/结构/环境 |
| 定位/基线 | 文件/符号/行、HEAD、dirty diff、产物 hash/ABI（相关时） |
| 契约依据 | 已确认产品规则/接口/独立样本；规则不明单列 |
| 触发/可达性 | 初始数据/窗口/线程/请求顺序、上游保护、最小输入 |
| 证据 | 静态事实、实际复现、失败业务断言；历史结果只作历史证据 |
| 影响/级别 | 数据/用户结果、范围、现有保护、确定的 P 级 |
| 改动 | 文件/消费者、步骤、兼容/数据风险、前置依赖 |
| 验证 | 精确文件/场景、必要构建/环境、成功与失败条件 |
| 回退/停止 | 代码/测试/产物/数据分别怎么恢复；哪些条件停止相关批次 |
| 剩余风险 | 未读分支、未执行环境、多屏/重启/安装/长期/客户边界 |
| 结案 | 修复验证，或明确排除/保留理由；不能只填“优化完毕” |

不要为尚未运行的结果创建“通过”文件或预填退出码。准备清单和实际证据分开；证据可继续沿用 S1 的本地结果规范，在实施时记录新版本。

### 8.2 局部验证命令与环境

以下仅是后续执行形式示例，不是本轮实际命令：

```powershell
$reviewNodeDir = 'C:/Users/Admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin'
$reviewRemainingPath = ($env:PATH -split ';' | Where-Object { $_ -notmatch '(?i)Volta' }) -join ';'
$env:PATH = $reviewNodeDir + ';' + $reviewRemainingPath
& "$reviewNodeDir/node.exe" 'node_modules/vitest/vitest.mjs' run 'tests/ipc-authorization.test.js'
```

替换为本批实际相关的具体测试文件；需要 ESLint 时同样用该 runtime 调项目本地 JS 入口并只传具体文件。最外层 Node 和可能派生的子进程 PATH 从第一条执行命令起避免 Volta。

真实 Electron/Chromium/GPU/DPAPI/窗口层级/拖动/通知等专项从第一次就使用适合访问桌面/用户缓存的沙箱外环境；依仓库要求请求执行权限。环境在业务断言前失败只记录阻塞，同一专项切换环境后的最终退出码/断言才有效。

必要构建按 T-004 的实际依赖选择，并校验产物来源；不能每次局部专项都连带 blur/capture/Qt 全部重建。测试包遵守本地 `--publish never`，本指导不授权安装/发布/部署。

不得默认运行 `npm test`、`npm run test:window-frame:win` 或其他全量入口。全量测试/完整回归/发布验证仍需要用户对应的明确要求；`--changed`/`related` 不能单独选择源码文本断言。

## 9. 阶段完成条件、停止与回退

S3 准备完成：

- [x] 当前基线、实际读取范围和未完成完整审查的边界已记录。
- [x] 审查方式、证据类别、问题分级和覆盖账本规则已确定。
- [x] 已存在保护和待核查风险分开，不虚构已复现缺陷。
- [x] 16 个 R 条目含文件/步骤/条件式修改/兼容/验证/回退，关联 T/D/C。
- [x] 高风险复现配方与 S4 决策点已列明。
- [x] 只写准备文档，未改业务/测试/构建/CI，未执行运行验证。

后续实际审查/实施仍须逐项完成：

- [ ] 每个目标功能沿入口/服务/存储/平台/返回/消费者闭环阅读，未读分支可追踪。
- [ ] 每个发现有契约、可达性、真实影响和分类；重复问题已合并。
- [ ] 所有严重问题、待规则和待环境项都有明确处理/保留原因。
- [ ] 持久化/恢复/重启/native/系统输入声明有匹配证据，模拟和历史结果不扩大证明范围。
- [ ] 每批 diff、消费者、最小测试、构建/产物、平台条件和回退已确认。
- [ ] 新增/删除测试有检测价值、独立预期和保护连续性，测试范围不会静默扩大。
- [ ] 代码/ABI/配置/包/文档一致，原有用户修改得到保护。
- [ ] 已运行局部、未运行全量与剩余风险在交付中列出。

停止相关依赖批次的条件：源码同时变化未核对、产品规则冲突、风险无最小保护、涉及未准备的数据迁移、构建来源/ABI 不明、真实环境不满足、复现只失败于环境或新模块仅透传旧全部状态。先记录并继续独立准备；不得通过全量运行、删断言、关安全能力或清用户目录绕过。

文档回退只恢复本轮新增本指导和阶段索引 diff。代码实施回退以每批真实 diff/快照为单位，所有调用方/测试/配置/产物/数据边界按相关 R 记录执行；不使用整个工作区 reset/clean 覆盖用户改动。

## 10. 本轮交付与下一阶段

本轮交付本指导并更新 README 的 S3 状态。只进行 Git/文件清单、关键路径和代表性断言阅读、文档引用/编号/路径/格式核对；没有运行单元、DB、存储、Electron、Qt、Windows native、安装/性能/全量测试，也没有 lint/构建/发布。

S3“方案准备完成”不等于完整项目审查完成、不等于 16 个风险都成立或已修复、不等于所有旧测试有效。实际多屏/DPI、重启、系统通知、异常终止恢复、安装权限、长期共存与客户设备行为仍待对应任务证据。

同日 S4 已形成 [04-implementation-plan.md](04-implementation-plan.md)，统一 T/D/R/C、条件式风险的决策路径、每批文件/消费者/保护/构建/平台/停止/回退。候选是否成立仍由后续复现决定，不能在方案阶段预先认定。代码实施与测试处置仍未开始。

## 11. S4 同日只读补充

以下补充来自三名只读子代理核对及主代理源码复核，仍是静态事实与复现依据，不是运行失败证据。

| 补充 | 当前证据 | 对 S4 的影响 |
|---|---|---|
| 月周同文档卸载有生产入口 | index.js:5551–5569 的业务清空调用 __clearEditingDrafts；useDraftProtection.js:19–25 递增 editingDataGeneration；MonthApp.vue:455–459 的 key 重建 MonthWorkspace。MonthWorkspace.vue:952–956 await 后 emit ready；978–990 的卸载释放未统一失效查询/天气序号 | Q-004/B6b 优先复现慢请求→清空→旧实例返回，核查旧 ready/DOM/焦点/新状态；不是已确认用户可见故障。根整页导航和同文档 remount 分开 |
| 跨 scope 风险与实际 reset 区分 | persistSettingValues 当前多项调用分别属 geometry/compact/dock/blur/wallpaper 同一 scope，未发现一次混 scope；index.js:5014–5015 的 reset 实际先 application 再当前 view | Q-001 在真实 reset 第二步故障点核验 timer/dirty/runtime/UI；跨 scope 是否必须全成全败待契约，不误改同 scope 壁纸互斥保护 |
| CSP 验证入口有缺项 | tests/security-hardening.test.js:9 的 HTML 列表缺 reminder.html；src/renderer/reminder.html:8 已有严格 CSP | B0b/B2a 纳入五 HTML/三 preload 能力矩阵；这是测试矩阵缺口，不能称产品 CSP 失效 |
| 运行前置与重新构建分开 | index.js:5688 创建 CaptureCoordinator、5734 initialize；CaptureCoordinator.js:87–90 预热 native helper。CaptureHost 专项也实际启动 helper；capture-business 模拟模式仍等待 engine ready | B0d 按实际入口登记 runtimePrerequisites 和 buildInputs；未改 native 可经证明复用，缺失/来源不明产物不能省略，UI 专项不能一律移除 capture 部署前置 |

remote health 中退出与 session-start 中退出分别按 Q-002 核验；已有 outbox 持久队列保留。最终日志按 Q-003 获取有界 flush/真实退出证据，不声称必丢。App/Month 壁纸、更新差异与月拒绝/周 pending 策略默认保留。测试选择/结果基础先于迁移，T-006 按域贯穿而非先删除全部。
