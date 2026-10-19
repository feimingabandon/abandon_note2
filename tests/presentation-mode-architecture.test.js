import { readFileSync } from 'node:fs'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
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

const readMainOwner = (path) =>
  readFileSync(new URL('../src/main/' + path, import.meta.url), 'utf8')
function functionSource(source, name) {
  let found
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) found = node
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parse(source, { sourceType: 'module' }).program)
  expect(found, 'actual function must exist: ' + name).toBeTruthy()
  return source.slice(found.start, found.end)
}

describe('single-window presentation architecture', () => {
  it('never captures a later lexical runtime alias eagerly during entry assembly', () => {
    const source = readFileSync(MAIN_PROCESS_PATH, 'utf8')
    const eagerReferences = []
    const traverse = traverseModule.default ?? traverseModule
    traverse(parse(source, { sourceType: 'module' }), {
      ReferencedIdentifier(path) {
        // Function bodies retain providers for later operation; direct arguments are eager.
        if (path.getFunctionParent()) return
        const binding = path.scope.getBinding(path.node.name)
        if (!binding || binding.kind === 'hoisted' || binding.path.node.start <= path.node.start)
          return
        eagerReferences.push({ name: path.node.name, line: path.node.loc.start.line })
      }
    })
    expect(eagerReferences).toEqual([])
    expect(source).toContain('initialViewMode: VIEW_MODES.LIST')
  })

  it('commits compact and expanded bounds once without creating another BrowserWindow', () => {
    const source = readFileSync(MAIN_PROCESS_PATH, 'utf8')
    const host = readMainOwner('windows/main-window-host.js')
    const runtime = readMainOwner('windows/presentation-runtime.js')
    const transaction = functionSource(runtime, 'performPresentationModeCommit')
    const windowCreation = functionSource(source, 'createWindow')

    expect((host.match(/new BrowserWindow\(/g) || []).length).toBe(1)
    expect(source).not.toContain('new BrowserWindow(')
    expect(windowCreation).toContain(
      'presentationRuntime.initialize(getMainWindow(), normalBounds)'
    )
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
    const runtime = readMainOwner('windows/presentation-runtime.js')
    const navigation = readMainOwner('windows/main-view-navigation.js')
    const writes = readMainOwner('settings/settings-write-coordinator.js')
    const dock = readMainOwner('window-motion/dock-runtime.js')
    const resizePersistence = [
      'persistCompactWindowSize',
      'flushCompactWindowSizePersistence',
      'finishCompactWindowResize'
    ]
      .map((name) => functionSource(runtime, name))
      .join('\n')
    const switchView = functionSource(navigation, 'switchMainView')
    const dockGeometryReconciliation = functionSource(dock, 'scheduleDockGeometryReconciliation')

    expect(resizePersistence).toContain("id: 'window.compactWidth'")
    expect(resizePersistence).toContain("id: 'window.compactHeight'")
    expect(resizePersistence).toContain("flushCompactWindowSizePersistence('pointer-finish')")
    expect(resizePersistence).not.toContain('geometry.posX')
    expect(resizePersistence).not.toContain('geometry.posY')
    expect(functionSource(runtime, 'handleResize')).toContain(
      'scheduleCompactWindowSizePersistence(stableCompactBounds)'
    )
    expect(writes).toContain(
      'writeApplicationSettings(applicationEntries.map(({ id, value }) => ({ id, value })))'
    )
    expect(dockGeometryReconciliation).toContain('if (isCompactPresentationActive()) return')
    expect(
      dockGeometryReconciliation.indexOf('if (isCompactPresentationActive()) return')
    ).toBeLessThan(dockGeometryReconciliation.indexOf('const bounds = getMainWindow().getBounds()'))
    const realWindow = functionSource(source, 'createWindow')
    expect(realWindow).toContain('presentationRuntime.handleResize(getMainWindow().getBounds())')
    const resizeHandler = functionSource(runtime, 'handleResize')
    expect(resizeHandler).toContain('presentationModeController.isCompact()')
    expect(resizeHandler).toContain('stableCompactBounds = { ...bounds }')
    expect(resizeHandler).toContain('scheduleCompactWindowSizePersistence(stableCompactBounds)')
    expect(switchView).toContain("exitCompactPresentation({ source: 'view-switch'")
    expect(switchView).toContain('const reusedWindow = getMainWindow()')
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
    const drag = readMainOwner('windows/window-drag-controller.js')
    expect(main).toContain('begin: beginTitlebarWindowDrag')
    expect(main).toContain('} = windowDragController')
    expect(main).toContain('beginTitlebarWindowDrag(payload.point, payload.diagnostics)')
    expect(drag).toContain("logger.info('titlebar.drag-lifecycle'")
    expect(drag).toContain('nativeZOrderBeforeReassert')
    expect(drag).toContain('nativeZOrderAfterReassert')
  })

  it('keeps locked windows expanded and explains why compact mode is unavailable', () => {
    const main = readFileSync(MAIN_PROCESS_PATH, 'utf8')
    const listApp = readFileSync(LIST_APP_PATH, 'utf8')
    const monthApp = readFileSync(MONTH_APP_PATH, 'utf8')
    const message = '窗口已锁定：切换为灵动岛会改变窗口位置和尺寸，请先解锁'
    const enterCompact = functionSource(
      readMainOwner('windows/presentation-runtime.js'),
      'enterCompactPresentation'
    )
    expect(main).toContain('isWindowLocked: () => isLocked')

    expect(enterCompact).toContain('if (isWindowLocked())')
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
    const broadcaster = functionSource(
      readMainOwner('windows/presentation-runtime.js'),
      'broadcastPresentationModeState'
    )

    expect(broadcaster).toContain(
      'if (!presentationModeController.operation) acknowledgedPresentationOperations.clear()'
    )
  })
})
