<script setup>
/**
 * TagSelector.vue — 统一标签选择器组件
 *
 * 职责：
 *   1. 横向展示全部已创建标签（可横向滚动）
 *   2. 点击标签芯片切换选中/取消选中
 *   3. 末尾 "+" 按钮 → 内联展开新建标签表单
 *   4. 通过 v-model 双向绑定选中标签 ID 数组
 *
 * UI 与数据驱动分离：
 *   - UI 层：统一展示标签芯片 + 新建按钮
 *   - 数据层：选中状态由外部 v-model 控制（新建便签、编辑便签、筛选查询等场景各不同）
 */
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'

const props = defineProps({
  /** 已选中的标签 ID 数组（v-model） */
  modelValue: {
    type: Array,
    default: () => []
  }
})

const emit = defineEmits(['update:modelValue'])

// ---- 颜色预设（与 TagPanel 共享） ----
const colorPresets = [
  '#007aff',
  '#ff3b30',
  '#34c759',
  '#ff9500',
  '#af52de',
  '#ff2d55',
  '#5856d6',
  '#00c7be',
  '#7b7b7b',
  '#ff9f0a',
  '#30b0c7',
  '#d35400'
]

// ---- 状态 ----
/** 全部标签列表 */
const tags = ref([])
/** 内部选中集合（与 modelValue 同步，存储标签名称字符串） */
const selectedNames = ref(new Set(props.modelValue))
/** 新建表单是否展开 */
const showForm = ref(false)
/** 新建标签名称 */
const newName = ref('')
/** 新建标签颜色 */
const newColor = ref('')
/** 颜色文本值（与 newColor 双向同步） */
const newColorText = ref('')
/** 是否正在保存 */
const saving = ref(false)
/** 删除确认弹窗 */
const showDeleteDialog = ref(false)
/** 待删除的标签 */
const tagToDelete = ref(null)

const inputRef = ref(null)

// ---- 颜色同步：newColor ↔ newColorText ----
watch(newColor, (val) => {
  newColorText.value = val || ''
})

/** 颜色文本值是否匹配某个预设 */
function isPresetMatch(preset) {
  return newColor.value.toLowerCase() === preset.toLowerCase()
}

/** 从文本输入同步颜色值 */
function onColorTextInput(e) {
  let raw = e.target.value.trim()
  // 自动补 # 前缀
  if (raw && !raw.startsWith('#')) raw = '#' + raw
  newColorText.value = raw
  // 验证是否为合法 hex
  if (/^#[0-9A-Fa-f]{6}$/.test(raw)) {
    newColor.value = raw.toLowerCase()
  }
  // 不合法时保留文本但不同步到 newColor（颜色不变）
}

// ---- modelValue 外部同步 ----
watch(
  () => props.modelValue,
  (val) => {
    selectedNames.value = new Set(val || [])
  }
)

// ---- 标签数据 ----
async function loadTags() {
  try {
    tags.value = await window.api.listTags()
  } catch (e) {
    console.error('[TagSelector] 加载标签失败:', e)
  }
}

// ---- 刷新按钮旋转动画 ----
const refreshSpinning = ref(false)

/** 双 rAF 强制重排，确保每次点击都能重新触发旋转动画 */
function restartRefreshSpin() {
  refreshSpinning.value = false
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      refreshSpinning.value = true
    })
  })
}

// ---- 刷新：重放逐个入场动画（与状态筛选面板 chip 一致：淡入+上浮，总窗口恒定） ----
const chipAnimating = ref(false)
const CHIP_ANIM_DURATION = 250   // 单 chip 动画时长(ms)，与 ts-chip-in 关键帧对齐
const CHIP_TOTAL_WINDOW = 565    // 从首到尾的总动画窗口(ms)，与状态面板 10 chip × 35ms + 250ms 对齐
const CHIP_STAGGER_MIN = 35      // 最小步进保护
const CHIP_INITIAL_DELAY = 80    // 首个标签延迟(ms)，避免立刻蹦出显得突兀

