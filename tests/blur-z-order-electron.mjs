import { app, BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import koffi from 'koffi'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/blur-z-order-electron.mjs',
  mode: 'electron-legacy-window-fixture',
  prefix: 'abandon-blur-z-order-',
  metadata: {
    realWindows: true,
    nativeBlur: true,
    productMainProcess: false,
    evidenceKind: 'native-window-state-json',
    pixelEvidence: false
  }
})
const { assert } = lifecycle
app.setPath('userData', lifecycle.root)

const HANDLE = koffi.pointer('HANDLE', koffi.opaque())
koffi.alias('HWND', HANDLE)
const GW_HWNDFIRST = 0
const GW_HWNDNEXT = 2
const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOACTIVATE = 0x0010
const OVERLAY_CLASS_NAME = 'BlurOverlayWindow'
koffi.struct('RECT', {
  left: 'int32_t',
  top: 'int32_t',
  right: 'int32_t',
  bottom: 'int32_t'
})

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
  let blurInitialized = false
  let destroyBlur = null
  let completed = false
  let failure = null
  let nativeWindowEvidence = null

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
    const getWindowRect = user32.func('int GetWindowRect(HWND hWnd, _Out_ RECT *bounds)')
    const blurDllPath =
      process.env.ABANDON_INTEGRATION_NATIVE_DLL ||
      resolve('native_blur', 'build', 'bin', 'blur_engine.dll')
    const blurLibrary = koffi.load(blurDllPath)
    const blurInit = blurLibrary.func('Blur_Init', 'int', ['intptr_t'])
    destroyBlur = blurLibrary.func('Blur_Destroy', 'void', [])
    const blurApplyConfig = blurLibrary.func('Blur_ApplyConfig', 'int', [
      'int',
      'float',
      'float',
      'float',
      'int',
      'int',
      'int',
      'float'
    ])
    const blurReSyncOrder = blurLibrary.func('Blur_ReSyncOrder', 'void', [])
    const blurFailureDetails = blurLibrary.func('Blur_GetLastFailureJson', 'str', [])
    assert.equal(blurApplyConfig(1, 20, 1.8, 12, 255, 255, 255, 0.3), 0)
    assert.equal(JSON.parse(blurFailureDetails()).stage, 'apply-config-not-ready')
    const blurIsZOrderSynchronized = blurLibrary.func('Blur_IsZOrderSynchronized', 'int', [])
    const moveWindowPhysical = blurLibrary.func('WindowMotion_MoveWindow', 'int', [
      'intptr_t',
      'int',
      'int'
    ])

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
    await Promise.all([
      mainWindow.loadURL(
        'data:text/html,<body style="margin:0;background:rgba(255,255,255,.2)"></body>'
      ),
      interloperWindow.loadURL('data:text/html,<body>interloper</body>')
    ])

    assert.equal(blurInit(nativeHandle(mainWindow)), 1)
    blurInitialized = true
    assert.equal(blurApplyConfig(1, 20, 1.8, 12, 255, 255, 255, 0.3), 1)

    let overlayWindow = null
    let candidate = getWindow(nativeHandle(mainWindow), GW_HWNDFIRST)
    while (candidate) {
      const classNameBuffer = Buffer.allocUnsafe(256)
      const classNameLength = getClassName(candidate, classNameBuffer, classNameBuffer.length)
      const className =
        classNameLength > 0 ? classNameBuffer.toString('ascii', 0, classNameLength) : ''

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
    assert.equal(blurApplyConfig(1, 20, 1.8, 12, 255, 255, 255, 0.3), 1)
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
    // WinEvent Hook 可能在本线程读取状态前就已经移除干扰窗口；这种即时自愈
    // 比显式兜底更强，不能被测试误判为 fixture 失败。尚未自愈时再触发统一
    // 去重队列，两个正确路径最终都必须恢复有效相邻层级。
    if (blurIsZOrderSynchronized() === 0) blurReSyncOrder()
    assert.equal(
      await waitUntil(() => blurIsZOrderSynchronized() === 1),
      true,
      'automatic or explicit z-order synchronization must remove an interposed window'
    )

    // 即使一个启用配置消息晚于 Electron.hide() 到达，也不能重新显示孤立背景层。
    mainWindow.hide()
    assert.equal(blurApplyConfig(1, 20, 1.8, 12, 255, 255, 255, 0.3), 1)
    assert.equal(
      await waitUntil(() => isWindowVisible(overlayWindow) === 0),
      true,
      'BlurOverlay must hide when its Electron parent is hidden'
    )

    mainWindow.show()
    assert.equal(blurApplyConfig(1, 20, 1.8, 12, 255, 255, 255, 0.3), 1)
    assert.equal(
      await waitUntil(
        () => isWindowVisible(overlayWindow) === 1 && blurIsZOrderSynchronized() === 1
      ),
      true,
      'BlurOverlay must recover after Electron is shown again'
    )

    // 贴边动画会在一个很短的时间窗口内连续调用原生移动。每次
    // WindowMotion_MoveWindow 返回时，Overlay 必须已经与 Electron 物理边界
    // 完全相等，不能依赖之后才取出的 PostMessage 追上下一帧。
    const parentBounds = {}
    const overlayBounds = {}
    for (let frame = 0; frame < 120; frame += 1) {
      const x = 220 + ((frame * 17) % 160)
      const y = 160 + ((frame * 11) % 120)
      assert.equal(
        moveWindowPhysical(nativeHandle(mainWindow), x, y),
        1,
        `synchronized native move must succeed at frame ${frame}`
      )
      assert.equal(getWindowRect(nativeHandle(mainWindow), parentBounds), 1)
      assert.equal(getWindowRect(overlayWindow, overlayBounds), 1)
      assert.deepEqual(
        overlayBounds,
        parentBounds,
        `BlurOverlay bounds must match Electron before frame ${frame} returns`
      )
    }
    assert.equal(
      await waitUntil(() => blurIsZOrderSynchronized() === 1),
      true,
      'synchronized native moves must preserve or promptly restore overlay z-order'
    )

    // This fixture asserts the Win32 overlay and physical geometry. Chromium's
    // compositor may have no capturable frame after the synchronous native moves;
    // record the actual tested native state before Blur_Destroy instead of asking
    // capturePage to provide unrelated pixel evidence during native teardown.
    const finalParentBounds = {}
    const finalOverlayBounds = {}
    if (
      getWindowRect(nativeHandle(mainWindow), finalParentBounds) !== 1 ||
      getWindowRect(overlayWindow, finalOverlayBounds) !== 1
    )
      throw new Error('Native evidence could not read the final window bounds')
    const snapshot = {
      version: 1,
      suite: 'tests/blur-z-order-electron.mjs',
      capturedAt: new Date().toISOString(),
      motionFrames: 120,
      parent: {
        hwnd: nativeHandle(mainWindow).toString(),
        visible: isWindowVisible(nativeHandle(mainWindow)) === 1,
        electronVisible: mainWindow.isVisible(),
        minimized: mainWindow.isMinimized(),
        url: mainWindow.webContents.getURL(),
        physicalBounds: finalParentBounds
      },
      overlay: {
        className: OVERLAY_CLASS_NAME,
        processId: process.pid,
        visible: isWindowVisible(overlayWindow) === 1,
        physicalBounds: finalOverlayBounds
      },
      zOrderSynchronized: blurIsZOrderSynchronized() === 1,
      limitations: ['Native visibility/geometry/z-order evidence; no Chromium bitmap or pixel QA']
    }
    if (
      !snapshot.parent.visible ||
      !snapshot.overlay.visible ||
      !snapshot.zOrderSynchronized ||
      ['left', 'top', 'right', 'bottom'].some(
        (side) => finalParentBounds[side] !== finalOverlayBounds[side]
      )
    )
      throw new Error('Native evidence no longer matches the verified visible synchronized windows')
    const artifact = 'native-window-snapshot.json'
    const content = JSON.stringify(snapshot, null, 2) + '\n'
    writeFileSync(join(process.env.ABANDON_TEST_EVIDENCE_DIR || lifecycle.root, artifact), content, {
      flag: 'wx'
    })
    nativeWindowEvidence = {
      artifact,
      sha256: createHash('sha256').update(content).digest('hex'),
      snapshot
    }

    console.log('blur visibility, synchronized geometry and z-order integration test passed')
    completed = true
  } catch (error) {
    console.error(error)
    failure = error
  } finally {
    await lifecycle.finish({
      completed,
      error: failure,
      summary: { nativeWindowEvidence },
      restore: () => {
        if (blurInitialized) destroyBlur?.()
      }
    })
  }
})
