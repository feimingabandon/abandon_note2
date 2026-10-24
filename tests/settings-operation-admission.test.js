import { describe, expect, it, vi } from 'vitest'
import { createSettingsOperationAdmission } from '../src/main/settings/settings-operation-admission.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('settings operation admission and complete-operation drain', () => {
  it('tracks an already admitted post-commit stage after sealing without reopening admission', async () => {
    const admission = createSettingsOperationAdmission()
    const outer = deferred()
    const stage = deferred()
    admission.run(() => outer.promise)
    const finished = vi.fn()
    const leaving = admission.sealAndDrain({}).then(finished)
    expect(admission.track(stage.promise)).toBe(stage.promise)
    outer.resolve()
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    expect(() => admission.run(() => null)).toThrow(/正在离开/)
    stage.resolve()
    await leaving
    expect(admission.snapshot().pending).toBe(0)
    expect(finished).toHaveBeenCalledOnce()
  })

  it('preserves synchronous invocation, result identity and the original thrown error', () => {
    const admission = createSettingsOperationAdmission()
    const value = { saved: true }
    const operation = vi.fn(() => value)
    const failure = new Error('SQLite write failed')
    expect(admission.run(operation)).toBe(value)
    expect(operation).toHaveBeenCalledOnce()
    expect(() =>
      admission.run(() => {
        throw failure
      })
    ).toThrow(failure)
    expect(admission.snapshot()).toEqual({ sealed: false, stopped: false, pending: 0 })
    expect(() => admission.assertOpen()).not.toThrow()
  })

  it('preserves the returned promise while sealing synchronously against new operations', async () => {
    const admission = createSettingsOperationAdmission()
    const operation = deferred()
    const owner = {}
    const lateWrite = vi.fn()
    expect(admission.run(() => operation.promise)).toBe(operation.promise)
    const finished = vi.fn()
    const leaving = admission.sealAndDrain(owner).then(finished)
    expect(admission.snapshot()).toEqual({ sealed: true, stopped: false, pending: 1 })
    expect(() => admission.assertOpen()).toThrow(
      expect.objectContaining({ code: 'SETTINGS_LEAVING' })
    )
    expect(() => admission.run(lateWrite)).toThrow(
      expect.objectContaining({ code: 'SETTINGS_LEAVING' })
    )
    expect(lateWrite).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    operation.resolve('persisted')
    await expect(operation.promise).resolves.toBe('persisted')
    await leaving
    expect(finished).toHaveBeenCalledOnce()
    expect(admission.snapshot()).toEqual({ sealed: true, stopped: false, pending: 0 })
    expect(admission.resume(owner)).toBe(true)
    expect(admission.run(() => 'next setting')).toBe('next setting')
  })

  it('waits for the full admitted rollback and preserves its original rejection', async () => {
    const admission = createSettingsOperationAdmission()
    const apply = deferred()
    const rollback = deferred()
    const failure = new Error('native application failed')
    const stages = []
    const operation = admission.run(async () => {
      await apply.promise
      stages.push('commit attempted')
      try {
        throw failure
      } catch (error) {
        await rollback.promise
        stages.push('rollback finished')
        throw error
      }
    })
    const caught = operation.catch((error) => error)
    const finished = vi.fn()
    const leaving = admission.sealAndDrain({}).then(finished)
    apply.resolve()
    await Promise.resolve()
    expect(stages).toEqual(['commit attempted'])
    expect(finished).not.toHaveBeenCalled()
    expect(admission.snapshot().pending).toBe(1)
    rollback.resolve()
    expect(await caught).toBe(failure)
    await leaving
    expect(stages).toEqual(['commit attempted', 'rollback finished'])
    expect(finished).toHaveBeenCalledOnce()
    expect(admission.snapshot().pending).toBe(0)
  })

  it('observes rejected results without producing an unhandled cleanup rejection', async () => {
    const admission = createSettingsOperationAdmission()
    const failed = deferred()
    const onUnhandled = vi.fn()
    process.on('unhandledRejection', onUnhandled)
    try {
      expect(admission.run(() => failed.promise)).toBe(failed.promise)
      failed.reject(new Error('settings failed'))
      await admission.drain()
      await new Promise((resolve) => setImmediate(resolve))
      expect(onUnhandled).not.toHaveBeenCalled()
      expect(admission.snapshot().pending).toBe(0)
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
    }
  })

  it('keeps one owner until that exact object resumes, including overlapping drain callers', async () => {
    const admission = createSettingsOperationAdmission()
    const operation = deferred()
    const owner = { id: 1 }
    const other = { id: 1 }
    admission.run(() => operation.promise)
    const first = admission.sealAndDrain(owner)
    const repeated = admission.sealAndDrain(owner)
    expect(() => admission.sealAndDrain(other)).toThrow(
      expect.objectContaining({ code: 'SETTINGS_LEAVING' })
    )
    expect(admission.resume(other)).toBe(false)
    expect(admission.resume(null)).toBe(false)
    expect(admission.snapshot().sealed).toBe(true)
    operation.resolve()
    await Promise.all([first, repeated])
    expect(admission.resume(other)).toBe(false)
    expect(admission.resume(owner)).toBe(true)
    expect(admission.resume(owner)).toBe(false)
    await admission.sealAndDrain(other)
    expect(admission.resume(owner)).toBe(false)
    expect(admission.resume(other)).toBe(true)
  })

  it.each([null, undefined, '', 'navigation', 1])(
    'rejects invalid owner %s without sealing',
    (owner) => {
      const admission = createSettingsOperationAdmission()
      expect(() => admission.sealAndDrain(owner)).toThrow(TypeError)
      expect(admission.snapshot()).toEqual({ sealed: false, stopped: false, pending: 0 })
    }
  )

  it('drains operations admitted while an open drain waits on its first snapshot', async () => {
    const admission = createSettingsOperationAdmission()
    const first = deferred()
    const second = deferred()
    admission.run(() => first.promise)
    const finished = vi.fn()
    const draining = admission.drain().then(finished)
    admission.run(() => second.promise)
    first.resolve()
    await first.promise
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    expect(admission.snapshot().pending).toBe(1)
    second.resolve()
    await draining
    expect(finished).toHaveBeenCalledOnce()
    expect(admission.snapshot().pending).toBe(0)
  })

  it('counts distinct admitted operations even when they return the same promise', async () => {
    const admission = createSettingsOperationAdmission()
    const shared = deferred()
    expect(admission.run(() => shared.promise)).toBe(shared.promise)
    expect(admission.run(() => shared.promise)).toBe(shared.promise)
    expect(admission.snapshot().pending).toBe(2)
    shared.resolve()
    await admission.drain()
    expect(admission.snapshot().pending).toBe(0)
  })

  it('waits a promise returned after a synchronous callback has already triggered sealing', async () => {
    const admission = createSettingsOperationAdmission()
    const operation = deferred()
    const finished = vi.fn()
    let leaving
    admission.run(() => {
      leaving = admission.sealAndDrain({}).then(finished)
      return operation.promise
    })
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    operation.resolve()
    await leaving
    expect(finished).toHaveBeenCalledOnce()
  })

  it('permanently stops new operations while already admitted internal stages finish', async () => {
    const admission = createSettingsOperationAdmission()
    const stage = deferred()
    const writes = []
    const owner = {}
    const operation = admission.run(async () => {
      await stage.promise
      writes.push('already admitted commit')
      return writes.length
    })
    const leaving = admission.sealAndDrain(owner)
    admission.stop()
    admission.stop()
    expect(admission.resume(owner)).toBe(false)
    expect(() => admission.run(() => writes.push('late write'))).toThrow(
      expect.objectContaining({ code: 'SETTINGS_LEAVING' })
    )
    stage.resolve()
    await expect(operation).resolves.toBe(1)
    await Promise.all([leaving, admission.drain()])
    expect(writes).toEqual(['already admitted commit'])
    expect(admission.snapshot()).toEqual({ sealed: true, stopped: true, pending: 0 })
    expect(() => admission.assertOpen()).toThrow(
      expect.objectContaining({ code: 'SETTINGS_LEAVING' })
    )
  })

  it('stops admission even without a leave owner and never resumes from that state', async () => {
    const admission = createSettingsOperationAdmission()
    admission.stop()
    expect(admission.resume({})).toBe(false)
    expect(() => admission.assertOpen()).toThrow(
      expect.objectContaining({ code: 'SETTINGS_LEAVING' })
    )
    await admission.drain()
    expect(admission.snapshot()).toEqual({ sealed: false, stopped: true, pending: 0 })
  })
})
