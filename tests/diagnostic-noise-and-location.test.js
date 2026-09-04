import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const APP_PATH = new URL('../src/renderer/src/App.vue', import.meta.url)
const NOTE_LIST_PATH = new URL('../src/renderer/src/components/list/NoteList.vue', import.meta.url)
const WEATHER_SETTINGS_PATH = new URL(
  '../src/renderer/src/components/weather/WeatherSettings.vue',
  import.meta.url
)
const MAIN_PATH = new URL('../src/main/index.js', import.meta.url)
const BUSINESS_IPC_PATH = new URL('../src/main/ipc/register-business-ipc.js', import.meta.url)
const WEATHER_SERVICE_PATH = new URL('../src/main/services/weather-service.js', import.meta.url)
const SCREENSHOT_SERVICE_PATH = new URL('../src/main/services/ScreenshotService.js', import.meta.url)
const ATTACHMENT_DB_PATH = new URL('../src/main/db/db.js', import.meta.url)
const WALLPAPER_DB_PATH = new URL('../src/main/db/db-wallpapers.js', import.meta.url)

describe('diagnostic noise governance', () => {
  it('keeps NoteList single-rooted and removes its unsupported create listener', () => {
    const app = readFileSync(APP_PATH, 'utf8')
    const noteList = readFileSync(NOTE_LIST_PATH, 'utf8')
    const appNoteList = app.slice(
      app.indexOf('<NoteList'),
      app.indexOf('/>', app.indexOf('<NoteList'))
    )
    const template = noteList.slice(
      noteList.indexOf('<template>'),
      noteList.lastIndexOf('</template>')
    )

    expect(appNoteList).not.toContain('@create=')
    expect(template.indexOf('<ConfirmDialog')).toBeGreaterThan(
      template.indexOf('<div class="note-list">')
    )
    expect(template.lastIndexOf('</div>')).toBeGreaterThan(template.indexOf('<ConfirmDialog'))
  })
})

describe('device location diagnostics', () => {
  it('records device accuracy, failure reason, resolved place and native permission decisions', () => {
    const weatherSettings = readFileSync(WEATHER_SETTINGS_PATH, 'utf8')
    const main = readFileSync(MAIN_PATH, 'utf8')
    const permissionBlock = main.slice(
      main.indexOf('mainSession.setPermissionRequestHandler'),
      main.indexOf('setWindowLogContext(mainWindow')
    )

    expect(weatherSettings).toContain("reportWeatherLocation('info', '用户请求设备位置'")
    expect(weatherSettings).toContain('maximumAgeMs: 3_600_000')
    expect(weatherSettings).toContain('accuracyMeters:')
    expect(weatherSettings).toContain('reason: String(locationError?.message || failureMessage)')
    expect(weatherSettings).toContain("reportWeatherLocation('info', '设备位置已解析并保存'")
    expect(permissionBlock).toContain("permission === 'geolocation-approximate'")
    expect(permissionBlock).toContain("logger.info(\n        'weather.location-permission'")
    expect(permissionBlock).not.toContain('GOOGLE_API_KEY')
  })
})

describe('high-value diagnostic coverage', () => {
  it('records lifecycle, destructive operations, notification breadcrumbs and scheduler changes', () => {
    const main = readFileSync(MAIN_PATH, 'utf8')
    const businessIpc = readFileSync(BUSINESS_IPC_PATH, 'utf8')

    for (const scope of [
      'lifecycle.shutdown-start',
      'lifecycle.shutdown-wait',
      'lifecycle.shutdown-complete',
      'notification.protocol',
      'notification.reveal-request',
      'notification.reveal',
      'scheduler.activation',
      'scheduler.template-generation',
      'settings.reset',
      'data.clear',
      'shortcut.view-visibility-trigger'
    ]) {
      expect(main).toContain(scope)
    }
    for (const scope of ['note.purge', 'template.purge', 'notes.historical-move']) {
      expect(businessIpc).toContain(scope)
    }
  })

  it('records weather degradation, storage recovery and screenshot renderer errors', () => {
    const weather = readFileSync(WEATHER_SERVICE_PATH, 'utf8')
    const screenshot = readFileSync(SCREENSHOT_SERVICE_PATH, 'utf8')
    const attachments = readFileSync(ATTACHMENT_DB_PATH, 'utf8')
    const wallpapers = readFileSync(WALLPAPER_DB_PATH, 'utf8')

    expect(weather).toContain('weather.provider-fallback')
    expect(weather).toContain('weather.stale-cache')
    expect(weather).toContain('weather.network-refresh')
    expect(screenshot).toContain("scope:'screenshot.renderer'")
    expect(screenshot).toContain("window.addEventListener('unhandledrejection'")
    expect(attachments).toContain('onRecovery({')
    expect(wallpapers).toContain('onRecovery({')
  })
})
