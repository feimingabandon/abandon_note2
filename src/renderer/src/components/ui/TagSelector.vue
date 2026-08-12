<script setup>
/** 轻量标签选择器：外层优先展示当前选中标签，其余遵循全局手动顺序。 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { enterPopover, leavePopover } from '../../utils/popoverMotion.js'
import TagManagerDialog from './TagManagerDialog.vue'
import TagSelectorRow from './TagSelectorRow.vue'

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  /** 0 表示不限；便签和模板场景传入 1，筛选场景允许多选。 */
  maxSelected: { type: Number, default: 0 }
})
const emit = defineEmits(['update:modelValue', 'refresh', 'selectionLimitExceeded'])

const tags = ref([])
const selectedIds = ref(new Set(props.modelValue.map(Number)))
const quickAreaRef = ref(null)
const measureRef = ref(null)
const visibleCount = ref(0)
const panelOpen = ref(false)
const panelButtonRef = ref(null)
const panelPosition = ref({ top: 0, left: 0, width: 320 })
const panelQuery = ref('')
const panelInputRef = ref(null)
const managerVisible = ref(false)
const refreshSpinning = ref(false)
let unsubscribeTagsChanged = null
let resizeObserver = null
let loadSequence = 0

const tagById = computed(() => new Map(tags.value.map((tag) => [Number(tag.id), tag])))
const selectedTags = computed(() =>
  [...selectedIds.value].map((id) => tagById.value.get(Number(id))).filter(Boolean)
)
const remainingTags = computed(() =>
  tags.value.filter((tag) => !selectedIds.value.has(Number(tag.id)))
)
const quickCandidates = computed(() => [...selectedTags.value, ...remainingTags.value])
const visibleTags = computed(() => quickCandidates.value.slice(0, visibleCount.value))
const normalizedQuery = computed(() => panelQuery.value.trim().toLocaleLowerCase())
const matchesQuery = (tag) =>
  !normalizedQuery.value || tag.name.toLocaleLowerCase().includes(normalizedQuery.value)
const panelTags = computed(() => tags.value.filter(matchesQuery))
const selectedSummary = computed(() => {
  const names = selectedTags.value.map((tag) => tag.name)
  if (names.length === 0) return '未选择'
  return `已选：${names.join('、')}`
})

watch(
  () => props.modelValue,
  (value) => {
    selectedIds.value = new Set((value || []).map(Number))
    scheduleMeasure()
  }
)
watch(quickCandidates, scheduleMeasure, { flush: 'post' })

async function loadTags() {
  const sequence = ++loadSequence
  try {
    const result = await window.api.listTags()
    if (sequence !== loadSequence) return
    tags.value = result
    scheduleMeasure()
  } catch (error) {
    console.error('[TagSelector] 加载标签失败:', error)
  }
}

function scheduleMeasure() {
  nextTick(measureQuickTags)
}

function measureQuickTags() {
  const available = quickAreaRef.value?.clientWidth || 0
  const chips = [...(measureRef.value?.children || [])]
  if (!available || chips.length === 0) {
    visibleCount.value = 0
    return
  }
  const gap = 7
  let used = 0
  let count = 0
  for (const chip of chips) {
    const nextWidth = chip.getBoundingClientRect().width + (count > 0 ? gap : 0)
    if (used + nextWidth > available) break
    used += nextWidth
    count += 1
  }
  // 极窄窗口仍保证当前选中标签能够出现；其名称会在芯片内部省略。
  visibleCount.value = Math.max(selectedTags.value.length > 0 ? 1 : 0, count)
}

function toggleTag(tagId) {
  const id = Number(tagId)
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else {
    // 单选场景采用原生单选语义：选择新标签时自然替换旧标签，而不是提示超限。
    if (props.maxSelected === 1) {
      next.clear()
      next.add(id)
    } else if (props.maxSelected > 0 && next.size >= props.maxSelected) {
      emit('selectionLimitExceeded', props.maxSelected)
      return
    } else {
      next.add(id)
    }
  }
  selectedIds.value = next
  emit('update:modelValue', [...next])
  scheduleMeasure()
}

function restartRefreshSpin() {
  refreshSpinning.value = false
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      refreshSpinning.value = true
    })
  })
}

async function onRefresh() {
  restartRefreshSpin()
  emit('refresh')
  await loadTags()
}

function updatePanelPosition() {
  const rect = panelButtonRef.value?.getBoundingClientRect()
  if (!rect) return
  const width = Math.min(360, Math.max(286, window.innerWidth - 16))
  panelPosition.value = {
    top: rect.bottom + 6,
    left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
    width
  }
}

async function openPanel() {
  updatePanelPosition()
  panelOpen.value = true
  await nextTick()
  panelInputRef.value?.focus()
}

function closePanel() {
  panelOpen.value = false
  panelQuery.value = ''
}

