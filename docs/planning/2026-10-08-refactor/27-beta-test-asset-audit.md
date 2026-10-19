# BR-02 内测测试资产静态审查（第一批）

日期：2026-10-10。状态：**第一批 62 项完成静态审查；其余 128 项交由后续分批，BR-02 尚未完成。** 七个 release-quality DB 专项由独立批次负责，不纳入本批。随后授权窄修 A-00，已完成该单项 7/7 局部验证，详见 §6；不能将这一个结果推广到其它61项。

第一批静态审查阶段没有运行测试，没有修改生产/测试代码或 manifest/CI，也没有删除测试。之后仅窄修 `recent-local-day-range.test.js` 并执行它及指定格式/lint，其余运行状态不变。本文的“已审”只表示已阅读该测试的完整断言及被测模块/直接消费位置，不表示行为通过。SFC 阅读范围是断言对应的 script/template/style 段落；纯 JS 小模块阅读全文；包装测试同时阅读生产脚本。新增诊断、毛玻璃和其它原有验收仍以各自 attempt 记录为准。

入场资产快照见 `tmp/beta-readiness/audit/registry-start.json`，由 `createTestRegistry()` 只读生成。当时 test 274 项，`reviewed-protection` 77、`unreviewed` 197。本文审查清单、未审清单和清单生成时测试文件 SHA256 见同目录 `static-review-first-batch.json`；这是源码身份统计，不是不可变运行 attempt。登记数量不是失败数量；本批不把未审状态直接改为已运行或已通过。

## 1. 内测优先结论与具体改法

### A-00：本地日边界测试仍定位重构前的函数

已静态确认 `tests/recent-local-day-range.test.js:30–31` 读取 NoteList.vue 并用正则提取 `threeDayCutoff`。当前函数已迁到 `src/renderer/src/composables/useTimelineListModel.js:7`；NoteList 中不再存在该函数，因此 `match(...)[1]` 会对 null 取下标。这是测试定位错误，不能解释为本地日/DST业务失败；本批未执行，不能填运行失败数。

改法：读取/执行当前 timeline owner 中实际 cutoff，保留七组固定时区、本地日期和 23/25/71/73 小时预期。新函数位于嵌套作用域且带缩进，不能只替换路径并沿用 `\n\}` 结尾正则。优先用 AST 定位该函数，或执行 composable 捕获其实际 `queryRecentNotes/queryEarlierNotes.cutoffTime`。同步 source-read/domain/CI 映射。指定局部验证为该测试与因登记修改影响的 selection/manifest/CI tests；不全量。不要删掉跨DST边界保护来获得通过。

### A-01：补源码读取依赖，保证局部选测能发现真实消费者

这是已确认的**测试元数据遗漏**，不是测试运行失败。`scripts/test-selection.cjs` 从登记依赖构建 source/source-read 关系，不能自动猜出 `readFileSync`、运行时 SFC 提取及 `createRequire` 的全部实际读取。下面项目需要按测试实际读取补登记；不扩大成全库测试。

