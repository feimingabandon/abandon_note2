import { parentPort, workerData } from 'node:worker_threads'
import { createLogStore } from './log-store.mjs'
import { maintainCrashDumps } from './crash-dump-store.mjs'

const store = createLogStore(workerData.directory, workerData.options)
let writes = Promise.resolve()
let crashDumps = { files: [], status: 'not-collected' }
async function maintain() {
  await store.maintain()
  try {
    crashDumps = await maintainCrashDumps(workerData.options?.crashDirectory)
  } catch (error) {
    crashDumps = { files: [], unavailable: true, error: errorValue(error) }
  }
}
const errorValue = (error) => ({
  message: String(error?.message || error).slice(0, 500),
  code: error?.code
})
parentPort.on('message', ({ id, operation, payload }) => {
  const barrier = writes
  let work
  if (operation === 'append') {
    work = writes.then(() => store.append(payload))
    writes = work.catch(() => {})
  } else {
    work = barrier.then(async () => {
      if (operation === 'flush') return store.stats()
      if (operation === 'files') return store.files()
      if (operation === 'crash-index') {
        await maintain()
        return crashDumps
      }
      if (operation === 'query') return store.query(payload)
      if (operation === 'freeze-export') return store.freezeExport()
      if (operation === 'release-snapshot') return store.releaseSnapshot(payload)
      if (operation === 'export') return store.exportTo(...payload)
      if (operation === 'maintain') return maintain()
      if (operation === 'close') {
        store.close()
        return true
      }
      throw new Error('Unknown logging operation')
    })
  }
  work.then(
    (result) => parentPort.postMessage({ id, result }),
    (error) => parentPort.postMessage({ id, error: errorValue(error) })
  )
})
const maintenanceTimer = setInterval(() => {
  writes = writes.then(maintain).catch(() => {})
}, 1800000)
maintenanceTimer.unref()
maintain().then(
  () => parentPort.postMessage({ ready: true }),
  (error) => parentPort.postMessage({ ready: true, error: errorValue(error) })
)
