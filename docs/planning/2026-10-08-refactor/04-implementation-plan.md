# 重构实施汇总与分批执行指导

版本：v3，2026-10-09；保留原 S4、暂停与各实施阶段记录。

阶段：全部批次准备、明确授权后实施与局部验收结案；最新27子批状态见 §25，历史实施/暂停证据见 §20–§24。

状态：B0–B7共27子批的指导、约定迁移、审查修复和指定局部门槛均已完成。用户在准备完成后明确授权连续实施，真实结果、首失败及剩余边界逐项记录于§25。自动审批的历史暂停见§24，不再是当前阻塞；未执行全量回归、打包/安装/发布/部署，不声称发布就绪。

阶段索引：[README.md](README.md)

前置指导：[测试](01-testing-guide.md)、[解耦](02-decoupling-guide.md)、[审查](03-review-guide.md)

## 1. 基线、范围与本轮交付

本轮 HEAD：`4fbc52be1c688dba9cf23fbbd51539606efbf381`。

本轮开始已有准备文件变化：README.md 为修改状态，03-review-guide.md 为未跟踪状态，均来自上一阶段；不把它们算作本轮业务改动。实施前重新记录实际 HEAD/分支/staged/unstaged/untracked/deleted、源码与产物，不能仅使用提交号代表整个工作区。

本轮由主代理统筹，三个子代理只读核对测试依赖、解耦顺序、风险/产品规则；主代理复核关键源码并统一写文档。没有并行编辑生产文件，没有运行测试、lint、构建、Electron、Qt、打包、安装或发布。

本指导将 12 个 T、12 个 D、16 个 R、13 个 C 契约汇总为 B0–B7 大批次及具体子批次。编号继承 S2；子批次的文件、消费者、步骤、保护和停止条件在下文明确。

本节“本轮”记录原 S4 准备交付：只写本指导、更新阶段索引并补充 S3 同日只读结论，不删除/生成测试、不修改业务/配置/构建/CI。随后用户已明确进入 S5，新增的实际范围与结果见 §20，历史准备记录保留。

仓库根：`C:/addFile/idea/项目/abandon/abandon_note2`；下文源码路径相对该根。拟新增路径是实施目标，是否已创建以 §20/§21 实际批次为准。若某模块只增加无意义透传，保留编号并记录合并/取消理由。

## 2. 已确定的实施原则与冲突处理

### 2.1 可以直接确定的决策

1. **不先删除全部测试。** T-006 贯穿各业务批次：确定契约/独立预期 → 验收现有或建立必要替代保护 → 改代码 → 迁移有效断言 → 按理由删重复/无效项。已废弃且确无保护价值的项可单独处置，但仍要有恢复来源。
2. **先建立可信选择、结果和依赖，再依赖它们验收迁移。** 首批不是运行全库测试。高风险保护只在所要迁移的域内核查，T-007/008/009/010 不作为所有功能一次执行清单。
3. **结构迁移与成立的缺陷修复分开记录。** 默认保留行为；待复现风险先核查/复现，成立才插入最小修复子批次，再继续迁移。没有确认的预期不得写成新测试事实。
4. **状态移交只有一个写入者。** 新模块接管值/版本/计时器/监听时，所有旧写点一起移交；旧入口仅委托或只读查询，不保留另一份可写镜像。
5. **完整操作不按文件拆碎。** SQL、文件提交/补偿、轮次/版本、成功结果和失败语义要保持闭合；SQLite 同步事务内不加入 await。
6. **接口先于迁移，暂委托解除前置循环。** settings/window/dock/blur/navigation 通过已登记窄接口连接；不要求 D-003/004/005/006 全部完成才能开始其中任何一项。
7. **消费者与入口同步修改。** test 默认参数、CI、README、manifest、source-read 断言；IPC/preload；DB facade；native ABI/产物必须同步接线。保留有效保护，避免中间提交失效。
8. **局部验证和运行前置明确。** 小改动不默认全量；构建输入和运行时依赖分开，源码检查、内存 DB、同进程重载不扩大为真实重启/原生/安装结论。
9. **产品选择冻结。** 单主窗口 list/month/week、周模式复用、compact 尺寸持久化、快捷键 session-only、草稿同进程会话、历史模板跳过、提醒轮次、首次使用/捐赠/统计/更新策略保留。
10. **规范整理附着本批文件。** 不附带全库格式化、框架/语言/状态库迁移、完整备份恢复功能、远程部署或平台发布。

### 2.2 三阶段间的具体衔接

| 衔接问题 | 汇总决策 |
|---|---|
| S1 先做 T-011，或等全部改完才碰 CI | 选择器/结果/依赖先稳定；改变 npm test 默认语义的同一子批同步 ci/release 调用。普通 CI 按真实变更选择，发布职责独立保留；后续仅完善映射，不留下暂时失效的 workflow |
| S2 B1 写入牵动 window/blur/dock | B1 先 repository/读值/快照；旧 persist 协调完整保留，B4f 再收敛副作用和背景写入，不能提前拆成互不知情的写入服务 |
| Host 抽出却保留 index.mainWindow | 要么先抽无状态工厂并明确 index 仍是唯一所有者，要么完整移交 current window 所有赋值/身份/释放；不允许两份可写 mainWindow |
| SettingsRuntime 与入口同时保存 resolvedSettings/revision | 同样分纯计算与完整所有权移交；旧读路径迁到只读查询，旧写路径统一委托，不能双缓存写入 |
| B4 多项相互调用 | 按 native 叶能力 → Dock → drag → Presentation → Navigation → Background 迁移；未迁能力由窄旧端口提供，不反向 import 入口 |
| T-006/T-012 被当作最后一次统一清理 | 每个子批同步测试处置/文档/结果；B7 只撤除全部消费者已迁移的兼容入口 |
| 把所有 R 都当缺陷改 | R 中同时含既有保护、结构建议、条件式风险和产品规则；各自沿不同决策路径处理 |
| “减少 native 构建”被理解成不需要 DLL/helper | 真实应用仍需实际启动路径的运行前置；只减少无关重编译，来源未知/缺失产物不得通过 |

## 3. 风险与产品规则决策表

所有条目状态为“方案已确定，实际验证待执行”。Q 用于本指导的决策，不是新增的缺陷级别；对应 R/T/D 保持原编号。

| 决策 | 当前证据与默认行为 | 后续验证/修改条件 | 对应批次 |
|---|---|---|---|
| Q-001 跨 scope 写入/重置 | persistSettingValues 分 view→application 提交；核对当前多项调用未发现混 scope。reset 实际是 application→当前 view 两步，各 scope 内部有事务 | 首先验证 reset 第二步失败及 timer/dirty/runtime/UI 状态。只有确认复合操作需要全成全败且风险成立，才增加同连接复合事务；不误改同 scope wallpaper 互斥保护 | B1、B5b、B6c；R-003/C-003 |
| Q-002 remote 启动中退出 | health/补报等待时可能尚无 session；退出按 active session 进入 stop。stop 先持久排队，再等 sessionStartPromise；1600ms race 不是取消 | 分 health 中退出和 session-start 中退出复现；断言退出后不新开会话/不访问已关 DB/补报资料保留。成立后给拥有者加 gate/generation/取消，保留有界退出 | B3d/B7a；R-007/C-010/C-013 |
| Q-003 日志最终确认 | before-quit 末段发起 flushLogs，无显式退出完成等待；writer 已有 sequence/timeout/incomplete | 定向验证最后记录和真实两轮进程；若需调整，确认有界等待/不完整报告规则，不无限等待、不预判必丢日志 | B0c/B3d/B7a；R-007/R-014 |
| Q-004 月周 clear/remount 旧结果 | clear-note-data → __clearEditingDrafts → editingDataGeneration++ → MonthWorkspace key 重建可达；卸载释放监听但未统一递增查询/天气序号，await 后仍 emit ready | 优先复现慢月周/天气→清空→旧实例返回，验证旧 ready/DOM/焦点/新状态。确认错误后先局部生命周期修复，再抽模型 | B2b/B5b/B6b；R-004/R-011/C-004/C-009 |
| Q-005 根页面 ready/生命周期 | 主进程已查 current sender/activeViewMode，视图切换复用窗口并整页导航；App/Month 片段缺 disposed 不直接证明泄漏 | 区分整页销毁、同 mode 重载、同文档组件重建；保留既有过滤，只有真实延续影响才修复 | B2b/B4e；R-008/R-011 |
| Q-006 视图和报表差异 | App 壁纸缓存/延迟释放及自动更新/最短展示，与 Month 策略不同；日报导出是在 save dialog 前重新查询，并非直接复用 preview | 默认保留差异和点击导出时快照。若用户另要统一/改为落盘时最新，独立记录产品变更，不阻塞保持行为的迁移 | B2b/B6/R-013/R-014 |
| Q-007 安全/源码断言覆盖 | 有注释/内部名/CSS 精确断言，也有有效 CSP 保护。security-hardening 的 HTML 清单缺 reminder.html，而产品 reminder.html 已有严格 CSP | 逐条处置，不按 readFile 全删。同步登记五个 renderer HTML 入口与 main/sticky/reminder preload；需要触碰入口/安全保护时补该契约，不宣称产品 CSP 已失效 | B0b/B2a/B7b；R-010/R-016/C-012 |
| Q-008 提交与清理结果 | 壁纸 final-cleanup、附件清理和业务清空已有提交后恢复/延后清理保护；现有壁纸专项覆盖清理失败 | 保留，优先验全路径/中断/并发；有不同故障造成结果歧义才修复，不将所有 cleanup 异常改为业务失败 | B5/R-002 |
| Q-009 原生与交付 | blur ABI 18，桥接精确校验；capture 部署/helper/Job/协议已分层 | 结构抽取默认不改 C++/ABI；真实导出/运行语义变化时才单列同步版本/重建/包与桌面验证 | B0d/B4/B7/R-008/R-009/R-016 |

静态可达性支持设置复现门槛，不能代替业务失败证据。Q-001/Q-003/Q-006 的产品规则若未得到进一步要求，保持现行为并记录未覆盖边界；无须因此停止所有独立准备。确有风险而最小保护不足时，停止相关迁移子批，不扩大为全量。

## 4. 每批统一执行流程

S4 归档时确定 S5 依次做以下七步；最新实际进度见 §20：

1. **记录本批范围。** 确定子批次、实际文件/符号/消费者、基线、产品契约、T/D/R/C 和原有用户变化；只读核查相关完整路径，补覆盖账本。
2. **核验必要保护。** 阅读本批断言/独立预期；运行已有对应局部与必要集成。保护不足先补最小充分保护。基线失败分旧问题、环境和目标缺陷；不能预填通过。
3. **先处理成立的缺陷。** 在相应 Q/R 门槛成立时建业务失败复现，最小修复并验证；单独记录该行为变化。结构迁移随后以已确定行为为基线。
4. **迁移闭合职责。** 端口/旧委托先接通，state/timer/listener/waiter/revision/资源与操作一起迁移；平台/存储/接口及原始顺序保留。
5. **审查 diff 与消费者。** 检查唯一写入者、错误/取消/补偿、权限/DTO/单位、重复安装、source-read 断言、helper/manifest、测试/构建接线；不只看新模块。
6. **执行本批验证。** 精确选择文件/契约，实际依赖闭包、来源/ABI 和正确环境；复用构建有证明。执行前说明范围，之后记命令/退出/业务结果/证据/跳过与风险。
7. **结案与回退检查。** 本批满足验收才继续依赖批；同步 T-006/T-012 与指导状态。兼容委托仅在全部消费者完成、对应验证有效后撤除。

结构迁移的验收是契约保持、隐式依赖减少、资源和状态拥有者明确；不以文件数量、行数下降或新类数量衡量。若本批跨资源/原生/系统状态改变，相关平台证据是必需保护，不能用 mock 替代。

## 5. 测试选择、结果与构建的统一目标

### 5.1 目标入口与 CLI（均为后续拟实现）

拟新增：

- `scripts/test-selection.cjs`：纯选择/校验/去重/依赖解析，不能启动进程或写证据。
- `scripts/run-focused-tests.cjs`：计划与调度，复用 `scripts/test-runner.cjs` 的进程/隔离/证据能力，不另造测试引擎。
- `tests/test-selection.test.js`：有实际选择行为价值的保护；runner/manifest 的现有测试按需要扩展。

| 参数/入口 | 目标语义 |
|---|---|
| --file 路径 | 明确可执行测试文件，可重复；规范化为仓库内已登记文件，helper/fixture 拒绝 |
| --id ID | 明确任务 ID，可重复；不能把当前全 Vitest 的 unit ID当成一个局部文件 |
| --feature 名称 | 已登记常规契约集合，输出实际文件/证明边界；未映射失败，不按名字猜 |
| --source 路径 | 本批明确源码的候选分析，用 sourceDependencies/sourceReadDependencies/消费者提示；单独不构成可靠执行范围，先 --plan 再人工选定 file/id/feature |
| --plan | 严格只读：显示选择理由、去重、依赖、来源校验、环境和遗漏；不建运行目录、不测试、不构建、不启动 Electron |
| --build rebuild | 默认方式，仅重建已进入必要构建依赖闭包的任务；不因默认值加入全产品构建 |
| --build reuse-verified | 相关代码/配置/工具链/模式/产物/ABI 符合来源证明才复用；失败阻塞或建议必要重建，不能删除 requires |
| test:unit 后具体文件位置参数 | 兼容现有仓库用法；按登记 level/runtime 接受 Vitest 文件，当前配置允许 .test.js/.test.mjs/.test.ts；拒绝独立集成 MJS/Qt/helper 误送 Vitest |
| 无选择/未知/空匹配/无效路径 | 非零且不启动任何测试；不能 fallback all/window-frame。source+plan 有有效候选时允许只读计划；只有 source 且无 plan/file/id/feature 时不执行并提示；未知来源/无有效候选非零 |
| 全量 | 局部入口拒绝 --all；保留显式 full 入口并显示实际范围，只有用户明确要求全量/完整回归/发布验证才在本地执行 |

file/id/feature 的并集按稳定 ID 去重；level 限制不能把 file 交给错误 runtime。source-only 输出候选和未映射问题，不能自动含其他 dirty 文件，也不能以 related/changed 作为唯一推断。性能、大验收/窗口矩阵按契约需明确纳入，不让普通 feature 隐含整个广域组合。

改变 `npm test`/`test:unit`/`test:db` 的默认选择语义时，同时迁移 package、两个 runner、ci/release 调用与 README。保持不变的命令也需写清它实际是集合还是单项；拟用法必须等文件实现后才作为可执行说明。

### 5.2 结果协议

结果分别记录：

- 原始进程退出/launch/timeout，目标文件/契约及断言完成数量/模式。
- businessResult：通过/失败/未执行/未能证明；零退出且目标断言缺失、全部跳过不能记通过。
- evidenceResult：完整/缺失/收集失败；必需证据缺失与可选附件分开。
- cleanupResult：完成/失败/待恢复，只有本次拥有的目录/窗口/子进程。
- build/source/runtime 元数据、第一次失败与每次 attempt、环境阻塞和剩余风险。

名称是目标语义，具体字段以现有格式兼容扩展，不要求一次重写所有旧报告。runner 当前 passed 主要由退出 0 决定、缺 artifact 会跳过，summary 可能把证据/清理问题仍计为通过；未来需要明确汇总类别。旧脚本尚未迁移结果协议时标“结果完整度未核实”，保留其有效断言证据但不能自动作为新迁移完成门槛。

### 5.3 构建输入、运行前置与环境

| 场景 | 必要来源/构建 | 环境与不能证明的内容 |
|---|---|---|
| 纯规则/选择器/IPC wrapper 单元 | Node + 项目本地 Vitest；无应用/native 构建 | 不证明真实 SQL、跨进程或窗口效果 |
| 直接导入 DB 源码专项 | Electron as Node + vite-node/真实 SQLite；按实际脚本运行 | 内存库/serialize-reopen 不能证明磁盘/主进程重启；不误运行整个固定 DB 组 |
| 附件/壁纸存储专项 | 正常 Electron ready/nativeImage、真实文件，核对脚本 DB 模式 | 需要合适环境；现有部分是内存 DB + 文件，不声明两轮进程恢复 |
| 独立 Chromium fixture | renderer/fixture 的实际构建和 preload | 只测该 fixture；不由 fixture 启动成功推断完整主应用前置 |
| 真实主应用窗口 | app out/入口、当前 native gate 和 capture 装配的实际运行依赖 | 当前会创建/prewarm capture helper；不能直接移除 blur/capture 部署前置 |
| CaptureHost | 当前源码 + deployed helper/host DLL/Qt 运行库/协议 | 没 BrowserWindow 也实际起 native helper；不等同纯 mock |
| capture-lifecycle | 直接导入当前 CaptureHost 源码 + deployed helper/Qt 部署，不消费 app out | 使用真实桌面/overlay，helper/资源终态按本场景验证；无需无关应用构建 |
| capture-business | app out + 实际 native engine ready/部署，真实输入还需匹配 input driver | 模拟业务交付仍先等待真实 engine ready；模拟/真实输入分列 |
| Qt 程序 | 测试目标开关、选中的 CTest/输入驱动，产品部署仍独立 | 严格名称/匹配数；没有匹配不是通过，普通构建不编译全部七程序 |
| 安装/包 | 明确所需产品/依赖/ABI/ASAR/worker/plugin/licenses | --publish never；目录包不是升级/卸载，当前不执行 |

每项登记 `buildInputs` 与 `runtimePrerequisites`。所改源码需要消费新构建时产生构建任务；未变 native/Qt 可以作为经来源校验的运行前置，不重复编译。缺失/来源不明/ABI 不符的前置不能省略，选择必要重建或记录阻塞，不关闭 native gate。

真实 Electron/Chromium/GPU/DPAPI/层级/拖动/系统通知/原生 helper 从第一次就在合适的沙箱外环境执行，按 AGENTS.md 请求权限。普通 Node 验证使用指定 runtime 并确保子进程 PATH 避免 Volta；不先制造已知环境失败。必要构建不算全量，默认精确测试不授权打包/安装/发布。

## 6. 批次总表与依赖

