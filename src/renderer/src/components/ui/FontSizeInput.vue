<script setup>
/**
 * FontSizeInput.vue — 输入选择框（输入框 + 下拉预设值）
 *
 * 继承 StyledSelect 的视觉风格，但将 trigger 改为可编辑的 <input>，
 * 下拉面板展示预设值供快速点选。
 *
 * Props:
 *   modelValue  — 当前数值（v-model 绑定）
 *   presets     — 预设值数组，默认 [14, 15, 16, 17, 18, 19, 20]
 *   min         — 最小允许值
 *   max         — 最大允许值
 *   width       — 组件宽度（CSS 字符串）
 *
 * Events:
 *   update:modelValue — v-model 更新
 */

import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { popoverStyle, measurePopoverContent } from '../../utils/anchoredPopover.js'
import { usePopoverLifecycle } from '../../composables/usePopoverLifecycle.js'
import { isComposingInput } from '../../utils/inputComposition.js'
import { useMessage } from '../../composables/useMessage.js'
import { enterPopover, leavePopover } from '../../utils/popoverMotion.js'

const props = defineProps({
  modelValue: { type: Number, default: 16 },
  presets: { type: Array, default: () => [14, 15, 16, 17, 18, 19, 20] },
  min: { type: Number, default: 12 },
  max: { type: Number, default: 24 },
  width: { type: [String, Number], default: '' }
})

const emit = defineEmits(['update:modelValue'])
const { showMessage } = useMessage()

// ============ State ============
const open = ref(false)
const hasWarning = ref(false)
const wrapperRef = ref(null)
const inputRef = ref(null)
const inputText = ref(String(props.modelValue))
let warningTimer = null
const panelRef = ref(null)
const panelStyle = ref({})
usePopoverLifecycle(open, wrapperRef, panelRef, updatePanelPosition)
function updatePanelPosition() {
  if (!wrapperRef.value) return
  const rect = wrapperRef.value.getBoundingClientRect()
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 1
  const natural = measurePopoverContent(panelRef.value)
  const width = Math.min(
    Math.max(rect.width, 90 * rem, natural?.width || 0),
    window.innerWidth - 16
  )
  const contentHeight = measurePopoverContent(panelRef.value, width)?.height || 256 * rem
  panelStyle.value = popoverStyle(rect, width, Math.min(256 * rem, contentHeight))
}

// ============ Sync external model → input text ============
watch(
  () => props.modelValue,
  (v) => {
    inputText.value = String(v)
  }
)

// ============ Methods ============
function onInput(e) {
  inputText.value = e.target.value
  // 用户开始编辑时清除之前的警告边框
  if (hasWarning.value) {
    hasWarning.value = false
    if (warningTimer) {
      clearTimeout(warningTimer)
      warningTimer = null
    }
  }
}

function showWarning(text) {
  showMessage('warning', text)
  hasWarning.value = true
  if (warningTimer) clearTimeout(warningTimer)
  warningTimer = setTimeout(() => {
    hasWarning.value = false
    warningTimer = null
  }, 3000)
}

function commit() {
  const raw = inputText.value.trim()

  // 空输入 → 恢复
  if (raw === '') {
    inputText.value = String(props.modelValue)
    return
  }

  const num = parseInt(raw, 10)

  // 非数字 → 提示 + 恢复
  if (isNaN(num)) {
    showWarning('请输入数字')
    inputText.value = String(props.modelValue)
    return
  }

  // 超出最小值 → 提示 + 恢复
  if (num < props.min) {
    showWarning(`最小为 ${props.min}`)
    inputText.value = String(props.modelValue)
    return
  }

  // 超出最大值 → 提示 + 恢复
  if (num > props.max) {
    showWarning(`最大为 ${props.max}`)
    inputText.value = String(props.modelValue)
    return
  }

  // 合法值 → 生效
  inputText.value = String(num)
  emit('update:modelValue', num)
}

function onFocus() {
  open.value = true
}
function onBlur(event) {
  if (panelRef.value?.contains(event.relatedTarget)) return
  commit()
  if (!wrapperRef.value?.contains(event.relatedTarget)) open.value = false
}
function onKeydown(event) {
  if (isComposingInput(event)) return
  if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault()
    open.value = true
    nextTick(() => {
      const options = panelRef.value?.querySelectorAll('button:not(:disabled)') || []
      options[event.key === 'ArrowUp' ? options.length - 1 : 0]?.focus()
    })
  } else if (event.key === 'Enter' || event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Enter') commit()
    else inputText.value = String(props.modelValue)
    open.value = false
  }
}
function onPanelKeydown(event) {
  if (isComposingInput(event)) return
  if (event.key === 'Escape' || event.key === 'Tab') {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
    }
    inputRef.value?.focus({ preventScroll: true })
    open.value = false
    return
  }
  const options = [...(panelRef.value?.querySelectorAll('button:not(:disabled)') || [])]
  if (!options.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const index = options.indexOf(document.activeElement)
  const target =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length
  options[target]?.focus()
}
function selectPreset(n) {
  if (n < props.min || n > props.max) return
  inputText.value = String(n)
  emit('update:modelValue', n)
  inputRef.value?.focus({ preventScroll: true })
  open.value = false
}
function toggle() {
  open.value = !open.value
}

function onEnter(el, done) {
  enterPopover(el, done, 'dropdown')
}
function onLeave(el, done) {
  leavePopover(el, done, 'dropdown')
}

// ============ 点击外部关闭 ============
function onDocClick(e) {
  if (!open.value) return
  if (wrapperRef.value?.contains(e.target) || panelRef.value?.contains(e.target)) return
  open.value = false
}

