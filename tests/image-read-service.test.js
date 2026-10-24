import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createImageReadService } from '../src/main/images/image-read-service.js'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}
const flush = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}
function fixture(options = {}) {
  const service = createImageReadService(options)
  const operations = []
  function port(name) {
    return service.createPort({
      name,
      isCurrent: (source) => source.current !== false,
      start: (source) => {
        const result = deferred(),
          closed = deferred()
        const operation = { result: result.promise, closed: closed.promise, cancel: vi.fn() }
        operations.push({ source, result, closed, operation })
        return operation
      }
    })
  }
  return { service, operations, port }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('one application image read owner', () => {
  it('shares one real activity across stored and draft ports and deduplicates only within a port', async () => {
    const f = fixture(),
      stored = f.port('stored'),
      draft = f.port('draft')
    const original = stored.request('same', { id: 1 })
    expect(stored.request('same', { id: 2 })).toBe(original)
    const staged = draft.request('same', { id: 3 })
    expect(f.operations).toHaveLength(1)
    f.operations[0].result.resolve('stored')
    await flush()
    expect(f.operations).toHaveLength(1)
    f.operations[0].closed.resolve()
    expect(await original).toBe('stored')
    await flush()
    expect(f.operations).toHaveLength(2)
    expect(f.operations[1].source.id).toBe(3)
    f.operations[1].result.resolve('draft')
    f.operations[1].closed.resolve()
    expect(await staged).toBe('draft')
    await expect(f.service.dispose()).resolves.toBeUndefined()
  })

  it('applies a single pending bound across ports', async () => {
    const f = fixture({ maxPending: 2 }),
      a = f.port('stored'),
      b = f.port('draft')
    const active = a.request('one', {})
    const queued = b.request('two', {})
    expect(await b.request('three', {})).toBeNull()
    expect(f.service.snapshot().pending).toBe(2)
    const disposed = f.service.dispose()
    expect(await active).toBeNull()
    expect(await queued).toBeNull()
    expect(f.operations[0].operation.cancel).toHaveBeenCalledOnce()
    f.operations[0].closed.resolve()
    await disposed
    expect(f.operations).toHaveLength(1)
  })

  it('cancels before drain, rejects old results, and only the owning suspension can resume', async () => {
    const f = fixture(),
      a = f.port('stored'),
      b = f.port('draft')
    const originalGeneration = f.service.generation()
    const active = a.request('one', {})
    const owner = Symbol('clear')
    const drained = f.service.suspend(owner)
    let finished = false
    void drained.then(() => {
      finished = true
    })
    expect(f.service.isCurrent(originalGeneration)).toBe(false)
    expect(await active).toBeNull()
    expect(await b.request('during-clear', {})).toBeNull()
    expect(f.service.resume(Symbol('foreign'))).toBe(false)
    f.operations[0].result.resolve('late')
    await flush()
    expect(finished).toBe(false)
    f.operations[0].closed.resolve()
    await drained
    expect(f.service.resume(owner)).toBe(true)
    const next = b.request('after-clear', {})
    f.operations[1].result.resolve('current')
    f.operations[1].closed.resolve()
    expect(await next).toBe('current')
    await f.service.dispose()
  })

  it('invalidates both caches and queued source identities without starting obsolete work', async () => {
    const f = fixture()
    const invalidate = vi.fn()
    const cached = f.service.createPort({ name: 'cache', start: vi.fn(), onInvalidate: invalidate })
    const a = f.port('stored'),
      b = f.port('draft')
    const active = a.request('one', {}),
      queued = b.request('two', {})
    f.service.invalidate()
    expect(invalidate).toHaveBeenCalledOnce()
    f.operations[0].result.resolve('late')
    await flush()
    f.operations[0].closed.resolve()
    expect(await active).toBeNull()
    expect(await queued).toBeNull()
    expect(f.operations).toHaveLength(1)
    expect(cached).toBeDefined()
    await f.service.dispose()
  })

  it('keeps an unconfirmed close occupying the shared owner and preserves disposal failure', async () => {
    const f = fixture(),
      a = f.port('stored'),
      b = f.port('draft')
    const active = a.request('one', {}),
      queued = b.request('two', {})
    const error = new Error('owned file or process termination unconfirmed')
    f.operations[0].closed.reject(error)
    expect(await active).toBeNull()
    expect(await queued).toBeNull()
    expect(f.service.snapshot()).toMatchObject({ busy: true, blocked: true })
    expect(await b.request('after-failure', {})).toBeNull()
    await expect(f.service.dispose()).rejects.toBe(error)
    expect(f.operations).toHaveLength(1)
  })
})
