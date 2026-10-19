import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/feature-runtime-electron.mjs',
  mode: 'electron-ready-real-app-feature-clear-tray-activation',
  metadata: {
    realMainComposition: true,
    realRendererAndPreload: true,
    realStickyWindows: true,
    realTray: true,
    sqlite: 'real-disk',
    controlledTiming: 'hold only real sticky ready IPC and renderer draft completion',
    osToastOrProtocolRegistration: false,
    mainProcessRestart: false,
    weatherNetwork: false
  }
})
const { assert } = recorder
const profile = prepareTestProfile({ prefix: 'abandon-feature-runtime-' })
app.setPath('userData', profile.directory)
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
process.argv.push('abandon-note://notification/open?id=legacy')
const seed = new Database(join(profile.directory, 'app.db'))
createDatabaseSchema(seed)
const put = seed.prepare('INSERT INTO app_settings(window_name,type,key,value) VALUES(?,?,?,?)')
for (const row of [
  ['application', 'application', 'active_view', 'list'],
  ['application', 'remote', 'receive_notices', 'false'],
  ['application', 'remote', 'upload_device_info', 'false'],
  ['application', 'onboarding', 'first_use_notice_version', '1'],
  ...['main', 'month', 'week'].map((scope) => [scope, 'system', 'blur_enabled', 'false'])
])
  put.run(...row)
seed.close()

let holdReady = false,
  readyBlocked = false,
  releaseReady
let inClearRequest = false,
  failReminderQuery = null
const injectedReminderQueryFailures = []
const originalPrepare = Database.prototype.prepare
Database.prototype.prepare = function (sql, ...args) {
  const activeQuery = /WHERE r\.state = 'active'/.test(String(sql))
  const nextQuery = /SELECT MIN\(r\.due_at\)/.test(String(sql))
  if (
    inClearRequest &&
    this.name === join(profile.directory, 'app.db') &&
    ((failReminderQuery === 'active' && activeQuery) || (failReminderQuery === 'next' && nextQuery))
  ) {
    const query = failReminderQuery
    failReminderQuery = null
    injectedReminderQueryFailures.push({ query, sql: String(sql) })
    throw new Error(`integration committed reminder ${query} SELECT failure`)
  }
  return originalPrepare.call(this, sql, ...args)
}
const delayedReady = new Promise((resolveReady) => {
  releaseReady = resolveReady
})
const originalHandle = ipcMain.handle
ipcMain.handle = function (channel, handler) {
  return originalHandle.call(
    this,
    channel,
    channel === 'sticky:ready'
      ? async (...args) => {
          if (holdReady) {
            readyBlocked = true
            await delayedReady
          }
          return handler(...args)
        }
      : channel === 'clear-note-data'
        ? async (...args) => {
            inClearRequest = true
            try {
              return await handler(...args)
            } finally {
              inClearRequest = false
            }
          }
        : handler
  )
}
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))
async function until(predicate, label, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await predicate()) return
    await wait(25)
  }
  throw new Error(label)
}
const hooks = () => globalThis.__ABANDON_WINDOW_TEST_HOOKS__
let sawEarlyReveal = false
app.on('browser-window-created', () => {
  if (hooks()?.notificationActivationState?.().pendingReveal) sawEarlyReveal = true
})
let window,
  db,
  failure = null,
  completed = false,
  reachedWillQuit = false
let closing = false,
  evidence = { status: 'incomplete' }
const cleanupErrors = [],
  snapshots = {}
