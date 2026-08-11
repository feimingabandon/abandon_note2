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
  function captureVisibleCardLayout() {
    const container = getContainer()
    if (!container) return new Map()
    return new Map(
      [...container.querySelectorAll(cardSelector)].map((element) => [
        String(element.getAttribute(idAttribute)),
        { element, rect: element.getBoundingClientRect() }
      ])
    )
  }

  function presenceRoot() {
    return getContainer()?.closest(rootSelector) || null
  }

  function animateRemovedCard({ element, rect }, order) {
    const clone = element.cloneNode(true)
    clone.removeAttribute('tabindex')
    clone.setAttribute('aria-hidden', 'true')
    clone.setAttribute('data-presence-clone', '')
    Object.assign(clone.style, {
      position: 'fixed',
      zIndex: 'var(--z-global-presence)',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: '0',
      boxSizing: 'border-box',
      pointerEvents: 'none',
      animation: 'none',
      transition: 'none',
      transformOrigin: 'center center'
    })
    document.body.appendChild(clone)
    detachedClones.add(clone)
    const animation = clone.animate(
      [
        { opacity: 1, translate: '0 0' },
        { opacity: 0, translate: '10px 0' }
      ],
      { duration: 240, delay: Math.min(order, 10) * 36, easing: EASING, fill: 'both' }
    )
    const removeClone = () => {
      detachedClones.delete(clone)
      clone.remove()
    }
    animation.finished.then(removeClone, removeClone)
  }

  function animateRetainedCards(before, { reenterIds = [] } = {}) {
    const after = captureVisibleCardLayout()
    const reenterIdSet = new Set([...reenterIds].map(String))
    let removedIndex = 0
    for (const [id, snapshot] of before) {
      const current = after.get(id)
      if (!current || reenterIdSet.has(id)) {
        animateRemovedCard(snapshot, removedIndex++)
        continue
      }
      const deltaX = snapshot.rect.left - current.rect.left
      const deltaY = snapshot.rect.top - current.rect.top
      if (Math.abs(deltaX) >= 0.5 || Math.abs(deltaY) >= 0.5) {
        current.element.animate([{ translate: `${deltaX}px ${deltaY}px` }, { translate: '0 0' }], {
          duration: 320,
          easing: EASING
        })
      }
    }

    let addedIndex = 0
    for (const [id, current] of after) {
      if (before.has(id) && !reenterIdSet.has(id)) continue
      for (const animation of current.element.getAnimations()) {
        if (animation.id === 'nl-presence-exit') animation.cancel()
      }
      const targetOpacity = getComputedStyle(current.element).opacity
      current.element.animate(
        [
          { opacity: 0, translate: '10px 0' },
          { opacity: targetOpacity, translate: '0 0' }
        ],
        {
          duration: 240,
          delay: Math.min(addedIndex++, 10) * 36,
          easing: EASING,
          fill: 'backwards'
        }
      )
    }
  }

  function animateAuxiliaryIn() {
    for (const element of presenceRoot()?.querySelectorAll(auxiliarySelector) || []) {
      element.animate(
        [
          { opacity: 0, transform: 'translateX(6px)' },
          { opacity: getComputedStyle(element).opacity, transform: 'translateX(0)' }
        ],
        { duration: 220, easing: EASING, fill: 'backwards' }
      )
    }
  }

  function cancelCurrentPresenceExits() {
    const root = presenceRoot()
    if (!root) return
    for (const element of root.querySelectorAll(`${cardSelector}, ${auxiliarySelector}`)) {
      for (const animation of element.getAnimations()) animation.cancel()
    }
  }

  async function animateCurrentCardsOut({ includeAuxiliary = false } = {}) {
    const animations = [...captureVisibleCardLayout().values()].map(({ element }, index) => {
      const animation = element.animate(
        [
          { opacity: getComputedStyle(element).opacity, translate: '0 0' },
          { opacity: 0, translate: '10px 0' }
        ],
        {
          duration: 240,
          delay: Math.min(index, 10) * 36,
          easing: EASING,
          fill: 'forwards'
        }
      )
      animation.id = 'nl-presence-exit'
      return animation
    })
    if (includeAuxiliary) {
      for (const element of presenceRoot()?.querySelectorAll(auxiliarySelector) || []) {
        animations.push(
          element.animate(
            [
              { opacity: getComputedStyle(element).opacity, transform: 'translateX(0)' },
              { opacity: 0, transform: 'translateX(6px)' }
            ],
            { duration: 180, easing: EASING, fill: 'forwards' }
          )
        )
      }
    }
    await Promise.allSettled(animations.map((animation) => animation.finished))
  }

  function disposePresenceMotion() {
    cancelCurrentPresenceExits()
    for (const clone of detachedClones) {
      for (const animation of clone.getAnimations()) animation.cancel()
      clone.remove()
    }
    detachedClones.clear()
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
