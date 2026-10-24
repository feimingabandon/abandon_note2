import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isReadonly } from 'vue'
import { useNoteStatusActions } from '../src/renderer/src/composables/useNoteStatusActions.js'

const owners = []
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture(callbacks = {}) {
  const api = {
    startProgress: vi.fn(async (id) => ({
      id,
      status: 'in_progress',
      effective_at: 'new effective'
    })),
    completeNote: vi.fn(async (id) => ({ id, status: 'completed' })),
    reopenNote: vi.fn(async (id) => ({ id, status: 'in_progress' }))
  }
  const onCommit = vi.fn(),
    onFinish = vi.fn(),
    onError = vi.fn()
  const options = { api, onCommit, onFinish, onError, ...callbacks }
  const model = useNoteStatusActions(options)
  owners.push(model)
  return { ...options, model }
}
const flush = async () => {
  for (let index = 0; index < 5; index++) await Promise.resolve()
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  owners.splice(0).forEach((owner) => owner.dispose())
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('owned note status command and presentation lifetime', () => {
  it.each([
    ['initialized', 'startProgress', 'in_progress', 125],
    ['in_progress', 'completeNote', 'completed', 920],
    ['completed', 'reopenNote', 'in_progress', 125]
  ])(
    'preserves %s command identity and exact commit/finish boundaries',
    async (from, method, to, delay) => {
      const { model, api, onCommit, onFinish, onError } = fixture()
      const note = { id: 7, status: from, effective_at: 'original effective' }
      const request = model.execute(note)
      expect(api[method]).toHaveBeenCalledExactlyOnceWith(7)
      expect(model.transitionFor(7)).toEqual({ from, to, phase: 'acknowledging' })
      expect(isReadonly(model.transitions)).toBe(true)
      expect(isReadonly(model.transitionFor(7))).toBe(true)
      const result = await request
      expect(result.status).toBe('committed')
      expect(model.transitionFor(7)).toEqual({ from, to, phase: 'playing' })
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(onCommit).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(onCommit).toHaveBeenCalledExactlyOnceWith(result.updated, note, { from, to })
      await vi.advanceTimersByTimeAsync(999 - delay)
      expect(onFinish).not.toHaveBeenCalled()
      expect(model.transitionFor(7)?.phase).toBe('playing')
      await vi.advanceTimersByTimeAsync(1)
      expect(onFinish).toHaveBeenCalledExactlyOnceWith(result.updated, note, {
        from,
        to,
        reconcile: false
      })
      expect(model.transitionFor(7)).toBeNull()
      expect(onError).not.toHaveBeenCalled()
      expect(Object.values(api).reduce((sum, method) => sum + method.mock.calls.length, 0)).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('changes acknowledging to waiting at 120ms and measures playing from the actual reply', async () => {
    const { model, api, onCommit } = fixture(),
      response = deferred()
    api.completeNote.mockReturnValueOnce(response.promise)
    const request = model.execute({ id: 1, status: 'in_progress' })
    await vi.advanceTimersByTimeAsync(119)
    expect(model.transitionFor(1).phase).toBe('acknowledging')
    await vi.advanceTimersByTimeAsync(1)
    expect(model.transitionFor(1).phase).toBe('waiting')
    await vi.advanceTimersByTimeAsync(380)
    response.resolve({ id: 1, status: 'completed' })
    await request
    expect(model.transitionFor(1).phase).toBe('playing')
    await vi.advanceTimersByTimeAsync(919)
    expect(onCommit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onCommit).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(80)
    expect(model.transitions.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('deduplicates one ID through the full animation while independent IDs run concurrently', async () => {
    const { model, api, onCommit, onFinish } = fixture(),
      first = deferred(),
      second = deferred()
    api.completeNote.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const note = { id: 1, status: 'in_progress' }
    const one = model.execute(note),
      duplicate = model.execute({ ...note }),
      two = model.execute({ ...note, id: 2 })
    expect(duplicate).toBe(one)
    expect(api.completeNote.mock.calls).toEqual([[1], [2]])
    expect(model.transitions.size).toBe(2)
    first.resolve({ id: 1, status: 'completed' })
    await one
    expect(model.execute(note)).toBe(one)
    expect(api.completeNote).toHaveBeenCalledTimes(2)
    second.resolve({ id: 2, status: 'completed' })
    await two
    await vi.advanceTimersByTimeAsync(1000)
    expect(onCommit).toHaveBeenCalledTimes(2)
    expect(onFinish).toHaveBeenCalledTimes(2)
    expect(model.transitions.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    null,
    {},
    { id: 1, status: 'unknown' },
    { id: 1, status: 'toString' },
    { status: 'completed' }
  ])('does not allocate work for an invalid action %#', async (note) => {
    const { model, api, onError } = fixture()
    expect(await model.execute(note)).toEqual({ status: 'cancelled', committed: false })
    expect(Object.values(api).every((method) => method.mock.calls.length === 0)).toBe(true)
    expect(model.transitions.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(onError).not.toHaveBeenCalled()
  })

  it.each(['rejected', 'empty'])(
    'shows %s failure for exactly 320ms, releases the lock and permits only an explicit retry',
    async (mode) => {
      const { model, api, onError, onCommit, onFinish } = fixture()
      const failure = new Error('SQL refused')
      if (mode === 'rejected') api.completeNote.mockRejectedValueOnce(failure)
      else api.completeNote.mockResolvedValueOnce(null)
      const note = { id: 1, status: 'in_progress' },
        request = model.execute(note)
      const result = await request
      expect(result).toMatchObject({ status: 'error', committed: false })
      expect(model.transitionFor(1).phase).toBe('error')
      expect(onError).toHaveBeenCalledWith(result.error, note, {
        from: 'in_progress',
        to: 'completed',
        committed: false
      })
      expect(model.execute(note)).toBe(request)
      await vi.advanceTimersByTimeAsync(319)
      expect(model.transitionFor(1).phase).toBe('error')
      await vi.advanceTimersByTimeAsync(1)
      expect(model.transitionFor(1)).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
      expect(api.completeNote).toHaveBeenCalledTimes(1)
      expect(onCommit).not.toHaveBeenCalled()
      expect(onFinish).not.toHaveBeenCalled()
      expect((await model.execute(note)).status).toBe('committed')
      expect(api.completeNote).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1000)
      expect(model.transitions.size).toBe(0)
    }
  )

  it.each(['resolve', 'reject'])(
    'settles disposal immediately and ignores a later SQL %s without new timers or effects',
    async (result) => {
      const { model, api, onCommit, onFinish, onError } = fixture(),
        response = deferred()
      api.completeNote.mockReturnValueOnce(response.promise)
      const request = model.execute({ id: 1, status: 'in_progress' })
      await vi.advanceTimersByTimeAsync(120)
      model.dispose()
      model.dispose()
      expect(await request).toEqual({ status: 'cancelled', committed: false })
      expect(model.transitions.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      if (result === 'resolve') response.resolve({ id: 1, status: 'completed' })
      else response.reject(new Error('late SQL failure'))
      await flush()
      await vi.runAllTimersAsync()
      expect(
        [onCommit, onFinish, onError].every((callback) => callback.mock.calls.length === 0)
      ).toBe(true)
      expect(api.completeNote).toHaveBeenCalledOnce()
      expect(await model.execute({ id: 1, status: 'in_progress' })).toEqual({
        status: 'cancelled',
        committed: false
      })
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('clears playing timers on disposal after SQL committed without undoing or replaying it', async () => {
    const { model, api, onCommit, onFinish, onError } = fixture()
    expect((await model.execute({ id: 1, status: 'completed' })).status).toBe('committed')
    await vi.advanceTimersByTimeAsync(124)
    model.dispose()
    await vi.runAllTimersAsync()
    expect(model.transitions.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(api.reopenNote).toHaveBeenCalledOnce()
    expect(
      [onCommit, onFinish, onError].every((callback) => callback.mock.calls.length === 0)
    ).toBe(true)
  })

  it.each(['throw', 'reject'])(
    'reconciles one committed SQL result after onCommit %s and never replays the command',
    async (mode) => {
      const failure = new Error('display patch failed')
      const onCommit = vi.fn(() => {
        if (mode === 'throw') throw failure
        return Promise.reject(failure)
      })
      const { model, api, onFinish, onError } = fixture({ onCommit })
      const note = { id: 1, status: 'completed' },
        result = await model.execute(note)
      await vi.advanceTimersByTimeAsync(125)
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure, note, {
        from: 'completed',
        to: 'in_progress',
        committed: true
      })
      expect(onFinish).toHaveBeenCalledExactlyOnceWith(result.updated, note, {
        from: 'completed',
        to: 'in_progress',
        reconcile: true
      })
      expect(model.transitions.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      await vi.runAllTimersAsync()
      expect(onFinish).toHaveBeenCalledOnce()
      expect(api.reopenNote).toHaveBeenCalledOnce()
    }
  )

  it.each(['resolve', 'reject'])(
    'waits for a pending commit callback before finishing once, including its late %s',
    async (outcome) => {
      const patch = deferred(),
        onCommit = vi.fn(() => patch.promise)
      const { model, api, onFinish, onError } = fixture({ onCommit })
      const note = { id: 1, status: 'in_progress' },
        result = await model.execute(note)
      await vi.advanceTimersByTimeAsync(1000)
      expect(onCommit).toHaveBeenCalledOnce()
      expect(onFinish).not.toHaveBeenCalled()
      expect(model.transitionFor(1)).toBeNull()
      expect(model.execute(note)).toBeDefined()
      expect(api.completeNote).toHaveBeenCalledOnce()
      const failure = new Error('slow patch failed')
      if (outcome === 'reject') patch.reject(failure)
      else patch.resolve()
      await flush()
      expect(onFinish).toHaveBeenCalledExactlyOnceWith(result.updated, note, {
        from: 'in_progress',
        to: 'completed',
        reconcile: outcome === 'reject'
      })
      expect(onError).toHaveBeenCalledTimes(outcome === 'reject' ? 1 : 0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('ignores a rejected commit continuation after disposal with no late feedback or refresh', async () => {
    const patch = deferred(),
      onCommit = vi.fn(() => patch.promise)
    const { model, onFinish, onError } = fixture({ onCommit })
    await model.execute({ id: 1, status: 'completed' })
    await vi.advanceTimersByTimeAsync(125)
    model.dispose()
    patch.reject(new Error('patch failed after disposal'))
    await flush()
    expect(onFinish).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['throw', 'reject'])(
    'reports onFinish %s once, releases ownership and does not repeat SQL or finish',
    async (mode) => {
      const failure = new Error('refresh failed'),
        onFinish = vi.fn(() => {
          if (mode === 'throw') throw failure
          return Promise.reject(failure)
        })
      const { model, api, onError } = fixture({ onFinish })
      const note = { id: 1, status: 'completed' }
      await model.execute(note)
      await vi.advanceTimersByTimeAsync(1000)
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure, note, {
        from: 'completed',
        to: 'in_progress',
        committed: true
      })
      expect(onFinish).toHaveBeenCalledOnce()
      expect(api.reopenNote).toHaveBeenCalledOnce()
      expect(model.transitions.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expect((await model.execute(note)).status).toBe('committed')
      expect(api.reopenNote).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['throw', 'reject'])(
    'bounds an onError %s and still releases the failed operation at 320ms',
    async (mode) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const onError = vi.fn(() => {
        if (mode === 'throw') throw new Error('feedback failed')
        return Promise.reject(new Error('feedback failed'))
      })
      const { model, api, onFinish } = fixture({ onError })
      api.completeNote.mockRejectedValueOnce(new Error('SQL refused'))
      expect((await model.execute({ id: 1, status: 'in_progress' })).status).toBe('error')
      await vi.advanceTimersByTimeAsync(320)
      expect(onError).toHaveBeenCalledOnce()
      expect(onFinish).not.toHaveBeenCalled()
      expect(model.transitions.size).toBe(0)
      expect(console.error).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('does not let an old feedback continuation release or alter a replacement same-ID operation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const feedback = deferred(),
      onError = vi.fn(() => feedback.promise)
    const { model, api, onCommit } = fixture({ onError })
    api.completeNote.mockRejectedValueOnce(new Error('old SQL failure'))
    const note = { id: 1, status: 'in_progress' }
    await model.execute(note)
    await vi.advanceTimersByTimeAsync(320)
    const next = deferred()
    api.completeNote.mockReturnValueOnce(next.promise)
    const request = model.execute(note)
    feedback.reject(new Error('old feedback failure'))
    await flush()
    expect(console.error).not.toHaveBeenCalled()
    expect(model.transitionFor(1).phase).toBe('acknowledging')
    expect(api.completeNote).toHaveBeenCalledTimes(2)
    next.resolve({ id: 1, status: 'completed' })
    await request
    await vi.advanceTimersByTimeAsync(1000)
    expect(onCommit).toHaveBeenCalledOnce()
    expect(model.transitions.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('captures the original note fields and releases the transition before the finish callback runs', async () => {
    const { model, onCommit, onFinish } = fixture()
    const note = { id: 1, status: 'initialized', effective_at: 'original time' }
    const request = model.execute(note)
    note.id = 2
    note.status = 'completed'
    note.effective_at = 'external change'
    await request
    onFinish.mockImplementation(() => {
      expect(model.transitionFor(1)).toBeNull()
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(onCommit.mock.calls[0][1]).toEqual({
      id: 1,
      status: 'initialized',
      effective_at: 'original time'
    })
    expect(onFinish).toHaveBeenCalledOnce()
    expect(model.transitions.size).toBe(0)
  })
})
