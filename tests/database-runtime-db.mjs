import { existsSync, mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { app } from 'electron'
import { initializeDatabase, closeDatabase } from '../src/main/db/db-runtime.js'
import { getDb, getDbIfInitialized } from '../src/main/db/db-connection.js'
import { createDatabaseSchema, DATABASE_SCHEMA_VERSION } from '../src/main/db/db-schema.js'
import { getAllSettings, setSettingsBatch } from '../src/main/db/db-settings-repository.js'
import { createNote, getNoteById } from '../src/main/db/db-notes.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/database-runtime-db.mjs',
  mode: 'electron-ready-disk-sqlite-runtime-migration',
  metadata: { browserWindow: false, mainProcessRestart: false }
})
const { assert } = recorder

app.once('ready', async () => {
  let profile
  let completed = false
  let failure
  let exitCode = 0
  const cleanupErrors = []
  try {
    profile = prepareTestProfile({ prefix: 'abandon-db-runtime-' })
    const currentRoot = join(profile.directory, 'current')
    const legacyRoot = join(profile.directory, 'legacy')
    const futureRoot = join(profile.directory, 'future')
    const journalUpgradeRoot = join(profile.directory, 'journal-upgrade')
    for (const root of [currentRoot, legacyRoot, futureRoot, journalUpgradeRoot]) mkdirSync(root)
    assert.equal(getDbIfInitialized(), null)
    assert.equal(initializeDatabase({ userDataPath: currentRoot }).isNewDatabase, true)
    const connection = getDb()
    assert.equal(connection.pragma('journal_mode', { simple: true }), 'wal')
    assert.equal(connection.pragma('synchronous', { simple: true }), 1)
    assert.equal(connection.pragma('cache_size', { simple: true }), -8000)
    assert.equal(connection.pragma('foreign_keys', { simple: true }), 1)
    assert.equal(connection.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
    assert.equal(
      connection
        .prepare("SELECT name FROM sqlite_master WHERE name='attachment_reset_commits'")
        .get().name,
      'attachment_reset_commits'
    )
    const note = createNote({ content: '实际生命周期重开' })
    setSettingsBatch('main', [{ type: 'test', key: 'persisted', value: 42 }])
    assert.equal(getNoteById(note.id).content, '实际生命周期重开')
    assert.throws(() => initializeDatabase({ userDataPath: currentRoot }), /数据库已经初始化/)
    assert.equal(getDb(), connection)
    closeDatabase()
    assert.equal(getDbIfInitialized(), null)
    assert.equal(connection.open, false)
    assert.equal(initializeDatabase({ userDataPath: currentRoot }).isNewDatabase, false)
    assert.equal(getAllSettings('main')[0].value, '42')
    assert.equal(getNoteById(note.id).content, '实际生命周期重开')
    closeDatabase()

    const legacyPath = join(legacyRoot, 'app.db')
    const legacy = new Database(legacyPath)
    createDatabaseSchema(legacy)
    legacy
      .prepare(
        `INSERT INTO app_settings
      (window_name,type,key,value,created_at,updated_at)
      VALUES ('month','dock','dock_reveal_handle_positions','{"right":0.8}',1,1)`
      )
      .run()
    legacy.pragma('user_version = 7')
    legacy.close()
    assert.equal(initializeDatabase({ userDataPath: legacyRoot }).isNewDatabase, false)
    const backupPath = join(legacyRoot, 'app-v7-before-v8.db')
    assert.equal(existsSync(backupPath), true)
    const backup = new Database(backupPath, { readonly: true })
    try {
      assert.equal(backup.pragma('user_version', { simple: true }), 7)
      assert.equal(
        backup
          .prepare(`SELECT value FROM app_settings WHERE key='dock_reveal_handle_positions'`)
          .get().value,
        '{"right":0.8}'
      )
    } finally {
      backup.close()
    }
    assert.equal(getDb().pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
    assert.equal(
      getAllSettings('month').some((row) => row.key === 'dock_reveal_handle_positions'),
      false
    )
    closeDatabase()

    const futurePath = join(futureRoot, 'app.db')
    const future = new Database(futurePath)
    future.pragma(`user_version = ${DATABASE_SCHEMA_VERSION + 1}`)
    future.close()
    assert.throws(() => initializeDatabase({ userDataPath: futureRoot }), /数据库版本.*高于/)
    assert.equal(getDbIfInitialized(), null)
    const recovered = new Database(futurePath)
    recovered.pragma(`user_version = 0`)
    recovered.close()
    assert.equal(initializeDatabase({ userDataPath: futureRoot }).isNewDatabase, false)
    assert.equal(getDb().pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
    closeDatabase()

    const upgrade = new Database(join(journalUpgradeRoot, 'app.db'))
    createDatabaseSchema(upgrade)
    upgrade.exec('DROP TABLE attachment_reset_commits')
    upgrade.pragma('user_version = 17')
    upgrade
      .prepare(
        "INSERT INTO app_settings(window_name,type,key,value) VALUES('application','test','journal-upgrade','retained')"
      )
      .run()
    upgrade.close()
    initializeDatabase({ userDataPath: journalUpgradeRoot })
    assert.equal(getDb().pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
    assert.equal(getAllSettings('application')[0].value, 'retained')
    const operationId = randomUUID()
    getDb()
      .prepare('INSERT INTO attachment_reset_commits(operation_id,committed_at) VALUES (?,1)')
      .run(operationId)
    closeDatabase()
    initializeDatabase({ userDataPath: journalUpgradeRoot })
    assert.equal(
      getDb().prepare('SELECT operation_id FROM attachment_reset_commits').get().operation_id,
      operationId
    )
    assert.equal(getDb().pragma('integrity_check', { simple: true }), 'ok')
    closeDatabase()
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
