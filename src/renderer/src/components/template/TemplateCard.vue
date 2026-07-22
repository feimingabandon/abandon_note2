<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useSharedMinuteClock } from '../../composables/useSharedMinuteClock.js'
import {
  formatRuleSummary,
  formatTemplateNextRun,
  formatTemplateTime,
  templateState
} from '../../utils/templateRules.js'

const props = defineProps({ template: { type: Object, required: true } })
const emit = defineEmits(['edit', 'action'])
const sharedNow = useSharedMinuteClock()
const state = computed(() => templateState(props.template))
const nextRunHint = computed(() =>
  formatTemplateNextRun(props.template.next_run_at, sharedNow.value)
)
const tags = computed(() => (Array.isArray(props.template.tags) ? props.template.tags : []))
const visibleTags = computed(() => tags.value.slice(0, 2))
const hiddenTagCount = computed(() => Math.max(0, tags.value.length - visibleTags.value.length))
const contentShellRef = ref(null)
const contentTextRef = ref(null)
const contentExpanded = ref(false)
const contentOverflows = ref(false)
const contentAnimating = ref(false)
const contentShellHeight = ref('auto')
const menuOpen = ref(false)
const menuStyle = ref({})
const CONTENT_PREVIEW_LINES = 3
const CONTENT_ANIMATION_DURATION = 280
let resizeObserver = null
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
function openMenu(event) {
  event.preventDefault()
  const width = 154
  const maxLeft = Math.max(8, window.innerWidth - width - 8)
  const maxTop = Math.max(8, window.innerHeight - 170)
  menuStyle.value = {
    left: `${Math.max(8, Math.min(event.clientX, maxLeft))}px`,
    top: `${Math.max(8, Math.min(event.clientY, maxTop))}px`
  }
  menuOpen.value = true
  nextTick(() => {
    if (menuOpen.value) document.addEventListener('pointerdown', closeMenu)
  })
}
function closeMenu() {
  menuOpen.value = false
  document.removeEventListener('pointerdown', closeMenu)
}
function action(name) {
  closeMenu()
  emit('action', name, props.template)
}

onMounted(async () => {
  await nextTick()
  measureContentOverflow()
  resizeObserver = new ResizeObserver(measureContentOverflow)
  if (contentTextRef.value) resizeObserver.observe(contentTextRef.value)
  document.fonts?.ready.then(measureContentOverflow)
})
watch(
  () => props.template.content,
  async () => {
    contentAnimation?.cancel()
    contentAnimation = null
    contentAnimating.value = false
    contentExpanded.value = false
    contentShellHeight.value = 'auto'
    await nextTick()
    measureContentOverflow()
  }
)
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  contentAnimation?.cancel()
  closeMenu()
})
</script>

