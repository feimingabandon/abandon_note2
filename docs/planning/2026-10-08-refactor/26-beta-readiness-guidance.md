# 1.4.0 内测发布前收口指导

更新时间：2026-10-11

状态：本轮约定的客户端本机收尾验证已完成，不处理服务器。附件、日报、13项主链、Qt截图/私有剪贴板及标题栏专项已有有效通过记录。日志导出的完整GPU查询引发供帧停顿已通过A/B/A反转定位并窄修；生产无替换探针和日志专项已验证。用户允许鼠标验收后，正常模式六轮运动比较及新1.4.0目录包内截图/冷重启/导出均正式accepted，清理完整。用户于2026-10-11授权后已生成正常1.4.0本地安装包，构建与静态校验通过；安装升级卸载、缺少设备的实机条件及测试群自然卡顿仍属后续验证。第7节保留最新结论及历史失败。

## 1. 本阶段目标与产品约束

产品是单机、单人使用的 Windows 10/11 x64 桌面便签软件。Apple 参考外观保留。风险判断从实际用户操作、现有后台任务和 Windows 自然事件出发，不引入多人协作、分布式一致性或没有产品入口的并发需求。

本阶段交付目标是可以交给测试群下载体验的内测候选包及其真实验收结果。测试用户体验和反馈完成后，才进入正式 1.4.0 发布。当前授权包括内测前整理与准备；不包含向测试群发送消息、公开分发、推送标签、发布 GitHub Release 或更新正式版渠道。

拖动和贴边卡顿按用户明确决定移交下一版本现场验证。当前算法保持原样，发布前验证诊断采集、模式归属、导出和必要的开销；不将自然卡顿根因未确认作为本阶段必须先关闭的条目，也不宣称它已经修复。

每项待办必须记录：用户或系统触发路径、实际影响、现有保护、准备修改的文件和消费者、指定验证、停止条件及回退来源。没有可达路径的猜测不能自动升级为缺陷或内测阻塞。

## 2. 入场事实与证据边界

- B0–B7 的 27 个约定子批已完成，后续成立问题修复见 18、20；Windows-only 见 21。
- 毛玻璃层级故障已完成本机反复因果验证和窄修复，见 24；22、23 属于先前调查历史，不是当前未定位结论。
- 当前原生 ABI 为 22，窗口运动诊断与对应局部证据见 25。
- 本轮只读登记统计为 296 项资产，其中 274 项 test；77 项 `reviewed-protection`、197 项 `unreviewed`。统一 focused 入口中 65 项 test 没有已验证结果适配器。这些是治理状态，不是运行失败数。
- 只读 `release-quality --plan` 选择 186 项，七个旧 DB 专项被结果适配门槛阻断：backend-integration、note-duration-db、note-list-completion-db、note-remark-db、note-text-color-db、recurring-preview-db、reminder-database-integration。尚未执行该入口，不能描述为发布测试运行失败。
- 当前本机系统枚举只有一个屏幕：1920×1080，工作区 1920×1032；WMI 也仅一块活动物理显示器。未改变系统缩放、显示配置或安装虚拟驱动。
- 工作区有此前未提交的修改、新文件和删除状态。本阶段只认自身增量，不能把全部 dirty 自动归入一个修复，也不执行全库 reset/clean。

## 3. 合理场景与测试生成规则

按三层处理，既避免无用测试，也保留单人软件的数据保护。

1. 必需：正常编辑/保存/切换/退出、单次双击或连续点击、多个本应用窗口、后台模板与提醒、文件写入失败、升级及正常异常重启。这些均可能由一名用户或系统自然产生。
2. 按证据：大量历史便签下的慢查询、保存尚未完成就退出、磁盘满或文件被占用、休眠恢复、显示缩放变化。用真实入口或合理延迟/错误注入验证；说明注入代表的现实条件。
3. 非默认门槛：在 UI 没有入口的同时调用、直接改内部状态、无限创建窗口、持续高频 IPC 洪泛、无法与真实输入或后台调度对应的极端交错。除非发现现实触发机制，不为这些场景改变生产设计。

人类无法直接制造的交错仍可能由后台任务或系统事件产生，需沿现有调用链确认，不能仅凭“单人使用”删掉所有异步保护。安全授权、数据补偿和异常恢复已有有效契约继续保留。

## 4. 两处数据边界的实际处置

