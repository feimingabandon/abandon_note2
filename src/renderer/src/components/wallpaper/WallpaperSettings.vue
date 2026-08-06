<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import BaseButton from '../ui/BaseButton.vue'
import AppSlider from '../ui/AppSlider.vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import ImagePreview from '../note/ImagePreview.vue'
import WallpaperCropEditor from './WallpaperCropEditor.vue'
import { useMessage } from '../../composables/useMessage.js'

const { showMessage } = useMessage()
const fileInput = ref(null)
const records = ref([])
const thumbnails = ref({})
const activeId = ref(null)
const enabled = ref(false)
const blurRadius = ref(8)
const sourceData = ref('')
const sourceId = ref(null)
const cropClosing = ref(false)
const loading = ref(true)
const capturing = ref(false)
const activatingId = ref(null)
const recroppingId = ref(null)
const deletingId = ref(null)
const disabling = ref(false)
const deleteTarget = ref(null)
const deleteDialogVisible = ref(false)
const previewData = ref('')
const previewVisible = ref(false)
const previewLoadingId = ref(null)
const libraryOpen = ref(false)
let overlayTimer = null
let previewReleaseTimer = null
let cropCloseTimer = null
let previewRequestSequence = 0
let libraryLoadSequence = 0
let pendingBlurRadius = null
let unmounted = false
let stopSettingsListener = null
let libraryPanelAnimation = null

function animateLibraryPanel(el, opening, done) {
  libraryPanelAnimation?.cancel()
  el.style.overflow = 'hidden'
  el.style.willChange = 'height, opacity, transform'
  const fullHeight = `${el.scrollHeight}px`
  const collapsed = { height: '0px', opacity: 0, transform: 'translateY(-4rem)' }
  const expanded = { height: fullHeight, opacity: 1, transform: 'translateY(0)' }
  const animation = el.animate(opening ? [collapsed, expanded] : [expanded, collapsed], {
    duration: opening ? 280 : 240,
    easing: 'cubic-bezier(0.32, 0.72, 0, 1)'
  })
  libraryPanelAnimation = animation

  const finish = () => {
    if (libraryPanelAnimation !== animation) return
    libraryPanelAnimation = null
    el.style.overflow = ''
    el.style.willChange = ''
    done()
  }
  animation.finished.then(finish, finish)
}

function onLibraryPanelEnter(el, done) {
  animateLibraryPanel(el, true, done)
}

function onLibraryPanelLeave(el, done) {
  animateLibraryPanel(el, false, done)
}

function syncWallpaperSettings(snapshot) {
  const wallpaper = snapshot?.values?.wallpaper
  if (!wallpaper) return
  activeId.value = wallpaper.activeId ?? null
  enabled.value = Boolean(wallpaper.enabled)
  blurRadius.value = Number(wallpaper.blurRadius ?? 8)
}

async function loadLibrary() {
  const sequence = ++libraryLoadSequence
  loading.value = true
  try {
    const [items, snapshot] = await Promise.all([
      window.api.listWallpapers(),
      window.api.getSettingsSnapshot()
    ])
    if (unmounted) return
    records.value = items || []
    thumbnails.value = {}
    syncWallpaperSettings(snapshot)
    loading.value = false
    void loadThumbnailsProgressively(records.value, sequence)
  } catch (error) {
    console.error('[WallpaperSettings] 读取壁纸库失败:', error)
    showMessage('error', `读取壁纸记录失败：${error?.message || '未知错误'}`, 4000)
  } finally {
    if (!unmounted) loading.value = false
  }
}

async function loadThumbnailsProgressively(items, sequence) {
  let nextIndex = 0
  const worker = async () => {
    while (!unmounted && sequence === libraryLoadSequence) {
      const item = items[nextIndex++]
      if (!item) return
      let thumbnail = null
      try {
        thumbnail = await window.api.getWallpaperThumbnail(item.id, 260)
      } catch (error) {
        console.warn(`[WallpaperSettings] 读取壁纸 ${item.id} 缩略图失败:`, error)
      }
      if (unmounted || sequence !== libraryLoadSequence) return
      thumbnails.value = { ...thumbnails.value, [item.id]: thumbnail }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, items.length) }, () => worker()))
}