function togglePanel() {
  if (panelOpen.value) closePanel()
  else openPanel()
}

function onDocumentPointerDown(event) {
  if (!panelOpen.value) return
  if (event.target.closest('.ts-more, .ts-panel')) return
  closePanel()
}

function onDocumentKeydown(event) {
  if (event.key === 'Escape' && panelOpen.value) closePanel()
}

async function openManager() {
  closePanel()
  await nextTick()
  panelButtonRef.value?.focus()
  managerVisible.value = true
}

onMounted(async () => {
  resizeObserver = new ResizeObserver(scheduleMeasure)
  if (quickAreaRef.value) resizeObserver.observe(quickAreaRef.value)
  unsubscribeTagsChanged = window.api.onTagsChanged?.(async (change) => {
    if (change?.reason === 'delete' && selectedIds.value.has(Number(change.id))) {
      const next = new Set(selectedIds.value)
      next.delete(Number(change.id))
      selectedIds.value = next
      emit('update:modelValue', [...next])
    }
    await loadTags()
  })
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onDocumentKeydown)
  window.addEventListener('resize', updatePanelPosition)
  window.addEventListener('scroll', closePanel, true)
  await loadTags()
})

onBeforeUnmount(() => {
  loadSequence++
  unsubscribeTagsChanged?.()
  resizeObserver?.disconnect()
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onDocumentKeydown)
  window.removeEventListener('resize', updatePanelPosition)
  window.removeEventListener('scroll', closePanel, true)
})
</script>

<template>
  <div class="ts-root">
    <div class="ts-row">
      <div ref="quickAreaRef" class="ts-quick" aria-label="快捷标签">
        <button
          v-for="tag in visibleTags"
          :key="tag.id"
          type="button"
          class="ts-chip"
          :class="{ selected: selectedIds.has(Number(tag.id)) }"
          :style="{
            '--chip-color': tag.color || 'color-mix(in srgb, var(--text-color) 45%, transparent)'
          }"
          :title="tag.name"
          @click="toggleTag(tag.id)"
        >
          <span class="ts-dot" />
          <span>{{ tag.name }}</span>
        </button>
        <span v-if="tags.length === 0" class="ts-empty">暂无标签</span>
        <div ref="measureRef" class="ts-measure" aria-hidden="true">
          <span
            v-for="tag in quickCandidates"
            :key="tag.id"
            class="ts-chip"
            :style="{
              '--chip-color': tag.color || 'color-mix(in srgb, var(--text-color) 45%, transparent)'
            }"
          >
            <span class="ts-dot" />
            <span>{{ tag.name }}</span>
          </span>
        </div>
      </div>

      <div class="ts-actions">
        <button type="button" class="ts-refresh" title="刷新标签" @click="onRefresh">
          <svg :class="{ spinning: refreshSpinning }" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5" />
          </svg>
        </button>
        <button
          ref="panelButtonRef"
          type="button"
          class="ts-more"
          :class="{ active: panelOpen }"
          aria-haspopup="listbox"
          :aria-expanded="panelOpen"
          @click="togglePanel"
        >
          更多 {{ tags.length }}
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
        </button>
      </div>
    </div>

    <Teleport to="body">
      <Transition
        :css="false"
        @enter="(element, done) => enterPopover(element, done, 'dropdown')"
        @leave="(element, done) => leavePopover(element, done, 'dropdown')"
      >
        <section
          v-if="panelOpen"
          class="ts-panel"
          :style="{
            top: `${panelPosition.top}px`,
            left: `${panelPosition.left}px`,
            width: `${panelPosition.width}px`
          }"
          aria-label="全部标签"
        >
          <div class="ts-search">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m16.5 16.5 4 4" />
            </svg>
            <input ref="panelInputRef" v-model="panelQuery" type="search" placeholder="搜索标签…" />
          </div>
          <div class="ts-panel-list scroll-y">
            <div class="ts-list-heading">
              <strong>全部标签</strong>
              <span :title="selectedSummary">{{ selectedSummary }}</span>
            </div>
            <TagSelectorRow
              v-for="tag in panelTags"
              :key="tag.id"
              :tag="tag"
              :selected="selectedIds.has(Number(tag.id))"
              @toggle="toggleTag"
            />
            <p v-if="panelTags.length === 0" class="ts-panel-empty">没有匹配的标签</p>
          </div>
          <button type="button" class="ts-manage" @click="openManager">管理标签</button>
        </section>
      </Transition>
    </Teleport>

    <TagManagerDialog v-model:visible="managerVisible" />
  </div>
</template>

