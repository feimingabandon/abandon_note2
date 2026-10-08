const EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'
const AUXILIARY_SELECTOR =
  '.nl-group-label-row, .nl-zone-label, .nl-tag-group-header, .nl-footer-count'

/** 便签列表的 FLIP、依次进出场与辅助文字动画。 */
export function useNotePresenceMotion(
  getContainer,
  {
    cardSelector = '.nl-card[data-note-id]',
    idAttribute = 'data-note-id',
    rootSelector = '.note-list',
    auxiliarySelector = AUXILIARY_SELECTOR
  } = {}
) {
  const detachedClones = new Set()
  const motions = new Set()
  const layoutMotions = new Set()
  const auxiliaryMotions = new Set()
  const EXIT_MS = 140
  function track(animation, registry = motions, persist = false) {
    registry.add(animation)
    animation.finished.then(
      // Filled exits must remain cancellable after they finish (e.g. a failed
      // refresh restores the same elements instead of replacing them).
      () => {
        if (!persist) registry.delete(animation)
      },
      () => registry.delete(animation)
    )
    return animation
  }
  function cancelRegistry(registry) {
    for (const animation of registry) animation.cancel()
    registry.clear()
  }
  function cancelCardMotions() {
    cancelRegistry(motions)
    cancelRegistry(layoutMotions)
    clearDetachedLayers()
  }
  function cancelMotions() {
    cancelCardMotions()
    cancelRegistry(auxiliaryMotions)
  }
  function visibleBounds(container) {
    let bounds = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
    for (let node = container; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        bounds.left = Math.max(bounds.left, rect.left + node.clientLeft)
        bounds.right = Math.min(bounds.right, rect.left + node.clientLeft + node.clientWidth)
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        bounds.top = Math.max(bounds.top, rect.top + node.clientTop)
        bounds.bottom = Math.min(bounds.bottom, rect.top + node.clientTop + node.clientHeight)
      }
    }
    return bounds
  }
  const intersects = (rect, clip) =>
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > clip.left &&
    rect.left < clip.right &&
    rect.bottom > clip.top &&
    rect.top < clip.bottom
  function captureVisibleCardLayout() {
    const container = getContainer()
    if (!container) return new Map()
    const clip = visibleBounds(container)
    return new Map(
      [...container.querySelectorAll(cardSelector)].map((element) => {
        const rect = element.getBoundingClientRect()
        // Snapshot before Vue removes the card, including local typography and pixels.
        const style = getComputedStyle(element)
        const noteId = String(element.getAttribute(idAttribute))
        const disclosing = Boolean(element.closest('[data-list-disclosure-moving]'))
        return [
          noteId,
          {
            element,
            noteId,
            disclosing,
            rect,
            clip,
            visible: intersects(rect, clip),
            clone: !disclosing && intersects(rect, clip) ? element.cloneNode(true) : null,
            fontSize: style.fontSize,
            opacity: style.opacity,
            tokens: Object.fromEntries(
              ['--font-size-base', '--fs-body', '--fs-secondary'].map((k) => [
                k,
                style.getPropertyValue(k)
              ])
            )
          }
        ]
      })
    )
  }

  function presenceRoot() {
    return getContainer()?.closest(rootSelector) || null
  }

  function animateRemovedCard({ clone, rect, clip, fontSize, tokens, opacity }, translateX) {
    if (!clone) return
    const layer = document.createElement('div')
    layer.setAttribute('data-presence-layer', '')
    Object.assign(layer.style, {
      position: 'fixed',
      zIndex: 'var(--z-global-presence)',
      left: clip.left + 'px',
      top: clip.top + 'px',
      width: Math.max(0, clip.right - clip.left) + 'px',
      height: Math.max(0, clip.bottom - clip.top) + 'px',
      overflow: 'hidden',
      pointerEvents: 'none',
      fontSize
    })
    for (const [key, value] of Object.entries(tokens)) layer.style.setProperty(key, value)
    clone.removeAttribute('tabindex')
    clone.setAttribute('aria-hidden', 'true')
    clone.setAttribute('data-presence-clone', '')
    Object.assign(clone.style, {
      position: 'absolute',
      left: `${rect.left - clip.left}px`,
      top: `${rect.top - clip.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: '0',
      boxSizing: 'border-box',
      pointerEvents: 'none',
      animation: 'none',
      transition: 'none',
      transformOrigin: 'center center'
    })
    layer.appendChild(clone)
    document.body.appendChild(layer)
    detachedClones.add(layer)
    const animation = track(
      clone.animate(
        [
          { opacity, translate: '0 0' },
          { opacity: 0, translate: `${translateX}px 0` }
        ],
        { duration: EXIT_MS, easing: EASING, fill: 'both' }
      )
    )
    const removeClone = () => {
      detachedClones.delete(layer)
      layer.remove()
    }
    animation.finished.then(removeClone, removeClone)
  }

  function animateRetainedCards(
    before,
    { reenterIds = [], exitTranslateX = 0, enterTranslateX = 4 } = {}
  ) {
    // Freeze the previous visible positions, then replace our own animations only.
    // A new query must not leave the preceding query's body clones alive.
    cancelCardMotions()
    const after = captureVisibleCardLayout()
    const reenterIdSet = new Set([...reenterIds].map(String))
    const hasVisibleExits = [...before].some(
      ([id, snapshot]) =>
        snapshot.visible &&
        !snapshot.disclosing &&
        (!after.has(id) || reenterIdSet.has(snapshot.noteId))
    )
    // Let removed cards fade in their old slots before retained/new cards occupy
    // those slots. Simultaneous exits and FLIP movement visibly double the text.
    const settleDelay = hasVisibleExits ? EXIT_MS : 0
    for (const [id, snapshot] of before) {
      const current = after.get(id)
      if (snapshot.disclosing || current?.disclosing) continue
      if (!current || reenterIdSet.has(snapshot.noteId)) {
        animateRemovedCard(snapshot, exitTranslateX)
        continue
      }
      if (!snapshot.visible || !current.visible) continue
      const deltaX = snapshot.rect.left - current.rect.left
      const deltaY = snapshot.rect.top - current.rect.top
      if (
        Math.abs(deltaX) >= 0.5 ||
        Math.abs(deltaY) >= 0.5 ||
        Math.abs(Number(snapshot.opacity) - Number(current.opacity)) > 0.01
      ) {
        track(
          current.element.animate(
            [
              { translate: `${deltaX}px ${deltaY}px`, opacity: snapshot.opacity },
              { translate: '0 0', opacity: current.opacity }
            ],
            {
              duration: 260,
              delay: settleDelay,
              easing: EASING,
              fill: 'backwards'
            }
          ),
          layoutMotions
        )
      }
    }

    let addedIndex = 0
    for (const [id, current] of after) {
      const retained = before.has(id) && !reenterIdSet.has(current.noteId)
      // Ordinary reorder/refresh must not replay entry for existing cards.
      // Only newly exposed cards behind a visible exit need to wait for its fade.
      if (
        current.disclosing ||
        !current.visible ||
        (retained && (before.get(id).visible || !hasVisibleExits))
      )
        continue
      const targetOpacity = getComputedStyle(current.element).opacity
      track(
        current.element.animate(
          [
            { opacity: 0, translate: `${enterTranslateX}px 0` },
            { opacity: targetOpacity, translate: '0 0' }
          ],
          {
            duration: 200,
            delay: settleDelay + Math.min(addedIndex++, 4) * 16,
            easing: EASING,
            fill: 'backwards'
          }
        )
      )
    }
  }

  function animateAuxiliaryIn() {
    cancelRegistry(auxiliaryMotions)
    for (const element of presenceRoot()?.querySelectorAll(auxiliarySelector) || []) {
      track(
        element.animate(
          [
            { opacity: 0, transform: 'translateX(6px)' },
            { opacity: getComputedStyle(element).opacity, transform: 'translateX(0)' }
          ],
          { duration: 220, easing: EASING, fill: 'backwards' }
        ),
        auxiliaryMotions
      )
    }
  }

  function cancelCurrentPresenceExits() {
    cancelMotions()
  }

  async function animateCurrentCardsOut({ includeAuxiliary = false } = {}) {
    cancelMotions()
    const animations = [...captureVisibleCardLayout().values()]
      .filter(({ visible }) => visible)
      .map(({ element }) => {
        const animation = track(
          element.animate(
            [
              { opacity: getComputedStyle(element).opacity, translate: '0 0' },
              { opacity: 0, translate: '4px 0' }
            ],
            {
              duration: 160,
              easing: EASING,
              fill: 'forwards'
            }
          ),
          motions,
          true
        )
        animation.id = 'nl-presence-exit'
        return animation
      })
    if (includeAuxiliary) {
      for (const element of presenceRoot()?.querySelectorAll(auxiliarySelector) || []) {
        animations.push(
          track(
            element.animate(
              [
                { opacity: getComputedStyle(element).opacity, transform: 'translateX(0)' },
                { opacity: 0, transform: 'translateX(6px)' }
              ],
              { duration: 180, easing: EASING, fill: 'forwards' }
            ),
            auxiliaryMotions,
            true
          )
        )
      }
    }
    await Promise.allSettled(animations.map((animation) => animation.finished))
  }

  function clearDetachedLayers() {
    for (const layer of detachedClones) {
      for (const animation of layer.getAnimations({ subtree: true })) animation.cancel()
      layer.remove()
    }
    detachedClones.clear()
  }
  // Live cards move with their scroll container. Only viewport-fixed exit
  // copies become stale on scroll; never abort entry for a layout-generated scroll.
  window.addEventListener('scroll', clearDetachedLayers, true)
  function onResize() {
    clearDetachedLayers()
    cancelRegistry(layoutMotions)
  }
  window.addEventListener('resize', onResize)

  function disposePresenceMotion() {
    window.removeEventListener('scroll', clearDetachedLayers, true)
    window.removeEventListener('resize', onResize)
    cancelCurrentPresenceExits()
  }

  return {
    captureVisibleCardLayout,
    animateRetainedCards,
    animateAuxiliaryIn,
    cancelCurrentPresenceExits,
    animateCurrentCardsOut,
    disposePresenceMotion
  }
}
