import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NOTE_DURATION_KINDS } from '../../../shared/calendar/calendar-date-rules.js'
import { MAX_ASSIGNED_TAGS } from '../../../shared/tag-rules.js'

const prefix = 'abandon:new-note-preferences:v1:'
const sessionId = window.api?.runtimeCapabilities?.editingDraftSessionId || crypto.randomUUID()
const storageKey = prefix + sessionId
const defaults = () => ({
  durationKind: NOTE_DURATION_KINDS.SINGLE_DAY,
  durationDays: 1,
  statusChoice: 'in_progress',
  reminderChannels: 0,
  isPinned: false,
  tagIds: []
})
let preferences = defaults()
try {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(prefix) && key !== storageKey) localStorage.removeItem(key)
  }
  const saved = JSON.parse(localStorage.getItem(storageKey) || 'null')
  if (saved) {
    preferences = {
      durationKind: Object.values(NOTE_DURATION_KINDS).includes(saved.durationKind)
        ? saved.durationKind
        : NOTE_DURATION_KINDS.SINGLE_DAY,
      durationDays: Math.min(365, Math.max(1, Math.trunc(Number(saved.durationDays)) || 1)),
      statusChoice: saved.statusChoice === 'completed' ? 'completed' : 'in_progress',
      reminderChannels: (Number(saved.reminderChannels) || 0) & 7,
      isPinned: saved.isPinned === true,
      tagIds: Array.isArray(saved.tagIds)
        ? [...new Set(saved.tagIds.filter((id) => Number.isInteger(id) && id > 0))].slice(
            0,
            MAX_ASSIGNED_TAGS
          )
        : []
    }
  }
} catch (error) {
  console.warn('[new-note-preferences] 读取本次启动的选项失败', error)
}

// Independent from editing drafts: content, attachments and schedule never enter
// this record. The main-process launch ID also survives main-view page reloads.
export function useNewNotePreferences() {
  const fields = Object.fromEntries(
    Object.entries(preferences).map(([key, value]) => [
      key,
      ref(Array.isArray(value) ? [...value] : value)
    ])
  )
  watch(
    () => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.value])),
    (value) => {
      preferences = { ...value, tagIds: [...value.tagIds] }
      try {
        localStorage.setItem(storageKey, JSON.stringify(preferences))
      } catch (error) {
        console.warn('[new-note-preferences] 暂存本次启动的选项失败', error)
      }
    },
    { deep: true, flush: 'sync' }
  )
  let disposed = false
  let sequence = 0
  let unsubscribe
  async function removeDeletedTags() {
    const request = ++sequence
    const selected = [...fields.tagIds.value]
    try {
      const tags = await window.api.listTags()
      if (
        disposed ||
        request !== sequence ||
        JSON.stringify(selected) !== JSON.stringify(fields.tagIds.value)
      )
        return
      const available = new Set(tags.map((tag) => tag.id))
      const valid = selected.filter((id) => available.has(id))
      if (valid.length !== selected.length) fields.tagIds.value = valid
    } catch (error) {
      console.warn('[new-note-preferences] 核对记住的标签失败', error)
    }
  }
  onMounted(() => {
    void removeDeletedTags()
    unsubscribe = window.api.onTagsChanged?.(removeDeletedTags)
  })
  onBeforeUnmount(() => {
    disposed = true
    unsubscribe?.()
  })
  return fields
}
