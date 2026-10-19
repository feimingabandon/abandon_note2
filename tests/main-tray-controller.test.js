import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/main/tray/shortcut-status.js', () => ({
  createShortcutTrayImages: () => ({ enabled: 'enabled', disabled: 'disabled' })
}))
import { createMainTrayController } from '../src/main/tray/main-tray-controller.js'

function fixture(capture = null) {
  let tray,
    enabled = true,
    view = 'list',
    reminderCount = 0
  const events = []
  class Tray extends EventEmitter {
    constructor(icon) {
      super()
      tray = this
      this.icon = icon
      this.destroyed = false
    }
    isDestroyed() {
      return this.destroyed
    }
    setToolTip(value) {
      this.tooltip = value
    }
    setContextMenu(value) {
      this.menu = value
    }
    destroy() {
      this.destroyed = true
      events.push('destroy')
    }
  }
  const sticky = { list: () => [], getRecoverableCount: () => 0 }
  const baseIcon = vi.fn()
  const showReminders = vi.fn()
  const owner = createMainTrayController({
    Tray,
    Menu: { buildFromTemplate: (value) => value },
    icon: 'original',
    getShortcutsEnabled: () => enabled,
    getViewMode: () => view,
    getStickyCommands: () => sticky,
    getCaptureCommands: () => capture,
    getReminderCount: () => reminderCount,
    showReminders,
    toggleShortcuts: () => {
      enabled = !enabled
    },
    acknowledgeReminders: () => events.push('ack'),
    attachReminderTray: vi.fn(),
    setReminderBaseIcon: baseIcon,
    openMainWindow: async () => {},
    switchView: async () => {},
    toggleWindow: () => events.push('toggle'),
    requestQuit: vi.fn(),
    logger: { error: vi.fn() }
  })
  return {
    owner,
    baseIcon,
    events,
    showReminders,
    setReminderCount: (value) => {
      reminderCount = value
    },
    getTray: () => tray,
    setView: (value) => {
      view = value
    }
  }
}

it('rebuilds current view/session state, updates reminder base icon, and disposes the actual click listener', () => {
  const f = fixture()
  expect(f.owner.create()).toBe(true)
  expect(f.owner.create()).toBe(false)
  expect(f.baseIcon).toHaveBeenLastCalledWith('enabled')
  f.getTray()
    .menu.find((item) => item.id === 'toggle-global-shortcuts')
    .click()
  expect(f.baseIcon).toHaveBeenLastCalledWith('disabled')
  expect(f.getTray().tooltip).toContain('重启恢复')
  f.setView('week')
  f.owner.rebuild()
  expect(f.getTray().menu.some((item) => item.label === '当前视图：周视图')).toBe(true)
  f.owner.triggerClick()
  expect(f.events).toEqual(['ack', 'toggle'])
  const actual = f.getTray()
  f.owner.dispose()
  f.owner.dispose()
  actual.emit('click')
  expect(f.events).toEqual(['ack', 'toggle', 'destroy'])
  expect(actual.listenerCount('click')).toBe(0)
})
it('places active reminder counts with main-window actions and disables the empty entry', () => {
  const f = fixture()
  f.owner.create()
  const empty = f.getTray().menu.find((item) => item.id === 'show-note-reminders')
  expect(empty).toMatchObject({ label: '待处理提醒（0）', enabled: false })
  f.setReminderCount(2)
  f.owner.rebuild()
  const items = f.getTray().menu
  const at = items.findIndex((item) => item.id === 'show-note-reminders')
  expect(items[at - 1].label).toBe('打开主窗口')
  expect(items[at]).toMatchObject({ label: '待处理提醒（2）', enabled: true })
  items[at].click()
  expect(f.showReminders).toHaveBeenCalledOnce()
  f.owner.dispose()
})
it('starts the same quick-copy mode from the tray', async () => {
  const capture = { capture: vi.fn(async () => {}), action: vi.fn(), report: vi.fn() }
  const f = fixture(capture)
  f.owner.create()
  f.getTray()
    .menu.find((item) => item.label === '快速截图复制')
    .click()
  await Promise.resolve()
  expect(capture.capture).toHaveBeenCalledWith({ mode: 'copy-on-select' })
  f.owner.dispose()
})

describe('tray construction failure', () => {
  it('destroys an allocated tray when reminder attachment fails', () => {
    let destroyed = 0
    class Tray extends EventEmitter {
      isDestroyed() {
        return false
      }
      destroy() {
        destroyed++
      }
    }
    const owner = createMainTrayController({
      Tray,
      createShortcutImages: () => ({ enabled: 'ok' }),
      attachReminderTray: () => {
        throw new Error('attach failed')
      }
    })
    expect(() => owner.create()).toThrow('attach failed')
    expect(destroyed).toBe(1)
    expect(owner.snapshot()).toEqual({ created: false, disposed: true })
  })
})
