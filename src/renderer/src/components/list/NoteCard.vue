<script setup>
/**
 * NoteCard.vue — 便签卡片组件
 *
 * 可复用的便签列表项，在时间线模式和自定义拖拽模式中统一使用。
 */
defineProps({
  /** 便签数据对象 */
  note: { type: Object, required: true },
  /** 是否显示拖拽手柄（自定义拖拽模式） */
  draggable: { type: Boolean, default: false },
  /** 是否为过期/归档样式（自定义模式过期区） */
  muted: { type: Boolean, default: false },
  /** 入场动画延迟（ms 字符串，如 "40ms"） */
  animationDelay: { type: String, default: '0ms' }
})

const emit = defineEmits(['select'])

/** 状态 value → label 映射 */
const statusLabelMap = { active: '待生效', in_progress: '进行中', completed: '已完成', cancelled: '已取消', expired: '已过期' }
function statusLabel(s) {
  return statusLabelMap[s] || s
}
</script>

<template>
  <div
    class="nl-card nl-card-anim"
    :class="{
      'nl-card--draggable': draggable,
      'nl-card--muted': muted
    }"
    :style="{ animationDelay }"
    @click="emit('select', note)"
  >
    <span v-if="draggable" class="nl-handle">⠿</span>
    <div class="nl-card-body">
      <span class="nl-card-text">{{ note.content || '（空内容）' }}</span>
      <div class="nl-card-meta">
        <span class="nl-card-status" :class="'nl-status--' + note.status">{{ statusLabel(note.status) }}</span>
        <span
          v-for="tag in note.tags"
          :key="tag.id"
          class="nl-card-tag"
          :style="tag.color ? { backgroundColor: tag.color + '22', color: tag.color } : {}"
        >{{ tag.name }}</span>
      </div>
    </div>
  </div>
</template>

<style>
/* 全局关键帧：NoteList.vue 的 .nl-chip-anim 也需要引用此动画，故不走 scoped */
@keyframes nl-card-in {
  from {
    opacity: 0;
    transform: translateY(6rem);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>

<style scoped>
/* ===== 列表卡片逐条入场（依次淡入上浮，延迟由 :style 按序号注入） ===== */
.nl-card-anim {
  animation: nl-card-in 250ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

/* ===== 便签卡片 ===== */
.nl-card {
  display: flex;
  align-items: flex-start;
  gap: 8rem;
  padding: 10rem 12rem;
  margin: 2rem 0;
  border-radius: 8rem;
  cursor: pointer;
  transition: background-color 120ms ease;
}
.nl-card:hover {
  background: rgba(255, 255, 255, 0.06);
}
.nl-card--draggable {
  cursor: grab;
}
.nl-card--muted {
  cursor: default;
  opacity: 0.7;
}
.nl-handle {
  font-size: var(--fs-body);
  color: var(--text-color-secondary);
  margin-top: 2rem;
  opacity: 0;
  transition: opacity 120ms ease;
  flex-shrink: 0;
}
.nl-card:hover .nl-handle {
  opacity: 1;
}
.nl-card-body {
  flex: 1;
  min-width: 0;
}
.nl-card-text {
  font-size: var(--fs-body);
  color: var(--text-color);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.nl-card-meta {
  display: flex;
  align-items: center;
  gap: 6rem;
  flex-wrap: wrap;
  margin-top: 6rem;
}
.nl-card-status {
  font-size: calc(var(--fs-secondary) * 0.88);
  padding: 2rem 6rem;
  border-radius: 4rem;
  background: rgba(128, 128, 128, 0.12);
}
.nl-status--active {
  background: rgba(0, 122, 255, 0.12);
}
.nl-status--in_progress {
  background: rgba(255, 149, 0, 0.12);
}
.nl-status--completed {
  background: rgba(52, 199, 89, 0.12);
}
.nl-card-tag {
  font-size: calc(var(--fs-secondary) * 0.85);
  padding: 1rem 5rem;
  border-radius: 3rem;
}
</style>
