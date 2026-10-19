import { describe, expect, it, vi } from 'vitest'
import { createMainWindowIpc } from '../src/main/ipc/ipc-authorization.js'
import { registerAppIpc } from '../src/main/ipc/register-app-ipc.js'

function fixture() {
  const handlers = new Map([['unrelated', () => true]])
  const window = { webContents: {}, isDestroyed: () => false }
  const ipc = {
    handle(channel, fn) {
      if (handlers.has(channel)) throw new Error('duplicate')
      handlers.set(channel, fn)
    },
    removeHandler: (channel) => handlers.delete(channel)
  }
  const service = {
    check: vi.fn(async () => ({ checkId: 'current' })),
    getExternalUrl: vi.fn((request) => {
      if (request.checkId !== 'current') throw new Error('expired check')
      return 'https://example.invalid/current'
    })
  }
  const shell = { openExternal: vi.fn(async () => {}) }
  const options = {
    mainWindowIpc: createMainWindowIpc(ipc, () => window),
    removeHandler: ipc.removeHandler,
    app: { getVersion: () => 'fixture' },
    shell,
    appUpdateService: service,
    platform: 'test',
    arch: 'fixture'
  }
  return { handlers, window, service, shell, options, event: { sender: window.webContents } }
}

describe('owned app transport registration', () => {
  it('keeps every migrated channel bound to the current live main sender', async () => {
    const f = fixture()
    registerAppIpc(f.options)
    for (const name of ['app:get-info', 'update:check', 'update:open-link'])
      expect(() => f.handlers.get(name)({ sender: {} })).toThrow('无权访问')
    expect(f.handlers.get('app:get-info')(f.event)).toEqual({
      version: 'fixture',
      platform: 'test',
      arch: 'fixture'
    })
    expect(await f.handlers.get('update:check')(f.event)).toEqual({ checkId: 'current' })
    f.window.isDestroyed = () => true
    expect(() => f.handlers.get('app:get-info')(f.event)).toThrow('无权访问')
  })
  it('revalidates the check identity before external navigation and preserves failures', async () => {
    const f = fixture()
    registerAppIpc(f.options)
    const open = f.handlers.get('update:open-link')
    await expect(open(f.event, { target: 'unsupported' })).rejects.toThrow('未知的更新入口')
    await expect(open(f.event, { target: 'download', checkId: 'old' })).rejects.toThrow(
      'expired check'
    )
    expect(f.shell.openExternal).not.toHaveBeenCalled()
    expect(await open(f.event, { target: 'download', checkId: 'current' })).toBe(true)
    f.shell.openExternal.mockRejectedValueOnce(new Error('browser failed'))
    await expect(open(f.event, { target: 'github', checkId: 'current' })).rejects.toThrow(
      'browser failed'
    )
  })
  it('disposes only its own registrations once and rolls back a partial install', () => {
    const f = fixture()
    const dispose = registerAppIpc(f.options)
    expect(() => registerAppIpc(f.options)).toThrow('duplicate')
    expect(f.handlers.size).toBe(4)
    dispose()
    dispose()
    expect([...f.handlers.keys()]).toEqual(['unrelated'])
    f.handlers.set('app:get-info', () => 'existing')
    expect(() => registerAppIpc(f.options)).toThrow('duplicate')
    expect([...f.handlers.keys()]).toEqual(['unrelated', 'app:get-info'])
  })
})