### 4.1 自定义列表分页

`useCustomListModel.js` 重建已浏览范围时分多次请求读取，当前没有跨请求的 DB 快照。可能的用户现象是读取期间数据顺序变化导致暂时漏项或重复项；这不是已确认的数据丢失，也不是多人并发问题。

核验顺序：

1. 查 `useNoteListQuerySession.js`、便签变更订阅、排序保存和模板生成是否已经使旧加载失效。
2. 使用实际列表入口，加载超过一页的合理历史数据；再触发同一用户的编辑/排序或现有后台模板变更。记录是否确有跨页变更窗口。
3. 延迟注入必须说明代表的机器/数据条件，不以零等待并行调用多个内部 API 证明用户缺陷。
4. 若旧会话已取消并正确重载，登记保护成立，不改 DB。
5. 若正常路径确有漏项/重复，先选择最小的失效重载或版本检查；只有产品确需固定快照且窄方案不足时，才评估游标或 DB 快照。

指定验证是 custom model 与 custom GUI，以及实际发生改动的 DB/订阅消费者。不自动扩大 Timeline/Tag 全库回归。未复现前不把快照改造列作内测阻塞。

### 4.2 保存、清空与退出

`business-mutation-admission.js` 会等待已经准入的操作完成，然后才清空或关闭资源。这保护已开始的文件/SQL操作，属于现有正确行为。极少数底层 IO 永不返回时，退出时间没有硬上限；目前没有正常用户流程卡死的确证。

内测前验证保存中退出、清空后重新使用、实际权限/文件写入失败的准确提示与补偿、隔离进程异常结束后的数据恢复。若这些成立，不为理论无限等待新增复杂取消系统。若出现自然长等待，先定位具体操作并补有限阶段记录/可理解提示，不强制关闭仍被使用的 DB，不添加吞掉失败的 timeout。

完整备份/恢复仍是以后功能计划，不因内测收口新增产品功能。测试与打包使用可恢复、独立的资料；不能拿用户真实资料清空、迁移或卸载。

## 5. Windows 环境验证能力

| 方法                                                      | 可证明                                                     | 不能据此证明                                      |
| --------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------- |
| 坐标/布局 fixture，注入 display/power 事件                | 负坐标算法、DIP/像素换算、相关事件过滤、恢复回调和清理顺序 | 系统真实改 DPI、拔屏、休眠、GPU 呈现              |
| Electron `force-device-scale-factor`，100%/125%/150%/200% | 该强制缩放条件下的 UI 布局、尺寸、浮层及缩放相关处理       | Windows 跨屏 DPI 消息、两块屏幕混合缩放与硬件行为 |
| Windows 设置调整单屏缩放，重启必要进程                    | 本机实际单屏缩放、窗口和 native 坐标状态                   | 双屏接缝、不同屏幕同时使用不同 DPI                |
| 可配置多个显示输出的 Windows VM/虚拟显示设备              | OS 枚举多个屏幕、不同布局及其支持的缩放/跨屏事件           | 客户物理 GPU、显示器插拔、功耗和真实视觉卡顿      |
| 实际双屏测试机器                                          | 指定硬件上的混合 DPI、跨屏拖动/截图/恢复                   | 所有 Windows/GPU/显示组合                         |

当前本机不具备真实双屏，不能通过修改 `screen.getAllDisplays()` 或事件对象伪称双屏验收。没有现成合适环境时，将实际双屏与自然卡顿作为测试群明确任务；不为了自动化默认安装显示驱动或修改用户系统配置。

Codex 官方云环境能编辑代码、执行命令和检查结果；当前官方指南列出 computer/browser use 不支持，没有由该文档确认的 Windows 多屏交互桌面。对本项目可承担源码/测试静态审查、环境兼容的纯逻辑测试、脚本与文档核对。Windows DLL、DWM、真实输入、系统通知及安装验收仍需可访问的 Windows 测试机；本任务实际使用本地 Windows 主机，尚未启动云任务。

官方核对来源（2026-10-10）：<https://learn.chatgpt.com/docs/environments/cloud-environments>。云端能否执行具体测试，以环境和仓库入口为准，不为了云测试恢复非 Windows 产品支持。

## 6. 按批实施

### BR-01：指导与有限结构整理

