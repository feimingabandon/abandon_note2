<script setup>
/**
 * MockNoteCard.vue — NoteCard 的静态只读复刻（帮助图解专用）
 *
 * 忠实还原真实便签卡片外观：左侧状态圆环 + 右侧正文与信息行（状态·时间 / 标签·提醒·复制·附件·展开箭头）。
 * 纯展示，无任何逻辑；配色、透明度、间距均与 NoteCard.vue 对齐。
 */
import MockStatusRing from './MockStatusRing.vue'

defineProps({
  status: { type: String, default: 'in_progress' },
  content: { type: String, default: '' },
  timeText: { type: String, default: '' },
  tags: { type: Array, default: () => [] },
  moreTags: { type: Number, default: 0 },
  notify: { type: Boolean, default: false },
  attachments: { type: Number, default: 0 },
  copy: { type: Boolean, default: true },
  disclosure: { type: Boolean, default: false }
})

const STATUS_LABEL = {
  initialized: '初始化',
  in_progress: '进行中',
  completed: '已完成'
}
</script>

<template>
  <article class="mc-card" :class="`mc-card--${status}`">
    <MockStatusRing :status="status" />
    <div class="mc-body">
      <p class="mc-text">{{ content }}</p>
      <div class="mc-meta">
        <div class="mc-context">
          <span class="mc-status">{{ STATUS_LABEL[status] || '初始化' }}</span>
          <span class="mc-sep">·</span>
          <span class="mc-time">{{ timeText }}</span>
        </div>
        <div class="mc-utilities">
          <span
            v-for="tag in tags"
            :key="tag.name"
            class="mc-tag"
            :style="tag.color ? { '--tag-color': tag.color } : {}"
            >{{ tag.name }}</span
          >
          <span v-if="moreTags" class="mc-more-tags">+{{ moreTags }}</span>
          <span v-if="notify" class="mc-icon" title="等待系统提醒">
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
          <span v-if="copy" class="mc-icon">
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
          </span>
          <span v-if="attachments" class="mc-icon mc-attach">
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
            <span>{{ attachments }}</span>
          </span>
          <span v-if="disclosure" class="mc-icon mc-disclosure">
            <svg viewBox="0 0 16 10" aria-hidden="true"><path d="m2 2 6 6 6-6" /></svg>
          </span>
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
.mc-card {
  --card-surface-opacity: 0.08;
  position: relative;
  display: grid;
  grid-template-columns: 21rem minmax(0, 1fr);
  gap: 9rem;
  min-width: 0;
  padding: 12rem 14rem 11rem;
  border: 1px solid var(--ui-border-divider);
  border-radius: 11rem;
  background: rgb(var(--bg-color) / var(--card-surface-opacity));
  color: var(--text-color);
}
.mc-card--initialized {
  --card-surface-opacity: 0.08;
}
.mc-card--in_progress {
  --card-surface-opacity: 0.14;
}
.mc-card--completed {
  --card-surface-opacity: 0.075;
}
.mc-card--completed::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: rgba(128, 128, 128, 0.1);
  pointer-events: none;
}
.mc-card--completed .mc-body {
  opacity: 0.62;
}

.mc-body {
  position: relative;
  z-index: var(--z-local-content);
  min-width: 0;
}
.mc-text {
  margin: 0;
  color: var(--text-color);
  font-size: var(--fs-body);
  font-weight: 500;
  line-height: 1.45;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
.mc-card--completed .mc-text {
  font-weight: 400;
}

.mc-meta {
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
.mc-context {
  display: flex;
  align-items: center;
  gap: 4rem;
  min-width: 0;
}
.mc-status {
  color: color-mix(in srgb, var(--text-color) 58%, transparent);
  font-weight: 500;
}
.mc-sep {
  opacity: 0.44;
}
.mc-time {
  white-space: nowrap;
}
.mc-utilities {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 5rem;
  min-width: 0;
}
.mc-tag,
.mc-more-tags {
  max-width: 140rem;
  padding: 2rem 6rem;
  overflow: hidden;
  border-radius: 5rem;
  background: color-mix(in srgb, var(--tag-color, var(--text-color)) 9%, transparent);
  color: color-mix(in srgb, var(--tag-color, var(--text-color)) 68%, var(--text-color-secondary));
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mc-more-tags {
  background: transparent;
  color: var(--text-color-secondary);
}
.mc-icon {
  display: flex;
  align-items: center;
  gap: 2rem;
  padding: 2rem 3rem;
  color: color-mix(in srgb, var(--text-color) 45%, transparent);
}
.mc-icon svg {
  display: block;
}
.mc-disclosure svg {
  width: 10rem;
  height: 6rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.6;
}
</style>
