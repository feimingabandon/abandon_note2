class StartupCancelled extends Error {}

/** A failed recovery must keep sibling storage work inside the startup lifetime. */
export async function settleStartupRecoveries(recoveries) {
  const outcomes = await Promise.allSettled(
    recoveries.map((recover) => Promise.resolve().then(recover))
  )
  const failures = outcomes.filter((outcome) => outcome.status === 'rejected')
  if (failures.length) {
    throw new AggregateError(
      failures.map((outcome) => outcome.reason),
      '启动存储恢复未能全部完成'
    )
  }
  return outcomes.map((outcome) => outcome.value)
}

/** Owns startup admission and the created-stage ledger, including late async continuations. */
export function createApplicationBootstrap({ whenReady, start, onFailure }) {
  let promise = null
  let stopping = false
  let phase = 'idle'
  const stages = new Map()

  function checkpoint() {
    if (stopping) throw new StartupCancelled('Application startup was cancelled')
  }

  async function runStage(name, operation) {
    checkpoint()
    if (stages.has(name)) throw new Error(`Startup stage already entered: ${name}`)
    stages.set(name, 'starting')
    try {
      const value = await operation()
      stages.set(name, 'created')
      checkpoint()
      return value
    } catch (error) {
      if (!(error instanceof StartupCancelled)) stages.set(name, 'failed')
      throw error
    }
  }

  return {
    start() {
      if (promise) return promise
      phase = 'waiting'
      promise = Promise.resolve()
        .then(whenReady)
        .then(async () => {
          checkpoint()
          phase = 'starting'
          await start({ runStage, checkpoint })
          checkpoint()
          phase = 'ready'
        })
        .catch((error) => {
          if (error instanceof StartupCancelled) {
            phase = 'cancelled'
            return
          }
          phase = 'failed'
          onFailure(error)
        })
      return promise
    },
    cancel() {
      stopping = true
      if (phase !== 'failed') phase = 'stopping'
    },
    settled: () => promise || Promise.resolve(),
    snapshot() {
      return { phase, stopping, stages: Object.fromEntries(stages) }
    }
  }
}
