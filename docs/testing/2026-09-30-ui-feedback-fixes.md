# 截图反馈修复与操作验收

日期：2026-09-30。针对本轮 13 张截图及文字反馈的增量修复。参考清晰层级、克制材质和连续反馈；以用户本次要求为准，撤回此前蓝色焦点框的设计。

本记录补充 [整体改造方案](2026-09-30-ui-consistency-responsive-plan.md) 和 [前两阶段实施记录](2026-09-30-ui-consistency-responsive-results.md)。此前测试通过没有覆盖本次全部真实页面问题，不作为本轮通过依据。以下仅说明实际修改和对应局部证据。

## 问题、修复与直观操作

| 反馈 | 原因与实际修复 | 在软件中如何体验 |
| --- | --- | --- |
| 新建正文顶部蓝框缺一段 | 全局焦点轮廓画在控件外，受到表单滚动区裁剪；按最新要求撤掉输入焦点蓝环，保留原有中性边线，不靠额外上边距遮掩。 | 打开新建便签，点击正文并上下滚动；正文轮廓完整，没有外扩蓝框。 |
| 持续方式选项不完整、切换时整行跳高 | 菜单不能只按触发器宽度布局；先测完整内容、对勾、内边距及滚动槽，再限制在视口内。持续方式触发器加宽，选择器和数字输入使用相同高度。 | 在“仅当天 → 指定天数 → 持续到完成”间反复切换；文字完整，同排时高度稳定。90/100/110/125/150% 均有断言。 |
| 便签截图完成后仍然是复制 | 原有来源回填链路存在，但主按钮、Enter 和双击仍默认复制。来源为便签时主按钮改为“加入便签”，来源为背景时改为“使用背景”；普通截图仍默认复制。Ctrl+C 和“更多”中的复制继续是明确的替代操作。 | 新建便签 → 图片 → 截图 → 框选 → 点击“加入便签”或按 Enter；缩略图直接出现在原表单。全局截图的主按钮仍为复制。 |
| 滚动后取消重要筛选出现越界重影 | 离场卡片副本原来直接挂在 body，脱离列表裁剪；现在仅复制可见卡片，放进与原滚动视口相交的裁剪层，并继承局部字号。滚动、缩放窗口、取消和卸载时清理副本。 | 准备较多便签，选“重要”，向下滚动后取消筛选；观察卡片只在列表内部退出，不穿到标题、操作区或窗口外。 |
| 快速编辑方框突兀、标签像被盖住 | 去掉嵌套焦点环，整理正文/备注标签和输入区间距，输入区使用圆角；窄短窗口内部滚动。 | 双击便签进入快速编辑，分别点击正文和备注；两段标签不与输入内容重叠。 |
| 各处输入仍有蓝框 | 检查全局令牌与组件局部 focus/focus-within/focus-visible 规则；正文、搜索、标签、字号、数值、日期时间及设置输入统一取消蓝色边框和光晕。按钮键盘导航保留细中性提示。 | 在新建、循环模板搜索、帮助搜索、标签搜索、设置字号之间点击或按 Tab；不出现套在外框里面的第二层蓝框。选中状态和业务状态的蓝色保留。 |
| 标签“更多”展开后自己缩回 | 原先用已经受限的外框回算内容高度，产生尺寸反馈；搜索清空时外框不变，单靠 ResizeObserver 又无法感知内容增加。改为测未裁剪内容，并监听内容变化。 | 打开“更多”等待，再搜索一个标签、清空搜索、关闭重开；列表保持展开并恢复高度，可继续滚动。完整面板中的长标签允许换行。 |
| 界面缩放菜单显示不清 | 公共选择器按自然宽度布局；小数字号的像素测量向上取整，避免“100%”单独被挤成两行。字号菜单及视图菜单也使用内容测量。 | 设置 → 界面缩放：90%、100%、110%、125%、150% 均完整可读；窄窗视图菜单也可看清三个视图名称。 |
| 下拉选中一会对勾、一会竖条 | 字号菜单去掉竖条，改为与普通选择器一致的预留对勾槽；地区各列也使用对勾。 | 对比界面缩放、字体大小、地区菜单；选中值都有对勾。日历日期格仍保留适合日期网格的选中填充。 |
| 已保存地区没有被选中 | 地区选择器之前没有从持久化地区恢复路径。现在优先按候选 ID 找到省/市/区，必要时按行政区名称匹配；每次打开恢复并滚到选中项。只有市级数据时不伪造区县。 | 保存地区，关设置再打开地区菜单；省、市、区与已保存结果相符。 |
| 全屏弹窗/整页工作区突然出现 | 通用模态、编辑器、图片预览补首次挂载 appear；帮助/模板内容及样式提前可用，滑入工作区等待初始关闭状态绘制后再打开。设置、确认框也明确初始布局后启动过渡。 | 首次和再次打开循环模板、帮助、新建/编辑等面板；内容与外壳一起平滑进入，关闭保留原有过渡。 |
| 月周左侧列表正文过大 | 日期侧栏设置局部字号层级，正文为基础字号的 0.88 倍，限制在 13–17 个设计单位；辅助文字为 0.72 倍、11–14 个设计单位，跟随界面缩放一次。 | 打开月/周视图左侧日期列表；正文和元信息更紧凑，主列表的用户正文设置保持原值。 |
| 年月选择器样式和位置异常 | 定位引用错误绑在“上个月”箭头；Teleport 后又丢失依赖工具栏祖先的按钮样式。改为锚定年月标题、补齐 Teleport 面板按钮样式、自然高度和视口避让。 | 分别点击月、周标题；面板贴近标题居中，靠边时避让，不再出现原生按钮的凸起方框。 |
| 其他过度样式及共享影响 | 普通下拉统一使用较轻的阴影；保留已有圆角和稳定阅读表面。修复公共焦点选择误把不可聚焦的时间行当作焦点目标的问题。 | 对比标签、字号、缩放和年月面板的阴影；打开时间面板后键盘可立即操作，Escape 返回触发器。 |

