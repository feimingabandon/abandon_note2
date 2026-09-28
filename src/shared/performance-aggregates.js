// 有界、纯内存的性能统计。名称来自代码中的操作名，附加字段只接受数值；
// 不保存 SQL、参数、文本、文件路径、图片内容，也不在采集过程中写日志。
const noop = () => {}
const namePattern = /^[a-zA-Z0-9:._-]{1,96}$/
const round = (value) => Math.round(value * 100) / 100

export function createPerformanceAggregates({
  now = () => performance.now(),
  wallNow = () => Date.now(),
  maxEntries = 128
} = {}) {
  const entries = new Map()
  let intervalStart = wallNow()
  let omitted = 0

  function empty(active = 0) {
    return {
      started: 0,
      count: 0,
      active,
      peakActive: active,
      totalMs: 0,
      maxMs: 0,
      over50ms: 0,
      over100ms: 0,
      over250ms: 0,
      metrics: Object.create(null)
    }
  }
  function get(category, operation) {
    if (!namePattern.test(category) || !namePattern.test(operation)) return null
    const key = `${category}/${operation}`
    if (!entries.has(key)) {
      if (entries.size >= maxEntries) {
        omitted++
        return null
      }
      entries.set(key, { category, operation, values: empty() })
    }
    return entries.get(key)
  }
  function add(entry, duration, metrics = {}) {
    const value = entry.values
    value.count++
    if (Number.isFinite(duration) && duration >= 0) {
      value.totalMs += duration
      value.maxMs = Math.max(value.maxMs, duration)
      if (duration > 50) value.over50ms++
      if (duration > 100) value.over100ms++
      if (duration > 250) value.over250ms++
    }
    for (const [key, number] of Object.entries(metrics).slice(0, 16)) {
      if (!namePattern.test(key) || !Number.isFinite(number) || number < 0) continue
      if (!value.metrics[key] && Object.keys(value.metrics).length >= 16) continue
      const metric = value.metrics[key] || (value.metrics[key] = { count: 0, total: 0, max: 0 })
      metric.count++
      metric.total += number
      metric.max = Math.max(metric.max, number)
    }
  }

  return {
    begin(category, operation) {
      try {
        const entry = get(category, operation)
        if (!entry) return noop
        const started = now()
        entry.values.started++
        entry.values.active++
        entry.values.peakActive = Math.max(entry.values.peakActive, entry.values.active)
        let finished = false
        return (metrics) => {
          if (finished) return
          finished = true
          try {
            entry.values.active--
            add(entry, now() - started, metrics)
          } catch {
            /* 诊断失败不能改变操作的返回值或异常。 */
          }
        }
      } catch {
        return noop
      }
    },
    record(category, operation, duration = 0, metrics) {
      try {
        const entry = get(category, operation)
        if (entry) add(entry, duration, metrics)
      } catch {
        /* 只丢弃本次统计。 */
      }
    },
    drain() {
      const intervalEnd = wallNow()
      const result = []
      for (const entry of entries.values()) {
        const value = entry.values
        if (!value.count && !value.started && !value.active) continue
        result.push({
          category: entry.category,
          operation: entry.operation,
          ...value,
          totalMs: round(value.totalMs),
          maxMs: round(value.maxMs),
          meanMs: value.count ? round(value.totalMs / value.count) : null,
          metrics: Object.fromEntries(
            Object.entries(value.metrics).map(([key, metric]) => [
              key,
              { count: metric.count, total: round(metric.total), max: round(metric.max) }
            ])
          )
        })
        entry.values = empty(value.active)
      }
      const batch = {
        intervalStart: new Date(intervalStart).toISOString(),
        intervalEnd: new Date(intervalEnd).toISOString(),
        entries: result,
        omitted
      }
      intervalStart = intervalEnd
      omitted = 0
      return batch
    }
  }
}
