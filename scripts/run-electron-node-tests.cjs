const electronPath = require('electron')
const { databaseTests } = require('./test-manifest.cjs')
const { createRunDirectory, runJobs } = require('./test-runner.cjs')

const directory = createRunDirectory()
process.stdout.write(`Database evidence: ${directory}\n`)
runJobs(
  databaseTests.map((file) => ({
    id: file,
    command: electronPath,
    args: ['node_modules/vite-node/dist/cli.mjs', file],
    electronNode: true
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
