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
let getViewSettingsScope
let prepareViewSettingsForSwitch
let readApplicationSettings
let writeActiveView

beforeAll(async () => {
  ;({
    ensureViewSettingsInitialized,
    getViewSettingsScope,
    prepareViewSettingsForSwitch,
    readApplicationSettings,
    writeActiveView
  } = await import('../src/main/settings/application-settings.js'))
})

beforeEach(() => {
  db.rowsByScope.clear()
  db.getAllSettings.mockClear()
  db.setSettingsBatch.mockClear()
})

describe('application view settings', () => {
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
