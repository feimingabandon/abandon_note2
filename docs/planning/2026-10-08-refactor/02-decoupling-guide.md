# 解耦准备与后续修改指导

版本：v1，2026-10-08

阶段：S2 解耦准备

状态：职责、状态所有权和迁移方案已归档；代码迁移、测试与构建尚未执行。

阶段索引：[README.md](README.md)

测试规则与 T/C 编号：[01-testing-guide.md](01-testing-guide.md)

## 1. 本阶段目标、依据与边界

本阶段确定“为什么拆、拆到哪里、谁管理状态、怎样迁移、如何验证和回退”。所有拟新增模块和修改步骤均属于后续 S5 实施，当前只编写准备文档。

基线 HEAD：`1111ce29dc57f8459a3f6f783eedad4d92b563c5`，包含现有未提交和未跟踪内容，不代表干净提交。文中源码路径均相对此仓库根：C:/addFile/idea/项目/abandon/abandon_note2。

依据包括前期代码阅读、本轮主进程关键路径与 renderer 状态流程复核、源码静态依赖分析和现有测试定位：

- 对 src/main、src/preload、src/shared、src/renderer/src 的 286 个 JS/MJS/Vue 文件进行脚本 AST 解析，排除 node_modules／Vite 缓存；未执行这些业务模块。
- 在成功解析的静态相对 import／re-export 图中未发现多模块强连通环；动态导入、路径别名、IPC、回调、共享状态和运行顺序不由该结果证明。
- 主进程入口约 5966 行、58 个解析到的相对源码依赖；它同时协调多个功能域和运行期状态。
- SettingsPanel 约 4043 行，其中脚本约 1589 行；NoteList 约 2621 行，其中脚本约 1614 行；MonthWorkspace 脚本约 992 行。模板和样式也占较大部分，不能按总行数直接判定应拆分。
- App.vue 与 MonthApp.vue 重复处理设置、壁纸、更新、通知、模态层及生命周期，但部分行为存在差异，不能直接用其中一个覆盖另一个。
- 复核了设置持久化／运行时应用、视图切换／展示模式、原生层级、停靠与移动接口、应用启动／退出、截图与服务装配、IPC 业务事务、列表加载、日历导航、设置队列与重置等重点链路。
- 当前文档是结构调整方案，不是逐行缺陷审查报告，也不宣称全部断言已验收或运行通过。

本轮不改业务代码、测试、配置、AGENTS.md、构建或 CI；不运行测试、lint、构建、Electron、安装和发布。S3 审查和 S4 实施汇总完成后，再按汇总顺序执行本指导。

## 2. 解耦判断与优先级

### 2.1 优先处理的结构

| 问题 | 当前证据 | 调整目标 | 对应条目 |
|---|---|---|---|
| 启动、退出与功能装配混在入口 | index.js 的 startupPromise、before-quit、托盘、调度和服务构造 | 入口保留进程引导；生命周期、服务装配有明确接口和顺序 | D-002、D-012 |
| 设置读取、写入、运行时副作用及快照集中 | resolvedSettings、persistSettingValues、set-blur-config、壁纸激活等 | 分开存储规则、设置运行时、背景事务与平台应用 | D-003、D-006、D-008 |
| 主窗口多个状态域交叉读写 | view、compact、dock、drag、z-order、geometry、capture 的字段与函数集中 | 每个域有唯一写入者；跨域事务由窗口协调层发起 | D-001、D-004、D-005、D-006 |
| IPC 层包含业务事务和文件补偿 | register-business-ipc 的 create-with-assets、save-draft 直接操作 SQL／文件 | 鉴权与传输保留在 IPC；完整业务命令下沉到应用服务 | D-007 |
| DB 入口混合连接、设置、存储恢复和清空数据 | db.js 同时负责 init/close、设置 upsert、附件恢复、clearNoteData | 保留连接生命周期与兼容外观，拆出明确的持久化职责 | D-008 |
| renderer 公共应用逻辑重复 | App／MonthApp 两套应用层监听与壁纸／通知逻辑 | 提取有限的可复用 composable，保留视图差异 | D-009 |
| 列表／日历查询、导航与 DOM 动画交织 | loadSeq、分页序号、scroll anchor、动画、状态动作同组件 | 数据模型与 DOM 展示分别负责；保留现有时序 | D-010 |
| 设置面板写队列、预览、原生应用、交互均在一处 | debounceTimers、pendingSaves、inFlight 集合、reset 和各区块 | 先提取写队列与各设置域，再按区块拆模板 | D-011 |

这些是职责或变更影响范围的证据，不能据此推断已发生产品错误。

### 2.2 当前应保留的合理边界

- src/shared 下的日期、设置、提醒、附件和输入规则继续作为共享纯规则来源。高复用本身不是坏耦合。
- PresentationModeController 已隔离稳定态／目标态与唯一进行中操作，继续复用，不另造第二套展开／紧凑状态机。
- window-motion 已区分 Windows 物理移动与其他平台 Electron DIP 移动；纯几何、边缘判定和转换规则保持独立。
- CaptureHost／CaptureCoordinator／CaptureAssetStore、Qt ImageDocument／Overlay／Editor 已有分层，首轮主要拆主进程集成回调。
- ReminderService、RemoteCoordinator、ElectronStickyService 等已有功能边界；不因文件长就改成多层空包装。
- useQueuedModal、useSlidingWorkspace、useNotePresenceMotion、usePopoverLifecycle 等已有生命周期能力，应复用并明确使用责任。
- vendor 日历实现、地区静态数据和生成产物不因行数大而重写。
- 不同时引入全量 TypeScript 迁移、全局状态库、通用事件总线或依赖注入容器。当前明确接口与小型工厂已足以表达边界。

## 3. 目标依赖方向与模块形态

目标关系：

```text
Electron 进程入口
  → 应用引导 / 服务装配 / 退出协调
  → 主窗口协调、设置运行时、各功能服务
  → 窄接口的持久化、平台与原生适配

renderer 页面
  → 页面级 composable / 业务模型 / 展示组件
  → preload 明确 API
  → 主进程 IPC 鉴权与请求处理
  → 完整业务命令 / 查询
  → DB / 文件资源

src/shared
  → 纯规则与协议，供 main / preload / renderer 使用
  → 不反向依赖 Electron、DOM、窗口或持久化模块
```

约束：

1. 入口创建模块并显式连接。业务模块不得反向 import src/main/index.js，也不接受可读写全部入口变量的巨型 context。
2. 窗口协调层发起跨域操作；Dock、Presentation、ZOrder 不互相发起未声明的递归命令。必要的只读状态通过小型快照／查询接口提供。
3. 传输层验证 sender、整理参数、调用业务命令、保留诊断关联和返回协议。业务命令不接收 Electron event，不直接广播 IPC。
4. DB 模块不调用 renderer、Tray 或窗口；平台适配不自行写业务设置。事务拥有者明确，SQL 与文件补偿的完整操作不能拆散。
5. renderer 业务模型可以使用 Vue 的 ref/computed；DOM 测量、滚动与动画留在展示适配层，不硬套“模型必须没有 Vue”。
6. 新模块采用显式 install/start/dispose 或小型工厂；现有构造函数副作用先登记并保留顺序，不能在迁移时悄悄改变。
7. 接口返回快照与结果，不让调用方获得内部 Map、计时器或任意修改状态的能力。运行期与持久化状态按含义区分，不机械压成一个字段。
8. 原有导出、IPC 通道和结果形状先兼容。删除兼容入口需在所有调用方迁移且局部验收后单列步骤。

