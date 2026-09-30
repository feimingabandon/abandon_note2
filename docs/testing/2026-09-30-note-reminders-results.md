# 便签多方式提醒与稍后提醒测试结果

日期：2026-09-30。环境：Windows 11（10.0.26200）、Electron 43.4.0、x64。

## 实现结果

- 新建、编辑、月/周视图完整新建器和循环模板提供系统提醒、软件弹窗、托盘闪烁多选。全部取消表示关闭提醒；旧数据开启状态迁移为系统提醒。
- 系统提醒和软件弹窗支持 5、10、30、60 分钟后及自定义时间。Windows 通知使用四个快捷按钮和一个自定义按钮；自定义会打开软件的时间选择窗口。
- 一轮提醒共享唯一标识。事务及唯一索引保证每条便签最多一个有效提醒轮次，稍后请求第一次成功保存生效；重复请求不覆盖时间，已经进入下一轮后旧操作失效。
- 稍后时间独立保存，不改变便签生效日期、状态或日历区间。编辑器可修改或取消已有稍后任务。
- 完成、删除、关闭全部方式、循环实例替换会取消相关任务；恢复或重新进行不会恢复旧任务。数据清空后同步撤下提醒窗口和托盘提示。
- 多条软件提醒在一个独立窗口展示，主窗口隐藏时仍可显示，自动提醒不抢键盘焦点。托盘只使用一个闪烁计时器，处理一条不会清掉其他便签的提示。
- 稍后任务持久化，单个最近到期计时器负责触发，分钟调度负责启动/恢复/失败后的补检查。原生通知失败最多重试三次，不阻止软件弹窗和托盘。
- 独立提醒 preload 和 sender 校验限制接口权限。帮助页面及调度任务名称已更新。

## 已运行的局部验证

| 验证 | 结果与范围 |
| --- | --- |
| Vitest，12 文件 / 84 项 | 全部通过，具体文件见下方 |
| `tests/reminder-database-integration.mjs` | 通过：V16→V17 重复迁移、唯一约束、第一次成功生效、旧轮次拒绝、再次稍后、编辑冲突、注入失败回滚、完成/删除/关闭取消、重开数据库及过期补触发、模板替换 |
| `tests/backend-integration.mjs` | 通过：相关便签、模板及已有数据库迁移回归 |
| `tests/reminders-electron.mjs` | 通过：主窗隐藏、独立小窗不抢焦点、双入口去重、协议回传、多个提醒互不清除、托盘状态与退出清理；列表新建/编辑、月/周新建及模板多选；时间编辑/取消、自定义日期输入与 Enter 确认、360px 窄窗、非授权窗口 IPC 拒绝 |
| `tests/reminder-native-acceptance.cjs` | 通过：隔离 EXE 提交真实 Windows 通知，收到 `show`；通过 Windows 系统协议进行运行中回传 30 分钟稍后和完全退出后冷启动自定义回传，进程号分别为 34232、36236 |
| ESLint | 本次涉及的源文件和新增 JS 测试无错误、无警告 |
| electron-vite build | 通过，独立提醒主页面及 preload 正常产出 |
| Windows 本地目录包 | 通过，`--publish never`；afterPack 确认提醒 preload/HTML、ASAR 提取及原生资源完整性 |
| `git diff --check` | 通过 |

Vitest 文件：

```text
tests/reminder-service.test.js
tests/reminder-notification.test.js
tests/notification-policy.test.js
tests/notification-guard.test.js
tests/note-scheduling-rules.test.js
tests/scheduler.test.js
tests/historical-note-backfill-ui.test.js
tests/template-ui-utils.test.js
tests/note-remark.test.js
tests/note-text-color.test.js
tests/test-manifest.test.js
tests/package-native-config.test.js
```

执行时从第一条命令使用内置 Node，并为派生进程设置 PATH；真实 Electron、SQLite 和打包专项在沙箱外执行。应用集成测试使用临时数据库，没有操作用户实际便签数据。

目录测试包：`dist-reminders-test/win-unpacked/AbandonNote.exe`。这是当前工作区的本地构建，包含工作区原有改动；没有安装、提交、打标签或发布。

## 原生入口选择与测试过程

初版尝试 Electron 的 COM 通知操作接口：通知提交和运行中动作回调可用，但冷启动探针先超时，固定激活器标识后仍出现 `REGDB_E_CLASSNOTREG`。未将这些失败计为通过，也没有据此声称所有 Windows 环境存在相同问题。

最终实现使用项目原有 `abandon-note` 协议处理通知操作。四个预设按钮及自定义按钮的 XML、转义、参数解析在单测中验证；完整应用的 `second-instance` 分发在 Electron 专项中验证；隔离探针通过操作系统真实协议关联验证运行中唤起与退出后的冷启动。原生 probe 的产品名、协议、CLSID 和数据目录均独立，早期探针及最后通过探针的注册、测试快捷方式和临时 EXE 已清理，证据保留。

测试过程中还修正了独立窗口在打包分块下的资源路径，以及日历验收等待导航完成的测试竞态。最终退出码均以表格中的最后有效运行结果为准。

## 证据

- [白底提醒窗口](evidence/note-reminders/popup-white.png)
- [黑底提醒窗口](evidence/note-reminders/popup-black.png)
- [渐变壁纸背景对比](evidence/note-reminders/popup-wallpaper.png)（测试注入的渐变背景，不代表加载了用户壁纸）
- [360px 自定义时间窗口](evidence/note-reminders/popup-narrow-custom.png)
- [编辑器多选提醒方式](evidence/note-reminders/editor-channels.png)
- [原生通知与协议冷/热启动记录](evidence/note-reminders/native-activation.json)

