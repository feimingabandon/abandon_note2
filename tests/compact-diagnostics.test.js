import { describe, expect, it, vi } from 'vitest'
import { createCompactTransitionDiagnostics } from '../src/renderer/src/composables/compact-transition-diagnostics.js'
import { normalizeCompactRendererDiagnostics } from '../src/main/logging/compact-diagnostics.js'

function fixture() {
  let now = 0,
    callback,
    timeout
  const listeners = new Map()
  const host = {
    innerWidth: 200,
    innerHeight: 40,
    devicePixelRatio: 1,
    performance: { now: () => now },
    requestAnimationFrame: (fn) => {
      callback = fn
      return 1
    },
    cancelAnimationFrame: vi.fn(),
    setTimeout: (fn) => {
      timeout = fn
      return 1
    },
    clearTimeout: vi.fn(),
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
    timeout: () => timeout()
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
    expect(f.host.api.reportCompactTransitionDiagnostics).toHaveBeenCalledTimes(1)
    const payload = f.host.api.reportCompactTransitionDiagnostics.mock.calls[0][0]
    expect(normalizeCompactRendererDiagnostics(payload, 3).frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'resize', width: 700, height: 500 })
      ])
    )
    expect(f.listeners.size).toBe(0)
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