## 4. 状态所有权与生命周期清单

D-001 首先建立以下所有权。目标名称是拟定模块，不是已创建文件。

| 状态／资源 | 当前定位 | 目标唯一管理者 | 生命周期与写入限制 |
|---|---|---|---|
| 单实例、应用路径、protocol、通知身份、草稿会话 ID | index.js 187–264 附近 | 应用引导 | 每主进程一次；dev／packaged／integration 分支保持 |
| mainWindow、窗口创建与事件解绑 | createWindow、mainWindow | MainWindowHost | 每实际窗口一组监听；其他域仅取得当前窗口／窄操作接口 |
| activeViewMode、切换占用、renderer-ready 等待、queuedViewSwitch | switchMainView、pendingMainViewRendererReady | MainViewNavigation | 保留视图迁移、几何保存、ready 与失败回退事务 |
| committedMode、desiredMode、operation | PresentationModeController | 现有 controller | 已有串行最新目标语义保留 |
| 展开／紧凑几何、ACK waiter、compact drag／resize 计时器 | compactExpandedBounds、stableCompactBounds 等 | PresentationRuntime | controller 的平台事务适配；操作结束／窗口变化释放 waiter 和暂停资源 |
| dockSide、isDockHidden、dockMotionSession、generation、edge monitor | index.js 停靠字段与 window-motion | DockRuntime | 一轮停靠会话独占；旧代次事件不得写入当前会话 |
| docking 暂停、native cleanup、display/power listeners | suspend count、cleanup pending、listener 列表 | DockRuntime | 按已有语义配对获取／释放；多来源暂停不互相覆盖 |
| titlebarDragSession、拖动暂停、移动计划 | titlebar drag 函数 | WindowDragController | 每拖动一次，坐标空间与尺寸不变量跟随该会话 |
| geometryDirty、可持久化边界、debounce、抑制时段 | geometry timer／bounds 字段 | WindowGeometryPersistence | 隐藏／拖动／紧凑时不把暂态位置写成稳定位置；退出前 flush |
| requested/pending z-order、confirm、retry、rollback | persistWindowZOrderMode 等 | ZOrderRuntime | 先应用和真实确认，成功后持久化；失败恢复原状态 |
| blur initialized／failed／diagnostic 与请求版本 | blurRuntime 与 set-blur-config | BlurRuntime ＋ BackgroundSettingsCoordinator | 原生有效状态由平台事实提供；背景切换协调者管理 blur／wallpaper 请求竞争 |
| resolvedSettings、settingsRevision、应用／视图 scope | refreshResolvedSettings、persistSettingValues | SettingsRuntime | 持久化值、会话覆盖、运行能力分别表达；快照格式兼容 |
| 快捷键本次运行开关、注册占用与失败状态 | globalShortcutsEnabled、shortcut services | ShortcutRuntime／现有服务 | 会话开关不写数据库；注册实际状态单独报告 |
| 截图 active/pending/session/delivery/assets | CaptureCoordinator 等 | 现有 CaptureCoordinator | 保持会话／ACK／资源限制；主窗口集成只管理暂停与恢复票据 |
| screenshot 前可见／焦点与隐藏恢复 | screenshotMainViewWas* | CaptureWindowIntegration | 开始时捕获、结束／失败／退出时一次释放；不假设任何结束都应显示窗口 |
| pending native reminder action、窗口 reveal | notification protocol 函数 | NotificationActivation | 服务未就绪时保留队列；就绪后按已有行为消耗 |
| capture/remote/diagnostic shutdown flags、draft quit approval | before-quit | ShutdownCoordinator | 保留分阶段、可重入、一次执行与超时行为；取消退出不能继续清理 |
| DB connection、WAL、schema、backup、close | db.js、db-connection.js | DatabaseRuntime／db-connection | 只有一个实际连接所有者；兼容入口引用同一连接 |
| renderer settings/wallpaper/modal/listeners | App／MonthApp | 页面内 WorkspaceRuntime 等 composable | 页面挂载／卸载；无跨页面意外状态串用 |
| 列表 loadSeq／分页 generation／filter／sort | NoteList | 列表数据模型 | 主查询与子分页分别失效；动画与 anchor 通过展示端协作 |
| 日历 loadSequence／navigation／selection／pending week | MonthWorkspace | CalendarWorkspaceModel | 月导航与周导航规则分开，保留待处理周目标和选中日期 |
| settings pending/inFlight/reset 与本地预览 | SettingsPanel | SettingsWriteQueue ＋ 页面表单模型 | 初始化／回填不写；重置丢弃未发写入、等待在途写入 |
| useMessage／minute clock／presentation 的共享引用 | 已有 composable | 原有 provider／引用计数模块 | 保留有意的共享；避免每个新组件再安装一份监听或时钟 |

“唯一管理者”指某类状态有确定的写入接口；DB 配置意图、正在申请的原生状态和最终系统有效状态是不同层，不应强行合并。

### 4.1 必须保留的并发策略

| 操作 | 当前策略 | 解耦要求 |
|---|---|---|
| expanded／compact | 现有 controller 串行执行，并跟随最新 desiredMode | 保留 committed／desired／operation 与错误恢复 |
| 主视图切换 | 在忙／草稿确认／native cleanup 时拒绝或取消；blur 请求期间保留 queuedViewSwitch | 不把所有分支统一改成无条件队列 |
| 列表模式切换 | pendingSortMode 与动画阶段协作 | 保留退出／进入和最新模式衔接 |
| 月历导航 | transitioning 期间返回 false | 不顺带增加月导航排队行为 |
| 周历导航 | 保存 pendingWeekNavigation，基于当前／待处理选择继续计算 | 不能简化成忽略所有后续点击 |
| blur 与 wallpaper | 请求版本、激活版本、在途计数和失败恢复 | 版本应跟随完整协调事务，不分散给互不知情的服务 |
| 设置重置 | 阻断 watcher，新队列丢弃，在途写入等待，再 reset | 排空和回填过程中禁止旧请求重新写回 |
| z-order | 应用→核验→持久化，失败回退，bottom 有有界重试 | 不提前把 requested 当 effective 或已保存 |
| 截图 | pending/active 返回 busy，ACK 与当前接收者匹配 | 不通过解耦放开并行截图会话 |
| 退出 | 多次 before-quit 逐阶段推进 | 不直接改成无区别并行 dispose |

## 5. 文件级迁移条目（全部待实施）

### D-001：固定行为契约、状态所有权与依赖端口

优先级：基础前置。现有文件：index.js、windows、window-motion、settings、相关 renderer 页面；文档维护本节所有权表。

修改步骤：

1. 每个待迁移状态列出初始化、写入、读取、计时器、异步完成、持久化和释放位置，使用本节作为起点。
2. 以功能为单位定义端口，例如读取当前窗口、保存稳定几何、发布 note 变更、调用现有 motion backend；端口只包含确实需要的能力。
3. 标清副作用顺序、请求版本与失败回退责任。一个业务事务只有一个协调者，底层执行者不得隐式回调另一个命令形成环。
4. 为每个 D 条目对应 T/C 契约，区分已存在保护与需核验缺口。
5. 记录会被源码断言读取的旧路径与符号；迁移测试定位时保留原有语义，不以改名为理由删除保护。
6. 冻结第一批的通道、结果形状、scope、DB schema、原生 ABI 与用户可见行为。结构迁移与缺陷修复分批。

