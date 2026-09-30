// Background-only lifecycle integration: no BrowserWindow, capture, clipboard,
// global shortcuts, SendInput or desktop-cover fixture.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { app } from 'electron'
import { CaptureHost } from '../src/main/capture/CaptureHost.js'

const directory = resolve(process.env.ABANDON_CAPTURE_TEST_DIRECTORY || 'native_capture/deploy')
const root = await fs.mkdtemp(join(tmpdir(), 'abandon-capture-host-'))
app.setPath('userData', join(root, 'profile'))
const host = new CaptureHost({ directory, root })
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(check, label) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if (check()) return
    await wait(25)
  }
  throw new Error(label)
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const failures = []
host.on('failure', (error) => failures.push(error.message))
let owner,
  exitCode = 0
async function run() {
  try {
    await Promise.all([host.start(), host.start()])
    const pid = host.pid
    assert.equal(host.ready, true)
    host.send({ type: 'theme', theme: { background: '#111820', foreground: '#eff5ff' } })
    await wait(100)
    assert.equal(alive(pid), true)
    assert.equal(failures.length, 0)
    host.socket.destroy()
    await until(() => !alive(pid), 'Helper survived disconnected host')
    await host.start()
    assert.notEqual(host.pid, pid)
    const nextPid = host.pid
    await host.dispose()
    await until(() => !alive(nextPid), 'Helper survived explicit shutdown')

    owner = spawn(process.execPath, ['tests/helpers/capture-owner.cjs', root, directory], {
      cwd: resolve('.'),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = '',
      spawnError = null
    owner.on('error', (error) => {
      spawnError = error
    })
    owner.stdout.on('data', (chunk) => {
      output += chunk
    })
    owner.stderr.on('data', (chunk) => process.stderr.write(chunk))
    await until(
      () => Boolean(spawnError) || output.includes('\n'),
      'Test owner did not report its helper'
    )
    if (spawnError) throw spawnError
    const ownedPid = JSON.parse(output.trim()).enginePid
    assert.equal(alive(ownedPid), true)
    owner.kill() // Only the fixture created above; its Job must reap its own helper.
    await until(() => !alive(ownedPid), 'Helper survived abrupt fixture-owner exit')
    console.log(
      JSON.stringify({
        status: 'passed',
        assertions: [
          'single prewarmed helper',
          'theme command survives',
          'IPC loss exit',
          'restart',
          'explicit shutdown',
          'atomic Job owner death'
        ]
      })
    )
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    owner?.kill()
    await host.dispose()
    const cleanupRoot = await fs.realpath(root)
    const tempRoot = await fs.realpath(tmpdir())
    assert.equal(dirname(cleanupRoot), tempRoot)
    assert.ok(basename(cleanupRoot).startsWith('abandon-capture-host-'))
    await fs.rm(cleanupRoot, { recursive: true, force: true }).catch(() => {})
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
