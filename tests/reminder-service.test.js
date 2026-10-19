import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReminderService } from '../src/main/services/ReminderService.js'
import { TrayReminderController } from '../src/main/services/TrayReminderController.js'
import { createBusinessMutationAdmission } from '../src/main/application/business-mutation-admission.js'
import { assertSnoozeTime, normalizeReminderChannels } from '../src/shared/reminder-rules.js'

afterEach(() => vi.useRealTimers())

function fixture(channels = 7, overrides = {}) {
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
      note_status: 'in_progress',
      parent_id: null,
      due_at: 1000,
      created_at: 1000,
      is_deleted: 0
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
    ...overrides
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

function nativeRetryFixture() {
  const admission = createBusinessMutationAdmission()
  const f = fixture(1, { runMutation: admission.run, canRunMutations: admission.canAdmit })
  const active = () => {
    const row = f.store.getReminder()
    return row &&
      row.state === 'active' &&
      row.note_status === 'in_progress' &&
      !row.is_deleted &&
      row.reminder_channels
      ? [row]
      : []
  }
  f.store.activateDueReminders.mockImplementation(active)
  f.store.listActiveReminders.mockImplementation(active)
  f.store.markReminderAttempt.mockImplementation((id, now) => {
    const row = f.store.getReminder(id)
    row.attempts++
    row.next_attempt_at = now + 60000
  })
  f.store.markReminderDelivered.mockImplementation((id, bit) => {
    f.store.getReminder(id).delivered_channels |= bit
  })
  f.store.markReminderFailure.mockImplementation((id, bit) => {
    const row = f.store.getReminder(id)
    if (row.id !== id) throw new Error('Wrong live round')
    row.delivered_channels &= ~bit
  })
  return { ...f, admission }
}
it('publishes active reminder count changes while retaining reminders after their popup is dismissed', () => {
  const onActiveChanged = vi.fn()
  const f = fixture(2, { onActiveChanged })
  f.service.refresh()
  expect(onActiveChanged).toHaveBeenLastCalledWith(1)
  f.service.action({ id: 'round-a', action: 'dismiss' })
  expect(onActiveChanged).toHaveBeenCalledTimes(1)
  f.service.showAll()
  expect(f.popup.focusRound).toHaveBeenCalledWith('round-a')
  f.setRows([])
  f.service.refresh()
  expect(onActiveChanged).toHaveBeenLastCalledWith(0)
  f.service.dispose()
})

describe('batch popup dismissal', () => {
  it('dismisses a large popup with one active-list query and one presentation refresh', () => {
    const f = fixture(7)
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      ...f.store.getReminder(),
      id: `round-${index}`,
      note_id: index + 1
    }))
    const byId = new Map(rows.map((row) => [row.id, row]))
    f.setRows(rows)
    f.store.getReminder.mockImplementation((id) => byId.get(id))
    f.store.dismissReminderChannel.mockImplementation((id, bit) => {
      byId.get(id).dismissed_channels |= bit
    })
    for (const row of rows) f.service.customIds.add(row.id)

    expect(f.service.dismissAll(rows.map((row) => row.id))).toEqual({ dismissed: 1000 })
    expect(f.store.listActiveReminders).toHaveBeenCalledOnce()
    expect(f.store.dismissReminderChannel).toHaveBeenCalledTimes(1000)
    expect(f.popup.sync).toHaveBeenCalledExactlyOnceWith([])
    expect(f.notifications.reconcileReminders).toHaveBeenCalledOnce()
    expect(f.tray.sync).toHaveBeenCalledExactlyOnceWith(rows.map((row) => row.id))
    expect(f.service.activeIds.size).toBe(1000)
    expect(f.service.customIds.size).toBe(0)
    expect(rows.every((row) => row.state === 'active' && row.reminder_channels === 7)).toBe(true)
    f.service.dispose()
  })

  it('continues after individual failures and refreshes the remaining popup once', () => {
    const f = fixture(2)
    const rows = ['round-a', 'round-b'].map((id) => ({ ...f.store.getReminder(), id }))
    const byId = new Map(rows.map((row) => [row.id, row]))
    f.setRows(rows)
    f.store.getReminder.mockImplementation((id) => byId.get(id))
    f.store.dismissReminderChannel.mockImplementation((id, bit) => {
      if (id === 'round-b') throw new Error('write failed')
      byId.get(id).dismissed_channels |= bit
    })
    for (const row of rows) f.service.customIds.add(row.id)

    expect(f.service.dismissAll(['round-a', 'round-b', 'missing', 'round-a'])).toEqual({
      dismissed: 1
    })
    expect(f.store.dismissReminderChannel).toHaveBeenCalledTimes(2)
    expect(f.reportError).toHaveBeenCalledTimes(2)
    expect(f.store.listActiveReminders).toHaveBeenCalledOnce()
    expect(f.popup.sync).toHaveBeenCalledExactlyOnceWith([rows[1]])
    expect([...f.service.customIds]).toEqual(['round-b'])
    f.service.dispose()
    expect(() => f.service.dismissAll(['round-b'])).toThrow('软件正在退出')
  })
})

