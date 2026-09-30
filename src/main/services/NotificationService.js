import { Notification } from 'electron'
import { pathToFileURL } from 'url'
import { sendNotificationSafely } from './notification-guard.js'
import { SNOOZE_MINUTES } from '../../shared/reminder-rules.js'

function escapeToastXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** 系统通知及应用内降级的统一边界。 */
export class NotificationService {
  constructor({
    appProtocol,
    capability,
    getMainWindow,
    icon,
    platform = process.platform,
    revealApplication
  }) {
    this.appProtocol = appProtocol
    this.capability = capability
    this.getMainWindow = getMainWindow
    this.icon = icon
    this.platform = platform
    this.revealApplication = revealApplication
    this.reminders = new Map()
  }

  notifyFailure(scene, title, body, error) {
    console.error(`[notification] ${scene}发送失败，降级为应用内消息条:`, error)
    const mainWindow = this.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
    try {
      const text = `${title}：${String(body || '')}`.trim().slice(0, 80) || title
      mainWindow.webContents.send('app:message', { type: 'warning', text, duration: 6000 })
    } catch (fallbackError) {
      console.error('[notification] 应用内消息条下发失败:', fallbackError)
    }
  }

  send(body, { title = '便签提醒', silent = false, noteId = null } = {}) {
    const summary = String(body || '') || '（空内容）'
    const parsedNoteId = Number(noteId)

    if (this.platform === 'win32' && Number.isInteger(parsedNoteId) && parsedNoteId > 0) {
      const openUrl = `${this.appProtocol}://notification/open`
      const iconUri = escapeToastXml(pathToFileURL(this.icon).href)
      const toastXml = `<toast launch="${openUrl}" activationType="protocol">
        <visual>
          <binding template="ToastGeneric">
            <image placement="appLogoOverride" src="${iconUri}"/>
            <text>${escapeToastXml(title)}</text>
            <text>${escapeToastXml(summary)}</text>
          </binding>
        </visual>
        <audio silent="${silent ? 'true' : 'false'}"/>
      </toast>`
      const notification = new Notification({ toastXml })
      notification.on('failed', (_event, error) => {
        this.notifyFailure('Windows 富通知', title, summary, error)
      })
      notification.show()
      return
    }

    const hasNote = Number.isInteger(parsedNoteId) && parsedNoteId > 0
    const options = { title, body: summary, silent, icon: this.icon }
    const notification = new Notification(options)
    if (hasNote) {
      notification.on('click', () => {
        this.revealApplication?.()
      })
    }
    notification.on('failed', (_event, error) => {
      this.notifyFailure('系统通知', title, summary, error)
    })
    notification.show()
  }

  trySend(body, options) {
    if (!this.capability.supported) return false
    return sendNotificationSafely((...args) => this.send(...args), body, options)
  }

  sendReminder(round, onFailed) {
    if (!this.capability.supported || !Notification.isSupported()) return false
    this.closeReminder(round.id)
    const title = round.from_template ? '循环便签提醒' : '便签提醒'
    const body = String(round.content || '（空内容）').slice(0, 1000)
    const root = `${this.appProtocol}://notification`
    const action = (label, path) =>
      `<action content="${escapeToastXml(label)}" activationType="protocol" arguments="${escapeToastXml(root + path)}"/>`
    // Five protocol buttons reuse the existing single-instance/cold-start path.
    const toastXml = `<toast launch="${root}/open" activationType="protocol"><visual><binding template="ToastGeneric">
      <image placement="appLogoOverride" src="${escapeToastXml(pathToFileURL(this.icon).href)}"/>
      <text>${escapeToastXml(title)}</text><text>${escapeToastXml(body)}</text>
      </binding></visual><actions>
      ${SNOOZE_MINUTES.map((m) => action(`${m} 分钟后`, `/snooze?round=${encodeURIComponent(round.id)}&minutes=${m}`)).join('')}
      ${action('自定义时间…', `/custom?round=${encodeURIComponent(round.id)}`)}
      </actions><audio silent="false"/></toast>`
    const notification = new Notification({
      id: round.id,
      groupId: 'note-reminders',
      title,
      body,
      icon: this.icon,
      silent: false,
      ...(this.platform === 'win32' ? { toastXml } : {})
    })
    if (this.platform !== 'win32') notification.on('click', () => this.revealApplication?.())
    notification.on('failed', (_event, error) => onFailed?.(error))
    this.reminders.set(round.id, notification)
    notification.show()
    return true
  }

  closeReminder(id) {
    const notification = this.reminders.get(id)
    if (!notification) return
    this.reminders.delete(id)
    notification.removeAllListeners()
    notification.close()
  }

  reconcileReminders(ids) {
    for (const id of this.reminders.keys()) if (!ids.has(id)) this.closeReminder(id)
  }

  dispose() {
    // Keep delivered Windows notifications actionable across app restarts.
    for (const notification of this.reminders.values()) notification.removeAllListeners()
    this.reminders.clear()
  }
}
