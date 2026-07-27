<script setup>
/** 固定几何的状态圆环：轨道光、图标和状态过渡分别占用独立 SVG 图层。 */
import { computed } from 'vue'

const props = defineProps({
  status: { type: String, required: true },
  transitionState: { type: Object, default: null },
  interactive: { type: Boolean, default: true }
})

const emit = defineEmits(['activate'])

const STATUS_META = {
  initialized: { label: '初始化', action: '提前开始', color: '#0A84FF' },
  in_progress: { label: '进行中', action: '标记完成', color: '#FF9F0A' },
  completed: { label: '已完成', action: '重新进行', color: '#30D158' },
  deleted: { label: '已删除', action: '', color: '#FF453A' }
}

const meta = computed(() => STATUS_META[props.status] || STATUS_META.initialized)
const actionable = computed(
  () => props.interactive && ['initialized', 'in_progress', 'completed'].includes(props.status)
)
const phase = computed(() => props.transitionState?.phase || 'idle')
const from = computed(() => props.transitionState?.from || props.status)
const to = computed(() => props.transitionState?.to || props.status)
const transitionName = computed(() => (props.transitionState ? `${from.value}-to-${to.value}` : ''))
const busy = computed(() => ['acknowledging', 'waiting', 'playing', 'error'].includes(phase.value))
const styleVars = computed(() => ({
  '--sr-color': meta.value.color,
  '--sr-from-color': STATUS_META[from.value]?.color || meta.value.color,
  '--sr-to-color': STATUS_META[to.value]?.color || meta.value.color
}))

function activate() {
  if (actionable.value && !busy.value) emit('activate')
}
</script>

<template>
  <button
    class="sr-control"
    :class="[
      `sr-control--${status}`,
      `sr-control--${phase}`,
      transitionName && `sr-control--${transitionName}`,
      { 'sr-control--actionable': actionable }
    ]"
    :style="styleVars"
    :disabled="!actionable || busy"
    :title="actionable ? meta.action : meta.label"
    :aria-label="actionable ? meta.action : meta.label"
    @click.stop="activate"
  >
    <svg class="sr-visual" viewBox="0 0 20 20" aria-hidden="true">
      <circle class="sr-track" cx="10" cy="10" r="7.6" pathLength="100" />
      <circle class="sr-wait-track" cx="10" cy="10" r="7.6" pathLength="100" />
      <circle class="sr-target-track" cx="10" cy="10" r="7.6" pathLength="100" />
      <circle class="sr-reopen-preview-track" cx="10" cy="10" r="7.6" pathLength="100" />
      <circle class="sr-complete-fill" cx="10" cy="10" r="6.55" />

      <!-- 所有图标常驻，避免状态提交时销毁/重建 SVG。 -->
      <path class="sr-icon sr-icon--play" d="m8 6 5 4-5 4Z" />
      <path class="sr-icon sr-icon--progress" d="m5.2 10.2 3.1 3.1 6.6-7" pathLength="24" />
      <path class="sr-icon sr-icon--complete" d="m5.2 10.2 3.1 3.1 6.6-7" pathLength="24" />
      <circle class="sr-success-wave" cx="10" cy="10" r="7.6" />
      <circle class="sr-error-flash" cx="10" cy="10" r="7.6" pathLength="100" />
    </svg>
  </button>
</template>

<style scoped>
.sr-control {
  position: relative;
  z-index: 2;
  display: block;
  width: 20rem;
  height: 20rem;
  margin: 2rem 0 0;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--sr-color);
  cursor: default;
  outline: none;
  contain: layout style;
}
.sr-control--actionable {
  cursor: pointer;
}
.sr-control:disabled {
  pointer-events: none;
}
.sr-visual {
  display: block;
  width: 20rem;
  height: 20rem;
  overflow: visible;
}
.sr-track,
.sr-wait-track,
.sr-target-track,
.sr-success-wave,
.sr-error-flash {
  fill: none;
  vector-effect: non-scaling-stroke;
  transform-origin: 10px 10px;
}
.sr-track {
  stroke: currentColor;
  stroke-width: 2.2;
  clip-path: inset(0);
  transition:
    stroke 260ms cubic-bezier(0.22, 1, 0.36, 1),
    clip-path 300ms cubic-bezier(0.32, 0.72, 0, 1);
}

