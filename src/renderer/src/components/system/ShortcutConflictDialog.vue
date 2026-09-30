<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppModalShell from '../ui/AppModalShell.vue'
import BaseButton from '../ui/BaseButton.vue'
import { useModalRequest } from '../../composables/useQueuedModal.js'
import { unavailableShortcuts } from '../../../../shared/shortcut-status.js'

const emit = defineEmits(['update:visible', 'open-settings'])
const queue = useModalRequest()
const visible = queue.requested
const failures = ref([])
const busy = ref(false)
const feedback = ref('')
let disposed = false
let stopSettingsListener = null

watch(visible, (value) => emit('update:visible', value), { flush: 'sync' })

async function dismiss(openSettings = false) {
  if (busy.value) return
  try {
    await window.api.dismissShortcutStartupNotice()
    visible.value = false
    if (openSettings) emit('open-settings')
  } catch {
    feedback.value = '关闭提示失败，请重试'
  }
}

async function retry() {
  if (busy.value) return
  busy.value = true
  feedback.value = ''
  try {
    const snapshot = await window.api.retryShortcuts()
    if (disposed) return
    failures.value = unavailableShortcuts(snapshot.runtime.shortcuts)
    feedback.value = failures.value.length
      ? '仍有快捷键无法启用，请释放占用后重试，或前往设置更换按键。'
      : '快捷键已恢复，无需重启。'
  } catch {
    feedback.value = '重试失败，请稍后再试'
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  stopSettingsListener = window.api.onSettingsChanged((snapshot) => {
    if (visible.value) failures.value = unavailableShortcuts(snapshot.runtime.shortcuts)
  })
  try {
    const items = await window.api.getShortcutStartupNotice()
    if (disposed || !items.length) return
    failures.value = items
    visible.value = true
  } catch (error) {
    console.warn('[ShortcutConflictDialog] 读取启动快捷键状态失败:', error)
  }
})

onBeforeUnmount(() => {
  disposed = true
  stopSettingsListener?.()
  emit('update:visible', false)
})
</script>

<template>
  <AppModalShell
    :queue="queue"
    :visible="visible"
    title="快捷键启用提示"
    aria-label="快捷键启用提示"
    width="min(480rem, calc(100vw - 40rem))"
    :close-disabled="busy"
    @update:visible="dismiss()"
  >
    <div class="shortcut-conflict-notice">
      <template v-if="failures.length">
        <p>启动时以下快捷键未能启用：</p>
        <ul>
          <li v-for="item in failures" :key="item.action">
            <strong>{{ item.label }} · {{ item.accelerator }}</strong>
            <span>{{ item.message }}</span>
          </li>
        </ul>
        <p>
          在其他软件中取消对应快捷键后，点击“重试启用”即可，无需重启便签。也可以在设置中更换按键。
        </p>
        <p>稍后处理时，可在设置中找到“重试启用”。</p>
      </template>
      <p v-else>当前没有待处理的快捷键冲突。</p>
      <p v-if="feedback" role="status">{{ feedback }}</p>
    </div>
    <template #footer>
      <BaseButton :disabled="busy" @click="dismiss()">{{
        failures.length ? '稍后处理' : '完成'
      }}</BaseButton>
      <BaseButton v-if="failures.length" :disabled="busy" @click="dismiss(true)"
        >前往设置</BaseButton
      >
      <BaseButton v-if="failures.length" variant="primary" :disabled="busy" @click="retry">
        {{ busy ? '正在重试…' : '重试启用' }}
      </BaseButton>
    </template>
  </AppModalShell>
</template>

<style scoped>
.shortcut-conflict-notice {
  color: var(--text-color-secondary);
  font-size: var(--fs-body);
  line-height: 1.6;
}
.shortcut-conflict-notice p {
  margin: 0 0 10rem;
}
.shortcut-conflict-notice ul {
  margin: 12rem 0;
  padding-left: 20rem;
}
.shortcut-conflict-notice li + li {
  margin-top: 10rem;
}
.shortcut-conflict-notice strong {
  display: block;
  color: var(--text-color);
}
</style>
