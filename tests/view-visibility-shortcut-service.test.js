import { describe, expect, it, vi } from 'vitest'
import { ViewVisibilityShortcutService } from '../src/main/services/view-visibility-shortcut.js'

function createHarness({ rejected = [] } = {}) {
  const callbacks = new Map()
  const globalShortcut = {
    register: vi.fn((accelerator, callback) => {
      if (rejected.includes(accelerator) || callbacks.has(accelerator)) return false
      callbacks.set(accelerator, callback)
      return true
    }),
    unregister: vi.fn((accelerator) => callbacks.delete(accelerator))
  }
  const onTrigger = vi.fn()
  const service = new ViewVisibilityShortcutService({ globalShortcut, onTrigger })
  return { callbacks, globalShortcut, onTrigger, service }
}

describe('ViewVisibilityShortcutService', () => {
  it('restores the saved shortcut at startup and invokes the visibility callback', () => {
    const { callbacks, onTrigger, service } = createHarness()

    expect(service.initialize('Control+Alt+N')).toMatchObject({
      configured: 'Control+Alt+N',
      registered: true,
      capturing: false
    })
    callbacks.get('Control+Alt+N')()
    expect(onTrigger).toHaveBeenCalledTimes(1)
  })

  it('temporarily unregisters during recording and restores on cancellation', () => {
    const { callbacks, globalShortcut, service } = createHarness()
    service.initialize('Control+Alt+N')

    expect(service.beginCapture(7)).toMatchObject({ registered: false, capturing: true })
    expect(callbacks.has('Control+Alt+N')).toBe(false)
    expect(service.endCapture(7)).toMatchObject({ registered: true, capturing: false })
    expect(globalShortcut.register).toHaveBeenLastCalledWith('Control+Alt+N', expect.any(Function))
  })

  it('keeps recording and preserves the old value when a candidate conflicts', () => {
    const { callbacks, service } = createHarness({ rejected: ['Control+Alt+M'] })
    service.initialize('Control+Alt+N')
    service.beginCapture(7)

    const result = service.update('Control+Alt+M', { ownerId: 7, persist: vi.fn() })

    expect(result).toMatchObject({ status: 'conflict', accelerator: 'Control+Alt+M' })
    expect(result.runtime).toMatchObject({ configured: 'Control+Alt+N', capturing: true })
    expect(callbacks.size).toBe(0)
    expect(service.endCapture(7).registered).toBe(true)
    expect(callbacks.has('Control+Alt+N')).toBe(true)
  })

  it('revalidates an unchanged saved shortcut when startup registration had failed', () => {
    const { service } = createHarness({ rejected: ['Control+Alt+N'] })
    expect(service.initialize('Control+Alt+N')).toMatchObject({ registered: false })
    service.beginCapture(7)

    expect(
      service.update('Control+Alt+N', {
        ownerId: 7,
        persist: vi.fn()
      })
    ).toMatchObject({
      status: 'conflict',
      runtime: { configured: 'Control+Alt+N', registered: false, capturing: true }
    })
  })

  it('replaces and persists a valid shortcut transactionally', () => {
    const { callbacks, globalShortcut, service } = createHarness()
    const persist = vi.fn()
    service.initialize('Control+Alt+N')
    service.beginCapture(7)

    expect(service.update('Control+Shift+F11', { ownerId: 7, persist })).toMatchObject({
      status: 'saved',
      accelerator: 'Control+Shift+F11',
      runtime: { configured: 'Control+Shift+F11', registered: true, capturing: false }
    })
    expect(persist).toHaveBeenCalledWith('Control+Shift+F11')
    expect(globalShortcut.unregister).toHaveBeenCalledWith('Control+Alt+N')
    expect(callbacks.has('Control+Shift+F11')).toBe(true)
  })

  it('rolls back a candidate if persistence fails and restores the old shortcut', () => {
    const { callbacks, service } = createHarness()
    service.initialize('Control+Alt+N')
    service.beginCapture(7)

    const result = service.update('Control+Alt+M', {
      ownerId: 7,
      persist: () => {
        throw new Error('database unavailable')
      }
    })

    expect(result).toMatchObject({ status: 'failed', accelerator: 'Control+Alt+N' })
    expect(callbacks.has('Control+Alt+M')).toBe(false)
    expect(service.endCapture(7)).toMatchObject({
      configured: 'Control+Alt+N',
      registered: true,
      capturing: false
    })
  })

  it('clears the configured shortcut and unregisters it', () => {
    const { callbacks, service } = createHarness()
    const persist = vi.fn()
    service.initialize('F11')

    expect(service.update('', { ownerId: 7, persist })).toMatchObject({
      status: 'cleared',
      accelerator: '',
      runtime: { configured: '', registered: false }
    })
    expect(persist).toHaveBeenCalledWith('')
    expect(callbacks.size).toBe(0)
  })
})
