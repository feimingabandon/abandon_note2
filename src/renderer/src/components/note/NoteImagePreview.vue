<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import ImagePreview from './ImagePreview.vue'
import { useMessage } from '../../composables/useMessage.js'

const props = defineProps({
  visible: { type: Boolean, default: false },
  noteId: { type: Number, default: null }
})
const emit = defineEmits(['close'])
const { showMessage } = useMessage()
const records = ref([])
const sources = ref([])
const initialIndex = ref(0)
let loadSequence = 0

async function resolveSource(index) {
  const sequence = loadSequence
  const record = records.value[index]
  if (!record) throw new Error('图片预览已失效')
  try {
    const src = await window.api.getImageBase64(record.file_path)
    if (sequence !== loadSequence || !props.visible || !src) throw new Error('图片预览已失效')
    return { src, release() {} }
  } catch (error) {
    if (sequence === loadSequence && props.visible)
      showMessage('warning', '图片暂时无法读取，请重试')
    throw error
  }
}

async function openNoteImages() {
  const sequence = ++loadSequence
  records.value = []
  sources.value = []
  initialIndex.value = 0
  if (!props.noteId) return
  try {
    const nextRecords = await window.api.listImages(props.noteId)
    if (sequence !== loadSequence) return
    if (!nextRecords.length) {
      showMessage('warning', '这条便签没有可预览的图片')
      emit('close')
      return
    }
    records.value = nextRecords
    const thumbnails = await Promise.all(
      nextRecords.map((record) => window.api.getImageThumbnail(record.file_path, 512))
    )
    if (sequence !== loadSequence) return
    sources.value = thumbnails
  } catch (error) {
    console.error('[NoteImagePreview] 加载图片失败:', error)
    if (sequence === loadSequence) {
      showMessage('error', '图片加载失败，请重试')
      emit('close')
    }
  }
}

watch(
  () => [props.visible, props.noteId],
  ([visible]) => {
    if (visible) void openNoteImages()
    else {
      loadSequence++
      records.value = []
      sources.value = []
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  loadSequence++
  records.value = []
  sources.value = []
})
</script>

<template>
  <ImagePreview
    :visible="visible && sources.length > 0"
    :sources="sources"
    :initial-index="initialIndex"
    :resolve-source="resolveSource"
    @close="emit('close')"
  />
</template>
