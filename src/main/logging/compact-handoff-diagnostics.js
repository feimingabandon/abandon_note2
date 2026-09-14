// 有界、只读采样；不在恢复透明度与同步释放外壳之间插入 IPC、定时器或读取。
// Win32/Electron 状态不是 DWM 实际呈现帧，readMs 用于评估采样自身的开销。
export function createCompactHandoffDiagnostics({
  window,
  readNative,
  report,
  clock = globalThis
}) {
  const startedAtUnixMs = Date.now()
  const startedAt = performance.now()
  const samples = []
  const timers = []
  let finished = false
  const sample = (stage) => {
    if (finished || samples.length >= 24) return
    const begin = performance.now()
    try {
      if (window.isDestroyed()) return
      const native = readNative(window)
      // timing 是上一轮动画的累计明细，不是当前帧；已有独立日志，不重复记录。
      if (native) delete native.timing
      samples.push({
        stage,
        elapsedMs: begin - startedAt,
        bounds: window.getBounds(),
        contentBounds: window.getContentBounds(),
        opacity: window.getOpacity(),
        visible: window.isVisible(),
        native,
        readMs: performance.now() - begin
      })
    } catch {
      // 诊断失败不可中断正常过渡或回滚。
    }
  }
  const finish = (reason) => {
    if (finished) return
    finished = true
    for (const timer of timers) clock.clearTimeout(timer)
    window.removeListener('closed', closed)
    try {
      report({
        startedAtUnixMs,
        totalMs: performance.now() - startedAt,
        reason,
        timingMeaning: 'read-only window snapshots; not GPU presentation timestamps',
        coordinateMeaning: 'Electron bounds in DIP; native rectangles in physical pixels',
        samples
      })
    } catch {
      // 日志关闭或窗口销毁时不影响主流程。
    }
  }
  const closed = () => finish('closed')
  window.once('closed', closed)
  return {
    sample,
    finish,
    tail() {
      if (finished || timers.length) return
      // 调用者恢复稳定态及窗口运行配置后，同一轮事件循环再开始尾部采样。
      for (const delay of [0, 16, 50, 100, 200]) {
        timers.push(
          clock.setTimeout(() => {
            sample(`tail-${delay}`)
            if (delay === 200) finish('settled')
          }, delay)
        )
      }
    }
  }
}
