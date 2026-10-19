# 最终集成差异审查与收尾指导

日期：2026-10-09

阶段：B0–B7 约定实施完成后的集成审查。状态：约定范围已完成；五项成立问题已修复并通过对应局部验收。首次失败、阻断和未覆盖边界保留，实际结果见§5–6。

## 1. 授权、基线与范围

用户同意继续最终集成差异审查。此前连续实施授权仍有效；本阶段先进行只读审查，只对有具体证据的成立问题安排最小修复和必要局部验证。不得自动全量测试、提交、推送、打包、安装、发布或部署。

当前 HEAD 为 `4fbc52be1c688dba9cf23fbbd51539606efbf381`，分支 `main`。已有未提交改动保留。不能仅依据当前 `git diff` 推定改动作者或自动扩大验证范围。

B0ab 实施前状态来自 `tmp/refactor-baselines/B0ab-2026-10-08T09-29-04-342Z-8825a3/baseline.json` 与其 staged/unstaged patch；另有各域实施前快照、B7b 恢复基线和此前 accepted 证据。对比时分别注明：HEAD 中已有实现、B0ab 时已存在的工作区改动、后续各域增量、本阶段新增内容。快照缺失或来源不足的文件不得伪称有完整恢复来源。

## 2. 审查分工与具体步骤

1. 主代理冻结本阶段进入时的 HEAD、状态、当前改动文件和 SHA256，核对 B0ab 状态及各域恢复来源，形成可逐文件追踪的清单。只读读取不改变生产/out/native。
2. 窗口域审查 index 接线、工厂构造时机、Host/geometry、Blur/ZOrder、Dock、Drag、Presentation、Navigation、设置副作用和 capture 恢复。检查单一 owner、同窗口身份、代次、迟到事件、排队目标、timer/listener/native session 的终态。
3. 数据与生命周期域审查 bootstrap/shutdown、业务准入、feature/tray/activation/weather、完整 note/sticky 命令、DB/recovery/reset、Reminder 和 remote。沿真实调用方检查 clear/quit 排空、SQL/文件补偿、事务边界、提交后成功语义及旧持久化兼容。
4. Renderer 域审查 App/MonthApp、三个列表模型/query session、日历模型/preferences、设置队列/forms/sections、workspace/wallpaper/notices/update。检查 ref 连接、卸载、查询代次、响应顺序、错误反馈和产品差异。若修改界面或样式，先完整阅读 `docs/UI_DESIGN_STANDARD.md`。
5. 主代理审查 registry/selector/runner/adapters/build/provenance、入口、CI/release 和 Qt 单目标链。核对空选择/未知目标/错误角色拒绝、跨域显式门槛、失败与清理分开、旧证据隔离、构建复用证明和 Windows 子进程环境。
6. 每个候选问题必须给出当前文件与行号、完整触发路径、可观察影响、与基线的差别、最小修复及验收配方。静态担忧、未验证环境和已知历史风险单列，不能全部升级为缺陷。
7. 主代理交叉核实代理结论。成立问题先在本文件登记修复步骤与文件范围，再保存受影响文件的当前副本/哈希，实施最小修复，运行具体保护；无成立问题不为凑测试量重复运行此前有效专项。

## 3. 验证与停止条件

- 默认按本阶段实际修改文件和契约选择具体 Vitest 文件；涉及 Electron/真实窗口/DB/文件/native 必须补对应具体专项，其必要 build 可执行。
- 从第一条验证命令使用固定 Codex Node，并前置其目录、过滤 Volta。真实 Electron/native 从第一次就在合适的沙箱外环境运行。不得将 shell helper、缓存、DPAPI/GPU 启动阻塞记为业务失败或通过。
- 保留首失败、修复前后证据、退出码、业务完成、证据和清理状态。复用已有结果须核对消费源未变；不得仅凭早先测试通过证明本次修改。
- 跨域影响不明确时说明具体风险和建议范围，不自动升级全量；原生闭包未证实时不签发 reuse 证书、不裁减 requires。
- 无可触发路径的问题作为待调查项；缺环境的验证保持未覆盖。不得用本轮 fresh 成功解释旧 `Overlay zOrderSynchronized=false` 的根因。

## 4. 修复与回退方法

修复仅限成立问题直接涉及的 owner、调用方和有效保护；不顺带改产品策略、public schema、ABI、数据格式或 UI 样式。各域修改前保存本阶段文件快照和 SHA256，再记录与进入时版本的精确差异。

