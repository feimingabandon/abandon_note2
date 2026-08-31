import assert from 'node:assert/strict'
import { app, BrowserWindow } from 'electron'
import { resolve } from 'node:path'
import koffi from 'koffi'

const GW_HWNDNEXT = 2
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

async function waitUntil(predicate, timeoutMs = 2500) {
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
    const getWindow = user32.func('intptr_t GetWindow(intptr_t hWnd, uint32_t command)')
    const isAbove = (upper, lower) => {
      let candidate = getWindow(upper, GW_HWNDNEXT)
      while (candidate) {
        if (BigInt(candidate) === BigInt(lower)) return true
        candidate = getWindow(candidate, GW_HWNDNEXT)
      }
      return false
    }

    const dllPath =
      process.env.ABANDON_INTEGRATION_NATIVE_DLL ||
      resolve('native_blur', 'build', 'bin', 'blur_engine.dll')
    const native = koffi.load(dllPath)
    const setBottom = native.func('WindowZOrder_SetBottom', 'int', ['intptr_t', 'int'])
    const reassert = native.func('WindowZOrder_Reassert', 'int', ['intptr_t'])
    const getStatusJson = native.func('WindowZOrder_GetStatusJson', 'str', ['intptr_t'])
    const blurInit = native.func('Blur_Init', 'int', ['intptr_t'])
    destroyBlur = native.func('Blur_Destroy', 'void', [])
    const blurApplyConfig = native.func('Blur_ApplyConfig', 'void', [
      'int',
      'float',
      'float',
      'float'
    ])

    const mainWindow = new BrowserWindow({
      show: true,
      frame: false,
      transparent: true,
      thickFrame: false,
      x: 260,
      y: 180,
      width: 360,
      height: 460
    })
    const ordinaryWindow = new BrowserWindow({
      show: true,
      x: 300,
      y: 220,
      width: 320,
      height: 360
    })
    windows.push(mainWindow, ordinaryWindow)
    await Promise.all([
      mainWindow.loadURL('data:text/html,<body style="background:#dbeafe">bottom target</body>'),
      ordinaryWindow.loadURL('data:text/html,<body>ordinary window</body>')
    ])

    const mainHwnd = nativeHandle(mainWindow)
    const ordinaryHwnd = nativeHandle(ordinaryWindow)
    const getStatus = () => JSON.parse(getStatusJson(mainHwnd))

    assert.equal(setBottom(mainHwnd, 1), 1, 'native bottom mode must attach on Electron UI thread')
    const initiallyAnchored = await waitUntil(
      () => getStatus().anchored && isAbove(ordinaryHwnd, mainHwnd)
    )
    if (!initiallyAnchored) {
      console.error('initial always-bottom diagnostics', {
        status: getStatus(),
        mainHwnd: String(mainHwnd),
        ordinaryHwnd: String(ordinaryHwnd),
        ordinaryAboveMain: isAbove(ordinaryHwnd, mainHwnd)
      })
    }
    assert.equal(
      initiallyAnchored,
      true,
      'ordinary windows must remain above the bottom-anchored main window'
    )
    assert.equal(getStatus().desktopWindowsAbove, 0, 'desktop hosts must stay below the main window')
    assert.ok(getStatus().desktopWindowsBelow > 0, 'the test must observe a Windows desktop host')

    // 模拟 Electron focus()/moveTop() 或快速双击触发的主动提层。Subclass 必须在
    // WINDOWPOSCHANGING 阶段阻止前移，而不是等 JS focus 事件后再补救。
    assert.equal(
      setWindowPos(mainHwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE),
      1
    )
    mainWindow.focus()
    assert.equal(
      await waitUntil(() => getStatus().anchored && isAbove(ordinaryHwnd, mainHwnd)),
      true,
      'focus and explicit HWND_TOP requests must not raise an always-bottom window'
    )

    assert.equal(blurInit(mainHwnd), 1)
    blurInitialized = true
    blurApplyConfig(1, 18, 1.5, 12)
    assert.equal(reassert(mainHwnd), 1)
    assert.equal(
      await waitUntil(() => {
        const status = getStatus()
        return status.anchored && status.overlayValid && status.overlayBehind
      }),
      true,
      'BlurOverlay must stay behind the bottom-anchored Electron window'
    )

    assert.equal(setBottom(mainHwnd, 0), 1)
    assert.equal(
      await waitUntil(() => isAbove(mainHwnd, ordinaryHwnd)),
      true,
      'disabling bottom mode must immediately restore normal Electron z-order control'
    )
    assert.equal(getStatus().enabled, false)

    console.log('always-bottom focus guard and blur adjacency integration test passed')
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
