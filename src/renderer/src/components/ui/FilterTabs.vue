<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  options: { type: Array, default: () => [] },
  panelOpen: { type: Boolean, default: false },
  modeLabel: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue', 'close-panel'])
const root = ref(null)
const expanded = ref(false)
let pointerInside = false
let keyboardInput = false
let keyboardInside = false
let closeTimer
let rotation

function open() {
  clearTimeout(closeTimer)
  expanded.value = true
}
function close() {
  clearTimeout(closeTimer)
  if (props.panelOpen) return
  // 鼠标点击后不能把焦点留在即将隐藏的侧按钮上，也不能因移焦重新展开。
  if (root.value?.querySelector('.sg-btn--side:focus')) {
    keyboardInside = false
    keyboardInput = false
    root.value.querySelector('.sg-btn--taiji')?.focus({ preventScroll: true })
  }
  expanded.value = false
}
function scheduleClose() {
  clearTimeout(closeTimer)
  if (!pointerInside && !keyboardInside && !props.panelOpen) closeTimer = setTimeout(close, 100)
}
function onPointerEnter(event) {
  if (event.pointerType === 'touch') return
  pointerInside = true
  open()
}
function onPointerLeave() {
  pointerInside = false
  scheduleClose()
}
function onPointerDown() {
  keyboardInput = false
  keyboardInside = false
  scheduleClose()
}
function onDocumentKeydown(event) {
  if (!['Tab', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(event.key)) return
  keyboardInput = true
  if (root.value?.contains(document.activeElement)) {
    keyboardInside = true
    open()
  }
}
function onFocusIn() {
  if (!keyboardInput) return
  keyboardInside = true
  open()
}
function onFocusOut(event) {
  if (root.value?.contains(event.relatedTarget)) return
  keyboardInside = false
  scheduleClose()
}
function onKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    keyboardInput = false
    keyboardInside = false
    root.value.querySelector('.sg-btn--taiji')?.focus({ preventScroll: true })
    if (props.panelOpen) {
      emit('close-panel')
      return
    }
    close()
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    const buttons = [...root.value.querySelectorAll('.sg-btn')]
    const index = buttons.indexOf(document.activeElement)
    const next = Math.max(
      0,
      Math.min(buttons.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1))
    )
    // 等展开状态提交后再聚焦原本禁用的侧按钮。
    requestAnimationFrame(() => buttons[next]?.isConnected && buttons[next].focus())
  }
}

function rotateTaiji(refresh = false) {
  const icon = root.value?.querySelector('.sg-btn--taiji .sg-icon-turn')
  if (!icon) return
  const style = getComputedStyle(icon)
  const matrix = new DOMMatrixReadOnly(style.transform)
  let from = (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI
  if (Math.abs(from) < 0.01) from = 0
  if (from < 0) from += 360
  let to = expanded.value ? 180 : 0
  if (refresh) to += 360
  else if (expanded.value && from > to + 0.01) to += 360
  const duration = parseFloat(style.getPropertyValue('--motion-panel')) || 300
  // 先读取正在呈现的角度再取消旧动画；刷新中离开也从此处逆时针收回。
  rotation?.cancel()
  icon.style.transform = `rotate(${to}deg)`
  rotation = icon.animate(
    [{ transform: `rotate(${from}deg)` }, { transform: `rotate(${to}deg)` }],
    {
      duration: refresh ? duration * 2 : duration,
      easing: style.getPropertyValue('--ease-standard').trim() || 'ease'
    }
  )
}
function onClick(value) {
  emit('update:modelValue', value)
  if (value === 'taiji') rotateTaiji(true)
}
watch(expanded, () => rotateTaiji(), { flush: 'post' })
watch(
  () => props.panelOpen,
  (visible) => (visible ? open() : scheduleClose())
)
onMounted(() => {
  document.addEventListener('keydown', onDocumentKeydown, true)
  document.addEventListener('pointerdown', onPointerDown, true)
})
onBeforeUnmount(() => {
  clearTimeout(closeTimer)
  rotation?.cancel()
  document.removeEventListener('keydown', onDocumentKeydown, true)
  document.removeEventListener('pointerdown', onPointerDown, true)
})
</script>

<template>
  <div
    ref="root"
    class="sg-root"
    :class="{ 'is-expanded': expanded }"
    :style="{ '--sg-mode-width': `calc(${modeLabel.length || 3}em + 10rem)` }"
    role="group"
    aria-label="便签筛选与刷新"
    @pointerenter="onPointerEnter"
    @pointerleave="onPointerLeave"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
    @keydown="onKeydown"
  >
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      class="sg-btn"
      :class="[
        `sg-btn--${opt.value}`,
        { 'sg-btn--active': modelValue === opt.value, 'sg-btn--side': opt.value !== 'taiji' }
      ]"
      :disabled="opt.value !== 'taiji' && !expanded"
      :tabindex="opt.value !== 'taiji' && !expanded ? -1 : 0"
      :aria-hidden="opt.value !== 'taiji' && !expanded ? true : undefined"
      :aria-label="opt.label"
      :aria-pressed="modelValue === opt.value"
      :aria-expanded="opt.value === 'taiji' ? expanded : undefined"
      :aria-haspopup="opt.value !== 'taiji' ? 'true' : undefined"
      :title="opt.value === 'taiji' ? `${opt.label}；悬停或键盘聚焦展开筛选按钮` : opt.label"
      @click="onClick(opt.value)"
    >
      <span v-if="opt.value === 'taiji'" class="sg-icon-turn">
        <AppIcon class="sg-icon" name="taiji" />
      </span>
      <span v-else>{{ opt.value === 'tags' ? '标签' : '状态' }}</span>
    </button>
    <button
      type="button"
      class="sg-btn sg-btn--side sg-btn--mode nl-mode-toggle"
      :class="{ 'sg-btn--active': modelValue === 'mode' }"
      :disabled="!expanded"
      :tabindex="expanded ? 0 : -1"
      :aria-hidden="!expanded || undefined"
      aria-haspopup="true"
      :aria-expanded="modelValue === 'mode'"
      :aria-label="`模式：当前${modeLabel}`"
      :title="`切换排列模式（当前${modeLabel}）`"
      @click="onClick('mode')"
    >
      {{ modeLabel }}
    </button>
  </div>
