import { describe, expect, it } from 'vitest'
import { pointerAnchorRect } from '../src/renderer/src/utils/pointerAnchor.js'
import { quickNoteEditorPosition } from '../src/renderer/src/utils/quickNoteEditorPosition.js'

describe('鼠标位置浮层锚点', () => {
  const fallback = { left: 100, top: 60, right: 300, bottom: 84, width: 200, height: 24 }

  it('uses the real mouse position and preserves the element rectangle for keyboard activation', () => {
    expect(pointerAnchorRect({ detail: 1, clientX: 246, clientY: 73 }, fallback)).toEqual({
      left: 246,
      top: 73,
      right: 246,
      bottom: 73,
      width: 0,
      height: 0
    })
    expect(pointerAnchorRect({ detail: 0, clientX: 0, clientY: 0 }, fallback)).toEqual(fallback)
  })

  it('centers a quick editor around a click while retaining left alignment for card anchors', () => {
    const viewport = { viewportWidth: 1000, viewportHeight: 700 }
    const panel = { width: 360, height: 240 }
    expect(
      quickNoteEditorPosition(
        pointerAnchorRect({ detail: 2, clientX: 500, clientY: 100 }),
        panel,
        viewport
      )
    ).toEqual({ left: 320, top: 108 })
    expect(quickNoteEditorPosition(fallback, panel, viewport)).toEqual({ left: 100, top: 92 })
  })

  it('keeps click-anchored editors inside the viewport and flips above near the bottom edge', () => {
    expect(
      quickNoteEditorPosition(
        pointerAnchorRect({ detail: 2, clientX: 980, clientY: 680 }),
        { width: 360, height: 240 },
        { viewportWidth: 1000, viewportHeight: 700 }
      )
    ).toEqual({ left: 628, top: 432 })
  })
})
