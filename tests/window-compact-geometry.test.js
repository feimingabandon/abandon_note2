import { describe, expect, it } from 'vitest'
import {
  compactBoundsFromExpandedTop,
  compactBoundsFromPosition,
  mapCompactPositionToWorkArea,
  normalizeCompactSize
} from '../src/shared/window-compact-geometry.js'

const workArea = { x: 0, y: 0, width: 1920, height: 1040 }

describe('compact window geometry', () => {
  it('clamps user sizes to product and display limits', () => {
    expect(normalizeCompactSize()).toEqual({ width: 200, height: 40 })
    expect(normalizeCompactSize({ width: 20, height: 20 }, workArea)).toEqual({
      width: 100,
      height: 40
    })
    expect(normalizeCompactSize({ width: 100, height: 500 }, workArea)).toEqual({
      width: 100,
      height: 180
    })
    expect(
      normalizeCompactSize({ width: 720, height: 180 }, { x: 0, y: 0, width: 500, height: 120 })
    ).toEqual({ width: 500, height: 120 })
  })

  it('collapses only to the expanded view top-center with the same top edge', () => {
    expect(
      compactBoundsFromExpandedTop({
        expandedBounds: { x: 120, y: 36, width: 1000, height: 700 },
        size: { width: 360, height: 76 },
        workArea
      })
    ).toEqual({ x: 440, y: 36, width: 360, height: 76 })
  })

  it('keeps a wide capsule inside the horizontal safe area when the main view is narrow', () => {
    expect(
      compactBoundsFromExpandedTop({
        expandedBounds: { x: 10, y: 36, width: 240, height: 700 },
        size: { width: 720, height: 76 },
        workArea
      })
    ).toEqual({ x: 0, y: 36, width: 720, height: 76 })
  })

  it('keeps the saved top-left position while compact dimensions change', () => {
    expect(
      compactBoundsFromPosition({
        position: { x: 440, y: 36 },
        size: { width: 420, height: 92 },
        workArea
      })
    ).toEqual({ x: 440, y: 36, width: 420, height: 92 })
    expect(
      compactBoundsFromPosition({
        position: { x: 1880, y: 1020 },
        size: { width: 420, height: 92 },
        workArea
      })
    ).toEqual({ x: 1500, y: 948, width: 420, height: 92 })
  })

  it('maps saved top-left positions proportionally when the original display disappears', () => {
    expect(
      mapCompactPositionToWorkArea({
        position: { x: 960, y: 520 },
        previousWorkArea: workArea,
        nextWorkArea: { x: 1920, y: 0, width: 1280, height: 720 }
      })
    ).toEqual({ x: 2560, y: 360 })
  })
})
