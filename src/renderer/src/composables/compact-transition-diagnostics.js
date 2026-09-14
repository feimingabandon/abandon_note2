// rAF/resize 表示 renderer 的调度与布局尺寸，不等同于 GPU 已呈现到屏幕。
// 只记录窗口及固定呈现层的几何/透明度，不采集正文、图片、HTML，不逐帧 IPC。
const LAYERS = {
  expanded: '.compact-presentation-layer--expanded',
  compact: '.compact-presentation-layer--compact',
  island: '.compact-island'
}
function readPresentation(host) {
  const layers = {}
  for (const [name, selector] of Object.entries(LAYERS)) {
    const element = host.document?.querySelector(selector)
    if (!element) continue
    const rect = element.getBoundingClientRect()
    const style = host.getComputedStyle(element)
    layers[name] = {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      opacity: Number(style.opacity),
      visibility: style.visibility
    }
  }
  return layers
}

export function createCompactTransitionDiagnostics(host = window) {
  let trace = null
  let frame = null
  let timeout = null
  let tailTimeout = null
  const sample = (event) => {
    if (!trace) return
    if (trace.frames.length >= 256) {
      trace.droppedFrames += 1
      return
    }
    const started = host.performance.now()
    let layers
    // 只在关键交接与稳定尾段读固定的三个元素，失败不影响呈现。
    try {
      if (['content-enter', 'stable'].includes(trace.stage)) layers = readPresentation(host)
    } catch {
      /* 窗口卸载时允许缺少布局数据。 */
    }
    trace.frames.push({
      event,
      stage: trace.stage,
      elapsedMs: host.performance.now() - trace.startedAt,
      width: host.innerWidth,
      height: host.innerHeight,
      devicePixelRatio: host.devicePixelRatio,
      screenX: host.screenX,
      screenY: host.screenY,
      outerWidth: host.outerWidth,
      outerHeight: host.outerHeight,
      layers,
      readMs: host.performance.now() - started
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
    host.clearTimeout(tailTimeout)
    tailTimeout = null
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
        if (trace && trace.stage !== 'stable') {
          trace.stage = 'stable'
          sample('stage')
          tailTimeout = host.setTimeout(() => finish('stable'), 200)
        }
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
