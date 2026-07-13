<script setup>
/**
 * MessageToast.vue — Apple 风格消息弹窗
 *
 * 设计参考：
 *   - Apple HIG：圆角、毛玻璃背景、SF 字体、SF Symbol 图标
 *   - Element UI Message：顶部居中、自动消失、TransitionGroup 动画
 *
 * 使用方式：在根组件中 <MessageToast /> 即可，无需传参
 */
import { useMessage } from '../../composables/useMessage.js'

const { messages, closeMessage } = useMessage()

/** 图标映射 */
const iconMap = {
  success: '✓',
  error: '✕',
  warning: '!'
}

/** 图标颜色映射 */
const colorMap = {
  success: '#30d158', // Apple 系统绿
  error: '#ff453a', // Apple 系统红
  warning: '#ff9f0a' // Apple 系统橙
}
</script>

<template>
  <Teleport to="body">
    <div class="msg-container" aria-live="polite">
      <TransitionGroup name="msg">
        <div v-for="m in messages" :key="m.id" class="msg-toast" @click="closeMessage(m.id)">
          <span class="msg-icon" :style="{ color: colorMap[m.type] || colorMap.success }">{{
            iconMap[m.type] || '✓'
          }}</span>
          <span class="msg-text">{{ m.text }}</span>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
/* ---- 容器：固定在视口顶部居中 ---- */
.msg-container {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10000;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}

/* ---- 单条消息 ---- */
.msg-toast {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 18px;
  min-width: 200px;
  max-width: 420px;
  border-radius: 14px;

  /* 背景 = 窗口文字色（反色） + 透明度 */
  background: color-mix(in srgb, var(--text-color) 88%, transparent);

  /* 毛玻璃效果 */
  -webkit-backdrop-filter: blur(var(--bg-blur)) saturate(var(--bg-saturation));
  backdrop-filter: blur(var(--bg-blur)) saturate(var(--bg-saturation));

  box-shadow:
    0 4px 16px rgba(0, 0, 0, 0.28),
    0 0 0 0.5px color-mix(in srgb, var(--text-color) 12%, transparent);

  /* 文字 = 窗口背景色（反色） */
  color: rgb(var(--bg-color));

  font-size: var(--fs-body);
  font-weight: 500;
  letter-spacing: -0.1px;
  cursor: default;
  pointer-events: auto;
  user-select: none;
}

/* ---- 图标 ---- */
.msg-icon {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-secondary);
  font-weight: 700;
  /* 图标圆圈背景 = 窗口文字色（反色）低透明度 */
  background: color-mix(in srgb, var(--text-color) 15%, transparent);
}

/* ---- 文本 ---- */
.msg-text {
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ============ TransitionGroup 动画 ============ */

/* 入场：从上方滑入 + 淡入 */
.msg-enter-active {
  transition:
    opacity 280ms cubic-bezier(0.22, 1, 0.36, 1),
    transform 350ms cubic-bezier(0.22, 1, 0.36, 1);
}
.msg-enter-from {
  opacity: 0;
  transform: translateY(-12px) scale(0.94);
}

/* 出场：淡出 + 上移 */
.msg-leave-active {
  transition:
    opacity 200ms ease-out,
    transform 220ms ease-out;
  position: absolute; /* 避免占据空间影响后续消息位置 */
}
.msg-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.96);
}

/* TransitionGroup 需要 move 过渡 */
.msg-move {
  transition: transform 280ms cubic-bezier(0.22, 1, 0.36, 1);
}
</style>
