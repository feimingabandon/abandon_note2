import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'
import { localDateKey } from '../src/shared/calendar/calendar-date-rules.js'
import { weatherLocationKey } from '../src/shared/weather-rules.js'

const WAIT_STEP_MS = 25
const require = createRequire(import.meta.url)
const report = (message) => process.stderr.write(`[main-view-enhancements] ${message}\n`)

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

async function waitUntil(predicate, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(WAIT_STEP_MS)
  }
  throw new Error(message)
}

function seedMainView(userDataPath) {
  mkdirSync(join(userDataPath, 'cache'), { recursive: true })
  const location = {
    id: 440100,
    name: '广州市',
    admin1: '广东省',
    admin2: '广州市',
    country: '中国',
    countryCode: 'CN',
    latitude: 23.12911,
    longitude: 113.26439,
    timezone: 'Asia/Shanghai'
  }
  const now = Date.now()
  const db = new Database(join(userDataPath, 'app.db'))
  db.exec(`
    CREATE TABLE app_settings (
      window_name TEXT NOT NULL,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      remark TEXT DEFAULT '',
      created_at INTEGER,
      updated_at INTEGER,
      PRIMARY KEY (window_name, key)
    );
  `)
  const insert = db.prepare(`
    INSERT INTO app_settings
      (window_name, type, key, value, remark, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', ?, ?)
  `)
  insert.run('application', 'application', 'active_view', 'list', now, now)
  insert.run('application', 'remote', 'receive_notices', 'false', now, now)
  insert.run('application', 'remote', 'upload_device_info', 'false', now, now)
  insert.run('application', 'onboarding', 'first_use_notice_version', '1', now, now)
  insert.run('application', 'weather', 'enabled', 'true', now, now)
  insert.run('application', 'weather', 'location', JSON.stringify(location), now, now)
  insert.run('main', 'system', 'blur_enabled', 'false', now, now)
  db.close()

  const forecast = {
    location,
    fetchedAt: now,
    timezone: location.timezone,
    current: null,
    days: [
      {
        date: localDateKey(now),
        weatherCode: 0,
        dailyWeatherCode: 0,
        label: '晴',
        icon: '☀️',
        temperatureMax: 27,
        temperatureMin: 18,
        precipitationProbability: 0,
        precipitation: 0,
        windSpeedMax: 12
      }
    ],
    source: { name: 'Open-Meteo', url: 'https://open-meteo.com/' }
  }
  const cacheKey = `${weatherLocationKey(location)}|cma_grapes_global`
  writeFileSync(
    join(userDataPath, 'cache', 'weather.json'),
    JSON.stringify({ version: 2, forecasts: { [cacheKey]: forecast } }),
    'utf8'
  )
}

function getViewWindow(mode) {
  const fileName = mode === 'list' ? 'index' : mode
  return BrowserWindow.getAllWindows().find(
    (window) =>
      !window.isDestroyed() &&
      new RegExp(`/${fileName}\\.html(?:$|[?#])`).test(window.webContents.getURL())
  )
}

