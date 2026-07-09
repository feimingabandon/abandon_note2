<script setup>
/**
 * ActionBar.vue — 首页顶部工具栏
 *
 * 折叠态：两个圆角矩形框，flex-grow 跷跷板切换
 * 展开态：活跃框在文档流内向下生长，挤占下方内容
 */
import { ref, computed, onBeforeUnmount } from 'vue'
import DateTimePicker from './DateTimePicker.vue'
import TagSelector from './TagSelector.vue'

const emit = defineEmits(['create'])

// ============================================================
// 状态
// ============================================================
const mode = ref('new') // 'new' | 'search'
const expanded = ref(false)
const collapsing = ref(false) // 收起动画进行中，保持展开内容但缩高
const expandHeight = ref(40) // vh，默认 40vh
const resizing = ref(false)

// ---- 新建便签表单 ----
const newContent = ref('')
const newEffectiveAt = ref('') // "YYYY-MM-DD HH:mm:ss" 或空（空 = 立即生效）
const newTagNames = ref([]) // 选中的标签名称数组
const creating = ref(false) // 防止重复提交

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
// 新建便签提交
// ============================================================
async function handleCreateNote() {
  const content = newContent.value.trim()
  if (!content) return
  if (creating.value) return
  creating.value = true

  try {
    const options = { content }
    // 如果设置了生效时间，转为毫秒时间戳
    if (newEffectiveAt.value) {
      options.effectiveAt = new Date(newEffectiveAt.value).getTime()
    }
    const note = await window.api.createNote(options)
    // 绑定标签
    if (newTagNames.value.length > 0 && note?.id) {
      await window.api.setNoteTags(note.id, newTagNames.value)
    }
    newContent.value = ''
    newEffectiveAt.value = ''
    newTagNames.value = []
    emit('create')
    closeExpanded()
  } catch (e) {
    console.error('[ActionBar] 创建便签失败:', e)
  } finally {
    creating.value = false
  }
}

// ============================================================
// 展开态高度
// ============================================================
const expandBoxStyle = computed(() => {
  if (!expanded.value || collapsing.value) return {}
  return { height: expandHeight.value + 'vh' }
})
</script>

<template>
  <div class="ab-root">
    <!-- ===== 新建框 ===== -->
    <div class="ab-box" :class="newBoxClass" :style="expandBoxStyle">
      <!-- 折叠 ↔ 展开 过渡 -->
      <Transition name="ab-fade" mode="out-in">
        <div
          v-if="(!expanded && !collapsing) || mode !== 'new'"
          key="collapsed"
          class="ab-collapsed-wrapper"
        >
          <button class="ab-box-btn" title="新建" @click.stop="onNewBtnClick">
            <svg class="ab-icon" viewBox="0 0 1024 1024">
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
          <span v-if="mode === 'new'" class="ab-box-hint" @click.stop="toggleExpand"
            >请输入需要新建的便签内容</span
          >
        </div>

        <div
          v-else-if="(expanded || collapsing) && mode === 'new'"
          key="expanded"
          class="ab-expand-inner"
        >
          <div class="ab-expand-header">
            <button class="ab-box-btn" title="折叠" @click.stop="closeExpanded">
              <svg class="ab-icon" viewBox="0 0 1024 1024">
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
            <span class="ab-expand-title">新建便签</span>
            <div class="ab-header-spacer" />
          </div>
          <div class="ab-panel-body scroll-y">
            <!-- 便签内容 -->
            <textarea
              v-model="newContent"
              class="ab-textarea"
              placeholder="输入便签内容…（Enter 换行）"
              rows="3"
            />

            <!-- 标签选择 -->
            <div class="ab-field">
              <label class="ab-field-label">标签</label>
              <TagSelector v-model="newTagNames" />
            </div>

            <!-- 生效时间 -->
            <div class="ab-field">
              <label class="ab-field-label">生效时间</label>
              <DateTimePicker
                v-model="newEffectiveAt"
                placeholder="立即生效"
                :width="'100%'"
              />
            </div>

            <!-- 提交按钮 -->
            <button
              class="ab-submit-btn"
              :disabled="!newContent.trim() || creating"
              @click="handleCreateNote"
            >
              {{ creating ? '创建中…' : '创建便签' }}
            </button>
          </div>
          <div class="ab-drag-handle" @mousedown="onDragStart">
            <div class="ab-drag-bar" />
          </div>
        </div>
      </Transition>
    </div>

    <!-- ===== 搜索框 ===== -->
    <div class="ab-box ab-box--search" :class="searchBoxClass" :style="expandBoxStyle">
      <!-- 折叠 ↔ 展开 过渡 -->
      <Transition name="ab-fade" mode="out-in">
        <div
          v-if="(!expanded && !collapsing) || mode !== 'search'"
          key="collapsed"
          class="ab-collapsed-wrapper ab-collapsed-wrapper--reverse"
        >
          <span v-if="mode === 'search'" class="ab-box-hint" @click.stop="toggleExpand"
            >请输入搜索内容</span
          >
          <button class="ab-box-btn" title="搜索" @click.stop="onSearchBtnClick">
            <svg class="ab-icon" viewBox="0 0 1024 1024">
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
          </button>
        </div>

        <div
          v-else-if="(expanded || collapsing) && mode === 'search'"
          key="expanded"
          class="ab-expand-inner"
        >
          <div class="ab-expand-header">
            <div class="ab-header-spacer" />
            <span class="ab-expand-title">搜索便签</span>
            <button class="ab-box-btn" title="折叠" @click.stop="closeExpanded">
              <svg class="ab-icon" viewBox="0 0 1024 1024">
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
          </div>
          <div class="ab-panel-body scroll-y" />
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
}

