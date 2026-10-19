import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import selector from '../scripts/test-selection.cjs'
import runner from '../scripts/test-runner.cjs'
import focused from '../scripts/run-focused-tests.cjs'

const { parseSelectionArgs, selectTests, TestSelectionError } = selector
const item = (id, file, extra = {}) => ({
  id,
  file,
  role: 'test',
  level: 'unit',
  runtime: 'vitest',
  selectionPolicy: 'focused',
  features: [],
  contracts: [],
  sourceDependencies: [],
  sourceReadDependencies: [],
  requires: [],
  runtimePrerequisites: [],
  limits: [],
  disposition: 'retain',
  cost: 'unknown',
  ...extra
})
const registry = () => [
  item('build-native', 'native_blur/build.ps1', {
    role: 'build',
    level: 'build',
    runtime: 'powershell',
    selectionPolicy: 'support',
    sourceDependencies: ['native_blur/blur.cpp'],
    runtimePrerequisites: ['windows', 'msvc']
  }),
  item('build-app', 'electron.vite.config.mjs', {
    role: 'build',
    level: 'build',
    runtime: 'node',
    selectionPolicy: 'support',
    requires: ['build-native']
  }),
  item('unit-note', 'tests/note.test.js', {
    features: ['notes'],
    sourceDependencies: ['src/shared/note.js']
  }),
  item('db-note', 'tests/note-db.mjs', {
    level: 'database',
    runtime: 'electron-node',
    features: ['notes'],
    sourceDependencies: ['src/main/db/notes.js'],
    runtimePrerequisites: ['electron-abi']
  }),
  item('gui-note', 'tests/note-electron.mjs', {
    level: 'gui',
    runtime: 'electron',
    features: ['notes'],
    requires: ['build-app'],
    sourceDependencies: ['tests/helpers/renderer.mjs'],
    sourceReadDependencies: ['src/renderer/Note.vue'],
    runtimePrerequisites: ['windows', 'desktop']
  }),
  item('gui-calendar', 'tests/calendar-electron.mjs', {
    level: 'gui',
    runtime: 'electron',
    features: ['calendar'],
    requires: ['build-app'],
    sourceDependencies: ['tests/helpers/renderer.mjs'],
    runtimePrerequisites: ['desktop']
  }),
  item('acceptance-note', 'tests/note-acceptance.mjs', {
    level: 'gui',
    runtime: 'electron',
    features: ['notes'],
    selectionPolicy: 'explicit',
    requires: ['build-app']
  }),
  item('perf-note', 'tests/note-benchmark.mjs', {
    level: 'performance',
    runtime: 'electron',
    features: ['notes'],
    selectionPolicy: 'explicit'
  }),
  item('native-note', 'native_capture/tests/input_test.cpp', {
    level: 'native',
    runtime: 'qt',
    features: ['notes'],
    selectionPolicy: 'explicit'
  }),
  item('install-note', 'scripts/test-installer.ps1', {
    level: 'install',
    runtime: 'powershell',
    features: ['notes'],
    selectionPolicy: 'explicit'
  }),
  item('renderer-helper', 'tests/helpers/renderer.mjs', {
    role: 'helper',
    level: 'support',
    runtime: 'none',
    selectionPolicy: 'support',
    sourceDependencies: ['tests/helpers/date.mjs']
  }),
  item('date-helper', 'tests/helpers/date.mjs', {
    role: 'helper',
    level: 'support',
    runtime: 'none',
    selectionPolicy: 'support'
  }),
  item('note-fixture', 'tests/fixtures/note.json', {
    role: 'fixture',
    level: 'support',
    runtime: 'none',
    selectionPolicy: 'support'
  })
]
const ids = (entries) => entries.map((entry) => entry.id)
const plan = (args, entries = registry(), options = {}) =>
  selectTests(entries, parseSelectionArgs(args), options)