需要回退时恢复本阶段受影响的一组代码/测试/入口，并重新建立消费该源的 out 或平台产物。不得 `reset/clean` 全库，不覆盖原有 dirty、用户数据库或已经新增的数据，不删除失败证据。这里只读/文档结果无需回退产品代码。

## 5. 实际审查结果

本阶段核对进入时200份 dirty 文件与各域来源，按窗口、数据/生命周期、Renderer、测试基础设施四条链审查实际调用方和终态。数据代理完整阅读34份源码并单列聚焦读取；Renderer代理完整阅读23份文件并单列辅助契约；窗口域核对接线、owner与基线函数，100项启发式比较中67项匹配、33项人工核对，不作为语义等价证明。具体清单见 `data-review.json`、`renderer-review.json`、`windows-review.md`、`windows-function-comparison.json`，均位于 `tmp/integration-review/`；其中早期报告的待修状态按本文件最终结果收口，不改写原报告。

334份源码完成最终语法、字面依赖和哈希核对；287项资产登记无错误，69项 reviewed 保护范围保持其审查语义，未审资产不批量认证。此阶段不是对全项目每处实现或所有动态路径的语义证明。B0ab没有完整production源码副本，来源依据初始Git状态/HEAD及各域快照，不伪称全部源码都可从B0副本恢复。

| 编号 | 分类 | 最终结果 |
|---|---|---|
| I-001 | B6a迁移回归 | 日常总数ref的model导出与consumer解构已补，真实标题总数正确 |
| I-002 | 测试缺陷 | 分别校验win32/darwin规划职责，finally恢复平台属性；未放宽Windows adapter限制 |
| I-003 | 基线继承缺陷 | compact/busy恢复交由Presentation；保留expanded几何、用户尺寸、hidden状态并处理过渡后复核 |
| I-004 | 基线继承缺陷 | 全部恢复分支settle后才离开启动阶段，真实DB关闭等待延迟恢复SQL完成 |
| I-005 | 基线继承缺陷 | 按<=100条分批收齐原已浏览范围，全部成功且token有效后一次提交，失败保持旧快照 |

此前27子批完成状态保持，其含义仍为约定迁移和具体局部验收，不代表全部历史测试或发布就绪。本阶段具体变更和结果与此前版本分开列明。

### I-001：自定义列表日常总数漏接（迁移回归，已验证）

当前 `NoteList.vue` 模板仍读取 `customNormalTotal`，迁移后的 consumer 未解构此 ref，`useCustomListModel.js` 也未导出。日常分组总数显示为空，Vue 开发模式报属性未定义。B6a 迁移前有有效 ref。证据：`tmp/integration-review/renderer-template-bindings.json`。

修改范围：`useCustomListModel.js`、`NoteList.vue`、`tests/custom-list-model.test.js`、`tests/note-list-custom-electron.mjs`。步骤：模型导出 readonly 的既有 total ref，组件解构连接；在现有分页契约检查 total，在真实自定义页面断言日常标题与实际总数一致。先保存这四文件本阶段快照；完整阅读 UI 标准，保持样式/文案策略不变。运行具体 custom model unit 及 custom app 专项；后者需要重建最新 app。

### I-002：CI 单元测试错误要求所有平台可运行 Windows adapter（测试缺陷，已验证）

`tests/ci-test-selection.test.js` 的实际 registry 验证把所有已审 Windows Electron 目标要求为 `!executionBlock`，但 `createFocusedPlan` 正确地根据实际平台阻断 Windows adapter。因此 macOS CI 选择该 unit 时会出现环境职责导致的错误失败；不能据此判产品失败。

修改范围：仅该测试文件。步骤：保留每条真实登记目标、role、数量和精确选择校验；分别在同步受控 win32/darwin 规划中断言 Vitest 可执行、Windows adapter 在 Windows 可执行并在 macOS 明确阻断，规划结束恢复平台属性。先以只读受控规划复现现有断言为假，再保存文件快照、修改测试并运行该具体文件。不得修改生产平台限制、拓宽 macOS native 支持或运行云端 CI。此验证只能证明选择/阻断协议，不代表真实 macOS Electron 通过。

### I-003：compact 状态的恢复事件被 Dock 写回 expanded 尺寸（基线继承缺陷，已验证）

Dock 的 display topology handler 没有 compact 状态分流；resume/unlock 也调用它。Presentation 进入 compact 时保留 expanded stable bounds，handler 将其直接写回窗口，controller 仍为 compact，程序 resize 还可能被保存成 compact size。B4a 前 index 中已有同一路径，不能归为本轮引入。

