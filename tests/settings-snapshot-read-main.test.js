import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { parseForESLint } from 'vue-eslint-parser'
import { getViewSettingsScope } from '../src/main/settings/application-settings.js'
import { createSettingsOperationAdmission } from '../src/main/settings/settings-operation-admission.js'
import { createSettingsRuntime } from '../src/main/settings/settings-runtime.js'
import { createSettingsWriteSource } from '../src/main/settings/settings-write-source.js'
import { createWindowGeometryPersistence } from '../src/main/windows/window-geometry-persistence.js'
import {
  createDefaultSettings,
  serializeSetting,
  VIEW_MODES
} from '../src/shared/settings-schema.js'

const mainSource = readFileSync(new URL('../src/main/index.js', import.meta.url), 'utf8')
const mainNodes = []
function visit(node) {
  if (!node || typeof node.type !== 'string') return
  mainNodes.push(node)
  for (const [key, value] of Object.entries(node)) {
    if (['parent', 'tokens', 'comments'].includes(key)) continue
    if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') visit(value)
  }
}
visit(parseForESLint(mainSource, { ecmaVersion: 'latest', sourceType: 'module' }).ast)

function productionNode(predicate, label) {
  const matches = mainNodes.filter(predicate)
  if (matches.length !== 1)
    throw new Error(`Expected one production ${label}, found ${matches.length}`)
  return matches[0]
}

function productionFunction(name) {
  return mainSource.slice(
    ...productionNode((node) => node.type === 'FunctionDeclaration' && node.id?.name === name, name)
      .range
  )
}

function productionDeclaration(name) {
  const node = productionNode(
    (entry) => entry.type === 'VariableDeclarator' && entry.id?.name === name,
    name
  )
  return `const ${mainSource.slice(...node.range)};`
}

const snapshotHandler = productionNode(
  (node) =>
    node.type === 'CallExpression' &&
    node.callee.object?.name === 'mainWindowIpc' &&
    node.callee.property?.name === 'handle' &&
    node.arguments[0]?.value === 'get-settings-snapshot',
  'get-settings-snapshot handler'
).arguments[1]

// Evaluate the real entry declarations and callback, including their wiring.
// Importing index.js would launch Electron; copying its bodies would test a second implementation.
const productionAdapters = [
  productionDeclaration('settingsRuntime'),
  productionDeclaration('geometryPersistence'),
  ...[
    'persistStoredWindowBounds',
    'refreshResolvedSettings',
    'readAutoStartRuntime',
    'readSettingsRuntimeSnapshot',
    'getResolvedSettingsSnapshot'
  ].map(productionFunction),
  `return { settingsRuntime, geometryPersistence, readSnapshot: (${mainSource.slice(...snapshotHandler.range)}) };`
].join('\n')

const initialBounds = { x: 30, y: 40, width: 480, height: 800 }
const changedBounds = { x: 55.6, y: 71.2, width: 721.4, height: 611.6 }
const roundedBounds = { x: 56, y: 71, width: 721, height: 612 }
const geometryValues = (bounds) => ({
  posX: bounds.x,
  posY: bounds.y,
  width: bounds.width,
  height: bounds.height
})
const geometryRows = (bounds) =>
  Object.entries(geometryValues(bounds)).map(([name, value]) =>
    serializeSetting(`geometry.${name}`, value)
  )

