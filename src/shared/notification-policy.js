import { normalizeReminderChannels } from './reminder-rules.js'

/** Product capability for the Windows-only runtime; OS delivery can still fail. */
export function getSystemNotificationCapability() {
  return { supported: true, reason: '' }
}

export function enforceSystemNotificationPolicy(payload) {
  const next = payload && typeof payload === 'object' ? { ...payload } : {}
  if (next.reminderChannels !== undefined) {
    next.reminderChannels = normalizeReminderChannels(next.reminderChannels)
    next.notifyEnabled = next.reminderChannels !== 0
  }
  return next
}
