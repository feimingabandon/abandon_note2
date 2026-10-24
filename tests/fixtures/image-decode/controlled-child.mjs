import { app, nativeImage } from 'electron'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

// Test-owned Electron entry only. Product entry has no mode, marker or release hook.
const profile = process.env.ABANDON_IMAGE_DECODER_PROFILE
if (!profile || typeof process.send !== 'function') app.exit(1)
else {
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
  app.disableHardwareAcceleration()
  let closing = false
  process.once('disconnect', () => {
    if (!closing) app.exit(1)
  })
  let admitted = false
  process.on('message', async (request) => {
    if (admitted) return
    admitted = true
    const record = (phase, details = {}) =>
      appendFileSync(
        request.marker,
        JSON.stringify({
          phase,
          pid: process.pid,
          profile: app.getPath('userData'),
          at: Date.now(),
          ...details
        }) + '\n'
      )
    const send = (message) =>
      new Promise((resolve, reject) => {
        process.send(message, (error) => (error ? reject(error) : resolve()))
      })
    try {
      record('received')
      if (request.mode === 'fault') {
        record('fault-exit')
        console.error('E831_CONTROLLED_CHILD_FAULT_EXIT_7')
        app.exit(7)
        return
      }
      if (request.mode === 'busy') {
        record('busy-ready')
        const until = Date.now() + 60_000
        while (Date.now() < until) {
          // Deliberately blocks this owned child's main thread, never the suite main.
        }
        throw new Error('Controlled busy child was not cancelled')
      }
      if (request.mode === 'wait-release') {
        record('waiting-release')
        await new Promise((resolve) => {
          const timer = setInterval(() => {
            if (existsSync(request.release)) {
              clearInterval(timer)
              resolve()
            }
          }, 10)
        })
      }
      if (request.mode === 'detached-descendant') {
        const readyFile = request.marker + '.descendant-ready.json'
        const env = { ...process.env }
        for (const key of Object.keys(env))
          if (['electron_run_as_node', 'node_options', 'node_path'].includes(key.toLowerCase()))
            delete env[key]
        env.ELECTRON_RUN_AS_NODE = '1'
        // Detached survives the decoder's normal exit but still belongs to its Job.
        // Windows transport may keep the gate pending until Job cancellation.
        const script = [
          "const fs = require('node:fs')",
          "fs.writeFileSync(process.argv[1] + '.pending', JSON.stringify({",
          'pid: process.pid, parentPid: process.ppid, mode: process.env.ELECTRON_RUN_AS_NODE,',
          'processType: typeof process.type, electronVersion: process.versions.electron,',
          'nodeOptions: process.env.NODE_OPTIONS || null, nodePath: process.env.NODE_PATH || null',
          "}), { flag: 'wx' })",
          "fs.renameSync(process.argv[1] + '.pending', process.argv[1])",
          'setInterval(() => {}, 1000)',
          // An unattended failed run has a bounded leftover; expiry can never pass the test.
          'setTimeout(() => process.exit(91), 60000)'
        ].join('\n')
        const descendant = spawn(process.execPath, ['-e', script, readyFile], {
          env,
          windowsHide: true,
          detached: true,
          stdio: 'ignore'
        })
        await new Promise((resolve, reject) => {
          descendant.once('spawn', resolve)
          descendant.once('error', reject)
        })
        descendant.unref()
        const deadline = Date.now() + 3000
        while (!existsSync(readyFile)) {
          if (Date.now() >= deadline) throw new Error('Controlled descendant readiness timed out')
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        const ready = JSON.parse(readFileSync(readyFile, 'utf8'))
        if (ready.pid !== descendant.pid || ready.parentPid !== process.pid)
          throw new Error('Controlled descendant readiness ownership mismatch')
        record('descendant-ready', { descendant: ready, readyFile })
      }
      const image = nativeImage.createFromBitmap(Buffer.alloc(16 * 8 * 4, 255), {
        width: 16,
        height: 8
      })
      await send({
        id: request.id,
        type: 'result',
        ok: true,
        value: {
          token: request.token,
          width: 16,
          height: 8,
          profile,
          pid: process.pid,
          data: image.toDataURL(),
          version: 'controlled-fixture',
          bytes: image.toPNG().length
        }
      })
      record('result-sent')
      if (request.mode === 'hold-result') {
        setInterval(() => {}, 1000)
        return
      }
      closing = true
      app.quit()
    } catch (error) {
      console.error(error.stack || error)
      await send({
        id: request.id,
        type: 'result',
        ok: false,
        error: { code: 'FIXTURE_FAILED', message: error.message }
      }).catch(() => {})
      app.exit(1)
    }
  })
  void app.whenReady().then(() => process.send({ type: 'ready' }))
}
