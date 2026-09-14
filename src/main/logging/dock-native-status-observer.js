const SIGNATURE_FIELDS = [
  'supported',
  'state',
  'workerAlive',
  'generation',
  'side',
  'lastError',
  'cursorFailureCount',
  'fullscreenBlockCount',
  'fullscreenActive',
  'fullscreenExitPending',
  'persistentHandleActivated',
  'handleDragging',
  'handlePositionPermille',
  'pendingEvent',
  'pendingEventCount',
  'mode',
  'handleState',
  'handleVisible',
  'handleWindowAlive',
  'handleEnteredOnce',
  'handleDpi',
  'handleRenderer',
  'handlePrewarmed',
  'handleEmbeddedFont',
  'handlePresented',
  'handleWindowCreateCount'
]

function pickStatus(status = {}) {
  const result = Object.fromEntries(
    SIGNATURE_FIELDS.filter((field) => status[field] !== undefined).map((field) => [
      field,
      status[field]
    ])
  )
  for (const field of [
    'pollIntervalMs',
    'lastPollAgeMs',
    'handlePresentCount',
    'handleVisualFrame'
  ]) {
    if (status[field] !== undefined) result[field] = status[field]
  }
  if (status.handleVisualElapsedMs !== undefined) {
    result.handleVisualElapsedMs = status.handleVisualElapsedMs
  }
  if (status.triggerArea !== undefined) result.triggerArea = status.triggerArea
  if (status.handleRect !== undefined) result.handleRect = status.handleRect
  return result
}

export function createDockNativeStatusSignature(status = {}) {
  const signature = Object.fromEntries(
    SIGNATURE_FIELDS.map((field) => [field, status[field] ?? null])
  )
  signature.triggerArea = status.triggerArea ?? null
  signature.handleRect = status.handleRect ?? null
  return JSON.stringify(signature)
}

/**
 * 隐藏会话期间低频读取原生状态，只在状态签名变化时写日志。
 * lastPollAgeMs 和逐帧绘制计数仍会随日志保存，但不参与签名，避免逐帧刷屏。
 */
export class DockNativeStatusObserver {
  constructor({
    getStatus,
    getContext = () => null,
    logger,
    intervalMs = 250,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval
  }) {
    this.getStatus = getStatus
    this.getContext = getContext
    this.logger = logger
    this.intervalMs = intervalMs
    this.setIntervalFn = setIntervalFn
    this.clearIntervalFn = clearIntervalFn
    this.timer = null
    this.generation = 0
    this.lastSignature = null
    this.readFailureCount = 0
    this.lastReadError = null
  }

  isActive() {
    return Boolean(this.timer)
  }

  start(generation, source = 'arm-succeeded') {
    this.stop('observer-replaced', { capture: false })
    this.generation = Number(generation) || 0
    this.lastSignature = null
    this.readFailureCount = 0
    this.lastReadError = null
    this.capture(source, { force: true })
    this.timer = this.setIntervalFn(() => this.capture('poll'), this.intervalMs)
    this.timer?.unref?.()
  }

  capture(source = 'manual', { force = false } = {}) {
    if (!this.generation) return null
    let status
    try {
      status = pickStatus(this.getStatus() || {})
    } catch (error) {
      this.readFailureCount += 1
      const message = error?.message || String(error)
      if (message !== this.lastReadError) {
        this.lastReadError = message
        this.logger.warn('dock.native-edge-status', '读取原生边缘状态失败', {
          source,
          observerGeneration: this.generation,
          consecutiveFailures: this.readFailureCount,
          error: message
        })
      }
      return null
    }

    const signature = createDockNativeStatusSignature(status)
    const changed = signature !== this.lastSignature
    if (!force && !changed) return status

    const recoveredReadFailures = this.readFailureCount
    this.lastSignature = signature
    this.readFailureCount = 0
    this.lastReadError = null
    this.logger.info('dock.native-edge-status', 'Windows 原生边缘状态变化', {
      source,
      observerGeneration: this.generation,
      generationMatches: Number(status.generation || 0) === this.generation,
      recoveredReadFailures,
      status,
      context: this.getContext(status)
    })
    return status
  }

  stop(source = 'observer-stopped', { capture = true } = {}) {
    if (!this.generation && !this.timer) return
    if (this.timer) this.clearIntervalFn(this.timer)
    this.timer = null
    if (capture) this.capture(source, { force: true })
    this.generation = 0
    this.lastSignature = null
    this.readFailureCount = 0
    this.lastReadError = null
  }
}

export const dockNativeStatusObserverInternals = {
  pickStatus,
  SIGNATURE_FIELDS
}
