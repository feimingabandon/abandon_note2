# 测试准备与后续修改指导

版本：v1，2026-10-08

阶段：S1 测试准备

状态：设计已归档，所有代码实施与测试执行均未开始。
阶段索引：[README.md](README.md)

## 1. 使用范围与当前基线

本指导将已讨论的测试规则转成文件级修改步骤、风险场景、验收条件和遗漏检查表。实施时先阅读阶段索引及仓库 AGENTS.md；涉及 renderer 的 UI、CSS、主题、控件或浮层修改前，完整阅读 docs/UI_DESIGN_STANDARD.md。

本轮基线：

- 仓库 HEAD：`1111ce29dc57f8459a3f6f783eedad4d92b563c5`。
- 基线包括当前未提交和未跟踪内容，不等于干净的该提交。
- 131 个 Vitest 测试文件；测试清单登记 69 个可执行 MJS 专项、5 个 MJS 辅助文件。
- 原生截图包含 7 个 Qt 测试程序与一个输入驱动，另有 CJS、PowerShell 辅助／专项脚本和 Python fixture。
- 已完成文件清点、入口检查、测试形态梳理和代表性断言分析；未逐条完成所有旧断言的语义验收。
- 当前发现的独立 MJS 文件与登记集合一致，登记路径均存在。这是文件集合静态比对，不是执行 test-manifest 测试所得结果。
- 本轮未执行测试、lint、构建、Electron、安装、性能测试。

附录记录本次读取时的文件集合。后续实施必须刷新清单并对照变化；文件数量不能作为用例数、通过数或覆盖率。

## 2. 目标与保留约束

目标：

1. 小改动选择直接相关的测试，避免无参数入口或错误映射触发大量测试。
2. 测试能证明明确规则，能发现具体错误，避免重复、实现镜像和无效断言。
3. 数据库、文件、跨进程和原生能力有相应真实验证，避免用模拟结果过度推断。
4. 每个测试有归属、环境、成本、前置构建、证据和未覆盖边界。
5. 清理旧测试有可恢复基线、有理由、有替代保护，防止先删后补造成盲区。

保留约束：

- 默认只运行本次任务直接相关的局部测试。工作区原有其他改动不自动加入范围。
- 全量测试、完整回归和发布验证需要对应的明确用户要求；本指导不是运行授权。
- 保留当前产品明确的草稿会话、周期任务、紧凑模式、首次使用、捐赠、统计和更新策略。
- 单窗口列表／月／周视图与紧凑模式的验证，应围绕实际状态切换，不能假定每种视图都有独立窗口。
- 不新增完整备份恢复功能作为测试改造的附带业务范围。
- Windows 10/11 是主要桌面验证目标；现有 macOS 配置的范围需要登记，不在本阶段构建或发布 macOS 安装器。

## 3. 已确认入口问题及对应修改项

| 当前定位 | 已确认现状 | 对应条目 |
|---|---|---|
| package.json | npm test 串行执行全部 Vitest、全部数据库专项和两类存储；test:unit 缺少文件参数会运行全部 Vitest | T-003 |
| scripts/run-electron-node-tests.cjs | 固定执行清单内 7 个数据库脚本 | T-003 |
| scripts/run-electron-window-tests.cjs | 未传组名默认 window-frame；该组含 18 项，超出纯窗口边框范围 | T-003 |
| scripts/test-manifest.cjs | 以文件分组为主，缺少契约、源码依赖、环境及成本元数据 | T-002 |
| tests/test-manifest.test.js | 完整性检查仅针对独立 MJS，不能证明其他测试种类均已登记 | T-002 |
| scripts/run-full-tests.cjs | GUI 项统一依赖原生 blur、capture 与应用构建；capture 构建带 -Test | T-004 |
| scripts/run-full-tests.cjs | 指定 ID 的复测过滤未选择的构建依赖，并记录快照；需要进一步校验复用产物来源 | T-004 |
| native_capture/CMakeLists.txt、build.ps1 | Qt Test 依赖与测试目标无条件定义，普通构建也编译测试；-Test 只控制 ctest 执行 | T-004 |
| scripts/test-runner.cjs | 有超时、隔离、首次失败证据保留；通过判定主要依据退出码 | T-005 |
| 存储专项的两个包装脚本 | 独立启动 Electron，尚未统一使用 test-runner 的完整证据流程 | T-005 |
| .github/workflows/ci.yml | 普通推送／PR 会执行 npm test 和 Windows window-frame 集合 | T-011 |
| .github/workflows/release.yml | 存在较大的发布验证组合，需要与普通变更检查区分 | T-011 |

本表描述静态代码事实，不声称已经观察到测试误通过、陈旧产物误用或运行失败。

## 4. 测试准入与生成规则

### 4.1 必须说明要保护什么

新增或改写前先写一句契约：在什么前提下，执行什么动作，应该观察到什么结果，以及哪些结果绝不允许出现。

预期依据使用确认过的产品规则、接口约定、独立固定样本或可复核的规则表。不得调用被测实现生成期望再与同一实现比较；不得为了兼容现存缺陷把偶然行为写成产品规则。规则不明时标记待核验，先保留相关保护。

每项测试应能说明要发现的具体故障。行覆盖率只用于寻找未探查的分支，不设“每个函数必须有测试”或“必须达到 100%”的生成目标。

### 4.2 选择最小充分层级

| 契约 | 最小充分验证 |
|---|---|
| 日期、输入校验、排序、纯布局算法 | 独立预期的单元测试 |
| 主键、SQL 冲突、事务、迁移 | 真实 SQLite 专项 |
| 数据库与附件／壁纸一致性 | 真实文件系统与数据库集成 |
| IPC、renderer 与主进程协作 | Electron 跨进程专项 |
| 焦点、动画中间帧、窗口交互 | 真实 Electron／Chromium |
| 原生层级、DPI、系统输入、系统通知 | Windows 原生／真实桌面专项 |
| 安装、升级、卸载、依赖交付 | 本地安装包专项 |

真实 SQLite 内存库可验证 SQL 与事务，但不能替代磁盘持久化和进程恢复。进程内模拟重建服务／数据库不能替代主进程重启。

### 4.3 断言与 Mock 的约束

- 使用参数化覆盖同类输入；按风险增加边界、故障、重入、取消、竞争和恢复场景，不机械给每个函数生成同一套案例。
- Mock 用于控制外部边界。不要 Mock 掉测试想证明的数据库、IPC 或原生行为。
- 调用次数和参数断言可以保护边界协议、去重和幂等性；若只证明自造 Mock 返回了自造数据，则不准入。
- 避免整份源码快照、无业务意义的 DOM 结构快照、字符串顺序和内部函数名断言。
- 安全白名单、CSP、架构禁止依赖与明确的 UI 标准可以保留静态契约。能够结构化解析时优先解析；同时写明它不能证明哪些运行行为。
- 低风险文案、注释和无行为变化整理不自动新增测试。布局修改涉及溢出、遮挡、焦点、命中区域或可访问性时，按对应行为验证。
- 核心规则已有同层等价保护时，不为新增文件或重命名重复生成测试。跨层验证承担不同责任时可以保留。
- 测试名称必须说明契约与实际模式，例如模拟交付、真实输入、数据库重载、进程重启；不能用名称扩大证明范围。

