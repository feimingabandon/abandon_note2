import { nextTick, onBeforeUnmount, watch } from 'vue'
import { ownPopover, releasePopover, observePopover } from '../utils/anchoredPopover.js'
import { cancelPopover } from '../utils/popoverMotion.js'
import { trapModalTab } from '../utils/modalFocus.js'
import { isComposingInput } from '../utils/inputComposition.js'

/** Shared ownership, geometry observers and keyboard lifetime for Teleported controls. */
export function usePopoverLifecycle(
  open,
  anchor,
  panel,
  update,
  { dialog = false, focus = false } = {}
) {
  let cleanup = () => {}
  let ownedPanel = null
  let returnFocus = null
  function release() {
    cleanup()
    releasePopover(ownedPanel)
    ownedPanel = null
  }
  function close(restore = false) {
    open.value = false
    if (restore) {
      const target = returnFocus?.isConnected
        ? returnFocus
        : anchor.value?.querySelector('button, input') || anchor.value
      target?.focus({ preventScroll: true })
    }
  }
  watch(open, async (visible, _, onCleanup) => {
    let cancelled = false
    onCleanup(() => {
      cancelled = true
    })
    release()
    if (!visible) return
    returnFocus = document.activeElement
    await nextTick()
    if (cancelled || !open.value || !panel.value) return
    ownedPanel = panel.value
    ownPopover(ownedPanel, anchor.value)
    update()
    cleanup = observePopover(ownedPanel, anchor.value, update, () => close())
    if (focus) {
      // Some listboxes use aria-activedescendant; their selected rows are not focusable.
      const target =
        panel.value.querySelector(
          '[aria-selected="true"]:is(button, input, [tabindex]):not(:disabled)'
        ) ||
        panel.value.querySelector('button:not(:disabled), input:not(:disabled), [tabindex="0"]')
      target?.focus({ preventScroll: true })
    }
  })
  function onKeydown(event) {
    if (isComposingInput(event)) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
    } else if (dialog && event.key === 'Tab') {
      trapModalTab(event, panel.value)
      event.stopPropagation()
    } else {
      const grid = event.target.closest?.('[data-popover-grid]')
      if (
        !grid ||
        !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
      )
        return
      const items = [...grid.querySelectorAll('button')]
      const index = items.indexOf(document.activeElement)
      if (index < 0) return
      event.preventDefault()
      const columns = Number(grid.dataset.popoverGrid) || 7
      const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }
      const next =
        event.key === 'Home'
          ? index - (index % columns)
          : event.key === 'End'
            ? Math.min(items.length - 1, index + columns - 1 - (index % columns))
            : index + delta[event.key]
      if (next >= 0 && next < items.length && !items[next].disabled) items[next].focus()
    }
  }
  onBeforeUnmount(() => {
    cancelPopover(ownedPanel)
    release()
  })
  return { close, onKeydown }
}
