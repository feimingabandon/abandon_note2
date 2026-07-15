<script setup>
/**
 * NoteList.vue — 便签列表（时间线 + 自定义拖拽双模式）
 *
 * 3.5 + 3.6: 新增自定义拖拽模式，集成 vuedraggable
 * - 四状态：initialized / in_progress / completed / cancelled
 */
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import draggable from 'vuedraggable'
import TagSelector from '../ui/TagSelector.vue'
import FilterTabs from '../ui/FilterTabs.vue'
import NoteCard from './NoteCard.vue'

const emit = defineEmits(['select'])

/** 排序模式：timeline | custom */
const sortMode = ref('timeline')

/** 排序模式显示文本 */
const sortModeLabel = computed(() => (sortMode.value === 'timeline' ? '时间线' : '自定义'))

/** 切换图标旋转动画标记 */
const modeSpinning = ref(false)

/**
 * 切换排序模式（时间线 <-> 自定义）
 * 只负责翻转模式 + 播放图标动画；数据加载交给 watch(sortMode) 响应式处理，
 * 与加载/查询彻底解耦，保证按钮点击永远即时生效、不会卡死。
 */
function toggleSortMode() {
  sortMode.value = sortMode.value === 'timeline' ? 'custom' : 'timeline'
  restartModeSpin()
}

/** 重启切换图标的旋转动画（双 rAF 强制重排，确保每次点击都能触发） */
function restartModeSpin() {
  modeSpinning.value = false
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      modeSpinning.value = true
    })
  })
}

// ============================================================
// 列表逐条入场动效（与「新建面板」展开动画保持一致）
// 关键帧/时长/缓动已与 NewNotePanel 完全相同（nl-card-in ↔ nnp-fade-up，250ms + 同款缓动）；
// 此处仅需匹配其「等差递增」的延迟节奏：从 0 起步、每项约 40ms 递增。
// ============================================================
const STAGGER_STEP = 40 // 相邻卡片入场延迟步进(ms)——对齐新建面板字段的平均节奏
const STAGGER_MAX = 16 // 延迟封顶序号（列表很长时不会无限延后）
/**
 * 按全局序号计算卡片入场动画延迟（等差递增，与新建面板一致）。
 */
function staggerDelay(index) {
  return Math.min(index, STAGGER_MAX) * STAGGER_STEP + 'ms'
}
/**
 * 列表入场动画重放键：每次 loadNotes 完成后自增，绑到列表容器 :key 上，
 * 强制整个列表子树重挂载以重放逐条入场动画。
 * 与 loading 卸载机制解耦——即使后续改动列表项结构或加载逻辑，重放依然生效。
 */
const listAnimKey = ref(0)

/** 便签列表 */
/** 加载状态 */
const loading = ref(false)
/** 全部未删除便签总数，不受当前标签/状态筛选影响。 */
const allNoteTotal = ref(0)
const timelineScrollRef = ref(null)
const customScrollRef = ref(null)

/** 标签筛选名称列表 */
const tagFilterNames = ref([])

/** 筛选面板状态：tags | taiji | status（taiji=太极图默认折叠态） */
const panelState = ref('taiji')

/** 状态筛选列表 */
const statusFilter = ref(['initialized', 'in_progress', 'completed'])

