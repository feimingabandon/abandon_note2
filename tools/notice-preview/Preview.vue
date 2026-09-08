<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, watchEffect } from 'vue'
import RemoteNoticeDialog from '../../src/renderer/src/components/system/RemoteNoticeDialog.vue'
import UpdateDialog from '../../src/renderer/src/components/system/UpdateDialog.vue'

const state = reactive({
  title: '软件通知',
  body: '在左侧输入 Markdown，实时查看通知效果。',
  link: '',
  view: 'list',
  theme: 'light',
  kind: 'notice',
  fontSize: 18
})
const notices = computed(() => [
  { id: 1, title: state.title || '软件通知', body: state.body, link: state.link }
])
const update = computed(() => ({
  status: 'available',
  relation: 'upgrade',
  currentVersion: '1.2.0',
  latestVersion: '1.3.0',
  platform: 'win32',
  releaseNotes: state.body,
  downloadAvailable: false,
  releaseLinks: {
    github: 'https://github.com/feimingabandon/abandon_note2/releases',
    gitcode: 'https://gitcode.com/zou-feiming/abandon_note2/releases'
  }
}))
function returnToEditor() {
  window.parent.postMessage({ type: 'abandon-notice-preview-exit' }, window.location.origin)
}
function receive(event) {
  if (
    event.source !== window.parent ||
    event.origin !== window.location.origin ||
    event.data?.type !== 'abandon-notice-preview'
  )
    return
  const data = event.data.payload || {}
  for (const key of ['title', 'body', 'link'])
    if (typeof data[key] === 'string')
      state[key] = data[key].slice(0, key === 'body' ? 20000 : 2048)
  if (['list', 'month'].includes(data.view)) state.view = data.view
  if (['light', 'dark', 'wallpaper'].includes(data.theme)) state.theme = data.theme
  if (['notice', 'update'].includes(data.kind)) state.kind = data.kind
  if (Number.isFinite(data.fontSize)) state.fontSize = Math.min(28, Math.max(12, data.fontSize))
}
watchEffect(() => {
  const root = document.documentElement
  root.classList.toggle('month-view', state.view === 'month')
  root.dataset.previewTheme = state.theme
  root.style.setProperty('--font-size-base', `${state.fontSize}rem`)
  root.style.setProperty('--bg-color', state.theme === 'dark' ? '0 0 0' : '255 255 255')
  root.style.setProperty('--text-color', state.theme === 'dark' ? '#ffffff' : '#18212b')
})
onMounted(() => {
  window.addEventListener('message', receive)
  window.parent.postMessage({ type: 'abandon-notice-preview-ready' }, window.location.origin)
})
onBeforeUnmount(() => window.removeEventListener('message', receive))
</script>

<template>
  <div class="preview-desktop">
    <div class="app-scene preview-scene">
      <header class="preview-title">
        <strong>Abandon 便签</strong><span>⌕&#12288;＋&#12288;⋯</span>
      </header>
      <template v-if="state.view === 'list'">
        <div class="preview-toolbar">全部便签&#12288;&#12288;进行中&#12288;&#12288;已完成</div>
        <article
          v-for="(text, index) in [
            '整理今天的计划',
            '记录灵感与想法',
            '读书，留一点时间给自己',
            '周末出去走走'
          ]"
          :key="text"
          class="preview-note"
        >
          <span class="preview-ring" />
          <div>
            <p>{{ text }}</p>
            <small>9 月 {{ 8 + index }} 日 · 进行中</small>
          </div>
        </article>
      </template>
      <template v-else>
        <div class="preview-calendar-title">
          <span>今天&#12288;↻</span><strong>2026 年 9 月</strong><span>日期列表</span>
        </div>
        <div class="preview-week">
          <span v-for="day in ['一', '二', '三', '四', '五', '六', '日']" :key="day"
            >周{{ day }}</span
          >
        </div>
        <div class="preview-calendar">
          <div v-for="day in 35" :key="day">
            <span>{{ ((day + 29) % 30) + 1 }}</span
            ><small v-if="day % 4 === 0">整理计划与记录</small>
          </div>
        </div>
      </template>
    </div>
    <RemoteNoticeDialog v-if="state.kind === 'notice'" :notices="notices" @close="returnToEditor" />
    <UpdateDialog v-else :visible="true" :result="update" @update:visible="returnToEditor" />
  </div>
</template>

<style>
:root {
  --popup-opacity: 0.94;
  --window-radius: 14rem;
}
body {
  background: rgb(var(--bg-color));
}
.preview-desktop {
  min-height: 100vh;
  background: rgb(var(--bg-color));
}
/* Illustration-only wallpaper preset; content surfaces use the real client tokens. */
[data-preview-theme='wallpaper'] .preview-desktop {
  background: repeating-linear-gradient(
    120deg,
    #dbeafe 0,
    #e0f2fe 55px,
    #fce7f3 110px,
    #eef2ff 165px
  );
}
.preview-scene {
  padding: 16rem;
  min-height: 100vh;
  color: var(--text-color);
}
.preview-title,
.preview-calendar-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12rem 4rem;
}
.preview-toolbar {
  margin: 20rem 0;
  color: var(--text-color-secondary);
}
.preview-note {
  display: flex;
  align-items: center;
  gap: 14rem;
  padding: 20rem 8rem;
  border-bottom: 1px solid var(--ui-border-divider);
}
.preview-note small {
  display: block;
  color: var(--text-color-secondary);
  margin-top: 8rem;
}
.preview-ring {
  width: 18rem;
  height: 18rem;
  border-radius: 50%;
  border: 1px solid var(--ui-accent);
}
.preview-calendar-title {
  padding: 30rem 8rem;
}
.preview-week,
.preview-calendar {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
}
.preview-week {
  text-align: center;
  padding: 12rem 0;
}
.preview-calendar > div {
  height: 135rem;
  padding: 12rem;
  border-top: 1px solid var(--ui-border-divider);
  border-left: 1px solid var(--ui-border-divider);
}
.preview-calendar small {
  display: block;
  margin-top: 18rem;
  padding: 5rem;
  color: var(--ui-accent);
  background: var(--ui-accent-subtle);
}
</style>
