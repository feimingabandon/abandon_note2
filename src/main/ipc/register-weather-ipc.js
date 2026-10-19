import { join } from 'path'
import { WeatherService } from '../services/weather-service.js'
import { createWeatherRefreshController } from '../services/weather-refresh-controller.js'
import { WEATHER_SOURCE } from '../../shared/weather-rules.js'
import { assertMainWindowSender } from './ipc-authorization.js'

export function registerWeatherIpcHandlers({
  ipcMain,
  shell,
  userDataPath,
  appVersion,
  getMainWindow,
  getWeatherSettings,
  canAutoRefresh = () => true,
  now = Date.now,
  random = Math.random,
  logger = null,
  weatherService = null
}) {
  const service =
    weatherService ||
    new WeatherService({
      cachePath: join(userDataPath, 'cache', 'weather.json'),
      userAgent: `Abandon-Note/${appVersion}`,
      diagnosticLog: (level, scope, message, metadata) =>
        logger?.[level]?.(scope, message, metadata)
    })
  const registered = []
  const handle = (channel, handler) => {
    ipcMain.handle(channel, handler)
    registered.push(channel)
  }
  const assertAuthorized = (event) => assertMainWindowSender(event, getMainWindow, '天气服务')
  const controller = createWeatherRefreshController({
    service,
    getSettings: getWeatherSettings,
    canAutoRefresh,
    now,
    random,
    publish(forecast) {
      const window = getMainWindow()
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('weather:forecast-updated', forecast)
      }
    }
  })
  const dispose = () => {
    controller.dispose()
    for (const channel of registered.splice(0)) ipcMain.removeHandler(channel)
  }
  try {
    handle('weather:resolve-location', (event, { location } = {}) => {
      assertAuthorized(event)
      return service.resolveLocation(location)
    })
    handle('weather:get-division-tree', (event) => {
      assertAuthorized(event)
      return service.getChinaDivisionTree()
    })
    handle('weather:get-forecast', (event) => {
      assertAuthorized(event)
      return controller.read()
    })
    handle('weather:refresh-forecast', (event) => {
      assertAuthorized(event)
      const settings = getWeatherSettings()
      if (!settings?.enabled) throw new Error('请先开启天气显示')
      if (!settings.location) throw new Error('请先选择天气地区')
      return controller.refresh({ manual: true, trigger: 'manual' })
    })
    handle('weather:open-source', async (event) => {
      assertAuthorized(event)
      await shell.openExternal(WEATHER_SOURCE.url)
      return true
    })
    return {
      refreshAtStartup: () => controller.refresh({ trigger: 'startup' }),
      refreshIfDue: () => controller.refresh({ trigger: 'automatic' }),
      settingsChanged: controller.settingsChanged,
      dispose
    }
  } catch (error) {
    dispose()
    throw error
  }
}
