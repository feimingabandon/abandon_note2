import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { CaptureHost } from '../src/main/capture/CaptureHost.js'
import { coverCaptureTestDesktop } from './helpers/capture-test-desktop.mjs'

const root = await fs.mkdtemp(join(tmpdir(), 'abandon-capture-e2e-'))
app.setPath('userData', join(root, 'profile'))
const host = new CaptureHost({ directory: resolve('native_capture/deploy'), root })
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))
async function until(predicate, label, timeout = 12000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await wait(25)
  }
  throw new Error(label)
}
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const messages = [],
  failures = []
let exitCode = 0,
  owner = null
host.on('message', (m) => messages.push(m))
host.on('failure', (error) => failures.push(error.message))
async function run() {
  let uncover
  try {
    uncover = await coverCaptureTestDesktop()
    await Promise.all([host.start(), host.start(), host.start()])
    const firstPid = host.pid
    assert.equal(host.ready, true)
    assert.equal(alive(firstPid), true)
    const sessionId = '11111111-1111-1111-1111-111111111111'
    await fs.mkdir(join(root, sessionId))
    host.send({ type: 'capture', origin: 'global', sessionId })
    await until(
      () => messages.some((m) => m.type === 'captureReady'),
      'Real desktop overlay never became ready'
    )
    host.send({ type: 'capture', origin: 'global', sessionId })
    host.send({ type: 'cancel', sessionId })
    await until(
      () => messages.some((m) => m.type === 'finished' && m.sessionId === sessionId),
      'Capture did not cancel'
    )
    assert.equal(messages.filter((m) => m.type === 'finished').length, 1)
    // Simulate helper crash only for the exact PID launched by this test-owned Job.
    process.kill(firstPid)
    await until(() => failures.length === 1, 'Engine exit was not observed')
    assert.equal(host.ready, false)
    await host.start()
    assert.notEqual(host.pid, firstPid)
    assert.equal(host.ready, true)
    const secondPid = host.pid
    // Loss of the host channel must terminate the engine and all its windows.
    host.socket.destroy()
    await until(() => !alive(secondPid), 'Engine survived IPC loss')
    owner = spawn(process.execPath, ['tests/helpers/capture-owner.cjs', root], {
      cwd: resolve('.'),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let ownerOutput = ''
    owner.stdout.on('data', (chunk) => {
      ownerOutput += chunk
    })
    owner.stderr.on('data', (chunk) => process.stderr.write(chunk))
    await until(() => ownerOutput.includes('\n'), 'Owner fixture did not launch')
    const ownedPid = JSON.parse(ownerOutput.trim()).enginePid
    assert.equal(alive(ownedPid), true)
    // Kill only the fixture created above: tests atomic Job membership on abrupt parent death.
    owner.kill()
    await until(() => !alive(ownedPid), 'Native engine survived abrupt parent termination')
    await host.start()
    const finalPid = host.pid
    await host.dispose()
    await until(() => !alive(finalPid), 'Owned engine survived application shutdown')
    console.log(
      JSON.stringify({
        status: 'passed',
        assertions: [
          'prewarm single process',
          'real desktop capture',
          'cancel exactly once',
          'crash recovery',
          'IPC disconnect exit',
          'atomic Job parent death',
          'graceful shutdown'
        ],
        pid: finalPid
      })
    )
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    owner?.kill()
    await host.dispose()
    uncover?.()
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }
  app.exit(exitCode)
}
app
  .whenReady()
  .then(run)
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