### 4.4 稳定性与回归要求

- 受控时间、时区与随机数据；网络使用本地 fixture 或确定性替身，真实网络验收另列。
- 等待状态、事件、事务提交或动画帧，不用固定 sleep 作为唯一完成条件。
- 测试创建的进程、窗口、订阅和文件都有清理路径。故障注入必须可复位。
- 在后续修复阶段建立问题复现，确认失败确由目标断言产生，再确认修复后通过；不能把环境启动失败当成“原问题已复现”。
- 重试说明原因，保留首次失败证据；不得扩大超时、删除断言或改为跳过以获得绿色结果。
- 资源释放检查使用测试实际拥有的对象／目录／子进程，避免进程名全局终止和用户目录清理。

## 5. 登记、选择和结果的目标设计

### 5.1 登记单位与字段

执行登记以独立可运行文件／原生程序为单位，业务契约可按测试组记录。不要求为每个 it 建一份重复 JSON。

| 字段 | 用途 |
|---|---|
| id、file、role | 稳定 ID、路径、测试／辅助／fixture 的明确角色 |
| features、contracts | 业务归属、被保护的契约与预期依据 |
| level、runtime、environment | 单元／DB／存储／GUI／原生／安装／性能，运行模式和桌面条件 |
| sourceDependencies | 实际源码依赖及需要人工确认的间接影响 |
| sourceReadDependencies | 源码文本断言读取的路径，防止 related/changed 遗漏 |
| requires | 应用、blur、capture、通知预览等确实必要的构建与服务 |
| cost、selectionPolicy | 根据实测记录成本；常规专项／显式验收／性能等范围 |
| evidence、cleanup | 断言报告、诊断与截图要求，资源清理责任 |
| disposition、limits | 保留／改写／删除候选／待核验及不能证明的条件 |

修改 scripts/test-manifest.cjs 时保留现有导出兼容性；现有数组可以从统一登记数据派生，避免手工维护两套真相。用例契约说明可先保留在测试注释与本指导，真正需要执行选择的元数据再放进脚本。

### 5.2 选择流程

1. 输入本次任务明确的改动文件或功能选择。日常本地不能直接把全部 git dirty 文件当作任务范围。
2. 找到直接业务契约、对应执行项和源码文本依赖。
3. 公共模块变更列明受影响消费者，选择确实相关的契约测试；发现范围变大时先说明理由和成本。
4. 只补入所选测试必要的构建／环境依赖，按依赖顺序执行且不重复构建。
5. 执行前输出选择清单、选择原因、前置依赖、排除项和未映射改动。
6. 空选择、未知 ID、文件不存在、无映射均明确失败或待核验，禁止退回 all。
7. 需要全量时使用独立显式入口；源码映射不完整不是默许全量的理由。

Vitest related/changed 只作辅助信息。CI 的输入是 PR／推送中已提交的变更；本地输入是当前任务的显式改动清单，两者不能混为一谈。

### 5.3 结果协议

保留退出码、signal、耗时、timeout、launch-error 和 runner-error 等原始信息，增加业务解释：

| 结果 | 判定 |
|---|---|
| 通过 | 选定的目标断言已实际完成；必要证据存在 |
| 业务失败 | 目标业务断言失败，有期望／实际与复现证据 |
| 测试或运行器失败 | 测试准备、断言实现、清理或协议本身有缺陷；不直接命名为产品缺陷 |
| 环境阻塞 | Volta、GPU、DPAPI、桌面条件、工具缺失等在业务断言前阻塞 |
| 依赖阻塞 | 必需构建、服务或前序项失败，目标断言未执行 |
| 跳过 | 有明确原因；不计入通过 |
| 未匹配用例 | 选择没有实际命中；不计入通过 |

退出码 0 只是必要信号，不能单独证明通过。迁移旧脚本时为每个套件建立“执行了哪些契约”的报告；缺少报告标为协议待迁移，不能静默宣称满足新标准。原生 Qt／Vitest 可使用它们的结构化报告，不另造重复断言系统。

## 6. 文件级实施条目（全部待实施）

以下步骤只在 S2、S3 和 S4 全部准备完成后执行。每项实施前刷新基线，确认没有其他人改变相关文件。

### T-001：建立可恢复基线

文件范围：本指导附录列出的测试、辅助文件；当前要修改的 scripts、package.json、原生配置和 CI。

步骤：

1. 记录 HEAD、分支、已暂存／未暂存／未跟踪／已删除文件；标清用户原有修改与本次修改。
2. 保存可恢复的文件内容和索引差异，包含未跟踪测试与 fixture；HEAD 或仅 git diff 不能覆盖全部内容。
3. 对要删除／移动的文件写处置清单，明确恢复来源。已有的 tests/styled-select-menu.test.js 删除状态属于用户基线，不能宣称本轮删除，也不能擅自恢复。
4. 不用 reset、clean 或整库 checkout 获取“干净环境”；需要隔离时另行建立符合任务范围的工作副本。
5. 验证快照能够恢复一个样本，并核对所有拟处置文件都可恢复；不覆盖用户当前工作区进行恢复演示。

验收：基线可追溯、未跟踪文件有副本、删除候选有回收点。回退时恢复本次涉及文件／片段，不覆盖其他用户修改。

### T-002：统一测试资产登记与完整性检查

文件范围：scripts/test-manifest.cjs、tests/test-manifest.test.js；必要时配套登记说明。

步骤：

1. 用附录刷新后的文件集登记 Vitest、独立 MJS、CJS、PS、Qt 程序与 fixture；区分可执行项和辅助项。
2. 逐项确认契约、运行模式、依赖和证明边界，不能只靠扩展名或文件名自动判定。
3. 补 sourceReadDependencies；共享 helper 的消费者作为依赖记录，不改变业务归属。
4. 扩展完整性检查：发现遗漏、重复 ID、缺失文件、无效依赖、循环依赖和 fixture 被当测试运行。
5. 将成本先标“未测量”，实施后按实际数据填写；不根据文件长度猜耗时。
6. 保持已有使用者的导出兼容，阶段性从统一数据派生旧分组。

局部验证：tests/test-manifest.test.js 及因登记接口变化受影响的运行器／选择器测试。

验收：附录资产都有明确角色，缺失登记不能漏报，辅助文件不计入通过数。回退：恢复清单导出和对应消费入口，不能只回退其中一侧。

