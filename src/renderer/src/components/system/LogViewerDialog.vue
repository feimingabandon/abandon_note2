<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import BaseButton from '../ui/BaseButton.vue'
import { releaseModalBlur, retainModalBlur } from '../../utils/modalBlur.js'

const props = defineProps({
  visible: { type: Boolean, default: false }
})
const emit = defineEmits(['update:visible'])

const rendered = ref(props.visible)
const active = ref(false)
const loading = ref(false)
const exporting = ref(false)
const errorMessage = ref('')
const records = ref([])
const nextCursor = ref(null)
const hasMore = ref(false)
const files = ref([])
const level = ref('all')
const processType = ref('all')
const searchInput = ref('')
const appliedSearch = ref('')
const searchRef = ref(null)
let ownsModalBlur = false
let closeTimer = null
let requestSequence = 0

const levelOptions = [
  { value: 'all', label: '全部级别' },
  { value: 'warn', label: '警告' },
  { value: 'error', label: '错误' },
  { value: 'fatal', label: '严重' },
  { value: 'info', label: '信息' },
  { value: 'debug', label: '调试' }
]
const processOptions = [
  { value: 'all', label: '全部来源' },
  { value: 'main', label: '主进程' },
  { value: 'renderer', label: '页面' },
  { value: 'child', label: '子进程' }
]

const fileSummary = computed(() => {
  const totalBytes = files.value.reduce((sum, file) => sum + Number(file.size || 0), 0)
  if (!files.value.length) return '暂无日志文件'
  return `${files.value.length} 个文件 · ${formatBytes(totalBytes)}`
})

function acquireBlur() {
  if (ownsModalBlur) return
  ownsModalBlur = true
  retainModalBlur()
}

function freeBlur() {
  if (!ownsModalBlur) return
  ownsModalBlur = false
  releaseModalBlur()
}

function close() {
  if (closeTimer) return
  active.value = false
  window.removeEventListener('keydown', onKeydown)
  freeBlur()
  closeTimer = setTimeout(() => {
    closeTimer = null
    rendered.value = false
    emit('update:visible', false)
  }, 220)
}

function onKeydown(event) {
  if (event.key === 'Escape') close()
}

async function query({ append = false } = {}) {
  const sequence = ++requestSequence
  loading.value = true
  errorMessage.value = ''
  try {
    const result = await window.api.queryLogs({
      levels: level.value === 'all' ? [] : [level.value],
      processes: processType.value === 'all' ? [] : [processType.value],
      search: appliedSearch.value,
      cursor: append ? nextCursor.value : 0,
      limit: 200
    })
    if (sequence !== requestSequence) return
    records.value = append ? [...records.value, ...result.items] : result.items
    nextCursor.value = result.nextCursor
    hasMore.value = result.hasMore
    files.value = result.files || []
  } catch (error) {
    if (sequence !== requestSequence) return
    errorMessage.value = error?.message || '读取日志失败'
  } finally {
    if (sequence === requestSequence) loading.value = false
  }
}

function applySearch() {
  appliedSearch.value = searchInput.value.trim()
  query()
}

async function openFolder() {
  errorMessage.value = ''
  try {
    await window.api.openLogsFolder()
  } catch (error) {
    errorMessage.value = error?.message || '无法打开日志目录'
  }
}

async function exportLogs() {
  exporting.value = true
  errorMessage.value = ''
  try {
    await window.api.exportLogs()
  } catch (error) {
    errorMessage.value = error?.message || '导出日志失败'
  } finally {
    exporting.value = false
  }
}

async function copyRecord(record) {
  try {
    await navigator.clipboard.writeText(JSON.stringify(record, null, 2))
  } catch (error) {
    errorMessage.value = error?.message || '复制日志失败'
  }
}

function formatTime(value) {
  if (!value) return '——'
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hour12: false
  })
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function levelLabel(value) {
  return (
    {
      debug: '调试',
      info: '信息',
      warn: '警告',
      error: '错误',
      fatal: '严重'
    }[value] || value
  )
}