修复步骤：核对现有 compact 几何 owner 的屏幕可见性修正和调用方，确定最窄的分流方案；Dock 不得在 compact 状态用 expanded stable bounds 改窗口。修复前追加具体文件、消费者和验证配方，保存快照；验证需覆盖正常 expanded 恢复、compact 尺寸和模式、随后正常退出 compact，以及无效/已销毁窗口。真实窗口局部验证受控触发 topology/resume handler，不宣称实际多屏、混合 DPI 或物理睡眠恢复已验。

具体修改配方：Dock 在 compact 或 Presentation busy 状态调用 Presentation 的窄 topology port；Presentation 读取真实 compact bounds 并按新工作区约束，不读取 expanded stable 来设置 compact 窗口、不唤醒隐藏窗口，不把程序约束引起的 resize 回声写为 compact 用户偏好。busy 期间合并最新事件，在当前操作 settle 后重新核对窗口/退出/模式；若最终 expanded，交回 Dock 的原有 expanded 流程。release/shutdown 清掉待恢复 ticket。窗口代理修改 `dock-runtime.js`、`presentation-runtime.js`、现有两者 unit 和 `presentation-mode-electron.mjs`；主代理最后串行修改 index 的惰性端口接线。相关测试只增加恢复路径断言，包含过渡中事件、迟到/销毁、hidden、用户 resize 与自动 resize 区别、expanded 恢复保持。

### I-004：一个存储恢复分支失败后未等待其他分支（基线继承缺陷，已验证）

`index.js` 的 storage-recovery 使用 `Promise.all`。一个分支提前失败时 catch 继续启动，但其他恢复分支仍可在 await 后查询 DB 或操作文件；startup promise 已 settle，退出协调不能再等待它们。受控生产 Bootstrap/Shutdown 调度已观测数据库关闭后仍有 sibling continuation：`tmp/integration-review/storage-first-rejection-proof.json`。本证据模拟恢复端口，没有真实 Electron/DB 结论；B3d 前 index 有同一结构。

修改范围：`application/bootstrap.js` 增加窄的恢复集合 settlement helper；index 使用它等待两个恢复 callback 全部 settle 后才按原 catch/继续启动策略处理失败；在 `tests/application-lifecycle.test.js` 的现有准入/退出契约补一支先失败、另一支延迟、快速退出，以及多个失败和同步抛错保护。helper 不新建资源 owner，不更改失败后继续启动的产品策略。保持 `checkStartup()` 在 catch 后阻止退出期进一步启动。先保存各文件快照，受控红/绿确认完整排空；随后在现有 lifecycle 专项保留普通两场景并补第三个失败恢复child验真实接线。所有 index 修改由主代理顺序落盘，避免与窗口接线编辑冲突。

真实验证追加于现有 `tests/application-lifecycle-electron.mjs`：保留 normal/reentrant 两进程场景，新增 recovery-failure 独立 child；在载入生产 out 前包装 filesystem 调度，一支注入一次 EACCES，另一支等待后放行原始 readdir。SQLite prepare/close 包装只记顺序并执行原实现；在 pending 期间请求退出，断言 DB 未关闭/窗口未创建，放行后的真实恢复 SQL 先于真实 DB close，退出后重开检查 integrity 和最终日志。模拟仅限故障/调度，不能称物理磁盘异常或任意崩溃均已覆盖。

本阶段最终专项明确选择四个既有文件：custom list、presentation、Dock runtime、application lifecycle。它们分别对应本阶段实际改变的列表、窗口恢复和启动排空契约；共用一次最新 app 构建，桌面顺序运行，所选 registry 的必要 capture/native 前置不得裁减。无新影响证据时不重跑其他阶段已完成专项。

真实专项首 attempt `tmp/test-runs/2026-10-09T05-34-50-933Z-fzSX1Z`：新 app build 和 Dock/custom/Presentation 均 accepted。lifecycle 已 recorded 57/57、raw0/completed=true，但三进程报告 mode 与 runner 旧 two-process 不一致，因此 accepted=false/unverified；该 attempt 总体5jobs/4accepted/1unverified、exit1，原结果保留。追加修改范围仅 `scripts/run-focused-tests.cjs` 的 lifecycle expected mode 同步为 three-process，保存该脚本快照，运行 focused/adapter 两个具体基础设施 unit 和严格 lint，然后正式 `reuse-verified` 核对未变化 app 来源、只复跑 lifecycle。不得把单项修复写回原 attempt 或复跑已有效通过的另外三个专项。

