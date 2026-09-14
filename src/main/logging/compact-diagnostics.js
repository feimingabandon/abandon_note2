const STAGES = new Set([
  'content-exit',
  'shell-transform',
  'shell-settle',
  'content-enter',
  'stable'
])
const EVENTS = new Set(['stage', 'raf', 'resize', 'end'])
const finite = (value, min, max) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

export function normalizeCompactRendererDiagnostics(payload, currentGeneration) {
  if (
    !payload ||
    !Number.isInteger(payload.generation) ||
    payload.generation <= 0 ||
    payload.generation > currentGeneration ||
    payload.generation < currentGeneration - 4 ||
    !['collapsing', 'expanding'].includes(payload.phase) ||
    !['stable', 'replaced', 'timeout', 'unmounted'].includes(payload.reason) ||
    !finite(payload.startedAtUnixMs, 0, 1e15) ||
    !finite(payload.totalMs, 0, 60000) ||
    !Array.isArray(payload.frames) ||
    payload.frames.length > 256
  )
    return null
  const frames = []
  let previous = -1
  for (const f of payload.frames) {
    if (
      !f ||
      !EVENTS.has(f.event) ||
      !STAGES.has(f.stage) ||
      !finite(f.elapsedMs, 0, 60000) ||
      f.elapsedMs < previous ||
      !finite(f.width, 0, 100000) ||
      !finite(f.height, 0, 100000) ||
      !finite(f.devicePixelRatio, 0.1, 16)
    )
      return null
    previous = f.elapsedMs
    const extra = {}
    for (const key of ['screenX', 'screenY', 'outerWidth', 'outerHeight', 'readMs']) {
      if (f[key] === undefined) continue
      if (!finite(f[key], ['screenX', 'screenY'].includes(key) ? -100000 : 0, 100000)) return null
      extra[key] = f[key]
    }
    if (f.layers !== undefined) {
      if (!f.layers || typeof f.layers !== 'object' || Array.isArray(f.layers)) return null
      extra.layers = {}
      for (const key of ['expanded', 'compact', 'island']) {
        const layer = f.layers[key]
        if (!layer) continue
        if (
          !finite(layer.x, -100000, 100000) ||
          !finite(layer.y, -100000, 100000) ||
          !finite(layer.width, 0, 100000) ||
          !finite(layer.height, 0, 100000) ||
          !finite(layer.opacity, 0, 1) ||
          !['visible', 'hidden', 'collapse'].includes(layer.visibility)
        )
          return null
        extra.layers[key] = {
          x: layer.x,
          y: layer.y,
          width: layer.width,
          height: layer.height,
          opacity: layer.opacity,
          visibility: layer.visibility
        }
      }
    }
    frames.push({
      event: f.event,
      stage: f.stage,
      elapsedMs: f.elapsedMs,
      width: f.width,
      height: f.height,
      devicePixelRatio: f.devicePixelRatio,
      ...extra
    })
  }
  return {
    generation: payload.generation,
    phase: payload.phase,
    reason: payload.reason,
    startedAtUnixMs: payload.startedAtUnixMs,
    totalMs: payload.totalMs,
    droppedFrames: finite(payload.droppedFrames, 0, 1e9) ? payload.droppedFrames : 0,
    timingMeaning: 'renderer rAF/resize samples; not GPU presentation timestamps',
    frames
  }
}
