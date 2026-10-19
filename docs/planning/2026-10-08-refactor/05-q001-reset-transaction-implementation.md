# Q-001：跨作用域恢复默认的复现与修复

2026-10-09，属于 B1/B5b/B6c 联合保护。恢复基线 `tmp/refactor-baselines/Q001-2026-10-09T01-39-25-645Z`。这是成立后修复的存储问题，不把所有设置写入改成新的通用事务。

## 问题与修改步骤

真实磁盘 SQLite 注入当前 main scope 的 DELETE 失败。原入口顺序先 resetApplicationSettingsToDefaults，再 clearSettings(main)。原序列失败后 weather.enabled 从true变为false，而main宽度777仍在；操作reject却已部分恢复全局。复现 `tmp/q001-before.json`，只证明原存储顺序，不冒称原UI或timer副作用已经复现。

新增 repository.resetSettingsGroup，在当前唯一连接的一次同步事务内写application默认组并删当前view；新增 application-settings.resetCurrentViewSettings(viewMode) 按原默认schema和scope调用，返回原两个统计。失败回滚所有scope，成功后保持原默认值、metadata、其它视图和业务数据语义。旧只恢复application的方法仍为其它明确调用方保留，不添加全局事务容器。

主入口接复合命令后才 cancelDock/geometry.cancel/markSaved，随后按原顺序刷新runtime、应用window/blur/dock、广播和750ms抑制默认尺寸事件。不能在SQL失败前清geometry dirty或更新UI revision。前端仍保留队列排空、watcher gate和错误显示，失败回读实际snapshot后允许下一次用户操作；不能用自动retry掩盖一次部分提交。

## 实际验证

- application-settings和settings-runtime两文件24 unit通过，`tmp/q001-unit-results.json`。三文件lint通过。
- 增强settings-repository-db专项49实际assert通过，注入view删除失败后application/current/其它scope逐行相等，业务note保留，drop trigger后retry成功。证据 `tmp/test-runs/2026-10-09T01-40-42-479Z-cUldkv`，accepted/evidence/cleanup完整。
- B6c/B6d新settings-queue真实GUI专项50实际assert通过，`tmp/test-runs/2026-10-09T01-48-43-449Z-vFgufD`。真实persistent DELETE trigger使实际renderer→preload→主进程reset拒绝；application/current/other/geometry rows、resolved.values、revision、session shortcut gate及runtime完全保持；UI回填和下一sticky写成功；删除trigger后同一UI重试reset成功，1秒后main几何不重插。详细构建、其它UI验证与清理见13/14域指导。

未运行全量、安装、客户环境或OS auto-start写入。SQL回滚证明不等于所有系统副作用原子化；本改动确保SQL成功前不改变相应runtime，提交后的原有OS/native错误仍由所属能力报告。

## 回退及以后怎么改

回退repository/app-settings/入口命令和对应故障断言一起恢复，禁止只撤外层事务而保留新UI成功预期；保护其它域工作区与用户数据库。以后新增复合设置命令先区分纯SQL组与OS/native动作，确定每一步的成功和失败回填，再写故障注入；不能仅以新函数名字测试实现，也不能由scope数量猜测事务规则。
