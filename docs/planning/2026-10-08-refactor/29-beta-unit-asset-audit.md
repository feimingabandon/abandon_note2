# 29：内测前 Vitest 测试资产逐项静态审查与定向修正指导

日期：2026-10-10。范围取自 `tmp/beta-readiness/audit/static-review-first-batch.json` 的 pending，筛选 runtime=vitest，再移交 10 项测试基础设施给 [31 报告](31-beta-test-infrastructure-audit.md)。本报告负责剩余 **61 项**。之前 reviewed、7 项数据库专项不重复审查；它们的运行结果也不混入本报告。

**本批静态审查已完整阅读 61 项测试正文与断言，核对相应目标模块和实际调用入口。初始静态审查未运行测试；后续仅获授权运行模板标签 fixture 演示和 `template-ui-utils` 单文件，已完成 28/28 case，详见第七节。没有构建或 GUI。** 生产审查范围是这些测试对应实现和关键消费者；help-content 核对内容索引结构，db-notes 核对 queryRecentNotes/hydration 路径，并非宣称全仓所有生产文件已在本批重审。`unit-asset-audit.json` 逐项保留当前 SHA256、字节数、测试声明行号、oracle、用户入口、模拟边界、时间依赖与依赖登记结论。测试动态参数化的声明数量不冒充已执行 case 数量。

初始结论：34 项直接保留，26 项保留并附边界/定向加固说明，1 项必须改写错误标签 fixture。该 fixture 已完成窄修与局部验收。没有整文件替代删除候选或不适用文件。“附说明”的 26 项并不等于 26 个产品缺陷；其中包含合理穷举、已经充分保护的边界、未来改动须同步的 fixture 和仍需比对专项覆盖的补测候选。

## 一、必须先修的测试缺陷：模板标签过滤 fixture 会误通过

位置：`tests/template-ui-utils.test.js` 的 `template UI state and filtering`，主要是 `combines text, frequency, tags and switches` 与 `matches any selected tag when filters contain multiple tags`。原审查 baseline 的 rows.tags 只有 name，filters.tags 也是中文文字。

生产 `filterAndSortTemplates` 明确将 tags.id 和筛选值转为 Number 后比较；真实 `TemplatePage.vue` 在按钮上调用 `toggleFilterTag(tag.id)`。错误 fixture 中 `Number(undefined)` 与 `Number('生活')` 均为 NaN，`Array.prototype.includes(NaN)` 返回 true。因此原测试没有区分真实标签身份，正文/频率条件及“所有已标记行”的期望掩盖了无关标签也会匹配的问题。这是测试输入与真实契约不符，不是已确认的产品过滤错误。

修正步骤：

1. 保存原文件副本、SHA256、测试声明/原断言位置和原 fixture；在单独记录中说明哪些输入被纠正。
2. 将“生活”改为 `{ id: 8, name: '生活' }`，“工作”改为 `{ id: 3, name: '工作' }`，筛选改为 `[8]` 或 `[8, 3]`。保持原有正文、频率、状态、排序、通知及编辑目标断言。
3. 加入选择一个与 rows 无关的数值 ID（例如 `[99]`）应返回空列表的反例；再加入仅选择 `[8]` 不得返回工作行的独立正/负例。防止 fixture 仍因 NaN 或全文条件误通过。
4. 不改生产算法，不放宽 expect，不删除旧 case。不要只新增一个负例而保留错误 fixture 为正式证据。
5. 在允许运行后，先以临时独立缺陷样本展示：旧文字 fixture 对不相关文字也会返回已标记行，而真实数值 `[99]` 返回空；该样本是测试缺陷演示，不记作产品回归通过。再以固定 Node 运行 `vitest run tests/template-ui-utils.test.js`，保存结果和退出码。
6. 如正确 ID fixture 暴露新的产品失败，停止把测试改成生产输出；保留失败 profile/结果，再单独定位该实际入口。

以上是初始发现与修正步骤；该窄修已按第七节完成运行验证，不能从其他资产的静态“保留”推导运行通过。

## 二、局部选择器须登记间接生产消费者

