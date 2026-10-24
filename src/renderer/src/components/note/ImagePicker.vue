<script setup>
/**
 * ImagePicker.vue — 图片选择组件
 *
 * 三种模式：
 *   mode="memory" — 图片暂存会话资产，由父组件决定何时提交
 *   mode="persist" — 图片即时写入磁盘（需提供 noteId）
 *   mode="draft"   — 加载已有图片，新增和删除只记录为未提交草稿
 *   readonly        — 只展示已保存图片，隐藏上传和删除操作
 *
 * Props:
 *   noteId  — 便签 ID（persist 模式必传，memory 模式传 null）
 *   mode    — 'memory' | 'persist' | 'draft'，默认 'persist'
 *   assetPort — memory/draft 模式使用所属表单的草稿资产端口
 *
 * 暴露方法（memory 模式）：
 *   getImages()    → { assetId, ext, name, size, sha256 }[]
 *   clearImages()  → void
 */
import { computed, nextTick, onMounted, onUnmounted, ref, unref, watch } from 'vue'
import ImagePreview from './ImagePreview.vue'
import ImageCopyMenu from './ImageCopyMenu.vue'
import { copyImageToClipboard, imageClipboardBusy } from '../../utils/imageClipboard.js'
import { useMessage } from '../../composables/useMessage.js'
import {
  MAX_ATTACHMENTS_PER_NOTE,
  MAX_ATTACHMENT_BATCH_BYTES,
  MAX_IMAGE_BYTES,
  getBase64DecodedSize
} from '../../../../shared/attachment-rules.js'

const { showMessage } = useMessage()

const props = defineProps({
  noteId: { type: Number, default: null },
  mode: { type: String, default: 'persist' },
  assetPort: { type: Object, default: null },
  readonly: { type: Boolean, default: false },
  readonlyMaxSize: { type: Number, default: 92 },
  carousel: { type: Boolean, default: false },
  expanded: { type: Boolean, default: false },
  collapsedHeight: { type: Number, default: 160 },
  refreshKey: { type: [String, Number], default: '' }
})

const emit = defineEmits(['count-change', 'draft-change', 'overflow-change', 'busy-change'])

/** 图片列表（统一数据格式） */
const images = ref([])
/** draft 模式下等待保存时删除的已有附件 ID。 */
const deletedImageIds = ref([])
/** 是否拖拽悬停 */
const dragover = ref(false)
/** 文件选择器 */
const fileInput = ref(null)
const loadingImages = ref(false)
const restoringImages = ref(false)
const pendingMutations = ref(0)
const mutationTokens = new Set()
const assetOrigins = new Map()
const busy = computed(
  () =>
    loadingImages.value ||
    restoringImages.value ||
    pendingMutations.value > 0 ||
    images.value.some((image) => image._loading)
)
// 同步通知父表单，不能等下一次渲染才阻止保存或切换视图。
watch(busy, (value) => emit('busy-change', value), { immediate: true, flush: 'sync' })

let imageLoadSeq = 0
let imageMutationSeq = 0
let disposed = false
let previewSession = 0

/** 支持的图片扩展名 */
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']
const canAdd = computed(
  () =>
    !props.readonly &&
    !loadingImages.value &&
    !restoringImages.value &&
    images.value.length < MAX_ATTACHMENTS_PER_NOTE
)
const pendingAddedBytes = computed(() =>
  images.value
    .filter((image) => !image.saved)
    .reduce((total, image) => total + Math.max(0, Number(image.size) || 0), 0)
)

/** 大图预览 */
const previewVisible = ref(false)
const previewSources = ref([])
const previewIndex = ref(0)
const copyMenu = ref(null)
let copyTarget = null
const carouselIndex = ref(0)
const carouselDirection = ref('next')
const carouselRef = ref(null)
const carouselNaturalHeight = ref(0)
let carouselResizeObserver = null
const carouselActiveImage = computed(() => images.value[carouselIndex.value] || null)
const carouselTransitionName = computed(() =>
  carouselDirection.value === 'previous' ? 'ip-carousel-previous' : 'ip-carousel-next'
)
const carouselStageStyle = computed(() => {
  const width = Number(carouselActiveImage.value?._naturalWidth)
  const height = Number(carouselActiveImage.value?._naturalHeight)
  return {
    '--ip-carousel-image-width': Number.isFinite(width) && width > 0 ? `${width}px` : '100%',
    '--ip-carousel-image-aspect':
      Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
        ? String(width / height)
        : '1'
  }
})
const carouselViewportStyle = computed(() => {
  const naturalHeight = carouselNaturalHeight.value
  if (!naturalHeight) return { height: `${props.collapsedHeight}rem` }
  return {
    height: props.expanded
      ? `${naturalHeight}px`
      : `min(${naturalHeight}px, ${props.collapsedHeight}rem)`
  }
})

