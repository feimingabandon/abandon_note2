<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AppModalShell from '../ui/AppModalShell.vue'
import BaseButton from '../ui/BaseButton.vue'
import StyledSelect from '../ui/StyledSelect.vue'

const props = defineProps({
  visible: { type: Boolean, default: false }
})
const emit = defineEmits(['update:visible'])

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
let requestSequence = 0
let searchTimer = null

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

function close() {
  emit('update:visible', false)
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
  clearTimeout(searchTimer)
  appliedSearch.value = searchInput.value.trim()
  query()
}

function clearSearch() {
  searchInput.value = ''
  applySearch()
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
  (visible) => {
    if (visible) {
      requestAnimationFrame(() => searchRef.value?.focus())
      void query()
    }
  }
)

watch([level, processType], () => {
  if (props.visible) query()
})

// 与模板页搜索框一致：输入防抖自动搜索，回车立即搜索
watch(searchInput, () => {
  if (!props.visible) return
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    const next = searchInput.value.trim()
    if (next === appliedSearch.value) return
    appliedSearch.value = next
    query()
  }, 300)
})

onBeforeUnmount(() => {
  clearTimeout(searchTimer)
})
</script>

<template>
  <AppModalShell
    :visible="visible"
    title="应用日志"
    :subtitle="fileSummary"
    width="min(780rem, calc(100vw - 40rem))"
    height="min(680rem, calc(100vh - 40rem))"
    flush
    @update:visible="close"
  >
    <div class="log-content">
      <div class="log-toolbar">
        <StyledSelect v-model="level" :options="levelOptions" size="sm" width="108rem" />
        <StyledSelect v-model="processType" :options="processOptions" size="sm" width="108rem" />
        <div class="log-search">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" />
            <path d="m13 13 4 4" />
          </svg>
          <input
            ref="searchRef"
            v-model="searchInput"
            placeholder="搜索消息、范围或堆栈"
            aria-label="搜索日志"
            @keydown.enter="applySearch"
          />
          <button v-if="searchInput" title="清空搜索" @click="clearSearch">×</button>
        </div>
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
    </div>
  </AppModalShell>
</template>

<style scoped>
.log-content {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  height: 100%;
}

.log-footer,
.log-toolbar {
  display: flex;
  align-items: center;
  gap: 10rem;
  padding: 14rem 16rem;
}

.log-toolbar {
  flex-wrap: wrap;
  border-bottom: 1rem solid var(--surface-float-border);
}

/* 搜索框复用模板页 tp-search 的形态：图标 + 输入框 + 清空按钮 */
.log-search {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1 1 220rem;
  min-width: 0;
  height: 32rem;
  overflow: hidden;
  border: 1rem solid rgb(var(--bg-color) / 0.1);
  border-radius: 8rem;
  background: rgba(255, 255, 255, 0.05);
  transition:
    border-color 160ms ease,
    background-color 160ms ease;
}

.log-search:focus-within {
  border-color: rgb(var(--bg-color) / 0.18);
}

.log-search svg {
  width: 16rem;
  height: 16rem;
  margin-left: 10rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  color: var(--text-color-secondary);
  flex-shrink: 0;
}

.log-search input {
  flex: 1;
  min-width: 0;
  height: 30rem;
  padding: 0 10rem;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  font-size: var(--fs-secondary);
}

.log-search input::placeholder {
  color: var(--text-color-secondary);
  opacity: 0.64;
}

.log-search button {
  display: grid;
  place-items: center;
  width: 24rem;
  height: 24rem;
  margin-right: 4rem;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text-color-secondary);
  font-size: 17rem;
  cursor: pointer;
  transition:
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease,
    transform var(--motion-fast) ease;
}

.log-search button:hover {
  background: color-mix(in srgb, var(--text-color) 8%, transparent);
  color: var(--text-color);
}

.log-search button:active {
  transform: scale(0.94);
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

/* 卡片背景对齐便签卡片（NoteCard）：半透明背景 + 浅描边，悬停时加深 */
.log-record {
  min-width: 0;
  margin-bottom: 6rem;
  border: 1px solid color-mix(in srgb, var(--text-color) 7%, transparent);
  border-left: 3rem solid rgba(142, 142, 147, 0.7);
  border-radius: 11rem;
  background: rgb(var(--bg-color) / 0.08);
  transition:
    background-color 180ms cubic-bezier(0.22, 1, 0.36, 1),
    border-color 180ms cubic-bezier(0.22, 1, 0.36, 1);
}

.log-record:hover {
  border-color: color-mix(in srgb, var(--text-color) 12%, transparent);
  /* border-color 简写会覆盖左侧级别色条，这里保住默认灰；
     warn/error 色条由下方同优先级且靠后的 is-* 规则继续生效 */
  border-left-color: rgba(142, 142, 147, 0.7);
  background: rgb(var(--bg-color) / 0.14);
}

.log-record.is-warn {
  border-left-color: #ff9f0a;
}

.log-record.is-error,
.log-record.is-fatal {
  border-left-color: #ff453a;
}

/* 单行摘要：级别 · 时间 · 来源 · 消息，消息占满剩余宽度并省略号截断 */
.log-record summary {
  display: flex;
  align-items: center;
  gap: 8rem;
  padding: 8rem 10rem;
  cursor: pointer;
  list-style: none;
  font-size: var(--fs-secondary);
  white-space: nowrap;
}

.log-record summary::-webkit-details-marker {
  display: none;
}

.log-level {
  flex-shrink: 0;
  font-weight: 600;
}

.log-record time,
.log-source {
  color: var(--text-color-secondary);
}

.log-record time {
  flex-shrink: 0;
}

.log-source {
  max-width: 180rem;
  flex-shrink: 0;
}

.log-message {
  min-width: 0;
  flex: 1;
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
  .log-detail {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