function recordDetail(record) {
  const detail = {}
  if (record.error) detail.error = record.error
  if (record.metadata) detail.metadata = record.metadata
  detail.sessionId = record.sessionId
  detail.pid = record.pid
  detail.appVersion = record.appVersion
  detail.platform = record.platform
  detail.arch = record.arch
  detail.versions = record.versions
  return JSON.stringify(detail, null, 2)
}

watch(
  () => props.visible,
  async (visible) => {
    if (visible) {
      if (closeTimer) {
        clearTimeout(closeTimer)
        closeTimer = null
      }
      acquireBlur()
      rendered.value = true
      window.addEventListener('keydown', onKeydown)
      await nextTick()
      requestAnimationFrame(() => {
        active.value = true
        searchRef.value?.focus()
      })
      await query()
    } else if (rendered.value) {
      close()
    }
  }
)

watch([level, processType], () => {
  if (rendered.value) query()
})

onBeforeUnmount(() => {
  if (closeTimer) clearTimeout(closeTimer)
  window.removeEventListener('keydown', onKeydown)
  freeBlur()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="rendered"
      class="log-overlay"
      :class="{ active }"
      data-keep-settings-open
      @click.self="close"
    >
      <section class="log-dialog" :class="{ active }" role="dialog" aria-modal="true">
        <header class="log-header">
          <div>
            <h2>应用日志</h2>
            <p>{{ fileSummary }}</p>
          </div>
          <button class="log-close" type="button" aria-label="关闭日志" @click="close">×</button>
        </header>

        <div class="log-toolbar">
          <select v-model="level" aria-label="日志级别">
            <option v-for="option in levelOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
          <select v-model="processType" aria-label="日志来源">
            <option v-for="option in processOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
          <form class="log-search" @submit.prevent="applySearch">
            <input
              ref="searchRef"
              v-model="searchInput"
              type="search"
              placeholder="搜索消息、范围或堆栈"
            />
            <BaseButton size="sm">搜索</BaseButton>
          </form>
        </div>

        <div class="log-list" aria-live="polite">
          <p v-if="errorMessage" class="log-error">{{ errorMessage }}</p>
          <div v-if="loading && !records.length" class="log-empty">正在读取日志…</div>
          <div v-else-if="!records.length" class="log-empty">当前条件下没有日志</div>
          <details
            v-for="record in records"
            :key="record.id"
            class="log-record"
            :class="`is-${record.level}`"
          >
            <summary>
              <span class="log-level">{{ levelLabel(record.level) }}</span>
              <time>{{ formatTime(record.time) }}</time>
              <span class="log-source">
                {{ record.windowRole || record.process }} · {{ record.scope }}
              </span>
              <span class="log-message">{{ record.message || '无消息' }}</span>
            </summary>
            <div class="log-detail">
              <pre>{{ recordDetail(record) }}</pre>
              <BaseButton size="sm" @click="copyRecord(record)">复制此条</BaseButton>
            </div>
          </details>
          <BaseButton
            v-if="hasMore"
            class="load-more"
            size="sm"
            :disabled="loading"
            @click="query({ append: true })"
          >
            {{ loading ? '正在加载…' : '加载更早日志' }}
          </BaseButton>
        </div>

        <footer class="log-footer">
          <div class="log-footer-left">
            <BaseButton size="sm" :disabled="loading" @click="query()">刷新</BaseButton>
            <BaseButton size="sm" @click="openFolder">打开文件夹</BaseButton>
          </div>
          <BaseButton size="sm" :disabled="exporting" @click="exportLogs">
            {{ exporting ? '正在导出…' : '导出完整日志' }}
          </BaseButton>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.log-overlay {
  position: fixed;
  inset: 0;
  z-index: 41000;
  display: grid;
  place-items: center;
  padding: 24rem;
  border-radius: var(--window-radius);
  overflow: hidden;
  background: rgba(12, 14, 18, 0);
  pointer-events: none;
  transition: background-color 200ms ease;
}

.log-overlay.active {
  background: rgba(12, 14, 18, 0.2);
  pointer-events: auto;
}

.log-dialog {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  width: min(760rem, calc(100vw - 48rem));
  height: min(680rem, calc(100vh - 48rem));
  border: 1rem solid var(--surface-float-border);
  border-radius: 16rem;
  overflow: hidden;
  color: var(--text-color);
  background: var(--surface-float);
  box-shadow: 0 18px 70px rgba(0, 0, 0, 0.44);
  opacity: 0;
  transform: translateY(8rem);
  transition:
    opacity var(--motion-control) ease,
    transform 240ms var(--ease-standard);
}

.log-dialog.active {
  opacity: 1;
  transform: translateY(0);
}

.log-header,
.log-footer,
.log-toolbar {
  display: flex;
  align-items: center;
  gap: 10rem;
  padding: 14rem 16rem;
}

.log-header {
  justify-content: space-between;
  border-bottom: 1rem solid var(--surface-float-border);
}

.log-header h2 {
  margin: 0;
  font-size: var(--fs-title);
}

.log-header p {
  margin: 3rem 0 0;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}

.log-close {
  width: 30rem;
  height: 30rem;
  border: 0;
  border-radius: 50%;
  color: var(--text-color);
  background: color-mix(in srgb, var(--text-color) 8%, transparent);
  font: inherit;
  font-size: 22rem;
  line-height: 1;
  cursor: pointer;
}

.log-toolbar {
  flex-wrap: wrap;
  border-bottom: 1rem solid var(--surface-float-border);
}

.log-toolbar select,
.log-toolbar input {
  min-height: 32rem;
  border: 1rem solid var(--surface-float-border);
  border-radius: 8rem;
  padding: 6rem 9rem;
  color: var(--text-color);
  background: color-mix(in srgb, var(--surface-float) 92%, var(--text-color) 8%);
  font: inherit;
  font-size: var(--fs-secondary);
  outline: none;
}

.log-search {
  display: flex;
  flex: 1 1 260rem;
  gap: 8rem;
}

.log-search input {
  min-width: 0;
  flex: 1;
}

.log-error {
  margin: 0 4rem 10rem;
  padding: 8rem 10rem;
  border-radius: 8rem;
  color: #ff6961;
  background: rgba(255, 59, 48, 0.1);
  font-size: var(--fs-secondary);
}

.log-list {
  min-width: 0;
  min-height: 0;
  padding: 10rem 12rem;
  overflow-x: hidden;
  overflow-y: auto;
}

.log-empty {
  display: grid;
  min-height: 180rem;
  place-items: center;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}

.log-record {
  min-width: 0;
  margin-bottom: 6rem;
  border: 1rem solid var(--surface-float-border);
  border-left: 3rem solid rgba(142, 142, 147, 0.7);
  border-radius: 9rem;
  background: color-mix(in srgb, var(--surface-float) 96%, var(--text-color) 4%);
}

.log-record.is-warn {
  border-left-color: #ff9f0a;
}

.log-record.is-error,
.log-record.is-fatal {
  border-left-color: #ff453a;
}

.log-record summary {
  display: grid;
  grid-template-columns: 48rem 108rem minmax(120rem, 0.8fr) minmax(160rem, 1.5fr);
  align-items: center;
  gap: 8rem;
  padding: 9rem 10rem;
  cursor: pointer;
  list-style: none;
  font-size: var(--fs-secondary);
}

.log-record summary::-webkit-details-marker {
  display: none;
}

.log-level {
  font-weight: 600;
}

.log-record time,
.log-source {
  color: var(--text-color-secondary);
}

.log-source,
.log-message {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-detail {
  display: flex;
  align-items: flex-end;
  gap: 10rem;
  padding: 0 10rem 10rem;
}

.log-detail pre {
  min-width: 0;
  max-height: 300rem;
  flex: 1;
  margin: 0;
  padding: 10rem;
  border-radius: 7rem;
  overflow: auto;
  color: var(--text-color);
  background: rgba(0, 0, 0, 0.14);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11rem;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}

.load-more {
  display: flex;
  margin: 10rem auto 2rem;
}

.log-footer {
  justify-content: space-between;
  border-top: 1rem solid var(--surface-float-border);
}

.log-footer-left {
  display: flex;
  gap: 8rem;
}

@media (max-width: 620px) {
  .log-record summary {
    grid-template-columns: 46rem 1fr;
  }
  .log-source,
  .log-message {
    grid-column: 1 / -1;
  }
  .log-detail {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