// ============================================================
// 从 DB 加载已有图片
// ============================================================
async function loadImages() {
  if (disposed) return
  closePreview()
  const seq = ++imageLoadSeq
  if (!props.noteId || !['persist', 'draft'].includes(props.mode)) {
    loadingImages.value = false
    return
  }
  loadingImages.value = true
  const previousIds = new Set(images.value.map((image) => image.id))
  try {
    const records = await window.api.listImages(props.noteId)

    // 列表只加载缩略图；原图在用户点击预览时按需读取。
    const items = await Promise.all(
      records.map(async (rec) => {
        const thumbnail = await window.api.getImageThumbnailDetails(rec.file_path, 512)
        return {
          id: rec.id,
          name: rec.file_path.split(/[\\/]/).pop(),
          size: rec.file_size,
          filePath: rec.file_path,
          dataUrl: thumbnail?.data || '',
          _naturalWidth: Number(thumbnail?.width) || null,
          _naturalHeight: Number(thumbnail?.height) || null,
          _thumbnailAspect:
            Number(thumbnail?.width) > 0 && Number(thumbnail?.height) > 0
              ? Number(thumbnail.width) / Number(thumbnail.height)
              : null,
          saved: true
        }
      })
    )
    if (seq !== imageLoadSeq) return
    // A save broadcast may refresh this same note before a multi-file upload
    // finishes. Keep its reserved slots; note changes never inherit those slots.
    const pending = images.value.filter(
      (image) =>
        image._loading &&
        image._noteId === props.noteId &&
        image._mode === props.mode &&
        image._mutationSequence === imageMutationSeq
    )
    const loadedIds = new Set(items.map((image) => image.id))
    const newlySaved = images.value.filter(
      (image) => image.saved && !previousIds.has(image.id) && !loadedIds.has(image.id)
    )
    const staged = images.value.filter((image) => image.assetId)
    images.value = [
      ...items.filter((image) => !deletedImageIds.value.includes(image.id)),
      ...newlySaved,
      ...staged,
      ...pending
    ]
    carouselIndex.value = 0
    await nextTick()
    observeCarouselSize()
  } catch (e) {
    console.error('[ImagePicker] 加载图片失败:', e)
  } finally {
    if (seq === imageLoadSeq) loadingImages.value = false
  }
  if (seq !== imageLoadSeq) return
  emitCount()
}

async function savedImageItem(record, { name, size, key } = {}) {
  let thumbnail = null
  try {
    thumbnail = await window.api.getImageThumbnailDetails(record.file_path, 512)
  } catch (error) {
    console.warn('[ImagePicker] 图片已保存，缩略图暂时无法读取:', error)
  }
  return {
    id: record.id,
    ...(key ? { _key: key } : {}),
    name:
      name ||
      String(record.file_path || '')
        .split(/[\\/]/)
        .pop(),
    size: record.file_size || size,
    filePath: record.file_path,
    dataUrl: thumbnail?.data || '',
    _naturalWidth: Number(thumbnail?.width) || null,
    _naturalHeight: Number(thumbnail?.height) || null,
    saved: true
  }
}

function currentImageMutation(sequence, noteId, mode, port) {
  return (
    !disposed &&
    sequence === imageMutationSeq &&
    props.noteId === noteId &&
    props.mode === mode &&
    props.assetPort === port
  )
}

function beginMutation() {
  const token = Symbol('image-mutation')
  mutationTokens.add(token)
  pendingMutations.value = mutationTokens.size
  return () => {
    mutationTokens.delete(token)
    pendingMutations.value = mutationTokens.size
  }
}

function assetMetadata(image) {
  if (
    typeof image?.assetId !== 'string' ||
    !image.assetId ||
    typeof image.ext !== 'string' ||
    typeof image.name !== 'string' ||
    !Number.isSafeInteger(image.size) ||
    image.size < 1 ||
    !/^[a-f0-9]{64}$/i.test(image.sha256 || '')
  )
    throw new Error('草稿图片信息无效，请保留原草稿后重试')
  return {
    assetId: image.assetId,
    ext: image.ext,
    name: image.name,
    size: image.size,
    sha256: image.sha256
  }
}

function requireAssetPort(port) {
  if (
    !port?.stageImage ||
    !port?.previewAsset ||
    !port?.thumbnailAsset ||
    !port?.releaseAssets ||
    !port?.flush
  )
    throw new Error('草稿图片暂存尚未就绪，请稍后重试')
  return port
}

