/**
 * smoothScroll.js — 全局速度驱动平滑滚动 + 滚动条自动隐现
 *
 * 在 main.js 中 import 一次，自动对所有 overflow-y:auto/scroll 元素生效。
 * 替代 Chrome 原生 ~100px/步的跳跃式滚动，实现逐帧细腻滚动。
 *
 * 原理：
 *   document 级 wheel 拦截 → 向上查找最近的可滚动容器
 *   → 累加到该容器的速度变量 → RAF 循环逐帧衰减位移
 */

/* ---- 可调参数 ---- */
const SCALE = 0.05 // 滚轮灵敏度（越小越细腻，0.05~0.2）
const DECAY = 0.92 // 速度衰减系数（<1，模拟惯性，0.75~0.92）
const MIN_V = 0.25 // 最小速度阈值（低于此值停止 RAF）

/* ---- 滚动条自动隐现 ---- */
let scrollbarTimer = null
const SHOW_SCROLLBAR_DELAY = 800 // 停止滚动后隐藏滚动条的延迟（ms）

function showScrollbar() {
  document.documentElement.classList.add('is-scrolling')
  if (scrollbarTimer) clearTimeout(scrollbarTimer)
  scrollbarTimer = setTimeout(() => {
    document.documentElement.classList.remove('is-scrolling')
    scrollbarTimer = null
  }, SHOW_SCROLLBAR_DELAY)
}

// 监听原生 scroll 事件（覆盖 wheel 驱动 + 拖拽滚动条 + 键盘滚动）
document.addEventListener('scroll', showScrollbar, { passive: true, capture: true })

/* ---- 每个可滚动元素独立的速度状态 ---- */
const states = new WeakMap()

/** 从目标元素向上查找最近的可滚动容器 */
function findScrollContainer(el) {
  while (el && el !== document.documentElement) {
    const s = getComputedStyle(el)
    const oy = s.overflowY
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
      return el
    }
    el = el.parentElement
  }
  return null
}

document.addEventListener(
  'wheel',
  (e) => {
    // 时间滚轮等组件拥有自己的离散对齐器，不能再叠加全局惯性 RAF。
    if (e.target instanceof Element && e.target.closest('[data-scroll-mode="self"]')) return
    const container = findScrollContainer(e.target)
    if (!container) return // 无可滚动容器，走原生行为

    e.preventDefault()

    // 取/建该容器的速度状态
    let st = states.get(container)
    if (!st) {
      st = { v: 0, raf: null }
      states.set(container, st)
    }

    // 归一化 delta
    let d = e.deltaY
    if (e.deltaMode === 1) d *= 20
    else if (e.deltaMode === 2) d *= container.clientHeight
    // 钳制 delta 上限，避免系统鼠标设置差异导致速度突变
    d = Math.sign(d) * Math.min(Math.abs(d), 150)

    st.v += d * SCALE

    if (!st.raf) {
      st.raf = requestAnimationFrame(function step() {
        container.scrollTop += st.v
        st.v *= DECAY

        // 触边时快速衰减
        if (
          container.scrollTop <= 0 ||
          container.scrollTop >= container.scrollHeight - container.clientHeight
        ) {
          st.v *= 0.4
        }

        if (Math.abs(st.v) < MIN_V) {
          st.v = 0
          st.raf = null
          return
        }
        st.raf = requestAnimationFrame(step)
      })
    }
  },
  { passive: false }
)
