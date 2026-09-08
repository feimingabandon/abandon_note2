import { describe, it, expect, vi } from 'vitest'
import { anchoredPopover } from '../src/renderer/src/utils/anchoredPopover.js'
import { isComposingInput } from '../src/renderer/src/utils/inputComposition.js'
import { createEditingDraftGuard } from '../src/main/windows/editing-draft-guard.js'
import { Scheduler } from '../src/main/services/scheduler.js'
import { EventEmitter } from 'node:events'
import { installRendererRecovery } from '../src/main/windows/renderer-recovery.js'
import { createThumbnailCache } from '../src/main/services/thumbnail-cache.js'

describe('Windows maturity boundaries', () => {
  it('bounds thumbnail cache bytes and retains recently used entries', () => {
    const cache = createThumbnailCache({ maxBytes: 12, maxEntries: 2 })
    cache.set('a', 'aaa')
    cache.set('b', 'bbb')
    expect(cache.get('a')).toBe('aaa')
    cache.set('c', 'ccc')
    expect(cache.get('b')).toBeUndefined()
    cache.set('huge', 'xxxxxxxxxx')
    expect(cache.get('huge')).toBeUndefined()
    expect(cache.get('a')).toBe('aaa')
  })
  it('stops automatically reloading after two recent renderer crashes', async () => {
    vi.useFakeTimers()
    try {
      const window = new EventEmitter()
      window.isDestroyed = () => false
      window.webContents = new EventEmitter()
      window.webContents.reload = vi.fn()
      const dialog = { showMessageBox: vi.fn(async () => ({ response: 2 })) }
      installRendererRecovery(window, { dialog, logger: { error: vi.fn() }, restart: vi.fn() })
      for (let i = 0; i < 3; i++) {
        window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
        await vi.advanceTimersByTimeAsync(400)
      }
      expect(window.webContents.reload).toHaveBeenCalledTimes(2)
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
      window.emit('closed')
    } finally {
      vi.useRealTimers()
    }
  })
  it('keeps large popovers inside a narrow viewport and flips at the bottom', () => {
    const rect = { top: 310, bottom: 340, left: 210 }
    const p = anchoredPopover(rect, {
      width: 360,
      height: 400,
      viewportWidth: 240,
      viewportHeight: 360
    })
    expect(p.flip).toBe(true)
    expect(p.left).toBeGreaterThanOrEqual(8)
    expect(p.left + p.width).toBeLessThanOrEqual(232)
    expect(p.top).toBeGreaterThanOrEqual(8)
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(352)
  })
  it('recognizes both modern and legacy IME composition', () => {
    expect(isComposingInput({ isComposing: true })).toBe(true)
    expect(isComposingInput({ keyCode: 229 })).toBe(true)
    expect(isComposingInput({ key: 'Enter' })).toBe(false)
  })
  it('never leaves on failed persistence, cancellation, or active save', async () => {
    const state = { dirty: true, blocked: true }
    const dialog = { showMessageBox: vi.fn(async () => ({ response: 0 })) }
    const window = {
      isDestroyed: () => false,
      webContents: { isCrashed: () => false, executeJavaScript: async () => state }
    }
    const guard = createEditingDraftGuard({ dialog, logger: { error: vi.fn() } })
    expect(await guard(window, '退出')).toBe(false)
    state.blocked = false
    expect(await guard(window, '退出')).toBe(false)
    dialog.showMessageBox.mockResolvedValue({ response: 1 })
    expect(await guard(window, '退出')).toBe(true)
  })
  it('keeps core tasks retryable with bounded backoff and explicit recovery', () => {
    const scheduler = new Scheduler()
    const work = vi.fn(() => {
      throw new Error('temporary storage failure')
    })
    scheduler.register({
      name: 'core',
      maxFailures: Infinity,
      retryBackoff: true,
      shouldRun: () => true,
      execute: work
    })
    scheduler.tick()
    scheduler.tick()
    expect(work).toHaveBeenCalledTimes(1)
    expect(scheduler.getHealth().tasks[0].nextRetryAt).toBeGreaterThan(Date.now())
    work.mockImplementation(() => {})
    scheduler.retryFailed()
    expect(work).toHaveBeenCalledTimes(2)
    expect(scheduler.getHealth().tasks[0]).toMatchObject({
      failures: 0,
      disabled: false,
      lastError: null,
      nextRetryAt: null
    })
  })
})
