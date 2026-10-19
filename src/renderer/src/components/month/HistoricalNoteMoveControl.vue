<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from '../ui/AppIcon.vue'
import AppModalShell from '../ui/AppModalShell.vue'
import AppToggle from '../ui/AppToggle.vue'
import BaseButton from '../ui/BaseButton.vue'
import DateRangePicker from '../ui/DateRangePicker.vue'
import { useModalRequest } from '../../composables/useQueuedModal.js'
import { useTodayKey } from '../../composables/useTodayKey.js'
import { useMessage } from '../../composables/useMessage.js'
import {
  MIN_CALENDAR_DATE,
  addCalendarDays
} from '../../../../shared/calendar/calendar-date-rules.js'
import {
  createHistoricalMoveSelection,
  historicalMoveSelectionCount,
  historicalMoveSelectionPayload,
  isHistoricalMoveSelected,
  toggleHistoricalMoveSelection
} from './historical-note-move-selection.js'

const props = defineProps({ disabled: { type: Boolean, default: false } })
const emit = defineEmits(['moved', 'open-change'])
const modalQueue = useModalRequest()
const modalShellQueue = {
  ...modalQueue,
  finishLeave() {
    modalQueue.finishLeave()
    resetResultsMotion()
    if (!disposed && !open.value) {
      triggerFocusPending = true
      void restoreTriggerFocus()
    }
  }
}
const open = modalQueue.requested
const todayKey = useTodayKey()
const { showMessage } = useMessage()
const presets = [
  { value: 'yesterday', label: '昨天' },
  { value: 'recent3', label: '最近3天' },
  { value: 'all', label: '全部历史' }
]
const preset = ref('yesterday')
const startDateKey = ref('')
const endDateKey = ref('')
const yesterdayKey = computed(() => addCalendarDays(todayKey.value, -1))
const notes = ref([])
const preview = ref(null)
const selection = ref(createHistoricalMoveSelection())
const previewLoading = ref(false)
const loadingMore = ref(false)
const previewError = ref('')
const previewTransitioning = ref(false)
const cardHeight = ref('auto')
const resultsViewportRef = ref(null)
const resultsRef = ref(null)
const selectionNotice = ref('')
const moving = ref(false)
const autoEnabled = ref(false)
const quickCreateEnabled = ref(false)
const settingsLoading = ref(true)
const settingsError = ref('')
const autoSaving = ref(false)
const quickCreateSaving = ref(false)
const settingsSaving = computed(() => autoSaving.value || quickCreateSaving.value)
const autoToggleRef = ref(null)
const quickCreateToggleRef = ref(null)
const triggerRef = ref(null)
let triggerFocusPending = false
let triggerFocusFrame = null
const autoError = ref('')
const quickCreateError = ref('')
let previewSequence = 0
let settingsRevision = 0
let settingsLoadSequence = 0
let disposed = false
let stopNotesListener = null
let stopSettingsListener = null
let animatedCard = null
let heightAnimation = null
let opacityAnimation = null
const pageSize = 50
const resultsUnavailable = computed(
  () =>
    previewLoading.value ||
    loadingMore.value ||
    previewTransitioning.value ||
    Boolean(previewError.value)
)
const resultsState = computed(() =>
  previewTransitioning.value
    ? 'transitioning'
    : previewLoading.value || loadingMore.value
      ? 'loading'
      : previewError.value
        ? 'error'
        : 'ready'
)
const selectedCount = computed(() =>
  historicalMoveSelectionCount(selection.value, preview.value?.movableCount || 0, notes.value)
)
const groups = computed(() => {
  const result = []
  for (const note of notes.value) {
    let group = result.at(-1)
    if (!group || group.dateKey !== note.dateKey) {
      group = { dateKey: note.dateKey, notes: [] }
      result.push(group)
    }
    group.notes.push(note)
  }
  return result
})

function rangePayload() {
  return preset.value === 'all'
    ? { scope: 'all' }
    : { scope: 'range', startDateKey: startDateKey.value, endDateKey: endDateKey.value }
}

