import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, dialog, screen, desktopCapturer } from 'electron'
import koffi from 'koffi'
import { constrainMainWindowBounds } from '../src/main/window-bounds.js'
import { createDefaultSettings } from '../src/shared/settings-schema.js'
import { NATIVE_ABI_VERSION } from '../src/shared/native-abi-version.js'

const require = createRequire(import.meta.url)
const WAIT_STEP_MS = 16
const requestedView = ['list', 'month', 'week'].includes(process.argv[2]) ? process.argv[2] : 'list'
const notificationLaunch = process.argv.includes('notification')
const normalZOrderLaunch = process.argv.includes('normal-z-order')
const coldBlurOff = process.argv.includes('cold-blur-off')
const expectedZOrderMode = normalZOrderLaunch
  ? 'normal'
  : { list: 'top', month: 'normal', week: 'bottom' }[requestedView]
const viewConfig = {
  list: { scope: 'main', rendererFile: 'index.html', root: '.app-root', scene: '.app-scene' },
  month: { scope: 'month', rendererFile: 'month.html', root: '.month-root', scene: '.month-scene' },
  week: { scope: 'week', rendererFile: 'week.html', root: '.month-root', scene: '.month-scene' }
}[requestedView]
// 默认验证开发/常规打包使用的 DLL。临时构建只能显式指定，不能掩盖默认目录的旧 ABI。
const nativeDllPath =
  process.env.ABANDON_INTEGRATION_NATIVE_DLL ||
  resolve('native_blur', 'build', 'bin', 'blur_engine.dll')

let native = null

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

function report(message) {
  if (
    !process.stderr ||
    process.stderr.destroyed ||
    process.stderr.writableEnded ||
    process.stderr.writable === false
  ) {
    return
  }
  try {
    process.stderr.write(`${message}\n`)
  } catch {
    // 测试宿主提前关闭输出管道不影响窗口断言及进程退出码。
  }
}

function getDefaultExpandedSize() {
  const display = screen.getPrimaryDisplay()
  const defaults = createDefaultSettings(requestedView)
  const constrained = constrainMainWindowBounds(
    {
      x: display.workArea.x,
      y: display.workArea.y,
      width: Math.round(display.workAreaSize.width * defaults.geometry.widthRatio),
      height: Math.round(display.workAreaSize.height * defaults.geometry.heightRatio)
    },
    display.workArea
  )
  return { width: constrained.width, height: constrained.height }
}

async function waitUntil(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(WAIT_STEP_MS)
  }
  throw new Error(message)
}

function seedSettings(userDataPath) {
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
  const rows = [
    ['application', 'application', 'active_view', requestedView],
    ['application', 'remote', 'receive_notices', 'false'],
    ['application', 'remote', 'upload_device_info', 'false'],
    ['application', 'onboarding', 'first_use_notice_version', '1'],
    ['application', 'system', 'lock_state', 'true'],
    ['application', 'system', 'z_order_mode', expectedZOrderMode],
    // 模拟旧版本在退出前留下的灵动岛状态；新版启动必须主动清除并显示主视图。
    ['application', 'compact', 'enabled', 'true'],
    ['application', 'compact', 'x', '130'],
    ['application', 'compact', 'y', '140'],
    ['application', 'compact', 'width', '360'],
    ['application', 'compact', 'height', '76'],
    [viewConfig.scope, 'ui', 'settings_panel_size', requestedView === 'list' ? '55' : '57'],
    [viewConfig.scope, 'css', 'bg_color', '32 33 36'],
    [viewConfig.scope, 'css', 'text_color', '#f1f3f4'],
    [viewConfig.scope, 'css', 'window_opacity', '0.72'],
    [
      viewConfig.scope,
      'system',
      'blur_enabled',
      !coldBlurOff && requestedView === 'list' ? 'true' : 'false'
    ]
  ]
  for (const row of rows) insert.run(...row, now, now)
  db.close()
}

function getWindowForRenderer(rendererFile) {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && window.webContents.getURL().includes(`/${rendererFile}`)
  )
}

function getMainWindow(rendererFile = viewConfig.rendererFile) {
  return getWindowForRenderer(rendererFile)
}

function getApplicationWindows() {
  return BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
}

function nativeHandle(window) {
  const buffer = window.getNativeWindowHandle()
  return process.arch === 'x64' ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0))
}

function loadNative() {
  if (native) return native
  native = koffi.load(nativeDllPath)
  native.getAbiVersion = native.func('AbandonNative_GetAbiVersion', 'int', [])
  native.isBlurInitialized = native.func('Blur_IsInitialized', 'int', [])
  native.isBlurHealthy = native.func('Blur_IsHealthy', 'int', [])
  native.getZOrderStatusJson = native.func('WindowZOrder_GetStatusJson', 'str', ['intptr_t'])
  native.getTransitionStatusJson = native.func('WindowTransition_GetStatusJson', 'str', [
    'intptr_t'
  ])
  return native
}

function readNativeTransitionStatus(window) {
  return JSON.parse(loadNative().getTransitionStatusJson(nativeHandle(window)))
}

async function readState(window) {
  return window.webContents.executeJavaScript(`window.api.getCompactWindowState()`)
}

function assertOnlyOneBrowserWindow(expectedWindow, stage) {
  const windows = getApplicationWindows()
  assert.equal(windows.length, 1, `${stage} 不应创建第二个 BrowserWindow`)
  assert.equal(windows[0].id, expectedWindow.id, `${stage} 的唯一 BrowserWindow 不是当前主窗口`)
  assert.equal(
    windows.some((window) => window.webContents.getURL().includes('/compact.html')),
    false,
    `${stage} 仍创建了独立 compact renderer`
  )
}

async function assertZOrderMode(window, stage) {
  assert.equal(
    window.isAlwaysOnTop(),
    expectedZOrderMode === 'top',
    `${stage} 没有继承 ${expectedZOrderMode} Electron 层级`
  )
  if (expectedZOrderMode === 'top') return
  const hwnd = nativeHandle(window)
  let lastStatus = null
  let status
  try {
    status = await waitUntil(() => {
      const next = JSON.parse(loadNative().getZOrderStatusJson(hwnd))
      lastStatus = next
      return expectedZOrderMode === 'bottom' ? next.anchored && next : !next.enabled && next
    }, `${stage} 没有继承 ${expectedZOrderMode} 原生层级`)
  } catch (error) {
    const snapshot = await window.webContents.executeJavaScript(`window.api.getSettingsSnapshot()`)
    error.message += `：native=${JSON.stringify(lastStatus)} runtime=${snapshot?.values?.window?.zOrderMode}`
    throw error
  }
  if (expectedZOrderMode === 'bottom') {
    assert.equal(status.desktopWindowsAbove, 0)
    assert.ok(status.desktopWindowsBelow > 0)
  }
}

function assertBlurRuntimeHealthy(stage) {
  const api = loadNative()
  assert.equal(Boolean(api.isBlurInitialized()), true, `${stage} 后毛玻璃没有绑定当前 HWND`)
  assert.equal(Boolean(api.isBlurHealthy()), true, `${stage} 后毛玻璃运行时不健康`)
}

async function readRendererDiagnostics(
  window,
  rootSelector = viewConfig.root,
  sceneSelector = viewConfig.scene
) {
  return window.webContents.executeJavaScript(`(() => {
    const root = document.querySelector(${JSON.stringify(rootSelector)})
    const mainScene = document.querySelector(${JSON.stringify(sceneSelector)})
    const expandedLayer = document.querySelector('.compact-presentation-layer--expanded')
    const compactScene = document.querySelector('.compact-window-scene')
    const presentationHost = document.querySelector('.compact-presentation-host')
    const island = document.querySelector('.compact-island')
    const titlebar = mainScene?.querySelector('.app-titlebar')
    const backgroundColor = root ? getComputedStyle(root).backgroundColor : ''
    const alpha = backgroundColor.match(/^rgba?\\([^,]+,[^,]+,[^,]+(?:,\\s*([0-9.]+))?\\)$/)?.[1]
    return {
      rootExists: Boolean(root),
      mainSceneExists: Boolean(mainScene),
      compactSceneExists: Boolean(compactScene),
      islandExists: Boolean(island),
      backgroundColor,
      paintedRoot: Boolean(root) && backgroundColor !== 'transparent' && Number(alpha ?? 1) > 0,
      nativeGlassActive: document.documentElement.classList.contains('is-system-glass-active'),
      presentationClass: presentationHost?.className || '',
      rootWidth: root?.getBoundingClientRect().width ?? 0,
      rootHeight: root?.getBoundingClientRect().height ?? 0,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      mainOpacity: expandedLayer ? getComputedStyle(expandedLayer).opacity : null,
      mainTransform: expandedLayer ? getComputedStyle(expandedLayer).transform : null,
      mainTransitionDuration: expandedLayer ? getComputedStyle(expandedLayer).transitionDuration : null,
      mainVisibility: expandedLayer ? getComputedStyle(expandedLayer).visibility : null,
      mainInert: expandedLayer?.inert ?? null,
      mainWidth: expandedLayer?.getBoundingClientRect().width ?? 0,
      mainHeight: expandedLayer?.getBoundingClientRect().height ?? 0,
      titlebarWidth: titlebar?.getBoundingClientRect().width ?? 0,
      titlebarHeight: titlebar?.getBoundingClientRect().height ?? 0,
      compactOpacity: compactScene ? getComputedStyle(compactScene).opacity : null,
      compactTransform: compactScene ? getComputedStyle(compactScene).transform : null,
      compactTransitionDuration: compactScene ? getComputedStyle(compactScene).transitionDuration : null,
      compactVisibility: compactScene ? getComputedStyle(compactScene).visibility : null,
      compactInert: compactScene?.inert ?? null,
      compactSceneWidth: compactScene?.getBoundingClientRect().width ?? 0,
      compactSceneHeight: compactScene?.getBoundingClientRect().height ?? 0,
      islandWidth: island?.getBoundingClientRect().width ?? 0,
      islandHeight: island?.getBoundingClientRect().height ?? 0,
      rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
    }
  })()`)
}

