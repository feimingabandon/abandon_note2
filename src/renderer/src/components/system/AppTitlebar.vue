<script setup>
/**
 * AppTitlebar.vue — 可切换 Apple / Microsoft 视觉的自定义标题栏组件
 *
 * 职责：
 *   1. 提供关闭、三态窗口层级、锁定窗口控制，视觉风格不改变功能语义
 *   2. 展示窗口标题文字
 *   3. 通过 slot 支持在标题栏右侧插入自定义操作按钮
 *   4. 除窗口缩放带和交互控件外，整个标题栏通过统一指针事务支持拖动与双击
 *
 * Props:
 *   - title {String} 标题栏显示的文字，默认为空
 *   - locked {Boolean} 窗口锁定状态
 *   - zOrderMode {'top'|'normal'|'bottom'} 主窗口层级
 *   - styleVariant {'apple'|'microsoft'} 标题栏视觉风格
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { WINDOW_Z_ORDER_MODES } from '../../../../shared/settings-schema.js'
import { enterPopover, leavePopover } from '../../utils/popoverMotion.js'

const props = defineProps({
  title: {
    type: String,
    default: ''
  },
  locked: {
    type: Boolean,
    required: true
  },
  zOrderMode: {
    type: String,
    required: true,
    validator: (value) => Object.values(WINDOW_Z_ORDER_MODES).includes(value)
  },
  styleVariant: {
    type: String,
    default: 'apple',
    validator: (value) => value === 'apple' || value === 'microsoft'
  }
})

const emit = defineEmits(['update:locked', 'update:zOrderMode', 'request:compact'])

const WINDOW_CONTROL_GUARD_MS = 500
const Z_ORDER_OPTIONS = Object.freeze([
  {
    value: WINDOW_Z_ORDER_MODES.TOP,
    label: '始终置顶',
    description: '保持在普通窗口上方'
  },
  {
    value: WINDOW_Z_ORDER_MODES.NORMAL,
    label: '正常层级',
    description: '跟随 Windows 窗口顺序'
  },
  {
    value: WINDOW_Z_ORDER_MODES.BOTTOM,
    label: '始终置底',
    description: '保持在普通窗口下方'
  }
])

const zOrderTriggerRef = ref(null)
const zOrderMenuRef = ref(null)
const zOrderMenuOpen = ref(false)
const zOrderMenuStyle = ref({})
const zOrderChanging = ref(false)
const lockChanging = ref(false)
let zOrderGuardTimer = null
let lockGuardTimer = null
let titlebarDragFrame = null
let titlebarDragPointerId = null
let titlebarDragLatestPoint = null
let titlebarPointerMoved = false
let titlebarDragStartPromise = null
let titlebarDragging = false
let titlebarDragGeneration = 0
let lastTitlebarPress = null
let suppressTitlebarDomDoubleClickUntil = 0

const TITLEBAR_DOUBLE_CLICK_MS = 420
const TITLEBAR_DOUBLE_CLICK_DISTANCE = 12
const TITLEBAR_INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, summary, [role="button"], [role="menu"], [contenteditable="true"], [data-no-compact]'

const activeZOrderOption = computed(
  () => Z_ORDER_OPTIONS.find((option) => option.value === props.zOrderMode) || Z_ORDER_OPTIONS[0]
)
const zOrderTitle = computed(() =>
  zOrderChanging.value ? '正在切换窗口层级' : `窗口层级：${activeZOrderOption.value.label}`
)

function finishGuard(stateRef, timerName) {
  const timer = setTimeout(() => {
    stateRef.value = false
    if (timerName === 'z-order') zOrderGuardTimer = null
    else lockGuardTimer = null
  }, WINDOW_CONTROL_GUARD_MS)
  if (timerName === 'z-order') zOrderGuardTimer = timer
  else lockGuardTimer = timer
}

function updateZOrderMenuPosition() {
  const trigger = zOrderTriggerRef.value
  if (!trigger) return
  const rect = trigger.getBoundingClientRect()
  const width = 188
  const preferredLeft = props.styleVariant === 'microsoft' ? rect.right - width : rect.left
  zOrderMenuStyle.value = {
    top: `${rect.bottom + 7}px`,
    left: `${Math.min(Math.max(8, preferredLeft), window.innerWidth - width - 8)}px`,
    width: `${width}px`
  }
}

async function focusActiveZOrderOption() {
  await nextTick()
  zOrderMenuRef.value
    ?.querySelector(`[data-mode="${props.zOrderMode}"]`)
    ?.focus({ preventScroll: true })
}

function toggleZOrderMenu() {
  if (zOrderChanging.value) return
  zOrderMenuOpen.value = !zOrderMenuOpen.value
  if (zOrderMenuOpen.value) {
    updateZOrderMenuPosition()
    void focusActiveZOrderOption()
  }
}

function closeZOrderMenu({ restoreFocus = false } = {}) {
  if (!zOrderMenuOpen.value) return
  zOrderMenuOpen.value = false
  if (restoreFocus) nextTick(() => zOrderTriggerRef.value?.focus({ preventScroll: true }))
}

async function selectZOrderMode(mode) {
  if (zOrderChanging.value) return
  closeZOrderMenu({ restoreFocus: true })
  if (mode === props.zOrderMode) return

  zOrderChanging.value = true
  try {
    const result = await window.api.setWindowZOrderMode(mode)
    if (result?.mode) emit('update:zOrderMode', result.mode)
  } catch (error) {
    console.warn('[AppTitlebar] 切换窗口层级失败:', error)
  } finally {
    finishGuard(zOrderChanging, 'z-order')
  }
}

function onZOrderMenuKeydown(event) {
  const items = [...(zOrderMenuRef.value?.querySelectorAll('[role="menuitemradio"]') || [])]
  if (!items.length) return
  const currentIndex = Math.max(0, items.indexOf(document.activeElement))
  let targetIndex = null
  if (event.key === 'ArrowDown') targetIndex = (currentIndex + 1) % items.length
  if (event.key === 'ArrowUp') targetIndex = (currentIndex - 1 + items.length) % items.length
  if (event.key === 'Home') targetIndex = 0
  if (event.key === 'End') targetIndex = items.length - 1
  if (event.key === 'Escape') {
    event.preventDefault()
    closeZOrderMenu({ restoreFocus: true })
    return
  }
  if (targetIndex === null) return
  event.preventDefault()
  items[targetIndex].focus({ preventScroll: true })
}

function onDocumentPointerDown(event) {
  if (!zOrderMenuOpen.value) return
  if (zOrderTriggerRef.value?.contains(event.target)) return
  if (zOrderMenuRef.value?.contains(event.target)) return
  closeZOrderMenu()
}

function onPopoverEnter(element, done) {
  enterPopover(element, done, 'dropdown')
}

function onPopoverLeave(element, done) {
  leavePopover(element, done, 'dropdown')
}

// ---- 窗口控制事件处理函数 ----
/** 关闭窗口：通过 preload 暴露的 API 发送 IPC 消息到主进程 */
const close = () => window.api.closeWindow()
/** 切换锁定/解锁状态 */
const toggleLock = async () => {
  if (lockChanging.value) return
  lockChanging.value = true
  try {
    const result = await window.api.toggleLock()
    if (typeof result?.value === 'boolean') emit('update:locked', result.value)
  } catch (e) {
    console.warn('[AppTitlebar] 切换锁定失败:', e)
  } finally {
    finishGuard(lockChanging, 'lock')
  }
}

