<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import NewNotePanel from './NewNotePanel.vue'
import SearchBox from './SearchBox.vue'

const emit = defineEmits(['create', 'edit'])

const mode = ref('new')
const phase = ref('collapsed') // collapsed | opening | open | closing-content | closing
const expandHeight = ref(58)
const resizing = ref(false)
const searchBoxRef = ref(null)
const searchContentReady = ref(false)
let pendingMode = null
let pendingOpen = false

const geometryExpanded = computed(() =>
  ['opening', 'open', 'closing-content'].includes(phase.value)
)
const contentVisible = computed(() => phase.value === 'open')
const activeUntilCollapsed = computed(() => phase.value !== 'collapsed')

const newBoxClass = computed(() => {
  if (geometryExpanded.value) return mode.value === 'new' ? 'ab-box--expand' : 'ab-box--hidden'
  return { 'ab-box--grow': mode.value === 'new' }
})
const searchBoxClass = computed(() => {
  if (geometryExpanded.value) return mode.value === 'search' ? 'ab-box--expand' : 'ab-box--hidden'
  return { 'ab-box--grow': mode.value === 'search' }
})

function openExpanded() {
  if (phase.value !== 'collapsed') return
  searchContentReady.value = false
  phase.value = 'opening'
}

function closeExpanded(nextMode = null, reopen = false) {
  if (phase.value !== 'open') return
  searchContentReady.value = false
  pendingMode = nextMode
  pendingOpen = reopen
  // 新建面板的内容淡出与外壳收缩并行；搜索结果较密集，仍先淡出内容再收壳。
  phase.value = mode.value === 'new' ? 'closing' : 'closing-content'
}

function onContentTransitionEnd(event, kind) {
  if (event.target !== event.currentTarget || event.propertyName !== 'opacity') return
  if (phase.value === 'open' && mode.value === kind) {
    if (kind === 'search') searchContentReady.value = true
    return
  }
  if (phase.value === 'closing-content' && mode.value === kind) phase.value = 'closing'
}

function onBoxTransitionEnd(event, kind) {
  if (event.target !== event.currentTarget || event.propertyName !== 'height') return
  if (mode.value !== kind) return
  if (phase.value === 'opening') {
    phase.value = 'open'
    return
  }
  if (phase.value !== 'closing') return
  phase.value = 'collapsed'
  const nextMode = pendingMode
  const shouldReopen = pendingOpen
  pendingMode = null
  pendingOpen = false
  if (nextMode) mode.value = nextMode
  if (shouldReopen) requestAnimationFrame(openExpanded)
}

function onModeButtonClick(targetMode) {
  if (phase.value !== 'collapsed') {
    if (phase.value === 'open') closeExpanded(targetMode === mode.value ? null : targetMode)
    return
  }
  // 折叠态点击另一侧时只切换宽度权重，保留原有的左右推拉反馈；
  // 再次点击当前侧才真正展开面板。
  if (targetMode !== mode.value) {
    mode.value = targetMode
    return
  }
  openExpanded()
}

function onNewBtnClick() {
  onModeButtonClick('new')
}

function onSearchBtnClick() {
  onModeButtonClick('search')
}

function openSearch() {
  if (phase.value === 'open' && mode.value === 'search') {
    searchBoxRef.value?.focus?.()
    return
  }
  if (phase.value === 'collapsed') {
    mode.value = 'search'
    openExpanded()
    return
  }
  if (phase.value === 'open') closeExpanded('search', true)
}

function onGlobalKeydown(event) {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return
  if (document.querySelector('.app-scene[inert]')) return
  event.preventDefault()
  openSearch()
}

// ============================================================
// 拖拽调整面板高度
// ============================================================
let isDragging = false
let dragStartY = 0
let dragStartHeight = 0
let dragRaf = null

function onDragStart(e) {
  isDragging = true
  resizing.value = true
  dragStartY = e.clientY
  dragStartHeight = expandHeight.value
  document.addEventListener('mousemove', onDragMove)
  document.addEventListener('mouseup', onDragEnd)
  e.preventDefault()
}

function onDragMove(e) {
  if (!isDragging) return
  if (dragRaf) return
  dragRaf = requestAnimationFrame(() => {
    dragRaf = null
    const deltaY = e.clientY - dragStartY
    const deltaVh = (deltaY / window.innerHeight) * 100
    let h = Math.round(dragStartHeight + deltaVh)
    h = Math.max(30, Math.min(85, h))
    expandHeight.value = h
  })
}