async function assertRendererSurface(window, bounds, phase, stage, selectors = {}) {
  const diagnostics = await waitUntil(
    async () => {
      const next = await readRendererDiagnostics(
        window,
        selectors.root || viewConfig.root,
        selectors.scene || viewConfig.scene
      )
      return next.viewportWidth === bounds.width && next.viewportHeight === bounds.height
        ? next
        : null
    },
    `${stage} 的 Renderer viewport 没有收敛到 ${bounds.width}×${bounds.height}`,
    1_500
  )
  assert.equal(diagnostics.rootExists, true, `${stage} 缺少主根表面`)
  assert.equal(diagnostics.mainSceneExists, true, `${stage} 没有预挂载主场景`)
  assert.equal(diagnostics.compactSceneExists, true, `${stage} 没有预挂载胶囊场景`)
  assert.equal(diagnostics.islandExists, true, `${stage} 没有预挂载胶囊内容`)
  assert.equal(
    diagnostics.paintedRoot || diagnostics.nativeGlassActive,
    true,
    `${stage} 既没有 Renderer 回退底色，也没有原生玻璃材质`
  )
  assert.equal(diagnostics.rootWidth, diagnostics.viewportWidth)
  assert.equal(diagnostics.rootHeight, diagnostics.viewportHeight)
  assert.equal(diagnostics.islandWidth, diagnostics.viewportWidth)
  assert.equal(diagnostics.islandHeight, diagnostics.viewportHeight)
  assert.equal(diagnostics.viewportWidth, bounds.width)
  assert.equal(diagnostics.viewportHeight, bounds.height)
  if (phase === 'compact') {
    assert.equal(diagnostics.mainVisibility, 'hidden')
    assert.equal(diagnostics.compactVisibility, 'visible')
    assert.equal(diagnostics.compactOpacity, '1')
  }
  return diagnostics
}

async function captureRendererSurface(window, stage) {
  const image = await window.webContents.capturePage()
  assert.equal(image.isEmpty(), false, `${stage} 捕获到了空 Renderer Surface`)
  const bitmap = image.toBitmap()
  let sampled = 0
  let nearlyWhite = 0
  for (let index = 0; index + 3 < bitmap.length; index += 64) {
    sampled += 1
    if (bitmap[index] >= 245 && bitmap[index + 1] >= 245 && bitmap[index + 2] >= 245) {
      nearlyWhite += 1
    }
  }
  const whiteRatio = sampled ? nearlyWhite / sampled : 1
  assert.ok(whiteRatio < 0.75, `${stage} 出现接近纯白的 Renderer 帧 (${whiteRatio})`)
  return { whiteRatio, size: image.getSize() }
}

function assertMonotonic(samples, key, label) {
  const start = samples[0][key]
  const end = samples.at(-1)[key]
  const direction = Math.sign(end - start)
  if (!direction) return
  for (let index = 1; index < samples.length; index += 1) {
    const delta = (samples[index][key] - samples[index - 1][key]) * direction
    assert.ok(delta >= -1, `${label} 的 ${key} 在第 ${index} 帧发生反向抖动`)
  }
}

function transitionGeometryProgress(bounds, transition) {
  const changedAxes = ['x', 'y', 'width', 'height'].filter(
    (key) => transition.target[key] !== transition.from[key]
  )
  if (!changedAxes.length) return 1
  return Math.min(
    ...changedAxes.map((key) => {
      const distance = Math.abs(transition.target[key] - transition.from[key])
      const travelled = Math.abs(bounds[key] - transition.from[key])
      return Math.max(0, Math.min(1, travelled / distance))
    })
  )
}

function hasHiddenTransitionContent(diagnostics) {
  return (
    ['shell-transform', 'shell-settle'].some((stage) =>
      diagnostics.presentationClass.includes(`is-stage-${stage}`)
    ) &&
    diagnostics.mainOpacity === '0' &&
    diagnostics.mainVisibility === 'hidden' &&
    diagnostics.compactOpacity === '0' &&
    diagnostics.compactVisibility === 'hidden'
  )
}

function assertSourceContentExiting(diagnostics, phase, label) {
  const sourceIsCompact = phase === 'expanding'
  assert.equal(
    sourceIsCompact ? diagnostics.compactTransitionDuration : diagnostics.mainTransitionDuration,
    '0.1s',
    `${label} 旧内容没有使用统一的快速淡出`
  )
  assert.equal(
    sourceIsCompact ? diagnostics.compactTransform : diagnostics.mainTransform,
    'matrix(1, 0, 0, 1, 0, 0)',
    `${label} 外壳运动前内容发生了多余位移`
  )
  assert.equal(
    sourceIsCompact ? diagnostics.compactVisibility : diagnostics.mainVisibility,
    'visible',
    `${label} 的旧内容没有参与退出动画`
  )
  assert.equal(
    sourceIsCompact ? diagnostics.mainVisibility : diagnostics.compactVisibility,
    'hidden',
    `${label} 在旧内容退出时提前显示了新内容`
  )
}

function assertTargetContentEntering(diagnostics, finalPhase, label) {
  const targetIsCompact = finalPhase === 'compact'
  assert.equal(
    targetIsCompact ? diagnostics.compactTransitionDuration : diagnostics.mainTransitionDuration,
    targetIsCompact ? '0.1s' : '0.16s',
    `${label} 新内容淡入时长没有与边框、壁纸统一`
  )
  assert.equal(
    targetIsCompact ? diagnostics.compactVisibility : diagnostics.mainVisibility,
    'visible',
    `${label} 的新内容没有在最终外壳中进入`
  )
  assert.equal(
    targetIsCompact ? diagnostics.mainVisibility : diagnostics.compactVisibility,
    'hidden',
    `${label} 在新内容进入时重新显示了旧内容`
  )
}

