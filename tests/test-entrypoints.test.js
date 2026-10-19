import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import entry from '../scripts/run-test-entry.cjs'
import selection from '../scripts/test-selection.cjs'
import manifest from '../scripts/test-manifest.cjs'

const root = resolve(import.meta.dirname, '..')
const previousExitCode = process.exitCode
const target = (file, level = 'unit', runtime = 'vitest') => ({
  id: file,
  file,
  role: 'test',
  level,
  runtime,
  selectionPolicy: 'focused',
  features: [],
  contracts: [],
  sourceDependencies: [],
  sourceReadDependencies: [],
  requires: [],
  runtimePrerequisites: [],
  limits: []
})
const registry = [
  target('tests/example.test.js'),
  target('tests/database.mjs', 'database', 'electron-node'),
  target('tests/gui.mjs', 'gui', 'electron'),
  target('tests/native.cpp', 'native', 'qt')
]
const focusedFixture = () => ({
  createFocusedPlan: vi.fn((argv, { entries, root: directory }) => {
    const result = selection.selectTests(entries, selection.parseSelectionArgs(argv), {
      root: directory
    })
    return { ...result, root: directory, mode: 'focused-plan', executed: false }
  }),
  executeFocusedPlan: vi.fn(async () => ({
    directory: 'controlled-evidence',
    exitCode: 0,
    summary: { successful: true }
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = previousExitCode
})

describe('explicit test entry boundaries', () => {
  it('preserves concrete unit positionals and prevents a level override', () => {
    expect(entry.normalizeEntryArgs('unit', ['tests/example.test.js', '--plan']).args).toEqual([
      '--file',
      'tests/example.test.js',
      '--plan',
      '--level',
      'unit'
    ])
    expect(() =>
      entry.normalizeEntryArgs('unit', ['--file', 'tests/example.test.js', '--level', 'database'])
    ).toThrow('cannot override')
  })

  it.each(['unit', 'database', 'window', 'capture-native'])(
    '%s rejects empty or advisory-only scope',
    (kind) => {
      expect(() => entry.normalizeEntryArgs(kind, [])).toThrow()
      expect(() =>
        entry.normalizeEntryArgs(kind, ['--source', 'src/shared/example.js', '--plan'])
      ).toThrow('explicit test files or IDs')
      expect(() => entry.normalizeEntryArgs(kind, ['--feature', 'guessed-business-name'])).toThrow(
        'explicit test files or IDs'
      )
    }
  )

  it('rejects missing values rather than turning the next flag into a positional', () => {
    expect(() => entry.normalizeEntryArgs('unit', ['--file', '--plan'])).toThrow()
    expect(() => entry.normalizeEntryArgs('unit', ['--bogus', 'tests/example.test.js'])).toThrow(
      'Unknown argument'
    )
  })

  it('checks registered role/runtime instead of suffix-based assumptions', () => {
    const focused = focusedFixture()
    expect(() =>
      entry.createEntryPlan('unit', ['tests/gui.mjs'], { entries: registry, focused, root })
    ).toThrow()
    expect(() =>
      entry.createEntryPlan('database', ['--file', 'tests/example.test.js'], {
        entries: registry,
        focused,
        root
      })
    ).toThrow()
    expect(() =>
      entry.createEntryPlan('window', ['--file', 'tests/example.test.js'], {
        entries: registry,
        focused,
        root
      })
    ).toThrow('requires registered Electron')
    expect(() =>
      entry.createEntryPlan('capture-native', ['--file', 'tests/gui.mjs'], {
        entries: registry,
        focused,
        root
      })
    ).toThrow()
    expect(
      entry
        .createEntryPlan('capture-native', ['--file', 'tests/native.cpp', '--plan'], {
          entries: registry,
          focused,
          root
        })
        .selected.map((item) => item.file)
    ).toEqual(['tests/native.cpp'])
  })

  it('keeps a concrete window selection at one target and plans without executing', async () => {
    const focused = focusedFixture()
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const plan = await entry.main('window', ['--file', 'tests/gui.mjs', '--plan'], {
      entries: registry,
      focused,
      root
    })
    expect(plan.selected.map((item) => item.file)).toEqual(['tests/gui.mjs'])
    expect(plan.entry.scope).toBe('explicit-focused')
    expect(focused.executeFocusedPlan).not.toHaveBeenCalled()
  })

  it('prints the complete explicitly requested collection before execution', async () => {
    const files = entry.windowGroups.capture.map((file) => target(file, 'gui', 'electron'))
    const focused = focusedFixture()
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await entry.main('window', ['capture'], { entries: files, focused, root })
    const printed = JSON.parse(output.mock.calls[0][0])
    expect(printed.executed).toBe(false)
    expect(printed.entry).toEqual({
      kind: 'window',
      scope: 'explicit-collection',
      collection: 'capture'
    })
    expect(printed.selected.map((item) => item.file)).toEqual(entry.windowGroups.capture)
    expect(output.mock.invocationCallOrder[0]).toBeLessThan(
      focused.executeFocusedPlan.mock.invocationCallOrder[0]
    )
    expect(() =>
      entry.normalizeEntryArgs('window', ['capture', '--file', 'tests/extra.mjs'])
    ).toThrow('only --plan')
    expect(() => entry.normalizeEntryArgs('window', ['unknown-collection'])).toThrow(
      'Unknown explicit'
    )
  })

  it('keeps the previous release-quality unit/database/storage scope explicit', () => {
    const all = [
      target('tests/example.test.js'),
      ...manifest.databaseTests.map((file) => target(file, 'database', 'electron-node')),
      ...manifest.storageTests.map((file) => target(file, 'storage', 'electron'))
    ]
    const normalized = entry.normalizeEntryArgs('release-quality', ['--plan'], { entries: all })
    expect(normalized.collection).toBe('release-quality-unit-database-storage')
    expect(selection.parseSelectionArgs(normalized.args).files).toEqual(
      all.map((item) => item.file)
    )
    expect(() =>
      entry.normalizeEntryArgs('release-quality', ['--file', 'tests/example.test.js'], {
        entries: all
      })
    ).toThrow('fixed explicit scope')
  })

  it.each(['scripts/run-electron-node-tests.cjs', 'scripts/run-electron-window-tests.cjs'])(
    '%s refuses a no-argument invocation before execution',
    (file) => {
      const result = spawnSync(process.execPath, [file], {
        cwd: root,
        encoding: 'utf8',
        timeout: 15000
      })
      expect(result.status).toBe(2)
      expect(JSON.parse(result.stderr).executed).toBe(false)
      expect(result.stdout).not.toContain('Focused evidence:')
    }
  )
})
