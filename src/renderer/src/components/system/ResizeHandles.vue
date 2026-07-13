<script setup>
/**
 * ResizeHandles.vue — 自定义窗口缩放手柄组件
 *
 * 职责：
 *   由于窗口设置了 frame: false（无系统边框），系统原生的缩放功能失效。
 *   本组件在窗口四条边和四个角放置透明的拖拽区域，实现八方向缩放：
 *     - n（上）、s（下）、w（左）、e（右）
 *     - nw（左上）、ne（右上）、sw（左下）、se（右下）
 *
 * 实现原理：
 *   1. 鼠标按下时，通过 IPC 获取当前窗口的 bounds（位置 + 尺寸）
 *   2. 监听 document 上的 mousemove 事件，计算鼠标偏移量 dx/dy
 *   3. 根据拖拽方向计算新的 bounds，并通过 IPC 设置窗口新尺寸
 *   4. 鼠标松开时移除事件监听器
 *
 * 注意事项：
 *   - 整个容器设置 pointer-events: none，仅各手柄区域开启 pointer-events: auto
 *   - z-index: 9999 确保手柄始终在最顶层可交互
 *   - 设置了最小宽高限制（200x200），防止窗口被缩得过小
 */

/** 窗口最小宽度限制（像素） */
const MIN_WIDTH = 200
/** 窗口最小高度限制（像素） */
const MIN_HEIGHT = 200

/** Props */
defineProps({
  locked: {
    type: Boolean,
    default: false
  }
})

/** 拖拽开始时的窗口初始 bounds，用于计算偏移量 */
let startBounds = null

/**
 * 鼠标按下事件处理器 — 启动缩放拖拽
 * @param {MouseEvent} e - 原生鼠标事件
 * @param {string} direction - 拖拽方向标识，由方位字母组合而成
 *   如 'n'（上）、'se'（右下角）、'nw'（左上角）等
 */
async function onMouseDown(e, direction) {
  e.preventDefault() // 阻止默认行为（如文本选择）

  // 通过 IPC 获取当前窗口的位置和尺寸
  startBounds = await window.api.getWindowBounds()
  if (!startBounds) return // 获取失败则不处理

  // 记录鼠标按下时的屏幕坐标（用于计算拖拽距离）
  const startX = e.screenX
  const startY = e.screenY

  /**
   * 鼠标移动处理器 — 实时计算并更新窗口尺寸
   * @param {MouseEvent} ev - 移动事件
   */
  const onMouseMove = (ev) => {
    // 计算相对于起始位置的偏移量
    const dx = ev.screenX - startX // 水平偏移（正值 = 向右）
    const dy = ev.screenY - startY // 垂直偏移（正值 = 向下）

    // 解构当前 bounds 作为计算基准
    let { x, y, width, height } = startBounds

    // 根据方向标识分别处理各方向的缩放逻辑

    // 向东（右）拖拽：增加宽度
    if (direction.includes('e')) width = Math.max(MIN_WIDTH, width + dx)

    // 向南（下）拖拽：增加高度
    if (direction.includes('s')) height = Math.max(MIN_HEIGHT, height + dy)

    // 向西（左）拖拽：减少宽度的同时需要移动窗口 X 坐标
    if (direction.includes('w')) {
      const newW = Math.max(MIN_WIDTH, width - dx)
      x = x + (width - newW) // 右边界不动，左边界跟随鼠标
      width = newW
    }

    // 向北（上）拖拽：减少高度的同时需要移动窗口 Y 坐标
    if (direction.includes('n')) {
      const newH = Math.max(MIN_HEIGHT, height - dy)
      y = y + (height - newH) // 下边界不动，上边界跟随鼠标
      height = newH
    }

    // 通过 IPC 通知主进程更新窗口 bounds
    window.api.setWindowBounds({ x, y, width, height })
  }

  /**
   * 鼠标松开处理器 — 结束缩放，清理事件监听
   */
  const onMouseUp = () => {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
  }

  // 在 document 级别监听，确保鼠标移出窗口边界后仍能继续缩放
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}
</script>

<template>
  <!-- 缩放手柄容器：absolute 定位覆盖整个窗口，自身不捕获事件；锁定后禁用手柄 -->
  <div class="resize-handles" :class="{ locked: locked }">
    <!-- 上边缘手柄 -->
    <div class="rh rh-n" @mousedown="onMouseDown($event, 'n')"></div>
    <!-- 下边缘手柄 -->
    <div class="rh rh-s" @mousedown="onMouseDown($event, 's')"></div>
    <!-- 左边缘手柄 -->
    <div class="rh rh-w" @mousedown="onMouseDown($event, 'w')"></div>
    <!-- 右边缘手柄 -->
    <div class="rh rh-e" @mousedown="onMouseDown($event, 'e')"></div>
    <!-- 左上角手柄 -->
    <div class="rh rh-nw" @mousedown="onMouseDown($event, 'nw')"></div>
    <!-- 右上角手柄 -->
    <div class="rh rh-ne" @mousedown="onMouseDown($event, 'ne')"></div>
    <!-- 左下角手柄 -->
    <div class="rh rh-sw" @mousedown="onMouseDown($event, 'sw')"></div>
    <!-- 右下角手柄 -->
    <div class="rh rh-se" @mousedown="onMouseDown($event, 'se')"></div>
  </div>
</template>

<style scoped>
/* 手柄容器：覆盖整个窗口，不捕获鼠标事件（留给子元素） */
.resize-handles {
  position: absolute;
  inset: 0; /* 等同于 top:0; right:0; bottom:0; left:0 */
  pointer-events: none; /* 容器本身不响应鼠标事件 */
  z-index: 9999; /* 确保在所有内容之上 */
}

/* 单个手柄的公共样式 */
.rh {
  position: absolute;
  pointer-events: auto; /* 手柄区域恢复鼠标事件响应 */
}

/* 锁定状态下禁用手柄交互 */
.resize-handles.locked .rh {
  pointer-events: none;
}

/* ---- 边缘手柄（条形，宽度/高度 5px） ---- */
/* 上边缘：水平条形，留出 6px 避免与角手柄重叠 */
.rh-n {
  top: 0;
  left: 6px;
  right: 6px;
  height: 5px;
  cursor: ns-resize;
}
/* 下边缘 */
.rh-s {
  bottom: 0;
  left: 6px;
  right: 6px;
  height: 5px;
  cursor: ns-resize;
}
/* 左边缘：垂直条形 */
.rh-w {
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 5px;
  cursor: ew-resize;
}
/* 右边缘 */
.rh-e {
  right: 0;
  top: 6px;
  bottom: 6px;
  width: 5px;
  cursor: ew-resize;
}

/* ---- 角手柄（正方形 8x8px，对角线方向光标） ---- */
/* 左上角 */
.rh-nw {
  top: 0;
  left: 0;
  width: 8px;
  height: 8px;
  cursor: nwse-resize;
}
/* 右上角 */
.rh-ne {
  top: 0;
  right: 0;
  width: 8px;
  height: 8px;
  cursor: nesw-resize;
}
/* 左下角 */
.rh-sw {
  bottom: 0;
  left: 0;
  width: 8px;
  height: 8px;
  cursor: nesw-resize;
}
/* 右下角 */
.rh-se {
  bottom: 0;
  right: 0;
  width: 8px;
  height: 8px;
  cursor: nwse-resize;
}
</style>
