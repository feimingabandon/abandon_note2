<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import AppModalShell from '../ui/AppModalShell.vue'
import BaseButton from '../ui/BaseButton.vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import DatePicker from '../ui/DatePicker.vue'
import { useMessage } from '../../composables/useMessage.js'
import { dateOrdinal, localDateKey } from '../../../../shared/calendar/calendar-date-rules.js'

const props = defineProps({
  visible: { type: Boolean, default: false }
})
const emit = defineEmits(['update:visible'])
const { showMessage } = useMessage()

const STATUS_OPTIONS = [
  { value: 'initialized', label: '待开始', color: 'var(--ui-status-pending)' },
  { value: 'in_progress', label: '进行中', color: 'var(--ui-status-progress)' },
  { value: 'completed', label: '已完成', color: 'var(--ui-status-completed)' }
]
const STATUS_BY_VALUE = new Map(STATUS_OPTIONS.map((status) => [status.value, status]))
const EXPORT_FORMAT_OPTIONS = [
  { value: 'txt', label: 'TXT' },
  { value: 'xlsx', label: 'Excel' }
]
const MAX_RANGE_DAYS = 366

const startDateKey = ref(localDateKey())
const endDateKey = ref(localDateKey())
const statuses = ref(STATUS_OPTIONS.map((status) => status.value))
const exportFormat = ref('txt')
const notes = ref([])
const selectedIds = ref(new Set())
const loading = ref(false)
const exporting = ref(false)
const exportSuccessVisible = ref(false)
const exportedFileName = ref('')
const exportSuccessMessage = ref('')
const loadError = ref('')
let loadSequence = 0
let stopNotesListener = null

const selectedCount = computed(() => selectedIds.value.size)
const allSelected = computed(
  () => notes.value.length > 0 && selectedIds.value.size === notes.value.length
)
const rangeValidationMessage = computed(() => {
  const dayCount = dateOrdinal(endDateKey.value) - dateOrdinal(startDateKey.value) + 1
  if (dayCount <= 0) return '结束日期不能早于开始日期'
  if (dayCount > MAX_RANGE_DAYS) return `单次导出范围不能超过 ${MAX_RANGE_DAYS} 天`
  return ''
})
const exportButtonLabel = computed(() =>
  exporting.value ? '正在导出…' : exportFormat.value === 'xlsx' ? '导出 Excel' : '导出 TXT'
)

function statusDetails(status) {
  return STATUS_BY_VALUE.get(status) || STATUS_OPTIONS[0]
}

