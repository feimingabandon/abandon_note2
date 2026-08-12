import { join } from 'path'
import { WeatherService } from '../services/weather-service.js'
import { weatherLocationKey, WEATHER_SOURCE } from '../../shared/weather-rules.js'

export function registerWeatherIpcHandlers({
  ipcMain,
  shell,
  userDataPath,
  getMainWindow,
  getWeatherSettings,
  weatherService = null
}) {
  const service =
    weatherService || new WeatherService({ cachePath: join(userDataPath, 'cache', 'weather.json') })
  const forecastRequests = new Map()
  const assertAuthorized = (event) => {
    if (event.sender !== getMainWindow()?.webContents) throw new Error('无权访问天气服务')
  }

  const isCurrentLocation = (key) => {
    const settings = getWeatherSettings()
    return Boolean(
      settings?.enabled && settings.location && weatherLocationKey(settings.location) === key
    )
  }

  const sendForecastIfCurrent = (forecast, key) => {
    if (!forecast || !isCurrentLocation(key)) return false
    const window = getMainWindow()
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('weather:forecast-updated', forecast)
    }
    return true
  }

  ipcMain.handle('weather:resolve-location', (event, { location } = {}) => {
    assertAuthorized(event)
    return service.resolveLocation(location)
  })
  ipcMain.handle('weather:get-division-tree', (event) => {
    assertAuthorized(event)
    return service.getChinaDivisionTree()
  })
  const refreshForecastFor = (settings, { refresh = false } = {}) => {
    if (!settings?.enabled || !settings.location) return Promise.resolve(null)
    const location = settings.location
    const key = weatherLocationKey(location)
    if (!key) return Promise.resolve(null)
    if (forecastRequests.has(key)) return forecastRequests.get(key)

    const request = service
      .getForecast(location, {
        refresh,
        shouldStore: () => isCurrentLocation(key)
      })
      .then((forecast) => {
        if (!sendForecastIfCurrent(forecast, key)) return null
        return forecast
      })
      .finally(() => {
        if (forecastRequests.get(key) === request) forecastRequests.delete(key)
      })
    forecastRequests.set(key, request)
    return request
  }

  const refreshForecast = ({ refresh = false } = {}) =>
    refreshForecastFor(getWeatherSettings(), { refresh })

  const refreshAtStartup = () => refreshForecast({ refresh: true })

  ipcMain.handle('weather:get-forecast', async (event) => {
    assertAuthorized(event)
    const settings = getWeatherSettings()
    if (!settings?.enabled || !settings.location) return null
    const key = weatherLocationKey(settings.location)
    const cached = await service.getForecast(settings.location, { cacheOnly: true })
    if (!isCurrentLocation(key)) return null
    if (cached) return cached
    // 首次启用天气或切换到从未缓存过的地区时，立即拉取该地区，而不是永久返回空缓存。
    return refreshForecastFor(settings, { refresh: true })
  })
  ipcMain.handle('weather:refresh-forecast', async (event) => {
    assertAuthorized(event)
    const settings = getWeatherSettings()
    if (!settings?.enabled) throw new Error('请先开启天气显示')
    if (!settings.location) throw new Error('请先选择天气地区')
    const key = weatherLocationKey(settings.location)
    const pendingForecast = forecastRequests.get(key)
    if (pendingForecast) await pendingForecast
    if (!isCurrentLocation(key)) throw new Error('天气地区已变化，请重试')
    const forecast = await service.refreshForecastManually(settings.location, {
      shouldStore: () => isCurrentLocation(key)
    })
    if (!sendForecastIfCurrent(forecast, key)) throw new Error('天气地区已变化，请重试')
    return forecast
  })
  ipcMain.handle('weather:open-source', async (event) => {
    assertAuthorized(event)
    await shell.openExternal(WEATHER_SOURCE.url)
    return true
  })

  return { refreshAtStartup, refreshDaily: () => refreshForecast({ refresh: true }) }
}
