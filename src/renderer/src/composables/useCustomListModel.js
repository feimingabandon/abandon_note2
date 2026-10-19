import { mergeNoteListItem } from '../utils/noteListItem.js'
import { ref, computed, readonly } from 'vue'

// Match the database query cap while rebuilding an already browsed normal range.
const MAX_CUSTOM_REFRESH_PAGE_SIZE = 100

/** Custom sorting and normal paging intentionally retain their own policies. */
export function useCustomListModel({ session, api, presentation }) {
  let customMoreRequestSeq = 0
  let customReloadSequence = null
  const customList = ref([]) // 唯一列表（置顶 + 日常已加载）
  const customNormalOffset = ref(0)
  const customNormalHasMore = ref(false)
  const customNormalTotal = ref(0)
  const customNormalLimit = ref(10) // 首 10，滚动后 20
  const customNormalLoading = ref(false)

  async function loadCustomData({ showLoading = true, preserveAnchor = false } = {}) {
    if (session.disposed) return { status: 'cancelled' }
    const seq = session.begin({ showLoading })
    customReloadSequence = seq
    try {
      const { statuses, tagIds } = session.filters()

      const normalLimit = preserveAnchor
        ? Math.max(customNormalOffset.value, customNormalLimit.value)
        : customNormalLimit.value
      const [pinned, normalCount, activeTotal] = await Promise.all([
        api.queryCustomPinned({ statuses, tagIds }),
        api.queryCustomNormal({
          statuses,
          tagIds,
          limit: Math.min(normalLimit, MAX_CUSTOM_REFRESH_PAGE_SIZE),
          offset: 0
        }),
        api.countActiveNotes()
      ])
      if (!session.isCurrent(seq)) return { status: 'cancelled' }

      let normalNotes = normalCount.notes || []
      let normalTotal = normalCount.total || 0
      while (normalNotes.length < Math.min(normalLimit, normalTotal)) {
        const page = await api.queryCustomNormal({
          statuses,
          tagIds,
          limit: Math.min(
            MAX_CUSTOM_REFRESH_PAGE_SIZE,
            Math.min(normalLimit, normalTotal) - normalNotes.length
          ),
          offset: normalNotes.length
        })
        if (!session.isCurrent(seq)) return { status: 'cancelled' }
        normalTotal = page.total || 0
        if (!page.notes?.length) break
        normalNotes = [...normalNotes, ...page.notes]
      }
      // A deletion between pages can shrink the target below the pages already read.
      normalNotes = normalNotes.slice(0, Math.min(normalLimit, normalTotal))
      // Query waits leave the old list scrollable; the latest reading position owns restoration.
      const anchor = preserveAnchor ? presentation.captureAnchor() : null
      customList.value = [...(pinned || []), ...normalNotes]
      customNormalOffset.value = normalNotes.length
      customNormalTotal.value = normalTotal
      customNormalHasMore.value = customNormalOffset.value < customNormalTotal.value
      session.setTotal(activeTotal)
      await presentation.restoreAnchor(anchor)
      if (!session.isCurrent(seq)) return { status: 'cancelled' }
      session.markRefreshed()
      return { status: 'success' }
    } catch (e) {
      console.error('[NoteList] 加载自定义列表失败:', e)
      session.fail(seq, '列表加载失败', showLoading)
      return { status: 'error', error: e }
    } finally {
      if (customReloadSequence === seq) customReloadSequence = null
      session.finish(seq)
    }
  }

  /** 自定义模式：滚动加载更多日常 */
  async function loadCustomMore() {
    if (
      session.disposed ||
      customReloadSequence === session.sequence ||
      customNormalLoading.value ||
      !customNormalHasMore.value
    )
      return
    const requestSeq = ++customMoreRequestSeq
    const parentLoadSeq = session.sequence
    customNormalLoading.value = true
    try {
      const { statuses, tagIds } = session.filters()

      const result = await api.queryCustomNormal({
        statuses,
        tagIds,
        limit: customNormalLimit.value,
        offset: customNormalOffset.value
      })
      if (requestSeq !== customMoreRequestSeq || !session.isCurrent(parentLoadSeq)) return
      const newNotes = result.notes || []
      const before = newNotes.length ? presentation.captureLayout() : null
      customList.value = [...customList.value, ...newNotes]
      customNormalOffset.value += newNotes.length
      customNormalTotal.value = result.total || 0
      customNormalHasMore.value = customNormalOffset.value < customNormalTotal.value
      if (customNormalLimit.value === 10) {
        customNormalLimit.value = 20
      }
      if (before) {
        await presentation.animatePage(before)
      }
    } catch (e) {
      console.error('[NoteList] 加载更多日常便签失败:', e)
    } finally {
      if (requestSeq === customMoreRequestSeq) customNormalLoading.value = false
    }
  }

  function assignExistingSortSlots(list) {
    const slots = list.map((note) => Number(note.sort_order)).sort((a, b) => a - b)
    list.forEach((note, index) => {
      note.sort_order = slots[index]
    })
  }

  async function persistSortOrder(list) {
    try {
      await api.updateCustomSortOrders(
        list.map((note) => ({ id: note.id, sortOrder: note.sort_order }))
      )
    } catch (e) {
      console.error('[NoteList] sort_order 持久化失败，重新加载数据库顺序:', e)
      await loadCustomData({ showLoading: false, preserveAnchor: true })
    }
  }

  const customTotalRendered = computed(() => customList.value.length)
  session.onInvalidate(() => {
    customMoreRequestSeq++
    customNormalLoading.value = false
  })
  async function reorderZone(pinned, orderedNotes) {
    const ordered = orderedNotes.map((note) => ({ ...note }))
    assignExistingSortSlots(ordered)
    const other = customList.value.filter((note) => Boolean(note.is_pinned) !== pinned)
    customList.value = pinned ? [...ordered, ...other] : [...other, ...ordered]
    await persistSortOrder(ordered)
  }
  function patchNote(updated) {
    customList.value = customList.value.map((note) =>
      note.id === updated.id ? mergeNoteListItem(note, updated) : note
    )
  }
  function replaceItems(notes) {
    customList.value = notes
  }
  return {
    customList: readonly(customList),
    customNormalHasMore: readonly(customNormalHasMore),
    customNormalTotal: readonly(customNormalTotal),
    customNormalLoading: readonly(customNormalLoading),
    customTotalRendered,
    load: loadCustomData,
    loadMore: loadCustomMore,
    patchNote,
    replaceItems,
    reorderZone
  }
}
