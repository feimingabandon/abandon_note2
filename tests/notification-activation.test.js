import { describe, expect, it, vi } from 'vitest'
import { createNotificationActivation } from '../src/main/services/notification-activation.js'

function fixture() {
  let window = null
  const open = vi.fn()
  const expand = vi.fn(async () => {})
  const logger = { info: vi.fn(), error: vi.fn() }
  const owner = createNotificationActivation({
    protocol: 'abandon-note',
    getWindow: () => window,
    exitCompactPresentation: expand,
    openMainWindow: open,
    logger,
    now: () => 12345
  })
  return {
    owner,
    open,
    expand,
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

describe('notification early activation owner', () => {
  it('validates protocols and drains at most 32 pre-ready round actions once', () => {
    const f = fixture(),
      action = vi.fn()
    expect(f.owner.handleProtocol('https://notification/custom?round=' + round)).toBe(false)
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
    expect(f.expand).toHaveBeenCalledWith({ source: 'notification', showWhenDone: true })
    expect(f.open).toHaveBeenCalledOnce()
  })

  it('opens the application after an expansion failure and guards late completion after disposal', async () => {
    const failed = fixture()
    failed.setWindow(liveWindow())
    failed.expand.mockRejectedValueOnce(new Error('presentation failed'))
    failed.owner.reveal()
    await turn()
    expect(failed.open).toHaveBeenCalledOnce()
    expect(failed.logger.error).toHaveBeenCalled()
    const late = fixture()
    late.setWindow(liveWindow())
    let release
    late.expand.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    late.owner.reveal()
    await Promise.resolve()
    late.owner.dispose()
    release()
    await turn()
    expect(late.open).not.toHaveBeenCalled()
    expect(late.owner.handleProtocol('abandon-note://notification/open')).toBe(false)
  })
})
