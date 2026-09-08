import { describe, expect, it, vi } from 'vitest'
import {
  animateCalendarPreview,
  calendarPreviewClips,
  calendarPreviewPosition
} from '../src/renderer/src/components/month/calendar-day-preview.js'

describe('日历预览位置与卷帘方向', () => {
  it.each([
    [{ left: 20, right: 120, top: 100, bottom: 200 }, { width: 800, height: 600 }, 'right'],
    [{ left: 650, right: 750, top: 100, bottom: 200 }, { width: 800, height: 600 }, 'left'],
    [{ left: 100, right: 160, top: 50, bottom: 100 }, { width: 360, height: 600 }, 'bottom'],
    [{ left: 100, right: 160, top: 500, bottom: 550 }, { width: 360, height: 600 }, 'top']
  ])('按可用空间选择 %s %s → %s', (anchor, viewport, placement) => {
    const preview = { width: 300, height: 200 }
    const position = calendarPreviewPosition(anchor, preview, viewport)
    expect(position.placement).toBe(placement)
    expect(position.left).toBeGreaterThanOrEqual(8)
    expect(position.top).toBeGreaterThanOrEqual(8)
    expect(position.left + preview.width).toBeLessThanOrEqual(viewport.width - 8)
    expect(position.top + preview.height).toBeLessThanOrEqual(viewport.height - 8)
  })

  it.each([
    ['right', 'inset(0 100% 0 0 round 12px)'],
    ['left', 'inset(0 0 0 100% round 12px)'],
    ['bottom', 'inset(0 0 100% 0 round 12px)'],
    ['top', 'inset(100% 0 0 0 round 12px)']
  ])('%s 从靠近日期格的边缘展开，关闭时反向收回', (placement, closed) => {
    const open = 'inset(0 0 0 0 round 12px)'
    expect(calendarPreviewClips(placement, true)).toEqual([closed, open])
    expect(calendarPreviewClips(placement, false)).toEqual([open, closed])
  })

  it('快速反向开合从当前裁剪继续，旧动画不能结束新过渡', async () => {
    const animations = []
    const element = {
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ clipPath: 'inset(0 45% 0 0 round 12px)' }) }
      },
      animate: vi.fn(() => {
        let finish
        const animation = {
          playState: 'running',
          finished: new Promise((resolve) => {
            finish = resolve
          }),
          cancel: vi.fn(() => finish()),
          finish: () => finish()
        }
        animations.push(animation)
        return animation
      })
    }
    const entered = vi.fn()
    const left = vi.fn()
    animateCalendarPreview(element, entered, 'right', true)
    animateCalendarPreview(element, left, 'right', false)
    expect(element.animate.mock.calls[1][0]).toEqual([
      { clipPath: 'inset(0 45% 0 0 round 12px)' },
      { clipPath: 'inset(0 100% 0 0 round 12px)' }
    ])
    await Promise.resolve()
    expect(entered).not.toHaveBeenCalled()
    animations[1].finish()
    await Promise.resolve()
    expect(left).toHaveBeenCalledOnce()
  })
})
