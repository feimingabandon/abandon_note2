# BR-02 测试基础设施资产静态审查

日期：2026-10-10。状态：本批 **10/10 项完成静态审查，执行测试和构建均为 0**。本批与27第一批、29/30其它资产审查分别计数；不得重复累计。本文件不宣称内测候选通过，也不改写其它批次的运行结果。

已完整阅读十个测试文件的断言、fixture、清理，以及它们对应的选择器、入口、runner、报告适配、recorder、构建描述与来源证明实现；同时核对实际 CI、release workflow、package scripts 和构建 job 消费位置。精确源码身份、逐项 owner 和结论见 `tmp/beta-readiness/audit/static-review-test-infrastructure.json`。这是静态底稿，`executed: false`，不是运行 attempt。

本批仅新增本文与自己的 JSON/清单生成脚本；没有修改生产、测试、manifest、CI，没有运行 GUI、数据库、Vitest 或构建。审查期间 root 独立处理的登记修正另记，不能归为本代理实现或验证。

## 1. 优先结论

十项均有应保留的真实保护，没有依据整文件删除。多数负例保护的是“测试工具不能给出假通过、覆盖旧证据或触碰别人的文件”，不是产品要承受无限用户并发。软件是单机单人，并不意味着测试工具可以用错目标、旧包、错误模式或不完整报告证明发布就绪。

当前结果协议总体边界合理：`processResult`、`businessResult`、`evidenceResult`、`cleanupResult` 分开记录；只有进程、业务断言、证据、清理都成功且 `accepted=true` 才计入 `verifiedPassed`。零断言、全跳过、旧报告、多报目标、错误 token、缺 adapter、失败依赖都不能形成通过。build/check 允许用明确进程检查，不伪造业务断言数。

仍需处理五类窄问题：共享证据目录导致隔离误报；构建与 Vitest 缓存写入并发；CI 映射同源期望发现不了漏项；真实资产被固定为永远未审的 fixture 耦合；失败后内存结论与此前已写报告可能不一致。前两类已在28记录真实干扰；后面明确区分静态发现与尚未执行的复现。

## 2. 逐项完整审查与处置

