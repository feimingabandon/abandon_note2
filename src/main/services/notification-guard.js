/** 将不可回滚的业务结果与可能失败的系统通知发送隔离。 */
export function sendNotificationSafely(
  send,
  body,
  options,
  reportError = (error) => console.error('[notification] 系统通知发送失败:', error)
) {
  try {
    send(body, options)
    return true
  } catch (error) {
    reportError(error)
    return false
  }
}