/** FilterTabs 选项 */
const panelOptions = [
  { value: 'tags', label: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" shape-rendering="geometricPrecision" xmlns="http://www.w3.org/2000/svg"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>' },
  { value: 'taiji', label: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" shape-rendering="geometricPrecision" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9"/><path d="M12 3a4.5 4.5 0 0 1 0 9 4.5 4.5 0 0 0 0 9"/><circle cx="12" cy="7.5" r="1.5" fill="currentColor" stroke="none"/></svg>' },
  { value: 'status', label: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" shape-rendering="geometricPrecision" xmlns="http://www.w3.org/2000/svg"><path d="M12 12C8 9.5 8 3.5 12 3.5C16 3.5 16 9.5 12 12Z"/><path d="M12 12C8 9.5 8 3.5 12 3.5C16 3.5 16 9.5 12 12Z" transform="rotate(120 12 12)"/><path d="M12 12C8 9.5 8 3.5 12 3.5C16 3.5 16 9.5 12 12Z" transform="rotate(240 12 12)"/></svg>' }
]

/** 面板点击：单选 + 展开/收起逻辑 */
function onPanelClick(value) {
  if (value === 'taiji') {
    panelState.value = 'taiji'
    if (sortMode.value === 'timeline') {
      loadAll()
    } else {
      loadCustom()
    }
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
  { value: 'completed', label: '完成' },
  { value: 'cancelled', label: '取消' }
]

/** 切换状态筛选 */
function toggleStatus(value) {
  const idx = statusFilter.value.indexOf(value)
  if (idx === -1) {
    statusFilter.value = [...statusFilter.value, value]
  } else {
    statusFilter.value = statusFilter.value.filter(s => s !== value)
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
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime()
  return todayEnd - 3 * 24 * 60 * 60 * 1000 - 1000
}

// ---- 时间线模式：单一统一列表 ----
const noteList = ref([])          // 唯一列表（置顶 + 三天 + 更早已加载）
const earlierIds = ref(new Set())  // 方法三写入的便签 ID（折叠时用于定点清除）
const earlierOffset = ref(0)
const earlierHasMore = ref(false)
const earlierLoading = ref(false)
const earlierHasData = ref(false)  // 更早是否有数据（loadAll 时通过 count 查询获知）
const earlierTotal = ref(0)
const earlierLimit = ref(10)       // 每次查询条数（首 10，滚动后 20）

/** 时间线模式：并行加载置顶 + 三天 + 更早计数，合并到单一列表 */
function captureScrollAnchor() {
  const container = sortMode.value === 'timeline' ? timelineScrollRef.value : customScrollRef.value
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
  const container = sortMode.value === 'timeline' ? timelineScrollRef.value : customScrollRef.value
  if (!container) return
  if (!anchor.id) {
    container.scrollTop = anchor.scrollTop || 0
    return
  }
  const card = [...container.querySelectorAll('[data-note-id]')]
    .find((item) => item.dataset.noteId === anchor.id)
  if (!card) return
  const containerTop = container.getBoundingClientRect().top
  container.scrollTop += card.getBoundingClientRect().top - containerTop - anchor.offset
}

async function loadAll({ showLoading = true, replayAnimation = true, preserveAnchor = false } = {}) {
  const seq = ++loadSeq
  earlierRequestSeq++
  customMoreRequestSeq++
  earlierLoading.value = false
  customNormalLoading.value = false
  const anchor = preserveAnchor ? captureScrollAnchor() : null
  const loadedEarlierCount = earlierIds.value.size
  if (showLoading) loading.value = true
  try {
    const statuses = statusFilter.value.length > 0
      ? [...statusFilter.value]
      : ['initialized', 'in_progress', 'completed']
    const tagNames = tagFilterNames.value.length > 0 ? [...tagFilterNames.value] : null
    const cutoff = threeDayCutoff()

    const [pinned, recent, earlierCount, activeTotal] = await Promise.all([
      window.api.queryPinnedNotes({ statuses, tagNames }),
      window.api.queryRecentNotes({ statuses, tagNames, cutoffTime: cutoff }),
      window.api.queryEarlierNotes({ statuses, tagNames, cutoffTime: cutoff, limit: 0, offset: 0 }),
      window.api.countActiveNotes()
    ])
    if (seq !== loadSeq) return

    // 合并到单一列表：置顶在前，三天在后
    noteList.value = [...(pinned || []), ...(recent || [])]
    // 重置更早运行时状态（数据已清空，需按当前展开状态重新加载）
    earlierIds.value = new Set()
    earlierOffset.value = 0
    earlierHasMore.value = false
    earlierTotal.value = earlierCount.total || 0
    earlierHasData.value = earlierTotal.value > 0
    allNoteTotal.value = Number(activeTotal) || 0
    if (replayAnimation) listAnimKey.value++

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
  } catch (e) {
    console.error('[NoteList] 加载列表失败:', e)
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
    const statuses = statusFilter.value.length > 0
      ? [...statusFilter.value]
      : ['initialized', 'in_progress', 'completed']
    const tagNames = tagFilterNames.value.length > 0 ? [...tagFilterNames.value] : null
    const cutoff = threeDayCutoff()

    const result = await window.api.queryEarlierNotes({
      statuses,
      tagNames,
      cutoffTime: cutoff,
      limit: earlierLimit.value,
      offset: earlierOffset.value
    })
    if (requestSeq !== earlierRequestSeq || parentLoadSeq !== loadSeq) return
    const newNotes = result.notes || []
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
  noteList.value = noteList.value.filter(n => !earlierIds.value.has(n.id))
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
const customList = ref([])          // 唯一列表（置顶 + 日常已加载）
const customNormalOffset = ref(0)
const customNormalHasMore = ref(false)
const customNormalTotal = ref(0)
const customNormalLimit = ref(10)   // 首 10，滚动后 20
const customNormalLoading = ref(false)

/** 自定义模式：并行加载置顶 + 日常首 10 条 */
async function loadCustom({ showLoading = true, replayAnimation = true, preserveAnchor = false } = {}) {
  const seq = ++loadSeq
  earlierRequestSeq++
  customMoreRequestSeq++
  earlierLoading.value = false
  customNormalLoading.value = false
  const anchor = preserveAnchor ? captureScrollAnchor() : null
  if (showLoading) loading.value = true
  try {
    const statuses = statusFilter.value.length > 0
      ? [...statusFilter.value]
      : ['initialized', 'in_progress', 'completed', 'cancelled']
    const tagNames = tagFilterNames.value.length > 0 ? [...tagFilterNames.value] : null

    const normalLimit = preserveAnchor
      ? Math.max(customNormalOffset.value, customNormalLimit.value)
      : customNormalLimit.value
    const [pinned, normalCount, activeTotal] = await Promise.all([
      window.api.queryCustomPinned({ statuses, tagNames }),
      window.api.queryCustomNormal({ statuses, tagNames, limit: normalLimit, offset: 0 }),
      window.api.countActiveNotes()
    ])
    if (seq !== loadSeq) return

    customList.value = [...(pinned || []), ...(normalCount.notes || [])]
    customNormalOffset.value = (normalCount.notes || []).length
    customNormalTotal.value = normalCount.total || 0
    customNormalHasMore.value = customNormalOffset.value < customNormalTotal.value
    allNoteTotal.value = Number(activeTotal) || 0
    if (replayAnimation) listAnimKey.value++
    await restoreScrollAnchor(anchor)
  } catch (e) {
    console.error('[NoteList] 加载自定义列表失败:', e)
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
    const statuses = statusFilter.value.length > 0
      ? [...statusFilter.value]
      : ['initialized', 'in_progress', 'completed', 'cancelled']
    const tagNames = tagFilterNames.value.length > 0 ? [...tagFilterNames.value] : null

    const result = await window.api.queryCustomNormal({
      statuses,
      tagNames,
      limit: customNormalLimit.value,
      offset: customNormalOffset.value
    })
    if (requestSeq !== customMoreRequestSeq || parentLoadSeq !== loadSeq) return
    const newNotes = result.notes || []
    customList.value = [...customList.value, ...newNotes]
    customNormalOffset.value += newNotes.length
    customNormalTotal.value = result.total || 0
    customNormalHasMore.value = customNormalOffset.value < customNormalTotal.value
    if (customNormalLimit.value === 10) {
      customNormalLimit.value = 20
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

  const filtered = all.filter(g => {
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
  customPinnedNotes.value = customList.value.filter(n => n.is_pinned)
  customNormalNotes.value = customList.value.filter(n => !n.is_pinned)
}

/** customList 变化时自动同步拖拽区 */
let _customSyncTimer = null
watch(customList, () => {
  clearTimeout(_customSyncTimer)
  _customSyncTimer = setTimeout(syncCustomZones, 0)
}, { deep: false })

// ---- 拖拽排序回调 ----

async function onCustomPinnedDragEnd() {
  let order = 65536
  for (const note of customPinnedNotes.value) {
    note.sort_order = order
    order += 65536
  }
  customList.value = [...customPinnedNotes.value, ...customNormalNotes.value]
  await persistSortOrder(customPinnedNotes.value)
}

async function onCustomNormalDragEnd() {
  let order = 65536
  for (const note of customNormalNotes.value) {
    note.sort_order = order
    order += 65536
  }
  customList.value = [...customPinnedNotes.value, ...customNormalNotes.value]
  await persistSortOrder(customNormalNotes.value)
}

async function persistSortOrder(list) {
  for (const note of list) {
    try {
      await window.api.updateNote(note.id, { sort_order: note.sort_order })
    } catch (e) {
      console.error('[NoteList] sort_order 持久化失败:', note.id, e)
    }
  }
}

/** 状态圆环的主操作：初始化提前开始，进行中标记完成。 */
async function onCardStatusAction(note) {
  try {
    let updated = null
    if (note.status === 'initialized') {
      updated = await window.api.startProgress(note.id)
    } else if (note.status === 'in_progress') {
      updated = await window.api.completeNote(note.id)
    } else {
      return
    }
    if (updated && !patchVisibleNote(updated)) await refreshInBackground()
  } catch (e) {
    console.error('[NoteList] 状态修改失败:', note.id, e)
  }
}

function patchVisibleNote(updated) {
  const allowed = statusFilter.value.length === 0 || statusFilter.value.includes(updated.status)
  if (!allowed) return false
  if (sortMode.value === 'timeline') {
    noteList.value = noteList.value.map((note) => note.id === updated.id ? mergeListItem(note, updated) : note)
    return true
  }
  customList.value = customList.value.map((note) => note.id === updated.id ? mergeListItem(note, updated) : note)
  syncCustomZones()
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
  const updated = typeof noteOrId === 'object' && Array.isArray(noteOrId.tags)
    ? noteOrId
    : await window.api.getNote(id)
  if (updated && !patchVisibleNote(updated)) await refreshInBackground()
}

async function refreshInBackground() {
  const options = { showLoading: false, replayAnimation: false, preserveAnchor: true }
  if (sortMode.value === 'timeline') return loadAll(options)
  const result = await loadCustom(options)
  syncCustomZones()
  return result
}

// ---- 模式切换 ----

async function switchMode(mode) {
  if (mode === 'custom') {
    await loadCustom()
    syncCustomZones()
    // 检查已加载的便签是否需要全局重排
    const needsReorder = customList.value.some(n => n.sort_order === 0)
    if (needsReorder) {
      const statuses = statusFilter.value.length > 0
        ? [...statusFilter.value]
        : ['initialized', 'in_progress', 'completed', 'cancelled']
      const tagNames = tagFilterNames.value.length > 0 ? [...tagFilterNames.value] : null
      await window.api.reorderCustomSortOrder({ statuses, tagNames })
      await loadCustom()
      syncCustomZones()
    }
  } else {
    await loadAll()
  }
}


const WINDOW_NAME = 'main'
const FILTER_KEY = 'list_filter'

/** 是否正在恢复持久化状态（恢复期间抑制自动重载/持久化，避免重复请求） */
let restoring = false

/** 持久化筛选状态到数据库 */
async function saveFilterState() {
  const state = {
    listMode: sortMode.value,
    tagNames: [...tagFilterNames.value],
    statusFilter: [...statusFilter.value]
  }
  await window.api.setSetting(WINDOW_NAME, 'filter', FILTER_KEY, JSON.stringify(state))
}

/** 从数据库恢复筛选状态 */
async function loadFilterState() {
  restoring = true
  try {
    const raw = await window.api.getSetting(WINDOW_NAME, FILTER_KEY)
    if (raw) {
      const state = JSON.parse(raw)
      if (state.listMode) sortMode.value = state.listMode
      if (state.tagNames) tagFilterNames.value = state.tagNames
      if (state.statusFilter) {
        const validStatuses = new Set(['initialized', 'in_progress', 'completed', 'cancelled'])
        const restored = state.statusFilter.filter((status) => validStatuses.has(status))
        statusFilter.value = restored.length ? restored : ['initialized', 'in_progress', 'completed']
      }
    }
  } catch (e) {
    console.warn('[NoteList] 恢复筛选状态失败:', e)
  } finally {
    // 等响应式 flush 完成后再解除抑制，防止恢复赋值触发重复加载
    await nextTick()
    restoring = false
  }
}

onMounted(async () => {
  await loadFilterState()
  // 统一入口：根据当前模式加载（时间线 / 自定义）
  await switchMode(sortMode.value)
})

let notesChangedTimer = null
const stopNotesChanged = window.api.onNotesChanged?.(() => {
  clearTimeout(notesChangedTimer)
  notesChangedTimer = setTimeout(refreshInBackground, 80)
})

onUnmounted(() => {
  clearTimeout(notesChangedTimer)
  clearTimeout(_customSyncTimer)
  stopNotesChanged?.()
  earlierRequestSeq++
  customMoreRequestSeq++
})

// 统一响应式入口：排序模式 / 标签 / 状态任一变化 → 重载 + 持久化
// （切换按钮只翻转 sortMode，加载与持久化都由这里负责，二者与按钮解耦）
watch(
  [sortMode, tagFilterNames, statusFilter],
  () => {
    if (restoring) return
    switchMode(sortMode.value) // 按当前条件重载
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
        <FilterTabs :modelValue="panelState" :options="panelOptions" @update:modelValue="onPanelClick" />
      </div>

      <!-- 右：展示板块（文字 + 切换图标） -->
      <div class="nl-toolbar-right">
        <button class="nl-mode-toggle" @click="toggleSortMode">
          <Transition name="nl-mode-text" mode="out-in">
            <span :key="sortMode" class="nl-mode-label">{{ sortModeLabel }}</span>
          </Transition>
          <span class="nl-mode-icon" :class="{ 'nl-mode-icon--spin': modeSpinning }">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 5.5h9l-2.4-2.4M12.5 10.5h-9l2.4 2.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
        </button>
      </div>
    </div>

    <!-- 筛选面板（标签 / 状态；太极=折叠态）—— 单一 out-in 过渡，避免两面板同时伸缩 -->
    <Transition :css="false" mode="out-in" @enter="onPanelEnter" @leave="onPanelLeave">
      <div v-if="panelState !== 'taiji'" :key="panelState" class="nl-panel-wrap">
        <div class="nl-panel-inner">
          <TagSelector v-if="panelState === 'tags'" v-model="tagFilterNames" class="nl-tags" />
          <div v-else class="nl-status-filter">
            <div class="nl-status-chips">
              <button
                v-for="(s, i) in statusOptions"
                :key="s.value"
                class="nl-status-chip nl-chip-anim"
                :class="{ 'nl-status-chip--active': statusFilter.includes(s.value) }"
                :style="{ animationDelay: staggerDelay(i) }"
                @click="toggleStatus(s.value)"
              >{{ s.label }}</button>
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 加载状态 -->
    <div v-if="loading" class="nl-loading">加载中…</div>

    <!-- ======== 时间线模式（时间标记 + 统一便签流） ======== -->
    <template v-else-if="sortMode === 'timeline'">
      <div ref="timelineScrollRef" :key="listAnimKey" class="nl-timeline nl-list-scroll scroll-y" @scroll="onTimelineScroll">
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
            <svg
              v-if="g.group === 'earlier'"
              width="12" height="12" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round"
              class="nl-group-chevron"
              :class="{ 'nl-group-chevron--collapsed': collapsedGroups['earlier'] }"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
          <template v-if="g.group !== 'earlier'">
            <NoteCard
              v-for="(note, ni) in g.items"
              :key="note.id"
              :note="note"
              :animation-delay="staggerDelay(g.offset + ni)"
              @select="emit('select', $event)"
              @status-action="onCardStatusAction"
            />
          </template>
        </div>
        <!-- 更早加载提示 -->
        <div v-if="!collapsedGroups['earlier'] && earlierLoading" class="nl-earlier-hint">加载中…</div>
        <div v-else-if="!collapsedGroups['earlier'] && earlierHasData && !earlierHasMore && earlierOffset > 0" class="nl-earlier-hint">没有更多便签</div>
        </template>
      </div>
      <!-- 底部计数 -->
      <div v-if="!timelineIsEmpty || allNoteTotal > 0" class="nl-footer-count">
        <span>当前页有 {{ totalRendered }} 条便签</span>
        <span>共有 {{ allNoteTotal }} 条</span>
      </div>
    </template>

    <!-- ======== 自定义模式 ======== -->
    <template v-else>
      <div ref="customScrollRef" :key="listAnimKey" class="nl-custom nl-list-scroll scroll-y" @scroll="onCustomScroll">
      <div v-if="customTotalRendered === 0" class="nl-empty-state">暂无便签</div>
      <template v-else>
      <!-- 置顶区 -->
      <div v-if="customPinnedNotes.length > 0" class="nl-zone nl-section">
        <div class="nl-zone-label">置顶 · {{ customPinnedNotes.length }}条</div>
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
          <template #item="{ element: note, index: i }">
            <NoteCard
              :note="note"
              draggable
              :animation-delay="staggerDelay(i)"
              @select="emit('select', $event)"
              @status-action="onCardStatusAction"
            />
          </template>
        </draggable>
      </div>

      <!-- 日常区 -->
      <div class="nl-zone nl-section">
        <div class="nl-zone-label">日常 · {{ customNormalTotal }}条</div>
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
          <template #item="{ element: note, index: i }">
            <NoteCard
              :note="note"
              draggable
              :animation-delay="staggerDelay(customPinnedNotes.length + i)"
              @select="emit('select', $event)"
              @status-action="onCardStatusAction"
            />
          </template>
        </draggable>
        <div v-if="customNormalLoading" class="nl-earlier-hint">加载中…</div>
        <div v-else-if="customNormalNotes.length > 0 && !customNormalHasMore" class="nl-earlier-hint">没有更多便签</div>
      </div>
      </template>
    </div>
      <!-- 底部计数 -->
      <div v-if="customTotalRendered > 0 || allNoteTotal > 0" class="nl-footer-count">
        <span>当前页有 {{ customTotalRendered }} 条便签</span>
        <span>共有 {{ allNoteTotal }} 条</span>
      </div>
    </template>
  </div>
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

/* 展示模式切换（文字 + 图标） */
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
  transition: color 150ms ease;
}
.nl-mode-toggle:hover {
  color: var(--text-color);
}
.nl-mode-label {
  display: inline-block;
}
.nl-mode-icon {
  display: inline-flex;
  align-items: center;
}
.nl-mode-icon svg {
  display: block;
}
/* 切换动效：图标向右移出深出，再从左侧滑回原位（与文字同向） */
.nl-mode-icon--spin svg {
  animation: nl-mode-swap 420ms cubic-bezier(0.45, 0, 0.25, 1);
}
@keyframes nl-mode-swap {
  0% {
    transform: translateX(0);
    opacity: 1;
  }
  45% {
    transform: translateX(14rem);
    opacity: 0;
  }
  46% {
    transform: translateX(-14rem);
    opacity: 0;
  }
  100% {
    transform: translateX(0);
    opacity: 1;
  }
}

/* 文字切换过渡：旧字往右滑出、新字从左滑入 */
.nl-mode-text-enter-active,
.nl-mode-text-leave-active {
  transition:
    opacity 200ms ease,
    transform 200ms ease;
}
.nl-mode-text-enter-from {
  opacity: 0;
  transform: translateX(-12rem);
}
.nl-mode-text-leave-to {
  opacity: 0;
  transform: translateX(12rem);
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
}

.nl-empty-state {
  display: grid;
  place-items: center;
  min-height: 180rem;
  padding: 32rem 20rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  letter-spacing: 0.02em;
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
  mask-image: linear-gradient(
    to bottom,
    black 0%,
    black calc(100% - 30rem),
    transparent 100%
  );
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
.nl-group-chevron { flex-shrink: 0; }
.nl-group-count {
  font-size: calc(var(--fs-secondary) * 0.82);
  font-weight: 400;
  opacity: 0.66;
}
.nl-group--earlier-toggle + .nl-section { margin-top: 8rem; }

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
  border-top: 1px solid rgb(var(--bg-color, 255 255 255) / 0.08);
  margin-top: 4rem;
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
  mask-image: linear-gradient(
    to bottom,
    black 0%,
    black calc(100% - 30rem),
    transparent 100%
  );
}
.nl-zone--archived {
  opacity: 0.6;
}
.nl-zone-label {
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
}

/* 状态 chip 逐个淡入上浮（复用 NoteCard 全局 nl-card-in 关键帧，延迟由 :style 注入 animationDelay） */
.nl-chip-anim {
  animation: nl-card-in 250ms cubic-bezier(0.22, 1, 0.36, 1) both;
}


/* ===== 展开面板容器（标签 / 状态）===== */
/* 动画元素本身不留内边距：全局 box-sizing:border-box 下，height:0 会被 padding 撑住无法归零，
   导致收拢末段视觉卡在 padding 高度、随后被 Vue 直接移除而“突然消失”。
   把间距放到内层 .nl-panel-inner，其高度仍计入外层 scrollHeight，动画即可平滑收到 0。
   外层 overflow 由 onPanelEnter / onPanelLeave 钩子在动画期间接管，动画结束后还原，
   避免常驻裁剪掉选中标签的 box-shadow 光晕。 */
.nl-panel-inner {}

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
  border: 1px solid rgba(128, 128, 128, 0.18);
  border-radius: 16rem;
  background: transparent;
  color: var(--text-color-secondary);
  cursor: pointer;
  transition: all 200ms ease;
  white-space: nowrap;
}
.nl-status-chip:hover {
  background: rgba(128, 128, 128, 0.06);
  border-color: rgba(128, 128, 128, 0.28);
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
</style>
