import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { createCompactHandoffDiagnostics } from '../src/main/logging/compact-handoff-diagnostics.js'

afterEach(() => vi.useRealTimers())
function fixture() {
  vi.useFakeTimers()
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1172, y: 56, width: 192, height: 69 }),
    getContentBounds: () => ({ x: 1172, y: 56, width: 192, height: 69 }),
    getOpacity: () => 1,
    isVisible: () => true
  })
  const report = vi.fn()
  const readNative = vi.fn(() => ({ shellPrepared: false, timing: { frames: ['old'] } }))
  const sampler = createCompactHandoffDiagnostics({ window, report, readNative })
  return { window, report, readNative, sampler }
}
it('records handoff and bounded delayed snapshots without reusing old native frame timings', () => {
  const f = fixture()
  f.sampler.sample('shell-released')
  f.sampler.tail()
  vi.advanceTimersByTime(100)
  expect(f.report).not.toHaveBeenCalled()
  vi.advanceTimersByTime(100)
  const result = f.report.mock.calls[0][0]
  expect(result.samples.map((s) => s.stage)).toEqual([
    'shell-released',
    'tail-0',
    'tail-16',
    'tail-50',
    'tail-100',
    'tail-200'
  ])
  expect(result.samples[0].native).toEqual({ shellPrepared: false })
  expect(result.reason).toBe('settled')
  expect(f.window.listenerCount('closed')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
it.each(['replaced', 'closed'])('cancels delayed reads when %s', (reason) => {
  const f = fixture()
  f.sampler.tail()
  if (reason === 'closed') f.window.emit('closed')
  else f.sampler.finish(reason)
  f.sampler.tail()
  expect(vi.getTimerCount()).toBe(0)
  vi.advanceTimersByTime(1000)
  expect(f.readNative).not.toHaveBeenCalled()
  expect(f.report).toHaveBeenCalledTimes(1)
  expect(f.report.mock.calls[0][0].reason).toBe(reason)
  expect(vi.getTimerCount()).toBe(0)
})
it('isolates collection and reporting failures from animation completion', () => {
  const f = fixture()
  f.readNative.mockImplementation(() => {
    throw new Error('native unavailable')
  })
  f.report.mockImplementation(() => {
    throw new Error('logger closed')
  })
  expect(() => f.sampler.sample('before-handoff')).not.toThrow()
  expect(() => f.sampler.finish('failed')).not.toThrow()
  expect(f.window.listenerCount('closed')).toBe(0)
})