先统一指导索引当前状态与历史状态、最新 ABI 和验收指向，保留各阶段原始失败。三组registrar已迁移并完成对应unit/app-ipc/background/dock/logging有效局部验收，具体范围与首失败见28；不由局部通过推导候选就绪。

结构候选：`src/main/index.js` 中日志查询/打开目录/导出 IPC、远程通知 IPC、壁纸 IPC。逐个核对是否有独立职责和现成 owner；只迁移有明确收益的组，不按行数强拆。

日志抽取的具体步骤：保存进入时文件快照；将导出互斥状态与三个 handlers 放入专用 registrar；通过显式 ports 注入 main-window 授权、dialog/shell、日志存储、diagnostic controller 和 system snapshot；入口继续拥有性能采集器的启动/退出，不把采集器一并塞入 registrar。保持点击截止、freeze、snapshot lease、取消、错误与 finally 释放语义，禁止改日志格式和用户流程。

其它两组沿同一规则处理：授权入口保留、完整业务命令仍归业务 owner、依赖不传巨型可写 context。同步旧源码读取消费者、manifest 与 CI 叶规则。验证取消/失败/重入/资源释放的有效行为及实际 app 导出，不新增纯复制源码拼写的测试。没有独立收益的组登记保持现状及理由。

### BR-02：测试资产审查与执行门槛

按基础设施、数据/附件、窗口/native、列表/日历、截图/贴图、设置/通知/网络分批静态审查。每项记录保留、改写、等价替代后删除或不适用及原因；运行通过与静态已审分开。197 个未审状态和 65 个未适配状态存在重叠，不能相加。

优先处理上述七个 release-quality DB 项：核对每项真实 SQL/文件/行为保护和启动环境，再补相应 recorder、模式、attempt 身份、business completion、证据与 cleanup；如果已被独立验收的测试等价替代，证明覆盖后成组改入口/manifest/CI，不能直接删依赖或把 exit0 当业务通过。

其余 legacy runtime 按内测核心功能和实际故障检测价值适配。有效测试不能因治理成本删除；确有重复/过时定位时先建立替代保护。公共入口未知影响保持显式 needs-domain-validation，不全量 fallback。

每个实施批仅执行实际受影响测试与必要集成。最后固定候选基线，执行内测章程明确列出的综合验收；不把每次小修升级为全量，不通过 skip/放宽条件制造成功。

### BR-03：单人实际操作与诊断准备

主链包括新建/编辑/保存/完成/提醒/模板、三种列表、月周导航、设置持久化、便签窗口、截图/贴图、草稿退出/重启和清空收尾。组合来自实际操作顺序，关键异步只加入可对应现实条件的迟到/失败。

诊断在日常/深度两种模式验证日志量、无响应或采样缺失的准确表示、停止/到期/关闭/导出尾批以及脱敏。以同机同场景比较开关前后的耗时与资源，记录数据规模、观测窗口和版本，不承诺零开销。弱机长期与自然卡顿留作测试群任务。

### BR-04：内测候选构建与包内验收

固定本批完整候选来源和 SHA256，native/source/out/ABI22 必须一致。外部 native 工具链闭包未认证时重建并记录实际工具版本；内测前不必须开发通用工具链认证系统。

用户明确内测与正式使用同一个1.4.0版本和正常安装包名；package/lock已统一1.4.0，不新增beta渠道。当前仍不生成安装包，本轮仅执行 `--dir --publish never` 目录构建与包内专项，不安装、不上传、不公开发布。最终安装产物的生成和验收属于后续工作。

包内检查原生 DLL/ABI、Qt 运行库与插件、ASAR Worker、必要资源和启动权限。先从独立目录/测试自有资料启动；实际安装、旧版本升级和卸载在可恢复Windows VM或独立测试机器中使用正常1.4.0产物验证，核对生产安装标识与测试环境userData路径。不为本次内测另建发行身份，不覆盖当前用户正式安装或资料。

数据/附件损坏、无法启动、保存失败却报成功、基本窗口无法使用、升级破坏资料、诊断导出不可用属于阻塞。设备尚缺的实机项和明确移交的卡顿不伪写通过，进入已知问题与测试任务。

### BR-05：交付与测试群任务

交付候选安装包/校验和、准确版本与来源、测试摘要、已知问题、恢复说明和简短操作清单。用户负责分发，当前不自动给群成员发消息。

