<script setup>
/**
 * NoteCard.vue — 便签列表项
 *
 * 左侧状态圆环既表达状态，也承担主要状态操作：
 * initialized → 提前开始；in_progress → 完成；completed → 重新进行。
 */
import { computed, ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import ImagePicker from '../note/ImagePicker.vue'
import ConfirmDialog from '../ui/ConfirmDialog.vue'
import StatusRing from './StatusRing.vue'
import { useMessage } from '../../composables/useMessage.js'
import { useSharedMinuteClock } from '../../composables/useSharedMinuteClock.js'

const props = defineProps({
  note: { type: Object, required: true },
  draggable: { type: Boolean, default: false },
  muted: { type: Boolean, default: false },
  statusTransition: { type: Object, default: null }
})

const emit = defineEmits(['status-action', 'edit'])
const { showMessage } = useMessage()
const sharedNow = useSharedMinuteClock()
const systemNotificationsSupported =
  window.api.runtimeCapabilities?.systemNotifications?.supported ?? true

const STATUS_META = {
  initialized: { label: '初始化', color: '#0A84FF', action: '提前开始' },
  in_progress: { label: '进行中', color: '#FF9F0A', action: '标记完成' },
  completed: { label: '已完成', color: '#30D158', action: '重新进行' }
}

const status = computed(() => STATUS_META[props.note.status] || STATUS_META.initialized)
const isTerminal = computed(() => props.note.status === 'completed')
const canChangeStatus = computed(() =>
  ['initialized', 'in_progress', 'completed'].includes(props.note.status)
)
const showReminder = computed(
  () =>
    systemNotificationsSupported &&
    props.note.status === 'initialized' &&
    Number(props.note.notify_enabled) === 1
)

const tags = computed(() => (Array.isArray(props.note.tags) ? props.note.tags : []))
const visibleTags = computed(() => tags.value.slice(0, 2))
const hiddenTagCount = computed(() => Math.max(0, tags.value.length - 2))
const attachmentCount = computed(() => Number(props.note.attachment_count) || 0)
const imagesExpanded = ref(false)
const imagesMounted = ref(false)
const tagsExpanded = ref(false)
const moreTagsButtonRef = ref(null)
const tagPopoverStyle = ref({})
const contextMenuVisible = ref(false)
const contextMenuRef = ref(null)
const contextMenuStyle = ref({})
const contentShellRef = ref(null)
const contentTextRef = ref(null)
const contentExpanded = ref(false)
const contentOverflows = ref(false)
const contentAnimating = ref(false)
const contentShellHeight = ref('auto')
const deleting = ref(false)
const creatingSticky = ref(false)
const showDeleteDialog = ref(false)
const CONTENT_PREVIEW_LINES = 3
// 产品规范：交互动画始终开启，不跟随系统 MinAnimate / reduced-motion 设置。
const CONTENT_ANIMATION_DURATION = 280
let contentResizeObserver = null
let contentAnimation = null

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
  document.removeEventListener('pointerdown', onTagPopoverOutside)
  document.removeEventListener('keydown', onTagPopoverKeydown)
  window.removeEventListener('resize', closeTags)
  window.removeEventListener('scroll', closeTags, true)
  closeContextMenu()
})

const displayContent = computed(() => {
  const text = String(props.note.content || '')
  if (text.trim()) return text
  return attachmentCount.value > 0 ? '图片便签' : '空白便签'
})

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
    {
      duration,
      easing: 'cubic-bezier(0.4, 0, 0.2, 1)'
    }
  )
  contentAnimation = animation
  animation.onfinish = () => finishContentAnimation(animation)
}

watch(displayContent, async () => {
  contentAnimation?.cancel()
  contentAnimation = null
  contentAnimating.value = false
  contentExpanded.value = false
  contentShellHeight.value = 'auto'
  await nextTick()
  measureContentOverflow()
})

