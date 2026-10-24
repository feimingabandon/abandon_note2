import { describe, expect, it } from 'vitest'
import {
  APPLICATION_SETTING_DEFINITIONS,
  APPLICATION_SETTING_IDS,
  DEFAULT_SETTINGS,
  DOCK_REVEAL_HANDLE_MODES,
  ICON_COLORS,
  RENDERER_WRITABLE_SETTING_IDS,
  SETTING_DEFINITIONS,
  SETTING_SCOPES,
  SETTING_WRITE_CHANNELS,
  applyApplicationSettings,
  createDefaultSettings,
  projectApplicationSettings,
  resolveSettingsRows,
  serializeSetting,
  VIEW_MODES,
  WINDOW_Z_ORDER_MODES
} from '../src/shared/settings-schema.js'
import { applySettingsSnapshot } from '../src/renderer/src/utils/applySettingsSnapshot.js'

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

  it('persists the shared titlebar icon scale and clamps it to the supported range', () => {
    expect(DEFAULT_SETTINGS.appearance.titlebarIconScale).toBe(100)
    expect(serializeSetting('appearance.titlebarIconScale', 175)).toMatchObject({
      type: 'appearance',
      key: 'titlebar_icon_scale',
      value: '150'
    })
    expect(serializeSetting('appearance.titlebarIconScale', 80).value).toBe('100')
    expect(
      resolveSettingsRows([{ type: 'appearance', key: 'titlebar_icon_scale', value: '135' }])
        .appearance.titlebarIconScale
    ).toBe(135)
  })

  it('persists a shared black or white icon color and rejects unknown values', () => {
    expect(DEFAULT_SETTINGS.appearance.iconColor).toBe(ICON_COLORS.BLACK)
    expect(serializeSetting('appearance.iconColor', ICON_COLORS.WHITE)).toMatchObject({
      type: 'appearance',
      key: 'icon_color',
      value: ICON_COLORS.WHITE
    })
    expect(
      resolveSettingsRows([{ type: 'appearance', key: 'icon_color', value: 'unsupported' }])
        .appearance.iconColor
    ).toBe(ICON_COLORS.BLACK)
  })

  it('maps the titlebar scale to separate Apple and Microsoft size tokens', () => {
    const values = createDefaultSettings()
    values.appearance.titlebarIconScale = 150
    const applied = new Map()
    const attributes = new Map()
    const root = {
      classList: { toggle() {} },
      setAttribute: (name, value) => attributes.set(name, value),
      style: { setProperty: (name, value) => applied.set(name, value) }
    }

    applySettingsSnapshot({ values }, root)

    expect(applied.get('--titlebar-apple-control-size')).toBe('27rem')
    expect(applied.get('--titlebar-apple-icon-size')).toBe('21rem')
    expect(applied.get('--titlebar-microsoft-icon-size')).toBe('22.5rem')
    expect(applied.get('--calendar-toolbar-icon-size')).toBe('25.5rem')
    expect(attributes.get('data-icon-color')).toBe('black')
  })
})