31 审查确认：选择器只遍历 registry 中登记的资产关系，不递归读取生产源码 import/reexport；manifest.directImports 也只扫描测试资产直接 import。因此“wrapper 已登记”不能保证被 wrapper 使用的真实 helper 修改后选到测试。

本批确认 **21 项**存在实际间接消费者未登记。精确 test→owner 列表在 JSON 每项 `dependencyAudit.confirmedMissingSourceDependencies`；此外 `indirectCandidates` 列出直接生产 import 的候选，并标注测试层 mock，**不能把所有候选不加区分自动追加**。

典型关系：

| 测试                   | 实际消费者                                                                                       | 为什么需要登记                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| help-scroll-motion     | scrollMotion.js                                                                                  | 目标文件已变为单行 reexport，动画实现在共享 helper         |
| note-weather           | weather-freshness.js、weather-display.js、weather-rules.js、calendar-date-rules.js               | 可见时间/新旧数据/来源文字和便签日期来自 helper            |
| capture-shortcut       | capture-shortcuts.js、view-visibility-shortcut.js                                                | 默认动作集合和 accelerator 规范决定真实行为                |
| settings-schema        | view-visibility-shortcut.js、window-compact-geometry.js                                          | 默认快捷键与 compact 限制来自共享契约                      |
| queued-modal-lifecycle | modalQueue.js                                                                                    | 真实 Vue composable 使用共享排队实例                       |
| sticky-utils / tray    | stickyConstants.js / settings-schema.js                                                          | 外观/位置默认值与视图菜单范围来自共享契约                  |
| sticky-diagnostic-ipc  | diagnostic-ipc.js、diagnostic-actions.js                                                         | sticky wrapper 直接复用共享诊断实现                        |
| main-logging           | log-writer.mjs、log-writer-client.js、crash-dump-store.mjs、diagnostic-state.js、policy/sanitize | 测试有真实 Node Worker 落盘，Worker 模块不是仅 fake worker |
| weather-service        | weather-rules.js、weather-freshness.js、china-weather-admin-centers.js                           | 格式化、模型有效时间与本地坐标直接改变测试输出             |
| remote-health-cache    | remote-client.js、device-info.js                                                                 | fetch 请求和会话上报不是 coordinator 单文件即可覆盖        |

修正由根代理集中维护 manifest，本批不改 manifest。先对 overlay 注册表逐个提供改变的 helper 路径，确认该直接消费者测试被 selected 或某个等价专项有明确覆盖；保留 selection reason 和 set difference。domain 规则可能扩大选择，但“某次大范围兜底恰好选到”不能代替准确归属。选择验证是静态 dry-run，不需为登记一个 helper 启动全量业务测试。

本批没有确认遗漏的**测试直接读取生产源码文本**登记。almanac 读独立 fixture、日志/天气读测试自有文件、system diagnostics 生产采集自身 hash，与测试读取源码检查调用形态是不同情况；不要把所有 readFile 一律标成 sourceRead。

## 三、应保留的真实保护与验证边界

- 单机单人仍会产生多窗口请求、旧请求迟到、后台调度、网络响应与保存对话框期间的日志写入。不能因“单人”删掉可达异步交错保护。66 个退休窗口 fixture 是整个应用生命周期累计，并非同时打开 66 个窗口。
- 1900–2100 日期支持域穷举、固定 Python 黄历 oracle、闰年单点和长文本粘贴是算法/内容边界，不是让人以机器速度点击。若性能成本过高，先测量再隔离昂贵 case，不能为减少耗时删除独立参考保护。
- quota/巨 payload/getter/cycle 测试缩小成本预算模拟真实高频事件与异常对象，保护诊断旁路不干扰业务。其合成规模不必每次都作为内测人工验收条件。
- Apple titlebar/token 期待是保留的视觉设计；Command/Option accelerator 被拒绝是 Windows-only 负向保护；国际天气数据也不是跨平台运行代码。
- fake RAF、mock screen 125% 和 144Hz 字段、native status fixture 都只证明数据/协议/算法。不能称为真实多 DPI、多屏、GPU、通知中心或 DWM 像素验证。拖动/贴边卡顿根因仍按用户决定交测试用户采集，不在本批宣称已经修复。

