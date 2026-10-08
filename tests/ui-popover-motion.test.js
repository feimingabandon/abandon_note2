import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  enterPopover,
  leavePopover,
  cancelPopover
} from '../src/renderer/src/utils/popoverMotion.js'

afterEach(() => vi.unstubAllGlobals())
describe('popover interruption', () => {
  it('continues from the visible frame and ignores completion of a replaced animation', async () => {
    const animations = []
    const el = {
      style: {},
      animate: vi.fn((frames) => {
        let resolve
        const animation = {
          frames,
          cancel: vi.fn(),
          finished: new Promise((r) => {
            resolve = r
          }),
          finish: () => resolve()
        }
        animations.push(animation)
        return animation
      })
    }
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: () => 'top',
      opacity: '0.43',
      transform: 'matrix(1, 0, 0, 1, 0, 2.2)'
    }))
    const oldDone = vi.fn(),
      newDone = vi.fn()
    enterPopover(el, oldDone, 'dropdown')
    expect(animations[0].frames[0].transform).toBe('translate(0, 4px)')
    leavePopover(el, newDone, 'dropdown')
    expect(animations[1].frames[0]).toEqual({
      opacity: '0.43',
      transform: 'matrix(1, 0, 0, 1, 0, 2.2)'
    })
    expect(animations[0].cancel).toHaveBeenCalledOnce()
    animations[0].finish()
    await Promise.resolve()
    expect(oldDone).not.toHaveBeenCalled()
    animations[1].finish()
    await Promise.resolve()
    expect(newDone).toHaveBeenCalledOnce()
    expect(animations[1].cancel).toHaveBeenCalledOnce()
    cancelPopover(el)
  })
})