| 测试                                        | 已读源码与登记的差异                                                                                                                               | 修改步骤与局部验证                                                                                                                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/tag-color-setting.test.js`           | 登记只含 index、NoteList、SettingsPanel，实际还读 App、MonthApp、useWorkspaceRuntime、NoteCard、SearchResultCard、MonthEventBar、MonthCalendarGrid | 向 `sourceReadDefinitions['tag-color-setting']` 补实际文件；若变更职责后迁至其它 owner，同步测试读取位置。用 manifest/selection/CI 选择规则测试分别断言每个实际消费者能找到这个测试。 |
| `tests/quick-note-edit.test.js`             | 实际读取 `useWorkspaceRuntime.js` 未登记                                                                                                           | 补 source-read；对该文件的选择计划确认本测试进入候选，不通过 unrelated dirty 扩大范围。                                                                                               |
| `tests/view-visibility-shortcut-ui.test.js` | `rendererHandler` 实际读取 HelpPage、ActionBar、SearchBox，登记遗漏这三项                                                                          | 补 source-read；行为提取有实际 Ctrl/Win/IME/inert 断言，应保留而非退回纯字符串检查。                                                                                                  |
| `tests/titlebar-icon-scale-ui.test.js`      | 实际读取 13 种图标的黑/白 SVG 共 26 个资源，未登记这些读取                                                                                         | 将同一图标名称列表用于明确登记或目录扩展；新增文件也应触发审查。测试标题称“14 icon types”而 names 实际 13，此文案修正不作为业务失败。                                                 |
| `tests/security-hardening.test.js`          | 实际读取 package.json、electron-builder.yml、generate-app-icons.py，登记遗漏；另对三个已删除 Mac 文件执行 existsSync                               | 补存在文件 source-read，并用适合已删除路径的规则保护“重新引入”变化。不能把 Mac 拒绝用例删成空保护。源码匹配仍仅是配置边界，包内/安装另验。                                            |
| `tests/package-native-config.test.js`       | createRequire 引入 configure-packaged-native、package-native-plan、validate-packaged-app 三个脚本，直接 imports 自动收集未覆盖它们                 | 补 `extraSourceDependencies` 或明确 source-read；保留真实 ASAR、实际 builder matcher 与破包负例；ABI fixture 的 mock 不证明真实 DLL 可装载。                                          |

以上缺失不必然导致当前计划完全无测试：其它明确 domain rules 可选择其它保护；但不能借此认为这个测试的读取关系已经完整。修改后须以具体文件的只读 plan 和选择器行为断言确认，不能仅统计字段数。

### A-02：明确性能基准与发布证据的边界

`tests/logging-overhead-electron.mjs` 有 500 行合成窗口、三模式轮换、CPU/回调分位与丢日志检查，**没有开销预算阈值**，也未安装真实标题栏/贴边运动 collector。因此它可以生成同机比较数据，不能证明新增运动诊断实际开销已经验收。

改法：按 BR-03 真实应用主链复用已有运动专项，同机同场景比较日常/深度的日志量、主/renderer CPU、耗时与采样缺失。为单人正常操作定义明确观测窗口和可判断预算；阈值必须有实测依据，不能先编一个数制造通过。原合成基准保留为 explicit/performance，不能每个小改动自动执行，也不能把弱机/长期测试伪模拟销账。

### A-03：遗留 runtime 结果与清理不能只依赖 exit0/打印 PASS

本批读过以下 legacy 的业务断言均有明确价值，但它们没有统一 recorder completion/cleanup 证据：capture-host、capture-lifecycle、capture-package-smoke、logging-worker-asar、logging-overhead、maturity-db，以及四个 sandbox 专项。是否被 focused 阻断以入口的 adapter 判断为准，不把本文阅读认作适配。

优先级：先处理内测候选实际要跑的包装/ASAR/沙箱路径。实现时沿已审 recorder 模式记录 suite、attempt token、mode、断言完成、业务完成、profile 所有权、cleanup；错误也写本次 attempt。不得把 stdout 中一个 PASS 字符串当整个脚本完成。

- `capture-package-smoke.cjs` 正常路径显式检查 app/helper 退出；失败 finally 仅关闭 socket/kill child，没有证明 helper 与 app 完全退出。补 owned process 等待和结果，进程操作只针对本测试创建的进程；不要动用户实例。默认包路径是旧日期临时目录，应改成明确必填候选包输入或由入口注入，禁止旧包混成当前候选。
- `logging-worker-asar-electron.mjs` 的真实 Worker 读写保护保留；给 Worker timeout/error/成功都补统一 finally 和本次产物证据。当前临时 ASAR 包只取 out/main，不等于最终安装包完整验收。
- `sandbox-diagnostics-win.cjs` 在 PS7 未安装时明确 SKIP 条件；需要把这个条件保留为未覆盖，不能把“六处 Inspect 成功”冒称已验证 PS7 父进程路径。三个 PowerShell 专项分别保护 ACL、真实 Electron sandbox 和编译生产 NSIS hook，不能因都打印 PASS 而合并删掉。
- `maturity-db.mjs` 真实内存 SQLite 验证恢复状态/tag/附件元数据，并生成 1k～50k 查询计量；没有查询延迟预算、没有真实附件文件读写。恢复保护与大数据基准可拆分调度，50k 数据量不是每次内测小修的默认门槛。

### A-04：源码字符串测试按保护类型处置，不能全删

本批源码/配置读取或提取测试中，有实际 API/AST 执行、设计标准约束、配置资产边界，也有纯拼写保护。有效职责不同。

- 安全/包边界：保留 CSP、目标平台、原生白名单、read-only ACL 等真实边界；用实际产物验收补证据。
- 产品设计约束：保留必要的标准/语义令牌/层级守卫；运行层验证布局、焦点、点击和动画，不能把精确像素/中文拼写当完整交互保护。
- 纯业务接线：优先由现有行为/DB/Electron 保护覆盖，再将具体字符串部分改写或等价替代后删除。替代前必须把覆盖矩阵写出来；本批不判定整文件“无用”。

例如 `month-event-bar.test.js` 第一条的名称称“完成态始终灰色”，实际仅检查 getCalendarNoteAccent 调用、tagColorEnabled 和 `color: #fff` 拼写；真正的状态颜色 oracle 在 `note-appearance.test.js`。应保留后者，前者改成“横条接入共享颜色规则”或组件渲染保护；不能以第一条通过单独宣称完成态颜色正确。

### A-05：发现一处 Windows-only 死分支，需要独立收口

`src/main/window-motion/index.js` 仍包含 ElectronPointMotionBackend 与非 win32 fallback；`dock-edge.js` 注释也明确其用于非 Windows。产品启动 gate 已限制 Windows，不能据此声称 Mac 能实际运行，但该旧分支不符合当前代码清理目标。

