import { mergeNoteListItem } from '../utils/noteListItem.js'
import { ref, computed, readonly } from 'vue'
import { recentLocalDayRange } from '../../../shared/calendar/calendar-date-rules.js'

/** Owns timeline snapshots, expansion intent and parent/child cancellation. */
export function useTimelineListModel({ session, api, presentation }) {
  // 日期归属与查询结果一起提交，跨午夜刷新时不提前移动旧快照中的卡片。
  const snapshotTime = ref(Date.now())
  function threeDayCutoff() {
    return recentLocalDayRange(snapshotTime.value, 3).timeFrom - 1
  }
  let earlierRequestSeq = 0
  const noteList = ref([]) // 唯一列表（置顶 + 三天 + 更早已加载）
  const timelinePinnedIds = ref(new Set()) // 与列表快照一起提交，状态动画结束前不提前换组
  const earlierIds = ref(new Set()) // 方法三写入的便签 ID（折叠时用于定点清除）
  const earlierOffset = ref(0)
  const earlierHasMore = ref(false)
  const earlierLoading = ref(false)
  const earlierHasData = ref(false) // 更早是否有数据（loadAll 时通过 count 查询获知）
  const earlierTotal = ref(0)
  const earlierLimit = ref(10) // 每次查询条数（首 10，滚动后 20）
  let timelineReloadSequence = null

  const totalRendered = computed(() => noteList.value.length)
  async function loadAllData({ showLoading = true, preserveAnchor = false } = {}) {
    const seq = session.begin({ showLoading })
    timelineReloadSequence = seq
    const loadedEarlierCount = earlierIds.value.size
    try {
      const { statuses, tagIds } = session.filters()
      const referenceTime = Date.now()
      const cutoff = recentLocalDayRange(referenceTime, 3).timeFrom - 1

      const [pinned, recent, earlierCount, activeTotal] = await Promise.all([
        api.queryPinnedNotes({ statuses, tagIds }),
        api.queryRecentNotes({ statuses, tagIds, cutoffTime: cutoff }),
        api.queryEarlierNotes({ statuses, tagIds, cutoffTime: cutoff, limit: 0, offset: 0 }),
        api.countActiveNotes()
      ])
      if (!session.isCurrent(seq)) return { status: 'cancelled' }

      // 刷新快照先在局部变量中收齐；等待 IPC 时保留所有旧卡片和列表高度。
      // 每次数据库查询最多 100 条，已滚动加载的历史范围不能在刷新后被截断。
      let earlierNotes = []
      let totalEarlier = Number(earlierCount.total) || 0
      let targetEarlierCount = preserveAnchor ? Math.max(10, loadedEarlierCount) : 10
      while (
        !collapsedGroups.value.earlier &&
        earlierNotes.length < Math.min(targetEarlierCount, totalEarlier)
      ) {
        const expansionSeq = earlierRequestSeq
        const result = await api.queryEarlierNotes({
          statuses,
          tagIds,
          cutoffTime: cutoff,
          limit: Math.min(100, targetEarlierCount - earlierNotes.length),
          offset: earlierNotes.length
        })
        if (!session.isCurrent(seq)) return { status: 'cancelled' }
        // 查询期间主动收起/重开时，丢弃旧展开周期的结果，按首批重新加载。
        if (expansionSeq !== earlierRequestSeq) {
          earlierNotes = []
          targetEarlierCount = 10
          continue
        }
        const page = result.notes || []
        totalEarlier = Number(result.total) || 0
        earlierNotes.push(...page)
        if (page.length === 0) break
      }
      if (collapsedGroups.value.earlier) earlierNotes = []
      const nextNotes = [...(pinned || []), ...(recent || []), ...earlierNotes]
      const anchor = preserveAnchor ? presentation.captureAnchor(nextNotes) : null
      const layoutBefore = preserveAnchor ? presentation.captureLayout() : null
      snapshotTime.value = referenceTime
      noteList.value = nextNotes
      timelinePinnedIds.value = new Set((pinned || []).map((note) => note.id))
      earlierIds.value = new Set(earlierNotes.map((note) => note.id))
      earlierOffset.value = earlierNotes.length
      earlierTotal.value = totalEarlier
      earlierHasData.value = totalEarlier > 0
      earlierHasMore.value = !collapsedGroups.value.earlier && earlierNotes.length < totalEarlier
      earlierLimit.value = earlierNotes.length > 0 ? 20 : 10
      session.setTotal(activeTotal)
      await presentation.restoreAnchor(anchor)
      if (!session.isCurrent(seq)) return { status: 'cancelled' }
      session.markRefreshed()
      return { status: 'success', layoutBefore }
    } catch (e) {
      console.error('[NoteList] 加载列表失败:', e)
      session.fail(seq, '列表加载失败', showLoading)
      return { status: 'error', error: e }
    } finally {
      if (timelineReloadSequence === seq) timelineReloadSequence = null
      session.finish(seq)
    }
  }

  /** 时间线模式：懒加载更早数据，追加到统一列表并记录 ID */
  async function loadEarlier() {
    if (
      timelineReloadSequence === session.sequence ||
      collapsedGroups.value.earlier ||
      earlierLoading.value ||
      !earlierHasMore.value
    )
      return
    const requestSeq = ++earlierRequestSeq
    const parentLoadSeq = session.sequence
    earlierLoading.value = true
    try {
      const { statuses, tagIds } = session.filters()
      const cutoff = threeDayCutoff()

      const result = await api.queryEarlierNotes({
        statuses,
        tagIds,
        cutoffTime: cutoff,
        limit: earlierLimit.value,
        offset: earlierOffset.value
      })
      if (requestSeq !== earlierRequestSeq || parentLoadSeq !== session.sequence) return
      const newNotes = result.notes || []
      // First expansion is owned by the disclosure, pagination by card presence.
      const before =
        newNotes.length && earlierOffset.value > 0 ? presentation.captureLayout() : null
      noteList.value = [...noteList.value, ...newNotes]
      for (const n of newNotes) {
        earlierIds.value.add(n.id)
      }
      earlierOffset.value += newNotes.length
      earlierHasMore.value = earlierOffset.value < (result.total || 0)
      // 首次加载后提升每批条数到 20
      if (earlierLimit.value === 10) {
        earlierLimit.value = 20
      }
      if (before) {
        await presentation.animatePage(before)
      }
    } catch (e) {
      console.error('[NoteList] 加载更早便签失败:', e)
    } finally {
      if (requestSeq === earlierRequestSeq) earlierLoading.value = false
    }
  }

  /** 展开更早时触发首次加载（重置 limit 到初始值） */
  function onEarlierExpand() {
    if (earlierOffset.value === 0 && !earlierLoading.value) {
      earlierLimit.value = 10
      earlierHasMore.value = true
      loadEarlier()
    }
  }

  /** 收起更早：从统一列表中移除方法三写入的便签 */
  function collapseEarlier() {
    // 折叠时作废尚未返回的分页请求，避免响应把隐藏的日期组重新插回列表。
    earlierRequestSeq++
    earlierLoading.value = false
    collapsedGroups.value['earlier'] = true
    // Keep the rendered content until the closing animation completes; reversing
    // midway reuses the same DOM and resumes from its currently displayed height.
  }

  function clearCollapsedEarlier() {
    if (!collapsedGroups.value.earlier) return
    noteList.value = noteList.value.filter((n) => !earlierIds.value.has(n.id))
    earlierIds.value = new Set()
    earlierOffset.value = 0
    earlierHasMore.value = false
    earlierLimit.value = 10
  }

  function timeGroup(ts) {
    const now = new Date(snapshotTime.value)
    const target = new Date(ts)
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const tomorrowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
    const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()
    const dayBeforeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2).getTime()
    if (target.getTime() >= tomorrowStart) return 'upcoming'
    if (target.getTime() >= todayStart) return 'today'
    if (target.getTime() >= yesterdayStart) return 'yesterday'
    if (target.getTime() >= dayBeforeStart) return 'dayBefore'
    return 'earlier'
  }

  function timelineDateKey(ts) {
    const date = new Date(ts)
    if (Number.isNaN(date.getTime())) return 'unknown'
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }

  function timelineDateLabel(ts) {
    const date = new Date(ts)
    if (Number.isNaN(date.getTime())) return '日期未知'
    const now = new Date(snapshotTime.value)
    return date.getFullYear() === now.getFullYear()
      ? `${date.getMonth() + 1}月${date.getDate()}日`
      : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
  }

  const timelineGroups = computed(() => {
    const pinned = []
    const dayMap = { upcoming: [], today: [], yesterday: [], dayBefore: [] }
    const earlier = []

    for (const note of noteList.value) {
      // 置顶归属随完整快照一起更新，避免先换组、数据返回后再移动一次。
      if (timelinePinnedIds.value.has(note.id)) {
        pinned.push(note)
      } else {
        const g = timeGroup(note.effective_at)
        if (g === 'earlier') {
          earlier.push(note)
        } else if (dayMap[g]) {
          dayMap[g].push(note)
        }
      }
    }

    const earlierDateGroups = []
    const earlierDateMap = new Map()
    for (const note of earlier) {
      const key = timelineDateKey(note.effective_at)
      let group = earlierDateMap.get(key)
      if (!group) {
        group = {
          group: `date-${key}`,
          label: timelineDateLabel(note.effective_at),
          items: []
        }
        earlierDateMap.set(key, group)
        earlierDateGroups.push(group)
      }
      group.items.push(note)
    }

    const all = [
      { group: 'pinned', label: '置顶', items: pinned },
      { group: 'upcoming', label: '未来', items: dayMap.upcoming },
      { group: 'today', label: '今天', items: dayMap.today },
      { group: 'yesterday', label: '昨天', items: dayMap.yesterday },
      { group: 'dayBefore', label: '前天', items: dayMap.dayBefore },
      { group: 'earlier', label: '更早', items: [], count: earlierTotal.value },
      ...earlierDateGroups
    ]

    const filtered = all.filter((g) => {
      if (g.group === 'earlier') return earlierHasData.value
      return g.items.length > 0
    })

    let acc = 0
    for (const grp of filtered) {
      grp.offset = acc
      acc += grp.items.length
    }
    return filtered
  })

  /** “更早”可能尚未展开，因此同时检查它的总数。 */
  const timelineIsEmpty = computed(() => totalRendered.value === 0 && !earlierHasData.value)
  const recentTimelineGroups = computed(() =>
    timelineGroups.value.filter((g) => !g.group.startsWith('date-'))
  )
  const earlierTimelineGroups = computed(() =>
    timelineGroups.value.filter((g) => g.group.startsWith('date-'))
  )

  /** 更早折叠状态 */
  const collapsedGroups = ref({ earlier: false })

  /** 更早展开/折叠 */
  function toggleGroupCollapse(groupKey) {
    if (groupKey !== 'earlier') return
    if (!collapsedGroups.value['earlier']) {
      collapseEarlier()
    } else {
      collapsedGroups.value['earlier'] = false
      onEarlierExpand()
    }
  }

  session.onInvalidate(() => {
    earlierRequestSeq++
    earlierLoading.value = false
  })
  function patchNote(updated) {
    noteList.value = noteList.value.map((note) =>
      note.id === updated.id ? mergeNoteListItem(note, updated) : note
    )
  }
  function replaceItems(notes) {
    noteList.value = notes
  }
  return {
    noteList: readonly(noteList),
    earlierOffset: readonly(earlierOffset),
    earlierHasMore: readonly(earlierHasMore),
    earlierLoading: readonly(earlierLoading),
    earlierHasData: readonly(earlierHasData),
    earlierTotal: readonly(earlierTotal),
    collapsedGroups: readonly(collapsedGroups),
    timelineGroups,
    totalRendered,
    timelineIsEmpty,
    recentTimelineGroups,
    earlierTimelineGroups,
    load: loadAllData,
    loadEarlier,
    onEarlierExpand,
    collapseEarlier,
    clearCollapsedEarlier,
    toggleGroupCollapse,
    patchNote,
    replaceItems
  }
}
