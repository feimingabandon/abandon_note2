import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'
import koffi from 'koffi'
import { NATIVE_ABI_VERSION } from '../src/shared/native-abi-version.js'

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('in-process-gpu')

const require = createRequire(import.meta.url)
const requestedView = ['list', 'month', 'week'].includes(process.argv[2]) ? process.argv[2] : 'list'
const notificationLaunch = process.argv.includes('notification')
const viewConfig = {
  list: { scope: 'main', rendererFile: 'index.html', root: '.app-root' },
  month: { scope: 'month', rendererFile: 'month.html', root: '.month-root' },
  week: { scope: 'week', rendererFile: 'week.html', root: '.month-root' }
}[requestedView]
const nativeDllPath =
  process.env.ABANDON_INTEGRATION_NATIVE_DLL ||
  resolve('native_blur', 'build', 'bin', 'blur_engine.dll')

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

async function waitUntil(predicate, message, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(16)
  }
  throw new Error(message)
}

function report(message) {
  try {
    process.stderr.write(message + '\n')
  } catch {
    // 测试进程退出期间日志管道可能已关闭。
  }
}

function seedSettings(userDataPath) {
  mkdirSync(userDataPath, { recursive: true })
  const db = new Database(join(userDataPath, 'app.db'))
  db.exec(
    'CREATE TABLE app_settings (' +
      'window_name TEXT NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, value TEXT, ' +
      "remark TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER, " +
      'PRIMARY KEY (window_name, key));'
  )
  const insert = db.prepare(
    'INSERT INTO app_settings ' +
      "(window_name, type, key, value, remark, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, ?)"
  )
  const now = Date.now()
  const rows = [
    ['application', 'application', 'active_view', requestedView],
    ['application', 'remote', 'receive_notices', 'false'],
    ['application', 'remote', 'upload_device_info', 'false'],
    ['application', 'onboarding', 'first_use_notice_version', '1'],
    ['application', 'system', 'lock_state', 'true'],
    ['application', 'system', 'z_order_mode', 'normal'],
    ['application', 'compact', 'enabled', 'true'],
    ['application', 'compact', 'x', '130'],
    ['application', 'compact', 'y', '140'],
    ['application', 'compact', 'width', '360'],
    ['application', 'compact', 'height', '76'],
    [viewConfig.scope, 'css', 'bg_color', '32 33 36'],
    [viewConfig.scope, 'css', 'text_color', '#f1f3f4'],
    [viewConfig.scope, 'css', 'window_opacity', '0.72'],
    [viewConfig.scope, 'system', 'blur_enabled', requestedView === 'list' ? 'true' : 'false']
  ]
  for (const row of rows) insert.run(...row, now, now)
  db.close()
}

function getMainWindow(rendererFile = viewConfig.rendererFile) {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && window.webContents.getURL().includes('/' + rendererFile)
  )
}

async function readState(window) {
  return window.webContents.executeJavaScript('window.api.getCompactWindowState()')
}

function assertBoundsEqual(actual, expected, label) {
  assert.deepEqual(actual, expected, label + ' 修改了 BrowserWindow carrier 边界')
}

async function readPresentationDom(window) {
  const rootSelector = JSON.stringify(viewConfig.root)
  return window.webContents.executeJavaScript(
    '(() => {' +
      'const root = document.querySelector(' +
      rootSelector +
      ');' +
      "const expanded = document.querySelector('.compact-presentation-layer--expanded');" +
      "const compact = document.querySelector('.compact-presentation-layer--compact');" +
      'const compactRect = compact?.getBoundingClientRect();' +
      'return {' +
      'viewport:{width:window.innerWidth,height:window.innerHeight},' +
      "rootClipPath:root?getComputedStyle(root).clipPath:''," +
      'expandedOpacity:expanded?getComputedStyle(expanded).opacity:null,' +
      'expandedVisibility:expanded?getComputedStyle(expanded).visibility:null,' +
      'compactOpacity:compact?getComputedStyle(compact).opacity:null,' +
      'compactVisibility:compact?getComputedStyle(compact).visibility:null,' +
      'compactRect:compactRect?{x:compactRect.x,y:compactRect.y,width:compactRect.width,height:compactRect.height}:null' +
      '};})()'
  )
}