处理：先确认所有 createWindowMotionBackend 消费者与现有 Windows motion 专项，删除不可达备用实现并在工厂明确拒绝不支持平台；同步处置仅保护备用 DIP edge 算法的 `dock-edge.test.js`。不能删除 WindowsPhysicalMotionBackend 的判断、原生边缘监视器、50ms barrier 或运动算法，也不要以这个整理顺便修卡顿。是否保留纯算法作为 Windows fixture 需给出真实消费者，不能仅为保住测试保留生产死代码。

## 2. 第一批逐项审查

“保留”表示静态认可保护价值；“改写候选”表示先保留现有保护，在对应实施批建立独立替代后调整；“适配”表示还缺当前 attempt/completion/cleanup 结果，不代表业务失败。“高/中/低”是内测价值，不是运行结果或缺陷级别。

### 2.1 源码、设计、配置接线

| 文件                                      | 真实保护与预期来源                                               | 阅读消费者/模拟边界                                                                            | 处置与内测价值                                                                |
| ----------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| tests/action-bar-accessibility.test.js    | 聚焦 hint 在 aria-hidden 前移至按钮，顺序来自无障碍约束          | ActionBar openExpanded/aria/tabindex；纯文本，不执行 DOM 焦点                                  | 保留守卫，后续焦点 GUI 补强；中                                               |
| tests/app-update-wiring.test.js           | 升/降/同版本确认、checkId+version+relation、Markdown 无 v-html   | UpdateDialog、preload、register-app-ipc 实际 request→getExternalUrl                            | 保留接线，真实确认/失败依赖 app-update 行为；高                               |
| tests/clipboard-and-selection.test.js     | 受限 clipboard IPC、页面选字、控件不可选                         | business IPC clipboard.writeText/preload、三个调用面、tokens/StyledSelect                      | 仅接线/样式，不等于真实剪贴板/选择；保留候选改写；中                          |
| tests/editing-draft-session.test.js       | 同启动会话保留，跨启动草稿清理                                   | index randomUUID/additionalArguments、preload、useDraftProtection 全文                         | 与产品“新启动不恢复草稿”一致；仅文本；保留；高                                |
| tests/help-navigation-ui.test.js          | 帮助关闭接线、每视图滚动记忆、回顶                               | App/MonthApp 模板、HelpPage scroll/restore/unmount                                             | 像素/标签拼写脆弱，不证实滚动效果；保留候选改写；低                           |
| tests/help-support-ui.test.js             | 项目支持链接/二维码位置与安全 rel                                | HelpPage 首页支持块、profile 绑定                                                              | 文案/模板 contract，非网络连通；保留候选精简；低                              |
| tests/historical-note-backfill-ui.test.js | 过去补录不提醒、进行中限制、主进程派生状态                       | 新建/编辑校验段、note-commands 保存段及 scheduling rules                                       | 关键行为由 rules/DB 保护；文本补接线；保留；高                                |
| tests/image-only-note.test.js             | 纯图允许新建/编辑、图片主轮播/预览链路                           | creators/editor/count、note-commands 总附件数、NoteCard/Picker/Preview、IPC                    | 文本不证实资源提交、图像呈现；保留候选改写；高                                |
| tests/month-calendar-context-menu.test.js | 日期/便签/输入框区分、菜单操作路由与只读                         | Grid handlers/template、EventBar emit、Workspace CRUD routes、标准文本                         | UI wiring 源码断言，需真实右键/CRUD专项；保留；中                             |
| tests/month-event-bar.test.js             | 共享 accent/color 源码接线、正文不拼完成文字                     | EventBar computed/template/style、noteAppearance 全文                                          | 第一条标题强于断言，改为接线或行为；中                                        |
| tests/native-edge-monitor-source.test.js  | Appearing/Ready可点击、cursor unavailable不发 reveal             | edge monitor HandleWndProc/Animation/Worker 相应段                                             | 源码不证明原生时间序列；保留与 native 专项互补；中                            |
| tests/note-duration-mode.test.js          | 三种期限默认/表单提交、旧移动 API 不再接线                       | DurationField、creators/editor、toolbar/preload/index/schema相关段                             | 不证实 DB 行为；保留，negative main substring 迁移可能变弱；中                |
| tests/note-list-motion.test.js            | 折叠 shell 无 padding、箭头/header设计规则                       | NoteList 标签组 template/style                                                                 | 第一载入/反向/慢查交互在 animation Electron；保留结构守卫；中                 |
| tests/note-remark.test.js                 | schema/DTO/IPC expectedContent+Remark、双字段UI/字号             | DB/schema、business handler、preload、card/editor/tokens/settings相关段                        | 不直接证明SQL迁移/并发冲突；配 DB 与 quick GUI；保留；高                      |
| tests/note-text-color.test.js             | schema/DB/IPC/编辑器/搜索/日历颜色接线                           | 各被读文件相应颜色段                                                                           | 写读持久化及offset变更需rules/DB/Electron；保留候选改写；中                   |
| tests/package-native-config.test.js       | 独立临时 ASAR、真实 builder matcher、白名单/泄漏/缺库/ABI拒绝    | package-native-plan/configure/validate 全文、base config                                       | native fixture是假二进制+mock ABI，不能证明DLL装载；保留+补metadata；高       |
| tests/quick-note-edit.test.js             | 快速编辑 blur/esc/成功接线、两视图共享开关                       | editor commit/cancel/watch、card/eventbar、runtime provider                                    | 文本不能证明失败不关闭、IME/重复blur；有对应GUI；保留+补metadata；高          |
| tests/recent-local-day-range.test.js      | 独立时区进程的本地日DST 23/25小时 oracle、提取生产函数执行的设计 | 已读SearchBox selectedTimeRange、NoteList、实际迁移后的useTimelineListModel cutoff；旧定位为空 | **测试定位错误已静态确认，优先修当前owner与metadata，保留独立固定oracle**；高 |
| tests/security-hardening.test.js          | CSP、Win x64、Mac资源删除、APP_ID/升级GUID、权限、包排除         | 五HTML、builder/workflow/pkg/icon generator、index权限段                                       | 配置边界有价值；不等于打包运行安全证明；保留+补metadata；高                   |
| tests/settings-panel-density.test.js      | 约定设置文案/密度、图片比例、截图隐藏开关                        | SettingsPanel/WeatherSettings/ImagePicker相关模板样式                                          | 纯源码与固定文案，不能证实截屏隐藏/持久化；改写候选；低                       |
| tests/sticky-entry.test.js                | 开发资源可达、工具栏顺序、圆角/布局、纯文本双击保存接线          | sticky HTML/CSS/JS相应段，文件存在                                                             | 不证明冲突/保存失败路径；保留与 sticky-persistence配合；中                    |
| tests/tag-color-setting.test.js           | provider快照/共享消费者/allowlist及持久化接线                    | 真实被读8+文件/provider相关段                                                                  | allowlist slice无标记校验脆弱；metadata遗漏；保留后改写；中                   |
| tests/tag-selector-ui.test.js             | 单选替换而非超限、多选提示的源码结构                             | TagSelector toggleTag全文及props/emit                                                          | 未调用toggle，substring顺序不足于完整行为；改写为执行/GUI；中                 |
| tests/titlebar-icon-scale-ui.test.js      | 一致图标设置/Apple与Microsoft盒尺寸/26个SVG规范                  | 相关组件template/style、icons SVG                                                              | 几何效果由Electron补；名称14实13；保留+补metadata；中                         |
| tests/ui-interaction-standard.test.js     | 标准中的按钮/日期面板/quick create/presence/report接线           | standards、tokens、组件对应template/style/handler段                                            | 大文件多feature但非行为；后续按owner分组选择，不能全删；中                    |
| tests/ui-scale.test.js                    | stored合法值/损坏回退、同快照不同尺寸单位                        | settings-schema scale规则与applySettingsSnapshot                                               | 真执行CSS fake setProperty，固定期望独立；非OS DPI；保留；中                  |
| tests/ui-z-index.test.js                  | 令牌层级/clone低于popover/全renderer裸数字禁止                   | tokens、presence zIndex、扫描规则全文                                                          | policy lint；全树输入范围已登记；不证明实际stacking；保留；中                 |
| tests/view-visibility-shortcut-ui.test.js | SFC函数实际执行Ctrl/Win/IME/inert、main退出/导航/capture保护     | HelpPage/ActionBar/SearchBox提取函数、main handler及settings/preload                           | 有效行为+部分字符串；新Function局部依赖未证完整渲染；保留+metadata；高        |
| tests/capture-build-selection.test.js     | explicit Qt test/input-driver、拒绝扩大/重复/旧结果              | build.ps1参数前置、CMake选项、run-qt-test                                                      | 实际PS错误入口，但未构建Qt业务；保留；高                                      |
| tests/windows-sandbox-permissions.test.js | literal路径/no-shell/read-only/失败传播、NSIS hook顺序           | inspector/installer helper全文、config和安装模板                                               | 执行端mock，版本敏感node_modules模板；保留；高                                |

