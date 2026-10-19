import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifySystem, collectDeviceInfo } from '../src/main/services/remote/device-info.js'

afterEach(() => vi.restoreAllMocks())

describe('Windows remote device classification', () => {
  it('uses the Windows 11 build boundary without changing Windows 10 classification', () => {
    expect(classifySystem('win32', '10.0.19045')).toBe('win10')
    expect(classifySystem('win32', '10.0.21999')).toBe('win10')
    expect(classifySystem('win32', '10.0.22000')).toBe('win11')
    expect(classifySystem('win32', '10.0.26100')).toBe('win11')
  })

  it('rejects unsupported hosts instead of labeling them as supported devices', () => {
    for (const platform of ['darwin', 'linux']) {
      expect(() => classifySystem(platform, '10.0.26100')).toThrow(
        `不支持的远程服务平台: ${platform}`
      )
    }
  })

  it('retains the Windows device payload if GPU collection is unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const app = {
      getGPUInfo: vi.fn(async () => {
        throw new Error('GPU information unavailable')
      }),
      getVersion: () => '1.3.0',
      getLocale: () => 'zh-CN'
    }
    const payload = await collectDeviceInfo(app, 'existing-installation-id')
    expect(payload).toMatchObject({
      installation_id: 'existing-installation-id',
      app_version: '1.3.0',
      locale: 'zh-CN',
      system_group: classifySystem(),
      gpu_model: null
    })
    expect(payload.system_build).toBeTruthy()
    expect(payload.memory_total).toBeGreaterThan(0)
  })
})
