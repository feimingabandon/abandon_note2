# Abandon Note — 完整项目规格文档

> 本文档是 Abandon Note 桌面便签应用的完整技术规格说明，基于 Electron + Vue 3 的原始实现编写。
> 目标：为使用 **PyQt6** 重构提供完整的架构、功能、交互和视觉参考。

---

## 1. 项目概述

Abandon Note 是一款桌面便签应用，核心追求是**极致的视觉质感与交互体验**。

**关键特征：**
- 无边框 + 透明背景的自定义窗口外观
- 系统级毛玻璃（Frosted Glass）效果支持
- macOS 风格的自定义标题栏（红绿灯按钮）
- 八方向自定义缩放手柄
- 贴边自动吸附与滑出隐藏功能
- 系统托盘常驻运行
- 所有用户设置持久化到 SQLite 数据库
- Apple Design System 启发的视觉语言

---

## 2. 原始技术栈（参考）

| 层级 | 技术 | 职责 |
|------|------|------|
| 桌面框架 | Electron ^39.2.6 | 窗口管理、系统托盘、IPC 通信 |
| 构建工具 | electron-vite ^5.0.0 | 主进程/preload/渲染进程三路 Vite 构建 |
| 前端框架 | Vue 3 ^3.5.25 | 渲染进程 UI，Composition API |
| 数据库 | better-sqlite3 ^12.9.0 | SQLite 同步驱动，WAL 模式 |
| 毛玻璃 | mica-electron ^1.5.17 | Windows DWM Acrylic 原生模块 |
| 打包 | electron-builder ^26.0.12 | 跨平台安装包 |
| 字体 | @zf-web-font/opposans | OPPO Sans WebFont |

---

## 3. 架构设计

### 3.1 三进程模型

```
┌──────────────────────────────────────────────────────────────┐
│                       主进程 (Main Process)                    │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐    │
│  │ 窗口管理     │  │ 贴边隐藏引擎  │  │ 系统托盘          │    │
│  └─────────────┘  └──────────────┘  └──────────────────┘    │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐    │
│  │ IPC 路由     │  │ SQLite (db)  │  │ 毛玻璃效果控制    │    │
│  └─────────────┘  └──────────────┘  └──────────────────┘    │
└───────────────────────────┬──────────────────────────────────┘
                            │  IPC 通信
┌───────────────────────────▼──────────────────────────────────┐
│                    预加载脚本 (Preload Script)                  │
│          contextBridge 安全暴露 window.api 业务接口             │
└───────────────────────────┬──────────────────────────────────┘
                            │  window.api.*
┌───────────────────────────▼──────────────────────────────────┐
│                    渲染进程 (Renderer Process)                  │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ App.vue   │  │ MacTitlebar  │  │ ResizeHandles        │   │
│  └──────────┘  └──────────────┘  └──────────────────────┘   │
│  ┌──────────────┐                                            │
│  │ SettingsPanel │                                            │
│  └──────────────┘                                            │
└──────────────────────────────────────────────────────────────┘
```

**PyQt6 对应方案：** PyQt6 是单进程架构，主窗口和 UI 均在同一进程。原 Electron 的 IPC 通信可替换为直接的 Python 方法调用和 Qt 信号/槽机制。渲染进程（Web UI）可替换为 Qt Widget 或 QML。

### 3.2 模块职责划分

| 模块 | 文件 | 职责 |
|------|------|------|
| 主进程入口 | `src/main/index.js` | 窗口创建、IPC 注册、贴边隐藏、系统托盘、生命周期管理 |
| 数据库 | `src/main/db.js` | SQLite CRUD、几何持久化 |
| 预加载 | `src/preload/index.js` | contextBridge 安全暴露 API |
| 渲染入口 | `src/renderer/src/main.js` | Vue 应用创建、全局样式导入 |
| 根组件 | `src/renderer/src/App.vue` | 设置加载、玻璃态样式、鼠标悬停检测 |
| 标题栏 | `src/renderer/src/components/MacTitlebar.vue` | 红绿灯按钮、拖拽移动、标题显示 |
| 缩放手柄 | `src/renderer/src/components/ResizeHandles.vue` | 八方向透明拖拽区域 |
| 设置面板 | `src/renderer/src/components/SettingsPanel.vue` | 底部弹出式设置、实时预览、防抖持久化 |
| 全局样式 | `src/renderer/src/assets/tokens.css` | CSS Reset + 变量 + 根字号 + 玻璃态背景 |

---

## 4. 功能详细规格

### 4.1 窗口系统

#### 4.1.1 窗口创建参数

| 参数 | 值 | 说明 |
|------|----|------|
| `frame` | `false` | 无边框窗口，完全自定义外观 |
| `transparent` | `true`（默认模式）/ `false`（毛玻璃模式） | 透明背景，与毛玻璃互斥 |
| `autoHideMenuBar` | `true` | 自动隐藏菜单栏 |
| `show` | `false` | 创建时不显示，等渲染就绪后再 show |
| `sandbox` | `false` | preload 需要 Node API |

#### 4.1.2 默认窗口尺寸

- **宽度**：主显示器工作区宽度 × 25%（`Math.round(screenW * 0.25)`）
- **高度**：主显示器工作区高度 × 90%（`Math.round(screenH * 0.9)`）
- **X 位置**：`(screenH - defaultH) / 2`（与上边距一致，视觉协调）
- **Y 位置**：`(screenH - defaultH) / 2`（垂直居中）
- **最小尺寸**：200 × 200 px

