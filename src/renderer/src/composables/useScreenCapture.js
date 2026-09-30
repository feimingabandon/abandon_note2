import { onBeforeUnmount } from 'vue'

export function useScreenCapture() {
  let dispose = null
  onBeforeUnmount(() => dispose?.())
  async function capture(origin, accept) {
    const token = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      let active = true
      const stopDelivery = window.api.onScreenshotDelivery(async (delivery) => {
        if (!active || delivery.token !== token || delivery.action !== 'source') return
        try {
          const accepted = await accept(delivery)
          await window.api.acknowledgeScreenshot({
            ...identifiers(delivery),
            accepted: accepted === true,
            message: '未能接收图片，请检查附件上限或重新打开来源页面'
          })
        } catch (error) {
          await window.api.acknowledgeScreenshot({
            ...identifiers(delivery),
            accepted: false,
            message: error.message
          })
        }
      })
      const stopFinished = window.api.onScreenshotFinished((result) => {
        if (result.token !== token) return
        cleanup()
        resolve(result)
      })
      const cleanup = () => {
        active = false
        stopDelivery()
        stopFinished()
        dispose = null
      }
      dispose = () => {
        cleanup()
        void window.api.invalidateScreenshotSource(token)
        resolve({ status: 'source-gone' })
      }
      window.api
        .captureScreen({ origin, token })
        .then((result) => {
          if (result.status !== 'started') {
            cleanup()
            reject(new Error(result.status === 'busy' ? '已有截图会话正在进行' : '截图未能启动'))
          }
        })
        .catch((error) => {
          cleanup()
          reject(error)
        })
    })
  }
  capture.invalidate = () => dispose?.()
  return capture
}

export const identifiers = ({ sessionId, deliveryId }) => ({ sessionId, deliveryId })