### 2.2 执行真实规则/模块的 unit

| 文件                                   | 独立预期与正常可达保护                                        | 模拟与阅读范围                                         | 处置与内测价值                                                                |
| -------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| tests/ipc-authorization.test.js        | 当前webContents允许、外来sender在业务前拒绝、只读旧sender取消 | authorization全文及各registrar消费位置；fake窗口       | 保留；高。可后补destroyed/current-window变化，不需IPC洪泛                     |
| tests/ipc-arguments.test.js            | 私密正文去掉、不解码大base64、序列化有界                      | captureIpcArguments全文与ipc-main异常日志调用          | 三例实际执行，未穷举accessor/cycle；保留；高                                  |
| tests/attachment-rules.test.js         | base64已知编码字节数、真实批量/count上限                      | rules全文及note-commands/business消费者                | 总量用trustDeclaredSize fake，不证IPC真payload/图像decode；保留；高           |
| tests/note-scheduling-rules.test.js    | 2min边界/历史补录/近午夜/完成只读等固定时间预期               | rules全文及creators/editor/note-commands调用           | 真实规则，通知发送与SQL另测；保留；高                                         |
| tests/note-appearance.test.js          | 首tag/关闭tag/完成灰色/预览颜色固定值                         | noteAppearance全文及EventBar消费者                     | 无DOM但是真颜色oracle，可替代month-event标题错误部分；保留；中                |
| tests/notification-policy.test.js      | Windows能力桥/0..7 channel组合/无payload原地改写              | policy全文和commands/business调用                      | 产品能力不证明OS toast投递；保留；高                                          |
| tests/dock-edge.test.js                | 外边缘/内接缝/offset/侧任务栏固定拓扑                         | dock-edge全文、motion Electron fallback消费者          | 当前只服务非Win死分支；待清理后“不适用/替代候选”；非双屏实机；低              |
| tests/dock-transition-state.test.js    | hide中show只消费一次、temporaryTop恢复一次                    | state全文、dock-runtime调用                            | 离散状态fake，真实动画/native另测；保留；中                                   |
| tests/deferred-window-restore.test.js  | show返回后合并、执行前eligibility重查                         | deferred全文、index canRestore/restore接线             | 三个命名case都仅切false，不独立证明三个实际原因；保留+后改写原因fixture；高   |
| tests/window-bounds.test.js            | offscreen回移/小workArea/只位置变更/稳定visible保存优先       | bounds全文、presentation/navigation/persistence消费者  | 数学fixture非拔屏；缺显式负原点及NaN案例可按现有专项先查等价保护；保留；高    |
| tests/window-compact-geometry.test.js  | 双击anchor为中心、workArea约束、size归一                      | geometry全文、presentation consumers                   | 固定非零正原点，不证明混合DPI；保留；中                                       |
| tests/window-profiles.test.js          | 三视图scope/renderer/dock edges产品定义                       | profiles全文、navigation消费                           | 映射测试有价值但共享DOCK_EDGES同源，非窗口运行；保留；中                      |
| tests/native-edge-monitor.test.js      | generation独占、失败不记、cleanup超时保留再disarm             | monitor全文、dock-runtime/message consumers            | native ports fake，不证DLL线程；保留；高                                      |
| tests/editing-draft-guard.test.js      | 退出/隐藏/崩溃/导航取消、确认后重查persist blocked            | guard全文与index入口；EventEmitter+executeJS fake      | 单人关闭/切视图可触发；不证dialog交互；保留；高                               |
| tests/calendar-grid-navigation.test.js | 单Tab入口/行首尾/箭头拒绝inactive                             | navigation全文与Grid调用                               | 固定days，真实keydown焦点另验；保留；中                                       |
| tests/calendar-day-preview.test.js     | 四方向viewport约束、反转用当前clip/旧finished不完成新动画     | helper全文与Grid调用；animate/getComputedStyle fake    | 固定几何oracle；不证真实像素/尺寸过大UI；保留；中                             |
| tests/capture-assets.test.js           | owned ID/oversized header拒绝且未decode、只清理owned session  | AssetStore全文/Coordinator使用；真实临时文件+fake解码  | 一项包含正反路径，不证明PNG完整解码，另image-worker；保留；高                 |
| tests/capture-image-worker.test.js     | 真Worker输出、CRC/大尺寸/truncated/filter/像素解压负例        | worker与AssetStore decode全文                          | 使用独立PNG chunk/CRC fixture；尺寸100k代表头损坏，不是要求人截100k；保留；高 |
| tests/capture-recorder-owner.test.js   | 切换录制串行、失败后可再开始                                  | owner全文/ShortcutRecorder调用；三个合法切换+延迟start | 正常单人连续点有可达性；保留；中                                              |
| tests/notification-guard.test.js       | 发送失败不把已完成业务报失败、成功body/title                  | guard全文、NotificationService sendSafe                | send fake、异常回调不抛假设；OS投递另测；保留；中                             |
| tests/tag-rules.test.js                | 保序去重/非法ID/最多1标签                                     | rules全文与commands/templates/tags消费者               | 真规则、没有DB外键/历史数据；保留；中                                         |
| tests/shortcut-status.test.js          | 只报告配置但启用失败项、不报录制/disabled/retired项           | status全文、main启动/面板消费                          | 固定runtime对象，真实globalShortcut另验；保留；中                             |