验收：任一字段都能回答“谁写、何时生效、谁取消、谁持久化、谁释放”；模块依赖不是把所有 globals 塞进 context。测试关联：T-002／T-006，所有相应 C 契约。回退：仅撤回该批端口与调用适配，不撤销用户原有改动。

### D-002：提取应用引导与可重入退出协调

现有文件：src/main/index.js，logging／native runtime gate／windows 的启动能力。拟新增：src/main/application/bootstrap.js、src/main/application/shutdown-coordinator.js。

步骤：

1. 入口保留 Electron 必须的早期配置、单实例处理、whenReady 和少量装配调用。logger／protocol／test path 的导入或初始化副作用逐项登记，不随意推迟。
2. 将 startupPromise 中的 DB 初始化、欢迎便签、存储恢复、应用／视图设置准备、窗口／功能服务装配按原顺序迁移到 bootstrap。
3. 服务初始化先写明确的阶段表；底层独立操作可保持已有并行，窗口、设置和 IPC 的前置顺序不改。
4. 从 before-quit 整段提取 ShutdownCoordinator：草稿确认与取消、capture 等待、remote 等待与 1600ms 边界、diagnostic freeze、几何 flush、scheduler/service/DB/native/tray 清理。
5. 保留 stage started/finished 和一次 Promise 行为，让重复 app.quit／before-quit 只推进阶段，不重复关闭 DB／native helper。
6. 并不把退出统一改成“逆序销毁”或全部 Promise.all；DB 必须在依赖它的持久化／服务清理之后关闭，日志 freeze/flush 时机保持。
7. 新增安装的 app/powerMonitor/window 监听都返回归属明确的释放能力。启动部分失败时按已完成阶段收尾，不接管未创建资源。
8. 测试 hooks 改为入口挂载受限的委托，不直接暴露内部可变状态。

对应验证：editing-draft-guard/session、capture-lifecycle、logging-actions、window-state-matrix，以及必要的独立退出重入／部分启动失败案例。关联 T-005／T-007／T-009，C-001／C-004／C-007／C-008／C-013。

验收：业务模块不 import 入口；退出取消保持可继续使用；重复退出无重复资源释放；主窗口／协议的启动时序一致。回退：bootstrap、shutdown 与入口接线成组恢复。

### D-003：建立设置运行时边界

现有：src/main/index.js 的 refreshResolvedSettings、persistSettingValues、getResolvedSettingsSnapshot、broadcastSettingsChanged；src/main/settings/application-settings.js、src/shared/settings-schema.js。拟新增：src/main/settings/settings-runtime.js。

步骤：

1. 继续使用 shared schema 与 application-settings 的 scope／序列化规则，不另建默认值和数据库键的副本。
2. SettingsRuntime 管理当前 view 的 resolved values、settingsRevision、会话覆盖和快照组装。快照仍区分 values 与 runtime。
3. persist(entries) 验证 ID、分组应用／视图 scope、调用 repository；保持目前副作用与广播顺序，跨 scope 原子性疑问交 S3 单列。
4. 窗口、背景、快捷键、weather、remote 等平台状态通过只读 provider 和明确应用端口连接；SettingsRuntime 不自行启动这些服务。
5. 日常配置写入与需要原生确认的命令分开。z-order、blur enable 和 auto-start 的有效结果由相应 runtime 报告，不提前“保存成功”。
6. 快捷键启用开关保持 session-only。renderer 白名单、应用级 ID 列表和旧 week 初始化／继承规则完整保留。
7. DB 读取改为 D-008 的窄 repository 时保留兼容导出，逐个迁移调用方，避免一次改遍全部 DB 使用者。
8. 设置重置与视图切换由协调层发起，SettingsRuntime 提供快照／读写能力，不跨层操控 renderer 的 watcher。

对应验证：application-settings、settings-schema、weather-settings、blur-settings-main-wiring；真实 SQLite 与重启按 T-007/C-003，背景原生按 T-009/C-007。

验收：应用／视图／会话值的所有者明确；快照格式、revision、scope 和 renderer 写入范围保持；没有新的第二份配置缓存成为写入源。回退：运行时及所有调用方成组恢复，结构迁移不变 DB schema。

### D-004：拆主窗口 host、视图导航与展示事务

现有：index.js 的 createWindow、loadActiveViewIntoWindow、renderer ready、switchMainView、perform/recoverPresentationModeCommit；windows/window-profiles.js、presentation-mode-controller.js、renderer-recovery.js。拟新增：windows/main-window-host.js、main-view-navigation.js、presentation-runtime.js。

步骤：

1. MainWindowHost 只管理实际 BrowserWindow 创建、安全选项、加载、当前窗口引用和事件安装／释放。列表／月／周保持同一个主窗口；week.html 继续复用现有 MonthApp 的 week 模式。
2. MainViewNavigation 迁移完整切换事务：草稿确认、退出 compact、停止／恢复 dock、保存源 view 稳定几何、准备目标 scope、加载／等待 ready、保存 active view、更新托盘。
3. 出错时恢复 previousMode、几何、settings、renderer 与托盘；ready waiter 超时、旧 sender、窗口变化和取消规则一起迁移。
4. PresentationRuntime 复用原 controller，负责 renderer operation ACK、隐藏／几何应用、blur 同步、显隐／焦点、失败强制 expanded。
5. compact 的稳定尺寸、展开恢复边界、compact drag/resize 与尺寸保存放入同一个展示事务适配。只持久化规定的尺寸，不持久化启动启用状态或旧位置。
6. 两类切换的 ready ID 与等待 Map 分开。不得用一个通用 ready Promise 合并两个协议。
7. 通过 D-005／D-006 的端口暂停停靠、保存几何、同步 blur／z-order；协调者调用端口，底层不反向启动视图导航。
8. createWindow 与 startup 中重复涉及窗口的监听列明归属，一次迁移一组，防止安装两份。

对应验证：window-profiles、view-switch-geometry-order、presentation-mode-controller/architecture、month-view、week-view、presentation-mode、draft-dialog-ui；T-007／T-009，C-003／C-004／C-007／C-009。

验收：主窗口 ID 在视图切换中不变；ready 先后顺序、rollback、锁定限制和 compact 生命周期保持；不存在未释放 waiter 或停靠暂停。回退：host、navigation、presentation 和入口委托按批恢复。

### D-005：将停靠、拖动与稳定几何拆成有所有者的模块

现有：index.js 相关 dock/drag/geometry 函数，src/main/window-motion、window-bounds.js、shared/window-compact-geometry.js。拟新增：window-motion/dock-runtime.js、windows/window-drag-controller.js、windows/window-geometry-persistence.js。

步骤：

1. 先沿原 API 提取 WindowGeometryPersistence：debounce、dirty、抑制时间、稳定边界选择与退出 flush。保留每个 view 的几何 scope。
2. DockRuntime 一批迁移 state/session/generation 与纯 helper 调用，再迁移 slide/hide/show、edge monitor、cleanup/health、display/power 重建。
3. 继续使用 DockTransitionState、native-edge-monitor、dock-config、dock-display-rebuild 与现有 motion backend；不在新模块复制算法。
4. 保留一轮会话的坐标空间和尺寸快照、旧代次事件拒绝、cleanup 未结束时阻止不安全的下一操作。
5. 暂停能力以配对资源接口提供给 titlebar drag、compact、capture 和 resize。首轮沿用计数语义；需要改为 token 化时单列有行为保护的子步骤。
6. Titlebar drag 使用现有物理／DIP 移动接口，移动结束保持原生层级恢复和 blur 同步。compact drag 与标题栏的不同边界规则保留。
7. 原生监视器 hook、display/power listeners、timer 都归 DockRuntime；stop/dispose 必须处理在途回调与未完成 cleanup。
8. 诊断快照由模块提供，不让 logging／外部直接改 session；getDockDiagnosticSnapshot 的现有字段有兼容映射。
9. 按功能切小批迁移：几何→可见停靠判定→hide/show→edge cleanup→显示器/电源恢复→拖动接线，不一次搬整个两千行区域。

