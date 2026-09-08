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
  const maxHeight = Math.min(height, flip ? above : below)
  const left = Math.max(padding, Math.min(rect.left, viewportWidth - panelWidth - padding))
  const top = flip
    ? Math.max(padding, rect.top - gap - maxHeight)
    : Math.min(rect.bottom + gap, viewportHeight - padding - maxHeight)
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
    transformOrigin: result.flip ? 'bottom center' : 'top center',
    zIndex: 'var(--z-global-popover)'
  }
}

// Modal focus traps recognize only explicitly owned Teleport surfaces.
const owners = new Map()
export function ownPopover(panel, trigger) {
  if (panel && trigger) owners.set(panel, trigger)
}
export function releasePopover(panel) {
  owners.delete(panel)
}
export function ownedPopovers(root) {
  return [...owners]
    .filter(([panel, trigger]) => panel.isConnected && root.contains(trigger))
    .map(([panel]) => panel)
}
