<script setup>
import BaseButton from '../ui/BaseButton.vue'
import { useDraftProtection } from '../../composables/useDraftProtection.js'
import { useNewNotePreferences } from '../../composables/useNewNotePreferences.js'
import { useNoteStateDraft } from '../../composables/useNoteStateDraft.js'
/**
 * NewNotePanel.vue — 新建便签表单面板
 *
 * 职责：
 *   1. 收集用户输入的表单字段（正文/备注/标签/生效时间/图片/通知/置顶）
 *   2. 调用 window.api.createNote 创建便签
 *   3. 创建成功后重置表单并 emit('create') 通知父组件
 *
 * 不负责：面板标题栏、面板高度拖拽（由 ActionBar 统一管理）
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import DateTimePicker from '../ui/DateTimePicker.vue'
import TagSelector from '../ui/TagSelector.vue'
import ScreenshotPicker from '../note/ScreenshotPicker.vue'
import NoteDurationField from '../note/NoteDurationField.vue'
import NoteStateFields from '../note/NoteStateFields.vue'
import NoteRemarkField from '../note/NoteRemarkField.vue'
import ReminderChannelPicker from '../note/ReminderChannelPicker.vue'
import AppToggle from '../ui/AppToggle.vue'
import HelpButton from '../ui/HelpButton.vue'
import ColoredTextEditor from '../note/ColoredTextEditor.vue'
import { useMessage } from '../../composables/useMessage.js'
import { MAX_ASSIGNED_TAGS, NOTE_TAG_LIMIT_MESSAGE } from '../../../../shared/tag-rules.js'
import { normalizeNoteTextColorRanges } from '../../../../shared/note-text-color-rules.js'
import {
  DEFAULT_NEW_NOTE_SCHEDULE_TIME,
  MIN_SCHEDULE_LEAD_TIME_MINUTES
} from '../../../../shared/note-scheduling-rules.js'

const emit = defineEmits(['create'])
const props = defineProps({
  draftKey: { type: String, default: 'new:list' },
  active: { type: Boolean, default: false }
})

const { showMessage } = useMessage()
// ============================================================
// 入场动效：按一级 DOM 顺序自动编排，组件常驻以保留草稿。
// ============================================================
const entranceBodyRef = ref(null)
const submitRef = ref(null)
const textareaRef = ref(null)
const ENTER_DURATION = 250
const ENTER_TOTAL_WINDOW = 520
let enterRaf = null
let entranceSeq = 0
let entranceAnimations = []

function entranceItems() {
  const bodyItems = entranceBodyRef.value ? Array.from(entranceBodyRef.value.children) : []
  return submitRef.value?.$el ? [...bodyItems, submitRef.value?.$el] : bodyItems
}

function focusTextareaAtTop() {
  if (entranceBodyRef.value) entranceBodyRef.value.scrollTop = 0
  textareaRef.value?.focus({ preventScroll: true })
}

function cancelEntranceAnimations() {
  entranceSeq++
  if (enterRaf) cancelAnimationFrame(enterRaf)
  enterRaf = null
  for (const animation of entranceAnimations) animation.cancel()
  entranceAnimations = []
  for (const element of entranceItems()) {
    element.style.removeProperty('opacity')
    element.style.removeProperty('filter')
    element.style.removeProperty('translate')
  }
}

async function replayEntrance() {
  cancelEntranceAnimations()
  const seq = entranceSeq
  await nextTick()
  if (!props.active || seq !== entranceSeq) return
  if (entranceBodyRef.value) entranceBodyRef.value.scrollTop = 0

  const items = entranceItems()
  const step = items.length > 1 ? (ENTER_TOTAL_WINDOW - ENTER_DURATION) / (items.length - 1) : 0
  for (const element of items) {
    if (element === submitRef.value?.$el) element.style.filter = 'opacity(0)'
    else element.style.opacity = '0'
    element.style.translate = '0 6px'
  }

  enterRaf = requestAnimationFrame(() => {
    enterRaf = null
    if (!props.active || seq !== entranceSeq) return
    entranceAnimations = items.map((element, index) => {
      const keyframes =
        element === submitRef.value?.$el
          ? [
              { filter: 'opacity(0)', translate: '0 6px' },
              { filter: 'opacity(1)', translate: '0 0' }
            ]
          : [
              { opacity: 0, translate: '0 6px' },
              { opacity: 1, translate: '0 0' }
            ]
      return element.animate(keyframes, {
        duration: ENTER_DURATION,
        delay: index * step,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'both'
      })
    })
    focusTextareaAtTop()

    Promise.allSettled(entranceAnimations.map((animation) => animation.finished)).then(() => {
      if (seq !== entranceSeq) return
      for (const element of items) {
        element.style.removeProperty('opacity')
        element.style.removeProperty('filter')
        element.style.removeProperty('translate')
      }
      for (const animation of entranceAnimations) animation.cancel()
      entranceAnimations = []
    })
  })
}

watch(
  () => props.active,
  (active) => {
    if (active) replayEntrance()
    else cancelEntranceAnimations()
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  cancelEntranceAnimations()
})

// ============================================================
// 表单状态
// ============================================================
const content = ref('')
const remark = ref('')
const contentColorRanges = ref([])
const effectiveAt = ref('') // "YYYY-MM-DD HH:mm:ss" 或空（空 = 立即生效）
const { durationKind, durationDays, tagIds, reminderChannels, isPinned, statusChoice } =
  useNewNotePreferences()
const finishedAt = ref('') // 空值始终表示本次保存时完成，而不是上次完成的时间戳。
const cleanEffectiveAt = ref('')
const cleanFinishedAt = ref('')
const submitState = ref('idle') // idle | creating
/** ScreenshotPicker 组件引用 */
const imagePickerRef = ref(null)
const draftImageCount = ref(0)
const attachmentsBusy = ref(false)

