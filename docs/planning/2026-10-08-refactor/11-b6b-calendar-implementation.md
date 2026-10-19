# B6b 日历工作区实施现状与剩余指导

更新日期：2026-10-09。用户已明确恢复代码实施授权。本批月/周/天气/循环预览状态迁移已完成并冻结；五个精确unit文件28项通过，局部lint零错误/警告；最终共享构建后的真实日历窄专项41/41实际断言通过且accepted。通过范围与未覆盖项如下，不扩展为全项目或发布验证；不运行全量、安装或发布。

## 1. 当前已有改动与实际验证

| 范围 | 代码状态 | 实际结果 | 未完成 |
| --- | --- | --- | --- |
| Q-004 同文档组件失效 | 已做最小disposed、query/weather sequence、settings await后订阅前及calendar await后ready门槛；卸载清周pending | 实际SFC setup两项先红后绿；真实Electron生产clear/remount的慢calendar/慢settings场景通过 | 动画中卸载等尚未选入窄专项的组合 |
| 月查询/导航 | 已移入`useCalendarWorkspaceModel`，保留月转场拒绝新目标 | 4个模型行为用例及真实month忙期拒绝第二目标、返回今天场景通过 | 日期边界/选中日期夹紧仍主要由unit覆盖 |
| 周查询/导航/刷新 | 已移入同一模型，保留最新pending周目标、同周focus、累积下一周意图、卸载不继续pending；删除临时migrationState端口 | 4个周行为用例及真实week连续next只查询首/末pending、共享preview场景通过 | 同周focus/其他refresh竞争组合仍主要由unit覆盖 |
| 日历快照与便签变更 | period/data/generation/loading/error/selection为模型唯一拥有者；root使用readonly状态、selection显式computed setter及patch/add/remove命令 | 模型用例及真实磁盘便签创建/显示、clear后慢calendar结果隔离通过 | 特定编辑/状态动作尚未逐项验证 |
| 天气/recurring preview辅助 | 已由`useCalendarWorkspacePreferences`唯一拥有refs、generation、error/finally、保存及回填；clock仍根调用一次后注入 | 11辅助unit、实际SFC及真实窗口模拟weather IPC不阻塞本地数据、旧结果隔离、preview保存/查询选项通过 | 真实外网供应商、客户机器及长期运行 |
| 最终局部ESLint | 清理9个unused导入及1个空行warning；根/两个模型/四test/新MJS逐文件执行`--no-cache --max-warnings 0` | **退出0：零error、零warning** | 不代表全项目lint |
| GUI/build | 当前日历迁移及最后anchor修复已进入冻结共享构建 | build-current-inputs/provenance verified且accepted；calendar 41/41、exit0、业务/证据/清理完整且accepted | 不代表全项目、原生输入、发布或客户环境验收 |

当前`preferences-unit.json`为28用例通过：`calendar-workspace-model.test.js`8、`calendar-workspace-lifecycle.test.js`3、`calendar-workspace-preferences.test.js`11、`calendar-recurring-preview-ui.test.js`3、`weather-ipc.test.js`3。阶段`week-unit.json`为此前10用例，`month-unit.json`是月阶段6用例，`q004-after.json`是最小修复2用例。上述unit和旧阶段结果按各自范围保留；最终真实日历41/41证据单列1.2节，不能累加或外推全部日历UI行为。

当前MonthWorkspace源码SHA256为`95020A0426A16FF38DB65F95B256AC45AF817B71C0E5C46EE78DFD2AB64A6731`；与生命周期接受副本统一换行后template到文件末尾字符相同。新`calendar-workspace-electron.mjs`已完成syntax check、局部lint及最终冻结共享构建后的真实GUI窄专项。

### 1.1 阶段 lint 失败的实际执行记录（已在恢复授权后修复）

2026-10-09 以只读方式重新执行下列命令，未使用`--fix`或缓存。退出码为 **1**；输出明确为 **9 errors、0 warnings**，不是静态推断，也不是运行环境启动失败。此前 lint 未保存独立JSON；本节保存本次复核的命令、退出码及错误定位，不把不存在的证据文件写入表格。

```powershell
& 'C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' 'node_modules\eslint\bin\eslint.js' --no-cache 'src/renderer/src/components/month/MonthWorkspace.vue' 'src/renderer/src/composables/useCalendarWorkspaceModel.js' 'tests/calendar-workspace-model.test.js' 'tests/calendar-workspace-lifecycle.test.js'
```

全部错误均来自`src/renderer/src/components/month/MonthWorkspace.vue`的`no-unused-vars`，定位如下；模型及两测试文件没有报错：

