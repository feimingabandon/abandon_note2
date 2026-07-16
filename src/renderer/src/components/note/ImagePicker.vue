<script setup>
/**
 * ImagePicker.vue — 图片选择组件
 *
 * 两种模式：
 *   mode="memory" — 图片暂存内存，由父组件决定何时持久化
 *   mode="persist" — 图片即时写入磁盘（需提供 noteId）
 *   readonly        — 只展示已保存图片，隐藏上传和删除操作
 *
 * Props:
 *   noteId  — 便签 ID（persist 模式必传，memory 模式传 null）
 *   mode    — 'memory' | 'persist'，默认 'persist'
 *
 * 暴露方法（memory 模式）：
 *   getImages()    → { base64, ext, name, size }[]
 *   clearImages()  → void
 */
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import ImagePreview from './ImagePreview.vue'

const props = defineProps({
  noteId: { type: Number, default: null },
  mode: { type: String, default: 'persist' },
  readonly: { type: Boolean, default: false }
})

const emit = defineEmits(['count-change'])

/** 图片列表（统一数据格式） */
const images = ref([])
/** 是否拖拽悬停 */
const dragover = ref(false)
/** 文件选择器 */
const fileInput = ref(null)

let imageLoadSeq = 0

/** 支持的图片扩展名 */
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']
/** 单图片最大 50MB */
const MAX_SIZE = 50 * 1024 * 1024
/** 单便签最多 50 张 */
const MAX_COUNT = 50

const canAdd = computed(() => !props.readonly && images.value.length < MAX_COUNT)

/** 大图预览 */
const previewVisible = ref(false)
const previewSrc = ref('')

// ============================================================
// 从 DB 加载已有图片
// ============================================================
async function loadImages() {
  const seq = ++imageLoadSeq
  if (!props.noteId || props.mode !== 'persist') return
  try {
    const records = await window.api.listImages(props.noteId)

    // 列表只加载缩略图；原图在用户点击预览时按需读取。
    const items = await Promise.all(records.map(async (rec) => {
      const thumbnail = await window.api.getImageThumbnail(rec.file_path, 240)
      return {
        id: rec.id,
        name: rec.file_path.split(/[\\/]/).pop(),
        size: rec.file_size,
        filePath: rec.file_path,
        dataUrl: thumbnail || '',
        fullDataUrl: null,
        saved: true
      }
    }))
    if (seq !== imageLoadSeq) return
    images.value = items
  } catch (e) {
    console.error('[ImagePicker] 加载图片失败:', e)
  }
  if (seq !== imageLoadSeq) return
  emitCount()
}

// ============================================================
// 文件处理（拖拽 / 选择共用）
// ============================================================
async function processFiles(files) {
  const available = MAX_COUNT - images.value.length
  if (available <= 0) return

  // 预筛选有效文件
  const valid = []
  for (const file of Array.from(files).slice(0, available)) {
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!IMAGE_EXTS.includes(ext)) continue
    if (file.size > MAX_SIZE) {
      console.warn(`[ImagePicker] 图片过大，跳过:`, file.name)
      continue
    }
    valid.push(file)
  }
  if (valid.length === 0) return

  // 立即插入占位（带 spinner）
  const placeholders = []
  for (const file of valid) {
    const tempId = '_loading_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
    placeholders.push(tempId)
    images.value.push({ id: tempId, name: file.name, size: file.size, _loading: true })
  }
  emitCount()

  // 逐个处理
  for (let i = 0; i < valid.length; i++) {
    const file = valid[i]
    const tempId = placeholders[i]
    const ext = file.name.split('.').pop()?.toLowerCase()

    let dataUrl
    try {
      dataUrl = await readFileAsDataURL(file)
    } catch {
      // 读取失败，移除占位
      const idx = images.value.findIndex((img) => img.id === tempId)
      if (idx !== -1) images.value.splice(idx, 1)
      continue
    }

    const idx = images.value.findIndex((img) => img.id === tempId)
    if (idx === -1) continue

    if (props.mode === 'persist' && props.noteId) {
      try {
        const base64 = dataUrl.split(',')[1]
        const results = await window.api.saveImages(props.noteId, [{ base64, ext }])
        if (results && results.length > 0) {
          const rec = results[0]
          images.value[idx] = {
            id: rec.id,
            _key: tempId,
            name: file.name,
            size: file.size,
            dataUrl,
            fullDataUrl: dataUrl,
            saved: true
          }
        }
      } catch (e) {
        console.error('[ImagePicker] 保存失败:', e)
        images.value.splice(idx, 1)
      }
    } else {
      images.value[idx] = {
        id: null, _key: tempId, name: file.name, size: file.size,
        dataUrl, ext, base64: dataUrl.split(',')[1], saved: false
      }
    }
  }

  emitCount()
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// ============================================================
// 事件处理
// ============================================================
function onDragOver(e) {
  e.preventDefault()
  dragover.value = true
}
function onDragLeave() {
  dragover.value = false
}
async function onDrop(e) {
  e.preventDefault()
  dragover.value = false
  const files = e.dataTransfer?.files
  if (files?.length) await processFiles(files)
}

