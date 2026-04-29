/**
 * ============================================================
 * fontUtils.js — 字体大小相关工具函数与常量（渲染进程公共模块）
 * ============================================================
 * 在 Electron 链路中的角色：
 *   渲染进程的「字体工具层」，被所有四个窗口的 Vue 组件共用。
 *   集中管理字体 CSS 变量的 clamp 配置和应用逻辑，
 *   修改 clamp 上下限或比例系数只需改这一处。
 *
 * 类比 Java：
 *   相当于一个纯工具类 FontUtils.java，提供 static 方法，
 *   不持有状态，被各个 Controller / Service 调用。
 *
 * 使用方 → composables/useFontSize.js（Composable 层）
 *         → App.vue / IslandApp.vue / SettingsApp.vue / IslandSettingsApp.vue（组件层）
 */

/**
 * 字体配置常量表
 *
 * 定义了七档字体的参数，用于生成 CSS clamp() 表达式。
 * 当用户通过设置窗口调整字号时，applyFontSize() 会遍历此表，
 * 为每一档重新计算 clamp 值并写入 CSS 变量。
 *
 * 各字段说明：
 * - varName: 对应的 CSS 变量名（写入到 document.documentElement.style 上）
 * - ratio:   相对于基准字号的倍率（Apple 17px body 为 1.0×）
 * - min:     clamp 最小值（px），极端窗口缩小时的可读性保障
 * - max:     clamp 最大值（px），极端窗口放大时的上限保护
 *
 * Apple 原始比例参考（以 17px body = 1.0×）：
 *   Display 56px → 3.29×    H1 40px → 2.35×
 *   H2 28px → 1.65×         H3 21px → 1.24×
 *   Body 17px → 1.0×        Caption 14px → 0.82×
 *   Micro 12px → 0.71×
 *
 * 类比 Java：相当于一个枚举类 FontTier，每个枚举值包含配置字段：
 *   enum FontTier {
 *     DISPLAY("--fs-display", 3.29, 20, 96),
 *     H1("--fs-h1", 2.35, 16, 72),
 *     ...
 *   }
 */
export const FONT_CONFIG = {
  display: {
    varName: '--fs-display',
    ratio: 3.29,    // Display — 超大标题/Hero
    min: 20,        // 最小 20px
    max: 96         // 最大 96px
  },
  h1: {
    varName: '--fs-h1',
    ratio: 2.35,    // H1 — 一级标题
    min: 16,
    max: 72
  },
  h2: {
    varName: '--fs-h2',
    ratio: 1.65,    // H2 — 二级标题
    min: 13,
    max: 52
  },
  h3: {
    varName: '--fs-h3',
    ratio: 1.24,    // H3 — 三级标题
    min: 11,
    max: 42
  },
  body: {
    varName: '--fs-body',
    ratio: 1,       // Body — 正文（基准字号，倍率 1:1）
    min: 11,        // 最小 11px（保证可读性）
    max: 40
  },
  caption: {
    varName: '--fs-caption',
    ratio: 0.82,    // Caption — 辅助文字
    min: 9,         // 最小 9px
    max: 34
  },
  micro: {
    varName: '--fs-micro',
    ratio: 0.71,    // Micro — 极小文字/脚注
    min: 8,
    max: 28
  }
}

/**
 * 字体大小的允许范围（滑动条 / 输入框共用）
 * 用户无法将字号调到此范围之外。
 * 范围扩大到 10-36，因为 base-raw 从 14 调到了 17，
 * 用户可能需要更大的调整空间。
 */
export const FONT_SIZE_MIN = 10
export const FONT_SIZE_MAX = 36

/**
 * 默认字号（rem 值），与 base.css 中 --font-size-base-raw: 17 保持一致。
 * 仅作为 readFontSizeFromCSS() 解析失败时的安全兜底。
 * 正常情况下不会用到，因为 base.css 中的值会被优先读取。
 */
export const FONT_SIZE_DEFAULT = 17

/**
 * 从 CSS 变量 --font-size-base-raw 读取默认 rem 基准值
 *
 * base.css 中定义了 :root { --font-size-base-raw: 17; }，
 * 此函数在 Vue 应用初始化时调用，确保 JS 状态与 CSS 默认值一致（单一真相源）。
 * 如果将来设计师在 CSS 中把默认值改为其他数字，JS 端无需同步改动。
 *
 * 执行时机：
 *   useFontSizeEditor() 初始化时调用，即设置窗口打开时。
 *
 * 关键 API 说明：
 *   getComputedStyle(element) — 浏览器 API，获取元素最终计算后的所有 CSS 属性值
 *     类似 Java 中通过反射获取组件的实际渲染属性
 *   .getPropertyValue('--xxx') — 读取指定 CSS 变量的值，返回字符串
 *   .trim() — 去除字符串两端空格，类似 Java 的 String.trim()
 *   parseFloat(str) — 将字符串转为浮点数，类似 Java 的 Double.parseDouble()
 *   Number.isNaN(val) — 检查是否为 NaN（Not a Number），类似 Java 的 Double.isNaN()
 *
 * @returns {number} 读取到的 rem 值，解析失败时返回 FONT_SIZE_DEFAULT (17)
 */
