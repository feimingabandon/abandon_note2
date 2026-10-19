# 第二轮独立深入复查与后续修改指导

日期：2026-10-09。阶段：S7。状态：本轮复查与指导完成；SR-001–007 均已确认、待实施，尚未修复或验收。

## 1. 本轮结论与基线

用户在上一轮收尾后提出“再看看呢，这么快吗”。上一轮 B0–B7 的27个子批和 S6 的五项修复完成，只能证明约定迁移与指定局部门槛完成，不能据此宣称全项目每处实现无缺陷。本轮从真实调用方重新追踪状态、失败补偿和操作交错，没有重复运行上一轮全部测试来替代复查。

HEAD：`4fbc52be1c688dba9cf23fbbd51539606efbf381`，分支 `main`。对照上一轮结案、进入清单和最终源码哈希，475个可比文件无漂移；文档落盘前另保存699个源码、测试、脚本、配置和输出等文件的本轮快照。基线见 `tmp/second-review/pre-documents-baseline.json`，最终核对见 `tmp/second-review/summary.json`。

本轮只新增审查指导与 `tmp/second-review/` 隔离复现/证据；不修改业务源码、正式测试、runner、配置、原生产物。原 dirty、首失败及上一轮结案均保留，不 reset/clean、不提交或推送。本轮7项均在 HEAD 原实现存在同类缺口，属于继承问题；不能归咎最近 owner 迁移。S6 的五项修复与其局部证据仍有效，但不覆盖这些新场景。

| 编号 | 原复查编号 | 问题 | 当前证据 | 后续状态 |
|---|---|---|---|---|
| SR-001 | L-001 | 附件回滚删除失败后仍清除恢复 manifest，遗留文件无法重试清理 | 真实 Electron/磁盘 SQLite trigger 回滚、关闭重开及生产恢复；unlink 故障注入 | P2，待实施 |
| SR-002 | L-002 | 清空提交后 Reminder 查询错误截断便利贴、草稿与广播清理，准入随后重开 | 当前完整 handler、ReminderService、admission 与受控 SQL/窗口端口 | P2，待实施 |
| SR-003 | L-003 | 清空提交标记和物理删除双失败后，新业务行让恢复误判历史 clear | 真实 SQLite clear、新便签、关闭重开与生产恢复；双文件错误注入 | P2，待实施 |
| SR-004 | W-001 | compact 展开后导航拒绝，留下隐藏 expanded 来源窗口 | 真实 Electron 窗口及8个缺陷观察断言；native-cleanup 分支另有受控对照 | P2，待实施 |
| SR-005 | R-01 | 自定义刷新期间新分页使用旧 offset，造成丢页、跳页和重复 ID | 当前模型与组件原 scroll handler，静态数据受控响应的两种交错 | P2，待实施 |
| SR-006 | R-02 | 自定义后台刷新用查询开始时锚点覆盖用户等待中的新滚动 | 当前模型、组件原 capture/restore 函数与受控位置适配器 | P2，待实施 |
| SR-007 | R-03 | 普通设置自动保存失败项被丢弃，无反馈且 close flush 不反映未保存值 | 实际 Vue watcher/queue、受控持久值与 API 拒绝 | P2，待实施 |

P2 表示应修复的条件性缺陷，不表示同等影响或概率。优先处理数据3项，再处理窗口与列表，最后设置失败反馈。未证明普遍必现、客户机发生频率或当前有数据损坏；SR-003 证明旧附件字节回到正常目录，没有证明旧便签记录或 UI 照片复活。

## 2. 阅读范围、审查方法与证据分层

三名独立子代理分管数据/生命周期、窗口、Renderer；主代理交叉核查关键实现、消费入口与证据，并单独审查选择器、CI 叶规则、结果协议、构建来源和 runner。完整与部分阅读逐文件列于：

- `tmp/second-review/lifecycle/review.md`：完整读16生产、11测试；index、sticky 和部分 schema/消费路径仅按明确范围读取。
- `tmp/second-review/windows/read-only-review.md`：完整读11生产、14测试，另列 index 与 Renderer 接线范围。
- `tmp/second-review/renderer/review.md`：完整读三个列表、Calendar、设置队列/表单、workspace/draft/motion、NoteList/MonthWorkspace/MonthApp 等；App/SettingsPanel 与专项仅部分读取，清单明确标注。

