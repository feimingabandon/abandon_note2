import { describe, expect, it, vi } from 'vitest'
import { createMainWindowIpc } from '../src/main/ipc/ipc-authorization.js'
import { registerRemoteNoticeIpc } from '../src/main/ipc/register-remote-notice-ipc.js'

const databaseAccess = vi.hoisted(() => vi.fn())
vi.mock('../src/main/db/db-connection.js', () => ({ getDb: databaseAccess }))
import { acknowledgeRemoteNotice, getRemoteNoticeLink } from '../src/main/db/db-remote-notices.js'

const channels = [
  'remote-notices:list-pending',
  'remote-notices:list',
  'remote-notices:acknowledge',
  'remote-notices:open-link',
  'remote:get-health'
]

function fixture(overrides = {}) {
  const handlers = new Map([['unrelated', () => true]])
  const window = { webContents: {}, isDestroyed: () => false }
  let currentWindow = window
  let coordinator = null
  const ipc = {
    handle(channel, handler) {
      if (handlers.has(channel)) throw new Error('duplicate')
      handlers.set(channel, handler)
    },
    removeHandler: vi.fn((channel) => handlers.delete(channel))
  }
  const owners = {
    listPendingRemoteNotices: vi.fn(() => []),
    listRemoteNotices: vi.fn(() => ({ items: [] })),
    acknowledgeRemoteNotice: vi.fn(() => true),
    getRemoteNoticeLink: vi.fn(() => null),
    getRemoteCoordinator: vi.fn(() => coordinator)
  }
  const shell = { openExternal: vi.fn(async () => {}) }
  const warn = vi.fn()
  const options = {
    mainWindowIpc: createMainWindowIpc(ipc, () => currentWindow),
    removeHandler: ipc.removeHandler,
    ...owners,
    shell,
    warn,
    ...overrides
  }
  return {
    handlers,
    window,
    owners,
    shell,
    warn,
    ipc,
    options,
    event: { sender: window.webContents },
    setWindow: (next) => (currentWindow = next),
    setCoordinator: (next) => (coordinator = next)
  }
}

