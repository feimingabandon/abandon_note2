# B7b 运行域审查、测试处置与收尾指导

日期：2026-10-09。状态：准备指导完成后，用户已明确授权实施并连续完成全部批次。第1–5节保留准备及暂停时的审查结论与执行指导；恢复实施与最终证据见第6节及 [实施汇总 §25](04-implementation-plan.md#25-明确授权后恢复实施2026-10-09)。局部结果不视为全项目或发布验收。

## 1. 准备阶段的边界与真实读取范围（历史）

自动审批拒绝了新增业务写入门禁及包装业务 IPC 写入通道的补丁，理由是用户此前要求先完成准备工作，实施授权不够明确。该补丁未落盘；主代理已要求所有代理停止生产、测试、配置代码写入。此后仅补指导、只读审查与状态核对，不以调整补丁路径或工具绕过拒绝。拒绝前已存在的代码改动保留，未擅自回滚。

本次读取主窗口/geometry、settings runtime、blur/z-order、application bootstrap/shutdown、remote coordinator、capture coordinator及恢复owner、app/business/calendar/weather/daily-report授权链路、preload、workspace/wallpaper/update composable、日报输出与诊断脱敏、manifest/focused/CI/结果协议及代表性源码断言。数据、模板、提醒闭环见 [15-b7b-data-review.md](15-b7b-data-review.md)，窗口剩余状态逐项见 [09-window-runtime-implementation.md](09-window-runtime-implementation.md)。

只读静态检查发现322个JS/MJS/CJS/Vue源码文件，270个登记资产（250 test、12 helper、4 fixture、4 build），登记校验无错误。字面相对import扫描未发现环；唯一指向main/index的文件是顶层日志引导 `src/main/bootstrap.js`，它是进程入口，不是服务反向依赖。该扫描使用字面路径，不能证明动态依赖、回调环或全部源码语义已审完。没有因文件数或静态解析而声称“每一处实现均已完整验收”。

## 2. R-007 至 R-016 审查结论与怎样修改

### R-007 启动、退出、在途操作

已有改动：application/bootstrap拥有startup准入与阶段台账；shutdown coordinator拥有草稿批准、异步退出阶段、同步cleanup和可重入标志。remote的终态gate已修，session-end先持久入队，再等待start及有界1600ms上报；超时后不采纳迟到DB回调。原logger本来具有will-quit `closeLogs(1000)`，不能把它误报成必丢最终日志。

已有证据：本域指定27单元通过；`application-lifecycle-electron.mjs` 两个独立app进程32实际断言，最后shutdown记录一次、数据库重开integrity、拥有资源终态，见08-main-lifecycle指导及 `tmp/test-evidence/B3d-lifecycle-2026-10-09T09-41-44`。

剩余步骤：B7a的feature/tray/activation移交须接入现有created ledger、startup checkpoint和退出顺序；数据清空门禁同时承担停止新业务写入、排空已准入命令的接口，不能在DB关闭后继续异步附件提交。退出草稿取消时不得过早永久封闭业务。超时和无法排空要显式报告，不能无限等待或把所有dispose并行。

验证选择：只在该接线真正变化时重跑application lifecycle和具体admission/feature单元，附慢stage/退出/失败场景；未运行客户异常断电、系统session-end所有分支或soak。

### R-008 窗口、停靠、展示、坐标和层级

已有改动：MainWindowHost唯一current/generation；GeometryPersistence唯一普通几何timer/dirty/suppression；BlurRuntime/ZOrderRuntime唯一叶能力状态。原apply→confirm→persist/rollback顺序保持。ABI18未改。

已有证据：B3ab九文件36单元、真实跨视图36断言；B4a四文件13单元、真实52断言。B4a一次glass=true normal→top真实确认不收敛，33断言后未完成、原始退出1，已保留；fresh通过不能结论为已修复根因。

剩余步骤：按B4b Dock→B4c drag→B4d Presentation→B4e Navigation→B4f完整背景/设置协调迁移。全部外写点、监听、timer、waiter移交，不传巨型可写context。具体接口/行为/验收在09指导。不要把原生edge fixture成功当实际app Dock接线成功；优先可精确选择的拖动专项，避免顺带运行截图crash组合。

剩余证据：多屏/负坐标/混合DPI、Explorer重建、睡眠恢复、overlay偶发层级、客户机器均未完整覆盖。本轮没有执行全量窗口矩阵。

### R-009 截图协议与主窗口恢复

CaptureCoordinator已有current sender、pending/active、来源导航监视、session/delivery/receiver ACK复核；结束释放监听与资产；Host拥有本次helper/Job，资源上限留在主/native边界。新CaptureWindowIntegration只接管一次恢复ticket，未复制Host/ACK/assets状态。

已有证据：20局部用例及真实app的18/18截图业务断言，见12-capture指导。有效模式为synthetic-transport，不能证明真实Qt输入/剪贴板/坐标。

剩余步骤：B4迁移后确认Dock suspend/resume与ticket身份仍同一来源；只在对应协议或生命周期改变时选择capture coordinator/assets/host/lifecycle专项，实际输入独立模式。不得改变来源截图的Enter/双击/复制产品动作。native协议未改时无须重写C++或全组Qt测试。

### R-010 IPC、preload及窗口能力

通用 `assertMainWindowSender` 校验current webContents身份，**未校验senderFrame是否mainFrame**。主窗口sandbox/contextIsolation为true、nodeIntegration为false；窗口导航/新窗口打开受阻，sticky/reminder具有自己的受限preload与导航规则；diagnostic另有frame校验。只读calendar旧sender取消是具名例外，不能用于写入。

已有证据：B2a app注册21局部用例与真实preload双窗口17断言，证明外部窗口拒绝、非法target/旧更新身份无外部打开副作用、host替换与dispose；未覆盖主窗口subframe，受控update service也不证明真实联网。

剩余步骤：为每个异步写入口列API→通道→当前窗口/frame→payload→完整业务命令→提交/返回/订阅。先查iframe/CSP/preload可达性，再决定是否需要统一frame限制；不把未查frame直接定为可利用漏洞。清空admission位于授权之后、副作用之前，非法sender不得准入。异步操作需要复核时检查资源/业务代次，不机械在每个await后复制相同判断。

验证选择：被改授权、arguments及具体业务文件；真实Electron覆盖实际可达窗口/frame。五HTML入口与三preload安全矩阵保留，CSP静态保护不等于运行攻击测试通过。

### R-011 异步生命周期与查询

WorkspaceRuntime的await后disposed gate、订阅台账、content-ready屏障和modal释放已迁移；wallpaper sequence与list缓存/延迟释放、calendar即时释放差异保持。UpdateCheck阻止同实例并发，清理startup/minimum timer及minimum waiter。

B6a三个模型已分别通过真实GUI；最新Timeline/Custom `await restoreAnchor` 之后补父token复查，22局部用例通过，最终build/两项GUI未重跑。B6b Q004慢calendar和迟到订阅经生产SFC同文档卸载复现后修复；Vue屏蔽卸载实例ready，不能声称旧ready已影响父页。月/周模型已有迁移但尚未完成真实日历验收。

剩余步骤：先完成日历天气/recurring辅助owner，再核对所有await/finally的disposed/sequence/父token与卸载释放；月拒绝新导航和周pending target策略保留。一个sequence不能兼任查询、天气、导航、动画票据。最后共享稳定build，分别补Timeline/Custom和本次日历实际页面专项，不把模型单元当焦点/DOM/动画证明。

### R-012 UI规范与交互

Renderer代理已完整阅读UI_DESIGN_STANDARD；SettingsPanel拆分复用了原语义token和170条CSS规则上下文，未引入新的中性灰/边线体系。Dock/Sticky是实际域表单与section，非Weather/Wallpaper透传包装。三模式列表、设置真实页面已有局部交互证据。

剩余步骤：未来每次DOM/CSS迁移逐一核对scoped归属、搜索锚点、popover定位/Escape/focus、关闭flush、exit副本/动画、uiScale和相邻天气黄历。模型抽取不同时改样式/文案。组件内语义/绘图例外按标准写原因注释。

已有设置50实际断言包含三view Dock布局、sticky颜色、关闭flush、popover、scroll/search；没有像素等价或所有尺寸/主题/可访问性认证。日历迁移尚无GUI结果；真实多屏和输入法组合仍有边界。

### R-013 网络、天气、更新与产品策略

WeatherRefreshController已有settings signature generation、按轮次去重、cache-only→refresh、`shouldStore`、手动/自动限频、Retry-After和退避；旧地区/关闭开关后不发布当前状态。B7a需将入口的天气装配/发布/调度生命周期完整归属feature天气子owner，而不是再次重建刷新算法。

AppUpdateService仅稳定数字版本；Windows x64目标产物、固定GitCode/GitHub发布页、GitCode HTTPS域名和精确release路径、checkId/version/relation绑定外链，浏览器继续负责下载/安装。Workspace中的disposed/单实例checking保护已读；main service多来源并行请求结果不能仅由renderer状态证明对所有调用场景安全。

剩余步骤：天气owner停止后gate旧发布/存储、服务引用与调度解除；保留现有地区/cache/Retry-After语义。更新与notice只在触碰协议/实际错误时新增受控响应验证。首次使用、捐赠、统计、更新展示时机、App/Month策略差异保持；无联网服务健康、发布或自动安装结论。

### R-014 日报、诊断、隐私与性能

DailyReport normalize保持自然日范围、366天上限、status白名单、跨日便签去重及稳定排序。export在保存对话框前重新读取当前数据并选择IDs，落盘使用该点击快照；不无意改成对话框结束后的新查询。TXT有UTF-8 BOM；XLSX内容作为字符串、日期作为Date，32767字符边界有truncatedCount。取消不写文件，最近路径仅在成功写后记录。

诊断通过DiagnosticSanitize处理token/body/buffer、URL查询、路径、有界深度/节点/字节预算，读取descriptor避免执行getter；logger实际will-quit屏障已读。自由文本/错误message仍需要独立敏感样本，不能由字段白名单证明任意文本不会包含正文。

剩余步骤：本批未改日报/性能算法，保留功能；若修改导出/日志需精确验证输出内容、取消、文件失败和脱敏样本。性能必须有规模、测量窗口、机器及主/renderer/native归因；未运行benchmark/ASAR包/长期资源或客户卡顿复现，不命名客户根因。

### R-015 依赖、所有权和编码规范

新模块朝shared纯规则和窄业务端口依赖，无服务反向import index；SettingsRuntime深冻结values，快照clone；MainWindowHost冻结身份；Blur配置只读。Bootstrap/Shutdown/Geometry/Queue/Query Session分别有明确状态来源。

剩余步骤：撤旧wrapper前列全部消费者；业务命令整体保留SQL/文件补偿，renderer只管查询结果/视图。检查snapshot是否含内部可变Map或嵌套错误对象、重复install的退出机制、timer/listener配对，状态dto不等同于共享引用。只整理本批实际文件，不全库format、不引新状态库/DI/事件总线。Calendar当前未lint的移交文件尤其不得预填规范通过。

### R-016 测试可信度、构建与CI

Focused入口拒绝无选择/未知/错误角色/非法路径/`--all`，source只提示候选；结果区分原始进程、业务断言、证据、清理；attempt token和模式绑定。原生build/runtime前置及来源证明分开；未知工具链闭包不允许reuse，Qt单目标须精确discovery。CI以已提交范围与显式已审消费者映射选择；未映射不fallback全量。

当前270登记资产只是可发现性；绝大多数仍 `disposition=unreviewed`、contracts空或带behavior-contracts-unreviewed，不能当质量完成。已验收模式仍需逐域补metadata/source-read/CI范围；见下节。没有运行GitHub CI、release quality、安装/升级/卸载或macOS平台验收。

## 3. 测试处置账本与修改顺序

本轮未删除全部测试，也未增加skip来制造通过。下表按故障检测价值处理；“待改写”不表示运行失败，未运行的静态问题不统计成失败数。

| 资产或断言组 | 处置 | 保留的检测价值、替代/修改步骤 |
|---|---|---|
| test-manifest/selection/runner/focused/entrypoints/result/build/CI文件 | 保留已有行为保护 | 角色/空选择/路径/尝试身份/依赖/业务结果及失败清理均为真实基础设施契约；不由implementation输出再生成expected |
| security-hardening五HTML、三preload、sandbox/发布身份 | 保留静态契约 | 解析实际CSP/配置及入口，不误称安全攻击或包验证；改入口同步source-read |
| app-update-wiring、view-switch-geometry-order、view-visibility-shortcut-ui | 已改消费位置，保留 | 原调用顺序、ready/授权边界；真实app/跨窗口证据另列 |
| historical-note-backfill、image-only-note、quick-note-edit、tag-color-setting | 已随命令/设置位置迁移，保留 | 保留历史输入、纯图片便签、文本编辑与颜色规则；不只断言新模块名 |
| application-settings、settings-runtime、settings-repository-db、settings-queue | 保留并补失败样本 | Q001原失败、真实transaction rollback及runtime/UI回填；受控queue乱序不替代真实系统auto-start |
| note-draft-conflict、attachment/wallpaper-storage、recovery-reset、sticky-persistence | 保留真实资源断言 | draft版本、资源补偿、成功后清理失败/恢复；内存库与磁盘/独立进程模式区分 |
| calendar-workspace-lifecycle/model、timeline/custom/tag模型 | 保留必要竞态保护 | 受控慢Promise、卸载、父token，expected来自外部初始/最终状态；真实GUI承接DOM/focus |
| dock-settings-ui、tag-group-ordering-ui | 已移读路径，保留有效规范/排序保护 | 同步section/model实际source-read，布局结果另由GUI承担 |
| window-z-order-main-wiring | 已迁叶模块，暂保留 | apply/confirm/persist/retry静态门槛与native行为测试并存；后续用行为替代内部拼写，不一次全删 |
| presentation-mode-architecture、dock-main-wiring | 待改写，当前存在旧定位 | 仍匹配旧 `mainWindow`、`screenshotCaptureActive`，与Host/Capture ticket不一致。先建立“单窗口、两次bounds、ACK、门禁、compact仅尺寸”等行为保护，再改AST/实际owner读路径。当前未运行，不填写失败数量 |
| note-list-motion精确CSS/注释、presentation拖动解释文本 | 候选改写，不立即删 | 内外间距/箭头/捕获释放有UI含义；内部注释和精确数值应由语义/结构或实际交互代替，替代验收后删除脆弱句子 |
| dock-trigger-electron | 保留平台叶能力测试 | 直接窗口+DLL fixture，无法单独证明app Dock装配；新增/适配实际app定向场景，不能以fixture过关消账B4b |
| window-control-drag-electron | 保留显式较广验收 | 后半还含截图crash组合；B4c默认选titlebar-native-drag或新增具名子场景，不自动连带此组合 |
| 尚无结果adapter的MJS/Qt其他目标 | 保留，待对应契约准入 | 不把退出0计作verifiedPassed；仅在该域变化时补recorder/模式/资源/清理，再准入focused和CI |
| 不在实际迁移范围内的其余资产 | 保留，质量未逐项验收 | 登记不代表独立expected/mock范围全部审完；后续按所属功能触发，不为清理而运行全库 |

禁止删除旧测试的条件：契约仍需要而替代未验证、删除影响source-read/命令/CI但未同步、恢复来源不明。允许删除的条件：说明保护意义消失或确有等价重复，记录替代文件/场景与有效结果，成组更新manifest/文档；没有必要为低影响文案再造镜像测试。

## 4. B7b 原定具体操作

1. 明确实施授权并核对现存diff/基线；完成B4、B5b门禁、B6b、B7a owner和其运行门槛后再撤旧兼容。
2. 修改 `scripts/test-manifest.cjs` 的reviewed overrides：只给实际读过/验收的文件填contracts/features/disposition/limits，未审资产仍unreviewed；C-008/C-007/C-009等按真实模式范围填写，禁止批量标verified。
3. 逐一登记本次新增owner与源码文本测试实际读取路径，包括Blur/ZOrder、Query Session和三个list模型、Calendar模型、Settings section/form/queue、feature/tray/activation、admission；对动态目录读保留directory依赖。仅import图不足。
4. 完善 `scripts/test-domain-rules.cjs`：优先已验收叶模块→具体unit+实际MJS。广域index/shared/native保持needs-domain-validation，除非另有明确覆盖方案；不能把所有index消费者自动并成全量。
5. 已有下轮可补映射候选：bootstrap/shutdown→application lifecycle/remote-shutdown；Blur/ZOrder→native-leaf及实际native MJS；capture-window→ticket/coordinator/实际synthetic业务；list session/models→对应模型及各模式GUI；settings forms/queue/sections→对应unit与settings-queue。Calendar/admission/feature/tray/activation须先完成验收，不能提前准入。
6. 新MJS登记明确runtime前置、buildInputs、standalone mode/adapter、report token、business completion、evidence和cleanup；synthetic/native-input独立选择，Windows责任与macOS未验收分开。
7. 只运行这次改过的manifest/focused/CI/source-read具体文件，检查每个映射目标真实存在、是test且能执行，不用fixture凭空造名掩盖缺项。再运行本次业务必要专项；未迁域不连带执行。
8. build由唯一协调者在稳定源码下串行进行，保存输入/产物/工具链/ABI来源；消费新Calendar/anchor源码时需新build，不复用旧out证明最新变更。未能证明工具链闭包时rebuild或阻塞，不能去掉requires。
9. 更新本组README/04及docs/testing/项目README的真实入口和状态。保留S1–S4历史准备与第一次失败，不把历史通过改成当前全项目通过。
10. 最后做本批diff/消费者/资源/状态账本审查，明确仍待多屏、native输入、系统toast点击、安装/macOS/长期/客户验证；只有用户另授权全量/发布验证才执行对应较广入口。

## 5. 准备阶段回退与结案（历史）

按域从已存基线取恢复候选到临时位置，人工比较后恢复实际本批文件及消费者/测试/manifest/配置；不得git reset/clean整个dirty checkout。不删除用户数据库或诊断证据；native回退保持ABI/源码/DLL对应。本批没有生产补丁，文档回退仅涉及本文件及索引链接。

准备完成条件已具备：剩余域的契约、具体文件/owner、消费者、顺序、验证、失败和回退有对应指导；16个R均有分类结论及证据边界。实施结案条件尚未具备：B4b–f、clear admission、B6b最终运行、B7a服务装配、B7b最终映射/撤兼容未完成，不得填“全部批次已实施”。

## 6. 明确授权后的实施结案（当前）

第1–5节为暂停时历史。用户在完整指导交付后明确授权连续实施；B4b–f、B5b准入、B6b辅助能力、B7a服务装配及本节B7b均已完成约定迁移和指定局部验收。每个子批的当前状态、指导、恢复来源见 [04 §25](04-implementation-plan.md#25-明确授权后恢复实施2026-10-09)，不能将历史的“尚未实施”当当前阻塞，也不能将此结案扩大成全项目发布认证。

### 6.1 审查成立问题、修复与消费者

- 清空/退出准入以完整命令排空，包含已准入的sticky独立ready续段、异步子操作、clear后的附件/草稿流程。退出业务排空后只开放同步最终bounds清理，不能借cleanup恢复一般IPC写入。实际clear磁盘专项最终58/58、feature真实app40/40、sticky52/52和两进程lifecycle32/32验收；模式限制分别在15/16及结果报告。
- Presentation退出后的迟到ACK、Navigation disposed期间迟到draft/ready/失败恢复均有受控生产模块红回放和定向修复；背景完整请求在DB关闭前settled。真实Presentation89、背景导航62、跨view36断言通过，不把受控Promise证明扩成OS生命周期全集。
- 最终共享构建揭示真实启动TDZ，保留原attempt后修SettingsRuntime不可变初始schema seed及三处后置alias。21个factory构造期逐项核对，动态view state仍唯一归Navigation。代码tokens/AST等价的注释清理不会充当业务验证；真实新app启动退出另行完成。
- Reminder的sealed期间failed事件丢失已修为当前delivery token与不可变round/attempt身份的内存观察，下次合法tick复核真实旧round后恢复重试，clear成功和dispose清除旧身份。独立受控红绿、25unit及实际磁盘SQLite/触发器失败回滚有证据；OS transport仍模拟，未验证Windows真实toast显示/点击。

### 6.2 测试处置已执行部分与以后规则

已改写 `presentation-mode-architecture`、`dock-main-wiring`、`view-switch-geometry-order`、`blur-settings-main-wiring`、`diagnostic-noise-and-location`、`native-runtime-gate` 的实际owner定位/AST边界，并同步manifest的源码读取关系。单窗口、提交顺序、ACK、late-provider和日志/原生gate的保护仍在；没有仅为适配新的内部拼写把有效契约删除。

新增/增强的窄专项保护真实app停靠、背景互斥、日历、feature/clear及Reminder实际存储边界；窗口旧专项迁移结果协议，未减少原断言来制造通过。Feature首次31断言后失败来自fixture返回不可克隆Function，只修显式void，最终40/40通过；原exit1/cleanup failed继续保留。

未批量删除旧测试、未新增skip、未把其余资产批量认证。note-list-motion等内部注释/数值断言仍属候选改写，未来实际功能触碰且有等价保护后再处置；未适配的legacy运行域继续拒绝仅凭exit0计通过。低风险可逆整理不机械新增测试；缺陷回归要求可观察的失败/成功样本，数据库/跨进程/native边界用对应真实资源专项。

### 6.3 登记、来源和CI最终状态

`scripts/test-manifest.cjs` 的69个实际审过保护范围有contracts/features及 `reviewed-protection`，同时保留 `reviewed-scope-does-not-certify-current-pass`。其余继续unreviewed，全部cost仍unmeasured；具体耗时由attempt报告记录。direct-import、明确built-app消费者及source-read只作候选，含实际新owner与动态helper路径，不自动传递选择。

`scripts/test-domain-rules.cjs` 已登记本批验收的窗口、背景、业务准入/服务/托盘/激活/天气/提醒、日历、列表模型/会话/item及GUI结果helper叶规则。每个目标必须真实存在、role=test且focused adapter可执行；新增CI单元通过实际仓库registry生成只读plan检查全体规则，而非只在fixture虚构文件名。单Calendar模型变动只选对应model单元与Calendar专项；main/index、preload、公共schema/native未知范围继续非零needs-domain-validation，不全量fallback。macOS只列可适用unit和Windows转交职责，未冒称macOS实际通过。

build-app在稳定源下完成输入/本地依赖/工具链闭包证明；Feature单项复测通过正式 `reuse-verified` 再核同一app输入/输出，未裁requires。build-capture必要产品构建通过，但外部Qt/MSVC/SDK闭包仍unverified，不发native复用证书，ABI18实际状态另由专项检查。

最终静态审查 `tmp/b7b-final-source-audit.json`：334个JS/MJS/CJS/TS/Vue源码、287登记资产（266 test、13 helper、4 fixture、4 build），syntax/literal import/registry错误均为空，未见字面导入环；唯一import main/index者为顶层bootstrap。该检查不是所有回调/计算动态依赖、每条源码语义或全部功能验收。

### 6.4 准确验证、失败与风险

- 最终10个具体登记/选择/CI/源码消费者单元 **130/130**，`tmp/b7b-final-mapping-source-unit.json`；五个基础设施文件前一收尾版本111/111，`tmp/b7b-final-infra-unit.json`。两组有重叠，不能相加当独立用例。相关九个实际脚本/测试严格lint通过；各业务owner另有匹配的局部结果。
- 最终共享app的14项真实专项有效结果在 `tmp/test-runs/2026-10-09T03-28-40-290Z-oElUD0`，详见04表；总体16/17jobs因Feature fixture失败仍为失败。Feature单项最终40/40和正式app reuse验证在 `03-34-16-718Z-ygxBDo`；增强后的磁盘clear/Reminder专项58/58在 `03-41-04-777Z-Clk3cP`，均raw0、业务完成、证据和清理complete。
- 保留首次TDZ未完成attempt、Feature clone失败、B4a Overlay z-order确认未收敛，以及各域早期SQL/环境/fixture失败。不用fresh一次通过命名旧Overlay/客户问题根因。
- 未运行无参默认测试、全量unit/窗口矩阵/Qt全集、云端CI、release quality、打包/安装/升级/卸载/发布/部署。多屏负坐标/混合DPI、Explorer/真实电源恢复、真实截图输入/剪贴板、系统toast关联/冷启、macOS、外网天气/更新、客户机、长期/性能/任意崩溃故障仍有边界。

本次回退仍按唯一域基线成组恢复实际owner、消费者、测试/登记/入口和相应产物；保留用户dirty和全部原始证据。不恢复陈旧用户数据库，不执行全库reset/clean。后续修复按本次实际改动契约选择，只有明确全量/发布要求才扩大到相应入口。