/** 动态错峰步长：数量少慢，数量多快，总窗口恒定 */
const staggerStep = computed(() => {
  const n = tags.value.length
  if (n <= 1) return 0
  const step = (CHIP_TOTAL_WINDOW - CHIP_ANIM_DURATION) / (n - 1)
  return Math.max(CHIP_STAGGER_MIN, step)
})

/** 双 rAF 强制重排，确保每次点击都能重新触发动画 */
function replayChipAnim() {
  chipAnimating.value = false
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      chipAnimating.value = true
    })
  })
}

/** 刷新按钮处理：旋转图标 + 重新加载 + 重放芯片动画 */
async function onRefresh() {
  restartRefreshSpin()
  await loadTags()
  replayChipAnim()
}

// ---- 选中切换 ----
function toggleTag(tagName) {
  if (hasDragged) return
  const next = new Set(selectedNames.value)
  if (next.has(tagName)) {
    next.delete(tagName)
  } else {
    next.add(tagName)
  }
  selectedNames.value = next
  emit('update:modelValue', [...next])
}

// ---- 新建表单 ----
function openForm() {
  showForm.value = true
  const c = colorPresets[Math.floor(Math.random() * colorPresets.length)]
  newColor.value = c
  newColorText.value = c
  nextTick(() => {
    inputRef.value?.focus()
  })
}

function closeForm() {
  showForm.value = false
  newName.value = ''
}

async function saveTag() {
  const name = newName.value.trim()
  if (!name || saving.value) return
  saving.value = true
  try {
    await window.api.createTag(name, newColor.value || null)
    closeForm()
    await loadTags()
  } catch (e) {
    console.error('[TagSelector] 创建标签失败:', e)
  } finally {
    saving.value = false
  }
}

function onFormKeydown(e) {
  if (e.key === 'Escape') {
    closeForm()
  }
}

// ---- 删除标签 ----
function confirmDelete(tag) {
  tagToDelete.value = tag
  showDeleteDialog.value = true
}

async function handleDelete() {
  if (!tagToDelete.value) return
  const tagName = tagToDelete.value.name
  try {
    await window.api.deleteTag(tagName)
    // 如果删的是选中的标签，从选中集移除
    if (selectedNames.value.has(tagName)) {
      const next = new Set(selectedNames.value)
      next.delete(tagName)
      selectedNames.value = next
      emit('update:modelValue', [...next])
    }
    await loadTags()
  } catch (e) {
    console.error('[TagSelector] 删除标签失败:', e)
  } finally {
    tagToDelete.value = null
  }
}

// ---- 滚轮横向滚动（阻止竖向传导） ----
function onTagWheel(e) {
  e.currentTarget.scrollLeft += e.deltaY * 2
}

// ---- 鼠标拖拽横向滚动 ----
const DRAG_THRESHOLD = 3
let dragScrollEl = null
let dragStartX = 0
let dragStartScroll = 0
let hasDragged = false

function onTagMouseDown(e) {
  if (e.target.closest('.ts-chip-del')) return
  dragScrollEl = e.currentTarget
  dragStartX = e.clientX
  dragStartScroll = dragScrollEl.scrollLeft
  hasDragged = false
  document.addEventListener('mousemove', onTagMouseMove)
  document.addEventListener('mouseup', onTagMouseUp)
}

function onTagMouseMove(e) {
  if (!dragScrollEl) return
  const dx = e.clientX - dragStartX
  if (Math.abs(dx) >= DRAG_THRESHOLD) hasDragged = true
  dragScrollEl.scrollLeft = dragStartScroll - dx
}

function onTagMouseUp() {
  document.removeEventListener('mousemove', onTagMouseMove)
  document.removeEventListener('mouseup', onTagMouseUp)
  dragScrollEl = null
}

onBeforeUnmount(() => {
  document.removeEventListener('mousemove', onTagMouseMove)
  document.removeEventListener('mouseup', onTagMouseUp)
})