## 实现范围

- 公共样式与行为：`tokens.css`、`anchoredPopover.js`、`usePopoverLifecycle.js`、`useSlidingWorkspace.js`、`useNotePresenceMotion.js`。
- 选择及输入：`StyledSelect`、`FontSizeInput`、`NumberStepper`、`NoteDurationField`、`TagSelector`、`ChinaAreaCascader`、`WeatherSettings`、新增 `weatherSelectionPath.js`。
- 业务页面：`MonthCalendarToolbar`、`MonthDayPanel`、`QuickNoteContentEditor`、`App`、`MonthApp`、`MonthWorkspace`、`TemplatePage`、`SettingsPanel`。
- 首次入场：`AppModalShell`、`ConfirmDialog`、`ImagePreview` 及上述业务编辑器过渡；背景裁剪原本已有入场动画，沿用其流程。
- 焦点清理覆盖公共按钮/开关、标签管理、设置颜色及快捷键入口、帮助/模板搜索、日期摘要、月历快速输入、列表及搜索卡片操作、提醒控件与提醒窗、通知 Markdown 链接。没有移除今天、便签状态、危险操作和真正选中项的语义色。
- 原生截图：`AnnotationEditor.h/.cpp`、`CaptureOverlay.cpp`；对应 Qt 用例及 `capture-business-electron.mjs` 同步更新默认完成动作。
- 回归：新增 `ui-feedback-electron.mjs`、`ui-feedback-app-electron.mjs`、`fixtures/ui-feedback.vue`、`weather-selection-path.test.js`；组件夹具支持实际组件的独立入口与项目资源别名。
- 文档：设计约定、整体方案、实施记录及本记录同步。此前整体改造和工作区其他原有修改不算成本轮新增修复。

## 已执行的局部验证

所有 Node 工具显式使用 `C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`，子进程 PATH 避开 Volta。Electron/Qt 在沙箱外使用独立测试资料；没有读取或修改用户真实数据库。原生构建前确认没有仓库进程占用，不终止其他程序。

