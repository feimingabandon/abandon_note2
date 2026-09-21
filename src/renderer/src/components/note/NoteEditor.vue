<script setup>
import { useDraftProtection } from '../../composables/useDraftProtection.js'
/**
 * NoteEditor.vue — 便签修改草稿。
 * 所有可编辑字段和附件只修改前端草稿，点击保存后统一持久化。
 */
import { ref, watch, computed, onMounted, nextTick } from 'vue'
import DateTimePicker from '../ui/DateTimePicker.vue'
import TagSelector from '../ui/TagSelector.vue'
import ScreenshotPicker from './ScreenshotPicker.vue'
import AppToggle from '../ui/AppToggle.vue'
import HelpButton from '../ui/HelpButton.vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import ColoredTextEditor from './ColoredTextEditor.vue'
import NoteDurationField from './NoteDurationField.vue'
import { useMessage } from '../../composables/useMessage.js'
import { MAX_ASSIGNED_TAGS, NOTE_TAG_LIMIT_MESSAGE } from '../../../../shared/tag-rules.js'
import { NOTE_DURATION_KINDS } from '../../../../shared/calendar/calendar-date-rules.js'
import { normalizeNoteTextColorRanges } from '../../../../shared/note-text-color-rules.js'
import {
  assertCreatableNoteEffectiveTime,
  canScheduleNoteNotification,
  createSafeScheduleShortcutTimestamp,
  MIN_SCHEDULE_LEAD_TIME_MINUTES
} from '../../../../shared/note-scheduling-rules.js'

const props = defineProps({
  note: { type: Object, required: true }
})

const emit = defineEmits(['saved', 'cancel'])
const { showMessage } = useMessage()
const systemNotificationCapability = window.api.runtimeCapabilities?.systemNotifications || {
  supported: true,
  reason: ''
}
const systemNotificationsSupported = systemNotificationCapability.supported
const systemNotificationUnavailableReason = systemNotificationCapability.reason

