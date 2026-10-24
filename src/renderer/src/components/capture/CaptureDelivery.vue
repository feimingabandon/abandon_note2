<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import AppModalShell from '../ui/AppModalShell.vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import BaseButton from '../ui/BaseButton.vue'
import NewNotePanel from '../list/NewNotePanel.vue'
import WallpaperCropEditor from '../wallpaper/WallpaperCropEditor.vue'
import { createCaptureDeliveryOperation, identifiers } from '../../composables/useScreenCapture.js'
import { useMessage } from '../../composables/useMessage.js'
import { useModalRequest, useQueuedModal } from '../../composables/useQueuedModal.js'
import {
  editingDataGeneration,
  getLegacyCaptureConflict,
  useDraftProtection
} from '../../composables/useDraftProtection.js'
import { getSettingsSnapshotStore } from '../../utils/settingsSnapshots.js'
import { parseSettingsReceipt } from '../../../../shared/settings-receipt.js'

const emit = defineEmits(['created'])
const { showMessage } = useMessage()
const settingsSnapshots = getSettingsSnapshotStore(window.api)
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
const receivingImage = ref(false)
const importError = ref('')
const recoveryPending = ref(false)
const legacyCaptureConflict = ref(getLegacyCaptureConflict())
if (legacyCaptureConflict.value) {
  // Ambiguous legacy records are not restored into a form. Show their retained
  // status without creating a fresh target that might look like recovered data.
  importError.value = legacyCaptureConflict.value
  noteVisible.value = true
}
let receiving = null,
  disposed = false,
  importSequence = 0
let latestDelivery = null
const currentGeneration = (generation) => !disposed && generation === editingDataGeneration.value
async function pendingDataUrl(asset) {
  const preview = await pendingDraft.previewAsset(asset.image.assetId)
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error || new Error('截图草稿暂时无法读取'))
    reader.readAsDataURL(new Blob([preview.bytes], { type: 'image/' + preview.ext }))
  })
}
const pendingDraft = useDraftProtection({
  key: 'capture:pending-delivery',
  fields: { pendingAsset },
  dirty: () => Boolean(pendingAsset.value),
  busy: () => importing.value || receivingImage.value,
  restoreExtra: () => {
    if (disposed || !pendingAsset.value) return
    // A restored journal may outlive its original document and delivery.
    // Keep its ownership without replaying that old operation's display intent.
    recoveryPending.value = true
    importError.value = '检测到暂存截图，可通过“恢复暂存截图”继续；也可保留并继续当前操作。'
  }
})
const stop = window.api.onScreenshotDelivery(async (asset) => {
  if (disposed || !['note', 'background'].includes(asset.action)) return
  if (
    latestDelivery?.identity.sessionId === asset.sessionId &&
    latestDelivery.identity.deliveryId === asset.deliveryId
  )
    return
  latestDelivery?.cancel('截图交付已被替换', { notify: false })
  const generation = editingDataGeneration.value
  const operation = createCaptureDeliveryOperation(asset, {
    current: () => currentGeneration(generation) && latestDelivery === operation
  })
  latestDelivery = operation
  const confirmationOwner = `capture:${asset.sessionId}:${asset.deliveryId}`
  const receiver = {}
  let accepted = false,
    message = ''
  let ownsReceipt = false
  let durable = false
  let image = null,
    published = null,
    flushStarted = false
  const markRecovery = (text) => {
    if (published && currentGeneration(generation) && pendingAsset.value === published) {
      recoveryPending.value = true
      importError.value = text
    }
  }
  const stopCancellation = operation.onCancel(() => {
    window.__cancelEditingDraftConfirmation?.(confirmationOwner)
    markRecovery('截图交付已结束，暂存结果仍需确认；处理结束后可恢复暂存截图。')
  })
  try {
    if (!(await operation.report('received')) || !(await operation.report('processing'))) return
    if (receiving || pendingAsset.value || noteVisible.value || background.value)
      throw new Error('已有截图草稿或背景裁剪正在编辑，请先完成')
    receiving = receiver
    ownsReceipt = true
    const draft = await operation.wait(window.__prepareEditingDrafts?.())
    if (draft?.blocked) throw new Error('当前草稿正在处理附件，请稍后重试')
    if (draft?.dirty) {
      if (!(await operation.report('awaiting-user'))) return
      if (
        !(await operation.wait(
          window.__confirmEditingDrafts?.('切换视图', { owner: confirmationOwner })
        ))
      )
        throw new Error('已保留当前编辑，可继续复制、保存或贴图')
      if (!(await operation.report('processing'))) return
    }
    operation.assertCurrent()
    // Take durable ownership before acknowledging. The native capture session
    // can finish now; it must not wait for the user to close an unrelated modal.
    receivingImage.value = true
    await pendingDraft.resume()
    operation.assertCurrent()
    if (pendingAsset.value) throw new Error('已有暂存截图，请先恢复或完成原截图')
    image = await pendingDraft.stageImage({
      base64: asset.dataUrl,
      ext: 'png',
      name: `截图_${Date.now()}.png`,
      size: asset.size
    })
    operation.assertCurrent()
    // The journal carries only main-owned asset metadata and delivery identity.
    pendingAsset.value = { ...identifiers(asset), action: asset.action, image }
    published = pendingAsset.value
    // Once published, the draft owner may already be writing its journal.
    // Cancellation must retain that uncertain/committed ownership, not delete it.
    flushStarted = true
    const state = await pendingDraft.flush()
    durable = state.persisted === true
    operation.assertCurrent()
    if (pendingAsset.value !== published) throw new Error('截图暂存已由用户释放')
    if (!state.persisted) throw new Error('截图草稿暂存失败，请保存图片后重试')
    accepted = true
    const acknowledged = await operation.finish(true)
    if (
      !acknowledged ||
      !currentGeneration(generation) ||
      latestDelivery !== operation ||
      pendingAsset.value !== published
    ) {
      markRecovery('图片已暂存，但截图交付已结束；请点击“恢复暂存截图”继续。')
      return
    }
    if (asset.action === 'background') background.value = asset.dataUrl
    else noteVisible.value = true
  } catch (error) {
    message = error.message
    if (image && !published) {
      try {
        await pendingDraft.releaseAssets([image.assetId])
      } catch (cleanupError) {
        console.error('[CaptureDelivery] 未接收截图的暂存清理失败:', cleanupError)
      }
    }
    if (flushStarted) {
      markRecovery(
        durable
          ? '截图交付已结束，图片已暂存；请点击“恢复暂存截图”继续。'
          : '截图暂存结果尚未确认；请恢复暂存截图核对，不要重复提交。'
      )
      if (published && currentGeneration(generation) && pendingAsset.value === published)
        showMessage('warning', importError.value)
    }
  } finally {
    if (ownsReceipt && receiving === receiver) {
      receiving = null
      receivingImage.value = false
    }
    await operation.finish(accepted, message)
    operation.cancel('截图接收回调已结束', { notify: false })
    stopCancellation()
    if (latestDelivery === operation) latestDelivery = null
  }
})