function selectPreset(value) {
  if (moving.value) return
  if (preset.value === value && preview.value && !resultsUnavailable.value) return
  preset.value = value
  startDateKey.value =
    value === 'recent3' ? addCalendarDays(yesterdayKey.value, -2) : yesterdayKey.value
  endDateKey.value = yesterdayKey.value
  void loadPreview()
}

function applyCustomRange(range) {
  if (moving.value) return
  preset.value = 'custom'
  startDateKey.value = range.start
  endDateKey.value = range.end
  void loadPreview()
}

function currentPreviewRequest(sequence) {
  return !disposed && open.value && sequence === previewSequence
}

function freezeResultsMotion() {
  const card = resultsViewportRef.value?.closest('.app-modal-card') || animatedCard
  const height = card?.getBoundingClientRect().height
  const opacity = resultsRef.value ? getComputedStyle(resultsRef.value).opacity : ''
  heightAnimation?.cancel()
  opacityAnimation?.cancel()
  heightAnimation = opacityAnimation = null
  animatedCard = card
  if (card && height) {
    // Shell renders its inline height again when slot state changes.
    // Keep its height prop aligned with the interrupted visible frame.
    cardHeight.value = `${height}px`
    card.style.height = cardHeight.value
  }
  if (resultsRef.value && opacity) resultsRef.value.style.opacity = opacity
  previewTransitioning.value = false
}

function resetResultsMotion() {
  heightAnimation?.cancel()
  opacityAnimation?.cancel()
  heightAnimation = opacityAnimation = null
  cardHeight.value = 'auto'
  if (animatedCard) animatedCard.style.height = 'auto'
  if (resultsRef.value) resultsRef.value.style.opacity = ''
  animatedCard = null
  previewTransitioning.value = false
}

function animateNaturalCardHeight() {
  const card = animatedCard
  if (!card) return null
  const fromHeight = card.getBoundingClientRect().height
  // The natural target is measured synchronously under the existing max-height.
  // A long list therefore animates only the visible card, retaining body scrolling.
  card.style.height = 'auto'
  const targetHeight = card.getBoundingClientRect().height
  card.style.height = `${fromHeight}px`
  return card.animate([{ height: `${fromHeight}px` }, { height: `${targetHeight}px` }], {
    duration: 260,
    easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
    fill: 'forwards'
  })
}

async function presentPreview(result, { append, clearSelection, sequence }) {
  freezeResultsMotion()
  previewTransitioning.value = true
  const content = resultsRef.value
  if (preview.value && content) {
    opacityAnimation = content.animate(
      [{ opacity: getComputedStyle(content).opacity }, { opacity: 0 }],
      { duration: 80, easing: 'ease-out', fill: 'forwards' }
    )
    await opacityAnimation.finished.catch(() => {})
    if (!currentPreviewRequest(sequence)) return
  }
  if (content) content.style.opacity = '0'
  opacityAnimation?.cancel()
  opacityAnimation = null
  notes.value = append ? [...notes.value, ...result.notes] : result.notes
  preview.value = result
  if (!append) {
    selection.value = createHistoricalMoveSelection(!clearSelection)
    selectionNotice.value = clearSelection ? '便签已更新，请重新选择要移动的便签。' : ''
  }
  await nextTick()
  if (!currentPreviewRequest(sequence)) return
  heightAnimation = animateNaturalCardHeight()
  if (content) {
    opacityAnimation = content.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 180,
      easing: 'ease-out',
      fill: 'forwards'
    })
  }
  await Promise.allSettled([heightAnimation?.finished, opacityAnimation?.finished])
  if (currentPreviewRequest(sequence)) resetResultsMotion()
}

