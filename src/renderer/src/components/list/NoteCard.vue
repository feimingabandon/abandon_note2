<script setup>
/**
 * NoteCard.vue — 便签列表项
 *
 * 左侧状态圆环既表达状态，也承担主要状态操作：
 * initialized → 提前开始；in_progress → 完成。
 */
import { computed, ref, onMounted, onUnmounted, nextTick } from 'vue'
import ImagePicker from '../note/ImagePicker.vue'

// 所有卡片共享一个分钟时钟，避免每张卡片各自创建定时器。
const sharedNow = ref(Date.now())
let sharedClockTimer = null
let sharedClockUsers = 0

function syncSharedClock() {
  sharedNow.value = Date.now()
}

function startSharedClock() {
  sharedClockUsers++
  syncSharedClock()
  if (sharedClockTimer) return
  const delay = 60_000 - (Date.now() % 60_000) + 20
  sharedClockTimer = setTimeout(function tick() {
    syncSharedClock()
    sharedClockTimer = setTimeout(tick, 60_000)
  }, delay)
  document.addEventListener('visibilitychange', syncSharedClock)
}

function stopSharedClock() {
  sharedClockUsers = Math.max(0, sharedClockUsers - 1)
  if (sharedClockUsers || !sharedClockTimer) return
  clearTimeout(sharedClockTimer)
  sharedClockTimer = null
  document.removeEventListener('visibilitychange', syncSharedClock)
}

const props = defineProps({
  note: { type: Object, required: true },
  draggable: { type: Boolean, default: false },
  muted: { type: Boolean, default: false },
  animationDelay: { type: String, default: '0ms' }
})

const emit = defineEmits(['select', 'status-action'])

const STATUS_META = {
  initialized: { label: '初始化', color: '#0A84FF', action: '提前开始' },
  in_progress: { label: '进行中', color: '#FF9F0A', action: '标记完成' },
  completed: { label: '已完成', color: '#30D158', action: '' },
  cancelled: { label: '已取消', color: '#8E8E93', action: '' }
}

const status = computed(() => STATUS_META[props.note.status] || STATUS_META.cancelled)
const isTerminal = computed(() => ['completed', 'cancelled'].includes(props.note.status))
const canChangeStatus = computed(() => ['initialized', 'in_progress'].includes(props.note.status))
const showReminder = computed(
  () => props.note.status === 'initialized' && Number(props.note.notify_enabled) === 1
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

onMounted(startSharedClock)

onUnmounted(() => {
  stopSharedClock()
  document.removeEventListener('pointerdown', onTagPopoverOutside)
  document.removeEventListener('keydown', onTagPopoverKeydown)
  window.removeEventListener('resize', closeTags)
  window.removeEventListener('scroll', closeTags, true)
})

const displayContent = computed(() => {
  const text = String(props.note.content || '').trim()
  if (text) return text
  return attachmentCount.value > 0 ? '图片便签' : '空白便签'
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
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
}

const effectiveTime = computed(() => formatDateTime(props.note.effective_at))
const effectiveIso = computed(() => {
  const date = new Date(props.note.effective_at)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
})
const finishedTime = computed(() => formatDateTime(props.note.finished_at))
const finishedLabel = computed(() => (props.note.status === 'completed' ? '完成' : '取消'))
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

  const dateLabel = target.getFullYear() === now.getFullYear()
    ? `${target.getMonth() + 1}月${target.getDate()}日`
    : `${target.getFullYear()}年${target.getMonth() + 1}月${target.getDate()}日`
  return `${dateLabel} (${dayDiff}天后) 生效`
})

function selectCard() {
  emit('select', props.note)
}

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
  if (event.target.closest?.('.nl-tag-popover') || moreTagsButtonRef.value?.contains(event.target)) return
  closeTags()
}

