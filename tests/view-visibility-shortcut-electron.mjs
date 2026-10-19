import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import koffi from 'koffi'
import { app, BrowserWindow, globalShortcut, Menu, nativeImage, Tray } from 'electron'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'
import { dismissStartupShortcutNotice } from './helpers/startup-shortcut-notice.mjs'
import { assessStandaloneReport } from '../scripts/test-result-adapters.cjs'

const require = createRequire(import.meta.url)
const WAIT_STEP_MS = 25
const stage = process.env.ABANDON_SHORTCUT_TEST_STAGE
const suite = 'tests/view-visibility-shortcut-electron.mjs'
const mode = 'electron-legacy-window-fixture'
const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite,
  mode,
  prefix: 'abandon-note-view-shortcut-e2e-',
  // Exercise product quit with the live main window through its asynchronous shutdown stages.
  destroyWindowsBeforeQuit: false,
  metadata: {
    legacyFixture: true,
    stage: stage || 'controller',
    runtimeAppBootstrap: Boolean(stage),
    diskDatabase: true,
    realWindows: true,
    mainProcessRestart: true,
    assertionCounterScope: stage
      ? 'actual business assert calls in this child process'
      : 'actual controller protocol assertions; child business totals are separately reported'
  },
  timeoutMs: stage ? 45000 : 210000
})
const { assert } = lifecycle

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

async function waitUntil(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(WAIT_STEP_MS)
  }
  throw new Error(message)
}

function seedListView(userDataPath) {
  mkdirSync(userDataPath, { recursive: true })
  const db = new Database(join(userDataPath, 'app.db'))
  db.exec(`
    CREATE TABLE app_settings (
      window_name TEXT NOT NULL,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      remark TEXT DEFAULT '',
      created_at INTEGER,
      updated_at INTEGER,
      PRIMARY KEY (window_name, key)
    );
  `)
  const insert = db.prepare(`
    INSERT INTO app_settings
      (window_name, type, key, value, remark, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', ?, ?)
  `)
  const now = Date.now()
  insert.run('application', 'application', 'active_view', 'list', now, now)
  insert.run('application', 'remote', 'receive_notices', 'false', now, now)
  insert.run('application', 'remote', 'upload_device_info', 'false', now, now)
  insert.run('application', 'onboarding', 'first_use_notice_version', '1', now, now)
  insert.run('application', 'shortcuts', 'view_visibility', 'Control+Alt+F10', now, now)
  insert.run('application', 'shortcuts', 'enabled', '0', now, now)
  insert.run('application', 'shortcuts', 'clipboard_pin', 'Control+Alt+Shift+F6', now, now)
  insert.run('application', 'shortcuts', 'toggle_pins', 'Control+Alt+Shift+F7', now, now)
  insert.run('main', 'system', 'blur_enabled', 'false', now, now)
  db.close()
}

