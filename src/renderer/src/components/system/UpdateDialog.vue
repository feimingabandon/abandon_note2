<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import BaseButton from '../ui/BaseButton.vue'
import { releaseModalBlur, retainModalBlur } from '../../utils/modalBlur.js'

const props = defineProps({
  visible: { type: Boolean, default: false },
  checking: { type: Boolean, default: false },
  result: { type: Object, default: null }
})

const emit = defineEmits(['update:visible', 'retry'])

const downloading = ref(false)
const downloaded = ref(false)
const downloadError = ref('')
const progress = ref(null)
let ownsModalBlur = false

const title = computed(() => {
  if (props.checking) return '正在检查更新'
  if (props.result?.status === 'available') return `发现新版本 v${props.result.latestVersion}`
  if (props.result?.status === 'current') return '已经是最新版本'
  if (props.result?.status === 'error') return '暂时无法检查更新'
  return '应用更新'
})

const platformLabel = computed(() => {
  if (props.result?.platform === 'win32') return 'Windows x64'
  if (props.result?.platform === 'darwin' && props.result?.arch === 'arm64')
    return 'macOS Apple 芯片'
  if (props.result?.platform === 'darwin') return 'macOS Intel'
  return '当前系统'
})

const availableSummary = computed(
  () =>
    `当前版本 v${props.result?.currentVersion}，可更新到 v${props.result?.latestVersion}。` +
    '更新会覆盖安装，不需要先卸载，也不会主动删除便签数据。'
)

const downloadLabel = computed(() => {
  if (downloaded.value) return '安装更新并退出'
  if (!downloading.value) return '在线下载更新'
  if (progress.value?.percent != null) return `正在下载 ${progress.value.percent}%`
  return '正在下载…'
})

const stopProgress = window.api.onUpdateDownloadProgress?.((payload) => {
  progress.value = payload
  if (payload?.state === 'error') downloadError.value = payload.error || '下载失败'
})

watch(
  () => props.visible,
  (visible) => {
    if (visible && !ownsModalBlur) {
      ownsModalBlur = true
      retainModalBlur()
    } else if (!visible && ownsModalBlur) {
      ownsModalBlur = false
      releaseModalBlur()
    }
  },
  { immediate: true }
)

watch(
  () => props.result?.latestVersion,
  () => {
    downloaded.value = false
    downloading.value = false
    downloadError.value = ''
    progress.value = null
  }
)

function close() {
  if (downloading.value) return
  emit('update:visible', false)
}

async function openManual(provider) {
  try {
    await window.api.openManualUpdate(provider)
  } catch (error) {
    downloadError.value = `无法打开更新页面：${error.message}`
  }
}

async function handleOnlineUpdate() {
  if (downloaded.value) {
    try {
      await window.api.installDownloadedUpdate()
    } catch (error) {
      downloadError.value = `无法启动安装包：${error.message}`
    }
    return
  }

  downloading.value = true
  downloadError.value = ''
  try {
    const result = await window.api.downloadUpdate()
    downloaded.value = Boolean(result?.ready)
  } catch (error) {
    downloadError.value = error.message || '下载失败，请使用下方手动更新地址'
  } finally {
    downloading.value = false
  }
}

