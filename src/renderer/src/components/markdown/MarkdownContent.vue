<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import AppModalShell from '../ui/AppModalShell.vue'
import { renderNoticeMarkdown } from './notice-markdown.js'

const props = defineProps({ content: { type: String, default: '' } })
const html = computed(() => renderNoticeMarkdown(props.content))
const root = ref(null)
const enlarged = ref(null)

function imageFailed(event) {
  const img = event.target
  if (img?.tagName !== 'IMG') return
  img.hidden = true
  const button = img.closest('.markdown-image')
  if (!button) return
  button.disabled = true
  button.querySelector('.markdown-image-error').hidden = false
}

function imageClicked(event) {
  const button = event.target.closest?.('.markdown-image')
  const img = button?.querySelector('img')
  if (img && !button.disabled) {
    event.preventDefault()
    enlarged.value = { src: img.src, alt: img.alt }
  }
}

watch(html, async () => {
  enlarged.value = null
  await nextTick()
  // Cached failed requests may finish before the delegated error listener runs.
  root.value?.querySelectorAll('img').forEach((img) => {
    if (img.complete && !img.naturalWidth) imageFailed({ target: img })
  })
})
</script>

<template>
  <div class="notice-markdown">
    <!-- One root preserves the caller's attributes and scoped typography. -->
    <!-- HTML can only come from our html:false Markdown parser and escaped renderers. -->
    <!-- eslint-disable vue/no-v-html -->
    <div
      ref="root"
      class="notice-markdown-body"
      @click="imageClicked"
      @error.capture="imageFailed"
      v-html="html"
    />
    <!-- eslint-enable vue/no-v-html -->
    <AppModalShell
      :visible="Boolean(enlarged)"
      :title="enlarged?.alt || '图片预览'"
      aria-label="图片预览"
      width="calc(100vw - 40rem)"
      z-index="var(--z-global-preview)"
      @update:visible="enlarged = null"
    >
      <img
        v-if="enlarged"
        class="markdown-enlarged"
        :src="enlarged.src"
        :alt="enlarged.alt"
        referrerpolicy="no-referrer"
      />
    </AppModalShell>
  </div>
</template>

<style src="./notice-markdown.css"></style>
