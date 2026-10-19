# B6a 笔记列表模型实施与后续验证指导

更新日期：2026-10-09。用户已明确恢复代码实施授权。本批源码冻结；最后anchor修复已包含在统一共享构建中，Timeline 66/66、Custom 17/17实际断言通过且accepted。TagGroup保留此前阶段79/79证据；不运行全量、安装或发布。

## 1. 当前状态，不能混用不同阶段的证据

| 子批 | 代码状态 | 已验证 | 未完成 |
| --- | --- | --- | --- |
| Timeline | 已移交完整查询、历史分页、分组和折叠状态 | 最后anchor修复后的共享构建与真实窗口专项66/66，accepted | 原生输入、重启、客户机器等平台场景 |
| Custom | 已移交查询、日常分页、排序槽分配与保存失败恢复 | 最后anchor修复后的共享构建与真实窗口专项17/17，accepted | 真实指针拖拽、重启、客户机器等平台场景 |
| TagGroup | 已移交分组、展开意图、分页、完整刷新、排序数据命令 | 模型行为单元及此前Tag阶段真实窗口专项79/79；本轮未重跑 | 未独立覆盖原生指针拖拽、重启、客户机器等平台场景 |
| 共用父session与摘要merge | 已建立唯一拥有者 | 四指定Vitest文件22用例通过；最终共享构建后的Timeline/Custom必要专项完成 | 仅支持列明的行为范围，未覆盖全项目 |

22个用例来自 `timeline-list-model.test.js`（7）、`custom-list-model.test.js`（6）、`tag-group-list-model.test.js`（6）、`tag-group-ordering-ui.test.js`（3），证据 `tmp/refactor-baselines/B6a-2026-10-09-list/anchor-after.json`。这是模型/源码保护结果；最终共享构建后的真实GUI结果另列第4节，不能由这22用例外推全部UI行为。

## 2. 文件拥有者与明确改法

| 拥有者 | 已移动职责 | 组件连接方式 |
| --- | --- | --- |
| `useNoteListQuerySession.js` | 三模式共用父generation、loading/error、总数与刷新时间；begin同步使所有子页失效；finish/fail只接受当前token；dispose停止旧实例结果 | 根读取readonly状态；不再另建loadSeq；通过begin/isCurrent/markRefreshed连接 |
| `useTimelineListModel.js` | 完整列表、置顶归属、历史ID/offset/limit/计数、reload/child令牌、collapse/reopen最新意图及时间分组 | 根用replaceItems/patchNote/toggleGroupCollapse等窄命令；DOM锚点、布局、动画留adapter |
| `useCustomListModel.js` | 置顶/日常查询、独立分页规则、已有sort slots分配、排序保存及失败重查 | vuedraggable区数组是组件显示adapter；reorderZone复制项并分配原有槽位，不穿越另一区 |
| `useTagGroupListModel.js` | 概览和分组页、展开集合、opening/loading/requestedCount、parent/child generation、后台局部快照及最终原子提交 | UI传入readonly group handle，模型按key解析为当前拥有的组；分组v-model通过computed setter/replaceGroups命令连接；未分类仍最后 |
| `utils/noteListItem.js` | 局部状态响应缺少标签、附件计数和摘要字段时保留已有值 | 三模型patchNote复用纯merge函数；根不深层修改模型数组/分组 |
| `NoteList.vue` | 排列/筛选控制、模式切换动画、anchor/focus/scroll、Popover/drag UI、状态动画、订阅和显示adapter | 保留现有跨模式策略与失败回滚，不将三种分页规则统一成通用分页器 |

Timeline后台刷新先收齐全部已浏览历史，再一次提交；单IPC最多100条，超过100按多页补齐。刷新期间collapse/reopen使旧展开页无效；离场完成前保留历史DOM，反转复用现有节点。Custom继续自身首10/随后20及筛选规则，没有套用Timeline分组语义。TagGroup刷新期间继续接纳最新展开/收起及requestedCount；一组查询失败保留完整旧快照。

DOM refs、原模板、CSS、主题、控件和浮层未迁移或重设计。与恢复副本比较，统一CRLF/LF后从`<template>`到文件末尾字符完全一致。未来若改显示/CSS，必须先完整读取UI_DESIGN_STANDARD，不能依据此次纯脚本迁移绕过该要求。

## 3. anchor迟到问题与实际保护

只读复核候选已经通过两项deferred restoreAnchor用例确认：旧完整查询提交后等待锚点恢复，新模式已开始刷新时，旧任务仍返回success并更新共用lastRefreshedAt。

- 失败证据：`anchor-before.json`，Timeline和Custom均实际返回success，预期cancelled。
- 已做最小修复：各模型在`await presentation.restoreAnchor(anchor)`后再次`session.isCurrent(seq)`检查，不当前则返回cancelled，不markRefreshed，不驱动外层success动画。
- 最终单元证据：`anchor-after.json`，22用例通过。
- 此修复位于此前Tag构建之后。本轮统一共享构建已包含修复，Timeline/Custom分别66/66、17/17实际断言通过，exit0且business/evidence/cleanup完整，accepted；此前Tag阶段79/79仍按原阶段解释。

## 4. 真实专项证据与失败记录

