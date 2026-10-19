# B2b：Renderer workspace 公共生命周期移交

状态：B2b 已实施并通过本批指定局部验证。已读取完整 App/Month root 的 script、template、scoped CSS，以及现有 settings/provider/presentation/modal/clock 调用链；四个能力已按下面实际策略移交。

## 恢复范围与修改边界

恢复目录：`tmp/refactor-baselines/B2b-2026-10-09-workspace`。包含 App.vue、MonthApp.vue 及本批迁移的 tag-color-setting、quick-note-edit、modal-blur 源读取保护原件、SHA-256 清单和这几个文件的既有工作区差异；GUI 迁移前另保存 modal-queue-electron.mjs 原件和哈希。此副本用于本批按文件回退，不覆盖其他代理进行中的主进程、数据库、设置页或 B0 构建能力改动。

本批仅修改两个 root 的脚本和四个拥有明确生命周期的 composable；根 template/CSS 保持原字节。遵守完整阅读的 `docs/UI_DESIGN_STANDARD.md`，不新增外观令牌、中性灰色、边线、浮层层级或产品入口。

## 必须保留的实际策略

| 能力 | App 列表页 | MonthApp 月/周页 |
| --- | --- | --- |
| 壁纸读取 | 同 id 已完成缓存及进行中请求复用；隐藏后 220 ms 释放数据，以保留退出画面 | 每次快照读取，关闭立即清空 URL/key，不套用列表缓存 |
| 更新检查 | 手动时至少展示 500 ms；root ready 后 1200 ms 静默检查，只有 available 主动打开 | 仅手动检查，立即打开，不增加启动自动检查或最短展示 |
| renderer ready | settings/providers、通知和节假日初始化完成后通知 LIST | 相同初始化后还须收到 MonthWorkspace ready，再通知当前 MONTH/WEEK |
| window 设置快照 | 快照没有 window 部分时保留现有本地 lock/zOrder | 缺省字段回退当前月/周默认值 |
| hover 监听 | setup 阶段安装，卸载释放 | mounted 安装，卸载释放 |
| modal | 保留独立业务 FIFO、child modal 例外、等待时不取得 blur/focus | 同一规则，calendarBusinessModalOpen 留根展示 adapter |

首次使用/捐赠文案、通知确认与历史策略、跨年节假日提醒、月/周共用主窗口与当前 view defaults 都按现有行为保留。

## 四个迁移步骤与真实拥有者

1. `useWorkspaceRuntime` 创建每个 root 唯一的 message、quick edit、tag color provider 和 presentation 使用票据；拥有 settings/message/notes 订阅、hover、ready barrier 与 keyed modal blur 释放句柄。它应用权威 CSS/provider 快照，通过回调连接后续能力；不创建另一份共享时钟/presentation state。
2. `useWorkspaceWallpaper` 同步迁移 URL/key/visible/blur、load generation、App cached/pending 请求及 release timer。用显式策略区别两个视图，取消或卸载后旧请求不得提交。
3. `useWorkspaceNotices` 同步移交三个业务 modal request、pending notice/holiday refs、初始化/广播/跨年加载、首次使用完成、确认与 dismiss，以及 220 ms 延迟打开设置 timer。继续复用既有 `useTodayKey` 的共享分钟时钟。
4. `useUpdateCheck` 同步移交 update modal request、checking/result、manual minimum timer 与 list-only startup timer。保留既有错误结果的字段差异。卸载后晚到结果不会发起弹窗，timer 和等待的 resolver 一起释放。

template refs、便签编辑器、focus/Tab/Escape adapter、业务 compactBlocked 条件、template/help workspace 交互继续留 root。`retainModalBlur` 的模块级引用计数仍只有现有 utils 中一份，runtime 只保存本 root 持有的释放句柄，不复制计数器。

## 保护与验证规则