### 2.3 平台、包装和计量专项

| 文件                                   | 实际保护与阅读范围                                                                                                                        | 未覆盖/结果适配                                                           | 处置与内测价值                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------- |
| tests/capture-package-smoke.cjs        | packaged独立profile/app-localQt、真实inputdriver截图、ASAR worker、草稿、restart保留绑定、app/helper退出；全文+CaptureHost和产品hooks位置 | 缺统一result completion/cleanup、失败清理证明；默认旧packageDir           | 保留并优先适配；高                                |
| tests/sandbox-diagnostics-win.cjs      | 实际包内只读Inspect六关键路径、无DACL backup、PS7 inherited path                                                                          | PS7条件skip；脚本无recorder；读取inspector/helper全文                     | 保留并适配实际候选；高                            |
| tests/sandbox-electron-win.ps1         | 私有复制Electron+ASAR fixture实际renderer/GPU sandbox/page/JS                                                                             | 未运行真实产品；无统一attempt completion，资料留下作证据                  | 保留并适配；高                                    |
| tests/sandbox-installer-win.ps1        | 编译生产customInstall hook；安装/重装中文路径/deny1603未到launch                                                                          | 无真实产品完整NSIS升级/卸载；fixture无registry                            | 保留并适配；高                                    |
| tests/sandbox-permissions-win.ps1      | 真ACL Inspect不写/backup先写/继承/幂等/upgrade/deny/protected/junction/backup失败                                                         | fixture测试，不能证明Chromium有效token访问；helper全文                    | 保留；高。异常来源明确，不属理论无限并发          |
| tests/logging-worker-asar-electron.mjs | 临时ASAR中的真实Worker加载共享chunk并append/readback                                                                                      | 不证最终包完整性；timeouts/error需更强finally/attempt                     | 保留并适配；高                                    |
| tests/logging-overhead-electron.mjs    | 合成真实BrowserWindow同机三模式轮换、前台/丢批合法性与CPU/interval计量                                                                    | 无预算；无实际motion collector；固定输出需本次attempt绑定                 | 保留explicit参考基准，另补实际诊断验收；中        |
| tests/capture-host-electron.mjs        | 真实helper并发start合并/theme/IPC loss/restart/dispose/Job owner死亡；CaptureHost/helper全文                                              | 没BrowserWindow/capture/clipboard/input；finally吞fs.rm错误，缺completion | 保留；高                                          |
| tests/capture-lifecycle-electron.mjs   | 真overlayReady/cancel一次/owned helper crash/recover/IPC loss/Job/graceful；全文+CaptureHost/cover helper                                 | 合成遮屏像素非客户桌面，未断言最终图像；缺completion/cleanup reporter     | 保留；高                                          |
| tests/maturity-db.mjs                  | 真内存SQL恢复状态/tag/附件DTO、大数量calendar正确count/filteredcount、查询时间记录；DB相应SQL段                                           | 附件只有row未写真实file；无延迟预算；50k不作每小修门槛                    | 保留恢复，benchmark按需拆调度；高恢复/低benchmark |

