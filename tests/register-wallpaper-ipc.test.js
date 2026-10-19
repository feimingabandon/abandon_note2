import { describe, expect, it, vi } from 'vitest'
import { createMainWindowIpc } from '../src/main/ipc/ipc-authorization.js'
import { registerWallpaperIpc } from '../src/main/ipc/register-wallpaper-ipc.js'

const channels = [
  'wallpapers:list',
  'wallpapers:get-thumbnail',
  'wallpapers:get-data',
  'wallpapers:save',
  'wallpapers:activate',
  'wallpapers:disable',
  'wallpapers:delete'
]

function fixture() {
  const handlers = new Map([['unrelated', () => true]])
  const window = { webContents: {}, isDestroyed: () => false }
  const ipc = {
    handle(channel, handler) {
      if (handlers.has(channel)) throw new Error('duplicate')
      handlers.set(channel, handler)
    },
    removeHandler: vi.fn((channel) => handlers.delete(channel))
  }
  const coordinator = {
    listWallpaperLibraryRecords: vi.fn(() => []),
    saveWallpaper: vi.fn(async () => ({ id: 7 })),
    activateWallpaper: vi.fn(() => ({ record: { id: 7 }, snapshot: {} })),
    disableWallpaper: vi.fn(() => ({ wallpaper: { enabled: false } })),
    deleteWallpaper: vi.fn(async () => true)
  }
  const thumbnail = vi.fn(() => 'data:image/png;base64,thumbnail')
  const data = vi.fn(async () => 'data:image/png;base64,crop')
  const options = {
    mainWindowIpc: createMainWindowIpc(ipc, () => window),
    removeHandler: ipc.removeHandler,
    backgroundSettingsCoordinator: coordinator,
    getWallpaperThumbnail: thumbnail,
    getWallpaperDataUrl: data
  }
  return {
    handlers,
    window,
    coordinator,
    thumbnail,
    data,
    options,
    ipc,
    event: { sender: window.webContents }
  }
}

