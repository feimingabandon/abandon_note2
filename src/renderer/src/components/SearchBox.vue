<script setup>
/**
 * SearchBox.vue — 全文搜索框
 *
 * 4.4: 基于 FTS5 的全文搜索 UI，含搜索建议、高亮结果展示
 */
import { ref, watch, onUnmounted } from 'vue'

const emit = defineEmits(['select'])

/** 搜索关键词 */
const query = ref('')
/** 搜索结果 */
const results = ref([])
/** 结果总数 */
const total = ref(0)
/** 搜索建议 */
const suggestions = ref([])
/** 加载状态 */
const loading = ref(false)
/** 是否显示结果面板 */
const showResults = ref(false)
/** 防抖定时器 */
let debounceTimer = null
/** 建议防抖定时器 */
let suggestTimer = null

// ============================================================
// 搜索逻辑
// ============================================================

async function doSearch(q) {
  if (!q || !q.trim()) {
    results.value = []
    total.value = 0
    showResults.value = false
    return
  }

  loading.value = true
  try {
    const res = await window.api.searchNotes(q, { limit: 30 })
    results.value = res.results || []
    total.value = res.total || 0
    showResults.value = true
  } catch (_e) {
    console.error('[SearchBox] 搜索失败:', _e)
    results.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

async function fetchSuggestions(prefix) {
  if (!prefix || prefix.length < 2) {
    suggestions.value = []
    return
  }
  try {
    suggestions.value = await window.api.searchSuggestions(prefix, 5)
  } catch {
    suggestions.value = []
  }
}

// ============================================================
// 输入防抖
// ============================================================

watch(query, (val) => {
  // 清除旧定时器
  if (debounceTimer) clearTimeout(debounceTimer)
  if (suggestTimer) clearTimeout(suggestTimer)

  // 搜索建议（延迟 150ms）
  suggestTimer = setTimeout(() => fetchSuggestions(val), 150)
  // 全文搜索（延迟 300ms）
  debounceTimer = setTimeout(() => doSearch(val), 300)
})

// ============================================================
// 交互
// ============================================================

function handleSelect(note) {
  emit('select', note)
  clearSearch()
}

function handleSuggestionClick(suggestion) {
  query.value = suggestion
}

function clearSearch() {
  query.value = ''
  results.value = []
  total.value = 0
  suggestions.value = []
  showResults.value = false
}

function handleFocus() {
  if (results.value.length > 0) {
    showResults.value = true
  }
}

function handleBlur() {
  // 延迟关闭，允许点击结果项
  setTimeout(() => {
    showResults.value = false
  }, 200)
}

onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
  if (suggestTimer) clearTimeout(suggestTimer)
})

// ============================================================
// 工具函数
// ============================================================

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

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return (
    d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  )
}
</script>

