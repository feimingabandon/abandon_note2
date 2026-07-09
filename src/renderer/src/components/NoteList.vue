<script setup>
/**
 * NoteList.vue — 便签列表（时间线 + 自定义拖拽双模式）
 *
 * 3.5 + 3.6: 新增自定义拖拽模式，集成 vuedraggable
 * - 置顶区（is_pinned=1, active/in_progress）: 可拖拽
 * - 日常区（is_pinned=0, active/in_progress）: 可拖拽
 * - 过期区（completed/cancelled/expired）: 只读
 */
import { ref, computed, onMounted, watch } from 'vue'
import draggable from 'vuedraggable'

const props = defineProps({
  filterTagNames: { type: Array, default: () => [] }
})

const emit = defineEmits(['select', 'create'])

/** 排序模式：timeline | custom */
const sortMode = ref('timeline')

/** 便签列表 */
const notes = ref([])
/** 加载状态 */
const loading = ref(false)

/** 批量选择模式 */
const selectionMode = ref(false)
/** 已选中的便签 ID 集合 */
const selectedIds = ref(new Set())

/** 已选中的便签数量 */
const selectedCount = computed(() => selectedIds.value.size)

// ============================================================
// 数据加载
// ============================================================

async function loadNotes() {
  loading.value = true
  try {
    const result = await window.api.listNotes({
      statuses:
        sortMode.value === 'custom'
          ? ['active', 'in_progress', 'completed', 'cancelled', 'expired']
          : ['active', 'in_progress'],
      sortMode: sortMode.value,
      tagNames: props.filterTagNames.length > 0 ? props.filterTagNames : null
    })
    notes.value = result.notes || []
  } catch (e) {
    console.error('[NoteList] 加载列表失败:', e)
  } finally {
    loading.value = false
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

function timelineGroups() {
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
  return groups
}

// ============================================================
// 自定义模式（3.5 三区域）
// ============================================================

const pinnedNotes = computed(() =>
  notes.value.filter((n) => n.is_pinned && ['active', 'in_progress'].includes(n.status))
)
const normalNotes = computed(() =>
  notes.value.filter((n) => !n.is_pinned && ['active', 'in_progress'].includes(n.status))
)
const archivedNotes = computed(() =>
  notes.value.filter((n) => ['completed', 'cancelled', 'expired'].includes(n.status))
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
  sortMode.value = mode
  if (mode === 'custom') {
    const active = notes.value.filter((n) => ['active', 'in_progress'].includes(n.status))
    needsGlobalReorder = active.some((n) => n.sort_order === 0)
  }
  await loadNotes()
  if (mode === 'custom' && needsGlobalReorder) {
    await syncSortOrder([...pinnedNotes.value, ...normalNotes.value])
    needsGlobalReorder = false
    await loadNotes()
  }
}

// ============================================================
// 批量操作
// ============================================================

/** 切换选择模式 */
function toggleSelectionMode() {
  selectionMode.value = !selectionMode.value
  if (!selectionMode.value) {
    selectedIds.value = new Set()
  }
}

/** 切换单条便签选中状态 */
function toggleSelect(id) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  selectedIds.value = next
}

/** 全选（仅活跃便签） */
function selectAll() {
  const next = new Set()
  notes.value
    .filter((n) => ['active', 'in_progress'].includes(n.status))
    .forEach((n) => next.add(n.id))
  selectedIds.value = next
}

/** 取消全选 */
function deselectAll() {
  selectedIds.value = new Set()
}

/** 批量完成 */
async function batchComplete() {
  const ids = [...selectedIds.value]
  if (ids.length === 0) return
  try {
    await window.api.batchUpdateStatus(ids, 'completed')
    selectedIds.value = new Set()
    await loadNotes()
  } catch (e) {
    console.error('[NoteList] 批量完成失败:', e)
  }
}

/** 批量取消 */
async function batchCancel() {
  const ids = [...selectedIds.value]
  if (ids.length === 0) return
  try {
    await window.api.batchUpdateStatus(ids, 'cancelled')
    selectedIds.value = new Set()
    await loadNotes()
  } catch (e) {
    console.error('[NoteList] 批量取消失败:', e)
  }
}

/** 批量置顶/取消置顶 */
async function batchTogglePin(pinned) {
  const ids = [...selectedIds.value]
  if (ids.length === 0) return
  try {
    await window.api.batchSetPinned(ids, pinned)
    selectedIds.value = new Set()
    await loadNotes()
  } catch (e) {
    console.error('[NoteList] 批量置顶失败:', e)
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

function statusLabel(s) {
  const map = {
    active: '待处理',
    in_progress: '进行中',
    completed: '已完成',
    cancelled: '已取消',
    expired: '已过期'
  }
  return map[s] || s
}

onMounted(loadNotes)

// 标签筛选变化时重新加载
watch(() => props.filterTagNames, loadNotes, { deep: true })

defineExpose({ refresh: loadNotes })
</script>

<template>
  <div class="note-list">
    <!-- 工具栏 -->
    <div class="nl-toolbar">
      <span class="nl-title">便签</span>
      <span class="nl-count">{{ notes.length }} 条</span>
      <div class="nl-spacer" />
      <button class="nl-select-btn" :class="{ active: selectionMode }" @click="toggleSelectionMode">
        {{ selectionMode ? '取消' : '选择' }}
      </button>
      <div class="nl-mode-switch">
        <button :class="{ active: sortMode === 'timeline' }" @click="switchMode('timeline')">
          时间线
        </button>
        <button :class="{ active: sortMode === 'custom' }" @click="switchMode('custom')">
          自定义
        </button>
      </div>
      <button class="nl-add-btn" @click="handleCreate">+ 新建</button>
    </div>

    <!-- 批量操作工具栏 -->
    <div v-if="selectionMode && selectedCount > 0" class="nl-batch-toolbar">
      <span class="nl-batch-count">已选 {{ selectedCount }} 条</span>
      <button class="nl-batch-btn" @click="selectAll">全选</button>
      <button class="nl-batch-btn" @click="deselectAll">取消全选</button>
      <span class="nl-batch-sep" />
      <button class="nl-batch-btn nl-batch-btn--primary" @click="batchComplete">完成</button>
      <button class="nl-batch-btn nl-batch-btn--danger" @click="batchCancel">取消</button>
      <button class="nl-batch-btn" @click="batchTogglePin(true)">置顶</button>
      <button class="nl-batch-btn" @click="batchTogglePin(false)">取消置顶</button>
    </div>

    <!-- 加载/空状态 -->
    <div v-if="loading" class="nl-loading">加载中…</div>
    <div v-else-if="notes.length === 0" class="nl-empty">
      <p>暂无便签</p>
      <button class="nl-empty-btn" @click="handleCreate">创建第一条便签</button>
    </div>

    <!-- ======== 时间线模式 ======== -->
    <div v-else-if="sortMode === 'timeline'" class="nl-timeline scroll-y">
      <div v-for="g in timelineGroups()" :key="g.group" class="nl-group">
        <div class="nl-group-label">{{ g.label }}</div>
        <div
          v-for="note in g.items"
          :key="note.id"
          class="nl-card"
          :class="{ 'nl-card--selected': selectionMode && selectedIds.has(note.id) }"
          @click="selectionMode ? toggleSelect(note.id) : emit('select', note)"
        >
          <span
            v-if="selectionMode"
            class="nl-checkbox"
            :class="{ 'nl-checkbox--on': selectedIds.has(note.id) }"
            >{{ selectedIds.has(note.id) ? '◉' : '○' }}</span
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
    <div v-else class="nl-custom scroll-y">
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
          <template #item="{ element: note }">
            <div
              class="nl-card nl-card--draggable"
              :class="{ 'nl-card--selected': selectionMode && selectedIds.has(note.id) }"
              @click="selectionMode ? toggleSelect(note.id) : emit('select', note)"
            >
              <span v-if="!selectionMode" class="nl-handle">⠿</span>
              <span
                v-if="selectionMode"
                class="nl-checkbox"
                :class="{ 'nl-checkbox--on': selectedIds.has(note.id) }"
                >{{ selectedIds.has(note.id) ? '◉' : '○' }}</span
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
          <template #item="{ element: note }">
            <div
              class="nl-card nl-card--draggable"
              :class="{ 'nl-card--selected': selectionMode && selectedIds.has(note.id) }"
              @click="selectionMode ? toggleSelect(note.id) : emit('select', note)"
            >
              <span v-if="!selectionMode" class="nl-handle">⠿</span>
              <span
                v-if="selectionMode"
                class="nl-checkbox"
                :class="{ 'nl-checkbox--on': selectedIds.has(note.id) }"
                >{{ selectedIds.has(note.id) ? '◉' : '○' }}</span
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
          v-for="note in archivedNotes"
          :key="note.id"
          class="nl-card nl-card--muted"
          :class="{ 'nl-card--selected': selectionMode && selectedIds.has(note.id) }"
          @click="selectionMode ? toggleSelect(note.id) : emit('select', note)"
        >
          <span
            v-if="selectionMode"
            class="nl-checkbox"
            :class="{ 'nl-checkbox--on': selectedIds.has(note.id) }"
            >{{ selectedIds.has(note.id) ? '◉' : '○' }}</span
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
  gap: 10rem;
  padding: 12rem 12rem;
  border-bottom: 1px solid rgba(128, 128, 128, 0.15);
  flex-shrink: 0;
}
.nl-title {
  font-size: var(--fs-title);
  font-weight: 700;
}
.nl-count {
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
}
.nl-spacer {
  flex: 1;
}
.nl-mode-switch {
  display: flex;
  background: rgba(128, 128, 128, 0.08);
  border-radius: 6rem;
  overflow: hidden;
}
.nl-mode-switch button {
  padding: 5rem 12rem;
  font-size: var(--fs-secondary);
  font-family: inherit;
  font-weight: 500;
  border: none;
  background: transparent;
  color: var(--text-color-secondary);
  cursor: pointer;
  transition:
    background-color 150ms ease,
    color 150ms ease;
}
.nl-mode-switch button.active {
  background: rgba(255, 255, 255, 0.12);
  color: var(--text-color);
}
.nl-add-btn {
  padding: 6rem 14rem;
  font-size: var(--fs-secondary);
  font-family: inherit;
  font-weight: 500;
  border: none;
  border-radius: 6rem;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-color);
  cursor: pointer;
}
.nl-add-btn:hover {
  background: rgba(255, 255, 255, 0.15);
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
  padding: 8rem 12rem;
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
  padding: 8rem 12rem;
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

/* ===== 选择按钮 ===== */
.nl-select-btn {
  padding: 5rem 12rem;
  font-size: var(--fs-secondary);
  font-family: inherit;
  font-weight: 500;
  border: 1px solid rgba(128, 128, 128, 0.2);
  border-radius: 6rem;
  background: transparent;
  color: var(--text-color-secondary);
  cursor: pointer;
  transition:
    background-color 150ms ease,
    color 150ms ease;
}
.nl-select-btn.active {
  background: rgba(0, 122, 255, 0.15);
  color: rgb(0, 122, 255);
  border-color: rgba(0, 122, 255, 0.3);
}

/* ===== 批量工具栏 ===== */
.nl-batch-toolbar {
  display: flex;
  align-items: center;
  gap: 6rem;
  padding: 8rem 12rem;
  background: rgba(0, 122, 255, 0.06);
  border-bottom: 1px solid rgba(0, 122, 255, 0.1);
  flex-shrink: 0;
}
.nl-batch-count {
  font-size: var(--fs-secondary);
  font-weight: 600;
  color: rgb(0, 122, 255);
}
.nl-batch-btn {
  padding: 4rem 10rem;
  font-size: calc(var(--fs-secondary) * 0.9);
  font-family: inherit;
  font-weight: 500;
  border: 1px solid rgba(128, 128, 128, 0.2);
  border-radius: 4rem;
  background: rgba(128, 128, 128, 0.06);
  color: var(--text-color-secondary);
  cursor: pointer;
  transition:
    background-color 120ms ease,
    color 120ms ease;
}
.nl-batch-btn:hover {
  background: rgba(128, 128, 128, 0.12);
  color: var(--text-color);
}
.nl-batch-btn--primary {
  background: rgba(52, 199, 89, 0.12);
  color: rgb(52, 199, 89);
  border-color: rgba(52, 199, 89, 0.25);
}
.nl-batch-btn--primary:hover {
  background: rgba(52, 199, 89, 0.2);
}
.nl-batch-btn--danger {
  background: rgba(255, 59, 48, 0.1);
  color: rgb(255, 59, 48);
  border-color: rgba(255, 59, 48, 0.2);
}
.nl-batch-btn--danger:hover {
  background: rgba(255, 59, 48, 0.18);
}
.nl-batch-sep {
  width: 1px;
  height: 16rem;
  background: rgba(128, 128, 128, 0.2);
  margin: 0 2rem;
}

/* ===== 复选框 ===== */
.nl-checkbox {
  flex-shrink: 0;
  font-size: var(--fs-body);
  color: var(--text-color-secondary);
  margin-right: 6rem;
  cursor: pointer;
  transition: color 120ms ease;
}
.nl-checkbox--on {
  color: rgb(0, 122, 255);
}

/* ===== 选中卡片高亮 ===== */
.nl-card--selected {
  background: rgba(0, 122, 255, 0.08) !important;
}
</style>