## 四、后续定向加固规则，不一次铺开全部测试

| 候选                               | 具体改法与保留目标                                                                                                                                                | 局部验证/停止条件                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| maturity-interactions retry clock  | 最后 nextRetryAt > Date.now() 有真实时钟依赖；生产首轮 backoff 为 60000ms，只有断言前暂停超该窗口才可能误失败。冻结时钟后比较确定预期和重试边界；保留失败重试保护 | 只运行该文件；若拆 owner，先做原声明/断言迁移对照，不能先删保护                      |
| main-logging 三个 console case     | 1300ms 固定 wait 绑定生产1250ms缓冲。后续将窗口捕获拆成明确受控 timeout 用例，同时保留真实 Worker/JSONL 成功及失败恢复测试                                        | 并非已经确认偶发失败；避免同时 fake Worker RPC/所有 timer 造成新误判，按捕获边界隔离 |
| calendar-metadata profile          | app.getPath=cwd 可能读取 workspace/calendar-data；改独立临时 profile，必要数据显式写 fixture                                                                      | 不得删除用户/工作区覆盖文件；仅比对相应 metadata 文件结果                            |
| app-update 与内测版本号            | 当前 normalizeVersion/compareVersions 只支持 x.y.z；beta 后缀会在 check 的 try 前生成 artifact 时抛错。打包方案必须先确认版本与升级策略                           | 不删拒绝 beta 的断言迁就包名；如改更新契约必须作为独立产品决定并有版本迁移覆盖       |
| daily-report/calendar IPC          | 单文件未覆盖 export取消/授权/写入失败、month路由、holiday导入取消/错误/广播；先对照现有专项是否等价覆盖                                                           | 无等价覆盖且入口实际可达才加窄 case；fake service 不能代替真实 IPC/SQL/文件证据      |
| modalBlur / slidingWorkspace       | 前者补同 target 重复 retain 的引用计数候选；后者目前仅两个 duration helper case，核对 leave/打断/重开真实组件专项                                                 | 必须区分 pure helper 与组件接线，不用大量源码字符串断言代替交互                      |
| weather-service                    | 根据天气专项核对 timeout/429 Retry-After/损坏缓存/请求期间换地点和写失败保护；已有 shouldStore/写失败/空200/真实0度保护保留                                       | 不在线调用第三方作为稳定 oracle；真实网络可用性单独实机记录                          |
| performance-attribution DB fixture | 当前4次mock读取×80ms，320ms仅为fixture模型；查询关系变化时同步更新mock查询模型                                                                                    | 不把320ms当产品预算，不删DTO/隐私保护，不用该unit结果推导性能根因                    |

每项补测应说明：真实用户入口、故障/风险、独立期待值、为何现有资产不能保护、mock 到哪里、最小执行范围和结果保留位置。测试应该在故意破坏对应行为时失败；“fixture 本身对且其他无关行为也能通过”不足以构成有价值的保护。只验证实现步骤/私有变量/绘图精确偏移的断言，未来重构时可在等价行为测试先落地后替换；目前不整文件删除。

## 五、61 项逐项处置表

表中“保留”仅表示静态审查确认当前保护具有价值和入口。逐项发现、时间依赖、hash、测试声明与间接依赖请以精确 JSON 为底稿。下面由该底稿生成，不复述运行通过率。

