import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { createAssertionRecorder } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/window-motion-diagnostics-native.mjs',
  mode: 'windows-native-motion-collector-no-hwnd',
  metadata: { realWindowMovement: false, isolatedCollector: true }
})
const { assert } = recorder
const root = resolve(import.meta.dirname, '..')
const evidence =
  process.env.ABANDON_TEST_EVIDENCE_DIR ||
  join(root, 'tmp/motion-diagnostics', 'native-collector-' + Date.now())
mkdirSync(evidence, { recursive: true })
let report
let failure
app.whenReady().then(() => {
  try {
    const buildDirectory = join(root, 'native_blur/build')
    const cache = readFileSync(join(buildDirectory, 'CMakeCache.txt'), 'utf8')
    const cmake = /^CMAKE_COMMAND:INTERNAL=(.+)$/m.exec(cache)?.[1]?.trim()
    assert.ok(cmake, 'configured CMake tool missing; run the native build prerequisite')
    const compiled = spawnSync(
      cmake,
      [
        '--build',
        buildDirectory,
        '--config',
        'Release',
        '--target',
        'window_motion_diagnostics_test'
      ],
      { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 120000 }
    )
    writeFileSync(join(evidence, 'native-build.stdout.log'), compiled.stdout || '')
    writeFileSync(join(evidence, 'native-build.stderr.log'), compiled.stderr || '')
    assert.equal(
      compiled.status,
      0,
      'collector test compilation failed: ' + (compiled.error?.message || compiled.stderr)
    )
    const executable = join(buildDirectory, 'Release/window_motion_diagnostics_test.exe')
    const tested = spawnSync(executable, [], {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10000
    })
    writeFileSync(join(evidence, 'native-test.stdout.log'), tested.stdout || '')
    writeFileSync(join(evidence, 'native-test.stderr.log'), tested.stderr || '')
    report = JSON.parse(tested.stdout.trim())
    report.executableSha256 = createHash('sha256').update(readFileSync(executable)).digest('hex')
    report.sourceSha256 = createHash('sha256')
      .update(readFileSync(join(root, 'native_blur/tests/window_motion_diagnostics_test.cpp')))
      .digest('hex')
    writeFileSync(join(evidence, 'native-collector.json'), JSON.stringify(report, null, 2))
    assert.equal(
      tested.status,
      0,
      'collector assertions failed: ' + (tested.error?.message || tested.stderr)
    )
    assert.equal(report.completed, true)
    assert.ok(Number.isSafeInteger(report.assertions.total) && report.assertions.total > 0)
    assert.equal(report.assertions.passed, report.assertions.total)
    assert.equal(report.assertions.failed, 0)
    assert.equal(report.assertions.skipped, 0)
    console.log('Native collector:', JSON.stringify(report.assertions))
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
      cleanup: {
        status: 'complete',
        scope: 'Synchronous compiler/test children exited; no HWND created'
      }
    })
    app.exit(failure ? 1 : 0)
  }
})
