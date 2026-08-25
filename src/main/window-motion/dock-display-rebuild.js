import { DOCK_REVEAL_HANDLE_MODES } from '../../shared/settings-schema.js'

function normalizeHandlePositionPermille(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1000 ? value : null
}

/**
 * 拖动释放时，原生线程先提交位置再异步通知主进程。显示参数变化可能先于
 * handle-moved 消息被 JS 消费，因此重建前以同代次原生快照为最新已提交值。
 */
export function resolveFullscreenRebuildHandlePosition(session, monitorStatus) {
  if (session?.revealHandleMode !== DOCK_REVEAL_HANDLE_MODES.PERSISTENT) return null

  const sessionPosition = normalizeHandlePositionPermille(session.handlePositionPermille)
  const isCurrentNativeSession =
    monitorStatus?.generation === session.generation &&
    monitorStatus?.side === session.side &&
    monitorStatus?.mode === DOCK_REVEAL_HANDLE_MODES.PERSISTENT
  if (!isCurrentNativeSession) return sessionPosition

  return normalizeHandlePositionPermille(monitorStatus.handlePositionPermille) ?? sessionPosition
}

export function stopEdgeMonitorForFullscreenRebuild({
  backend,
  generation,
  beginNativeEdgeCleanup,
  emergencyRestoreDock
}) {
  try {
    if (backend.disarmEdgeMonitor(generation)) return true

    beginNativeEdgeCleanup(generation, backend, 'fullscreen-display-rebuild-stop-timeout')
    emergencyRestoreDock(
      'fullscreen-display-rebuild-stop-timeout',
      new Error('全屏分辨率变化后停止旧边缘监视器超时'),
      { skipNativeDisarm: true }
    )
  } catch (error) {
    beginNativeEdgeCleanup(generation, backend, 'fullscreen-display-rebuild-stop-failed')
    emergencyRestoreDock('fullscreen-display-rebuild-stop-failed', error, {
      skipNativeDisarm: true
    })
  }
  return false
}