const js = (source) => window.webContents.executeJavaScript(source)
const queryCount = (table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count
const watchdog = setTimeout(() => {
  failure ||= new Error('feature runtime suite timed out')
  Database.prototype.prepare = originalPrepare
  releaseReady()
  app.exit(1)
}, 90000)

app.once('will-quit', () => {
  reachedWillQuit = true
  try {
    snapshots.shutdown = {
      feature: hooks().featureState(),
      tray: hooks().trayState(),
      activation: hooks().notificationActivationState(),
      shutdown: hooks().shutdownState()
    }
    assert.equal(snapshots.shutdown.feature.disposed, true)
    assert.equal(snapshots.shutdown.feature.subscriptions, 0)
    assert.ok(
      Object.values(snapshots.shutdown.feature.resources).every((status) =>
        ['disposed', 'disposed-by-parent'].includes(status)
      ),
      'Every actually constructed feature resource must be disposed once'
    )
    assert.deepEqual(snapshots.shutdown.tray, { created: false, disposed: true })
    assert.equal(snapshots.shutdown.activation.disposed, true)
    assert.equal(snapshots.shutdown.shutdown.completed, true)
    assert.equal(snapshots.shutdown.shutdown.stages.database.status, 'complete')
    writeFileSync(
      join(
        process.env.ABANDON_TEST_EVIDENCE_DIR || profile.directory,
        'feature-disposal-final.json'
      ),
      JSON.stringify(snapshots.shutdown, null, 2),
      { flag: 'wx' }
    )
  } catch (error) {
    failure ||= error
    process.exitCode = 1
  }
})
app.once('quit', (_event, code) => {
  clearTimeout(watchdog)
  try {
    db?.close()
  } catch (error) {
    cleanupErrors.push(error.message)
  }
  recorder.finish({
    completed: completed && !failure,
    error: failure,
    evidence,
    profileOwnership: profile.ownership,
    cleanup: {
      status:
        reachedWillQuit && cleanupErrors.length === 0 && !failure
          ? profile.ownership === 'runner'
            ? 'complete'
            : 'preserved'
          : 'failed',
      reachedWillQuit,
      exitCode: code,
      errors: cleanupErrors,
      scope:
        'Actual product before-quit, feature ledger, database, tray and windows; runner owns profile'
    }
  })
})

async function fail(error) {
  if (closing) return
  closing = true
  failure = error
  process.exitCode = 1
  ipcMain.handle = originalHandle
  Database.prototype.prepare = originalPrepare
  releaseReady()
  for (const target of BrowserWindow.getAllWindows()) if (!target.isDestroyed()) target.destroy()
  app.quit()
}

async function run() {
  try {
    createRequire(import.meta.url)(resolve('out/main/index.js'))
    await until(() => {
      window = BrowserWindow.getAllWindows().find((item) =>
        /\/index\.html(?:$|[?#])/.test(item.webContents.getURL())
      )
      return (
        window?.isVisible() &&
        hooks()?.nativeCaptureState().ready &&
        hooks()?.featureState().scheduled
      )
    }, 'Actual application and feature prerequisites did not become ready')
    ipcMain.handle = originalHandle
    db = new Database(join(profile.directory, 'app.db'))
    await until(
      () =>
        js('Boolean(window.__clearEditingDrafts && document.querySelector(".nnp-root textarea"))'),
      'Mounted draft form missing'
    )
    snapshots.start = hooks().featureState()
    assert.equal(snapshots.start.resources.sticky, 'created')
    assert.equal(snapshots.start.resources.reminders, 'created')
    assert.equal(snapshots.start.resources.weather, 'created')
    assert.equal(snapshots.start.resources.notification, 'transferred')
    assert.deepEqual(hooks().trayState(), { created: true, disposed: false })
    assert.equal(
      sawEarlyReveal,
      true,
      'Startup protocol must queue before the actual main window exists'
    )
    await until(
      () => !hooks().notificationActivationState().pendingReveal,
      'Startup protocol reveal was not consumed'
    )
    assert.equal(hooks().notificationActivationState().pendingActions, 0)

    const shortcut = () =>
      hooks()
        .trayMenu()
        .find((item) => item.id === 'toggle-global-shortcuts')
    const oldChecked = shortcut().checked
    shortcut().click()
    assert.equal(shortcut().checked, !oldChecked)
    shortcut().click()
    assert.equal(shortcut().checked, oldChecked)
    window.focus()
    await until(() => window.isFocused(), 'Real main window did not focus before the hide gesture')
    hooks().triggerTrayClick()
    await until(() => !window.isVisible(), 'Actual tray click did not hide the window')
    hooks().triggerTrayClick()
    await until(() => window.isVisible(), 'Actual tray click did not show the window')
    window.hide()
    assert.equal(
      hooks().handleNotificationProtocol('abandon-note://notification/open?id=old', 'integration'),
      true
    )
    await until(
      () => window.isVisible() && !hooks().notificationActivationState().pendingReveal,
      'Notification activation did not reveal current main window'
    )
    assert.equal(
      queryCount('notes'),
      0,
      'Legacy notification ID must not create or target business data'
    )

    const note = await js('window.api.createNote({content:"真实便利贴迟到创建"})')
    assert.ok(note.id > 0)
    await js(`(() => {
      const field = document.querySelector('.nnp-root textarea')
      field.value = '清空前 mounted 草稿'
      field.dispatchEvent(new Event('input',{bubbles:true}))
      return true
    })()`)
    assert.equal(await js('window.__prepareEditingDrafts().dirty'), true)
    holdReady = true
    await js(
      `void window.api.createSticky(${note.id}).then(value => {window.__featureStickyResult=value})`
    )
    await until(
      () => readyBlocked && hooks().businessMutationState().pending > 0,
      'Sticky create did not reach controlled real ready IPC'
    )
    assert.equal(queryCount('desktop_stickies'), 0)
    await js(
      'void window.api.clearNoteData().then(value => {window.__featureClearResult={value}}, error => {window.__featureClearResult={error:error.message}})'
    )
    await until(() => hooks().businessMutationState().clearing, 'Clear did not seal admission')
    assert.equal(await js('typeof window.__featureClearResult'), 'undefined')
    assert.equal(
      queryCount('notes'),
      1,
      'Clear must not delete before admitted sticky create settles'
    )
    const blocked = await js(
      'window.api.createNote({content:"迟到新写"}).then(()=>"unexpected",error=>error.message)'
    )
    assert.ok(blocked.includes('正在清空'))
    releaseReady()
    holdReady = false
    await until(
      () => js('Boolean(window.__featureStickyResult && window.__featureClearResult)'),
      'Old creation and clear did not both settle'
    )
    assert.equal(
      await js('window.__featureStickyResult.ok'),
      true,
      'Previously admitted create must survive independent ready IPC'
    )
    assert.equal(await js('window.__featureClearResult.value'), true)
    assert.equal(queryCount('notes'), 0)
    assert.equal(queryCount('desktop_stickies'), 0)
    assert.equal(
      BrowserWindow.getAllWindows().filter((item) =>
        /\/sticky\.html/.test(item.webContents.getURL())
      ).length,
      0
    )
    assert.equal(await js('window.__prepareEditingDrafts().dirty'), false)
    assert.equal(
      await js(
        'Object.keys(localStorage).filter(key=>key.startsWith("abandon:editing-draft:")).length'
      ),
      0
    )

    await js(`(() => {
      window.__s7ClearBroadcasts = 0
      window.__s7StopClearBroadcasts = window.api.onNotesChanged(event => {
        if (event?.reason === 'note-data-cleared') window.__s7ClearBroadcasts++
      })
    })()`)
    for (const query of ['active', 'next']) {
      const oldNote = await js('window.api.createNote({content:"提交后提醒查询失败保护"})')
      const oldSticky = await js(`window.api.createSticky(${oldNote.id})`)
      assert.equal(oldSticky.ok, true)
      await js(`(() => {
        const field = document.querySelector('.nnp-root textarea')
        field.value = '提醒查询失败也必须清理的草稿'
        field.dispatchEvent(new Event('input', {bubbles:true}))
      })()`)
      assert.equal(await js('window.__prepareEditingDrafts().dirty'), true)
      const previousBroadcasts = await js('window.__s7ClearBroadcasts')
      failReminderQuery = query
      const failureMessage = await js(
        'window.api.clearNoteData().then(()=>"unexpected",error=>error.message)'
      )
      assert.ok(
        failureMessage.includes('业务数据已清空') && failureMessage.includes('提醒清理失败')
      )
      assert.ok(failureMessage.includes('无需再次清空数据'))
      assert.equal(queryCount('notes'), 0)
      assert.equal(queryCount('note_attachments'), 0)
      assert.equal(queryCount('desktop_stickies'), 0)
      assert.equal(
        BrowserWindow.getAllWindows().filter((item) =>
          /\/sticky\.html/.test(item.webContents.getURL())
        ).length,
        0
      )
      assert.equal(await js('window.__prepareEditingDrafts().dirty'), false)
      assert.equal(
        await js(
          'Object.keys(localStorage).filter(key=>key.startsWith("abandon:editing-draft:")).length'
        ),
        0
      )
      await until(
        () => js(`window.__s7ClearBroadcasts > ${previousBroadcasts}`),
        'Committed clear must broadcast after reminder SELECT failure'
      )
      assert.equal(hooks().businessMutationState().clearing, false)
      const newNote = await js('window.api.createNote({content:"清空收尾失败后可合法新建"})')
      assert.ok(newNote.id > 0)
      assert.equal(queryCount('notes'), 1)
    }
    assert.deepEqual(
      injectedReminderQueryFailures.map((item) => item.query),
      ['active', 'next']
    )
    snapshots.committedReminderFailures = injectedReminderQueryFailures
    Database.prototype.prepare = originalPrepare
    await js(
      'window.__s7StopClearBroadcasts(); void (window.__testDraftClear=window.__clearEditingDrafts)'
    )
    await js(
      'void (window.__clearEditingDrafts=async()=>{throw new Error("integration committed draft failure")})'
    )
    const clearError = await js(
      'window.api.clearNoteData().then(()=>"unexpected",error=>error.message)'
    )
    assert.ok(clearError.includes('业务数据已清空') && clearError.includes('草稿清理失败'))
    assert.equal(queryCount('notes'), 0)
    const next = await js('window.api.createNote({content:"清空后新建成功"})')
    assert.ok(next.id > 0)
    assert.equal(queryCount('notes'), 1)
    await js('void (window.__clearEditingDrafts=window.__testDraftClear)')

    // Last clear deliberately pauses after SQL commit while the product quits.
    await js(`void (window.__clearEditingDrafts=async()=>{
      window.__featureDraftEntered=true
      await new Promise(resolve=>{window.__featureReleaseDraft=resolve})
      return window.__testDraftClear()
    }); void window.api.clearNoteData().then(value=>{window.__featureFinalClear=value})`)
    await until(
      () => js('Boolean(window.__featureDraftEntered)'),
      'Final clear did not reach renderer draft completion'
    )
    assert.equal(queryCount('notes'), 0)
    app.quit()
    app.quit()
    app.quit()
    await until(
      () => hooks().shutdownState().activeStage === 'business-mutations',
      'Shutdown did not wait at business mutation/clear drain'
    )
    assert.equal(reachedWillQuit, false)
    assert.equal(hooks().businessMutationState().clearing, true)
    assert.equal(hooks().featureState().resources.sticky, 'created')
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
    const output = process.env.ABANDON_TEST_EVIDENCE_DIR || profile.directory
    const png = (await window.webContents.capturePage()).toPNG()
    writeFileSync(join(output, 'feature-runtime-final.png'), png, { flag: 'wx' })
    snapshots.beforeDrainRelease = {
      feature: hooks().featureState(),
      admission: hooks().businessMutationState(),
      shutdown: hooks().shutdownState()
    }
    writeFileSync(
      join(output, 'feature-runtime-evidence.json'),
      JSON.stringify(
        { snapshots, screenshotSha256: createHash('sha256').update(png).digest('hex') },
        null,
        2
      ),
      { flag: 'wx' }
    )
    evidence = {
      status: 'complete',
      artifacts: [
        'feature-runtime-final.png',
        'feature-runtime-evidence.json',
        'feature-disposal-final.json'
      ]
    }
    completed = true
    closing = true
    await js('void window.__featureReleaseDraft()')
    // The running shutdown coordinator now owns the normal final app.quit().
  } catch (error) {
    await fail(error)
  }
}
void run()