onMounted(async () => {
  await loadTags()
  await nextTick()
  replayChipAnim()
})
</script>

<template>
  <div class="ts-root">
    <!-- ===== 标签行 ===== -->
    <div class="ts-row">
      <!-- 横向滚动标签区 -->
      <div class="ts-scroll" @wheel.prevent="onTagWheel" @mousedown="onTagMouseDown">
        <div
          v-for="(tag, i) in tags"
          :key="tag.id"
          class="ts-chip"
          :class="{ 'ts-chip--selected': selectedNames.has(tag.name), 'ts-chip-anim': chipAnimating }"
          :style="{ '--chip-color': tag.color || '#888', animationDelay: chipAnimating ? (CHIP_INITIAL_DELAY + i * staggerStep) + 'ms' : '' }"
        >
          <span class="ts-chip-body" @click="toggleTag(tag.name)">
            <span class="ts-chip-dot" />
            <span class="ts-chip-name">{{ tag.name }}</span>
          </span>
          <button class="ts-chip-del" @click.stop="confirmDelete(tag)" title="删除标签">
            <svg viewBox="0 0 16 16" class="ts-chip-del-icon">
              <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </button>
        </div>

        <!-- 空状态提示 -->
        <span v-if="tags.length === 0" class="ts-empty">暂无标签</span>
      </div>

      <!-- 操作按钮组 -->
      <span class="ts-actions">
        <!-- 刷新按钮 -->
        <button class="ts-refresh-btn" title="刷新标签" @click="onRefresh">
          <svg class="ts-refresh-icon" :class="{ 'ts-refresh-icon--spin': refreshSpinning }" viewBox="0 0 24 24">
            <path
              d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path
              d="M21 3v5h-5"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>

        <!-- 新建按钮 -->
        <button
          class="ts-add-btn"
          :class="{ 'ts-add-btn--open': showForm }"
          @click="showForm ? closeForm() : openForm()"
        >
          <svg class="ts-add-icon" viewBox="0 0 24 24">
            <path
              d="M12 5v14M5 12h14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </span>
    </div>

    <!-- ===== 新建表单（内联展开，有归属感） ===== -->
    <div class="ts-form-wrapper" :class="{ 'ts-form-wrapper--open': showForm }">
      <div class="ts-form-inner">
        <div class="ts-form" @keydown="onFormKeydown">
          <!-- 名称输入 -->
          <input
            ref="inputRef"
            v-model="newName"
            class="ts-form-input"
            placeholder="标签名称"
            maxlength="10"
            @keyup.enter="saveTag"
          />

          <!-- 颜色选择器 + 文本值 + 保存 -->
          <div class="ts-form-color-row">
            <input
              type="color"
              :value="newColor"
              class="ts-form-color-picker"
              @input="newColor = ($event.target).value"
            />
            <input
              v-model="newColorText"
              class="ts-form-color-text"
              placeholder="#007aff"
              maxlength="7"
              @input="onColorTextInput"
            />
            <button
              class="ts-form-save"
              :disabled="!newName.trim() || saving"
              @click="saveTag"
            >
              {{ saving ? '创建中…' : '保存' }}
            </button>
          </div>

          <!-- 颜色选择 -->
          <div class="ts-form-colors">
            <button
              v-for="c in colorPresets"
              :key="c"
              class="ts-form-color"
              :class="{ 'ts-form-color--active': isPresetMatch(c) }"
              :style="{ backgroundColor: c }"
              @click="newColor = c"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- 删除确认弹窗 -->
    <ConfirmDialog
      v-model:visible="showDeleteDialog"
      title="删除标签"
      :message="`确定要删除标签「${tagToDelete?.name}」吗？`"
      confirm-text="删除"
      variant="danger"
      @confirm="handleDelete"
    />
  </div>
</template>

<style scoped>
/* ===== 根容器 ===== */
.ts-root {
  overflow: hidden;
}

/* ===== 标签行 ===== */
.ts-row {
  display: flex;
  align-items: center;
  gap: 8rem;
  overflow: hidden; /* 截断横向溢出，防止撑大外层容器 */
}