卡顿反馈：版本/Windows/毛玻璃/层级/壁纸/刷新率/显示缩放、卡顿时间、具体拖动或贴边步骤、设置→查看日志→开启深度排查后复现并及时停止导出。以自愿录屏辅助视觉证据，不要求上传便签内容。

双屏反馈复用 `docs/testing/capture-multimonitor-user-checklist.md` 的坐标/截图要求；先复核该旧清单的快捷键持久化等描述是否符合当前实现，再交付。扩展窗口跨屏拖动、贴边、隐藏恢复与拔屏可达性检查。真实 Windows 10/11、不同缩放/刷新率和弱机由测试用户实际环境承担。

测试群反馈后，有修改则按可复现原因修复、指定局部验证并记录新产物；没有修改则复用已验证的1.4.0文件和校验和。正式1.4.0的标签、渠道和公开发布属于后续阶段。

## 7. 完成表与恢复

| 条目                         | 当前状态         | 完成条件                                                      |
| ---------------------------- | ---------------- | ------------------------------------------------------------- |
| 产品/内测范围与风险规则      | 已明确           | 单机单人 Windows 约束写入本指导，卡顿现场任务与发布前任务分开 |
| 当前状态索引去歧义           | 本轮已整理       | 当前修复/ABI/证据单独指向，历史失败保留                       |
| 有收益的 IPC 结构整理        | 局部验收完成     | 三registrar及真实消费者，结果/边界见28                        |
| 遗留测试分域审查             | 静态审查完成     | 27/29/30/31逐项依据；测试窄修仍按33/36/37验收                 |
| 发布质量旧 DB 门槛           | 七项适配已验收   | 341不同业务断言与错误期望负对照见28，不称应用重启             |
| 实际单人主链与数据保护       | 13项专项通过     | 既有771项记录断言；真实UI、受控IPC、内存DB的边界分别保留 |
| 诊断开销/包内导出            | 本机约定验收完成 | 正常六轮比较及active/stop尾批通过，日常无详细运动日志，深度四类覆盖完整 |
| Windows 候选包与安装升级卸载 | 新目录运行链通过 | 新目录91项截图/冷重启/导出断言；1.4.0安装包已生成，安装/升级/卸载未验收 |
| 用户群操作清单               | 指引已准备       | 39已有正常1.4.0操作/反馈步骤；候选信息待最终实际验收后回填    |
| 自然卡顿、实际双屏及客户环境 | 下一版测试群验证 | 具体反馈与现场证据，不要求现在伪模拟结案                      |
| 正式 1.4.0 发布              | 后续阶段         | 内测反馈处理后另按正式发布过程执行                            |

本指导入场时仅新增指导和整理规划README；后续实施已按28及29—37分批开展，这段不再代表当前没有代码改动。索引入场快照：`tmp/beta-readiness/before-scope-20261010-141327-122/README.md`。后续每批另存本批恢复点，按owner/消费者/测试/产物成组恢复；不得覆盖之前重构和用户资料。

### 本轮实际收尾（2026-10-10）

