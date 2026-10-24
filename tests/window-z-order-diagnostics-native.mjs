import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/window-z-order-diagnostics-native.mjs',
  mode: 'windows-native-z-order-diagnostics-no-hwnd',
  metadata: { realWindowMovement: false, isolatedController: true, productionFaultInjection: false }
})
const { assert } = recorder
const profile = prepareTestProfile({ prefix: 'abandon-zorder-diagnostic-native-' })
app.setPath('userData', profile.directory)
const root = resolve(import.meta.dirname, '..')
const evidence =
  process.env.ABANDON_TEST_EVIDENCE_DIR ||
  join(root, 'tmp/zorder-diagnostics', 'native-controller-' + Date.now())
mkdirSync(evidence, { recursive: true })
let report
let failure
let childrenExitedNormally = true

function run(stage, command, args, timeout) {
  const child = spawnSync(command, args, {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
    timeout
  })
  writeFileSync(join(evidence, stage + '.stdout.log'), child.stdout || '', { flag: 'wx' })
  writeFileSync(join(evidence, stage + '.stderr.log'), child.stderr || '', { flag: 'wx' })
  writeFileSync(
    join(evidence, stage + '.process.json'),
    JSON.stringify(
      {
        stage,
        command,
        args,
        status: child.status,
        signal: child.signal,
        timeoutMs: timeout,
        error: child.error ? { code: child.error.code, message: child.error.message } : null
      },
      null,
      2
    ),
    { flag: 'wx' }
  )
  if (child.error || child.signal || child.status === null) childrenExitedNormally = false
  assert.equal(
    child.status,
    0,
    stage + ' failed: ' + (child.error?.message || child.stderr || child.stdout)
  )
  assert.equal(child.signal, null, stage + ' must exit without a termination signal')
  assert.equal(child.error, undefined, stage + ' child execution failed')
  return child
}

app.whenReady().then(() => {
  try {
    const buildDirectory = join(root, 'native_blur/build')
    const cache = readFileSync(join(buildDirectory, 'CMakeCache.txt'), 'utf8')
    const cmake = /^CMAKE_COMMAND:INTERNAL=(.+)$/m.exec(cache)?.[1]?.trim()
    assert.ok(cmake, 'configured CMake tool missing; run the native build prerequisite')
    run(
      'native-build',
      cmake,
      [
        '--build',
        buildDirectory,
        '--config',
        'Release',
        '--target',
        'window_z_order_diagnostics_test'
      ],
      120000
    )
    const executable = join(buildDirectory, 'Release/window_z_order_diagnostics_test.exe')
    const tested = run('native-test', executable, [], 10000)
    report = JSON.parse(tested.stdout.trim())
    report.executableSha256 = createHash('sha256').update(readFileSync(executable)).digest('hex')
    report.sources = [
      'native_blur/tests/window_z_order_diagnostics_test.cpp',
      'native_blur/window_z_order.cpp',
      'native_blur/window_z_order.h',
      'native_blur/blur_engine.h',
      'native_blur/CMakeLists.txt'
    ].map((file) => ({
      file,
      sha256: createHash('sha256')
        .update(readFileSync(join(root, file)))
        .digest('hex')
    }))
    writeFileSync(join(evidence, 'native-controller.json'), JSON.stringify(report, null, 2), {
      flag: 'wx'
    })
    assert.equal(report.completed, true)
    assert.ok(Number.isSafeInteger(report.assertions.total) && report.assertions.total > 0)
    assert.equal(report.assertions.passed, report.assertions.total)
    assert.equal(report.assertions.failed, 0)
    assert.equal(report.assertions.skipped, 0)
    console.log('Native controller diagnostics:', JSON.stringify(report.assertions))
  } catch (error) {
    failure = error
    console.error(error)
  } finally {
    recorder.finish({
      completed: !failure,
      error: failure,
      evidence: {
        status: failure ? 'incomplete' : 'complete',
        nativeAssertions: report?.assertions
      },
      profileOwnership: profile.ownership,
      cleanup: {
        status: !childrenExitedNormally
          ? 'failed'
          : profile.ownership === 'runner'
            ? 'complete'
            : 'preserved',
        scope: 'Synchronous compiler/test children; no HWND created or product DLL fault injection'
      }
    })
    app.exit(failure ? 1 : 0)
  }
})
