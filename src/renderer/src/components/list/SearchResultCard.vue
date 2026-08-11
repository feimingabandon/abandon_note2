<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import StatusRing from './StatusRing.vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import { useMessage } from '../../composables/useMessage.js'
import { getNoteTextColor } from '../../utils/noteAppearance.js'

const props = defineProps({
  note: { type: Object, required: true },
  query: { type: String, default: '' }
})

const noteTextColor = computed(() => getNoteTextColor(props.note))

const emit = defineEmits(['edit', 'deleted'])
const { showMessage } = useMessage()

const STATUS_META = {
  initialized: { label: '初始化', color: '#0A84FF' },
  in_progress: { label: '进行中', color: '#FF9F0A' },
  completed: { label: '已完成', color: '#30D158' },
  deleted: { label: '已删除', color: '#FF453A' }
}

const status = computed(() =>
  props.note.is_deleted
    ? STATUS_META.deleted
    : STATUS_META[props.note.status] || STATUS_META.initialized
)
const displayStatus = computed(() => (props.note.is_deleted ? 'deleted' : props.note.status))
const displayContent = computed(() => {
  const content = String(props.note.content || '')
  return content.trim() ? content : '空白便签'
})

const contentParts = computed(() => {
  const content = displayContent.value
  const needle = props.query.trim()
  if (!needle) return [{ text: content, match: false }]

  const parts = []
  const haystack = content.toLocaleLowerCase()
  const normalizedNeedle = needle.toLocaleLowerCase()
  let cursor = 0
  let index = haystack.indexOf(normalizedNeedle, cursor)
  while (index !== -1) {
    if (index > cursor) parts.push({ text: content.slice(cursor, index), match: false })
    parts.push({ text: content.slice(index, index + needle.length), match: true })
    cursor = index + needle.length
    index = haystack.indexOf(normalizedNeedle, cursor)
  }
  if (cursor < content.length) parts.push({ text: content.slice(cursor), match: false })
  return parts.length ? parts : [{ text: content, match: false }]
})

