import { describe, expect, it } from 'vitest'
import { isDisplayEdgeExposed } from '../src/main/window-motion/dock-edge.js'

const primary = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 }
}

describe('isDisplayEdgeExposed', () => {
  it('allows only a real outer edge', () => {
    const windowBounds = { x: 1440, y: 120, width: 480, height: 800 }
    expect(isDisplayEdgeExposed(primary, [primary], 'right', windowBounds)).toBe(true)
  })

  it('rejects an internal edge when another display is beyond it', () => {
    const neighbor = {
      id: 2,
      bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
      workArea: { x: 1920, y: 0, width: 2560, height: 1400 }
    }
    const windowBounds = { x: 1440, y: 120, width: 480, height: 800 }
    expect(isDisplayEdgeExposed(primary, [primary, neighbor], 'right', windowBounds)).toBe(false)
  })

  it('allows an exposed segment when an offset display does not overlap the window', () => {
    const upperNeighbor = {
      id: 2,
      bounds: { x: 1920, y: -1080, width: 1920, height: 1080 },
      workArea: { x: 1920, y: -1080, width: 1920, height: 1040 }
    }
    const windowBounds = { x: 1440, y: 120, width: 480, height: 800 }
    expect(isDisplayEdgeExposed(primary, [primary, upperNeighbor], 'right', windowBounds)).toBe(
      true
    )
  })

  it('rejects a work-area edge occupied by a side taskbar', () => {
    const taskbarOnRight = {
      ...primary,
      workArea: { x: 0, y: 0, width: 1880, height: 1080 }
    }
    const windowBounds = { x: 1400, y: 120, width: 480, height: 800 }
    expect(isDisplayEdgeExposed(taskbarOnRight, [taskbarOnRight], 'right', windowBounds)).toBe(
      false
    )
  })
})