#### 4.1.3 DPI 固定

- 调用 `setZoomFactor(1.0)` 锁定缩放因子，防止系统 DPI 影响布局

#### 4.1.4 几何持久化

- 窗口 `resize` 和 `move` 事件触发**防抖保存**（500ms 延迟）
- 保存四个值：`pos_x`、`pos_y`、`width`、`height`
- 存储位置：SQLite `app_settings` 表，`type = 'geometry'`
- 启动时优先读取数据库恢复位置，无记录则使用默认值
- 所有像素值 `Math.round()` 取整，避免亚像素问题

#### 4.1.5 窗口关闭行为

- 点击关闭按钮 **不退出应用**，而是 `hide()` 隐藏窗口（最小化到托盘）
- 隐藏时重置贴边状态（`dockSide = null`、`isDockHidden = false`、销毁触发窗口）
- 使用 `isQuitting` 标志位区分「用户关闭」和「真正退出」

### 4.2 Mac 风格标题栏

#### 4.2.1 红绿灯按钮

| 按钮 | 默认颜色 | 悬停颜色 | 功能 |
|------|---------|---------|------|
| 关闭（红） | `#ff5f57` | `#ff4136` | 隐藏窗口到托盘 |
| 最小化（黄） | `#febc2e` | `#f5a623` | 最小化窗口 |
| 最大化（绿） | `#28c840` | `#1db954` | 切换最大化/还原 |

- **按钮尺寸**：24rem × 24rem（响应式 rem，随窗口宽度缩放）
- **形状**：圆形（`border-radius: 50%`）
- **按钮间距**：8px
- **图标行为**：默认隐藏，鼠标悬停在按钮组上时显示图标（模拟 macOS 行为）
- **图标大小**：24rem × 24rem

#### 4.2.2 拖拽移动

- 整个标题栏区域设置 `-webkit-app-region: drag`，支持拖拽移动窗口
- 红绿灯按钮和右侧操作按钮设置 `no-drag`，确保可点击

#### 4.2.3 标题栏布局

```
[● ● ●]   [标题文字]   [设置] [帮助]
 红绿灯     flex:1       操作按钮
```

- **内边距**：12px 16px
- **子元素间距**：8px
- **标题字号**：24rem，字重 600
- **标题颜色**：`var(--text-color)`

#### 4.2.4 右侧操作按钮

- **设置按钮**：蓝色圆形（`#0071e3`），24rem × 24rem，点击打开设置面板
- **帮助按钮**：同上样式
- **图标**：18rem × 18rem，默认隐藏，悬停按钮组时显示
- **按钮间距**：8px

### 4.3 八方向缩放手柄

#### 4.3.1 实现原理

由于 `frame: false` 导致系统原生缩放失效，在窗口四边四角放置透明拖拽区域：

| 手柄 | 位置 | 尺寸 | 光标 |
|------|------|------|------|
| n（上） | 顶部条形 | 高 5px，左右各留 6px | `ns-resize` |
| s（下） | 底部条形 | 高 5px，左右各留 6px | `ns-resize` |
| w（左） | 左侧条形 | 宽 5px，上下各留 6px | `ew-resize` |
| e（右） | 右侧条形 | 宽 5px，上下各留 6px | `ew-resize` |
| nw（左上） | 左上角 | 8×8px | `nwse-resize` |
| ne（右上） | 右上角 | 8×8px | `nesw-resize` |
| sw（左下） | 左下角 | 8×8px | `nesw-resize` |
| se（右下） | 右下角 | 8×8px | `nwse-resize` |

- **容器**：`position: absolute; inset: 0; pointer-events: none; z-index: 9999`
- **手柄**：`pointer-events: auto`，仅手柄区域响应鼠标
- **最小尺寸限制**：宽 ≥ 200px，高 ≥ 200px

#### 4.3.2 缩放算法

```
1. mousedown → 获取当前窗口 bounds，记录起始鼠标坐标 (startX, startY)
2. mousemove → 计算偏移量 dx = screenX - startX, dy = screenY - startY
3. 根据方向计算新 bounds：
   - e: width = max(200, width + dx)
   - s: height = max(200, height + dy)
   - w: newW = max(200, width - dx); x = x + (width - newW); width = newW
   - n: newH = max(200, height - dy); y = y + (height - newH); height = newH
4. 调用 setWindowBounds(newBounds)
5. mouseup → 移除事件监听
```

### 4.4 贴边隐藏系统

这是本项目最复杂的交互功能。

#### 4.4.1 常量参数

| 参数 | 值 | 说明 |
|------|----|------|
| `SNAP_THRESHOLD` | 20px | 吸附阈值，窗口距边缘 ≤ 20px 时触发 |
| `TRIGGER_WIDTH` | 2px | 边缘触发窗口宽度 |
| `SLIDE_DURATION` | 200ms | 滑动动画总时长 |
| `SLIDE_INTERVAL` | 16ms | 帧间隔（≈60fps） |
| `HIDE_DELAY` | 200ms | 鼠标离开后延迟隐藏时间 |

#### 4.4.2 状态变量

