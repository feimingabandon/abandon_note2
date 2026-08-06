function sameBounds(actual, expected) {
  if (!actual || !expected) return false
  return (
    actual.x === expected.x &&
    actual.y === expected.y &&
    actual.width === expected.width &&
    actual.height === expected.height
  )
}

/**
 * BrowserWindow 的构造尺寸只是请求值。Windows/Chromium 可能把极窄窗口放大，
 * 因此要按创建后的真实尺寸重新定位，让屏幕内始终只露出指定宽度。
 */
export function alignTriggerBoundsToEdge({ side, requestedBounds, actualBounds, visibleWidth }) {
  const width = Math.max(visibleWidth, actualBounds.width)
  const hiddenWidth = width - visibleWidth
  return {
    x: side === 'left' ? requestedBounds.x - hiddenWidth : requestedBounds.x,
    y: requestedBounds.y,
    width,
    height: actualBounds.height
  }
}

/**
 * 检查贴边隐藏状态是否自洽。这里只报告内部状态损坏，不尝试判断鼠标事件
 * 是否真的可以命中透明触发窗口，也不会修改任何窗口状态。
 */
export function inspectDockHealth(snapshot) {
  const issues = []

  if (!snapshot.mainWindowExists) {
    if (snapshot.isDockHidden || snapshot.hasDockMotionSession || snapshot.trigger.exists) {
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
    if (snapshot.dockSide !== 'left' && snapshot.dockSide !== 'right') {
      issues.push('隐藏状态缺少有效的贴边方向')
    }
    if (!snapshot.hasDockMotionSession) {
      issues.push('隐藏状态缺少贴边运动会话')
    } else if (snapshot.sessionSide !== snapshot.dockSide) {
      issues.push('贴边运动会话方向与当前贴边方向不一致')
    }
    if (snapshot.mainAtHiddenTarget !== true) {
      issues.push('主窗口未处于本轮会话记录的隐藏位置')
    }
    if (!snapshot.trigger.exists) {
      issues.push('隐藏状态缺少边缘触发窗口')
      return issues
    }
    if (snapshot.trigger.destroyed) issues.push('边缘触发窗口已经销毁')
    if (snapshot.trigger.webContentsDestroyed) issues.push('边缘触发窗口的渲染进程已经销毁')
    if (!snapshot.trigger.pageLoaded) issues.push('边缘触发页面尚未加载完成')
    if (!snapshot.trigger.visible) issues.push('边缘触发窗口当前不可见')
    if (snapshot.trigger.alwaysOnTop !== snapshot.trigger.expectedAlwaysOnTop) {
      issues.push('边缘触发窗口的置顶状态与当前窗口设置不一致')
    }
    if (!sameBounds(snapshot.trigger.bounds, snapshot.expectedTriggerBounds)) {
      issues.push('边缘触发窗口的位置或尺寸与贴边会话不一致')
    }
  } else {
    if (snapshot.hasDockMotionSession && !snapshot.isSliding) {
      issues.push('非隐藏状态残留贴边运动会话')
    }
    if (snapshot.trigger.exists) issues.push('非隐藏状态残留边缘触发窗口')
  }

  return issues
}