function onTitlebarDoubleClick(event) {
  if (Date.now() < suppressTitlebarDomDoubleClickUntil) return
  const target = event.target
  if (!(target instanceof Element)) return
  if (target.closest(TITLEBAR_INTERACTIVE_SELECTOR)) return
  emit('request:compact')
}

function requestTitlebarDragUpdate() {
  if (titlebarDragFrame) return
  titlebarDragFrame = requestAnimationFrame(() => {
    titlebarDragFrame = null
    window.api.updateTitlebarWindowDrag(titlebarDragLatestPoint)
  })
}

function setTitlebarPointerCapture(target, pointerId) {
  try {
    target.setPointerCapture?.(pointerId)
  } catch {
    // 合成输入或窗口切换期间指针可能已失效；主进程拖动事务仍可按坐标完成。
  }
}

function releaseTitlebarPointerCapture(target, pointerId) {
  try {
    target.releasePointerCapture?.(pointerId)
  } catch {
    // lostpointercapture 与 pointerup 可能竞争，释放操作保持幂等。
  }
}

function onTitlebarPointerDown(event) {
  if (event.button !== 0 || titlebarDragPointerId !== null) return
  const target = event.target
  if (!(target instanceof Element) || target.closest(TITLEBAR_INTERACTIVE_SELECTOR)) return
  const now = Date.now()
  const press = { at: now, x: event.screenX, y: event.screenY }
  const isDoublePress =
    lastTitlebarPress &&
    now - lastTitlebarPress.at <= TITLEBAR_DOUBLE_CLICK_MS &&
    Math.hypot(press.x - lastTitlebarPress.x, press.y - lastTitlebarPress.y) <=
      TITLEBAR_DOUBLE_CLICK_DISTANCE
  lastTitlebarPress = isDoublePress ? null : press
  if (isDoublePress) {
    suppressTitlebarDomDoubleClickUntil = now + 500
    event.preventDefault()
    titlebarDragGeneration += 1
    titlebarDragging = false
    void window.api
      .endTitlebarWindowDrag()
      .catch(() => false)
      .finally(() => emit('request:compact'))
    return
  }
  if (props.locked) return
  const generation = ++titlebarDragGeneration
  titlebarDragPointerId = event.pointerId
  titlebarDragLatestPoint = { x: event.screenX, y: event.screenY }
  titlebarPointerMoved = false
  setTitlebarPointerCapture(event.currentTarget, event.pointerId)
  const task = window.api.beginTitlebarWindowDrag(titlebarDragLatestPoint).catch(() => false)
  titlebarDragStartPromise = task
  void task.then(async (started) => {
    if (titlebarDragStartPromise === task) titlebarDragStartPromise = null
    if (generation !== titlebarDragGeneration || titlebarDragPointerId === null) {
      if (started) {
        if (titlebarPointerMoved && titlebarDragLatestPoint) {
          window.api.updateTitlebarWindowDrag(titlebarDragLatestPoint)
        }
        await window.api.endTitlebarWindowDrag().catch(() => false)
      }
      return
    }
    titlebarDragging = Boolean(started)
    if (titlebarDragging && titlebarPointerMoved) requestTitlebarDragUpdate()
  })
}