function releaseLocalImages() {
  assetOrigins.clear()
}

function thumbnailMetadata(value) {
  if (!value) return null
  return {
    dataUrl: value.data,
    _naturalWidth: value.width,
    _naturalHeight: value.height,
    _thumbnailAspect: value.width / value.height
  }
}

function imageBlob({ bytes, ext }) {
  const subtype = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext
  return new Blob([bytes], { type: 'image/' + subtype })
}

async function stageDraftImage(dataUrl, ext, name, size, tempId, current, port, onStaged) {
  let staged
  let thumbnail
  let compensating = false
  try {
    requireAssetPort(port)
    const base64 = dataUrl.split(',')[1]
    staged = assetMetadata(await port.stageImage({ base64, ext, name, size }))
    if (!current() || !images.value.some((image) => image.id === tempId)) {
      compensating = true
      await port.releaseAssets([staged.assetId])
      return false
    }
    try {
      thumbnail = thumbnailMetadata(await port.thumbnailAsset(staged.assetId, 512))
    } catch (error) {
      if (current()) console.warn('[ImagePicker] 图片已暂存，缩略图暂时无法读取:', error)
    }
    const index = images.value.findIndex((image) => image.id === tempId)
    if (!current() || index < 0) {
      compensating = true
      await port.releaseAssets([staged.assetId])
      return false
    }
    onStaged?.(staged)
    if (!current() || images.value[index]?.id !== tempId) {
      compensating = true
      await port.releaseAssets([staged.assetId])
      return false
    }
    assetOrigins.set(staged.assetId, port)
    images.value[index] = {
      ...staged,
      ...thumbnail,
      _key: tempId,
      dataUrl: thumbnail?.dataUrl || '',
      saved: false
    }
    emitCount()
    emitDraftChange()
    return true
  } catch (error) {
    if (staged && !compensating && !assetOrigins.has(staged.assetId)) {
      try {
        await port.releaseAssets([staged.assetId])
      } catch (cleanupError) {
        console.warn('[ImagePicker] 迟到草稿图片清理失败:', cleanupError)
      }
    }
    if (current()) {
      const index = images.value.findIndex((image) => image.id === tempId)
      if (index >= 0) images.value.splice(index, 1)
      console.error('[ImagePicker] 草稿图片暂存失败:', error)
      showMessage('warning', error.message || '图片暂存失败，请重试')
      emitCount()
    }
    return false
  }
}

function collapsedHeightPixels() {
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 1
  return props.collapsedHeight * rem
}

function renderedImageHeight(image, availableWidth) {
  const width = Number(image?._naturalWidth)
  const height = Number(image?._naturalHeight)
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return 0
  const renderedWidth = Math.min(width, Math.max(0, availableWidth))
  return renderedWidth * (height / width)
}

function measureCarouselLayout() {
  if (!props.carousel || !carouselRef.value) return
  const availableWidth = carouselRef.value.clientWidth
  const limit = collapsedHeightPixels()
  carouselNaturalHeight.value = renderedImageHeight(carouselActiveImage.value, availableWidth)
  emit(
    'overflow-change',
    images.value.some((image) => renderedImageHeight(image, availableWidth) > limit + 1)
  )
}

function observeCarouselSize() {
  carouselResizeObserver?.disconnect()
  if (!props.carousel || !carouselRef.value) return
  carouselResizeObserver = new ResizeObserver(measureCarouselLayout)
  carouselResizeObserver.observe(carouselRef.value)
  measureCarouselLayout()
}