### T-003：缩小默认入口，支持精确选择

文件范围：package.json、scripts/run-electron-node-tests.cjs、scripts/run-electron-window-tests.cjs、vitest.config.mjs；拟新增共享选择逻辑 scripts/test-selection.cjs 与有行为价值的 tests/test-selection.test.js。

步骤：

1. 为常规入口提供显式文件／功能选择与仅显示执行计划的能力；参数名称在 S4 最终统一，本文不把拟定 CLI 写成已可用命令。
2. npm test 与 test:unit 的常规入口没有选择时提示正确用法并返回非零；保留独立、明确命名的全量入口。
3. 数据库入口能够选择单个脚本。窗口入口不再无参数回退 window-frame。
4. 将“窗口框架”“窗口层级”“便签编辑”“月周视图”“提醒”“截图”等范围按契约拆分。旧的大分组保留为明确的合集入口或迁移别名，并在输出显示实际范围。
5. capture 范围分别登记 host、lifecycle、模拟业务交付和真实输入。当前 capture 组不包含 host，不能继续让名称暗示完整截图覆盖。
6. 选择器拒绝未知、空匹配、无效路径；不得以 all 作为异常处理。
7. 修改 lint:tests 等文件列表，纳入确实新增的脚本和验证文件。

必须验证的选择行为：单文件命中、多个选择去重、源码读取依赖、共享依赖、辅助项拒绝、未知项失败、无参数失败、显式全量与局部入口分离。本地显式任务清单不包含原有 dirty 文件的测试也需验证。

验收：一个数据库选择不启动其余六项；一个 UI 选择不触发窗口合集；空参数不运行任何测试。回退：同时恢复调用命令、参数解析与兼容导出，避免 CI 或专项入口失联。

### T-004：分离必要构建、原生测试与复用校验

文件范围：scripts/run-full-tests.cjs、相关专项包装脚本、package.json、native_capture/CMakeLists.txt、native_capture/build.ps1；原生 ABI 定义只在相关原生功能确有变动时同步。

步骤：

1. 按登记中的 requires 建立所选任务的依赖闭包。普通 renderer 专项不默认加入全部 native／capture 构建。
2. 分离 blur 与 capture 的专项构建入口，同时保留真正需要二者的完整产品构建。
3. 为 capture 测试目标增加显式构建选项；普通配置关闭测试目标，Qt Test 仅在测试开启时查找。
4. 条件化测试目标、add_test、输出目录列表和输入驱动，避免关闭测试时 foreach 引用不存在的 target。
5. build.ps1 每次显式传入测试开关，防止同一构建目录的 CMake 缓存残留。普通构建继续部署产品所需二进制、Qt／MSVC 运行库和许可证。
6. 原生专项选择具体测试程序／CTest 名称；只有显式要求完整原生专项时运行七项。
7. 保留现有构建失败阻塞依赖项的行为。选项明确“重新构建”或“校验并复用”；复用校验源码摘要、工具链／模式、产物摘要和有关 ABI。
8. 当前 selected-retest 会移除未选依赖：修改后不能因为未选 build 就认为前置条件满足。无法确认产物来源时报告阻塞或建议必要重建。

局部验证：构建任务选择／阻塞逻辑的运行器测试；在实施环境验证 capture 测试开关开与关、选择单项 Qt 测试及产品依赖交付。必要构建不视为全量；禁止为验证一个开关默认执行全部 GUI。

验收：普通 capture 构建不编译测试目标；选择某专项只运行必要构建；复用旧／未知产物不会静默得到“当前源码通过”。回退：成组恢复 CMake、build.ps1 和任务依赖，重建原生产物后再验证兼容。

### T-005：完善结果协议与证据留存

文件范围：scripts/test-runner.cjs、scripts/run-full-tests.cjs、scripts/run-electron-attachment-tests.cjs、scripts/run-electron-wallpaper-tests.cjs、tests/test-runner.test.js；按批迁移独立专项的结果输出。

步骤：

1. 保留不可覆盖的 attempt、超时处理、仅终止自有子进程、环境隔离与清理前诊断保存。
2. 增加选择计划、目标契约和断言完成信息；汇总原始进程状态与业务结果，不由字符串里出现 OK 就认定所有目标已执行。
3. 存储专项包装脚本接入统一证据流程，但保留它们所需的 Electron ready/nativeImage 环境，不能错误地改成普通 Node。
4. 传入实际运行模式，如模拟截图输入／真实输入、内存 DB／磁盘 DB、进程内重载／真实进程重启。
5. 缺少断言结果、跳过全部用例、无匹配、缺少必要证据单独报告，不能算通过。
6. 诊断和故障证据在脚本清理 userData 前交付运行器；证据绑定本次 run ID，避免误收旧截图。
7. 故障注入日志与业务断言一起判断；环境启动错误不自动归类为业务失败。
8. 在 evidenceError／cleanupError 时保留错误及必要资源，报告的“业务通过”与“证据／清理未完成”分开。

局部验证：tests/test-runner.test.js；覆盖退出 0 但无目标断言、跳过、依赖阻塞、超时、环境错误、旧证据、首次失败留存和清理边界。

验收：零退出但无断言不计通过；首轮失败可追溯；测试只清理自己创建的资源。回退：保留已有证据格式兼容读取，任何回退不覆盖历史运行目录。

### T-006：按契约逐项处理旧测试

文件范围：附录全部旧测试及有关 helper；具体删除／移动名单必须在实施前填写，当前没有统一删除名单。

步骤：

1. 每项标为保留候选、改写候选、删除候选或待核验，记录实际契约及独立预期依据。
2. 优先验收数据、冲突、事务、状态机和原生恢复的高风险保护；规则未明的测试先保留。
3. 对源码断言分开处理安全／架构／明确 UI 标准与偶然实现细节，禁止按“用了 readFile”整体删除。
4. 对广域串行脚本按独立业务契约拆分，保留共有 fixture；仍需跨功能事务的场景不要人为拆碎。
5. 确认同层等价保护后才删除重复项；跨层保护不能只因名称相似判为重复。
6. 对已废弃功能或无效 Mock 镜像写删除理由、替代覆盖或无需替代的依据与恢复位置。
7. 先建立必要替代保护，再删除原文件；同步登记、入口、CI 和引用，检查孤立 helper。
8. 每批只运行处理契约的局部测试，不因“清理测试”默认跑全量。

代表性候选：recurrence-rules、calendar-date-rules、calendar-event-layout、presentation-mode-controller 的行为测试以及真实草稿冲突／存储／窗口专项优先核验保留；note-list-motion、settings-panel-density、titlebar-icon-scale-ui 等源码结构断言逐条判断是否改写。security-hardening 中真实安全约束保留；backend-integration 的广域顺序脚本评估拆分。

