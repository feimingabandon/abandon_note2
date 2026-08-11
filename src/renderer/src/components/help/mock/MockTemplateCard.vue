<script setup>
/**
 * MockTemplateCard.vue — TemplateCard 的静态只读复刻（帮助图解专用）
 *
 * 还原循环模板卡片：状态点 + 频率摘要 + 更多按钮，正文，底部下次生成时间与标签/通知/置顶图标。
 */
defineProps({
  state: { type: String, default: 'running' }, // running | paused | error | deleted
  stateLabel: { type: String, default: '运行中' },
  rule: { type: String, default: '每天 09:00' },
  content: { type: String, default: '' },
  contextText: { type: String, default: '' },
  tags: { type: Array, default: () => [] },
  notify: { type: Boolean, default: false },
  pinned: { type: Boolean, default: false }
})
</script>

<template>
  <article class="mtc-card" :class="`is-${state}`">
    <div class="mtc-head">
      <span class="mtc-state"><i />{{ stateLabel }}</span>
      <span class="mtc-rule">{{ rule }}</span>
      <span class="mtc-more">•••</span>
    </div>
    <p class="mtc-content">{{ content }}</p>
    <div class="mtc-meta">
      <div class="mtc-context">{{ contextText }}</div>
      <div class="mtc-utilities">
        <span
          v-for="tag in tags"
          :key="tag.name"
          class="mtc-tag"
          :style="tag.color ? { '--tag-color': tag.color } : {}"
          >{{ tag.name }}</span
        >
        <span v-if="notify" class="mtc-icon">
          <svg
            viewBox="0 0 20 20"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M5.6 8.2a4.4 4.4 0 0 1 8.8 0c0 4.3 1.8 4.6 1.8 5.7H3.8c0-1.1 1.8-1.4 1.8-5.7Z"
            />
            <path d="M8.2 16a2 2 0 0 0 3.6 0" />
          </svg>
        </span>
        <span v-if="pinned" class="mtc-icon">
          <svg
            viewBox="0 0 20 20"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M6.2 3.5h7.6M8 3.5v4.1l-2.2 3h8.4l-2.2-3V3.5M10 10.6v6" />
          </svg>
        </span>
      </div>
    </div>
  </article>
</template>

<style scoped>
.mtc-card {
  --card-surface-opacity: 0.08;
  padding: 14rem 14rem 12rem;
  border: 1px solid var(--ui-border-divider);
  border-radius: 11rem;
  background: rgb(var(--bg-color) / var(--card-surface-opacity));
  color: var(--text-color);
}
.mtc-card.is-deleted {
  opacity: 0.72;
}
.mtc-head {
  display: flex;
  align-items: center;
  gap: 8rem;
}
.mtc-state {
  display: flex;
  align-items: center;
  gap: 5rem;
  flex-shrink: 0;
  font-size: var(--fs-secondary);
  font-weight: 600;
}
.mtc-state i {
  width: 6rem;
  height: 6rem;
  border-radius: 50%;
  background: #0a84ff;
}
.is-paused .mtc-state i {
  background: #ff9f0a;
}
.is-error .mtc-state i {
  background: #ff453a;
}
.is-deleted .mtc-state i {
  background: #8e8e93;
}
.mtc-rule {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
.mtc-more {
  margin-left: auto;
  color: var(--text-color-secondary);
  letter-spacing: 1rem;
}
.mtc-content {
  margin: 10rem 0 0;
  font-size: var(--fs-body);
  line-height: 1.55;
  overflow-wrap: anywhere;
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
.mtc-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 9rem;
  margin-top: 9rem;
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.8);
  line-height: 1.25;
}
.mtc-context {
  min-width: 0;
}
.mtc-utilities {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 5rem;
}
.mtc-tag {
  max-width: 140rem;
  padding: 2rem 6rem;
  overflow: hidden;
  border-radius: 5rem;
  background: color-mix(in srgb, var(--tag-color, var(--text-color)) 9%, transparent);
  color: color-mix(in srgb, var(--tag-color, var(--text-color)) 68%, var(--text-color-secondary));
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mtc-icon {
  display: flex;
  align-items: center;
  padding: 2rem 3rem;
  color: color-mix(in srgb, var(--text-color) 45%, transparent);
}
.mtc-icon svg {
  display: block;
}
</style>
