<script setup>
import { isComposingInput } from '../../utils/inputComposition.js'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  formatViewVisibilityShortcut,
  shortcutCaptureFromKeyboardEvent
} from '../../../../shared/view-visibility-shortcut.js'
import BaseButton from './BaseButton.vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  runtime: { type: Object, default: null },
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue', 'update:runtime', 'feedback'])

const platform = window.api?.runtimeCapabilities?.platform || 'win32'
const fieldRef = ref(null)
const isCapturing = ref(false)
const isBusy = ref(false)
const capturePreview = ref('')
const localStatus = ref(null)
let captureRequested = false
let componentUnmounted = false

const formattedValue = computed(() => formatViewVisibilityShortcut(props.modelValue, platform))
const fieldValue = computed(() => {
  if (isCapturing.value) return capturePreview.value || '请按下快捷键…'
  return formattedValue.value || '未设置'
})
const actionLabel = computed(() => {
  if (isCapturing.value) return '取消'
  return props.modelValue ? '重新录制' : '录制'
})
const persistentStatus = computed(() => {
  if (props.runtime?.error && props.modelValue && !props.runtime.registered) {
    return {
      type: 'error',
      text: `启动时已保存但注册失败：${props.runtime.error.message || '快捷键被系统或其他应用占用'}`
    }
  }
  if (props.modelValue && props.runtime?.registered !== false) {
    return { type: 'success', text: '快捷键已启用；窗口隐藏到托盘后仍然有效' }
  }
  return { type: 'muted', text: '未设置；点击“录制”，然后直接按下组合键' }
})
const visibleStatus = computed(() => localStatus.value || persistentStatus.value)

function setStatus(type, text) {
  localStatus.value = { type, text }
}

function emitFeedback(type, message, duration) {
  emit('feedback', { type, message, duration })
}

function applyRuntime(runtime) {
  if (runtime) emit('update:runtime', runtime)
}

async function beginCapture() {
  if (props.disabled || isBusy.value || isCapturing.value) return
  isBusy.value = true
  captureRequested = true
  localStatus.value = null
  capturePreview.value = ''
  try {
    const runtime = await window.api.beginViewVisibilityShortcutCapture()
    if (componentUnmounted) {
      await window.api.endViewVisibilityShortcutCapture().catch(() => {})
      return
    }
    applyRuntime(runtime)
    isCapturing.value = true
    setStatus('recording', '正在录制：请按下一个组合键，Esc 取消')
    await nextTick()
    fieldRef.value?.focus({ preventScroll: true })
  } catch (error) {
    captureRequested = false
    setStatus('error', `无法进入录制：${error?.message || '主进程通信失败'}`)
  } finally {
    isBusy.value = false
  }
}

async function cancelCapture({ announce = true } = {}) {
  if (!captureRequested && !isCapturing.value) return
  isBusy.value = true
  try {
    applyRuntime(await window.api.endViewVisibilityShortcutCapture())
  } catch (error) {
    console.warn('[ShortcutRecorder] 结束快捷键录制失败:', error)
  } finally {
    captureRequested = false
    isCapturing.value = false
    isBusy.value = false
    capturePreview.value = ''
    if (announce) setStatus('muted', '已取消录制，原快捷键保持不变')
  }
}

function invalidStatus(code) {
  if (code === 'incomplete') return ['warning', '组合不完整：请再按一个字母、数字或功能键']
  if (code === 'modifier-required') {
    return ['warning', '无效：请至少使用一个修饰键，或单独使用 F1–F12']
  }
  if (code === 'reserved') return ['error', '无效：该组合键属于系统常用操作，请换一个']
  return ['error', '无效：该按键暂不支持，请换一个组合键']
}

async function recordCandidate(accelerator, display) {
  isBusy.value = true
  setStatus('recording', `正在校验：${display}`)
  try {
    const result = await window.api.setViewVisibilityShortcut(accelerator)
    applyRuntime(result?.runtime)
    if (result?.status === 'conflict') {
      setStatus('error', '冲突：该快捷键已被系统或其他应用占用，请换一个')
      return
    }
    if (result?.status === 'invalid') {
      const [type, text] = invalidStatus(result.code)
      setStatus(type, text)
      return
    }
    if (result?.status === 'unchanged') {
      captureRequested = false
      emit('update:modelValue', result.accelerator || props.modelValue)
      isCapturing.value = false
      capturePreview.value = ''
      setStatus('muted', `未变化：${formattedValue.value || display}`)
      return
    }
    if (result?.status === 'saved') {
      captureRequested = false
      emit('update:modelValue', result.accelerator)
      isCapturing.value = false
      capturePreview.value = ''
      const savedDisplay = formatViewVisibilityShortcut(result.accelerator, platform)
      setStatus('success', `保存成功：${savedDisplay}`)
      emitFeedback('success', `视图显示快捷键已保存：${savedDisplay}`)
      return
    }

    await cancelCapture({ announce: false })
    setStatus('error', '保存失败，原快捷键保持不变')
    emitFeedback('error', '快捷键保存失败，已恢复原快捷键', 4000)
  } catch (error) {
    await cancelCapture({ announce: false })
    setStatus('error', `保存失败：${error?.message || '主进程通信失败'}；原快捷键保持不变`)
    emitFeedback('error', '快捷键保存失败，已恢复原快捷键', 4000)
  } finally {
    isBusy.value = false
  }
}