| 检查 | 有效结果 | 证据 |
| --- | --- | --- |
| Vitest 指定 13 个文件 | passed，39 项 | `user-feedback/final-checks/unit.log` |
| 直接修改的 JS/Vue 与测试 ESLint | passed，0 错误、0 警告 | `user-feedback/final-checks/lint.log` |
| electron-vite build | passed | `user-feedback/final-checks/build.log` |
| native_capture/build.ps1，不带 -Test | passed；Qt 部署工具有翻译目录路径警告，后续原生业务测试均成功 | `user-feedback/final-checks/native-build.log` |
| ui-components-electron | passed，10 场景；键盘、日期时间、菜单高度恢复、边界及动效 | `user-feedback/2026-09-30T09-52-48-572Z-DAa9c1/` |
| ui-feedback-electron | passed，9 场景；五档缩放下持续行高度、完整文字、标签稳定、地区回显、月周定位、快速编辑、裁剪与首次模态动画 | 同上 `feedback.json` |
| ui-feedback-app-electron | passed，6 场景；实际表单、36 条便签滚动筛选、首次/重复帮助模板入场、三种背景缩放菜单、窄窗视图菜单及月周侧栏 | 同上 `feedback-app.json` |
| capture-business-electron，ABANDON_CAPTURE_REAL_INPUT=1 | passed，真实桌面输入；来源草稿按 Enter 后增加第二张图，完成确认回执；兼查草稿保护、快捷键及背景裁剪取消 | `user-feedback/2026-09-30T09-46-15-743Z-pKO60C/capture-business-electron/` |
| Qt completionReturnsToRequestingForm / completionGestures | passed，覆盖全局/便签/背景主动作、Enter、双击、Ctrl+C、贴图手势及导出图片 | `user-feedback/final-checks/capture-completion.txt` |
| Qt toolbarLayoutAndTheme | passed，工具栏操作可达及主题 | `user-feedback/final-checks/capture-toolbar.txt` |
| git diff --check | passed | `user-feedback/final-checks/diff-check.log` |

Vitest 文件：`weather-selection-path.test.js`、`styled-select-menu.test.js`、`tag-selector-ui.test.js`、`quick-note-edit.test.js`、`sliding-workspace.test.js`、`note-duration-mode.test.js`、`pointer-anchored-popovers.test.js`、`ui-z-index.test.js`、`ui-popover-motion.test.js`、`ui-interaction-standard.test.js`、`clipboard-and-selection.test.js`、`note-remark.test.js`、`calendar-recurring-preview-ui.test.js`。

完整证据目录为 [user-feedback](evidence/2026-09-30-ui-consistency/user-feedback/)。最新界面 run 保存命令、退出码、stdout/stderr、关键截图及源码 SHA256（包含新增源文件）。测试报告不把“文字没有溢出”当成足够条件：缩放菜单另检查单行高度，并人工复看最终截图。

## 调试中发现并关闭的问题

- 标签搜索清空不能恢复、年月面板锚点错绑、100% 因小数像素换行、时间面板焦点落不到可操作元素，均经过修复和有效复测。
- 原生主动作测试起初命中待删除的旧复制按钮；给替代按钮独立标识后，主按钮查找及行为验证通过。
- 测试夹具的模块别名、Electron 启动时序、跨场景组件复用、草稿保护和滚动锚定前提也有修正。旧失败日志保留，不能混同产品缺陷，也不作为通过结果。
- 真实列表用逐帧采样检查离场副本边界；隔离夹具关闭浏览器自动滚动锚定，专门验证副本样式和随后滚动清理。二者覆盖不同条件。

## 未运行与边界

- 未运行全量测试、完整 Windows 窗口专项集合、原生截图全套回归、打包/安装/发布验证。
- 本轮没有重新执行物理双屏混合 DPI、Windows 10 独立机器、真实中文输入法完整输入链路。五档 UI 缩放和组件测试不能代替这些条件。
- 公共壳覆盖多个弹窗，但没有逐个复跑更新、日志、软件通知等全部业务流程；任意主题颜色、全部窗口尺寸和全部数据组合也不宣称已覆盖。
- 截图专项验证本轮默认动作及回填，不等于多屏截图、OCR、标注和贴图生命周期的全量验收。
- 没有提交、推送或制作安装包。已安装的旧版本不会随源码自动更新；体验时需运行当前源码的开发/预览版本并重启原生截图进程。
