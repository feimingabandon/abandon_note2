# B7b 数据、设置、模板与提醒审查记录

日期：2026-10-09。对应审查指导 R-001～R-006。结论以当前源实现、独立专项记录及本批定向复现分开登记；没有把六个领域统一标成“全部通过”。本文件是实施时的逐项指导和审查处置账。

## 1. 阅读范围与证据等级

以下源文件在本批完整阅读；`index.js` 只阅读相关接线块，不把主入口局部读取记成完整阅读。

| 源范围                   | 完整阅读的文件                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB 连接/迁移/清空        | `db/db.js`、`db-connection.js`、`db-runtime.js`、`db-schema.js`、`db-migration-backup.js`、`attachment-recovery.js`、`business-data-reset.js`             |
| 笔记/附件/标签/提醒/模板 | `db/db-notes.js`、`db-images.js`、`db-wallpapers.js`、`db-tags.js`、`db-reminders.js`、`db-templates.js`                                                  |
| 完整写命令和业务边界     | `notes/note-commands.js`、`notes/sticky-note-commands.js`、`ipc/register-business-ipc.js`                                                                 |
| 设置作用域/运行状态      | `db/db-settings-repository.js`、`settings/application-settings.js`、`settings/settings-runtime.js`                                                        |
| 日期、模板、调度         | `services/recurrence.js`、`recurrence-rules.js`、`template-scheduler-guard.js`、`scheduler.js`、`calendar/recurring-note-preview.js`                      |
| 提醒展示和授权           | `services/ReminderService.js`、`ReminderWindow.js`、`NotificationService.js`、`TrayReminderController.js`、`notification-guard.js`、`preload/reminder.js` |
| 共享规则与草稿           | `shared/reminder-rules.js`、`reminder-protocol.js`、`notification-policy.js`、`tag-rules.js`、`renderer/src/composables/useDraftProtection.js`            |

`SettingsPanel.vue`、`useSettingsWriteQueue.js`、两个设置表单/区块的完整阅读和实施证据见 B6c/B6d。`settings-schema.js` 的 ID/键/默认/允许值已由 B1/B6 相关批次核对，本批没有重新宣称完整逐项映射验证。`editing-draft-guard.js`、所有表单消费者、ReminderApp、日期规则全部消费者不在本次完整阅读声明内。

另外实际阅读：审查指导 R-001～R-006；DB 恢复实施记录；B5a/B7a sticky、B6c/B6d、Q001 实施记录；笔记命令、提醒服务、模板保护测试完整文件；其他既有专项只定位相关断言，因此“存在该断言”不等于“本批运行通过”。

本批没有为只读审查执行宽范围单元回归。唯一新运行是 §5 的生产函数受控顺序复现。其他已通过计数来自已保存的对应实施专项，保留原运行范围和限制。

## 2. R-001：数据库生命周期与迁移

### 已核对

- 候选连接先配置 WAL/NORMAL/cache/FK、执行迁移前备份和 schema，完成后才安装到唯一 `db-connection`。失败关闭候选并清引用；重复初始化拒绝第二连接。业务和设置 repository 都读取同一连接。
- 当前 schema 为 17；高于 17 的版本在建表/迁移前拒绝。V0 依据实际结构识别，不能仅凭 `user_version=0` 当成空库。
- 迁移中的数据/结构与 `user_version` 在同一同步事务；基础表/索引创建在该迁移事务外，因此不能宣称所有迁移失败都令数据库文件字节完全不变。
- 备份采用 SQLite 一致快照方式。当前只为已登记的破坏性结构条件备份；已有同名备份复用，不保证每次尝试生成新的备份。

### 已有证据及剩余边界

DB 实施记录中的 runtime 专项 25 个实际断言验证 WAL/pragmas、同连接、关闭重开、第二 init 拒绝、V7 废弃行清理前备份、未来版本拒绝及引用清除。附件恢复专项含独立 seed/recover 子进程。它们不等价于全部 V0～V16 历史迁移或主应用两轮重启。

下一次真正修改迁移时，先列该迁移支持的输入结构并为相应 fixture 副本逐项验证行、关系、默认、触发器、索引、版本和失败回滚。未知旧结构保留并登记；不自动“修好”客户数据库。本次不递增 schema，不重写已有迁移，不把所有迁移一并重跑。

迁移逐项处置如下；“已读”不代表各历史fixture已经运行。本表只绑定当前实际结构条件，不保证任意手工改过的库可修复。

