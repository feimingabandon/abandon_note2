import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  inTransaction: false,
  note: null,
  transaction: vi.fn((body) => () => {
    state.inTransaction = true
    try {
      return body()
    } finally {
      state.inTransaction = false
    }
  }),
  updateNote: vi.fn(),
  updateSnapshots: vi.fn()
}))
vi.mock('../src/main/db/db-connection.js', () => ({
  getDb: () => ({ transaction: state.transaction })
}))
vi.mock('../src/main/db/db-notes.js', () => ({
  getNoteById: () => state.note,
  updateNote: state.updateNote
}))
vi.mock('../src/main/db/db-desktop-stickies.js', () => ({
  updateDesktopStickyContentsByNoteId: state.updateSnapshots
}))

import { saveStickyNoteContent } from '../src/main/notes/sticky-note-commands.js'

beforeEach(() => {
  vi.clearAllMocks()
  state.note = { id: 7, content: 'current text' }
  state.updateNote.mockImplementation((id, { content }) => {
    expect(state.inTransaction).toBe(true)
    return { id, content }
  })
  state.updateSnapshots.mockImplementation(() => {
    expect(state.inTransaction).toBe(true)
    return 2
  })
})
const save = (patch = {}) =>
  saveStickyNoteContent({
    noteId: 7,
    content: 'submitted text',
    expectedContent: 'current text',
    updatedAt: 100,
    ...patch
  })

describe('sticky text command port with controlled repository fixtures', () => {
  it('updates the note and every persisted snapshot inside one synchronous command transaction', () => {
    expect(save()).toEqual({ conflict: false, note: { id: 7, content: 'submitted text' } })
    expect(state.transaction).toHaveBeenCalledTimes(1)
    expect(state.updateSnapshots).toHaveBeenCalledExactlyOnceWith(7, 'submitted text', 100)
    expect(state.inTransaction).toBe(false)
  })

  it('compares expected text, leaves the note intact on conflict and repairs persisted snapshots', () => {
    expect(save({ expectedContent: 'old text' })).toEqual({
      conflict: true,
      content: 'current text'
    })
    expect(state.updateNote).not.toHaveBeenCalled()
    expect(state.updateSnapshots).toHaveBeenCalledExactlyOnceWith(7, 'current text', 100)
  })

  it('refuses a missing source before mutating sticky snapshots', () => {
    state.note = null
    expect(() => save()).toThrow('来源便签不存在或已被删除')
    expect(state.updateNote).not.toHaveBeenCalled()
    expect(state.updateSnapshots).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'rejects a missing persisted sticky in the conflict=%s branch',
    (conflict) => {
      state.updateSnapshots.mockReturnValueOnce(0)
      expect(() => save(conflict ? { expectedContent: 'old text' } : {})).toThrow(
        '便利贴记录不存在'
      )
      expect(state.inTransaction).toBe(false)
    }
  )
})
