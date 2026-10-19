# B7a sticky 明确保存命令实施指导

日期：2026-10-09。范围：sticky 保存的数据库命令所有权及其生产/真实专项消费者；B7a 其他 feature/tray/notification/capture 装配由各自阶段负责。状态：命令、单元/lint 与真实桌面专项已验证。

## 改动与保留契约

`src/main/notes/sticky-note-commands.js` 的 `saveStickyNoteContent({ noteId, content, expectedContent, updatedAt })` 完整接管原 index 内的同步事务。父代理在 index 将 `saveContent` 接为该窄端口，移除没有其他消费者的旧 import。没有将保存命令塞入窗口注册、显示或托盘逻辑。

事务内依次读取来源便签、比较 expectedContent 文本：来源删除立即报原错误；冲突时保留最新来源文本并更新所有同源 sticky 快照；成功时先更新来源便签，再更新所有同源快照。两条分支都要求至少一个持久化 sticky，否则事务失败。保存仍比较文本，不改成 expectedVersion，也不新增第二个版本或来源缓存。

`ElectronStickyService` 继续拥有 sender 归属、输入规范化、打开窗口同步、冲突草稿保留、preview/托盘刷新和成功后 onNoteChanged。冲突回填结果不广播便签变更；成功广播在命令同步事务退出后。窗口恢复、容量、显示器/置顶和 dispose 行为保持既有实现。

## 保护和真实专项

`sticky-note-commands.test.js` 五个控制存储口用例覆盖成功/冲突/来源删除/两条无 sticky 分支，确认所有写口运行在同一命令事务内。这些 fixture 不证明 SQLite 的真实回滚。

`sticky-service.test.js` 既有窗口 fixture 保持，检查保存后的窗口同步和预览、同源冲突、来源变化处理等行为。实际桌面证据由 `sticky-persistence-electron.mjs` 负责，使用真正 Electron BrowserWindow/renderer、真实内存 SQLite 与持久化 sticky 表；Windows 下还读取真实 z-order。

真实专项改用生产 `saveStickyNoteContent`，不再复制 index 事务实现。补充真正 SQLite trigger 注入 sticky 快照 UPDATE 故障：检查来源便签 SQL 回滚、持久化快照/内存 entry 保持、未提交不广播；移除故障后的重试证明便签/快照同步成功且广播看到 inTransaction=false。冲突不广播、来源删除错误也有真实断言。原双击编辑、失焦保存、错误保留草稿、恢复、同源编辑和 closeAll 竞争保护保留。

实际 assert 由 recorder 计数；模式为 `electron-ready-memory-sqlite-real-sticky-windows`。日志证据与清理独立报告，失败保留专属 profile。此专项不是文件 SQLite 两轮主进程恢复、客户机器或所有 DPI/显示器验证。

## 验证、前置与限制

sticky-note-commands 五例与原 sticky-service 的既有局部用例已在指定十文件运行中通过；九个本域修改代码/测试文件 lint 通过。NoteCommands fixture 修正和其局部复跑记录见 B5a 指导，不能混为 sticky 产品缺陷。

真实窗口专项必须沙箱外、独占桌面串行运行，等待 B2b 的 modal GUI 场景结束。需要匹配本次 preload/renderer 的应用构建；复用该次明确构建要记录实际产物与边界，产物存在不能冒充 provenance 认证。未运行全量、安装、Qt、性能、客户机器及全部显示器组合。

## 基线与回退

基线：`tmp/refactor-baselines/B7a-sticky-2026-10-09T01-02-19-219Z/`。保存原 index、ElectronStickyService、sticky repository、db-notes、两项既有保护及 SHA-256。十文件初次单元报告保存在 B5a baseline 的 `unit-validation.json`，其中本域五例通过。

恢复时仅成组恢复 index 的 sticky saveContent callback/import、新命令消费者及专项；父代理已迁其他 index 域时不能整文件覆盖。schema/用户资料未改，不删除桌面 sticky 记录、不重置 DB。ElectronStickyService 的独立窗口生命周期与其他 B7a 装配保持各自版本；失败临时现场只按本轮 profile 归属处理。

最终真实专项在 B2b GUI 退出后沙箱外串行执行：46 个实际 assert 全部通过、0 失败/跳过，进程退出 0，业务/日志证据/script cleanup/runner cleanup 均完整，accepted=true。证据为 `tmp/test-runs/2026-10-09T01-22-45-960Z-ZovAqm/`，桌面已释放。

没有重复 app build。本批 baseline 的 `run-sticky-validation.cjs` 只运行该真实专项，记录 B2b 已明确构建的 `out/preload/sticky.js`、`out/renderer/sticky.html` 和 assets SHA-256；现有 service/命令从当前源码导入。baseline 明确 certifiedReuse=false，B2b 引用为 `tmp/test-runs/2026-10-09T01-18-19-974Z-XNek96/`；不声称其他域并行变化后的完整 app provenance。该域局部验收完成，文件 SQLite 重启与客户环境等边界仍未覆盖。
