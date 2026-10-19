import { AsyncLocalStorage } from 'node:async_hooks'

/** Clear closes admission before draining complete mutations, including resource cleanup. */
export function createBusinessMutationAdmission() {
  const pending = new Set()
  const scopes = new AsyncLocalStorage()
  let clearing = false
  let stopped = false
  let clearTask = null
  let shutdownDrainComplete = false

  function run(operation) {
    const internal = scopes.getStore()?.active === true
    if (stopped && !internal) throw new Error('软件正在退出，请稍后重试')
    if (clearing && !internal) throw new Error('正在清空便签数据，请完成后再试')
    const scope = { active: true }
    let result
    try {
      result = scopes.run(scope, operation)
    } catch (error) {
      scope.active = false
      throw error
    }
    if (result && typeof result.then === 'function') {
      const completion = Promise.resolve(result)
      pending.add(completion)
      const release = () => {
        scope.active = false
        pending.delete(completion)
      }
      // Observe both outcomes without producing an unhandled cleanup rejection.
      void completion.then(release, release)
    } else scope.active = false
    return result
  }

  async function drainMutations() {
    // A tracked parent may start another async child while the first snapshot drains.
    while (pending.size) await Promise.allSettled([...pending])
  }

  async function drain() {
    // Shutdown waits for an already-started clear, including file/draft presentation.
    // clear itself calls drainMutations, otherwise it would wait on its own task.
    while (pending.size || clearTask) {
      await drainMutations()
      if (clearTask) await Promise.allSettled([clearTask])
    }
    if (stopped) shutdownDrainComplete = true
  }

  function clear(operation) {
    // Keep rejections asynchronous for the IPC contract, while sealing immediately.
    try {
      if (stopped) throw new Error('软件正在退出，请稍后重试')
      if (scopes.getStore()?.active) throw new Error('业务写入内部不能清空便签数据')
      if (clearing) throw new Error('正在清空便签数据，请勿重复操作')
    } catch (error) {
      return Promise.reject(error)
    }
    clearing = true
    const completion = (async () => {
      try {
        await drainMutations()
        return await operation()
      } finally {
        clearing = false
        clearTask = null
      }
    })()
    clearTask = completion
    return completion
  }

  function bindContinuation(operation) {
    const scope = scopes.getStore()
    if (!scope?.active) return (...args) => run(() => operation(...args))
    // A renderer ready IPC is a later event, rather than a descendant async task.
    // Retain only its admitted command scope, and invalidate it when that command settles.
    return (...args) => {
      if (!scope.active) throw new Error('业务操作已经结束，请重新发起')
      return scopes.run(scope, () => run(() => operation(...args)))
    }
  }

  function runCleanup(operation) {
    if (!stopped || !shutdownDrainComplete || pending.size || clearTask) {
      throw new Error('退出业务排空完成后才能同步清理')
    }
    if (operation.constructor?.name === 'AsyncFunction') {
      throw new Error('退出清理只允许同步操作')
    }
    const scope = { active: true }
    try {
      const result = scopes.run(scope, operation)
      if (result && typeof result.then === 'function') {
        // This port is reserved for the known synchronous final sticky-bounds save.
        // Revoke its scope immediately; late continuation writes remain sealed.
        void Promise.resolve(result).catch(() => {})
        throw new Error('退出清理只允许同步操作')
      }
      return result
    } finally {
      scope.active = false
    }
  }

  return Object.freeze({
    run,
    bindContinuation,
    runCleanup,
    canAdmit: () => !clearing && !stopped,
    clear,
    preventNewMutations() {
      stopped = true
      shutdownDrainComplete = false
    },
    drain,
    snapshot: () => ({ clearing, pending: pending.size })
  })
}