对应验证：window-bounds、dock-config/edge/transition-state/display-rebuild/health、dock-trigger、window-control-drag、window-state-matrix、window-z-order-recovery；T-004／T-009，C-007。

验收：物理像素与 DIP 未混用；隐藏位置不持久化；旧事件不会影响新 session；取消／崩溃／显示器变更后暂停与资源无残留。回退：状态拥有者、端口和调用方按完整停靠子批次恢复，原生 ABI 不随 JS 提取改变。

### D-006：隔离 blur、z-order 与背景切换协调

现有：bridge/blur_bridge.js、index.js blur initialization/health、set-blur-config、wallpapers:activate、persistWindowZOrderMode。拟新增：windows/blur-runtime.js、windows/z-order-runtime.js、settings/background-settings-coordinator.js。

步骤：

1. 继续以 blur_bridge 作为原生绑定边界，不为每个 DLL 导出再建一个同义 wrapper。
2. BlurRuntime 接管 initialized/failed/diagnostic、重建 overlay、窗口几何／层级同步和可见恢复；现有 deferred restore 复用。
3. ZOrderRuntime 接管 request/pending/confirm/retry/rollback，保留先实际应用并核验，再持久化的次序。
4. 原生确认包含 topmost、bottom enabled/requestedMatches/anchored 及相关 blur health；可配置值不能代替有效值。
5. BackgroundSettingsCoordinator 整段迁移 blur 与 wallpaper 的互斥、requestRevision、activationRevision、inFlight 计数、wallpaper suspend/restore 和 queued view 衔接。
6. wallpaper 列表／缩略图／存储 API 留在存储与查询端口，背景协调者只处理激活与效果状态，不负责文件库所有 CRUD。
7. 设置广播、错误反馈与诊断关联保持。结构迁移不调整延时、重试上限、恢复策略或 UI 文案。
8. 若将来确需改 DLL 导出／ABI，在 S4 单列 native_blur 与 shared/native-abi-version 同步、重建与专项验证；首轮 JS 解耦不修改它们。

对应验证：deferred-window-restore、blur-settings-main-wiring、window-z-order-main-wiring、blur-z-order、window-z-order/recovery、presentation-mode、wallpaper-storage；T-004／T-007／T-009，C-002／C-003／C-007。

验收：背景竞争的旧请求不覆盖新意图；z-order 失败恢复配置与实际状态；diagnostic/effective/requested 区别仍可观察。回退：原生事务与背景协调按整体恢复，不能只恢复其中一个 revision 计数器。

### D-007：IPC 保留鉴权，把完整业务命令移出传输层

现有：src/main/ipc/register-business-ipc.js、index.js 内未拆 IPC、src/main/ipc/ipc-authorization.js、logging/ipc-main.js、src/preload/index.js。拟新增：src/main/notes/note-commands.js，以及按域的 register-window/settings/background/app/remote/shortcut-ipc.js。

步骤：

1. 用附录 A 和 preload API 对照冻结现有通道、参数、结果、广播与 sender 范围；动态注册、reminder/sticky 专属窗口另行确认。
2. 先迁移 index 内的同域注册，使用各 runtime 的窄接口；注册返回自己的 dispose，不 removeAllListeners。
3. 主窗口鉴权、stale sender 特例、on/send 与 handle/invoke 区别保持。不能给 reminder/sticky 自动扩大主窗口能力，也不能把 fire-and-forget 事件改为 invoke 而不同步协议。
4. 将 notes:create-with-assets 和 notes:save-draft 的完整操作移入 note-commands：输入规则、ownership、version、staging、同步 SQL 事务、文件提交／补偿、清理和结果一起迁移。
5. 保留事务内再次校验版本／归属；不得把 await 文件 staging 放进 better-sqlite3 的同步 transaction 回调。
6. 服务返回业务结果后由 IPC 层保留 observeNoteMutation、diagnostic action、广播 reason/id 与 reminders/sticky 回调。
7. tags/templates/images 的已有简单操作只按域整理，不自动生成一层无业务内容的 service。跨资源操作才提取命令。
8. preload API 暂保持接口形状；如按域拆内部文件，contextBridge 只暴露原有限 API，不暴露任意 invoke。
9. sticky 保存当前内容冲突与 note draft expectedVersion 是不同契约，不能为复用强行统一为同一校验。
10. channel 移动后检查重复安装、引用遗漏与释放；测试源码读取路径随迁移调整但原规则不删。

对应验证：ipc-authorization、ipc-arguments、backend-integration 的相关契约、draft-conflict、attachment-storage、reminder-database、sticky-persistence、相关按域 IPC 测试；T-002／T-005／T-006／T-007，C-002／C-004／C-006／C-012。

验收：鉴权与协议兼容；业务命令不接收 Electron event；事务／补偿完整；失败不发成功广播；用户数据与资源归属一致。回退：命令、注册、preload 和调用方一起恢复，不能留下双注册通道。

### D-008：明确 DB 生命周期、设置 repository 与资源恢复职责

现有：src/main/db/db.js、db-connection.js、db-notes.js、db-images.js、db-wallpapers.js、db-schema.js、db-migration-backup.js。拟新增：db-settings-repository.js、db-runtime.js、attachment-recovery.js、business-data-reset.js；查询模块仅在收益确认后拆。

步骤：

1. 设置 getAllSettings/setSettingsBatch/clearSettings 等移到窄 repository，统一使用原实际 connection；application-settings 不再依赖聚合生命周期入口。
2. DatabaseRuntime 负责 app.db 路径、WAL/foreign_keys、迁移前备份、schema 初始化与 close；路径由应用引导提供，保留已有 pragmas 和错误回收。
3. db-connection 继续给既有业务模块提供同一连接；首轮不强行给全部 12 个消费者注入新的 repository 容器。
4. 附件 staging/reset 恢复迁移到 attachment-recovery；manifest 版本、文件名、目录策略和失败保留现场规则不变。
5. clearNoteData 的 SQL 事务与文件 move/committed marker/补偿迁移为完整 business-data-reset 操作；对 reminders/sticky/drafts 的运行期同步由应用层负责。
6. db.js 暂作为兼容外观 re-export，其他模块逐批改窄 import；新模块不反向依赖 db.js 避免产生环。
7. db-notes 先保持公共 API 与事务边界。纯查询、列表 DTO 和排序／过滤 SQL 可以在稳定后拆到 note-queries，日期／分页／completed-last 等契约保持。
8. 不同时改 DB schema、主键、排序算法、用户路径、迁移版本或公开 DTO；发现设计问题交 S3 单列。
9. 结构迁移不更换用户 DB；磁盘恢复与原库兼容按 T-007 真实环境验收。

对应验证：application-settings、各修改相关 DB 专项、attachment/wallpaper-storage、draft-conflict、recurring-preview-db、note-list-completion-db；T-007／T-008，C-001／C-002／C-003／C-004／C-005。