| 变量 | 类型 | 说明 |
|------|------|------|
| `dockSide` | `null \| 'left' \| 'right'` | 当前吸附方向 |
| `isDockHidden` | `boolean` | 窗口是否处于隐藏状态 |
| `triggerWin` | `BrowserWindow \| null` | 边缘触发窗口实例 |
| `cachedWorkArea` | `object \| null` | 缓存显示器工作区 |
| `isSliding` | `boolean` | 滑动动画进行中 |
| `slideAnimTimer` | `timer \| null` | 滑动动画定时器 |
| `hideTimer` | `timer \| null` | 隐藏延迟定时器 |

#### 4.4.3 边缘检测（detectSide）

```
1. 排除最大化/最小化状态
2. 获取缓存的工作区 (workArea)
3. 获取窗口 bounds
4. 左边缘：b.x <= wa.x + 20 → return 'left'
5. 右边缘：b.x + b.width >= wa.x + wa.width - 20 → return 'right'
6. 否则 → return null
```

#### 4.4.4 吸附到边缘（snapToEdge）

```
- 左边缘：x = workArea.x
- 右边缘：x = workArea.x + workArea.width - windowWidth
```

#### 4.4.5 触发窗口（Trigger Window）

**创建条件**：窗口贴边隐藏后创建

**属性：**
| 参数 | 值 |
|------|----|
| 宽度 | 2px |
| 高度 | 工作区全高 |
| 位置 | 吸附侧边缘 |
| transparent | true |
| frame | false |
| alwaysOnTop | true |
| skipTaskbar | true |
| resizable | false |
| focusable | false |
| hasShadow | false |
| 置顶层级 | `pop-up-menu`（确保全屏应用上方仍可触发） |

**行为**：加载一段 HTML，`onmouseenter` 时发送 `trigger-enter` IPC 消息

**销毁时机**：主窗口恢复显示时立即销毁

#### 4.4.6 滑动动画（slideTo）

**缓动函数**：easeInOutQuad

```
easeInOutQuad(t):
  if t < 0.5:  return 2 * t * t
  else:        return 1 - (-2t + 2)² / 2
```

**动画流程：**
```
1. 清除之前的动画定时器
2. 设置 isSliding = true
3. 记录起始 X 坐标 (fromX)
4. 计算总帧数 = ceil(200ms / 16ms) = 13 帧
5. setInterval 每 16ms 执行：
   a. frame++
   b. progress = min(frame / totalFrames, 1)
   c. ease = easeInOutQuad(progress)
   d. newX = fromX + (targetX - fromX) * ease
   e. setX(newX)  // 仅修改 X 坐标
   f. progress >= 1 时停止，isSliding = false
```

#### 4.4.7 隐藏流程（doHide）

```
1. 前置检查：窗口存在 && 未隐藏 && dockSide 非空
2. isDockHidden = true
3. mainWindow.setAlwaysOnTop(true)  // 恢复默认定级
4. 计算目标 X：
   - 左边缘隐藏：targetX = workArea.x - windowWidth（滑出左屏幕）
   - 右边缘隐藏：targetX = workArea.x + workArea.width（滑出右屏幕）
5. 创建触发窗口
6. 执行 slideTo(targetX)
```

#### 4.4.8 显示流程（doShow）

```
1. 前置检查：窗口存在 && 已隐藏
2. isDockHidden = false
3. 立即销毁触发窗口
4. 计算目标 X：
   - 左边缘显示：targetX = workArea.x（滑回到左边缘）
   - 右边缘显示：targetX = workArea.x + workArea.width - windowWidth
5. mainWindow.setAlwaysOnTop(true, 'pop-up-menu')  // 提升层级覆盖全屏应用
6. 执行 slideTo(targetX)
```

#### 4.4.9 鼠标悬停控制

- **mouseenter（进入窗口）**：取消待执行的隐藏定时器
- **mouseleave（离开窗口）**：若已吸附边缘且未隐藏且未在动画中，延迟 200ms 后隐藏
- **防误触**：隐藏前二次校验光标位置，排除透明圆角区域误触发的 mouseleave

```
防误触校验逻辑：
  cursor = 获取光标屏幕坐标
  bounds = 窗口 bounds
  if cursor 在 bounds 矩形内 → 误触发，不隐藏
```

#### 4.4.10 最大化/最小化时的状态重置

最大化或最小化时，重置所有贴边状态：
```
dockSide = null
isDockHidden = false
销毁触发窗口
```

### 4.5 系统托盘

#### 4.5.1 托盘行为

| 操作 | 行为 |
|------|------|
| 左键单击 | 显示窗口 + 获取焦点；若已贴边隐藏则先恢复 |
| 右键菜单 | 显示「退出」选项，执行 `app.quit()` |

#### 4.5.2 托盘图标

- 使用 `resources/icon.png` 作为托盘图标
- tooltip 文字：`便签`

#### 4.5.3 点击恢复逻辑

```
1. 检查窗口是否可见
2. 若不可见：
   a. 若已贴边隐藏 → 执行 doShow()
   b. mainWindow.show() + mainWindow.focus()
   c. 重新检测边缘 dockSide = detectSide()
```

### 4.6 毛玻璃效果系统

这是本项目中**平台复杂度最高**的功能。

#### 4.6.1 双模式互斥

| 模式 | transparent | 背景效果 | 圆角来源 |
|------|-------------|---------|---------|
| 默认模式 | `true` | CSS 透明 + backdrop-filter | CSS border-radius |
| 毛玻璃模式 | `false` | DWM Acrylic（Win11）/ User32（Win10） | DWM 原生圆角 |

**核心矛盾**：`transparent: true` 与 DWM 毛玻璃**互斥**。开启毛玻璃必须 `transparent: false`，因此需要**销毁并重建窗口**。

