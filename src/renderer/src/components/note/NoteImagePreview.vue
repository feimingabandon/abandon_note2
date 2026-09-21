<script setup>
import { ref, watch } from 'vue'
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

async function loadSource(index, sequence = loadSequence) {
  const record = records.value[index]
  if (!record) return
  const source = await window.api.getImageBase64(record.file_path)
  if (sequence !== loadSequence || !source) return
  sources.value[index] = source
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
    sources.value = await Promise.all(
      nextRecords.map((record) => window.api.getImageThumbnail(record.file_path, 512))
    )
    if (sequence !== loadSequence) return
    await loadSource(0, sequence)
  } catch (error) {
    console.error('[NoteImagePreview] 加载图片失败:', error)
    if (sequence === loadSequence) {
      showMessage('error', '图片加载失败，请重试')
      emit('close')
    }
  }
}

function onChange(index) {
  void loadSource(index)
}

watch(
  () => [props.visible, props.noteId],
  ([visible]) => {
    if (visible) void openNoteImages()
    else loadSequence++
  },
  { immediate: true }
)
</script>

<template>
  <ImagePreview
    :visible="visible && sources.length > 0"
    :sources="sources"
    :initial-index="initialIndex"
    @change="onChange"
    @close="emit('close')"
  />
</template>
