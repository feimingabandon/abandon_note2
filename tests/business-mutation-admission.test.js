import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createBusinessMutationAdmission } from '../src/main/application/business-mutation-admission.js'
import { createShutdownCoordinator } from '../src/main/application/shutdown-coordinator.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('business clear admission and complete mutation drain', () => {
  it('restricts final sticky cleanup to synchronous drained shutdown and revokes late continuations', async () => {
    const owner = createBusinessMutationAdmission(),
      pending = deferred()
    expect(() => owner.runCleanup(() => true)).toThrow('排空完成')
    const mutation = owner.run(() => pending.promise)
    owner.preventNewMutations()
    expect(() => owner.runCleanup(() => true)).toThrow('排空完成')
    const draining = owner.drain()
    pending.resolve()
    await mutation
    await draining
    let late
    expect(
      owner.runCleanup(() => {
        late = owner.bindContinuation(() => owner.run(() => 'late write'))
        return owner.run(() => 'final sticky bounds')
      })
    ).toBe('final sticky bounds')
    expect(() => late()).toThrow('已经结束')
    expect(() => owner.runCleanup(async () => true)).toThrow('只允许同步')
    expect(() => owner.runCleanup(() => Promise.resolve(true))).toThrow('只允许同步')
    expect(() => owner.run(() => true)).toThrow('正在退出')
  })

  it('keeps admitted IPC continuations live through clear, then revokes their scope', async () => {
    const owner = createBusinessMutationAdmission(),
      ready = deferred()
    let completeReady
    const created = owner.run(async () => {
      completeReady = owner.bindContinuation(() => owner.run(() => 'persisted'))
      await ready.promise
    })
    const body = vi.fn()
    const clearing = owner.clear(body)
    expect(completeReady()).toBe('persisted')
    expect(body).not.toHaveBeenCalled()
    ready.resolve()
    await created
    await clearing
    expect(body).toHaveBeenCalledOnce()
    expect(() => completeReady()).toThrow('已经结束')
  })

  it('shutdown drain waits for the complete clear without clear waiting on itself', async () => {
    for (const failure of [null, new Error('draft cleanup failed')]) {
      const owner = createBusinessMutationAdmission(),
        presentation = deferred(),
        entered = deferred()
      const clearing = owner.clear(async () => {
        entered.resolve()
        await presentation.promise
        if (failure) throw failure
        return 'cleared'
      })
      const outcome = clearing.catch((error) => error)
      await entered.promise
      owner.preventNewMutations()
      const closedDatabase = vi.fn()
      const draining = owner.drain().then(closedDatabase)
      await Promise.resolve()
      expect(closedDatabase).not.toHaveBeenCalled()
      presentation.resolve()
      expect(await outcome).toBe(failure || 'cleared')
      await draining
      expect(closedDatabase).toHaveBeenCalledOnce()
      expect(() => owner.run(() => true)).toThrow('正在退出')
      expect(owner.snapshot()).toEqual({ clearing: false, pending: 0 })
    }
  })

  it('a cancelled draft approval never seals admission or interferes with current clear', async () => {
    const owner = createBusinessMutationAdmission(),
      body = deferred()
    const app = new EventEmitter()
    app.quit = vi.fn()
    const onBegin = vi.fn(() => owner.preventNewMutations())
    const shutdown = createShutdownCoordinator({
      app,
      logger: { info: vi.fn(), error: vi.fn() },
      getWindow: () => ({ isDestroyed: () => false }),
      confirmDrafts: async () => false,
      isViewDraftCheckActive: () => false,
      onBegin,
      hasRemoteSession: () => false,
      stages: [{ name: 'business-writes', enabled: () => true, run: owner.drain }],
      cleanup: [],
      flushLogs: async () => {}
    })
    const clearing = owner.clear(() => body.promise)
    app.emit('before-quit', { preventDefault: vi.fn() })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(shutdown.snapshot().checkingDrafts).toBe(false)
    expect(onBegin).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
    await expect(owner.clear(() => true)).rejects.toThrow('重复操作')
    body.resolve()
    await clearing
    expect(owner.run(() => 'new note')).toBe('new note')
  })

  it('allows internal stages of admitted async commands after clear closes external admission', async () => {
    const owner = createBusinessMutationAdmission(),
      stage = deferred()
    const writes = []
    const mutation = owner.run(async () => {
      await stage.promise
      owner.run(() => writes.push('internal repository'))
      return writes.length
    })
    const clearing = owner.clear(() => {
      writes.length = 0
    })
    expect(() => owner.run(() => writes.push('external'))).toThrow('正在清空')
    stage.resolve()
    expect(await mutation).toBe(1)
    await clearing
    expect(writes).toEqual([])
  })

  it('drains children started by an admitted parent and seals new writes only after approved shutdown', async () => {
    const owner = createBusinessMutationAdmission(),
      stage = deferred(),
      child = deferred()
    const parent = owner.run(async () => {
      await stage.promise
      owner.run(() => child.promise)
    })
    const body = vi.fn()
    const clearing = owner.clear(body)
    stage.resolve()
    await parent
    expect(body).not.toHaveBeenCalled()
    child.resolve()
    await clearing
    expect(body).toHaveBeenCalledOnce()
    owner.preventNewMutations()
    expect(() => owner.run(() => true)).toThrow('正在退出')
    await owner.drain()
  })
  it('preserves sync results/errors without retaining pending writes', () => {
    const owner = createBusinessMutationAdmission()
    expect(owner.run(() => 42)).toBe(42)
    expect(() =>
      owner.run(() => {
        throw new Error('SQL failed')
      })
    ).toThrow('SQL failed')
    expect(owner.snapshot()).toEqual({ clearing: false, pending: 0 })
  })

  it('drains staged creation and postcommit cleanup before clear, then admits a new write', async () => {
    const owner = createBusinessMutationAdmission()
    const stage = deferred(),
      cleanup = deferred()
    const rows = []
    const create = owner.run(async () => {
      await stage.promise
      rows.push('old form')
      await cleanup.promise
    })
    const clearBody = vi.fn(() => {
      rows.length = 0
    })
    const clearing = owner.clear(clearBody)
    expect(owner.snapshot()).toEqual({ clearing: true, pending: 1 })
    expect(() => owner.run(() => rows.push('late form'))).toThrow('正在清空')
    stage.resolve()
    await Promise.resolve()
    expect(rows).toEqual(['old form'])
    expect(clearBody).not.toHaveBeenCalled()
    cleanup.resolve()
    await create
    await clearing
    expect(rows).toEqual([])
    owner.run(() => rows.push('new form'))
    expect(rows).toEqual(['new form'])
  })

  it('waits failed compensation and preserves the original mutation rejection', async () => {
    const owner = createBusinessMutationAdmission()
    const compensate = deferred()
    const failure = new Error('resource SQL failed')
    const mutation = owner.run(async () => {
      await compensate.promise
      throw failure
    })
    const caught = mutation.catch((error) => error)
    const clearBody = vi.fn()
    const clearing = owner.clear(clearBody)
    expect(clearBody).not.toHaveBeenCalled()
    compensate.resolve()
    expect(await caught).toBe(failure)
    await clearing
    expect(clearBody).toHaveBeenCalledOnce()
    expect(owner.snapshot().pending).toBe(0)
  })

  it('holds admission through presentation and reopens after SQL or committed-draft errors', async () => {
    for (const message of ['SQL clear failed', '业务数据已清空，但草稿清理失败']) {
      const owner = createBusinessMutationAdmission()
      const presentation = deferred()
      const clearing = owner.clear(async () => {
        await presentation.promise
        throw new Error(message)
      })
      await Promise.resolve()
      expect(() => owner.run(() => true)).toThrow('正在清空')
      await expect(owner.clear(() => true)).rejects.toThrow('重复操作')
      presentation.resolve()
      await expect(clearing).rejects.toThrow(message)
      expect(owner.run(() => 'retry')).toBe('retry')
    }
  })
})