| 大批次 | 子批次与内容 | 必要前置 | 对应 S2 |
|---|---|---|---|
| B0 | a 基线/契约/端口；b 登记/纯选择；c 结果/调度；d 构建选择、入口/CI同步 | 准备阶段完成，进入 S5 的本批范围明确 | 扩展 B0，纳入 T-001..005/T-011 |
| B1 | a settings repository；b settings 读取/快照/唯一状态；c 保留写协调并改窄接线 | B0；本域 R-001/R-003 与 C-003 保护 | B1 |
| B2 | a 简单 IPC；b App/Month 共用 runtime 小步抽取 | B0；对应权限/生命周期保护；共享设置接线需 B1 | B2 |
| B3 | a host；b geometry；c DB runtime；d bootstrap/shutdown | B1；对应窗口/数据/退出保护 | B3 |
| B4 | a native leaf；b dock；c drag；d presentation；e navigation；f background/settings 完整协调 | B3 host/geometry；本域保护；按下文窄端口解除循环 | 展开 B4 |
| B5 | a note commands；b recovery/business reset | B0/B1；C-001/002/004/006 相关保护；连接生命周期改动需要 B3c | B5，可独立于未改窗口域安排 |
| B6 | a timeline/custom/tag；b calendar；c setting queue；d form/sections | B0/B1/B2 对应接口；R-011/R-012 和必要 UI/数据保护 | 展开 B6 |
| B7 | a feature/tray/notification/capture 集成与 sticky 完整命令；b 清理兼容、测试处置与接线完成 | 已迁对应状态域并验证；未改功能通过旧窄委托接入 | B7 |

默认沿 B0→B1→B2→B3→B4→B5→B6→B7 安排。B5 或 B6 的独立子域可在其列明前置满足后提前，但修改 index/共享协议的接线仍串行。不能把大批次看成一次巨大 diff；每个子批可独立审查/验收/回退。

默认子批路线如下，列出的边用于顺序与门槛追踪，不表示新增模块必须相互 import。B7a 的独立集成、B6 的独立模型可按其实际端口与消费者拆开提前；解除默认顺序边时记录理由和必要保护，不能跳过真实依赖。B5b 若改连接生命周期，另需 B3c。

| 子批 | 默认前置 |
|---|---|
| B0a | 无，进入 S5 后记录当前基线 |
| B0b | B0a |
| B0c | B0b |
| B0d | B0c |
| B1a | B0d |
| B1b | B1a |
| B1c | B1b |
| B2a | B0d |
| B2b | B0d、B1b |
| B3a | B1c |
| B3b | B3a |
| B3c | B1a |
| B3d | B3a、B3b、B3c |
| B4a | B3a、B3b、B1c |
| B4b | B4a |
| B4c | B4b |
| B4d | B4c |
| B4e | B4d |
| B4f | B4a、B4e、B1c |
| B5a | B0d、B1c |
| B5b | B5a |
| B6a | B0d、B1c、B2b |
| B6b | B0d、B1c、B2b |
| B6c | B0d、B1c、B2b |
| B6d | B6c |
| B7a | B3d、B4f、B5b、B6d |
| B7b | B7a、B6a、B6b |

## 7. B0：先建立可恢复、可信的实施入口

### B0a：基线、契约和所有权账本

**文件：** 本组指导、当前拟改文件/脚本/fixture；D-001 的状态/端口登记。对应 T-001/T-002/T-012、D-001、R-015/R-016。

**步骤：**

1. 保存本批实际 staged/unstaged/untracked/deleted 内容、manifest/构建来源与恢复样本；现有 checkpoint 已存在，不因此自动提交/推送。
2. 登记产品契约、状态唯一写入者、读/命令/事务端口、消费者和撤兼容条件。测试与产物基线注明未运行/未知，不沿用历史通过。
3. 只核查下一子批相关完整链路；所有未读/未验证分支保留账本。既有 styled-select-menu.test.js 删除为用户历史基线，不新计/擅自恢复。
4. 隔离数据和目录所有权；保护原用户变化，恢复样本不覆盖当前 checkout。

**验收/回退：** 本批可恢复、范围与前置可解释；撤回本批登记/快照，不回退其他用户变化。不满足时暂停依赖迁移。

### B0b：统一登记和纯选择

**现有/拟新增：** scripts/test-manifest.cjs、tests/test-manifest.test.js；拟 test-selection.cjs/test-selection.test.js；vitest.config.mjs 仅确需接线时修改。

**步骤：**

1. 登记 S1 资产的 runnable/helper/fixture/native 角色、level/runtime、契约/独立预期、源码读取依赖与 requires；未核查语义明示，不猜耗时。
2. 保持旧分组导出兼容，逐步由统一登记派生；每个 Vitest 文件成为可选择单位，不能仅保留“unit 全部”任务。
3. 实现 §5.1 的纯选择，重复去重/无匹配失败/level/仓库路径/辅助项拒绝/source 候选；不启动进程。
4. 完整性覆盖缺项/重复/无效/循环依赖；安全入口矩阵纳入 reminder.html，产品 CSP 不变。

**验证：** 未来仅运行 test-manifest.test.js、拟 test-selection.test.js 的实际用例；确认选择一个 DB/GUI 文件不带合集，空参数无作业。T-002/T-003、R-010/R-016。

**验收/回退：** 选择可解释，元数据不足明确报告；登记/旧导出/选择器消费者成组回退，保护既有资产。

### B0c：结果协议和局部调度

**现有/拟新增：** test-runner.cjs、test-runner.test.js、full runner 结果消费者、storage 两包装脚本；拟 run-focused-tests.cjs，必要的结构化结果 adapter。

**步骤：**

1. 先保留子进程/timeout/隔离/诊断收集/首次失败，再扩展 §5.2；运行器、汇总和依赖阻塞同时消费明确结果。
2. Vitest/DB/存储/native 各按实际输出证明目标断言完成；按域逐步迁移，不给旧脚本凭空赋 assertions count。
3. focused 调度按选择+依赖闭包执行，未选构建仍保留为依赖/来源校验；首次失败/缺证据/清理结果分开。
4. storage 保留正常 Electron ready/nativeImage；只清测试自己拥有的资源，清理前交付当前 attempt 证据。
5. --plan 的无目录/无构建/无进程保证有必要行为保护；测试 runner 用受控小型 fixture 验失败/超时/环境/缺断言，不运行整个业务库。

**验证：** test-runner.test.js 及选择/adapter 的必要用例。T-005、R-014/R-016/C-013。

**验收/回退：** 零退出无断言不计业务通过，首失败和 incomplete 可追溯；保持旧报告兼容，runner/consumer/adapter 同步回退，不覆盖历史证据。

### B0d：构建/Qt 选择与默认入口、CI 一起接通

**文件：** package.json、node/window/storage/full 包装与 focused/selector、native_capture/CMakeLists.txt/build.ps1、必要构建脚本、.github/workflows/ci.yml/release.yml、README.md/docs/testing/README.md。

**步骤：**

1. 按 §5.3 分 build/runtime 前置并校验来源；保留完整产品构建，拆 blur/capture/Qt 测试需要，修复 full selected-retest 删除 requires 的逻辑。
2. Qt Test/测试 targets/add_test/输出 target list/input driver 条件化；每次 build.ps1 显式开关消除 CMake 缓存残留。普通部署运行库/插件/许可证不消失。
3. Qt 仅按明确 CTest 名称执行，零匹配/缺结果非通过；测试开关开/关与选一项独立验证，不能顺带七项全部执行。
4. 然后同步改变默认测试选择入口、DB单文件/GUI明确选择与 CI/README 用法；不要先提交 package 拒绝空参，下一批才修 workflow。
5. 普通 CI 用本次提交/PR 的明确变更基线和 source-read/人工 feature 映射，空变更与未映射分开；不可假设本地有完整 Git 历史。未映射失败并报告，不 fallback all。
6. release workflow 的发布职责/显式验证不删；其调用改为明确范围/专门入口，不拿普通 CI 缩范围取消发布必要保护。当前无 CI/发布执行授权。
7. lint:tests 等显式文件列表同步包含新脚本，不实施全库 format。

**验证：** selector/runner/manifest、package-native-config.test.js，必要 CMake/选定 Qt/部署来源验证；只选本批边界。T-003/T-004/T-011/T-012、R-016/C-008/C-012。

**验收/回退：** 空参数零测试且非零、单项不带合集；CI 无失联调用；未改 native 不误重编译、未知前置不静默忽略。package/runner/CI/README/build/config 同批恢复，原生产物恢复其对应版本。

## 8. B1：设置存储、快照与单一状态归属

**范围/前置：** B0；T-007/C-003、本批 R-001/R-003/R-015；application-settings/schema 单元不能替代真实 SQLite，先核查需补的 SQL/scope/重开保护。

### B1a：窄 settings repository

现有 db/db.js、db-connection.js、settings/application-settings.js；拟 db/db-settings-repository.js。将 getAllSettings/setSettingsBatch/clearSettings 等迁移到同一连接，db.js 暂 re-export；application-settings 改窄 import。新模块不反向依赖 facade，所有旧 DB 业务模块仍取得同一 connection。

验证当前相关 application-settings.test.js、settings-schema.test.js，并为真实主键/SQL/事务/磁盘契约使用相应局部真实 SQLite 保护。完成时 ID/键/scope/schema/返回兼容，无第二连接。回退 repository/facade/import/mock 定位一起恢复。

### B1b：读值/快照与完整所有权移交

现有 index 的 refreshResolvedSettings/getSnapshot、application-settings/schema 与 runtime providers；拟 settings/settings-runtime.js。先拆纯组装函数，再一次移交 resolvedSettings/settingsRevision 的全部写点；入口消费者使用只读值/快照，旧 refresh 名称仅委托与协调原副作用。

refresh 当前还同步 blur 配置/截图主题；本子批把实际顺序登记并通过窄适配保持。runtime provider 只读有效状态，不自行启动平台服务。application/view/session/default/revision 与 runtime 字段保持，shortcuts.enabled 继续会话状态。

验证 schema/application settings、实际相关快照/跨页面与 SQLite 契约。验收没有双写缓存、初始化/广播回填不变。回退 runtime、所有写点、providers 和消费者共同恢复。

### B1c：先保留完整写协调，完成窄接线

persistSettingValues 暂作为入口完整协调：验证/序列化→scope SQL→refresh→window/blur/dock→snapshot/broadcast。将读/写口接 B1a/b，不把三个副作用分别移给无协调者的模块；B4f 再整体迁入协调层。

Q-001 只作条件式分支，默认不附带改跨 scope 或重置语义。当前 wall/blur 同 scope 原子组不拆。完成时 B1 所需消费者均兼容，旧写协调只有一份。回退窄接口与完整协调共同恢复，不换 schema/用户路径。

## 9. B2：简单传输入口和 renderer 公共能力

### B2a：简单 IPC 注册

**文件：** index.js、ipc-authorization/logging wrapper、preload/index.js 的消费者；拟 ipc/register-app-ipc.js 及有明确闭合职责的 settings/window/remote 注册模块。不是一次抽全部 IPC。

**步骤：** 冻结通道/payload/结果/sender/广播与 action；先迁 app-info/update 等简单注册，复杂 diagnostics/窗口/background 保持现有 coordinator。每注册返回自己的 dispose，不能 removeAllListeners；preload 暂只改内部接线，保持有限 API。

**保护/验收：** ipc-authorization/ipc-arguments/app-update 的对应文件，相关真实跨进程契约。T-006/T-010、D-007、R-010/R-013/R-014/C-010/C-012。无双注册、旧 sender 只读例外不扩大为写权限，五 HTML/三 preload 权限矩阵准确。回退注册/入口/preload/测试读取一起恢复。

### B2b：App/Month 共用 runtime 分四小步

**文件：** App.vue、MonthApp.vue、applySettingsSnapshot、现有 presentation/modal/provider；拟 useWorkspaceRuntime.js、useWorkspaceWallpaper.js、useWorkspaceNotices.js、useUpdateCheck.js。

**步骤：** 先 settings/消息/订阅，再壁纸，再公告/首次使用/节假日，再 update；每小步都保持根模板/CSS与各 view 策略。timer、unsubscribe、modal blur、引用计数和 ready 归属随方法一起移动，不能每新组件再装一份共享时钟/presentation。Q-004/005 的成立修复独立记录，不借抽取统一 App/Month 行为。

**保护/验收：** 相关 first-use-notice、modal-queue、draft-dialog-ui、presentation-mode、month/week-view、更新/Markdown 局部保护；按本小步选择。T-007/T-009/T-010、D-009、R-011/R-013/C-004/C-007/C-009/C-010。没有重复监听/过早 ready；策略可追踪。回退每个 composable 与两个 root 接入一起恢复。

## 10. B3：窗口、几何、连接与生命周期

### B3a：MainWindowHost

现有 index createWindow/security/session/window listeners 与 window-profiles/recovery；拟 windows/main-window-host.js。先冻结 getWindow/load/readIdentity 与安装边界，再整体移交 current window 创建/赋值/closed identity 和窗口级释放；所有旧消费者改 getter/窄命令，旧 createWindow 仅委托。

若首步仅抽无状态工厂，index 仍明确为唯一所有者，账本标未完成 host 状态移交。session 权限策略与窗口事件生命周期不同，不能销毁一个窗口就清除共享 session 策略。

前置 R-008/R-010、T-009/C-007/C-012；选择 window-profiles.test.js、renderer recovery/draft 的相关保护与真正受影响窗口专项。完成窗口/导航安全/启动显示顺序不变、无双 owner。回退 host/工厂/调用方和身份检查一起恢复。

### B3b：稳定几何持久化

现有 index 的普通 geometryDirty/debounce/suppression/稳定几何 flush、window-bounds；拟 windows/window-geometry-persistence.js。普通几何 state/timer/稳定边界与 mark/cancel/flush 一起迁；从尚未迁的 Dock/Presentation 读取窄快照，不接管它们的状态。compactExpandedBounds/stableCompactBounds、compact drag/resize 计时器与尺寸保存事务仍归 B4d PresentationRuntime；本模块只提供其必要的持久化端口，旧 compact 逻辑在迁移前保留唯一 owner。

前置 B3a、相关 R-008/C-007；选 window-bounds/window-compact-geometry 单元、view-switch-geometry-order 的有效契约及真实拖动/视图切换相关场景。隐藏/拖动/紧凑暂态不覆盖稳定位置，compact 只按约定持久化尺寸。回退 geometry/旧委托/消费者/source-read保护同步。

### B3c：DatabaseRuntime

现有 db.js/init/close、db-connection/schema/migration-backup；拟 db/db-runtime.js。应用引导传用户路径，runtime 保留 WAL/pragmas/backup/schema/error close 顺序；facade 与业务 consumers 同一 connection，先不改全部 DB 模块为新 DI 容器。

前置 B1a、R-001/R-007、T-007/C-001；真实旧结构/磁盘 init/close/失败引用清除按所改契约验证，不运行所有 DB 组。完成唯一连接、迁移语义不变、服务持久化早于关闭。回退 runtime/facade/import 与隔离数据策略同步；涉及真实数据迁移另列批次。

### B3d：bootstrap 与可重入 shutdown

现有 src/main/bootstrap.js 的早期 logging/import、index startupPromise/before-quit；拟 application/bootstrap.js/shutdown-coordinator.js。现有外层 bootstrap.js 保持实际 electron-vite 入口，不能被同名新内部模块替换。

先建立按原序的已创建阶段表，再移动 startup；退出保持草稿→capture→remote有界等待→diagnostic→geometry/services/DB/native/tray/log。未拆服务使用明确阶段委托，部分失败只回收实际拥有资源。重复 before-quit 不重复 dispose，取消退出不能继续关闭。

Q-002/003 在本子批前定向复现；成立则先最小修复并记录，后续迁移按修复后的契约。选择 editing-draft-guard/session、capture-lifecycle、remote-health-cache、log-writer-client/logging-actions 与必要独立退出小场景；不自动窗口矩阵。T-005/T-007/T-009/T-010、D-002、R-007/C-001/C-004/C-007/C-008/C-010/C-013。

验收正常/取消/重入/启动中退出/单服务失败与有界 incomplete 的资源终态可追踪。回退 startup/shutdown/入口/连接/日志消费者一起恢复，禁止把全部 dispose 改为 Promise.all。


## 11. B4：窗口事务与 native 能力逐域移交

**共同前置：** B3 host/geometry 与 B1 settings 端口；T-009/C-007、本域 R-008/R-009/R-003。每个子批先读其完整调用链和失败恢复，运行对应保护；不是一次执行所有窗口专项。

统一保留 Electron DIP 与 native 物理像素边界、单主窗口、compact 尺寸持久化与会话启用状态、最新意图、native health gate，以及 apply→实际 confirm→persist/rollback 顺序。源码结构测试保留有效边界，注释/内部名字断言逐项改写。

### B4a：blur 与 z-order 叶能力

**文件/消费者：** index.js 的 native 同步/层级事务、blur_bridge.js、shared/native-abi-version.js 与现有 windows 规则；拟 windows/blur-runtime.js、windows/z-order-runtime.js。窗口、Dock、拖动、Presentation、设置和截图恢复都是消费者。

**步骤：**

1. 冻结 host/window getter、settings 读/持久化、native health/snapshot 等端口；不让叶模块 import index 或反向调用完整背景事务。
2. 迁移 blur 配置/同步调度/实际状态、z-order pending/requested/确认/回退及其 waiter/timer；旧函数仅委托。
3. 保持层级 apply→confirm→persist 闭合；确认失败不能以 renderer 设置值作为成功，也不能先写 DB 再尝试 native。
4. 结构抽取保留 ABI 18 和 DLL。仅实际导出/语义变化时单列 native 修改、同步 shared 版本/产物/打包验证。

**验收/回退：** 选相关 blur-settings-main-wiring.test.js、window-z-order-main-wiring.test.js 的有效契约和 blur-z-order/window-z-order/recovery 对应专项；确认 enabled/requestedMatches/anchored 等真实状态。回退 runtime、全部委托和消费者；若改 ABI，JS/版本/DLL/部署证明成组恢复，不混用产物。

### B4b：DockRuntime

**文件：** index.js 的 dock state/session/generation、edge/display/power 监听；现有 window-motion 规则/backend 与 native observer；拟 window-motion/dock-runtime.js。

**步骤：** 分五小步：状态/会话/轮次 → 可见态判定 → hide/show → edge cleanup → display/power 恢复。每小步移交自己完整的计时器、监听、pending 和清理；共用 motion/backend 保留，不另造隐藏动画或监控服务。

Dock 接 host/settings/geometry/native 窄口；提供 readSnapshot/restoreVisible/stop/suspend/release/isCleanupPending 等已登记能力。截图/拖动/Presentation 调用 Dock 暂停和恢复，不直接改内部 state。现有暂停计数先保留，token 化另论，避免把行为重写夹进迁移。

