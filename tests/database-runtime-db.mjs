import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

function createLegacyFontFixture(database) {
  createDatabaseSchema(database)
  database.exec(`
    DROP TABLE desktop_stickies;
    CREATE TABLE desktop_stickies (
      id TEXT PRIMARY KEY,
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      content_snapshot TEXT NOT NULL,
      x INTEGER NOT NULL, y INTEGER NOT NULL,
      width INTEGER NOT NULL CHECK(width > 0), height INTEGER NOT NULL CHECK(height > 0),
      display_id TEXT,
      work_area_x INTEGER, work_area_y INTEGER,
      work_area_width INTEGER CHECK(work_area_width IS NULL OR work_area_width > 0),
      work_area_height INTEGER CHECK(work_area_height IS NULL OR work_area_height > 0),
      font_size INTEGER NOT NULL CHECK(font_size BETWEEN 12 AND 32),
      background_color TEXT NOT NULL,
      corner_radius INTEGER NOT NULL CHECK(corner_radius BETWEEN 0 AND 32),
      always_on_top INTEGER NOT NULL DEFAULT 0 CHECK(always_on_top IN (0, 1)),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO notes(id,content,status,effective_at,created_at,updated_at)
      VALUES(101,'原始便签正文','in_progress',100,101,102);
    INSERT INTO desktop_stickies VALUES
      ('small',101,'原始快照',-10,25,280,260,'screen-a',-1920,0,1920,1080,12,'#FFF2A8',16,1,103,104),
      ('large',101,'另一快照',20,35,320,300,NULL,NULL,NULL,NULL,NULL,32,'#FFFFFF',0,0,105,106);
    PRAGMA user_version = 18;
  `)
  return database.prepare('SELECT * FROM desktop_stickies ORDER BY id').all()
}

