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
import { ref, watch, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import DateTimePicker from '../ui/DateTimePicker.vue'
import TagSelector from '../ui/TagSelector.vue'
import ScreenshotPicker from '../note/ScreenshotPicker.vue'
import AppToggle from '../ui/AppToggle.vue'
import HelpButton from '../ui/HelpButton.vue'
import { useMessage } from '../../composables/useMessage.js'

const emit = defineEmits(['create'])

const { showMessage } = useMessage()

// ============================================================
// 入场动效：挂载一帧后触发逐层淡入
// ============================================================
const mounted = ref(false)

onMounted(async () => {
  await nextTick()
  requestAnimationFrame(() => {
    mounted.value = true
    // 面板展开后自动聚焦文本域
    textareaRef.value?.focus()
  })
})

// ============================================================
// 表单状态
// ============================================================
const content = ref('')
const effectiveAt = ref('') // "YYYY-MM-DD HH:mm:ss" 或空（空 = 立即生效）
const tagNames = ref([]) // 仅保存用户自定义标签；内容类型由正文和附件推导
const notifyEnabled = ref(false) // 启用系统提醒开关
const isPinned = ref(false) // 置顶开关
const creating = ref(false) // 防止重复提交
/** ScreenshotPicker 组件引用 */
const imagePickerRef = ref(null)
/** 文本域 DOM 引用（拖拽调整高度） */
const textareaRef = ref(null)

// ---- 联动逻辑 ----
/** 只有设置了生效时间才能开启系统提醒 */
const canEnableNotify = computed(() => !!effectiveAt.value)

/** 今天零点，作为日期选择下限 */
const today = computed(() => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
})

/** 自定义快捷选项（不含过去日期） */
const dateShortcuts = [
  { label: '今天', getValue: () => new Date() },
  { label: '明天', getValue: () => { const d = new Date(); d.setDate(d.getDate() + 1); return d } },
  { label: '三天后', getValue: () => { const d = new Date(); d.setDate(d.getDate() + 3); return d } }
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

async function handleCreate() {
  const text = content.value.trim()

  // 校验：内容不能为空
  if (!text) {
    showMessage('warning', '请输入便签内容')
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

  if (creating.value) return
  creating.value = true

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

    showMessage('success', '便签创建成功')

    // 重置表单
    content.value = ''
    effectiveAt.value = ''
    tagNames.value = []
    notifyEnabled.value = false
    isPinned.value = false
    imagePickerRef.value?.clearImages()
    emit('create')
  } catch (e) {
    console.error('[NewNotePanel] 创建便签失败:', e)
    showMessage('error', e.message || '创建失败，请重试')
  } finally {
    creating.value = false
  }
}

// ============================================================
// 拖拽调整文本域高度
// ============================================================
let isDragging = false
let dragStartY = 0
let dragStartHeight = 0
let dragRaf = null

function onTextareaDragStart(e) {
  isDragging = true
  dragStartY = e.clientY
  dragStartHeight = textareaRef.value ? textareaRef.value.clientHeight : 80
  document.addEventListener('mousemove', onTextareaDragMove)
  document.addEventListener('mouseup', onTextareaDragEnd)
  e.preventDefault()
}

function onTextareaDragMove(e) {
  if (!isDragging || !textareaRef.value) return
  if (dragRaf) return
  dragRaf = requestAnimationFrame(() => {
    dragRaf = null
    const deltaY = e.clientY - dragStartY
    let h = dragStartHeight + deltaY
    // 最小 3 行约 60px，最大 300px
    h = Math.max(60, Math.min(300, h))
    textareaRef.value.style.height = h + 'px'
  })
}

function onTextareaDragEnd() {
  isDragging = false
  if (dragRaf) {
    cancelAnimationFrame(dragRaf)
    dragRaf = null
  }
  document.removeEventListener('mousemove', onTextareaDragMove)
  document.removeEventListener('mouseup', onTextareaDragEnd)
}

onBeforeUnmount(() => {
  document.removeEventListener('mousemove', onTextareaDragMove)
  document.removeEventListener('mouseup', onTextareaDragEnd)
})
</script>

<template>
  <div class="nnp-root" :class="{ 'nnp-enter': mounted }">
    <!-- 可滚动表单区域 -->
    <div class="nnp-body scroll-y">
      <!-- 便签内容 -->
      <textarea
        ref="textareaRef"
        v-model="content"
        class="nnp-textarea nnp-stagger"
        style="animation-delay: 0ms"
        placeholder="请新建一次性便签内容…（Enter 换行）"
        rows="4"
      />
      <!-- 文本域拖拽调整条 -->
      <div class="nnp-resize nnp-stagger" style="animation-delay: 20ms" @mousedown="onTextareaDragStart">
        <div class="nnp-resize-bar" />
      </div>

      <!-- 生效时间（label 左，picker 右） -->
      <div class="nnp-field-row nnp-stagger" style="animation-delay: 60ms">
        <label class="nnp-field-label">生效时间<HelpButton text="设置后便签将在指定时间生效。未设置则立即生效。" /></label>
        <DateTimePicker
          v-model="effectiveAt"
          placeholder="立即生效"
          :min-date="today"
          :shortcuts="dateShortcuts"
        />
      </div>

      <!-- 启用系统提醒 -->
      <div class="nnp-field-row nnp-stagger" style="animation-delay: 110ms">
        <label class="nnp-field-label">启用系统提醒<HelpButton text="仅在设置生效时间后才可开启。到达生效时间时通过操作系统发送通知提醒" /></label>
        <AppToggle v-model="notifyEnabled" :disabled="!canEnableNotify" />
      </div>

      <!-- 置顶 -->
      <div class="nnp-field-row nnp-stagger" style="animation-delay: 140ms">
        <label class="nnp-field-label">置顶<HelpButton text="开启后便签将固定在列表顶部，不受排序方式影响" /></label>
        <AppToggle v-model="isPinned" />
      </div>

      <!-- 标签 -->
      <div class="nnp-field nnp-group-gap nnp-stagger" style="animation-delay: 190ms">
        <label class="nnp-field-label">标签<HelpButton text="添加自定义分类标签；正文和图片类型由系统自动识别。" /></label>
        <TagSelector v-model="tagNames" />
      </div>

      <!-- 图片 -->
      <div class="nnp-field nnp-stagger" style="animation-delay: 220ms">
        <label class="nnp-field-label">图片<HelpButton text="支持截图、拖拽或点击上传图片附件。单张最大 50MB，单条便签最多 50 张" /></label>
        <ScreenshotPicker ref="imagePickerRef" mode="memory" />
      </div>
    </div>

    <!-- 创建按钮（始终可见，不受面板内容滚动和底部渐隐影响） -->
    <button
      class="nnp-submit nnp-stagger"
      style="animation-delay: 270ms"
      :disabled="!content.trim() || creating"
      @click="handleCreate"
    >
      {{ creating ? '创建中…' : '创建便签' }}
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
  mask-image: linear-gradient(
    to bottom,
    black 0%,
    black calc(100% - 30rem),
    transparent 100%
  );
}

