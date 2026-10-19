import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createMainWindowHost } from '../src/main/windows/main-window-host.js'

function fixture() {
  let sequence = 0
  class Window extends EventEmitter {
    constructor(options) {
      super()
      if (options.fail) throw new Error('creation failed')
      this.options = options
      this.id = ++sequence
      this.webContents = { id: sequence }
      this.destroyed = false
    }
    isDestroyed() {
      return this.destroyed
    }
    loadURL(value) {
      return Promise.resolve({ type: 'url', value })
    }
    loadFile(value) {
      return Promise.resolve({ type: 'file', value })
    }
  }
  return createMainWindowHost({ BrowserWindow: Window })
}

describe('single main window owner', () => {
  it('does not create a second live window or advance identity after failed construction', () => {
    const host = fixture()
    expect(() => host.create({ fail: true })).toThrow('creation failed')
    expect(host.getWindow()).toBeNull()
    expect(host.readIdentity().generation).toBe(0)
    const window = host.create({ sandbox: true })
    expect(host.getWindow()).toBe(window)
    expect(Object.isFrozen(host.readIdentity())).toBe(true)
    expect(() => host.create({})).toThrow('主窗口已存在')
    expect(host.readIdentity().generation).toBe(1)
  })
  it('runs owned cleanup once and clears identity even after cleanup failure', () => {
    const host = fixture()
    const window = host.create({})
    let calls = 0
    host.installClosedCleanup(window, () => {
      calls++
      expect(host.getWindow()).toBe(window)
      throw new Error('cleanup failed')
    })
    expect(() => host.installClosedCleanup(window, () => {})).toThrow('生命周期')
    expect(() => window.emit('closed')).toThrow('cleanup failed')
    expect(host.getWindow()).toBeNull()
    window.emit('closed')
    expect(calls).toBe(1)
  })
  it('ignores an old closed event after replacement and rejects loading the stale identity', async () => {
    const host = fixture()
    const old = host.create({})
    let calls = 0
    host.installClosedCleanup(old, () => calls++)
    old.destroyed = true
    const current = host.create({})
    old.emit('closed')
    expect(calls).toBe(0)
    expect(host.isCurrent(current)).toBe(true)
    expect(() => host.load(old, { type: 'file', value: 'old.html' })).toThrow('主窗口不可用')
    expect(await host.load(current, { type: 'url', value: 'https://localhost/' })).toEqual({
      type: 'url',
      value: 'https://localhost/'
    })
    expect(await host.load(current, { type: 'file', value: 'current.html' })).toEqual({
      type: 'file',
      value: 'current.html'
    })
  })
})
