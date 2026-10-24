import { nextTick, onUnmounted, ref } from 'vue'

/** Read policy belongs to the view; actual Transition completion owns image retirement. */
export function useWorkspaceWallpaper({
  defaults,
  cacheLoads = false,
  label,
  api = window.api,
  documentTarget = document
}) {
  const wallpaperUrl = ref('')
  const wallpaperVisible = ref(false)
  const wallpaperBlurRadius = ref(defaults.wallpaper.blurRadius)
  const wallpaperRenderKey = ref(null)
  const elements = new Map()
  const leaves = new Map()
  const subscriptions = []
  let sequence = 0
  let renderGeneration = 0
  let loadedId = null
  let pendingId = null
  let pendingLoad = null
  let desiredVisible = false
  let desiredId = null
  let hasSnapshot = false
  let hiddenSnapshotObserved = false
  let retirement = null
  let disposed = false

  const readElements = () =>
    Array.from(documentTarget.querySelectorAll('.app-wallpaper, .month-wallpaper'))

  function clearData() {
    wallpaperUrl.value = ''
    wallpaperRenderKey.value = null
    loadedId = null
  }

  function releaseElement(element) {
    element
      .querySelector('.app-wallpaper-image, .month-wallpaper-image')
      ?.style.removeProperty('background-image')
  }

  function finishRetirement(ticket, outcome, reason, acknowledge = true) {
    if (!ticket || ticket.done) return
    ticket.done = true
    if (retirement === ticket) retirement = null
    ticket.pendingElements.clear()
    for (const leave of leaves.values()) if (leave.ticket === ticket) leave.ticket = null
    if (!acknowledge || disposed) return
    try {
      Promise.resolve(
        api.acknowledgeWallpaperRetirement({
          id: ticket.id,
          outcome,
          ...(reason ? { reason } : {})
        })
      ).catch((error) => console.warn(`[${label}] 确认壁纸退场失败:`, error))
    } catch (error) {
      console.warn(`[${label}] 确认壁纸退场失败:`, error)
    }
  }

  async function settleHidden(expectedSequence, expectedGeneration, ticket) {
    await nextTick()
    if (
      disposed ||
      expectedSequence !== sequence ||
      desiredVisible ||
      wallpaperVisible.value ||
      readElements().length ||
      leaves.size
    )
      return
    // Replacement layers can finish in either order. Once every owned node has
    // left, the current hidden image is also retired even if an older layer
    // delivered the final callback. A live newer owner still blocks clearing.
    if (expectedGeneration === renderGeneration || elements.size === 0) clearData()
    // A request alone never proves absence: first observe a hidden snapshot,
    // finish its DOM update, and account for every captured element/leave.
    if (
      hiddenSnapshotObserved &&
      retirement === ticket &&
      ticket &&
      !ticket.done &&
      ticket.pendingElements.size === 0
    )
      finishRetirement(ticket, ticket.leftElements > 0 ? 'left' : 'absent')
  }

  function requestRetirement(payload) {
    if (disposed || typeof payload?.id !== 'string' || !payload.id) return
    if (retirement?.id === payload.id) return
    finishRetirement(retirement, 'cancelled', 'retirement-replaced')
    const ticket = {
      id: payload.id,
      done: false,
      pendingElements: new Set(readElements()),
      leftElements: 0
    }
    retirement = ticket
    // A new request can own an already running leave, but the callback still
    // carries that exact element/leave record rather than reading a global id.
    for (const [element, leave] of leaves) {
      ticket.pendingElements.add(element)
      leave.ticket = ticket
    }
    void settleHidden(sequence, renderGeneration, ticket)
  }

  function cancelRetirement(payload) {
    if (retirement?.id === payload?.id)
      finishRetirement(retirement, 'cancelled', payload.reason, false)
  }

  for (const [register, callback] of [
    [api.onWallpaperRetirementRequested, requestRetirement],
    [api.onWallpaperRetirementCancelled, cancelRetirement]
  ]) {
    if (typeof register !== 'function') continue
    const stop = register(callback)
    if (typeof stop === 'function') subscriptions.push(stop)
  }

  // Each render supplies a distinct closure to Vue's Transition. An old
  // after-leave/leave-cancelled cannot consume a later leave of the same node.
  function transitionHooks() {
    const ownedLeaves = new WeakMap()
    const generation = renderGeneration
    const key = wallpaperRenderKey.value
    return {
      onBeforeEnter(element) {
        if (disposed) return
        const oldLeave = leaves.get(element)
        if (oldLeave) {
          leaves.delete(element)
          finishRetirement(oldLeave.ticket, 'cancelled', 'leave-reversed')
        }
        elements.set(element, { generation, key })
      },
      onBeforeLeave(element) {
        if (disposed) return
        const oldLeave = leaves.get(element)
        if (oldLeave) finishRetirement(oldLeave.ticket, 'cancelled', 'leave-replaced')
        const owner = elements.get(element) || { generation, key }
        elements.set(element, owner)
        const ticket = retirement
        const leave = { owner, ticket }
        leaves.set(element, leave)
        ownedLeaves.set(element, leave)
        ticket?.pendingElements.add(element)
      },
      onAfterLeave(element) {
        const leave = ownedLeaves.get(element)
        if (disposed || !leave || leaves.get(element) !== leave) return
        leaves.delete(element)
        if (elements.get(element) === leave.owner) {
          elements.delete(element)
          releaseElement(element)
        }
        const ticket = leave.ticket
        if (ticket && !ticket.done) {
          ticket.pendingElements.delete(element)
          ticket.leftElements += 1
        }
        void settleHidden(sequence, leave.owner.generation, ticket)
      },
      onLeaveCancelled(element) {
        const leave = ownedLeaves.get(element)
        if (disposed || !leave || leaves.get(element) !== leave) return
        leaves.delete(element)
        finishRetirement(leave.ticket, 'cancelled', 'leave-cancelled')
      }
    }
  }

  async function sync(snapshot) {
    if (disposed) return
    const currentSequence = ++sequence
    const wallpaper = snapshot?.values?.wallpaper || defaults.wallpaper
    wallpaperBlurRadius.value = wallpaper.blurRadius
    const visible = Boolean(
      wallpaper.enabled && wallpaper.activeId && !snapshot?.runtime?.blur?.effectiveEnabled
    )
    const requestedId = visible ? Number(wallpaper.activeId) : null
    if (visible && hasSnapshot && (!desiredVisible || desiredId !== requestedId))
      finishRetirement(retirement, 'cancelled', 'wallpaper-shown-or-replaced')
    hasSnapshot = true
    hiddenSnapshotObserved = snapshot?.values?.wallpaper?.enabled === false
    desiredVisible = visible
    desiredId = requestedId
    if (!visible) {
      wallpaperVisible.value = false
      void settleHidden(currentSequence, renderGeneration, retirement)
      return
    }
    if (cacheLoads && loadedId === requestedId && wallpaperUrl.value) {
      if (!wallpaperVisible.value) renderGeneration += 1
      wallpaperVisible.value = true
      return
    }
    let currentLoad
    try {
      if (!cacheLoads || pendingId !== requestedId || !pendingLoad) {
        pendingId = requestedId
        pendingLoad = api.getWallpaperData(requestedId, false)
      }
      currentLoad = pendingLoad
      const data = await currentLoad
      if (currentLoad === pendingLoad) {
        pendingId = null
        pendingLoad = null
      }
      if (disposed || currentSequence !== sequence) return
      if (!data) {
        desiredVisible = false
        wallpaperVisible.value = false
        void settleHidden(currentSequence, renderGeneration, retirement)
        return
      }
      renderGeneration += 1
      // A fresh calendar read of the same id patches the existing node rather
      // than entering a new one. Its later leave owns this newer image too.
      for (const [element, owner] of elements)
        if (owner.key === requestedId && !leaves.has(element)) owner.generation = renderGeneration
      wallpaperUrl.value = data
      wallpaperRenderKey.value = requestedId
      loadedId = requestedId
      wallpaperVisible.value = true
    } catch (error) {
      if (currentLoad === pendingLoad) {
        pendingId = null
        pendingLoad = null
      }
      if (!disposed && currentSequence === sequence) {
        desiredVisible = false
        wallpaperVisible.value = false
        void settleHidden(currentSequence, renderGeneration, retirement)
      }
      console.warn(`[${label}] 读取壁纸失败:`, error)
    }
  }

  onUnmounted(() => {
    disposed = true
    sequence += 1
    finishRetirement(retirement, 'cancelled', 'unmounted', false)
    for (const stop of subscriptions.splice(0)) stop()
    for (const element of elements.keys()) releaseElement(element)
    elements.clear()
    leaves.clear()
    pendingId = null
    pendingLoad = null
    wallpaperVisible.value = false
    clearData()
  })
  return {
    wallpaperUrl,
    wallpaperVisible,
    wallpaperBlurRadius,
    wallpaperRenderKey,
    transitionHooks,
    sync
  }
}