/* === 逐层淡入动效：挂载前隐藏，挂载后逐元素延迟触发 === */
.nnp-stagger {
  opacity: 0;
}

.nnp-enter .nnp-stagger {
  animation: nnp-fade-up 250ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes nnp-fade-up {
  from {
    opacity: 0;
    transform: translateY(6rem);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* === 文本域 === */
.nnp-textarea {
  display: block;
  width: 100%;
  padding: 10rem 12rem;
  font-size: var(--fs-body);
  font-family: inherit;
  font-weight: 500;
  color: var(--text-color);
  background: rgba(255, 255, 255, 0.05);
  border: 1rem solid rgb(var(--bg-color, 255 255 255) / 0.1);
  border-radius: 8rem;
  outline: none;
  resize: none;
  transition: border-color 150ms ease;
  line-height: 1.5;
  min-height: 90rem;
}
.nnp-textarea:focus {
  border-color: rgb(var(--bg-color, 255 255 255) / 0.18);
}
.nnp-textarea::placeholder {
  color: var(--text-color-secondary);
  opacity: 0.5;
}

/* === 文本域拖拽调整条 === */
.nnp-resize {
  display: flex;
  justify-content: center;
  padding: 2rem 0 4rem;
  cursor: row-resize;
  user-select: none;
}
.nnp-resize-bar {
  width: 32rem;
  height: 3rem;
  border-radius: 1.5rem;
  background-color: rgba(255, 255, 255, 0.1);
  transition: background-color 150ms ease;
}
.nnp-resize:hover .nnp-resize-bar {
  background-color: rgba(255, 255, 255, 0.22);
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
  margin-top: 0;
  display: block;
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
  transition: background-color 150ms ease;
}
.nnp-submit:hover:not(:disabled) {
  background: #0077ed;
}
.nnp-submit:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