async function presentPreviewError(error, sequence) {
  freezeResultsMotion()
  previewError.value = error?.message || '无法读取历史便签'
  previewTransitioning.value = true
  await nextTick()
  if (!currentPreviewRequest(sequence)) return
  heightAnimation = animateNaturalCardHeight()
  if (resultsRef.value) {
    opacityAnimation = resultsRef.value.animate(
      [{ opacity: getComputedStyle(resultsRef.value).opacity }, { opacity: 0.32 }],
      { duration: 180, easing: 'ease-out', fill: 'forwards' }
    )
  }
  await Promise.allSettled([heightAnimation?.finished, opacityAnimation?.finished])
  if (currentPreviewRequest(sequence)) resetResultsMotion()
}

async function loadPreview({ append = false, clearSelection = false } = {}) {
  if (!open.value || (append && (previewLoading.value || loadingMore.value))) return
  const sequence = ++previewSequence
  freezeResultsMotion()
  previewError.value = ''
  if (append) loadingMore.value = true
  else {
    previewLoading.value = true
    loadingMore.value = false
  }
  if (preview.value && resultsRef.value) {
    opacityAnimation = resultsRef.value.animate(
      [{ opacity: getComputedStyle(resultsRef.value).opacity }, { opacity: 0.4 }],
      { duration: 120, easing: 'ease-out', fill: 'forwards' }
    )
  }
  try {
    const result = await window.api.previewHistoricalNotesToToday({
      ...rangePayload(),
      targetDateKey: append ? preview.value.targetDateKey : todayKey.value,
      limit: pageSize,
      offset: append ? notes.value.length : 0
    })
    if (disposed || sequence !== previewSequence || !open.value) return
    if (
      append &&
      (result.count !== preview.value.count || result.movableCount !== preview.value.movableCount)
    ) {
      await loadPreview({ clearSelection: true })
      return
    }
    await presentPreview(result, { append, clearSelection, sequence })
  } catch (error) {
    if (disposed || sequence !== previewSequence || !open.value) return
    await presentPreviewError(error, sequence)
  } finally {
    if (sequence === previewSequence) {
      previewLoading.value = false
      loadingMore.value = false
    }
  }
}

function selectAll() {
  if (moving.value || resultsUnavailable.value) return
  selection.value = createHistoricalMoveSelection()
  selectionNotice.value = ''
}

function clearSelection() {
  if (moving.value || resultsUnavailable.value) return
  selection.value = createHistoricalMoveSelection(false)
  selectionNotice.value = ''
}

function toggleSelection(note) {
  if (moving.value || resultsUnavailable.value) return
  selection.value = toggleHistoricalMoveSelection(selection.value, note)
  selectionNotice.value = ''
}

function durationLabel(note) {
  if (note.durationKind === 'fixed_days') return `指定 ${note.durationDays} 天`
  if (note.durationKind === 'until_completed') return '持续到完成'
  return '仅当天'
}

function disabledReason(note) {
  if (note.disabledReason) return note.disabledReason
  return note.durationKind === 'until_completed'
    ? '已持续显示到今天，无需移动。'
    : '已设置持续天数，不能使用移至今天。'
}

function onPreviewChanged() {
  if (open.value && !moving.value) void loadPreview({ clearSelection: true })
}

async function executeMove() {
  if (
    moving.value ||
    settingsSaving.value ||
    previewLoading.value ||
    previewTransitioning.value ||
    loadingMore.value ||
    previewError.value ||
    selectedCount.value <= 0
  )
    return
  moving.value = true
  try {
    const result = await window.api.moveHistoricalNotesToToday({
      ...rangePayload(),
      ...historicalMoveSelectionPayload(selection.value, notes.value),
      targetDateKey: preview.value.targetDateKey
    })
    if (disposed) return
    if (result.count > 0) {
      showMessage('success', `已将 ${result.count} 条未完成便签移至今天`)
      emit('moved', result)
      open.value = false
    } else {
      showMessage('warning', '所选便签已没有可移动项，请重新选择。')
      await loadPreview({ clearSelection: true })
    }
  } catch (error) {
    if (disposed) return
    showMessage('error', error?.message || '移动未完成便签失败')
    await loadPreview({ clearSelection: true })
  } finally {
    moving.value = false
  }
}

