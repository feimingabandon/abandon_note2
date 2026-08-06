import { describe, expect, it } from 'vitest'
import {
  NOTE_TAG_LIMIT_MESSAGE,
  normalizeAssignedTagNames,
  requireSingleAssignedTag
} from '../src/shared/tag-rules.js'

describe('single tag assignment rules', () => {
  it('preserves order while trimming and deduplicating names', () => {
    expect(normalizeAssignedTagNames([' 重要 ', '日常', '重要', ''])).toEqual(['重要', '日常'])
  })

  it('allows zero or one tag and rejects multiple tags', () => {
    expect(requireSingleAssignedTag([])).toEqual([])
    expect(requireSingleAssignedTag(['重要'])).toEqual(['重要'])
    expect(() => requireSingleAssignedTag(['重要', '日常'])).toThrow(NOTE_TAG_LIMIT_MESSAGE)
  })
})