本轮没有重新逐行完整审查整个仓库；334源码的上一轮静态语法/依赖检查不是334份完整语义审查。各阅读清单有重叠，不把人数或文件数相加当覆盖率。

审查重点是：谁持有状态、谁能解除门禁、SQL 提交前后如何补偿、等待时新意图是否被接纳、晚回调是否仍有写权限、真实消费者是否触发测试中的组合。源码断言、unit、实际函数受控执行、真实 SQLite 与真实窗口分别陈述，不互相升级证据等级。

排除的误报：Calendar clear 通过 draft generation 重建并 dispose；普通 dirty 草稿取消会先 reveal，没有 SR-004 隐藏问题；startup recovery 的 allSettled 确实被 shutdown 等待；Reminder 晚失败身份/token 保护没有发现新的绕过。Timeline/Tag 没有被证实有 SR-005 同一缺口，不推广修改。

## 3. 数据与清空修改指导

### 3.1 SR-001：保留未完成附件补偿的恢复凭据

**位置与触发。** `src/main/notes/note-commands.js:88–90,254–256`、`src/main/ipc/register-business-ipc.js:422–424`。图片重命名至最终路径后 SQL 失败，`db-images.js:197–205` 的 deleteImageFile 捕获 unlink 错误并返回 false，三处调用者忽略结果、继续清 staging/target manifest。下次 recovery 没有入口发现该孤儿文件。

**已观察。** `tmp/second-review/lifecycle/orphan-real-sqlite-1791527181740-result.json`：真实 INSERT trigger 回滚后 notes=0、attachments=0、staging=[]，留1个最终文件；解除 unlink 错误后真实 DB close/reopen，再执行生产 recovery，文件/hash仍相同、recoveryEvents=[]、integrity=ok。这里实际执行的是 create-with-assets；另两消费者由源码确定有同一顺序，仍需各自修复验收。

**改动范围。** note-commands、register-business-ipc、db-images，以及必要的窄补偿 helper；attachment-recovery 按需要调整契约。复用既有 image-add operation 格式，保持附件配额、授权、路径校验和成功广播语义，不借此搬迁整个 IPC。

**步骤。**

1. 将 published relativePath 和对应 staged operation 建立逐文件关联；commitStagedImage 后立即登记，SQL 后续失败也可定位，不能继续使用无关联的两个数组。
2. 同一狭窄 helper 对每文件补偿并完整等待结果。只有 final 删除成功或确定 ENOENT 才清对应 operation；false/throw 保留 target/manifest 以供下次恢复。尚未发布的 stage 按既有规则清理。
3. 三处回滚同步采用此 helper。draft 中既有 stagedDeletions 的恢复也必须尝试，即使新增图片补偿失败；不要让一项异常截断其余补偿。SQL 原始错误继续作为主要错误，补偿未完另外记录。
4. 日志准确区分“数据库已回滚”和“部分文件待恢复”，不能继续无条件声称全部文件已清理。
5. recovery 对无 DB row 的 final 文件先删除文件、再清 operation；删除失败保留现场。DB 已提交后的广播/cleanup 错误绝不触发删除已提交附件。

**局部验收。** 扩展 `tests/note-commands.test.js`，并在 `tests/attachment-recovery-reset-electron.mjs` 或同等窄存储专项验证 create、draft、batch 三条真实事务路径。覆盖 SQL失败+unlink失败、解除故障后重开恢复、两次恢复幂等、多图只保留失败图凭据、旧附件恢复、成功提交后的广播失败。断言文件字节和manifest，不仅断言 notes 数量。若测试入口或 source-read owner 移动，同步 manifest 的具名消费源与局部选择映射，不把资产登记当通过。

**回退与停止。** 代码/helper/三消费者和测试成组回退，保留已有用户附件与未完 operation。出现“DB有已提交row却被补偿删文件”或混合补偿丢恢复凭据即停止；禁止清空整个附件目录来掩盖孤儿文件，也不覆盖用户 DB。

### 3.2 SR-002：SQL 提交后的收尾彼此隔离

