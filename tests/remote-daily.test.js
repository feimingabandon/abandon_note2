import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteCoordinator } from '../src/main/services/remote/remote-coordinator.js'
import { chinaDate, nextChinaDayDelay } from '../src/main/services/remote/daily-clock.js'

function fixture(saved = {}) {
  let now = Date.parse('2026-10-10T16:05:00Z')
  const settings = { remote: { uploadDeviceInfo: true, receiveNotices: false } }
  let state = { ...saved }
  const coordinator = new RemoteCoordinator({
    app: { getVersion: () => '1.4.0', getLocale: () => 'zh-CN', getGPUInfo: async () => ({}) },
    baseUrl: 'https://example.test',
    getSettings: () => settings,
    getInstallationId: () => '123e4567-e89b-42d3-a456-426614174000',
    getDailyState: () => state,
    saveDailyState: (value) => (state = value),
    getNoticeSyncState: () => ({ streamId: 'stream', cursor: 5 }),
    applyNoticeEvents: vi.fn(() => ({ changed: 0 })),
    now: () => now,
    random: () => 0,
    queueSessionEnd: vi.fn(),
    listPendingSessionEnds: () => [],
    removePendingSessionEnd: vi.fn()
  })
  coordinator.client.health = vi.fn(async () => ({
    status: 'ok',
    api_version: 2,
    service_state: 'active',
    report_service: true,
    notice_service: true,
    stats_protocol: 3,
    stats_epoch: 'epoch',
    notice_stream_id: 'stream',
    notice_sequence: 5
  }))
  coordinator.client.reportDaily = vi.fn(async () => ({ ok: true }))
  coordinator.client.startSession = vi.fn(async (p) => ({ session_id: p.session_id }))
  coordinator.client.endSession = vi.fn(async () => ({ ok: true }))
  coordinator.client.pullNotices = vi.fn(async () => ({
    stream_id: 'stream',
    next_cursor: 6,
    events: []
  }))
  return { coordinator, settings, state: () => state, advanceDay: () => (now += 86400000) }
}

afterEach(() => vi.useRealTimers())

