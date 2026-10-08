import { describe, expect, it } from 'vitest'
import {
  normalizeUiScale,
  resolveSettingsRows,
  serializeSetting
} from '../src/shared/settings-schema.js'
import { applySettingsSnapshot } from '../src/renderer/src/utils/applySettingsSnapshot.js'

describe('application UI scale', () => {
  it('retains supported stored scales and falls back for corrupt or missing values', () => {
    for (const value of [undefined, null, '', -1, 0, 200, 'oops', 1.15])
      expect(normalizeUiScale(value)).toBe(1)
    expect(normalizeUiScale('1.25')).toBe(1.25)
    expect(serializeSetting('appearance.uiScale', 1.5).value).toBe('1.5')
    expect(
      resolveSettingsRows([{ type: 'appearance', key: 'ui_scale', value: '1.5' }]).appearance
        .uiScale
    ).toBe(1.5)
  })
  it('applies one scale without changing native radii, independent fonts or user typography', () => {
    const values = resolveSettingsRows([{ type: 'appearance', key: 'ui_scale', value: '1.25' }])
    const css = new Map()
    const root = {
      style: { setProperty: (key, value) => css.set(key, value) },
      classList: { toggle() {} }
    }
    applySettingsSnapshot({ values }, root)
    expect(css.get('--ui-scale')).toBe('1.25')
    expect(css.get('--font-size-base')).toBe(`${values.css.fontSizeBase}rem`)
    expect(css.get('--compact-content-font-size')).toBe(`${values.window.compactFontSize}px`)
    expect(css.get('--window-radius')).toBe(`${values.blur.cornerRadius}px`)
  })
})
