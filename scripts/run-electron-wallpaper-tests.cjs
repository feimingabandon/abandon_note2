const { spawnSync } = require('node:child_process')
const electronPath = require('electron')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(electronPath, ['tests/wallpaper-storage-electron.mjs'], {
  cwd: process.cwd(),
  env,
  stdio: 'inherit'
})

process.exit(result.status ?? 1)