#### 4.6.2 Windows 11 毛玻璃实现

```javascript
// 通过 mica-electron 原生 addon 调用 DWM API
const HWND = mainWindow.getNativeWindowHandle().readInt32LE()
_micaNative.executeDwm(HWND, 3, 5)  // BACKGROUND.ACRYLIC + THEME.AUTO
_micaNative.executeDwm(HWND, 5, 3)  // CORNER.ROUNDSMALL
```

- 在窗口首次 `show` 事件时应用
- `BACKGROUND.ACRYLIC = 3`：亚克力模糊背景
- `THEME.AUTO = 5`：自动跟随系统主题
- `CORNER.ROUNDSMALL = 3`：小圆角

#### 4.6.3 Windows 10 毛玻璃实现

```javascript
// 通过 User32.dll SetWindowCompositionAttribute
_micaNative.executeUser32(HWND, WIN10_ACRYLIC, 0x00ffffff)
// WIN10_ACRYLIC = 4 (ACCENT_ENABLE_ACRYLICBLURBEHIND)
// 颜色 = 0x00ffffff（透明白色）
```

- Win10 不支持 DWM 圆角参数
- 使用 User32 API 的 `SetWindowCompositionAttribute`

#### 4.6.4 macOS 毛玻璃实现

```javascript
// 默认模式（非毛玻璃）使用 vibrancy
{ vibrancy: 'under-window' }
```

- macOS 的 vibrancy 在 `transparent: true` 时可用
- 毛玻璃模式下不需要 vibrancy（DWM 提供效果）

#### 4.6.5 窗口重建流程（recreateWindow）

```
1. 保存当前窗口 bounds 到数据库
2. 记录当前可见状态 wasVisible
3. 清理贴边状态
4. 移除旧 IPC handler（避免重复注册）
5. mainWindow.destroy()  // 销毁旧窗口
6. 注册新 IPC handler
7. createWindow()  // 用新的 transparent 值创建新窗口
8. if wasVisible → mainWindow.show()
```

#### 4.6.6 毛玻璃状态持久化

- 存储位置：`app_settings` 表，`key = 'frosted_glass'`，`type = 'system'`
- 值：`'1'`（开启）或 `'0'`（关闭）
- 启动时读取并设置 `_frostedGlassEnabled` 标志，在 `createWindow` 前加载

#### 4.6.7 平台兼容性

| 平台 | 支持状态 | 实现方式 |
|------|---------|---------|
| Windows 11 (22H2+) | 完整支持 | DWM API (mica-electron) |
| Windows 10 | 有限支持 | User32 API |
| macOS | vibrancy 方式 | Electron vibrancy 属性 |
| Linux | 不支持 | 返回错误提示 |

### 4.7 设置面板（SettingsPanel）

#### 4.7.1 面板外观

- **位置**：从窗口底部向上滑入
- **高度**：占主窗口 70%
- **圆角**：顶部 16rem，底部 0（`border-radius: 16rem 16rem 0 0`）
- **阴影**：`0px -8px 32px 0px rgba(0, 0, 0, 0.37)`
- **遮罩层**：`rgba(0, 0, 0, 0.25)` 半透明黑色，点击关闭面板
- **继承样式**：使用 `.app-bg` 类继承全局玻璃态效果

#### 4.7.2 动画

- **进入**：`translateY(100%)` → `translateY(0)`
- **退出**：`translateY(0)` → `translateY(100%)`
- **时长**：350ms
- **缓动**：`cubic-bezier(0.25, 0.1, 0.25, 1)`
- **遮罩**：透明 → 半透明，同步 350ms 过渡

#### 4.7.3 面板结构

```
┌─────────────────────────────┐
│        ▬▬▬ (拖拽指示条)       │  宽 36rem, 高 4rem, 圆角 2rem
├─────────────────────────────┤
│  设置                    ✕   │  标题 18rem/600 + 关闭按钮 28rem 圆形
├─────────────────────────────┤
│  ── 基础样式修改 ──           │  分区标题 12rem/600, 38% 透明度
│  [毛玻璃效果]        [开关]   │
│  [窗口透明度]     [滑条 25%]  │
│  [弹窗模糊]       [滑条 10px] │
│  [边框]             [开关]   │
│  [字体缩放]       [下拉 1x]  │
│  [文字颜色]       [色块 #...] │
│  [背景颜色]  [预设色块...] [选择器] │
│                             │
│  ── 窗口设置 ──              │
│  [窗口置顶]         [开关]   │
│  [开机自启]         [开关]   │
│                             │
│  ── 关于 ──                 │
│  应用版本          v1.0.0    │
│  [  重置所有设置  ]          │
└─────────────────────────────┘
```

#### 4.7.4 设置项详细规格

**毛玻璃效果开关**
- 类型：Toggle 开关
- 开启时通过 IPC 调用 `setFrostedGlass(true)`，触发窗口重建
- 失败时弹出 alert 并回退开关状态

**窗口透明度**
- 类型：滑条（range）
- 范围：0 ~ 1，步长 0.05
- 默认值：0.25
- 映射 CSS 变量：`--popup-opacity`

**弹窗模糊**
- 类型：滑条（range）
- 范围：0 ~ 40，步长 1
- 默认值：10
- 映射 CSS 变量：`--bg-blur`（单位 px）

**边框开关**
- 类型：Toggle
- 默认值：true
- 映射 CSS 变量：`--bg-border`（1 或 0）

