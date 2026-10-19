import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
afterEach(() => vi.restoreAllMocks())
const id = 'a5e25203-aa86-4fd5-9531-09a92c543990'

function fixture() {
  const send = vi.fn()
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }
  return {
    send,
    service: new NotificationService({
      appProtocol: 'abandon-note',
      capability: { supported: true },
      icon: 'icon.png',
      getMainWindow: () => window
    })
  }
}

it('uses five escaped protocol actions that parse back to the same reminder round', () => {
  const { service } = fixture()
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

it('keeps ordinary Windows notifications without note ids and falls back after a native failure', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { service, send } = fixture()
  service.send('引擎暂时不可用', { title: '调度器告警', silent: true })
  const notification = state.notifications[0]
  expect(notification.options).toEqual({
    title: '调度器告警',
    body: '引擎暂时不可用',
    silent: true,
    icon: 'icon.png'
  })
  notification.emit('failed', {}, new Error('Windows notification unavailable'))
  expect(send).toHaveBeenCalledWith('app:message', {
    type: 'warning',
    text: '调度器告警：引擎暂时不可用',
    duration: 6000
  })
  service.dispose()
})

it('keeps the Windows protocol launch for a note notification and its failure fallback', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { service, send } = fixture()
  service.send('note <content>', { title: '便签提醒', noteId: 42 })
  const notification = state.notifications[0]
  expect(notification.options.toastXml).toContain('launch="abandon-note://notification/open"')
  expect(notification.options.toastXml).toContain('note &lt;content&gt;')
  notification.emit('failed', {}, new Error('Windows toast unavailable'))
  expect(send).toHaveBeenCalledWith(
    'app:message',
    expect.objectContaining({ type: 'warning', text: '便签提醒：note <content>' })
  )
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