onBeforeUnmount(() => {
  stopProgress?.()
  if (ownsModalBlur) releaseModalBlur()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="update-dialog">
      <div v-if="visible" class="update-overlay" @click.self="close">
        <section class="update-card" role="dialog" aria-modal="true" aria-labelledby="update-title">
          <header class="update-header">
            <div>
              <p class="update-eyebrow">Abandon Note</p>
              <h2 id="update-title">{{ title }}</h2>
            </div>
            <button class="update-close" :disabled="downloading" aria-label="关闭" @click="close">
              ×
            </button>
          </header>

          <div v-if="checking" class="checking-row">
            <span class="checking-spinner" aria-hidden="true" />
            <span>正在从 Gitee 获取稳定版本信息…</span>
          </div>

          <template v-else-if="result">
            <p v-if="result.status === 'available'" class="update-summary">
              {{ availableSummary }}
            </p>
            <p v-else-if="result.status === 'current'" class="update-summary">
              当前版本 v{{ result.currentVersion }}，无需更新。
            </p>
            <p v-else class="update-summary update-summary--warning">
              {{ result.error || '当前系统暂不支持在线更新，请使用手动更新地址。' }}
            </p>

            <div class="artifact-card">
              <span class="artifact-label">{{ platformLabel }} 应下载</span>
              <strong>{{ result.artifactName || '请在发布页选择当前系统安装包' }}</strong>
            </div>

            <div
              v-if="result.status === 'available' && result.onlineDownloadSupported"
              class="online-update"
            >
              <BaseButton
                variant="primary"
                size="lg"
                :disabled="downloading"
                style="width: 100%"
                @click="handleOnlineUpdate"
              >
                {{ downloadLabel }}
              </BaseButton>
              <div
                v-if="downloading && progress?.percent != null"
                class="progress-track"
                role="progressbar"
                :aria-valuenow="progress.percent"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <span :style="{ width: `${progress.percent}%` }" />
              </div>
              <p v-if="downloaded" class="download-note">
                安装包已准备好。点击上方按钮会启动安装程序并退出应用。
              </p>
            </div>

            <p v-if="downloadError" class="download-error">{{ downloadError }}</p>

            <div class="manual-section">
              <div class="manual-heading">
                <strong>手动更新</strong>
                <span>在线更新是否可用，都可以从以下地址下载</span>
              </div>
              <div class="manual-actions">
                <BaseButton variant="default" @click="openManual('gitee')">Gitee 下载</BaseButton>
                <BaseButton variant="default" @click="openManual('github')">
                  GitHub 下载
                </BaseButton>
              </div>
            </div>

            <BaseButton
              v-if="result.status === 'error'"
              variant="default"
              style="width: 100%"
              @click="emit('retry')"
            >
              重新检查
            </BaseButton>
          </template>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.update-overlay {
  position: fixed;
  inset: 0;
  z-index: 41000;
  display: grid;
  place-items: center;
  padding: 24rem;
  border-radius: var(--window-radius);
  background: rgba(12, 14, 18, 0.18);
}

.update-card {
  width: min(390rem, calc(100vw - 32rem));
  max-height: calc(100vh - 32rem);
  overflow-y: auto;
  padding: 22rem;
  border: 1px solid var(--surface-float-border);
  border-radius: 16rem;
  color: var(--text-color);
  background: var(--surface-float);
  box-shadow: 0 18px 64px rgba(0, 0, 0, 0.38);
}

.update-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16rem;
}

.update-eyebrow {
  margin: 0 0 4rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}

.update-header h2 {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 650;
}

.update-close {
  width: 28rem;
  height: 28rem;
  border: 0;
  border-radius: 50%;
  color: var(--text-color-secondary);
  background: rgba(255, 255, 255, 0.08);
  cursor: pointer;
}

.checking-row {
  display: flex;
  align-items: center;
  gap: 10rem;
  min-height: 96rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}

.checking-spinner {
  width: 16rem;
  height: 16rem;
  border: 2px solid rgba(255, 255, 255, 0.18);
  border-top-color: #0071e3;
  border-radius: 50%;
  animation: update-spin 0.8s linear infinite;
}

.update-summary {
  margin: 16rem 0;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  line-height: 1.55;
}

.update-summary--warning,
.download-error {
  color: #ff9f8f;
}

.artifact-card {
  display: flex;
  flex-direction: column;
  gap: 5rem;
  padding: 13rem 14rem;
  border-radius: 10rem;
  background: rgba(255, 255, 255, 0.06);
}

.artifact-label {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}

.artifact-card strong {
  overflow-wrap: anywhere;
  font-size: var(--fs-secondary);
}

.online-update,
.manual-section {
  margin-top: 14rem;
}

.progress-track {
  height: 3rem;
  margin-top: 8rem;
  overflow: hidden;
  border-radius: 2rem;
  background: rgba(255, 255, 255, 0.1);
}

.progress-track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: #0071e3;
  transition: width 160ms ease;
}

.download-note,
.download-error {
  margin: 9rem 0 0;
  font-size: var(--fs-secondary);
  line-height: 1.45;
}

.manual-section {
  padding-top: 14rem;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.manual-heading {
  display: flex;
  flex-direction: column;
  gap: 3rem;
  margin-bottom: 10rem;
}

.manual-heading strong {
  font-size: var(--fs-body);
}

.manual-heading span {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}

.manual-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 9rem;
}

.manual-actions :deep(.base-btn) {
  width: 100%;
}

.update-dialog-enter-active,
.update-dialog-leave-active {
  transition: opacity var(--motion-control) ease;
}

.update-dialog-enter-active .update-card,
.update-dialog-leave-active .update-card {
  transition:
    opacity var(--motion-control) ease,
    transform var(--motion-control) var(--ease-standard);
}

.update-dialog-enter-from,
.update-dialog-leave-to,
.update-dialog-enter-from .update-card,
.update-dialog-leave-to .update-card {
  opacity: 0;
}

.update-dialog-enter-from .update-card,
.update-dialog-leave-to .update-card {
  transform: translateY(8rem);
}

@keyframes update-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
