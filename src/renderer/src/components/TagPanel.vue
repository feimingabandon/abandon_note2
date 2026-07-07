<script setup>
/**
 * TagPanel.vue — 标签面板 + 筛选栏
 *
 * 职责：
 *   1. 展示全部标签列表
 *   2. 创建 / 编辑 / 删除标签
 *   3. 选中标签进行便签筛选
 *
 * 依赖：
 *   window.api.listTags()       — 获取全部标签
 *   window.api.createTag()      — 创建标签
 *   window.api.updateTag()      — 更新标签
 *   window.api.deleteTag()      — 删除标签
 *
 * Emits:
 *   filter — 当选中标签变化时，传出选中的 tagId 数组
 */
import { ref, onMounted, reactive } from 'vue'

const emit = defineEmits(['filter'])

/** 全部标签 */
const tags = ref([])
/** 当前选中的标签 ID 集合 */
const selectedIds = ref(new Set())

/** 颜色预设 */
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

/** 新建/编辑标签状态 */
const editing = reactive({
  active: false,
  id: null,
  name: '',
  color: ''
})

/**
 * 加载标签列表
 */
async function loadTags() {
  try {
    tags.value = await window.api.listTags()
  } catch (e) {
    console.error('[TagPanel] 加载失败:', e)
  }
}

/**
 * 点击标签 → 切换选中
 */
function toggleTag(tagId) {
  const next = new Set(selectedIds.value)
  if (next.has(tagId)) {
    next.delete(tagId)
  } else {
    next.add(tagId)
  }
  selectedIds.value = next
  emit('filter', [...next])
}

/**
 * 开始新建标签
 */
function startCreate() {
  editing.active = true
  editing.id = null
  editing.name = ''
  editing.color = colorPresets[Math.floor(Math.random() * colorPresets.length)]
}

/**
 * 开始编辑标签
 */
function startEdit(tag) {
  editing.active = true
  editing.id = tag.id
  editing.name = tag.name
  editing.color = tag.color || ''
}

/**
 * 取消编辑
 */
function cancelEdit() {
  editing.active = false
  editing.id = null
  editing.name = ''
  editing.color = ''
}

/**
 * 保存标签（创建或更新）
 */
async function saveTag() {
  if (!editing.name.trim()) return

  try {
    if (editing.id) {
      // 更新
      await window.api.updateTag(editing.id, {
        name: editing.name.trim(),
        color: editing.color || null
      })
    } else {
      // 创建
      await window.api.createTag(editing.name.trim(), editing.color || null)
    }
    cancelEdit()
    await loadTags()
  } catch (e) {
    console.error('[TagPanel] 保存失败:', e)
  }
}

/**
 * 删除标签
 */
async function deleteTag(tag) {
  try {
    await window.api.deleteTag(tag.id)
    // 同时从选中集中移除
    if (selectedIds.value.has(tag.id)) {
      const next = new Set(selectedIds.value)
      next.delete(tag.id)
      selectedIds.value = next
      emit('filter', [...next])
    }
    await loadTags()
  } catch (e) {
    console.error('[TagPanel] 删除失败:', e)
  }
}

/**
 * 清除全部选中
 */
function clearSelection() {
  selectedIds.value = new Set()
  emit('filter', [])
}

onMounted(loadTags)
</script>

<template>
  <div class="tag-panel">
    <!-- 标题栏 -->
    <div class="tag-panel__header">
      <span class="tag-panel__title">标签</span>
      <button class="tag-panel__add-btn" @click="startCreate">+</button>
    </div>

    <!-- 新建/编辑标签表单 -->
    <div v-if="editing.active" class="tag-panel__form">
      <input
        v-model="editing.name"
        class="tag-panel__form-input"
        placeholder="标签名称"
        maxlength="10"
        @keyup.enter="saveTag"
        @keyup.escape="cancelEdit"
      />
      <div class="tag-panel__form-colors">
        <button
          v-for="c in colorPresets"
          :key="c"
          class="tag-panel__form-color"
          :class="{ 'tag-panel__form-color--active': editing.color === c }"
          :style="{ backgroundColor: c }"
          @click="editing.color = c"
        />
      </div>
      <div class="tag-panel__form-actions">
        <button class="tag-panel__form-cancel" @click="cancelEdit">取消</button>
        <button class="tag-panel__form-save" @click="saveTag">保存</button>
      </div>
    </div>

    <!-- 选中提示 -->
    <div v-if="selectedIds.size > 0" class="tag-panel__filter-hint">
      已选 {{ selectedIds.size }} 个标签
      <button class="tag-panel__clear-btn" @click="clearSelection">清除</button>
    </div>

    <!-- 标签列表 -->
    <div class="tag-panel__list">
      <div
        v-for="tag in tags"
        :key="tag.id"
        class="tag-panel__item"
        :class="{ 'tag-panel__item--selected': selectedIds.has(tag.id) }"
      >
        <div class="tag-panel__item-left" @click="toggleTag(tag.id)">
          <span class="tag-panel__item-dot" :style="{ backgroundColor: tag.color || '#888' }" />
          <span class="tag-panel__item-name">{{ tag.name }}</span>
        </div>
        <div class="tag-panel__item-actions">
          <button class="tag-panel__item-edit" title="编辑" @click.stop="startEdit(tag)">✎</button>
          <button class="tag-panel__item-delete" title="删除" @click.stop="deleteTag(tag)">
            ×
          </button>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-if="!editing.active && tags.length === 0" class="tag-panel__empty">
      暂无标签，点击 + 创建
    </div>
  </div>
