# B7a 后续实施指导：业务清空准入、服务生命周期、托盘与通知激活

日期：2026-10-09。状态：**后续明确实施授权后的模块、主入口接线与本域精准局部验收已完成，平台边界保留**。此前仅前期准备阶段的生产补丁曾被自动审批拒绝，未执行该补丁；后续授权实施后才创建下述模块与测试。方案与消费者清单保留作操作指导，当前实现、证据和验收边界见 §10；Reminder late failure 成立缺陷的窄修见 §11。

关联：15-B7b 数据审查；12-B7a sticky 已有实施记录；B3/B4 主窗口、Dock、展示和导航模块；B6 设置队列；主代理的 R-007～R-016 与总状态账。

## 1. 实施单位与唯一状态所有者

| 拟议文件                                     | 真正迁入的状态/操作                                                                                                                          | 留在已有 owner 的内容                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `application/business-mutation-admission.js` | 完整业务写命令 pending、clear准入关闭状态、等待旧写、重复clear阻断及finally恢复                                                              | SQLite连接/事务、资源manifest/补偿、renderer草稿本身                                           |
| `application/feature-runtime.js`             | sticky/notification/reminder/trayReminder/scheduler 的实际创建顺序、创建台账、初始化与一次性释放；任务注册与resume订阅；天气自动刷新生命周期 | 各服务自身DB轮次/窗口/请求state；capture/remote/diagnostic和主窗口/Dock独立owner               |
| `tray/main-tray-controller.js`               | 真实tray句柄、shortcut两种图标、menu构造/rebuild、click订阅、tooltip、destroy                                                                | 快捷键session gate、sticky记录与窗口、tray提醒blink状态、视图切换/退出审批                     |
| `services/notification-activation.js`        | pending reveal/context、最多32 reminder动作、早期URL/argv接收、ready后消费、compact恢复后显示                                                | durable提醒轮次、协议解析规则、真实主窗口与展示状态                                            |
| 天气所属模块的必要增量                       | feature侧power pauses/可视订阅及controller disposal失效；weather registrar注册清单释放                                                       | 现有 `createWeatherRefreshController` pending/backoff/generation，WeatherService缓存队列与网络 |

主入口不能继续留下对应 `let` 镜像，也不能新增 `services.get(name)` service locator。对外是具名操作/只读状态；测试专用已存在接口可在integration flag下接只读服务观察，不变成产品业务跨owner随意写属性。

## 2. 清空竞态：复现与修复范围

证据 `tmp/refactor-baselines/B7b-clear-race/result.json`：生产createWithAssets函数停在异步stage，clear SQL之后放行，旧请求仍创建一行。源SHA记录于JSON。依赖为受控fixture，证明顺序缺口；不是实际Electron/SQLite/文件/GUI清空验收。

### 窄接口与行为

拟议 `createBusinessMutationAdmission()` 返回：

- `run(operation)`：clear关闭准入时同步拒绝；普通同步操作保留结果/throw，不无条件Promise化。async返回值在完整settle前登记，原值/错误返回调用方。
- `clear(operation)`：同步置关闭标志，拒绝重复clear；对已登记完整Promise用allSettled排空，然后运行完整clear编排；DB失败、草稿失败或其它拒绝均finally恢复可写。
- `snapshot()`：只读 `{ clearing, pending }`，用于精确测试和诊断；不暴露Set，不把generation复制到业务模块。

只观察settle并从Set释放，不在finally链上产生无人接收的新rejection。旧命令失败仍向原调用方报告原错误；排空不把该错误覆盖为clear错误。它不是全局串行写队列：一般写按原来的并发/事务执行，只有clear暂时关闭准入。

### 写入接线位置

在组合根创建一份owner；生产必须注入，不让每个注册器创建独立gate。`registerBusinessIpcHandlers` 新增 `runMutation` 端口，在**授权之后**、进入完整mutation/诊断观察之前包装；不能用gate绕过sender授权，不能只包装SQL尾部。

明列下述变更通道，不按前缀把所有读/剪贴板都挡住：

| 类型      | 必须登记的通道                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| notes     | create、create-with-assets、update、save-draft、set-text-color、restore、delete、purge、start-progress、complete、reopen、reorder-custom、update-custom-order |
| tags      | create、update、delete、update-order                                                                                                                          |
| note-tags | bind、unbind、set                                                                                                                                             |
| templates | create、update、delete、pause、resume、restore、purge                                                                                                         |
| images    | save-batch、delete                                                                                                                                            |

其中create/save/batch/purge的pending从stage开始一直覆盖提交后cleanup/失败compensation以及边界广播；不把只剩资源清理的已提交命令提前摘掉。读接口可继续读，以本次真实DB返回为准。

还必须核对绕开该注册器的真实变更：sticky `saveContent` 包装完整 `saveStickyNoteContent`；stickyRepository insert/update/delete/deleteAll等持久变更包装同一run；其它快捷创建和截图最终note保存入口沿真实调用链接到同一owner。主入口integration测试seed的直接create仅测试初始化，不能据此给产品保留后门。模板/activation任务为同步完整SQL，无await交错，但clear期间仍应在task shouldRun或执行准入处阻止新业务写，避免将后台scheduler算成用户可写例外。

