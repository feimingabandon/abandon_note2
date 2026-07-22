<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import TemplateForm from './TemplateForm.vue'
import TemplateCard from './TemplateCard.vue'
import TemplateCreatePanel from './TemplateCreatePanel.vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import AppToggle from '../ui/AppToggle.vue'
import StyledSelect from '../ui/StyledSelect.vue'
import { filterAndSortTemplates, isTemplateEditTarget } from '../../utils/templateRules.js'
import { useMessage } from '../../composables/useMessage.js'
import { useNotePresenceMotion } from '../../composables/useNotePresenceMotion.js'
import { releaseModalBlur, retainModalBlur } from '../../utils/modalBlur.js'

const { showMessage } = useMessage()
const templates = ref([])
const displayedTemplates = ref([])
const tags = ref([])
const loading = ref(false)
const refreshing = ref(false)
const lastRefreshedAt = ref(null)
const creating = ref(false)
const createPanelRef = ref(null)
const templateListRef = ref(null)
const queryInput = ref('')
const query = ref('')
const filtersOpen = ref(false)
const filterContentRef = ref(null)
const filterContentHeight = ref(0)
const state = ref('running')
const frequency = ref('all')
const selectedTags = ref([])
const pinnedOnly = ref(false)
const notifyOnly = ref(false)
const sort = ref('next')
const editing = ref(null)
const editFormRef = ref(null)
const savingEdit = ref(false)
const editDiscardConfirmVisible = ref(false)
const confirmVisible = ref(false)
const pendingAction = ref(null)
const resetAcknowledged = ref(false)
const visibleLimit = ref(10)
let queryTimer = null
let resetTimer = null
let resetRaf = null
let refreshSpinTimer = null
let stopChanged = null
let ownsEditBlur = false
let filterResizeObserver = null
let presenceMotionSeq = 0
let loadSeq = 0
let scrollPending = false
let loadingMore = false
let saveEditSequence = 0

const PAGE_FIRST = 10
const PAGE_MORE = 20

const stateOptions = [
  { value: 'running', label: '运行中' },
  { value: 'paused', label: '已暂停' },
  { value: 'deleted', label: '已删除' }
]
const frequencyOptions = [
  { value: 'all', label: '全部频率' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'yearly', label: '每年' }
]
const sortOptions = [
  { value: 'next', label: '按下次生成' },
  { value: 'updated', label: '按最近修改' },
  { value: 'created', label: '按创建时间' }
]
const refreshTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
})
const refreshSummary = computed(() =>
  lastRefreshedAt.value
    ? `当前${displayedTemplates.value.length}条 · 此条件共${filteredTemplates.value.length}条 · 刷新 ${refreshTimeFormatter.format(lastRefreshedAt.value)}`
    : `当前${displayedTemplates.value.length}条 · 此条件共${filteredTemplates.value.length}条`
)
const filteredTemplates = computed(() =>
  filterAndSortTemplates(templates.value, {
    text: query.value,
    frequency: frequency.value,
    tags: selectedTags.value,
    pinned: pinnedOnly.value,
    notify: notifyOnly.value,
    sort: sort.value
  })
)
const hasAdvancedFilters = computed(
  () =>
    state.value !== 'running' ||
    frequency.value !== 'all' ||
    selectedTags.value.length > 0 ||
    pinnedOnly.value ||
    notifyOnly.value ||
    sort.value !== 'next'
)
const hasMoreTemplates = computed(
  () => displayedTemplates.value.length < filteredTemplates.value.length
)
const confirmCopy = computed(() =>
  pendingAction.value?.name === 'purge'
    ? {
        title: '彻底删除循环模板？',
        message: '该操作无法撤销。已经生成的便签不会被删除。',
        confirm: '彻底删除'
      }
    : {
        title: '删除循环模板？',
        message: '模板将移入已删除。已经生成的便签不会受到影响。',
        confirm: '删除'
      }
)

watch(queryInput, (value) => {
  clearTimeout(queryTimer)
  queryTimer = setTimeout(() => {
    query.value = value
  }, 120)
})
watch(editing, (value) => {
  if (value && !ownsEditBlur) {
    ownsEditBlur = true
    retainModalBlur()
  } else if (!value && ownsEditBlur) {
    ownsEditBlur = false
    releaseModalBlur()
  }
})

