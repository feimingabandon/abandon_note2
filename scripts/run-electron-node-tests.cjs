const { spawnSync } = require('node:child_process')
const electronPath = require('electron')

const result = spawnSync(
  electronPath,
  ['node_modules/vite-node/dist/cli.mjs', 'tests/backend-integration.mjs'],
  {
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit'
  }
)

process.exit(result.status ?? 1)
