/**
 * 检查贴边隐藏状态是否自洽。鼠标检测由 DLL 的 100ms 监视线程负责；这里是
 * 每分钟执行一次的结构检查，只报告问题，由调用者统一执行故障开放恢复。
 */
export function inspectDockHealth(snapshot) {
  const issues = []
  const edgeMonitor = snapshot.edgeMonitor || {
    supported: false,
    state: 'unavailable',
    workerAlive: false,
    generation: 0,
    side: null,
    lastPollAgeMs: Infinity
  }

  if (!snapshot.mainWindowExists) {
    if (snapshot.isDockHidden || snapshot.hasDockMotionSession || edgeMonitor.workerAlive) {
      issues.push('主窗口不存在，但贴边资源仍然处于活动状态')
    }
    return issues
  }

  if (snapshot.isSliding && snapshot.slideAgeMs >= snapshot.maxSlideAgeMs) {
    issues.push(`贴边动画已持续 ${snapshot.slideAgeMs}ms，超过允许时间`)
  }

  // 正常动画只有约 200ms，期间页面加载和会话清理都可能处于过渡态；只有动画
  // 超时后才继续检查这些稳定态不变量，避免整分 tick 恰好撞上动画时误报。
  if (snapshot.isSliding && snapshot.slideAgeMs < snapshot.maxSlideAgeMs) return issues

  if (snapshot.isDockHidden) {
    if (!['left', 'right', 'top'].includes(snapshot.dockSide)) {
      issues.push('隐藏状态缺少有效的贴边方向')
    }
    if (!snapshot.hasDockMotionSession) {
      issues.push('隐藏状态缺少贴边运动会话')
    } else if (snapshot.sessionSide !== snapshot.dockSide) {
      issues.push('贴边运动会话方向与当前贴边方向不一致')
    }
    if (
      Array.isArray(snapshot.activeDockEdges) &&
      !snapshot.activeDockEdges.includes(snapshot.dockSide)
    ) {
      issues.push('隐藏方向已不在当前启用的贴边范围内')
    }
    if (snapshot.sessionRevealHandleEnabled !== snapshot.revealHandleEnabled) {
      issues.push('隐藏会话的小黑条模式与当前配置不一致')
    }
    if (snapshot.mainAtHiddenTarget !== true) {
      issues.push('主窗口未处于本轮会话记录的隐藏位置')
    }
    const monitor = edgeMonitor
    if (!monitor.supported) issues.push('Windows 原生边缘监视器不可用')
    if (!monitor.workerAlive) issues.push('原生边缘监视线程未运行')
    if (monitor.generation !== snapshot.sessionGeneration) {
      issues.push('原生边缘监视器代次与贴边会话不一致')
    }
    if (monitor.side !== snapshot.dockSide) {
      issues.push('原生边缘监视器方向与贴边会话不一致')
    }
    if (typeof monitor.mode === 'string' && monitor.mode !== snapshot.sessionMonitorMode) {
      issues.push('原生边缘监视器的小黑条模式与贴边会话不一致')
    }
    if (snapshot.sessionRevealHandleEnabled === true) {
      // 原生小黑条 HWND 按需创建；尚未首次触边时 hidden + windowAlive=false 是正常态。
      if (
        ['animating', 'appearing', 'ready', 'retreating'].includes(monitor.handleState) &&
        monitor.handleWindowAlive !== true
      ) {
        issues.push('小黑条进入显示阶段但原生窗口未运行')
      }
      if (monitor.handleState === 'ready' && monitor.handleVisible !== true) {
        issues.push('小黑条已就绪但不可见')
      }
    }
    if (!['waiting-outside', 'armed', 'trigger-pending', 'degraded'].includes(monitor.state)) {
      issues.push(`原生边缘监视器状态异常：${monitor.state}`)
    }
    if (monitor.state !== 'degraded' && monitor.lastPollAgeMs > snapshot.maxMonitorPollAgeMs) {
      issues.push(`原生边缘监视线程已 ${monitor.lastPollAgeMs}ms 未轮询`)
    }
  } else {
    if (snapshot.hasDockMotionSession && !snapshot.isSliding) {
      issues.push('非隐藏状态残留贴边运动会话')
    }
    if (edgeMonitor.workerAlive || edgeMonitor.state !== 'stopped') {
      issues.push('非隐藏状态残留原生边缘监视器')
    }
  }

  return issues
}