| #   | 资产                                             | 处置                                  | 独立 oracle / 保护                                                              | 实际入口                                                                | 模拟与证据边界                                                                                              |
| --- | ------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | `tests/almanac-engine.test.js`                   | 保留；按候选规则定向加固              | 固定 Python 参考 fixture、独立节日日期与非法年边界                              | 日历黄历卡片、按选中日计算                                              | 纯算法与 TZ 子进程不证明 Windows UI、DPI 或跨屏                                                             |
| 2   | `tests/almanac-requests.test.js`                 | 保留                                  | 请求次数、固定结果、旧请求失效后可重试                                          | useAlmanac 请求卡片和节假日更新清缓存                                   | mock IPC 不证明真实 preload 或网络                                                                          |
| 3   | `tests/app-update.test.js`                       | 保留；按候选规则定向加固              | 固定 SemVer 比较与架构资产 URL                                                  | 设置检查更新、启动后台检查                                              | mock transport、download 和 shell 不证明真实升级                                                            |
| 4   | `tests/calendar-date-rules.test.js`              | 保留                                  | 固定边界日期、35/42 格、月末周及非法日期                                        | 月/周视图日期网格                                                       | 纯 UTC 日期规则不证明真实窗口                                                                               |
| 5   | `tests/calendar-event-layout.test.js`            | 保留                                  | 独立事件跨日位置和行布局预期                                                    | MonthCalendarGrid 多日便签显示                                          | 布局数据不证明 CSS 裁切或屏幕效果                                                                           |
| 6   | `tests/calendar-ipc.test.js`                     | 保留；按候选规则定向加固              | 真实 registrar、明确返回和授权拒绝                                              | preload month/week/calendar API                                         | mock services 不证明 Electron sender、真实 SQL                                                              |
| 7   | `tests/calendar-metadata.test.js`                | 保留；按候选规则定向加固              | 独立节日日期与单日/月结果                                                       | 日历节假日/黄历 metadata                                                | mock app.getPath；历法自一致之外有独立日期                                                                  |
| 8   | `tests/calendar-service.test.js`                 | 保留                                  | 独立日期列表、交集和预览开关                                                    | 月/周加载、导航刷新                                                     | mock DB/metadata/preview 不证明 SQL；DB 专项独立负责                                                        |
| 9   | `tests/capture-shortcut.test.js`                 | 保留；按候选规则定向加固              | bindingMap 与 externalSet 的注册/冲突/回滚结果                                  | 截图快捷键、主开关和录制切换                                            | mock globalShortcut 不证明 Windows 真注册                                                                   |
| 10  | `tests/daily-report-ipc.test.js`                 | 保留；按候选规则定向加固              | 真实临时 XLSX 落盘后由 ExcelJS 读取                                             | 导出日报按钮和 save dialog                                              | mock DB/dialog/shell；只有成功路径                                                                          |
| 11  | `tests/daily-report.test.js`                     | 保留；按候选规则定向加固              | 独立字段值、顺序、XLSX 回读、公式文本和截断预期                                 | 按选中日期/便签导出日报                                                 | mock notes；真实文件编码不证明系统 Excel 行为                                                               |
| 12  | `tests/diagnostic-actions.test.js`               | 保留                                  | 稳定 action 映射、隐私删除及 error code                                         | 深度诊断用户动作记录                                                    | 纯映射不证明接线完整                                                                                        |
| 13  | `tests/diagnostic-controller.test.js`            | 保留；按候选规则定向加固              | 受控 BrowserWindow 事件、buffer/ack/freeze 状态                                 | 开启深度诊断、renderer 退出及导出                                       | fake windows + transport；不证明真实 sender 和 WorkerASAR                                                   |
| 14  | `tests/diagnostic-evidence.test.js`              | 保留；按候选规则定向加固              | 独立 operation 上下文/失败/迟到结果阶段预期                                     | 编辑保存、持久化读取与 renderer applied 证据                            | AsyncLocalStorage 为真实实现；mock readback 不证明 SQL                                                      |
| 15  | `tests/diagnostic-ipc.test.js`                   | 保留                                  | 请求标记、上下文、catch 与 ack 预期                                             | preload invoke 包装                                                     | mock raw IPC 不证明 Electron 跨进程                                                                         |
| 16  | `tests/diagnostic-policy.test.js`                | 保留                                  | daily/deep 阈值、独立配额及 bounded getter/cycle 预期                           | 所有诊断源的成本和脱敏门槛                                              | 合成高频保护后台事件，不是要求用户高速点击                                                                  |
| 17  | `tests/diagnostic-transport.test.js`             | 保留                                  | 受控 ack timeout、expiry、quota、freeze request id                              | preload renderer diagnostic batch                                       | fake clock/raw IPC 不证明真实生命周期或包内 worker                                                          |
| 18  | `tests/dock-config.test.js`                      | 保留                                  | 独立最近边、tie、overshoot 和严格 payload 预期                                  | 贴边设置与显示器几何变化                                                | 模拟 display 不证明实际 multi-DPI                                                                           |
| 19  | `tests/dock-display-rebuild.test.js`             | 保留                                  | 迟到 generation、commit、timeout 与错误故障开放预期                             | display/fullscreen 变化后重建贴边                                       | mock native backend 不证明 DWM                                                                              |
| 20  | `tests/dock-health.test.js`                      | 保留                                  | minimized sentinel、过渡/稳定/presentation/pollAge 预期                         | 贴边健康检查和恢复判断                                                  | native snapshot fixture，不是画面验收                                                                       |
| 21  | `tests/dock-native-status-observer.test.js`      | 保留                                  | 稳定签名不计 timing、故障去重和末帧 capture                                     | 贴边状态深度日志和日常故障日志                                          | fake timer/getStatus 不证明 DLL 实际同步                                                                    |
| 22  | `tests/error-capture.test.js`                    | 保留                                  | 独立 window error/rejection/console 参数和去重                                  | renderer 安装错误捕获                                                   | node 中 stub window，无真实 Chromium 错误                                                                   |
| 23  | `tests/help-quick-links.test.js`                 | 保留                                  | 索引存在、唯一性和缺失项过滤                                                    | 帮助快捷入口                                                            | 内容模型不证明视觉导航                                                                                      |
| 24  | `tests/help-scroll-motion.test.js`               | 保留                                  | 受控 RAF 连续进度、重入取消及卸载                                               | 帮助页目录滚动                                                          | fake RAF 不是真实 FPS、硬件卡顿根因                                                                         |
| 25  | `tests/help-search.test.js`                      | 保留                                  | 固定标题/正文匹配及特殊字符高亮输出                                             | 帮助搜索                                                                | 字符串模型不执行真实 DOM                                                                                    |
| 26  | `tests/holiday-data-rules.test.js`               | 保留                                  | 节假日覆盖校验和固定替换语义                                                    | 节假日文件导入与 metadata                                               | 纯数据校验不证明文件系统                                                                                    |
| 27  | `tests/holiday-data-service.test.js`             | 保留；按候选规则定向加固              | 独立默认节日、导入覆盖、恢复与非法内容预期                                      | 节假日导入/恢复                                                         | 真实临时覆盖文件与 app mock                                                                                 |
| 28  | `tests/log-record-text.test.js`                  | 保留                                  | 独立完整消息/stack/context 文本                                                 | 日志列表和复制                                                          | 纯格式化，不证明真实展示                                                                                    |
| 29  | `tests/log-store.test.js`                        | 保留；按候选规则定向加固              | 独立事件时间顺序/分页 id/UTF8/配额/旧文件保留/导出 cutoff，真实临时文件回读     | 日志查询、分页、导出、保留策略与崩溃转储维护                            | 真实 fs、无 Electron；低 quota 是缩小重现存储压力，不要求用户大量点击                                       |
| 30  | `tests/log-writer-client.test.js`                | 保留                                  | fake worker ack/restart/cooldown/queue 预期                                     | 主进程向日志 worker 请求                                                | 不证明 WorkerASAR、真实线程和进程退出                                                                       |
| 31  | `tests/main-logging.test.js`                     | 保留；按候选规则定向加固              | 真实 Node Worker 和临时 JSONL 回读、独立 action 字段和源文件保护                | main 初始化 logger、window/process 捕获及日志导出                       | Electron app/window 为 mock；真实 Node Worker 仍不是 ASAR/真实窗口                                          |
| 32  | `tests/maturity-interactions.test.js`            | 保留；按候选规则定向加固              | LRU、reload 上限、popover 边界、IME、draft guard、retry 状态                    | 图片/窗口恢复/编辑保存/调度入口                                         | 多 owner 合集，mock renderer/geometry 与真实小模块                                                          |
| 33  | `tests/modal-blur.test.js`                       | 保留；按候选规则定向加固              | top layer 模糊、嵌套恢复和 release 幂等                                         | 通用 modal background blur                                              | fake DOM style 不证明 CSS 动画                                                                              |
| 34  | `tests/modal-queue.test.js`                      | 保留                                  | FIFO、确认持有、取消和 release 预期                                             | 编辑/通知/更新交错弹窗                                                  | 纯队列不证明组件 leave 接线                                                                                 |
| 35  | `tests/note-text-color-rules.test.js`            | 保留                                  | 固定区间拆分/映射及歧义丢弃；真实 Vue proxy clone                               | 编辑器文字颜色和内容保存                                                | 算法不证明选区 DOM                                                                                          |
| 36  | `tests/note-weather.test.js`                     | 保留                                  | 有效/获取/模型来源/旧数据与断网的独立文本                                       | 便签天气展示                                                            | 显式 now/结果模型，不证明实际 API                                                                           |
| 37  | `tests/notice-markdown.test.js`                  | 保留                                  | HTML 转义、URL scheme/credentials、属性注入预期                                 | 远程公告内容展示                                                        | 字符串 sanitizer，不证明 Chromium 交互                                                                      |
| 38  | `tests/performance-attribution.test.js`          | 保留；按候选规则定向加固              | 固定 perf clock、独立计数/时长与不含SQL/正文的负向期待                          | DB 查询 hydration、IPC handle 和同步 scheduler callback 性能归因        | fake DB/IPC，不证明 SQL结果或硬件耗时                                                                       |
| 39  | `tests/performance-diagnostics.test.js`          | 保留；按候选规则定向加固              | 受控 RAF/longtask/app metrics/native counters，独立采样/暂停/归因期望           | main 每秒轻检查、renderer 输入和导出汇总                                | fake native/CPU/DOM counts；rAF不等于实际呈现帧率，GPU进程CPU不是GPU利用率                                  |
| 40  | `tests/pointer-anchored-popovers.test.js`        | 保留                                  | 鼠标/键盘 fallback 与屏边 quick editor 几何                                     | 便签列表菜单、快速编辑                                                  | 模拟 viewport，不证明 Windows 屏幕/DPI                                                                      |
| 41  | `tests/queued-modal-lifecycle.test.js`           | 保留                                  | 真实 Vue custom renderer/nextTick，独立 visible 顺序和 leave handoff            | AppModalShell 以及编辑/报表/公告/更新等 request controllers             | 无 DOM/CSS/焦点原生输入；控制流程真实但不是画面测量                                                         |
| 42  | `tests/recurrence-rules.test.js`                 | 保留                                  | 固定周期规则、闰年和日期支持边界                                                | 循环便签/提醒规则计算                                                   | 纯日期算法；1900–2100 支持域穷举合理，2400 是算法单点                                                       |
| 43  | `tests/recurring-note-preview.test.js`           | 保留                                  | 固定模板、实例存在与历史交集输出                                                | 日历未生成循环便签预览                                                  | mock DB/recurrence，不证明真正落库                                                                          |
| 44  | `tests/reminder-notification.test.js`            | 保留；按候选规则定向加固              | 固定5按钮数量、5/10/30/60分钟、转义文本与非法URL                                | feature-runtime NotificationService、external protocol 提醒延后         | fake Electron Notification不证明通知中心/冷启动协议                                                         |
| 45  | `tests/remote-health-cache.test.js`              | 保留；按候选规则定向加固              | 固定health/retired响应、fetch调用次数、session queue/remove时序                 | 启动远程公告/可选设备上报、设置状态读取、退出补报                       | mock fetch 和DB回调；DeviceInfo读本机OS，不联系真实服务器                                                   |
| 46  | `tests/scheduler.test.js`                        | 保留；按候选规则定向加固              | 受控startup/recovery/reloadgeneration，独立健康状态和通知fallback               | feature-runtime 一分钟任务和恢复任务                                    | mock Notification，不证明系统休眠或通知中心                                                                 |
| 47  | `tests/settings-schema.test.js`                  | 保留；按候选规则定向加固              | 固定DB row key/value、defaults/clamp、legacy migration和CSS token               | 主/renderer共享设置schema；ApplicationSettings、SettingsPanel与视图应用 | 纯row/假root；不证明SQLite冲突持久化或DWM生效                                                               |
| 48  | `tests/sliding-workspace.test.js`                | 保留；按候选规则定向加固              | 两项 transition duration helper 独立预期                                        | 设置/日历滑动 workspace                                                 | 只证明 duration 解析，不代表全生命周期                                                                      |
| 49  | `tests/sticky-diagnostic-ipc.test.js`            | 保留；按候选规则定向加固              | 正文长度摘要、独立phase及业务result在日志失败时保持                             | sticky preload update-content/toggle-pin                                | mock transport/raw，不证明Electron IPC                                                                      |
| 50  | `tests/sticky-tray-menu.test.js`                 | 保留                                  | 独立菜单label/checked/enabled及service调用                                      | main-tray-controller 恢复/显示/关闭便利贴与切换视图                     | 纯模板+mock service；不证明原生Tray菜单交互                                                                 |
| 51  | `tests/sticky-utils.test.js`                     | 保留；按候选规则定向加固              | 独立原文/ID/颜色/可达位置及零overlap                                            | ElectronStickyService 创建、主窗口避让和移除屏幕后重映射                | 纯workArea几何，不证明multiDPI                                                                              |
| 52  | `tests/system-diagnostics.test.js`               | 保留；按候选规则定向加固              | 固定GPU/display/window字段、硬件标识负向过滤及timeout/partial                   | 日志导出时 collectSystemDiagnostics                                     | screen/GPU/版本/ACL provider为mock或缺getPath空实现；会读取自身源码hash与本机OS                             |
| 53  | `tests/template-scheduler-guard.test.js`         | 保留                                  | 独立3次失败/5min窗口和成功恢复期待                                              | feature-runtime noteGenerationTask 的服务级保护                         | 同步operation fixture；不证明实际模板SQL和调度时钟                                                          |
| 54  | `tests/template-ui-utils.test.js`                | 保留；已纠正标签fixture并完成局部验证 | 固定中文周期摘要/时间/状态/编辑目标；修正后按真实numeric tag id与无关id独立期待 | TemplatePage过滤、TemplateForm脏状态、TemplateCard摘要                  | 纯模型；原审查baseline的name-only标签fixture误通过已复证；numeric id窄修通过唯一focused 28/28，不证明UI/SQL |
| 55  | `tests/ui-popover-motion.test.js`                | 保留；按候选规则定向加固              | 动画替换旧 completion 不推进新 generation                                       | popover 展开关闭                                                        | fake animate 不证明真实视觉                                                                                 |
| 56  | `tests/view-visibility-shortcut-service.test.js` | 保留                                  | owner/binding/rollback/mastergate/latecallback 预期                             | 全局显示隐藏主窗口快捷键                                                | mock globalShortcut，不证明 OS 冲突输入                                                                     |
| 57  | `tests/view-visibility-shortcut.test.js`         | 保留                                  | 标准化、非法 Command/Option 和冲突 payload 预期                                 | Windows 显隐快捷键设置                                                  | 纯规则；非 Windows 键拒绝是支持边界                                                                         |
| 58  | `tests/wallpaper-crop.test.js`                   | 保留                                  | 独立 cover/ratio/visibleBounds 映射                                             | 壁纸裁切和预览                                                          | 数学，不证明真实图像解码/GPU                                                                                |
| 59  | `tests/weather-rules.test.js`                    | 保留                                  | 固定WMO中文含夜间图标、真实0度、09:00边界、坐标及反向地区转换                   | 天气位置标准化、日预报显示和scheduler刷新门槛                           | 纯输入，未联网且未调OS定位；国际天气数据不等于非Windows平台支持                                             |
| 60  | `tests/weather-selection-path.test.js`           | 保留                                  | 保存 district/city id/name 与 foreign fallback                                  | 设置天气地区恢复选择                                                    | mock district tree，不证明远程地区列表                                                                      |
| 61  | `tests/weather-service.test.js`                  | 保留；按候选规则定向加固              | 固定HTTP响应、独立模型/日期/温度/来源预期与真实临时JSON缓存回读                 | 天气设置地区解析、日历/列表预报读取、手动/后台刷新                      | mock fetch不证明第三方在线状态；地区树/坐标数据为实际依赖                                                   |

