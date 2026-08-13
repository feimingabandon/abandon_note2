<script setup>
/**
 * MockActionBar.vue — ActionBar 折叠态的静态只读复刻（帮助图解专用）
 *
 * 还原顶部两枚操作框：左「新建」（＋ 图标 + 提示语）、右「搜索」（放大镜 + 提示语）。
 * 可通过 grow 指定哪一侧更宽（呼应真实的左右权重反馈）。
 */
defineProps({
  /** 'new' | 'search'：哪一侧作为当前较宽的活跃框。 */
  grow: { type: String, default: 'new' }
})
</script>

<template>
  <div class="mab-root">
    <div class="mab-box" :class="{ 'mab-box--grow': grow === 'new' }">
      <span class="mab-btn">
        <svg class="mab-icon" viewBox="0 0 1024 1024">
          <path
            d="M 512 200 V 824"
            fill="none"
            stroke="currentColor"
            stroke-width="100"
            stroke-linecap="round"
          />
          <path
            d="M 200 512 H 824"
            fill="none"
            stroke="currentColor"
            stroke-width="100"
            stroke-linecap="round"
          />
        </svg>
      </span>
      <span class="mab-hint">请新建一次性便签内容…</span>
    </div>
    <div class="mab-box mab-box--search" :class="{ 'mab-box--grow': grow === 'search' }">
      <span class="mab-btn">
        <svg class="mab-icon" viewBox="0 0 1024 1024">
          <circle cx="370" cy="370" r="210" fill="none" stroke="currentColor" stroke-width="100" />
          <path
            d="M 530 530 L 780 780"
            fill="none"
            stroke="currentColor"
            stroke-width="100"
            stroke-linecap="round"
          />
        </svg>
      </span>
      <span class="mab-hint">请输入搜索内容</span>
    </div>
  </div>
</template>

<style scoped>
.mab-root {
  display: flex;
  align-items: flex-start;
  gap: 6rem;
}
.mab-box {
  position: relative;
  display: flex;
  align-items: center;
  flex-grow: 0;
  flex-shrink: 0;
  flex-basis: 36rem;
  height: 36rem;
  overflow: hidden;
  border: 1px solid var(--ui-border-control);
  border-radius: 10rem;
  background: var(--ui-fill-hover);
}
.mab-box--grow {
  flex-grow: 1;
}
.mab-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36rem;
  height: 36rem;
  color: var(--text-color);
}
.mab-icon {
  width: 15rem;
  height: 15rem;
}
.mab-box--search .mab-btn {
  order: 2;
  margin-left: auto;
}
.mab-box--search .mab-hint {
  order: 1;
}
.mab-hint {
  overflow: hidden;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  white-space: nowrap;
  text-overflow: ellipsis;
  opacity: 0.75;
}
</style>
