import { describe, expect, it } from 'vitest'
import { inspectDockHealth } from '../src/main/window-motion/dock-health.js'

function healthyHiddenSnapshot(overrides = {}) {
  return {
    mainWindowExists: true,
    isDockHidden: true,
    dockSide: 'left',
    hasDockMotionSession: true,
    sessionSide: 'left',
    sessionGeneration: 7,
    activeDockEdges: ['top', 'left', 'right'],
    revealHandleEnabled: false,
    sessionRevealHandleEnabled: false,
    sessionMonitorMode: 'direct',
    mainAtHiddenTarget: true,
    isSliding: false,
    slideAgeMs: 0,
    maxSlideAgeMs: 5000,
    maxMonitorPollAgeMs: 1000,
    edgeMonitor: {
      supported: true,
      state: 'armed',
      workerAlive: true,
      generation: 7,
      side: 'left',
      mode: 'direct',
      lastPollAgeMs: 40
    },
    ...overrides
  }
}

describe('dock health inspection', () => {
  it('accepts a consistent native hidden session', () => {
    expect(inspectDockHealth(healthyHiddenSnapshot())).toEqual([])
  })

  it('accepts waiting-outside, trigger-pending and transient degraded states', () => {
    for (const state of ['waiting-outside', 'trigger-pending', 'degraded']) {
      expect(
        inspectDockHealth(
          healthyHiddenSnapshot({
            edgeMonitor: { ...healthyHiddenSnapshot().edgeMonitor, state }
          })
        )
      ).toEqual([])
    }
  })

  it('reports a hidden window without a live native monitor', () => {
    const snapshot = healthyHiddenSnapshot({
      edgeMonitor: {
        ...healthyHiddenSnapshot().edgeMonitor,
        workerAlive: false,
        state: 'failed'
      }
    })

    expect(inspectDockHealth(snapshot)).toEqual([
      '原生边缘监视线程未运行',
      '原生边缘监视器状态异常：failed'
    ])
  })

  it('reports generation and side mismatches', () => {
    const snapshot = healthyHiddenSnapshot({
      edgeMonitor: {
        ...healthyHiddenSnapshot().edgeMonitor,
        generation: 6,
        side: 'right'
      }
    })

    expect(inspectDockHealth(snapshot)).toEqual([
      '原生边缘监视器代次与贴边会话不一致',
      '原生边缘监视器方向与贴边会话不一致'
    ])
  })

  it('reports a monitor whose 100ms poll loop has stalled', () => {
    const snapshot = healthyHiddenSnapshot({
      edgeMonitor: {
        ...healthyHiddenSnapshot().edgeMonitor,
        lastPollAgeMs: 1500
      }
    })

    expect(inspectDockHealth(snapshot)).toContain('原生边缘监视线程已 1500ms 未轮询')
  })

  it('accepts a lazy click-handle window before the first edge touch', () => {
    const snapshot = healthyHiddenSnapshot({
      revealHandleEnabled: true,
      sessionRevealHandleEnabled: true,
      sessionMonitorMode: 'click-handle',
      edgeMonitor: {
        ...healthyHiddenSnapshot().edgeMonitor,
        mode: 'click-handle',
        handleState: 'hidden',
        handleVisible: false,
        handleWindowAlive: false
      }
    })

    expect(inspectDockHealth(snapshot)).toEqual([])
  })

  it.each(['animating', 'appearing', 'ready', 'retreating'])(
    'accepts a live click-handle in the %s stage',
    (handleState) => {
      const snapshot = healthyHiddenSnapshot({
        revealHandleEnabled: true,
        sessionRevealHandleEnabled: true,
        sessionMonitorMode: 'click-handle',
        edgeMonitor: {
          ...healthyHiddenSnapshot().edgeMonitor,
          mode: 'click-handle',
          handleState,
          handleVisible: true,
          handleWindowAlive: true
        }
      })

      expect(inspectDockHealth(snapshot)).toEqual([])
    }
  )

  it.each(['animating', 'appearing', 'ready', 'retreating'])(
    'reports a missing native handle window in the %s stage',
    (handleState) => {
      const snapshot = healthyHiddenSnapshot({
        revealHandleEnabled: true,
        sessionRevealHandleEnabled: true,
        sessionMonitorMode: 'click-handle',
        edgeMonitor: {
          ...healthyHiddenSnapshot().edgeMonitor,
          mode: 'click-handle',
          handleState,
          handleVisible: handleState !== 'ready',
          handleWindowAlive: false
        }
      })

      expect(inspectDockHealth(snapshot)).toContain('小黑条进入显示阶段但原生窗口未运行')
      if (handleState === 'ready') {
        expect(inspectDockHealth(snapshot)).toContain('小黑条已就绪但不可见')
      }
    }
  )

  it('reports changed edge/mode config and an invalid ready handle', () => {
    const snapshot = healthyHiddenSnapshot({
      activeDockEdges: ['top', 'right'],
      revealHandleEnabled: false,
      sessionRevealHandleEnabled: true,
      sessionMonitorMode: 'click-handle',
      edgeMonitor: {
        ...healthyHiddenSnapshot().edgeMonitor,
        mode: 'direct',
        handleState: 'ready',
        handleVisible: false,
        handleWindowAlive: false
      }
    })

    expect(inspectDockHealth(snapshot)).toEqual([
      '隐藏方向已不在当前启用的贴边范围内',
      '隐藏会话的小黑条模式与当前配置不一致',
      '原生边缘监视器的小黑条模式与贴边会话不一致',
      '小黑条进入显示阶段但原生窗口未运行',
      '小黑条已就绪但不可见'
    ])
  })

  it('reports stale native resources after the window is restored', () => {
    const snapshot = healthyHiddenSnapshot({
      isDockHidden: false,
      hasDockMotionSession: true
    })

    expect(inspectDockHealth(snapshot)).toEqual([
      '非隐藏状态残留贴边运动会话',
      '非隐藏状态残留原生边缘监视器'
    ])
  })

  it('reports a stuck slide together with stable-state failures', () => {
    const snapshot = healthyHiddenSnapshot({
      isSliding: true,
      slideAgeMs: 6000,
      mainAtHiddenTarget: false
    })

    expect(inspectDockHealth(snapshot)).toEqual([
      '贴边动画已持续 6000ms，超过允许时间',
      '主窗口未处于本轮会话记录的隐藏位置'
    ])
  })
})