async function recoverPendingCapture() {
  const asset = pendingAsset.value
  if (!asset || importing.value || receivingImage.value || disposed) return
  const generation = editingDataGeneration.value
  const sequence = ++importSequence
  const current = () =>
    currentGeneration(generation) && sequence === importSequence && pendingAsset.value === asset
  importing.value = true
  try {
    const state = await pendingDraft.flush()
    if (!current()) return
    if (!state.persisted) throw new Error('截图暂存尚未确认，请保留原内容后重试')
    if (asset.action === 'background') {
      const dataUrl = await pendingDataUrl(asset)
      if (!current()) return
      background.value = dataUrl
    } else noteVisible.value = true
    recoveryPending.value = false
    importError.value = ''
  } catch (error) {
    if (current()) importError.value = error.message
  } finally {
    if (sequence === importSequence) importing.value = false
  }
}
async function importPendingCapture() {
  const conflict = getLegacyCaptureConflict()
  if (legacyCaptureConflict.value && !conflict) importError.value = ''
  legacyCaptureConflict.value = conflict
  if (conflict) {
    importError.value = conflict
    return
  }
  const asset = pendingAsset.value
  if (!asset || asset.action !== 'note' || importing.value) return
  importing.value = true
  const sequence = ++importSequence
  const generation = editingDataGeneration.value
  let target
  const current = () =>
    currentGeneration(generation) &&
    sequence === importSequence &&
    pendingAsset.value === asset &&
    noteVisible.value &&
    noteRef.value === target
  importError.value = ''
  try {
    await nextTick()
    target = noteRef.value
    if (!current() || !target) return
    const prepared = await target.draftState()
    if (!current()) return
    if (!prepared?.persisted) throw new Error('便签草稿仍在恢复，请稍后重试加载截图')
    if (!target.hasCapture(asset)) {
      const dataUrl = await pendingDataUrl(asset)
      if (!current()) return
      if (!(await target.addCapture({ ...identifiers(asset), dataUrl, size: asset.image.size })))
        throw new Error('图片未能加入便签，请重试')
      if (!current()) return
    }
    const state = await target.draftState()
    if (!current()) return
    if (!state.persisted) {
      throw new Error('图片已加载，但草稿暂存失败，请重试或保存便签')
    }
    // Only a durable target receipt allows releasing the original pending owner.
    await pendingDraft.clear()
    if (!current()) return
    pendingAsset.value = null
  } catch (error) {
    if (current()) importError.value = error.message
  } finally {
    if (sequence === importSequence) importing.value = false
  }
}
async function clearPending() {
  ++importSequence
  pendingAsset.value = null
  recoveryPending.value = false
  importError.value = ''
  await pendingDraft.clear()
}
async function requestClose() {
  if (importing.value || receivingImage.value) return
  const generation = editingDataGeneration.value
  const target = noteRef.value
  const state = await target?.draftState()
  if (!currentGeneration(generation) || noteRef.value !== target) return
  if (state?.blocked) {
    showMessage('warning', '请等待附件处理完成')
    return
  }
  if (state?.dirty || pendingAsset.value) discardVisible.value = true
  else {
    await target?.discard()
    if (currentGeneration(generation) && noteRef.value === target) noteVisible.value = false
  }
}
async function discard() {
  const generation = editingDataGeneration.value
  const target = noteRef.value
  const cancelled = await target?.discard()
  if (cancelled === false || !currentGeneration(generation) || noteRef.value !== target) return
  await clearPending()
  if (currentGeneration(generation) && noteRef.value === target) noteVisible.value = false
}
async function created() {
  const generation = editingDataGeneration.value
  try {
    await clearPending()
  } catch (error) {
    console.error('[CaptureDelivery] 创建后的截图草稿清理失败:', error)
    if (currentGeneration(generation))
      showMessage('warning', '便签已创建，部分截图草稿待清理，请勿重复创建。')
  }
  if (!currentGeneration(generation)) return
  noteVisible.value = false
  emit('created')
}
async function backgroundSaved(record) {
  const generation = editingDataGeneration.value
  try {
    await clearPending()
  } catch (error) {
    console.error('[CaptureDelivery] 壁纸保存后的截图草稿清理失败:', error)
    if (currentGeneration(generation)) showMessage('warning', '壁纸已保存，部分截图草稿待清理。')
  }
  if (!currentGeneration(generation)) return
  background.value = ''
  try {
    const result = await window.api.activateWallpaper(record.id)
    const receipt = parseSettingsReceipt(result, { source: settingsSnapshots.latest()?.source })
    if (!receipt.saved) throw new Error(receipt.error?.message || '壁纸设置保存结果尚未确认')
    if (receipt.canonical) settingsSnapshots.acceptCommitted(receipt.canonical, { reconcile: true })
    if (disposed) return
    if (!receipt.canonical || (receipt.application && receipt.application.status !== 'applied'))
      showMessage('warning', '壁纸设置已保存，当前效果尚待确认', 4000)
    else showMessage('success', '主页面壁纸已应用')
  } catch (error) {
    showMessage('error', `壁纸已保存，但应用失败：${error.message}`)
  }
}
async function cancelBackground() {
  const generation = editingDataGeneration.value
  await clearPending()
  if (currentGeneration(generation)) background.value = ''
}
watch(editingDataGeneration, () => {
  latestDelivery?.cancel('截图接收数据已换代')
  latestDelivery = null
  receiving = null
  receivingImage.value = false
  ++importSequence
  pendingAsset.value = null
  recoveryPending.value = false
  importError.value = ''
  legacyCaptureConflict.value = null
  importing.value = false
  noteVisible.value = false
  background.value = ''
})
onBeforeUnmount(() => {
  latestDelivery?.cancel('截图接收页面已关闭')
  latestDelivery = null
  disposed = true
  ++importSequence
  stop()
})
</script>