function formatDateTime(timestamp) {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''

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
const finishedTime = computed(() => formatDateTime(props.note.finished_at))
const finishedLabel = '完成'
const effectiveDisplay = computed(() => {
  if (props.note.status !== 'initialized') return `生效 ${effectiveTime.value}`
  const timestamp = Number(props.note.effective_at)
  const diff = timestamp - sharedNow.value
  if (!Number.isFinite(diff) || diff <= 0) return '即将生效'

  const target = new Date(timestamp)
  const now = new Date(sharedNow.value)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate())
  const dayDiff = Math.round((targetDay.getTime() - today.getTime()) / 86_400_000)
  const minutes = Math.ceil(diff / 60_000)
  const clock = `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`

  if (minutes < 60) return `${minutes}分钟后生效`
  if (dayDiff === 0) return `今天 ${clock} 生效`
  if (dayDiff === 1) return `明天 ${clock} 生效`
  if (dayDiff === 2) return `后天 ${clock} 生效`
  if (dayDiff === 3) return `3天后 ${clock} 生效`

  const dateLabel =
    target.getFullYear() === now.getFullYear()
      ? `${target.getMonth() + 1}月${target.getDate()}日`
      : `${target.getFullYear()}年${target.getMonth() + 1}月${target.getDate()}日`
  return `${dateLabel} (${dayDiff}天后) 生效`
})

function handleStatusAction() {
  if (canChangeStatus.value) emit('status-action', props.note)
}

function toggleImages() {
  if (attachmentCount.value <= 0) return
  imagesExpanded.value = !imagesExpanded.value
  if (imagesExpanded.value) imagesMounted.value = true
}

function closeTags() {
  tagsExpanded.value = false
  document.removeEventListener('pointerdown', onTagPopoverOutside)
  document.removeEventListener('keydown', onTagPopoverKeydown)
  window.removeEventListener('resize', closeTags)
  window.removeEventListener('scroll', closeTags, true)
}

function onTagPopoverKeydown(event) {
  if (event.key === 'Escape') closeTags()
}

function onTagPopoverOutside(event) {
  if (event.target.closest?.('.nl-tag-popover') || moreTagsButtonRef.value?.contains(event.target))
    return
  closeTags()
}

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
  closeTags()
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

/** 修改打开现有编辑器；桌面展示和删除均通过受限主进程能力完成。 */
async function onContextMenuAction(action) {
  closeContextMenu()
  if (action === 'edit') emit('edit', props.note)
  if (action === 'sticky') {
    if (creatingSticky.value) return
    creatingSticky.value = true
    try {
      const result = await window.api.createSticky(props.note.id)
      if (!result?.ok) {
        const message = result?.message || '无法贴到桌面'
        showMessage(message.includes('最多同时展示') ? 'warning' : 'error', message)
        return
      }
      showMessage('success', '已贴到桌面')
    } catch (error) {
      console.error('[NoteCard] 创建便利贴失败:', props.note.id, error)
      showMessage('error', error.message || '无法贴到桌面')
    } finally {
      creatingSticky.value = false
    }
    return
  }
  if (action !== 'delete' || deleting.value) return
  showDeleteDialog.value = true
}

async function confirmDelete() {
  if (deleting.value) return
  deleting.value = true
  try {
    const deleted = await window.api.deleteNote(props.note.id)
    if (!deleted) throw new Error('便签不存在或已被删除')
    showMessage('success', '便签已删除')
  } catch (error) {
    console.error('[NoteCard] 删除便签失败:', props.note.id, error)
    showMessage('error', error.message || '删除失败，请重试')
  } finally {
    deleting.value = false
  }
}

async function copyContent() {
  const text = String(props.note.content || '')
  if (!text.trim()) return
  try {
    await navigator.clipboard.writeText(text)
    showMessage('success', '便签正文已复制')
  } catch (error) {
    console.error('[NoteCard] 复制便签失败:', props.note.id, error)
    showMessage('error', '复制失败，请重试')
  }
}

async function toggleTags() {
  if (tagsExpanded.value) {
    closeTags()
    return
  }
  closeContextMenu()
  const rect = moreTagsButtonRef.value?.getBoundingClientRect()
  if (!rect) return
  const horizontal = { right: `${Math.max(8, window.innerWidth - rect.right)}px` }
  tagPopoverStyle.value =
    window.innerHeight - rect.bottom >= 150
      ? { ...horizontal, top: `${rect.bottom + 6}px` }
      : { ...horizontal, bottom: `${window.innerHeight - rect.top + 6}px` }
  tagsExpanded.value = true
  await nextTick()
  document.addEventListener('pointerdown', onTagPopoverOutside)
  document.addEventListener('keydown', onTagPopoverKeydown)
  window.addEventListener('resize', closeTags)
  window.addEventListener('scroll', closeTags, true)
}
</script>

