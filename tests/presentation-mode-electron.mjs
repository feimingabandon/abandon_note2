import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain, powerMonitor, screen } from 'electron'
import koffi from 'koffi'
import { compactBoundsFromAnchor } from '../src/shared/window-compact-geometry.js'
import { NATIVE_ABI_VERSION } from '../src/shared/native-abi-version.js'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'
import { dismissStartupShortcutNotice } from './helpers/startup-shortcut-notice.mjs'

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/presentation-mode-electron.mjs',
  mode: 'electron-ready-real-app-presentation-mode',
  prefix: 'abandon-presentation-mode-',
  metadata: {
    realWindows: true,
    realDiskDatabase: true,
    nativeDCompVerified: true,
    chromiumGpuDisabled: true,
    syntheticPointerEvents: true,
    nativePointerDrag: false,
    mainProcessRestart: false,
    syntheticPowerEvents: true,
    syntheticDisplayEvents: true,
    realSystemResume: false,
    realDisplayTopologyChange: false
  },
  timeoutMs: 60000
})
const { assert, root } = lifecycle
// Drop only the selected actual renderer ACK; all other IPC and native work stay real.
let dropRendererAck = false
const droppedAcks = []
let holdRendererAck = false
const heldRendererAcks = []
const originalOn = ipcMain.on.bind(ipcMain)
ipcMain.on = (channel, listener) =>
  originalOn(
    channel,
    channel === 'presentation-mode:renderer-ready'
      ? (event, payload) => {
          if (dropRendererAck) {
            droppedAcks.push(payload?.operationId)
            return
          }
          if (holdRendererAck) {
            heldRendererAcks.push(() => listener(event, payload))
            return
          }
          return listener(event, payload)
        }
      : listener
  )
app.setPath('userData', root)
// CI/沙箱中的 Chromium GPU 子进程缺少运行库；DComp Overlay 仍由原生 DLL 独立验证。
app.commandLine.appendSwitch('disable-gpu')
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')

const databasePath = join(root, 'app.db')
const database = new Database(databasePath)
database.exec(`CREATE TABLE app_settings (
  window_name TEXT NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
  remark TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER,
  PRIMARY KEY (window_name, key))`)
const insert = database.prepare(
  'INSERT INTO app_settings (window_name,type,key,value) VALUES (?,?,?,?)'
)
for (const [scope, type, key, value] of [
  ['application', 'application', 'active_view', 'list'],
  ['application', 'remote', 'receive_notices', 'false'],
  ['application', 'remote', 'upload_device_info', 'false'],
  ['application', 'onboarding', 'first_use_notice_version', '1'],
  ['main', 'system', 'blur_enabled', 'true'],
  ['month', 'system', 'blur_enabled', 'true']
]) {
  insert.run(scope, type, key, value)
}
database.close()

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))
async function until(check, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await check()
    if (result) {
      assert.ok(true, label)
      return result
    }
    await wait(30)
  }
  assert.fail(label)
}

const native = koffi.load(process.env.ABANDON_INTEGRATION_NATIVE_DLL)
const nativeAbi = native.func('AbandonNative_GetAbiVersion', 'int', [])
const blurHealthy = native.func('Blur_IsHealthy', 'int', [])
const syncBlurGeometry = native.func('Blur_SyncGeometryAndWait', 'int', ['int'])

app.once('ready', () => void run())
const require = createRequire(import.meta.url)
require(resolve('out/main/index.js'))
const mainChunk = readdirSync(resolve('out/main/chunks')).find((name) =>
  /^index-[\w-]+\.js$/.test(name)
)
assert.ok(mainChunk, 'main process chunk missing')
require(resolve('out/main/chunks', mainChunk))