// ---- 联动逻辑 ----
const effectiveTimestamp = computed(() =>
  effectiveAt.value ? new Date(effectiveAt.value).getTime() : null
)
const isHistoricalBackfill = computed(
  () => Number.isFinite(effectiveTimestamp.value) && effectiveTimestamp.value <= currentTime.value
)
const {
  status,
  statusOptions,
  currentTime,
  stateHint,
  canScheduleNotification: canEnableNotify,
  chooseStatus,
  submissionFields
} = useNoteStateDraft({ effectiveTimestamp, statusChoice, finishedAt })
const canCreate = computed(() => Boolean(content.value.trim()) || draftImageCount.value > 0)
const submitLabel = computed(() => {
  if (submitState.value === 'creating') return '创建中…'
  if (attachmentsBusy.value) return '图片处理中…'
  return '创建便签'
})
const submitEmpty = computed(() => submitState.value === 'idle' && !canCreate.value)

function dateAtDefaultScheduleTime(dayOffset = 0) {
  const date = new Date()
  date.setDate(date.getDate() + dayOffset)
  date.setHours(0, 1, 0, 0)
  return date
}

/** 历史补录和未来预约共用快捷选项，时间统一为当天 00:01。 */
const dateShortcuts = [
  { label: '昨天', getValue: () => dateAtDefaultScheduleTime(-1) },
  { label: '一周前', getValue: () => dateAtDefaultScheduleTime(-7) },
  { label: '明天', getValue: () => dateAtDefaultScheduleTime(1) }
]

// An unavailable reminder is disabled for this note, without erasing the user's
// selection for the next scheduled note. The payload below still enforces this.

// ============================================================
// 创建便签
// ============================================================
function resetForm() {
  content.value = ''
  remark.value = ''
  contentColorRanges.value = []
  // Explicit times belong to this continuous entry session. "Immediately" and
  // "complete on save" remain empty intentions, resolved anew on each submit.
  cleanEffectiveAt.value = effectiveAt.value
  cleanFinishedAt.value = finishedAt.value
  imagePickerRef.value?.clearImages()
}

