<script setup>
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import TemplateForm from './TemplateForm.vue'

defineProps({ submitting: { type: Boolean, default: false } })
const emit = defineEmits(['submit'])

const phase = ref('collapsed') // collapsed | opening | open | closing
const expandHeight = ref(58)
const formRef = ref(null)
const boxRef = ref(null)
const animatedHeight = ref(null)
let boxAnimation = null
// closing 阶段必须撤掉展开高度，让外壳从当前高度过渡回默认的 36rem。
// 若把 closing 也当作展开态，内联高度会一直保留，面板便会卡在空壳状态。
const expandedGeometry = computed(() => ['opening', 'open'].includes(phase.value))
const contentVisible = computed(() => phase.value === 'open')
const panelStyle = computed(() => {
  if (animatedHeight.value !== null) return { height: `${animatedHeight.value}px` }
  return phase.value === 'open' ? { height: `${expandHeight.value}vh` } : {}
})

function collapsedHeight() {
  return 36 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
}

function animateBox(from, to, onFinish) {
  boxAnimation?.cancel()
  const animation = boxRef.value?.animate([{ height: `${from}px` }, { height: `${to}px` }], {
    duration: 300,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    fill: 'both'
  })
  boxAnimation = animation || null
  animation?.finished
    .catch(() => undefined)
    .then(() => {
      if (boxAnimation !== animation) return
      boxAnimation = null
      animation.cancel()
      onFinish()
    })
}

async function toggle() {
  const box = boxRef.value
  if (!box) return
  if (phase.value === 'collapsed') {
    const from = box.getBoundingClientRect().height
    animatedHeight.value = from
    phase.value = 'opening'
    await nextTick()
    const to = (window.innerHeight * expandHeight.value) / 100
    animateBox(from, to, () => {
      animatedHeight.value = null
      phase.value = 'open'
    })
  } else if (phase.value === 'open') {
    const from = box.getBoundingClientRect().height
    animatedHeight.value = from
    phase.value = 'closing'
    await nextTick()
    animateBox(from, collapsedHeight(), () => {
      animatedHeight.value = null
      phase.value = 'collapsed'
    })
  }
}

let dragging = false
let dragStartY = 0
let dragStartHeight = 0
let dragRaf = null
function onDragStart(event) {
  dragging = true
  dragStartY = event.clientY
  dragStartHeight = expandHeight.value
  document.addEventListener('mousemove', onDragMove)
  document.addEventListener('mouseup', onDragEnd)
  event.preventDefault()
}
function onDragMove(event) {
  if (!dragging || dragRaf) return
  dragRaf = requestAnimationFrame(() => {
    dragRaf = null
    const delta = ((event.clientY - dragStartY) / window.innerHeight) * 100
    expandHeight.value = Math.max(30, Math.min(85, Math.round(dragStartHeight + delta)))
  })
}
function onDragEnd() {
  dragging = false
  if (dragRaf) cancelAnimationFrame(dragRaf)
  dragRaf = null
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', onDragEnd)
}

defineExpose({ reset: () => formRef.value?.reset?.() })
onBeforeUnmount(() => {
  onDragEnd()
  boxAnimation?.cancel()
})
</script>

