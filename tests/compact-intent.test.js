import { describe, it, expect, vi } from 'vitest'
import { CompactIntent } from '../src/main/windows/compact-intent.js'

function setup() {
  let compact = false
  let window = { isDestroyed: () => false }
  const completions = []
  const apply = vi.fn(
    (target) =>
      new Promise((resolve, reject) => {
        completions.push({
          complete: () => {
            compact = target
            resolve({ changed: true })
          },
          reject
        })
      })
  )
  const intent = new CompactIntent({ getWindow: () => window, isCompact: () => compact, apply })
  return {
    intent,
    apply,
    completions,
    replace: () => {
      window = { isDestroyed: () => false }
    }
  }
}

describe('latest compact window intent', () => {
  it('waits for the native transaction before applying the last opposite request', async () => {
    const { intent, apply, completions } = setup()
    const pending = intent.request(true)
    await Promise.resolve()
    intent.request(false)
    intent.request(true)
    intent.request(false)
    expect(apply.mock.calls).toEqual([[true]])
    completions[0].complete()
    await new Promise((resolve) => setImmediate(resolve))
    expect(apply.mock.calls).toEqual([[true], [false]])
    completions[1].complete()
    await pending
    expect(intent.pending).toBeNull()
  })

  it('coalesces duplicate targets and toggles against the requested destination', async () => {
    const { intent, apply, completions } = setup()
    const pending = intent.request(true)
    await Promise.resolve()
    expect(intent.request(true)).toBe(pending)
    intent.toggle()
    intent.toggle()
    completions[0].complete()
    await pending
    expect(apply).toHaveBeenCalledOnce()
  })

  it('drops pending work after window replacement', async () => {
    const { intent, apply, completions, replace } = setup()
    const pending = intent.request(true)
    await Promise.resolve()
    intent.request(false)
    replace()
    completions[0].complete()
    await pending
    expect(apply).toHaveBeenCalledOnce()
  })

  it('drops queued requests on failure and permits the next user request', async () => {
    const { intent, apply, completions } = setup()
    const pending = intent.request(true)
    await Promise.resolve()
    intent.request(false)
    const rejected = expect(pending).rejects.toThrow('native failure')
    completions[0].reject(new Error('native failure'))
    await rejected
    const retry = intent.request(true)
    await Promise.resolve()
    completions[1].complete()
    await retry
    expect(apply).toHaveBeenCalledTimes(2)
  })
})
