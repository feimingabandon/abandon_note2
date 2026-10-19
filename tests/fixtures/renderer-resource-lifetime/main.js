import { createApp, h, nextTick, ref } from 'vue'
import ImagePicker from '../../../src/renderer/src/components/note/ImagePicker.vue'
import { createMessageProvider } from '../../../src/renderer/src/composables/useMessage.js'
import '../../../src/renderer/src/assets/tokens.css'

// Test-owned parent: all image loading/preview/cleanup runs inside the product SFC.
createApp({
  setup() {
    createMessageProvider()
    const picker = ref(null)
    const mounted = ref(true)
    const noteId = ref(1)
    const draft = ref(false)
    window.fixture = {
      async setMounted(value) {
        mounted.value = value
        await nextTick()
      },
      async changeNote(value) {
        noteId.value = value
        await nextTick()
      },
      addStored(dataUrl) {
        return picker.value.addImage(dataUrl, 'png', 'fixture-upload.png', 512)
      },
      async useDraft(dataUrl) {
        mounted.value = false
        await nextTick()
        draft.value = true
        mounted.value = true
        await nextTick()
        return picker.value.addImage(dataUrl, 'png', 'fixture-draft.png', 4)
      },
      snapshot() {
        const images = picker.value?.images || []
        return {
          imageCount: images.length,
          cachedOriginals: images.filter((image) => Boolean(image.fullDataUrl)).length,
          draftImageCount: picker.value?.getImages().length || 0,
          storedPaths: images.filter((image) => image.saved).map((image) => image.filePath),
          busy: images.some((image) => image._loading),
          thumbnails: images.map((image) => image.dataUrl)
        }
      }
    }
    return () =>
      h('main', { class: 'app-scene', style: 'padding:24px;overflow:auto;height:100vh' }, [
        h('h1', 'Image preview resource lifetime'),
        mounted.value
          ? h(ImagePicker, {
              ref: picker,
              noteId: draft.value ? null : noteId.value,
              mode: draft.value ? 'memory' : 'persist',
              readonly: false
            })
          : h('p', 'Image picker unmounted')
      ])
  }
}).mount('#app')
