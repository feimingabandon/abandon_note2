import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useNoteStateDraft } from '../src/renderer/src/composables/useNoteStateDraft.js'

const lifecycle = vi.hoisted(() => ({ mount: [], unmount: [] }))
vi.mock('vue', async (importOriginal) => ({
  ...(await importOriginal()),
  onMounted: (callback) => lifecycle.mount.push(callback),
  onBeforeUnmount: (callback) => lifecycle.unmount.push(callback)
}))

const NOW = new Date('2026-10-14T10:00:00.123+08:00').getTime()
function fixture({
  effectiveAt = null,
  chosenStatus = 'in_progress',
  completedAt = '',
  note
} = {}) {
  const effectiveTimestamp = ref(effectiveAt)
  const statusChoice = ref(chosenStatus)
  const finishedAt = ref(completedAt)
  const draft = useNoteStateDraft({
    effectiveTimestamp,
    statusChoice,
    finishedAt,
    originalNote: () => note
  })
  lifecycle.mount.splice(0).forEach((callback) => callback())
  return { ...draft, effectiveTimestamp, statusChoice, finishedAt }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  lifecycle.mount = []
  lifecycle.unmount = []
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
})
afterEach(() => {
  lifecycle.unmount.splice(0).forEach((callback) => callback())
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('time-controlled note form state', () => {
  it('starts immediately and exposes progress/completion without a start reminder', () => {
    const draft = fixture()
    expect(draft.status.value).toBe('in_progress')
    expect(
      draft.statusOptions.value.filter((option) => !option.disabled).map((option) => option.value)
    ).toEqual(['in_progress', 'completed'])
    expect(draft.canScheduleNotification.value).toBe(false)
    expect(draft.submissionFields()).toEqual({ status: 'in_progress', effectiveAt: null })
  })

  it('temporarily limits a future note without replacing the remembered completed choice', () => {
    const draft = fixture({ chosenStatus: 'completed' })
    draft.effectiveTimestamp.value = NOW + 3600_000
    expect(draft.status.value).toBe('initialized')
    expect(draft.statusChoice.value).toBe('completed')
    expect(draft.submissionFields()).toEqual({ status: 'initialized', effectiveAt: NOW + 3600_000 })
    draft.effectiveTimestamp.value = NOW - 86400_000
    expect(draft.status.value).toBe('completed')
    expect(draft.submissionFields().finishedAt).toBe(null)
  })

  it('re-evaluates an open appointment when its time passes without writing preferences', () => {
    const note = { status: 'initialized', effective_at: NOW + 3000, notify_enabled: 1 }
    const draft = fixture({ effectiveAt: note.effective_at, note })
    expect(draft.canScheduleNotification.value).toBe(true)
    vi.advanceTimersByTime(4000)
    expect(draft.status.value).toBe('in_progress')
    expect(draft.canScheduleNotification.value).toBe(false)
    expect(draft.statusChoice.value).toBe('in_progress')
    expect(draft.submissionFields().status).toBe('in_progress')
  })

  it('keeps complete-on-save as an intention across consecutive submissions', () => {
    const draft = fixture({ chosenStatus: 'completed' })
    expect(draft.submissionFields()).toEqual({
      status: 'completed',
      effectiveAt: null,
      finishedAt: null
    })
    vi.advanceTimersByTime(15000)
    expect(draft.submissionFields()).toEqual({
      status: 'completed',
      effectiveAt: null,
      finishedAt: null
    })
    expect(draft.finishedAt.value).toBe('')
  })

  it('keeps an explicit now completion relative across delayed and consecutive saves', () => {
    const draft = fixture({ chosenStatus: 'completed', completedAt: 'now' })
    vi.advanceTimersByTime(15000)
    expect(draft.submissionFields()).toEqual({
      status: 'completed',
      effectiveAt: null,
      finishedAt: null
    })
    vi.advanceTimersByTime(15000)
    expect(draft.submissionFields().finishedAt).toBe(null)
    expect(draft.finishedAt.value).toBe('now')
  })

  it('accepts an explicit now completion when a stored completed note is missing its time', () => {
    const note = {
      status: 'completed',
      effective_at: NOW - 10000,
      finished_at: null,
      notify_enabled: 0
    }
    const draft = fixture({
      effectiveAt: note.effective_at,
      chosenStatus: 'completed',
      completedAt: 'now',
      note
    })
    expect(draft.submissionFields({ effectiveAt: undefined })).toEqual({
      status: 'completed',
      effectiveAt: undefined,
      finishedAt: null
    })
    expect(() => draft.submissionFields({ effectiveAt: undefined, finishedAt: undefined })).toThrow(
      '缺少完成时间'
    )
  })

  it('rejects an inherited explicit completion before the next note starts', () => {
    const draft = fixture({ chosenStatus: 'completed', completedAt: '2026-10-13T11:00:00+08:00' })
    expect(() => draft.submissionFields()).toThrow('完成时间不能早于生效时间')
    draft.effectiveTimestamp.value = new Date('2026-10-13T09:00:00+08:00').getTime()
    expect(draft.submissionFields().finishedAt).toBe(
      new Date('2026-10-13T11:00:00+08:00').getTime()
    )
  })

  it('preserves exact stored timestamps on content-only edits', () => {
    const note = {
      status: 'completed',
      effective_at: NOW - 1000,
      finished_at: NOW - 500,
      notify_enabled: 0
    }
    const draft = fixture({ effectiveAt: note.effective_at, chosenStatus: 'completed', note })
    expect(draft.submissionFields({ effectiveAt: undefined, finishedAt: undefined })).toEqual({
      status: 'completed',
      effectiveAt: undefined,
      finishedAt: undefined
    })
  })

  it('lets unchanged appointments retain their reminder shortly before activation', () => {
    const note = {
      status: 'initialized',
      effective_at: NOW + 1000,
      finished_at: NOW,
      notify_enabled: 1
    }
    const draft = fixture({ effectiveAt: note.effective_at, note })
    expect(draft.canScheduleNotification.value).toBe(true)
    expect(draft.submissionFields({ effectiveAt: undefined }).status).toBe('initialized')
    expect(() => fixture({ effectiveAt: NOW + 1000 }).submissionFields()).toThrow('2 分钟')
  })

  it.each([
    [120000 - 1, false],
    [120000, true],
    [120000 + 1, true]
  ])('uses the exact two-minute boundary for a new appointment (%i ms)', (lead, allowed) => {
    const draft = fixture({ effectiveAt: NOW + lead, chosenStatus: 'completed' })
    expect(draft.status.value).toBe('initialized')
    expect(draft.canScheduleNotification.value).toBe(allowed)
    expect(draft.statusChoice.value).toBe('completed')
    if (allowed) expect(draft.submissionFields().status).toBe('initialized')
    else expect(() => draft.submissionFields()).toThrow('2 分钟')
  })

  it('disables a new reminder when an open draft enters the minimum lead-time window', () => {
    const draft = fixture({ effectiveAt: NOW + 121000, chosenStatus: 'completed' })
    expect(draft.canScheduleNotification.value).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(draft.canScheduleNotification.value).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(draft.status.value).toBe('initialized')
    expect(draft.canScheduleNotification.value).toBe(false)
    expect(draft.statusChoice.value).toBe('completed')
    draft.effectiveTimestamp.value = NOW + 3600000
    expect(draft.canScheduleNotification.value).toBe(true)
  })

  it('refreshes reminder eligibility after returning focus across a clock boundary', () => {
    const draft = fixture({ effectiveAt: NOW + 120000 })
    const focusRefresh = window.addEventListener.mock.calls.find(([event]) => event === 'focus')[1]
    vi.setSystemTime(NOW + 1)
    focusRefresh()
    expect(draft.canScheduleNotification.value).toBe(false)
    vi.setSystemTime(NOW)
    focusRefresh()
    expect(draft.canScheduleNotification.value).toBe(true)
  })

  it('does not grant an unchanged-appointment exemption to an edited future time', () => {
    const note = { status: 'initialized', effective_at: NOW + 1000, notify_enabled: 1 }
    const draft = fixture({ effectiveAt: note.effective_at, note })
    expect(draft.canScheduleNotification.value).toBe(true)
    draft.effectiveTimestamp.value += 1000
    expect(draft.canScheduleNotification.value).toBe(false)
    expect(() => draft.submissionFields()).toThrow('2 分钟')
    draft.effectiveTimestamp.value = note.effective_at
    expect(draft.canScheduleNotification.value).toBe(true)
  })

  it.each(['in_progress', 'completed'])(
    'requires full lead time when a %s note is changed to a future appointment',
    (status) => {
      const note = { status, effective_at: NOW - 86400000, finished_at: NOW, notify_enabled: 0 }
      const draft = fixture({ effectiveAt: NOW + 1000, chosenStatus: status, note })
      expect(draft.canScheduleNotification.value).toBe(false)
      expect(() => draft.submissionFields()).toThrow('2 分钟')
      draft.effectiveTimestamp.value = NOW + 120000
      expect(draft.canScheduleNotification.value).toBe(true)
    }
  )

  it('uses the original appointment precision when the draft remains in the same second', () => {
    const note = { status: 'initialized', effective_at: NOW + 1000, notify_enabled: 1 }
    const draft = fixture({
      effectiveAt: Math.floor(note.effective_at / 1000) * 1000,
      note
    })
    expect(draft.canScheduleNotification.value).toBe(true)
    expect(draft.submissionFields().status).toBe('initialized')
    draft.effectiveTimestamp.value = note.effective_at + 100
    vi.advanceTimersByTime(1000)
    // The displayed millisecond variant is still future, but the original
    // timestamp retained by the backend is already due.
    expect(draft.canScheduleNotification.value).toBe(false)
  })

  it('keeps an omitted existing appointment until its original activation time', () => {
    const note = { status: 'initialized', effective_at: NOW + 1000, notify_enabled: 1 }
    const draft = fixture({ effectiveAt: note.effective_at, note })
    draft.effectiveTimestamp.value = undefined
    expect(draft.canScheduleNotification.value).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(draft.canScheduleNotification.value).toBe(false)
  })

  it.each([null, '', 'now', Number.NaN, Infinity, 0, NOW, NOW - 1])(
    'does not offer start reminders for immediate, invalid, or elapsed time (%s)',
    (effectiveAt) => {
      const note = { status: 'initialized', effective_at: NOW + 1000, notify_enabled: 1 }
      expect(fixture({ effectiveAt, note }).canScheduleNotification.value).toBe(false)
    }
  )

  it('a new explicit completion selection uses now instead of an old completion date', () => {
    const draft = fixture({ effectiveAt: NOW - 86400_000, completedAt: '2026-10-13 11:00:00' })
    draft.chooseStatus('completed')
    expect(draft.finishedAt.value).toBe('')
    expect(draft.submissionFields().finishedAt).toBe(null)
    draft.chooseStatus('initialized')
    expect(draft.status.value).toBe('completed')
  })

  it('releases the clock and focus listeners when the form closes', () => {
    fixture()
    expect(vi.getTimerCount()).toBe(1)
    lifecycle.unmount.splice(0).forEach((callback) => callback())
    expect(vi.getTimerCount()).toBe(0)
    expect(window.removeEventListener).toHaveBeenCalledWith('focus', expect.any(Function))
    expect(document.removeEventListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function)
    )
  })
})
