import { describe, it, expect, vi } from 'vitest'
import { CaptureShortcutService } from '../src/main/capture/CaptureShortcutService.js'
import { ViewVisibilityShortcutService } from '../src/main/services/view-visibility-shortcut.js'
import { DEFAULT_SETTINGS } from '../src/shared/settings-schema.js'

function setup() {
  const bindings = new Map(),
    external = new Set()
  const globalShortcut = {
    register: (key, fn) => {
      if (bindings.has(key) || external.has(key)) return false
      bindings.set(key, fn)
      return true
    },
    unregister: (key) => bindings.delete(key)
  }
  const view = new ViewVisibilityShortcutService({ globalShortcut })
  view.initialize('Control+F8')
  const trigger = vi.fn()
  const service = new CaptureShortcutService({
    globalShortcut,
    viewService: view,
    onTrigger: trigger
  })
  service.initialize(DEFAULT_SETTINGS.shortcuts)
  return { bindings, external, view, service, trigger }
}
describe('capture global shortcut ownership', () => {
  it('registers only F1 capture and preserves view visibility', () => {
    const { service, bindings, trigger } = setup()
    expect(bindings.size).toBe(2)
    bindings.get('F1')()
    expect(trigger).toHaveBeenCalledWith('screenshot')
    expect(service.conflicts('screenshot', 'Ctrl+F8')).toBe(true)
    expect(service.conflicts('viewVisibility', 'F1')).toBe(true)
    expect(service.conflicts('viewVisibility', 'Ctrl+Alt+P')).toBe(false)
    expect(service.update('clipboardPin', 'F2', { persist: vi.fn() }).status).toBe('invalid')
    expect(service.update('togglePins', 'F3', { persist: vi.fn() }).status).toBe('invalid')
  })
  it('suspends every action during recording and restores only after all owners finish', () => {
    const { service, bindings } = setup()
    service.beginCapture(1)
    service.beginCapture(2)
    expect(bindings.size).toBe(0)
    service.endCapture(1)
    expect(bindings.size).toBe(0)
    service.endCapture(2)
    expect(bindings.size).toBe(2)
  })
  it('rolls back conflicts and failed persistence then allows a successful update and clear', () => {
    const { service, external, bindings } = setup()
    const persist = vi.fn()
    external.add('Control+F9')
    expect(service.update('screenshot', 'Control+F9', { persist }).status).toBe('conflict')
    expect(service.update('screenshot', 'Control+F8', { persist }).status).toBe('conflict')
    expect(persist).not.toHaveBeenCalled()
    expect(
      service.update('screenshot', 'Control+F10', {
        persist: () => {
          throw Error('db')
        }
      }).status
    ).toBe('failed')
    expect(bindings.has('F1')).toBe(true)
    expect(bindings.has('Control+F10')).toBe(false)
    service.beginCapture(1)
    expect(service.update('screenshot', 'Control+F10', { persist, ownerId: 1 }).status).toBe(
      'saved'
    )
    expect(bindings.size).toBe(2)
    expect(service.update('screenshot', '', { persist, ownerId: 1 }).status).toBe('cleared')
    expect(bindings.size).toBe(1)
    service.dispose()
    expect(bindings.size).toBe(1)
  })
  it('releases all shortcuts and ignores stale callbacks until explicitly enabled', () => {
    const { service, view, bindings, trigger } = setup()
    const stale = bindings.get('F1')
    service.setEnabled(false)
    expect(bindings.size).toBe(0)
    stale()
    expect(trigger).not.toHaveBeenCalled()
    service.beginCapture(1)
    service.endCapture(1)
    expect(bindings.size).toBe(0)
    expect(view.snapshot()).toMatchObject({ enabled: false, registered: false })
    const persist = vi.fn()
    expect(service.update('screenshot', 'F2', { persist }).status).toBe('saved')
    expect(service.update('screenshot', 'F2', { persist }).status).toBe('unchanged')
    expect(bindings.size).toBe(0)
    service.initialize({ enabled: false, screenshot: 'F2' })
    expect(bindings.size).toBe(0)
    service.setEnabled(true)
    expect([...bindings.keys()].sort()).toEqual(['Control+F8', 'F2'])
  })
  it('preserves the master gate across recording owners and reports enable conflicts', () => {
    const { service, bindings, external } = setup()
    service.setEnabled(false)
    service.beginCapture(1)
    service.beginCapture(2)
    service.setEnabled(true)
    expect(bindings.size).toBe(0)
    expect(service.update('screenshot', 'F2', { ownerId: 1, persist: vi.fn() }).status).toBe(
      'saved'
    )
    expect(bindings.size).toBe(0)
    service.endCapture(2)
    expect(bindings.size).toBe(2)
    service.setEnabled(false)
    external.add('F2')
    service.setEnabled(true)
    expect(service.snapshot().screenshot).toMatchObject({
      configured: 'F2',
      enabled: true,
      registered: false,
      error: { code: 'conflict' }
    })
    expect(bindings.has('Control+F8')).toBe(true)
    external.delete('F2')
    service.setEnabled(true)
    expect(bindings.has('F2')).toBe(true)
  })
  it('does not register obsolete saved shortcuts or let a duplicate replace view visibility', () => {
    const { service, bindings } = setup()
    service.initialize({ screenshot: 'Control+F8', clipboardPin: 'F2', togglePins: 'F3' })
    service.setEnabled(false)
    service.setEnabled(true)
    service.beginCapture(1)
    service.endCapture(1)
    expect([...bindings.keys()]).toEqual(['Control+F8'])
    expect(service.snapshot().screenshot.error.code).toBe('conflict')
  })
})