describe('global main-window controls', () => {
  it('defaults calendar quick creation to single day and persists its separate shared switch', () => {
    for (const mode of Object.values(VIEW_MODES)) {
      expect(createDefaultSettings(mode).notes.quickCreateUntilCompleted).toBe(false)
    }
    expect(serializeSetting('notes.quickCreateUntilCompleted', true)).toMatchObject({
      type: 'notes',
      key: 'quick_create_until_completed',
      value: '1'
    })
    expect(serializeSetting('notes.quickCreateUntilCompleted', false).value).toBe('0')
    const quickCreate = resolveSettingsRows([
      { type: 'notes', key: 'quick_create_until_completed', value: '1' }
    ])
    expect(quickCreate.notes.quickCreateUntilCompleted).toBe(true)
    expect(quickCreate.notes.autoMoveToToday).toBe(false)
    const automaticMove = resolveSettingsRows([
      { type: 'notes', key: 'auto_move_to_today', value: '1' },
      { type: 'notes', key: 'quick_create_until_completed', value: 'damaged' }
    ])
    expect(automaticMove.notes.autoMoveToToday).toBe(true)
    expect(automaticMove.notes.quickCreateUntilCompleted).toBe(false)
  })

  it('defaults auto move off and persists a separate key from the retired feature', () => {
    for (const mode of Object.values(VIEW_MODES))
      expect(createDefaultSettings(mode).notes.autoMoveToToday).toBe(false)
    expect(serializeSetting('notes.autoMoveToToday', true)).toMatchObject({
      type: 'notes',
      key: 'auto_move_to_today',
      value: '1'
    })
    expect(
      resolveSettingsRows([{ type: 'notes', key: 'auto_move_to_today', value: '1' }]).notes
        .autoMoveToToday
    ).toBe(true)
    expect(
      resolveSettingsRows([{ type: 'notes', key: 'auto_move_yesterday', value: '1' }]).notes
        .autoMoveToToday
    ).toBe(false)
  })

  it('defaults capture to F1 and ignores the old persistent gate and retired bindings', () => {
    expect(DEFAULT_SETTINGS.shortcuts).toEqual({
      enabled: true,
      viewVisibility: 'F2',
      newNote: 'F3',
      screenshot: 'F1',
      screenshotCopy: 'Control+F1'
    })
    expect(
      resolveSettingsRows([
        { type: 'shortcuts', key: 'enabled', value: '0' },
        { type: 'shortcuts', key: 'screenshot', value: 'F2' },
        { type: 'shortcuts', key: 'clipboard_pin', value: 'F3' },
        { type: 'shortcuts', key: 'toggle_pins', value: 'F4' }
      ]).shortcuts
    ).toEqual({
      enabled: true,
      viewVisibility: 'F2',
      newNote: 'F3',
      screenshot: 'F2',
      screenshotCopy: 'Control+F1'
    })
    expect(serializeSetting('shortcuts.screenshotCopy', 'Ctrl+F3')).toMatchObject({
      type: 'shortcuts',
      key: 'screenshot_copy',
      value: 'Control+F3'
    })
    expect(() => serializeSetting('shortcuts.enabled', false)).toThrow('不持久化')
    expect(() => serializeSetting('shortcuts.clipboardPin', 'F3')).toThrow()
    expect(() => serializeSetting('shortcuts.togglePins', 'F4')).toThrow()
  })

  it('persists the shared view visibility shortcut in a dedicated application key', () => {
    expect(DEFAULT_SETTINGS.shortcuts.viewVisibility).toBe('F2')
    expect(
      resolveSettingsRows([{ type: 'shortcuts', key: 'view_visibility', value: '' }]).shortcuts
        .viewVisibility
    ).toBe('')
    expect(serializeSetting('shortcuts.viewVisibility', 'alt+control+n')).toMatchObject({
      type: 'shortcuts',
      key: 'view_visibility',
      value: 'Control+Alt+N'
    })
    expect(
      resolveSettingsRows([
        { type: 'shortcuts', key: 'view_visibility', value: 'Control+Shift+F11' }
      ]).shortcuts.viewVisibility
    ).toBe('Control+Shift+F11')
  })

  it('uses a three-state z-order setting and normalizes the two legacy boolean values', () => {
    expect(DEFAULT_SETTINGS.window).toEqual({
      lockState: false,
      zOrderMode: WINDOW_Z_ORDER_MODES.TOP,
      compactWidth: 180,
      compactHeight: 48,
      compactFontSize: 17
    })
    expect(serializeSetting('window.zOrderMode', WINDOW_Z_ORDER_MODES.BOTTOM)).toMatchObject({
      type: 'system',
      key: 'z_order_mode',
      value: 'bottom'
    })
    expect(
      resolveSettingsRows([{ type: 'system', key: 'z_order_mode', value: 'true' }]).window
        .zOrderMode
    ).toBe(WINDOW_Z_ORDER_MODES.TOP)
    expect(
      resolveSettingsRows([{ type: 'system', key: 'z_order_mode', value: 'false' }]).window
        .zOrderMode
    ).toBe(WINDOW_Z_ORDER_MODES.NORMAL)
    expect(
      resolveSettingsRows([{ type: 'system', key: 'z_order_mode', value: 'damaged' }]).window
        .zOrderMode
    ).toBe(WINDOW_Z_ORDER_MODES.TOP)
  })

  it('persists compact presentation size and clamps damaged values', () => {
    expect(serializeSetting('window.compactWidth', 999)).toMatchObject({
      type: 'presentation',
      key: 'compact_width',
      value: '720'
    })
    expect(serializeSetting('window.compactHeight', 12)).toMatchObject({
      type: 'presentation',
      key: 'compact_height',
      value: '48'
    })
    expect(
      resolveSettingsRows([
        { type: 'presentation', key: 'compact_width', value: '356' },
        { type: 'presentation', key: 'compact_height', value: '88' }
      ]).window
    ).toMatchObject({ compactWidth: 356, compactHeight: 88 })
    expect(
      resolveSettingsRows([
        { type: 'presentation', key: 'compact_width', value: '-1' },
        { type: 'presentation', key: 'compact_height', value: '9999' }
      ]).window
    ).toMatchObject({ compactWidth: 180, compactHeight: 180 })
  })

  it('persists one shared compact presentation font size', () => {
    expect(serializeSetting('window.compactFontSize', 24)).toMatchObject({
      type: 'presentation',
      key: 'compact_font_size',
      value: '24'
    })
    expect(
      resolveSettingsRows([{ type: 'presentation', key: 'compact_font_size', value: '99' }]).window
        .compactFontSize
    ).toBe(40)
  })
})

