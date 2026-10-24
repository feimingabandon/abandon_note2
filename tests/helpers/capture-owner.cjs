const { pathToFileURL } = require('node:url')
const path = require('node:path')
const { realpathSync } = require('node:fs')
;(async () => {
  const { CaptureHost } = await import(
    pathToFileURL(path.resolve('src/main/capture/CaptureHost.js'))
  )
  const directory = realpathSync(path.resolve(process.argv[3] || 'native_capture/deploy'))
  const root = realpathSync(path.resolve(process.argv[2]))
  const host = new CaptureHost({ directory, root })
  host.on('failure', (error) => {
    console.error(error)
    process.exit(2)
  })
  await host.start()
  process.stdout.write(
    JSON.stringify({
      enginePid: host.pid,
      ownerPid: process.pid,
      parentPid: process.ppid,
      root,
      directory
    }) + '\n'
  )
  setInterval(() => {}, 1000)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
