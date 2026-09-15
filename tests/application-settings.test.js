import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  rowsByScope: new Map(),
  getAllSettings: vi.fn((scope) => db.rowsByScope.get(scope) || []),
  setSettingsBatch: vi.fn((scope, rows) => {
    const existing = db.rowsByScope.get(scope) || []
    const merged = new Map(existing.map((row) => [row.key, row]))
    rows.forEach((row) => merged.set(row.key, { ...row }))
    db.rowsByScope.set(scope, [...merged.values()])
  })
}))

vi.mock('../src/main/db/db.js', () => ({
  getAllSettings: db.getAllSettings,
  setSettingsBatch: db.setSettingsBatch
}))

let ensureViewSettingsInitialized
let ensureApplicationWindowSettingsInitialized
let clearPersistedCompactWindowMode
let getViewSettingsScope
let prepareViewSettingsForSwitch
let readApplicationSettings
let writeActiveView
let writeApplicationSetting
let writeApplicationSettings

beforeAll(async () => {
  ;({
    clearPersistedCompactWindowMode,
    ensureApplicationWindowSettingsInitialized,
    ensureViewSettingsInitialized,
    getViewSettingsScope,
    prepareViewSettingsForSwitch,
    readApplicationSettings,
    writeActiveView,
    writeApplicationSetting,
    writeApplicationSettings
  } = await import('../src/main/settings/application-settings.js'))
})

beforeEach(() => {
  db.rowsByScope.clear()
  db.getAllSettings.mockClear()
  db.setSettingsBatch.mockClear()
})

