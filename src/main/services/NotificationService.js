import { Notification } from 'electron'
import { pathToFileURL } from 'url'
import { sendNotificationSafely } from './notification-guard.js'

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
    snoozeDelayMs,
    snoozeNote
  }) {
    this.appProtocol = appProtocol
    this.capability = capability
    this.getMainWindow = getMainWindow
    this.icon = icon
    this.platform = platform
    this.snoozeDelayMs = snoozeDelayMs
    this.snoozeNote = snoozeNote
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
      const openUrl = `${this.appProtocol}://notification/open?id=${parsedNoteId}`
      const snoozeUrl = `${this.appProtocol}://notification/snooze?id=${parsedNoteId}`
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
        <actions>
          <action content="明白" arguments="dismiss" activationType="system"/>
          <action content="稍后提醒（10分钟）" arguments="${snoozeUrl}" activationType="protocol"/>
        </actions>
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
    if (hasNote) {
      options.actions = [{ type: 'button', text: '稍后提醒（10分钟）' }]
      options.closeButtonText = '明白'
    }
    const notification = new Notification(options)
    if (hasNote) {
      notification.on('click', () => {
        const mainWindow = this.getMainWindow()
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show()
          mainWindow.focus()
        }
      })
      notification.on('action', (_event, index) => {
        if (index !== 0) return
        const result = this.snoozeNote(parsedNoteId, this.snoozeDelayMs)
        if (result) {
          console.log(`[notification] 便签 #${parsedNoteId} 已延后 10 分钟提醒`)
        } else {
          console.log(`[notification] 便签 #${parsedNoteId} 已非进行中，忽略延后提醒`)
        }
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
}
