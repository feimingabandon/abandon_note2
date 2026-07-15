<script setup>
/**
 * NoteEditor.vue — 便签修改面板
 *
 * 职责：
 *   1. 接收 note prop，预填表单字段
 *   2. content / tags / images / is_pinned — 始终可修改
 *   3. effective_at / notify_enabled — 仅 active 状态可修改
 *   4. 状态流转按钮（开始处理 / 完成 / 取消）
 *   5. 保存后 emit('saved')
 *
 * 面板结构（flex column + scroll-y body + 底部渐隐 + 逐层淡入）与 NewNotePanel 一致。
 */
import { ref, watch, computed, onMounted, nextTick } from 'vue'
import DateTimePicker from '../ui/DateTimePicker.vue'
import TagSelector from '../ui/TagSelector.vue'
import ScreenshotPicker from '../note/ScreenshotPicker.vue'
import AppToggle from '../ui/AppToggle.vue'
import HelpButton from '../ui/HelpButton.vue'
import { useMessage } from '../../composables/useMessage.js'

const props = defineProps({
  note: { type: Object, required: true }
})

const emit = defineEmits(['saved'])

const { showMessage } = useMessage()

// ============================================================
// 入场动效
// ============================================================
const mounted = ref(false)
onMounted(async () => {
  await nextTick()
  requestAnimationFrame(() => { mounted.value = true })
})

// ============================================================
// 表单状态
// ============================================================
const content = ref('')
const effectiveAt = ref('')
const tagNames = ref([])
const notifyEnabled = ref(false)
const isPinned = ref(false)
const saving = ref(false)
/** ScreenshotPicker 引用 */
const imagePickerRef = ref(null)

// ---- 状态标签 ----
const statusLabel = computed(() => {
  const map = {
    active: '待生效',
    in_progress: '进行中',
    completed: '已完成',
    cancelled: '已取消',
    expired: '已过期'
  }
  return map[props.note.status] || props.note.status
})

const isActive = computed(() => props.note.status === 'active')
const isTerminal = computed(() => ['completed', 'cancelled', 'expired'].includes(props.note.status))

// ---- 联动逻辑 ----
const canEnableNotify = computed(() => !!effectiveAt.value)

watch(effectiveAt, (val) => {
  if (!val && notifyEnabled.value) notifyEnabled.value = false
})

// ---- 日期快捷选项 ----
const today = computed(() => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
})

const dateShortcuts = [
  { label: '今天', getValue: () => new Date() },
  { label: '明天', getValue: () => { const d = new Date(); d.setDate(d.getDate() + 1); return d } },
  { label: '三天后', getValue: () => { const d = new Date(); d.setDate(d.getDate() + 3); return d } }
]

// ============================================================
// 预填数据
// ============================================================
watch(() => props.note, (n) => {
  if (!n) return
  content.value = n.content || ''
  tagNames.value = n.tags?.map(t => t.name) || []
  isPinned.value = !!n.is_pinned
  notifyEnabled.value = !!n.notify_enabled
  if (n.effective_at && n.effective_at > 0) {
    effectiveAt.value = new Date(n.effective_at).toISOString().slice(0, 19).replace('T', ' ')
  } else {
    effectiveAt.value = ''
  }
}, { immediate: true })

// ============================================================
// 图片 ←→ 标签双向联动
// ============================================================
function onImageCountChange(count) {
  const hasImgTag = tagNames.value.includes('图片')
  if (count > 0 && !hasImgTag) {
    tagNames.value = [...tagNames.value, '图片']
  } else if (count === 0 && hasImgTag) {
    tagNames.value = tagNames.value.filter((t) => t !== '图片')
  }
}

// ============================================================
// 保存
// ============================================================
async function handleSave() {
  if (saving.value) return

  const text = content.value.trim()
  if (!text) {
    showMessage('warning', '请输入便签内容')
    return
  }

  saving.value = true
  try {
    const fields = {
      content: text,
      is_pinned: isPinned.value ? 1 : 0
    }

    if (isActive.value) {
      if (effectiveAt.value) {
        fields.effective_at = new Date(effectiveAt.value).getTime()
      }
      fields.notify_enabled = notifyEnabled.value ? 1 : 0
    }

    await window.api.updateNote(props.note.id, fields)

    if (tagNames.value.length > 0) {
      await window.api.setNoteTags(props.note.id, [...tagNames.value])
    }

    showMessage('success', '便签已保存')
    emit('saved')
  } catch (e) {
    console.error('[NoteEditor] 保存失败:', e)
    showMessage('error', e.message || '保存失败，请重试')
  } finally {
    saving.value = false
  }
}

