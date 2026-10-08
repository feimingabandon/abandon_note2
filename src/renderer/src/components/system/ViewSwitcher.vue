<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { VIEW_MODES } from '../../../../shared/settings-schema.js'
import { useMessage } from '../../composables/useMessage.js'
import { enterPopover, leavePopover } from '../../utils/popoverMotion.js'
import AppIcon from '../ui/AppIcon.vue'
import { measurePopoverContent, popoverStyle } from '../../utils/anchoredPopover.js'
import { usePopoverLifecycle } from '../../composables/usePopoverLifecycle.js'
import { isComposingInput } from '../../utils/inputComposition.js'

const props = defineProps({
  activeView: {
    type: String,
    required: true,
    validator: (value) => Object.values(VIEW_MODES).includes(value)
  },
  styleVariant: {
    type: String,
    default: 'apple',
    validator: (value) => value === 'apple' || value === 'microsoft'
  }
})

const VIEW_OPTIONS = Object.freeze([
  { value: VIEW_MODES.LIST, shortLabel: '列', label: '便签列表' },
  { value: VIEW_MODES.MONTH, shortLabel: '月', label: '月视图' },
  { value: VIEW_MODES.WEEK, shortLabel: '周', label: '周视图' }
])

const triggerRef = ref(null)
const menuRef = ref(null)
const menuOpen = ref(false)
const menuStyle = ref({})
usePopoverLifecycle(menuOpen, triggerRef, menuRef, updateMenuPosition)
const switching = ref(false)
const stopSwitchListener = window.api.onMainViewSwitchFinished?.(() => {
  switching.value = false
})
const { showMessage } = useMessage()

const activeOption = computed(
  () => VIEW_OPTIONS.find((option) => option.value === props.activeView) || VIEW_OPTIONS[0]
)

function updateMenuPosition() {
  const trigger = triggerRef.value
  if (!trigger) return
  const rect = trigger.getBoundingClientRect()
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
  const font = parseFloat(getComputedStyle(trigger.parentElement).fontSize)
  const natural = measurePopoverContent(menuRef.value)
  const width = Math.min(Math.max(144 * rem, 8 * font, natural?.width || 0), window.innerWidth - 16)
  const fitted = measurePopoverContent(menuRef.value, width)
  const preferredLeft = props.styleVariant === 'microsoft' ? rect.right - width : rect.left
  menuStyle.value = popoverStyle(
    { ...rect.toJSON(), left: preferredLeft },
    width,
    fitted?.height || 180 * rem
  )
}

async function focusActiveOption() {
  await nextTick()
  menuRef.value?.querySelector(`[data-view="${props.activeView}"]`)?.focus({ preventScroll: true })
}

function toggleMenu() {
  if (switching.value) return
  menuOpen.value = !menuOpen.value
  if (menuOpen.value) {
    updateMenuPosition()
    void focusActiveOption()
  }
}

function closeMenu({ restoreFocus = false } = {}) {
  if (!menuOpen.value) return
  menuOpen.value = false
  if (restoreFocus) triggerRef.value?.focus({ preventScroll: true })
}

async function switchView(targetView) {
  if (switching.value) return
  closeMenu({ restoreFocus: true })
  if (targetView === props.activeView) return

  switching.value = true
  try {
    const accepted = await window.api.switchMainView(targetView)
    if (!accepted) switching.value = false
  } catch (error) {
    switching.value = false
    console.error('[ViewSwitcher] 切换主视图失败:', targetView, error)
    showMessage('error', error?.message || '切换视图失败，请重试')
  }
}

function onMenuKeydown(event) {
  if (isComposingInput(event)) return
  const items = [...(menuRef.value?.querySelectorAll('[role="menuitemradio"]') || [])]
  if (!items.length) return
  const currentIndex = Math.max(0, items.indexOf(document.activeElement))
  let targetIndex = null
  if (event.key === 'ArrowDown') targetIndex = (currentIndex + 1) % items.length
  if (event.key === 'ArrowUp') targetIndex = (currentIndex - 1 + items.length) % items.length
  if (event.key === 'Home') targetIndex = 0
  if (event.key === 'End') targetIndex = items.length - 1
  if (event.key === 'Tab') {
    closeMenu({ restoreFocus: true })
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeMenu({ restoreFocus: true })
    return
  }
  if (targetIndex === null) return
  event.preventDefault()
  items[targetIndex].focus({ preventScroll: true })
}