function formatDateTime(timestamp) {
  const value = Number(timestamp)
  const date = new Date(value)
  if (!Number.isFinite(value) || Number.isNaN(date.getTime())) return '时间未知'

  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const dayDiff = Math.round((target.getTime() - today.getTime()) / 86400000)
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`

  if (dayDiff === 0) return `今天 ${clock}`
  if (dayDiff === 1) return `明天 ${clock}`
  if (dayDiff === -1) return `昨天 ${clock}`
  if (date.getFullYear() === now.getFullYear())
    return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
}

const effectiveTime = computed(() => formatDateTime(props.note.effective_at))
const effectiveIso = computed(() => {
  const date = new Date(props.note.effective_at)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
})

// 正文折叠与首页便签卡片使用相同的真实高度测量和像素高度动画。
const contentShellRef = ref(null)
const contentTextRef = ref(null)
const contentExpanded = ref(false)
const contentOverflows = ref(false)
const contentAnimating = ref(false)
const contentShellHeight = ref('1.46em')
const CONTENT_PREVIEW_LINES = 1
const CONTENT_ANIMATION_DURATION = 280
let contentResizeObserver = null
let contentAnimation = null

function measureContentOverflow() {
  const element = contentTextRef.value
  if (!element) return
  const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight)
  if (!Number.isFinite(lineHeight)) return
  const fullHeight = element.scrollHeight
  const collapsedHeight = Math.min(fullHeight, lineHeight * CONTENT_PREVIEW_LINES)
  contentOverflows.value = fullHeight > collapsedHeight + 1
  if (contentAnimating.value) return
  contentShellHeight.value = contentExpanded.value ? 'auto' : `${collapsedHeight}px`
}

function finishContentAnimation(animation) {
  if (contentAnimation !== animation) return
  contentAnimation = null
  contentAnimating.value = false
  contentShellHeight.value = contentExpanded.value ? 'auto' : contentShellHeight.value
  nextTick(measureContentOverflow)
}

async function toggleContent() {
  const shell = contentShellRef.value
  const element = contentTextRef.value
  if (!shell || !element || !contentOverflows.value || contentAnimating.value) return

  const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight)
  if (!Number.isFinite(lineHeight)) return
  const nextExpanded = !contentExpanded.value
  const targetHeight = nextExpanded
    ? element.scrollHeight
    : Math.min(element.scrollHeight, lineHeight * CONTENT_PREVIEW_LINES)
  const startHeight = shell.getBoundingClientRect().height
  const distance = Math.abs(targetHeight - startHeight)
  const duration = Math.min(420, CONTENT_ANIMATION_DURATION + distance * 0.24)

  contentAnimating.value = true
  contentExpanded.value = nextExpanded
  contentShellHeight.value = `${targetHeight}px`
  await nextTick()

  const animation = shell.animate(
    [{ height: `${startHeight}px` }, { height: `${targetHeight}px` }],
    { duration, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }
  )
  contentAnimation = animation
  animation.onfinish = () => finishContentAnimation(animation)
}

watch([displayContent, () => props.query], async () => {
  contentAnimation?.cancel()
  contentAnimation = null
  contentAnimating.value = false
  contentExpanded.value = false
  contentShellHeight.value = '1.46em'
  await nextTick()
  measureContentOverflow()
})

// 与首页便签卡片一致的右键菜单定位；搜索结果额外提供明确确认的彻底删除入口。
const contextMenuVisible = ref(false)
const contextMenuRef = ref(null)
const contextMenuStyle = ref({})
const deleting = ref(false)
const showPurgeDialog = ref(false)

function closeContextMenu() {
  contextMenuVisible.value = false
  document.removeEventListener('pointerdown', onContextMenuOutside)
  document.removeEventListener('keydown', onContextMenuKeydown)
  window.removeEventListener('resize', closeContextMenu)
  window.removeEventListener('scroll', closeContextMenu, true)
}

function onContextMenuOutside(event) {
  if (contextMenuRef.value?.contains(event.target)) return
  closeContextMenu()
}

function onContextMenuKeydown(event) {
  if (event.key === 'Escape') closeContextMenu()
}

async function openContextMenu(event) {
  event.preventDefault()
  closeContextMenu()
  contextMenuStyle.value = { left: `${event.clientX}px`, top: `${event.clientY}px` }
  contextMenuVisible.value = true
  await nextTick()

  const rect = contextMenuRef.value?.getBoundingClientRect()
  if (!rect) return
  const gap = 8
  contextMenuStyle.value = {
    left: `${Math.max(gap, Math.min(event.clientX, window.innerWidth - rect.width - gap))}px`,
    top: `${Math.max(gap, Math.min(event.clientY, window.innerHeight - rect.height - gap))}px`
  }
  document.addEventListener('pointerdown', onContextMenuOutside)
  document.addEventListener('keydown', onContextMenuKeydown)
  window.addEventListener('resize', closeContextMenu)
  window.addEventListener('scroll', closeContextMenu, true)
}

async function onContextMenuAction(action) {
  closeContextMenu()
  if (action === 'edit') {
    if (props.note.is_deleted) return
    emit('edit', props.note)
    return
  }
  if (action !== 'purge' || deleting.value) return
  showPurgeDialog.value = true
}

async function confirmPurge() {
  if (deleting.value) return
  deleting.value = true
  try {
    const deleted = await window.api.purgeNote(props.note.id)
    if (!deleted) throw new Error('便签不存在或已被彻底删除')
    showMessage('success', '便签已彻底删除')
    emit('deleted', props.note)
  } catch (error) {
    console.error('[SearchResultCard] 彻底删除便签失败:', props.note.id, error)
    showMessage('error', error.message || '彻底删除失败，请重试')
  } finally {
    deleting.value = false
  }
}

onMounted(async () => {
  await nextTick()
  measureContentOverflow()
  contentResizeObserver = new ResizeObserver(measureContentOverflow)
  if (contentTextRef.value) contentResizeObserver.observe(contentTextRef.value)
  document.fonts?.ready.then(measureContentOverflow)
})

onUnmounted(() => {
  contentResizeObserver?.disconnect()
  contentAnimation?.cancel()
  closeContextMenu()
})
</script>

<template>
  <article
    class="src-card"
    :class="[`src-card--${displayStatus}`, { 'src-card--deleted': note.is_deleted }]"
    :style="{ '--accent-color': status.color, '--note-text-color': noteTextColor }"
    :data-search-note-id="note.id"
    :aria-label="`${status.label}：${displayContent}`"
    @contextmenu="openContextMenu"
  >
    <StatusRing :status="displayStatus" :interactive="false" />

    <div class="src-body">
      <div
        ref="contentShellRef"
        class="src-content-shell"
        :class="{
          'src-content-shell--collapsed': contentOverflows && !contentExpanded && !contentAnimating,
          'src-content-shell--animating': contentAnimating
        }"
        :style="{ height: contentShellHeight }"
      >
        <p ref="contentTextRef" class="src-content">
          <template v-for="(part, index) in contentParts" :key="index">
            <mark v-if="part.match" class="src-highlight">{{ part.text }}</mark>
            <template v-else>{{ part.text }}</template>
          </template>
        </p>
      </div>

      <div class="src-meta">
        <div class="src-context">
          <span class="src-status" :class="{ 'src-status--deleted': note.is_deleted }">
            {{ status.label }}
          </span>
          <span class="src-separator" aria-hidden="true">·</span>
          <time class="src-time" :datetime="effectiveIso">生效 {{ effectiveTime }}</time>
        </div>
        <button
          v-if="contentOverflows"
          class="src-disclosure"
          type="button"
          :class="{ 'src-disclosure--expanded': contentExpanded }"
          :aria-expanded="contentExpanded"
          :aria-label="contentExpanded ? '收起正文' : '展开正文'"
          :title="contentExpanded ? '收起正文' : '展开正文'"
          @click.stop="toggleContent"
          @keydown.enter.stop
        >
          <svg viewBox="0 0 16 10" aria-hidden="true"><path d="m2 2 6 6 6-6" /></svg>
        </button>
      </div>
    </div>

    <Teleport to="body">
      <Transition name="src-context-menu">
        <div
          v-if="contextMenuVisible"
          ref="contextMenuRef"
          class="src-context-menu-shell"
          :style="contextMenuStyle"
          role="menu"
          aria-label="便签操作"
          @click.stop
          @contextmenu.prevent
        >
          <div class="src-context-menu">
            <button
              role="menuitem"
              :disabled="Boolean(note.is_deleted)"
              @click="onContextMenuAction('edit')"
            >
              修改
            </button>
            <div class="src-context-menu__divider" role="separator" />
            <button
              class="src-context-menu__delete"
              role="menuitem"
              :disabled="deleting"
              @click="onContextMenuAction('purge')"
            >
              彻底删除
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>

    <ConfirmDialog
      v-model:visible="showPurgeDialog"
      title="彻底删除便签？"
      message="该便签及其全部图片将被永久删除，删除后无法恢复。"
      confirm-text="彻底删除"
      cancel-text="取消"
      variant="danger"
      @confirm="confirmPurge"
    />
  </article>
</template>

<style scoped>
.src-card {
  --card-surface-opacity: 0.08;
  display: grid;
  grid-template-columns: 21rem minmax(0, 1fr);
  gap: 9rem;
  width: 100%;
  min-width: 0;
  padding: 12rem 14rem 11rem;
  overflow: visible;
  border: 1px solid var(--ui-border-divider);
  border-radius: 11rem;
  background: rgb(var(--bg-color) / var(--card-surface-opacity));
  color: var(--text-color);
  cursor: default;
  transition:
    border-color var(--motion-control) ease,
    background-color var(--motion-control) ease;
}
.src-card:hover {
  border-color: var(--ui-border-control);
}
.src-card--in_progress {
  --card-surface-opacity: 0.14;
}
.src-card--completed {
  --card-surface-opacity: 0.075;
}
.src-card :deep(.sr-control) {
  pointer-events: none;
}
.src-body {
  min-width: 0;
}
.src-content-shell {
  overflow: hidden;
}
.src-content-shell--collapsed .src-content {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
}
.src-content-shell--animating {
  will-change: height;
}
.src-content {
  margin: 0;
  color: color-mix(in srgb, var(--note-text-color) 92%, transparent);
  font-size: var(--fs-body);
  line-height: 1.46;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
  cursor: text;
}
.src-highlight {
  padding: 0 1rem;
  border-radius: 3rem;
  background: color-mix(in srgb, #ffcc00 24%, transparent);
  color: inherit;
}
.src-meta {
  display: flex;
  align-items: flex-end;
  gap: 8rem;
  min-width: 0;
  margin-top: 7rem;
  color: color-mix(in srgb, var(--text-color) 58%, transparent);
  font-size: calc(var(--fs-secondary) * 0.8);
  line-height: 1.25;
}
.src-context {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: 5rem;
  min-width: 0;
}
.src-status {
  flex-shrink: 0;
  font-weight: 500;
}
.src-status--deleted {
  color: #ff453a;
}
.src-time {
  min-width: 0;
}
.src-disclosure {
  display: grid;
  place-items: center;
  flex: 0 0 22rem;
  width: 22rem;
  height: 22rem;
  padding: 0;
  border: 0;
  border-radius: 7rem;
  background: transparent;
  color: color-mix(in srgb, var(--text-color) 48%, transparent);
  cursor: pointer;
  transition:
    color 160ms ease,
    background-color 160ms ease;
}
.src-disclosure svg {
  width: 10rem;
  height: 6rem;
  overflow: visible;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 220ms cubic-bezier(0.4, 0, 0.2, 1);
}
.src-disclosure--expanded svg {
  transform: rotate(180deg);
}
.src-disclosure:hover,
.src-disclosure:focus-visible {
  outline: none;
  background: var(--ui-fill-hover);
  color: color-mix(in srgb, var(--text-color) 82%, transparent);
}
.src-context-menu-shell {
  position: fixed;
  z-index: var(--z-global-popover);
  width: 128rem;
  overflow: hidden;
  border-radius: 10rem;
  box-shadow: 0 12rem 34rem rgba(0, 0, 0, 0.22);
}
.src-context-menu {
  display: grid;
  gap: 1rem;
  padding: 5rem;
  border: 1px solid var(--surface-float-border);
  border-radius: inherit;
  background-color: var(--surface-float);
}
.src-context-menu__divider {
  height: 1px;
  margin: 3rem 4rem;
  background: color-mix(in srgb, var(--text-color) 10%, transparent);
}
.src-context-menu button {
  width: 100%;
  padding: 7rem 9rem;
  border: 0;
  border-radius: 6rem;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  font-size: var(--fs-secondary);
  text-align: left;
  cursor: pointer;
  transition:
    background-color 140ms ease,
    color 140ms ease;
}
.src-context-menu button:hover:not(:disabled),
.src-context-menu button:focus-visible:not(:disabled) {
  outline: none;
  background: var(--ui-fill-hover);
}
.src-context-menu button:disabled {
  opacity: 0.38;
  cursor: default;
}
.src-context-menu .src-context-menu__delete {
  color: #ff453a;
}
.src-context-menu .src-context-menu__delete:hover:not(:disabled),
.src-context-menu .src-context-menu__delete:focus-visible:not(:disabled) {
  background: color-mix(in srgb, #ff453a 11%, transparent);
}
.src-context-menu-enter-active,
.src-context-menu-leave-active {
  transition:
    opacity 130ms ease,
    transform 180ms cubic-bezier(0.32, 0.72, 0, 1);
}
.src-context-menu-enter-from,
.src-context-menu-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}
</style>
