import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const MAIN_PROCESS_PATH = new URL('../src/main/index.js', import.meta.url)
const LIST_APP_PATH = new URL('../src/renderer/src/App.vue', import.meta.url)
const MONTH_APP_PATH = new URL('../src/renderer/src/MonthApp.vue', import.meta.url)
const PRESENTATION_PATH = new URL(
  '../src/renderer/src/components/system/WindowPresentation.vue',
  import.meta.url
)
const COMPACT_ISLAND_PATH = new URL(
  '../src/renderer/src/components/system/CompactIsland.vue',
  import.meta.url
)
const TITLEBAR_PATH = new URL(
  '../src/renderer/src/components/system/AppTitlebar.vue',
  import.meta.url
)
const RESIZE_HANDLES_PATH = new URL(
  '../src/renderer/src/components/system/ResizeHandles.vue',
  import.meta.url
)
const SETTINGS_PANEL_PATH = new URL(
  '../src/renderer/src/components/system/SettingsPanel.vue',
  import.meta.url
)

describe('single-window presentation architecture', () => {
  it('commits compact and expanded bounds once without creating another BrowserWindow', () => {
    const source = readFileSync(MAIN_PROCESS_PATH, 'utf8')
    const transaction = source.slice(
      source.indexOf('async function performPresentationModeCommit'),
      source.indexOf('async function recoverExpandedPresentation')
    )
    const windowCreation = source.slice(
      source.indexOf('function createWindow('),
      source.indexOf('function setDockPosition(')
    )

    expect((source.match(/new BrowserWindow\(/g) || []).length).toBe(1)
    expect(windowCreation).toContain('presentationModeController.initialize(mainWindow)')
    expect(transaction).not.toContain('new BrowserWindow(')
    expect(transaction).not.toContain('setShape(')
    expect(transaction).not.toContain('requestAnimationFrame')
    expect(transaction).not.toContain('setInterval(')
    expect(transaction).not.toContain('transitionend')
    expect((transaction.match(/window\.setBounds\(/g) || []).length).toBe(2)
    expect(transaction.indexOf("hideWindowForPresentationCommit(window, 'compact')")).toBeLessThan(
      transaction.indexOf('window.setBounds(stableCompactBounds, false)')
    )
    expect(transaction.indexOf("hideWindowForPresentationCommit(window, 'expanded')")).toBeLessThan(
      transaction.indexOf('window.setBounds(expandedBounds, false)')
    )
  })

  it('persists compact size only and keeps view switching on the reused window', () => {
    const source = readFileSync(MAIN_PROCESS_PATH, 'utf8')
    const resizePersistence = source.slice(
      source.indexOf('function persistCompactWindowSize('),
      source.indexOf('const scheduleVisibleBlurRestore')
    )
    const switchView = source.slice(
      source.indexOf('async function switchMainView(targetMode)'),
      source.indexOf('async function switchMainViewFromTray')
    )
    const dockGeometryReconciliation = source.slice(
      source.indexOf('function scheduleDockGeometryReconciliation()'),
      source.indexOf('function createStableDockBounds(')
    )

    expect(resizePersistence).toContain("id: 'window.compactWidth'")
    expect(resizePersistence).toContain("id: 'window.compactHeight'")
    expect(resizePersistence).toContain("flushCompactWindowSizePersistence('pointer-finish')")
    expect(resizePersistence).not.toContain('geometry.posX')
    expect(resizePersistence).not.toContain('geometry.posY')
    expect(source).toContain('scheduleCompactWindowSizePersistence(stableCompactBounds)')
    expect(source).toContain(
      'writeApplicationSettings(applicationEntries.map(({ id, value }) => ({ id, value })))'
    )
    expect(dockGeometryReconciliation).toContain('if (isCompactPresentationActive()) return')
    expect(
      dockGeometryReconciliation.indexOf('if (isCompactPresentationActive()) return')
    ).toBeLessThan(dockGeometryReconciliation.indexOf('const bounds = mainWindow.getBounds()'))
    const realResizeListener = source.slice(
      source.indexOf("mainWindow.on('resize', () =>"),
      source.indexOf("mainWindow.on('move', () =>")
    )
    expect(realResizeListener).toContain('presentationModeController.isCompact()')
    expect(realResizeListener).toContain('stableCompactBounds = { ...mainWindow.getBounds() }')
    expect(realResizeListener).toContain(
      'scheduleCompactWindowSizePersistence(stableCompactBounds)'
    )
    expect(switchView).toContain("exitCompactPresentation({ source: 'view-switch'")
    expect(switchView).toContain('const reusedWindow = mainWindow')
    expect(switchView).not.toContain('createWindow(')
    expect(switchView).not.toContain('.destroy()')
  })

  it('acknowledges only after the compact scene has mounted and shares the window radius', () => {
    const presentation = readFileSync(PRESENTATION_PATH, 'utf8')
    const island = readFileSync(COMPACT_ISLAND_PATH, 'utf8')
    const titlebar = readFileSync(TITLEBAR_PATH, 'utf8')

    expect(presentation).toContain('<CompactIsland')
    expect(presentation).toContain('v-if="!expanded"')
    expect(presentation).toContain('await nextTick()')
    expect(presentation).toContain('requestAnimationFrame(() => requestAnimationFrame(resolve))')
    expect(presentation).toContain('window.api.notifyPresentationRendererReady(operationId)')
    expect(presentation).toContain(':ready="!operation"')
    expect(presentation).not.toContain('getComputedStyle(document.body).fontSize')
    expect(island).toContain('border-radius: var(--window-radius)')
    expect(island).toContain('exitCompactPresentation()')
    expect(island).not.toContain('exitCompactPresentation(anchor)')
    expect(island).toContain('@dblclick="onDoubleClick"')
    expect(island).toContain('suppressDoubleClickUntil = now + 500')
    expect(island).toContain("'is-ready': ready")
    expect(island).toContain(
      'animation: compact-island-content-enter var(--motion-panel) var(--ease-standard) both'
    )
    expect(island).toContain('@keyframes compact-island-content-enter')
    expect(island).toContain('font-size: var(--compact-content-font-size)')
    expect(island).toContain('justify-content: flex-start')
    expect(island).not.toContain('prefers-reduced-motion')
    expect(titlebar).toContain('const anchor = compactAnchor(event)')
    expect(titlebar).not.toContain('titlebarCenterOffsetY')
    expect(titlebar).toContain(".finally(() => emit('request:compact', anchor))")
  })

  it('keeps real-edge resizing captured until its final persistence commit', () => {
    const resizeHandles = readFileSync(RESIZE_HANDLES_PATH, 'utf8')
    const settingsPanel = readFileSync(SETTINGS_PANEL_PATH, 'utf8')

    expect(resizeHandles).toContain('@pointerdown="onPointerDown($event,')
    expect(resizeHandles).toContain('setPointerCapture?.(pointerId)')
    expect(resizeHandles).toContain("window.addEventListener('pointermove', onPointerMove, true)")
    expect(resizeHandles).toContain("window.addEventListener('blur', finishResize)")
    expect(resizeHandles).not.toContain("window.addEventListener('blur', finishResize, true)")
    expect(resizeHandles).toContain('@lostpointercapture="onLostPointerCapture"')
    expect(resizeHandles).not.toContain('@lostpointercapture="finishResize"')
    expect(resizeHandles).toContain('继续使用窗口级监听')
    expect(resizeHandles).toContain('window.api.setWindowBounds({ x, y, width, height })')
    expect(resizeHandles).toContain('window.api.finishWindowResize()')
    expect(resizeHandles).toContain('onBeforeUnmount(() => finishResize())')
    expect(settingsPanel).not.toContain('aria-label="灵动岛宽度"')
    expect(settingsPanel).not.toContain('aria-label="灵动岛高度"')
  })

  it('keeps titlebar dragging alive when Windows z-order work releases DOM pointer capture', () => {
    const titlebar = readFileSync(TITLEBAR_PATH, 'utf8')
    const main = readFileSync(MAIN_PROCESS_PATH, 'utf8')

    expect(titlebar).toContain(
      "window.addEventListener('pointermove', onTitlebarPointerMove, true)"
    )
    expect(titlebar).toContain("window.addEventListener('pointerup', onTitlebarPointerUp, true)")
    expect(titlebar).toContain('@lostpointercapture="onTitlebarLostPointerCapture"')
    expect(titlebar).not.toContain('@lostpointercapture="finishTitlebarPointer"')
    expect(titlebar).toContain("window.addEventListener('blur', onTitlebarWindowBlur)")
    expect(titlebar).not.toContain("window.addEventListener('blur', onTitlebarWindowBlur, true)")
    expect(titlebar).toContain('继续使用窗口级监听')
    expect(titlebar).toContain("scope: 'titlebar.drag.renderer'")
    expect(titlebar).toContain('hasPointerCapture')
    expect(titlebar).toContain("finishTitlebarPointer(event, 'pointercancel')")
    expect(main).toContain("logger.info('titlebar.drag-lifecycle'")
    expect(main).toContain('nativeZOrderBeforeReassert')
    expect(main).toContain('nativeZOrderAfterReassert')
  })

  it('keeps locked windows expanded and explains why compact mode is unavailable', () => {
    const main = readFileSync(MAIN_PROCESS_PATH, 'utf8')
    const listApp = readFileSync(LIST_APP_PATH, 'utf8')
    const monthApp = readFileSync(MONTH_APP_PATH, 'utf8')
    const message = '窗口已锁定：切换为灵动岛会改变窗口位置和尺寸，请先解锁'
    const enterCompact = main.slice(
      main.indexOf('function enterCompactPresentation(anchor)'),
      main.indexOf('function exitCompactPresentation')
    )

    expect(enterCompact).toContain('if (isLocked)')
    expect(enterCompact).toContain(message)
    for (const source of [listApp, monthApp]) {
      const requestCompact = source.slice(
        source.indexOf('async function requestCompactPresentation(anchor)'),
        source.indexOf('/** 主页面壁纸') >= 0
          ? source.indexOf('/** 主页面壁纸')
          : source.indexOf('function onCalendarWorkspaceReady')
      )
      expect(requestCompact).toContain('if (locked.value)')
      expect(requestCompact).toContain(message)
      expect(requestCompact.indexOf('if (locked.value)')).toBeLessThan(
        requestCompact.indexOf('if (compactBlocked.value)')
      )
    }
  })

  it('keeps compact dragging alive when Windows releases DOM pointer capture', () => {
    const compactIsland = readFileSync(COMPACT_ISLAND_PATH, 'utf8')

    expect(compactIsland).toContain("window.addEventListener('pointermove', onPointerMove, true)")
    expect(compactIsland).toContain("window.addEventListener('pointerup', finishPointer, true)")
    expect(compactIsland).toContain('@lostpointercapture="onLostPointerCapture"')
    expect(compactIsland).not.toContain('@lostpointercapture="finishPointer"')
    expect(compactIsland).toContain("window.addEventListener('blur', finishPointer)")
    expect(compactIsland).not.toContain("window.addEventListener('blur', finishPointer, true)")
    expect(compactIsland).toContain('继续使用窗口级监听')
  })

  it('discards renderer acknowledgements after a presentation transaction settles', () => {
    const source = readFileSync(MAIN_PROCESS_PATH, 'utf8')
    const broadcaster = source.slice(
      source.indexOf('function broadcastPresentationModeState()'),
      source.indexOf('function acknowledgePresentationRenderer')
    )

    expect(broadcaster).toContain(
      'if (!presentationModeController.operation) acknowledgedPresentationOperations.clear()'
    )
  })
})
