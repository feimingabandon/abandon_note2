import { readonly, ref } from 'vue'

// All attachment entry points share one operation. Extra clicks never queue
// original reads or canvases while a conversion/write is already in progress.
const busy = ref(false)
export const imageClipboardBusy = readonly(busy)

export async function copyImageToClipboard({ acquire, isCurrent = () => true }) {
  if (busy.value) return 'busy'
  if (!navigator.clipboard?.write || typeof ClipboardItem !== 'function') {
    throw new Error('当前窗口无法复制图片，请重试')
  }
  busy.value = true
  let source
  let loader
  let canvas
  try {
    if (!isCurrent()) return 'cancelled'
    source = await acquire()
    if (!isCurrent()) return 'cancelled'
    if (!source?.src || typeof source.release !== 'function') throw new Error('图片已失效')
    const image = source.image || (loader = new Image())
    if (loader) {
      loader.decoding = 'async'
      loader.src = source.src
    }
    if (!image.complete || !image.naturalWidth) await image.decode()
    if (!isCurrent()) return 'cancelled'
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片暂时无法读取')
    canvas = document.createElement('canvas')
    // Draw intrinsic pixels. Preview zoom, rotation and thumbnail dimensions
    // must never change the copied attachment's resolution or orientation.
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('图片复制暂时不可用')
    context.drawImage(image, 0, 0)
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => {
        if (value) resolve(value)
        else reject(new Error('图片转换失败，请重试'))
      }, 'image/png')
    })
    if (!isCurrent()) return 'cancelled'
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    } catch (error) {
      throw new Error('无法写入剪贴板，请重试', { cause: error })
    }
    return 'copied'
  } finally {
    // A source lease survives asynchronous PNG conversion and clipboard write,
    // even when its preview has meanwhile left the DOM.
    if (loader) loader.removeAttribute('src')
    if (canvas) canvas.width = canvas.height = 0
    try {
      source?.release?.()
    } finally {
      busy.value = false
    }
  }
}