验收：每个删除有理由和恢复点，高风险契约没有保护空档；无未登记测试与遗留引用。回退：恢复文件、登记、helper、入口和替代测试的对应关系。

### T-007：补齐持久化、资源一致性与草稿冲突的证据

文件范围：tests/application-settings.test.js、tests/attachment-storage-electron.mjs、tests/wallpaper-storage-electron.mjs、tests/note-draft-conflict-electron.mjs、tests/note-draft-conflict-ui-electron.mjs、tests/editing-draft-session.test.js，以及相关迁移／DB 专项。确有证据缺口时拟新增独立持久化／进程恢复专项，不预先决定批量生成文件。

步骤：

1. 先保留 Map 设置测试、内存 SQLite 和文件故障注入现有价值，登记它们分别证明什么。
2. 为设置建立磁盘 SQLite 样本：应用作用域／列表月周作用域、同名字段隔离、批量写入、重置与在途写入竞争；通过独立连接读取结果。
3. 在隔离 profile 中真实结束并重启主进程，确认设置、提醒、便签、sticky 等各自承诺持久化的字段；通过 UI 与 DB 各自观察，不仅重新创建服务。
4. 对受支持的历史 schema 样本检查迁移后的数据、约束与备份；迁移故障不能使原库不可恢复。使用合成／脱敏样本，不直接纳入客户数据。
5. 对附件与壁纸枚举 staging、文件提交、SQL 提交、删除补偿、启动恢复等已实现边界，在确定位置注入失败。
6. 真实异常结束的测试只终止隔离测试进程。重启后确认 DB 引用、文件存在和资源清理对应一致，不能用清空 profile 模拟恢复。
7. 草稿分别验证同一主进程 renderer 重载／视图切换与下一主进程启动；后一种按当前规则清理旧会话草稿。
8. 编辑版本冲突验证胜方数据、败方结果、草稿与截图资产归属，以及保存失败后仍可恢复编辑内容。
9. 现有保护已充分的场景记录覆盖，不重复生成相同测试。

验收：每个“重启”“持久化”“恢复”的通过结论标明实际重启层级与存储模式，关键失败后数据／文件仍一致。回退：只恢复测试和 fixture；若发现需改产品代码，登记关联 R/D 问题，不在测试准备阶段直接修复。

### T-008：校验周期生成与提醒的状态竞争

文件范围：tests/recurrence-rules.test.js、tests/recurring-note-preview.test.js、tests/recurring-preview-db.mjs、tests/reminder-service.test.js、tests/reminder-notification.test.js、tests/reminder-database-integration.mjs、tests/reminders-electron.mjs、tests/reminder-native-acceptance.cjs。

步骤：

1. 按规则表核对普通日、月底、季度、闰年、有效区间和本地日期边界。期望日期使用独立固定值，不反向调用 calculateNextRun 生成。
2. 将周期预览、实际生成和 DB 状态对应起来，检查重复调度／重入只产生合法的一次结果。
3. 停用数日后启动应跳过历史日期，不一次补发全部旧任务；当日是否可生成按实际调度规则核对。
4. 前一条未完成生成便签的替换、已完成便签保留、模板删除／恢复／编辑后状态均需按产品规则确认。
5. 注入生成失败，核验失败计数、错误信息与达到阈值后暂停；当前默认阈值为三次，不能误写为第一次失败即自动暂停。
6. 提醒验证过期轮次拒绝、重复延后、并发编辑／完成／删除、多通道去重和重启恢复。
7. 保留当前序列化重建数据库的测试，但标记为数据库重载；真实进程重启与 Windows 通知激活另设专项。
8. 睡眠／恢复、系统时间改变、OS 通知行为需要真实平台环境；未执行时保留为未覆盖，不用虚拟时钟结果代替全部 OS 结论。

验收：预览与生成一致、无重复或过期提醒覆盖、事务失败无部分状态提交；模拟与真实平台结果分开。回退：恢复相应测试、时间 fixture 与局部选择登记。

### T-009：核验真实窗口、原生截图与输入模式

文件范围：tests/window-state-matrix-electron.mjs、tests/presentation-mode-electron.mjs、tests/window-z-order-electron.mjs、tests/window-z-order-recovery-electron.mjs、tests/dock-trigger-electron.mjs、tests/window-control-drag-electron.mjs、capture 三类 Electron 专项与 native_capture/tests。

步骤：

1. 建立展开／紧凑、隐藏／显示、锁定、置顶／置底、停靠等被测状态转换表，仅选择当前修改涉及的转换和必要组合。
2. 快速反向操作、在途退出、renderer 重载、helper 崩溃、显示器变化时，验证最新意图、稳定终态、恢复与资源释放。
3. 同时观察 Electron 状态与真实 native 状态。原生置底应核验 enabled、requestedMatches、anchored 等实际确认信息，不能只看设置值。
4. 分开断言物理像素、Electron DIP 与 CSS 缩放；记录显示器布局、DPI、负坐标、混合 DPI 及前台桌面条件。
5. 紧凑模式保持单窗口展示语义，验证只持久化规定的尺寸，不能要求启动时恢复紧凑启用状态或旧位置。
6. capture-business 的默认模拟模式与 ABANDON_CAPTURE_REAL_INPUT=1 分开登记。真实输入需要实际可交互桌面与输入驱动，不能用协议注入冒充手势验证。
7. 截图交付核验 session／delivery 标识、ACK、取消、超时、乱序／重复消息、资产大小限制和窗口恢复。
8. Qt offscreen 测试只证明相应绘图／逻辑，不能声称已覆盖真实桌面捕获、IME、剪贴板、系统焦点和窗口识别。
9. capture 包装依赖单独验证；构建的产品与输入驱动版本须与测试匹配。
10. 真实多屏、系统通知、休眠和长期共存按物理条件安排；条件不具备时报告阻塞／未覆盖。

验收：报告有模式与坐标单位，真实状态可核对，helper 异常不遗留测试拥有的窗口／进程；模拟覆盖不夸大为实机全覆盖。回退：恢复测试与驱动登记；原生 ABI 或产品实现改动另按 D/R 条目执行。

### T-010：按契约改进 UI、网络、安全、报表与性能验证

文件范围：对应 Vitest 与 Electron 专项；包含 note-list-motion、ui-interaction-standard、security-hardening、weather、notice-markdown、daily-report、app-update、logging 和 benchmark 测试。

步骤：

