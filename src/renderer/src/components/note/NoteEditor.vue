<script setup>
import BaseButton from '../ui/BaseButton.vue'
import { useDraftProtection } from '../../composables/useDraftProtection.js'
import { parseNoteDraftTime, useNoteStateDraft } from '../../composables/useNoteStateDraft.js'
/**
 * NoteEditor.vue — 便签修改草稿。
 * 所有可编辑字段和附件只修改前端草稿，点击保存后统一持久化。
 */
import { ref, watch, computed, onMounted, nextTick } from 'vue'
import DateTimePicker from '../ui/DateTimePicker.vue'
import TagSelector from '../ui/TagSelector.vue'
import ScreenshotPicker from './ScreenshotPicker.vue'
import ReminderChannelPicker from './ReminderChannelPicker.vue'
import AppToggle from '../ui/AppToggle.vue'
import HelpButton from '../ui/HelpButton.vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import ColoredTextEditor from './ColoredTextEditor.vue'
import NoteDurationField from './NoteDurationField.vue'
import NoteStateFields from './NoteStateFields.vue'
import NoteRemarkField from './NoteRemarkField.vue'
import { useMessage } from '../../composables/useMessage.js'
import { MAX_ASSIGNED_TAGS, NOTE_TAG_LIMIT_MESSAGE } from '../../../../shared/tag-rules.js'
import { NOTE_DURATION_KINDS } from '../../../../shared/calendar/calendar-date-rules.js'
import { normalizeNoteTextColorRanges } from '../../../../shared/note-text-color-rules.js'
import { MIN_SCHEDULE_LEAD_TIME_MINUTES } from '../../../../shared/note-scheduling-rules.js'

const props = defineProps({
  note: { type: Object, required: true }
})

