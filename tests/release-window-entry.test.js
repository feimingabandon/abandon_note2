import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import windowEntry from '../scripts/run-electron-window-tests.cjs'
import manifest from '../scripts/test-manifest.cjs'
import provenance from '../scripts/test-build-provenance.cjs'
import focused from '../scripts/run-focused-tests.cjs'

const root = resolve(import.meta.dirname, '..')
const directories = []
const previousExitCode = process.exitCode
const buildIds = ['build-native', 'build-capture', 'build-app']

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = previousExitCode
  for (const directory of directories.splice(0)) {
    expect(directory.startsWith(resolve(tmpdir()) + sep)).toBe(true)
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'abandon-release-continuity-'))
  directories.push(directory)
  mkdirSync(join(directory, 'src'))
  writeFileSync(join(directory, 'src/main.js'), 'source before tests')
  writeFileSync(join(directory, 'compiler.exe'), 'fixture compiler')
  const descriptors = new Map()
  const results = buildIds.map((id) => {
    const buildDirectory = join(directory, 'evidence', id)
    const output = 'out-' + id
    mkdirSync(buildDirectory, { recursive: true })
    mkdirSync(join(directory, output))
    writeFileSync(join(directory, output, 'product.bin'), id)
    const snapshotOptions = {
      root: directory,
      id,
      mode: { configuration: 'Release' },
      inputs: ['src'],
      outputs: [output],
      toolchain: { files: [{ name: 'compiler', path: join(directory, 'compiler.exe') }] },
      closure: { complete: id === 'build-app', basis: 'Explicit fixture closure' }
    }
    descriptors.set(id, { snapshotOptions })
    writeFileSync(
      join(buildDirectory, 'build-after.json'),
      JSON.stringify(provenance.createBuildSnapshot(snapshotOptions))
    )
    return { id, directory: buildDirectory, accepted: true, status: 'passed' }
  })
  return {
    directory,
    plan: { root: directory },
    result: {
      directory: join(directory, 'evidence'),
      results,
      summary: { successful: true },
      exitCode: 0
    },
    options: { describeBuild: ({ id }) => descriptors.get(id) }
  }
}

describe('release window build entry', () => {
  it('plans the existing 18 window targets plus diagnostics and builds app, blur and capture once', () => {
    const registry = manifest.createTestRegistry({ root })
    const appRequires = registry.find((item) => item.id === 'build-app').requires.slice()
    const plan = windowEntry.createReleasePlan(['--plan'], { root, entries: registry })
    expect(plan.selected.map((item) => item.file).sort()).toEqual(
      [...manifest.windowFrameTests, 'tests/test-failure-diagnostics-win.cjs'].sort()
    )
    expect(plan.selected).toHaveLength(19)
    expect(windowEntry.groups['window-frame']).toHaveLength(18)
    expect(
      plan.jobs
        .filter((item) => item.role === 'build')
        .map((item) => item.id)
        .sort()
    ).toEqual([...buildIds].sort())
    expect(plan.jobs.find((item) => item.id === 'build-app').requires).toEqual(
      expect.arrayContaining(['build-native', 'build-capture'])
    )
    expect(plan.order.indexOf('build-capture')).toBeLessThan(plan.order.indexOf('build-app'))
    expect(plan.buildMode).toBe('rebuild')
    expect(plan.releaseCaptureInputDriver).toBe(true)
    expect(plan.packageAcceptanceEnvironment.ABANDON_CAPTURE_INPUT_DRIVER).toMatch(
      /focused-builds[\\/]capture-[a-f0-9]{12}[\\/]bin[\\/]capture_input_driver\.exe$/
    )
    expect(registry.find((item) => item.id === 'build-app').requires).toEqual(appRequires)
  })

  it('refuses narrower, wider or reusable release scope before executing', () => {
    for (const argv of [
      ['--file', 'tests/window-frame-electron.mjs'],
      ['--build', 'reuse-verified'],
      ['--all'],
      ['features']
    ])
      expect(() => windowEntry.createReleasePlan(argv)).toThrow('scope is fixed')
  })

  it('prints the release plan without dispatching builds or tests', async () => {
    const executeFocusedPlan = vi.fn()
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const plan = await windowEntry.main(['release-window-frame', '--plan'], {
      focused: { createFocusedPlan: focused.createFocusedPlan, executeFocusedPlan }
    })
    expect(plan.executed).toBe(false)
    expect(plan.releaseBuilds).toEqual(buildIds)
    expect(executeFocusedPlan).not.toHaveBeenCalled()
  })

  it('retains native closure limits while accepting fresh same-run outputs', () => {
    const item = fixture()
    const report = windowEntry.verifyReleaseBuildContinuity(item.plan, item.result, item.options)
    expect(report.successful).toBe(true)
    expect(report.checks.map((check) => check.id)).toEqual(buildIds)
    expect(report.checks.filter((check) => !check.reusableClosure)).toHaveLength(2)
    expect(
      JSON.parse(readFileSync(join(item.result.directory, 'release-build-continuity.json'), 'utf8'))
        .successful
    ).toBe(true)
  })

  it.each(['source edit', 'output edit', 'output addition', 'tool edit', 'output removal'])(
    'blocks packaging continuity after %s',
    (change) => {
      const item = fixture()
      if (change === 'source edit')
        writeFileSync(join(item.directory, 'src/main.js'), 'changed after testing')
      else if (change === 'output edit')
        writeFileSync(join(item.directory, 'out-build-app/product.bin'), 'changed after testing')
      else if (change === 'output addition')
        writeFileSync(join(item.directory, 'out-build-app/extra.bin'), 'unreviewed output')
      else if (change === 'tool edit')
        writeFileSync(join(item.directory, 'compiler.exe'), 'replacement compiler')
      else rmSync(join(item.directory, 'out-build-app/product.bin'))
      const report = windowEntry.verifyReleaseBuildContinuity(item.plan, item.result, item.options)
      expect(report.successful).toBe(false)
      expect(report.checks.find((check) => check.id === 'build-app').verified).toBe(false)
    }
  )

  it('never accepts missing or failed build results as current-run continuity', () => {
    const item = fixture()
    item.result.results[0].accepted = false
    item.result.results.pop()
    const report = windowEntry.verifyReleaseBuildContinuity(item.plan, item.result, item.options)
    expect(report.successful).toBe(false)
    expect(report.checks.filter((check) => !check.verified).map((check) => check.id)).toEqual([
      'build-native',
      'build-app'
    ])
  })

  it('returns a failing exit code when business tests pass but build continuity fails', async () => {
    const item = fixture()
    writeFileSync(join(item.directory, 'out-build-app/product.bin'), 'changed after tests')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const result = await windowEntry.main(['release-window-frame'], {
      ...item.options,
      focused: {
        createFocusedPlan: focused.createFocusedPlan,
        executeFocusedPlan: vi.fn(async () => item.result)
      }
    })
    expect(result.exitCode).toBe(1)
    expect(process.exitCode).toBe(1)
    expect(result.releaseBuildContinuity.successful).toBe(false)
  })
})
