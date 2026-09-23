import { ipcMain as electronIpcMain, BrowserWindow } from 'electron'
import {
  diagnosticErrorCode,
  diagnosticOutcome,
  summarizeDiagnosticResult
} from '../../shared/diagnostic-actions.js'
import { takeInvocationContext, withOperation, observeDiagnostic } from './operation-context.js'
import { logger, writeLog } from './logger.js'
import { captureIpcArguments } from './ipc-arguments.js'

const listenerWrappers = new Map()
const SLOW_IPC_MS = 2000

function senderMetadata(event, channel, startedAt, actionContext = null) {
  return {
    channel,
    durationMs: Date.now() - startedAt,
    webContentsId: event?.sender?.id,
    url: event?.sender?.getURL?.(),
    actionId: actionContext?.actionId,
    eventName: actionContext?.eventName
  }
}

function reportActionOutcome(
  event,
  channel,
  startedAt,
  actionContext,
  outcome,
  error = null,
  args = [],
  result,
  windowState
) {
  if (!actionContext) return
  const durationMs = Date.now() - startedAt
  observeDiagnostic(() =>
    writeLog({
      level: outcome === 'failure' ? 'error' : 'info',
      process: 'main',
      scope: 'ipc.action',
      eventName: actionContext.eventName,
      phase: outcome === 'failure' ? 'failure' : 'returned',
      actionId: actionContext.actionId,
      outcome,
      durationMs,
      stage: 'ipc-handler',
      errorCode: error ? diagnosticErrorCode(error) : undefined,
      message:
        outcome === 'failure'
          ? `主进程操作失败：${actionContext.eventName}`
          : `主进程接口返回：${actionContext.eventName}`,
      error: error || undefined,
      metadata: {
        ...senderMetadata(event, channel, startedAt, actionContext),
        ...summarizeDiagnosticResult(result),
        windowState,
        ...(error ? { arguments: captureIpcArguments(args) } : {})
      }
    })
  )
}

function readWindowState(event, channel) {
  if (!/^(view:|toggle-lock|set-window-|presentation-mode:)/.test(channel)) return undefined
  return observeDiagnostic(() => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return { destroyed: true }
    return {
      bounds: win.getBounds(),
      visible: win.isVisible(),
      focused: win.isFocused(),
      minimized: win.isMinimized(),
      alwaysOnTop: win.isAlwaysOnTop(),
      url: event.sender.getURL()
    }
  })
}

function wrapHandle(channel, handler) {
  return function loggedIpcHandle(event, ...args) {
    const startedAt = Date.now()
    const actionContext = takeInvocationContext(channel, args)
    return withOperation(actionContext, () => {
      const beforeWindow = readWindowState(event, channel)
      if (actionContext)
        observeDiagnostic(() =>
          writeLog({
            scope: 'ipc.action',
            eventName: actionContext.eventName,
            actionId: actionContext.actionId,
            phase: 'received',
            stage: 'ipc-handler',
            outcome: 'pending',
            message: `主进程收到请求：${channel}`,
            metadata: {
              ...senderMetadata(event, channel, startedAt, actionContext),
              windowState: beforeWindow
            }
          })
        )
      let pendingTimer
      const clearPending = () => clearTimeout(pendingTimer)
      const reportSlow = () => {
        const durationMs = Date.now() - startedAt
        if (durationMs >= SLOW_IPC_MS) {
          observeDiagnostic(() =>
            logger.warn(
              'ipc.slow',
              `${channel} 用时 ${durationMs}ms`,
              senderMetadata(event, channel, startedAt, actionContext)
            )
          )
        }
      }
      const reportError = (error) => {
        if (actionContext) {
          reportActionOutcome(event, channel, startedAt, actionContext, 'failure', error, args)
          return
        }
        observeDiagnostic(() =>
          logger.error(`ipc.${channel}`, error, {
            ...senderMetadata(event, channel, startedAt),
            arguments: captureIpcArguments(args)
          })
        )
      }
      try {
        const result = handler(event, ...args)
        if (result && typeof result.then === 'function') {
          if (actionContext) {
            pendingTimer = setTimeout(
              () =>
                observeDiagnostic(() =>
                  writeLog({
                    level: 'warn',
                    scope: 'ipc.action',
                    eventName: actionContext.eventName,
                    actionId: actionContext.actionId,
                    phase: 'pending',
                    outcome: 'pending',
                    stage: 'ipc-handler',
                    durationMs: Date.now() - startedAt,
                    message: `请求仍未返回：${channel}`,
                    metadata: senderMetadata(event, channel, startedAt, actionContext)
                  })
                ),
              SLOW_IPC_MS
            )
            pendingTimer.unref?.()
          }
          return result.then(
            (value) => {
              clearPending()
              reportSlow()
              reportActionOutcome(
                event,
                channel,
                startedAt,
                actionContext,
                diagnosticOutcome(value),
                null,
                [],
                value,
                readWindowState(event, channel)
              )
              return value
            },
            (error) => {
              clearPending()
              reportError(error)
              throw error
            }
          )
        }
        reportSlow()
        reportActionOutcome(
          event,
          channel,
          startedAt,
          actionContext,
          diagnosticOutcome(result),
          null,
          [],
          result,
          readWindowState(event, channel)
        )
        return result
      } catch (error) {
        clearPending()
        reportError(error)
        throw error
      }
    })
  }
}

function wrapListener(channel, listener) {
  const wrapped = function loggedIpcListener(event, ...args) {
    const startedAt = Date.now()
    try {
      const result = listener(event, ...args)
      if (result && typeof result.then === 'function') {
        result.catch((error) => {
          logger.error(`ipc.${channel}`, error, {
            ...senderMetadata(event, channel, startedAt),
            arguments: captureIpcArguments(args)
          })
          queueMicrotask(() => {
            throw error
          })
        })
      }
      return result
    } catch (error) {
      logger.error(`ipc.${channel}`, error, {
        ...senderMetadata(event, channel, startedAt),
        arguments: captureIpcArguments(args)
      })
      throw error
    }
  }
  let channelMap = listenerWrappers.get(channel)
  if (!channelMap) {
    channelMap = new WeakMap()
    listenerWrappers.set(channel, channelMap)
  }
  channelMap.set(listener, wrapped)
  return wrapped
}

export const ipcMain = {
  handle(channel, handler) {
    electronIpcMain.handle(channel, wrapHandle(channel, handler))
    return this
  },
  handleOnce(channel, handler) {
    electronIpcMain.handleOnce(channel, wrapHandle(channel, handler))
    return this
  },
  removeHandler(channel) {
    electronIpcMain.removeHandler(channel)
    return this
  },
  on(channel, listener) {
    electronIpcMain.on(channel, wrapListener(channel, listener))
    return this
  },
  once(channel, listener) {
    electronIpcMain.once(channel, wrapListener(channel, listener))
    return this
  },
  removeListener(channel, listener) {
    const wrapped = listenerWrappers.get(channel)?.get(listener) || listener
    electronIpcMain.removeListener(channel, wrapped)
    listenerWrappers.get(channel)?.delete(listener)
    return this
  },
  removeAllListeners(channel) {
    electronIpcMain.removeAllListeners(channel)
    if (channel) listenerWrappers.delete(channel)
    else listenerWrappers.clear()
    return this
  }
}
