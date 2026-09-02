export function assertMainWindowSender(event, getMainWindow, capability = '应用功能') {
  const resolved = getMainWindow?.()
  const windows = (Array.isArray(resolved) ? resolved : [resolved]).filter(Boolean)
  const authorized = windows.some(
    (window) => !window.isDestroyed?.() && event?.sender === window.webContents
  )
  if (!authorized) {
    throw new Error(`无权访问${capability}`)
  }
}

export function createMainWindowIpc(ipcMain, getMainWindow, capability = '应用功能') {
  return {
    handle(channel, handler, { onStaleSender = null } = {}) {
      ipcMain.handle(channel, (event, ...args) => {
        try {
          assertMainWindowSender(event, getMainWindow, capability)
        } catch (error) {
          if (onStaleSender) return onStaleSender(event, ...args)
          throw error
        }
        return handler(event, ...args)
      })
      return this
    }
  }
}