function onDragEnd() {
  isDragging = false
  resizing.value = false
  if (dragRaf) {
    cancelAnimationFrame(dragRaf)
    dragRaf = null
  }
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', onDragEnd)
}

onBeforeUnmount(() => {
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', onDragEnd)
  window.removeEventListener('keydown', onGlobalKeydown)
})

onMounted(() => window.addEventListener('keydown', onGlobalKeydown))

// ============================================================
// 新建便签创建完成回调
// ============================================================
function onNoteCreated() {
  emit('create')
  // 创建成功后自动收起新建面板（仅当面板仍处于展开态时）。
  if (phase.value === 'open' && mode.value === 'new') closeExpanded()
}

function onSearchEdit(note) {
  emit('edit', note)
}

// ============================================================
// 展开态高度
// ============================================================
const expandBoxStyle = computed(() => {
  if (!geometryExpanded.value) return {}
  return { height: expandHeight.value + 'vh' }
})

const isNewExpanded = computed(() => activeUntilCollapsed.value && mode.value === 'new')
const isSearchExpanded = computed(() => activeUntilCollapsed.value && mode.value === 'search')

function isHintInteractive(kind) {
  return mode.value === kind && phase.value === 'collapsed'
}

function hintClass(kind) {
  return {
    'is-selected': mode.value === kind
  }
}

defineExpose({
  refreshSearch: () => searchBoxRef.value?.refresh?.()
})
</script>

<template>
  <div
    class="ab-root"
    :class="{
      'ab-root--expanded': geometryExpanded,
      'ab-root--resizing': resizing,
      'ab-root--collapsed': phase === 'collapsed'
    }"
    :data-phase="phase"
  >
    <!-- ===== 新建框 ===== -->
    <div
      class="ab-box"
      :class="newBoxClass"
      :style="expandBoxStyle"
      @transitionend="onBoxTransitionEnd($event, 'new')"
    >
      <!-- 按钮始终可见，固定在左上角 -->
      <button
        class="ab-box-btn ab-btn-fixed"
        :title="isNewExpanded ? '折叠' : '新建'"
        @click.stop="onNewBtnClick"
      >
        <svg
          class="ab-icon ab-icon--plus"
          :class="{ 'ab-icon--crossed': isNewExpanded }"
          viewBox="0 0 1024 1024"
        >
          <path
            d="M 512 200 V 824"
            fill="none"
            stroke="currentColor"
            stroke-width="100"
            stroke-linecap="round"
          />
          <path
            d="M 200 512 H 824"
            fill="none"
            stroke="currentColor"
            stroke-width="100"
            stroke-linecap="round"
          />
        </svg>
      </button>

      <button
        type="button"
        class="ab-inline-hint ab-inline-hint--new"
        :class="hintClass('new')"
        aria-label="展开新建面板"
        :aria-hidden="!isHintInteractive('new')"
        :tabindex="isHintInteractive('new') ? 0 : -1"
        @click.stop="openExpanded"
      >
        <span class="ab-box-hint-motion">
          <span class="ab-box-hint">请新建一次性便签内容…</span>
        </span>
      </button>

      <button
        v-if="contentVisible && mode === 'new'"
        type="button"
        class="ab-collapse-row-hit ab-collapse-row-hit--start"
        title="折叠新建面板"
        aria-label="折叠新建面板"
        @click.stop="closeExpanded()"
      />

      <div
        class="ab-content-layer ab-content-layer--expanded"
        :class="{ 'is-visible': contentVisible && mode === 'new' }"
        @transitionend="onContentTransitionEnd($event, 'new')"
      >
        <NewNotePanel :active="contentVisible && mode === 'new'" @create="onNoteCreated" />
        <div class="ab-drag-handle" @mousedown="onDragStart">
          <div class="ab-drag-bar" />
        </div>
      </div>
    </div>

    <!-- ===== 搜索框 ===== -->
    <div
      class="ab-box ab-box--search"
      :class="searchBoxClass"
      :style="expandBoxStyle"
      @transitionend="onBoxTransitionEnd($event, 'search')"
    >
      <!-- 按钮始终可见，固定在右上角 -->
      <button
        class="ab-box-btn ab-btn-fixed ab-btn-fixed--right"
        :title="isSearchExpanded ? '折叠' : '搜索'"
        @click.stop="onSearchBtnClick"
      >
        <!-- 放大镜图标 -->
        <svg
          class="ab-icon ab-icon--swap"
          :class="{ 'ab-icon--hide': isSearchExpanded }"
          viewBox="0 0 1024 1024"
        >
          <circle cx="370" cy="370" r="210" fill="none" stroke="currentColor" stroke-width="100" />
          <path
            d="M 530 530 L 780 780"
            fill="none"
            stroke="currentColor"
            stroke-width="100"
            stroke-linecap="round"
          />
        </svg>
        <!-- X 图标 -->
        <svg
          class="ab-icon ab-icon--swap"
          :class="{ 'ab-icon--hide': !isSearchExpanded }"
          viewBox="0 0 1024 1024"
        >
          <path
            d="M 256 256 L 768 768"
            fill="none"
            stroke="currentColor"
            stroke-width="100"
            stroke-linecap="round"
          />
          <path
            d="M 768 256 L 256 768"
            fill="none"
            stroke="currentColor"
            stroke-width="100"
            stroke-linecap="round"
          />
        </svg>
      </button>

      <button
        type="button"
        class="ab-inline-hint ab-inline-hint--search"
        :class="hintClass('search')"
        aria-label="展开搜索面板"
        :aria-hidden="!isHintInteractive('search')"
        :tabindex="isHintInteractive('search') ? 0 : -1"
        @click.stop="openExpanded"
      >
        <span class="ab-box-hint-motion">
          <span class="ab-box-hint">请输入搜索内容</span>
        </span>
      </button>

      <button
        v-if="contentVisible && mode === 'search'"
        type="button"
        class="ab-collapse-row-hit ab-collapse-row-hit--end"
        title="折叠搜索面板"
        aria-label="折叠搜索面板"
        @click.stop="closeExpanded()"
      />

      <div
        class="ab-content-layer ab-content-layer--expanded"
        :class="{ 'is-visible': contentVisible && mode === 'search' }"
        @transitionend="onContentTransitionEnd($event, 'search')"
      >
        <SearchBox
          ref="searchBoxRef"
          :active="contentVisible && mode === 'search'"
          :query-ready="searchContentReady && contentVisible && mode === 'search'"
          @edit="onSearchEdit"
          @request-close="closeExpanded()"
        />
        <div class="ab-drag-handle" @mousedown="onDragStart">
          <div class="ab-drag-bar" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* === 根容器 === */
