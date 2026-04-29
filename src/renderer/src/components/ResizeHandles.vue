<script setup>
/**
 * ============================================================
 * ResizeHandles.vue — 窗口缩放手柄（公共组件）
 * ============================================================
 * 为无边框透明窗口提供自定义缩放能力。
 *
 * 原理：
 *   frame: false + transparent: true 的 Electron 窗口失去了原生缩放边框，
 *   本组件在窗口四边和四角放置 8 个不可见的热区（绝对定位），
 *   用户拖拽热区时通过 IPC 实时更新窗口的 bounds（位置 + 尺寸）。
 *
 * 8 个方向：
 *   nw ─── n ─── ne
 *   │              │
 *   w              e
 *   │              │
 *   sw ─── s ─── se
 *
 * 数据流：
 *   mousedown（记录起始鼠标坐标 + 起始窗口 bounds）
 *   → mousemove（计算鼠标偏移量，根据方向算出新 bounds，IPC 发送）
 *   → mouseup（清除监听器）
 *
 * 类比 Java Swing：
 *   类似在 JFrame 的 glassPane 上放 8 个透明 JPanel，
 *   监听 MouseMotionListener 并调用 setBounds() 缩放窗口。
 *
 * Props：
 *   minWidth  — 最小宽度（像素），防止窗口缩到不可见
 *   minHeight — 最小高度（像素），防止窗口缩到不可见
 *
 * 使用方式：
 *   <div class="window-frame glass">
 *     <ResizeHandles />
 *     <MacTitlebar ... />
 *     <main> ... </main>
 *   </div>
 */

const props = defineProps({
  minWidth: {
    type: Number,
    default: 200
  },
  minHeight: {
    type: Number,
    default: 120
  }
})

/**
 * startResize — 按下某个缩放手柄时触发
 *
 * @param {string} direction - 缩放方向（'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'nw'）
 * @param {MouseEvent} e     - 原生鼠标事件，用于获取起始屏幕坐标
 *
 * 整体流程：
 *   1. 异步获取当前窗口的 bounds（{ x, y, width, height }）
 *   2. 记录起始鼠标的屏幕坐标（screenX, screenY）
 *   3. 监听 document 的 mousemove / mouseup 事件
 *   4. mousemove 时计算偏移量 dx/dy，根据方向算出新 bounds
 *   5. mouseup 时移除监听器
 *
 * 为什么用 screenX/screenY 而不是 clientX/clientY？
 *   因为缩放时窗口位置在变，clientX 是相对于窗口的，会跳动。
 *   screenX 是相对于屏幕的绝对坐标，不受窗口移动影响。
 */
const startResize = async (direction, e) => {
  // 阻止默认行为（避免拖拽时选中文字等）
  e.preventDefault()

  // 获取当前窗口的矩形区域（异步 IPC，类似 Java 的 Future.get()）
  const initBounds = await window.api.getWindowBounds()
  if (!initBounds) return

  // 记录鼠标按下时的屏幕坐标
  const startX = e.screenX
  const startY = e.screenY

  // 从 props 获取最小尺寸限制

  /**
   * onMouseMove — 鼠标移动时实时计算新 bounds
   *
   * dx = 鼠标水平移动距离（正 = 右移，负 = 左移）
   * dy = 鼠标垂直移动距离（正 = 下移，负 = 上移）
   *
   * 每个方向的计算逻辑不同：
   *   e（右边）：宽度增加 dx，位置不变
   *   w（左边）：x 右移 dx，宽度减少 dx（窗口左边界右移）
   *   s（下边）：高度增加 dy，位置不变
   *   n（上边）：y 下移 dy，高度减少 dy（窗口上边界下移）
   *   角落 = 两个方向的组合
   */
  const onMouseMove = (moveEvent) => {
    const dx = moveEvent.screenX - startX
    const dy = moveEvent.screenY - startY

    // 从初始 bounds 复制一份，避免直接修改原对象
    let newX = initBounds.x
    let newY = initBounds.y
    let newW = initBounds.width
    let newH = initBounds.height

    // 根据方向调整对应的坐标和尺寸
    // includes() 是 JS 字符串方法，检查是否包含某个子串
    // 类似 Java 的 String.contains()

    // 涉及右边（e）的方向：宽度 += dx
    if (direction.includes('e')) {
      newW = initBounds.width + dx
    }

    // 涉及左边（w）的方向：x += dx, 宽度 -= dx
    if (direction.includes('w')) {
      newW = initBounds.width - dx
      newX = initBounds.x + dx
    }

    // 涉及下边（s）的方向：高度 += dy
    if (direction.includes('s')) {
      newH = initBounds.height + dy
    }

    // 涉及上边（n）的方向：y += dy, 高度 -= dy
    if (direction === 'n' || direction === 'nw' || direction === 'ne') {
      newH = initBounds.height - dy
      newY = initBounds.y + dy
    }

    // 最小尺寸约束：防止窗口缩到看不见
    // Math.max(a, b) 取较大值，确保不小于最小限制
    if (newW < props.minWidth) {
      newW = props.minWidth
      // 如果是从左边缩放，还需要修正 x 位置
      if (direction.includes('w')) {
        newX = initBounds.x + initBounds.width - props.minWidth
      }
    }

    if (newH < props.minHeight) {
      newH = props.minHeight
      // 如果是从上边缩放，还需要修正 y 位置
      if (direction === 'n' || direction === 'nw' || direction === 'ne') {
        newY = initBounds.y + initBounds.height - props.minHeight
      }
    }

    // 通过 IPC 让主进程更新窗口矩形区域
    window.api.setWindowBounds({
      x: newX,
      y: newY,
      width: newW,
      height: newH
    })
  }

  /**
   * onMouseUp — 松开鼠标，结束缩放
   * 移除 mousemove 和 mouseup 监听器，恢复正常状态
   */
  const onMouseUp = () => {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
  }

  // 在 document 级别监听，确保鼠标移出窗口后仍能跟踪
  // （Chromium 的 pointer capture 机制会在 mousedown 后持续捕获事件）
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}
</script>

