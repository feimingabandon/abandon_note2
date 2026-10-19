import {
  getWindowMotionSnapshot,
  isWindowDockEdgeExposed,
  moveWindowPhysical
} from '../bridge/blur_bridge.js'
import { getWindowsPlatformCompatibility } from '../../shared/platform-support.js'
import { NativeEdgeMonitor } from './native-edge-monitor.js'

function assertFiniteGeometry(geometry, label) {
  const values = [
    geometry?.x,
    geometry?.y,
    geometry?.width,
    geometry?.height,
    geometry?.workArea?.left,
    geometry?.workArea?.top,
    geometry?.workArea?.right,
    geometry?.workArea?.bottom
  ]
  if (!values.every(Number.isFinite) || geometry.width <= 0 || geometry.height <= 0) {
    throw new Error(`${label}返回了无效窗口几何`)
  }
  return geometry
}

class WindowsPhysicalMotionBackend {
  constructor(window) {
    this.window = window
    this.moving = false
    this.edgeMonitor = new NativeEdgeMonitor(window)
  }

  isMoving() {
    return this.moving
  }

  isDockEdgeExposed(side) {
    return isWindowDockEdgeExposed(this.window, side)
  }

  getEdgeMonitorMessageId() {
    return this.edgeMonitor.getMessageId()
  }

  armEdgeMonitor(side, generation, options) {
    return this.edgeMonitor.arm(side, generation, options)
  }

  disarmEdgeMonitor(generation) {
    return this.edgeMonitor.disarm(generation)
  }

  showPersistentHandle(generation) {
    return this.edgeMonitor.showPersistentHandle(generation)
  }

  setPersistentHandlePosition(positionPermille, generation) {
    return this.edgeMonitor.setPersistentHandlePosition(positionPermille, generation)
  }

  getEdgeMonitorStatus() {
    return this.edgeMonitor.getStatus()
  }

  consumeEdgeMonitorEvent() {
    return this.edgeMonitor.consumeEvent()
  }

  capture() {
    const snapshot = getWindowMotionSnapshot(this.window)
    if (!snapshot?.window?.valid || !snapshot?.monitor?.valid) {
      const error = new Error('无法读取 Windows 窗口或显示器物理边界')
      error.code = 'WINDOW_MOTION_CAPTURE_FAILED'
      error.snapshotState = {
        windowValid: Boolean(snapshot?.window?.valid),
        monitorValid: Boolean(snapshot?.monitor?.valid)
      }
      throw error
    }
    return assertFiniteGeometry(
      {
        coordinateSpace: 'physical',
        x: snapshot.window.left,
        y: snapshot.window.top,
        width: snapshot.window.width,
        height: snapshot.window.height,
        clientWidth: snapshot.window.clientWidth,
        clientHeight: snapshot.window.clientHeight,
        dpi: snapshot.window.dpi,
        workArea: {
          left: snapshot.monitor.workLeft,
          top: snapshot.monitor.workTop,
          right: snapshot.monitor.workRight,
          bottom: snapshot.monitor.workBottom
        }
      },
      'Windows 原生移动后端'
    )
  }

  moveTo(x, y, expectedSize) {
    this.moving = true
    try {
      if (!moveWindowPhysical(this.window, x, y)) {
        const error = new Error(
          `SetWindowPos(SWP_NOSIZE) 移动窗口失败：target=(${Math.round(x)}, ${Math.round(y)})`
        )
        error.code = 'WINDOW_MOTION_MOVE_FAILED'
        error.target = { x: Math.round(x), y: Math.round(y) }
        error.expectedSize = expectedSize || null
        throw error
      }
      const after = this.capture()
      if (
        expectedSize &&
        (after.width !== expectedSize.width || after.height !== expectedSize.height)
      ) {
        throw new Error(
          `Windows 原生移动破坏尺寸不变量：${expectedSize.width}x${expectedSize.height} -> ${after.width}x${after.height}`
        )
      }
      return after
    } finally {
      this.moving = false
    }
  }

  createDockPlan(side, overshootDip) {
    const snapshot = this.capture()
    const physicalOvershoot = Math.max(1, Math.ceil((overshootDip * snapshot.dpi) / 96))
    const visibleX =
      side === 'left'
        ? snapshot.workArea.left
        : side === 'right'
          ? snapshot.workArea.right - snapshot.width
          : snapshot.x
    const visibleY =
      side === 'top'
        ? snapshot.workArea.top
        : side === 'bottom'
          ? snapshot.workArea.bottom - snapshot.height
          : snapshot.y
    const hiddenX =
      side === 'left'
        ? snapshot.workArea.left - snapshot.width - physicalOvershoot
        : side === 'right'
          ? snapshot.workArea.right + physicalOvershoot
          : visibleX
    const hiddenY =
      side === 'top'
        ? snapshot.workArea.top - snapshot.height - physicalOvershoot
        : side === 'bottom'
          ? snapshot.workArea.bottom + physicalOvershoot
          : visibleY

    return {
      side,
      coordinateSpace: snapshot.coordinateSpace,
      initial: snapshot,
      expectedSize: {
        width: snapshot.width,
        height: snapshot.height
      },
      visibleX,
      visibleY,
      hiddenX,
      hiddenY,
      workArea: snapshot.workArea,
      overshoot: physicalOvershoot
    }
  }
}

export function createWindowMotionBackend(window) {
  const compatibility = getWindowsPlatformCompatibility()
  if (!compatibility.success) {
    throw Object.assign(new Error(compatibility.error.message), { code: compatibility.error.code })
  }
  console.log('[dock] 窗口移动后端: Windows 原生物理坐标')
  return new WindowsPhysicalMotionBackend(window)
}
