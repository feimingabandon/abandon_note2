// Settings participants keep their own pending values and write lifetimes. This page-level
// rendezvous only owns one leave attempt and resumes its participants when it is cancelled.
const participants = new Set()
let activeOperation = null

function cancelledError() {
  const error = new Error('页面离开准备已取消')
  error.code = 'PAGE_LEAVE_CANCELLED'
  return error
}

function releaseParticipant(operation, record) {
  if (record.released) return
  record.released = true
  record.detach()
  operation.records.delete(record)
  try {
    record.participant.resume(operation.id)
  } catch (error) {
    console.error('[page-leave] 恢复设置编辑失败:', error)
  }
}

function cancelOperation(operation) {
  if (activeOperation === operation) activeOperation = null
  operation.cancel()
  for (const record of [...operation.records]) releaseParticipant(operation, record)
}

function addParticipant(operation, participant) {
  let detach
  const detached = new Promise((resolve) => {
    detach = resolve
  })
  const record = { participant, detach, released: false, settled: false, task: null }
  operation.records.add(record)
  let preparation
  try {
    preparation = participant.prepare(operation.id)
  } catch (error) {
    preparation = Promise.reject(error)
  }
  record.task = Promise.race([Promise.resolve(preparation), detached]).then(() => {
    record.settled = true
  })
  // Registration can happen during an await; the active drain will join this task next.
  record.task.catch(() => {})
  return record
}

function drainOperation(operation) {
  operation.draining = true
  const drain = async () => {
    try {
      while (activeOperation === operation) {
        const pending = [...operation.records].filter((record) => !record.settled)
        if (!pending.length) return { ready: true }
        await Promise.all(pending.map((record) => record.task))
      }
      throw cancelledError()
    } finally {
      operation.draining = false
    }
  }
  operation.promise = Promise.race([
    drain(),
    operation.cancelled.then(() => {
      throw cancelledError()
    })
  ]).catch((error) => {
    if (activeOperation === operation) cancelOperation(operation)
    throw error
  })
  return operation.promise
}

function preparePageLeave(operationId, { recheck = false } = {}) {
  // The final main-process recheck must never revive an attempt cancelled by an unmount.
  if (recheck && activeOperation?.id !== operationId) return Promise.reject(cancelledError())
  if (activeOperation?.id === operationId) {
    const operation = activeOperation
    const pending = [...operation.records].some((record) => !record.settled)
    if (operation.draining || !pending) return operation.promise
    return drainOperation(operation)
  }
  if (activeOperation) cancelOperation(activeOperation)
  let cancel
  const cancelled = new Promise((resolve) => {
    cancel = resolve
  })
  const operation = {
    id: operationId,
    records: new Set(),
    cancel,
    cancelled,
    draining: false,
    promise: null
  }
  activeOperation = operation
  for (const participant of participants) addParticipant(operation, participant)
  return drainOperation(operation)
}

function cancelPageLeave(operationId) {
  if (activeOperation?.id === operationId) cancelOperation(activeOperation)
}

export function registerPageLeaveParticipant(participant) {
  participants.add(participant)
  if (activeOperation) addParticipant(activeOperation, participant)
  return () => {
    if (!participants.delete(participant)) return
    if (!activeOperation) return
    if ([...activeOperation.records].some((record) => record.participant === participant))
      cancelOperation(activeOperation)
  }
}

if (typeof window !== 'undefined') {
  window.__preparePageLeave = preparePageLeave
  window.__cancelPageLeave = cancelPageLeave
}
