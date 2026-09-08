<script setup>
import { useDraftProtection } from '../../composables/useDraftProtection.js'
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, useId } from 'vue'
import { useMessage } from '../../composables/useMessage.js'

const props = defineProps({
  note: { type: Object, required: true },
  anchorRect: { type: Object, required: true }
})
const emit = defineEmits(['close', 'saved'])
const { showMessage } = useMessage()
const hintId = useId()

const editorRef = ref(null)
const textareaRef = ref(null)
const originalContent = ref(String(props.note.content || ''))
const draft = ref(originalContent.value)
const conflict = ref(false)
const positionStyle = reactive({ left: '12px', top: '12px', visibility: 'hidden' })
const phase = ref('editing')
let pendingSave = null
let mounted = false
let validationResetTimer = null

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function positionEditor() {
  const editor = editorRef.value
  if (!editor) return
  const bounds = editor.getBoundingClientRect()
  const anchor = props.anchorRect
  const viewportPadding = 12
  const gap = 8
  const maxLeft = Math.max(viewportPadding, window.innerWidth - bounds.width - viewportPadding)
  const maxTop = Math.max(viewportPadding, window.innerHeight - bounds.height - viewportPadding)
  const preferredTop = anchor.bottom + gap
  const top =
    preferredTop + bounds.height <= window.innerHeight - viewportPadding
      ? preferredTop
      : anchor.top - bounds.height - gap

  positionStyle.left = `${clamp(anchor.left, viewportPadding, maxLeft)}px`
  positionStyle.top = `${clamp(top, viewportPadding, maxTop)}px`
  positionStyle.visibility = 'visible'
}

function focusEditor() {
  const textarea = textareaRef.value
  if (!textarea) return
  textarea.focus({ preventScroll: true })
  const caret = textarea.value.length
  textarea.setSelectionRange(caret, caret)
}

function closeEditor() {
  if (phase.value === 'closed') return
  protectedDraft.clear()
  phase.value = 'closed'
  emit('close')
}

async function commit() {
  if (phase.value === 'closed') return true
  if (phase.value === 'saving') return pendingSave
  if (phase.value === 'invalid' || conflict.value) return false

  const content = draft.value.replace(/\r\n?/g, '\n')
  if (!content.trim()) {
    phase.value = 'invalid'
    showMessage('warning', '请输入便签内容')
    await nextTick()
    if (mounted) focusEditor()
    validationResetTimer = setTimeout(() => {
      validationResetTimer = null
      if (phase.value === 'invalid') phase.value = 'editing'
    }, 0)
    return false
  }
  if (content === originalContent.value) {
    closeEditor()
    return true
  }

  phase.value = 'saving'
  pendingSave = window.api
    .updateNote(props.note.id, { content }, originalContent.value)
    .then((updated) => {
      if (!updated) throw new Error('便签不存在或已被删除')
      showMessage('success', '便签已保存')
      emit('saved', updated)
      closeEditor()
      return true
    })
    .catch(async (error) => {
      console.error('[QuickNoteContentEditor] 保存失败:', props.note.id, error)
      phase.value = 'editing'
      conflict.value = true
      showMessage('error', error.message || '保存失败，请重试')
      await nextTick()
      if (mounted) focusEditor()
      return false
    })
    .finally(() => {
      pendingSave = null
    })
  return pendingSave
}

function cancel(event) {
  if (event.isComposing || phase.value !== 'editing') return
  event.preventDefault()
  event.stopPropagation()
  closeEditor()
}

function onFocusOut(event) {
  if (editorRef.value?.contains(event.relatedTarget)) return
  void commit()
}

function onDocumentPointerDown(event) {
  if (editorRef.value?.contains(event.target)) return
  void commit()
}

function onViewportChange(event) {
  if (editorRef.value?.contains(event?.target)) return
  void commit()
}

onMounted(async () => {
  mounted = true
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  window.addEventListener('blur', commit)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
  await nextTick()
  positionEditor()
  requestAnimationFrame(focusEditor)
})

