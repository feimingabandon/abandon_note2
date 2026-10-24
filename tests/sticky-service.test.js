import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({
  handlers: new Map(),
  instances: [],
  nextWebContentsId: 100,
  failRegistration: null,
  onWindowCreated: null
}))

vi.mock('electron', () => {
  const display = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1,
    rotation: 0
  }

  class BrowserWindow {
    constructor(options) {
      this.options = options
      this.destroyed = false
      this.visible = false
      this.alwaysOnTop = Boolean(options.alwaysOnTop)
      this.alwaysOnTopLevel = null
      this.listeners = new Map()
      this.webContentsListeners = new Map()
      this.webContents = {
        id: ++electronState.nextWebContentsId,
        isDestroyed: () => this.destroyed,
        send: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        on: vi.fn((eventName, listener) => this.webContentsListeners.set(eventName, listener))
      }
      electronState.instances.push(this)
      electronState.onWindowCreated?.(this)
    }

    on(eventName, listener) {
      this.listeners.set(eventName, listener)
    }

    once(eventName, listener) {
      this.listeners.set(eventName, listener)
    }

    isDestroyed() {
      return this.destroyed
    }

    getBounds() {
      return {
        x: this.options.x,
        y: this.options.y,
        width: this.options.width,
        height: this.options.height
      }
    }

    loadFile() {
      return Promise.resolve()
    }

    loadURL() {
      return Promise.resolve()
    }

    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      this.visible = false
      this.listeners.get('closed')?.()
    }

    showInactive() {
      this.visible = true
    }

    isVisible() {
      return this.visible
    }

    moveTop() {}

    focus() {}

    setAlwaysOnTop(flag, level) {
      this.alwaysOnTop = flag
      this.alwaysOnTopLevel = level
    }

    isAlwaysOnTop() {
      return this.alwaysOnTop
    }
  }

  return {
    BrowserWindow,
    ipcMain: {
      handle: (channel, handler) => {
        if (channel === electronState.failRegistration) throw new Error('handler already exists')
        electronState.handlers.set(channel, handler)
      },
      removeHandler: (channel) => electronState.handlers.delete(channel)
    },
    screen: {
      getCursorScreenPoint: () => ({ x: 1700, y: 220 }),
      getDisplayNearestPoint: () => display,
      getPrimaryDisplay: () => display,
      getAllDisplays: () => [display],
      on: vi.fn(),
      removeListener: vi.fn()
    }
  }
})

import { ElectronStickyService } from '../src/main/sticky/ElectronStickyService.js'
import { createBusinessMutationAdmission } from '../src/main/application/business-mutation-admission.js'
import { ReminderWindow } from '../src/main/services/ReminderWindow.js'
import { BrowserWindow, ipcMain } from 'electron'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

// Model Electron close dispatch, including an independent later close listener.
// The existing window fixture keeps each service listener addressable for races.
function requestWindowClose(window, { prevented = false, afterService = () => {} } = {}) {
  const event = {
    defaultPrevented: prevented,
    preventDefault() {
      this.defaultPrevented = true
    }
  }
  window.listeners.get('close')?.(event)
  afterService(event)
  if (!event.defaultPrevented) window.destroy()
  return event
}

function createService(
  mainBounds = { x: 1440, y: 25, width: 480, height: 930 },
  defaultAppearance,
  stickyRepository,
  overrides = {}
) {
  const mainWindow = {
    webContents: { id: 1 },
    isDestroyed: () => false,
    isVisible: () => true,
    getBounds: () => mainBounds
  }
  return {
    mainWindow,
    service: new ElectronStickyService({
      getMainWindow: () => mainWindow,
      getNoteById: () => ({ id: 1, content: '测试便利贴正文' }),
      getDefaultAppearance: () => defaultAppearance,
      stickyRepository,
      preloadPath: 'sticky-preload.js',
      rendererFile: 'sticky.html',
      ...overrides
    })
  }
}

function createRepository(initialRecords = []) {
  const records = new Map(initialRecords.map((record) => [record.id, structuredClone(record)]))
  return {
    records,
    list: vi.fn(() => [...records.values()].map((record) => structuredClone(record))),
    count: vi.fn(() => records.size),
    exists: vi.fn((id) => records.has(id)),
    insert: vi.fn((record) => records.set(record.id, structuredClone(record))),
    update: vi.fn((id, patch) => {
      const record = records.get(id)
      if (!record) return false
      records.set(id, { ...record, ...structuredClone(patch) })
      return true
    }),
    delete: vi.fn((id) => records.delete(id)),
    deleteAll: vi.fn(() => {
      const count = records.size
      records.clear()
      return count
    })
  }
}

function persistedRecord(overrides = {}) {
  return {
    id: 'sticky-persisted-1',
    noteId: 1,
    content: '需要恢复的便利贴',
    bounds: { x: 120, y: 80, width: 280, height: 260 },
    displayId: '1',
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    fontSize: 16,
    backgroundColor: '#FFF2A8',
    cornerRadius: 0,
    pinned: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides
  }
}

async function completeCreation(service, noteId = 1) {
  const creation = service.create({ noteId })
  await Promise.resolve()
  const entry = [...service.registry.values()].find((item) => !item.ready)
  service.markReady(entry.webContentsId)
  const result = await creation
  return { entry, result }
}

beforeEach(() => {
  electronState.handlers.clear()
  electronState.instances.length = 0
  electronState.nextWebContentsId = 100
  electronState.failRegistration = null
  electronState.onWindowCreated = null
  vi.restoreAllMocks()
})