describe('native failures across business clear admission', () => {
  it('retains a failed delivery while clear is sealed and retries the unchanged live round after SQL clear fails', async () => {
    const f = nativeRetryFixture()
    f.service.tick(100000)
    const callback = f.notifications.sendReminder.mock.calls[0][1]
    let rejectClear
    const clear = f.admission.clear(
      () =>
        new Promise((_, reject) => {
          rejectClear = reject
        })
    )
    const failure = clear.catch((error) => error.message)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    callback(new Error('native failed during clear'))
    expect(f.store.markReminderFailure).not.toHaveBeenCalled()
    expect(f.service.pendingNativeFailures.size).toBe(1)
    rejectClear(new Error('clear SQL failed'))
    expect(await failure).toBe('clear SQL failed')
    f.service.tick(160001)
    expect(f.store.markReminderFailure).toHaveBeenCalledWith('round-a', 1)
    expect(f.notifications.sendReminder).toHaveBeenCalledTimes(2)
    expect(f.service.pendingNativeFailures.size).toBe(0)
    f.service.dispose()
  })

  it('invalidates successful-clear delivery tokens even if a same-note new round deliberately reuses every durable identity field', async () => {
    for (const id of ['round-a', 'round-new']) {
      const f = nativeRetryFixture()
      f.service.tick(100000)
      const old = { ...f.store.getReminder() }
      const callback = f.notifications.sendReminder.mock.calls[0][1]
      let finishStage
      const clear = f.admission.clear(async () => {
        await new Promise((resolve) => {
          finishStage = resolve
        })
        f.setRows([])
        f.service.refresh()
      })
      for (let i = 0; i < 5; i++) await Promise.resolve()
      callback(new Error('queued old failure'))
      finishStage()
      await clear
      expect(f.service.pendingNativeFailures.size).toBe(0)
      f.setRows([{ ...old, id, delivered_channels: 0, attempts: 0, next_attempt_at: 0 }])
      f.service.tick(160001)
      callback(new Error('old event after new delivery'))
      expect(f.store.markReminderFailure).not.toHaveBeenCalled()
      expect(f.store.getReminder().delivered_channels).toBe(1)
      expect(f.notifications.sendReminder).toHaveBeenCalledTimes(2)
      f.service.dispose()
    }
  })

  it('discards deferred failures when a round is snoozed, cancelled, or its system channel is disabled', async () => {
    for (const change of [
      { state: 'snoozed' },
      { state: 'cancelled' },
      { reminder_channels: 2 },
      { is_deleted: 1 },
      { note_status: 'completed' }
    ]) {
      const f = nativeRetryFixture()
      f.service.tick(100000)
      const callback = f.notifications.sendReminder.mock.calls[0][1]
      let finishClear
      const clear = f.admission.clear(
        () =>
          new Promise((resolve) => {
            finishClear = resolve
          })
      )
      for (let i = 0; i < 5; i++) await Promise.resolve()
      callback(new Error('old delivery failed'))
      Object.assign(f.store.getReminder(), change)
      finishClear()
      await clear
      f.service.tick(160001)
      expect(f.store.markReminderFailure).not.toHaveBeenCalled()
      expect(f.service.pendingNativeFailures.size).toBe(0)
      f.service.dispose()
    }
  })

  it('ignores an older native delivery callback after the same round was retried', () => {
    const f = nativeRetryFixture()
    f.service.tick(100000)
    const old = f.notifications.sendReminder.mock.calls[0][1]
    old(new Error('first delivery failed'))
    f.service.tick(160001)
    old(new Error('duplicate late old event'))
    expect(f.store.markReminderFailure).toHaveBeenCalledTimes(1)
    expect(f.store.getReminder().delivered_channels).toBe(1)
    f.notifications.sendReminder.mock.calls[1][1](new Error('new delivery failed'))
    expect(f.store.markReminderFailure).toHaveBeenCalledTimes(2)
    f.service.dispose()
  })

  it('keeps a failure queued after SQL update fails and clears it on the next legal retry', async () => {
    const f = nativeRetryFixture()
    f.service.tick(100000)
    f.store.markReminderFailure.mockImplementationOnce(() => {
      throw new Error('failure update SQL failed')
    })
    f.notifications.sendReminder.mock.calls[0][1](new Error('native failure'))
    expect(f.service.pendingNativeFailures.size).toBe(1)
    f.service.tick(160001)
    expect(f.service.pendingNativeFailures.size).toBe(0)
    expect(f.notifications.sendReminder).toHaveBeenCalledTimes(2)
    f.service.dispose()
  })

  it('does no SQL while shutdown is sealed, disposes the failure buffer, and ignores late callbacks', () => {
    const f = nativeRetryFixture()
    f.service.tick(100000)
    const callback = f.notifications.sendReminder.mock.calls[0][1]
    f.store.getReminder.mockClear()
    f.admission.preventNewMutations()
    callback(new Error('shutdown failure'))
    f.service.tick(160001)
    expect(f.store.getReminder).not.toHaveBeenCalled()
    expect(f.store.markReminderFailure).not.toHaveBeenCalled()
    expect(f.service.pendingNativeFailures.size).toBe(1)
    f.service.dispose()
    callback(new Error('after dispose'))
    expect(f.service.pendingNativeFailures.size).toBe(0)
    expect(f.service.nativeDeliveries.size).toBe(0)
    expect(f.store.getReminder).not.toHaveBeenCalled()
  })

  it('applies a synchronous native failure after the accepted-delivery bit instead of losing it', () => {
    const f = nativeRetryFixture()
    f.notifications.sendReminder.mockImplementation((_round, failed) => {
      failed(new Error('sync native failure'))
      return true
    })
    f.service.tick(100000)
    expect(f.store.getReminder().delivered_channels).toBe(0)
    expect(f.store.markReminderFailure).toHaveBeenCalledOnce()
    expect(f.service.pendingNativeFailures.size).toBe(0)
    f.service.dispose()
  })
})

