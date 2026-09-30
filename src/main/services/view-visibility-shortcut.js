import {
  normalizeViewVisibilityShortcut,
  validateViewVisibilityShortcut
} from '../../shared/view-visibility-shortcut.js'

export class ViewVisibilityShortcutService {
  constructor({ globalShortcut, onTrigger, logger = null, canRegister = () => true }) {
    this.globalShortcut = globalShortcut
    this.onTrigger = onTrigger
    this.logger = logger
    this.canRegister = canRegister
    this.configuredAccelerator = ''
    this.registeredAccelerator = ''
    this.runtimeError = null
    this.enabled = true
    this.captureOwners = new Set()
    this.handleTrigger = () => {
      if (!this.enabled || this.captureOwners.size > 0) {
        this.logger?.info?.('shortcut.view-visibility-trigger', '显示/隐藏快捷键触发被忽略', {
          action: 'ignored',
          reason: this.enabled ? 'capture' : 'disabled'
        })
        return
      }
      this.onTrigger?.()
    }
  }

  initialize(value, { enabled = this.enabled } = {}) {
    this.disposeRegistration()
    this.enabled = enabled
    this.captureOwners.clear()
    this.configuredAccelerator = normalizeViewVisibilityShortcut(value)
    this.runtimeError = null
    if (this.configuredAccelerator) this.restoreConfiguredRegistration('startup')
    return this.snapshot()
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled)
    if (!this.enabled) {
      this.disposeRegistration()
      this.runtimeError = null
    } else if (!this.registeredAccelerator) {
      this.restoreConfiguredRegistration('enabled')
    }
    return this.snapshot()
  }

  beginCapture(ownerId) {
    const owner = String(ownerId)
    if (this.captureOwners.has(owner)) return this.snapshot()
    this.captureOwners.add(owner)
    if (this.captureOwners.size === 1 && this.registeredAccelerator) {
      this.globalShortcut.unregister(this.registeredAccelerator)
      this.registeredAccelerator = ''
    }
    return this.snapshot()
  }

  retryRegistration() {
    // Keep working bindings and recording/disabled states intact.
    if (!this.registeredAccelerator) this.restoreConfiguredRegistration('retry')
    return this.snapshot()
  }

  endCapture(ownerId) {
    this.captureOwners.delete(String(ownerId))
    if (this.captureOwners.size === 0 && !this.registeredAccelerator) {
      this.restoreConfiguredRegistration('capture-end')
    }
    return this.snapshot()
  }

  update(value, { ownerId, persist }) {
    const validation = validateViewVisibilityShortcut(value)
    if (!validation.valid) {
      return { status: 'invalid', code: validation.code, runtime: this.snapshot() }
    }

    const next = validation.accelerator
    const previous = this.configuredAccelerator
    if (next === previous) {
      if (
        this.enabled &&
        next &&
        !this.registeredAccelerator &&
        !this.tryRegister(next, 'update-unchanged')
      ) {
        return { status: 'conflict', accelerator: next, runtime: this.snapshot() }
      }
      this.captureOwners.delete(String(ownerId))
      if (this.captureOwners.size > 0) this.disposeRegistration()
      return { status: 'unchanged', accelerator: previous, runtime: this.snapshot() }
    }

    const previouslyRegistered = this.registeredAccelerator
    if (
      this.enabled &&
      next &&
      next !== previouslyRegistered &&
      !this.tryRegister(next, 'update')
    ) {
      return { status: 'conflict', accelerator: next, runtime: this.snapshot() }
    }

    try {
      persist(next)
    } catch (error) {
      if (this.enabled && next && next !== previouslyRegistered) {
        this.globalShortcut.unregister(next)
        if (this.registeredAccelerator === next) {
          this.registeredAccelerator = previouslyRegistered
        }
      }
      this.runtimeError = { code: 'persistence-failed', message: error?.message || String(error) }
      return { status: 'failed', accelerator: previous, runtime: this.snapshot() }
    }

    if (previouslyRegistered && previouslyRegistered !== next) {
      this.globalShortcut.unregister(previouslyRegistered)
    }
    this.configuredAccelerator = next
    this.registeredAccelerator = this.enabled ? next : ''
    this.runtimeError = null
    this.captureOwners.delete(String(ownerId))
    if (this.captureOwners.size > 0) this.disposeRegistration()
    if (
      this.captureOwners.size === 0 &&
      this.configuredAccelerator &&
      !this.registeredAccelerator
    ) {
      this.restoreConfiguredRegistration('update-finish')
    }
    return {
      status: next ? 'saved' : 'cleared',
      accelerator: next,
      runtime: this.snapshot()
    }
  }

  snapshot() {
    return {
      configured: this.configuredAccelerator,
      enabled: this.enabled,
      registered: Boolean(
        this.configuredAccelerator && this.registeredAccelerator === this.configuredAccelerator
      ),
      capturing: this.captureOwners.size > 0,
      error: this.runtimeError ? { ...this.runtimeError } : null
    }
  }

  disposeRegistration() {
    if (this.registeredAccelerator) {
      this.globalShortcut.unregister(this.registeredAccelerator)
      this.registeredAccelerator = ''
    }
  }

  dispose() {
    this.disposeRegistration()
    this.captureOwners.clear()
  }

  restoreConfiguredRegistration(source) {
    if (!this.enabled || !this.configuredAccelerator || this.captureOwners.size > 0) return false
    return this.tryRegister(this.configuredAccelerator, source)
  }

  tryRegister(accelerator, source) {
    if (!this.enabled) return false
    if (!this.canRegister(accelerator)) {
      this.runtimeError = { code: 'conflict', message: '与应用内另一项快捷键重复' }
      return false
    }
    try {
      const registered = this.globalShortcut.register(accelerator, this.handleTrigger)
      if (!registered) {
        this.runtimeError = { code: 'conflict', message: '快捷键已被系统或其他应用占用' }
        this.logger?.warn?.('shortcut.view-visibility-conflict', this.runtimeError.message, {
          accelerator,
          source
        })
        return false
      }
      this.registeredAccelerator = accelerator
      this.runtimeError = null
      return true
    } catch (error) {
      this.runtimeError = { code: 'registration-failed', message: error?.message || String(error) }
      this.logger?.error?.('shortcut.view-visibility-register', error, { accelerator, source })
      return false
    }
  }
}
