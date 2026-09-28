<script setup>
import { onBeforeUnmount, onMounted, onUpdated, ref } from 'vue'

const viewport = ref(null)
const content = ref(null)
const overflowing = ref(false)
let observer
function measure() {
  overflowing.value = Boolean(
    viewport.value && content.value && content.value.scrollWidth > viewport.value.clientWidth + 1
  )
}
onMounted(() => {
  observer = new ResizeObserver(measure)
  observer.observe(viewport.value)
  observer.observe(content.value)
  measure()
})
onUpdated(measure)
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <span ref="viewport" class="overflow-fade" :class="{ 'is-overflowing': overflowing }">
    <span ref="content" class="overflow-fade__content"><slot /></span>
  </span>
</template>

<style scoped>
.overflow-fade {
  display: block;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: clip;
}
.overflow-fade__content {
  display: inline-block;
  white-space: nowrap;
}
.overflow-fade.is-overflowing {
  /* 黑色仅用于透明度遮罩，渐隐仍透出实际主题或壁纸。 */
  mask-image: linear-gradient(to right, black calc(100% - min(28rem, 40%)), transparent);
}
</style>
