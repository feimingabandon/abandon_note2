<script setup>
/**
 * MockSettings.vue — 设置面板整机的静态只读复刻（帮助图解「整机图」专用）
 *
 * 还原设置面板：拖拽条 + 头部（标题 + 关闭）+ 分区（分区标题 + 若干设置项）。
 * 设置项左标签右控件，控件类型覆盖：预设色块 + 十六进制输入、开关、滑块。
 */
</script>

<template>
  <div class="ms-panel">
    <div class="ms-drag"><span /></div>
    <div class="ms-header">
      <span class="ms-title">设置</span>
      <span class="ms-close">
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
          <path
            d="M1 1L13 13M1 13L13 1"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          />
        </svg>
      </span>
    </div>

    <div class="ms-body">
      <section class="ms-section">
        <h5 class="ms-section-title">基础样式</h5>
        <div class="ms-item">
          <span class="ms-label">背景颜色 <span class="ms-q">?</span></span>
          <span class="ms-right">
            <span class="ms-dot" style="background: #1c1c1e" />
            <span class="ms-dot ms-dot--active" style="background: #ffffff" />
            <span class="ms-dot" style="background: #0a84ff" />
            <span class="ms-hex">#FFFFFF</span>
          </span>
        </div>
        <div class="ms-item">
          <span class="ms-label">字体大小 <span class="ms-q">?</span></span>
          <span class="ms-right"><span class="ms-stepper">17</span></span>
        </div>
        <div class="ms-item">
          <span class="ms-label">文字颜色 <span class="ms-q">?</span></span>
          <span class="ms-right">
            <span class="ms-dot ms-dot--active" style="background: #1c1c1e" />
            <span class="ms-dot" style="background: #ffffff" />
            <span class="ms-hex">#1C1C1E</span>
          </span>
        </div>
      </section>

      <section class="ms-section">
        <h5 class="ms-section-title">窗口模糊玻璃与外观</h5>
        <div class="ms-item">
          <span class="ms-label">启用毛玻璃 <span class="ms-q">?</span></span>
          <span class="ms-right"
            ><span class="ms-toggle ms-toggle--on"><i /></span
          ></span>
        </div>
        <div class="ms-item ms-item--slider">
          <span class="ms-label ms-label--slider">模糊半径 <span class="ms-q">?</span></span>
          <span class="ms-slider"
            ><span class="ms-slider-fill" style="width: 52%" /><span
              class="ms-slider-knob"
              style="left: 52%"
          /></span>
          <span class="ms-value">20</span>
        </div>
      </section>

      <section class="ms-section">
        <h5 class="ms-section-title">窗口与数据</h5>
        <div class="ms-item">
          <span class="ms-label">窗口置顶 <span class="ms-q">?</span></span>
          <span class="ms-right"
            ><span class="ms-toggle ms-toggle--on"><i /></span
          ></span>
        </div>
        <div class="ms-item">
          <span class="ms-label">开机自启 <span class="ms-q">?</span></span>
          <span class="ms-right"
            ><span class="ms-toggle"><i /></span
          ></span>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.ms-panel {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--surface-float-border);
  border-radius: 16rem 16rem 0 0;
  background: var(--surface-float);
  overflow: hidden;
}
.ms-drag {
  display: grid;
  place-items: center;
  padding: 6rem 0 2rem;
}
.ms-drag span {
  width: 36rem;
  height: 4rem;
  border-radius: 2rem;
  background: color-mix(in srgb, var(--text-color) 18%, transparent);
}
.ms-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6rem 14rem 10rem;
}
.ms-title {
  font-size: calc(var(--fs-body) * 1.1);
  font-weight: 700;
  color: var(--text-color);
}
.ms-close {
  display: grid;
  place-items: center;
  width: 24rem;
  height: 24rem;
  border-radius: 7rem;
  color: var(--text-color-secondary);
  background: color-mix(in srgb, var(--text-color) 6%, transparent);
}
.ms-body {
  display: flex;
  flex-direction: column;
  gap: 14rem;
  padding: 4rem 12rem 14rem;
}
.ms-section {
  display: flex;
  flex-direction: column;
  gap: 4rem;
}
.ms-section-title {
  margin: 0 0 4rem;
  padding-left: 2rem;
  color: var(--text-color);
  font-size: var(--fs-body);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5rem;
}
.ms-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10rem;
  padding: 10rem 14rem;
  border-radius: 10rem;
  background: rgba(128, 128, 128, 0.05);
}
.ms-label {
  display: inline-flex;
  align-items: center;
  gap: 6rem;
  color: var(--text-color);
  font-size: var(--fs-body);
}
.ms-q {
  display: grid;
  place-items: center;
  width: 15rem;
  height: 15rem;
  border-radius: 50%;
  background: rgba(128, 128, 128, 0.16);
  color: var(--text-color-secondary);
  font-size: calc(var(--fs-secondary) * 0.78);
  font-weight: 700;
}
.ms-right {
  display: inline-flex;
  align-items: center;
  gap: 8rem;
}
.ms-dot {
  width: 18rem;
  height: 18rem;
  border-radius: 50%;
  border: 2rem solid transparent;
  box-shadow: inset 0 0 0 1px rgb(128 128 128 / 0.3);
}
.ms-dot--active {
  border-color: #0a84ff;
}
.ms-hex,
.ms-stepper {
  padding: 3rem 8rem;
  border: 1px solid var(--ui-border-hover);
  border-radius: 7rem;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  font-family: var(--font-family-mono, monospace);
}
.ms-toggle {
  position: relative;
  display: inline-block;
  width: 34rem;
  height: 20rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-color) 22%, transparent);
}
.ms-toggle i {
  position: absolute;
  top: 2rem;
  left: 2rem;
  width: 16rem;
  height: 16rem;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1rem 3rem rgba(0, 0, 0, 0.25);
  transition: none;
}
.ms-toggle--on {
  background: #30d158;
}
.ms-toggle--on i {
  left: auto;
  right: 2rem;
}
.ms-item--slider {
  gap: 8rem;
}
.ms-label--slider {
  flex: 0 0 30%;
  white-space: nowrap;
}
.ms-slider {
  position: relative;
  flex: 1;
  height: 4rem;
  border-radius: 2rem;
  background: color-mix(in srgb, var(--text-color) 16%, transparent);
}
.ms-slider-fill {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  border-radius: 2rem;
  background: #0a84ff;
}
.ms-slider-knob {
  position: absolute;
  top: 50%;
  width: 12rem;
  height: 12rem;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1rem 4rem rgba(0, 0, 0, 0.3);
}
.ms-value {
  flex: 0 0 auto;
  min-width: 26rem;
  text-align: right;
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
}
</style>
