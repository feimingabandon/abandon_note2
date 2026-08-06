<script setup>
/**
 * NewNotePanel.vue — 新建便签表单面板
 *
 * 职责：
 *   1. 收集用户输入的表单字段（正文/标签/生效时间/图片/通知/置顶）
 *   2. 调用 window.api.createNote 创建便签
 *   3. 创建成功后重置表单并 emit('create') 通知父组件
 *
 * 不负责：面板标题栏、面板高度拖拽（由 ActionBar 统一管理）
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import DateTimePicker from '../ui/DateTimePicker.vue'
import TagSelector from '../ui/TagSelector.vue'
import ScreenshotPicker from '../note/ScreenshotPicker.vue'
import AppToggle from '../ui/AppToggle.vue'
import HelpButton from '../ui/HelpButton.vue'
import ResizableTextarea from '../ui/ResizableTextarea.vue'
import { useMessage } from '../../composables/useMessage.js'
import { MAX_ASSIGNED_TAGS, NOTE_TAG_LIMIT_MESSAGE } from '../../../../shared/tag-rules.js'

const emit = defineEmits(['create'])
const props = defineProps({
  active: { type: Boolean, default: false }
})

const { showMessage } = useMessage()
const systemNotificationCapability = window.api.runtimeCapabilities?.systemNotifications || {
  supported: true,
  reason: ''
}
const systemNotificationsSupported = systemNotificationCapability.supported
const systemNotificationUnavailableReason = systemNotificationCapability.reason

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
  return submitRef.value ? [...bodyItems, submitRef.value] : bodyItems
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
    if (element === submitRef.value) element.style.filter = 'opacity(0)'
    else element.style.opacity = '0'
    element.style.translate = '0 6px'
  }

  enterRaf = requestAnimationFrame(() => {
    enterRaf = null
    if (!props.active || seq !== entranceSeq) return
    entranceAnimations = items.map((element, index) => {
      const keyframes =
        element === submitRef.value
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
  finishSuccessHold()
})

// ============================================================
// 表单状态
// ============================================================
const content = ref('')
const effectiveAt = ref('') // "YYYY-MM-DD HH:mm:ss" 或空（空 = 立即生效）
const tagNames = ref([]) // 仅保存用户自定义标签；内容类型由正文和附件推导
const notifyEnabled = ref(false) // 启用系统提醒开关
const isPinned = ref(false) // 置顶开关
const submitState = ref('idle') // idle | creating | success
/** ScreenshotPicker 组件引用 */
const imagePickerRef = ref(null)
let successTimer = null
let successHoldResolve = null

// ---- 联动逻辑 ----
/** 只有设置了生效时间才能开启系统提醒 */
const canEnableNotify = computed(() => systemNotificationsSupported && !!effectiveAt.value)
const submitLabel = computed(() => {
  if (submitState.value === 'creating') return '创建中…'
  if (submitState.value === 'success') return '✓ 已创建'
  return '创建便签'
})
const submitEmpty = computed(() => submitState.value === 'idle' && !content.value.trim())

/** 今天零点，作为日期选择下限 */
const today = computed(() => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
})

/** 自定义快捷选项（不含过去日期） */
const dateShortcuts = [
  { label: '今天', getValue: () => new Date() },
  {
    label: '明天',
    getValue: () => {
      const d = new Date()
      d.setDate(d.getDate() + 1)
      return d
    }
  },
  {
    label: '三天后',
    getValue: () => {
      const d = new Date()
      d.setDate(d.getDate() + 3)
      return d
    }
  }
]

// 生效时间被清空时，强制关闭系统提醒
watch(effectiveAt, (val) => {
  if (!val && notifyEnabled.value) {
    notifyEnabled.value = false
  }
})

// ============================================================
// 创建便签
// ============================================================
const FIVE_MINUTES = 5 * 60 * 1000
const SUCCESS_HOLD = 550

function resetForm() {
  content.value = ''
  effectiveAt.value = ''
  tagNames.value = []
  notifyEnabled.value = false
  isPinned.value = false
  imagePickerRef.value?.clearImages()
}

function holdSuccessState() {
  return new Promise((resolve) => {
    successHoldResolve = resolve
    successTimer = setTimeout(() => {
      successTimer = null
      successHoldResolve = null
      resolve()
    }, SUCCESS_HOLD)
  })
}

function finishSuccessHold() {
  if (successTimer) clearTimeout(successTimer)
  successTimer = null
  const resolve = successHoldResolve
  successHoldResolve = null
  resolve?.()
}

