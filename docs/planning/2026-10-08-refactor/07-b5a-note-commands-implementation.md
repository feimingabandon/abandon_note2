# B5a NoteCommands 实施与恢复指导

日期：2026-10-09。范围：两个完整便签写命令的所有权迁移、业务 IPC 接线、直接受影响保护与真实事务故障验证。状态：实现、局部单元/lint 与真实 Electron 文件 SQLite 专项已验证。

## 改动与所有权

`src/main/notes/note-commands.js` 新增 `createNoteWithAssets`、`saveNoteDraft`、`normalizeNoteCreateOptions`。直接依赖既有 db-connection、db-notes、db-images、db-reminders 与 shared 规则，不依赖 index、renderer、窗口或托盘，不另建 DB 连接/版本缓存。

`register-business-ipc.js` 保留 sender 鉴权、诊断、observeNoteMutation、原 DTO 与返回结果。create-with-assets/save-draft 各调用自己的完整命令，只有命令成功返回后才广播；普通 notes:create 复用同一创建参数规则。标签、模板、附件 batch、清空、purge、提醒调度仍保持其既有边界，本批不扩大为万能 save。

两个操作的实际链：

| 操作               | 暂存前                                                                                        | 同步事务                                                                                  | 失败补偿                                              | 提交后                       |
| ------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------- |
| create-with-assets | 单标签与附件批量限制；异步暂存添加资源                                                        | 创建便签并派生状态/提醒；提交文件、登记附件、写标签；返回完整便签                         | SQLite 回滚；删除已提交新文件；清理暂存               | 清理暂存；IPC 刷新提醒并广播 |
| save-draft         | ID、完整 editVersion、状态、附件删除归属、最终纯图/正文规则与数量限制；异步暂存添加；暂存删除 | 再取最新便签并比对完整版本；更新提醒轮次、正文/颜色/日程/标签；删除附件记录并提交添加资源 | SQLite 回滚；删除新文件；清理添加暂存；逆序恢复原文件 | 清理添加/删除暂存；IPC 广播  |

版本同时包含正文、备注、状态、日程、提醒、颜色、标签和附件 id/path/size/sort。事务中的复核也覆盖暂存期间附件归属/关系改变，不退化为 updated_at 时间戳比较。SQL 事务仍同步；不会在事务中 await 文件写入。

既有图片清理/恢复口的容错日志和恢复 manifest 保留。已提交后的广播或托盘展示失败不能删除已提交文件，也不能将业务提交改报失败。恢复/清空由其独立域处理，不将临时资源清理移入 renderer。

## 保护的迁移与新增

`image-only-note.test.js`、`historical-note-backfill-ui.test.js` 仅把属于完整命令的源码读取断言指向新的拥有者，断言内容保留。其余 API/授权/颜色/备注/剪贴板消费者仍在原 IPC 位置。

`note-commands.test.js` 六个控制依赖用例核对：阶段失败不启动 SQL、已提交新文件补偿、外来附件拒绝、异步暂存后版本复核、原文件恢复、创建与草稿不同契约。这些 fixture 不证明真实 SQLite 回滚。

`note-draft-conflict-electron.mjs` 使用真正的文件 SQLite、真实附件文件、真实 Electron ready；IPC sender 和广播窗口是同进程授权 fixture，没有 renderer 窗口。新增真正 SQLite trigger 令附件记录 INSERT 失败，分别证明创建整体回滚，以及草稿的正文/标签/提醒/附件回滚、原文件恢复、失败无成功广播；解除故障后重试检查完整成功。既有同毫秒、颜色/状态/标签/附件竞争、暂存竞争、成功后广播失败保护保留。

专项通过 recorder 统计实际执行的 assert，并输出独立断言完成、日志证据、清理/保留结果。模式为 `electron-ready-file-sqlite-real-attachments-mocked-ipc`；不能称为真实 renderer、真实主进程重启或客户机器证据。

## 已运行验证与当前限制

2026-10-09 指定十文件局部 Vitest：note-commands、sticky-note-commands、sticky-service、attachment-rules、editing-draft-guard、editing-draft-session、image-only-note、historical-note-backfill-ui、ipc-authorization、ipc-arguments。首轮 53 例中 49 通过，四个新增 fixture 的断言错误地把 Array.map 索引/数组也当作业务参数；改成核对资源对象后只重跑 note-commands 六例，全部通过。其余九文件先前 47 例通过。首次失败现场未覆盖。

本域九个修改代码/测试文件 ESLint --no-cache 通过，修正后的 note-commands 测试再次 lint 通过。未运行全量、安装、Qt、性能、客户机器或真实两轮重启。

真实专项的首次只读计划尚未执行测试：并行 B3 创建中的数据库 runtime 源/登记不完整使 registry 拒绝，记录 executed:false。等待完整登记再执行；此项不是业务失败或通过。

## 基线、证据与回退

基线：`tmp/refactor-baselines/B5a-2026-10-09T01-01-30-247Z/`。`baseline.json`、`files/` 保存原 IPC、事务依赖及关键保护；后补的两项源码读取原文件与哈希见 `source-assertion-baseline.json`。`unit-validation.json` 是首次结果，`unit-validation-retry.json` 是修正 fixture 后的六例结果。

回退以本域为单位：恢复原 create-with-assets/save-draft 两段和创建 normalization、匹配 import、两项 source-read 测试；撤回新命令与对应新增保护。若已接入其他批次 IPC，不整文件覆盖其改动。数据库 schema、真实用户库和用户附件布局均未改；禁止用旧库覆盖最新库或借回退删附件。专项临时目录只按本次 runner/profile 归属清理，失败现场保留。

最终专项：指定 Node 与去 Volta PATH 调用 focused runner，仅选择 `tests/note-draft-conflict-electron.mjs`。52 个实际 assert 全部通过、0 失败/跳过，进程退出 0，业务/日志证据/script cleanup/runner cleanup 均完整，accepted=true。证据为 `tmp/test-runs/2026-10-09T01-21-38-967Z-DKy4J1/`；没有 app build，也没有扩大为全量。此前 registry 中间态已解除，真实 SQLite trigger 与实际文件回滚保护已执行。

该域局部验收完成。覆盖仍受上述同进程 IPC fixture/无 renderer/无客户环境边界约束；全库 lint 或一次退出码不能替代事务证明。