1. 将 UI 源码断言逐条标明语义、架构约束或偶然 CSS 细节；有价值的约束保留，其余用可观察的布局／交互验证替代。
2. 列表、月周视图与浮层核验异步刷新顺序、过滤／分组结果、动画反转连续性、退出期间生命周期、焦点、命中区域和缩放后溢出。
3. 对明确的 UI 标准使用代表性主题／缩放／尺寸，不为每个组件复制同一套像素断言。颜色等标准如确属契约，测试与 docs/UI_DESIGN_STANDARD.md 保持一致。
4. 天气、远程公告与更新通过确定性本地响应验证超时、错误响应、取消和过期结果；真实服务验收另列，不连接生产作为默认测试。
5. 保留 CSP、IPC 允许范围、路径限制、markdown 清理与安装权限等安全契约；优先结构化解析与对应运行边界验证。
6. 日报核验日期范围、状态／时长统计、导出内容、取消与写入失败，不只断言文件已经生成。
7. logging 核验诊断导出、worker／asar 运行模式和低开销边界。性能测试记录硬件、构建、数据规模、采样方式与基线，避免无来源绝对时长断言。
8. 安装器权限、首次安装／升级／卸载和运行依赖作为独立包专项，不用目录包通过替代安装过程。

验收：每种测试有明确证明范围；源码结构调整不无意义地破坏行为保护；性能结果可比较，安装／服务／OS 行为不被模拟结果代替。回退：保留行为契约和前后结果依据，恢复测试／fixture／登记；业务修改另按汇总计划。

### T-011：让普通 CI 与显式大范围验证分开

文件范围：.github/workflows/ci.yml、.github/workflows/release.yml、package.json、选择与构建登记脚本。

步骤：

1. 普通 PR／push 读取明确 base/head 的已提交差异；文档改动不启动全套业务与原生专项。
2. 使用 T-002／T-003 的映射展示计划，源码文本依赖与跨层专项不能因 import 图缺失被略过。
3. 未映射生产改动、依赖范围不明或缺少桌面条件要显式报告，禁止“没有选中所以绿色”，也禁止自动退回全量。
4. 普通任务只构建被选专项必要的产物，去除当前 Windows 连续重复构建等冗余依赖。
5. 在静态配置层验证普通范围、显式全量／验收范围与 release 范围的分离。发布工作流已有验证职责保留，不削弱它来缩短日常检查。
6. macOS CI 只选择该环境真实支持的测试，不把 Windows 专项伪装为跨平台完成。
7. hosted runner 不具备真实桌面条件时，将需要物理输入／OS 功能的项目登记到合适环境；CI 的模拟通过不覆盖这些边界。
8. 保留原有 permissions、checkout 凭据策略等与本次选择改造无关的限制。

验收：文档变更、单个规则变更、renderer 变更、native 变更与未知映射都有可解释的计划；显式全量入口仍可选择完整登记范围。本阶段编写方案不触发 CI、release 或发布。回退：恢复 workflow 与其调用接口，避免仅回退入口导致工作流损坏。

### T-012：同步使用说明、最终范围与实施证据

文件范围：docs/testing/README.md、本指导、阶段索引、后续 04-implementation-plan.md；AGENTS.md 当前约束保留，只有实施方案确需调整时再单列。

步骤：

1. 新入口落地后更新真实可执行命令，删除／修正历史 README 中容易命中 Volta 的普通 Node 示例；历史结果本身不改写为当前通过。
2. 明确哪些是局部、合集、全量、验收、包专项和性能；说明参数空缺、未知选择与复用构建的结果。
3. 更新附录、处置台账、契约到测试映射与未覆盖项目。
4. 每批记录实际变更文件、运行命令、退出码、业务断言、源码／产物来源、首轮失败与最后结果。
5. 对未运行全量、真实多屏、重启、休眠、通知、安装等情况写明剩余风险，不省略成“全部正常”。
6. 将新增 R/D 事项和范围变化回写阶段指导，不在文档之外形成无法追踪的隐式修复。

验收：任何后续实施者都能从条目、源码和结果追溯当前状态；文档没有把计划命令写成已执行结果。回退：保留历史决策与真实结果，在文档标记撤回／替代关系。

## 7. 重点契约与核验矩阵

下表不是“已证明缺失测试”的清单，而是实施时必须核对的风险范围。已有测试充分时登记证据；不足时再补最小充分测试。

| 风险 ID | 优先级／对应条目 | 生产边界 | 现有代表保护 | 重点核验 |
|---|---|---|---|---|
| C-001 | 第一批／T-007 | db-schema、db-migration-backup、db.js | backend-integration、reminder-database-integration 等 | 受支持旧库迁移、数据不丢失、备份／失败恢复、磁盘打开与重启 |
| C-002 | 第一批／T-007 | db-images、db-wallpapers | attachment-storage、wallpaper-storage | staging／SQL／文件提交故障、删除补偿、孤立资源、异常终止后恢复 |
| C-003 | 第一批／T-007 | application-settings、settings-schema、db.js | application-settings、settings-schema、weather-settings | 实际 SQLite 键与冲突、作用域隔离、批写／重置／在途写入、进程重启 |
| C-004 | 第一批／T-007 | useDraftProtection、editing-draft-guard、db-notes、截图资产 | editing-draft-session、draft-conflict 与 UI 专项 | renderer 重载保留、旧进程草稿清理、版本冲突胜败双方、资源归属 |
| C-005 | 第一批／T-008 | recurrence-rules、recurrence、db-templates、recurring-note-preview | recurrence-rules、recurring-preview 的规则／DB／GUI | 本地日期、季度／闰年、无历史补发洪峰、替换规则、重复调度、失败阈值 |
| C-006 | 第一批／T-008 | ReminderService、db-reminders、reminder protocol／窗口 | reminder-service、reminder-database、reminders、native-acceptance | 过期轮次、多通道竞争、延后与编辑、真实重启／系统激活 |
| C-007 | 第二批／T-009 | index.js、windows、window-motion、blur_bridge、native_blur | presentation-mode、dock、window-state-matrix、z-order/recovery | 最新意图、恢复、真实层级、物理像素／DIP、多屏、紧凑持久化边界 |
| C-008 | 第二批／T-009 | CaptureHost、Coordinator、AssetStore、native_capture | capture-host／lifecycle／business、Qt 七程序 | 模拟／真实输入、ACK、取消、异常、资源限制、helper／产品依赖 |
| C-009 | 第二批／T-010 | NoteList、MonthWorkspace、popover lifecycle／motion | note-list-animation、刷新／标签、月周视图、ui-feedback | 异步乱序、状态组合、动画反转、浮层退出、焦点、缩放与遮挡 |
| C-010 | 第二批／T-010 | weather、remote、notice markdown、app-update | weather-rule/service、notice-markdown、remote-health、app-update | 可控响应、错误／取消／过期结果、输入清理、现有更新策略 |
| C-011 | 按改动／T-010 | daily-report、IPC、DailyReportDialog | daily-report 单元／IPC／Electron | 日期范围与统计一致、输出内容、取消、写入失败 |
| C-012 | 按改动／T-010 | Electron/preload 边界、sandbox、installer | security-hardening、sandbox 脚本、capture-package-smoke | 安全约束、打包依赖、实际安装／升级／卸载与权限 |
| C-013 | 后续专项／T-010 | logging worker、列表与缩略图、长期资源 | logging-actions、worker-asar、两个 benchmark | 环境基线、采样、数据规模、资源增长和长时间共存 |

