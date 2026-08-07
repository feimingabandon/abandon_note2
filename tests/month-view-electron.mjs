import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, screen } from 'electron'
import koffi from 'koffi'

const WAIT_STEP_MS = 25
const require = createRequire(import.meta.url)
const report = (message) => process.stderr.write(`[month-e2e] ${message}\n`)

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
  // 集成测试不访问远程服务，也不创建启用状态的 BlurOverlay。
  insert.run('application', 'remote', 'receive_notices', 'false', now, now)
  insert.run('application', 'remote', 'upload_device_info', 'false', now, now)
  insert.run('month', 'system', 'blur_enabled', 'false', now, now)
  db.close()
}

function getMonthWindow() {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && /\/month\.html(?:$|[?#])/.test(window.webContents.getURL())
  )
}

const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-month-e2e-'))
let exitCode = 0
let originalCursor = null

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

  // bootstrap 使用异步 require 加载构建分块。测试需要在同一主进程里立即进入
  // 真实初始化代码，所以先加载 bootstrap，再同步加载其唯一主进程分块；异步任务
  // 随后再次 require 时会命中 CommonJS 缓存，不会重复初始化。
  require(resolve('out', 'main', 'index.js'))
  report('loaded built bootstrap')
  const mainChunk = readdirSync(resolve('out', 'main', 'chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk, '未找到构建后的主进程分块')
  require(resolve('out', 'main', 'chunks', mainChunk))
  report('loaded built main chunk')
  // Electron 会等入口模块求值结束后才发 ready；不能在顶层 await app.whenReady()，
  // 否则 ESM 顶层等待与 ready 事件会互相阻塞。
  app.once('ready', () => void runMonthViewTests())
} catch (error) {
  report(`setup failed: ${error?.stack || error}`)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}

async function runMonthViewTests() {
  try {
    report('electron app ready')

    const monthWindow = await waitUntil(
      () => getMonthWindow(),
      '月视图主窗口未按持久化的 active_view 启动',
      10000
    )
    report('month window created')
    await waitUntil(() => monthWindow.isVisible(), '月视图渲染就绪后没有显示')

    const display = screen.getDisplayMatching(monthWindow.getBounds())
    const workArea = display.workArea
    const expectedBounds = {
      x: workArea.x + Math.round((workArea.width - Math.round(workArea.width * 0.7)) / 2),
      y: workArea.y + Math.round((workArea.height - Math.round(workArea.height * 0.7)) / 2),
      width: Math.round(workArea.width * 0.7),
      height: Math.round(workArea.height * 0.7)
    }
    assert.deepEqual(
      monthWindow.getBounds(),
      expectedBounds,
      '月视图首次窗口必须为工作区 70% 并居中'
    )

    const initialUi = await monthWindow.webContents.executeJavaScript(`(() => ({
    title: document.querySelector('.app-titlebar-title')?.textContent?.trim(),
    emptyContentChildren: document.querySelector('.month-content')?.children.length,
    settingsButton: Boolean(document.querySelector('.month-titlebar-btn[title="设置"]')),
    helpDisabled: document.querySelector('.month-titlebar-btn[aria-disabled="true"]')?.getAttribute('title'),
    templateButton: Array.from(document.querySelectorAll('button')).some((button) =>
      /模板|循环/.test(button.title || button.textContent || '')
    ),
    controlCount: document.querySelectorAll('.traffic-lights .light').length
  }))()`)
    assert.equal(initialUi.title, '月视图')
    assert.equal(initialUi.emptyContentChildren, 0, '月视图主体在本阶段应保持为空')
    assert.equal(initialUi.settingsButton, true)
    assert.match(initialUi.helpDisabled || '', /暂未开放/)
    assert.equal(initialUi.templateButton, false, '月视图导航栏不应包含模板按钮')
    assert.equal(initialUi.controlCount, 3, '月视图应复用关闭、置顶、锁定三个窗口控制')

    const appleTitlebar = await monthWindow.webContents.executeJavaScript(`(() => {
    const titlebar = document.querySelector('.app-titlebar')
    const group = document.querySelector('.titlebar-actions-group')
    const settings = document.querySelector('.month-titlebar-btn[title="设置"]')
    const help = document.querySelector('.month-titlebar-btn[aria-disabled="true"]')
    const settingsRect = settings.getBoundingClientRect()
    const helpRect = help.getBoundingClientRect()
    return {
      titlebarClass: titlebar.className,
      groupClass: group.className,
      settingsLeft: settingsRect.left,
      helpLeft: helpRect.left,
      settingsWidth: settingsRect.width,
      settingsHeight: settingsRect.height,
      settingsRadius: getComputedStyle(settings).borderRadius,
      settingsBackground: getComputedStyle(settings).backgroundColor
    }
  })()`)
    assert.match(appleTitlebar.titlebarClass, /app-titlebar--apple/)
    assert.match(appleTitlebar.groupClass, /titlebar-actions-group--apple/)
    assert.ok(
      Math.abs(appleTitlebar.settingsWidth - appleTitlebar.settingsHeight) < 0.1,
      'Apple 风格的月视图业务按钮必须为圆形'
    )
    assert.equal(appleTitlebar.settingsRadius, '50%')
    assert.equal(appleTitlebar.settingsBackground, 'rgb(0, 113, 227)')
    assert.ok(
      appleTitlebar.settingsLeft < appleTitlebar.helpLeft,
      'Apple 风格应保持设置、帮助的 DOM 顺序'
    )

    await monthWindow.webContents.executeJavaScript(
      `window.api.setSettingValue('appearance.titlebarStyle', 'microsoft')`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.app-titlebar')?.classList.contains('app-titlebar--microsoft')`
        ),
      '月视图没有切换到 Microsoft 导航栏风格'
    )
    await wait(250)
    const microsoftTitlebar = await monthWindow.webContents.executeJavaScript(`(() => {
    const title = document.querySelector('.app-titlebar-title').getBoundingClientRect()
    const group = document.querySelector('.titlebar-actions-group')
    const settings = document.querySelector('.month-titlebar-btn[title="设置"]')
    const help = document.querySelector('.month-titlebar-btn[aria-disabled="true"]')
    const icon = settings.querySelector('.btn-icon')
    const settingsRect = settings.getBoundingClientRect()
    return {
      groupClass: group.className,
      titleCenter: title.left + title.width / 2,
      viewportCenter: window.innerWidth / 2,
      settingsLeft: settingsRect.left,
      helpLeft: help.getBoundingClientRect().left,
      settingsWidth: settingsRect.width,
      settingsHeight: settingsRect.height,
      settingsBackground: getComputedStyle(settings).backgroundColor,
      iconOpacity: getComputedStyle(icon).opacity
    }
  })()`)
    assert.match(microsoftTitlebar.groupClass, /titlebar-actions-group--microsoft/)
    assert.ok(
      Math.abs(microsoftTitlebar.titleCenter - microsoftTitlebar.viewportCenter) < 0.5,
      'Microsoft 风格的月视图标题必须相对窗口真正居中'
    )
    assert.ok(
      microsoftTitlebar.settingsWidth > microsoftTitlebar.settingsHeight,
      'Microsoft 风格的月视图业务按钮必须使用 Fluent 矩形尺寸'
    )
    assert.equal(microsoftTitlebar.settingsBackground, 'rgba(0, 0, 0, 0)')
    assert.equal(microsoftTitlebar.iconOpacity, '0.72')
    assert.ok(
      microsoftTitlebar.settingsLeft < microsoftTitlebar.helpLeft,
      'Microsoft 风格不得反转设置和帮助按钮的顺序'
    )

    await monthWindow.webContents.executeJavaScript(
      `window.api.setSettingValue('appearance.titlebarStyle', 'apple')`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.app-titlebar')?.classList.contains('app-titlebar--apple')`
        ),
      '月视图没有恢复 Apple 导航栏风格'
    )

    assert.equal(monthWindow.isAlwaysOnTop(), true, '月视图应恢复默认置顶状态')
    await monthWindow.webContents.executeJavaScript(`document.querySelector('.light-pin').click()`)
    await waitUntil(() => !monthWindow.isAlwaysOnTop(), '月视图取消置顶没有生效')
    await monthWindow.webContents.executeJavaScript(`document.querySelector('.light-pin').click()`)
    await waitUntil(() => monthWindow.isAlwaysOnTop(), '月视图置顶按钮没有作用于月视图窗口')

    await monthWindow.webContents.executeJavaScript(`document.querySelector('.light-lock').click()`)
    await waitUntil(() => !monthWindow.isMovable(), '月视图锁定按钮没有禁用窗口移动')
    await monthWindow.webContents.executeJavaScript(`document.querySelector('.light-lock').click()`)
    await waitUntil(() => monthWindow.isMovable(), '月视图解锁按钮没有恢复窗口移动')

    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-titlebar-btn[title="设置"]').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.settings-panel--month.active'))`
        ),
      '月视图设置面板没有从右侧打开'
    )
    await wait(400)
    const settingsUi = await monthWindow.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.settings-panel--month')
    const rect = panel.getBoundingClientRect()
    const sectionTitles = Array.from(panel.querySelectorAll('.section-title'), (node) =>
      node.textContent.replace(/\\s+/g, ' ').trim()
    )
    return {
      widthRatio: rect.width / window.innerWidth,
      rightGap: window.innerWidth - rect.right,
      heightRatio: rect.height / window.innerHeight,
      resizeCursor: getComputedStyle(panel.querySelector('.drag-indicator')).cursor,
      sectionTitles,
      text: panel.textContent
    }
  })()`)
    assert.ok(Math.abs(settingsUi.widthRatio - 0.4) < 0.01, '月视图设置面板默认宽度必须为 40%')
    assert.ok(Math.abs(settingsUi.rightGap) < 1, '月视图设置面板必须贴住窗口右边缘')
    assert.ok(Math.abs(settingsUi.heightRatio - 1) < 0.01, '月视图设置面板必须占满窗口高度')
    assert.equal(settingsUi.resizeCursor, 'ew-resize', '月视图设置面板左边缘必须支持横向调宽')
    for (const title of [
      '基础样式',
      '窗口模糊玻璃与外观',
      'CSS 玻璃全局基准',
      '系统设置',
      '远程服务与隐私',
      '关于',
      '调度器诊断'
    ]) {
      assert.ok(
        settingsUi.sectionTitles.some((actualTitle) => actualTitle.startsWith(title)),
        `月视图设置缺少“${title}”板块`
      )
    }
    assert.equal(
      settingsUi.sectionTitles.includes('便利贴'),
      false,
      '月视图设置不应显示列表便签外观'
    )
    assert.match(settingsUi.text, /设置主页面壁纸/, '月视图必须保留独立壁纸设置')
    assert.match(settingsUi.text, /查看全部通知/)
    assert.match(settingsUi.text, /恢复默认设置/)
    assert.match(settingsUi.text, /清空便签数据/)

    // 关闭设置，避免其全屏 Teleport 层影响后续窗口鼠标离开验证。
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.settings-panel--month .panel-close-btn').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `!document.querySelector('.settings-panel--month')`
        ),
      '月视图设置面板没有完成关闭动画'
    )

    const user32 = koffi.load('user32.dll')
    const setCursorPos = user32.func('int SetCursorPos(int X, int Y)')
    const nativeDll = koffi.load(resolve('native_blur', 'build', 'bin', 'blur_engine.dll'))
    const getEdgeStatusJson = nativeDll.func('WindowMotion_GetEdgeMonitorStatusJson', 'str', [])
    const getEdgeStatus = () => JSON.parse(getEdgeStatusJson())
    originalCursor = screen.getCursorScreenPoint()
    assert.equal(setCursorPos(workArea.x + workArea.width - 2, workArea.y + workArea.height - 2), 1)

    monthWindow.setPosition(expectedBounds.x, workArea.y + 10)
    await waitUntil(
      () => monthWindow.getBounds().y === workArea.y,
      '月视图移入顶端 20px 阈值后没有吸附到工作区顶端'
    )
    await monthWindow.webContents.executeJavaScript(`window.api.windowHover(false)`)
    await waitUntil(
      () => monthWindow.getBounds().y + monthWindow.getBounds().height <= workArea.y,
      '月视图没有完整滑出工作区顶部'
    )
    const armedStatus = await waitUntil(() => {
      const status = getEdgeStatus()
      return status.workerAlive && ['armed', 'waiting-outside'].includes(status.state) && status
    }, '月视图顶部贴边后没有启动原生边缘监视器')
    assert.equal(armedStatus.side, -2, '月视图必须使用 DLL 顶部监视器')
    assert.equal(armedStatus.pollIntervalMs, 100, '月视图原生鼠标检测周期必须为 100ms')
    assert.equal(
      BrowserWindow.getAllWindows().filter((window) => window !== monthWindow).length,
      0,
      'Windows 原生贴边隐藏不得创建 Electron 触发窗口'
    )

    const topTriggerX = expectedBounds.x + Math.floor(expectedBounds.width / 2)
    assert.equal(setCursorPos(topTriggerX, workArea.y), 1)
    await waitUntil(
      () => monthWindow.getBounds().y === workArea.y,
      'DLL 没有在真实鼠标触顶后将月视图滑回可见位置'
    )
    await waitUntil(() => getEdgeStatus().state === 'stopped', '月视图恢复后没有停止原生边缘监视器')

    // 月视图配置只允许 top。靠近底部并离开鼠标后，不得再次创建触发条或滑出屏幕。
    const bottomY = workArea.y + workArea.height - expectedBounds.height
    monthWindow.setPosition(expectedBounds.x, bottomY)
    await wait(300)
    await monthWindow.webContents.executeJavaScript(`window.api.windowHover(false)`)
    await wait(700)
    assert.equal(getEdgeStatus().state, 'stopped', '月视图底部不得启动原生边缘监视器')
    assert.equal(monthWindow.getBounds().y, bottomY, '月视图底部不得自动隐藏')

    report(
      'month view application integration test passed: startup, geometry, navbar, settings, native top dock and bottom exclusion'
    )
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    if (originalCursor) {
      try {
        const user32 = koffi.load('user32.dll')
        const setCursorPos = user32.func('int SetCursorPos(int X, int Y)')
        setCursorPos(originalCursor.x, originalCursor.y)
      } catch {
        exitCode = 1
      }
    }
    process.exitCode = exitCode
    app.releaseSingleInstanceLock()
    app.once('quit', () => {
      try {
        rmSync(testUserData, { recursive: true, force: true })
      } catch {
        // Crashpad 可能直到进程完全退出才释放最后一个句柄；测试结果不应被临时目录清理覆盖。
      }
      process.exit(exitCode)
    })
    app.quit()
  }
}
