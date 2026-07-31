import { collectDeviceInfo, classifySystem } from './device-info.js'
import { RemoteClient } from './remote-client.js'

function normalizeNotice(raw) {
  const sequence = Number(raw?.sequence)
  const title = typeof raw?.title === 'string' ? raw.title.trim() : ''
  const body = typeof raw?.body === 'string' ? raw.body : ''
  const publishedAt = Date.parse(raw?.published_at)
  const link = raw?.link == null || raw.link === '' ? null : String(raw.link)
  if (!Number.isInteger(sequence) || sequence <= 0) throw new Error('通知 sequence 无效')
  if (!title || title.length > 50) throw new Error('通知标题无效')
  if (!body.trim() || body.length > 20000) throw new Error('通知正文无效')
  if (!Number.isFinite(publishedAt)) throw new Error('通知发布时间无效')
  if (link) {
    const url = new URL(link)
    if (url.protocol !== 'https:') throw new Error('通知链接不是 HTTPS')
  }
  return {
    id: String(raw.id || sequence),
    sequence,
    title,
    body: body.replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
    link,
    publishedAt
  }
}

export class RemoteCoordinator {
  constructor({
    app,
    baseUrl,
    getSettings,
    getInstallationId,
    getCursor,
    ingestNotices,
    onNoticesChanged = () => {}
  }) {
    this.app = app
    this.client = new RemoteClient(baseUrl)
    this.getSettings = getSettings
    this.getInstallationId = getInstallationId
    this.getCursor = getCursor
    this.ingestNotices = ingestNotices
    this.onNoticesChanged = onNoticesChanged
    this.sessionId = null
  }

  async start() {
    const remote = this.getSettings()?.remote
    if (!this.client.configured || (!remote?.receiveNotices && !remote?.uploadDeviceInfo)) return

    const health = await this.checkHealth()
    if (!health.available) {
      console.warn('[remote] 服务器不可用，本次启动停止远端流程:', health.error)
      return
    }

    const tasks = []
    if (remote.uploadDeviceInfo && health.reportService) {
      tasks.push(this.#startSession())
    }
    if (remote.receiveNotices && health.noticeService) {
      tasks.push(this.#pullNotices())
    }
    await Promise.allSettled(tasks)
  }

  async checkHealth() {
    if (!this.client.configured) {
      return {
        available: false,
        noticeService: false,
        reportService: false,
        checkedAt: Date.now(),
        error: '未配置远程服务地址'
      }
    }
    try {
      const result = await this.client.health()
      const available = result?.status === 'ok' && Number(result?.api_version) === 1
      return {
        available,
        noticeService: available && result?.notice_service === true,
        reportService: available && result?.report_service === true,
        checkedAt: Date.now(),
        error: available ? null : '服务器响应版本不兼容'
      }
    } catch (error) {
      return {
        available: false,
        noticeService: false,
        reportService: false,
        checkedAt: Date.now(),
        error: error?.message || '连接失败'
      }
    }
  }

  async #startSession() {
    try {
      const deviceInfo = await collectDeviceInfo(this.app, this.getInstallationId())
      const result = await this.client.startSession(deviceInfo)
      if (typeof result?.session_id === 'string' && result.session_id) {
        this.sessionId = result.session_id
      }
    } catch (error) {
      console.warn('[remote] 上传启动与设备信息失败:', error)
    }
  }

  async #pullNotices() {
    try {
      const result = await this.client.pullNotices({
        system: classifySystem(),
        app_version: this.app.getVersion(),
        cursor: this.getCursor()
      })
      const nextCursor = Number(result?.next_cursor)
      if (!Number.isInteger(nextCursor) || nextCursor < 0 || !Array.isArray(result?.notices)) {
        throw new Error('服务器通知响应格式无效')
      }
      const notices = result.notices.map(normalizeNotice)
      const inserted = this.ingestNotices(notices, nextCursor)
      if (inserted > 0) this.onNoticesChanged({ reason: 'remote-sync', inserted })
    } catch (error) {
      console.warn('[remote] 获取远程通知失败:', error)
    }
  }

  async stop() {
    const sessionId = this.sessionId
    this.sessionId = null
    if (!sessionId) return
    try {
      await this.client.endSession(sessionId)
    } catch (error) {
      console.warn('[remote] 上传退出时间失败:', error)
    }
  }
}
