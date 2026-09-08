import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const MAIN_PATH = new URL('../src/main/index.js', import.meta.url)

describe('native blur settings main-process wiring', () => {
  it('reapplies the native material when its CSS-derived tint settings change', () => {
    const source = readFileSync(MAIN_PATH, 'utf8')
    const persistSettings = source.slice(
      source.indexOf('function persistSettingValues'),
      source.indexOf('function persistSettingValue(')
    )

    expect(persistSettings).toContain("id.startsWith('blur.')")
    expect(persistSettings).toContain("id === 'css.bgColor'")
    expect(persistSettings).toContain("id === 'css.windowOpacity'")
    expect(persistSettings).toContain('if (applyBlurRuntime && changesBlurRuntime)')
    expect(persistSettings).toContain('applyResolvedBlurRuntime()')
  })
})