function onTitlebarPointerMove(event) {
  if (titlebarDragPointerId === null || titlebarDragPointerId !== event.pointerId) return
  titlebarDragLatestPoint = { x: event.screenX, y: event.screenY }
  titlebarPointerMoved = true
  if (titlebarDragging) requestTitlebarDragUpdate()
}

async function finishTitlebarPointer(event) {
  if (titlebarDragPointerId !== event.pointerId) return
  titlebarDragPointerId = null
  titlebarDragGeneration += 1
  releaseTitlebarPointerCapture(event.currentTarget, event.pointerId)
  if (titlebarDragStartPromise) await titlebarDragStartPromise.catch(() => false)
  if (titlebarDragging) {
    if (titlebarPointerMoved && titlebarDragLatestPoint) {
      window.api.updateTitlebarWindowDrag(titlebarDragLatestPoint)
    }
    titlebarDragging = false
    await window.api.endTitlebarWindowDrag().catch(() => false)
  }
  titlebarDragLatestPoint = null
  titlebarPointerMoved = false
}

watch(
  () => props.styleVariant,
  () => {
    if (zOrderMenuOpen.value) nextTick(updateZOrderMenuPosition)
  }
)

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  window.addEventListener('resize', updateZOrderMenuPosition)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  window.removeEventListener('resize', updateZOrderMenuPosition)
  if (titlebarDragFrame) cancelAnimationFrame(titlebarDragFrame)
  if (titlebarDragging || titlebarDragStartPromise) {
    void window.api.endTitlebarWindowDrag().catch(() => false)
  }
  if (zOrderGuardTimer) clearTimeout(zOrderGuardTimer)
  if (lockGuardTimer) clearTimeout(lockGuardTimer)
})
</script>

