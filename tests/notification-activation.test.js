import { describe, expect, it, vi } from 'vitest'
import { createNotificationActivation } from '../src/main/services/notification-activation.js'

function fixture(options = {}) {
  let window = null
  const open = vi.fn(() => true)
  const logger = { info: vi.fn(), error: vi.fn() }
  const owner = createNotificationActivation({
    protocol: 'abandon-note',
    getWindow: () => window,
    openMainWindow: open,
    logger,
    now: () => 12345,
    ...options
  })
  return {
    owner,
    open,
    logger,
    setWindow: (value) => {
      window = value
    }
  }
}
const liveWindow = (loading = false) => ({
  isDestroyed: () => false,
  isVisible: () => false,
  webContents: { isDestroyed: () => false, isLoadingMainFrame: () => loading }
})
const round = '12345678-1234-1234-1234-123456789abc'
const turn = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
const deferred = () => {
  let resolve, reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
const results = (f) =>
  f.logger.info.mock.calls
    .filter(([scope, , context]) => scope === 'notification.reveal' && context.result)
    .map(([, , context]) => context)

describe('notification early activation owner', () => {
  it('validates protocols and drains at most 32 pre-ready round actions once', () => {
    const f = fixture(),
      action = vi.fn()
    expect(f.owner.handleProtocol('https://notification/custom?round=' + round)).toBe(false)
    expect(f.owner.handleProtocol('abandon-note://another-host/open')).toBe(false)
    expect(
      f.owner.handleProtocol('abandon-note://notification/snooze?round=' + round + '&minutes=7')
    ).toBe(false)
    for (let i = 0; i < 35; i++)
      expect(f.owner.handleArgs(['app', 'abandon-note://notification/custom?round=' + round])).toBe(
        true
      )
    expect(f.owner.snapshot().pendingActions).toBe(32)
    f.owner.attachReminderAction(action)
    f.owner.attachReminderAction(action)
    expect(action).toHaveBeenCalledTimes(32)
    expect(action).toHaveBeenLastCalledWith({ id: round, action: 'custom' })
  })

  it('retains open intent through absent/loading windows and consumes the current context once', async () => {
    const f = fixture()
    expect(f.owner.handleProtocol('abandon-note://notification/open?id=99', 'cold-start')).toBe(
      true
    )
    expect(f.owner.snapshot().revealContext).toEqual({
      source: 'cold-start',
      hadLegacyNoteId: true,
      requestedAt: 12345
    })
    f.setWindow(liveWindow(true))
    expect(f.owner.settlePendingReveal()).toBe(false)
    f.setWindow(liveWindow())
    expect(f.owner.settlePendingReveal()).toBe(true)
    expect(f.owner.settlePendingReveal()).toBe(false)
    await turn()
    expect(f.open).toHaveBeenCalledOnce()
    expect(results(f)).toEqual([
      expect.objectContaining({ source: 'cold-start', hadLegacyNoteId: true, result: 'shown' })
    ])
  })

  it('does not log an accepted asynchronous open as shown until the full port succeeds', async () => {
    const f = fixture()
    const completion = deferred()
    f.setWindow(liveWindow())
    f.open.mockReturnValueOnce(completion.promise)
    f.owner.reveal({ source: 'async-open' })
    expect(f.open).not.toHaveBeenCalled()
    await turn()
    expect(f.open).toHaveBeenCalledOnce()
    expect(results(f)).toEqual([])
    expect(f.owner.settlePendingReveal()).toBe(false)
    completion.resolve(true)
    await turn()
    expect(results(f)).toEqual([expect.objectContaining({ source: 'async-open', result: 'shown' })])
  })

  it.each(['boolean', 'promise'])(
    'records an open cancellation from a %s false result',
    async (kind) => {
      const f = fixture()
      f.setWindow(liveWindow())
      f.open.mockReturnValueOnce(kind === 'boolean' ? false : Promise.resolve(false))
      f.owner.reveal()
      await turn()
      expect(f.open).toHaveBeenCalledOnce()
      expect(results(f)).toEqual([expect.objectContaining({ result: 'not-shown' })])
      expect(f.logger.error).not.toHaveBeenCalled()
      expect(f.owner.snapshot().pendingReveal).toBe(false)
    }
  )

  it.each(['throw', 'reject'])(
    'records a full open %s without attempting a second open',
    async (kind) => {
      const f = fixture()
      const failure = new Error('complete open failed')
      f.setWindow(liveWindow())
      if (kind === 'throw')
        f.open.mockImplementationOnce(() => {
          throw failure
        })
      else f.open.mockRejectedValueOnce(failure)
      f.owner.reveal({ source: 'failed-open', hadLegacyNoteId: true })
      await turn()
      expect(f.open).toHaveBeenCalledOnce()
      expect(f.logger.error).toHaveBeenCalledExactlyOnceWith(
        'notification.reveal',
        failure,
        expect.objectContaining({ source: 'failed-open', hadLegacyNoteId: true, result: 'failed' })
      )
      expect(results(f)).toEqual([])
      expect(f.owner.settlePendingReveal()).toBe(false)
    }
  )

  it('uses the injected business-ready gate even when a nonessential load tail remains held', async () => {
    let ready = false
    const canRequestOpen = vi.fn(() => ready)
    const f = fixture({ canRequestOpen })
    const window = liveWindow(false)
    f.setWindow(window)
    f.owner.reveal()
    await turn()
    expect(f.open).not.toHaveBeenCalled()
    expect(f.owner.snapshot().pendingReveal).toBe(true)
    window.webContents.isLoadingMainFrame = () => true
    ready = true
    expect(f.owner.settlePendingReveal()).toBe(true)
    expect(f.owner.settlePendingReveal()).toBe(false)
    await turn()
    expect(canRequestOpen).toHaveBeenCalledWith(window)
    expect(f.open).toHaveBeenCalledOnce()
    expect(results(f)).toEqual([expect.objectContaining({ result: 'shown', loading: true })])
  })

  it('can delegate a still-loading first startup to the injected startup owner gate', async () => {
    const f = fixture({ canRequestOpen: () => true })
    f.setWindow(liveWindow(true))
    f.owner.reveal({ source: 'startup-notification' })
    await turn()
    expect(f.open).toHaveBeenCalledOnce()
    expect(results(f)).toEqual([
      expect.objectContaining({ source: 'startup-notification', result: 'shown' })
    ])
  })

  it('retains a pending reveal when the window or its contents is absent or destroyed', async () => {
    const f = fixture({ canRequestOpen: () => true })
    f.owner.reveal()
    expect(f.owner.settlePendingReveal()).toBe(false)
    f.setWindow({ ...liveWindow(), isDestroyed: () => true })
    expect(f.owner.settlePendingReveal()).toBe(false)
    const destroyedContents = liveWindow()
    destroyedContents.webContents.isDestroyed = () => true
    f.setWindow(destroyedContents)
    expect(f.owner.settlePendingReveal()).toBe(false)
    await turn()
    expect(f.open).not.toHaveBeenCalled()
    expect(f.owner.snapshot().pendingReveal).toBe(true)
    f.setWindow(liveWindow())
    expect(f.owner.settlePendingReveal()).toBe(true)
    await turn()
    expect(f.open).toHaveBeenCalledOnce()
  })

  it('keeps only the newest pending context while no window exists', async () => {
    const f = fixture()
    f.owner.reveal({ source: 'old', hadLegacyNoteId: true })
    f.owner.reveal({ source: 'new', hadLegacyNoteId: false })
    f.setWindow(liveWindow())
    f.owner.settlePendingReveal()
    await turn()
    expect(f.open).toHaveBeenCalledOnce()
    expect(results(f)).toEqual([
      expect.objectContaining({ source: 'new', hadLegacyNoteId: false, result: 'shown' })
    ])
  })

  it.each(['cancel', 'dispose', 'replacement'])(
    'does not dispatch an old reveal after synchronous %s',
    async (change) => {
      const f = fixture()
      f.setWindow(liveWindow())
      f.owner.reveal()
      if (change === 'cancel') f.owner.cancelPendingReveal('user-hide')
      if (change === 'dispose') f.owner.dispose()
      if (change === 'replacement') f.setWindow(liveWindow())
      await turn()
      expect(f.open).not.toHaveBeenCalled()
      expect(results(f)).toEqual([])
    }
  )

  it.each(['cancel', 'dispose', 'replacement', 'window-destroyed', 'contents-destroyed'])(
    'ignores late completion after %s without issuing another open',
    async (change) => {
      const f = fixture()
      const completion = deferred()
      const window = liveWindow()
      f.setWindow(window)
      f.open.mockReturnValueOnce(completion.promise)
      f.owner.reveal({ source: 'old' })
      await turn()
      expect(f.open).toHaveBeenCalledOnce()
      if (change === 'cancel') f.owner.cancelPendingReveal('user-hide')
      if (change === 'dispose') f.owner.dispose()
      if (change === 'replacement') f.setWindow(liveWindow())
      if (change === 'window-destroyed') window.isDestroyed = () => true
      if (change === 'contents-destroyed') window.webContents.isDestroyed = () => true
      completion.resolve(true)
      await turn()
      expect(f.open).toHaveBeenCalledOnce()
      expect(results(f)).toEqual([])
      expect(f.logger.error).not.toHaveBeenCalled()
      expect(f.owner.cancelPendingReveal('after-settlement')).toBe(false)
      if (change === 'dispose')
        expect(f.owner.handleProtocol('abandon-note://notification/open')).toBe(false)
    }
  )

  it.each(['resolve', 'reject'])(
    'does not publish an old %s after a newer reveal owns completion',
    async (outcome) => {
      const f = fixture()
      const first = deferred()
      f.setWindow(liveWindow())
      f.open.mockReturnValueOnce(first.promise)
      f.owner.reveal({ source: 'old' })
      await turn()
      f.owner.reveal({ source: 'new' })
      await turn()
      expect(f.open).toHaveBeenCalledTimes(2)
      if (outcome === 'resolve') first.resolve(true)
      else first.reject(new Error('old completion rejected'))
      await turn()
      expect(results(f)).toEqual([expect.objectContaining({ source: 'new', result: 'shown' })])
      expect(f.logger.error).not.toHaveBeenCalled()
    }
  )

  it('cancels pending and in-flight completion ownership without cancelling queued reminder actions', async () => {
    const f = fixture()
    f.owner.handleProtocol('abandon-note://notification/custom?round=' + round)
    f.owner.reveal({ source: 'before-window' })
    expect(f.owner.cancelPendingReveal('user-hide')).toBe(true)
    expect(f.owner.cancelPendingReveal('user-hide')).toBe(false)
    expect(f.owner.snapshot()).toMatchObject({ pendingReveal: false, pendingActions: 1 })
    const first = deferred()
    f.setWindow(liveWindow())
    f.open.mockReturnValueOnce(first.promise)
    f.owner.reveal({ source: 'in-flight' })
    await turn()
    expect(f.owner.cancelPendingReveal('user-hide')).toBe(true)
    first.resolve(true)
    await turn()
    expect(results(f)).toEqual([])
    f.owner.reveal({ source: 'explicit-new-intent' })
    await turn()
    expect(f.open).toHaveBeenCalledTimes(2)
    expect(results(f)).toEqual([
      expect.objectContaining({ source: 'explicit-new-intent', result: 'shown' })
    ])
    const action = vi.fn()
    f.owner.attachReminderAction(action)
    expect(action).toHaveBeenCalledExactlyOnceWith({ id: round, action: 'custom' })
    expect(f.logger.info).toHaveBeenCalledWith(
      'notification.reveal-cancel',
      expect.any(String),
      expect.objectContaining({ reason: 'user-hide' })
    )
  })

  it('rechecks window and intent ownership after the injected readiness gate', async () => {
    let cancel
    const f = fixture({
      canRequestOpen: () => {
        cancel()
        return true
      }
    })
    f.setWindow(liveWindow())
    cancel = () => f.owner.cancelPendingReveal('gate-user-hide')
    f.owner.reveal()
    await turn()
    expect(f.open).not.toHaveBeenCalled()
    expect(f.owner.snapshot().pendingReveal).toBe(false)
  })

  it('keeps pending intent observable when a readiness gate throws', async () => {
    const failure = new Error('readiness unavailable')
    const gate = vi.fn(() => {
      throw failure
    })
    const f = fixture({ canRequestOpen: gate })
    f.setWindow(liveWindow())
    expect(f.owner.reveal()).toBe(true)
    await turn()
    expect(f.open).not.toHaveBeenCalled()
    expect(f.owner.snapshot().pendingReveal).toBe(true)
    expect(f.logger.error).toHaveBeenCalledWith(
      'notification.reveal-gate',
      failure,
      expect.objectContaining({ source: 'notification-click' })
    )
    gate.mockReturnValue(true)
    f.owner.settlePendingReveal()
    await turn()
    expect(f.open).toHaveBeenCalledOnce()
  })

  it('disposes protocol actions and reveal ownership once', () => {
    const f = fixture()
    f.owner.handleProtocol('abandon-note://notification/custom?round=' + round)
    f.owner.reveal()
    f.owner.dispose()
    f.owner.dispose()
    expect(f.owner.snapshot()).toEqual({
      disposed: true,
      pendingReveal: false,
      pendingActions: 0,
      revealContext: null
    })
    expect(f.owner.attachReminderAction(vi.fn())).toBe(false)
    expect(f.owner.reveal()).toBe(false)
    expect(f.owner.cancelPendingReveal('late-hide')).toBe(false)
  })

  it('keeps display and hide cancellation independent from a failing diagnostic sink', async () => {
    const f = fixture({
      logger: {
        info: () => {
          throw new Error('info unavailable')
        },
        error: () => {
          throw new Error('error unavailable')
        }
      }
    })
    const opening = deferred()
    f.setWindow(liveWindow())
    f.open.mockReturnValueOnce(opening.promise)
    expect(f.owner.reveal()).toBe(true)
    await turn()
    expect(f.open).toHaveBeenCalledOnce()
    expect(f.owner.cancelPendingReveal('user-hide')).toBe(true)
    opening.reject(new Error('cancelled completion failed'))
    await turn()
    expect(f.owner.reveal()).toBe(true)
    await turn()
    expect(f.open).toHaveBeenCalledTimes(2)
    expect(f.owner.cancelPendingReveal('already-complete')).toBe(false)
  })
})
