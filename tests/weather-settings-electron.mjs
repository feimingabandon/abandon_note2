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

function seedMonthView(userDataPath) {
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
  insert.run('application', 'application', 'active_view', 'month', now, now)
  insert.run('application', 'remote', 'receive_notices', 'false', now, now)
  insert.run('application', 'remote', 'upload_device_info', 'false', now, now)
  insert.run('application', 'onboarding', 'first_use_notice_version', '1', now, now)
  insert.run('month', 'system', 'blur_enabled', 'false', now, now)
  db.close()
}

function getMonthWindow() {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && /\/month\.html(?:$|[?#])/.test(window.webContents.getURL())
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
  seedMonthView(testUserData)
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
    const monthWindow = await waitUntil(getMonthWindow, '月视图主窗口未启动', 10000)
    await waitUntil(() => monthWindow.isVisible(), '月视图渲染就绪后没有显示')
    monthWindow.setSize(900, 700)

    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-titlebar-btn[title="设置"]').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.settings-panel.active'))`
        ),
      '设置面板没有打开'
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.china-area-cascader__trigger:not(:disabled)'))`
        ),
      '中国行政区划没有加载'
    )

    const clicked = await monthWindow.webContents.executeJavaScript(`(async () => {
      const trigger = document.querySelector('.china-area-cascader__trigger')
      trigger.scrollIntoView({ block: 'center' })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const body = document.querySelector('.settings-panel .panel-body')
      const targetTriggerTop = innerHeight - 60
      for (let attempt = 0; attempt < 5; attempt += 1) {
        body.scrollTop += trigger.getBoundingClientRect().top - targetTriggerTop
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
      trigger.click()
      await new Promise((resolve) => setTimeout(resolve, 40))
      const triggerRect = trigger.getBoundingClientRect()
      const panelRect = document.querySelector('.china-area-cascader__panel').getBoundingClientRect()

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
      const city = clickNamed(1, '广州市')
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const district = clickNamed(2, '增城区')
      return {
        province,
        city,
        district,
        placement: {
          viewportHeight: innerHeight,
          triggerTop: triggerRect.top,
          panelTop: panelRect.top,
          panelBottom: panelRect.bottom
        }
      }
    })()`)
    assert.deepEqual(
      { province: clicked.province, city: clicked.city, district: clicked.district },
      { province: true, city: true, district: true }
    )
    assert.ok(
      clicked.placement.panelTop < clicked.placement.triggerTop,
      `底部空间不足时地区面板必须向上展开: ${JSON.stringify(clicked.placement)}`
    )
    assert.ok(
      clicked.placement.panelBottom <= clicked.placement.viewportHeight - 7,
      `地区面板不得超出窗口底部: ${JSON.stringify(clicked.placement)}`
    )

    const saved = await waitUntil(async () => {
      const state = await monthWindow.webContents.executeJavaScript(`(async () => {
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
