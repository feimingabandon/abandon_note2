const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, delimiter, join, resolve } = require('node:path')
const os = require('node:os')
const electron = require('electron')
const manifest = require('./test-manifest.cjs')
const { createRunDirectory, runJobs } = require('./test-runner.cjs')

function createJobs() {
  const nodeJob = (id, args, extra = {}) => ({ id, command: process.execPath, args, ...extra })
  const guiJob = (file) => ({
    id: file,
    command: electron,
    args: [file],
    gui: true,
    requires: ['build-native', 'build-app']
  })
  return [
    nodeJob('unit', ['node_modules/vitest/vitest.mjs', 'run']),
    nodeJob('lint-source', ['node_modules/eslint/bin/eslint.js', 'src', '--no-cache']),
    nodeJob('lint-tests', [
      'node_modules/eslint/bin/eslint.js',
      'tests',
      'scripts/test-manifest.cjs',
      'scripts/test-runner.cjs',
      'scripts/run-full-tests.cjs',
      'scripts/run-electron-node-tests.cjs',
      'scripts/run-electron-window-tests.cjs',
      '--no-cache'
    ]),
    {
      id: 'build-native',
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'native_blur/build.ps1']
    },
    nodeJob('build-app', ['node_modules/electron-vite/bin/electron-vite.js', 'build']),
    nodeJob('build-notice-preview', ['scripts/build-notice-preview.mjs']),
    ...[...manifest.databaseTests, 'tests/maturity-db.mjs'].map((file) => ({
      id: file,
      command: electron,
      args: ['node_modules/vite-node/dist/cli.mjs', file],
      electronNode: true
    })),
    ...[
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
  for (const file of ['out/main/index.js', 'native_blur/build/bin/blur_engine.dll']) {
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
  // Explicit selection is a retest using the recorded existing build, not a full run.
  // If a build IS selected, its failure must still block its selected dependants.
  return requested.length
    ? all
        .filter((job) => requested.includes(job.id))
        .map((job) => ({ ...job, requires: job.requires?.filter((id) => requested.includes(id)) }))
    : all
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
  const failures = results.filter((result) => result.status !== 'passed')
  process.stdout.write(
    `Completed: ${results.length - failures.length}/${results.length} passed. Evidence: ${directory}\n`
  )
  process.exitCode = failures.length ? 1 : 0
}

if (require.main === module)
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
module.exports = { createJobs, selectJobs }
