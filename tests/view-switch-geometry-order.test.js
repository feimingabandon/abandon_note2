import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const MAIN_PROCESS_PATH = new URL('../src/main/index.js', import.meta.url)

describe('主视图切换几何收敛顺序', () => {
  it('persists pending source geometry before initializing target settings', () => {
    const source = readFileSync(MAIN_PROCESS_PATH, 'utf8')
    const geometryBlock = source.slice(
      source.indexOf('const debouncedSaveGeometry = () => {'),
      source.indexOf('// 监听窗口大小变化和移动事件')
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
    expect(switchBlock.indexOf('prepareViewSettingsForSwitch({')).toBeLessThan(
      switchBlock.indexOf('mainWindow.hide()')
    )
    expect(switchBlock.indexOf('prepareViewSettingsForSwitch({')).toBeLessThan(
      switchBlock.indexOf('activeViewMode = normalized')
    )
  })
})
