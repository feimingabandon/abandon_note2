<script setup>
import { computed, ref, watch } from 'vue'
import AppModalShell from '../ui/AppModalShell.vue'
import BaseButton from '../ui/BaseButton.vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  checking: { type: Boolean, default: false },
  result: { type: Object, default: null }
})

const emit = defineEmits(['update:visible', 'retry'])

const manualError = ref('')

const manualLinks = Object.freeze([
  {
    provider: 'gitcode',
    label: 'GitCode',
    url: 'https://gitcode.com/zou-feiming/abandon_note2/releases'
  },
  {
    provider: 'github',
    label: 'GitHub',
    url: 'https://github.com/feimingabandon/abandon_note2/releases'
  }
])

const title = computed(() => {
  if (props.checking) return '正在检查更新'
  if (props.result?.status === 'available') return `发现新版本 v${props.result.latestVersion}`
  if (props.result?.status === 'current') return '已经是最新版本'
  if (props.result?.status === 'unpublished') return '尚未发布公开版本'
  if (props.result?.status === 'error') return '暂时无法连接更新服务'
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
    '请前往下方发布页下载安装包；更新会覆盖安装，不需要先卸载，也不会主动删除便签数据。'
)

const contentKey = computed(() => {
  if (props.checking) return 'checking'
  return `${props.result?.status || 'idle'}-${props.result?.latestVersion || 'none'}`
})

watch(
  () => props.result?.latestVersion,
  () => {
    manualError.value = ''
  }
)

function close() {
  emit('update:visible', false)
}

async function openManual(provider) {
  try {
    await window.api.openManualUpdate(provider)
  } catch (error) {
    manualError.value = `无法打开更新页面：${error.message}`
  }
}
</script>

<template>
  <AppModalShell
    :visible="visible"
    :title="title"
    eyebrow="Abandon Note"
    width="min(430rem, calc(100vw - 40rem))"
    @update:visible="close"
  >
    <Transition name="update-content" mode="out-in">
      <div :key="contentKey" class="update-state">
        <div v-if="checking" class="checking-row">
          <span class="checking-spinner" aria-hidden="true" />
          <div class="checking-copy">
            <strong>正在查询公开 Release</strong>
            <span>同时检查 GitCode 与 GitHub，选择较新的版本</span>
          </div>
        </div>

        <template v-else-if="result">
          <p v-if="result.status === 'available'" class="update-summary">
            {{ availableSummary }}
          </p>
          <p v-else-if="result.status === 'current'" class="update-summary">
            当前版本 v{{ result.currentVersion }}，无需更新。
          </p>
          <p
            v-else
            class="update-summary"
            :class="{ 'update-summary--warning': result.status === 'error' }"
          >
            {{ result.error || '请使用下方发布页下载对应系统的安装包。' }}
          </p>

          <div class="manual-section">
            <div class="manual-heading">
              <strong>手动更新</strong>
              <span>点击以下地址，前往对应平台的安装包发布页</span>
            </div>
            <div class="manual-actions">
              <button
                v-for="link in manualLinks"
                :key="link.provider"
                class="manual-link"
                :title="`在浏览器中打开 ${link.label} 安装包发布页`"
                @click="openManual(link.provider)"
              >
                <span class="manual-link-label">{{ link.label }}：</span>
                <span class="manual-link-url">{{ link.url }}</span>
                <span class="manual-link-arrow" aria-hidden="true">↗</span>
              </button>
            </div>
          </div>

          <div class="artifact-card">
            <template v-if="result.status === 'current'">
              <span class="artifact-label">{{ platformLabel }}</span>
              <strong>当前无需下载任何安装包</strong>
            </template>
            <template v-else-if="result.status === 'unpublished'">
              <span class="artifact-label">{{ platformLabel }}</span>
              <strong>尚无可下载的公开安装包</strong>
            </template>
            <template v-else-if="result.status === 'error'">
              <span class="artifact-label">{{ platformLabel }}</span>
              <strong>暂时无法确认推荐版本，请在发布页选择对应系统安装包</strong>
            </template>
            <template v-else>
              <span class="artifact-label">{{ platformLabel }} 推荐下载</span>
              <strong>{{ result.artifactName || '请在发布页选择当前系统安装包' }}</strong>
            </template>
          </div>

          <p v-if="manualError" class="manual-error">{{ manualError }}</p>

          <BaseButton
            v-if="result.status === 'error' || result.status === 'unpublished'"
            variant="default"
            style="width: 100%"
            @click="emit('retry')"
          >
            重新检查
          </BaseButton>
        </template>
      </div>
    </Transition>
  </AppModalShell>
</template>

<style scoped>
.update-state {
  min-height: 300rem;
}

.checking-row {
  display: flex;
  align-items: center;
  gap: 10rem;
  justify-content: center;
  min-height: 220rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}

.checking-copy {
  display: flex;
  flex-direction: column;
  gap: 3rem;
}

.checking-copy strong {
  color: var(--text-color);
  font-size: var(--fs-body);
  font-weight: 600;
}

.checking-spinner {
  width: 20rem;
  height: 20rem;
  border: 2px solid color-mix(in srgb, var(--text-color) 15%, transparent);
  border-top-color: #0071e3;
  border-radius: 50%;
  animation: update-spin 0.8s linear infinite;
}

.update-summary {
  margin: 0 0 15rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  line-height: 1.55;
}

.update-summary--warning,
.manual-error {
  color: color-mix(in srgb, #ff453a 78%, var(--text-color));
}

.artifact-card {
  display: flex;
  flex-direction: column;
  gap: 5rem;
  padding: 13rem 14rem;
  border-radius: 10rem;
  background: rgba(255, 255, 255, 0.06);
  margin-top: 14rem;
}

.artifact-label {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}

.artifact-card strong {
  overflow-wrap: anywhere;
  font-size: var(--fs-secondary);
}

.manual-error {
  margin: 9rem 0 0;
  font-size: var(--fs-secondary);
  line-height: 1.45;
}

.manual-section {
  padding: 14rem 0;
  border-top: 1px solid var(--surface-float-border);
  border-bottom: 1px solid var(--surface-float-border);
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
  display: flex;
  flex-direction: column;
  gap: 7rem;
}

.manual-link {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 4rem;
  width: 100%;
  min-height: 38rem;
  padding: 8rem 10rem;
  border: 1px solid color-mix(in srgb, #0071e3 18%, transparent);
  border-radius: 9rem;
  color: #0071e3;
  background: color-mix(in srgb, #0071e3 6%, transparent);
  font-family: inherit;
  font-size: var(--fs-secondary);
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--motion-fast) ease,
    background-color var(--motion-fast) ease,
    transform var(--motion-control) var(--ease-standard);
}

.manual-link:hover {
  border-color: color-mix(in srgb, #0071e3 36%, transparent);
  background: color-mix(in srgb, #0071e3 11%, transparent);
}

.manual-link:active {
  transform: scale(0.99);
}

.manual-link-label {
  font-weight: 650;
}

.manual-link-url {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.manual-link-arrow {
  font-size: var(--fs-body);
}

.update-title-enter-active,
.update-title-leave-active,
.update-content-enter-active,
.update-content-leave-active {
  transition:
    opacity 180ms ease,
    transform 220ms var(--ease-standard),
    filter 180ms ease;
}

.update-title-enter-from,
.update-content-enter-from {
  opacity: 0;
  transform: translateY(5rem);
  filter: blur(2px);
}

.update-title-leave-to,
.update-content-leave-to {
  opacity: 0;
  transform: translateY(-4rem);
  filter: blur(2px);
}

@keyframes update-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