**位置与触发。** `src/main/index.js:1974–1996` 在 clearNoteData 成功后立即 refreshReminders；ReminderService:117–120 的 store SELECT 抛错会跳过 sticky discard、editing draft clear、notes广播。businessAdmission.clear 的 finally 仍解除 clear gate。

**已观察。** `controlled-reproduction-v2.json` 的原 handler/实际 ReminderService/实际 admission：事件只到 SQL-COMMITTED→REMINDER-REFRESH→REMINDER-SELECT，后三步骤未发生且准入重开。这一 SQL commit 是受控端口，本轮没有此场景完整 app/真实 SQL 验证。

**改动范围。** index 的 clear 协调；可提取唯一的窄 clear coordinator，不新增第二份 clear owner。feature-runtime、ReminderService、sticky command、renderer draft hook 和广播作为明确端口；需要按接口变化同步 index 组装与测试，不能吞全部错误后无条件返回 true。

**步骤。**

1. DB clear 是提交前必需阶段，失败就停止，不discard未提交的真实旧数据，维持原回滚语义。
2. 提交后 reminder reconcile、sticky discard、draft清理、逐窗口广播分别 attempt；一项失败不截断其它项。窗口destroyed/webContents发送异常按窗口隔离；操作可 await 时等待其 settle。
3. 汇总后提交失败，给出准确“业务数据已清空，某些收尾未完成”的结果与日志。重试针对未完成步骤，不假装能回滚已提交事务，也不盲目再次清空用户刚创建的新数据。具体错误返回/IPC字段需同现有调用方一起更新。
4. 保持 businessAdmission 与 shutdown 对整个 clearTask 的等待，全部收尾尝试结束后才解除 gate。若存在必须保持封闭的未完安全步骤，先明确其恢复状态与重试入口，不能仅换 finally 顺序造成永久锁死。
5. 可为已提交 clear 提供独立 runtime token失效接口，减少提醒清理依赖失败 SQL；这是设计建议，当前晚提醒 token保护本轮未被证明有误写缺陷，不扩大成另一问题。

**局部验收。** `tests/feature-runtime.test.js`/`tests/business-mutation-admission.test.js` 只按实际修改 owner 选文件；真实 store 场景放 `tests/business-clear-admission-electron.mjs`，真实窗口/草稿链放 `tests/feature-runtime-electron.mjs`。覆盖 listActive 与 nextTime 查询分别失败、sticky步骤失败、单窗口广播失败、草稿失败、SQL回滚对照、shutdown与清空收尾交错。成功提交应 rows=0、其余收尾均尝试、反馈准确；不能把模拟 toast 回调描述成 OS 通知验收。

**回退与停止。** 协调器、组装及IPC/消费端返回契约成组回退。若错误后准入过早开放、shutdown越过clear settle，或SQL失败却discard旧草稿/窗口，应停止实施并保留证据。

### 3.3 SR-003：按具体 operation 的事务提交决定恢复

**位置与触发。** `src/main/db/business-data-reset.js:64–75` 提交后写committed失败、removeDirectory也失败仍fulfilled；`attachment-recovery.js:169–193` 以“缺committed+当前有业务行”判断旧clear未提交。之后新建纯文本便签且attachments根尚未重建，启动恢复便把旧附件搬回根目录。

**已观察。** 同真实SQLite报告第二个独立profile：clear fulfilled，note/attachment/reminder全0；marker与rm各注入1次EACCES。解除注入后真实新建纯文本note、DBclose/reopen、生产恢复，旧字节回根、event=rolled-back、notes=1/attachments=0/integrity=ok，旧note记录不存在。仅是受控双故障可成立，不证明客户机实际错误频率。

**改动范围。** business-data-reset、attachment-recovery、db-schema/内部journal repository与DB facade/runtime接线，以及窄迁移/存储测试。这里确需内部schema设计，不是单改if判断。保持 app_settings、业务删除范围、附件隔离及真实SQL回滚恢复。

**步骤。**

