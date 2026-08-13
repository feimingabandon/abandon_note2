export function assertMainWindowSender(event, getMainWindow, capability = '应用功能') {
  const mainWindow = getMainWindow?.()
  if (!mainWindow || mainWindow.isDestroyed?.() || event?.sender !== mainWindow.webContents) {
    throw new Error(`无权访问${capability}`)
  }
}

export function createMainWindowIpc(ipcMain, getMainWindow, capability = '应用功能') {
  return {
    handle(channel, handler) {
      ipcMain.handle(channel, (event, ...args) => {
        assertMainWindowSender(event, getMainWindow, capability)
        return handler(event, ...args)
      })
      return this
    }
  }
}