| 行 | 未使用导入 |
| --- | --- |
| 24 | MAX_CALENDAR_DATE |
| 25 | MAX_CALENDAR_YEAR |
| 26 | MIN_CALENDAR_DATE |
| 27 | MIN_CALENDAR_YEAR |
| 28 | addCalendarDays |
| 29 | buildWeekGrid |
| 30 | dateKeyFromParts |
| 31 | dateOrdinal |
| 32 | parseDateKey |

上面的复核发生在停止代码写入阶段，当时没有修改代码、构建应用或运行GUI。恢复授权后清理这9个导入，并在8个本批文件上重新执行`--no-cache --max-warnings 0`，最终退出0；历史失败不覆盖，不再当作当前未修错误。

### 1.2 最终共享构建与真实日历窄专项

| 项目 | 当前证据 | 实际结果及边界 |
| --- | --- | --- |
| 共享app构建 | `tmp/test-runs/2026-10-09T03-28-40-290Z-oElUD0/build-app-qxZs1f`；proof `tmp/test-build-proofs/build-app/0001791516584978/proof.json` | build-current-inputs passed、provenance verified、输入/工具链closure匹配、runner accepted=true；ABI仅declared-only，编译不证明native业务 |
| 日历真实专项 | `tmp/test-runs/2026-10-09T03-28-40-290Z-oElUD0/tests_calendar-workspace-electron.mjs-wYhjtp/result.json` | 41/41实际assert，exit0，business passed、evidence complete、script+runner cleanup complete，accepted=true |
| 业务证据 | 同目录`calendar-workspace-evidence.json`与`calendar-workspace-final.png` | 真实窗口/preload/磁盘DB；同文档生产clear；慢响应与weather在IPC边界模拟；无原生指针输入或main重启 |

已执行范围：真实month数据与磁盘便签，月忙期拒绝第二导航目标，共享preview保存与calendar请求选项，生产`__clearEditingDrafts`导致的同文档key重建及旧慢calendar/慢settings隔离，模拟weather不阻塞本地日历且不恢复旧实例状态，独立month→week整页切换，week三次next只查询首个与最后pending。日期夹紧、同周focus及其他编辑动作不能由这41项外推为已做全部GUI覆盖。

首次共享构建运行 `tmp/test-runs/2026-10-09T03-17-06-973Z-lpK69s/tests_calendar-workspace-electron.mjs-esrjdC/result.json`继续保留：exit1、accepted=false，SettingsRuntime构造期读取尚未初始化的mainViewNavigation触发TDZ；当时只有1次前置assert调用，不是日历业务通过，也不是沙箱/缓存环境失败。主进程依赖改为不可变初始view seed及惰性端口后重新共享构建，本轮41/41通过；不覆盖首次失败记录。本轮源未再修改，旧Tag阶段out不足以验收的提示已被本次对应构建与结果取代。

## 2. Q-004成立范围与最小修复依据

测试从真实MonthWorkspace.vue编译setup，通过Vue host renderer在同一文档中挂载旧实例→卸载→挂载新实例，隔离child UI/时钟/focus，保留实际组件hook、API await、订阅、ready与内部状态。此方式是实际组件生命周期行为测试，**不是原生Electron窗口测试**。

修改前 `tmp/refactor-baselines/B6b-2026-10-09-calendar/q004-before.json`两项失败：

1. 慢calendar查询在旧实例卸载后完成，旧实例内部快照仍写入id999。
2. 慢settings请求在旧实例卸载后完成，旧实例注册5个监听并继续查询。

Vue自身已经屏蔽卸载实例emit的父接收，因此没有证明父收到旧ready，也没有证明客户机器出现用户可见错误。当前修复用disposed及sequence取消旧结果，并在异步mounted恢复设置后、注册监听前、calendar结果后检查实例归属；卸载失效calendar/weather序号并清pending week selection。`q004-after.json`同两项用例通过。继续迁移后同两项测试仍通过。

新增期望或扩大故障结论必须另外复现，不能从“无disposed”的源码片段直接升级成生产泄漏/客户根因。

## 3. 已移交边界与应保持的不同策略

`useCalendarWorkspaceModel.js`现在拥有月份/周锚点、calendarData、loading/refreshing/transitioning/error、selectedKey、单一loadSequence/disposed、月查询/导航、周查询/导航及pending target、refresh、goToday/previous/next/jump、calendar便签patch/add/remove。

MonthWorkspace保留DOM/grid/modal/creator/editor/resize/focus、实际动画、订阅与broadcast合并；辅助天气/preview状态已移入`useCalendarWorkspacePreferences`。display端口为replacePeriod/refreshPeriod/focusDate；查询选项由辅助模型requestOptions提供。动画await后的当前token判断与commit通过显式命令连接。

