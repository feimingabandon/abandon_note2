import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const require = createRequire(import.meta.url)
const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-recurring-preview-e2e-'))
const report = (message) => process.stderr.write(`[recurring-preview-e2e] ${message}\n`)
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))
let exitCode = 0

async function waitUntil(predicate, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(30)
  }
  throw new Error(message)
}

function seedSettings() {
  mkdirSync(testUserData, { recursive: true })
  const db = new Database(join(testUserData, 'app.db'))
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
  insert.run('week', 'system', 'blur_enabled', 'false', now, now)
  db.close()
}

function viewWindow(view) {
  return BrowserWindow.getAllWindows().find(
    (window) =>
      !window.isDestroyed() &&
      new RegExp(`/${view}\\.html(?:$|[?#])`).test(window.webContents.getURL())
  )
}

function dateKey(date) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, '0'))
    .join('-')
}

async function ensureDateVisible(window, targetDateKey, view) {
  const visible = await window.webContents.executeJavaScript(
    `Boolean(document.querySelector('.month-day-cell[data-date="${targetDateKey}"]'))`
  )
  if (visible) return

  if (view === 'month') {
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="下个月"]')?.click()`
    )
  } else {
    await window.webContents.executeJavaScript(`(() => {
      const title = document.querySelector('.month-toolbar__title')
      if (title?.getAttribute('aria-expanded') !== 'true') title?.click()
    })()`)
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-toolbar__date-option[aria-label="${targetDateKey}"]'))`
        ),
      '周视图日期选择器没有显示目标循环日期'
    )
    await window.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__date-option[aria-label="${targetDateKey}"]').click()`
    )
  }

  await waitUntil(
    () =>
      window.webContents.executeJavaScript(
        `Boolean(document.querySelector('.month-day-cell[data-date="${targetDateKey}"]'))`
      ),
    `${view} 视图没有导航到循环便签预览日期`
  )
}

async function assertPreview(window, content) {
  const selector = `.month-event-bar.is-recurring-preview[data-preview="${content}"]`
  await waitUntil(
    () => window.webContents.executeJavaScript(`Boolean(document.querySelector('${selector}'))`),
    `没有显示循环便签预览：${content}`
  )

  const interaction = await window.webContents.executeJavaScript(`(async () => {
    const bar = document.querySelector('${selector}')
    bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))
    bar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))
    await new Promise((resolve) => setTimeout(resolve, 320))
    return {
      ariaLabel: bar.getAttribute('aria-label'),
      quickEditor: Boolean(document.querySelector('.quick-note-editor')),
      contextMenu: Boolean(document.querySelector('.month-cell-context-menu-shell')),
      opacity: Number.parseFloat(getComputedStyle(bar).opacity),
      shadow: getComputedStyle(bar).boxShadow
    }
  })()`)
  assert.match(interaction.ariaLabel, /循环便签预览.*只读/s)
  assert.equal(interaction.quickEditor, false, '预览横条不得打开双击快速编辑器')
  assert.equal(interaction.contextMenu, false, '预览横条不得打开便签右键菜单')
  assert.ok(interaction.opacity < 1, '预览横条必须弱化显示')
  assert.equal(interaction.shadow, 'none', '预览横条不应使用真实便签的强调阴影')
}

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
  seedSettings()
  report('seeded isolated database')

  require(resolve('out', 'main', 'index.js'))
  const mainChunk = readdirSync(resolve('out', 'main', 'chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk, '未找到构建后的主进程分块')
  require(resolve('out', 'main', 'chunks', mainChunk))
  report('loaded built main process')
  if (app.isReady()) void run()
  else app.once('ready', () => void run())
} catch (error) {
  report(`setup failed: ${error?.stack || error}`)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}

async function run() {
  try {
    const monthWindow = await waitUntil(() => viewWindow('month'), '月视图没有启动', 10000)
    await waitUntil(() => monthWindow.isVisible(), '月视图没有显示')

    const target = new Date(Date.now() + 10 * 60 * 1000)
    target.setSeconds(0, 0)
    const targetDateKey = dateKey(target)
    const timeOfDay = `${String(target.getHours()).padStart(2, '0')}:${String(
      target.getMinutes()
    ).padStart(2, '0')}`
    const content = `循环预览专项 ${target.getTime()}`

    await monthWindow.webContents.executeJavaScript(
      `window.api.createTemplate(${JSON.stringify({
        content,
        recurrenceRule: { frequency: 'daily', interval: 1, time_of_day: timeOfDay },
        notifyEnabled: false,
        isPinned: false,
        tagIds: []
      })})`
    )
    await ensureDateVisible(monthWindow, targetDateKey, 'month')

    const initialToggle = await monthWindow.webContents.executeJavaScript(`(() => ({
      label: document.querySelector('.month-toolbar__recurring-preview')?.getAttribute('aria-label'),
      checked: document.querySelector('.month-toolbar__recurring-preview-toggle')?.getAttribute('aria-checked'),
      previewVisible: Array.from(document.querySelectorAll('.month-event-bar'), (node) => node.dataset.preview).includes(${JSON.stringify(content)})
    }))()`)
    assert.equal(initialToggle.label, '显示循环便签预览')
    assert.equal(initialToggle.checked, 'false', '循环便签预览必须默认关闭')
    assert.equal(initialToggle.previewVisible, false, '开关关闭时不得显示未来循环节点')

    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__recurring-preview-toggle').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-toolbar__recurring-preview-toggle')?.getAttribute('aria-checked') === 'true'`
        ),
      '月视图循环便签预览开关没有开启'
    )
    await assertPreview(monthWindow, content)

    const storedDb = new Database(join(testUserData, 'app.db'), { readonly: true })
    const stored = storedDb
      .prepare(
        "SELECT window_name, value FROM app_settings WHERE type = 'calendar' AND key = 'recurring_preview_enabled'"
      )
      .get()
    storedDb.close()
    assert.deepEqual(stored, { window_name: 'application', value: '1' })

    await monthWindow.webContents.executeJavaScript(`window.api.switchMainView('week')`)
    const weekWindow = await waitUntil(() => viewWindow('week'), '没有切换到周视图', 10000)
    await waitUntil(() => weekWindow.isVisible(), '周视图没有显示')
    await ensureDateVisible(weekWindow, targetDateKey, 'week')
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `document.querySelector('.month-toolbar__recurring-preview-toggle')?.getAttribute('aria-checked') === 'true'`
        ),
      '周视图没有继承循环便签预览开关'
    )
    await assertPreview(weekWindow, content)

    await weekWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__recurring-preview-toggle').click()`
    )
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `!Array.from(document.querySelectorAll('.month-event-bar'), (node) => node.dataset.preview).includes(${JSON.stringify(content)})`
        ),
      '关闭开关后周视图仍显示循环便签预览'
    )
    report('month/week preview toggle, persistence, muted style and read-only interactions passed')
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    process.exitCode = exitCode
    app.releaseSingleInstanceLock()
    app.once('quit', () => {
      try {
        rmSync(testUserData, { recursive: true, force: true })
      } catch {
        // Electron 退出前可能仍短暂持有 Crashpad 文件。
      }
      process.exit(exitCode)
    })
    app.quit()
  }
}
