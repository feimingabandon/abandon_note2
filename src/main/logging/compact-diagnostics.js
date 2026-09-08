const STAGES = new Set(['content-exit', 'shell-transform', 'shell-settle', 'content-enter'])
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
    frames.push({
      event: f.event,
      stage: f.stage,
      elapsedMs: f.elapsedMs,
      width: f.width,
      height: f.height,
      devicePixelRatio: f.devicePixelRatio
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
