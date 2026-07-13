<script setup>
/**
 * NoteList.vue — 便签列表（时间线 + 自定义拖拽双模式）
 *
 * 3.5 + 3.6: 新增自定义拖拽模式，集成 vuedraggable
 * - 置顶区（is_pinned=1, active/in_progress）: 可拖拽
 * - 日常区（is_pinned=0, active/in_progress）: 可拖拽
 * - 过期区（completed/cancelled/expired）: 只读
 */
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import draggable from 'vuedraggable'
import TagSelector from '../ui/TagSelector.vue'
import FilterTabs from '../ui/FilterTabs.vue'

const emit = defineEmits(['select', 'create'])

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
const notes = ref([])
/** 加载状态 */
const loading = ref(false)

/** 标签筛选名称列表 */
const tagFilterNames = ref([])

/** 筛选面板状态：tags | taiji | status（taiji=太极图默认折叠态） */
const panelState = ref('taiji')

/** 状态筛选列表 */
const statusFilter = ref([])

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
    loadNotes()
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
  { value: 'active', label: '待生效' },
  { value: 'in_progress', label: '进行中' },
  { value: 'completed', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
  { value: 'expired', label: '已过期' }
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

async function loadNotes() {
  const seq = ++loadSeq
  loading.value = true
  try {
    const defaultStatuses = sortMode.value === 'custom'
      ? ['active', 'in_progress', 'completed', 'cancelled', 'expired']
      : ['active', 'in_progress']

    const params = { sortMode: sortMode.value }
    params.statuses = statusFilter.value.length > 0 ? [...statusFilter.value] : defaultStatuses
    params.tagNames = tagFilterNames.value.length > 0 ? [...tagFilterNames.value] : null

    const result = await window.api.listNotes(params)
    if (seq !== loadSeq) return // 已有更新的请求发起，丢弃本次旧结果
    notes.value = result.notes || []
    listAnimKey.value++ // 触发列表容器重挂载，重放逐条入场动画
  } catch (e) {
    console.error('[NoteList] 加载列表失败:', e)
  } finally {
    if (seq === loadSeq) loading.value = false // 仅最新请求可结束 loading 态
  }
}

// ============================================================
// 时间线分组
// ============================================================

function timeGroup(ts) {
  const now = new Date()
  const target = new Date(ts)
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 86400000
  if (target.getTime() >= todayStart) return 'today'
  if (target.getTime() >= yesterdayStart) return 'yesterday'
  return 'earlier'
}

const groupLabels = { today: '今天', yesterday: '昨天', earlier: '更早' }

const timelineGroups = computed(() => {
  const pinned = notes.value.filter((n) => n.is_pinned)
  const unpinned = notes.value.filter((n) => !n.is_pinned)
  const groups = []
  if (pinned.length > 0) groups.push({ group: 'pinned', label: '📌 置顶', items: pinned })
  let currentGroup = null
  for (const note of unpinned) {
    const g = timeGroup(note.effective_at)
    if (g !== currentGroup) {
      currentGroup = g
      groups.push({ group: g, label: groupLabels[g], items: [] })
    }
    groups[groups.length - 1].items.push(note)
  }
  // 为每组标记其之前的累计条数，供卡片跨组连续错峰
  let acc = 0
  for (const grp of groups) {
    grp.offset = acc
    acc += grp.items.length
  }
  return groups
})

// ============================================================
// 自定义模式（3.5 三区域）
// ============================================================

// 置顶区 / 日常区要作为 vuedraggable 的可写 v-model（拖拽会就地重排元素），
// 故用 ref + watch(notes) 派生为「可变数组」；过期区只读，直接用 computed 即可。
const pinnedNotes = ref([])
const normalNotes = ref([])
const archivedNotes = computed(() =>
  notes.value.filter((n) => ['completed', 'cancelled', 'expired'].includes(n.status))
)

/** 便签数据变化时，重新派生可写的置顶区 / 日常区（供 vuedraggable 拖拽重排） */
watch(
  notes,
  () => {
    pinnedNotes.value = notes.value.filter(
      (n) => n.is_pinned && ['active', 'in_progress'].includes(n.status)
    )
    normalNotes.value = notes.value.filter(
      (n) => !n.is_pinned && ['active', 'in_progress'].includes(n.status)
    )
  },
  { immediate: true }
)

let needsGlobalReorder = false

// ============================================================
// 拖拽排序回调（3.6）
// ============================================================

async function onPinnedDragEnd() {
  await syncSortOrder(pinnedNotes.value)
}
async function onNormalDragEnd() {
  await syncSortOrder(normalNotes.value)
}

/** 大间距策略持久化 sort_order（顺序执行，防并发写入丢失） */
async function syncSortOrder(list) {
  let order = 65536
  for (const note of list) {
    try {
      await window.api.updateNote(note.id, { sort_order: order })
      order += 65536
    } catch (e) {
      console.error('[NoteList] sort_order 持久化失败:', note.id, e)
    }
  }
}

// ============================================================
// 模式切换
// ============================================================

async function switchMode(mode) {
  if (mode === 'custom') {
    const active = notes.value.filter((n) => ['active', 'in_progress'].includes(n.status))
    needsGlobalReorder = active.some((n) => n.sort_order === 0)
  }
  await loadNotes()
  if (mode === 'custom' && needsGlobalReorder) {
    // 直接从 notes 派生重排列表（置顶在前），不依赖 watch(notes) 的 flush 时机
    const active = notes.value.filter((n) => ['active', 'in_progress'].includes(n.status))
    const ordered = [...active.filter((n) => n.is_pinned), ...active.filter((n) => !n.is_pinned)]
    await syncSortOrder(ordered)
    needsGlobalReorder = false
    await loadNotes()
  }
}

// ============================================================
// 创建 / 工具函数
// ============================================================

async function handleCreate() {
  try {
    await window.api.createNote({ content: '' })
    emit('create')
    await loadNotes()
  } catch (e) {
    console.error('[NoteList] 创建便签失败:', e)
  }
}

/** 状态 value → label 映射（由 statusOptions 派生，单一真相源，仅构建一次） */
const statusLabelMap = Object.fromEntries(statusOptions.map((o) => [o.value, o.label]))
function statusLabel(s) {
  return statusLabelMap[s] || s
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
      if (state.statusFilter) statusFilter.value = state.statusFilter
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

defineExpose({ refresh: loadNotes })
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

    <!-- 加载/空状态 -->
    <div v-if="loading" class="nl-loading">加载中…</div>
    <div v-else-if="notes.length === 0" class="nl-empty">
      <p>暂无便签</p>
      <button class="nl-empty-btn" @click="handleCreate">创建第一条便签</button>
    </div>

    <!-- ======== 时间线模式 ======== -->
    <div v-else-if="sortMode === 'timeline'" :key="listAnimKey" class="nl-timeline scroll-y">
      <div v-for="g in timelineGroups" :key="g.group" class="nl-group">
        <div class="nl-group-label">{{ g.label }}</div>
        <div
          v-for="(note, ni) in g.items"
          :key="note.id"
          class="nl-card nl-card-anim"
          :style="{ animationDelay: staggerDelay(g.offset + ni) }"
          @click="emit('select', note)"
        >
          <div class="nl-card-body">
            <span class="nl-card-text">{{ note.content || '（空内容）' }}</span>
            <div class="nl-card-meta">
              <span class="nl-card-status" :class="'nl-status--' + note.status">{{
                statusLabel(note.status)
              }}</span>
              <span
                v-for="tag in note.tags"
                :key="tag.id"
                class="nl-card-tag"
                :style="tag.color ? { backgroundColor: tag.color + '22', color: tag.color } : {}"
                >{{ tag.name }}</span
              >
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ======== 自定义模式 ======== -->
    <div v-else :key="listAnimKey" class="nl-custom scroll-y">
      <!-- 置顶区 -->
      <div class="nl-zone">
        <div class="nl-zone-label">📌 置顶区</div>
        <draggable
          v-model="pinnedNotes"
          :group="{ name: 'pinned', pull: false, put: false }"
          item-key="id"
          class="nl-dropzone"
          ghost-class="nl-ghost"
          @end="onPinnedDragEnd"
        >
          <template #item="{ element: note, index: i }">
            <div
              class="nl-card nl-card--draggable nl-card-anim"
              :style="{ animationDelay: staggerDelay(i) }"
              @click="emit('select', note)"
            >
              <span class="nl-handle">⠿</span>
              <div class="nl-card-body">
                <span class="nl-card-text">{{ note.content || '（空内容）' }}</span>
                <div class="nl-card-meta">
                  <span class="nl-card-status" :class="'nl-status--' + note.status">{{
                    statusLabel(note.status)
                  }}</span>
                  <span
                    v-for="tag in note.tags"
                    :key="tag.id"
                    class="nl-card-tag"
                    :style="
                      tag.color ? { backgroundColor: tag.color + '22', color: tag.color } : {}
                    "
                    >{{ tag.name }}</span
                  >
                </div>
              </div>
            </div>
          </template>
        </draggable>
        <div v-if="pinnedNotes.length === 0" class="nl-zone-empty">拖拽便签到此处置顶</div>
      </div>

      <!-- 日常区 -->
      <div class="nl-zone">
        <div class="nl-zone-label">📋 日常区</div>
        <draggable
          v-model="normalNotes"
          :group="{ name: 'normal', pull: false, put: false }"
          item-key="id"
          class="nl-dropzone"
          ghost-class="nl-ghost"
          @end="onNormalDragEnd"
        >
          <template #item="{ element: note, index: i }">
            <div
              class="nl-card nl-card--draggable nl-card-anim"
              :style="{ animationDelay: staggerDelay(pinnedNotes.length + i) }"
              @click="emit('select', note)"
            >
              <span class="nl-handle">⠿</span>
              <div class="nl-card-body">
                <span class="nl-card-text">{{ note.content || '（空内容）' }}</span>
                <div class="nl-card-meta">
                  <span class="nl-card-status" :class="'nl-status--' + note.status">{{
                    statusLabel(note.status)
                  }}</span>
                  <span
                    v-for="tag in note.tags"
                    :key="tag.id"
                    class="nl-card-tag"
                    :style="
                      tag.color ? { backgroundColor: tag.color + '22', color: tag.color } : {}
                    "
                    >{{ tag.name }}</span
                  >
                </div>
              </div>
            </div>
          </template>
        </draggable>
        <div v-if="normalNotes.length === 0" class="nl-zone-empty">暂无活跃便签</div>
      </div>

      <!-- 过期区（只读） -->
      <div v-if="archivedNotes.length > 0" class="nl-zone nl-zone--archived">
        <div class="nl-zone-label">📦 过期区</div>
        <div
          v-for="(note, i) in archivedNotes"
          :key="note.id"
          class="nl-card nl-card--muted nl-card-anim"
          :style="{ animationDelay: staggerDelay(pinnedNotes.length + normalNotes.length + i) }"
          @click="emit('select', note)"
        >
          <div class="nl-card-body">
            <span class="nl-card-text">{{ note.content || '（空内容）' }}</span>
            <div class="nl-card-meta">
              <span class="nl-card-status" :class="'nl-status--' + note.status">{{
                statusLabel(note.status)
              }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
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
  border-bottom: 1px solid rgba(128, 128, 128, 0.15);
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

/* ===== 空/加载状态 ===== */
.nl-loading,
.nl-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40rem 20rem;
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
  gap: 12rem;
}
.nl-empty-btn {
  padding: 8rem 16rem;
  font-size: var(--fs-secondary);
  font-family: inherit;
  font-weight: 500;
  border: 1px solid rgba(128, 128, 128, 0.2);
  border-radius: 8rem;
  background: transparent;
  color: var(--text-color);
  cursor: pointer;
}

/* ===== 时间线 ===== */
.nl-timeline {
  flex: 1;
  padding: 8rem 0;
}
.nl-group {
  margin-bottom: 16rem;
}
.nl-group-label {
  font-size: var(--fs-secondary);
  font-weight: 500;
  color: var(--text-color-secondary);
  padding: 6rem 0 4rem;
}

/* ===== 自定义模式 ===== */
.nl-custom {
  flex: 1;
  padding: 8rem 0;
}
.nl-zone {
  margin-bottom: 20rem;
}
.nl-zone--archived {
  opacity: 0.6;
}
.nl-zone-label {
  font-size: var(--fs-secondary);
  font-weight: 500;
  color: var(--text-color-secondary);
  padding: 6rem 8rem 4rem;
  margin-bottom: 4rem;
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

/* ===== 列表卡片逐条入场（依次淡入上浮，延迟由 :style 按序号注入） ===== */
.nl-card-anim {
  animation: nl-card-in 250ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes nl-card-in {
  from {
    opacity: 0;
    transform: translateY(6rem);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 状态 chip 逐个淡入上浮（复用卡片关键帧，延迟由 :style 注入 animationDelay） */
.nl-chip-anim {
  animation: nl-card-in 250ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

/* ===== 便签卡片 ===== */
.nl-card {
  display: flex;
  align-items: flex-start;
  gap: 8rem;
  padding: 10rem 12rem;
  margin: 2rem 0;
  border-radius: 8rem;
  cursor: pointer;
  transition: background-color 120ms ease;
}
.nl-card:hover {
  background: rgba(255, 255, 255, 0.06);
}
.nl-card--draggable {
  cursor: grab;
}
.nl-card--muted {
  cursor: default;
  opacity: 0.7;
}
.nl-handle {
  font-size: var(--fs-body);
  color: var(--text-color-secondary);
  margin-top: 2rem;
  opacity: 0;
  transition: opacity 120ms ease;
  flex-shrink: 0;
}
.nl-card:hover .nl-handle {
  opacity: 1;
}
.nl-card-body {
  flex: 1;
  min-width: 0;
}
.nl-card-text {
  font-size: var(--fs-body);
  color: var(--text-color);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.nl-card-meta {
  display: flex;
  align-items: center;
  gap: 6rem;
  flex-wrap: wrap;
  margin-top: 6rem;
}
.nl-card-status {
  font-size: calc(var(--fs-secondary) * 0.88);
  padding: 2rem 6rem;
  border-radius: 4rem;
  background: rgba(128, 128, 128, 0.12);
}
.nl-status--active {
  background: rgba(0, 122, 255, 0.12);
}
.nl-status--in_progress {
  background: rgba(255, 149, 0, 0.12);
}
.nl-status--completed {
  background: rgba(52, 199, 89, 0.12);
}
.nl-card-tag {
  font-size: calc(var(--fs-secondary) * 0.85);
  padding: 1rem 5rem;
  border-radius: 3rem;
}

/* ===== 展开面板容器（标签 / 状态）===== */
/* 动画元素本身不留内边距：全局 box-sizing:border-box 下，height:0 会被 padding 撑住无法归零，
   导致收拢末段视觉卡在 padding 高度、随后被 Vue 直接移除而“突然消失”。
   把间距放到内层 .nl-panel-inner，其高度仍计入外层 scrollHeight，动画即可平滑收到 0。
   外层 overflow 由 onPanelEnter / onPanelLeave 钩子在动画期间接管，动画结束后还原，
   避免常驻裁剪掉选中标签的 box-shadow 光晕。 */
.nl-panel-inner {
  padding-top: 10rem;
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
  padding: 4rem 12rem;
  font-size: var(--fs-secondary);
  font-family: inherit;
  font-weight: 500;
  border: 1px solid rgba(128, 128, 128, 0.15);
  border-radius: 14rem;
  background: rgba(128, 128, 128, 0.05);
  color: var(--text-color-secondary);
  cursor: pointer;
  transition:
    background-color 150ms ease,
    border-color 150ms ease,
    color 150ms ease;
  white-space: nowrap;
}
.nl-status-chip:hover {
  background: rgba(128, 128, 128, 0.1);
}
.nl-status-chip--active {
  background: rgba(0, 122, 255, 0.12);
  border-color: rgba(0, 122, 255, 0.3);
  color: #007aff;
}
</style>
