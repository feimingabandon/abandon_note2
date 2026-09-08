// rAF/resize 表示 renderer 的调度与布局尺寸，不等同于 GPU 已呈现到屏幕。
// 只采样窗口数值，不读 DOM 布局、不采集便签内容、不逐帧 IPC。
export function createCompactTransitionDiagnostics(host = window) {
  let trace = null
  let frame = null
  let timeout = null
  const sample = (event) => {
    if (!trace) return
    if (trace.frames.length >= 256) {
      trace.droppedFrames += 1
      return
    }
    trace.frames.push({
      event,
      stage: trace.stage,
      elapsedMs: host.performance.now() - trace.startedAt,
      width: host.innerWidth,
      height: host.innerHeight,
      devicePixelRatio: host.devicePixelRatio
    })
  }
  const resize = () => sample('resize')
  const tick = () => {
    sample('raf')
    if (trace) frame = host.requestAnimationFrame(tick)
  }
  const finish = (reason) => {
    if (!trace) return
    sample('end')
    host.cancelAnimationFrame(frame)
    host.clearTimeout(timeout)
    host.removeEventListener('resize', resize)
    const completed = trace
    trace = null
    try {
      host.api.reportCompactTransitionDiagnostics?.({
        generation: completed.generation,
        phase: completed.phase,
        reason,
        startedAtUnixMs: completed.startedAtUnixMs,
        totalMs: host.performance.now() - completed.startedAt,
        frames: completed.frames,
        droppedFrames: completed.droppedFrames
      })
    } catch {
      /* 窗口销毁时丢弃采样，不影响正常呈现状态。 */
    }
  }
  return {
    update(state) {
      const generation = state?.transition?.generation
      if (!Number.isInteger(generation) || !['collapsing', 'expanding'].includes(state.phase)) {
        finish('stable')
        return
      }
      if (trace?.generation !== generation) {
        finish('replaced')
        trace = {
          generation,
          phase: state.phase,
          stage: state.transition.stage,
          startedAt: host.performance.now(),
          startedAtUnixMs: Date.now(),
          frames: [],
          droppedFrames: 0
        }
        host.addEventListener('resize', resize)
        frame = host.requestAnimationFrame(tick)
        timeout = host.setTimeout(() => finish('timeout'), 3000)
      }
      trace.stage = state.transition.stage
      sample('stage')
    },
    stop: () => finish('unmounted')
  }
}
