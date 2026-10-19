import * as reminderStore from '../db/db-reminders.js'
import { normalizeReminderChannels, SNOOZE_MINUTES } from '../../shared/reminder-rules.js'

const NATIVE_IDENTITY_FIELDS = ['id', 'note_id', 'parent_id', 'due_at', 'created_at', 'attempts']
const nativeIdentity = (round) =>
  Object.freeze(Object.fromEntries(NATIVE_IDENTITY_FIELDS.map((field) => [field, round[field]])))

function assertActiveReminder(round) {
  if (!round) throw new Error('提醒已不存在')
  if (
    round.state !== 'active' ||
    round.note_status !== 'in_progress' ||
    round.is_deleted ||
    !round.reminder_channels
  ) {
    throw new Error('这轮提醒已处理，请使用最新提醒')
  }
}

export class ReminderService {
  constructor({
    notifications,
    popup,
    tray,
    onChanged = () => {},
    onActiveChanged = () => {},
    store = reminderStore,
    runMutation = (operation) => operation(),
    canRunMutations = () => true,
    reportError = console.error
  }) {
    Object.assign(this, {
      notifications,
      popup,
      tray,
      onChanged,
      onActiveChanged,
      store,
      reportError
    })
    this.runMutation = runMutation
    this.canRunMutations = canRunMutations
    this.customIds = new Set()
    this.activeIds = new Set()
    this.timer = null
    this.disposed = false
    this.nativeDeliveries = new Map()
    this.pendingNativeFailures = new Map()
  }

  tick(now = Date.now()) {
    if (this.disposed || !this.canRunMutations()) return
    return this.runMutation(() => this.tickAdmitted(now))
  }

  tickAdmitted(now) {
    this.flushNativeFailures()
    const rounds = this.store.activateDueReminders(now)
    for (const round of rounds) {
      const channels = normalizeReminderChannels(round.reminder_channels)
      if (
        !(channels & 1) ||
        round.delivered_channels & 1 ||
        round.attempts >= 3 ||
        round.next_attempt_at > now
      )
        continue
      this.store.markReminderAttempt(round.id, now)
      let delivery
      try {
        const current = this.store.getReminder(round.id)
        if (!current) continue
        delivery = { identity: nativeIdentity(current), sending: true }
        this.nativeDeliveries.set(round.id, delivery)
        // A successful request is not proof Windows displayed the toast. Failed
        // events clear the delivery bit, with at most three attempts per round.
        if (
          this.notifications.sendReminder(round, (error) =>
            this.recordNativeFailure(delivery, error)
          )
        )
          this.store.markReminderDelivered(round.id, 1)
      } catch (error) {
        this.reportError('[reminders] notification failed', error)
      } finally {
        if (delivery) delivery.sending = false
        // A synchronous failure event can precede the accepted-delivery bit.
        // Apply it only after send/markDelivered have both finished.
        this.flushNativeFailures()
      }
    }
    this.refresh()
  }

  recordNativeFailure(delivery, error) {
    const id = delivery.identity.id
    if (this.disposed || this.nativeDeliveries.get(id) !== delivery) return
    // During clear/shutdown this is an in-memory observation, never a queued note write.
    this.pendingNativeFailures.set(id, delivery)
    this.reportError('[reminders] Windows notification failed', error)
    if (!delivery.sending && this.canRunMutations()) {
      try {
        this.runMutation(() => this.flushNativeFailures())
      } catch (writeError) {
        this.reportError('[reminders] native failure deferred', writeError)
      }
    }
  }

  flushNativeFailures() {
    if (this.disposed || !this.canRunMutations()) return
    for (const [id, delivery] of this.pendingNativeFailures) {
      if (delivery.sending) continue
      if (this.nativeDeliveries.get(id) !== delivery) {
        this.pendingNativeFailures.delete(id)
        continue
      }
      try {
        const current = this.store.getReminder(id)
        const valid =
          current &&
          current.state === 'active' &&
          current.note_status === 'in_progress' &&
          !current.is_deleted &&
          normalizeReminderChannels(current.reminder_channels) & 1 &&
          NATIVE_IDENTITY_FIELDS.every((field) => current[field] === delivery.identity[field])
        if (valid) this.store.markReminderFailure(id, 1)
        else this.nativeDeliveries.delete(id)
        this.pendingNativeFailures.delete(id)
      } catch (error) {
        // Keep this exact delivery eligible for the next legal tick if SQL failed.
        this.reportError('[reminders] native failure update failed', error)
      }
    }
  }