async function runTransition(window, method, targetMode, shapeCalls, options = {}) {
  const carrier = window.getBounds()
  if (options.breakAnimation) {
    await window.webContents.executeJavaScript(
      'window.__compactOriginalAnimate=Element.prototype.animate;' +
        "Element.prototype.animate=()=>{throw new Error('injected renderer animation failure')};true"
    )
  }

  await window.webContents.executeJavaScript('void window.api.' + method + 'CompactWindow(); true')
  const observed = await waitUntil(async () => {
    const state = await readState(window)
    if (state.transition?.to === targetMode) return state
    return !state.transition && state.mode === targetMode ? state : null
  }, method + ' 没有进入或收口到目标 presentation 状态')
  if (!options.breakAnimation) {
    assert.equal(observed.transition?.to, targetMode, method + ' 没有创建 presentation transaction')
  }
  assert.equal(observed.presentation.carrier.width, carrier.width)
  assert.equal(observed.presentation.carrier.height, carrier.height)
  assertBoundsEqual(window.getBounds(), carrier, method + ' 动画开始')

  let sawIntermediateClip = false
  while (true) {
    const state = await readState(window)
    assertBoundsEqual(window.getBounds(), carrier, method + ' 动画过程')
    if (!state.transition && state.mode === targetMode) break
    const dom = await readPresentationDom(window)
    if (
      dom.rootClipPath &&
      dom.rootClipPath !== 'none' &&
      dom.expandedOpacity !== '0' &&
      dom.expandedOpacity !== '1'
    ) {
      sawIntermediateClip = true
    }
    await wait(20)
  }

  if (options.breakAnimation) {
    await window.webContents.executeJavaScript(
      'Element.prototype.animate=window.__compactOriginalAnimate;delete window.__compactOriginalAnimate'
    )
  } else {
    assert.equal(sawIntermediateClip, true, method + ' 没有观察到连续 Renderer 呈现')
  }

  const stable = await readState(window)
  const dom = await readPresentationDom(window)
  assert.equal(stable.mode, targetMode)
  assert.equal(stable.transition, null)
  assert.equal(dom.viewport.width, carrier.width)
  assert.equal(dom.viewport.height, carrier.height)
  if (targetMode === 'compact') {
    assert.equal(dom.compactOpacity, '1')
    assert.equal(dom.compactVisibility, 'visible')
    assert.equal(dom.expandedVisibility, 'hidden')
    assert.deepEqual(shapeCalls.at(-1), [stable.presentation.compact])
  } else {
    assert.equal(dom.expandedOpacity, '1')
    assert.equal(dom.expandedVisibility, 'visible')
    assert.equal(dom.compactVisibility, 'hidden')
    assert.deepEqual(shapeCalls.at(-1), [stable.presentation.expanded])
  }
  assertBoundsEqual(window.getBounds(), carrier, method + ' 稳定收口')
  return stable
}

