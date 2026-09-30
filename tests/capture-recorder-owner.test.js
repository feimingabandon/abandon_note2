import { describe, expect, it, vi } from 'vitest'
import {
  acquireShortcutRecorder,
  releaseShortcutRecorder
} from '../src/renderer/src/utils/shortcutRecordingOwner.js'

describe('shortcut recorder ownership', () => {
  it('serializes rapid switches until the previous start and cancellation finish', async () => {
    const a = Symbol(),
      b = Symbol(),
      c = Symbol(),
      calls = []
    let started
    const ready = new Promise((resolve) => {
      started = resolve
    })
    const first = acquireShortcutRecorder(
      a,
      async () => {
        calls.push('end-a')
      },
      async () => {
        calls.push('start-a')
        await ready
      }
    )
    const second = acquireShortcutRecorder(
      b,
      async () => {
        calls.push('end-b')
      },
      async () => {
        calls.push('start-b')
      }
    )
    const third = acquireShortcutRecorder(c, vi.fn(), async () => {
      calls.push('start-c')
    })
    await Promise.resolve()
    expect(calls).toEqual(['start-a'])
    started()
    await Promise.all([first, second, third])
    expect(calls).toEqual(['start-a', 'end-a', 'start-b', 'end-b', 'start-c'])
    releaseShortcutRecorder(a)
    releaseShortcutRecorder(c)
  })
  it('allows a new recorder after a failed IPC start', async () => {
    const owner = Symbol(),
      next = Symbol(),
      cancel = vi.fn(),
      start = vi.fn()
    await expect(
      acquireShortcutRecorder(owner, cancel, async () => {
        throw Error('IPC')
      })
    ).rejects.toThrow('IPC')
    await acquireShortcutRecorder(next, vi.fn(), start)
    expect(cancel).not.toHaveBeenCalled()
    expect(start).toHaveBeenCalledOnce()
    releaseShortcutRecorder(next)
  })
})
