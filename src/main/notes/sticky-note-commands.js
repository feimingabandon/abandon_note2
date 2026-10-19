import { getDb } from '../db/db-connection.js'
import { getNoteById, updateNote } from '../db/db-notes.js'
import { updateDesktopStickyContentsByNoteId } from '../db/db-desktop-stickies.js'

/** Text comparison is the sticky editor contract, distinct from draft editVersion.
 * The caller owns window synchronization and broadcasts after this transaction.
 */
export function saveStickyNoteContent({ noteId, content, expectedContent, updatedAt }) {
  return getDb().transaction(() => {
    const currentNote = getNoteById(noteId)
    if (!currentNote) throw new Error('来源便签不存在或已被删除')
    if (currentNote.content !== expectedContent) {
      if (updateDesktopStickyContentsByNoteId(noteId, currentNote.content, updatedAt) < 1) {
        throw new Error('便利贴记录不存在')
      }
      return { conflict: true, content: currentNote.content }
    }
    const updatedNote = updateNote(noteId, { content })
    if (!updatedNote) throw new Error('来源便签不存在或已被删除')
    if (updateDesktopStickyContentsByNoteId(noteId, content, updatedAt) < 1) {
      throw new Error('便利贴记录不存在')
    }
    return { conflict: false, note: updatedNote }
  })()
}
