import { ipcMain as electronIpcMain } from 'electron'
import { logger } from './logger.js'

const listenerWrappers = new Map()
const SLOW_IPC_MS = 2000
const MAX_IPC_ARGUMENT_TEXT = 100_000

function senderMetadata(event, channel, startedAt) {
  return {
    channel,
    durationMs: Date.now() - startedAt,
    webContentsId: event?.sender?.id,
    url: event?.sender?.getURL?.()
  }
}

function captureArguments(args) {
  try {
    const serialized = JSON.stringify(args)
    if (serialized.length <= MAX_IPC_ARGUMENT_TEXT) return args
    return {
      truncated: true,
      originalLength: serialized.length,
      preview: serialized.slice(0, MAX_IPC_ARGUMENT_TEXT)
    }
  } catch (error) {
    return {
      serializationFailed: true,
      error: error?.message || String(error),
      values: args.map((value) => String(value))
    }
  }
}

function wrapHandle(channel, handler) {
  return function loggedIpcHandle(event, ...args) {
    const startedAt = Date.now()
    const reportSlow = () => {
      const durationMs = Date.now() - startedAt
      if (durationMs >= SLOW_IPC_MS) {
        logger.warn(
          'ipc.slow',
          `${channel} 用时 ${durationMs}ms`,
          senderMetadata(event, channel, startedAt)
        )
      }
    }
    const reportError = (error) => {
      logger.error(`ipc.${channel}`, error, {
        ...senderMetadata(event, channel, startedAt),
        arguments: captureArguments(args)
      })
    }
    try {
      const result = handler(event, ...args)
      if (result && typeof result.then === 'function') {
        return result.then(
          (value) => {
            reportSlow()
            return value
          },
          (error) => {
            reportError(error)
            throw error
          }
        )
      }
      reportSlow()
      return result
    } catch (error) {
      reportError(error)
      throw error
    }
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
            arguments: captureArguments(args)
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
        arguments: captureArguments(args)
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
