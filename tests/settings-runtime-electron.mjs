import { createRequire } from 'node:module'
import { readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/settings-runtime-electron.mjs',
  mode: 'electron-main-app-settings-cross-view',
  metadata: {
    browserWindow: true,
    realRendererAndPreload: true,
    sqlite: 'real-disk',
    remarkFontSize: 'real-input-close-flush-panel-remount-cross-view',
    mainProcessRestart: false,
    views: ['list', 'month', 'week']
  }
})
const { assert } = recorder
const profile = prepareTestProfile({ prefix: 'abandon-settings-runtime-' })
const require = createRequire(import.meta.url)
let completed = false
let failure = null
let exitCode = 0

app.setPath('userData', profile.directory)
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
const seed = new Database(join(profile.directory, 'app.db'))
try {
  createDatabaseSchema(seed)
  const insert = seed.prepare(`INSERT INTO app_settings
    (window_name, type, key, value, remark, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', ?, ?)`)
  const now = Date.now()
  for (const [scope, type, key, value] of [
    ['application', 'application', 'active_view', 'list'],
    ['application', 'remote', 'receive_notices', 'false'],
    ['application', 'remote', 'upload_device_info', 'false'],
    ['application', 'onboarding', 'first_use_notice_version', '1'],
    ['application', 'shortcuts', 'enabled', 'false'],
    ['main', 'system', 'blur_enabled', 'false'],
    ['month', 'system', 'blur_enabled', 'false']
  ])
    insert.run(scope, type, key, value, now, now)
} finally {
  seed.close()
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

async function waitUntil(read, description, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await read()
    if (result) return result
    await wait(25)
  }
  throw new Error(description)
}