新增测试用 Vue 的实际生命周期/custom renderer 和独立异步预期，覆盖订阅安装/幂等释放、卸载中的初始化/ready、壁纸反向/重复请求/迟到结果与两种清空策略、通知初始顺序和延迟设置、list/calendar update 的主动/静默/最短时长差异。源读取保护中仍有效的 provider 边界移到真实 owner，不删除成没有保护。

局部验证使用指定 Node 和去 Volta 的 PATH，按明确文件运行；真实 Electron 从首次调用就在沙箱外运行。构建须与其他代理协商一段稳定源码窗口，只执行本批必需的 app build。根模板/CSS 使用恢复副本逐段 SHA-256 比较；这只能证明字节不变，不能替代实际 renderer 交互。

本批实际选择 workspace-runtime、quick-note-edit、tag-color-setting、modal-blur、queued-modal-lifecycle、modal-queue 六个 unit 文件；真实 GUI 为 `modal-queue-electron.mjs`（其脚本跨列表/月/周的通知/更新/首次使用场景）。未运行额外完整 month/week/presentation 脚本，也未因 root 属于共享入口自动全量测试。

## 验证结果与下一步

| 已运行 | 实际结果与证据 |
| --- | --- |
| 指定 Node 调用 Vitest，上述六文件 | 31 个用例通过，0 失败；`unit-results.json` 保存于本批恢复目录 |
| 指定 Node 调用 ESLint `--no-cache`，本批两个 root、四 composable、workspace-runtime/quick-note-edit/tag-color-setting 和 modal-queue GUI 十文件 | 退出 0 |
| 指定 Node 调用 `node_modules/electron-vite/bin/electron-vite.js build` | 一次必要 app build 退出 0；main 126、preload 16、renderer 397 modules。构建前协调其他代理停止共享源码写入；不据此声称产物复用来源已认证 |
| 两 root `<template>` 到文件末尾与保存原件逐段精确比较 | App、MonthApp 均完全相等。只证明模板/CSS 字节保持，不冒充像素视觉验收 |
| 实际 Electron GUI，runner 精确单任务 `modal-queue-electron.mjs` | 42 个实际 assert 调用通过，0 失败/跳过。业务、证据、script cleanup、runner cleanup 均通过，accepted=true；`tmp/test-runs/2026-10-09T01-18-19-974Z-XNek96` |
| 本批路径 `git diff --check` | 退出 0 |

GUI 专项新增真实 assertion recorder，mode 为 `electron-ready-real-app-modal-queue`。它执行原业务断言，不把打印 PASS/进程退出 0 当计数；记录真实 list/month/week 完成名单和最终截图哈希，保存 app/detail 日志。测试经真实 `app.quit()` 的 before-quit/will-quit/quit 路径结束，记录窗口关闭状态；runner 在子进程退出后移除它自己的私有用户数据。独立直接运行时保留 profile，明确标 preserved，不能当清理完整通过。

GUI 中 remote notice/update handler 和截图像素是隔离模拟；验证的是实际 preload、root、业务弹窗、FIFO/焦点/草稿/退出交接。它不证明联网升级、真实原生截图输入、客户机器行为、应用进程重启、安装或性能。未运行全量、未重编 native/Qt、未发布；根 UI 没有视觉样式变更。公共 root 引入的晚到 callback 失效保护有实际 Vue 卸载测试，但尚未据此宣布 Q-004 的 calendar remount 问题成立或修复。

回退时恢复两个 root 和两个 provider 源定位保护、modal-queue GUI 原件，撤除四个新 composable 与 workspace-runtime.test.js；重新构建受影响 app 产物，不能保留混合新旧 root/composable 的 out。恢复工具与执行器不纳入本批回退。

下一步进入 B6a 三个列表模式依次迁移，再进入 B6b。B6b 的 Q-004 慢请求与同文档 clear/remount 先定向复现；根页面整页导航、源码缺少 disposed、搜索命中均不能单独充当缺陷成立证据。