function getListWindow() {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && /\/index\.html(?:$|[?#])/.test(window.webContents.getURL())
  )
}

async function shortcutSnapshot(window) {
  return window.webContents
    .executeJavaScript(`window.api.getSettingsSnapshot().then((snapshot) => ({
    value: snapshot.values.shortcuts.viewVisibility,
    runtime: snapshot.runtime.shortcuts.viewVisibility
  }))`)
}

const testUserData = lifecycle.root
const evidence =
  process.env.ABANDON_SHORTCUT_TEST_EVIDENCE ||
  (stage ? process.env.ABANDON_TEST_EVIDENCE_DIR : null)
const trayPresentation = {}
const originalTrayMethods = new Map()
let activeWindow = null
for (const method of ['setImage', 'setToolTip']) {
  const original = Tray.prototype[method]
  originalTrayMethods.set(method, original)
  Tray.prototype[method] = function (value) {
    trayPresentation[method] =
      method === 'setImage'
        ? (typeof value === 'string' ? nativeImage.createFromPath(value) : value).toPNG()
        : value
    return original.call(this, value)
  }
}

function restoreTestPatches() {
  for (const [method, original] of originalTrayMethods) Tray.prototype[method] = original
  app.releaseSingleInstanceLock()
}

async function finishShortcutStage(completed, error) {
  await lifecycle.finish({
    completed: completed && !error,
    error,
    window: activeWindow,
    summary: { stage, profile: app.getPath('userData') },
    restore: restoreTestPatches
  })
}

async function openShortcutEditor(window, action) {
  const js = (code) => window.webContents.executeJavaScript(code)
  await waitUntil(
    () =>
      js(`(() => {
        const panel = document.querySelector('.settings-panel.active')
        return panel && !panel.getAnimations().some(animation =>
          !['finished', 'idle'].includes(animation.playState))
      })()`),
    '设置入场动画未结束'
  )
  await waitUntil(
    () =>
      js(`Boolean(document.querySelector('[data-shortcut="${action}"] button:not(:disabled)'))`),
    '快捷键摘要未就绪'
  )
  // Scroll after the panel has restored its opening position. Opening the
  // recorder during that movement can put its anchor outside the panel body.
  await js(`(async () => {
    const trigger = document.querySelector('[data-shortcut="${action}"] button');
    trigger.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`)
  await waitUntil(
    () =>
      js(`(() => {
        const trigger = document.querySelector('[data-shortcut="${action}"] button')
        const body = trigger?.closest('.panel-body')
        if (!trigger || trigger.disabled || !body) return false
        const rect = trigger.getBoundingClientRect()
        const bounds = body.getBoundingClientRect()
        return rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1
      })()`),
    '快捷键摘要没有稳定显示在设置滚动区域内'
  )
  await js(`(() => {
    const trigger = document.querySelector('[data-shortcut="${action}"] button')
    if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click()
  })()`)
  await waitUntil(
    () =>
      js(
        `Boolean(document.querySelector('#shortcut-status-${action}')) && document.querySelectorAll('.shortcut-recorder').length === 1`
      ),
    '快捷键编辑浮层未打开'
  )
}

async function runViewVisibilityShortcutTest() {
  let completed = false
  let failure = null
  try {
    const listWindow = await waitUntil(() => getListWindow(), '列表主窗口没有按隔离设置启动', 10000)
    activeWindow = listWindow
    await waitUntil(() => listWindow.isVisible(), '列表主窗口渲染就绪后没有显示')
    await dismissStartupShortcutNotice(listWindow)
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.titlebar-btn-settings[title="设置"]'))`
        ),
      '列表导航栏没有设置入口'
    )

    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.titlebar-btn-settings[title="设置"]').click()`
    )
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.settings-panel.active .shortcut-setting'))`
        ),
      '设置面板没有显示视图快捷键录制器'
    )

    const hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
    const js = (code) => listWindow.webContents.executeJavaScript(code)
    const allShortcuts = () =>
      js(
        'window.api.getSettingsSnapshot().then(s => ({ values: s.values.shortcuts, runtime: s.runtime.shortcuts }))'
      )
    const trayToggle = () =>
      hooks.getTrayMenuTemplate().find((item) => item.id === 'toggle-global-shortcuts')
    const screenshotKey = 'Control+Alt+Shift+F9'
    const screenshotCopyKey = 'Control+Alt+Shift+F8'
    let shortcuts = await allShortcuts()
    assert.deepEqual(shortcuts.values, {
      enabled: true,
      viewVisibility: 'Control+Alt+F10',
      screenshot: 'F1',
      screenshotCopy: 'Control+F1'
    })
    // The old persisted disabled value must not affect a new app session.
    assert.equal(shortcuts.runtime.screenshot.enabled, true)
    assert.equal(shortcuts.runtime.screenshotCopy.enabled, true)
    assert.equal(shortcuts.runtime.viewVisibility.registered, true)
    assert.equal(trayToggle().type, 'checkbox')
    assert.equal(trayToggle().label, '禁用全部快捷键（本次运行）')
    assert.equal(trayToggle().checked, false)
    assert.equal(trayPresentation.setToolTip, '便签')
    const normalIcon = trayPresentation.setImage
    assert.ok(normalIcon?.length)
    trayToggle().click()
    assert.equal(trayToggle().checked, true)
    assert.equal(
      Menu.buildFromTemplate(hooks.getTrayMenuTemplate()).getMenuItemById('toggle-global-shortcuts')
        .checked,
      true
    )
    assert.equal(trayPresentation.setToolTip, '便签 · 快捷键已禁用（重启恢复）')
    assert.ok(!trayPresentation.setImage.equals(normalIcon))
    if (evidence) {
      mkdirSync(evidence, { recursive: true })
      writeFileSync(join(evidence, 'tray-enabled.png'), normalIcon)
      writeFileSync(join(evidence, 'tray-disabled.png'), trayPresentation.setImage)
    }
    shortcuts = await allShortcuts()
    assert.equal(shortcuts.runtime.screenshot.registered, false)
    assert.equal(shortcuts.runtime.screenshotCopy.registered, false)
    assert.equal(shortcuts.runtime.viewVisibility.registered, false)
    assert.equal(globalShortcut.isRegistered('Control+Alt+F10'), false)
    assert.equal(globalShortcut.isRegistered('Control+Alt+Shift+F6'), false)
    assert.equal(globalShortcut.isRegistered('Control+Alt+Shift+F7'), false)
    assert.equal(await js('document.querySelectorAll("[data-shortcut]").length'), 3)
    assert.equal(await js('document.querySelectorAll(".shortcut-recorder").length'), 0)
    assert.equal(trayToggle().checked, true)
    for (const label of ['剪贴板贴图', '显示/隐藏全部贴图']) {
      assert.ok(hooks.getTrayMenuTemplate().some((item) => item.label === label))
    }
    assert.ok(!hooks.getTrayMenuTemplate().some((item) => /鼠标穿透|关闭全部贴图/.test(item.label)))
    for (const key of ['clipboardPin', 'togglePins']) {
      assert.equal((await js(`window.api.setCaptureShortcut('${key}', 'F3')`)).status, 'invalid')
    }
    assert.equal(
      (await js(`window.api.setCaptureShortcut('screenshot', '${screenshotKey}')`)).status,
      'saved'
    )
    assert.equal(
      (await js(`window.api.setCaptureShortcut('screenshotCopy', '${screenshotCopyKey}')`)).status,
      'saved'
    )
    await js("window.api.beginViewVisibilityShortcutCapture('screenshot')")
    await js("window.api.endViewVisibilityShortcutCapture('screenshot')")
    assert.equal(globalShortcut.isRegistered(screenshotKey), false)
    assert.equal(globalShortcut.isRegistered(screenshotCopyKey), false)
    hooks.triggerViewVisibilityShortcut()
    hooks.triggerScreenshotShortcut()
    hooks.triggerScreenshotShortcut('screenshotCopy')
    await wait(100)
    assert.equal(listWindow.isVisible(), true)
    assert.equal(hooks.nativeCaptureState().active, false)
    trayToggle().click()
    assert.equal(trayToggle().checked, false)
    assert.ok(trayPresentation.setImage.equals(normalIcon))
    assert.equal(trayPresentation.setToolTip, '便签')
    assert.equal(globalShortcut.isRegistered(screenshotKey), true)
    assert.equal(globalShortcut.isRegistered(screenshotCopyKey), true)
    assert.equal((await allShortcuts()).runtime.screenshotCopy.registered, true)
    assert.equal(globalShortcut.isRegistered('Control+Alt+F10'), true)
    await openShortcutEditor(listWindow, 'screenshot')
    await waitUntil(
      () =>
        js('document.querySelector("#shortcut-status-screenshot")?.textContent.includes("已启用")'),
      '托盘开启后设置状态未同步'
    )
    // Enabling the gate must not overwrite the legacy row either.
    const persisted = new Database(join(testUserData, 'app.db'), { readonly: true })
    try {
      assert.equal(
        persisted
          .prepare(
            "SELECT value FROM app_settings WHERE window_name = 'application' AND key = 'enabled' AND type = 'shortcuts'"
          )
          .get().value,
        '0'
      )
    } finally {
      persisted.close()
    }
    trayToggle().click()
    assert.equal(globalShortcut.isRegistered(screenshotKey), false)
    assert.equal(globalShortcut.isRegistered(screenshotCopyKey), false)
    assert.equal(globalShortcut.isRegistered('Control+Alt+F10'), false)
    await waitUntil(
      () =>
        js('document.querySelector("#shortcut-status-screenshot")?.textContent.includes("已禁用")'),
      '托盘禁用后设置状态未同步'
    )
    // An application can acquire the key while ours is disabled. Re-enabling
    // must expose the conflict without breaking the other configured shortcut.
    assert.equal(
      globalShortcut.register(screenshotKey, () => {}),
      true
    )
    trayToggle().click()
    shortcuts = await allShortcuts()
    assert.equal(shortcuts.runtime.screenshot.registered, false)
    assert.equal(shortcuts.runtime.screenshot.error.code, 'conflict')
    assert.equal(shortcuts.runtime.viewVisibility.registered, true)
    trayToggle().click()
    globalShortcut.unregister(screenshotKey)
    trayToggle().click()

    assert.deepEqual(await shortcutSnapshot(listWindow), {
      value: 'Control+Alt+F10',
      runtime: {
        configured: 'Control+Alt+F10',
        enabled: true,
        registered: true,
        capturing: false,
        error: null
      }
    })

    await openShortcutEditor(listWindow, 'viewVisibility')
    await listWindow.webContents.executeJavaScript(`(() => {
      const recorder = document.querySelector('.shortcut-recorder')
      const clearButton = Array.from(recorder.querySelectorAll('button')).find(
        (button) => button.textContent.trim() === '清除'
      )
      clearButton?.click()
    })()`)
    await waitUntil(async () => {
      const snapshot = await shortcutSnapshot(listWindow)
      return snapshot.value === '' && !snapshot.runtime.registered
    }, '启动时恢复的快捷键没有清除')

    const recorded = await listWindow.webContents.executeJavaScript(`(() => {
      const recorder = document.querySelector('.shortcut-recorder')
      const recordButton = Array.from(recorder.querySelectorAll('button')).find(
        (button) => button.textContent.trim() === '录制'
      )
      recordButton?.click()
      return Boolean(recordButton)
    })()`)
    assert.equal(recorded, true, '没有找到录制按钮')
    await waitUntil(
      async () => (await shortcutSnapshot(listWindow)).runtime.capturing,
      '录制按钮没有进入录制状态'
    )
    await listWindow.webContents
      .executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'F11',
        code: 'F11',
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true
      }))`)

    await waitUntil(async () => {
      const snapshot = await shortcutSnapshot(listWindow)
      return snapshot.value === 'Control+Alt+F11' && snapshot.runtime.registered
    }, '快捷键没有自动保存并注册')
    assert.equal(
      await listWindow.webContents.executeJavaScript(
        `document.querySelector('.shortcut-recorder-field')?.value`
      ),
      'Ctrl + Alt + F11'
    )

    await listWindow.webContents.executeJavaScript(`(() => {
      const recorder = document.querySelector('.shortcut-recorder')
      const button = Array.from(recorder.querySelectorAll('button')).find(
        (candidate) => candidate.textContent.trim() === '重新录制'
      )
      button?.click()
    })()`)
    await waitUntil(
      async () => (await shortcutSnapshot(listWindow)).runtime.capturing,
      '重新录制没有进入录制状态'
    )
    globalThis.__ABANDON_WINDOW_TEST_HOOKS__.triggerViewVisibilityShortcut()
    await wait(120)
    assert.equal(listWindow.isVisible(), true, '录制期间旧快捷键不应隐藏设置窗口')

    await listWindow.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    )
    await waitUntil(
      async () => !(await shortcutSnapshot(listWindow)).runtime.capturing,
      'Esc 没有取消快捷键录制'
    )

    await js(`window.api.setWindowZOrderMode('normal')`)
    const user32 = koffi.load('user32.dll')
    const foreground = user32.func('intptr_t GetForegroundWindow()')
    const getWindow = user32.func('intptr_t GetWindow(intptr_t hwnd, uint32_t command)')
    const handle = (window) => window.getNativeWindowHandle().readBigUInt64LE()
    const isAbove = (upper, lower) => {
      for (
        let candidate = getWindow(handle(upper), 2);
        candidate;
        candidate = getWindow(candidate, 2)
      ) {
        if (BigInt(candidate) === handle(lower)) return true
      }
      return false
    }
    const coveredBy = new BrowserWindow({
      width: 600,
      height: 400,
      show: false,
      webPreferences: { sandbox: true }
    })
    try {
      await coveredBy.loadURL(
        'data:text/html,<title>Visibility regression cover</title><p>Foreground test window</p>'
      )
      const coverMain = async () => {
        coveredBy.setBounds(listWindow.getBounds())
        coveredBy.show()
        coveredBy.moveTop()
        coveredBy.focus()
        await waitUntil(
          () =>
            BigInt(foreground()) === handle(coveredBy) &&
            !listWindow.isFocused() &&
            isAbove(coveredBy, listWindow),
          '前提失败：测试窗口未遮住主窗口'
        )
      }
      const expectActivated = async (label) => {
        await waitUntil(
          () =>
            listWindow.isVisible() &&
            !listWindow.isMinimized() &&
            listWindow.isFocused() &&
            BigInt(foreground()) === handle(listWindow) &&
            isAbove(listWindow, coveredBy),
          label
        )
        assert.equal(listWindow.isAlwaysOnTop(), false, '显示操作不应改变正常层级')
      }
      for (const [name, trigger] of [
        ['shortcut', () => hooks.triggerViewVisibilityShortcut()],
        ['tray', () => hooks.triggerTrayClick()]
      ]) {
        await coverMain()
        assert.equal(listWindow.isVisible(), true)
        trigger()
        await expectActivated(name + ': 被遮挡时一次操作应置前并激活')
        trigger()
        await waitUntil(() => !listWindow.isVisible(), name + ': 前台窗口应隐藏')
        trigger()
        await expectActivated(name + ': 隐藏后一次操作应显示并激活')
        listWindow.minimize()
        await waitUntil(() => listWindow.isMinimized(), '未进入最小化')
        trigger()
        await expectActivated(name + ': 最小化后一次操作应恢复并激活')
      }
      await coverMain()
      await hooks.openMainWindowFromTray()
      await expectActivated('托盘打开主窗口应置前并激活')
      assert.equal(
        await js('window.api.getSettingsSnapshot().then(s=>s.values.window.zOrderMode)'),
        'normal'
      )
      console.log(
        'visibility: covered, foreground, hidden and minimized states passed for shortcut and tray; native foreground/z-order verified'
      )
    } finally {
      coveredBy.destroy()
    }

    globalThis.__ABANDON_WINDOW_TEST_HOOKS__.triggerViewVisibilityShortcut()
    await waitUntil(() => !listWindow.isVisible(), '快捷键回调没有把当前视图隐藏到托盘')
    globalThis.__ABANDON_WINDOW_TEST_HOOKS__.triggerViewVisibilityShortcut()
    await waitUntil(() => listWindow.isVisible(), '快捷键回调没有从托盘恢复当前视图')

    trayToggle().click()
    assert.equal(trayToggle().checked, true)
    await listWindow.webContents.executeJavaScript(`(() => {
      const button = Array.from(document.querySelectorAll('.settings-panel button')).find(
        (candidate) => candidate.textContent.trim() === '恢复默认设置'
      )
      button?.click()
    })()`)
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.confirm-card.active[aria-label="恢复默认设置"]'))`
        ),
      '恢复默认确认弹窗没有打开'
    )
    await listWindow.webContents.executeJavaScript(`(() => {
      const button = Array.from(document.querySelectorAll('.confirm-card.active button')).find(
        (candidate) => candidate.textContent.trim() === '恢复'
      )
      button?.click()
    })()`)
    await waitUntil(async () => {
      const snapshot = await shortcutSnapshot(listWindow)
      return snapshot.value === 'F2' && !snapshot.runtime.registered
    }, '禁用状态下恢复默认应保存 F2，但不注册快捷键')

    assert.equal((await allShortcuts()).values.enabled, false)
    assert.equal((await allShortcuts()).values.screenshot, 'F1')
    assert.equal((await allShortcuts()).values.screenshotCopy, 'Control+F1')
    assert.equal((await allShortcuts()).runtime.screenshotCopy.registered, false)
    assert.equal(trayToggle().checked, true)
    assert.equal(
      (await js(`window.api.setCaptureShortcut('screenshot', '${screenshotKey}')`)).status,
      'saved'
    )
    assert.equal(
      (await js(`window.api.setCaptureShortcut('screenshotCopy', '${screenshotCopyKey}')`)).status,
      'saved'
    )
    assert.equal(
      (await js("window.api.setViewVisibilityShortcut('Control+Alt+F10')")).status,
      'saved'
    )
    // Settings reloads, view navigation and hiding are all within this session.
    for (const view of ['month', 'list']) {
      assert.equal(await hooks.switchMainView(view), true)
      assert.equal((await allShortcuts()).values.enabled, false)
      assert.equal(trayToggle().checked, true)
      assert.equal(globalShortcut.isRegistered(screenshotKey), false)
      assert.equal(globalShortcut.isRegistered(screenshotCopyKey), false)
    }
    listWindow.hide()
    await hooks.openMainWindowFromTray()
    await waitUntil(() => listWindow.isVisible(), '托盘没有重新显示主窗口')
    assert.equal((await allShortcuts()).values.enabled, false)
    assert.equal(trayToggle().checked, true)
    process.stderr.write('session gate, tray badge, settings refresh and view switching passed\n')
    completed = true
  } catch (error) {
    console.error(error)
    failure = error
  } finally {
    await finishShortcutStage(completed, failure)
  }
}