## 3. 修改顺序、停止条件与恢复

1. 先修 A-00 测试定位并补 A-01 元数据与当前 BR-01 迁移读取位置；由主代理成组修改 manifest/domain/CI 与对应断言。局部验证只运行选择基础设施文件，以及真正被改的功能测试；不要顺带把 128 个未审项全跑一遍。
2. 七 DB recorder 专项合入后以 `release-quality --plan` 检查阻断减少，plan 无阻断仍不等于运行通过。其余 runtime 从候选章程实际要跑的项逐个适配。
3. A-04 仅在受影响owner整改时生成行为替代；保留安全/数据保护，不默认新增纯镜像或耗时洪泛测试。
4. A-05 由窗口owner独立评估/实施；本批不修改motion/native行为。
5. 继续按附录未审列表分域读完。每次只销账实际已读文件；未读的不标 reviewed。最后再确认哪些资产纳入候选内测验收，哪些为explicit/参考/客户任务。

停止条件：存在失效定位、含skip却报全通过、业务未完成/清理未闭合、测试使用当前用户资料、旧build/旧package与新源码身份混用时，该专项结果保持 blocked/unproven，不放宽断言制造成功。先确认现实触发入口，不把无法由用户/后台/Windows事件产生的理论交错列内测阻塞。

恢复：静态审查阶段只有本指导和 `tmp/beta-readiness/audit/` 的只读统计。A-00 的窄修另保存了该测试入场副本，见 §6；如需回退，只恢复这一测试与匹配的后续映射，不覆盖其它工作区修改。后续实施另存本批入口和消费者基线，禁止全库reset/clean。

## 4. 本批未运行与未覆盖

静态审查阶段未运行任何 Vitest、Electron、Qt、原生、数据库、安装或全量回归。随后只执行 §6 的单项 Vitest 和该文件 ESLint/Prettier；其它61项没有本批运行结果。没有打包、安装、发布、上传、发送群消息。实际双屏/DPI/睡眠、自然卡顿、弱机长期、候选包安装升级卸载还需后续证据。

## 5. 精确未审清单

以下由入场 registry 减去本批62项及七个独立DB专项生成，不能视为已审/已通过。

<!-- generated pending inventory -->