</template>

<style scoped>
.sg-root {
  --sg-button-width: 34rem;
  --sg-padding: 4rem;
  --sg-text-width: calc(2em + 10rem);
  position: relative;
  flex: 0 0 auto;
  width: calc(var(--sg-button-width) + var(--sg-padding) * 2);
  height: max(32rem, calc(1.4em + 6rem));
  overflow: hidden;
  font-size: var(--fs-secondary);
  padding: 3rem var(--sg-padding);
  border-radius: 8rem;
  background: var(--ui-surface-subtle);
  /* 只向右扩展真实宽度，天气与宜忌平分剩余空间。 */
  transition: width var(--motion-panel) var(--ease-standard);
}
.sg-root.is-expanded {
  width: calc(
    var(--sg-button-width) + var(--sg-padding) * 2 + var(--sg-text-width) * 2 + var(--sg-mode-width)
  );
}
.sg-btn {
  position: absolute;
  left: var(--sg-padding);
  top: 3rem;
  width: var(--sg-button-width);
  height: calc(100% - 6rem);
  display: flex;
  align-items: center;
  justify-content: center;
  appearance: none;
  padding: 0;
  border: none;
  border-radius: 6rem;
  background: transparent;
  color: var(--text-color-secondary);
  font: inherit;
  white-space: nowrap;
  opacity: 0.6;
  cursor: pointer;
  transition:
    translate var(--motion-panel) var(--ease-standard),
    opacity var(--motion-panel) var(--ease-standard),
    visibility 0s,
    transform var(--motion-control) var(--ease-standard);
}
.sg-btn:hover:not(:disabled),
.sg-btn--active {
  opacity: 1;
}
.sg-btn:focus-visible {
  outline: 2px solid var(--ui-accent);
  outline-offset: -1px;
}
.sg-btn--taiji {
  z-index: var(--z-local-raised);
}
.sg-btn--side {
  width: var(--sg-text-width);
  transition-delay: var(--sg-delay, 0ms), var(--sg-delay, 0ms), 0s, 0s;
}
.sg-btn--tags {
  left: calc(var(--sg-padding) + var(--sg-button-width));
}
.sg-btn--status {
  --sg-delay: 35ms;
  left: calc(var(--sg-padding) + var(--sg-button-width) + var(--sg-text-width));
}
.sg-btn--mode {
  --sg-delay: 70ms;
  width: var(--sg-mode-width);
  left: calc(var(--sg-padding) + var(--sg-button-width) + var(--sg-text-width) * 2);
}
.sg-root:not(.is-expanded) .sg-btn--side {
  translate: -8rem 0;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition-delay: 0s, 0s, var(--motion-panel), 0s;
}
.sg-icon-turn {
  display: flex;
}
.sg-btn :deep(.sg-icon) {
  display: block;
  width: 22rem;
  height: 22rem;
}
</style>
