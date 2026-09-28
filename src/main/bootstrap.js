import { app } from 'electron'
import {
  initializeLogger,
  installConsoleCapture,
  installConsoleStreamGuards,
  flushLogs,
  logger
} from './logging/logger.js'
import { installProcessCapture, startLocalCrashReporter } from './logging/process-capture.js'

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