## 六、移交与完成口径

10 项基础设施资产：ci-test-selection、run-focused-tests、test-build-descriptors、test-build-provenance、test-entrypoints、test-manifest、test-result-adapters、test-result-recorder、test-runner、test-selection。其完整处置归属 [31 报告](31-beta-test-infrastructure-audit.md)，不重复填写这里的 oracle 或通过率。

本批静态审查执行源码阅读、AST/依赖清单提取与 JSON/文档结构校验；后续仅运行第七节的模板窄修验收。未执行 npm test、全量窗口回归、全量构建或新的 GUI 测试。跨进程、SQLite、真实 Windows 热键、通知中心、安装包 ASAR Worker、DPI、多屏、睡眠恢复和用户硬件卡顿等风险仍由对应专项/测试群材料负责。报告与窄 fixture 修正不代表已经满足全部内测门槛。

精确底稿：`tmp/beta-readiness/audit/unit-asset-audit.json`。生成工具仅解析文件并写审查数据，不导入生产模块执行，不启动测试。原始 pending 范围与当前测试 SHA256 均保存，后续源码若变化需标明失效范围，不能继续沿用旧快照为新版本通过证据。

## 七、后续窄修状态

根代理已授权最窄测试修改并完成局部验收：生活/工作 fixture 分别加 id=8/3，两个原筛选输入纠正为 numeric ID，新增 `[8]→[1]`、`[3]→[2]`、`[99]→[]`、`[8,99]→[1]` 四组身份判断。本窄修没有修改生产代码。

