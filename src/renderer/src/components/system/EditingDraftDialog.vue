<script setup>
import { onBeforeUnmount, ref } from 'vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'

const visible = ref(false)
const action = ref('切换视图')
let pending = null

function finish(accepted = false) {
  visible.value = false
  const request = pending
  pending = null
  request?.resolve(accepted)
}

function requestConfirmation(nextAction) {
  if (pending) return pending.promise
  action.value = nextAction === '退出' ? '退出' : '切换视图'
  const promise = new Promise((resolve) => {
    pending = { resolve }
  })
  pending.promise = promise
  visible.value = true
  return promise
}

window.__confirmEditingDrafts = requestConfirmation
window.__cancelEditingDraftConfirmation = finish
onBeforeUnmount(() => {
  finish(false)
  delete window.__confirmEditingDrafts
  delete window.__cancelEditingDraftConfirmation
})
</script>

<template>
  <ConfirmDialog
    v-model:visible="visible"
    title="保留草稿后继续？"
    message="未保存内容只在本次软件启动期间暂存，重新打开对应编辑器即可继续编辑。退出软件后不会恢复。"
    :confirm-text="action === '退出' ? '保留并退出' : '保留并切换'"
    cancel-text="继续编辑"
    @confirm="finish(true)"
    @cancel="finish(false)"
  />
</template>
