import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  createAttachmentRecoveryRetryController,
  registerAttachmentRecoveryRetryIpc
} from '../src/main/application/attachment-recovery-retry.js'
import { createBusinessMutationAdmission } from '../src/main/application/business-mutation-admission.js'
import { createShutdownCoordinator } from '../src/main/application/shutdown-coordinator.js'
import { createMainWindowIpc } from '../src/main/ipc/ipc-authorization.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture() {
  const business = createBusinessMutationAdmission()
  let draftOwner = null
  let disposed = false
  let current = true
  let allowed = true
  const source = { database: {}, profile: 'owned-profile', window: {} }
  const events = []
  const draftDrain = deferred()
  const recovery = deferred()
  const entered = deferred()
  const report = {
    phase: 'finished',
    partial: false,
    status: 'preservedConflict',
    operations: [{ operationId: 'retained', statuses: ['preservedConflict'] }]
  }
  const drafts = {
    sealAndDrain: vi.fn((owner) => {
      if (disposed || draftOwner !== null) throw new Error('draft owner unavailable')
      draftOwner = owner
      events.push('draft-sealed')
      return draftDrain.promise
    }),
    resume: vi.fn((owner) => {
      events.push('draft-resume')
      if (disposed || owner !== draftOwner) return false
      draftOwner = null
      return true
    })
  }
  const recover = vi.fn(() => {
    events.push('recover')
    entered.resolve()
    return recovery.promise
  })
  const getReport = vi.fn(() => {
    expect(draftOwner).not.toBeNull()
    expect(business.canAdmit()).toBe(false)
    events.push('snapshot')
    return report
  })
  const onError = vi.fn()
  const getSource = vi.fn(() => source)
  const canStart = vi.fn(() => allowed)
  const isSourceCurrent = vi.fn((candidate) => current && candidate === source)
  const exclusive = vi.fn(business.exclusive)
  const controller = createAttachmentRecoveryRetryController({
    businessAdmission: { exclusive },
    draftAssetsRuntime: drafts,
    getSource,
    isSourceCurrent,
    canStart,
    recover,
    getReport,
    onError
  })
  return {
    ...controller,
    business,
    drafts,
    draftDrain,
    recovery,
    entered,
    report,
    recover,
    getReport,
    onError,
    getSource,
    canStart,
    isSourceCurrent,
    exclusive,
    events,
    isDraftSealed: () => draftOwner !== null,
    expireSource: () => (current = false),
    stop: () => (allowed = false),
    disposeDrafts: () => (disposed = true)
  }
}