**验收/回退：** 选择实际改动对应的 dock-transition-state/dock-edge/dock-health/dock-display-rebuild 等单元和 dock-trigger/window-control-drag 等必要桌面场景；隐藏中再次显示、边缘清理、显示器/电源事件只按本小步涉及范围纳入。验收单一状态源、监听不重复、无晚到隐藏、稳定几何不被暂态覆盖。每小步连同接线/source-read 保护恢复；清理测试自己拥有的监控和窗口。

### B4c：WindowDragController

现有 index 的 native drag、title/control drag 与暂停/blur/geometry 协调；拟 windows/window-drag-controller.js。前置 B4b 的暂停端口和 B4a 的同步端口。

移动 drag active/暂停计数/开始结束票据/恢复与资源释放，不只移动 mouse handler。所有结束、取消、窗口销毁、native 失败路径恢复 Dock/blur/几何的顺序保持；既有 backend 复用，坐标与缩放转换不顺带重写。

验证 titlebar-native-drag-electron.mjs 或 window-control-drag-electron.mjs 的实际相关路径及所消费纯规则，不能默认两个都跑。完成时只有一个拖动状态拥有者，按钮点击不误拖动，拖动中退出不遗留暂停。回退 controller/全部入口/恢复消费者共同恢复。

### B4d：PresentationRuntime

现有 PresentationModeController 与 index 的紧凑/presentation 适配；拟 windows/presentation-runtime.js。前置 host/geometry/Dock/drag/native 的窄接口；未迁小能力可用声明过的旧端口。

复用现有 controller，将 operation/latest intent、target bounds 更新、waiter、退出/导航屏障和窗口事件适配一起移交。compactExpandedBounds/stableCompactBounds、compact drag/resize 计时器与尺寸保存事务归本 runtime，普通 geometry 只提供持久化端口。当前外部对 operation.targetBounds 的写入需变成拥有者内的受控适配；不能新造第二个 controller，也不让无关消费者任意写其内部状态。

选择 presentation-mode-controller.test.js、window-compact-geometry.test.js 及 presentation-mode-electron.mjs 的受影响契约；architecture 断言逐条判断。完成紧凑进出/反转/失败/销毁终态一致，enabled 与旧位置按会话规则，尺寸按原持久化规则。回退 runtime/controller 适配/所有消费者/source-read 断言。

### B4e：MainViewNavigation

现有 index 的切换 gate/queuedViewSwitch、draft 保护、settings scope、load/ready 和 tray 更新；拟 windows/main-view-navigation.js。前置 B4d；background 尚未迁移时提供只读 inFlight/settled 端口，不互相反向 import。

导航唯一拥有 queued target 和轮次；保持 list/month/week 单窗口导航、week 复用 MonthApp、旧 renderer 授权/只读例外、草稿 flush/冲突阻断、稳定几何和当前 sender/activeViewMode ready 过滤。background 仅通知事务收敛，导航自己消费最后目标，不保存两份 target 或形成递归指令环。

验证 view-switch-geometry-order.test.js 的行为契约、editing-draft-guard/session 与 month/week/presentation 对应专项中的必要场景。Q-005 区分整页销毁、同 mode 重载和同文档 remount。完成无重复导航/过早 ready/草稿覆盖；回退 navigation、load/ready、scope、draft 与 tray 接线一起恢复。

### B4f：BackgroundSettingsCoordinator 与完整写协调

现有 index 的 blur/wallpaper IPC、revision/inFlight、失败回填与 persistSettingValues；拟 settings/background-settings-coordinator.js、settings/settings-write-coordinator.js。前置 B4a/e，settings runtime 和已迁相关窗口端口；wallpaper 查询/资源提交由独立存储口提供。

把 blur/wallpaper 请求版本、互斥组、提交/恢复、快照、广播与 navigation settlement 通知完整迁移到 BackgroundSettingsCoordinator。B1c 的旧 persist 协调在同一子批归 SettingsWriteCoordinator：持久化→runtime 刷新→window/blur/dock 副作用→快照/广播按原序接窄口，不拥有第二份 resolvedSettings/revision。SettingsRuntime 唯一拥有配置缓存/快照，Background 唯一拥有背景请求竞争；复杂命令调用通用写口，通用写协调不反向调用背景命令，不能形成循环或把所有功能塞入一个 settings service。

保留当前 wall/blur 同 scope 原子组、最后有效请求、截图 theme 同步与提交后清理成功语义。Q-001 仍按 reset 的实际双 scope 路径核验，不能混为壁纸问题。

验证 blur-settings-main-wiring.test.js 的有效边界、wallpaper-storage-electron.mjs，以及实际相关背景/视图/设置桌面场景；scope/revision/最终快照和系统状态保持。回退 coordinator、IPC、持久化/快照、navigation 通知与资源补偿成组恢复。

## 12. B5：完整业务命令、恢复与清空

**共同前置：** B0/B1；本域 T-007/T-008、R-001/R-002/R-004/R-006、C-001/C-002/C-004/C-006。只有连接生命周期改动才依赖 B3c；不因窗口域尚未全迁移阻止独立 note 命令准备。

### B5a：NoteCommands

**文件/消费者：** ipc/register-business-ipc.js、db-notes/db-images/db-reminders/编辑草稿保护与资产能力；拟 notes/note-commands.js。IPC、截图创建、编辑/草稿消费者保留既有 DTO。

**步骤：**

1. 先从 create-with-assets/save-draft 两个完整操作各自画出 staging→SQL/版本/归属复核→文件提交→补偿→广播链，不将二者强制统一为一个万能 save。
2. IPC 保留 sender/参数鉴权、diagnostic/observeNoteMutation、返回和提交后广播；命令承担完整事务与跨资源协调。
3. SQL 事务内复核版本和资源拥有者，保留同步事务；文件操作失败保留原补偿。已提交成功后的清理/展示问题不改成“保存失败”。
4. 对 clear/delete、旧草稿会话、提醒轮次和截图资产来源核对消费者；不在命令中直接控制 renderer、窗口或托盘。

**验证/验收：** attachment-rules、editing-draft-guard/session、ipc-arguments/authorization 对应文件；note-draft-conflict-electron.mjs 与 attachment-storage-electron.mjs 按实际改动使用。资源故障/胜败双方/标签与提醒一致性缺口按 S1/S3 补最小保护。完成唯一操作拥有者、失败补偿和成功广播时点保持。回退命令/IPC/消费者/测试读取成组恢复；不借回退删除用户附件或重置 DB。

### B5b：AttachmentRecovery 与 BusinessDataReset

现有 db.js 的 pending attachment recovery/clear/reset、附件目录与应用清空协调；拟 db/attachment-recovery.js、db/business-data-reset.js。db.js 暂 facade；schema、文件布局、pending 状态和恢复顺序不变。

**步骤：**

1. recovery 的扫描/判断/幂等恢复/待清理现场整体移交；测试隔离目录和中断快照，不能扫删真实用户目录。
2. reset 的 SQL/文件处理与提交后恢复移动完整，应用层仍协调 reminder/sticky/drafts、renderer generation 和广播；不把 platform runtime 放入 DB 模块。
3. 核对清空时在途保存/截图/查询，保持 generation/revision 门槛。Q-004 复现清空导致 MonthWorkspace 重建，确认失败后另批局部修复。
4. 设置 reset 的 scope/geometry timer/dirty/UI 队列按 Q-001/R-003 与 B6c 联合核查；业务清空不顺带改变设置 scope。

**验证/验收：** 相关 backend-integration.mjs 既有契约、attachment/wallpaper 存储专项和真正需要的两轮进程/中断恢复小场景；reminder/sticky 仅所改清空同步路径。完成异常终止可恢复、重复恢复无二次删除、已提交成功不会被 cleanup 改报失败。回退 facade/recovery/reset/应用接线与匹配数据/资产恢复方案，不单独回退 schema 或复制陈旧库覆盖最新资料。

## 13. B6：renderer 模型、写队列与展示

**共同前置：** B0/B1/B2 对应稳定接口；R-011/R-012/R-003、T-007/T-010/C-003/C-004/C-005/C-009/C-010。纯脚本迁移先保持 template/CSS，实际界面/CSS/主题/边线/背景/控件/浮层修改前完整阅读 docs/UI_DESIGN_STANDARD.md。

### B6a：Timeline → Custom → TagGroup 三个独立子批

现有 components/list/NoteList.vue；拟 composables/useTimelineNotes.js、useCustomNotes.js、useTagGroupNotes.js。顺序分别验收，不一次搬整个 NoteList。

1. timeline 迁移 query/load/pagination 的 parent generation 与子请求序号，取消/过期/finally 和 refresh 归属一起移动。
2. custom 保留现有自定义模式规则、筛选/分页/刷新边界；不套用时间线全部状态。
3. tag group 保留分组排序/展开/分页/刷新、parent/child generation；不能只移动 child page sequence。
4. DOM refs、anchor、focus、scroll、Popover/motion 留展示 adapter；模型通过显式事件或命令连接，不深层跨写组件 refs。
5. 保留 NoteList 已有卸载失效/清理、状态组合、动画退出/反转和清空后的新实例隔离；新发现的 disposed 缺口另按复现门槛修复。

选本子域对应 note-list-refresh/tag-refresh/completion/animation/toolbar 专项及 tag-group-ordering-ui 等有效局部断言，不全部运行。完成 props/emits、排序/分页/最终状态一致，无旧结果改新视图。回退单一模型与其 adapter/消费者/读取测试；暂未迁模式继续原实现。

### B6b：CalendarWorkspaceModel

现有 components/month/MonthWorkspace.vue、calendar/recurrence/weather 能力；拟 composables/useCalendarWorkspaceModel.js。前置 Q-004 的同文档 remount 复现和成立问题最小修复，R-005/R-011/R-013。

分月查询→周查询→天气/辅助数据小步迁移，generation、pending target、transition/finally 与 loading/error 一起移动。保留月导航转场中拒绝新目标、周导航保留 pending 的不同策略；不统一串行队列。

日期/事件布局/recurring preview 规则沿现有纯模块；DOM/grid/anchor/focus/resize/motion 留展示 adapter。卸载、clear/remount、view mode 切换分别核验 ready/旧结果/旧 pending；不把根页面整页导航当作组件失效证据。

选择 calendar-grid-navigation/date-rules/service 等本小步相关文件，month-view/week-view/recurring-preview/week-day-panel 等必要专项；气象单独按改变契约纳入。完成原月周语义和交互、recurrence 历史跳过规则、日期单位一致。回退模型和页面接入/ready/generation/读取保护成组恢复。

### B6c：SettingsWriteQueue

现有 components/system/SettingsPanel.vue、现有 settings schema/快照应用；拟 composables/useSettingsWriteQueue.js。

先冻结通用 setting、blur、auto-start、dock 四类写任务的排空/失败/回填语义，再移动 debounce/timer/inFlight/latest revision/watcher gate/卸载。保留初始化与广播回填不写回、reset 先阻断 watcher→取消未发任务→等待在途→reset→最终状态回填、已存在的卸载检查。

queue 不接管业务 schema 或 OS 状态；通过明确的写/读/快照端口工作，避免队列读取另一份可写配置。Q-001 的后端 reset 失败状态与前端最终回填联合验证；Q-004/生命周期修复不能依靠通用 retry 隐藏。

选择 application-settings/settings-schema、blur/dock settings 相关有效源码断言与 weather-settings-electron.mjs 等实际设置契约；需覆盖不同任务迟到、reset 与写入竞争、卸载后回填、失败后的下一次操作。完成没有丢最终意图/重复保存/初始化写回。回退队列、四类调用与 watcher gate/回填统一恢复。

### B6d：域表单模型 → Settings Sections

