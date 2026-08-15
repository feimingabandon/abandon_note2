import { randomUUID } from 'crypto'

import { collectDeviceInfo, classifySystem } from './device-info.js'
import { RemoteClient } from './remote-client.js'

const MAX_NOTICE_SYNC_PAGES = 20

function normalizeNotice(raw) {
  const title = typeof raw?.title === 'string' ? raw.title.trim() : ''
  const body = typeof raw?.body === 'string' ? raw.body : ''
  const publishedAt = Date.parse(raw?.published_at)
  const link = raw?.link == null || raw.link === '' ? null : String(raw.link)
  if (!title || title.length > 50) throw new Error('通知标题无效')
  if (!body.trim() || body.length > 20000) throw new Error('通知正文无效')
  if (!Number.isFinite(publishedAt)) throw new Error('通知发布时间无效')
  if (link) {
    const url = new URL(link)
    if (url.protocol !== 'https:') throw new Error('通知链接不是 HTTPS')
  }
  return {
    title,
    body: body.replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
    link,
    publishedAt
  }
}

function normalizeNoticeEvent(raw) {
  const sequence = Number(raw?.sequence)
  const type = raw?.type
  const noticeId = String(raw?.notice_id || '').trim()
  if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error('通知事件序号无效')
  if (!['upsert', 'revoke'].includes(type)) throw new Error('通知事件类型无效')
  if (!noticeId) throw new Error('通知 ID 无效')
  if (type === 'revoke') return { sequence, type, noticeId, notifyAgain: false }
  return {
    sequence,
    type,
    noticeId,
    notifyAgain: raw?.notify_again === true,
    notice: normalizeNotice(raw?.notice)
  }
}

export class RemoteCoordinator {
  constructor({
    app,
    baseUrl,
    getSettings,
    getInstallationId,
    getNoticeSyncState,
    applyNoticeEvents,
    isServiceRetired = () => false,
    markServiceRetired = () => {},
    queueSessionEnd = () => {},
    listPendingSessionEnds = () => [],
    markSessionEndAttempt = () => {},
    removePendingSessionEnd = () => {},
    clearPendingSessionEnds = () => {},
    onNoticesChanged = () => {},
    onHealthChanged = () => {}
  }) {
    this.app = app
    this.client = new RemoteClient(baseUrl)
    this.getSettings = getSettings
    this.getInstallationId = getInstallationId
    this.getNoticeSyncState = getNoticeSyncState
    this.applyNoticeEvents = applyNoticeEvents
    this.isServiceRetired = isServiceRetired
    this.markServiceRetired = markServiceRetired
    this.queueSessionEnd = queueSessionEnd
    this.listPendingSessionEnds = listPendingSessionEnds
    this.markSessionEndAttempt = markSessionEndAttempt
    this.removePendingSessionEnd = removePendingSessionEnd
    this.clearPendingSessionEnds = clearPendingSessionEnds
    this.onNoticesChanged = onNoticesChanged
    this.onHealthChanged = onHealthChanged
    this.sessionId = null
    this.sessionStartPromise = null
    this.stopPromise = null
    this.lastHealth = {
      available: false,
      noticeService: false,
      reportService: false,
      serviceState: 'unknown',
      retired: false,
      message: null,
      checkedAt: null,
      checking: false,
      skipped: false,
      error: '本次启动尚未检测远程服务'
    }
  }

