import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'

const require = createRequire(import.meta.url)
const WAIT_STEP_MS = 25
const RESPONSIVE_TEST_WIDTH = 256

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

function isCloseTo(actual, expected, tolerance = 0.1) {
  return Math.abs(actual - expected) < tolerance
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
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 0
    return {
      headerHeight: header?.getBoundingClientRect().height ?? 0,
      buttonWidth: button?.getBoundingClientRect().width ?? 0,
      buttonHeight: button?.getBoundingClientRect().height ?? 0,
      iconWidth: icon?.getBoundingClientRect().width ?? 0,
      iconHeight: icon?.getBoundingClientRect().height ?? 0,
      rootFontSize,
      microsoft: header?.classList.contains('app-titlebar--microsoft') ?? false,
      iconSources: Array.from(header?.querySelectorAll('img') || [], (image) => image.src)
    }
  })()`)
}

async function titlebarScaleState(window) {
  return window.webContents.executeJavaScript(`(() => {
    const item = Array.from(document.querySelectorAll('.settings-panel .setting-item')).find(
      (node) => node.querySelector('.setting-label')?.textContent.includes('导航图标大小')
    )
    const slider = item?.querySelector('[role="slider"]')
    const rootStyle = document.documentElement.style
    return {
      sliderValue: Number(slider?.getAttribute('aria-valuenow')),
      appleControlSize: rootStyle.getPropertyValue('--titlebar-apple-control-size').trim(),
      appleIconSize: rootStyle.getPropertyValue('--titlebar-apple-icon-size').trim(),
      microsoftIconSize: rootStyle.getPropertyValue('--titlebar-microsoft-icon-size').trim(),
      calendarToolbarIconSize: rootStyle.getPropertyValue('--calendar-toolbar-icon-size').trim()
    }
  })()`)
}

async function waitForTitlebarScale(window, expectedValue, message) {
  const scale = expectedValue / 100
  const expected = {
    sliderValue: expectedValue,
    appleControlSize: `${18 * scale}rem`,
    appleIconSize: `${14 * scale}rem`,
    microsoftIconSize: `${15 * scale}rem`,
    calendarToolbarIconSize: `${17 * scale}rem`
  }
  let latest = null
  try {
    return await waitUntil(
      async () => {
        latest = await titlebarScaleState(window)
        return Object.entries(expected).every(([key, value]) => latest[key] === value)
          ? latest
          : false
      },
      message,
      10000
    )
  } catch (error) {
    throw new Error(
      `${message}: expected=${JSON.stringify(expected)}, latest=${JSON.stringify(latest)}`,
      { cause: error }
    )
  }
}

async function waitForTitlebarMetrics(window, predicate, message, initial) {
  let latest = null
  try {
    return await waitUntil(
      async () => {
        latest = await titlebarMetrics(window)
        return predicate(latest) ? latest : false
      },
      message,
      10000
    )
  } catch (error) {
    throw new Error(
      `${message}: initial=${JSON.stringify(initial)}, latest=${JSON.stringify(latest)}`,
      { cause: error }
    )
  }
}

async function setSliderTo(window, key) {
  return window.webContents.executeJavaScript(`(() => {
    const item = Array.from(document.querySelectorAll('.settings-panel .setting-item')).find(
      (node) => node.querySelector('.setting-label')?.textContent.includes('导航图标大小')
    )
    const slider = item?.querySelector('[role="slider"]')
    if (!slider) return false
    slider.focus()
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
    const [, initialWindowHeight] = listWindow.getSize()
    listWindow.setSize(RESPONSIVE_TEST_WIDTH, initialWindowHeight)
    await waitUntil(
      () => listWindow.getContentBounds().width === RESPONSIVE_TEST_WIDTH,
      '列表窗口没有进入响应式缩放测试宽度'
    )

    const appleInitial = await waitForTitlebarMetrics(
      listWindow,
      (metrics) =>
        isCloseTo(metrics.buttonWidth, 18 * metrics.rootFontSize) &&
        isCloseTo(metrics.buttonHeight, 18 * metrics.rootFontSize) &&
        isCloseTo(metrics.iconWidth, 14 * metrics.rootFontSize) &&
        isCloseTo(metrics.iconHeight, 14 * metrics.rootFontSize),
      'Apple 100% 响应式尺寸没有完成窗口缩放过渡',
      null
    )
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

    assert.equal(await setSliderTo(listWindow, 'End'), true, '没有找到导航图标大小滑块')
    await waitForTitlebarScale(listWindow, 150, 'Apple 放大设置没有完整应用')
    const appleLarge = await waitForTitlebarMetrics(
      listWindow,
      (metrics) =>
        isCloseTo(metrics.buttonWidth, 27 * metrics.rootFontSize) &&
        isCloseTo(metrics.buttonHeight, 27 * metrics.rootFontSize) &&
        isCloseTo(metrics.iconWidth, 21 * metrics.rootFontSize) &&
        isCloseTo(metrics.iconHeight, 21 * metrics.rootFontSize),
      'Apple 圆形按钮或图标没有随设置放大',
      appleInitial
    )
    assert.ok(
      Math.abs(appleLarge.headerHeight - appleInitial.headerHeight) < 0.1,
      'Apple 图标放大改变了导航栏高度'
    )

    assert.equal(await setSliderTo(listWindow, 'Home'), true)
    await waitForTitlebarScale(listWindow, 100, '导航图标大小没有恢复到 100%')
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
    const microsoftInitial = await waitForTitlebarMetrics(
      listWindow,
      (metrics) =>
        isCloseTo(metrics.buttonWidth, 32 * metrics.rootFontSize) &&
        isCloseTo(metrics.buttonHeight, 30 * metrics.rootFontSize) &&
        isCloseTo(metrics.iconWidth, 15 * metrics.rootFontSize) &&
        isCloseTo(metrics.iconHeight, 15 * metrics.rootFontSize),
      'Microsoft 固定按钮盒没有完成样式过渡',
      appleLarge
    )

    assert.equal(await setSliderTo(listWindow, 'End'), true)
    await waitForTitlebarScale(listWindow, 150, 'Microsoft 放大设置没有完整应用')
    const microsoftLarge = await waitForTitlebarMetrics(
      listWindow,
      (metrics) =>
        isCloseTo(metrics.buttonWidth, 32 * metrics.rootFontSize) &&
        isCloseTo(metrics.buttonHeight, 30 * metrics.rootFontSize) &&
        isCloseTo(metrics.iconWidth, 22.5 * metrics.rootFontSize) &&
        isCloseTo(metrics.iconHeight, 22.5 * metrics.rootFontSize),
      'Microsoft 图标没有在固定按钮盒内放大',
      microsoftInitial
    )
    assert.ok(
      Math.abs(microsoftLarge.buttonWidth - microsoftInitial.buttonWidth) < 0.1 &&
        Math.abs(microsoftLarge.buttonHeight - microsoftInitial.buttonHeight) < 0.1,
      `Microsoft 按钮盒不应随图标设置变化：initial=${JSON.stringify(microsoftInitial)}, large=${JSON.stringify(microsoftLarge)}`
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
      '导航图标大小没有持久化到全局设置'
    )
    assert.equal(
      await listWindow.webContents.executeJavaScript(
        `window.api.getSettingsSnapshot().then((snapshot) => snapshot.values.appearance.iconColor)`
      ),
      'white',
      '图标颜色没有持久化到全局设置'
    )

    await listWindow.webContents.executeJavaScript(`(() => {
      const button = Array.from(document.querySelectorAll('.settings-panel button')).find(
        (candidate) => candidate.textContent.trim() === '恢复默认设置'
      )
      button?.click()
    })()`)
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.confirm-card.active[aria-label="恢复默认设置"]'))`
        ),
      '恢复默认确认弹窗没有打开'
    )
    await listWindow.webContents.executeJavaScript(`(() => {
      const button = Array.from(document.querySelectorAll('.confirm-card.active button')).find(
        (candidate) => candidate.textContent.trim() === '恢复'
      )
      button?.click()
    })()`)
    await waitForTitlebarScale(listWindow, 100, '恢复默认没有重置导航图标大小')
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `document.documentElement.getAttribute('data-icon-color') === 'black'`
        ),
      '恢复默认没有重置图标颜色'
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