describe('controlled attachment recovery retry', () => {
  it('seals both gates synchronously, drains admitted continuations and snapshots before releasing', async () => {
    const f = fixture()
    const write = deferred(),
      cleanup = deferred()
    let continueWrite
    const mutation = f.business.run(async () => {
      continueWrite = f.business.bindContinuation(() => f.business.run(() => 'committed'))
      await write.promise
      f.business.run(() => cleanup.promise)
    })
    const retry = f.retry()
    expect(f.isDraftSealed()).toBe(true)
    expect(f.business.canAdmit()).toBe(false)
    expect(f.events).toEqual(['draft-sealed'])
    expect(() => f.business.run(() => 'late write')).toThrow('维护附件存储')
    expect(continueWrite()).toBe('committed')
    write.resolve()
    await mutation
    expect(f.recover).not.toHaveBeenCalled()
    cleanup.resolve()
    await cleanup.promise
    expect(f.recover).not.toHaveBeenCalled()
    f.draftDrain.resolve()
    await f.entered.promise
    expect(f.isSourceCurrent).toHaveBeenCalledWith(f.getSource.mock.results[0].value)
    expect(f.business.canAdmit()).toBe(false)
    expect(f.isDraftSealed()).toBe(true)
    f.recovery.resolve()
    const result = await retry
    expect(result).toEqual({ outcome: 'finished', report: f.report })
    expect(result.report).not.toBe(f.report)
    result.report.operations[0].statuses.push('caller-only')
    expect(f.report.operations[0].statuses).toEqual(['preservedConflict'])
    expect(f.events).toEqual(['draft-sealed', 'recover', 'snapshot', 'draft-resume'])
    expect(f.business.canAdmit()).toBe(true)
    expect(f.isDraftSealed()).toBe(false)
    expect(() => continueWrite()).toThrow('已经结束')
    await expect(f.retry()).resolves.toMatchObject({ outcome: 'finished' })
    expect(f.recover).toHaveBeenCalledTimes(2)
  })

  it('rejects a duplicate at the draft owner and keeps clear mutually exclusive', async () => {
    const f = fixture()
    const retry = f.retry()
    expect(() => f.retry()).toThrow('draft owner unavailable')
    await expect(f.business.clear(() => true)).rejects.toThrow('维护附件存储')
    expect(f.drafts.resume).not.toHaveBeenCalled()
    f.draftDrain.resolve()
    await f.entered.promise
    f.recovery.resolve()
    await retry
    expect(f.drafts.resume).toHaveBeenCalledTimes(1)
  })

  it('waits and observes draft drain when business acquisition fails, then releases only its owner', async () => {
    const f = fixture()
    const clearBody = deferred()
    const clearing = f.business.clear(() => clearBody.promise)
    let settled = false
    const retry = f.retry().catch((error) => {
      settled = true
      return error
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(f.isDraftSealed()).toBe(true)
    const draftError = new Error('draft drain rejected after business refused')
    f.draftDrain.reject(draftError)
    expect((await retry).message).toMatch(/清空便签/)
    expect(f.onError).toHaveBeenCalledWith(draftError)
    expect(f.drafts.resume).toHaveBeenCalledTimes(1)
    expect(f.isDraftSealed()).toBe(false)
    expect(f.recover).not.toHaveBeenCalled()
    expect(f.getReport).not.toHaveBeenCalled()
    expect(f.business.canAdmit()).toBe(false)
    clearBody.resolve()
    await clearing
    expect(f.business.canAdmit()).toBe(true)
  })

  it('does not acquire business admission when draft sealing throws', () => {
    const f = fixture()
    f.drafts.sealAndDrain.mockImplementation(() => {
      throw new Error('draft gate owned elsewhere')
    })
    expect(() => f.retry()).toThrow('draft gate owned elsewhere')
    expect(f.exclusive).not.toHaveBeenCalled()
    expect(f.drafts.resume).not.toHaveBeenCalled()
    expect(f.business.canAdmit()).toBe(true)
  })

  it.each(['source', 'shutdown'])(
    'rejects %s changes during drain before starting a new round',
    async (change) => {
      const f = fixture()
      const write = deferred()
      const mutation = f.business.run(() => write.promise)
      const retry = f.retry()
      const rejected = expect(retry).rejects.toMatchObject({
        code:
          change === 'source'
            ? 'ATTACHMENT_RECOVERY_SOURCE_CHANGED'
            : 'ATTACHMENT_RECOVERY_UNAVAILABLE'
      })
      if (change === 'source') f.expireSource()
      else {
        f.stop()
        f.business.preventNewMutations()
        f.disposeDrafts()
      }
      f.draftDrain.resolve()
      write.resolve()
      await mutation
      await rejected
      expect(f.recover).not.toHaveBeenCalled()
      expect(f.getReport).not.toHaveBeenCalled()
      expect(f.drafts.resume).toHaveBeenCalledTimes(1)
      expect(f.business.canAdmit()).toBe(change !== 'shutdown')
    }
  )

  it('rejects a failed admitted draft drain without starting recovery and releases both gates', async () => {
    const f = fixture()
    const retry = f.retry()
    const failure = new Error('admitted draft cleanup failed')
    const rejected = expect(retry).rejects.toBe(failure)
    f.draftDrain.reject(failure)
    await rejected
    expect(f.recover).not.toHaveBeenCalled()
    expect(f.getReport).not.toHaveBeenCalled()
    expect(f.business.canAdmit()).toBe(true)
    expect(f.isDraftSealed()).toBe(false)
  })

  it('preserves recovery failure and partial facts while reopening for a later explicit retry', async () => {
    const f = fixture()
    f.report.phase = 'failed'
    f.report.partial = true
    f.report.status = 'undetermined'
    const retry = f.retry()
    f.draftDrain.resolve()
    await f.entered.promise
    const failure = new Error('recovery readdir failed')
    f.recovery.reject(failure)
    await expect(retry).resolves.toEqual({ outcome: 'failed', report: f.report })
    expect(f.onError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(f.events.indexOf('snapshot')).toBeLessThan(f.events.indexOf('draft-resume'))
    expect(f.business.canAdmit()).toBe(true)
    expect(f.isDraftSealed()).toBe(false)
    f.recover.mockResolvedValueOnce(undefined)
    await expect(f.retry()).resolves.toMatchObject({ outcome: 'finished' })
  })

  it.each(['getReport', 'clone'])(
    'propagates and records %s failures without fabricating a report',
    async (kind) => {
      const f = fixture()
      const failure = new Error('report unavailable')
      if (kind === 'getReport')
        f.getReport.mockImplementation(() => {
          throw failure
        })
      else f.report.uncloneable = () => true
      const retry = f.retry()
      const rejected = expect(retry).rejects.toThrow(
        kind === 'getReport' ? 'report unavailable' : /clone|cloned/i
      )
      f.draftDrain.resolve()
      await f.entered.promise
      f.recovery.resolve()
      await rejected
      expect(f.onError).toHaveBeenCalledOnce()
      expect(f.business.canAdmit()).toBe(true)
      expect(f.isDraftSealed()).toBe(false)
    }
  )

  it('does not let a logging failure replace the recovery outcome', async () => {
    const f = fixture()
    f.onError.mockImplementation(() => {
      throw new Error('logger failed')
    })
    const retry = f.retry()
    f.draftDrain.resolve()
    await f.entered.promise
    f.recovery.reject(new Error('recovery failed'))
    await expect(retry).resolves.toMatchObject({ outcome: 'failed' })
  })

  it('shutdown drain retains an active recovery and disposed drafts cannot reopen admission', async () => {
    const f = fixture()
    const retry = f.retry()
    f.draftDrain.resolve()
    await f.entered.promise
    f.stop()
    f.business.preventNewMutations()
    f.disposeDrafts()
    const close = vi.fn()
    const drained = f.business.drain().then(close)
    await Promise.resolve()
    expect(close).not.toHaveBeenCalled()
    expect(() => f.retry()).toThrow('当前无法')
    f.recovery.resolve()
    await retry
    await drained
    expect(close).toHaveBeenCalledOnce()
    expect(f.drafts.resume.mock.results[0].value).toBe(false)
    expect(f.business.canAdmit()).toBe(false)
    expect(() => f.business.run(() => true)).toThrow('正在退出')
  })

  it('a cancelled quit confirmation does not dispose drafts or stop the accepted retry', async () => {
    const f = fixture()
    const app = new EventEmitter()
    app.quit = vi.fn()
    const confirm = deferred()
    const onBegin = vi.fn()
    const shutdown = createShutdownCoordinator({
      app,
      logger: { info: vi.fn(), error: vi.fn() },
      getWindow: () => ({ isDestroyed: () => false }),
      confirmDrafts: () => confirm.promise,
      onBegin,
      hasRemoteSession: () => false,
      stages: [{ name: 'business', enabled: () => true, run: f.business.drain }],
      cleanup: [],
      flushLogs: async () => {}
    })
    const retry = f.retry()
    app.emit('before-quit', { preventDefault: vi.fn() })
    confirm.resolve(false)
    f.draftDrain.resolve()
    await f.entered.promise
    expect(shutdown.snapshot().startedAt).toBeNull()
    expect(onBegin).not.toHaveBeenCalled()
    expect(f.drafts.resume).not.toHaveBeenCalled()
    f.recovery.resolve()
    await retry
    expect(f.drafts.resume.mock.results[0].value).toBe(true)
    expect(f.business.canAdmit()).toBe(true)
    expect(shutdown.snapshot().quitRequested).toBe(false)
    expect(shutdown.snapshot().checkingDrafts).toBe(false)
  })

  it('refuses unavailable requests before any source or admission work', () => {
    const f = fixture()
    f.stop()
    expect(() => f.retry()).toThrow('当前无法')
    expect(f.getSource).not.toHaveBeenCalled()
    expect(f.drafts.sealAndDrain).not.toHaveBeenCalled()
    expect(f.recover).not.toHaveBeenCalled()
  })
})

describe('attachment recovery retry IPC', () => {
  it('authorizes before retry, rejects every argument and disposes only its owned channel', async () => {
    const handlers = new Map([['unrelated', () => true]])
    const rawIpc = { handle: (channel, handler) => handlers.set(channel, handler) }
    let destroyed = false
    const window = { isDestroyed: () => destroyed, webContents: {} }
    const retry = vi.fn(async () => ({ outcome: 'finished', report: { phase: 'finished' } }))
    const removeHandler = vi.fn((channel) => handlers.delete(channel))
    const dispose = registerAttachmentRecoveryRetryIpc({
      mainWindowIpc: createMainWindowIpc(rawIpc, () => window, '附件恢复'),
      removeHandler,
      retry
    })
    const handler = handlers.get('attachments:recovery-retry')
    const event = { sender: window.webContents }
    expect(() => handler({ sender: {} })).toThrow('无权访问')
    for (const argument of [undefined, null, {}, 'path', false])
      expect(() => handler(event, argument)).toThrow('不接受参数')
    expect(retry).not.toHaveBeenCalled()
    await expect(handler(event)).resolves.toMatchObject({ outcome: 'finished' })
    expect(retry).toHaveBeenCalledExactlyOnceWith()
    destroyed = true
    expect(() => handler(event)).toThrow('无权访问')
    dispose()
    dispose()
    expect(removeHandler).toHaveBeenCalledExactlyOnceWith('attachments:recovery-retry')
    expect(handlers.has('unrelated')).toBe(true)
    expect(handlers.has('attachments:recovery-retry')).toBe(false)
    destroyed = false
    expect(() => handler(event)).toThrow('当前无法')
    expect(retry).toHaveBeenCalledOnce()
  })
})
