import { describe, expect, it, vi } from 'vitest'
import { createStickyDiagnosticIpcRenderer } from '../src/preload/sticky-diagnostic-ipc.js'

describe('sticky preload diagnostic IPC wrapper', () => {
  it('correlates sticky writes without logging their content', async () => {
    const sent = []
    const raw = {
      send: vi.fn((...args) => sent.push(args)),
      invoke: vi.fn(async () => true),
      on: vi.fn(),
      removeListener: vi.fn()
    }
    const ipc = createStickyDiagnosticIpcRenderer(raw)

    await expect(
      ipc.invoke('sticky:update-content', { id: 7, content: '便利贴正文' })
    ).resolves.toBe(true)

    const logs = sent.filter(([channel]) => channel === 'logs:write').map(([, value]) => value)
    expect(logs.map((entry) => entry.phase)).toEqual(['start', 'returned'])
    expect(logs[0]).toMatchObject({
      eventName: 'sticky.content.save',
      metadata: {
        arguments: [{ id: 7, content: { omitted: true, length: 5 } }]
      }
    })
    expect(JSON.stringify(logs)).not.toContain('便利贴正文')
  })

  it('keeps the business result when diagnostic sends fail', async () => {
    const raw = {
      send: vi.fn(() => {
        throw new Error('diagnostic channel unavailable')
      }),
      invoke: vi.fn(async () => ({ pinned: true })),
      on: vi.fn(),
      removeListener: vi.fn()
    }
    const ipc = createStickyDiagnosticIpcRenderer(raw)

    await expect(ipc.invoke('sticky:toggle-pin')).resolves.toEqual({ pinned: true })
  })
})