| 输入/目标   | 已读实现与审查结论                                               | 本轮验证分类                                                     |
| ----------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| fresh V0    | 建最终表结构后按缺列/关系条件进入迁移；不把V0自动当旧结构        | runtime真实专项包含fresh；全部表默认/索引专项未逐项新增          |
| 真实旧V0/V1 | 按缺列、tag_name、旧pin等结构识别；迁移前备份按破坏性条件选择    | 源码已读；本批未声称覆盖全部旧结构fixture                        |
| V2          | duration_days列/1～365约束，缺列可重入                           | 已读保留，独立旧fixture回滚待相关变更时核验                      |
| V3          | tag_name→稳定tag_id，orphan/行数/FK校验，list_filter迁移         | 已读保留；其备份逻辑已核对；本批未重跑V3fixture                  |
| V4/V6       | 旧pin只为缺sort_order旧库临时补；V6按旧偏好生成槽位并删pin列     | 已读保留，不误判fresh库需要加废字段；本批未重跑每种pin组合       |
| V5          | 删除旧remind_again列/索引                                        | 已读保留；新提醒round模型不是旧字段复活                          |
| V7          | desktop_stickies schema                                          | 已读保留；具体旧sticky结构fixture仍待对应迁移变更                |
| V8          | 删除已废dock位置，备份VACUUM一致快照                             | DB runtime专项实际V7→cleanup/备份原值已验证；不证明所有scope组合 |
| V9          | from_template列，仅当前last_generated关系可确认来源者回填        | 已读保留，不推测已失去关系的历史来源                             |
| V10/V11     | 先移除compact enabled再清旧compact设置                           | 已读保留，新的presentation状态不写回废弃启动字段                 |
| V12         | remark非空默认空串                                               | 已读保留；全部旧数据fixture未本批运行                            |
| V13         | duration_kind三态并回填多天fixed，删除废历史移动设置             | 已读保留；duration真实专项归相关命令/日历批次，不代签迁移fixture |
| V14         | content_color_ranges默认[]                                       | 已读保留；颜色规则测试不等于历史库迁移回滚                       |
| V15         | 模板start/end，缺start从anchor按秒回填                           | 已读保留，范围规则与回填fixture需独立验收                        |
| V16         | 保留兼容号/旧废布局表，不新建或倒版本；无单独V16迁移函数         | 已读保留；提醒既有专项存在V16→17fixture，本批未运行              |
| V17/current | note/template channels与round schema；缺结构仍检查，版本事务提交 | 已读保留；runtime当前重开验证不能替代round迁移全部触发器fixture  |
| >17         | schema修改前拒绝、候选关闭/引用清除                              | runtime真实专项已验证，支持范围明确止于17                        |

## 3. R-002：跨资源事务与 Q008

### 保留的保护

附件新增先异步 stage，事务内同卷 rename、SQL 记录与关系；失败删除新文件并清 staging。删除/purge 先隔离旧文件，SQL 失败逆序恢复。纯图片便签最后一张、资产归属、数量限制在主进程受保护。恢复按已登记 manifest 和 DB 是否引用决定保留/恢复/清理；未知或冲突附件现场保留。

业务清空先移动附件目录，再同步清业务表；失败恢复目录。提交后写 marker/异步删 pending 的错误记录后保持业务成功，下次启动恢复。附件 `cleanupStagedImage` 吸收非 ENOENT 清理错误并警告；`deleteImageFile` 返回失败，保留资料，不能让清理异常覆盖原 SQL 错误。

壁纸保存/删除共用串行 mutation queue，包含原图去重判断、文件提交和 SQL，防止同原图并发判断失配。每次裁剪独立版本；多个视图 selection 按传入 scope 在删除事务内清理。`committed` 后最终目录清理返回失败仍保留成功。Q008 所指现有 committed/cleanup 保护成立，本批没有因审查而改写它。

### 已有证据及新缺口

DB 域修改前后附件存储各 30 个实际断言；双进程恢复控制器 18，seed 2/recover 19 分开报告；实际 SQL 清空失败补偿与提交后清理故障已验证。B5a draft 专项 52 个实际断言覆盖当前源命令、实际 SQLite/附件和 SQL 故障，IPC 为进程内授权 fixture；不是完整 renderer。

