/**
 * ============================================================
 * fontUtils.js — 字体大小相关工具函数与常量
 * ============================================================
 * 集中管理字体 CSS 变量的 clamp 配置和应用逻辑。
 * 所有窗口（主窗口、灵动岛、两个设置窗口）共用此模块，
 * 修改 clamp 上下限或比例系数只需改这一处。
 *
 * 使用方 → App.vue / IslandApp.vue / SettingsApp.vue / IslandSettingsApp.vue
 */

/**
 * 字体配置常量
 * - ratio: 相对于基准字号的倍率
 * - min:   clamp 最小值（px），防止缩放过小导致不可读
 * - max:   clamp 最大值（px），防止缩放过大溢出布局
 * - varName: 对应的 CSS 变量名
 */
export const FONT_CONFIG = {
  base: {
    varName: '--font-size-base',
    ratio: 1,
    min: 8,
    max: 40
  },
  title: {
    varName: '--font-size-title',
    ratio: 1.5,
    min: 12,
    max: 60
  },
  caption: {
    varName: '--font-size-caption',
    ratio: 0.85,
    min: 7,
    max: 34
  }
}

/** 字体大小的允许范围（滑动条 / 输入框共用） */
export const FONT_SIZE_MIN = 8
export const FONT_SIZE_MAX = 32

/** 默认字号（rem 值），对应 base.css 中 :root 的初始 14rem */
export const FONT_SIZE_DEFAULT = 14

/**
 * 将字号值限制在合法范围内
 * @param {number} val - 用户输入的字号值
 * @returns {number} 限制后的值
 */
export function clampFontSize(val) {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Number(val)))
}

/**
 * 根据 size（rem 值）生成某个字体变量的 clamp 表达式
 * @param {object} config - FONT_CONFIG 中的某一项（base / title / caption）
 * @param {number} size   - 基准字号（rem 值，如 14）
 * @returns {string} CSS clamp 表达式，如 "clamp(8px, 14rem, 40px)"
 */
function buildClampValue(config, size) {
  const { ratio, min, max } = config
  if (ratio === 1) {
    // 基准字号：直接使用 size rem
    return `clamp(${min}px, ${size}rem, ${max}px)`
  }
  // 派生字号：使用 calc(size rem * ratio)
  return `clamp(${min}px, calc(${size}rem * ${ratio}), ${max}px)`
}

/**
 * 将字号应用到当前窗口的 CSS 变量
 * 更新 :root 上的 --font-size-base / --font-size-title / --font-size-caption
 *
 * 被以下场景调用：
 *   1. 主窗口 / 灵动岛 接收到 IPC 字号变更通知后调用
 *   2. 设置窗口 watch(fontSize) 时更新本窗口预览
 *
 * @param {number} size - 基准字号（rem 值，如 14）
 */
export function applyFontSize(size) {
  const el = document.documentElement
  Object.values(FONT_CONFIG).forEach((config) => {
    el.style.setProperty(config.varName, buildClampValue(config, size))
  })
}
