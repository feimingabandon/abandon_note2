import { describe, it, expect, vi, afterEach } from 'vitest'
import { prepareCompactTargetFrame } from '../src/main/windows/compact-target-frame.js'

const createWindow = (capturePage) => ({
  isDestroyed: () => false,
  getContentSize: () => [1200, 800],
  webContents: { isDestroyed: () => false, capturePage }
})
afterEach(() => vi.useRealTimers())

describe('compact target composited frame', () => {
  it('keeps the handoff pending until a nonempty compositor readback completes', async () => {
    let complete
    const capture = vi.fn(() => new Promise((resolve) => (complete = resolve)))
    const finished = vi.fn()
    const pending = prepareCompactTargetFrame(createWindow(capture)).then(finished)
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    expect(capture).toHaveBeenCalledWith(
      { x: 600, y: 400, width: 1, height: 1 },
      { stayHidden: true, stayAwake: true }
    )
    complete({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) })
    await pending
    expect(finished).toHaveBeenCalledWith({ width: 1, height: 1 })
  })

  it('rejects an empty readback so the transaction can restore the source window', async () => {
    await expect(
      prepareCompactTargetFrame(createWindow(async () => ({ isEmpty: () => true })))
    ).rejects.toThrow('没有生成有效合成帧')
  })

  it('bounds a stuck compositor wait', async () => {
    vi.useFakeTimers()
    const pending = prepareCompactTargetFrame(
      createWindow(() => new Promise(() => {})),
      100
    )
    const assertion = expect(pending).rejects.toThrow('准备超时')
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a window destroyed during readback', async () => {
    const window = createWindow(async () => {
      window.isDestroyed = () => true
      return { isEmpty: () => false }
    })
    await expect(prepareCompactTargetFrame(window)).rejects.toThrow('没有生成有效合成帧')
  })
})