function onClickSelect() {
  fileInput.value?.click()
}

async function onFileChange(e) {
  const files = e.target.files
  if (files?.length) await processFiles(files)
  // 重置 input 以支持重复选择同一文件
  if (fileInput.value) fileInput.value.value = ''
}

async function handleDelete(img, index) {
  if (img._loading) {
    images.value.splice(index, 1)
    emitCount()
    return
  }
  if (img.saved && img.id) {
    // 已保存的图片：删 DB + 磁盘
    try {
      await window.api.deleteImage(img.id)
    } catch (e) {
      console.error('[ImagePicker] 删除图片失败:', e)
      return
    }
  }
  images.value.splice(index, 1)
  emitCount()
}

/** 打开大图预览 */
async function handlePreview(img) {
  if (img._loading) return
  let source = img.fullDataUrl || img.dataUrl
  if (img.saved && img.filePath && !img.fullDataUrl) {
    source = await window.api.getImageBase64(img.filePath)
  }
  if (!source) return
  previewSrc.value = source
  previewVisible.value = true
}

function closePreview() {
  previewVisible.value = false
  previewSrc.value = ''
}

function emitCount() {
  emit('count-change', images.value.length)
}

// ============================================================
// memory 模式暴露给父组件
// ============================================================
function getImages() {
  return images.value
    .filter((img) => !img._loading && !img.saved)
    .map((img) => ({ base64: img.base64, ext: img.ext, name: img.name, size: img.size }))
}

function clearImages() {
  images.value = []
}