<template>
  <div class="sb-root">
    <!-- 搜索输入 -->
    <div class="sb-input-wrap">
      <span class="sb-icon">🔍</span>
      <input
        v-model="query"
        class="sb-input"
        type="text"
        placeholder="搜索便签内容…"
        @focus="handleFocus"
        @blur="handleBlur"
      />
      <button v-if="query" class="sb-clear-btn" @click="clearSearch">✕</button>
      <span v-if="loading" class="sb-spinner">⏳</span>
    </div>

    <!-- 搜索建议 -->
    <div v-if="suggestions.length > 0 && query && !showResults" class="sb-dropdown">
      <div class="sb-dropdown-label">搜索建议</div>
      <div
        v-for="(s, i) in suggestions"
        :key="i"
        class="sb-suggestion-item"
        @mousedown.prevent="handleSuggestionClick(s)"
      >
        {{ s }}
      </div>
    </div>

    <!-- 搜索结果面板 -->
    <div v-if="showResults" class="sb-results-panel scroll-y">
      <div class="sb-results-header">
        <span class="sb-results-count">找到 {{ total }} 条结果</span>
      </div>

      <div v-if="results.length === 0 && !loading" class="sb-empty">无匹配结果</div>

      <div v-else class="sb-results-list">
        <div
          v-for="note in results"
          :key="note.id"
          class="sb-result-card"
          @mousedown.prevent="handleSelect(note)"
        >
          <div class="sb-result-content" v-html="note.highlight || note.content || '（空内容）'" />
          <div class="sb-result-meta">
            <span class="sb-result-status" :class="'sb-status--' + note.status">
              {{ statusLabel(note.status) }}
            </span>
            <span class="sb-result-time">{{ formatTime(note.effective_at) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ===== 根容器 ===== */
.sb-root {
  position: relative;
}

/* ===== 输入框 ===== */
.sb-input-wrap {
  display: flex;
  align-items: center;
  gap: 6rem;
  padding: 6rem 10rem;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8rem;
  transition: border-color 150ms ease;
}
.sb-input-wrap:focus-within {
  border-color: rgba(0, 122, 255, 0.4);
  background: rgba(255, 255, 255, 0.05);
}
.sb-icon {
  font-size: var(--fs-secondary);
  flex-shrink: 0;
}
.sb-input {
  flex: 1;
  border: none;
  background: transparent;
  font-size: var(--fs-secondary);
  font-family: inherit;
  font-weight: 500;
  color: var(--text-color);
  outline: none;
  min-width: 0;
}
.sb-input::placeholder {
  color: var(--text-color-secondary);
}
.sb-clear-btn {
  flex-shrink: 0;
  width: 18rem;
  height: 18rem;
  border: none;
  border-radius: 50%;
  background: rgba(128, 128, 128, 0.15);
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.8);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.sb-clear-btn:hover {
  background: rgba(128, 128, 128, 0.25);
}
.sb-spinner {
  font-size: var(--fs-secondary);
  flex-shrink: 0;
}

/* ===== 下拉建议 ===== */
.sb-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  margin-top: 4rem;
  background: rgb(var(--bg-color) / 0.95);
  backdrop-filter: blur(var(--bg-blur)) saturate(var(--bg-saturation));
  border: 1px solid rgba(128, 128, 128, 0.15);
  border-radius: 8rem;
  overflow: hidden;
  z-index: 100;
  box-shadow: 0 4rem 16rem rgba(0, 0, 0, 0.1);
}
.sb-dropdown-label {
  font-size: calc(var(--fs-secondary) * 0.85);
  color: var(--text-color-secondary);
  padding: 8rem 12rem 4rem;
}
.sb-suggestion-item {
  padding: 8rem 12rem;
  font-size: var(--fs-secondary);
  color: var(--text-color);
  cursor: pointer;
  transition: background-color 100ms ease;
}
.sb-suggestion-item:hover {
  background: rgba(0, 122, 255, 0.08);
}

/* ===== 结果面板 ===== */
.sb-results-panel {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  margin-top: 4rem;
  max-height: 320rem;
  background: rgb(var(--bg-color) / 0.95);
  backdrop-filter: blur(var(--bg-blur)) saturate(var(--bg-saturation));
  border: 1px solid rgba(128, 128, 128, 0.15);
  border-radius: 8rem;
  z-index: 100;
  box-shadow: 0 4rem 16rem rgba(0, 0, 0, 0.1);
}
.sb-results-header {
  display: flex;
  align-items: center;
  padding: 8rem 12rem;
  border-bottom: 1px solid rgba(128, 128, 128, 0.1);
}
.sb-results-count {
  font-size: calc(var(--fs-secondary) * 0.85);
  color: var(--text-color-secondary);
}
.sb-empty {
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
  text-align: center;
  padding: 24rem 0;
}

/* ===== 结果卡片 ===== */
.sb-results-list {
  padding: 4rem 0;
}
.sb-result-card {
  padding: 10rem 12rem;
  cursor: pointer;
  transition: background-color 100ms ease;
}
.sb-result-card:hover {
  background: rgba(0, 122, 255, 0.06);
}
.sb-result-content {
  font-size: var(--fs-secondary);
  color: var(--text-color);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
/* FTS5 snippet 高亮标记 */
.sb-result-content :deep(mark) {
  background: rgba(255, 204, 0, 0.35);
  color: inherit;
  padding: 0 1rem;
  border-radius: 2rem;
}
.sb-result-meta {
  display: flex;
  align-items: center;
  gap: 8rem;
  margin-top: 4rem;
}
.sb-result-status {
  font-size: calc(var(--fs-secondary) * 0.8);
  padding: 2rem 5rem;
  border-radius: 3rem;
  background: rgba(128, 128, 128, 0.1);
}
.sb-status--active {
  background: rgba(0, 122, 255, 0.12);
}
.sb-status--in_progress {
  background: rgba(255, 149, 0, 0.12);
}
.sb-status--completed {
  background: rgba(52, 199, 89, 0.12);
}
.sb-result-time {
  font-size: calc(var(--fs-secondary) * 0.78);
  color: var(--text-color-secondary);
}
</style>