function applySettings(snapshot) {
  if (disposed) return
  settingsRevision += 1
  autoEnabled.value = Boolean(snapshot?.values?.notes?.autoMoveToToday)
  quickCreateEnabled.value = Boolean(snapshot?.values?.notes?.quickCreateUntilCompleted)
  settingsError.value = ''
}

async function loadSettings() {
  if (disposed) return
  const sequence = ++settingsLoadSequence
  const revision = settingsRevision
  settingsLoading.value = true
  settingsError.value = ''
  autoError.value = ''
  quickCreateError.value = ''
  try {
    const snapshot = await window.api.getSettingsSnapshot()
    if (!disposed && sequence === settingsLoadSequence && revision === settingsRevision) {
      applySettings(snapshot)
    }
  } catch (error) {
    if (!disposed && sequence === settingsLoadSequence && revision === settingsRevision) {
      settingsError.value = error?.message || '无法读取便签延续与移动设置'
    }
  } finally {
    if (!disposed && sequence === settingsLoadSequence) settingsLoading.value = false
  }
}

async function saveAutoSetting(value) {
  if (disposed || settingsSaving.value || settingsLoading.value || moving.value) return
  const restoreToggleFocus = document.activeElement === autoToggleRef.value?.$el
  autoSaving.value = true
  autoError.value = ''
  try {
    await window.api.setSettingValue('notes.autoMoveToToday', Boolean(value))
    if (!disposed) {
      await loadSettings()
      if (!disposed) onPreviewChanged()
    }
  } catch (error) {
    if (!disposed) autoError.value = error?.message || '无法保存自动移动设置'
  } finally {
    if (!disposed) autoSaving.value = false
    await nextTick()
    if (!disposed && open.value && restoreToggleFocus && document.activeElement === document.body) {
      autoToggleRef.value?.$el?.focus({ preventScroll: true })
    }
  }
}

async function saveQuickCreateSetting(value) {
  if (disposed || settingsSaving.value || settingsLoading.value || moving.value) return
  const restoreToggleFocus = document.activeElement === quickCreateToggleRef.value?.$el
  quickCreateSaving.value = true
  quickCreateError.value = ''
  try {
    await window.api.setSettingValue('notes.quickCreateUntilCompleted', Boolean(value))
    if (!disposed) await loadSettings()
  } catch (error) {
    if (!disposed) quickCreateError.value = error?.message || '无法保存快捷新建设置'
  } finally {
    if (!disposed) quickCreateSaving.value = false
    await nextTick()
    if (!disposed && open.value && restoreToggleFocus && document.activeElement === document.body) {
      quickCreateToggleRef.value?.$el?.focus({ preventScroll: true })
    }
  }
}

async function restoreTriggerFocus() {
  await nextTick()
  if (triggerFocusFrame !== null) cancelAnimationFrame(triggerFocusFrame)
  triggerFocusFrame = requestAnimationFrame(() => {
    triggerFocusFrame = null
    if (disposed || open.value || !triggerFocusPending || props.disabled || moving.value) return
    const active = document.activeElement
    // A calendar refresh can temporarily disable the original trigger while
    // the modal closes. Retry when it settles, without taking another dialog's focus.
    if (
      active === document.body ||
      active === triggerRef.value ||
      active?.closest('.historical-note-move')
    ) {
      triggerRef.value?.focus({ preventScroll: true })
    }
    triggerFocusPending = false
  })
}

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled && !open.value && document.activeElement === triggerRef.value) {
      triggerFocusPending = true
    }
    if (triggerFocusPending && !props.disabled) void restoreTriggerFocus()
  }
)
watch(open, (value) => {
  emit('open-change', value)
  triggerFocusPending = !value
  if (!value) {
    previewSequence += 1
    freezeResultsMotion()
    previewLoading.value = false
    loadingMore.value = false
    void restoreTriggerFocus()
  }
})
watch(todayKey, () => {
  if (!open.value) return
  if (preset.value === 'yesterday' || preset.value === 'recent3') {
    startDateKey.value =
      preset.value === 'recent3' ? addCalendarDays(yesterdayKey.value, -2) : yesterdayKey.value
    endDateKey.value = yesterdayKey.value
  }
  onPreviewChanged()
})

