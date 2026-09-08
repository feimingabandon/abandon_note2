const runningAnimations = new WeakMap()
const OPEN_CLIP = 'inset(0 0 0 0 round 12px)'
const CLOSED_CLIPS = {
  right: 'inset(0 100% 0 0 round 12px)',
  left: 'inset(0 0 0 100% round 12px)',
  bottom: 'inset(0 0 100% 0 round 12px)',
  top: 'inset(100% 0 0 0 round 12px)'
}

export function calendarPreviewPosition(anchor, preview, viewport) {
  const gap = 10
  const edge = 8
  const right = anchor.right + gap
  const left = anchor.left - preview.width - gap
  const below = anchor.bottom + gap
  const above = anchor.top - preview.height - gap
  let placement
  let x
  let y
  if (right + preview.width <= viewport.width - edge) {
    placement = 'right'
    x = right
    y = anchor.top
  } else if (left >= edge) {
    placement = 'left'
    x = left
    y = anchor.top
  } else {
    x = (anchor.left + anchor.right - preview.width) / 2
    if (below + preview.height <= viewport.height - edge) placement = 'bottom'
    else if (above >= edge) placement = 'top'
    else placement = viewport.height - anchor.bottom >= anchor.top ? 'bottom' : 'top'
    y = placement === 'bottom' ? below : above
  }
  return {
    placement,
    left: Math.max(edge, Math.min(x, viewport.width - preview.width - edge)),
    top: Math.max(edge, Math.min(y, viewport.height - preview.height - edge))
  }
}

export function calendarPreviewClips(placement, entering) {
  const closed = CLOSED_CLIPS[placement] || CLOSED_CLIPS.right
  return entering ? [closed, OPEN_CLIP] : [OPEN_CLIP, closed]
}

export function animateCalendarPreview(element, done, placement, entering) {
  const previous = runningAnimations.get(element)
  const [start, end] = calendarPreviewClips(placement, entering)
  // 反向点击时从当前裁剪位置继续，避免先跳回全开或全关。
  const currentClip =
    previous?.playState === 'running'
      ? element.ownerDocument.defaultView.getComputedStyle(element).clipPath
      : null
  previous?.cancel()
  const animation = element.animate(
    [{ clipPath: currentClip && currentClip !== 'none' ? currentClip : start }, { clipPath: end }],
    {
      duration: entering ? 280 : 240,
      easing: entering ? 'cubic-bezier(0.32, 0.72, 0, 1)' : 'ease-out',
      fill: 'both'
    }
  )
  runningAnimations.set(element, animation)
  const finish = () => {
    if (runningAnimations.get(element) !== animation) return
    runningAnimations.delete(element)
    done()
  }
  animation.finished.then(finish, finish)
}
