<div align="center">

<img src="resources/icon.png" width="128" alt="Abandon便签图标" />

# Abandon便签（Abandon Note）

**一款简洁、可靠的跨平台桌面便签应用**

[![Release](https://img.shields.io/github/v/release/feimingabandon/abandon_note2?label=%E7%89%88%E6%9C%AC)](https://github.com/feimingabandon/abandon_note2/releases)
[![CI](https://github.com/feimingabandon/abandon_note2/actions/workflows/ci.yml/badge.svg)](https://github.com/feimingabandon/abandon_note2/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)

支持 Windows 10 / 11 与 macOS

</div>

---

## 写在前言

从第一版便签问世，就一直想着使用新架构重新实现。兜兜转转终于是写出来了，新版唯一的缺点就是占用内存比第一版多，大概100~200MB，不过对于电脑而言也在可接受范围内。但带来的好处有很多，更精美的动画，交互。更容易实现的复杂功能。

由于win和mac都没购买签名，因此在下载和安装时会包异常，这个是正常的。win的好解决，但是mac复杂一点，具体可自行搜索解决方法。

现在属于内测阶段，正式版发布可能还需要一段时间，主要对UI，功能，bug进行修复和新增。如果有好的想法和建议可以发邮件：1160653906@qq.com



## ✨ 功能特性

- 📝 **便签管理** — 创建、编辑、标签分类、置顶，按时间线分组浏览
- 🔁 **循环便签** — 基于模板的周期性便签，由统一调度器自动生成，到点提醒
- 📌 **桌面便利贴** — 将便签钉在桌面，随时查看，支持多张同时展示
- 🫥 **贴边隐藏** — 窗口拖到屏幕边缘自动收起，鼠标移入触发区即滑出
- 🌫 **原生毛玻璃** — Windows 下通过 Windows.UI.Composition 实现系统级模糊背景
- 🖼 **图片与截图** — 支持粘贴图片附件、配置便签壁纸
- 🔔 **提醒通知** — 到期提醒走系统原生通知，附带应用内降级兜底
- 🔄 **更新检查** — GitHub / GitCode 双源检查新版本，前往发布页手动下载安装
- 💾 **本地存储** — 数据保存在本地 SQLite 数据库，不依赖网络

## 🖥 应用界面

**主界面** — 毛玻璃背景下的便签列表，支持置顶分组与时间线浏览

![主界面](docs/screenshots/main-window.png)

**桌面便利贴** — 便签钉在桌面随时查看，支持调整字号、颜色与置顶

![桌面便利贴](docs/screenshots/sticky-note.png)

**贴边隐藏** — 窗口拖到屏幕边缘自动收起，鼠标移入触发区即滑出

![贴边隐藏演示](docs/screenshots/dock-hide.gif)

| 新建便签 | 循环便签模板 |
| :---: | :---: |
| ![新建便签面板](docs/screenshots/new-note-panel.png) | ![循环便签模板设置](docs/screenshots/recurring-templates.png) |

| 时间线模式 | 更新检查 |
| :---: | :---: |
| ![时间线模式](docs/screenshots/timeline-mode.png) | ![更新检查对话框](docs/screenshots/update-dialog.png) |

| 基础样式设置 | 毛玻璃与壁纸设置 |
| :---: | :---: |
| ![基础样式设置](docs/screenshots/settings-basic.png) | ![毛玻璃与壁纸设置](docs/screenshots/settings-glass.png) |

## 💽 下载安装

从以下任一渠道下载最新版安装包：

- [GitHub Releases](https://github.com/feimingabandon/abandon_note2/releases)
- [GitCode Releases](https://gitcode.com/zou-feiming/abandon_note2/releases)

### Windows

下载 `Abandon-Note-x.y.z-windows-x64-setup.exe` 安装包，双击安装即可。

### macOS

按芯片架构选择对应的 `dmg` 安装包：

- Apple Silicon（M 系列芯片）：`Abandon-Note-x.y.z-macos-arm64.dmg`
- Intel 芯片：`Abandon-Note-x.y.z-macos-x64.dmg`

> 应用支持自动检查更新，检测到新版本后前往发布页下载安装包，覆盖安装即可升级。

## ⌨️ 本地开发

### 环境要求

- Node.js 22（项目使用 [Volta](https://volta.sh/) 锁定版本）
- Windows 下编译原生毛玻璃模块需要 Visual Studio C++ 构建工具与 CMake

### 克隆与安装依赖

```bash
git clone https://github.com/feimingabandon/abandon_note2.git
cd abandon_note2
npm install
```

### 开发模式

```bash
npm run dev
```

### 测试与检查

```bash
npm test        # vitest 单元测试 + Electron 集成测试
npm run lint    # eslint 检查
```

### 构建打包

```bash
npm run build:win        # Windows：先编译原生毛玻璃模块，再打 NSIS x64 安装包
npm run build:mac:x64    # macOS Intel
npm run build:mac:arm64  # macOS Apple Silicon
```

## 🛠 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | [Electron](https://www.electronjs.org/) 43 |
| 前端 | [Vue 3](https://vuejs.org/) + [electron-vite](https://electron-vite.org/) |
| 数据存储 | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)（本地 SQLite） |
| 原生能力 | C++（Windows.UI.Composition 毛玻璃）+ [koffi](https://koffi.dev/) FFI 桥接 |
| 打包 | [electron-builder](https://www.electron.build/) |

## 🤝 参与贡献

欢迎提交 [Issue](https://github.com/feimingabandon/abandon_note2/issues) 反馈问题或建议；提交 PR 前请确保 `npm run lint` 与 `npm test` 通过。

## 📜 许可证

本项目基于 [GNU GPL v3](LICENSE)（`GPL-3.0-only`）开源。
