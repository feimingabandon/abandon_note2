/**
 * 浮动弹层统一动效。
 * menu / dropdown：锚点淡入和轻微位移，不拉伸文字；
 * reveal：大面板从触发器方向裁剪揭示，不拉伸文字。
 */
const runningAnimations = new WeakMap()

function frames(el, kind) {
  const style = getComputedStyle(el)
  const placement = style.getPropertyValue('--popover-placement').trim() || 'bottom'
  const offset = { top: '0, 4px', bottom: '0, -4px', left: '4px, 0', right: '-4px, 0' }
  const closed = { opacity: 0, transform: `translate(${offset[placement] || offset.bottom})` }
  const opened = { opacity: 1, transform: 'translate(0, 0)' }
  if (kind === 'reveal') {
    const clips = {
      top: '100% 0 0 0',
      bottom: '0 0 100% 0',
      left: '0 0 0 100%',
      right: '0 100% 0 0'
    }
    closed.clipPath = `inset(${clips[placement] || clips.bottom} round 10px)`
    opened.clipPath = 'inset(0 0 0 0 round 10px)'
  }
  return { closed, opened }
}

export function cancelPopover(el) {
  const animation = runningAnimations.get(el)
  runningAnimations.delete(el)
  animation?.cancel()
}

function run(el, done, kind, direction) {
  const { closed, opened } = frames(el, kind)
  const previous = runningAnimations.get(el)
  // Read before cancellation so a reversal starts at the visible frame.
  const style = previous ? getComputedStyle(el) : null
  const entering = direction === 'enter'
  const from = style
    ? Object.fromEntries(Object.keys(opened).map((key) => [key, style[key]]))
    : entering
      ? closed
      : opened
  cancelPopover(el)
  el.style.pointerEvents = entering ? '' : 'none'
  if (!el.animate) {
    done()
    return
  }
  const animation = el.animate([from, entering ? opened : closed], {
    duration: entering ? 180 : 140,
    easing: entering ? 'cubic-bezier(0.32, 0.72, 0, 1)' : 'ease-out',
    fill: 'both'
  })
  runningAnimations.set(el, animation)

  const finish = () => {
    // 快速反向开合时，已取消动画不能结束当前过渡。
    if (runningAnimations.get(el) !== animation) return
    runningAnimations.delete(el)
    done()
    animation.cancel()
  }
  animation.finished.then(finish, () => {})
}

export function enterPopover(el, done, kind = 'menu') {
  run(el, done, kind, 'enter')
}

export function leavePopover(el, done, kind = 'menu') {
  run(el, done, kind, 'leave')
}
