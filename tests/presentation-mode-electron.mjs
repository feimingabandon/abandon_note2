import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, screen } from 'electron'
import koffi from 'koffi'
import { compactBoundsFromAnchor } from '../src/shared/window-compact-geometry.js'

const root = mkdtempSync(join(tmpdir(), 'abandon-presentation-mode-'))
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
    if (result) return result
    await wait(30)
  }
  throw new Error(label)
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

const timeout = setTimeout(() => {
  console.error('presentation mode integration timed out')
  app.exit(1)
}, 60_000)

async function run() {
  try {
    assert.equal(nativeAbi(), 17, 'native blur ABI was not rebuilt')
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
    await until(() => window.isVisible(), 'list window never became visible')
    const js = (code) => window.webContents.executeJavaScript(code)
    await until(() => js("Boolean(document.querySelector('.app-titlebar'))"), 'titlebar missing')
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

    const secondAnchor = { x: anchor.x + 40, y: anchor.y + 40 }
    await hooks.enterCompactPresentation(secondAnchor)
    assert.equal(window.getBounds().width, 272)
    assert.equal(window.getBounds().height, 68)
    assert.equal(window.getNativeWindowHandle().toString('hex'), originalHandle)

    await hooks.openMainWindowFromTray()
    assert.equal(hooks.getPresentationModeState().mode, 'expanded')
    assert.deepEqual(window.getBounds(), originalBounds)
    assert.equal(window.getNativeWindowHandle().toString('hex'), originalHandle)

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

    console.log('presentation mode Electron integration passed')
    clearTimeout(timeout)
    app.exit(0)
  } catch (error) {
    console.error(error)
    clearTimeout(timeout)
    app.exit(1)
  }
}
