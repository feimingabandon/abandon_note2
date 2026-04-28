# abandon_note2

An Electron application with Vue

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode) + [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```

---

## 响应式布局 + 多窗口独立字号设置

### 一、理论基础

#### 1. rem 等比缩放原理

CSS 中 `rem` 单位始终参照 `<html>` 的 `font-size`。将 html 的 font-size 设为与视口宽度关联的动态值，所有使用 rem 的元素就会随窗口宽度等比缩放。

**核心公式**：

```css
html { font-size: calc(100vw / W); }
```

- `100vw` = 当前窗口的 CSS 像素宽度
- `W` = 设计锚点（固定常量，本项目为 **500**）

当窗口宽度恰好等于 W 时，`1rem = 1px`，设计稿的像素值可以 1:1 直接写成 rem 值（如设计稿 28px → 写 28rem）。

**为什么 W 必须写死？** 如果 W 动态取窗口宽度，那 `calc(100vw / 窗口宽度)` 永远等于 1px，rem 就等于 px，响应式缩放完全失效。W 是"设计锚点"，窗口偏离 W 时才会产生缩放效果。

#### 2. clamp 安全阈值

rem 虽然实现了等比缩放，但字体有最小可读性要求。窗口极小时字体不能缩到看不清，窗口极大时也不能无限放大。

**解决方案**：用 `clamp(最小px, 动态rem, 最大px)` 给字体设上下限：

```css
clamp(8px, 14rem, 40px)
       ↑      ↑      ↑
    地板    正常缩放   天花板
```

- 窗口正常范围内：14rem 随窗口等比变化
- 窗口太小：不会低于 8px
- 窗口太大：不会超过 40px

**注意**：间距、圆角等不需要 clamp（没有可读性要求，缩放到极端也不影响使用）。

#### 3. 媒体查询双保险

除了 clamp 保护字体，还对 html 根字号本身加媒体查询兜底：

```css
@media (max-width: 350px) { html { font-size: 0.7px; } }   /* 锁死下限 */
@media (min-width: 1000px) { html { font-size: 2px; } }    /* 锁死上限 */
```

这保护的是**所有** rem 值（间距、圆角、尺寸），而 clamp 只保护字体。两者互补。

#### 4. Electron 多窗口的隔离性

每个 `BrowserWindow` 是独立的 Chromium 渲染进程，拥有各自的 `document`、`:root`、CSS 变量。在设置窗口改了 CSS 变量，主窗口完全不知道——就像两个浏览器标签页互不影响。

**因此**：跨窗口通信只能走 IPC（进程间通信），没有其他路径。

---

### 二、架构设计（三层结构）

```
┌─────────────────────────────────────────────────────────────┐
│ 第 1 层：rem 根字号缩放（全局基础）                           │
│   html { font-size: calc(100vw / 500); }                    │
│   + 媒体查询上下限兜底                                       │
├─────────────────────────────────────────────────────────────┤
│ 第 2 层：CSS 变量字体分层 + clamp                            │
│   --font-size-base:    clamp(8px,  14rem,       40px)       │
│   --font-size-title:   clamp(12px, 14rem × 1.5, 60px)      │
│   --font-size-caption: clamp(7px,  14rem × 0.85, 34px)     │
│   body { font-size: var(--font-size-base); }                │
├─────────────────────────────────────────────────────────────┤
│ 第 3 层：窗口尺寸按屏幕比例                                   │
│   主窗口 30%×62% | 设置 32%×46%                              │
│   灵动岛 22%×15% | 灵动岛设置 28%×38%                        │
└─────────────────────────────────────────────────────────────┘
```

---

### 三、实际代码流程

#### 文件结构

```
src/renderer/src/
├── assets/
│   └── base.css                  ← 第 1+2 层：根字号 + CSS 变量定义
├── utils/
│   └── fontUtils.js              ← 工具层：字体常量 + applyFontSize()
├── composables/
│   └── useFontSize.js            ← Vue 组合式：监听器 + 编辑器
├── App.vue                       ← 主窗口（消费者）
├── views/
│   ├── IslandApp.vue             ← 灵动岛窗口（消费者）
│   ├── SettingsApp.vue           ← 主窗口设置（生产者）
│   └── IslandSettingsApp.vue     ← 灵动岛设置（生产者）

src/main/index.js                 ← 主进程：IPC 转发中枢
src/preload/index.js              ← 桥梁：暴露 IPC API
```

#### A. 响应式缩放（静态，页面加载即生效）

```
base.css
  ├── html { font-size: calc(100vw / 500); }     ← 1rem 随窗口宽度动态变化
  ├── @media 上下限                                ← 极端尺寸兜底
  ├── :root { --font-size-base/title/caption }    ← 字体变量 + clamp
  └── body { font-size: var(--font-size-base); }  ← 默认继承正文字号

所有 CSS 文件/组件
  └── 间距、圆角 → rem 单位（如 padding: 20rem）
  └── 字体 → var(--font-size-base/title/caption)
  └── 1px 边框 → 保留 px（防缩放模糊）
```

#### B. 多窗口独立设置字号（动态，用户操作触发）

```
fontUtils.js — 常量 + 纯函数
  ├── FONT_CONFIG = { base, title, caption }     ← clamp 参数集中管理
  ├── FONT_SIZE_MIN/MAX/DEFAULT                  ← 滑动条范围
  ├── clampFontSize(val)                         ← 限制输入范围
  └── applyFontSize(size)                        ← 更新当前 document 的 3 个 CSS 变量

useFontSize.js — Vue Composable
  ├── useFontSizeListener()                      ← 目标窗口用：onMounted 注册 IPC 监听
  └── useFontSizeEditor(ipcMethod)               ← 设置窗口用：ref + watch + IPC 发送
```

#### C. IPC 通信链路（以主窗口为例）

```
SettingsApp.vue                    主窗口设置页
  │  const { fontSize } = useFontSizeEditor('setMainFontSize')
  │  ↓ 用户拖动滑动条，fontSize 变化
  │  watch → clampFontSize(val)
  │        → applyFontSize(val)           ← 更新本窗口预览
  │        → window.api.setMainFontSize(val)
  ↓
preload/index.js
  │  setMainFontSize: (size) => ipcRenderer.send('set-main-font-size', size)
  ↓
main/index.js                      主进程
  │  ipcMain.on('set-main-font-size', (_event, size) => {
  │    mainWindow.webContents.send('font-size-changed', size)
  │  })
  ↓
App.vue                            主窗口
  │  useFontSizeListener()
  │  → onMounted → window.api.onFontSizeChanged(callback)
  │  → callback → applyFontSize(size)     ← 更新主窗口的 3 个 CSS 变量
  ↓
  页面所有使用 var(--font-size-*) 的元素实时变化
```

灵动岛的链路完全对称，IPC 通道名为 `set-island-font-size`。

---

### 四、维护要点

| 想改什么 | 改哪里 |
|---------|--------|
| clamp 上下限（如 8px→10px） | `src/renderer/src/utils/fontUtils.js` 的 `FONT_CONFIG` |
| 滑动条范围（如 8~32→5~50） | `src/renderer/src/utils/fontUtils.js` 的 `FONT_SIZE_MIN/MAX` |
| 默认字号（如 14→16） | `fontUtils.js` 的 `FONT_SIZE_DEFAULT` + `base.css` 的 `:root` 初始值 |
| 新增字体层级（如 small） | `FONT_CONFIG` 加一项，`applyFontSize` 自动遍历 |
| 设计锚点 W（如 500→600） | `base.css` 的 `calc(100vw / 500)` |
| 窗口尺寸比例 | `src/main/index.js` 中各 `createXxxWindow()` 的百分比 |
