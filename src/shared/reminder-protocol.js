import { SNOOZE_MINUTES } from './reminder-rules.js'

export function parseReminderProtocol(raw, protocol) {
  try {
    const url = new URL(raw)
    if (url.protocol !== `${protocol}:` || url.hostname !== 'notification') return null
    const id = url.searchParams.get('round')
    if (!id || !/^[a-f0-9-]{36}$/i.test(id)) return null
    if (url.pathname === '/custom') return { id, action: 'custom' }
    const rawMinutes = url.searchParams.get('minutes')
    if (url.pathname === '/snooze' && SNOOZE_MINUTES.some((n) => String(n) === rawMinutes)) {
      return { id, action: 'snooze', minutes: Number(rawMinutes) }
    }
  } catch {
    /* Ignore malformed external protocol requests. */
  }
  return null
}
