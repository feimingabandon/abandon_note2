import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  resolveSettingsRows,
  serializeSetting
} from '../src/shared/settings-schema.js'

describe('titlebar appearance setting', () => {
  it('defaults to Apple and persists either supported visual style', () => {
    expect(DEFAULT_SETTINGS.appearance.titlebarStyle).toBe('apple')
    expect(serializeSetting('appearance.titlebarStyle', 'microsoft')).toMatchObject({
      type: 'appearance',
      key: 'titlebar_style',
      value: 'microsoft'
    })
  })

  it('falls back to Apple for an unknown persisted style', () => {
    expect(
      resolveSettingsRows([
        { type: 'appearance', key: 'titlebar_style', value: 'unsupported-style' }
      ]).appearance.titlebarStyle
    ).toBe('apple')
  })
})

describe('sticky default settings schema', () => {
  it('provides stable defaults for newly created sticky windows', () => {
    expect(DEFAULT_SETTINGS.sticky).toEqual({
      fontSize: 16,
      backgroundColor: '#fff2a8',
      cornerRadius: 0,
      alwaysOnTop: false
    })
  })

  it('serializes sticky settings into dedicated database keys', () => {
    expect(serializeSetting('sticky.fontSize', 22)).toMatchObject({
      type: 'sticky',
      key: 'sticky_font_size',
      value: '22'
    })
    expect(serializeSetting('sticky.backgroundColor', '#D4EAFF')).toMatchObject({
      type: 'sticky',
      key: 'sticky_background_color',
      value: '#d4eaff'
    })
    expect(serializeSetting('sticky.cornerRadius', 18)).toMatchObject({
      type: 'sticky',
      key: 'sticky_corner_radius',
      value: '18'
    })
    expect(serializeSetting('sticky.alwaysOnTop', true)).toMatchObject({
      type: 'sticky',
      key: 'sticky_always_on_top',
      value: 'true'
    })
  })

  it('resolves persisted values and clamps invalid numeric ranges', () => {
    const resolved = resolveSettingsRows([
      { type: 'sticky', key: 'sticky_font_size', value: '27' },
      { type: 'sticky', key: 'sticky_background_color', value: '#FFD4E1' },
      { type: 'sticky', key: 'sticky_corner_radius', value: '99' },
      { type: 'sticky', key: 'sticky_always_on_top', value: '1' }
    ])

    expect(resolved.sticky).toEqual({
      fontSize: 27,
      backgroundColor: '#ffd4e1',
      cornerRadius: 32,
      alwaysOnTop: true
    })
  })
})
