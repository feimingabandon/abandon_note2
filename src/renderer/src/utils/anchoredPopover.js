/** Fixed-position popovers use CSS pixels, including on scaled Windows displays. */
export function anchoredPopover(
  rect,
  { width, height, viewportWidth, viewportHeight, gap = 6, padding = 8 }
) {
  const availableWidth = Math.max(0, viewportWidth - padding * 2)
  const panelWidth = Math.min(width, availableWidth)
  const below = Math.max(0, viewportHeight - rect.bottom - gap - padding)
  const above = Math.max(0, rect.top - gap - padding)
  const flip = below < height && above > below
  const maxHeight = Math.max(
    0,
    Math.min(height, flip ? above : below, viewportHeight - padding * 2)
  )
  const left = Math.max(padding, Math.min(rect.left, viewportWidth - panelWidth - padding))
  const top = flip
    ? Math.max(padding, rect.top - gap - maxHeight)
    : Math.max(padding, Math.min(rect.bottom + gap, viewportHeight - padding - maxHeight))
  return { left, top, width: panelWidth, maxHeight, flip }
}

export function popoverStyle(rect, width, height) {
  const result = anchoredPopover(rect, {
    width,
    height,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight
  })
  return {
    position: 'fixed',
    left: result.left + 'px',
    top: result.top + 'px',
    width: result.width + 'px',
    maxHeight: result.maxHeight + 'px',
    '--popover-available-height': result.maxHeight + 'px',
    '--popover-placement': result.flip ? 'top' : 'bottom',
    transformOrigin: result.flip ? 'bottom center' : 'top center',
    zIndex: 'var(--z-global-popover)'
  }
}

/** Measure natural content before applying viewport limits, never the last clipped box.
 * Styles are restored synchronously so ResizeObserver sees only the settled layout.
 */
export function measurePopoverContent(panel, width = 'max-content') {
  if (!panel) return null
  const previous = panel.getAttribute('style')
  Object.assign(panel.style, {
    width: typeof width === 'number' ? `${width}px` : width,
    height: 'auto',
    maxHeight: 'none'
  })
  panel.style.setProperty('--popover-available-height', '100000px')
  const rect = panel.getBoundingClientRect()
  // Fractional font metrics must round up; rounding down can wrap just the selected label.
  const size = { width: Math.ceil(rect.width), height: Math.ceil(rect.height) }
  if (previous === null) panel.removeAttribute('style')
  else panel.setAttribute('style', previous)
  return size
}

/** Pointer menus stay next to the requested point and scroll within the viewport. */
export function pointerMenuStyle(x, y, panel) {
  const rect = panel.getBoundingClientRect()
  const width = Math.min(rect.width, Math.max(0, window.innerWidth - 16))
  const height = Math.min(rect.height, Math.max(0, window.innerHeight - 16))
  return {
    left: `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`,
    top: `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`,
    maxWidth: 'calc(100vw - 16px)',
    maxHeight: 'calc(100vh - 16px)',
    '--popover-placement': y + height > window.innerHeight - 8 ? 'top' : 'bottom'
  }
}

// Modal focus traps recognize only explicitly owned Teleport surfaces.
const owners = new Map()
export function ownPopover(panel, trigger) {
  if (panel && trigger) {
    owners.set(panel, trigger)
    inheritPopoverStyle(panel, trigger)
  }
}

/** Teleport must retain local typography, including settings density and size variants. */
export function inheritPopoverStyle(panel, trigger) {
  if (!panel || !trigger) return
  const control = trigger.matches('button, input')
    ? trigger
    : trigger.querySelector('button, input') || trigger
  const style = getComputedStyle(control)
  for (const token of [
    '--font-size-base',
    '--fs-body',
    '--fs-secondary',
    '--fs-title',
    '--text-color',
    '--bg-color'
  ]) {
    const value = style.getPropertyValue(token)
    if (value) panel.style.setProperty(token, value)
  }
  panel.style.fontSize = style.fontSize
  panel.style.fontFamily = style.fontFamily
}

export function observePopover(panel, trigger, update, onHidden) {
  if (!panel || !trigger) return () => {}
  let frame = 0
  const refresh = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      if (onHidden && !isPopoverAnchorVisible(trigger)) {
        onHidden()
        return
      }
      inheritPopoverStyle(panel, trigger)
      update()
    })
  }
  const resize = new ResizeObserver(refresh)
  resize.observe(trigger)
  resize.observe(panel)
  // Filtering can change intrinsic height while the clipped outer box stays unchanged.
  const content = new MutationObserver(refresh)
  content.observe(panel, { childList: true, characterData: true, subtree: true })
  const theme = new MutationObserver(refresh)
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
  window.addEventListener('resize', refresh)
  const scroll = (event) => {
    if (!panel.contains(event.target)) refresh()
  }
  window.addEventListener('scroll', scroll, true)
  return () => {
    cancelAnimationFrame(frame)
    resize.disconnect()
    content.disconnect()
    theme.disconnect()
    window.removeEventListener('resize', refresh)
    window.removeEventListener('scroll', scroll, true)
  }
}
function isPopoverAnchorVisible(trigger) {
  if (!trigger.isConnected || !trigger.getClientRects().length) return false
  const rect = trigger.getBoundingClientRect()
  let left = 0,
    top = 0,
    right = window.innerWidth,
    bottom = window.innerHeight
  for (let parent = trigger.parentElement; parent; parent = parent.parentElement) {
    // The root scrollport clips to the viewport, not body's content-height box.
    if (parent === document.body || parent === document.documentElement) continue
    const style = getComputedStyle(parent)
    const clipX = /(auto|scroll|hidden|clip)/.test(style.overflowX)
    const clipY = /(auto|scroll|hidden|clip)/.test(style.overflowY)
    if (!clipX && !clipY) continue
    const bounds = parent.getBoundingClientRect()
    if (clipX) {
      left = Math.max(left, bounds.left)
      right = Math.min(right, bounds.right)
    }
    if (clipY) {
      top = Math.max(top, bounds.top)
      bottom = Math.min(bottom, bounds.bottom)
    }
  }
  return rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom
}
export function releasePopover(panel) {
  owners.delete(panel)
}
export function ownedPopovers(root) {
  return [...owners]
    .filter(([panel, trigger]) => panel.isConnected && root.contains(trigger))
    .map(([panel]) => panel)
}
