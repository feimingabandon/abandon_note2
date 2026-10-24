<script setup>
import BaseButton from '../ui/BaseButton.vue'
import { editingDataGeneration, useDraftProtection } from '../../composables/useDraftProtection.js'
import { useNewNotePreferences } from '../../composables/useNewNotePreferences.js'
import { useNoteStateDraft } from '../../composables/useNoteStateDraft.js'
import { computed, onBeforeUnmount, ref } from 'vue'
import ColoredTextEditor from '../note/ColoredTextEditor.vue'
import TimePicker from '../ui/TimePicker.vue'
import ReminderChannelPicker from '../note/ReminderChannelPicker.vue'
import AppToggle from '../ui/AppToggle.vue'
import TagSelector from '../ui/TagSelector.vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import NoteDurationField from '../note/NoteDurationField.vue'
import NoteStateFields from '../note/NoteStateFields.vue'
import NoteRemarkField from '../note/NoteRemarkField.vue'
import ScreenshotPicker from '../note/ScreenshotPicker.vue'
import HelpButton from '../ui/HelpButton.vue'
import { useMessage } from '../../composables/useMessage.js'
import {
  combineLocalDateAndTime,
  localDateKey
} from '../../../../shared/calendar/calendar-date-rules.js'
import { MAX_ASSIGNED_TAGS, NOTE_TAG_LIMIT_MESSAGE } from '../../../../shared/tag-rules.js'
import { normalizeNoteTextColorRanges } from '../../../../shared/note-text-color-rules.js'
import {
  defaultMonthNoteEffectiveTime,
  MIN_SCHEDULE_LEAD_TIME_MINUTES
} from '../../../../shared/note-scheduling-rules.js'

const props = defineProps({
  dateKey: { type: String, required: true },
  viewLabel: { type: String, default: '月视图' }
})
const emit = defineEmits(['created', 'close'])
const { showMessage } = useMessage()
const now = new Date()
const initialTodayKey = localDateKey(now)
const initialTime = defaultMonthNoteEffectiveTime(props.dateKey, initialTodayKey, now)
// The entry date decides this intention once. Midnight must not convert a
// future appointment to immediate, or turn an immediate draft into backfill.
const immediateIntent = ref(props.dateKey === initialTodayKey)
const content = ref('')
const remark = ref('')
const contentColorRanges = ref([])
const time = ref(initialTime)
const timeDirty = ref(false)
const { durationKind, durationDays, reminderChannels, isPinned, tagIds, statusChoice } =
  useNewNotePreferences()
const finishedAt = ref('')
const imagePickerRef = ref(null)
const draftImageCount = ref(0)
const attachmentsBusy = ref(false)
const saving = ref(false)
const querying = ref(false)
const discardVisible = ref(false)
let disposed = false
const dataGeneration = editingDataGeneration.value
const currentDraft = () => !disposed && dataGeneration === editingDataGeneration.value
const dateLabel = computed(() => {
  const [year, month, day] = props.dateKey.split('-').map(Number)
  return `${year}年${month}月${day}日`
})
const isImmediateDefault = computed(() => immediateIntent.value && !timeDirty.value)
const selectedEffectiveAt = computed(() => combineLocalDateAndTime(props.dateKey, time.value))
const effectiveTimestamp = computed(() =>
  isImmediateDefault.value ? null : selectedEffectiveAt.value
)
const {
  status,
  statusOptions,
  currentTime,
  stateHint,
  canScheduleNotification: canNotify,
  chooseStatus,
  submissionFields
} = useNoteStateDraft({ effectiveTimestamp, statusChoice, finishedAt })
const isHistoricalBackfill = computed(
  () => !isImmediateDefault.value && selectedEffectiveAt.value <= currentTime.value
)
const dirty = computed(
  () =>
    Boolean(content.value.trim()) ||
    !!remark.value ||
    timeDirty.value ||
    !!finishedAt.value ||
    (imagePickerRef.value?.getImages?.().length || 0) > 0
)
const canCreate = computed(() => Boolean(content.value.trim()) || draftImageCount.value > 0)

function onTimeChange() {
  timeDirty.value = true
}

async function requestClose() {
  if (saving.value || attachmentsBusy.value) return
  if (commitLocked.value) {
    showMessage('warning', '创建结果尚未确认，请先查询原请求')
    return
  }
  const state = await protectedDraft.flush()
  if (!currentDraft() || saving.value || attachmentsBusy.value) return
  if (dirty.value) {
    discardVisible.value = true
    return
  }
  if (state.blocked) {
    showMessage('warning', '请等待附件处理完成并确认草稿已暂存')
    return
  }
  await protectedDraft.clear()
  if (currentDraft()) emit('close')
}

async function discardDraft() {
  if (commitLocked.value) {
    showMessage('warning', '创建结果尚未确认，请先查询原请求')
    return
  }
  await protectedDraft.clear()
  if (currentDraft()) emit('close')
}

