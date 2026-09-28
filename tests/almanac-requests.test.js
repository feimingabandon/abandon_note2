import { describe, expect, it, vi } from 'vitest'
import { createAlmanacRequests } from '../src/renderer/src/utils/almanacRequests.js'

describe('shared date requests', () => {
  it('deduplicates same-day cards and bounds cached dates', async () => {
    const load = vi.fn(async (dateKey) => ({ dateKey, almanac: { status: 'ok' } }))
    const requests = createAlmanacRequests(load, 2)
    const first = requests.get('2026-09-28')
    expect(requests.get('2026-09-28')).toBe(first)
    await first
    await requests.get('2026-09-29')
    await requests.get('2026-09-28')
    expect(load).toHaveBeenCalledTimes(2)
    await requests.get('2026-09-30')
    await requests.get('2026-09-29')
    expect(load).toHaveBeenCalledTimes(4)
  })
  it('does not let a stale in-flight result overwrite holiday updates', async () => {
    const resolve = []
    const load = vi.fn(() => new Promise((done) => resolve.push(done)))
    const requests = createAlmanacRequests(load)
    const first = requests.get('2026-09-28')
    await Promise.resolve()
    requests.clear()
    const second = requests.get('2026-09-28')
    await Promise.resolve()
    resolve[1]({ revision: 2 })
    await second
    resolve[0]({ revision: 1 })
    await first
    expect(await requests.get('2026-09-28')).toEqual({ revision: 2 })
    expect(load).toHaveBeenCalledTimes(2)
  })
  it('allows retry after transport and calculation errors', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('IPC failed'))
      .mockResolvedValueOnce({ almanac: { status: 'error' } })
      .mockResolvedValue({ almanac: { status: 'ok' } })
    const requests = createAlmanacRequests(load)
    await expect(requests.get('2026-09-28')).rejects.toThrow('IPC failed')
    expect((await requests.get('2026-09-28')).almanac.status).toBe('error')
    expect((await requests.get('2026-09-28')).almanac.status).toBe('ok')
    expect(load).toHaveBeenCalledTimes(3)
  })
})
