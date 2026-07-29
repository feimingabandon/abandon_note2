/**
 * 只管理贴边动画的离散状态，不读取或修改任何窗口几何。
 * 坐标、DPI、持久化和原生移动均不属于该对象的职责。
 */
export class DockTransitionState {
  constructor() {
    this.showRequestedDuringHide = false
    this.temporaryAlwaysOnTop = false
  }

  /**
   * @returns {'ignore'|'queued'|'start'} 调用方下一步动作
   */
  requestShow({ hidden, sliding }) {
    if (!hidden) return 'ignore'
    if (sliding) {
      this.showRequestedDuringHide = true
      return 'queued'
    }
    this.showRequestedDuringHide = false
    return 'start'
  }

  consumeQueuedShow() {
    const requested = this.showRequestedDuringHide
    this.showRequestedDuringHide = false
    return requested
  }

  beginTemporaryAlwaysOnTop() {
    this.temporaryAlwaysOnTop = true
  }

  finishTemporaryAlwaysOnTop() {
    this.temporaryAlwaysOnTop = false
  }

  reset() {
    const restoreAlwaysOnTop = this.temporaryAlwaysOnTop
    this.showRequestedDuringHide = false
    this.temporaryAlwaysOnTop = false
    return { restoreAlwaysOnTop }
  }
}