<template>
  <article
    class="nl-card"
    :class="[
      `nl-card--${note.status}`,
      {
        'nl-card--draggable': draggable,
        'nl-card--muted': muted,
        'nl-card--empty': !String(note.content || '').trim(),
        'nl-card--status-playing': statusTransition?.phase === 'playing'
      },
      statusTransition && `nl-card--${statusTransition.from}-to-${statusTransition.to}`
    ]"
    :style="{ '--accent-color': status.color }"
    :data-note-id="note.id"
    :aria-label="`${status.label}：${displayContent}`"
    @contextmenu="openContextMenu"
  >
    <span v-if="draggable" class="nl-drag-handle" title="拖动排序" aria-hidden="true" @click.stop>
      <svg viewBox="0 0 12 18">
        <circle cx="3" cy="3" r="1.25" />
        <circle cx="9" cy="3" r="1.25" />
        <circle cx="3" cy="9" r="1.25" />
        <circle cx="9" cy="9" r="1.25" />
        <circle cx="3" cy="15" r="1.25" />
        <circle cx="9" cy="15" r="1.25" />
      </svg>
    </span>

    <StatusRing
      :status="note.status"
      :transition-state="statusTransition"
      @activate="handleStatusAction"
    />

    <div class="nl-card-body">
      <div
        ref="contentShellRef"
        class="nl-card-text-shell"
        :class="{
          'nl-card-text-shell--collapsed':
            contentOverflows && !contentExpanded && !contentAnimating,
          'nl-card-text-shell--animating': contentAnimating
        }"
        :style="{ height: contentShellHeight }"
      >
        <p ref="contentTextRef" class="nl-card-text">{{ displayContent }}</p>
      </div>
      <div class="nl-card-meta">
        <div class="nl-card-context">
          <span class="nl-card-status">{{ status.label }}</span>
          <span class="nl-card-separator" aria-hidden="true">·</span>
          <time class="nl-card-time" :datetime="effectiveIso">{{ effectiveDisplay }}</time>
          <template v-if="isTerminal && finishedTime">
            <span class="nl-card-separator" aria-hidden="true">·</span>
            <time class="nl-card-time nl-card-time--finished"
              >{{ finishedLabel }} {{ finishedTime }}</time
            >
          </template>
        </div>

        <div
          v-if="
            visibleTags.length ||
            hiddenTagCount ||
            showReminder ||
            attachmentCount ||
            contentOverflows ||
            String(note.content || '').trim()
          "
          class="nl-card-utilities"
        >
          <span
            v-for="tag in visibleTags"
            :key="tag.id || tag.name"
            class="nl-card-tag"
            :style="tag.color ? { '--tag-color': tag.color } : {}"
            >{{ tag.name }}</span
          >
          <button
            v-if="hiddenTagCount"
            ref="moreTagsButtonRef"
            class="nl-card-more-tags"
            :aria-expanded="tagsExpanded"
            aria-label="显示全部标签"
            @click.stop="toggleTags"
          >
            +{{ hiddenTagCount }}
          </button>

          <span
            v-if="showReminder"
            class="nl-card-icon"
            title="等待系统提醒"
            aria-label="等待系统提醒"
          >
            <svg
              viewBox="0 0 20 20"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            >
              <path
                d="M5.6 8.2a4.4 4.4 0 0 1 8.8 0c0 4.3 1.8 4.6 1.8 5.7H3.8c0-1.1 1.8-1.4 1.8-5.7Z"
              />
              <path d="M8.2 16a2 2 0 0 0 3.6 0" />
            </svg>
          </span>

          <button
            v-if="String(note.content || '').trim()"
            class="nl-card-copy"
            type="button"
            title="复制正文"
            aria-label="复制便签正文"
            @click.stop="copyContent"
          >
            <svg
              viewBox="0 0 20 20"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            >
              <rect x="7" y="6" width="9" height="10" rx="2" />
              <path d="M13 6V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
            </svg>
          </button>

          <button
            v-if="attachmentCount"
            class="nl-card-attachment"
            title="展开图片附件"
            :aria-expanded="imagesExpanded"
            @click.stop="toggleImages"
          >
            <svg
              viewBox="0 0 20 20"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            >
              <rect x="3" y="4" width="14" height="12" rx="2" />
              <circle cx="7" cy="8" r="1.2" />
              <path d="m5 14 3.2-3 2.2 2 1.8-1.6L15 14" />
            </svg>
            <span>{{ attachmentCount }}</span>
          </button>

          <button
            v-if="contentOverflows"
            class="nl-card-disclosure"
            type="button"
            :class="{ 'nl-card-disclosure--expanded': contentExpanded }"
            :aria-expanded="contentExpanded"
            :aria-label="contentExpanded ? '收起正文' : '展开正文'"
            :title="contentExpanded ? '收起正文' : '展开正文'"
            @click.stop="toggleContent"
            @keydown.enter.stop
          >
            <svg viewBox="0 0 16 10" aria-hidden="true">
              <path d="m2 2 6 6 6-6" />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <Transition name="nl-tag-popover">
        <div
          v-if="tagsExpanded"
          class="nl-tag-popover-shell"
          :style="tagPopoverStyle"
          role="dialog"
          aria-label="全部标签"
          @click.stop
        >
          <div class="nl-tag-popover">
            <span
              v-for="tag in tags"
              :key="tag.id || tag.name"
              class="nl-tag-popover__tag"
              :style="tag.color ? { '--tag-color': tag.color } : {}"
              >{{ tag.name }}</span
            >
          </div>
        </div>
      </Transition>
    </Teleport>

    <Teleport to="body">
      <Transition name="nl-context-menu">
        <div
          v-if="contextMenuVisible"
          ref="contextMenuRef"
          class="nl-context-menu-shell"
          :style="contextMenuStyle"
          role="menu"
          aria-label="便签操作"
          @click.stop
          @contextmenu.prevent
        >
          <div class="nl-context-menu">
            <button role="menuitem" @click="onContextMenuAction('edit')">修改</button>
            <button
              role="menuitem"
              :disabled="creatingSticky"
              @click="onContextMenuAction('sticky')"
            >
              {{ creatingSticky ? '正在创建…' : '贴到桌面' }}
            </button>
            <div class="nl-context-menu__divider" role="separator" />
            <button
              class="nl-context-menu__delete"
              role="menuitem"
              :disabled="deleting"
              @click="onContextMenuAction('delete')"
            >
              删除
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>

    <ConfirmDialog
      v-model:visible="showDeleteDialog"
      title="删除便签？"
      message="便签会从列表中移除，但正文和图片仍会保留，可在搜索中启用“包含已删除”查看。"
      confirm-text="删除"
      cancel-text="取消"
      variant="danger"
      @confirm="confirmDelete"
    />

    <div
      v-if="attachmentCount"
      class="nl-image-panel-shell"
      :class="{ 'nl-image-panel-shell--expanded': imagesExpanded }"
      @click.stop
    >
      <div class="nl-image-panel-clip">
        <div class="nl-image-panel-content">
          <ImagePicker v-if="imagesMounted" :note-id="note.id" mode="persist" readonly />
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
.nl-card {
  --card-surface-opacity: 0.08;
  --card-surface-hover-opacity: 0.12;
  --content-strength: 100%;
  position: relative;
  isolation: isolate;
  display: grid;
  grid-template-columns: 21rem minmax(0, 1fr);
  gap: 9rem;
  min-width: 0;
  margin: 0 0 5rem;
  padding: 12rem 14rem 11rem;
  overflow: visible;
  border: 1px solid color-mix(in srgb, var(--text-color) 7%, transparent);
  border-radius: 11rem;
  outline: none;
  background: rgb(var(--bg-color) / var(--card-surface-opacity));
  cursor: default;
  transition:
    background-color 180ms cubic-bezier(0.22, 1, 0.36, 1),
    border-color 180ms cubic-bezier(0.22, 1, 0.36, 1),
    box-shadow 180ms cubic-bezier(0.22, 1, 0.36, 1),
    transform 100ms ease;
}

