import { describe, expect, it } from 'vitest'
import {
  calculateOverlapArea,
  chooseStickyBounds,
  createStickyPreview,
  getContrastTextColor,
  isToolbarAccessible,
  mapBoundsBetweenWorkAreas,
  normalizeBackgroundColor,
  normalizeCornerRadius,
  normalizeFontSize,
  normalizeNoteId,
  normalizeStickyContent
} from '../src/main/sticky/stickyUtils.js'

describe('sticky input validation', () => {
  it('preserves the original note text while rejecting whitespace-only content', () => {
    expect(normalizeStickyContent('  第一行\n第二行  ')).toBe('  第一行\n第二行  ')
    expect(() => normalizeStickyContent(' \n\t ')).toThrow('便签内容为空')
  })

  it('accepts only positive integer note ids', () => {
    expect(normalizeNoteId('12')).toBe(12)
    expect(() => normalizeNoteId(0)).toThrow('无效的便签')
    expect(() => normalizeNoteId(1.5)).toThrow('无效的便签')
  })

  it('validates the temporary appearance values', () => {
    expect(normalizeFontSize(12)).toBe(12)
    expect(normalizeFontSize(13)).toBe(13)
    expect(normalizeFontSize(32)).toBe(32)
    expect(() => normalizeFontSize(12.5)).toThrow('整数')
    expect(normalizeBackgroundColor('#ffd4e1')).toBe('#FFD4E1')
    expect(() => normalizeBackgroundColor('red')).toThrow('无效')
    expect(normalizeCornerRadius(0)).toBe(0)
    expect(normalizeCornerRadius(18)).toBe(18)
    expect(normalizeCornerRadius(32)).toBe(32)
    expect(() => normalizeCornerRadius(-1)).toThrow('0～32')
    expect(() => normalizeCornerRadius(12.5)).toThrow('整数')
    expect(() => normalizeCornerRadius(33)).toThrow('0～32')
  })

  it('chooses readable text colors and stable tray previews', () => {
    expect(getContrastTextColor('#FFFFFF')).toBe('#1F2328')
    expect(getContrastTextColor('#000000')).toBe('#FFFFFF')
    expect(createStickyPreview('\n  一条很短的便签\n第二行')).toBe('一条很短的便签')
    expect(createStickyPreview('1234567890123456789012345')).toBe('123456789012345678901234…')
  })
})

describe('sticky placement', () => {
  const workArea = { x: 100, y: 50, width: 800, height: 600 }

  it('keeps a new sticky completely inside the display work area', () => {
    const bounds = chooseStickyBounds({
      cursor: { x: 895, y: 645 },
      workArea,
      existingBounds: []
    })
    expect(bounds.x).toBeGreaterThanOrEqual(workArea.x)
    expect(bounds.y).toBeGreaterThanOrEqual(workArea.y)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(workArea.x + workArea.width)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(workArea.y + workArea.height)
  })

  it('treats the visible main window as a hard exclusion zone', () => {
    const mainWindowBounds = { x: 1440, y: 25, width: 480, height: 930 }
    const bounds = chooseStickyBounds({
      cursor: { x: 1710, y: 220 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      existingBounds: [],
      blockedBounds: [mainWindowBounds]
    })

    expect(calculateOverlapArea(bounds, mainWindowBounds)).toBe(0)
  })

  it('searches the whole work area instead of accepting a partial main-window overlap', () => {
    const mainWindowBounds = { x: 250, y: 0, width: 550, height: 600 }
    const bounds = chooseStickyBounds({
      cursor: { x: 520, y: 280 },
      workArea: { x: 0, y: 0, width: 1100, height: 700 },
      existingBounds: [{ x: 804, y: 0, width: 280, height: 260 }],
      blockedBounds: [mainWindowBounds]
    })

    expect(calculateOverlapArea(bounds, mainWindowBounds)).toBe(0)
  })

  it('maps removed-display positions into a remaining work area', () => {
    const mapped = mapBoundsBetweenWorkAreas(
      { x: 1500, y: 200, width: 280, height: 260 },
      { x: 1000, y: 0, width: 1000, height: 800 },
      workArea
    )
    expect(mapped.x).toBeGreaterThanOrEqual(workArea.x)
    expect(mapped.y).toBeGreaterThanOrEqual(workArea.y)
    expect(mapped.x + mapped.width).toBeLessThanOrEqual(workArea.x + workArea.width)
    expect(mapped.y + mapped.height).toBeLessThanOrEqual(workArea.y + workArea.height)
  })

  it('detects whether the draggable toolbar remains reachable', () => {
    expect(isToolbarAccessible({ x: 110, y: 40, width: 280, height: 260 }, [workArea], 30)).toBe(
      true
    )
    expect(isToolbarAccessible({ x: -500, y: -500, width: 280, height: 260 }, [workArea], 30)).toBe(
      false
    )
  })
})
