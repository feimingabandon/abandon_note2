import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTransitionTotalMs } from '../src/renderer/src/composables/useSlidingWorkspace.js'

afterEach(() => vi.unstubAllGlobals())

describe('sliding workspace transition fallback', () => {
  it('uses the matching transform duration and delay', () => {
    vi.stubGlobal('window', {
      getComputedStyle: () => ({
        transitionProperty: 'opacity, transform',
        transitionDuration: '120ms, 0.36s',
        transitionDelay: '0ms, 40ms'
      })
    })

    expect(getTransitionTotalMs({}, 'transform')).toBe(400)
  })

  it('finishes immediately when the element has no transition', () => {
    vi.stubGlobal('window', {
      getComputedStyle: () => ({
        transitionProperty: 'none',
        transitionDuration: '0s',
        transitionDelay: '0s'
      })
    })

    expect(getTransitionTotalMs({}, 'transform')).toBe(0)
  })
})