应用清空与在途新建跨越异步 staging 的问题在 §5 成立。该问题属于完整命令准入与 clear 编排，不能通过撤销 committed 清理保护解决。文件占用、磁盘不足、任意崩溃点/断电和客户环境仍待相关平台专项。壁纸各故障点不能因为附件专项通过而统一签收。

## 4. R-003：设置 scope、队列与实际状态

数据库主键是 `(window_name,key)`，`type` 不参与冲突；repository 使用相同 ON CONFLICT。weather 和 retired shortcut 的 enabled 必须按 schema 键与分流解释。shortcut gate 仅在 settings runtime 本次运行中保存；读 snapshot 不向 DB 写回。系统自启仅回读 OS，不能用 DB 设置值替代。

应用级 ID 在 `APPLICATION_SETTING_IDS` 注册；视图 scope 为 main/month/week。周视图首次继承及应用级窗口设置迁移保留原语义。Q001 已经用实际磁盘 DELETE trigger 复现第二 scope 失败导致先前部分提交，并以当前连接的窄 reset group 事务修复。runtime、geometry dirty/timer、revision 和广播在 SQL 成功后更新。

B6c 队列唯一拥有 debounce/inFlight/revision/reset gate，完整失败恢复链参与排空。旧 blur 意图在入队时失效；reset 清未发并等在途，失败回读实际值、保留错误、允许用户再操作。B6d 子区块复用原 refs，不新增第二 IPC/写队列。

当前证据：Q001 两文件 24 单元；repository 专项 49 实际断言；B6 GUI 50 实际断言，实际 renderer/preload/main/磁盘库贯通，注入第二 scope 失败后 rows/values/revision/gate/runtime 不变，后续写成功，重试成功且几何行不晚到重插。构建与 reused output 限制见 B6c/B6d 文档。这不能签收 OS 自启真实写入、原生 blur 有效状态、重启持久化全路径、全部 DPI 或 macOS。

本次没有额外把所有单项写变成全局队列，也没有更改 ID/键/scope。以后新设置必须更新完整 ID→键→scope→allowlist→runtime→broadcast→启动读取映射；按实际影响新增局部证据。

## 5. R-004：草稿版本、状态、清空竞态

### 既有规则

`editVersion` 对实际正文/文字颜色/备注/状态/有效和完成时间/持续方式/提醒/固定状态/时间戳/排序后的标签 ID 与附件关系求 hash，避免毫秒时间相同掩盖关系变化。draft 在 stage 前及同步事务内再次比较版本；附件删除校验目标归属，提醒编辑含 expected round/dueAt，标签、资源和正文在同一事务。状态只能沿 initialized→in_progress⇄completed，软删/恢复不会恢复提醒，旧关系资产保留到物理清空。

草稿 localStorage 仅供同一次主进程启动重载/切视图；旧启动 session 记录清理。`__clearEditingDrafts` 删除当前 session 后标记 mounted entries discarded，再提高 generation，阻止卸载 flush 重建草稿。storage失败阻止退出/导航，不暗中覆盖数据库。

业务 clear handler 已明确区分“数据库已清空但草稿清理失败”，这条语义继续保留。它目前在 `await clearNoteData()` 后才刷新提醒、丢弃 sticky/草稿并广播。

### 本批成立问题：旧新建在 clear 后提交

复现目录 `tmp/refactor-baselines/B7b-clear-race`。脚本直接读取当前 `createNoteWithAssets` 生产函数，记录源 SHA256；仅依赖 stage/SQL/file fixture 受控。实际顺序：

1. 旧 mounted form 发起带图片的新建，停在 stage Promise。
2. 模拟 clear SQL 完成，业务 rows=0。
3. stage 放行；现有完整命令继续 create SQL，rows=1，正文为旧表单内容。

`result.json` 为 `reproduced=true`，运行退出 0。它证明生产命令存在可达的顺序缺口；不是实际 SQLite、真实文件或完整 GUI clear 证据，不推断客户已遭遇。

### 修复指导和验收边界

引入唯一业务变更准入/排空 owner：业务写命令登记到完整 Promise（包括资源清理/补偿）；clear 同步关闭新准入，排空已准入命令，再清 DB/文件、renderer drafts、reminder/sticky 和广播，finally 恢复准入。不能只追加 renderer generation；不能在 SQLite 与文件 commit 中间插 await。clear 失败仍恢复可写；已提交 clear 的草稿清理错误继续明确报告已清空事实。

