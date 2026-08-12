import assert from 'node:assert/strict'
import { app, BrowserWindow } from 'electron'
import { resolve } from 'node:path'
import koffi from 'koffi'

const HANDLE = koffi.pointer('HANDLE', koffi.opaque())
const HWND = koffi.alias('HWND', HANDLE)
const GW_HWNDFIRST = 0
const GW_HWNDNEXT = 2
const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOACTIVATE = 0x0010
const OVERLAY_CLASS_NAME = 'BlurOverlayWindow'

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
      'int SetWindowPos(HWND hWnd, HWND hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)'
    )
    const getWindow = user32.func('HWND GetWindow(HWND hWnd, uint32_t command)')
    const getClassName = user32.func(
      'int GetClassNameA(HWND hWnd, _Out_ uint8_t *className, int maxCount)'
    )
    const getWindowThreadProcessId = user32.func(
      'uint32_t GetWindowThreadProcessId(HWND hWnd, _Out_ uint32_t *processId)'
    )
    const isWindowVisible = user32.func('int IsWindowVisible(HWND hWnd)')
    const blurDllPath = process.env.ABANDON_INTEGRATION_NATIVE_DLL ||
      resolve('native_blur', 'build', 'bin', 'blur_engine.dll')
    const blurLibrary = koffi.load(blurDllPath)
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
      show: false,
      frame: false,
      transparent: true,
      thickFrame: false,
      x: 240,
      y: 180,
      width: 360,
      height: 500
    })
    const interloperWindow = new BrowserWindow({
      show: true,
      x: 240,
      y: 180,
      width: 240,
      height: 320
    })
    windows.push(mainWindow, interloperWindow)
    await Promise.all([
      mainWindow.loadURL('data:text/html,<body style="margin:0;background:rgba(255,255,255,.2)"></body>'),
      interloperWindow.loadURL('data:text/html,<body>interloper</body>')
    ])

    assert.equal(blurInit(nativeHandle(mainWindow)), 1)
    blurInitialized = true
    blurApplyConfig(1, 20, 1.8, 12)

    let overlayWindow = null
    let candidate = getWindow(nativeHandle(mainWindow), GW_HWNDFIRST)
    while (candidate) {
      const classNameBuffer = Buffer.allocUnsafe(256)
      const classNameLength = getClassName(candidate, classNameBuffer, classNameBuffer.length)
      const className = classNameLength > 0
        ? classNameBuffer.toString('ascii', 0, classNameLength)
        : ''

      const ownerProcessId = [null]
      getWindowThreadProcessId(candidate, ownerProcessId)
      if (className === OVERLAY_CLASS_NAME && ownerProcessId[0] === process.pid) {
        overlayWindow = candidate
        break
      }
      candidate = getWindow(candidate, GW_HWNDNEXT)
    }
    assert.ok(overlayWindow, 'BlurOverlay must be created during native initialization')
    await wait(100)
    assert.equal(
      isWindowVisible(overlayWindow),
      0,
      'BlurOverlay must stay hidden while Electron is show:false'
    )

    // 生产默认值会在 renderer-ready 之前恢复置顶状态；Overlay 必须继续隐藏，
    // 等 Electron 真正显示后再随完整配置进入相同 band 并原子显示。
    mainWindow.setAlwaysOnTop(true, 'pop-up-menu')
    blurReSyncOrder()
    mainWindow.show()
    blurApplyConfig(1, 20, 1.8, 12)
    assert.equal(
      await waitUntil(
        () => isWindowVisible(overlayWindow) === 1 && blurIsZOrderSynchronized() === 1
      ),
      true,
      'BlurOverlay must become visible directly behind a topmost Electron window'
    )

    mainWindow.setAlwaysOnTop(false)
    blurReSyncOrder()
    assert.equal(
      await waitUntil(() => blurIsZOrderSynchronized() === 1),
      true,
      'BlurOverlay must follow Electron back to the non-topmost band'
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

    // 即使一个启用配置消息晚于 Electron.hide() 到达，也不能重新显示孤立背景层。
    mainWindow.hide()
    blurApplyConfig(1, 20, 1.8, 12)
    assert.equal(
      await waitUntil(() => isWindowVisible(overlayWindow) === 0),
      true,
      'BlurOverlay must hide when its Electron parent is hidden'
    )

    mainWindow.show()
    blurApplyConfig(1, 20, 1.8, 12)
    assert.equal(
      await waitUntil(
        () => isWindowVisible(overlayWindow) === 1 && blurIsZOrderSynchronized() === 1
      ),
      true,
      'BlurOverlay must recover after Electron is shown again'
    )

    console.log('blur visibility lifecycle and z-order repair integration test passed')
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
