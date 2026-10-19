import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/main/db/db-connection.js', () => ({ getDb: vi.fn() }))
import { getDb } from '../src/main/db/db-connection.js'
import { runAutomaticNoteMove } from '../src/main/services/automatic-note-move.js'

describe('automatic note move admission', () => {
  beforeEach(() => vi.clearAllMocks())

  it('leaves the database untouched while disabled, including after an invalid scheduler clock', () => {
    expect(runAutomaticNoteMove({ enabled: false, now: NaN, force: true })).toEqual({
      count: 0,
      skipped: true,
      reason: 'disabled'
    })
    expect(getDb).not.toHaveBeenCalled()
  })

  it('rejects invalid active clocks before reading or mutating the database', () => {
    for (const now of [NaN, Infinity, 0, -1, 9e20]) {
      expect(() => runAutomaticNoteMove({ enabled: true, now })).toThrow('自动移动时间无效')
    }
    expect(getDb).not.toHaveBeenCalled()
  })
})