onBeforeUnmount(() => {
  mounted = false
  if (validationResetTimer) clearTimeout(validationResetTimer)
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  window.removeEventListener('blur', commit)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
})
const protectedDraft = useDraftProtection({
  key: 'quick:' + props.note.id,
  fields: { draft, originalContent },
  dirty: () => draft.value !== originalContent.value,
  busy: () => phase.value === 'saving'
})
function retrySave() {
  conflict.value = false
  void commit()
}

async function loadLatest() {
  try {
    const current = await window.api.getNote(props.note.id)
    if (!current) {
      showMessage('error', '便签已删除，草稿仍保留')
      return
    }
    originalContent.value = current.content
    draft.value = current.content
    conflict.value = false
  } catch (error) {
    showMessage('error', error.message || '加载失败，草稿仍保留')
  }
}
async function copyDraft() {
  try {
    await navigator.clipboard.writeText(draft.value)
    showMessage('success', '草稿已复制')
  } catch {
    showMessage('error', '复制失败，请选中正文手动复制')
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="quick-note-editor" appear>
      <section
        ref="editorRef"
        class="quick-note-editor"
        :class="{ 'is-saving': phase === 'saving' }"
        :style="positionStyle"
        role="dialog"
        aria-label="快速修改便签正文"
        @focusout="onFocusOut"
        @keydown.esc="cancel"
      >
        <textarea
          ref="textareaRef"
          v-model="draft"
          :aria-describedby="hintId"
          :disabled="phase === 'saving'"
          spellcheck="true"
        />
        <div v-if="conflict" class="quick-note-editor__recovery">
          <span>保存未完成，草稿已保留。</span>
          <button type="button" @click="copyDraft">复制草稿</button>
          <button type="button" @click="retrySave">重试保存</button>
          <button type="button" @click="loadLatest">放弃草稿并加载最新正文</button>
        </div>
        <div :id="hintId" class="quick-note-editor__hint" aria-live="polite">
          {{ phase === 'saving' ? '正在保存…' : '失焦自动保存 · Esc 取消' }}
        </div>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.quick-note-editor__recovery {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px;
}
.quick-note-editor__recovery span {
  flex-basis: 100%;
  color: var(--text-color-secondary);
}
.quick-note-editor__recovery button {
  padding: 4px 6px;
  border: 0;
  border-radius: 6px;
  background: var(--ui-fill-passive);
  color: var(--text-color);
  font: inherit;
  cursor: pointer;
}
.quick-note-editor__recovery button:hover {
  background: var(--ui-fill-hover);
}

.quick-note-editor {
  position: fixed;
  z-index: var(--z-global-editor);
  width: min(360px, calc(100vw - 24px));
  padding: 9px 10px 7px;
  border: 1px solid var(--ui-border-control);
  border-radius: 14px;
  background: var(--surface-float);
  box-shadow:
    0 14px 34px color-mix(in srgb, var(--text-color) 18%, transparent),
    0 2px 8px color-mix(in srgb, var(--text-color) 10%, transparent);
  color: var(--text-color);
  transform-origin: top left;
  transition:
    border-color 150ms ease,
    box-shadow 150ms ease;
}

.quick-note-editor:focus-within {
  border-color: color-mix(in srgb, var(--ui-accent) 72%, transparent);
  box-shadow:
    0 0 0 3px var(--ui-accent-subtle),
    0 14px 34px color-mix(in srgb, var(--text-color) 18%, transparent);
}

.quick-note-editor textarea {
  display: block;
  width: 100%;
  min-height: 112px;
  max-height: min(260px, calc(100vh - 96px));
  padding: 5px 6px;
  overflow: auto;
  border: 0;
  outline: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 1.55;
  resize: vertical;
}

.quick-note-editor.is-saving textarea {
  opacity: 0.66;
}

.quick-note-editor__hint {
  padding: 4px 6px 1px;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  line-height: 1.3;
  text-align: right;
  user-select: none;
}

.quick-note-editor-enter-active,
.quick-note-editor-leave-active {
  transition:
    opacity 160ms ease,
    transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
}

.quick-note-editor-enter-from,
.quick-note-editor-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}
</style>
