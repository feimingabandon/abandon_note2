import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({
  handlers: new Map(),
  instances: [],
  nextWebContentsId: 100
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
      this.listeners = new Map()
      this.webContentsListeners = new Map()
      this.webContents = {
        id: ++electronState.nextWebContentsId,
        setWindowOpenHandler: vi.fn(),
        on: vi.fn((eventName, listener) => this.webContentsListeners.set(eventName, listener))
      }
      electronState.instances.push(this)
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

    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      this.listeners.get('closed')?.()
    }

    showInactive() {}

    moveTop() {}

    focus() {}
  }

  return {
    BrowserWindow,
    ipcMain: {
      handle: (channel, handler) => electronState.handlers.set(channel, handler),
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

function createService(
  mainBounds = { x: 1440, y: 25, width: 480, height: 930 },
  defaultAppearance,
  stickyRepository
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
      rendererFile: 'sticky.html'
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
    update: vi.fn((id) => records.has(id)),
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
  vi.restoreAllMocks()
})

describe('ElectronStickyService creation lifecycle', () => {
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
    expect(service.serializeAppearance(entry)).toEqual({
      fontSize: 23,
      backgroundColor: '#D4EAFF',
      textColor: '#1F2328',
      cornerRadius: 18,
      pinned: true
    })
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
