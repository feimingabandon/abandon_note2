import { app } from 'electron'
import { join, resolve } from 'node:path'
import { promises as fs } from 'node:fs'
import { CaptureHost } from './CaptureHost.js'
import { CaptureAssetStore, decodeCaptureAsset } from './CaptureAssetStore.js'

export class CaptureCoordinator {
  constructor(options) {
    Object.assign(this, options)
    this.active = null
    this.pending = null
    this.stopping = false
    this.handlers = []
    this.invalidSources = new Set()
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
    handle('screenshot:ack', (event, data) => this.ack(event.sender, data))
    handle('screenshot:cancel', (event, token) => {
      if (this.active?.sender === event.sender && this.active.token === token) this.cancel()
    })
    handle('screenshot:source-gone', (event, token) => {
      this.invalidSources.add(token)
      if (this.invalidSources.size > 100)
        this.invalidSources.delete(this.invalidSources.values().next().value)
      if (this.active?.sender !== event.sender || this.active.token !== token) return
      if (this.active.delivery)
        this.ack(event.sender, {
          sessionId: this.active.id,
          deliveryId: this.active.delivery,
          accepted: false,
          message: '来源页面已关闭，可复制、保存或贴图'
        })
      this.active.sender = null
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
      if (mainFrame && !inPlace) callback()
    }
    sender.on('did-start-navigation', navigation)
    sender.on('render-process-gone', callback)
    sender.on('destroyed', callback)
    return () => {
      sender.removeListener('did-start-navigation', navigation)
      sender.removeListener('render-process-gone', callback)
      sender.removeListener('destroyed', callback)
    }
  }
  async capture({ sender = null, token = '', origin = 'global' } = {}) {
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
        delivery: null,
        started: Date.now(),
        unwatchSource
      }
      if (this.invalidSources.delete(token) || sourceUnavailable || sender?.isDestroyed())
        this.active.sender = null
      await this.onCaptureStart?.(origin)
      // Let the desktop compositor apply an optional main-window hide before freezing.
      await new Promise((resolve) => setTimeout(resolve, 80))
      if (this.active?.id !== id || this.stopping) return { status: 'cancelled' }
      this.host.send({ type: 'capture', sessionId: id, origin })
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
      if (active.delivery) return
      active.delivery = message.deliveryId
      try {
        const asset = await this.assets.read(active.id, message.deliveryId)
        if (this.active !== active) return
        const receiver =
          message.action === 'source' ? active.sender : this.getMainWindow()?.webContents
        if (!receiver || receiver.isDestroyed())
          throw new Error('截图来源已关闭，请复制、保存或贴图')
        active.receiver = receiver
        if (message.action !== 'source') {
          active.businessOpened = true
          await this.onBusinessOpen?.()
        }
        if (
          this.active !== active ||
          receiver.isDestroyed() ||
          (message.action === 'source' && active.sender !== receiver)
        )
          throw new Error('接收页面已关闭，可复制、保存或贴图')
        active.unwatchReceiver = this.watchPage(receiver, () => {
          if (this.active === active && active.delivery) {
            this.ack(receiver, {
              sessionId: active.id,
              deliveryId: active.delivery,
              accepted: false,
              message: '接收页面已关闭，可复制、保存或贴图'
            })
          }
        })
        receiver.send('screenshot:delivery', {
          ...asset,
          token: active.token,
          sessionId: active.id,
          deliveryId: message.deliveryId,
          action: message.action
        })
      } catch (error) {
        active.unwatchReceiver?.()
        active.unwatchReceiver = null
        if (this.active !== active) return
        this.host.send({
          type: 'ack',
          sessionId: active.id,
          deliveryId: active.delivery,
          accepted: false,
          message: error.message
        })
        active.delivery = null
      }
    }
  }
  ack(sender, data) {
    const active = this.active
    if (
      !active ||
      active.receiver !== sender ||
      data.sessionId !== active.id ||
      data.deliveryId !== active.delivery
    )
      return false
    clearTimeout(this.deliveryTimeout)
    active.unwatchReceiver?.()
    active.unwatchReceiver = null
    if (data.accepted === true && active.businessOpened) active.businessAccepted = true
    this.host.send({
      type: 'ack',
      sessionId: active.id,
      deliveryId: active.delivery,
      accepted: data.accepted === true,
      message: String(data.message || '').slice(0, 300)
    })
    active.delivery = null
    return true
  }
  cancel() {
    if (this.active) {
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
    clearTimeout(this.deliveryTimeout)
    const active = this.active
    if (!active) return
    this.active = null
    active.unwatchReceiver?.()
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
