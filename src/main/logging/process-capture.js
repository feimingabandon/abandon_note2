import { app, crashReporter } from 'electron'
import { logger, writeLog } from './logger.js'

let installed = false

export function installProcessCapture() {
  if (installed) return
  installed = true

  process.on('uncaughtExceptionMonitor', (error, origin) => {
    logger.fatal(
      origin === 'unhandledRejection' ? 'process.unhandledRejection' : 'process.uncaughtException',
      error,
      { origin }
    )
  })
  process.on('warning', (warning) => {
    logger.warn('process.warning', warning.message, {
      name: warning.name,
      stack: warning.stack
    })
  })
  app.on('child-process-gone', (_event, details) => {
    writeLog({
      level: details.reason === 'clean-exit' ? 'info' : 'fatal',
      process: 'child',
      scope: 'electron.child-process-gone',
      message: `${details.type} 子进程已退出：${details.reason}`,
      metadata: details,
      dedupeKey: `${details.type}|${details.reason}|${details.exitCode}`
    })
  })
}

export function startLocalCrashReporter() {
  try {
    crashReporter.start({
      productName: app.getName(),
      companyName: 'Abandon Note',
      submitURL: '',
      uploadToServer: false,
      compress: false,
      ignoreSystemCrashHandler: false,
      rateLimit: false
    })
    logger.info('crash-reporter', '本地崩溃转储已启用', {
      crashDumpsPath: app.getPath('crashDumps')
    })
  } catch (error) {
    logger.error('crash-reporter', error)
  }
}
