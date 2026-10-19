import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const MAIN_PROCESS_PATH = new URL('../src/main/index.js', import.meta.url)

describe('主视图复用窗口切换', () => {
  it('persists source geometry before reusing the existing BrowserWindow', () => {
    const source = readFileSync(MAIN_PROCESS_PATH, 'utf8')
    const geometryBlock = source.slice(
      source.indexOf('const geometryPersistence = createWindowGeometryPersistence({'),
      source.indexOf('function debouncedSaveGeometry() {')
    )
    const navigation = readFileSync(
      new URL('../src/main/windows/main-view-navigation.js', import.meta.url),
      'utf8'
    )
    const start = navigation.indexOf('async function switchMainView(targetMode) {')
    const end = navigation.indexOf('async function switchMainViewFromTray', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const switchBlock = navigation.slice(start, end)

    expect(geometryBlock).toContain(
      '!mainViewNavigation.isSwitching() && !isCompactPresentationActive()'
    )
    expect(switchBlock).toContain('const pendingGeometry = geometryPersistence.readPendingBounds()')
    expect(switchBlock).toContain('prepareViewSettingsForSwitch({')
    expect(switchBlock.indexOf('dockRuntime.restoreDockWindowToVisiblePosition()')).toBeLessThan(
      switchBlock.indexOf('prepareViewSettingsForSwitch({')
    )
    expect(switchBlock).toContain('const reusedWindow = getMainWindow()')
    expect(switchBlock).toContain('hideMainWindowForViewNavigation(reusedWindow)')
    expect(switchBlock).toContain('await presentActiveViewInExistingWindow(reusedWindow')
    expect(switchBlock).not.toContain('createWindow(')
    expect(switchBlock).not.toContain('.destroy()')
    expect(switchBlock).not.toContain('destroyBlurRuntimeForWindowReplacement')
    expect(switchBlock.indexOf('prepareViewSettingsForSwitch({')).toBeLessThan(
      switchBlock.indexOf('hideMainWindowForViewNavigation(reusedWindow)')
    )
    expect(switchBlock.indexOf('prepareViewSettingsForSwitch({')).toBeLessThan(
      switchBlock.indexOf('activeViewMode = normalized')
    )
    expect(switchBlock.indexOf('activeViewMode = normalized')).toBeLessThan(
      switchBlock.indexOf('await presentActiveViewInExistingWindow(reusedWindow')
    )
    expect(switchBlock.indexOf('if (dockRuntime.cleanupStatus)')).toBeLessThan(
      switchBlock.indexOf('endTitlebarWindowDrag()')
    )
  })
})