const {
  captureVisibleCardLayout,
  animateRetainedCards,
  animateAuxiliaryIn,
  cancelCurrentPresenceExits,
  animateCurrentCardsOut,
  disposePresenceMotion
} = useNotePresenceMotion(() => templateListRef.value, {
  cardSelector: '.tc-card[data-template-id]',
  idAttribute: 'data-template-id',
  rootSelector: '.tp-page',
  auxiliarySelector: '.tp-summary, .tp-empty, .tp-more-state'
})

function finishRefreshSpin() {
  clearTimeout(refreshSpinTimer)
  refreshSpinTimer = setTimeout(() => {
    refreshing.value = false
    refreshSpinTimer = null
  }, 380)
}

async function loadTemplateData() {
  const requestSeq = ++loadSeq
  const requestedState = state.value
  loading.value = true
  try {
    const [rows, allTags] = await Promise.all([
      window.api.listTemplates({ state: requestedState }),
      window.api.listTags()
    ])
    if (requestSeq !== loadSeq || requestedState !== state.value) return false
    templates.value = rows || []
    tags.value = allTags || []
    lastRefreshedAt.value = new Date()
    return true
  } catch (error) {
    if (requestSeq === loadSeq) showMessage('error', error.message || '加载模板失败')
    return false
  } finally {
    if (requestSeq === loadSeq) loading.value = false
  }
}

/** 主动刷新或筛选变化：完全复用首页列表的依次退场、更新、依次入场节奏。 */
async function replayListRefresh({ fetch = false, spin = false, initial = false } = {}) {
  if (spin) {
    clearTimeout(refreshSpinTimer)
    refreshing.value = true
  }
  try {
    const motionSeq = ++presenceMotionSeq
    cancelCurrentPresenceExits()
    const scrollTop = templateListRef.value?.scrollTop || 0
    if (!initial) await animateCurrentCardsOut({ includeAuxiliary: true })
    if (motionSeq !== presenceMotionSeq) return false

    if (fetch && !(await loadTemplateData())) {
      if (motionSeq === presenceMotionSeq) cancelCurrentPresenceExits()
      return false
    }
    if (motionSeq !== presenceMotionSeq) return false

    visibleLimit.value = PAGE_FIRST
    displayedTemplates.value = filteredTemplates.value.slice(0, visibleLimit.value)
    await nextTick()
    if (motionSeq !== presenceMotionSeq) return false
    if (templateListRef.value) templateListRef.value.scrollTop = scrollTop
    animateAuxiliaryIn()
    animateRetainedCards(new Map())
    return true
  } finally {
    if (spin) finishRefreshSpin()
  }
}

/** 数据发生增删改时保留现有卡片，并通过 FLIP 平滑完成移除、插入和重排。 */
async function refreshInBackground({ before, reenterIds = [] } = {}) {
  const motionSeq = ++presenceMotionSeq
  cancelCurrentPresenceExits()
  const previousLayout = before || captureVisibleCardLayout()
  if (!(await loadTemplateData()) || motionSeq !== presenceMotionSeq) return false
  displayedTemplates.value = filteredTemplates.value.slice(0, visibleLimit.value)
  await nextTick()
  if (motionSeq !== presenceMotionSeq) return false
  animateRetainedCards(previousLayout, { reenterIds })
  return true
}

function refresh(options = {}) {
  return replayListRefresh({ ...options, fetch: true })
}

async function loadMoreTemplates() {
  if (loadingMore || !hasMoreTemplates.value) return
  loadingMore = true
  try {
    const before = captureVisibleCardLayout()
    visibleLimit.value += PAGE_MORE
    displayedTemplates.value = filteredTemplates.value.slice(0, visibleLimit.value)
    await nextTick()
    animateRetainedCards(before)
  } finally {
    loadingMore = false
  }
}

function onTemplateScroll(event) {
  if (scrollPending) return
  scrollPending = true
  requestAnimationFrame(() => {
    scrollPending = false
    const element = event.target
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 90) {
      void loadMoreTemplates()
    }
  })
}

function onTemplateWheel(event) {
  if (event.deltaY <= 0 || !hasMoreTemplates.value) return
  const element = event.currentTarget
  if (element.scrollHeight <= element.clientHeight + 1) void loadMoreTemplates()
}

