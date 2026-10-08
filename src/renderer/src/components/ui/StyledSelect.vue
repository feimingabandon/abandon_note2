<script setup>
import {
  popoverStyle,
  measurePopoverContent,
  ownPopover,
  releasePopover
} from '../../utils/anchoredPopover.js'
import { isComposingInput } from '../../utils/inputComposition.js'
import { usePopoverLifecycle } from '../../composables/usePopoverLifecycle.js'
/**
 * StyledSelect.vue — 自定义下拉选择组件
 *
 * 使用 Teleport to="body" + position:fixed 渲染下拉面板，
 *
 * Props:
 *   modelValue  — 当前选中值（v-model 绑定）
 *   options     — 选项数组 [{ label, value }]
 *   placeholder — 占位文本（默认 '-'）
 *   size        — 尺寸 sm / md / lg
 *   width       — 组件宽度（px 或 CSS 字符串）
 *   disabled    — 是否禁用
 *
 * Events:
 *   update:modelValue — v-model 更新
 *   change            — 选中变化，参数为 option 对象 { label, value }
 */

import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { enterPopover, leavePopover } from '../../utils/popoverMotion.js'

const props = defineProps({
  modelValue: { type: [String, Number, Boolean], default: '' },
  options: { type: Array, required: true },
  placeholder: { type: String, default: '-' },
  size: { type: String, default: '' },
  width: { type: [String, Number], default: '' },
  ariaLabel: { type: String, default: '' },
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue', 'change'])

// ============ State ============
const open = ref(false)
const wrapperRef = ref(null)
const panelRef = ref(null)
const panelStyle = ref({})
usePopoverLifecycle(open, wrapperRef, panelRef, updatePanelPosition)
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) open.value = false
  }
)

// ============ Computed ============
const displayLabel = computed(() => {
  const val = props.modelValue
  if (val === '' || val === null || val === undefined) return props.placeholder
  const opt = props.options.find((o) => o.value === val)
  return opt ? opt.label : props.placeholder
})

const sizeClass = computed(() => (props.size ? `sel--${props.size}` : ''))

const wrapperStyle = computed(() => {
  if (!props.width) return {}
  return { width: typeof props.width === 'number' ? props.width + 'px' : props.width }
})

// ============ Methods ============
function toggle() {
  if (props.disabled) return
  if (open.value) {
    open.value = false
    return
  }
  updatePanelPosition()
  open.value = true
}

/** 计算面板 fixed 定位（对齐触发器左下角） */
function updatePanelPosition() {
  if (!wrapperRef.value) return
  const rect = wrapperRef.value.getBoundingClientRect()
  const natural = measurePopoverContent(panelRef.value)
  const width = Math.min(Math.max(rect.width, natural?.width || rect.width), window.innerWidth - 16)
  const fitted = measurePopoverContent(panelRef.value, width)
  panelStyle.value = popoverStyle(rect, width, fitted?.height || 256)
}

function select(opt) {
  if (opt.disabled) return
  emit('update:modelValue', opt.value)
  emit('change', opt)
  open.value = false
  wrapperRef.value?.querySelector('button')?.focus({ preventScroll: true })
}

function onPanelKeydown(event) {
  if (isComposingInput(event)) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    open.value = false
    wrapperRef.value?.querySelector('button')?.focus()
    return
  }
  const options = [...(panelRef.value?.querySelectorAll('button:not(:disabled)') || [])]
  const index = options.indexOf(document.activeElement)
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    const target =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : (index + (event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length
    options[target]?.focus()
  }
  if (event.key === 'Tab') {
    open.value = false
    // Teleport 中的选项位于 body 末尾。先把焦点还给触发器，再让浏览器执行
    // 默认 Tab 顺序，才能前往表单中的上一个/下一个控件而不是困在下拉框里。
    wrapperRef.value?.querySelector('button')?.focus({ preventScroll: true })
  }
}
function onTriggerKeydown(event) {
  if (isComposingInput(event) || !['ArrowDown', 'ArrowUp'].includes(event.key)) return
  event.preventDefault()
  if (!open.value) toggle()
  nextTick(() => panelRef.value?.querySelector('button:not(:disabled)')?.focus())
}
function onScroll(event) {
  if (!panelRef.value?.contains(event.target)) updatePanelPosition()
}
function onEnter(el, done) {
  enterPopover(el, done, 'dropdown')
}

function onLeave(el, done) {
  leavePopover(el, done, 'dropdown')
}

// 点击外部关闭
function onDocClick(e) {
  if (!open.value) return
  if (wrapperRef.value?.contains(e.target)) return
  if (panelRef.value?.contains(e.target)) return
  open.value = false
}

// 面板打开时监听窗口 resize，保持定位跟随
watch(open, (val) => {
  if (val) {
    nextTick(() => {
      updatePanelPosition()
      ownPopover(panelRef.value, wrapperRef.value)
      panelRef.value
        ?.querySelector('button.is-active:not(:disabled), button:not(:disabled)')
        ?.focus({ preventScroll: true })
    })
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', updatePanelPosition)
  } else {
    releasePopover(panelRef.value)
    window.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('resize', updatePanelPosition)
  }
})

onMounted(() => {
  document.addEventListener('click', onDocClick, true)
})
onBeforeUnmount(() => {
  releasePopover(panelRef.value)
  window.removeEventListener('scroll', onScroll, true)
  document.removeEventListener('click', onDocClick, true)
  window.removeEventListener('resize', updatePanelPosition)
})
</script>

