import { describe, expect, it, vi } from 'vitest'
import { settleCompactPresentation } from '../src/main/windows/compact-transition-settle.js'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('overlapping native motion and target presentation', () => {
  it('prepares the target during motion but never releases before motion ends', async () => {
    const native = deferred()
    const prepare = vi.fn(async () => ({ width: 200, height: 40 }))
    const released = vi.fn()
    const pending = settleCompactPresentation(native.promise, prepare).then(released)
    await Promise.resolve()
    await Promise.resolve()
    expect(prepare).toHaveBeenCalledOnce()
    expect(released).not.toHaveBeenCalled()
    native.resolve({ success: true })
    await pending
    expect(released).toHaveBeenCalledWith({ success: true })
  })

  it('keeps the shell when target composition is slower than native motion', async () => {
    const frame = deferred()
    const released = vi.fn()
    const pending = settleCompactPresentation(
      Promise.resolve({ success: true }),
      () => frame.promise
    ).then(released)
    await Promise.resolve()
    expect(released).not.toHaveBeenCalled()
    frame.resolve()
    await pending
    expect(released).toHaveBeenCalledOnce()
  })

  it('does not roll back geometry while native code still owns the window after a target failure', async () => {
    const native = deferred()
    const rollback = vi.fn()
    const error = new Error('capture failed')
    const pending = settleCompactPresentation(native.promise, () => {
      throw error
    }).catch(rollback)
    await Promise.resolve()
    await Promise.resolve()
    expect(rollback).not.toHaveBeenCalled()
    native.resolve({ success: true })
    await pending
    expect(rollback).toHaveBeenCalledWith(error)
  })
})
