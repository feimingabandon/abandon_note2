<script setup>
/**
 * MacTitlebar.vue — Mac 风格自定义标题栏组件
 *
 * 职责：
 *   1. 提供 macOS 风格的"红绿灯"窗口控制按钮（关闭、最小化、最大化）
 *   2. 展示窗口标题文字
 *   3. 通过 slot 支持在标题栏右侧插入自定义操作按钮
 *   4. 整个标题栏区域可拖拽移动窗口（-webkit-app-region: drag）
 *
 * Props:
 *   - title {String} 标题栏显示的文字，默认为空
 */

// 定义组件接收的 props
const props = defineProps({
  title: {
    type: String,
    default: ''
  },
  locked: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['update:locked'])

// ---- 窗口控制事件处理函数 ----
/** 关闭窗口：通过 preload 暴露的 API 发送 IPC 消息到主进程 */
const close = () => window.api.closeWindow()
/** 最小化窗口 */
const minimize = () => window.api.minimizeWindow()
/** 切换锁定/解锁状态 */
const toggleLock = async () => {
  try {
    const newState = await window.api.toggleLock()
    emit('update:locked', newState)
  } catch (e) {
    console.warn('[MacTitlebar] 切换锁定失败:', e)
  }
}
</script>

<template>
  <!-- 标题栏容器：整体可拖拽（-webkit-app-region: drag），锁定后禁用拖拽 -->
  <header class="mac-titlebar" :class="{ locked: locked }">
    <!-- 红绿灯按钮组：设置 no-drag 使按钮可点击 -->
    <div class="traffic-lights">
      <!-- 关闭按钮(红色) -->
      <button class="light light-close" @click="close" title="关闭">
        <img class="light-icon" src="@/resources/icons/close.png" alt="关闭" />
      </button>
      <!-- 最小化按钮(黄色) -->
      <button class="light light-minimize" @click="minimize" title="最小化">
        <img class="light-icon" src="@/resources/icons/minimize.png" alt="最小化" />
      </button>
      <!-- 锁定按钮（绿色=未锁 / 橙色=已锁） -->
      <button
        class="light light-lock"
        :class="{ locked: locked }"
        @click="toggleLock"
        :title="locked ? '解锁' : '锁定'">
        <img class="light-icon" src="@/resources/icons/lock.png" alt="锁定" />
      </button>
    </div>
    <!-- 标题文字，仅当 title prop 非空时显示 -->
    <span v-if="title" class="mac-titlebar-title">{{ title }}</span>
    <!-- 右侧操作区域插槽，父组件可插入自定义按钮 -->
    <div class="mac-titlebar-actions">
      <slot />
    </div>
  </header>
</template>

<style scoped>
/* 标题栏容器：水平排列，支持拖拽移动窗口 */
.mac-titlebar {
  display: flex;
  align-items: center; /* 垂直居中对齐 */
  padding: 12px 16px; /* 内边距 */
  -webkit-app-region: drag; /* 允许通过此区域拖拽移动窗口 */
  flex-shrink: 0; /* 禁止在 flex 布局中被压缩 */
  gap: 8px; /* 子元素间距 */
  border-bottom: 1px solid rgba(0, 0, 0, 0.08); /* 标题栏底部分割线 */
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
  transition: opacity 120ms ease; /* 悬停过渡动画 */
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

/* 各按钮的默认背景色（模拟 macOS 红绿灯） */
.light-close { background-color: #ff5f57; } /* 红色 - 关闭 */
.light-minimize { background-color: #febc2e; } /* 黄色 - 最小化 */
.light-lock { background-color: #28c840; } /* 绿色 - 未锁定 */

/* 各按钮悬停时的加深背景色 */
.light-close:hover { background-color: #ff4136; }
.light-minimize:hover { background-color: #f5a623; }
.light-lock:hover { background-color: #1db954; }

/* 锁定状态：按钮变橙色 */
.light-lock.locked { background-color: #ff9f0a; }
.light-lock.locked:hover { background-color: #e08e00; }

/* 锁定状态下标题栏不可拖拽 */
.mac-titlebar.locked {
  -webkit-app-region: no-drag;
}

/* 标题文字样式 */
.mac-titlebar-title {
  font-size: var(--fs-title); /* 标题字号（响应式） */
  font-weight: 600; /* MiSans Medium，更圆润 */
  color: var(--text-color); /* 使用全局文字颜色变量 */
  flex: 1; /* 占据中间所有剩余空间，实现左右分布布局 */
}

/* 右侧操作按钮区域 */
.mac-titlebar-actions {
  display: flex;
  gap: 8px;
  margin-left: auto; /* 标题移除后，仍保持靠右对齐 */
  -webkit-app-region: no-drag; /* 取消拖拽，使操作按钮可点击 */
}
</style>
