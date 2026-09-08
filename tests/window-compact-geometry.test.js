import { describe, expect, it } from 'vitest'
import {
  COMPACT_WINDOW_ANCHORS,
  compactAnchorFromPosition,
  compactBoundsFromCenter,
  compactBoundsFromExpandedTop,
  compactBoundsFromPosition,
  expandedBoundsFromCompact,
  interpolateWindowBounds,
  mapCompactCenterToWorkArea,
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

  it('treats a middle capsule as a top or bottom anchor instead of the view center', () => {
    expect(
      expandedBoundsFromCompact({
        compactBounds: { x: 780, y: 482, width: 360, height: 76 },
        expandedSize: { width: 1000, height: 700 },
        workArea
      })
    ).toEqual({ x: 460, y: 340, width: 1000, height: 700 })
  })

  it('allows the capsule and expanded view to touch the top edge', () => {
    expect(
      expandedBoundsFromCompact({
        compactBounds: { x: 780, y: 0, width: 360, height: 76 },
        expandedSize: { width: 1000, height: 700 },
        workArea
      })
    ).toEqual({ x: 460, y: 0, width: 1000, height: 700 })
  })

  it('keeps the capsule top edge fixed when the top anchor has room', () => {
    const target = expandedBoundsFromCompact({
      compactBounds: { x: 780, y: 20, width: 360, height: 76 },
      expandedSize: { width: 1000, height: 700 },
      workArea
    })
    expect(target.y).toBe(20)
  })

  it('prefers keeping the top edge fixed when both one-sided directions fit', () => {
    const compactBounds = { x: 780, y: 400, width: 360, height: 76 }
    expect(
      compactAnchorFromPosition({
        compactBounds,
        expandedSize: { width: 1000, height: 300 },
        workArea
      })
    ).toBe(COMPACT_WINDOW_ANCHORS.TOP)
    expect(
      expandedBoundsFromCompact({
        compactBounds,
        expandedSize: { width: 1000, height: 300 },
        workArea
      }).y
    ).toBe(400)
  })

  it('uses a bottom anchor near the lower edge', () => {
    const compactBounds = { x: 780, y: 964, width: 360, height: 76 }
    expect(
      compactAnchorFromPosition({
        compactBounds,
        expandedSize: { width: 1000, height: 700 },
        workArea
      })
    ).toBe(COMPACT_WINDOW_ANCHORS.BOTTOM)
    expect(
      expandedBoundsFromCompact({
        compactBounds,
        expandedSize: { width: 1000, height: 700 },
        workArea
      })
    ).toEqual({
      x: 460,
      y: 340,
      width: 1000,
      height: 700
    })
  })

  it('keeps resized compact windows centered until a safe edge requires a shift', () => {
    expect(
      compactBoundsFromCenter({
        center: { x: 960, y: 520 },
        size: { width: 600, height: 120 },
        workArea
      })
    ).toEqual({ x: 660, y: 460, width: 600, height: 120 })
    expect(
      compactBoundsFromCenter({
        center: { x: 20, y: 20 },
        size: { width: 600, height: 120 },
        workArea
      })
    ).toEqual({ x: 0, y: 0, width: 600, height: 120 })
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

  it('interpolates four edges with one shared progress value', () => {
    expect(
      interpolateWindowBounds(
        { x: 10, y: 10, width: 360, height: 76 },
        { x: 10, y: 10, width: 1000, height: 700 },
        0.5
      )
    ).toEqual({ x: 10, y: 10, width: 680, height: 388 })
  })

  it('maps saved centers proportionally when the original display disappears', () => {
    expect(
      mapCompactCenterToWorkArea({
        center: { x: 960, y: 520 },
        previousWorkArea: workArea,
        nextWorkArea: { x: 1920, y: 0, width: 1280, height: 720 }
      })
    ).toEqual({ x: 2560, y: 360 })
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
