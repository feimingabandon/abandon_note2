<script setup>
/**
 * AppTitlebar.vue — 可切换 Apple / Microsoft 视觉的自定义标题栏组件
 *
 * 职责：
 *   1. 提供关闭、置顶、锁定窗口控制，视觉风格不改变功能语义
 *   2. 展示窗口标题文字
 *   3. 通过 slot 支持在标题栏右侧插入自定义操作按钮
 *   4. 整个标题栏区域可拖拽移动窗口（-webkit-app-region: drag）
 *
 * Props:
 *   - title {String} 标题栏显示的文字，默认为空
 *   - locked {Boolean} 窗口锁定状态
 *   - alwaysOnTop {Boolean} 窗口置顶状态
 *   - styleVariant {'apple'|'microsoft'} 标题栏视觉风格
 */

// 定义组件接收的 props
defineProps({
  title: {
    type: String,
    default: ''
  },
  locked: {
    type: Boolean,
    required: true
  },
  alwaysOnTop: {
    type: Boolean,
    required: true
  },
  styleVariant: {
    type: String,
    default: 'apple',
    validator: (value) => value === 'apple' || value === 'microsoft'
  }
})

const emit = defineEmits(['update:locked', 'update:alwaysOnTop'])

// ---- 窗口控制事件处理函数 ----
/** 关闭窗口：通过 preload 暴露的 API 发送 IPC 消息到主进程 */
const close = () => window.api.closeWindow()
/** 切换置顶/取消置顶状态 */
const toggleAlwaysOnTop = async () => {
  try {
    const newState = await window.api.toggleAlwaysOnTop()
    emit('update:alwaysOnTop', newState)
  } catch (e) {
    console.warn('[AppTitlebar] 切换置顶失败:', e)
  }
}
/** 切换锁定/解锁状态 */
const toggleLock = async () => {
  try {
    const newState = await window.api.toggleLock()
    emit('update:locked', newState)
  } catch (e) {
    console.warn('[AppTitlebar] 切换锁定失败:', e)
  }
}
</script>

<template>
  <!-- 标题栏容器：整体可拖拽（-webkit-app-region: drag），锁定后禁用拖拽 -->
  <header
    class="app-titlebar"
    :class="[`app-titlebar--${styleVariant}`, { locked: locked }]"
    :data-style="styleVariant"
  >
    <!-- 红绿灯按钮组：设置 no-drag 使按钮可点击 -->
    <div class="traffic-lights">
      <!-- 关闭按钮(红色) -->
      <button class="light light-close" title="关闭" @click="close">
        <img class="light-icon" src="@/resources/icons/close.png" alt="关闭" />
      </button>
      <!-- 置顶切换按钮(黄色=已置顶 / 灰色=未置顶) -->
      <button
        class="light light-pin"
        :class="{ pinned: alwaysOnTop }"
        :title="alwaysOnTop ? '取消置顶' : '窗口置顶'"
        @click="toggleAlwaysOnTop"
      >
        <img class="light-icon" src="@/resources/icons/pin.svg" alt="置顶" />
      </button>
      <!-- 锁定按钮（绿色=未锁 / 橙色=已锁） -->
      <button
        class="light light-lock"
        :class="{ locked: locked }"
        :title="locked ? '解锁' : '锁定'"
        @click="toggleLock"
      >
        <img class="light-icon" src="@/resources/icons/lock.png" alt="锁定" />
      </button>
    </div>
    <!-- 标题文字，仅当 title prop 非空时显示 -->
    <span v-if="title" class="app-titlebar-title">{{ title }}</span>
    <!-- 右侧操作区域插槽，父组件可插入自定义按钮 -->
    <div class="app-titlebar-actions">
      <slot />
    </div>
  </header>
</template>

<style scoped>
/* 标题栏容器：flex 响应式三栏布局，支持拖拽移动窗口
 * 左（红绿灯）· 中（标题 flex:1）· 右（操作按钮），随窗口宽度自适应 */
.app-titlebar {
  display: flex;
  align-items: center; /* 垂直居中对齐 */
  padding: 14px 16px; /* 内边距，总高 14+18+14+1(border)=47rem ≈ 48px Apple 导航标准 */
  -webkit-app-region: drag; /* 允许通过此区域拖拽移动窗口 */
  flex-shrink: 0; /* 禁止在 flex 布局中被压缩 */
  gap: 8px; /* 子元素间距 */
  border-bottom: 1px solid rgb(var(--bg-color) / 0.1); /* 标题栏底部分割线 */
}

/* 红绿灯按钮容器 */
.traffic-lights {
  display: flex;
  gap: 8px; /* 按钮间距 8px */
  -webkit-app-region: no-drag; /* 取消拖拽，使按钮可以响应点击事件 */
}

