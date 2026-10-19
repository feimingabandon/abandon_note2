import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectSystemDiagnostics } from '../src/main/logging/system-diagnostics.js'

const fixture = () => ({
  app: {
    getVersion: () => '1.2.0',
    isPackaged: true,
    getGPUInfo: vi.fn(async () => ({
      gpuDevice: [
        { active: true, deviceString: 'GPU test', driverVersion: '123', serialNumber: 'exclude-me' }
      ],
      auxAttributes: { glRenderer: 'ANGLE test', sandboxed: false, inProcessGpu: true }
    })),
    getGPUFeatureStatus: vi.fn(() => ({ gpu_compositing: 'enabled' })),
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
  it('includes read-only ACL findings without turning a missing grant into a startup verdict', async () => {
    const permissions = {
      status: 'inspected',
      verification: 'required-allow-and-known-deny-rules',
      checkedFiles: [{ path: 'icudtl.dat', hasRequiredAllow: false, error: null }]
    }
    const snapshot = await collectSystemDiagnostics(fixture(), {
      readWindowsVersion: async () => null,
      readSandboxPermissions: async () => permissions
    })
    expect(snapshot.sandboxPermissions).toEqual(permissions)
    expect(snapshot.collectionErrors).toEqual([])
  })

  it('keeps exporting when installation ACL inspection fails', async () => {
    const snapshot = await collectSystemDiagnostics(fixture(), {
      readWindowsVersion: async () => null,
      readSandboxPermissions: async () => {
        throw new Error('ACL access denied')
      }
    })
    expect(snapshot.sandboxPermissions).toBeNull()
    expect(snapshot.graphics.featureStatus.gpu_compositing).toBe('enabled')
    expect(snapshot.collectionErrors).toContainEqual({
      field: 'sandboxPermissions',
      message: 'ACL access denied'
    })
  })

  it('captures fresh display/GPU details and omits hardware identifiers', async () => {
    const providers = fixture()
    const first = await collectSystemDiagnostics(providers, {
      readWindowsVersion: async () => ({ CurrentBuildNumber: '19045', UBR: 1 })
    })
    expect(first.displays).toEqual([
      { id: 7, scaleFactor: 1.25, scalePercent: 125, displayFrequency: 60, primary: true }
    ])
    expect(first.graphics.devices[0]).toEqual({
      deviceString: 'GPU test',
      driverVersion: '123'
    })
    expect(providers.app.getGPUInfo).toHaveBeenCalledExactlyOnceWith('basic')
    expect(first.graphics).toMatchObject({
      collectionLevel: 'basic',
      adapterSelection: 'not-collected',
      auxiliary: null,
      auxiliaryStatus: 'not-collected',
      featureStatus: { gpu_compositing: 'enabled' }
    })
    expect(providers.app.getGPUFeatureStatus).toHaveBeenCalledTimes(1)
    expect(first.application.mainBundleSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(first.collectionErrors).toEqual([])
    providers.screen.getAllDisplays = () => [{ id: 7, scaleFactor: 1, displayFrequency: 144 }]
    providers.app.getGPUInfo.mockResolvedValue({
      gpuDevice: [{ vendorId: 0x10de, deviceId: 1, driverVersion: '124' }]
    })
    const second = await collectSystemDiagnostics(providers, {
      readWindowsVersion: async () => null
    })
    expect(second.displays[0]).toMatchObject({ scalePercent: 100, displayFrequency: 144 })
    expect(second.graphics.devices[0].driverVersion).toBe('124')
    expect(providers.app.getGPUInfo.mock.calls).toEqual([['basic'], ['basic']])
  })
  it('does not report a default basic adapter or its flags as observed rendering state', async () => {
    const providers = fixture()
    providers.app.getGPUInfo.mockResolvedValue({
      gpuDevice: [{ vendorId: 0, deviceId: 0, active: false, deviceString: '', driverVersion: '' }],
      auxAttributes: { glRenderer: '', sandboxed: false, inProcessGpu: true }
    })
    const snapshot = await collectSystemDiagnostics(providers, {
      readWindowsVersion: async () => null,
      readSandboxPermissions: async () => null
    })
    expect(snapshot.graphics.devices).toEqual([])
    expect(snapshot.graphics.auxiliary).toBeNull()
    expect(snapshot.graphics.adapterSelection).toBe('not-collected')
    expect(snapshot.graphics.featureStatus).toEqual({ gpu_compositing: 'enabled' })
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