async function waitForView(mode) {
  const window = await waitUntil(() => getViewWindow(mode), `${mode} 主视图没有创建`)
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector('.view-switcher__trigger[data-active-view="${mode}"] .view-switcher__trigger-icon')?.dataset.iconName === 'switch-view'`
      ),
    `${mode} 主视图切换入口没有显示当前视图`
  )
  return window
}

async function chooseView(window, mode) {
  await window.webContents.executeJavaScript(
    `document.querySelector('.view-switcher__trigger').click()`
  )
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(
        `Boolean(document.querySelector('.view-switcher__menu [data-view="${mode}"]'))`
      ),
    `视图下拉菜单中没有 ${mode} 选项`
  )
  await window.webContents.executeJavaScript(
    `document.querySelector('.view-switcher__menu [data-view="${mode}"]').click()`
  )
}

async function assertTodayWeatherSummary(window) {
  const meta = await waitUntil(
    () =>
      window.webContents.executeJavaScript(`(() => {
    const element = document.querySelector('.month-toolbar__weather-meta')
    return element?.textContent.includes('☀️ 晴 18°～27°') ? {
      text: element.textContent.trim(),
      title: element.title,
      isButton: element.matches('button, [role="button"]'),
      sourceCount: element.querySelectorAll('small, i').length,
      weatherCenter: element.getBoundingClientRect().top + element.getBoundingClientRect().height / 2,
      todayCenter: (() => {
        const rect = document.querySelector('.month-toolbar__today').getBoundingClientRect()
        return rect.top + rect.height / 2
      })()
    } : null
  })()`),
    '当天天气概览没有显示'
  )
  assert.equal(meta.title, meta.text)
  assert.equal(meta.isButton, false)
  assert.equal(meta.sourceCount, 0)
  assert.ok(
    Math.abs(meta.weatherCenter - meta.todayCenter) < 0.25,
    `天气信息与今天按钮没有垂直居中：${JSON.stringify(meta)}`
  )
  assert.doesNotMatch(meta.text, /广州市|广东省/)
  assert.doesNotMatch(meta.text, /数据来源|Open-Meteo|CMA/)
}

async function calendarToolbarAppearance(window) {
  return window.webContents.executeJavaScript(`(() => {
    const toolbar = document.querySelector('.month-toolbar')
    const today = document.querySelector('.month-toolbar__today')
    const expectedNames = ['locate-current', 'taiji', 'recurrence', 'move-to-today', 'date-panel']
    const icons = expectedNames.map((name) =>
      document.querySelector('.month-toolbar [data-icon-name="' + name + '"]')
    )
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
    return {
      toolbarHeight: toolbar?.getBoundingClientRect().height ?? 0,
      rootFontSize,
      todayText: today?.textContent.trim() ?? '',
      todayLabel: today?.getAttribute('aria-label') ?? '',
      iconNames: icons.map((icon) => icon?.dataset.iconName ?? ''),
      iconWidths: icons.map((icon) => icon?.getBoundingClientRect().width ?? 0),
      pairedAssets: icons.every(
        (icon) =>
          icon?.querySelector('.app-icon__asset--black') &&
          icon?.querySelector('.app-icon__asset--white')
      ),
      whiteAssetsVisible: icons.every((icon) => {
        const black = icon?.querySelector('.app-icon__asset--black')
        const white = icon?.querySelector('.app-icon__asset--white')
        return getComputedStyle(black).display === 'none' && getComputedStyle(white).display !== 'none'
      })
    }
  })()`)
}

async function assertCalendarToolbarAppearance(window) {
  const initial = await calendarToolbarAppearance(window)
  assert.ok(
    initial.toolbarHeight <= 36 * initial.rootFontSize + 0.1,
    `日历工具栏高度没有收紧到 36rem：${JSON.stringify(initial)}`
  )
  assert.equal(initial.todayText, '', '定位到今天入口不应继续显示文字')
  assert.equal(initial.todayLabel, '定位到今天')
  assert.deepEqual(initial.iconNames, [
    'locate-current',
    'taiji',
    'recurrence',
    'move-to-today',
    'date-panel'
  ])
  assert.equal(initial.pairedAssets, true, '日历工具栏操作图标必须同时提供黑白资源')
  assert.ok(
    initial.iconWidths.every((width) => Math.abs(width - 17 * initial.rootFontSize) < 0.1),
    `日历工具栏默认图标大小不正确：${JSON.stringify(initial)}`
  )

  await window.webContents.executeJavaScript(
    `window.api.setSettingValue('appearance.titlebarIconScale', 150)`
  )
  await window.webContents.executeJavaScript(
    `window.api.setSettingValue('appearance.iconColor', 'white')`
  )
  const customized = await waitUntil(async () => {
    const state = await calendarToolbarAppearance(window)
    return state.whiteAssetsVisible &&
      state.iconWidths.every((width) => Math.abs(width - 25.5 * state.rootFontSize) < 0.1)
      ? state
      : null
  }, '日历工具栏图标没有响应设置中的颜色和大小')
  assert.equal(customized.pairedAssets, true)

  await window.webContents.executeJavaScript(
    `window.api.setSettingValue('appearance.titlebarIconScale', 100)`
  )
  await window.webContents.executeJavaScript(
    `window.api.setSettingValue('appearance.iconColor', 'black')`
  )
}

async function assertDayPanelWeatherLayout(window) {
  await window.webContents.executeJavaScript(
    `document.querySelector('.month-toolbar__day-panel-toggle').click()`
  )
  const layout = await waitUntil(
    () =>
      window.webContents.executeJavaScript(`(() => {
        const weather = document.querySelector('.month-day-panel__weather')
        const main = weather?.querySelector('.month-day-panel__weather-main')
        const details = weather?.querySelector('.month-day-panel__weather-details')
        const place = main?.querySelector('span')
        if (!weather || !main || !details || !place) return null
        const mainRect = main.getBoundingClientRect()
        const detailsRect = details.getBoundingClientRect()
        return {
          mainRight: mainRect.right,
          detailsLeft: detailsRect.left,
          placeOverflow: getComputedStyle(place).overflow,
          placeEllipsis: getComputedStyle(place).textOverflow
        }
      })()`),
    '日期侧栏天气没有显示'
  )
  assert.ok(
    layout.mainRight <= layout.detailsLeft,
    `日期侧栏天气主信息与详情发生重叠：${JSON.stringify(layout)}`
  )
  assert.deepEqual(
    [layout.placeOverflow, layout.placeEllipsis],
    ['hidden', 'ellipsis'],
    '天气地区过长时必须单行省略'
  )
  await window.webContents.executeJavaScript(
    `document.querySelector('.month-toolbar__day-panel-toggle').click()`
  )
}

const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-main-view-enhancements-'))

try {
  app.setPath('userData', testUserData)
  process.env.ABANDON_INTEGRATION_TEST = '1'
  process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
  process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve(
    'native_blur',
    'build',
    'bin',
    'blur_engine.dll'
  )
  seedMainView(testUserData)

  require(resolve('out', 'main', 'index.js'))
  const mainChunk = readdirSync(resolve('out', 'main', 'chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk, '未找到构建后的主进程分块')
  require(resolve('out', 'main', 'chunks', mainChunk))
  app.once('ready', () => void runMainViewEnhancementsTest())
} catch (error) {
  report(`setup failed: ${error?.stack || error}`)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}

async function runMainViewEnhancementsTest() {
  try {
    const listWindow = await waitForView('list')
    const noteIds = await listWindow.webContents.executeJavaScript(`(async () => {
      const today = await window.api.createNote({ content: '有天气的便签' })
      const tomorrow = await window.api.createNote({
        content: '没有天气的便签',
        effectiveAt: Date.now() + 24 * 60 * 60 * 1000
      })
      return { today: today.id, tomorrow: tomorrow.id }
    })()`)
    const weatherState = await waitUntil(async () => {
      const state = await listWindow.webContents.executeJavaScript(`(() => {
        const today = document.querySelector('[data-note-id="${noteIds.today}"]')
        const tomorrow = document.querySelector('[data-note-id="${noteIds.tomorrow}"]')
        return {
          todayWeather: today?.querySelector('.nl-card-weather')?.textContent?.trim() || '',
          tomorrowHasWeather: Boolean(tomorrow?.querySelector('.nl-card-weather'))
        }
      })()`)
      return state.todayWeather ? state : null
    }, '便签列表没有显示生效日天气')
    assert.match(weatherState.todayWeather, /晴\s*18°～27°/)
    assert.equal(weatherState.tomorrowHasWeather, false, '无预报日期不得显示天气占位')

    const listTitlebarState = await listWindow.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('.view-switcher__trigger')
      const triggerIcon = document.querySelector('.view-switcher__trigger-icon')
      const blackAsset = triggerIcon.querySelector('.app-icon__asset--black')
      const whiteAsset = triggerIcon.querySelector('.app-icon__asset--white')
      const triggerRect = trigger.getBoundingClientRect()
      const iconRect = triggerIcon.getBoundingClientRect()
      const root = document.documentElement
      root.setAttribute('data-icon-color', 'white')
      const whiteAssetVisible = getComputedStyle(whiteAsset).display !== 'none'
      const blackAssetHidden = getComputedStyle(blackAsset).display === 'none'
      root.setAttribute('data-icon-color', 'black')
      const blackAssetVisible = getComputedStyle(blackAsset).display !== 'none'
      const whiteAssetHidden = getComputedStyle(whiteAsset).display === 'none'
      return {
        whiteAssetVisible,
        blackAssetHidden,
        blackAssetVisible,
        whiteAssetHidden,
        centerOffsetX: Math.abs(
          triggerRect.left + triggerRect.width / 2 - (iconRect.left + iconRect.width / 2)
        ),
        centerOffsetY: Math.abs(
          triggerRect.top + triggerRect.height / 2 - (iconRect.top + iconRect.height / 2)
        )
      }
    })()`)
    assert.equal(listTitlebarState.whiteAssetVisible, true, '视图图标没有切换到白色资源')
    assert.equal(listTitlebarState.blackAssetHidden, true, '白色模式仍显示黑色视图图标')
    assert.equal(listTitlebarState.blackAssetVisible, true, '视图图标没有切换到黑色资源')
    assert.equal(listTitlebarState.whiteAssetHidden, true, '黑色模式仍显示白色视图图标')
    assert.ok(
      listTitlebarState.centerOffsetX < 0.1 && listTitlebarState.centerOffsetY < 0.1,
      `视图图标没有在按钮中居中：${JSON.stringify(listTitlebarState)}`
    )

    const triggerHoverTarget = await listWindow.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('.view-switcher__trigger')
      const icon = document.querySelector('.view-switcher__trigger-icon')
      const rect = trigger.getBoundingClientRect()
      const microsoft = document
        .querySelector('.titlebar-actions-group')
        .classList.contains('titlebar-actions-group--microsoft')
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        hitTarget: document.elementFromPoint(
          Math.round(rect.left + rect.width / 2),
          Math.round(rect.top + rect.height / 2)
        )?.closest('.view-switcher__trigger') === trigger,
        initialOpacity: getComputedStyle(icon).opacity,
        expectedInitialOpacity: microsoft ? '0.72' : '0'
      }
    })()`)
    assert.equal(triggerHoverTarget.hitTarget, true, '视图切换按钮中心被其他图层遮挡')
    assert.equal(
      triggerHoverTarget.initialOpacity,
      triggerHoverTarget.expectedInitialOpacity,
      '视图文字常态应与其他标题栏图标保持相同透明度'
    )
    listWindow.focus()
    listWindow.webContents.sendInputEvent({
      type: 'mouseMove',
      x: 1,
      y: listWindow.getBounds().height - 1
    })
    await wait(50)
    listWindow.webContents.sendInputEvent({
      type: 'mouseMove',
      x: triggerHoverTarget.x,
      y: triggerHoverTarget.y
    })
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `getComputedStyle(document.querySelector('.view-switcher__trigger-icon')).opacity === '1'`
        ),
      '鼠标悬停标题栏按钮组时没有显示视图图标'
    )

    const listWindowId = listWindow.id
    await chooseView(listWindow, 'list')
    assert.equal(getViewWindow('list')?.id, listWindowId, '重复选择当前视图不应重建窗口')

    await chooseView(listWindow, 'month')
    const monthWindow = await waitForView('month')
    await assertTodayWeatherSummary(monthWindow)
    await assertCalendarToolbarAppearance(monthWindow)
    await assertDayPanelWeatherLayout(monthWindow)
    await chooseView(monthWindow, 'week')
    const weekWindow = await waitForView('week')
    await assertTodayWeatherSummary(weekWindow)
    await chooseView(weekWindow, 'list')
    await waitForView('list')

    const db = new Database(join(testUserData, 'app.db'), { readonly: true })
    const activeView = db
      .prepare(
        `SELECT value FROM app_settings
         WHERE window_name = 'application' AND type = 'application' AND key = 'active_view'`
      )
      .pluck()
      .get()
    db.close()
    assert.equal(activeView, 'list', '标题栏切换后的当前视图没有持久化')

    report('note weather and list/month/week titlebar switching passed')
    app.exit(0)
  } catch (error) {
    report(`failed: ${error?.stack || error}`)
    app.exit(1)
  }
}

app.on('will-quit', () => {
  try {
    rmSync(testUserData, { recursive: true, force: true })
  } catch {
    // Electron 退出时可能仍短暂占用临时数据库，不覆盖测试结果。
  }
})