<style scoped>
.ts-root {
  min-width: 0;
}
.ts-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6rem;
}
.ts-quick {
  position: relative;
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 7rem;
  overflow: hidden;
}
.ts-chip {
  display: inline-flex;
  min-width: 0;
  max-width: 92rem;
  flex: 0 0 auto;
  align-items: center;
  gap: 5rem;
  padding: 5rem 9rem;
  overflow: hidden;
  border: 0;
  border-radius: 13rem;
  background: var(--ui-fill-passive);
  color: var(--text-color);
  font: inherit;
  font-size: calc(var(--fs-secondary) * 0.84);
  white-space: nowrap;
  cursor: pointer;
}
.ts-chip:hover {
  background: var(--ui-fill-hover);
}
.ts-chip:active {
  transform: scale(0.98);
}
.ts-chip.selected {
  background: color-mix(in srgb, var(--chip-color) 17%, transparent);
}
.ts-chip > span:last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ts-dot {
  width: 7rem;
  height: 7rem;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--chip-color);
}
.ts-measure {
  position: absolute;
  top: -10000px;
  left: 0;
  display: flex;
  gap: 7rem;
  visibility: hidden;
  pointer-events: none;
}
.ts-empty {
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.85);
}
.ts-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2rem;
}
.ts-refresh,
.ts-more {
  display: inline-flex;
  height: 32rem;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6rem;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  font-size: calc(var(--fs-secondary) * 0.82);
  cursor: pointer;
}
.ts-refresh {
  width: 30rem;
  padding: 0;
}
.ts-refresh:hover,
.ts-more:hover,
.ts-more.active {
  background: var(--ui-fill-hover);
}
.ts-refresh:active {
  transform: scale(0.98);
}
.ts-refresh svg {
  width: 17rem;
  height: 17rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
}
.ts-refresh svg.spinning {
  animation: ts-refresh-spin 320ms var(--ease-standard);
}
.ts-more {
  gap: 3rem;
  min-width: 62rem;
  padding: 0 7rem;
}
.ts-more svg {
  width: 10rem;
  height: 10rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.5;
  transition: transform var(--motion-control) var(--ease-standard);
}
.ts-more.active svg {
  transform: rotate(180deg);
}
@keyframes ts-refresh-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

<style>
.ts-panel {
  position: fixed;
  z-index: var(--z-global-popover);
  display: flex;
  max-height: min(480rem, calc(100vh - 24rem));
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--surface-float-border);
  border-radius: 10rem;
  background: var(--surface-float);
  box-shadow: 0 10rem 30rem rgba(0, 0, 0, 0.24);
  color: var(--text-color);
  transform-origin: top right;
}
.ts-search {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 7rem;
  margin: 9rem;
  padding: 6rem 9rem;
  border: 1px solid var(--ui-border-control);
  border-radius: 7rem;
  background: var(--ui-surface-control);
}
.ts-search:focus-within {
  border-color: #007aff;
}
.ts-search svg {
  width: 15rem;
  height: 15rem;
  flex: 0 0 auto;
  fill: none;
  stroke: var(--text-color-secondary);
  stroke-linecap: round;
  stroke-width: 1.7;
}
.ts-search input {
  min-width: 0;
  flex: 1;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  font-size: var(--fs-secondary);
}
.ts-panel-list {
  min-height: 80rem;
  flex: 1;
  padding: 0 6rem 6rem;
}
.ts-list-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12rem;
  margin: 5rem 8rem 6rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.78);
}
.ts-list-heading strong {
  flex: 0 0 auto;
  color: var(--text-color-secondary);
  font-weight: 600;
}
.ts-list-heading span {
  min-width: 0;
  overflow: hidden;
  color: #007aff;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ts-panel-row {
  display: flex;
  min-height: 34rem;
  align-items: center;
  border-radius: 6rem;
}
.ts-panel-select {
  display: flex;
  min-width: 0;
  height: 34rem;
  flex: 1;
  align-items: center;
  gap: 8rem;
  padding: 0 8rem;
  border: 0;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ts-panel-select:hover {
  background: var(--ui-fill-hover);
}
.ts-panel-select:active,
.ts-manage:active {
  transform: scale(0.98);
}
.ts-panel-dot {
  width: 8rem;
  height: 8rem;
  flex: 0 0 auto;
  border-radius: 50%;
}
.ts-panel-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ts-check {
  width: 15rem;
  height: 15rem;
  flex: 0 0 auto;
  fill: none;
  stroke: #007aff;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
}
.ts-panel-empty {
  margin: 34rem 0;
  color: var(--text-color-secondary);
  text-align: center;
}
.ts-manage {
  flex: 0 0 auto;
  width: 100%;
  padding: 10rem 12rem;
  border: 0;
  border-top: 1px solid var(--ui-border-divider);
  background: transparent;
  color: #007aff;
  font: inherit;
  font-size: var(--fs-secondary);
  text-align: left;
  cursor: pointer;
}
.ts-manage:hover {
  background: var(--ui-fill-hover);
}
</style>