function openImport() {
  fileInput.value?.click()
}

function openCropEditor(data, id = null) {
  clearTimeout(cropCloseTimer)
  cropClosing.value = false
  sourceData.value = data
  sourceId.value = id
}

function closeCropEditor() {
  if (!sourceData.value || cropClosing.value) return
  cropClosing.value = true
  clearTimeout(cropCloseTimer)
  cropCloseTimer = setTimeout(() => {
    sourceData.value = ''
    sourceId.value = null
    cropClosing.value = false
  }, 190)
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}

async function onFilePicked(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  if (file.size > 50 * 1024 * 1024) {
    showMessage('error', '壁纸图片不能超过 50MB')
    return
  }
  try {
    openCropEditor(await readFile(file))
  } catch (error) {
    console.error('[WallpaperSettings] 读取待裁剪图片失败:', error)
    showMessage('error', error?.message || '图片读取失败')
  }
}

async function captureScreen() {
  if (capturing.value) return
  capturing.value = true
  try {
    const data = await window.api.captureScreen()
    if (data) openCropEditor(data)
  } catch (error) {
    console.error('[WallpaperSettings] 截图失败:', error)
    showMessage('error', `截图失败：${error?.message || '未知错误'}`)
  } finally {
    capturing.value = false
  }
}

async function recrop(record) {
  if (recroppingId.value !== null) return
  recroppingId.value = record.id
  try {
    const data = await window.api.getWallpaperData(record.id, true)
    if (!data) {
      showMessage('error', '这张壁纸的原图已丢失，无法重新裁剪')
      return
    }
    openCropEditor(data, record.source_id)
  } catch (error) {
    console.error(`[WallpaperSettings] 读取壁纸 ${record.id} 原图失败:`, error)
    showMessage('error', `读取原图失败：${error?.message || '未知错误'}`)
  } finally {
    recroppingId.value = null
  }
}

async function previewOriginal(record) {
  const sequence = ++previewRequestSequence
  clearTimeout(previewReleaseTimer)
  previewLoadingId.value = record.id
  try {
    const data = await window.api.getWallpaperData(record.id, true)
    if (unmounted || sequence !== previewRequestSequence) return
    if (!data) {
      showMessage('error', '这张壁纸的原图已丢失，无法预览')
      return
    }
    previewData.value = data
    previewVisible.value = true
  } catch (error) {
    console.error(`[WallpaperSettings] 预览壁纸 ${record.id} 原图失败:`, error)
    if (!unmounted && sequence === previewRequestSequence) {
      showMessage('error', `原图预览失败：${error?.message || '未知错误'}`)
    }
  } finally {
    if (!unmounted && sequence === previewRequestSequence) previewLoadingId.value = null
  }
}

function closePreview() {
  previewVisible.value = false
  clearTimeout(previewReleaseTimer)
  previewReleaseTimer = setTimeout(() => {
    previewData.value = ''
  }, 220)
}

async function onCropSaved(record) {
  closeCropEditor()
  try {
    await window.api.activateWallpaper(record.id)
    showMessage('success', '主页面壁纸已应用')
  } catch (error) {
    console.error(`[WallpaperSettings] 应用已保存壁纸 ${record.id} 失败:`, error)
    showMessage('error', `壁纸已保存，但应用失败：${error?.message || '未知错误'}`, 4000)
  } finally {
    await loadLibrary()
  }
}

async function activate(record) {
  if (activatingId.value !== null) return
  activatingId.value = record.id
  try {
    await window.api.activateWallpaper(record.id)
    activeId.value = record.id
    enabled.value = true
    showMessage('success', '已切换主页面壁纸')
    await loadLibrary()
  } catch (error) {
    console.error(`[WallpaperSettings] 激活壁纸 ${record.id} 失败:`, error)
    showMessage('error', `切换壁纸失败：${error?.message || '未知错误'}`)
  } finally {
    activatingId.value = null
  }
}

