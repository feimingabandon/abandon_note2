import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, screen } from 'electron'

const WAIT_STEP_MS = 25
const require = createRequire(import.meta.url)
const report = (message) => process.stderr.write(`[week-e2e] ${message}\n`)

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

function seedWeekView(userDataPath) {
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
  insert.run('application', 'application', 'active_view', 'week', now, now)
  insert.run('application', 'remote', 'receive_notices', 'false', now, now)
  insert.run('application', 'remote', 'upload_device_info', 'false', now, now)
  insert.run('application', 'onboarding', 'first_use_notice_version', '1', now, now)
  // 周视图第一次启动应继承月视图的窗口、侧栏与外观设置。
  insert.run('month', 'geometry', 'pos_x', '110', now, now)
  insert.run('month', 'geometry', 'pos_y', '120', now, now)
  // GitHub Windows runner 的工作区约为 1024x720；尺寸过大时约束后的 y=20
  // 会恰好命中贴边阈值，并在 show 时被正常吸附到 y=0，干扰本用例的继承断言。
  insert.run('month', 'geometry', 'width', '900', now, now)
  insert.run('month', 'geometry', 'height', '600', now, now)
  insert.run('month', 'ui', 'day_panel_size', '33', now, now)
  insert.run('month', 'appearance', 'titlebar_style', 'microsoft', now, now)
  insert.run('month', 'system', 'blur_enabled', 'false', now, now)
  db.close()
}

function getWeekWindow() {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && /\/week\.html(?:$|[?#])/.test(window.webContents.getURL())
  )
}

function addDays(dateKey, amount) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + amount))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-week-e2e-'))

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
  seedWeekView(testUserData)
  report('seeded isolated database')

  require(resolve('out', 'main', 'index.js'))
  const mainChunk = readdirSync(resolve('out', 'main', 'chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk, '未找到构建后的主进程分块')
  require(resolve('out', 'main', 'chunks', mainChunk))
  app.once('ready', () => void runWeekViewTests())
} catch (error) {
  report(`setup failed: ${error?.stack || error}`)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}

async function runWeekViewTests() {
  try {
    let win = await waitUntil(() => getWeekWindow(), 'week window missing')
    await waitUntil(() => win.isVisible(), 'window not visible')
    mkdirSync('tmp/calendar-font-qa', { recursive: true })
    for (const mode of ['week', 'month']) {
      if (mode === 'month') {
        await win.webContents.executeJavaScript(`window.api.switchMainView('month')`)
        win = await waitUntil(
          () =>
            BrowserWindow.getAllWindows().find((w) => /\/month\.html/.test(w.webContents.getURL())),
          'month window missing'
        )
        await waitUntil(() => win.isVisible(), 'month not visible')
      }
      const snapshot = await win.webContents.executeJavaScript('window.api.getSettingsSnapshot()')
      assert.equal(snapshot.values.css.fontSizeBase, 20)
      await win.webContents.executeJavaScript(`(async () => {
        for (let i = 0; i < 12; i++) await window.api.createNote({content: '大字号测试 中文 English 123456789 长文字背景边界 ' + i, durationDays: 7})
      })()`)
      for (const size of [20, 28, 20, 28]) {
        await win.webContents.executeJavaScript(
          `window.api.setSettingValue('css.fontSizeBase', ${size})`
        )
        await wait(850)
        const result = await win.webContents.executeJavaScript(`(() => {
          const bars = [...document.querySelectorAll('.month-event-bar')]
          return { count: bars.length, failures: bars.flatMap(bar => {
            const b = bar.getBoundingClientRect(), t = bar.querySelector('.month-event-bar__text').getBoundingClientRect(), layer = bar.parentElement.getBoundingClientRect()
            return t.top < b.top - 1 || t.bottom > b.bottom + 1 || b.bottom > layer.bottom + 1 ? [{ b: b.toJSON(), t: t.toJSON(), layer: layer.toJSON() }] : []
          }) }
        })()`)
        const layout = await win.webContents.executeJavaScript(`(() => {
          const navigation = document.querySelector('.month-toolbar__navigation').getBoundingClientRect()
          const trailing = document.querySelector('.month-toolbar__trailing').getBoundingClientRect()
          return { toolbarFits: navigation.right <= trailing.left + 1 }
        })()`)
        assert.equal(layout.toolbarFits, true, mode + ' toolbar overlap')
        assert.ok(result.count > 0)
        assert.deepEqual(result.failures, [], mode + ' font ' + size + ' overflow')
      }
      for (const [name, bg, color] of [
        ['white', '#ffffff', '#111111'],
        ['black', '#000000', '#eeeeee'],
        [
          'complex',
          'linear-gradient(135deg, #172a3a 0 24%, #bd6b45 24% 48%, #2e806e 48% 72%, #e4c46a 72% 100%)',
          '#ffffff'
        ]
      ]) {
        await win.webContents.executeJavaScript(
          `document.querySelector('.month-root').style.background = ${JSON.stringify(bg)}; document.documentElement.style.setProperty('--text-color', ${JSON.stringify(color)})`
        )
        await wait(150)
        writeFileSync(
          'tmp/calendar-font-qa/' + mode + '-' + name + '.png',
          (await win.capturePage()).toPNG()
        )
      }
      report(mode + ': defaults, live font changes and event bounds passed')
    }
    app.exit(0)
  } catch (error) {
    report(error.stack)
    app.exit(1)
  }
}