async function run() {
  let completed = false,
    failure = null,
    current
  try {
    assert.equal(nativeAbi(), NATIVE_ABI_VERSION, 'native blur ABI was not rebuilt')
    const hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
    assert.ok(hooks, 'integration hooks missing')

    const window = await until(
      () =>
        BrowserWindow.getAllWindows().find(
          (candidate) =>
            !candidate.isDestroyed() && candidate.webContents.getURL().endsWith('/index.html')
        ),
      'list window missing'
    )
    current = window
    await until(() => window.isVisible(), 'list window never became visible')
    const js = (code) => window.webContents.executeJavaScript(code)
    await until(() => js("Boolean(document.querySelector('.app-titlebar'))"), 'titlebar missing')
    await dismissStartupShortcutNotice(window)
    await js('window.api.setBlurConfig({ enabled: true, cornerRadius: 26 })')
    await until(() => hooks.getBlurRuntimeHealth()?.healthy, 'native blur did not initialize')
    await until(
      () =>
        js(
          "getComputedStyle(document.documentElement).getPropertyValue('--window-radius').trim() === '26px'"
        ),
      'shared corner radius did not reach the renderer'
    )
    await js("window.api.setSettingValue('window.compactFontSize', 23)")
    await until(
      () =>
        js(
          "getComputedStyle(document.documentElement).getPropertyValue('--compact-content-font-size').trim() === '23px'"
        ),
      'shared compact font size did not reach the renderer'
    )

    const originalWindow = window
    const originalHandle = window.getNativeWindowHandle().toString('hex')
    const originalBounds = window.getBounds()
    const titlebarCenterOffsetY = await js(`(() => {
      const rect = document.querySelector('.app-titlebar').getBoundingClientRect()
      return Math.round(rect.top + rect.height / 2)
    })()`)
    const anchor = {
      x: originalBounds.x + Math.round(originalBounds.width * 0.68),
      y: originalBounds.y + 24
    }
    const workArea = screen.getDisplayNearestPoint(anchor).workArea

    dropRendererAck = true
    try {
      await assert.rejects(() => hooks.enterCompactPresentation(anchor), /渲染就绪超时/)
    } finally {
      dropRendererAck = false
    }
    assert.ok(droppedAcks.length > 0, 'failure injection did not intercept a real renderer ACK')
    await until(
      () => hooks.getPresentationModeState().operation === null && window.isVisible(),
      'ACK timeout did not restore a visible idle window'
    )
    assert.equal(hooks.getPresentationModeState().mode, 'expanded')
    assert.deepEqual(window.getBounds(), originalBounds)
    assert.equal(window.getNativeWindowHandle().toString('hex'), originalHandle)
    assert.equal(hooks.getDockRuntimeState().interactionSuspendCount, 0)
    assert.equal(blurHealthy(), 1, 'blur became unhealthy after ACK recovery')
    assert.equal(syncBlurGeometry(1_000), 1, 'blur geometry did not match ACK recovery')
    await until(
      () => js("Boolean(document.querySelector('.app-titlebar'))"),
      'ACK recovery did not restore expanded UI'
    )

    await js(
      `document.querySelector('.app-titlebar-interaction-surface').dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          screenX: ${anchor.x},
          screenY: ${anchor.y}
        })
      )`
    )
    await until(
      () =>
        hooks.getPresentationModeState().mode === 'compact' &&
        hooks.getPresentationModeState().operation === null,
      'titlebar double-click did not enter compact mode'
    )
    assert.equal(BrowserWindow.getAllWindows().includes(originalWindow), true)
    assert.equal(window.getNativeWindowHandle().toString('hex'), originalHandle)
    assert.deepEqual(hooks.getPresentationModeState().operation, null)
    assert.equal(hooks.getPresentationModeState().mode, 'compact')
    assert.equal(
      hooks.getDockRuntimeState().interactionSuspendCount,
      1,
      'compact owner must retain exactly one dock suspension'
    )
    assert.deepEqual(
      window.getBounds(),
      compactBoundsFromAnchor({ anchor, size: { width: 180, height: 48 }, workArea })
    )
    assert.equal(await js("Boolean(document.querySelector('.compact-island'))"), true)
    assert.equal(
      await js(
        "getComputedStyle(document.querySelector('.compact-island__content')).justifyContent"
      ),
      'flex-start'
    )
    assert.equal(
      await js("getComputedStyle(document.querySelector('.compact-island__text')).fontSize"),
      '23px'
    )
    await until(
      () =>
        js(
          "document.querySelector('.compact-island__content').getAnimations().some(animation => animation.animationName.includes('compact-island-content-enter'))"
        ),
      'compact content entrance animation did not start after commit'
    )
    assert.equal(
      await js("getComputedStyle(document.querySelector('.compact-island')).borderTopLeftRadius"),
      '26px'
    )
    assert.equal(
      await js(
        "getComputedStyle(document.querySelector('.window-presentation__expanded')).display"
      ),
      'none'
    )
    assert.equal(blurHealthy(), 1, 'blur became unhealthy after compact commit')
    assert.equal(syncBlurGeometry(1_000), 1, 'blur geometry did not match compact bounds')

    await js(
      `document.querySelector('.rh-se').dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerId: 41, button: 0, screenX: 100, screenY: 100
      }))`
    )
    await wait(100)
    await js(
      `document.querySelector('.resize-handles').dispatchEvent(new PointerEvent('lostpointercapture', {
        bubbles: true, pointerId: 41, button: 0, buttons: 1, screenX: 104, screenY: 103
      }))`
    )
    for (const [dx, dy] of [
      [24, 4],
      [48, 8],
      [76, 16]
    ]) {
      await js(
        `window.dispatchEvent(new PointerEvent('pointermove', {
          pointerId: 41, buttons: 1, screenX: ${100 + dx}, screenY: ${100 + dy}
        }))`
      )
      await until(
        () => window.getBounds().width === 180 + dx && window.getBounds().height === 48 + dy,
        `compact resize step ${dx}/${dy} did not reach the real window`
      )
    }
    await js(
      `window.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 41, button: 0, screenX: 176, screenY: 116
      }))`
    )
    await until(
      () => window.getBounds().width === 256 && window.getBounds().height === 64,
      'compact resize did not reach the real window'
    )
    const compactSettings = await js('window.api.getSettingsSnapshot().then(s => s.values.window)')
    assert.equal(
      hooks.getDockRuntimeState().interactionSuspendCount,
      1,
      'compact resize leaked an additional dock suspension'
    )
    assert.equal(compactSettings.compactWidth, 256)
    assert.equal(compactSettings.compactHeight, 64)
    const persistedDatabase = new Database(databasePath, { readonly: true })
    const persisted = persistedDatabase
      .prepare(
        "SELECT key, value FROM app_settings WHERE window_name='application' AND type='presentation' ORDER BY key"
      )
      .all()
    persistedDatabase.close()
    assert.deepEqual(persisted, [
      { key: 'compact_font_size', value: '23' },
      { key: 'compact_height', value: '64' },
      { key: 'compact_width', value: '256' }
    ])
    assert.equal(syncBlurGeometry(1_000), 1, 'blur geometry did not follow compact resize')

    // 尺寸也可能由 Renderer IPC 以外的真实窗口路径改变。主进程必须直接监听
    // BrowserWindow resize，在没有 window-resize:end 时仍以真实边界完成保存。
    const idlePersistBounds = { ...window.getBounds(), width: 272, height: 68 }
    window.setBounds(idlePersistBounds)
    await until(
      () => window.getBounds().width === 272 && window.getBounds().height === 68,
      'compact resize fallback did not reach the real window'
    )
    await until(async () => {
      const settings = await js('window.api.getSettingsSnapshot().then(s => s.values.window)')
      return settings.compactWidth === 272 && settings.compactHeight === 68
    }, 'compact resize fallback was not persisted without a pointer finish event')
    const idlePersistDatabase = new Database(databasePath, { readonly: true })
    const idlePersisted = idlePersistDatabase
      .prepare(
        "SELECT key, value FROM app_settings WHERE window_name='application' AND type='presentation' ORDER BY key"
      )
      .all()
    idlePersistDatabase.close()
    assert.deepEqual(idlePersisted, [
      { key: 'compact_font_size', value: '23' },
      { key: 'compact_height', value: '68' },
      { key: 'compact_width', value: '272' }
    ])

    // Exercise the application's registered power callbacks and topology hook;
    // the operating system does not actually sleep or change displays here.
    const beforeDisplayRecovery = { ...window.getBounds() }
    powerMonitor.emit('resume')
    powerMonitor.emit('unlock-screen')
    hooks.handleDisplayTopologyChange({
      eventName: 'display-metrics-changed',
      displayId: screen.getDisplayMatching(beforeDisplayRecovery).id
    })
    await wait(400) // Includes a delayed Electron resize echo and the 300 ms size save.
    assert.equal(hooks.getPresentationModeState().mode, 'compact')
    assert.equal(hooks.getPresentationModeState().operation, null)
    assert.deepEqual(
      window.getBounds(),
      beforeDisplayRecovery,
      'power/display recovery expanded the compact HWND'
    )
    assert.equal(window.getNativeWindowHandle().toString('hex'), originalHandle)
    assert.equal(hooks.getDockRuntimeState().interactionSuspendCount, 1)
    assert.equal(blurHealthy(), 1, 'blur became unhealthy after compact display recovery')
    assert.equal(
      syncBlurGeometry(1_000),
      1,
      'native blur geometry did not follow compact display recovery'
    )
    const recoveryDatabase = new Database(databasePath, { readonly: true })
    try {
      assert.deepEqual(
        recoveryDatabase
          .prepare(
            "SELECT key, value FROM app_settings WHERE window_name='application' AND type='presentation' ORDER BY key"
          )
          .all(),
        idlePersisted,
        'automatic recovery overwrote durable compact dimensions'
      )
      assert.deepEqual(
        recoveryDatabase
          .prepare(
            "SELECT key, value FROM app_settings WHERE window_name='main' AND type='geometry' ORDER BY key"
          )
          .all(),
        [
          { key: 'height', value: String(originalBounds.height) },
          { key: 'pos_x', value: String(originalBounds.x) },
          { key: 'pos_y', value: String(originalBounds.y) },
          { key: 'width', value: String(originalBounds.width) }
        ],
        'compact display recovery overwrote expanded geometry'
      )
    } finally {
      recoveryDatabase.close()
    }

    // 灵动岛拖动复用贴边窗口移动后端，但贴边补偿计时器不得把当前小窗口
    // 的位置和尺寸回写到 main/geometry。
    const compactBeforeDrag = window.getBounds()
    const compactDragOrigin = {
      x: compactBeforeDrag.x + 20,
      y: compactBeforeDrag.y + 20
    }
    const compactDragTarget = {
      x: compactDragOrigin.x + 48,
      y: compactDragOrigin.y + 32
    }
    await js(`(() => {
      const island = document.querySelector('.compact-island')
      island.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerId: 57, button: 0, buttons: 1,
        screenX: ${compactDragOrigin.x}, screenY: ${compactDragOrigin.y}
      }))
      island.dispatchEvent(new PointerEvent('lostpointercapture', {
        bubbles: true, pointerId: 57, button: 0, buttons: 1,
        screenX: ${compactDragOrigin.x + 3}, screenY: ${compactDragOrigin.y + 2}
      }))
    })()`)
    await wait(100)
    await js(`window.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 57, button: 0, buttons: 1,
      screenX: ${compactDragTarget.x}, screenY: ${compactDragTarget.y}
    }))`)
    await until(() => {
      const moved = window.getBounds()
      return moved.x === compactBeforeDrag.x + 48 && moved.y === compactBeforeDrag.y + 32
    }, 'compact drag did not move the real window')
    await js(`window.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 57, button: 0, buttons: 0,
      screenX: ${compactDragTarget.x}, screenY: ${compactDragTarget.y}
    }))`)
    await wait(1_200)
    assert.equal(
      hooks.getDockRuntimeState().interactionSuspendCount,
      1,
      'compact drag leaked an additional dock suspension'
    )
    const geometryDatabase = new Database(databasePath, { readonly: true })
    const mainGeometry = geometryDatabase
      .prepare(
        "SELECT key, value FROM app_settings WHERE window_name='main' AND type='geometry' ORDER BY key"
      )
      .all()
    geometryDatabase.close()
    assert.deepEqual(mainGeometry, [
      { key: 'height', value: String(originalBounds.height) },
      { key: 'pos_x', value: String(originalBounds.x) },
      { key: 'pos_y', value: String(originalBounds.y) },
      { key: 'width', value: String(originalBounds.width) }
    ])

    const expandAnchor = {
      x:
        workArea.x +
        originalBounds.width / 2 +
        Math.min(80, Math.max(0, workArea.width - originalBounds.width)),
      y: workArea.y + titlebarCenterOffsetY
    }
    await js(`document.querySelector('.compact-island').dispatchEvent(
      new MouseEvent('dblclick', {
        bubbles: true,
        screenX: ${expandAnchor.x},
        screenY: ${expandAnchor.y}
      })
    )`)
    await until(
      () =>
        hooks.getPresentationModeState().mode === 'expanded' &&
        hooks.getPresentationModeState().operation === null,
      'compact island double-click did not restore expanded mode'
    )
    assert.equal(hooks.getPresentationModeState().mode, 'expanded')
    assert.equal(
      hooks.getDockRuntimeState().interactionSuspendCount,
      0,
      'expanding did not release compact dock suspension'
    )
    assert.deepEqual(window.getBounds(), originalBounds)
    assert.equal(window.getNativeWindowHandle().toString('hex'), originalHandle)
    assert.equal(await js("Boolean(document.querySelector('.app-titlebar'))"), true)
    assert.equal(syncBlurGeometry(1_000), 1, 'blur geometry did not match restored expanded bounds')

    await js("document.querySelector('.light-lock').click()")
    await until(
      () => js("document.querySelector('.light-lock').classList.contains('locked')"),
      'titlebar lock button did not lock the window'
    )
    await assert.rejects(
      () => js(`window.api.enterCompactPresentation(${JSON.stringify(anchor)})`),
      /窗口已锁定/
    )
    await js(`document.querySelector('.app-titlebar-interaction-surface').dispatchEvent(
      new MouseEvent('dblclick', {
        bubbles: true,
        screenX: ${anchor.x},
        screenY: ${anchor.y}
      })
    )`)
    await until(
      () =>
        js(
          `[...document.querySelectorAll('.msg-toast')].some(item => item.textContent.includes('切换为灵动岛会改变窗口位置和尺寸'))`
        ),
      'locked titlebar double-click did not explain why compact mode is unavailable'
    )
    assert.equal(hooks.getPresentationModeState().mode, 'expanded')
    assert.deepEqual(hooks.getPresentationModeState().operation, null)
    await until(
      () => js("!document.querySelector('.light-lock').disabled"),
      'titlebar lock guard did not settle'
    )
    await js("document.querySelector('.light-lock').click()")
    await until(
      () => js("!document.querySelector('.light-lock').classList.contains('locked')"),
      'titlebar lock button did not unlock the window'
    )

    // 点击标题栏会让正文中的编辑控件失焦。元素级 blur 不得被 window 的
    // 捕获监听误判为整个窗口失焦，否则普通层级的拖动也会刚开始就结束。
    const normalDragStartBounds = window.getBounds()
    const normalDragOrigin = {
      x: normalDragStartBounds.x + Math.round(normalDragStartBounds.width / 2),
      y: normalDragStartBounds.y + titlebarCenterOffsetY
    }
    const normalDragDelta = { x: 72, y: 44 }
    await js(`(() => {
      const surface = document.querySelector('.app-titlebar-interaction-surface')
      surface.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 71,
        button: 0,
        buttons: 1,
        screenX: ${normalDragOrigin.x},
        screenY: ${normalDragOrigin.y}
      }))
      surface.dispatchEvent(new FocusEvent('blur', { bubbles: false }))
      window.dispatchEvent(new PointerEvent('pointermove', {
        pointerId: 71,
        button: 0,
        buttons: 1,
        screenX: ${normalDragOrigin.x + normalDragDelta.x},
        screenY: ${normalDragOrigin.y + normalDragDelta.y}
      }))
      window.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 71,
        button: 0,
        buttons: 0,
        screenX: ${normalDragOrigin.x + normalDragDelta.x},
        screenY: ${normalDragOrigin.y + normalDragDelta.y}
      }))
    })()`)
    await until(() => {
      const moved = window.getBounds()
      return (
        moved.x === normalDragStartBounds.x + normalDragDelta.x &&
        moved.y === normalDragStartBounds.y + normalDragDelta.y
      )
    }, 'normal titlebar drag stopped when a child control blurred')
    window.setBounds(normalDragStartBounds)
    await until(() => {
      const restored = window.getBounds()
      return restored.x === normalDragStartBounds.x && restored.y === normalDragStartBounds.y
    }, 'normal titlebar drag regression did not restore the shared test window')

    // 回归用户机器上的偶发序列：置底 -> 锁定 -> 解锁后，Windows/DComp
    // 重排可能让 Chromium 丢失 DOM pointer capture。捕获丢失不能提前结束
    // 主进程拖动事务，后续窗口级 pointermove 必须仍走完整长距离。
    await wait(600)
    assert.equal((await js("window.api.setWindowZOrderMode('bottom')")).mode, 'bottom')
    await wait(600)
    assert.equal((await js('window.api.toggleLock()')).value, true)
    await wait(600)
    assert.equal((await js('window.api.toggleLock()')).value, false)
    const dragStartBounds = window.getBounds()
    const dragOrigin = {
      x: dragStartBounds.x + Math.round(dragStartBounds.width / 2),
      y: dragStartBounds.y + titlebarCenterOffsetY
    }
    const dragDelta = { x: 140, y: 90 }
    await js(`(() => {
      const titlebar = document.querySelector('.app-titlebar')
      const surface = document.querySelector('.app-titlebar-interaction-surface')
      surface.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 73,
        button: 0,
        buttons: 1,
        screenX: ${dragOrigin.x},
        screenY: ${dragOrigin.y}
      }))
      titlebar.dispatchEvent(new PointerEvent('lostpointercapture', {
        bubbles: true,
        pointerId: 73,
        button: 0,
        buttons: 1,
        screenX: ${dragOrigin.x + 4},
        screenY: ${dragOrigin.y + 3}
      }))
      window.dispatchEvent(new PointerEvent('pointermove', {
        pointerId: 73,
        button: 0,
        buttons: 1,
        screenX: ${dragOrigin.x + dragDelta.x},
        screenY: ${dragOrigin.y + dragDelta.y}
      }))
      window.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 73,
        button: 0,
        buttons: 0,
        screenX: ${dragOrigin.x + dragDelta.x},
        screenY: ${dragOrigin.y + dragDelta.y}
      }))
    })()`)
    await until(() => {
      const moved = window.getBounds()
      return (
        moved.x === dragStartBounds.x + dragDelta.x && moved.y === dragStartBounds.y + dragDelta.y
      )
    }, 'titlebar drag stopped after lost pointer capture')
    await wait(600)
    assert.equal((await js("window.api.setWindowZOrderMode('normal')")).mode, 'normal')
    window.setBounds(dragStartBounds)
    await until(() => {
      const restored = window.getBounds()
      return restored.x === dragStartBounds.x && restored.y === dragStartBounds.y
    }, 'titlebar drag regression did not restore the shared test window')
    assert.equal(
      hooks.getDockRuntimeState().interactionSuspendCount,
      0,
      'titlebar drag left dock interaction suspended'
    )

    const secondAnchor = { x: anchor.x + 40, y: anchor.y + 40 }
    const enteringAfterDisplayRecovery = hooks.enterCompactPresentation(secondAnchor)
    powerMonitor.emit('resume')
    hooks.handleDisplayTopologyChange({ eventName: 'display-metrics-changed' })
    await enteringAfterDisplayRecovery
    assert.equal(window.getBounds().width, 272)
    assert.equal(window.getBounds().height, 68)
    assert.equal(window.getNativeWindowHandle().toString('hex'), originalHandle)

    const openingAfterDisplayRecovery = hooks.openMainWindowFromTray()
    powerMonitor.emit('unlock-screen')
    await openingAfterDisplayRecovery
    assert.equal(hooks.getPresentationModeState().mode, 'expanded')
    assert.deepEqual(window.getBounds(), originalBounds)
    assert.equal(window.getNativeWindowHandle().toString('hex'), originalHandle)

    // SR-004: the production draft guard rejects its first inspection after the
    // real compact -> expanded ACK. Refusal must restore this visible source.
    const installDraftInspectionFailure = () =>
      js(`(() => {
        window.__sr004DraftPrepare = window.__prepareEditingDrafts
        window.__sr004DraftReads = 0
        window.__prepareEditingDrafts = () => {
          window.__sr004DraftReads++
          throw new Error('controlled SR-004 draft inspection failure')
        }
      })()`)
    const restoreDraftInspection = () =>
      js(`(() => {
        window.__prepareEditingDrafts = window.__sr004DraftPrepare
        delete window.__sr004DraftPrepare
        delete window.__sr004DraftReads
      })()`)
    await hooks.enterCompactPresentation(secondAnchor)
    await installDraftInspectionFailure()
    try {
      assert.equal(await hooks.switchMainViewFromTray('month'), false)
      assert.equal(hooks.navigationState().mode, 'list')
      assert.equal(hooks.navigationState().pendingReady, null)
      assert.equal(hooks.navigationState().queuedTarget, null)
      assert.equal(hooks.getPresentationModeState().mode, 'expanded')
      assert.equal(hooks.getPresentationModeState().operation, null)
      assert.equal(window.isVisible(), true, 'draft refusal left the visible compact source hidden')
      assert.equal(await js('window.__sr004DraftReads'), 1)
      assert.equal(window.getNativeWindowHandle().toString('hex'), originalHandle)
    } finally {
      await restoreDraftInspection()
    }

    // A source the user already hid must not be revealed by refusal compensation.
    await hooks.enterCompactPresentation(secondAnchor)
    await js('window.api.closeWindow()')
    await until(() => !window.isVisible(), 'compact source did not hide to tray')
    await installDraftInspectionFailure()
    try {
      assert.equal(await hooks.switchMainViewFromTray('month'), false)
      assert.equal(hooks.navigationState().mode, 'list')
      assert.equal(hooks.getPresentationModeState().mode, 'expanded')
      assert.equal(window.isVisible(), false, 'refusal revealed an initially hidden source')
    } finally {
      await restoreDraftInspection()
    }
    await hooks.openMainWindowFromTray()
    await until(
      () => window.isVisible(),
      'hidden-source control did not recover via explicit tray-open'
    )

    // Explicit hide intent must survive when the compact transaction already hid
    // the HWND; Electron cannot be relied on to emit a second hide event here.
    await hooks.enterCompactPresentation(secondAnchor)
    holdRendererAck = true
    const hiddenDuringExpansion = hooks.switchMainViewFromTray('month')
    try {
      await until(
        () => !window.isVisible() && heldRendererAcks.length > 0,
        'expansion did not reach the actual hidden ACK boundary'
      )
      const userHideReceived = new Promise((resolveHide) =>
        ipcMain.once('window-close', () => setImmediate(resolveHide))
      )
      await js('window.api.closeWindow()')
      await userHideReceived
      holdRendererAck = false
      for (const acknowledge of heldRendererAcks.splice(0)) acknowledge()
      assert.equal(await hiddenDuringExpansion, false)
      assert.equal(hooks.navigationState().mode, 'list')
      assert.equal(hooks.navigationState().pendingReady, null)
      assert.equal(hooks.getPresentationModeState().mode, 'expanded')
      assert.equal(window.isVisible(), false, 'navigation overrode a newer user hide intent')
      assert.equal(window.getNativeWindowHandle().toString('hex'), originalHandle)
    } finally {
      holdRendererAck = false
      for (const acknowledge of heldRendererAcks.splice(0)) acknowledge()
      await hiddenDuringExpansion.catch(() => {})
    }
    await hooks.openMainWindowFromTray()
    await until(
      () => window.isVisible(),
      'explicit user-hide control did not recover via tray-open'
    )

    // The real draft guard also owns a late reveal. Its visibility permission
    // must be revoked when inspection finishes after a newer explicit hide.
    await hooks.enterCompactPresentation(secondAnchor)
    await js(`(() => {
      window.__sr004DraftPrepare = window.__prepareEditingDrafts
      window.__sr004InspectionWaiting = false
      window.__prepareEditingDrafts = () => new Promise(resolveInspection => {
        window.__sr004InspectionWaiting = true
        window.__sr004FinishInspection = resolveInspection
      })
    })()`)
    const hiddenDuringInspection = hooks.switchMainViewFromTray('month')
    try {
      await until(
        async () => !window.isVisible() && (await js('window.__sr004InspectionWaiting')),
        'draft guard did not reach the concealed inspection boundary'
      )
      const userHideReceived = new Promise((resolveHide) =>
        ipcMain.once('window-close', () => setImmediate(resolveHide))
      )
      await js('window.api.closeWindow()')
      await userHideReceived
      await js('window.__sr004FinishInspection({ dirty: false, blocked: true }); void 0')
      assert.equal(await hiddenDuringInspection, false)
      assert.equal(hooks.navigationState().mode, 'list')
      assert.equal(window.isVisible(), false, 'late draft inspection overrode user hide intent')
      assert.equal(hooks.getPresentationModeState().mode, 'expanded')
      assert.equal(window.getNativeWindowHandle().toString('hex'), originalHandle)
    } finally {
      await js(`(() => {
        window.__sr004FinishInspection?.({ dirty: false, blocked: false })
        window.__prepareEditingDrafts = window.__sr004DraftPrepare
        delete window.__sr004DraftPrepare
        delete window.__sr004InspectionWaiting
        delete window.__sr004FinishInspection
      })()`)
      await hiddenDuringInspection.catch(() => {})
    }
    await hooks.openMainWindowFromTray()
    await until(() => window.isVisible(), 'late-inspection control did not recover via tray-open')

    await hooks.enterCompactPresentation(secondAnchor)

    await hooks.switchMainView('month')
    await until(
      () => window.webContents.getURL().endsWith('/month.html') && window.isVisible(),
      'month view did not finish navigation'
    )
    assert.equal(BrowserWindow.getAllWindows().includes(originalWindow), true)
    assert.equal(window.getNativeWindowHandle().toString('hex'), originalHandle)
    assert.equal(hooks.getPresentationModeState().mode, 'expanded')
    assert.deepEqual(hooks.getPresentationModeState().operation, null)
    assert.ok(window.getBounds().width >= 240 && window.getBounds().height >= 240)
    assert.equal(await js("Boolean(document.querySelector('.month-scene'))"), true)
    assert.equal(await js("Boolean(document.querySelector('.compact-island'))"), false)
    assert.equal(blurHealthy(), 1, 'blur became unhealthy after view navigation')
    assert.equal(syncBlurGeometry(1_000), 1, 'blur geometry did not follow view navigation')
    assert.equal(
      hooks.getDockRuntimeState().interactionSuspendCount,
      0,
      'view navigation leaked presentation dock suspension'
    )

    console.log('presentation mode Electron integration passed')
    completed = true
  } catch (error) {
    console.error(error)
    failure = error
  } finally {
    await lifecycle.finish({
      completed,
      error: failure,
      window: current,
      summary: {
        scope:
          'Same HWND compact/expand, controlled power/display recovery, resize persistence, ordinary geometry, drag, tray/view navigation and native blur geometry',
        droppedAcks,
        presentation: globalThis.__ABANDON_WINDOW_TEST_HOOKS__?.getPresentationModeState?.(),
        dock: globalThis.__ABANDON_WINDOW_TEST_HOOKS__?.getDockRuntimeState?.()
      }
    })
  }
}