clear自身不能调用run再调用clear造成自锁。清空时用于discardAllRuntime的实现必须只丢runtime；若后来改为写repository，应在clear操作明确内部端口执行，不能意外触发关闭状态的外部run。

### `clear-note-data` 顺序

保持handler外层授权，在owner.clear内依次：

1. 准入已关闭并排空旧命令后读取counts，避免日志统计遗漏刚完成的写。
2. `await clearNoteData()`：沿已有目录stage、同步事务、marker、清理。事务中无await，不改Q008。
3. 读取实际DB后刷新reminder，discard sticky runtime，调用固定renderer `__clearEditingDrafts`；按现有顺序广播note-data-cleared并记录成功数量。
4. 草稿清理失败沿现有明确文案报告“业务数据已清空，但编辑草稿清理失败”；不能当数据库回滚或自动恢复旧业务资料。
5. 所有路径finally重开准入。重复clear在准入关闭时reject；错误后用户新操作/明确重试可执行。

提醒刷新/便利贴丢弃/广播异常的隔离属于提交后表现边界：先记录当前行为与成立风险，再决定是否独立修复，不借本次gate改造静默更改全部错误语义。清空期间新请求收到明确busy，不后台排队等清空后复活旧form。

### 取得实施授权后的精准验收

- owner单元：sync结果/原error，旧stage→SQL→cleanup完整排空，新写blocked，失败补偿排空，重复clear，async草稿阶段仍blocked，SQL/已提交draft错误后恢复可写。
- 注册器单元：实际授权wrapper调用owner；mutation清单逐组有代表性create/save/images/tag/template例，读/剪贴板不误挡；原诊断与广播顺序保留。不要逐通道写重复实现镜像测试。
- 精确真实专项：临时磁盘SQLite/真实stage原语，先暂停大附件stage，触发真实clear，证明clear等旧create完成后最终notes/files/staging一致；另跑旧save失败补偿、image batch、重复clear、DB clear trigger失败可重试。计数/业务完成/cleanup必须真实报告，不能只有exit0。
- 最后完整app UI的一条窄链：旧创建/编辑mounted→clear→旧asyncsettle→数据库0/窗口列表0/草稿无复活，下一新建成功；清空成功草稿清理故障必须显示已清空文案。使用实际build/source哈希，假IPC专项不代替UI。
- 不全量测试，不改变或删除全部旧测试；只按这些实际修改边界显式选择文件和对应必需build。

## 3. feature runtime：完整创建与释放台账

### 建议接口

`createFeatureRuntime({ app, powerMonitor, ipcMain, nativeImage, logger, protocol, capability, icon, paths, platform, development, integrationTest, getWindow, getApplicationWindows, getSettingsSnapshot, getListStickyAppearance, stickyRepository, businessAdmission, onRegistryChanged, revealApplication, runBlurDiagnostic, shouldCheckDockHealth, runDockHealthCheck, canPresentWeather, shell, userDataPath, appVersion, beginPerformanceOperation })`。

参数按实际职责分成具名小DTO，实施时不逐层重复几十个位置参数；不存在的端口不加空配置。生产构造器直接导入对应服务，测试用窄factory注入验证创建/释放失败，不注入一个可任意查询的通用容器。

上面的长列表用于核对现有依赖，**不能原样实现成巨型context**。最终构造只接受 `lifecycle`、`reminders`、`stickies`、`schedule`、`weather` 五个小DTO；每个DTO只传给对应创建阶段/子owner，不共享一个包含所有可变globals的对象：

