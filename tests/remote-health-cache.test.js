import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteCoordinator } from '../src/main/services/remote/remote-coordinator.js'

function createCoordinator(remote, overrides = {}) {
  return new RemoteCoordinator({
    app: {
      getVersion: () => '0.9.2',
      getLocale: () => 'zh-CN',
      getGPUInfo: async () => ({ gpuDevice: [] })
    },
    baseUrl: 'https://example.test',
    getSettings: () => ({ remote }),
    getInstallationId: () => 'installation-id',
    getNoticeSyncState: () => ({ streamId: null, cursor: 0 }),
    applyNoticeEvents: () => ({ changed: 0, inserted: 0, updated: 0, revoked: 0 }),
    ...overrides
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('remote startup health cache', () => {
  it('does not contact the server when remote features are disabled', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const coordinator = createCoordinator({ receiveNotices: false, uploadDeviceInfo: false })

    await coordinator.start()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(coordinator.getHealthSnapshot()).toMatchObject({
      available: false,
      checking: false,
      skipped: true,
      error: '本次启动未启用远程功能'
    })
  })

  it('returns the startup result repeatedly without another request', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith('/health')) {
        return {
          ok: true,
          json: async () => ({
            status: 'ok',
            api_version: 2,
            service_state: 'active',
            notice_service: true,
            report_service: false
          })
        }
      }
      return {
        ok: true,
        json: async () => ({ stream_id: 'stream-id', next_cursor: 0, events: [] })
      }
    })
    vi.stubGlobal('fetch', fetchMock)
    const coordinator = createCoordinator({ receiveNotices: true, uploadDeviceInfo: false })

    await coordinator.start()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const first = coordinator.getHealthSnapshot()
    const second = coordinator.getHealthSnapshot()
    expect(first).toMatchObject({ available: true, checking: false })
    expect(second).toEqual(first)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('publishes the final result when a settings view reads the in-flight snapshot', async () => {
    let resolveHealth
    const fetchMock = vi.fn((url) => {
      if (String(url).endsWith('/health')) {
        return new Promise((resolve) => {
          resolveHealth = () =>
            resolve({
              ok: true,
              json: async () => ({
                status: 'ok',
                api_version: 2,
                service_state: 'active',
                notice_service: true,
                report_service: false
              })
            })
        })
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ stream_id: 'stream-id', next_cursor: 0, events: [] })
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const onHealthChanged = vi.fn()
    const coordinator = createCoordinator(
      { receiveNotices: true, uploadDeviceInfo: false },
      { onHealthChanged }
    )

    const startPromise = coordinator.start()
    expect(coordinator.getHealthSnapshot()).toMatchObject({ checking: true })

    resolveHealth()
    await startPromise

    expect(onHealthChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ available: true, checking: false })
    )
  })

  it('persists a formal retirement state and stops all remote work', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: 'ok',
        api_version: 2,
        service_state: 'retired',
        notice_service: false,
        report_service: false,
        message: '远程服务已停止'
      })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const markServiceRetired = vi.fn()
    const clearPendingSessionEnds = vi.fn()
    const coordinator = createCoordinator(
      { receiveNotices: true, uploadDeviceInfo: true },
      { markServiceRetired, clearPendingSessionEnds }
    )

    await coordinator.start()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(markServiceRetired).toHaveBeenCalledOnce()
    expect(clearPendingSessionEnds).toHaveBeenCalledOnce()
    expect(coordinator.getHealthSnapshot()).toMatchObject({
      retired: true,
      serviceState: 'retired',
      available: false
    })
  })

  it('queues the session end before reporting and removes it after success', async () => {
    const fetchMock = vi.fn(async (url, options) => ({
      ok: true,
      json: async () =>
        String(url).endsWith('/session/end')
          ? { ok: true, status: 'updated' }
          : String(url).endsWith('/session/start')
            ? { session_id: JSON.parse(options?.body || '{}').session_id }
            : {
                status: 'ok',
                api_version: 2,
                service_state: 'active',
                notice_service: false,
                report_service: true
              }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const queueSessionEnd = vi.fn()
    const markSessionEndAttempt = vi.fn()
    const removePendingSessionEnd = vi.fn()
    const coordinator = createCoordinator(
      { receiveNotices: false, uploadDeviceInfo: true },
      { queueSessionEnd, markSessionEndAttempt, removePendingSessionEnd }
    )

    await coordinator.start()
    await coordinator.stop()

    const sessionId = queueSessionEnd.mock.calls[0][0]
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(queueSessionEnd).toHaveBeenCalledWith(sessionId, expect.any(String))
    expect(markSessionEndAttempt).toHaveBeenCalledWith(sessionId)
    expect(removePendingSessionEnd).toHaveBeenCalledWith(sessionId)
  })
})
