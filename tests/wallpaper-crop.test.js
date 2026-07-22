import { describe, expect, it } from 'vitest'
import {
  constrainFrameToVisibleBounds,
  fitAspectFrame,
  mapFrameToSource
} from '../src/renderer/src/utils/wallpaperCrop.js'

describe('wallpaper crop math', () => {
  it('maps a moved frame back to original pixels without stretching', () => {
    expect(
      mapFrameToSource({
        frame: { x: 250, y: 150, width: 300, height: 400 },
        imageRect: { x: 100, y: 50, width: 800, height: 800 },
        renderScale: 0.5,
        imageSize: { width: 1600, height: 1600 }
      })
    ).toEqual({ x: 300, y: 200, width: 600, height: 800 })
  })

  it('fits the main-window ratio inside both image and stage bounds', () => {
    const frame = fitAspectFrame({
      bounds: { width: 900, height: 600 },
      stage: { width: 1000, height: 700 },
      ratio: 3 / 4
    })
    expect(frame.width / frame.height).toBeCloseTo(3 / 4)
    expect(frame.width).toBeLessThanOrEqual(900 * 0.82)
    expect(frame.height).toBeLessThanOrEqual(600 * 0.82)
  })

  it('keeps the whole crop frame visible when a zoomed image extends beyond the stage', () => {
    const constrained = constrainFrameToVisibleBounds({
      frame: { x: -451, y: -108, width: 105, height: 203 },
      imageRect: { x: -451, y: -108, width: 1353, height: 744 },
      stage: { width: 451, height: 528 }
    })
    expect(constrained.x).toBe(0)
    expect(constrained.y).toBe(0)
    expect(constrained.x + 105).toBeLessThanOrEqual(451)
    expect(constrained.y + 203).toBeLessThanOrEqual(528)
  })
})