// ============================================================
// 文件处理（拖拽 / 选择共用）
// ============================================================
async function processFiles(files) {
  if (disposed || !canAdd.value) return
  const sequence = imageMutationSeq
  const noteId = props.noteId
  const mode = props.mode
  const port = props.assetPort
  const current = () => currentImageMutation(sequence, noteId, mode, port)
  const available = MAX_ATTACHMENTS_PER_NOTE - images.value.length
  if (available <= 0) return

  // 预筛选有效文件
  const valid = []
  let totalBytes = props.mode === 'persist' ? 0 : pendingAddedBytes.value
  let oversizedCount = 0
  let aggregateRejected = false
  for (const file of Array.from(files).slice(0, available)) {
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!IMAGE_EXTS.includes(ext)) continue
    if (file.size > MAX_IMAGE_BYTES) {
      console.warn(`[ImagePicker] 图片过大，跳过:`, file.name)
      oversizedCount += 1
      continue
    }
    if (totalBytes + file.size > MAX_ATTACHMENT_BATCH_BYTES) {
      aggregateRejected = true
      continue
    }
    valid.push(file)
    totalBytes += file.size
  }
  if (oversizedCount > 0) showMessage('warning', '单张图片不能超过 50MB')
  if (aggregateRejected) showMessage('warning', '单批新增图片总量不能超过 200MB')
  if (valid.length === 0) return

  // 立即插入占位（带 spinner）
  const placeholders = []
  for (const file of valid) {
    const tempId = '_loading_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
    placeholders.push(tempId)
    images.value.push({
      id: tempId,
      name: file.name,
      size: file.size,
      _loading: true,
      _noteId: noteId,
      _mode: mode,
      _mutationSequence: sequence
    })
  }
  emitCount()

  const finishMutation = beginMutation()
  try {
    // 逐个处理
    for (let i = 0; i < valid.length; i++) {
      if (!current()) break
      const file = valid[i]
      const tempId = placeholders[i]
      const ext = file.name.split('.').pop()?.toLowerCase()

      let dataUrl
      try {
        dataUrl = await readFileAsDataURL(file)
      } catch (error) {
        if (!current()) break
        // 读取失败，移除占位
        console.error(
          `[ImagePicker] 读取图片失败 (name=${file.name}, size=${file.size}, type=${file.type}):`,
          error
        )
        const idx = images.value.findIndex((img) => img.id === tempId)
        if (idx !== -1) images.value.splice(idx, 1)
        continue
      }

      if (!current()) break
      const idx = images.value.findIndex((img) => img.id === tempId)
      if (idx === -1) continue

      if (mode === 'persist' && noteId) {
        try {
          const base64 = dataUrl.split(',')[1]
          const results = await window.api.saveImages(noteId, [{ base64, ext }])
          if (!current()) break
          if (results && results.length > 0) {
            const item = await savedImageItem(results[0], {
              key: tempId,
              name: file.name,
              size: file.size
            })
            if (!current()) break
            const currentIndex = images.value.findIndex((img) => img.id === tempId)
            if (currentIndex !== -1) {
              if (images.value.some((image) => image.id === item.id))
                images.value.splice(currentIndex, 1)
              else images.value[currentIndex] = item
            }
          }
        } catch (e) {
          if (!current()) break
          console.error('[ImagePicker] 保存失败:', e)
          const currentIndex = images.value.findIndex((img) => img.id === tempId)
          if (currentIndex !== -1) images.value.splice(currentIndex, 1)
        }
      } else {
        await stageDraftImage(dataUrl, ext, file.name, file.size, tempId, current, port)
      }
    }

    if (current()) {
      emitCount()
      emitDraftChange()
    }
  } finally {
    finishMutation()
  }
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
  if (disposed || props.readonly) return
  index = images.value.indexOf(img)
  if (index < 0) return
  closePreview()
  if (img._loading) {
    images.value.splice(index, 1)
    emitCount()
    return
  }
  if (img.assetId) {
    const port = assetOrigins.get(img.assetId) || props.assetPort
    const sequence = imageMutationSeq
    const noteId = props.noteId
    const mode = props.mode
    const current = () => currentImageMutation(sequence, noteId, mode, port)
    const finishMutation = beginMutation()
    images.value.splice(index, 1)
    emitCount()
    emitDraftChange()
    let persisted = false
    try {
      const result = await requireAssetPort(port).flush()
      if (!current()) return
      if (!result?.persisted) throw new Error('草稿暂存失败，图片尚未删除，请重试')
      persisted = true
      await port.releaseAssets([img.assetId])
      assetOrigins.delete(img.assetId)
    } catch (error) {
      if (current() && !persisted) {
        images.value.splice(Math.min(index, images.value.length), 0, img)
        emitCount()
        emitDraftChange()
      }
      if (persisted) {
        assetOrigins.delete(img.assetId)
      }
      console.error('[ImagePicker] 草稿图片删除失败:', error)
      if (current()) showMessage('warning', error.message || '图片删除失败，请重试')
    } finally {
      finishMutation()
    }
    return
  }
  if (img.saved && img.id) {
    if (props.mode === 'draft') {
      if (!deletedImageIds.value.includes(img.id)) deletedImageIds.value.push(img.id)
    } else {
      // persist 模式：已保存的图片立即删 DB + 磁盘。
      const sequence = imageMutationSeq
      const noteId = props.noteId
      const mode = props.mode
      const port = props.assetPort
      try {
        await window.api.deleteImage(img.id)
        if (!currentImageMutation(sequence, noteId, mode, port)) return
      } catch (e) {
        console.error('[ImagePicker] 删除图片失败:', e)
        showMessage('warning', e.message || '图片删除失败，请重试')
        return
      }
    }
  }
  images.value.splice(index, 1)
  emitCount()
  emitDraftChange()
}

