<script setup>
import { computed, ref, watch } from 'vue'
import AppModalShell from '../ui/AppModalShell.vue'
import RemoteNoticeDialog from './RemoteNoticeDialog.vue'

const PAGE_SIZE = 20
const visible = defineModel('visible', { type: Boolean, default: false })
const loading = ref(false)
const loadingMore = ref(false)
const items = ref([])
const total = ref(0)
const pending = ref(0)
const selected = ref(null)

const hasMore = computed(() => items.value.length < total.value)
const subtitle = computed(() => `全部 ${total.value} 条 · 未确认 ${pending.value} 条`)

async function load({ append = false } = {}) {
  if ((append && (loadingMore.value || !hasMore.value)) || (!append && loading.value)) return
  if (append) loadingMore.value = true
  else loading.value = true
  try {
    const result = await window.api.listRemoteNotices({
      limit: PAGE_SIZE,
      offset: append ? items.value.length : 0
    })
    items.value = append ? [...items.value, ...result.items] : result.items
    total.value = result.total
    pending.value = result.pending
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

function close() {
  selected.value = null
  visible.value = false
}

function onListScroll(event) {
  const element = event.currentTarget
  if (element.scrollTop + element.clientHeight >= element.scrollHeight - 80) {
    void load({ append: true })
  }
}

function onAcknowledged(id) {
  const item = items.value.find((notice) => notice.id === id)
  if (item && !item.acknowledgedAt) {
    item.acknowledgedAt = Date.now()
    pending.value = Math.max(0, pending.value - 1)
  }
  selected.value = null
}

watch(visible, (value) => {
  if (value) {
    selected.value = null
    void load()
  }
})
</script>

<template>
  <AppModalShell
    :visible="visible"
    title="全部通知"
    :subtitle="subtitle"
    width="min(700rem, calc(100vw - 40rem))"
    height="min(640rem, calc(100vh - 40rem))"
    flush
    @update:visible="close"
  >
    <div v-if="loading && !items.length" class="history-empty">正在读取通知…</div>
    <div v-else-if="!items.length" class="history-empty">暂无通知记录</div>
    <ol v-else class="history-list" @scroll.passive="onListScroll">
      <li v-for="notice in items" :key="notice.id">
        <button type="button" @click="selected = notice">
          <span class="history-state" :class="{ pending: !notice.acknowledgedAt }" />
          <strong class="history-title">{{ notice.title }}</strong>
          <span class="history-arrow" aria-hidden="true">›</span>
        </button>
      </li>
      <li v-if="loadingMore" class="history-loading">正在加载更多…</li>
      <li v-else-if="!hasMore && items.length" class="history-end">已经到底了</li>
    </ol>
  </AppModalShell>

  <RemoteNoticeDialog
    v-if="selected"
    :notices="[selected]"
    history-mode
    @close="selected = null"
    @acknowledged="onAcknowledged"
  />
</template>

<style scoped>
.history-list {
  height: 100%;
  padding: 10rem 12rem;
  margin: 0;
  overflow-y: auto;
  list-style: none;
}

.history-list li + li {
  margin-top: 6rem;
}

/* 卡片布局对齐便签列表（NoteCard）：圆角长方形 + 半透明背景，悬停加深 */
.history-list button {
  display: flex;
  align-items: center;
  gap: 12rem;
  width: 100%;
  min-height: 52rem;
  padding: 12rem 14rem;
  border: 1px solid color-mix(in srgb, var(--text-color) 7%, transparent);
  border-radius: 11rem;
  color: var(--text-color);
  background: rgb(var(--bg-color) / 0.08);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background-color 180ms cubic-bezier(0.22, 1, 0.36, 1),
    border-color 180ms cubic-bezier(0.22, 1, 0.36, 1);
}

.history-list button:hover {
  border-color: color-mix(in srgb, var(--text-color) 12%, transparent);
  background: rgb(var(--bg-color) / 0.14);
}

.history-state {
  width: 8rem;
  height: 8rem;
  flex-shrink: 0;
  border-radius: 50%;
  background: color-mix(in srgb, var(--text-color-secondary) 45%, transparent);
}

.history-state.pending {
  background: #0071e3;
  box-shadow: 0 0 0 4rem color-mix(in srgb, #0071e3 12%, transparent);
}

.history-title {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-body);
  font-weight: 620;
}

.history-loading,
.history-end {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}

.history-arrow {
  flex-shrink: 0;
  color: var(--text-color-secondary);
  font-size: 22rem;
}

.history-empty {
  display: grid;
  height: 100%;
  place-items: center;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}

.history-loading,
.history-end {
  padding: 12rem;
  text-align: center;
}
</style>
