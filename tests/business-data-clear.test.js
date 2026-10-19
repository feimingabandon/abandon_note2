import { describe, expect, it, vi } from 'vitest'
import {
  runCommittedDataCleanup,
  broadcastBusinessDataCleared,
  createBusinessClearCleanupError
} from '../src/main/application/business-data-clear.js'
import { createBusinessMutationAdmission } from '../src/main/application/business-mutation-admission.js'

describe('committed business data cleanup', () => {
  it('continues sticky, draft and broadcast cleanup after a reminder query fails', async () => {
    const events = []
    const queryError = new Error('reminder SELECT failed')
    const failures = await runCommittedDataCleanup([
      {
        id: 'reminders',
        label: '提醒清理',
        run: () => {
          events.push('reminders')
          throw queryError
        }
      },
      { id: 'stickies', label: '桌面便签清理', run: () => events.push('stickies') },
      { id: 'drafts', label: '编辑草稿清理', run: () => events.push('drafts') },
      { id: 'broadcast', label: '界面刷新', run: () => events.push('broadcast') }
    ])
    expect(events).toEqual(['reminders', 'stickies', 'drafts', 'broadcast'])
    expect(failures).toEqual([{ id: 'reminders', label: '提醒清理', error: queryError }])
    const error = createBusinessClearCleanupError(failures)
    expect(error).toMatchObject({
      committed: true,
      code: 'BUSINESS_DATA_CLEANUP_INCOMPLETE',
      failedSteps: ['reminders']
    })
    expect(error.message).toContain('业务数据已清空')
    expect(error.message).toContain('提醒清理失败')
    expect(error.message).toContain('无需再次清空数据')
  })

  it('collects multiple failures even if failure logging throws', async () => {
    const last = vi.fn()
    const failures = await runCommittedDataCleanup(
      [
        {
          id: 'stickies',
          label: '桌面便签清理',
          run: () => {
            throw new Error('sticky failure')
          }
        },
        {
          id: 'drafts',
          label: '编辑草稿清理',
          run: async () => {
            throw new Error('draft failure')
          }
        },
        { id: 'broadcast', label: '界面刷新', run: last }
      ],
      () => {
        throw new Error('logging failure')
      }
    )
    expect(failures.map((failure) => failure.id)).toEqual(['stickies', 'drafts'])
    expect(last).toHaveBeenCalledOnce()
  })

  it('keeps clear admission sealed and shutdown waiting through asynchronous cleanup', async () => {
    const admission = createBusinessMutationAdmission()
    let release
    const pause = new Promise((resolve) => {
      release = resolve
    })
    let entered = false
    const finished = admission.clear(async () => {
      const failures = await runCommittedDataCleanup([
        {
          id: 'reminders',
          label: '提醒清理',
          run: () => {
            throw new Error('query')
          }
        },
        {
          id: 'drafts',
          label: '编辑草稿清理',
          run: async () => {
            entered = true
            await pause
          }
        }
      ])
      throw createBusinessClearCleanupError(failures)
    })
    const observed = finished.catch((error) => error)
    while (!entered) await Promise.resolve()
    expect(admission.canAdmit()).toBe(false)
    admission.preventNewMutations()
    let drained = false
    const drain = admission.drain().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    release()
    expect((await observed).committed).toBe(true)
    await drain
    expect(drained).toBe(true)
    expect(admission.snapshot()).toEqual({ clearing: false, pending: 0 })
  })

  it('continues sending to live recipients and skips destroyed ones', () => {
    const send = vi.fn()
    const deadSend = vi.fn()
    expect(() =>
      broadcastBusinessDataCleared([
        {
          isDestroyed: () => false,
          webContents: {
            isDestroyed: () => false,
            send: () => {
              throw new Error('recipient failure')
            }
          }
        },
        { isDestroyed: () => true, webContents: { isDestroyed: () => false, send: deadSend } },
        { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }
      ])
    ).toThrow('部分窗口清空通知失败')
    expect(send).toHaveBeenCalledWith('notes:changed', { reason: 'note-data-cleared' })
    expect(deadSend).not.toHaveBeenCalled()
  })

  it('returns no failure when all committed cleanup steps finish', async () => {
    const reported = vi.fn()
    expect(
      await runCommittedDataCleanup(
        [{ id: 'drafts', label: '编辑草稿清理', run: async () => true }],
        reported
      )
    ).toEqual([])
    expect(reported).not.toHaveBeenCalled()
  })
})
