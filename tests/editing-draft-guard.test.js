import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditingDraftGuard } from '../src/main/windows/editing-draft-guard.js'

function fixture() {
  const window = new EventEmitter()
  const contents = new EventEmitter()
  window.webContents = contents
  window.isDestroyed = () => false
  contents.isDestroyed = () => false
  contents.isCrashed = () => false
  contents.send = vi.fn()
  let answer
  const state = { dirty: true, blocked: false }
  const prepare = vi.fn(async () => ({ ready: true }))
  const cancelPageLeave = vi.fn()
  const frame = { isDestroyed: () => false, detached: false }
  contents.mainFrame = frame
  contents.executeJavaScript = vi.fn(() => {
    throw new Error('Draft guard must execute in its captured main frame')
  })
  frame.executeJavaScript = vi.fn(async (code) => {
    if (code.includes('__preparePageLeave')) return prepare()
    if (code.includes('__cancelPageLeave')) return cancelPageLeave(code)
    if (code.includes('__prepareEditingDrafts')) return { ...state }
    if (code.includes('__cancelEditingDraftConfirmation')) {
      answer?.(false)
      return
    }
    return new Promise((resolve) => {
      answer = resolve
    })
  })
  const guard = createEditingDraftGuard({ logger: { error: vi.fn() } })
  return {
    window,
    contents,
    frame,
    state,
    guard,
    prepare,
    cancelPageLeave,
    confirmationCount: () =>
      frame.executeJavaScript.mock.calls.filter(([code]) =>
        code.includes('__confirmEditingDrafts(')
      ).length,
    respond: (accepted) => answer(accepted)
  }
}

afterEach(() => vi.useRealTimers())