验收：连接唯一、close 不早于服务持久化、目录／manifest／SQL 语义不变、legacy imports 可用，无新 import 环。回退：外观与窄模块成组恢复；仅结构变更不需要数据迁移，若加入 schema 改动必须另有回退设计。

### D-009：提取列表与日历共用的 renderer 应用运行逻辑

现有：src/renderer/src/App.vue、MonthApp.vue、utils/applySettingsSnapshot.js、composables/usePresentationMode.js、useQueuedModal.js、useSlidingWorkspace.js。拟新增：composables/useWorkspaceRuntime.js、useWorkspaceWallpaper.js、useWorkspaceNotices.js、useUpdateCheck.js；按职责实际收益决定是否合并较小文件。

步骤：

1. 先比较两入口的默认 view、renderer-ready 前置、模态阻断、更新触发、壁纸退场与缓存等差异，记录“共同行为／视图策略”。
2. 提取 settings snapshot 应用、快捷编辑／标签颜色 provider 同步、app message 和远程 notice 订阅；页面提供必要策略和通知回调。
3. Wallpaper composable 管理请求序号、已加载／在途资源和释放时机。保留 App 当前退出延迟与去重、Month 当前直接释放的差异，不借解耦统一效果。
4. 通知 composable 复用待确认公告、首次使用、节假日提示的业务方法；显示请求仍走现有 modal queue。当前首次使用、捐赠与设备统计策略不改变。
5. Update composable 复用执行／错误映射，保留列表入口自动检查及最短显示时间等行为，日历入口维持自己的触发策略。
6. root 的 compactBlocked 由公共模态状态＋该页面业务模态合成；NoteEditor 与 CalendarWorkspace 的不同完成条件仍由页面提供。
7. 生命周期明确 start/dispose；每个订阅只装一次，所有 timer、modal blur 引用、焦点恢复与 renderer-ready 发出顺序保持。
8. usePresentationMode 的共享引用计数继续使用，不在新 runtime 再创建第二套状态。useDraftProtection 继续由主进程 session capability 区分生命周期。
9. 不立即引入包含所有视图模板的巨型 WorkspaceShell。只有公共视觉框架稳定且不会增加多层透传时，再评估小型布局组件。

对应验证：first-use-notice、modal-queue、draft-dialog-ui、presentation-mode、month/week-view、notice-markdown、相关更新／通知单元；T-007／T-009／T-010，C-004／C-007／C-009／C-010。

验收：两入口的行为差异有显式参数／策略，公共方法不复制；无重复监听／时钟／presentation 用户计数，ready 不提前。回退：composable 与两个 root 的接入成组恢复，CSS／DOM 结构首批保持。

### D-010：拆列表与日历的加载模型、交互和展示适配

现有：NoteList.vue、MonthWorkspace.vue、MonthCalendarGrid.vue、NoteCard.vue、相关 motion／weather composable。拟新增：composables/useTimelineNotes.js、useCustomNotes.js、useTagGroupNotes.js、useCalendarWorkspaceModel.js；DOM 适配优先复用现有 motion 模块。

步骤：

1. 列表先提取状态／标签过滤的查询快照与统一失效入口。timeline、custom、tag group 各自分页序号必须受父级 load generation 约束，不能拆完后互相无法失效。
2. 分批提取 loadAllData/loadEarlier、loadCustomData/loadCustomMore、loadTagGroupsData/loadTagGroupPage；保留分页起点、limit 递增、总数、已展开内容与独立请求取消规则。
3. 组件保留 panelState/panelLeaving、实际 scroll refs、布局采集、滚动 anchor 与动画 hooks。数据替换前后用明确协作步骤连接，不让数据模块 querySelector。
4. 保留 modeSwitchRunning/pendingSortMode 与 exit/enter 动画的时序；已有 useNotePresenceMotion 接管 DOM 动画，不再实现第二套动效引擎。
5. 状态动作先保持 notes:start/complete/reopen 协议、提前开始确认、局部 patch 与后台刷新顺序；列表／日历可共享纯参数构造或命令适配，但各自展示过渡不硬合并。
6. 日历模型管理 month/week 查询、selectedKey、loadSequence、period、preview 参数与 pendingWeekNavigation。月与周分别保留原 navigation 策略。
7. 日历展示适配管理替换／刷新动画、focusCalendarDate、day panel/creator/editor 的 DOM 焦点和 resize。月份／周数据 DTO 与 shared event-layout 不改。
8. weather 数据可通过已存在 useWeatherRecovery 和小型查询端口共用；按日期展示与 UI 文案仍由列表／日历负责，避免再复制 freshness 规则。
9. 根据已有卸载逻辑迁移 timer、订阅与 animation 清理。需要新增 disposed／异步完成失效保护的地方在 S3 单列行为修复，不能混在“纯搬移”里宣称原逻辑不变。
10. NoteCard、MonthCalendarGrid、NoteEditor、ImagePicker 先保留公开 props/emits 和关键 DOM 标记。仅有明确复用或职责证据时再拆局部逻辑，禁止按文件长度批量改写所有 UI。

对应验证：note-list-refresh/tag-refresh/animation/completion/toolbar、tag-group-ordering、month/week-view/day-panel/context-menu/status、calendar-date/event-layout、draft-conflict-ui；T-006／T-007／T-010，C-004／C-005／C-009。

验收：旧请求不覆盖当前查询；分页、过滤、排序、滚动 anchor、退出动画与日历选择保持；业务模型不会变成新的 UI 巨型文件。回退：按 timeline/custom/tag/calendar 独立批次恢复，父 generation 与子分页一起恢复。

### D-011：先拆设置写入协调，再拆设置面板区块

现有：SettingsPanel.vue、WallpaperSettings.vue、WeatherSettings.vue、useSettingsSearch.js、applySettingsSnapshot.js 与现有 popover/modal 工具。拟新增：composables/useSettingsWriteQueue.js、按域的 settings form model；设置区块组件放在 components/system/settings/，具体数量以表单域为准。

步骤：

1. 提取通用设置的 pendingSaves/debounceTimers/inFlight 跟踪；平台专用 blur/auto-start/dock 请求加入同一总在途等待接口，但保留各自版本和初始化闸门。
2. queue 提供 enqueue/flush/cancelPending/trackInFlight/waitForIdle 等有限能力。它不定义默认值、renderer 白名单或原生成功条件。
3. 保留初始化／广播回填的同步闸门，防止赋 snapshot 触发写入；保留各项当前立即或延迟保存策略。
4. reset 仍先进入临界区、失效 auto-start 请求版本、停止拖动、丢弃待发送设置和 blur 请求、等待在途操作，再调用 resetSettings，最后回填并恢复闸门。
5. 卸载需要按已有规则 flush／cancel；不要让新 section 在旧父组件尚在退出期间卸载得更早，导致最后一笔写入丢失。
6. appearance/css、window/dock/blur、shortcuts、remote/update/diagnostics、weather/holiday、sticky、data reset 等按实际表单域提取模型；既有 WallpaperSettings/WeatherSettings 不重复包装。
7. 先只移动脚本逻辑，保留模板／CSS；队列和状态验收后，再按设置区块迁移模板。
8. section 接收本域 refs 与有限 actions，不接收整个父组件 context。Vue ref/reactive 的引用与 v-model 语义保持，避免普通解构丢失响应性。
9. 将区块用到的 scoped CSS、搜索定位 data 标记、焦点／popover anchor refs 和滚动记忆一起核对；父组件 scoped 规则不会自动作用到新子组件内部。
10. UI 抽取遵守 docs/UI_DESIGN_STANDARD.md，继续使用 tokens 与现有 usePopoverLifecycle／modal 工具；不新增局部中性灰或边线体系。
11. 不把所有 UI input 都改成同一自动保存组件；确认、原生激活、快捷键录制、重置等具有不同提交语义。

