import { app } from 'electron'
import {
  initializeLogger,
  installConsoleCapture,
  installConsoleStreamGuards,
  flushLogs,
  logger
} from './logging/logger.js'
import { installProcessCapture, startLocalCrashReporter } from './logging/process-capture.js'
import { enforceWindowsPlatform } from '../shared/platform-support.js'

if (
  enforceWindowsPlatform({
    report: (error) => console.error(error.message),
    exit: (code) => app.exit(code)
  })
) {
  if (process.argv.includes('--abandon-image-decode-gate')) {
    // A gate requires Node mode. An incompatible RunAsNode fuse must never enter product IO.
    app.exit(1)
  } else if (process.argv.includes('--abandon-image-decoder')) {
    // Child decode must branch before logging, single-instance admission and product IO.
    void import('./images/image-decode-entry.mjs').catch((error) => {
      console.error(error)
      app.exit(1)
    })
  } else {
    installConsoleStreamGuards()
    initializeLogger()
    installConsoleCapture()
    installProcessCapture()
    startLocalCrashReporter()
    logger.info('bootstrap', '应用启动', {
      flags: process.argv
        .filter((arg) => /^--[a-z-]+(?:=|$)/i.test(arg))
        .map((arg) => arg.split('=')[0])
        .slice(0, 32)
    })

    import('./index.js').catch(async (error) => {
      logger.fatal('bootstrap.import', error)
      await flushLogs(1000).catch(() => {})
      try {
        app.exit(1)
      } catch {
        process.exitCode = 1
      }
    })
  }
}
