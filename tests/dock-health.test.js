import { describe, expect, it } from 'vitest'
import {
  alignTriggerBoundsToEdge,
  inspectDockHealth
} from '../src/main/window-motion/dock-health.js'

function healthyHiddenSnapshot(overrides = {}) {
  return {
    mainWindowExists: true,
    isDockHidden: true,
    dockSide: 'left',
    hasDockMotionSession: true,
    sessionSide: 'left',
    mainAtHiddenTarget: true,
    isSliding: false,
    slideAgeMs: 0,
    maxSlideAgeMs: 5000,
    expectedTriggerBounds: { x: 0, y: 100, width: 2, height: 600 },
    trigger: {
      exists: true,
      destroyed: false,
      webContentsDestroyed: false,
      pageLoaded: true,
      visible: true,
      alwaysOnTop: true,
      expectedAlwaysOnTop: true,
      bounds: { x: 0, y: 100, width: 2, height: 600 }
    },
    ...overrides
  }
}

describe('dock health inspection', () => {
  it('moves Windows-clamped trigger width outside the left edge', () => {
    expect(
      alignTriggerBoundsToEdge({
        side: 'left',
        requestedBounds: { x: 0, y: 100, width: 2, height: 600 },
        actualBounds: { x: 0, y: 100, width: 32, height: 600 },
        visibleWidth: 2
      })
    ).toEqual({ x: -30, y: 100, width: 32, height: 600 })
  })

  it('keeps Windows-clamped trigger width extending beyond the right edge', () => {
    expect(
      alignTriggerBoundsToEdge({
        side: 'right',
        requestedBounds: { x: 1918, y: 100, width: 2, height: 600 },
        actualBounds: { x: 1918, y: 100, width: 32, height: 600 },
        visibleWidth: 2
      })
    ).toEqual({ x: 1918, y: 100, width: 32, height: 600 })
  })

  it('moves Windows-clamped trigger height outside the top edge', () => {
    expect(
      alignTriggerBoundsToEdge({
        side: 'top',
        requestedBounds: { x: 100, y: 0, width: 1200, height: 2 },
        actualBounds: { x: 100, y: 0, width: 1200, height: 32 },
        visibleWidth: 2
      })
    ).toEqual({ x: 100, y: -30, width: 1200, height: 32 })
  })

  it('accepts the effective native bounds after Windows clamps the width', () => {
    expect(
      inspectDockHealth(
        healthyHiddenSnapshot({
          expectedTriggerBounds: { x: -30, y: 100, width: 32, height: 600 },
          trigger: {
            ...healthyHiddenSnapshot().trigger,
            bounds: { x: -30, y: 100, width: 32, height: 600 }
          }
        })
      )
    ).toEqual([])
  })

  it('accepts a consistent hidden session', () => {
    expect(inspectDockHealth(healthyHiddenSnapshot())).toEqual([])
  })

  it('reports a hidden window without its trigger', () => {
    const snapshot = healthyHiddenSnapshot({
      trigger: {
        exists: false,
        destroyed: false,
        webContentsDestroyed: false,
        pageLoaded: false,
        visible: false,
        bounds: null
      }
    })

    expect(inspectDockHealth(snapshot)).toContain('隐藏状态缺少边缘触发窗口')
  })

  it('reports stale resources after the window is restored', () => {
    const snapshot = healthyHiddenSnapshot({
      isDockHidden: false,
      hasDockMotionSession: true
    })

    expect(inspectDockHealth(snapshot)).toEqual([
      '非隐藏状态残留贴边运动会话',
      '非隐藏状态残留边缘触发窗口'
    ])
  })

  it('reports a stuck slide and an invalid trigger geometry', () => {
    const snapshot = healthyHiddenSnapshot({
      isSliding: true,
      slideAgeMs: 6000,
      trigger: {
        ...healthyHiddenSnapshot().trigger,
        bounds: { x: 10, y: 100, width: 2, height: 600 }
      }
    })

    expect(inspectDockHealth(snapshot)).toEqual([
      '贴边动画已持续 6000ms，超过允许时间',
      '边缘触发窗口的位置或尺寸与贴边会话不一致'
    ])
  })
})