- 唯一产品代码窄修：`AnnotationEditor::fitPanel` 对实际 `capturePrimary` 按钮应用紧凑样式，修复便签/背景来源按钮在窄工具栏中被挤掉；`selectionAndExport` 通过。同步原有截图README的Enter/双击/Ctrl+C说明，没有改运动算法、生产剪贴板或服务器代码。
- 附件：`tmp/test-runs/2026-10-10T09-19-45-433Z-kKlxyM` 三项目均accepted：恢复/重置18项、重置unit13项、存储30项。测试补真实journal schema；mock-SQL unit明确使用目录移动stand-in并保护EPERM失败保留，真实rename仍由Electron专项验证。没有据短时fixture EPERM推断客户锁文件原因或新增生产重试。
- 日报：`tmp/test-runs/2026-10-10T09-29-43-462Z-TzR59Z` 日报accepted，记录54项断言；TXT/XLSX真实写出并读回。修正测试对受限高度下内部滚动的错误期望，保留较高窗口的浮层方向验证。系统保存对话框响应受控，未操作真实Excel。
- 运动：测试准备的60次150ms创建burst曾使renderer丢355条；改为启动前在自有SQLite预置60条后，`2026-10-10T09-55-10-765Z-f2lHxH` warmup真实隐藏/显示及日志导出完成，producer/writer丢失均0、complete=true。修正Chromium注入缺少mouseLeave；正式计量仍失败于拖动updateCount=0。新增有限两帧准备观察和失败输入证据，最后一项改动仅静态检查通过，待解锁后复验。没有六轮开销结果，不能命名自然卡顿根因。
- Qt复制：UI对照46pass/1fail/1skip，剪贴板三业务fail。私有站ACL允许clipboard权限，但message与popup两种owner的OpenClipboard均返回5；命名站两种ACL方案创建均返回5。原复制失败保护正确保留会话。`tmp/beta-readiness/clipboard-private-access-*-20261010.json` 保留证据；未访问用户剪贴板。先在会话解锁后复验私有站能力；仍拒绝时再用独立用户会话或禁用宿主剪贴板共享的VM验证成功复制/生命周期。本轮不以skip记通过。
- 目录包：`tmp/beta-readiness/unpacked-check-20261010-retry/win-unpacked` 构建exit0、现有原生ABI22/Qt/ASAR校验通过，身份与SHA256见 `unpacked-check-20261010-identity.json`。首次依赖收集因无可用npm子入口失败，使用临时固定Node的npm.cmd后重建成功，没有更改产品配置。包内第一次中文路径解码错误已修测试UTF8/UTF16LE传输，遗留测试进程逐个验明身份后收尾，原失败未改写。
- 包内第二次 `tmp/test-runs/2026-10-10T09-57-05-532Z-Ozkunt` 通过22项记录断言后截图guard拒绝，未完成截图保存、冷重启和两次日志导出。候选/helper已关闭，cleanup无错误，失败profile保留。外层远端地址指向本地拒绝连接端点；未运行安装器、未写用户剪贴板。
- 原生只读探针 `tmp/beta-readiness/wts-desktop-guard-probe-20261010.json`：WTS默认和显式Session 2均成功，232字节等于真实结构大小、Level=1、SessionFlags=0（锁定）。截图拒绝并非结构尺寸/解析错误。保持会话解锁后重跑运动及目录专项，并复验私有clipboard能力；当前锁定快照不能证明解锁后也会拒绝。锁定尚不能认定为拖动updateCount=0的根因。
- 本轮没有再次运行全量回归；历史189目标184pass/5fail的attempt继续保留，不追改为全部通过。真实Windows 10、双屏/混合DPI、安装升级卸载和客户自然卡顿仍未覆盖。最后只回填本清单，恢复副本 `tmp/beta-readiness/current-checklist-before-20261010.md`。

### 解锁后续验收（2026-10-10）

- 默认与显式Session 2只读探针均返回SessionFlags=1；证据 `tmp/beta-readiness/wts-desktop-guard-probe-unlocked-20261010.json`。同一私有站探针message/popup的OpenClipboard均成功，清理完成；只证明解锁后的本机能力，不给之前访问拒绝命名更深的Windows原因。
- Qt：`tmp/test-runs/2026-10-10T10-29-23-431Z-v9BLG9` 的clipboard/UI均accepted；QTest分别5/48pass，复制feedback子进程3pass，均无fail或skip。图片真实写入读回、复制完成后的overlay销毁与feedback存活，以及真实桌面截图/贴图用例成立。
- 目录版：先核对所有候选产物SHA256仍匹配原identity，生产来源无变化，仅UI测试源码不同。`tmp/test-runs/2026-10-10T10-30-16-313Z-1s0Sla` 包内专项accepted，91项记录断言。单屏真实截图经ASAR图片Worker保存，冷重启后便签/附件/图片hash/尺寸/缩略图及快捷键读回一致；两次ASAR日志Worker导出complete=true/exportFinished=true，writer丢失和写错误0，候选/helper正常退出，清理完整。没有生成或运行安装器。
- 主链：`tmp/test-runs/2026-10-10T10-31-39-459Z-trL2li` 13个明确文件均accepted，共771项记录断言：application-lifecycle、business-clear-admission、calendar-workspace、capture-business、feature-runtime、note-draft-conflict、note-list-custom/refresh/tag-refresh、presentation-mode、settings-queue/runtime、sticky-persistence。清理均complete。clear/draft含受控IPC，capture-business用合成transport，sticky用内存SQLite；不将这些边界描述为真人输入或磁盘重启，实际冷重启另由application-lifecycle和目录专项证明。
- 标题栏：`tmp/test-runs/2026-10-10T10-35-21-278Z-MffRsZ` 中titlebar-native-drag accepted，179项断言、0skip，包含实际140px拖动、选择/原生dragstart保护、主进程90ms延迟和renderer帧延迟的日志归因、active tail及stop后不继续详采。原02:43的RAF注入失败保留，不能从一次复验推断其历史根因。
- 六轮开销仍在复验：解锁后Chromium注入、补持键modifier及SendInput按键+SetCursorPos位移三种轮次都仍在首计量拖动失败。两帧准备与export前后帧/焦点正常，最新真实左键持续按下却无后续页面移动事件；未证明锁定、RAF或modifier是原因。仅修改本motion测试，改用完整SendInput鼠标流和原生捕获/命中窗口证据，并在计量外增加export/dock独立对照；100px实际路径、六轮模式、native覆盖和日志完整性判据保留。没有修改生产运动算法或共享测试基础设施。