/* 单个红绿灯按钮的基础样式 */
.light {
  width: 18rem; /* 按钮直径（响应式 rem 单位） */
  height: 18rem;
  border-radius: 50%; /* 圆形 */
  border: none;
  padding: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    opacity var(--motion-fast) ease,
    background-color var(--motion-control) ease,
    transform var(--motion-control) var(--ease-standard); /* 悬停与状态过渡 */
}

/* 按钮内的图标 */
.light-icon {
  width: 14rem; /* 图标大小 */
  height: 14rem;
  opacity: 0; /* 默认隐藏图标 */
  transition: opacity 120ms ease;
  display: block; /* 确保正确居中 */
}

/* 鼠标悬停在按钮组上时，显示所有图标（模拟 macOS 行为） */
.traffic-lights:hover .light-icon {
  opacity: 1;
}
.light:active {
  transform: scale(0.86);
  transition-duration: 70ms;
}
.light.pinned .light-icon,
.light.locked .light-icon {
  animation: light-state-in var(--motion-control) var(--ease-standard);
}
@keyframes light-state-in {
  from {
    opacity: 0;
    transform: scale(0.75);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

/* 各按钮的默认背景色（模拟 macOS 红绿灯） */
.light-close {
  background-color: #ff5f57;
} /* 红色 - 关闭 */
.light-pin {
  background-color: #8e8e93;
} /* 灰色 - 未置顶 */
.light-pin.pinned {
  background-color: #febc2e;
} /* 黄色 - 已置顶（原最小化色） */
.light-lock {
  background-color: #28c840;
} /* 绿色 - 未锁定 */

/* 各按钮悬停时的加深背景色 */
.light-close:hover {
  background-color: #ff4136;
}
.light-pin:hover {
  background-color: #7c7c80;
}
.light-pin.pinned:hover {
  background-color: #f5a623;
}
.light-lock:hover {
  background-color: #1db954;
}

/* 锁定状态：按钮变橙色 */
.light-lock.locked {
  background-color: #ff9f0a;
}
.light-lock.locked:hover {
  background-color: #e08e00;
}

/* 锁定状态下标题栏不可拖拽 */
.app-titlebar.locked {
  -webkit-app-region: no-drag;
}

/* 标题文字：正文大小、居中、flex:1 占据中间剩余空间 */
.app-titlebar-title {
  font-size: var(--fs-body); /* 正文字号（跟随 --font-size-base 响应式缩放） */
  font-weight: 600; /* OPPOSans Bold，更圆润 */
  color: var(--text-color); /* 使用全局文字颜色变量 */
  flex: 1; /* 占据中间所有剩余空间，左右等宽按钮组自然居中 */
  text-align: center; /* 文字在 flex 区域内居中 */
}

/* 右侧操作按钮区域 */
.app-titlebar-actions {
  display: flex;
  gap: 8px;
  margin-left: auto; /* 标题移除后，仍保持靠右对齐 */
  -webkit-app-region: no-drag; /* 取消拖拽，使操作按钮可点击 */
}

/* Windows 11 / Fluent 取向：业务操作靠左，窗口操作靠右，关闭按钮位于最右端。 */
.app-titlebar--microsoft {
  min-height: 47px;
  padding: 8px 8px 8px 16px;
  gap: 2rem;
}
.app-titlebar--microsoft .traffic-lights {
  order: 3;
  gap: 2rem;
  margin-left: auto;
}
.app-titlebar--microsoft .app-titlebar-title {
  order: 2;
  text-align: left;
}
.app-titlebar--microsoft .app-titlebar-actions {
  order: 1;
  margin-left: 0;
}
.app-titlebar--microsoft .light {
  width: 32rem;
  height: 30rem;
  border-radius: 4rem;
  color: var(--text-color);
  background-color: transparent;
}
.app-titlebar--microsoft .light-icon {
  width: 15rem;
  height: 15rem;
  opacity: 0.72;
}
.app-titlebar--microsoft .traffic-lights:hover .light-icon {
  opacity: 0.72;
}
.app-titlebar--microsoft .light:hover {
  background-color: color-mix(in srgb, var(--text-color) 9%, transparent);
}
.app-titlebar--microsoft .light:hover .light-icon {
  opacity: 1;
}
.app-titlebar--microsoft .light-pin.pinned,
.app-titlebar--microsoft .light-lock.locked {
  background-color: color-mix(in srgb, #0078d4 18%, transparent);
}
.app-titlebar--microsoft .light-pin.pinned:hover,
.app-titlebar--microsoft .light-lock.locked:hover {
  background-color: color-mix(in srgb, #0078d4 26%, transparent);
}
.app-titlebar--microsoft .light-close {
  order: 3;
}
.app-titlebar--microsoft .light-close:hover {
  background-color: #c42b1c;
}
</style>
