import {
  armWindowEdgeMonitor,
  consumeWindowEdgeMonitorEvent,
  disarmWindowEdgeMonitor,
  getWindowEdgeMonitorMessageId,
  getWindowEdgeMonitorStatus,
  setWindowPersistentHandlePosition,
  showWindowPersistentHandle
} from '../bridge/blur_bridge.js'

export class NativeEdgeMonitor {
  constructor(
    window,
    {
      arm = armWindowEdgeMonitor,
      disarm = disarmWindowEdgeMonitor,
      getStatus = getWindowEdgeMonitorStatus,
      consumeEvent = consumeWindowEdgeMonitorEvent,
      getMessageId = getWindowEdgeMonitorMessageId,
      setPersistentHandlePosition = setWindowPersistentHandlePosition,
      showPersistentHandle = showWindowPersistentHandle
    } = {}
  ) {
    this.window = window
    this.armNative = arm
    this.disarmNative = disarm
    this.getStatusNative = getStatus
    this.consumeEventNative = consumeEvent
    this.getMessageIdNative = getMessageId
    this.setPersistentHandlePositionNative = setPersistentHandlePosition
    this.showPersistentHandleNative = showPersistentHandle
    this.activeGeneration = 0
  }

  getMessageId() {
    return this.getMessageIdNative()
  }

  arm(side, generation, options) {
    if (this.activeGeneration) {
      return { success: false, code: -8, error: '已经存在活动的原生边缘监视器' }
    }
    const result = this.armNative(this.window, side, generation, options)
    // 启动超时表示原生线程可能仍在完成不可中断的系统初始化；必须保留代次，
    // 让主进程的 cleanup-pending 流程持续 Disarm，不能误以为没有活动资源。
    if (result.success || result.cleanupRequired) this.activeGeneration = generation
    return result
  }

  disarm(generation = this.activeGeneration) {
    const stopped = this.disarmNative(generation || 0)
    if (stopped && (!generation || generation === this.activeGeneration)) this.activeGeneration = 0
    return stopped
  }

  showPersistentHandle(generation = this.activeGeneration) {
    if (!generation || generation !== this.activeGeneration) {
      return { success: false, code: -11, error: '贴边会话代次无效' }
    }
    return this.showPersistentHandleNative(generation)
  }

  setPersistentHandlePosition(positionPermille, generation = this.activeGeneration) {
    if (!generation || generation !== this.activeGeneration) {
      return { success: false, code: -11, error: '贴边会话代次无效' }
    }
    return this.setPersistentHandlePositionNative(generation, positionPermille)
  }

  getStatus() {
    return this.getStatusNative()
  }

  consumeEvent() {
    return this.consumeEventNative()
  }
}
