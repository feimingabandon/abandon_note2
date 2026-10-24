import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteCoordinator } from '../src/main/services/remote/remote-coordinator.js'

function deferred() {
  let resolve
  const promise = new Promise((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

const activeHealth = {
  status: 'ok',
  api_version: 2,
  service_state: 'active',
  notice_service: true,
  report_service: true
}

function fixture() {
  let closed = false
  const touchedAfterClose = []
  const database = (name, result) =>
    vi.fn((...args) => {
      if (closed) touchedAfterClose.push({ name, args })
      return result
    })
  const ports = {
    getSettings: database('getSettings', {
      remote: { receiveNotices: true, uploadDeviceInfo: true }
    }),
    getInstallationId: database('getInstallationId', 'installation-id'),
    getNoticeSyncState: database('getNoticeSyncState', { streamId: null, cursor: 0 }),
    applyNoticeEvents: database('applyNoticeEvents', { changed: 1 }),
    isServiceRetired: database('isServiceRetired', false),
    markServiceRetired: database('markServiceRetired'),
    queueSessionEnd: database('queueSessionEnd'),
    listPendingSessionEnds: database('listPendingSessionEnds', []),
    markSessionEndAttempt: database('markSessionEndAttempt'),
    removePendingSessionEnd: database('removePendingSessionEnd'),
    clearPendingSessionEnds: database('clearPendingSessionEnds'),
    onNoticesChanged: vi.fn(),
    onHealthChanged: vi.fn()
  }
  const app = {
    getVersion: () => '0.9.2',
    getLocale: () => 'zh-CN',
    getGPUInfo: vi.fn(async () => ({ gpuDevice: [] }))
  }
  const coordinator = new RemoteCoordinator({ app, baseUrl: 'https://example.test', ...ports })
  coordinator.client.health = vi.fn(async () => activeHealth)
  coordinator.client.startSession = vi.fn(async (payload) => ({ session_id: payload.session_id }))
  coordinator.client.endSession = vi.fn(async () => ({ ok: true }))
  coordinator.client.pullNotices = vi.fn(async () => ({
    stream_id: 'stream',
    next_cursor: 0,
    events: []
  }))
  return { coordinator, app, ports, touchedAfterClose, close: () => (closed = true) }
}

afterEach(() => vi.useRealTimers())

describe('remote shutdown lifetime', () => {
  it('checkpoints once before earlier shutdown waits without starting session-end HTTP', async () => {
    const state = fixture()
    await state.coordinator.start()
    const sessionId = state.coordinator.sessionId
    expect(sessionId).toBeTruthy()

    const prepared = state.coordinator.prepareStop()
    expect(prepared).toMatchObject({ sessionId, queued: true, maySend: true })
    expect(state.coordinator.prepareStop()).toBe(prepared)
    expect(state.ports.queueSessionEnd).toHaveBeenCalledExactlyOnceWith(sessionId, prepared.endedAt)
    expect(state.coordinator.client.endSession).not.toHaveBeenCalled()
    expect(state.coordinator.hasActiveSession()).toBe(false)

    expect(await state.coordinator.stop()).toBe('completed')
    expect(state.ports.queueSessionEnd).toHaveBeenCalledTimes(1)
    expect(state.coordinator.client.endSession).toHaveBeenCalledExactlyOnceWith(
      sessionId,
      prepared.endedAt
    )
    expect(state.ports.removePendingSessionEnd).toHaveBeenCalledExactlyOnceWith(sessionId)
  })

  it('retains the session identity when the admission checkpoint cannot be written', async () => {
    const state = fixture()
    await state.coordinator.start()
    const sessionId = state.coordinator.sessionId
    state.ports.queueSessionEnd.mockImplementation(() => {
      throw new Error('outbox disk failure')
    })
    expect(() => state.coordinator.prepareStop()).toThrow('outbox disk failure')
    expect(state.coordinator.sessionId).toBe(sessionId)
    expect(state.coordinator.stopPreparation).toBe(null)
    expect(state.coordinator.client.endSession).not.toHaveBeenCalled()
  })

  it('stops an in-flight health check before starting sessions or touching closed storage', async () => {
    const state = fixture()
    const health = deferred()
    state.coordinator.client.health.mockReturnValue(health.promise)
    const starting = state.coordinator.start()
    await state.coordinator.stop()
    state.close()
    const broadcasts = state.ports.onHealthChanged.mock.calls.length

    health.resolve(activeHealth)
    await starting

    expect(state.touchedAfterClose).toEqual([])
    expect(state.coordinator.client.startSession).not.toHaveBeenCalled()
    expect(state.coordinator.client.pullNotices).not.toHaveBeenCalled()
    expect(state.ports.onHealthChanged).toHaveBeenCalledTimes(broadcasts)
  })

  it('does not persist a late retirement reply after storage has closed', async () => {
    const state = fixture()
    const health = deferred()
    state.coordinator.client.health.mockReturnValue(health.promise)
    const starting = state.coordinator.start()
    await state.coordinator.stop()
    state.close()
    health.resolve({ ...activeHealth, service_state: 'retired' })
    await starting

    expect(state.touchedAfterClose).toEqual([])
    expect(state.ports.markServiceRetired).not.toHaveBeenCalled()
    expect(state.ports.clearPendingSessionEnds).not.toHaveBeenCalled()
  })

  it('keeps an existing pending end when its reply arrives after stop', async () => {
    const state = fixture()
    const response = deferred()
    const entered = deferred()
    state.ports.listPendingSessionEnds.mockReturnValue([{ sessionId: 'previous', endedAt: 'time' }])
    state.coordinator.client.endSession.mockImplementation(() => {
      entered.resolve()
      return response.promise
    })
    const starting = state.coordinator.start()
    await entered.promise
    await state.coordinator.stop()
    state.close()
    response.resolve({ ok: true })
    await starting

    expect(state.touchedAfterClose).toEqual([])
    expect(state.ports.removePendingSessionEnd).not.toHaveBeenCalled()
    expect(state.coordinator.client.startSession).not.toHaveBeenCalled()
  })

  it('discards late notice pages without applying events or broadcasting', async () => {
    const state = fixture()
    const response = deferred()
    const entered = deferred()
    state.ports.getSettings.mockReturnValue({
      remote: { receiveNotices: true, uploadDeviceInfo: false }
    })
    state.coordinator.client.pullNotices.mockImplementation(() => {
      entered.resolve()
      return response.promise
    })
    const starting = state.coordinator.start()
    await entered.promise
    await state.coordinator.stop()
    state.close()
    response.resolve({ stream_id: 'stream', next_cursor: 0, events: [], has_more: true })
    await starting

    expect(state.touchedAfterClose).toEqual([])
    expect(state.ports.applyNoticeEvents).not.toHaveBeenCalled()
    expect(state.ports.onNoticesChanged).not.toHaveBeenCalled()
    expect(state.coordinator.client.pullNotices).toHaveBeenCalledOnce()
  })

  it('queues the current session before waiting, then leaves it recoverable on bounded timeout', async () => {
    vi.useFakeTimers()
    const state = fixture()
    const response = deferred()
    const entered = deferred()
    let payload
    state.coordinator.client.startSession.mockImplementation((value) => {
      payload = value
      entered.resolve()
      return response.promise
    })
    const starting = state.coordinator.start()
    await entered.promise
    const stopping = state.coordinator.stop({ timeoutMs: 1600 })
    expect(state.ports.queueSessionEnd).toHaveBeenCalledWith(payload.session_id, expect.any(String))
    expect(state.ports.markSessionEndAttempt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1600)
    expect(await stopping).toBe('timeout')
    state.close()
    response.resolve({ session_id: payload.session_id })
    await starting
    await Promise.resolve()

    expect(state.touchedAfterClose).toEqual([])
    expect(state.ports.removePendingSessionEnd).not.toHaveBeenCalled()
    expect(state.coordinator.client.endSession).not.toHaveBeenCalled()
  })

  it('does not remove the queued end when the end request returns after its timeout', async () => {
    vi.useFakeTimers()
    const state = fixture()
    await state.coordinator.start()
    const response = deferred()
    const entered = deferred()
    state.coordinator.client.endSession.mockImplementation(() => {
      entered.resolve()
      return response.promise
    })
    const stopping = state.coordinator.stop({ timeoutMs: 1600 })
    await entered.promise
    await vi.advanceTimersByTimeAsync(1600)
    expect(await stopping).toBe('timeout')
    state.close()
    response.resolve({ ok: true })
    await Promise.resolve()
    await Promise.resolve()

    expect(state.touchedAfterClose).toEqual([])
    expect(state.ports.removePendingSessionEnd).not.toHaveBeenCalled()
    expect(state.ports.queueSessionEnd).toHaveBeenCalledOnce()
  })

  it('skips a session upload if stop begins during device collection', async () => {
    const state = fixture()
    const response = deferred()
    const entered = deferred()
    state.app.getGPUInfo.mockImplementation(() => {
      entered.resolve()
      return response.promise
    })
    const starting = state.coordinator.start()
    await entered.promise
    const stopping = state.coordinator.stop()
    expect(state.ports.queueSessionEnd).toHaveBeenCalledOnce()
    response.resolve({ gpuDevice: [] })
    await starting
    await stopping

    expect(state.coordinator.client.startSession).not.toHaveBeenCalled()
    expect(state.ports.queueSessionEnd).toHaveBeenCalledOnce()
  })

  it('keeps stop terminal and idempotent, preserving the normal successful end contract', async () => {
    const state = fixture()
    await state.coordinator.start()
    const stopping = state.coordinator.stop()
    expect(state.coordinator.stop()).toBe(stopping)
    expect(await stopping).toBe('completed')
    const sessionId = state.ports.queueSessionEnd.mock.calls[0][0]
    expect(state.ports.markSessionEndAttempt).toHaveBeenCalledWith(sessionId)
    expect(state.ports.removePendingSessionEnd).toHaveBeenCalledWith(sessionId)
    state.close()
    await state.coordinator.stop()
    await state.coordinator.start()

    expect(state.touchedAfterClose).toEqual([])
    expect(state.ports.queueSessionEnd).toHaveBeenCalledOnce()
    expect(state.coordinator.client.startSession).toHaveBeenCalledOnce()
  })
})
