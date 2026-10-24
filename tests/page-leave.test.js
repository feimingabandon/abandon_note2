import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function deferred() {
  let resolve, reject
  const promise = new Promise((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}

async function settle() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

let register, page
const registrations = []
function participant(prepare = async () => {}) {
  const value = { prepare: vi.fn(prepare), resume: vi.fn() }
  const unregister = register(value)
  registrations.push(unregister)
  return { ...value, unregister }
}

beforeEach(async () => {
  vi.resetModules()
  page = {}
  vi.stubGlobal('window', page)
  const module = await import('../src/renderer/src/utils/pageLeave.js')
  register = module.registerPageLeaveParticipant
})

afterEach(() => {
  for (const unregister of registrations.splice(0)) unregister()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('page leave settings rendezvous', () => {
  it('is ready immediately when no settings participant is mounted', async () => {
    await expect(page.__preparePageLeave('empty')).resolves.toEqual({ ready: true })
    page.__cancelPageLeave('empty')
  })

  it('shares one preparation for repeated requests with the same operation ID', async () => {
    const save = deferred()
    const settings = participant(() => save.promise)
    const first = page.__preparePageLeave('same')
    expect(page.__preparePageLeave('same')).toBe(first)
    expect(settings.prepare).toHaveBeenCalledExactlyOnceWith('same')
    save.resolve()
    await expect(first).resolves.toEqual({ ready: true })
    expect(settings.resume).not.toHaveBeenCalled()
    page.__cancelPageLeave('same')
    page.__cancelPageLeave('same')
    expect(settings.resume).toHaveBeenCalledExactlyOnceWith('same')
  })

  it('joins a settings participant mounted while another preparation is still pending', async () => {
    const firstSave = deferred(),
      secondSave = deferred()
    participant(() => firstSave.promise)
    let ready = false
    const preparing = page.__preparePageLeave('mounting').then((result) => {
      ready = true
      return result
    })
    const second = participant(() => secondSave.promise)
    expect(second.prepare).toHaveBeenCalledExactlyOnceWith('mounting')
    firstSave.resolve()
    await settle()
    expect(ready).toBe(false)
    secondSave.resolve()
    await expect(preparing).resolves.toEqual({ ready: true })
  })

  it('drains a newly mounted participant again after an earlier pass was ready', async () => {
    const first = page.__preparePageLeave('mounted-after-ready')
    await expect(first).resolves.toEqual({ ready: true })
    const save = deferred()
    const settings = participant(() => save.promise)
    const recheck = page.__preparePageLeave('mounted-after-ready', { recheck: true })
    expect(recheck).not.toBe(first)
    expect(page.__preparePageLeave('mounted-after-ready', { recheck: true })).toBe(recheck)
    let ready = false
    void recheck.then(() => {
      ready = true
    })
    await settle()
    expect(ready).toBe(false)
    expect(settings.prepare).toHaveBeenCalledExactlyOnceWith('mounted-after-ready')
    save.resolve()
    await expect(recheck).resolves.toEqual({ ready: true })
    expect(settings.resume).not.toHaveBeenCalled()
  })

  it('rejects a final recheck after a ready participant unmounted instead of reviving an empty attempt', async () => {
    const settings = participant()
    await expect(page.__preparePageLeave('unmounted-after-ready')).resolves.toEqual({ ready: true })
    settings.unregister()
    await expect(
      page.__preparePageLeave('unmounted-after-ready', { recheck: true })
    ).rejects.toMatchObject({ code: 'PAGE_LEAVE_CANCELLED' })
    expect(settings.resume).toHaveBeenCalledExactlyOnceWith('unmounted-after-ready')
  })

  it('rejects an old final recheck without cancelling the replacement operation', async () => {
    const save = deferred()
    const settings = participant((id) => (id === 'replacement' ? save.promise : undefined))
    await page.__preparePageLeave('old-ready')
    const current = page.__preparePageLeave('replacement')
    await expect(page.__preparePageLeave('old-ready', { recheck: true })).rejects.toMatchObject({
      code: 'PAGE_LEAVE_CANCELLED'
    })
    expect(settings.resume.mock.calls).toEqual([['old-ready']])
    save.resolve()
    await expect(current).resolves.toEqual({ ready: true })
    expect(settings.resume.mock.calls).toEqual([['old-ready']])
  })

  it('cancels promptly without waiting for an unfinished save and ignores an old cancellation', async () => {
    const oldSave = deferred(),
      newSave = deferred()
    const settings = participant((id) => (id === 'old' ? oldSave.promise : newSave.promise))
    const old = page.__preparePageLeave('old')
    const cancelled = expect(old).rejects.toMatchObject({ code: 'PAGE_LEAVE_CANCELLED' })
    const current = page.__preparePageLeave('new')
    await cancelled
    expect(settings.resume.mock.calls).toEqual([['old']])
    page.__cancelPageLeave('old')
    expect(settings.resume.mock.calls).toEqual([['old']])
    oldSave.reject(new Error('late old failure'))
    newSave.resolve()
    await expect(current).resolves.toEqual({ ready: true })
    expect(settings.resume.mock.calls).toEqual([['old']])
  })

  it('does not let a late cancelled preparation release a replacement using the same ID', async () => {
    const oldSave = deferred(),
      newSave = deferred()
    let count = 0
    const settings = participant(() => (++count === 1 ? oldSave.promise : newSave.promise))
    const old = page.__preparePageLeave('reused')
    const cancelled = expect(old).rejects.toMatchObject({ code: 'PAGE_LEAVE_CANCELLED' })
    page.__cancelPageLeave('reused')
    const current = page.__preparePageLeave('reused')
    await cancelled
    oldSave.reject(new Error('late failure'))
    await settle()
    expect(settings.resume.mock.calls).toEqual([['reused']])
    newSave.resolve()
    await expect(current).resolves.toEqual({ ready: true })
    expect(settings.resume.mock.calls).toEqual([['reused']])
  })

  it('resumes every participant when a save fails, including another unfinished participant', async () => {
    const firstSave = deferred(),
      secondSave = deferred()
    const first = participant(() => firstSave.promise)
    const second = participant(() => secondSave.promise)
    const preparing = page.__preparePageLeave('failure')
    const failed = expect(preparing).rejects.toThrow('disk-full')
    firstSave.reject(new Error('disk-full'))
    await failed
    expect(first.resume).toHaveBeenCalledExactlyOnceWith('failure')
    expect(second.resume).toHaveBeenCalledExactlyOnceWith('failure')
    secondSave.resolve()
    await settle()
    expect(second.resume).toHaveBeenCalledTimes(1)
  })

  it('treats unmount during preparation as cancellation, never as successful persistence', async () => {
    const save = deferred()
    const settings = participant(() => save.promise)
    const preparing = page.__preparePageLeave('unmount')
    const cancelled = expect(preparing).rejects.toMatchObject({ code: 'PAGE_LEAVE_CANCELLED' })
    settings.unregister()
    await cancelled
    expect(settings.resume).toHaveBeenCalledExactlyOnceWith('unmount')
    save.resolve()
    await settle()
    await expect(page.__preparePageLeave('after-unmount')).resolves.toEqual({ ready: true })
    expect(settings.prepare).toHaveBeenCalledTimes(1)
  })

  it('continues restoring other participants if one resume callback throws', async () => {
    const save = deferred()
    const first = participant(() => save.promise)
    const second = participant(() => save.promise)
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    first.resume.mockImplementation(() => {
      throw new Error('restore failed')
    })
    const preparing = page.__preparePageLeave('resume-failure')
    const cancelled = expect(preparing).rejects.toMatchObject({ code: 'PAGE_LEAVE_CANCELLED' })
    page.__cancelPageLeave('resume-failure')
    await cancelled
    expect(second.resume).toHaveBeenCalledExactlyOnceWith('resume-failure')
    expect(errorLog).toHaveBeenCalledOnce()
    save.resolve()
  })
})
