# B3a/B3b 主窗口身份与普通几何实施

2026-10-09。两个子批已完成对应局部验收。紧凑/Dock 状态随后已由 [B4](09-window-runtime-implementation.md) 对应owner接管，实际跨view/Dock/Presentation结果见 [04 §25](04-implementation-plan.md#25-明确授权后恢复实施2026-10-09)；本批Host/geometry证据不代表所有窗口组合验收。

## 怎么改与实际所有权

B3a 基线：`tmp/refactor-baselines/B3a-2026-10-09T01-18-20-871Z`。`windows/main-window-host.js` 唯一持有 current BrowserWindow 和 generation。创建后才更新身份，拒绝第二个 live 主窗口，load 校验当前 identity，closed 一次安装，旧 closed 不释放新窗口，cleanup 异常仍清身份。主入口321处 AST 引用改为 getMainWindow 调用，保持原对象字段名及配置。共享 session、窗口 options、具体运行时事件继续由装配层负责，后续移交不能复制 current。

B3b 基线：`tmp/refactor-baselines/B3b-2026-10-09T01-29-05-762Z`。`windows/window-geometry-persistence.js` 唯一持有普通 debounce timer、dirty、suppression deadline、稳定可见 bounds。主入口所有原状态读写通过窄端口替换，视图切换 cancel 后读取 pending geometry，在导航前完成原 prepareViewSettingsForSwitch；恢复默认 cancel/markSaved 后短暂 suppress；退出使用 repository flush。Dock/Presentation 只提供稳定快照/允许写入判断，不能迁走或复制它们自己的尺寸/拖动/动画计时器。

保持原500ms防抖、750ms重置抑制、scope和两类写入副作用：普通保存走完整设置写协调，紧凑扩展边界/退出走 repository，不附加广播。SQL失败保留 dirty 供重试；稳定快照通过 clone 读取，外部不能修改内部字段。Presentation 自己持有 compactExpandedBounds；仅在稳定持久化成功后更新，不能把临时离屏动画帧保存为普通边界。

## 局部验证

九个明确文件共36个 unit通过：main-window-host、window-geometry-persistence、window-profiles、renderer-recovery、window-bounds、security-hardening、view-switch-geometry-order、editing-draft-session、window-compact-geometry。新增7个几何行为用例覆盖最新防抖、Dock冻结边界、reset取消和抑制、导航/compact guard、destroyed窗口、失败dirty重试、提交失败不更新稳定值和shutdown flush重试。报告 `tmp/b3ab-unit-final-results.json`。

B3a 首轮24/26：security-hardening 和 view-switch-geometry-order 仍匹配旧变量名，已改到当前 getter 和真实持久化顺序；未删除安全保护。九个本批文件最终 lint退出0，仅按名单格式化。普通几何被多个运行时消费，因而扩大为上述精确文件和下述单一跨视图专项，没有运行全库测试。

必要构建成功：`tmp/b3ab-app-build.log`。增强 `settings-runtime-electron.mjs` 在真实主窗口/SQLite路径验证：普通防抖写入、list→month→week 同一窗口/同一 native handle、未到防抖时 source geometry先落库、week恢复默认后不重插几何。与已有设置断言共36实际assert通过，accepted/evidence/cleanup完整，证据 `tmp/test-runs/2026-10-09T01-35-45-629Z-pFG0fv`。

该专项首次新增reset断言误读 month scope而实际已在week，得到4条正常历史记录，证据 `tmp/test-runs/2026-10-09T01-35-07-409Z-XsRCs6` 保留。核对 VIEW_SETTINGS_SCOPES 后只将断言改为week；未据此改业务或称产品缺陷。每轮独立 attempt，最终证据不覆盖首次失败。

专项用本次冻结 out，输出 hashes已记录，certifiedReuse=false。未重建blur ABI18和Capture产物，它们作为已有运行前置；未验证多屏DPI/完整层级/真实原生输入/所有Presentation组合、macOS、客户设备、安装和发布。未运行全量。

## 交接与回退

主入口已交 B3d/B4 代理继续单一文件拥有者迁移。新消费者必须使用Host identity与Geometry窄端口，不能再新增 mainWindow/dirty/timer 第二份状态；读Dock稳定快照时保持持久化优先顺序，写SQL成功后才清dirty。后续真实窗口测试因运行时变化重新选择，不把本批旧out结果当当前全部域通过。

回退按各批基线恢复本批入口增量、两个模块、上述源码读取接线及专项新增断言；不能覆盖后来B3d/B4成果，应在对应交接基线重放本批diff。新模块删除前检查现存消费者，manifest与测试一起回退。保留已生成失败和最终证据，不复制旧用户数据库，不reset/clean。
