import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const buildScript = join(root, 'native_capture', 'build.ps1')
const powershell = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

function rejectedArguments(args, reason) {
  const result = spawnSync(
    powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', buildScript, ...args],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000
    }
  )
  expect(result.error).toBeUndefined()
  expect(result.status).not.toBe(0)
  expect(result.stdout + result.stderr).toContain(reason)
}

describe('Capture build selection contract', () => {
  it('keeps testing and the real input driver opt-in while preserving product dependencies', () => {
    const cmake = readFileSync(join(root, 'native_capture', 'CMakeLists.txt'), 'utf8')
    expect(cmake).toMatch(/option\(ABANDON_CAPTURE_BUILD_TESTS\s+"[^"]+"\s+OFF\)/)
    expect(cmake).toMatch(/option\(ABANDON_CAPTURE_BUILD_INPUT_DRIVER\s+"[^"]+"\s+OFF\)/)
    expect(cmake).toContain('find_package(Qt6 6.8.3 EXACT REQUIRED COMPONENTS Widgets Network)')
    expect(cmake).toMatch(
      /if\(ABANDON_CAPTURE_BUILD_TESTS\)\s+find_package\(Qt6 6\.8\.3 EXACT REQUIRED COMPONENTS Test\)\s+endif\(\)/
    )
  })
})

describe.runIf(process.platform === 'win32')(
  'Capture command rejects widening before toolchain discovery',
  () => {
    it.each([
      [['-Test'], '-Test requires explicit -TestName'],
      [['-TestsOnly'], '-TestsOnly requires -Test'],
      [['-TestName', 'capture_core'], '-TestName requires -Test'],
      [['-Test', '-TestName', 'capture_core'], 'Test execution requires -ResultDirectory'],
      [['-Test', '-TestName', 'capture_missing', '-BuildOnly'], 'Unknown Capture test name'],
      [
        ['-Test', '-TestName', 'capture_core,capture_core', '-BuildOnly'],
        'Duplicate Capture test names are not allowed'
      ],
      [
        ['-BuildDirectory', resolve(root, '..', 'outside-capture-build')],
        'must remain inside the repository'
      ]
    ])('rejects %j', (args, reason) => {
      rejectedArguments(args, reason)
    })

    it('refuses an existing attempt report instead of treating old evidence as current', () => {
      const tempParent = join(root, 'tmp')
      mkdirSync(tempParent, { recursive: true })
      const attempt = mkdtempSync(join(tempParent, 'capture-selection-contract-'))
      try {
        writeFileSync(join(attempt, 'capture_core.junit.xml'), '<testsuite tests="1"/>')
        rejectedArguments(
          ['-Test', '-TestName', 'capture_core', '-TestsOnly', '-ResultDirectory', attempt],
          'Current attempt requires new result files'
        )
      } finally {
        rmSync(attempt, { recursive: true, force: true })
      }
    })
  }
)