async function verifyRestart() {
  let completed = false
  let failure = null
  try {
    const window = await waitUntil(() => getListWindow(), '重启后没有列表窗口', 10000)
    activeWindow = window
    await waitUntil(() => window.isVisible(), '重启后列表窗口没有显示')
    await dismissStartupShortcutNotice(window)
    await waitUntil(
      () => globalThis.__ABANDON_WINDOW_TEST_HOOKS__?.nativeCaptureState().ready,
      '重启后截图组件未就绪',
      10000
    )
    const snapshot = await window.webContents.executeJavaScript('window.api.getSettingsSnapshot()')
    assert.deepEqual(snapshot.values.shortcuts, {
      enabled: true,
      viewVisibility: 'Control+Alt+F10',
      screenshot: 'Control+Alt+Shift+F9',
      screenshotCopy: 'Control+Alt+Shift+F8'
    })
    for (const shortcut of ['viewVisibility', 'screenshot', 'screenshotCopy']) {
      assert.equal(snapshot.runtime.shortcuts[shortcut].enabled, true)
      assert.equal(snapshot.runtime.shortcuts[shortcut].registered, true)
      assert.equal(globalShortcut.isRegistered(snapshot.values.shortcuts[shortcut]), true)
    }
    const item = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
      .getTrayMenuTemplate()
      .find((item) => item.id === 'toggle-global-shortcuts')
    assert.equal(item.checked, false)
    assert.equal(trayPresentation.setToolTip, '便签')
    process.stderr.write('same-profile restart restores enabled shortcuts and saved bindings\n')
    completed = true
  } catch (error) {
    console.error(error)
    failure = error
  } finally {
    await finishShortcutStage(completed, failure)
  }
}