.sr-icon {
  transform-box: fill-box;
  transform-origin: center;
  pointer-events: none;
}
.sr-icon--play {
  fill: currentColor;
  opacity: 0;
  transform: scale(0.82);
  transition:
    opacity 150ms ease,
    transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
.sr-icon--progress,
.sr-icon--complete {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.sr-icon--progress {
  opacity: 0;
  transform: scale(0.82);
  transition:
    opacity 150ms ease,
    transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
.sr-icon--complete {
  color: #fff;
  opacity: 0;
  clip-path: inset(0);
  transition:
    opacity 150ms ease,
    transform 180ms cubic-bezier(0.22, 1, 0.36, 1),
    clip-path 300ms cubic-bezier(0.32, 0.72, 0, 1);
}
.sr-complete-fill {
  fill: #30d158;
  opacity: 0;
  transform-origin: 10px 10px;
  clip-path: inset(0);
  transition:
    opacity 160ms ease,
    clip-path 300ms cubic-bezier(0.32, 0.72, 0, 1);
}
.sr-control--completed .sr-track {
  stroke: color-mix(in srgb, #30d158 72%, #8a8a8a);
}
.sr-control--completed .sr-complete-fill,
.sr-control--completed .sr-icon--complete {
  opacity: 1;
}

/* 只显示内部图标，圆环本身没有 scale，因此不会发生亚像素挤压。 */
.sr-control--initialized:hover .sr-icon--play,
.sr-control--initialized:focus-visible .sr-icon--play,
.sr-control--in_progress:hover .sr-icon--progress,
.sr-control--in_progress:focus-visible .sr-icon--progress {
  opacity: 1;
  transform: scale(1);
}

/* 点击立即给图标一个克制的蓄力反馈，不等待 IPC。 */
.sr-control--acknowledging.sr-control--initialized-to-in_progress .sr-icon--play {
  opacity: 1;
  transform: translateX(-0.8px) scale(0.92);
}
.sr-control--acknowledging.sr-control--in_progress-to-completed .sr-icon--progress {
  opacity: 1;
  transform: scale(0.9);
}
.sr-control--completed-to-in_progress.sr-control--acknowledging .sr-track,
.sr-control--completed-to-in_progress.sr-control--acknowledging .sr-complete-fill,
.sr-control--completed-to-in_progress.sr-control--acknowledging .sr-icon--complete,
.sr-control--completed-to-in_progress.sr-control--waiting .sr-track,
.sr-control--completed-to-in_progress.sr-control--waiting .sr-complete-fill,
.sr-control--completed-to-in_progress.sr-control--waiting .sr-icon--complete,
.sr-control--completed-to-in_progress.sr-control--playing .sr-track,
.sr-control--completed-to-in_progress.sr-control--playing .sr-complete-fill,
.sr-control--completed-to-in_progress.sr-control--playing .sr-icon--complete {
  clip-path: inset(0 100% 0 0);
}
.sr-wait-track {
  stroke: var(--sr-from-color);
  stroke-width: 2.25;
  stroke-linecap: round;
  stroke-dasharray: 18 82;
  opacity: 0;
  transform: rotate(-90deg);
}
.sr-control--waiting .sr-track {
  opacity: 0.42;
}
.sr-control--waiting .sr-wait-track {
  opacity: 1;
  animation: sr-wait-orbit 780ms linear infinite;
}
.sr-control--completed-to-in_progress.sr-control--waiting .sr-wait-track {
  opacity: 0;
  animation: none;
}

.sr-target-track {
  stroke: var(--sr-to-color);
  stroke-width: 2.25;
  stroke-linecap: round;
  stroke-dasharray: 0 100;
  opacity: 0;
  transform: rotate(-28deg);
}
.sr-reopen-preview-track {
  fill: none;
  stroke: #ff9f0a;
  stroke-width: 2.25;
  stroke-linecap: butt;
  stroke-dasharray: 0 100;
  stroke-dashoffset: 0;
  opacity: 0;
  vector-effect: non-scaling-stroke;
  transform-origin: 10px 10px;
  transform: rotate(-28deg);
  transition:
    stroke-dasharray 420ms cubic-bezier(0.32, 0.72, 0, 1),
    opacity 0ms linear 420ms;
}
.sr-control--completed.sr-control--actionable:not(:disabled):hover .sr-reopen-preview-track,
.sr-control--completed.sr-control--actionable:not(:disabled):focus-visible .sr-reopen-preview-track,
.sr-control--completed-to-in_progress.sr-control--acknowledging .sr-reopen-preview-track,
.sr-control--completed-to-in_progress.sr-control--waiting .sr-reopen-preview-track,
.sr-control--completed-to-in_progress.sr-control--playing .sr-reopen-preview-track {
  stroke-dasharray: 100 0;
  opacity: 1;
  transition-delay: 0ms;
}
.sr-success-wave {
  stroke: #30d158;
  stroke-width: 1.15;
  opacity: 0;
}
.sr-error-flash {
  stroke: #ff453a;
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-dasharray: 18 82;
  opacity: 0;
  transform: rotate(-90deg);
}

/* 初始化 → 进行中：三角先蓄力再向右推动，橙色从右上接触点向整环闭合。 */
.sr-control--playing.sr-control--initialized-to-in_progress .sr-icon--play {
  opacity: 1;
  animation: sr-play-launch 420ms cubic-bezier(0.32, 0.72, 0, 1) both;
}
.sr-control--playing.sr-control--initialized-to-in_progress .sr-icon--progress {
  opacity: 0;
}
.sr-control--playing.sr-control--initialized-to-in_progress .sr-target-track {
  opacity: 1;
  animation: sr-start-track 440ms 70ms cubic-bezier(0.32, 0.72, 0, 1) both;
}

/* 进行中 → 完成：绿色闭环、填充、绘制白勾、最后释放一圈细光。 */
.sr-control--playing.sr-control--in_progress-to-completed .sr-icon--progress {
  opacity: 1;
  animation: sr-progress-fold 160ms ease-out both;
}
.sr-control--playing.sr-control--in_progress-to-completed .sr-target-track {
  opacity: 1;
  animation: sr-complete-track 330ms 70ms cubic-bezier(0.32, 0.72, 0, 1) both;
}
.sr-control--playing.sr-control--in_progress-to-completed .sr-complete-fill {
  animation: sr-complete-fill 260ms 190ms ease-out both;
}
.sr-control--playing.sr-control--in_progress-to-completed .sr-icon--complete {
  stroke-dasharray: 24;
  animation: sr-complete-check 310ms 230ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
.sr-control--playing.sr-control--in_progress-to-completed .sr-success-wave {
  animation: sr-success-wave 380ms 390ms ease-out both;
}

/* 已完成 → 进行中：悬停预览轨道保持闭合，底层轨道在其下方无缝接管。 */
.sr-control--playing.sr-control--completed-to-in_progress .sr-track {
  animation: sr-reopen-base-handoff 1ms 500ms step-end both;
}
.sr-control--error .sr-error-flash {
  animation: sr-error-track 320ms ease-out both;
}

@keyframes sr-wait-orbit {
  to {
    transform: rotate(270deg);
  }
}
@keyframes sr-play-launch {
  0% {
    transform: translateX(-0.8px) scale(0.92);
    opacity: 1;
    color: #0a84ff;
  }
  35% {
    transform: translateX(-1.1px) scale(0.96);
    opacity: 1;
  }
  72% {
    transform: translateX(4.2px) scale(1);
    opacity: 1;
  }
  100% {
    transform: translateX(6px) scale(0.72);
    opacity: 0;
  }
}
@keyframes sr-start-track {
  0% {
    stroke-dasharray: 0 100;
    stroke-dashoffset: 0;
  }
  100% {
    stroke-dasharray: 100 0;
    stroke-dashoffset: -50;
  }
}
@keyframes sr-reopen-base-handoff {
  0% {
    clip-path: inset(0 100% 0 0);
  }
  100% {
    clip-path: inset(0);
  }
}
@keyframes sr-progress-fold {
  0% {
    transform: scale(1);
    opacity: 1;
  }
  100% {
    transform: scale(0.72);
    opacity: 0;
  }
}
@keyframes sr-complete-track {
  0% {
    stroke-dasharray: 0 100;
    stroke-dashoffset: 0;
  }
  100% {
    stroke-dasharray: 100 0;
    stroke-dashoffset: -50;
  }
}
@keyframes sr-complete-fill {
  0% {
    opacity: 0;
  }
  100% {
    opacity: 1;
  }
}
@keyframes sr-complete-check {
  0% {
    stroke-dashoffset: 24;
    opacity: 0;
  }
  100% {
    stroke-dashoffset: 0;
    opacity: 1;
  }
}
@keyframes sr-success-wave {
  0% {
    opacity: 0.72;
    transform: scale(0.94);
  }
  100% {
    opacity: 0;
    transform: scale(1.42);
  }
}
@keyframes sr-error-track {
  0% {
    opacity: 0;
    stroke-dashoffset: 0;
  }
  35% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    stroke-dashoffset: -48;
  }
}
</style>
