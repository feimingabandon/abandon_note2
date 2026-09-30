import { ViewVisibilityShortcutService } from '../services/view-visibility-shortcut.js'
import { normalizeViewVisibilityShortcut } from '../../shared/view-visibility-shortcut.js'
import { CAPTURE_SHORTCUTS } from '../../shared/capture-shortcuts.js'

export class CaptureShortcutService {
  constructor({ globalShortcut, viewService, onTrigger, logger }) {
    this.viewService = viewService
    this.services = Object.fromEntries(
      Object.keys(CAPTURE_SHORTCUTS).map((key) => [
        key,
        new ViewVisibilityShortcutService({
          globalShortcut,
          logger,
          canRegister: (value) => !this.conflicts(key, value),
          onTrigger: () => onTrigger(key)
        })
      ])
    )
  }
  initialize(values) {
    const enabled = values.enabled !== false
    this.viewService.setEnabled(enabled)
    const seen = new Set([this.viewService.snapshot().configured].filter(Boolean))
    for (const [key, service] of Object.entries(this.services)) {
      const value = normalizeViewVisibilityShortcut(
        values[key] ?? CAPTURE_SHORTCUTS[key].defaultValue
      )
      service.dispose()
      service.enabled = enabled
      service.configuredAccelerator = value
      service.runtimeError = null
      if (value && seen.has(value))
        service.runtimeError = { code: 'conflict', message: '与应用内另一项快捷键重复' }
      else {
        service.initialize(value)
        if (value) seen.add(value)
      }
    }
  }
  setEnabled(enabled) {
    for (const service of [this.viewService, ...Object.values(this.services)])
      service.setEnabled(enabled)
  }
  conflicts(key, value) {
    const accelerator = normalizeViewVisibilityShortcut(value)
    return (
      accelerator &&
      Object.entries({ viewVisibility: this.viewService, ...this.services }).some(
        ([other, service]) => other !== key && service.snapshot().configured === accelerator
      )
    )
  }
  beginCapture(owner) {
    for (const service of [this.viewService, ...Object.values(this.services)])
      service.beginCapture(owner)
  }
  endCapture(owner) {
    for (const service of [this.viewService, ...Object.values(this.services)])
      service.endCapture(owner)
  }
  update(key, value, options) {
    const service = this.services[key]
    if (!service) return { status: 'invalid', code: 'unsupported' }
    if (this.conflicts(key, value)) return { status: 'conflict', runtime: service.snapshot() }
    const result = service.update(value, options)
    if (['saved', 'cleared', 'unchanged'].includes(result.status)) this.endCapture(options.ownerId)
    return { ...result, runtime: service.snapshot() }
  }
  snapshot() {
    return Object.fromEntries(
      Object.entries(this.services).map(([key, service]) => [key, service.snapshot()])
    )
  }
  dispose() {
    for (const service of Object.values(this.services)) service.dispose()
  }
}