async function verifyStartupConflict() {
  let completed = false
  let failure = null
  try {
    const releaseTestShortcut = async (accelerator) => {
      globalShortcut.unregister(accelerator)
      // Confirm the OS has released the test reservation before asking the UI
      // to recover. A real external owner may reclaim a default key meanwhile.
      await waitUntil(() => {
        if (!globalShortcut.register(accelerator, () => {})) return false
        globalShortcut.unregister(accelerator)
        return true
      }, `测试按键 ${accelerator} 仍被系统占用`)
    }
    const window = await waitUntil(() => getListWindow(), '冲突测试主窗口未创建', 10000)
    activeWindow = window
    const js = (code) => window.webContents.executeJavaScript(code)
    await waitUntil(() => js('Boolean(window.api)'), 'preload 未就绪')
    const failures = await js('window.api.getShortcutStartupNotice()')
    assert.deepEqual(failures.map((item) => item.accelerator).sort(), ['Ctrl + F1', 'F1', 'F2'])
    const snapshot = await js('window.api.getSettingsSnapshot()')
    assert.equal(snapshot.values.shortcuts.viewVisibility, 'F2')
    assert.equal(snapshot.values.shortcuts.screenshotCopy, 'Control+F1')
    assert.equal(snapshot.runtime.shortcuts.screenshotCopy.registered, false)
    assert.equal(snapshot.runtime.shortcuts.screenshotCopy.error.code, 'conflict')
    const selector = '.app-modal-card[aria-label="快捷键启用提示"]'
    await waitUntil(() => js(`Boolean(document.querySelector('${selector}'))`), '启动冲突没有弹窗')
    assert.equal(await js(`document.querySelector('${selector}').querySelectorAll('li').length`), 3)
    assert.equal(await js('document.querySelector(".app-scene").inert'), true)
    const click = (label) =>
      js(
        `Array.from(document.querySelector('${selector}').querySelectorAll('button')).find(b => b.textContent.trim() === '${label}').click()`
      )
    await click('重试启用')
    await waitUntil(
      () => js(`document.querySelector('${selector}').textContent.includes('仍有快捷键')`),
      '仍冲突时没有反馈'
    )
    if (evidence) {
      mkdirSync(evidence, { recursive: true })
      for (const [name, bg, fg] of [
        ['white', '255 255 255', '#000000'],
        ['black', '0 0 0', '#ffffff'],
        ['wallpaper', '245 245 250', '#14141e']
      ]) {
        await js(`window.api.setSettingValue('css.bgColor', '${bg}')`)
        await js(`window.api.setSettingValue('css.textColor', '${fg}')`)
        await js(`(() => {
          document.querySelector('.app-scene').style.background = ${name === 'wallpaper' ? JSON.stringify('repeating-linear-gradient(35deg, #fc8 0 30px, #38a 30px 70px, #827 70px 100px)') : JSON.stringify(`rgb(${bg})`)};
        })()`)
        await wait(300)
        assert.equal(await js("document.documentElement.style.getPropertyValue('--bg-color')"), bg)
        assert.equal(
          await js("document.documentElement.style.getPropertyValue('--text-color')"),
          fg
        )
        writeFileSync(
          join(evidence, `shortcut-conflict-${name}.png`),
          (await window.webContents.capturePage()).toPNG()
        )
      }
    }
    await releaseTestShortcut('F2')
    await click('重试启用')
    await waitUntil(
      () => js(`document.querySelector('${selector}').querySelectorAll('li').length === 2`),
      '释放 F2 后没有局部恢复'
    ).catch(async (error) => {
      console.error(
        'retry evidence',
        await js(
          `window.api.getSettingsSnapshot().then(s => ({ shortcuts: s.runtime.shortcuts, dialog: document.querySelector('${selector}')?.textContent }))`
        )
      )
      throw error
    })
    assert.equal((await shortcutSnapshot(window)).runtime.registered, true)
    await releaseTestShortcut('F1')
    await click('重试启用')
    await waitUntil(
      () => js(`document.querySelector('${selector}').querySelectorAll('li').length === 1`),
      '释放 F1 后应只剩快速截图复制冲突'
    )
    const partial = await js('window.api.getSettingsSnapshot()')
    assert.equal(partial.runtime.shortcuts.screenshot.registered, true)
    assert.equal(partial.runtime.shortcuts.screenshotCopy.registered, false)
    assert.equal(partial.runtime.shortcuts.screenshotCopy.error.code, 'conflict')
    await releaseTestShortcut('Control+F1')
    await click('重试启用')
    await waitUntil(
      () => js(`document.querySelector('${selector}').textContent.includes('快捷键已恢复')`),
      '释放 Control+F1 后没有全部恢复'
    )
    const recovered = await js('window.api.getSettingsSnapshot()')
    assert.equal(recovered.runtime.shortcuts.screenshotCopy.registered, true)
    assert.equal(globalShortcut.isRegistered('Control+F1'), true)
    await click('完成')
    await waitUntil(() => js(`!document.querySelector('${selector}')`), '冲突提示没有关闭')
    assert.deepEqual(await js('window.api.getShortcutStartupNotice()'), [])
    const hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
    for (const view of ['month', 'week', 'list']) {
      assert.equal(await hooks.switchMainView(view), true)
      assert.deepEqual(await js('window.api.getShortcutStartupNotice()'), [])
      assert.equal(await js(`Boolean(document.querySelector('${selector}'))`), false)
    }
    const toggle = () =>
      hooks
        .getTrayMenuTemplate()
        .find((item) => item.id === 'toggle-global-shortcuts')
        .click()
    toggle()
    assert.equal(
      (await js('window.api.retryShortcuts()')).runtime.shortcuts.viewVisibility.registered,
      false
    )
    assert.equal(
      globalShortcut.register('F2', () => {}),
      true
    )
    toggle()
    await js('document.querySelector(".titlebar-btn-settings[title=设置]").click()')
    await openShortcutEditor(window, 'viewVisibility')
    await waitUntil(
      () => js('Boolean(document.querySelector("#shortcut-status-viewVisibility"))'),
      '设置未打开'
    )
    assert.equal(
      await js(
        'document.querySelector("#shortcut-status-viewVisibility").textContent.includes("未能启用")'
      ),
      true
    )
    await releaseTestShortcut('F2')
    await waitUntil(
      () =>
        js(`(() => {
          const status = document.querySelector('#shortcut-status-viewVisibility')
          const panel = status?.closest('.settings-control-panel')
          const retry = Array.from(status?.parentElement.querySelectorAll('button') || [])
            .find(button => button.textContent.trim() === '重试启用')
          return panel && retry && !retry.disabled && !panel.getAnimations().some(animation =>
            !['finished', 'idle'].includes(animation.playState))
        })()`),
      '设置中的快捷键重试按钮尚未可操作'
    )
    await js(
      `Array.from(document.querySelector('#shortcut-status-viewVisibility').parentElement.querySelectorAll('button')).find(b => b.textContent.trim() === '重试启用' && !b.disabled).click()`
    )
    await waitUntil(
      async () => (await shortcutSnapshot(window)).runtime.registered,
      '设置中重试没有恢复'
    ).catch(async (error) => {
      console.error(
        'settings retry evidence',
        await js(`window.api.getSettingsSnapshot().then(snapshot => ({
          runtime: snapshot.runtime.shortcuts.viewVisibility,
          status: document.querySelector('#shortcut-status-viewVisibility')?.textContent,
          expanded: document.querySelector('[data-shortcut="viewVisibility"] button')?.getAttribute('aria-expanded'),
          buttons: Array.from(document.querySelector('#shortcut-status-viewVisibility')?.parentElement.querySelectorAll('button') || [],
            button => ({ text: button.textContent.trim(), disabled: button.disabled })),
          scrollTop: document.querySelector('.settings-panel .panel-body')?.scrollTop
        }))`)
      )
      throw error
    })
    assert.equal(globalShortcut.isRegistered('F2'), true, '设置中重试必须恢复真实 F2 注册')
    assert.equal(
      await js(
        'document.querySelector("#shortcut-status-viewVisibility").textContent.includes("已启用")'
      ),
      true
    )
    process.stderr.write(
      'F2 default, startup conflict dialog, partial recovery, settings retry, disabled guard and view navigation passed\n'
    )
    completed = true
  } catch (error) {
    console.error(error)
    failure = error
  } finally {
    await finishShortcutStage(completed, failure)
  }
}

