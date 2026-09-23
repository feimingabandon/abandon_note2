const electronPath = require('electron')
const { electronFeatureTests, windowFrameTests } = require('./test-manifest.cjs')
const { createRunDirectory, runJobs } = require('./test-runner.cjs')

const groups = Object.freeze({
  all: [...windowFrameTests, ...electronFeatureTests],
  features: electronFeatureTests,
  'logging-actions': ['tests/logging-actions-electron.mjs'],
  'window-frame': windowFrameTests,
  'window-control-drag': ['tests/window-control-drag-electron.mjs']
})

const groupName = process.argv[2] || 'window-frame'
const testFiles = groups[groupName]
if (!testFiles) {
  process.stderr.write(`Unknown Electron test group: ${groupName}\n`)
  process.exit(2)
}

const directory = createRunDirectory()
process.stdout.write(`Electron evidence: ${directory}\n`)
runJobs(
  testFiles.map((file) => ({
    id: file,
    command: electronPath,
    args: [file],
    gui: true,
    ...(file === 'tests/window-state-matrix-electron.mjs'
      ? { timeoutMs: 660_000, artifacts: ['tmp/window-state-matrix-results.json'] }
      : {})
  })),
  { directory }
)
  .then((results) => {
    process.exitCode = results.some((result) => result.status !== 'passed') ? 1 : 0
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