1. 为新reset operation分配持久UUID，并定义带operationId的新版manifest；内部storage operation journal按operationId记录提交决定，结构由数据库唯一owner维护，不借用产品设置key。
2. 完整写manifest后隔离旧attachments。清业务表与写该operation的committed记录处于同一SQLite事务，使二者共同提交或回滚。仅移动文件或提前写committed不能提供此原子决定。
3. 恢复按精确operationId查询journal：已提交只清旧目录，无论现在是否有新note/tag/template；确定未提交才尝试恢复旧附件。journal读取失败必须保留现场和诊断，不能退回“当前有业务行”的猜测。
4. fs committed标记可保留作兼容/诊断。物理rm失败保留operation与journal；只有目录确实清理后才移除该journal记录。目录已删而journal清理未完时，下一次可幂等清理孤立journal记录。清空业务数据本身不得顺便删掉未完成的内部journal。
5. 对旧格式、缺marker且无法确定决定的目录保留隔离并记录，不能凭新业务行自动恢复或删除。实施前列出当前旧格式全部恢复规则；能够证明未提交的旧操作仍可恢复，有新attachments根时不覆盖。迁移只增内部结构，先在独立profile验证，禁止以升级为由删除用户附件。
6. 新版manifest尚未移动payload的崩溃、移出后SQL回滚且即时恢复失败、提交后marker失败、rm后journal删除前崩溃，各有独立恢复分支与幂等条件。启动与shutdown继续遵守现有排空顺序。

**局部验收。** 修改 `tests/database-runtime-db.mjs` 的相关内部迁移场景和 `tests/attachment-recovery-reset-electron.mjs` 的具体reset场景；触及准入再选 `tests/business-clear-admission-electron.mjs`。覆盖本次双失败+新note/tag/template、清空后已创建新附件根、SQL真回滚恢复、提交/marker/rm/journal各崩溃点、旧格式不确定保留与诊断、重复启动恢复。不因公共schema触及面较宽而自动全量；先列受影响内部存储消费者及局部扩大范围。

**回退与停止。** 先备份隔离fixture与本批源码。新增journal表通常保留，禁止为了代码回退删除提交凭据；已有新版pending operation的profile不能直接降级到旧恢复代码，否则同一误判重新出现。旧版本无法理解新版证据时需制定保留/前向修复方案。出现任何已commit旧附件回正常根、未commit旧附件被删、新根被覆盖，立即停止，不用旧DB替换新用户数据。

## 4. 窗口与 Renderer 修改指导

### 4.1 SR-004：导航拒绝补偿本次临时隐藏

**位置与触发。** `main-view-navigation.js:268–270` 先exitCompact(showWhenDone:false)，presentation-runtime:311–327隐藏后完成expanded；草稿检查false（:283）或native清理拒绝（:286–291、:315–320）直接早退。首次草稿读取错误/超时没有dirty确认分支的reveal。

**已观察。** `tmp/second-review/navigation-hidden-result.json` 对应正式attempt `navigation-attempts/2026-10-09T06-15-52-822Z-JzxGVW`：可见compact→注入草稿读取throw→切month被拒绝，实际view=list/mode=expanded/isVisible=false，pendingReady与queuedTarget为空；明确tray-open后可见。8个观察断言、业务/证据/清理齐全，证明缺陷存在，尚未修复。native-cleanup拒绝及dirty取消对照另在 `windows/boundary-reproduction.json`；普通dirty用户取消可见，不包含在隐藏问题中。

**步骤与范围。**

1. 在Navigation保有本次admission票据：来源窗口身份、原显隐、临时隐藏owner；compact ACK await前明确请求所有权，防两个请求共用展开事务后错误补偿彼此。
2. 本请求早退/异常且原来可见、同窗口仍活、应用未退出、用户没有随后主动隐藏时恢复来源交互。安全expanded可保留，不无条件再发compact事务。
3. 不需要expanded草稿UI的native gate可前移；草稿弹框需展开，不机械把全部guard移到compact exit前。
4. 补偿涵盖正式navigation前的所有早退；成功/后台排队/正式加载已接管时转移或释放票据。不得用全局finally openMainWindow强制show用户隐藏或新窗口。
5. 只调整Navigation/必要Presentation或visibility port及index组装；不修改ABI、全局z-order或Dock算法来掩盖这个逻辑问题。

**局部验收与回退。** 扩展 `tests/main-view-navigation.test.js`、`tests/editing-draft-guard.test.js` 必要场景；串联真实Presentation可用相关runtimeunit。真实窗口用 `tests/presentation-mode-electron.mjs` 增 compact→draft读取失败/超时→拒绝。断言真正isVisible，保留dirty取消、hidden来源、shutdown/换窗、双请求、成功和背景排队对照。票据/visibility接线及测试成组回退；用户主动隐藏后被强制show或旧票据触及新窗口即停止。