.ab-root {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 6rem;
  transition: gap 300ms cubic-bezier(0.22, 1, 0.36, 1);
}
/* 展开时收起两框间距，让活跃框平滑撑满整个容器 */
.ab-root--expanded {
  gap: 0;
}

/* === 框体 === */
.ab-box {
  position: relative;
  display: flex;
  flex-direction: column;
  flex-grow: 0;
  flex-shrink: 0;
  flex-basis: 36rem;
  min-width: 0;
  height: 36rem;
  border: 1px solid var(--ui-border-control);
  border-radius: 10rem;
  overflow: hidden;
  background: var(--ui-surface-subtle);
  transition:
    flex-grow 300ms cubic-bezier(0.22, 1, 0.36, 1),
    flex-basis 300ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 200ms ease,
    height 300ms cubic-bezier(0.22, 1, 0.36, 1);
}
.ab-box--grow {
  flex-grow: 1;
}
.ab-box--expand {
  height: 40vh;
  flex-grow: 1;
  flex-basis: 0%;
}
/* 展开时非活跃框：宽度收缩到 0 + 淡出（不用 display:none，保证可过渡） */
.ab-box--hidden {
  flex-basis: 0;
  flex-grow: 0;
  opacity: 0;
  pointer-events: none;
}

/* 拖动高度时直接跟手，松开后再恢复常规高度过渡。 */
.ab-root--resizing .ab-box {
  transition-property: flex-grow, flex-basis, opacity;
}

/* === 通用按钮 === */
.ab-box-btn {
  flex-shrink: 0;
  width: 36rem;
  height: 36rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 10rem;
  background: transparent;
  cursor: pointer;
  color: var(--text-color);
  transition: background 150ms ease;
}
.ab-box-btn:hover {
  background: var(--ui-fill-hover);
}
.ab-box-btn:active {
  transform: scale(0.98);
  transition: transform 70ms ease;
}

/* === 按钮固定定位（脱离 Transition，始终可见） === */
.ab-btn-fixed {
  position: absolute;
  top: 0;
  left: 0;
  z-index: var(--z-local-content);
}
.ab-btn-fixed--right {
  left: auto;
  right: 0;
}