function fixture(viewMode = VIEW_MODES.LIST) {
  const activeScope = getViewSettingsScope(viewMode)
  const location = resolve(`out/renderer/${viewMode === VIEW_MODES.LIST ? 'index' : viewMode}.html`)
  const contents = new EventEmitter()
  const frame = { url: pathToFileURL(location).href, isDestroyed: () => false }
  Object.assign(contents, {
    mainFrame: frame,
    isDestroyed: () => false,
    isCrashed: () => false
  })
  const window = {
    webContents: contents,
    isDestroyed: () => false,
    getBounds: () => ({ ...initialBounds })
  }
  const event = { sender: contents, senderFrame: frame }
  const admission = createSettingsOperationAdmission()
  const assertCanWrite = vi.fn(admission.assertOpen)
  const settingsWriteSource = createSettingsWriteSource({
    getMainWindow: () => window,
    getActiveWindowName: () => activeScope,
    getActiveRendererLocation: () => ({ type: 'file', value: location }),
    assertCanWrite,
    createToken: () => `${viewMode}-read-document`
  })
  const source = settingsWriteSource.issue(event)
  // These injected ports model committed rows, not a SQLite connection. Real
  // repository transactions and frame/IPC transport require their integration suites.
  const storedRows = new Map([[activeScope, geometryRows(initialBounds)]])
  const application = createDefaultSettings(viewMode)
  application.window.lockState = true
  const state = { quitting: false, autoStart: false }
  const ledger = { commitId: null, dependencies: {}, domains: {} }
  const effects = {
    materialConfig: vi.fn(),
    theme: vi.fn(),
    remote: vi.fn(),
    window: vi.fn(),
    blur: vi.fn(),
    dock: vi.fn(),
    broadcast: vi.fn(),
    features: vi.fn(),
    internalWrite: vi.fn(),
    complete: vi.fn(),
    retry: vi.fn(),
    track: vi.fn(admission.track),
    run: vi.fn(admission.run),
    drain: vi.fn(admission.drain)
  }
  const ports = {
    createSettingsRuntime,
    createWindowGeometryPersistence,
    VIEW_MODES,
    serializeSetting,
    getViewSettingsScope,
    settingsWriteSource,
    getMainWindow: () => window,
    getActiveWindowName: () => activeScope,
    mainViewNavigation: { mode: viewMode, isSwitching: () => false },
    isCompactPresentationActive: () => false,
    dockRuntime: {
      isDockGeometryPersistenceSuppressed: () => false,
      readStableSessionBounds: () => null
    },
    readApplicationSettings: vi.fn(() => application),
    getAllSettings: vi.fn((scope) => structuredClone(storedRows.get(scope) || [])),
    setSettingsBatch: vi.fn((scope, rows) => {
      const next = new Map((storedRows.get(scope) || []).map((row) => [row.key, row]))
      for (const row of rows) next.set(row.key, { ...row })
      storedRows.set(scope, [...next.values()])
    }),
    app: { getLoginItemSettings: vi.fn(() => ({ openAtLogin: state.autoStart })) },
    getDockRuntimeConfig: vi.fn(() => ({
      supportedEdges: ['top', 'left', 'right'],
      enabledEdges: [],
      activeEdges: [],
      revealHandleMode: 'direct'
    })),
    getDockRuntimeCapability: vi.fn(() => ({ supported: true, reason: null })),
    blurRuntime: {
      failed: false,
      initialized: true,
      config: { enabled: false },
      caps: { supported: true, platform: 'Windows', strategy: 'dcomp' },
      diagnostic: { status: 'disabled' }
    },
    captureShortcutService: { snapshot: vi.fn(() => ({ screenshot: { registered: false } })) },
    viewVisibilityShortcutService: {
      snapshot: vi.fn(() => ({ configured: 'F2', enabled: true, registered: true }))
    },
    syncBlurConfigFromResolved: effects.materialConfig,
    screenshotService: { syncTheme: effects.theme },
    remoteCoordinator: { settingsChanged: effects.remote },
    applyResolvedWindowRuntime: effects.window,
    applyResolvedBlurRuntime: effects.blur,
    reconcileDockRuntimeConfig: effects.dock,
    broadcastSettingsChanged: effects.broadcast,
    featureRuntime: { settingsChanged: effects.features },
    persistInternalSettingValues: effects.internalWrite,
    settingsApplicationCoordinator: {
      completeCommittedSettings: effects.complete,
      retryAppliedSettings: effects.retry,
      snapshotLedger: () => structuredClone(ledger)
    },
    settingsOperations: { track: effects.track, run: effects.run, drain: effects.drain },
    shutdownCoordinator: { isQuitting: vi.fn(() => state.quitting) },
    logger: { error: vi.fn() },
    console: { warn: vi.fn() }
  }
  const adapters = new Function(...Object.keys(ports), productionAdapters)(...Object.values(ports))
  return {
    ...adapters,
    ports,
    effects,
    ledger,
    storedRows,
    state,
    source,
    event,
    admission,
    assertCanWrite,
    activeScope,
    read: () => adapters.readSnapshot(event, source)
  }
}

function expectNoApplication(f) {
  for (const [name, effect] of Object.entries(f.effects))
    expect(effect, name).not.toHaveBeenCalled()
  expect(f.ledger).toEqual({ commitId: null, dependencies: {}, domains: {} })
  expect(f.admission.snapshot().pending).toBe(0)
}