### 日志GPU查询定位与无鼠标收尾（2026-10-10）

- 失败输入路径的实际边界：16段持键WM_MOUSEMOVE均到达自有HWND和Electron，但renderer持键move与RAF停顿。`11-23-28-630Z-U57YlL` 的短trace显示pending swap达到上限，GPU真正执行swap约晚1.8秒，实际swap函数只耗0.180ms；不能把队列等待称作DXGI Present内部耗时。五秒备用分发、锁定、modifier、额外状态查询均没有成为已证原因。
- A/B/A反转证据均为真实生产导出、无物理输入的独立诊断probe。A `11-39-52-600Z-o7n0z9`：两次Dawn在绘制GPU主线程占用2409.156/2063.646ms，pending swap2409.900/2083.454ms，导出后的双RAF等待1750.6/1886.5ms。仅测试内将complete替换basic的B `11-45-27-259Z-XNmV5n`：Dawn为0、最大pending swap25.991ms、RAF7.8/5.3ms，原方法finally恢复。恢复原查询的A2 `11-47-31-050Z-5OsxG9`：Dawn2372.590/2080.228ms、RAF2114.4/1887.8ms，故障再次返回。各trace未满缓冲，原始trace和SHA256在各attempt中保存。
- 导出Promise在Dawn任务完成前已返回；该采集期间GPU任务无法执行，供帧在Dawn结束数毫秒后恢复。本机完整GPU诊断查询触发的供帧停顿已可重复验证，但不能用这些人工导出/受控运动证据结案测试用户尚未反馈的自然拖动或贴边卡顿。
- 本续轮唯一新增产品修改为 `src/main/logging/system-diagnostics.js`：导出使用basic查询，保留DXGI设备身份、可取得的驱动版本及独立featureStatus。basic不能确认实际渲染适配器，active字段删除；auxiliary为null，adapterSelection/auxiliaryStatus明确not-collected，并记录collectionLevel=basic。全零空描述的默认设备不报作已识别显卡；空驱动字段不视为已知版本。不改运动算法、后台节流、GPU开关或服务器。
- 测试修改限于 `tests/system-diagnostics.test.js` 与原motion专项。新增契约先对旧实现作负对照，`11-49-29-117Z-kajMTk` 两项按预期失败；修改后 `11-50-18-128Z-tMQRco` 六项通过。固定Node的语法、单文件ESLint/Prettier通过。motion诊断分支只在显式环境开关下启用，保留真实路径至少100px、六轮比较及日志完整性判据，未放宽失败或改共享测试基础设施。
- 生产无替换复验 `11-52-53-878Z-XfSQo0`：logging-actions正式accepted，79/79断言；独立GPU probe49/49、0skip，真实两次导出basic字段契约成立、collectionErrors为空，Dawn为0，最大pending swap27.242ms，RAF6.2/1.8ms。两专项正常will-quit、窗口关闭、清理errors为空、子进程exit0。probe的独立mode与motion验收不同，focused入口保留unverified；该attempt不是“全部验收通过”，也没有六轮开销结果。
- 刷新目录候选 `tmp/beta-readiness/unpacked-gpu-export-20261010/win-unpacked`：固定Node/npm子入口，以--dir --publish never构建exit0，afterPack原生/ABI22/ASAR静态校验通过。485项源码/config身份在构建前后无变化；ASAR中5个main JS逐文件匹配当前out，GPU查询为basic-only。五项核心产物SHA256及身份见 `unpacked-gpu-export-20261010-identity.json`。首次输出参数未正确引用在读取配置前退出，引用后成功；ASAR校验脚本的Windows路径分隔问题修正后逐文件一致，不改候选内容。
- 用户已明确真实鼠标验收等通知；六轮daily/deep运动和新目录capture-package-smoke均暂未运行，后者的driver也使用真实输入。旧目录的91项截图/冷重启/导出记录仍有效地描述旧候选，不替代新目录运行验收。通知后先关闭trace/probe/替换开关运行原六轮，再对新目录执行包内专项；不得重用旧candidate身份。
- 未运行全量回归，历史189目标184pass/5fail保留。Windows10实机、混合DPI/双屏、弱机长期、安装升级卸载及测试群自然卡顿仍未覆盖；安装包与发布仍未授权执行。本续轮只回填本指导，窄修前恢复副本在 `tmp/beta-readiness/gpu-export-before-20261010`。