| 小DTO                      | 明确内容                                                                                       | 最终消费与状态归属                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `lifecycle`                | `app/powerMonitor/logger` 的现有窄适配器、`integrationTest`；资源释放结果记录回调              | feature只登记准确listener/created ledger并编排；不在此DTO放DB/window/services对象                       |
| `reminders.configuration`  | protocol、capability、icon、platform、reminder preload/renderer路径和dev URL                   | NotificationService/ReminderWindow各自得到所需值，配置只读，不创建第二caps/window状态                   |
| `reminders.windowPorts`    | getMainWindow、getSettingsSnapshot、onNoteChanged                                              | reminder子图创建时注入；真实窗口仍由main-window-host拥有，功能结果经回调广播                            |
| `reminders.activationPort` | `reveal`回调、`attachAction`/`detachAction`回调                                                | activation仍单独拥有pending/contexts；feature只在ready/dispose时接上/解绑动作，不查询它内部queue        |
| `stickies.configuration`   | sticky preload/renderer路径/dev URL、isDevelopment                                             | ElectronStickyService构造配置，reminder路径不在此复制                                                   |
| `stickies.commands`        | getNoteById、完整saveContent、read/write repository具名方法；写入口已连接同一businessAdmission | note命令和DB保持各自owner；feature不缓存note/row，不直接展开SQL。repository method只在sticky子owner持有 |
| `stickies.windowPorts`     | getMainWindow、getListAppearance、onNoteChanged、onError、onRegistryChanged                    | sticky子owner消费；tray只由onRegistryChanged请求rebuild，不通过feature读写tray句柄                      |
| `schedule.commands`        | activateNotes、runRecurringTemplates；单一业务准入run/clearing只读条件                         | feature负责依原顺序注册完整任务；DB事务与模板单项失败仍在原命令owner                                    |
| `schedule.runtimeChecks`   | blurDiagnostic、shouldCheckDockHealth、dockHealthCheck、onNotesChanged、onTemplatesChanged     | 真实blur/Dock仍在各owner，传行为函数而非state布尔/镜像；通知由已就绪reminder子图具名操作执行            |
| `weather.configuration`    | userDataPath、appVersion；shell/ipc的窄适配器                                                  | registerWeatherIpcHandlers创建实际WeatherService/controller；feature不接forecast cache对象              |
| `weather.windowPorts`      | getMainWindow、getWeatherSettings、canPresentWeather                                           | weather子owner通过getter读真实值；feature只组合自身powerPause/isDisposed条件，不维护visible/compact镜像 |
| `weather.performancePort`  | beginPerformanceOperation和reportAutoRefreshError                                              | 天气刷新生命周期记录实际async完成；不让feature拥有网络Promise/backoff/cacheWriteQueue第二副本           |

相同的getMainWindow函数可作为只读引用注入两个子owner；这不产生第二window状态。一次初始化方法仅取得该阶段DTO，不能把五个DTO再次合并成通用参数袋传入每个service。需要测试factory时按 `reminderFactories`、`stickyFactory`、`schedulerFactory`、`weatherRegistrar` 定点注入，默认直接导入生产实现；不提供create(anyName)或get(anyName)。

feature本体只保创建顺序、资源拥有关系、阶段/订阅台账和已就绪子图的具名操作。业务清空、tray菜单、通知activation、网络请求、DB、真实window均分别归自己的owner；公开端口不足时先确认真实消费者，再追加一个具名方法，不暴露全部context让调用方自选service。

对外方法按真实消费需要：

- `initializeSticky()`、`initializeReminders()`、`startScheduledTasks()`、`initializeWeather()`：保留启动位置，成功后加入created ledger。重复调用明确返回已就绪或拒绝，不创建第二服务。
- `refreshReminders()`、`sendReminderSettings()`、`showReminders()`、`applyNativeReminderAction(payload)`、`attachReminderTray(tray)`、`setReminderBaseIcon(icon)`、`acknowledgeReminderTray()`。
- `stickySnapshot()/stickyCommands` 或只读具名sticky端口：仅对已有tray/IPC需要的list/focus/showAll/close/restore/discardByNoteId/discardAllRuntime开放，不暴露任意service properties。
- `settingsChanged()`：weather controller签名同步与reminder popup settings更新；没有重新new controller。
- `schedulerHealth()`、`retryScheduledTasks()`，测试flag下观察轮次状态。
- `stopScheduledTasks()`、`disposeReminders()`、`disposeSticky()`、`disposeWeather()`及总 `disposeCreated()`：与shutdown既有阶段次序组合，ledger保证每个资源一次；不把geometry/DB/native/tray提前释放。
- `snapshot()`：阶段/created/completed/failed/active subscriptions的只读诊断；不返回第二份可写状态。

`notification-activation`通过具名 `applyNativeReminderAction`消费，在reminder初始化完成后一次性attach，不再在index保存service和pending数组。测试需要真实service时限定旧integration hook保留兼容观察。

### 创建台账必须处理部分启动

资源**一旦构造成功即可记入台账**，不能只在整个initialize成功后登记，否则initialize抛错会泄漏已构造窗口/IPC/timer。构造器内部在返回前抛错且已注册部分资源，由该类自己的构造失败补偿负责，或将可失败初始化分开；feature不能处置它从未获得的句柄。

reminder复合图有notification→trayReminder→popup→ReminderService。完整Servicedispose已处置三个child，台账须标记拥有关系：组装成功后由service统一dispose，child标成transferred；组装中失败时逆序分别release。避免group dispose后再次child dispose，尤其notification需保留已送Windows toast跨启动动作。某一dispose抛错应记录且继续其他已创建资源，不吞掉日志或留下未attempt项。

Scheduler在before-ready可构造但不start；通知capability按现有supported/reason设置。注册activation→template→reminder→blur diagnostic→dock health，原顺序不换；weather在原之后注册。`start`只一次，power resume按绑定函数引用注册并台账解除。关停先停止scheduler，再dispose天气监听/请求发布、提醒和sticky，最后由已有shutdown阶段关闭DB/native/tray/log。

### 完整任务迁移

activation保留 `activateNotes()`、count/notified/performanceCounts、logger和主窗口notes changed。template保留guard、autoPaused中文通知、templatesChanged判定、ids/broadcast/performanceCounts；单模板3、guard3/5min、SchedulerInfinity各自保留。reminder task保留 now参数与retryBackoff；blur/dock只注入真实callback/条件，runtime仍属对应owner。