describe('wallpaper transport', () => {
  it('authorizes the live main window before reading payloads or calling storage/settings owners', () => {
    const f = fixture()
    registerWallpaperIpc(f.options)
    const payload = {
      get id() {
        throw new Error('payload accessed')
      }
    }
    for (const channel of channels) {
      expect(() => f.handlers.get(channel)({ sender: {} }, payload)).toThrow('无权访问')
    }
    f.window.isDestroyed = () => true
    for (const channel of channels) {
      expect(() => f.handlers.get(channel)(f.event, payload)).toThrow('无权访问')
    }
    for (const owner of Object.values(f.coordinator)) expect(owner).not.toHaveBeenCalled()
    expect(f.thumbnail).not.toHaveBeenCalled()
    expect(f.data).not.toHaveBeenCalled()
  })

  it('keeps complete mutating commands in the coordinator and returns each owner result unchanged', async () => {
    const f = fixture()
    registerWallpaperIpc(f.options)
    const records = [{ id: 7, usedBy: ['month'], compatibleWithCurrentView: true }]
    f.coordinator.listWallpaperLibraryRecords.mockReturnValue(records)
    expect(f.handlers.get('wallpapers:list')(f.event)).toBe(records)
    const payload = { sourceId: 1, cropped: { base64: 'fixture' }, crop: { x: 0 } }
    const pendingSave = f.handlers.get('wallpapers:save')(f.event, payload)
    expect(pendingSave).toBe(f.coordinator.saveWallpaper.mock.results[0].value)
    expect(await pendingSave).toEqual({ id: 7 })
    expect(f.coordinator.saveWallpaper.mock.calls[0][0]).toBe(payload)
    const activate = { id: '7' }
    const activated = f.handlers.get('wallpapers:activate')(f.event, activate)
    expect(activated).toBe(f.coordinator.activateWallpaper.mock.results[0].value)
    expect(f.coordinator.activateWallpaper.mock.calls[0][0]).toBe(activate)
    expect(f.handlers.get('wallpapers:disable')(f.event)).toBe(
      f.coordinator.disableWallpaper.mock.results[0].value
    )
    expect(f.coordinator.disableWallpaper).toHaveBeenCalledExactlyOnceWith()
    const deletion = { id: 7 }
    const pendingDelete = f.handlers.get('wallpapers:delete')(f.event, deletion)
    expect(pendingDelete).toBe(f.coordinator.deleteWallpaper.mock.results[0].value)
    expect(await pendingDelete).toBe(true)
    expect(f.coordinator.deleteWallpaper.mock.calls[0][0]).toBe(deletion)
    expect(f.thumbnail).not.toHaveBeenCalled()
    expect(f.data).not.toHaveBeenCalled()
  })

  it('retains absent-save fallback while passing activation/deletion input to their existing owner', async () => {
    const f = fixture()
    registerWallpaperIpc(f.options)
    for (const payload of [undefined, null, false, 0, '']) {
      await f.handlers.get('wallpapers:save')(f.event, payload)
      expect(f.coordinator.saveWallpaper).toHaveBeenLastCalledWith({})
    }
    f.coordinator.activateWallpaper.mockImplementationOnce(() => {
      throw new Error('壁纸不存在')
    })
    expect(() => f.handlers.get('wallpapers:activate')(f.event, { id: -1 })).toThrow('壁纸不存在')
    expect(f.coordinator.activateWallpaper).toHaveBeenCalledExactlyOnceWith({ id: -1 })
    f.coordinator.deleteWallpaper.mockRejectedValueOnce(new Error('delete failed'))
    await expect(f.handlers.get('wallpapers:delete')(f.event, null)).rejects.toThrow(
      'delete failed'
    )
    expect(f.coordinator.deleteWallpaper).toHaveBeenCalledExactlyOnceWith(null)
    expect(f.coordinator.disableWallpaper).not.toHaveBeenCalled()
  })

  it('routes thumbnail and original/crop selection without mutating requested values or consuming errors', async () => {
    const f = fixture()
    registerWallpaperIpc(f.options)
    expect(f.handlers.get('wallpapers:get-thumbnail')(f.event, { id: '7', maxSize: 260 })).toBe(
      'data:image/png;base64,thumbnail'
    )
    expect(f.thumbnail).toHaveBeenCalledExactlyOnceWith('7', 260)
    const read = f.handlers.get('wallpapers:get-data')
    for (const original of [undefined, false, true, null]) {
      const pending = read(f.event, { id: 7, original })
      expect(pending).toBe(f.data.mock.results.at(-1).value)
      expect(await pending).toBe('data:image/png;base64,crop')
      expect(f.data).toHaveBeenLastCalledWith(7, {
        original: original === undefined ? false : original
      })
    }
    f.thumbnail.mockReturnValueOnce(null)
    expect(f.handlers.get('wallpapers:get-thumbnail')(f.event, { id: 99 })).toBeNull()
    f.data.mockRejectedValueOnce(new Error('read failed'))
    await expect(read(f.event, { id: 7 })).rejects.toThrow('read failed')
    for (const owner of Object.values(f.coordinator)) expect(owner).not.toHaveBeenCalled()
  })

  it('rejects malformed image read requests before accessing image storage', () => {
    const f = fixture()
    registerWallpaperIpc(f.options)
    for (const channel of ['wallpapers:get-thumbnail', 'wallpapers:get-data']) {
      for (const payload of [undefined, null]) {
        expect(() => f.handlers.get(channel)(f.event, payload)).toThrow(TypeError)
      }
    }
    expect(f.thumbnail).not.toHaveBeenCalled()
    expect(f.data).not.toHaveBeenCalled()
  })

  it('removes transport registrations once without canceling already admitted background work', async () => {
    const f = fixture()
    let finish
    const pending = new Promise((resolve) => (finish = resolve))
    f.coordinator.saveWallpaper.mockReturnValueOnce(pending)
    const unrelated = f.handlers.get('unrelated')
    const dispose = registerWallpaperIpc(f.options)
    expect(() => registerWallpaperIpc(f.options)).toThrow('duplicate')
    expect(f.ipc.removeHandler).not.toHaveBeenCalled()
    const admitted = f.handlers.get('wallpapers:save')(f.event, { sourceId: 1 })
    dispose()
    dispose()
    expect([...f.handlers.keys()]).toEqual(['unrelated'])
    expect(f.handlers.get('unrelated')).toBe(unrelated)
    expect(f.ipc.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(channels)
    finish({ id: 7 })
    expect(await admitted).toEqual({ id: 7 })
    const nextDispose = registerWallpaperIpc(f.options)
    expect(f.handlers.get('wallpapers:list')(f.event)).toEqual([])
    nextDispose()
  })

  it.each(channels)(
    'rolls back only registrations acquired before occupied channel %s',
    (occupied) => {
      const f = fixture()
      const external = () => 'external owner'
      f.handlers.set(occupied, external)
      expect(() => registerWallpaperIpc(f.options)).toThrow('duplicate')
      expect([...f.handlers.keys()]).toEqual(['unrelated', occupied])
      expect(f.handlers.get(occupied)).toBe(external)
      expect(f.ipc.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(
        channels.slice(0, channels.indexOf(occupied))
      )
    }
  )
})
