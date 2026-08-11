const FOCUSABLE_SELECTOR = [
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function isHTMLElement(value) {
  return typeof HTMLElement !== 'undefined' && value instanceof HTMLElement
}

export function captureFocusedElement() {
  return isHTMLElement(document.activeElement) ? document.activeElement : null
}

export function focusModal(root, preferredSelector = '[data-modal-initial-focus]') {
  if (!root) return
  const preferred = root.querySelector(preferredSelector)
  const target = preferred || root.querySelector(FOCUSABLE_SELECTOR) || root
  if (!isHTMLElement(target)) return
  target.focus({ preventScroll: true })
}

export function restoreFocusedElement(element) {
  if (!isHTMLElement(element) || !element.isConnected) return
  element.focus({ preventScroll: true })
}

export function trapModalTab(event, root) {
  if (event.key !== 'Tab' || !root) return
  const focusable = [...root.querySelectorAll(FOCUSABLE_SELECTOR)].filter(
    (element) => isHTMLElement(element) && element.getClientRects().length > 0
  )
  if (!focusable.length) {
    event.preventDefault()
    root.focus({ preventScroll: true })
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (
    event.shiftKey &&
    (document.activeElement === first || !root.contains(document.activeElement))
  ) {
    event.preventDefault()
    last.focus({ preventScroll: true })
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus({ preventScroll: true })
  }
}
