import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let broadcast
let replies
beforeEach(() => {
  vi.resetModules()
  replies = []
  vi.stubGlobal('window', {
    api: {
      onCompactWindowStateChanged: (callback) => {
        broadcast = callback
        return vi.fn()
      },
      getCompactWindowState: () => new Promise((resolve) => replies.push(resolve))
    }
  })
})
afterEach(() => vi.unstubAllGlobals())

const createMode = async () =>
  (await import('../src/renderer/src/composables/useCompactWindowMode.js')).useCompactWindowMode()
const stable = { mode: 'compact', phase: 'compact', transition: null, compact: true }
const moving = {
  mode: 'compact',
  phase: 'expanding',
  transition: { generation: 4, from: 'compact', to: 'expanded' },
  compact: true
}

describe('compact renderer bootstrap ordering', () => {
  it('does not erase an in-flight transition with a delayed initial snapshot', async () => {
    const mode = await createMode()
    const started = mode.start()
    broadcast(moving)
    replies[0](stable)
    await started
    expect(mode.state.value).toEqual(moving)
    expect(mode.changing.value).toBe(true)
    mode.stop()
  })

  it('ignores a reply from a stopped subscription after a new session starts', async () => {
    const mode = await createMode()
    const old = mode.start()
    mode.stop()
    const current = mode.start()
    replies[1](moving)
    await current
    replies[0](stable)
    await old
    expect(mode.state.value).toEqual(moving)
    mode.stop()
  })

  it('keeps the newest bootstrap when two consumers start together', async () => {
    const first = await createMode()
    const second = await createMode()
    const older = first.start()
    const newer = second.start()
    replies[1](moving)
    await newer
    replies[0](stable)
    await older
    expect(first.state.value).toEqual(moving)
    first.stop()
    second.stop()
  })
})
