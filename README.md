# Abandon Note 2 — 便签桌面应用

基于 **Electron + Vue 3** 的多窗口便签桌面应用，采用无边框透明窗口 + 毛玻璃效果，支持主窗口与灵动岛两种形态切换。

---

## 目录

- [技术栈](#技术栈)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [项目目录结构](#项目目录结构)
- [整体架构](#整体架构)
- [窗口系统](#窗口系统)
- [IPC 通信全表](#ipc-通信全表)
- [CSS 样式架构](#css-样式架构)
- [公共组件](#公共组件)
- [字号系统](#字号系统)
- [数据库设计](#数据库设计)
- [构建与打包](#构建与打包)
- [维护指南](#维护指南)

---

## 技术栈

| 类别 | 技术 | 版本 |
|------|------|------|
| 桌面框架 | Electron | 39.2.6 |
| 前端框架 | Vue 3（Composition API） | 3.5.25 |
| 构建工具 | Vite + electron-vite | 7.2.6 / 5.0.0 |
| 数据库 | SQLite（better-sqlite3） | 12.9.0 |
| 打包工具 | electron-builder | 26.0.12 |
| 工具库 | @electron-toolkit/utils, @electron-toolkit/preload | 4.0.0 / 3.0.2 |

---

## 环境要求

- **Node.js** >= 18（推荐 LTS）
- **npm**（随 Node.js 安装）
- **Windows / macOS / Linux**（跨平台支持）
- better-sqlite3 是 C++ 原生模块，安装时需要编译环境：
  - Windows：需要 `windows-build-tools` 或 Visual Studio Build Tools
  - macOS：需要 Xcode Command Line Tools
  - Linux：需要 `build-essential` / `python3`

---

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 启动开发模式（热重载）
npm run dev

# 3. 构建生产包
npm run build

# 4. 打包为可安装程序（Windows）
npm run build:win
```

> 注意：`npm run dev` 实际执行 `chcp 65001 && electron-vite dev`，`chcp 65001` 用于设置终端为 UTF-8 编码，避免中文乱码。

---

## 项目目录结构

```
abandon_note2/
├── src/
│   ├── main/                          # 主进程（Node.js 环境）
│   │   ├── index.js                   #   应用入口：窗口创建、IPC 注册、生命周期管理
│   │   └── db.js                      #   SQLite 数据库模块：建表、CRUD 操作
│   │
│   ├── preload/                       # Preload 脚本（主进程 ↔ 渲染进程桥梁）
│   │   └── index.js                   #   通过 contextBridge 暴露 window.api
│   │
│   └── renderer/                      # 渲染进程（浏览器环境，Vue 3 应用）
│       ├── index.html                 #   主窗口 HTML 入口
│       ├── settings.html              #   主设置窗口 HTML 入口
│       ├── island.html                #   灵动岛窗口 HTML 入口
│       ├── island-settings.html       #   灵动岛设置窗口 HTML 入口
│       │
│       └── src/
│           ├── main.js                #   主窗口 Vue 入口（createApp → App.vue）
│           ├── settings-main.js       #   主设置窗口 Vue 入口
│           ├── island-main.js         #   灵动岛窗口 Vue 入口
│           ├── island-settings-main.js#   灵动岛设置窗口 Vue 入口
│           │
│           ├── App.vue                #   主窗口组件
│           ├── views/
│           │   ├── SettingsApp.vue     #   主设置窗口组件
│           │   ├── IslandApp.vue       #   灵动岛窗口组件
│           │   └── IslandSettingsApp.vue # 灵动岛设置窗口组件
│           │
│           ├── components/            # 公共组件
│           │   ├── MacTitlebar.vue     #   苹果风格标题栏（红绿灯）
│           │   ├── WinTitlebar.vue     #   Windows 风格标题栏
│           │   └── ResizeHandles.vue   #   窗口缩放手柄（8 方向）
│           │
│           ├── composables/           # Vue Composable（可复用逻辑）
│           │   └── useFontSize.js     #   字号监听 / 编辑逻辑
│           │
│           ├── utils/                 # 纯工具函数
│           │   └── fontUtils.js       #   字号配置表 + clamp 生成 + 应用函数
│           │
│           └── assets/                # 静态资源 + 全局样式
│               ├── base.css           #   设计令牌 + CSS Reset + 复合样式
│               └── main.css           #   样式入口（@import base.css）
│
├── resources/                         # 应用资源
│   └── icon.png                       #   应用图标
│
├── electron.vite.config.mjs           # electron-vite 构建配置（多页面入口）
├── electron-builder.yml               # electron-builder 打包配置
└── package.json                       # 项目依赖与脚本
```

---

## 整体架构

本项目采用 Electron 标准三层架构，每一层职责分明：

```
┌─────────────────────────────────────────────────────────┐
│                    主进程 (Main Process)                  │
│  src/main/index.js + src/main/db.js                     │
│                                                         │
│  职责：                                                  │
│  · 创建和管理 4 个 BrowserWindow                          │
│  · 注册所有 IPC 通信处理器                                │
│  · 管理应用生命周期（启动、退出）                           │
│  · 通过 db.js 操作 SQLite 数据库                          │
│  · 获取屏幕信息、恢复窗口几何状态                           │
├─────────────────────────────────────────────────────────┤
│                  Preload 脚本 (Bridge)                   │
│  src/preload/index.js                                   │
│                                                         │
│  职责：                                                  │
│  · 通过 contextBridge 安全暴露 window.api                 │
│  · 每个 API 方法对应一个 IPC 通道                          │
│  · 四个窗口共用同一个 preload                              │
├─────────────────────────────────────────────────────────┤
│              渲染进程 (Renderer Process) × 4              │
│  src/renderer/                                          │
│                                                         │
│  职责：                                                  │
│  · 4 个独立 Vue 3 应用（各自 createApp）                   │
│  · 通过 window.api.xxx() 与主进程通信                      │
│  · 使用公共组件（MacTitlebar / WinTitlebar / ResizeHandles）│
│  · 使用 Composable 复用逻辑（useFontSize）                │
└─────────────────────────────────────────────────────────┘
```

### 关键设计决策

1. **多页面而非路由**：4 个窗口 = 4 个独立 HTML 入口 + 4 个独立 Vue 实例，互不干扰。在 `electron.vite.config.mjs` 中配置 `rollupOptions.input` 实现多页面打包。

2. **共用 preload**：所有窗口共用同一个 `preload/index.js`。主进程通过 `BrowserWindow.fromWebContents(event.sender)` 自动识别是哪个窗口发来的消息，无需每个窗口单独注册 IPC 通道。

3. **无边框透明窗口**：所有窗口 `frame: false` + `transparent: true`，原生标题栏和缩放边框失效，由自定义组件（MacTitlebar/WinTitlebar/ResizeHandles）替代。

---

## 窗口系统

### 四个窗口

| 窗口 | 文件 | HTML 入口 | 标题栏 | 默认尺寸 | 说明 |
|------|------|----------|--------|---------|------|
| 主窗口 | `App.vue` | `index.html` | MacTitlebar | 屏幕 30%×62% | 便签主界面，应用启动时自动打开 |
| 主设置 | `SettingsApp.vue` | `settings.html` | MacTitlebar | 屏幕 32%×46% | 主窗口的设置面板（子窗口） |
| 灵动岛 | `IslandApp.vue` | `island.html` | 无（自定义胶囊布局） | 屏幕 22%×15% | 灵动岛形态，紧凑模式 |
| 灵动岛设置 | `IslandSettingsApp.vue` | `island-settings.html` | WinTitlebar | 屏幕 28%×38% | 灵动岛的设置面板（子窗口） |

### 窗口切换流程

```
主窗口 ──── [⚙ 设置] ──→ 打开 主设置窗口（子窗口，非模态）
  │
  └──── [🏝️ 灵动岛] ──→ 关闭主窗口，打开灵动岛窗口

灵动岛 ──── [设置] ──→ 打开 灵动岛设置窗口（子窗口，非模态）
  │
  └──── [回到主窗口] ──→ 关闭灵动岛，打开主窗口
```

### 窗口通用行为

- **ready-to-show**：窗口渲染完成后才显示，避免白屏闪烁
- **外链拦截**：`window.open` / `target="_blank"` 自动交给系统浏览器
- **几何状态持久化**：resize/move 事件防抖 500ms 后写入 SQLite
- **多显示器恢复**：记录上次所在显示器 ID，显示器不在时只恢复宽高、位置居中

---

## IPC 通信全表

所有 IPC 通道均在 `preload/index.js` 中暴露为 `window.api.xxx()`，主进程在 `main/index.js` 中注册处理器。

| 渲染进程 API | IPC 通道 | 方向 | 说明 |
|-------------|---------|------|------|
| `closeWindow()` | `window-close` | send（单向） | 关闭当前窗口 |
| `minimizeWindow()` | `window-minimize` | send | 最小化当前窗口 |
| `maximizeWindow()` | `window-maximize` | send | 切换最大化/还原 |
| `getWindowBounds()` | `window-get-bounds` | invoke（双向） | 获取窗口矩形区域 `{x,y,width,height}` |
| `setWindowBounds(bounds)` | `window-set-bounds` | send | 设置窗口矩形区域（缩放用） |
| `openMainSettings()` | `open-main-settings` | send | 打开主设置窗口 |
| `switchToIsland()` | `open-island` | send | 切换到灵动岛 |
| `switchToMain()` | `open-main` | send | 切换回主窗口 |
| `openIslandSettings()` | `open-island-settings` | send | 打开灵动岛设置 |
| `setMainFontSize(size)` | `set-main-font-size` | send | 设置主窗口字号 |
| `setIslandFontSize(size)` | `set-island-font-size` | send | 设置灵动岛字号 |
| `onFontSizeChanged(cb)` | `font-size-changed` | 监听（主→渲） | 接收字号变更通知 |
| `getWindowStyle(type)` | `get-window-style` | invoke | 查询持久化样式配置 |

> **设计要点**：`send` = 单向（类似 POST，无返回值）；`invoke` = 双向（类似 GET，有返回值）。

---

## CSS 样式架构

### 四层设计

```
第 1 层  html { font-size: clamp(0.5px, calc(100vw / 500), 2.5px) }
         ↑ rem 响应式根字号，W=500 锚点

第 2 层  :root { --fs-body, --color-text-1, --radius-lg, ... }
         ↑ 设计令牌（Design Tokens），集中定义所有设计变量

第 3 层  *, *::before, *::after { box-sizing: border-box; margin: 0; ... }
         ↑ CSS Reset + body 默认样式 + 滚动条隐藏

第 4 层  .window-frame, .glass, .btn-primary, .card, .badge, .input, ...
         ↑ 复合样式（公共 UI 组件样式）
```

所有内容定义在 `base.css` 中，通过 `main.css` 的 `@import` 引入，四个窗口共享。

### rem 响应式机制

```css
html { font-size: clamp(0.5px, calc(100vw / 500), 2.5px); }
```

- 窗口 500px 宽时：`1rem = 1px`，设计稿 1:1 映射
- 窗口 1000px 宽时：`1rem = 2px`，所有元素放大 2 倍
- `clamp` 限制极端值，防止过小或过大

### 样式分层治理

- **公共样式**（base.css 中的复合样式类）：`.window-frame`、`.glass`、`.btn-primary` 等，所有窗口可用
- **私有样式**（各 `.vue` 文件 `<style scoped>`）：仅当前组件生效

### .window-frame — 窗口级公共样式

```css
.window-frame {
  position: relative;      /* 为 ResizeHandles 绝对定位提供参考 */
  display: flex;
  flex-direction: column;
  height: 100vh;
  border-radius: var(--radius-lg);
  overflow: hidden;
}
```

每个窗口的根元素都使用 `<div class="window-frame glass">`。

---

## 公共组件

### MacTitlebar.vue — 苹果风格标题栏

- **外观**：左侧红🔴黄🟡绿🟢三个 12px 小圆灯，hover 时三个灯同时显示图标（✕ − ＋）
- **Props**：`title`（String，可选）— 标题文字
- **Slots**：`default` — 右侧自定义操作区域（如设置按钮、灵动岛切换按钮）
- **拖拽**：整个标题栏 `-webkit-app-region: drag`，按钮和插槽 `no-drag`

```vue
<MacTitlebar title="便签">
  <button @click="openSettings">⚙ 设置</button>
</MacTitlebar>
```

### WinTitlebar.vue — Windows 风格标题栏

- **外观**：右侧矩形按钮 ─ □ ✕，关闭按钮 hover 变红（#e81123）
- **Props**：`title`（String，可选）
- **Slots**：`default` — 标题旁的自定义区域
- **拖拽**：同 MacTitlebar

```vue
<WinTitlebar title="灵动岛设置" />
```

### ResizeHandles.vue — 窗口缩放手柄

- **功能**：为无边框透明窗口提供自定义 8 方向缩放能力
- **Props**：`minWidth`（default: 200）、`minHeight`（default: 120）
- **原理**：8 个 6px 宽的绝对定位透明热区 + mousedown/mousemove/mouseup + IPC setBounds

```
nw ─── n ─── ne
│              │
w              e
│              │
sw ─── s ─── se
```

**核心流程**：
1. `mousedown` → 调用 `getWindowBounds()` 记录起始窗口位置和鼠标 `screenX/screenY`
2. `mousemove` → 计算鼠标偏移 dx/dy，根据方向算出新 bounds，调用 `setWindowBounds()`
3. `mouseup` → 移除监听器

> 使用 `screenX/screenY`（屏幕绝对坐标）而非 `clientX/clientY`，避免窗口移动导致坐标跳动。

---

## 字号系统

### 整体数据流

```
设置窗口（滑动条调整字号）
    ↓ IPC: set-main-font-size / set-island-font-size
主进程
    ├→ 转发给目标窗口渲染进程（font-size-changed）
    └→ 持久化到 SQLite（window_styles 表）

目标窗口（接收字号变更）
    └→ applyFontSize(size) → 遍历 7 档字体 → 写入 CSS 变量
```

### 三层架构

| 层 | 文件 | 职责 |
|----|------|------|
| 工具层 | `utils/fontUtils.js` | 7 档字体配置表（FONT_CONFIG）、clamp 表达式生成、applyFontSize() |
| Composable 层 | `composables/useFontSize.js` | `useFontSizeListener()`（目标窗口用）、`useFontSizeEditor()`（设置窗口用） |
| 组件层 | 各 `.vue` 文件 | 调用 Composable，绑定 UI |

### 7 档字体配置

| 层级 | CSS 变量 | 比例 | 最小 px | 最大 px | 用途 |
|------|---------|------|--------|--------|------|
| Display | `--fs-display` | 3.29× | 20 | 96 | 超大标题/Hero |
| H1 | `--fs-h1` | 2.35× | 16 | 72 | 一级标题 |
| H2 | `--fs-h2` | 1.65× | 13 | 52 | 二级标题 |
| H3 | `--fs-h3` | 1.24× | 11 | 42 | 三级标题 |
| Body | `--fs-body` | 1.0× | 11 | 40 | 正文（基准） |
| Caption | `--fs-caption` | 0.82× | 9 | 34 | 辅助文字 |
| Micro | `--fs-micro` | 0.71× | 8 | 28 | 极小文字 |

字号范围：10 ~ 36，默认值 17（Apple 17px 正文锚点）。

---

## 数据库设计

使用 **better-sqlite3**（同步驱动），数据库文件存放在用户数据目录（`app.getPath('userData')/app.db`）。

### 表 1：window_styles — 窗口样式配置

键值对设计，方便扩展新样式属性。

| 字段 | 类型 | 说明 |
|------|------|------|
| window_type | TEXT | 窗口类型：`main` / `island` |
| key | TEXT | 样式属性名：`font_size` 等 |
| value | TEXT | 样式属性值 |
| updated_at | INTEGER | 更新时间戳（ms） |

> 复合主键：`(window_type, key)`

### 表 2：window_geometry — 窗口几何状态

列式设计，每个窗口一行。

| 字段 | 类型 | 说明 |
|------|------|------|
| window_type | TEXT (PK) | 窗口标识：`main` / `island` / `main_settings` / `island_settings` |
| width | INTEGER | 宽度 (px) |
| height | INTEGER | 高度 (px) |
| pos_x | INTEGER | 左上角 X 坐标 |
| pos_y | INTEGER | 左上角 Y 坐标 |
| is_maximized | INTEGER | 是否最大化（0/1） |
| display_id | TEXT | 所在显示器 ID |
| updated_at | INTEGER | 更新时间戳（ms） |

### 表 3：app_settings — 全局应用配置

键值对设计，与具体窗口无关。

| 字段 | 类型 | 说明 |
|------|------|------|
| key | TEXT (PK) | 配置键名 |
| value | TEXT | 配置值 |
| updated_at | INTEGER | 更新时间戳（ms） |

### 导出函数

```
initDatabase()                              → 初始化连接 + 建表
closeDatabase()                             → 关闭连接
getWindowStyle(windowType, key)             → 读取单个样式
getAllWindowStyles(windowType)               → 读取全部样式
setWindowStyle(windowType, key, value)      → 写入/更新样式
getWindowGeometry(windowType)               → 读取窗口几何
saveWindowGeometry(windowType, bounds, opt) → 保存窗口几何
getAppSetting(key)                          → 读取全局配置
setAppSetting(key, value)                   → 写入/更新全局配置
```

---

## 构建与打包

### 脚本说明

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发服务器（Vite HMR + Electron） |
| `npm run build` | 构建生产版本到 `out/` 目录 |
| `npm run build:win` | 构建 + 打包 Windows 安装包（NSIS） |
| `npm run build:mac` | 构建 + 打包 macOS（DMG） |
| `npm run build:linux` | 构建 + 打包 Linux（AppImage/snap/deb） |
| `npm run start` | 预览生产构建（electron-vite preview） |

### electron-builder 配置

- **appId**: `com.electron.app`
- **productName**: `abandon_note2`
- **NSIS 安装器**：自动创建桌面快捷方式
- **Electron 镜像**：使用 `npmmirror.com` 国内镜像加速下载

---

## 维护指南

### 新增窗口

1. 在 `src/renderer/` 下新建 `xxx.html` + `src/xxx-main.js` + 对应 `.vue` 文件
2. 在 `electron.vite.config.mjs` 的 `rollupOptions.input` 中添加新入口
3. 在 `src/main/index.js` 中添加 `createXxxWindow()` 函数和对应 IPC
4. 在 `src/preload/index.js` 中添加新的 API 方法（如需要）

### 新增 IPC 通道

1. `preload/index.js` — 在 `api` 对象中添加新方法
2. `main/index.js` — 用 `ipcMain.on()`（单向）或 `ipcMain.handle()`（双向）注册处理器

### 新增公共组件

放在 `src/renderer/src/components/` 目录下，使用 `<style scoped>` 避免样式污染。

### 新增设计令牌

在 `base.css` 的 `:root` 块中添加新的 CSS 变量，遵循现有的命名前缀规范：
- 字号：`--fs-xxx`
- 字重：`--fw-xxx`
- 颜色：`--color-xxx`
- 间距：`--sp-xxx`
- 圆角：`--radius-xxx`
- 层级：`--z-xxx`

### 新增数据库表/字段

在 `src/main/db.js` 的 `initDatabase()` 中添加 `CREATE TABLE IF NOT EXISTS` 语句，并导出对应的 CRUD 函数。

### 调试技巧

- 开发模式下 **F12** 打开 DevTools，**Ctrl+R** 刷新窗口
- 主进程日志输出在终端（启动 `npm run dev` 的终端）
- 数据库文件位置：`%APPDATA%/abandon_note2/app.db`（Windows）
