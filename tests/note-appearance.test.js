import { describe, expect, it } from 'vitest'
import {
  getNoteTextColor,
  NOTE_TEXT_COLOR_FALLBACK
} from '../src/renderer/src/utils/noteAppearance.js'

describe('note text color', () => {
  it('uses the first tag color without hiding legacy tags', () => {
    const note = {
      tags: [
        { name: '最先绑定', color: '#ff3b30' },
        { name: '历史第二项', color: '#007aff' }
      ]
    }
    expect(getNoteTextColor(note)).toBe('#ff3b30')
    expect(note.tags).toHaveLength(2)
  })

  it('falls back to the configured text color variable', () => {
    expect(getNoteTextColor({ tags: [] })).toBe(NOTE_TEXT_COLOR_FALLBACK)
    expect(getNoteTextColor({ tags: [{ color: null }] })).toBe(NOTE_TEXT_COLOR_FALLBACK)
    expect(getNoteTextColor({ tags: [{ color: 'invalid' }] })).toBe(NOTE_TEXT_COLOR_FALLBACK)
    expect(NOTE_TEXT_COLOR_FALLBACK).toBe('var(--text-color)')
  })
})
