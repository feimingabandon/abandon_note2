import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { registerWeatherIpcHandlers } from '../src/main/ipc/register-weather-ipc.js'

const MONTH_WORKSPACE_PATH = new URL(
  '../src/renderer/src/components/month/MonthWorkspace.vue',
  import.meta.url
)

const beijing = {
  name: '北京市',
  latitude: 39.9042,
  longitude: 116.4074,
  timezone: 'Asia/Shanghai',
  countryCode: 'CN'
}
const shanghai = {
  name: '上海市',
  latitude: 31.2304,
  longitude: 121.4737,
  timezone: 'Asia/Shanghai',
  countryCode: 'CN'
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createHarness(weatherService, initialSettings) {
  const handlers = new Map()
  const webContents = {
    isDestroyed: () => false,
    send: vi.fn()
  }
  const mainWindow = {
    isDestroyed: () => false,
    webContents
  }
  let settings = initialSettings
  const lifecycle = registerWeatherIpcHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    shell: { openExternal: vi.fn() },
    userDataPath: 'unused-in-test',
    getMainWindow: () => mainWindow,
    getWeatherSettings: () => settings,
    weatherService
  })
  return {
    handlers,
    lifecycle,
    webContents,
    event: { sender: webContents },
    setSettings: (nextSettings) => {
      settings = nextSettings
    }
  }
}

describe('天气 IPC 请求协调', () => {
  it('当前地区没有缓存时会主动拉取天气', async () => {
    const forecast = { location: beijing, days: [] }
    const weatherService = {
      getForecast: vi.fn(async (_location, options) => (options.cacheOnly ? null : forecast)),
      resolveLocation: vi.fn(),
      getChinaDivisionTree: vi.fn(),
      refreshForecastManually: vi.fn()
    }
    const harness = createHarness(weatherService, { enabled: true, location: beijing })

    await expect(harness.handlers.get('weather:get-forecast')(harness.event)).resolves.toBe(
      forecast
    )
    expect(weatherService.getForecast).toHaveBeenNthCalledWith(1, beijing, { cacheOnly: true })
    expect(weatherService.getForecast.mock.calls[1][1]).toMatchObject({ refresh: true })
    expect(harness.webContents.send).toHaveBeenCalledWith('weather:forecast-updated', forecast)
  })

  it('切换地区后丢弃旧请求，只缓存并发布当前地区结果', async () => {
    const pendingByName = new Map([
      [beijing.name, deferred()],
      [shanghai.name, deferred()]
    ])
    const storeDecisions = []
    const weatherService = {
      getForecast: vi.fn(async (location, options) => {
        if (options.cacheOnly) return null
        const forecast = await pendingByName.get(location.name).promise
        storeDecisions.push({ name: location.name, allowed: options.shouldStore() })
        return forecast
      }),
      resolveLocation: vi.fn(),
      getChinaDivisionTree: vi.fn(),
      refreshForecastManually: vi.fn()
    }
    const harness = createHarness(weatherService, { enabled: true, location: beijing })

    const oldRequest = harness.lifecycle.refreshAtStartup()
    harness.setSettings({ enabled: true, location: shanghai })
    const currentRequest = harness.handlers.get('weather:get-forecast')(harness.event)

    const oldForecast = { location: beijing, days: [] }
    pendingByName.get(beijing.name).resolve(oldForecast)
    await expect(oldRequest).resolves.toBeNull()
    expect(harness.webContents.send).not.toHaveBeenCalled()

    const currentForecast = { location: shanghai, days: [] }
    pendingByName.get(shanghai.name).resolve(currentForecast)
    await expect(currentRequest).resolves.toBe(currentForecast)
    expect(storeDecisions).toEqual([
      { name: beijing.name, allowed: false },
      { name: shanghai.name, allowed: true }
    ])
    expect(harness.webContents.send).toHaveBeenCalledTimes(1)
    expect(harness.webContents.send).toHaveBeenCalledWith(
      'weather:forecast-updated',
      currentForecast
    )
  })
})

describe('月视图天气加载', () => {
  it('本地月份数据就绪后立即显示，天气在后台加载', () => {
    const workspace = readFileSync(MONTH_WORKSPACE_PATH, 'utf8')
    const mountBlock = workspace.slice(workspace.indexOf('onMounted(async () => {'))

    expect(mountBlock).toContain('const monthLoadPromise = loadMonth()')
    expect(mountBlock).toContain('if (weatherEnabled.value) void loadWeather({ quiet: true })')
    expect(mountBlock.indexOf('await monthLoadPromise')).toBeLessThan(
      mountBlock.indexOf("emit('ready')")
    )
    expect(mountBlock).not.toContain('Promise.all([loadMonth(), loadWeather')
  })
})
