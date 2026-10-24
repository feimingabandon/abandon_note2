import { onBeforeUnmount } from 'vue'

export const identifiers = ({ sessionId, deliveryId }) => ({ sessionId, deliveryId })

/** A single receiver owns progress, cancellation and the final ACK for these exact ids. */
export function createCaptureDeliveryOperation(
  delivery,
  { api = window.api, current = () => true } = {}
) {
  const identity = identifiers(delivery)
  let active = true
  let terminal = null
  let settling = false
  let stop = null
  let resolveCancellation
  const cancellations = new Set()
  const cancelled = new Promise((resolve) => {
    resolveCancellation = resolve
  })
  const expired = () =>
    Object.assign(new Error('截图交付已结束，请保留已暂存内容后重试'), {
      code: 'CAPTURE_DELIVERY_EXPIRED'
    })
  const isCurrent = () => active && current()

  function end(state, message) {
    if (!active) return
    active = false
    terminal = state
    stop?.()
    stop = null
    if (state === 'rejected') {
      resolveCancellation(expired())
      for (const callback of cancellations) {
        try {
          callback(message)
        } catch (error) {
          console.warn('[ScreenCapture] 取消截图接收清理失败:', error)
        }
      }
    }
    cancellations.clear()
  }
  stop = api.onScreenshotDeliveryState((state) => {
    if (
      state?.sessionId !== identity.sessionId ||
      state.deliveryId !== identity.deliveryId ||
      !['accepted', 'rejected'].includes(state.state)
    )
      return
    end(state.state, state.message)
  })

  function cancel(message = '截图接收来源已失效', { notify = true } = {}) {
    const shouldNotify = active && !settling && notify
    end('rejected', message)
    if (shouldNotify) {
      try {
        Promise.resolve(api.acknowledgeScreenshot({ ...identity, accepted: false, message })).catch(
          (error) => console.warn('[ScreenCapture] 取消截图交付回执失败:', error)
        )
      } catch (error) {
        console.warn('[ScreenCapture] 取消截图交付回执失败:', error)
      }
    }
  }
  function assertCurrent() {
    if (!isCurrent()) throw expired()
  }
  return {
    identity,
    isCurrent,
    assertCurrent,
    cancel,
    onCancel(callback) {
      if (terminal === 'rejected') callback()
      else if (active) cancellations.add(callback)
      return () => cancellations.delete(callback)
    },
    async wait(task) {
      assertCurrent()
      const value = await Promise.race([
        task,
        cancelled.then((error) => {
          throw error
        })
      ])
      assertCurrent()
      return value
    },
    async report(state) {
      if (!isCurrent() || settling) return false
      const accepted = await api.reportScreenshotDelivery({ ...identity, state })
      if (accepted !== true) cancel('截图交付已失效', { notify: false })
      return accepted === true && isCurrent()
    },
    async finish(accepted, message = '') {
      if (!isCurrent() || settling) return false
      settling = true
      try {
        const result = await api.acknowledgeScreenshot({
          ...identity,
          accepted: accepted === true,
          message
        })
        if (active) end(result === true && accepted === true ? 'accepted' : 'rejected', message)
        return result === true && terminal === 'accepted'
      } catch (error) {
        end('rejected', error.message)
        console.warn('[ScreenCapture] 截图交付回执失败:', error)
        return false
      }
    }
  }
}

export function useScreenCapture() {
  let session = null
  let disposed = false
  onBeforeUnmount(() => {
    disposed = true
    session?.invalidate()
  })
  async function capture(origin, accept) {
    if (disposed) throw new Error('截图来源已关闭')
    if (session) throw new Error('已有截图会话正在进行')
    const token = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const owner = { active: true, delivery: null }
      session = owner
      const stopDelivery = window.api.onScreenshotDelivery(async (delivery) => {
        if (!owner.active || delivery.token !== token || delivery.action !== 'source') return
        if (owner.delivery?.identity?.deliveryId === delivery.deliveryId) return
        owner.delivery?.cancel('截图交付已被替换', { notify: false })
        const operation = createCaptureDeliveryOperation(delivery, {
          current: () => owner.active && session === owner && !disposed
        })
        owner.delivery = operation
        try {
          if (!(await operation.report('received')) || !(await operation.report('processing')))
            return
          const accepted = await accept(delivery, operation)
          await operation.finish(
            accepted,
            accepted === true ? '' : '未能接收图片，请检查附件上限或重新打开来源页面'
          )
        } catch (error) {
          await operation.finish(false, error.message)
        } finally {
          operation.cancel('截图接收回调已结束', { notify: false })
          if (owner.delivery === operation) owner.delivery = null
        }
      })
      const stopFinished = window.api.onScreenshotFinished((result) => {
        if (!owner.active || result.token !== token) return
        cleanup()
        resolve(result)
      })
      const cleanup = () => {
        owner.active = false
        owner.delivery?.cancel('截图会话已结束', { notify: false })
        stopDelivery()
        stopFinished()
        if (session === owner) session = null
      }
      owner.invalidate = () => {
        cleanup()
        void window.api
          .invalidateScreenshotSource(token)
          .catch((error) => console.warn('[ScreenCapture] 注销截图来源失败:', error))
        resolve({ status: 'source-gone' })
      }
      window.api
        .captureScreen({ origin, token })
        .then((result) => {
          if (!owner.active) return
          if (result.status !== 'started') {
            cleanup()
            reject(new Error(result.status === 'busy' ? '已有截图会话正在进行' : '截图未能启动'))
          }
        })
        .catch((error) => {
          if (!owner.active) return
          cleanup()
          reject(error)
        })
    })
  }
  capture.invalidate = () => session?.invalidate()
  return capture
}