/* ---- 横向滚动区 ---- */
.ts-scroll {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8rem;
  overflow-x: auto;
  overflow-y: hidden;
  user-select: none;
  margin-right: 8rem;

  /* 隐藏滚动条（保持可滚动） */
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.ts-scroll::-webkit-scrollbar {
  display: none;
}

/* ---- 标签芯片 ---- */
.ts-chip {
  display: inline-flex;
  align-items: center;
  gap: 4rem;
  flex-shrink: 0;
  font-size: calc(var(--fs-secondary) * 0.85);
  font-family: inherit;
  font-weight: 500;
  color: var(--text-color);
  border: 1rem solid rgba(255, 255, 255, 0.1);
  border-radius: 14rem;
  background: rgba(128, 128, 128, 0.05);
  transition:
    background-color 150ms ease,
    border-color 150ms ease,
    box-shadow 150ms ease;
  user-select: none;
  white-space: nowrap;
}
.ts-chip:hover {
  background: rgba(128, 128, 128, 0.1);
}

/* 芯片主体（点击切换选中） */
.ts-chip-body {
  display: inline-flex;
  align-items: center;
  gap: 5rem;
  padding: 5rem 2rem 5rem 14rem;
  cursor: pointer;
}

/* 删除按钮 */
.ts-chip-del {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20rem;
  height: 20rem;
  margin-right: 4rem;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-color-secondary);
  cursor: pointer;
  flex-shrink: 0;
  opacity: 0;
  transition:
    opacity 120ms ease,
    background-color 120ms ease,
    color 120ms ease;
}
.ts-chip:hover .ts-chip-del {
  opacity: 1;
}
.ts-chip-del:hover {
  background: rgba(255, 59, 48, 0.12);
  color: #ff3b30;
}
.ts-chip-del-icon {
  width: 10rem;
  height: 10rem;
  display: block;
}

/* 选中态：标签主题色透出 */
.ts-chip--selected {
  border-color: var(--chip-color);
  background: color-mix(in srgb, var(--chip-color) 14%, transparent);
  box-shadow: 0 0 0 1rem color-mix(in srgb, var(--chip-color) 20%, transparent);
}
.ts-chip--selected:hover {
  background: color-mix(in srgb, var(--chip-color) 20%, transparent);
}

/* ---- 芯片圆点 ---- */
.ts-chip-dot {
  width: 8rem;
  height: 8rem;
  border-radius: 50%;
  background-color: var(--chip-color);
  flex-shrink: 0;
}

/* ---- 芯片名称 ---- */
.ts-chip-name {
  white-space: nowrap;
}