<template>
  <!-- 标题栏空白区统一由 JS 处理拖动和双击；按钮与最上沿缩放带保持独立。 -->
  <header
    class="app-titlebar"
    :class="[`app-titlebar--${styleVariant}`, { locked: locked }]"
    :data-style="styleVariant"
    @dblclick="onTitlebarDoubleClick"
    @pointerdown="onTitlebarPointerDown"
    @pointermove="onTitlebarPointerMove"
    @pointerup="finishTitlebarPointer"
    @pointercancel="finishTitlebarPointer"
    @lostpointercapture="finishTitlebarPointer"
  >
    <!-- 红绿灯按钮组：设置 no-drag 使按钮可点击 -->
    <div class="traffic-lights">
      <!-- 关闭按钮(红色) -->
      <button class="light light-close" title="关闭" @click="close">
        <img class="light-icon" src="@/resources/icons/close.png" alt="关闭" />
      </button>
      <!-- 全视图共享的三态窗口层级入口 -->
      <button
        ref="zOrderTriggerRef"
        class="light light-pin"
        :class="{
          pinned: zOrderMode === WINDOW_Z_ORDER_MODES.TOP,
          bottomed: zOrderMode === WINDOW_Z_ORDER_MODES.BOTTOM,
          'is-open': zOrderMenuOpen,
          'is-changing': zOrderChanging
        }"
        :title="zOrderTitle"
        aria-haspopup="menu"
        :aria-expanded="zOrderMenuOpen"
        :aria-disabled="zOrderChanging"
        @click="toggleZOrderMenu"
      >
        <img
          class="light-icon layer-mode-icon"
          :class="{ 'is-bottom': zOrderMode === WINDOW_Z_ORDER_MODES.BOTTOM }"
          src="@/resources/icons/pin.svg"
          alt=""
        />
      </button>
      <!-- 锁定按钮（绿色=未锁 / 橙色=已锁） -->
      <button
        class="light light-lock"
        :class="{ locked: locked, 'is-changing': lockChanging }"
        :title="lockChanging ? '正在切换锁定状态' : locked ? '解锁主窗口' : '锁定主窗口'"
        :disabled="lockChanging"
        @click="toggleLock"
      >
        <img class="light-icon" src="@/resources/icons/lock.png" alt="锁定" />
      </button>
    </div>
    <!-- 中间弹性区只负责布局；指针事务由整个标题栏统一接管。 -->
    <div class="app-titlebar-interaction-surface">
      <span v-if="title" class="app-titlebar-title">{{ title }}</span>
    </div>
    <!-- 右侧操作区域插槽，父组件可插入自定义按钮 -->
    <div class="app-titlebar-actions">
      <slot />
    </div>
  </header>

  <Teleport to="body">
    <Transition :css="false" @enter="onPopoverEnter" @leave="onPopoverLeave">
      <div
        v-if="zOrderMenuOpen"
        ref="zOrderMenuRef"
        class="z-order-menu"
        :style="zOrderMenuStyle"
        role="menu"
        aria-label="主窗口层级"
        @click.stop
        @keydown="onZOrderMenuKeydown"
      >
        <button
          v-for="option in Z_ORDER_OPTIONS"
          :key="option.value"
          class="z-order-option"
          :class="{ 'is-active': zOrderMode === option.value }"
          type="button"
          role="menuitemradio"
          :aria-checked="zOrderMode === option.value"
          :aria-label="`${option.label}，${option.description}`"
          :title="option.description"
          :data-mode="option.value"
          @click="selectZOrderMode(option.value)"
        >
          <span class="z-order-option-check" aria-hidden="true">✓</span>
          <span class="z-order-option-label">{{ option.label }}</span>
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 标题栏容器：flex 响应式三栏布局，空白区域由统一 JS 指针事务拖动窗口
 * 左（红绿灯）· 中（标题 flex:1）· 右（操作按钮），随窗口宽度自适应 */