所有“真实重启”采用隔离 profile 和独立主进程生命周期；所有“真实桌面”记录前台桌面／锁屏条件。单次本地通过不能解释客户机器原因，也不能证明全部硬件条件。

## 8. 三个具体用例设计示例

以下是测试设计要求，不是新增测试代码，也不宣称现有文件尚未覆盖它们。

### 示例 A：设置作用域与真实重启

- 目标：一个应用设置写入不能覆盖其他业务设置，相同字段名跨作用域隔离。
- 前提：隔离磁盘 DB，构造应用与视图的独立设置；先记录默认值。
- 操作：交替写入两个实际设置，切换列表／月／周，关闭测试主进程并新建主进程。
- 预期：允许持久化的字段与最后成功操作一致；无关字段不被覆盖；UI 与独立 DB 读取一致。
- 层级：规则单元＋真实 SQLite＋必要重启专项；单纯 Map 测试只能计规则保护。
- 证据：写入序列、scope/key/value、进程轮次、UI 观察和失败诊断。

### 示例 B：草稿重载与进程重启

- 目标：按现有会话规则验证草稿生命周期，防止错误地要求跨应用启动恢复草稿。
- 操作一：同一主进程内编辑未保存内容，renderer 重载或切换视图。
- 预期一：同一会话草稿按规则保留，恢复内容与资源归属一致。
- 操作二：结束该隔离主进程，再启动一个新主进程，沿用该 profile。
- 预期二：旧会话草稿被清理，无关 localStorage 设置保持；不能删整个 profile 来制造成功。
- 证据：两轮主进程会话 ID、localStorage 相关 key、UI 内容、文件资产引用。

### 示例 C：停止多日后的周期任务

- 目标：不补发全部历史错过日期，同时保持当日调度与后续日期正确。
- 前提：固定本地日期与模板锚点，独立写明应生成日期和下一日期。
- 操作：模拟／启动到数日后的调度点，重复执行调度，再注入生成故障。
- 预期：无历史补发洪峰；重复触发不重复生成；替换前一条未完成便签按既有规则；失败计数和暂停阈值正确。
- 层级：规则单元＋调度与 DB 集成；真实应用启动链路是否覆盖单列。
- 证据：模板状态、便签数量及有效日期、事务前后数据、失败次数与暂停信息。

## 9. 实施顺序、停止条件与回退

最终顺序在 S4 与解耦、审查条目合并后确定。当前建议依赖：

1. T-001 建可恢复基线。
2. T-002 完成资产登记；T-003 精确选择与 T-004 必要构建按登记共同落地。
3. T-005 完成可信结果协议，先验证运行器自身的关键行为。
4. 对第一批风险执行 T-007／T-008 的必要保护核验，作为 T-006 高风险清理的前置。
5. T-006 分批处理已确认的旧测试，与相关 T-009／T-010 契约迁移同步。
6. T-011 在选择与构建逻辑稳定后调整 CI，不先删普通 CI 再补新规则。
7. T-012 贯穿每批，最后复核资产与结果。

停止条件：规则冲突、没有可恢复基线、产物来源不明、映射遗漏、用户并行改动影响同一文件、目标断言未执行或环境不满足。停止依赖工作，继续不受影响的准备／实施项；报告原因，不通过放宽断言或自动全量绕过。

回退以条目和实际 diff 为单位。源代码、接口消费者、登记、配置和原生产物有依赖时成组恢复；不回退用户原有改动。涉及 DB／文件的产品修改在 S4 单列数据兼容与回退，不以测试库可清空推断用户库可清空。

## 10. Windows 执行环境与命令说明

本节供进入实施后的验证使用，本轮没有执行以下命令。

### 10.1 固定 Node 与子进程 PATH

Codex 本机采用：

```powershell
$taskNodeExe = 'C:/Users/Admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
$taskNodeDir = Split-Path -Parent $taskNodeExe
$env:PATH = "$taskNodeDir;$env:PATH"
& $taskNodeExe node_modules/vitest/vitest.mjs run tests/test-manifest.test.js
```

在仓库根运行，从第一条命令就绕过 Volta。修改外层 Node 不足以处理继续派生 node/npm/npx 的工具，必须维护正确 PATH 或直接调用 JS 入口。不得复用 HOME/home/CODEX_HOME 等系统变量名。

若修改了运行器，可按实际范围运行：

```powershell
& $taskNodeExe node_modules/vitest/vitest.mjs run tests/test-runner.test.js
```

拟新增选择器的命令只有文件实际创建后才可执行；本节不展示尚不存在的命令作为现有用法。

### 10.2 Electron、原生与安装专项

- GUI、Chromium/GPU、DPAPI、拖动、原生层级和系统通知等已知需要桌面／缓存权限的专项，从第一次运行就在合适的沙箱外环境执行。
- 核对 Electron 普通模式与 ELECTRON_RUN_AS_NODE，保持专项原有必要初始化。收集最终进程退出码和目标断言，不用 shell 瞬时返回计通过。
- 记录 Windows、显示器、DPI、工具链、Qt、Electron 和原生 ABI；native_blur ABI 若变动，与 src/shared/native-abi-version.js 同步并重建。
- 安装包只在明确范围内构建；本地打包继续使用 --publish never。目录包不等于安装／升级／卸载验收。
- Volta 权限、GPU、缓存、DPAPI 在目标断言前导致退出，记录环境阻塞，不计产品通过或产品失败。
- 不用 npm test、test:window-frame:win 或 full runner 无参数调用作为普通局部验证。

## 11. 实施遗漏检查表与当前交付

当前已完成：

- [x] 阶段边界、生成规则与现状证据已归档。
- [x] 文件级修改条目、依赖、验收和回退已列明。
- [x] 高风险契约矩阵与正确预期示例已列明。
- [x] 当前测试／辅助／fixture 文件清单已生成。
- [x] 全部计划明确为未实施，未预填测试通过结果。

实施时逐项检查：

- [ ] 基线包含已暂存、未暂存、未跟踪和原有删除状态。
- [ ] 清单刷新后每个资产有角色，helper／fixture 不作为独立测试。
- [ ] 实际源码读取路径、共享依赖和相关消费者均已映射。
- [ ] 局部入口空参数、未知选择、无匹配不会触发 all 或得到绿色。
- [ ] 必要构建没有顺带编译／执行无关测试；缓存与复用来源可验证。
- [ ] 对所有处置项填写理由、保护契约、替代覆盖和恢复位置。
- [ ] 持久化与恢复声明有相应磁盘／进程级证据。
- [ ] 截图模式、原生状态、坐标单位、系统通知与物理条件明确。
- [ ] 退出码、目标断言完成、跳过、环境阻塞、证据和清理分别报告。
- [ ] 第一轮失败仍可读，没有通过删除断言制造通过。
- [ ] 当前阶段改动文件与测试范围没有包含无关用户修改。
- [ ] CI、package 命令、登记、旧引用与使用说明已同步。
- [ ] 全量测试仅在有明确要求时运行；本轮未运行项和风险已列出。
- [ ] 结果绑定实际源码／构建来源，历史结果未冒充当前验证。