async function runSessions() {
  const parentEvidence = process.env.ABANDON_TEST_EVIDENCE_DIR || testUserData
  const sessions = []
  const childBusinessAssertions = { total: 0, passed: 0, failed: 0, skipped: 0 }
  let completed = false
  let failure = null
  try {
    for (const childStage of ['startup-conflict', 'session', 'restart']) {
      const childProfile = join(
        testUserData,
        childStage === 'startup-conflict' ? 'startup-conflict-profile' : 'shared-profile'
      )
      const childEvidence = join(parentEvidence, 'shortcut-stages', childStage)
      const childToken = randomBytes(24).toString('hex')
      mkdirSync(childProfile, { recursive: true })
      mkdirSync(childEvidence, { recursive: true })
      const childEnv = {
        ...process.env,
        ABANDON_SHORTCUT_TEST_STAGE: childStage,
        ABANDON_SHORTCUT_TEST_PROFILE: childProfile,
        ABANDON_SHORTCUT_TEST_EVIDENCE: childEvidence,
        ABANDON_TEST_USER_DATA: childProfile,
        ABANDON_TEST_EVIDENCE_DIR: childEvidence,
        ABANDON_TEST_RESULT_FILE: join(childEvidence, 'standalone.json'),
        ABANDON_TEST_RUN_TOKEN: childToken
      }
      delete childEnv.ELECTRON_RUN_AS_NODE
      const startedMs = Date.now()
      const result = await new Promise((done, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
          env: childEnv,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = ''
        let stderr = ''
        let timedOut = false
        child.stdout.on('data', (chunk) => {
          stdout += chunk
          process.stdout.write(chunk)
        })
        child.stderr.on('data', (chunk) => {
          stderr += chunk
          process.stderr.write(chunk)
        })
        const timeout = setTimeout(() => {
          timedOut = true
          child.kill()
        }, 60000)
        child.once('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        child.once('close', (code, signal) => {
          clearTimeout(timeout)
          done({ code, signal, timedOut, pid: child.pid, stdout, stderr })
        })
      })
      writeFileSync(join(childEvidence, 'process.json'), JSON.stringify(result, null, 2), {
        flag: 'wx'
      })
      const session = {
        stage: childStage,
        profile: childProfile,
        evidenceDirectory: childEvidence,
        runToken: childToken,
        pid: result.pid,
        exitCode: result.code,
        signal: result.signal,
        timedOut: result.timedOut
      }
      sessions.push(session)
      assert.equal(result.timedOut, false, `Shortcut ${childStage} session timed out`)
      assert.equal(result.code, 0, `Shortcut ${childStage} session failed: ${result.stderr}`)
      assert.equal(result.signal, null, `${childStage} must reach a normal process exit`)
      const assessment = assessStandaloneReport(
        { directory: childEvidence, startedMs },
        { file: suite, suite, runToken: childToken, mode }
      )
      session.assessment = assessment
      assert.equal(
        assessment.status,
        'passed',
        `${childStage} result must be verified: ${assessment.reason || ''}`
      )
      const childReport = JSON.parse(readFileSync(join(childEvidence, 'standalone.json'), 'utf8'))
      const guiEvidence = JSON.parse(readFileSync(join(childEvidence, 'gui-evidence.json'), 'utf8'))
      session.report = childReport
      assert.equal(childReport.metadata.stage, childStage)
      assert.equal(childReport.profileOwnership, 'runner', 'the parent retains profile ownership')
      assert.equal(childReport.cleanup.reachedWillQuit, true)
      assert.equal(childReport.cleanup.windowsClosed, true)
      assert.equal(guiEvidence.profile, childProfile, 'the child must use its assigned profile')
      for (const key of Object.keys(childBusinessAssertions)) {
        childBusinessAssertions[key] += childReport.assertions[key]
      }
    }
    assert.equal(sessions.length, 3)
    assert.equal(new Set(sessions.map((session) => session.pid)).size, 3)
    assert.equal(new Set(sessions.map((session) => session.runToken)).size, 3)
    assert.equal(new Set(sessions.map((session) => session.evidenceDirectory)).size, 3)
    assert.notEqual(sessions[0].profile, sessions[1].profile)
    assert.equal(
      sessions[1].profile,
      sessions[2].profile,
      'session and restart must share the exact isolated on-disk profile'
    )
    completed = true
  } catch (error) {
    console.error(error)
    failure = error
  } finally {
    await lifecycle.finish({
      completed,
      error: failure,
      summary: {
        sessions,
        childBusinessAssertions,
        assertionCounterScope:
          'parent protocol assertions are counted by this result; childBusinessAssertions is the sum of actual child lifecycle recorder results, without replay'
      },
      restore: restoreTestPatches
    })
  }
}