function verifyFontMigrationRollback() {
  const database = new Database(':memory:')
  try {
    database.pragma('foreign_keys = ON')
    const originalRows = createLegacyFontFixture(database)
    const originalExec = database.exec
    database.exec = function (sql) {
      const rename = sql.indexOf('ALTER TABLE desktop_stickies_v19 RENAME')
      if (rename !== -1) {
        originalExec.call(this, sql.slice(0, rename))
        throw new Error('injected interruption after old sticky table dropped')
      }
      return originalExec.call(this, sql)
    }
    try {
      assert.throws(() => createDatabaseSchema(database), /injected interruption/)
    } finally {
      database.exec = originalExec
    }
    assert.equal(database.pragma('user_version', { simple: true }), 18)
    assert.deepEqual(
      database.prepare('SELECT * FROM desktop_stickies ORDER BY id').all(),
      originalRows
    )
    assert.equal(
      database.prepare("SELECT 1 FROM sqlite_master WHERE name='desktop_stickies_v19'").get(),
      undefined
    )
    assert.throws(() => database.prepare('UPDATE desktop_stickies SET font_size=8').run(), /CHECK/)
    createDatabaseSchema(database)
    assert.equal(database.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
    assert.deepEqual(
      database.prepare('SELECT * FROM desktop_stickies ORDER BY id').all(),
      originalRows
    )
  } finally {
    database.close()
  }
}

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
    const backupBlockedRoot = join(profile.directory, 'backup-blocked')
    const fontUpgradeRoot = join(profile.directory, 'font-upgrade')
    for (const root of [
      currentRoot,
      legacyRoot,
      futureRoot,
      journalUpgradeRoot,
      backupBlockedRoot,
      fontUpgradeRoot
    ])
      mkdirSync(root)
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

    // A required pre-migration backup failure must leave the old user row and
    // version intact and must never publish the failed candidate connection.
    const backupBlockedPath = join(backupBlockedRoot, 'app.db')
    const backupBlocked = new Database(backupBlockedPath)
    try {
      createDatabaseSchema(backupBlocked)
      backupBlocked
        .prepare(
          `INSERT INTO app_settings
          (window_name,type,key,value,created_at,updated_at)
          VALUES ('month','dock','dock_reveal_handle_positions','{"right":0.7}',1,1)`
        )
        .run()
      backupBlocked.pragma('user_version = 7')
    } finally {
      backupBlocked.close()
    }
    const blockedBackupPath = join(backupBlockedRoot, 'app-v7-before-v8.db')
    const invalidBackup = Buffer.from('retained invalid backup, never overwrite')
    writeFileSync(blockedBackupPath, invalidBackup)
    assert.throws(() => initializeDatabase({ userDataPath: backupBlockedRoot }), {
      code: 'MIGRATION_BACKUP_INVALID'
    })
    assert.equal(getDbIfInitialized(), null)
    assert.deepEqual(readFileSync(blockedBackupPath), invalidBackup)
    const unchanged = new Database(backupBlockedPath, { readonly: true, fileMustExist: true })
    try {
      assert.equal(unchanged.pragma('user_version', { simple: true }), 7)
      assert.equal(
        unchanged
          .prepare(`SELECT value FROM app_settings WHERE key='dock_reveal_handle_positions'`)
          .get().value,
        '{"right":0.7}'
      )
      assert.deepEqual(unchanged.pragma('integrity_check'), [{ integrity_check: 'ok' }])
    } finally {
      unchanged.close()
    }

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

    const fontLegacy = new Database(join(fontUpgradeRoot, 'app.db'))
    let originalStickies
    try {
      originalStickies = createLegacyFontFixture(fontLegacy)
    } finally {
      fontLegacy.close()
    }
    initializeDatabase({ userDataPath: fontUpgradeRoot })
    const fontBackup = new Database(join(fontUpgradeRoot, 'app-v18-before-v19.db'), {
      readonly: true,
      fileMustExist: true
    })
    try {
      assert.equal(fontBackup.pragma('user_version', { simple: true }), 18)
      assert.deepEqual(
        fontBackup.prepare('SELECT * FROM desktop_stickies ORDER BY id').all(),
        originalStickies
      )
      assert.match(
        fontBackup.prepare("SELECT sql FROM sqlite_master WHERE name='desktop_stickies'").get().sql,
        /font_size BETWEEN 12 AND 32/
      )
    } finally {
      fontBackup.close()
    }
    assert.deepEqual(
      getDb().prepare('SELECT * FROM desktop_stickies ORDER BY id').all(),
      originalStickies
    )
    assert.equal(
      getDb().prepare('SELECT content FROM notes WHERE id=101').get().content,
      '原始便签正文'
    )
    const updateFont = getDb().prepare('UPDATE desktop_stickies SET font_size=? WHERE id=?')
    updateFont.run(8, 'small')
    updateFont.run(40, 'large')
    assert.throws(() => updateFont.run(7, 'small'), /CHECK/)
    assert.throws(() => updateFont.run(41, 'large'), /CHECK/)
    assert.deepEqual(getDb().pragma('foreign_key_check'), [])
    assert.equal(getDb().pragma('integrity_check', { simple: true }), 'ok')
    assert.equal(
      getDb()
        .prepare(
          "SELECT COUNT(*) AS total FROM sqlite_master WHERE type='index' AND name IN ('idx_desktop_stickies_note_id','idx_desktop_stickies_created_at')"
        )
        .get().total,
      2
    )
    closeDatabase()
    initializeDatabase({ userDataPath: fontUpgradeRoot })
    assert.deepEqual(
      getDb().prepare('SELECT id,font_size FROM desktop_stickies ORDER BY id').all(),
      [
        { id: 'large', font_size: 40 },
        { id: 'small', font_size: 8 }
      ]
    )
    getDb().prepare('DELETE FROM notes WHERE id=101').run()
    assert.equal(getDb().prepare('SELECT COUNT(*) AS total FROM desktop_stickies').get().total, 0)
    closeDatabase()
    verifyFontMigrationRollback()
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
