import { ref, computed, readonly, toRaw } from 'vue'
import { mergeNoteListItem } from '../utils/noteListItem.js'

/** Owns group snapshots, current expansion intent and page requests as one domain. */
export function useTagGroupListModel({ session, api, presentation }) {
  const TAG_GROUP_INITIAL_LIMIT = 10,
    TAG_GROUP_MORE_LIMIT = 20
  const tagGroups = ref([]),
    expandedTagGroupKeys = new Set()
  let tagGroupGeneration = 0
  session.onInvalidate(() => {
    tagGroupGeneration++
  })
  function activeStatuses() {
    return session.filters().statuses
  }
  function ownedGroup(group) {
    return tagGroups.value.find((item) => item.key === group?.key)
  }
  const tagGroupMatchingTotal = computed(() =>
    tagGroups.value.reduce((total, group) => total + group.total, 0)
  )
  const tagGroupCanSort = computed(
    () => tagGroups.value.filter((group) => !group.untagged).length > 1
  )

  async function loadTagGroupPage(group, { reset = false, limit = null } = {}) {
    group = ownedGroup(group)
    if (!group || group.loading) return { status: 'cancelled' }
    const generation = tagGroupGeneration
    const offset = reset ? 0 : group.notes.length
    const pageLimit = limit || (reset ? TAG_GROUP_INITIAL_LIMIT : TAG_GROUP_MORE_LIMIT)
    group.requestedCount = offset + pageLimit
    group.loading = true
    group.error = null
    try {
      const result = await api.queryTagGroupNotes({
        tagId: group.untagged ? null : group.id,
        statuses: activeStatuses(),
        limit: pageLimit,
        offset
      })
      if (generation !== tagGroupGeneration || !tagGroups.value.includes(group)) {
        return { status: 'cancelled' }
      }
      const before = !reset && group.expanded ? presentation.captureLayout() : null
      const notes = result.notes || []
      group.notes = reset ? notes : [...group.notes, ...notes]
      group.total = Number(result.total) || 0
      group.hasMore = group.notes.length < group.total
      delete group.requestedCount
      if (before) {
        await presentation.animatePage(
          before,
          () => generation === tagGroupGeneration && group.expanded
        )
      }
      return { status: 'success' }
    } catch (error) {
      delete group.requestedCount
      console.error('[NoteList] 加载标签组便签失败:', group.name, error)
      if (generation === tagGroupGeneration) group.error = '加载失败'
      return { status: 'error', error }
    } finally {
      // 刷新期间仍保留旧分组，已取消的旧请求也必须释放它自己的加载状态。
      group.loading = false
    }
  }

  async function loadTagGroupsData({ showLoading = true, preserveAnchor = false } = {}) {
    const seq = session.begin({ showLoading })
    const generation = tagGroupGeneration
    const isCurrent = () => session.isCurrent(seq) && generation === tagGroupGeneration
    try {
      const { tagIds, statuses } = session.filters()
      const [groups, activeTotal] = await Promise.all([
        api.queryTagGroups({ statuses, tagIds }),
        api.countActiveNotes()
      ])
      if (!isCurrent()) return { status: 'cancelled' }

      // 后台查询只构造局部快照，不清空已显示的卡片，也不提前改变列表高度。
      const nextGroups = (groups || []).map((group) => ({
        ...group,
        notes: [],
        opening: false,
        openingRequest: 0,
        loading: false,
        error: null
      }))
      const exhausted = new Set()
      const targetCount = (group) => {
        if (!expandedTagGroupKeys.has(group.key) || exhausted.has(group.key)) return 0
        const current = tagGroups.value.find((item) => item.key === group.key)
        return Math.min(
          Number(group.total) || 0,
          Math.max(
            TAG_GROUP_INITIAL_LIMIT,
            current?.notes.length || 0,
            current?.requestedCount || 0
          )
        )
      }
      while (true) {
        const pendingGroups = nextGroups.filter((group) => group.notes.length < targetCount(group))
        if (pendingGroups.length === 0) break
        await Promise.all(
          pendingGroups.map(async (group) => {
            const result = await api.queryTagGroupNotes({
              tagId: group.untagged ? null : group.id,
              statuses,
              limit: Math.min(100, targetCount(group) - group.notes.length),
              offset: group.notes.length
            })
            if (!isCurrent()) return
            const page = result.notes || []
            group.notes.push(...page)
            group.total = Number(result.total) || 0
            if (page.length === 0) exhausted.add(group.key)
          })
        )
        if (!isCurrent()) return { status: 'cancelled' }
        // 等待期间用户可能展开/收起或加载更多，按最新意图补齐，不能覆盖用户操作。
      }
      if (!isCurrent()) return { status: 'cancelled' }
      for (const group of nextGroups) {
        group.expanded = expandedTagGroupKeys.has(group.key)
        group.hasMore = group.notes.length < Number(group.total)
      }
      const nextNotes = nextGroups.filter((group) => group.expanded).flatMap((group) => group.notes)
      const anchor = preserveAnchor ? presentation.captureAnchor(nextNotes) : null
      const layoutBefore = preserveAnchor ? presentation.captureLayout() : null
      tagGroups.value = nextGroups
      session.setTotal(activeTotal)
      await presentation.restoreAnchor(anchor)
      if (!isCurrent()) return { status: 'cancelled' }
      session.markRefreshed()
      return { status: 'success', layoutBefore }
    } catch (error) {
      console.error('[NoteList] 加载标签分组失败:', error)
      session.fail(seq, '标签分组加载失败', showLoading)
      return { status: 'error', error }
    } finally {
      session.finish(seq)
    }
  }

  async function toggleTagGroup(group) {
    group = ownedGroup(group)
    if (!group) return
    if (group.expanded) {
      group.expanded = false
      expandedTagGroupKeys.delete(group.key)
      return
    }

    group.expanded = true
    expandedTagGroupKeys.add(group.key)
    if (group.opening) return
    if (group.notes.length === 0 && group.total > 0) {
      // 先记录展开意图，后台快照即使先返回也能接续这次展开。
      const openingRequest = ++group.openingRequest
      group.opening = true
      try {
        await loadTagGroupPage(group, { reset: true })
      } finally {
        if (group.openingRequest === openingRequest) group.opening = false
      }
    }
  }

  function collapseAllTagGroups() {
    expandedTagGroupKeys.clear()
    tagGroups.value.forEach((group) => {
      if (group.opening) group.openingRequest++
      group.opening = false
      group.expanded = false
    })
  }

  function normalizeUntaggedLast() {
    const untagged = tagGroups.value.find((group) => group.untagged)
    if (!untagged) return
    tagGroups.value = [...tagGroups.value.filter((group) => !group.untagged), untagged]
  }

  function replaceGroups(groups) {
    tagGroups.value = groups.map((group) => toRaw(group))
  }
  function patchNote(updated) {
    const group = tagGroups.value.find((item) => item.notes.some((note) => note.id === updated.id))
    const key = updated.tags?.[0]?.id ? `tag:${updated.tags[0].id}` : 'untagged'
    if (!group || group.key !== key) return false
    group.notes = group.notes.map((note) =>
      note.id === updated.id ? mergeNoteListItem(note, updated) : note
    )
    return true
  }
  function orderedTagIds() {
    normalizeUntaggedLast()
    return tagGroups.value.filter((group) => !group.untagged).map((group) => Number(group.id))
  }
  return {
    tagGroups: readonly(tagGroups),
    tagGroupMatchingTotal,
    tagGroupCanSort,
    load: loadTagGroupsData,
    loadPage: loadTagGroupPage,
    toggleGroup: toggleTagGroup,
    collapseAll: collapseAllTagGroups,
    replaceGroups,
    patchNote,
    orderedTagIds
  }
}
