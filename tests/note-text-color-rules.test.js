import { describe, expect, it } from 'vitest'
import {
  applyNoteTextColorRange,
  buildNoteTextColorSegments,
  normalizeNoteTextColorRanges,
  reconcileNoteTextColorRanges
} from '../src/shared/note-text-color-rules.js'

describe('note text color ranges', () => {
  it('supports multiple ranges and lets a new color split an existing range', () => {
    const content = '今天完成报告'
    const red = applyNoteTextColorRange([], { content, start: 0, end: 6, color: '#FF3B30' })
    const split = applyNoteTextColorRange(red, {
      content,
      start: 2,
      end: 4,
      color: '#007aff'
    })

    expect(split).toEqual([
      { start: 0, end: 2, text: '今天', color: '#ff3b30' },
      { start: 2, end: 4, text: '完成', color: '#007aff' },
      { start: 4, end: 6, text: '报告', color: '#ff3b30' }
    ])
  })

  it('clears only the selected color and merges adjacent equal colors', () => {
    const content = '今天完成报告'
    const ranges = [
      { start: 0, end: 2, text: '今天', color: '#ff3b30' },
      { start: 2, end: 4, text: '完成', color: '#007aff' },
      { start: 4, end: 6, text: '报告', color: '#ff3b30' }
    ]
    expect(applyNoteTextColorRange(ranges, { content, start: 2, end: 4, color: null })).toEqual([
      { start: 0, end: 2, text: '今天', color: '#ff3b30' },
      { start: 4, end: 6, text: '报告', color: '#ff3b30' }
    ])
    expect(
      applyNoteTextColorRange(ranges, { content, start: 2, end: 4, color: '#ff3b30' })
    ).toEqual([{ start: 0, end: 6, text: '今天完成报告', color: '#ff3b30' }])
  })

  it('keeps exact matches, moves unique text and drops changed or ambiguous text', () => {
    const oldContent = '今天完成报告'
    const ranges = [
      { start: 0, end: 2, text: '今天', color: '#34c759' },
      { start: 2, end: 4, text: '完成', color: '#ff3b30' },
      { start: 4, end: 6, text: '报告', color: '#007aff' }
    ]
    expect(reconcileNoteTextColorRanges(ranges, oldContent, '请在今天完成报告')).toEqual([
      { start: 2, end: 4, text: '今天', color: '#34c759' },
      { start: 4, end: 6, text: '完成', color: '#ff3b30' },
      { start: 6, end: 8, text: '报告', color: '#007aff' }
    ])
    expect(reconcileNoteTextColorRanges(ranges, oldContent, '请在今天完成周报')).toEqual([
      { start: 2, end: 4, text: '今天', color: '#34c759' },
      { start: 4, end: 6, text: '完成', color: '#ff3b30' }
    ])
    expect(
      reconcileNoteTextColorRanges(
        [{ start: 0, end: 2, text: '重复', color: '#ff3b30' }],
        '重复内容',
        '前缀重复和重复'
      )
    ).toEqual([])
  })

  it('drops invalid stored records and produces safe render segments', () => {
    const content = '颜色正文'
    const normalized = normalizeNoteTextColorRanges(
      [
        { start: 0, end: 2, text: '颜色', color: '#AF52DE' },
        { start: 2, end: 4, text: '错误', color: '#ff3b30' }
      ],
      content
    )
    expect(normalized).toEqual([{ start: 0, end: 2, text: '颜色', color: '#af52de' }])
    expect(buildNoteTextColorSegments(content, normalized)).toEqual([
      { start: 0, end: 2, text: '颜色', color: '#af52de' },
      { start: 2, end: 4, text: '正文' }
    ])
  })
})
