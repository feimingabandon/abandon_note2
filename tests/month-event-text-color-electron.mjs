import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'

const require = createRequire(import.meta.url)
const report = (message) => process.stderr.write(`[month-event-text-color-e2e] ${message}\n`)
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))

app.commandLine.appendSwitch('disable-gpu')

async function waitUntil(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(25)
  }
  throw new Error(message)
}

function seedMonthView(userDataPath) {
  mkdirSync(userDataPath, { recursive: true })
  const database = new Database(join(userDataPath, 'app.db'))
  database.exec(`
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
  const insert = database.prepare(`
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
  database.close()
}

function monthWindow() {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && /\/month\.html(?:$|[?#])/.test(window.webContents.getURL())
  )
}

const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-month-text-color-'))

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
  require(resolve('out', 'main', 'index.js'))
  const mainChunk = readdirSync(resolve('out', 'main', 'chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk, '未找到构建后的主进程分块')
  require(resolve('out', 'main', 'chunks', mainChunk))
  app.once('ready', () => void run())
} catch (error) {
  report(`setup failed: ${error?.stack || error}`)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}

async function run() {
  try {
    const window = await waitUntil(monthWindow, '月视图窗口没有创建')
    await waitUntil(
      () => window.webContents.executeJavaScript(`Boolean(document.querySelector('.month-grid'))`),
      '月视图没有渲染完成'
    )
    const noteId = await window.webContents.executeJavaScript(`(async () => {
      const note = await window.api.createNote({ content: '日历详情选色测试' })
      return note.id
    })()`)
    const barSelector = `.month-event-bar[data-note-id="${noteId}"]`
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(document.querySelector(${JSON.stringify(barSelector)}))`
        ),
      '新建便签没有出现在月历中'
    )
    await window.webContents.executeJavaScript(`(() => {
      const bar = document.querySelector(${JSON.stringify(barSelector)})
      const rect = bar.getBoundingClientRect()
      bar.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        detail: 1,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      }))
    })()`)
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-event-tooltip__content'))`
        ),
      '单击没有打开便签详情浮窗'
    )
    const selected = await window.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('.month-event-tooltip__content')
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const node = walker.nextNode()
      const range = document.createRange()
      range.setStart(node, 2)
      range.setEnd(node, 4)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
      return selection.toString()
    })()`)
    assert.equal(selected, '详情')
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(document.querySelector('.nl-text-color-popover'))`
        ),
      '详情浮窗选区没有打开颜色面板'
    )
    await window.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="设置文字颜色 #ff9500"]').click()`
    )
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(`window.api.getNote(${noteId}).then((note) =>
          note.content_color_ranges.some((range) => range.text === '详情' && range.color === '#ff9500')
        )`),
      '详情浮窗设置的颜色没有持久化'
    )
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('.month-event-tooltip__content span')).some(
            (span) => span.textContent === '详情' && span.style.color === 'rgb(255, 149, 0)'
          )`
        ),
      '详情浮窗没有立即显示已保存颜色'
    )
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll(${JSON.stringify(`${barSelector} .month-event-bar__text span`)})).some(
            (span) => span.textContent === '详情' && span.style.color === 'rgb(255, 149, 0)'
          )`
        ),
      '日期格内的便签横条没有显示局部文字颜色'
    )

    report('month/week event bar and shared detail popover selection coloring passed')
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
