import { describe, expect, it } from 'vitest'
import {
  COMPACT_WINDOW_LIMITS,
  compactBoundsAroundCenter,
  compactBoundsFromAnchor,
  normalizeCompactSize
} from '../src/shared/window-compact-geometry.js'

describe('compact window geometry', () => {
  const workArea = { x: 1920, y: 40, width: 1600, height: 900 }

  it('uses the titlebar double-click screen point as the compact window center', () => {
    expect(
      compactBoundsFromAnchor({
        anchor: { x: 2500, y: 300 },
        size: {
          width: COMPACT_WINDOW_LIMITS.defaultWidth,
          height: COMPACT_WINDOW_LIMITS.defaultHeight
        },
        workArea
      })
    ).toEqual({ x: 2410, y: 276, width: 180, height: 48 })
  })

  it('keeps the complete real window inside the target display work area', () => {
    expect(
      compactBoundsFromAnchor({
        anchor: { x: 1910, y: 20 },
        size: {
          width: COMPACT_WINDOW_LIMITS.defaultWidth,
          height: COMPACT_WINDOW_LIMITS.defaultHeight
        },
        workArea
      })
    ).toEqual({ x: 1920, y: 40, width: 180, height: 48 })
  })

  it('normalizes persisted sizes and preserves center when applying a new size', () => {
    expect(normalizeCompactSize({ width: 10_000, height: 1 }, workArea)).toEqual({
      width: COMPACT_WINDOW_LIMITS.maxWidth,
      height: COMPACT_WINDOW_LIMITS.minHeight
    })
    expect(
      compactBoundsAroundCenter({
        bounds: { x: 2200, y: 200, width: 280, height: 72 },
        size: { width: 400, height: 100 },
        workArea
      })
    ).toEqual({ x: 2140, y: 186, width: 400, height: 100 })
  })
})