**字体缩放**
- 类型：下拉选择框
- 选项：0.5x, 0.75x, 1x, 1.25x, 1.5x, 1.75x, 2x, 2.5x, 3x
- 默认值：1
- 映射 CSS 变量：`--font-scale`

**文字颜色**
- 类型：颜色选择器
- 默认值：`#1d1d1f`
- 映射 CSS 变量：`--text-color`

**背景颜色**
- 类型：预设色块 + 自定义颜色选择器
- 默认值：`255 255 255`（白色）
- 映射 CSS 变量：`--bg-color`
- 预设色：
  | 名称 | RGB 值 |
  |------|--------|
  | 白 | `255 255 255` |
  | 暖黄 | `255 248 220` |
  | 薄荷 | `220 255 240` |
  | 淡蓝 | `220 240 255` |
  | 淡紫 | `240 225 255` |
  | 深灰 | `40 40 45` |

**窗口置顶** / **开机自启**
- 类型：Toggle
- 默认值：false
- （UI 已实现，功能逻辑待完善）

**重置所有设置**
- 将所有设置恢复为默认值
- 若毛玻璃开启，先关闭毛玻璃

#### 4.7.5 防抖保存机制

- 滑条类控件使用 **300ms 防抖**保存到数据库
- Toggle 和下拉框立即保存（无防抖）
- 所有设置修改**立即生效**（CSS 变量即时更新），保存只是持久化

---

## 5. 数据持久化

### 5.1 数据库配置

| 配置 | 值 |
|------|----|
| 引擎 | SQLite |
| 文件位置 | `userData/app.db`（Electron 用户数据目录） |
| 驱动 | better-sqlite3（同步 API） |
| 日志模式 | WAL（Write-Ahead Logging） |

### 5.2 表结构

```sql
CREATE TABLE IF NOT EXISTS app_settings (
  window_name TEXT NOT NULL,   -- 窗口标识（如 'main'）
  type        TEXT NOT NULL,   -- 设置分类
  key         TEXT NOT NULL,   -- 设置键名
  value       TEXT,            -- 设置值（字符串形式）
  created_at  INTEGER,         -- 创建时间戳（ms）
  updated_at  INTEGER,         -- 更新时间戳（ms）
  PRIMARY KEY (window_name, key)  -- 复合主键
);
```

### 5.3 设置分类（type）

| type | 说明 | 示例 key |
|------|------|---------|
| `geometry` | 窗口几何信息 | `pos_x`, `pos_y`, `width`, `height` |
| `css` | 样式设置 | `bg_color`, `win_opacity`, `bg_blur`, `bg_border`, `font_scale`, `text_color` |
| `system` | 系统功能开关 | `frosted_glass` |

### 5.4 CRUD 操作

**获取单个设置：**
```sql
SELECT value FROM app_settings WHERE window_name = ? AND key = ?
```

**写入/更新设置（UPSERT）：**
```sql
INSERT INTO app_settings (window_name, type, key, value, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(window_name, key) DO UPDATE SET
  value = excluded.value,
  type = excluded.type,
  updated_at = excluded.updated_at
```

**按类型批量获取：**
```sql
SELECT key, value FROM app_settings WHERE window_name = ? AND type = ?
```

**删除设置：**
```sql
DELETE FROM app_settings WHERE window_name = ? AND key = ?
```

**保存几何信息（事务）：**
- 使用数据库事务一次性写入 `pos_x`、`pos_y`、`width`、`height`，保证原子性

### 5.5 旧表兼容

- 检测 `app_settings` 表是否包含 `window_name` 列
- 若缺少该列（旧版结构），删除旧表重建

---

## 6. IPC 通信协议

### 6.1 通道一览

| 通道名 | 方向 | 类型 | 用途 |
|--------|------|------|------|
| `renderer-ready` | Renderer → Main | `send` | 渲染就绪，触发窗口显示 |
| `window-close` | Renderer → Main | `send` | 关闭窗口（隐藏到托盘） |
| `window-minimize` | Renderer → Main | `send` | 最小化窗口 |
| `window-maximize` | Renderer → Main | `send` | 切换最大化/还原 |
| `window-get-bounds` | Renderer → Main | `invoke` | 获取窗口位置与尺寸 |
| `window-set-bounds` | Renderer → Main | `send` | 设置窗口位置与尺寸 |
| `get-settings` | Renderer → Main | `invoke` | 按类型批量获取设置 |
| `get-setting` | Renderer → Main | `invoke` | 获取单个设置值 |
| `set-setting` | Renderer → Main | `invoke` | 写入/更新设置 |
| `delete-setting` | Renderer → Main | `invoke` | 删除设置 |
| `window-hover` | Renderer → Main | `send` | 鼠标悬停状态 |
| `trigger-enter` | Renderer → Main | `send` | 边缘触发窗口鼠标进入 |
| `window-frosted-glass` | Renderer → Main | `invoke` | 开关毛玻璃效果 |

### 6.2 send vs invoke

- **send**：单向通知，不需要返回值（如窗口关闭、最小化）
- **invoke**：双向通信，返回 Promise（如获取设置、获取 bounds）

---

## 7. 全局样式系统

### 7.1 响应式根字号

```css
html {
  font-size: calc(100vw / 500 * var(--font-scale, 1));
}
```