const content = ref('')
const contentColorRanges = ref([])
const status = ref('initialized')
const effectiveAt = ref('')
const durationKind = ref(NOTE_DURATION_KINDS.SINGLE_DAY)
const durationDays = ref(1)
const notifyEnabled = ref(false)
const isPinned = ref(false)
const tagIds = ref([])
const saving = ref(false)
const mounted = ref(false)
const imagePickerRef = ref(null)
const draftImageCount = ref(0)
const attachmentDirty = ref(false)
const initialSnapshot = ref(null)
const initialVersion = ref(null)
const confirmVisible = ref(false)

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatDateTime(timestamp) {
  const date = new Date(Number(timestamp))
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function normalizedTags(tags) {
  return [...tags].map(Number).sort((a, b) => a - b)
}

function createSnapshot(note) {
  return {
    content: note.content || '',
    contentColorRanges: normalizeNoteTextColorRanges(note.content_color_ranges, note.content || ''),
    status: note.status,
    effectiveAt: formatDateTime(note.effective_at),
    durationKind:
      note.duration_kind ||
      (Number(note.duration_days) > 1
        ? NOTE_DURATION_KINDS.FIXED_DAYS
        : NOTE_DURATION_KINDS.SINGLE_DAY),
    durationDays: Number(note.duration_days) || 1,
    notifyEnabled: systemNotificationsSupported && !!note.notify_enabled,
    isPinned: !!note.is_pinned,
    tagIds: normalizedTags(note.tags?.map((tag) => tag.id) || [])
  }
}

function resetFromNote(note) {
  if (!note) return
  const snapshot = createSnapshot(note)
  initialSnapshot.value = snapshot
  initialVersion.value = note.editVersion
  content.value = snapshot.content
  contentColorRanges.value = snapshot.contentColorRanges.map((range) => ({ ...range }))
  status.value = snapshot.status
  effectiveAt.value = snapshot.effectiveAt
  durationKind.value = snapshot.durationKind
  durationDays.value = snapshot.durationDays
  notifyEnabled.value = snapshot.notifyEnabled
  isPinned.value = snapshot.isPinned
  tagIds.value = [...snapshot.tagIds]
  attachmentDirty.value = false
  draftImageCount.value = Number(note.attachment_count) || 0
}

watch(() => props.note, resetFromNote, { immediate: true })

onMounted(async () => {
  await nextTick()
  requestAnimationFrame(() => {
    mounted.value = true
  })
})

const statusLabel = computed(
  () =>
    ({
      initialized: '待开始',
      in_progress: '进行中',
      completed: '已完成'
    })[status.value] || status.value
)

const canEditSchedule = computed(() => ['initialized', 'in_progress'].includes(status.value))
const effectiveTimestamp = computed(() => new Date(effectiveAt.value).getTime())
const isHistoricalSchedule = computed(
  () => Number.isFinite(effectiveTimestamp.value) && effectiveTimestamp.value <= Date.now()
)
const canEditNotify = computed(
  () =>
    status.value === 'initialized' &&
    systemNotificationsSupported &&
    canScheduleNoteNotification(effectiveTimestamp.value, Date.now())
)

function dateAtDefaultScheduleTime(dayOffset) {
  const date = new Date()
  date.setDate(date.getDate() + dayOffset)
  date.setHours(0, 1, 0, 0)
  return date
}

const initializedDateShortcuts = [
  {
    label: '今天',
    getValue: () => new Date(createSafeScheduleShortcutTimestamp())
  },
  { label: '昨天', getValue: () => dateAtDefaultScheduleTime(-1) },
  {
    label: '明天',
    getValue: () => {
      const date = new Date()
      date.setDate(date.getDate() + 1)
      return date
    }
  }
]
const inProgressDateShortcuts = [
  { label: '今天', getValue: () => new Date() },
  { label: '昨天', getValue: () => dateAtDefaultScheduleTime(-1) },
  { label: '一周前', getValue: () => dateAtDefaultScheduleTime(-7) }
]
const dateShortcuts = computed(() =>
  status.value === 'in_progress' ? inProgressDateShortcuts : initializedDateShortcuts
)

const scheduleHelp = computed(() => {
  if (status.value === 'initialized')
    return `可改为过去时间进行历史补录；未来预约需至少晚于当前时间 ${MIN_SCHEDULE_LEAD_TIME_MINUTES} 分钟。`
  if (status.value === 'in_progress') return '可修正为当前或过去时间，不能改为未来预约。'
  return '已完成便签的生效时间不可修改。'
})

const notifyHelp = computed(() => {
  if (!systemNotificationsSupported) return systemNotificationUnavailableReason
  if (status.value === 'initialized')
    return `仅未来至少 ${MIN_SCHEDULE_LEAD_TIME_MINUTES} 分钟的预约可以修改系统提醒设置。`
  return '进行中或已完成便签不发送待生效提醒。'
})

watch([effectiveAt, status], () => {
  if (!canEditNotify.value && notifyEnabled.value) notifyEnabled.value = false
})

const hasChanges = computed(() => {
  const initial = initialSnapshot.value
  if (!initial) return false
  return (
    attachmentDirty.value ||
    content.value !== initial.content ||
    JSON.stringify(contentColorRanges.value) !== JSON.stringify(initial.contentColorRanges) ||
    status.value !== initial.status ||
    effectiveAt.value !== initial.effectiveAt ||
    durationKind.value !== initial.durationKind ||
    durationDays.value !== initial.durationDays ||
    notifyEnabled.value !== initial.notifyEnabled ||
    isPinned.value !== initial.isPinned ||
    JSON.stringify(normalizedTags(tagIds.value)) !== JSON.stringify(initial.tagIds)
  )
})
const canSave = computed(() => Boolean(content.value.trim()) || draftImageCount.value > 0)

function onAttachmentDraftChange(changes) {
  attachmentDirty.value = !!changes?.dirty
}

function requestClose() {
  if (saving.value) return
  if (!hasChanges.value) {
    emit('cancel')
    return
  }
  confirmVisible.value = true
}

function handleConfirm() {
  protectedDraft.clear()
  emit('cancel')
}

async function handleSave() {
  if (saving.value || !hasChanges.value) return
  const text = content.value
  if (!canSave.value) {
    showMessage('warning', '请输入便签内容或保留至少一张图片')
    return
  }

  if (tagIds.value.length > MAX_ASSIGNED_TAGS) {
    showMessage('warning', NOTE_TAG_LIMIT_MESSAGE)
    return
  }

  const requestedEffectiveAt = effectiveTimestamp.value
  if (canEditSchedule.value) {
    if (!Number.isFinite(requestedEffectiveAt)) {
      showMessage('warning', '请选择有效的生效时间')
      return
    }
    const effectiveAtChanged = effectiveAt.value !== initialSnapshot.value?.effectiveAt
    if (effectiveAtChanged && status.value === 'initialized') {
      try {
        assertCreatableNoteEffectiveTime(requestedEffectiveAt, Date.now())
      } catch (error) {
        showMessage('warning', error.message || '请选择有效的生效时间')
        return
      }
    }
    if (effectiveAtChanged && status.value === 'in_progress' && requestedEffectiveAt > Date.now()) {
      showMessage('warning', '进行中便签的生效时间只能修正为当前或过去时间')
      return
    }
  }

  saving.value = true
  try {
    const attachmentChanges = imagePickerRef.value?.getDraftChanges() || {
      addedImages: [],
      deletedImageIds: []
    }
    const updated = await window.api.saveNoteDraft({
      id: props.note.id,
      expectedVersion: initialVersion.value,
      fields: {
        content: text,
        contentColorRanges: contentColorRanges.value,
        status: status.value,
        effectiveAt: requestedEffectiveAt,
        durationKind: durationKind.value,
        durationDays: durationDays.value,
        notifyEnabled: canEditNotify.value && notifyEnabled.value,
        isPinned: isPinned.value
      },
      tagIds: [...tagIds.value],
      ...attachmentChanges
    })
    showMessage('success', '便签已保存')
    protectedDraft.clear()
    emit('saved', updated)
  } catch (error) {
    console.error('[NoteEditor] 保存失败:', error)
    showMessage('error', error.message || '保存失败，请重试')
  } finally {
    saving.value = false
  }
}

defineExpose({ requestClose })
const protectedDraft = useDraftProtection({
  key: 'note:' + props.note.id,
  fields: {
    content,
    contentColorRanges,
    status,
    effectiveAt,
    durationKind,
    durationDays,
    notifyEnabled,
    isPinned,
    tagIds,
    initialVersion
  },
  dirty: () => hasChanges.value,
  busy: () => saving.value,
  extra: () => ({ attachments: imagePickerRef.value?.getDraftChanges() }),
  restoreExtra: (data) => imagePickerRef.value?.restoreDraft(data.attachments)
})
</script>

<template>
  <div class="ne-root" :class="{ 'ne-enter': mounted }">
    <div class="ne-body scroll-y">
      <ColoredTextEditor
        v-model="content"
        v-model:color-ranges="contentColorRanges"
        class="ne-stagger"
        initial-focus
        style="animation-delay: 0ms"
        placeholder="输入便签内容…（Enter 换行）"
        :rows="4"
      />

      <div class="ne-field-row ne-stagger" style="animation-delay: 40ms">
        <label class="ne-field-label">状态</label>
        <span class="ne-status-tag" :class="'ne-status--' + status">{{ statusLabel }}</span>
      </div>

      <div class="ne-field-row ne-stagger" style="animation-delay: 70ms">
        <label class="ne-field-label">生效时间<HelpButton :text="scheduleHelp" /></label>
        <DateTimePicker
          v-model="effectiveAt"
          :disabled="!canEditSchedule"
          :clearable="false"
          :shortcuts="dateShortcuts"
        />
      </div>
      <p
        v-if="status === 'initialized' && isHistoricalSchedule"
        class="ne-platform-note ne-schedule-note"
      >
        保存后将直接进入进行中，并关闭系统提醒。
      </p>

      <NoteDurationField
        v-model:kind="durationKind"
        v-model:days="durationDays"
        :visible="!!effectiveAt"
      />

      <div class="ne-notification-field ne-stagger" style="animation-delay: 100ms">
        <div class="ne-field-row">
          <label class="ne-field-label">系统提醒<HelpButton :text="notifyHelp" /></label>
          <AppToggle v-model="notifyEnabled" :disabled="!canEditNotify" />
        </div>
        <p v-if="!systemNotificationsSupported" class="ne-platform-note">
          {{ systemNotificationUnavailableReason }}
        </p>
      </div>

      <div class="ne-field-row ne-stagger" style="animation-delay: 130ms">
        <label class="ne-field-label">置顶<HelpButton text="开启后便签将固定在列表顶部。" /></label>
        <AppToggle v-model="isPinned" />
      </div>

      <div class="ne-field ne-group-gap ne-stagger" style="animation-delay: 160ms">
        <label class="ne-field-label"
          >标签<HelpButton text="每条便签最多保留一个分类标签；历史多标签需删减后才能保存。"
        /></label>
        <TagSelector
          v-model="tagIds"
          :max-selected="MAX_ASSIGNED_TAGS"
          @selection-limit-exceeded="showMessage('warning', NOTE_TAG_LIMIT_MESSAGE)"
        />
      </div>

      <div class="ne-field ne-stagger" style="animation-delay: 190ms">
        <label class="ne-field-label"
          >附件<HelpButton text="附件修改会保存在草稿中，点击保存修改后才会写入数据库和附件目录。"
        /></label>
        <ScreenshotPicker
          ref="imagePickerRef"
          :note-id="note.id"
          mode="draft"
          @count-change="draftImageCount = $event"
          @draft-change="onAttachmentDraftChange"
        />
      </div>
    </div>

    <div class="ne-footer ne-stagger" style="animation-delay: 230ms">
      <button class="ne-dismiss" :disabled="saving" @click="requestClose">
        {{ hasChanges ? '放弃修改' : '关闭' }}
      </button>
      <button class="ne-submit" :disabled="!canSave || !hasChanges || saving" @click="handleSave">
        {{ saving ? '保存中…' : '保存修改' }}
      </button>
    </div>

    <ConfirmDialog
      v-model:visible="confirmVisible"
      title="放弃未保存的修改？"
      message="正文、属性、状态和附件草稿都将恢复为打开编辑器时的内容。"
      confirm-text="放弃修改"
      cancel-text="继续编辑"
      variant="danger"
      @confirm="handleConfirm"
    />
  </div>
</template>

<style scoped>
.ne-root {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.ne-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
  padding: 14rem 14rem 16rem;
  -webkit-mask-image: linear-gradient(
    to bottom,
    black 0%,
    black calc(100% - 30rem),
    transparent 100%
  );
  mask-image: linear-gradient(to bottom, black 0%, black calc(100% - 30rem), transparent 100%);
}
.ne-stagger {
  opacity: 0;
}
.ne-enter .ne-stagger {
  animation: ne-fade-up 250ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes ne-fade-up {
  from {
    opacity: 0;
    transform: translateY(6rem);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.ne-field-row {
  margin-top: 12rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
}
.ne-field-row .ne-field-label {
  flex-shrink: 0;
}
.ne-notification-field {
  display: flex;
  flex-direction: column;
  gap: 5rem;
}
.ne-platform-note {
  margin: 0;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  line-height: 1.5;
  opacity: 0.72;
}
.ne-schedule-note {
  margin-top: 5rem;
  text-align: right;
}
.ne-field {
  margin-top: 12rem;
  display: flex;
  flex-direction: column;
  gap: 6rem;
  min-width: 0;
}
.ne-field-label {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  font-weight: 500;
}
.ne-group-gap {
  margin-top: 20rem;
}
.ne-status-tag {
  display: inline-flex;
  align-items: center;
  padding: 3rem 9rem;
  border-radius: 6rem;
  background: color-mix(in srgb, currentColor 10%, transparent);
  font-size: var(--fs-secondary);
  font-weight: 600;
  white-space: nowrap;
}
.ne-status--initialized {
  color: #007aff;
}
.ne-status--in_progress {
  color: #ff9500;
}
.ne-status--completed {
  color: #34c759;
}
.ne-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8rem;
  width: calc(100% - 28rem);
  margin: 0 14rem 14rem;
  flex-shrink: 0;
}
.ne-dismiss,
.ne-submit {
  padding: 10rem 16rem;
  border: 0;
  border-radius: 8rem;
  font-family: inherit;
  font-size: var(--fs-body);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color 150ms ease,
    color 150ms ease,
    transform 70ms ease;
}
.ne-dismiss {
  background: color-mix(in srgb, var(--text-color) 8%, transparent);
  color: var(--text-color-secondary);
}
.ne-dismiss:hover:not(:disabled) {
  background: var(--ui-fill-hover);
  color: var(--text-color);
}
.ne-submit {
  flex: 1;
  min-width: 104rem;
  background: var(--ui-primary);
  color: var(--ui-on-primary);
}
.ne-submit:hover:not(:disabled) {
  background: var(--ui-primary-hover);
}
.ne-dismiss:active:not(:disabled),
.ne-submit:active:not(:disabled) {
  transform: scale(0.98);
}
.ne-dismiss:disabled,
.ne-submit:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