/* ---- 刷新时逐个入场（与状态筛选面板 nl-card-in 一致：淡入+上浮，延迟由 :style 注入） ---- */
.ts-chip-anim {
  animation: ts-chip-in 250ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes ts-chip-in {
  from {
    opacity: 0;
    transform: translateY(6rem);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* ---- 空状态 ---- */
.ts-empty {
  flex-shrink: 0;
  font-size: calc(var(--fs-secondary) * 0.85);
  color: var(--text-color-secondary);
  white-space: nowrap;
}

/* ---- 操作按钮组（无间距） ---- */
.ts-actions {
  display: flex;
  align-items: center;
  gap: 0;
  flex-shrink: 0;
}

/* ---- 刷新按钮 ---- */
.ts-refresh-btn {
  flex-shrink: 0;
  width: 34rem;
  height: 34rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6rem;
  background: transparent;
  color: var(--text-color);
  cursor: pointer;
  transition: background-color 150ms ease;
}
.ts-refresh-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}

.ts-refresh-icon {
  width: 18rem;
  height: 18rem;
  display: block;
}

/* 点击刷新时图标旋转 360°（苹果弹性缓出，与项目动效体系一致） */
.ts-refresh-icon--spin {
  animation: ts-refresh-spin 500ms cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes ts-refresh-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

/* ---- 新建按钮 ---- */
.ts-add-btn {
  flex-shrink: 0;
  width: 34rem;
  height: 34rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6rem;
  background: transparent;
  color: var(--text-color);
  cursor: pointer;
  transition:
    background-color 150ms ease;
}
.ts-add-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}

/* 展开态：按钮变红 + 图标旋转 45° → × */
.ts-add-btn--open {
  background: rgba(255, 59, 48, 0.12);
  color: #ff3b30;
}
.ts-add-btn--open:hover {
  background: rgba(255, 59, 48, 0.2);
}
.ts-add-btn--open .ts-add-icon {
  transform: rotate(45deg);
}

.ts-add-icon {
  width: 20rem;
  height: 20rem;
  display: block;
  transition: transform 250ms cubic-bezier(0.22, 1, 0.36, 1);
}

/* ===== 新建表单（内联展开，归属感） ===== */
.ts-form-wrapper {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 280ms cubic-bezier(0.22, 1, 0.36, 1);
  overflow: hidden;
}
.ts-form-wrapper--open {
  grid-template-rows: 1fr;
}

.ts-form-inner {
  overflow: hidden;
}

.ts-form {
  margin-top: 10rem;
  padding: 10rem 12rem;
  border: 1rem solid rgba(255, 255, 255, 0.1);
  border-radius: 8rem;
  background: rgba(128, 128, 128, 0.03);
}

/* ---- 名称输入 ---- */
.ts-form-input {
  width: 100%;
  padding: 6rem 10rem;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6rem;
  outline: none;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-color);
  font-family: inherit;
  font-size: var(--fs-secondary);
  transition: border-color 150ms ease;
}
.ts-form-input:focus {
  border-color: rgba(255, 255, 255, 0.18);
}
.ts-form-input::placeholder {
  color: var(--text-color-secondary);
  opacity: 0.5;
}

/* ---- 颜色选择器 + 文本值 ---- */
.ts-form-color-row {
  display: flex;
  align-items: center;
  gap: 8rem;
  margin-top: 8rem;
}

.ts-form-color-picker {
  width: 28rem;
  height: 28rem;
  padding: 0;
  border: 1rem solid rgba(255, 255, 255, 0.1);
  border-radius: 6rem;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.05);
  flex-shrink: 0;
}
.ts-form-color-picker::-webkit-color-swatch-wrapper {
  padding: 2rem;
}
.ts-form-color-picker::-webkit-color-swatch {
  border: none;
  border-radius: 3rem;
}

.ts-form-color-text {
  flex: 1;
  min-width: 0;
  padding: 6rem 10rem;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6rem;
  outline: none;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-color);
  font-family: inherit;
  font-size: var(--fs-secondary);
  transition: border-color 150ms ease;
}
.ts-form-color-text:focus {
  border-color: rgba(255, 255, 255, 0.18);
}
.ts-form-color-text::placeholder {
  color: var(--text-color-secondary);
  opacity: 0.5;
}

/* ---- 保存按钮（行内，颜色行右侧） ---- */
.ts-form-save {
  padding: 6rem 14rem;
  font-size: var(--fs-secondary);
  font-family: inherit;
  font-weight: 500;
  border: none;
  border-radius: 6rem;
  cursor: pointer;
  background: rgba(0, 122, 255, 0.15);
  color: #007aff;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background-color 150ms ease;
}
.ts-form-save:hover:not(:disabled) {
  background: rgba(0, 122, 255, 0.25);
}
.ts-form-save:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ---- 颜色选择 ---- */
.ts-form-colors {
  display: flex;
  flex-wrap: wrap;
  gap: 6rem;
  margin-top: 8rem;
}

.ts-form-color {
  width: 22rem;
  height: 22rem;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  transition:
    transform 120ms ease,
    box-shadow 120ms ease;
}
.ts-form-color--active {
  transform: scale(1.25);
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.6);
}
.ts-form-color:hover {
  transform: scale(1.15);
}

</style>