勿把既有sync scheduler换成async任务全局等待；天气自己finish异步性能。任何广播失败是否影响已提交操作需先复现并独立处置，不以提取为由统一修改错误策略。

## 4. tray controller：菜单、订阅、图标和销毁

建议 `createMainTrayController({ Tray, Menu, icon, createShortcutImages, getShortcutsEnabled, getViewMode, getStickyCommands, getCaptureCommands, showReminders, toggleShortcuts, acknowledgeReminders, attachReminderTray, setReminderBaseIcon, openMainWindow, switchView, toggleWindow, requestQuit, logger })` 返回 `create()`、`rebuild()`、`menuTemplate()`、integration专用 `triggerClick()`、`dispose()`、只读snapshot。

`create`真实生成两种shortcut图标、new Tray、attach提醒blink、绑定click、rebuild。失败清理已建立tray/listener，不能用另一份index tray兜底。`rebuild`只读实时session gate/view/sticky/capture，不保存菜单数据镜像；shortcut base icon先交reminder controller，保持blink过程中切图标的最新恢复目标。tooltip保持原“重启恢复”文案。

menu结构和文案保持：查看便签提醒、禁用全部快捷键checkbox、conditional截图/贴图动作、StickyTrayMenu的视图radio、列表/恢复/关闭、退出。已有StickyTrayMenu仍拥有其纯菜单模板，不把里面每个action拆成无状态包装；真实tray controller负责组合/副作用。

异步open/switch/capture用原catch/logger/report路径，不能仅 `void`抛出无人接收promise；原sticky菜单restoreMissing的错误边界先登记，若要修复须有成立证据。左键click先acknowledge再toggle，保持用户手势语义。每次service注册变化、视图切换成功/失败恢复、session快捷键切换/设置reset都明确调用rebuild；不订阅另一个隐藏全局bus来代替实际调用点。

dispose解除自己的click listener后destroy一次，清句柄/图标引用。blink由feature的trayReminder owner先停；controller不再次dispose整个reminderService。测试可以用EventEmitter假tray验证真实listener生命周期，必须补一条actual tray/app专项才能声称真实接线通过。

## 5. notification activation：早接收、ready消费与可視恢复

建议 `createNotificationActivation({ protocol, getWindow, exitCompactPresentation, openMainWindow, logger, now })` 返回 `handleProtocol(url,source)`、`handleArgs(argv,source)`、`reveal(context)`、`settlePendingReveal()`、`attachReminderAction(handler)`、`detachReminderAction()`、`dispose()`与只读snapshot。

模块构造不读取真实window、不启动服务，可在before-ready接受第二实例URL。`parseReminderProtocol`沿共享规则；不能宽松接受任意noteid/URL/action。服务未就绪动作最多32，动作已解析后才进queue；attach后按原顺序splice一次并交ReminderService.nativeAction，该层继续处理stale round。不要把持久轮次复制到activation，pending只保内存动作。

open接收后只设置pending reveal/context并log：source、hadLegacyNoteId、requestedAt和windowSnapshot。若窗口缺失/销毁/loading，保留pending；renderer-ready或重建ready调用settle。settle在开始异步expand前消费context，exitCompact({source:notification,showWhenDone:true})成功open/log，失败按原scope日志并尝试open。同一pending不能被两个ready回调重复消费。

dispose关闭接收并标记late reveal不可操作已释放窗口；不清durable round、不关闭已送系统通知。部分启动失败后detach只移除handler，不伪造已消费，明确是否保留pending直到终止。late expand完成/失败时重查disposed和当前实际window状态，不能捕获旧window引用去show；若窗口已被合法重建，按当前window打开。新增该guard属于生命周期成立边界的精确实现与测试，不把冷启OS路径冒称已验证。

主入口的single instance lock、协议关联/AppUserModelId/ToastActivatorCLSID仍是bootstrap产品配置；此模块不改注册系统协议，不在integrationTest下新增系统写。当前代码没有open-url监听，不借提取自动加macOS新路径；如后续产品要求，单列兼容与真实平台验证。

## 6. 天气刷新生命周期

feature迁入当前 `weatherPowerPauses` Set、show/restore监听、suspend/lock-screen添加pause、resume/unlock-screen删除对应pause并刷新；全部保存准确listener函数引用，由ledger去注册/释放。是否可刷新仍以真实窗口visible、非minimized、非compact和integrationTest状态判断，不能复制窗口visible布尔。

`registerWeatherIpcHandlers`已真实new WeatherService+refresh controller，feature不得再new第二controller。它返回具名refresh/settings方法，后续补注册清单和dispose：只remove自身五个weather handlers，controller.dispose失效generation，late results不能publish。controller自身保留pending/backoff/date/signature逻辑；`isCurrent`增加disposed条件、disposed后read/refresh拒绝或明确空结果，按UI调用约定统一。

