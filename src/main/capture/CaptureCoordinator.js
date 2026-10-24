import { app } from 'electron'
import { join, resolve } from 'node:path'
import { promises as fs } from 'node:fs'
import { CaptureHost } from './CaptureHost.js'
import { CaptureAssetStore, decodeCaptureAsset } from './CaptureAssetStore.js'

const DELIVERY_CANCELLED = Symbol('capture-delivery-cancelled')

export class CaptureCoordinator {
  constructor(options) {
    Object.assign(this, options)
    this.active = null
    this.pending = null
    this.stopping = false
    this.handlers = []
    this.invalidSources = new Set()
    this.deliveryTimeouts = { sent: 5000, processing: 30000, ...options.deliveryTimeouts }
    this.waitForCompositor =
      options.waitForCompositor ?? (() => new Promise((resolve) => setTimeout(resolve, 80)))
    this.lastDelivery = null
  }
  async initialize() {
    const assetBase = join(app.getPath('userData'), 'capture-tmp')
    await fs.mkdir(assetBase, { recursive: true })
    // The application's single-instance lock is already held. Reclaim only our own
    // prior run directories; never follow reparse points or unrelated temp folders.
    for (const entry of await fs.readdir(assetBase, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^run-[a-zA-Z0-9]{6}$/.test(entry.name)) continue
      const previous = join(assetBase, entry.name)
      if (resolve(await fs.realpath(previous)) !== resolve(previous)) continue
      await fs.rm(previous, { recursive: true, force: true })
    }
    const root = await fs.mkdtemp(join(assetBase, 'run-'))
    const appRoot =
      process.env.ABANDON_INTEGRATION_TEST === '1'
        ? process.env.ABANDON_INTEGRATION_APP_ROOT || app.getAppPath()
        : app.getAppPath()
    this.assets = new CaptureAssetStore(root, (bytes) =>
      decodeCaptureAsset(bytes, join(appRoot, 'out/main/capture-image.js'))
    )
    this.host = new CaptureHost({
      root,
      logger: this.logger,
      directory: app.isPackaged
        ? join(process.resourcesPath, 'native_capture')
        : join(
            process.env.ABANDON_INTEGRATION_TEST === '1'
              ? process.env.ABANDON_INTEGRATION_APP_ROOT || app.getAppPath()
              : app.getAppPath(),
            'native_capture/deploy'
          )
    })
    this.host.on('message', (message) => {
      void this.message(message).catch((error) => this.report(error))
    })
    this.host.on('failure', (error) => {
      this.finish('failed')
      this.report(error)
    })
    const handle = (name, callback) => {
      this.ipcMain.handle(name, (event, ...args) => {
        if (event.sender !== this.getMainWindow()?.webContents) throw new Error('截图请求来源无效')
        return callback(event, ...args)
      })
      this.handlers.push(name)
    }
    handle('screenshot:capture', (event, options = {}) =>
      this.capture({
        sender: event.sender,
        token: String(options.token || ''),
        origin: options.origin === 'background' ? 'background' : 'note'
      })
    )
    handle('screenshot:delivery-progress', (event, data) =>
      this.progress(event.sender, data, event.senderFrame)
    )
    handle('screenshot:ack', (event, data) => this.ack(event.sender, data, event.senderFrame))
    handle('screenshot:cancel', (event, token) => {
      if (this.active?.sender === event.sender && this.active.token === token) this.cancel()
    })
    handle('screenshot:source-gone', (event, token) => {
      this.invalidSources.add(token)
      if (this.invalidSources.size > 100)
        this.invalidSources.delete(this.invalidSources.values().next().value)
      const active = this.active
      if (active?.sender !== event.sender || active.token !== token) return
      if (active.deliveryOperation)
        this.settleDelivery(
          active.deliveryOperation,
          false,
          '来源页面已关闭，可复制、保存或贴图',
          'source-gone'
        )
      if (this.active === active) active.sender = null
    })
    // Prewarming failure is visible in the UI on the next actual request; no restart loop.
    void this.host
      .start()
      .then(() => this.syncTheme())
      .catch((error) => this.logger?.error?.('capture.prewarm', error))
  }
  syncTheme() {
    if (!this.host?.ready || this.stopping || !this.getTheme) return
    const css = this.getTheme()
    const channels = String(css?.bgColor || '')
      .trim()
      .split(/\s+/)
      .map(Number)
    const valid =
      channels.length === 3 &&
      channels.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    const background = valid
      ? `#${channels.map((value) => value.toString(16).padStart(2, '0')).join('')}`
      : '#ffffff'
    const foreground = /^#[\da-f]{6}$/i.test(css?.textColor || '') ? css.textColor : '#1d1d1f'
    this.host.send({ type: 'theme', theme: { background, foreground } })
  }
  report(error) {
    this.logger?.error?.('capture.failure', error)
    this.onError?.(error.message || String(error))
  }
  watchPage(sender, callback) {
    const navigation = (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) callback('document-invalid')
    }
    const documentChanged = () => callback('document-invalid')
    const receiverGone = () => callback('receiver-gone')
    sender.on('did-start-navigation', navigation)
    sender.on('did-navigate', documentChanged)
    sender.on('render-process-gone', receiverGone)
    sender.on('destroyed', receiverGone)
    return () => {
      sender.removeListener('did-start-navigation', navigation)
      sender.removeListener('did-navigate', documentChanged)
      sender.removeListener('render-process-gone', receiverGone)
      sender.removeListener('destroyed', receiverGone)
    }
  }
  async capture({ sender = null, token = '', origin = 'global', mode = 'edit' } = {}) {
    if (this.stopping) return { status: 'stopping' }
    if (this.pending) return { status: 'busy' }
    if (this.active) {
      this.host.send({ type: 'capture' })
      return { status: 'busy' }
    }
    this.pending = true
    let sourceUnavailable = Boolean(sender?.isDestroyed())
    const unwatchSource =
      sender && !sourceUnavailable
        ? this.watchPage(sender, () => {
            sourceUnavailable = true
            if (this.active?.token === token) this.active.sender = null
          })
        : null
    try {
      await this.host.start()
      if (this.stopping) return { status: 'stopping' }
      this.syncTheme()
      const id = await this.assets.create()
      if (this.stopping) {
        await this.assets.release(id)
        return { status: 'stopping' }
      }
      this.active = {
        id,
        sender,
        token,
        origin,
        mode: origin === 'global' && mode === 'copy-on-select' ? mode : 'edit',
        delivery: null,
        deliveryIds: new Set(),
        started: Date.now(),
        unwatchSource
      }
      if (this.invalidSources.delete(token) || sourceUnavailable || sender?.isDestroyed())
        this.active.sender = null
      await this.onCaptureStart?.(origin)
      // Let the desktop compositor apply an optional main-window hide before freezing.
      await this.waitForCompositor()
      if (this.active?.id !== id || this.stopping) return { status: 'cancelled' }
      this.host.send({ type: 'capture', sessionId: id, origin, mode: this.active.mode })
      this.readyTimeout = setTimeout(() => {
        this.cancel()
        this.report(new Error('截图画面准备超时'))
      }, 10000)
      return { status: 'started', sessionId: id }
    } catch (error) {
      this.finish('failed')
      throw error
    } finally {
      if (this.active?.unwatchSource !== unwatchSource) unwatchSource?.()
      this.pending = false
    }
  }
  async action(type) {
    if (this.stopping || this.active || this.pending) return
    try {
      await this.host.start()
      this.syncTheme()
      this.host.send({ type })
    } catch (error) {
      this.report(error)
    }
  }
  describeDelivery(operation) {
    const processingRemainingMs = Math.max(
      0,
      operation.processingRemaining -
        (operation.processingStarted === null
          ? 0
          : Math.max(0, Date.now() - operation.processingStarted))
    )
    return {
      sessionId: operation.sessionId,
      deliveryId: operation.id,
      token: operation.token,
      state: operation.state,
      reason: operation.reason,
      sent: operation.sent,
      remainingMs:
        operation.deadlineAt === null ? null : Math.max(0, operation.deadlineAt - Date.now()),
      processingRemainingMs,
      deadlineAt: operation.deadlineAt,
      timerActive: operation.timer !== null,
      observingReceiver: Boolean(operation.unwatchReceiver),
      awaitingUserUsed: operation.awaitingUserUsed,
      message: operation.message
    }
  }
  deliverySnapshot() {
    const operation = this.active?.deliveryOperation
    return operation
      ? this.describeDelivery(operation)
      : this.lastDelivery && { ...this.lastDelivery }
  }
  chargeDeliveryWork(operation) {
    if (operation.processingStarted === null) return
    operation.processingRemaining = Math.max(
      0,
      operation.processingRemaining - Math.max(0, Date.now() - operation.processingStarted)
    )
    operation.processingStarted = null
  }
  armDelivery(operation, kind, duration) {
    clearTimeout(operation.timer)
    const remaining =
      kind === 'processing' && operation.processingStarted !== null
        ? Math.max(0, duration - Math.max(0, Date.now() - operation.processingStarted))
        : duration
    operation.deadlineAt = Date.now() + remaining
    operation.deadlineKind = kind
    operation.timer = setTimeout(() => {
      this.settleDelivery(
        operation,
        false,
        kind === 'sent'
          ? '截图接收超时，可复制、保存或再次交付'
          : '截图处理超时，可复制、保存或再次交付',
        `${kind}-timeout`
      )
    }, remaining)
  }
  deliveryCurrent(operation) {
    if (
      this.active !== operation.active ||
      this.active?.deliveryOperation !== operation ||
      ['accepted', 'rejected'].includes(operation.state)
    )
      return false
    if (
      !operation.receiver ||
      operation.receiver.isDestroyed() ||
      operation.receiver.isCrashed?.() ||
      !operation.frame ||
      operation.frame.isDestroyed?.() ||
      operation.receiver.mainFrame !== operation.frame ||
      (operation.action === 'source' && operation.active.sender !== operation.receiver)
    ) {
      this.settleDelivery(
        operation,
        false,
        '接收页面已关闭，可复制、保存或再次交付',
        'document-invalid'
      )
      return false
    }
    if (operation.deadlineAt !== null && Date.now() >= operation.deadlineAt) {
      this.settleDelivery(
        operation,
        false,
        '截图交付超时，可复制、保存或再次交付',
        `${operation.deadlineKind}-timeout`
      )
      return false
    }
    return true
  }
  beginDelivery(active, message) {
    const receiver = message.action === 'source' ? active.sender : this.getMainWindow()?.webContents
    const operation = {
      active,
      sessionId: active.id,
      id: message.deliveryId,
      token: active.token,
      action: message.action,
      receiver,
      frame: null,
      state: 'preparing',
      reason: null,
      sent: false,
      processingRemaining: this.deliveryTimeouts.processing,
      processingStarted: Date.now(),
      awaitingUserUsed: false,
      deadlineAt: null,
      deadlineKind: 'processing',
      timer: null,
      unwatchReceiver: null,
      message: null,
      resolve: null
    }
    operation.finished = new Promise((resolveFinished) => {
      operation.resolve = resolveFinished
    })
    active.delivery = operation.id
    active.receiver = receiver
    active.deliveryOperation = operation
    try {
      if (receiver && !receiver.isDestroyed()) operation.frame = receiver.mainFrame
    } catch (error) {
      this.settleDelivery(operation, false, error.message, 'document-invalid')
      return operation
    }
    if (!this.deliveryCurrent(operation)) return operation
    operation.unwatchReceiver = this.watchPage(receiver, (reason) =>
      this.settleDelivery(operation, false, '接收页面已关闭，可复制、保存或再次交付', reason)
    )
    this.armDelivery(operation, 'processing', operation.processingRemaining)
    return operation
  }
  async waitForDelivery(operation, work) {
    const result = await Promise.race([work, operation.finished.then(() => DELIVERY_CANCELLED)])
    return this.deliveryCurrent(operation) ? result : DELIVERY_CANCELLED
  }
  settleDelivery(operation, accepted, message = '', reason = 'renderer-rejected') {
    if (this.active !== operation.active || this.active?.deliveryOperation !== operation)
      return false
    this.chargeDeliveryWork(operation)
    clearTimeout(operation.timer)
    operation.timer = null
    operation.deadlineAt = null
    operation.unwatchReceiver?.()
    operation.unwatchReceiver = null
    operation.state = accepted ? 'accepted' : 'rejected'
    operation.reason = accepted ? 'accepted' : reason
    operation.message = String(message || '').slice(0, 300)
    const active = operation.active
    active.deliveryOperation = null
    active.delivery = null
    active.receiver = null
    if (accepted && operation.businessOpened) active.businessAccepted = true
    this.lastDelivery = this.describeDelivery(operation)
    operation.resolve()
    // Notify only the captured document. A reused WebContents may already own
    // a replacement main frame, which must not inherit this operation's state.
    try {
      if (
        operation.receiver &&
        !operation.receiver.isDestroyed() &&
        !operation.frame?.isDestroyed?.() &&
        operation.receiver.mainFrame === operation.frame
      )
        operation.receiver.send('screenshot:delivery-state', {
          sessionId: operation.sessionId,
          deliveryId: operation.id,
          state: operation.state,
          message: operation.message
        })
    } catch (error) {
      this.logger?.error?.('capture.delivery-state', error)
    }
    try {
      this.host.send({
        type: 'ack',
        sessionId: operation.sessionId,
        deliveryId: operation.id,
        accepted,
        message: operation.message
      })
    } catch (error) {
      this.logger?.error?.('capture.delivery-ack', error)
    }
    return true
  }
  matchingDelivery(sender, data, frame) {
    const operation = this.active?.deliveryOperation
    if (
      !operation ||
      !data ||
      operation.receiver !== sender ||
      operation.frame !== frame ||
      data.sessionId !== operation.sessionId ||
      data.deliveryId !== operation.id ||
      !operation.sent ||
      !this.deliveryCurrent(operation)
    )
      return null
    return operation
  }
  progress(sender, data, frame = sender?.mainFrame) {
    const operation = this.matchingDelivery(sender, data, frame)
    if (!operation) return false
    if (data.state === 'received' && operation.state === 'sent') {
      operation.state = 'received'
      operation.processingStarted = Date.now()
      this.armDelivery(operation, 'processing', operation.processingRemaining)
      return true
    }
    if (data.state === 'processing' && operation.state === 'received') {
      operation.state = 'processing'
      return true
    }
    if (data.state === 'awaiting-user' && ['received', 'processing'].includes(operation.state)) {
      if (operation.awaitingUserUsed) return false
      this.chargeDeliveryWork(operation)
      operation.awaitingUserUsed = true
      operation.state = 'awaiting-user'
      clearTimeout(operation.timer)
      operation.timer = null
      operation.deadlineAt = null
      return true
    }
    if (data.state === 'processing' && operation.state === 'awaiting-user') {
      operation.state = 'processing'
      operation.processingStarted = Date.now()
      this.armDelivery(operation, 'processing', operation.processingRemaining)
      return true
    }
    return false
  }
  async message(message) {
    const active = this.active
    if (message.type === 'error') {
      this.report(new Error(message.message))
      return
    }
    if (!active || message.sessionId !== active.id) return
    if (message.type === 'captureReady') {
      clearTimeout(this.readyTimeout)
      // Keep only numeric layout metadata for local multi-monitor diagnosis.
      // Never log native message payloads or captured image content.
      const validRect = (rect) =>
        Array.isArray(rect) && rect.length === 4 && rect.every(Number.isSafeInteger)
      const displays = (Array.isArray(message.displays) ? message.displays : [])
        .slice(0, 16)
        .filter((display) => validRect(display?.physical) && validRect(display?.logical))
        .map((display) => ({ physical: display.physical, logical: display.logical }))
      this.logger?.info?.('capture.ready', '截图桌面已冻结', {
        sessionId: active.id,
        displays
      })
      if (active.sender && !active.sender.isDestroyed()) active.sender.send('screenshot:ready')
    } else if (message.type === 'finished') this.finish(message.status)
    else if (message.type === 'output') {
      if (active.delivery || active.deliveryIds.has(message.deliveryId)) return
      active.deliveryIds.add(message.deliveryId)
      const operation = this.beginDelivery(active, message)
      if (!this.deliveryCurrent(operation)) return
      try {
        const asset = await this.waitForDelivery(
          operation,
          this.assets.read(operation.sessionId, operation.id)
        )
        if (asset === DELIVERY_CANCELLED) return
        if (message.action !== 'source') {
          active.businessOpened = true
          operation.businessOpened = true
          if (
            (await this.waitForDelivery(
              operation,
              this.onBusinessOpen?.({ isCurrent: () => this.deliveryCurrent(operation) })
            )) === DELIVERY_CANCELLED
          )
            return
        }
        if (!this.deliveryCurrent(operation)) return
        this.chargeDeliveryWork(operation)
        operation.state = 'sent'
        operation.sent = true
        this.armDelivery(operation, 'sent', this.deliveryTimeouts.sent)
        try {
          operation.receiver.send('screenshot:delivery', {
            ...asset,
            token: operation.token,
            sessionId: operation.sessionId,
            deliveryId: operation.id,
            action: message.action
          })
        } catch (error) {
          this.settleDelivery(operation, false, error.message, 'send-failed')
        }
      } catch (error) {
        this.settleDelivery(operation, false, error.message, 'processing-error')
      }
    }
  }
  ack(sender, data, frame = sender?.mainFrame) {
    const operation = this.matchingDelivery(sender, data, frame)
    if (!operation || (data.accepted === true && operation.state !== 'processing')) return false
    return this.settleDelivery(operation, data.accepted === true, data.message)
  }
  cancel() {
    if (this.active) {
      if (this.active.deliveryOperation)
        this.settleDelivery(this.active.deliveryOperation, false, '截图交付已取消', 'cancelled')
      try {
        this.host.send({ type: 'cancel', sessionId: this.active.id })
      } catch {
        /* host already exited */
      }
      this.finish('cancelled')
    }
  }
  finish(status) {
    clearTimeout(this.readyTimeout)
    const active = this.active
    if (!active) return
    if (active.deliveryOperation)
      this.settleDelivery(
        active.deliveryOperation,
        false,
        '截图会话已结束，交付已取消',
        this.stopping ? 'disposed' : status === 'cancelled' ? 'cancelled' : 'finished'
      )
    this.active = null
    active.unwatchSource?.()
    try {
      if (active.sender && !active.sender.isDestroyed())
        active.sender.send('screenshot:finished', {
          token: active.token,
          sessionId: active.id,
          status
        })
    } catch (error) {
      this.logger?.error?.('capture.source-closed', error)
    }
    this.onCaptureEnd?.(active.origin, {
      businessOpened: active.businessOpened,
      businessAccepted: active.businessAccepted
    })
    this.logger?.info?.('capture.finished', '截图会话结束', {
      origin: active.origin,
      status,
      elapsedMs: Date.now() - active.started
    })
    void this.assets
      .release(active.id)
      .catch((error) => this.logger?.error?.('capture.asset-cleanup', error))
  }
  async dispose() {
    this.stopping = true
    this.finish('cancelled')
    for (const name of this.handlers) this.ipcMain.removeHandler(name)
    await this.host?.dispose()
    await this.assets?.dispose()
  }
}
