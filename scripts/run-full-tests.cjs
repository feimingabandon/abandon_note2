const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, delimiter, join, resolve } = require('node:path')
const os = require('node:os')
const electron = require('electron')
const manifest = require('./test-manifest.cjs')
const { createRunDirectory, runJobs, summarizeResults } = require('./test-runner.cjs')

function createJobs() {
  const nodeJob = (id, args, extra = {}) => ({ id, command: process.execPath, args, ...extra })
  const guiJob = (file) => ({
    id: file,
    command: electron,
    args: [file],
    gui: true,
    windowsHide: false,
    requires: ['build-native', 'build-capture', 'build-app']
  })
  return [
    nodeJob('unit', ['node_modules/vitest/vitest.mjs', 'run']),
    nodeJob('lint-source', ['node_modules/eslint/bin/eslint.js', 'src', '--no-cache'], {
      resultKind: 'check'
    }),
    nodeJob(
      'lint-tests',
      [
        'node_modules/eslint/bin/eslint.js',
        'tests',
        'scripts/test-manifest.cjs',
        'scripts/test-runner.cjs',
        'scripts/run-full-tests.cjs',
        'scripts/run-electron-node-tests.cjs',
        'scripts/run-electron-window-tests.cjs',
        '--no-cache'
      ],
      { resultKind: 'check' }
    ),
    {
      id: 'build-native',
      resultKind: 'build',
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'native_blur/build.ps1']
    },
    {
      id: 'build-capture',
      resultKind: 'build',
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        'native_capture/build.ps1',
        '-Test',
        '-TestName',
        'capture_core,capture_ui,capture_ux,capture_selection,capture_pin_halo,capture_polish,capture_clipboard',
        '-InputDriver'
      ],
      prepare: ({ directory }) => ({
        args: [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          'native_capture/build.ps1',
          '-Test',
          '-TestName',
          'capture_core,capture_ui,capture_ux,capture_selection,capture_pin_halo,capture_polish,capture_clipboard',
          '-InputDriver',
          '-ResultDirectory',
          directory
        ]
      }),
      metadata: {
        scope: 'explicit-full-only',
        limits: [
          'Legacy build result does not certify individual Qt business counts; use focused Qt targets'
        ]
      }
    },
    nodeJob('build-app', ['node_modules/electron-vite/bin/electron-vite.js', 'build'], {
      resultKind: 'build'
    }),
    nodeJob('build-notice-preview', ['scripts/build-notice-preview.mjs'], { resultKind: 'build' }),
    ...manifest.focusedNativeTests.map((file) => ({
      ...guiJob(file),
      gui: false,
      windowsHide: true,
      requires: ['build-native']
    })),
    ...[...manifest.databaseTests, 'tests/maturity-db.mjs'].map((file) => ({
      id: file,
      command: electron,
      args: ['node_modules/vite-node/dist/cli.mjs', file],
      electronNode: true
    })),
    ...[
      ...manifest.focusedDatabaseTests,
      ...manifest.focusedGuiTests,
      ...manifest.storageTests,
      ...manifest.windowFrameTests,
      ...manifest.electronFeatureTests,
      ...manifest.acceptanceTests.filter((file) => file !== 'tests/maturity-db.mjs'),
      ...manifest.benchmarkTests
    ].map(guiJob)
  ].map((job) => {
    const artifacts = {
      'tests/draft-dialog-ui-electron.mjs': ['tmp/draft-dialog-ui-results.json'],
      'tests/help-center-electron.mjs': ['tmp/help-center-qa'],
      'tests/notice-admin-electron.mjs': ['tmp/notice-markdown-qa'],
      'tests/notice-markdown-electron.mjs': ['tmp/notice-markdown-qa'],
      'tests/window-state-matrix-electron.mjs': ['tmp/window-state-matrix-results.json'],
      'tests/maturity-electron.mjs': [
        'tmp/maturity-electron-results.json',
        'tmp/maturity-settings-white.png',
        'tmp/maturity-settings-black.png',
        'tmp/maturity-settings-wallpaper.png'
      ],
      'tests/maturity-regressions-electron.mjs': ['tmp/maturity-regressions-results.json'],
      'tests/thumbnail-benchmark-electron.mjs': [
        'tmp/thumbnail-benchmark.json',
        'tmp/thumbnail-benchmark-error.txt'
      ]
    }
    const needsPreview = [
      'tests/notice-admin-electron.mjs',
      'tests/notice-markdown-electron.mjs'
    ].includes(job.id)
    return {
      ...job,
      ...(job.id === 'tests/window-state-matrix-electron.mjs' ? { timeoutMs: 660_000 } : {}),
      artifacts: artifacts[job.id],
      requires: needsPreview ? [...job.requires, 'build-notice-preview'] : job.requires
    }
  })
}