function requestOpen() {
  resetResultsMotion()
  notes.value = []
  preview.value = null
  previewError.value = ''
  selection.value = createHistoricalMoveSelection()
  selectionNotice.value = ''
  preset.value = 'yesterday'
  startDateKey.value = yesterdayKey.value
  endDateKey.value = yesterdayKey.value
  open.value = true
}

onMounted(() => {
  stopNotesListener = window.api.onNotesChanged?.(onPreviewChanged)
  stopSettingsListener = window.api.onSettingsChanged?.(applySettings)
  void loadSettings()
})
onBeforeUnmount(() => {
  disposed = true
  resetResultsMotion()
  if (triggerFocusFrame !== null) cancelAnimationFrame(triggerFocusFrame)
  previewSequence += 1
  stopNotesListener?.()
  stopSettingsListener?.()
})
</script>

<template>
  <button
    ref="triggerRef"
    type="button"
    class="historical-note-move__trigger"
    :disabled="disabled || moving"
    :class="{ 'is-open': open }"
    aria-haspopup="dialog"
    :aria-expanded="open"
    aria-label="便签延续与移动"
    title="便签延续与移动"
    @click="requestOpen"
  >
    <AppIcon name="move-to-today" class="historical-note-move__icon" />
  </button>
  <AppModalShell
    v-model:visible="open"
    :queue="modalShellQueue"
    title="便签延续与移动"
    subtitle="设置快捷新建的持续方式，或将未完成的仅当天便签移至今天。"
    width="min(560rem, calc(100vw - 32rem))"
    :height="cardHeight"
    :close-disabled="moving || settingsSaving"
    @opened="loadPreview()"
  >
    <div class="historical-note-move" :aria-busy="previewLoading || moving">
      <section class="historical-note-move__automatic">
        <div>
          <strong id="historical-move-quick-create-label">快捷新建默认持续到完成</strong>
          <p id="historical-move-quick-create-help">
            开启后，周/月日期格快捷新建的便签从生效日持续显示，直到完成。关闭时仅在生效当天显示；不改变已有便签与完整新建选项。
          </p>
          <p v-if="quickCreateError" class="historical-note-move__error" role="alert">
            {{ quickCreateError }}
          </p>
        </div>
        <AppToggle
          id="historical-move-quick-create-toggle"
          ref="quickCreateToggleRef"
          data-quick-create-until-completed
          :model-value="quickCreateEnabled"
          :disabled="settingsLoading || settingsSaving || moving || Boolean(settingsError)"
          size="sm"
          aria-labelledby="historical-move-quick-create-label"
          aria-describedby="historical-move-quick-create-help"
          @update:model-value="saveQuickCreateSetting"
        />
      </section>
      <section class="historical-note-move__automatic">
        <div>
          <strong id="historical-move-auto-label">每天自动移至今天</strong>
          <p id="historical-move-auto-help">
            每天自动移动昨天未完成的仅当天便签，开启后立即检查。所有视图共用此设置。
          </p>
          <p v-if="autoError" class="historical-note-move__error" role="alert">{{ autoError }}</p>
        </div>
        <AppToggle
          id="historical-move-auto-toggle"
          ref="autoToggleRef"
          :model-value="autoEnabled"
          :disabled="settingsLoading || settingsSaving || moving || Boolean(settingsError)"
          size="sm"
          aria-labelledby="historical-move-auto-label"
          aria-describedby="historical-move-auto-help"
          @update:model-value="saveAutoSetting"
        />
      </section>
      <div v-if="settingsError" class="historical-note-move__error" role="alert">
        {{ settingsError }}
        <BaseButton size="sm" :disabled="settingsSaving" @click="loadSettings"
          >重试读取设置</BaseButton
        >
      </div>
      <div class="historical-note-move__presets" role="group" aria-label="历史日期范围">
        <BaseButton
          v-for="option in presets"
          :key="option.value"
          class="historical-note-move__preset"
          :data-move-preset="option.value"
          size="sm"
          :variant="preset === option.value ? 'primary' : 'default'"
          :aria-pressed="preset === option.value"
          :disabled="moving || settingsSaving"
          @click="selectPreset(option.value)"
          >{{ option.label }}</BaseButton
        >
      </div>
      <div class="historical-note-move__range" :inert="moving || settingsSaving">
        <span>自选日期区间</span>
        <DateRangePicker
          :start="preset === 'all' ? '' : startDateKey"
          :end="preset === 'all' ? '' : endDateKey"
          :min-date="MIN_CALENDAR_DATE"
          :max-date="yesterdayKey"
          @change="applyCustomRange"
        />
      </div>
      <div
        ref="resultsViewportRef"
        class="historical-note-move__results-viewport"
        :class="{ 'is-empty': !preview }"
        :data-state="resultsState"
        :aria-busy="previewLoading || loadingMore || previewTransitioning"
        data-move-results-viewport
      >
        <p
          v-if="(previewLoading || loadingMore) && !previewTransitioning"
          class="historical-note-move__feedback"
          role="status"
          data-move-loading
        >
          <span>正在读取历史便签…</span>
        </p>
        <div
          v-if="previewError"
          class="historical-note-move__feedback historical-note-move__error"
          role="alert"
        >
          <span>{{ previewError }}</span>
          <BaseButton size="sm" @click="loadPreview({ clearSelection: true })">重新读取</BaseButton>
        </div>
        <div
          ref="resultsRef"
          class="historical-note-move__results"
          :inert="resultsUnavailable"
          :aria-hidden="resultsUnavailable || undefined"
          data-move-results
        >
          <template v-if="preview">
            <p class="historical-note-move__summary" aria-live="polite" data-move-preview>
              共 <strong>{{ preview.count }}</strong> 条，可移动
              <strong>{{ preview.movableCount }}</strong> 条，不可移动
              <strong>{{ preview.disabledCount }}</strong> 条。
            </p>
            <p v-if="selectionNotice" class="historical-note-move__hint" role="status">
              {{ selectionNotice }}
            </p>
            <div class="historical-note-move__selection-bar">
              <span data-move-selection-count
                >已选 {{ selectedCount }} / {{ preview.movableCount }} 条可移动便签</span
              >
              <div>
                <BaseButton
                  size="sm"
                  variant="text"
                  :disabled="moving || resultsUnavailable || selectedCount === preview.movableCount"
                  data-move-select-all
                  @click="selectAll"
                  >全选可移动项</BaseButton
                >
                <BaseButton
                  size="sm"
                  variant="text"
                  :disabled="moving || resultsUnavailable || selectedCount === 0"
                  data-move-clear-selection
                  @click="clearSelection"
                  >取消全选</BaseButton
                >
              </div>
            </div>
            <p class="historical-note-move__hint historical-note-move__selection-help">
              全选包含当前日期范围内尚未加载的可移动便签。手动指定过历史生效日期的仅当天便签也可移动。
            </p>
            <div v-if="groups.length" class="historical-note-move__note-list" data-move-note-list>
              <section
                v-for="group in groups"
                :key="group.dateKey"
                class="historical-note-move__group"
              >
                <h3>
                  <time :datetime="group.dateKey">{{ group.dateKey }}</time>
                </h3>
                <ul>
                  <li v-for="note in group.notes" :key="note.id" :data-note-id="note.id">
                    <label class="historical-note-move__note-option">
                      <input
                        type="checkbox"
                        :checked="isHistoricalMoveSelected(selection, note)"
                        :disabled="moving || resultsUnavailable || !note.canMove"
                        :aria-describedby="
                          !note.canMove ? `historical-move-reason-${note.id}` : undefined
                        "
                        @change="toggleSelection(note)"
                      />
                      <span class="historical-note-move__note-text">
                        <span class="historical-note-move__content">{{
                          note.content?.trim() || '（无正文）'
                        }}</span>
                        <span class="historical-note-move__note-meta">
                          <span class="historical-note-move__hint">{{ durationLabel(note) }}</span>
                          <span
                            v-if="!note.canMove"
                            :id="`historical-move-reason-${note.id}`"
                            class="historical-note-move__reason"
                            data-move-disabled-reason
                            >{{ disabledReason(note) }}</span
                          >
                        </span>
                      </span>
                    </label>
                  </li>
                </ul>
              </section>
            </div>
            <p v-else class="historical-note-move__hint">所选日期范围内没有未完成的历史便签。</p>
            <BaseButton
              v-if="preview.hasMore"
              size="sm"
              class="historical-note-move__load-more"
              variant="text"
              :loading="loadingMore"
              :disabled="moving || resultsUnavailable"
              data-move-load-more
              @click="loadPreview({ append: true })"
              >显示更多（已加载 {{ notes.length }} / {{ preview.count }} 条）</BaseButton
            >
          </template>
        </div>
      </div>
    </div>
    <template #footer>
      <BaseButton
        class="historical-note-move__close"
        variant="text"
        :disabled="moving || settingsSaving"
        @click="open = false"
        >关闭</BaseButton
      >
      <BaseButton
        class="historical-note-move__submit"
        variant="primary"
        :loading="moving"
        :disabled="settingsSaving || resultsUnavailable || selectedCount <= 0"
        data-move-action
        @click="executeMove"
        >将 {{ selectedCount }} 条便签移至今天</BaseButton
      >
    </template>
  </AppModalShell>