function onKeydown(event) {
  if (isComposingInput(event)) return
  if (!isCapturing.value) return
  event.preventDefault()
  event.stopPropagation()
  if (isBusy.value || event.repeat) return
  const captured = shortcutCaptureFromKeyboardEvent(event, platform)
  capturePreview.value = captured.display

  if (captured.action === 'cancel') {
    void cancelCapture()
    return
  }
  if (captured.action === 'candidate') {
    void recordCandidate(captured.accelerator, captured.display)
    return
  }

  const [type, text] = invalidStatus(captured.code)
  setStatus(type, text)
}

async function toggleCapture() {
  if (isCapturing.value) await cancelCapture()
  else await beginCapture()
}

async function clearShortcut() {
  if (props.disabled || isBusy.value || (!props.modelValue && !isCapturing.value)) return
  isBusy.value = true
  try {
    const result = await window.api.setViewVisibilityShortcut('')
    applyRuntime(result?.runtime)
    if (result?.status !== 'cleared' && result?.status !== 'unchanged') {
      throw new Error('主进程未清除快捷键')
    }
    emit('update:modelValue', '')
    captureRequested = false
    isCapturing.value = false
    capturePreview.value = ''
    setStatus('success', '已清除：视图显示快捷键未设置')
    emitFeedback('success', '视图显示快捷键已清除')
  } catch (error) {
    setStatus('error', `清除失败：${error?.message || '主进程通信失败'}`)
    emitFeedback('error', '快捷键清除失败，请重试', 4000)
  } finally {
    isBusy.value = false
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown, true))

onBeforeUnmount(() => {
  componentUnmounted = true
  window.removeEventListener('keydown', onKeydown, true)
  if (captureRequested || isCapturing.value) {
    void window.api.endViewVisibilityShortcutCapture().catch(() => {})
  }
})
</script>

<template>
  <div class="shortcut-recorder" :class="{ 'is-recording': isCapturing }">
    <div class="shortcut-recorder-controls">
      <input
        ref="fieldRef"
        class="shortcut-recorder-field"
        type="text"
        :value="fieldValue"
        readonly
        inputmode="none"
        aria-label="视图显示快捷键录制框"
        aria-describedby="view-visibility-shortcut-status"
        :disabled="disabled"
        @click="beginCapture"
        @beforeinput.prevent
        @paste.prevent
      />
      <BaseButton size="sm" :disabled="disabled || isBusy" @click="toggleCapture">
        {{ actionLabel }}
      </BaseButton>
      <BaseButton
        size="sm"
        :disabled="disabled || isBusy || (!modelValue && !isCapturing)"
        @click="clearShortcut"
      >
        清除
      </BaseButton>
    </div>
    <p
      id="view-visibility-shortcut-status"
      class="shortcut-recorder-status"
      :class="`is-${visibleStatus.type}`"
      aria-live="polite"
    >
      {{ visibleStatus.text }}
    </p>
  </div>
</template>

<style scoped>
.shortcut-recorder {
  width: min(100%, 430rem);
  min-width: 0;
}

.shortcut-recorder-controls {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6rem;
}

.shortcut-recorder-field {
  min-width: 120rem;
  min-height: 32rem;
  flex: 1;
  padding: 0 10rem;
  border: 1px solid var(--ui-border-control);
  border-radius: 7rem;
  outline: none;
  color: var(--text-color);
  background: var(--ui-surface-control);
  font: inherit;
  font-size: var(--fs-secondary);
  font-weight: 500;
  cursor: pointer;
  caret-color: transparent;
  transition: border-color var(--motion-fast) ease;
}

.shortcut-recorder-field:hover:not(:disabled) {
  border-color: var(--ui-border-hover);
}

.shortcut-recorder-field:focus-visible,
.is-recording .shortcut-recorder-field {
  border-color: var(--ui-accent);
  box-shadow: 0 0 0 2px var(--ui-accent-subtle);
}

.shortcut-recorder-field:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.shortcut-recorder-status {
  min-height: 1.4em;
  margin: 5rem 2rem 0;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.82);
  line-height: 1.4;
}

.shortcut-recorder-status.is-recording {
  color: var(--ui-accent);
}

.shortcut-recorder-status.is-warning {
  color: var(--ui-warning);
}

.shortcut-recorder-status.is-success {
  color: rgb(52, 199, 89);
}

.shortcut-recorder-status.is-error {
  color: rgb(255, 59, 48);
}

@container (max-width: 440px) {
  .shortcut-recorder-controls {
    flex-wrap: wrap;
  }

  .shortcut-recorder-field {
    flex-basis: 100%;
  }
}
</style>