describe('sticky renderer recovery resource lifetime', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('invalidates an already running restore batch without clearing a new lifecycle batch', async () => {
    const repository = createRepository([
      persistedRecord({ id: 'old-1' }),
      persistedRecord({ id: 'old-2' })
    ])
    const { service } = createService(undefined, undefined, repository)
    service.initialize()
    const releases = []
    const open = vi
      .spyOn(service, 'openEntry')
      .mockImplementation(() => new Promise((resolve) => releases.push(resolve)))
    const oldBatch = service.restoreMissing()
    service.dispose()
    repository.records.clear()
    repository.records.set('new-1', persistedRecord({ id: 'new-1' }))
    service.initialize()
    const newBatch = service.restoreMissing()
    releases[0]()
    expect(await oldBatch).toBe(0)
    expect(open.mock.calls.map(([record]) => record.id)).toEqual(['old-1', 'new-1'])
    expect(service.restorePromise).toBe(newBatch)
    releases[1]()
    await newBatch
    expect(service.restorePromise).toBe(null)
    service.dispose()
  })

  it('does not accumulate recovery records or timers across crashed and deleted stickies', async () => {
    const repository = createRepository()
    const { service } = createService(undefined, undefined, repository)
    service.initialized = true
    const restore = vi.spyOn(service, 'restoreMissing')
    for (let cycle = 0; cycle < 100; cycle++) {
      const { entry } = await completeCreation(service)
      entry.window.webContentsListeners.get('render-process-gone')({}, { reason: 'crashed' })
      expect(service.rendererRecoveryAttempts.size).toBe(1)
      expect(service.rendererRecoveryTimers.size).toBe(1)
      expect(service.close(entry.id)).toBe(true)
      expect(service.rendererRecoveryAttempts.size).toBe(0)
      expect(service.rendererRecoveryTimers.size).toBe(0)
    }
    await vi.advanceTimersByTimeAsync(1000)
    expect(restore).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(repository.records.size).toBe(0)
    service.dispose()
  })

  it('retains the one-retry guard for a persisted sticky after its recovery timer finishes', async () => {
    const record = persistedRecord()
    const repository = createRepository([record])
    const { service } = createService(undefined, undefined, repository)
    service.initialized = true
    const restore = vi.spyOn(service, 'restoreMissing').mockResolvedValue(0)
    service.scheduleRendererRecovery(record.id)
    service.scheduleRendererRecovery(record.id)
    await vi.advanceTimersByTimeAsync(500)
    service.scheduleRendererRecovery(record.id)
    await vi.advanceTimersByTimeAsync(1000)
    expect(restore).toHaveBeenCalledOnce()
    expect(service.rendererRecoveryAttempts.size).toBe(1)
    expect(service.rendererRecoveryTimers.size).toBe(0)
    service.dispose()
    expect(repository.records.size).toBe(1)
    expect(service.rendererRecoveryAttempts.size).toBe(0)
  })

  it('preserves the retry guard when deleting the persisted record fails', () => {
    const record = persistedRecord()
    const repository = createRepository([record])
    const { service } = createService(undefined, undefined, repository)
    service.initialized = true
    service.scheduleRendererRecovery(record.id)
    repository.delete.mockImplementationOnce(() => {
      throw new Error('injected SQL failure')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(service.close(record.id)).toBe(false)
    expect(service.rendererRecoveryAttempts.size).toBe(1)
    expect(repository.records.size).toBe(1)
    expect(service.close(record.id)).toBe(true)
    expect(service.rendererRecoveryAttempts.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    service.dispose()
  })

  it('prunes a crashed sticky deleted by a source-note cascade without resetting other guards', () => {
    const removed = persistedRecord()
    const kept = persistedRecord({ id: 'sticky-other', noteId: 2 })
    const repository = createRepository([removed, kept])
    const { service } = createService(undefined, undefined, repository)
    service.initialized = true
    service.scheduleRendererRecovery(removed.id)
    service.scheduleRendererRecovery(kept.id)
    repository.records.delete(removed.id)
    service.discardByNoteId(removed.noteId)
    expect([...service.rendererRecoveryAttempts.keys()]).toEqual([kept.id])
    expect([...service.rendererRecoveryTimers.keys()]).toEqual([kept.id])
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['closeAll', 'discardAllRuntime', 'dispose'])(
    '%s cancels pending recovery and removes historical guards',
    async (method) => {
      const record = persistedRecord()
      const repository = createRepository([record])
      const { service } = createService(undefined, undefined, repository)
      service.initialized = true
      const restore = vi.spyOn(service, 'restoreMissing')
      service.scheduleRendererRecovery(record.id)
      service[method]()
      await vi.advanceTimersByTimeAsync(1000)
      expect(restore).not.toHaveBeenCalled()
      expect(service.rendererRecoveryAttempts.size).toBe(0)
      expect(service.rendererRecoveryTimers.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      service.dispose()
    }
  )

  it('does not recover a deleted sticky when its timer has fired but the continuation is pending', async () => {
    const record = persistedRecord()
    const repository = createRepository([record])
    const { service } = createService(undefined, undefined, repository)
    service.initialized = true
    const restore = vi.spyOn(service, 'restoreMissing')
    service.scheduleRendererRecovery(record.id)
    vi.advanceTimersByTime(500)
    service.close(record.id)
    await Promise.resolve()
    expect(restore).not.toHaveBeenCalled()
    expect(service.rendererRecoveryAttempts.size).toBe(0)
    service.dispose()
  })

  it('does not let an old timer continuation consume a new lifecycle recovery attempt', async () => {
    const record = persistedRecord()
    const repository = createRepository([record])
    const { service } = createService(undefined, undefined, repository)
    service.initialize()
    const restore = vi.spyOn(service, 'restoreMissing').mockResolvedValue(0)
    service.scheduleRendererRecovery(record.id)
    vi.advanceTimersByTime(500)
    service.dispose()
    service.initialize()
    service.scheduleRendererRecovery(record.id)
    await Promise.resolve()
    expect(restore).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(restore).toHaveBeenCalledOnce()
    service.dispose()
  })
})

describe('ElectronStickyService creation lifecycle', () => {
  it('reclaims only successful sticky registrations when initialization fails', () => {
    const foreign = () => true
    electronState.handlers.set('sticky:ready', foreign)
    electronState.failRegistration = 'sticky:ready'
    const { service } = createService()
    const stop = vi.spyOn(service.displayManager, 'stop')
    expect(() => service.initialize()).toThrow('handler already exists')
    expect(electronState.handlers.size).toBe(1)
    expect(electronState.handlers.get('sticky:ready')).toBe(foreign)
    expect(stop).toHaveBeenCalledOnce()
    service.dispose()
    expect(stop).toHaveBeenCalledOnce()
    expect(service.initialized).toBe(false)
  })

  it('reclaims a partial reminder window constructor without removing foreign handlers', () => {
    const foreign = () => true
    electronState.handlers.set('reminders:action', foreign)
    electronState.failRegistration = 'reminders:action'
    expect(
      () => new ReminderWindow({ ipcMain, getSettings: () => ({}), onAction: vi.fn() })
    ).toThrow('handler already exists')
    expect(electronState.handlers.size).toBe(1)
    expect(electronState.handlers.get('reminders:action')).toBe(foreign)
    expect(electronState.instances).toEqual([])
  })

  it('completes a previously admitted create from an independent ready IPC while clear is draining', async () => {
    const admission = createBusinessMutationAdmission(),
      repository = createRepository()
    const gated = { ...repository }
    for (const name of ['insert', 'update', 'delete', 'deleteAll']) {
      gated[name] = (...args) => admission.run(() => repository[name](...args))
    }
    const { service, mainWindow } = createService(undefined, undefined, gated, {
      runMutation: admission.run,
      bindMutationContinuation: admission.bindContinuation
    })
    service.initialize()
    const created = electronState.handlers.get('sticky:create')(
      { sender: mainWindow.webContents },
      { noteId: 1 }
    )
    const entry = [...service.registry.values()][0]
    const cleared = admission.clear(() => {
      repository.records.clear()
      service.discardAllRuntime()
    })
    expect(admission.snapshot().clearing).toBe(true)
    expect(repository.insert).not.toHaveBeenCalled()
    // A separate invocation deliberately has no create AsyncLocalStorage ancestry.
    electronState.handlers.get('sticky:ready')({ sender: { id: entry.webContentsId } })
    expect((await created).ok).toBe(true)
    await cleared
    expect(repository.insert).toHaveBeenCalledOnce()
    expect(repository.records.size).toBe(0)
    expect(service.registry.size).toBe(0)
    expect(entry.window.isDestroyed()).toBe(true)
    service.dispose()
  })

  it('persists a ready sticky and removes it only after an explicit close', async () => {
    const repository = createRepository()
    const { service } = createService(undefined, undefined, repository)
    service.initialized = true

    const { entry } = await completeCreation(service)

    expect(entry.id).toMatch(
      /^sticky-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(repository.insert).toHaveBeenCalledOnce()
    expect(repository.records.has(entry.id)).toBe(true)
    expect(service.close(entry.id)).toBe(true)
    expect(repository.delete).toHaveBeenCalledWith(entry.id)
    expect(repository.records.size).toBe(0)
  })

  it('preserves persisted records while disposing application windows', async () => {
    const repository = createRepository()
    const { service } = createService(undefined, undefined, repository)
    service.initialized = true
    const { entry } = await completeCreation(service)

    service.dispose()

    expect(entry.window.destroyed).toBe(true)
    expect(repository.delete).not.toHaveBeenCalled()
    expect(repository.deleteAll).not.toHaveBeenCalled()
    expect(repository.records.has(entry.id)).toBe(true)
  })

  it('restores a persisted sticky that has no active window', async () => {
    const repository = createRepository([persistedRecord()])
    const { service } = createService(undefined, undefined, repository)
    service.initialized = true

    const restoration = service.restoreMissing({ source: 'test' })
    await Promise.resolve()
    const [entry] = service.registry.values()
    service.markReady(entry.webContentsId)

    expect(await restoration).toBe(1)
    expect(service.list()).toHaveLength(1)
    expect(repository.insert).not.toHaveBeenCalled()
    service.dispose()
  })

  it('stops using a restore snapshot after close-all removes its records', async () => {
    const repository = createRepository([
      persistedRecord(),
      persistedRecord({ id: 'sticky-persisted-2', createdAt: 1_700_000_000_001 })
    ])
    const { service } = createService(undefined, undefined, repository)
    service.initialized = true

    const restoration = service.restoreMissing({ source: 'test-close-all-race' })
    await Promise.resolve()
    expect(service.registry.size).toBe(1)

    expect(service.closeAll()).toBe(true)

    expect(await restoration).toBe(0)
    expect(repository.records.size).toBe(0)
    expect(service.registry.size).toBe(0)
    expect(electronState.instances).toHaveLength(1)
  })

  it('keeps a sticky record when its window cannot be destroyed', async () => {
    const repository = createRepository()
    const { service } = createService(undefined, undefined, repository)
    service.initialized = true
    const { entry } = await completeCreation(service)
    const destroyWindow = entry.window.destroy.bind(entry.window)
    entry.window.destroy = vi.fn(() => {
      throw new Error('injected destroy failure')
    })

    expect(service.close(entry.id)).toBe(false)
    expect(repository.records.has(entry.id)).toBe(true)
    expect(service.registry.has(entry.id)).toBe(true)

    entry.window.destroy = destroyWindow
    service.dispose()
  })

  it('keeps all records when close-all cannot destroy every window', async () => {
    const repository = createRepository()
    const { service } = createService(undefined, undefined, repository)
    service.initialized = true
    const first = await completeCreation(service, 1)
    const second = await completeCreation(service, 2)
    const destroyWindow = second.entry.window.destroy.bind(second.entry.window)
    second.entry.window.destroy = vi.fn(() => {
      throw new Error('injected destroy failure')
    })

    expect(service.closeAll()).toBe(false)
    expect(first.entry.window.destroyed).toBe(true)
    expect(repository.deleteAll).not.toHaveBeenCalled()
    expect(repository.records.size).toBe(2)

    second.entry.window.destroy = destroyWindow
    service.dispose()
  })

  it('returns expected creation failures as business results instead of rejected IPC handlers', async () => {
    const { mainWindow, service } = createService()
    service.initialize()
    for (let index = 0; index < 10; index += 1) {
      service.registry.set(`existing-${index}`, {})
    }

    const response = await electronState.handlers.get('sticky:create')(
      { sender: mainWindow.webContents },
      { noteId: 1 }
    )

    expect(response).toEqual({
      ok: false,
      message: '最多同时展示 10 张便利贴，请先关闭部分便利贴'
    })
    service.registry.clear()
    service.dispose()
  })

  it('counts persisted records and initializing windows as one shared capacity', async () => {
    const repository = createRepository(
      Array.from({ length: 9 }, (_, index) =>
        persistedRecord({ id: `sticky-persisted-${index + 1}` })
      )
    )
    const { service } = createService(undefined, undefined, repository)
    service.initialized = true

    const firstCreation = service.create({ noteId: 1 })
    await Promise.resolve()
    await expect(service.create({ noteId: 1 })).rejects.toThrow('最多同时展示 10 张便利贴')

    const [initializingEntry] = service.registry.values()
    service.markReady(initializingEntry.webContentsId)
    await firstCreation

    expect(repository.records.size).toBe(10)
    expect(service.registry.size).toBe(1)
    service.dispose()
  })

  it('destroys and unregisters a window that never completes the ready handshake', async () => {
    vi.useFakeTimers()
    const { service } = createService()
    service.initialized = true

    const creation = service.create({ noteId: 1 })
    const rejection = expect(creation).rejects.toThrow('便利贴初始化失败')
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(5_000)

    await rejection
    expect(service.registry.size).toBe(0)
    expect(electronState.instances).toHaveLength(1)
    expect(electronState.instances[0].destroyed).toBe(true)
    vi.useRealTimers()
  })

  it('keeps an initializing window out of tray and show-all actions until ready', async () => {
    const { service } = createService()
    service.initialized = true

    const creation = service.create({ noteId: 1 })
    await Promise.resolve()
    const [entry] = service.registry.values()

    expect(service.list()).toEqual([])
    expect(service.showAll()).toBe(false)

    service.markReady(entry.webContentsId)
    await creation

    expect(service.list()).toHaveLength(1)
    expect(service.showAll()).toBe(true)
    service.dispose()
  })

  it('refuses creation when no display can fully avoid the main window', async () => {
    const { service } = createService({ x: 0, y: 0, width: 1920, height: 1040 })
    service.initialized = true

    await expect(service.create({ noteId: 1 })).rejects.toThrow('主窗口外没有足够空间展示便利贴')
    expect(electronState.instances).toHaveLength(0)
  })

  it('deletes one sticky through its sender-scoped IPC handler', async () => {
    const { service } = createService()
    service.initialize()
    const { entry } = await completeCreation(service)

    expect(
      electronState.handlers.get('sticky:close')({ sender: { id: entry.webContentsId } })
    ).toBe(true)
    expect(entry.window.destroyed).toBe(true)
    expect(service.registry.size).toBe(0)
    expect(service.byWebContentsId.size).toBe(0)
    service.dispose()
  })

  it('deletes all sticky windows and clears their registry mappings', async () => {
    const { service } = createService()
    service.initialized = true
    await completeCreation(service, 1)
    await completeCreation(service, 2)

    service.closeAll()

    expect(electronState.instances.every((instance) => instance.destroyed)).toBe(true)
    expect(service.registry.size).toBe(0)
    expect(service.byWebContentsId.size).toBe(0)
  })

  it('cleans up a sticky after an abnormal renderer exit', async () => {
    const { service } = createService()
    service.initialized = true
    service.onError = vi.fn()
    const { entry } = await completeCreation(service)

    entry.window.webContentsListeners.get('render-process-gone')({}, { reason: 'crashed' })

    expect(service.onError).toHaveBeenCalledWith('一张便利贴异常关闭')
    expect(entry.window.destroyed).toBe(true)
    expect(service.registry.size).toBe(0)
    expect(service.byWebContentsId.size).toBe(0)
  })

  it('initializes a new sticky from the persisted default appearance', async () => {
    const { service } = createService(
      { x: 1440, y: 25, width: 480, height: 930 },
      {
        fontSize: 23,
        backgroundColor: '#d4eaff',
        cornerRadius: 18,
        alwaysOnTop: true
      }
    )
    service.initialized = true

    const { entry } = await completeCreation(service)

    expect(entry.window.options).toMatchObject({
      transparent: true,
      roundedCorners: true,
      alwaysOnTop: true,
      backgroundColor: '#00000000'
    })
    expect(entry.window.alwaysOnTop).toBe(true)
    expect(entry.window.alwaysOnTopLevel).toBe('pop-up-menu')
    expect(service.serializeAppearance(entry)).toEqual({
      fontSize: 23,
      backgroundColor: '#D4EAFF',
      textColor: '#1F2328',
      cornerRadius: 18,
      pinned: true
    })
    service.dispose()
  })

  it('keeps the window, persisted record, and renderer pin state synchronized', async () => {
    const repository = createRepository()
    const { service } = createService(undefined, undefined, repository)
    service.initialized = true
    const { entry } = await completeCreation(service)

    expect(service.togglePinForSender(entry.webContentsId)).toEqual({ pinned: true })
    expect(entry.window.isAlwaysOnTop()).toBe(true)
    expect(entry.window.alwaysOnTopLevel).toBe('pop-up-menu')
    expect(repository.records.get(entry.id).alwaysOnTop).toBe(true)

    expect(service.togglePinForSender(entry.webContentsId)).toEqual({ pinned: false })
    expect(entry.window.isAlwaysOnTop()).toBe(false)
    expect(repository.records.get(entry.id).alwaysOnTop).toBe(false)
    service.dispose()
  })

  it('rolls the native pin state back when persistence fails', async () => {
    const repository = createRepository()
    const { service } = createService(undefined, undefined, repository)
    service.initialized = true
    const { entry } = await completeCreation(service)
    repository.update.mockReturnValueOnce(false)

    expect(() => service.togglePinForSender(entry.webContentsId)).toThrow('便利贴记录不存在')
    expect(entry.pinned).toBe(false)
    expect(entry.window.isAlwaysOnTop()).toBe(false)
    service.dispose()
  })

  it('saves only normalized text content and refreshes the sticky preview', async () => {
    const repository = createRepository()
    const saveContent = vi.fn(({ noteId, content }) => ({ id: noteId, content }))
    const onNoteChanged = vi.fn()
    const { service } = createService(undefined, undefined, repository, {
      saveContent,
      onNoteChanged
    })
    service.initialized = true
    const { entry } = await completeCreation(service)

    expect(service.updateContentForSender(entry.webContentsId, '修改后的正文\n第二行')).toEqual({
      content: '修改后的正文\n第二行',
      conflict: false
    })
    expect(saveContent).toHaveBeenCalledWith(
      expect.objectContaining({
        stickyId: entry.id,
        noteId: entry.noteId,
        content: '修改后的正文\n第二行',
        expectedContent: '测试便利贴正文'
      })
    )
    expect(entry.preview).toBe('修改后的正文')
    expect(onNoteChanged).toHaveBeenCalledWith({
      id: entry.noteId,
      content: '修改后的正文\n第二行'
    })
    expect(() => service.updateContentForSender(entry.webContentsId, ' \n ')).toThrow(
      '便签内容为空'
    )
    service.dispose()
  })

  it('synchronizes duplicate writable stickies and rejects an obsolete write', async () => {
    const repository = createRepository()
    let sourceContent = '测试便利贴正文'
    const saveContent = vi.fn(({ noteId, content, expectedContent }) => {
      if (expectedContent !== sourceContent) return { conflict: true, content: sourceContent }
      sourceContent = content
      return { conflict: false, note: { id: noteId, content } }
    })
    const logger = { warn: vi.fn() }
    const { service } = createService(undefined, undefined, repository, { saveContent, logger })
    service.initialized = true
    const first = (await completeCreation(service)).entry
    const second = (await completeCreation(service)).entry

    expect(service.updateContentForSender(first.webContentsId, '第一张保存的新正文')).toEqual({
      content: '第一张保存的新正文',
      conflict: false
    })
    expect(second.content).toBe('第一张保存的新正文')
    expect(second.window.webContents.send).toHaveBeenCalledWith('sticky:content-changed', {
      content: '第一张保存的新正文'
    })

    expect(
      service.updateContentForSender(second.webContentsId, {
        content: '第二张基于旧正文的修改',
        expectedContent: '测试便利贴正文'
      })
    ).toEqual({ content: '第一张保存的新正文', conflict: true })
    expect(sourceContent).toBe('第一张保存的新正文')
    expect(logger.warn).toHaveBeenCalledWith(
      'sticky.content-conflict',
      '便利贴正文写入因版本冲突被拒绝',
      expect.objectContaining({
        stickyId: second.id,
        noteId: second.noteId,
        expectedLength: '测试便利贴正文'.length,
        currentLength: '第一张保存的新正文'.length,
        submittedLength: '第二张基于旧正文的修改'.length,
        synchronizedOtherStickies: true,
        otherOpenStickyCount: 1
      })
    )
    service.dispose()
  })

  it('always creates a transparent window when the default corner radius is zero', async () => {
    const { service } = createService(
      { x: 1440, y: 25, width: 480, height: 930 },
      {
        fontSize: 16,
        backgroundColor: '#fff2a8',
        cornerRadius: 0,
        alwaysOnTop: false
      }
    )
    service.initialized = true

    const { entry } = await completeCreation(service)

    expect(entry.window.options).toMatchObject({
      transparent: true,
      roundedCorners: false,
      backgroundColor: '#00000000'
    })
    service.dispose()
  })
})

describe('sticky shutdown stops initialization before business drain', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each([false, true])(
    'cancels a window stopped by its construction callback and retains failed cleanup: %s',
    async (cleanupFails) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const load = vi.spyOn(BrowserWindow.prototype, 'loadFile')
      const show = vi.spyOn(BrowserWindow.prototype, 'showInactive')
      const repository = createRepository()
      const { service, mainWindow } = createService(undefined, undefined, repository)
      service.initialize()
      let entry, report
      electronState.onWindowCreated = (window) => {
        const destroy = window.destroy.bind(window)
        vi.spyOn(window, 'destroy').mockImplementationOnce(() => {
          entry = [...service.registry.values()][0]
          if (cleanupFails) throw new Error('constructor-stop cleanup failure')
          destroy()
        })
        expect(service.registry.size).toBe(0)
        report = service.stopInitializations()
      }
      const response = await electronState.handlers.get('sticky:create')(
        { sender: mainWindow.webContents },
        { noteId: 1 }
      )
      expect(report.cancelled).toEqual([])
      expect(report.pendingCommit).toEqual([])
      expect(report.cleanupErrors).toEqual([])
      expect(response).toEqual({
        ok: false,
        message: cleanupFails
          ? '便利贴初始化已取消；窗口清理失败，请正常退出应用以重试释放'
          : '便利贴初始化已取消',
        ...(cleanupFails ? { cleanupIncomplete: true } : {})
      })
      expect(entry.initialization.state).toBe('cancelled')
      expect(entry.initialization.error.committed).toBe(false)
      expect(entry.initialization.continueReady).toBe(null)
      expect(entry.readyTimer).toBe(null)
      expect(entry.completeReady()).toBe(false)
      expect(service.completeReady(entry)).toBe(false)
      expect(load).not.toHaveBeenCalled()
      expect(show).not.toHaveBeenCalled()
      expect(repository.insert).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      expect(entry.window.isDestroyed()).toBe(!cleanupFails)
      if (cleanupFails) {
        expect(service.registry.get(entry.id)).toBe(entry)
        expect(service.byWebContentsId.get(entry.webContentsId)).toBe(entry.id)
        expect(service.markReady(entry.webContentsId)).toBe(false)
      } else {
        expect(service.registry.size).toBe(0)
        expect(service.byWebContentsId.size).toBe(0)
      }
      service.dispose()
      expect(entry.window.isDestroyed()).toBe(true)
      expect(service.registry.size).toBe(0)
      expect(service.byWebContentsId.size).toBe(0)
    }
  )

  it('cancels pending creation synchronously and seals late ready, create and restore', async () => {
    const loading = deferred()
    vi.spyOn(BrowserWindow.prototype, 'loadFile').mockReturnValueOnce(loading.promise)
    const repository = createRepository()
    const { service, mainWindow } = createService(undefined, undefined, repository)
    service.initialize()
    const response = electronState.handlers.get('sticky:create')(
      { sender: mainWindow.webContents },
      { noteId: 1 }
    )
    const [entry] = service.registry.values()
    const lateReady = entry.completeReady
    const show = vi.spyOn(entry.window, 'showInactive')
    expect(service.stopInitializations()).toEqual({
      stopped: true,
      alreadyStopped: false,
      cancelled: [entry.id],
      preserved: [],
      pendingCommit: [],
      cleanupErrors: []
    })
    expect(entry.initialization.state).toBe('cancelled')
    expect(entry.window.isDestroyed()).toBe(true)
    expect(service.registry.size).toBe(0)
    expect(service.byWebContentsId.size).toBe(0)
    expect(lateReady()).toBe(false)
    expect(await response).toEqual({ ok: false, message: '便利贴初始化已取消' })
    await expect(service.create({ noteId: 1 })).rejects.toThrow('便利贴初始化已停止')
    expect(await service.restoreMissing()).toBe(0)
    expect(service.getRecoverableCount()).toBe(0)
    expect(electronState.instances).toHaveLength(1)
    expect(repository.insert).not.toHaveBeenCalled()
    expect(show).not.toHaveBeenCalled()
    loading.resolve()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(lateReady()).toBe(false)
    expect(service.stopInitializations()).toEqual({
      stopped: true,
      alreadyStopped: true,
      cancelled: [],
      preserved: [],
      pendingCommit: [],
      cleanupErrors: []
    })
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['continuation-binding', 'registry-notification'])(
    'does not continue setup after stop reenters %s',
    async (phase) => {
      const repository = createRepository()
      const load = vi.spyOn(BrowserWindow.prototype, 'loadFile')
      const show = vi.spyOn(BrowserWindow.prototype, 'showInactive')
      let entry
      const stop = () => {
        if (service.initializationsStopped) return
        entry = [...service.registry.values()][0]
        service.stopInitializations()
      }
      const { service } = createService(undefined, undefined, repository, {
        ...(phase === 'continuation-binding'
          ? {
              bindMutationContinuation(operation) {
                stop()
                return operation
              }
            }
          : { onRegistryChanged: stop })
      })
      service.initialize()
      const outcome = service.create({ noteId: 1 }).catch((error) => error)
      expect(await outcome).toMatchObject({ message: '便利贴初始化已取消', committed: false })
      expect(entry.initialization.continueReady).toBe(null)
      expect(entry.completeReady()).toBe(false)
      expect(entry.readyTimer).toBe(null)
      expect(entry.window.isDestroyed()).toBe(true)
      expect(service.registry.size).toBe(0)
      expect(service.byWebContentsId.size).toBe(0)
      expect(load).not.toHaveBeenCalled()
      expect(show).not.toHaveBeenCalled()
      expect(repository.insert).not.toHaveBeenCalled()
      service.dispose()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('revokes all ready continuations before a cleanup callback can reenter', async () => {
    const repository = createRepository()
    const { service } = createService(undefined, undefined, repository)
    service.initialize()
    const first = service.create({ noteId: 1 }).catch((error) => error)
    const second = service.create({ noteId: 2 }).catch((error) => error)
    const entries = [...service.registry.values()]
    let reentered
    const destroy = entries[0].window.destroy.bind(entries[0].window)
    vi.spyOn(entries[0].window, 'destroy').mockImplementationOnce(() => {
      expect(entries[1].initialization.state).toBe('cancelling')
      expect(entries[1].completeReady()).toBe(false)
      reentered = service.create({ noteId: 3 }).catch((error) => error)
      expect(service.stopInitializations().alreadyStopped).toBe(true)
      destroy()
    })
    const result = service.stopInitializations()
    expect(result.cancelled).toEqual(entries.map((entry) => entry.id))
    expect((await first).message).toBe('便利贴初始化已取消')
    expect((await second).message).toBe('便利贴初始化已取消')
    expect((await reentered).message).toBe('便利贴初始化已停止')
    expect(electronState.instances).toHaveLength(2)
    expect(repository.insert).not.toHaveBeenCalled()
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('invalidates an admitted multi-entry restore batch before it can open its next record', async () => {
    const saved = [persistedRecord(), persistedRecord({ id: 'sticky-persisted-2', noteId: 2 })]
    const repository = createRepository(saved)
    const admission = createBusinessMutationAdmission()
    const { service } = createService(undefined, undefined, repository, {
      runMutation: admission.run,
      bindMutationContinuation: admission.bindContinuation
    })
    service.initialize()
    const restoration = admission.run(() => service.restoreMissing({ source: 'shutdown-batch' }))
    const [entry] = service.registry.values()
    admission.preventNewMutations()
    const result = service.stopInitializations()
    expect(result.cancelled).toEqual([entry.id])
    expect(entry.initialization.error.committed).toBe(true)
    expect(await restoration).toBe(0)
    await admission.drain()
    expect(admission.snapshot().pending).toBe(0)
    expect(electronState.instances).toHaveLength(1)
    expect([...repository.records.values()]).toEqual(saved)
    expect(repository.insert).not.toHaveBeenCalled()
    expect(repository.update).not.toHaveBeenCalled()
    expect(repository.delete).not.toHaveBeenCalled()
    expect(repository.deleteAll).not.toHaveBeenCalled()
    admission.runCleanup(() => service.dispose())
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['timer', 'queued-continuation'])(
    'stops renderer recovery at its %s boundary',
    async (boundary) => {
      const repository = createRepository()
      const { service } = createService(undefined, undefined, repository)
      service.initialize()
      const { entry } = await completeCreation(service)
      entry.window.webContentsListeners.get('render-process-gone')({}, { reason: 'crashed' })
      expect(service.rendererRecoveryTimers.size).toBe(1)
      if (boundary === 'queued-continuation') vi.advanceTimersByTime(500)
      service.stopInitializations()
      await vi.advanceTimersByTimeAsync(500)
      expect(service.rendererRecoveryTimers.size).toBe(0)
      expect(service.rendererRecoveryAttempts.size).toBe(0)
      expect(electronState.instances).toHaveLength(1)
      expect(service.registry.size).toBe(0)
      expect(repository.records.has(entry.id)).toBe(true)
      expect(await service.restoreMissing({ source: 'after-stop' })).toBe(0)
      service.dispose()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('preserves completed windows and saves their final moved bounds only during later disposal', async () => {
    const repository = createRepository()
    const { service } = createService(undefined, undefined, repository)
    service.initialize()
    const { entry } = await completeCreation(service)
    repository.update.mockClear()
    const displayStop = vi.spyOn(service.displayManager, 'stop')
    entry.window.options.x = 200
    entry.window.listeners.get('move')()
    expect(entry.boundsPersistTimer).not.toBe(null)
    const report = service.stopInitializations()
    expect(report.preserved).toEqual([entry.id])
    expect(report.cancelled).toEqual([])
    expect(entry.boundsPersistTimer).toBe(null)
    expect(service.initialized).toBe(true)
    expect(service.disposing).toBe(false)
    expect(service.registry.get(entry.id)).toBe(entry)
    expect(entry.window.isVisible()).toBe(true)
    expect(entry.window.isDestroyed()).toBe(false)
    expect(displayStop).not.toHaveBeenCalled()
    expect(electronState.handlers.has('sticky:ready')).toBe(true)
    entry.window.options.x = 320
    entry.window.options.y = 140
    entry.window.listeners.get('move')()
    await vi.advanceTimersByTimeAsync(500)
    expect(repository.update).not.toHaveBeenCalled()
    expect(entry.boundsPersistTimer).toBe(null)
    service.dispose()
    expect(repository.update).toHaveBeenCalledExactlyOnceWith(
      entry.id,
      expect.objectContaining({ boundsX: 320, boundsY: 140 })
    )
    expect(entry.window.isDestroyed()).toBe(true)
    expect(repository.records.has(entry.id)).toBe(true)
    expect(repository.delete).not.toHaveBeenCalled()
    expect(repository.deleteAll).not.toHaveBeenCalled()
    expect(displayStop).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports real cancellation cleanup errors and retains their ownership until dispose retries', async () => {
    const repository = createRepository()
    const { service, mainWindow } = createService(undefined, undefined, repository)
    service.initialize()
    const response = electronState.handlers.get('sticky:create')(
      { sender: mainWindow.webContents },
      { noteId: 1 }
    )
    const [entry] = service.registry.values()
    const failure = new Error('injected shutdown cancellation cleanup failure')
    vi.spyOn(entry.window, 'destroy').mockImplementationOnce(() => {
      throw failure
    })
    const report = service.stopInitializations()
    expect(report.cancelled).toEqual([entry.id])
    expect(report.cleanupErrors).toEqual([{ stickyId: entry.id, error: failure }])
    expect(service.registry.get(entry.id)).toBe(entry)
    expect(service.byWebContentsId.get(entry.webContentsId)).toBe(entry.id)
    expect(entry.window.isDestroyed()).toBe(false)
    expect(entry.completeReady()).toBe(false)
    expect(await response).toEqual({
      ok: false,
      message: '便利贴初始化已取消；窗口清理失败，请正常退出应用以重试释放',
      cleanupIncomplete: true
    })
    expect(() => service.dispose()).not.toThrow()
    expect(entry.window.isDestroyed()).toBe(true)
    expect(service.registry.size).toBe(0)
    expect(repository.insert).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['insert-before-save', 'insert-after-save', 'bounds-update', 'show'])(
    'waits for actual persistence when stop reenters synchronous %s',
    async (phase) => {
      const repository = createRepository()
      const { service, mainWindow } = createService(undefined, undefined, repository)
      service.initialize()
      const response = electronState.handlers.get('sticky:create')(
        { sender: mainWindow.webContents },
        { noteId: 1 }
      )
      const [entry] = service.registry.values()
      let report
      const stop = () => {
        report = service.stopInitializations()
        expect(report.pendingCommit).toEqual([entry.id])
        expect(report.cancelled).toEqual([])
        expect(entry.initialization.state).toBe('cancelling')
        expect(entry.completeReady()).toBe(false)
        expect(entry.window.isDestroyed()).toBe(false)
      }
      if (phase.startsWith('insert')) {
        const insert = repository.insert.getMockImplementation()
        repository.insert.mockImplementationOnce((record) => {
          if (phase === 'insert-before-save') stop()
          const result = insert(record)
          if (phase === 'insert-after-save') stop()
          return result
        })
      } else if (phase === 'bounds-update') {
        const update = repository.update.getMockImplementation()
        repository.update.mockImplementationOnce((...args) => {
          const result = update(...args)
          stop()
          return result
        })
      } else {
        const show = entry.window.showInactive.bind(entry.window)
        vi.spyOn(entry.window, 'showInactive').mockImplementationOnce(() => {
          show()
          stop()
        })
      }
      expect(service.markReady(entry.webContentsId)).toBe(false)
      expect(await response).toEqual({
        ok: false,
        message: '便利贴初始化已取消，已保存记录保留供下次恢复',
        committed: true,
        stickyId: entry.id
      })
      expect(entry.initialization.state).toBe('cancelled')
      expect(entry.ready).toBe(false)
      expect(entry.window.isDestroyed()).toBe(true)
      expect(service.registry.size).toBe(0)
      expect(repository.records.has(entry.id)).toBe(true)
      expect(repository.insert).toHaveBeenCalledOnce()
      expect(repository.delete).not.toHaveBeenCalled()
      expect(repository.deleteAll).not.toHaveBeenCalled()
      expect(report.pendingCommit).toEqual([entry.id])
      expect(report.cancelled).toEqual([])
      expect(report.cleanupErrors).toEqual([])
      service.dispose()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('keeps deferred committing cleanup failure in the creation result and logger', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const repository = createRepository()
    const logger = { error: vi.fn() }
    const { service, mainWindow } = createService(undefined, undefined, repository, { logger })
    service.initialize()
    const response = electronState.handlers.get('sticky:create')(
      { sender: mainWindow.webContents },
      { noteId: 1 }
    )
    const [entry] = service.registry.values()
    const failure = new Error('injected deferred cleanup failure')
    vi.spyOn(entry.window, 'destroy').mockImplementationOnce(() => {
      throw failure
    })
    let report
    const insert = repository.insert.getMockImplementation()
    repository.insert.mockImplementationOnce((record) => {
      report = service.stopInitializations()
      return insert(record)
    })
    expect(service.markReady(entry.webContentsId)).toBe(false)
    expect(await response).toEqual({
      ok: false,
      message:
        '便利贴初始化已取消，已保存记录保留供下次恢复；窗口清理失败，请正常退出应用以重试释放',
      committed: true,
      stickyId: entry.id,
      cleanupIncomplete: true
    })
    expect(logger.error).toHaveBeenCalledExactlyOnceWith('sticky.stop-initialization', failure, {
      stickyId: entry.id
    })
    expect(report.pendingCommit).toEqual([entry.id])
    expect(report.cleanupErrors).toEqual([])
    expect(service.registry.get(entry.id)).toBe(entry)
    expect(entry.window.isDestroyed()).toBe(false)
    service.dispose()
    expect(entry.window.isDestroyed()).toBe(true)
    expect(repository.records.has(entry.id)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['insert', 'verify', 'show'])(
    'retains the original cause when a stopped synchronous %s operation subsequently fails',
    async (phase) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const repository = createRepository(phase === 'verify' ? [persistedRecord()] : [])
      const logger = { error: vi.fn() }
      const { service } = createService(undefined, undefined, repository, { logger })
      service.initialize()
      const outcome =
        phase === 'verify'
          ? service.restoreMissing({ source: 'stop-during-verify' })
          : service.create({ noteId: 1 }).catch((error) => error)
      const [entry] = service.registry.values()
      const cause = new Error(`${phase} failed after stop`)
      const failAfterStop = () => {
        service.stopInitializations()
        throw cause
      }
      if (phase === 'insert') repository.insert.mockImplementationOnce(failAfterStop)
      else if (phase === 'verify') repository.exists.mockImplementationOnce(failAfterStop)
      else vi.spyOn(entry.window, 'showInactive').mockImplementationOnce(failAfterStop)
      expect(service.markReady(entry.webContentsId)).toBe(false)
      const result = await outcome
      const error = phase === 'verify' ? entry.initialization.error : result
      if (phase === 'verify') expect(result).toBe(0)
      expect(error).toMatchObject({
        message:
          phase === 'insert'
            ? '便利贴初始化已取消'
            : '便利贴初始化已取消，已保存记录保留供下次恢复',
        committed: phase !== 'insert'
      })
      expect(error.cause).toBe(cause)
      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        'sticky.stop-initialization-operation',
        cause,
        { stickyId: entry.id, phase }
      )
      expect(repository.records.size).toBe(phase === 'insert' ? 0 : 1)
      expect(entry.initialization.state).toBe('cancelled')
      expect(entry.window.isDestroyed()).toBe(true)
      expect(repository.delete).not.toHaveBeenCalled()
      expect(repository.deleteAll).not.toHaveBeenCalled()
      service.dispose()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('keeps stopped operation cancellation and its cause even when diagnostic sinks throw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('console failed')
    })
    const logger = {
      error: vi.fn(() => {
        throw new Error('logger failed')
      })
    }
    const repository = createRepository()
    const { service } = createService(undefined, undefined, repository, { logger })
    service.initialize()
    const outcome = service.create({ noteId: 1 }).catch((error) => error)
    const [entry] = service.registry.values()
    const cause = new Error('insert never committed')
    repository.insert.mockImplementationOnce(() => {
      service.stopInitializations()
      throw cause
    })
    expect(service.markReady(entry.webContentsId)).toBe(false)
    expect(await outcome).toMatchObject({
      message: '便利贴初始化已取消',
      committed: false,
      cause
    })
    expect(entry.initialization.state).toBe('cancelled')
    expect(entry.window.isDestroyed()).toBe(true)
    expect(repository.records.size).toBe(0)
    expect(service.registry.size).toBe(0)
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('sticky initialization has one bounded business owner', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each(['file', 'url'])(
    'completes from ready while %s load remains pending and observes late load rejection',
    async (kind) => {
      const loading = deferred()
      vi.spyOn(
        BrowserWindow.prototype,
        kind === 'file' ? 'loadFile' : 'loadURL'
      ).mockReturnValueOnce(loading.promise)
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const repository = createRepository()
      const { service } = createService(undefined, undefined, repository, {
        rendererUrl: kind === 'url' ? 'http://127.0.0.1/sticky.html' : null
      })
      service.initialize()
      const creation = service.create({ noteId: 1 })
      const [entry] = service.registry.values()
      const show = vi.spyOn(entry.window, 'showInactive')
      expect(service.markReady(entry.webContentsId)).toBe(true)
      expect(await creation).toMatchObject({ id: entry.id, count: 1 })
      expect(entry.initialization.state).toBe('succeeded')
      expect(entry.window.isVisible()).toBe(true)
      expect(entry.readyTimer).toBe(null)
      expect(repository.records.size).toBe(1)
      expect(service.markReady(entry.webContentsId)).toBe(true)
      expect(entry.completeReady()).toBe(false)
      expect(repository.insert).toHaveBeenCalledOnce()
      expect(show).toHaveBeenCalledOnce()

      loading.reject(new Error('late load failure after business ready'))
      await Promise.resolve()
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('页面加载失败'),
        expect.objectContaining({ message: 'late load failure after business ready' })
      )
      expect(entry.initialization.state).toBe('succeeded')
      expect(entry.window.isDestroyed()).toBe(false)
      expect(repository.records.has(entry.id)).toBe(true)
      service.dispose()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['file', 'url'])(
    'expires %s loading without waiting for load and releases admitted creation and drain',
    async (kind) => {
      const loading = deferred()
      vi.spyOn(
        BrowserWindow.prototype,
        kind === 'file' ? 'loadFile' : 'loadURL'
      ).mockReturnValueOnce(loading.promise)
      const admission = createBusinessMutationAdmission()
      const repository = createRepository()
      const { service } = createService(undefined, undefined, repository, {
        rendererUrl: kind === 'url' ? 'http://127.0.0.1/sticky.html' : null,
        runMutation: admission.run,
        bindMutationContinuation: admission.bindContinuation
      })
      service.initialize()
      const creation = admission.run(() => service.create({ noteId: 1 }))
      const outcome = creation.catch((error) => error)
      const [entry] = service.registry.values()
      const lateReady = entry.completeReady
      const show = vi.spyOn(entry.window, 'showInactive')
      admission.preventNewMutations()
      const draining = admission.drain()
      await vi.advanceTimersByTimeAsync(5_000)
      expect((await outcome).message).toContain('便利贴初始化失败')
      await draining
      expect(admission.snapshot().pending).toBe(0)
      expect(service.registry.size).toBe(0)
      expect(service.byWebContentsId.size).toBe(0)
      expect(entry.window.isDestroyed()).toBe(true)
      expect(entry.initialization.state).toBe('failed')
      expect(entry.readyTimer).toBe(null)
      expect(lateReady()).toBe(false)
      expect(service.completeReady(entry)).toBe(false)
      expect(repository.insert).not.toHaveBeenCalled()
      expect(show).not.toHaveBeenCalled()
      loading.resolve()
      await Promise.resolve()
      expect(service.registry.size).toBe(0)
      service.dispose()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('rejects ready past the absolute deadline even before the timer callback runs', async () => {
    const loading = deferred()
    vi.spyOn(BrowserWindow.prototype, 'loadFile').mockReturnValueOnce(loading.promise)
    const repository = createRepository()
    const { service } = createService(undefined, undefined, repository)
    service.initialize()
    const outcome = service.create({ noteId: 1 }).catch((error) => error)
    const [entry] = service.registry.values()
    vi.setSystemTime(entry.initialization.deadline)
    expect(service.markReady(entry.webContentsId)).toBe(false)
    expect((await outcome).message).toContain('便利贴初始化失败')
    expect(repository.insert).not.toHaveBeenCalled()
    expect(entry.window.isVisible()).toBe(false)
    expect(entry.window.isDestroyed()).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    loading.resolve()
    service.dispose()
  })

  it.each(['close', 'closeAll', 'discardAllRuntime', 'dispose'])(
    '%s ends pending initialization immediately and rejects queued ready callbacks',
    async (method) => {
      const loading = deferred()
      vi.spyOn(BrowserWindow.prototype, 'loadFile').mockReturnValueOnce(loading.promise)
      const repository = createRepository()
      const { service } = createService(undefined, undefined, repository)
      service.initialize()
      const outcome = service.create({ noteId: 1 }).catch((error) => error)
      const [entry] = service.registry.values()
      const lateReady = entry.completeReady
      const show = vi.spyOn(entry.window, 'showInactive')
      if (method === 'close') expect(service.close(entry.id)).toBe(true)
      else service[method]()
      expect((await outcome).message).toContain('便利贴初始化已取消')
      expect(entry.initialization.state).toBe('cancelled')
      expect(lateReady()).toBe(false)
      expect(repository.insert).not.toHaveBeenCalled()
      expect(show).not.toHaveBeenCalled()
      expect(entry.window.isDestroyed()).toBe(true)
      expect(service.registry.size).toBe(0)
      expect(service.byWebContentsId.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      loading.resolve()
      service.dispose()
    }
  )

  it('a native close settles creation while its browser load remains pending', async () => {
    const loading = deferred()
    vi.spyOn(BrowserWindow.prototype, 'loadFile').mockReturnValueOnce(loading.promise)
    const { service } = createService()
    service.initialize()
    const outcome = service.create({ noteId: 1 }).catch((error) => error)
    const [entry] = service.registry.values()
    entry.window.destroy()
    expect((await outcome).message).toContain('便利贴初始化已取消')
    expect(entry.completeReady()).toBe(false)
    expect(service.registry.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    loading.resolve()
    service.dispose()
  })

  it.each([false, true])(
    'owns an initializing close request even when another listener prevented it: %s',
    async (prevented) => {
      const loading = deferred()
      vi.spyOn(BrowserWindow.prototype, 'loadFile').mockReturnValueOnce(loading.promise)
      const repository = createRepository()
      const { service } = createService(undefined, undefined, repository)
      service.initialize()
      let observer
      const outcome = service.create({ noteId: 1 }).catch((error) => {
        observer = {
          destroyed: entry.window.isDestroyed(),
          registered: service.registry.has(entry.id)
        }
        return error
      })
      const [entry] = service.registry.values()
      const destroy = vi.spyOn(entry.window, 'destroy')
      const event = requestWindowClose(entry.window, { prevented })
      expect(event.defaultPrevented).toBe(true)
      expect(entry.initialization.state).toBe('cancelling')
      expect(entry.initialization.continueReady).toBe(null)
      expect(entry.completeReady()).toBe(false)
      expect(destroy).not.toHaveBeenCalled()
      expect(entry.window.isDestroyed()).toBe(false)
      expect((await outcome).message).toBe('便利贴初始化已取消')
      expect(observer).toEqual({ destroyed: true, registered: false })
      expect(entry.initialization.state).toBe('cancelled')
      expect(destroy).toHaveBeenCalledOnce()
      expect(repository.insert).not.toHaveBeenCalled()
      expect(entry.readyTimer).toBe(null)
      loading.resolve()
      service.dispose()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('revokes ready during close dispatch before a later listener can synchronously commit', async () => {
    const loading = deferred()
    vi.spyOn(BrowserWindow.prototype, 'loadFile').mockReturnValueOnce(loading.promise)
    const repository = createRepository()
    const { service } = createService(undefined, undefined, repository)
    service.initialize()
    const outcome = service.create({ noteId: 1 }).catch((error) => error)
    const [entry] = service.registry.values()
    const show = vi.spyOn(entry.window, 'showInactive')
    requestWindowClose(entry.window, {
      afterService() {
        expect(entry.initialization.state).toBe('cancelling')
        expect(service.markReady(entry.webContentsId)).toBe(false)
        expect(service.completeReady(entry)).toBe(false)
        expect(repository.insert).not.toHaveBeenCalled()
        expect(show).not.toHaveBeenCalled()
      }
    })
    expect((await outcome).message).toBe('便利贴初始化已取消')
    expect(entry.initialization.state).toBe('cancelled')
    expect(entry.window.isDestroyed()).toBe(true)
    expect(repository.records.size).toBe(0)
    loading.resolve()
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps close cancellation when browser load rejects before the delayed closed event', async () => {
    const loading = deferred()
    vi.spyOn(BrowserWindow.prototype, 'loadFile').mockReturnValueOnce(loading.promise)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const repository = createRepository()
    const { service } = createService(undefined, undefined, repository)
    service.initialize()
    const order = []
    const outcome = service.create({ noteId: 1 }).catch((error) => {
      order.push('creation-observed')
      return error
    })
    const [entry] = service.registry.values()
    const show = vi.spyOn(entry.window, 'showInactive')
    const closed = entry.window.listeners.get('closed')
    vi.spyOn(entry.window, 'destroy').mockImplementationOnce(() => {
      entry.window.destroyed = true
      entry.window.visible = false
      order.push('load-rejected')
      loading.reject(
        Object.assign(new Error('ERR_FAILED during native close'), { code: 'ERR_FAILED' })
      )
      queueMicrotask(() => {
        order.push('closed')
        closed()
      })
    })
    order.push('close')
    requestWindowClose(entry.window)
    expect((await outcome).message).toBe('便利贴初始化已取消')
    expect(order.indexOf('close')).toBeLessThan(order.indexOf('load-rejected'))
    expect(order.indexOf('load-rejected')).toBeLessThan(order.indexOf('closed'))
    expect(entry.initialization.state).toBe('cancelled')
    expect(entry.initialization.error.cause).toBe(undefined)
    expect(entry.window.isDestroyed()).toBe(true)
    expect(service.registry.size).toBe(0)
    expect(service.byWebContentsId.size).toBe(0)
    expect(entry.completeReady()).toBe(false)
    expect(repository.insert).not.toHaveBeenCalled()
    expect(show).not.toHaveBeenCalled()
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns incomplete close cleanup while retaining the failed window for shutdown retry', async () => {
    const loading = deferred()
    vi.spyOn(BrowserWindow.prototype, 'loadFile').mockReturnValueOnce(loading.promise)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const repository = createRepository()
    const { service } = createService(undefined, undefined, repository)
    service.initialize()
    const outcome = service.create({ noteId: 1 }).catch((error) => error)
    const [entry] = service.registry.values()
    vi.spyOn(entry.window, 'destroy').mockImplementationOnce(() => {
      throw new Error('injected close cleanup failure')
    })
    requestWindowClose(entry.window)
    const error = await outcome
    expect(entry.initialization.state).toBe('cancelled')
    expect(error.cleanupError).toBe('injected close cleanup failure')
    expect(error.message).toContain('正常退出应用以重试释放')
    expect(entry.window.isDestroyed()).toBe(false)
    expect(service.registry.get(entry.id)).toBe(entry)
    expect(service.byWebContentsId.get(entry.webContentsId)).toBe(entry.id)
    expect(entry.completeReady()).toBe(false)
    expect(repository.insert).not.toHaveBeenCalled()
    expect(entry.readyTimer).toBe(null)
    expect(() => service.dispose()).not.toThrow()
    expect(entry.window.isDestroyed()).toBe(true)
    expect(service.registry.size).toBe(0)
    loading.resolve()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves an existing record when its unfinished restoration receives a close request', async () => {
    const loading = deferred()
    vi.spyOn(BrowserWindow.prototype, 'loadFile').mockReturnValueOnce(loading.promise)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const saved = persistedRecord()
    const repository = createRepository([saved])
    const { service } = createService(undefined, undefined, repository)
    service.initialize()
    const restoration = service.restoreMissing({ source: 'pending-window-close' })
    const [entry] = service.registry.values()
    requestWindowClose(entry.window)
    expect(await restoration).toBe(0)
    expect(entry.initialization.state).toBe('cancelled')
    expect(entry.initialization.error.committed).toBe(true)
    expect(entry.initialization.error.message).toContain('已保存记录保留供下次恢复')
    expect(repository.records.get(saved.id)).toEqual(saved)
    expect(repository.insert).not.toHaveBeenCalled()
    expect(repository.delete).not.toHaveBeenCalled()
    expect(repository.deleteAll).not.toHaveBeenCalled()
    expect(entry.window.isDestroyed()).toBe(true)
    loading.resolve()
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['insert', 'show'])(
    'cancels a close reentered during committed %s work without rolling its record back',
    async (phase) => {
      const repository = createRepository()
      const { service, mainWindow } = createService(undefined, undefined, repository)
      service.initialize()
      const response = electronState.handlers.get('sticky:create')(
        { sender: mainWindow.webContents },
        { noteId: 1 }
      )
      const [entry] = service.registry.values()
      const originalShow = entry.window.showInactive.bind(entry.window)
      const show = vi.spyOn(entry.window, 'showInactive')
      const closeDuringCommit = () => {
        expect(repository.records.has(entry.id)).toBe(true)
        expect(entry.ready).toBe(false)
        expect(entry.initialization.state).toBe('committing')
        requestWindowClose(entry.window)
        expect(entry.initialization.state).toBe('cancelling')
        expect(entry.completeReady()).toBe(false)
      }
      if (phase === 'insert') {
        const insert = repository.insert.getMockImplementation()
        repository.insert.mockImplementationOnce((record) => {
          const result = insert(record)
          closeDuringCommit()
          return result
        })
      } else {
        show.mockImplementationOnce(() => {
          originalShow()
          closeDuringCommit()
        })
      }
      expect(service.markReady(entry.webContentsId)).toBe(false)
      expect(await response).toEqual({
        ok: false,
        message: '便利贴初始化已取消，已保存记录保留供下次恢复',
        committed: true,
        stickyId: entry.id
      })
      expect(entry.initialization.state).toBe('cancelled')
      expect(entry.ready).toBe(false)
      expect(entry.window.isDestroyed()).toBe(true)
      expect(service.registry.size).toBe(0)
      expect(repository.records.size).toBe(1)
      expect(repository.records.get(entry.id)).toMatchObject({
        id: entry.id,
        noteId: 1,
        content: '测试便利贴正文'
      })
      expect(repository.insert).toHaveBeenCalledOnce()
      expect(repository.delete).not.toHaveBeenCalled()
      expect(repository.deleteAll).not.toHaveBeenCalled()
      if (phase === 'insert') expect(show).not.toHaveBeenCalled()
      else expect(show).toHaveBeenCalledOnce()
      const restoration = service.restoreMissing({ source: 'cancelled-during-commit' })
      const [restored] = service.registry.values()
      expect(restored.id).toBe(entry.id)
      service.markReady(restored.webContentsId)
      expect(await restoration).toBe(1)
      expect(restored.window.isVisible()).toBe(true)
      expect(repository.insert).toHaveBeenCalledOnce()
      service.dispose()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('keeps completed windows on native close semantics, including a prevented close', async () => {
    const repository = createRepository()
    const { service } = createService(undefined, undefined, repository)
    service.initialize()
    const { entry } = await completeCreation(service)
    expect(requestWindowClose(entry.window, { prevented: true }).defaultPrevented).toBe(true)
    expect(entry.window.isDestroyed()).toBe(false)
    expect(entry.initialization.state).toBe('succeeded')
    expect(requestWindowClose(entry.window).defaultPrevented).toBe(false)
    expect(entry.window.isDestroyed()).toBe(true)
    expect(entry.initialization.state).toBe('succeeded')
    expect(repository.records.has(entry.id)).toBe(true)
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains a timed-out restored record without reinserting or showing it', async () => {
    const loading = deferred()
    vi.spyOn(BrowserWindow.prototype, 'loadFile').mockReturnValueOnce(loading.promise)
    const saved = persistedRecord()
    const repository = createRepository([saved])
    const { service } = createService(undefined, undefined, repository)
    service.initialize()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const restoration = service.restoreMissing({ source: 'initialization-timeout' })
    const [entry] = service.registry.values()
    const show = vi.spyOn(entry.window, 'showInactive')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await restoration).toBe(0)
    expect(repository.records.get(saved.id)).toEqual(saved)
    expect(repository.insert).not.toHaveBeenCalled()
    expect(repository.delete).not.toHaveBeenCalled()
    expect(show).not.toHaveBeenCalled()
    expect(entry.completeReady()).toBe(false)
    expect(service.getRecoverableCount()).toBe(1)
    loading.resolve()
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['rejected', 'synchronously thrown'])(
    'a %s load finishes creation, removes ownership and permits a later creation',
    async (failureMode) => {
      const loading = deferred()
      const load = vi.spyOn(BrowserWindow.prototype, 'loadFile')
      if (failureMode === 'rejected') load.mockReturnValueOnce(loading.promise)
      else
        load.mockImplementationOnce(() => {
          throw new Error('injected browser load failure')
        })
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const repository = createRepository()
      const { service } = createService(undefined, undefined, repository)
      service.initialize()
      const outcome = service.create({ noteId: 1 }).catch((error) => error)
      const entry = electronState.instances[0]
      if (failureMode === 'rejected') loading.reject(new Error('injected browser load failure'))
      expect((await outcome).message).toBe('便利贴页面加载失败')
      expect(entry.isDestroyed()).toBe(true)
      expect(service.registry.size).toBe(0)
      expect(service.byWebContentsId.size).toBe(0)
      expect(repository.insert).not.toHaveBeenCalled()
      const replacement = await completeCreation(service)
      expect(repository.records.has(replacement.entry.id)).toBe(true)
      expect(repository.records.size).toBe(1)
      service.dispose()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('an insert failure ends both ready and creation without a displayed or persisted sticky', async () => {
    const repository = createRepository()
    repository.insert.mockImplementationOnce(() => {
      throw new Error('injected sticky insert failure')
    })
    const { service } = createService(undefined, undefined, repository)
    service.initialize()
    const outcome = service.create({ noteId: 1 }).catch((error) => error)
    const [entry] = service.registry.values()
    const show = vi.spyOn(entry.window, 'showInactive')
    expect(() => service.markReady(entry.webContentsId)).toThrow('便利贴保存失败，未显示到桌面')
    const error = await outcome
    expect(error.committed).toBe(false)
    expect(error.cause.message).toBe('injected sticky insert failure')
    expect(entry.completeReady()).toBe(false)
    expect(entry.window.isDestroyed()).toBe(true)
    expect(show).not.toHaveBeenCalled()
    expect(repository.records.size).toBe(0)
    expect(service.registry.size).toBe(0)
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['throws', 'remains-hidden'])(
    'reports a committed show failure (%s) truthfully and preserves its record for recovery',
    async (showFailure) => {
      const repository = createRepository()
      const { service, mainWindow } = createService(undefined, undefined, repository)
      service.initialize()
      const response = electronState.handlers.get('sticky:create')(
        { sender: mainWindow.webContents },
        { noteId: 1 }
      )
      const [entry] = service.registry.values()
      vi.spyOn(entry.window, 'showInactive').mockImplementationOnce(() => {
        if (showFailure === 'throws') throw new Error('injected show failure')
      })
      expect(() => service.markReady(entry.webContentsId)).toThrow('便利贴已保存，但窗口显示失败')
      expect(await response).toEqual({
        ok: false,
        message: '便利贴已保存，但窗口显示失败，请通过托盘重试恢复',
        committed: true,
        stickyId: entry.id
      })
      expect(entry.initialization.state).toBe('failed')
      expect(entry.completeReady()).toBe(false)
      expect(entry.ready).toBe(false)
      expect(entry.window.isDestroyed()).toBe(true)
      expect(repository.records.has(entry.id)).toBe(true)
      expect(service.getRecoverableCount()).toBe(1)
      const restoration = service.restoreMissing({ source: 'after-show-failure' })
      const [restored] = service.registry.values()
      expect(restored.id).toBe(entry.id)
      expect(restored).not.toBe(entry)
      service.markReady(restored.webContentsId)
      expect(await restoration).toBe(1)
      expect(repository.insert).toHaveBeenCalledOnce()
      expect(restored.window.isVisible()).toBe(true)
      service.dispose()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('notification failure cannot fail a committed sticky or prevent runtime cleanup', async () => {
    const notify = vi.fn(() => {
      throw new Error('injected tray notification failure')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const repository = createRepository()
    const { service } = createService(undefined, undefined, repository, {
      onRegistryChanged: notify
    })
    service.initialize()
    const { entry, result } = await completeCreation(service)
    expect(result.id).toBe(entry.id)
    expect(entry.initialization.state).toBe('succeeded')
    expect(entry.window.isVisible()).toBe(true)
    expect(repository.records.has(entry.id)).toBe(true)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(() => service.dispose()).not.toThrow()
    expect(entry.window.isDestroyed()).toBe(true)
    expect(service.registry.size).toBe(0)
    expect(repository.records.has(entry.id)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains failed-destroy ownership until normal shutdown cleanup really releases it', async () => {
    const loading = deferred()
    vi.spyOn(BrowserWindow.prototype, 'loadFile').mockReturnValueOnce(loading.promise)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const repository = createRepository()
    const { service } = createService(undefined, undefined, repository)
    service.initialize()
    const outcome = service.create({ noteId: 1 }).catch((error) => error)
    const [entry] = service.registry.values()
    vi.spyOn(entry.window, 'destroy')
      .mockImplementationOnce(() => {
        throw new Error('injected destroy failure')
      })
      .mockImplementationOnce(() => {
        throw new Error('injected shutdown destroy failure')
      })
    await vi.advanceTimersByTimeAsync(5_000)
    const error = await outcome
    expect(error.cleanupError).toBe('injected destroy failure')
    expect(error.message).toContain('窗口清理失败，请正常退出应用以重试释放')
    expect(entry.initialization.state).toBe('failed')
    expect(entry.completeReady()).toBe(false)
    expect(entry.window.isDestroyed()).toBe(false)
    expect(service.registry.get(entry.id)).toBe(entry)
    expect(service.byWebContentsId.get(entry.webContentsId)).toBe(entry.id)
    expect(service.list()).toEqual([])
    expect(repository.insert).not.toHaveBeenCalled()
    expect(entry.readyTimer).toBe(null)
    expect(() => service.dispose()).toThrow('便利贴资源释放失败')
    expect(entry.window.isDestroyed()).toBe(false)
    expect(service.registry.get(entry.id)).toBe(entry)
    expect(entry.completeReady()).toBe(false)
    expect(() => service.dispose()).not.toThrow()
    expect(entry.window.isDestroyed()).toBe(true)
    expect(service.registry.size).toBe(0)
    expect(service.byWebContentsId.size).toBe(0)
    loading.resolve()
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['dispose', 'close', 'close-failed-delete'])(
    '%s reports whether a cancelled restoration actually retains its prior record',
    async (method) => {
      const loading = deferred()
      vi.spyOn(BrowserWindow.prototype, 'loadFile').mockReturnValueOnce(loading.promise)
      const saved = persistedRecord()
      const repository = createRepository([saved])
      const { service } = createService(undefined, undefined, repository)
      service.initialize()
      const restoration = service.restoreMissing({ source: 'cancel-record-ownership' })
      const [entry] = service.registry.values()
      const disposalTimestamp = Date.now()
      if (method === 'close-failed-delete') {
        repository.delete.mockImplementationOnce(() => {
          throw new Error('injected close delete failure')
        })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        expect(service.close(entry.id)).toBe(false)
      } else if (method === 'close') expect(service.close(entry.id)).toBe(true)
      else service.dispose()
      expect(await restoration).toBe(0)
      expect(entry.initialization.error.committed).toBe(method !== 'close')
      if (method !== 'close') {
        expect(entry.initialization.error.message).toContain('已保存记录保留供下次恢复')
        expect(repository.records.size).toBe(1)
        expect(repository.insert).not.toHaveBeenCalled()
        expect(repository.deleteAll).not.toHaveBeenCalled()
        // dispose has always saved final window bounds before releasing it. The
        // fixture repository merges that exact command patch into its saved row.
        const expectedBoundsPatch = {
          boundsX: saved.bounds.x,
          boundsY: saved.bounds.y,
          boundsWidth: saved.bounds.width,
          boundsHeight: saved.bounds.height,
          displayId: saved.displayId,
          workAreaX: saved.workArea.x,
          workAreaY: saved.workArea.y,
          workAreaWidth: saved.workArea.width,
          workAreaHeight: saved.workArea.height,
          updatedAt: disposalTimestamp
        }
        if (method === 'dispose') {
          expect(repository.update).toHaveBeenCalledExactlyOnceWith(saved.id, expectedBoundsPatch)
          expect(repository.delete).not.toHaveBeenCalled()
        } else {
          expect(repository.update).not.toHaveBeenCalled()
          expect(repository.delete).toHaveBeenCalledExactlyOnceWith(saved.id)
        }
        expect(
          repository.records.get(saved.id),
          JSON.stringify({
            method,
            before: saved,
            after: repository.records.get(saved.id),
            updates: repository.update.mock.calls
          })
        ).toEqual(method === 'dispose' ? { ...saved, ...expectedBoundsPatch } : saved)
      } else {
        expect(entry.initialization.error.message).toBe('便利贴初始化已取消')
        expect(repository.records.size).toBe(0)
      }
      loading.resolve()
      service.dispose()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('cleans registered ownership when setup fails before window listeners are installed', async () => {
    const repository = createRepository()
    const setupFailure = null
    const { service } = createService(undefined, undefined, repository, {
      bindMutationContinuation() {
        throw setupFailure
      }
    })
    service.initialize()
    await expect(service.create({ noteId: 1 })).rejects.toThrow('便利贴初始化失败')
    expect(electronState.instances[0].isDestroyed()).toBe(true)
    expect(service.registry.size).toBe(0)
    expect(service.byWebContentsId.size).toBe(0)
    expect(repository.insert).not.toHaveBeenCalled()
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a non-Error show failure still settles ready and returns committed IPC evidence', async () => {
    const repository = createRepository()
    const { service, mainWindow } = createService(undefined, undefined, repository)
    service.initialize()
    const response = electronState.handlers.get('sticky:create')(
      { sender: mainWindow.webContents },
      { noteId: 1 }
    )
    const [entry] = service.registry.values()
    const showFailure = null
    vi.spyOn(entry.window, 'showInactive').mockImplementationOnce(() => {
      throw showFailure
    })
    expect(() => service.markReady(entry.webContentsId)).toThrow('便利贴已保存，但窗口显示失败')
    expect(await response).toMatchObject({ ok: false, committed: true, stickyId: entry.id })
    expect(entry.initialization.error.cause).toBe(null)
    expect(entry.window.isDestroyed()).toBe(true)
    expect(repository.records.has(entry.id)).toBe(true)
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