恢复点：`tmp/beta-readiness/template-tag-fixture-before-20261010-151026-887/template-ui-utils.test.js`，原 SHA256 `bd5508234cd8912a476c05a374de5eebe06f64ca883df57c4379fb65e439c12d`。已执行 `tmp/beta-readiness/audit/template-tag-fixture-evidence.mjs`，同名 JSON 的 `accepted=true`：旧文字 fixture 的 `['生活']` 与 `['完全无关标签']` 均返回 `[1,2]`，数值 `[99]` 返回 `[]`，其余三组真实 ID 结果与独立期待一致。AST 提取的 **33 个原 expect 完整表达式全部保留**；新增一个 expect callsite，参数化为四个 case。该演示明确标记为测试 fixture 缺陷，不作为产品故障或完整产品回归证据。

固定 Node、去除 Volta 的 PATH 后执行 `scripts/run-focused-tests.cjs --file tests/template-ui-utils.test.js`。唯一目标的标准结果目录为 `tmp/test-runs/2026-10-10T07-15-37-733Z-5dZmrI`：`focused-summary.json` 为 `verifiedPassed=1/1`、`successful=true`，目标 `result.json` 为 `accepted=true`、进程退出码 0、Vitest 完成 case **28/28**，失败/跳过均 0。28 是完成的 Vitest case 数，不是 expect 数。未运行其余 60 项单元资产、DB/native/GUI 或全量回归。

本批底稿已增加每项 `registrySuggestions`，提供基于实际保护的 contracts/features 和 `reviewed-protection` 建议。契约以 [01 测试指导](01-testing-guide.md) 为权威：C-011 仅用于日报；logging、diagnostic、error capture 与 performance 归 C-013，涉及授权边界时附 C-012；dock native observer 为 C-007+C-013。这些归属与其余 60 项静态资产处置不代表运行通过；仅模板项回填此次局部实证，生成器会核对当前文件 hash、fixture 样本及标准结果，过期时标记为未验证。manifest 统一由根代理维护，本代理没有编辑。

样本与唯一单文件 Vitest 已串行完成；格式/结构检查只针对本次编辑文件。未启动构建或 GUI，未将本机纯模型结果扩展为真实窗口、用户硬件或整个内测版本已经验收的结论。
