import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { app } from 'electron'
import { ScreenshotService } from '../src/main/services/ScreenshotService.js'
import { flushLogs } from '../src/main/logging/logger.js'

app.setPath(
  'userData',
  process.env.ABANDON_TEST_USER_DATA || mkdtempSync(join(tmpdir(), 'screenshot-recovery-'))
)
app.on('window-all-closed', () => {})
const ipc = new EventEmitter()
const handlers = new Map()
ipc.handle = (name, fn) => handlers.set(name, fn)
ipc.removeHandler = (name) => handlers.delete(name)
const sender = { isDestroyed: () => false, send: () => {} }
let startCount = 0
let endCount = 0
const service = new ScreenshotService({
  ipcMain: ipc,
  preloadPath: resolve('out/preload/screenshot.js'),
  getMainWindow: () => ({ webContents: sender }),
  onCaptureStart: () => startCount++,
  onCaptureEnd: () => endCount++
})
const timeout = setTimeout(() => {
  console.error('screenshot recovery timed out')
  app.exit(1)
}, 20000)
app.whenReady().then(async () => {
  let exitCode = 0
  try {
    service.initialize()
    for (const action of ['crash', 'cancel', 'dispose']) {
      const pending = handlers.get('screenshot:capture')({ sender })
      const overlay = service.window
      await new Promise((done) => overlay.webContents.once('did-finish-load', done))
      // No desktop capture is requested: only exercise the overlay lifecycle.
      if (action === 'crash') overlay.webContents.forcefullyCrashRenderer()
      else if (action === 'cancel') ipc.emit('screenshot:cancel', { sender: overlay.webContents })
      else service.dispose()
      assert.equal(await pending, null)
      assert.equal(overlay.isDestroyed(), true, `${action}: overlay remained alive`)
      assert.equal(service.window, null)
      assert.equal(ipc.listenerCount('screenshot:confirm'), 0)
      assert.equal(ipc.listenerCount('screenshot:cancel'), 0)
      assert.equal(endCount, startCount, `${action}: capture suspension leaked`)
    }
    assert.equal(endCount, 3)
    console.log('screenshot renderer crash, recapture, cancel and dispose recovery passed')
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    clearTimeout(timeout)
    service.dispose()
    await flushLogs()
    app.exit(exitCode)
  }
})
