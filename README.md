<div align="center">

<img src="resources/icon.png" width="128" alt="Abandon便签图标" />

# Abandon便签（Abandon Note）

**一款简洁、可靠的 Windows 桌面便签应用**

[![Release](https://img.shields.io/github/v/release/feimingabandon/abandon_note2?label=%E7%89%88%E6%9C%AC)](https://github.com/feimingabandon/abandon_note2/releases)
[![CI](https://github.com/feimingabandon/abandon_note2/actions/workflows/ci.yml/badge.svg)](https://github.com/feimingabandon/abandon_note2/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-lightgrey)

支持 Windows 10 / 11（x64）

</div>

---

## 写在前言

2025 年，是一切罪恶的开始。

作者正处于失业的煎熬中，本想找个免费的便签，写点规划。谁能想到，如此简单的应用居然也能收费。于是作者一怒之下，决定自己写一个。

就这样，Abandon 便签 0.0.1 版本问世了。

过程是坎坷的，结果是稀碎的。

第一次正儿八经开发软件，作者才发现需要处理的问题远比想象中多。多屏幕、多尺寸、多缩放……一个个始料未及的问题扑面而来，以至于最初的它看上去更像一个玩具，还是一碰就碎的那种。

但是，冥冥之中似乎总有一种力量推着我继续前行。

虽然软件稀碎，可自从发布到小红书以后，却得到了很多人的喜欢。即使到了 2026 年，仍然时常有人点赞、收藏，也有很多同学认真地向我提出建议。

坦白讲，我受之有愧。

从初版问世开始，我就一直琢磨着要重构它。但懒惰与拖延的诱惑，换来了一次又一次的延期。也正因如此，很长一段时间里，我甚至不敢打开小红书，不敢面对你们的点赞和收藏。

但是没招，小红书的消息总会在不经意间出现在我的通知列表中。每一次推送，每一个点赞、收藏和评论，都像是一种特别的催稿。

人总会给自己附加上一些奇怪的使命感，仿佛自己就站在道德高地上，居高临下地怒斥这个不公、那个不对。对不对先不说，但确实挺中二的。

这么看我好歹也整上一句：

当我敲下第一行属于 Abandon 便签的代码时，我便知道——它会是这个赛道的天下第一。

过程自然不会一帆风顺，但不必多言。

我只想让你知道：

别的软件有的，它也有。

别的软件没有的，它还有。

什么月视图、周视图、列表、标签分组、循环模板便签，都是基础。

它最大的优点，是 UI，也是交互。

Windows 10 和 Windows 11 支持原生毛玻璃，可以自由调节毛玻璃样式。你喜欢的样子，它都有。

支持贴边隐藏，就像 QQ 那样。如果你担心误触，还可以开启贴边隐藏小黑条。

支持丰富的样式设置。设置页面，值得你亲自探索。

支持丰富的交互动画。让每一次点击都尽量赏心悦目。

默认采用苹果式 UI 风格，也可以切换标题栏样式。

简约不等于简单，美好应该恰如其分。

永久免费，始终开源。

当然，作者肯定也喜欢钱。只不过比起钱，更喜欢它真的被大家使用、分享和推荐。

你的推荐，我求之不得。

Abandon便签，等你来探索...

## ☕ 赞赏支持

如果 Abandon便签恰好帮到了你，可以请作者喝杯咖啡。金额不重要，0.01 也是对作者最大的肯定。

|                                                  微信赞赏                                                   |                                                    支付宝                                                     |
| :---------------------------------------------------------------------------------------------------------: | :-----------------------------------------------------------------------------------------------------------: |
| <img src="src/renderer/src/resources/help/wechat-appreciation-qr.png" width="260" alt="小邹的微信赞赏码" /> | <img src="src/renderer/src/resources/help/alipay-appreciation-qr.jpg" width="260" alt="小邹的支付宝收款码" /> |

> 赞赏完全自愿，不会解锁任何隐藏功能。不赞赏，也依然可以完整地使用 Abandon便签。

## 📖 项目介绍

Abandon便签（Abandon Note）是一款永久免费开源、以本地存储为核心的 Windows 桌面便签应用，目前支持 Windows 10 / 11。

- **三种主视图** — 通过便签列表集中整理内容，也可以在月视图和周视图中按日期安排与回顾。
- **桌面原生体验** — 支持桌面便利贴、贴边隐藏、系统提醒与 Windows 原生毛玻璃。
- **本地优先** — 便签、标签、循环模板、图片附件和壁纸保存在当前设备中，不要求登录账号，也不提供云同步。
- **持续开放** — 项目基于 GPL-3.0-only 许可证开放源码，并持续完善功能、交互与 Windows 使用体验。

如果你有想法、建议或使用反馈，欢迎提交 Issue，或发送邮件至：1160653906@qq.com。

## ✨ 功能特性

- 📝 **便签管理** — 创建、编辑、标签分类、置顶，按时间线分组浏览
- 🗓 **月历与周历** — 在月视图、周视图中查看和管理便签，支持农历、节气、节日及法定休班标记
- 🌤 **天气预报** — 在日历中展示天气图标与高低温，支持手动选择地区或按需使用设备位置
- 🔁 **循环便签** — 基于模板的周期性便签，由统一调度器自动生成，到点提醒
- 📌 **桌面便利贴** — 将便签钉在桌面，随时查看，支持多张同时展示
- 🫥 **贴边隐藏** — 窗口拖到屏幕边缘自动收起，鼠标移入触发区即滑出
- 🌫 **原生毛玻璃** — Windows 下通过 Windows.UI.Composition 实现系统级模糊背景
- 🖼 **图片与截图** — 支持粘贴图片附件、配置便签壁纸
- 🔔 **提醒通知** — 到期提醒走系统原生通知，附带应用内降级兜底
- 📄 **日报导出** — 按日期和状态筛选便签，预览后导出为 TXT 文件
- 📖 **帮助中心** — 内置图解式使用说明，覆盖便签、日历、便利贴和设置等主要功能
- 🔄 **更新检查** — GitCode / GitHub 双源检查公开版本，可通过浏览器直接下载 GitCode 安装包，也可进入两个平台的对应版本页面手动下载
- 💾 **本地存储** — 便签数据保存在本地 SQLite 数据库，核心便签功能无需联网

## 🖥 应用界面

**主界面** — 毛玻璃背景下的便签列表，支持置顶分组与时间线浏览

![主界面](docs/screenshots/main-window.png)

**标签分组列表** — 以标签分组整理便签，列表、月视图和周视图可随时切换

<div align="center">
  <img src="docs/screenshots/note-list-view.png" width="420" alt="标签分组便签列表" />
</div>

|                       月视图                        |                       周视图                       |
| :-------------------------------------------------: | :------------------------------------------------: |
| ![月视图](docs/screenshots/calendar-month-view.png) | ![周视图](docs/screenshots/calendar-week-view.png) |

**桌面便利贴** — 便签钉在桌面随时查看，支持调整字号、颜色与置顶

![桌面便利贴](docs/screenshots/sticky-note.png)

**贴边隐藏** — 窗口拖到屏幕边缘自动收起，鼠标移入触发区即滑出

![贴边隐藏演示](docs/screenshots/dock-hide.gif)

|                       新建便签                       |                         循环便签模板                          |
| :--------------------------------------------------: | :-----------------------------------------------------------: |
| ![新建便签面板](docs/screenshots/new-note-panel.png) | ![循环便签模板设置](docs/screenshots/recurring-templates.png) |

|                    时间线模式                     |                       更新检查                        |
| :-----------------------------------------------: | :---------------------------------------------------: |
| ![时间线模式](docs/screenshots/timeline-mode.png) | ![更新检查对话框](docs/screenshots/update-dialog.png) |

|                     基础样式设置                     |                     毛玻璃与壁纸设置                     |
| :--------------------------------------------------: | :------------------------------------------------------: |
| ![基础样式设置](docs/screenshots/settings-basic.png) | ![毛玻璃与壁纸设置](docs/screenshots/settings-glass.png) |

## 💽 下载安装

从以下任一官方渠道下载最新版安装包：

- [GitCode Releases（国内推荐）](https://gitcode.com/zou-feiming/abandon_note2/releases)
- [GitHub Releases（备用渠道）](https://github.com/feimingabandon/abandon_note2/releases)

### 系统要求

- Windows 10 / 11（x64）
- 当前仅提供正式 Windows 安装包，暂不提供 macOS 安装包，也不支持 Windows 7

### Windows

下载 `Abandon-Note-x.y.z-windows-x64-setup.exe`，双击运行并按提示选择安装目录。升级时可直接覆盖安装，通常不会影响已有便签；卸载程序默认也不会删除应用数据。重要资料仍建议额外备份。

> 当前安装包尚未进行数字签名，Windows 可能显示 Microsoft Defender SmartScreen 或“未知发布者”提示。请只从上方官方发布页获取安装包，并在确认发布来源无误后安装。

> 应用会检查最新公开版本。升级可直接打开下载；同版本重新下载会先确认，远程公开版本低于当前版本时会明确标记为降级并要求危险确认。下载和安装始终由浏览器与用户完成。

## 🔐 数据、隐私与联网

- 便签正文、标签、循环模板内容、图片附件和壁纸始终保存在当前设备中；应用不提供账号和云同步，也不会通过远程服务上传这些内容。
- 首次启动会发送一次匿名基础设备统计，用于估算实际启动的安装数量；这不是纯下载量，下载后从未启动的安装不会被统计。
- “接收软件通知”和“后续设备统计”默认开启，可在“设置 → 远程服务与隐私”中分别关闭。修改后的选择从下次启动起停止对应的后续请求，不会撤回首次启动已经发送的统计。
- 设备信息仅包含安装标识、应用版本、系统版本与架构、CPU、GPU、内存、语言和启动/退出时间，用于了解基础使用情况。
- 天气、更新检查、软件通知和设备信息检测需要访问网络；天气位置可手动选择，仅在用户主动选择“使用设备位置”时请求定位并将坐标转换为地区名称。

重要内容不要只保存一份。遇到问题时，可以在设置中查看或导出运行日志，并通过 Issue 或邮件反馈。

## ⌨️ 本地开发

### 环境要求

- Node.js 22（项目使用 [Volta](https://volta.sh/) 锁定版本）
- Windows 下编译原生毛玻璃模块需要 Visual Studio C++ 构建工具与 CMake

### 克隆与安装依赖

```bash
git clone https://github.com/feimingabandon/abandon_note2.git
cd abandon_note2
npm ci
```

### 开发模式

```bash
npm run dev
```

### 测试与检查

```bash
npm run lint       # ESLint 检查
npm test           # Vitest 单元测试 + Electron 集成测试
npm run build      # 完整生产构建
git diff --check   # 检查空白字符错误
```

界面、主题和组件样式改动请遵守 [UI 材质与边线开发标准](docs/UI_DESIGN_STANDARD.md)。

### 构建打包

```bash
npm run build:unpack:win # Windows：生成未封装目录，便于本地运行验证
npm run build:win        # Windows：先编译原生毛玻璃模块，再打 NSIS x64 安装包
```

## 🛠 技术栈

| 层       | 技术                                                                           |
| -------- | ------------------------------------------------------------------------------ |
| 桌面框架 | [Electron](https://www.electronjs.org/) 43                                     |
| 前端     | [Vue 3](https://vuejs.org/) + [electron-vite](https://electron-vite.org/)      |
| 数据存储 | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)（本地 SQLite）    |
| 日历数据 | [chinese-days](https://github.com/vsme/chinese-days)（农历、节气与中国节假日） |
| 天气服务 | [Open-Meteo](https://open-meteo.com/)（预报与地理编码 API）                    |
| 原生能力 | C++（Windows.UI.Composition 毛玻璃）+ [koffi](https://koffi.dev/) FFI 桥接     |
| 打包     | [electron-builder](https://www.electron.build/)                                |

## 💐 感谢与致谢

Abandon便签的天气、定位与日历能力离不开以下开源项目和开放 API，在此向它们的维护者与服务提供方表示感谢：

- [Open-Meteo](https://open-meteo.com/) — 提供天气预报与地理编码 API；中国地区优先使用其接入的 CMA GRAPES 预报模型。
- [BigDataCloud](https://www.bigdatacloud.com/) — 提供反向地理编码 API，仅在用户主动选择“使用设备位置”时用于将坐标转换为地区名称。
- [chinese-days](https://github.com/vsme/chinese-days) — 提供农历、二十四节气、中国法定节假日、调休与工作日数据。
- [@aurouscia/china-areas](https://gitee.com/au114514/au-npm-pkgs/tree/master/packages/china-areas) — 提供本地中国行政区划数据，用于手动选择天气地区。

### 测试与反馈

感谢所有参与测试、反馈问题并帮助改进 Abandon便签的朋友。

## 🤝 参与贡献

欢迎提交 [Issue](https://github.com/feimingabandon/abandon_note2/issues) 反馈问题或建议；提交 PR 前请确保 `npm run lint`、`npm test`、`npm run build` 与 `git diff --check` 通过。

## 📜 许可证

本项目基于 [GNU GPL v3](LICENSE)（`GPL-3.0-only`）开源。
