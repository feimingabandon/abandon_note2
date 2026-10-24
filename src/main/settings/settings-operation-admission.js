/** Owns settings admission only; each callback includes its complete commit and rollback. */
export function createSettingsOperationAdmission() {
  const pending = new Set()
  let owner = null
  let stopped = false

  function rejectLeaving() {
    const error = new Error('正在离开当前页面，暂时无法修改设置')
    error.code = 'SETTINGS_LEAVING'
    throw error
  }

  function assertOpen() {
    if (stopped || owner !== null) rejectLeaving()
  }

  function track(result) {
    // Track a stage that already passed admission, including stages started by an
    // admitted async operation after page-leave sealed new requests.
    if (result && typeof result.then === 'function') {
      const ticket = { completion: Promise.resolve(result) }
      pending.add(ticket)
      const release = () => {
        pending.delete(ticket)
      }
      // Both outcomes release ownership without creating a rejected cleanup promise.
      void ticket.completion.then(release, release)
    }
    return result
  }

  function run(operation) {
    assertOpen()
    return track(operation())
  }

  async function drain() {
    // Always yield once: a synchronous callback can trigger a leave before run()
    // has received and registered that callback's returned promise.
    do {
      await Promise.allSettled([...pending].map((ticket) => ticket.completion))
    } while (pending.size)
  }

  function sealAndDrain(nextOwner) {
    if (!nextOwner || typeof nextOwner !== 'object') {
      throw new TypeError('设置离开操作必须提供独立的 owner 对象')
    }
    if (owner !== null && owner !== nextOwner) rejectLeaving()
    owner = nextOwner
    return drain()
  }

  function resume(previousOwner) {
    if (stopped || owner === null || owner !== previousOwner) return false
    owner = null
    return true
  }

  return Object.freeze({
    assertOpen,
    run,
    track,
    sealAndDrain,
    resume,
    stop() {
      stopped = true
    },
    drain,
    snapshot: () => ({ sealed: owner !== null, stopped, pending: pending.size })
  })
}
