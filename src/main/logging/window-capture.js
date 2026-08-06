import { writeLog } from './logger.js'

const contexts = new WeakMap()
const attached = new WeakSet()

function contextFor(win) {
  return contexts.get(win) || { role: 'unknown-window' }
}

function recordWindowEvent(win, payload) {
  const context = contextFor(win)
  writeLog({
    process: 'renderer',
    windowRole: context.role,
    webContentsId: win.webContents.id,
    ...payload
  })
}

export function setWindowLogContext(win, context) {
  if (!win || win.isDestroyed()) return
  contexts.set(win, { ...contextFor(win), ...context })
}

export function getWindowLogContext(win) {
  if (!win || win.isDestroyed()) return { role: 'unknown-window' }
  return { ...contextFor(win) }
}

export function attachWindowLogging(win) {
  if (!win || win.isDestroyed() || attached.has(win)) return
  attached.add(win)
  const webContents = win.webContents

  webContents.on('console-message', (details) => {
    const levelMap = {
      verbose: 'debug',
      info: 'info',
      warning: 'warn',
      error: 'error',
      debug: 'debug'
    }
    recordWindowEvent(win, {
      level: levelMap[details.level] || 'info',
      scope: 'renderer.console',
      message: details.message || '',
      metadata: {
        lineNumber: details.lineNumber,
        sourceId: details.sourceId
      }
    })
  })
  webContents.on('preload-error', (_event, preloadPath, error) => {
    recordWindowEvent(win, {
      level: 'error',
      scope: 'renderer.preload-error',
      message: error?.message || '预加载脚本失败',
      error,
      metadata: { preloadPath },
      dedupeKey: error?.stack || error?.message
    })
  })
  webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame && errorCode === -3) return
      recordWindowEvent(win, {
        level: 'error',
        scope: 'renderer.did-fail-load',
        message: errorDescription,
        metadata: { errorCode, validatedURL, isMainFrame }
      })
    }
  )
  webContents.on('render-process-gone', (_event, details) => {
    recordWindowEvent(win, {
      level: details.reason === 'clean-exit' ? 'info' : 'fatal',
      scope: 'renderer.render-process-gone',
      message: `渲染进程已退出：${details.reason}`,
      metadata: details,
      dedupeKey: `${details.reason}|${details.exitCode}`
    })
  })
  win.on('unresponsive', () => {
    recordWindowEvent(win, {
      level: 'error',
      scope: 'renderer.unresponsive',
      message: '窗口无响应'
    })
  })
  win.on('responsive', () => {
    recordWindowEvent(win, {
      level: 'info',
      scope: 'renderer.responsive',
      message: '窗口已恢复响应'
    })
  })
}