必须覆盖带附件创建/保存/单独 image batch 与 clear；其余同步写在同一准入边界阻断 clear 尚在执行时的复活。不要把 screenshot 自己的所有生命周期并入 DB gate：截图到 note 的实际最终提交必须经过它。

本缺口复现后已交父代理和主入口 owner 协调；最终变更、真实专项和残余风险由后续独立实施记录签收。本文件不将尚未实施或仅受控复现的修复标为通过。

## 6. R-005：模板与调度故障边界

模板事务重读当前未删未暂停行，拒绝未来节点；历史积压不批量补发，只寻找当天已到时规则节点。生成独立快照，稳定继承旧多标签第一项；上一未完成实例软删，已完成保留。新实例/标签/提醒/next_run/last_generated/失败清零同事务，JS result/通知列表只在提交后更新。记录单项失败本身失败时 AggregateError 交给服务保护，不吞掉服务错误。

三个阈值保持独立：单模板连续失败默认 3 自动暂停；`TemplateSchedulerGuard` 3 次服务失败后按 5 分钟重试；`Scheduler` 默认任务 10 连续失败，但实际 activation/template/reminder 等注册 `Infinity`，部分带 retryBackoff。watchdog 3 次恢复告警又是主线存活保护。不能统一这些策略。

Scheduler 是同步分发；`lastTickAt` 表示同步分发完成。天气 refresh controller 自己拥有 pending/generation/backoff，异步 finish 记录等待完成；不能据 tick 退出声称天气网络完成，也不因此重写为全局异步调度器。

本批完整阅读规则/事务/接线，已有 guard/scheduler/日期/DB专项被定位，但没有重跑全部模板专项，未给全部日期规则签“通过”。后续改规则需用独立固定日期核验季度/月末/闰年、range边界、当天/历史skip、重复startup/recovery/resume、失败回滚及3次暂停；Asia/Shanghai 和 DST、真实休眠/改时分开留证。

## 7. R-006：提醒轮次、渠道与协议激活

DB partial unique 约束一张 note 只有一个 live round；parent unique 阻止重复 snooze 子轮次。旧 active round 的重复 snooze只返回仍 scheduled 的已生成子项；已处理/过期轮次不可改新轮次。编辑 pending 同时校验 round id/dueAt。完成、删除或 channels0 触发取消；物理删 FK cascade。

系统发送尝试最多3，成功 send仅标请求accepted，failed事件撤delivery位；不推断用户看见。展示 refresh 各渠道 try/catch 隔离，popup失败不阻断tray。dispose先立disposed并停timer，晚到failure callback不能再写DB。Notification dispose移除监听但保留已送 Windows toast跨启动操作，这是产品语义。

专属 ReminderWindow/IPC 校验 sender 属于当前授权窗口，action必须属于当前 rows；现有 helper 并未额外核查 senderFrame/main frame，本批不把该安全边界签成通过，应由 R-010 IPC 审查单列判定与验证。renderer失效销毁，后续sync负责重建。协议仅允许已登记 scheme/notification host/路径/round与4种minutes；服务未就绪暂存最多32动作，ready后逐条nativeAction由round校验。open仅唤醒当前应用，不定位旧noteid。pending reveal等主窗口/renderer可用，再退出compact并显示，失败仍尝试打开。

本批读取这些真实接线后，下一批将迁移 activation pending/state 和 feature/tray完整生命周期，不改变round/协议/平台策略。新模块单元可验证早期接收、队列上限、消费与dispose/恢复；必须另有真实 app专项确认接线。既有同进程模拟protocol/reminder测试不等于真实系统toast、退出冷启、Windows协议关联或客户接受验证，native acceptance只能在用户授权专项下单列。

## 8. 本次处置、为何不改与后续顺序

| 审查项     | 处置                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------- |
| R-001      | 连接/版本保护保留；支持迁移矩阵仍逐迁移登记，未做无证据 schema 改造                      |
| R-002/Q008 | committed/cleanup 保护保留；在途清空竞态交完整准入编排；任意崩溃/占用保留边界            |
| R-003/Q001 | 已独立复现并修复，引用精准证据；OS/native/重启不由GUI结果代签                            |
| R-004      | 版本/归属/草稿session保留；旧创建跨clear问题成立，后续窄owner和专项验收                  |
| R-005      | 历史skip、快照与三个阈值保留；日期/恢复平台矩阵未统一签收                                |
| R-006      | 轮次/渠道/late callback保护保留；pending激活/服务创建/tray owner迁移继续，真实OS接受单列 |