async function disable() {
  if (disabling.value) return
  disabling.value = true
  try {
    await window.api.disableWallpaper()
    enabled.value = false
    showMessage('success', '主页面壁纸已关闭')
  } catch (error) {
    console.error('[WallpaperSettings] 关闭壁纸失败:', error)
    showMessage('error', `关闭壁纸失败：${error?.message || '未知错误'}`)
  } finally {
    disabling.value = false
  }
}

async function confirmDelete() {
  const record = deleteTarget.value
  deleteTarget.value = null
  if (!record) return
  deletingId.value = record.id
  try {
    const deleted = await window.api.deleteWallpaper(record.id)
    if (!deleted) throw new Error('壁纸版本已不存在')
    showMessage('success', '壁纸版本已删除')
    await loadLibrary()
  } catch (error) {
    console.error(`[WallpaperSettings] 删除壁纸 ${record.id} 失败:`, error)
    showMessage('error', `删除失败：${error?.message || '未知错误'}`)
  } finally {
    deletingId.value = null
  }
}

function requestDelete(record) {
  if (enabled.value && activeId.value === record.id) {
    showMessage('info', '请先切换或关闭当前壁纸')
    return
  }
  deleteTarget.value = record
  deleteDialogVisible.value = true
}

function cancelCrop() {
  closeCropEditor()
}

watch(blurRadius, (value) => {
  if (loading.value) return
  pendingBlurRadius = value
  clearTimeout(overlayTimer)
  overlayTimer = setTimeout(() => {
    const valueToSave = pendingBlurRadius
    pendingBlurRadius = null
    window.api
      .setSettingValue('wallpaper.blurRadius', valueToSave)
      .catch((error) => console.warn('[WallpaperSettings] 保存壁纸模糊失败:', error))
  }, 250)
})

onMounted(() => {
  stopSettingsListener = window.api.onSettingsChanged?.(syncWallpaperSettings)
  loadLibrary()
})
onBeforeUnmount(() => {
  unmounted = true
  clearTimeout(overlayTimer)
  clearTimeout(previewReleaseTimer)
  clearTimeout(cropCloseTimer)
  libraryPanelAnimation?.cancel()
  libraryPanelAnimation = null
  previewRequestSequence += 1
  libraryLoadSequence += 1
  if (pendingBlurRadius !== null) {
    window.api
      .setSettingValue('wallpaper.blurRadius', pendingBlurRadius)
      .catch((error) => console.warn('[WallpaperSettings] 卸载前保存壁纸模糊失败:', error))
    pendingBlurRadius = null
  }
  stopSettingsListener?.()
})
</script>