function onDocumentPointerDown(event) {
  if (!menuOpen.value) return
  if (triggerRef.value?.contains(event.target)) return
  if (menuRef.value?.contains(event.target)) return
  closeMenu()
}

function onPopoverEnter(element, done) {
  enterPopover(element, done, 'dropdown')
}

function onPopoverLeave(element, done) {
  leavePopover(element, done, 'dropdown')
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
})

onBeforeUnmount(() => {
  stopSwitchListener?.()
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
})
</script>

<template>
  <div class="view-switcher" :aria-busy="switching">
    <button
      ref="triggerRef"
      type="button"
      class="titlebar-btn view-switcher__trigger"
      data-diagnostic-action="view.menu"
      :class="{ 'is-open': menuOpen, 'is-switching': switching }"
      :data-active-view="activeView"
      :title="`当前视图：${activeOption.label}`"
      :aria-label="`切换主视图，当前为${activeOption.label}`"
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
      :aria-disabled="switching"
      :disabled="switching"
      @click="toggleMenu"
    >
      <AppIcon class="btn-icon view-switcher__trigger-icon" name="switch-view" />
    </button>

    <Teleport to="body">
      <Transition :css="false" @enter="onPopoverEnter" @leave="onPopoverLeave">
        <div
          v-if="menuOpen"
          ref="menuRef"
          class="view-switcher__menu"
          :style="menuStyle"
          role="menu"
          aria-label="切换主视图"
          @click.stop
          @keydown="onMenuKeydown"
        >
          <button
            v-for="option in VIEW_OPTIONS"
            :key="option.value"
            type="button"
            class="view-switcher__option"
            :class="{ 'is-active': option.value === activeView }"
            role="menuitemradio"
            :aria-checked="option.value === activeView"
            :data-view="option.value"
            :data-diagnostic-action="`view.switch.${option.value}`"
            @click="switchView(option.value)"
          >
            <span class="view-switcher__option-check" aria-hidden="true">✓</span>
            <span class="view-switcher__option-short" aria-hidden="true">{{
              option.shortLabel
            }}</span>
            <span class="view-switcher__option-label">{{ option.label }}</span>
          </button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.view-switcher {
  display: inline-flex;
  flex: 0 0 auto;
  -webkit-app-region: no-drag;
}

.view-switcher__trigger {
  line-height: 0;
}

.view-switcher__menu {
  position: fixed;
  z-index: var(--z-global-popover);
  display: grid;
  gap: 1rem;
  padding: 5rem;
  color: var(--text-color);
  background: var(--surface-float);
  border: 1px solid var(--surface-float-border);
  border-radius: var(--ui-menu-radius);
  box-shadow: var(--ui-menu-shadow);
  overflow-y: auto;
  overscroll-behavior: contain;
  transform-origin: top center;
  will-change: opacity, transform;
  -webkit-app-region: no-drag;
}

.view-switcher__option {
  display: grid;
  grid-template-columns: 14rem 16rem minmax(0, 1fr);
  align-items: center;
  gap: 6rem;
  width: 100%;
  min-height: var(--ui-menu-row-height);
  padding: 5rem 8rem;
  color: inherit;
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: 7rem;
  cursor: pointer;
  outline: none;
  transition:
    color var(--motion-fast) ease,
    background-color var(--motion-fast) ease;
}

.view-switcher__option:hover,
.view-switcher__option:focus-visible {
  color: var(--ui-menu-on-highlight);
  background: var(--ui-menu-highlight);
}

.view-switcher__option-check {
  color: var(--ui-accent);
  font-size: 13rem;
  line-height: 1;
  opacity: 0;
}

.view-switcher__option.is-active .view-switcher__option-check {
  opacity: 1;
}

.view-switcher__option:hover .view-switcher__option-check,
.view-switcher__option:focus-visible .view-switcher__option-check {
  color: currentColor;
}

.view-switcher__option-short {
  font-size: var(--fs-secondary);
  font-weight: 650;
  line-height: 1;
}

.view-switcher__option-label {
  font-size: var(--fs-body);
  font-weight: 400;
  line-height: 1.2;
  white-space: normal;
  overflow-wrap: anywhere;
}

.view-switcher__option.is-active .view-switcher__option-label {
  font-weight: 600;
}
</style>
