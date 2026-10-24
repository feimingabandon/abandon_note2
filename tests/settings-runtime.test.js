import { describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '../src/shared/settings-schema.js'
import {
  assembleResolvedSettings,
  createSettingsRuntime
} from '../src/main/settings/settings-runtime.js'

function applicationValues() {
  const value = createDefaultSettings('list')
  value.appearance.uiScale = 1.25
  value.appearance.iconColor = 'white'
  value.weather = { enabled: true, location: { code: '101010100', name: '北京' } }
  value.almanac.enabled = false
  value.window.lockState = true
  return value
}

function fixture(extra = {}) {
  let viewMode = 'list'
  const application = applicationValues()
  const viewRows = {
    list: [{ type: 'geometry', key: 'width', value: '801' }],
    month: [{ type: 'geometry', key: 'width', value: '1201' }],
    week: [{ type: 'geometry', key: 'width', value: '1301' }]
  }
  const readApplication = vi.fn(() => application)
  const readViewRows = vi.fn((view) => viewRows[view])
  const readRuntime = vi.fn(() => ({
    autoStart: { value: true, error: null },
    blur: { effectiveEnabled: false },
    shortcuts: { screenshot: { registered: false } }
  }))
  const runtime = createSettingsRuntime({
    getViewMode: () => viewMode,
    readApplication,
    readViewRows,
    readRuntime,
    ...extra
  })
  return {
    runtime,
    application,
    readApplication,
    readViewRows,
    readRuntime,
    switchView: (view) => (viewMode = view)
  }
}

describe('resolved settings runtime', () => {
  it('seeds schema defaults before navigation exists and reads the sole active mode only during refresh', () => {
    let activeMode
    const getViewMode = vi.fn(() => {
      if (activeMode === undefined) throw new ReferenceError('navigation is not initialized')
      return activeMode
    })
    const { runtime, readViewRows } = fixture({ initialViewMode: 'list', getViewMode })
    expect(getViewMode).not.toHaveBeenCalled()
    expect(runtime.values).toEqual(createDefaultSettings('list'))
    activeMode = 'month'
    runtime.resetForView(activeMode)
    runtime.refresh()
    expect(getViewMode).toHaveBeenCalledOnce()
    expect(readViewRows).toHaveBeenCalledWith('month')
    expect(runtime.values.geometry.width).toBe(1201)
  })

  it('merges application settings, view-local geometry and the session gate without mutating inputs', () => {
    const application = applicationValues()
    const result = assembleResolvedSettings({
      applicationSettings: application,
      viewMode: 'month',
      viewRows: [
        { type: 'geometry', key: 'width', value: '1234' },
        { type: 'appearance', key: 'ui_scale', value: '0.9' },
        { type: 'appearance', key: 'titlebar_style', value: 'microsoft' }
      ],
      shortcutsEnabled: false
    })
    expect(result.geometry.width).toBe(1234)
    expect(result.appearance).toMatchObject({
      uiScale: 1.25,
      iconColor: 'white',
      titlebarStyle: 'microsoft'
    })
    expect(result.shortcuts.enabled).toBe(false)
    expect(result.window.lockState).toBe(true)
    expect(result.almanac.enabled).toBe(false)
    result.almanac.enabled = true
    expect(application.almanac.enabled).toBe(false)
    result.weather.location.name = '改动快照'
    expect(application.weather.location.name).toBe('北京')
  })

  it('keeps the shared almanac choice through every view switch', () => {
    const { runtime, application, switchView } = fixture()
    for (const viewMode of ['list', 'month', 'week']) {
      switchView(viewMode)
      runtime.resetForView(viewMode)
      runtime.refresh()
      expect(runtime.snapshot().values.almanac.enabled).toBe(false)
      expect(runtime.snapshot().values.weather.enabled).toBe(true)
    }
    application.almanac.enabled = true
    runtime.refresh()
    expect(runtime.values.almanac.enabled).toBe(true)
  })

  it('keeps quick-create defaults application-wide through view changes and default restoration', () => {
    const { runtime, application, readViewRows, switchView } = fixture()
    application.notes.quickCreateUntilCompleted = true
    readViewRows.mockReturnValue([
      { type: 'notes', key: 'quick_create_until_completed', value: '0' }
    ])
    for (const viewMode of ['list', 'month', 'week']) {
      switchView(viewMode)
      runtime.resetForView(viewMode)
      runtime.refresh()
      expect(runtime.snapshot().values.notes).toMatchObject({
        quickCreateUntilCompleted: true,
        autoMoveToToday: false
      })
    }
    const snapshot = runtime.snapshot()
    snapshot.values.notes.quickCreateUntilCompleted = false
    expect(application.notes.quickCreateUntilCompleted).toBe(true)
    expect(runtime.values.notes.quickCreateUntilCompleted).toBe(true)

    application.notes.quickCreateUntilCompleted = false
    readViewRows.mockReturnValue([
      { type: 'notes', key: 'quick_create_until_completed', value: '1' }
    ])
    runtime.refresh()
    expect(runtime.values.notes.quickCreateUntilCompleted).toBe(false)
    expect(runtime.values.notes.autoMoveToToday).toBe(false)
  })

  it('publishes values and their revision before material/theme sync', () => {
    const observations = []
    let runtime
    ;({ runtime } = fixture({
      onResolved: (values) =>
        observations.push([
          values.geometry.width,
          runtime.values === values,
          runtime.revision,
          runtime.snapshot().revision
        ])
    }))
    expect(runtime.refresh()).toBe(true)
    expect(observations).toEqual([[801, true, 1, 1]])
    expect(runtime.revision).toBe(1)
    expect(runtime.refresh()).toBe(false)
    expect(runtime.revision).toBe(1)
    expect(runtime.refresh({ incrementRevision: true })).toBe(true)
    expect(runtime.revision).toBe(2)
    expect(observations).toHaveLength(3)
  })

  it('keeps the published value and revision consistent when a resolved dependency throws', () => {
    const failure = new Error('capture theme dependency failed')
    let publishedInCallback
    const onResolved = vi.fn().mockImplementationOnce(() => {
      publishedInCallback = runtime.snapshot()
      throw failure
    })
    const { runtime } = fixture({ onResolved })
    const before = runtime.snapshot()
    expect(() => runtime.refresh()).toThrow(failure)
    const after = runtime.snapshot()
    expect(after.values.geometry.width).toBe(801)
    expect(after.values.geometry.width).not.toBe(before.values.geometry.width)
    expect(after.revision).toBe(before.revision + 1)
    expect(publishedInCallback.revision).toBe(after.revision)
    expect(publishedInCallback.values.geometry.width).toBe(after.values.geometry.width)
    expect(runtime.refresh()).toBe(false)
    expect(runtime.revision).toBe(after.revision)
    expect(onResolved).toHaveBeenCalledTimes(2)
  })

  it('can publish stored values without dispatching dependencies owned by the application coordinator', () => {
    const onResolved = vi.fn()
    const { runtime } = fixture({ onResolved })
    expect(runtime.refresh({ incrementRevision: true, notifyResolved: false })).toBe(true)
    expect(runtime.values.geometry.width).toBe(801)
    expect(runtime.revision).toBe(1)
    expect(onResolved).not.toHaveBeenCalled()
    // The existing entry remains compatible until its consumer migration.
    expect(runtime.refresh()).toBe(false)
    expect(onResolved).toHaveBeenCalledOnce()
    expect(onResolved).toHaveBeenCalledWith(runtime.values)
    expect(runtime.revision).toBe(1)
  })

  it('does not publish an old value/revision pair as a new resolution when a silent read fails', () => {
    const onResolved = vi.fn()
    const { runtime, readViewRows } = fixture({ onResolved })
    runtime.refresh({ notifyResolved: false })
    const before = runtime.values
    const beforeRevision = runtime.revision
    readViewRows.mockImplementationOnce(() => {
      throw new Error('settings resolve read failed')
    })
    expect(() => runtime.refresh({ incrementRevision: true, notifyResolved: false })).toThrow(
      'settings resolve read failed'
    )
    expect(runtime.values).toBe(before)
    expect(runtime.revision).toBe(beforeRevision)
    expect(onResolved).not.toHaveBeenCalled()
  })

  it('leaves a provider failure explicit after publication instead of inventing OS observations', () => {
    const { runtime, readRuntime } = fixture()
    runtime.refresh({ notifyResolved: false })
    const before = runtime.values
    const beforeRevision = runtime.revision
    readRuntime.mockImplementationOnce(() => {
      throw new Error('OS runtime observation unavailable')
    })
    expect(() => runtime.snapshot()).toThrow('OS runtime observation unavailable')
    expect(runtime.values).toBe(before)
    expect(runtime.revision).toBe(beforeRevision)
    expect(runtime.values.system?.autoStart).toBeUndefined()
  })

  it('keeps the shortcut pause across refresh, view switch and stored-default reset', () => {
    const { runtime, application, switchView } = fixture()
    runtime.refresh()
    runtime.setShortcutsEnabled(false)
    switchView('month')
    runtime.resetForView('month')
    runtime.refresh({ incrementRevision: true })
    expect(runtime.values.geometry.width).toBe(1201)
    expect(runtime.values.shortcuts.enabled).toBe(false)
    expect(application.shortcuts.enabled).toBe(true)
    expect(runtime.shortcutsEnabled).toBe(false)
    expect(runtime.revision).toBe(3)
  })

  it('returns detached snapshots and prevents external writes to owned values', () => {
    const { runtime, readRuntime } = fixture()
    runtime.refresh()
    expect(() => {
      runtime.values.shortcuts.enabled = false
    }).toThrow(TypeError)
    expect(() => {
      runtime.values.weather.location.name = '外部写入'
    }).toThrow(TypeError)
    const snapshot = runtime.snapshot()
    expect(snapshot).toMatchObject({
      revision: 1,
      values: { system: { autoStart: true } },
      runtime: { blur: { effectiveEnabled: false } }
    })
    snapshot.values.weather.location.name = '修改广播快照'
    expect(runtime.values.weather.location.name).toBe('北京')
    expect(readRuntime).toHaveBeenCalledTimes(1)
  })

  it.each(['readApplication', 'readViewRows'])('does not publish when %s fails', (failingRead) => {
    const onResolved = vi.fn()
    const f = fixture({ onResolved })
    const { runtime } = f
    runtime.refresh()
    onResolved.mockClear()
    const before = runtime.values
    f[failingRead].mockImplementationOnce(() => {
      throw new Error('SQLite read failed')
    })
    expect(() => runtime.refresh({ incrementRevision: true })).toThrow('SQLite read failed')
    expect(runtime.values).toBe(before)
    expect(runtime.revision).toBe(1)
    expect(onResolved).not.toHaveBeenCalled()
  })

  it('publishes a forced revision for unchanged values before a dependency fails', () => {
    let fail = false
    const { runtime } = fixture({
      onResolved: () => {
        if (fail) throw new Error('theme sync failed')
      }
    })
    runtime.refresh()
    fail = true
    expect(() => runtime.refresh({ incrementRevision: true })).toThrow('theme sync failed')
    expect(runtime.values.geometry.width).toBe(801)
    expect(runtime.revision).toBe(2)
  })

  it('advances runtime-only revision without reading or persisting settings', () => {
    const { runtime, readApplication, readViewRows } = fixture()
    expect(runtime.advanceRevision()).toBe(1)
    expect(runtime.revision).toBe(1)
    expect(readApplication).not.toHaveBeenCalled()
    expect(readViewRows).not.toHaveBeenCalled()
  })
})
