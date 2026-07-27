const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const electronPath = require('electron')

const tempDir = mkdtempSync(join(tmpdir(), 'abandon-note2-schema-'))
const dbPath = join(tempDir, 'app.db')
let result

try {
  result = spawnSync(
    electronPath,
    ['node_modules/vite-node/dist/cli.mjs', 'scripts/reset-business-schema.mjs'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ABANDON_DB_PATH: dbPath,
        ELECTRON_RUN_AS_NODE: '1'
      },
      stdio: 'inherit'
    }
  )
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}

process.exit(result?.status ?? 1)
