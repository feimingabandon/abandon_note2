import { createApp, h, nextTick, ref } from 'vue'
import ImagePicker from '../../../src/renderer/src/components/note/ImagePicker.vue'
import ImagePreview from '../../../src/renderer/src/components/note/ImagePreview.vue'
import NoteImagePreview from '../../../src/renderer/src/components/note/NoteImagePreview.vue'
import { createMessageProvider } from '../../../src/renderer/src/composables/useMessage.js'
import { modalQueue } from '../../../src/renderer/src/utils/modalQueue.js'
import { imageClipboardBusy } from '../../../src/renderer/src/utils/imageClipboard.js'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings-schema.js'
import { applySettingsSnapshot } from '../../../src/renderer/src/utils/applySettingsSnapshot.js'
import '../../../src/renderer/src/assets/tokens.css'

// Match the real renderer's pre-mount CSS defaults. Without this, the root
// design unit is 1px but text tokens have no base and screenshots are unreadable.
applySettingsSnapshot({ values: DEFAULT_SETTINGS })

// Test-owned parent: all image loading/preview/cleanup runs inside the product SFC.
createApp({
  setup() {
    createMessageProvider()
    const picker = ref(null)
    const mounted = ref(true)
    const noteId = ref(1)
    const draft = ref(false)
    const notePreview = ref(false)
    const legacyVisible = ref(false)
    const legacySource = ref('')
    const copiedImages = []
    let holdConversion = false
    const conversions = []
    const originalToBlob = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      const finish = () => originalToBlob.call(this, callback, ...args)
      if (holdConversion) conversions.push(finish)
      else finish()
    }
    // Exercise native Chromium PNG encoding/ClipboardItem, but never replace
    // the user's system clipboard (which may contain non-restorable formats).
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        async write(items) {
          const blob = await items[0].getType('image/png')
          const bitmap = await createImageBitmap(blob)
          const canvas = document.createElement('canvas')
          canvas.width = bitmap.width
          canvas.height = bitmap.height
          const context = canvas.getContext('2d')
          context.drawImage(bitmap, 0, 0)
          copiedImages.push({
            width: bitmap.width,
            height: bitmap.height,
            pixel: [...context.getImageData(0, 0, 1, 1).data],
            type: blob.type
          })
          bitmap.close()
          canvas.width = canvas.height = 0
        }
      }
    })
    const activeUrls = new Set()
    const revocations = []
    const createUrl = URL.createObjectURL.bind(URL)
    const revokeUrl = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = (blob) => {
      const url = createUrl(blob)
      activeUrls.add(url)
      return url
    }
    URL.revokeObjectURL = (url) => {
      revocations.push({
        url,
        connected: [...document.images].some((image) => image.isConnected && image.src === url)
      })
      activeUrls.delete(url)
      revokeUrl(url)
    }
    let maximumPreviewImages = 0
    let queued = false
    const observer = new MutationObserver(() => {
      maximumPreviewImages = Math.max(
        maximumPreviewImages,
        document.querySelectorAll('.ipv-image').length
      )
    })
    observer.observe(document.body, { childList: true, subtree: true })
    window.fixture = {
      holdCopyConversion() {
        holdConversion = true
      },
      releaseCopyConversion() {
        holdConversion = false
        for (const finish of conversions.splice(0)) finish()
      },
      clipboardSnapshot() {
        return { copiedImages, converting: conversions.length, busy: imageClipboardBusy.value }
      },
      queueProbe() {
        queued = false
        const release = modalQueue.enqueue(() => {
          queued = true
          queueMicrotask(() => release())
        })
      },
      showLegacy(source) {
        legacySource.value = source
        legacyVisible.value = true
      },
      clearImages() {
        picker.value.clearImages()
      },
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
        return picker.value.addImage(
          dataUrl,
          'png',
          'fixture-draft.png',
          atob(dataUrl.split(',')[1]).length
        )
      },
      addDraft(dataUrl) {
        return picker.value.addImage(
          dataUrl,
          'png',
          'fixture-next.png',
          atob(dataUrl.split(',')[1]).length
        )
      },
      snapshot() {
        const images = picker.value?.images || []
        return {
          imageCount: images.length,
          cachedOriginals: images.filter((image) => Boolean(image.fullDataUrl)).length,
          draftImageCount: picker.value?.getImages().length || 0,
          storedPaths: images.filter((image) => image.saved).map((image) => image.filePath),
          busy: images.some((image) => image._loading),
          thumbnails: images.map((image) => image.dataUrl),
          activeBlobUrls: activeUrls.size,
          revocations,
          maximumPreviewImages,
          queued
        }
      }
    }
    return () =>
      h('main', { class: 'app-scene', style: 'padding:24px;overflow:auto;height:100vh' }, [
        h('h1', 'Image preview resource lifetime'),
        h(
          'button',
          {
            id: 'note-preview',
            onClick: () => {
              notePreview.value = true
            }
          },
          'Preview note'
        ),
        h(NoteImagePreview, {
          visible: notePreview.value,
          noteId: noteId.value,
          onClose: () => {
            notePreview.value = false
          }
        }),
        h(ImagePreview, {
          visible: legacyVisible.value,
          src: legacySource.value,
          onClose: () => {
            legacyVisible.value = false
          }
        }),
        mounted.value
          ? h(ImagePicker, {
              ref: picker,
              noteId: draft.value ? null : noteId.value,
              mode: draft.value ? 'memory' : 'persist',
              assetPort: draft.value ? window.api.fixtureDraftAssets : null,
              readonly: false
            })
          : h('p', 'Image picker unmounted')
      ])
  }
}).mount('#app')