async function runTransitionAndAssertSynchronizedGeometry({
  window,
  invoke,
  finalPhase,
  label,
  expectOverlay,
  captureSurface = false,
  selectors = {}
}) {
  const windowId = window.id
  const samples = [window.getBounds()]
  const nativeSamples = []
  let operationError = null
  let operationDone = false
  const operation = Promise.resolve(invoke())
    .catch((error) => {
      operationError = error
    })
    .finally(() => {
      operationDone = true
    })

  const exitState = await waitUntil(async () => {
    const state = await readState(window)
    return state.transition?.stage === 'content-exit' && state
  }, `${label} 没有进入旧内容退出阶段`)
  const exitDiagnostics = await waitUntil(
    async () => {
      const diagnostics = await readRendererDiagnostics(
        window,
        selectors.root || viewConfig.root,
        selectors.scene || viewConfig.scene
      )
      const sourceIsCompact = exitState.phase === 'expanding'
      const sourceVisibility = sourceIsCompact
        ? diagnostics.compactVisibility
        : diagnostics.mainVisibility
      return sourceVisibility === 'visible' ? diagnostics : null
    },
    `${label} 的旧内容退出动画没有启动`,
    1_000
  )
  assertSourceContentExiting(exitDiagnostics, exitState.phase, label)
  assert.deepEqual(window.getBounds(), exitState.transition.from, `${label} 提前改变了窗口外壳`)
  assert.equal(exitDiagnostics.viewportWidth, exitState.transition.from.width)
  assert.equal(exitDiagnostics.viewportHeight, exitState.transition.from.height)

  const transitionState = await waitUntil(async () => {
    const state = await readState(window)
    return ['shell-transform', 'shell-settle'].includes(state.transition?.stage) && state
  }, `${label} 没有在内容退出后进入外壳变形阶段`)
  const phaseDiagnostics = await waitUntil(
    async () => {
      const diagnostics = await readRendererDiagnostics(
        window,
        selectors.root || viewConfig.root,
        selectors.scene || viewConfig.scene
      )
      return hasHiddenTransitionContent(diagnostics) ? diagnostics : null
    },
    `${label} 的新旧内容没有在原生动画前完整退出`,
    1_500
  )
  assert.equal(
    phaseDiagnostics.paintedRoot || phaseDiagnostics.nativeGlassActive,
    true,
    `${label} 过渡期没有可见外壳材质`
  )
  assert.equal(phaseDiagnostics.mainSceneExists, true)
  assert.equal(phaseDiagnostics.compactSceneExists, true)
  assert.equal(transitionState.transition?.phase, transitionState.phase)
  assert.ok(['shell-transform', 'shell-settle'].includes(transitionState.transition?.stage))
  const rendererSamples = [phaseDiagnostics]
  const surfaceCaptures = []
  let sawContentEnter = false
  let sawCompositorShell = false
  let desktopCaptureCount = 0
  if (captureSurface) {
    surfaceCaptures.push(await captureRendererSurface(window, `${label}过渡帧1`))
  }
  let nextVisualSampleAt = Date.now() + 48

  const deadline = Date.now() + 10_000
  while (true) {
    const currentState = await readState(window)
    if (currentState.phase === finalPhase) break
    if (operationDone && operationError) throw operationError
    if (Date.now() >= deadline) throw new Error(`${label}没有稳定到 ${finalPhase}`)
    assert.equal(window.id, windowId, `${label} 途中替换了 BrowserWindow`)
    samples.push(window.getBounds())
    const nativeStatus = readNativeTransitionStatus(window)
    nativeSamples.push(nativeStatus)
    if (nativeStatus.shellPrepared && nativeStatus.running) {
      sawCompositorShell = true
      assert.equal(window.getOpacity(), 0, `${label} 原生外壳动画时 Renderer 没有隐藏`)
      if (process.env.SHELL_CAPTURE_DIR && desktopCaptureCount < 3) {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1920, height: 1080 }
        })
        const display = screen.getDisplayMatching(window.getBounds())
        const source = sources.find((item) => item.display_id === String(display.id))
        if (source && !source.thumbnail.isEmpty()) {
          mkdirSync(process.env.SHELL_CAPTURE_DIR, { recursive: true })
          writeFileSync(
            join(
              process.env.SHELL_CAPTURE_DIR,
              `${requestedView}-${label}-${++desktopCaptureCount}.png`
            ),
            source.thumbnail.toPNG()
          )
        }
      }
      const carrier = nativeStatus.shellCarrier
      const overlay = nativeStatus.shellRect
      assert.deepEqual(overlay, carrier, `${label} 动画承载窗口没有保持固定尺寸`)
    }
    if (nativeStatus.overlayExpected) {
      assert.equal(nativeStatus.geometryEqual, true, `${label} 的 Electron/Overlay 当前帧不同步`)
      assert.equal(nativeStatus.currentDelta, 0, `${label} 的 Electron/Overlay 当前帧存在像素偏差`)
    }
    if (Date.now() >= nextVisualSampleAt) {
      const diagnostics = await readRendererDiagnostics(
        window,
        selectors.root || viewConfig.root,
        selectors.scene || viewConfig.scene
      )
      if (['shell-transform', 'shell-settle'].includes(currentState.transition?.stage)) {
        // IPC 状态与 DOM 诊断不是同一个原子快照；Renderer 已进入下一阶段时，
        // 不能拿旧的主进程阶段去断言新的 DOM 帧。
        if (
          ['shell-transform', 'shell-settle'].some((stage) =>
            diagnostics.presentationClass.includes(`is-stage-${stage}`)
          )
        ) {
          assert.equal(
            hasHiddenTransitionContent(diagnostics),
            true,
            `${label} 外壳变形时内容重新出现`
          )
        }
      } else if (currentState.transition?.stage === 'content-enter') {
        if (!diagnostics.presentationClass.includes('is-stage-content-enter')) {
          await wait(WAIT_STEP_MS)
          continue
        }
        const targetVisibility =
          finalPhase === 'compact' ? diagnostics.compactVisibility : diagnostics.mainVisibility
        if (targetVisibility !== 'visible') {
          await wait(WAIT_STEP_MS)
          continue
        }
        assertTargetContentEntering(diagnostics, finalPhase, label)
        assert.equal(
          finalPhase === 'compact' ? diagnostics.compactInert : diagnostics.mainInert,
          true,
          `${label} 在稳定前提前开放了新内容交互`
        )
        const currentBounds = window.getBounds()
        if (finalPhase === 'expanded') {
          const geometryProgress = transitionGeometryProgress(
            currentBounds,
            currentState.transition
          )
          assert.ok(
            geometryProgress >= 0.9,
            `${label} 在外壳尚未接近最终尺寸时显示了主内容 (${geometryProgress})`
          )
          assert.equal(nativeStatus.running, false, `${label} 内容在布局稳定前出现`)
          assert.equal(geometryProgress, 1)
        } else {
          assert.equal(diagnostics.viewportWidth, currentState.transition.target.width)
          assert.equal(diagnostics.viewportHeight, currentState.transition.target.height)
          assert.deepEqual(
            currentBounds,
            currentState.transition.target,
            `${label} 收起时在最终外壳尺寸到达前显示了胶囊内容`
          )
        }
        sawContentEnter = true
      }
      rendererSamples.push(diagnostics)
      if (captureSurface) {
        surfaceCaptures.push(
          await captureRendererSurface(window, `${label}过渡帧${surfaceCaptures.length + 1}`)
        )
      }
      nextVisualSampleAt = Date.now() + 48
    }
    await wait(WAIT_STEP_MS)
  }
  await operation
  if (operationError) throw operationError
  samples.push(window.getBounds())

  const uniqueBounds = new Set(samples.map((bounds) => JSON.stringify(bounds))).size
  assert.ok(uniqueBounds <= 2, `${label} 真实窗口在动画中反复 resize (${uniqueBounds})`)
  for (const key of ['x', 'y', 'width', 'height']) assertMonotonic(samples, key, label)
  assert.equal(window.id, windowId)
  assert.equal(window.isVisible(), true, `${label} 完成后唯一窗口不可见`)
  assertOnlyOneBrowserWindow(window, label)

  const finalNative = readNativeTransitionStatus(window)
  assert.equal(finalNative.running, false, `${label} 完成后原生事务仍在运行`)
  assert.equal(finalNative.blurTransitionActive, false, `${label} 完成后 Blur 仍处于 transition`)
  assert.equal(finalNative.frameCount, 1, `${label} 真实窗口必须只提交一次目标尺寸`)
  assert.equal(finalNative.shellPrepared, false, `${label} 临时外壳没有释放`)
  assert.equal(finalNative.shellError, 0, `${label} 原生外壳报告错误`)
  assert.equal(finalNative.shellVisible, false, `${label} 临时承载窗口没有隐藏`)
  assert.deepEqual(
    finalNative.shellRect,
    finalNative.shellCarrier,
    `${label} 交接时修改了外壳承载坐标，可能在旧原点显示胶囊`
  )
  assert.equal(window.getOpacity(), 1, `${label} 原窗口透明度没有恢复`)
  assert.equal(finalNative.geometryEqual, true, `${label} 完成后 Electron/Overlay 不一致`)
  if (expectOverlay) {
    assert.equal(finalNative.overlayExpected, true, `${label} 未保持 Blur Overlay`)
    assert.equal(finalNative.overlayVisible, true, `${label} 的 Blur Overlay 不可见`)
    assert.equal(
      finalNative.visualWidth,
      finalNative.parentRect.right - finalNative.parentRect.left,
      `${label} 的 DComp Visual 宽度未覆盖 Electron 窗口`
    )
    assert.equal(
      finalNative.visualHeight,
      finalNative.parentRect.bottom - finalNative.parentRect.top,
      `${label} 的 DComp Visual 高度未覆盖 Electron 窗口`
    )
    assert.equal(finalNative.maximumObservedDelta, 0, `${label} 曾出现 Electron/Overlay 帧偏差`)
  } else {
    assert.equal(finalNative.overlayExpected, false, `${label} 毛玻璃关闭时仍显示 Overlay`)
    assert.equal(finalNative.overlayVisible, false, `${label} 毛玻璃关闭时 Overlay 仍然可见`)
  }
  assert.ok(nativeSamples.length >= 2, `${label} 未采集到足够的原生过渡样本`)
  assert.ok(
    rendererSamples.some(hasHiddenTransitionContent),
    `${label} 未覆盖新旧内容都隐藏的外壳变形阶段`
  )
  assert.equal(sawContentEnter, true, `${label} 未覆盖新内容进入阶段`)
  assert.equal(sawCompositorShell, true, `${label} 未覆盖固定承载窗口的合成动画`)
  if (captureSurface) {
    assert.ok(surfaceCaptures.length >= 3, `${label} 未覆盖过渡前中后段 Renderer 帧`)
  }
  return { samples, finalNative, rendererSamples, surfaceCaptures }
}

async function assertCompactContent(window, expectedBounds, expectedFontSize = null) {
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(`(() => {
        const root = document.querySelector('.compact-island')
        return root && root.getBoundingClientRect().width === ${expectedBounds.width} &&
          root.getBoundingClientRect().height === ${expectedBounds.height}
      })()`),
    `胶囊 Renderer 没有同步到 ${expectedBounds.width}×${expectedBounds.height}`,
    1_500
  )
  const diagnostics = await window.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('.compact-island')
    const content = document.querySelector('.compact-island__content')
    const text = document.querySelector('.compact-island__text')
    const ring = document.querySelector('.compact-island__status-ring')
    const rootRect = root.getBoundingClientRect()
    const textRect = text.getBoundingClientRect()
    const ringRect = ring?.getBoundingClientRect()
    const left = ringRect ? ringRect.left : textRect.left
    return {
      centerDeltaX: (left + textRect.right - rootRect.left - rootRect.right) / 2,
      centerDeltaY: (textRect.top + textRect.bottom - rootRect.top - rootRect.bottom) / 2,
      ringCenterDeltaY: ringRect ? (ringRect.top + ringRect.bottom - rootRect.top - rootRect.bottom) / 2 : 0,
      textFitsVertically: textRect.top >= rootRect.top && textRect.bottom <= rootRect.bottom,
      contentPadding: content ? getComputedStyle(content).padding : null,
      textFontSize: text ? getComputedStyle(text).fontSize : null,
      textOverflow: text ? getComputedStyle(text).textOverflow : null,
      textAnimation: text ? getComputedStyle(text).animationName : null,
      cursor: root ? getComputedStyle(root).cursor : null,
      expandIcon: Boolean(document.querySelector('.compact-island__expand-icon'))
    }
  })()`)
  assert.equal(diagnostics.contentPadding, '4px 12px')
  assert.ok(Math.abs(diagnostics.centerDeltaX) <= 1, '圆环与文字整体没有水平居中')
  assert.ok(Math.abs(diagnostics.centerDeltaY) <= 1, '文字没有垂直居中')
  assert.ok(Math.abs(diagnostics.ringCenterDeltaY) <= 1, '状态圆环没有垂直居中')
  assert.equal(diagnostics.textFitsVertically, true, '文字超出了胶囊高度')
  assert.ok(Number.parseFloat(diagnostics.textFontSize) >= 12)
  if (expectedFontSize) assert.equal(diagnostics.textFontSize, expectedFontSize)
  assert.equal(diagnostics.textOverflow, 'ellipsis')
  assert.equal(diagnostics.textAnimation, 'none')
  assert.equal(diagnostics.cursor, 'default')
  assert.equal(diagnostics.expandIcon, false)
  return diagnostics
}

async function runCompactLayoutTest(window) {
  const bounds = window.getBounds()
  const themes = [
    { name: 'white', background: '#fff', text: '#111' },
    { name: 'black', background: '#000', text: '#fff' },
    {
      name: 'pattern',
      background:
        'repeating-linear-gradient(35deg, #405060 0 13px, #697867 13px 27px, #564d63 27px 42px)',
      text: '#fff'
    }
  ]
  for (const [name, content] of [
    ['empty', null],
    ['short', '测试'],
    ['long', '这是一条需要省略显示的很长的进行中便签'.repeat(4)]
  ]) {
    let note = null
    if (content) {
      note = await window.webContents.executeJavaScript(
        `window.api.createNote({ content: ${JSON.stringify(content)} })`
      )
      await waitUntil(
        () =>
          window.webContents.executeJavaScript(
            `document.querySelector('.compact-island__content')?.dataset.noteId === '${note.id}'`
          ),
        '没有显示布局测试便签'
      )
    }
    await assertCompactContent(window, bounds)
    for (const theme of themes) {
      await window.webContents.executeJavaScript(`(() => {
        const root = document.querySelector('${viewConfig.root}')
        root.style.background = ${JSON.stringify(theme.background)}
        root.style.setProperty('--text-color', ${JSON.stringify(theme.text)})
        return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      })()`)
      await assertCompactContent(window, bounds)
      if (process.env.ABANDON_LAYOUT_ARTIFACT_DIR) {
        mkdirSync(process.env.ABANDON_LAYOUT_ARTIFACT_DIR, { recursive: true })
        writeFileSync(
          join(
            process.env.ABANDON_LAYOUT_ARTIFACT_DIR,
            `${requestedView}-${name}-${theme.name}.png`
          ),
          (await window.webContents.capturePage()).toPNG()
        )
      }
    }
    if (note) {
      await window.webContents.executeJavaScript(`window.api.completeNote('${note.id}')`)
      await waitUntil(
        () =>
          window.webContents.executeJavaScript(
            `document.querySelector('.compact-island__content')?.dataset.noteId === ''`
          ),
        '布局测试便签完成后没有恢复空状态'
      )
    }
  }
  await window.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('${viewConfig.root}')
    root.style.removeProperty('background')
    root.style.removeProperty('--text-color')
  })()`)
  await window.webContents.executeJavaScript('window.api.exitCompactWindow()')
  assert.equal((await readState(window)).phase, 'expanded')
  await window.webContents.executeJavaScript('window.api.enterCompactWindow()')
  assert.equal((await readState(window)).phase, 'compact')
  assert.equal(window.getBounds().width, 200)
  assert.equal(window.getBounds().height, 40)
  await assertCompactContent(window, window.getBounds())
  report(`${requestedView} compact default migration, centered layout and round-trip passed`)
}

