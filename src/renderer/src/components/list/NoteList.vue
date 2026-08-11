<script setup>
/**
 * NoteList.vue — 便签列表（时间线、自定义拖拽、标签分组三种模式）
 *
 * 3.5 + 3.6: 新增自定义拖拽模式，集成 vuedraggable
 * - 三状态：initialized / in_progress / completed
 */
import { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import draggable from 'vuedraggable'
import TagSelector from '../ui/TagSelector.vue'
import FilterTabs from '../ui/FilterTabs.vue'
import NoteCard from './NoteCard.vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import { DEFAULT_SETTINGS } from '../../../../shared/settings-schema.js'
import { useNotePresenceMotion } from '../../composables/useNotePresenceMotion.js'
import { enterPopover, leavePopover } from '../../utils/popoverMotion.js'

const emit = defineEmits(['edit'])

/** 排序模式：timeline | custom | tag-group */
const sortMode = ref(DEFAULT_SETTINGS.listFilter.listMode)

/** 排序模式显示文本 */
const modeOptions = [
  { value: 'timeline', label: '时间线' },
  { value: 'custom', label: '自定义' },
  { value: 'tag-group', label: '标签分组' }
]
const sortModeLabel = computed(
  () => modeOptions.find((option) => option.value === sortMode.value)?.label || '时间线'
)
const modeMenuOpen = ref(false)
const modeMenuRootRef = ref(null)
const modeToggleRef = ref(null)

/** 三种模式使用完整的依次离场、切换、依次进场。 */
let modeSwitchRunning = false
let modePresenceSwitching = false
async function selectSortMode(nextMode) {
  modeMenuOpen.value = false
  if (nextMode === sortMode.value || modeSwitchRunning || replayRefreshRunning) return
  modeSwitchRunning = true
  const previousMode = sortMode.value
  const previousTimeline = noteList.value
  const previousCustom = customList.value
  const previousTagGroups = tagGroups.value
  const switchSeq = ++presenceMotionSeq
  try {
    await animateCurrentCardsOut({ includeAuxiliary: true })
    if (switchSeq !== presenceMotionSeq) {
      cancelCurrentPresenceExits()
      return
    }

    // 只清空即将进入的目标列表；源列表保留为失败回滚快照。
    if (nextMode === 'timeline') {
      noteList.value = []
    } else if (nextMode === 'custom') {
      customList.value = []
      syncCustomZones()
    } else {
      tagGroups.value = []
    }
    await nextTick()

    modePresenceSwitching = true
    sortMode.value = nextMode
    await nextTick()
    const result = await switchMode(nextMode, { showLoading: false, preserveAnchor: false }, false)
    if (result?.status !== 'success') {
      noteList.value = previousTimeline
      customList.value = previousCustom
      tagGroups.value = previousTagGroups
      syncCustomZones()
      sortMode.value = previousMode
      await nextTick()
      animateAuxiliaryIn()
      animateRetainedCards(new Map())
      return
    }
    if (switchSeq !== presenceMotionSeq) {
      cancelCurrentPresenceExits()
      return
    }
    await nextTick()
    animateAuxiliaryIn()
    animateRetainedCards(new Map())
  } finally {
    modePresenceSwitching = false
    modeSwitchRunning = false
  }
}

function toggleModeMenu() {
  if (modeSwitchRunning || replayRefreshRunning) return
  modeMenuOpen.value = !modeMenuOpen.value
}

function onModeMenuOutside(event) {
  if (modeMenuOpen.value && !modeMenuRootRef.value?.contains(event.target)) {
    modeMenuOpen.value = false
  }
}

function onModeMenuKeydown(event) {
  if (event.key !== 'Escape' || !modeMenuOpen.value) return
  modeMenuOpen.value = false
  modeToggleRef.value?.focus()
}

// 筛选面板 chip 的轻量错峰；便签本身的进出场由列表 ID 差分协调器统一处理。
const STAGGER_STEP = 28 // 首屏轻量错峰，保持列表出现迅速
const STAGGER_MAX = 7 // 只错峰前 8 张，长列表不再等待
/**
 * 按全局序号计算卡片入场动画延迟（等差递增，与新建面板一致）。
 */
function staggerDelay(index) {
  return Math.min(index, STAGGER_MAX) * STAGGER_STEP + 'ms'
}
/** 便签列表 */
/** 加载状态 */
const loading = ref(false)
const loadError = ref(null)
/** 全部未删除便签总数，不受当前标签/状态筛选影响。 */
const allNoteTotal = ref(0)
const lastRefreshedAt = ref(null)
const lastRefreshLabel = computed(() => formatRefreshTime(lastRefreshedAt.value))
const timelineScrollRef = ref(null)
const customScrollRef = ref(null)
const tagGroupScrollRef = ref(null)

function currentScrollContainer() {
  if (sortMode.value === 'timeline') return timelineScrollRef.value
  if (sortMode.value === 'custom') return customScrollRef.value
  return tagGroupScrollRef.value
}

function formatRefreshTime(timestamp) {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':')
}

/** 标签筛选 ID 列表 */
const tagFilterIds = ref([...DEFAULT_SETTINGS.listFilter.tagIds])

/** 筛选面板状态：tags | taiji | status（taiji=太极图默认折叠态） */
const panelState = ref('taiji')

/** 状态筛选列表 */
const statusFilter = ref([...DEFAULT_SETTINGS.listFilter.statusFilter])

/** FilterTabs 选项 */
const panelOptions = [
  { value: 'tags', label: '按标签筛选' },
  { value: 'taiji', label: '刷新并收起筛选' },
  { value: 'status', label: '按状态筛选' }
]

/** 面板点击：单选 + 展开/收起逻辑 */
function onPanelClick(value) {
  if (value === 'taiji') {
    panelState.value = 'taiji'
    replayListRefresh()
    return
  }
  if (panelState.value === value) {
    panelState.value = 'taiji'
  } else {
    panelState.value = value
  }
}

/** 状态筛选项 */
const statusOptions = [
  { value: 'initialized', label: '初始化' },
  { value: 'in_progress', label: '进行中' },
  { value: 'completed', label: '完成' }
]

/** 切换状态筛选 */
function toggleStatus(value) {
  const idx = statusFilter.value.indexOf(value)
  if (idx === -1) {
    statusFilter.value = [...statusFilter.value, value]
  } else {
    statusFilter.value = statusFilter.value.filter((s) => s !== value)
  }
}

// ============================================================
// 数据加载
// ============================================================

/** 请求令牌：并发加载时只接受最新一次结果，避免旧请求覆盖新数据 */
let loadSeq = 0
let earlierRequestSeq = 0
let customMoreRequestSeq = 0

/** 三天截止时间戳（毫秒）：今天 23:59:59 倒推 3×24h 再减 1 秒 */
function threeDayCutoff() {
  const now = new Date()
  const todayEnd = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999
  ).getTime()
  return todayEnd - 3 * 24 * 60 * 60 * 1000 - 1000
}

// ---- 时间线模式：单一统一列表 ----
const noteList = ref([]) // 唯一列表（置顶 + 三天 + 更早已加载）
const earlierIds = ref(new Set()) // 方法三写入的便签 ID（折叠时用于定点清除）
const earlierOffset = ref(0)
const earlierHasMore = ref(false)
const earlierLoading = ref(false)
const earlierHasData = ref(false) // 更早是否有数据（loadAll 时通过 count 查询获知）
const earlierTotal = ref(0)
const earlierLimit = ref(10) // 每次查询条数（首 10，滚动后 20）

/** 时间线模式：并行加载置顶 + 三天 + 更早计数，合并到单一列表 */
function captureScrollAnchor() {
  const container = currentScrollContainer()
  if (!container) return null
  const containerTop = container.getBoundingClientRect().top
  const cards = [...container.querySelectorAll('[data-note-id]')]
  const card = cards.find((item) => item.getBoundingClientRect().bottom > containerTop)
  return card
    ? { id: card.dataset.noteId, offset: card.getBoundingClientRect().top - containerTop }
    : { id: null, scrollTop: container.scrollTop }
}

