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
  insert.run('main', 'system', 'blur_enabled', 'false', now, now)
  db.close()
}

function getListWindow() {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && /\/index\.html(?:$|[?#])/.test(window.webContents.getURL())
  )
}

const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-window-border-e2e-'))
let exitCode = 0

async function runWindowBorderTest() {
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
          `Boolean(document.querySelector('.settings-panel.active'))`
        ),
      '列表设置面板没有打开'
    )

    const initial = await listWindow.webContents.executeJavaScript(`(() => {
      const item = Array.from(document.querySelectorAll('.settings-panel .setting-item')).find(
        (node) => node.querySelector('.setting-label')?.textContent.includes('窗口边框')
      )
      return {
        found: Boolean(item),
        enabled: item?.querySelector('.switch')?.classList.contains('on') ?? null,
        cssWidth: getComputedStyle(document.documentElement).getPropertyValue('--window-border-width').trim(),
        renderedWidth: getComputedStyle(document.querySelector('.app-root'), '::after').borderTopWidth
      }
    })()`)
    assert.equal(initial.found, true, '基础样式中缺少窗口边框开关')
    assert.equal(initial.enabled, false, '窗口边框必须默认关闭')
    assert.equal(initial.cssWidth, '0px')
    assert.equal(initial.renderedWidth, '0px')

    await listWindow.webContents.executeJavaScript(`(() => {
      const item = Array.from(document.querySelectorAll('.settings-panel .setting-item')).find(
        (node) => node.querySelector('.setting-label')?.textContent.includes('窗口边框')
      )
      item.querySelector('.switch').click()
    })()`)
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `getComputedStyle(document.querySelector('.app-root'), '::after').borderTopWidth === '1px'`
        ),
      '开启窗口边框后没有立即绘制 1px 内侧边线'
    )
    await wait(350)
    assert.equal(
      await listWindow.webContents.executeJavaScript(
        `window.api.getSettingsSnapshot().then((snapshot) => snapshot.values.css.windowBorder)`
      ),
      true,
      '窗口边框开启状态没有持久化到列表视图'
    )

    await listWindow.webContents.executeJavaScript(`(() => {
      const item = Array.from(document.querySelectorAll('.settings-panel .setting-item')).find(
        (node) => node.querySelector('.setting-label')?.textContent.includes('窗口边框')
      )
      item.querySelector('.switch').click()
    })()`)
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `getComputedStyle(document.querySelector('.app-root'), '::after').borderTopWidth === '0px'`
        ),
      '关闭窗口边框后没有移除内侧边线'
    )
    await wait(350)
    assert.equal(
      await listWindow.webContents.executeJavaScript(
        `window.api.getSettingsSnapshot().then((snapshot) => snapshot.values.css.windowBorder)`
      ),
      false,
      '窗口边框关闭状态没有持久化到列表视图'
    )

    process.stderr.write('window border integration passed\n')
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
  app.once('ready', () => void runWindowBorderTest())
} catch (error) {
  console.error(error)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}
