import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReminderService } from '../src/main/services/ReminderService.js'
import { TrayReminderController } from '../src/main/services/TrayReminderController.js'
import {
  availableReminderChannels,
  assertSnoozeTime,
  normalizeReminderChannels
} from '../src/shared/reminder-rules.js'

afterEach(() => vi.useRealTimers())

function fixture(channels = 7) {
  let rounds = [
    {
      id: 'round-a',
      note_id: 1,
      reminder_channels: channels,
      delivered_channels: 0,
      dismissed_channels: 0,
      attempts: 0,
      next_attempt_at: 0,
      state: 'active',
      note_status: 'in_progress'
    }
  ]
  const store = {
    getNextReminderTime: vi.fn(() => null),
    activateDueReminders: vi.fn(() => rounds),
    listActiveReminders: vi.fn(() => rounds),
    getReminder: vi.fn(() => rounds[0]),
    markReminderAttempt: vi.fn(),
    markReminderDelivered: vi.fn(),
    markReminderFailure: vi.fn(),
    dismissReminderChannel: vi.fn(),
    snoozeReminder: vi.fn(() => ({ created: true, reminder: { due_at: 200000, id: 'round-b' } }))
  }
  const notifications = {
    sendReminder: vi.fn(() => true),
    reconcileReminders: vi.fn(),
    dispose: vi.fn()
  }
  const popup = { sync: vi.fn(), focusRound: vi.fn(), dispose: vi.fn() }
  const tray = { sync: vi.fn(), acknowledge: vi.fn(), dispose: vi.fn() }
  const onChanged = vi.fn(),
    reportError = vi.fn()
  const service = new ReminderService({
    notifications,
    popup,
    tray,
    store,
    onChanged,
    reportError,
    platform: 'win32'
  })
  return {
    service,
    store,
    notifications,
    popup,
    tray,
    onChanged,
    reportError,
    setRows: (rows) => {
      rounds = rows
    }
  }
}

describe('shared reminder delivery', () => {
  it('delivers popup and tray even if Windows notifications throw', () => {
    const f = fixture()
    f.notifications.sendReminder.mockImplementation(() => {
      throw new Error('disabled')
    })
    f.service.tick(100000)
    expect(f.popup.sync.mock.calls[0][0]).toHaveLength(1)
    expect(f.tray.sync).toHaveBeenCalledWith(['round-a'])
    expect(f.store.markReminderDelivered).not.toHaveBeenCalled()
  })
  it('isolates window failures from tray delivery and reconciles consumed rounds', () => {
    const f = fixture()
    f.popup.sync.mockImplementationOnce(() => {
      throw new Error('window failed')
    })
    f.service.tick(100000)
    expect(f.tray.sync).toHaveBeenLastCalledWith(['round-a'])
    f.setRows([])
    f.service.refresh()
    expect(f.tray.sync).toHaveBeenLastCalledWith([])
    expect(f.notifications.reconcileReminders).toHaveBeenLastCalledWith(new Set())
  })
  it('does not replay accepted native deliveries and retries only up to three times', () => {
    const f = fixture()
    const row = f.store.getReminder()
    row.delivered_channels = 1
    f.service.tick(100000)
    row.delivered_channels = 0
    row.attempts = 3
    f.service.tick(100000)
    expect(f.notifications.sendReminder).not.toHaveBeenCalled()
    row.attempts = 1
    row.next_attempt_at = 200000
    f.service.tick(100000)
    expect(f.notifications.sendReminder).not.toHaveBeenCalled()
    f.service.tick(200001)
    const callback = f.notifications.sendReminder.mock.calls[0][1]
    callback(new Error('async failure'))
    expect(f.store.markReminderFailure).toHaveBeenCalledWith('round-a', 1)
  })
  it('uses popup for an explicitly requested custom time even on a system-only reminder', () => {
    const f = fixture(1)
    f.service.action({ id: 'round-a', action: 'custom' })
    expect(f.popup.sync.mock.calls.at(-1)[0]).toHaveLength(1)
    expect(f.popup.focusRound).toHaveBeenCalledWith('round-a')
    f.service.action({ id: 'round-a', action: 'snooze', minutes: 10 })
    expect(f.onChanged).toHaveBeenCalledWith(1)
    expect(f.service.customIds.size).toBe(0)
  })
  it('rejects arbitrary native actions and guards callbacks after shutdown', () => {
    const f = fixture()
    expect(() => f.service.action({ id: 'round-a', action: 'snooze', minutes: -1 })).toThrow()
    f.service.dispose()
    f.service.tick()
    expect(f.store.activateDueReminders).not.toHaveBeenCalled()
    expect(() => f.service.action({ id: 'round-a', action: 'snooze', minutes: 5 })).toThrow('退出')
  })
  it('fires one precise timer, refreshes note badges, and cancels timers on disposal', () => {
    vi.useFakeTimers()
    const f = fixture(2)
    f.setRows([])
    f.store.getNextReminderTime.mockReturnValue(Date.now() + 1520)
    f.service.refresh()
    f.service.refresh()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1519)
    expect(f.store.activateDueReminders).not.toHaveBeenCalled()
    f.store.activateDueReminders.mockImplementation(() => {
      f.setRows([{ id: 'due-round', reminder_channels: 2 }])
      f.store.getNextReminderTime.mockReturnValue(null)
      return f.store.listActiveReminders()
    })
    vi.advanceTimersByTime(1)
    expect(f.popup.sync).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'due-round' })])
    expect(f.onChanged).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    f.store.getNextReminderTime.mockReturnValue(Date.now() + 5000)
    f.service.refresh()
    f.service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('tray lifecycle', () => {
  it('queues before tray creation, merges rounds, preserves other alerts and restores the latest base icon', () => {
    vi.useFakeTimers()
    const tray = { setImage: vi.fn(), isDestroyed: () => false }
    const controller = new TrayReminderController({ normalIcon: 'normal', alertIcon: 'alert' })
    controller.sync(['a', 'b'])
    expect(vi.getTimerCount()).toBe(0)
    controller.attach(tray)
    controller.sync(['a', 'b'])
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(500)
    expect(tray.setImage).toHaveBeenLastCalledWith('alert')
    controller.sync(['b'])
    expect(vi.getTimerCount()).toBe(1)
    controller.setBaseIcon('shortcuts-disabled')
    controller.acknowledge()
    expect(tray.setImage).toHaveBeenLastCalledWith('shortcuts-disabled')
    expect(vi.getTimerCount()).toBe(0)
    controller.sync(['b', 'c'])
    expect(vi.getTimerCount()).toBe(1)
    controller.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(tray.setImage).toHaveBeenLastCalledWith('shortcuts-disabled')
  })
})

it('validates masks and dates without disabling non-native channels on macOS', () => {
  expect(normalizeReminderChannels(undefined, true)).toBe(1)
  expect(availableReminderChannels(7, 'darwin')).toBe(6)
  expect(() => normalizeReminderChannels(8)).toThrow()
  expect(() => assertSnoozeTime(1000, 1000)).toThrow()
  expect(() => assertSnoozeTime(Infinity, 1000)).toThrow()
  expect(assertSnoozeTime(1001, 1000)).toBe(1001)
})