### 正常鼠标验收完成（2026-10-10）

- 用户已明确允许运行并暂停鼠标操作。本轮只运行两个指定文件及其必需的app/native/capture构建，attempt `tmp/test-runs/2026-10-10T12-00-31-779Z-aQmID4`：5个目标全部verified passed，failed/unverified/blocked均0，总入口exit0。没有修改生产或测试代码，没有全量回归、安装器或服务器操作。
- `logging-motion-overhead-electron.mjs` 正常验收身份accepted，3860次记录断言通过、0skip，耗时53.289秒；trace/probe/GPU查询替换均关闭。daily/deep交替六轮，各3轮，每轮计量2次拖动+2次贴边隐藏恢复。含控制、预热和尾批共33次真实拖动、22次隐藏恢复，所有操作complete；每次16段SendInput路径实际最大位移约201.246px，可信持键页面move存在，不是只核对最终回到原点。
- 六轮毛玻璃paired z-order在计量前后均同步；renderer/writer丢失、writer写错误、运输拒绝均0，所有导出complete=true。daily三轮详细运动记录均0；deep三轮各16条，覆盖main drag、renderer drag、native motion、dock animation四类，nativeCoverageComplete=true。运动进行中的active export尾批、停止后daily不再详采均通过。
- 同机60条短便签、480×640、Apple/normal/blur/left/direct场景：每轮运动计量中位数daily3263.645ms、deep3258.557ms；两次拖动1218.552/1198.019ms、两次贴边周期2044.502/2058.949ms；计量后导出226.029/228.920ms。日志增量中位数45030/157732字节（约3.503倍）、33/50条。全应用进程CPU单核等效中位数33.763%/34.787%，差1.024个百分点；这些不是16核整机占用率。
- 只有每模式3个短时样本，存在观察/等待/调度和GC波动；内存是端点变化而非峰值。不能把略低的deep耗时解释成开启排查使软件更快，也不将日志增量外推成持续写入速率。当前比较未显示明显的运动耗时增加，没有自定性能预算或“零开销”结论；不证明所有客户设备视觉帧率，也不结案自然卡顿。
- `capture-package-smoke.cjs` 对最新 `unpacked-gpu-export-20261010/win-unpacked` accepted，91项记录断言、0skip，耗时13.195秒。真实单屏截图经ASAR图片Worker保存，独立进程冷重启后便签/附件hash、尺寸、缩略图及截图快捷键读回一致；两次ASAR日志Worker导出complete=true/exportFinished=true，writer丢失/写错误0。候选五项SHA256仍匹配identity，运行验收信息已回填该identity，不复用旧候选结果。
- 两专项均正常退出，窗口和自有candidate/helper关闭，cleanup complete/errors为空；包内pendingInspectorRequests=0，两个应用进程exit0。结束后再次查询未发现工作区自有Electron/候选/截图driver残留；已通知用户可恢复鼠标操作。
- 本机本轮待办已收尾。未运行全量回归，历史失败仍保留；真实Win10、混合DPI/双屏插拔、弱机长期、安装升级卸载、测试群自然卡顿和最终安装包/发布保持后续边界。以后小改仍按实际影响局部验证，不因本次收尾默认全量。

### 本地安装包交付（2026-10-11）