- 月导航归一化月份并限制1900–2100，选中31号向目标月迁移时按当月天数夹紧；转场中的新月目标被拒绝，没有新增排队策略。
- 周导航已有转场中只保留最新pending，当前周focus不再查询；previous/next从pending/active/selected/anchor的既有优先级推导目标。后台/手动refresh后按原规则继续pending。卸载不继续旧pending。
- 月周数据与日期/event layout/recurrence纯规则没有重写。模型始终调用原calendar IPC和preview选项，不能移动后改变时间单位/历史跳过/布局规则。
- 原模板和CSS没有迁移或重设计。与恢复副本比较，统一CRLF/LF后从`<template>`到文件末尾字符完全一致。后续UI/CSS改动仍必须完整阅读UI_DESIGN_STANDARD。

## 4. 已完成的收尾与保持规则

1. 已仅删除MonthWorkspace的9个unused calendar-date-rules导入：MAX_CALENDAR_DATE、MAX_CALENDAR_YEAR、MIN_CALENDAR_DATE、MIN_CALENDAR_YEAR、addCalendarDays、buildWeekGrid、dateKeyFromParts、dateOrdinal、parseDateKey。模型实际使用的导入保留。
2. 已运行五个精确文件28用例及根/模型/test/MJS局部ESLint `--no-cache --max-warnings 0`；当前单位测试和局部lint均通过，9项旧错误为真实代码问题且已清理。
3. 核对readonly data消费端：根不再直接改calendarData；selection setter只调用selectDate；修改/删除/快速创建都用模型窄命令。若真实UI证明旧业务await会在卸载后开新timer/modal，先加具体复现，再做该拥有者的最小gate。
4. 不把模型的月拒绝/周pending策略合并，也不因旧finally释放它自己的状态就机械加一套新队列。若发现当前generation与transition finally确有可观察竞争，应先deferred回放证明，再局部修复。

## 5. 天气与recurring preview已完成的唯一拥有者

新增`useCalendarWorkspacePreferences.js`拥有recurringPreviewEnabled/Saving、requestOptions、updateRecurringPreviewEnabled、weatherEnabled/Forecast/Loading/Error、独立weather sequence、weatherState/weatherByDate与loadWeather。根不再深层写辅助状态；mounted调用applyInitialSettings，settings监听调用applySettings并根据previewChanged协调queueNotesRefresh，forecast监听调用acceptForecast，卸载调用dispose。

已实施规则及后续维护要求：

1. **唯一状态。** weather/preview refs和独立weather generation已整体移交，readonly提供显示字段；根不能再另造可写副本。clock仅在根调用useSharedMinuteClock一次并注入辅助模型，没有新增时钟timer。
2. **请求与过期。** loadWeather开始→加载/错误状态→API返回→序号/实例归属检查→forecast/error→finally整体移交；onSettings disable及onWeatherForecastUpdated都失效旧天气请求。不能只移动API函数保留另一处自增token。
3. **非阻塞ready。** 设置恢复后启动天气后台请求；ready只依赖本地日历数据，不能等待网络气象。freshness使用Math.max(shared minute tick, Date.now())，刚收到的数据立即按实际接收时间评估。
4. **明确端口。** 已建立applyInitialSettings、applySettings、acceptForecast；根订阅仍协调queueNotesRefresh并通过命令提交，辅助模型没有自行安装订阅，subscription owner不重复。
5. **preview写入规则。** 保存一次共享`calendar.recurringPreviewEnabled`；query options每条month/week/load/navigation/refresh入口读取当前唯一值；保留saving gate及保存失败回填/提示/refresh。previewRevision区分本次乐观值与后续settings广播，旧失败不回填覆盖新广播。成功持久化后的refresh异常只报同步失败，不反转成功保存的值；卸载后的保存/天气结果不通知、不刷新旧实例。
6. **记录源码保护迁移。** `tests/calendar-recurring-preview-ui.test.js`的业务请求/设置断言应读取实际owner，toolbar/template保护继续原文件；若迁移涉及其他source-read测试，先确认它们到底保护业务契约还是实现文本，再把owner登记同步到manifest。

上述代码已落盘并由11个辅助行为用例及实际SFC天气ready/卸载用例验证。关闭天气会即时清loading并失效旧结果；这是从真实旧状态清理缺口得出的窄修复。真实外网天气供应商、客户机器及长期运行仍未验证，不能从模拟IPC气象推导这些结论。

## 6. 已执行的窄专项与后续精确验证规则

### 模型/组件局部文件