async function assertDiagnosticExport(window) {
  // 单次事务采样应在本地日志里完整保留，不依赖开发者工具或逐帧 IPC。
  const native = await waitUntil(async () => {
    const result = await window.webContents.executeJavaScript(
      `window.api.queryLogs({ search: 'compact-window.native-diagnostics', limit: 10 })`
    )
    return result.items.find(
      (item) =>
        item.scope === 'compact-window.native-diagnostics' && item.metadata?.phase === 'collapsing'
    )
  }, '没有自动记录原生窗口过渡采样')
  const timing = native.metadata.diagnostics.timing
  assert.equal(timing.schemaVersion, 1)
  assert.equal(timing.mode, 'composition-shell')
  assert.equal(timing.frames.length, 1)
  assert.equal(timing.presentationFramesMeasured, false)
  assert.equal(timing.durationRequestedMs, native.metadata.phase === 'collapsing' ? 320 : 400)
  assert.ok(
    timing.compositionWaitMs >= timing.durationRequestedMs - 30 && timing.compositionWaitMs < 2000
  )
  assert.ok(
    timing.frames[0].elapsedMs + timing.compositionWaitMs <= timing.totalMs + 1,
    '真实窗口尺寸仍然在外壳动画结束后才提交'
  )
  assert.equal(timing.droppedFrames, 0)
  assert.ok(timing.frames.every((frame) => !frame.dwmWaited))
  for (const frame of timing.frames) {
    assert.deepEqual(frame.actual, frame.requested)
    for (const field of ['geometryMs', 'batchMs', 'visualSyncMs', 'elapsedMs', 'intervalMs']) {
      assert.ok(Number.isFinite(frame[field]) && frame[field] >= 0, field)
    }
  }
  await waitUntil(async () => {
    const result = await window.webContents.executeJavaScript(
      `window.api.queryLogs({ search: 'compact-window.renderer-diagnostics', limit: 10 })`
    )
    return result.items.find(
      (item) =>
        item.metadata?.generation === native.metadata.generation &&
        item.metadata?.frames?.some((frame) => frame.event === 'resize')
    )
  }, '没有与原生过渡对应的 renderer 尺寸采样')
  const exportPath = join(testUserData, 'diagnostics-export.jsonl')
  const originalDialog = dialog.showSaveDialog
  try {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath })
    const result = await window.webContents.executeJavaScript('window.api.exportLogs()')
    assert.equal(result.canceled, false)
  } finally {
    dialog.showSaveDialog = originalDialog
  }
  const records = readFileSync(exportPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
  assert.equal(records[0].type, 'diagnostic-export')
  assert.equal(records.at(-1).type, 'diagnostic-system')
  const snapshot = records.at(-1).snapshot
  assert.ok(snapshot.system.release)
  assert.ok(snapshot.hardware.totalMemoryBytes > 0)
  assert.ok(
    snapshot.displays.some((display) => display.scaleFactor > 0 && display.displayFrequency > 0)
  )
  assert.ok(snapshot.system.windowsVersion?.CurrentBuildNumber)
  assert.match(snapshot.application.nativeDllSha256, /^[a-f0-9]{64}$/)
  assert.ok(
    records.some(
      (record) =>
        record.scope === 'compact-window.native-diagnostics' &&
        record.metadata.diagnostics.timing.frames.length > 0
    )
  )
  let overlappedFrames = 0
  for (const record of records.filter(
    (item) => item.scope === 'compact-window.stage-diagnostics'
  )) {
    const stages = record.metadata.stages
    const readyIndex = stages.findIndex((stage) => stage.stage === 'target-frame-ready')
    const enterIndex = stages.findIndex((stage) => stage.stage === 'content-enter-requested')
    const releaseIndex = stages.findIndex((stage) => stage.stage === 'shell-released')
    const nativeIndex = stages.findIndex((stage) => stage.stage === 'native-complete')
    const requestedIndex = stages.findIndex((stage) => stage.stage === 'target-layout-requested')
    if (enterIndex >= 0) {
      assert.ok(
        requestedIndex >= 0 && requestedIndex < nativeIndex,
        '布局准备没有与原生动画同时启动'
      )
      assert.ok(releaseIndex > nativeIndex, '原生动画未结束就撤下了外壳')
      if (readyIndex >= 0 && readyIndex < nativeIndex) overlappedFrames += 1
      assert.ok(readyIndex >= 0 && readyIndex < enterIndex, '内容显示前没有生成目标合成帧')
      assert.ok(enterIndex > nativeIndex && releaseIndex > enterIndex, '内容没有与最终材质提交重叠')
      assert.ok(stages[readyIndex].frameSize.width > 0 && stages[readyIndex].frameSize.height > 0)
    }
  }
  assert.ok(overlappedFrames > 0, '未观察到动画期间生成目标合成帧')
  report(`${requestedView} target frames prepared during native motion: ${overlappedFrames}`)
  if (process.env.ABANDON_LAYOUT_ARTIFACT_DIR) {
    mkdirSync(process.env.ABANDON_LAYOUT_ARTIFACT_DIR, { recursive: true })
    writeFileSync(
      join(process.env.ABANDON_LAYOUT_ARTIFACT_DIR, `${requestedView}-diagnostics-export.jsonl`),
      readFileSync(exportPath)
    )
  }
  report(`${requestedView} native/renderer timing and complete export system footer passed`)
}

async function runHandoffReadbackChecks(window) {
  report('handoff checks: holding first compositor readback')
  const initialBounds = window.getBounds()
  const capture = window.webContents.capturePage.bind(window.webContents)
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let captured = false
  let holdFirst = true
  window.webContents.capturePage = async (...args) => {
    const image = await capture(...args)
    if (holdFirst && args[0]?.width === 1) {
      holdFirst = false
      captured = true
      await gate
    }
    return image
  }
  try {
    const pending = window.webContents.executeJavaScript('window.api.exitCompactWindow()')
    await waitUntil(
      () => captured && readNativeTransitionStatus(window).shellCompleted,
      '小区域合成帧等待未能与原生完成分离'
    )
    const state = await readState(window)
    assert.equal(state.phase, 'expanding')
    assert.equal(state.transition.stage, 'shell-settle')
    assert.equal(window.getOpacity(), 0, '慢帧期间提前显示真实窗口')
    assert.equal(readNativeTransitionStatus(window).shellPrepared, true)
    release()
    await pending
    assert.equal((await readState(window)).phase, 'expanded')
    await window.webContents.executeJavaScript('window.api.enterCompactWindow()')
  } finally {
    release()
    window.webContents.capturePage = capture
  }

  const beforeFailure = window.getBounds()
  report('handoff checks: injecting readback failure')
  window.webContents.capturePage = async (...args) => {
    if (args[0]?.width === 1) {
      report('handoff checks: returning rejected capture promise')
      throw new Error('injected target readback failure')
    }
    return capture(...args)
  }
  try {
    await window.webContents.executeJavaScript('window.api.exitCompactWindow().catch(() => null)')
    assert.deepEqual(window.getBounds(), beforeFailure)
    assert.equal(window.getOpacity(), 1)
    assert.equal((await readState(window)).phase, 'compact')
    const status = readNativeTransitionStatus(window)
    assert.equal(status.running, false, '读取失败后原生动画尚未结束就回滚了窗口')
    assert.equal(status.shellPrepared, false)
  } finally {
    window.webContents.capturePage = capture
  }

  // 模拟运动期间连续请求，只执行当前事务和最后目标，不逐项排队。
  const before = (await readState(window)).transition
  report('handoff checks: coalescing opposite requests')
  assert.equal(before, null)
  const pending = window.webContents.executeJavaScript('window.api.exitCompactWindow()')
  await waitUntil(
    async () => (await readState(window)).transition?.stage === 'shell-settle',
    '连续请求测试未进入外壳阶段'
  )
  const requests = window.webContents.executeJavaScript(`Promise.all([
    window.api.enterCompactWindow(), window.api.exitCompactWindow(), window.api.enterCompactWindow()
  ])`)
  await Promise.all([pending, requests])
  assert.equal((await readState(window)).phase, 'compact')
  assert.equal(window.getOpacity(), 1)
  assert.equal(readNativeTransitionStatus(window).shellPrepared, false)
  assert.equal(window.getBounds().width, initialBounds.width)
  const entering = window.webContents.executeJavaScript('window.api.exitCompactWindow()')
  await waitUntil(
    async () => (await readState(window)).transition?.stage === 'content-enter',
    '双击测试未进入内容交接阶段'
  )
  assert.equal(
    await window.webContents.executeJavaScript(`(() => {
    const target = document.querySelector('.compact-transition-input')
    if (!target) return false
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  })()`),
    true
  )
  await entering
  assert.equal((await readState(window)).phase, 'compact', '交接期间的双击意图丢失')
  report(`${requestedView} small readback, slow/failing frame recovery and latest intent passed`)
}