async function handleCreate() {
  if (attachmentsBusy.value) return
  const text = content.value

  if (!canCreate.value) {
    showMessage('warning', '请输入便签内容或添加图片')
    return
  }

  if (tagIds.value.length > MAX_ASSIGNED_TAGS) {
    showMessage('warning', NOTE_TAG_LIMIT_MESSAGE)
    return
  }

  let stateFields
  try {
    stateFields = submissionFields()
  } catch (error) {
    showMessage('warning', error.message || '请核对状态与时间')
    return
  }
  const historicalBackfill = isHistoricalBackfill.value

  if (submitState.value !== 'idle') return
  submitState.value = 'creating'

  try {
    const options = {
      content: text,
      remark: remark.value.replace(/\r\n?/g, '\n'),
      contentColorRanges: normalizeNoteTextColorRanges(contentColorRanges.value, text),
      durationKind: durationKind.value,
      durationDays: durationDays.value,
      reminderChannels: canEnableNotify.value ? reminderChannels.value : 0,
      isPinned: isPinned.value ? 1 : 0
    }
    Object.assign(options, stateFields)
    const imgs = imagePickerRef.value?.getImages() || []
    // 检查 API 是否存在
    if (typeof window.api.createNoteWithAssets !== 'function') {
      throw new Error('接口未就绪，请完全重启应用（npm run dev）')
    }

    const created = await window.api.createNoteWithAssets({
      options,
      images: imgs,
      tagIds: [...tagIds.value]
    })
    if (!created?.id) throw new Error('创建接口未返回便签')

    protectedDraft.clear()
    resetForm()
    protectedDraft.resume()
    submitState.value = 'idle'
    emit('create')
    showMessage(
      'success',
      historicalBackfill ? '历史便签补录成功，已按生效日期归档' : '便签创建成功'
    )
    await nextTick()
    if (props.active)
      requestAnimationFrame(() => {
        if (props.active && submitState.value === 'idle') focusTextareaAtTop()
      })
  } catch (e) {
    console.error('[NewNotePanel] 创建便签失败:', e)
    showMessage('error', e.message || '创建失败，请重试')
    submitState.value = 'idle'
  } finally {
    if (submitState.value === 'creating') submitState.value = 'idle'
  }
}
const protectedDraft = useDraftProtection({
  key: props.draftKey,
  fields: {
    content,
    remark,
    contentColorRanges,
    effectiveAt,
    statusChoice,
    finishedAt,
    cleanEffectiveAt,
    cleanFinishedAt,
    durationKind,
    durationDays,
    reminderChannels,
    isPinned,
    tagIds
  },
  dirty: () =>
    !!content.value ||
    !!remark.value ||
    effectiveAt.value !== cleanEffectiveAt.value ||
    finishedAt.value !== cleanFinishedAt.value ||
    (imagePickerRef.value?.getImages().length || 0) > 0,
  busy: () => submitState.value === 'creating' || attachmentsBusy.value,
  extra: () => ({ attachments: imagePickerRef.value?.getDraftChanges() }),
  restoreExtra: (data) => imagePickerRef.value?.restoreDraft(data.attachments)
})
defineExpose({
  addCapture: (asset) => imagePickerRef.value?.addCapture(asset),
  draftState: () => protectedDraft.flush(),
  discard: () => protectedDraft.clear()
})
</script>

<template>
  <div class="nnp-root">
    <!-- 可滚动表单区域 -->
    <div ref="entranceBodyRef" class="nnp-body scroll-y" :inert="submitState !== 'idle'">
      <!-- 便签内容 -->
      <ColoredTextEditor
        ref="textareaRef"
        v-model="content"
        v-model:color-ranges="contentColorRanges"
        placeholder="请新建一次性便签内容…（Enter 换行）"
        :rows="2"
      />

      <NoteRemarkField v-model="remark" />

      <!-- 生效时间（label 左，picker 右） -->
      <div class="nnp-field-row">
        <label class="nnp-field-label"
          >生效时间<HelpButton text="设置后便签将在指定时间生效。未设置则立即生效。"
        /></label>
        <DateTimePicker
          v-model="effectiveAt"
          placeholder="立即生效"
          :shortcuts="dateShortcuts"
          :default-time="`${DEFAULT_NEW_NOTE_SCHEDULE_TIME}:00`"
        />
      </div>
      <NoteStateFields
        v-model:finished-at="finishedAt"
        :status="status"
        :options="statusOptions"
        :hint="stateHint"
        @update:status="chooseStatus"
      />

      <NoteDurationField v-model:kind="durationKind" v-model:days="durationDays" visible />

      <div class="nnp-notification-field">
        <ReminderChannelPicker
          v-model="reminderChannels"
          :disabled="!canEnableNotify"
          :help-text="`仅未来至少 ${MIN_SCHEDULE_LEAD_TIME_MINUTES} 分钟的预约可开启；稍后提醒不会改变生效时间。`"
          :disabled-reason="
            status === 'completed'
              ? '已完成便签不再提醒'
              : status === 'initialized'
                ? `新预约至少提前 ${MIN_SCHEDULE_LEAD_TIME_MINUTES} 分钟`
                : '设置未来生效时间后可选择生效提醒'
          "
        />
      </div>

      <!-- 置顶 -->
      <div class="nnp-field-row">
        <label class="nnp-field-label"
          >置顶<HelpButton text="开启后便签将固定在列表顶部，不受排序方式影响"
        /></label>
        <AppToggle v-model="isPinned" aria-label="置顶" />
      </div>

      <!-- 标签 -->
      <div class="nnp-field nnp-group-gap">
        <label class="nnp-field-label"
          >标签<HelpButton text="每条便签最多设置一个分类标签；正文和图片类型由系统自动识别。"
        /></label>
        <TagSelector
          v-model="tagIds"
          :max-selected="MAX_ASSIGNED_TAGS"
          @selection-limit-exceeded="showMessage('warning', NOTE_TAG_LIMIT_MESSAGE)"
        />
      </div>

      <!-- 图片 -->
      <div class="nnp-field">
        <label class="nnp-field-label"
          >图片<HelpButton
            text="支持截图、拖拽或点击上传图片附件。单张最大 50MB，单条便签最多 50 张"
        /></label>
        <ScreenshotPicker
          ref="imagePickerRef"
          mode="memory"
          @count-change="draftImageCount = $event"
          @busy-change="attachmentsBusy = $event"
        />
      </div>
    </div>

    <!-- 创建按钮（始终可见，不受面板内容滚动和底部渐隐影响） -->
    <BaseButton
      ref="submitRef"
      class="nnp-submit"
      :class="{
        'is-empty': submitEmpty,
        'is-creating': submitState === 'creating'
      }"
      :disabled="submitState !== 'idle' || attachmentsBusy || !canCreate"
      data-diagnostic-action="note.create"
      variant="primary"
      @click="handleCreate"
    >
      <Transition name="nnp-submit-label">
        <span :key="submitState" class="nnp-submit-label">{{ submitLabel }}</span>
      </Transition>
    </BaseButton>
  </div>
