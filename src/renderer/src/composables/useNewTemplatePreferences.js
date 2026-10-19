import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { MAX_ASSIGNED_TAGS } from '../../../shared/tag-rules.js'

const PREFIX = 'abandon:new-template-preferences:v1:'
const FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly']

const selectedIntegers = (value, min, max, fallback) => {
  const selected = Array.isArray(value)
    ? [
        ...new Set(
          value.map(Number).filter((item) => Number.isInteger(item) && item >= min && item <= max)
        )
      ]
    : []
  return selected.length ? selected : [...fallback]
}

export function normalizeNewTemplatePreferences(value = {}, defaultTime = '09:00') {
  const dates = Array.isArray(value.yearDates)
    ? value.yearDates
        .filter((date) => {
          const month = Number(date?.month)
          const day = Number(date?.day)
          return (
            Number.isInteger(month) &&
            month >= 1 &&
            month <= 12 &&
            Number.isInteger(day) &&
            day >= 1 &&
            day <= new Date(2024, month, 0).getDate()
          )
        })
        .map((date) => ({ month: Number(date.month), day: Number(date.day) }))
    : []
  return {
    frequency: FREQUENCIES.includes(value.frequency) ? value.frequency : 'daily',
    interval: Math.min(3650, Math.max(1, Math.trunc(Number(value.interval)) || 1)),
    weekdays: selectedIntegers(value.weekdays, 1, 7, [1]),
    monthDays: selectedIntegers(value.monthDays, 1, 31, [1]),
    quarterMonth: [1, 2, 3].includes(Number(value.quarterMonth)) ? Number(value.quarterMonth) : 3,
    quarterDays: selectedIntegers(value.quarterDays, 1, 31, [31]),
    yearDates: dates.length ? dates : [{ month: 1, day: 1 }],
    timeOfDay: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value.timeOfDay))
      ? value.timeOfDay
      : defaultTime,
    // Empty is a relative choice (start on the next save), never an old saved timestamp.
    startAt: typeof value.startAt === 'string' ? value.startAt : '',
    endAt: typeof value.endAt === 'string' ? value.endAt : '',
    reminderChannels: (Number(value.reminderChannels) || 0) & 7,
    isPinned: value.isPinned === true,
    tagIds: selectedIntegers(value.tagIds, 1, Number.MAX_SAFE_INTEGER, []).slice(
      0,
      MAX_ASSIGNED_TAGS
    )
  }
}

/** Choice memory is separate from unfinished content and expires on a real app restart. */
export function useNewTemplatePreferences({ enabled = () => true, defaultTime = '09:00' } = {}) {
  const sessionId = window.api?.runtimeCapabilities?.editingDraftSessionId || crypto.randomUUID()
  const storageKey = PREFIX + sessionId
  let remembered = null
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX) && key !== storageKey) localStorage.removeItem(key)
    }
    remembered = JSON.parse(localStorage.getItem(storageKey) || 'null')
  } catch (error) {
    console.warn('[new-template-preferences] 读取本次启动的选项失败', error)
  }
  const fields = Object.fromEntries(
    Object.entries(normalizeNewTemplatePreferences(remembered || {}, defaultTime)).map(
      ([key, value]) => [key, ref(value)]
    )
  )
  watch(
    () => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.value])),
    (value) => {
      if (!enabled()) return
      remembered = normalizeNewTemplatePreferences(value, defaultTime)
      try {
        localStorage.setItem(storageKey, JSON.stringify(remembered))
      } catch (error) {
        console.warn('[new-template-preferences] 暂存本次启动的选项失败', error)
      }
    },
    { deep: true, flush: 'sync' }
  )
  let disposed = false
  let sequence = 0
  let unsubscribe
  async function removeDeletedTags() {
    if (!enabled()) return
    const request = ++sequence
    const selected = [...fields.tagIds.value]
    try {
      const tags = await window.api.listTags()
      if (
        disposed ||
        !enabled() ||
        request !== sequence ||
        JSON.stringify(selected) !== JSON.stringify(fields.tagIds.value)
      )
        return
      const available = new Set(tags.map((tag) => tag.id))
      const valid = selected.filter((id) => available.has(id))
      if (valid.length !== selected.length) fields.tagIds.value = valid
    } catch (error) {
      console.warn('[new-template-preferences] 核对记住的标签失败', error)
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
  return { fields, hasSavedChoices: () => remembered !== null }
}