async function createTemplate(payload) {
  if (creating.value) return
  creating.value = true
  const before = captureVisibleCardLayout()
  try {
    await window.api.createTemplate(payload)
    createPanelRef.value?.reset()
    showMessage('success', '循环模板已创建')
    if (state.value !== 'running') state.value = 'running'
    else await refreshInBackground({ before })
  } catch (error) {
    showMessage('error', error.message || '创建失败')
  } finally {
    creating.value = false
  }
}

function requestAction(name, template) {
  if (name === 'edit') {
    editing.value = template
    return
  }
  if (name === 'delete' || name === 'purge') {
    pendingAction.value = { name, template }
    confirmVisible.value = true
    return
  }
  performAction(name, template)
}

function closeEdit() {
  if (savingEdit.value) return
  editDiscardConfirmVisible.value = false
  editing.value = null
}

function requestCloseEdit() {
  if (savingEdit.value) return
  if (editFormRef.value?.hasChanges) {
    editDiscardConfirmVisible.value = true
    return
  }
  closeEdit()
}

function discardEdit() {
  closeEdit()
}

async function performAction(name, template) {
  const before = captureVisibleCardLayout()
  try {
    if (name === 'pause') await window.api.pauseTemplate(template.id)
    else if (name === 'resume') await window.api.resumeTemplate(template.id)
    else if (name === 'restore') await window.api.restoreTemplate(template.id)
    else if (name === 'delete') await window.api.deleteTemplate(template.id)
    else if (name === 'purge') await window.api.purgeTemplate(template.id)
    showMessage(
      'success',
      {
        pause: '模板已暂停',
        resume: '模板已恢复',
        restore: '模板已恢复',
        delete: '模板已移入已删除',
        purge: '模板已彻底删除'
      }[name]
    )
    if (name === 'restore' && state.value !== 'running') state.value = 'running'
    else await refreshInBackground({ before })
  } catch (error) {
    showMessage('error', error.message || '操作失败')
  }
}
function confirmAction() {
  const action = pendingAction.value
  pendingAction.value = null
  if (action) performAction(action.name, action.template)
}

function measureFilterContent() {
  filterContentHeight.value = filterContentRef.value?.offsetHeight || 0
}

function toggleFilters() {
  filtersOpen.value = !filtersOpen.value
}
function resetFilters() {
  state.value = 'running'
  frequency.value = 'all'
  selectedTags.value = []
  pinnedOnly.value = false
  notifyOnly.value = false
  sort.value = 'next'

  resetAcknowledged.value = false
  clearTimeout(resetTimer)
  if (resetRaf) cancelAnimationFrame(resetRaf)
  resetRaf = requestAnimationFrame(() => {
    resetRaf = null
    resetAcknowledged.value = true
    resetTimer = setTimeout(() => {
      resetAcknowledged.value = false
      resetTimer = null
    }, 620)
  })
}
async function saveEdit(payload) {
  if (!editing.value || savingEdit.value) return
  savingEdit.value = true
  const before = captureVisibleCardLayout()
  const editedId = editing.value.id
  const requestSequence = ++saveEditSequence
  try {
    await window.api.updateTemplate(editedId, payload)
    if (requestSequence !== saveEditSequence) return
    if (isTemplateEditTarget(editing.value, editedId)) editing.value = null
    showMessage('success', '模板修改已保存')
    await refreshInBackground({ before, reenterIds: [editedId] })
  } catch (error) {
    showMessage('error', error.message || '保存失败')
  } finally {
    savingEdit.value = false
  }
}
function toggleFilterTag(name) {
  const next = new Set(selectedTags.value)
  next.has(name) ? next.delete(name) : next.add(name)
  selectedTags.value = [...next]
}

watch(
  [state, frequency, selectedTags, pinnedOnly, notifyOnly, sort, query],
  (nextValues, previousValues) => {
    const stateChanged = nextValues[0] !== previousValues[0]
    void replayListRefresh({ fetch: stateChanged })
  },
  { deep: true }
)

