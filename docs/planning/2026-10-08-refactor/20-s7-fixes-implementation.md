# S7：第二轮七项问题实施与验收

## 基线与边界

本阶段依据 [19 独立复查](19-independent-second-review.md) 的 SR-001 至 SR-007 实施。HEAD 为 `4fbc52be1c688dba9cf23fbbd51539606efbf381`，工作区已有前批未提交修改。本次共同恢复基线为 `tmp/windows-only/before-inventory.json` 与 `tmp/windows-only/before/`；不得用 Git reset/clean 覆盖这些修改。19 与旧证据保留为缺陷成立时的历史记录。

先完成七项修复及局部验收，再进入 Windows 专用平台清理。Apple 参考界面、业务数据、现有更新策略及原生 ABI 不因平台清理改变。本阶段不安装、发布、推送或部署，不默认全量回归。

## 修改配方与完成条件

| 编号 | 具体实现及调用方 | 验收条件 |
| --- | --- | --- |
| SR-001 | 将新增附件补偿集中到 `db/image-addition-compensation.js`；每个发布目标带有 staged 所有权。unlink 返回 false 或抛错时保留该目标的 manifest，不截断其他补偿，原 SQL 错误仍为主错误。同步 note commands、业务 IPC 与附件恢复测试。 | 真文件删除失败可在重启后再次恢复；没有失去 manifest 的孤儿；旧附件删除回滚仍执行。 |
| SR-002 | 新建 `application/business-data-clear.js`；数据库 clear 提交后依次尝试 Reminder、sticky、Renderer 草稿及广播。单项失败只累积，不跳过后续项；所有异步收尾完成才释放业务准入。向用户返回已提交但收尾不全的准确错误。 | 提醒 SELECT 注入失败时数据库已空，sticky/draft/broadcast 仍完成；准入最终释放，新便签可创建。错误不得诱导用户重复清空。 |
| SR-003 | 内部 schema 升级为 18，新增 `attachment_reset_commits`；reset v2 manifest 携带 operationId。清业务表与记录该操作提交在同一 SQLite 事务内；恢复按精确 operationId 判定，删除 payload 后清 journal。旧 v1 无确定证据时保留 ambiguous，而非按新业务行数量猜测回滚。 | marker 写与目录删除双失败后即使新建业务行，重启也不搬回旧字节；未提交事务仍恢复原附件；重复恢复幂等。 |
| SR-004 | Navigation 在 compact ACK 前取得 owner，记录原窗口身份、原 visible 及显式 hide 代次；失败补偿仅作用于仍拥有该操作的原可见窗口。`hideToTray` 接入用户 hide 通知；DraftGuard 可选 canReveal 阻止迟到检查越过新 hide 意图。 | 原可见来源失败后恢复；原隐藏来源不显示；用户中途 hide、退出、换窗及并发请求均不被旧操作重显。 |
| SR-005 | Custom reload 序列覆盖 begin、查询、提交、anchor 及 finally；reload 期间禁止用旧 offset 启动新分页。旧请求和 dispose 后结果不得提交或解除新请求门禁。 | 延迟刷新与滚动组合不丢页、不重复；后续分页基于刷新后 offset。 |
| SR-006 | quiet refresh 在提交前读取当前阅读锚点，成功提交后才恢复；旧查询无权恢复位置。 | 查询等待中的新滚动意图保留；刷新失败保留旧内容，失效请求不改新视口。 |
| SR-007 | Settings queue 按 ID 串行，保存最新未确认值与失败项；同键迟到结果不覆盖新值。SettingsPanel 显示失败及显式重试；close flush 包含历史失败，失败时保持面板打开；reset 排空旧写并清失败，dispose 禁止晚更新界面。 | 自动保存失败有反馈且可重试；close 不静默漏失败；同键重试/新写、reset/dispose 组合不写回旧值。 |

## 局部验证

先保留受控红例，修复后运行具体 unit 文件；红例成立不是产品通过。修改完成后串行运行真实专项：`database-runtime-db.mjs`、`attachment-recovery-reset-electron.mjs`、`presentation-mode-electron.mjs`、`note-list-custom-electron.mjs`、`settings-queue-electron.mjs`、`feature-runtime-electron.mjs`。必要 app build 用当前源并记录 provenance；真实 Electron 首次在沙箱外运行，固定 Node 与无 Volta PATH。

新增 helper 必须同步资产与源映射，不能批量将所有旧资产认证为 reviewed。结果以正式 runner 的退出码、业务断言、证据与清理状态共同判断；fixture 错误或环境阻塞保留首 attempt，再精确修复。

## 回退与数据保护

仅按本阶段清单从共同基线恢复指定文件，不回退其他已存在修改。schema 18 及 journal 属于恢复证据：代码回退前先停止软件、备份数据库与附件，不能直接删 journal 或强行改 user_version。失败 manifest/payload 不作为临时垃圾删除。旧 v1 ambiguous 需保留后检查，不能假定安全恢复或安全删除。

## 实际状态

七项已实施并通过本阶段局部验收。数据 unit 22/22，窗口及直接消费者 unit 54/54，Renderer unit 38/38；主代理 helper/登记/CI选择的三个指定文件 38/38。各自严格局部 lint、MJS syntax 和 diff 检查通过。准确文件/红绿与哈希见 `tmp/s7-implementation/{data,windows,renderer}/`。

正式验收证据：

- `tmp/test-runs/2026-10-09T07-07-38-144Z-BUnkeF`：附件 controller18/18（seed2、recover97），数据库30/30，均 accepted、证据/清理 complete。该 attempt 的 app 编译退出0，但并发 Vitest 写缓存导致来源漂移；GUI被正确阻断，不算通过。
- `tmp/test-runs/2026-10-09T07-09-26-167Z-fhCN6t`：重新构建来源 verified，feature67/67、presentation128/128、settings63/63 accepted。custom首次失败为测试同时人工和原生 scroll 连续加载两页，精确62条中间态被跳过，保留原 attempt。
- `tmp/test-runs/2026-10-09T07-15-49-246Z-uZ4Yhc`：失败区不再直接显示SQL/IPC信息，显示具体设置名称及未保存；必要重建 verified、settings63/63 accepted。custom推进到manual场景，真实连续offset0/20/.../140已加载全部150条，旧脚本仍要求再追加20，失败保留。
- `tmp/test-runs/2026-10-09T07-21-15-545Z-kxs1EK`：仅修custom夹具起始滚动位置和单次事件，严格保持20→40、offset0→20及唯一性断言，生产model/queue未改；app reuse来源 verified，custom54/54正式 accepted，整体exit0，证据/清理 complete。

设置失败区在白/黑/复杂背景、360px窄窗有实际截图与bounds断言，主代理已检查，未新增与UI标准冲突的局部颜色体系。附件schema18、manifest v2 与遗留v1兼容边界已实际验证；journal元数据清理失败保留证据并继续恢复，不撤回提交决定。准入覆盖clear后全部attempt；部分完成错误不提供破坏性的重复clear重试。

进入平台清理前保存 `tmp/windows-only/s7-accepted/` 文件及清单；后续平台回退从这个阶段边界开始，不覆盖七项修复。

旧 Overlay `zOrderSynchronized=false`、真实多屏、休眠、客户机器、长期运行与发布验证不属于本次已通过结论。
