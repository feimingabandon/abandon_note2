import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'

const require = createRequire(import.meta.url)
const WAIT_STEP_MS = 25

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

async function waitUntil(predicate, message, timeoutMs = 5000) {
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
  insert.run('application', 'shortcuts', 'view_visibility', 'Control+Alt+F10', now, now)
  insert.run('main', 'system', 'blur_enabled', 'false', now, now)
  db.close()
}

function getListWindow() {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && /\/index\.html(?:$|[?#])/.test(window.webContents.getURL())
  )
}

async function shortcutSnapshot(window) {
  return window.webContents
    .executeJavaScript(`window.api.getSettingsSnapshot().then((snapshot) => ({
    value: snapshot.values.shortcuts.viewVisibility,
    runtime: snapshot.runtime.shortcuts.viewVisibility
  }))`)
}

const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-view-shortcut-e2e-'))
let exitCode = 0

async function runViewVisibilityShortcutTest() {
  try {
    const listWindow = await waitUntil(() => getListWindow(), '列表主窗口没有按隔离设置启动', 10000)
    await waitUntil(() => listWindow.isVisible(), '列表主窗口渲染就绪后没有显示')
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.titlebar-btn-settings[title="设置"]'))`
        ),
      '列表导航栏没有设置入口'
    )

    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.titlebar-btn-settings[title="设置"]').click()`
    )
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.settings-panel.active .shortcut-recorder'))`
        ),
      '设置面板没有显示视图快捷键录制器'
    )

    assert.deepEqual(await shortcutSnapshot(listWindow), {
      value: 'Control+Alt+F10',
      runtime: {
        configured: 'Control+Alt+F10',
        registered: true,
        capturing: false,
        error: null
      }
    })

    await listWindow.webContents.executeJavaScript(`(() => {
      const recorder = document.querySelector('.shortcut-recorder')
      const clearButton = Array.from(recorder.querySelectorAll('button')).find(
        (button) => button.textContent.trim() === '清除'
      )
      clearButton?.click()
    })()`)
    await waitUntil(async () => {
      const snapshot = await shortcutSnapshot(listWindow)
      return snapshot.value === '' && !snapshot.runtime.registered
    }, '启动时恢复的快捷键没有清除')

    const recorded = await listWindow.webContents.executeJavaScript(`(() => {
      const recorder = document.querySelector('.shortcut-recorder')
      const recordButton = Array.from(recorder.querySelectorAll('button')).find(
        (button) => button.textContent.trim() === '录制'
      )
      recordButton?.click()
      return Boolean(recordButton)
    })()`)
    assert.equal(recorded, true, '没有找到录制按钮')
    await waitUntil(
      async () => (await shortcutSnapshot(listWindow)).runtime.capturing,
      '录制按钮没有进入录制状态'
    )
    await listWindow.webContents
      .executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'F11',
        code: 'F11',
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true
      }))`)

    await waitUntil(async () => {
      const snapshot = await shortcutSnapshot(listWindow)
      return snapshot.value === 'Control+Alt+F11' && snapshot.runtime.registered
    }, '快捷键没有自动保存并注册')
    assert.equal(
      await listWindow.webContents.executeJavaScript(
        `document.querySelector('.shortcut-recorder-field')?.value`
      ),
      'Ctrl + Alt + F11'
    )

    await listWindow.webContents.executeJavaScript(`(() => {
      const recorder = document.querySelector('.shortcut-recorder')
      const button = Array.from(recorder.querySelectorAll('button')).find(
        (candidate) => candidate.textContent.trim() === '重新录制'
      )
      button?.click()
    })()`)
    await waitUntil(
      async () => (await shortcutSnapshot(listWindow)).runtime.capturing,
      '重新录制没有进入录制状态'
    )
    globalThis.__ABANDON_COMPACT_TEST_HOOKS__.triggerViewVisibilityShortcut()
    await wait(120)
    assert.equal(listWindow.isVisible(), true, '录制期间旧快捷键不应隐藏设置窗口')

    await listWindow.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    )
    await waitUntil(
      async () => !(await shortcutSnapshot(listWindow)).runtime.capturing,
      'Esc 没有取消快捷键录制'
    )

    globalThis.__ABANDON_COMPACT_TEST_HOOKS__.triggerViewVisibilityShortcut()
    await waitUntil(() => !listWindow.isVisible(), '快捷键回调没有把当前视图隐藏到托盘')
    globalThis.__ABANDON_COMPACT_TEST_HOOKS__.triggerViewVisibilityShortcut()
    await waitUntil(() => listWindow.isVisible(), '快捷键回调没有从托盘恢复当前视图')

    await listWindow.webContents.executeJavaScript(`(() => {
      const recorder = document.querySelector('.shortcut-recorder')
      const clearButton = Array.from(recorder.querySelectorAll('button')).find(
        (button) => button.textContent.trim() === '清除'
      )
      clearButton?.click()
    })()`)
    await waitUntil(async () => {
      const snapshot = await shortcutSnapshot(listWindow)
      return snapshot.value === '' && !snapshot.runtime.registered
    }, '快捷键没有清除')

    process.stderr.write('view visibility shortcut integration passed\n')
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
        // Crashpad 可能在进程退出前短暂占用隔离目录，不覆盖真实测试结果。
      }
      process.exit(exitCode)
    })
    app.quit()
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
  seedListView(testUserData)

  require(resolve('out', 'main', 'index.js'))
  const mainChunk = readdirSync(resolve('out', 'main', 'chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk, '未找到构建后的主进程分块')
  require(resolve('out', 'main', 'chunks', mainChunk))
  app.once('ready', () => void runViewVisibilityShortcutTest())
} catch (error) {
  console.error(error)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}
