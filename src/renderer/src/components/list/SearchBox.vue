<script setup>
/** SearchBox.vue — 独立搜索工作区，不改变首页列表状态。 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import SearchFilterPanel from './SearchFilterPanel.vue'
import SearchResultCard from './SearchResultCard.vue'
import { useNotePresenceMotion } from '../../composables/useNotePresenceMotion.js'

const props = defineProps({
  active: { type: Boolean, default: false },
  queryReady: { type: Boolean, default: false }
})

const emit = defineEmits(['edit', 'request-close'])

const inputRef = ref(null)
const resultsRef = ref(null)
const query = ref('')
const searchedQuery = ref('')
const results = ref([])
const total = ref(0)
const nextOffset = ref(0)
const lastRefreshedAt = ref(null)
const loading = ref(false)
const loadingMore = ref(false)
const loadError = ref('')
const advancedOpen = ref(false)
const statusFilter = ref([])
const tagFilterNames = ref([])
const timePreset = ref('all')
const customFrom = ref('')
const customTo = ref('')
const onlyPinned = ref(false)
const hasAttachments = ref(false)
const includeDeleted = ref(true)
const sortMode = ref('effective')

const PAGE_FIRST = 5
const PAGE_MORE = 5

let requestSeq = 0
let focusTimer = null
let mounted = false
let stopNotesChanged = null

const {
  captureVisibleCardLayout,
  animateRetainedCards,
  cancelCurrentPresenceExits,
  animateCurrentCardsOut,
  disposePresenceMotion
} = useNotePresenceMotion(() => resultsRef.value, {
  cardSelector: '.src-card[data-search-note-id]',
  idAttribute: 'data-search-note-id',
  rootSelector: '.sb-root',
  auxiliarySelector: '.sb-results-head'
})

const hasMore = computed(() => nextOffset.value < total.value)
const lastRefreshLabel = computed(() => formatRefreshTime(lastRefreshedAt.value))
const hasActiveFilters = computed(
  () =>
    statusFilter.value.length > 0 ||
    tagFilterNames.value.length > 0 ||
    timePreset.value !== 'all' ||
    onlyPinned.value ||
    hasAttachments.value ||
    !includeDeleted.value
)

function formatRefreshTime(timestamp) {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':')
}
function focusSearch() {
  nextTick(() => inputRef.value?.focus({ preventScroll: true }))
}

watch(
  () => props.active,
  (active) => {
    if (focusTimer) clearTimeout(focusTimer)
    focusTimer = null
    if (active) {
      focusTimer = setTimeout(focusSearch, 110)
    } else {
      requestSeq++
      loading.value = false
      loadingMore.value = false
      cancelCurrentPresenceExits()
    }
  },
  { immediate: true }
)

watch(
  () => props.queryReady,
  (ready) => {
    if (ready && mounted) runSearch()
  },
  { immediate: true }
)

function toggleArrayValue(source, value) {
  return source.includes(value) ? source.filter((item) => item !== value) : [...source, value]
}

function toggleStatus(value) {
  statusFilter.value = toggleArrayValue(statusFilter.value, value)
  runSearch()
}

function updateTags(values) {
  tagFilterNames.value = [...values]
  runSearch()
}

function resetFilters() {
  statusFilter.value = []
  tagFilterNames.value = []
  timePreset.value = 'all'
  customFrom.value = ''
  customTo.value = ''
  onlyPinned.value = false
  hasAttachments.value = false
  includeDeleted.value = true
  runSearch()
}

function clearQuery() {
  query.value = ''
  searchedQuery.value = ''
  runSearch()
  focusSearch()
}

function submitSearch() {
  searchedQuery.value = query.value.trim()
  runSearch()
}

function selectTime(value) {
  const nextValue = timePreset.value === value ? 'all' : value
  timePreset.value = nextValue
  if (nextValue !== 'custom') {
    customFrom.value = ''
    customTo.value = ''
  }
  runSearch()
}

function toggleOption(option) {
  if (option === 'onlyPinned') onlyPinned.value = !onlyPinned.value
  else if (option === 'hasAttachments') hasAttachments.value = !hasAttachments.value
  else if (option === 'includeDeleted') includeDeleted.value = !includeDeleted.value
  runSearch()
}

function changeSort(value) {
  if (sortMode.value === value) return
  sortMode.value = value
  runSearch()
}

function dateBoundary(value, endOfDay = false) {
  if (!value) return null
  const suffix = endOfDay ? 'T23:59:59.999' : 'T00:00:00.000'
  const timestamp = new Date(`${value}${suffix}`).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}

function selectedTimeRange() {
  if (timePreset.value === 'all') return {}
  if (timePreset.value === 'custom') {
    return { timeFrom: dateBoundary(customFrom.value), timeTo: dateBoundary(customTo.value, true) }
  }
  const current = new Date()
  const todayStart = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate()
  ).getTime()
  const todayEnd = todayStart + 86400000 - 1
  const days = timePreset.value === '3days' ? 3 : 1
  return { timeFrom: todayStart - (days - 1) * 86400000, timeTo: todayEnd }
}

function searchOptions(limit, offset) {
  return {
    search: searchedQuery.value,
    statuses: statusFilter.value.length ? [...statusFilter.value] : null,
    tagNames: tagFilterNames.value.length ? [...tagFilterNames.value] : null,
    ...selectedTimeRange(),
    onlyPinned: onlyPinned.value,
    hasAttachments: hasAttachments.value,
    includeDeleted: includeDeleted.value,
    sort: sortMode.value,
    limit,
    offset
  }
}

async function runSearch({ append = false } = {}) {
  if (append && (loading.value || loadingMore.value || !hasMore.value)) return
  const seq = ++requestSeq
  const before = append ? captureVisibleCardLayout() : null
  loadError.value = ''
  if (append) loadingMore.value = true
  else loading.value = true

  try {
    if (!append) {
      cancelCurrentPresenceExits()
      await animateCurrentCardsOut()
      if (seq !== requestSeq) return
    }

    const response = await window.api.searchNotes(
      searchOptions(append ? PAGE_MORE : PAGE_FIRST, append ? nextOffset.value : 0)
    )
    if (seq !== requestSeq) return
    const incoming = Array.isArray(response?.notes) ? response.notes : []
    if (append) {
      const knownIds = new Set(results.value.map((note) => note.id))
      results.value = [...results.value, ...incoming.filter((note) => !knownIds.has(note.id))]
      nextOffset.value += incoming.length
      await nextTick()
      if (seq === requestSeq) animateRetainedCards(before)
    } else {
      results.value = incoming
      nextOffset.value = incoming.length
      await nextTick()
      if (resultsRef.value) resultsRef.value.scrollTop = 0
      if (seq === requestSeq) animateRetainedCards(new Map())
    }
    total.value = Number(response?.total) || 0
    if (!append) lastRefreshedAt.value = Date.now()
  } catch (error) {
    if (seq !== requestSeq) return
    if (!append) cancelCurrentPresenceExits()
    loadError.value = '搜索失败，请重试'
    console.error('[SearchBox] 搜索失败:', error)
  } finally {
    if (seq === requestSeq) {
      loading.value = false
      loadingMore.value = false
    }
  }
}

function onDateRangeChange({ start, end }) {
  customFrom.value = start
  customTo.value = end
  if (start && end) timePreset.value = 'custom'
  else if (timePreset.value === 'custom') timePreset.value = 'all'
  runSearch()
}

function onInputKeydown(event) {
  if (event.key === 'Enter') {
    event.preventDefault()
    submitSearch()
  } else if ((event.ctrlKey || event.metaKey) && event.key === 'Backspace') {
    event.preventDefault()
    clearQuery()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    if (advancedOpen.value) advancedOpen.value = false
    else if (query.value) clearQuery()
    else emit('request-close')
  }
}

function onResultsScroll(event) {
  const element = event.currentTarget
  if (element.scrollHeight - element.scrollTop - element.clientHeight < 90)
    runSearch({ append: true })
}

function onResultsWheel(event) {
  if (event.deltaY <= 0 || !hasMore.value || loading.value || loadingMore.value) return
  const element = event.currentTarget
  if (element.scrollHeight <= element.clientHeight + 1) runSearch({ append: true })
}

function openAdvanced() {
  advancedOpen.value = !advancedOpen.value
}

onMounted(() => {
  mounted = true
  stopNotesChanged = window.api.onNotesChanged?.(() => {
    if (props.queryReady) runSearch()
  })
  if (props.queryReady) runSearch()
  if (props.active) focusSearch()
})

onBeforeUnmount(() => {
  mounted = false
  if (focusTimer) clearTimeout(focusTimer)
  stopNotesChanged?.()
  disposePresenceMotion()
  requestSeq++
})

defineExpose({
  focus: focusSearch,
  refresh: () => {
    if (props.queryReady) runSearch()
  }
})
</script>

<template>
  <section class="sb-root" aria-label="搜索便签">
    <div class="sb-top-row">
      <div class="sb-search-field">
        <input
          ref="inputRef"
          v-model="query"
          class="sb-input"
          type="search"
          autocomplete="off"
          spellcheck="false"
          placeholder="搜索便签内容……"
          aria-label="搜索便签内容"
          @keydown="onInputKeydown"
        />
        <button
          v-if="query"
          type="button"
          class="sb-clear"
          aria-label="清除搜索内容并显示全部便签"
          @click="clearQuery"
        >
          ×
        </button>
        <button
          type="button"
          class="sb-submit"
          aria-label="执行搜索"
          :disabled="loading"
          @click="submitSearch"
        >
          <span v-if="loading" class="sb-submit-spinner" />
          <svg v-else viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="M15.5 15.5L21 21" />
          </svg>
        </button>
      </div>
      <button
        type="button"
        class="sb-filter-button"
        :class="{ 'is-open': advancedOpen, 'is-active': hasActiveFilters }"
        :aria-expanded="advancedOpen"
        @click="openAdvanced"
      >
        高级筛选
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
      </button>
    </div>

    <SearchFilterPanel
      :open="advancedOpen"
      :statuses="statusFilter"
      :tag-names="tagFilterNames"
      :time-preset="timePreset"
      :custom-from="customFrom"
      :custom-to="customTo"
      :only-pinned="onlyPinned"
      :has-attachments="hasAttachments"
      :include-deleted="includeDeleted"
      @toggle-status="toggleStatus"
      @update-tags="updateTags"
      @select-time="selectTime"
      @change-date-range="onDateRangeChange"
      @toggle-option="toggleOption"
      @reset="resetFilters"
    />

    <div class="sb-results-head">
      <span v-if="loadError">搜索遇到问题</span>
      <span v-else class="sb-result-summary">
        <span>当前{{ results.length }}条</span>
        <span>此条件共{{ total }}条</span>
        <span v-if="lastRefreshLabel" class="sb-refresh-time"> 刷新 {{ lastRefreshLabel }} </span>
      </span>
      <div class="sb-sort" aria-label="搜索结果排序">
        <button
          type="button"
          :class="{ 'is-active': sortMode === 'effective' }"
          @click="changeSort('effective')"
        >
          生效时间
        </button>
        <span>/</span>
        <button
          type="button"
          :class="{ 'is-active': sortMode === 'updated' }"
          @click="changeSort('updated')"
        >
          最近修改
        </button>
      </div>
    </div>

    <div
      ref="resultsRef"
      class="sb-results scroll-y"
      @scroll="onResultsScroll"
      @wheel.passive="onResultsWheel"
    >
      <div v-if="loadError" class="sb-state">
        <strong>{{ loadError }}</strong
        ><span>关键词和筛选条件已保留</span>
        <button type="button" class="sb-state-action" @click="runSearch()">重试</button>
      </div>
      <div v-else-if="!loading && results.length === 0" class="sb-state">
        <strong>{{
          searchedQuery ? `没有找到包含“${searchedQuery}”的便签` : '没有符合当前条件的便签'
        }}</strong>
        <span v-if="hasActiveFilters">可以尝试重置筛选条件</span>
        <button v-if="hasActiveFilters" type="button" class="sb-state-action" @click="resetFilters">
          重置筛选
        </button>
      </div>
      <div v-else class="sb-result-list">
        <SearchResultCard
          v-for="note in results"
          :key="note.id"
          :note="note"
          :query="searchedQuery"
          @edit="emit('edit', $event)"
        />
      </div>
      <div v-if="loadingMore" class="sb-more-state">正在加载更多……</div>
      <div v-else-if="results.length && !hasMore" class="sb-more-state">已显示全部结果</div>
    </div>
  </section>
</template>

<style scoped>
.sb-root {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  padding: 0 14rem 12rem;
  overflow: hidden;
}
.sb-top-row {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 9rem;
  min-height: 45rem;
  padding: 4rem 2rem 5rem;
}
.sb-search-field {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  height: 34rem;
  overflow: hidden;
  border: 1rem solid rgb(var(--bg-color) / 0.1);
  border-radius: 8rem;
  background: rgba(255, 255, 255, 0.05);
  transition:
    border-color 160ms ease,
    background-color 160ms ease;
}
.sb-search-field:focus-within {
  border-color: rgb(var(--bg-color) / 0.18);
}
.sb-input {
  flex: 1;
  min-width: 0;
  height: 32rem;
  padding: 0 10rem;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  user-select: text;
}
.sb-input::placeholder {
  color: var(--text-color-secondary);
  opacity: 0.64;
}
.sb-input::-webkit-search-cancel-button {
  display: none;
}
.sb-clear,
.sb-submit {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 30rem;
  height: 30rem;
  padding: 0;
  border: 0;
  border-radius: 8rem;
  background: transparent;
  color: var(--text-color-secondary);
  font: inherit;
  cursor: pointer;
  transition:
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease,
    transform var(--motion-fast) ease;
}
.sb-clear {
  width: 25rem;
  height: 25rem;
  border-radius: 50%;
  font-size: 19rem;
  line-height: 1;
}
.sb-clear:hover,
.sb-submit:hover {
  background: color-mix(in srgb, var(--text-color) 8%, transparent);
  color: var(--text-color);
}
.sb-clear:active,
.sb-submit:active {
  transform: scale(0.94);
}
.sb-submit:disabled {
  opacity: 0.62;
  cursor: default;
}
.sb-submit svg {
  width: 16rem;
  height: 16rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.sb-submit-spinner {
  width: 13rem;
  height: 13rem;
  border: 1.6rem solid color-mix(in srgb, currentColor 22%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: sb-submit-spin 620ms linear infinite;
}
.sb-filter-button {
  display: inline-flex;
  align-items: center;
  gap: 3rem;
  flex-shrink: 0;
  min-height: 30rem;
  padding: 0 7rem;
  border: 1rem solid rgb(var(--bg-color) / 0.1);
  border-radius: 8rem;
  background: rgba(255, 255, 255, 0.05);
  color: #000;
  opacity: 0.45;
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
  transition:
    border-color var(--motion-fast) ease,
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease,
    opacity var(--motion-fast) ease,
    transform var(--motion-fast) ease;
}
.sb-filter-button:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #000;
  opacity: 0.7;
}
.sb-filter-button.is-open {
  border-color: rgb(var(--bg-color) / 0.18);
  background: rgba(255, 255, 255, 0.05);
  color: #000;
}
.sb-filter-button.is-active {
  color: #000;
  opacity: 1;
}
.sb-filter-button:active {
  transform: scale(0.97);
}
.sb-filter-button svg {
  width: 13rem;
  height: 13rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.sb-filter-button svg {
  transition: transform 220ms var(--ease-standard);
}
.sb-filter-button.is-open svg {
  transform: rotate(180deg);
}
.sb-results-head {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  min-height: 30rem;
  padding: 4rem 3rem 6rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.sb-result-summary {
  display: inline-flex;
  align-items: baseline;
  gap: 7rem;
  min-width: 0;
  white-space: nowrap;
}
.sb-refresh-time {
  font-size: calc(var(--fs-secondary) * 0.82);
  opacity: 0.58;
}
.sb-sort {
  display: flex;
  gap: 5rem;
  margin-left: auto;
}
.sb-sort button {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-color-secondary);
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
}
.sb-sort button:hover,
.sb-sort button.is-active {
  color: var(--text-color);
}
.sb-results {
  position: relative;
  flex: 1;
  min-height: 0;
  padding: 1rem 2rem 24rem;
  -webkit-mask-image: linear-gradient(
    to bottom,
    black 0%,
    black calc(100% - 22rem),
    transparent 100%
  );
  mask-image: linear-gradient(to bottom, black 0%, black calc(100% - 22rem), transparent 100%);
}
.sb-result-list {
  display: flex;
  flex-direction: column;
  gap: 7rem;
}
.sb-state {
  display: flex;
  min-height: 142rem;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 7rem;
  padding: 20rem;
  color: var(--text-color-secondary);
  text-align: center;
}
.sb-state strong {
  color: color-mix(in srgb, var(--text-color) 78%, transparent);
  font-size: var(--fs-body);
  font-weight: 500;
}
.sb-state span {
  font-size: var(--fs-secondary);
}
.sb-state-action {
  padding: 3rem 6rem;
  border: 0;
  background: transparent;
  color: color-mix(in srgb, #0a84ff 80%, var(--text-color));
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
}
.sb-more-state {
  padding: 13rem 0 5rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  text-align: center;
  opacity: 0.7;
}
@keyframes sb-submit-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
