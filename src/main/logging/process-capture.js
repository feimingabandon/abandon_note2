import { app, crashReporter } from 'electron'
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { logger, writeLog } from './logger.js'

let installed = false

export function getRecentCrashDumps(limit = 5) {
  try {
    const crashDumpsPath = app.getPath('crashDumps')
    const directories = [crashDumpsPath, join(crashDumpsPath, 'reports')]
    const dumps = []
    for (const directory of directories) {
      if (!existsSync(directory)) continue
      for (const name of readdirSync(directory)) {
        if (!name.toLocaleLowerCase().endsWith('.dmp')) continue
        const path = join(directory, name)
        const stat = statSync(path)
        if (!stat.isFile()) continue
        dumps.push({
          name,
          relativePath: directory === crashDumpsPath ? name : join('reports', name),
          size: stat.size,
          modifiedAt: stat.mtime.toISOString()
        })
      }
    }
    return dumps
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
      .slice(0, Math.max(0, Number(limit) || 0))
  } catch (error) {
    return [{ unavailable: true, reason: error?.message || String(error) }]
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
    logger.info('crash-reporter', '本地崩溃转储已启用', {
      crashDumpsPath: app.getPath('crashDumps'),
      recentCrashDumps: getRecentCrashDumps()
    })
  } catch (error) {
    logger.error('crash-reporter', error)
  }
}
