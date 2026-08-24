import { app, BrowserWindow } from 'electron'
import koffi from 'koffi'

app.commandLine.appendSwitch('disable-gpu')
app.on('window-all-closed', () => {})

async function main() {
  const mode = process.argv.at(-2)
  const bounds = JSON.parse(process.argv.at(-1))
  const window = new BrowserWindow({
    ...bounds,
    show: false,
    frame: true,
    thickFrame: true,
    backgroundColor: '#101010'
  })
  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent('<title>Abandon Note dock foreground fixture</title>')}`
  )
  if (mode === 'fullscreen' || mode === 'fullscreen-pulse') window.setFullScreen(true)
  else if (mode === 'maximized') window.maximize()
  else throw new Error(`未知前台窗口测试模式：${mode}`)
  window.show()
  window.focus()

  const user32 = koffi.load('user32.dll')
  const setForegroundWindow = user32.func('int SetForegroundWindow(intptr_t hWnd)')
  const handle = window.getNativeWindowHandle()
  const hwnd = handle.length >= 8 ? Number(handle.readBigUInt64LE()) : handle.readUInt32LE()
  setForegroundWindow(hwnd)

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  process.stdout.write(
    `FOREGROUND_READY:${mode}:${window.isFullScreen()}:${window.isMaximized()}\n`
  )
  if (mode === 'fullscreen-pulse') {
    setTimeout(() => {
      window.setFullScreen(false)
      setTimeout(() => {
        window.setFullScreen(true)
        window.show()
        window.focus()
        setForegroundWindow(hwnd)
        process.stdout.write('FULLSCREEN_PULSE_DONE\n')
      }, 100)
    }, 350)
  }
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (value) => {
    if (value.includes('quit')) app.quit()
  })
}

app
  .whenReady()
  .then(main)
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
