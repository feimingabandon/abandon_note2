import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'

const require = createRequire(import.meta.url)
const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-day-preview-status-'))

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

async function waitUntil(predicate, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(25)
  }
  throw new Error(message)
}

function seedMonthView() {
  mkdirSync(testUserData, { recursive: true })
  const database = new Database(join(testUserData, 'app.db'))
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
  insert.run('application', 'onboarding', 'first_use_notice_version', '1', now, now)
  insert.run('month', 'system', 'blur_enabled', 'false', now, now)
  database.close()
}

function monthWindow() {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && /\/month\.html(?:$|[?#])/.test(window.webContents.getURL())
  )
}

async function run() {
  try {
    const window = await waitUntil(monthWindow, '月视图没有启动')
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `[35, 42].includes(document.querySelectorAll('.month-day-cell').length)`
        ),
      '月历没有完成渲染'
    )

    const created = await window.webContents.executeJavaScript(
      `window.api.createNote({ content: '预览直接完成测试', durationDays: 1 })`
    )
    assert.ok(created?.id, '测试便签创建失败')
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-event-bar[data-note-id="${created.id}"]'))`
        ),
      '测试便签没有进入月历'
    )

    await window.webContents.executeJavaScript(`(() => {
      const today = new Date()
      const key = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-')
      const target = document.querySelector('.month-day-cell[data-date="' + key + '"] .month-day-cell__header')
      const rect = target.getBoundingClientRect()
      target.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 10,
        clientY: rect.top + 10
      }))
    })()`)
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-cell-context-menu-shell'))`
        ),
      '日期菜单没有打开'
    )
    await window.webContents.executeJavaScript(`(() => {
      const button = Array.from(document.querySelectorAll('.month-cell-context-menu button')).find(
        (item) => item.textContent.includes('预览当日全部便签')
      )
      button?.click()
    })()`)
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(Array.from(document.querySelectorAll('.month-day-preview__status-action')).find((button) => button.getAttribute('aria-label') === '标记完成：预览直接完成测试'))`
        ),
      '全天预览没有显示直接完成操作'
    )
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.month-day-preview__status-action')).find((button) => button.getAttribute('aria-label') === '标记完成：预览直接完成测试').click()`
    )
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `document.querySelector('.month-event-bar[data-note-id="${created.id}"]')?.classList.contains('is-completed')`
        ),
      '预览窗操作没有将便签标记完成'
    )
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('.month-day-preview__status-action')).some((button) => button.getAttribute('aria-label') === '重新进行：预览直接完成测试' && !button.disabled)`
        ),
      '完成后预览窗没有同步为重新进行'
    )

    process.stderr.write('month day preview direct status action passed\n')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
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
  seedMonthView()
  require(resolve('out', 'main', 'index.js'))
  const mainChunk = readdirSync(resolve('out', 'main', 'chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk, '未找到构建后的主进程分块')
  require(resolve('out', 'main', 'chunks', mainChunk))
  app.once('ready', () => void run())
} catch (error) {
  console.error(error)
  app.exit(1)
}

app.on('will-quit', () => {
  try {
    rmSync(testUserData, { recursive: true, force: true })
  } catch {
    // Electron 退出时可能仍短暂占用隔离目录。
  }
})