<template>
  <Teleport to="body">
    <aside
      v-if="recoveryPending && pendingAsset && !noteVisible && !background"
      class="capture-recovery-entry"
      role="region"
      aria-label="暂存截图恢复"
    >
      <p role="status">{{ importError || '有一张暂存截图，可按需恢复。' }}</p>
      <BaseButton
        aria-label="恢复暂存截图"
        :disabled="importing || receivingImage"
        @click="recoverPendingCapture"
      >
        恢复暂存截图
      </BaseButton>
    </aside>
  </Teleport>
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
      <button
        type="button"
        :disabled="importing || !!legacyCaptureConflict"
        @click="importPendingCapture"
      >
        重试加载截图
      </button>
    </p>
    <NewNotePanel
      v-if="noteVisible && !legacyCaptureConflict"
      ref="noteRef"
      draft-key="new:capture"
      active
      @create="created"
    />
  </AppModalShell>
  <ConfirmDialog
    v-model:visible="discardVisible"
    title="放弃这张便签草稿？"
    message="草稿中的正文、备注和截图尚未保存。"
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

<style scoped>
/* A persistent, nonmodal window notice: above page content, below editors and
   confirmations. Only this compact region receives input; page leave stays available. */
.capture-recovery-entry {
  position: fixed;
  right: 12rem;
  bottom: 12rem;
  left: 12rem;
  z-index: var(--z-global-panel);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10rem;
  max-height: calc(100vh - 24rem);
  padding: 12rem;
  overflow: auto;
  border: 1px solid var(--surface-float-border);
  border-radius: 12rem;
  background: var(--surface-float);
  color: var(--text-color);
  font-size: var(--fs-secondary);
}

.capture-recovery-entry p {
  flex: 1 1 180rem;
  min-width: 0;
  margin: 0;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
</style>