- **基准**：500px 宽窗口下 `1rem = 1px × scale`
- **效果**：所有 rem 单位随窗口宽度自动缩放
- **用户控制**：`--font-scale` 变量允许用户自定义缩放

### 7.2 CSS 自定义属性（Design Tokens）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `--font-scale` | `1` | 字体缩放因子 |
| `--font-family-text` | `'OPPOSans', 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', sans-serif` | 正文字体族 |
| `--text-color` | `#1d1d1f` | 全局文字颜色 |
| `--bg-color` | `255 255 255` | 背景颜色（RGB 三通道，空格分隔） |
| `--bg-blur` | `10px` | 弹窗模糊半径 |
| `--bg-border` | `1` | 边框开关（0/1） |
| `--popup-opacity` | `0.25` | 窗口背景透明度（0~1） |

### 7.3 玻璃态背景容器（.app-bg）

```css
.app-bg {
  background-color: rgb(var(--bg-color) / var(--popup-opacity));
  backdrop-filter: blur(var(--bg-blur)) saturate(180%) contrast(100%) brightness(100%);
  border: calc(var(--bg-border) * 1px) solid rgba(255, 255, 255, 0.18);
}
```

- 应用于：根组件 `.app-root` 和设置面板 `.settings-panel`
- 背景色透明度由 `--popup-opacity` 控制
- 模糊效果含饱和度增强（`saturate(180%)`）

### 7.4 全局字体

```
OPPOSans → SF Pro Text → PingFang SC → Microsoft YaHei → sans-serif
```

### 7.5 CSS Reset 要点

- 所有元素 `box-sizing: border-box; margin: 0; font-weight: normal`
- 隐藏 WebKit 滚动条（`::-webkit-scrollbar { display: none }`）
- 列表无样式（`list-style: none`）
- `body`：`background: transparent; overflow: hidden; user-select: none`
- 字体平滑：`-webkit-font-smoothing: antialiased`

---

## 8. 视觉设计规范

### 8.1 设计原则

- **极简克制**：每个像素都有存在的理由，无装饰性元素
- **二元明暗节奏**：纯黑 (`#000000`) 与浅灰 (`#f5f5f7`) 交替
- **单一强调色**：Apple Blue (`#0071e3`) 仅用于交互元素
- **极度克制的阴影**：仅一种柔和漫射阴影 `3px 5px 30px rgba(0,0,0,0.22)`
- **负字间距**：所有尺寸文字使用轻微负 letter-spacing

### 8.2 配色速查

| 用途 | 色值 |
|------|------|
| 主 CTA / 强调色 | `#0071e3` |
| 浅色背景 | `#f5f5f7` |
| 深色背景 | `#000000` |
| 标题文字（浅底） | `#1d1d1f` |
| 标题文字（深底） | `#ffffff` |
| 链接（浅底） | `#0066cc` |
| 链接（深底） | `#2997ff` |
| 聚焦环 | `#0071e3` |
| 关闭按钮 | `#ff5f57` / hover `#ff4136` |
| 最小化按钮 | `#febc2e` / hover `#f5a623` |
| 最大化按钮 | `#28c840` / hover `#1db954` |
| 危险操作 | `#ff453a` |

### 8.3 排版

| 类型 | 字号范围 | 字重 | 行高 |
|------|---------|------|------|
| Display（≥20px） | SF Pro Display | 600 | 1.07–1.14 |
| Body（<20px） | SF Pro Text | 400 | 1.47 |

- **字重范围**：300–700，大部分文字在 400 和 600
- **负字间距**：所有尺寸均使用

### 8.4 间距与圆角

- **间距基准**：8px，细粒度从 2px 起
- **圆角阶梯**：

| 级别 | 值 | 用途 |
|------|----|------|
| 微型 | 5px | 小容器、标签 |
| 标准 | 8px | 按钮、卡片 |
| 舒适 | 11px | 搜索框、筛选按钮 |
| 大 | 12px | 主窗口圆角、面板 |
| 面板顶 | 16rem | 设置面板顶部圆角 |
| 药丸 | 980px | CTA 链接 |
| 圆形 | 50% | 红绿灯按钮、开关 |

### 8.5 阴影

- **唯一阴影**：`3px 5px 30px rgba(0, 0, 0, 0.22)`
- **设置面板阴影**：`0px -8px 32px 0px rgba(0, 0, 0, 0.37)`（向上投射）
- **大多数元素无阴影**，高度感通过背景色对比实现

---

## 9. 关键 UI 组件样式详细规格

### 9.1 Toggle 开关

```
关闭状态：
  宽度: 44rem, 高度: 24rem, 圆角: 12rem
  背景: rgba(255, 255, 255, 0.12)
  滑块: 20rem 圆形, 白色, 阴影 0 1rem 3rem rgba(0,0,0,0.2)
  滑块位置: translateX(0)

开启状态：
  背景: #0071e3
  滑块位置: translateX(20rem)

过渡: 200ms ease
```

### 9.2 滑条（Slider/Range）

```
轨道: 宽 120rem, 高 4rem, 圆角 2rem
  背景: rgba(255, 255, 255, 0.12)

滑块: 16rem 圆形, 白色
  阴影: 0 1rem 4rem rgba(0, 0, 0, 0.3)
  悬停: scale(1.15)
```

### 9.3 设置项卡片

```
单条设置:
  padding: 12rem 14rem
  border-radius: 10rem
  background: rgba(255, 255, 255, 0.04)
  hover background: rgba(255, 255, 255, 0.07)
  margin-bottom: 6rem
  布局: flex, space-between, center aligned
```

