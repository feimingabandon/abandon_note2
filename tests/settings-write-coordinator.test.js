import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/main/settings/application-settings.js', () => ({
  APPLICATION_SETTING_IDS: ['window.zOrderMode'],
  writeApplicationSettings: vi.fn()
}))
vi.mock('../src/main/db/db-settings-repository.js', () => ({
  getAllSettings: vi.fn(),
  setSettingsBatch: vi.fn()
}))
vi.mock('../src/main/logging/operation-context.js', () => ({ currentOperation: () => null }))
vi.mock('../src/main/logging/persistence-evidence.js', () => ({
  readSettingEvidence: () => [],
  reportSettingEvidence: vi.fn()
}))
import { createSettingsWriteCoordinator } from '../src/main/settings/settings-write-coordinator.js'

function fixture() {
  const calls = []
  const snapshot = { revision: 5, values: {} }
  const ports = {
    getActiveWindowName: () => 'month',
    getAllSettings: vi.fn(() => []),
    setSettingsBatch: vi.fn(() => calls.push('view-sql')),
    writeApplicationSettings: vi.fn(() => calls.push('application-sql')),
    observeVerification: () => ({ enabled: false, reason: 'skipped-policy' }),
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
  return { coordinator: createSettingsWriteCoordinator(ports), ports, snapshot, calls }
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
      'view-sql',
      'application-sql',
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
    expect(ports.refreshResolvedSettings).not.toHaveBeenCalled()
  })
  it('respects an already-applied native material without skipping refresh or broadcast', () => {
    const { coordinator, ports, calls } = fixture()
    coordinator.persistSettingValues([{ id: 'blur.enabled', value: true }], {
      applyBlurRuntime: false
    })
    expect(ports.applyResolvedBlurRuntime).not.toHaveBeenCalled()
    expect(calls).toEqual(['view-sql', 'refresh', 'snapshot', 'broadcast'])
  })
})