describe('main settings snapshot read contract', () => {
  it.each(['expired token', 'child frame'])(
    'rejects %s before stored or platform reads',
    (kind) => {
      const f = fixture()
      const event =
        kind === 'child frame' ? { ...f.event, senderFrame: { ...f.event.senderFrame } } : f.event
      const source = kind === 'expired token' ? { ...f.source, token: 'old-document' } : f.source
      expect(() => f.readSnapshot(event, source)).toThrow('页面已失效')
      expect(f.ports.readApplicationSettings).not.toHaveBeenCalled()
      expect(f.ports.getAllSettings).not.toHaveBeenCalled()
      expect(f.ports.app.getLoginItemSettings).not.toHaveBeenCalled()
      expect(f.ports.setSettingsBatch).not.toHaveBeenCalled()
      expectNoApplication(f)
    }
  )

  it('keeps current-document reads available while page-leave has sealed writes', async () => {
    const f = fixture()
    await f.admission.sealAndDrain({ id: 'page-leave' })
    expect(() => f.admission.assertOpen()).toThrow('正在离开')
    expect(f.read().source).toEqual(f.source)
    expect(f.assertCanWrite).not.toHaveBeenCalled()
    expect(f.admission.snapshot()).toEqual({ sealed: true, stopped: false, pending: 0 })
    expect(f.ports.setSettingsBatch).not.toHaveBeenCalled()
    expectNoApplication(f)
  })

  it.each([VIEW_MODES.LIST, VIEW_MODES.MONTH, VIEW_MODES.WEEK])(
    'reads current %s rows and shared application values without applying them',
    (viewMode) => {
      const f = fixture(viewMode)
      const result = f.read()
      expect(result.source).toEqual(f.source)
      expect(result.values.geometry).toMatchObject(geometryValues(initialBounds))
      expect(result.values.window.lockState).toBe(true)
      expect(f.ports.readApplicationSettings).toHaveBeenCalledOnce()
      expect(f.ports.getAllSettings).toHaveBeenCalledExactlyOnceWith(f.activeScope)
      expect(f.ports.setSettingsBatch).not.toHaveBeenCalled()
      expectNoApplication(f)
    }
  )

  it('rereads stored rows on every query without forcing a revision or applying services', () => {
    const f = fixture()
    const first = f.read()
    const second = f.read()
    expect(second.revision).toBe(first.revision)
    expect(f.ports.readApplicationSettings).toHaveBeenCalledTimes(2)
    expect(f.ports.getAllSettings).toHaveBeenCalledTimes(2)
    expect(f.ports.app.getLoginItemSettings).toHaveBeenCalledTimes(2)
    expect(f.ports.setSettingsBatch).not.toHaveBeenCalled()
    expectNoApplication(f)
  })

  it.each(['readApplicationSettings', 'getAllSettings'])(
    'rejects %s failure without returning the old cache or sampling a new runtime',
    (port) => {
      const f = fixture()
      const before = f.read()
      const values = f.settingsRuntime.values
      const observations = f.ports.app.getLoginItemSettings.mock.calls.length
      const error = new Error(`${port} SQLite read unavailable`)
      f.ports[port].mockImplementationOnce(() => {
        throw error
      })
      expect(() => f.read()).toThrow(error)
      expect(f.settingsRuntime.values).toBe(values)
      expect(f.settingsRuntime.revision).toBe(before.revision)
      expect(f.ports.app.getLoginItemSettings).toHaveBeenCalledTimes(observations)
      expect(f.ports.setSettingsBatch).not.toHaveBeenCalled()
      expectNoApplication(f)
    }
  )

  it('samples a new OS/native observation at the same settings revision', () => {
    const f = fixture()
    const first = f.read()
    f.state.autoStart = true
    f.ports.blurRuntime.config.enabled = true
    const second = f.read()
    expect(second.revision).toBe(first.revision)
    expect(first.values.system.autoStart).toBe(false)
    expect(second.values.system.autoStart).toBe(true)
    expect(second.runtime.autoStart).toEqual({ value: true, error: null })
    expect(second.runtime.blur.effectiveEnabled).toBe(true)
    expect(f.settingsRuntime.values.system).toBeUndefined()
    expect(f.ports.setSettingsBatch).not.toHaveBeenCalled()
    expectNoApplication(f)
  })

  it('retains the existing boolean and error contract when the OS observation fails', () => {
    const f = fixture()
    const error = new Error('OS observation unavailable')
    f.ports.app.getLoginItemSettings.mockImplementationOnce(() => {
      throw error
    })
    const result = f.read()
    expect(result.values.system.autoStart).toBe(false)
    expect(result.runtime.autoStart).toEqual({ value: false, error: error.message })
    expect(f.ports.logger.error).toHaveBeenCalledExactlyOnceWith('settings.auto-start-read', error)
    expect(f.ports.setSettingsBatch).not.toHaveBeenCalled()
    expectNoApplication(f)
  })
})