/* 状态成功后由左向右扫过一次；只使用合成层属性，不改变卡片布局。 */
.nl-card::before {
  content: '';
  position: absolute;
  z-index: 3;
  inset: 0;
  border-radius: 0;
  clip-path: inset(0 round 11rem);
  pointer-events: none;
  opacity: 0;
  transform: scaleX(0);
  transform-origin: left center;
  background:
    radial-gradient(
      ellipse 15% 94% at 100% 50%,
      color-mix(in srgb, #fff 14%, transparent) 0%,
      color-mix(in srgb, var(--status-sweep-color) 16%, transparent) 28%,
      color-mix(in srgb, var(--status-sweep-color) 8%, transparent) 58%,
      transparent 100%
    ),
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--status-sweep-color) 2.5%, transparent) 0%,
      color-mix(in srgb, var(--status-sweep-color) 4%, transparent) 34%,
      color-mix(in srgb, var(--status-sweep-color) 6.5%, transparent) 68%,
      color-mix(in srgb, var(--status-sweep-color) 10%, transparent) 90%,
      color-mix(in srgb, var(--status-sweep-color) 14%, transparent) 100%
    );
}
.nl-card--status-playing::before {
  will-change: transform, opacity;
}
.nl-card--status-playing.nl-card--initialized-to-in_progress {
  --status-sweep-color: #ff9f0a;
}
.nl-card--status-playing.nl-card--in_progress-to-completed {
  --status-sweep-color: #30d158;
}
.nl-card--status-playing.nl-card--completed-to-in_progress {
  --status-sweep-color: #ff9f0a;
}
.nl-card--status-playing.nl-card--initialized-to-in_progress::before {
  animation:
    nl-status-sweep-motion 1000ms cubic-bezier(0.55, 0, 0.45, 1) both,
    nl-status-sweep-opacity-start 1000ms linear both;
}
.nl-card--status-playing.nl-card--in_progress-to-completed::before {
  animation:
    nl-status-sweep-motion 1000ms cubic-bezier(0.55, 0, 0.45, 1) both,
    nl-status-sweep-opacity-complete 1000ms linear both;
}
.nl-card--status-playing.nl-card--completed-to-in_progress::before {
  animation:
    nl-status-sweep-motion 1000ms cubic-bezier(0.55, 0, 0.45, 1) both,
    nl-status-sweep-opacity-start 1000ms linear both;
}

