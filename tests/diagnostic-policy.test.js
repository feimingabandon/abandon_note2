import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDiagnosticState } from '../src/main/logging/diagnostic-state.js'
import {
  dailyDiagnosticPolicy,
  diagnosticDestination,
  diagnosticHash
} from '../src/shared/diagnostic-policy.js'
import { diagnosticText, sanitizeDiagnosticValue } from '../src/shared/diagnostic-sanitize.js'
import { measureSyncPerformance } from '../src/main/logging/operation-performance.js'

afterEach(() => vi.useRealTimers())
describe('diagnostic collection policy', () => {
  it('keeps important outcomes, buffers cheap traces and gates detailed observers before work', () => {
    const policy = dailyDiagnosticPolicy()
    expect(diagnosticDestination({ scope: 'console', level: 'info' }, policy)).toBe('drop')
    expect(diagnosticDestination({ scope: 'action.note.save', phase: 'start' }, policy)).toBe(
      'ring'
    )
    expect(diagnosticDestination({ scope: 'ipc.action', phase: 'returned' }, policy)).toBe(
      'persist'
    )
    expect(diagnosticDestination({ outcome: 'mismatch' }, policy)).toBe('persist')
    expect(diagnosticDestination({ detail: true }, policy)).toBe('drop')
    const summarize = vi.fn()
    const result = { private: 'same identity' }
    expect(measureSyncPerformance('database', 'hydrate', () => result, summarize)).toBe(result)
    expect(summarize).not.toHaveBeenCalled()
  })
  it('expires using monotonic time after wall-clock rollback and caps extension at 30 minutes', () => {
    let wall = 10000000
    let mono = 0
    const state = createDiagnosticState({
      now: () => wall,
      monotonic: () => mono,
      timer: () => 1,
      clear: () => {}
    })
    expect(state.get().mode).toBe('daily')
    const initial = state.start()
    expect(initial.expiresAt - initial.startedAt).toBe(600000)
    state.start(30)
    expect(state.get().expiresAt - initial.startedAt).toBe(1800000)
    wall -= 86400000
    mono += 1800001
    expect(state.get().mode).toBe('daily')
    expect(state.snapshot().history.at(-1).reason).toBe('expired')
    expect(createDiagnosticState({ timer: () => 1, clear: () => {} }).get().mode).toBe('daily')
    state.dispose()
  })
  it('samples actions deterministically with a global daily and deep observation budget', () => {
    let mono = 0
    const state = createDiagnosticState({ monotonic: () => mono, timer: () => 1, clear: () => {} })
    const chosen = Array.from({ length: 1000 }, (_, i) => `action-${i}`).find(
      (id) => diagnosticHash(id) % 100 === 0
    )
    expect(state.observation(chosen).enabled).toBe(true)
    expect(state.observation(chosen).reason).toBe('skipped-budget')
    expect(state.observation('not-selected').reason).toBe('skipped-policy')
    mono += 60000
    expect(state.observation(chosen).enabled).toBe(true)
    state.start()
    for (let i = 0; i < 5; i++) expect(state.observation().enabled).toBe(true)
    expect(state.observation().reason).toBe('skipped-budget')
    mono += 1000
    expect(state.observation().enabled).toBe(true)
    state.dispose()
  })
  it('does not invoke getters and bounds cycles, contents, credentials, paths and exception causes', () => {
    const getter = vi.fn(() => {
      throw new Error('should not run')
    })
    const value = { content: 'private note', token: 'private token', nested: {} }
    Object.defineProperty(value, 'hostile', { get: getter, enumerable: true })
    value.nested.self = value
    const result = sanitizeDiagnosticValue(value)
    expect(getter).not.toHaveBeenCalled()
    expect(result.content).toEqual({ omitted: true, length: 12 })
    expect(result.token).toBe('[redacted]')
    expect(result.nested.self).toBe('[Circular]')
    expect(diagnosticText('app://test-window')).toBe('app://test-window')
    const text = diagnosticText(
      'https://user:pwd@service/api?token=foo#bar C:\\Users\\name\\private.txt Bearer ABC123'
    )
    expect(text).not.toMatch(/pwd|foo|bar|private\.txt|ABC123/)
    expect(
      sanitizeDiagnosticValue(new Error('outer', { cause: new Error('inner') })).cause.message
    ).toBe('inner')
    const huge = sanitizeDiagnosticValue(Array.from({ length: 10000 }, () => '中'.repeat(10000)))
    expect(JSON.stringify(huge).length).toBeLessThan(8192)
  })
})