function formatTime(timestamp) {
  const date = new Date(Number(timestamp))
  if (Number.isNaN(date.getTime())) return '未记录'
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function noteTime(note) {
  return note.status === 'completed'
    ? `完成 ${formatTime(note.finished_at)}`
    : `生效 ${formatTime(note.effective_at)}`
}

async function loadPreview() {
  const sequence = ++loadSequence
  if (rangeValidationMessage.value) {
    notes.value = []
    selectedIds.value = new Set()
    loading.value = false
    loadError.value = ''
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    const result = await window.api.previewDailyReport({
      startDateKey: startDateKey.value,
      endDateKey: endDateKey.value,
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
    loadError.value = error?.message || '报表内容加载失败'
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
  if (selectedIds.value.size === 0 || exporting.value || rangeValidationMessage.value) return
  exporting.value = true
  try {
    const result = await window.api.exportDailyReport({
      startDateKey: startDateKey.value,
      endDateKey: endDateKey.value,
      statuses: [...statuses.value],
      noteIds: [...selectedIds.value],
      format: exportFormat.value
    })
    if (result?.canceled) return
    const rangeLabel =
      startDateKey.value === endDateKey.value
        ? startDateKey.value
        : `${startDateKey.value}至${endDateKey.value}`
    const extension = exportFormat.value === 'xlsx' ? 'xlsx' : 'txt'
    exportedFileName.value = result?.fileName || `Abandon报表-${rangeLabel}.${extension}`
    const truncatedNotice = result?.truncatedCount
      ? `\n其中 ${result.truncatedCount} 条超长便签内容已按 Excel 单元格限制截断。`
      : ''
    exportSuccessMessage.value = `便签报表已成功导出：\n${exportedFileName.value}${truncatedNotice}`
    emit('update:visible', false)
    await nextTick()
    exportSuccessVisible.value = true
  } catch (error) {
    showMessage('error', error?.message || '报表导出失败')
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
    startDateKey.value = localDateKey()
    endDateKey.value = localDateKey()
    statuses.value = STATUS_OPTIONS.map((status) => status.value)
    exportFormat.value = 'txt'
  }
)

watch([startDateKey, endDateKey, statuses], () => {
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
    title="便签报表"
    subtitle="选择最长 366 天的日期范围、状态和导出格式"
    width="min(700rem, calc(100vw - 32rem))"
    height="min(680rem, calc(100vh - 32rem))"
    :close-disabled="exporting"
    flush
    @update:visible="close"
  >
    <div class="daily-report">
      <section class="daily-report__filters" aria-label="便签报表筛选条件">
        <div class="daily-report__filter-row">
          <span class="daily-report__filter-label">日期范围</span>
          <div class="daily-report__date-range">
            <DatePicker v-model="startDateKey" aria-label="选择报表开始日期" />
            <span class="daily-report__date-separator">至</span>
            <DatePicker v-model="endDateKey" aria-label="选择报表结束日期" />
            <span v-if="rangeValidationMessage" class="daily-report__range-error" role="alert">
              {{ rangeValidationMessage }}
            </span>
          </div>
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
        <div class="daily-report__filter-row">
          <span class="daily-report__filter-label">导出格式</span>
          <div class="daily-report__formats" role="radiogroup" aria-label="报表导出格式">
            <button
              v-for="format in EXPORT_FORMAT_OPTIONS"
              :key="format.value"
              type="button"
              class="daily-report__format"
              :class="{ 'is-selected': exportFormat === format.value }"
              role="radio"
              :aria-checked="exportFormat === format.value"
              @click="exportFormat = format.value"
            >
              {{ format.label }}
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
            正在读取报表内容…
          </div>
          <div v-else-if="loadError" class="daily-report__state is-error">
            <span>{{ loadError }}</span>
            <button type="button" @click="loadPreview">重新加载</button>
          </div>
          <div v-else-if="statuses.length === 0" class="daily-report__state">
            请至少选择一个便签状态
          </div>
          <div v-else-if="rangeValidationMessage" class="daily-report__state is-error">
            {{ rangeValidationMessage }}
          </div>
          <div v-else-if="notes.length === 0" class="daily-report__state">
            所选日期范围内没有符合状态条件的便签
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
                  <span
                    v-if="note.duration_kind === 'until_completed'"
                    class="daily-report-note__duration"
                  >
                    持续到完成 · {{ note.calendar_duration_days }} 天
                  </span>
                  <span v-else-if="note.duration_days > 1" class="daily-report-note__duration">
                    指定 {{ note.duration_days }} 天
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
        :disabled="selectedCount === 0 || loading || exporting || !!rangeValidationMessage"
        @click="exportReport"
      >
        {{ exportButtonLabel }}
      </BaseButton>
    </template>
  </AppModalShell>

  <ConfirmDialog
    v-model:visible="exportSuccessVisible"
    title="导出成功"
    :message="exportSuccessMessage"
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
  grid-template-columns: 72rem minmax(0, 1fr);
  align-items: center;
}
.daily-report__filter-label {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.daily-report__filter-row :deep(.date-picker) {
  width: 100%;
}
.daily-report__date-range {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) 20rem minmax(0, 1fr);
  align-items: center;
  gap: 7rem;
}
.daily-report__date-separator {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  text-align: center;
}
.daily-report__range-error {
  grid-column: 1 / -1;
  color: var(--ui-warning);
  font-size: var(--fs-secondary);
}
.daily-report__statuses {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 7rem;
}
.daily-report__formats {
  display: inline-flex;
  width: fit-content;
  padding: 3rem;
  border-radius: 9rem;
  background: var(--ui-surface-subtle);
}
.daily-report__format {
  min-width: 72rem;
  min-height: 30rem;
  padding: 0 11rem;
  border: 0;
  border-radius: 7rem;
  background: transparent;
  color: var(--text-color-secondary);
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
  transition:
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease,
    transform var(--motion-control) var(--ease-standard);
}
.daily-report__format:hover {
  background: var(--ui-fill-hover);
}
.daily-report__format:active {
  transform: scale(0.98);
}
.daily-report__format.is-selected {
  background: var(--ui-accent-subtle);
  color: var(--ui-accent);
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
  color: var(--ui-status-pending);
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
  color: var(--ui-danger);
}
.daily-report__spinner {
  width: 15rem;
  height: 15rem;
  border: 2px solid color-mix(in srgb, var(--ui-status-pending) 20%, transparent);
  border-top-color: var(--ui-status-pending);
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
  border-color: var(--ui-status-pending);
  background: var(--ui-status-pending);
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
    grid-template-columns: 62rem minmax(0, 1fr);
  }
  .daily-report-note__duration {
    display: none;
  }
}
</style>
