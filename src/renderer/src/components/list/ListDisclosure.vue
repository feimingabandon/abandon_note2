<script setup>
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({ open: Boolean })
const emit = defineEmits(['closed'])
const root = ref(null)
const content = ref(null)
const rendered = ref(props.open)
const moving = ref(false)
let animation = null
let revision = 0
let targetHeight = 0
let observer

async function move(open) {
  const element = root.value
  if (!element) return
  const sequence = ++revision
  // Read the displayed height before cancellation: rapid reversal starts here.
  const height = rendered.value ? element.getBoundingClientRect().height : 0
  const opacity = rendered.value ? getComputedStyle(element).opacity : '0'
  element.style.height = `${height}px`
  element.style.opacity = opacity
  animation?.cancel()
  rendered.value = true
  moving.value = true
  await nextTick()
  if (sequence !== revision) return
  targetHeight = open ? content.value.getBoundingClientRect().height : 0
  const current = element.animate(
    [
      { height: `${height}px`, opacity },
      { height: `${targetHeight}px`, opacity: open ? 1 : 0 }
    ],
    { duration: open ? 260 : 200, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'both' }
  )
  current.id = 'list-disclosure'
  animation = current
  current.finished.then(
    () => {
      if (sequence !== revision) return
      rendered.value = open
      moving.value = false
      element.style.height = ''
      element.style.opacity = ''
      animation = null
      current.cancel()
      if (!open) emit('closed')
    },
    () => {}
  )
}

watch(() => props.open, move, { flush: 'sync' })
onMounted(() => {
  observer = new ResizeObserver(() => {
    if (
      moving.value &&
      props.open &&
      content.value &&
      Math.abs(content.value.getBoundingClientRect().height - targetHeight) > 1
    ) {
      void move(true)
    }
  })
  // The inner wrapper always exists, even while its slot is unmounted.
  observer.observe(content.value)
})
onBeforeUnmount(() => {
  revision++
  observer?.disconnect()
  animation?.cancel()
})
</script>

<template>
  <div
    v-show="rendered"
    ref="root"
    class="list-disclosure"
    :data-list-disclosure-moving="moving ? '' : undefined"
    :inert="!open"
    :aria-hidden="!open"
  >
    <div ref="content" class="list-disclosure__content">
      <slot v-if="rendered" />
    </div>
  </div>
</template>

<style scoped>
.list-disclosure {
  min-height: 0;
}
.list-disclosure[data-list-disclosure-moving] {
  overflow: hidden;
}
.list-disclosure__content {
  display: flow-root;
}
</style>
