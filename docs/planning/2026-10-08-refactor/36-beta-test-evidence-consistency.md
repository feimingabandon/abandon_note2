# BR-02 测试证据隔离与最终结论一致性

日期：2026-10-10。状态：修前私有复现确证，窄修完成，修后私有故障样本和namespace守卫通过；三个Vitest文件、构建与GUI仍待root统一串行验收。

## 范围和恢复

只处理31的F-01/F-05：两个CLI suite的证据namespace，以及runner最终报告/summary/completion写失败后的结论。允许修改runner、focused及直接相关三unit；不动root集中处理的manifest、manifest test、CI test，不动生产业务/WindowStation实现。

恢复点 `tmp/beta-readiness/test-evidence-before-20261010-151816-209/` 保存runner、focused、test-runner、run-focused-tests、test-selection五文件与SHA256。只恢复本批对应文件，不重置dirty仓库。

## 先复现再判断

私有故障注入仅创建 `tmp/beta-readiness/f05-private-*`，运行受控Node child，拦截本样本拥有目录的node:fs写入。不得调用Vitest/build/GUI、创建共享tmp/test-runs、写缓存或修改真实文件权限。

逐项复现：初次case报告写成功，仅最终case persist失败；run summary写失败；summary成功但completion写失败。保存返回值、case/recovery/summary/completion与真实错误。若最终summary和command仍拒绝，明确问题是落盘报告一致性，不能称产品错误放行。

## F-01 修改步骤

1. 为真实CLI提供明确的私有证据根，两个suite每case拥有自己的namespace；保留真实repo registry和真实CLI路径。
2. 目录检查只检查被测调用namespace。另一个合法run在另一个namespace创建产物不应误报。
3. 保留负保护：故意让本次被测plan在自己的namespace创建run/report，目录守卫仍拒绝。不得删除目录断言或允许本次plan实际执行。
4. 明确source-only只规划、未知/空scope拒绝、显式单目标等原断言保留。无参不能回退全量。

## F-05 修改步骤

1. 报告写失败立即更新evidence/status/accepted拒绝，再序列化安全recovery；失败现场保留。
2. 明确case报告是暂态还是最终、是否可用、哪个安全报告是当前authoritative。不能用曾写成功的旧case/report覆盖最终失败。
3. summary/completion写失败要更新当前case证据，并产生可识别的最终run报告状态；原文件不安全时使用自有恢复目录，不通过链接写入。无法写出的报告明确不可用。
4. 依赖只认最终成功；证据失败挡其依赖，独立check继续。业务断言passed与证据失败分维度保留，最终accepted=false。
5. 添加私有fixture保护原故障及primary/recovery均失败、链接拒绝；测试只处理自有目录与进程，不吞异常、不删除现场、不改变exit0验收。

## 验收和停止条件

本批可执行不写Vitestcache的私有前后复现。root空窗后用AGENTS指定Node与过滤Volta的PATH，仅运行test-runner、run-focused-tests、test-selection三个文件；必要focused消费者由root根据实际修改决定，不自动扩大为全量。GUI/构建尚不需要本修复证明。

每个复现后要求：最终返回和可用authoritative报告一致拒绝；旧/暂态产物有明确不可用边界；原业务状态与错误仍保留；自己的plan写产物仍被检测、其它namespace合法run不误报。满足后停止，不把单机单人产品升级为无限并发压力测试。

## 实际修改与报告读取契约

修改五个文件：`scripts/test-runner.cjs`、`scripts/run-focused-tests.cjs`、`tests/test-runner.test.js`、`tests/run-focused-tests.test.js`、`tests/test-selection.test.js`。没有修改生产业务、renderer、manifest/CI、原生构建或剪贴板代码。

### F-01 私有证据namespace

1. runner的默认证据根支持 `ABANDON_TEST_EVIDENCE_ROOT`。focused的优先级是显式 `evidenceRoot`、传入env的同名override、仓库 `tmp/test-runs`。已有显式单目标、source候选只规划和错误scope拒绝行为保留。
2. 两个真实CLI suite每次调用使用自己的临时namespace，保持真实仓库registry和CLI路径，PATH过滤Volta。守卫只比较自己的namespace前后文件名，不再读共享目录的所有run。
3. 两suite都增加独立合法check在另一namespace成功、自己的目录检查仍通过的保护；另有刻意误写自己的run/report的坏plan fixture，要求守卫抛错。没有删除“plan不能写产物”的保护。
4. focused已有实际单unit执行用例同时覆盖env override；另一个已有混合目标用例保留显式option优先级并检查未使用env目录为空。正式执行仍由root串行。

