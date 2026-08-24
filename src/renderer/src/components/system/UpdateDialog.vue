<script setup>
import { computed, ref, watch } from 'vue'
import AppModalShell from '../ui/AppModalShell.vue'
import BaseButton from '../ui/BaseButton.vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  checking: { type: Boolean, default: false },
  result: { type: Object, default: null }
})

const emit = defineEmits(['update:visible', 'retry'])

const actionError = ref('')
const confirmVisible = ref(false)
const pendingTarget = ref(null)

const manualLinks = computed(() => [
  {
    target: 'gitcode',
    label: 'GitCode',
    url: props.result?.releaseLinks?.gitcode || ''
  },
  {
    target: 'github',
    label: 'GitHub',
    url: props.result?.releaseLinks?.github || ''
  }
])

const title = computed(() => {
  if (props.checking) return '正在检查更新'
  if (props.result?.status === 'available') return `发现新版本 v${props.result.latestVersion}`
  if (props.result?.status === 'current') return '已经是最新版本'
  if (props.result?.status === 'downgrade') return '远程公开版本低于当前版本'
  if (props.result?.status === 'unpublished') return '尚未发布公开版本'
  if (props.result?.status === 'error') return '暂时无法连接更新服务'
  if (props.result?.status === 'unsupported') return '暂不提供更新下载'
  return '应用更新'
})

const platformLabel = computed(() => {
  if (props.result?.platform === 'win32') return 'Windows x64'
  return '当前系统'
})

const hasRelease = computed(
  () =>
    Boolean(props.result?.latestVersion) &&
    ['available', 'current', 'downgrade'].includes(props.result?.status)
)

const releaseNotes = computed(() => String(props.result?.releaseNotes || '').trim())

const statusSummary = computed(() => {
  if (props.result?.status === 'available') {
    return (
      `当前版本 v${props.result.currentVersion}，可更新到 v${props.result.latestVersion}。` +
      '覆盖安装不需要先卸载，也不会主动删除便签数据。'
    )
  }
  if (props.result?.status === 'current') {
    return `当前版本与公开版本都是 v${props.result.currentVersion}。继续操作属于同版本重新下载，不是升级。`
  }
  if (props.result?.status === 'downgrade') {
    return `当前版本 v${props.result.currentVersion} 高于公开版本 v${props.result.latestVersion}。继续安装会降级，旧版本可能无法识别新版本写入的数据，请先备份重要内容。`
  }
  return props.result?.error || '暂时无法获取公开版本信息。'
})

const primaryActionLabel = computed(() => {
  if (props.result?.relation === 'same') return '重新下载安装包'
  if (props.result?.relation === 'downgrade') return `下载旧版本 v${props.result.latestVersion}`
  return '使用浏览器下载更新'
})

const confirmation = computed(() => {
  if (props.result?.relation === 'downgrade') {
    return {
      title: '确认下载旧版本？',
      message: `当前 v${props.result.currentVersion} → 目标 v${props.result.latestVersion}。\n\n这是降级操作，旧版本可能无法识别新版本写入的数据。请先备份重要内容，再决定是否继续。`,
      confirmText: `仍要下载 v${props.result.latestVersion}`,
      variant: 'danger'
    }
  }
  return {
    title: '确认重新下载安装包？',
    message: `当前版本与目标版本都是 v${props.result?.latestVersion}。这不是升级，将重新打开同版本安装包或发布页面。`,
    confirmText: '继续打开',
    variant: 'default'
  }
})

const contentKey = computed(() => {
  if (props.checking) return 'checking'
  return `${props.result?.status || 'idle'}-${props.result?.latestVersion || 'none'}`
})

watch(
  () => props.result?.checkId,
  () => {
    actionError.value = ''
    confirmVisible.value = false
    pendingTarget.value = null
  }
)

watch(
  () => props.visible,
  (visible) => {
    if (visible) return
    confirmVisible.value = false
    pendingTarget.value = null
  }
)

function close() {
  confirmVisible.value = false
  pendingTarget.value = null
  emit('update:visible', false)
}

async function openUpdateTargetNow(target, label) {
  try {
    actionError.value = ''
    await window.api.openUpdateLink({
      target,
      checkId: props.result?.checkId,
      targetVersion: props.result?.latestVersion,
      relation: props.result?.relation
    })
  } catch (error) {
    console.error(`[UpdateDialog] 打开${label}失败:`, error)
    actionError.value = `无法打开${label}：${error.message}`
  }
}

function requestOpenUpdateTarget(target, label) {
  if (props.result?.relation === 'upgrade') {
    void openUpdateTargetNow(target, label)
    return
  }
  pendingTarget.value = { target, label }
  confirmVisible.value = true
}

function confirmOpenUpdateTarget() {
  const pending = pendingTarget.value
  pendingTarget.value = null
  if (pending) void openUpdateTargetNow(pending.target, pending.label)
}
</script>