对应验证：application-settings/settings-schema、settings-scroll-memory、settings-panel-density、weather-settings、view-visibility-shortcut、blur-settings-main-wiring、ui-popover-motion、ui-components/feedback 的对应选定场景；T-007／T-009／T-010，C-003／C-007／C-009／C-010。

验收：reset 是最后生效的持久化操作，未发与在途写入区分正确；初始化不写回；搜索／滚动／焦点／主题／浮层退出无退化。回退：queue、表单模型和父/子区块按阶段恢复；不回退已有 UI 标准或用户原改动。

### D-012：收敛功能装配、托盘、协议与截图窗口集成

现有：index.js 服务构造与 callback，capture/*、services/Reminder*/Notification*/remote/*、sticky/*、tray/*、weather registration。拟新增：application/feature-runtime.js 或少量按域 factory、tray/main-tray-controller.js、services/notification-activation.js、capture/capture-window-integration.js。

步骤：

1. feature runtime 只装配、启动和停止已有服务；服务对象通过明确端口连接，不能成为可任意读取全应用状态的 service locator。
2. 托盘 controller 管理 tray、图标和菜单构造，调用明确的 open/switch/quit/shortcut/capture/reminder/sticky actions。业务状态改变只请求 rebuild，不反向写业务配置。
3. notification activation 管理 protocol argv、second-instance、pending reminder action 与窗口 reveal；服务／renderer 未就绪的队列保留，sender 与已退役窗口判定不放宽。
4. capture window integration 迁移 onCaptureStart/End/BusinessOpen：记录原可见／焦点、暂停停靠、按设置隐藏、业务打开／接受、失败恢复。正常结束不一概 show/focus。
5. shortcut runtime 保留会话启用开关、录制占用、冲突检测、startup notice 与恢复。不要写回已刻意取消持久化的 shortcuts.enabled。
6. weather 的 scheduler、window show/restore 与 powerMonitor 的暂停集合由该域管理，监听有明确释放归属；保持 integration 环境自动刷新禁用策略。
7. scheduler 保留现有同步 tick、任务重试和 TemplateSchedulerGuard。功能 factory 注册任务时保持失败计数、通知时机和 transaction 提交后广播；不夹带异步调度器重写。
8. sticky 的 saveContent 事务从入口移动到明确命令端口；来源便签冲突、记录更新及广播不拆散。既有窗口注册与显示管理继续使用现有 service。
9. RemoteCoordinator 的会话／outbox／退役服务策略、设备统计与更新策略保留；只整理调用与释放，不扩展联网行为。
10. NativeBlur 和 Qt engine 的现有协议／对象边界保持。AnnotationEditor、ImageDocument、CaptureEngine 若在 S3 有明确状态／职责缺陷，再提出有证据的具体 C++ 改动，当前不因跨语言边界重写它们。

对应验证：sticky-service/tray-menu/persistence、view-visibility-shortcut、capture-lifecycle/business/host、reminder-service/native acceptance、scheduler/template-scheduler-guard、weather-refresh、remote-health、logging-actions；T-005／T-007／T-008／T-009／T-010，C-005／C-006／C-007／C-008／C-010／C-013。

验收：入口只装配少量功能域，feature runtime 没有接管内部业务状态；启动／退出顺序与 callback 结果一致，订阅／快捷键／pause 资源无重复注册和遗漏释放。回退：factory、服务委托、菜单／协议与入口接线成组恢复。

## 6. 拟新增模块地图与迁移方法

路径是实施目标，不表示已经存在。若 S3/S4 确认某模块只增加无意义转发，应合并或取消并记录原因，不机械创建全部文件。

| 目标区域 | 主要新增能力 | 从哪里迁移 |
|---|---|---|
| src/main/application | bootstrap、shutdown、有限 feature 装配 | index startup / before-quit / service constructors |
| src/main/settings | settings runtime、背景事务协调 | refresh/persist/snapshot、blur/wallpaper request |
| src/main/windows | main window host、view navigation、presentation、z-order、blur、drag、geometry | index 对应状态域和事务 |
| src/main/window-motion | dock runtime，复用已有纯规则和平台 backend | index dock state/session/hide/show/recovery |
| src/main/ipc | window/settings/background/app/remote/shortcut 注册 | index 各域 literal IPC |
| src/main/notes | 跨资源 note commands | business IPC 中的完整草稿与附件事务 |
| src/main/db | settings repository、runtime、attachment recovery、data reset | db.js；note queries 后续按收益决定 |
| src/main/tray / services / capture | tray controller、notification activation、capture window integration | index 中的功能协调回调 |
| src/renderer/src/composables | workspace runtime/wallpaper/notices/update、列表模型、日历模型、settings queue | App、MonthApp、NoteList、MonthWorkspace、SettingsPanel |
| src/renderer/src/components/system/settings | 实际需要的设置区块 | SettingsPanel 的 template/style，脚本验收后迁移 |

迁移一项的具体操作：

1. 标记当前入口、依赖、状态与失败恢复，确认测试契约和现有源码断言读取位置。
2. 提取完整闭合职责，首轮保留原函数行为／参数／返回和条件分支；外部调用暂通过旧名称委托。
3. 将关联状态、timer、listener、revision 与 dispose 同时迁移，不把状态留在旧入口让新模块跨层写回。
4. 用窄 port 接替跨域调用，逐个迁移消费者，检查 import 与运行期回调方向。
5. 按相关 T 条目运行明确局部验证及必要平台集成，记录实际源码／产物版本与未覆盖环境。
6. 确认没有重复状态所有者、双安装监听、失效操作残留和未迁移消费者后，再删除旧委托与死引用。
7. 代码格式／文件命名在该批局部调整；不夹带整个仓库格式化或其他 dirty 文件修改。

## 7. 建议实施批次与前置保护

真正批次由 S4 与 R/T 条目合并后决定。下表避免“一次抽空 index.js”或“同时重做全部 UI”。

| 批次 | 迁移内容 | 必要前置 | 完成边界 |
|---|---|---|---|
| B0 | D-001；T-001/T-002 的基线与契约登记 | S3/S4 准备完成 | 规则、所有权、保护和可恢复状态可追踪 |
| B1 | D-008 设置 repository/兼容外观；D-003 settings snapshot 核心 | B0；对应 SQLite 保护 | 设置边界可独立使用，无 schema 变化 |
| B2 | D-009 小型共用方法；D-007 app/update/logs 等简单注册 | B0；相关应用/IPC 保护 | 共用 runtime 与入口差异明确；先不动 UI 框架 |
| B3 | D-004 host；D-005 geometry；D-002 bootstrap/exit 的原序迁移 | B1；窗口/退出保护 | 主窗口引用、事件归属、稳定几何与生命周期可控 |
| B4 | D-006 native/background；D-005 dock 子批次；D-004 navigation/presentation | B3；原生状态与竞争保护 | 按事务逐批迁移，原接口暂委托，不发生跨域指令环 |
| B5 | D-007 note 跨资源命令；D-008 recovery/reset | B1；资产/冲突/恢复保护 | 事务、文件补偿与广播时点保留 |
| B6 | D-010 列表/日历模型；D-011 write queue→区块 | B1/B2；局部 UI 与写入竞争保护 | 数据/展示分工明确、原交互与标准保持 |
| B7 | D-012 剩余功能装配；兼容入口清理；T-006/T-012 同步 | 对应迁移批次已验证 | source/test/config/docs 接线一致，无孤立状态与消费者 |

D-003、D-004、D-005、D-006 相互需要的是接口约定，不应形成“全部完成才可开始任何一项”的循环依赖。D-001 固定端口，旧入口委托可作过渡；S4 按具体子批次处理接线。

每批验证只覆盖实际修改的契约，不把别的 dirty 文件纳入。公共模块影响大时说明消费者与建议扩大范围，不自动全量。必要 app/native/capture 构建按 T-004，真实 Windows/Electron 专项按 AGENTS.md 从合适环境执行。

## 8. 跨阶段映射与不遗漏条件

| D 条目 | 测试准备条目 | 风险契约 |
|---|---|---|
| D-001 | T-001/T-002/T-006 | 对应功能的全部 C |
| D-002 | T-005/T-007/T-009 | C-001/C-004/C-007/C-008/C-013 |
| D-003 | T-002/T-007/T-009 | C-003/C-007 |
| D-004 | T-006/T-007/T-009/T-010 | C-003/C-004/C-007/C-009 |
| D-005 | T-004/T-009 | C-007 |
| D-006 | T-004/T-007/T-009 | C-002/C-003/C-007 |
| D-007 | T-002/T-005/T-006/T-007 | C-002/C-004/C-006/C-012 |
| D-008 | T-007/T-008 | C-001/C-002/C-003/C-004/C-005 |
| D-009 | T-007/T-009/T-010 | C-004/C-007/C-009/C-010 |
| D-010 | T-006/T-007/T-010 | C-004/C-005/C-009 |
| D-011 | T-007/T-009/T-010 | C-003/C-007/C-009/C-010 |
| D-012 | T-005/T-007/T-008/T-009/T-010 | C-005/C-006/C-007/C-008/C-010/C-013 |

S3 审查必须进一步核对：

- 多 scope 设置写入是否需要完整业务原子性；当前代码事实是分别调用批写，不能仅凭结构判断应改 schema 或已经有事故。
- 文件/SQL 提交与清理报错的结果协议，是否存在“已提交但返回失败”的歧义，以及如何保持用户可恢复。
- async mounted/load/animation 回调在 renderer 卸载、view/window 变化后的失效检查是否足够。
- IPC sender 检查、stale 特例、诊断 wrapper 与专属窗口能力在迁移中是否完整。
- 退出 timeout、在途 remote/capture/diagnostic 请求和 DB/log close 的边界是否满足当前产品要求。
- 原生 requested/effective/confirmed 的一致性、多 DPI、显示器变化与停靠 cleanup 的状态恢复。
- App/Month 现有细节差异是刻意产品策略还是可统一行为；未确认前保留。
- 现有源码结构测试的预期是否对应有效契约；不能因为拆分导致失败就删掉。
- 本阶段只明确职责边界；并不把这些待审事项预判为已确认 Bug。

## 9. 实施检查表、停止条件与回退

当前准备已完成：

- [x] 主要职责、合理边界与优先级已列明。
- [x] 状态所有权、资源生命周期和并发策略已列明。
- [x] 文件级迁移步骤、兼容约束、验收与回退已列明。
- [x] D 与 T/C 的对应关系、建议子批次和待审事项已列明。
- [x] 拟新增文件明确标记，没有预建业务模块或虚构运行结果。

实施时：

- [ ] 刷新源码与 dirty 基线，区分原有修改和本批修改。
- [ ] 每个 state/timer/listener/waiter/revision 都有迁入位置和 dispose。
- [ ] main/shared/renderer/native 的依赖方向清楚，既无 import 环也无跨域隐式命令环。
- [ ] 不以“新模块只引用旧入口全部变量”完成表面拆分。
- [ ] 原始 IPC 通道、参数、返回、sender、广播 reason 和诊断关联未遗漏。
- [ ] source-text 测试读取路径与预期合理迁移，原有效保护未删除。
- [ ] settings scope、DB schema、manifest、资源路径、DTO 与 transaction 没有附带改变。
- [ ] 单主窗口、week 模式、compact、草稿会话、快捷键会话与更新/首次使用策略保持。
- [ ] 月／周／列表／背景请求的并发策略没有被通用 abstraction 改写。
- [ ] 物理像素、DIP、CSS 单位和原生 ABI 兼容已按实际修改核对。
- [ ] UI 模板抽取包含 scoped style、搜索标记、DOM hooks、动画与焦点责任。
- [ ] 模块安装不重复，部分失败/取消/退出的释放路径完整。
- [ ] 按本批契约实际验证，未运行全量和物理环境风险明确。
- [ ] 旧导出/委托只在全部消费者迁移并验证后删除。
- [ ] 文档状态和结果已同步，引用实际源码与产物证据。

停止条件：规则冲突、目标模块只增加透传、需要未准备的数据迁移、同文件并行用户修改、前置产物未知、测试保护不足或真实环境阻塞。停止相关依赖批次，继续独立准备；不通过扩大至全量或降低断言绕过。

回退：以本批真实 diff 和 T-001 快照恢复状态所有者、调用方、IPC、测试定位、构建与文档接线。保持用户原有改动。纯结构迁移不修改存量数据；凡涉及 schema、manifest 或 native ABI 的改动另有独立兼容与回退条目。

## 10. 本轮交付与证据边界

本轮只读源码、静态 AST/依赖/通道清点，并新增本指导、更新阶段索引。未改业务代码、测试、配置、构建或 CI，未运行局部测试、全量测试、lint、构建、Electron、原生或安装专项。

已形成可按文件和条目实施的解耦方案。运行期正确性、客户机器、多屏 DPI、系统通知、真实重启与长期运行没有新增验证结论；S3 审查和 S4 合并计划仍未开始。

## 附录 A：静态 IPC 注册定位

下面列出本轮从明确 IPC 对象与截图 handle-helper 调用提取的 146 处字面量注册，并补列 ReminderWindow 的 4 项授权别名注册。它是迁移核对起点，不等于全部协议清单：动态通道／常量、日志底层 wrapper、事件广播、preload invoke/send/on、protocol 和条件安装仍需逐项对照。

每项行号仅用于当前基线定位；实际迁移前以函数/通道名称重新定位。全部通道初始状态为“待迁移核对”，不是要求所有文件都拆分或改动。

### src/main/capture/CaptureCoordinator.js

| 通道 | 注册方式 | 当前行 |
|---|---|---|
| `screenshot:capture` | handle-helper | 61 |
| `screenshot:ack` | handle-helper | 68 |
| `screenshot:cancel` | handle-helper | 69 |
| `screenshot:source-gone` | handle-helper | 72 |

### src/main/index.js

| 通道 | 注册方式 | 当前行 |
|---|---|---|
| `logs:query` | handle | 4471 |
| `logs:open-folder` | handle | 4475 |
| `logs:export` | handle | 4483 |
| `update:check` | handle | 4556 |
| `app:get-info` | handle | 4560 |
| `update:open-link` | handle | 4564 |
| `renderer-ready` | on | 4575 |
| `presentation-mode:renderer-ready` | on | 4623 |
| `window-close` | on | 4629 |
| `view:switch` | handle | 4635 |
| `toggle-lock` | handle | 4661 |
| `set-window-z-order-mode` | handle | 4703 |
| `window-get-bounds` | handle | 4760 |
| `presentation-mode:get-state` | handle | 4765 |
| `presentation-mode:enter-compact` | handle | 4766 |
| `presentation-mode:exit-compact` | handle | 4769 |
| `presentation-mode:begin-drag` | handle | 4772 |
| `presentation-mode:update-drag` | on | 4775 |
| `presentation-mode:end-drag` | handle | 4779 |
| `presentation-mode:show-context-menu` | handle | 4780 |
| `titlebar-window:begin-drag` | handle | 4804 |
| `titlebar-window:update-drag` | on | 4807 |
| `titlebar-window:end-drag` | handle | 4811 |
| `window-resize:end` | handle | 4814 |
| `window-set-bounds` | on | 4816 |
| `shortcuts:startup-notice` | handle | 4851 |
| `shortcuts:dismiss-startup-notice` | handle | 4859 |
| `shortcuts:retry` | handle | 4862 |
| `set-setting-value` | handle | 4875 |
| `shortcut:view-visibility-capture-start` | handle | 4882 |
| `shortcut:view-visibility-capture-end` | handle | 4899 |
| `shortcut:view-visibility-set` | handle | 4905 |
| `shortcut:capture-set` | handle | 4922 |
| `set-dock-config` | handle | 4938 |
| `get-settings-snapshot` | handle | 4947 |
| `remote-notices:list-pending` | handle | 4962 |
| `remote-notices:list` | handle | 4963 |
| `remote-notices:acknowledge` | handle | 4964 |
| `remote-notices:open-link` | handle | 4967 |
| `remote:get-health` | handle | 4982 |
| `reset-settings` | handle | 5001 |
| `window-hover` | on | 5053 |
| `set-blur-config` | handle | 5129 |
| `wallpapers:list` | handle | 5229 |
| `wallpapers:get-thumbnail` | handle | 5230 |
| `wallpapers:get-data` | handle | 5233 |
| `wallpapers:save` | handle | 5236 |
| `wallpapers:activate` | handle | 5237 |
| `wallpapers:disable` | handle | 5276 |
| `wallpapers:delete` | handle | 5277 |
| `clear-note-data` | handle | 5551 |
| `verify-auto-start` | handle | 5593 |
| `set-auto-start` | handle | 5601 |
| `scheduler:retry` | handle | 5759 |
| `scheduler:health` | handle | 5764 |

### src/main/ipc/register-business-ipc.js

| 通道 | 注册方式 | 当前行 |
|---|---|---|
| `clipboard:write-text` | handle | 216 |
| `notes:create` | handle | 223 |
| `notes:create-with-assets` | handle | 227 |
| `notes:restore` | handle | 277 |
| `notes:update` | handle | 281 |
| `notes:set-text-color` | handle | 293 |
| `notes:save-draft` | handle | 299 |
| `notes:delete` | handle | 468 |
| `notes:purge` | handle | 474 |
| `notes:get` | handle | 490 |
| `notes:query-pinned` | handle | 491 |
| `notes:query-recent` | handle | 492 |
| `notes:query-compact` | handle | 493 |
| `notes:query-earlier` | handle | 494 |
| `notes:query-custom-pinned` | handle | 495 |
| `notes:query-custom-normal` | handle | 496 |
| `notes:query-tag-groups` | handle | 497 |
| `notes:query-tag-group` | handle | 498 |
| `notes:search` | handle | 499 |
| `notes:count-active` | handle | 500 |
| `notes:reorder-custom` | handle | 501 |
| `notes:update-custom-order` | handle | 502 |
| `notes:start-progress` | handle | 503 |
| `notes:complete` | handle | 506 |
| `notes:reopen` | handle | 509 |
| `tags:create` | handle | 513 |
| `tags:update` | handle | 517 |
| `tags:delete` | handle | 526 |
| `tags:update-order` | handle | 534 |
| `tags:list` | handle | 539 |
| `tags:get` | handle | 540 |
| `tags:usage` | handle | 541 |
| `note-tags:bind` | handle | 542 |
| `note-tags:unbind` | handle | 545 |
| `note-tags:set` | handle | 548 |
| `note-tags:list` | handle | 554 |
| `templates:create` | handle | 556 |
| `templates:update` | handle | 559 |
| `templates:delete` | handle | 562 |
| `templates:list` | handle | 565 |
| `templates:get` | handle | 566 |
| `templates:pause` | handle | 569 |
| `templates:resume` | handle | 572 |
| `templates:restore` | handle | 575 |
| `templates:purge` | handle | 578 |
| `templates:preview-next-run` | handle | 590 |
| `images:save-batch` | handle | 599 |
| `images:delete` | handle | 637 |
| `images:list` | handle | 643 |
| `images:get-base64` | handle | 644 |
| `images:get-dimensions` | handle | 645 |
| `images:get-thumbnail` | handle | 648 |
| `images:count` | handle | 651 |

### src/main/ipc/register-calendar-ipc.js

| 通道 | 注册方式 | 当前行 |
|---|---|---|
| `calendar:get-almanac` | handle | 22 |
| `calendar:get-month` | handle | 27 |
| `calendar:get-week` | handle | 36 |
| `calendar:holiday-data-status` | handle | 45 |
| `calendar:holiday-data-import` | handle | 49 |
| `calendar:holiday-data-download` | handle | 62 |
| `calendar:holiday-data-open-link` | handle | 68 |
| `calendar:holiday-data-notice` | handle | 75 |
| `calendar:holiday-data-dismiss-notice` | handle | 78 |

### src/main/ipc/register-daily-report-ipc.js

| 通道 | 注册方式 | 当前行 |
|---|---|---|
| `daily-report:preview` | handle | 30 |
| `daily-report:export` | handle | 40 |
| `daily-report:open-export-folder` | handle | 88 |

### src/main/ipc/register-weather-ipc.js

| 通道 | 注册方式 | 当前行 |
|---|---|---|
| `weather:resolve-location` | handle | 42 |
| `weather:get-division-tree` | handle | 46 |
| `weather:get-forecast` | handle | 50 |
| `weather:refresh-forecast` | handle | 54 |
| `weather:open-source` | handle | 61 |

### src/main/logging/diagnostic-controller.js

| 通道 | 注册方式 | 当前行 |
|---|---|---|
| `logs:policy-get` | handle | 129 |
| `logs:ending` | on | 168 |
| `logs:continuing` | on | 184 |
| `logs:policy-applied` | on | 188 |
| `logs:batch` | on | 197 |
| `logs:frozen` | on | 273 |
| `logs:state` | handle | 364 |
| `logs:mode-start` | handle | 365 |
| `logs:mode-extend` | handle | 379 |
| `logs:mode-stop` | handle | 384 |

### src/main/sticky/ElectronStickyService.js

| 通道 | 注册方式 | 当前行 |
|---|---|---|
| `sticky:create` | handle | 103 |
| `sticky:get-state` | handle | 123 |
| `sticky:ready` | handle | 124 |
| `sticky:close` | handle | 125 |
| `sticky:toggle-pin` | handle | 126 |
| `sticky:update-content` | handle | 127 |
| `sticky:update-appearance` | handle | 130 |

### src/main/services/ReminderWindow.js（授权 ipc 别名，补充核对）

| 通道 | 注册方式 | 当前行 |
|---|---|---|
| `reminders:state` | ipc.handle | 32 |
| `reminders:action` | ipc.handle | 33 |
| `reminders:ready` | ipc.handle | 38 |
| `reminders:hide` | ipc.handle | 44 |
