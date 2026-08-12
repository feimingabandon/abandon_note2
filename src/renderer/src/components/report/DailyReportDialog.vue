<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import AppModalShell from '../ui/AppModalShell.vue'
import BaseButton from '../ui/BaseButton.vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import DatePicker from '../ui/DatePicker.vue'
import { useMessage } from '../../composables/useMessage.js'
import { localDateKey } from '../../../../shared/calendar/calendar-date-rules.js'

const props = defineProps({
  visible: { type: Boolean, default: false }
})
const emit = defineEmits(['update:visible'])
const { showMessage } = useMessage()

const STATUS_OPTIONS = [
  { value: 'initialized', label: '初始化', color: '#0a84ff' },
  { value: 'in_progress', label: '进行中', color: '#ff9f0a' },
  { value: 'completed', label: '已完成', color: '#30d158' }
]
const STATUS_BY_VALUE = new Map(STATUS_OPTIONS.map((status) => [status.value, status]))

const dateKey = ref(localDateKey())
const statuses = ref(STATUS_OPTIONS.map((status) => status.value))
const notes = ref([])
const selectedIds = ref(new Set())
const loading = ref(false)
const exporting = ref(false)
const exportSuccessVisible = ref(false)
const exportedFileName = ref('')
const loadError = ref('')
let loadSequence = 0
let stopNotesListener = null

const selectedCount = computed(() => selectedIds.value.size)
const allSelected = computed(
  () => notes.value.length > 0 && selectedIds.value.size === notes.value.length
)

function statusDetails(status) {
  return STATUS_BY_VALUE.get(status) || STATUS_OPTIONS[0]
}

