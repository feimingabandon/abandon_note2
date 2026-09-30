# 开源截图模块复用评估

日期：2026-09-29。对象：Abandon Note 的独立截图、标注、贴图能力。

后续产品决定：用户明确以 Snipaste 免费版的截图、贴图、工具栏和交互为目标，开源代码仅作参考，不强求复用。下文候选与源码事实作为历史调研保留；“优先集成某库/裁剪某应用”的建议不再是执行前置条件。后续以 [交互基线 v2](2026-09-28-screenshot-core-design.md) 为准。

本轮只做公开资料与源码评估，未替换产品代码、安装或运行候选软件。功能判断区分文档声明、源码证据与尚未进行的集成验证。前置问题见 [Snipaste 免费版差距复核](2026-09-29-snipaste-free-gap-review.md)。

## 1. 结论与建议

**值得复用开源成果；不建议继续从零扩写当前标注编辑器。** 当前最欠缺的是可编辑图元、工具与参数反馈、文字编辑、贴图继续标注，以及连续鼠标/键盘操作的状态管理。这些不是再增加几个绘图分支就能完成的。

建议保留现有 Electron 业务接入和原生进程管理，把“绘图与交互内核”的选型重新打开：

- **希望控制依赖和改造范围：优先验证 kImageAnnotator。** 它是真正可嵌入的 C++/Qt QWidget 库，有编辑对象、参数控件、撤销重做和多种标注工具。代价是截图选区、浮动操作栏布局、贴图窗口管理仍需自己适配。
- **希望尽量复用整套截图＋可编辑贴图：重点验证 Snow Shot 当前原生版本。** 在本轮深入检查的候选中，它的源码覆盖更接近目标，而且已经拆出绘图引擎；但正在发布 beta，构建依赖和代码范围明显更大，不能直接断言总成本更低。
- **Flameshot 是截图浮层的强候选，不是完整的 Snipaste 贴图替代品。** 它能解决不少截图中操作细节，但贴图编辑仍需补充。
- **ScreenPinKit 值得重点借鉴贴图交互。** 它确实有贴图编辑，不只是显示图片；如果允许 Python 运行时，可作为整套改造候选。若坚持 C++，逐段移植 Python 代码属于重写，不算低成本直接复用。
- **eSearch 适合愿意重新评估 Electron 路线的情况。** 可以抽取源码并共用现有 Electron，不必打包第二套 Electron；但不是直接导入就能使用的组件。

不建议现阶段把任一第三方完整 EXE 放进安装包，再通过快捷键/剪贴板“遥控”。这可以很快做出启动演示，却不能证明满足同生共死、取消回调、便签/背景精确交付、配置隔离和贴图编辑等要求。

## 2. 候选比较

这里的“可借鉴”不代表必须照搬所有快捷键、外观或扩展功能。