<template>
  <article
    class="tc-card"
    :class="[`is-${state.key}`]"
    :data-template-id="template.id"
    @contextmenu="openMenu"
  >
    <div class="tc-head">
      <span class="tc-state"><i />{{ state.label }}</span>
      <span class="tc-rule">{{ formatRuleSummary(template.recurrence_rule) }}</span>
      <button class="tc-more" aria-label="模板操作" title="模板操作" @click.stop="openMenu">
        •••
      </button>
    </div>
    <div
      ref="contentShellRef"
      class="tc-content-shell"
      :class="{
        'tc-content-shell--collapsed': contentOverflows && !contentExpanded && !contentAnimating,
        'tc-content-shell--animating': contentAnimating
      }"
      :style="{ height: contentShellHeight }"
    >
      <p ref="contentTextRef" class="tc-content">{{ template.content }}</p>
    </div>
    <div class="tc-meta">
      <div class="tc-context">
        <span v-if="state.key === 'running'" class="tc-next-run">
          <span>下次 {{ formatTemplateTime(template.next_run_at) }}</span>
          <span v-if="nextRunHint" class="tc-next-run-hint">· {{ nextRunHint }}</span>
        </span>
        <span v-else-if="state.key === 'deleted'"
          >删除于 {{ formatTemplateTime(template.deleted_at) }}</span
        >
        <span v-else>已暂停</span>
      </div>
      <div
        v-if="
          tags.length ||
          Number(template.notify_enabled) === 1 ||
          Number(template.is_pinned) === 1 ||
          contentOverflows
        "
        class="tc-utilities"
      >
        <span
          v-for="tag in visibleTags"
          :key="tag.id || tag.name"
          class="tc-tag"
          :style="tag.color ? { '--tag-color': tag.color } : {}"
          >{{ tag.name }}</span
        >
        <span
          v-if="hiddenTagCount"
          class="tc-more-tags"
          :title="
            tags
              .slice(2)
              .map((tag) => tag.name)
              .join('、')
          "
          >+{{ hiddenTagCount }}</span
        >
        <span
          v-if="Number(template.notify_enabled) === 1"
          class="tc-icon"
          title="模板生成便签时通知"
          aria-label="模板生成便签时通知"
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path
              d="M5.6 8.2a4.4 4.4 0 0 1 8.8 0c0 4.3 1.8 4.6 1.8 5.7H3.8c0-1.1 1.8-1.4 1.8-5.7Z"
            />
            <path d="M8.2 16a2 2 0 0 0 3.6 0" />
          </svg>
        </span>
        <span
          v-if="Number(template.is_pinned) === 1"
          class="tc-icon"
          title="生成的便签置顶"
          aria-label="生成的便签置顶"
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M6.2 3.5h7.6M8 3.5v4.1l-2.2 3h8.4l-2.2-3V3.5M10 10.6v6" />
          </svg>
        </span>
        <button
          v-if="contentOverflows"
          class="tc-disclosure"
          type="button"
          :class="{ 'tc-disclosure--expanded': contentExpanded }"
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
    <div v-if="state.key === 'error'" class="tc-error">
      连续失败 {{ template.consecutive_failures }} 次<span v-if="template.last_error"
        >：{{ template.last_error }}</span
      >
    </div>
  </article>

  <Teleport to="body">
    <Transition name="tc-menu">
      <div v-if="menuOpen" class="tc-menu" :style="menuStyle" @pointerdown.stop>
        <template v-if="state.key !== 'deleted'">
          <button @click="action('edit')">修改</button>
          <button @click="action(state.key === 'running' ? 'pause' : 'resume')">
            {{ state.key === 'running' ? '暂停' : '恢复' }}
          </button>
          <hr />
          <button class="danger" @click="action('delete')">删除</button>
        </template>
        <template v-else>
          <button @click="action('restore')">恢复模板</button>
          <hr />
          <button class="danger" @click="action('purge')">彻底删除</button>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.tc-card {
  --card-surface-opacity: 0.08;
  --card-surface-hover-opacity: 0.12;
  position: relative;
  padding: 14rem 14rem 12rem;
  border: 1px solid color-mix(in srgb, var(--text-color) 7%, transparent);
  border-radius: 11rem;
  background: rgb(var(--bg-color) / var(--card-surface-opacity));
  color: var(--text-color);
  transition:
    background-color 180ms cubic-bezier(0.22, 1, 0.36, 1),
    border-color 180ms cubic-bezier(0.22, 1, 0.36, 1),
    box-shadow 180ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 180ms ease;
}
.tc-card:hover {
  border-color: color-mix(in srgb, var(--text-color) 12%, transparent);
  background: rgb(var(--bg-color) / var(--card-surface-hover-opacity));
  box-shadow: 0 5rem 18rem rgba(0, 0, 0, 0.05);
}
.tc-card.is-deleted {
  opacity: 0.72;
}
.tc-head,
.tc-meta {
  display: flex;
  align-items: center;
  gap: 8rem;
}
.tc-state {
  display: flex;
  align-items: center;
  gap: 5rem;
  flex-shrink: 0;
  font-size: var(--fs-secondary);
  font-weight: 600;
}
.tc-state i {
  width: 6rem;
  height: 6rem;
  border-radius: 50%;
  background: #0a84ff;
}
.is-paused .tc-state i {
  background: #ff9f0a;
}
.is-error .tc-state i {
  background: #ff453a;
}
.is-deleted .tc-state i {
  background: #8e8e93;
}
.tc-rule {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.tc-more {
  margin-left: auto;
  border: 0;
  padding: 2rem 4rem;
  background: transparent;
  color: var(--text-color-secondary);
  letter-spacing: 1rem;
  cursor: pointer;
}
.tc-content-shell {
  overflow: hidden;
  margin-top: 10rem;
}
.tc-content-shell--animating {
  will-change: height;
}
.tc-content {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: var(--fs-body);
  line-height: 1.55;
  user-select: text;
  cursor: text;
}
.tc-content-shell--collapsed .tc-content {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
.tc-disclosure {
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
.tc-disclosure svg {
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
.tc-disclosure--expanded svg {
  transform: rotate(180deg);
}
.tc-disclosure:hover,
.tc-disclosure:focus-visible {
  background: color-mix(in srgb, var(--text-color) 7%, transparent);
  color: color-mix(in srgb, var(--text-color) 82%, transparent);
}
.tc-disclosure:focus-visible {
  box-shadow: 0 0 0 2rem color-mix(in srgb, var(--accent-color) 22%, transparent);
}
.tc-meta {
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 9rem;
  margin-top: 9rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.8);
  line-height: 1.25;
}
.tc-context {
  display: flex;
  flex: 1 0 auto;
  flex-wrap: wrap;
  align-items: center;
  width: max-content;
  max-width: 100%;
  min-width: 0;
}
.tc-next-run {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4rem;
}
.tc-next-run-hint {
  color: color-mix(in srgb, var(--text-color-secondary) 78%, transparent);
}
.tc-utilities {
  display: flex;
  flex: 1 0 auto;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 5rem;
  width: max-content;
  max-width: 100%;
  min-width: 0;
}
.tc-tag,
.tc-more-tags {
  max-width: min(140rem, 42vw);
  padding: 2rem 6rem;
  overflow: hidden;
  border-radius: 5rem;
  background: color-mix(in srgb, var(--tag-color, var(--text-color)) 9%, transparent);
  color: color-mix(in srgb, var(--tag-color, var(--text-color)) 68%, var(--text-color-secondary));
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tc-more-tags {
  flex-shrink: 0;
  background: transparent;
  color: var(--text-color-secondary);
}
.tc-icon {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  padding: 2rem 3rem;
  color: color-mix(in srgb, var(--text-color) 45%, transparent);
}
.tc-icon svg {
  display: block;
  width: 13rem;
  height: 13rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.5;
}
.tc-error {
  margin-top: 8rem;
  padding: 7rem 9rem;
  border-radius: 7rem;
  background: rgba(255, 69, 58, 0.1);
  color: #ff6961;
  font-size: calc(var(--fs-secondary) * 0.9);
  overflow-wrap: anywhere;
}
.tc-menu {
  position: fixed;
  z-index: 30000;
  width: 154rem;
  padding: 5rem;
  border: 1rem solid var(--surface-float-border);
  border-radius: 10rem;
  background: var(--surface-float);
  box-shadow: 0 12rem 32rem rgba(0, 0, 0, 0.28);
}
.tc-menu button {
  width: 100%;
  border: 0;
  border-radius: 6rem;
  padding: 7rem 10rem;
  text-align: left;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  font-size: var(--fs-secondary);
  cursor: pointer;
}
.tc-menu button:hover {
  background: color-mix(in srgb, var(--text-color) 8%, transparent);
}
.tc-menu .danger {
  color: #ff453a;
}
.tc-menu hr {
  height: 1rem;
  margin: 4rem 5rem;
  border: 0;
  background: color-mix(in srgb, var(--text-color) 9%, transparent);
}
.tc-menu-enter-active,
.tc-menu-leave-active {
  transition:
    opacity 130ms ease,
    transform 130ms ease;
}
.tc-menu-enter-from,
.tc-menu-leave-to {
  opacity: 0;
  transform: translateY(-4rem);
}
</style>