</template>

<style scoped>
:global(.app-modal-card:has(> .app-modal-body > .historical-note-move)) {
  --fs-title: clamp(17rem, calc(var(--font-size-base) * 0.94), 21rem);
  --fs-body: clamp(13rem, calc(var(--font-size-base) * 0.74), 17rem);
  --fs-secondary: clamp(11rem, calc(var(--font-size-base) * 0.64), 14rem);
}
.historical-note-move__trigger {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 30rem;
  height: 30rem;
  padding: 5rem;
  border: 0;
  border-radius: 8rem;
  background: transparent;
  color: var(--text-color-secondary);
  font-size: calc(var(--titlebar-icon-size, 14rem) * var(--nav-icon-scale, 1));
  cursor: pointer;
}
.historical-note-move__trigger:hover:not(:disabled) {
  background: var(--ui-fill-hover);
}
.historical-note-move__trigger.is-open {
  color: var(--ui-accent);
}
.historical-note-move__trigger:disabled {
  opacity: 0.35;
  cursor: default;
}
.historical-note-move__trigger:focus-visible {
  outline: 1px solid var(--ui-border-hover);
  outline-offset: 2px;
}
.historical-note-move__icon {
  width: var(--calendar-toolbar-icon-size, 17rem);
  height: var(--calendar-toolbar-icon-size, 17rem);
}
.historical-note-move {
  display: flex;
  flex-direction: column;
  gap: 14rem;
  font-size: var(--fs-body);
}
.historical-note-move p {
  margin: 0;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.historical-note-move__automatic {
  display: flex;
  align-items: center;
  gap: 20rem;
  padding: 2rem 0 16rem;
  border-bottom: 1px solid var(--ui-border-divider);
}
.historical-note-move__automatic > div {
  flex: 1;
  min-width: 0;
}
.historical-note-move__automatic strong {
  font-size: var(--fs-body);
  font-weight: 600;
  line-height: 1.4;
}
.historical-note-move__automatic p,
.historical-note-move__hint {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.historical-note-move__automatic p {
  margin-top: 6rem;
}
.historical-note-move__presets,
.historical-note-move__selection-bar,
.historical-note-move__selection-bar > div {
  display: flex;
  align-items: center;
  gap: 8rem;
  flex-wrap: wrap;
}
.historical-note-move__selection-bar {
  justify-content: space-between;
  gap: 6rem 12rem;
  font-size: var(--fs-secondary);
  font-variant-numeric: tabular-nums;
}
.historical-note-move__presets {
  align-self: flex-start;
  padding: 3rem;
  gap: 3rem;
  border-radius: 8rem;
  background: var(--ui-surface-subtle);
}
.historical-note-move__preset {
  min-height: max(26px, 28rem);
  padding: 4rem 12rem;
  background: transparent;
  font-weight: 500;
}
.historical-note-move__preset:hover:not(:disabled) {
  background: var(--ui-surface-control-hover);
}
.historical-note-move__preset[aria-pressed='true'],
.historical-note-move__preset[aria-pressed='true']:hover:not(:disabled) {
  background: var(--ui-accent-subtle);
  color: var(--ui-accent);
  font-weight: 600;
}
.historical-note-move__summary {
  padding-top: 4rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  font-variant-numeric: tabular-nums;
}
.historical-note-move__summary strong {
  color: var(--text-color);
  font-weight: 600;
}
.historical-note-move__selection-bar > div {
  gap: 2rem;
}
.historical-note-move__results-viewport {
  position: relative;
  min-width: 0;
}
.historical-note-move__results-viewport.is-empty {
  min-height: 84rem;
}
.historical-note-move__results {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12rem;
}
.historical-note-move__results-viewport[data-state='error'] .historical-note-move__results {
  opacity: 0.32;
}
.historical-note-move__feedback {
  position: absolute;
  inset: 0 0 auto;
  z-index: var(--z-local-raised);
  display: flex;
  min-height: 32rem;
  padding: 4rem 8rem;
  flex-wrap: wrap;
  align-content: center;
  align-items: center;
  justify-content: center;
  gap: 8rem;
  border-radius: 8rem;
  background: var(--surface-modal);
  font-size: var(--fs-secondary);
  text-align: center;
}
.historical-note-move__feedback > span {
  max-width: 100%;
  overflow-wrap: anywhere;
}
.historical-note-move__range {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.historical-note-move__range :deep(.drp) {
  min-width: 0;
  max-width: 100%;
}
.historical-note-move__group h3 {
  margin: 0;
  padding: 8rem 0 6rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.historical-note-move__group + .historical-note-move__group {
  border-top: 1px solid var(--ui-border-divider);
  margin-top: 10rem;
  padding-top: 6rem;
}
.historical-note-move__group ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.historical-note-move__note-option {
  display: flex;
  gap: 12rem;
  padding: 10rem 0;
  align-items: flex-start;
}
.historical-note-move__note-option:has(input:not(:disabled)) {
  cursor: pointer;
}
.historical-note-move__note-option input {
  width: 16rem;
  height: 16rem;
  margin: 1rem 0 0;
  flex: 0 0 auto;
  accent-color: var(--ui-accent);
  cursor: pointer;
}
.historical-note-move__note-option input:disabled {
  cursor: default;
}
.historical-note-move__note-option input:focus-visible {
  outline: 1px solid var(--ui-border-hover);
  outline-offset: 2px;
}
.historical-note-move__note-text {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 5rem;
  line-height: 1.5;
}
.historical-note-move__content {
  color: var(--text-color);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.historical-note-move__note-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 2rem 12rem;
  align-items: baseline;
}
.historical-note-move__reason {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  overflow-wrap: anywhere;
}
.historical-note-move__error {
  color: var(--ui-danger);
  display: flex;
  flex-wrap: wrap;
  gap: 8rem;
  align-items: center;
}
.historical-note-move__automatic .historical-note-move__error {
  color: var(--ui-danger);
}
.historical-note-move__load-more {
  align-self: center;
}
.historical-note-move__close,
.historical-note-move__submit {
  min-height: max(28px, 32rem);
  font-size: var(--fs-body);
}
.historical-note-move__submit {
  font-weight: 600;
}
</style>