describe('remote-notice transport', () => {
  it('rejects foreign, stale and destroyed senders before payload access or owner effects', () => {
    const f = fixture()
    registerRemoteNoticeIpc(f.options)
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
    f.window.isDestroyed = () => false
    const replacement = { webContents: {}, isDestroyed: () => false }
    f.setWindow(replacement)
    expect(() => f.handlers.get('remote-notices:acknowledge')(f.event, payload)).toThrow('无权访问')
    for (const owner of Object.values(f.owners)) expect(owner).not.toHaveBeenCalled()
    expect(f.shell.openExternal).not.toHaveBeenCalled()
    expect(
      f.handlers.get('remote-notices:acknowledge')({ sender: replacement.webContents }, { id: 9 })
    ).toBe(true)
    expect(f.owners.acknowledgeRemoteNotice).toHaveBeenCalledExactlyOnceWith(9)
  })

  it('delegates reads and local acknowledgement without transforming query or result', () => {
    const f = fixture()
    registerRemoteNoticeIpc(f.options)
    const pending = [{ id: 7 }]
    const page = { items: pending, pending: 1, total: 1, limit: 20, offset: 3 }
    const query = { limit: 20, offset: 3 }
    f.owners.listPendingRemoteNotices.mockReturnValue(pending)
    f.owners.listRemoteNotices.mockReturnValue(page)
    expect(f.handlers.get('remote-notices:list-pending')(f.event)).toBe(pending)
    expect(f.handlers.get('remote-notices:list')(f.event, query)).toBe(page)
    expect(f.owners.listRemoteNotices).toHaveBeenCalledExactlyOnceWith(query)
    expect(f.owners.listRemoteNotices.mock.calls[0][0]).toBe(query)
    f.handlers.get('remote-notices:list')(f.event)
    expect(f.owners.listRemoteNotices).toHaveBeenLastCalledWith(undefined)
    f.owners.acknowledgeRemoteNotice.mockReturnValue(false)
    expect(f.handlers.get('remote-notices:acknowledge')(f.event, { id: '7' })).toBe(false)
    expect(f.owners.acknowledgeRemoteNotice).toHaveBeenCalledExactlyOnceWith('7')
    expect(f.shell.openExternal).not.toHaveBeenCalled()
  })

  it('preserves real local-command validation and rejects malformed requests before DB access', () => {
    databaseAccess.mockClear()
    const f = fixture({ acknowledgeRemoteNotice, getRemoteNoticeLink })
    registerRemoteNoticeIpc(f.options)
    const acknowledge = f.handlers.get('remote-notices:acknowledge')
    for (const id of [0, -1, 'bad', 1.5]) {
      expect(() => acknowledge(f.event, { id })).toThrow('通知 ID 无效')
      expect(f.handlers.get('remote-notices:open-link')(f.event, { id })).toBe(false)
    }
    for (const request of [undefined, null]) {
      expect(() => acknowledge(f.event, request)).toThrow(TypeError)
      expect(() => f.handlers.get('remote-notices:open-link')(f.event, request)).toThrow(TypeError)
    }
    expect(databaseAccess).not.toHaveBeenCalled()
    expect(f.shell.openExternal).not.toHaveBeenCalled()
  })

  it('opens only a locally resolved HTTPS notice URL and preserves immediate return semantics', async () => {
    const f = fixture()
    registerRemoteNoticeIpc(f.options)
    const open = f.handlers.get('remote-notices:open-link')
    for (const link of [
      null,
      '',
      'bad url',
      'http://example.invalid',
      'file:///secret',
      'javascript:alert(1)'
    ]) {
      f.owners.getRemoteNoticeLink.mockReturnValueOnce(link)
      expect(open(f.event, { id: 1, link: 'https://renderer.invalid' })).toBe(false)
    }
    expect(f.shell.openExternal).not.toHaveBeenCalled()
    f.owners.getRemoteNoticeLink.mockReturnValue('https://EXAMPLE.invalid/path?q=notice')
    let finish
    f.shell.openExternal.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
    expect(open(f.event, { id: 7, link: 'https://renderer.invalid' })).toBe(true)
    expect(f.owners.getRemoteNoticeLink).toHaveBeenLastCalledWith(7)
    expect(f.shell.openExternal).toHaveBeenCalledExactlyOnceWith(
      'https://example.invalid/path?q=notice'
    )
    finish()
    await Promise.resolve()
  })

  it('reports asynchronous browser rejection while retaining synchronous and repository errors', async () => {
    const f = fixture()
    registerRemoteNoticeIpc(f.options)
    const open = f.handlers.get('remote-notices:open-link')
    f.owners.getRemoteNoticeLink.mockReturnValue('https://example.invalid')
    const error = new Error('browser unavailable')
    f.shell.openExternal.mockRejectedValueOnce(error)
    expect(open(f.event, { id: 7 })).toBe(true)
    await Promise.resolve()
    expect(f.warn).toHaveBeenCalledExactlyOnceWith('[remote] 打开通知链接失败:', error)
    f.shell.openExternal.mockImplementationOnce(() => {
      throw error
    })
    expect(open(f.event, { id: 7 })).toBe(false)
    expect(f.warn).toHaveBeenCalledTimes(1)
    const dbError = new Error('DB unavailable')
    f.owners.getRemoteNoticeLink.mockImplementationOnce(() => {
      throw dbError
    })
    expect(() => open(f.event, { id: 7 })).toThrow(dbError)
    f.owners.listRemoteNotices.mockImplementationOnce(() => {
      throw dbError
    })
    expect(() => f.handlers.get('remote-notices:list')(f.event)).toThrow(dbError)
  })

  it('uses the current initialized coordinator cache without starting or refreshing remote service', () => {
    const f = fixture()
    registerRemoteNoticeIpc(f.options)
    const read = f.handlers.get('remote:get-health')
    expect(read(f.event)).toEqual({
      available: false,
      noticeService: false,
      reportService: false,
      checkedAt: null,
      checking: false,
      skipped: false,
      error: '远程服务尚未初始化'
    })
    const cached = { available: true, checkedAt: 123, checking: false }
    const coordinator = {
      getHealthSnapshot: vi.fn(() => cached),
      start: vi.fn(),
      refreshHealth: vi.fn()
    }
    f.setCoordinator(coordinator)
    expect(read(f.event)).toBe(cached)
    expect(coordinator.getHealthSnapshot).toHaveBeenCalledExactlyOnceWith()
    expect(coordinator.start).not.toHaveBeenCalled()
    expect(coordinator.refreshHealth).not.toHaveBeenCalled()
  })

  it('disposes owned handlers once and allows a fresh registration without removing unrelated handlers', () => {
    const f = fixture()
    const unrelated = f.handlers.get('unrelated')
    const dispose = registerRemoteNoticeIpc(f.options)
    expect(() => registerRemoteNoticeIpc(f.options)).toThrow('duplicate')
    expect(f.ipc.removeHandler).not.toHaveBeenCalled()
    dispose()
    dispose()
    expect([...f.handlers.keys()]).toEqual(['unrelated'])
    expect(f.handlers.get('unrelated')).toBe(unrelated)
    expect(f.ipc.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(channels)
    const nextDispose = registerRemoteNoticeIpc(f.options)
    expect(f.handlers.get('remote-notices:list-pending')(f.event)).toEqual([])
    nextDispose()
  })

  it.each(channels)(
    'rolls back only successfully owned registrations when %s is occupied',
    (occupied) => {
      const f = fixture()
      const existing = () => 'external owner'
      f.handlers.set(occupied, existing)
      expect(() => registerRemoteNoticeIpc(f.options)).toThrow('duplicate')
      expect([...f.handlers.keys()]).toEqual(['unrelated', occupied])
      expect(f.handlers.get(occupied)).toBe(existing)
      expect(f.ipc.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(
        channels.slice(0, channels.indexOf(occupied))
      )
    }
  )
})