当前交付边界：只新增指导文档；现有生产代码、测试和配置未因本指导改动。全部运行验证与逐例质量验收待后续对应实施范围完成，客户机器、多屏、系统通知、真实重启和长期运行没有新增通过结论。

## 附录 A：2026-10-08 测试资产快照

下面的分类来自文件发现和当前 scripts/test-manifest.cjs，不表示质量验收通过。初始处置状态统一为“待核验”；代表性候选意见见 T-006。未跟踪文件也包含在清单中，原有删除状态文件另见 T-001。

路径相对文首仓库根；辅助／fixture 可能在多个用途列表出现，不重复计为测试。

### A.1 Vitest（131 个文件）

| 文件 | 当前角色 | 处置状态 |
|---|---|---|
| `tests/action-bar-accessibility.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/almanac-engine.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/almanac-requests.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/app-update-wiring.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/app-update.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/application-settings.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/attachment-rules.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/blur-settings-main-wiring.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/calendar-date-rules.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/calendar-day-preview.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/calendar-event-layout.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/calendar-grid-navigation.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/calendar-ipc.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/calendar-metadata.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/calendar-recurring-preview-ui.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/calendar-service.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/capture-assets.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/capture-coordinator.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/capture-image-worker.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/capture-recorder-owner.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/capture-shortcut.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/clipboard-and-selection.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/daily-report-ipc.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/daily-report.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/deferred-window-restore.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/diagnostic-actions.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/diagnostic-controller.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/diagnostic-evidence.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/diagnostic-ipc.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/diagnostic-noise-and-location.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/diagnostic-policy.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/diagnostic-transport.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/dock-config.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/dock-display-rebuild.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/dock-edge.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/dock-health.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/dock-main-wiring.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/dock-native-status-observer.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/dock-settings-ui.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/dock-transition-state.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/editing-draft-guard.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/editing-draft-session.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/error-capture.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/help-navigation-ui.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/help-quick-links.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/help-scroll-motion.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/help-search.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/help-support-ui.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/historical-note-backfill-ui.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/holiday-data-rules.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/holiday-data-service.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/image-only-note.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/ipc-arguments.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/ipc-authorization.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/log-record-text.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/log-store.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/log-writer-client.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/main-logging.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/maturity-interactions.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/modal-blur.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/modal-queue.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/month-calendar-context-menu.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/month-event-bar.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/native-edge-monitor-source.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/native-edge-monitor.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/native-runtime-gate.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/note-appearance.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/note-duration-mode.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/note-list-motion.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/note-remark.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/note-scheduling-rules.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/note-text-color-rules.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/note-text-color.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/note-weather.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/notice-markdown.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/notification-guard.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/notification-policy.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/package-native-config.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/performance-attribution.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/performance-diagnostics.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/pointer-anchored-popovers.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/presentation-mode-architecture.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/presentation-mode-controller.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/queued-modal-lifecycle.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/quick-note-edit.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/recent-local-day-range.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/recurrence-rules.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/recurring-note-preview.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/reminder-notification.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/reminder-service.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/remote-health-cache.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/scheduler.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/security-hardening.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/settings-panel-density.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/settings-schema.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/shortcut-status.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/sliding-workspace.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/sticky-diagnostic-ipc.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/sticky-entry.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/sticky-service.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/sticky-tray-menu.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/sticky-utils.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/system-diagnostics.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/tag-color-setting.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/tag-group-ordering-ui.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/tag-rules.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/tag-selector-ui.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/template-scheduler-guard.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/template-ui-utils.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/test-manifest.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/test-runner.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/titlebar-icon-scale-ui.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/ui-interaction-standard.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/ui-popover-motion.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/ui-scale.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/ui-z-index.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/view-switch-geometry-order.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/view-visibility-shortcut-service.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/view-visibility-shortcut-ui.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/view-visibility-shortcut.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/wallpaper-crop.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/weather-ipc.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/weather-refresh-controller.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/weather-rules.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/weather-selection-path.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/weather-service.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/window-bounds.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/window-compact-geometry.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/window-profiles.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/window-z-order-main-wiring.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |
| `tests/windows-sandbox-permissions.test.js` | Vitest，具体契约／层级逐项核验 | 待核验 |

### A.2 数据库专项（7）

| 文件 | 当前角色 | 处置状态 |
|---|---|---|
| `tests/note-list-completion-db.mjs` | 可执行 DB 专项 | 待核验 |
| `tests/reminder-database-integration.mjs` | 可执行 DB 专项 | 待核验 |
| `tests/backend-integration.mjs` | 可执行 DB 专项 | 待核验 |
| `tests/note-duration-db.mjs` | 可执行 DB 专项 | 待核验 |
| `tests/note-remark-db.mjs` | 可执行 DB 专项 | 待核验 |
| `tests/note-text-color-db.mjs` | 可执行 DB 专项 | 待核验 |
| `tests/recurring-preview-db.mjs` | 可执行 DB 专项 | 待核验 |

### A.3 存储专项（2）

| 文件 | 当前角色 | 处置状态 |
|---|---|---|
| `tests/attachment-storage-electron.mjs` | 可执行存储专项 | 待核验 |
| `tests/wallpaper-storage-electron.mjs` | 可执行存储专项 | 待核验 |

### A.4 当前 window-frame 集合（18）

| 文件 | 当前角色 | 处置状态 |
|---|---|---|
| `tests/window-frame-electron.mjs` | 可执行合集成员，拟按契约重分组 | 待核验 |
| `tests/dock-trigger-electron.mjs` | 可执行合集成员，拟按契约重分组 | 待核验 |
| `tests/blur-z-order-electron.mjs` | 可执行合集成员，拟按契约重分组 | 待核验 |
| `tests/window-z-order-electron.mjs` | 可执行合集成员，拟按契约重分组 | 待核验 |
| `tests/window-border-electron.mjs` | 可执行合集成员，拟按契约重分组 | 待核验 |
| `tests/note-duration-electron.mjs` | 可执行合集成员，拟按契约重分组 | 待核验 |
| `tests/main-view-enhancements-electron.mjs` | 可执行合集成员，拟按契约重分组 | 待核验 |
| `tests/daily-report-electron.mjs` | 可执行合集成员，拟按契约重分组 | 待核验 |
| `tests/template-quarterly-electron.mjs` | 可执行合集成员，拟按契约重分组 | 待核验 |
| `tests/month-view-electron.mjs` | 可执行合集成员，拟按契约重分组 | 待核验 |
| `tests/week-view-electron.mjs` | 可执行合集成员，拟按契约重分组 | 待核验 |
| `tests/weather-settings-electron.mjs` | 可执行合集成员，拟按契约重分组 | 待核验 |
| `tests/sticky-persistence-electron.mjs` | 可执行合集成员，拟按契约重分组 | 待核验 |
| `tests/quick-note-edit-electron.mjs` | 可执行合集成员，拟按契约重分组 | 待核验 |
| `tests/titlebar-icon-scale-electron.mjs` | 可执行合集成员，拟按契约重分组 | 待核验 |
| `tests/view-visibility-shortcut-electron.mjs` | 可执行合集成员，拟按契约重分组 | 待核验 |
| `tests/note-draft-conflict-electron.mjs` | 可执行合集成员，拟按契约重分组 | 待核验 |
| `tests/note-draft-conflict-ui-electron.mjs` | 可执行合集成员，拟按契约重分组 | 待核验 |

### A.5 Electron 功能专项（32）

| 文件 | 当前角色 | 处置状态 |
|---|---|---|
| `tests/note-list-animation-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/note-list-toolbar-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/note-list-tag-refresh-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/note-list-refresh-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/note-list-completion-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/reminders-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/almanac-weather-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/attachment-loading-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/list-minimal-mode-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/calendar-font-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/draft-dialog-ui-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/modal-queue-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/first-use-notice-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/help-center-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/logging-actions-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/logging-worker-asar-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/month-context-menu-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/month-day-preview-status-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/month-event-text-color-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/note-text-color-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/notice-markdown-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/presentation-mode-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/titlebar-native-drag-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/recurring-preview-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/capture-lifecycle-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/capture-host-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/capture-business-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/settings-scroll-memory-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/window-state-matrix-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/week-day-panel-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/window-control-drag-electron.mjs` | 可执行功能专项 | 待核验 |
| `tests/window-z-order-recovery-electron.mjs` | 可执行功能专项 | 待核验 |

### A.6 显式验收（8）

| 文件 | 当前角色 | 处置状态 |
|---|---|---|
| `tests/ui-components-electron.mjs` | 验收范围，不默认随小改动执行 | 待核验 |
| `tests/ui-responsive-electron.mjs` | 验收范围，不默认随小改动执行 | 待核验 |
| `tests/ui-feedback-electron.mjs` | 验收范围，不默认随小改动执行 | 待核验 |
| `tests/ui-feedback-app-electron.mjs` | 验收范围，不默认随小改动执行 | 待核验 |
| `tests/maturity-db.mjs` | 验收范围，不默认随小改动执行 | 待核验 |
| `tests/maturity-electron.mjs` | 验收范围，不默认随小改动执行 | 待核验 |
| `tests/maturity-regressions-electron.mjs` | 验收范围，不默认随小改动执行 | 待核验 |
| `tests/notice-admin-electron.mjs` | 验收范围，不默认随小改动执行 | 待核验 |

### A.7 性能（2）

| 文件 | 当前角色 | 处置状态 |
|---|---|---|
| `tests/thumbnail-benchmark-electron.mjs` | 性能范围，环境／基线需记录 | 待核验 |
| `tests/logging-overhead-electron.mjs` | 性能范围，环境／基线需记录 | 待核验 |

### A.8 MJS 辅助文件（5）

| 文件 | 当前角色 | 处置状态 |
|---|---|---|
| `tests/calendar-count-preview-helper.mjs` | 辅助，不独立计测试 | 待核验 |
| `tests/helpers/capture-test-desktop.mjs` | 辅助，不独立计测试 | 待核验 |
| `tests/helpers/date-picker-keyboard.mjs` | 辅助，不独立计测试 | 待核验 |
| `tests/helpers/renderer-evidence.mjs` | 辅助，不独立计测试 | 待核验 |
| `tests/fullscreen-foreground-electron.mjs` | 辅助，不独立计测试 | 待核验 |

### A.9 原生截图程序

| 文件 | 当前角色 | 处置状态 |
|---|---|---|
| `native_capture/tests/clipboard_test.cpp` | Qt 测试程序 | 待核验 |
| `native_capture/tests/core_test.cpp` | Qt 测试程序 | 待核验 |
| `native_capture/tests/input_driver.cpp` | 输入驱动，辅助 | 待核验 |
| `native_capture/tests/pin_halo_test.cpp` | Qt 测试程序 | 待核验 |
| `native_capture/tests/polish_test.cpp` | Qt 测试程序 | 待核验 |
| `native_capture/tests/selection_test.cpp` | Qt 测试程序 | 待核验 |
| `native_capture/tests/ui_test.cpp` | Qt 测试程序 | 待核验 |
| `native_capture/tests/ux_test.cpp` | Qt 测试程序 | 待核验 |

### A.10 其他脚本（11 个文件）

| 文件 | 当前角色 | 处置状态 |
|---|---|---|
| `tests/capture-package-smoke.cjs` | 专项／工具脚本，运行角色需核验 | 待核验 |
| `tests/fixtures/notice-admin-server.py` | fixture 服务 | 待核验 |
| `tests/helpers/capture-owner.cjs` | 辅助脚本 | 待核验 |
| `tests/helpers/reminder-activation.ps1` | 辅助脚本 | 待核验 |
| `tests/helpers/ui-fixture.cjs` | 辅助脚本 | 待核验 |
| `tests/helpers/z-order-event-emitter.cjs` | 辅助脚本 | 待核验 |
| `tests/reminder-native-acceptance.cjs` | 专项／工具脚本，运行角色需核验 | 待核验 |
| `tests/sandbox-diagnostics-win.cjs` | 专项／工具脚本，运行角色需核验 | 待核验 |
| `tests/sandbox-electron-win.ps1` | 专项／工具脚本，运行角色需核验 | 待核验 |
| `tests/sandbox-installer-win.ps1` | 专项／工具脚本，运行角色需核验 | 待核验 |
| `tests/sandbox-permissions-win.ps1` | 专项／工具脚本，运行角色需核验 | 待核验 |

### A.11 fixtures（4 个文件，包含上表的 Python 服务）

- `tests/fixtures/almanac-reference.json`
- `tests/fixtures/notice-admin-server.py`
- `tests/fixtures/ui-components.vue`
- `tests/fixtures/ui-feedback.vue`

### A.12 原有删除状态

- `tests/styled-select-menu.test.js`：读取基线时已处于删除状态，不包含在 131 个现存 Vitest 文件中。本轮没有删除或恢复它；实施时单独确认处置来源和相应保护。