### 4.2 SR-005：自定义完整刷新拥有期间阻止旧offset新分页

**位置与触发。** `useCustomListModel.js:18–24,57–60,76–90,94,129–132`。session.begin失效旧页并将分页loading清false，但新的loadMore可在本轮完整refresh未完时用旧offset入场。`NoteList.vue:400–404,790–808,831–839,1449` 真实滚动、手动与后台调用都可保持容器；后二者showLoading=false，不能用session.loading当锁。

**已观察。** `renderer/controlled-reproduction.json`：静态200条集合，40条旧列表刷新等待时新页先到60，随后刷新覆回40；反向顺序刷新先提交1–20，旧offset40页追加41–60，缺21–40，后续再offset40追加重复20条，最终rendered60/unique40。与DB并发变化无关。

**步骤。**

1. custom domain记录owned refresh sequence，从begin持续到最后快照提交、anchor恢复与finish；quiet/manual都使用同一门禁。
2. 门禁期间loadMore不使用旧offset发页；如需保留滚动意图，仅合并一个pending意图，释放门禁后重新按当前offset/hasMore发起，不缓存旧请求参数。
3. 新刷新取消旧owner；finally只释放自己持有的owner，dispose/模式失效先封后续事件。保留旧page sequence失效逻辑，不能只对返回数据去重掩盖跳页。
4. 保持custom业务排序、DB单页cap100、>100收齐范围和三列表各自策略；不修改schema，不扩大到timeline/tag。与SR-006同模型应合并一个受审小批。

**局部验收与回退。** `tests/custom-list-model.test.js` 覆盖上述两顺序、quiet/manual、第二刷新、错误和卸载；断言refresh期间页不发或intent合并、最终ID连续且唯一、下一页offset正确。`tests/note-list-custom-electron.mjs` 使用真实DOM scroll及可门控IPC响应，检查ID/范围而非只看数值总数。保留现有旧页取消与120条保护。回退model/组件接线与本批测试；更新finally释放新owner或快照发生缺页/重复即停止。

### 4.3 SR-006：提交快照前读取最新阅读锚点

**位置与触发。** `useCustomListModel.js:19,62` 在查询开始采锚点；组件 `NoteList.vue:327–344` 仅容器/代次保护不能识别同代次的新滚动。后台等待中用户从top400滚600，同rows刷新后被拉回400。

**步骤。** 收齐页并核验session后，在替换customList前采当前阅读锚点，随后按新布局restore；排序变动的定位规则沿用custom语义，并参考timeline/tag现有提交前采样。继续检查容器身份、代次及dispose，restore期间的新刷新不能更新旧lastRefreshedAt。无需重新设计CSS/列表动画。

**局部验收与回退。** 与SR-005同 `custom-list-model.test.js` 和 `note-list-custom-electron.mjs`，查询等待期间真实滚动400→600，结果后保留新阅读点；对照mode切换/卸载不恢复老容器，以及删除anchor项的既有fallback。回退两项时按同一批model/消费者/测试进行，不能只恢复其中一处锚点后保留过期门禁。

### 4.4 SR-007：普通设置失败可见并保留最新意图

**位置与触发。** `useSettingsWriteQueue.js:84–90,106–110,298–306` 删除pending后拒绝只warn。实际consumer SettingsPanel:900–902先改字号CSS；300ms保存失败后selected20/persisted16、消息0，之后close flush/dispose fulfilled，没有重试或回读。

**推荐规则。** 普通设置保留最新未确认值与失败状态，提供可见“未保存”反馈和显式重试。close flush可以对当前最新失败值作一次明确重试，失败仍准确反馈；不设无限自动重试。直接persist与防抖保存共用确认逻辑。若实施决定用回读恢复实际值，须在本节更新规则，并保证赋值不再次触发写入，不能两种策略混用造成覆盖新意图。

**步骤与范围。**