/** Originals are leased by ImagePreview until its actual image nodes leave. */
async function resolvePreviewSource(index) {
  const session = previewSession
  const img = images.value[index]
  const current = () => !disposed && session === previewSession && images.value[index] === img
  return resolveOriginalSource(img, current)
}

async function resolveOriginalSource(img, current) {
  if (!img || img._loading || !current()) throw new Error('图片预览已失效')
  try {
    const value = img.assetId
      ? await requireAssetPort(assetOrigins.get(img.assetId) || props.assetPort).previewAsset(
          img.assetId
        )
      : img.saved && img.filePath
        ? await window.api.getImageBase64(img.filePath)
        : img.dataUrl
    if (!current() || !value) throw new Error('图片预览已失效')
    if (!img.assetId) return { src: value, release() {} }
    const src = URL.createObjectURL(imageBlob(value))
    let released = false
    return {
      src,
      release() {
        if (!released) {
          released = true
          URL.revokeObjectURL(src)
        }
      }
    }
  } catch (error) {
    if (current()) {
      console.error('[ImagePicker] 读取预览图片失败:', error)
      showMessage('warning', '图片暂时无法读取，请重试')
    }
    throw error
  }
}

function openCopyMenu(event, image) {
  event.preventDefault()
  event.stopPropagation()
  if (disposed || image._loading || event.currentTarget.getAttribute('src') !== image.dataUrl)
    return
  copyTarget = image
  void copyMenu.value?.open(event)
}

async function copySelectedImage() {
  const image = copyTarget
  copyTarget = null
  const sequence = imageMutationSeq
  const current = () => !disposed && sequence === imageMutationSeq && images.value.includes(image)
  try {
    const result = await copyImageToClipboard({
      acquire: () => resolveOriginalSource(image, current),
      isCurrent: current
    })
    if (result === 'copied' && !disposed) showMessage('success', '图片已复制')
  } catch (error) {
    if (current()) showMessage('warning', error.message || '图片复制失败，请重试')
  }
}

function handlePreview(img) {
  if (disposed || img._loading) return false
  const index = images.value.indexOf(img)
  if (index < 0) return false
  previewSession++
  previewIndex.value = index
  previewSources.value = images.value.map((image) => image.dataUrl || '')
  previewVisible.value = true
  return true
}

function onPreviewChange(index) {
  previewIndex.value = index
}

function closePreview() {
  copyMenu.value?.close()
  copyTarget = null
  previewSession++
  previewVisible.value = false
  previewSources.value = []
}

function changeCarouselImage(index, direction) {
  if (images.value.length <= 1) return
  carouselDirection.value = direction
  carouselIndex.value = (index + images.value.length) % images.value.length
  nextTick(measureCarouselLayout)
}

function showPreviousCarouselImage() {
  changeCarouselImage(carouselIndex.value - 1, 'previous')
}

function showNextCarouselImage() {
  changeCarouselImage(carouselIndex.value + 1, 'next')
}

function updateThumbnailAspect(image, event) {
  const width = Number(event?.target?.naturalWidth)
  const height = Number(event?.target?.naturalHeight)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
  image._thumbnailAspect = width / height
  if (!image._naturalWidth || !image._naturalHeight) {
    image._naturalWidth = width
    image._naturalHeight = height
  }
  nextTick(measureCarouselLayout)
}

function thumbnailStyle(image) {
  const aspect = Number(image?._thumbnailAspect)
  if (!Number.isFinite(aspect) || aspect <= 0) return null
  const widthFactor = Math.min(1, aspect)
  return {
    '--ip-thumb-aspect': String(aspect),
    '--ip-thumb-width': `${widthFactor * 100}%`,
    '--ip-thumb-readonly-width': `${widthFactor * props.readonlyMaxSize}rem`
  }
}

function freezeLeavingThumbnail(element) {
  // The group uses display:contents. Absolute positioning would otherwise resolve
  // percentage widths against the whole picker, not the thumbnail's grid cell.
  const { offsetLeft, offsetTop, offsetWidth, offsetHeight } = element
  Object.assign(element.style, {
    left: `${offsetLeft}px`,
    top: `${offsetTop}px`,
    width: `${offsetWidth}px`,
    height: `${offsetHeight}px`
  })
}

function releaseLeavingThumbnail(element) {
  for (const property of ['left', 'top', 'width', 'height']) element.style.removeProperty(property)
}

function emitCount() {
  emit('count-change', images.value.length)
}

