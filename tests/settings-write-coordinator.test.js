import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/main/settings/application-settings.js', () => ({
  APPLICATION_SETTING_IDS: ['window.zOrderMode'],
  writeApplicationSettings: vi.fn()
}))
vi.mock('../src/main/db/db-settings-repository.js', () => ({
  getAllSettings: vi.fn(),
  runSettingsTransaction: vi.fn((operation) => operation()),
  setSettingsBatch: vi.fn()
}))
vi.mock('../src/main/logging/operation-context.js', () => ({ currentOperation: () => null }))
vi.mock('../src/main/logging/persistence-evidence.js', () => ({
  readSettingEvidence: vi.fn(() => []),
  reportSettingEvidence: vi.fn()
}))
import { createSettingsWriteCoordinator } from '../src/main/settings/settings-write-coordinator.js'
import {
  readSettingEvidence,
  reportSettingEvidence
} from '../src/main/logging/persistence-evidence.js'

function fixture(options = {}) {
  const calls = []
  const snapshot = { revision: 5, values: {} }
  let transactionActive = false
  const ports = {
    getActiveWindowName: () => 'month',
    getAllSettings: vi.fn(() => []),
    runSettingsTransaction: vi.fn((operation) => {
      calls.push('transaction-begin')
      transactionActive = true
      try {
        const result = operation()
        calls.push('transaction-commit')
        return result
      } catch (error) {
        calls.push('transaction-rollback')
        throw error
      } finally {
        transactionActive = false
      }
    }),
    setSettingsBatch: vi.fn(() => calls.push('view-sql')),
    writeApplicationSettings: vi.fn(() => calls.push('application-sql')),
    observeVerification: () =>
      options.verificationTicket || { enabled: false, reason: 'skipped-policy' },
    refreshResolvedSettings: vi.fn(() => calls.push('refresh')),
    applyResolvedWindowRuntime: vi.fn(() => calls.push('window')),
    applyResolvedBlurRuntime: vi.fn(() => calls.push('blur')),
    getDockRuntimeConfig: () => ({ enabledEdges: [] }),
    reconcileDockRuntimeConfig: vi.fn(() => calls.push('dock')),
    getResolvedSettingsSnapshot: vi.fn(() => {
      calls.push('snapshot')
      return snapshot
    }),
    broadcastSettingsChanged: vi.fn(() => calls.push('broadcast'))
  }
  if (options.completeCommittedSettings)
    ports.completeCommittedSettings = options.completeCommittedSettings
  return {
    coordinator: createSettingsWriteCoordinator(ports),
    ports,
    snapshot,
    calls,
    isTransactionActive: () => transactionActive
  }
}
describe('settings write sequencing', () => {
  it('writes each original scope before runtime side effects and broadcasts the returned snapshot', () => {
    const { coordinator, ports, calls, snapshot } = fixture()
    expect(
      coordinator.persistSettingValues([
        { id: 'window.zOrderMode', value: 'normal' },
        { id: 'css.bgColor', value: '#abcdef' },
        { id: 'dock.enabledEdges', value: ['left'] }
      ])
    ).toBe(snapshot)
    expect(calls).toEqual([
      'transaction-begin',
      'view-sql',
      'application-sql',
      'transaction-commit',
      'refresh',
      'window',
      'blur',
      'dock',
      'snapshot',
      'broadcast'
    ])
    expect(ports.setSettingsBatch).toHaveBeenCalledWith(
      'month',
      expect.arrayContaining([expect.objectContaining({ id: 'dock.enabledEdges' })])
    )
    expect(ports.writeApplicationSettings).toHaveBeenCalledWith([
      { id: 'window.zOrderMode', value: 'normal' }
    ])
    expect(ports.broadcastSettingsChanged).toHaveBeenCalledWith(snapshot)
  })
  it('validates the whole ID group before any scope is written', () => {
    const { coordinator, ports } = fixture()
    expect(() =>
      coordinator.persistSettingValues([
        { id: 'css.bgColor', value: '#abcdef' },
        { id: 'unknown-setting', value: true }
      ])
    ).toThrow()
    expect(ports.setSettingsBatch).not.toHaveBeenCalled()
    expect(ports.writeApplicationSettings).not.toHaveBeenCalled()
    expect(ports.runSettingsTransaction).not.toHaveBeenCalled()
    expect(ports.refreshResolvedSettings).not.toHaveBeenCalled()
  })
  it('respects an already-applied native material without skipping refresh or broadcast', () => {
    const { coordinator, ports, calls } = fixture()
    coordinator.persistSettingValues([{ id: 'blur.enabled', value: true }], {
      applyBlurRuntime: false
    })
    expect(ports.applyResolvedBlurRuntime).not.toHaveBeenCalled()
    expect(calls).toEqual([
      'transaction-begin',
      'view-sql',
      'transaction-commit',
      'refresh',
      'snapshot',
      'broadcast'
    ])
  })
  it('keeps both scope writers inside one transaction and publishes only after it commits', () => {
    const { coordinator, ports, calls, isTransactionActive } = fixture()
    ports.setSettingsBatch.mockImplementationOnce(() => {
      expect(isTransactionActive()).toBe(true)
      calls.push('view-sql')
    })
    ports.writeApplicationSettings.mockImplementationOnce(() => {
      expect(isTransactionActive()).toBe(true)
      calls.push('application-sql')
    })
    ports.refreshResolvedSettings.mockImplementationOnce(() => {
      expect(isTransactionActive()).toBe(false)
      calls.push('refresh')
    })
    coordinator.persistSettingValues([
      { id: 'css.bgColor', value: '1 2 3' },
      { id: 'window.zOrderMode', value: 'normal' }
    ])
    expect(ports.runSettingsTransaction).toHaveBeenCalledOnce()
    expect(calls).toEqual([
      'transaction-begin',
      'view-sql',
      'application-sql',
      'transaction-commit',
      'refresh',
      'window',
      'blur',
      'snapshot',
      'broadcast'
    ])
  })
  it('propagates a second-scope SQL failure without reporting persistence or applying runtime effects', () => {
    const { coordinator, ports, calls } = fixture()
    const failure = new Error('application SQL failed')
    const previousReports = reportSettingEvidence.mock.calls.length
    ports.writeApplicationSettings.mockImplementationOnce(() => {
      calls.push('application-sql')
      throw failure
    })
    expect(() =>
      coordinator.persistSettingValues([
        { id: 'css.bgColor', value: '1 2 3' },
        { id: 'dock.enabledEdges', value: ['left'] },
        { id: 'window.zOrderMode', value: 'normal' }
      ])
    ).toThrow(failure)
    expect(calls).toEqual([
      'transaction-begin',
      'view-sql',
      'application-sql',
      'transaction-rollback'
    ])
    expect(reportSettingEvidence).toHaveBeenCalledTimes(previousReports)
    expect(ports.refreshResolvedSettings).not.toHaveBeenCalled()
    expect(ports.applyResolvedWindowRuntime).not.toHaveBeenCalled()
    expect(ports.applyResolvedBlurRuntime).not.toHaveBeenCalled()
    expect(ports.reconcileDockRuntimeConfig).not.toHaveBeenCalled()
    expect(ports.getResolvedSettingsSnapshot).not.toHaveBeenCalled()
    expect(ports.broadcastSettingsChanged).not.toHaveBeenCalled()
  })

  it('hands the full post-commit promise to the optional owner without running the legacy effects', async () => {
    const result = { kind: 'settings-saved', persistence: { status: 'saved' }, snapshot: null }
    const completeCommittedSettings = vi.fn(async () => result)
    const f = fixture({ completeCommittedSettings })
    const reports = reportSettingEvidence.mock.calls.length
    const operation = f.coordinator.persistSettingValues(
      [
        { id: 'window.zOrderMode', value: 'normal' },
        { id: 'css.bgColor', value: '1 2 3' },
        { id: 'dock.enabledEdges', value: ['left'] }
      ],
      { applyBlurRuntime: false }
    )
    expect(f.isTransactionActive()).toBe(false)
    expect(f.calls).toEqual([
      'transaction-begin',
      'view-sql',
      'application-sql',
      'transaction-commit'
    ])
    await expect(operation).resolves.toBe(result)
    expect(completeCommittedSettings).toHaveBeenCalledExactlyOnceWith({
      scope: 'month',
      ids: ['window.zOrderMode', 'css.bgColor', 'dock.enabledEdges'],
      previousDockConfig: { enabledEdges: [] },
      applyBlurRuntime: false,
      verify: expect.any(Function)
    })
    expect(completeCommittedSettings.mock.calls[0][0]).not.toHaveProperty('values')
    expect(reportSettingEvidence).toHaveBeenCalledTimes(reports)
    expect(await completeCommittedSettings.mock.calls[0][0].verify()).toEqual({
      status: 'skipped',
      reason: 'skipped-policy'
    })
    expect(reportSettingEvidence).toHaveBeenCalledTimes(reports)
    expect(f.ports.refreshResolvedSettings).not.toHaveBeenCalled()
    expect(f.ports.getResolvedSettingsSnapshot).not.toHaveBeenCalled()
    expect(f.ports.broadcastSettingsChanged).not.toHaveBeenCalled()
  })

  it('executes enabled post-commit evidence and returns its explicit completion marker', () => {
    const completeCommittedSettings = vi.fn(() => ({ persistence: { status: 'saved' } }))
    const f = fixture({
      completeCommittedSettings,
      verificationTicket: { enabled: true, reason: 'enabled-policy' }
    })
    const reports = reportSettingEvidence.mock.calls.length
    const after = [
      { id: 'css.bgColor', scope: 'month', expected: '1 2 3', stored: '1 2 3', exists: true }
    ]
    // A missing before image affects change evidence, not the successful current readback.
    readSettingEvidence.mockReturnValueOnce(undefined).mockReturnValueOnce(after)
    f.coordinator.persistSettingValue('css.bgColor', '1 2 3')
    expect(completeCommittedSettings.mock.calls[0][0].verify()).toEqual({
      status: 'completed',
      reason: 'enabled-policy'
    })
    expect(reportSettingEvidence).toHaveBeenCalledTimes(reports + 1)
  })

  it.each([
    [undefined, 'readback-unavailable'],
    [[], 'readback-unavailable'],
    [
      [
        { id: 'css.fontSizeBase', scope: 'month', expected: '1 2 3', stored: '1 2 3', exists: true }
      ],
      'readback-unavailable'
    ],
    [
      [{ id: 'css.bgColor', scope: 'month', expected: '1 2 3', stored: '9 9 9', exists: true }],
      'readback-mismatch'
    ]
  ])('keeps unavailable or mismatching enabled evidence unconfirmed: %j', (after, reason) => {
    const completeCommittedSettings = vi.fn(() => ({ persistence: { status: 'saved' } }))
    const f = fixture({
      completeCommittedSettings,
      verificationTicket: { enabled: true, reason: 'enabled-policy' }
    })
    readSettingEvidence.mockReturnValueOnce([]).mockReturnValueOnce(after)
    expect(f.coordinator.persistSettingValue('css.bgColor', '1 2 3')).toEqual({
      persistence: { status: 'saved' }
    })
    expect(completeCommittedSettings.mock.calls[0][0].verify()).toEqual({
      status: 'unconfirmed',
      reason
    })
    expect(reportSettingEvidence).toHaveBeenLastCalledWith([], after)
  })

  it('does not hand off an invalid or rolled-back group to the optional post-commit owner', () => {
    const completeCommittedSettings = vi.fn()
    const f = fixture({ completeCommittedSettings })
    expect(() => f.coordinator.persistSettingValue('unknown-setting', true)).toThrow()
    expect(completeCommittedSettings).not.toHaveBeenCalled()
    f.ports.writeApplicationSettings.mockImplementationOnce(() => {
      throw new Error('second SQL failed')
    })
    expect(() =>
      f.coordinator.persistSettingValues([
        { id: 'css.bgColor', value: '1 2 3' },
        { id: 'window.zOrderMode', value: 'normal' }
      ])
    ).toThrow('second SQL failed')
    expect(completeCommittedSettings).not.toHaveBeenCalled()
    expect(f.ports.refreshResolvedSettings).not.toHaveBeenCalled()
  })
})
