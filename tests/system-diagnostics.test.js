import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectSystemDiagnostics } from '../src/main/logging/system-diagnostics.js'

const fixture = () => ({
  app: {
    getVersion: () => '1.2.0',
    isPackaged: true,
    getGPUInfo: async () => ({
      gpuDevice: [
        { active: true, deviceString: 'GPU test', driverVersion: '123', serialNumber: 'exclude-me' }
      ],
      auxAttributes: { glRenderer: 'ANGLE test' }
    }),
    getGPUFeatureStatus: () => ({ gpu_compositing: 'enabled' }),
    getAppMetrics: () => []
  },
  screen: {
    getPrimaryDisplay: () => ({ id: 7 }),
    getAllDisplays: () => [{ id: 7, scaleFactor: 1.25, displayFrequency: 60 }],
    getDisplayMatching: () => ({
      id: 7,
      scaleFactor: 1.25,
      bounds: { x: 0, y: 0, width: 1536, height: 864 },
      workArea: { x: 0, y: 0, width: 1536, height: 824 }
    })
  },
  windows: [],
  runtime: { activeViewMode: 'month' }
})
afterEach(() => vi.useRealTimers())
describe('export system diagnostics', () => {
  it('captures fresh display/GPU details and omits hardware identifiers', async () => {
    const providers = fixture()
    const first = await collectSystemDiagnostics(providers, {
      readWindowsVersion: async () => ({ CurrentBuildNumber: '19045', UBR: 1 })
    })
    expect(first.displays).toEqual([
      { id: 7, scaleFactor: 1.25, scalePercent: 125, displayFrequency: 60, primary: true }
    ])
    expect(first.graphics.devices[0]).toEqual({
      active: true,
      deviceString: 'GPU test',
      driverVersion: '123'
    })
    expect(first.application.mainBundleSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(first.collectionErrors).toEqual([])
    providers.screen.getAllDisplays = () => [{ id: 7, scaleFactor: 1, displayFrequency: 144 }]
    const second = await collectSystemDiagnostics(providers, {
      readWindowsVersion: async () => null
    })
    expect(second.displays[0]).toMatchObject({ scalePercent: 100, displayFrequency: 144 })
  })
  it('keeps the snapshot exportable when GPU collection hangs and Windows details fail', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const providers = fixture()
    providers.app.getGPUInfo = () => new Promise(() => {})
    const result = collectSystemDiagnostics(providers, {
      readWindowsVersion: async () => {
        throw new Error('unavailable')
      }
    })
    await vi.advanceTimersByTimeAsync(3501)
    const snapshot = await result
    expect(snapshot.graphics.devices).toBeNull()
    expect(snapshot.displays[0].scalePercent).toBe(125)
    expect(snapshot.collectionErrors).toEqual(
      expect.arrayContaining([
        { field: 'gpu', message: 'collection timed out' },
        { field: 'windowsVersion', message: 'unavailable' }
      ])
    )
  })

  it('matches every exported window to its display and records DPI scale explicitly', async () => {
    const providers = fixture()
    providers.windows = [
      {
        id: 19,
        isDestroyed: () => false,
        getBounds: () => ({ x: 10, y: 20, width: 320, height: 480 }),
        getContentBounds: () => ({ x: 10, y: 20, width: 320, height: 480 }),
        isVisible: () => true,
        isMinimized: () => false,
        isMaximized: () => false,
        isFocused: () => true,
        isAlwaysOnTop: () => false,
        getOpacity: () => 0.92,
        webContents: {
          getZoomFactor: () => 1,
          getOSProcessId: () => 1234
        }
      }
    ]

    const snapshot = await collectSystemDiagnostics(providers, {
      readWindowsVersion: async () => null
    })
    expect(snapshot.windows[0]).toMatchObject({
      id: 19,
      displayId: 7,
      displayScaleFactor: 1.25,
      displayScalePercent: 125,
      displayBounds: { width: 1536, height: 864 },
      displayWorkArea: { width: 1536, height: 824 },
      zoomFactor: 1
    })
  })
})