1. queue按setting ID持有latest intent token/value及error；删除timer pending不等于持久成功。成功ACK仅确认对应最新token，旧失败/旧成功不得覆盖较新值。必要的同ID派发顺序由同一queue owner控制。
2. timer与flush的拒绝走相同失败记录/消息路径；flush结算后检查本域仍未确认的失败，不能因本轮pending为空而返回“全部保存完成”。
3. SettingsPanel消费失败状态/重试接口，沿用产品文案与统一UI标准，必要新增控件前完整重读 `docs/UI_DESIGN_STANDARD.md`。复用一个一致反馈入口，不给每个watcher叠加不同提示体系。
4. 新值覆盖旧错误、reset/suspend/dispose建立明确代次；旧失败不能重建已reset的值或在卸载后发UI消息。dispose最终派发仍需排空，但不允许关闭后弹出旧错误。
5. 不将blur、autoStart、Dock专用回读与验证改为普通设置策略，也不把所有设置/OS权限操作纳入本次改动。

**局部验收与回退。** `tests/settings-write-queue.test.js` 用具体ID覆盖timer拒绝、flush拒绝、同值重试、新值替换旧失败、reset取消与dispose抑制；`tests/settings-queue-electron.mjs` 注入普通setSettingValue拒绝，观察真实字号控件/CSS/反馈及重新打开后的持久值。queue/Panel消费接口与测试成组回退；旧失败覆盖新值或reset后产生写回即停止。只记录Windows DB/IPC拒绝验证，不声称真实自启权限测试。

## 5. 下一步批次、测试生成与运行规则

| 建议顺序 | 内容 | 必要关系 | 本轮状态 |
|---|---|---|---|
| S7a | SR-003 operation journal与旧格式兼容 | 先明确schema与恢复决定，再改reset/recovery | 待实施 |
| S7b | SR-001逐附件补偿凭据 | 与S7a共用恢复文件时串行合入；不同时写recovery | 待实施 |
| S7c | SR-002提交后收尾隔离 | 使用前两项最终存储契约验证clear，自己不复制DB恢复逻辑 | 待实施 |
| S7d | SR-004导航票据/显隐补偿 | 窗口域可独立，实际共享build验收串行 | 待实施 |
| S7e | SR-005+006自定义刷新门禁/新锚点 | 同owner合并一次实现与验证 | 待实施 |
| S7f | SR-007普通设置未确认值与反馈 | 先定失败/重试语义，再改queue与Panel | 待实施 |

这些是后续修改指导，本轮不预填通过；业务实施需有明确恢复指令。已有连续实施授权和本轮“只复查”的边界分别保留，不把review完成自动解释为本轮代码已修好。

新增测试按已确认缺陷生成：先在修复前以目标正确行为得到明确失败，再实现、运行同一用例得到正确结果。当前临时脚本是反向断言“坏状态仍存在”，只能作为探索证据，不能原样登记成绿色产品测试。每项至少有关键触发、正确结果、失败/取消对照与真实资源层保护；不为每个getter或源码写法生成重复测试，不只assert调用顺序。

使用既有具体测试文件承载对应契约，只有现有专项无法隔离消费者时才新增窄专项；新入口登记可执行角色、消费源、contract/feature与结果mode，必要runner adapter同步。成本目前未测量，不编造cost或以登记数量证明验证充分。失败夹具、环境阻塞、断言失败、业务未完成、清理失败分别保存，不改写旧attempt。

后续局部命令模板（**本轮未执行这些修复验收命令**）：

```powershell
$reviewNodeDir = 'C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin'
$env:PATH = $reviewNodeDir + ';' + (($env:PATH -split ';' | Where-Object { $_ -notmatch 'Volta' }) -join ';')
& "$reviewNodeDir\node.exe" node_modules/vitest/vitest.mjs run tests/custom-list-model.test.js
& "$reviewNodeDir\node.exe" scripts/run-focused-tests.cjs --file tests/note-list-custom-electron.mjs --plan
# 核对具体选择和必要build后，去掉 --plan 执行同一专项。
```

按实际本批文件替换目标，不把整个dirty自动加入。真实Electron/Chromium/SQLite/Windows资源从首次执行就在合适的沙箱外环境；必要build自动走来源证明，不复用漂移产物、不裁缓存依赖签证。公共schema/owner扩大影响时先列风险和具体补充文件；未经明确全量要求不运行 npm test、窗口矩阵、Qt全集或全量fallback。

## 6. 本轮实际验证与保留证据