function snapshot() {
  const git = (args) => spawnSync('git', args, { encoding: 'utf8', windowsHide: true }).stdout || ''
  const paths = git(['ls-files', '-c', '-o', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)
  const hashes = {}
  for (const file of paths) {
    if (existsSync(file))
      hashes[file] = createHash('sha256').update(readFileSync(file)).digest('hex')
  }
  for (const file of [
    'out/main/index.js',
    'native_blur/build/bin/blur_engine.dll',
    'native_capture/build/bin/AbandonCapture.exe',
    'native_capture/deploy/AbandonCapture.exe',
    'native_capture/deploy/capture_host.dll'
  ]) {
    if (existsSync(file))
      hashes[file] = createHash('sha256').update(readFileSync(file)).digest('hex')
  }
  return {
    at: new Date().toISOString(),
    commit: git(['rev-parse', 'HEAD']).trim(),
    status: git(['status', '--short']),
    hashes
  }
}

function selectJobs(all, requested) {
  for (const id of requested)
    if (!all.some((job) => job.id === id)) throw new Error(`Unknown test: ${id}`)
  if (!requested.length) return all
  const selected = new Set()
  const visiting = new Set()
  const ordered = []
  function visit(id) {
    if (selected.has(id)) return
    if (visiting.has(id)) throw new Error('Cyclic build dependency: ' + id)
    const job = all.find((entry) => entry.id === id)
    if (!job) throw new Error('Unknown required build: ' + id)
    visiting.add(id)
    for (const dependency of job.requires || []) visit(dependency)
    visiting.delete(id)
    selected.add(id)
    ordered.push(job)
  }
  for (const id of requested) visit(id)
  return ordered
}

async function main() {
  const requested = process.argv.slice(2)
  const jobs = selectJobs(createJobs(), requested)
  const directory = createRunDirectory()
  const env = { ...process.env, PATH: dirname(process.execPath) + delimiter + process.env.PATH }
  writeFileSync(
    join(directory, 'baseline.json'),
    JSON.stringify(
      {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        node: process.version,
        scope: requested.length ? 'selected-retest' : 'full',
        jobs: jobs.map((job) => job.id),
        ...snapshot()
      },
      null,
      2
    ) + '\n'
  )
  process.stdout.write(`Test evidence: ${directory}\n`)
  const results = await runJobs(jobs, { directory, cwd: resolve('.'), env })
  writeFileSync(join(directory, 'ending-snapshot.json'), JSON.stringify(snapshot(), null, 2) + '\n')
  const summary = summarizeResults(results)
  process.stdout.write(
    `Completed: ${summary.verifiedPassed}/${summary.total} verified; ${summary.legacyUnproven} legacy unproven; ${summary.unverified} unverified; ${summary.failed} failed; ${summary.blocked} blocked. Evidence: ${directory}\n`
  )
  process.exitCode = summary.successful ? 0 : 1
}

if (require.main === module)
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
module.exports = { createJobs, selectJobs }
