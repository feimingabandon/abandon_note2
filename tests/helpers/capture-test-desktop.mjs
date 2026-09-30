import { BrowserWindow, screen } from 'electron'

// Cover every monitor with test pixels before exercising the native capture
// backend. These windows never load application data or external content.
export async function coverCaptureTestDesktop() {
  const windows = []
  try {
    for (const display of screen.getAllDisplays()) {
      const window = new BrowserWindow({
        ...display.bounds,
        frame: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        focusable: false,
        backgroundColor: '#245080',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      })
      windows.push(window)
      await window.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            '<body style="margin:0;background:#245080;color:white;font:32px sans-serif;padding:80px;box-sizing:border-box">Abandon Capture · Synthetic test canvas<div style="margin-top:60px;width:480px;height:240px;background:linear-gradient(90deg,#e13c39,#ffb800,#0071e3)"></div></body>'
          )
      )
      window.setBounds(display.bounds)
      window.showInactive()
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
    return () => windows.forEach((window) => !window.isDestroyed() && window.destroy())
  } catch (error) {
    windows.forEach((window) => !window.isDestroyed() && window.destroy())
    throw error
  }
}