describe('view-specific defaults', () => {
  it('keeps list geometry and panel defaults separate from calendar views', () => {
    const list = createDefaultSettings(VIEW_MODES.LIST)
    const month = createDefaultSettings(VIEW_MODES.MONTH)
    const week = createDefaultSettings(VIEW_MODES.WEEK)

    expect(list.geometry).toMatchObject({ widthRatio: 0.25, heightRatio: 0.9 })
    expect(list.ui.settingsPanelSize).toBe(70)
    expect(month.geometry).toMatchObject({ widthRatio: 0.7, heightRatio: 0.7 })
    expect(month.ui.settingsPanelSize).toBe(40)
    expect(month.ui.dayPanelSize).toBe(25)
    expect(week.geometry).toMatchObject({ widthRatio: 0.7, heightRatio: 0.5 })
    expect(week.ui).toMatchObject({ settingsPanelSize: 40, dayPanelSize: 25 })
  })

  it('uses the same native glass defaults for all views', () => {
    const list = createDefaultSettings(VIEW_MODES.LIST)
    const month = createDefaultSettings(VIEW_MODES.MONTH)
    const week = createDefaultSettings(VIEW_MODES.WEEK)

    expect(list.css.windowOpacity).toBe(0.3)
    expect(month.css.windowOpacity).toBe(0.3)
    expect(week.css.windowOpacity).toBe(0.3)
    expect(list.blur.radius).toBe(12)
    expect(month.blur.radius).toBe(12)
    expect(week.blur.radius).toBe(12)
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

describe('dock settings', () => {
  it('preserves the legacy dock behavior as the default for each view', () => {
    expect(createDefaultSettings(VIEW_MODES.LIST).dock).toEqual({
      revealHandleMode: DOCK_REVEAL_HANDLE_MODES.DIRECT,
      enabledEdges: ['left', 'right']
    })
    expect(createDefaultSettings(VIEW_MODES.MONTH).dock).toEqual({
      revealHandleMode: DOCK_REVEAL_HANDLE_MODES.DIRECT,
      enabledEdges: ['top']
    })
    expect(createDefaultSettings(VIEW_MODES.WEEK).dock).toEqual({
      revealHandleMode: DOCK_REVEAL_HANDLE_MODES.DIRECT,
      enabledEdges: ['top']
    })
  })

  it('serializes all reveal modes and the canonical dock edge order', () => {
    expect(
      serializeSetting('dock.revealHandleMode', DOCK_REVEAL_HANDLE_MODES.PERSISTENT)
    ).toMatchObject({
      type: 'dock',
      key: 'dock_reveal_handle_enabled',
      value: 'persistent'
    })
    expect(serializeSetting('dock.enabledEdges', ['right', 'top', 'right', 'left'])).toMatchObject({
      type: 'dock',
      key: 'dock_enabled_edges',
      value: JSON.stringify(['top', 'left', 'right'])
    })
    expect(serializeSetting('dock.enabledEdges', [])).toMatchObject({ value: '[]' })
  })

  it('rejects unsupported edges and uses the current view fallback for damaged rows', () => {
    expect(serializeSetting('dock.enabledEdges', ['top', 'bottom']).value).toBe('[]')
    expect(serializeSetting('dock.enabledEdges', Array(13).fill('top')).value).toBe('[]')
    expect(
      resolveSettingsRows(
        [{ type: 'dock', key: 'dock_enabled_edges', value: '["bottom"]' }],
        VIEW_MODES.LIST
      ).dock.enabledEdges
    ).toEqual(['left', 'right'])
    expect(
      resolveSettingsRows(
        [{ type: 'dock', key: 'dock_enabled_edges', value: 'not-json' }],
        VIEW_MODES.MONTH
      ).dock.enabledEdges
    ).toEqual(['top'])
    expect(
      resolveSettingsRows(
        [
          {
            type: 'dock',
            key: 'dock_enabled_edges',
            value: JSON.stringify(Array(13).fill('left'))
          }
        ],
        VIEW_MODES.WEEK
      ).dock.enabledEdges
    ).toEqual(['top'])
    expect(
      resolveSettingsRows([
        {
          type: 'dock',
          key: 'dock_reveal_handle_positions',
          value: '{"right":0.9}'
        }
      ]).dock
    ).not.toHaveProperty('revealHandlePositions')
  })

  it('migrates legacy booleans, restores all modes and keeps an empty selection', () => {
    expect(
      resolveSettingsRows(
        [
          { type: 'dock', key: 'dock_reveal_handle_enabled', value: 'true' },
          { type: 'dock', key: 'dock_enabled_edges', value: '["right","top"]' }
        ],
        VIEW_MODES.WEEK
      ).dock
    ).toEqual({
      revealHandleMode: DOCK_REVEAL_HANDLE_MODES.ON_TOUCH,
      enabledEdges: ['top', 'right']
    })
    expect(
      resolveSettingsRows(
        [{ type: 'dock', key: 'dock_reveal_handle_enabled', value: 'false' }],
        VIEW_MODES.LIST
      ).dock.revealHandleMode
    ).toBe(DOCK_REVEAL_HANDLE_MODES.DIRECT)
    expect(
      resolveSettingsRows(
        [{ type: 'dock', key: 'dock_reveal_handle_enabled', value: 'persistent' }],
        VIEW_MODES.MONTH
      ).dock.revealHandleMode
    ).toBe(DOCK_REVEAL_HANDLE_MODES.PERSISTENT)
    expect(
      resolveSettingsRows(
        [{ type: 'dock', key: 'dock_enabled_edges', value: '[]' }],
        VIEW_MODES.LIST
      ).dock.enabledEdges
    ).toEqual([])
  })
})

describe('CSS blur setting', () => {
  it('keeps persisted UI blur at or above the 5px readability floor', () => {
    const resolved = resolveSettingsRows([{ type: 'css', key: 'bg_blur', value: '0' }])

    expect(resolved.css.bgBlur).toBe(5)
    expect(DEFAULT_SETTINGS.css.bgBlur).toBe(10)
  })

  it('keeps the optional window border off by default and persists the explicit choice', () => {
    expect(DEFAULT_SETTINGS.css.windowBorder).toBe(false)
    expect(serializeSetting('css.windowBorder', true)).toMatchObject({
      type: 'css',
      key: 'window_border_enabled',
      value: '1'
    })
    expect(
      resolveSettingsRows([{ type: 'css', key: 'window_border_enabled', value: '1' }]).css
        .windowBorder
    ).toBe(true)
  })

  it('maps the window border choice to a layout-neutral CSS width token', () => {
    const values = createDefaultSettings(VIEW_MODES.MONTH)
    const applied = new Map()
    const classes = new Set()
    const root = {
      classList: {
        toggle(name, force) {
          if (force) classes.add(name)
          else classes.delete(name)
        }
      },
      style: {
        setProperty(name, value) {
          applied.set(name, value)
        }
      }
    }

    applySettingsSnapshot({ values }, root)
    expect(applied.get('--window-border-width')).toBe('0px')
    expect(applied.get('--note-remark-font-size')).toBe('19rem')
    expect(applied.get('--compact-content-font-size')).toBe('17px')
    expect(classes.has('is-system-glass-active')).toBe(false)

    applySettingsSnapshot(
      {
        values: { ...values, css: { ...values.css, windowBorder: true } },
        runtime: { blur: { effectiveEnabled: true } }
      },
      root
    )
    expect(applied.get('--window-border-width')).toBe('1px')
    expect(classes.has('is-system-glass-active')).toBe(true)
  })
})

describe('sticky default settings schema', () => {
  it('provides stable defaults for newly created sticky windows', () => {
    expect(DEFAULT_SETTINGS.sticky).toEqual({
      fontSize: 16,
      backgroundColor: '#fff2a8',
      cornerRadius: 0,
      alwaysOnTop: true
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

describe('calendar recurring preview settings schema', () => {
  it('defaults to disabled and serializes as a shared boolean setting row', () => {
    expect(DEFAULT_SETTINGS.calendar.recurringPreviewEnabled).toBe(false)
    expect(serializeSetting('calendar.recurringPreviewEnabled', true)).toMatchObject({
      type: 'calendar',
      key: 'recurring_preview_enabled',
      value: '1'
    })
    expect(
      resolveSettingsRows([{ type: 'calendar', key: 'recurring_preview_enabled', value: 'true' }])
        .calendar.recurringPreviewEnabled
    ).toBe(true)
  })
})

describe('tag color settings schema', () => {
  it('defaults to enabled and serializes as a shared boolean setting row', () => {
    expect(DEFAULT_SETTINGS.notes.tagColorEnabled).toBe(true)
    expect(serializeSetting('notes.tagColorEnabled', false)).toMatchObject({
      type: 'notes',
      key: 'tag_color_enabled',
      value: '0'
    })
    expect(
      resolveSettingsRows([{ type: 'notes', key: 'tag_color_enabled', value: 'false' }]).notes
        .tagColorEnabled
    ).toBe(false)
  })
})

describe('quick note edit settings schema', () => {
  it('defaults to enabled and serializes as a stable setting row', () => {
    expect(DEFAULT_SETTINGS.interaction.doubleClickQuickEdit).toBe(true)
    expect(serializeSetting('interaction.doubleClickQuickEdit', false)).toMatchObject({
      type: 'interaction',
      key: 'double_click_quick_edit',
      value: '0'
    })
    expect(
      resolveSettingsRows([{ type: 'interaction', key: 'double_click_quick_edit', value: 'false' }])
        .interaction.doubleClickQuickEdit
    ).toBe(false)
  })

  it('keeps screenshot main-view visibility configurable across views', () => {
    expect(DEFAULT_SETTINGS.interaction.hideMainViewDuringScreenshot).toBe(false)
    expect(serializeSetting('interaction.hideMainViewDuringScreenshot', true)).toMatchObject({
      type: 'interaction',
      key: 'hide_main_view_during_screenshot',
      value: '1'
    })
    expect(
      resolveSettingsRows([
        { type: 'interaction', key: 'hide_main_view_during_screenshot', value: 'true' }
      ]).interaction.hideMainViewDuringScreenshot
    ).toBe(true)
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

describe('weather and almanac settings', () => {
  it('defaults almanac on and stores its switch independently from weather', () => {
    for (const viewMode of Object.values(VIEW_MODES)) {
      expect(createDefaultSettings(viewMode).almanac.enabled).toBe(true)
    }
    const almanacRow = serializeSetting('almanac.enabled', false)
    const weatherRow = serializeSetting('weather.enabled', true)
    expect(almanacRow).toMatchObject({
      type: 'almanac',
      key: 'almanac_enabled',
      value: 'false'
    })
    expect(almanacRow.key).not.toBe(weatherRow.key)
    const resolved = resolveSettingsRows([almanacRow, weatherRow])
    expect(resolved.almanac.enabled).toBe(false)
    expect(resolved.weather.enabled).toBe(true)
    expect(resolveSettingsRows([{ ...almanacRow, value: 'invalid' }]).almanac.enabled).toBe(true)
  })

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

describe('first-use notice setting', () => {
  it('defaults to unread and persists the acknowledged notice version', () => {
    expect(DEFAULT_SETTINGS.onboarding.noticeVersion).toBe(0)
    expect(serializeSetting('onboarding.noticeVersion', 1)).toMatchObject({
      type: 'onboarding',
      key: 'first_use_notice_version',
      value: '1'
    })
    expect(
      resolveSettingsRows([{ type: 'onboarding', key: 'first_use_notice_version', value: '1' }])
        .onboarding.noticeVersion
    ).toBe(1)
  })
})

describe('calendar font settings', () => {
  it('defaults calendars to 20 and preserves stored font sizes', () => {
    expect(createDefaultSettings(VIEW_MODES.LIST).css.fontSizeBase).toBe(17)
    for (const mode of [VIEW_MODES.MONTH, VIEW_MODES.WEEK]) {
      expect(createDefaultSettings(mode).css.fontSizeBase).toBe(20)
      expect(
        resolveSettingsRows([{ type: 'css', key: 'font_size_base', value: '18' }], mode).css
          .fontSizeBase
      ).toBe(18)
      expect(
        resolveSettingsRows([{ type: 'css', key: 'font_size_base', value: '28' }], mode).css
          .fontSizeBase
      ).toBe(28)
    }
    expect(serializeSetting('css.fontSizeBase', 40).value).toBe('40')
  })

  it('keeps note remark size independent and slightly smaller than body by default', () => {
    expect(createDefaultSettings(VIEW_MODES.LIST).css.noteRemarkFontSize).toBe(16)
    for (const mode of [VIEW_MODES.MONTH, VIEW_MODES.WEEK]) {
      expect(createDefaultSettings(mode).css.noteRemarkFontSize).toBe(19)
      expect(
        resolveSettingsRows([{ type: 'css', key: 'note_remark_font_size', value: '17' }], mode).css
          .noteRemarkFontSize
      ).toBe(17)
    }
    expect(serializeSetting('css.noteRemarkFontSize', 40)).toMatchObject({
      type: 'css',
      key: 'note_remark_font_size',
      value: '40'
    })
  })
  it.each([
    'css.fontSizeBase',
    'css.noteRemarkFontSize',
    'window.compactFontSize',
    'sticky.fontSize'
  ])('accepts and bounds all note font sizes for %s', (id) => {
    for (const value of [8, 9, 17, 39, 40])
      expect(serializeSetting(id, value).value).toBe(String(value))
    expect(serializeSetting(id, 7).value).toBe('8')
    expect(serializeSetting(id, 41).value).toBe('40')
  })
})

describe('list minimal card setting', () => {
  it('defaults off and round trips enabled and disabled values', () => {
    expect(DEFAULT_SETTINGS.listAppearance.minimalMode).toBe(false)
    for (const enabled of [true, false]) {
      const row = serializeSetting('listAppearance.minimalMode', enabled)
      expect(row).toMatchObject({ type: 'notes', key: 'minimal_mode', value: enabled ? '1' : '0' })
      expect(resolveSettingsRows([row]).listAppearance.minimalMode).toBe(enabled)
    }
  })
})

// Fixed contracts from the existing application scope and IPC entrypoints.
// Keep these independent of the schema metadata and its derived collections.
const expectedScopeIds = {
  application: [
    'appearance.uiScale',
    'appearance.titlebarIconScale',
    'appearance.iconColor',
    'shortcuts.viewVisibility',
    'shortcuts.newNote',
    'shortcuts.screenshot',
    'shortcuts.screenshotCopy',
    'calendar.recurringPreviewEnabled',
    'notes.quickCreateUntilCompleted',
    'notes.autoMoveToToday',
    'notes.tagColorEnabled',
    'interaction.doubleClickQuickEdit',
    'interaction.hideMainViewDuringScreenshot',
    'remote.receiveNotices',
    'remote.uploadDeviceInfo',
    'almanac.enabled',
    'weather.enabled',
    'weather.location',
    'onboarding.noticeVersion',
    'window.lockState',
    'window.zOrderMode',
    'window.compactWidth',
    'window.compactHeight',
    'window.compactFontSize'
  ],
  view: [
    'appearance.titlebarStyle',
    'css.bgColor',
    'css.popupOpacity',
    'css.bgBlur',
    'css.windowOpacity',
    'css.windowBorder',
    'css.fontSizeBase',
    'css.noteRemarkFontSize',
    'css.textColor',
    'blur.enabled',
    'blur.radius',
    'blur.saturation',
    'blur.cornerRadius',
    'wallpaper.enabled',
    'wallpaper.activeId',
    'wallpaper.blurRadius',
    'ui.settingsPanelSize',
    'ui.dayPanelSize',
    'listAppearance.minimalMode',
    'dock.revealHandleMode',
    'dock.enabledEdges',
    'sticky.fontSize',
    'sticky.backgroundColor',
    'sticky.cornerRadius',
    'sticky.alwaysOnTop',
    'listFilter',
    'geometry.posX',
    'geometry.posY',
    'geometry.width',
    'geometry.height',
    'geometry.widthRatio',
    'geometry.heightRatio'
  ],
  session: ['shortcuts.enabled']
}

const expectedWriteChannelIds = {
  renderer: [
    'appearance.titlebarStyle',
    'appearance.uiScale',
    'appearance.titlebarIconScale',
    'appearance.iconColor',
    'css.bgColor',
    'css.popupOpacity',
    'css.bgBlur',
    'css.windowOpacity',
    'css.windowBorder',
    'css.fontSizeBase',
    'css.noteRemarkFontSize',
    'css.textColor',
    'sticky.fontSize',
    'sticky.backgroundColor',
    'sticky.cornerRadius',
    'sticky.alwaysOnTop',
    'wallpaper.blurRadius',
    'ui.settingsPanelSize',
    'ui.dayPanelSize',
    'calendar.recurringPreviewEnabled',
    'notes.quickCreateUntilCompleted',
    'notes.autoMoveToToday',
    'notes.tagColorEnabled',
    'listAppearance.minimalMode',
    'interaction.doubleClickQuickEdit',
    'interaction.hideMainViewDuringScreenshot',
    'almanac.enabled',
    'weather.enabled',
    'weather.location',
    'remote.receiveNotices',
    'remote.uploadDeviceInfo',
    'onboarding.noticeVersion',
    'window.compactWidth',
    'window.compactHeight',
    'window.compactFontSize',
    'listFilter'
  ],
  specialized: [
    'shortcuts.enabled',
    'shortcuts.viewVisibility',
    'shortcuts.newNote',
    'shortcuts.screenshot',
    'shortcuts.screenshotCopy',
    'blur.enabled',
    'blur.radius',
    'blur.saturation',
    'blur.cornerRadius',
    'wallpaper.enabled',
    'wallpaper.activeId',
    'window.lockState',
    'window.zOrderMode',
    'dock.revealHandleMode',
    'dock.enabledEdges'
  ],
  main: ['geometry.posX', 'geometry.posY', 'geometry.width', 'geometry.height'],
  none: ['geometry.widthRatio', 'geometry.heightRatio']
}

function sortedIds(ids) {
  return [...ids].sort()
}

describe('setting scope and write channel contracts', () => {
  it('assigns every existing definition its explicit application, view or session scope', () => {
    expect(SETTING_SCOPES).toEqual({
      APPLICATION: 'application',
      VIEW: 'view',
      SESSION: 'session'
    })
    expect(Object.isFrozen(SETTING_SCOPES)).toBe(true)
    expect(SETTING_DEFINITIONS).toHaveLength(57)
    const expectedIds = Object.values(expectedScopeIds).flat()
    expect(new Set(expectedIds).size).toBe(57)
    expect(sortedIds(SETTING_DEFINITIONS.map((definition) => definition.id))).toEqual(
      sortedIds(expectedIds)
    )
    for (const [scope, ids] of Object.entries(expectedScopeIds)) {
      expect(
        sortedIds(
          SETTING_DEFINITIONS.filter((definition) => definition.scope === scope).map(
            (definition) => definition.id
          )
        )
      ).toEqual(sortedIds(ids))
    }
    const session = SETTING_DEFINITIONS.find((definition) => definition.id === 'shortcuts.enabled')
    expect(session.db).toBeUndefined()
    for (const id of ['geometry.widthRatio', 'geometry.heightRatio']) {
      const definition = SETTING_DEFINITIONS.find((candidate) => candidate.id === id)
      expect(definition).toMatchObject({ scope: 'view', writeChannel: 'none', db: null })
    }
  })

  it('preserves the complete generic, specialized, main and read-only entrypoint sets', () => {
    expect(SETTING_WRITE_CHANNELS).toEqual({
      RENDERER: 'renderer',
      SPECIALIZED: 'specialized',
      MAIN: 'main',
      NONE: 'none'
    })
    expect(Object.isFrozen(SETTING_WRITE_CHANNELS)).toBe(true)
    expect(new Set(Object.values(expectedWriteChannelIds).flat()).size).toBe(57)
    for (const [writeChannel, ids] of Object.entries(expectedWriteChannelIds)) {
      expect(
        sortedIds(
          SETTING_DEFINITIONS.filter((definition) => definition.writeChannel === writeChannel).map(
            (definition) => definition.id
          )
        )
      ).toEqual(sortedIds(ids))
    }
    expect(RENDERER_WRITABLE_SETTING_IDS).toHaveLength(36)
    expect(sortedIds(RENDERER_WRITABLE_SETTING_IDS)).toEqual(
      sortedIds(expectedWriteChannelIds.renderer)
    )
    expect(Object.isFrozen(RENDERER_WRITABLE_SETTING_IDS)).toBe(true)
  })

  it('exports exactly the 24 application definitions and IDs as immutable collections', () => {
    expect(APPLICATION_SETTING_DEFINITIONS).toHaveLength(24)
    expect(sortedIds(APPLICATION_SETTING_IDS)).toEqual(sortedIds(expectedScopeIds.application))
    expect(APPLICATION_SETTING_DEFINITIONS.map((definition) => definition.id)).toEqual(
      APPLICATION_SETTING_IDS
    )
    expect(Object.isFrozen(APPLICATION_SETTING_DEFINITIONS)).toBe(true)
    expect(Object.isFrozen(APPLICATION_SETTING_IDS)).toBe(true)
    for (const definition of APPLICATION_SETTING_DEFINITIONS) {
      expect(SETTING_DEFINITIONS).toContain(definition)
      expect(Object.isFrozen(definition)).toBe(true)
      expect(Object.isFrozen(definition.path)).toBe(true)
    }
    expect(APPLICATION_SETTING_IDS).not.toContain('appearance.titlebarStyle')
    expect(APPLICATION_SETTING_IDS).not.toContain('shortcuts.enabled')
    expect(APPLICATION_SETTING_IDS).not.toContain('geometry.widthRatio')
  })

  it('keeps persisted database keys unique without storing session or read-only defaults', () => {
    const persisted = SETTING_DEFINITIONS.filter((definition) => definition.db)
    // app_settings uniqueness uses scope and key, without type.
    expect(persisted).toHaveLength(54)
    expect(new Set(persisted.map((definition) => definition.db.key)).size).toBe(54)
    for (const id of ['shortcuts.enabled', 'geometry.widthRatio', 'geometry.heightRatio']) {
      expect(() => serializeSetting(id, true)).toThrow('不持久化')
    }
  })
})

describe('pure application settings projection and overlay', () => {
  it('projects all application paths without view, session or unknown sibling fields', () => {
    const source = createDefaultSettings(VIEW_MODES.MONTH)
    source.appearance = {
      uiScale: 1.25,
      titlebarStyle: 'microsoft',
      titlebarIconScale: 135,
      iconColor: 'white',
      extra: 'exclude'
    }
    source.shortcuts = {
      enabled: false,
      viewVisibility: 'Ctrl+Alt+Z',
      screenshot: 'F4',
      screenshotCopy: 'Control+F4'
    }
    source.calendar.recurringPreviewEnabled = true
    source.notes = {
      quickCreateUntilCompleted: true,
      autoMoveToToday: false,
      tagColorEnabled: false
    }
    source.interaction = { doubleClickQuickEdit: false, hideMainViewDuringScreenshot: true }
    source.window = {
      lockState: true,
      zOrderMode: 'bottom',
      compactWidth: 350,
      compactHeight: 80,
      compactFontSize: 19,
      extra: 'exclude'
    }
    source.almanac.enabled = false
    source.weather = {
      enabled: true,
      location: { name: 'Projection city', metadata: { label: 'original' } },
      extra: 'exclude'
    }
    source.remote = { receiveNotices: false, uploadDeviceInfo: false }
    source.onboarding.noticeVersion = 0
    source.extra = { value: 'exclude' }
    const original = structuredClone(source)

    const result = projectApplicationSettings(source)

    expect(result).toEqual({
      appearance: { uiScale: 1.25, titlebarIconScale: 135, iconColor: 'white' },
      shortcuts: { viewVisibility: 'Ctrl+Alt+Z', screenshot: 'F4', screenshotCopy: 'Control+F4' },
      calendar: { recurringPreviewEnabled: true },
      notes: { quickCreateUntilCompleted: true, autoMoveToToday: false, tagColorEnabled: false },
      interaction: { doubleClickQuickEdit: false, hideMainViewDuringScreenshot: true },
      window: {
        lockState: true,
        zOrderMode: 'bottom',
        compactWidth: 350,
        compactHeight: 80,
        compactFontSize: 19
      },
      almanac: { enabled: false },
      weather: {
        enabled: true,
        location: { name: 'Projection city', metadata: { label: 'original' } }
      },
      remote: { receiveNotices: false, uploadDeviceInfo: false },
      onboarding: { noticeVersion: 0 }
    })
    result.weather.location.metadata.label = 'changed'
    result.shortcuts.screenshot = 'F9'
    expect(source).toEqual(original)
  })

  it('preserves null, false and zero while omitting undefined without filling defaults', () => {
    expect(
      projectApplicationSettings({
        appearance: { uiScale: undefined },
        shortcuts: { enabled: false },
        weather: { enabled: false, location: null },
        onboarding: { noticeVersion: 0 }
      })
    ).toEqual({ weather: { enabled: false, location: null }, onboarding: { noticeVersion: 0 } })
    expect(projectApplicationSettings({})).toEqual({})
  })

  it('returns a separate overlay preserving view, session and unknown target fields', () => {
    const target = createDefaultSettings(VIEW_MODES.MONTH)
    target.appearance.titlebarStyle = 'microsoft'
    target.shortcuts.enabled = false
    target.geometry.width = 1234
    target.css.fontSizeBase = 22
    target.listFilter.tagIds = [1, 2]
    target.extra = { markers: ['keep'] }
    const application = {
      appearance: { uiScale: 1.5, titlebarStyle: 'apple', extra: 'ignore' },
      shortcuts: { enabled: true },
      geometry: { width: 99 },
      weather: { location: { name: 'New city', metadata: { label: 'fresh' } } },
      extra: { markers: ['ignore'] }
    }
    const originalTarget = structuredClone(target)
    const originalApplication = structuredClone(application)

    const result = applyApplicationSettings(target, application)

    expect(result).toEqual({
      ...originalTarget,
      appearance: { ...originalTarget.appearance, uiScale: 1.5 },
      weather: {
        ...originalTarget.weather,
        location: { name: 'New city', metadata: { label: 'fresh' } }
      }
    })
    expect(result).not.toBe(target)
    result.weather.location.metadata.label = 'changed'
    result.extra.markers.push('new marker')
    result.listFilter.tagIds.push(3)
    expect(target).toEqual(originalTarget)
    expect(application).toEqual(originalApplication)
  })

  it('uses only defined application values and preserves explicit null, false and zero', () => {
    const target = createDefaultSettings(VIEW_MODES.WEEK)
    target.appearance.uiScale = 1.25
    target.notes.autoMoveToToday = true
    target.onboarding.noticeVersion = 5
    target.weather.location = { name: 'Old city' }
    const original = structuredClone(target)

    const result = applyApplicationSettings(target, {
      appearance: { uiScale: undefined },
      notes: { autoMoveToToday: false },
      onboarding: { noticeVersion: 0 },
      weather: { location: null }
    })

    expect(result.appearance.uiScale).toBe(1.25)
    expect(result.notes.autoMoveToToday).toBe(false)
    expect(result.onboarding.noticeVersion).toBe(0)
    expect(result.weather).toEqual({ enabled: false, location: null })
    expect(result.geometry).toEqual(original.geometry)
    expect(result.shortcuts.enabled).toBe(true)
    expect(target).toEqual(original)
  })
})