| 测试文件                               | 已核对的 owner/消费者                                                                  | 实际保护与独立判定依据                                                                                                                                                                                                    | 处置与边界                                                                                                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/ci-test-selection.test.js`      | `run-ci-tests.cjs`、`test-domain-rules.cjs`、manifest/focused；实际 CI/release/package | Windows 平台拒绝、committed diff 与 dirty 隔离、merge-base、明确叶子映射、广入口需域审、删除保护审查、package 仅 scripts 分类、候选不授权执行、无全量 fallback。真实临时 Git 仓库和固定 calendar 两目标提供独立判定。     | 保留。大量期望直接来自 `infrastructureRules/domainRules`，只证明调度按表执行，不证明表完整；补具体变更→固定目标的漏映射保护。不能据此升级为全量。                           |
| `tests/run-focused-tests.test.js`      | focused、selector、runner、adapter、build jobs；真实本库 CLI                           | 单目标与完整构建依赖、只读 plan、未知/空范围拒绝、无 adapter 阻断、独立目标继续、PATH 去 Volta、Electron ready 与 Electron-as-Node 隔离；真实单文件 Vitest 报告参与结果验收。                                             | 保留；真实仓库 `tmp/test-runs` before/after 比较有并行归因缺陷，见 F-01。两个真实嵌套 Vitest case 会写缓存，不能与 app provenance 构建并发。                                |
| `tests/test-build-descriptors.test.js` | `test-build-descriptors.cjs`、实际 `test-build-jobs.cjs` 消费                          | 用私有源树明确 app 输入、环境摘要与秘密不落盘、外部 Node injection 禁止复用、notice 独立输出、Qt 指定目标排序与私有目录、native 未完整工具链 closure、ABI 声明与真实 probe 区分。                                         | 保留。fixture ABI18 是受控输入，不是当前 DLL ABI 验证。当前全 node_modules 输入包含 Vitest 缓存，见 F-02；descriptor自身 suite 的 CI 漏项已由 root 补入，未由本批运行验证。 |
| `tests/test-build-provenance.test.js`  | provenance、descriptor/build-job 接口                                                  | 私有文件的真实 SHA256 oracle；源码/锁文件/config/output/tool/mode/ABI 新增改删都使复用失效；构建前后漂移、closure 未审、缺产物、最新坏证明不能回退、验证证据需匹配 hash。junction/hardlink/越界输出保全外部文件。         | 保留。这些负例有工具证据边界价值；不是产品并发压力。证明 fixture 行为，不证明当前 MSVC/Qt 完整闭包或 DLL 实际装载。                                                         |
| `tests/test-entrypoints.test.js`       | `run-test-entry.cjs`、两个 Electron wrapper、实际 package/CI 消费                      | 具体 unit positionals、level 不越权、空/advisory-only 拒绝、按登记 role/runtime 判定、一个 window 目标不扩邻居、集合先完整展示再执行、release-quality 固定 unit+DB+storage、真实 wrapper 无参拒绝。                       | 保留。受控 focused mock 验证入口调用，不证明 Electron 桌面；源码入口断言与实际消费者核对可继续保留。                                                                        |
| `tests/test-manifest.test.js`          | manifest 全部数据表、discover/directImports/validator；selector和CI消费                | 实际目录独立发现与登记一致、role/runtime/support 分离、缺实体/缺登记/重复/大小写/循环/越界 junction 拒绝、真实 TS ImportDeclaration 解析不误读模板、已迁 owner 与具体 source-read 关系、五 security entry/三 capability。 | 保留。固定 almanac 为永远 unreviewed 与全表 cost 永远 unmeasured 应改写为受控状态契约，见 F-04；不能为测试通过保留已审资产未审。                                            |
| `tests/test-result-adapters.test.js`   | adapters；focused、Qt job、runner消费                                                  | Vitest 当前 attempt/唯一文件/汇总计数/未知状态/setup failure/零或跳过；standalone suite/token/mode/completed/counts；Qt 精确 CTest 与 QTest、setup-only 不计业务、真实错误不被 exit0 掩盖；新鲜有界报告与路径归属。       | 保留。业务 passed 与 scriptEvidence incomplete 或 cleanup failed 分维度返回是设计，runner 最终拒绝；不是错误通过。测试用报告 fixture，不声称是真 Qt/Electron 运行。         |
| `tests/test-result-recorder.test.js`   | recorder；focused standalone调用约定                                                   | 真 assert 同步/异步计数，expected throws/rejects计一次，捕获失败仍保留、pending 不提前完成、结束只能一次、attempt 环境必须成组、wx不能覆盖、写前重新核对真实父目录、runner/script profile所有权。                         | 保留。真实文件与junction fixture保护归属；不运行生产 DB。被测 assert 的期望不由 recorder替换，避免镜像通过。                                                                |
| `tests/test-runner.test.js`            | runner、旧 full runner jobs/selectJobs、manifest                                       | 真受控 Node子进程退出/超时/不存在命令、stdout/stderr与attempt、失败只挡依赖、独立check继续、清理失败和证据失败不计通过、临时目录保留、重复ID/净化碰撞不覆旧证据、链接/ADS拒绝、准备/适配超时、日志写失败有界。            | 保留。stdout标记→一断言的 `proven` 仅为 controlled-fixture，不能用作真实产品adapter。最终写/summary失败后的落盘一致性还缺保护，见 F-05。                                    |
| `tests/test-selection.test.js`         | selector、manifest；真实 planning CLI                                                  | 固定registry多级build拓扑、明确file/id/feature规则、昂贵目标显式选择、level/role/path/Windows大小写/特殊ID、冻结入参不修改、helper消费者候选传播、未映射拒绝、source-only无jobs、真实单DB范围。                           | 保留。真实CLI共享目录before/after同F-01；生产源码传递imports不是此实现的自动能力，需明确手工登记，见 F-03。纯路径POSIX fixture不代表产品支持非Windows运行。                 |

## 3. 具体修改指导、优先级与停止条件

### F-01：plan/拒绝入口的共享目录检查有并行隔离缺陷

已静态确认 `run-focused-tests.test.js` 的 `evidenceNames()` 与 `test-selection.test.js` 的 `runDirectories()` 比较真实仓库 `tmp/test-runs` 全目录前后列表。期间另一个合法 run 创建目录，也会导致被测“只规划不能执行”的断言失败。28已保留第一次并行干扰的运行现场；本批不重新执行、不增加失败计数，更不把它当生产问题。

内测本轮立即执行约束：这些测试及其它写 Vitest 缓存的 unit 与 GUI/provenance 构建串行。runner内部 job 本来串行，不能据此声称不同外层进程已经隔离。

后续窄改：将每个 CLI case 的证据根注入私有 fixture，或者给本次调用独立 namespace 并只检查该 namespace。focused API已可收 `evidenceRoot`；纯 selection CLI本身不创建证据，不应为避误报放宽成“任何目录变化都算合法”。CLI无法注入的边界可通过明确测试适配层实现，同时保留真实仓库 registry 的只读检查。

必须新增两个独立判定：同期另一个合法 run 新增目录时，plan 不误报；故意让被测plan本次写自己的run/report时仍拒绝。原保护“空/错误范围不能执行、plan不建产物”不得删。局部验收仅这两个文件及被改入口/runner所需unit；无须生产GUI。达成隔离且负例仍拒绝即停止，不要求产品无限并发。

### F-02：全 node_modules 构建输入包含 Vitest 可写缓存

当前 descriptor把完整 `node_modules` 纳入 app/notice closure，provenance完整枚举并对文件身份/内容漂移拒绝。Vitest写 `.vite/vitest/.../results.json` 与此闭包冲突，所以28的构建被阻断是来源规则按当前设计生效；编译exit0不能代替来源通过，阻断后 GUI 业务没有运行。

内测本轮采用串行即可，不跳过 provenance，不抹掉旧阻断。后续如缩小snapshot，先确认具体Vitest缓存不参与生产编译，只排除已证明的路径，并给出构建输入依据；不能排除整个 node_modules、全部 `.vite` 或所有cache。

窄验收应分别验证：无关Vitest结果缓存改变不会使合法production snapshot失效；实际electron-vite/esbuild或依赖模块内容改动仍使复用拒绝；新增实际依赖、lock/config/env/ABI/tool变化保护继续存在。预算与耗时应先实测，不虚构性能阈值。未有证据时维持完整输入与串行，诚实说明限制。

### F-03：CI同源映射与间接源码消费者需要补独立保护

本批发现 descriptor修改的CI目标原来只有provenance与capture-build-selection，缺它自己的 `test-build-descriptors.test.js`。root已补该suite；本批仅复核源码存在，不写验证通过。同源测试 `expect(selected).toEqual(infrastructureRules[path])` 在漏项时也会通过，不能作为映射完整性判据。

补法：给这个具体变更使用固定目标oracle，断言 descriptor自己的suite必入选，并保留原必要consumer。相同原则用于新 admitted叶子：owner→关键unit/必要integration固定期望，与实际断言审查对应；不要把所有生产源映射到所有测试。实际registry中目标存在且有adapter的检查继续保留。

选择器传播只发生在已登记asset之间；`manifest.directImports`只取被登记文件顶层 ImportDeclaration，不递归生产模块，也不自动收生产reexport。因此其它审计发现 `help-scroll-motion.js` reexport到`scrollMotion.js`，`noteWeather.js`用`weather-freshness.js/weather-display.js`，应核对这些间接生产消费者的 `sourceDependencies`；测试实际readFileSync源码才登记 `sourceReadDependencies`。

窄验收：分别对具体间接文件生成只读候选，确认正确测试入候选而 `jobs=[]`；显式选测仍只运行选中的目标；对映射缺项的受控fixture必须报警。来源候选仍是advisory，不能因候选多而自动全量。manifest/source-map完整性与CI admission完整性是两项检查，不能互相替代。

### F-04：治理测试的真实资产fixture耦合

`test-manifest.test.js` 把真实 `almanac-engine.test.js` 固定为 `unreviewed`。当前不代表已执行失败，但全资产审查完成后合理更新登记会使这个测试抵抗正确治理。全表必须 `cost==='unmeasured'` 同样锁住当前状态，而validator已经允许真实非负cost。

改法：用私有fixture验证未审资产确实产生unreviewed与对应limits；真实registry只校验disposition、contracts、features、limits一致，不要求某个生产资产永远未审。cost验证允许 `unmeasured` 或已测非负数，已测值需有真实测量证据；不为了清表凭空写0。

必须保留新资产漏登记、未知helper不得猜为test、同名大小写重复、坏依赖/越界、AST不读模板伪import等独立保护。局部只跑manifest/selection/CI与新增fixture涉及测试。停止条件是已审/未审/已测/未测都能正确表达，不能把静态审完当运行通过。

### F-05：失败后的最终报告一致性有静态缺口

已确认 runner内存状态最终拒绝错误，这一保护有效。另有两处写入顺序值得窄复现：

1. `runJob` 最终 `persist()` 失败时，函数先在catch写 recovery report，再由调用处设 `accepted=false`。若初次persist成功、清理完成后仅最终persist失败，recovery序列化发生在这次拒绝更新之前，可能仍带先前 `accepted=true`。现有链接负例主要在初次persist就失败，不能覆盖此顺序。
2. `runJobs` 在run summary/completion写失败后将内存result改为 `accepted=false`，却不重新发布该case已经写过的result；后续summary可显示失败，但单case result可能仍保留失败前的成功结论。现有linked-summary case核验了返回值和外部文件，未核验各报告之间一致。

这是**静态写入顺序风险，尚未执行该故障注入**；不称已证实内测被错误放行，也不归因生产数据/Windows层级。命令最终summary目前会据内存失败退出，风险主要是下游只读某一份过期报告。

后续窄改前先用私有fixture做可控故障：初次result写成功，仅最终写失败；summary成功而completion写失败；summary目的地链接拒绝。故障只影响本测试拥有目录，不改变真实仓库/外部文件权限。比较返回值、可读case result、recovery、summary、completion的最终拒绝与reason；不存在的报告须明确缺失，不能回读旧通过。

实现应先将evidence/status/accepted拒绝状态确定，再写安全恢复报告；对于无法改写的旧报告，以明确最终attempt状态与不可用标记阻止其作为通过，保持失败现场。不得简单吞掉写异常、删除诊断或把process exit0继续当通过。局部runner及focused/adapter必要consumer即可。此类证据工具负例有价值，不构成产品的极限并发门槛。

## 4. 旧全量入口的诚实边界

`run-full-tests.cjs` 仍有legacy unit/standalone job，没有统一 `assessResult/resultPolicy` 协议。当前runner会保存其exit0，但归为`legacyUnproven`，不计verifiedPassed；full命令可能因此非零。这是明确未证明，不是业务失败。不能拿该旧命令打印的PASS或零退出单项证明全候选通过。

本轮内测使用已适配的明确focused目标和必要专项记录。后续如迁移full入口，先保留完整目标/依赖保护，再逐域接实际adapter、attempt模式和清理；未迁资产继续列未覆盖，不能为获得全绿给legacy统一套stdout假adapter。是否迁移全部legacy由内测实际范围决定，不要求每次小修跑full。

## 5. 本批交付和后续验收范围

本批完成十项静态阅读，保留十项，删除候选为0；改写候选是F-01/F-04的特定断言，补保护候选是F-03/F-05，F-02保持串行并待证据。root的descriptor CI补项与recent日期重复key收口已在最终静态身份核对，不能代写它们的运行结果。

已执行：只读源码/配置核对、自己的清单与文档格式核对。未执行：这十项Vitest、Electron/Qt/DB专项、构建、全量测试、真实多屏/混合DPI/用户卡顿、打包/升级/卸载。父批次已跑的结果仍引用对应attempt，不能算本批执行。

真正改动时每个F项先保存自身文件与hash；保持原dirty其它内容。只执行修改直接相关的具体文件，Node使用AGENTS指定runtime并过滤Volta；已知需要桌面/缓存的专项一开始申请沙箱外。检查通过且上述独立负例仍拒绝即结束，不自动扩大成全量。最终要分别列静态已审、已运行、阻断、未覆盖及真实客户环境限制。

底稿生成脚本仅读取本批固定十项及列出的owner，然后写本批JSON；不修改registry、不启动runner。审计时源码可能由其它owner继续修改，最终实施与验收应以各自attempt基线为准，不把本底稿hash当永久身份。
