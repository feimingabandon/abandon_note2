import { rm } from 'node:fs/promises'
import { app } from 'electron'
import {
  initDatabase,
  closeDatabase,
  getDb,
  getAllSettings as facadeRead,
  setSettingsBatch as facadeWrite,
  clearAllSettings as facadeClearAll,
  clearSettings as facadeClear
} from '../src/main/db/db.js'
import {
  getAllSettings,
  setSettingsBatch,
  clearSettings,
  clearAllSettings
} from '../src/main/db/db-settings-repository.js'
import { createNote, getNoteById } from '../src/main/db/db-notes.js'
import {
  ensureViewSettingsInitialized,
  getViewSettingsScope,
  readApplicationSettings,
  writeApplicationSettings,
  resetCurrentViewSettings
} from '../src/main/settings/application-settings.js'
import { createSettingsRuntime } from '../src/main/settings/settings-runtime.js'
import { serializeSetting } from '../src/shared/settings-schema.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/settings-repository-db.mjs',
  mode: 'electron-ready-disk-sqlite-reopen-settings',
  metadata: { browserWindow: false, mainProcessRestart: false, diskDatabase: true }
})
const { assert } = recorder

app.once('ready', async () => {
  let profile = null
  let completed = false
  let failure = null
  let exitCode = 0
  const cleanupErrors = []
  try {
    profile = prepareTestProfile({ prefix: 'abandon-settings-db-' })
    app.setPath('userData', profile.directory)
    assert.equal(initDatabase().isNewDatabase, true)
    assert.equal(facadeRead, getAllSettings)
    assert.equal(facadeWrite, setSettingsBatch)
    assert.equal(facadeClear, clearSettings)
    assert.equal(facadeClearAll, clearAllSettings)
    const note = createNote({ content: 'B1 保留业务行' })
    assert.equal(getNoteById(note.id).content, 'B1 保留业务行')

    setSettingsBatch('main', [{ type: 'first', key: 'same_key', value: 'old', remark: 'initial' }])
    const original = getAllSettings('main')[0]
    setSettingsBatch('main', [{ type: 'second', key: 'same_key', value: 42, remark: 'updated' }])
    const changed = getAllSettings('main')
    assert.equal(changed.length, 1)
    assert.equal(changed[0].type, 'second')
    assert.equal(changed[0].value, '42')
    assert.equal(changed[0].created_at, original.created_at)
    assert.equal(changed[0].remark, 'updated')
    setSettingsBatch('month', [{ type: 'second', key: 'same_key', value: null }])
    assert.equal(getAllSettings('month')[0].value, null)
    assert.equal(getAllSettings('main')[0].value, '42')

    getDb().exec(`CREATE TEMP TRIGGER b1_settings_failure BEFORE INSERT ON app_settings
      WHEN NEW.key = 'b1_reject' BEGIN SELECT RAISE(ABORT, 'injected settings write'); END;`)
    assert.throws(
      () =>
        setSettingsBatch('main', [
          { type: 'second', key: 'same_key', value: 'must rollback' },
          { type: 'second', key: 'b1_reject', value: 'reject' }
        ]),
      /injected settings write/
    )
    assert.deepEqual(getAllSettings('main'), changed)
    getDb().exec('DROP TRIGGER b1_settings_failure')
    assert.equal(setSettingsBatch('main', []), undefined)

    writeApplicationSettings([
      { id: 'weather.enabled', value: true },
      { id: 'almanac.enabled', value: false },
      { id: 'window.lockState', value: true }
    ])
    setSettingsBatch('month', [serializeSetting('geometry.width', 1200)])
    assert.equal(ensureViewSettingsInitialized('week'), true)
    const inherited = getAllSettings('week')
    assert.equal(inherited.find((row) => row.key === 'width')?.value, '1200')
    assert.equal(readApplicationSettings().weather.enabled, true)
    assert.equal(readApplicationSettings().almanac.enabled, false)
    assert.equal(readApplicationSettings().window.lockState, true)

    let view = 'month'
    const runtime = createSettingsRuntime({
      getViewMode: () => view,
      readApplication: readApplicationSettings,
      readViewRows: (mode) => getAllSettings(getViewSettingsScope(mode)),
      readRuntime: () => ({ autoStart: { value: false, error: null } })
    })
    runtime.refresh()
    runtime.setShortcutsEnabled(false)
    view = 'week'
    runtime.resetForView(view)
    runtime.refresh({ incrementRevision: true })
    assert.equal(runtime.snapshot().values.geometry.width, 1200)
    assert.equal(runtime.snapshot().values.weather.enabled, true)
    assert.equal(runtime.snapshot().values.almanac.enabled, false)
    assert.equal(runtime.snapshot().values.shortcuts.enabled, false)
    assert.equal(runtime.revision, 3)

    closeDatabase()
    assert.throws(() => getAllSettings('main'), /数据库尚未初始化/)
    assert.equal(initDatabase().isNewDatabase, false)
    assert.equal(readApplicationSettings().almanac.enabled, false)
    assert.equal(getAllSettings('main')[0].value, '42')
    assert.equal(readApplicationSettings().weather.enabled, true)
    assert.deepEqual(getAllSettings('week'), inherited)
    assert.equal(ensureViewSettingsInitialized('week'), false)
    assert.equal(clearSettings('week'), inherited.length)
    assert.equal(ensureViewSettingsInitialized('week'), false)
    assert.deepEqual(getAllSettings('week'), [])
    assert.equal(getAllSettings('month').find((row) => row.key === 'width')?.value, '1200')
    assert.equal(readApplicationSettings().weather.enabled, true)
    assert.equal(getNoteById(note.id).content, 'B1 保留业务行')
    setSettingsBatch('main', [serializeSetting('geometry.width', 777)])
    const beforeResetApplication = getAllSettings('application')
    const beforeResetMain = getAllSettings('main')
    const beforeResetMonth = getAllSettings('month')
    getDb().exec(`CREATE TEMP TRIGGER q001_reset_failure BEFORE DELETE ON app_settings
      WHEN OLD.window_name='main' BEGIN SELECT RAISE(ABORT,'Q001 view reset failure'); END`)
    assert.throws(() => resetCurrentViewSettings('list'), /Q001 view reset failure/)
    assert.deepEqual(getAllSettings('application'), beforeResetApplication)
    assert.deepEqual(getAllSettings('main'), beforeResetMain)
    assert.deepEqual(getAllSettings('month'), beforeResetMonth)
    getDb().exec('DROP TRIGGER q001_reset_failure')
    const resetResult = resetCurrentViewSettings('list')
    assert.ok(resetResult.resetApplicationSettingCount > 0)
    assert.equal(resetResult.clearedViewSettingCount, beforeResetMain.length)
    assert.deepEqual(getAllSettings('main'), [])
    assert.deepEqual(getAllSettings('month'), beforeResetMonth)
    assert.equal(readApplicationSettings().weather.enabled, false)
    assert.equal(readApplicationSettings().almanac.enabled, true)
    assert.equal(getNoteById(note.id).content, 'B1 保留业务行')
    const settingsCount = getDb().prepare('SELECT COUNT(*) AS count FROM app_settings').get().count
    assert.equal(clearAllSettings(), settingsCount)
    assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM app_settings').get().count, 0)
    assert.equal(getNoteById(note.id).content, 'B1 保留业务行')
    completed = true
  } catch (error) {
    failure = error
    exitCode = 1
    console.error(error)
  } finally {
    try {
      closeDatabase()
    } catch (error) {
      cleanupErrors.push(error.message)
      exitCode = 1
    }
    if (profile?.ownership === 'script' && !exitCode) {
      try {
        await rm(profile.directory, { recursive: true, force: true })
      } catch (error) {
        cleanupErrors.push(error.message)
        exitCode = 1
      }
    }
    try {
      recorder.finish({
        completed,
        error: failure,
        evidence: { status: 'complete' },
        profileOwnership: profile?.ownership,
        cleanup: {
          status: cleanupErrors.length ? 'failed' : exitCode ? 'preserved' : 'complete',
          ...(cleanupErrors.length ? { error: cleanupErrors.join('\n') } : {}),
          ...(exitCode && profile ? { preservedProfile: profile.directory } : {})
        }
      })
    } catch (error) {
      console.error(error)
      exitCode = 1
    }
    app.exit(exitCode)
  }
})
