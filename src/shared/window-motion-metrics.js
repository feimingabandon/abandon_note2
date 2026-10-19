// Fixed-size, in-memory observations. These are callback/API timings, not presented FPS.
const thresholds = [8, 16, 33, 50, 100, 250, 1000]
const round = (value) => Math.round(value * 100) / 100
const namePattern = /^[a-zA-Z0-9._-]{1,64}$/

export function createWindowMotionMetrics({ maxStages = 16, maxSamples = 6 } = {}) {
  const stages = new Map()
  const counters = new Map()
  const samples = []
  let omitted = 0
  return {
    add(name, duration) {
      if (!namePattern.test(name) || !Number.isFinite(duration) || duration < 0) return
      if (!stages.has(name)) {
        if (stages.size >= maxStages) return void omitted++
        stages.set(name, { count: 0, totalMs: 0, maxMs: 0, bins: Array(8).fill(0) })
      }
      const entry = stages.get(name)
      entry.count++
      entry.totalMs += duration
      entry.maxMs = Math.max(entry.maxMs, duration)
      const index = thresholds.findIndex((threshold) => duration <= threshold)
      entry.bins[index < 0 ? 7 : index]++
    },
    count(name, value = 1) {
      if (!namePattern.test(name) || !Number.isFinite(value) || value < 0) return
      if (!counters.has(name) && counters.size >= maxStages) return void omitted++
      counters.set(name, (counters.get(name) || 0) + value)
    },
    sample(duration, values) {
      if (!Number.isFinite(duration) || duration < 0) return
      // Allow only numerical diagnostic fields. Never retain caller payloads or text.
      const numeric = Object.fromEntries(
        Object.entries(values || {})
          .slice(0, 16)
          .filter(([key, value]) => namePattern.test(key) && Number.isFinite(value))
          .map(([key, value]) => [key, round(value)])
      )
      samples.push({ durationMs: round(duration), ...numeric })
      samples.sort((a, b) => b.durationMs - a.durationMs)
      if (samples.length > maxSamples) samples.pop()
    },
    drain() {
      const result = {
        stages: Object.fromEntries(
          [...stages].map(([name, entry]) => [
            name,
            {
              count: entry.count,
              totalMs: round(entry.totalMs),
              meanMs: round(entry.totalMs / entry.count),
              maxMs: round(entry.maxMs),
              bins: entry.bins
            }
          ])
        ),
        counters: Object.fromEntries(counters),
        slowSamples: samples.slice(),
        durationBinUpperMs: [...thresholds, null],
        omitted
      }
      stages.clear()
      counters.clear()
      samples.length = 0
      omitted = 0
      return result
    }
  }
}

// The handshake provides an offset interval, not an assumed shared process clock.
export function estimateMotionDelivery(packet, receivedAt) {
  const { sentAt, clockOffsetLowMs: low, clockOffsetHighMs: high } = packet || {}
  if (![sentAt, low, high, receivedAt].every(Number.isFinite) || high < low || high - low > 5000)
    return { status: 'clock-unavailable' }
  const upperMs = receivedAt - sentAt - low
  const lowerMs = receivedAt - sentAt - high
  if (upperMs < -2 || upperMs > 120000) return { status: 'clock-invalid' }
  return {
    status: 'estimated',
    lowerMs: round(Math.max(0, lowerMs)),
    upperMs: round(Math.max(0, upperMs)),
    uncertaintyMs: round(high - low)
  }
}
