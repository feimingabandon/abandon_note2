# B6d 设置域表单与区块实施指导

日期：2026-10-09。前置：B6c 四类写生命周期已集中验证；B6c/B6d/Q001 联合真实 GUI 已验收。范围：具备实际验证/状态职责的 dock 与 sticky defaults 两个域，不按行数把整页模板分成透传包装。

## 原件、边界与步骤

恢复点：`tmp/refactor-baselines/B6d-2026-10-09T01-35-00/` 保存 B6c 后 SettingsPanel/queue 与两个消费者保护原件/哈希。完整阅读 `docs/UI_DESIGN_STANDARD.md` 后迁移；保留原语义颜色、1 px 控件边线、密度、标签、帮助内容、诊断 action 和响应式布局。没有新增中性灰色或局部主题规则。

1. `useDockSettingsForm` 拥有当前 view 的 mode/edges/runtime refs、边缘去重/合法顺序/默认回退、可用平台判断、单个完整 DTO 以及乐观展示。收到 snapshot 只 assign，不写回。调用 settingsWrites 的 canWrite/saveDockConfig；请求代次、回读与 reset gate 仍只有 queue 一份。
2. `useStickySettingsForm` 拥有新建便利贴四项 defaults、预设值、十六进制输入草稿/错误、空值取消、3 位展开/6 位统一小写及控件同步；四字段 watcher 调用同一个 queue.debouncedSave。snapshot 的 assign 在父 queue gate 关闭期间执行；不改变已经存在的 sticky 窗口，也不发通用万能 save。
3. `DockSettingsSection.vue`、`StickySettingsSection.vue` 显示实际域表单，props 只接稳定的域模型及必要 viewLabel/reset/panelActive。解构的是原 refs，未创建局部第二份值或第二份 IPC 状态。DOM 原 section/rows、可访问名称、mode radio、edge aria-pressed、FontSizeInput、颜色浮层 Escape/focus 和 AppToggle 均保持。
4. `settings-form.css` 保存原公共设置行/标签/颜色编辑/slider/窄容器规则的唯一源定义，由父与区块的 scoped style src 引用。dock 自己的 selector 与 340 px container 规则随实际区块移动；外层字体变量、密度变量、container-type、全页深层控件尺寸/搜索高亮仍归父。Teleport 的颜色编辑节点携带区块 scope，继续由同一 shared CSS 控制。

父 SettingsPanel 保留单一权威 snapshot、CSS 即时预览、搜索/导航/当前视图、scroll memory、reset confirm、focus/trap、开合/拖动、诊断与必要区块间协调。WeatherSettings、WallpaperSettings 沿用已有边界，未再包同名字段的空组件。其它设置没有足够独立的状态/验证责任时暂留父，避免为减少总行数制造配置转发。

## 保护迁移与验证

dock-settings-ui 读取真正 DockSettingsSection/model 和 queue 的 owner，保留三唤出方式、三边缘、未选择提醒、unsupported 禁用、340 px 换行和父尺寸读取后才进场的断言；没有删保护换成编译通过。新增 `settings-form-models.test.js` 用实际 Vue lifecycle，覆盖 snapshot 去重/非共享数组、不写回、空选边、多选顺序/完整 mode DTO、unsupported/reset/非法操作、颜色 shorthand/空输入/无效输入/下次恢复、snapshot 显示同步和实际卸载后 watcher 停止。

指定四个文件 queue/models/dock/density 首轮共 29 例，28 通过；唯一新增 fixture 假设 alwaysOnTop 默认 false，实际默认 true，修成基于原值反转后仅复跑七例模型，全部通过。其余 22 例已通过。保存首次 `unit-results.json` 与修正 fixture 的 `model-unit-retry-results.json`，不把错误 fixture 当产品缺陷。本域十个代码/测试文件 ESLint 最终退出 0，无警告。

必要 app build 由另一代理统一协调，包含 Custom/本批 queue/forms/sections/B3d/Q001。生产 src 全树与 package/config 前后哈希一致，构建退出 0；证据为 `tmp/refactor-baselines/B6a-2026-10-09-list/custom-build-{before,after}.json`、`custom-app-build.log`。这是一段记录过的稳定构建窗口，不是完整 toolchain provenance 复用认证。GUI 随后串行消费同次冻结 out，专属 helper 记录全部 out hash 和 certifiedReuse=false，不再重复 build。

`ui-migration-verification.json` 确认旧面板 170 个 CSS rule 与新 parent/shared/dock 三处 170 个 rule 的 selector/声明/at-rule 上下文完全相等，没有丢失或新增声明；不把 rule 集合相等冒充 cascade/像素验收。

`settings-queue-electron.mjs` 实际完成三视图五分类、dock 语义背景/字体与普通行一致、窄面板无标签/控件重叠、mode/edge 实际持久化；list 的 sticky 字号关闭前 flush、无效色不写、规范化颜色、Teleport 视口边界、Escape 返回 trigger/保持面板、scroll remount、区块搜索/focus，以及 B6c/Q001 联合失败/retry。50 个实际 assert 通过，0 失败/跳过，退出 0；业务/日志证据、正常 will-quit/windowsClosed、script cleanup 与 runner profile cleanup 均完整，accepted=true，首轮有效专项通过。证据：`tmp/test-runs/2026-10-09T01-48-43-449Z-vFgufD/`。证据 JSON 记录 list/month/week 完成名单与逐 view layout，最终截图另有 SHA-256。

该专项尚未证明所有缩放/DPI、实体鼠标/设备位置、天气联网、所有 native blur 状态、OS auto-start、应用进程重启或客户机器；未以 static CSS 代替上述 GUI，未运行全量。B6c/B6d 当前局部验收完成。

## 回退与下一次扩展

按域回退模型、区块、父 assign/call/watch 接入和对应 style owner/source-read 定位；共享样式应与新旧 scope 一起恢复。仅恢复父模板而不接回原本地 form/watch，或仅删 shared CSS 会造成控件状态/样式缺失。B6c queue/后端原子 reset 不因区块回退撤掉。重新构建受影响应用，不保留混用新旧 schema/model/out 的产物。

新增区块前先证明它自己的状态/输入规则/生命周期，明确表单只由单一 snapshot 与 queue 管理；逐区块迁移 scoped/继承/Teleport，核对 DOM 可访问名称、搜索、focus、scroll 和实际窄窗。只有展示职责且只是转发大量同名字段时，不创建包装层。后续真实行为变化必须重新选择该域局部测试，不能只因为 parent 变动就全量回归。
