/** Attempt every post-commit step before releasing business admission. */
export async function runCommittedDataCleanup(steps, reportFailure = () => {}) {
  const failures = []
  for (const step of steps) {
    try {
      await step.run()
    } catch (error) {
      const failure = { id: step.id, label: step.label, error }
      failures.push(failure)
      try {
        reportFailure(failure)
      } catch {
        // Diagnostics cannot cancel the remaining committed-data cleanup.
      }
    }
  }
  return failures
}

/** A failed recipient must not prevent the remaining windows from refreshing. */
export function broadcastBusinessDataCleared(windows) {
  const failures = []
  for (const window of windows) {
    try {
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) continue
      window.webContents.send('notes:changed', { reason: 'note-data-cleared' })
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, '部分窗口清空通知失败')
}

export function createBusinessClearCleanupError(failures) {
  const labels = [...new Set(failures.map((failure) => failure.label))].join('、')
  const error = new Error(
    `便签业务数据已清空，但${labels}失败。请重新打开软件后检查，无需再次清空数据。`,
    {
      cause: new AggregateError(
        failures.map((failure) => failure.error),
        '清空后收尾未完成'
      )
    }
  )
  error.code = 'BUSINESS_DATA_CLEANUP_INCOMPLETE'
  error.committed = true
  error.failedSteps = failures.map((failure) => failure.id)
  return error
}
