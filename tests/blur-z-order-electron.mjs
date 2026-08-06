import assert from 'node:assert/strict'
import { app, BrowserWindow } from 'electron'
import { resolve } from 'node:path'
import koffi from 'koffi'

const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOACTIVATE = 0x0010

function nativeHandle(window) {
  const buffer = window.getNativeWindowHandle()
  return process.arch === 'x64' ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0))
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await wait(20)
  }
  return false
}

app.once('ready', async () => {
  const windows = []
  let blurInitialized = false
  let destroyBlur = null
  let exitCode = 0

  try {
    const user32 = koffi.load('user32.dll')
    const setWindowPos = user32.func(
      'int SetWindowPos(intptr_t hWnd, intptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)'
    )
    const blurLibrary = koffi.load(resolve('native_blur', 'build', 'bin', 'blur_engine.dll'))
    const blurInit = blurLibrary.func('Blur_Init', 'int', ['intptr_t'])
    destroyBlur = blurLibrary.func('Blur_Destroy', 'void', [])
    const blurApplyConfig = blurLibrary.func('Blur_ApplyConfig', 'void', [
      'int',
      'float',
      'float',
      'float'
    ])
    const blurReSyncOrder = blurLibrary.func('Blur_ReSyncOrder', 'void', [])
    const blurIsZOrderSynchronized = blurLibrary.func('Blur_IsZOrderSynchronized', 'int', [])

    const mainWindow = new BrowserWindow({
      show: true,
      frame: false,
      transparent: true,
      thickFrame: false,
      width: 360,
      height: 500
    })
    const interloperWindow = new BrowserWindow({ show: true, width: 240, height: 320 })
    windows.push(mainWindow, interloperWindow)
    await Promise.all([
      mainWindow.loadURL('data:text/html,<body style="margin:0;background:rgba(255,255,255,.2)"></body>'),
      interloperWindow.loadURL('data:text/html,<body>interloper</body>')
    ])

    assert.equal(blurInit(nativeHandle(mainWindow)), 1)
    blurInitialized = true
    blurApplyConfig(1, 20, 1.8, 12)
    blurReSyncOrder()
    assert.equal(
      await waitUntil(() => blurIsZOrderSynchronized() === 1),
      true,
      'BlurOverlay must initially be directly behind Electron'
    )

    assert.equal(
      setWindowPos(
        nativeHandle(interloperWindow),
        nativeHandle(mainWindow),
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
      ),
      1
    )
    assert.equal(
      blurIsZOrderSynchronized(),
      0,
      'the fixture must place a visible overlapping window between Electron and BlurOverlay'
    )

    // 显式兜底必须通过统一去重队列收敛为有效相邻层级。
    blurReSyncOrder()
    assert.equal(
      await waitUntil(() => blurIsZOrderSynchronized() === 1),
      true,
      'deduplicated z-order synchronization must remove an interposed window'
    )

    console.log('blur z-order repair integration test passed')
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    if (blurInitialized) {
      try {
        destroyBlur?.()
      } catch {
        exitCode = 1
      }
    }
    for (const window of windows) window.destroy()
    app.exit(exitCode)
  }
})