<template>
  <div class="wp-settings">
    <div class="wp-heading">
      <div>
        <h4>设置主页面壁纸</h4>
        <p>毛玻璃未运行时，可用图片替代透明背景</p>
      </div>
      <Transition name="wp-control">
        <BaseButton v-if="enabled" size="sm" :disabled="disabling" @click="disable">
          {{ disabling ? '正在关闭…' : '关闭壁纸' }}
        </BaseButton>
      </Transition>
    </div>

    <div class="wp-source-actions">
      <button class="wp-source" :disabled="capturing" @click="captureScreen">
        <span class="wp-source-icon">⌗</span>
        <span>{{ capturing ? '正在截图…' : '直接截图' }}</span>
      </button>
      <button class="wp-source" @click="openImport">
        <span class="wp-source-icon">＋</span>
        <span>导入文件</span>
      </button>
      <input
        ref="fileInput"
        class="wp-file"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/bmp"
        @change="onFilePicked"
      />
    </div>

    <div class="wp-blur-control">
      <span>壁纸模糊</span>
      <AppSlider v-model="blurRadius" :min="0" :max="30" :step="1" />
      <span>{{ blurRadius }}px</span>
    </div>

    <button
      class="wp-library-toggle"
      type="button"
      :aria-expanded="libraryOpen"
      aria-controls="wallpaper-library-panel"
      @click="libraryOpen = !libraryOpen"
    >
      <span>旧壁纸</span>
      <span class="wp-library-toggle-meta">
        <span v-if="records.length">{{ records.length }} 个版本</span>
        <svg
          class="wp-library-chevron"
          :class="{ 'is-open': libraryOpen }"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </span>
    </button>
    <Transition :css="false" @enter="onLibraryPanelEnter" @leave="onLibraryPanelLeave">
      <div v-if="libraryOpen" id="wallpaper-library-panel" class="wp-library-collapse">
        <div class="wp-library-content">
          <Transition name="wp-library-state" mode="out-in">
            <div v-if="loading" key="loading" class="wp-empty">正在读取壁纸…</div>
            <div v-else-if="records.length === 0" key="empty" class="wp-empty">
              还没有保存过壁纸
            </div>
            <TransitionGroup v-else key="library" tag="div" name="wp-card" class="wp-library">
              <article
                v-for="record in records"
                :key="record.id"
                class="wp-card"
                :class="{ active: enabled && activeId === record.id }"
              >
                <img v-if="thumbnails[record.id]" :src="thumbnails[record.id]" alt="壁纸缩略图" />
                <div v-else class="wp-thumb-missing">预览不可用</div>
                <Transition name="wp-badge">
                  <span v-if="enabled && activeId === record.id" class="wp-active-badge"
                    >使用中</span
                  >
                </Transition>
                <div class="wp-card-actions">
                  <button
                    :disabled="
                      activatingId !== null ||
                      deletingId !== null ||
                      (enabled && activeId === record.id)
                    "
                    @click="activate(record)"
                  >
                    {{
                      activatingId === record.id
                        ? '切换中'
                        : enabled && activeId === record.id
                          ? '使用中'
                          : '使用'
                    }}
                  </button>
                  <button
                    :disabled="previewLoadingId === record.id"
                    @click="previewOriginal(record)"
                  >
                    {{ previewLoadingId === record.id ? '读取中' : '预览' }}
                  </button>
                  <button :disabled="recroppingId !== null" @click="recrop(record)">
                    {{ recroppingId === record.id ? '读取中' : '重新裁剪' }}
                  </button>
                  <button
                    class="danger"
                    :disabled="deletingId !== null || (enabled && activeId === record.id)"
                    :title="
                      enabled && activeId === record.id ? '请先切换或关闭当前壁纸' : '删除壁纸版本'
                    "
                    @click="requestDelete(record)"
                  >
                    删除
                  </button>
                </div>
              </article>
            </TransitionGroup>
          </Transition>
        </div>
      </div>
    </Transition>

    <WallpaperCropEditor
      v-if="sourceData"
      :source-data="sourceData"
      :source-id="sourceId"
      :closing="cropClosing"
      @cancel="cancelCrop"
      @saved="onCropSaved"
    />
    <ImagePreview :visible="previewVisible" :src="previewData" @close="closePreview" />
    <ConfirmDialog
      v-model:visible="deleteDialogVisible"
      title="删除壁纸版本？"
      message="该裁剪版本会从磁盘删除；如果它是原图的最后一个版本，原图也会一并删除。"
      confirm-text="删除"
      variant="danger"
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />
  </div>
</template>