实际WeatherService.request已有12秒AbortController timeout；目前没有统一abort所有请求API。dispose首先停止新准入和发布，不把wait超时说成网络取消。`shouldStore`在getForecast的网络结果完成后、内存赋值/cacheWriteQueue入队前校验；若dispose先于网络完成，应false。不撤销已在queue中的cache写，因为timeout/stop不能虚称取消。需要有界等待/真正abort时须给request控制器新增独立所有权，并说明已入cacheWriteQueue可完成的边界。

readCache可能异步迁移旧cache并save；该路径不是用户note数据清空范围。天气缓存不依赖app.db，不将天气请求纳入business clear gate。自动刷新异步finish保持beginPerformanceOperation实际完成/错误统计，无论scheduler同步tick何时结束。

## 7. 主入口迁移和消费者清单

以下位置是2026-10-09准备快照的定位辅助；实施时按符号搜索最新文件，不能照旧行号直接删块。

| 源符号/块                                              | 准备快照位置   | 具体替换与消费者                                                                                        |
| ------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------- |
| notification/reminder/trayReminder/weatherService变量  | index 266～270 | 删除对应let镜像，所有读/动作接feature具名端口                                                           |
| tray/trayShortcutImages/stickyService变量              | 346～348       | tray两个迁controller；sticky只在feature一份                                                             |
| pendingNotification\*/pendingReminderActions及五个函数 | 365～472       | 全块迁activation；second-instance477接handleArgs；普通second-instance保持原open捕获                     |
| scheduler构造/capability                               | 860～862       | feature唯一构造；不提早start                                                                            |
| broadcastSettingsChanged                               | 979～981       | feature.settingsChanged而非读取两份service                                                              |
| view切换成功与恢复/menu                                | 3582、3619     | tray.rebuild保持成功/失败恢复调用位置                                                                   |
| toggleGlobalShortcuts/menu/rebuild                     | 3634～3711     | gate操作仍settings owner；session改变后tray.rebuild；菜单/真实tray迁controller                          |
| integration hooks                                      | 3732～3734     | flag内代理triggerClick/menu/reminder观察，不生产暴露service locator                                     |
| startup handleProtocolArgs                             | 3813           | activation.handleArgs，保留早期queue                                                                    |
| renderer ready通知显示                                 | 3991           | activation.settlePendingReveal                                                                          |
| reset settings menu重建                                | 4354           | tray.rebuild，仍SQL提交之后                                                                             |
| sticky构造/initialize/restoreMissing                   | 4656～4692     | feature.initializeSticky；repository写与saveContent接同一admission；list-only appearance继续现有resolve |
| notification/reminder构造/queue/tasks/start/resume     | 4701～4862     | feature初始化和任务方法；ready后activation.attachReminderAction；resumelistener进created ledger         |
| clear-note-data                                        | 4877～4910     | 同一admission.clear包完整编排；迁移counts到drain后，保留已清空错误文案                                  |
| business IPC callbacks                                 | 4935～4946     | 注入runMutation；reminder refresh、sticky discard接feature操作                                          |
| weather构造/PowerPauses/listeners/performance          | 4959～5013     | feature.initializeWeather，移除原Set与匿名listener；不得留双份刷新路径                                  |
| scheduler retry/health IPC                             | 5053～5059     | 具名feature方法，保留授权和返回DTO                                                                      |
| tray构造/click/rebuild                                 | 5063～5073     | controller.create，feature提供blink/gesture端口                                                         |
| shutdown cleanup ledger                                | 5164～5211     | 同位置调用feature.stopScheduler/reminder/sticky/weather释放和tray.dispose；DB/native/log次序不改        |

captureShortcut/capture协调、remote/diagnostic、window/Dock/geometry/presentation/navigation属于其它已具名owner；不能删掉它们的退出阶段或把“feature全dispose”塞到DB关闭后。constructor imports随实际迁出的owner移动；没有真实消费者才删index import。模板/通知/协议shared模块路径与原键不变。

## 8. 后续局部验证和测试处置

实施授权后新增单元必须绑定可失败契约；已建立的源码与定向结果见 §10，不运行全量：

- feature：资源构造中途抛错、initialize抛错、组装child所有权转移、dispose一项抛错仍attempt其余、重复init/dispose、resume解绑、各task原顺序与阈值。
- tray：checkbox与动态view/sticky/capture实值、click ack→toggle、blink期间baseicon更新、销毁后无click副作用、部分创建失败。
- activation：错误URL/旧noteid、未ready queue上限、ready一次性consume、late disposed、loading/重建ready、compact失败fallback；round有效性仍DB/service测试负责。
- weather：重复show/resume合并到现有pending、暂停/锁屏门闩、Dispose后late网络不store/publish、既有cache write边界、handlers/listeners准确解绑，不模拟固定时间函数得出真实休眠证明。

迁移已有源码文本保护到真实owner，保留原断言目的，不让删index代码导致测试失去检查。按`rg`发现的实际消费者更新sourceRead映射、测试manifest和focused命令候选；新增owner文件未映射不得默认退化到全量。必要的actual app/build/native专项范围由本次实际行为边界选择并明确日志/token/output provenance。