单项复跑 `tmp/test-runs/2026-10-09T05-40-43-931Z-WcRLiC` 在业务执行前被 `BUILD_STATE_CHANGED` 正确拒绝，lifecycle 为 blocked，整体 exit1，原结果保留。核对旧证明与当前状态，环境摘要相同、声明输出 hash 未变；观测到的唯一输入变化是基础设施 Vitest 写入的 `node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json`，见 `tmp/integration-review/lifecycle-protocol-fix/reuse-drift-observation.json`。当时决定按默认 rebuild 重新建立 app 来源，只运行 lifecycle；不还原缓存、不缩小构建依赖、不手签证明。随后两次声明产物及生产源完全一致，保留另三个已 accepted 专项，不重复运行 unit 污染新构建状态。

### I-005：自定义刷新超过100条后丢失已浏览范围（基线继承缺陷，已验证）

模型用已加载 offset 作为单次 anchored refresh 的 limit，而生产 DB 单次查询上限为100；加载120条后刷新实际提交100条，末尾20条及阅读锚点丢失。使用实际模型与生产 `normalizeQueryLimit` 的受控 adapter 已复现：`tmp/integration-review/renderer-custom-range-reproduction.json`。B6a 前 NoteList 也有相同实现，非迁移引入；不是实际 DB/GUI 证据。

修改范围仍限 I-001 的 custom model、现有 custom unit/真实专项；不改 DB 上限或公共 schema。步骤：按单页不超过100查询原已加载范围，持同一 QuerySession token，在全部页成功且 token 当前时一次提交；任一页失败或迟到则保持原快照，total 缩小时按新实际范围结束。补 >100、第二页失败、迟到失效和总数缩水契约；真实自定义专项增加 >100条的滚动加载、刷新与末尾/标题检查。保存 I-001 后单独快照，先红后绿，最后使用统一新 build 运行该具体专项，不自动扩大其他列表回归。

## 6. 最终验收、准确增量与剩余工作

### 6.1 本阶段实际文件范围

与进入时 `entry-inventory.json` 的逐文件SHA比较，本阶段变化共18份文件；不是将仓库全部200份dirty归为本阶段。`tmp/`中快照、只读辅助脚本和运行证据另行保留，不计入生产/测试增量。

| 类型 | 实际变化 |
|---|---|
| 6个生产文件 | `src/main/index.js`、`src/main/application/bootstrap.js`、`src/main/window-motion/dock-runtime.js`、`src/main/windows/presentation-runtime.js`、`src/renderer/src/components/list/NoteList.vue`、`src/renderer/src/composables/useCustomListModel.js` |
| 8个测试文件 | `tests/application-lifecycle-electron.mjs`、`tests/application-lifecycle.test.js`、`tests/ci-test-selection.test.js`、`tests/custom-list-model.test.js`、`tests/dock-runtime.test.js`、`tests/note-list-custom-electron.mjs`、`tests/presentation-runtime.test.js`、`tests/presentation-mode-electron.mjs` |
| 1个运行脚本 | `scripts/run-focused-tests.cjs`：仅同步lifecycle三进程报告mode |
| 3份阶段文档 | 本文件、同目录 `README.md` 与 `04-implementation-plan.md` §26 |

未改public schema、数据库单页上限、native ABI18、DLL、产品文案或UI样式。Renderer代理完整读取UI标准，补ref与列表模型仍按既有样式呈现。未删除有效旧测试。代码/测试回退优先按§4及本阶段各域快照成组恢复，不恢复全库或用户数据。

### 6.2 实际局部测试与必要构建

七个具体unit文件 **75/75**：application-lifecycle12、ci-test-selection14、custom-list-model14、dock-main-wiring8、dock-runtime7、presentation-mode-architecture9、presentation-runtime11。证据：`tmp/integration-review/final-seven-unit.json`。最后runner协议同步后，run-focused-tests与test-result-adapters两个具体unit **25/25**，证据：`lifecycle-protocol-fix/infra-unit.json`。两组文件不重叠；此前各域红/绿与这些结果重叠，不能累加为新覆盖。Git fixture的不存在commit和blocked build是预期基础设施分支，非产品失败。