describe('application draft confirmation lifecycle', () => {
  it('gives native reveal the original document authority and revokes it on a same-wrapper commit', async () => {
    const f = fixture()
    const revealStates = []
    let afterInvalidation = 0
    const guard = createEditingDraftGuard({
      logger: { error: vi.fn() },
      reveal: async (window, canContinue) => {
        expect(window).toBe(f.window)
        revealStates.push(canContinue())
        f.contents.emit('did-navigate', {}, 'file:///new-document.html')
        expect(f.contents.mainFrame).toBe(f.frame)
        revealStates.push(canContinue())
        if (canContinue()) afterInvalidation++
      }
    })
    expect(await guard(f.window, '退出')).toBe(false)
    expect(revealStates).toEqual([true, false])
    expect(afterInvalidation).toBe(0)
    expect(f.confirmationCount()).toBe(0)
    expect(f.contents.listenerCount('did-navigate')).toBe(0)
    expect(f.cancelPageLeave).not.toHaveBeenCalled()
  })
  it('runs prepare, inspection, confirmation, recheck and resume in one captured frame while contents loading is held', async () => {
    const f = fixture()
    f.contents.executeJavaScript.mockImplementation(() => new Promise(() => {}))
    const leaving = f.guard(f.window, '切换视图')
    await vi.waitFor(() => expect(f.confirmationCount()).toBe(1))
    f.respond(true)
    expect(await leaving).toBe(true)
    f.guard.resume(f.window)
    const calls = f.frame.executeJavaScript.mock.calls.map(([code]) => code)
    expect(calls[0]).toContain('__preparePageLeave')
    expect(calls[1]).toContain('__prepareEditingDrafts')
    expect(calls[2]).toContain('__confirmEditingDrafts(')
    expect(calls[3]).toContain('__prepareEditingDrafts')
    expect(calls[4]).toContain('recheck: true')
    expect(calls[5]).toContain('__cancelPageLeave')
    expect(f.prepare).toHaveBeenCalledTimes(2)
    expect(f.cancelPageLeave).toHaveBeenCalledOnce()
    expect(f.contents.executeJavaScript).not.toHaveBeenCalled()
    expect(f.contents.listenerCount('did-navigate')).toBe(0)
  })

  it.each(['did-navigate', 'render-process-gone', 'destroyed', 'closed'])(
    'invalidates a held successful document on %s without releasing its main settings owner early',
    async (event) => {
      const f = fixture()
      f.state.dirty = false
      const owner = {}
      const prepareSettingsOperations = vi.fn()
      const resumeSettingsOperations = vi.fn()
      const guard = createEditingDraftGuard({
        logger: { error: vi.fn() },
        prepareSettingsOperations,
        resumeSettingsOperations
      })
      expect(await guard(f.window, '切换视图', { owner })).toBe(true)
      const preparation = prepareSettingsOperations.mock.calls[0][0]
      expect(preparation.frame).toBe(f.frame)
      const callCount = f.frame.executeJavaScript.mock.calls.length
      // Deliberately reuse the same frame wrapper: its document epoch changed.
      if (event === 'closed') f.window.emit(event)
      else f.contents.emit(event)
      expect(resumeSettingsOperations).not.toHaveBeenCalled()
      expect(await guard(f.window, '退出', { owner: {} })).toBe(false)
      guard.resume(f.window, owner)
      expect(resumeSettingsOperations).toHaveBeenCalledExactlyOnceWith(preparation)
      expect(f.frame.executeJavaScript).toHaveBeenCalledTimes(callCount)
      expect(f.cancelPageLeave).not.toHaveBeenCalled()
      expect(f.contents.executeJavaScript).not.toHaveBeenCalled()
      expect(f.contents.listenerCount('did-navigate')).toBe(0)
      expect(f.contents.listenerCount('render-process-gone')).toBe(0)
      expect(f.contents.listenerCount('destroyed')).toBe(0)
      expect(f.window.listenerCount('closed')).toBe(0)
      guard.resume(f.window, owner)
      expect(resumeSettingsOperations).toHaveBeenCalledOnce()
    }
  )

  it('retains a successful main settings seal across a navigation request that never commits', async () => {
    const f = fixture()
    f.state.dirty = false
    const owner = {}
    const resumeSettingsOperations = vi.fn()
    const guard = createEditingDraftGuard({
      logger: { error: vi.fn() },
      resumeSettingsOperations
    })
    expect(await guard(f.window, '切换视图', { owner })).toBe(true)
    f.contents.emit('did-start-navigation', {}, 'blocked-target', false, true)
    expect(resumeSettingsOperations).not.toHaveBeenCalled()
    expect(f.cancelPageLeave).not.toHaveBeenCalled()
    guard.resume(f.window, owner)
    expect(resumeSettingsOperations).toHaveBeenCalledOnce()
    expect(f.cancelPageLeave).toHaveBeenCalledOnce()
    expect(f.contents.executeJavaScript).not.toHaveBeenCalled()
    expect(await guard(f.window, '退出', { owner })).toBe(true)
    guard.resume(f.window, owner)
    expect(f.cancelPageLeave).toHaveBeenCalledTimes(2)
  })

  it('cancels in-progress navigation through its captured frame and permits retry when navigation is prevented', async () => {
    const f = fixture()
    const leaving = f.guard(f.window, '切换视图')
    await vi.waitFor(() => expect(f.confirmationCount()).toBe(1))
    f.contents.emit('did-start-navigation', {}, 'blocked-target', false, true)
    expect(await leaving).toBe(false)
    expect(f.frame.executeJavaScript).toHaveBeenCalledWith(
      'window.__cancelEditingDraftConfirmation?.()'
    )
    expect(f.cancelPageLeave).toHaveBeenCalledOnce()
    expect(f.contents.executeJavaScript).not.toHaveBeenCalled()
    f.state.dirty = false
    expect(await f.guard(f.window, '切换视图')).toBe(true)
    f.guard.resume(f.window)
    expect(f.cancelPageLeave).toHaveBeenCalledTimes(2)
  })

  it('never retargets a late preparation to a replacement frame', async () => {
    const f = fixture()
    f.state.dirty = false
    let finish
    f.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const leaving = f.guard(f.window, '切换视图')
    const replacement = { isDestroyed: () => false, executeJavaScript: vi.fn() }
    f.contents.mainFrame = replacement
    finish({ ready: true })
    expect(await leaving).toBe(false)
    expect(f.frame.executeJavaScript).toHaveBeenCalledOnce()
    expect(replacement.executeJavaScript).not.toHaveBeenCalled()
    expect(f.cancelPageLeave).not.toHaveBeenCalled()
    expect(f.contents.executeJavaScript).not.toHaveBeenCalled()
    expect(f.contents.listenerCount('did-navigate')).toBe(0)
  })

  it('does not send held resume into a replacement frame without a navigation event', async () => {
    const f = fixture()
    f.state.dirty = false
    const resumeSettingsOperations = vi.fn()
    const guard = createEditingDraftGuard({
      logger: { error: vi.fn() },
      resumeSettingsOperations
    })
    expect(await guard(f.window, '切换视图')).toBe(true)
    const callCount = f.frame.executeJavaScript.mock.calls.length
    const replacement = { isDestroyed: () => false, executeJavaScript: vi.fn() }
    f.contents.mainFrame = replacement
    guard.resume(f.window)
    expect(resumeSettingsOperations).toHaveBeenCalledOnce()
    expect(f.frame.executeJavaScript).toHaveBeenCalledTimes(callCount)
    expect(replacement.executeJavaScript).not.toHaveBeenCalled()
    expect(f.contents.executeJavaScript).not.toHaveBeenCalled()
  })

  it.each(['missing', 'destroyed', 'detached'])(
    'refuses a %s frame without falling back to WebContents execution',
    async (state) => {
      const f = fixture()
      if (state === 'missing') f.contents.mainFrame = null
      else if (state === 'destroyed') f.frame.isDestroyed = () => true
      else f.frame.detached = true
      expect(await f.guard(f.window, '退出')).toBe(false)
      expect(f.frame.executeJavaScript).not.toHaveBeenCalled()
      expect(f.contents.executeJavaScript).not.toHaveBeenCalled()
      expect(f.contents.listenerCount('did-navigate')).toBe(0)
    }
  )

  it('keeps document observation during a reentrant local owner release', async () => {
    const f = fixture()
    f.state.dirty = false
    const resumeSettingsOperations = vi.fn(() => f.contents.emit('did-navigate'))
    const guard = createEditingDraftGuard({
      logger: { error: vi.fn() },
      resumeSettingsOperations
    })
    expect(await guard(f.window, '切换视图')).toBe(true)
    const callCount = f.frame.executeJavaScript.mock.calls.length
    guard.resume(f.window)
    expect(resumeSettingsOperations).toHaveBeenCalledOnce()
    expect(f.frame.executeJavaScript).toHaveBeenCalledTimes(callCount)
    expect(f.cancelPageLeave).not.toHaveBeenCalled()
    expect(f.contents.listenerCount('did-navigate')).toBe(0)
  })

  it.each([
    ['settings', 10_000, '设置离开准备超时'],
    ['main-settings', 10_000, '主进程设置操作尚未结束'],
    ['drafts', 3_000, '草稿检查超时']
  ])('keeps the original %s deadline at %i ms', async (phase, deadline, message) => {
    vi.useFakeTimers()
    const f = fixture()
    f.state.dirty = false
    const logger = { error: vi.fn() }
    const held = new Promise(() => {})
    if (phase === 'settings') f.prepare.mockReturnValueOnce(held)
    else if (phase === 'drafts') {
      const execute = f.frame.executeJavaScript.getMockImplementation()
      f.frame.executeJavaScript.mockImplementation((code) =>
        code.includes('__prepareEditingDrafts') ? held : execute(code)
      )
    }
    const guard = createEditingDraftGuard({
      logger,
      ...(phase === 'main-settings' ? { prepareSettingsOperations: () => held } : {})
    })
    let settled = false
    const leaving = guard(f.window, '切换视图').then((result) => {
      settled = true
      return result
    })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(deadline - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await leaving).toBe(false)
    expect(logger.error).toHaveBeenCalledWith(
      'editing-draft.guard',
      expect.objectContaining({ message })
    )
    expect(f.cancelPageLeave).toHaveBeenCalledOnce()
    expect(f.contents.executeJavaScript).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves user confirmation unbounded but cancels it immediately on hide', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let settled = false
    const leaving = f.guard(f.window, '退出').then((result) => {
      settled = true
      return result
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.confirmationCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(10_001)
    expect(settled).toBe(false)
    f.window.emit('hide')
    expect(await leaving).toBe(false)
    expect(f.cancelPageLeave).toHaveBeenCalledOnce()
    expect(f.contents.executeJavaScript).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('seals and drains main settings after renderer flush, before draft negotiation', async () => {
    const f = fixture()
    f.state.dirty = false
    let finish
    const prepareSettingsOperations = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const resumeSettingsOperations = vi.fn()
    const guard = createEditingDraftGuard({
      logger: { error: vi.fn() },
      prepareSettingsOperations,
      resumeSettingsOperations
    })
    const leaving = guard(f.window, '退出')
    await vi.waitFor(() => expect(prepareSettingsOperations).toHaveBeenCalledOnce())
    expect(f.prepare).toHaveBeenCalledOnce()
    expect(
      f.frame.executeJavaScript.mock.calls.some(([code]) => code.includes('__prepareEditingDrafts'))
    ).toBe(false)
    finish()
    expect(await leaving).toBe(true)
    expect(f.prepare).toHaveBeenCalledTimes(2)
    expect(resumeSettingsOperations).not.toHaveBeenCalled()
    guard.resume(f.window)
    expect(resumeSettingsOperations).toHaveBeenCalledExactlyOnceWith(
      prepareSettingsOperations.mock.calls[0][0]
    )
  })

  it('releases the matching main seal on hide while an admitted setting is still completing', async () => {
    const f = fixture()
    let finish
    const prepareSettingsOperations = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const resumeSettingsOperations = vi.fn()
    const guard = createEditingDraftGuard({
      logger: { error: vi.fn() },
      prepareSettingsOperations,
      resumeSettingsOperations
    })
    const leaving = guard(f.window, '切换视图')
    await vi.waitFor(() => expect(prepareSettingsOperations).toHaveBeenCalledOnce())
    f.window.emit('hide')
    expect(await leaving).toBe(false)
    expect(resumeSettingsOperations).toHaveBeenCalledExactlyOnceWith(
      prepareSettingsOperations.mock.calls[0][0]
    )
    finish()
    await Promise.resolve()
    expect(f.confirmationCount()).toBe(0)
  })
  it.each(['hide', 'closed', 'render-process-gone', 'navigation'])(
    'releases a pending request on %s',
    async (event) => {
      const f = fixture()
      const pending = f.guard(f.window, '切换视图')
      await vi.waitFor(() => expect(f.confirmationCount()).toBe(1))
      expect(f.guard(f.window, '退出')).toBe(pending)
      if (event === 'navigation') f.contents.emit('did-start-navigation', {}, '', false, true)
      else if (event === 'render-process-gone') f.contents.emit(event)
      else f.window.emit(event)
      expect(await pending).toBe(false)
      expect(f.window.listenerCount('hide')).toBe(0)
      expect(f.contents.listenerCount('did-start-navigation')).toBe(0)
      f.state.dirty = false
      expect(await f.guard(f.window, '切换视图')).toBe(true)
    }
  )
  it('checks persistence again after confirmation and releases cancellation for another attempt', async () => {
    const f = fixture()
    const first = f.guard(f.window, '切换视图')
    await vi.waitFor(() => expect(f.confirmationCount()).toBe(1))
    f.respond(false)
    expect(await first).toBe(false)
    const second = f.guard(f.window, '切换视图')
    await vi.waitFor(() => expect(f.confirmationCount()).toBe(2))
    f.state.blocked = true
    f.respond(true)
    expect(await second).toBe(false)
    expect(f.contents.send).toHaveBeenCalledWith(
      'app:message',
      expect.objectContaining({ type: 'warning' })
    )
  })

  it('waits for settings before reading drafts and holds successful preparation until navigation releases it', async () => {
    const f = fixture()
    let finish
    f.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    f.state.dirty = false
    const leaving = f.guard(f.window, '切换视图')
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce())
    expect(
      f.frame.executeJavaScript.mock.calls.some(([code]) => code.includes('__prepareEditingDrafts'))
    ).toBe(false)
    finish({ ready: true })
    expect(await leaving).toBe(true)
    expect(f.cancelPageLeave).not.toHaveBeenCalled()
    await f.guard.resume(f.window)
    expect(f.cancelPageLeave).toHaveBeenCalledOnce()
    await f.guard.resume(f.window)
    expect(f.cancelPageLeave).toHaveBeenCalledOnce()
  })

  it('restores settings after preparation failure and lets the same page retry', async () => {
    const f = fixture()
    f.prepare.mockRejectedValueOnce(new Error('disk-full'))
    expect(await f.guard(f.window, '退出')).toBe(false)
    expect(f.cancelPageLeave).toHaveBeenCalledOnce()
    expect(f.confirmationCount()).toBe(0)
    f.state.dirty = false
    expect(await f.guard(f.window, '退出')).toBe(true)
    await f.guard.resume(f.window)
  })

  it('does not let an old caller release a newer preparation on the same window', async () => {
    const f = fixture()
    f.state.dirty = false
    const oldOwner = {}
    const newOwner = {}
    expect(await f.guard(f.window, '切换视图', { owner: oldOwner })).toBe(true)
    expect(await f.guard(f.window, '退出', { owner: newOwner })).toBe(false)
    f.guard.resume(f.window, oldOwner)
    let finish
    f.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const second = f.guard(f.window, '退出', { owner: newOwner })
    const cancelCount = f.cancelPageLeave.mock.calls.length
    f.guard.resume(f.window, oldOwner)
    expect(f.cancelPageLeave).toHaveBeenCalledTimes(cancelCount)
    expect(await f.guard(f.window, '切换视图', { owner: oldOwner })).toBe(false)
    finish({ ready: true })
    expect(await second).toBe(true)
    f.guard.resume(f.window, oldOwner)
    expect(f.cancelPageLeave).toHaveBeenCalledTimes(cancelCount)
    f.guard.resume(f.window, newOwner)
    expect(f.cancelPageLeave).toHaveBeenCalledTimes(cancelCount + 1)
  })

  it('reveals a hidden settings failure before notifying the user', async () => {
    const f = fixture()
    const events = []
    const guard = createEditingDraftGuard({
      logger: { error: vi.fn() },
      reveal: async () => events.push('reveal')
    })
    f.contents.send.mockImplementation(() => events.push('message'))
    f.prepare.mockRejectedValueOnce(new Error('disk-full'))
    expect(await guard(f.window, '退出')).toBe(false)
    expect(events).toEqual(['reveal', 'message'])
  })

  it('rechecks settings after draft inspection and refuses a participant cancelled in between', async () => {
    const f = fixture()
    f.state.dirty = false
    f.prepare
      .mockResolvedValueOnce({ ready: true })
      .mockRejectedValueOnce(new Error('participant unmounted'))
    expect(await f.guard(f.window, '切换视图')).toBe(false)
    expect(f.prepare).toHaveBeenCalledTimes(2)
    expect(
      f.frame.executeJavaScript.mock.calls.some(([code]) => code.includes('recheck: true'))
    ).toBe(true)
    expect(f.cancelPageLeave).toHaveBeenCalledOnce()
  })

  it('does not wait indefinitely for a nonresponsive renderer to acknowledge cancellation', async () => {
    const f = fixture()
    f.prepare.mockRejectedValueOnce(new Error('disk-full'))
    f.cancelPageLeave.mockImplementation(() => new Promise(() => {}))
    expect(await f.guard(f.window, '退出')).toBe(false)
    expect(f.cancelPageLeave).toHaveBeenCalledOnce()
    expect(f.window.listenerCount('hide')).toBe(0)
  })

  it('cancels a pending settings prepare without entering a late draft confirmation', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let finish
    f.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const leaving = f.guard(f.window, '切换视图')
    expect(f.prepare).toHaveBeenCalledOnce()
    f.window.emit('hide')
    expect(await leaving).toBe(false)
    expect(f.cancelPageLeave).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    finish({ ready: true })
    await Promise.resolve()
    expect(f.confirmationCount()).toBe(0)
  })
})
