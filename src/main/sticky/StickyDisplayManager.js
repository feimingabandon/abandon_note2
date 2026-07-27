import { DISPLAY_CHANGE_DEBOUNCE_MS } from './stickyConstants.js'

function snapshotDisplay(display) {
  return {
    id: display.id,
    bounds: { ...display.bounds },
    workArea: { ...display.workArea },
    scaleFactor: display.scaleFactor,
    rotation: display.rotation
  }
}

export class StickyDisplayManager {
  constructor(electronScreen, onTopologyChanged) {
    this.screen = electronScreen
    this.onTopologyChanged = onTopologyChanged
    this.snapshots = new Map()
    this.timer = null
    this.listeners = []
  }

  start() {
    this.snapshots = this.readSnapshots()
    for (const eventName of ['display-added', 'display-removed', 'display-metrics-changed']) {
      const listener = () => this.scheduleRefresh()
      this.screen.on(eventName, listener)
      this.listeners.push([eventName, listener])
    }
  }

  readSnapshots() {
    return new Map(
      this.screen.getAllDisplays().map((display) => [display.id, snapshotDisplay(display)])
    )
  }

  scheduleRefresh() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      const previous = this.snapshots
      const current = this.readSnapshots()
      this.snapshots = current
      this.onTopologyChanged?.({ previous, current })
    }, DISPLAY_CHANGE_DEBOUNCE_MS)
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (const [eventName, listener] of this.listeners) {
      this.screen.removeListener(eventName, listener)
    }
    this.listeners = []
  }
}