async function toggleTags() {
  if (tagsExpanded.value) {
    closeTags()
    return
  }
  const rect = moreTagsButtonRef.value?.getBoundingClientRect()
  if (!rect) return
  const horizontal = { right: `${Math.max(8, window.innerWidth - rect.right)}px` }
  tagPopoverStyle.value = window.innerHeight - rect.bottom >= 150
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
    class="nl-card nl-card-anim"
    :class="[
      `nl-card--${note.status}`,
      {
        'nl-card--draggable': draggable,
        'nl-card--muted': muted,
        'nl-card--empty': !String(note.content || '').trim()
      }
    ]"
    :style="{ animationDelay, '--accent-color': status.color }"
    :data-note-id="note.id"
    tabindex="0"
    :aria-label="`${status.label}：${displayContent}`"
    @click="selectCard"
    @keydown.enter="selectCard"
  >
    <span v-if="draggable" class="nl-handle" aria-hidden="true">
      <svg viewBox="0 0 12 18" width="10" height="15">
        <circle cx="3" cy="3" r="1.25" /><circle cx="9" cy="3" r="1.25" />
        <circle cx="3" cy="9" r="1.25" /><circle cx="9" cy="9" r="1.25" />
        <circle cx="3" cy="15" r="1.25" /><circle cx="9" cy="15" r="1.25" />
      </svg>
    </span>

    <button
      class="nl-status-control"
      :class="{ 'nl-status-control--actionable': canChangeStatus }"
      :disabled="!canChangeStatus"
      :title="status.action || status.label"
      :aria-label="status.action || status.label"
      @click.stop="handleStatusAction"
    >
      <svg v-if="note.status === 'completed'" viewBox="0 0 20 20" aria-hidden="true">
        <path d="m5.2 10.2 3.1 3.1 6.6-7" />
      </svg>
      <svg v-else-if="note.status === 'cancelled'" viewBox="0 0 20 20" aria-hidden="true">
        <path d="m6.2 6.2 7.6 7.6M13.8 6.2l-7.6 7.6" />
      </svg>
      <svg v-else class="nl-status-hover-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path v-if="note.status === 'initialized'" d="m8 6 5 4-5 4Z" />
        <path v-else d="m5.2 10.2 3.1 3.1 6.6-7" />
      </svg>
    </button>

    <div class="nl-card-body">
      <p class="nl-card-text">{{ displayContent }}</p>

      <div class="nl-card-meta">
        <div class="nl-card-context">
          <span class="nl-card-status">{{ status.label }}</span>
          <span class="nl-card-separator" aria-hidden="true">·</span>
          <time class="nl-card-time" :datetime="effectiveIso">{{ effectiveDisplay }}</time>
          <template v-if="isTerminal && finishedTime">
            <span class="nl-card-separator" aria-hidden="true">·</span>
            <time class="nl-card-time nl-card-time--finished">{{ finishedLabel }} {{ finishedTime }}</time>
          </template>
        </div>

        <div
          v-if="visibleTags.length || hiddenTagCount || showReminder || attachmentCount"
          class="nl-card-utilities"
        >
          <span
            v-for="tag in visibleTags"
            :key="tag.id || tag.name"
            class="nl-card-tag"
            :style="tag.color ? { '--tag-color': tag.color } : {}"
          >{{ tag.name }}</span>
          <button
            v-if="hiddenTagCount"
            ref="moreTagsButtonRef"
            class="nl-card-more-tags"
            :aria-expanded="tagsExpanded"
            aria-label="显示全部标签"
            @click.stop="toggleTags"
          >+{{ hiddenTagCount }}</button>

          <span v-if="showReminder" class="nl-card-icon" title="等待系统提醒" aria-label="等待系统提醒">
            <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M5.6 8.2a4.4 4.4 0 0 1 8.8 0c0 4.3 1.8 4.6 1.8 5.7H3.8c0-1.1 1.8-1.4 1.8-5.7Z" />
              <path d="M8.2 16a2 2 0 0 0 3.6 0" />
            </svg>
          </span>

          <button
            v-if="attachmentCount"
            class="nl-card-attachment"
            title="展开图片附件"
            :aria-expanded="imagesExpanded"
            @click.stop="toggleImages"
          >
            <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="4" width="14" height="12" rx="2" />
              <circle cx="7" cy="8" r="1.2" />
              <path d="m5 14 3.2-3 2.2 2 1.8-1.6L15 14" />
            </svg>
            <span>{{ attachmentCount }}</span>
          </button>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <Transition name="nl-tag-popover">
        <div
          v-if="tagsExpanded"
          class="nl-tag-popover"
          :style="tagPopoverStyle"
          role="dialog"
          aria-label="全部标签"
          @click.stop
        >
          <span
            v-for="tag in tags"
            :key="tag.id || tag.name"
            class="nl-tag-popover__tag"
            :style="tag.color ? { '--tag-color': tag.color } : {}"
          >{{ tag.name }}</span>
        </div>
      </Transition>
    </Teleport>

    <div
      v-if="attachmentCount"
      class="nl-image-panel-shell"
      :class="{ 'nl-image-panel-shell--expanded': imagesExpanded }"
      @click.stop
    >
      <div class="nl-image-panel-clip">
        <div class="nl-image-panel-content">
          <ImagePicker
            v-if="imagesMounted"
            :note-id="note.id"
            mode="persist"
            readonly
          />
        </div>
      </div>
    </div>
  </article>
