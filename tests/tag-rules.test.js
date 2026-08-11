import { describe, expect, it } from 'vitest'
import {
  NOTE_TAG_LIMIT_MESSAGE,
  normalizeAssignedTagIds,
  requireSingleAssignedTagId
} from '../src/shared/tag-rules.js'

describe('single tag assignment rules', () => {
  it('preserves order while normalizing and deduplicating IDs', () => {
    expect(normalizeAssignedTagIds([3, '2', 3])).toEqual([3, 2])
    expect(() => normalizeAssignedTagIds([0])).toThrow('无效标签 ID')
  })

  it('allows zero or one tag and rejects multiple tags', () => {
    expect(requireSingleAssignedTagId([])).toEqual([])
    expect(requireSingleAssignedTagId([3])).toEqual([3])
    expect(() => requireSingleAssignedTagId([3, 4])).toThrow(NOTE_TAG_LIMIT_MESSAGE)
  })
})