describe('application view settings', () => {
  it('persists automatic movement once for all views and defaults to disabled', () => {
    expect(readApplicationSettings().notes.autoMoveYesterday).toBe(false)
    writeApplicationSetting('notes.autoMoveYesterday', true)
    expect(readApplicationSettings().notes.autoMoveYesterday).toBe(true)
    expect(db.rowsByScope.get('application')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'notes', key: 'auto_move_yesterday', value: '1' })
      ])
    )
    ensureViewSettingsInitialized('week')
    expect(readApplicationSettings().notes.autoMoveYesterday).toBe(true)
    writeApplicationSetting('notes.autoMoveYesterday', false)
    expect(readApplicationSettings().notes.autoMoveYesterday).toBe(false)
  })
  it('initializes lock and z-order once from the active legacy view, then shares them globally', () => {
    db.rowsByScope.set('main', [
      { type: 'system', key: 'lock_state', value: 'true' },
      { type: 'system', key: 'always_on_top', value: 'false' }
    ])

    expect(ensureApplicationWindowSettingsInitialized('list')).toBe(true)
    expect(readApplicationSettings().window).toEqual({
      lockState: true,
      zOrderMode: 'normal',
      compact: expect.objectContaining({ enabled: false, width: 200, height: 40 })
    })
    expect(ensureApplicationWindowSettingsInitialized('month')).toBe(false)

    writeApplicationSetting('window.zOrderMode', 'bottom')
    writeApplicationSetting('window.lockState', false)
    expect(readApplicationSettings().window).toEqual({
      lockState: false,
      zOrderMode: 'bottom',
      compact: expect.objectContaining({ enabled: false, width: 200, height: 40 })
    })
  })

  it('upgrades the old compact default once without changing position or later size choices', () => {
    writeApplicationSettings([
      { id: 'window.compact.width', value: 360 },
      { id: 'window.compact.height', value: 76 },
      { id: 'window.compact.x', value: 130 },
      { id: 'window.compact.y', value: 140 }
    ])
    ensureApplicationWindowSettingsInitialized('list')
    expect(readApplicationSettings().window.compact).toMatchObject({
      width: 200,
      height: 40,
      x: 130,
      y: 140
    })
    writeApplicationSettings([
      { id: 'window.compact.width', value: 360 },
      { id: 'window.compact.height', value: 76 }
    ])
    expect(ensureApplicationWindowSettingsInitialized('list')).toBe(false)
    expect(readApplicationSettings().window.compact).toMatchObject({ width: 360, height: 76 })
  })

  it('preserves customized compact dimensions during the default upgrade', () => {
    writeApplicationSettings([
      { id: 'window.compact.width', value: 280 },
      { id: 'window.compact.height', value: 76 }
    ])
    ensureApplicationWindowSettingsInitialized('month')
    expect(readApplicationSettings().window.compact).toMatchObject({ width: 280, height: 76 })
  })

  it('keeps the first-use notice version in the application scope', () => {
    expect(readApplicationSettings().onboarding.noticeVersion).toBe(0)

    writeApplicationSetting('onboarding.noticeVersion', 1)

    expect(readApplicationSettings().onboarding.noticeVersion).toBe(1)
    expect(db.rowsByScope.get('application')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'onboarding',
          key: 'first_use_notice_version',
          value: '1'
        })
      ])
    )
  })

  it('keeps the titlebar icon scale in the application scope', () => {
    expect(readApplicationSettings().appearance.titlebarIconScale).toBe(100)

    writeApplicationSetting('appearance.titlebarIconScale', 145)

    expect(readApplicationSettings().appearance.titlebarIconScale).toBe(145)
    expect(db.rowsByScope.get('application')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'appearance',
          key: 'titlebar_icon_scale',
          value: '145'
        })
      ])
    )
  })

  it('keeps the icon color in the application scope', () => {
    expect(readApplicationSettings().appearance.iconColor).toBe('black')

    writeApplicationSetting('appearance.iconColor', 'white')

    expect(readApplicationSettings().appearance.iconColor).toBe('white')
    expect(db.rowsByScope.get('application')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'appearance',
          key: 'icon_color',
          value: 'white'
        })
      ])
    )
  })

  it('keeps the view visibility shortcut in the application scope', () => {
    expect(readApplicationSettings().shortcuts.viewVisibility).toBe('')

    writeApplicationSetting('shortcuts.viewVisibility', 'Control+Alt+N')

    expect(readApplicationSettings().shortcuts.viewVisibility).toBe('Control+Alt+N')
    expect(db.rowsByScope.get('application')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'shortcuts',
          key: 'view_visibility',
          value: 'Control+Alt+N'
        })
      ])
    )
  })

  it('keeps double-click quick edit in the application scope', () => {
    expect(readApplicationSettings().interaction.doubleClickQuickEdit).toBe(true)

    writeApplicationSetting('interaction.doubleClickQuickEdit', false)

    expect(readApplicationSettings().interaction.doubleClickQuickEdit).toBe(false)
    expect(db.rowsByScope.get('application')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'interaction',
          key: 'double_click_quick_edit',
          value: '0'
        })
      ])
    )
  })

  it('shares the recurring note preview switch between month and week', () => {
    expect(readApplicationSettings().calendar.recurringPreviewEnabled).toBe(false)

    writeApplicationSetting('calendar.recurringPreviewEnabled', true)

    expect(readApplicationSettings().calendar.recurringPreviewEnabled).toBe(true)
    expect(db.rowsByScope.get('application')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'calendar',
          key: 'recurring_preview_enabled',
          value: '1'
        })
      ])
    )
  })

  it('writes compact geometry atomically and rejects unrelated batch entries', () => {
    writeApplicationSettings([
      { id: 'window.compact.enabled', value: true },
      { id: 'window.compact.x', value: 440 },
      { id: 'window.compact.y', value: 364 },
      { id: 'window.compact.width', value: 420 },
      { id: 'window.compact.height', value: 92 },
      { id: 'window.compact.displayId', value: 'display-2' },
      {
        id: 'window.compact.previousWorkArea',
        value: { x: 0, y: 0, width: 1920, height: 1040 }
      }
    ])

    expect(db.setSettingsBatch).toHaveBeenCalledTimes(1)
    expect(readApplicationSettings().window.compact).toEqual({
      enabled: true,
      x: 440,
      y: 364,
      width: 420,
      height: 92,
      displayId: 'display-2',
      previousWorkArea: { x: 0, y: 0, width: 1920, height: 1040 }
    })
    expect(() => writeApplicationSettings([{ id: 'window.zOrderMode', value: 'normal' }])).toThrow(
      /未授权/
    )
    expect(db.setSettingsBatch).toHaveBeenCalledTimes(1)
  })

  it('clears a legacy compact startup flag without discarding compact geometry', () => {
    db.rowsByScope.set('application', [
      { type: 'compact', key: 'enabled', value: 'true' },
      { type: 'compact', key: 'x', value: '440' },
      { type: 'compact', key: 'y', value: '364' }
    ])

    expect(clearPersistedCompactWindowMode()).toBe(true)
    expect(readApplicationSettings().window.compact).toMatchObject({
      enabled: false,
      x: 440,
      y: 364
    })
    expect(clearPersistedCompactWindowMode()).toBe(false)
    expect(db.setSettingsBatch).toHaveBeenCalledTimes(1)
  })

  it('accepts week as the persisted active view and maps it to an independent scope', () => {
    db.rowsByScope.set('application', [{ type: 'application', key: 'active_view', value: 'week' }])

    expect(readApplicationSettings().activeView).toBe('week')
    expect(writeActiveView('week')).toBe('week')
    expect(getViewSettingsScope('week')).toBe('week')
    expect(getViewSettingsScope('unknown')).toBe('main')
  })

  it('copies month settings only on the first week initialization', () => {
    db.rowsByScope.set('month', [
      { type: 'geometry', key: 'width', value: '1200', remark: '窗口宽度' },
      { type: 'ui', key: 'day_panel_size', value: '31', remark: '日期侧栏宽度' },
      { type: 'wallpaper', key: 'active_wallpaper_id', value: '9', remark: '壁纸' },
      { type: 'appearance', key: 'titlebar_style', value: 'microsoft', remark: '导航栏' },
      {
        type: 'appearance',
        key: 'titlebar_icon_scale',
        value: '145',
        remark: '旧错误作用域中的全局图标大小'
      },
      {
        type: 'shortcuts',
        key: 'view_visibility',
        value: 'Control+Alt+N',
        remark: '错误作用域中的全局快捷键'
      },
      {
        type: 'dock',
        key: 'dock_reveal_handle_positions',
        value: '{"top":0.8}',
        remark: '废弃的小黑条位置'
      },
      { type: 'weather', key: 'enabled', value: 'true', remark: '旧公共设置' }
    ])

    expect(ensureViewSettingsInitialized('week')).toBe(true)
    expect(db.rowsByScope.get('week')).toEqual([
      { type: 'geometry', key: 'width', value: '1200', remark: '窗口宽度' },
      { type: 'ui', key: 'day_panel_size', value: '31', remark: '日期侧栏宽度' },
      { type: 'wallpaper', key: 'active_wallpaper_id', value: '9', remark: '壁纸' },
      { type: 'appearance', key: 'titlebar_style', value: 'microsoft', remark: '导航栏' }
    ])

    db.rowsByScope.set('month', [
      { type: 'geometry', key: 'width', value: '1600', remark: '窗口宽度' }
    ])
    db.rowsByScope.set('week', [
      { type: 'geometry', key: 'width', value: '900', remark: '窗口宽度' }
    ])

    expect(ensureViewSettingsInitialized('week')).toBe(false)
    expect(db.rowsByScope.get('week')[0].value).toBe('900')

    // “恢复周视图默认设置”会清空 week scope，但初始化标记必须阻止再次继承月设置。
    db.rowsByScope.set('week', [])
    expect(ensureViewSettingsInitialized('week')).toBe(false)
    expect(db.rowsByScope.get('week')).toEqual([])
  })

  it('adopts pre-existing week settings without overwriting them when the marker is absent', () => {
    db.rowsByScope.set('month', [{ type: 'geometry', key: 'width', value: '1200' }])
    db.rowsByScope.set('week', [{ type: 'geometry', key: 'width', value: '880' }])

    expect(ensureViewSettingsInitialized('week')).toBe(true)
    expect(db.rowsByScope.get('week')[0].value).toBe('880')
    expect(
      db.rowsByScope.get('application').find((row) => row.key === 'week_settings_initialized')
        ?.value
    ).toBe('true')
  })

  it('flushes pending month geometry before the first week settings inheritance', () => {
    db.rowsByScope.set('month', [
      { type: 'geometry', key: 'pos_x', value: '10' },
      { type: 'geometry', key: 'pos_y', value: '20' },
      { type: 'geometry', key: 'width', value: '900' },
      { type: 'geometry', key: 'height', value: '600' },
      { type: 'ui', key: 'day_panel_size', value: '31' }
    ])

    expect(
      prepareViewSettingsForSwitch({
        sourceViewMode: 'month',
        targetViewMode: 'week',
        pendingGeometry: { x: 121, y: 132, width: 1180, height: 760 }
      })
    ).toEqual({ geometryPersisted: true, targetInitialized: true })

    expect(db.setSettingsBatch.mock.calls.map(([scope]) => scope)).toEqual([
      'month',
      'week',
      'application'
    ])
    expect(db.rowsByScope.get('week')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'pos_x', value: '121' }),
        expect.objectContaining({ key: 'pos_y', value: '132' }),
        expect.objectContaining({ key: 'width', value: '1180' }),
        expect.objectContaining({ key: 'height', value: '760' }),
        expect.objectContaining({ key: 'day_panel_size', value: '31' })
      ])
    )
  })
})
