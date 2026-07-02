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

import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useMessage } from '../composables/useMessage.js'

const props = defineProps({
  modelValue: { type: Number, default: 16 },
  presets: { type: Array, default: () => [14, 15, 16, 17, 18, 19, 20] },
  min: { type: Number, default: 12 },
  max: { type: Number, default: 24 },
  width: { type: [String, Number], default: '' },
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

// ============ Sync external model → input text ============
watch(() => props.modelValue, (v) => {
  inputText.value = String(v)
})

// ============ Methods ============
function onInput(e) {
  inputText.value = e.target.value
  // 用户开始编辑时清除之前的警告边框
  if (hasWarning.value) {
    hasWarning.value = false
    if (warningTimer) { clearTimeout(warningTimer); warningTimer = null }
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

function onBlur() {
  commit()
  // 延迟关闭下拉，让选项的 click 事件先触发
  setTimeout(() => { open.value = false }, 150)
}

function onKeydown(e) {
  if (e.key === 'Enter') {
    commit()
    open.value = false
    inputRef.value?.blur()
  }
  if (e.key === 'Escape') {
    inputText.value = String(props.modelValue)
    open.value = false
    inputRef.value?.blur()
  }
}

function selectPreset(n) {
  inputText.value = String(n)
  emit('update:modelValue', n)
  open.value = false
  inputRef.value?.focus()
}

function toggle() {
  if (open.value) {
    open.value = false
  } else {
    open.value = true
    inputRef.value?.focus()
  }
}

// ============ 下拉动画（同 StyledSelect） ============
function onBeforeEnter(el) {
  el.style.height = '0'
}
function onEnter(el, done) {
  const h = el.scrollHeight
  el.animate(
    [{ height: '0px' }, { height: h + 'px' }],
    { duration: 350, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'forwards' }
  ).onfinish = () => {
    el.style.height = 'auto'
    done()
  }
}
function onBeforeLeave(el) {
  el.style.height = el.scrollHeight + 'px'
}
function onLeave(el, done) {
  el.animate(
    [{ height: el.scrollHeight + 'px' }, { height: '0px' }],
    { duration: 200, easing: 'cubic-bezier(0.42, 0, 1, 1)', fill: 'forwards' }
  ).onfinish = done
}

// ============ 点击外部关闭 ============
function onDocClick(e) {
  if (!open.value) return
  if (wrapperRef.value?.contains(e.target)) return
  open.value = false
}

onMounted(() => document.addEventListener('click', onDocClick, true))
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true)
  if (warningTimer) clearTimeout(warningTimer)
})
</script>

<template>
  <div ref="wrapperRef" class="fsi-wrapper" :style="width ? { width: typeof width === 'number' ? width + 'px' : width } : {}">
    <!-- 触发器：输入框 + 下拉箭头 -->
    <div class="fsi-trigger" :class="{ 'is-open': open, 'has-warning': hasWarning }">
      <input
        ref="inputRef"
        class="fsi-input"
        type="text"
        inputmode="numeric"
        :value="inputText"
        @input="onInput"
        @focus="onFocus"
        @blur="onBlur"
        @keydown="onKeydown"
      />
      <button class="fsi-arrow-btn" tabindex="-1" @click="toggle">
        <svg class="fsi-arrow" :class="{ 'is-open': open }" width="10" height="6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <!-- 下拉预设面板 -->
    <Transition
      @before-enter="onBeforeEnter"
      @enter="onEnter"
      @before-leave="onBeforeLeave"
      @leave="onLeave"
    >
      <div v-if="open" class="fsi-panel-wrap app-bg" @click.stop>
        <div class="fsi-panel">
          <button
            v-for="n in presets"
            :key="n"
            class="fsi-option"
            :class="{ 'is-active': modelValue === n }"
            @mousedown.prevent="selectPreset(n)"
          >
            {{ n }}
          </button>
        </div>
      </div>
    </Transition>
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
  background-color: rgb(var(--bg-color) / var(--popup-opacity));
  border: 1rem solid color-mix(in srgb, var(--text-color) 15%, transparent);
  border-radius: 6rem;
  transition: border-color 150ms ease;
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
  transition: background-color 120ms ease;
}
.fsi-arrow-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}

.fsi-arrow {
  flex-shrink: 0;
  opacity: 0.45;
  color: var(--text-color);
  transition: transform 200ms ease;
}
.fsi-arrow.is-open {
  transform: rotate(180deg);
}

/* ============ 下拉面板 ============ */
.fsi-panel-wrap {
  position: absolute;
  top: calc(100% + 4rem);
  left: 0;
  right: 0;
  z-index: 100;
  border-radius: 10rem;
  box-shadow: 0 4rem 24rem rgba(0, 0, 0, 0.35);
  overflow: hidden;
}
.fsi-panel {
  padding: 4rem 0;
  max-height: 256rem;
  overflow-y: auto;
}

/* ============ 预设选项 ============ */
.fsi-option {
  display: block;
  width: 100%;
  padding: 7rem 14rem;
  font-size: var(--fs-body);
  font-family: inherit;
  color: var(--text-color);
  background: transparent;
  border: none;
  text-align: center;
  cursor: pointer;
  white-space: nowrap;
  outline: none;
  transition: background-color 120ms ease;
}
.fsi-option:hover {
  background-color: rgba(255, 255, 255, 0.1);
}
.fsi-option.is-active {
  color: #0071e3;
  background-color: rgba(0, 113, 227, 0.12);
  font-weight: 600;
}
</style>
