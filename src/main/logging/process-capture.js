import { app, crashReporter } from 'electron'
import { logger, writeLog, getCrashDumpIndex } from './logger.js'

let installed = false
let recentDumps = []

export const getRecentCrashDumps = (limit = 5) => recentDumps.slice(0, limit)
export async function refreshCrashDumpIndex() {
  try {
    const result = await getCrashDumpIndex()
    recentDumps = result.unavailable ? [{ unavailable: true }] : result.files
    return result
  } catch {
    return { unavailable: true, files: recentDumps }
  }
}

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
    const recentCrashDumps = details.reason === 'clean-exit' ? undefined : getRecentCrashDumps()
    writeLog({
      level: details.reason === 'clean-exit' ? 'info' : 'fatal',
      process: 'child',
      scope: 'electron.child-process-gone',
      message: `${details.type} 子进程已退出：${details.reason}`,
      metadata: { ...details, ...(recentCrashDumps ? { recentCrashDumps } : {}) },
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
    void refreshCrashDumpIndex()
    logger.info('crash-reporter', '本地崩溃转储已启用', {
      crashDumpsPath: app.getPath('crashDumps'),
      recentCrashDumps: getRecentCrashDumps()
    })
  } catch (error) {
    logger.error('crash-reporter', error)
  }
}