describe('one report per China date without a heartbeat', () => {
  it('uses China dates and schedules only the next calendar day', () => {
    expect(chinaDate(Date.parse('2026-10-10T16:00:00Z'))).toBe('2026-10-11')
    expect(nextChinaDayDelay(Date.parse('2026-10-10T15:59:00Z'), () => 0)).toBe(90000)
  })

  it('deduplicates daily requests, including a restart, and reports the next day', async () => {
    const f = fixture()
    await f.coordinator.runDaily()
    await f.coordinator.runDaily()
    const restarted = fixture(f.state())
    await restarted.coordinator.runDaily()
    expect(f.coordinator.client.reportDaily).toHaveBeenCalledOnce()
    expect(restarted.coordinator.client.health).not.toHaveBeenCalled()
    f.advanceDay()
    await f.coordinator.runDaily()
    expect(f.coordinator.client.reportDaily).toHaveBeenCalledTimes(2)
  })

  it('does not check or upload when both permissions are off', async () => {
    const f = fixture()
    f.settings.remote.uploadDeviceInfo = false
    await f.coordinator.runDaily()
    expect(f.coordinator.client.health).not.toHaveBeenCalled()
    expect(f.coordinator.client.reportDaily).not.toHaveBeenCalled()
  })

  it('rechecks the upload permission after health finishes', async () => {
    const f = fixture()
    const response = f.coordinator.client.health.getMockImplementation()
    f.coordinator.client.health.mockImplementation(async () => {
      f.settings.remote.uploadDeviceInfo = false
      return response()
    })
    await f.coordinator.runDaily()
    expect(f.coordinator.client.reportDaily).not.toHaveBeenCalled()
  })

  it.each(['maintenance', 'retired'])(
    'does not upload when the server is %s',
    async (serviceState) => {
      const f = fixture()
      f.coordinator.client.health.mockResolvedValue({
        status: 'ok',
        api_version: 2,
        service_state: serviceState
      })
      await f.coordinator.runDaily()
      await f.coordinator.runDaily()
      expect(f.coordinator.client.reportDaily).not.toHaveBeenCalled()
      expect(f.coordinator.client.health).toHaveBeenCalledOnce()
    }
  )

  it('honors the independent server report switch', async () => {
    const f = fixture()
    f.coordinator.client.health.mockResolvedValue({
      status: 'ok',
      api_version: 2,
      service_state: 'active',
      report_service: false
    })
    await f.coordinator.runDaily()
    expect(f.coordinator.client.reportDaily).not.toHaveBeenCalled()
  })

  it('does not retry a network failure on the same day', async () => {
    const f = fixture()
    f.coordinator.client.health.mockRejectedValue(new Error('offline'))
    await f.coordinator.runDaily()
    await f.coordinator.runDaily()
    expect(f.coordinator.client.health).toHaveBeenCalledOnce()
  })

  it('still synchronizes changed notices when the daily upload fails', async () => {
    const f = fixture()
    f.settings.remote.receiveNotices = true
    const response = f.coordinator.client.health.getMockImplementation()
    f.coordinator.client.health.mockImplementation(async () => ({
      ...(await response()),
      notice_sequence: 6
    }))
    f.coordinator.client.reportDaily.mockRejectedValue(new Error('report unavailable'))
    await f.coordinator.runDaily()
    await f.coordinator.runDaily()
    expect(f.coordinator.client.reportDaily).toHaveBeenCalledOnce()
    expect(f.coordinator.client.pullNotices).toHaveBeenCalledOnce()
  })

  it('ignores a daily upload that completes after shutdown', async () => {
    const f = fixture()
    let finish
    f.coordinator.client.reportDaily.mockImplementation(
      () => new Promise((resolve) => (finish = resolve))
    )
    const task = f.coordinator.runDaily()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await f.coordinator.stop()
    finish({ ok: true })
    await task
    expect(f.state().successDay).toBeUndefined()
    expect(f.coordinator.client.pullNotices).not.toHaveBeenCalled()
  })

  it('counts a successful start without an extra daily upload', async () => {
    const f = fixture()
    await f.coordinator.start()
    await f.coordinator.runDaily()
    expect(f.coordinator.client.reportDaily).not.toHaveBeenCalled()
    expect(f.coordinator.client.startSession.mock.calls[0][0]).toMatchObject({
      stats_protocol: 3,
      stats_epoch: 'epoch'
    })
    await f.coordinator.stop()
  })

  it('allows notices when upload is disabled and only pulls when changed', async () => {
    const f = fixture()
    f.settings.remote = { uploadDeviceInfo: false, receiveNotices: true }
    await f.coordinator.runDaily()
    expect(f.coordinator.client.reportDaily).not.toHaveBeenCalled()
    expect(f.coordinator.client.pullNotices).not.toHaveBeenCalled()
    f.advanceDay()
    f.coordinator.client.health.mockResolvedValue({
      status: 'ok',
      api_version: 2,
      service_state: 'active',
      notice_service: true,
      notice_stream_id: 'stream',
      notice_sequence: 6
    })
    await f.coordinator.runDaily()
    expect(f.coordinator.client.pullNotices).toHaveBeenCalledOnce()
  })

  it('does not upload on exit after the user disables upload', async () => {
    const f = fixture()
    await f.coordinator.start()
    f.settings.remote.uploadDeviceInfo = false
    await f.coordinator.stop()
    expect(f.coordinator.client.endSession).not.toHaveBeenCalled()
  })

  it('cancels the scheduled task when both settings are disabled', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.coordinator.start()
    f.settings.remote.uploadDeviceInfo = false
    f.coordinator.settingsChanged()
    await vi.advanceTimersByTimeAsync(2 * 86400000)
    expect(f.coordinator.client.reportDaily).not.toHaveBeenCalled()
    expect(f.coordinator.client.health).toHaveBeenCalledOnce()
    await f.coordinator.stop()
  })
})
