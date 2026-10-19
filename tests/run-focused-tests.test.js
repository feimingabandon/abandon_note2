import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import focused from '../scripts/run-focused-tests.cjs'
import runner from '../scripts/test-runner.cjs'

const roots = []
const root = resolve(import.meta.dirname, '..')
const privateRoot = () => {
  // Parent runners replace TEMP with their nested attempt directory. Keep this inner runner's
  // owned fixture short enough for Windows mkdtemp instead of nesting another full run in TEMP.
  mkdirSync(join(root, 'tmp'), { recursive: true })
  const dir = mkdtempSync(join(root, 'tmp/focused-unit-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const evidenceNames = (directory) => (existsSync(directory) ? readdirSync(directory).sort() : [])
const assertNoOwnEvidence = (directory, before) => expect(evidenceNames(directory)).toEqual(before)
const cli = (args, directory = privateRoot()) =>
  spawnSync(process.execPath, ['scripts/run-focused-tests.cjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: focused.normalizedEnvironment({ ...process.env, ABANDON_TEST_EVIDENCE_ROOT: directory }),
    windowsHide: true
  })

describe('focused planning and dispatch', () => {
  it('keeps Qt targets on capture when app and blur builds share the selected scope', () => {
    const plan = focused.createFocusedPlan([
      '--file',
      'native_capture/tests/core_test.cpp',
      '--file',
      'tests/window-border-electron.mjs',
      '--file',
      'tests/window-motion-diagnostics-native.mjs'
    ])
    const builds = focused.createFocusedJobs(plan).filter((entry) => entry.resultKind === 'build')
    expect(builds.map((entry) => entry.id).sort()).toEqual([
      'build-app',
      'build-capture',
      'build-native'
    ])
    for (const build of builds) {
      expect(build.metadata.qtNames).toEqual(build.id === 'build-capture' ? ['capture_core'] : [])
    }
  })
  it('dispatches the isolated renderer fixture with its own verified result mode', async () => {
    const file = 'tests/renderer-resource-lifetime-electron.mjs'
    const plan = focused.createFocusedPlan(['--file', file, '--plan'])
    expect(plan.order).toEqual([file])
    expect(plan.dependencies).toEqual([])
    expect(plan.selected[0].executionBlock).toBeNull()
    const [job] = focused.createFocusedJobs(plan)
    expect(job.args).toEqual([file])
    expect(job.gui).toBe(true)
    expect(job.resultPolicy).toBe('required')
    const directory = privateRoot()
    const prepared = await job.prepare({ directory })
    const context = { directory, startedMs: Date.now() - 100 }
    writeFileSync(
      join(directory, 'standalone.json'),
      JSON.stringify({
        version: 1,
        suite: file,
        runToken: prepared.env.ABANDON_TEST_RUN_TOKEN,
        mode: 'electron-component-fixture',
        completed: true,
        assertions: { total: 1, passed: 1, failed: 0, skipped: 0 },
        cleanup: { status: 'complete' },
        evidence: { status: 'complete' },
        profileOwnership: 'runner'
      })
    )
    expect(job.assessResult(context)).toMatchObject({
      status: 'passed',
      mode: 'electron-component-fixture',
      target: file,
      assertions: { passed: 1 }
    })
  })
  it('selects only the isolated native motion collector and its native build prerequisite', () => {
    const file = 'tests/window-motion-diagnostics-native.mjs'
    const plan = focused.createFocusedPlan(['--file', file, '--plan'])
    expect(plan.selected.map((entry) => entry.file)).toEqual([file])
    expect(plan.selected[0]).toMatchObject({ level: 'native', runtime: 'electron' })
    expect(plan.order).toEqual(['build-native', file])
    expect(plan.runtimePrerequisites).toContain('windows-msvc-toolchain')
    expect(plan.runtimePrerequisites).not.toContain('capture-qt-deployment')
    const job = focused.createFocusedJobs(plan).find((entry) => entry.id === file)
    expect(job.args).toEqual([file])
    expect(job.resultPolicy).toBe('required')
    expect(job.blockedReason).toBeUndefined()
  })
  it('retains exact selected targets and complete dependencies in the read-only plan', () => {
    const plan = focused.createFocusedPlan([
      '--file',
      'tests/note-list-toolbar-electron.mjs',
      '--plan'
    ])
    expect(plan.selected.map((entry) => entry.file)).toEqual([
      'tests/note-list-toolbar-electron.mjs'
    ])
    expect(plan.order).toEqual(['build-app', 'tests/note-list-toolbar-electron.mjs'])
    expect(plan.dependencies[0].executionBlock).toBeNull()
    expect(plan.runtimePrerequisites).toContain('capture-qt-deployment')
    expect(plan.executed).toBe(false)
  })
  it('refuses unknown or empty scope before creating evidence', () => {
    for (const args of [
      [],
      ['--file', 'tests/missing.test.js'],
      ['--all'],
      ['--feature', 'unknown']
    ]) {
      const directory = privateRoot()
      const before = evidenceNames(directory)
      const result = cli(args, directory)
      expect(result.status).toBe(2)
      expect(JSON.parse(result.stderr).executed).toBe(false)
      assertNoOwnEvidence(directory, before)
    }
  })
  it('lets source-only plans show candidates without adding execution targets', () => {
    const plan = focused.createFocusedPlan([
      '--source',
      'src/renderer/src/components/list/SearchBox.vue',
      '--plan'
    ])
    expect(plan.candidates.length).toBeGreaterThan(0)
    expect(plan.order).toEqual([])
    expect(plan.selected).toEqual([])
    expect(() =>
      focused.createFocusedPlan(['--source', 'src/renderer/src/components/list/SearchBox.vue'])
    ).toThrow()
  })
  it('creates no run directory or report when invoked with --plan', () => {
    const directory = privateRoot()
    const before = evidenceNames(directory)
    const result = cli(['--file', 'tests/test-result-adapters.test.js', '--plan'], directory)
    expect(result.status).toBe(0)
    const plan = JSON.parse(result.stdout)
    expect(plan.executed).toBe(false)
    expect(plan.order).toEqual(['tests/test-result-adapters.test.js'])
    assertNoOwnEvidence(directory, before)
  })
  it('does not attribute another owned run to the plan namespace', async () => {
    const directory = privateRoot()
    const otherNamespace = privateRoot()
    const before = evidenceNames(directory)
    const result = cli(['--file', 'tests/test-result-adapters.test.js', '--plan'], directory)
    const otherDirectory = runner.createRunDirectory(otherNamespace)
    const other = await runner.runJob(
      {
        id: 'other-check',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        resultKind: 'check'
      },
      { directory: otherDirectory }
    )
    expect(result.status).toBe(0)
    expect(other.accepted).toBe(true)
    expect(evidenceNames(otherNamespace)).toHaveLength(1)
    assertNoOwnEvidence(directory, before)
  })
  it('still detects a broken plan fixture that writes evidence in its own namespace', () => {
    const directory = privateRoot()
    const before = evidenceNames(directory)
    const accidentalRun = runner.createRunDirectory(directory)
    writeFileSync(join(accidentalRun, 'result.json'), '{"executed":true}')
    expect(() => assertNoOwnEvidence(directory, before)).toThrow()
  })
  it('does not clear build dependencies when reuse is requested', () => {
    const plan = focused.createFocusedPlan([
      '--file',
      'tests/capture-host-electron.mjs',
      '--build',
      'reuse-verified',
      '--plan'
    ])
    expect(plan.order).toEqual(['build-capture', 'tests/capture-host-electron.mjs'])
    const jobs = focused.createFocusedJobs(plan)
    expect(jobs[0].blockedReason).toContain('lack a verified adapter')
    expect(jobs[1].requires).toEqual(['build-capture'])
    expect(plan.warnings.join(' ')).toContain('provenance')
  })
  it('keeps Electron ready storage and its proof env distinct from Electron-as-Node', async () => {
    const plan = focused.createFocusedPlan(['--file', 'tests/attachment-storage-electron.mjs'])
    const job = focused.createFocusedJobs(plan)[0]
    expect(job.gui).toBe(true)
    expect(job.electronNode).not.toBe(true)
    expect(job.args).toEqual(['tests/attachment-storage-electron.mjs'])
    expect(job.resultPolicy).toBe('required')
    const directory = privateRoot()
    const prepared = await job.prepare({ directory })
    expect(prepared.env.ABANDON_TEST_RESULT_FILE).toBe(join(directory, 'standalone.json'))
    expect(prepared.env.ABANDON_TEST_EVIDENCE_DIR).toBe(directory)
    expect(prepared.env.ABANDON_TEST_RUN_TOKEN).toBeTruthy()
  })
  it('normalizes child PATH without changing the caller environment', () => {
    const separator = process.platform === 'win32' ? ';' : ':'
    const env = { Path: ['C:/Program Files/Volta', 'C:/normal'].join(separator), TOKEN: 'private' }
    const copy = { ...env }
    const result = focused.normalizedEnvironment(env, process.execPath)
    expect(result.PATH.toLowerCase()).not.toContain('volta')
    expect(result.Path).toBeUndefined()
    expect(result.TOKEN).toBe('private')
    expect(env).toEqual(copy)
  })
  it('runs packaged acceptance through Node and requires an explicit candidate before launch', () => {
    const plan = focused.createFocusedPlan(['--file', 'tests/capture-package-smoke.cjs'])
    const job = focused
      .createFocusedJobs(plan, { env: {} })
      .find((entry) => entry.id === 'tests/capture-package-smoke.cjs')
    expect(job.command).toBe(process.execPath)
    expect(job.gui).toBe(true)
    expect(job.args).toEqual(['tests/capture-package-smoke.cjs'])
    const directory = privateRoot()
    expect(() => job.prepare({ directory })).toThrow('explicit absolute')
    expect(evidenceNames(directory)).toEqual([])
  })
  it('refuses to execute a read-only plan before creating evidence', async () => {
    const directory = privateRoot()
    const plan = focused.createFocusedPlan(['--file', 'tests/security-hardening.test.js', '--plan'])
    await expect(focused.executeFocusedPlan(plan, { evidenceRoot: directory })).rejects.toThrow(
      'Read-only'
    )
    expect(readdirSync(directory)).toEqual([])
  })
  it('executes one explicit Vitest file with a fresh target report and truthful summary', async () => {
    const directory = privateRoot()
    const plan = focused.createFocusedPlan(['--file', 'tests/security-hardening.test.js'])
    const result = await focused.executeFocusedPlan(plan, {
      env: { ...process.env, ABANDON_TEST_EVIDENCE_ROOT: directory }
    })
    expect(result.exitCode, JSON.stringify(result.results, null, 2)).toBe(0)
    expect(result.summary).toMatchObject({ total: 1, verifiedPassed: 1, successful: true })
    expect(result.results).toHaveLength(1)
    expect(result.results[0].businessResult).toMatchObject({
      status: 'passed',
      target: 'tests/security-hardening.test.js'
    })
    expect(result.results[0].businessResult.assertions.passed).toBeGreaterThan(0)
    const baseline = JSON.parse(readFileSync(join(result.directory, 'baseline.json'), 'utf8'))
    expect(baseline.scope).toBe('explicit-focused')
    expect(baseline.selection.selected.map((entry) => entry.file)).toEqual([
      'tests/security-hardening.test.js'
    ])
    expect(existsSync(join(result.results[0].directory, 'vitest.json'))).toBe(true)
  }, 20000)
  it('records blocked dependencies and continues an independent selected unit target', async () => {
    const directory = privateRoot()
    const unusedEnvironmentRoot = privateRoot()
    const plan = focused.createFocusedPlan([
      '--file',
      'tests/note-list-toolbar-electron.mjs',
      '--file',
      'tests/security-hardening.test.js'
    ])
    const result = await focused.executeFocusedPlan(plan, {
      evidenceRoot: directory,
      env: { ...process.env, ABANDON_TEST_EVIDENCE_ROOT: unusedEnvironmentRoot }
    })
    expect(evidenceNames(unusedEnvironmentRoot)).toEqual([])
    expect(result.exitCode).toBe(1)
    expect(result.summary, JSON.stringify(result.results, null, 2)).toMatchObject({
      total: 3,
      verifiedPassed: 1,
      blocked: 2,
      successful: false
    })
    const target = result.results.find(
      (entry) => entry.id === 'tests/note-list-toolbar-electron.mjs'
    )
    expect(target.status).toBe('blocked')
    expect(target.businessResult.status).toBe('not-run')
    expect(target.processResult.status).toBe('not-run')
    expect(readFileSync(join(target.directory, 'stdout.log'), 'utf8')).toBe('')
  }, 20000)
})