系统toast实际出现、协议关联、退出冷启toast action、真实Windows suspend/lock-screen、多DPI、macOS与客户机保留平台验收边界。同进程protocol调用或fake Notification不冒充OS接受。release/package/full regression只有明确要求才执行。

## 9. 回退与完成条件

实施前为当时准确dirty基线保存这些源块、共享helper、测试与hash。按独立单位实施/验收：clear admission完整接线；activation；tray；feature/天气生命周期。每单位经过局部证据再继续，避免用一个大文件搬迁掩盖失败。

回退clear必须同步恢复准入owner、完整mutation包装、sticky入口和clear编排；不能仅去掉clear gate却保留blocked预期。回退feature/tray/activation须恢复同一基线主入口state/constructor/subscription/shutdown与消费者，撤新owner时禁止保留两套timer/listener/queue；重新生成匹配out并重跑对应窄链。

不删除用户app.db、业务记录、已送notification、未知staging或附件目录；不通过恢复旧数据库消除测试问题。旧已清空数据不得被“回退”重新恢复。保留本轮复现JSON和原失败日志。

完成条件是每个状态仅一个owner、partial启动有释放台账、正常与失败退出有准确once顺序、clear旧写不复活、所有真实消费者接线和源码保护完整、局部业务断言与build证据通过且平台边界明确。以 §10 实际证据逐项签收，不能以方案完成代替实际装配验收。

## 10. 实施记录与精准证据

### 已实现的唯一拥有者与失败闭合

- `business-mutation-admission` 统一登记完整异步写；已准入操作的嵌套写通过活跃 ALS scope 完成。`bindContinuation` 只捕获当前操作的活跃 scope，供便利贴独立 `sticky:ready` IPC 完成原创建；操作结束即失效，不能反复使用旧资格绕过清空或退出。
- `clearTask` 单独记录清空文件、renderer 草稿和表现收尾。清空内部仅排空 mutation；退出的外部 `drain` 同时等待 mutation 和整个 clear，避免自等待与过早关闭 DB。
- 草稿批准之前不封闭新写；取消退出仍可正常使用。批准后封闭外部写，旧操作完整完成。`runCleanup` 仅在已封闭、shutdown drain 已结束、pending 为 0 且无 clearTask 时允许同步执行；仅用于 `disposeStickyAfterDrain` 保存最后未 debounce 的真实窗口坐标，离开立即失活，拒绝 async 返回。业务清空的 `discardAllRuntime` 不使用此权限，不回写已删除 rows。
- `feature-runtime` 使用五个小 DTO 与成功创建/child 转交/释放台账，迁入完整任务顺序、阈值、广播、性能计数、resume 与天气可视/电源监听。提醒独立 timer 和 Windows 通知失败回调也接同一准入，封闭期间不另起 DB 写。
- tray controller 拥有真实 tray、图标、菜单和 click 订阅；activation 拥有 early protocol queue/pending reveal，退出屏蔽晚到展开。weather 保留唯一原 controller/cache；dispose 失效 late 网络发布与 store 条件。
- sticky 初始化与 ReminderWindow 构造按实际成功注册清单回收 handler，部分失败不移除其它拥有者的 handler；释放某个窗口/通道失败仍尝试其它已创建资源，保留原初始化错误。
- tray 的 close/closeAll/restore 端口保持原 `false`/`Promise(0)` 失败契约；准入关闭时记录并显示具体 busy，不让同步 gate 拒绝变成未捕获 menu click 异常。renderer IPC 的明确错误响应继续保留。

### 已取得的局部结果

