import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'

const WAIT_STEP_MS = 25
const require = createRequire(import.meta.url)
const report = (message) => process.stderr.write(`[weather-settings-e2e] ${message}\n`)

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

async function waitUntil(predicate, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(WAIT_STEP_MS)
  }
  throw new Error(message)
}

function seedListView(userDataPath) {
  mkdirSync(userDataPath, { recursive: true })
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
  const now = Date.now()
  insert.run('application', 'application', 'active_view', 'list', now, now)
  insert.run('application', 'remote', 'receive_notices', 'false', now, now)
  insert.run('application', 'remote', 'upload_device_info', 'false', now, now)
  insert.run('application', 'onboarding', 'first_use_notice_version', '1', now, now)
  insert.run('main', 'system', 'blur_enabled', 'false', now, now)
  db.close()
}

function getListWindow() {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && /\/index\.html(?:$|[?#])/.test(window.webContents.getURL())
  )
}

const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-weather-settings-e2e-'))
let exitCode = 0

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
  seedListView(testUserData)
  report('seeded isolated database')

  require(resolve('out', 'main', 'index.js'))
  const mainChunk = readdirSync(resolve('out', 'main', 'chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk, '未找到构建后的主进程分块')
  require(resolve('out', 'main', 'chunks', mainChunk))
  app.once('ready', () => void runWeatherSettingsTest())
} catch (error) {
  report(`setup failed: ${error?.stack || error}`)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}

async function runWeatherSettingsTest() {
  try {
    const listWindow = await waitUntil(getListWindow, '列表主窗口未启动', 10000)
    await waitUntil(() => listWindow.isVisible(), '列表视图渲染就绪后没有显示')
    listWindow.setSize(445, 852)

    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.titlebar-btn-settings[title="设置"]').click()`
    )
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.settings-panel.active'))`
        ),
      '设置面板没有打开'
    )
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.china-area-cascader__trigger:not(:disabled)'))`
        ),
      '中国行政区划没有加载'
    )

    const prepared = await listWindow.webContents.executeJavaScript(`(async () => {
      const trigger = document.querySelector('.china-area-cascader__trigger')
      trigger.scrollIntoView({ block: 'center' })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const body = document.querySelector('.settings-panel .panel-body')
      const targetTriggerTop = innerHeight * 0.66
      for (let attempt = 0; attempt < 5; attempt += 1) {
        body.scrollTop += trigger.getBoundingClientRect().top - targetTriggerTop
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
      trigger.click()
      await new Promise((resolve) => setTimeout(resolve, 40))
      const triggerRect = trigger.getBoundingClientRect()
      const panelRect = document.querySelector('.china-area-cascader__panel').getBoundingClientRect()
      const titlebarRect = document.querySelector('.app-titlebar').getBoundingClientRect()
      const rootRem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)

      const clickNamed = (columnIndex, name) => {
        const column = document.querySelectorAll('.china-area-cascader__column')[columnIndex]
        const target = [...(column?.querySelectorAll('button') || [])].find((button) =>
          button.textContent.trim().startsWith(name)
        )
        target?.click()
        return Boolean(target)
      }

      const province = clickNamed(0, '广东省')
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const cityColumn = document.querySelectorAll('.china-area-cascader__column')[1]
      cityColumn.scrollTop = cityColumn.scrollHeight
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const cityScrollBeforeSwitch = cityColumn.scrollTop
      const switchedProvince = clickNamed(0, '浙江省')
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const firstCity = cityColumn.querySelector('button')
      const firstCityRect = firstCity?.getBoundingClientRect()
      return {
        province,
        switchedProvince,
        cityScrollBeforeSwitch,
        cityScrollAfterSwitch: cityColumn.scrollTop,
        firstCityName: firstCity?.textContent.trim() || '',
        firstCityPoint: firstCityRect
          ? {
              x: Math.round(firstCityRect.left + firstCityRect.width / 2),
              y: Math.round(firstCityRect.top + firstCityRect.height / 2)
            }
          : null,
        placement: {
          viewportHeight: innerHeight,
          triggerTop: triggerRect.top,
          panelTop: panelRect.top,
          panelBottom: panelRect.bottom,
          panelHeight: panelRect.height,
          expectedMaxHeight: 294 * rootRem,
          titlebarBottom: titlebarRect.bottom,
          scrollableColumns: [...document.querySelectorAll('.china-area-cascader__column')]
            .filter((column) => column.scrollHeight > column.clientHeight + 1).length
        }
      }
    })()`)
    assert.equal(prepared.province, true, '没有选中用于制造滚动状态的广东省')
    assert.equal(prepared.switchedProvince, true, '没有切换到浙江省')
    assert.ok(prepared.cityScrollBeforeSwitch > 0, '城市列没有形成待清理的滚动状态')
    assert.equal(prepared.cityScrollAfterSwitch, 0, '切换省份后城市列没有回到顶部')
    assert.match(prepared.firstCityName, /^杭州市/, '回到顶部后第一项应为杭州市')
    assert.ok(prepared.firstCityPoint, '没有取得第一项城市的真实点击坐标')
    assert.ok(
      prepared.placement.panelTop < prepared.placement.triggerTop,
      `底部空间不足时地区面板必须向上展开: ${JSON.stringify(prepared.placement)}`
    )
    assert.ok(
      prepared.placement.panelBottom <= prepared.placement.viewportHeight - 7,
      `地区面板不得超出窗口底部: ${JSON.stringify(prepared.placement)}`
    )
    assert.ok(
      prepared.placement.panelTop >= prepared.placement.titlebarBottom + 3,
      `地区面板第一行不得进入标题栏交互区: ${JSON.stringify(prepared.placement)}`
    )
    assert.ok(
      prepared.placement.panelHeight <= prepared.placement.expectedMaxHeight + 1,
      `地区面板不得被内联高度放大并覆盖标题栏: ${JSON.stringify(prepared.placement)}`
    )
    assert.ok(
      prepared.placement.scrollableColumns > 0,
      `低高度窗口中地区列必须在面板内部滚动: ${JSON.stringify(prepared.placement)}`
    )

    listWindow.focus()
    listWindow.webContents.sendInputEvent({ type: 'mouseMove', ...prepared.firstCityPoint })
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(`(() => {
          const firstCity = document.querySelectorAll('.china-area-cascader__column')[1]
            ?.querySelector('button')
          const point = ${JSON.stringify(prepared.firstCityPoint)}
          return firstCity?.matches(':hover') &&
            document.elementFromPoint(point.x, point.y)?.closest('button') === firstCity
        })()`),
      '真实鼠标移动没有悬停到城市列第一项'
    )
    listWindow.webContents.sendInputEvent({
      type: 'mouseDown',
      ...prepared.firstCityPoint,
      button: 'left',
      clickCount: 1
    })
    listWindow.webContents.sendInputEvent({
      type: 'mouseUp',
      ...prepared.firstCityPoint,
      button: 'left',
      clickCount: 1
    })
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `document.querySelectorAll('.china-area-cascader__column')[1]
            ?.querySelector('button.is-active')?.textContent.trim().startsWith('杭州市')`
        ),
      '真实鼠标事件没有选中城市列第一项'
    )

    const clicked = await listWindow.webContents.executeJavaScript(`(async () => {
      const clickNamed = (columnIndex, name) => {
        const column = document.querySelectorAll('.china-area-cascader__column')[columnIndex]
        const target = [...(column?.querySelectorAll('button') || [])].find((button) =>
          button.textContent.trim().startsWith(name)
        )
        target?.click()
        return Boolean(target)
      }
      const districtColumn = document.querySelectorAll('.china-area-cascader__column')[2]
      districtColumn.scrollTop = districtColumn.scrollHeight
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const districtScrollBeforeSwitch = districtColumn.scrollTop
      const switchedCity = clickNamed(1, '宁波市')
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const districtScrollAfterSwitch = districtColumn.scrollTop

      const province = clickNamed(0, '广东省')
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const city = clickNamed(1, '广州市')
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const districtTarget = [...(districtColumn?.querySelectorAll('button') || [])].find(
        (button) => button.textContent.trim().startsWith('增城区')
      )
      districtTarget?.click()
      districtTarget?.click()
      return {
        province,
        city,
        district: Boolean(districtTarget),
        switchedCity,
        districtScrollBeforeSwitch,
        districtScrollAfterSwitch
      }
    })()`)
    assert.deepEqual(
      { province: clicked.province, city: clicked.city, district: clicked.district },
      { province: true, city: true, district: true }
    )
    assert.equal(clicked.switchedCity, true, '没有切换到宁波市')
    assert.ok(clicked.districtScrollBeforeSwitch > 0, '区县列没有形成待清理的滚动状态')
    assert.equal(clicked.districtScrollAfterSwitch, 0, '切换城市后区县列没有回到顶部')

    const saved = await waitUntil(async () => {
      const state = await listWindow.webContents.executeJavaScript(`(async () => {
          const snapshot = await window.api.getSettingsSnapshot()
          return {
            enabled: snapshot.values.weather.enabled,
            location: snapshot.values.weather.location,
            display: document.querySelector('.china-area-cascader__trigger')?.textContent?.trim(),
            errors: [...document.querySelectorAll('.weather-settings__message.is-error')]
              .map((item) => item.textContent.trim())
          }
        })()`)
      return state.location?.id === 440118 && state.enabled ? state : null
    }, '手动选择的天气地区没有写入设置')

    assert.equal(saved.enabled, true, '首次选择地区后必须自动开启天气')
    assert.match(saved.display, /广东省 \/ 广州市 \/ 增城区/)
    assert.deepEqual(saved.errors, [], '成功选择地区后不应显示 IPC 克隆错误')
    assert.deepEqual(
      {
        name: saved.location.name,
        admin1: saved.location.admin1,
        admin2: saved.location.admin2,
        latitude: saved.location.latitude,
        longitude: saved.location.longitude
      },
      {
        name: '增城区',
        admin1: '广东省',
        admin2: '广州市',
        latitude: 23.2905,
        longitude: 113.82958
      }
    )
    const locationFailures = await listWindow.webContents.executeJavaScript(`(async () => {
      const originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'geolocation')
      const originalFetch = window.fetch
      const options = []
      const codes = [2, 3]
      let networkAttempt = 0
      window.fetch = async () => {
        networkAttempt += 1
        if (networkAttempt === 1) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                city: '杭州市',
                locality: '西湖区',
                principalSubdivision: '浙江省',
                countryName: '中国',
                countryCode: 'CN',
                latitude: 30.2741,
                longitude: 120.1551
              }
            }
          }
        }
        throw new Error('模拟网络大致地区不可用')
      }
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: {
          getCurrentPosition(_success, failure, receivedOptions) {
            options.push(receivedOptions)
            const code = codes.shift()
            queueMicrotask(() => failure({ code }))
          }
        }
      })
      const button = [...document.querySelectorAll('.weather-settings__picker button')].find(
        (item) => item.textContent.includes('使用设备位置')
      )
      const waitFor = async (predicate) => {
        const deadline = Date.now() + 2000
        while (Date.now() < deadline) {
          if (predicate()) return
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error('等待模拟定位结果超时')
      }
      const messages = []
      const expectedResults = ['已使用网络大致地区', '网络大致地区也不可用']
      for (let attempt = 0; attempt < 2; attempt += 1) {
        button.click()
        await waitFor(() =>
          document
            .querySelector('.weather-settings__message.is-error')
            ?.textContent.includes(expectedResults[attempt])
        )
        messages.push(document.querySelector('.weather-settings__message.is-error')?.textContent.trim())
      }
      const snapshot = await window.api.getSettingsSnapshot()
      if (originalDescriptor) Object.defineProperty(navigator, 'geolocation', originalDescriptor)
      else delete navigator.geolocation
      window.fetch = originalFetch
      return { messages, options, fallbackLocation: snapshot.values.weather.location }
    })()`)
    assert.match(locationFailures.messages[0], /系统暂时无法确定位置.*已使用网络大致地区/)
    assert.match(locationFailures.messages[1], /获取设备位置超时.*网络大致地区也不可用/)
    assert.deepEqual(
      {
        name: locationFailures.fallbackLocation.name,
        admin1: locationFailures.fallbackLocation.admin1,
        admin2: locationFailures.fallbackLocation.admin2,
        latitude: locationFailures.fallbackLocation.latitude,
        longitude: locationFailures.fallbackLocation.longitude
      },
      {
        name: '西湖区',
        admin1: '浙江省',
        admin2: '杭州市',
        latitude: 30.2741,
        longitude: 120.1551
      }
    )
    assert.deepEqual(
      locationFailures.options.map((options) => ({
        enableHighAccuracy: options.enableHighAccuracy,
        timeout: options.timeout,
        maximumAge: options.maximumAge
      })),
      [
        { enableHighAccuracy: false, timeout: 20000, maximumAge: 3600000 },
        { enableHighAccuracy: false, timeout: 20000, maximumAge: 3600000 }
      ]
    )
    report('manual province-city-district selection persisted successfully')
  } catch (error) {
    exitCode = 1
    report(error?.stack || error)
  } finally {
    app.exit(exitCode)
    setTimeout(() => {
      rmSync(testUserData, { recursive: true, force: true })
      process.exit(exitCode)
    }, 100)
  }
}