基础：`calendar-workspace-model.test.js`、`calendar-workspace-lifecycle.test.js`。直接受preview owner变更影响时加入`calendar-recurring-preview-ui.test.js`；实际触碰导航/日期/event纯规则时才加入`calendar-grid-navigation.test.js`、`calendar-date-rules.test.js`、`calendar-event-layout.test.js`或`calendar-service.test.js`的对应文件，不能仅因为这次涉及calendar就把所有纯规则全跑。

天气新增有意义用例：旧请求晚于新request/broadcast/disable、quiet与非quiet失败提示、加载finally不能释放新请求、初始settings迟到/unmount、即刻freshness、weather不阻塞ready。preview新增有意义用例：初始化/broadcast不重复保存、成功后每query option有效、保存失败回填、保存期间卸载/新实例、不丢新意图。先构造能够观察到错误结果的行为断言，避免按源码行数生成测试。

### 真Electron专项和新增最小场景

已建立窄的`tests/calendar-workspace-electron.mjs`，mode为`electron-ready-real-app-calendar-workspace`，带actual assertion recorder、证据JSON/截图及正常quit/script+runner cleanup。它使用真实生产窗口、IPC和磁盘DB，本轮已在统一共享构建后执行并accepted。以下为后续扩展候选，不能全部标为本轮已经执行：

- 月导航边界/选中日期夹紧/转场拒绝新目标，周latest pending/同周focus/refresh期间连续next。
- 原calendar IPC和磁盘DB的实际查询快照与preview选择，局部卡片patch与add/delete最终显示。
- 生产`__clearEditingDrafts`导致MonthWorkspace同文档key重建：记录document timeOrigin相同、旧节点脱离、新节点身份；分别延迟calendar请求与settings请求，在旧结果释放后验证新实例数据、query数量、ready及无迟到订阅。整页switchMainView导航不能冒充同文档remount。
- month→week整页切换单独检查，与clear/remount分开记录。
- 气象可在真实IPC边界提供确定响应/故障并记录它属于模拟网络结果，不能推导外网供应商或客户机器通过。

本次窄MJS具体包括：真实month查询及磁盘便签、month忙期按钮拒绝第二目标、共享preview保存与请求选项、生产clear的慢calendar/慢settings两次key重建、模拟weather IPC不阻塞本地可见数据、独立month→week页面切换及week三次next只查询首个与最后pending。日期夹紧和同周focus等仍由精确unit覆盖；不声称新MJS已逐条涵盖上面的扩展候选。文件、mode、app build需求及source-read owner已交主代理登记。

### 共享构建条件

1. 完成并审阅上述代码/测试小步骤后，冻结month/list模型、根接线、main/preload共享源；协调一个build拥有者，其他代理暂停改源和写out。
2. 第一条命令就用仓库指定Node并去Volta PATH。真实Electron在适合桌面/缓存/GPU的沙箱外环境执行，不能先制造预期启动失败。
3. 记录构建前后完整认可的输入/输出和工具链证据；未建立完整closure则据实记非认证人工build，禁止声称strict reuse。本轮build-app-qxZs1f已建立verified proof并accepted，当前对应out已用于本批日历及最后anchor修复验收；以后源/工具链变化须重新核对来源。
4. GUI串行共享桌面/out。本轮最后anchor修复的Timeline 66/66、Custom 17/17及日历41/41必要专项均已完成并accepted；后续只跑实际变动直接相关的明确专项，不能自动全量。
5. accepted必须同时满足实际业务断言、业务completed、证据可读、脚本和runner cleanup、有效退出码。缓存/Volta/GPU启动失败只算环境阻塞。失败保存attempt，不以重跑覆盖原证据。

## 7. 恢复方案与未覆盖风险

原件与SHA在`tmp/refactor-baselines/B6b-2026-10-09-calendar/files/`；最小生命周期接受点`MonthWorkspace-lifecycle-accepted.vue`，月接受点`MonthWorkspace-month-accepted.vue`。同目录保留每步转换脚本和结果；这些脚本并非幂等，不能再次盲跑当作恢复。

若经明确授权撤回：恢复匹配的根adapter/model/测试owner与订阅/generation/ready保护为一组，保留Q-004复现证据；决定是否保留成立修复应单独审阅。不能单删模型、把schema/真实资料随便恢复，或覆盖其他代理/原有dirty工作。当前没有执行回滚。

本批最终共享app build及真实calendar窄GUI已经完成并accepted；仍未运行全量回归、发布/安装、客户机器、跨屏/DPI、真实网络天气、macOS、长期运行及崩溃重启。28个精确unit与41次真实专项assert各自支持其列明的行为范围，不能外推未选择的编辑/动画/平台组合或全项目验收。