async function restoreScrollAnchor(anchor) {
  if (!anchor) return
  await nextTick()
  const container = currentScrollContainer()
  if (!container) return
  if (!anchor.id) {
    container.scrollTop = anchor.scrollTop || 0
    return
  }
  const card = [...container.querySelectorAll('[data-note-id]')].find(
    (item) => item.dataset.noteId === anchor.id
  )
  if (!card) return
  const containerTop = container.getBoundingClientRect().top
  container.scrollTop += card.getBoundingClientRect().top - containerTop - anchor.offset
}

async function loadAll({ showLoading = true, preserveAnchor = false } = {}) {
  const seq = ++loadSeq
  tagGroupGeneration++
  loadError.value = null
  earlierRequestSeq++
  customMoreRequestSeq++
  earlierLoading.value = false
  customNormalLoading.value = false
  const anchor = preserveAnchor ? captureScrollAnchor() : null
  const loadedEarlierCount = earlierIds.value.size
  if (showLoading) loading.value = true
  try {
    const statuses =
      statusFilter.value.length > 0
        ? [...statusFilter.value]
        : ['initialized', 'in_progress', 'completed']
    const tagIds = tagFilterIds.value.length > 0 ? [...tagFilterIds.value] : null
    const cutoff = threeDayCutoff()

    const [pinned, recent, earlierCount, activeTotal] = await Promise.all([
      window.api.queryPinnedNotes({ statuses, tagIds }),
      window.api.queryRecentNotes({ statuses, tagIds, cutoffTime: cutoff }),
      window.api.queryEarlierNotes({ statuses, tagIds, cutoffTime: cutoff, limit: 0, offset: 0 }),
      window.api.countActiveNotes()
    ])
    if (seq !== loadSeq) return { status: 'cancelled' }

    // 合并到单一列表：置顶在前，三天在后
    noteList.value = [...(pinned || []), ...(recent || [])]
    // 重置更早运行时状态（数据已清空，需按当前展开状态重新加载）
    earlierIds.value = new Set()
    earlierOffset.value = 0
    earlierHasMore.value = false
    earlierTotal.value = earlierCount.total || 0
    earlierHasData.value = earlierTotal.value > 0
    allNoteTotal.value = Number(activeTotal) || 0
    // 如果更早之前是展开的，自动重新加载
    if (!collapsedGroups.value['earlier'] && earlierHasData.value) {
      earlierHasMore.value = true
      if (preserveAnchor) {
        earlierLimit.value = Math.max(10, loadedEarlierCount)
        await loadEarlier()
        earlierLimit.value = 20
      } else {
        loadEarlier() // 不 await，后台加载
      }
    }
    await restoreScrollAnchor(anchor)
    lastRefreshedAt.value = Date.now()
    return { status: 'success' }
  } catch (e) {
    console.error('[NoteList] 加载列表失败:', e)
    if (seq === loadSeq && showLoading) loadError.value = '列表加载失败'
    return { status: 'error', error: e }
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

/** 时间线模式：懒加载更早数据，追加到统一列表并记录 ID */
async function loadEarlier() {
  if (earlierLoading.value || !earlierHasMore.value) return
  const requestSeq = ++earlierRequestSeq
  const parentLoadSeq = loadSeq
  earlierLoading.value = true
  try {
    const statuses =
      statusFilter.value.length > 0
        ? [...statusFilter.value]
        : ['initialized', 'in_progress', 'completed']
    const tagIds = tagFilterIds.value.length > 0 ? [...tagFilterIds.value] : null
    const cutoff = threeDayCutoff()

    const result = await window.api.queryEarlierNotes({
      statuses,
      tagIds,
      cutoffTime: cutoff,
      limit: earlierLimit.value,
      offset: earlierOffset.value
    })
    if (requestSeq !== earlierRequestSeq || parentLoadSeq !== loadSeq) return
    const newNotes = result.notes || []
    const before = newNotes.length ? captureVisibleCardLayout() : null
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
      await nextTick()
      animateRetainedCards(before)
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
  noteList.value = noteList.value.filter((n) => !earlierIds.value.has(n.id))
  earlierIds.value = new Set()
  earlierOffset.value = 0
  earlierHasMore.value = false
  earlierLimit.value = 10
  collapsedGroups.value['earlier'] = true
}

/** 主容器滚动触底检测（更早展开 + 有更多数据时自动加载） */
let scrollPending = false
function onTimelineScroll(e) {
  if (scrollPending) return
  scrollPending = true
  requestAnimationFrame(() => {
    scrollPending = false
    const el = e.target
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
      loadEarlier()
    }
  })
}

/** 当前页面实际渲染总数 */
const totalRendered = computed(() => noteList.value.length)

// ---- 自定义模式：单列表 + 日常分页 ----
const customList = ref([]) // 唯一列表（置顶 + 日常已加载）
const customNormalOffset = ref(0)
const customNormalHasMore = ref(false)
const customNormalTotal = ref(0)
const customNormalLimit = ref(10) // 首 10，滚动后 20
const customNormalLoading = ref(false)

/** 自定义模式：并行加载置顶 + 日常首 10 条 */
async function loadCustom({ showLoading = true, preserveAnchor = false } = {}) {
  const seq = ++loadSeq
  tagGroupGeneration++
  loadError.value = null
  earlierRequestSeq++
  customMoreRequestSeq++
  earlierLoading.value = false
  customNormalLoading.value = false
  const anchor = preserveAnchor ? captureScrollAnchor() : null
  if (showLoading) loading.value = true
  try {
    const statuses =
      statusFilter.value.length > 0
        ? [...statusFilter.value]
        : ['initialized', 'in_progress', 'completed']
    const tagIds = tagFilterIds.value.length > 0 ? [...tagFilterIds.value] : null

    const normalLimit = preserveAnchor
      ? Math.max(customNormalOffset.value, customNormalLimit.value)
      : customNormalLimit.value
    const [pinned, normalCount, activeTotal] = await Promise.all([
      window.api.queryCustomPinned({ statuses, tagIds }),
      window.api.queryCustomNormal({ statuses, tagIds, limit: normalLimit, offset: 0 }),
      window.api.countActiveNotes()
    ])
    if (seq !== loadSeq) return { status: 'cancelled' }

    customList.value = [...(pinned || []), ...(normalCount.notes || [])]
    customNormalOffset.value = (normalCount.notes || []).length
    customNormalTotal.value = normalCount.total || 0
    customNormalHasMore.value = customNormalOffset.value < customNormalTotal.value
    allNoteTotal.value = Number(activeTotal) || 0
    await restoreScrollAnchor(anchor)
    lastRefreshedAt.value = Date.now()
    return { status: 'success' }
  } catch (e) {
    console.error('[NoteList] 加载自定义列表失败:', e)
    if (seq === loadSeq && showLoading) loadError.value = '列表加载失败'
    return { status: 'error', error: e }
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

/** 自定义模式：滚动加载更多日常 */
async function loadCustomMore() {
  if (customNormalLoading.value || !customNormalHasMore.value) return
  const requestSeq = ++customMoreRequestSeq
  const parentLoadSeq = loadSeq
  customNormalLoading.value = true
  try {
    const statuses =
      statusFilter.value.length > 0
        ? [...statusFilter.value]
        : ['initialized', 'in_progress', 'completed']
    const tagIds = tagFilterIds.value.length > 0 ? [...tagFilterIds.value] : null

    const result = await window.api.queryCustomNormal({
      statuses,
      tagIds,
      limit: customNormalLimit.value,
      offset: customNormalOffset.value
    })
    if (requestSeq !== customMoreRequestSeq || parentLoadSeq !== loadSeq) return
    const newNotes = result.notes || []
    const before = newNotes.length ? captureVisibleCardLayout() : null
    customList.value = [...customList.value, ...newNotes]
    customNormalOffset.value += newNotes.length
    customNormalTotal.value = result.total || 0
    customNormalHasMore.value = customNormalOffset.value < customNormalTotal.value
    if (customNormalLimit.value === 10) {
      customNormalLimit.value = 20
    }
    if (before) {
      await nextTick()
      animateRetainedCards(before)
    }
  } catch (e) {
    console.error('[NoteList] 加载更多日常便签失败:', e)
  } finally {
    if (requestSeq === customMoreRequestSeq) customNormalLoading.value = false
  }
}

/** 自定义模式滚动触底检测 */
function onCustomScroll(e) {
  const el = e.target
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
    loadCustomMore()
  }
}

/** 自定义模式当前渲染总数 */
const customTotalRendered = computed(() => customList.value.length)

// ---- 标签分组模式：分组概览 + 展开后手动分页 ----
const TAG_GROUP_INITIAL_LIMIT = 10
const TAG_GROUP_MORE_LIMIT = 20
const tagGroups = ref([])
const expandedTagGroupKeys = new Set()
let tagGroupGeneration = 0

const tagGroupMatchingTotal = computed(() =>
  tagGroups.value.reduce((total, group) => total + group.total, 0)
)

function activeStatuses() {
  return statusFilter.value.length > 0
    ? [...statusFilter.value]
    : ['initialized', 'in_progress', 'completed']
}

async function loadTagGroupPage(group, { reset = false, limit = null } = {}) {
  if (!group || group.loading) return { status: 'cancelled' }
  const generation = tagGroupGeneration
  const offset = reset ? 0 : group.notes.length
  group.loading = true
  group.error = null
  try {
    const result = await window.api.queryTagGroupNotes({
      tagId: group.untagged ? null : group.id,
      statuses: activeStatuses(),
      limit: limit || (reset ? TAG_GROUP_INITIAL_LIMIT : TAG_GROUP_MORE_LIMIT),
      offset
    })
    if (generation !== tagGroupGeneration || !tagGroups.value.includes(group)) {
      return { status: 'cancelled' }
    }
    const notes = result.notes || []
    group.notes = reset ? notes : [...group.notes, ...notes]
    group.total = Number(result.total) || 0
    group.hasMore = group.notes.length < group.total
    return { status: 'success' }
  } catch (error) {
    console.error('[NoteList] 加载标签组便签失败:', group.name, error)
    if (generation === tagGroupGeneration) group.error = '加载失败'
    return { status: 'error', error }
  } finally {
    if (generation === tagGroupGeneration) group.loading = false
  }
}

async function loadTagGroups({ showLoading = true, preserveAnchor = false } = {}) {
  const seq = ++loadSeq
  const generation = ++tagGroupGeneration
  loadError.value = null
  earlierRequestSeq++
  customMoreRequestSeq++
  earlierLoading.value = false
  customNormalLoading.value = false
  const anchor = preserveAnchor ? captureScrollAnchor() : null
  const previousGroups = new Map(tagGroups.value.map((group) => [group.key, group]))
  if (showLoading) loading.value = true
  try {
    const tagIds = tagFilterIds.value.length > 0 ? [...tagFilterIds.value] : null
    const [groups, activeTotal] = await Promise.all([
      window.api.queryTagGroups({ statuses: activeStatuses(), tagIds }),
      window.api.countActiveNotes()
    ])
    if (seq !== loadSeq || generation !== tagGroupGeneration) return { status: 'cancelled' }

    tagGroups.value = (groups || []).map((group) => {
      const previous = previousGroups.get(group.key)
      return {
        ...group,
        expanded: Boolean(previous?.expanded || expandedTagGroupKeys.has(group.key)),
        notes: [],
        loading: false,
        error: null,
        hasMore: Number(group.total) > 0,
        previousLoadedCount: previous?.notes?.length || 0
      }
    })
    allNoteTotal.value = Number(activeTotal) || 0

    await Promise.all(
      tagGroups.value
        .filter((group) => group.expanded)
        .map((group) =>
          loadTagGroupPage(group, {
            reset: true,
            limit: Math.max(TAG_GROUP_INITIAL_LIMIT, group.previousLoadedCount)
          })
        )
    )
    tagGroups.value.forEach((group) => delete group.previousLoadedCount)
    await restoreScrollAnchor(anchor)
    lastRefreshedAt.value = Date.now()
    return { status: 'success' }
  } catch (error) {
    console.error('[NoteList] 加载标签分组失败:', error)
    if (seq === loadSeq && showLoading) loadError.value = '标签分组加载失败'
    return { status: 'error', error }
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

async function toggleTagGroup(group) {
  group.expanded = !group.expanded
  if (group.expanded) expandedTagGroupKeys.add(group.key)
  else expandedTagGroupKeys.delete(group.key)
  if (group.expanded && group.notes.length === 0 && group.total > 0) {
    await loadTagGroupPage(group, { reset: true })
  }
}

function retryTagGroup(group) {
  loadTagGroupPage(group, { reset: group.notes.length === 0 })
}

// ============================================================
// 时间线分组（从单一 noteList 派生）
// ============================================================

function timeGroup(ts) {
  const now = new Date()
  const target = new Date(ts)
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const tomorrowStart = todayStart + 86400000
  const yesterdayStart = todayStart - 86400000
  const dayBeforeStart = yesterdayStart - 86400000
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
  const now = new Date()
  return date.getFullYear() === now.getFullYear()
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

const timelineGroups = computed(() => {
  const pinned = []
  const dayMap = { upcoming: [], today: [], yesterday: [], dayBefore: [] }
  const earlier = []

  for (const note of noteList.value) {
    if (note.is_pinned) {
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

/** 更早折叠状态 */
const collapsedGroups = ref({ earlier: true })

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

// ============================================================
// 自定义模式（置顶 + 日常，拖拽排序 + 滚动分页）
// ============================================================

const customPinnedNotes = ref([])
const customNormalNotes = ref([])

/** 从 customList 派生拖拽区数组 */
function syncCustomZones() {
  customPinnedNotes.value = customList.value.filter((n) => n.is_pinned)
  customNormalNotes.value = customList.value.filter((n) => !n.is_pinned)
}

/** customList 变化时自动同步拖拽区 */
let _customSyncTimer = null
watch(
  customList,
  () => {
    clearTimeout(_customSyncTimer)
    _customSyncTimer = setTimeout(syncCustomZones, 0)
  },
  { deep: false }
)

// ---- 拖拽排序回调 ----

async function onCustomPinnedDragEnd() {
  assignExistingSortSlots(customPinnedNotes.value)
  customList.value = [...customPinnedNotes.value, ...customNormalNotes.value]
  await persistSortOrder(customPinnedNotes.value)
}

async function onCustomNormalDragEnd() {
  assignExistingSortSlots(customNormalNotes.value)
  customList.value = [...customPinnedNotes.value, ...customNormalNotes.value]
  await persistSortOrder(customNormalNotes.value)
}

function assignExistingSortSlots(list) {
  const slots = list.map((note) => Number(note.sort_order)).sort((a, b) => a - b)
  list.forEach((note, index) => {
    note.sort_order = slots[index]
  })
}

async function persistSortOrder(list) {
  try {
    await window.api.updateCustomSortOrders(
      list.map((note) => ({ id: note.id, sortOrder: note.sort_order }))
    )
  } catch (e) {
    console.error('[NoteList] sort_order 持久化失败，重新加载数据库顺序:', e)
    await loadCustom({ showLoading: false, preserveAnchor: true })
    syncCustomZones()
  }
}

const statusTransitions = reactive(new Map())
const statusTransitionTimers = new Map()
const earlyStartConfirmVisible = ref(false)
const earlyStartNote = ref(null)
const earlyStartMessage = computed(() => {
  const durationDays = Math.max(1, Number(earlyStartNote.value?.duration_days) || 1)
  if (durationDays > 1) {
    return `该便签设置了持续 ${durationDays} 天。提前执行后，生效时间将改为当前时间，月视图中的连续显示日期也会从今天重新计算。是否确认提前执行？`
  }
  return '该便签尚未到达生效时间。提前执行后，生效时间将改为当前时间。是否确认提前执行？'
})

function statusTransitionFor(noteId) {
  return statusTransitions.get(noteId) || null
}

function setStatusTransition(noteId, state) {
  if (state) statusTransitions.set(noteId, state)
  else statusTransitions.delete(noteId)
}

function statusTimerKey(noteId, kind) {
  return `${noteId}:${kind}`
}

function clearStatusTimer(noteId, kind) {
  const key = statusTimerKey(noteId, kind)
  clearTimeout(statusTransitionTimers.get(key))
  statusTransitionTimers.delete(key)
}

function scheduleStatusTransition(noteId, kind, delay, callback) {
  const key = statusTimerKey(noteId, kind)
  clearTimeout(statusTransitionTimers.get(key))
  const timer = setTimeout(async () => {
    statusTransitionTimers.delete(key)
    await callback?.()
  }, delay)
  statusTransitionTimers.set(key, timer)
}

function finishStatusTransition(noteId, delay, callback) {
  scheduleStatusTransition(noteId, 'finish', delay, async () => {
    setStatusTransition(noteId, null)
    await callback?.()
  })
}

/** 初始化便签先确认提前执行；其他状态保持原有单击流程。 */
function onCardStatusAction(note) {
  if (note.status === 'initialized') {
    earlyStartNote.value = note
    earlyStartConfirmVisible.value = true
    return
  }
  void executeCardStatusAction(note)
}

function confirmEarlyStart() {
  const note = earlyStartNote.value
  earlyStartNote.value = null
  if (note) void executeCardStatusAction(note)
}

function cancelEarlyStart() {
  earlyStartNote.value = null
}

/** 状态圆环的主操作：初始化提前开始，进行中标记完成，已完成重新进行。 */
async function executeCardStatusAction(note) {
  if (statusTransitions.has(note.id)) return
  const from = note.status
  const to =
    from === 'initialized' || from === 'completed'
      ? 'in_progress'
      : from === 'in_progress'
        ? 'completed'
        : null
  if (!to) return

  // 先给 0 延迟的点击确认；只有请求超过 120ms 才显示轨道等待光。
  setStatusTransition(note.id, { from, to, phase: 'acknowledging' })
  scheduleStatusTransition(note.id, 'waiting', 120, () => {
    const current = statusTransitions.get(note.id)
    if (current?.phase === 'acknowledging') {
      setStatusTransition(note.id, { from, to, phase: 'waiting' })
    }
  })

  try {
    let updated = null
    if (from === 'initialized') {
      updated = await window.api.startProgress(note.id)
    } else if (from === 'in_progress') {
      updated = await window.api.completeNote(note.id)
    } else if (from === 'completed') {
      updated = await window.api.reopenNote(note.id)
    }

    if (!updated) throw new Error('状态接口未返回更新后的便签')
    clearStatusTimer(note.id, 'waiting')
    const remainsVisible =
      statusFilter.value.length === 0 || statusFilter.value.includes(updated.status)
    // 完成态的灰层必须等扫描真正抵达卡片右端后才出现。
    const commitDelay = to === 'completed' ? 920 : 125
    const totalDuration = 1000

    // 主动画先使用旧状态起跑；颜色传播到中点后才提交文字、卡片和常驻发光颜色。
    setStatusTransition(note.id, { from, to, phase: 'playing' })
    scheduleStatusTransition(note.id, 'commit', commitDelay, () => {
      // 提前开始会改变时间线分组。动画期间保留旧生效时间，避免卡片在圆环
      // 过渡尚未完成时被 Vue 从“未来”卸载、又在“今天”重新挂载。
      const resetsEffectiveTime = from === 'initialized' && to === 'in_progress'
      const displayUpdate = resetsEffectiveTime
        ? { ...updated, effective_at: note.effective_at }
        : updated
      patchVisibleNote(displayUpdate, true)
    })
    finishStatusTransition(note.id, totalDuration, async () => {
      const resetsEffectiveTime = from === 'initialized' && to === 'in_progress'
      const changedEffectiveTimeOrdering =
        resetsEffectiveTime &&
        ((sortMode.value === 'timeline' && !note.is_pinned) || sortMode.value === 'tag-group')
      if (!remainsVisible || changedEffectiveTimeOrdering) {
        await refreshInBackground({
          reenterIds: changedEffectiveTimeOrdering && remainsVisible ? [note.id] : []
        })
      }
    })
  } catch (e) {
    clearStatusTimer(note.id, 'waiting')
    console.error('[NoteList] 状态修改失败:', note.id, e)
    setStatusTransition(note.id, { from, to, phase: 'error' })
    finishStatusTransition(note.id, 320)
  }
}

function patchVisibleNote(updated, force = false) {
  const allowed = statusFilter.value.length === 0 || statusFilter.value.includes(updated.status)
  if (!allowed && !force) return false
  if (sortMode.value === 'timeline') {
    noteList.value = noteList.value.map((note) =>
      note.id === updated.id ? mergeListItem(note, updated) : note
    )
    return true
  }
  if (sortMode.value === 'custom') {
    customList.value = customList.value.map((note) =>
      note.id === updated.id ? mergeListItem(note, updated) : note
    )
    syncCustomZones()
    return true
  }

  const currentGroup = tagGroups.value.find((group) =>
    group.notes.some((note) => note.id === updated.id)
  )
  const updatedGroupKey = updated.tags?.[0]?.id ? `tag:${updated.tags[0].id}` : 'untagged'
  if (!currentGroup || currentGroup.key !== updatedGroupKey) return false
  currentGroup.notes = currentGroup.notes
    .map((note) => (note.id === updated.id ? mergeListItem(note, updated) : note))
    .sort((first, second) => second.effective_at - first.effective_at || second.id - first.id)
  return true
}

/** 局部状态响应缺少摘要字段时保留卡片已有的标签与附件信息。 */
function mergeListItem(current, updated) {
  return {
    ...current,
    ...updated,
    tags: Array.isArray(updated.tags) ? updated.tags : current.tags,
    attachment_count: Number.isFinite(Number(updated.attachment_count))
      ? Number(updated.attachment_count)
      : current.attachment_count,
    has_text: typeof updated.has_text === 'boolean' ? updated.has_text : current.has_text,
    has_image: typeof updated.has_image === 'boolean' ? updated.has_image : current.has_image
  }
}

async function refreshOne(noteOrId) {
  const id = typeof noteOrId === 'object' ? noteOrId?.id : noteOrId
  if (!id) return
  const updated =
    typeof noteOrId === 'object' && Array.isArray(noteOrId.tags)
      ? noteOrId
      : await window.api.getNote(id)
  if (updated) {
    if (!patchVisibleNote(updated)) await refreshInBackground()
    else lastRefreshedAt.value = Date.now()
  }
}

let presenceMotionSeq = 0

const {
  captureVisibleCardLayout,
  animateRetainedCards,
  animateAuxiliaryIn,
  cancelCurrentPresenceExits,
  animateCurrentCardsOut,
  disposePresenceMotion
} = useNotePresenceMotion(currentScrollContainer)

/** 用户主动刷新：完整播放依次离场 → 清空 → 重新查询 → 依次进场。 */
let replayRefreshRunning = false
async function replayListRefresh() {
  if (replayRefreshRunning) return
  replayRefreshRunning = true
  const refreshSeq = ++presenceMotionSeq
  try {
    const container = currentScrollContainer()
    const scrollTop = container?.scrollTop || 0
    await animateCurrentCardsOut()
    if (refreshSeq !== presenceMotionSeq) {
      cancelCurrentPresenceExits()
      return
    }

    const options = { showLoading: false, preserveAnchor: false }
    let result
    if (sortMode.value === 'timeline') {
      result = await loadAll(options)
    } else if (sortMode.value === 'custom') {
      result = await loadCustom(options)
      syncCustomZones()
    } else {
      result = await loadTagGroups(options)
    }
    if (result?.status !== 'success') {
      cancelCurrentPresenceExits()
      return
    }
    if (refreshSeq !== presenceMotionSeq) {
      cancelCurrentPresenceExits()
      return
    }
    await nextTick()
    const refreshedContainer = currentScrollContainer()
    if (refreshedContainer) refreshedContainer.scrollTop = scrollTop
    animateRetainedCards(new Map())
  } finally {
    replayRefreshRunning = false
  }
}

async function refreshInBackground({ reenterIds = [] } = {}) {
  const motionSeq = ++presenceMotionSeq
  const before = captureVisibleCardLayout()
  const options = { showLoading: false, preserveAnchor: true }
  let result
  if (sortMode.value === 'timeline') {
    result = await loadAll(options)
  } else if (sortMode.value === 'custom') {
    result = await loadCustom(options)
    syncCustomZones()
  } else {
    result = await loadTagGroups(options)
  }
  if (result?.status !== 'success' || motionSeq !== presenceMotionSeq) return result
  await nextTick()
  if (motionSeq !== presenceMotionSeq) return result
  animateRetainedCards(before, { reenterIds })
  return result
}

// ---- 模式切换 ----

async function switchMode(mode, loadOptions, cancelPresence = true) {
  if (cancelPresence) presenceMotionSeq++
  if (mode === 'custom') {
    let result = await loadCustom(loadOptions)
    if (result?.status !== 'success') return result
    syncCustomZones()
    // 主进程检查全部便签，修复早期版本可能留下的 0 或重复排序槽位。
    const repaired = await window.api.reorderCustomSortOrder()
    if (repaired) {
      result = await loadCustom(loadOptions)
      if (result?.status !== 'success') return result
      syncCustomZones()
    }
    return result
  }
  if (mode === 'tag-group') return loadTagGroups(loadOptions)
  return loadAll(loadOptions)
}

function retryLoad() {
  switchMode(sortMode.value, { showLoading: true, preserveAnchor: false })
}

/** 是否正在恢复持久化状态（恢复期间抑制自动重载/持久化，避免重复请求） */
let restoring = false

/** 持久化筛选状态到数据库 */
async function saveFilterState() {
  const state = {
    listMode: sortMode.value,
    tagIds: [...tagFilterIds.value],
    statusFilter: [...statusFilter.value]
  }
  await window.api.setSettingValue('listFilter', state)
}

function isCurrentFilterState(state) {
  return (
    state.listMode === sortMode.value &&
    JSON.stringify(state.tagIds) === JSON.stringify(tagFilterIds.value) &&
    JSON.stringify(state.statusFilter) === JSON.stringify(statusFilter.value)
  )
}

async function applyFilterState(state) {
  if (!state || isCurrentFilterState(state)) return false
  restoring = true
  sortMode.value = state.listMode
  tagFilterIds.value = [...state.tagIds]
  statusFilter.value = [...state.statusFilter]
  await nextTick()
  restoring = false
  return true
}

/** 从完整设置快照恢复筛选状态。 */
async function loadFilterState() {
  restoring = true
  try {
    const snapshot = await window.api.getSettingsSnapshot()
    const state = snapshot.values.listFilter
    sortMode.value = state.listMode
    tagFilterIds.value = [...state.tagIds]
    statusFilter.value = [...state.statusFilter]
  } catch (e) {
    sortMode.value = DEFAULT_SETTINGS.listFilter.listMode
    tagFilterIds.value = [...DEFAULT_SETTINGS.listFilter.tagIds]
    statusFilter.value = [...DEFAULT_SETTINGS.listFilter.statusFilter]
    console.warn('[NoteList] 恢复筛选状态失败，使用共享默认值:', e)
  } finally {
    // 等响应式 flush 完成后再解除抑制，防止恢复赋值触发重复加载
    await nextTick()
    restoring = false
  }
}

onMounted(async () => {
  document.addEventListener('pointerdown', onModeMenuOutside)
  document.addEventListener('keydown', onModeMenuKeydown)
  await loadFilterState()
  // 统一入口：根据当前模式加载（时间线 / 自定义 / 标签分组）
  await switchMode(sortMode.value)
})

let notesChangedTimer = null
function refreshNotesWhenStatusIdle() {
  if (statusTransitions.size > 0) {
    notesChangedTimer = setTimeout(refreshNotesWhenStatusIdle, 100)
    return
  }
  refreshInBackground()
}
const stopNotesChanged = window.api.onNotesChanged?.(() => {
  clearTimeout(notesChangedTimer)
  notesChangedTimer = setTimeout(refreshNotesWhenStatusIdle, 80)
})

const stopSettingsChanged = window.api.onSettingsChanged?.(async (snapshot) => {
  const changed = await applyFilterState(snapshot?.values?.listFilter)
  if (changed) await switchMode(sortMode.value)
})

onUnmounted(() => {
  presenceMotionSeq++
  loadSeq++
  disposePresenceMotion()
  clearTimeout(notesChangedTimer)
  clearTimeout(_customSyncTimer)
  for (const timer of statusTransitionTimers.values()) clearTimeout(timer)
  statusTransitionTimers.clear()
  document.removeEventListener('pointerdown', onModeMenuOutside)
  document.removeEventListener('keydown', onModeMenuKeydown)
  stopNotesChanged?.()
  stopSettingsChanged?.()
  earlierRequestSeq++
  customMoreRequestSeq++
  tagGroupGeneration++
})

// 统一响应式入口：排序模式 / 标签 / 状态任一变化 → 重载 + 持久化
// （切换按钮只翻转 sortMode，加载与持久化都由这里负责，二者与按钮解耦）
watch(
  [sortMode, tagFilterIds, statusFilter],
  ([nextMode], [previousMode]) => {
    if (restoring) return
    if (nextMode !== previousMode) {
      if (!modePresenceSwitching) switchMode(nextMode)
    } else refreshInBackground()
    saveFilterState() // 持久化筛选条件
  },
  { deep: true }
)

// ============================================================
// 面板展开/折叠动画（真实高度过渡 + 苹果风缓动，避免卡顿）
// ============================================================
const PANEL_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'

function onPanelEnter(el, done) {
  el.style.overflow = 'hidden'
  el.style.willChange = 'height'
  el.style.height = '0'
  el.style.opacity = '0'
  void el.offsetHeight // 强制回流
  el.style.transition = `height 320ms ${PANEL_EASING}, opacity 320ms ease`
  el.style.height = el.scrollHeight + 'px'
  el.style.opacity = '1'
  const onEnd = (e) => {
    if (e.propertyName !== 'height') return
    el.removeEventListener('transitionend', onEnd)
    el.style.height = ''
    el.style.overflow = ''
    el.style.transition = ''
    el.style.willChange = ''
    done()
  }
  el.addEventListener('transitionend', onEnd)
}

function onPanelLeave(el, done) {
  el.style.overflow = 'hidden'
  el.style.willChange = 'height'
  el.style.height = el.scrollHeight + 'px'
  el.style.opacity = '1'
  void el.offsetHeight // 强制回流
  el.style.transition = `height 280ms ${PANEL_EASING}, opacity 280ms ease`
  el.style.height = '0'
  el.style.opacity = '0'
  const onEnd = (e) => {
    if (e.propertyName !== 'height') return
    el.removeEventListener('transitionend', onEnd)
    el.style.willChange = ''
    done()
  }
  el.addEventListener('transitionend', onEnd)
}

defineExpose({
  refresh: refreshInBackground,
  refreshOne
})
</script>

<template>
  <div class="note-list">
    <!-- 工具栏 -->
    <div class="nl-toolbar">
      <!-- 左：标题板块 -->
      <div class="nl-toolbar-left">
        <span class="nl-title">便签</span>
      </div>

      <!-- 中：功能板块（单选切换） -->
      <div class="nl-toolbar-center">
        <FilterTabs
          :model-value="panelState"
          :options="panelOptions"
          @update:model-value="onPanelClick"
        />
      </div>

      <!-- 右：展示模式选择 -->
      <div class="nl-toolbar-right">
        <div ref="modeMenuRootRef" class="nl-mode-menu-root">
          <button
            ref="modeToggleRef"
            type="button"
            class="nl-mode-toggle"
            aria-haspopup="menu"
            :aria-expanded="modeMenuOpen"
            :aria-label="`当前是${sortModeLabel}，选择排列方式`"
            @click="toggleModeMenu"
          >
            <Transition name="nl-mode-text" mode="out-in">
              <span :key="sortMode" class="nl-mode-label">{{ sortModeLabel }}</span>
            </Transition>
            <svg
              class="nl-mode-chevron"
              :class="{ 'nl-mode-chevron--open': modeMenuOpen }"
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="m4 6 4 4 4-4"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <Transition
            :css="false"
            @enter="(element, done) => enterPopover(element, done, 'dropdown')"
            @leave="(element, done) => leavePopover(element, done, 'dropdown')"
          >
            <div v-if="modeMenuOpen" class="nl-mode-menu" role="menu">
              <button
                v-for="option in modeOptions"
                :key="option.value"
                type="button"
                role="menuitemradio"
                class="nl-mode-option"
                :class="{ 'nl-mode-option--active': option.value === sortMode }"
                :aria-checked="option.value === sortMode"
                @click="selectSortMode(option.value)"
              >
                <span>{{ option.label }}</span>
                <svg
                  v-if="option.value === sortMode"
                  width="13"
                  height="13"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="m3.5 8 2.8 2.8 6.2-6.2"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
            </div>
          </Transition>
        </div>
      </div>
    </div>

    <!-- 筛选面板（标签 / 状态；太极=折叠态）—— 单一 out-in 过渡，避免两面板同时伸缩 -->
    <Transition :css="false" mode="out-in" @enter="onPanelEnter" @leave="onPanelLeave">
      <div v-if="panelState !== 'taiji'" :key="panelState" class="nl-panel-wrap">
        <div class="nl-panel-inner">
          <TagSelector
            v-if="panelState === 'tags'"
            v-model="tagFilterIds"
            class="nl-tags"
            @refresh="replayListRefresh"
          />
          <div v-else class="nl-status-filter">
            <div class="nl-status-chips">
              <button
                v-for="(s, i) in statusOptions"
                :key="s.value"
                class="nl-status-chip nl-chip-anim"
                :class="{ 'nl-status-chip--active': statusFilter.includes(s.value) }"
                :style="{ animationDelay: staggerDelay(i) }"
                @click="toggleStatus(s.value)"
              >
                {{ s.label }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 加载状态 -->
    <div v-if="loading" class="nl-loading">加载中…</div>
    <div v-else-if="loadError" class="nl-empty-state nl-load-error">
      <span>{{ loadError }}</span>
      <button @click="retryLoad">重试</button>
    </div>

    <!-- ======== 时间线模式（时间标记 + 统一便签流） ======== -->
    <template v-else-if="sortMode === 'timeline'">
      <div
        ref="timelineScrollRef"
        class="nl-timeline nl-list-scroll scroll-y"
        @scroll="onTimelineScroll"
      >
        <div v-if="timelineIsEmpty" class="nl-empty-state">暂无便签</div>
        <template v-else>
          <div
            v-for="g in timelineGroups"
            :key="g.group"
            class="nl-group nl-section"
            :class="{ 'nl-group--earlier-toggle': g.group === 'earlier' }"
          >
            <div
              class="nl-group-label-row"
              :class="{ 'nl-group-label-row--earlier': g.group === 'earlier' }"
              @click="g.group === 'earlier' && toggleGroupCollapse('earlier')"
            >
              <span class="nl-group-label">{{ g.label }}</span>
              <span class="nl-group-count">· {{ g.count ?? g.items.length }}条</span>
              <span v-if="lastRefreshLabel" class="nl-group-refresh-time">
                · 刷新 {{ lastRefreshLabel }}
              </span>
              <svg
                v-if="g.group === 'earlier'"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="nl-group-chevron"
                :class="{ 'nl-group-chevron--collapsed': collapsedGroups['earlier'] }"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
            <template v-if="g.group !== 'earlier'">
              <NoteCard
                v-for="note in g.items"
                :key="note.id"
                :note="note"
                :status-transition="statusTransitionFor(note.id)"
                @edit="emit('edit', $event)"
                @status-action="onCardStatusAction"
              />
            </template>
          </div>
          <!-- 更早加载提示 -->
          <div v-if="!collapsedGroups['earlier'] && earlierLoading" class="nl-earlier-hint">
            加载中…
          </div>
          <div
            v-else-if="
              !collapsedGroups['earlier'] && earlierHasData && !earlierHasMore && earlierOffset > 0
            "
            class="nl-earlier-hint"
          >
            没有更多便签
          </div>
        </template>
      </div>
      <!-- 底部计数 -->
      <div v-if="!timelineIsEmpty || allNoteTotal > 0" class="nl-footer-count">
        <span>当前{{ totalRendered }}条</span>
        <span>共{{ allNoteTotal }}条</span>
      </div>
    </template>

    <!-- ======== 标签分组模式 ======== -->
    <template v-else-if="sortMode === 'tag-group'">
      <div ref="tagGroupScrollRef" class="nl-tag-groups nl-list-scroll scroll-y">
        <div v-if="tagGroups.length === 0" class="nl-empty-state">暂无标签组</div>
        <section v-for="group in tagGroups" :key="group.key" class="nl-tag-group">
          <button
            type="button"
            class="nl-tag-group-header"
            :class="{
              'nl-tag-group-header--expanded': group.expanded,
              'nl-tag-group-header--empty': group.total === 0
            }"
            :aria-expanded="group.expanded"
            :aria-controls="`nl-tag-group-${group.id ?? 'untagged'}`"
            @click="toggleTagGroup(group)"
          >
            <svg
              class="nl-tag-group-chevron"
              :class="{ 'nl-tag-group-chevron--open': group.expanded }"
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="m6 4 4 4-4 4"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span
              class="nl-tag-group-dot"
              :class="{ 'nl-tag-group-dot--untagged': group.untagged }"
              :style="group.color ? { backgroundColor: group.color } : null"
              aria-hidden="true"
            ></span>
            <span class="nl-tag-group-name">{{ group.name }}</span>
            <span class="nl-tag-group-count">{{ group.total }}</span>
          </button>
          <Transition :css="false" @enter="onPanelEnter" @leave="onPanelLeave">
            <div
              v-if="group.expanded"
              :id="`nl-tag-group-${group.id ?? 'untagged'}`"
              class="nl-tag-group-content"
            >
              <div v-if="group.total === 0" class="nl-tag-group-empty">当前状态下暂无便签</div>
              <template v-else>
                <NoteCard
                  v-for="note in group.notes"
                  :key="note.id"
                  :note="note"
                  :color-by-tag="false"
                  :status-transition="statusTransitionFor(note.id)"
                  @edit="emit('edit', $event)"
                  @status-action="onCardStatusAction"
                />
                <div v-if="group.loading" class="nl-tag-group-hint">加载中…</div>
                <button
                  v-else-if="group.error"
                  type="button"
                  class="nl-tag-group-more"
                  @click="retryTagGroup(group)"
                >
                  加载失败，点击重试
                </button>
                <button
                  v-else-if="group.hasMore"
                  type="button"
                  class="nl-tag-group-more"
                  @click="loadTagGroupPage(group)"
                >
                  显示更多
                </button>
              </template>
            </div>
          </Transition>
        </section>
      </div>
      <div v-if="tagGroups.length > 0 || allNoteTotal > 0" class="nl-footer-count">
        <span>{{ tagGroups.length }} 个标签组，{{ tagGroupMatchingTotal }} 条便签</span>
      </div>
    </template>

    <!-- ======== 自定义模式 ======== -->
    <template v-else>
      <div ref="customScrollRef" class="nl-custom nl-list-scroll scroll-y" @scroll="onCustomScroll">
        <div v-if="customTotalRendered === 0" class="nl-empty-state">暂无便签</div>
        <template v-else>
          <!-- 置顶区 -->
          <div v-if="customPinnedNotes.length > 0" class="nl-zone nl-section">
            <div class="nl-zone-label">
              <span>置顶</span>
              <span class="nl-group-count">· {{ customPinnedNotes.length }}条</span>
              <span v-if="lastRefreshLabel" class="nl-group-refresh-time">
                · 刷新 {{ lastRefreshLabel }}
              </span>
            </div>
            <draggable
              v-model="customPinnedNotes"
              :group="{ name: 'custom-pinned', pull: false, put: false }"
              item-key="id"
              class="nl-dropzone"
              ghost-class="nl-ghost"
              handle=".nl-drag-handle"
              :animation="180"
              @end="onCustomPinnedDragEnd"
            >
              <template #item="{ element: note }">
                <NoteCard
                  :note="note"
                  draggable
                  :status-transition="statusTransitionFor(note.id)"
                  @edit="emit('edit', $event)"
                  @status-action="onCardStatusAction"
                />
              </template>
            </draggable>
          </div>

          <!-- 日常区 -->
          <div class="nl-zone nl-section">
            <div class="nl-zone-label">
              <span>日常</span>
              <span class="nl-group-count">· {{ customNormalTotal }}条</span>
              <span v-if="lastRefreshLabel" class="nl-group-refresh-time">
                · 刷新 {{ lastRefreshLabel }}
              </span>
            </div>
            <draggable
              v-model="customNormalNotes"
              :group="{ name: 'custom-normal', pull: false, put: false }"
              item-key="id"
              class="nl-dropzone"
              ghost-class="nl-ghost"
              handle=".nl-drag-handle"
              :animation="180"
              @end="onCustomNormalDragEnd"
            >
              <template #item="{ element: note }">
                <NoteCard
                  :note="note"
                  draggable
                  :status-transition="statusTransitionFor(note.id)"
                  @edit="emit('edit', $event)"
                  @status-action="onCardStatusAction"
                />
              </template>
            </draggable>
            <div v-if="customNormalLoading" class="nl-earlier-hint">加载中…</div>
            <div
              v-else-if="customNormalNotes.length > 0 && !customNormalHasMore"
              class="nl-earlier-hint"
            >
              没有更多便签
            </div>
          </div>
        </template>
      </div>
      <!-- 底部计数 -->
      <div v-if="customTotalRendered > 0 || allNoteTotal > 0" class="nl-footer-count">
        <span>当前{{ customTotalRendered }}条</span>
        <span>共{{ allNoteTotal }}条</span>
      </div>
    </template>
  </div>

  <ConfirmDialog
    v-model:visible="earlyStartConfirmVisible"
    title="提前执行便签？"
    :message="earlyStartMessage"
    confirm-text="提前执行"
    cancel-text="取消"
    @confirm="confirmEarlyStart"
    @cancel="cancelEarlyStart"
  />
</template>

<style scoped>
/* ===== 布局 ===== */
.note-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* ===== 工具栏 ===== */
.nl-toolbar {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 8rem 0;
  flex-shrink: 0;
}

.nl-toolbar-left {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10rem;
  justify-content: flex-start;
}

.nl-toolbar-center {
  flex: 0 0 auto;
  display: flex;
  justify-content: center;
}

.nl-toolbar-right {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10rem;
}

.nl-title {
  font-size: var(--fs-title);
  font-weight: 700;
}

/* 展示模式选择 */
.nl-mode-menu-root {
  position: relative;
}
.nl-mode-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4rem;
  padding: 4rem 6rem;
  border: none;
  background: transparent;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  transition:
    color 150ms ease,
    transform var(--motion-control) var(--ease-standard);
}
.nl-mode-toggle:hover {
  color: var(--text-color);
}
.nl-mode-toggle:active {
  transform: scale(0.98);
}
.nl-mode-label {
  display: inline-block;
}
.nl-mode-chevron {
  display: block;
  transition: transform var(--motion-control) var(--ease-standard);
}
.nl-mode-chevron--open {
  transform: rotate(180deg);
}
.nl-mode-menu {
  position: absolute;
  z-index: var(--z-local-top);
  top: calc(100% + 4rem);
  right: 0;
  min-width: 112rem;
  padding: 4rem;
  border: 1px solid var(--surface-float-border);
  border-radius: 10rem;
  background: var(--surface-float);
  box-shadow: 0 8rem 24rem rgb(0 0 0 / 0.14);
  transform-origin: top right;
}
.nl-mode-option {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12rem;
  padding: 7rem 9rem;
  border: 0;
  border-radius: 7rem;
  background: transparent;
  color: var(--text-color-secondary);
  font: inherit;
  font-size: var(--fs-secondary);
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--motion-control) ease,
    color var(--motion-control) ease,
    transform var(--motion-control) var(--ease-standard);
}
.nl-mode-option:hover {
  background: var(--ui-fill-hover);
  color: var(--text-color);
}
.nl-mode-option--active {
  background: var(--ui-fill-pressed);
  color: var(--text-color);
}
.nl-mode-option:active {
  transform: scale(0.98);
}

/* 文字切换过渡：旧字往右滑出、新字从左滑入 */
.nl-mode-text-enter-active,
.nl-mode-text-leave-active {
  transition:
    opacity var(--motion-control) ease,
    transform var(--motion-control) var(--ease-standard);
}
.nl-mode-text-enter-from {
  opacity: 0;
  transform: translateX(-5rem);
}
.nl-mode-text-leave-to {
  opacity: 0;
  transform: translateX(5rem);
}

/* ===== 加载状态 ===== */
.nl-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40rem 20rem;
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
  gap: 12rem;
  animation: nl-state-in var(--motion-control) ease both;
}

.nl-empty-state {
  display: grid;
  place-items: center;
  min-height: 180rem;
  padding: 32rem 20rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  letter-spacing: 0.02em;
  animation: nl-state-in var(--motion-control) ease both;
}
.nl-load-error {
  gap: 10rem;
}
.nl-load-error button {
  border: 0;
  border-radius: 6rem;
  padding: 5rem 12rem;
  color: var(--text-color);
  background: rgb(var(--bg-color) / 0.12);
  cursor: pointer;
}

@keyframes nl-state-in {
  from {
    opacity: 0;
    transform: translateY(4rem);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* ===== 时间线 ===== */
.nl-list-scroll {
  padding-bottom: 30rem;
}

.nl-section + .nl-section {
  margin-top: 16rem;
}

.nl-timeline {
  flex: 1;
  -webkit-mask-image: linear-gradient(
    to bottom,
    black 0%,
    black calc(100% - 30rem),
    transparent 100%
  );
  mask-image: linear-gradient(to bottom, black 0%, black calc(100% - 30rem), transparent 100%);
}

/* 日期分组：用日期、数量和延伸线表达时间层级，不额外占用横向轨道。 */
.nl-group-label-row {
  display: flex;
  align-items: center;
  gap: 6rem;
  font-size: var(--fs-secondary);
  font-weight: 500;
  color: var(--text-color-secondary);
  padding: 7rem 0 5rem;
}
/* 第一项（置顶）去除上内边距，贴顶 */
.nl-group:first-child .nl-group-label-row {
  padding-top: 0;
}
/* 更早标记行（可点击展开） */
.nl-group-label-row--earlier {
  cursor: pointer;
  user-select: none;
}
.nl-group-label,
.nl-group-count,
.nl-group-refresh-time,
.nl-group-chevron {
  flex-shrink: 0;
}
.nl-group-count {
  font-size: calc(var(--fs-secondary) * 0.82);
  font-weight: 400;
  opacity: 0.66;
}
.nl-group-refresh-time {
  font-size: calc(var(--fs-secondary) * 0.78);
  font-weight: 400;
  opacity: 0.52;
  white-space: nowrap;
}
.nl-group--earlier-toggle + .nl-section {
  margin-top: 8rem;
}

/* 折叠箭头：收起时旋转 -90° */
.nl-group-chevron {
  transition: transform 200ms ease;
}
.nl-group-chevron--collapsed {
  transform: rotate(-90deg);
}

/* 更早区域加载/结束提示 */
.nl-earlier-hint {
  text-align: center;
  padding: 12rem 0 6rem;
  font-size: calc(var(--fs-secondary) * 0.85);
  color: var(--text-color-secondary);
}

/* 底部计数（始终固定） */
.nl-footer-count {
  display: flex;
  justify-content: center;
  gap: 12rem;
  flex-shrink: 0;
  text-align: center;
  padding: 10rem 0 4rem;
  font-size: calc(var(--fs-secondary) * 0.85);
  color: var(--text-color-secondary);
  border-top: 1px solid var(--ui-border-divider);
  margin-top: 4rem;
}

/* ===== 标签分组模式 ===== */
.nl-tag-groups {
  flex: 1;
  -webkit-mask-image: linear-gradient(
    to bottom,
    black 0%,
    black calc(100% - 30rem),
    transparent 100%
  );
  mask-image: linear-gradient(to bottom, black 0%, black calc(100% - 30rem), transparent 100%);
}
.nl-tag-group + .nl-tag-group {
  margin-top: 2rem;
}
.nl-tag-group-header {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 7rem;
  min-height: 34rem;
  padding: 6rem 0;
  border: 0;
  border-radius: 7rem;
  background: transparent;
  color: var(--text-color-secondary);
  font: inherit;
  font-size: var(--fs-secondary);
  text-align: left;
  cursor: pointer;
  transition:
    color var(--motion-control) ease,
    transform var(--motion-control) var(--ease-standard);
}
.nl-tag-group-header:hover {
  color: var(--text-color);
}
.nl-tag-group-header:active {
  transform: scale(0.98);
}
.nl-tag-group-header--expanded {
  color: var(--text-color);
}
.nl-tag-group-header--empty {
  opacity: 0.58;
}
.nl-tag-group-dot {
  width: 8rem;
  height: 8rem;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--text-color-secondary);
}
.nl-tag-group-dot--untagged {
  opacity: 0.48;
}
.nl-tag-group-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.nl-tag-group-count {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.82);
  font-variant-numeric: tabular-nums;
  opacity: 0.72;
}
.nl-tag-group-chevron {
  flex: 0 0 auto;
  opacity: 0.64;
  transition: transform var(--motion-control) var(--ease-standard);
}
.nl-tag-group-chevron--open {
  transform: rotate(90deg);
}
.nl-tag-group-content {
  padding: 7rem 0 2rem 18rem;
}
.nl-tag-group-empty,
.nl-tag-group-hint {
  padding: 14rem 0 10rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.85);
  text-align: center;
}
.nl-tag-group-more {
  display: block;
  margin: 6rem auto 2rem;
  padding: 7rem 12rem;
  border: 0;
  border-radius: 7rem;
  background: transparent;
  color: var(--text-color-secondary);
  font: inherit;
  font-size: calc(var(--fs-secondary) * 0.85);
  cursor: pointer;
  transition:
    color var(--motion-control) ease,
    transform var(--motion-control) var(--ease-standard);
}
.nl-tag-group-more:hover {
  color: var(--text-color);
}
.nl-tag-group-more:active {
  transform: scale(0.98);
}

/* ===== 自定义模式 ===== */
.nl-custom {
  flex: 1;
  -webkit-mask-image: linear-gradient(
    to bottom,
    black 0%,
    black calc(100% - 30rem),
    transparent 100%
  );
  mask-image: linear-gradient(to bottom, black 0%, black calc(100% - 30rem), transparent 100%);
}
.nl-zone--archived {
  opacity: 0.6;
}
.nl-zone-label {
  display: flex;
  align-items: center;
  gap: 6rem;
  font-size: var(--fs-secondary);
  font-weight: 500;
  color: var(--text-color-secondary);
  padding: 6rem 0 4rem;
}
.nl-zone:first-child .nl-zone-label {
  padding-top: 0;
}
.nl-dropzone {
  min-height: 10rem;
}
.nl-zone-empty {
  font-size: calc(var(--fs-secondary) * 0.85);
  color: var(--text-color-secondary);
  text-align: center;
  padding: 20rem 0;
}
.nl-ghost {
  opacity: 0.3;
  transform: scale(0.985);
}

/* 状态 chip 逐个淡入上浮；与便签列表的进出场动画互不关联。 */
.nl-chip-anim {
  animation: nl-chip-in 250ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes nl-chip-in {
  from {
    opacity: 0;
    transform: translateY(4rem);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* ===== 展开面板容器（标签 / 状态）===== */
/* 动画元素本身不留内边距：全局 box-sizing:border-box 下，height:0 会被 padding 撑住无法归零，
   导致收拢末段视觉卡在 padding 高度、随后被 Vue 直接移除而“突然消失”。
   把间距放到内层 .nl-panel-inner，其高度仍计入外层 scrollHeight，动画即可平滑收到 0。
   外层 overflow 由 onPanelEnter / onPanelLeave 钩子在动画期间接管，动画结束后还原，
   避免常驻裁剪掉选中标签的 box-shadow 光晕。 */
.nl-panel-inner {
}

/* ===== 标签筛选栏 ===== */
.nl-tags {
  flex-shrink: 0;
  padding: 0 0 8rem;
}

/* ===== 状态筛选栏 ===== */
.nl-status-filter {
  flex-shrink: 0;
  padding: 0 0 8rem;
}
.nl-status-chips {
  display: flex;
  align-items: center;
  gap: 8rem;
  flex-wrap: wrap;
}
.nl-status-chip {
  padding: 5rem 14rem;
  font-size: calc(var(--fs-secondary) * 0.85);
  font-family: inherit;
  font-weight: 400;
  border: 1px solid var(--ui-border-control);
  border-radius: 16rem;
  background: transparent;
  color: var(--text-color-secondary);
  cursor: pointer;
  transition:
    background-color var(--motion-control) ease,
    border-color var(--motion-control) ease,
    color var(--motion-control) ease,
    transform var(--motion-control) var(--ease-standard);
  white-space: nowrap;
}
.nl-status-chip:hover {
  border-color: var(--ui-border-hover);
  color: var(--text-color);
}
.nl-status-chip--active {
  background: #007aff;
  border-color: #007aff;
  color: #fff;
  font-weight: 500;
}
.nl-status-chip--active:hover {
  background: #0066d6;
  border-color: #0066d6;
}
.nl-status-chip:active {
  transform: scale(0.98);
  transition-duration: 70ms;
}
</style>