### 9.4 分区标题

```
font-size: 12rem
font-weight: 600
opacity: 0.38
text-transform: uppercase
letter-spacing: 0.5rem
margin-bottom: 12rem
padding-left: 2rem
```

### 9.5 预设色块

```
尺寸: 20rem 圆形
border: 2rem solid transparent
hover: scale(1.15)
active: border-color #0071e3, box-shadow 0 0 0 2rem rgba(0,113,227,0.3)
间距: gap 6rem
```

### 9.6 颜色选择器

```
尺寸: 28rem × 28rem
border-radius: 6rem
border: 1rem solid rgba(255, 255, 255, 0.15)
无边框装饰，无内边距
```

### 9.7 字体下拉框

```
background: rgba(255, 255, 255, 0.1)
border: 1rem solid rgba(255, 255, 255, 0.15)
border-radius: 6rem
padding: 4rem 28rem 4rem 10rem
font-size: 13rem
min-width: 72rem
自定义下拉箭头（SVG chevron）
hover: background rgba(255, 255, 255, 0.15)
focus: border-color #0071e3
option 背景: #2a2a2d
```

### 9.8 危险按钮（重置）

```
width: 100%
padding: 10rem 0
border-radius: 10rem
background: rgba(255, 59, 48, 0.15)
color: #ff453a
font-size: 14rem
font-weight: 500
hover: background rgba(255, 59, 48, 0.25)
```

### 9.9 关闭按钮（面板）

```
尺寸: 28rem 圆形
background: rgba(255, 255, 255, 0.08)
opacity: 0.6
SVG 图标: 14×14, stroke-width 1.8, stroke-linecap round
hover: background rgba(255, 255, 255, 0.15), opacity 1
```

### 9.10 拖拽指示条

```
容器: 居中, padding-top 10rem, padding-bottom 4rem
条形: 宽 36rem, 高 4rem, 圆角 2rem
background: rgba(255, 255, 255, 0.2)
```

---

## 10. 生命周期管理

### 10.1 启动流程

```
1. app.whenReady()
2. initDatabase()              // 初始化 SQLite
3. setAppUserModelId()         // Windows 任务栏 ID
4. 注册所有 IPC 通道
5. 从数据库读取 frosted_glass 设置
6. createWindow()              // 创建主窗口（show: false）
7. 渲染进程加载完成 → 发送 renderer-ready
8. 主进程收到 → mainWindow.show()
9. 创建系统托盘 Tray
10. 注册托盘事件
```

### 10.2 退出流程

```
1. 托盘右键「退出」 → isQuitting = true → app.quit()
2. before-quit 事件触发：
   a. closeDatabase()         // 关闭 SQLite 连接
   b. 销毁触发窗口
   c. 清除滑动动画定时器
   d. 清除隐藏延迟定时器
   e. 销毁托盘
3. window-all-closed → 空函数（不退出，保持托盘运行）
```

### 10.3 macOS 特有

- `activate` 事件：点击 Dock 图标时显示窗口

---

## 11. 资源文件

### 11.1 图标资源

| 文件 | 用途 |
|------|------|
| `resources/icon.png` | 应用主图标（系统托盘 & 打包） |
| `resources/icons/close.png` | 红绿灯关闭按钮图标 |
| `resources/icons/minimize.png` | 红绿灯最小化按钮图标 |
| `resources/icons/maximize.png` | 红绿灯最大化按钮图标 |
| `resources/icons/settings.png` | 设置按钮图标 |
| `resources/icons/help.png` | 帮助按钮图标 |

---

## 12. 安全策略