最终lifecycle单项按默认rebuild运行：`tmp/test-runs/2026-10-09T05-46-03-610Z-5k7cva`。build-app输入/工具链闭包verified，两个job均accepted，整体exit0。lifecycle真实三child **57/57**，raw0、业务completed、evidence/script cleanup/runner cleanup均complete。故障场景pending时DB开、无窗口；放行原始readdir后的实际恢复SQL在DB close前；退出日志最终settlement complete，并重开实际磁盘DB检查integrity。仅EACCES与调度受控，不宣称真实硬盘损坏或任意崩溃覆盖。

| 专项文件 | accepted结果 | 证据attempt与本次覆盖 |
|---|---:|---|
| `tests/application-lifecycle-electron.mjs` | 57/57 | `05-46-03-610Z-5k7cva`，正常、重入、失败/延迟恢复退出 |
| `tests/dock-runtime-electron.mjs` | 38/38 | `05-34-50-933Z-fzSX1Z`，实际Dock/native及expanded恢复接线 |
| `tests/note-list-custom-electron.mjs` | 33/33 | 同首attempt，150总数/120已加载范围、100+20刷新、末尾/可见锚点/scrollTop/标题 |
| `tests/presentation-mode-electron.mjs` | 98/98 | 同首attempt，原compact契约及受控topology/resume后尺寸/模式/退出保持 |

表中短attempt均位于 `tmp/test-runs/2026-10-09T` 日期前缀下。四项均raw0/accepted、业务/证据/脚本及runner清理完整；首attempt总体仍exit1/一项unverified，不改写为整体通过。

新旧构建证明：`tmp/test-build-proofs/build-app/0001791524161448/proof.json` 与 `0001791524828680/proof.json`。40条声明输出记录逐项相同，构建mode/工具链相同，输入差异仅上述Vitest缓存；当前非依赖树产品/配置/资源输入、当前out与最终证明匹配。首attempt消费源唯一变化为runner mode同步，三个保留专项的脚本、产品源码和依赖消费者hash未变；最终attempt消费源无变化。因此保留另外三个accepted结果，无需再跑它们或其他域。核对见 `tmp/integration-review/final-evidence-verification.json`，errors=[]。

最终15个可执行文件一次严格lint：exit0、0error/0warning，`tmp/integration-review/final-fifteen-lint.json`。源码审查334份、资产287/保护范围69、语法/字面import/registry错误和字面环均为空；唯一index消费者为顶层bootstrap。文档与27批表收尾核对、当前文件SHA和diff空白结果登记于 `tmp/integration-review/closeout.json`。这些静态结果不代替动态语义或平台验收。

可复核的单项命令（需合适的真实Windows桌面环境，禁止由此扩成全量）：

```powershell
$reviewNodeDir = 'C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin'
$env:PATH = $reviewNodeDir + ';' + (($env:PATH -split ';' | Where-Object { $_ -notmatch 'Volta' }) -join ';')
& (Join-Path $reviewNodeDir 'node.exe') scripts/run-focused-tests.cjs --file tests/application-lifecycle-electron.mjs
```

### 6.3 首次失败与剩余边界

各域首次红测试、协议不匹配unverified、构建reuse拒绝blocked及此前Overlay失败保留，不用最新成功覆盖。没有执行全量unit、窗口矩阵、Qt全集、云端CI、release quality、打包/安装/升级/卸载、macOS、客户机器、发布、部署、提交或推送。HEAD仍为本文件§1基线，分支main。

后续优先级与实施方法：

1. **Overlay偶发 `zOrderSynchronized=false`**：先以实际native requested/enabled/anchored状态和事件序列建立可复现路径，区分时序、窗口身份与系统层级干扰；保存失败日志再确定最小修复。fresh通过不解释旧失败，当前根因未解决。
2. **Windows真实环境专项**：按既有窗口指导分别验证多屏/负坐标/混合DPI、真实睡眠与解锁、Explorer重启、真实输入；每次只选相关文件与必要构建。当前恢复事件受控触发不能替代物理设备/电源恢复。
3. **剩余产品平台链**：真实截图指针/剪贴板、toast关联与冷启、安装重启、外网天气/更新及客户机独立验收。当前synthetic/IPC/系统transport fixture的边界保持，不改记已通过。
4. **自定义分页一致性**：当前单次刷新各页没有DB事务快照保证，并发增删或重排可能产生跨页变化；先确认产品对并发排序的一致性要求，再决定是否采用revision/cursor或DB快照，不能无证据扩大成当前已修的范围丢失缺陷。

约定测试、解耦、审查及最终集成阶段至此完成。后续任务围绕以上具体风险单独确定契约、指导、复现和局部验收，不能自动升级全量或推导发布就绪。