describe('exclusive attachment maintenance admission', () => {
  it('seals synchronously while admitted continuations, child work and postcommit cleanup finish first', async () => {
    const owner = createBusinessMutationAdmission()
    const stage = deferred(),
      cleanup = deferred(),
      child = deferred(),
      maintenance = deferred()
    const entered = deferred()
    const events = []
    let continuation
    const mutation = owner.run(async () => {
      continuation = owner.bindContinuation(() => child.promise)
      await stage.promise
      owner.run(() => events.push('committed'))
      await cleanup.promise
      events.push('mutation cleanup')
    })
    const body = vi.fn(async () => {
      events.push('maintenance')
      entered.resolve()
      await maintenance.promise
      return 'maintenance complete'
    })
    const exclusive = owner.exclusive(body)
    const drained = vi.fn()
    const draining = owner.drain().then(drained)
    expect(owner.snapshot()).toEqual({ clearing: false, pending: 1 })
    expect(owner.canAdmit()).toBe(false)
    expect(() => owner.run(() => 'new external write')).toThrow('正在维护附件存储')
    const admittedChild = continuation()
    stage.resolve()
    await Promise.resolve()
    expect(events).toEqual(['committed'])
    expect(body).not.toHaveBeenCalled()
    cleanup.resolve()
    await mutation
    expect(body).not.toHaveBeenCalled()
    expect(() => continuation()).toThrow('已经结束')
    child.resolve()
    await admittedChild
    await entered.promise
    expect(events).toEqual(['committed', 'mutation cleanup', 'maintenance'])
    expect(owner.snapshot()).toEqual({ clearing: false, pending: 0 })
    expect(owner.canAdmit()).toBe(false)
    expect(drained).not.toHaveBeenCalled()
    maintenance.resolve()
    expect(await exclusive).toBe('maintenance complete')
    await draining
    expect(drained).toHaveBeenCalledOnce()
    expect(owner.canAdmit()).toBe(true)
    expect(owner.run(() => 'new write')).toBe('new write')
    expect(() => owner.runCleanup(() => true)).toThrow('排空完成')
  })

  it('waits for failed compensation without changing the mutation rejection', async () => {
    const owner = createBusinessMutationAdmission()
    const compensation = deferred()
    const failure = new Error('attachment SQL failed after staging')
    const mutation = owner.run(async () => {
      try {
        throw failure
      } finally {
        await compensation.promise
      }
    })
    const outcome = mutation.catch((error) => error)
    const body = vi.fn(() => 'recovered after compensation')
    const exclusive = owner.exclusive(body)
    expect(body).not.toHaveBeenCalled()
    expect(owner.canAdmit()).toBe(false)
    compensation.resolve()
    expect(await outcome).toBe(failure)
    expect(await exclusive).toBe('recovered after compensation')
    expect(body).toHaveBeenCalledOnce()
    expect(owner.snapshot()).toEqual({ clearing: false, pending: 0 })
    expect(owner.canAdmit()).toBe(true)
  })

  it('rejects exclusive admission synchronously and preserves asynchronous clear rejection and mutual exclusion', async () => {
    const owner = createBusinessMutationAdmission()
    const clearGate = deferred(),
      maintenanceGate = deferred()
    const rejectedBody = vi.fn()
    owner.run(() => {
      expect(() => owner.exclusive(rejectedBody)).toThrow('业务写入内部不能开始附件存储维护')
    })
    await expect(owner.run(() => owner.clear(rejectedBody))).rejects.toThrow(
      '业务写入内部不能清空便签数据'
    )
    const clearing = owner.clear(() => clearGate.promise)
    expect(owner.snapshot().clearing).toBe(true)
    expect(() => owner.exclusive(rejectedBody)).toThrow('正在清空便签数据，请完成后再试')
    let repeatedClear
    expect(() => {
      repeatedClear = owner.clear(rejectedBody)
    }).not.toThrow()
    await expect(repeatedClear).rejects.toThrow('正在清空便签数据，请勿重复操作')
    clearGate.resolve()
    await clearing
    const exclusive = owner.exclusive(() => maintenanceGate.promise)
    expect(owner.snapshot().clearing).toBe(false)
    expect(owner.canAdmit()).toBe(false)
    expect(() => owner.exclusive(rejectedBody)).toThrow('正在维护附件存储')
    let clearDuringMaintenance
    expect(() => {
      clearDuringMaintenance = owner.clear(rejectedBody)
    }).not.toThrow()
    await expect(clearDuringMaintenance).rejects.toThrow('正在维护附件存储')
    expect(rejectedBody).not.toHaveBeenCalled()
    maintenanceGate.resolve()
    await exclusive
    expect(owner.canAdmit()).toBe(true)
  })

  it.each(['throw', 'rejection'])('releases maintenance after callback %s', async (kind) => {
    const owner = createBusinessMutationAdmission()
    const failure = new Error(`maintenance ${kind}`)
    const exclusive = owner.exclusive(() => {
      if (kind === 'throw') throw failure
      return Promise.reject(failure)
    })
    expect(owner.canAdmit()).toBe(false)
    await expect(exclusive).rejects.toBe(failure)
    expect(owner.snapshot()).toEqual({ clearing: false, pending: 0 })
    expect(owner.canAdmit()).toBe(true)
    expect(owner.run(() => 'retry write')).toBe('retry write')
  })

  it('holds shutdown through the leading drain and complete maintenance, including failures, without reopening', async () => {
    for (const failure of [null, new Error('maintenance callback failed')]) {
      const owner = createBusinessMutationAdmission()
      const mutationGate = deferred(),
        maintenanceGate = deferred(),
        entered = deferred()
      const mutation = owner.run(() => mutationGate.promise)
      const exclusive = owner.exclusive(async () => {
        entered.resolve()
        await maintenanceGate.promise
        if (failure) throw failure
        return 'maintained'
      })
      const outcome = exclusive.catch((error) => error)
      owner.preventNewMutations()
      const finalCleanup = vi.fn(() => 'saved final sticky bounds')
      const draining = owner.drain().then(() => owner.runCleanup(finalCleanup))
      expect(() => owner.runCleanup(finalCleanup)).toThrow('排空完成')
      mutationGate.resolve()
      await mutation
      await entered.promise
      expect(finalCleanup).not.toHaveBeenCalled()
      expect(() => owner.runCleanup(finalCleanup)).toThrow('排空完成')
      maintenanceGate.resolve()
      expect(await outcome).toBe(failure || 'maintained')
      expect(await draining).toBe('saved final sticky bounds')
      expect(finalCleanup).toHaveBeenCalledOnce()
      expect(owner.snapshot()).toEqual({ clearing: false, pending: 0 })
      expect(owner.canAdmit()).toBe(false)
      expect(() => owner.run(() => 'late write')).toThrow('正在退出')
      expect(() => owner.exclusive(() => true)).toThrow('正在退出')
      let lateClear
      expect(() => {
        lateClear = owner.clear(() => true)
      }).not.toThrow()
      await expect(lateClear).rejects.toThrow('正在退出')
    }
  })
})
