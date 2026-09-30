<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import AppModalShell from '../ui/AppModalShell.vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import NewNotePanel from '../list/NewNotePanel.vue'
import WallpaperCropEditor from '../wallpaper/WallpaperCropEditor.vue'
import { identifiers } from '../../composables/useScreenCapture.js'
import { useMessage } from '../../composables/useMessage.js'
import { useModalRequest, useQueuedModal } from '../../composables/useQueuedModal.js'
import { editingDataGeneration, useDraftProtection } from '../../composables/useDraftProtection.js'

const emit = defineEmits(['created'])
const { showMessage } = useMessage()
const noteQueue = useModalRequest()
const noteVisible = noteQueue.requested,
  noteRef = ref(null),
  discardVisible = ref(false)
const background = ref('')
const { visible: backgroundDisplayed, finishLeave: finishBackgroundLeave } =
  useQueuedModal(background)
watch(background, (value) => {
  if (!value) finishBackgroundLeave()
})
const pendingAsset = ref(null)
const importing = ref(false)
const importError = ref('')
const pendingDraft = useDraftProtection({
  key: 'capture:pending-delivery',
  fields: { pendingAsset },
  dirty: () => Boolean(pendingAsset.value),
  busy: () => importing.value,
  restoreExtra: () => {
    if (pendingAsset.value?.action === 'note') noteVisible.value = true
    else if (pendingAsset.value?.action === 'background')
      background.value = pendingAsset.value.dataUrl
  }
})
let receiving = false,
  disposed = false
let importedAsset = null
const stop = window.api.onScreenshotDelivery(async (asset) => {
  if (!['note', 'background'].includes(asset.action)) return
  let accepted = false,
    message = ''
  let ownsReceipt = false
  try {
    if (receiving || noteVisible.value || background.value)
      throw new Error('已有截图草稿或背景裁剪正在编辑，请先完成')
    receiving = true
    ownsReceipt = true
    const draft = window.__prepareEditingDrafts?.()
    if (draft?.blocked) throw new Error('当前草稿正在处理附件，请稍后重试')
    if (draft?.dirty && !(await window.__confirmEditingDrafts?.('切换视图')))
      throw new Error('已保留当前编辑，可继续复制、保存或贴图')
    if (disposed) throw new Error('接收页面已关闭')
    // Take durable ownership before acknowledging. The native capture session
    // can finish now; it must not wait for the user to close an unrelated modal.
    pendingDraft.resume()
    pendingAsset.value = asset
    if (pendingDraft.flush().blocked) {
      pendingAsset.value = null
      pendingDraft.clear()
      throw new Error('截图草稿暂存失败，请保存图片后重试')
    }
    if (asset.action === 'background') background.value = asset.dataUrl
    else noteVisible.value = true
    accepted = true
  } catch (error) {
    message = error.message
  } finally {
    if (ownsReceipt) receiving = false
    await window.api.acknowledgeScreenshot({ ...identifiers(asset), accepted, message })
  }
})
async function importPendingCapture() {
  const asset = pendingAsset.value
  if (!asset || asset.action !== 'note' || importing.value) return
  importing.value = true
  importError.value = ''
  try {
    await nextTick()
    if (disposed || !noteVisible.value) return
    if (importedAsset !== asset) {
      if (!(await noteRef.value?.addCapture(asset))) throw new Error('图片未能加入便签，请重试')
      importedAsset = asset
    }
    // Drop the duplicate staged copy before persisting the mounted form. If
    // storage fails, keep the original asset and retry without adding it twice.
    pendingDraft.clear()
    if (noteRef.value?.draftState()?.blocked) {
      pendingDraft.resume()
      pendingDraft.flush()
      throw new Error('图片已加载，但草稿暂存失败，请重试或保存便签')
    }
    pendingAsset.value = null
    importedAsset = null
  } catch (error) {
    importError.value = error.message
  } finally {
    importing.value = false
  }
}
function clearPending() {
  importedAsset = null
  pendingAsset.value = null
  pendingDraft.clear()
  importError.value = ''
}
function requestClose() {
  if (importing.value) return
  const state = noteRef.value?.draftState()
  if (state?.blocked) {
    showMessage('warning', '请等待附件处理完成')
    return
  }
  if (state?.dirty || pendingAsset.value) discardVisible.value = true
  else noteVisible.value = false
}
function discard() {
  clearPending()
  noteRef.value?.discard()
  noteVisible.value = false
}
function created() {
  clearPending()
  noteVisible.value = false
  emit('created')
}
async function backgroundSaved(record) {
  clearPending()
  background.value = ''
  try {
    await window.api.activateWallpaper(record.id)
    showMessage('success', '主页面壁纸已应用')
  } catch (error) {
    showMessage('error', `壁纸已保存，但应用失败：${error.message}`)
  }
}
function cancelBackground() {
  clearPending()
  background.value = ''
}
watch(editingDataGeneration, () => {
  clearPending()
  noteVisible.value = false
  background.value = ''
})
onBeforeUnmount(() => {
  disposed = true
  stop()
})
</script>

<template>
  <AppModalShell
    :queue="noteQueue"
    :visible="noteVisible"
    title="截图新建便签"
    height="min(680rem, calc(100vh - 40rem))"
    :close-disabled="importing"
    @close="requestClose"
    @opened="importPendingCapture"
  >
    <p v-if="importError" role="alert">
      {{ importError }}
      <button type="button" @click="importPendingCapture">重试加载截图</button>
    </p>
    <NewNotePanel
      v-if="noteVisible"
      ref="noteRef"
      draft-key="new:capture"
      active
      @create="created"
    />
  </AppModalShell>
  <ConfirmDialog
    v-model:visible="discardVisible"
    title="放弃这张便签草稿？"
    message="草稿中的文字和截图尚未保存。"
    confirm-text="放弃草稿"
    @confirm="discard"
  />
  <WallpaperCropEditor
    v-if="backgroundDisplayed"
    :source-data="background"
    @cancel="cancelBackground"
    @saved="backgroundSaved"
  />
</template>