async function runCompactWindowTest() {
  let exitCode = 0
  try {
    assert.ok(existsSync(nativeDllPath), '未找到原生测试 DLL：' + nativeDllPath)
    const native = koffi.load(nativeDllPath)
    const getAbiVersion = native.func('AbandonNative_GetAbiVersion', 'int', [])
    assert.equal(getAbiVersion(), NATIVE_ABI_VERSION, '原生 DLL ABI 与当前代码不一致')

    let mainWindow = await waitUntil(() => getMainWindow(), requestedView + ' 主窗口没有创建')
    await waitUntil(
      async () => (await readState(mainWindow)).mode === 'expanded' && mainWindow.isVisible(),
      '首次加载没有稳定显示 expanded 主视图'
    )
    assert.equal(BrowserWindow.getAllWindows().length, 1, '首次加载创建了多余 BrowserWindow')
    const startupCarrier = mainWindow.getBounds()
    const startupDb = new Database(join(testUserData, 'app.db'), { readonly: true })
    const oldEnabled = startupDb
      .prepare(
        "SELECT value FROM app_settings WHERE window_name='application' AND type='compact' AND key='enabled'"
      )
      .get()?.value
    startupDb.close()
    assert.equal(oldEnabled, undefined, '旧 compact.enabled 启动状态没有从数据库删除')

    if (notificationLaunch) {
      report('compact notification startup recovery passed (' + requestedView + ')')
      return
    }

    const shapeCalls = []
    const originalSetShape = mainWindow.setShape.bind(mainWindow)
    mainWindow.setShape = (rects) => {
      shapeCalls.push(structuredClone(rects))
      return originalSetShape(rects)
    }

    const compactState = await runTransition(mainWindow, 'enter', 'compact', shapeCalls)
    assert.equal(mainWindow.id, BrowserWindow.getAllWindows()[0].id)
    assert.equal(mainWindow.isMovable(), true, 'compact 稳定态没有允许拖动')
    assert.ok(compactState.presentation.compact.width <= startupCarrier.width)
    assert.ok(compactState.presentation.compact.height <= startupCarrier.height)

    const beforeResize = mainWindow.getBounds()
    await mainWindow.webContents.executeJavaScript(
      'Promise.all([' +
        "window.api.setSettingValue('window.compact.width',420)," +
        "window.api.setSettingValue('window.compact.height',92)])"
    )
    await waitUntil(
      async () => (await readState(mainWindow)).presentation.compact.width === 420,
      'compact 可见区域尺寸没有更新'
    )
    assertBoundsEqual(mainWindow.getBounds(), beforeResize, 'compact 设置尺寸')
    assert.equal(shapeCalls.at(-1)[0].width, 420)
    assert.equal(shapeCalls.at(-1)[0].height, 92)

    const presentation = (await readState(mainWindow)).presentation
    const pointer = {
      x: mainWindow.getBounds().x + presentation.compact.x + 30,
      y: mainWindow.getBounds().y + presentation.compact.y + 20
    }
    assert.equal(
      await mainWindow.webContents.executeJavaScript(
        'window.api.beginCompactWindowDrag(' + JSON.stringify(pointer) + ')'
      ),
      true
    )
    await mainWindow.webContents.executeJavaScript(
      'window.api.updateCompactWindowDrag(' +
        JSON.stringify({ x: pointer.x + 24, y: pointer.y + 18 }) +
        ');true'
    )
    await waitUntil(() => {
      const moved = mainWindow.getBounds()
      return moved.x !== beforeResize.x || moved.y !== beforeResize.y
    }, 'compact 拖动没有移动固定 carrier')
    const draggedCarrier = mainWindow.getBounds()
    assert.equal(draggedCarrier.width, beforeResize.width)
    assert.equal(draggedCarrier.height, beforeResize.height)
    await mainWindow.webContents.executeJavaScript('window.api.endCompactWindowDrag()')

    await runTransition(mainWindow, 'exit', 'expanded', shapeCalls, { breakAnimation: true })
    assert.equal(mainWindow.isMovable(), false, 'expanded 后没有恢复窗口锁定')

    await runTransition(mainWindow, 'enter', 'compact', shapeCalls)
    await mainWindow.webContents.executeJavaScript(
      'void Promise.all([' +
        'window.api.exitCompactWindow(),' +
        'new Promise((resolve)=>setTimeout(resolve,40)).then(()=>window.api.enterCompactWindow())' +
        ']);true'
    )
    await waitUntil(async () => {
      const state = await readState(mainWindow)
      return !state.transition && state.mode === 'compact' ? state : null
    }, '连续相反请求没有收敛到最后一次 compact 意图')
    assertBoundsEqual(mainWindow.getBounds(), draggedCarrier, '连续相反请求')

    await runTransition(mainWindow, 'exit', 'expanded', shapeCalls)
    const targetView = requestedView === 'list' ? 'month' : 'list'
    const previousId = mainWindow.id
    await mainWindow.webContents.executeJavaScript(
      'window.api.switchMainView(' + JSON.stringify(targetView) + ')'
    )
    mainWindow = await waitUntil(
      () => BrowserWindow.getAllWindows().find((window) => window.id !== previousId),
      '视图切换没有创建替代主窗口'
    )
    await waitUntil(
      async () => (await readState(mainWindow)).mode === 'expanded' && mainWindow.isVisible(),
      '视图替换继承了 compact 或 transition 状态'
    )
    assert.equal(BrowserWindow.getAllWindows().length, 1)
    report('compact fixed-carrier integration passed (' + requestedView + ')')
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    app.releaseSingleInstanceLock()
    try {
      rmSync(testUserData, { recursive: true, force: true })
    } catch {
      // Crashpad 可能短暂占用隔离目录。
    }
    process.exit(exitCode)
  }
}

const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-compact-' + requestedView + '-'))
try {
  app.setPath('userData', testUserData)
  process.env.ABANDON_INTEGRATION_TEST = '1'
  process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
  process.env.ABANDON_INTEGRATION_NATIVE_DLL = nativeDllPath
  seedSettings(testUserData)
  if (notificationLaunch) process.argv.push('abandon-note://notification/open?id=1')

  require(resolve('out', 'main', 'index.js'))
  const mainChunk = readdirSync(resolve('out', 'main', 'chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk, '未找到构建后的主进程分块')
  require(resolve('out', 'main', 'chunks', mainChunk))
  app.once('ready', () => void runCompactWindowTest())
} catch (error) {
  console.error(error)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}
