import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createImageDecodeRuntime } from '../src/main/images/image-decode-runtime.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

function operation() {
  const result = deferred()
  const closed = deferred()
  return {
    result: result.promise,
    closed: closed.promise,
    cancel: vi.fn(),
    deliver: result.resolve,
    fail: result.reject,
    close: closed.resolve,
    failClose: closed.reject
  }
}

function fixture(options = {}) {
  const operations = []
  const diagnostics = []
  const start = vi.fn(() => {
    const work = operation()
    operations.push(work)
    return work
  })
  const runtime = createImageDecodeRuntime({
    start,
    onDiagnostic: (event) => diagnostics.push(event),
    ...options
  })
  return { runtime, start, operations, diagnostics }
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => vi.useRealTimers())

describe('bounded image decode resource ownership', () => {
  it('deduplicates the original Promise and waits for real closure before publishing or starting next', async () => {
    const { runtime, start, operations } = fixture()
    const payload = { path: 'first.png' }
    const first = runtime.request('first', payload)
    expect(runtime.request('first', { path: 'ignored.png' })).toBe(first)
    const second = runtime.request('second', { path: 'second.png' })
    const published = vi.fn()
    void first.then(published)
    operations[0].deliver({ width: 16, height: 8 })
    await flush()
    expect(published).not.toHaveBeenCalled()
    expect(start).toHaveBeenCalledTimes(1)
    expect(runtime.snapshot()).toMatchObject({ busy: true, pending: 2, queued: 1 })
    operations[0].close()
    await expect(first).resolves.toEqual({ width: 16, height: 8 })
    expect(start).toHaveBeenCalledTimes(2)
    expect(start).toHaveBeenNthCalledWith(1, payload)
    operations[1].deliver('thumbnail')
    operations[1].close()
    await expect(second).resolves.toBe('thumbnail')
    expect(runtime.snapshot()).toMatchObject({ busy: false, pending: 0 })
    await runtime.dispose()
  })

  it('also handles close arriving before the decoded result without publishing a partial response', async () => {
    const { runtime, operations } = fixture()
    const response = runtime.request('image', {})
    const published = vi.fn()
    void response.then(published)
    operations[0].close()
    await flush()
    expect(published).not.toHaveBeenCalled()
    operations[0].deliver('complete')
    await expect(response).resolves.toBe('complete')
    expect(runtime.snapshot().pending).toBe(0)
    await runtime.dispose()
  })

  it('bounds unique admitted work including active resources and leaves queued payloads unread', async () => {
    const { runtime, start, operations, diagnostics } = fixture({ maxPending: 2 })
    const first = runtime.request('first', {})
    const queuedPayload = {}
    Object.defineProperty(queuedPayload, 'bytes', {
      get: () => {
        throw new Error('queued source was read')
      }
    })
    const queued = runtime.request('queued', queuedPayload)
    expect(runtime.request('queued', {})).toBe(queued)
    await expect(runtime.request('overflow', {})).resolves.toBeNull()
    expect(start).toHaveBeenCalledTimes(1)
    expect(diagnostics).toContainEqual({ type: 'queue-full', key: 'overflow' })
    const disposed = runtime.dispose()
    await expect(first).resolves.toBeNull()
    await expect(queued).resolves.toBeNull()
    operations[0].close()
    await disposed
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('expires waiting work without starting it while an earlier resource still owns the slot', async () => {
    const { runtime, start, operations, diagnostics } = fixture({
      totalTimeoutMs: 40,
      activeTimeoutMs: 100
    })
    const first = runtime.request('first', {})
    const queued = runtime.request('queued', {})
    await vi.advanceTimersByTimeAsync(40)
    await expect(first).resolves.toBeNull()
    await expect(queued).resolves.toBeNull()
    expect(start).toHaveBeenCalledTimes(1)
    expect(operations[0].cancel).toHaveBeenCalledExactlyOnceWith('total-timeout')
    expect(diagnostics).toContainEqual({ type: 'total-timeout', key: 'queued' })
    expect(runtime.snapshot()).toMatchObject({ busy: true, pending: 1, queued: 0 })
    operations[0].close()
    await flush()
    await runtime.dispose()
  })

  it('answers an active timeout but starts the next request only after the cancelled resource closes', async () => {
    const { runtime, start, operations } = fixture({
      totalTimeoutMs: 100,
      activeTimeoutMs: 20
    })
    const first = runtime.request('first', {})
    const second = runtime.request('second', {})
    await vi.advanceTimersByTimeAsync(20)
    await expect(first).resolves.toBeNull()
    expect(operations[0].cancel).toHaveBeenCalledExactlyOnceWith('active-timeout')
    expect(runtime.request('first', {})).toBe(first)
    operations[0].deliver('late image')
    await vi.advanceTimersByTimeAsync(5)
    expect(start).toHaveBeenCalledTimes(1)
    expect(runtime.snapshot()).toMatchObject({ busy: true, pending: 2 })
    operations[0].close()
    await flush()
    expect(start).toHaveBeenCalledTimes(2)
    operations[1].deliver('next image')
    operations[1].close()
    await expect(second).resolves.toBe('next image')
    const fresh = runtime.request('first', {})
    expect(fresh).not.toBe(first)
    operations[2].deliver('fresh image')
    operations[2].close()
    await expect(fresh).resolves.toBe('fresh image')
    await runtime.dispose()
  })

  it('measures total time from enqueue rather than restarting its budget at decoder startup', async () => {
    const { runtime, operations } = fixture({ totalTimeoutMs: 40, activeTimeoutMs: 100 })
    const first = runtime.request('first', {})
    const second = runtime.request('second', {})
    await vi.advanceTimersByTimeAsync(30)
    operations[0].deliver('first')
    operations[0].close()
    await expect(first).resolves.toBe('first')
    await vi.advanceTimersByTimeAsync(10)
    await expect(second).resolves.toBeNull()
    expect(operations[1].cancel).toHaveBeenCalledExactlyOnceWith('total-timeout')
    operations[1].close()
    await flush()
    await runtime.dispose()
  })

  it('checks source validity both before queued startup and again after result but before publication', async () => {
    const { runtime, start, operations } = fixture()
    let waitingCurrent = true
    let activeCurrent = true
    const first = runtime.request('first', {}, () => activeCurrent)
    const waiting = runtime.request('waiting', {}, () => waitingCurrent)
    waitingCurrent = false
    operations[0].deliver('must not escape')
    await flush()
    activeCurrent = false
    operations[0].close()
    await expect(first).resolves.toBeNull()
    await expect(waiting).resolves.toBeNull()
    expect(start).toHaveBeenCalledTimes(1)
    await runtime.dispose()
  })

  it('cancels an expired active source and ignores late completion until it is actually closed', async () => {
    const { runtime, operations, start } = fixture()
    let current = true
    const response = runtime.request('expired', {}, () => current)
    const next = runtime.request('next', {})
    current = false
    operations[0].deliver('stale')
    await expect(response).resolves.toBeNull()
    expect(operations[0].cancel).toHaveBeenCalledExactlyOnceWith('source-expired')
    expect(start).toHaveBeenCalledTimes(1)
    operations[0].close()
    await flush()
    operations[1].deliver('valid')
    operations[1].close()
    await expect(next).resolves.toBe('valid')
    await runtime.dispose()
  })

  it('isolates rejected results while retaining ownership until resource closure', async () => {
    const { runtime, operations, start, diagnostics } = fixture()
    const failure = new Error('decoder failed')
    const response = runtime.request('failed', {})
    const next = runtime.request('next', {})
    operations[0].fail(failure)
    await expect(response).resolves.toBeNull()
    expect(diagnostics).toContainEqual({ type: 'result-error', key: 'failed', error: failure })
    expect(operations[0].cancel).toHaveBeenCalledExactlyOnceWith('result-error')
    expect(start).toHaveBeenCalledTimes(1)
    operations[0].close()
    await flush()
    operations[1].deliver(null)
    operations[1].close()
    await expect(next).resolves.toBeNull()
    expect(runtime.snapshot()).toMatchObject({ sealed: false, busy: false })
    await runtime.dispose()
  })

  it('contains a synchronous startup error and permits a later request with no returned resource', async () => {
    const failure = new Error('spawn refused')
    const work = operation()
    const start = vi
      .fn()
      .mockImplementationOnce(() => {
        throw failure
      })
      .mockReturnValue(work)
    const { runtime, diagnostics } = fixture({ start })
    await expect(runtime.request('failed', {})).resolves.toBeNull()
    expect(diagnostics).toContainEqual({ type: 'start-error', key: 'failed', error: failure })
    const next = runtime.request('next', {})
    work.deliver('started')
    work.close()
    await expect(next).resolves.toBe('started')
    await runtime.dispose()
  })

  it('seals synchronously on dispose, clears waiting work, and returns one promise waiting for actual close', async () => {
    const { runtime, start, operations } = fixture()
    const active = runtime.request('active', {})
    const queued = runtime.request('queued', {})
    const disposed = runtime.dispose()
    expect(runtime.dispose()).toBe(disposed)
    expect(runtime.snapshot()).toMatchObject({ sealed: true, busy: true, pending: 1, queued: 0 })
    expect(operations[0].cancel).toHaveBeenCalledExactlyOnceWith('disposed')
    await expect(active).resolves.toBeNull()
    await expect(queued).resolves.toBeNull()
    await expect(runtime.request('after-dispose', {})).resolves.toBeNull()
    const cleaned = vi.fn()
    void disposed.then(cleaned)
    operations[0].deliver('late')
    await flush()
    expect(cleaned).not.toHaveBeenCalled()
    expect(start).toHaveBeenCalledTimes(1)
    operations[0].close()
    await disposed
    expect(runtime.snapshot()).toMatchObject({ busy: false, pending: 0, sealed: true })
  })

  it('cancels a batch without sealing, waits for real closure, and then accepts fresh work', async () => {
    const { runtime, operations, start } = fixture()
    const active = runtime.request('active', {})
    const queued = runtime.request('queued', {})
    const cancelled = runtime.cancelAll()
    expect(runtime.cancelAll()).toBe(cancelled)
    expect(runtime.snapshot()).toMatchObject({ sealed: false, busy: true, queued: 0, pending: 1 })
    expect(operations[0].cancel).toHaveBeenCalledExactlyOnceWith('cancelled')
    await expect(active).resolves.toBeNull()
    await expect(queued).resolves.toBeNull()
    const completed = vi.fn()
    void cancelled.then(completed)
    operations[0].deliver('late result')
    await flush()
    expect(completed).not.toHaveBeenCalled()
    expect(start).toHaveBeenCalledTimes(1)
    operations[0].close()
    await cancelled
    expect(runtime.snapshot()).toMatchObject({ busy: false, pending: 0, sealed: false })
    const fresh = runtime.request('active', {})
    operations[1].deliver('fresh generation')
    operations[1].close()
    await expect(fresh).resolves.toBe('fresh generation')
    await runtime.dispose()
  })

  it('releases confirmed closed resources after cleanup failures and still rejects the affected batch cleanup', async () => {
    const { runtime, operations, start, diagnostics } = fixture()
    const firstCleanupError = new Error('first profile could not be removed')
    const secondCleanupError = new Error('second profile could not be removed')
    const first = runtime.request('first', {})
    const second = runtime.request('second', {})
    operations[0].deliver('first image')
    operations[0].close({ cleanupError: firstCleanupError })
    await expect(first).resolves.toBe('first image')
    expect(start).toHaveBeenCalledTimes(2)
    expect(runtime.snapshot()).toMatchObject({
      busy: true,
      pending: 1,
      sealed: false,
      blocked: false,
      cleanupFailures: 1
    })
    expect(diagnostics).toContainEqual({
      type: 'cleanup-error',
      key: 'first',
      error: firstCleanupError
    })
    const cancelled = runtime.cancelAll()
    await expect(second).resolves.toBeNull()
    operations[1].close({ cleanupError: secondCleanupError })
    await expect(cancelled).rejects.toBe(secondCleanupError)
    expect(runtime.snapshot()).toMatchObject({ busy: false, pending: 0, cleanupFailures: 2 })
    await expect(runtime.dispose()).rejects.toBe(firstCleanupError)
  })

  it('remembers a completed cleanup failure for late disposal without cancelling the already closed decoder', async () => {
    const { runtime, operations } = fixture()
    const cleanupError = new Error('closed child profile remains')
    const response = runtime.request('image', {})
    operations[0].deliver('image')
    operations[0].close({ cleanupError })
    await expect(response).resolves.toBe('image')
    expect(runtime.snapshot()).toMatchObject({
      busy: false,
      pending: 0,
      sealed: false,
      cleanupFailures: 1
    })
    const disposed = runtime.dispose()
    expect(runtime.dispose()).toBe(disposed)
    await expect(disposed).rejects.toBe(cleanupError)
    expect(operations[0].cancel).not.toHaveBeenCalled()
    expect(runtime.snapshot()).toMatchObject({ busy: false, pending: 0, sealed: true })
  })

  it('blocks further decoding when closure cannot be confirmed and reports cleanup failure separately', async () => {
    const { runtime, start, operations } = fixture()
    const failure = new Error('close observation failed')
    const active = runtime.request('active', {})
    const waiting = runtime.request('waiting', {})
    operations[0].deliver('unconfirmed')
    operations[0].failClose(failure)
    await expect(active).resolves.toBeNull()
    await expect(waiting).resolves.toBeNull()
    await expect(runtime.request('later', {})).resolves.toBeNull()
    expect(operations[0].cancel).toHaveBeenCalledExactlyOnceWith('closed-error')
    expect(start).toHaveBeenCalledTimes(1)
    expect(runtime.snapshot()).toMatchObject({
      busy: true,
      pending: 1,
      sealed: true,
      blocked: true
    })
    await expect(runtime.dispose()).rejects.toBe(failure)
  })

  it('seals on a throwing cancellation and still waits for closure before rejecting disposal', async () => {
    const { runtime, operations, start } = fixture({ activeTimeoutMs: 20 })
    const failure = new Error('cancel refused')
    const response = runtime.request('active', {})
    const waiting = runtime.request('waiting', {})
    operations[0].cancel.mockImplementation(() => {
      throw failure
    })
    await vi.advanceTimersByTimeAsync(20)
    await expect(response).resolves.toBeNull()
    await expect(waiting).resolves.toBeNull()
    const disposed = runtime.dispose()
    const settled = vi.fn()
    void disposed.then(settled, settled)
    await flush()
    expect(settled).not.toHaveBeenCalled()
    expect(runtime.snapshot()).toMatchObject({ busy: true, sealed: true, blocked: true })
    operations[0].close()
    await expect(disposed).rejects.toBe(failure)
    expect(start).toHaveBeenCalledTimes(1)
    expect(runtime.snapshot().busy).toBe(false)
  })

  it('keeps diagnostic failures from changing cancellation or resource order', async () => {
    const { runtime, operations, start } = fixture({
      activeTimeoutMs: 20,
      onDiagnostic: () => {
        throw new Error('logger failed')
      }
    })
    const first = runtime.request('first', {})
    const next = runtime.request('next', {})
    await vi.advanceTimersByTimeAsync(20)
    await expect(first).resolves.toBeNull()
    expect(operations[0].cancel).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledTimes(1)
    operations[0].close()
    await flush()
    operations[1].deliver('next')
    operations[1].close()
    await expect(next).resolves.toBe('next')
    await runtime.dispose()
  })

  it('rejects an already expired or throwing source before acquiring any decoder resource', async () => {
    const { runtime, start, diagnostics } = fixture()
    await expect(runtime.request('stale', {}, () => false)).resolves.toBeNull()
    const failure = new Error('source lookup failed')
    await expect(
      runtime.request('throwing', {}, () => {
        throw failure
      })
    ).resolves.toBeNull()
    expect(start).not.toHaveBeenCalled()
    expect(diagnostics).toContainEqual({
      type: 'source-check-error',
      key: 'throwing',
      error: failure
    })
    await runtime.dispose()
  })

  it('fails closed if a returned resource has no usable closure promise', async () => {
    const cancel = vi.fn()
    const start = vi.fn(() => ({ result: Promise.resolve('orphan'), cancel }))
    const { runtime } = fixture({ start })
    await expect(runtime.request('malformed', {})).resolves.toBeNull()
    expect(cancel).toHaveBeenCalledExactlyOnceWith('invalid-operation')
    expect(runtime.snapshot()).toMatchObject({ busy: true, sealed: true, blocked: true })
    await expect(runtime.request('later', {})).resolves.toBeNull()
    await expect(runtime.dispose()).rejects.toThrow('result, closed and cancel')
    expect(start).toHaveBeenCalledTimes(1)
  })
})