const emit = defineEmits(['saved', 'cancel'])
const { showMessage } = useMessage()
const content = ref('')
const remark = ref('')
const contentColorRanges = ref([])
const statusChoice = ref('initialized')
const effectiveAt = ref('')
const finishedAt = ref('')
const durationKind = ref(NOTE_DURATION_KINDS.SINGLE_DAY)
const durationDays = ref(1)
const reminderChannels = ref(0)
const pendingReminderTime = ref('')
const pendingReminderCancelled = ref(false)
const isPinned = ref(false)
const tagIds = ref([])
const saving = ref(false)
const mounted = ref(false)
const imagePickerRef = ref(null)
const draftImageCount = ref(0)
const attachmentsBusy = ref(false)
const attachmentDirty = ref(false)
const initialSnapshot = ref(null)
const initialVersion = ref(null)
const confirmVisible = ref(false)

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatDateTime(timestamp) {
  if (timestamp === null || timestamp === undefined || timestamp === '') return ''
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
    remark: String(note.remark ?? ''),
    contentColorRanges: normalizeNoteTextColorRanges(note.content_color_ranges, note.content || ''),
    status: note.status,
    effectiveAt: formatDateTime(note.effective_at),
    finishedAt: note.status === 'completed' ? formatDateTime(note.finished_at) : '',
    durationKind:
      note.duration_kind ||
      (Number(note.duration_days) > 1
        ? NOTE_DURATION_KINDS.FIXED_DAYS
        : NOTE_DURATION_KINDS.SINGLE_DAY),
    durationDays: Number(note.duration_days) || 1,
    reminderChannels: Number(note.reminder_channels ?? (note.notify_enabled ? 1 : 0)),
    pendingReminderTime: note.pending_reminder ? formatDateTime(note.pending_reminder.due_at) : '',
    pendingReminder: note.pending_reminder ? { ...note.pending_reminder } : null,
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
  remark.value = snapshot.remark
  contentColorRanges.value = snapshot.contentColorRanges.map((range) => ({ ...range }))
  statusChoice.value = snapshot.status
  effectiveAt.value = snapshot.effectiveAt
  finishedAt.value = snapshot.finishedAt
  durationKind.value = snapshot.durationKind
  durationDays.value = snapshot.durationDays
  reminderChannels.value = snapshot.reminderChannels
  pendingReminderTime.value = snapshot.pendingReminderTime
  pendingReminderCancelled.value = false
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

const effectiveTimestamp = computed(() =>
  effectiveAt.value === initialSnapshot.value?.effectiveAt
    ? props.note.effective_at
    : parseNoteDraftTime(effectiveAt.value)
)
const {
  status,
  statusOptions,
  stateHint,
  canScheduleNotification,
  chooseStatus,
  submissionFields
} = useNoteStateDraft({
  effectiveTimestamp,
  statusChoice,
  finishedAt,
  originalNote: () => props.note
})
const canEditNotify = computed(
  () =>
    canScheduleNotification.value ||
    (status.value === 'in_progress' && initialSnapshot.value?.status === 'in_progress')
)
const canEditPendingReminder = computed(
  () => status.value === 'in_progress' && initialSnapshot.value?.status === 'in_progress'
)

function dateAtDefaultScheduleTime(dayOffset) {
  const date = new Date()
  date.setDate(date.getDate() + dayOffset)
  date.setHours(0, 1, 0, 0)
  return date
}

const dateShortcuts = [
  {
    label: '今天',
    getValue: () => new Date()
  },
  { label: '昨天', getValue: () => dateAtDefaultScheduleTime(-1) },
  { label: '一周前', getValue: () => dateAtDefaultScheduleTime(-7) },
  {
    label: '明天',
    getValue: () => {
      const date = new Date()
      date.setDate(date.getDate() + 1)
      return date
    }
  }
]

const scheduleHelp = computed(() => {
  return `可修正生效时间；当前或过去可进行中、已完成，改为未来将转为未开始。新预约需至少晚于当前时间 ${MIN_SCHEDULE_LEAD_TIME_MINUTES} 分钟。`
})

const notifyHelp = computed(() =>
  status.value === 'initialized'
    ? `未来预约可设置生效提醒；新预约至少提前 ${MIN_SCHEDULE_LEAD_TIME_MINUTES} 分钟，已有预约不受剩余时间影响。`
    : '进行中便签可修改后续提醒方式；关闭全部方式会取消待触发提醒。已结束的提醒不会重新触发。'
)
const notifyDisabledReason = computed(() => {
  if (status.value === 'completed') return '已完成便签不再提醒'
  if (status.value === 'initialized') return `新预约至少提前 ${MIN_SCHEDULE_LEAD_TIME_MINUTES} 分钟`
  return '不补发生效提醒；保存为进行中后可另设稍后提醒，原提醒不会恢复。'
})
const missingCompletionTime = computed(
  () =>
    status.value === 'completed' &&
    initialSnapshot.value?.status === 'completed' &&
    !initialSnapshot.value?.finishedAt &&
    !finishedAt.value
)

const hasChanges = computed(() => {
  const initial = initialSnapshot.value
  if (!initial) return false
  return (
    attachmentDirty.value ||
    content.value !== initial.content ||
    remark.value !== initial.remark ||
    JSON.stringify(contentColorRanges.value) !== JSON.stringify(initial.contentColorRanges) ||
    statusChoice.value !== initial.status ||
    effectiveAt.value !== initial.effectiveAt ||
    finishedAt.value !== initial.finishedAt ||
    durationKind.value !== initial.durationKind ||
    durationDays.value !== initial.durationDays ||
    reminderChannels.value !== initial.reminderChannels ||
    pendingReminderTime.value !== initial.pendingReminderTime ||
    pendingReminderCancelled.value ||
    isPinned.value !== initial.isPinned ||
    JSON.stringify(normalizedTags(tagIds.value)) !== JSON.stringify(initial.tagIds)
  )
})
const canSave = computed(() => Boolean(content.value.trim()) || draftImageCount.value > 0)

function onAttachmentDraftChange(changes) {
  attachmentDirty.value = !!changes?.dirty
}

function requestClose() {
  if (saving.value || attachmentsBusy.value) return
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
  if (saving.value || attachmentsBusy.value || !hasChanges.value) return
  const text = content.value
  if (!canSave.value) {
    showMessage('warning', '请输入便签内容或保留至少一张图片')
    return
  }

  if (tagIds.value.length > MAX_ASSIGNED_TAGS) {
    showMessage('warning', NOTE_TAG_LIMIT_MESSAGE)
    return
  }

  let stateFields
  try {
    stateFields = submissionFields({
      effectiveAt:
        effectiveAt.value === initialSnapshot.value?.effectiveAt
          ? undefined
          : effectiveTimestamp.value,
      finishedAt:
        statusChoice.value === initialSnapshot.value?.status &&
        finishedAt.value === initialSnapshot.value?.finishedAt
          ? undefined
          : parseNoteDraftTime(finishedAt.value)
    })
  } catch (error) {
    showMessage('warning', error.message || '请核对状态与时间')
    return
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
        remark: remark.value.replace(/\r\n?/g, '\n'),
        contentColorRanges: normalizeNoteTextColorRanges(contentColorRanges.value, text),
        ...stateFields,
        durationKind: durationKind.value,
        durationDays: durationDays.value,
        reminderChannels: canEditNotify.value ? reminderChannels.value : 0,
        ...(canEditPendingReminder.value &&
        initialSnapshot.value.pendingReminder &&
        (pendingReminderCancelled.value ||
          pendingReminderTime.value !== initialSnapshot.value.pendingReminderTime)
          ? {
              pendingReminder: {
                id: initialSnapshot.value.pendingReminder.id,
                expectedDueAt: initialSnapshot.value.pendingReminder.due_at,
                dueAt: pendingReminderCancelled.value
                  ? null
                  : new Date(pendingReminderTime.value).getTime()
              }
            }
          : {}),
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
    remark,
    contentColorRanges,
    statusChoice,
    effectiveAt,
    finishedAt,
    durationKind,
    durationDays,
    reminderChannels,
    pendingReminderTime,
    pendingReminderCancelled,
    isPinned,
    tagIds,
    initialVersion
  },
  dirty: () => hasChanges.value,
  busy: () => saving.value || attachmentsBusy.value,
  extra: () => ({ attachments: imagePickerRef.value?.getDraftChanges() }),
  restoreExtra: (data) => imagePickerRef.value?.restoreDraft(data.attachments)
})
</script>

