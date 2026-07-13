<script setup>
/**
 * SearchBox.vue — 搜索面板（骨架）
 *
 * 后续将在此实现搜索功能。
 * 面板结构（flex column + scroll-y body + 底部渐隐）与 NewNotePanel 一致。
 */
</script>

<template>
  <div class="sb-root">
    <div class="sb-body scroll-y">
      <!-- 后续实现搜索功能 -->
    </div>
  </div>
</template>

<style scoped>
/* === 根容器（与 NewNotePanel .nnp-root 结构一致） === */
.sb-root {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

/* === 可滚动内容区（底部渐隐 mask 与 NewNotePanel .nnp-body 一致） === */
.sb-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow-x: hidden;
  padding: 0 14rem;
  padding-bottom: 16rem;
  -webkit-mask-image: linear-gradient(
    to bottom,
    black 0%,
    black calc(100% - 30rem),
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    black 0%,
    black calc(100% - 30rem),
    transparent 100%
  );
}
</style>