### F-05 最终报告与失败恢复

1. case新增 `reportResult`：`phase` 为provisional/final，`generation` 单调递增，`primaryUsable` 和 `authoritativePath` 明确当前可用位置。初次cleanup前的报告是provisional、accepted=false；最终成功报告为final/complete。写错先更新accepted=false、unverified和evidence错误，再写final/recovered拒绝报告；primary与recovery都写失败时为unavailable、authoritativePath=null。旧文件保留，不能把provisional或已被拒绝的primary当最终证据。
2. run新增 `run-report-status.json` 提交标记。写summary/completion前先标publishing；二者写成后才标complete。标记包含runToken、generation、total、finalRun，completion带同一代次。只有phase=final、finalRun=true且代次匹配的标记可以证明整个run报告可用，早期批次complete不能证明后续批次完成。
3. primary summary/completion/commit失败时先拒绝当前attempt，通过保存原路径所有权的WeakMap闭包重新写case。run根标记变为recovery-required、primaryStatus=failed、primary summary/completion路径不可用，并指向新自有run-report目录的status标记。该目录先写拒绝后的summary/completion，再提交recovered标记；读取者应按此authoritative路径取拒绝结论。曾写成功但属于失败提交的primary summary可能仍有accepted=true，明确不可用，禁止单读它。
4. recovery再失败时，返回及可写case标记unavailable，summaryPath/completionPath清空；能够写出的status同样unavailable。所有primary/recovery/status错误都记录在evidence并输出到stderr。没有通过链接写入，没有删除失败报告或现场。若失败发生在cleanup之前，保留temporary；若最终报告写失败发生在已完成cleanup之后，保留已有stdout/stderr和报告，不能声称已移除的temporary仍存在。
5. `isResultSuccessful`在原有四维条件上要求final/complete case报告，以及存在时的complete run报告；不降低exit0、业务断言、证据或清理要求。报告失败立即阻挡依赖，独立check继续。新增unit覆盖final-case、summary、completion、final status提交、primary/recovery双拒绝、瞬态失败后依赖阻挡与独立成功；已有链接和硬链接保护保留并追加落盘拒绝检查。

### 父任务补充的focused映射

按root请求仅增加两个已经实现、等待真实GUI验收的standalone模式：`tests/logging-motion-overhead-electron.mjs` → `electron-real-app-motion-diagnostic-overhead`；`tests/daily-report-electron.mjs` → `electron-real-app-daily-report-selected-range-txt-xlsx-export`。只有motion-overhead的外层timeout改为270000ms，为其240000ms业务生命周期和12000ms清理留出外层余量；其它standalone仍为180000ms。这只是测试调度支持，不宣称对应业务已通过。

## 当前证据与下一步验收

根代理串行局部 attempt `tmp/test-runs/2026-10-10T07-38-44-652Z-Rs0tEz` 八文件六通过、两失败。`test-runner` 的完整登记断言揭示显式旧全量入口遗漏已有的 `window-motion-diagnostics-native.mjs`，同一Node模块对照明确只有这一个missing，并非新benchmark遗漏。窄修在 `run-full-tests.cjs` 追加 `manifest.focusedNativeTests`，其依赖限定 `build-native`；保留全量入口显式边界和旧未适配结论，不执行该入口。恢复点 `tmp/beta-readiness/focused-native-full-entry-before-20261010/`。`run-focused-tests` 两个真实内嵌 dispatch 失败仍待复核，不能把该 attempt 写为全部通过。

修前证据 `tmp/beta-readiness/f05-private-before.json` 确证：final-case恢复报告accepted=true而返回false；summary写失败时旧case=true而返回false；completion写失败时旧case/summary=true而返回false。最终内存summary和命令仍拒绝，问题属于测试报告一致性，不是产品错误放行。

修后证据 `tmp/beta-readiness/f05-private-after.json`：三种返回均false；case均false；final-case recovery为false；summary/completion失败的root标记均recovery-required、primaryStatus=failed，可用recovery summary/completion均拒绝。completion故障的旧primary summary=true有明确不可用标记，故意保留用于验证不能误读旧文件。