<template>
  <AppModalShell
    :visible="visible"
    :title="title"
    eyebrow="Abandon Note"
    width="min(460rem, calc(100vw - 40rem))"
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
          <p
            class="update-summary"
            :class="{
              'update-summary--warning': result.status === 'error' || result.status === 'downgrade'
            }"
          >
            {{ statusSummary }}
          </p>

          <template v-if="hasRelease">
            <section
              v-if="releaseNotes"
              class="release-notes"
              aria-labelledby="release-notes-heading"
            >
              <strong id="release-notes-heading">本次更新</strong>
              <p>{{ releaseNotes }}</p>
            </section>

            <section class="download-section" aria-labelledby="browser-download-heading">
              <div class="section-heading">
                <strong id="browser-download-heading">浏览器下载</strong>
                <span>点击按钮后，将在默认浏览器中直接下载 GitCode 安装包</span>
              </div>
              <button
                class="browser-download"
                :disabled="!result.downloadAvailable"
                :title="
                  result.downloadAvailable
                    ? `使用浏览器下载 ${result.artifactName}`
                    : 'GitCode 对应版本安装包尚未同步完成'
                "
                @click="requestOpenUpdateTarget('download', 'GitCode 安装包下载地址')"
              >
                <span class="browser-download-copy">
                  <strong>{{ primaryActionLabel }}</strong>
                  <span>
                    {{
                      result.downloadAvailable
                        ? `GitCode · ${platformLabel} · v${result.latestVersion}`
                        : 'GitCode 安装包同步中，请稍后重试'
                    }}
                  </span>
                </span>
                <span class="browser-download-arrow" aria-hidden="true">↓</span>
              </button>
              <span v-if="result.downloadAvailable" class="artifact-name">
                {{ result.artifactName }}
              </span>
            </section>

            <section class="manual-section" aria-labelledby="manual-download-heading">
              <div class="section-heading">
                <strong id="manual-download-heading">手动下载</strong>
                <span>进入 v{{ result.latestVersion }} 的发布页面查看说明或选择附件</span>
              </div>
              <div class="manual-actions">
                <button
                  v-for="link in manualLinks"
                  :key="link.target"
                  class="manual-link"
                  :title="`在浏览器中打开 ${link.label} v${result.latestVersion} 发布页`"
                  @click="requestOpenUpdateTarget(link.target, `${link.label} 发布页`)"
                >
                  <span class="manual-link-label">{{ link.label }}：</span>
                  <span class="manual-link-url">{{ link.url }}</span>
                  <span class="manual-link-arrow" aria-hidden="true">↗</span>
                </button>
              </div>
            </section>
          </template>

          <div v-else-if="result.status === 'unsupported'" class="unsupported-card">
            <span>{{ platformLabel }}</span>
            <strong>暂不提供该系统的应用内下载入口</strong>
          </div>

          <p v-if="actionError" class="action-error">{{ actionError }}</p>

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
  <ConfirmDialog
    v-model:visible="confirmVisible"
    :title="confirmation.title"
    :message="confirmation.message"
    :confirm-text="confirmation.confirmText"
    :variant="confirmation.variant"
    @confirm="confirmOpenUpdateTarget"
    @cancel="pendingTarget = null"
  />
</template>

<style scoped>
.update-state {
  min-height: 315rem;
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
  border-top-color: var(--ui-accent);
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
.action-error {
  color: color-mix(in srgb, #ff453a 78%, var(--text-color));
}

.release-notes {
  display: flex;
  flex-direction: column;
  gap: 7rem;
  margin-bottom: 15rem;
  padding: 12rem 14rem;
  border: 1px solid var(--ui-border-divider);
  border-radius: 10rem;
  background: var(--ui-surface-subtle);
}

.release-notes strong {
  font-size: var(--fs-body);
}

.release-notes p {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  line-height: 1.6;
  white-space: pre-wrap;
}

.download-section,
.manual-section {
  display: flex;
  flex-direction: column;
  gap: 10rem;
}

.download-section {
  padding-bottom: 15rem;
  border-bottom: 1px solid var(--ui-border-divider);
}

.browser-download {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12rem;
  width: 100%;
  min-height: 58rem;
  padding: 10rem 14rem;
  border: none;
  border-radius: 10rem;
  color: #fff;
  background: var(--ui-accent);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--motion-fast) ease,
    transform var(--motion-control) var(--ease-standard);
}

.browser-download:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-accent) 88%, white);
}

.browser-download:active:not(:disabled) {
  transform: scale(0.98);
}

.browser-download:disabled {
  color: var(--text-color-secondary);
  background: var(--ui-surface-control);
  cursor: not-allowed;
}

.browser-download-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3rem;
}

.browser-download-copy strong {
  font-size: var(--fs-body);
  font-weight: 650;
}

.browser-download-copy span,
.artifact-name,
.action-error {
  font-size: var(--fs-secondary);
  line-height: 1.45;
}

.browser-download-copy span {
  opacity: 0.82;
}

.browser-download-arrow {
  flex: 0 0 auto;
  font-size: 22rem;
  line-height: 1;
}

.artifact-name {
  overflow-wrap: anywhere;
  color: var(--text-color-secondary);
}

.manual-section {
  padding-top: 15rem;
}

.section-heading {
  display: flex;
  flex-direction: column;
  gap: 3rem;
}

.section-heading strong {
  font-size: var(--fs-body);
}

.section-heading span {
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
  border: 1px solid var(--ui-border-control);
  border-radius: 9rem;
  color: var(--ui-accent);
  background: var(--ui-surface-control);
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
  border-color: var(--ui-accent);
}

.manual-link:active {
  transform: scale(0.98);
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

.unsupported-card {
  display: flex;
  flex-direction: column;
  gap: 4rem;
  padding: 13rem 14rem;
  border-radius: 10rem;
  background: var(--ui-surface-subtle);
}

.unsupported-card span {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}

.unsupported-card strong {
  font-size: var(--fs-secondary);
}

.action-error {
  margin: 10rem 0 0;
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
}

.update-title-leave-to,
.update-content-leave-to {
  opacity: 0;
  transform: translateY(-4rem);
}

@keyframes update-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
