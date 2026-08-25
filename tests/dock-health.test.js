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
    revealHandleMode: 'direct',
    sessionRevealHandleMode: 'direct',
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
      handlePresented: false,
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

  it('accepts a prewarmed off-screen on-touch handle before the first edge touch', () => {
    const snapshot = healthyHiddenSnapshot({
      revealHandleMode: 'on-touch',
      sessionRevealHandleMode: 'on-touch',
      edgeMonitor: {
        ...healthyHiddenSnapshot().edgeMonitor,
        mode: 'on-touch',
        handleState: 'hidden',
        handleVisible: false,
        handleWindowAlive: true
      }
    })

    expect(inspectDockHealth(snapshot)).toEqual([])
  })

  it.each(['animating', 'appearing', 'ready', 'retreating'])(
    'accepts a live on-touch handle in the %s stage',
    (handleState) => {
      const snapshot = healthyHiddenSnapshot({
        revealHandleMode: 'on-touch',
        sessionRevealHandleMode: 'on-touch',
        edgeMonitor: {
          ...healthyHiddenSnapshot().edgeMonitor,
          mode: 'on-touch',
          handleState,
          handleVisible: true,
          handlePresented: handleState === 'ready',
          handleWindowAlive: true
        }
      })

      expect(inspectDockHealth(snapshot)).toEqual([])
    }
  )

  it.each(['hidden', 'animating', 'appearing', 'ready', 'retreating'])(
    'reports a missing native handle window in the %s stage',
    (handleState) => {
      const snapshot = healthyHiddenSnapshot({
        revealHandleMode: 'on-touch',
        sessionRevealHandleMode: 'on-touch',
        edgeMonitor: {
          ...healthyHiddenSnapshot().edgeMonitor,
          mode: 'on-touch',
          handleState,
          handleVisible: handleState !== 'ready',
          handleWindowAlive: false
        }
      })

      expect(inspectDockHealth(snapshot)).toContain('小黑条原生窗口未持续运行')
      if (handleState === 'ready') {
        expect(inspectDockHealth(snapshot)).toContain('小黑条已就绪但不可见')
        expect(inspectDockHealth(snapshot)).toContain('小黑条已就绪但画面未成功提交')
      }
    }
  )

  it('reports changed edge/mode config and an invalid ready handle', () => {
    const snapshot = healthyHiddenSnapshot({
      activeDockEdges: ['top', 'right'],
      revealHandleMode: 'direct',
      sessionRevealHandleMode: 'on-touch',
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
      '小黑条原生窗口未持续运行',
      '小黑条已就绪但不可见',
      '小黑条已就绪但画面未成功提交'
    ])
  })

  it('accepts an activated persistent handle and reports a missing activation', () => {
    const persistent = healthyHiddenSnapshot({
      revealHandleMode: 'persistent',
      sessionRevealHandleMode: 'persistent',
      edgeMonitor: {
        ...healthyHiddenSnapshot().edgeMonitor,
        mode: 'persistent',
        persistentHandleActivated: true,
        handleState: 'ready',
        handleVisible: true,
        handlePresented: true,
        handleWindowAlive: true
      }
    })

    expect(inspectDockHealth(persistent)).toEqual([])
    expect(
      inspectDockHealth({
        ...persistent,
        edgeMonitor: { ...persistent.edgeMonitor, persistentHandleActivated: false }
      })
    ).toContain('常显小黑条尚未激活')
    expect(
      inspectDockHealth({
        ...persistent,
        edgeMonitor: { ...persistent.edgeMonitor, handlePresented: false }
      })
    ).toContain('小黑条已就绪但画面未成功提交')
    expect(
      inspectDockHealth({
        ...persistent,
        edgeMonitor: { ...persistent.edgeMonitor, handlePresented: null }
      })
    ).toContain('小黑条已就绪但画面未成功提交')
  })

  it('reports a ready handle when the native presentation status is missing', () => {
    const persistent = healthyHiddenSnapshot({
      revealHandleMode: 'persistent',
      sessionRevealHandleMode: 'persistent',
      edgeMonitor: {
        ...healthyHiddenSnapshot().edgeMonitor,
        mode: 'persistent',
        persistentHandleActivated: true,
        handleState: 'ready',
        handleVisible: true,
        handleWindowAlive: true
      }
    })
    delete persistent.edgeMonitor.handlePresented

    expect(inspectDockHealth(persistent)).toContain('小黑条已就绪但画面未成功提交')
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