- `native_capture/tests/clipboard_test.cpp` (native, qt)
- `native_capture/tests/core_test.cpp` (native, qt)
- `native_capture/tests/pin_halo_test.cpp` (native, qt)
- `native_capture/tests/polish_test.cpp` (native, qt)
- `native_capture/tests/selection_test.cpp` (native, qt)
- `native_capture/tests/ui_test.cpp` (native, qt)
- `native_capture/tests/ux_test.cpp` (native, qt)
- `tests/almanac-engine.test.js` (unit, vitest)
- `tests/almanac-requests.test.js` (unit, vitest)
- `tests/almanac-weather-electron.mjs` (gui, electron)
- `tests/app-update.test.js` (unit, vitest)
- `tests/attachment-loading-electron.mjs` (gui, electron)
- `tests/attachment-storage-electron.mjs` (storage, electron)
- `tests/blur-z-order-electron.mjs` (gui, electron)
- `tests/calendar-date-rules.test.js` (unit, vitest)
- `tests/calendar-event-layout.test.js` (unit, vitest)
- `tests/calendar-font-electron.mjs` (gui, electron)
- `tests/calendar-ipc.test.js` (unit, vitest)
- `tests/calendar-metadata.test.js` (unit, vitest)
- `tests/calendar-service.test.js` (unit, vitest)
- `tests/capture-shortcut.test.js` (unit, vitest)
- `tests/ci-test-selection.test.js` (unit, vitest)
- `tests/daily-report-electron.mjs` (gui, electron)
- `tests/daily-report-ipc.test.js` (unit, vitest)
- `tests/daily-report.test.js` (unit, vitest)
- `tests/diagnostic-actions.test.js` (unit, vitest)
- `tests/diagnostic-controller.test.js` (unit, vitest)
- `tests/diagnostic-evidence.test.js` (unit, vitest)
- `tests/diagnostic-ipc.test.js` (unit, vitest)
- `tests/diagnostic-policy.test.js` (unit, vitest)
- `tests/diagnostic-transport.test.js` (unit, vitest)
- `tests/dock-config.test.js` (unit, vitest)
- `tests/dock-display-rebuild.test.js` (unit, vitest)
- `tests/dock-health.test.js` (unit, vitest)
- `tests/dock-native-status-observer.test.js` (unit, vitest)
- `tests/dock-trigger-electron.mjs` (gui, electron)
- `tests/draft-dialog-ui-electron.mjs` (gui, electron)
- `tests/error-capture.test.js` (unit, vitest)
- `tests/first-use-notice-electron.mjs` (gui, electron)
- `tests/help-center-electron.mjs` (gui, electron)
- `tests/help-quick-links.test.js` (unit, vitest)
- `tests/help-scroll-motion.test.js` (unit, vitest)
- `tests/help-search.test.js` (unit, vitest)
- `tests/holiday-data-rules.test.js` (unit, vitest)
- `tests/holiday-data-service.test.js` (unit, vitest)
- `tests/list-minimal-mode-electron.mjs` (gui, electron)
- `tests/log-record-text.test.js` (unit, vitest)
- `tests/log-store.test.js` (unit, vitest)
- `tests/log-writer-client.test.js` (unit, vitest)
- `tests/logging-actions-electron.mjs` (gui, electron)
- `tests/main-logging.test.js` (unit, vitest)
- `tests/main-view-enhancements-electron.mjs` (gui, electron)
- `tests/maturity-electron.mjs` (gui, electron)
- `tests/maturity-interactions.test.js` (unit, vitest)
- `tests/maturity-regressions-electron.mjs` (gui, electron)
- `tests/modal-blur.test.js` (unit, vitest)
- `tests/modal-queue.test.js` (unit, vitest)
- `tests/month-context-menu-electron.mjs` (gui, electron)
- `tests/month-day-preview-status-electron.mjs` (gui, electron)
- `tests/month-event-text-color-electron.mjs` (gui, electron)
- `tests/month-view-electron.mjs` (gui, electron)
- `tests/note-draft-conflict-ui-electron.mjs` (gui, electron)
- `tests/note-duration-electron.mjs` (gui, electron)
- `tests/note-list-animation-electron.mjs` (gui, electron)
- `tests/note-list-completion-electron.mjs` (gui, electron)
- `tests/note-list-toolbar-electron.mjs` (gui, electron)
- `tests/note-text-color-electron.mjs` (gui, electron)
- `tests/note-text-color-rules.test.js` (unit, vitest)
- `tests/note-weather.test.js` (unit, vitest)
- `tests/notice-admin-electron.mjs` (gui, electron)
- `tests/notice-markdown-electron.mjs` (gui, electron)
- `tests/notice-markdown.test.js` (unit, vitest)
- `tests/performance-attribution.test.js` (unit, vitest)
- `tests/performance-diagnostics.test.js` (unit, vitest)
- `tests/pointer-anchored-popovers.test.js` (unit, vitest)
- `tests/queued-modal-lifecycle.test.js` (unit, vitest)
- `tests/quick-note-edit-electron.mjs` (gui, electron)
- `tests/recurrence-rules.test.js` (unit, vitest)
- `tests/recurring-note-preview.test.js` (unit, vitest)
- `tests/recurring-preview-electron.mjs` (gui, electron)
- `tests/reminder-native-acceptance.cjs` (native, node)
- `tests/reminder-notification.test.js` (unit, vitest)
- `tests/reminders-electron.mjs` (gui, electron)
- `tests/remote-health-cache.test.js` (unit, vitest)
- `tests/run-focused-tests.test.js` (unit, vitest)
- `tests/scheduler.test.js` (unit, vitest)
- `tests/settings-schema.test.js` (unit, vitest)
- `tests/settings-scroll-memory-electron.mjs` (gui, electron)
- `tests/sliding-workspace.test.js` (unit, vitest)
- `tests/sticky-diagnostic-ipc.test.js` (unit, vitest)
- `tests/sticky-tray-menu.test.js` (unit, vitest)
- `tests/sticky-utils.test.js` (unit, vitest)
- `tests/system-diagnostics.test.js` (unit, vitest)
- `tests/template-quarterly-electron.mjs` (gui, electron)
- `tests/template-scheduler-guard.test.js` (unit, vitest)
- `tests/template-ui-utils.test.js` (unit, vitest)
- `tests/test-build-descriptors.test.js` (unit, vitest)
- `tests/test-build-provenance.test.js` (unit, vitest)
- `tests/test-entrypoints.test.js` (unit, vitest)
- `tests/test-manifest.test.js` (unit, vitest)
- `tests/test-result-adapters.test.js` (unit, vitest)
- `tests/test-result-recorder.test.js` (unit, vitest)
- `tests/test-runner.test.js` (unit, vitest)
- `tests/test-selection.test.js` (unit, vitest)
- `tests/thumbnail-benchmark-electron.mjs` (performance, electron)
- `tests/titlebar-icon-scale-electron.mjs` (gui, electron)
- `tests/ui-components-electron.mjs` (gui, electron)
- `tests/ui-feedback-app-electron.mjs` (gui, electron)
- `tests/ui-feedback-electron.mjs` (gui, electron)
- `tests/ui-popover-motion.test.js` (unit, vitest)
- `tests/ui-responsive-electron.mjs` (gui, electron)
- `tests/view-visibility-shortcut-electron.mjs` (gui, electron)
- `tests/view-visibility-shortcut-service.test.js` (unit, vitest)
- `tests/view-visibility-shortcut.test.js` (unit, vitest)
- `tests/wallpaper-crop.test.js` (unit, vitest)
- `tests/wallpaper-storage-electron.mjs` (storage, electron)
- `tests/weather-rules.test.js` (unit, vitest)
- `tests/weather-selection-path.test.js` (unit, vitest)
- `tests/weather-service.test.js` (unit, vitest)
- `tests/weather-settings-electron.mjs` (gui, electron)
- `tests/week-day-panel-electron.mjs` (gui, electron)
- `tests/week-view-electron.mjs` (gui, electron)
- `tests/window-border-electron.mjs` (gui, electron)
- `tests/window-control-drag-electron.mjs` (gui, electron)
- `tests/window-frame-electron.mjs` (gui, electron)
- `tests/window-state-matrix-electron.mjs` (gui, electron)
- `tests/window-z-order-electron.mjs` (gui, electron)
- `tests/window-z-order-recovery-electron.mjs` (gui, electron)

