import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createSettingsWriteSource } from '../src/main/settings/settings-write-source.js'

function fixture(options = {}) {
  let scope = 'main'
  let file = resolve('out/renderer/index.html')
  let counter = 0
  const contents = new EventEmitter()
  const frame = { url: pathToFileURL(file).href, isDestroyed: () => false }
  contents.mainFrame = frame
  contents.isDestroyed = () => false
  contents.isCrashed = () => false
  contents.getURL = vi.fn(() => frame.url)
  const window = { webContents: contents, isDestroyed: () => false }
  const event = { sender: contents, senderFrame: frame }
  const source = createSettingsWriteSource({
    getMainWindow: () => window,
    getActiveWindowName: () => scope,
    getActiveRendererLocation: () => ({ type: 'file', value: file }),
    createToken: () => `document-${++counter}`,
    ...options
  })
  return {
    source,
    event,
    frame,
    contents,
    window,
    changeView() {
      scope = 'month'
      file = resolve('out/renderer/month.html')
    },
    loadCurrentView() {
      contents.emit('did-start-navigation', {}, '', false, true)
      frame.url = pathToFileURL(file).href
      contents.emit('did-navigate', {}, frame.url)
    }
  }
}

describe('settings writes belong to their originating main document', () => {
  it('captures only the existing live document without issuing or borrowing the write gate', () => {
    const assertCanWrite = vi.fn(() => {
      throw new Error('writes sealed')
    })
    const f = fixture({ assertCanWrite })
    expect(f.source.captureCurrent()).toBeNull()
    expect(f.source.readGeneration()).toBe(0)
    expect(f.contents.listenerCount('did-navigate')).toBe(0)
    const first = f.source.issue(f.event)
    expect(f.source.captureCurrent()).toEqual(first)
    expect(Object.isFrozen(f.source.captureCurrent())).toBe(true)
    expect(assertCanWrite).not.toHaveBeenCalled()
    f.loadCurrentView()
    expect(f.source.captureCurrent()).toBeNull()
    expect(f.source.readGeneration()).toBe(1)
    const next = f.source.issue(f.event)
    expect(next.token).not.toBe(first.token)
    expect(f.source.captureCurrent()).toEqual(next)
    f.source.stop()
    expect(f.source.captureCurrent()).toBeNull()
  })

  it('never reads a destroyed window getter when capturing or checking an expired source', () => {
    const f = fixture()
    const context = f.source.issue(f.event)
    f.window.isDestroyed = () => true
    const getter = vi.fn(() => {
      throw new Error('destroyed window getter')
    })
    Object.defineProperty(f.window, 'webContents', { get: getter })
    expect(f.source.captureCurrent()).toBeNull()
    expect(() => f.source.assertDocument(f.event, context)).toThrow('页面已失效')
    expect(getter).not.toHaveBeenCalled()
  })

  it('reads a monotonic generation without issuing a document identity', () => {
    const f = fixture()
    expect(f.source.readGeneration()).toBe(0)
    expect(f.source.readGeneration()).toBe(0)
    expect(f.contents.listenerCount('did-navigate')).toBe(0)
    expect(() => f.source.assertDocument(f.event, { token: 'document-1', scope: 'main' })).toThrow(
      '页面已失效'
    )
    expect(f.source.readGeneration()).toBe(0)
    const ticket = f.source.issue(f.event)
    // The renderer protocol remains the existing opaque token and scope only.
    expect(ticket).toEqual({ token: 'document-1', scope: 'main' })
    expect(f.source.readGeneration()).toBe(1)
    expect(f.source.issue(f.event)).toEqual(ticket)
    expect(f.source.readGeneration()).toBe(1)
  })

  it('validates document identity while settings writes are sealed without borrowing that write gate', () => {
    const assertCanWrite = vi.fn(() => {
      throw new Error('settings leaving')
    })
    const f = fixture({ assertCanWrite })
    const ticket = f.source.issue(f.event)
    expect(f.source.assertDocument(f.event, ticket)).toEqual({ scope: 'main', generation: 1 })
    expect(assertCanWrite).not.toHaveBeenCalled()
    expect(f.source.assertDocument(f.event, { ...ticket, generation: 99 })).toEqual({
      scope: 'main',
      generation: 1
    })
    expect(() => f.source.assert(f.event, ticket)).toThrow('settings leaving')
    expect(assertCanWrite).toHaveBeenCalledOnce()
    expect(f.source.assertDocument(f.event, ticket)).toEqual({ scope: 'main', generation: 1 })
    expect(assertCanWrite).toHaveBeenCalledOnce()
  })

  it.each(['same-url-reload', 'renderer-crash'])(
    'keeps generations increasing after %s invalidation and stop without renewing the old context',
    (reason) => {
      const f = fixture()
      const old = f.source.issue(f.event)
      expect(f.source.assertDocument(f.event, old)).toEqual({ scope: 'main', generation: 1 })
      if (reason === 'same-url-reload') f.loadCurrentView()
      else f.contents.emit('render-process-gone')
      expect(f.source.readGeneration()).toBe(1)
      expect(() => f.source.assertDocument(f.event, old)).toThrow('页面已失效')
      expect(f.source.readGeneration()).toBe(1)
      const next = f.source.issue(f.event)
      expect(next).toEqual({ token: 'document-2', scope: 'main' })
      expect(f.source.assertDocument(f.event, next)).toEqual({ scope: 'main', generation: 2 })
      expect(() => f.source.assertDocument(f.event, old)).toThrow('页面已失效')
      expect(f.source.readGeneration()).toBe(2)
      f.source.stop()
      expect(f.source.readGeneration()).toBe(2)
      expect(() => f.source.assertDocument(f.event, next)).toThrow('页面已失效')
      expect(() => f.source.issue(f.event)).toThrow('页面已失效')
      expect(f.source.readGeneration()).toBe(2)
    }
  )

  it('keeps read context available while the main settings leave gate rejects new writes', () => {
    let sealed = false
    const assertCanWrite = vi.fn(() => {
      if (sealed) throw new Error('settings leaving')
    })
    const f = fixture({ assertCanWrite })
    const ticket = f.source.issue(f.event)
    expect(f.source.assert(f.event, ticket)).toBe('main')
    sealed = true
    expect(f.source.issue(f.event)).toEqual(ticket)
    expect(() => f.source.assert(f.event, ticket)).toThrow('settings leaving')
    sealed = false
    expect(f.source.assert(f.event, ticket)).toBe('main')
  })
  it('reuses one source within a document and refuses client-selected scope or token', () => {
    const f = fixture()
    const ticket = f.source.issue(f.event)
    expect(f.source.issue(f.event)).toEqual(ticket)
    expect(f.source.assert(f.event, ticket)).toBe('main')
    expect(() => f.source.assert(f.event, { ...ticket, scope: 'month' })).toThrow('页面已失效')
    expect(() => f.source.assert(f.event, { ...ticket, token: 'forged' })).toThrow('页面已失效')
    expect(() => f.source.assertDocument(f.event, { ...ticket, scope: 'month' })).toThrow(
      '页面已失效'
    )
    expect(() => f.source.assertDocument(f.event, { ...ticket, token: 'forged' })).toThrow(
      '页面已失效'
    )
    expect(f.contents.listenerCount('did-navigate')).toBe(1)
  })

  it('rejects old-page work as soon as the active scope changes, before load completes', () => {
    const f = fixture()
    const old = f.source.issue(f.event)
    f.changeView()
    expect(() => f.source.assert(f.event, old)).toThrow('页面已失效')
    expect(() => f.source.issue(f.event)).toThrow('页面已失效')
    f.loadCurrentView()
    const next = f.source.issue(f.event)
    expect(next.scope).toBe('month')
    expect(() => f.source.assert(f.event, old)).toThrow('页面已失效')
    expect(f.source.assert(f.event, next)).toBe('month')
  })

  it('expires a same-URL reload even when the main frame wrapper is reused', () => {
    const f = fixture()
    const old = f.source.issue(f.event)
    f.loadCurrentView()
    const next = f.source.issue(f.event)
    expect(next.token).not.toBe(old.token)
    expect(() => f.source.assert(f.event, old)).toThrow('页面已失效')
    expect(f.source.assert(f.event, next)).toBe('main')
  })

  it('keeps the live document valid when a requested navigation never commits', () => {
    const f = fixture()
    const ticket = f.source.issue(f.event)
    f.contents.emit('did-start-navigation', {}, 'https://example.invalid/', false, true)
    expect(f.source.assert(f.event, ticket)).toBe('main')
    expect(f.source.issue(f.event)).toEqual(ticket)
    expect(f.source.assertDocument(f.event, ticket)).toEqual({ scope: 'main', generation: 1 })
    expect(f.source.readGeneration()).toBe(1)
  })

  it.each(['missing', 'subframe', 'destroyed', 'foreign-sender', 'unexpected-url'])(
    'refuses %s without borrowing the current webContents URL',
    (kind) => {
      const f = fixture()
      const ticket = f.source.issue(f.event)
      if (kind === 'missing') f.event.senderFrame = null
      if (kind === 'subframe') f.event.senderFrame = { ...f.frame }
      if (kind === 'destroyed') f.frame.isDestroyed = () => true
      if (kind === 'foreign-sender') f.event.sender = {}
      if (kind === 'unexpected-url') f.frame.url = 'https://example.com/index.html'
      expect(() => f.source.assert(f.event, ticket)).toThrow('页面已失效')
      expect(() => f.source.assertDocument(f.event, ticket)).toThrow('页面已失效')
      expect(() => f.source.issue(f.event)).toThrow('页面已失效')
      expect(f.contents.getURL).not.toHaveBeenCalled()
    }
  )

  it('preserves same-document hash changes, but expires crashed and stopped documents', () => {
    const f = fixture()
    const ticket = f.source.issue(f.event)
    f.frame.url += '#settings'
    f.contents.emit('did-start-navigation', {}, f.frame.url, true, true)
    expect(f.source.assert(f.event, ticket)).toBe('main')
    f.contents.emit('render-process-gone')
    expect(() => f.source.assert(f.event, ticket)).toThrow('页面已失效')
    const next = f.source.issue(f.event)
    f.source.stop()
    expect(() => f.source.assert(f.event, next)).toThrow('页面已失效')
    expect(() => f.source.issue(f.event)).toThrow('页面已失效')
    f.contents.emit('destroyed')
    expect(f.contents.listenerCount('did-navigate')).toBe(0)
    expect(f.contents.listenerCount('render-process-gone')).toBe(0)
  })
})