onMounted(() => document.addEventListener('click', onDocClick, true))
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true)
  if (warningTimer) clearTimeout(warningTimer)
})
</script>

<template>
  <div
    ref="wrapperRef"
    class="fsi-wrapper"
    :style="width ? { width: typeof width === 'number' ? width + 'px' : width } : {}"
  >
    <!-- 触发器：输入框 + 下拉箭头 -->
    <div class="fsi-trigger" :class="{ 'is-open': open, 'has-warning': hasWarning }">
      <input
        ref="inputRef"
        class="fsi-input"
        type="text"
        inputmode="numeric"
        aria-label="字号"
        aria-haspopup="listbox"
        :aria-expanded="open"
        :value="inputText"
        @input="onInput"
        @focus="onFocus"
        @blur="onBlur"
        @keydown="onKeydown"
      />
      <button
        type="button"
        class="fsi-arrow-btn"
        aria-label="字号预设"
        aria-haspopup="listbox"
        :aria-expanded="open"
        tabindex="-1"
        @mousedown.prevent
        @click="toggle"
      >
        <svg
          class="fsi-arrow"
          :class="{ 'is-open': open }"
          width="10"
          height="6"
          aria-hidden="true"
        >
          <path
            d="M1 1l4 4 4-4"
            stroke="currentColor"
            stroke-width="1.5"
            fill="none"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>

    <!-- 下拉预设面板 -->
    <Teleport to="body">
      <Transition :css="false" @enter="onEnter" @leave="onLeave">
        <div
          v-if="open"
          ref="panelRef"
          class="fsi-panel-wrap"
          :style="panelStyle"
          @keydown="onPanelKeydown"
          @click.stop
        >
          <div class="fsi-panel-glass">
            <div class="fsi-panel scroll-y" role="listbox" aria-label="字号预设">
              <button
                v-for="n in presets"
                :key="n"
                class="fsi-option"
                :class="{ 'is-active': modelValue === n }"
                type="button"
                role="option"
                :aria-selected="modelValue === n"
                :disabled="n < min || n > max"
                @mousedown.prevent
                @click="selectPreset(n)"
              >
                <span class="fsi-option-check" aria-hidden="true">✓</span>
                <span>{{ n }}</span>
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* ============ 容器 ============ */
.fsi-wrapper {
  position: relative;
  display: inline-block;
}

/* ============ 触发器（自闭环背景+边框，不与 .app-bg 叠加） ============ */
.fsi-trigger {
  display: flex;
  align-items: center;
  gap: 4rem;
  width: 100%;
  padding: 5rem 10rem;
  background: var(--ui-surface-control);
  border: 1px solid var(--ui-border-control);
  border-radius: 6rem;
  transition:
    background-color 160ms ease,
    border-color 160ms ease;
}
.fsi-trigger:hover:not(.has-warning),
.fsi-trigger.is-open:not(.has-warning) {
  border-color: var(--ui-border-hover);
}
.fsi-trigger.has-warning {
  border-color: rgba(255, 59, 48, 0.4);
}

/* ============ 输入框 ============ */
.fsi-input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-color);
  font-size: var(--fs-secondary);
  font-family: inherit;
  font-weight: 500;
  text-align: left;
}
.fsi-trigger:focus-within {
  border-color: var(--ui-border-hover);
}
.fsi-input::selection {
  background: rgba(0, 113, 227, 0.25);
}

/* ============ 箭头按钮 ============ */
.fsi-arrow-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18rem;
  height: 18rem;
  padding: 0;
  border: none;
  border-radius: 4rem;
  background: transparent;
  cursor: pointer;
}

.fsi-arrow {
  flex-shrink: 0;
  opacity: 0.45;
  color: var(--text-color);
  transition:
    transform 200ms ease,
    opacity 160ms ease;
}
.fsi-trigger:hover .fsi-arrow,
.fsi-trigger.is-open .fsi-arrow {
  opacity: 0.78;
}
.fsi-arrow.is-open {
  transform: rotate(180deg);
}

/* ============ 下拉面板 ============ */
.fsi-panel-wrap {
  position: fixed;
  z-index: var(--z-global-popover);
  border-radius: 10rem;
  box-shadow: var(--ui-menu-shadow);
  overflow: hidden;
  transform-origin: top center;
  will-change: clip-path;
}
.fsi-panel-glass {
  background-color: var(--surface-float);
  border: 1px solid var(--surface-float-border);
  border-radius: inherit;
}
.fsi-panel {
  padding: 5rem;
  max-height: calc(var(--popover-available-height) - 2px);
}

/* ============ 预设选项 ============ */
.fsi-option {
  display: grid;
  grid-template-columns: 18rem minmax(0, 1fr);
  align-items: center;
  gap: 6rem;
  width: 100%;
  padding: 5rem 8rem;
  min-height: var(--ui-menu-row-height);
  border-radius: 7rem;
  font-size: inherit;
  font-family: inherit;
  color: var(--text-color);
  background: transparent;
  border: none;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
  outline: none;
  transition: background-color 120ms ease;
}
.fsi-option:hover:not(:disabled),
.fsi-option:focus-visible {
  background-color: var(--ui-menu-highlight);
  color: var(--ui-menu-on-highlight);
}
.fsi-option.is-active {
  font-weight: 600;
}
.fsi-option-check {
  opacity: 0;
  color: var(--ui-accent);
  font-size: 13rem;
}
.fsi-option.is-active .fsi-option-check {
  opacity: 1;
}
.fsi-option:hover .fsi-option-check,
.fsi-option:focus-visible .fsi-option-check {
  color: currentColor;
}
</style>
