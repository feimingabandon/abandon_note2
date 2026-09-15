import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const url = (path) => new URL(path, import.meta.url)
const read = (path) => readFileSync(url(path), 'utf8')

describe('compact fixed-carrier architecture', () => {
  it('uses one BrowserWindow and pre-mounts both presentations', () => {
    const main = read('../src/main/index.js')
    const scene = read('../src/renderer/src/components/system/CompactWindowScene.vue')
    const config = read('../electron.vite.config.mjs')

    expect(main.match(/new BrowserWindow\(/g)).toHaveLength(1)
    expect(main).toContain('function getActiveVisualWindow()')
    expect(main).toContain('return mainWindow')
    expect(main).not.toContain('let compactWindow = null')
    expect(scene).toContain("import CompactIsland from './CompactIsland.vue'")
    expect(scene).toContain('<slot />')
    expect(scene).toContain('<CompactIsland :phase="phase" />')
    expect(config).not.toContain('compact.html')
    expect(existsSync(url('../src/renderer/src/CompactApp.vue'))).toBe(false)
  })

  it('keeps BrowserWindow bounds fixed while visibility animates', () => {
    const main = read('../src/main/index.js')
    const block = main.slice(
      main.indexOf('function fullCarrierRect'),
      main.indexOf('function beginTitlebarWindowDrag')
    )

    expect(block).toContain('window.setShape([')
    expect(block).toContain('applyCompactWindowShape(window, presentation.expanded)')
    expect(block).toContain('applyCompactWindowShape(window, presentation[to])')
    expect(block).toContain('blurAnimatePresentation(')
    expect(block).not.toContain('.setBounds(')
    expect(block).not.toContain('.setSize(')
    expect(block).not.toContain('setTransitionStage')
    expect(block).not.toContain('transitionend')
  })

  it('runs one WAAPI timeline and sends one generation acknowledgement', () => {
    const scene = read('../src/renderer/src/components/system/CompactWindowScene.vue')
    const preload = read('../src/preload/index.js')
    const main = read('../src/main/index.js')

    expect(scene).toContain('root.animate(')
    expect(scene).toContain('expandedLayer.animate(')
    expect(scene).toContain('compactLayer.animate(')
    expect(scene).toContain('animation.finished')
    expect(scene).toContain('duration + 300')
    expect(scene).not.toContain('@transitionend')
    expect(preload).toContain(
      "ipcRenderer.send('compact-window:presentation-finished', generation)"
    )
    expect(main).toContain("ipcMain.on('compact-window:presentation-finished'")
    expect(main).toContain('COMPACT_PRESENTATION.guardMs')
  })

  it('animates only the existing native overlay clip and has no transition shell', () => {
    const api = read('../native_blur/blur_api.h')
    const engine = read('../native_blur/blur_engine.cpp')
    const bridge = read('../src/main/bridge/blur_bridge.js')
    const cmake = read('../native_blur/CMakeLists.txt')

    expect(api).toContain('BLUR_API int Blur_AnimatePresentation(')
    expect(api).toContain('BLUR_API void Blur_ResetPresentation(void)')
    expect(engine).toContain('m_clipGeometry.StartAnimation(L"Offset"')
    expect(engine).toContain('m_clipGeometry.StartAnimation(L"Size"')
    expect(engine).toContain('CreateScopedBatch(CompositionBatchTypes::Animation)')
    expect(bridge).toContain('lib.Blur_AnimatePresentation.async(')
    expect(cmake).not.toContain('transition_engine')
    for (const source of [api, engine, bridge]) {
      expect(source).not.toContain('WindowTransition_')
      expect(source).not.toContain('AbandonTransitionShell')
      expect(source).not.toContain('m_shell')
    }
    expect(existsSync(url('../native_blur/transition_engine.cpp'))).toBe(false)
    expect(existsSync(url('../native_blur/transition_engine.h'))).toBe(false)
  })

  it('keeps runtime state independent from persisted compact mode and view replacement', () => {
    const main = read('../src/main/index.js')
    const persist = main.slice(
      main.indexOf('function persistCompactWindowBounds'),
      main.indexOf('function syncCompactWindowRuntime')
    )
    const create = main.slice(
      main.indexOf('function createWindow({ preferredDisplay = null } = {})'),
      main.indexOf('// ---- 初始化系统模糊 ----')
    )

    expect(read('../src/shared/settings-schema.js')).not.toContain('window.compact.enabled')
    expect(read('../src/main/db/db-schema.js')).toContain(
      "DELETE FROM app_settings WHERE type = 'compact' AND key = 'enabled'"
    )
    expect(persist).not.toContain('window.compact.enabled')
    expect(create).toContain('compactWindowController.initializeForWindow(createdWindow)')
    expect(create).toContain(
      'applyCompactWindowShape(createdWindow, fullCarrierRect(normalBounds))'
    )
    expect(main).toContain('新视图固定从 expanded 稳定态启动')
  })

  it('retains notification and tray recovery through the unconditional expanded request', () => {
    const main = read('../src/main/index.js')
    expect(main).toContain('await requestCompactMode(COMPACT_WINDOW_MODES.EXPANDED)')
    expect(main).toContain('openExpandedMainWindowFromTray')
    expect(main).toContain('expandCompactWindowForNotification()')
    expect(main).toContain('switchMainViewFromTray(targetMode)')
  })

  it('contains none of the retired stage, shell, or diagnostic modules', () => {
    for (const path of [
      '../src/main/windows/compact-intent.js',
      '../src/main/windows/compact-presentation-waiters.js',
      '../src/main/windows/compact-target-frame.js',
      '../src/main/windows/compact-transition-settle.js',
      '../src/main/windows/compact-motion-policy.js',
      '../src/main/logging/compact-handoff-diagnostics.js',
      '../src/main/logging/compact-diagnostics.js',
      '../src/renderer/src/composables/compact-transition-diagnostics.js',
      '../src/renderer/src/components/system/compact-stage-completion.js'
    ]) {
      expect(existsSync(url(path))).toBe(false)
    }

    const combined = [
      read('../src/main/index.js'),
      read('../src/preload/index.js'),
      read('../src/renderer/src/components/system/CompactWindowScene.vue')
    ].join('\n')
    for (const retired of [
      'CONTENT_EXIT',
      'TARGET_LAYOUT',
      'CONTENT_ENTER',
      'compact-window:transition-ready',
      'compact-window:diagnostics'
    ]) {
      expect(combined).not.toContain(retired)
    }
  })
})
