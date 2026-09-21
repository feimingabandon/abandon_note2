const { spawnSync } = require('node:child_process')
const electronPath = require('electron')

const testFiles = [
  'tests/backend-integration.mjs',
  'tests/note-duration-db.mjs'
]

for (const testFile of testFiles) {
  const result = spawnSync(electronPath, ['node_modules/vite-node/dist/cli.mjs', testFile], {
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit'
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