async function create() {
  if (saving.value || attachmentsBusy.value) return
  if (commitLocked.value) {
    saving.value = true
    querying.value = true
    try {
      await protectedDraft.commitNote('create', {})
    } catch (error) {
      if (currentDraft()) showMessage('error', error.message || '创建结果尚未确认，请查询原请求')
    } finally {
      saving.value = false
      querying.value = false
    }
    return
  }
  const prepared = await protectedDraft.flush()
  if (!currentDraft() || saving.value || attachmentsBusy.value) return
  if (!prepared.persisted) {
    showMessage('warning', '请先确认草稿暂存完成后再保存便签')
    return
  }
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
  const options = {
    ...stateFields,
    content: content.value,
    remark: remark.value.replace(/\r\n?/g, '\n'),
    contentColorRanges: normalizeNoteTextColorRanges(contentColorRanges.value, content.value),
    durationKind: durationKind.value,
    durationDays: durationDays.value,
    reminderChannels: canNotify.value ? reminderChannels.value : 0,
    isPinned: isPinned.value
  }

  saving.value = true
  try {
    const created = await protectedDraft.commitNote('create', {
      options,
      images: imagePickerRef.value?.getImages?.() || [],
      tagIds: [...tagIds.value]
    })
    if (!created?.id) throw new Error('创建接口未返回便签')
  } catch (error) {
    if (!currentDraft()) return
    console.error('[MonthNoteCreator] 创建失败:', error)
    showMessage('error', error.message || '创建失败，请重试')
  } finally {
    saving.value = false
  }
}

onBeforeUnmount(() => {
  disposed = true
  discardVisible.value = false
})

defineExpose({ requestClose })
const protectedDraft = useDraftProtection({
  key: 'new:calendar:' + props.dateKey,
  fields: {
    content,
    remark,
    contentColorRanges,
    time,
    timeDirty,
    immediateIntent,
    statusChoice,
    finishedAt,
    durationKind,
    durationDays,
    reminderChannels,
    isPinned,
    tagIds
  },
  dirty: () => dirty.value,
  busy: () => saving.value || attachmentsBusy.value,
  extra: () => ({ attachments: imagePickerRef.value?.getDraftChanges() }),
  restoreExtra: (data) => {
    // Older draft records did not persist the intention. Keep their recorded
    // date/time instead of silently treating an old appointment as immediate.
    if (typeof data.immediateIntent !== 'boolean') immediateIntent.value = false
    return imagePickerRef.value?.restoreDraft(data.attachments)
  },
  onCommitted: (created, { recovered }) => {
    if (!currentDraft()) return
    showMessage(
      'success',
      recovered
        ? '已确认上次便签创建成功'
        : isHistoricalBackfill.value
          ? '历史便签补录成功'
          : '便签已创建'
    )
    emit('created', created)
  }
})
const commitLocked = computed(() => protectedDraft.commitLocked.value)
</script>

