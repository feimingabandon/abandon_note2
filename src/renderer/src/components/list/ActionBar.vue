<script setup>
/**
 * ActionBar.vue — 首页顶部工具栏
 *
 * 折叠态：两个圆角矩形框，flex-grow 跷跷板切换
 * 展开态：活跃框在文档流内向下生长，挤占下方内容
 * 新建表单内容由 NewNotePanel.vue 独立管理
 */
import { ref, computed, onBeforeUnmount } from 'vue'
import NewNotePanel from './NewNotePanel.vue'
import SearchBox from './SearchBox.vue'

const emit = defineEmits(['create'])

// ============================================================
// 状态
// ============================================================
const mode = ref('new') // 'new' | 'search'
const expanded = ref(false)
const collapsing = ref(false) // 收起动画进行中，保持展开内容但缩高
const expandHeight = ref(50) // vh，默认 50vh
const resizing = ref(false)

// ============================================================
// 每个框的动态 class
// ============================================================
const newBoxClass = computed(() => {
  if (expanded.value && !collapsing.value) {
    return mode.value === 'new' ? 'ab-box--expand' : 'ab-box--hidden'
  }
  // 收起中 & 完全折叠：都用跷跷板布局，flex-grow 参与宽度过渡
  return { 'ab-box--grow': mode.value === 'new' }
})
const searchBoxClass = computed(() => {
  if (expanded.value && !collapsing.value) {
    return mode.value === 'search' ? 'ab-box--expand' : 'ab-box--hidden'
  }
  return { 'ab-box--grow': mode.value === 'search' }
})

// ============================================================
// 展开/收起
// ============================================================
function toggleExpand() {
  if (collapsing.value) return // 收起动画中忽略
  expanded.value = !expanded.value
}
function closeExpanded() {
  collapsing.value = true
  setTimeout(() => {
    expanded.value = false
    collapsing.value = false
  }, 300)
}

// ============================================================
// 按钮点击 → 切换模式；展开时自身按钮变为折叠按钮
// ============================================================
function onNewBtnClick() {
  if (expanded.value && mode.value === 'new') {
    closeExpanded()
    return
  }
  if (expanded.value) {
    closeExpanded()
    mode.value = 'new'
    return
  }
  if (mode.value === 'new') {
    toggleExpand()
    return
  }
  mode.value = 'new'
}
function onSearchBtnClick() {
  if (expanded.value && mode.value === 'search') {
    closeExpanded()
    return
  }
  if (expanded.value) {
    closeExpanded()
    mode.value = 'search'
    return
  }
  if (mode.value === 'search') {
    toggleExpand()
    return
  }
  mode.value = 'search'
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
    h = Math.max(25, Math.min(85, h))
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
})

// ============================================================
// 新建便签创建完成回调
// ============================================================
function onNoteCreated() {
  emit('create')
}

// ============================================================
// 展开态高度
// ============================================================
const expandBoxStyle = computed(() => {
  if (!expanded.value || collapsing.value) return {}
  return { height: expandHeight.value + 'vh' }
})

// ============================================================
// 当前是否展开（含收起动画中）
// ============================================================
const isNewExpanded = computed(() => (expanded.value || collapsing.value) && mode.value === 'new')
const isSearchExpanded = computed(() => (expanded.value || collapsing.value) && mode.value === 'search')
</script>

<template>
  <div class="ab-root" :class="{ 'ab-root--expanded': expanded && !collapsing }">
    <!-- ===== 新建框 ===== -->
    <div class="ab-box" :class="newBoxClass" :style="expandBoxStyle">
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

      <!-- 内容区域：折叠 ↔ 展开 过渡 -->
      <Transition name="ab-fade" mode="out-in">
        <!-- 折叠态：仅提示文字 -->
        <div v-if="!isNewExpanded" key="collapsed" class="ab-rest ab-rest--start">
          <span
            v-if="mode === 'new'"
            class="ab-box-hint"
            @click.stop="toggleExpand"
          >请新建一次性便签内容…</span>
        </div>

        <div v-else key="expanded" class="ab-rest ab-rest--column">
          <NewNotePanel @create="onNoteCreated" />
          <div class="ab-drag-handle" @mousedown="onDragStart">
            <div class="ab-drag-bar" />
          </div>
        </div>
      </Transition>
    </div>

    <!-- ===== 搜索框 ===== -->
    <div class="ab-box ab-box--search" :class="searchBoxClass" :style="expandBoxStyle">
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
          <circle
            cx="370"
            cy="370"
            r="210"
            fill="none"
            stroke="currentColor"
            stroke-width="100"
          />
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

      <!-- 内容区域：折叠 ↔ 展开 过渡 -->
      <Transition name="ab-fade" mode="out-in">
        <!-- 折叠态：仅提示文字 -->
        <div v-if="!isSearchExpanded" key="collapsed" class="ab-rest ab-rest--end">
          <span
            v-if="mode === 'search'"
            class="ab-box-hint"
            @click.stop="toggleExpand"
          >请输入搜索内容</span>
        </div>

        <!-- 展开态：标题 + 面板 + 拖拽条 -->
        <div v-else key="expanded" class="ab-rest ab-rest--column">
          <SearchBox />
          <div class="ab-drag-handle" @mousedown="onDragStart">
            <div class="ab-drag-bar" />
          </div>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
/* === 根容器 === */
.ab-root {
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
  border: 1px solid rgb(var(--bg-color) / 0.1);
  border-radius: 10rem;
  overflow: hidden;
  background: rgba(128, 128, 128, 0.03);
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
  opacity: 0;
  pointer-events: none;
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
  background: rgba(128, 128, 128, 0.06);
}
.ab-box-btn:active {
  transform: scale(0.92);
  transition: transform 70ms ease;
}

/* === 按钮固定定位（脱离 Transition，始终可见） === */
.ab-btn-fixed {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
}
.ab-btn-fixed--right {
  left: auto;
  right: 0;
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

/* === 折叠态内容区（按钮之外的剩余空间） === */
.ab-rest {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.ab-rest--start {
  padding-left: 36rem;
  align-items: center;
}
.ab-rest--end {
  padding-right: 36rem;
  justify-content: flex-end;
  align-items: center;
}

/* === 展开态内容区（按钮下方，填满剩余高度） === */
.ab-rest--column {
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
  flex: 1;
  padding: 0 12rem;
  text-align: center;
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
  white-space: nowrap;
  overflow: hidden;
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
  mask-image: linear-gradient(
    to bottom,
    black 0%,
    black calc(100% - 30rem),
    transparent 100%
  );
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
  background-color: rgba(255, 255, 255, 0.2);
}

/* === 内容切换过渡 === */
.ab-fade-enter-active,
.ab-fade-leave-active {
  transition:
    opacity var(--motion-control) ease,
    transform var(--motion-control) var(--ease-standard);
}
.ab-fade-enter-from,
.ab-fade-leave-to {
  opacity: 0;
  transform: translateY(-5rem);
}

.ab-drag-handle:hover .ab-drag-bar {
  transform: scaleX(1.18);
  background-color: rgba(255, 255, 255, 0.32);
}
.ab-drag-bar {
  transition:
    transform var(--motion-control) var(--ease-standard),
    background-color var(--motion-fast) ease;
}
</style>
