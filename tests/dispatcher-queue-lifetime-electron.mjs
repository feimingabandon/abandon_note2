import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { app } from 'electron'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/dispatcher-queue-lifetime-electron.mjs',
  mode: 'windows-native-dispatcher-queue-lifetime',
  metadata: {
    scope: 'Owned current-thread queues and real product DLL Init/Destroy cycles',
    limitations: ['single-machine', 'no production async ABI', 'no customer leak attribution']
  }
})
const { assert } = recorder
const profile = prepareTestProfile({ prefix: 'abandon-dispatcher-queue-' })
app.setPath('userData', profile.directory)
const evidence = process.env.ABANDON_TEST_EVIDENCE_DIR || profile.directory
const root = resolve(import.meta.dirname, '..')
const children = []

// The focused runner owns the deadline and external failure capture. An
// unresolved child stays unresolved; this wrapper never kills it to pass.
function runOwned(label, executable, args, env = process.env) {
  const directory = join(evidence, label)
  mkdirSync(directory, { recursive: false })
  const stdout = openSync(join(directory, 'stdout.log'), 'wx')
  const stderr = openSync(join(directory, 'stderr.log'), 'wx')
  const state = { executable, args, closed: false, code: null, signal: null, error: null }
  children.push(state)
  return new Promise((done, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ['ignore', stdout, stderr]
    })
    state.pid = child.pid
    writeFileSync(join(directory, 'command.json'), JSON.stringify(state, null, 2), { flag: 'wx' })
    child.once('error', (error) => {
      state.error = error.message
    })
    child.once('close', (code, signal) => {
      Object.assign(state, { closed: true, code, signal })
      closeSync(stdout)
      closeSync(stderr)
      writeFileSync(join(directory, 'exit.json'), JSON.stringify(state, null, 2), { flag: 'wx' })
      if (state.error) reject(new Error(state.error))
      else done({ ...state, directory })
    })
  })
}

async function run() {
  let failure
  let report
  let nativeStarted = false
  try {
    const buildDirectory = join(root, 'native_blur/build')
    const cache = readFileSync(join(buildDirectory, 'CMakeCache.txt'), 'utf8')
    const cmake = /^CMAKE_COMMAND:INTERNAL=(.+)$/m.exec(cache)?.[1]?.trim()
    assert.ok(cmake, 'Configured CMake is required from the fresh native build')
    const compiled = await runOwned('native-build', cmake, [
      '--build',
      buildDirectory,
      '--config',
      'Release',
      '--target',
      'dispatcher_queue_lifetime_test'
    ])
    assert.equal(
      compiled.code,
      0,
      'Native lifetime target compilation failed; see native-build logs'
    )
    assert.equal(compiled.signal, null)
    const executable = join(buildDirectory, 'Release/dispatcher_queue_lifetime_test.exe')
    nativeStarted = true
    const tested = await runOwned('native-test', executable, [], {
      ...process.env,
      PATH: join(buildDirectory, 'bin') + delimiter + process.env.PATH
    })
    const nativeReport = readFileSync(join(tested.directory, 'stdout.log'), 'utf8').trim()
    if (!nativeReport)
      throw new Error(
        `Native lifetime exited ${tested.code} without a report; see native-test logs and crash evidence`
      )
    report = JSON.parse(nativeReport)
    writeFileSync(
      join(evidence, 'native-lifetime.json'),
      JSON.stringify(
        {
          ...report,
          executableSha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
          dllSha256: createHash('sha256')
            .update(readFileSync(join(buildDirectory, 'bin/blur_engine.dll')))
            .digest('hex')
        },
        null,
        2
      ),
      { flag: 'wx' }
    )
    assert.equal(tested.code, 0, 'Native lifetime assertions failed; see native-test logs')
    assert.equal(tested.signal, null)
    assert.equal(report.completed, true)
    assert.equal(report.cleanupComplete, true)
    assert.ok(Number.isSafeInteger(report.assertions?.total) && report.assertions.total > 0)
    assert.equal(report.assertions.passed, report.assertions.total)
    assert.equal(report.assertions.failed, 0)
    assert.equal(report.assertions.skipped, 0)
    for (const phase of [
      'initial',
      'afterInvalidInit',
      'afterRejectedGeometry',
      'afterUncreatedDestroy'
    ]) {
      const shutdown = report.shutdownSnapshots[phase].shutdown
      assert.equal(shutdown.generation, 0)
      assert.equal(shutdown.status, 'not-created')
      assert.equal(shutdown.threadExitConfirmed, false, 'No created thread means no claimed join')
      assert.equal(shutdown.waitResult, null)
      assert.equal(shutdown.abandoned, false)
    }
    const failureOnly = (diagnostic) =>
      Object.fromEntries(Object.entries(diagnostic).filter(([key]) => key !== 'shutdown'))
    const rejectedGeometry = failureOnly(report.shutdownSnapshots.afterRejectedGeometry)
    assert.ok(
      Object.keys(rejectedGeometry).length > 0,
      'Safe not-ready rejection must retain its cause'
    )
    assert.deepEqual(
      failureOnly(report.shutdownSnapshots.afterUncreatedDestroy),
      rejectedGeometry,
      'Shutdown observation must preserve all original native failure fields'
    )
    assert.equal(report.cycles.length, 4)
    let previousGeneration = 0
    for (const cycle of report.cycles) {
      const created = cycle.shutdownSnapshots.afterInit.shutdown
      const destroyed = cycle.shutdownSnapshots.afterDestroy.shutdown
      const repeated = cycle.shutdownSnapshots.afterRepeatedDestroy.shutdown
      assert.equal(created.generation, previousGeneration + 1)
      assert.equal(created.status, 'not-requested')
      assert.equal(created.threadExitConfirmed, false)
      assert.equal(created.waitResult, null)
      assert.equal(destroyed.generation, created.generation)
      assert.equal(destroyed.status, 'completed')
      assert.equal(destroyed.threadExitConfirmed, true)
      assert.equal(destroyed.waitResult, 0, 'Completion must come from WAIT_OBJECT_0 and join')
      assert.equal(destroyed.nativeCode, 0)
      assert.equal(destroyed.abandoned, false)
      assert.equal(destroyed.modulePinned, false, 'Normal joined shutdown needs no abandon pin')
      assert.equal(destroyed.pinNativeCode, 0)
      assert.deepEqual(repeated, destroyed, 'Repeated Destroy must preserve the same generation')
      assert.equal(
        cycle.staExited,
        true,
        'The separately retained real STA HANDLE must be signaled'
      )
      assert.equal(cycle.overlayReleased, true)
      previousGeneration = created.generation
    }
  } catch (error) {
    failure = error
    console.error(error)
  } finally {
    const closed = children.every((child) => child.closed && !child.error && !child.signal)
    recorder.finish({
      completed: !failure,
      error: failure,
      profileOwnership: profile.ownership,
      evidence: {
        status: closed ? 'complete' : 'incomplete',
        nativeAssertions: report?.assertions
      },
      cleanup: {
        status:
          closed && (!nativeStarted || report?.cleanupComplete === true) ? 'complete' : 'failed',
        scope:
          'Owned compiler/test children closed; native report separately proves owned HWND/thread cleanup'
      }
    })
    // This wrapper owns no product windows or DLL; all native children have
    // closed. Electron's app.quit() ignores Node's process.exitCode on failure.
    app.exit(failure ? 1 : 0)
  }
}
void app.whenReady().then(run)
