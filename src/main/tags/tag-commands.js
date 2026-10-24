import {
  bindTag,
  createTag,
  deleteTag,
  getNoteTags,
  setNoteTagIds,
  unbindTag,
  updateTag,
  updateTagOrder
} from '../db/db-tags.js'

/**
 * Own complete tag mutations and their ordered post-commit notifications.
 * DB functions remain the sole owner of validation, transactions and tag rules;
 * IPC retains sender authorization, mutation admission and broadcast transport.
 */
export function createTagCommands({ broadcastTagChange, broadcastNoteChange }) {
  return Object.freeze({
    create({ name, color }) {
      const tag = createTag(name, color)
      return broadcastTagChange('create', tag, { tag })
    },
    update({ id, fields }) {
      const result = updateTag(id, fields)
      broadcastTagChange('update', result, { tag: result.tag, oldName: result.oldName })
      broadcastNoteChange('tag', true, { tagId: result.tag.id })
      return result.tag
    },
    delete({ id }) {
      const deleted = deleteTag(id)
      if (deleted) {
        broadcastTagChange('delete', true, { id: Number(id) })
        broadcastNoteChange('tag', true, { tagId: Number(id) })
      }
      return deleted
    },
    reorder({ tagIds }) {
      const tags = updateTagOrder(tagIds)
      const normalizedTagIds = Array.isArray(tagIds) ? tagIds.map(Number) : []
      return broadcastTagChange('reorder', tags, { tagIds: normalizedTagIds })
    },
    bind({ noteId, tagId }) {
      return broadcastNoteChange('tag', bindTag(noteId, tagId), { id: noteId, tagId })
    },
    unbind({ noteId, tagId }) {
      return broadcastNoteChange('tag', unbindTag(noteId, tagId), { id: noteId, tagId })
    },
    setNoteTags({ noteId, tagIds }) {
      setNoteTagIds(noteId, tagIds)
      const tags = getNoteTags(noteId)
      broadcastNoteChange('tag', true, { id: noteId })
      return tags
    }
  })
}