if (!stage) {
  const controllerProfile = join(testUserData, 'controller-profile')
  mkdirSync(controllerProfile)
  app.setPath('userData', controllerProfile)
  app
    .whenReady()
    .then(runSessions)
    .catch((error) => {
      console.error(error)
      void lifecycle.finish({ error, restore: restoreTestPatches })
    })
} else
  try {
    app.setPath('userData', testUserData)
    process.env.ABANDON_INTEGRATION_TEST = '1'
    process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
    process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve(
      'native_blur',
      'build',
      'bin',
      'blur_engine.dll'
    )
    if (stage === 'session' || stage === 'startup-conflict') seedListView(testUserData)
    if (stage === 'startup-conflict') {
      const db = new Database(join(testUserData, 'app.db'))
      db.prepare(
        "DELETE FROM app_settings WHERE type = 'shortcuts' AND key = 'view_visibility'"
      ).run()
      db.close()
      // Reserve before application startup registers its defaults; these bindings
      // simulate the OS refusing keys owned by another application.
      app.once('ready', () => {
        globalShortcut.register('F1', () => {})
        globalShortcut.register('F2', () => {})
        globalShortcut.register('Control+F1', () => {})
      })
    }

    require(resolve('out', 'main', 'index.js'))
    const mainChunk = readdirSync(resolve('out', 'main', 'chunks')).find((name) =>
      /^index-[\w-]+\.js$/.test(name)
    )
    assert.ok(mainChunk, '未找到构建后的主进程分块')
    require(resolve('out', 'main', 'chunks', mainChunk))
    app.once(
      'ready',
      () =>
        void (stage === 'restart'
          ? verifyRestart()
          : stage === 'startup-conflict'
            ? verifyStartupConflict()
            : runViewVisibilityShortcutTest())
    )
  } catch (error) {
    console.error(error)
    void lifecycle.finish({ error, window: activeWindow, restore: restoreTestPatches })
  }