| 专项 | 最近accepted证据目录（按阶段） | 实际断言/边界 |
| --- | --- | --- |
| `tests/note-list-refresh-electron.mjs` | `tmp/test-runs/2026-10-09T03-28-40-290Z-oElUD0/tests_note-list-refresh-electron.mjs-ZYsZpE` | 66/66；真实窗口/磁盘DB、稳定DOM/scroll、历史超过100条、错误/collapse/模式取消；包含最后anchor修复 |
| `tests/note-list-custom-electron.mjs` | `tmp/test-runs/2026-10-09T03-28-40-290Z-oElUD0/tests_note-list-custom-electron.mjs-hdbLc0` | 17/17；真实窗口/DB、分页/失败快照、既有槽位保存、跨模式取消；包含最后anchor修复；输入为真实Sortable的合成回调，未证明原生指针拖动 |
| `tests/note-list-tag-refresh-electron.mjs` | `tmp/test-runs/2026-10-09T01-54-12-480Z-HhjhTZ` | 79/79；此前Tag阶段的长分组原子刷新、部分失败、最新scroll/展开/收起、下一页并发、模式取消；本轮未重跑 |

本轮Timeline/Custom的result.json均为accepted=true、exit0、business passed、evidence complete及script+runner cleanup complete；两份报告记录实际assert调用及截图/JSON。Tag报告保留此前阶段的同类证据，只能按各自声明的本地环境范围解释。历史成功目录 `tmp/test-runs/2026-10-09T01-39-05-843Z-muRQza` 与 `tmp/test-runs/2026-10-09T01-50-08-453Z-hshY30`继续保留，早于最后anchor修复。

首次统一构建运行 `tmp/test-runs/2026-10-09T03-17-06-973Z-lpK69s`保留为失败attempt：主进程SettingsRuntime构造时同步调用后置mainViewNavigation getter，出现TDZ启动错误。这是代码初始化失败，不能记为环境阻塞或GUI通过。之后以不可变初始view seed及惰性依赖端口修复；本轮共享构建及上述真实专项通过，首次失败证据不覆盖。

保留Timeline首次`01-32-13-360Z-HmiDfv`失败：组件漏接earlierOffset，数据已提交16条却未显示历史disclosure；补回readonly ref后重构建并通过。Custom前三个失败attempt（`01-45-00-622Z-omsOLV`、`01-45-34-309Z-w9UAlk`、`01-47-26-766Z-xUbW9A`）属于新fixture错误：生产Vue无dev instance访问；旧Custom模式修复二次load令before瞬时读到空数组。修改测试为Sortable实际回调、稳定等待及非空基线后17次断言通过；没有因此继续修改产品排序规则。

`custom-build-{before,after}.json`和`tag-build-{before,after}.json`记录src/package/config构建前后相等及out输出哈希。Tag阶段主代理09:54:00和本子代理09:54:12做了两次串行重复构建；`tag-shared-output-check.json`确认最终out仍与捕捉的输出全部SHA相同。这些旧阶段记录是限定输入范围的人工构建证据，**不是完整工具链来源证明或可认证复用**。

本轮共享app构建证据为 `tmp/test-runs/2026-10-09T03-28-40-290Z-oElUD0/build-app-qxZs1f`：build-current-inputs passed、provenance verified、输入/工具链closure匹配，runner accepted=true；proof为 `tmp/test-build-proofs/build-app/0001791516584978/proof.json`。ABI状态仅declared-only，构建本身不证明native/桌面业务。此次GUI使用该冻结构建；本轮没有在运行中继续修改本批源码。

## 5. 本轮已完成的局部验收与后续执行规则

1. 本轮已冻结本批模型/adapter及共享main/preload源，并完成一次统一app构建和来源证明。后续共享out仍须协调唯一构建窗口；没有完整closure时据实记人工构建，不得在GUI运行中改写out。
2. 使用指定Node和去Volta的PATH，精确运行上述四Vitest文件以及这次实际改动的model/adapter/helper/test的ESLint `--no-cache`。不要自动扩展到工作区其他dirty变动。
3. 当前最后anchor变动所必需的app build和Timeline/Custom真实专项已完成并accepted。后续仅按实际变动选择对应专项；若Tag模型/adapter或共同查询行为再变动，再评估加入`note-list-tag-refresh-electron.mjs`，不能自动全量。
4. 若真实指针拖拽列为验收目标，追加限定两区/筛选/paging的本地专项，不把现有合成回调升级称已覆盖；故障、模式变化和卸载的迟到结果都需当前token证明。
5. 本指导已按本轮实际结果更新；未通过保留attempt和具体失效步骤。accepted继续同时要求业务completed、实际断言、证据、script+runner cleanup及有效退出码，不能以exit0或没有报错单独充当GUI通过。

未运行全量回归、发布验证、安装包、重启/崩溃恢复、客户机器、跨屏/DPI和macOS专项。不会因本批修改共用session就自行升级到全量。

## 6. 恢复边界

原NoteList及旧GUI脚本在`tmp/refactor-baselines/B6a-2026-10-09-list/files/`；Timeline接受点`NoteList-timeline-accepted.vue`、Custom接受点`NoteList-custom-accepted.vue`，各脚本/报告在同目录。若经明确授权决定撤回，应恢复对应model+adapter+纯merge+匹配源码读取保护；不能只删模型留下新根接线，不回滚别的批次或覆盖真实用户DB/附件。当前没有主动执行回滚。
