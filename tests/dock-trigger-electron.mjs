import assert from 'node:assert/strict'
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { resolve } from 'node:path'
import koffi from 'koffi'

const REQUESTED_VISIBLE_WIDTH = 2
const TEST_HEIGHT = 240
const EVENT_TIMEOUT_MS = 3000

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

function waitForTriggerEnter() {
  return new Promise((resolveEvent, reject) => {
    const timeout = setTimeout(() => {
      ipcMain.removeListener('trigger-enter', onTriggerEnter)
      reject(new Error(`trigger-enter was not received within ${EVENT_TIMEOUT_MS}ms`))
    }, EVENT_TIMEOUT_MS)

    function onTriggerEnter(event) {
      clearTimeout(timeout)
      resolveEvent(event.sender.id)
    }

    ipcMain.once('trigger-enter', onTriggerEnter)
  })
}

function horizontalIntersectionWidth(bounds, workArea) {
  const left = Math.max(bounds.x, workArea.x)
  const right = Math.min(bounds.x + bounds.width, workArea.x + workArea.width)
  return Math.max(0, right - left)
}

function alignToEdge(side, requestedBounds, createdBounds) {
  const width = Math.max(REQUESTED_VISIBLE_WIDTH, createdBounds.width)
  const hiddenWidth = width - REQUESTED_VISIBLE_WIDTH
  return {
    x: side === 'left' ? requestedBounds.x - hiddenWidth : requestedBounds.x,
    y: requestedBounds.y,
    width,
    height: createdBounds.height
  }
}

app.once('ready', async () => {
  const windows = []
  let exitCode = 0
  let originalCursor = null

  try {
    const user32 = koffi.load('user32.dll')
    const setCursorPos = user32.func('int SetCursorPos(int X, int Y)')
    const mouseEvent = user32.func(
      'void mouse_event(uint32_t dwFlags, uint32_t dx, uint32_t dy, uint32_t dwData, uintptr_t dwExtraInfo)'
    )
    originalCursor = screen.getCursorScreenPoint()

    const display = screen.getPrimaryDisplay()
    const workArea = display.workArea
    const testY = workArea.y + Math.max(0, Math.floor((workArea.height - TEST_HEIGHT) / 2))
    const awayX = workArea.x + Math.floor(workArea.width / 2)
    const cursorY = testY + Math.floor(TEST_HEIGHT / 2)
    assert.equal(setCursorPos(awayX, cursorY), 1)
    await wait(100)

    for (const side of ['left', 'right']) {
      const requestedBounds = {
        x:
          side === 'left'
            ? workArea.x
            : workArea.x + workArea.width - REQUESTED_VISIBLE_WIDTH,
        y: testY,
        width: REQUESTED_VISIBLE_WIDTH,
        height: TEST_HEIGHT
      }

      const triggerWindow = new BrowserWindow({
        ...requestedBounds,
        show: false,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        focusable: false,
        hasShadow: false,
        webPreferences: {
          preload: resolve('out', 'preload', 'trigger.js'),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false
        }
      })
      windows.push(triggerWindow)

      const createdBounds = triggerWindow.getBounds()
      const expectedBounds = alignToEdge(side, requestedBounds, createdBounds)
      triggerWindow.setBounds(expectedBounds, false)
      triggerWindow.setAlwaysOnTop(true, 'screen-saver')
      triggerWindow.setIgnoreMouseEvents(true, { forward: true })
      await triggerWindow.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            '<!doctype html><html style="width:100%;height:100%"><body style="margin:0;width:100%;height:100%"></body></html>'
          )
      )
      const triggerEnter = waitForTriggerEnter()
      triggerWindow.showInactive()
      await wait(100)

      const actualBounds = triggerWindow.getBounds()
      console.log(side, { requestedBounds, createdBounds, expectedBounds, actualBounds })
      assert.deepEqual(
        actualBounds,
        expectedBounds,
        `${side} trigger bounds must remain at the corrected Windows-clamped bounds`
      )
      assert.equal(
        horizontalIntersectionWidth(actualBounds, workArea),
        REQUESTED_VISIBLE_WIDTH,
        `${side} trigger must expose exactly ${REQUESTED_VISIBLE_WIDTH}px inside the work area`
      )
      assert.equal(triggerWindow.isVisible(), true)
      assert.equal(triggerWindow.isAlwaysOnTop(), true)

      const edgeX =
        side === 'left' ? workArea.x + 1 : workArea.x + workArea.width - 1
      assert.equal(setCursorPos(edgeX, cursorY - 12), 1)
      for (let offset = -10; offset <= 12; offset += 2) {
        mouseEvent(0x0001, 0, 2, 0, 0)
        await wait(20)
      }
      const senderId = await triggerEnter
      assert.equal(senderId, triggerWindow.webContents.id)

    }

    console.log(
      'two-sided dock trigger integration test passed: corrected bounds, 2px exposure, and forwarded mousemove IPC'
    )
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    if (originalCursor) {
      try {
        const user32 = koffi.load('user32.dll')
        const setCursorPos = user32.func('int SetCursorPos(int X, int Y)')
        setCursorPos(originalCursor.x, originalCursor.y)
      } catch {
        // The test result is more useful than masking it with a cursor restore failure.
      }
    }
    for (const window of windows) window.destroy()
    ipcMain.removeAllListeners('trigger-enter')
    app.exit(exitCode)
  }
})