`tmp/beta-readiness/f01-private-after.json` 对两个真实CLI逐项记录：plan exit0且executed=false；拒绝scope exit2且executed=false；另一私有namespace合法check accepted=true没有造成误报；故意误写自己的namespace被守卫拒绝。额外用Node assert读回F-05最终报告，检查其一致拒绝与authoritative位置。

执行的私有脚本为 `tmp/beta-readiness/reproduce-test-evidence-consistency.cjs after`、`tmp/beta-readiness/verify-private-test-evidence-namespace.cjs`。均为受控Node check、真实CLI只规划和故障注入；不执行产品业务测试、Vitest、build或GUI，不写共享test-runs或Vitest缓存。五文件Node语法检查和指定文件Prettier、diff --check通过。原31静态审查保留旧snapshot身份，没有覆盖为修后结果。

下一步由root在代码固定后串行运行指定Node与过滤Volta的PATH，执行 `node_modules/vitest/vitest.mjs run tests/test-runner.test.js tests/run-focused-tests.test.js tests/test-selection.test.js`，然后按自己实际新增映射运行两个真实专项。本批没有运行全量回归、Qt、Electron窗口或构建，也不能替代真实GPU、DPI/多屏或用户机器验证。

恢复前先与root核对当前owner；只能恢复本批diff对应片段或入场副本中本批拥有文件，不能覆盖root随后在focused/runner上的包内调度修改。不得reset或清理整个dirty仓库。

## 串行验收发现的嵌套fixture路径问题

root的真实局部8file attempt `tmp/test-runs/2026-10-10T07-38-44-652Z-Rs0tEz` 中，run-focused-tests两个实际执行用例失败，内部目标立即runner-error/0ms，而短ID的build-app仍能建立attempt。其余F-01新namespace用例及F-05故障用例通过；test-runner另一个旧manifest计数断言由root处理。本批不把这些失败记作产品通过。

失败stdout记录的focused evidence根有197字符：unit的 `tmpdir()` 继承父runner的TEMP，之后又追加fixture/run/case/temp/profile。unit afterEach已删除自己的嵌套fixture，所以不能从已删除报告编造具体错误；改用私有同长度Node样本复现，证据 `tmp/beta-readiness/focused-nested-path-reproduction.json`。

该样本不用Vitest，只调用真实runJob受控check。长197字符根分别使用父managed env和干净env，均在 `mkdtemp(case/temp-XXXXXX)` 抛同一 `ENAMETOOLONG`，发生在spawn之前；缩短至107字符后，保留相同父managed env，check accepted=true。由此排除“result namespace环境变量导致业务拒绝”的猜测，确证Windows嵌套fixture路径长度是这两个测试失败的原因。

最窄修复仅修改 `tests/run-focused-tests.test.js`：自有fixture改为仓库tmp下唯一的 `focused-unit-*`，保持两CLI的每次namespace隔离，afterEach仍只清理自身创建目录；不再把完整内层run嵌入父TEMP。两个实际执行用例的原exit、throughput计数、业务断言和build阻挡断言全部保留，只在失败message附真实results原因，便于下次直接看到runner错误。未修改runner、生产路径或Windows长路径配置。

本次unit入场恢复点 `tmp/beta-readiness/focused-fixture-before-20261010-074252-012/` 仅保留该文件。私有复现Node assert exit0；修复后正式Vitest由root串行重跑，未在子代理运行Vitest/build/GUI或重建共享test-runs。

## 根任务后续验收与暂停状态

上述“待root重跑”属于当时记录。后续集中质量attempt `tmp/test-runs/2026-10-10T07-52-09-968Z-6DjHnz` 中，test-runner 39/39、test-selection 58/58、test-result-adapters 15/15、test-result-recorder 13/13、test-manifest 21/21均accepted；focused runner因新包内prepare同步异常断言失败，后按[42](42-quality-unit-assertion-repair.md)窄修，`2026-10-10T08-01-18-961Z-FLoV2w`中14/14 accepted。最终报告标记与completion已读回核对，旧失败不覆盖。

后续root为包内专项增加外层270秒调度及显式候选目录准备保护；两个真实专项的映射继续有效。35运动开销、37日报GUI、38包内业务尚未运行；38脚本清理deadline与版本断言仍待收尾。用户要求先完成其它产品修改，当前只同步记录，不继续测试、构建或打包。本节的局部基础设施结果不等于整体质量或发布验收通过。
