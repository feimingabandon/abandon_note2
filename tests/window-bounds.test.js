import { describe, expect, it } from 'vitest'
import { constrainMainWindowBounds } from '../src/main/window-bounds.js'

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