<style scoped>
.wp-settings {
  margin-top: 6rem;
  padding: 14rem;
  border-radius: 12rem;
  background: color-mix(in srgb, var(--text-color) 4%, transparent);
}
.wp-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12rem;
}
.wp-heading h4 {
  margin: 0;
  color: var(--text-color);
  font-size: var(--fs-body);
  font-weight: 600;
}
.wp-heading p {
  margin: 3rem 0 0;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.wp-control-enter-active,
.wp-control-leave-active {
  transition:
    opacity 160ms ease,
    transform 190ms var(--ease-standard);
}
.wp-control-enter-from,
.wp-control-leave-to {
  opacity: 0;
  transform: translateY(-4rem) scale(0.96);
}
.wp-source-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8rem;
  margin-top: 12rem;
}
.wp-source {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7rem;
  min-height: 54rem;
  border: 1px dashed color-mix(in srgb, var(--text-color) 18%, transparent);
  border-radius: 10rem;
  background: rgba(128, 128, 128, 0.03);
  color: var(--text-color);
  cursor: pointer;
  transition:
    background 140ms ease,
    border-color 140ms ease,
    transform 140ms ease;
}
.wp-source:hover {
  border-color: rgba(0, 113, 227, 0.55);
  background: rgba(128, 128, 128, 0.06);
}
.wp-source:active {
  transform: scale(0.985);
}
.wp-source-icon {
  font-size: 20rem;
  color: #0071e3;
}
.wp-file {
  display: none;
}
.wp-blur-control {
  display: grid;
  grid-template-columns: auto minmax(90rem, 1fr) 42rem;
  align-items: center;
  gap: 10rem;
  margin-top: 10rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.wp-library-toggle {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 10rem;
  margin-top: 10rem;
  padding: 8rem 2rem;
  border: 0;
  border-radius: 8rem;
  background: transparent;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  user-select: none;
  transition:
    color 150ms ease,
    background 150ms ease;
}
.wp-library-toggle:hover {
  background: color-mix(in srgb, var(--text-color) 4%, transparent);
  color: var(--text-color);
}
.wp-library-toggle-meta {
  display: inline-flex;
  align-items: center;
  gap: 6rem;
  flex-shrink: 0;
}
.wp-library-chevron {
  width: 12rem;
  height: 12rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transform: rotate(-90deg);
  transition: transform 200ms var(--ease-standard);
}
.wp-library-chevron.is-open {
  transform: rotate(0);
}
.wp-library-collapse {
  display: flow-root;
}
.wp-library-content {
  padding-top: 1rem;
}
.wp-empty {
  padding: 18rem;
  text-align: center;
  border-radius: 9rem;
  background: color-mix(in srgb, var(--text-color) 3%, transparent);
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.wp-library-state-enter-active,
.wp-library-state-leave-active {
  transition:
    opacity 160ms ease,
    transform 190ms var(--ease-standard);
}
.wp-library-state-enter-from,
.wp-library-state-leave-to {
  opacity: 0;
  transform: translateY(5rem);
}
.wp-library {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180rem, 1fr));
  gap: 9rem;
  max-height: 310rem;
  padding-right: 4rem;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
}
.wp-library::-webkit-scrollbar {
  display: none;
}
.wp-card {
  position: relative;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: 10rem;
  background: color-mix(in srgb, var(--text-color) 4%, transparent);
  transition:
    border-color 160ms ease,
    opacity 180ms ease,
    transform 220ms var(--ease-standard);
}
.wp-card-enter-from,
.wp-card-leave-to {
  opacity: 0;
  transform: translateY(8rem) scale(0.98);
}
.wp-card-move {
  transition: transform 240ms var(--ease-standard);
}
.wp-card.active {
  border-color: #0071e3;
}
.wp-card img,
.wp-thumb-missing {
  display: block;
  width: 100%;
  aspect-ratio: 16/10;
  object-fit: cover;
  background: color-mix(in srgb, var(--text-color) 5%, transparent);
}
.wp-card img {
  animation: wp-thumb-in 180ms ease both;
}
@keyframes wp-thumb-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.wp-thumb-missing {
  display: grid;
  place-items: center;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.wp-active-badge {
  position: absolute;
  top: 7rem;
  right: 7rem;
  padding: 3rem 7rem;
  border-radius: 999px;
  background: #0071e3;
  color: #fff;
  font-size: 11rem;
}
.wp-badge-enter-active,
.wp-badge-leave-active {
  transition:
    opacity 140ms ease,
    transform 180ms var(--ease-standard);
}
.wp-badge-enter-from,
.wp-badge-leave-to {
  opacity: 0;
  transform: translateY(-3rem) scale(0.9);
}
.wp-card-actions {
  display: flex;
  gap: 1rem;
  padding: 6rem;
}
.wp-card-actions button {
  flex: 1;
  min-width: 0;
  padding: 5rem 2rem;
  border: 0;
  border-radius: 6rem;
  background: transparent;
  color: var(--text-color-secondary);
  font-size: 10rem;
  white-space: nowrap;
  cursor: pointer;
}
.wp-card-actions button:hover {
  background: color-mix(in srgb, var(--text-color) 7%, transparent);
  color: var(--text-color);
}
.wp-card-actions button:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}
.wp-card-actions button:disabled:hover {
  background: transparent;
  color: var(--text-color-secondary);
}
.wp-card-actions .danger:hover {
  color: #ff453a;
}
</style>
