import { describe, expect, it, vi } from 'vitest'
import { sendNotificationSafely } from '../src/main/services/notification-guard.js'

describe('notification failure isolation', () => {
  it('reports a notification error without throwing into the completed business task', () => {
    const error = new Error('notification unavailable')
    const report = vi.fn()

    expect(
      sendNotificationSafely(
        () => {
          throw error
        },
        '正文',
        { title: '模板生成通知' },
        report
      )
    ).toBe(false)
    expect(report).toHaveBeenCalledWith(error)
  })

  it('preserves the title and body for a successful notification', () => {
    const send = vi.fn()
    expect(sendNotificationSafely(send, '生成的便签正文', { title: '模板生成通知' })).toBe(true)
    expect(send).toHaveBeenCalledWith('生成的便签正文', { title: '模板生成通知' })
  })
})
