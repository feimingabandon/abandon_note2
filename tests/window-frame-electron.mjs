import assert from 'node:assert/strict'
import { app, BrowserWindow } from 'electron'
import { resolve } from 'node:path'
import koffi from 'koffi'

const GWL_STYLE = -16
const WS_THICKFRAME = 0x00040000

function readNativeHandle(window) {
  const buffer = window.getNativeWindowHandle()
  return process.arch === 'x64'
    ? buffer.readBigUInt64LE(0)
    : BigInt(buffer.readUInt32LE(0))
}

app.once('ready', async () => {
  let window = null
  let exitCode = 0

  try {
    const user32 = koffi.load('user32.dll')
    const getWindowLongPtr = user32.func('intptr_t GetWindowLongPtrW(void *hWnd, int nIndex)')
    const motionLibrary = koffi.load(resolve('native_blur', 'build', 'bin', 'blur_engine.dll'))
    const getMotionSnapshot = motionLibrary.func(
      'WindowMotion_GetSnapshotJson',
      'str',
      ['intptr_t']
    )
    const moveWindowPhysical = motionLibrary.func(
      'WindowMotion_MoveWindow',
      'int',
      ['intptr_t', 'int', 'int']
    )
    const isEdgeExposed = motionLibrary.func(
      'WindowMotion_IsEdgeExposed',
      'int',
      ['intptr_t', 'int']
    )

    window = new BrowserWindow({
      show: true,
      frame: false,
      transparent: true,
      thickFrame: false,
      width: 367,
      height: 734
    })
    await window.loadURL('data:text/html,<body style="margin:0"></body>')

    const style = BigInt.asUintN(64, BigInt(getWindowLongPtr(readNativeHandle(window), GWL_STYLE)))
    assert.equal(
      style & BigInt(WS_THICKFRAME),
      0n,
      `thickFrame:false must omit WS_THICKFRAME; actual style=0x${style.toString(16)}`
    )

    const hwnd = readNativeHandle(window)
    const initialBounds = window.getBounds()
    const initialContentBounds = window.getContentBounds()
    const initialNative = JSON.parse(getMotionSnapshot(hwnd))
    assert.equal(initialNative.window.valid, true)
    assert.equal(initialNative.monitor.valid, true)
    assert.ok([0, 1].includes(isEdgeExposed(hwnd, -1)))
    assert.ok([0, 1].includes(isEdgeExposed(hwnd, 1)))
    assert.equal(isEdgeExposed(hwnd, 0), 0)

    const assertSizeInvariant = () => {
      const currentBounds = window.getBounds()
      const currentContentBounds = window.getContentBounds()
      const currentNative = JSON.parse(getMotionSnapshot(hwnd))
      assert.equal(currentBounds.width, initialBounds.width)
      assert.equal(currentBounds.height, initialBounds.height)
      assert.equal(currentContentBounds.width, initialContentBounds.width)
      assert.equal(currentContentBounds.height, initialContentBounds.height)
      assert.equal(currentNative.window.width, initialNative.window.width)
      assert.equal(currentNative.window.height, initialNative.window.height)
      return currentNative
    }

    for (const side of ['left', 'right']) {
      for (let cycle = 0; cycle < 50; cycle += 1) {
        const hiddenX =
          side === 'left'
            ? initialNative.monitor.workLeft - initialNative.window.width - 5
            : initialNative.monitor.workRight + 5
        const visibleX =
          side === 'left'
            ? initialNative.monitor.workLeft
            : initialNative.monitor.workRight - initialNative.window.width

        assert.equal(moveWindowPhysical(hwnd, hiddenX, initialNative.window.top), 1)
        await new Promise((resolveFrame) => setTimeout(resolveFrame, 0))
        const hidden = assertSizeInvariant()
        if (side === 'left') {
          assert.ok(
            hidden.window.right <= initialNative.monitor.workLeft,
            `left-hidden window leaked ${hidden.window.right - initialNative.monitor.workLeft}px`
          )
        } else {
          assert.ok(
            hidden.window.left >= initialNative.monitor.workRight,
            `right-hidden window leaked ${initialNative.monitor.workRight - hidden.window.left}px`
          )
        }

        assert.equal(moveWindowPhysical(hwnd, visibleX, initialNative.window.top), 1)
        await new Promise((resolveFrame) => setTimeout(resolveFrame, 0))
        const visible = assertSizeInvariant()
        assert.equal(visible.window.left, visibleX)
      }
    }
    console.log('frameless window style and two-sided motion integration test passed')
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    window?.destroy()
    app.exit(exitCode)
  }
})