.nl-card:hover {
  border-color: color-mix(in srgb, var(--text-color) 12%, transparent);
  background: rgb(var(--bg-color) / var(--card-surface-hover-opacity));
  box-shadow: 0 5rem 18rem rgba(0, 0, 0, 0.05);
}

@keyframes nl-status-sweep-motion {
  0% {
    transform: scaleX(0.02);
  }
  90%,
  100% {
    transform: scaleX(1);
  }
}

@keyframes nl-status-sweep-opacity-start {
  0% {
    opacity: 0;
  }
  14%,
  92% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

@keyframes nl-status-sweep-opacity-complete {
  0% {
    opacity: 0;
  }
  12%,
  92% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

.nl-card--completed::after {
  content: '';
  position: absolute;
  z-index: 4;
  inset: 0;
  pointer-events: none;
  border-radius: inherit;
  background: rgba(128, 128, 128, 0.1);
  transition: background-color 180ms ease;
}
.nl-card--completed:hover::after {
  background: rgba(128, 128, 128, 0.075);
}

.nl-card--initialized {
  --card-surface-opacity: 0.08;
  --card-surface-hover-opacity: 0.12;
}
.nl-card--in_progress {
  --card-surface-opacity: 0.14;
  --card-surface-hover-opacity: 0.18;
}
.nl-card--completed {
  --card-surface-opacity: 0.075;
  --card-surface-hover-opacity: 0.095;
  --content-strength: 60%;
}
.nl-card--muted {
  opacity: 0.66;
}

.nl-drag-handle {
  position: absolute;
  z-index: 6;
  top: 9rem;
  right: 8rem;
  display: grid;
  place-items: center;
  width: 22rem;
  height: 24rem;
  border-radius: 7rem;
  background: rgb(var(--bg-color) / 0.76);
  color: var(--text-color-secondary);
  cursor: grab;
  opacity: 0;
  pointer-events: none;
  touch-action: none;
  box-shadow: 0 2rem 8rem rgba(0, 0, 0, 0.06);
  backdrop-filter: blur(10px);
  transition:
    opacity 140ms ease,
    color 140ms ease,
    background-color 140ms ease;
}
.nl-drag-handle svg {
  width: 9rem;
  height: 14rem;
  fill: currentColor;
}
.nl-card--draggable:hover .nl-drag-handle,
.nl-card--draggable:focus-within .nl-drag-handle {
  opacity: 0.58;
  pointer-events: auto;
}
.nl-card--draggable .nl-drag-handle:hover {
  background: rgb(var(--bg-color) / 0.9);
  color: var(--text-color);
  opacity: 0.9;
}
.nl-card--draggable .nl-drag-handle:active {
  cursor: grabbing;
  opacity: 1;
}

/* 终结态降低内部信息层，而不是继续压暗卡片表面。 */
.nl-card--completed .nl-card-body {
  opacity: 0.62;
}
.nl-card--completed :deep(.sr-control) {
  opacity: 0.68;
}
.nl-card--completed .nl-image-panel-shell {
  opacity: 0;
}
.nl-card--completed .nl-image-panel-shell--expanded {
  opacity: 0.7;
}
.nl-card--completed:hover .nl-card-body {
  opacity: 0.67;
}
.nl-card--completed:hover :deep(.sr-control) {
  opacity: 0.72;
}
.nl-card--completed:hover .nl-image-panel-shell--expanded {
  opacity: 0.74;
}

.nl-card-body {
  position: relative;
  z-index: 1;
  min-width: 0;
  transition: opacity 180ms ease;
}
.nl-card-text {
  margin: 0;
  color: color-mix(in srgb, var(--text-color) var(--content-strength), transparent);
  font-size: var(--fs-body);
  font-weight: 500;
  line-height: 1.45;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  user-select: text;
  cursor: text;
}
.nl-card-text-shell {
  overflow: hidden;
}
.nl-card-text-shell--collapsed .nl-card-text {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
.nl-card-text-shell--animating {
  will-change: height;
}
.nl-card-disclosure {
  display: grid;
  place-items: center;
  flex: 0 0 22rem;
  width: 22rem;
  height: 18rem;
  margin-left: 1rem;
  padding: 0;
  border: 0;
  border-radius: 980px;
  outline: none;
  background: transparent;
  color: color-mix(in srgb, var(--text-color-secondary) 72%, transparent);
  cursor: pointer;
  transition:
    color 160ms ease,
    background-color 160ms ease;
}
.nl-card-disclosure svg {
  display: block;
  width: 10rem;
  height: 6rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.6;
  transition: transform 220ms cubic-bezier(0.4, 0, 0.2, 1);
}
.nl-card-disclosure--expanded svg {
  transform: rotate(180deg);
}
.nl-card-disclosure:hover,
.nl-card-disclosure:focus-visible {
  background: color-mix(in srgb, var(--text-color) 7%, transparent);
  color: color-mix(in srgb, var(--text-color) 82%, transparent);
}
.nl-card-disclosure:focus-visible {
  box-shadow: 0 0 0 2rem color-mix(in srgb, var(--accent-color) 22%, transparent);
}
.nl-card--completed .nl-card-text {
  font-weight: 400;
}
.nl-card--empty .nl-card-text {
  color: var(--text-color-secondary);
  font-weight: 400;
}

.nl-card-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 9rem;
  min-width: 0;
  margin-top: 8rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.8);
  line-height: 1.25;
}
.nl-card-context {
  display: flex;
  flex: 1 0 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 4rem;
  width: max-content;
  max-width: 100%;
  min-width: 0;
}
.nl-card-status {
  flex-shrink: 0;
  color: color-mix(in srgb, var(--text-color) 58%, transparent);
  font-weight: 500;
}
.nl-card-separator {
  opacity: 0.44;
}
.nl-card-time {
  white-space: nowrap;
}
.nl-card-time--finished {
  color: color-mix(in srgb, var(--text-color) 58%, transparent);
}
.nl-card-utilities,
.nl-card-copy,
.nl-card-attachment {
  display: flex;
  align-items: center;
}
.nl-card-utilities {
  flex: 1 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 5rem;
  width: max-content;
  max-width: 100%;
  min-width: 0;
}
.nl-card-tag,
.nl-card-more-tags {
  max-width: min(140rem, 42vw);
  padding: 2rem 6rem;
  overflow: hidden;
  border-radius: 5rem;
  background: color-mix(in srgb, var(--tag-color, var(--text-color)) 9%, transparent);
  color: color-mix(in srgb, var(--tag-color, var(--text-color)) 68%, var(--text-color-secondary));
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nl-card-more-tags {
  flex-shrink: 0;
  background: transparent;
  color: var(--text-color-secondary);
}
.nl-card-more-tags {
  appearance: none;
  border: 0;
  font: inherit;
  cursor: pointer;
  transition:
    color 140ms ease,
    background-color 140ms ease;
}
.nl-card-more-tags:hover,
.nl-card-more-tags[aria-expanded='true'] {
  background: color-mix(in srgb, var(--text-color) 7%, transparent);
  color: var(--text-color);
}
.nl-card-icon,
.nl-card-copy,
.nl-card-attachment {
  appearance: none;
  gap: 2rem;
  padding: 2rem 3rem;
  border: 0;
  border-radius: 4rem;
  background: transparent;
  font: inherit;
  flex-shrink: 0;
  color: color-mix(in srgb, var(--text-color) 45%, transparent);
  cursor: pointer;
  transition:
    color 140ms ease,
    background-color 140ms ease;
}
.nl-card-copy:hover,
.nl-card-attachment:hover,
.nl-card-attachment[aria-expanded='true'] {
  color: var(--text-color);
  background: color-mix(in srgb, var(--text-color) 7%, transparent);
}
.nl-card-icon svg,
.nl-card-copy svg,
.nl-card-attachment svg {
  display: block;
}

.nl-image-panel-shell {
  position: relative;
  z-index: 1;
  display: grid;
  grid-column: 1 / -1;
  grid-template-rows: 0fr;
  opacity: 0;
  transition:
    grid-template-rows 240ms cubic-bezier(0.32, 0.72, 0, 1),
    opacity 180ms ease;
}
.nl-image-panel-shell--expanded {
  grid-template-rows: 1fr;
  opacity: 1;
}
.nl-image-panel-clip {
  min-height: 0;
  overflow: hidden;
}
.nl-image-panel-content {
  max-height: 240rem;
  margin-top: 10rem;
  padding: 10rem 0 2rem;
  overflow-y: auto;
  border-top: 1px solid color-mix(in srgb, var(--text-color) 7%, transparent);
}

.nl-tag-popover-shell {
  position: fixed;
  z-index: 10000;
  width: max-content;
  max-width: min(260px, calc(100vw - 16px));
  border-radius: 10rem;
  box-shadow: 0 12rem 34rem rgba(0, 0, 0, 0.2);
  overflow: hidden;
}
.nl-tag-popover {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6rem;
  width: 100%;
  max-width: inherit;
  max-height: min(220px, calc(100vh - 24px));
  padding: 10rem;
  overflow-y: auto;
  background-color: var(--surface-float);
  border: 1px solid var(--surface-float-border);
  border-radius: 10rem;
}
.nl-tag-popover__tag {
  max-width: 180px;
  padding: 3rem 7rem;
  overflow: hidden;
  border-radius: 6rem;
  background: color-mix(in srgb, var(--tag-color, var(--text-color)) 11%, transparent);
  color: color-mix(in srgb, var(--tag-color, var(--text-color)) 72%, var(--text-color-secondary));
  font-size: calc(var(--fs-secondary) * 0.82);
  line-height: 1.3;
  overflow-wrap: anywhere;
}
.nl-tag-popover-enter-active,
.nl-tag-popover-leave-active {
  transition:
    opacity 150ms ease,
    transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
.nl-tag-popover-enter-from,
.nl-tag-popover-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}

.nl-context-menu-shell {
  position: fixed;
  z-index: 10001;
  width: 128rem;
  border-radius: 10rem;
  box-shadow: 0 12rem 34rem rgba(0, 0, 0, 0.22);
  overflow: hidden;
}
.nl-context-menu {
  display: grid;
  gap: 1rem;
  padding: 5rem;
  border: 1px solid var(--surface-float-border);
  border-radius: inherit;
  background-color: var(--surface-float);
}
.nl-context-menu__divider {
  height: 1px;
  margin: 3rem 4rem;
  background: color-mix(in srgb, var(--text-color) 10%, transparent);
}
.nl-context-menu button {
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
.nl-context-menu button:hover:not(:disabled),
.nl-context-menu button:focus-visible:not(:disabled) {
  outline: none;
  background: color-mix(in srgb, var(--text-color) 8%, transparent);
}
.nl-context-menu button:disabled {
  opacity: 0.38;
  cursor: default;
}
.nl-context-menu .nl-context-menu__delete {
  color: #ff453a;
}
.nl-context-menu .nl-context-menu__delete:hover,
.nl-context-menu .nl-context-menu__delete:focus-visible {
  background: color-mix(in srgb, #ff453a 11%, transparent);
}
.nl-context-menu-enter-active,
.nl-context-menu-leave-active {
  transition:
    opacity 130ms ease,
    transform 180ms cubic-bezier(0.32, 0.72, 0, 1);
}
.nl-context-menu-enter-from,
.nl-context-menu-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}

@media (max-width: 390px) {
  .nl-card-tag {
    max-width: 86rem;
  }
}
</style>