async function handleCreate() {
  const text = content.value

  // 校验：内容不能为空
  if (!text.trim()) {
    showMessage('warning', '请输入便签内容')
    return
  }

  if (tagNames.value.length > MAX_ASSIGNED_TAGS) {
    showMessage('warning', NOTE_TAG_LIMIT_MESSAGE)
    return
  }

  // 校验：生效时间不能距离当下不足 5 分钟
  if (effectiveAt.value) {
    const ts = new Date(effectiveAt.value).getTime()
    if (ts - Date.now() < FIVE_MINUTES) {
      showMessage('warning', '生效时间需在当前时间 5 分钟之后，请重新选择')
      return
    }
  }

  if (submitState.value !== 'idle') return
  submitState.value = 'creating'

  try {
    const options = {
      content: text,
      notifyEnabled: notifyEnabled.value ? 1 : 0,
      isPinned: isPinned.value ? 1 : 0
    }
    if (effectiveAt.value) {
      options.effectiveAt = new Date(effectiveAt.value).getTime()
    }
    const imgs = imagePickerRef.value?.getImages() || []
    // 检查 API 是否存在
    if (typeof window.api.createNoteWithAssets !== 'function') {
      throw new Error('接口未就绪，请完全重启应用（npm run dev）')
    }

    await window.api.createNoteWithAssets({
      options,
      images: imgs,
      tagNames: [...tagNames.value]
    })

    submitState.value = 'success'
    showMessage('success', '便签创建成功')
    // 先保留 SUCCESS_HOLD 展示「✓ 已创建」，再 emit（由父级刷新列表并收起面板），确保用户能看清成功反馈。
    await holdSuccessState()
    emit('create')
    resetForm()
    submitState.value = 'idle'
    await nextTick()
    if (props.active) requestAnimationFrame(focusTextareaAtTop)
  } catch (e) {
    console.error('[NewNotePanel] 创建便签失败:', e)
    showMessage('error', e.message || '创建失败，请重试')
    submitState.value = 'idle'
  } finally {
    if (submitState.value === 'creating') submitState.value = 'idle'
  }
}
</script>

<template>
  <div class="nnp-root">
    <!-- 可滚动表单区域 -->
    <div ref="entranceBodyRef" class="nnp-body scroll-y" :inert="submitState !== 'idle'">
      <!-- 便签内容 -->
      <ResizableTextarea
        ref="textareaRef"
        v-model="content"
        placeholder="请新建一次性便签内容…（Enter 换行）"
        :rows="4"
      />

      <!-- 生效时间（label 左，picker 右） -->
      <div class="nnp-field-row">
        <label class="nnp-field-label"
          >生效时间<HelpButton text="设置后便签将在指定时间生效。未设置则立即生效。"
        /></label>
        <DateTimePicker
          v-model="effectiveAt"
          placeholder="立即生效"
          :min-date="today"
          :shortcuts="dateShortcuts"
        />
      </div>

      <!-- 启用系统提醒 -->
      <div class="nnp-notification-field">
        <div class="nnp-field-row">
          <label class="nnp-field-label"
            >启用系统提醒<HelpButton
              :text="
                systemNotificationsSupported
                  ? '仅在设置生效时间后才可开启。到达生效时间时通过操作系统发送通知提醒'
                  : systemNotificationUnavailableReason
              "
          /></label>
          <AppToggle v-model="notifyEnabled" :disabled="!canEnableNotify" />
        </div>
        <p v-if="!systemNotificationsSupported" class="nnp-platform-note">
          {{ systemNotificationUnavailableReason }}
        </p>
      </div>

      <!-- 置顶 -->
      <div class="nnp-field-row">
        <label class="nnp-field-label"
          >置顶<HelpButton text="开启后便签将固定在列表顶部，不受排序方式影响"
        /></label>
        <AppToggle v-model="isPinned" />
      </div>

      <!-- 标签 -->
      <div class="nnp-field nnp-group-gap">
        <label class="nnp-field-label"
          >标签<HelpButton text="每条便签最多设置一个分类标签；正文和图片类型由系统自动识别。"
        /></label>
        <TagSelector
          v-model="tagNames"
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
        <ScreenshotPicker ref="imagePickerRef" mode="memory" />
      </div>
    </div>

    <!-- 创建按钮（始终可见，不受面板内容滚动和底部渐隐影响） -->
    <button
      ref="submitRef"
      class="nnp-submit"
      :class="{
        'is-empty': submitEmpty,
        'is-creating': submitState === 'creating',
        'is-success': submitState === 'success'
      }"
      :disabled="submitState !== 'idle' || !content.trim()"
      @click="handleCreate"
    >
      <Transition name="nnp-submit-label">
        <span :key="submitState" class="nnp-submit-label">{{ submitLabel }}</span>
      </Transition>
    </button>
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
}
.nnp-notification-field {
  display: flex;
  flex-direction: column;
  gap: 5rem;
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
  margin-top: 0;
  display: grid;
  place-items: center;
  width: calc(100% - 28rem);
  margin-left: 14rem;
  margin-right: 14rem;
  padding: 10rem 0;
  font-size: var(--fs-body);
  font-family: inherit;
  font-weight: 600;
  color: #fff;
  background: #0071e3;
  border: none;
  border-radius: 8rem;
  cursor: pointer;
  outline: none;
  flex-shrink: 0;
  transform: scale(1);
  transition:
    background-color 180ms ease,
    opacity 170ms ease,
    transform 170ms var(--ease-standard);
}
.nnp-submit:hover:not(:disabled) {
  background: #0077ed;
}
.nnp-submit:disabled {
  cursor: not-allowed;
}
.nnp-submit.is-empty {
  opacity: 0.4;
  transform: scale(0.99);
}
.nnp-submit.is-success {
  /* 苹果浅色模式 systemGreen（#34C759），比深色档 #30D158 更沉稳，与主蓝 #0071e3 同为压深调。 */
  background: #34c759;
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
.nnp-submit:active:not(:disabled) {
  transform: scale(0.985);
  transition:
    background-color var(--motion-fast) ease,
    transform 70ms ease;
}
</style>