function getDraftChanges() {
  return {
    addedImages: getImages(),
    deletedImageIds: [...deletedImageIds.value]
  }
}

function emitDraftChange() {
  if (props.mode !== 'draft') return
  const changes = getDraftChanges()
  emit('draft-change', {
    ...changes,
    dirty: changes.addedImages.length > 0 || changes.deletedImageIds.length > 0
  })
}

// ============================================================
// memory 模式暴露给父组件
// ============================================================
function getImages() {
  return images.value.filter((img) => !img._loading && !img.saved).map(assetMetadata)
}

function clearImages() {
  closePreview()
  imageLoadSeq++
  imageMutationSeq++
  mutationTokens.clear()
  pendingMutations.value = 0
  loadingImages.value = false
  restoringImages.value = false
  releaseLocalImages()
  images.value = []
  deletedImageIds.value = []
  emitCount()
  emitDraftChange()
}

/** 程序化添加图片（供 ScreenshotPicker 等外部调用） */
async function addImage(dataUrl, ext, name, size, { onStaged, deliveryOperation } = {}) {
  if (disposed || !canAdd.value) return false
  const sequence = imageMutationSeq
  const noteId = props.noteId
  const mode = props.mode
  const port = props.assetPort
  const currentTarget = () => currentImageMutation(sequence, noteId, mode, port)
  const current = () => currentTarget() && (deliveryOperation?.isCurrent() ?? true)
  if (!current()) return false
  const base64 = dataUrl.split(',')[1]
  const resolvedSize = Number(size) > 0 ? Number(size) : getBase64DecodedSize(base64)
  if (resolvedSize > MAX_IMAGE_BYTES) {
    showMessage('warning', '单张图片不能超过 50MB')
    return
  }
  const currentBatchBytes = props.mode === 'persist' ? 0 : pendingAddedBytes.value
  if (currentBatchBytes + resolvedSize > MAX_ATTACHMENT_BATCH_BYTES) {
    showMessage('warning', '单批新增图片总量不能超过 200MB')
    return
  }
  if (mode === 'persist' && noteId) {
    return window.api
      .saveImages(noteId, [{ base64, ext }])
      .then(async (results) => {
        if (results && results.length > 0) {
          if (!current()) return true // The durable save still succeeded for its original note.
          try {
            const item = await savedImageItem(results[0], { name, size: resolvedSize })
            if (current()) {
              const existingIndex = images.value.findIndex((image) => image.id === item.id)
              if (existingIndex === -1) images.value.push(item)
              else images.value[existingIndex] = item
              emitCount()
            }
          } catch (error) {
            console.warn('[ImagePicker] 图片已保存，界面暂时无法更新:', error)
          }
          return true
        }
      })
      .catch((e) => {
        console.error('[ImagePicker] 截图保存失败:', e)
        return false
      })
  } else {
    const tempId = `memory-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    images.value.push({
      id: tempId,
      name,
      size: resolvedSize,
      _loading: true,
      _noteId: noteId,
      _mode: mode,
      _mutationSequence: sequence
    })
    emitCount()
    const finishMutation = beginMutation()
    try {
      return await stageDraftImage(
        dataUrl,
        ext,
        name,
        resolvedSize,
        tempId,
        current,
        port,
        onStaged
      )
    } finally {
      // Delivery cancellation does not invalidate the whole form. Remove only
      // this request's unpublished placeholder; never clear another image or
      // delete a staged image already published to its journal owner.
      if (currentTarget()) {
        const index = images.value.findIndex((image) => image.id === tempId && image._loading)
        if (index >= 0) {
          images.value.splice(index, 1)
          emitCount()
        }
      }
      finishMutation()
    }
  }
}

async function restoreDraft(draft) {
  if (!draft) return
  const sequence = ++imageMutationSeq
  const noteId = props.noteId
  const mode = props.mode
  const port = props.assetPort
  const current = () => currentImageMutation(sequence, noteId, mode, port)
  restoringImages.value = true
  images.value = images.value.filter((image) => !image._loading)
  const restored = []
  try {
    const metadata = (draft.addedImages || []).map(assetMetadata)
    await loadImages()
    if (!current()) return false
    for (const image of metadata) {
      const thumbnail = thumbnailMetadata(
        await requireAssetPort(port).thumbnailAsset(image.assetId, 512)
      )
      if (!current()) {
        return false
      }
      restored.push({
        ...image,
        ...thumbnail,
        dataUrl: thumbnail?.dataUrl || '',
        _key: image.assetId,
        saved: false
      })
    }
    if (!current()) return false
    deletedImageIds.value = [...(draft.deletedImageIds || [])]
    const saved = images.value.filter(
      (image) => image.saved && !deletedImageIds.value.includes(image.id)
    )
    assetOrigins.clear()
    for (const image of restored) assetOrigins.set(image.assetId, port)
    images.value = [...saved, ...restored]
    emitCount()
    emitDraftChange()
    return true
  } finally {
    if (current()) restoringImages.value = false
  }
}

defineExpose({ restoreDraft, getImages, getDraftChanges, clearImages, addImage, images })

// ============================================================
// noteId 变化时重新加载
// ============================================================
watch(
  () => [props.noteId, props.mode, props.assetPort, props.refreshKey],
  ([noteId, mode, port], [previousNoteId, previousMode, previousPort]) => {
    if (noteId !== previousNoteId || mode !== previousMode || port !== previousPort) clearImages()
    void loadImages()
  },
  { flush: 'sync' }
)
watch(
  () => unref(props.assetPort?.imageGeneration),
  () => closePreview(),
  { flush: 'sync' }
)
onMounted(loadImages)
onUnmounted(() => {
  disposed = true
  closePreview()
  imageLoadSeq++
  imageMutationSeq++
  mutationTokens.clear()
  pendingMutations.value = 0
  releaseLocalImages()
  carouselResizeObserver?.disconnect()
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
    <!-- 外部入口也参与同一个流式布局（例如截图按钮） -->
    <slot name="leading" />

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
      <span class="ip-dropzone__text ip-dropzone__text--full">{{
        loadingImages ? '加载中…' : '已满'
      }}</span>
    </div>

    <div
      v-if="readonly && carousel && carouselActiveImage"
      ref="carouselRef"
      class="ip-carousel"
      :class="{ 'is-multiple': images.length > 1 }"
      :style="carouselViewportStyle"
    >
      <Transition :name="carouselTransitionName">
        <div :key="carouselIndex" class="ip-carousel__stage" :style="carouselStageStyle">
          <img
            :src="carouselActiveImage.dataUrl"
            class="ip-carousel__image"
            :alt="carouselActiveImage.name"
            tabindex="0"
            aria-haspopup="menu"
            @load="updateThumbnailAspect(carouselActiveImage, $event)"
            @click.stop="handlePreview(carouselActiveImage)"
            @contextmenu="openCopyMenu($event, carouselActiveImage)"
          />
          <span class="ip-thumb__size">{{ formatSize(carouselActiveImage.size) }}</span>
        </div>
      </Transition>
      <template v-if="images.length > 1">
        <button
          type="button"
          class="ip-carousel__nav ip-carousel__nav--previous"
          title="上一张"
          aria-label="上一张卡片图片"
          @click.stop="showPreviousCarouselImage"
        >
          ‹
        </button>
        <button
          type="button"
          class="ip-carousel__nav ip-carousel__nav--next"
          title="下一张"
          aria-label="下一张卡片图片"
          @click.stop="showNextCarouselImage"
        >
          ›
        </button>
        <span class="ip-carousel__count">{{ carouselIndex + 1 }} / {{ images.length }}</span>
      </template>
    </div>

    <!-- 缩略图列表：新增、删除与补位保持连续 -->
    <TransitionGroup
      v-else
      name="ip-thumb"
      tag="div"
      class="ip-thumb-list"
      @before-leave="freezeLeavingThumbnail"
      @after-leave="releaseLeavingThumbnail"
      @leave-cancelled="releaseLeavingThumbnail"
    >
      <div
        v-for="(img, idx) in images"
        :key="img._key || img.id || `memory-${idx}`"
        class="ip-thumb"
        :style="thumbnailStyle(img)"
      >
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
            tabindex="0"
            aria-haspopup="menu"
            @load="updateThumbnailAspect(img, $event)"
            @click.stop="handlePreview(img)"
            @contextmenu="openCopyMenu($event, img)"
          />
        </Transition>
        <button
          v-if="!readonly"
          class="ip-thumb__del"
          title="删除"
          @click.stop="handleDelete(img, idx)"
        >
          ×
        </button>
        <span v-if="!img._loading" class="ip-thumb__size">{{ formatSize(img.size) }}</span>
      </div>
    </TransitionGroup>

    <ImageCopyMenu ref="copyMenu" :disabled="imageClipboardBusy" @copy="copySelectedImage" />

    <!-- 大图预览 -->
    <ImagePreview
      :visible="previewVisible"
      :sources="previewSources"
      :initial-index="previewIndex"
      :resolve-source="resolvePreviewSource"
      @change="onPreviewChange"
      @close="closePreview"
    />
  </div>
</template>

<style scoped>
.ip-root {
  position: relative;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8rem;
  align-items: flex-start;
}

.ip-root--readonly {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
}

.ip-root--readonly .ip-thumb {
  width: var(--ip-thumb-readonly-width, 92rem);
}

.ip-carousel {
  position: relative;
  display: grid;
  width: 100%;
  place-items: start;
  overflow: hidden;
  transition: height 240ms var(--ease-standard);
}
.ip-carousel__stage {
  position: relative;
  display: grid;
  grid-area: 1 / 1;
  width: min(100%, var(--ip-carousel-image-width));
  aspect-ratio: var(--ip-carousel-image-aspect);
  place-items: start;
}
.ip-carousel__image {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 8rem;
  object-fit: contain;
  cursor: zoom-in;
}
.ip-carousel__stage:hover .ip-thumb__size {
  opacity: 1;
}
.ip-carousel__nav {
  position: absolute;
  z-index: var(--z-local-raised);
  top: 50%;
  display: grid;
  width: 28rem;
  height: 38rem;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 8rem;
  background: rgba(0, 0, 0, 0.38);
  color: #fff;
  cursor: pointer;
  font-size: 24rem;
  line-height: 1;
  opacity: 0;
  pointer-events: none;
  transform: translateY(-50%);
  transition:
    opacity 140ms ease,
    background-color 140ms ease;
}
.ip-carousel:hover .ip-carousel__nav,
.ip-carousel:focus-within .ip-carousel__nav {
  opacity: 1;
  pointer-events: auto;
}
.ip-carousel__nav:hover {
  background: rgba(0, 0, 0, 0.58);
}
.ip-carousel__nav:active {
  transform: translateY(-50%) scale(0.98);
}
.ip-carousel__nav--previous {
  left: 6rem;
}
.ip-carousel__nav--next {
  right: 6rem;
}
.ip-carousel__count {
  position: absolute;
  z-index: var(--z-local-raised);
  right: 7rem;
  bottom: 6rem;
  padding: 3rem 6rem;
  border-radius: 980px;
  background: rgba(0, 0, 0, 0.52);
  color: #fff;
  font-size: calc(var(--fs-secondary) * 0.76);
  line-height: 1;
  pointer-events: none;
}
.ip-carousel-next-enter-active,
.ip-carousel-next-leave-active,
.ip-carousel-previous-enter-active,
.ip-carousel-previous-leave-active {
  transition:
    opacity 180ms ease,
    transform 220ms var(--ease-standard);
}
.ip-carousel-next-enter-from {
  opacity: 0;
  transform: translateX(18rem);
}
.ip-carousel-next-leave-to {
  opacity: 0;
  transform: translateX(-18rem);
}
.ip-carousel-previous-enter-from {
  opacity: 0;
  transform: translateX(-18rem);
}
.ip-carousel-previous-leave-to {
  opacity: 0;
  transform: translateX(18rem);
}

/* 拖拽区域 — 正方形 */
.ip-dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4rem;
  width: 100%;
  min-width: 0;
  aspect-ratio: 1;
  border: 1px dashed var(--ui-border-control);
  border-radius: 6rem;
  cursor: pointer;
  transition:
    border-color 150ms ease,
    background-color 150ms ease;
  flex-shrink: 0;
  background: transparent;
}
.ip-dropzone:hover {
  border-color: var(--ui-border-hover);
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

/* 缩略图按原始宽高比放进同一最大边长，横图限宽、竖图限高。 */
.ip-thumb {
  position: relative;
  display: block;
  width: var(--ip-thumb-width, 100%);
  min-width: 0;
  aspect-ratio: var(--ip-thumb-aspect, 1);
  justify-self: center;
  align-self: center;
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
  pointer-events: none;
  /* TransitionGroup also measures leaving cells after the centered form shrinks.
     Keep that FLIP translation off the removed image; only fade it in place. */
  transform: none !important;
  transition: opacity var(--motion-control) ease;
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
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 8rem;
  object-fit: contain;
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

.ip-thumb__size {
  position: absolute;
  z-index: var(--z-local-content);
  top: 50%;
  left: 50%;
  padding: 4rem 7rem;
  border-radius: 6rem;
  background: rgba(0, 0, 0, 0.58);
  color: #fff;
  font-size: calc(var(--fs-secondary) * 0.76);
  line-height: 1;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, -50%);
  transition: opacity 140ms ease;
}
.ip-thumb:hover .ip-thumb__size {
  opacity: 1;
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
  border: 3rem solid color-mix(in srgb, var(--text-color) 15%, transparent);
  border-top-color: #0071e3;
  border-radius: 50%;
  animation: ip-spin 0.8s linear infinite;
}
@keyframes ip-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