<template>
  <section
    class="month-creator"
    role="dialog"
    aria-modal="true"
    :aria-label="`${viewLabel}新建便签`"
  >
    <header>
      <div>
        <strong><span>新建</span><span>便签</span></strong
        ><span>{{ dateLabel }}</span>
      </div>
      <button
        type="button"
        aria-label="关闭新建便签"
        title="关闭"
        :disabled="saving || attachmentsBusy"
        @click="requestClose"
      >
        ×
      </button>
    </header>
    <div class="month-creator__body scroll-y" :inert="saving || commitLocked">
      <ColoredTextEditor
        v-model="content"
        v-model:color-ranges="contentColorRanges"
        initial-focus
        placeholder="输入便签内容…（Enter 换行）"
        :rows="2"
      />

      <NoteRemarkField v-model="remark" />

      <div class="month-creator__row">
        <label>执行日期<HelpButton text="日期由进入新建功能时选中的日历格固定。" /></label>
        <strong>{{ dateLabel }}</strong>
      </div>
      <div class="month-creator__row">
        <label
          >生效时间<HelpButton
            :text="`过去时间可用于历史补录；未来预约需至少晚于当前时间 ${MIN_SCHEDULE_LEAD_TIME_MINUTES} 分钟。今天保持默认时间会立即生效。`"
        /></label>
        <TimePicker
          v-model="time"
          panel-title="生效时间"
          aria-label="选择便签生效时间"
          @change="onTimeChange"
        />
      </div>
      <p v-if="isImmediateDefault" class="month-creator__hint">保持默认时间：创建后立即生效</p>
      <NoteStateFields
        v-model:finished-at="finishedAt"
        :status="status"
        :options="statusOptions"
        :hint="stateHint"
        @update:status="chooseStatus"
      />

      <NoteDurationField v-model:kind="durationKind" v-model:days="durationDays" visible />

      <div class="month-creator__field">
        <ReminderChannelPicker
          v-model="reminderChannels"
          :disabled="!canNotify"
          :help-text="`仅未来至少 ${MIN_SCHEDULE_LEAD_TIME_MINUTES} 分钟的预约可开启提醒。`"
          :disabled-reason="
            status === 'completed'
              ? '已完成便签不再提醒'
              : status === 'initialized'
                ? `新预约至少提前 ${MIN_SCHEDULE_LEAD_TIME_MINUTES} 分钟`
                : '设置未来生效时间后可选择生效提醒'
          "
        />
      </div>
      <div class="month-creator__row">
        <label>置顶<HelpButton text="与便签列表共用同一置顶状态。" /></label>
        <AppToggle v-model="isPinned" aria-label="置顶" />
      </div>
      <div class="month-creator__field">
        <label
          >标签<HelpButton text="每条便签最多设置一个分类标签；正文和图片类型由系统自动识别。"
        /></label>
        <TagSelector
          v-model="tagIds"
          :max-selected="MAX_ASSIGNED_TAGS"
          @selection-limit-exceeded="showMessage('warning', NOTE_TAG_LIMIT_MESSAGE)"
        />
      </div>
      <div class="month-creator__field">
        <label
          >图片<HelpButton
            text="支持截图、拖拽或点击上传图片附件。单张最大 50MB，单条便签最多 50 张"
        /></label>
        <ScreenshotPicker
          ref="imagePickerRef"
          :asset-port="protectedDraft"
          mode="memory"
          @count-change="draftImageCount = $event"
          @busy-change="attachmentsBusy = $event"
        />
      </div>
    </div>
    <footer>
      <BaseButton type="button" :disabled="saving || attachmentsBusy" @click="requestClose">
        取消
      </BaseButton>
      <BaseButton
        type="button"
        class="is-primary"
        variant="primary"
        data-diagnostic-action="note.create"
        :disabled="saving || attachmentsBusy || (!canCreate && !commitLocked)"
        @click="create"
      >
        {{
          saving
            ? querying
              ? '查询中…'
              : '创建中…'
            : commitLocked
              ? '查询创建结果'
              : attachmentsBusy
                ? '图片处理中…'
                : '创建便签'
        }}
      </BaseButton>
    </footer>

    <ConfirmDialog
      v-model:visible="discardVisible"
      title="放弃新建便签？"
      message="当前填写的正文、备注、属性或附件尚未保存。"
      confirm-text="放弃"
      variant="danger"
      @confirm="discardDraft"
    />
  </section>
</template>

<style scoped>
.month-creator {
  display: flex;
  width: min(620rem, calc(100vw - min(40rem, 8vw)));
  height: min(660rem, calc(100vh - 40rem));
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--ui-border-control);
  border-radius: 16rem;
  background: var(--surface-modal);
  box-shadow: 0 22rem 56rem rgba(0, 0, 0, 0.28);
  color: var(--text-color);
}
.month-creator > header {
  display: flex;
  min-height: 48rem;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  padding: 0 13rem 0 17rem;
  border-bottom: 1px solid var(--ui-border-divider);
}
.month-creator > header div {
  display: flex;
  align-items: baseline;
  gap: 9rem;
  min-width: 0;
  flex-wrap: wrap;
  padding-block: 8rem;
}
.month-creator > header strong {
  display: flex;
  flex-wrap: wrap;
  max-width: 100%;
}
.month-creator > header strong span {
  font: inherit;
  color: inherit;
  white-space: nowrap;
}
.month-creator > header span {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.month-creator > header button {
  display: grid;
  width: 27rem;
  height: 27rem;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text-color-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 22rem;
  flex-shrink: 0;
}
.month-creator > header button:hover {
  background: var(--ui-fill-hover);
  color: var(--text-color);
}
.month-creator__body {
  min-height: 0;
  flex: 1;
  padding: 16rem min(18rem, 4vw);
}
.month-creator__row {
  display: flex;
  min-height: 42rem;
  align-items: center;
  justify-content: space-between;
  gap: 12rem;
  margin-top: 12rem;
}
.month-creator__row label,
.month-creator__field > label {
  min-width: 0;
  max-width: 100%;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  font-weight: 500;
}
.month-creator__row strong {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
  font-size: var(--fs-secondary);
}
.month-creator__hint {
  margin: -3rem 0 3rem;
  color: #0a84ff;
  font-size: calc(var(--fs-secondary) * 0.82);
  text-align: right;
}
.month-creator__hint.is-history {
  color: var(--text-color-secondary);
}
.month-creator__field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6rem;
  margin-top: 12rem;
}
.month-creator__field > label {
  display: block;
}
.month-creator > footer {
  display: flex;
  flex-wrap: wrap;
  min-height: 54rem;
  flex-shrink: 0;
  align-items: center;
  justify-content: flex-end;
  gap: 8rem;
  padding: 0 15rem;
  border-top: 1px solid var(--ui-border-divider);
}
.month-creator__row {
  flex-wrap: wrap;
}
.month-creator > footer {
  padding-block: 8rem;
}
</style>