</template>

<style>
@keyframes nl-card-in {
  from { opacity: 0; transform: translateY(6rem); }
  to { opacity: 1; transform: translateY(0); }
}
</style>

<style scoped>
.nl-card-anim {
  animation: nl-card-in 250ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

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
  cursor: pointer;
  transition:
    background-color 180ms cubic-bezier(0.22, 1, 0.36, 1),
    border-color 180ms cubic-bezier(0.22, 1, 0.36, 1),
    box-shadow 180ms cubic-bezier(0.22, 1, 0.36, 1),
    transform 100ms ease;
}

.nl-card:hover {
  border-color: color-mix(in srgb, var(--text-color) 12%, transparent);
  background: rgb(var(--bg-color) / var(--card-surface-hover-opacity));
  box-shadow: 0 5rem 18rem rgba(0, 0, 0, 0.05);
}

.nl-card--completed::after,
.nl-card--cancelled::after {
  content: '';
  position: absolute;
  z-index: 4;
  inset: 0;
  pointer-events: none;
  border-radius: inherit;
  background: rgba(128, 128, 128, 0.1);
  backdrop-filter: saturate(0.38);
  transition: background-color 180ms ease;
}
.nl-card--completed:hover::after { background: rgba(128, 128, 128, 0.075); }
.nl-card--cancelled::after { background: rgba(128, 128, 128, 0.15); }
.nl-card--cancelled:hover::after { background: rgba(128, 128, 128, 0.125); }

.nl-card:focus-visible {
  border-color: color-mix(in srgb, var(--accent-color) 55%, transparent);
  box-shadow: 0 0 0 3rem color-mix(in srgb, var(--accent-color) 14%, transparent);
}
.nl-card:active { transform: scale(0.993); }

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
.nl-card--cancelled {
  --card-surface-opacity: 0.035;
  --card-surface-hover-opacity: 0.055;
  --content-strength: 52%;
}
.nl-card--muted { opacity: 0.66; }
.nl-card--draggable { padding-right: 30rem; cursor: grab; }
.nl-card--draggable:active { cursor: grabbing; }

.nl-handle {
  position: absolute;
  z-index: 3;
  top: 13rem;
  right: 10rem;
  display: grid;
  place-items: center;
  width: 14rem;
  height: 18rem;
  color: var(--text-color-secondary);
  opacity: 0;
  transition: opacity 140ms ease;
}
.nl-handle svg { display: block; fill: currentColor; }
.nl-card:hover .nl-handle,
.nl-card:focus-visible .nl-handle { opacity: 0.58; }

