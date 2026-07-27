<script setup>
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
import ResizableTextarea from '../ui/ResizableTextarea.vue'
import { useMessage } from '../../composables/useMessage.js'

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
const status = ref('initialized')
const effectiveAt = ref('')
const notifyEnabled = ref(false)
const isPinned = ref(false)
const tagNames = ref([])
const saving = ref(false)
const mounted = ref(false)
const imagePickerRef = ref(null)
const attachmentDirty = ref(false)
const initialSnapshot = ref(null)
const confirmVisible = ref(false)

const FIVE_MINUTES = 5 * 60 * 1000

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatDateTime(timestamp) {
  const date = new Date(Number(timestamp))
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function normalizedTags(tags) {
  return [...tags].map(String).sort((a, b) => a.localeCompare(b))
}

function createSnapshot(note) {
  return {
    content: note.content || '',
    status: note.status,
    effectiveAt: formatDateTime(note.effective_at),
    notifyEnabled: systemNotificationsSupported && !!note.notify_enabled,
    isPinned: !!note.is_pinned,
    tagNames: normalizedTags(note.tags?.map((tag) => tag.name) || [])
  }
}

function resetFromNote(note) {
  if (!note) return
  const snapshot = createSnapshot(note)
  initialSnapshot.value = snapshot
  content.value = snapshot.content
  status.value = snapshot.status
  effectiveAt.value = snapshot.effectiveAt
  notifyEnabled.value = snapshot.notifyEnabled
  isPinned.value = snapshot.isPinned
  tagNames.value = [...snapshot.tagNames]
  attachmentDirty.value = false
}

watch(() => props.note, resetFromNote, { immediate: true })

onMounted(async () => {
  await nextTick()
  requestAnimationFrame(() => { mounted.value = true })
})

const statusLabel = computed(() => ({
  initialized: '初始化',
  in_progress: '进行中',
  completed: '已完成'
})[status.value] || status.value)

const canEditSchedule = computed(() => status.value === 'initialized')
const today = computed(() => {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
})
const dateShortcuts = [
  { label: '今天', getValue: () => new Date(Date.now() + FIVE_MINUTES) },
  { label: '明天', getValue: () => { const date = new Date(); date.setDate(date.getDate() + 1); return date } },
  { label: '三天后', getValue: () => { const date = new Date(); date.setDate(date.getDate() + 3); return date } }
]

const scheduleHelp = computed(() => {
  if (status.value === 'initialized') return '仅初始化状态允许修改，新的生效时间需在当前时间 5 分钟之后。'
  if (status.value === 'in_progress') return '便签生效后不能修改原始生效时间。'
  return '已完成便签的生效时间不可修改。'
})

const notifyHelp = computed(() => {
  if (!systemNotificationsSupported) return systemNotificationUnavailableReason
  if (status.value === 'initialized') return '初始化状态可以修改系统提醒设置。'
  return '便签进入当前状态后，系统提醒设置不可修改。'
})

const hasChanges = computed(() => {
  const initial = initialSnapshot.value
  if (!initial) return false
  return attachmentDirty.value ||
    content.value !== initial.content ||
    status.value !== initial.status ||
    effectiveAt.value !== initial.effectiveAt ||
    notifyEnabled.value !== initial.notifyEnabled ||
    isPinned.value !== initial.isPinned ||
    JSON.stringify(normalizedTags(tagNames.value)) !== JSON.stringify(initial.tagNames)
})

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
  emit('cancel')
}