| 候选 | 已确认的相关能力 | 适合复用什么 | 主要成本或缺口 | 判断 |
| --- | --- | --- | --- | --- |
| [kImageAnnotator](https://github.com/ksnip/kImageAnnotator) | QWidget 标注库；选择/移动/缩放对象、文字编辑、颜色/粗细等参数、撤销重做；直线、箭头、记号笔、模糊、像素化 | 编辑器与图元模型；截图和贴图共用的标注能力 | 默认布局偏独立图片编辑器；没有屏幕捕获、全局快捷键或贴图管理；公开工具枚举未见折线和橡皮擦 | 轻量组件复用首选验证对象 |
| [Snow Shot / Snow Apps](https://github.com/mg-chao/snow-apps) | Qt 截图操作栏、共享绘图引擎、贴图内编辑/撤销重做、透明度与缩放、贴图保留/销毁等状态 | 整套交互流程或独立绘图引擎 | beta；C++/Qt＋Rust＋OpenCV 等；整应用锁定 Qt 6.11.1，当前本项目为 6.8.3；还包括大量识别/录制/更新功能 | 整套改造优先进入验证，尚不能直接选定 |
| [Flameshot](https://github.com/flameshot-org/flameshot) | 截图浮层直接标注、对象选择、就地颜色选择、滚轮调整工具大小、放大镜、撤销重做、贴图 | 截图浮层、工具条及输入状态 | 当前 PinWidget 没有标注编辑器；自身有驻留进程、单实例消息和配置体系 | 截图体验参考及备选底座 |
| [ksnip](https://github.com/ksnip/ksnip) | 截图模式、上次区域、延时、快捷键、调用 kImageAnnotator 编辑、贴图 | 捕获与编辑分层、输出动作、编辑库接入方式 | PinWindow 是 QLabel 图片窗；工作流偏截图后进入编辑器；Windows 不支持 README 中所有平台的截图模式 | 优先取其库，不优先嵌入整个应用 |
| [ScreenPinKit](https://github.com/InterwovenCode/ScreenPinKit) | 截图、放大镜/取色、贴图内工具栏、图元编辑、折线/记号笔/橡皮擦、撤销重做、Ctrl＋滚轮透明度、鼠标穿透 | 贴图编辑、绘图态与拖动态切换、工具参数跟随对象 | Python＋PyQt5；原始依赖含 PyQtWebEngine、OpenCV、ONNX 等；没有在本轮发现独立 tests 目录；MIT 不覆盖全部依赖 | 功能参考价值高，整合需接受额外运行时 |
| [eSearch](https://github.com/xushengfeng/eSearch) | 截图内绘图、取色、马赛克/模糊、Fabric 对象编辑；贴图缩放/透明度/归位/穿透；编辑入口 | Web 绘图交互、选区、贴图工具条 | 和设置、IPC、OCR等耦合；贴图编辑入口把图片送回编辑流程，不等于贴图原位编辑；须重接 preload 边界 | 不坚持 C++ 时值得对比 |
| [ShareX](https://github.com/ShareX/ShareX) | 丰富截图模式、标注/遮挡、快捷键工作流、Pin to screen | Windows 交互参考、捕获后动作、工具参数体系 | C#/.NET，当前还含 Avalonia/Skia；本轮抽查的贴图窗无标注编辑器；应用范围远超所需 | 借鉴成熟细节，不优先整套嵌入 |
| [Greenshot](https://github.com/greenshot/greenshot) | 区域/窗口截图，独立编辑器，标注/高亮/遮挡，输出插件 | 输出目标解耦、编辑器交互 | C#/.NET Framework；本轮未确认符合目标的贴图编辑链路 | 次级参考 |

### 2.1 最容易误判的“支持贴图”

查了源码后，不能再把“支持 Pin”简单打勾：

- **ksnip** 的 [PinWindow](https://github.com/ksnip/ksnip/blob/343925d24bb0031e636013773fd310e9c56315b9/src/gui/modelessWindows/pinWindow/PinWindow.cpp) 使用 QLabel/QPixmap，支持拖动、滚轮和关闭菜单，没有集成标注库。
- **Flameshot** 的 [PinWidget](https://github.com/flameshot-org/flameshot/blob/2d478061ffeeba5919d3a3d9168f93542ea9b357/src/tools/pin/pinwidget.cpp) 支持缩放、透明度、旋转、复制和保存，但没有截图浮层的工具编辑模型。
- **ScreenPinKit** 的 [PinEditorWindow](https://github.com/InterwovenCode/ScreenPinKit/blob/b50c04436fe119c4c28894d7aa19b20e5b0b2fdf/src/view/pin_editor_window.py) 直接创建 PainterInterface 与绘图层，非编辑态拖动、Ctrl＋滚轮调透明度，编辑态交还事件给绘图组件。这才接近目标中的“贴图还能继续修改”。
- **Snow Shot** 的 [ScreenshotPinnedEditController](https://github.com/mg-chao/snow-apps/blob/89a13ef983047717c82757b8c4d8ce9dce9d8186/snow_shot/src/presentation/pinned/screenshotpinnededitcontroller.cpp) 为贴图创建浮动工具栏，将 undo/redo、工具和样式绑定到 SnowCanvasWidget；[滚轮处理](https://github.com/mg-chao/snow-apps/blob/89a13ef983047717c82757b8c4d8ce9dce9d8186/snow_shot/src/presentation/pinned/screenshotpinnedinteraction.cpp) 区分 Ctrl 透明度与普通缩放。
- **eSearch** 的 [ding.ts](https://github.com/xushengfeng/eSearch/blob/a86a0bcfcf7f2f7dad86aba67cd6871b89e0048b/src/renderer/ding/ding.ts) 有编辑按钮，但 edit() 发送 edit_pic 图片消息；不能据此认定与 Snipaste 原位编辑相同。

## 3. 最值得借鉴的功能设计

| 本项目已发现的差距 | 可复用或参考的实现 | 仍需本项目明确和验收的内容 |
| --- | --- | --- |
| G06/G07：工具无选中反馈、参数藏在菜单和模态框 | kImageAnnotator 的 ToolSelection/ItemSettings；Flameshot 的工具按钮、取色和滚轮；Snow Shot 的样式工具条绑定 | 活跃工具、颜色和粗细可见；参数点击不能意外结束编辑；小选区/屏幕边缘不能遮挡 |
| G08/G09：工具少，松手即变成不可编辑 stroke | kImageAnnotator 对象选择/修改器与命令式撤销；ScreenPinKit CanvasScene＋QUndoStack；SnowCanvasRuntime | 新建、选中、编辑、完成、撤销重做的状态一致；不要同时维护旧 stroke 模型和新对象模型 |
| G10/G11：文字右键丢失，文字框难调整 | 各成熟编辑器的文字编辑状态；SnowCanvasWidget 有提交/取消草稿及样式弹窗焦点接口 | 中文输入法、换行、字号调整、拖动、右键完成、Esc 取消的像素结果与状态 |
| G13：贴图不能继续标注 | ScreenPinKit PinEditorWindow；Snow Shot PinnedEditController；或在自有贴图窗中嵌入标注库 | 截图与贴图共用编辑模型；移动/缩放窗口不能误画；保存和复制应导出当前编辑结果 |
| G14/G15：透明度、重置、边缘缩放与键盘欠缺 | ScreenPinKit、Snow Shot；ShareX PinToScreenWindow 的重置与透明度操作 | 明确 Ctrl＋滚轮、中键、方向键、Ctrl＋S/W 行为；逐条重跑前一轮差异探针 |
| G16：关闭和销毁混同 | Snow Shot 的保留/销毁意图、贴图管理 | 只需要会话内恢复还是跨重启保存应由本项目决定；全退必须清掉运行中的窗与进程 |
| 自动框选、放大镜、取色、上次区域 | Flameshot 放大镜；ksnip 上次区域；ScreenPinKit 放大镜和图像轮廓检测；Snow Shot 窗口/区域检测路径 | 图像轮廓识别不等于 Windows UI 元素识别；准确率、混合 DPI 和遮挡情况仍需实测 |
| G01–G05/G12：双击、中键、空格、修饰键约束等习惯 | 将 Snipaste 文档作为本产品交互规范，参考各项目事件处理结构 | 上游默认快捷键各不相同；直接集成不会自动实现 Snipaste 语义 |

这里借鉴的核心是对象模型和连续操作流程，而不是照抄图标、颜色或品牌外观。

### 3.1 kImageAnnotator 能直接省掉什么

[公开 API](https://github.com/ksnip/kImageAnnotator/blob/d184dbd77da385a7e2e9c7527f3a4184b0842cb4/include/kImageAnnotator/KImageAnnotator.h) 是 QWidget，提供 loadImage()、image()、undoAction()/redoAction()、imageChanged 等接口，有独立 [集成示例](https://github.com/ksnip/kImageAnnotator/blob/d184dbd77da385a7e2e9c7527f3a4184b0842cb4/example/main.cpp)。

可以减少图元命中、选择/移动/缩放、文字修改、参数面板、撤销命令和图像渲染方面的从零开发。源码确实包含 AnnotationItemModifier/Resizer、ChangePropertiesCommand/MoveCommand/ResizeCommand 等，而非只有几个绘图函数。

但有四个边界：

1. 默认编辑器是 dock 面板布局，公开 API 没有完整暴露“自有工具条逐项控制”的接口。改成紧凑的截图悬浮工具栏可能需要维护小型 fork/适配层。
2. 公开工具枚举没有折线和橡皮擦；不能声称覆盖前一轮所有缺口。
3. image() 返回合成位图。若贴图时只传 PNG，旧对象将被压平；应保留/迁移编辑会话，或明确只支持在已合成图片上新增标注。是否需要原对象继续修改要单独决定。
4. 支持 Qt6 构建选项，但当前 Windows CI 配置使用 Qt 5.15.2。不能由“支持 Qt6”直接推导在本机 Qt 6.8.3/MSVC 下已通过。

依赖为 kColorPicker、Qt Widgets/Svg，LinguistTools 用于构建翻译。README 说明 Windows 当前只支持静态构建此库。这不要求用户安装 Qt，但需要开发端构建并随程序正确打包所需 Qt DLL/插件和许可材料。

### 3.2 Snow Shot 为什么值得纳入，但不能立即采用

原 mg-chao/snow-shot 已迁移到 [mg-chao/snow-apps](https://github.com/mg-chao/snow-apps)。搜索到的旧 Tauri/Web 版或 fork 不能代表当前上游技术栈。

本轮当前源码已具有：

- [SnowCanvasWidget](https://github.com/mg-chao/snow-apps/blob/89a13ef983047717c82757b8c4d8ce9dce9d8186/snow_draw_engine_qt/include/snow_draw_engine_qt/snow_canvas_widget.h)：公开工具、样式、撤销重做、文本草稿、工具状态信号等接口。
- [SnowCanvasRuntime](https://github.com/mg-chao/snow-apps/blob/89a13ef983047717c82757b8c4d8ce9dce9d8186/snow_draw_engine_qt/include/snow_draw_engine_qt/snow_canvas_runtime.h)：可克隆/序列化文档会话和历史、渲染到 QImage；这对截图转贴图时保留编辑状态很有价值。
- [贴图配置与窗口](https://github.com/mg-chao/snow-apps/blob/89a13ef983047717c82757b8c4d8ce9dce9d8186/snow_shot/include/snow_shot/presentation/screenshotpinnedwindow.h)：编辑会话、透明度、窗口交互、保留/销毁意图。
- 图元和贴图/工具栏/几何方面有独立测试源码。**本轮只确认这些测试存在，没有执行，也没有审计全部断言。**

其 [绘图引擎 CMake](https://github.com/mg-chao/snow-apps/blob/89a13ef983047717c82757b8c4d8ce9dce9d8186/snow_draw_engine_qt/CMakeLists.txt) 仍依赖 Rust 静态库、OpenCV、Ant Design Qt 图标/相关构建。它不是只复制一个 .h/.cpp 的轻量库。

[整应用 CMake](https://github.com/mg-chao/snow-apps/blob/89a13ef983047717c82757b8c4d8ce9dce9d8186/snow_shot/CMakeLists.txt) 锁定 Qt 6.11.1，还涉及 Qt 私有组件、ONNX 等；根构建要求 CMake 4.2。仅绘图库未在该文件声明同一精确 Qt 限制，但相关依赖是否能与本项目 6.8.3 一起构建尚未验证。完整应用不能与本项目 Qt 6.8.3 DLL 混用。

当前看到的最新发布为 1.1.6-beta（2026-09-28）。虽然该 GitHub release 的 prerelease 字段为 false，版本名依然明确是 beta，本评估按 beta 对待。

### 3.3 其他路线的真实成本

- **Flameshot**：[CaptureWidget](https://github.com/flameshot-org/flameshot/blob/2d478061ffeeba5919d3a3d9168f93542ea9b357/src/widgets/capture/capturewidget.cpp) 已有工具对象、撤销栈、放大镜和滚轮处理。导出仍耦合 Flameshot 单例；[daemon](https://github.com/flameshot-org/flameshot/blob/2d478061ffeeba5919d3a3d9168f93542ea9b357/src/core/flameshotdaemon.cpp) 负责托盘、快捷键和贴图，Windows 消息使用固定的 org.flameshot.Flameshot 单实例身份。嵌入时必须隔离身份并重接宿主协议，避免把指令发给用户自己运行的 Flameshot。
- **ScreenPinKit**：[requirements](https://github.com/InterwovenCode/ScreenPinKit/blob/b50c04436fe119c4c28894d7aa19b20e5b0b2fdf/requirements.txt) 是 PyQt5，不是 PySide6。可以打包 Python 运行时，使用户无须单独安装 Python；但开发和升级仍多维护 Python、Qt5 及依赖。移除 OCR/WebEngine 等需要实际梳理 import 与功能耦合，不能仅删除 requirements 行。
- **eSearch**：[package.json](https://github.com/xushengfeng/eSearch/blob/a86a0bcfcf7f2f7dad86aba67cd6871b89e0048b/package.json) 使用 Electron、Fabric、node-screenshots 等，源码抽取可复用本应用 Electron。其 [main.ts](https://github.com/xushengfeng/eSearch/blob/a86a0bcfcf7f2f7dad86aba67cd6871b89e0048b/src/main/main.ts) 为相关页面设置 nodeIntegration: true、contextIsolation: false，本应用当前相反；接入应改成受控 preload API，不能直接搬入。无需的 OCR/录屏/翻译依赖需要随模块边界一并裁剪。
- **ShareX**：v21.0.0 的 [工程文件](https://github.com/ShareX/ShareX/blob/v21.0.0/ShareX/ShareX.csproj) 声明 net9.0-windows10.0.22621.0 和同一 SupportedOSPlatformVersion（Windows 11 22H2 基线）；当前 develop 已使用 net10。不能按旧印象假定最新版对 Windows 10 目标无影响。采用旧版本或抽库需要重新核对平台承诺和维护成本。
- **ksnip**：当前 README 明确招募共同维护者，最新正式版仍为 v1.10.1（2023-03-15），但仓库和 continuous 构建仍有更新。应区分维护资源、开发分支和正式版，不能简单说项目已停更。

## 4. 嵌入方式与现有代码如何取舍

| 路线 | 能节省的工作 | 仍需完成的工作 | 适用性 |
| --- | --- | --- | --- |
| 内置标注库 | 图元/编辑/撤销/参数等复杂逻辑 | 捕获选区、工具栏适配、贴图状态、热键与宿主交付 | 当前最容易控制范围 |
| 将整套应用裁成自有 helper | 截图、工具栏和部分贴图流程一起复用 | 移除托盘/独立热键/更新器等产品壳；加 IPC；隔离配置/实例；维护 fork | Snow Shot / Flameshot / ScreenPinKit 可做验证 |
| 附带未修改 EXE，通过 CLI 调用 | 最快形成截图启动演示 | 完成/取消结果关联、图片交付、贴图管理、同生共死和单实例控制通常仍欠缺 | 不作为当前最终设计首选 |
| 抽取 Web 模块到现有 Electron | 不新增第二套 Electron；复用 Fabric 等生态 | 原生捕获适配、窗口、IPC、安全边界、DPI和输入法验证 | 不坚持 Qt 时比较 eSearch |
| 只照着交互自行写 | 依赖少，外观控制自由 | 原有编辑器复杂度基本全部保留 | 用于小交互，不适合继续从零写整个编辑内核 |

现有代码值得保留的部分：

- CaptureHost 与 Windows Job Object 启动/回收边界；
- CaptureCoordinator 的会话、快捷键、取消与业务交付；
- 图片文件校验、资源所有权及 ACK；
- 便签附件和背景图片入口、快捷键设置、错误提示。

需要重新评估或替换的部分：

- ImageDocument 当前简单 stroke/redoStack；
- CaptureOverlay 的绘图状态与工具条；
- PinWindow 的不可变图片显示模型。

第三方 helper 应使用自己的实例标识和数据目录，不接管用户独立安装的同名软件。完整退出由现有 Job Object 保证进程树回收，内部窗口与会话也要正常清理。仅给启动器套 Job 并不能回收已存在的外部单实例进程。

IPC 至少要保留请求 ID、ready、完成/取消/失败、输出目标和 ACK；不能通过监控全局剪贴板猜测“这是本次截图完成”。

## 5. 许可证与维护边界

本项目 package.json 当前是 GPL-3.0-only，这使 GPLv3 系项目的源码复用有可行基础，但不是省略归属、依赖许可和对应源码的理由。

| 项目 | 本轮核对的许可 | 集成时的实际含义 |
| --- | --- | --- |
| kImageAnnotator / kColorPicker | 根 LICENSE 为 LGPLv3；部分源文件有 earlier-or-later 历史声明 | 保留逐文件声明，核对所选版本；Windows 静态链接应准备可重建/重链接所需材料或适用 GPL 路径，不能按“动态 Qt”推断此库也是动态 |
| Flameshot | GPLv3；所查文件 SPDX 为 GPL-3.0-or-later | 修改分发须提供对应源码、构建说明和声明 |
| ksnip / ShareX / eSearch / Greenshot | 根许可文本均为 GPLv3；文件声明与依赖分别核对 | 当前 GPLv3 项目可以评估整合；未来若要闭源应重新评估，不能因为独立进程就自动认定没有义务 |
| ScreenPinKit | 自身 MIT | MIT 不替代 PyQt5、PyQt-Fluent-Widgets 等依赖许可；已核对后者根 LICENSE 为 GPLv3 |
| Snow Apps | [按目录多许可](https://github.com/mg-chao/snow-apps/blob/89a13ef983047717c82757b8c4d8ce9dce9d8186/LICENSE.md)：snow_shot 为 GPL-3.0-or-later，snow_draw_engine_qt / snow-crates / snow_rust_ffi / ant_design_qt 原创部分为 Apache-2.0 | 抽引擎与抽整应用的范围不同；共同构建文件和第三方材料另有范围规则，不能把整个仓库当 Apache-2.0 |

GPL 允许商业使用，不等于只能免费发布。更具体的发行义务取决于实际采用的代码、链接与交付方式；选定并裁剪后应生成精确第三方清单。图标、字体、表情等资源也需核对许可，开源代码许可不自动授权沿用原项目品牌。

## 6. 选型验证方法：先验证高风险交互，再决定替换

建议下一轮只做候选可行性验证，不立即重写全部截图模块。先验证 kImageAnnotator 的轻量组件路线；若更看重尽量保留完整截图/贴图交互，则优先切换到 Snow Shot 的裁剪验证。Flameshot 保留为截图浮层备选，不同时拼入多个编辑内核。

| 验证组 | 方法与通过条件 |
| --- | --- |
| V1 可构建与依赖 | 固定上游 commit，使用实际 Qt/MSVC 构建；列出新增 DLL/插件、运行时与发行许可。Snow Shot 单独测绘图库和应用裁剪，确认是否必须升级 Qt。不能用 README 的 build 成功描述替代本机结果 |
| V2 连续截图标注 | 合成测试桌面上完成框选→工具选中→改颜色/宽度→绘图→修改→撤销重做→复制/保存。检查状态反馈及最终像素；覆盖双击、中键、空格、Shift 约束、方向键语义 |
| V3 文字与弹窗焦点 | 中文输入法、多行、字号修改、拖动、右键结束、Esc、Alt+F4；工具参数弹窗关闭后文字与对象不丢失、不误提交 |
| V4 截图转贴图 | 输出后继续标注、保存/复制；明确旧对象是否保持可编辑。贴图移动和编辑不冲突，Ctrl＋滚轮只改透明度，重置动作同时恢复约定的大小/透明度 |
| V5 窗口边界 | 小选区、四个屏幕角、100%/150%/200% 混合 DPI、负坐标副屏；工具条完整可见，选区/标注/输出像素对齐 |
| V6 宿主交付 | 截图分别送入便签与背景；快速取消/再次截图、迟到消息、失败重试不得串到另一业务请求 |
| V7 生命周期和隔离 | 便签隐藏后可用；完整退出/主进程异常退出后 helper、贴图和快捷键消失；同时运行用户原版候选软件时互不影响；不启动自己的独立更新/托盘/登录流程 |
| V8 成本实测 | 同一张大图、同样贴图数量，测首次截图耗时、重复唤起、拖动/编辑响应、峰值内存、包体增量和实际需要改动的上游模块。不先给节省比例或固定工期 |

取舍标准：候选只有在减少复杂交互代码、满足生命周期并通过真实连续操作后，才算降低成本。若为了套进现有方案需要大范围改写上游 GUI 或引入第二个编辑模型，应及时停止该路线。

## 7. 本轮版本快照与验证范围

读取了仓库元数据、README、许可、发布信息、构建文件，以及关键编辑/贴图源码。以下均为本轮查询时的默认分支提交；默认分支能力不一定已在正式发行版提供。

| 仓库 | 查询时源码 commit | 发布信息摘要 |
| --- | --- | --- |
| ksnip/kImageAnnotator | d184dbd77da385a7e2e9c7527f3a4184b0842cb4 | v0.7.2，2025-11-21 |
| ksnip/ksnip | 343925d24bb0031e636013773fd310e9c56315b9 | 正式 v1.10.1，2023-03-15；continuous 更新至 2026-09-07 |
| flameshot-org/flameshot | 2d478061ffeeba5919d3a3d9168f93542ea9b357 | 正式 v14.0.0，2026-06-19；另有 v15.0.rc1 |
| InterwovenCode/ScreenPinKit | b50c04436fe119c4c28894d7aa19b20e5b0b2fdf | v3.1，2025-05-11；源码之后仍有更新 |
| xushengfeng/eSearch | a86a0bcfcf7f2f7dad86aba67cd6871b89e0048b | 15.5.1，2026-09-13 |
| ShareX/ShareX | cf5a6fe57908452a38fc56ae924760a10f3d7173 | v21.0.0，2026-07-03；另核对该标签工程配置 |
| greenshot/greenshot | 2ec4003aa1e1dc66088cd16dbaa11b8342bb2ac6 | 最近返回 v1.4.263-g2e6dd8ce0a 预览，2026-09-28；未据此认定最新正式版 |
| mg-chao/snow-apps | 89a13ef983047717c82757b8c4d8ce9dce9d8186 | v1.1.6-beta，2026-09-28 |

本轮没有执行候选构建、产品单元测试、真实窗口专项或全量回归；没有测量性能、包体，也没有进行候选与 Snipaste 的实机并排操作。未覆盖的关键风险包括 Qt6/MSVC 兼容、Win10/Win11 分别运行、混合 DPI、输入法、窗口焦点、跨进程输出及 fork 升级维护。本文是选型依据，不是集成完成或功能验收结论。
