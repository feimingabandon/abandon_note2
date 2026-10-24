import { describe, expect, it } from 'vitest'
import {
  isSettingsApplicationRetry,
  isSettingsApplicationState
} from '../src/shared/settings-application-state.js'

const source = { token: 'document', scope: 'main' }
function state() {
  return {
    source,
    ledgerRevision: 8,
    ledger: {
      scope: 'main',
      ledgerRevision: 8,
      commitId: 'commit-1',
      current: {
        attempt: 2,
        reason: 'retry',
        phase: 'settled',
        targets: { domains: [], dependencies: ['theme'] },
        resolve: { status: 'applied', error: null },
        snapshot: { status: 'available', error: null },
        verification: { status: 'skipped', error: null },
        delivery: { status: 'completed', error: null, confirmation: 'invocation-only' },
        superseded: false
      },
      domains: { blur: { attempt: 1, status: 'failed', error: 'native refused', retryable: true } },
      dependencies: {
        theme: { attempt: 2, status: 'unconfirmed', error: 'no host ACK', retryable: true }
      },
      errors: [{ attempt: 1, stage: 'domain:blur', error: { message: 'native refused' } }]
    }
  }
}

describe('settings application metadata contract', () => {
  it('keeps saved-value revision independent and accepts explicit unconfirmed metadata', () => {
    expect(isSettingsApplicationState(state(), { source })).toBe(true)
    const initial = state()
    initial.ledger.current = null
    expect(isSettingsApplicationState(initial)).toBe(true)
  })

  it('rejects foreign sources, version conflicts and payload-bearing ledger data', () => {
    expect(
      isSettingsApplicationState(state(), { source: { ...source, token: 'replacement' } })
    ).toBe(false)
    for (const mutate of [
      (value) => {
        value.ledger.scope = 'month'
      },
      (value) => {
        value.ledgerRevision = -1
      },
      (value) => {
        value.ledger.ledgerRevision += 1
      },
      (value) => {
        value.ledger.values = { css: { fontSizeBase: 18 } }
      },
      (value) => {
        value.ledger.current.snapshot.values = {}
      },
      (value) => {
        value.ledger.domains.blur.status = 'success'
      },
      (value) => {
        value.ledger.dependencies.unknown = { status: 'applied' }
      },
      (value) => {
        value.ledger.errors = Array.from({ length: 65 }, () => value.ledger.errors[0])
      },
      (value) => {
        value.ledger.current = undefined
      }
    ]) {
      const value = state()
      mutate(value)
      expect(isSettingsApplicationState(value)).toBe(false)
    }
  })

  it('permits only explicit target arrays, including a deliberate resolve-only command', () => {
    for (const value of [
      { domains: [], dependencies: [] },
      { domains: [], dependencies: ['theme'] },
      { domains: ['blur'], dependencies: [] }
    ])
      expect(isSettingsApplicationRetry(value)).toBe(true)
    for (const value of [
      null,
      {},
      { domains: ['blur'] },
      { domains: [], dependencies: ['unknown'] },
      { domains: ['blur', 'blur'], dependencies: [] },
      { domains: [], dependencies: [], values: {} },
      { domains: [], dependencies: [], context: source },
      { domains: 'window', dependencies: [] }
    ])
      expect(isSettingsApplicationRetry(value)).toBe(false)
  })
})