前置 B6c 验收；先提取有实际状态/验证职责的域模型，再将 template/style 移到 components/system/settings/* 的必要区块。当前 WeatherSettings/WallpaperSettings 保持已有边界，不再包一层只透传同名字段的组件。

parent 保留搜索/当前 section/导航/scroll memory；区块 props/emits 明确，公共写队列/快照只有一份。scoped CSS/继承变量/焦点/键盘/可访问名称/Popover退出随区块审查，遵守 UI 标准的 semantic token/边线与背景规则。

按受影响区块选择 settings-panel-density、dock-settings-ui、ui-interaction-standard 等有效保护与 settings-scroll-memory/天气相关局部交互；静态 CSS 断言不能替代实际遮挡/缩放/焦点。完成当前标签和可见行为保持，搜索/重置/滚动/焦点不丢。回退一个区块及其模型、父接入和样式/测试定位，不全局格式化。

## 14. B7：剩余功能装配与兼容撤除

### B7a：Feature、Tray、Notification、Capture 集成

**文件：** index 中 remaining constructors/callbacks、现有服务/托盘/提醒/截图/sticky 能力；拟 application/feature-runtime.js、tray/main-tray-controller.js、services/notification-activation.js、capture/capture-window-integration.js、notes/sticky-note-commands.js。D-012、R-004/R-005/R-006/R-007/R-009/R-010/R-013/R-014。

分别迁移五个闭合职责：

1. feature runtime 按已创建阶段组合现有 recurrence/reminder/weather/remote/shortcut 等服务，只有 start/dispose/有限查询。各服务仍拥有自己状态，不成为能返回全部 globals 的 service locator。
2. tray controller 统一自己 menu rebuild/click/subscription，接当前窗口与 view/settings 窄口；保留 sticky 独立托盘能力、shortcut enabled 会话状态。
3. notification activation 保留 protocol 早接收、pending reminder、sender/轮次幂等、多通道和专属窗口能力。系统通知/激活不能由普通 mock 证明；窗口与 preload 例外保持有限。
4. capture window integration 统一开始时原始可见/焦点、业务 accepted/opened、来源取消/贴图存活与 Dock pause/blur 恢复票据，按 S3 R-009 决定恢复，不让任何结束都 show/focus。来源 Enter/双击执行来源动作，Ctrl+C 复制，全局截图默认复制；Host/Coordinator/资产/ACK 保持现有分层，不将 native screenshot 实现搬进窗口协调层。
5. sticky saveContent 完整移入明确命令端口：保留 expectedContent 文本比较、来源 note 删除错误、冲突时回填最新 content 和 sticky 记录、成功时 note/sticky 同事务更新；服务 onNoteChanged 的广播仍在事务成功之后。窗口注册/显示继续现有 StickyService，不能把文本比较改成草稿 expectedVersion 或把广播搬进事务。

前置对应状态域已验收；未迁独立服务可用已登记旧窄委托。Q-002/003 相关退出风险、reminder 轮次、capture 结束/取消/故障恢复作为本次实际改动保护。

选择 reminder-service/notification-guard/shortcut-status/capture-coordinator 等相应局部文件和 reminders/native activation/capture-lifecycle/business 的必要场景，按模块分别验收。sticky 命令选 sticky-service.test.js、sticky-persistence-electron.mjs 的保存/冲突/来源删除相关保护，必要时补真实事务失败场景。完成安装/释放各一次、提前激活不丢、过期回调不覆盖、截图恢复终态可靠、sticky 事务与广播语义保持。回退某个集成及其装配/回调/命令/结果消费者；测试不要并发争用桌面。

### B7b：按域撤兼容与闭合审查

只有该 wrapper 的全部实际消费者迁移、行为与平台证据有效，才能删其旧委托/死 import/孤立 timer 和重复 state；不统一删除全部旧名称。

逐域复核源码/IPC/preload/native/registry/source-read/helper/CI/docs。D-001 的所有权账本逐项销账；T-006 每条测试记录保留/改写/合并/删除及替代保护，T-012 同步真实入口和未覆盖边界。

R-001 至 R-016 的未修改分支仍须有链路审查结论；例如 recurrence 日期/失败阈值、reminder 多通道、日报快照/导出、天气/更新策略、安装依赖、性能原因不能因没有抽取文件就无记录。阅读可以在对应域保护前并行；验证只选择需要证明的契约，不以一次全库运行替代覆盖账本。

完成须无反向依赖 index、双可写状态/重复监听、无主资源、未映射测试或失联命令。每个 R 记录确认/排除/待核验及实际证据边界；有未覆盖项可以如实保留，不能称“全面通过”或“发布就绪”。撤除回退以该域兼容/消费者/测试/config/docs 成组恢复。

## 15. T/D/R/C 与批次的完整对应

本节是遗漏检查与选择依据，不是自动执行测试集合。编号含义仍以 S1/S2/S3 原文为准。多个批次出现同一契约表示分步骤移交或贯穿保护，不重复生成同一测试。

### 15.1 T 与 D 对应

| 测试条目 | 实施落点 |
|---|---|
| T-001 | B0a；每批更新真实基线/恢复来源 |
| T-002 | B0b 登记与完整性；每批迁移消费者/source-read |
| T-003 | B0b/c 选择与调度；B0d 默认入口/CI |
| T-004 | B0d 构建/Qt选择；B3/B4/B7 对应来源/runtime前置 |
| T-005 | B0c 结果/证据；B3d/B7a 退出、日志与专项适配 |
| T-006 | B1–B7 按本域逐条处置，B7b销账；不先全删 |
| T-007 | B1设置、B2草稿共享、B3连接/退出、B4背景、B5事务/恢复、B6队列/生命周期 |
| T-008 | B5提醒一致、B6 recurring preview、B7 recurrence/reminder装配；R-005/R-006独立领域核验 |
| T-009 | B2/B3/B4窗口与视图；B7 capture/notification集成 |
| T-010 | B2/B6 UI/网络/安全；B0/B3/B7 日志/性能/交付按实际改变契约 |
| T-011 | B0d 同步普通CI与release调用；后续每批只完善相关映射 |
| T-012 | B0a/d 和所有子批的真实使用/状态/证据；B7b一致性闭合 |

| 解耦条目 | 实施落点 |
|---|---|
| D-001 | B0a 所有权/端口；贯穿每批，B7b销账 |
| D-002 | B3d bootstrap/shutdown；B7a剩余服务装配 |
| D-003 | B1a/b/c settings存储/唯一快照/窄写口；B4f通用SettingsWriteCoordinator，与Background分明 |
| D-004 | B3a host；B4d presentation；B4e navigation |
| D-005 | B3b geometry；B4b dock；B4c drag |
| D-006 | B4a blur/z-order；B4f background；B1c暂完整协调 |
| D-007 | B2a简单IPC；B5a完整note命令；B4/B7对应复杂域注册随拥有者迁移 |
| D-008 | B1a repository；B3c DB runtime；B5b recovery/reset |
| D-009 | B2b workspace runtime/wallpaper/notices/update |
| D-010 | B6a list模型；B6b calendar模型 |
| D-011 | B6c queue；B6d form/sections |
| D-012 | B7a feature/tray/notification/capture集成及sticky完整命令；相关B3d生命周期接线 |

### 15.2 R 的处理与契约对应

同一 R 可以同时包含必须保留的保护、结构建议、条件式风险和产品规则；不机械分成互斥类别。

| 审查条目 | 处理与实施落点 | 主要契约 |
|---|---|---|
| R-001 | 保留schema/迁移/唯一连接；B1a/B3c/B5b；故障/恢复条件式修复 | C-001/C-003 |
| R-002 | 保留资源补偿和成功语义；B4f/B5；先复现提交/清理歧义 | C-002/C-004 |
| R-003 | 保留scope/session/reset队列；B1/B4f/B6c；Q-001按实际规则 | C-003/C-007 |
| R-004 | 保留版本/草稿/资源归属；B2b/B4e/B5/B6；B7a sticky文本冲突；Q-004clear并发 | C-002/C-004/C-009 |
| R-005 | 保留历史跳过/替换/单模板默认连续失败3次；TemplateSchedulerGuard与Scheduler task独立阈值保持；B6b/B7a前核验日期/调度 | C-005/C-009 |
| R-006 | 保留轮次/幂等/窗口能力；B5/B7a；真实系统激活另证 | C-004/C-006 |
| R-007 | 保留退出阶段/outbox/诊断冻结；B3c/d/B7a；Q-002/003复现 | C-001/C-004/C-007/C-008/C-010/C-013 |
| R-008 | 保留controller/稳定几何/层级确认；B3/B4；故障需桌面证据 | C-003/C-007/C-009 |
| R-009 | 保留Host/Coordinator/ACK/Job/资产；B0d/B4/B7a对应路径 | C-002/C-007/C-008/C-012 |
| R-010 | 保留权限/有限例外；B0b/B2a/B3a/B7a；补入口矩阵，可达越权另证 | C-008/C-010/C-012 |
| R-011 | 保留现有sequence/dispose；B2b/B6；Q-004/005条件式修复 | C-003/C-004/C-009/C-010 |
| R-012 | 保留标准/交互；B2b/B3/B4/B6实际界面范围，不产品改版 | C-007/C-009 |
| R-013 | 保留缓存/联网/首次使用/统计/更新/App-Month差异；B2b/B6b/B7a | C-005/C-009/C-010/C-012 |
| R-014 | 保留日报/诊断/隐私；B0c/B3d/B7a；日报IPC触碰随B2a；性能原因另证 | C-009/C-011/C-013 |
| R-015 | 每批窄接口/唯一owner/规范；不全库格式化或引框架 | 对应所改 C |
| R-016 | B0可信入口/结果/构建，贯穿测试审查，B7b闭合 | C-001至C-013 |

### 15.3 C 覆盖落点

| 契约 | 核验/保护落点与实施边界 |
|---|---|
| C-001 | B3c DB迁移/磁盘/连接、B3d退出、B5b恢复；真实重启缺口独立记录 |
| C-002 | B4f wallpaper、B5附件/恢复、B7 capture资产；SQL+文件与中断恢复 |
| C-003 | B1 scope/快照/SQL、B4 settings副作用、B6 queue/reset |
| C-004 | B2/B4 view/draft、B5保存/清空、B6卸载/remount、B3退出 |
| C-005 | R-005领域核验、B6 recurring UI、B7调度装配；未改规则保留 |
| C-006 | B5笔记提醒一致、B7轮次/多通道/激活；真实系统端到端另证 |
| C-007 | B3 host/geometry/exit、B4 native/Dock/drag/presentation/navigation |
| C-008 | B0d Qt/部署前置、B3d退出、B7 capture集成；真实/模拟模式分列 |
| C-009 | B2共享页面、B6列表/月周/设置展示；旧结果/动画/焦点 |
| C-010 | B2 notices/update、B3d remote退出、B6天气、B7服务装配 |
| C-011 | 日报IPC触碰随B2a保护；R-014独立审查/export核验，不强制重写日报 |
| C-012 | B0入口/交付、B2 IPC、B3 host/session、B7通知/capture边界；安装另证 |
| C-013 | B0结果证据、B3d/B7日志、R-014性能核验；长期/客户环境未自动覆盖 |

## 16. 局部验证选型表与现有缺口

### 16.1 怎样使用下表

下表给出**现有候选文件**和**补证条件**。实施时先核对文件的实际断言、数据/模式与本批 diff，再确定具体文件/场景；同一行也不能直接当“全部运行”的默认集合。相关集成是必需时不能用单元代替；文件本身过宽，应增加可靠的场景选择或独立小专项，再说明原广域文件为什么不默认执行。

| 功能/子批 | 已有单元/静态候选（tests/） | 已有专项候选（tests/）与纳入条件 |
|---|---|---|
| B0b登记/选择 | test-manifest.test.js；拟 test-selection.test.js | 不需应用窗口；验证空/单/多/未知/helper/无匹配/source-read/依赖 |
| B0c结果/调度 | test-runner.test.js；拟selector/adapter保护 | 受控子进程fixture证明失败/超时/证据/cleanup，不执行产品全集 |
| B0d构建/入口 | package-native-config.test.js、native-runtime-gate.test.js | 选定Qt程序、capture-package-smoke.cjs只在相应目标/包改变；非默认打包 |
| B1存储/快照 | application-settings.test.js、settings-schema.test.js | SQL/scope/disk需要相应真实SQLite保护；weather-settings-electron.mjs仅触碰其持久化/回填时 |
| B2a传输/安全 | ipc-authorization.test.js、ipc-arguments.test.js、security-hardening.test.js | 对应实际IPC跨进程与权限消费者；不是运行所有业务GUI |
| B2b共享公告/update | modal-queue.test.js、queued-modal-lifecycle.test.js、notice-markdown.test.js、app-update.test.js | first-use-notice-electron.mjs、modal-queue-electron.mjs、notice-markdown-electron.mjs按本小步选择 |
| B3a host/ready | window-profiles.test.js、deferred-window-restore.test.js | window-frame-electron.mjs及相应recovery/view场景；先确认文件实际范围 |
| B3b geometry | window-bounds.test.js、window-compact-geometry.test.js、view-switch-geometry-order.test.js | presentation-mode-electron.mjs、window-control-drag-electron.mjs按暂态/稳定保存实际变化 |
| B3c DB | 相关db规则/迁移逻辑与独立预期 | backend-integration.mjs按已有契约；缺真实磁盘/旧库迁移/失败引用释放则补相应小场景 |
| B3d shutdown | editing-draft-guard.test.js、remote-health-cache.test.js、log-writer-client.test.js | capture-lifecycle-electron.mjs、logging-actions-electron.mjs仅对应退出资源；缺启动中退出/最终flush则补 |
| B4a blur/z-order | blur-settings-main-wiring.test.js、window-z-order-main-wiring.test.js | blur-z-order-electron.mjs、window-z-order-electron.mjs、window-z-order-recovery-electron.mjs按改动的真实state契约 |
| B4b Dock | dock-transition-state.test.js、dock-edge.test.js、dock-health.test.js、dock-display-rebuild.test.js、dock-native-status-observer.test.js | dock-trigger-electron.mjs；只有改display/power或拖动恢复才加相应场景 |
| B4c drag | 所消费Dock/坐标/窗口纯规则的具体文件 | titlebar-native-drag-electron.mjs或window-control-drag-electron.mjs按入口选择 |
| B4d presentation | presentation-mode-controller.test.js、window-compact-geometry.test.js、presentation-mode-architecture.test.js | presentation-mode-electron.mjs；matrix仅触及组合契约时另外纳入 |
| B4e navigation/draft | view-switch-geometry-order.test.js、editing-draft-session.test.js | month-view-electron.mjs、week-view-electron.mjs、note-draft-conflict-ui-electron.mjs按实际路径 |
| B4f background | blur-settings-main-wiring.test.js、wallpaper-crop.test.js仅触其规则时 | wallpaper-storage-electron.mjs和对应设置/视图场景；保留cleanup成功路径 |
| B5a note/asset/draft | attachment-rules.test.js、editing-draft-guard.test.js、ipc-arguments.test.js | attachment-storage-electron.mjs、note-draft-conflict-electron.mjs；结果双方/故障点按命令 |
| B5b clear/recovery | 相应pending/recovery/clear规则保护 | backend-integration.mjs、attachment-storage-electron.mjs；中断/两轮进程缺口单列，Month remount定向场景 |
| R-005/B6/B7 recurrence | recurrence-rules.test.js、template-scheduler-guard.test.js、recurring-note-preview.test.js | recurring-preview-db.mjs、recurring-preview-electron.mjs、template-quarterly-electron.mjs按日期/装配/preview变化 |
| R-006/B7 reminder | reminder-service.test.js、reminder-notification.test.js、notification-guard.test.js | reminder-database-integration.mjs、reminders-electron.mjs、reminder-native-acceptance.cjs按持久化/多通道/系统激活 |
| B6a list | note-list-motion.test.js、tag-group-ordering-ui.test.js及本模式规则 | note-list-refresh-electron.mjs、note-list-tag-refresh-electron.mjs、note-list-completion-electron.mjs、note-list-animation-electron.mjs、note-list-toolbar-electron.mjs按本模式变化 |
| B6b calendar | calendar-grid-navigation.test.js、calendar-date-rules.test.js、calendar-event-layout.test.js、calendar-service.test.js | month-view-electron.mjs、week-view-electron.mjs、week-day-panel-electron.mjs、month-day-preview-status-electron.mjs按月/周/侧栏步骤 |
| B6c/d settings | settings-panel-density.test.js、dock-settings-ui.test.js、settings-schema.test.js | settings-scroll-memory-electron.mjs、weather-settings-electron.mjs只覆盖对应区块/queue；竞态缺口单补 |
| B7 capture集成 | capture-coordinator.test.js、capture-assets.test.js、capture-recorder-owner.test.js | capture-host-electron.mjs、capture-lifecycle-electron.mjs、capture-business-electron.mjs按Host/桌面/业务模式 |
| B7 tray/shortcut | sticky-tray-menu.test.js、shortcut-status.test.js、view-visibility-shortcut.test.js | view-visibility-shortcut-electron.mjs及必要托盘动作/会话重载 |
| B7 sticky命令 | sticky-service.test.js、sticky-utils.test.js按实际契约选择 | sticky-persistence-electron.mjs；expectedContent冲突/来源删除/真实事务失败与提交后广播 |
| R-013联网/策略 | weather-service.test.js、weather-refresh-controller.test.js、holiday-data-service.test.js、remote-health-cache.test.js、app-update.test.js | almanac-weather-electron.mjs、notice-markdown-electron.mjs仅对应交互；响应/取消用可控fixture |
| R-014日报/日志/性能 | daily-report.test.js、daily-report-ipc.test.js、diagnostic-controller.test.js、log-writer-client.test.js、performance-attribution.test.js | daily-report-electron.mjs、logging-actions-electron.mjs、logging-worker-asar-electron.mjs、thumbnail-benchmark-electron.mjs、logging-overhead-electron.mjs分别按输出/退出/ASAR/性能改动 |

tests/window-state-matrix-electron.mjs、ui-components/ui-responsive/ui-feedback-app、maturity、benchmark、原18项 window-frame 集合、七个Qt程序都不是“任一窗口/UI改动”的默认前置。改变公共模块影响不清时，先说明实际风险和建议补的具体契约，不能自行升级全量。

### 16.2 必须单独登记的证据缺口

1. settings Map mock 不证明 SQL主键/ON CONFLICT/真实重开；真实磁盘两轮主进程不由同进程serialize/reopen替代。
2. 附件存储已有真文件但部分是内存SQLite；需证明SQL/文件/进程异常边界时，设计隔离数据库/目录/故障点及恢复观察，不复制正常成功路径。
3. remote health中退出与session-start中退出分开；outbox已先持久化，重点查迟到新流程/已关DB访问/补报资料，不假定记录必丢。
4. 日志最终sequence/timeout/incomplete与真实quit/restart相联系；exit 0不是最终文件完整的替代。
5. Month clear/remount、根整页导航、同mode重载分开；生产入口和可控延迟保留，禁止仅在测试强制unmount后将结果泛化。
6. capture simulated-business仍等待真实engine，CaptureHost确实启动helper；模式/依赖/输入证明不能混写。
7. 安全矩阵覆盖五个renderer HTML：index/month/week/sticky/reminder，三个preload入口：main/sticky/reminder。诊断/capture接收者和session/frame权限按实际能力单列；静态CSP缺测试入口不等于产品CSP失效。
8. 安装/升级/卸载、通知系统激活、多屏/DPI/真实输入、长期共存、客户机器只在相应任务有证据时结论；目录包或本机一次通过不能代替这些边界。

### 16.3 未来执行命令的边界

以下只是B0完成前的现有局部单元用法示例，当前未执行；具体文件仍由本批选择。拟focused CLI须等实现/验证后再写可执行示例，不能现在调用不存在的文件。

~~~powershell
$taskNodeDir = 'C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin'
$taskPathEntries = @(
  $env:PATH -split ';' | Where-Object {
    $_ -and $_ -notmatch '(?i)[\\/]Volta(?:[\\/]|$)'
  }
)
$env:PATH = (@($taskNodeDir) + $taskPathEntries) -join ';'
& "$taskNodeDir\node.exe" '.\node_modules\vitest\vitest.mjs' run 'tests/test-manifest.test.js'
~~~

这是专用命令进程内的PATH设置，不写系统PATH。Electron/桌面/DPAPI/GPU/native专项从第一次使用合适沙箱外环境；采用本批明确单文件与实际构建/runtime依赖，不调用空参数DB/window/full wrapper。若需扩大到全量/发布验证，必须有用户相应明确要求；部署/发布另有授权边界。

## 17. 多代理分工与并行约束

当前三名子代理仅做只读核对，统一文档由主代理写入。未来S5可用以下分工减少遗漏：

| 任务 | 可并行范围 | 写入/集成负责人 |
|---|---|---|
| 现规则、链路、测试预期独立性核查 | 各功能域只读并行，互换消费者/失败路径结论 | 本批主负责人汇总并复核 |
| index接线/全局状态移交 | 各代理可只读提出diff建议 | src/main/index.js始终一名写入者 |
| DB/settings核心 | 独立规则阅读可并行 | db.js/db-connection/application-settings/schema的共享契约同批串行 |
| 测试基础/CI/Qt | 独立方案可并行 | package/manifest/runner/CI及ABI/CMake/build接线各指定一位，跨接口顺序集成 |
| App/Month共用抽取 | 壁纸/更新差异可独立审查 | 同一负责人统筹两个root的接入 |
| NoteList与MonthWorkspace | API/DTO/generation冻结后可分文件并行 | 每文件单写入者，共享helper先验收 |
| SettingsPanel | 区块只读设计可并行 | queue→model→template串行，每阶段一位写入者 |
| 独立新模块 | 必要端口稳定、文件不交叉时可并行实现 | 各模块单写入者，主负责人串行接入口 |
| 测试执行 | 无共享DB/profile/产物/端口的纯单元可并行 | 桌面/窗口/拖动/通知/capture/GPU/快捷键串行 |

代理交接必须提供：实际文件/符号、保留契约、端口/状态拥有者、消费者、断言依据、验证结果或未执行、风险/恢复来源。没有完整结果不得仅据另一代理“已完成”宣称验收；主负责人核对diff、实际源码和必要结果。

前一代理的未验收API不能被后一代理当稳定依赖。一个子批修改共享接口时暂停依赖实现，更新消费者清单后再继续；防止并行中双写index或以最后保存覆盖其他改动。

## 18. 门槛、实施状态、证据与停止/回退

### 18.1 三类门槛

| 门槛 | 意义 | 当前状态 |
|---|---|---|
| G-P 准备闭合 | S1–S4方案、编号对应、产品保留、顺序/依赖/文件/保护/回退齐全 | 文档交付，静态一致性检查完成后可标方案完成 |
| G-B 本子批可实施 | 实际基线稳定、规则明确、唯一owner/端口可迁、必要保护有效、依赖/环境具备 | 未执行；每个子批分别核查 |
| G-A 本子批可结案 | 本批diff与消费者审查、目标业务/平台/证据、测试处置和使用说明满足 | 未执行，不预填通过 |

G-P不表示G-B/G-A已满足；S4写完不自动执行S5。后续明确进入实施时，B0从当前源码/数据/产物开始核验；无需重做已有效的准备，也不能跳过漂移核查。

### 18.2 S4 归档时的初始实施状态（最新结果见 §20）

| 范围 | 当前状态 | 下一项动作 |
|---|---|---|
| B0a/b/c/d | 待实施 | B0a记录实际基线/端口，B0b建设登记与纯选择 |
| B1a/b/c | 待实施 | B0可用后核验本域真实SQLite与snapshot保护 |
| B2a/b | 待实施 | 分简单IPC与共用runtime小步，核查权限/生命周期 |
| B3a/b/c/d | 待实施 | 本域前置后按host→geometry→DB runtime→lifecycle |
| B4a/b/c/d/e/f | 待实施 | native叶能力→Dock→drag→Presentation→Navigation→Background |
| B5a/b | 待实施 | 完整命令/恢复保护，SQL+文件+版本不拆碎 |
| B6a/b/c/d | 待实施 | 列表/月周模型、settings queue与form先行，template/style后行 |
| B7a/b | 待实施 | 对应域完成后装配；按消费者验收逐项撤兼容 |
| Q-001至Q-009 | 决策路径已列，实际规则/复现/平台证据待核验 | 按所属域保留或验证，成立才做最小行为修复 |

实施账本可直接追加在本指导相应子批，不要求为小改动另造很多文档。单批最少记录：批次/状态、时间/HEAD+dirty基线、实际文件、owner/端口/消费者、保留/改变行为与原因、选中的具体测试/构建/环境、命令/退出/业务断言/来源、证据路径、测试处置、未覆盖、回退来源、下一批前置。

同时保持阅读/审查覆盖账本：文件或功能链、已完整阅读部分、未读分支/全部消费者、规则来源、R/C结论与实际验证。数量/AST/搜索命中不能标“每处实现已了解”；当前未完成所有旧断言/C++分支/安装环境的全面审查。

### 18.3 停止条件

只停止受影响子批，独立准备可继续：

- 当前源码/用户dirty/契约漂移未复核，或产品规则与计划冲突。
- 高风险契约没有必要保护/独立预期，或只能取得业务断言前的环境退出。
- 依赖来源/ABI/构建模式不明、requires被裁掉、目标测试零匹配/全跳过。
- 新模块仍依赖全部旧globals，状态/计时器有两个owner，或跨域命令循环。
- 事务/文件补偿/成功语义/退出顺序被意外改变，迟到回调不能证明被隔离。
- 真实native/系统效果仅有renderer/mock结论，或清理可能触及非本次拥有资源。
- 局部范围无法准确界定；说明缺口与建议具体扩大范围，不能自行全量。

### 18.4 回退原则

1. 每批只恢复自己的明确diff/快照；禁止整库reset/clean、覆盖原用户dirty或为恢复方便删除测试。
2. source+consumer+IPC/preload+测试定位+registry/config/docs同步恢复，单回退新模块不能留下孤立调用方。
3. native版本/JS ABI/实际DLL/helper/Qt部署/产品依赖来源成组；仅JS结构抽取且native导出、运行语义未变时，不夹带ABI升级；实际原生语义变化按Q-009同步评估。
4. 数据/文件先保护最新状态与当前恢复现场；迁移回退另用该批隔离快照/恢复流程，不能把旧库/目录粗暴覆写现用户资料。
5. 测试清理只处理当前拥有且确认路径内的目录/进程/窗口，保留首次失败和当前attempt证据；先收证据再清理。
6. 回退后验证该批必要契约/接线恢复；不自动全量，也不把回退当作风险已解决。

## 19. S4 归档交付与后续起点

本轮S4已将三个阶段合并，明确B0–B7及其子批次、9组风险/规则决策、全部T/D/R/C对应、局部验证选型、构建/runtime区别、多代理职责、状态门槛与回退。

主代理和三名子代理仅作只读源码/消费者核对与文档编写；文档编号/引用/路径/依赖/格式检查属于静态准备验证，不是业务测试。本轮未删除或生成测试，未改业务/测试/配置/AGENTS/构建/CI，未运行单元/DB/存储/Electron/Qt/Windows native/安装/性能/全量测试，也未lint/构建/打包/发布。

本轮文档检查：27 个子批、9 个决策和全部 T/D/R/C 映射齐全；默认依赖无循环；现有/拟新增/历史删除文件引用、关键源码定位、链接、表格列数、代码围栏与空白检查通过，git diff --check 通过。工作区变化仅限本组 README/S3/S4 指导文件，HEAD 不变。上述结果不填写为业务或平台验收通过。

S4 归档时，S1–S4 方案准备完成，S5 所有批次待实施；完整功能审查、条件式风险复现及运行期保护待对应批次执行。归档方案确定进入代码实施时从 B0a 开始，再做 B0b/c/d 可信测试入口；最新实施结果见 §20。

## 20. S5 实际实施记录

### 20.1 B0a/B0b：2026-10-08 首批结果（后续进度见 §21）

用户在 S4 交付后明确要求“开始”，允许必要的子代理。主代理保存快照、实现 CLI 接线/补安全入口、审查整合并统一验证；三个子代理分别负责登记、纯选择器与独立只读审查。共享文件按交接移交，未同时写入口或业务模块。

**状态：B0a/B0b 本批已验证；B0c/B0d 和 B1–B7 待实施。** T-001 本批基线完成，T-002 本批资产/依赖/完整性登记完成，T-003 纯选择与只读计划完成；T-003 默认入口与执行、T-004/T-005 等后续部分尚未完成。T-006 本批保留所有旧测试，仅补有实际保护价值的断言。

实际 HEAD：4fbc52be1c688dba9cf23fbbd51539606efbf381，分支 main。开始时仅 README 修改、03/04 两份指导未跟踪，来自前期准备；不视为本次业务修改。原 styled-select-menu.test.js 在当前 HEAD 已不存在，本批未删除或恢复它。

恢复来源：tmp/refactor-baselines/B0ab-2026-10-08T09-29-04-342Z-8825a3。保存 251 个本批相关源资产/脚本/配置/准备文件、staged.patch、unstaged.patch、原 dirty/untracked 状态与产物哈希；抽样复制 test-manifest.cjs 并校验 SHA-256 一致，未覆盖当前工作区。它不是完整产品/用户数据库备份。out/main、blur DLL、capture helper/host DLL 仅记录存在及哈希，构建来源未认证；本批结束哈希均未变化。

### 20.2 实际文件与所有权

| 文件/接口 | 本批实际职责 | 消费者与限制 |
|---|---|---|
| scripts/test-manifest.cjs | 保留原冻结分组数组；createTestRegistry/validateTestRegistry 统一资产、已核实读取依赖、运行前置和完整性；securityEntryPoints 五HTML/三preload | 旧 full/DB/window/storage 入口继续使用兼容导出；CLI 先校验再选择，不启动业务 |
| scripts/test-selection.cjs | parseSelectionArgs/selectTests 纯逻辑；require.main CLI 为只读边界 | 纯 API 不读文件/进程状态；CLI 读取登记和真实落点、输出计划，不调用 runner/创建证据/构建 |
| tests/test-manifest.test.js | 资产遗漏/重复/错角色/依赖环/真实链接逃逸/AST和运行模式保护 | 只用源资产与私有临时 fixture，未运行 native/数据库/产品专项 |
| tests/test-selection.test.js | 独立小样本选择契约及真实 CLI 只读联测 | 受控 Node 子进程；单DB、source-read、无匹配和依赖闭包均不执行目标业务 |
| tests/security-hardening.test.js | CSP 入口增加 reminder.html | 保留原安全断言；不是 renderer 实现/CSP 修改，也不证明真实越权或安装行为 |
| 本组 README/01/04 指导 | 更新授权/状态、实际结果与后续门槛 | S1–S4 历史基线保留，未把本批通过填到其他功能 |

本批没有修改 src、package/lockfile、vitest config、AGENTS、CI、runner/native构建或产品产物；没有提交/推送、旧测试删除、平台打包/部署/发布。

### 20.3 实际登记与选择行为

当前登记 **233 项**：214 个可运行文件、11 个 helper、4 个 fixture、4 个构建节点。其中 132 个 Vitest 文件（含本批新增选择器测试）；实际完整性 errors=[]。数量不是通过数，也不表示已逐条验收所有业务断言。

- Vitest 按当前 include 的 .test.js/.test.mjs/.test.ts 分文件发现；其他 MJS/CJS/PS/CPP/helper/fixture 明确分类，新增未知资产报错，不猜角色。
- 真实 ESM import 用已有锁定依赖的 AST 解析，不将模板字符串/注释内代码误当依赖。人工核实的 39 个源码读取组、嵌入子进程/动态helper/worker路径与 renderer 递归读取一并登记；未核实的业务规则/间接闭包仍标 limits、unreviewed、unmeasured。
- feature 当前只有已核实的 testing-infrastructure、ipc-security 小组，不按文件名生成广域业务feature。source 候选不表示完整 import/build 传递闭包；目录型 buildInputs 也不是当前可复用来源证明。
- file/id/feature 并集按登记顺序去重；未知/空匹配/越界/URL/UNC/glob/辅助项/无效level、requires缺项/环均非零，不回退合集。原有 dirty 文件不自动成为选择输入。
- requires 保留完整构建闭包，runtimePrerequisites 独立报告；reuse-verified 目前只表示请求模式，不裁依赖、不认证产物。
- 单选 reminder-database-integration 仅有一个 DB 文件，无应用构建、没有另六个 DB 项。单选 note-list-toolbar 只列 build-app，但保留 blur/capture 部署等实际运行前置，未启动窗口。
- note-draft-conflict 专项登记为 database + 正常 electron ready（真实 DB/附件、模拟 IPC sender，无 renderer）；CaptureHost 登记为 native + electron 后台 helper 生命周期，不声称测试了截图overlay/真实输入。
- registry 在读取/枚举前检查真实落点；越界链接不先解析外部源码。validator 再核对登记文件及源依赖落点/缺失/角色，纯 selector 仅承担词法和元数据检查。

### 20.4 当前可用的只读计划命令

在仓库根使用指定 Node；这些命令**仅输出 JSON 计划**，不会测试、构建或创建运行证据目录：

~~~powershell
$taskNodeDir = 'C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin'
& "$taskNodeDir\node.exe" scripts/test-selection.cjs --file tests/reminder-database-integration.mjs --plan
& "$taskNodeDir\node.exe" scripts/test-selection.cjs --source src/renderer/src/components/list/SearchBox.vue --plan
& "$taskNodeDir\node.exe" scripts/test-selection.cjs --feature testing-infrastructure --plan
~~~

第一项显式选一文件；第二项只有候选、selected/order 为空；第三项仅已登记的测试基础设施小组。CLI 缺少 --plan 返回 2，非法选择也返回 2。JSON 中 executed=false 与 warnings 明确标出未验证业务/产物/ABI/桌面；source候选只用于人工确定下一批具体范围。

当前 npm test/test:unit/DB/window 默认入口仍保持旧行为，不能因新增计划接口就称“无参数全跑已经修复”。B0d 将与 CI/release/README 同批接通；B0c 才新增实际 focused 调度/结果协议。

### 20.5 实际验证与首次异常

| 验证 | 实际结果与证明范围 |
|---|---|
| 原有 manifest/security/runner 三文件基线 | 沙箱 realpath EPERM 导致 0 断言，仅环境阻塞；同样三文件沙箱外重跑 20 断言通过 |
| 本批四文件最终局部测试 | tests/test-manifest.test.js、tests/test-selection.test.js、tests/security-hardening.test.js、tests/test-runner.test.js，**4 文件/92 断言通过，退出 0** |
| 本批五文件 ESLint --no-cache | 首次 5 个输入正则规范错误；改等价控制字符检测/转义写法后最终退出 0，未放宽拒绝规则 |
| 本批五文件 Prettier | 仅格式化本批文件；未全库格式化 |
| 真实登记/只读示例与恢复检查 | 233项 errors=[]、GUI/CaptureHost 依赖与前置分离、恢复样本哈希一致；原产物无变化 |
| 指导文档静态检查 | 27 个子批、9 个决策、全部 T/D/R/C 映射和依赖无环；本组五份指导的链接、表格、围栏与空白检查通过，B0a/B0b 实际状态一致 |

Vitest 通过指定 Node 调项目内入口，PATH 去除 Volta；第二次及之后从首次已证实适用的沙箱外环境执行。最终命令为 vitest run 后跟上述四个明确文件，没有使用 related/changed 推断。

test-runner 单元故意打印 failed/blocked 验证受控失败与依赖阻断；它们是该用例的预期，不是产品失败。原始最终输出和第一次异常/规范失败保存在上述快照目录 verification.json；implementation-hashes.json 记录本批源码哈希。它们是本批基础设施验证证据，不是新结果协议或产品验收报告。

未运行 npm test、test:window-frame:win、任何全量回归、DB/存储业务脚本、真实Electron窗口、Qt/C++、Windows native、安装/性能或客户环境专项；未构建/打包。数据库文件被“选中”不表示它已运行或通过。

### 20.6 回退与未覆盖

回退使用本批快照中的原文件和本批 diff；01/04/README 的准备阶段内容也有副本。新增 selector 两文件仅在确认没有后续用户修改时撤回，CSP 名单与manifest/test接线一起恢复；禁止整库 reset/clean，保留原有未跟踪的 S3/S4 指导和其他用户资料。

下一子批 **B0c**：实现 run-focused-tests.cjs 的实际调度、断言完成/证据/清理分离、首次失败保留与只读计划保证。之后 **B0d**：构建/Qt精确选择、来源认证、默认入口/CI同步，并修复旧 full selector 裁 requires。进入这两批前核对当前基线，不重复已经有效的本批准备。

尚未覆盖：各业务断言质量、完整消费者/构建传递闭包、真实 SQL/重启/资源恢复、native ABI/交付、桌面/通知/输入/多屏/安装/性能/客户设备。业务 feature 与结果 adapter 后续按真实契约扩充，当前不得用待审核元数据批准 B1–B7 迁移。

## 21. S5 B0c 实际实施记录

### 21.1 本批范围、恢复与交接

用户要求“继续”，本批按 B0c 实施局部调度、结果协议、独立证据和存储包装接线。B0a/B0b 的 253 个收尾文件哈希无漂移；本批再次保存 253 文件恢复副本、原 staged/unstaged/untracked 状态和 patch，抽样验证 runner 副本 SHA-256 一致。

恢复目录：`tmp/refactor-baselines/B0c-2026-10-08T10-06-52-486Z-f9891f`。HEAD 仍为 `4fbc52be1c688dba9cf23fbbd51539606efbf381`，分支 main；恢复副本包含上一批未提交结果，不将其作为本批可撤销的原始空状态。产物存在及哈希继续记录为来源未认证；本批没有构建或修改产品产物。

两名子代理分别负责 runner/受控保护/full 汇总，以及专项输出核对/计数器/两项存储/包装；主代理负责 focused 调度、适配器、登记接线、独立复核与最终验证。文件交接后才统一格式化，未同时编辑业务模块。

**本批已验证：** T-003 的精确局部调度、T-005 的运行器结果/证据/清理基座及 Vitest、附件/壁纸两类适配。其他 DB/GUI/native/安装/性能脚本的结果完整度仍待其域迁移；B0d 的构建/Qt 选择、来源认证、默认入口/CI 尚未实施。该限制不把没有证明的任务计为通过。

### 21.2 文件、消费者与真实行为

| 实际文件 | 改动与消费者 | 本批证明边界 |
|---|---|---|
| scripts/test-runner.cjs、tests/test-runner.test.js | 新增 prepare/assessResult、静态 blockedReason、明确验收和分层结果；full/focused 使用；每次调用独立 attempt，原始 code/signal/timeout/launch 信息保留 | 受控 Node 验证超时、输出失败、缺/旧证据、清理失败、链接/硬链接、首次失败重试和依赖阻断，不推导产品缺陷 |
| scripts/run-focused-tests.cjs、tests/run-focused-tests.test.js（新增） | 显式 file/id/feature 选择，源码仅候选；只读计划；保留完整 requires；按单文件 Vitest 或两项存储调度 | 空/未知/越界/--all 拒绝；缺 adapter 或 B0d 构建前置标 blocked，独立 unit 仍执行；不反向调用旧合集入口 |
| scripts/test-result-adapters.cjs、tests/test-result-adapters.test.js（新增） | 当前 attempt 的 Vitest JSON 必须只报告选定文件、计数一致且有实际通过用例；storage 报告核实 suite/mode/token/计数/终态 | 无匹配、全跳过、陈旧/错误目标/损坏报告不能验收；Vitest 数字为完成的测试用例数，不是 expect 调用数 |
| tests/helpers/test-result-recorder.cjs、tests/test-result-recorder.test.js（新增） | 包装实际 node:assert/strict 调用，异步断言 resolve/reject 完成后计数；报告带 attempt token；profile 真实子目录和独占报告路径保护 | 计数来自执行，不是扫描源码或静态常量；计数和到达末端不替代业务预期质量审查 |
| tests/attachment-storage-electron.mjs、tests/wallpaper-storage-electron.mjs | 保留原断言/故障注入，增加计数和末端完成信息；受管 profile 交父 runner 在取证后清理；DB release、flushLogs、脚本清理分别报告 | 正常 Electron ready、内存 SQLite、真实文件；壁纸使用 nativeImage，无 BrowserWindow，不证明真实主进程重启 |
| scripts/run-electron-attachment-tests.cjs、scripts/run-electron-wallpaper-tests.cjs | main guard 后委托 focused.main，每次精确一个存储文件；正常 Electron，清除继承的 as-node | 导入无运行副作用，包装脚本实际执行已验证；不调用整组 DB/GUI |
| scripts/run-full-tests.cjs | lint/普通 build 明确非业务任务；最终汇总只计完整验收项，旧结果 unproven 独立显示 | 未运行 full；未改原有 selectJobs 裁 requires 或 capture -Test/Qt 选择，均留 B0d |
| scripts/test-manifest.cjs | 登记新 helper，三份新增 unit 加入 testing-infrastructure | 当前 237 项：217 test、12 helper、4 fixture、4 build；其中 135 Vitest 文件，登记无错误 |
| 本组 README/01/04 | 同步实际状态、结果、兼容影响、后续步骤和回退 | S1–S4 与 B0a/B0b 历史结果保留，不预填其他功能验收 |

本批 14 个代码/测试文件，仅按该名单格式化和 lint；生产 src、package/lockfile、CI、AGENTS、native 构建及 UI 未改。没有删除旧测试，没有提交/推送、打包、部署或发布。

### 21.3 结果协议与兼容影响

每个 attempt 记录 `protocolVersion=2`、实际 args、目标 metadata、原始进程信息，以及以下四类结果：

| 字段 | 判定与消费 |
|---|---|
| processResult | 退出码/signal、passed/failed/timeout/launch-error/runner-error/not-run；进程失败不自动命名为产品业务根因 |
| businessResult | passed/failed/unproven/skipped/not-run；required adapter 必须证明实际目标完成；build/check 的 process-check 不编造业务断言数 |
| evidenceResult | complete/missing/incomplete/collection-failed，记录必需缺项/陈旧/收集错误/诊断 flush；与业务结果分开 |
| cleanupResult | complete/failed/pending，分别保留脚本资源释放和 runner owned cache 结果；只有自己创建且身份未变化的目录可清理 |

`accepted` 只在进程成功、目标证明通过、必要证据完整、资源清理完成时为 true。`isResultSuccessful` 是新门槛；`summarizeResults` 分 verifiedPassed、legacyUnproven、unverified、failed、blocked，空结果不算成功。依赖使用这个门槛，未通过的前置阻断相关目标，不取消独立项。

legacy 无 adapter 的零退出保留旧 `status=passed` 兼容字段，但 businessResult 为 unproven、accepted=false；控制台明确显示 unverified，不能作为新迁移验收。旧 DB/window 包装的默认组及退出消费未在本批切换。full 的结尾已用严格汇总，因此在旧域未迁移时可能以未证明/依赖阻塞非零结束；这不是据此认定产品有缺陷。**不得把 full 的历史用法当成已有可靠局部入口，旧 requires 裁剪尚未修复。**

必需 artifact 单文件需当前 attempt 新鲜文件；目录目前要求至少一个新鲜文件，内容完整性由相应 adapter 检查。可选附件缺失不伪装为必需失败。日志/诊断先保存再删缓存；写失败、链接换根、硬链接目的地或结果不完整时不通过，必要时在独立 owned sibling 保存恢复报告。重试新建 run/case，不覆盖第一次失败。

### 21.4 当前命令与后续 adapter 生成规则

在仓库根使用指定 Node；子进程 PATH 由 focused 去掉 Volta 并前置同一 Node。以下不是无参数全量入口：

~~~powershell
$taskNodeDir = 'C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin'
& "$taskNodeDir\node.exe" scripts/run-focused-tests.cjs --file tests/test-result-adapters.test.js --plan
& "$taskNodeDir\node.exe" scripts/run-focused-tests.cjs --source src/renderer/src/components/list/SearchBox.vue --plan
& "$taskNodeDir\node.exe" scripts/run-focused-tests.cjs --file tests/test-result-adapters.test.js
& "$taskNodeDir\node.exe" scripts/run-focused-tests.cjs --file tests/attachment-storage-electron.mjs --file tests/wallpaper-storage-electron.mjs
~~~

前两项只读，无运行目录/进程/构建；后两项只执行明确选中的已支持任务。storage 从第一次就在适用的沙箱外环境运行，受管 profile 不代表创建了真实应用窗口。含 build 的选择会显示依赖并记录 blocked，`reuse-verified` 不会删除 requires 或未经认证复用产物。

后续 DB/GUI/native 等 adapter 必须按以下顺序完成，不凭 OK/PASS 字符串泛化：

1. 核对实际启动模式、选定目标/契约和必需证据；内存 DB、磁盘 DB、同进程重载、两轮进程、模拟/真实输入分别说明。
2. 在真实断言成功/失败和目标末端处输出结构化报告；统计实际执行，不把源码断言行数或静态常量当计数；缺结果/零断言/全跳过必须拒绝。
3. 绑定独立 attempt、目标身份、模式与 token，校验路径/时间；报告不得沿链接逃逸或覆盖旧结果。
4. 先 flush/交付诊断，再释放自有资源；业务、证据、清理结果分别传给 runner，不能用 finally 的成功掩盖断言失败，也不能用清理异常改写已完成业务事实。
5. 补该 adapter 的独立故障样本，再跑其精确产品专项；没有业务预期或真实运行证据时继续 blocked/unproven，不能登记成迁移保护已通过。
6. 同批同步 manifest、真实消费者、结果字段和指导，避免只有新模块却仍调用旧合集。日常 feature 不隐含完整窗口/native/性能矩阵。

### 21.5 实际验证与证据

| 验证 | 结果 |
|---|---|
| 真实 Vitest JSON 样本 | 精确 test-selection.test.js，56 用例通过；用于核对当前锁定 Vitest 报告字段，不执行产品 |
| 首轮四文件 unit | 97 通过、1 fixture 失败：Windows 对空目录 rmSync 返回 EISDIR；改为 rmdirSync 后重新验证，不归类产品失败 |
| 六文件局部验证 | test-runner、run-focused-tests、test-result-adapters、test-result-recorder、test-manifest、test-selection，最终 **6 文件/140 用例通过，退出 0** |
| 本批 14 文件 lint/格式 | ESLint --no-cache 通过；Prettier 仅本批名单 |
| 两项 storage 包装 | 各精确运行一个文件，均退出 0；壁纸第一次自动权限审查超时，未启动，按提示重试后通过 |
| 最终 focused 双文件 storage | **附件 30/30、壁纸 53/53 实际断言通过**；mode 正常 Electron ready/内存 SQLite/真实文件，flush incomplete=false，evidence/cleanup complete、accepted=true，退出 0 |
| 只读计划与范围 | testing-infrastructure 仅六个明确文件，executed=false、没有构建依赖；最终文件/产物哈希和指导检查记录在恢复目录 |

最终 storage 证据：`tmp/test-runs/2026-10-08T10-31-20-192Z-welzt3`，有 baseline.json、summary.json、completion.json、focused-summary.json、每项 stdout/stderr/result/standalone 报告。实际代码包含两项断言包装和 runner 收尾修改后又以同样精确场景验证，不使用旧产物报告代替本轮结果。

首次异常、各次退出及最终命令/输出保存在本批恢复目录 `verification.json`，`implementation-hashes.json` 绑定最终文件，原 baseline/files 不变。受控用例刻意输出 failed/blocked/evidence-error，均为预期 fixture，不能当作产品失败。

未运行 npm test、test:window-frame:win、任何 full/完整回归、其余 DB、真实产品 GUI/window matrix、capture/Qt/native、安装、性能、发布或客户机器专项；没有应用/native 构建。存储通过不覆盖真实重启、客户设备或所有业务断言质量。

### 21.6 回退、剩余项与 B0d 起点

回退只恢复本批 snapshot 中的 8 个已有代码/测试和 README/01/04 的本批增量；撤回 6 个新增文件前确认没有后续用户修改，并成组恢复 manifest/两包装/full 消费者。不要 reset/clean 全库，不覆盖上一批未提交成果、原 S3/S4 指导、真实用户资料或第一次失败证据。产品数据/产物没有迁移，不用旧数据库或 DLL 覆写当前状态。

下一子批 **B0d**：

1. 先核对本批基线和真实部署前置；实现已选构建依赖的精确执行及复用来源认证，未知/缺失/ABI 不符时阻断或明确必要重建，不全编 native/Qt。
2. 修复旧 full selectJobs 对未选 requires 的裁剪，保留完整依赖；Qt 严格名称和匹配数量，无匹配不是通过。
3. 同一子批切换 package 默认入口及 DB/window/CI/release/README 调用；空选择非零，不让普通 CI 或小改动退回合集。
4. 为 full 与未迁移域明确 adapter/未证明的过渡策略；不把当前 legacy unproven 当成已解决，不给全部旧脚本自动加数字。
5. 继续仅按本批实际文件和功能边界验证。此处为 B0c 收尾时的历史起点；后续结果见 §22 及各域实施记录。

## 22. S5 B0d：2026-10-09 构建选择、来源与入口

### 22.1 实施与恢复

本批恢复基线：`tmp/refactor-baselines/B0d-2026-10-09T00-43-28-652Z-7c777b`，617 个代码/配置/指导文件、78 个实际产物（46,431,948 bytes）；B0c 的259项收尾哈希无漂移。包含既有 out、blur DLL、Capture build/deploy 的匹配副本。本机受限 shell 初始化持续报 helper_unknown_error，命令从适用的沙箱外环境执行，不将其算作业务失败。

新增 build provenance/descriptor/jobs 与单项 CTest launcher。保留完整 requires；full selected-retest 不再裁掉未手工列出的依赖。focused 只构建具有可执行结果适配器的消费者所需依赖；全部消费者缺 adapter 时不浪费构建。纯单元没有 app/native 前置。

来源 proof 使用明确输入目录完整清单、源码/配置/安装依赖/工具/输出 SHA、mode、环境摘要、ABI 声明及独立不可覆写 attempt。输入或配置变更、新增文件、损坏的最新证明、未知工具链闭包均拒复用。app/notice 的完整本地依赖树纳入记录；本批未用实际 app 构建发证，因此只声明纯 helper/descriptor 验证有效。native 的 MSVC/SDK/Qt 完整外部闭包仍未认证，rebuild 输出记录为 provenance=unverified，`reuse-verified` 拒绝；ABI 声明不伪装成实际探针。

Capture CMake 的 Test/七目标/input driver 默认 OFF，普通产品部署不变；每次显式覆盖缓存开关。build.ps1 的 -Test 必须给准确 -TestName，执行必须给新 ResultDirectory，TestsOnly 只编选定测试，BuildOnly 不执行 CTest。运行时报告目录由 CTest wrapper 取当前 attempt，不为复测重写缓存。验证 exact CTest 名称、内层 QTest 业务用例、报告时效/完整性，零匹配、全跳过、缺报告不通过。

package/DB/window/Qt/default entry、普通 CI、release quality、README/testing/native 文档同批接通。空选择/错误角色非零且不执行；unit 仍支持具体文件位置参数。普通 CI 使用完整提交基线和提交差异、明确已核实映射，source-read/import只提示候选；未映射域需要单独验收，不能 fallback all。发布 quality 保留明确旧 unit+DB7+storage2 范围；缺域 adapter 严格阻断，发布构建/上传职责保留，本轮未执行。

### 22.2 实际局部验证

- 本批 11 个指定单元文件首轮205/213；Capture参数保护的8项被PowerShell执行策略先行阻断，测试缺少与产品命令相同的ExecutionPolicy Bypass，修正后四个实际变化文件87/87。随后补显式外部只读Windows工具硬链接保护，与 B2a局部验证一起运行 provenance 的最终35用例通过。上述11文件有效结果合计214用例；不是全库结果。
- 本批20个脚本/测试文件最终 ESLint 退出0；只格式化本批实际文件。首lint的unused变量/regex转义和局部风格问题已修，首输出保留。
- 真实单项 Qt focused：`tmp/test-runs/2026-10-09T01-03-09-272Z-S5ee1R`，build-capture及core专项均accepted=true；QTest排除setup/teardown后7/7业务用例通过，CTest exact目标=1，evidence/cleanup完整。build provenance明确unverified，不发原生复用证书。
- 独立私有目录 tests ON 只编 core；同目录显式重配OFF后CTest tests=[]，输出 `tmp/b0d-ctest-off.json`，没有执行其它六项，也没有修改原产品部署产物。
- 首Qt尝试遇到系统PowerShell的合法WinSxS硬链接被过严工具输入规则拒绝；改为只允许显式外部工具只读稳定哈希，源码/输出/proof硬链接仍拒绝。第二次遇到并行B1新资产尚未登记，执行前即拒；两次现场保留，第三次有效通过。

原始单元证据：`tmp/b0d-unit-results.json`、`tmp/b0d-unit-corrected-results.json`、`tmp/b2a-unit-results.json`；Qt失败/最终独立attempt均保留。参数空选、未知名、路径和旧证据保护在指定unit内实际执行。未运行npm test无参、任何full/窗口合集、七Qt全集、CI、打包/安装/发布或客户机器验证。

### 22.3 回退与后续门槛

package、入口、workflow、manifest、focused/结果/来源消费者、CMake/build/wrapper和文档成组恢复；新脚本与测试只撤回本批文件。必要时从本批artifacts恢复对应原产物，不能将陈旧数据库复制回用户目录。私有构建与失败证据保留，不执行全库reset/clean。后续域逐个迁移真实结果adapter，补source-read/CI映射；native外部工具闭包、实际app发证、客户设备/多DPI/安装验证仍未覆盖，不称全面通过或发布就绪。

## 23. S5 后续域进度（历史中间状态，最新见 §24）

- B1a/B1b/B1c 已实施、局部验收，详见 [05-b1-settings-implementation.md](05-b1-settings-implementation.md)。保持scope/schema/path与完整写协调，65单元、39磁盘SQLite、30三页面断言通过；实际app构建通过，native产物仅作运行前置。
- B2a 简单app/update注册及 B2b workspace共享能力实施中；B3c/B5b 数据库域、B5a完整命令、B7a sticky命令并行分域推进。尚未验收的域不预填通过。
- 当时执行将“连续完成全部批次”解释为继续实施；2026-10-09 自动审批依据用户前期准备限制拒绝新增业务写入门禁，之后所有代码写入停止。当前边界和精确状态以 §24 为准；保持不自动全量、不发布、不删除全部旧测试。

## 24. 全部批次准备完成与代码暂停时的真实状态

### 24.1 授权边界与未落盘补丁

2026-10-09，自动审批拒绝 `functions.exec` 内 `tools.apply_patch`：拟新增 `src/main/application/business-mutation-admission.js`、`tests/business-mutation-admission.test.js`，并包装 `register-business-ipc.js` 的多类mutation。拒绝理由是用户明确要求测试、解耦、审查准备完成后才修改代码，该补丁超出明确授权且有业务回归风险。整批未落盘，两新文件不存在、业务IPC无runMutation/mutationChannels。

此前会话已经产生业务、测试、配置和构建/CI改动，不能描述成“始终未修改代码”。主代理收到拒绝后让全部代理停止代码写入；未通过换工具/拆补丁绕过，未擅自回滚dirty工作区。后续只补指导、只读核对与文档状态。下面表格是暂停时的真实状态，不能作为全项目通过或发布批准。

现有恢复基线、首次失败、各attempt和产物证据继续保留。全量/发布/安装/部署不在本次范围。

### 24.2 27 个子批状态与指导

全部27子批均有具体实施指导。下表中“已局部验收”只指列明的当前子域；“部分实施”意味着尚有生产迁移或验证缺口。

| 子批 | 当前代码与验证状态 | 具体指导及下一步 |
|---|---|---|
| B0a | 已保存本批恢复基线和所有权清单 | §20，保留原有dirty与各域基线，后续更新准确来源 |
| B0b | 登记/纯选择已实施，指定4文件92用例 | §20；未审资产保持unreviewed |
| B0c | 局部调度/结果协议与两存储适配已实施，6文件140用例、附件30/壁纸53实际断言 | §21；其他legacy模式不可只凭exit0准入 |
| B0d | 构建/Qt单目标/来源/默认入口/CI已实施，指定214单元及单Qt core 7业务case | §22；工具链闭包未证实的reuse拒绝，最终CI映射仍待B7b |
| B1a | settings repository已实施，真实磁盘专项有证据 | [05设置](05-b1-settings-implementation.md)、[Q001](05-q001-reset-transaction-implementation.md) |
| B1b | 唯一settings values/revision/session gate已实施并局部验收 | 05设置；深冻结读值与clone快照保留 |
| B1c | 窄读/写接线已实施，完整旧写协调保留 | 05设置；最终副作用owner交B4f，不能标B4f已完成 |
| B2a | 三app/update IPC注册已移交，21unit与真实preload17断言 | [06 IPC](06-b2a-app-ipc-implementation.md)；subframe未验证 |
| B2b | workspace/wallpaper/notices/update共用能力已迁移，35unit及实际modal专项 | [06 workspace](06-b2b-workspace-implementation.md)；App/Month有意差异保留 |
| B3a | Host唯一身份已移交 | [08 Host/geometry](08-b3ab-window-geometry-implementation.md)，与B3b九文件36unit、真实36断言 |
| B3b | 普通geometry dirty/timer/suppression已移交 | 08 Host/geometry；compact/dock暂态仍归后续域 |
| B3c | DB候选/唯一连接/关闭与引用已移交，runtime专项25实际断言 | [07 DB恢复](07-database-recovery-implementation.md)；历史迁移fixture未全覆盖 |
| B3d | bootstrap/shutdown及remote迟到gate已实施，27unit、真实两进程32断言 | [08 lifecycle](08-main-lifecycle-implementation.md)，日志屏障保留原will-quit |
| B4a | Blur/ZOrder叶owner已迁移，13unit、真实最终52断言 | [09窗口](09-window-runtime-implementation.md)；一次overlay确认失败未解释，不能称根因修复 |
| B4b | 尚未迁移生产Dock owner | 09窗口B4b完整状态/消费者/端口/真实app验收指导 |
| B4c | 尚未迁移生产drag owner | 09窗口B4c，按session/单位/释放完整移交 |
| B4d | 尚未迁移生产Presentation集成owner | 09窗口B4d，复用原controller，不新建另一主窗口 |
| B4e | 尚未迁移生产Navigation owner | 09窗口B4e，保留单窗口/draft/ready/当前view门禁 |
| B4f | 尚未迁移Background/SettingsWrite完整协调 | 09窗口B4f，SQL/文件/原生副作用及失败补偿顺序闭合 |
| B5a | note完整命令已移交，7unit及真实SQL/附件授权fixture52断言 | [07命令](07-b5a-note-commands-implementation.md)；fixture不是完整renderer |
| B5b | DB恢复/清空已移交并验收；应用clear准入缺陷成立但未修 | 07 DB恢复、[15审查](15-b7b-data-review.md)、[16门禁/装配](16-b7a-feature-and-clear-guidance.md)；先排空旧完整命令再clear |
| B6a | 三模式模型已迁移；真实66/17/79断言；最后anchor补token后的22unit通过，最终两GUI未重跑 | [10列表](10-b6a-list-implementation.md)；新build消费最新源，不能拿旧out验收 |
| B6b | Q004最小生命周期及月/周模型已改，最后8模型+2生命周期用例；天气/preview未迁，最终lint退出1/9个unused错误，build/GUI未完成 | [11日历](11-b6b-calendar-implementation.md)；先处理实际lint错误，再验对应GUI |
| B6c | settings唯一写队列已实施，12竞态unit；与B6d真实50断言 | [13队列](13-b6c-settings-write-queue-implementation.md)；未真实写OS自启 |
| B6d | Dock/Sticky实际form/section已拆，与本域合计29unit、10文件lint、真实50断言 | [14表单](14-b6d-settings-sections-implementation.md)；170条CSS迁移不称像素认证 |
| B7a | sticky命令、capture恢复已迁移；feature/tray/activation/weather尚未实施 | [12 sticky](12-b7a-sticky-implementation.md)、[12 capture](12-b7a-capture-window-implementation.md)、16；capture20unit+真实synthetic18断言，native input未验 |
| B7b | 部分CI显式映射及40unit已做；剩余映射/metadata/source-read/撤兼容未实施；R审查/处置指导已补齐 | [17运行域与测试处置](17-b7b-runtime-review-and-test-disposition.md)、15；不得批量删除旧测试或预填verified |

### 24.3 T/D/R/C 防遗漏账

| 编号组 | 本次结论 | 未完成或保留边界 |
|---|---|---|
| T-001 | B0及各域有恢复基线、失败证据 | B0d事后hash仅qualified当前观察，不伪称当时immutable；后续新增改动重新保存 |
| T-002/T-003 | 登记/明确局部选择已实施 | contracts/disposition仍多为unreviewed，source-read随未迁域继续补；不自动related/changed |
| T-004/T-005 | 选择必要build、来源/模式/attempt/业务/证据/清理协议已实施部分域 | legacy专项尚无全部adapter；native工具链closure/平台差异显式保留 |
| T-006 | 已迁域同步处置，17列具体保留/改写/候选 | presentation/dock等旧定位尚未改，所有未改资产未逐断言全审；无批量删除 |
| T-007 | settings/DB/draft/资源恢复有具体证据，Q001已修 | clear新旧写准入尚未修，所有历史迁移/崩溃点/OS真实状态未全证 |
| T-008 | 模板、日期、提醒round/channel规则已读分类 | 现有历史skip/独立阈值保留；系统toast真实点击/冷启、DST/恢复不冒称验证 |
| T-009/T-010 | 窗口/native叶、capture业务、列表/设置/IPC已有精确证据 | 其余真实窗口/日历/输入、macOS、多屏、网络/报表/性能按实际改变契约独立选择 |
| T-011 | CI提交范围选择与release职责已分离，部分规则验收 | 剩余规则只有消费者验收后准入；未运行云端workflow/发布quality |
| T-012 | 每域指导及总索引已核对真实状态 | 所有未实施项继续标未实施；未来命令实现后再更新用户使用说明 |
| D-001/D-002 | 所有权地图与生命周期部分移交 | 最终状态销账、剩余feature部分启动/释放仍待实施 |
| D-003–D-006 | settings/Host/geometry/native叶已移交 | B4b–f完整state/timer/listener/transaction仍须按09指导移交 |
| D-007/D-008 | appIPC、完整note/sticky命令、repository/DB/recovery已移交 | clear准入及复杂域IPC随owner同步接线；不能拆散完整事务 |
| D-009–D-011 | root共享能力、list、settings queue/forms已移交，calendar部分 | anchor最终GUI、日历辅助/真实专项待完成 |
| D-012 | sticky/capture部分已移交 | feature/tray/activation/weather完整创建与退出台账尚未实施 |
| R-001–R-006 | 15逐项完成本次审查分类，保留保护/风险/规则/环境边界 | clear缺陷待修；全部历史迁移、模板/提醒平台行为未全验收 |
| R-007–R-016 | 17逐项完成本次运行域/结构/测试审查分类 | 未迁owner、frame可达性、旧源码定位、CI收尾和平台风险不假消账 |
| C-001–C-004 | DB/settings/resources/draft有匹配的部分实际证据 | 清空并发和任意崩溃、所有旧迁移/restart仍有限制 |
| C-005/C-006 | 现有日期/调度/round规则已审保留 | 本次没有全跑模板/提醒；真实OS/时区恢复场景未证 |
| C-007/C-008 | Host/geometry/native叶及capture恢复部分证据 | B4余域、overlay瞬态、多屏/真实截图输入未证 |
| C-009/C-010 | workspace/list/settings有局部与GUI证据；网络策略已读保留 | calendar最后源未验、真实网络/全UI组合未证 |
| C-011–C-013 | 日报/诊断/安全/性能边界有审查指导，部分退出/IPC证据 | 包/安装/macOS、全路径隐私、benchmark/长期/客户行为未证 |

### 24.4 明确授权后的执行顺序与最后门槛

1. 核对现有dirty恢复来源；先收尾Calendar unused/最后anchor验证和成立clear竞态的完整准入，保持旧数据、文件补偿和提交后成功语义。
2. 按09的B4b–f依赖迁移。每域完成state/timer/listener、调用方、真实必要保护后再继续依赖批；不以薄包装/巨大context达成“解耦”。
3. 完成16的activation、tray、feature/天气生命周期及部分启动/退出台账。clear gate必须覆盖绕路sticky、模板/activation任务和最终截图业务提交。
4. 完成17的reviewed metadata/CI叶映射/source-read、旧定位改写、必要兼容撤除与测试处置；所有新目标真实存在、角色/模式正确，未知范围无全量fallback。
5. 在稳定源下唯一协调build，分别执行实际改动所需局部文件/平台专项；最后记录当前source/output/ABI、原始退出、业务断言、首次失败、evidence/cleanup。无全量/安装/发布授权，不执行相应入口。
6. 更新准确最终状态与剩余风险后才可标具体子批验收。仅准备文档完整不能标B0–B7代码完成；局部通过不能标发布就绪。

暂停后的只读一致性检查：270登记资产无登记错误，322字面import源码未见环；实际唯一import index者为顶层日志bootstrap。该结果不是完整语义审查/业务测试；具体限制见17。后续任何源码变化使旧out不能证明最新Calendar/anchor状态。

## 25. 明确授权后恢复实施（2026-10-09）

### 25.1 授权与协调

全部准备指导完成后，用户明确回复“确认，直到完成。你有最大权限，最大方便。”，授权恢复剩余业务、测试、配置和CI实施，并连续完成全部批次。§24记录暂停时历史，不再是当前阻塞。admission新增补丁通过正常审批落盘，没有绕过历史拒绝。

本轮恢复基线：`tmp/refactor-baselines/B7b-resume-2026-10-09`。保留所有原dirty、原基线、失败证据和产物。仍只按实际改变契约选择局部验证；未取得全量回归、安装、发布或部署要求。三个代理各自拥有窗口/index、业务准入/feature、renderer/窗口专项；主代理拥有registry/CI和统一build/桌面调度，避免同文件写入和桌面并行互扰。

### 25.2 恢复后的运行记录

- B7b登记修正：已审查保护采用具名contracts/features与 `reviewed-protection`，并显式标注“不等于本次通过”。未审资产继续unreviewed，不批量升级。source-read z-order定位移交实际叶owner；admission/feature等只有消费者验收后才加入CI叶规则。
- B7b本轮三个具体unit文件41/41通过，证据 `tmp/b7b-resume-infra-unit-results.json`；其中fixture模拟blocked/不存在commit是预期基础设施行为，不是产品失败。主代理五个实际脚本/测试lint退出0。
- B4b Dock owner已迁移，真实app专项 `tests/dock-runtime-electron.mjs` 已新增登记，覆盖单个左边缘的native终点、代次、queued show、嵌套suspend、配置关闭、几何暂态不落库和shutdown资源终态。命令驱动不冒称真实指针输入/拔屏/系统休眠。真实执行待稳定共享build。
- B6b preferences和根接线完成，五unit文件28/28通过，原9个unused问题已清；严格lint退出0。新calendar专项已创建登记，分别检验生产clear同文档重建和独立month→week整页切换，天气IPC模拟边界写进结果模式；最后真实执行待共享build。

本节继续追加实际结果。当前不得将正在迁移或等待运行的B4c–f、clear完整准入、feature/tray/activation或日历GUI写成已验收；最终27子批状态在收尾时逐项更新。

- B5b完整准入的磁盘专项最终30/30实际断言通过，证据 `tmp/test-runs/2026-10-09T02-47-03-050Z-CTNR42`。生产registerer、SQLite与附件真实，IPC sender是进程内授权fixture，无renderer；不把它代替真实app清空链。首次 `02-45-21-624Z-M2ib6t` 在恢复准入场景因fixture标签超过10字符失败，随后修合法名称与sync返回读取，保留首失败。中间一次新helper未登记被registry在执行前拒绝，无业务执行。
- 两个原真实窗口专项已迁移recorder与窄生命周期helper：titlebar保留原六组合输入，Presentation保留HWND、compact/拖动/resize/几何/导航，并补实际renderer ACK timeout恢复；模式和模拟/禁GPU边界明确登记。三个文件严格lint与语法检查通过，真实运行仍待统一build。
- 交叉审查继续检查退出竞态：clearTask须被外部shutdown drain等待，Navigation须取消queued/ready并拒绝迟到draft/background切换；具体修复与验证由唯一owner完成后再写结案。

- 最终gate磁盘clear再跑30/30，`tmp/test-runs/2026-10-09T03-16-14-982Z-z6XxuD`。registry/focused/CI/selection/entrypoint五指定unit109/109，`tmp/b7b-freeze-infra-unit.json`；诊断/native定位两文件11/11，`tmp/b7b-source-consumers-unit.json`。fixture内不存在commit/blocked任务是预期基础设施分支。
- 首次冻结共享构建 `tmp/test-runs/2026-10-09T03-17-06-973Z-lpK69s` 的build-app/build-capture成功；实际应用因SettingsRuntime构造时同步读取尚未创建的Navigation而TDZ退出。前三个应用专项保留真实failed报告；capture业务未完成，后续选择未运行。主代理核实owned runner PID与子树后精确终止，记录 `tmp/refactor-baselines/B7b-shared-startup-failure.md`，不将未执行项计为产品失败或通过。修构造顺序后须重新build与原精确集合。
- 继续只读审查发现Reminder Windows失败回调在clear门禁关闭期间被丢弃，clear SQL失败后旧round保留却无法重试。受控生产模块复现成立，修复在合法准入时只处理仍存续的旧round失败；clear成功删除round及shutdown需丢弃迟到事件。此项不是实际系统toast接收/点击证明，尚待定向修复验收。

### 25.3 最后生产源与真实专项

首轮启动失败已修：SettingsRuntime接受不可变schema seed，动态mode仍归Navigation；Geometry/Dock/Drag对后置能力用窄惰性端口。定向回归先红15/17，修后35/35；构造期独立核对21个工厂，未发现其他必然TDZ。index孤立迁移注释用明确补丁清理，代码tokens及去位置元数据AST相同，architecture9/9；最后index SHA256 `70ae0005c888f60e4d32566e7fa40688470dce3a4e6515600c5613e3b255cd58`。

Reminder晚到失败采用当前delivery token及不可变round/attempt身份，封闭期间只记录内存；下次合法tick仅对仍active、便签有效且身份相同的round恢复失败位。成功clear的refresh清除旧token/待处理失败，旧回调不能影响新round；dispose清空内存并阻断SQL。受控红/绿复现见 `tmp/refactor-baselines/B7a-late-reminder-failure`；三个指定unit25/25（与54项存在重叠，不相加），`tmp/b7a-reminder-late-failure-unit.json`，lint通过。

稳定源第二次共享构建及串行精确专项：`tmp/test-runs/2026-10-09T03-28-40-290Z-oElUD0`。build-app的输入/工具链闭包证明为verified；build-capture仅构建产品前置且闭包未认证，没有执行七Qt测试或重写ABI18。下列通过项均raw exit0、accepted=true、业务completed、证据与脚本/runner cleanup complete。该attempt整体17jobs/16accepted/1failed，不能把整体写成通过。

| 具体专项 | 实际断言 | 本次覆盖及边界 |
|---|---:|---|
| application-lifecycle | 32/32 | 两独立app进程、正常/重入退出、最终日志与磁盘重开 |
| background-navigation | 62/62 | 真实190ms壁纸退场、最新月/周目标、同HWND、SQL作用域、native健康与真实SQL触发器失败回滚 |
| business-clear-admission | 30/30 | 磁盘SQLite/附件及生产registerer，sender为进程内fixture |
| calendar-workspace | 41/41 | 月/周真实页面、生产同文档clear重建，慢响应/天气在IPC边界受控 |
| capture-business | 18/18 | 实际app恢复与业务提交，synthetic transport，非真实截图输入 |
| dock-runtime | 38/38 | 实际左侧Dock/native终点、queued show/suspend、几何与资源终态；命令驱动 |
| native-leaf-runtime | 52/52 | 实际Blur/ZOrder健康；保留早先Overlay确认未收敛失败 |
| note-list-custom | 17/17 | 最后anchor token源的真实自定义列表 |
| note-list-refresh | 66/66 | 最后anchor token源的真实时间线 |
| presentation-mode | 89/89 | 同窗口/HWND、compact几何、真实ACK timeout、恢复和suspend归零 |
| settings-queue | 50/50 | 三view真实设置表单/队列，非真实OS自启写入 |
| settings-runtime | 36/36 | 同窗口跨view设置/几何接线 |
| sticky-persistence | 52/52 | 实际便利贴窗口与内存SQLite，退出同步last-bounds及资源释放 |
| titlebar-native-drag | 137/137 | 六个titlebar/layer组合的真实输入与窗口坐标；原禁GPU测试配置保留 |
| feature-runtime | 31个断言已过，业务未完成 | fixture将Function当executeJavaScript最终值导致clone失败，原exit1/cleanup failed保留；只修测试返回值，正在单项复跑 |

Feature测试修复仅加显式void，生产/out未改变。后续通过正式focused入口核对build-app来源后单项复跑，不复跑上表已有效通过的14项。native工具链未知的reuse仍拒绝，不借此为DLL或Qt发复用证书。

### 25.4 两个单项收尾与B7b验收

Feature单项 `tmp/test-runs/2026-10-09T03-34-16-718Z-ygxBDo`：正式build-app复用核验true、mode=build-reuse-verified，实际feature **40/40**、raw0/accepted=true、业务/证据/脚本及runner清理complete。旧31断言后clone失败保留，不修改原run总体失败状态。

Reminder缺陷补实际store验收，增强现有business-clear MJS而未新建广域合集。`tmp/test-runs/2026-10-09T03-41-04-777Z-Clk3cP` **58/58**、raw0/accepted=true、业务/证据/清理complete：生产ReminderService及实际磁盘db-reminders，真实SQL trigger让clear回滚；sealed回调/tick无prepare SQL、旧round恢复重试；成功clear后刻意复用完整durable身份仍被delivery token隔离；shutdown/dispose晚回调零SQL。OS accepted/failed transport明确模拟，无真实系统toast结论。此前30项仍是其时有效结果，58包含它们，不能相加。

B7b最终10个具体unit文件130/130，`tmp/b7b-final-mapping-source-unit.json`，含实际registry中每个CI叶目标可执行、单Calendar模型精确选择、广域入口/schema/native不全量fallback和最后root源码消费者。前一五文件111项与此重叠不相加；本批九个实际脚本/测试严格lint退出0。

最终静态审查 `tmp/b7b-final-source-audit.json`：334个源码、287登记资产（266 test/13 helper/4 fixture/4 build）、69个reviewed保护范围，parse/literal import/registry错误=[]、字面环=[]，唯一index消费者为顶层bootstrap。明确消费者/source-read与CI叶规则已补齐；reviewed不是本次pass，未审资产不批量升级，cost仍unmeasured。工具检查不证明全部语义/动态依赖/用户环境。工作分支main，diff空白检查通过。

### 25.5 全部27子批当前状态

以下“完成”指约定迁移、消费者、指导与指定局部门槛完成。§24的暂停表继续保留为历史；本表不表示完整回归、全部历史数据库迁移或发布就绪。

| 子批 | 当前完成内容与验收 | 指导/限制 |
|---|---|---|
| B0a | 恢复基线/状态与所有权清单完整 | §20及各域独立基线，原dirty保留 |
| B0b | 资产登记、明确纯选择及错误角色/空选择保护 | §20/17；未审资产不认证 |
| B0c | 局部调度、结果协议、附件/壁纸真实存储adapter | §21，30/53实际断言；legacy未适配域保留 |
| B0d | 必要build/来源/Qt单目标/默认入口/CI职责 | §22，214局部unit及core7；native闭包未认证 |
| B1a | settings repository与事务/存储scope | 05设置/Q001，磁盘专项保护 |
| B1b | 唯一values/revision/session gate | 05设置，B4修不可变seed，动态mode不复制 |
| B1c | 窄设置读写及消费者完成 | 05设置/09，最终跨view36、queue50、背景62 |
| B2a | app/update授权注册完成 | 06 IPC，21unit/真实preload17；subframe未验 |
| B2b | workspace/wallpaper/notices/update共享能力 | 06 workspace，35unit与modal专项；有意产品差异保留 |
| B3a | 主窗口唯一身份/代次Host | 08 Host，真实同窗口/HWND后续专项继续验证 |
| B3b | 普通geometry dirty/timer/suppression | 08 Host/09，跨view36、Dock38、Presentation89 |
| B3c | 数据库候选/唯一连接/关闭owner | 07 DB，runtime25；历史迁移矩阵有限 |
| B3d | bootstrap/shutdown/remote终态 | 08 lifecycle，本轮两独立app进程32 |
| B4a | Blur/ZOrder叶owner及消费者 | 09，native52；早先Overlay失败根因未确认 |
| B4b | Dock完整状态/timer/listener/native会话owner | 09，11文件51组内保护、真实Dock38；单左边缘命令驱动 |
| B4c | Drag与坐标转换owner | 09，实际六组合titlebar137；混合DPI未验 |
| B4d | Presentation完整commit/recover/ACK owner | 09，真实89含timeout；迟到退出保护红绿 |
| B4e | Navigation/view/draft/ready/queued目标owner | 09，同窗口跨view36及背景互斥62 |
| B4f | Write/Background完整副作用、补偿、settlement | 09，真实背景SQL失败回滚62、settings queue50 |
| B5a | note完整SQL/附件/草稿命令 | 07命令，7unit/授权fixture52；非完整renderer证明 |
| B5b | recovery/reset与完整clear准入/排空 | 07 DB/15/16，真实磁盘58＋真实app40 |
| B6a | 三列表模式/会话/item移交 | 10，最终Timeline66/Custom17；Tag79为其阶段证据，本轮未重跑 |
| B6b | Calendar模型/preferences及root接线 | 11，28unit/真实41；天气/慢响应IPC模拟 |
| B6c | 唯一设置写队列 | 13，29组内unit/真实50，OS自启写入未证 |
| B6d | Dock/Sticky form与section | 14，CSS语义保留/真实50，未作像素全集认证 |
| B7a | sticky/capture/feature/tray/activation/weather生命周期 | 12/16，capture18 synthetic、sticky52、feature40；Reminder真实store58 |
| B7b | 审查处置、实际owner读路径、reviewed metadata、CI叶规则、结案 | 15/17，本轮最终130unit/九文件lint、静态无错误；云端CI未跑 |

### 25.6 防遗漏账与收尾边界

T-001–012：来源、明确选择、结果/构建协议、有效测试保留/定位迁移、必要竞态与真实资源保护、CI及指导完成本次范围；未适配legacy、未审资产、未知native闭包和全量/发布门槛不伪消账。D-001–012：约定owner、状态/timer/listener/事务、调用方和退出归属完成；没有用可写巨大context或duplicate view owner替代迁移。R-001–016：分类审查、成立缺陷与红绿/真实接线证据、保留规则及平台边界已写入15/17。C-001–013：本次修改契约的对应证据可追溯，未改域/全部组合按原指导独立触发。

未运行全量unit/窗口状态矩阵/Qt全集、云端workflow或release quality，未打包/安装/升级/卸载/发布/部署。剩余风险包括旧Overlay偶发确认不收敛、多屏负坐标/混合DPI、Explorer/真实休眠、电源/会话恢复、真实截图指针/剪贴板、toast关联/冷启、macOS、实际外网天气/更新、客户环境、长期/性能/任意崩溃/磁盘故障。无法安全取消的已准入IO须排空而不能超时强关DB，不声明任意用户IO有界。

本次工作无需逐批再询问继续。以后实际改动仍按任务自身文件/契约选择；跨域明确列范围，未授权全量不自动升级。需要回退时按各域基线比较并成组恢复本次owner/消费者/测试/入口/产物，保留用户dirty与失败证据，禁止全库reset/clean或用旧用户DB覆盖新数据。

最终文档核对：23份指导、72个Markdown文件链接目标与27子批当前表均无缺项，`tmp/b7b-document-links-audit.json`；它只检查文件目标和显式批次表，不替代文案/anchor语义审阅。最后 `git diff --check` 退出0，HEAD仍 `4fbc52be1c688dba9cf23fbbd51539606efbf381` / main，未提交或推送。index、ReminderService及两最后修复测试的SHA与各accepted时版本一致，未在验收后修改生产源或out。

## 26. 最终集成差异审查（2026-10-09）

用户在27子批完成后同意继续最终集成审查。本阶段约定审查、五项修复和局部验收已完成，基线、具体修改步骤、回退与剩余风险见 [18最终集成审查](18-final-integration-review.md)。§25保留上一阶段具体版本和证据，不因后续修复而改写原attempt或原结论。

### 26.1 本阶段修复与准确范围

I-001迁移漏接custom日常总数；I-002测试错误要求darwin执行Windows adapter；I-003基线compact恢复被Dock写成expanded尺寸；I-004基线storage recovery一支失败后未等待另一支；I-005基线自定义>100条刷新因DB单页上限丢已浏览范围。分别完成ref连接、受控平台规划、Presentation恢复分流、allSettled启动排空与分批原范围刷新。public schema、单页上限、ABI18、产品策略与UI样式保留。

相对阶段进入时200文件inventory，本阶段变化18份：6生产文件、8测试文件、1runner协议同步脚本、3指导文档；准确列表及SHA见18§6与 `tmp/integration-review/closeout.json`。各域修复前快照、首次红/绿和历史失败保留，不将整个dirty归于本阶段，不全库reset/clean。

### 26.2 实际验证与来源

七具体unit75/75、focused/adapter两unit25/25；本阶段15可执行文件严格lint exit0/0error/0warning。四个实际专项：lifecycle57/57、Dock38/38、custom33/33、Presentation98/98，均accepted且业务/证据/脚本与runner清理完整。

首共享build/四专项 `tmp/test-runs/2026-10-09T05-34-50-933Z-fzSX1Z` 总体仍exit1：三专项accepted，lifecycle录得57业务断言但旧two-process mode导致unverified。只同步runner期望mode并验25unit；单项reuse `05-40-43-931Z-WcRLiC` 因Vitest缓存输入漂移被正确拒绝，业务未执行，blocked保留。未还原缓存、裁依赖或伪签证明。

最终单项必要rebuild `tmp/test-runs/2026-10-09T05-46-03-610Z-5k7cva`：app闭包verified，lifecycle三child57/57 accepted，整体exit0。真实失败/延迟恢复SQL先于DB close，pending期间DB开且无窗口，最终磁盘重开integrity通过；仅故障和调度受控。新旧build声明40输出记录、mode/工具链一致，产品源和保留专项脚本无漂移，另三个accepted结果继续有效，不重复其他域。

334源码/287资产/69reviewed范围最终静态无错误或字面环，唯一index消费者顶层bootstrap；24份指导/链接/27子批表收尾审计见 `tmp/integration-review/final-document-links-audit.json`。该静态审查不证明全项目每处动态语义或全部测试通过。

### 26.3 未执行与后续优先级

未执行全量unit/窗口矩阵/Qt全集、云端CI、发布验证、打包/安装/升级/卸载、macOS、客户机、发布或部署；未提交/推送，HEAD与main保持基线。首失败及旧Overlay `zOrderSynchronized=false` 继续保留，当前根因未解决。后续优先按18§6.3复现Overlay，再独立完成真实多屏/DPI/物理睡眠/Explorer/输入、截图/toast冷启/安装重启等具体环境专项；跨分页并发排序的事务快照一致性另需产品契约，不能以本次范围修复冒称覆盖。局部结案不表示发布就绪。

## 27. 第二轮独立深入复查（2026-10-09）

用户质疑收尾速度后，主代理与三名只读子代理重新检查真实消费者、失败补偿和同代次交错。复查与详细修改指导已完成，但项目层面的审查仍不能结案。新增 [19第二轮独立复查](19-independent-second-review.md)，不覆盖18、§25/26及旧closeout。上一轮完成的是约定批次与局部门槛，本轮7项均为HEAD继承问题且尚未修复。

### 27.1 发现与证据

| 条目 | 已确认缺口 | 实际证据 | 当前状态 |
|---|---|---|---|
| SR-001 | 回滚final unlink失败后仍清operation，孤儿附件失去恢复入口 | 真实SQLite trigger rollback→close/reopen→生产recovery，文件/hash不变且事件空 | P2，待实施 |
| SR-002 | clear提交后Reminder SELECT失败截断sticky/draft/broadcast，准入重开 | 原完整handler+Reminder/admission，SQL/窗口端口受控 | P2，待实施 |
| SR-003 | marker/rm双失败+新业务行令历史clear误恢复旧附件 | 真实SQLite clear→新纯文本note→close/reopen→恢复旧字节，旧note记录未复活 | P2，待实施 |
| SR-004 | compact展开后的导航拒绝未补偿本次隐藏 | 实际Electron ACK/window、8个缺陷观察；dirty取消可见为对照 | P2，待实施 |
| SR-005 | custom刷新未完时新页用旧offset造成丢/跳/重复页 | 生产model+原scroll函数，静态数据两种响应顺序 | P2，待实施 |
| SR-006 | custom查询前锚点覆盖用户等待中的新滚动 | 原capture/restore，top400→用户600→刷新400 | P2，待实施 |
| SR-007 | 普通设置timer拒绝被丢弃无反馈，close flush误无失败 | 实际Vue/queue，selected20/persisted16、消息0、flush/dispose fulfilled | P2，待实施 |

先处理数据三项，再窗口/列表和设置；详细顺序19§5的S7a–f。SR-003需内部operation journal与旧格式兼容，SR-001三处补偿同步，SR-002提交后各收尾attempt并准确报告部分完成；SR-004用有owner/窗口身份的隐藏票据，SR-005/006合并同model批次，SR-007保留最新未确认值与可见重试。每项修改文件、消费者、局部测试及停止/回退见19§3/4，未填验收通过。

### 27.2 实际执行与本轮增量

真实磁盘两复现 `tmp/second-review/lifecycle/orphan-real-sqlite-1791527181740-result.json`：Node spawn正式退出0、两profile独立、completed/error/descriptor/DB清理齐全、0BrowserWindow，EACCES注入范围仅fixture目录。真实窗口正式attempt `tmp/second-review/navigation-attempts/2026-10-09T06-15-52-822Z-JzxGVW`：8观察、exit0、证据/清理完整，renderer读取错误与navigation请求受控，实际window/ACK真实。它们观察的是坏状态存在，不能作为修复后绿色产品验收。

另运行当前函数受控数据/窗口复现和Renderer四case；基础设施12门禁场景的1正/11负对照符合预期，6选择边界及两CI规划分支符合拒绝/无tests职责。未运行Vitest、全量或云端CI；脚本、业务结果、证据和清理各自列明。首次Function clone失败、PowerShell GUI缺退出码/报告启动和file URL夹具错误保留，均不冒称产品失败或通过。

本轮仅新增19并修改本索引及04（3份指导），以及 `tmp/second-review/` 分析/复现/证据。475个上一轮可比文件进入时无漂移，本轮文档前699文件快照与最终核对见 `tmp/second-review/summary.json`；业务/正式测试/runner/out及历史报告保持，HEAD/main未变，未提交或推送。原dirty不归为本轮变更。

### 27.3 未收口与下次实施门槛

SR-001–007都待实际实施与同场景正确结果验收；不得把反向“坏状态可复现”的临时断言直接登记为绿色测试。既有保护继续保留，按本批真实修改owner/消费者选择具体测试及必要build，不为小改动全量回归。

Controller同tick no-op→compact只成立于受控API probe，自然UI可达性未确认，不计第8项产品缺陷。旧Overlay根因、真实多屏/混合DPI/物理恢复、截图输入、toast冷启/安装客户机、性能与任意故障边界仍保留。没有新增全量、打包、安装、发布或部署授权。本轮只收口复查和指导，业务修改时按19的恢复/数据保护门槛逐批推进。

## 28. S7 七项修复实施（2026-10-09）

用户明确要求先修复上述已确认问题，再清理macOS运行内容。§27及19保留修复前的历史，不再作为当前待实施状态。七项修改配方、实际文件、数据保护、回退和局部结果见 [20七项修复](20-s7-fixes-implementation.md)。共同恢复基线为 `tmp/windows-only/before-inventory.json` 与 before目录；后续平台阶段从 `s7-accepted` 开始，不能把这些修复一起回退。

SR-001保留删除失败附件的恢复manifest并等待全部补偿；SR-002提交后全部收尾attempt完才释放准入，准确报告部分完成；SR-003用schema18的operation journal与clear同事务判提交，兼容v1 ambiguous；SR-004导航owner与显式hide代次阻止迟到重显；SR-005/006串行刷新分页并在提交前读取最新滚动锚点；SR-007保留设置失败并显示具体未保存项、显式重试、close flush历史失败。均已实施并完成指定局部验收。

数据22、窗口54、Renderer38、helper/登记38指定unit通过，各域严格lint/语法通过。实际附件controller18（child seed2/recover97）、DB30、feature67、Presentation128、settings63、custom54 accepted且证据/清理complete；settings文案调整后的必要重建和复验通过。首次并发缓存导致GUI来源阻断、两次custom夹具错误与所有旧失败保留，不能写成首轮全部通过。证据逐attempt见20，不执行全量/安装/发布。

## 29. Windows 专用平台清理（2026-10-09）

用户澄清macOS删除指平台运行、设置和构建，Apple风格UI保留。具体实施指导、保留行为、消费者、局部验证、恢复及未覆盖事项见 [21Windows专用](21-windows-only-implementation.md)。非win32在业务启动前拒绝；删除vibrancy/Mac Dock运行分支、通知/快捷键Mac策略与别名、Mac builder/script/job/entitlements/ICNS；保留Windows10/11 x64、Windows原生能力、三种提醒方式、内置字体与Apple外观。

源代码支持清理已完成，十个S7关键owner与已验收快照逐字节一致。阶段准确增量与结果在 `tmp/windows-only/final-audit.json`，最终快照保存为 `windows-only-complete`；这个名字不表示全部Windows原生验收通过。当前README/隐私/测试说明/AGENTS、manifest与CI具体消费者映射同步；第三方锁文件与历史证据保留。

指定unit按域35/5/57/45/71及最终登记93均通过（CI18重复执行不计入唯一总数）。平台后必要app build来源verified，真实clear58、feature67、settings63 accepted；提醒与快捷键legacy专项exit0、marker完整、独占profile清理完整，快捷键包含同profile重启，未迁移统一accepted协议。主代理核实际窄窗/背景截图。没有新增全量或打包、安装、发布、提交/推送。

原生leaf正式专项仍失败：`tmp/test-runs/2026-10-09T07-39-50-892Z-hXq5tc` 中glass=true normal→top的IPC未收敛，completed=false、exit1、accepted=false；已记录33条通过不能冒充整项通过。实际主窗口topmost和blur健康正确、Overlay同步false，与此前历史失败同型，未确定根因。保留原始失败profile/日志和严格断言，继续按实际HWND/band链证据定位；不以去除Mac支持掩盖Windows旧问题。源代码清理完成与原生运行验收不全分别登记，局部结果不表示发布就绪。

一次不改源/正式脚本/out/DLL的tmp隔离诊断完成52/52、exit0，probe-end完整但全局链达到256项上限，不能确立完整物理层级原因。证据与profile保留于 `tmp/windows-only/overlay-attempt-qZzEl0`；它说明相同版本有一次成功执行，不能取消已有正式失败或声称旧同步问题修复。实际状态、证据边界和下一步取证配方已写入21，当前没有基于猜测追加native修改。

## 30. 毛玻璃置顶的测试审查与失败取证（2026-10-09）

用户要求先排查测试问题，再仔细查原因，允许必要日志。三份独立只读报告完成：未发现当前profile/seed/ready/节流/断言/report误报，原失败发生于产品IPC确认。精确Overlay探针修正旧全桌面256门槛；原脚本、探针原序列、实际标题栏DOM菜单三次限定对照各52/52，快照已知revision不变。根因未复现，旧失败不取消。

本批只补两条失败日志，原四次检查/等待/重发/确认/提交/错误/回退不变。新增惰性Win32只读采样模块；窗口owner仅最终确认不收敛、回退前一次采样，记录band、句柄身份、可见性、cloaked/iconic、几何/夹层和首尾漂移。两个指定测试文件/manifest映射同步，三份指导索引更新。native源码/DLL/ABI18、正式native-leaf、Renderer UI与用户DB不变；恢复点为 `tmp/overlay-investigation/before/inventory.json`。

最终四指定unit37/37、严格lint/格式通过；必要app build及native-leaf52 accepted，证据 `tmp/test-runs/2026-10-09T09-30-14-390Z-wzTGgJ`。一次明确getter故障注入保留业务exit1/completed=false/33，真实JSONL记录4次原核验和物理快照，验证日志实际可用，不能算自然缺陷复现或产品修复。两次来源启动前阻断、旧失败与所有新独立attempt保留，细节见 [22完整指导](22-blur-topmost-investigation.md) 和 `tmp/overlay-investigation/closeout.json`。

当前只能交付测试审查和取证能力。稍晚非原子观察、无native队列ACK、枚举次数不是FFI硬超时、极端日志截断都明确保留；下一次自然失败按22的分类配方继续窄定位，必要native日志必须同步ABI/bridge/test并重建。未执行全量、安装/发布验证、客户机、多屏/物理恢复/长期压力、提交或部署，不能将本地通过写成旧同步问题已经解决。

## 31. 毛玻璃多组合与失败前缀调查（2026-10-09）

用户要求一个个组合多次尝试，同时排查实际层级失联、短暂过渡和状态读取问题。本阶段形成 [23详细指导](23-blur-layer-combination-stress.md)、三个tmp诊断入口/观察/结果分析及独立只读审查；没有修改生产、正式测试、native/DLL/ABI18或out。第一轮无请求内热采样，第14次glass-on normal→top自然拒绝即停止扩张；其后两个冷启动只重复同一14请求前缀，均在同一步拒绝。

实际42mode（39完成/3拒绝）、6material；每轮132已执行断言无断言失败，但产品IPC拒绝使三轮exit1/completed=false，均非registry accepted，不能把396前置/成功步骤断言称整项通过。三个回退前Win32快照都为main topmost=true、唯一同PID Overlay=false、pairStable=true，双方可见/非iconic/cloaked0。第二轮13请求内快照持续同型，第三轮原FFI重同步确实到达且快速返回，回退后3秒未观察到getter恢复。当前已有物理失联证据，消息队列/STA执行根因尚未确定；3/3仅是本机该前缀结果，不是总体故障率。

玻璃off有向9组合已执行；玻璃on全矩阵、剩余core轮、焦点/夹层/隐藏恢复/跨通道竞争/快速重入因首失败停止未运行。完整链到256上限不影响直接band证据，但完整夹层位置、native绑定代次和队列ACK仍未确认。下一步有界native request/post/dispatch/阶段/BOOL/错误及getter reason日志、ABI同步/重建/同前缀局部验证的详细修改配方已写入23，不能凭候选直接改timeout或predicate。

三原始attempt位于 `tmp/overlay-investigation/stress/`，精简完整汇总为 `tmp/overlay-investigation/stress-evidence-analysis.json`；运行中873路径哈希无变化，最终生产保护范围核对与文档增量见 `tmp/overlay-investigation/stress-closeout.json`。保留22、旧closeout及原失败，不提交/推送/发布。临时脚本语法检查完成；未运行全量、客户机、多屏/DPI、物理输入/睡眠/Explorer、安装/发布验证或长期压力。

## 32. 毛玻璃原生因果验证（2026-10-10，本机局部收口）

用户要求一直重复到原因可反复验证。本阶段实施步骤、恢复点、原生阶段证据、reset匹配A/B、IME候选与独立desktop事件缺口见[24原生因果验证指导](24-blur-native-cause-verification.md)。已经再次捕获真实band失配，排除这些样本只getter误报或post未dispatch；两个冷启动共六组匹配对照均显示重复TOPMOST无效、NOTOPMOST→TOPMOST恢复，bottom历史六次再次引入故障。三原始自然失败及后续正式失败继续保留。

IME独立ABAB固定旧desktop过滤：A1/A2两次第14请求同型自然拒绝；B1/B2各三次14请求完成，实际ImmDisableIME BOOL1且默认IME HWND0。desktop独立ABAB固定IME禁用：A1/A2两次可见owned blocker夹层100ms未恢复；B1/B2各三次自动恢复，各90/90。ABI21只禁用非交互Overlay专用STA的IME并额外接受desktop HWND的CLIENT/SELF，其它线程/输入法设置不改。未加生产band reset、未延长产品确认等待或放宽getter。独立Win32最小程序同机支持证据与未复现轮的边界单独保留，不归因Windows私有算法或WeType。

扩展组合第77请求另失败于托盘show后约1ms的Overlay可见性断言，实际band/相邻/健康均正确。三独立profile保持原断言失败后被动观察，均在首个实际约5–11ms样本恢复并保持；修正仅作用show恢复边界，名义100ms预算不扩张。人为持续隐藏owned Overlay的负对照仍exit1/completed=false，排除测试修正隐藏真实缺陷。退出码另修正局部exitCode与产品logger process.exitCode不一致，正式runner本来就拒绝completed=false。

生产默认、trace关闭完整同域组合三轮各88 mode/14 material/18场景/995断言全部通过，合计264次mode、42次material、2985断言。正式native-leaf补12种off/on×normal/top/bottom×80/550ms隐藏恢复，三轮各598/598 accepted，Dock38/38 accepted；四指定unit63/63、匹配native/app builds、局部严格lint/格式/diff检查通过。正式结果为`tmp/test-runs/2026-10-09T16-04-50-078Z-f7QOkX`、`2026-10-09T16-07-47-303Z-Logca1`、`2026-10-09T16-09-43-479Z-cy9uxv`；临时组合及因果实验保留registryAccepted=false。489个产品源码/native/out哈希在补测试重建后与组合复验一致。

本故障具体10文件增量、实施规则、全部恢复点、异常读数语义、失败/通过索引与本机证据见[24](24-blur-native-cause-verification.md)。旧ABI18/19/20恢复点、三个原始自然失败及后续失败均保留，不以新通过取消历史。未运行全量、安装/发布、客户机、多屏/混合DPI、Explorer重启、睡眠或长期压力；人工IME候选输入与逐像素外观未验证。此处只收口已反复验证的窄机制和局部修复，不承诺任意Windows环境无故障。
