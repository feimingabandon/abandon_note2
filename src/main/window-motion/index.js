import {
  getWindowMotionSnapshot,
  isWindowDockEdgeExposed,
  moveWindowPhysical
} from '../bridge/blur_bridge.js'
import { isDisplayEdgeExposed } from './dock-edge.js'
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

class ElectronPointMotionBackend {
  constructor(window, screen) {
    this.window = window
    this.screen = screen
    this.moving = false
  }

  isMoving() {
    return this.moving
  }

  isDockEdgeExposed(side) {
    const bounds = this.window.getBounds()
    const display = this.screen.getDisplayMatching(bounds)
    return isDisplayEdgeExposed(display, this.screen.getAllDisplays(), side, bounds)
  }

  getEdgeMonitorMessageId() {
    return null
  }

  armEdgeMonitor() {
    return { success: false, code: null, error: '当前平台没有原生边缘监视器' }
  }

  disarmEdgeMonitor() {
    return true
  }

  showPersistentHandle() {
    return { success: false, code: null, error: '当前平台没有常显小黑条' }
  }

  setPersistentHandlePosition() {
    return { success: false, unsupported: true, code: null, error: '当前平台不能拖动小黑条' }
  }

  getEdgeMonitorStatus() {
    return {
      supported: false,
      state: 'unavailable',
      workerAlive: false,
      generation: 0,
      side: null
    }
  }

  consumeEdgeMonitorEvent() {
    return null
  }

  capture() {
    const bounds = this.window.getBounds()
    const display = this.screen.getDisplayMatching(bounds)
    const workArea = display.workArea
    return assertFiniteGeometry(
      {
        coordinateSpace: 'point',
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        clientWidth: this.window.getContentBounds().width,
        clientHeight: this.window.getContentBounds().height,
        dpi: 96,
        workArea: {
          left: workArea.x,
          top: workArea.y,
          right: workArea.x + workArea.width,
          bottom: workArea.y + workArea.height
        }
      },
      'Electron 移动后端'
    )
  }

  moveTo(x, y, expectedSize) {
    this.moving = true
    try {
      this.window.setPosition(Math.round(x), Math.round(y))
      const after = this.capture()
      if (
        expectedSize &&
        (after.width !== expectedSize.width || after.height !== expectedSize.height)
      ) {
        throw new Error(
          `Electron 移动破坏尺寸不变量：${expectedSize.width}x${expectedSize.height} -> ${after.width}x${after.height}`
        )
      }
      return after
    } finally {
      this.moving = false
    }
  }

  createDockPlan(side, overshootDip) {
    const snapshot = this.capture()
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
        ? snapshot.workArea.left - snapshot.width - overshootDip
        : side === 'right'
          ? snapshot.workArea.right + overshootDip
          : visibleX
    const hiddenY =
      side === 'top'
        ? snapshot.workArea.top - snapshot.height - overshootDip
        : side === 'bottom'
          ? snapshot.workArea.bottom + overshootDip
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
      overshoot: overshootDip
    }
  }
}

export function createWindowMotionBackend(window, screen) {
  if (process.platform === 'win32') {
    console.log('[dock] 窗口移动后端: Windows 原生物理坐标')
    return new WindowsPhysicalMotionBackend(window)
  }
  console.log('[dock] 窗口移动后端: Electron 逻辑坐标')
  return new ElectronPointMotionBackend(window, screen)
}
