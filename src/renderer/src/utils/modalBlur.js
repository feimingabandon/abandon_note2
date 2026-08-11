const targetRetainCounts = new Map()
const UI_BLUR_CLASS = 'is-ui-background-blurred'

function readLayerZIndex(element) {
  const value = Number.parseInt(window.getComputedStyle(element).zIndex, 10)
  return Number.isFinite(value) ? value : 0
}

function findCurrentBackgroundLayer() {
  const layers = [...document.querySelectorAll('[data-modal-layer]')]
  if (layers.length) {
    return layers.reduce((top, layer) => {
      if (!top) return layer
      return readLayerZIndex(layer) >= readLayerZIndex(top) ? layer : top
    }, null)
  }
  return document.querySelector('.app-scene, .month-scene')
}

function retainTarget(target) {
  if (!target) return
  const count = (targetRetainCounts.get(target) || 0) + 1
  targetRetainCounts.set(target, count)
  target.classList.add(UI_BLUR_CLASS)
}

function releaseTarget(target) {
  if (!target) return
  const count = Math.max(0, (targetRetainCounts.get(target) || 0) - 1)
  if (count) {
    targetRetainCounts.set(target, count)
    return
  }
  targetRetainCounts.delete(target)
  target.classList.remove(UI_BLUR_CLASS)
}

/**
 * 模态层打开前锁定当前最上层内容，并返回幂等释放函数。
 * 每个模态根节点使用 data-modal-layer 标记，因此嵌套弹窗只模糊它下面的一层。
 */
export function retainModalBlur() {
  const target = findCurrentBackgroundLayer()
  let released = false
  retainTarget(target)

  return () => {
    if (released) return
    released = true
    releaseTarget(target)
  }
}
