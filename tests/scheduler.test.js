import { afterEach, describe, expect, it, vi } from 'vitest'
import { Scheduler } from '../src/main/services/scheduler.js'

afterEach(() => vi.useRealTimers())

describe('scheduler context', () => {
  it('passes startup without converting it to recovery', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-07-20T08:00:00'))
    const scheduler = new Scheduler()
    const contexts = []
    scheduler.register({
      name: 'probe',
      shouldRun: () => true,
      execute: (context) => contexts.push(context)
    })
    scheduler.tick({ reason: 'startup' })
    expect(contexts).toHaveLength(1)
    expect(contexts[0].reason).toBe('startup')
  })

  it('converts a late scheduled tick into recovery', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-07-20T08:05:00'))
    const scheduler = new Scheduler()
    scheduler.lastTickAt = Date.now() - 120_000
    const contexts = []
    scheduler.register({
      name: 'probe',
      shouldRun: () => true,
      execute: (context) => contexts.push(context)
    })
    scheduler.tick({ reason: 'scheduled' })
    expect(contexts[0].reason).toBe('recovery')
  })

  it('does not disable a task configured for persistent retry', () => {
    const scheduler = new Scheduler()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    scheduler.register({
      name: 'persistent',
      maxFailures: Infinity,
      shouldRun: () => true,
      execute: () => {
        throw new Error('temporary failure')
      }
    })
    for (let attempt = 0; attempt < 12; attempt += 1) scheduler.tick()
    expect(scheduler.tasks[0]._disabled).not.toBe(true)
    errorSpy.mockRestore()
  })

  it('runs registered diagnostic tasks on startup and scheduled ticks', () => {
    const scheduler = new Scheduler()
    const diagnostic = vi.fn()
    scheduler.register({
      name: 'blurRuntimeDiagnosticTask',
      maxFailures: Infinity,
      shouldRun: () => true,
      execute: diagnostic
    })

    scheduler.tick({ reason: 'startup' })
    scheduler.tick({ reason: 'scheduled' })

    expect(diagnostic).toHaveBeenCalledTimes(2)
    expect(diagnostic.mock.calls[0][0].reason).toBe('startup')
    expect(diagnostic.mock.calls[1][0].reason).toBe('scheduled')
    expect(scheduler.getHealth().tasks).toContainEqual({
      name: 'blurRuntimeDiagnosticTask',
      failures: 0,
      disabled: false,
      lastError: null
    })
  })

  it('starts idempotently and invalidates queued callbacks when stopped', () => {
    vi.useFakeTimers()
    const scheduler = new Scheduler()
    const task = vi.fn()
    scheduler.register({
      name: 'probe',
      shouldRun: () => true,
      execute: task
    })

    scheduler.start()
    const runningGeneration = scheduler._mainGeneration
    scheduler.start()
    expect(task).toHaveBeenCalledTimes(1)
    expect(scheduler._mainGeneration).toBe(runningGeneration)

    scheduler.stop()
    expect(scheduler._mainGeneration).toBe(runningGeneration + 1)
    expect(scheduler.getHealth().status).toBe('stopped')
    expect(scheduler.getHealth().watchdogRunning).toBe(false)
  })

  it('uses the in-app fallback without creating a native notification when disabled', () => {
    const scheduler = new Scheduler()
    const fallback = vi.fn()
    const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    scheduler.systemNotificationsEnabled = false
    scheduler.systemNotificationsDisabledReason = 'macOS 系统通知已关闭'
    scheduler.onAlertNotifyFailed = fallback
    scheduler._Notification = vi.fn()

    scheduler._sendAlert()

    expect(scheduler._Notification).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledWith(
      '便签调度器异常',
      '定时任务引擎连续恢复失败，请重启应用以恢复正常。',
      expect.objectContaining({ message: 'macOS 系统通知已关闭' })
    )
    warningSpy.mockRestore()
    errorSpy.mockRestore()
  })
})
