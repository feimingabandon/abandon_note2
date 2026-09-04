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

async function titlebarMetrics(window) {
  return window.webContents.executeJavaScript(`(() => {
    const header = document.querySelector('.app-titlebar')
    const button = document.querySelector('.traffic-lights .light-close')
    const icon = button?.querySelector('.light-icon')
    return {
      headerHeight: header?.getBoundingClientRect().height ?? 0,
      buttonWidth: button?.getBoundingClientRect().width ?? 0,
      buttonHeight: button?.getBoundingClientRect().height ?? 0,
      iconWidth: icon?.getBoundingClientRect().width ?? 0,
      iconHeight: icon?.getBoundingClientRect().height ?? 0,
      microsoft: header?.classList.contains('app-titlebar--microsoft') ?? false,
      iconSources: Array.from(header?.querySelectorAll('img') || [], (image) => image.src)
    }
  })()`)
}

async function setSliderTo(window, key) {
  return window.webContents.executeJavaScript(`(() => {
    const item = Array.from(document.querySelectorAll('.settings-panel .setting-item')).find(
      (node) => node.querySelector('.setting-label')?.textContent.includes('导航栏图标大小')
    )
    const slider = item?.querySelector('[role="slider"]')
    if (!slider) return false
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }))
    return true
  })()`)
}

async function setIconColor(window, label) {
  return window.webContents.executeJavaScript(`(() => {
    const item = Array.from(document.querySelectorAll('.settings-panel .setting-item')).find(
      (node) => node.querySelector('.setting-label')?.textContent.includes('图标颜色')
    )
    const button = Array.from(item?.querySelectorAll('[role="radio"]') || []).find(
      (node) => node.textContent.trim() === '${label}'
    )
    if (!button) return false
    button.click()
    return true
  })()`)
}

const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-titlebar-icon-scale-e2e-'))
let exitCode = 0

async function runTitlebarIconScaleTest() {
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

    const appleInitial = await titlebarMetrics(listWindow)
    assert.equal(appleInitial.microsoft, false)
    assert.ok(appleInitial.iconSources.length > 0)
    assert.ok(
      appleInitial.iconSources.every(
        (source) => source.endsWith('.svg') || source.startsWith('data:image/svg+xml')
      ),
      `标题栏仍引用了非 SVG 图标：${JSON.stringify(appleInitial.iconSources)}`
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

    assert.equal(await setSliderTo(listWindow, 'End'), true, '没有找到导航栏图标大小滑块')
    await wait(260)
    const appleLarge = await titlebarMetrics(listWindow)
    assert.ok(appleLarge.buttonWidth > appleInitial.buttonWidth, 'Apple 圆形按钮没有随设置放大')
    assert.ok(appleLarge.iconWidth > appleInitial.iconWidth, 'Apple 图标没有随设置放大')
    assert.ok(
      Math.abs(appleLarge.headerHeight - appleInitial.headerHeight) < 0.1,
      'Apple 图标放大改变了导航栏高度'
    )

    assert.equal(await setSliderTo(listWindow, 'Home'), true)
    await listWindow.webContents.executeJavaScript(`(() => {
      const button = Array.from(document.querySelectorAll('.titlebar-style-selector button')).find(
        (node) => node.textContent.trim() === 'Microsoft'
      )
      button?.click()
    })()`)
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `document.querySelector('.app-titlebar')?.classList.contains('app-titlebar--microsoft')`
        ),
      '导航栏没有切换为 Microsoft 风格'
    )
    await wait(220)
    const microsoftInitial = await titlebarMetrics(listWindow)

    assert.equal(await setSliderTo(listWindow, 'End'), true)
    await wait(260)
    const microsoftLarge = await titlebarMetrics(listWindow)
    assert.ok(
      Math.abs(microsoftLarge.buttonWidth - microsoftInitial.buttonWidth) < 0.1 &&
        Math.abs(microsoftLarge.buttonHeight - microsoftInitial.buttonHeight) < 0.1,
      'Microsoft 按钮盒不应随图标设置变化'
    )
    assert.ok(
      microsoftLarge.iconWidth > microsoftInitial.iconWidth,
      'Microsoft 图标没有在固定按钮盒内放大'
    )

    const renderedIconNames = await listWindow.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[data-icon-name]'), (icon) => icon.dataset.iconName)`
    )
    assert.ok(
      renderedIconNames.includes('switch-view'),
      `列表主视图入口没有使用统一图标组件：${JSON.stringify(renderedIconNames)}`
    )
    assert.equal(await setIconColor(listWindow, '白色'), true, '没有找到图标颜色设置')
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `document.documentElement.getAttribute('data-icon-color') === 'white'`
        ),
      '图标颜色没有切换为白色'
    )
    assert.equal(
      await listWindow.webContents.executeJavaScript(`(() => {
        const icons = Array.from(document.querySelectorAll('[data-icon-name]'))
        return icons.every((icon) => {
          const black = icon.querySelector('.app-icon__asset--black')
          const white = icon.querySelector('.app-icon__asset--white')
          return getComputedStyle(black).display === 'none' && getComputedStyle(white).display !== 'none'
        })
      })()`),
      true,
      '不是所有当前渲染的图标都切换到了白色资源'
    )

    await wait(350)
    assert.equal(
      await listWindow.webContents.executeJavaScript(
        `window.api.getSettingsSnapshot().then((snapshot) => snapshot.values.appearance.titlebarIconScale)`
      ),
      150,
      '导航栏图标大小没有持久化到全局设置'
    )
    assert.equal(
      await listWindow.webContents.executeJavaScript(
        `window.api.getSettingsSnapshot().then((snapshot) => snapshot.values.appearance.iconColor)`
      ),
      'white',
      '图标颜色没有持久化到全局设置'
    )

    process.stderr.write('titlebar icon appearance integration passed\n')
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
  app.once('ready', () => void runTitlebarIconScaleTest())
} catch (error) {
  console.error(error)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}
