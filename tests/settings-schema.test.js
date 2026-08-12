import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  createDefaultSettings,
  resolveSettingsRows,
  serializeSetting,
  VIEW_MODES
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

describe('view-specific defaults', () => {
  it('keeps list geometry and panel defaults separate from month view', () => {
    const list = createDefaultSettings(VIEW_MODES.LIST)
    const month = createDefaultSettings(VIEW_MODES.MONTH)

    expect(list.geometry).toMatchObject({ widthRatio: 0.25, heightRatio: 0.9 })
    expect(list.ui.settingsPanelSize).toBe(70)
    expect(month.geometry).toMatchObject({ widthRatio: 0.7, heightRatio: 0.7 })
    expect(month.ui.settingsPanelSize).toBe(40)
    expect(month.ui.dayPanelSize).toBe(25)
  })

  it('uses the same native glass defaults for list and month views', () => {
    const list = createDefaultSettings(VIEW_MODES.LIST)
    const month = createDefaultSettings(VIEW_MODES.MONTH)

    expect(list.css.windowOpacity).toBe(0.3)
    expect(month.css.windowOpacity).toBe(0.3)
    expect(list.blur.radius).toBe(12)
    expect(month.blur.radius).toBe(12)
  })

  it('persists and clamps each view panel size', () => {
    expect(serializeSetting('ui.settingsPanelSize', 120)).toMatchObject({
      type: 'ui',
      key: 'settings_panel_size',
      value: '95'
    })
    expect(
      resolveSettingsRows(
        [{ type: 'ui', key: 'settings_panel_size', value: '31' }],
        VIEW_MODES.MONTH
      ).ui.settingsPanelSize
    ).toBe(31)
    expect(serializeSetting('ui.dayPanelSize', 99)).toMatchObject({
      type: 'ui',
      key: 'day_panel_size',
      value: '50'
    })
    expect(
      resolveSettingsRows([{ type: 'ui', key: 'day_panel_size', value: '19' }], VIEW_MODES.MONTH).ui
        .dayPanelSize
    ).toBe(25)
  })
})

describe('CSS blur setting', () => {
  it('keeps persisted UI blur at or above the 5px readability floor', () => {
    const resolved = resolveSettingsRows([{ type: 'css', key: 'bg_blur', value: '0' }])

    expect(resolved.css.bgBlur).toBe(5)
    expect(DEFAULT_SETTINGS.css.bgBlur).toBe(10)
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

describe('list filter setting', () => {
  it('persists the tag-group list mode and falls back for unknown modes', () => {
    expect(
      resolveSettingsRows([
        {
          type: 'filter',
          key: 'list_filter',
          value: JSON.stringify({
            listMode: 'tag-group',
            tagIds: [12],
            statusFilter: ['in_progress']
          })
        }
      ]).listFilter
    ).toEqual({
      listMode: 'tag-group',
      tagIds: [12],
      statusFilter: ['in_progress']
    })

    expect(
      resolveSettingsRows([
        {
          type: 'filter',
          key: 'list_filter',
          value: JSON.stringify({ listMode: 'unknown' })
        }
      ]).listFilter.listMode
    ).toBe('timeline')
  })
})

describe('weather settings', () => {
  it('keeps weather disabled until a valid local location is selected', () => {
    expect(DEFAULT_SETTINGS.weather).toEqual({ enabled: false, location: null })
    expect(serializeSetting('weather.enabled', true)).toMatchObject({
      type: 'weather',
      key: 'enabled',
      value: 'true'
    })
  })

  it('normalizes persisted WGS84 coordinates and rejects invalid locations', () => {
    const location = {
      id: 1816670,
      name: '北京',
      admin1: '北京市',
      admin2: '',
      country: '中国',
      countryCode: 'cn',
      latitude: 39.9041999,
      longitude: 116.4073963,
      timezone: 'Asia/Shanghai'
    }
    expect(JSON.parse(serializeSetting('weather.location', location).value)).toMatchObject({
      name: '北京',
      countryCode: 'CN',
      latitude: 39.9042,
      longitude: 116.4074
    })
    expect(
      serializeSetting('weather.location', { name: '错误', latitude: 190, longitude: 0 }).value
    ).toBeNull()
  })

  it('restores the complete saved city information from a database row', () => {
    const location = {
      id: null,
      name: '广州市',
      admin1: '广东省',
      admin2: '',
      country: '中华人民共和国',
      countryCode: 'CN',
      latitude: 23.28224,
      longitude: 113.66902,
      timezone: 'Asia/Shanghai'
    }
    const persisted = serializeSetting('weather.location', location)

    expect(
      resolveSettingsRows([{ type: persisted.type, key: persisted.key, value: persisted.value }])
        .weather.location
    ).toEqual(location)
  })
})