  async start() {
    const remote = this.getSettings()?.remote
    if (this.isServiceRetired()) {
      this.#setHealth({
        ...this.lastHealth,
        serviceState: 'retired',
        retired: true,
        checkedAt: Date.now(),
        checking: false,
        skipped: true,
        message: '远程服务已正式停止，本地功能不受影响',
        error: null
      })
      return
    }
    if (!this.client.configured || (!remote?.receiveNotices && !remote?.uploadDeviceInfo)) {
      this.#setHealth({
        ...this.lastHealth,
        checkedAt: Date.now(),
        checking: false,
        skipped: this.client.configured,
        error: this.client.configured ? '本次启动未启用远程功能' : '未配置远程服务地址'
      })
      return
    }

    this.#setHealth({ ...this.lastHealth, checking: true, error: null })
    const health = await this.checkHealth()
    if (health.retired || !health.available) {
      if (!health.retired)
        console.warn('[remote] 服务器不可用，本次启动停止远端流程:', health.error)
      return
    }

    const tasks = []
    if (remote.uploadDeviceInfo && health.reportService) {
      tasks.push(
        (async () => {
          await this.#flushPendingSessionEnds()
          await this.#startSession()
        })()
      )
    }
    if (remote.receiveNotices && health.noticeService) tasks.push(this.#pullNotices())
    await Promise.allSettled(tasks)
  }

  async checkHealth() {
    let health
    try {
      const result = await this.client.health()
      const compatible = result?.status === 'ok' && Number(result?.api_version) === 2
      const serviceState = compatible ? String(result?.service_state || 'active') : 'incompatible'
      const retired = compatible && serviceState === 'retired'
      const available = compatible && serviceState === 'active'
      if (retired) {
        this.markServiceRetired()
        this.clearPendingSessionEnds()
      }
      health = {
        available,
        noticeService: available && result?.notice_service === true,
        reportService: available && result?.report_service === true,
        serviceState,
        retired,
        message: typeof result?.message === 'string' ? result.message : null,
        retiredAt: typeof result?.retired_at === 'string' ? result.retired_at : null,
        checkedAt: Date.now(),
        checking: false,
        skipped: false,
        error: compatible
          ? available || retired
            ? null
            : result?.message || '远程服务正在维护'
          : '服务器响应版本不兼容'
      }
    } catch (error) {
      health = {
        ...this.lastHealth,
        available: false,
        noticeService: false,
        reportService: false,
        serviceState: 'unavailable',
        retired: false,
        checkedAt: Date.now(),
        checking: false,
        skipped: false,
        error: error?.message || '连接失败'
      }
    }
    return this.#setHealth(health)
  }

  getHealthSnapshot() {
    return { ...this.lastHealth }
  }

  hasActiveSession() {
    return Boolean(this.sessionId)
  }

  #setHealth(health) {
    this.lastHealth = { ...health }
    const snapshot = this.getHealthSnapshot()
    try {
      this.onHealthChanged(snapshot)
    } catch (error) {
      console.warn('[remote] 广播健康状态失败:', error)
    }
    return snapshot
  }

  #startSession() {
    const sessionId = randomUUID()
    this.sessionId = sessionId
    const promise = (async () => {
      try {
        const deviceInfo = await collectDeviceInfo(this.app, this.getInstallationId())
        const result = await this.client.startSession({
          ...deviceInfo,
          session_id: sessionId
        })
        if (result?.session_id !== sessionId) throw new Error('服务器返回的会话 ID 不一致')
      } catch (error) {
        console.warn('[remote] 上传启动与设备信息失败:', error)
      }
    })().finally(() => {
      if (this.sessionStartPromise === promise) this.sessionStartPromise = null
    })
    this.sessionStartPromise = promise
    return promise
  }

  async #flushPendingSessionEnds() {
    for (const item of this.listPendingSessionEnds()) {
      try {
        this.markSessionEndAttempt(item.sessionId)
        const result = await this.client.endSession(item.sessionId, item.endedAt)
        if (result?.ok === true) this.removePendingSessionEnd(item.sessionId)
      } catch (error) {
        console.warn('[remote] 补报退出时间失败:', error)
        break
      }
    }
  }

  async #pullNotices() {
    try {
      for (let page = 0; page < MAX_NOTICE_SYNC_PAGES; page += 1) {
        const state = this.getNoticeSyncState()
        const result = await this.client.pullNotices({
          system: classifySystem(),
          app_version: this.app.getVersion(),
          cursor: state.cursor,
          stream_id: state.streamId
        })
        const streamId = String(result?.stream_id || '').trim()
        const nextCursor = Number(result?.next_cursor)
        if (
          !streamId ||
          !Number.isSafeInteger(nextCursor) ||
          nextCursor < 0 ||
          !Array.isArray(result?.events)
        ) {
          throw new Error('服务器通知响应格式无效')
        }
        const events = result.events.map(normalizeNoticeEvent)
        const changes = this.applyNoticeEvents(streamId, events, nextCursor)
        if (changes.changed > 0) this.onNoticesChanged({ reason: 'remote-sync', ...changes })
        if (result?.has_more !== true) break
      }
    } catch (error) {
      console.warn('[remote] 获取远程通知失败:', error)
    }
  }

  stop() {
    if (this.stopPromise) return this.stopPromise
    const sessionId = this.sessionId
    this.sessionId = null
    if (!sessionId) return Promise.resolve()
    const endedAt = new Date().toISOString()
    this.queueSessionEnd(sessionId, endedAt)
    this.stopPromise = (async () => {
      try {
        if (this.sessionStartPromise) await this.sessionStartPromise
        this.markSessionEndAttempt(sessionId)
        const result = await this.client.endSession(sessionId, endedAt)
        if (result?.ok === true) this.removePendingSessionEnd(sessionId)
      } catch (error) {
        console.warn('[remote] 上传退出时间失败，将在下次启动时补报:', error)
      }
    })().finally(() => {
      this.stopPromise = null
    })
    return this.stopPromise
  }
}
