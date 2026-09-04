import { writeLog } from './logger.js'
import { getRecentCrashDumps } from './process-capture.js'

const contexts = new WeakMap()
const attached = new WeakSet()

function contextFor(win) {
  return contexts.get(win) || { role: 'unknown-window' }
}

function callSafely(target, method, fallback = null) {
  try {
    return typeof target?.[method] === 'function' ? target[method]() : fallback
  } catch {
    return fallback
  }
}

/**
 * 收集能够把 renderer 异常定位到具体窗口的最小运行态。
 * 不包含页面正文、表单值等用户内容。
 */
export function getWindowDiagnosticContext(win, webContents = win?.webContents) {
  const windowContext = win ? { ...contextFor(win) } : { role: 'unknown-window' }
  return {
    windowContext,
    browserWindowId: Number.isSafeInteger(win?.id) ? win.id : null,
    rendererProcessId: callSafely(webContents, 'getOSProcessId'),
    url: callSafely(webContents, 'getURL', ''),
    windowState: win
      ? {
          bounds: callSafely(win, 'getBounds'),
          visible: callSafely(win, 'isVisible'),
          focused: callSafely(win, 'isFocused'),
          minimized: callSafely(win, 'isMinimized')
        }
      : null
  }
}

function isExpectedViteDevelopmentMessage(context, details) {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (!rendererUrl) return false

  const sourceId = String(details?.sourceId || '')
  const message = String(details?.message || '')
  if (!sourceId.includes('/@vite/client')) return false

  if (
    message === '[vite] connecting...' ||
    message === '[vite] connected.' ||
    message.startsWith('[vite] hot updated:')
  ) {
    return true
  }
  if (context.role !== 'sticky' || !message.includes('Content Security Policy')) return false

  try {
    const host = new URL(rendererUrl).host
    return (
      message.includes("connect-src 'none'") &&
      (message.includes(`ws://${host}`) || message.includes(`wss://${host}`))
    )
  } catch {
    return false
  }
}

function recordWindowEvent(win, payload) {
  const context = contextFor(win)
  const diagnostic = getWindowDiagnosticContext(win)
  writeLog({
    process: 'renderer',
    windowRole: context.role,
    webContentsId: win.webContents.id,
    ...payload,
    metadata: {
      ...(payload.metadata || {}),
      ...diagnostic
    }
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
    const context = contextFor(win)
    if (isExpectedViteDevelopmentMessage(context, details)) return
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
    const recentCrashDumps = details.reason === 'clean-exit' ? undefined : getRecentCrashDumps()
    recordWindowEvent(win, {
      level: details.reason === 'clean-exit' ? 'info' : 'fatal',
      scope: 'renderer.render-process-gone',
      message: `渲染进程已退出：${details.reason}`,
      metadata: { ...details, ...(recentCrashDumps ? { recentCrashDumps } : {}) },
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
