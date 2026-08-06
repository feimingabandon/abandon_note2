import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteCoordinator } from '../src/main/services/remote/remote-coordinator.js'

function createCoordinator(remote, overrides = {}) {
  return new RemoteCoordinator({
    app: { getVersion: () => '0.9.2' },
    baseUrl: 'https://example.test',
    getSettings: () => ({ remote }),
    getInstallationId: () => 'installation-id',
    getCursor: () => 0,
    ingestNotices: () => 0,
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
            api_version: 1,
            notice_service: true,
            report_service: false
          })
        }
      }
      return {
        ok: true,
        json: async () => ({ next_cursor: 0, notices: [] })
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
                api_version: 1,
                notice_service: true,
                report_service: false
              })
            })
        })
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ next_cursor: 0, notices: [] })
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
})