.nl-status-control {
  position: relative;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 20rem;
  height: 20rem;
  margin: 2rem 0 0;
  padding: 0;
  border: 2.2rem solid var(--accent-color);
  border-radius: 50%;
  background: transparent;
  color: var(--accent-color);
  font-family: inherit;
  cursor: default;
  transition:
    box-shadow 260ms cubic-bezier(0.22, 1, 0.36, 1),
    transform 180ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 180ms ease;
}
.nl-status-control svg {
  width: 13rem;
  height: 13rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.nl-status-control--actionable { cursor: pointer; }
.nl-card:hover .nl-status-control--actionable {
  box-shadow:
    0 0 3rem color-mix(in srgb, var(--accent-color) 30%, transparent),
    0 0 8rem color-mix(in srgb, var(--accent-color) 17%, transparent),
    0 0 16rem color-mix(in srgb, var(--accent-color) 8%, transparent);
  transform: scale(1.035);
}
.nl-status-control--actionable:active { transform: scale(0.9); }
.nl-status-hover-icon { opacity: 0; transition: opacity 130ms ease; }
.nl-status-control--actionable:hover .nl-status-hover-icon { opacity: 1; }
.nl-card--completed .nl-status-control {
  border-color: color-mix(in srgb, var(--accent-color) 44%, #8a8a8a);
  background: color-mix(in srgb, var(--accent-color) 38%, #8a8a8a);
  color: #fff;
}
.nl-card--cancelled .nl-status-control { opacity: 0.7; }
.nl-status-control:disabled { pointer-events: none; }

/* 终结态降低内部信息层，而不是继续压暗卡片表面。 */
.nl-card--completed .nl-card-body {
  opacity: 0.62;
}
.nl-card--completed .nl-status-control {
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
.nl-card--completed:hover .nl-status-control {
  opacity: 0.72;
}
.nl-card--completed:hover .nl-image-panel-shell--expanded {
  opacity: 0.74;
}

.nl-card--cancelled .nl-card-body {
  opacity: 0.54;
}
.nl-card--cancelled .nl-status-control {
  opacity: 0.6;
}
.nl-card--cancelled .nl-image-panel-shell {
  opacity: 0;
}
.nl-card--cancelled .nl-image-panel-shell--expanded {
  opacity: 0.62;
}
.nl-card--cancelled:hover .nl-card-body {
  opacity: 0.59;
}
.nl-card--cancelled:hover .nl-status-control {
  opacity: 0.64;
}
.nl-card--cancelled:hover .nl-image-panel-shell--expanded {
  opacity: 0.66;
}

.nl-card-body {
  position: relative;
  z-index: 1;
  min-width: 0;
  transition: opacity 180ms ease;
}
.nl-card-text {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  color: color-mix(in srgb, var(--text-color) var(--content-strength), transparent);
  font-size: var(--fs-body);
  font-weight: 500;
  line-height: 1.45;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.nl-card--completed .nl-card-text,
.nl-card--cancelled .nl-card-text { font-weight: 400; }
.nl-card--empty .nl-card-text { color: var(--text-color-secondary); font-weight: 400; }

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
.nl-card-separator { opacity: 0.44; }
.nl-card-time { white-space: nowrap; }
.nl-card-time--finished { color: color-mix(in srgb, var(--text-color) 58%, transparent); }
.nl-card-utilities,
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
.nl-card-more-tags { flex-shrink: 0; background: transparent; color: var(--text-color-secondary); }
.nl-card-more-tags {
  appearance: none;
  border: 0;
  font: inherit;
  cursor: pointer;
  transition: color 140ms ease, background-color 140ms ease;
}
.nl-card-more-tags:hover,
.nl-card-more-tags[aria-expanded='true'] {
  background: color-mix(in srgb, var(--text-color) 7%, transparent);
  color: var(--text-color);
}
.nl-card-icon,
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
  transition: color 140ms ease, background-color 140ms ease;
}
.nl-card-attachment:hover,
.nl-card-attachment[aria-expanded='true'] {
  color: var(--text-color);
  background: color-mix(in srgb, var(--text-color) 7%, transparent);
}
.nl-card-icon svg,
.nl-card-attachment svg { display: block; }

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

.nl-tag-popover {
  position: fixed;
  z-index: 10000;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6rem;
  width: max-content;
  max-width: min(260px, calc(100vw - 16px));
  max-height: min(220px, calc(100vh - 24px));
  padding: 10rem;
  overflow-y: auto;
  border: 1px solid color-mix(in srgb, var(--text-color) 10%, transparent);
  border-radius: 10rem;
  background: rgb(var(--bg-color) / 0.92);
  box-shadow: 0 12rem 34rem rgba(0, 0, 0, 0.18);
  backdrop-filter: blur(22px) saturate(1.25);
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
.nl-tag-popover-leave-active { transition: opacity 150ms ease, transform 180ms cubic-bezier(0.22, 1, 0.36, 1); }
.nl-tag-popover-enter-from,
.nl-tag-popover-leave-to { opacity: 0; transform: translateY(-4px) scale(0.98); }

@media (max-width: 390px) {
  .nl-card-tag { max-width: 86rem; }
}
</style>
