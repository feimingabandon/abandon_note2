import { randomUUID } from 'crypto'

import { collectDeviceInfo, classifySystem } from './device-info.js'
import { RemoteClient } from './remote-client.js'
import { chinaDate, nextChinaDayDelay } from './daily-clock.js'

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
    onHealthChanged = () => {},
    getDailyState = () => ({}),
    saveDailyState = () => {},
    now = Date.now,
    random = Math.random
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
    this.getDailyState = getDailyState
    this.saveDailyState = saveDailyState
    this.now = now
    this.random = random
    this.dailyState = getDailyState()
    this.dailyTimer = null
    this.dailyBusy = false
    this.started = false
    this.sessionId = null
    this.sessionStartPromise = null
    this.stopPromise = null
    this.stopPreparation = null
    this.stopped = false
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
    if (this.stopped) return
    this.started = true
    this.settingsChanged()
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
    if (this.stopped) return
    if (health.retired || !health.available) {
      if (!health.retired)
        console.warn('[remote] 服务器不可用，本次启动停止远端流程:', health.error)
      return
    }

    const tasks = []
    if (this.getSettings()?.remote?.uploadDeviceInfo && health.reportService) {
      tasks.push(
        (async () => {
          await this.#flushPendingSessionEnds()
          if (this.stopped) return
          await this.#startSession()
        })()
      )
    }
    if (this.getSettings()?.remote?.receiveNotices && health.noticeService)
      tasks.push(this.#pullNotices())
    await Promise.allSettled(tasks)
  }

  async checkHealth() {
    if (this.stopped) return this.getHealthSnapshot()
    let health
    try {
      const result = await this.client.health()
      if (this.stopped) return this.getHealthSnapshot()
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
        statsProtocol: Number(result?.stats_protocol || 0),
        statsEpoch: result?.stats_epoch || null,
        noticeSequence: result?.notice_sequence ?? null,
        noticeStreamId: result?.notice_stream_id || null,
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
      if (this.stopped) return this.getHealthSnapshot()
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

  preventStartup() {
    this.stopped = true
    clearTimeout(this.dailyTimer)
    this.dailyTimer = null
  }

  // One timer for the next China calendar day, never an hourly/minute heartbeat.
  settingsChanged() {
    clearTimeout(this.dailyTimer)
    this.dailyTimer = null
    if (!this.started || this.stopped || this.isServiceRetired() || !this.client.configured) return
    const remote = this.getSettings()?.remote
    if (!remote?.receiveNotices && !remote?.uploadDeviceInfo) return
    this.dailyTimer = setTimeout(
      () => {
        this.dailyTimer = null
        void this.runDaily()
          .catch((error) => console.warn('[remote] 每日任务失败:', error))
          .finally(() => {
            if (!this.stopped) this.settingsChanged()
          })
      },
      nextChinaDayDelay(this.now(), this.random)
    )
    this.dailyTimer.unref?.()
  }

  #saveDaily(patch) {
    if (this.stopped) return
    this.dailyState = { ...this.dailyState, ...patch }
    this.saveDailyState(this.dailyState)
  }

  async runDaily() {
    if (this.stopped || this.dailyBusy || this.isServiceRetired() || !this.client.configured) return
    const remote = this.getSettings()?.remote
    if (!remote?.uploadDeviceInfo && !remote?.receiveNotices) return
    const day = chinaDate(this.now())
    if (this.dailyState.attemptedDay === day) return
    this.dailyBusy = true
    try {
      // Persist the attempt BEFORE a request; failure/restart cannot create a retry loop.
      this.#saveDaily({ attemptedDay: day })
      const health = await this.checkHealth()
      if (this.stopped || !health.available || health.retired) return
      if (
        this.getSettings()?.remote?.uploadDeviceInfo &&
        health.reportService &&
        health.statsProtocol === 3
      ) {
        if (this.dailyState.successDay !== day || this.dailyState.epoch !== health.statsEpoch) {
          try {
            const result = await this.client.reportDaily({
              installation_id: this.getInstallationId(),
              session_id: this.sessionId,
              app_version: this.app.getVersion(),
              system_group: classifySystem(),
              report_date: day,
              stats_protocol: 3,
              stats_epoch: health.statsEpoch
            })
            if (this.stopped) return
            if (result?.ok === true) this.#saveDaily({ successDay: day, epoch: health.statsEpoch })
          } catch (error) {
            console.warn('[remote] 每日上报失败，本日不重试:', error)
          }
        }
      }
      if (this.stopped || !this.getSettings()?.remote?.receiveNotices || !health.noticeService)
        return
      const state = this.getNoticeSyncState()
      if (
        health.noticeSequence == null ||
        health.noticeStreamId !== state.streamId ||
        health.noticeSequence > state.cursor
      ) {
        await this.#pullNotices()
      }
    } finally {
      this.dailyBusy = false
    }
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
    if (this.stopped || !this.getSettings()?.remote?.uploadDeviceInfo) return Promise.resolve()
    const sessionId = randomUUID()
    this.sessionId = sessionId
    const promise = (async () => {
      try {
        const deviceInfo = await collectDeviceInfo(this.app, this.getInstallationId())
        if (this.stopped || !this.getSettings()?.remote?.uploadDeviceInfo) return
        const result = await this.client.startSession({
          ...deviceInfo,
          ...(this.lastHealth.statsProtocol === 3
            ? { stats_protocol: 3, stats_epoch: this.lastHealth.statsEpoch }
            : {}),
          session_id: sessionId
        })
        if (this.stopped) return
        if (result?.session_id !== sessionId) throw new Error('服务器返回的会话 ID 不一致')
        if (this.lastHealth.statsProtocol === 3) {
          this.#saveDaily({ successDay: chinaDate(this.now()), epoch: this.lastHealth.statsEpoch })
        }
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
    if (this.stopped || !this.getSettings()?.remote?.uploadDeviceInfo) return
    for (const item of this.listPendingSessionEnds()) {
      if (this.stopped || !this.getSettings()?.remote?.uploadDeviceInfo) return
      try {
        this.markSessionEndAttempt(item.sessionId)
        const result = await this.client.endSession(item.sessionId, item.endedAt)
        if (this.stopped) return
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
        if (this.stopped || !this.getSettings()?.remote?.receiveNotices) return
        const state = this.getNoticeSyncState()
        const result = await this.client.pullNotices({
          system: classifySystem(),
          app_version: this.app.getVersion(),
          cursor: state.cursor,
          stream_id: state.streamId
        })
        if (this.stopped || !this.getSettings()?.remote?.receiveNotices) return
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

  prepareStop() {
    if (this.stopPreparation) return this.stopPreparation
    const allowed = this.getSettings()?.remote?.uploadDeviceInfo && !this.isServiceRetired()
    const maySend = allowed && this.lastHealth.available && this.lastHealth.reportService
    this.stopped = true
    clearTimeout(this.dailyTimer)
    this.dailyTimer = null
    const sessionId = this.sessionId
    const endedAt = new Date().toISOString()
    // Checkpoint synchronously at shutdown admission, before an earlier owner
    // can consume the overall deadline. The serial stop stage still owns HTTP.
    if (sessionId && allowed) this.queueSessionEnd(sessionId, endedAt)
    this.sessionId = null
    this.stopPreparation = Object.freeze({
      sessionId: allowed ? sessionId : null,
      endedAt,
      maySend: Boolean(maySend),
      queued: Boolean(sessionId && allowed)
    })
    return this.stopPreparation
  }

  stop({ timeoutMs = 1600 } = {}) {
    if (this.stopPromise) return this.stopPromise
    const { sessionId, endedAt, maySend } = this.prepareStop()
    if (!sessionId) {
      this.stopPromise = Promise.resolve('completed')
      return this.stopPromise
    }
    if (!maySend) {
      this.stopPromise = Promise.resolve('completed')
      return this.stopPromise
    }
    let acceptingResults = true
    let timeout
    const reporting = (async () => {
      try {
        if (this.sessionStartPromise) await this.sessionStartPromise
        if (!acceptingResults) return 'timeout'
        if (!this.getSettings()?.remote?.uploadDeviceInfo) return 'completed'
        this.markSessionEndAttempt(sessionId)
        const result = await this.client.endSession(sessionId, endedAt)
        if (acceptingResults && result?.ok === true) this.removePendingSessionEnd(sessionId)
      } catch (error) {
        console.warn('[remote] 上传退出时间失败，将在下次启动时补报:', error)
      }
      return 'completed'
    })()
    const deadline = new Promise((resolve) => {
      timeout = setTimeout(
        () => {
          acceptingResults = false
          resolve('timeout')
        },
        Math.max(0, Number(timeoutMs) || 0)
      )
    })
    this.stopPromise = Promise.race([reporting, deadline]).finally(() => {
      acceptingResults = false
      clearTimeout(timeout)
    })
    return this.stopPromise
  }
}
