<script setup>
/**
 * AttachmentPanel.vue — 附件面板
 *
 * 职责：
 *   1. 展示便签的附件列表
 *   2. 添加附件（拖拽 / 选择文件）
 *   3. 删除附件
 *
 * Props:
 *   noteId  — 所属便签 ID
 *
 * 依赖：
 *   window.api.addAttachment()     — 添加附件
 *   window.api.removeAttachment()  — 删除附件
 *   window.api.listAttachments()   — 获取附件列表
 */
import { ref, watch, onMounted } from 'vue'

const props = defineProps({
  noteId: { type: Number, default: null }
})

/** 附件列表 */
const attachments = ref([])
/** 上传中 */
const uploading = ref(false)
/** 文件选择器引用 */
const fileInput = ref(null)

/**
 * 媒体类型图标
 */
function mediaIcon(type) {
  const map = { image: '🖼', video: '🎬', audio: '🎵' }
  return map[type] || '📎'
}

/**
 * 格式化文件大小
 */
function formatSize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/**
 * 加载附件列表
 */
async function loadAttachments() {
  if (!props.noteId) {
    attachments.value = []
    return
  }
  try {
    attachments.value = await window.api.listAttachments(props.noteId)
  } catch (e) {
    console.error('[AttachmentPanel] 加载失败:', e)
  }
}

/**
 * 选择文件
 */
function handleSelectFile() {
  fileInput.value?.click()
}

/**
 * 文件选择回调
 */
async function onFileChange(e) {
  const files = e.target.files
  if (!files?.length) return

  uploading.value = true
  try {
    // 逐个添加（实际项目中应由主进程处理文件复制）
    for (const file of files) {
      // 通过 IPC 传递文件路径和基本信息
      // 注：浏览器安全限制无法直接获取真实路径，此处传递文件名
      // 实际项目需在主进程侧用 dialog.showOpenDialog 获取完整路径
      const result = await window.api.addAttachment({
        noteId: props.noteId,
        filePath: file.name, // 占位：实际应为主进程侧完整路径
        fileSize: file.size,
        mediaType: detectType(file.type)
      })
      if (result) {
        attachments.value.push(result)
      }
    }
  } catch (e) {
    console.error('[AttachmentPanel] 上传失败:', e)
  } finally {
    uploading.value = false
    // 重置 input 以便重复选择同一文件
    if (fileInput.value) fileInput.value.value = ''
  }
}

/**
 * 根据 MIME 类型检测媒体类型
 */
function detectType(mime) {
  if (mime?.startsWith('image/')) return 'image'
  if (mime?.startsWith('video/')) return 'video'
  if (mime?.startsWith('audio/')) return 'audio'
  return 'image'
}

/**
 * 删除附件
 */
async function handleRemove(att) {
  try {
    await window.api.removeAttachment(att.id)
    attachments.value = attachments.value.filter((a) => a.id !== att.id)
  } catch (e) {
    console.error('[AttachmentPanel] 删除失败:', e)
  }
}

// 便签切换时重新加载
watch(() => props.noteId, loadAttachments)
onMounted(loadAttachments)
</script>

<template>
  <div class="attachment-panel">
    <!-- 标题栏 -->
    <div class="attachment-panel__header">
      <span class="attachment-panel__title">附件</span>
      <span class="attachment-panel__count">{{ attachments.length }}/50</span>
    </div>

    <!-- 附件列表 -->
    <div v-if="attachments.length > 0" class="attachment-panel__list scroll-y">
      <div v-for="att in attachments" :key="att.id" class="attachment-panel__item">
        <span class="attachment-panel__item-icon">{{ mediaIcon(att.media_type) }}</span>
        <span class="attachment-panel__item-name">{{ att.file_path }}</span>
        <span class="attachment-panel__item-size">{{ formatSize(att.file_size) }}</span>
        <button class="attachment-panel__item-remove" @click="handleRemove(att)">×</button>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="attachment-panel__empty">暂无附件</div>

    <!-- 上传控件 -->
    <div class="attachment-panel__actions">
      <input
        ref="fileInput"
        type="file"
        multiple
        class="attachment-panel__file-input"
        accept="image/*,video/*,audio/*"
        @change="onFileChange"
      />
      <button
        class="attachment-panel__add-btn"
        :disabled="uploading || attachments.length >= 50"
        @click="handleSelectFile"
      >
        {{ uploading ? '上传中…' : '+ 添加附件' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.attachment-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.attachment-panel__header {
  display: flex;
  align-items: center;
  gap: 8rem;
  padding: 10rem 14rem;
  border-bottom: 1px solid rgba(128, 128, 128, 0.12);
  flex-shrink: 0;
}

.attachment-panel__title {
  font-size: var(--fs-secondary);
  font-weight: 600;
}

.attachment-panel__count {
  font-size: calc(var(--fs-secondary) * 0.85);
  color: var(--text-color-secondary);
}

.attachment-panel__list {
  flex: 1;
  padding: 6rem 0;
}

.attachment-panel__item {
  display: flex;
  align-items: center;
  gap: 8rem;
  padding: 8rem 14rem;
  transition: background-color 120ms ease;
}
.attachment-panel__item:hover {
  background: rgba(255, 255, 255, 0.04);
}

.attachment-panel__item-icon {
  font-size: var(--fs-body);
  flex-shrink: 0;
}

.attachment-panel__item-name {
  flex: 1;
  font-size: var(--fs-secondary);
  color: var(--text-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-panel__item-size {
  font-size: calc(var(--fs-secondary) * 0.82);
  color: var(--text-color-secondary);
  flex-shrink: 0;
}

.attachment-panel__item-remove {
  width: 24rem;
  height: 24rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 4rem;
  background: transparent;
  color: var(--text-color-secondary);
  font-size: var(--fs-body);
  cursor: pointer;
  flex-shrink: 0;
}
.attachment-panel__item-remove:hover {
  background: rgba(255, 59, 48, 0.15);
  color: #ff3b30;
}

.attachment-panel__empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-secondary);
  color: var(--text-color-secondary);
}

.attachment-panel__actions {
  padding: 10rem 14rem;
  border-top: 1px solid rgba(128, 128, 128, 0.12);
  flex-shrink: 0;
}

.attachment-panel__file-input {
  display: none;
}

.attachment-panel__add-btn {
  width: 100%;
  padding: 8rem 14rem;
  font-size: var(--fs-secondary);
  font-family: inherit;
  font-weight: 500;
  border: 1px dashed rgba(128, 128, 128, 0.25);
  border-radius: 8rem;
  background: transparent;
  color: var(--text-color);
  cursor: pointer;
  transition: background-color 150ms ease;
}
.attachment-panel__add-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
}
.attachment-panel__add-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
</style>