## 未覆盖条件与限制

- 未运行 `npm test`、`npm run test:window-frame:win` 或其他全量回归；未将工作区已有的截图、窗口等其他改动自动纳入本次测试。
- 原生 `show` 表示 Windows 接受请求，不保证用户看到弹横幅；勿扰、通知设置等可能改变展示。原生测试调用实际系统协议，**没有自动点击 Windows 通知中心的按钮**，五个按钮在不同版本中的布局仍需人工验收。
- 未在 Windows 10 真机、不同 DPI、多屏、托盘折叠菜单或 Explorer 重启条件下做人工视觉验证。macOS 仅验证了通道能力规则，没有真机验证。
- 未执行真实睡眠/唤醒或关机；测试覆盖持久化恢复、过期触发及重复触发去重，保留实际电源环境验收。
- 只生成并校验目录测试包，未执行 NSIS 安装、覆盖升级、卸载或正式安装版的人工通知交互。
- 软件完全退出时不会定时唤醒电脑；重新运行后补触发过期任务。旧 Windows 通知可能仍留在通知历史中，但旧轮次动作经过数据库校验，不能重新创建过时的稍后任务。

## 提醒方式排版调整（2026-09-30）

按确认方案将列表新建、编辑、月周新建及循环模板的提醒方式改为左侧名称、右侧摘要；点击摘要展开多选浮层。选项右侧使用蓝色对勾，选择后保持展开，全部取消显示“不提醒”。不可用时显示“无需提醒”及原因。沿用现有语义颜色、浮层定位、展开动效与焦点归属；大字号时摘要自动扩宽。

本轮局部验证：

- `historical-note-backfill-ui.test.js`、`template-ui-utils.test.js`、`pointer-anchored-popovers.test.js`：3 文件、30 项通过。
- `reminders-electron.mjs`：最终退出码 0，输出 `REMINDERS_ELECTRON_OK`。新增真实鼠标选择与命中检查，覆盖 8 种组合摘要、连续多选、方向键/Home、空格/回车、Tab、Escape 焦点恢复、点击外部关闭以及各表单保存；保留原有提醒生命周期专项。
- 480px 白底、黑底、测试壁纸背景，以及 360px 窄窗配 24rem 正文字号：检查浮层未越界、页面无横向溢出、摘要完整可读，并读取实际计算字号避免把未生效的测试配置算作通过。
- 修改文件 ESLint、Prettier、必要构建及相关文件 `git diff --check` 通过。

真实输入检查中修正了点击字段名称未收起菜单，以及无关后台列表滚动误收起菜单的问题。测试同步等待新建成功状态与控件可点击状态；Electron 回车输入补齐 `char` 事件；主题注入等待窗口尺寸保存引发的设置广播，避免截图配置被覆盖。早期失败未计入通过。

截图：[收起状态](evidence/note-reminders/channels-collapsed.png)、[白底展开](evidence/note-reminders/channels-white.png)、[黑底展开](evidence/note-reminders/channels-black.png)、[测试壁纸背景](evidence/note-reminders/channels-wallpaper.png)、[窄窗大字号](evidence/note-reminders/channels-narrow-large-text.png)。尺寸和实际字体记录：[channels-geometry.json](evidence/note-reminders/channels-geometry.json)。壁纸为测试注入图案，不是用户桌面壁纸。

未运行全量回归；本轮未重做 Windows 10、多 DPI/多屏、macOS 真机、原生通知按钮点击及安装包验证。测试使用隔离临时数据库，未操作用户实际便签。

## 审查问题修复：滚动后提醒菜单滞留（2026-09-30）

提醒方式控件在定位前检查触发按钮与视口及各层裁剪容器的可见交集。按钮仍有可见部分时继续跟随定位；完全滚出可见区域时关闭浮层。若键盘焦点位于菜单内，则以 `preventScroll` 恢复到按钮，避免焦点落到背景页面或把表单滚回原位。无关背景列表及菜单自身的滚动仍不会关闭菜单。本轮未修改公共浮层工具或提醒业务规则。

验证结果：

- 从 `tests/reminders-electron.mjs` 抽取新增滚动场景，在修复前构建上运行，明确失败于 `hidden anchor closes menu`，确认回归用例能识别原问题。
- 修复后运行 `tests/reminders-electron.mjs`，退出码 0，输出 `REMINDERS_ELECTRON_OK`。新增真实滚轮输入覆盖 480×400、480×300 窗口中向上及向下滚出可见区域；断言浮层关闭、焦点留在编辑器、滚动位置不被恢复焦点拉回、重新打开后原多选状态保留。同时检查按钮可见时浮层继续跟随、背景滚动及菜单内部滚动不误关闭，并通过原有多选、键盘、主题和各表单保存检查。
- 修改的 Vue 组件和 Electron 测试文件 ESLint、Prettier 检查通过；`electron-vite build` 通过。
- 几何结果：[channels-scroll-geometry.json](evidence/note-reminders/channels-scroll-geometry.json)；修复后截图：[300px 窗口滚回顶部](evidence/note-reminders/channels-scroll-hidden-300-top.png)。

本轮只运行提醒专项及其必要构建，未运行全量回归，也未重跑其他功能的单测。未覆盖 Windows 10 真机、不同 DPI、多显示器、macOS 或安装包。测试使用独立临时数据库。
