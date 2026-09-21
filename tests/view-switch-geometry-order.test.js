import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const MAIN_PROCESS_PATH = new URL('../src/main/index.js', import.meta.url)

describe('主视图复用窗口切换', () => {
  it('persists source geometry before reusing the existing BrowserWindow', () => {
    const source = readFileSync(MAIN_PROCESS_PATH, 'utf8')
    const geometryBlock = source.slice(
      source.indexOf('function debouncedSaveGeometry() {'),
      source.indexOf('/** 恢复默认时忽略程序化缩放触发的 resize')
    )
    const switchBlock = source.slice(
      source.indexOf('function switchMainView(targetMode) {'),
      source.indexOf('function rebuildTrayMenu()')
    )

    expect(geometryBlock).toContain('if (switchingMainView) return')
    expect(switchBlock).toContain('geometryDirty && mainWindow && !mainWindow.isDestroyed()')
    expect(switchBlock).toContain('prepareViewSettingsForSwitch({')
    expect(switchBlock.indexOf('restoreDockWindowToVisiblePosition()')).toBeLessThan(
      switchBlock.indexOf('prepareViewSettingsForSwitch({')
    )
    expect(switchBlock).toContain('const reusedWindow = mainWindow')
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
    expect(switchBlock.indexOf('if (nativeEdgeCleanupPending)')).toBeLessThan(
      switchBlock.indexOf('endTitlebarWindowDrag()')
    )
  })
})
