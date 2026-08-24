import { describe, expect, it } from 'vitest'
import {
  dockRuntimeConfigEqual,
  isCurrentDockMonitorEvent,
  normalizeDockRuntimeConfig,
  resolveActiveDockEdges,
  resolveDockRevealHandlePositionPermille,
  selectNearestDockSide,
  validateDockConfigPayload
} from '../src/main/window-motion/dock-config.js'

const workArea = { x: 0, y: 0, width: 1000, height: 800 }

describe('dock runtime config', () => {
  it('uses the deterministic capability intersection for every view', () => {
    expect(resolveActiveDockEdges(['right', 'top'], ['left', 'right', 'top'])).toEqual([
      'top',
      'right'
    ])
    expect(
      normalizeDockRuntimeConfig(
        { revealHandleMode: 'persistent', enabledEdges: ['right', 'left', 'right'] },
        ['top', 'left']
      )
    ).toEqual({
      revealHandleMode: 'persistent',
      supportedEdges: ['top', 'left'],
      enabledEdges: ['left', 'right'],
      activeEdges: ['left']
    })
  })

  it('treats equivalent edge sets as the same runtime config', () => {
    expect(
      dockRuntimeConfigEqual(
        { revealHandleMode: 'on-touch', enabledEdges: ['right', 'top'] },
        { revealHandleMode: 'on-touch', enabledEdges: ['top', 'right'] }
      )
    ).toBe(true)
  })

  it('maps an optional per-edge handle position to native permille', () => {
    expect(resolveDockRevealHandlePositionPermille({ right: 0.734 }, 'right')).toBe(734)
    expect(resolveDockRevealHandlePositionPermille({ top: -2 }, 'top')).toBe(0)
    expect(resolveDockRevealHandlePositionPermille({}, 'left')).toBeNull()
    expect(resolveDockRevealHandlePositionPermille({ bottom: 0.5 }, 'bottom')).toBeNull()
  })

  it('strictly validates the atomic IPC payload and caps its shape', () => {
    expect(
      validateDockConfigPayload({
        revealHandleMode: 'persistent',
        enabledEdges: ['right', 'top']
      })
    ).toEqual({ revealHandleMode: 'persistent', enabledEdges: ['top', 'right'] })
    expect(() =>
      validateDockConfigPayload({
        revealHandleMode: 'on-touch',
        enabledEdges: ['top'],
        unexpected: true
      })
    ).toThrow('只能包含')
    expect(() =>
      validateDockConfigPayload({
        revealHandleMode: 'direct',
        enabledEdges: Array(13).fill('top')
      })
    ).toThrow('最多包含十二项')
    expect(() =>
      validateDockConfigPayload({ revealHandleMode: 'direct', enabledEdges: ['bottom'] })
    ).toThrow('只能包含 top、left 或 right')
    expect(() =>
      validateDockConfigPayload({ revealHandleMode: 'always', enabledEdges: ['top'] })
    ).toThrow('只能是 direct、on-touch 或 persistent')
  })
})

describe('dock edge selection', () => {
  it('selects the nearest eligible edge at a corner', () => {
    expect(
      selectNearestDockSide({
        bounds: { x: 3, y: 8, width: 300, height: 400 },
        workArea,
        activeEdges: ['top', 'left', 'right'],
        threshold: 20,
        isExposed: () => true
      })
    ).toBe('left')
  })

  it('uses top then left then right as the exact-tie order', () => {
    expect(
      selectNearestDockSide({
        bounds: { x: 5, y: 5, width: 300, height: 400 },
        workArea,
        activeEdges: ['left', 'top'],
        threshold: 20,
        isExposed: () => true
      })
    ).toBe('top')
  })

  it('ignores disabled, occluded and out-of-threshold edges', () => {
    expect(
      selectNearestDockSide({
        bounds: { x: 4, y: 6, width: 300, height: 400 },
        workArea,
        activeEdges: ['top', 'left'],
        threshold: 20,
        isExposed: (side) => side !== 'left'
      })
    ).toBe('top')
    expect(
      selectNearestDockSide({
        bounds: { x: 30, y: 30, width: 300, height: 400 },
        workArea,
        activeEdges: ['top', 'left'],
        threshold: 20,
        isExposed: () => true
      })
    ).toBeNull()
  })

  it('keeps an edge eligible after the window crosses beyond the snap threshold', () => {
    const select = (bounds, activeEdges) =>
      selectNearestDockSide({
        bounds,
        workArea,
        activeEdges,
        threshold: 20,
        isExposed: () => true
      })

    expect(select({ x: -21, y: 100, width: 300, height: 400 }, ['left'])).toBe('left')
    expect(select({ x: 721, y: 100, width: 300, height: 400 }, ['right'])).toBe('right')
    expect(select({ x: 100, y: -21, width: 300, height: 400 }, ['top'])).toBe('top')
  })

  it('still selects the geometrically nearest edge at an overshot corner', () => {
    const select = (bounds) =>
      selectNearestDockSide({
        bounds,
        workArea,
        activeEdges: ['top', 'left'],
        threshold: 20,
        isExposed: () => true
      })

    expect(select({ x: -40, y: -5, width: 300, height: 400 })).toBe('top')
    expect(select({ x: -5, y: -40, width: 300, height: 400 })).toBe('left')
  })
})

describe('dock native event generation guard', () => {
  const session = { generation: 42, side: 'right' }

  it('accepts only the current generation and frozen side', () => {
    expect(isCurrentDockMonitorEvent({ generation: 42, side: 'right' }, session)).toBe(true)
    expect(isCurrentDockMonitorEvent({ generation: 41, side: 'right' }, session)).toBe(false)
    expect(isCurrentDockMonitorEvent({ generation: 42, side: 'left' }, session)).toBe(false)
    expect(isCurrentDockMonitorEvent({ generation: 42, side: 'right' }, null)).toBe(false)
  })
})