function formatTime(timestamp) {
  const date = new Date(Number(timestamp))
  if (Number.isNaN(date.getTime())) return '未记录'
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function noteTime(note) {
  return note.status === 'completed'
    ? `完成 ${formatTime(note.finished_at)}`
    : `生效 ${formatTime(note.effective_at)}`
}

async function loadPreview() {
  const sequence = ++loadSequence
  loading.value = true
  loadError.value = ''
  try {
    const result = await window.api.previewDailyReport({
      dateKey: dateKey.value,
      // Electron IPC 不能克隆 Vue 的响应式代理；跨进程前转成普通数组。
      statuses: [...statuses.value]
    })
    if (sequence !== loadSequence) return
    notes.value = Array.isArray(result?.notes) ? result.notes : []
    selectedIds.value = new Set(notes.value.map((note) => Number(note.id)))
  } catch (error) {
    if (sequence !== loadSequence) return
    notes.value = []
    selectedIds.value = new Set()
    loadError.value = error?.message || '日报内容加载失败'
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function toggleStatus(status) {
  statuses.value = statuses.value.includes(status)
    ? statuses.value.filter((item) => item !== status)
    : STATUS_OPTIONS.map((item) => item.value).filter(
        (item) => item === status || statuses.value.includes(item)
      )
}

function toggleNote(noteId) {
  const id = Number(noteId)
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

function selectAll() {
  selectedIds.value = new Set(notes.value.map((note) => Number(note.id)))
}

function clearSelection() {
  selectedIds.value = new Set()
}

function close() {
  if (exporting.value) return
  emit('update:visible', false)
}

async function exportReport() {
  if (selectedIds.value.size === 0 || exporting.value) return
  exporting.value = true
  try {
    const result = await window.api.exportDailyReport({
      dateKey: dateKey.value,
      statuses: [...statuses.value],
      noteIds: [...selectedIds.value]
    })
    if (result?.canceled) return
    exportedFileName.value = result?.fileName || `Abandon日报-${dateKey.value}.txt`
    emit('update:visible', false)
    await nextTick()
    exportSuccessVisible.value = true
  } catch (error) {
    showMessage('error', error?.message || '日报导出失败')
    await loadPreview()
  } finally {
    exporting.value = false
  }
}

async function openExportFolder() {
  try {
    if (typeof window.api.openDailyReportExportFolder === 'function') {
      await window.api.openDailyReportExportFolder()
    } else {
      // 开发热更新可能只刷新 renderer；复用旧 preload 已有方法完成兼容调用。
      await window.api.exportDailyReport({ action: 'open-folder' })
    }
  } catch (error) {
    showMessage('error', error?.message || '无法打开导出文件夹')
  }
}

watch(
  () => props.visible,
  (visible) => {
    if (!visible) {
      loadSequence += 1
      return
    }
    dateKey.value = localDateKey()
    statuses.value = STATUS_OPTIONS.map((status) => status.value)
  }
)

watch([dateKey, statuses], () => {
  if (props.visible) void loadPreview()
})

stopNotesListener = window.api.onNotesChanged?.(() => {
  if (props.visible) void loadPreview()
})

onBeforeUnmount(() => {
  loadSequence += 1
  stopNotesListener?.()
})
</script>

<template>
  <AppModalShell
    :visible="visible"
    title="日报导出"
    subtitle="选择日期和状态，并确认本次要导出的便签"
    width="min(700rem, calc(100vw - 32rem))"
    height="min(680rem, calc(100vh - 32rem))"
    :close-disabled="exporting"
    flush
    @update:visible="close"
  >
    <div class="daily-report">
      <section class="daily-report__filters" aria-label="日报筛选条件">
        <div class="daily-report__filter-row">
          <span class="daily-report__filter-label">日期</span>
          <DatePicker v-model="dateKey" aria-label="选择日报日期" />
        </div>
        <div class="daily-report__filter-row">
          <span class="daily-report__filter-label">状态</span>
          <div class="daily-report__statuses" aria-label="状态筛选，可多选">
            <button
              v-for="status in STATUS_OPTIONS"
              :key="status.value"
              type="button"
              class="daily-report__status"
              :class="{ 'is-selected': statuses.includes(status.value) }"
              :style="{ '--status-color': status.color }"
              :aria-pressed="statuses.includes(status.value)"
              @click="toggleStatus(status.value)"
            >
              <span class="daily-report__status-check" aria-hidden="true">
                <svg v-if="statuses.includes(status.value)" viewBox="0 0 16 16">
                  <path d="m3 8 3 3 7-7" />
                </svg>
              </span>
              <span class="daily-report__status-dot" />
              {{ status.label }}
            </button>
          </div>
        </div>
      </section>

      <section class="daily-report__preview" aria-label="待导出的便签">
        <header class="daily-report__preview-header">
          <strong>导出内容</strong>
          <div class="daily-report__selection-actions">
            <button type="button" :disabled="allSelected || notes.length === 0" @click="selectAll">
              全选
            </button>
            <button type="button" :disabled="selectedCount === 0" @click="clearSelection">
              取消全选
            </button>
          </div>
        </header>

        <div class="daily-report__list scroll-y" :aria-busy="loading">
          <div v-if="loading" class="daily-report__state">
            <span class="daily-report__spinner" aria-hidden="true" />
            正在读取日报内容…
          </div>
          <div v-else-if="loadError" class="daily-report__state is-error">
            <span>{{ loadError }}</span>
            <button type="button" @click="loadPreview">重新加载</button>
          </div>
          <div v-else-if="statuses.length === 0" class="daily-report__state">
            请至少选择一个便签状态
          </div>
          <div v-else-if="notes.length === 0" class="daily-report__state">
            当天没有符合状态条件的便签
          </div>
          <template v-else>
            <label
              v-for="note in notes"
              :key="note.id"
              class="daily-report-note"
              :class="{ 'is-selected': selectedIds.has(Number(note.id)) }"
            >
              <input
                type="checkbox"
                :checked="selectedIds.has(Number(note.id))"
                @change="toggleNote(note.id)"
              />
              <span class="daily-report-note__checkbox" aria-hidden="true">
                <svg viewBox="0 0 16 16"><path d="m3 8 3 3 7-7" /></svg>
              </span>
              <span class="daily-report-note__body">
                <span class="daily-report-note__meta">
                  <span
                    class="daily-report-note__status-dot"
                    :style="{ '--status-color': statusDetails(note.status).color }"
                  />
                  <span>{{ statusDetails(note.status).label }}</span>
                  <span aria-hidden="true">·</span>
                  <time>{{ noteTime(note) }}</time>
                  <span v-if="note.duration_days > 1" class="daily-report-note__duration">
                    持续 {{ note.duration_days }} 天
                  </span>
                </span>
                <span class="daily-report-note__content">{{ note.content }}</span>
              </span>
            </label>
          </template>
        </div>
      </section>
    </div>

    <template #footer>
      <span class="daily-report__selected-summary" aria-live="polite">
        已选择 {{ selectedCount }} 条
      </span>
      <BaseButton :disabled="exporting" @click="close">取消</BaseButton>
      <BaseButton
        variant="primary"
        :disabled="selectedCount === 0 || loading || exporting"
        @click="exportReport"
      >
        {{ exporting ? '正在导出…' : '导出 TXT' }}
      </BaseButton>
    </template>
  </AppModalShell>

  <ConfirmDialog
    v-model:visible="exportSuccessVisible"
    title="导出成功"
    :message="`日报已成功导出：\n${exportedFileName}`"
    confirm-text="打开文件夹"
    cancel-text="关闭"
    @confirm="openExportFolder"
  />
</template>

<style scoped>
.daily-report {
  display: flex;
  min-height: 0;
  height: 100%;
  flex-direction: column;
}
.daily-report__filters {
  display: grid;
  flex: 0 0 auto;
  gap: 12rem;
  padding: 16rem 19rem;
  border-bottom: 1px solid var(--ui-border-divider);
}
.daily-report__filter-row {
  display: grid;
  min-width: 0;
  grid-template-columns: 52rem minmax(0, 1fr);
  align-items: center;
}
.daily-report__filter-label {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.daily-report__filter-row :deep(.date-picker) {
  width: min(260rem, 100%);
}
.daily-report__statuses {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 7rem;
}
.daily-report__status {
  display: inline-flex;
  min-height: 30rem;
  align-items: center;
  gap: 6rem;
  padding: 0 10rem 0 7rem;
  border: 0;
  border-radius: 15rem;
  background: var(--ui-fill-passive);
  color: var(--text-color-secondary);
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
  transition:
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease,
    transform var(--motion-control) var(--ease-standard);
}
.daily-report__status:hover {
  background: var(--ui-fill-hover);
  color: var(--text-color);
}
.daily-report__status:active {
  transform: scale(0.98);
}
.daily-report__status.is-selected {
  background: color-mix(in srgb, var(--status-color) 15%, transparent);
  color: var(--text-color);
}
.daily-report__status-check {
  display: grid;
  width: 16rem;
  height: 16rem;
  place-items: center;
  border-radius: 50%;
  background: color-mix(in srgb, var(--text-color) 8%, transparent);
}
.daily-report__status.is-selected .daily-report__status-check {
  background: var(--status-color);
}
.daily-report__status-check svg {
  width: 11rem;
  height: 11rem;
  fill: none;
  stroke: #fff;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
}
.daily-report__status-dot,
.daily-report-note__status-dot {
  width: 7rem;
  height: 7rem;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--status-color);
}
.daily-report__preview {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  padding: 0 19rem 16rem;
}
.daily-report__preview-header {
  display: flex;
  min-height: 48rem;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 12rem;
}
.daily-report__preview-header strong {
  font-size: var(--fs-body);
  font-weight: 600;
}
.daily-report__selection-actions {
  display: flex;
  gap: 2rem;
}
.daily-report__selection-actions button,
.daily-report__state button {
  min-height: 28rem;
  padding: 0 7rem;
  border: 0;
  border-radius: 7rem;
  background: transparent;
  color: #0a84ff;
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
}
.daily-report__selection-actions button:hover:not(:disabled),
.daily-report__state button:hover {
  background: var(--ui-fill-hover);
}
.daily-report__selection-actions button:active:not(:disabled),
.daily-report__state button:active {
  transform: scale(0.98);
}
.daily-report__selection-actions button:disabled {
  opacity: 0.32;
  cursor: default;
}
.daily-report__list {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  border: 1px solid var(--ui-border-divider);
  border-radius: 11rem;
  background: var(--ui-surface-subtle);
}
.daily-report__state {
  display: flex;
  min-height: 180rem;
  align-items: center;
  justify-content: center;
  gap: 9rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  text-align: center;
}
.daily-report__state.is-error {
  flex-direction: column;
  color: #ff453a;
}
.daily-report__spinner {
  width: 15rem;
  height: 15rem;
  border: 2px solid color-mix(in srgb, #0a84ff 20%, transparent);
  border-top-color: #0a84ff;
  border-radius: 50%;
  animation: daily-report-spin 650ms linear infinite;
}
.daily-report-note {
  position: relative;
  display: flex;
  min-width: 0;
  gap: 11rem;
  padding: 12rem 13rem;
  color: var(--text-color);
  cursor: pointer;
}
.daily-report-note + .daily-report-note {
  border-top: 1px solid var(--ui-border-divider);
}
.daily-report-note input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  opacity: 0;
}
.daily-report-note__checkbox {
  display: grid;
  width: 18rem;
  height: 18rem;
  flex: 0 0 auto;
  place-items: center;
  margin-top: 2rem;
  border: 1px solid var(--ui-border-control);
  border-radius: 6rem;
  background: var(--ui-surface-control);
  transition:
    border-color var(--motion-fast) ease,
    background-color var(--motion-fast) ease,
    transform var(--motion-control) var(--ease-standard);
}
.daily-report-note:hover .daily-report-note__checkbox {
  border-color: var(--ui-border-hover);
}
.daily-report-note:active .daily-report-note__checkbox {
  transform: scale(0.94);
}
.daily-report-note.is-selected .daily-report-note__checkbox {
  border-color: #0a84ff;
  background: #0a84ff;
}
.daily-report-note__checkbox svg {
  width: 12rem;
  height: 12rem;
  fill: none;
  stroke: #fff;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
  opacity: 0;
}
.daily-report-note.is-selected .daily-report-note__checkbox svg {
  opacity: 1;
}
.daily-report-note__body {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 5rem;
}
.daily-report-note__meta {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 5rem;
  overflow: hidden;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  white-space: nowrap;
}
.daily-report-note__meta time {
  overflow: hidden;
  text-overflow: ellipsis;
}
.daily-report-note__duration {
  flex: 0 0 auto;
  margin-left: auto;
  padding: 2rem 6rem;
  border-radius: 8rem;
  background: var(--ui-fill-passive);
  font-size: calc(var(--fs-secondary) * 0.82);
}
.daily-report-note__content {
  display: -webkit-box;
  overflow: hidden;
  font-size: var(--fs-body);
  line-height: 1.48;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.daily-report__selected-summary {
  margin-right: auto;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
@keyframes daily-report-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 520px) {
  .daily-report__filter-row {
    grid-template-columns: 42rem minmax(0, 1fr);
  }
  .daily-report-note__duration {
    display: none;
  }
}
</style>