describe('shared reminder delivery', () => {
  it('blocks independent snooze timers and late native failure writes during clear and shutdown', async () => {
    vi.useFakeTimers()
    const admission = createBusinessMutationAdmission()
    const f = fixture(1, { runMutation: admission.run, canRunMutations: admission.canAdmit })
    f.service.tick(Date.now())
    const lateFailure = f.notifications.sendReminder.mock.calls[0][1]
    f.store.activateDueReminders.mockClear()
    f.store.getNextReminderTime.mockReturnValue(Date.now() + 10)
    f.service.refresh()
    let finishClear
    const clearing = admission.clear(
      () =>
        new Promise((resolve) => {
          finishClear = resolve
        })
    )
    for (let i = 0; i < 5; i++) await Promise.resolve()
    vi.advanceTimersByTime(10)
    lateFailure(new Error('late native failure'))
    expect(f.store.activateDueReminders).not.toHaveBeenCalled()
    expect(f.store.markReminderFailure).not.toHaveBeenCalled()
    finishClear()
    await clearing
    f.store.getNextReminderTime.mockReturnValue(null)
    f.service.tick(Date.now())
    expect(f.store.activateDueReminders).toHaveBeenCalledOnce()
    expect(f.store.markReminderFailure).toHaveBeenCalledOnce()
    f.store.markReminderFailure.mockClear()
    admission.preventNewMutations()
    lateFailure(new Error('during shutdown'))
    expect(f.store.markReminderFailure).not.toHaveBeenCalled()
    f.service.dispose()
  })

  it('attempts every presentation release after one fails and never repeats disposal', () => {
    const f = fixture()
    f.popup.dispose.mockImplementationOnce(() => {
      throw new Error('popup release failed')
    })
    expect(() => f.service.dispose()).toThrow('提醒展示资源释放失败')
    expect(f.tray.dispose).toHaveBeenCalledOnce()
    expect(f.notifications.dispose).toHaveBeenCalledOnce()
    f.service.dispose()
    expect(f.popup.dispose).toHaveBeenCalledOnce()
    expect(f.service.disposed).toBe(true)
  })
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

it('validates Windows channel masks and future snooze dates', () => {
  expect(normalizeReminderChannels(undefined, true)).toBe(1)
  expect(normalizeReminderChannels(7)).toBe(7)
  expect(() => normalizeReminderChannels(8)).toThrow()
  expect(() => assertSnoozeTime(1000, 1000)).toThrow()
  expect(() => assertSnoozeTime(Infinity, 1000)).toThrow()
  expect(assertSnoozeTime(1001, 1000)).toBe(1001)
})