结案分类：R-001为“已读闭环、已有生命周期证据、迁移fixture边界保留”；R-002为“原提交保护保留、应用准入缺陷成立、平台故障边界保留”；R-003为“Q001独立修复有证据、剩余OS/native/restart边界保留”；R-004为“版本与草稿session保护保留、clear竞态待授权实施”；R-005为“现有规则/阈值已读闭环，未发现需无证据改写项，日期/恢复专项逐项保留”；R-006为“round/channel保护已读闭环，activation/生命周期待授权迁移，系统接受与senderFrame交对应审查”。这些是本次审查处置完成状态，不能解读为六个领域所有行为都已完整测试通过。

先完成成立clear竞态的完整边界，再将feature/tray/activation按实际状态owner迁出主入口；最后复核源码保护与针对真实接线的局部专项。纯解耦不修改schema、提醒数据格式、协议URL或草稿跨启动策略。每次失败保留原日志与run/token，修正fixture失败不算产品失败；没有运行全量回归、打包、安装或发布。

## 9. 后续实施状态更新

后续明确授权实施后，R-004 的唯一业务准入 owner 和完整注册器消费者已落盘；R-006 的 feature/tray/activation 与天气资源生命周期已按具名拥有者迁移，主入口接线已完成。§5 原顺序复现与 §8 原准备阶段分类保留为历史依据，不代表现阶段仍未授权。当前实际实现与证据见 `16-b7a-feature-and-clear-guidance.md` §10。

随后新增 clearTask 与退出排空、便利贴独立 ready 续段、受限同步 final-bounds cleanup、提醒 timer/native late 写门禁与 partial 注册回收，并保持 tray busy 的原失败契约；相应单元 54/54 已通过。gate 源改变后已精准重跑：run `tmp/test-runs/2026-10-09T03-28-40-290Z-oElUD0` 中业务 clear 30/30、sticky persistence 52/52、application lifecycle 32/32 均 accepted。clear 为真实磁盘 SQLite/附件/生产注册器和进程内 IPC；sticky 为真实窗口与内存 SQLite；lifecycle 为真实主应用 normal/reentrant 两次独立进程，各自边界分开。run `tmp/test-runs/2026-10-09T03-34-16-718Z-ygxBDo` 中 feature 真实 main/preload/renderer/磁盘 SQLite/tray/sticky/草稿/退出排空 40/40，accepted，且 build-app 复用来源验证 true。原 31 assert 后测试夹具 clone 失败保留，未算产品失败；准确路径和修正见 §10。

收尾又成立一个 Reminder late failure 缺陷：clear 封闭期间丢弃 native failed，而 clear SQL 随后失败，原 live round 的 accepted delivery 位令后续 tick 永不重试。经明确允许后，以确切发送 token/完整 durable 身份与内存 failure 缓冲窄修；成功 clear 清旧身份、新 attempt 拒旧 callback、退出零迟到 SQL。生产源受控红绿与增量 25/25 单元见 `16-b7a-feature-and-clear-guidance.md` §11。新增真实磁盘/默认生产 ReminderService 与 `db-reminders` 场景仅落到既有业务 clear 专项；run `tmp/test-runs/2026-10-09T03-41-04-777Z-Clk3cP/tests_business-clear-admission-electron.mjs-m4lL6W/result.json` 已正式 58/58、raw exit 0、accepted、业务/证据/脚本及 runner 清理完整。它包含原 30 项和新增 28 项：实际 joined row 身份、attempt/backoff/delivery 更新、SQLite clear trigger 回滚后原轮次重试、成功 clear 后完全复用身份的新 token 隔离及退出零迟到 SQL。OS transport 明确模拟，不代签真实 toast failed 事件或用户看见通知。

前期准备阶段的 production admission/业务 IPC/测试补丁曾被自动审批拒绝，理由是当时用户仅授权前期准备，那个补丁未执行。随后用户明确授权实施，才落下上述模块与测试；本段仅保留授权历史，不构成当前实施阻塞，也不将历史方案或旧证据记为当前全部行为通过。Windows toast 接受、系统协议关联/冷启、真实电源事件、DPI/macOS/客户机、任意磁盘故障与长时运行仍保留专项边界。没有运行全量回归、打包、安装或发布。
