<script setup>
/**
 * NoteEditor.vue — 便签编辑器
 *
 * 职责：
 *   1. 创建 / 更新便签内容
 *   2. 状态流转控制（开始处理 / 完成 / 取消）
 *   3. 自动保存（防抖 500ms）
 *
 * Props:
 *   note  — 当前编辑的便签对象（null = 新建模式）
 *
 * 依赖：
 *   window.api.createNote()        — 创建便签
 *   window.api.updateNote()        — 更新便签
 *   window.api.startProgress()     — 开始处理
 *   window.api.completeNote()      — 完成
 *   window.api.cancelNote()        — 取消
 */
import { ref, watch, onBeforeUnmount } from 'vue'

const props = defineProps({
  note: { type: Object, default: null }
})

const emit = defineEmits(['saved', 'close'])

/** 编辑区文本 */
const content = ref('')
/** 保存状态 */
const saving = ref(false)
/** 防抖定时器 */
let saveTimer = null

/**
 * 当传入便签变化时，同步文本
 */
watch(
  () => props.note,
  (newNote) => {
    if (newNote) {
      content.value = newNote.content || ''
    } else {
      content.value = ''
    }
  },
  { immediate: true }
)

/**
 * 防抖自动保存
 */
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    doSave()
  }, 500)
}

/**
 * 执行保存
 */
async function doSave() {
  if (!props.note) return

  const text = content.value
  saving.value = true
  try {
    await window.api.updateNote(props.note.id, {
      content: text
    })
    emit('saved', { ...props.note, content: text })
  } catch (e) {
    console.error('[NoteEditor] 保存失败:', e)
  } finally {
    saving.value = false
  }
}

/**
 * 输入事件 → 触发防抖保存
 */
function onInput() {
  scheduleSave()
}

/**
 * 状态流转：开始处理
 */
async function handleStartProgress() {
  if (!props.note) return
  try {
    const updated = await window.api.startProgress(props.note.id)
    if (updated) emit('saved', updated)
  } catch (e) {
    console.error('[NoteEditor] 状态切换失败:', e)
  }
}

/**
 * 状态流转：完成
 */
async function handleComplete() {
  if (!props.note) return
  try {
    const updated = await window.api.completeNote(props.note.id)
    if (updated) emit('saved', updated)
  } catch (e) {
    console.error('[NoteEditor] 状态切换失败:', e)
  }
}

/**
 * 状态流转：取消
 */
async function handleCancel() {
  if (!props.note) return
  try {
    const updated = await window.api.cancelNote(props.note.id)
    if (updated) emit('saved', updated)
  } catch (e) {
    console.error('[NoteEditor] 状态切换失败:', e)
  }
}

/**
 * 状态是否可操作
 */
function canStartProgress() {
  return props.note?.status === 'active'
}
function canComplete() {
  return props.note?.status === 'active' || props.note?.status === 'in_progress'
}
function canCancel() {
  return props.note && !['completed', 'cancelled', 'expired'].includes(props.note.status)
}

// 组件卸载前清除定时器
onBeforeUnmount(() => {
  if (saveTimer) {
    clearTimeout(saveTimer)
    // 最后做一次同步保存
    doSave()
  }
})
</script>

<template>
  <div class="note-editor">
    <!-- 顶部工具栏 -->
    <div class="note-editor__toolbar">
      <button class="note-editor__back-btn" @click="emit('close')">←</button>
      <div class="note-editor__spacer" />
      <span v-if="saving" class="note-editor__save-label">保存中…</span>
      <template v-if="note">
        <button
          v-if="canStartProgress()"
          class="note-editor__action-btn note-editor__action-btn--start"
          @click="handleStartProgress"
        >
          开始处理
        </button>
        <button
          v-if="canComplete()"
          class="note-editor__action-btn note-editor__action-btn--complete"
          @click="handleComplete"
        >
          完成
        </button>
        <button
          v-if="canCancel()"
          class="note-editor__action-btn note-editor__action-btn--cancel"
          @click="handleCancel"
        >
          取消
        </button>
      </template>
    </div>

    <!-- 编辑器主体 -->
    <textarea
      v-if="note"
      class="note-editor__textarea"
      :value="content"
      placeholder="输入便签内容…（支持 Markdown）"
      @input="onInput"
    />
    <div v-else class="note-editor__empty">
      <p>选择一条便签开始编辑</p>
    </div>
  </div>
</template>

<style scoped>
.note-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.note-editor__toolbar {
  display: flex;
  align-items: center;
  gap: 8rem;
  padding: 10rem 14rem;
  border-bottom: 1px solid rgba(128, 128, 128, 0.15);
  flex-shrink: 0;
}

.note-editor__back-btn {
  width: 32rem;
  height: 32rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6rem;
  background: transparent;
  color: var(--text-color);
  font-size: var(--fs-body);
  font-family: inherit;
  cursor: pointer;
}
.note-editor__back-btn:hover {
  background: rgba(128, 128, 128, 0.1);
}

.note-editor__spacer {
  flex: 1;
}

.note-editor__save-label {
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
}

.note-editor__action-btn {
  padding: 5rem 12rem;
  font-size: var(--fs-secondary);
  font-family: inherit;
  font-weight: 500;
  border: none;
  border-radius: 6rem;
  cursor: pointer;
  transition: background-color 150ms ease;
}

.note-editor__action-btn--start {
  background: rgba(0, 122, 255, 0.15);
  color: #007aff;
}
.note-editor__action-btn--start:hover {
  background: rgba(0, 122, 255, 0.25);
}

.note-editor__action-btn--complete {
  background: rgba(52, 199, 89, 0.15);
  color: #34c759;
}
.note-editor__action-btn--complete:hover {
  background: rgba(52, 199, 89, 0.25);
}

.note-editor__action-btn--cancel {
  background: rgba(255, 59, 48, 0.12);
  color: #ff3b30;
}
.note-editor__action-btn--cancel:hover {
  background: rgba(255, 59, 48, 0.22);
}

.note-editor__textarea {
  flex: 1;
  padding: 14rem 16rem;
  border: none;
  outline: none;
  resize: none;
  font-family: inherit;
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--text-color);
  background: transparent;
  line-height: 1.6;
}
.note-editor__textarea::placeholder {
  color: var(--text-color-secondary);
}

.note-editor__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
}
</style>