onMounted(async () => {
  await replayListRefresh({ fetch: true, initial: true })
  measureFilterContent()
  filterResizeObserver = new ResizeObserver(measureFilterContent)
  if (filterContentRef.value) filterResizeObserver.observe(filterContentRef.value)
  stopChanged = window.api.onTemplatesChanged?.(() => refreshInBackground())
})
onBeforeUnmount(() => {
  presenceMotionSeq++
  loadSeq++
  saveEditSequence++
  clearTimeout(queryTimer)
  clearTimeout(resetTimer)
  clearTimeout(refreshSpinTimer)
  if (resetRaf) cancelAnimationFrame(resetRaf)
  disposePresenceMotion()
  stopChanged?.()
  filterResizeObserver?.disconnect()
  if (ownsEditBlur) releaseModalBlur()
})
</script>

<template>
  <section class="tp-page">
    <header class="tp-page-header">
      <span>循环便签模版设置</span>
    </header>
    <div class="tp-root" :inert="!!editing">
      <TemplateCreatePanel ref="createPanelRef" :submitting="creating" @submit="createTemplate" />

      <div class="tp-tools">
        <div class="tp-toolbar">
          <div class="tp-search">
            <svg viewBox="0 0 20 20">
              <circle cx="8.5" cy="8.5" r="5.5" />
              <path d="m13 13 4 4" />
            </svg>
            <input v-model="queryInput" placeholder="搜索模板内容" aria-label="搜索模板内容" />
            <button v-if="queryInput" title="清空搜索" @click="queryInput = ''">×</button>
          </div>
          <button
            class="tp-filter-button"
            :class="{ 'is-open': filtersOpen }"
            :aria-expanded="filtersOpen"
            aria-controls="template-filter-panel"
            @click="toggleFilters"
          >
            高级筛选
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
          </button>
          <button
            class="tp-refresh-button"
            title="刷新"
            aria-label="刷新模板"
            @click="refresh({ spin: true })"
          >
            <svg :class="{ spinning: refreshing }" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M16 7a7 7 0 1 0 .4 5M16 3v4h-4" />
            </svg>
          </button>
        </div>

        <div
          id="template-filter-panel"
          class="tp-filter-shell"
          :class="{ 'is-open': filtersOpen }"
          :style="{ height: filtersOpen ? `${filterContentHeight}px` : '0px' }"
          :inert="!filtersOpen"
          :aria-hidden="!filtersOpen"
        >
          <div ref="filterContentRef" class="tp-filter">
            <header class="tp-filter-header">
              <span>筛选条件</span>
              <button
                type="button"
                class="tp-filter-reset"
                :class="{ 'is-acknowledged': resetAcknowledged }"
                @click="resetFilters"
              >
                <Transition name="tp-reset-label" mode="out-in">
                  <span :key="resetAcknowledged ? 'done' : 'idle'" aria-live="polite">
                    {{ resetAcknowledged ? '✓ 已重置' : '重置' }}
                  </span>
                </Transition>
              </button>
            </header>
            <div class="tp-filter-row">
              <span>状态</span>
              <div class="tp-filter-chips">
                <button
                  v-for="item in stateOptions"
                  :key="item.value"
                  :class="{ active: state === item.value }"
                  @click="state = item.value"
                >
                  {{ item.label }}
                </button>
              </div>
            </div>
            <div class="tp-filter-row">
              <span>频率</span
              ><StyledSelect
                v-model="frequency"
                :options="frequencyOptions"
                width="122rem"
                size="sm"
              />
            </div>
            <div v-if="tags.length" class="tp-filter-row tp-filter-tags">
              <span>标签</span>
              <div>
                <button
                  v-for="tag in tags"
                  :key="tag.name"
                  :class="{ active: selectedTags.includes(tag.name) }"
                  @click="toggleFilterTag(tag.name)"
                >
                  {{ tag.name }}
                </button>
              </div>
            </div>
            <div class="tp-filter-row">
              <span>选项</span>
              <div class="tp-filter-options">
                <label>生成的便签是否置顶 <AppToggle v-model="pinnedOnly" /></label>
                <label>模板通知 <AppToggle v-model="notifyOnly" /></label>
              </div>
            </div>
            <div class="tp-filter-row">
              <span>排序</span
              ><StyledSelect v-model="sort" :options="sortOptions" width="138rem" size="sm" />
            </div>
          </div>
        </div>
      </div>

      <div class="tp-summary">
        <span>{{ loading ? '正在刷新…' : refreshSummary }}</span
        ><span v-if="query || hasAdvancedFilters">已应用筛选</span>
      </div>
      <div
        ref="templateListRef"
        class="tp-list scroll-y"
        @scroll="onTemplateScroll"
        @wheel.passive="onTemplateWheel"
      >
        <TemplateCard
          v-for="template in displayedTemplates"
          :key="template.id"
          :template="template"
          @action="requestAction"
        />
        <div v-if="!loading && !displayedTemplates.length" class="tp-empty">
          <svg viewBox="0 0 32 32"><path d="M8 5h13l4 4v18H8zM21 5v5h5M12 15h9M12 20h7" /></svg>
          <strong>{{ state === 'deleted' ? '没有已删除模板' : '还没有符合条件的模板' }}</strong>
          <span>{{
            state === 'deleted'
              ? '删除的模板会暂时保留在这里'
              : '展开上方的新建框，创建第一个循环模板'
          }}</span>
        </div>
        <div v-else-if="hasMoreTemplates" class="tp-more-state">继续向下滚动加载更多</div>
        <div v-else-if="displayedTemplates.length" class="tp-more-state">已显示全部模板</div>
      </div>
    </div>
  </section>

  <Teleport to="body">
    <Transition name="tp-modal">
      <div v-if="editing" class="tp-edit-overlay" @click.self="requestCloseEdit">
        <section class="tp-edit-dialog" role="dialog" aria-modal="true" aria-label="修改循环模板">
          <header>
            <strong>修改循环模板</strong
            ><button title="关闭" :disabled="savingEdit" @click="requestCloseEdit">×</button>
          </header>
          <div class="tp-edit-body">
            <TemplateForm
              ref="editFormRef"
              :initial="editing"
              :submitting="savingEdit"
              editor-mode
              submit-label="保存修改"
              show-cancel
              @submit="saveEdit"
              @cancel="requestCloseEdit"
            />
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>

  <ConfirmDialog
    v-model:visible="editDiscardConfirmVisible"
    title="放弃未保存的修改？"
    message="正文、生成规则、通知、置顶和标签都将恢复为打开编辑器时的内容。"
    confirm-text="放弃修改"
    cancel-text="继续编辑"
    variant="danger"
    @confirm="discardEdit"
  />

  <ConfirmDialog
    v-model:visible="confirmVisible"
    :title="confirmCopy.title"
    :message="confirmCopy.message"
    :confirm-text="confirmCopy.confirm"
    variant="danger"
    @confirm="confirmAction"
    @cancel="pendingAction = null"
  />