<template>
  <div class="ne-root" :class="{ 'ne-enter': mounted }">
    <div class="ne-body scroll-y" :inert="saving">
      <ColoredTextEditor
        v-model="content"
        v-model:color-ranges="contentColorRanges"
        class="ne-stagger"
        initial-focus
        style="animation-delay: 0ms"
        placeholder="输入便签内容…（Enter 换行）"
        :rows="2"
      />

      <NoteRemarkField v-model="remark" class="ne-stagger" style="animation-delay: 35ms" />

      <div class="ne-field-row ne-stagger" style="animation-delay: 70ms">
        <label class="ne-field-label">生效时间<HelpButton :text="scheduleHelp" /></label>
        <DateTimePicker v-model="effectiveAt" placeholder="立即生效" :shortcuts="dateShortcuts" />
      </div>
      <NoteStateFields
        v-model:finished-at="finishedAt"
        class="ne-stagger"
        style="animation-delay: 85ms"
        :status="status"
        :options="statusOptions"
        :hint="stateHint"
        :finished-placeholder="missingCompletionTime ? '请补充完成时间' : '保存时完成'"
        :completion-hint="
          missingCompletionTime
            ? '这条历史记录缺少完成时间，请明确填写后保存；不会自动补为现在。'
            : ''
        "
        @update:status="chooseStatus"
      />

      <NoteDurationField v-model:kind="durationKind" v-model:days="durationDays" visible />

      <div class="ne-notification-field ne-stagger" style="animation-delay: 100ms">
        <ReminderChannelPicker
          v-model="reminderChannels"
          :disabled="!canEditNotify"
          :help-text="notifyHelp"
          :disabled-reason="notifyDisabledReason"
        />
        <div
          v-if="initialSnapshot?.pendingReminder && canEditPendingReminder"
          class="ne-pending-reminder"
        >
          <label class="ne-field-label">下次提醒时间</label>
          <DateTimePicker
            v-model="pendingReminderTime"
            :shortcuts="[]"
            :clearable="false"
            :disabled="pendingReminderCancelled || !reminderChannels"
          />
          <label class="ne-reminder-cancel"
            ><input
              v-model="pendingReminderCancelled"
              type="checkbox"
            />取消这次稍后提醒（保存后生效）</label
          >
        </div>
        <p v-else-if="initialSnapshot?.pendingReminder" class="ne-platform-note">
          保存后将取消原来的稍后提醒。
        </p>
      </div>

      <div class="ne-field-row ne-stagger" style="animation-delay: 130ms">
        <label class="ne-field-label">置顶<HelpButton text="开启后便签将固定在列表顶部。" /></label>
        <AppToggle v-model="isPinned" aria-label="置顶" />
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
          @busy-change="attachmentsBusy = $event"
          @draft-change="onAttachmentDraftChange"
        />
      </div>
    </div>

    <div class="ne-footer ne-stagger" style="animation-delay: 230ms">
      <BaseButton
        class="ne-dismiss"
        :disabled="saving || attachmentsBusy"
        variant="default"
        @click="requestClose"
      >
        {{ hasChanges ? '放弃修改' : '关闭' }}
      </BaseButton>
      <BaseButton
        class="ne-submit"
        data-diagnostic-action="note.save"
        :disabled="!canSave || !hasChanges || saving || attachmentsBusy"
        variant="primary"
        @click="handleSave"
      >
        {{ saving ? '保存中…' : attachmentsBusy ? '图片处理中…' : '保存修改' }}
      </BaseButton>
    </div>

    <ConfirmDialog
      v-model:visible="confirmVisible"
      title="放弃未保存的修改？"
      message="正文、备注、属性、状态和附件草稿都将恢复为打开编辑器时的内容。"
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
.ne-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8rem;
  width: calc(100% - 28rem);
  margin: 0 14rem 14rem;
  flex-shrink: 0;
}
.ne-submit {
  flex: 1 1 104rem;
}
.ne-pending-reminder {
  display: grid;
  gap: 8rem;
  margin-top: 12rem;
}
.ne-reminder-cancel {
  display: flex;
  gap: 6rem;
  align-items: center;
  font-size: var(--fs-secondary);
}
.ne-reminder-cancel input {
  accent-color: var(--ui-accent);
}
.ne-field-row {
  flex-wrap: wrap;
  gap: 6rem;
}
.ne-field-row .ne-field-label {
  max-width: 100%;
}
input,
textarea {
  max-width: 100%;
}
</style>
