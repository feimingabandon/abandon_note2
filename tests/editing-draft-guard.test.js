import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
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
  contents.executeJavaScript = vi.fn(async (code) => {
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
  return { window, contents, state, guard, respond: (accepted) => answer(accepted) }
}

describe('application draft confirmation lifecycle', () => {
  it.each(['hide', 'closed', 'render-process-gone', 'navigation'])(
    'releases a pending request on %s',
    async (event) => {
      const f = fixture()
      const pending = f.guard(f.window, '切换视图')
      await vi.waitFor(() => expect(f.contents.executeJavaScript).toHaveBeenCalledTimes(2))
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
    await vi.waitFor(() => expect(f.contents.executeJavaScript).toHaveBeenCalledTimes(2))
    f.respond(false)
    expect(await first).toBe(false)
    const second = f.guard(f.window, '切换视图')
    await vi.waitFor(() => expect(f.contents.executeJavaScript).toHaveBeenCalledTimes(4))
    f.state.blocked = true
    f.respond(true)
    expect(await second).toBe(false)
    expect(f.contents.send).toHaveBeenCalledWith(
      'app:message',
      expect.objectContaining({ type: 'warning' })
    )
  })
})