/** 程序化添加图片（供 ScreenshotPicker 等外部调用） */
function addImage(dataUrl, ext, name, size) {
  if (!canAdd.value) return
  const base64 = dataUrl.split(',')[1]
  if (props.mode === 'persist' && props.noteId) {
    window.api.saveImages(props.noteId, [{ base64, ext }]).then((results) => {
      if (results && results.length > 0) {
        const rec = results[0]
        images.value.push({
          id: rec.id,
          name,
          size,
          dataUrl,
          fullDataUrl: dataUrl,
          filePath: rec.file_path,
          saved: true
        })
        emitCount()
      }
    }).catch((e) => console.error('[ImagePicker] 截图保存失败:', e))
  } else {
    images.value.push({
      id: null,
      _key: `memory-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      size,
      dataUrl,
      ext,
      base64,
      saved: false
    })
    emitCount()
  }
}

defineExpose({ getImages, clearImages, addImage, images })

// ============================================================
// noteId 变化时重新加载
// ============================================================
watch(() => props.noteId, loadImages)
onMounted(loadImages)
onUnmounted(() => {
  imageLoadSeq++
})

// ============================================================
// 尺寸格式化
// ============================================================
function formatSize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}
</script>

<template>
  <div class="ip-root" :class="{ 'ip-root--readonly': readonly }">
    <!-- 拖拽区域 — 始终在第一位 -->
    <div
      v-if="!readonly && canAdd"
      class="ip-dropzone"
      :class="{ 'ip-dropzone--active': dragover }"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
      @click="onClickSelect"
    >
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        multiple
        class="ip-input"
        @change="onFileChange"
      />
      <span class="ip-dropzone__icon">+</span>
      <span class="ip-dropzone__text">{{ dragover ? '释放' : '点击添加' }}</span>
      <span v-if="!dragover" class="ip-dropzone__sub">或拖拽添加</span>
    </div>

    <!-- 已满时不可添加的占位 -->
    <div v-else-if="!readonly" class="ip-dropzone ip-dropzone--disabled">
      <span class="ip-dropzone__text ip-dropzone__text--full">已满</span>
    </div>

    <!-- 缩略图列表：新增、删除与补位保持连续 -->
    <TransitionGroup name="ip-thumb" tag="div" class="ip-thumb-list">
      <div v-for="(img, idx) in images" :key="img._key || img.id || `memory-${idx}`" class="ip-thumb">
        <Transition name="ip-content" mode="out-in">
          <div v-if="img._loading" key="loading" class="ip-thumb__spinner">
            <div class="ip-spinner" />
          </div>
          <img
            v-else
            key="image"
            :src="img.dataUrl"
            class="ip-thumb__img"
            :alt="img.name"
            @click.stop="handlePreview(img)"
          />
        </Transition>
        <button v-if="!readonly" class="ip-thumb__del" title="删除" @click.stop="handleDelete(img, idx)">×</button>
        <span class="ip-thumb__name">{{ img.name }}</span>
        <span class="ip-thumb__size">{{ img._loading ? '处理中…' : formatSize(img.size) }}</span>
      </div>
    </TransitionGroup>

    <!-- 大图预览 -->
    <ImagePreview :visible="previewVisible" :src="previewSrc" @close="closePreview" />
  </div>
</template>

<style scoped>
.ip-root {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  gap: 8rem;
  align-items: flex-start;
}

.ip-root--readonly .ip-thumb {
  width: 92rem;
  background: rgb(var(--bg-color) / 0.08);
}

/* 拖拽区域 — 正方形 */
.ip-dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4rem;
  width: 100rem;
  aspect-ratio: 1;
  border: 1px dashed rgba(128, 128, 128, 0.2);
  border-radius: 6rem;
  cursor: pointer;
  transition: border-color 150ms ease, background-color 150ms ease;
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.02);
}
.ip-dropzone:hover {
  border-color: rgba(128, 128, 128, 0.35);
  background: rgba(255, 255, 255, 0.02);
}
.ip-dropzone--active {
  border-color: #0071e3;
  background: rgba(0, 113, 227, 0.06);
  transform: scale(1.02);
  box-shadow: 0 0 0 3rem rgba(0, 113, 227, 0.08);
}
.ip-dropzone--disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.ip-dropzone__icon {
  font-size: 28rem;
  font-weight: 300;
  color: var(--text-color-secondary);
  line-height: 1;
  transition: transform var(--motion-control) var(--ease-standard);
}
.ip-dropzone--active .ip-dropzone__icon {
  transform: scale(1.1);
}
.ip-dropzone__text {
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
  user-select: none;
  pointer-events: none;
}
.ip-dropzone__sub {
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
  user-select: none;
  pointer-events: none;
}
.ip-dropzone__text--full {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}

.ip-input {
  display: none;
}

/* 缩略图 — 固定宽度方块 */
.ip-thumb {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4rem;
  width: 100rem;
  padding: 6rem;
  border-radius: 6rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(128, 128, 128, 0.08);
  flex-shrink: 0;
  transition:
    transform var(--motion-control) var(--ease-standard),
    opacity var(--motion-control) ease,
    box-shadow var(--motion-control) ease;
}
.ip-thumb-list {
  display: contents;
}
.ip-thumb-enter-active,
.ip-thumb-leave-active,
.ip-thumb-move {
  transition:
    transform 220ms var(--ease-standard),
    opacity var(--motion-control) ease;
}
.ip-thumb-enter-from,
.ip-thumb-leave-to {
  opacity: 0;
  transform: scale(0.94);
}
.ip-thumb-leave-active {
  position: absolute;
}
.ip-content-enter-active,
.ip-content-leave-active {
  transition: opacity var(--motion-control) ease;
}
.ip-content-enter-from,
.ip-content-leave-to {
  opacity: 0;
}

.ip-thumb__img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: 4rem;
  cursor: zoom-in;
  transition: transform var(--motion-control) var(--ease-standard);
}
.ip-thumb__img:hover {
  transform: scale(1.015);
}

.ip-thumb__del {
  position: absolute;
  top: 2rem;
  right: 2rem;
  width: 20rem;
  height: 20rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 14rem;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 120ms ease;
}
.ip-thumb:hover .ip-thumb__del {
  opacity: 1;
}

.ip-thumb__name {
  font-size: calc(var(--fs-secondary) * 0.8);
  color: var(--text-color-secondary);
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.ip-thumb__size {
  font-size: calc(var(--fs-secondary) * 0.7);
  color: var(--text-color-secondary);
  opacity: 0.6;
}

/* 加载 spinner */
.ip-thumb__spinner {
  width: 100%;
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ip-spinner {
  width: 32rem;
  height: 32rem;
  border: 3rem solid rgba(128, 128, 128, 0.15);
  border-top-color: #0071e3;
  border-radius: 50%;
  animation: ip-spin 0.8s linear infinite;
}
@keyframes ip-spin {
  to { transform: rotate(360deg); }
}
</style>