async function handleSave() {
  if (saving.value || !hasChanges.value) return
  const text = content.value
  if (!text.trim()) {
    showMessage('warning', '请输入便签内容')
    return
  }

  let effectiveTimestamp = new Date(effectiveAt.value).getTime()
  if (status.value === 'initialized') {
    if (!Number.isFinite(effectiveTimestamp)) {
      showMessage('warning', '请选择有效的生效时间')
      return
    }
    const effectiveAtChanged = effectiveAt.value !== initialSnapshot.value?.effectiveAt
    if (effectiveAtChanged && effectiveTimestamp - Date.now() < FIVE_MINUTES) {
      showMessage('warning', '生效时间需在当前时间 5 分钟之后')
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
      fields: {
        content: text,
        status: status.value,
        effectiveAt: effectiveTimestamp,
        notifyEnabled: systemNotificationsSupported && notifyEnabled.value,
        isPinned: isPinned.value
      },
      tagNames: [...tagNames.value],
      ...attachmentChanges
    })
    showMessage('success', '便签已保存')
    emit('saved', updated)
  } catch (error) {
    console.error('[NoteEditor] 保存失败:', error)
    showMessage('error', error.message || '保存失败，请重试')
  } finally {
    saving.value = false
  }
}

defineExpose({ requestClose })
</script>

<template>
  <div class="ne-root" :class="{ 'ne-enter': mounted }">
    <div class="ne-body scroll-y">
      <ResizableTextarea
        v-model="content"
        class="ne-stagger"
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
          :min-date="today"
          :shortcuts="dateShortcuts"
        />
      </div>

      <div class="ne-notification-field ne-stagger" style="animation-delay: 100ms">
        <div class="ne-field-row">
          <label class="ne-field-label">系统提醒<HelpButton :text="notifyHelp" /></label>
          <AppToggle
            v-model="notifyEnabled"
            :disabled="!systemNotificationsSupported || !canEditSchedule"
          />
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
        <label class="ne-field-label">标签<HelpButton text="为便签添加分类标签，便于筛选和管理。" /></label>
        <TagSelector v-model="tagNames" />
      </div>

      <div class="ne-field ne-stagger" style="animation-delay: 190ms">
        <label class="ne-field-label">附件<HelpButton text="附件修改会保存在草稿中，点击保存修改后才会写入数据库和附件目录。" /></label>
        <ScreenshotPicker
          ref="imagePickerRef"
          :note-id="note.id"
          mode="draft"
          @draft-change="onAttachmentDraftChange"
        />
      </div>
    </div>

    <div class="ne-footer ne-stagger" style="animation-delay: 230ms">
      <button class="ne-dismiss" :disabled="saving" @click="requestClose">
        {{ hasChanges ? '放弃修改' : '关闭' }}
      </button>
      <button class="ne-submit" :disabled="!content.trim() || !hasChanges || saving" @click="handleSave">
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
  -webkit-mask-image: linear-gradient(to bottom, black 0%, black calc(100% - 30rem), transparent 100%);
  mask-image: linear-gradient(to bottom, black 0%, black calc(100% - 30rem), transparent 100%);
}
.ne-stagger { opacity: 0; }
.ne-enter .ne-stagger { animation: ne-fade-up 250ms cubic-bezier(0.22, 1, 0.36, 1) both; }
@keyframes ne-fade-up {
  from { opacity: 0; transform: translateY(6rem); }
  to { opacity: 1; transform: translateY(0); }
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
.ne-group-gap { margin-top: 20rem; }
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
.ne-status--initialized { color: #007aff; }
.ne-status--in_progress { color: #ff9500; }
.ne-status--completed { color: #34c759; }
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
  transition: background-color 150ms ease, color 150ms ease, transform 70ms ease;
}
.ne-dismiss {
  background: color-mix(in srgb, var(--text-color) 8%, transparent);
  color: var(--text-color-secondary);
}
.ne-dismiss:hover:not(:disabled) {
  background: color-mix(in srgb, var(--text-color) 13%, transparent);
  color: var(--text-color);
}
.ne-submit { flex: 1; min-width: 104rem; background: #0071e3; color: #fff; }
.ne-submit:hover:not(:disabled) { background: #0077ed; }
.ne-dismiss:active:not(:disabled),
.ne-submit:active:not(:disabled) { transform: scale(0.97); }
.ne-dismiss:disabled,
.ne-submit:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