</template>

<style scoped>
/* === 根容器：填充父级剩余空间，内部为 flex 列布局 === */
.nnp-root {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

/* === 可滚动表单体 === */
.nnp-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow-x: hidden;
  padding: 0 14rem;
  padding-bottom: 16rem;
  -webkit-mask-image: linear-gradient(
    to bottom,
    black 0%,
    black calc(100% - 30rem),
    transparent 100%
  );
  mask-image: linear-gradient(to bottom, black 0%, black calc(100% - 30rem), transparent 100%);
}

/* === 表单字段 === */
.nnp-field {
  margin-top: 12rem;
  display: flex;
  flex-direction: column;
  gap: 6rem;
  min-width: 0;
}
.nnp-field-label {
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
  font-weight: 500;
}

/* === 行内字段：label 左 + 组件右，space-between（生效时间 / 开关） === */
.nnp-field-row {
  margin-top: 12rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
}
.nnp-field-row .nnp-field-label {
  flex-shrink: 0;
  max-width: 100%;
}
.nnp-notification-field {
  margin-top: 12rem;
}
.nnp-platform-note {
  margin: 0;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  line-height: 1.5;
  opacity: 0.72;
}

/* === 行内字段：label + 组件，组件填满右侧（标签） === */
.nnp-field-inline {
  margin-top: 12rem;
  display: flex;
  align-items: center;
  gap: 10rem;
  min-width: 0;
}
.nnp-field-inline .nnp-field-label {
  flex-shrink: 0;
  white-space: nowrap;
}
.nnp-field-inline > :last-child {
  flex: 1;
  min-width: 0;
}

/* === 视觉分组间距 === */
.nnp-group-gap {
  margin-top: 20rem;
}

/* === 创建按钮 === */
.nnp-submit {
  position: relative;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: calc(100% - 28rem);
  margin: 0 14rem;
}
.nnp-submit.is-empty {
  opacity: 0.4;
  transform: scale(0.99);
}
.nnp-submit-label {
  grid-area: 1 / 1;
}
.nnp-submit-label-enter-active,
.nnp-submit-label-leave-active {
  transition:
    opacity 120ms ease,
    translate 150ms var(--ease-standard);
}
.nnp-submit-label-enter-from {
  opacity: 0;
  translate: 0 2rem;
}
.nnp-submit-label-leave-to {
  opacity: 0;
  translate: 0 -2rem;
}

.nnp-field-row,
.nnp-field-inline {
  flex-wrap: wrap;
  gap: 6rem;
}
input,
textarea {
  max-width: 100%;
}
</style>
