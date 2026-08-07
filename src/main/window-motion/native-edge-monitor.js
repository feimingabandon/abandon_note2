import {
  armWindowEdgeMonitor,
  consumeWindowEdgeMonitorEvent,
  disarmWindowEdgeMonitor,
  getWindowEdgeMonitorMessageId,
  getWindowEdgeMonitorStatus
} from '../bridge/blur_bridge.js'

export class NativeEdgeMonitor {
  constructor(
    window,
    {
      arm = armWindowEdgeMonitor,
      disarm = disarmWindowEdgeMonitor,
      getStatus = getWindowEdgeMonitorStatus,
      consumeEvent = consumeWindowEdgeMonitorEvent,
      getMessageId = getWindowEdgeMonitorMessageId
    } = {}
  ) {
    this.window = window
    this.armNative = arm
    this.disarmNative = disarm
    this.getStatusNative = getStatus
    this.consumeEventNative = consumeEvent
    this.getMessageIdNative = getMessageId
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
    if (result.success) this.activeGeneration = generation
    return result
  }

  disarm(generation = this.activeGeneration) {
    const stopped = this.disarmNative(generation || 0)
    if (stopped && (!generation || generation === this.activeGeneration)) this.activeGeneration = 0
    return stopped
  }

  getStatus() {
    return this.getStatusNative()
  }

  consumeEvent() {
    return this.consumeEventNative()
  }
}
