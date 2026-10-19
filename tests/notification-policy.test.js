import { describe, expect, it } from 'vitest'
import {
  enforceSystemNotificationPolicy,
  getSystemNotificationCapability
} from '../src/shared/notification-policy.js'

describe('Windows system notification policy', () => {
  it('keeps the capability bridge and preserves legacy notification choices without mutating the payload', () => {
    expect(getSystemNotificationCapability()).toEqual({ supported: true, reason: '' })
    for (const enabled of [true, false]) {
      const payload = { content: '提醒', notifyEnabled: enabled }
      const options = enforceSystemNotificationPolicy(payload)
      expect(options).toEqual(payload)
      expect(options).not.toBe(payload)
    }
  })

  it('keeps every Windows channel combination and derives enabled state from the explicit mask', () => {
    for (let channels = 0; channels <= 7; channels++) {
      expect(
        enforceSystemNotificationPolicy({ content: '提醒', reminderChannels: channels })
      ).toEqual({
        content: '提醒',
        reminderChannels: channels,
        notifyEnabled: channels !== 0
      })
    }
  })

  it('rejects invalid channel masks at the request boundary', () => {
    for (const channels of [-1, 8, 1.5, NaN, 'invalid']) {
      expect(() => enforceSystemNotificationPolicy({ reminderChannels: channels })).toThrow(
        '提醒方式无效'
      )
    }
  })
})