</template>

<style scoped>
.tp-page {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: transparent;
}
.tp-page-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 47rem;
  flex-shrink: 0;
  padding: 0 16rem;
  border-bottom: 1px solid rgb(var(--bg-color) / 0.1);
  color: var(--text-color);
  font-size: var(--fs-body);
  font-weight: 600;
}
.tp-root {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 10rem;
  padding: 16rem;
  color: var(--text-color);
}
.tp-tools {
  display: flex;
  min-width: 0;
  flex-shrink: 0;
  flex-direction: column;
}
.tp-toolbar {
  display: flex;
  align-items: center;
  gap: 9rem;
  flex-shrink: 0;
  min-height: 45rem;
  padding: 4rem 2rem 5rem;
}
.tp-search {
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
.tp-search:focus-within {
  border-color: rgb(var(--bg-color) / 0.18);
}
.tp-search svg {
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
.tp-search input {
  flex: 1;
  min-width: 0;
  height: 32rem;
  padding: 0 10rem;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-color);
  font: inherit;
}
.tp-search input::placeholder {
  color: var(--text-color-secondary);
  opacity: 0.64;
}
.tp-search button {
  display: grid;
  place-items: center;
  width: 25rem;
  height: 25rem;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text-color-secondary);
  font-size: 18rem;
  cursor: pointer;
  transition:
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease,
    transform var(--motion-fast) ease;
}
.tp-search button:hover {
  background: color-mix(in srgb, var(--text-color) 8%, transparent);
  color: var(--text-color);
}
.tp-search button:active {
  transform: scale(0.94);
}
.tp-filter-button {
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
.tp-filter-button:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #000;
  opacity: 0.7;
}
.tp-filter-button.is-open {
  border-color: rgb(var(--bg-color) / 0.18);
  opacity: 1;
}
.tp-filter-button:active {
  transform: scale(0.97);
}
.tp-filter-button svg {
  width: 13rem;
  height: 13rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 220ms var(--ease-standard);
}
.tp-filter-button.is-open svg {
  transform: rotate(180deg);
}
.tp-refresh-button {
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
  cursor: pointer;
  transition:
    background-color var(--motion-fast) ease,
    color var(--motion-fast) ease,
    transform var(--motion-fast) ease;
}
.tp-refresh-button:hover {
  background: color-mix(in srgb, var(--text-color) 8%, transparent);
  color: var(--text-color);
}
.tp-refresh-button:active {
  transform: scale(0.94);
}
.tp-refresh-button svg {
  width: 16rem;
  height: 16rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.tp-refresh-button svg.spinning {
  animation: tp-spin 380ms ease;
}
@keyframes tp-spin {
  to {
    transform: rotate(360deg);
  }
}
.tp-filter-shell {
  flex-shrink: 0;
  overflow: hidden;
  opacity: 0;
  transform: translateY(-4rem);
  visibility: hidden;
  transition:
    height 180ms var(--ease-standard),
    opacity 130ms ease,
    transform 180ms var(--ease-standard),
    visibility 0s linear 180ms;
}
.tp-filter-shell.is-open {
  opacity: 1;
  transform: translateY(0);
  visibility: visible;
  transition:
    height 220ms var(--ease-standard),
    opacity 160ms ease,
    transform 220ms var(--ease-standard),
    visibility 0s;
}
.tp-filter {
  display: flex;
  flex-direction: column;
  gap: 0;
  box-sizing: border-box;
  padding: 4rem 7rem 8rem;
  border: 1px solid rgb(var(--bg-color) / 0.1);
  border-radius: 10rem;
  background: transparent;
  overflow: hidden;
}
.tp-filter-header {
  display: flex;
  align-items: center;
  min-height: 30rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.tp-filter-reset {
  min-width: 54rem;
  min-height: 27rem;
  margin-left: auto;
  padding: 3rem 5rem;
  border: 0;
  border-radius: 7rem;
  background: transparent;
  color: #0a84ff;
  font: inherit;
  font-size: inherit;
  cursor: pointer;
  transition:
    background-color 160ms ease,
    color 160ms ease,
    transform 160ms var(--ease-standard);
}
.tp-filter-reset:hover {
  background: color-mix(in srgb, #0a84ff 8%, transparent);
}
.tp-filter-reset:active {
  transform: scale(0.95);
}
.tp-filter-reset.is-acknowledged {
  background: color-mix(in srgb, #0a84ff 11%, transparent);
  transform: scale(1);
}
.tp-reset-label-enter-active,
.tp-reset-label-leave-active {
  transition:
    opacity 130ms ease,
    transform 160ms var(--ease-standard);
}
.tp-reset-label-enter-from {
  opacity: 0;
  transform: translateY(3rem);
}
.tp-reset-label-leave-to {
  opacity: 0;
  transform: translateY(-3rem);
}
.tp-filter-row {
  display: grid;
  grid-template-columns: 50rem minmax(0, 1fr);
  align-items: center;
  min-height: 38rem;
  font-size: var(--fs-secondary);
}
.tp-filter-row > span {
  color: var(--text-color-secondary);
}
.tp-filter-chips,
.tp-filter-tags > div {
  display: flex;
  gap: 6rem;
  flex-wrap: wrap;
}
.tp-filter-chips button,
.tp-filter-tags button {
  min-height: 27rem;
  padding: 0 10rem;
  border: 1rem solid rgba(255, 255, 255, 0.1);
  border-radius: 8rem;
  background: rgba(128, 128, 128, 0.05);
  color: var(--text-color-secondary);
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
  transition:
    border-color var(--motion-fast) ease,
    background-color var(--motion-control) var(--ease-standard),
    color var(--motion-fast) ease,
    box-shadow var(--motion-control) var(--ease-standard),
    transform var(--motion-fast) var(--ease-standard);
}
.tp-filter-chips button:hover,
.tp-filter-tags button:hover {
  background: rgba(128, 128, 128, 0.1);
  color: var(--text-color);
}
.tp-filter-chips button:active,
.tp-filter-tags button:active {
  transform: scale(0.96);
}
.tp-filter-chips button.active,
.tp-filter-tags button.active {
  border-color: #0071e3;
  background: #0071e3;
  color: #fff;
  font-weight: 600;
  box-shadow: 0 2rem 7rem rgba(0, 113, 227, 0.2);
}
.tp-filter-chips button.active:hover,
.tp-filter-tags button.active:hover {
  border-color: #0077ed;
  background: #0077ed;
  color: #fff;
  box-shadow: 0 3rem 9rem rgba(0, 113, 227, 0.26);
}
.tp-filter-row label {
  display: flex;
  align-items: center;
  gap: 7rem;
  color: var(--text-color-secondary);
}
.tp-filter-options {
  display: flex;
  align-items: center;
  gap: 14rem;
  min-width: 0;
}
.tp-summary {
  display: flex;
  justify-content: space-between;
  padding: 0 2rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.9);
}
.tp-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8rem;
  padding: 1rem 2rem 12rem;
}
.tp-list > :deep(.tc-card) {
  margin-bottom: 8rem;
}
.tp-empty {
  display: flex;
  flex: 1;
  min-height: 170rem;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 5rem;
  color: var(--text-color-secondary);
  text-align: center;
}
.tp-empty svg {
  width: 38rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.3;
  opacity: 0.45;
}
.tp-empty strong {
  color: var(--text-color);
  font-size: var(--fs-body);
}
.tp-empty span {
  font-size: var(--fs-secondary);
  opacity: 0.72;
}
.tp-more-state {
  flex-shrink: 0;
  padding: 7rem 0 1rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.86);
  text-align: center;
  opacity: 0.68;
}
.tp-edit-overlay {
  position: fixed;
  z-index: 21000;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 22rem;
  background: rgba(18, 20, 24, 0.04);
}
.tp-edit-dialog {
  display: flex;
  flex-direction: column;
  width: min(620rem, 100%);
  height: min(639rem, 100%);
  min-height: 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--text-color) 10%, transparent);
  border-radius: 16rem;
  background-color: rgb(var(--bg-color) / var(--glass-opacity-base));
  box-shadow: 0 22rem 56rem rgba(0, 0, 0, 0.28);
}
.tp-edit-dialog header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  min-height: 42rem;
  padding: 0 12rem 0 16rem;
  border-bottom: 1px solid color-mix(in srgb, var(--text-color) 8%, transparent);
  color: var(--text-color);
  font-size: var(--fs-body);
  font-weight: 600;
}
.tp-edit-dialog header button {
  display: grid;
  place-items: center;
  width: 26rem;
  height: 26rem;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text-color-secondary);
  font: inherit;
  font-size: 22rem;
  line-height: 1;
  cursor: pointer;
  transition:
    background-color 140ms ease,
    color 140ms ease,
    transform 140ms var(--ease-standard);
}
.tp-edit-dialog header button:hover {
  background: color-mix(in srgb, var(--text-color) 9%, transparent);
  color: var(--text-color);
}
.tp-edit-dialog header button:active {
  transform: scale(0.9);
}
.tp-edit-dialog header button:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}
.tp-edit-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.tp-modal-enter-active,
.tp-modal-leave-active {
  transition: opacity 180ms ease;
}
.tp-modal-enter-active .tp-edit-dialog,
.tp-modal-leave-active .tp-edit-dialog {
  transition:
    transform 220ms cubic-bezier(0.32, 0.72, 0, 1),
    opacity 180ms ease;
}
.tp-modal-enter-from,
.tp-modal-leave-to {
  opacity: 0;
}
.tp-modal-enter-from .tp-edit-dialog,
.tp-modal-leave-to .tp-edit-dialog {
  opacity: 0;
  transform: translateY(8rem) scale(0.985);
}
@media (max-width: 420px) {
  .tp-filter-row {
    grid-template-columns: 44rem minmax(0, 1fr);
  }
  .tp-filter-chips button,
  .tp-filter-tags button {
    padding: 0 7rem;
  }
  .tp-filter-options {
    align-items: flex-start;
    flex-direction: column;
    gap: 6rem;
    padding: 5rem 0;
  }
}
</style>