const expectCode = (run, code) => {
  let error
  try {
    run()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(TestSelectionError)
  expect(error.code).toBe(code)
}

describe('focused test argument parsing', () => {
  it('accepts repeatable selectors and preserves exact values for explanation', () => {
    expect(
      parseSelectionArgs([
        '--file',
        'tests/note.test.js',
        '--file=tests/note-db.mjs',
        '--id=db-note',
        '--feature',
        'notes',
        '--feature=calendar',
        '--source',
        'src/renderer/Note.vue',
        '--source=src/shared/note.js',
        '--plan',
        '--build=reuse-verified',
        '--level=unit'
      ])
    ).toEqual({
      files: ['tests/note.test.js', 'tests/note-db.mjs'],
      ids: ['db-note'],
      features: ['notes', 'calendar'],
      sources: ['src/renderer/Note.vue', 'src/shared/note.js'],
      plan: true,
      build: 'reuse-verified',
      level: 'unit'
    })
    expect(parseSelectionArgs([])).toEqual({
      files: [],
      ids: [],
      features: [],
      sources: [],
      plan: false,
      build: 'rebuild',
      level: null
    })
  })

  it.each([
    [['--all'], 'FULL_SELECTION_FORBIDDEN'],
    [['tests/note.test.js'], 'UNKNOWN_ARGUMENT'],
    [['--changed'], 'UNKNOWN_ARGUMENT'],
    [['--plan=true'], 'UNKNOWN_ARGUMENT'],
    [['--file'], 'INVALID_VALUE'],
    [['--file='], 'INVALID_VALUE'],
    [['--file', '--plan'], 'MISSING_VALUE'],
    [['--level=everything'], 'INVALID_LEVEL'],
    [['--build=skip'], 'INVALID_BUILD_MODE'],
    [['--level=build'], 'INVALID_LEVEL'],
    [['--build=rebuild', '--build=reuse-verified'], 'DUPLICATE_ARGUMENT']
  ])('rejects invalid or ambiguous invocation %j', (args, code) =>
    expectCode(() => parseSelectionArgs(args), code)
  )
})

describe('focused registry selection', () => {
  it('refuses empty input and zero-match requests, even with plan enabled', () => {
    expectCode(() => plan([]), 'EMPTY_SELECTION')
    expectCode(() => plan(['--plan']), 'EMPTY_SELECTION')
    expectCode(() => plan(['--id=missing']), 'UNKNOWN_TEST')
    expectCode(() => plan(['--file=tests/missing.mjs']), 'UNKNOWN_TEST')
    expectCode(() => plan(['--feature=missing']), 'UNKNOWN_FEATURE')
  })

  it('selects one DB file without adding the DB suite or an app build', () => {
    const result = plan(['--file=tests/note-db.mjs'])
    expect(ids(result.selected)).toEqual(['db-note'])
    expect(ids(result.dependencies)).toEqual([])
    expect(ids(result.jobs)).toEqual(['db-note'])
    expect(result.runtimePrerequisites).toEqual(['electron-abi'])
    expect(result.buildMode).toBe('rebuild')
    expect(result.planOnly).toBe(false)
  })

  it('selects one GUI file with its full build closure and separate runtime prerequisites', () => {
    const result = plan(['--id=gui-note', '--plan'])
    expect(ids(result.selected)).toEqual(['gui-note'])
    expect(ids(result.dependencies)).toEqual(['build-native', 'build-app'])
    expect(ids(result.jobs)).toEqual(['build-native', 'build-app', 'gui-note'])
    expect(result.runtimePrerequisites).toEqual(['windows', 'msvc', 'desktop'])
    expect(result.reasons['build-app']).toEqual([{ type: 'requires', value: 'gui-note' }])
    expect(result.planOnly).toBe(true)
  })

  it('unions file/id/feature choices in registry order, deduplicating shared builds', () => {
    const result = plan([
      '--id=gui-calendar',
      '--feature=notes',
      '--file=tests/note.test.js',
      '--id=gui-note',
      '--id=gui-note'
    ])
    expect(ids(result.selected)).toEqual(['unit-note', 'db-note', 'gui-note', 'gui-calendar'])
    expect(ids(result.jobs)).toEqual([
      'build-native',
      'build-app',
      'unit-note',
      'db-note',
      'gui-note',
      'gui-calendar'
    ])
    expect(result.reasons['gui-note']).toEqual([
      { type: 'id', value: 'gui-note' },
      { type: 'feature', value: 'notes' }
    ])
    expect(result.reasons['build-app']).toEqual([
      { type: 'requires', value: 'gui-note' },
      { type: 'requires', value: 'gui-calendar' }
    ])
    expect(result.warnings[0]).toContain('acceptance-note, perf-note, native-note, install-note')
  })

  it('never discards required builds when reuse-verified is requested', () => {
    const rebuilt = plan(['--id=gui-note'])
    const reused = plan(['--id=gui-note', '--build=reuse-verified'])
    expect(ids(reused.jobs)).toEqual(ids(rebuilt.jobs))
    expect(reused.buildMode).toBe('reuse-verified')
  })

  it('requires explicit file/id selections for acceptance, native, install, and performance', () => {
    const result = plan(['--feature=notes'])
    expect(ids(result.selected)).toEqual(['unit-note', 'db-note', 'gui-note'])
    for (const id of ['acceptance-note', 'perf-note', 'native-note', 'install-note']) {
      expect(ids(plan([`--id=${id}`]).selected)).toEqual([id])
    }
    expectCode(() => plan(['--feature=notes', '--level=native']), 'EMPTY_FEATURE')
    expectCode(
      () =>
        plan(
          ['--feature=only-explicit'],
          [
            item('accept', 'tests/accept.mjs', {
              level: 'gui',
              runtime: 'electron',
              features: ['only-explicit'],
              selectionPolicy: 'explicit'
            })
          ]
        ),
      'EMPTY_FEATURE'
    )
  })

  it('supports a level-scoped feature but rejects incompatible explicit selections', () => {
    expect(ids(plan(['--feature=notes', '--level=unit']).selected)).toEqual(['unit-note'])
    expectCode(() => plan(['--file=tests/note-db.mjs', '--level=unit']), 'LEVEL_MISMATCH')
    expectCode(() => plan(['--id=unit-note', '--level=gui']), 'LEVEL_MISMATCH')
    expectCode(() => plan(['--feature=calendar', '--level=database']), 'EMPTY_FEATURE')
  })

  it('keeps a registered PowerShell GUI launcher separate from Vitest and Electron Node mode', () => {
    const entries = [
      item('sandbox-gui', 'tests/sandbox.ps1', {
        level: 'gui',
        runtime: 'powershell',
        selectionPolicy: 'explicit'
      })
    ]
    const result = plan(['--id=sandbox-gui', '--level=gui'], entries)
    expect(result.selected[0].runtime).toBe('powershell')
    expectCode(() => plan(['--id=sandbox-gui', '--level=unit'], entries), 'LEVEL_MISMATCH')
  })

  it('explains special registry IDs without changing or losing the reason map prototype', () => {
    const result = plan(['--id=__proto__'], [item('__proto__', 'tests/prototype.test.js')])
    expect(Object.getPrototypeOf(result.reasons)).toBe(null)
    expect(JSON.parse(JSON.stringify(result.reasons))['__proto__']).toEqual([
      { type: 'id', value: '__proto__' }
    ])
  })

  it.each(['renderer-helper', 'note-fixture', 'build-app'])(
    'does not treat support item %s as a test',
    (id) => {
      expectCode(() => plan([`--id=${id}`]), 'TEST_REQUIRED')
      const file = registry().find((entry) => entry.id === id).file
      expectCode(() => plan([`--file=${file}`]), 'TEST_REQUIRED')
    }
  )

  it('rejects invalid runtime/level combinations before returning a plan', () => {
    expectCode(
      () =>
        plan(
          ['--id=unit-note'],
          [item('unit-note', 'tests/note.test.js', { runtime: 'electron' })]
        ),
      'INVALID_RUNTIME'
    )
    expectCode(
      () =>
        plan(
          ['--id=bad'],
          [item('bad', 'tests/bad.mjs', { level: 'gui', runtime: 'electron-node' })]
        ),
      'INVALID_RUNTIME'
    )
  })

  it('does not mutate frozen registry entries or caller selection', () => {
    const entries = registry()
    for (const entry of entries) {
      Object.values(entry).filter(Array.isArray).forEach(Object.freeze)
      Object.freeze(entry)
    }
    Object.freeze(entries)
    const selection = parseSelectionArgs(['--id=gui-note'])
    Object.values(selection).filter(Array.isArray).forEach(Object.freeze)
    Object.freeze(selection)
    const before = JSON.stringify({ entries, selection })
    const result = selectTests(entries, selection)
    expect(result.selected[0]).toBe(entries[4])
    expect(JSON.stringify({ entries, selection })).toBe(before)
  })
})

describe('source candidates without automatic execution', () => {
  it('explains a source-read dependency and creates no jobs in a source-only plan', () => {
    const result = plan(['--source=src/renderer/Note.vue', '--plan'])
    expect(ids(result.candidates)).toEqual(['gui-note'])
    expect(ids(result.selected)).toEqual([])
    expect(ids(result.jobs)).toEqual([])
    expect(result.runtimePrerequisites).toEqual([])
    expect(result.reasons['gui-note']).toEqual([
      { type: 'source-read', value: 'src/renderer/Note.vue' }
    ])
    expect(result.warnings).toContain(
      'Source candidates are advisory and may be incomplete; only explicit file/id/feature selections enter jobs'
    )
  })

  it('follows helper consumers transitively and still requires concrete execution choices', () => {
    const result = plan(['--source=tests/helpers/date.mjs', '--plan'])
    expect(ids(result.candidates)).toEqual(['gui-note', 'gui-calendar'])
    expect(result.reasons['gui-note']).toEqual([
      { type: 'helper-consumer', value: 'tests/helpers/date.mjs', via: 'renderer-helper' }
    ])
    expectCode(() => plan(['--source=tests/helpers/date.mjs']), 'SOURCE_REQUIRES_PLAN')
  })

  it('shows build consumers as candidates without scheduling that build', () => {
    const result = plan(['--source=native_blur/blur.cpp', '--plan'])
    expect(ids(result.candidates)).toEqual(['gui-note', 'gui-calendar', 'acceptance-note'])
    expect(ids(result.dependencies)).toEqual([])
    expect(result.reasons['gui-note'][0].type).toBe('dependency-consumer')
  })

  it('keeps source candidates and unrelated registry changes out of selected jobs', () => {
    const entries = [
      ...registry(),
      item('unrelated-dirty', 'tests/unrelated.test.js', {
        sourceDependencies: ['src/unrelated.js']
      })
    ]
    const result = plan(['--id=db-note', '--source=src/renderer/Note.vue'], entries)
    expect(ids(result.selected)).toEqual(['db-note'])
    expect(ids(result.jobs)).toEqual(['db-note'])
    expect(ids(result.candidates)).toEqual(['gui-note'])
    expect(result.reasons).not.toHaveProperty('unrelated-dirty')
  })

  it('fails every unmapped source including mixed known-source and explicit selection requests', () => {
    expectCode(() => plan(['--source=src/missing.js', '--plan']), 'UNMAPPED_SOURCE')
    expectCode(
      () =>
        plan([
          '--id=unit-note',
          '--source=src/shared/note.js',
          '--source=src/missing.js',
          '--plan'
        ]),
      'UNMAPPED_SOURCE'
    )
    expectCode(
      () => plan(['--source=src/renderer/Note.vue', '--level=database', '--plan']),
      'SOURCE_LEVEL_MISMATCH'
    )
  })
})

describe('repository file boundaries', () => {
  it('normalizes Windows separators, drive case, and registered filenames within an explicit root', () => {
    const result = plan(
      ['--file=c:\\REPO\\tests\\NOTE.test.js', '--file=.\\tests\\note.test.js'],
      registry(),
      { root: 'C:\\repo' }
    )
    expect(ids(result.selected)).toEqual(['unit-note'])
  })

  it('normalizes POSIX absolute and relative paths without consulting the working directory', () => {
    expect(
      ids(plan(['--file=/repo/tests/./note.test.js'], registry(), { root: '/repo' }).selected)
    ).toEqual(['unit-note'])
    expect(ids(plan(['--file=./tests/note.test.js']).selected)).toEqual(['unit-note'])
    expectCode(() => plan(['--file=/repo/tests/note.test.js']), 'ROOT_REQUIRED')
  })

  it.each([
    ['../tests/note.test.js', 'OUTSIDE_REPOSITORY'],
    ['tests/../../note.test.js', 'OUTSIDE_REPOSITORY'],
    ['/repo-sibling/tests/note.test.js', 'OUTSIDE_REPOSITORY'],
    ['C:\\other\\tests\\note.test.js', 'OUTSIDE_REPOSITORY'],
    ['\\\\server\\repo\\tests\\note.test.js', 'INVALID_PATH'],
    ['//server/repo/tests/note.test.js', 'INVALID_PATH'],
    ['https://example.test/note.test.js', 'INVALID_PATH'],
    ['file:tests/note.test.js', 'INVALID_PATH'],
    ['tests/*.test.js', 'INVALID_PATH'],
    ['tests/[ab].test.js', 'INVALID_PATH'],
    ['tests/note.test.js\0', 'INVALID_VALUE'],
    ['C:tests/note.test.js', 'INVALID_PATH']
  ])('rejects unsafe path %j', (file, code) =>
    expectCode(() => plan(['--file', file], registry(), { root: '/repo' }), code)
  )

  it('rejects sibling Windows absolute paths and alternate-stream colon paths', () => {
    expectCode(
      () => plan(['--file=C:\\repo-old\\tests\\note.test.js'], registry(), { root: 'C:\\repo' }),
      'OUTSIDE_REPOSITORY'
    )
    expectCode(
      () => plan(['--file=tests/note.test.js:stream'], registry(), { root: 'C:\\repo' }),
      'INVALID_PATH'
    )
  })
})

describe('registry integrity before planning', () => {
  it('rejects duplicate IDs/files, missing metadata, and unknown build references', () => {
    expectCode(
      () => plan(['--id=unit-note'], [...registry(), item('unit-note', 'tests/another.test.js')]),
      'DUPLICATE_ID'
    )
    expectCode(
      () => plan(['--id=unit-note'], [...registry(), item('another', 'tests/note.test.js')]),
      'DUPLICATE_FILE'
    )
    expectCode(
      () =>
        plan(
          ['--id=broken'],
          [item('broken', 'tests/broken.test.js', { sourceReadDependencies: undefined })]
        ),
      'INVALID_REGISTRY'
    )
    expectCode(
      () =>
        plan(['--id=broken'], [item('broken', 'tests/broken.test.js', { requires: ['missing'] })]),
      'UNKNOWN_DEPENDENCY'
    )
  })

  it('refuses cycles or non-build requires even if the invalid item was not selected', () => {
    const entries = registry()
    entries[0].requires = ['build-app']
    expectCode(() => plan(['--id=unit-note'], entries), 'DEPENDENCY_CYCLE')
    expectCode(
      () =>
        plan(
          ['--id=unit-note'],
          [
            ...registry(),
            item('unselected', 'tests/unselected.test.js', { requires: ['unit-note'] })
          ]
        ),
      'INVALID_DEPENDENCY'
    )
  })
})

describe('read-only planning CLI with the actual repository registry', () => {
  const root = resolve(import.meta.dirname, '..')
  const roots = []
  const privateRoot = () => {
    const directory = mkdtempSync(join(tmpdir(), 'abandon-selection-unit-'))
    roots.push(directory)
    return directory
  }
  afterEach(() => {
    for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
  })
  const run = (args, directory = privateRoot()) =>
    spawnSync(process.execPath, ['scripts/test-selection.cjs', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: focused.normalizedEnvironment({ ...process.env, ABANDON_TEST_EVIDENCE_ROOT: directory }),
      windowsHide: true,
      timeout: 15000
    })
  const runDirectories = (directory) => {
    return existsSync(directory) ? readdirSync(directory).sort() : []
  }
  const assertNoOwnEvidence = (directory, before) =>
    expect(runDirectories(directory)).toEqual(before)

  it('plans exactly one real database file without starting a test, creating evidence, or adding the other six', () => {
    const directory = privateRoot()
    const before = runDirectories(directory)
    const result = run(['--file=tests/reminder-database-integration.mjs', '--plan'], directory)
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    const output = JSON.parse(result.stdout)
    expect(output.executed).toBe(false)
    expect(output.selected.map((entry) => entry.id)).toEqual([
      'tests/reminder-database-integration.mjs'
    ])
    expect(output.dependencies).toEqual([])
    expect(output.order).toEqual(['tests/reminder-database-integration.mjs'])
    assertNoOwnEvidence(directory, before)
  })

  it('does not attribute an independent owned check run to this plan', async () => {
    const directory = privateRoot()
    const otherNamespace = privateRoot()
    const before = runDirectories(directory)
    const result = run(['--file=tests/reminder-database-integration.mjs', '--plan'], directory)
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
    expect(runDirectories(otherNamespace)).toHaveLength(1)
    assertNoOwnEvidence(directory, before)
  })

  it('detects a broken plan fixture writing in its own evidence namespace', () => {
    const directory = privateRoot()
    const before = runDirectories(directory)
    const accidentalRun = runner.createRunDirectory(directory)
    writeFileSync(join(accidentalRun, 'result.json'), '{"executed":true}')
    expect(() => assertNoOwnEvidence(directory, before)).toThrow()
  })

  it('preserves an Electron-ready database integration runtime and a native background helper scope', () => {
    const database = run([
      '--file=tests/note-draft-conflict-electron.mjs',
      '--level=database',
      '--plan'
    ])
    expect(database.status).toBe(0)
    expect(JSON.parse(database.stdout).selected[0]).toMatchObject({
      level: 'database',
      runtime: 'electron'
    })
    const native = run(['--file=tests/capture-host-electron.mjs', '--plan'])
    expect(native.status).toBe(0)
    const output = JSON.parse(native.stdout)
    expect(output.selected[0]).toMatchObject({ level: 'native', runtime: 'electron' })
    expect(output.dependencies.map((entry) => entry.id)).toEqual(['build-capture'])
    expect(output.executed).toBe(false)
  })

  it('shows real source-read candidates without generating execution jobs', () => {
    const result = run(['--source=src/renderer/src/components/list/SearchBox.vue', '--plan'])
    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.selected).toEqual([])
    expect(output.order).toEqual([])
    expect(output.candidates.map((entry) => entry.id)).toContain(
      'tests/recent-local-day-range.test.js'
    )
    expect(output.reasons['tests/recent-local-day-range.test.js'][0].type).toBe('source-read')
  })

  it.each([
    [[], 'PLAN_REQUIRED'],
    [['--file=tests/test-manifest.test.js'], 'PLAN_REQUIRED'],
    [['--all', '--plan'], 'FULL_SELECTION_FORBIDDEN'],
    [['--file=tests/helpers/ui-fixture.cjs', '--plan'], 'TEST_REQUIRED'],
    [['--file=tests/unknown.test.js', '--plan'], 'UNKNOWN_TEST']
  ])(
    'fails invocation %j without starting jobs or creating an evidence directory',
    (args, code) => {
      const directory = privateRoot()
      const before = runDirectories(directory)
      const result = run(args, directory)
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(JSON.parse(result.stderr)).toMatchObject({ executed: false, error: { code } })
      assertNoOwnEvidence(directory, before)
    }
  )
})