<template>
  <div class="tcp-root" :class="{ 'is-expanded': expandedGeometry }">
    <div ref="boxRef" class="tcp-box" :style="panelStyle">
      <button
        class="tcp-button"
        :title="expandedGeometry ? '折叠' : '新建循环模板'"
        @click.stop="toggle"
      >
        <svg :class="{ crossed: expandedGeometry }" viewBox="0 0 1024 1024" aria-hidden="true">
          <path d="M512 200V824M200 512H824" />
        </svg>
      </button>
      <button
        class="tcp-hint"
        :aria-hidden="expandedGeometry"
        :tabindex="expandedGeometry ? -1 : 0"
        @click.stop="toggle"
      >
        <span>请新建循环模板内容…</span>
      </button>
      <button
        v-if="contentVisible"
        class="tcp-collapse-hit"
        title="折叠新建模板面板"
        aria-label="折叠新建模板面板"
        @click.stop="toggle"
      />
      <div class="tcp-content" :class="{ visible: contentVisible }">
        <div class="tcp-body scroll-y">
          <TemplateForm
            ref="formRef"
            :active="contentVisible"
            :submitting="submitting"
            @submit="emit('submit', $event)"
          />
        </div>
        <div class="tcp-drag-handle" @mousedown="onDragStart"><div class="tcp-drag-bar" /></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tcp-root {
  position: relative;
  display: flex;
  align-items: flex-start;
}
.tcp-box {
  position: relative;
  display: flex;
  flex: 1 1 0;
  box-sizing: border-box;
  min-width: 0;
  height: 36rem;
  border: 1px solid rgb(var(--bg-color) / 0.1);
  border-radius: 10rem;
  overflow: hidden;
  background: transparent;
}
.tcp-button {
  position: absolute;
  z-index: 2;
  top: 0;
  left: 0;
  display: grid;
  place-items: center;
  width: 36rem;
  height: 36rem;
  padding: 0;
  border: 0;
  border-radius: 10rem;
  background: transparent;
  color: var(--text-color);
  cursor: pointer;
  transition:
    background 150ms ease,
    transform 70ms ease;
}
.tcp-button:hover {
  background: rgba(128, 128, 128, 0.06);
}
.tcp-button:active {
  transform: scale(0.92);
}
.tcp-button svg {
  width: 16rem;
  height: 16rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 100;
  stroke-linecap: round;
  transition: transform 350ms cubic-bezier(0.22, 1, 0.36, 1);
}
.tcp-button svg.crossed {
  transform: rotate(45deg);
}
.tcp-hint {
  position: absolute;
  z-index: 1;
  top: 0;
  left: 36rem;
  right: 0;
  height: 36rem;
  padding: 0 12rem;
  border: 0;
  background: transparent;
  color: var(--text-color-secondary);
  font: inherit;
  font-size: var(--fs-secondary);
  white-space: nowrap;
  overflow: hidden;
  cursor: pointer;
  opacity: 1;
  transform: translateY(0);
  transition:
    opacity 180ms ease,
    transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
.is-expanded .tcp-hint {
  opacity: 0;
  transform: translateY(-9rem);
  pointer-events: none;
}
.tcp-collapse-hit {
  position: absolute;
  z-index: 1;
  top: 0;
  left: 36rem;
  right: 0;
  height: 36rem;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.tcp-collapse-hit:hover {
  background: rgba(128, 128, 128, 0.025);
}
.tcp-content {
  position: absolute;
  inset: 0;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  padding-top: 36rem;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition:
    opacity 130ms ease,
    visibility 0s linear 130ms;
}
.tcp-content.visible {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transition-delay: 0s;
}
.tcp-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
  padding: 0 14rem 16rem;
  -webkit-mask-image: linear-gradient(
    to bottom,
    black 0%,
    black calc(100% - 30rem),
    transparent 100%
  );
  mask-image: linear-gradient(to bottom, black 0%, black calc(100% - 30rem), transparent 100%);
}
.tcp-drag-handle {
  display: flex;
  justify-content: center;
  flex-shrink: 0;
  padding: 4rem 0 10rem;
  cursor: ns-resize;
  user-select: none;
}
.tcp-drag-bar {
  width: 36rem;
  height: 4rem;
  border-radius: 2rem;
  background: rgba(255, 255, 255, 0.2);
  transition:
    transform var(--motion-control) var(--ease-standard),
    background-color var(--motion-fast) ease;
}
.tcp-drag-handle:hover .tcp-drag-bar {
  transform: scaleX(1.18);
  background: rgba(255, 255, 255, 0.32);
}
</style>
