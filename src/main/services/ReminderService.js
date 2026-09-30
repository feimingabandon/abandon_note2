import * as reminderStore from '../db/db-reminders.js'
import { availableReminderChannels, SNOOZE_MINUTES } from '../../shared/reminder-rules.js'

export class ReminderService {
  constructor({
    notifications,
    popup,
    tray,
    onChanged = () => {},
    store = reminderStore,
    platform = process.platform,
    reportError = console.error
  }) {
    Object.assign(this, { notifications, popup, tray, onChanged, store, platform, reportError })
    this.customIds = new Set()
    this.activeIds = new Set()
    this.timer = null
    this.disposed = false
  }

  tick(now = Date.now()) {
    if (this.disposed) return
    const rounds = this.store.activateDueReminders(now)
    for (const round of rounds) {
      const channels = availableReminderChannels(round.reminder_channels, this.platform)
      if (
        !(channels & 1) ||
        round.delivered_channels & 1 ||
        round.attempts >= 3 ||
        round.next_attempt_at > now
      )
        continue
      this.store.markReminderAttempt(round.id, now)
      try {
        // A successful request is not proof Windows displayed the toast. Failed
        // events clear the delivery bit, with at most three attempts per round.
        if (
          this.notifications.sendReminder(round, (error) => {
            if (this.disposed) return
            this.store.markReminderFailure(round.id, 1)
            this.reportError('[reminders] Windows notification failed', error)
          })
        )
          this.store.markReminderDelivered(round.id, 1)
      } catch (error) {
        this.reportError('[reminders] notification failed', error)
      }
    }
    this.refresh()
  }

  refresh() {
    if (this.disposed) return
    const rounds = this.store.listActiveReminders()
    const live = new Set(rounds.map((r) => r.id))
    const changed =
      live.size !== this.activeIds.size || [...live].some((id) => !this.activeIds.has(id))
    this.activeIds = live
    this.customIds = new Set([...this.customIds].filter((id) => live.has(id)))
    const hasChannel = (r, bit) =>
      availableReminderChannels(r.reminder_channels, this.platform) & bit
    const independently = (action) => {
      try {
        action()
      } catch (error) {
        this.reportError('[reminders] presentation failed', error)
      }
    }
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
    if (
      round.state !== 'active' ||
      round.note_status !== 'in_progress' ||
      round.is_deleted ||
      !round.reminder_channels
    ) {
      throw new Error('这轮提醒已处理，请使用最新提醒')
    }
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
    this.disposed = true
    clearTimeout(this.timer)
    this.timer = null
    this.popup.dispose()
    this.tray.dispose()
    this.notifications.dispose()
  }
}
