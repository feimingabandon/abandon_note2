import { describe, expect, it } from 'vitest'
import {
  enforceSystemNotificationPolicy,
  getSystemNotificationCapability,
  MAC_SYSTEM_NOTIFICATION_UNAVAILABLE_REASON
} from '../src/shared/notification-policy.js'

describe('system notification platform policy', () => {
  it('disables system notifications on macOS with a visible reason', () => {
    expect(getSystemNotificationCapability('darwin')).toEqual({
      supported: false,
      reason: MAC_SYSTEM_NOTIFICATION_UNAVAILABLE_REASON
    })
    expect(
      enforceSystemNotificationPolicy({ content: '提醒', notifyEnabled: true }, 'darwin')
    ).toEqual({
      content: '提醒',
      notifyEnabled: false
    })
  })

  it('preserves the notification choice on supported platforms', () => {
    expect(getSystemNotificationCapability('win32')).toEqual({ supported: true, reason: '' })
    expect(enforceSystemNotificationPolicy({ notifyEnabled: true }, 'win32')).toEqual({
      notifyEnabled: true
    })
  })
})
