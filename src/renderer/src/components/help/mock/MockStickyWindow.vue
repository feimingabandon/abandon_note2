<template>
  <div class="msw-window">
    <header class="msw-toolbar">
      <div class="msw-actions">
        <button>A−</button>
        <button>A+</button>
        <button>颜色</button>
        <button class="is-pinned">已置顶</button>
      </div>
      <div class="msw-drag-area" aria-hidden="true"></div>
      <div class="msw-actions msw-actions--close"><button aria-label="关闭">×</button></div>
    </header>
    <main class="msw-content">
      <div class="msw-content-scroll">
        下午 3 点和设计团队确认交互稿。
        重点确认帮助中心的滑入动效、只读预览方案，以及便利贴在桌面上的实际展示效果。
      </div>
    </main>
  </div>
</template>

<style scoped>
.msw-window {
  /* 固定黄底和深色文字用于复刻产品默认便利贴，不属于帮助页的中性表面体系。 */
  display: grid;
  grid-template-rows: 30rem minmax(0, 1fr);
  width: min(100%, 360rem);
  min-height: 260rem;
  overflow: hidden;
  border-radius: 8rem;
  background: #fff2a8;
  color: #1f2328;
  box-shadow: 0 12rem 28rem rgb(0 0 0 / 0.18);
}
.msw-toolbar {
  display: flex;
  align-items: center;
  min-width: 0;
  height: 30rem;
}
.msw-actions {
  display: flex;
  align-items: center;
  gap: 1rem;
  height: 100%;
  padding-left: 3rem;
  color: color-mix(in srgb, #1f2328 48%, transparent);
}
.msw-actions--close {
  padding-right: 3rem;
  padding-left: 0;
}
.msw-actions button {
  min-width: 27rem;
  height: 23rem;
  padding: 0 6rem;
  border: 0;
  border-radius: 3rem;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11rem;
  line-height: 1;
  pointer-events: none;
}
.msw-actions .is-pinned {
  background: color-mix(in srgb, #1f2328 11%, transparent);
  color: #1f2328;
}
.msw-actions--close button {
  min-width: 24rem;
  padding: 0;
  font-size: 18rem;
}
.msw-drag-area {
  flex: 1;
  min-width: 10rem;
  height: 100%;
}
.msw-content {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 0 16rem 18rem;
  font-size: 16rem;
  line-height: 1.55;
}
.msw-content-scroll {
  width: 100%;
  height: 100%;
  overflow: hidden;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
