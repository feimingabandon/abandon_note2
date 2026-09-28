import { createPerformanceAggregates } from '../../shared/performance-aggregates.js'
import { isDetailedOperation } from '../../shared/diagnostic-policy.js'
import { isDeepDiagnosticMode } from './diagnostic-state.js'

const aggregates = createPerformanceAggregates()
const noop = () => {}
const enabled = (category, operation) =>
  !isDetailedOperation(category, operation) || isDeepDiagnosticMode()
export const beginPerformanceOperation = (category, operation) =>
  enabled(category, operation) ? aggregates.begin(category, operation) : noop
export const recordPerformanceOperation = (category, operation, duration, metrics) =>
  enabled(category, operation) && aggregates.record(category, operation, duration, metrics)
export const drainOperationPerformance = () => aggregates.drain()

// 只读取已返回结果的数量，不序列化业务数据。
export function performanceResultCounts(result) {
  if (Array.isArray(result)) return { resultRows: result.length }
  for (const key of ['items', 'notes', 'groups']) {
    if (Array.isArray(result?.[key])) return { resultRows: result[key].length }
  }
  return {}
}

export function measureSyncPerformance(
  category,
  operation,
  work,
  summarize = performanceResultCounts,
  summarizeError
) {
  if (!enabled(category, operation)) return work()
  const finish = beginPerformanceOperation(category, operation)
  try {
    const result = work()
    let metrics
    try {
      metrics = summarize?.(result)
    } catch {
      /* 不读取失败的观察结果。 */
    }
    finish(metrics)
    return result
  } catch (error) {
    let metrics = { errors: 1 }
    try {
      metrics = { ...summarizeError?.(error), errors: 1 }
    } catch {
      /* 保留原始业务异常。 */
    }
    finish(metrics)
    throw error
  }
}
