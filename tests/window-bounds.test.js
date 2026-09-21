import { describe, expect, it } from 'vitest'
import {
  constrainMainWindowBounds,
  getPersistableWindowBounds,
  getWindowBoundsUpdate,
  mainWindowBoundsFromTitlebarAnchor
} from '../src/main/window-bounds.js'

describe('constrainMainWindowBounds', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 }

  it('keeps valid saved bounds unchanged', () => {
    expect(constrainMainWindowBounds({ x: 40, y: 50, width: 480, height: 900 }, workArea)).toEqual({
      x: 40,
      y: 50,
      width: 480,
      height: 900
    })
  })

  it('moves off-screen bounds back into the current work area', () => {
    expect(
      constrainMainWindowBounds({ x: 2800, y: -800, width: 480, height: 900 }, workArea)
    ).toEqual({ x: 1440, y: 0, width: 480, height: 900 })
  })

  it('clamps invalid sizes without exceeding a small work area', () => {
    expect(
      constrainMainWindowBounds(
        { x: -50, y: -50, width: 20, height: 5000 },
        { x: 10, y: 20, width: 200, height: 180 }
      )
    ).toEqual({ x: 10, y: 20, width: 200, height: 180 })
  })
})

describe('mainWindowBoundsFromTitlebarAnchor', () => {
  const workArea = { x: 1920, y: 40, width: 1600, height: 900 }
  const expandedBounds = { x: 40, y: 50, width: 480, height: 720 }

  it('places the navigation center exactly at the double-click point when space is available', () => {
    expect(
      mainWindowBoundsFromTitlebarAnchor(expandedBounds, { x: 2600, y: 200 }, 24, workArea)
    ).toEqual({ x: 2360, y: 176, width: 480, height: 720 })
  })

  it('moves the complete main window inside the target display work area near an edge', () => {
    expect(
      mainWindowBoundsFromTitlebarAnchor(expandedBounds, { x: 3500, y: 920 }, 24, workArea)
    ).toEqual({ x: 3040, y: 220, width: 480, height: 720 })
  })
})

describe('getWindowBoundsUpdate', () => {
  it('does nothing when the constrained bounds are unchanged', () => {
    const bounds = { x: 40, y: 50, width: 480, height: 900 }
    expect(getWindowBoundsUpdate(bounds, bounds)).toEqual({ mode: 'none' })
  })

  it('moves only the position when the size is unchanged', () => {
    expect(
      getWindowBoundsUpdate(
        { x: 2800, y: -800, width: 480, height: 900 },
        { x: 1440, y: 0, width: 480, height: 900 }
      )
    ).toEqual({ mode: 'position', x: 1440, y: 0 })
  })

  it('submits full bounds only when the constrained size changed', () => {
    const nextBounds = { x: 10, y: 20, width: 200, height: 180 }
    expect(getWindowBoundsUpdate({ x: -50, y: -50, width: 480, height: 900 }, nextBounds)).toEqual({
      mode: 'bounds',
      bounds: nextBounds
    })
  })
})

describe('getPersistableWindowBounds', () => {
  it('never persists an off-screen animation frame over the frozen visible bounds', () => {
    const stable = { x: 1440, y: 80, width: 480, height: 900 }
    expect(
      getPersistableWindowBounds({
        dockStableBounds: stable,
        lastVisibleBounds: { x: 1400, y: 80, width: 480, height: 900 },
        currentBounds: { x: 1924, y: 80, width: 480, height: 900 }
      })
    ).toEqual(stable)
  })

  it('falls back to the last visible bounds when no dock session exists', () => {
    const visible = { x: 40, y: 50, width: 480, height: 900 }
    expect(
      getPersistableWindowBounds({
        lastVisibleBounds: visible,
        currentBounds: { x: -480, y: 50, width: 480, height: 900 }
      })
    ).toEqual(visible)
  })
})