// ============================================================
// 状态流转
// ============================================================
async function handleStartProgress() {
  try {
    const updated = await window.api.startProgress(props.note.id)
    if (updated) {
      showMessage('success', '已切换为进行中')
      emit('saved')
    }
  } catch (e) {
    showMessage('error', '状态切换失败')
  }
}

async function handleComplete() {
  try {
    const updated = await window.api.completeNote(props.note.id)
    if (updated) {
      showMessage('success', '已完成')
      emit('saved')
    }
  } catch (e) {
    showMessage('error', '状态切换失败')
  }
}

async function handleCancel() {
  try {
    const updated = await window.api.cancelNote(props.note.id)
    if (updated) {
      showMessage('success', '已取消')
      emit('saved')
    }
  } catch (e) {
    showMessage('error', '状态切换失败')
  }
}
</script>

<template>
  <div class="ne-root" :class="{ 'ne-enter': mounted }">
    <!-- 可滚动表单区域 -->
    <div class="ne-body scroll-y">
      <!-- 状态标签 -->
      <div class="ne-status-row ne-stagger" style="animation-delay: 0ms">
        <span class="ne-status-label">状态</span>
        <span class="ne-status-tag" :class="'ne-status--' + note.status">{{ statusLabel }}</span>
      </div>

      <!-- 便签内容 -->
      <textarea
        v-model="content"
        class="ne-textarea ne-stagger"
        style="animation-delay: 30ms"
        placeholder="输入便签内容…（Enter 换行）"
        rows="4"
      />

      <!-- 生效时间（仅 active 状态） -->
      <div
        v-if="isActive"
        class="ne-field-row ne-stagger"
        style="animation-delay: 60ms"
      >
        <label class="ne-field-label">生效时间<HelpButton text="设置后便签将在指定时间生效。未设置则立即生效。" /></label>
        <DateTimePicker
          v-model="effectiveAt"
          placeholder="立即生效"
          :min-date="today"
          :shortcuts="dateShortcuts"
        />
      </div>

      <!-- 启用系统提醒（仅 active 状态） -->
      <div
        v-if="isActive"
        class="ne-field-row ne-stagger"
        style="animation-delay: 90ms"
      >
        <label class="ne-field-label">启用系统提醒<HelpButton text="仅在设置生效时间后才可开启。" /></label>
        <AppToggle v-model="notifyEnabled" :disabled="!canEnableNotify" />
      </div>

      <!-- 置顶 -->
      <div class="ne-field-row ne-stagger" style="animation-delay: 120ms">
        <label class="ne-field-label">置顶<HelpButton text="开启后便签将固定在列表顶部。" /></label>
        <AppToggle v-model="isPinned" />
      </div>

      <!-- 标签 -->
      <div class="ne-field ne-group-gap ne-stagger" style="animation-delay: 160ms">
        <label class="ne-field-label">标签<HelpButton text="为便签添加分类标签，便于筛选和管理。" /></label>
        <TagSelector v-model="tagNames" />
      </div>

      <!-- 图片 -->
      <div class="ne-field ne-stagger" style="animation-delay: 190ms">
        <label class="ne-field-label">图片<HelpButton text="支持截图、拖拽或点击上传。单张最大 50MB，单条便签最多 50 张。" /></label>
        <ScreenshotPicker
          ref="imagePickerRef"
          :note-id="note.id"
          mode="persist"
          @count-change="onImageCountChange"
        />
      </div>
    </div>

    <!-- 底部操作区：状态流转 + 保存按钮 -->
    <div class="ne-footer ne-stagger" style="animation-delay: 240ms">
      <!-- 状态流转按钮（非终态时显示） -->
      <div v-if="!isTerminal" class="ne-actions">
        <button
          v-if="note.status === 'active'"
          class="ne-action-btn ne-action-btn--start"
          :disabled="saving"
          @click="handleStartProgress"
        >开始处理</button>
        <button
          v-if="note.status === 'active' || note.status === 'in_progress'"
          class="ne-action-btn ne-action-btn--complete"
          :disabled="saving"
          @click="handleComplete"
        >完成</button>
        <button
          class="ne-action-btn ne-action-btn--cancel"
          :disabled="saving"
          @click="handleCancel"
        >取消</button>
      </div>
      <div class="ne-spacer" />
      <button
        class="ne-submit"
        :disabled="!content.trim() || saving"
        @click="handleSave"
      >
        {{ saving ? '保存中…' : '保存修改' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* === 根容器（与 NewNotePanel .nnp-root 结构一致） === */
.ne-root {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

/* === 可滚动表单体 === */
.ne-body {
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

/* === 逐层淡入动效 === */
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

/* === 状态标签行 === */
.ne-status-row {
  display: flex;
  align-items: center;
  gap: 10rem;
  padding: 6rem 0 10rem;
}

.ne-status-label {
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
  font-weight: 500;
  flex-shrink: 0;
}

.ne-status-tag {
  display: inline-flex;
  align-items: center;
  padding: 3rem 10rem;
  border-radius: 4rem;
  font-size: var(--fs-secondary);
  font-weight: 500;
  background: color-mix(in srgb, var(--text-color) 8%, transparent);
  white-space: nowrap;
}

.ne-status--active       { color: #007aff; }
.ne-status--in_progress  { color: #ff9500; }
.ne-status--completed    { color: #34c759; }
.ne-status--cancelled    { color: #ff3b30; }
.ne-status--expired      { color: #8e8e93; }

/* === 文本域 === */
.ne-textarea {
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

.ne-textarea:focus {
  border-color: rgb(var(--bg-color, 255 255 255) / 0.18);
}

.ne-textarea::placeholder {
  color: var(--text-color-secondary);
  opacity: 0.5;
}

/* === 表单字段 === */
.ne-field {
  margin-top: 12rem;
  display: flex;
  flex-direction: column;
  gap: 6rem;
  min-width: 0;
}

.ne-field-label {
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
  font-weight: 500;
}

/* === 行内字段：label 左 + 组件右 === */
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

/* === 视觉分组间距 === */
.ne-group-gap {
  margin-top: 20rem;
}

/* === 底部操作区 === */
.ne-footer {
  display: flex;
  align-items: center;
  gap: 8rem;
  padding: 0 14rem;
  flex-shrink: 0;
}

.ne-actions {
  display: flex;
  gap: 6rem;
  flex-shrink: 0;
}

.ne-spacer {
  flex: 1;
}

/* 状态流转按钮 */
.ne-action-btn {
  padding: 6rem 12rem;
  font-size: var(--fs-secondary);
  font-family: inherit;
  font-weight: 500;
  border: none;
  border-radius: 6rem;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color 150ms ease,
    opacity 150ms ease;
}

.ne-action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.ne-action-btn--start {
  background: rgba(0, 122, 255, 0.15);
  color: #007aff;
}

.ne-action-btn--start:hover:not(:disabled) {
  background: rgba(0, 122, 255, 0.25);
}

.ne-action-btn--complete {
  background: rgba(52, 199, 89, 0.15);
  color: #34c759;
}

.ne-action-btn--complete:hover:not(:disabled) {
  background: rgba(52, 199, 89, 0.25);
}

.ne-action-btn--cancel {
  background: rgba(255, 59, 48, 0.12);
  color: #ff3b30;
}

.ne-action-btn--cancel:hover:not(:disabled) {
  background: rgba(255, 59, 48, 0.22);
}

/* 保存按钮 */
.ne-submit {
  padding: 8rem 20rem;
  font-size: var(--fs-body);
  font-family: inherit;
  font-weight: 600;
  color: #fff;
  background: #0071e3;
  border: none;
  border-radius: 8rem;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background-color 150ms ease;
}

.ne-submit:hover:not(:disabled) {
  background: #0077ed;
}

.ne-submit:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
