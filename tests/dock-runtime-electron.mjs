import { createRequire } from 'node:module'
import { rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, screen } from 'electron'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { NATIVE_ABI_VERSION } from '../src/shared/native-abi-version.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/dock-runtime-electron.mjs',
  mode: 'electron-real-app-dock-owner-native-state',
  metadata: {
    browserWindow: true,
    nativeAbi: NATIVE_ABI_VERSION,
    side: 'left',
    commandDriven: true,
    realPointerInput: false,
    realDisplayRemoval: false
  }
})
const { assert } = recorder
const profile = prepareTestProfile({ prefix: 'abandon-dock-runtime-' })
const snapshots = []
let commands
let completed = false
let failure
let exitCode = 0
app.setPath('userData', profile.directory)
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
const seed = new Database(join(profile.directory, 'app.db'))
try {
  createDatabaseSchema(seed)
  const insert = seed.prepare(`INSERT INTO app_settings
    (window_name,type,key,value,remark,created_at,updated_at) VALUES(?,?,?,?,'',?,?)`)
  const now = Date.now()
  for (const [scope, type, key, value] of [
    ['application', 'remote', 'receive_notices', 'false'],
    ['application', 'remote', 'upload_device_info', 'false'],
    ['application', 'application', 'active_view', 'list'],
    ['application', 'onboarding', 'first_use_notice_version', '1'],
    ['main', 'system', 'blur_enabled', 'false'],
    ['main', 'dock', 'enabled_edges', '[]']
  ])
    insert.run(scope, type, key, value, now, now)
} finally {
  seed.close()
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(read, label) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await wait(25)
  }
  throw new Error(label)
}
function geometry() {
  const database = new Database(join(profile.directory, 'app.db'), { readonly: true })
  try {
    return Object.fromEntries(
      database
        .prepare(
          "SELECT key,value FROM app_settings WHERE window_name='main' AND key IN ('pos_x','pos_y','width','height')"
        )
        .all()
        .map(({ key, value }) => [key, Number(value)])
    )
  } finally {
    database.close()
  }
}
function capture(label) {
  const snapshot = commands.snapshot()
  snapshots.push({ label, snapshot, resources: commands.resources() })
  return snapshot
}
async function visible() {
  return until(() => {
    const state = commands.snapshot()
    return !state.isDockHidden && !state.isSliding && !state.hasDockMotionSession && state
  }, 'Dock did not converge to the visible state')
}
async function run() {
  try {
    const window = await until(
      () =>
        BrowserWindow.getAllWindows().find((candidate) =>
          /\/index\.html(?:$|[?#])/.test(candidate.webContents.getURL())
        ),
      'Main window did not load'
    )
    await until(() => window.isVisible(), 'Main window did not become visible')
    const hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
    assert.ok(hooks)
    commands = hooks.dockCommands
    assert.ok(commands, 'Actual application Dock commands must be wired')
    await until(() => hooks.nativeCaptureState().ready, 'Capture prerequisite did not become ready')
    const js = (code) => window.webContents.executeJavaScript(code)
    const workArea = screen.getDisplayMatching(window.getBounds()).workArea
    window.setBounds({ x: workArea.x + 80, y: workArea.y + 70, width: 460, height: 650 })
    await until(() => geometry().pos_x === workArea.x + 80, 'Ordinary geometry did not persist')
    await js("window.api.setDockConfig({enabledEdges:['left'],revealHandleMode:'persistent'})")
    window.setPosition(workArea.x, workArea.y + 70)
    assert.equal(
      commands.syncVisible({ source: 'test-left-edge', snap: true, forceSnap: true }),
      'left'
    )
    const before = capture('visible-left')
    assert.equal(before.dockSide, 'left')
    assert.deepEqual(before.activeDockEdges, ['left'])
    const storedBeforeHide = geometry()
    commands.hide()
    const hidden = await until(() => {
      const state = commands.snapshot()
      return (
        state.isDockHidden &&
        !state.isSliding &&
        state.mainAtHiddenTarget &&
        state.edgeMonitor.persistentHandleActivated &&
        state
      )
    }, 'Actual Dock did not reach its hidden target and activate the handle')
    capture('hidden-left')
    assert.equal(hidden.hasDockMotionSession, true)
    assert.equal(hidden.sessionSide, 'left')
    assert.equal(hidden.edgeMonitor.supported, true)
    assert.equal(hidden.edgeMonitor.workerAlive, true)
    assert.equal(hidden.edgeMonitor.generation, hidden.sessionGeneration)
    assert.equal(hidden.mainAtHiddenTarget, true)
    assert.ok(hidden.session.stableBounds.x >= workArea.x)
    await wait(1100)
    assert.deepEqual(
      geometry(),
      storedBeforeHide,
      'Hidden animation must not persist off-screen geometry'
    )
    commands.show('test-show')
    const shown = await visible()
    capture('shown-left')
    assert.equal(shown.edgeMonitor.workerAlive, false)
    assert.equal(shown.mainMotionBounds.x, hidden.session.motionPlan.visibleTarget.x)
    assert.equal(shown.mainMotionBounds.y, hidden.session.motionPlan.visibleTarget.y)
    commands.hide()
    assert.equal(commands.snapshot().isSliding, true)
    commands.show('test-show-during-hide')
    const queued = await visible()
    assert.equal(queued.edgeMonitor.workerAlive, false)
    assert.equal(queued.hasDockMotionSession, false)
    capture('queued-show-converged')
    commands.suspend('test-outer')
    commands.suspend('test-inner')
    assert.equal(hooks.getDockRuntimeState().interactionSuspendCount, 2)
    commands.hide()
    assert.equal(commands.snapshot().isDockHidden, false)
    commands.resume('test-inner')
    commands.hide()
    assert.equal(hooks.getDockRuntimeState().interactionSuspendCount, 1)
    assert.equal(commands.snapshot().isDockHidden, false)
    commands.resume('test-outer')
    commands.resume('test-extra')
    assert.equal(hooks.getDockRuntimeState().interactionSuspendCount, 0)
    const motionRows = async () =>
      (await js("window.api.queryLogs({ search: 'performance.window-', limit: 500 })")).items
    assert.equal((await motionRows()).length, 0, 'Daily Dock must not emit detailed motion metrics')
    const policy = await js('window.api.startDeepDiagnostics()')
    await until(
      () => js("window.api.getDiagnosticPolicy().mode === 'deep'"),
      'Deep policy not applied'
    )
    await js('window.api.setBlurConfig({ enabled: true })')
    commands.hide()
    // Block the main loop after scheduling the existing timer. Its first callback
    // must report late delivery while move/API duration remains a separate stage.
    const deadline = performance.now() + 90
    while (performance.now() < deadline) {
      /* Controlled timer delay. */
    }
    await until(
      () => commands.snapshot().isDockHidden && !commands.snapshot().isSliding,
      'Balanced suspension did not restore hide admission'
    )
    const motion = await until(async () => {
      const rows = await motionRows()
      return rows.some((row) => row.scope === 'performance.window-dock-animation') && rows
    }, 'Dock timing batch not persisted')
    const animation = motion.find((row) => row.scope === 'performance.window-dock-animation')
    assert.equal(animation.captureId, policy.captureId)
    assert.equal(animation.metadata.counters.callbacks, animation.metadata.plannedCallbacks)
    assert.ok(
      animation.metadata.stages.callbackLateBy.maxMs >= 60,
      'Main timer blockage not attributed to callback delay'
    )
    assert.ok(animation.metadata.stages.moveAndValidation.count > 0)
    assert.ok(animation.metadata.stages.animationElapsed.count === 1)
    assert.ok(
      motion.some(
        (row) =>
          row.scope === 'performance.window-motion-native' && row.metadata.stages.move.count > 0
      )
    )
    snapshots.push({ label: 'deep-motion-attribution', metrics: motion })
    await js('window.api.stopDeepDiagnostics()')
    await until(
      () => js("window.api.getDiagnosticPolicy().mode === 'daily'"),
      'Daily policy not restored'
    )
    const stoppedCount = (await motionRows()).length
    commands.show('after-deep-stop')
    await visible()
    commands.hide()
    await until(
      () => commands.snapshot().isDockHidden && !commands.snapshot().isSliding,
      'Daily hide did not finish'
    )
    assert.equal(
      (await motionRows()).length,
      stoppedCount,
      'Motion sampling continued after deep stop'
    )
    await js("window.api.setDockConfig({enabledEdges:[],revealHandleMode:'direct'})")
    const disabled = await visible()
    capture('config-disabled')
    assert.deepEqual(disabled.activeDockEdges, [])
    assert.equal(disabled.dockSide, null)
    assert.equal(disabled.edgeMonitor.workerAlive, false)
    assert.equal(commands.resources().observer, false)
    completed = true
  } catch (error) {
    failure = error
    exitCode = 1
  }
  app.quit()
}
app.once('will-quit', (event) => {
  event.preventDefault()
  let cleanup = { status: 'complete' }
  try {
    if (completed) {
      const resources = commands.resources()
      snapshots.push({ label: 'shutdown', resources })
      assert.equal(resources.stopping, true)
      assert.equal(resources.disposed, true)
      assert.equal(resources.attached, false)
      for (const key of ['slideTimer', 'hideTimer', 'geometryTimer', 'cleanupTimer', 'observer'])
        assert.equal(resources[key], false, key + ' must be released')
      assert.equal(resources.displayListeners, 0)
      assert.equal(resources.powerListeners, 0)
    }
    if (process.env.ABANDON_TEST_EVIDENCE_DIR)
      writeFileSync(
        join(process.env.ABANDON_TEST_EVIDENCE_DIR, 'dock-snapshots.json'),
        JSON.stringify(snapshots, null, 2)
      )
    if (profile.ownership === 'script' && completed)
      rmSync(profile.directory, { recursive: true, force: true })
    else if (!completed) cleanup = { status: 'preserved', preservedProfile: profile.directory }
  } catch (error) {
    failure ||= error
    completed = false
    exitCode = 1
    cleanup = { status: 'failed', error: error.message, preservedProfile: profile.directory }
  }
  recorder.finish({
    completed,
    error: failure,
    evidence: { status: 'complete' },
    profileOwnership: profile.ownership,
    cleanup
  })
  app.exit(exitCode)
})
app
  .whenReady()
  .then(run)
  .catch((error) => {
    failure = error
    exitCode = 1
    app.quit()
  })
createRequire(import.meta.url)(resolve('out/main/index.js'))