.app-titlebar {
  position: relative;
  display: flex;
  align-items: center; /* 垂直居中对齐 */
  padding: 14px 16px; /* 内边距，总高 14+18+14+1(border)=47rem ≈ 48px Apple 导航标准 */
  -webkit-app-region: no-drag; /* 保留完整 DOM 指针事件，拖动由主进程事务完成 */
  flex-shrink: 0; /* 禁止在 flex 布局中被压缩 */
  gap: 8px; /* 子元素间距 */
  border-bottom: 1px solid var(--ui-border-divider); /* 标题栏底部分割线 */
}

/* 红绿灯按钮容器 */
.traffic-lights {
  display: flex;
  gap: 8px; /* 按钮间距 8px */
  -webkit-app-region: no-drag; /* 取消拖拽，使按钮可以响应点击事件 */
}

/* 单个红绿灯按钮的基础样式 */
.light {
  width: 18rem; /* 按钮直径（响应式 rem 单位） */
  height: 18rem;
  border-radius: 50%; /* 圆形 */
  border: none;
  padding: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    opacity var(--motion-fast) ease,
    background-color var(--motion-control) ease,
    transform var(--motion-control) var(--ease-standard); /* 悬停与状态过渡 */
}

/* 按钮内的图标 */
.light-icon {
  width: 14rem; /* 图标大小 */
  height: 14rem;
  opacity: 0; /* 默认隐藏图标 */
  transition:
    opacity 120ms ease,
    transform var(--motion-control) var(--ease-standard);
  display: block; /* 确保正确居中 */
}