/* === 框体 === */
.ab-box {
  display: flex;
  align-items: center;
  flex-grow: 0;
  flex-shrink: 0;
  min-width: 0;
  height: 36rem;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10rem;
  overflow: hidden;
  background: rgba(128, 128, 128, 0.03);
  transition:
    flex-grow 300ms cubic-bezier(0.22, 1, 0.36, 1),
    height 300ms cubic-bezier(0.22, 1, 0.36, 1);
}
.ab-box--grow {
  flex-grow: 1;
}
.ab-box--expand {
  flex-direction: column;
  align-items: stretch;
  height: 40vh;
  flex-grow: 1;
  flex-basis: 0%;
  overflow: hidden;
}
.ab-box--hidden {
  display: none;
}

/* === 展开内部容器 === */
.ab-expand-inner {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
}

/* === 展开头部（按钮 + 标题居中 + 对称占位） === */
.ab-expand-header {
  display: flex;
  align-items: center;
  gap: 10rem;
  flex-shrink: 0;
  padding: 0;
  min-height: 36rem;
}
.ab-header-spacer {
  width: 36rem;
  flex-shrink: 0;
}
.ab-expand-title {
  flex: 1;
  text-align: center;
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
}

/* === 面板内容区 === */
.ab-panel-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow-x: hidden;
  padding: 0 14rem;
}

/* === 拖拽条（底部，参照 SettingsPanel） === */
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

/* 搜索框折叠态右对齐 */
.ab-box--search:not(.ab-box--expand):not(.ab-box--hidden) {
  justify-content: flex-end;
}

/* === 折叠态按钮 === */
.ab-box-btn {
  flex-shrink: 0;
  width: 36rem;
  height: 100%;
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
.ab-icon {
  width: 16rem;
  height: 16rem;
  display: block;
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

/* === 折叠态内容包裹（Transition 需要单根） === */
.ab-collapsed-wrapper {
  display: flex;
  align-items: center;
  width: 100%;
  height: 100%;
}
.ab-collapsed-wrapper--reverse {
  justify-content: flex-end;
}

/* === 内容切换过渡 === */
.ab-fade-enter-active,
.ab-fade-leave-active {
  transition: opacity 180ms ease;
}
.ab-fade-enter-from,
.ab-fade-leave-to {
  opacity: 0;
}

/* === 新建便签表单 === */
.ab-textarea {
  display: block;
  width: 100%;
  padding: 10rem 12rem;
  font-size: var(--fs-body);
  font-family: inherit;
  font-weight: 500;
  color: var(--text-color);
  background: rgba(255, 255, 255, 0.05);
  border: 1rem solid rgba(255, 255, 255, 0.1);
  border-radius: 8rem;
  outline: none;
  resize: vertical;
  transition: border-color 150ms ease;
  line-height: 1.5;
}
.ab-textarea:focus {
  border-color: rgba(255, 255, 255, 0.18);
}
.ab-textarea::placeholder {
  color: var(--text-color-secondary);
  opacity: 0.5;
}

.ab-field {
  margin-top: 12rem;
  display: flex;
  flex-direction: column;
  gap: 6rem;
  min-width: 0;
}
.ab-field-label {
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
  font-weight: 500;
}

.ab-submit-btn {
  margin-top: 14rem;
  display: block;
  width: 100%;
  padding: 10rem 0;
  font-size: var(--fs-body);
  font-family: inherit;
  font-weight: 600;
  color: var(--text-color);
  background: #0071e3;
  border: none;
  border-radius: 8rem;
  cursor: pointer;
  outline: none;
  transition: background-color 150ms ease;
}
.ab-submit-btn:hover:not(:disabled) {
  background: #0077ed;
}
.ab-submit-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