<template>
  <div ref="wrapperRef" class="sel-wrapper" :class="sizeClass" :style="wrapperStyle">
    <!-- 触发器 -->
    <button
      class="sel-trigger"
      type="button"
      :class="{ 'is-open': open, 'is-disabled': disabled }"
      :disabled="disabled"
      :aria-label="ariaLabel || undefined"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <span class="sel-label" :class="{ 'is-placeholder': !modelValue && modelValue !== 0 }">
        {{ displayLabel }}
      </span>
      <svg class="sel-arrow" :class="{ 'is-open': open }" width="10" height="6" aria-hidden="true">
        <path
          d="M1 1l4 4 4-4"
          stroke="currentColor"
          stroke-width="1.5"
          fill="none"
          stroke-linecap="round"
        />
      </svg>
    </button>

    <Teleport to="body">
      <Transition :css="false" @enter="onEnter" @leave="onLeave">
        <div
          v-if="open"
          ref="panelRef"
          class="sel-panel-wrap"
          :class="sizeClass"
          :style="panelStyle"
          @keydown="onPanelKeydown"
          @click.stop
        >
          <div class="sel-panel-glass">
            <div class="sel-panel scroll-y" role="listbox" :aria-label="ariaLabel || displayLabel">
              <button
                v-for="opt in options"
                :key="opt.value"
                class="sel-option"
                type="button"
                role="option"
                :aria-selected="modelValue === opt.value"
                :class="{ 'is-active': modelValue === opt.value, 'is-disabled': opt.disabled }"
                :data-value="String(opt.value)"
                :disabled="opt.disabled"
                @click="select(opt)"
              >
                <span class="sel-option-check" aria-hidden="true">✓</span>
                <span class="sel-option-label">{{ opt.label }}</span>
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
.sel-wrapper {
  display: inline-block;
  min-width: 0;
  max-width: 100%;
}

/* ============ 触发器 ============ */
.sel-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8rem;
  width: 100%;
  padding: 5rem 10rem;
  font-size: inherit;
  font-family: inherit;
  color: var(--text-color);
  background: var(--ui-surface-control);
  border: 1px solid var(--ui-border-control);
  border-radius: 6rem;
  cursor: pointer;
  outline: none;
  -webkit-user-select: none;
  user-select: none;
  transition:
    background-color var(--motion-control) ease,
    border-color 160ms ease,
    box-shadow 160ms ease;
}
.sel-trigger:hover:not(.is-disabled) {
  border-color: var(--ui-border-hover);
}
.sel-trigger:focus-visible {
  border-color: var(--ui-border-hover);
}
.sel-trigger.is-open {
  border-color: var(--ui-border-hover);
}
.sel-trigger.is-disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.sel-label {
  flex: 1;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sel-label.is-placeholder {
  opacity: 0.4;
}

.sel-arrow {
  flex-shrink: 0;
  opacity: 0.45;
  color: var(--text-color);
  transition:
    transform var(--motion-control) ease,
    opacity 160ms ease;
}
.sel-trigger:hover:not(.is-disabled) .sel-arrow,
.sel-trigger.is-open .sel-arrow {
  opacity: 0.78;
}
.sel-arrow.is-open {
  transform: rotate(180deg);
}

/* ============ 下拉面板 ============ */
.sel-panel-wrap {
  border-radius: 12rem;
  box-shadow: var(--ui-menu-shadow);
  overflow: hidden;
  transform-origin: top center;
  will-change: clip-path;
}
.sel-panel-glass {
  min-width: 100%;
  background-color: var(--surface-float);
  border: 1px solid var(--surface-float-border);
  border-radius: inherit;
}
.sel-panel {
  display: grid;
  min-width: 0;
  gap: 1rem;
  padding: 5rem;
  max-height: calc(var(--popover-available-height) - 2px);
}

.sel-option {
  display: grid;
  grid-template-columns: 18rem minmax(0, 1fr);
  align-items: center;
  gap: 6rem;
  width: 100%;
  min-height: var(--ui-menu-row-height);
  padding: 5rem 8rem;
  font-size: inherit;
  font-family: inherit;
  color: inherit;
  background: transparent;
  border: none;
  border-radius: 7rem;
  cursor: pointer;
  outline: none;
  -webkit-user-select: none;
  user-select: none;
  transition:
    color var(--motion-fast) ease,
    background-color var(--motion-fast) ease;
}
.sel-option:hover:not(.is-disabled),
.sel-option:focus-visible:not(.is-disabled) {
  color: var(--ui-on-primary);
  background-color: var(--ui-menu-highlight);
}
.sel-option.is-active {
  font-weight: 600;
}
.sel-option.is-disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.sel-option-check {
  justify-self: start;
  width: 14rem;
  color: var(--ui-accent);
  font-size: 13rem;
  line-height: 1;
  opacity: 0;
}
.sel-option.is-active .sel-option-check {
  opacity: 1;
}
.sel-option:hover .sel-option-check,
.sel-option:focus-visible .sel-option-check {
  color: currentColor;
}
.sel-option-label {
  line-height: 1.2;
  text-align: left;
  white-space: normal;
  overflow-wrap: anywhere;
}

/* ============ 尺寸变体 ============ */
.sel--sm,
.sel--sm .sel-trigger,
.sel--sm .sel-option {
  font-size: var(--fs-secondary);
}
.sel--md,
.sel--md .sel-trigger,
.sel--md .sel-option {
  font-size: var(--fs-secondary);
}
.sel--lg,
.sel--lg .sel-trigger,
.sel--lg .sel-option {
  font-size: var(--fs-body);
}
.sel--lg .sel-trigger {
  padding: 7rem 12rem;
}
.sel--lg .sel-option {
  padding: 9rem 16rem;
}
</style>