| 范围                                            | 准确结果与证据                                                                                                                  | 能证明的边界                                                                                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 最初 owner/消费者单元                           | `tmp/b7a-owner-consumers-unit.json`，7 文件 36/36，0 fail/skip                                                                  | 当时 gate/activation/tray/feature/weather/reminder 契约                                                                                                                       |
| clear/ready/资源补偿及 tray busy 增量后的单元   | `tmp/b7a-admission-resource-final-unit.json`，5 文件 54/54，0 fail/skip                                                         | clear 与 shutdown 等待、cancel draft approval、scope 失效、同步 cleanup guards、独立 sticky ready IPC、partial 注册、提醒 timer/native late、weather late、tray busy 失败契约 |
| 当时业务清空真实专项                            | `tmp/test-runs/2026-10-09T02-47-03-050Z-CTNR42`，30 个实际 assert，全通过且 accepted                                            | 真实磁盘 SQLite/WAL、真实附件文件/stage、生产业务注册器；IPC 为进程内授权 fixture，没有 renderer/BrowserWindow                                                                |
| 原 fixture 失败                                 | `tmp/test-runs/2026-10-09T02-45-21-624Z-M2ib6t`，tag 名超过真实 10 字上限                                                       | 已改为合法名重跑；保留失败，不能归类产品失败                                                                                                                                  |
| Reminder late failure 红绿后的增量单元          | `tmp/b7a-reminder-late-failure-unit.json`，3 文件 25/25，0 fail/skip                                                            | 确切发送身份、失败缓冲、clear 成败、新轮次隔离、退出零迟到 SQL；store/native 为受控依赖，详见 §11                                                                             |
| 当前源业务清空重验                              | `tmp/test-runs/2026-10-09T03-28-40-290Z-oElUD0/tests_business-clear-admission-electron.mjs-ldmGYS/result.json`，30/30，accepted | 真实磁盘 SQLite/WAL、附件/stage、生产业务注册器；仍为进程内授权 IPC fixture，不代替 renderer 与窗口验收                                                                       |
| 当前源便利贴持久化重验                          | 同 run 的 `tests_sticky-persistence-electron.mjs-sUGZJE/result.json`，52/52，accepted                                           | 真实 Electron renderer/便利贴窗口、内存 SQLite、桌面层级；封闭准入、排空、同步最终 bounds 保存、资源释放，不证明主进程重启后的磁盘持久化                                      |
| 当前构建退出生命周期重验                        | 同 run 的 `tests_application-lifecycle-electron.mjs-nSUlUm/result.json`，32/32，accepted                                        | 真实主应用两次独立进程 normal/reentrant 场景、正常退出与 once 释放；不扩展为任意 OS 强杀、断电或提醒 toast 接受                                                               |
| 当前构建 feature 真实接线重验                   | `tmp/test-runs/2026-10-09T03-34-16-718Z-ygxBDo/tests_feature-runtime-electron.mjs-ufDONG/result.json`，40/40，accepted          | 真实 main/preload/renderer、磁盘 SQLite、tray、sticky ready→clear、草稿故障和 clear→quit 排空；build-app 的 `build-reuse-verified` 来源验证为 true，不是跳过来源检查          |
| Reminder 真实 store 场景加入后的最终 clear 专项 | `tmp/test-runs/2026-10-09T03-41-04-777Z-Clk3cP/tests_business-clear-admission-electron.mjs-m4lL6W/result.json`，58/58，accepted | 前述 30 项加 28 项生产 ReminderService/真实磁盘 db-reminders 身份、attempt/backoff、SQLite clear 回滚、成功 clear 新 token 隔离、退出零迟到 SQL；OS transport 明确模拟        |

最初的 30 assert 是增量 `clearTask`/独立 ready/cleanup 修复前的历史证据。后续已按同一窄专项重跑当前源并 accepted，保留两次记录；此前的 54 单元对应当时源，Reminder 后续修复另以 25 个直接相关单元登记，不把旧报告冒充新源全域签收。

### 已取得的实际 app 验收与平台边界

`tests/feature-runtime-electron.mjs`，mode `electron-ready-real-app-feature-clear-tray-activation`：真实构建主入口、主 renderer/preload、磁盘 SQLite、tray 和 sticky 窗口。测试只控制真实 `sticky:ready` 回调与真实 renderer 草稿完成时序，不替换 service/repository。逐项验收 early protocol→ready consume、tray click/session checkbox、mounted 草稿、旧完整 sticky create→clear 等待→DB/窗口/草稿归零、提交后 draft 故障明确已清空并恢复新写、clear 草稿未完成→app.quit 重入→business-mutations 排空→正常资源台账退出。

`tests/sticky-persistence-electron.mjs` 增加实际窗口坐标尚待 debounce 时的 sealed shutdown→drain→同步 final-bounds cleanup，核对真实持久记录、窗口和 timer，随后仍拒绝新写；该项已取得上表当前源 52/52 accepted。

本轮 feature 第一次实际 app 运行在上述 run 的 `tests_feature-runtime-electron.mjs-YOMtct/result.json` 中为 failed：31 个已到达断言全部通过，但故障注入脚本以函数赋值为 `executeJavaScript` 的最终返回值，Electron 报 `An object could not be cloned`，证据未完成，因此不能 accepted。它是测试夹具返回值缺陷，不是产品 IPC 返回对象失败。原 attempt 保留。仅将三处草稿函数赋值及最终 release 显式 `void`，定向 ESLint 和 Node 语法检查通过；测试 SHA256 为 `b0c391c3220cefe01c674b63ff4bb341fd031415c86af354972cf4387575d679`。生产源码和 out 未改。随后主代理用来源已验证的 build-app 单独正式重跑，取得上表 40/40、exit 0、business/evidence/cleanup complete、accepted=true；失败 attempt 不能被该成功报告覆盖或删除。

真实专项和必需 build 由主代理统一登记、生成准确输入/out 指纹并串行执行；退出生命周期的两次独立进程也不替代 feature 专项自己的主进程重启或协议冷启证明。

当前只运行与本批修改直接相关的单元和 ESLint。没有运行全量回归、安装、打包或发布。实际 Windows toast 接受、系统协议关联/冷启、真实 suspend/lock-screen、多 DPI/macOS/客户机、任意磁盘故障和长时运行仍属专项边界。业务 drain 没有虚设超时强关 DB：现有文件 IO 无安全取消契约，未排空时保持 DB/资源；这不能声称所有用户机器 IO 必定有界收敛。

