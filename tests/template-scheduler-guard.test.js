import { describe, expect, it, vi } from 'vitest'
import { TemplateSchedulerGuard } from '../src/main/services/template-scheduler-guard.js'

describe('template scheduler service guard', () => {
  it('alerts after three consecutive failures and retries at a reduced frequency', () => {
    const alert = vi.fn()
    const guard = new TemplateSchedulerGuard({
      failureThreshold: 3,
      retryDelayMs: 5 * 60 * 1000,
      onAlert: alert
    })
    const start = new Date('2025-07-20T09:00:00').getTime()
    const fail = () => {
      throw new Error('database unavailable')
    }

    expect(() => guard.run(fail, start)).toThrow('database unavailable')
    expect(() => guard.run(fail, start + 60_000)).toThrow('database unavailable')
    expect(alert).not.toHaveBeenCalled()
    expect(() => guard.run(fail, start + 120_000)).toThrow('database unavailable')
    expect(alert).toHaveBeenCalledTimes(1)
    expect(guard.shouldRun(start + 120_000 + 4 * 60_000)).toBe(false)
    expect(guard.shouldRun(start + 120_000 + 5 * 60_000)).toBe(true)
  })

  it('clears the incident after a successful retry', () => {
    const alert = vi.fn()
    const guard = new TemplateSchedulerGuard({ failureThreshold: 1, onAlert: alert })
    const start = Date.now()
    expect(() =>
      guard.run(() => {
        throw new Error('temporary')
      }, start)
    ).toThrow('temporary')
    expect(guard.run(() => 'ok', start + 5 * 60 * 1000)).toBe('ok')
    expect(guard.consecutiveFailures).toBe(0)
    expect(guard.nextRetryAt).toBe(0)
    expect(guard.alerted).toBe(false)
  })
})
