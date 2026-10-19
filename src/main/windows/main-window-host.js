/** The sole owner of the main BrowserWindow identity. Session policy stays with application wiring. */
export function createMainWindowHost({ BrowserWindow }) {
  let current = null
  let generation = 0
  const installed = new WeakSet()
  const isCurrent = (window) => Boolean(window && window === current)
  return {
    getWindow: () => current,
    isCurrent,
    readIdentity: () =>
      Object.freeze({
        generation,
        windowId: current?.id ?? null,
        webContentsId: current?.webContents?.id ?? null
      }),
    create(options) {
      if (current && !current.isDestroyed()) throw new Error('主窗口已存在')
      const window = new BrowserWindow(options)
      current = window
      generation++
      return window
    },
    load(window, location) {
      if (!isCurrent(window) || window.isDestroyed()) throw new Error('主窗口不可用')
      return location.type === 'url'
        ? window.loadURL(location.value)
        : window.loadFile(location.value)
    },
    installClosedCleanup(window, cleanup) {
      if (!isCurrent(window) || installed.has(window)) throw new Error('主窗口生命周期已安装或失效')
      installed.add(window)
      window.once('closed', () => {
        if (!isCurrent(window)) return
        try {
          cleanup(window)
        } finally {
          if (isCurrent(window)) current = null
        }
      })
    }
  }
}