| 策略 | 配置 |
|------|------|
| 无边框 | `frame: false` |
| 透明背景 | `transparent: true`（默认模式） |
| 沙箱 | `sandbox: false`（preload 需要 Node API） |
| 上下文隔离 | `contextBridge` 安全暴露 API |
| CSP | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:` |
| 外部链接 | 拦截新窗口请求，使用系统浏览器打开 |

---

## 13. PyQt6 迁移关键注意事项

### 13.1 窗口系统对应

| Electron | PyQt6 建议 |
|----------|-----------|
| `BrowserWindow` | `QMainWindow` 或 `QWidget` |
| `frame: false` | `Qt.FramelessWindowHint` |
| `transparent: true` | `Qt.WA_TranslucentBackground` + `setAttribute` |
| `setBounds()` | `setGeometry()` / `move()` + `resize()` |
| `getBounds()` | `geometry()` / `pos()` + `size()` |
| `show/hide` | `show()` / `hide()` |
| `setAlwaysOnTop` | `Qt.WindowStaysOnTopHint` |
| `setZoomFactor(1.0)` | 不需要（Qt 原生处理 DPI） |

### 13.2 贴边隐藏对应

| Electron | PyQt6 建议 |
|----------|-----------|
| `screen.getDisplayMatching()` | `QApplication.screenAt()` |
| `screen.getCursorScreenPoint()` | `QCursor.pos()` |
| `screen.getPrimaryDisplay()` | `QApplication.primaryScreen()` |
| `workArea` | `screen.availableGeometry()` |
| `setInterval` 动画 | `QTimer` + `QPropertyAnimation` |
| 触发窗口 | 另一个 `QWidget`（Frameless + Transparent） |
| `mouseEnter/mouseLeave` | `enterEvent` / `leaveEvent` |

### 13.3 系统托盘对应

| Electron | PyQt6 建议 |
|----------|-----------|
| `Tray` | `QSystemTrayIcon` |
| `Menu.buildFromTemplate` | `QMenu` |
| `tray.on('click')` | `QSystemTrayIcon.activated` 信号 |

### 13.4 数据持久化对应

| Electron | PyQt6 建议 |
|----------|-----------|
| `better-sqlite3` | `sqlite3`（Python 标准库）或 `PyQt6.QtSql` |
| `app.getPath('userData')` | `QStandardPaths.writableLocation(AppDataLocation)` |

### 13.5 毛玻璃效果对应

这是 **Electron 版本中最复杂的部分**，在 PyQt6 中同样具有挑战性：

| 平台 | Electron 方案 | PyQt6 建议 |
|------|-------------|-----------|
| Windows 11 | DWM API via mica-electron | `DwmSetWindowAttribute` 通过 `ctypes` 直接调用 |
| Windows 10 | User32 API | `SetWindowCompositionAttribute` 通过 `ctypes` |
| macOS | Electron vibrancy | `NSVisualEffectView` 通过 `pyobjc` |
| Linux | 不支持 | 可尝试 `KWin` 的模糊效果或 `QGraphicsBlurEffect` |

**关键区别**：PyQt6 可以直接通过 `ctypes` 调用 Windows API，**不需要第三方原生模块**（如 mica-electron），简化了依赖链。

### 13.6 UI 渲染对应

| Electron（Vue 3 + CSS） | PyQt6 建议 |
|------------------------|-----------|
| Vue 组件 | `QWidget` / QML 组件 |
| CSS 自定义属性 | QSS（Qt Style Sheets）或 Python 变量 |
| `backdrop-filter: blur()` | `QGraphicsBlurEffect` 或自定义 shader |
| `border-radius` | QSS `border-radius` 或 `QPainterPath` |
| Flex 布局 | `QVBoxLayout` / `QHBoxLayout` |
| `-webkit-app-region: drag` | 手动实现拖拽（`mousePressEvent` + `mouseMoveEvent`） |
| CSS 过渡动画 | `QPropertyAnimation` |
| `Teleport` | `QDialog` 或 stacked widget |

### 13.7 响应式字号对应

Electron 版本的响应式根字号（`calc(100vw / 500 * var(--font-scale))`）在 PyQt6 中需要手动实现：
- 监听窗口 resize 事件
- 根据窗口宽度计算基准字号
- 乘以 `font_scale` 因子
- 更新所有子控件的字体大小

### 13.8 八方向缩放对应

Electron 的透明缩放手柄在 PyQt6 中可通过以下方式实现：
- 重写 `QWidget` 的 `mousePressEvent`、`mouseMoveEvent`、`mouseReleaseEvent`
- 根据鼠标位置判断缩放方向（边缘检测）
- 调用 `setGeometry()` 更新窗口

---

## 14. 已知技术难点与解决方案

### 14.1 毛玻璃与透明互斥

**问题**：Electron 的 `transparent: true` 与 DWM 毛玻璃效果互斥，无法同时使用。
**解决**：切换毛玻璃时销毁并重建窗口，用新的 `transparent` 参数创建。
**PyQt6 注意**：Qt 中 `WA_TranslucentBackground` 与 DWM 可能也存在类似冲突，需测试。

### 14.2 窗口 destroy 被 close 拦截

**问题**：`mainWindow.destroy()` 会触发 `close` 事件，被 `preventDefault` 拦截导致重建失败。
**解决**：使用 `isQuitting` 标志位，或直接在 `destroy` 前移除 close handler。
**PyQt6 注意**：Qt 的 `close()` 和 `deleteLater()` 行为不同，注意区分。

### 14.3 贴边隐藏的圆角误触发

**问题**：透明窗口的圆角区域会误触发 `mouseleave` 事件。
**解决**：隐藏前二次校验光标位置，确认光标不在窗口矩形内才执行隐藏。

### 14.4 触发窗口的层级问题

**问题**：全屏应用会覆盖普通置顶窗口。
**解决**：触发窗口使用 `pop-up-menu` 层级（Windows 上对应 `HWND_TOPMOST` + 特殊 flag）。
**PyQt6 对应**：`Qt.WindowStaysOnTopHint` 或 `Qt.Popup` flag。

### 14.5 Windows 缓存锁定错误

**问题**：窗口重建时 SQLite 可能因文件锁定报错（`0x5`）。
**解决**：确保旧窗口完全销毁后再操作数据库，使用 WAL 模式减少锁冲突。

---

## 15. 代码规范（供 PyQt6 版本参考）

### 15.1 注释规范

- **文件级**：每个文件顶部使用文档字符串，声明文件名、职责概述、关键设计决策
- **函数级**：所有函数/方法使用文档字符串，包含 `@param`、`@returns`
- **常量级**：关键常量附说明
- **注释语言**：中文
- **区块分隔**：使用 `# ====` 分隔符划分逻辑区块

### 15.2 代码风格

- **模块职责单一**：每个文件有明确的职责边界
- **防御性编程**：关键操作前检查实例是否存在
- **防抖保护**：高频事件（resize/move）使用防抖避免频繁 IO
- **状态守卫**：贴边动画使用标志位防止状态冲突
- **资源清理**：退出前统一释放数据库连接、销毁辅助窗口、清除定时器
- **像素对齐**：`int()` / `round()` 确保所有像素值为整数
