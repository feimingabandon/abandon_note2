let active = null
let queue = Promise.resolve()

export function acquireShortcutRecorder(owner, cancel, start) {
  const operation = queue.then(async () => {
    if (active && active.owner !== owner) await active.cancel()
    active = { owner, cancel }
    try {
      await start()
    } catch (error) {
      releaseShortcutRecorder(owner)
      throw error
    }
  })
  queue = operation.catch(() => {})
  return operation
}

export function releaseShortcutRecorder(owner) {
  if (active?.owner === owner) active = null
}
