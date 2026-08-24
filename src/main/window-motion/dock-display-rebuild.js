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