  refresh() {
    if (this.disposed) return
    const rounds = this.store.listActiveReminders()
    const live = new Set(rounds.map((r) => r.id))
    for (const id of this.nativeDeliveries.keys()) {
      if (live.has(id)) continue
      this.nativeDeliveries.delete(id)
      this.pendingNativeFailures.delete(id)
    }
    const changed =
      live.size !== this.activeIds.size || [...live].some((id) => !this.activeIds.has(id))
    this.activeIds = live
    this.customIds = new Set([...this.customIds].filter((id) => live.has(id)))
    const hasChannel = (r, bit) => normalizeReminderChannels(r.reminder_channels) & bit
    const independently = (action) => {
      try {
        action()
      } catch (error) {
        this.reportError('[reminders] presentation failed', error)
      }
    }
    if (changed) independently(() => this.onActiveChanged(live.size))
    independently(() =>
      this.notifications.reconcileReminders(
        new Set(rounds.filter((r) => hasChannel(r, 1)).map((r) => r.id))
      )
    )
    independently(() =>
      this.popup.sync(
        rounds.filter(
          (r) => this.customIds.has(r.id) || (hasChannel(r, 2) && !(r.dismissed_channels & 2))
        )
      )
    )
    independently(() => this.tray.sync(rounds.filter((r) => hasChannel(r, 4)).map((r) => r.id)))
    // A single precise timer handles snoozes; the minute scheduler also recovers
    // overdue tasks after startup/resume and failures.
    clearTimeout(this.timer)
    this.timer = null
    const dueAt = this.store.getNextReminderTime()
    if (dueAt !== null) {
      this.timer = setTimeout(
        () => {
          this.timer = null
          try {
            this.tick()
          } catch (error) {
            this.reportError('[reminders] timer failed', error)
          }
        },
        Math.min(2147483647, Math.max(0, dueAt - Date.now()))
      )
      this.timer.unref?.()
    }
    if (changed) independently(() => this.onChanged())
  }

  action({ id, action, minutes, dueAt }) {
    if (this.disposed) throw new Error('软件正在退出')
    const round = this.store.getReminder(id)
    if (!round) throw new Error('提醒已不存在')
    if (action === 'snooze') {
      if (minutes !== undefined && !SNOOZE_MINUTES.includes(Number(minutes)))
        throw new Error('稍后时间无效')
      const result = this.store.snoozeReminder(
        id,
        minutes === undefined ? dueAt : Date.now() + Number(minutes) * 60000
      )
      this.customIds.delete(id)
      this.refresh()
      this.onChanged(round.note_id)
      return { created: result.created, dueAt: result.reminder.due_at }
    }
    assertActiveReminder(round)
    if (action === 'custom') {
      this.customIds.add(id)
      this.refresh()
      this.popup.focusRound(id)
      return { opened: true }
    }
    if (action === 'dismiss') {
      this.store.dismissReminderChannel(id, 2)
      this.customIds.delete(id)
      this.refresh()
      return { dismissed: true }
    }
    throw new Error('提醒操作无效')
  }

  dismissAll(ids) {
    if (this.disposed) throw new Error('软件正在退出')
    if (!ids.length) return { dismissed: 0 }
    let dismissed = 0
    // Keep each round independently dismissible, but query/publish the active list once.
    for (const id of new Set(ids)) {
      try {
        assertActiveReminder(this.store.getReminder(id))
        this.store.dismissReminderChannel(id, 2)
        this.customIds.delete(id)
        dismissed += 1
      } catch (error) {
        this.reportError('[reminders] dismiss failed', error)
      }
    }
    this.refresh()
    return { dismissed }
  }

  nativeAction(payload) {
    try {
      return this.action(payload)
    } catch (error) {
      this.reportError('[reminders] ignored notification action', error)
      return { error: error.message }
    }
  }

  showAll() {
    const rounds = this.store.listActiveReminders()
    for (const round of rounds) this.customIds.add(round.id)
    this.refresh()
    this.tray.acknowledge()
    if (rounds.length) this.popup.focusRound(rounds[0].id)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.timer)
    this.timer = null
    this.nativeDeliveries.clear()
    this.pendingNativeFailures.clear()
    const failures = []
    for (const presentation of [this.popup, this.tray, this.notifications]) {
      try {
        presentation.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) throw new AggregateError(failures, '提醒展示资源释放失败')
  }
}
