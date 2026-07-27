export const MAC_SYSTEM_NOTIFICATION_UNAVAILABLE_REASON =
  '因 macOS 系统通知需要付费的 Apple Developer 证书签名，当前暂未开通，已关闭此设置。'

export function getSystemNotificationCapability(platform) {
  if (platform === 'darwin') {
    return {
      supported: false,
      reason: MAC_SYSTEM_NOTIFICATION_UNAVAILABLE_REASON
    }
  }
  return { supported: true, reason: '' }
}

export function enforceSystemNotificationPolicy(payload, platform) {
  const next = payload && typeof payload === 'object' ? { ...payload } : {}
  if (!getSystemNotificationCapability(platform).supported) next.notifyEnabled = false
  return next
}