1. 生命周期受控复现：L-001/L-002 当前函数与真实临时文件、受控SQL；另reset双失败脚本。最终退出0表示缺陷观察成立，不表示产品修复通过。
2. 真实SQLite双场景：`lifecycle/run-real-sqlite.cjs` → `real-sqlite-driver-9e752ec1-5197-4a1d-a700-e19e1781a118/driver-result.json`，原进程exit0、无signal/timeout/spawnError、completed=true、descriptor恢复、0 BrowserWindow、DB关闭与日志flush完成。两个profile保留证据；真实数据库是同一Electron进程close/reopen，非完整app两次启动、非图片渲染验证。
3. 真实窗口缺陷：正式navigation attempt记录8个断言、exit0、证据和清理完整；renderer草稿throw和navigation请求受控，实际app/ACK/window真实；沿原专项配置禁Chromium GPU，未证明客户机GPU环境。
4. Renderer：四个受控case，包括SR-005两个响应顺序、SR-006锚点和SR-007保存失败；原模型/实际组件函数与Vue执行，不是实际GUI/SQLite报告。
5. 窗口组合：草稿读取错误、native cleanup拒绝、dirty用户取消三对照，以及controller same-tick契约probe；没有全窗口回归。
6. 基础设施对抗：`infra-adversarial-results.json` 的12结果门禁场景，1正对照accepted、11负对照拒绝；6选择边界，空/unknown/helper/--all/source-only拒绝、具体unit只选自身；CI broad index为needs-domain-validation/exit3/selected0，docs为no-tests/exit0。证明协议拒绝能力，不是产品功能验收或云端CI执行。

首次失败保留：窗口临时脚本把Function作为executeJavaScript返回值而clone失败，修临时脚本void后重跑；真实SQLite首PowerShell GUI启动没有报告且LASTEXITCODE=null，不能计通过，之后Node spawn取得实际退出码；各受控夹具的Windows file URL错误单列。本轮没有为获得漂亮结果删除首失败、历史blocked或S6结案。

本轮未运行 Vitest、全量unit、窗口状态矩阵、Qt全集、云端CI、修复后的产品专项、打包/安装/升级/卸载、发布/部署、macOS或客户机测试。最终文档目标、7条指导/6批顺序、原27批表、代码/正式测试/runner/out哈希和diff空白另行核对于summary；这些检查不能认证全部文案语义或运行时行为。

## 7. 未收口事项与实施检查表

Controller expanded no-op同一调用栈紧接compact的受控请求丢失已复现，但自然UI/消费者可达性未确认，列W-R01契约风险，不计第8项产品缺陷。后续先补最窄契约用例并核真实调用链，再决定是否纳入修复批。

旧Overlay `zOrderSynchronized=false` 根因仍未解决。真实多屏/负坐标/混合DPI、物理睡眠/解锁/Explorer恢复、极小工作区最小尺寸、真实截图指针/剪贴板、toast关联与冷启、安装重启、客户机、外网天气/更新、长期性能与任意崩溃等边界继续保留。分页各查询缺DB事务快照保证是独立产品契约，不与静态集合的SR-005混淆。

- [x] 7项问题已交叉核查，HEAD继承与本次变更归因分开。
- [x] 每项文件、consumer、步骤、局部测试、失败补偿、回退和停止条件均明确。
- [x] 真实SQLite与真实窗口证据有原退出码、报告、恢复/清理及边界。
- [x] 原dirty、历史结案和首次失败保留，本轮没有业务或正式测试改动。
- [ ] SR-003内部schema与旧目录兼容实际实现并通过窄迁移/恢复验收。
- [ ] SR-001三处消费者补偿实现并各自通过真实回滚/重开验收。
- [ ] SR-002提交后收尾实现及真实store/窗口链路验收。
- [ ] SR-004导航票据实现与真实拒绝显隐验收。
- [ ] SR-005/006同批实现与真实滚动交错验收。
- [ ] SR-007失败语义、反馈和重试实现与真实设置表单验收。
- [ ] W-R01消费者可达性与旧Overlay、真实平台边界仍待独立工作。

本轮可以收口“第二轮复查与指导”，不能收口“所有问题已修复”“全项目充分审查”或“发布就绪”。后续按上述具体批次实施并以正确结果重新验收。