export function readFontSizeFromCSS() {
  try {
    // document.documentElement 是 <html> 元素，即 CSS :root 选择器指向的节点
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--font-size-base-raw')
      .trim()

    // parseFloat('17') → 17，parseFloat('abc') → NaN
    const val = parseFloat(raw)

    // 确保是有效的正数后，再通过 clampFontSize 限制在合法范围内
    if (!Number.isNaN(val) && val > 0) {
      return clampFontSize(val)
    }
  } catch {
    // DOM 不可用时降级（比如在 Node.js 环境中运行测试时）
  }
  return FONT_SIZE_DEFAULT
}

/**
 * 将字号值限制在合法范围 [FONT_SIZE_MIN, FONT_SIZE_MAX] 内
 *
 * 类似 Java 中：Math.min(max, Math.max(min, value))
 *
 * Number(val) — 强制类型转换，确保参数是数字
 *   类似 Java 的 Integer.parseInt() 或自动拆箱
 * Math.max(a, b) — 返回较大值，Math.min(a, b) — 返回较小值
 *   与 Java 的 Math.max / Math.min 完全一样
 *
 * @param {number} val - 用户输入的字号值（可能超出合法范围）
 * @returns {number} 限制后的值，保证在 [10, 36] 之间
 */
export function clampFontSize(val) {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Number(val)))
}

/**
 * 根据 size（rem 值）生成某个字体变量的 CSS clamp() 表达式
 *
 * clamp(最小值, 理想值, 最大值) 是 CSS 函数：
 *   - 当理想值 < 最小值时，取最小值
 *   - 当理想值 > 最大值时，取最大值
 *   - 其他情况取理想值
 *   类似 Java 中的 MathUtils.clamp(value, min, max)
 *
 * @param {object} config - FONT_CONFIG 中的某一项
 * @param {number} size   - 基准字号（rem 值，如 17）
 * @returns {string} CSS clamp 表达式，如 "clamp(11px, 17rem, 40px)"
 */
function buildClampValue(config, size) {
  const { ratio, min, max } = config  // 解构赋值，类似 Java 的 getter

  if (ratio === 1) {
    // 基准字号（body）：直接使用 size rem，无需乘以比例
    return `clamp(${min}px, ${size}rem, ${max}px)`
  }
  // 派生字号（display/h1/h2/h3/caption/micro）：使用 calc() 计算 size * ratio
  // 模板字符串 `...${变量}...` 类似 Java 的 String.format() 或 "..." + var + "..."
  return `clamp(${min}px, calc(${size}rem * ${ratio}), ${max}px)`
}

/**
 * 将字号应用到当前窗口的 CSS 变量
 *
 * 遍历 FONT_CONFIG 中的七档字体（display/h1/h2/h3/body/caption/micro），
 * 为每一档生成 clamp 表达式并写入 :root 的 CSS 变量。
 *
 * 执行时机（被以下场景调用）：
 *   1. 主窗口 / 灵动岛窗口 接收到 IPC 字号变更通知后，实时更新本窗口字体
 *   2. 设置窗口 watch(fontSize) 触发时，更新本窗口的预览效果
 *   3. 窗口启动时从数据库拉取持久化字号后，恢复上次的字体大小
 *
 * 关键 API 说明：
 *   document.documentElement — <html> 元素，即 CSS :root
 *   Object.values(obj) — 返回对象所有值的数组，类似 Java 的 map.values()
 *   .forEach(fn) — 遍历数组并对每个元素执行 fn，类似 Java 的 List.forEach()
 *   el.style.setProperty(name, value) — 设置元素的内联 CSS 变量
 *     类似 Java Swing 中 component.setFont(new Font(...))
 *
 * @param {number} size - 基准字号（rem 值，如 17）
 */
export function applyFontSize(size) {
  // document.documentElement 就是 <html> 标签，对应 CSS 中的 :root 选择器
  const el = document.documentElement

  // Object.values(FONT_CONFIG) 返回 [display, h1, h2, h3, body, caption, micro]
  Object.values(FONT_CONFIG).forEach((config) => {
    // setProperty 会在 <html> 元素上添加内联样式，覆盖 base.css 中的默认值
    el.style.setProperty(config.varName, buildClampValue(config, size))
  })
}