describe('main stored geometry adapter and its real geometry owner', () => {
  it.each([VIEW_MODES.LIST, VIEW_MODES.MONTH, VIEW_MODES.WEEK])(
    'commits normalized %s expanded bounds and refreshes cache synchronously without application',
    (viewMode) => {
      const f = fixture(viewMode)
      const before = f.read()
      f.geometryPersistence.setStableBounds(initialBounds)
      f.geometryPersistence.markDirty()
      const result = f.geometryPersistence.persistStableBounds(changedBounds)
      expect(result).toEqual(roundedBounds)
      expect(result.then).toBeUndefined()
      expect(f.geometryPersistence.getStableBounds()).toEqual(roundedBounds)
      expect(f.geometryPersistence.isDirty()).toBe(false)
      expect(f.settingsRuntime.values.geometry).toMatchObject(geometryValues(roundedBounds))
      expect(f.settingsRuntime.revision).toBe(before.revision + 1)
      expect(f.ports.setSettingsBatch).toHaveBeenCalledExactlyOnceWith(
        f.activeScope,
        geometryRows(roundedBounds)
      )
      expect(f.geometryPersistence.flush()).toBe(false)
      expect(f.ports.setSettingsBatch).toHaveBeenCalledOnce()
      expectNoApplication(f)
    }
  )

  it('keeps SQL success when resolution fails and a fresh getter recovers B without resaving', () => {
    const f = fixture()
    const before = f.read()
    f.geometryPersistence.setStableBounds(initialBounds)
    f.geometryPersistence.markDirty()
    const error = new Error('committed geometry read unavailable')
    f.ports.getAllSettings.mockImplementationOnce(() => {
      throw error
    })
    expect(f.geometryPersistence.persistStableBounds(changedBounds)).toEqual(roundedBounds)
    expect(f.geometryPersistence.getStableBounds()).toEqual(roundedBounds)
    expect(f.geometryPersistence.isDirty()).toBe(false)
    expect(f.settingsRuntime.values.geometry).toMatchObject(geometryValues(initialBounds))
    expect(f.settingsRuntime.revision).toBe(before.revision)
    expect(f.ports.logger.error).toHaveBeenCalledExactlyOnceWith(
      'settings.geometry-resolution',
      error
    )
    expect(f.geometryPersistence.flush()).toBe(false)
    const recovered = f.read()
    expect(recovered.values.geometry).toMatchObject(geometryValues(roundedBounds))
    expect(recovered.revision).toBe(before.revision + 1)
    expect(f.ports.setSettingsBatch).toHaveBeenCalledOnce()
    expectNoApplication(f)
  })

  it('propagates a SQL failure before cache refresh and retains dirty/stable ownership', () => {
    const f = fixture()
    const before = f.read()
    f.geometryPersistence.setStableBounds(initialBounds)
    f.geometryPersistence.markDirty()
    const reads = f.ports.getAllSettings.mock.calls.length
    const error = new Error('geometry SQL transaction failed')
    f.ports.setSettingsBatch.mockImplementationOnce(() => {
      throw error
    })
    expect(() => f.geometryPersistence.persistStableBounds(changedBounds)).toThrow(error)
    expect(f.geometryPersistence.getStableBounds()).toEqual(initialBounds)
    expect(f.geometryPersistence.isDirty()).toBe(true)
    expect(f.settingsRuntime.revision).toBe(before.revision)
    expect(f.ports.getAllSettings).toHaveBeenCalledTimes(reads)
    expect(f.ports.shutdownCoordinator.isQuitting).not.toHaveBeenCalled()
    expect(f.ports.logger.error).not.toHaveBeenCalled()
    expectNoApplication(f)
  })

  it('performs the final shutdown flush once without reads, observations or new drain work', () => {
    const f = fixture()
    f.state.quitting = true
    f.admission.stop()
    f.geometryPersistence.setStableBounds(roundedBounds)
    f.geometryPersistence.markDirty()
    expect(f.geometryPersistence.flush()).toBe(true)
    expect(f.geometryPersistence.isDirty()).toBe(false)
    expect(f.geometryPersistence.flush()).toBe(false)
    expect(f.ports.setSettingsBatch).toHaveBeenCalledExactlyOnceWith(
      f.activeScope,
      geometryRows(roundedBounds)
    )
    expect(f.ports.readApplicationSettings).not.toHaveBeenCalled()
    expect(f.ports.getAllSettings).not.toHaveBeenCalled()
    expect(f.ports.app.getLoginItemSettings).not.toHaveBeenCalled()
    expect(f.settingsRuntime.revision).toBe(0)
    expect(f.ports.logger.error).not.toHaveBeenCalled()
    expectNoApplication(f)
  })

  it('preserves pending final geometry when shutdown SQL fails', () => {
    const f = fixture()
    f.state.quitting = true
    f.admission.stop()
    f.geometryPersistence.setStableBounds(roundedBounds)
    f.geometryPersistence.markDirty()
    const error = new Error('shutdown geometry SQL failed')
    f.ports.setSettingsBatch.mockImplementationOnce(() => {
      throw error
    })
    expect(() => f.geometryPersistence.flush()).toThrow(error)
    expect(f.geometryPersistence.isDirty()).toBe(true)
    expect(f.geometryPersistence.readPendingBounds()).toEqual(roundedBounds)
    expect(f.ports.readApplicationSettings).not.toHaveBeenCalled()
    expect(f.ports.getAllSettings).not.toHaveBeenCalled()
    expect(f.ports.logger.error).not.toHaveBeenCalled()
    expectNoApplication(f)
  })
})