async function runSettingsPanelOpeningTest(window) {
  const calendarView = requestedView !== 'list'
  const expectedRatio = calendarView ? 0.57 : 0.55
  await window.webContents.executeJavaScript(
    `document.querySelector('.titlebar-btn-settings').click()`
  )
  const opening = await waitUntil(async () => {
    const state = await window.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('.settings-panel')
      if (!panel?.classList.contains('active')) return null
      const rect = panel.getBoundingClientRect()
      return {
        sizeRatio: ${calendarView} ? rect.width / window.innerWidth : rect.height / window.innerHeight,
        sectionTitles: Array.from(panel.querySelectorAll('.section-title'), (node) =>
          node.textContent.replace(/\\s+/g, ' ').trim()
        )
      }
    })()`)
    return state
  }, `${requestedView} 设置面板没有打开`)
  assert.ok(
    Math.abs(opening.sizeRatio - expectedRatio) < 0.01,
    `${requestedView} 设置面板进场首帧没有使用保存尺寸`
  )
  assert.equal(opening.sectionTitles.includes('灵动岛'), false, '设置页面仍显示灵动岛宽高设置')
  await window.webContents.executeJavaScript(
    `document.querySelector('.settings-panel .panel-close-btn').click()`
  )
  await waitUntil(
    () => window.webContents.executeJavaScript(`!document.querySelector('.settings-panel')`),
    `${requestedView} 设置面板没有完成关闭`
  )
}

async function runRepeatedTransitionStress(window, cycles, expectOverlay) {
  const originalId = window.id
  for (let index = 0; index < cycles; index += 1) {
    const expandStartedAt = Date.now()
    await runTransitionAndAssertSynchronizedGeometry({
      window,
      invoke: () => window.webContents.executeJavaScript(`window.api.exitCompactWindow()`),
      finalPhase: 'expanded',
      label: `连续切换 ${index + 1}/${cycles} 展开`,
      expectOverlay
    })
    assert.ok(Date.now() - expandStartedAt < 2_000, '展开事务出现异常长尾')
    assert.equal(window.id, originalId)
    assertBlurRuntimeHealthy(`连续切换 ${index + 1}/${cycles} 展开`)

    const collapseStartedAt = Date.now()
    await runTransitionAndAssertSynchronizedGeometry({
      window,
      invoke: () => window.webContents.executeJavaScript(`window.api.enterCompactWindow()`),
      finalPhase: 'compact',
      label: `连续切换 ${index + 1}/${cycles} 收起`,
      expectOverlay
    })
    assert.ok(Date.now() - collapseStartedAt < 2_000, '收起事务出现异常长尾')
    assert.equal(window.id, originalId)
    assertBlurRuntimeHealthy(`连续切换 ${index + 1}/${cycles} 收起`)
  }
}

async function runBlurDisabledTransitionTest(window) {
  if (requestedView !== 'list') return
  const originalId = window.id
  const disabled = await window.webContents.executeJavaScript(
    `window.api.setBlurConfig({ enabled: false })`
  )
  assert.equal(disabled.success, true, '关闭毛玻璃请求失败')
  assert.equal(disabled.runtime?.effectiveEnabled, false, '主进程仍报告毛玻璃已启用')
  const fallback = await waitUntil(async () => {
    const diagnostics = await readRendererDiagnostics(window)
    return !diagnostics.nativeGlassActive && diagnostics.paintedRoot ? diagnostics : null
  }, '关闭毛玻璃后 Renderer 没有恢复 CSS 半透明底色')
  assert.equal(fallback.nativeGlassActive, false)
  assert.equal(fallback.paintedRoot, true)
  const disabledNative = readNativeTransitionStatus(window)
  assert.equal(disabledNative.overlayExpected, false)
  assert.equal(disabledNative.overlayVisible, false, '关闭毛玻璃后原生 Overlay 仍可见')

  await runTransitionAndAssertSynchronizedGeometry({
    window,
    invoke: () => window.webContents.executeJavaScript(`window.api.enterCompactWindow()`),
    finalPhase: 'compact',
    label: '毛玻璃关闭后收起',
    expectOverlay: false
  })
  await window.webContents.executeJavaScript(
    `Promise.all([
      window.api.setSettingValue('window.compact.width', 404),
      window.api.setSettingValue('window.compact.height', 84)
    ])`
  )
  await waitUntil(
    () => window.getBounds().width === 404 && window.getBounds().height === 84,
    '毛玻璃关闭时胶囊尺寸没有收敛到设置值'
  )
  await assertRendererSurface(window, window.getBounds(), 'compact', '毛玻璃关闭后胶囊缩放')
  assert.equal(readNativeTransitionStatus(window).overlayVisible, false)

  await runTransitionAndAssertSynchronizedGeometry({
    window,
    invoke: () => window.webContents.executeJavaScript(`window.api.exitCompactWindow()`),
    finalPhase: 'expanded',
    label: '毛玻璃关闭后展开',
    expectOverlay: false
  })
  const enabled = await window.webContents.executeJavaScript(
    `window.api.setBlurConfig({ enabled: true })`
  )
  assert.equal(enabled.success, true, `重新启用毛玻璃失败：${enabled.error || ''}`)
  assert.equal(enabled.runtime?.effectiveEnabled, true, '主进程没有确认毛玻璃重新启用')
  await waitUntil(async () => {
    const diagnostics = await readRendererDiagnostics(window)
    return diagnostics.nativeGlassActive && !diagnostics.paintedRoot ? diagnostics : null
  }, '重新启用毛玻璃后 Renderer 没有移除 CSS 回退底色')
  const enabledNative = await waitUntil(() => {
    const status = readNativeTransitionStatus(window)
    return status.overlayExpected && status.overlayVisible && status.geometryEqual ? status : null
  }, '重新启用毛玻璃后 Overlay 没有与 Electron 窗口同步恢复')
  assert.equal(
    enabledNative.visualWidth,
    enabledNative.parentRect.right - enabledNative.parentRect.left,
    '重新启用毛玻璃后 DComp Visual 宽度错误'
  )
  assert.equal(
    enabledNative.visualHeight,
    enabledNative.parentRect.bottom - enabledNative.parentRect.top,
    '重新启用毛玻璃后 DComp Visual 高度错误'
  )
  assert.equal(window.id, originalId, '毛玻璃切换期间替换了 BrowserWindow')
  assertBlurRuntimeHealthy('重新启用毛玻璃')
}

async function runTitlebarInteractionTest(window) {
  if (requestedView !== 'list') return
  await window.webContents.executeJavaScript(`window.api.toggleLock()`)
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(
        `!document.querySelector('.app-titlebar')?.classList.contains('locked')`
      ),
    '标题栏交互测试前没有解除窗口锁定'
  )

  const before = window.getBounds()
  const workArea = screen.getDisplayMatching(before).workArea
  const centered = {
    x: Math.round(workArea.x + (workArea.width - before.width) / 2),
    y: Math.round(workArea.y + (workArea.height - before.height) / 2)
  }
  window.setPosition(centered.x, centered.y, false)
  await wait(80)
  const centeredBounds = window.getBounds()
  const centeredNativeBounds = readNativeTransitionStatus(window).parentRect
  const target = await window.webContents.executeJavaScript(`(() => {
    const titlebar = document.querySelector('.app-titlebar')
    const surface = document.querySelector('.app-titlebar-interaction-surface')
    const resizeHandle = document.querySelector('.rh-n')
    const rect = titlebar.getBoundingClientRect()
    const resizeRect = resizeHandle.getBoundingClientRect()
    const y = Math.min(
      Math.floor(rect.bottom) - 2,
      Math.max(Math.ceil(resizeRect.bottom) + 2, Math.ceil(rect.top) + 1)
    )
    let point = null
    for (let x = Math.ceil(rect.left) + 12; x < Math.floor(rect.right) - 12; x += 8) {
      const candidate = document.elementFromPoint(x, y)
      if (titlebar.contains(candidate) && !candidate.closest('button, a, input, [role="button"]')) {
        point = { x, y }
        break
      }
    }
    const hit = point ? document.elementFromPoint(point.x, point.y) : null
    return {
      point,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      hitClass: hit?.className || '',
      titlebarContainsHit: titlebar.contains(hit),
      surfaceContainsHit: surface.contains(hit),
      resizeContainsHit: resizeHandle.contains(hit),
      phaseClass: document.querySelector('.month-root, .app-root').className
    }
  })()`)
  assert.equal(
    target.titlebarContainsHit,
    true,
    `标题栏顶部空白带未命中统一交互面：${JSON.stringify(target)}`
  )
  assert.equal(target.surfaceContainsHit, false, '测试坐标仍落在旧的中间交互面')
  assert.equal(target.resizeContainsHit, false, '测试坐标错误落在顶部缩放手柄')
  const point = target.point

  const delta = { x: 36, y: 22 }
  const dragStart = { x: centered.x + point.x, y: centered.y + point.y }
  await window.webContents.executeJavaScript(`(async () => {
    const titlebar = document.querySelector('.app-titlebar')
    const send = (type, screenX, screenY) => titlebar.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 71,
      pointerType: 'mouse',
      clientX: ${point.x} + screenX - ${dragStart.x},
      clientY: ${point.y} + screenY - ${dragStart.y},
      screenX,
      screenY
    }))
    send('pointerdown', ${dragStart.x}, ${dragStart.y})
    for (let step = 1; step <= 16; step += 1) {
      send(
        'pointermove',
        ${dragStart.x} + Math.round((${delta.x} * step) / 16),
        ${dragStart.y} + Math.round((${delta.y} * step) / 16)
      )
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame))
    }
    send('pointerup', ${dragStart.x + delta.x}, ${dragStart.y + delta.y})
    return true
  })()`)
  await waitUntil(() => {
    const bounds = window.getBounds()
    return bounds.x === centered.x + delta.x && bounds.y === centered.y + delta.y
  }, '快速标题栏拖动丢失了 IPC 返回前的指针位移')
  const draggedBounds = window.getBounds()
  const draggedNativeBounds = readNativeTransitionStatus(window).parentRect
  assert.equal(draggedBounds.width, centeredBounds.width, '标题栏拖动改变了 Electron 窗口宽度')
  assert.equal(draggedBounds.height, centeredBounds.height, '标题栏拖动改变了 Electron 窗口高度')
  assert.equal(
    draggedNativeBounds.right - draggedNativeBounds.left,
    centeredNativeBounds.right - centeredNativeBounds.left,
    '标题栏拖动改变了窗口物理宽度'
  )
  assert.equal(
    draggedNativeBounds.bottom - draggedNativeBounds.top,
    centeredNativeBounds.bottom - centeredNativeBounds.top,
    '标题栏拖动改变了窗口物理高度'
  )

  const clickScreen = {
    x: centered.x + delta.x + point.x,
    y: centered.y + delta.y + point.y
  }
  await window.webContents.executeJavaScript(`(() => {
    const titlebar = document.querySelector('.app-titlebar')
    const click = (pointerId) => {
      const init = {
        bubbles: true,
        button: 0,
        pointerId,
        pointerType: 'mouse',
        clientX: ${point.x},
        clientY: ${point.y},
        screenX: ${clickScreen.x},
        screenY: ${clickScreen.y}
      }
      titlebar.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }))
      titlebar.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }))
    }
    click(72)
    click(73)
    return true
  })()`)
  await waitUntil(
    async () => (await readState(window)).phase === 'compact',
    '标题栏顶部空白带真实双击没有收起为胶囊'
  )
  await window.webContents.executeJavaScript(`window.api.exitCompactWindow()`)
  await waitUntil(
    async () => (await readState(window)).phase === 'expanded',
    '标题栏交互测试后没有恢复主视图'
  )
}

async function runActionBarAccessibilityTest(window) {
  if (requestedView !== 'list') return
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(`(() => {
        const scene = document.querySelector('.app-scene')
        const actionBar = document.querySelector('.ab-root')
        return scene && !scene.inert && actionBar?.dataset.phase === 'collapsed'
      })()`),
    '操作栏无障碍测试前主场景没有恢复交互'
  )
  const hintPoint = await window.webContents.executeJavaScript(`(() => {
    const hint = document.querySelector('.ab-inline-hint--new')
    const rect = hint.getBoundingClientRect()
    hint.focus()
    return { x: Math.floor(rect.left + rect.width / 2), y: Math.floor(rect.top + rect.height / 2) }
  })()`)
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    ...hintPoint,
    button: 'left',
    clickCount: 1
  })
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    ...hintPoint,
    button: 'left',
    clickCount: 1
  })
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector('.ab-root')?.dataset.phase !== 'collapsed'`
      ),
    '操作栏提示按钮没有开始展开面板'
  )
  const focusState = await window.webContents.executeJavaScript(`(() => {
    const hint = document.querySelector('.ab-inline-hint--new')
    const active = document.activeElement
    return {
      hintHidden: hint.getAttribute('aria-hidden'),
      hintStillFocused: active === hint,
      activeClass: active?.className || ''
    }
  })()`)
  assert.equal(focusState.hintHidden, 'true', '操作栏展开后提示按钮没有退出无障碍树')
  assert.equal(focusState.hintStillFocused, false, '操作栏提示按钮隐藏后仍保留焦点')
  assert.match(focusState.activeClass, /ab-box-btn/, '操作栏没有把焦点转移到可见的折叠按钮')
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector('.ab-root')?.dataset.phase === 'open'`
      ),
    '操作栏无障碍测试中面板没有完成展开'
  )
  await window.webContents.executeJavaScript(
    `document.querySelector('.ab-box-btn:not(.ab-btn-fixed--right)').click()`
  )
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(
        `document.querySelector('.ab-root')?.dataset.phase === 'collapsed'`
      ),
    '操作栏无障碍测试后面板没有恢复折叠'
  )
}

async function runViewReplacementTest(window) {
  if (requestedView !== 'list') return { window, root: viewConfig.root, scene: viewConfig.scene }
  const oldId = window.id
  const hooks = globalThis.__ABANDON_COMPACT_TEST_HOOKS__
  hooks.openExpandedMainWindowFromTray()
  await waitUntil(
    async () => (await readState(window)).phase === 'expanded' && window.isVisible(),
    '托盘打开主窗口没有退出胶囊状态'
  )
  assert.equal(window.id, oldId, '托盘打开主窗口不应替换当前 HWND')
  await window.webContents.executeJavaScript('window.api.enterCompactWindow()')
  await waitUntil(
    async () => (await readState(window)).phase === 'compact',
    '托盘打开主窗口测试后无法再次进入胶囊'
  )
  assert.equal(await hooks.switchMainViewFromTray('month'), true, '托盘未能从胶囊切换月视图')
  const replacement = await waitUntil(
    () => getMainWindow('month.html'),
    '托盘切换后没有创建新的月视图'
  )
  await waitUntil(() => window.isDestroyed(), '旧列表主窗口没有销毁')
  await waitUntil(
    async () => (await readState(replacement)).phase === 'expanded' && replacement.isVisible(),
    '替换后的月视图没有恢复主视图状态'
  )
  assert.notEqual(replacement.id, oldId, '视图替换没有创建目标视图 HWND')
  assert.ok(replacement.getBounds().width >= 240, '托盘视图切换后仍保留胶囊宽度')
  assert.ok(replacement.getBounds().height >= 240, '托盘视图切换后仍保留胶囊高度')
  assertOnlyOneBrowserWindow(replacement, '托盘视图替换')
  await assertRendererSurface(replacement, replacement.getBounds(), 'expanded', '托盘视图替换', {
    root: '.month-root',
    scene: '.month-scene'
  })
  await assertZOrderMode(replacement, '托盘视图替换')
  assertBlurRuntimeHealthy('托盘视图替换')
  await replacement.webContents.executeJavaScript('window.api.enterCompactWindow()')
  await waitUntil(
    async () => (await readState(replacement)).phase === 'compact',
    '托盘视图切换测试后无法再次进入胶囊'
  )
  return { window: replacement, root: '.month-root', scene: '.month-scene' }
}

async function runCompactWindowTest() {
  let exitCode = 0
  try {
    assert.ok(existsSync(nativeDllPath), `未找到原生测试 DLL：${nativeDllPath}`)
    assert.equal(loadNative().getAbiVersion(), NATIVE_ABI_VERSION, '原生 DLL ABI 与当前代码不一致')
    let mainWindow = await waitUntil(
      () => getMainWindow(),
      `${requestedView} 主窗口没有创建`,
      12_000
    )

    if (notificationLaunch) {
      await waitUntil(
        async () => (await readState(mainWindow)).phase === 'expanded' && mainWindow.isVisible(),
        '通知冷启动没有展开同一个主窗口',
        12_000
      )
      assertOnlyOneBrowserWindow(mainWindow, '通知冷启动')
      const expandedBounds = mainWindow.getBounds()
      assert.deepEqual(
        { width: expandedBounds.width, height: expandedBounds.height },
        getDefaultExpandedSize(),
        '通知冷启动没有恢复当前工作区对应的默认展开尺寸'
      )
      await assertRendererSurface(mainWindow, mainWindow.getBounds(), 'expanded', '通知冷启动')
      report('compact single-window notification cold-start integration passed')
      return
    }

    await waitUntil(
      async () => (await readState(mainWindow)).phase === 'expanded' && mainWindow.isVisible(),
      '旧灵动岛状态冷启动后没有显示主视图'
    )
    assertOnlyOneBrowserWindow(mainWindow, '主视图冷启动')
    const startupExpandedBounds = mainWindow.getBounds()
    assert.deepEqual(
      { width: startupExpandedBounds.width, height: startupExpandedBounds.height },
      getDefaultExpandedSize(),
      '旧灵动岛状态冷启动后没有恢复展开尺寸'
    )
    await assertRendererSurface(mainWindow, startupExpandedBounds, 'expanded', '主视图冷启动')
    const startupDb = new Database(join(testUserData, 'app.db'), { readonly: true })
    const startupCompactEnabled = startupDb
      .prepare(
        `SELECT value FROM app_settings WHERE window_name = 'application' AND type = 'compact' AND key = 'enabled'`
      )
      .get()?.value
    startupDb.close()
    assert.equal(startupCompactEnabled, 'false', '旧灵动岛启动标记没有被清除')

    if (coldBlurOff) {
      // 不先调用 setBlurConfig；第一下直接收起，避免开关操作掩盖首次初始化错误。
      await runTransitionAndAssertSynchronizedGeometry({
        window: mainWindow,
        invoke: () => mainWindow.webContents.executeJavaScript('window.api.enterCompactWindow()'),
        finalPhase: 'compact',
        label: 'cold-blur-off-first-collapse',
        expectOverlay: false
      })
      await runTransitionAndAssertSynchronizedGeometry({
        window: mainWindow,
        invoke: () => mainWindow.webContents.executeJavaScript('window.api.exitCompactWindow()'),
        finalPhase: 'expanded',
        label: 'cold-blur-off-first-expand',
        expectOverlay: false
      })
      report(`${requestedView} cold start with blur disabled: first double-click round-trip passed`)
    }

    await mainWindow.webContents.executeJavaScript('window.api.enterCompactWindow()')

    await waitUntil(
      async () => (await readState(mainWindow)).phase === 'compact' && mainWindow.isVisible(),
      '主视图启动后无法手动进入胶囊状态'
    )
    assertOnlyOneBrowserWindow(mainWindow, '手动进入胶囊')
    const initialWindowId = mainWindow.id
    const startupCompactBounds = mainWindow.getBounds()
    assert.deepEqual(
      { width: startupCompactBounds.width, height: startupCompactBounds.height },
      { width: 200, height: 40 }
    )
    assert.equal(mainWindow.isMovable(), true, '胶囊错误继承了主窗口锁定')
    await assertRendererSurface(mainWindow, startupCompactBounds, 'compact', '手动进入胶囊')
    const startupRenderer = await assertCompactContent(mainWindow, startupCompactBounds)
    await assertZOrderMode(mainWindow, '手动进入胶囊')
    assertBlurRuntimeHealthy('手动进入胶囊')

    if (process.argv.includes('diagnostics-only')) {
      await mainWindow.webContents.executeJavaScript('window.api.exitCompactWindow()')
      const area = screen.getDisplayMatching(mainWindow.getBounds()).workArea
      mainWindow.setBounds({
        x: area.x + 100,
        y: area.y + 56,
        width: 480,
        height: Math.min(936, area.height - 60)
      })
      await mainWindow.webContents.executeJavaScript(`Promise.all([
        window.api.setSettingValue('window.compact.width', 192),
        window.api.setSettingValue('window.compact.height', 69)
      ])`)
      await wait(300)
      for (const enabled of [false, true]) {
        await mainWindow.webContents.executeJavaScript(
          `window.api.setBlurConfig({ enabled: ${enabled} })`
        )
        for (const [action, phase] of [
          ['enter', 'collapsing'],
          ['exit', 'expanding']
        ]) {
          await mainWindow.webContents.executeJavaScript(`window.api.${action}CompactWindow()`)
          const handoff = await waitUntil(async () => {
            const logs = await mainWindow.webContents.executeJavaScript(
              "window.api.queryLogs({ search: 'compact-window.handoff-diagnostics', limit: 1 })"
            )
            const item = logs.items[0]?.metadata
            return item?.phase === phase &&
              item.reason === 'settled' &&
              item.samples.at(-1)?.native?.overlayExpected === enabled
              ? item
              : null
          }, `missing ${phase} handoff diagnostics (blur ${enabled})`)
          const samples = handoff.samples
          assert.equal(samples[0].stage, 'before-handoff')
          assert.equal(samples[0].opacity, 0)
          assert.equal(samples[0].native.shellPrepared, true)
          assert.deepEqual(
            samples[0].native.overlayRect,
            samples[0].native.parentRect,
            '普通材质到交接前仍然停留在旧坐标'
          )
          assert.equal(samples[0].native.visualWidth, handoff.target.width)
          assert.equal(samples[0].native.visualHeight, handoff.target.height)
          const released = samples.find((sample) => sample.stage === 'shell-released')
          assert.equal(released.opacity, 1)
          assert.equal(released.native.shellPrepared, false)
          assert.equal(released.native.shellVisible, false)
          assert.equal(samples.at(-1).stage, 'tail-200')
          assert.ok(
            samples.every((sample) => !sample.native.timing && Number.isFinite(sample.readMs))
          )
          const renderer = await waitUntil(async () => {
            const logs = await mainWindow.webContents.executeJavaScript(
              "window.api.queryLogs({ search: 'compact-window.renderer-diagnostics', limit: 5 })"
            )
            return logs.items.find((item) => item.metadata.generation === handoff.generation)
              ?.metadata
          }, 'missing corresponding renderer tail')
          const tail = renderer.frames.filter(
            (frame) => frame.stage === 'stable' && frame.event === 'raf'
          )
          assert.ok(tail.length > 0)
          assert.ok(tail.every((frame) => Number.isFinite(frame.screenX) && frame.layers?.island))
          assert.ok(renderer.frames.length <= 256)
          assert.equal(renderer.reason, 'stable')
          report(
            `${requestedView} ${phase} handoff/tail diagnostics passed (blur ${enabled}), max read ${Math.max(...samples.map((s) => s.readMs)).toFixed(2)}ms`
          )
        }
      }
      // 与首次显示走相同的延后恢复入口，且不需要用户再点毛玻璃开关。
      for (let cycle = 0; cycle < 3; cycle++) {
        mainWindow.hide()
        mainWindow.show()
        await waitUntil(async () => {
          const logs = await mainWindow.webContents.executeJavaScript(
            "window.api.queryLogs({ search: 'blur.visible-restore', limit: 1 })"
          )
          return (
            logs.items[0]?.metadata?.deferred &&
            !logs.items[0].metadata.failed &&
            readNativeTransitionStatus(mainWindow).overlayVisible
          )
        }, '窗口重新显示后毛玻璃未恢复')
        assertBlurRuntimeHealthy('延后恢复')
      }
      await assertDiagnosticExport(mainWindow)
      return
    }

    if (process.argv.includes('layout-only')) {
      await runCompactLayoutTest(mainWindow)
      await assertDiagnosticExport(mainWindow)
      return
    }

    if (process.argv.includes('shell-only')) {
      if (!coldBlurOff) {
        const beforeWarmup = mainWindow.getBounds()
        await waitUntil(async () => {
          const logs = await mainWindow.webContents.executeJavaScript(
            "window.api.queryLogs({ scope: 'compact-window.warmup', limit: 5 })"
          )
          return logs.items.some((item) => item.metadata?.ready)
        }, '首次动画之前未完成隐藏资源预热')
        assert.deepEqual(mainWindow.getBounds(), beforeWarmup)
        assert.equal(readNativeTransitionStatus(mainWindow).shellPrepared, false)
        assert.equal(readNativeTransitionStatus(mainWindow).shellVisible, false)
        report(`${requestedView} hidden shell warmup preserved stable window`)
      }
      if (process.argv.includes('handoff-checks')) {
        for (const enabled of [false, true]) {
          await mainWindow.webContents.executeJavaScript(
            `window.api.setBlurConfig({ enabled: ${enabled} })`
          )
          await runHandoffReadbackChecks(mainWindow)
        }
      }
      // 模拟原窗口透明度切换失败：必须回滚、释放 Overlay，后续还能再次展开。
      const beforeFailure = mainWindow.getBounds()
      const setOpacity = mainWindow.setOpacity.bind(mainWindow)
      mainWindow.setOpacity = (value) => {
        if (value === 0) throw new Error('injected shell presentation failure')
        return setOpacity(value)
      }
      await mainWindow.webContents.executeJavaScript(
        'window.api.exitCompactWindow().catch(() => null)'
      )
      mainWindow.setOpacity = setOpacity
      assert.equal(mainWindow.getOpacity(), 1)
      assert.deepEqual(mainWindow.getBounds(), beforeFailure)
      assert.equal(readNativeTransitionStatus(mainWindow).shellPrepared, false)
      assert.equal((await readState(mainWindow)).phase, 'compact')
      for (const enabled of [false, true]) {
        await mainWindow.webContents.executeJavaScript(
          `window.api.setBlurConfig({ enabled: ${enabled} })`
        )
        const cycles = process.argv.includes('shell-stress') ? 8 : 2
        for (let cycle = 0; cycle < cycles; cycle += 1) {
          await runTransitionAndAssertSynchronizedGeometry({
            window: mainWindow,
            invoke: () =>
              mainWindow.webContents.executeJavaScript('window.api.exitCompactWindow()'),
            finalPhase: 'expanded',
            label: `shell-${enabled}-${cycle}-expand`,
            expectOverlay: enabled
          })
          await runTransitionAndAssertSynchronizedGeometry({
            window: mainWindow,
            invoke: () =>
              mainWindow.webContents.executeJavaScript('window.api.enterCompactWindow()'),
            finalPhase: 'compact',
            label: `shell-${enabled}-${cycle}-collapse`,
            expectOverlay: enabled
          })
        }
      }
      await assertDiagnosticExport(mainWindow)
      if (requestedView === 'list') {
        // 复用过的临时原生外壳也必须随旧主视图释放，新 HWND 能重新创建外壳。
        const replacement = await runViewReplacementTest(mainWindow)
        mainWindow = replacement.window
        await runTransitionAndAssertSynchronizedGeometry({
          window: mainWindow,
          invoke: () => mainWindow.webContents.executeJavaScript('window.api.exitCompactWindow()'),
          finalPhase: 'expanded',
          label: 'shell-after-view-replacement',
          expectOverlay: true,
          selectors: replacement
        })
      }
      report(
        `${requestedView} composition shell, blur on/off, stable carrier and single resize passed`
      )
      return
    }

    await runTransitionAndAssertSynchronizedGeometry({
      window: mainWindow,
      invoke: () =>
        mainWindow.webContents.executeJavaScript(`(() => {
          document.querySelector('.compact-island').dispatchEvent(
            new MouseEvent('dblclick', { bubbles: true })
          )
          return true
        })()`),
      finalPhase: 'expanded',
      label: '胶囊展开',
      expectOverlay: requestedView === 'list' && !coldBlurOff,
      captureSurface: true
    })
    assert.equal(mainWindow.id, initialWindowId)
    assert.equal(mainWindow.isMovable(), false, '展开后没有恢复主窗口锁定')
    await assertZOrderMode(mainWindow, '主视图展开')
    assertBlurRuntimeHealthy('主视图展开')
    await runSettingsPanelOpeningTest(mainWindow)
    await runBlurDisabledTransitionTest(mainWindow)
    await runTitlebarInteractionTest(mainWindow)
    await runActionBarAccessibilityTest(mainWindow)
    const expandedBounds = mainWindow.getBounds()

    await mainWindow.webContents.executeJavaScript(
      `Promise.all([
        window.api.setSettingValue('window.compact.width', 420),
        window.api.setSettingValue('window.compact.height', 92)
      ])`
    )
    const duplicateCollapse = await mainWindow.webContents.executeJavaScript(
      `Promise.all([window.api.enterCompactWindow(), window.api.enterCompactWindow()])`
    )
    assert.ok(duplicateCollapse.some((result) => result.changed === true))
    await waitUntil(
      async () => (await readState(mainWindow)).phase === 'compact',
      '重复收起没有收口'
    )
    const resizedCompactBounds = mainWindow.getBounds()
    assert.equal(resizedCompactBounds.width, 420)
    assert.equal(resizedCompactBounds.height, 92)
    assert.equal(resizedCompactBounds.y, expandedBounds.y, '收起后上边线没有与主视图重合')
    const compactCenterX = resizedCompactBounds.x + resizedCompactBounds.width / 2
    const expandedCenterX = expandedBounds.x + expandedBounds.width / 2
    assert.ok(
      Math.abs(compactCenterX - expandedCenterX) <= 0.5,
      `收起后没有落在主视图上边中心：compact=${compactCenterX}, expanded=${expandedCenterX}`
    )
    await assertRendererSurface(mainWindow, resizedCompactBounds, 'compact', '主视图收起')
    await assertCompactContent(mainWindow, resizedCompactBounds, startupRenderer.textFontSize)

    const beforeSingleClick = mainWindow.getBounds()
    mainWindow.webContents.sendInputEvent({
      type: 'mouseDown',
      x: beforeSingleClick.width - 30,
      y: Math.floor(beforeSingleClick.height / 2),
      button: 'left',
      clickCount: 1
    })
    mainWindow.webContents.sendInputEvent({
      type: 'mouseUp',
      x: beforeSingleClick.width - 30,
      y: Math.floor(beforeSingleClick.height / 2),
      button: 'left',
      clickCount: 1
    })
    await wait(520)
    assert.deepEqual(mainWindow.getBounds(), beforeSingleClick, '单击胶囊仍会恢复默认尺寸')
    assert.equal((await readState(mainWindow)).phase, 'compact')

    const dragPoint = {
      x: beforeSingleClick.width - 30,
      y: Math.floor(beforeSingleClick.height / 2)
    }
    const dragStartedAt = Date.now()
    mainWindow.webContents.sendInputEvent({
      type: 'mouseDown',
      ...dragPoint,
      button: 'left',
      clickCount: 1
    })
    await waitUntil(
      async () => (await readState(mainWindow)).phase === 'dragging',
      '胶囊按下后没有立即进入拖动'
    )
    assert.ok(Date.now() - dragStartedAt < 220, '胶囊拖动仍有长按延迟')
    mainWindow.webContents.sendInputEvent({
      type: 'mouseUp',
      ...dragPoint,
      button: 'left',
      clickCount: 1
    })
    await waitUntil(
      async () => (await readState(mainWindow)).phase === 'compact',
      '胶囊松开后没有结束拖动'
    )

    const originalSetBounds = mainWindow.setBounds.bind(mainWindow)
    let injectedResizeFailure = false
    report('expected fault injection: compact resize rollback begins')
    mainWindow.setBounds = (bounds, animate) => {
      if (!injectedResizeFailure && bounds.width > resizedCompactBounds.width) {
        injectedResizeFailure = true
        throw new Error('injected:test-only compact resize failure')
      }
      return originalSetBounds(bounds, animate)
    }
    const failedResize = await mainWindow.webContents.executeJavaScript(
      `window.api.setSettingValue('window.compact.width', 500).then(
        () => ({ rejected: false }),
        (error) => ({ rejected: true, message: String(error?.message || error) })
      )`
    )
    mainWindow.setBounds = originalSetBounds
    assert.equal(failedResize.rejected, true, '胶囊 setBounds 失败后设置仍提交成功')
    assert.match(failedResize.message, /injected:test-only compact resize failure|尺寸调整失败/)
    assert.deepEqual(mainWindow.getBounds(), resizedCompactBounds, '尺寸失败后没有回滚')
    report('expected fault injection passed: compact resize rolled back')

    await mainWindow.webContents.executeJavaScript(
      `Promise.all([
        window.api.setSettingValue('window.compact.width', 20),
        window.api.setSettingValue('window.compact.height', 20)
      ])`
    )
    await waitUntil(
      () => mainWindow.getBounds().width === 100 && mainWindow.getBounds().height === 40,
      '小于下限的输入没有修正到 100×40'
    )
    const minimumBounds = mainWindow.getBounds()
    await assertRendererSurface(mainWindow, minimumBounds, 'compact', '最小胶囊')
    await assertCompactContent(mainWindow, minimumBounds, startupRenderer.textFontSize)

    const firstNote = await mainWindow.webContents.executeJavaScript(
      `window.api.createNote({ content: '单窗口胶囊状态切换测试 A' })`
    )
    const secondNote = await mainWindow.webContents.executeJavaScript(
      `window.api.createNote({ content: '${'单窗口胶囊单行截断测试 '.repeat(18)}' })`
    )
    assert.ok(firstNote.id && secondNote.id)
    await waitUntil(
      () =>
        mainWindow.webContents.executeJavaScript(
          `document.querySelector('.compact-island__content')?.dataset.noteId === '${secondNote.id}'`
        ),
      '胶囊没有显示最新进行中便签'
    )
    const narrowUi = await mainWindow.webContents.executeJavaScript(`(() => {
      const ring = document.querySelector('.compact-island__status-ring')
      const text = document.querySelector('.compact-island__text')
      const ringRect = ring.getBoundingClientRect()
      const textRect = text.getBoundingClientRect()
      return {
        ringWidth: getComputedStyle(ring).width,
        ringHeight: getComputedStyle(ring).height,
        ringOpacity: getComputedStyle(ring).opacity,
        ringLeft: ringRect.left,
        ringRight: ringRect.right,
        textLeft: textRect.left,
        viewportWidth: document.documentElement.clientWidth,
        textOverflow: getComputedStyle(text).textOverflow,
        whiteSpace: getComputedStyle(text).whiteSpace,
        textFontSize: getComputedStyle(text).fontSize
      }
    })()`)
    assert.equal(narrowUi.ringWidth, '24px')
    assert.equal(narrowUi.ringHeight, '24px')
    assert.equal(narrowUi.ringOpacity, '1')
    assert.ok(narrowUi.ringLeft >= 0 && narrowUi.ringRight <= narrowUi.viewportWidth)
    assert.ok(narrowUi.ringRight <= narrowUi.textLeft, '状态圆环没有位于正文左侧')
    assert.equal(narrowUi.textOverflow, 'ellipsis')
    assert.equal(narrowUi.whiteSpace, 'nowrap')
    assert.equal(narrowUi.textFontSize, startupRenderer.textFontSize)

    await mainWindow.webContents.executeJavaScript(
      `document.querySelector('.compact-island__status-ring .sr-control').click()`
    )
    await waitUntil(
      () =>
        mainWindow.webContents.executeJavaScript(
          `document.querySelector('.compact-island')?.classList.contains('is-status-playing')`
        ),
      '胶囊完成状态没有播放全局扫描动画'
    )
    await waitUntil(
      () =>
        mainWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.compact-note-forward-enter-active'))`
        ),
      '完成便签后没有播放新旧正文单向换入动画',
      4_000
    )
    await waitUntil(
      () =>
        mainWindow.webContents.executeJavaScript(
          `document.querySelector('.compact-island__content')?.dataset.noteId === '${firstNote.id}'`
        ),
      '完成后没有切换到下一条进行中便签',
      4_000
    )

    await mainWindow.webContents.executeJavaScript(
      `Promise.all([
        window.api.setSettingValue('window.compact.width', 420),
        window.api.setSettingValue('window.compact.height', 92)
      ])`
    )
    await waitUntil(
      () => mainWindow.getBounds().width === 420 && mainWindow.getBounds().height === 92,
      '胶囊从最小尺寸拉大后唯一 BrowserWindow 没有恢复'
    )
    await assertCompactContent(mainWindow, mainWindow.getBounds(), startupRenderer.textFontSize)

    await mainWindow.webContents.executeJavaScript(
      `window.api.setSettingValue('css.fontSizeBase', 21)`
    )
    await waitUntil(
      () =>
        mainWindow.webContents.executeJavaScript(
          `getComputedStyle(document.querySelector('.compact-island__text')).fontSize === '21px'`
        ),
      '运行期间修改全局字号后胶囊仍使用旧字号'
    )

    globalThis.__ABANDON_COMPACT_TEST_HOOKS__.handleDisplayTopologyChange({
      eventName: 'display-metrics-changed',
      displayId: null,
      changedMetrics: ['workArea']
    })
    await waitUntil(
      async () => (await readState(mainWindow)).phase === 'compact',
      '显示器拓扑处理破坏了胶囊稳定状态'
    )
    assert.equal(mainWindow.getBounds().width, 420)
    assert.equal(mainWindow.getBounds().height, 92)

    await runRepeatedTransitionStress(
      mainWindow,
      requestedView === 'list' ? 4 : 2,
      requestedView === 'list'
    )

    const replacement = await runViewReplacementTest(mainWindow)
    mainWindow = replacement.window
    await runTransitionAndAssertSynchronizedGeometry({
      window: mainWindow,
      invoke: () => mainWindow.webContents.executeJavaScript(`window.api.exitCompactWindow()`),
      finalPhase: 'expanded',
      label: '最终展开',
      expectOverlay: requestedView === 'list' ? true : false,
      captureSurface: true,
      selectors: replacement
    })
    await assertRendererSurface(
      mainWindow,
      mainWindow.getBounds(),
      'expanded',
      '最终展开',
      replacement
    )
    const db = new Database(join(testUserData, 'app.db'), { readonly: true })
    const compactRows = db
      .prepare(
        `SELECT key, value FROM app_settings WHERE window_name = 'application' AND type = 'compact'`
      )
      .all()
    db.close()
    assert.equal(compactRows.find((row) => row.key === 'enabled')?.value, 'false')
    assert.equal(compactRows.find((row) => row.key === 'width')?.value, '420')
    assert.equal(compactRows.find((row) => row.key === 'height')?.value, '92')

    report(`compact single-window integration passed (${requestedView})`)
  } catch (error) {
    console.error(error)
    const failedWindow = getApplicationWindows()[0]
    if (failedWindow) {
      report(JSON.stringify(readNativeTransitionStatus(failedWindow)))
      report(
        JSON.stringify(
          await failedWindow.webContents.executeJavaScript(
            `window.api.queryLogs({ scope: 'compact-window.renderer-diagnostics', limit: 2 })`
          )
        )
      )
    }
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

const testUserData = mkdtempSync(
  join(tmpdir(), `abandon-note-compact-window-${requestedView}-e2e-`)
)

// 只在专项测试中模拟一次首次配置失败，验证用户无需先开毛玻璃即可重试初始化。
if (process.argv.includes('fail-first-blur-config')) {
  const originalLoad = koffi.load.bind(koffi)
  let failed = false
  koffi.load = (...loadArgs) => {
    const library = originalLoad(...loadArgs)
    const originalFunc = library.func.bind(library)
    library.func = (...funcArgs) => {
      const fn = originalFunc(...funcArgs)
      if (funcArgs[0] !== 'Blur_ApplyConfig') return fn
      return (...args) => {
        if (!failed) {
          failed = true
          return 0
        }
        return fn(...args)
      }
    }
    return library
  }
}

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
