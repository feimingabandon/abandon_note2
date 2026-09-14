import { describe, expect, it, vi } from 'vitest'
import { createCompactTransitionDiagnostics } from '../src/renderer/src/composables/compact-transition-diagnostics.js'
import { normalizeCompactRendererDiagnostics } from '../src/main/logging/compact-diagnostics.js'

function fixture() {
  let now = 0,
    callback,
    timerId = 0
  const timers = new Map()
  const listeners = new Map()
  const host = {
    innerWidth: 200,
    innerHeight: 40,
    devicePixelRatio: 1,
    screenX: 1028,
    screenY: 56,
    outerWidth: 480,
    outerHeight: 936,
    performance: { now: () => now },
    requestAnimationFrame: (fn) => {
      callback = fn
      return 1
    },
    cancelAnimationFrame: vi.fn(),
    setTimeout: (fn, delay) => {
      timers.set(++timerId, { fn, delay })
      return timerId
    },
    clearTimeout: (id) => timers.delete(id),
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
    api: { reportCompactTransitionDiagnostics: vi.fn() }
  }
  return {
    host,
    listeners,
    step: () => {
      now += 16.67
      callback()
    },
    timers,
    timeout: (delay = 3000) => {
      const [id, timer] = [...timers].find(([, timer]) => timer.delay === delay)
      timers.delete(id)
      timer.fn()
    }
  }
}
describe('compact transition diagnostics', () => {
  it('buffers changing viewport sizes and sends once after the transition', () => {
    const f = fixture(),
      sampler = createCompactTransitionDiagnostics(f.host)
    sampler.update({ phase: 'expanding', transition: { generation: 3, stage: 'content-exit' } })
    f.step()
    f.host.innerWidth = 700
    f.host.innerHeight = 500
    f.listeners.get('resize')()
    sampler.update({ phase: 'expanding', transition: { generation: 3, stage: 'shell-transform' } })
    f.step()
    expect(f.host.api.reportCompactTransitionDiagnostics).not.toHaveBeenCalled()
    sampler.update({ phase: 'expanded', transition: null })
    expect(f.host.api.reportCompactTransitionDiagnostics).not.toHaveBeenCalled()
    f.host.screenX = 1172
    f.step()
    f.timeout(200)
    expect(f.host.api.reportCompactTransitionDiagnostics).toHaveBeenCalledTimes(1)
    const payload = f.host.api.reportCompactTransitionDiagnostics.mock.calls[0][0]
    expect(normalizeCompactRendererDiagnostics(payload, 3).frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'resize', width: 700, height: 500 }),
        expect.objectContaining({ event: 'raf', stage: 'stable', screenX: 1172 })
      ])
    )
    expect(f.listeners.size).toBe(0)
    expect(f.timers.size).toBe(0)
    expect(normalizeCompactRendererDiagnostics({ ...payload, generation: 9 }, 3)).toBeNull()
    expect(
      normalizeCompactRendererDiagnostics(
        { ...payload, frames: Array(257).fill(payload.frames[0]) },
        3
      )
    ).toBeNull()
    expect(
      normalizeCompactRendererDiagnostics(
        { ...payload, frames: [{ ...payload.frames[0], width: Infinity }] },
        3
      )
    ).toBeNull()
  })
  it('captures only fixed layer geometry and strips untrusted content at the IPC boundary', () => {
    const f = fixture()
    const element = {
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 192, height: 69 }),
      get textContent() {
        throw new Error('must not read note content')
      }
    }
    f.host.document = { querySelector: vi.fn(() => element) }
    f.host.getComputedStyle = () => ({ opacity: '0.5', visibility: 'visible' })
    const sampler = createCompactTransitionDiagnostics(f.host)
    sampler.update({ phase: 'collapsing', transition: { generation: 2, stage: 'content-enter' } })
    sampler.stop()
    const payload = f.host.api.reportCompactTransitionDiagnostics.mock.calls[0][0]
    payload.frames[0].layers.island.textContent = 'secret'
    payload.frames[0].layers.unknown = { textContent: 'secret' }
    const normalized = normalizeCompactRendererDiagnostics(payload, 2)
    expect(normalized.frames[0].layers.island).toEqual({
      x: 0,
      y: 0,
      width: 192,
      height: 69,
      opacity: 0.5,
      visibility: 'visible'
    })
    expect(JSON.stringify(normalized)).not.toContain('secret')
    payload.frames[0].layers.island.x = Infinity
    expect(normalizeCompactRendererDiagnostics(payload, 2)).toBeNull()
  })
  it('flushes a replaced stable tail and cancels its timer without ending the next transition', () => {
    const f = fixture(),
      sampler = createCompactTransitionDiagnostics(f.host)
    sampler.update({ phase: 'collapsing', transition: { generation: 1, stage: 'content-enter' } })
    sampler.update({ phase: 'compact', transition: null })
    sampler.update({ phase: 'compact', transition: null })
    expect([...f.timers.values()].filter((timer) => timer.delay === 200)).toHaveLength(1)
    sampler.update({ phase: 'expanding', transition: { generation: 2, stage: 'content-exit' } })
    expect(f.host.api.reportCompactTransitionDiagnostics.mock.calls[0][0].reason).toBe('replaced')
    expect([...f.timers.values()].some((timer) => timer.delay === 200)).toBe(false)
    sampler.stop()
    expect(f.host.api.reportCompactTransitionDiagnostics).toHaveBeenCalledTimes(2)
    expect(f.timers.size).toBe(0)
    expect(f.listeners.size).toBe(0)
  })
  it('bounds high-refresh sampling and flushes stalled transitions on timeout', () => {
    const f = fixture(),
      sampler = createCompactTransitionDiagnostics(f.host)
    sampler.update({ phase: 'collapsing', transition: { generation: 1, stage: 'shell-transform' } })
    for (let i = 0; i < 300; i++) f.step()
    f.timeout()
    const payload = f.host.api.reportCompactTransitionDiagnostics.mock.calls[0][0]
    expect(payload.frames).toHaveLength(256)
    expect(payload.droppedFrames).toBeGreaterThan(0)
    expect(payload.reason).toBe('timeout')
    sampler.stop()
    expect(f.host.api.reportCompactTransitionDiagnostics).toHaveBeenCalledTimes(1)
  })
})