</template>

<style scoped>
.tag-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.tag-panel__header {
  display: flex;
  align-items: center;
  gap: 8rem;
  padding: 10rem 14rem;
  border-bottom: 1px solid rgba(128, 128, 128, 0.12);
  flex-shrink: 0;
}

.tag-panel__title {
  font-size: var(--fs-secondary);
  font-weight: 600;
}

.tag-panel__add-btn {
  margin-left: auto;
  width: 28rem;
  height: 28rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6rem;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-color);
  font-size: var(--fs-body);
  cursor: pointer;
  transition: background-color 150ms ease;
}
.tag-panel__add-btn:hover {
  background: rgba(255, 255, 255, 0.15);
}

/* ---- 编辑表单 ---- */
.tag-panel__form {
  padding: 10rem 14rem;
  border-bottom: 1px solid rgba(128, 128, 128, 0.12);
}

.tag-panel__form-input {
  width: 100%;
  padding: 6rem 10rem;
  border: 1px solid rgba(128, 128, 128, 0.2);
  border-radius: 6rem;
  outline: none;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-color);
  font-family: inherit;
  font-size: var(--fs-secondary);
}
.tag-panel__form-input:focus {
  border-color: rgba(0, 122, 255, 0.4);
}

.tag-panel__form-colors {
  display: flex;
  flex-wrap: wrap;
  gap: 6rem;
  margin-top: 8rem;
}

.tag-panel__form-color {
  width: 22rem;
  height: 22rem;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  transition:
    transform 120ms ease,
    box-shadow 120ms ease;
}
.tag-panel__form-color--active {
  transform: scale(1.25);
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.6);
}
.tag-panel__form-color:hover {
  transform: scale(1.15);
}

.tag-panel__form-actions {
  display: flex;
  gap: 8rem;
  margin-top: 10rem;
}

.tag-panel__form-cancel,
.tag-panel__form-save {
  padding: 5rem 14rem;
  font-size: var(--fs-secondary);
  font-family: inherit;
  font-weight: 500;
  border: none;
  border-radius: 6rem;
  cursor: pointer;
  transition: background-color 150ms ease;
}
.tag-panel__form-cancel {
  background: rgba(128, 128, 128, 0.12);
  color: var(--text-color);
}
.tag-panel__form-cancel:hover {
  background: rgba(128, 128, 128, 0.2);
}
.tag-panel__form-save {
  background: rgba(0, 122, 255, 0.15);
  color: #007aff;
}
.tag-panel__form-save:hover {
  background: rgba(0, 122, 255, 0.25);
}

/* ---- 筛选提示 ---- */
.tag-panel__filter-hint {
  display: flex;
  align-items: center;
  gap: 6rem;
  padding: 8rem 14rem;
  font-size: calc(var(--fs-secondary) * 0.85);
  color: var(--text-color-secondary);
  border-bottom: 1px solid rgba(128, 128, 128, 0.12);
}

.tag-panel__clear-btn {
  padding: 2rem 8rem;
  border: none;
  border-radius: 4rem;
  background: rgba(0, 122, 255, 0.12);
  color: #007aff;
  font-size: calc(var(--fs-secondary) * 0.82);
  font-family: inherit;
  cursor: pointer;
}

/* ---- 标签列表 ---- */
.tag-panel__list {
  flex: 1;
  overflow-y: auto;
  padding: 4rem 0;
}

.tag-panel__item {
  display: flex;
  align-items: center;
  padding: 8rem 14rem;
  transition: background-color 120ms ease;
}
.tag-panel__item:hover {
  background: rgba(255, 255, 255, 0.04);
}
.tag-panel__item--selected {
  background: rgba(0, 122, 255, 0.08);
}

.tag-panel__item-left {
  display: flex;
  align-items: center;
  gap: 8rem;
  flex: 1;
  cursor: pointer;
}

.tag-panel__item-dot {
  width: 10rem;
  height: 10rem;
  border-radius: 50%;
  flex-shrink: 0;
}

.tag-panel__item-name {
  font-size: var(--fs-secondary);
  color: var(--text-color);
}

.tag-panel__item-actions {
  display: flex;
  gap: 2rem;
  opacity: 0;
  transition: opacity 120ms ease;
}
.tag-panel__item:hover .tag-panel__item-actions {
  opacity: 1;
}

.tag-panel__item-edit,
.tag-panel__item-delete {
  width: 24rem;
  height: 24rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 4rem;
  background: transparent;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.9);
  cursor: pointer;
}
.tag-panel__item-edit:hover {
  background: rgba(0, 122, 255, 0.12);
  color: #007aff;
}
.tag-panel__item-delete:hover {
  background: rgba(255, 59, 48, 0.12);
  color: #ff3b30;
}

.tag-panel__empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
}
</style>
