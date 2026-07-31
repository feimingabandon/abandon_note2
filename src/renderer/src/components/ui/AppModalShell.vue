<script setup>
import { onBeforeUnmount, useSlots, watch } from 'vue'
import { releaseModalBlur, retainModalBlur } from '../../utils/modalBlur.js'

const props = defineProps({
  visible: { type: Boolean, default: false },
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
  eyebrow: { type: String, default: '' },
  ariaLabel: { type: String, default: '' },
  width: { type: String, default: 'min(560rem, calc(100vw - 40rem))' },
  height: { type: String, default: 'auto' },
  maxHeight: { type: String, default: 'calc(100vh - 40rem)' },
  zIndex: { type: Number, default: 41000 },
  closeDisabled: { type: Boolean, default: false },
  closeOnBackdrop: { type: Boolean, default: true },
  flush: { type: Boolean, default: false }
})

const emit = defineEmits(['update:visible', 'close'])
const slots = useSlots()
let ownsModalBlur = false

function acquireBlur() {
  if (ownsModalBlur) return
  ownsModalBlur = true
  retainModalBlur()
}

function freeBlur() {
  if (!ownsModalBlur) return
  ownsModalBlur = false
  releaseModalBlur()
}

function close() {
  if (props.closeDisabled) return
  emit('update:visible', false)
  emit('close')
}

function onBackdrop() {
  if (props.closeOnBackdrop) close()
}

function onKeydown(event) {
  if (event.key === 'Escape') close()
}

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      acquireBlur()
      window.addEventListener('keydown', onKeydown)
    } else {
      window.removeEventListener('keydown', onKeydown)
      freeBlur()
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  freeBlur()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="app-modal">
      <div
        v-if="visible"
        class="app-modal-overlay"
        data-keep-settings-open
        :style="{ zIndex }"
        role="presentation"
        @click.self="onBackdrop"
      >
        <section
          class="app-modal-card"
          role="dialog"
          aria-modal="true"
          :aria-label="ariaLabel || title"
          :style="{ width, height, maxHeight }"
        >
          <header class="app-modal-header">
            <div class="app-modal-heading">
              <p v-if="eyebrow" class="app-modal-eyebrow">{{ eyebrow }}</p>
              <h2>{{ title }}</h2>
              <p v-if="subtitle" class="app-modal-subtitle">{{ subtitle }}</p>
            </div>
            <button
              type="button"
              class="app-modal-close"
              :disabled="closeDisabled"
              aria-label="关闭"
              title="关闭"
              @click="close"
            >
              ×
            </button>
          </header>

          <main class="app-modal-body" :class="{ 'is-flush': flush }">
            <slot />
          </main>

          <footer v-if="slots.footer" class="app-modal-footer">
            <slot name="footer" />
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.app-modal-overlay {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20rem;
  overflow: hidden;
  border-radius: var(--window-radius);
  background: rgba(12, 14, 18, 0.14);
}

.app-modal-card {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border: 0;
  border-radius: 14rem;
  color: var(--text-color);
  background: rgb(var(--bg-color) / var(--glass-complex-opacity));
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.42);
}

.app-modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex: 0 0 auto;
  gap: 16rem;
  padding: 17rem 19rem;
  border-bottom: 1rem solid color-mix(in srgb, var(--text-color) 10%, transparent);
}

.app-modal-heading {
  min-width: 0;
}

.app-modal-heading h2 {
  margin: 0;
  color: var(--text-color);
  font-size: var(--fs-title);
  font-weight: 650;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.app-modal-eyebrow,
.app-modal-subtitle {
  margin: 0;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  line-height: 1.4;
}

.app-modal-eyebrow {
  margin-bottom: 3rem;
}

.app-modal-subtitle {
  margin-top: 4rem;
}

.app-modal-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28rem;
  height: 28rem;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  color: var(--text-color);
  background: transparent;
  opacity: 0.6;
  font: inherit;
  font-size: 20rem;
  line-height: 1;
  cursor: pointer;
  transition:
    opacity var(--motion-fast) ease,
    transform var(--motion-control) var(--ease-standard);
}

.app-modal-close:hover:not(:disabled) {
  background: transparent;
  opacity: 1;
}

.app-modal-close:active:not(:disabled) {
  transform: scale(0.9);
  transition-duration: 70ms;
}

.app-modal-close:disabled {
  opacity: 0.35;
  cursor: wait;
}

.app-modal-body {
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  padding: 18rem 19rem;
  overflow-y: auto;
}

.app-modal-body.is-flush {
  padding: 0;
  overflow: hidden;
}

.app-modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex: 0 0 auto;
  gap: 10rem;
  padding: 13rem 19rem;
  border-top: 1rem solid color-mix(in srgb, var(--text-color) 10%, transparent);
}

.app-modal-enter-active,
.app-modal-leave-active {
  transition: opacity var(--motion-control) ease;
}

.app-modal-enter-active .app-modal-card,
.app-modal-leave-active .app-modal-card {
  transition:
    opacity var(--motion-control) ease,
    transform var(--motion-control) var(--ease-standard);
}

.app-modal-enter-from,
.app-modal-leave-to,
.app-modal-enter-from .app-modal-card,
.app-modal-leave-to .app-modal-card {
  opacity: 0;
}

.app-modal-enter-from .app-modal-card,
.app-modal-leave-to .app-modal-card {
  transform: translateY(8rem);
}
</style>
