<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import ResizableTextarea from '../ui/ResizableTextarea.vue'
import TimePicker from '../ui/TimePicker.vue'
import AppToggle from '../ui/AppToggle.vue'
import TagSelector from '../ui/TagSelector.vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import NoteDurationField from '../note/NoteDurationField.vue'
import ScreenshotPicker from '../note/ScreenshotPicker.vue'
import HelpButton from '../ui/HelpButton.vue'
import { useMessage } from '../../composables/useMessage.js'
import { useTodayKey } from '../../composables/useTodayKey.js'
import { combineLocalDateAndTime } from '../../../../shared/calendar/calendar-date-rules.js'
import { MAX_ASSIGNED_TAGS, NOTE_TAG_LIMIT_MESSAGE } from '../../../../shared/tag-rules.js'
import {
  MIN_SCHEDULE_LEAD_TIME_MINUTES,
  MIN_SCHEDULE_LEAD_TIME_MS
} from '../../../../shared/note-scheduling-rules.js'

const props = defineProps({ dateKey: { type: String, required: true } })
const emit = defineEmits(['created', 'close'])
const { showMessage } = useMessage()
const now = new Date()
const pad = (value) => String(value).padStart(2, '0')
const initialTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`
const content = ref('')
const time = ref(initialTime)
const timeDirty = ref(false)
const durationDays = ref(1)
const notifyEnabled = ref(false)
const isPinned = ref(false)
const tagIds = ref([])
const imagePickerRef = ref(null)
const saving = ref(false)
const discardVisible = ref(false)
const todayKey = useTodayKey()
const systemNotificationCapability = window.api.runtimeCapabilities?.systemNotifications || {
  supported: true,
  reason: ''
}

const dateLabel = computed(() => {
  const [year, month, day] = props.dateKey.split('-').map(Number)
  return `${year}年${month}月${day}日`
})
const isPast = computed(() => props.dateKey < todayKey.value)
const isImmediateDefault = computed(() => props.dateKey === todayKey.value && !timeDirty.value)
const canNotify = computed(
  () => systemNotificationCapability.supported && !isImmediateDefault.value && !isPast.value
)
const dirty = computed(
  () =>
    Boolean(content.value.trim()) ||
    timeDirty.value ||
    durationDays.value !== 1 ||
    notifyEnabled.value ||
    isPinned.value ||
    tagIds.value.length > 0 ||
    (imagePickerRef.value?.getImages?.().length || 0) > 0
)

function onTimeChange() {
  timeDirty.value = true
}

function requestClose() {
  if (saving.value) return
  if (dirty.value) discardVisible.value = true
  else emit('close')
}

async function create() {
  if (saving.value || isPast.value) return
  if (!content.value.trim()) {
    showMessage('warning', '请输入便签内容')
    return
  }
  if (tagIds.value.length > MAX_ASSIGNED_TAGS) {
    showMessage('warning', NOTE_TAG_LIMIT_MESSAGE)
    return
  }

  const options = {
    content: content.value,
    durationDays: durationDays.value,
    notifyEnabled: canNotify.value && notifyEnabled.value,
    isPinned: isPinned.value
  }
  if (!isImmediateDefault.value) {
    const effectiveAt = combineLocalDateAndTime(props.dateKey, time.value)
    if (props.dateKey === todayKey.value && effectiveAt - Date.now() < MIN_SCHEDULE_LEAD_TIME_MS) {
      showMessage(
        'warning',
        `今天的生效时间需在当前时间 ${MIN_SCHEDULE_LEAD_TIME_MINUTES} 分钟之后；不调整时间可直接立即创建`
      )
      return
    }
    options.effectiveAt = effectiveAt
  }

  saving.value = true
  try {
    const created = await window.api.createNoteWithAssets({
      options,
      images: imagePickerRef.value?.getImages?.() || [],
      tagIds: [...tagIds.value]
    })
    if (!created?.id) throw new Error('创建接口未返回便签')
    showMessage('success', '便签已创建')
    emit('created', created)
  } catch (error) {
    console.error('[MonthNoteCreator] 创建失败:', error)
    showMessage('error', error.message || '创建失败，请重试')
  } finally {
    saving.value = false
  }
}

onBeforeUnmount(() => {
  discardVisible.value = false
})

defineExpose({ requestClose })
</script>

<template>
  <section class="month-creator" role="dialog" aria-modal="true" aria-label="月视图新建便签">
    <header>
      <div>
        <strong>新建便签</strong><span>{{ dateLabel }}</span>
      </div>
      <button type="button" aria-label="关闭新建便签" title="关闭" @click="requestClose">×</button>
    </header>
    <div class="month-creator__body scroll-y">
      <ResizableTextarea
        v-model="content"
        initial-focus
        placeholder="输入便签内容…（Enter 换行）"
        :rows="5"
      />

      <div class="month-creator__row">
        <label>执行日期<HelpButton text="日期由进入新建功能时选中的日历格固定。" /></label>
        <strong>{{ dateLabel }}</strong>
      </div>
      <div class="month-creator__row">
        <label
          >生效时间<HelpButton
            :text="`今天保持默认时间会立即生效；手动调整后需至少晚于当前时间 ${MIN_SCHEDULE_LEAD_TIME_MINUTES} 分钟。`"
        /></label>
        <TimePicker
          v-model="time"
          panel-title="生效时间"
          aria-label="选择便签生效时间"
          @change="onTimeChange"
        />
      </div>
      <p v-if="isImmediateDefault" class="month-creator__hint">保持默认时间：创建后立即生效</p>

      <NoteDurationField v-model="durationDays" visible />

      <div class="month-creator__row">
        <label
          >系统提醒<HelpButton
            :text="canNotify ? '到达生效时间时发送系统提醒。' : '立即生效的便签无需定时提醒。'"
        /></label>
        <AppToggle v-model="notifyEnabled" :disabled="!canNotify" />
      </div>
      <div class="month-creator__row">
        <label>置顶<HelpButton text="与便签列表共用同一置顶状态。" /></label>
        <AppToggle v-model="isPinned" />
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
        <ScreenshotPicker ref="imagePickerRef" mode="memory" />
      </div>
    </div>
    <footer>
      <button type="button" :disabled="saving" @click="requestClose">取消</button>
      <button
        type="button"
        class="is-primary"
        :disabled="saving || !content.trim() || isPast"
        @click="create"
      >
        {{ saving ? '创建中…' : '创建便签' }}
      </button>
    </footer>

    <ConfirmDialog
      v-model:visible="discardVisible"
      title="放弃新建便签？"
      message="当前填写的正文、属性或附件尚未保存。"
      confirm-text="放弃"
      variant="danger"
      @confirm="emit('close')"
    />
  </section>
</template>

<style scoped>
.month-creator {
  display: flex;
  width: min(620rem, calc(100vw - 40rem));
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
}
.month-creator > header button:hover {
  background: var(--ui-fill-hover);
  color: var(--text-color);
}
.month-creator__body {
  min-height: 0;
  flex: 1;
  padding: 16rem 18rem;
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
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  font-weight: 500;
}
.month-creator__row strong {
  font-size: var(--fs-secondary);
}
.month-creator__hint {
  margin: -3rem 0 3rem;
  color: #0a84ff;
  font-size: calc(var(--fs-secondary) * 0.82);
  text-align: right;
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
  min-height: 54rem;
  flex-shrink: 0;
  align-items: center;
  justify-content: flex-end;
  gap: 8rem;
  padding: 0 15rem;
  border-top: 1px solid var(--ui-border-divider);
}
.month-creator > footer button {
  height: 32rem;
  padding: 0 14rem;
  border: 0;
  border-radius: 8rem;
  background: rgb(var(--bg-color) / 0.1);
  color: var(--text-color);
  cursor: pointer;
  font: inherit;
}
.month-creator > footer button.is-primary {
  background: #0071e3;
  color: white;
}
.month-creator > footer button.is-primary:hover:not(:disabled) {
  background: #0077ed;
}
.month-creator > footer button:disabled {
  cursor: default;
  opacity: 0.45;
}
</style>