## 11. Reminder late failure：成立缺陷、窄修与边界

### 受控红绿证据

收尾审查发现一个可达顺序：原生通知请求 accepted 后 delivered 位为 1；clear 封闭准入期间收到 native failed；旧实现因不能写而直接丢回调；随后 clear SQL 失败，旧轮次仍 live，后续 tick 继续看到 delivered=1，无法重试。

`tmp/refactor-baselines/B7a-late-reminder-failure/reproduce.mjs` 直接加载生产 ReminderService 与 admission，但 store/native callback 为受控内存依赖。`red.json` 记录旧源 SHA256 `1b423f788ccf49b6085d24a09a71401e1584ab74d9bdfcb1328a8ddcaa4b284b`，`reproduced=true`、sends=1、failureMarks=0、delivered=1。经父代理确认并取得该窄修实施授权后，`green.json` 记录新源 SHA256 `af77c0cbba4c4a5f87111982a0b4b628972805732fed1697760aa0e6c7b1fd9d`，`reproduced=false`、sends=2、failureMarks=1；最后 delivered=1 是第二次发送 accepted。该红绿不是实际 SQLite 故障、真实 OS failed 事件或用户看到通知的证明。

### 具体修改与不遗漏的保护

1. 每次发送先递增尝试，再通过现有 `getReminder` 捕获 `id/note_id/parent_id/due_at/created_at/attempts` 完整身份，并为该次发送建立独立 token。不能只按 note ID、轮次 UUID 或 delivered 位回放。
2. 封闭期间 failed 回调只登记每轮最多一份内存 pending failure，不查询或写 DB。下一合法 tick 先 flush；合法 callback 也可即时 flush。当前 token、完整身份、live active、笔记 in_progress/未删除和 system 渠道必须同时匹配，才调用现有 `markReminderFailure`。
3. 成功 clear 后原 `refreshReminders` 删除旧 live token 与 pending；同 note 新轮次甚至故意复用完全相同 durable 身份也不能接收旧 callback。snoozed/cancelled、渠道关闭、删除、完成及同轮 newer attempt 都拒绝旧失败。
4. failure SQL update 自身失败时保留该确切 failure，下一合法 tick 重试。同步 native failed 先缓冲到 send/markDelivered 完成后再 flush，避免 accepted 位覆盖失败。
5. shutdown 封闭后零迟到 SQL；dispose 清空 token 与 pending，晚回调忽略。保持原最多三次尝试、backoff、schema、协议与 DTO；不得放宽所有写入口来处理这一回调。

### 精准验证

`tests/reminder-service.test.js`、`tests/feature-runtime.test.js`、`tests/reminder-notification.test.js` 合计 25/25，0 fail/skip，保存于 `tmp/b7a-reminder-late-failure-unit.json`；修改的生产服务与该 unit 文件 ESLint 通过。新增七组回归覆盖上述 clear 成败、故意复用身份、新 attempt、inactive/channel/note 条件、SQL failure 保留、shutdown/dispose 和同步 callback 顺序。当前真实 build 的退出与 clear 接线证据见 §10，但该 native failed 缺陷的红绿依赖仍受控，不据此宣称真实 Windows toast 失败/恢复已验证。

进一步跨真实 store 验收已窄加至现有 `tests/business-clear-admission-electron.mjs`，没有新建广域 suite 或修改 schema；注册资产由主代理统一维护。它复用临时磁盘 SQLite，默认加载生产 ReminderService 与 `db-reminders`，实际创建 snapshot/enqueue、更新 attempts/backoff/delivery 位，并用 SQLite DELETE trigger 令 clear 回滚；OS transport 仅模拟 accepted/failed 回调。成功 clear 后故意构造仍满足实际约束的完全复用 durable 身份 fixture，再发送新 token，验证旧回调不得污染。以实际 `db.prepare` 调用观察 sealed callback/tick 与 shutdown/dispose 的零 SQL 边界，且 finally 恢复观察包装。该 MJS SHA256 为 `2c4cb3cec4d74f18716ee1dc5cd461f480f2b087bca2d2a14113c465a48284fb`，Prettier、ESLint 与 Node 语法检查通过。

正式单项 run `tmp/test-runs/2026-10-09T03-41-04-777Z-Clk3cP/tests_business-clear-admission-electron.mjs-m4lL6W/result.json` 为 58/58、0 fail/skip、raw exit 0、business/evidence/script cleanup/runner cleanup 全部 complete、accepted=true。其中前述 30 项保持，新增 28 项证明实际 joined row 身份和 SQL 状态更新、真实 clear rollback 保留并重试、成功 clear 复用身份的旧回调隔离、shutdown/dispose 时零迟到 prepare SQL。至此该窄缺陷已经跨真实磁盘 store 验证；受控红绿仍作为原缺陷成立历史保存，OS toast accepted/failed 事件及用户实际看到通知仍未证明。
