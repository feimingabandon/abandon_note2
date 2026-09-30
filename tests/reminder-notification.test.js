import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import { parseReminderProtocol } from '../src/shared/reminder-protocol.js'
const state = vi.hoisted(() => ({ notifications: [] }))
vi.mock('electron', () => ({
  Notification: class extends EventEmitter {
    static isSupported() {
      return true
    }
    constructor(options) {
      super()
      this.options = options
      state.notifications.push(this)
    }
    show() {}
    close() {
      this.closed = true
    }
  }
}))
import { NotificationService } from '../src/main/services/NotificationService.js'
beforeEach(() => {
  state.notifications = []
})
const id = 'a5e25203-aa86-4fd5-9531-09a92c543990'
it('uses five escaped protocol actions that parse back to the same reminder round', () => {
  const service = new NotificationService({
    appProtocol: 'abandon-note',
    platform: 'win32',
    capability: { supported: true },
    icon: 'icon.png'
  })
  service.sendReminder({ id, content: 'hello <world> & "test"' })
  const xml = state.notifications[0].options.toastXml
  expect(xml).toContain('hello &lt;world&gt; &amp; &quot;test&quot;')
  const urls = [...xml.matchAll(/<action .*?arguments="([^"]+)"/g)].map((m) =>
    m[1].replaceAll('&amp;', '&')
  )
  expect(urls).toHaveLength(5)
  for (const [index, minutes] of [5, 10, 30, 60].entries()) {
    expect(parseReminderProtocol(urls[index], 'abandon-note')).toEqual({
      id,
      action: 'snooze',
      minutes
    })
  }
  expect(parseReminderProtocol(urls[4], 'abandon-note')).toEqual({ id, action: 'custom' })
  service.reconcileReminders(new Set())
  expect(state.notifications[0].closed).toBe(true)
  service.dispose()
})
it('rejects malformed, unrelated and unsupported external protocol actions', () => {
  for (const url of [
    'x',
    'https://notification/custom?round=' + id,
    'abandon-note://other/custom?round=' + id,
    'abandon-note://notification/custom?round=1',
    ...['', '0', '-1', '05', '1.0', '999'].map(
      (n) => `abandon-note://notification/snooze?round=${id}&minutes=${n}`
    )
  ]) {
    expect(parseReminderProtocol(url, 'abandon-note')).toBeNull()
  }
})
