import { app } from 'electron'
import { initializeLogger, installConsoleCapture, logger } from './logging/logger.js'
import { installProcessCapture, startLocalCrashReporter } from './logging/process-capture.js'

initializeLogger()
installConsoleCapture()
installProcessCapture()
startLocalCrashReporter()
logger.info('bootstrap', '应用启动', { argv: process.argv })

import('./index.js').catch((error) => {
  logger.fatal('bootstrap.import', error)
  try {
    app.exit(1)
  } catch {
    process.exitCode = 1
  }
})