- 用户已授权生成安装包交测试人员，沿用正常1.4.0版本及名称。输出 `dist-local-1.4.0-20261011/Abandon-Note-1.4.0-windows-x64-setup.exe`，118092539字节，SHA256 `6356863dc57ab1c05c0bb83b2df91bf82a9c6f7fa609f4a4676b1c347d1762ec`；同目录SHA256SUMS.txt供校验。
- 固定Node/native工具链重建并使用--win nsis --x64 --publish never，退出0；afterPack原生模块/ABI/ASAR校验通过，NSIS可执行结构及latest.yml的版本/大小/SHA512匹配。486项来源记录构建期间无变化，之前已验收来源也无变化；exe、ASAR、blur DLL、capture exe、capture host DLL五项核心文件哈希均与12-00-31-779Z-aQmID4所验收目录一致。
- 安装包NotSigned，未执行安装器，未验收安装/旧版升级/卸载，也未重跑全量测试。只交付本地文件，没有提交、打标签、推送或公开发布；本轮没有修改产品代码。来源/日志/校验记录保存在 `tmp/local-installer-20261011`。

### 月周日期格与滚动条修复（2026-10-11）

- `MonthWorkspace.vue` 删除月、周共用的整画布 `380rem` 下限，日历画布使用公共 `scroll-y`。`MonthCalendarGrid.vue` 按实际行数计算最低高度，每排保留顶部日期区32rem、底部新建区28rem；月历五/六排与周历一排共用格子下限，空间充足时填满剩余区域。
- `tokens.css` 修正 Chromium 标准滚动条属性覆盖 WebKit 绘制规则的问题：支持 WebKit 绘制时将标准属性恢复auto，使用已有6px圆角主题滑块、透明轨道并隐藏箭头。其他滚动区域继续使用同一公共规则。
- 最终局部验收 `tmp/test-runs/2026-10-11T13-41-23-799Z-lOzBok`：app构建与 `calendar-workspace-electron.mjs` 均verified passed，628项断言、0失败/跳过，正常退出及清理完成。实际五/六排月历、一排周历在90/100/150%界面缩放、478/900px内容高度及小窗口下验证；日期头部与新建区不重叠，必要滚动仍可达最后一排。1344×478周视图三种缩放均没有纵向溢出。纯白、纯黑、复杂渐变背景截图已复查；这些背景是视觉测试夹具，不是用户真实壁纸或混合DPI模拟。
- 公共样式扩大验证只运行已有 `ui-responsive-electron.mjs`，退出0、7个场景通过，证据 `tmp/scrollbar-responsive-20261011/responsive.json`；覆盖设置页、侧栏、窄窗控件可达性与滚动布局。改动Vue/专项测试ESLint及格式检查通过，没有全量回归。
- 首次新增断言错误地假定月历固定六排，保留失败attempt `2026-10-11T13-34-00-263Z-PabgUR`；修正为实际五/六排后复验。之后截图发现公共样式仍有箭头，修正公共样式后再次验收，不以中间通过结果替代最终产物。
- 本轮未重新生成安装包；之前交付的 `dist-local-1.4.0-20261011` 不包含本次修复。真实Windows10、混合DPI/多屏和用户环境仍未新增验证。

### 日历修复安装包交付（2026-10-11）

- 用户随后授权打包；新包 `dist-local-1.4.0-20261011-calendar-fix/Abandon-Note-1.4.0-windows-x64-setup.exe`，118092724字节，SHA256 `477935711e6e7232ac35093e62f87314cbabb380e8a3374dad3dd9949f7ea6cb`；同目录 `SHA256SUMS.txt`。版本仍为正常1.4.0，旧安装包保留。
- native_blur/native_capture/app重新构建、NSIS x64以 `--publish never` 生成均退出0，afterPack原生/ABI/ASAR校验通过。486项来源在构建期间无变化；相对旧包只涉及日期格、日历画布、公共滚动条三个产品文件。35个out文件重建后与刚才实际窗口验收构建一致，包内逐文件哈希匹配；三项原生文件也与当前构建/部署一致。安装器MZ/NSIS结构、版本、大小与SHA512元数据核对通过。
- 打包校验读取ASAR时首次路径分隔符写成斜线，核对归档实际Windows路径后修正临时校验脚本，随后全部匹配；没有为此改动产品或包内容。来源、构建日志、校验记录在 `tmp/local-installer-calendar-20261011`。
- 安装包NotSigned。没有重跑全量测试或运行安装器，安装/旧版升级/卸载仍未实测；没有提交、打标签、推送或公开发布。