<template>
  <!-- 8 个缩放手柄，绝对定位在 .window-frame（position: relative）内部 -->
  <div class="resize-handle handle-n"  @mousedown="(e) => startResize('n', e)"></div>
  <div class="resize-handle handle-ne" @mousedown="(e) => startResize('ne', e)"></div>
  <div class="resize-handle handle-e"  @mousedown="(e) => startResize('e', e)"></div>
  <div class="resize-handle handle-se" @mousedown="(e) => startResize('se', e)"></div>
  <div class="resize-handle handle-s"  @mousedown="(e) => startResize('s', e)"></div>
  <div class="resize-handle handle-sw" @mousedown="(e) => startResize('sw', e)"></div>
  <div class="resize-handle handle-w"  @mousedown="(e) => startResize('w', e)"></div>
  <div class="resize-handle handle-nw" @mousedown="(e) => startResize('nw', e)"></div>
</template>

<style scoped>
/**
 * ============================================================
 * 缩放手柄样式
 * ============================================================
 * 手柄是 6px 宽的透明热区，绝对定位在容器边缘。
 * 视觉上完全不可见，只通过 cursor 提示用户可以缩放。
 *
 * z-index 设为最高层（z-tooltip），确保手柄不被其他内容遮挡。
 * -webkit-app-region: no-drag — 必须设置，否则在 drag 区域内的
 *   手柄无法接收鼠标事件。
 */

/* 所有手柄共享的基础样式 */
.resize-handle {
  position: absolute;
  z-index: var(--z-tooltip);
  -webkit-app-region: no-drag;
}

/* ----------------------------------------------------------
 * 热区尺寸
 * 6px 是经过多年桌面应用 UX 实践的标准值：
 *   太小 → 难以精确点击
 *   太大 → 容易误触，侵入内容区
 * ---------------------------------------------------------- */

/* 上边 */
.handle-n {
  top: 0;
  left: 6px;
  right: 6px;
  height: 6px;
  cursor: n-resize;
}

/* 下边 */
.handle-s {
  bottom: 0;
  left: 6px;
  right: 6px;
  height: 6px;
  cursor: s-resize;
}

/* 左边 */
.handle-w {
  top: 6px;
  bottom: 6px;
  left: 0;
  width: 6px;
  cursor: w-resize;
}

/* 右边 */
.handle-e {
  top: 6px;
  bottom: 6px;
  right: 0;
  width: 6px;
  cursor: e-resize;
}

/* 左上角 */
.handle-nw {
  top: 0;
  left: 0;
  width: 6px;
  height: 6px;
  cursor: nw-resize;
}

/* 右上角 */
.handle-ne {
  top: 0;
  right: 0;
  width: 6px;
  height: 6px;
  cursor: ne-resize;
}

/* 左下角 */
.handle-sw {
  bottom: 0;
  left: 0;
  width: 6px;
  height: 6px;
  cursor: sw-resize;
}

/* 右下角 */
.handle-se {
  bottom: 0;
  right: 0;
  width: 6px;
  height: 6px;
  cursor: se-resize;
}
</style>