另七个 DB 专项（独立 owner，不计本批未审 128 项）：

- `tests/backend-integration.mjs`
- `tests/note-duration-db.mjs`
- `tests/note-list-completion-db.mjs`
- `tests/note-remark-db.mjs`
- `tests/note-text-color-db.mjs`
- `tests/recurring-preview-db.mjs`
- `tests/reminder-database-integration.mjs`

## 6. A-00 窄修与局部运行结果

入场副本：`tmp/beta-readiness/audit/recent-local-day-range-before/recent-local-day-range.test.js`；同时保存 `useTimelineListModel.js` 用于确认生产实现未改。`static-review-first-batch.json` 仍保留静态审查时清单身份，窄修运行单独记录，不覆盖原失败。

复现前：固定 Node/PATH 执行该单项 Vitest，七个用例全部失败，均在旧 NoteList 函数正则 `match(...)[1]` 处发生 `Cannot read properties of null (reading '1')`。没有到达时区行为断言，不能解释为产品 DST 逻辑失败。原报告与输出为 `vitest-before.json`、`vitest-before.log`。

最终改动：不再从旧 SFC 正则复制 cutoff，直接导入当前 `useTimelineListModel`，执行其 `load`，捕获真实 recent 与 earlier 查询参数。测试 ports 仅返回空数据，隔离 query/UI；cutoff 由生产 model 派生。每个 TZ 子进程设置固定 Date.now，不影响宿主或系统时区。保留原七组搜索 start/end/小时 oracle，再为两个 timeline 查询增加独立固定日历日期预期及 load success，而不是调用同一个计算函数生成期待结果。

修后：同一单项 7/7 通过，failed/pending/todo 为0；该测试 ESLint 和 Prettier 通过。没有运行GUI、原生构建、DB集成或全量。生产 timeline 文件与入场副本 SHA256 相同：`F52B0BEA2CA945C1AE97F36DB67016D3338AABEDF34C9B559F6F729E06CEBEEE`。结果在 `vitest-after.json`、`vitest-after.log` 与 `recent-local-day-range-narrow-fix.json`。

源读取映射由根代理成组更新，本代理未修改 manifest/domain/CI。下一步须把实际 owner 加入 `sourceReadDefinitions` 与适用 domain/CI 映射，再执行对应选择基础设施局部验证；上述 7/7 不替代映射验收。
