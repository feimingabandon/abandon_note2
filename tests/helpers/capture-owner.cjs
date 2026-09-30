const { pathToFileURL } = require('node:url')
const path = require('node:path')
;(async () => {
  const { CaptureHost } = await import(
    pathToFileURL(path.resolve('src/main/capture/CaptureHost.js'))
  )
  const host = new CaptureHost({
    directory: path.resolve(process.argv[3] || 'native_capture/deploy'),
    root: process.argv[2]
  })
  host.on('failure', (error) => {
    console.error(error)
    process.exit(2)
  })
  await host.start()
  process.stdout.write(JSON.stringify({ enginePid: host.pid }) + '\n')
  setInterval(() => {}, 1000)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
