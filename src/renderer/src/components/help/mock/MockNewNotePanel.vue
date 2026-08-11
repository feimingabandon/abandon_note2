<script setup>
/**
 * MockNewNotePanel.vue — 新建便签展开面板的静态只读复刻（帮助图解专用）
 *
 * 完整还原展开后的新建面板：关闭按钮、文本域、生效时间、系统提醒、置顶、标签、图片、创建按钮。
 * 各区域用具名标签标注（非编号），方便帮助中心按名称逐项讲解。
 */
</script>

<template>
  <div class="mnp">
    <!-- 关闭按钮 -->
    <button class="mnp-close" aria-label="关闭">
      <svg viewBox="0 0 14 14" width="11" height="11" fill="none">
        <path
          d="M1 1L13 13M1 13L13 1"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        />
      </svg>
    </button>

    <!-- 输入区域 -->
    <div class="mnp-textarea">
      <span class="mnp-placeholder">请新建一次性便签内容…（Enter 换行）</span>
    </div>

    <!-- 生效时间 -->
    <div class="mnp-row">
      <span class="mnp-label">生效时间？</span>
      <span class="mnp-control mnp-select">
        立即生效
        <svg
          viewBox="0 0 16 16"
          width="11"
          height="11"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </span>
    </div>

    <!-- 系统提醒 -->
    <div class="mnp-row">
      <span class="mnp-label">启用系统提醒？</span>
      <span class="mnp-control"
        ><span class="mnp-toggle"><i /></span
      ></span>
    </div>

    <!-- 置顶 -->
    <div class="mnp-row">
      <span class="mnp-label">置顶？</span>
      <span class="mnp-control"
        ><span class="mnp-toggle mnp-toggle--on"><i /></span
      ></span>
    </div>

    <!-- 标签 -->
    <div class="mnp-row mnp-row--tags">
      <span class="mnp-label">标签？</span>
      <div class="mnp-tags">
        <span class="mnp-tag"><i class="mnp-tag-dot" style="background: #ef4444" />重要</span>
        <span class="mnp-tag"><i class="mnp-tag-dot" style="background: #22c55e" />日常</span>
        <span class="mnp-tag-actions">
          <svg
            viewBox="0 0 20 20"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          >
            <path d="M16 7a7 7 0 1 0 .4 5M16 3v4h-4" />
          </svg>
          <svg viewBox="0 0 1024 1024" width="14" height="14" fill="none">
            <path
              d="M512 200V824"
              stroke="currentColor"
              stroke-width="100"
              stroke-linecap="round"
            />
            <path
              d="M200 512H824"
              stroke="currentColor"
              stroke-width="100"
              stroke-linecap="round"
            />
          </svg>
        </span>
      </div>
    </div>

    <!-- 图片 -->
    <div class="mnp-row mnp-row--images">
      <span class="mnp-label">图片？</span>
      <div class="mnp-images">
        <span class="mnp-img-slot">
          <svg viewBox="0 0 1024 1024" width="18" height="18" fill="none">
            <path d="M512 200V824" stroke="currentColor" stroke-width="80" stroke-linecap="round" />
            <path d="M200 512H824" stroke="currentColor" stroke-width="80" stroke-linecap="round" />
          </svg>
        </span>
      </div>
    </div>

    <!-- 创建按钮 -->
    <button class="mnp-submit">创建便签</button>
  </div>
</template>

<style scoped>
.mnp {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12rem;
  padding: 16rem;
  border-radius: 14rem;
  background: rgb(var(--bg-color) / 0.06);
  border: 1px solid var(--ui-border-divider);
}
.mnp-close {
  position: absolute;
  top: 10rem;
  left: 10rem;
  display: grid;
  place-items: center;
  width: 22rem;
  height: 22rem;
  border: none;
  background: none;
  color: var(--text-color-secondary);
  cursor: default;
  pointer-events: none;
}
.mnp-textarea {
  min-height: 72rem;
  padding: 10rem 12rem;
  border: 1px solid var(--ui-border-hover);
  border-radius: 10rem;
  background: rgb(var(--bg-color) / 0.04);
}
.mnp-placeholder {
  color: var(--text-color-secondary);
  font-size: var(--fs-secondary);
  opacity: 0.6;
}
.mnp-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 32rem;
}
.mnp-row--tags,
.mnp-row--images {
  flex-direction: column;
  align-items: flex-start;
  gap: 8rem;
}
.mnp-label {
  color: var(--text-color);
  font-size: var(--fs-secondary);
}
.mnp-control {
  display: flex;
  align-items: center;
}
.mnp-select {
  display: inline-flex;
  align-items: center;
  gap: 4rem;
  padding: 4rem 10rem;
  border: 1px solid var(--ui-border-hover);
  border-radius: 8rem;
  color: var(--text-color);
  font-size: var(--fs-secondary);
}
/* Toggle 开关 */
.mnp-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 38rem;
  height: 22rem;
  border-radius: 11rem;
  background: color-mix(in srgb, var(--text-color) 18%, transparent);
  transition: background 0.2s;
}
.mnp-toggle i {
  position: absolute;
  left: 3rem;
  width: 16rem;
  height: 16rem;
  border-radius: 50%;
  background: white;
  transition: left 0.2s;
}
.mnp-toggle--on {
  background: #34c759;
}
.mnp-toggle--on i {
  left: 19rem;
}
/* 标签 */
.mnp-tags {
  display: flex;
  align-items: center;
  gap: 8rem;
  flex-wrap: wrap;
}
.mnp-tag {
  display: inline-flex;
  align-items: center;
  gap: 5rem;
  padding: 3rem 10rem;
  border-radius: 12rem;
  border: 1px solid var(--ui-border-hover);
  font-size: calc(var(--fs-secondary) * 0.9);
  color: var(--text-color);
}
.mnp-tag-dot {
  width: 7rem;
  height: 7rem;
  border-radius: 50%;
}
.mnp-tag-actions {
  display: flex;
  align-items: center;
  gap: 8rem;
  color: var(--text-color-secondary);
}
/* 图片 */
.mnp-images {
  display: flex;
  gap: 8rem;
}
.mnp-img-slot {
  display: grid;
  place-items: center;
  width: 56rem;
  height: 56rem;
  border: 1px dashed var(--ui-border-hover);
  border-radius: 8rem;
  color: var(--text-color-secondary);
}
/* 创建按钮 */
.mnp-submit {
  width: 100%;
  height: 40rem;
  border: none;
  border-radius: 12rem;
  background: #007aff;
  color: white;
  font-size: var(--fs-body);
  font-weight: 600;
  cursor: default;
  pointer-events: none;
}
</style>
