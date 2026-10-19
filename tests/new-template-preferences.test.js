import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeNewTemplatePreferences,
  useNewTemplatePreferences
} from '../src/renderer/src/composables/useNewTemplatePreferences.js'

vi.mock('vue', async (importOriginal) => ({
  ...(await importOriginal()),
  onMounted: vi.fn(),
  onBeforeUnmount: vi.fn()
}))

class MemoryStorage {
  getItem(key) {
    return this[key] ?? null
  }
  setItem(key, value) {
    this[key] = String(value)
  }
  removeItem(key) {
    delete this[key]
  }
}
let scope
beforeEach(() => {
  scope = effectScope()
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.stubGlobal('window', {
    api: { runtimeCapabilities: { editingDraftSessionId: 'test-launch' } }
  })
})
afterEach(() => {
  scope.stop()
  vi.unstubAllGlobals()
})

describe('new recurring-template choices', () => {
  it('starts with reminders off and relative empty boundaries', () => {
    const preferences = scope.run(() => useNewTemplatePreferences({ defaultTime: '10:30' }))
    expect(preferences.fields.reminderChannels.value).toBe(0)
    expect(preferences.fields.startAt.value).toBe('')
    expect(preferences.fields.endAt.value).toBe('')
    expect(preferences.fields.timeOfDay.value).toBe('10:30')
    expect(preferences.hasSavedChoices()).toBe(false)
  })
  it('inherits choices across a remount in one launch, but clears previous launch choices', () => {
    const first = scope.run(() => useNewTemplatePreferences({ defaultTime: '10:30' }))
    first.fields.frequency.value = 'weekly'
    first.fields.weekdays.value = [2, 5]
    first.fields.timeOfDay.value = '15:00'
    first.fields.reminderChannels.value = 6
    first.fields.startAt.value = '2026-10-14 08:00:00'
    const next = scope.run(() => useNewTemplatePreferences({ defaultTime: '11:30' }))
    expect(next.fields.frequency.value).toBe('weekly')
    expect(next.fields.weekdays.value).toEqual([2, 5])
    expect(next.fields.timeOfDay.value).toBe('15:00')
    expect(next.fields.reminderChannels.value).toBe(6)
    expect(next.fields.startAt.value).toBe('2026-10-14 08:00:00')
    window.api.runtimeCapabilities.editingDraftSessionId = 'new-launch'
    const restarted = scope.run(() => useNewTemplatePreferences({ defaultTime: '12:00' }))
    expect(restarted.fields.frequency.value).toBe('daily')
    expect(restarted.fields.reminderChannels.value).toBe(0)
    expect(restarted.fields.startAt.value).toBe('')
    expect(Object.keys(localStorage).some((key) => key.endsWith('test-launch'))).toBe(false)
  })
  it('editing a template cannot overwrite remembered new-template choices', () => {
    const editing = scope.run(() => useNewTemplatePreferences({ enabled: () => false }))
    editing.fields.reminderChannels.value = 7
    editing.fields.frequency.value = 'yearly'
    const next = scope.run(() => useNewTemplatePreferences())
    expect(next.fields.reminderChannels.value).toBe(0)
    expect(next.fields.frequency.value).toBe('daily')
  })
  it('validates stored selections without moving explicit dates', () => {
    const result = normalizeNewTemplatePreferences(
      {
        frequency: 'unknown',
        weekdays: [0, 2, 2, 8],
        monthDays: [32],
        timeOfDay: '25:00',
        yearDates: [{ month: 2, day: 30 }],
        startAt: '2020-10-12 08:00:00',
        endAt: '2020-10-13 08:00:00',
        tagIds: [0, 7, 7, 8]
      },
      '09:30'
    )
    expect(result.frequency).toBe('daily')
    expect(result.weekdays).toEqual([2])
    expect(result.monthDays).toEqual([1])
    expect(result.timeOfDay).toBe('09:30')
    expect(result.yearDates).toEqual([{ month: 1, day: 1 }])
    expect(result.startAt).toBe('2020-10-12 08:00:00')
    expect(result.endAt).toBe('2020-10-13 08:00:00')
    expect(result.tagIds).toEqual([7])
  })
})