/* 鼠标悬停在按钮组上时，显示所有图标（模拟 macOS 行为） */
.traffic-lights:hover .light-icon {
  opacity: 1;
}
.light:not(.light-pin):active:not(:disabled) {
  transform: scale(0.98);
  transition-duration: 70ms;
}
.light:disabled,
.light[aria-disabled='true'] {
  cursor: wait;
  opacity: 0.58;
}
.light.pinned .light-icon,
.light.locked .light-icon {
  animation: light-state-in var(--motion-control) var(--ease-standard);
}
@keyframes light-state-in {
  from {
    opacity: 0;
    transform: scale(0.75);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

/* 各按钮的默认背景色（模拟 macOS 红绿灯） */
.light-close {
  background-color: #ff5f57;
} /* 红色 - 关闭 */
.light-pin {
  background-color: #8e8e93;
} /* 灰色 - 未置顶 */
.light-pin.pinned {
  background-color: #febc2e;
} /* 黄色 - 已置顶（原最小化色） */
.light-pin.bottomed {
  background-color: var(--ui-accent);
}
.layer-mode-icon.is-bottom {
  transform: rotate(180deg);
}
.light-lock {
  background-color: #28c840;
} /* 绿色 - 未锁定 */

/* 各按钮悬停时的加深背景色 */
.light-close:hover {
  background-color: #ff4136;
}
.light-pin:hover {
  background-color: #7c7c80;
}
.light-pin.pinned:hover {
  background-color: #f5a623;
}
.light-pin.bottomed:hover,
.light-pin.bottomed.is-open {
  background-color: color-mix(in srgb, var(--ui-accent) 84%, var(--text-color) 16%);
}
.light-lock:hover {
  background-color: #1db954;
}

/* 锁定状态：按钮变橙色 */
.light-lock.locked {
  background-color: #ff9f0a;
}
.light-lock.locked:hover {
  background-color: #e08e00;
}

/* 锁定状态下标题栏不可拖拽 */
.app-titlebar.locked {
  -webkit-app-region: no-drag;
}

.app-titlebar-interaction-surface {
  display: flex;
  align-self: stretch;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-width: 12px;
  cursor: default;
  -webkit-app-region: no-drag;
}

/* 标题文字：正文大小、居中 */
.app-titlebar-title {
  font-size: var(--fs-body); /* 正文字号（跟随 --font-size-base 响应式缩放） */
  font-weight: 600; /* OPPOSans Bold，更圆润 */
  color: var(--text-color); /* 使用全局文字颜色变量 */
  width: 100%;
  text-align: center; /* 文字在 flex 区域内居中 */
}

/* 右侧操作按钮区域 */
.app-titlebar-actions {
  display: flex;
  gap: 8px;
  margin-left: auto; /* 标题移除后，仍保持靠右对齐 */
  -webkit-app-region: no-drag; /* 取消拖拽，使操作按钮可点击 */
}

/* Windows 11 / Fluent 取向：业务操作靠左，窗口操作靠右，关闭按钮位于最右端。 */
.app-titlebar--microsoft {
  min-height: 47px;
  padding: 8px 8px 8px 16px;
  gap: 2rem;
}
.app-titlebar--microsoft .traffic-lights {
  order: 3;
  gap: 2rem;
  margin-left: auto;
}
.app-titlebar--microsoft .app-titlebar-interaction-surface {
  order: 2;
}
.app-titlebar--microsoft .app-titlebar-title {
  order: 2;
  position: absolute;
  left: 50%;
  max-width: 40%;
  overflow: hidden;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
  transform: translateX(-50%);
}
.app-titlebar--microsoft .app-titlebar-actions {
  order: 1;
  margin-left: 0;
}
.app-titlebar--microsoft .light {
  width: 32rem;
  height: 30rem;
  border-radius: 4rem;
  color: var(--text-color);
  background-color: transparent;
}
.app-titlebar--microsoft .light-icon {
  width: 15rem;
  height: 15rem;
  opacity: 0.72;
}
.app-titlebar--microsoft .traffic-lights:hover .light-icon {
  opacity: 0.72;
}
.app-titlebar--microsoft .light:hover {
  background-color: var(--ui-fill-hover);
}
.app-titlebar--microsoft .light:hover .light-icon {
  opacity: 1;
}
.app-titlebar--microsoft .light-pin.pinned,
.app-titlebar--microsoft .light-pin.bottomed,
.app-titlebar--microsoft .light-lock.locked {
  background-color: var(--ui-accent-subtle);
}
.app-titlebar--microsoft .light-pin.pinned:hover,
.app-titlebar--microsoft .light-pin.bottomed:hover,
.app-titlebar--microsoft .light-pin.is-open,
.app-titlebar--microsoft .light-lock.locked:hover {
  background-color: var(--ui-fill-pressed);
}
.app-titlebar--microsoft .light-close {
  order: 3;
}
.app-titlebar--microsoft .light-close:hover {
  background-color: #c42b1c;
}

/* Teleport 到 body 的窗口层级菜单：采用 macOS 菜单的紧凑勾选布局。 */
.z-order-menu {
  position: fixed;
  z-index: var(--z-global-popover);
  display: grid;
  gap: 1rem;
  padding: 5rem;
  color: var(--text-color);
  background: var(--surface-float);
  border: 1px solid var(--surface-float-border);
  border-radius: 12rem;
  box-shadow:
    0 12rem 32rem rgba(0, 0, 0, 0.18),
    0 2rem 8rem rgba(0, 0, 0, 0.08);
  transform-origin: top center;
  will-change: clip-path;
  -webkit-app-region: no-drag;
}

.z-order-option {
  display: grid;
  grid-template-columns: 18rem minmax(0, 1fr);
  align-items: center;
  gap: 6rem;
  width: 100%;
  min-height: 34rem;
  padding: 5rem 8rem;
  color: inherit;
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: 7rem;
  cursor: pointer;
  outline: none;
  transition:
    color var(--motion-fast) ease,
    background-color var(--motion-fast) ease;
}

.z-order-option:hover,
.z-order-option:focus-visible {
  color: #fff;
  background: var(--ui-accent);
}

.z-order-option-label {
  font-size: var(--fs-body);
  line-height: 1.2;
  white-space: nowrap;
}

.z-order-option.is-active .z-order-option-label {
  font-weight: 600;
}

.z-order-option-check {
  justify-self: start;
  width: 14rem;
  font-size: 13rem;
  line-height: 1;
  color: var(--ui-accent);
  opacity: 0;
}

.z-order-option.is-active .z-order-option-check {
  opacity: 1;
}

.z-order-option:hover .z-order-option-check,
.z-order-option:focus-visible .z-order-option-check {
  color: currentColor;
}
</style>
