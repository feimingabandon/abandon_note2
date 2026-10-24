import { describe, expect, it, vi } from 'vitest'
import { createNewNoteShortcut } from '../src/main/services/new-note-shortcut.js'
import { ACTION_SHORTCUTS } from '../src/shared/capture-shortcuts.js'
import { DEFAULT_SETTINGS } from '../src/shared/settings-schema.js'
import { CaptureShortcutService } from '../src/main/capture/CaptureShortcutService.js'
import { ViewVisibilityShortcutService } from '../src/main/services/view-visibility-shortcut.js'

describe('new note global shortcut', () => {
  it.each(['viewVisibility', 'screenshot', 'screenshotCopy'])(
    'preserves the saved %s F3 binding through recording and enable cycles',
    (action) => {
      const bindings = new Map()
      const globalShortcut = {
        register(key, callback) {
          if (bindings.has(key)) return false
          bindings.set(key, callback)
          return true
        },
        unregister: (key) => bindings.delete(key)
      }
      const onTrigger = vi.fn()
      const viewService = new ViewVisibilityShortcutService({
        globalShortcut,
        onTrigger: () => onTrigger('viewVisibility')
      })
      viewService.initialize(action === 'viewVisibility' ? 'F3' : 'F2')
      const service = new CaptureShortcutService({
        globalShortcut,
        viewService,
        onTrigger,
        definitions: ACTION_SHORTCUTS
      })
      service.initialize({ ...DEFAULT_SETTINGS.shortcuts, [action]: 'F3' })
      for (const restore of [
        () => {},
        () => {
          service.beginCapture(1)
          service.endCapture(1)
        },
        () => {
          service.setEnabled(false)
          service.setEnabled(true)
        }
      ]) {
        restore()
        expect(bindings.has('F3')).toBe(true)
        bindings.get('F3')()
        expect(onTrigger).toHaveBeenLastCalledWith(action)
        expect(service.snapshot().newNote).toMatchObject({
          registered: false,
          error: { code: 'conflict' }
        })
      }
      expect(service.update('newNote', 'F3', { persist: vi.fn() }).status).toBe('conflict')
      service.dispose()
      viewService.dispose()
    }
  )
  it('registers F3, rejects conflicts and follows capture, disable and dispose ownership', () => {
    const bindings = new Map()
    const globalShortcut = {
      register: (key, callback) => {
        if (bindings.has(key)) return false
        bindings.set(key, callback)
        return true
      },
      unregister: (key) => bindings.delete(key)
    }
    const viewService = new ViewVisibilityShortcutService({ globalShortcut })
    viewService.initialize('F2')
    const onTrigger = vi.fn()
    const service = new CaptureShortcutService({
      globalShortcut,
      viewService,
      onTrigger,
      definitions: ACTION_SHORTCUTS
    })
    service.initialize(DEFAULT_SETTINGS.shortcuts)
    bindings.get('F3')()
    expect(onTrigger).toHaveBeenCalledWith('newNote')
    expect(service.conflicts('screenshot', 'F3')).toBe(true)
    expect(service.update('newNote', 'F1', { persist: vi.fn() }).status).toBe('conflict')
    service.beginCapture(1)
    expect(bindings.size).toBe(0)
    service.endCapture(1)
    expect(bindings.has('F3')).toBe(true)
    service.setEnabled(false)
    expect(bindings.size).toBe(0)
    service.setEnabled(true)
    service.dispose()
    viewService.dispose()
    expect(bindings.size).toBe(0)
  })
  it('coalesces opening and only delivers to a live ready document', async () => {
    let finish
    const window = { isDestroyed: () => false, webContents: { send: vi.fn() } }
    const openWindow = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    let allowed = true
    const owner = createNewNoteShortcut({
      canOpen: () => allowed,
      openWindow,
      getWindow: () => window,
      isReady: () => true
    })
    const first = owner.trigger()
    expect(owner.trigger()).toBe(first)
    finish(true)
    expect(await first).toBe(true)
    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith('notes:new-requested')
    const second = owner.trigger()
    allowed = false
    finish(true)
    expect(await second).toBe(false)
    expect(window.webContents.send).toHaveBeenCalledTimes(1)
    expect(await owner.trigger()).toBe(false)
    expect(openWindow).toHaveBeenCalledTimes(2)
  })
})