/* 展开后保留整条顶部行作为折叠热区，与折叠态辅助文字的点击位置相呼应。 */
.ab-collapse-row-hit {
  position: absolute;
  top: 0;
  z-index: var(--z-local-content);
  height: 36rem;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.ab-collapse-row-hit--start {
  left: 36rem;
  right: 0;
}
.ab-collapse-row-hit--end {
  left: 0;
  right: 36rem;
}
/* === SVG 图标 === */
.ab-icon {
  width: 16rem;
  height: 16rem;
  display: block;
}

/* 新建按钮：+ 图标旋转 45° 变为 X */
.ab-icon--plus {
  transition: transform 350ms cubic-bezier(0.22, 1, 0.36, 1);
}
.ab-icon--crossed {
  transform: rotate(45deg);
}

/* 搜索按钮：两个图标交替淡入淡出 */
.ab-icon--swap {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  transition: opacity 200ms ease;
}
.ab-icon--hide {
  opacity: 0;
  pointer-events: none;
}

/* === 展开态内容层 === */
.ab-content-layer {
  position: absolute;
  inset: 0;
  display: flex;
  min-height: 0;
  min-width: 0;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition:
    opacity 130ms ease,
    visibility 0s linear 130ms;
}
.ab-content-layer.is-visible {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transition-delay: 0s;
}

/* === 单实例辅助文字：外层补偿横向几何，内层负责纵向显隐 === */
.ab-inline-hint {
  position: absolute;
  top: 0;
  z-index: var(--z-local-base);
  display: flex;
  align-items: center;
  justify-content: center;
  height: 36rem;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-color-secondary);
  font: inherit;
  pointer-events: none;
  transform: translateX(0);
  transition: transform 300ms cubic-bezier(0.22, 1, 0.36, 1);
}
.ab-inline-hint--new {
  left: 36rem;
  right: 0;
}
.ab-inline-hint--search {
  left: 0;
  right: 36rem;
}
.ab-root--collapsed .ab-inline-hint.is-selected {
  pointer-events: auto;
}

/*
 * 展开后活跃框的文字区域中心会横移半个“方形按钮 + 间距”，即 21rem。
 * 外层用同曲线反向补偿，确保文字在宽度变化期间保持屏幕横坐标稳定。
 */
.ab-root[data-phase='opening'] .ab-inline-hint--new,
.ab-root[data-phase='open'] .ab-inline-hint--new,
.ab-root[data-phase='closing-content'] .ab-inline-hint--new {
  transform: translateX(-21rem);
}
.ab-root[data-phase='opening'] .ab-inline-hint--search,
.ab-root[data-phase='open'] .ab-inline-hint--search,
.ab-root[data-phase='closing-content'] .ab-inline-hint--search {
  transform: translateX(21rem);
}

.ab-box-hint-motion {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  opacity: 0;
  transform: translateY(-9rem);
  transition:
    opacity 180ms ease,
    transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
.ab-root--collapsed .ab-box-hint-motion {
  transform: translateY(0);
}
.ab-root--collapsed .ab-inline-hint.is-selected .ab-box-hint-motion {
  opacity: 1;
}
.ab-inline-hint .ab-box-hint {
  width: 100%;
  padding: 0 12rem;
  box-sizing: border-box;
}
/* === 展开态内容区（按钮下方，填满剩余高度） === */
.ab-content-layer--expanded {
  flex-direction: column;
  padding-top: 36rem;
}

/* === 标题文字（搜索面板使用） === */
.ab-expand-title {
  flex-shrink: 0;
  text-align: center;
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
  line-height: 36rem;
}

/* === 折叠态提示文字 === */
.ab-box-hint {
  display: block;
  max-width: 100%;
  text-align: center;
  font-size: var(--fs-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: clip;
  cursor: pointer;
}

/* === 面板内容区（搜索面板使用） === */
.ab-panel-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow-x: hidden;
  padding: 0 14rem;
  padding-bottom: 16rem;
  -webkit-mask-image: linear-gradient(
    to bottom,
    black 0%,
    black calc(100% - 30rem),
    transparent 100%
  );
  mask-image: linear-gradient(to bottom, black 0%, black calc(100% - 30rem), transparent 100%);
}

/* === 拖拽条（底部） === */
.ab-drag-handle {
  display: flex;
  justify-content: center;
  padding: 4rem 0 10rem;
  flex-shrink: 0;
  cursor: ns-resize;
  user-select: none;
}
.ab-drag-bar {
  width: 36rem;
  height: 4rem;
  border-radius: 2rem;
  background-color: color-mix(in srgb, var(--text-color) 20%, transparent);
}

.ab-drag-handle:hover .ab-drag-bar {
  transform: scaleX(1.18);
  background-color: color-mix(in srgb, var(--text-color) 32%, transparent);
}
.ab-drag-bar {
  transition:
    transform var(--motion-control) var(--ease-standard),
    background-color var(--motion-fast) ease;
}
</style>