function mainWindow() {
  return BrowserWindow.getAllWindows().find((window) =>
    /\/(?:index|month|week)\.html(?:$|[?#])/.test(window.webContents.getURL())
  )
}

function readGeometry(scope) {
  const database = new Database(join(profile.directory, 'app.db'), { readonly: true })
  try {
    return database
      .prepare(
        "SELECT key,value FROM app_settings WHERE window_name=? AND key IN ('pos_x','pos_y','width','height')"
      )
      .all(scope)
  } finally {
    database.close()
  }
}

function readRemarkFontSizes() {
  const database = new Database(join(profile.directory, 'app.db'), { readonly: true })
  try {
    return database
      .prepare(
        "SELECT window_name,type,key,value FROM app_settings WHERE key='note_remark_font_size' ORDER BY window_name"
      )
      .all()
  } finally {
    database.close()
  }
}

app.once('will-quit', (event) => {
  event.preventDefault()
  const cleanup = { status: 'complete' }
  if (profile.ownership === 'script' && !exitCode) {
    try {
      rmSync(profile.directory, { recursive: true, force: true })
    } catch (error) {
      cleanup.status = 'failed'
      cleanup.error = error.message
      exitCode = 1
    }
  }
  if (exitCode) {
    cleanup.status = cleanup.status === 'failed' ? 'failed' : 'preserved'
    cleanup.preservedProfile = profile.directory
  }
  try {
    recorder.finish({
      completed,
      error: failure,
      evidence: { status: 'complete' },
      profileOwnership: profile.ownership,
      cleanup
    })
  } catch (error) {
    console.error(error)
    exitCode = 1
  }
  app.exit(exitCode)
})

async function run() {
  try {
    const window = await waitUntil(mainWindow, 'Settings main window did not load')
    await waitUntil(() => window.isVisible(), 'Settings main window did not become visible')
    const hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
    assert.ok(hooks, 'The existing integration command port is required')
    await waitUntil(
      () => hooks.nativeCaptureState().ready,
      'Capture runtime prerequisite did not become ready'
    )
    const js = (source) => window.webContents.executeJavaScript(source)
    const snapshot = () => js('window.api.getSettingsSnapshot()')
    const remarkInput = '[data-diagnostic-action="settings.noteRemarkFontSize"] input'
    const inputFontSize = () =>
      js(`Number(document.querySelector(${JSON.stringify(remarkInput)})?.value)`)
    const appliedFontSize = () =>
      js(
        `getComputedStyle(document.documentElement).getPropertyValue('--note-remark-font-size').trim()`
      )
    const openSettings = async () => {
      await waitUntil(
        () => js('Boolean(document.querySelector(".titlebar-btn-settings"))'),
        'Settings button did not become ready'
      )
      await js('document.querySelector(".titlebar-btn-settings").click()')
      await waitUntil(
        () => js(`Boolean(document.querySelector('.settings-panel.active ${remarkInput}'))`),
        'Remark font size setting did not open'
      )
      // The panel loads its snapshot asynchronously while its entrance animation runs.
      await wait(400)
    }
    const closeSettings = async () => {
      await js('document.querySelector(".panel-close-btn").click()')
      await waitUntil(
        () => js('!document.querySelector(".settings-panel")'),
        'Settings close must flush a successful remark font size save and unmount the panel'
      )
    }
    const verifyRemarkFontSizeSave = async (mode, value) => {
      const before = await snapshot()
      assert.equal(before.runtime.dock.viewMode, mode)
      assert.notEqual(before.values.css.noteRemarkFontSize, value)
      await js(`
        globalThis.__remarkBroadcasts = [];
        globalThis.__stopRemarkBroadcasts?.();
        globalThis.__stopRemarkBroadcasts = window.api.onSettingsChanged(snapshot =>
          globalThis.__remarkBroadcasts.push(snapshot));
        void 0;
      `)
      await openSettings()
      assert.equal(await inputFontSize(), before.values.css.noteRemarkFontSize)
      await js(`(() => {
        const input = document.querySelector(${JSON.stringify(remarkInput)});
        input.value = ${JSON.stringify(String(value))};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      })()`)
      await waitUntil(
        () => appliedFontSize().then((cssValue) => cssValue === `${value}rem`),
        mode + ' remark font size preview did not apply'
      )
      // Closing immediately exercises the same pending-write flush as the settings UI.
      await closeSettings()
      const saved = await snapshot()
      assert.equal(saved.values.css.noteRemarkFontSize, value)
      assert.ok(saved.revision > before.revision, mode + ' remark save must revise its snapshot')
      const changed = await waitUntil(
        () =>
          js(`globalThis.__remarkBroadcasts.find(snapshot =>
            snapshot.revision === ${saved.revision} &&
            snapshot.values.css.noteRemarkFontSize === ${value})`),
        mode + ' remark font size save did not broadcast its snapshot'
      )
      assert.equal(changed.runtime.dock.viewMode, mode)
      assert.equal(changed.revision, saved.revision)
      assert.equal(changed.values.css.noteRemarkFontSize, value)
      assert.deepEqual(
        readRemarkFontSizes().find((row) => row.window_name === (mode === 'list' ? 'main' : mode)),
        {
          window_name: mode === 'list' ? 'main' : mode,
          type: 'css',
          key: 'note_remark_font_size',
          value: String(value)
        },
        mode + ' remark font size must persist to its real database scope'
      )
      await openSettings()
      assert.equal(
        await inputFontSize(),
        value,
        mode + ' remark font size must survive panel remount'
      )
      assert.equal(await appliedFontSize(), `${value}rem`)
      assert.equal(await js('Boolean(document.querySelector(".settings-save-error"))'), false)
      await closeSettings()
      await js('void globalThis.__stopRemarkBroadcasts()')
    }
    const originalId = window.id
    const originalHandle = window.getNativeWindowHandle().toString('hex')
    const ordinaryBounds = { ...window.getBounds(), x: 50, y: 60, width: 460, height: 700 }
    window.setBounds(ordinaryBounds)
    await waitUntil(() => {
      const rows = Object.fromEntries(
        readGeometry('main').map((row) => [row.key, Number(row.value)])
      )
      return (
        rows.pos_x === ordinaryBounds.x &&
        rows.pos_y === ordinaryBounds.y &&
        rows.width === ordinaryBounds.width &&
        rows.height === ordinaryBounds.height
      )
    }, 'Ordinary geometry did not persist after debounce')
    assert.deepEqual(window.getBounds(), ordinaryBounds)
    const initial = await snapshot()
    assert.equal(initial.runtime.dock.viewMode, 'list')
    assert.equal(
      initial.values.shortcuts.enabled,
      true,
      'The old persisted gate must not disable a new session'
    )
    assert.equal(
      (await snapshot()).revision,
      initial.revision,
      'An unchanged read must not revise settings'
    )
    await js(
      `globalThis.__b1Broadcasts = []; void window.api.onSettingsChanged(s => globalThis.__b1Broadcasts.push(s))`
    )
    await js(`window.api.setSettingValue('notes.tagColorEnabled', false)`)
    const updated = await snapshot()
    assert.equal(updated.values.notes.tagColorEnabled, false)
    assert.ok(updated.revision > initial.revision)
    const broadcast = await waitUntil(
      () => js(`globalThis.__b1Broadcasts.find(s => s.revision === ${updated.revision})`),
      'Settings mutation did not broadcast its snapshot'
    )
    assert.equal(broadcast.values.notes.tagColorEnabled, false)
    assert.equal(broadcast.revision, updated.revision)
    hooks
      .getTrayMenuTemplate()
      .find((item) => item.id === 'toggle-global-shortcuts')
      .click()
    const paused = await snapshot()
    assert.equal(paused.values.shortcuts.enabled, false)
    assert.ok(paused.revision > updated.revision)
    const remarkFontSizes = { list: 14, month: 20, week: 22 }
    await verifyRemarkFontSizeSave('list', remarkFontSizes.list)
    for (const mode of ['month', 'week']) {
      const sourceScope = mode === 'month' ? 'main' : 'month'
      const pending = { ...window.getBounds(), x: window.getBounds().x + 10 }
      window.setBounds(pending)
      assert.equal(await hooks.switchMainView(mode), true)
      assert.equal(mainWindow().id, originalId, 'The main BrowserWindow must be reused')
      assert.equal(window.getNativeWindowHandle().toString('hex'), originalHandle)
      const saved = Object.fromEntries(
        readGeometry(sourceScope).map((row) => [row.key, Number(row.value)])
      )
      assert.equal(saved.pos_x, pending.x, 'Pending source geometry must commit before navigation')
      const switched = await snapshot()
      assert.equal(switched.runtime.dock.viewMode, mode)
      assert.equal(switched.values.notes.tagColorEnabled, false)
      assert.equal(switched.values.shortcuts.enabled, false)
      assert.ok(switched.revision > paused.revision)
      assert.equal((await snapshot()).revision, switched.revision)
      await verifyRemarkFontSizeSave(mode, remarkFontSizes[mode])
    }
    for (const mode of ['list', 'month', 'week']) {
      assert.equal(await hooks.switchMainView(mode), true)
      const restored = await snapshot()
      assert.equal(restored.runtime.dock.viewMode, mode)
      assert.equal(
        restored.values.css.noteRemarkFontSize,
        remarkFontSizes[mode],
        mode + ' must restore its own saved remark font size after navigation'
      )
      await openSettings()
      assert.equal(await inputFontSize(), remarkFontSizes[mode])
      assert.equal(await appliedFontSize(), `${remarkFontSizes[mode]}rem`)
      assert.equal(await js('Boolean(document.querySelector(".settings-save-error"))'), false)
      await closeSettings()
    }
    assert.deepEqual(
      readRemarkFontSizes(),
      Object.entries({
        main: remarkFontSizes.list,
        month: remarkFontSizes.month,
        week: remarkFontSizes.week
      }).map(([scope, value]) => ({
        window_name: scope,
        type: 'css',
        key: 'note_remark_font_size',
        value: String(value)
      })),
      'The three independently saved remark font sizes must not overwrite another view or application scope'
    )
    const beforeReset = await snapshot()
    const reset = await js('window.api.resetSettings()')
    assert.equal(reset.values.notes.tagColorEnabled, true)
    assert.equal(
      reset.values.shortcuts.enabled,
      false,
      'Stored-default reset must preserve the session gate'
    )
    assert.equal(reset.runtime.dock.viewMode, 'week')
    assert.ok(reset.revision > beforeReset.revision)
    assert.equal((await snapshot()).revision, reset.revision)
    await wait(1000)
    assert.equal(
      readGeometry('week').length,
      0,
      'Reset must not reinsert geometry during suppression or shutdown'
    )
    completed = true
  } catch (error) {
    failure = error
    exitCode = 1
    console.error(error)
  } finally {
    app.quit()
  }
}

try {
  require(resolve('out/main/index.js'))
  const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(chunk, 'A current application main chunk is required')
  require(resolve('out/main/chunks', chunk))
  app.once('ready', () => void run())
} catch (error) {
  failure = error
  exitCode = 1
  console.error(error)
  app.quit()
}
