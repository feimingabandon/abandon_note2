import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createPackage } from '@electron/asar'
import { app } from 'electron'

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'abandon-logging-asar-'))
  const archive = join(directory, 'app.asar')
  await createPackage(resolve('out/main'), archive)
  let worker
  try {
    worker = new Worker(join(archive, 'log-writer.js'), {
      workerData: { directory: join(directory, 'logs') }
    })
    await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error('ASAR Worker did not start')), 5000)
      worker.once('error', reject)
      worker.once('message', (message) => {
        clearTimeout(timeout)
        assert.equal(message.ready, true)
        resolveReady()
      })
    })
    worker.postMessage({
      id: 1,
      operation: 'append',
      payload: [
        {
          schemaVersion: 3,
          id: 'asar-event',
          time: new Date().toISOString(),
          message: 'packaged worker'
        }
      ]
    })
    await new Promise((resolveWrite, reject) => {
      const timeout = setTimeout(() => reject(new Error('ASAR Worker write timed out')), 5000)
      worker.once('message', (message) => {
        clearTimeout(timeout)
        assert.equal(message.result.records, 1)
        resolveWrite()
      })
    })
    const files = await readdir(join(directory, 'logs'))
    assert.ok((await readFile(join(directory, 'logs', files[0]), 'utf8')).includes('asar-event'))
    process.stderr.write('[logging-asar] packaged Worker and shared chunk load/write passed\n')
    await worker.terminate()
    app.exit(0)
  } catch (error) {
    process.stderr.write(`${error.stack}\n`)
    await worker?.terminate()
    app.exit(1)
  }
}
void app
  .whenReady()
  .then(run)
  .catch((error) => {
    process.stderr.write(`${error.stack}\n`)
    app.exit(1)
  })
