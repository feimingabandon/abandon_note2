import { describe, expect, it } from 'vitest'
import {
  isSettingsSnapshot,
  isSettingsSource,
  parseSettingsReceipt,
  sameSettingsSource
} from '../src/shared/settings-receipt.js'

const source = { token: 'receipt-document', scope: 'main' }
const canonical = () => ({
  source: { ...source },
  revision: 3,
  values: { css: { fontSizeBase: 18 } }
})
const saved = () => ({
  kind: 'settings-saved',
  source: { ...source },
  persistence: { status: 'saved', commitId: 'opaque-commit-a' },
  application: { status: 'failed' },
  snapshot: null,
  snapshotError: { message: 'resolved snapshot unavailable' }
})

describe('settings receipt decoding', () => {
  it('accepts a legacy canonical setter without changing its fields or source', () => {
    const result = canonical()
    const parsed = parseSettingsReceipt(result, { source })
    expect(parsed).toMatchObject({ valid: true, saved: true, persistence: null, error: null })
    expect(parsed.canonical).toBe(result)
    expect(parsed.source).toEqual(source)
    parsed.source.token = 'changed copy'
    expect(result.source).toEqual(source)
  })

  it('keeps additive canonical metadata separate from a failed application', () => {
    const result = {
      ...canonical(),
      persistence: saved().persistence,
      application: { status: 'failed', domains: { window: { status: 'failed' } } }
    }
    const parsed = parseSettingsReceipt(result)
    expect(parsed.saved).toBe(true)
    expect(parsed.canonical).toBe(result)
    expect(parsed.application).toBe(result.application)
    expect(parsed.persistence.commitId).toBe('opaque-commit-a')
  })

  it.each([false, true])(
    'preserves native success=%s while decoding its nested canonical',
    (success) => {
      const result = {
        success,
        config: { enabled: false },
        runtime: { effectiveEnabled: false },
        snapshot: canonical()
      }
      const parsed = parseSettingsReceipt(result, { source })
      expect(parsed).toMatchObject({ valid: true, saved: true, error: null })
      expect(parsed.canonical).toBe(result.snapshot)
      expect(result.success).toBe(success)
      expect(result.runtime).toEqual({ effectiveEnabled: false })
    }
  )

  it.each(['top-level', 'nested'])(
    'accepts a %s saved envelope without inventing canonical values or runtime',
    (shape) => {
      const receipt = saved()
      const result = shape === 'nested' ? { success: false, snapshot: receipt } : receipt
      const parsed = parseSettingsReceipt(result, { source })
      expect(parsed).toMatchObject({ valid: true, saved: true, canonical: null, source })
      expect(parsed.snapshotError).toEqual(receipt.snapshotError)
      expect(Object.hasOwn(parsed, 'values')).toBe(false)
      expect(Object.hasOwn(parsed, 'runtime')).toBe(false)
      expect(parsed.application.status).toBe('failed')
    }
  )

  it('accepts native top-level save metadata with an explicitly absent nested snapshot', () => {
    const result = { ...saved(), success: false, config: { enabled: false } }
    expect(parseSettingsReceipt(result)).toMatchObject({
      valid: true,
      saved: true,
      canonical: null
    })
  })

  it.each([null, 'opaque-previous-commit'])(
    'recognizes an application retry with commit marker %s without calling it a new save',
    (commitId) => {
      const result = { ...saved(), persistence: { status: 'unchanged', commitId } }
      expect(parseSettingsReceipt(result)).toMatchObject({
        valid: true,
        saved: false,
        canonical: null,
        persistence: { status: 'unchanged', commitId }
      })
    }
  )

  it.each([
    { token: 'other-document', scope: 'main' },
    { token: source.token, scope: 'week' }
  ])('rejects a receipt from another document or scope %#', (foreign) => {
    expect(parseSettingsReceipt({ ...saved(), source: foreign }, { source })).toMatchObject({
      valid: false,
      saved: false,
      canonical: null,
      error: { code: 'SETTINGS_SNAPSHOT_SOURCE_MISMATCH' }
    })
  })

  it('rejects a conflicting outer native source instead of trusting only the nested snapshot', () => {
    expect(
      parseSettingsReceipt({ source: { ...source, token: 'foreign' }, snapshot: canonical() })
    ).toMatchObject({ valid: false, error: { code: 'SETTINGS_SNAPSHOT_SOURCE_MISMATCH' } })
  })

  it.each([
    { ...canonical(), values: [] },
    { ...canonical(), revision: -1 },
    { ...canonical(), revision: Number.NaN },
    { ...canonical(), source: { token: '', scope: 'main' } },
    { ...canonical(), source: { token: source.token, scope: 'arbitrary' } }
  ])('does not reinterpret a malformed canonical as a valid save envelope %#', (result) => {
    expect(parseSettingsReceipt({ ...result, persistence: saved().persistence })).toMatchObject({
      valid: false,
      saved: false,
      canonical: null
    })
  })

  it.each([
    { status: 'saved' },
    { status: 'saved', commitId: '' },
    { status: 'saved', commitId: Number.POSITIVE_INFINITY },
    { status: 'failed', commitId: 'opaque' },
    { status: 'unchanged', commitId: {} }
  ])('rejects invalid persistence metadata %#', (persistence) => {
    expect(parseSettingsReceipt({ ...saved(), persistence })).toMatchObject({
      valid: false,
      saved: false,
      error: { code: 'SETTINGS_RECEIPT_INVALID' }
    })
  })

  it('requires an explicit null snapshot when values are unavailable', () => {
    const result = saved()
    delete result.snapshot
    expect(parseSettingsReceipt(result)).toMatchObject({ valid: false, saved: false })
  })

  it.each([undefined, null, true, false, 'saved', [], { success: true, config: {}, runtime: {} }])(
    'does not confuse a separate domain result with a persistence acknowledgement %#',
    (result) => {
      expect(parseSettingsReceipt(result)).toMatchObject({ valid: false, saved: false })
    }
  )

  it('validates source and snapshot identity without parsing the opaque commit marker', () => {
    expect(isSettingsSource(source)).toBe(true)
    expect(isSettingsSource({ ...source, scope: 'linux' })).toBe(false)
    expect(sameSettingsSource(source, { ...source })).toBe(true)
    expect(sameSettingsSource(source, { ...source, token: 'replacement' })).toBe(false)
    expect(sameSettingsSource(null, null)).toBe(false)
    expect(isSettingsSnapshot(canonical())).toBe(true)
    expect(isSettingsSnapshot(saved())).toBe(false)
    expect(
      parseSettingsReceipt({ ...saved(), persistence: { status: 'saved', commitId: 0 } }).saved
    ).toBe(true)
  })
})
