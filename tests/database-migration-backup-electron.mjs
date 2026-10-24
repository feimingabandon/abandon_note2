import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { basename, join, toNamespacedPath } from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import koffi from 'koffi'
import { app } from 'electron'
import {
  createDatabaseMigrationBackup,
  createTagIdMigrationBackup
} from '../src/main/db/db-migration-backup.js'
import { DATABASE_SCHEMA_VERSION } from '../src/main/db/db-schema.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/database-migration-backup-electron.mjs',
  mode: 'electron-ready-migration-backup-real-files',
  metadata: {
    browserWindow: false,
    realSqlite: true,
    realFiles: true,
    migrationBackup: true,
    processInterruption: false,
    powerLoss: false
  }
})
const { assert } = recorder
const fs = createRequire(import.meta.url)('node:fs')

function sourceSnapshot(db) {
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
  return {
    version: db.pragma('user_version', { simple: true }),
    tables,
    rows: tables.map(({ name }) => [
      name,
      db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()
    ])
  }
}

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function databaseFiles(root) {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...databaseFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.db')) files.push(path)
  }
  return files
}

function retainedCandidates(root, sourcePath, backupPath) {
  return databaseFiles(root).filter((path) => path !== sourcePath && path !== backupPath)
}

/** Patch only the synchronous file boundary of this one test operation. */
function withFsyncHook(hook, operation) {
  const originalOpen = fs.openSync
  const originalFsync = fs.fsyncSync
  const paths = new Map()
  let calls = 0
  fs.openSync = (...args) => {
    const fd = originalOpen(...args)
    paths.set(fd, String(args[0]))
    return fd
  }
  fs.fsyncSync = (fd) => {
    calls += 1
    return hook({ fd, path: paths.get(fd), flush: () => originalFsync(fd) })
  }
  syncBuiltinESMExports()
  try {
    const result = operation()
    assert.equal(calls, 1, 'the candidate must be flushed exactly once before publication')
    return result
  } finally {
    fs.openSync = originalOpen
    fs.fsyncSync = originalFsync
    syncBuiltinESMExports()
  }
}

function withFsMethods(replacements, operation) {
  const originals = new Map()
  try {
    for (const [name, replacement] of Object.entries(replacements)) {
      const original = fs[name]
      originals.set(name, original)
      fs[name] = (...args) => replacement(original, ...args)
    }
    syncBuiltinESMExports()
    return operation()
  } finally {
    for (const [name, original] of originals) fs[name] = original
    syncBuiltinESMExports()
  }
}

function withPublicationRace(item, createWinner, operation) {
  let candidatePath
  let created = false
  withFsMethods(
    {
      lstatSync(original, path, ...args) {
        try {
          return original(path, ...args)
        } catch (error) {
          if (path === item.backupPath && error.code === 'ENOENT' && candidatePath && !created) {
            // The observation was genuinely absent. A second owned writer now
            // wins before MoveFileExW; retain that original ENOENT observation.
            createWinner(candidatePath)
            created = true
          }
          throw error
        }
      }
    },
    () =>
      withFsyncHook(({ path, flush }) => {
        candidatePath = path
        flush()
      }, operation)
  )
  assert.equal(created, true, 'the owned competitor was created after the absence observation')
}

app.once('ready', async () => {
  let profile
  let completed = false
  let failure
  let exitCode = 0
  const cleanupErrors = []
  const connections = new Set()
  const openDatabase = (...args) => {
    const connection = new Database(...args)
    connections.add(connection)
    return connection
  }
  const fixture = (name, { kind = 'v8', version = 7, value = name } = {}) => {
    const root = join(profile.directory, name)
    mkdirSync(root)
    const sourcePath = join(root, 'app.db')
    const db = openDatabase(sourcePath)
    db.exec('CREATE TABLE preserved_user_data(id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO preserved_user_data VALUES (1, ?)').run(value)
    if (kind === 'v3') {
      db.exec(`CREATE TABLE note_tags(note_id INTEGER, tag_name TEXT);
        INSERT INTO note_tags VALUES (1, '旧标签')`)
    } else if (kind === 'v6') {
      db.exec(`CREATE TABLE tags(id INTEGER PRIMARY KEY, name TEXT, is_pinned INTEGER, pinned_at INTEGER);
        INSERT INTO tags VALUES (1, '旧置顶', 1, 2000)`)
    } else if (kind === 'v8') {
      db.exec(`CREATE TABLE app_settings(window_name TEXT, type TEXT, key TEXT, value TEXT);
        INSERT INTO app_settings VALUES ('month', 'dock', 'dock_reveal_handle_positions', '{"right":0.8}')`)
    }
    db.pragma(`user_version = ${version}`)
    const target = kind === 'v3' ? 3 : kind === 'v6' ? 6 : 8
    return {
      root,
      db,
      sourcePath,
      backupPath: join(root, `app-v${version}-before-v${target}.db`),
      version,
      value,
      original: sourceSnapshot(db)
    }
  }
  const verifyBackup = ({ backupPath, version, value }) => {
    assert.equal(lstatSync(backupPath).isFile(), true)
    assert.equal(lstatSync(backupPath).isSymbolicLink(), false)
    assert.equal(readFileSync(backupPath).subarray(0, 16).toString(), 'SQLite format 3\0')
    const backup = openDatabase(backupPath, { readonly: true, fileMustExist: true })
    try {
      assert.deepEqual(backup.pragma('integrity_check'), [{ integrity_check: 'ok' }])
      assert.equal(backup.pragma('user_version', { simple: true }), version)
      assert.equal(
        backup.prepare('SELECT value FROM preserved_user_data WHERE id = 1').get().value,
        value
      )
    } finally {
      backup.close()
    }
  }
  const assertUntouched = (item) => {
    assert.deepEqual(sourceSnapshot(item.db), item.original)
  }
  const assertRejectedWithCandidate = (item, code, operation) => {
    assert.throws(operation || (() => createDatabaseMigrationBackup(item.db, item.sourcePath)), {
      code
    })
    assertUntouched(item)
    const candidates = retainedCandidates(item.root, item.sourcePath, item.backupPath)
    assert.equal(candidates.length, 1, 'a failed backup retains its private candidate')
    assert.equal(basename(candidates[0]), 'snapshot.db')
    return candidates[0]
  }
  try {
    profile = prepareTestProfile({ prefix: 'abandon-db-migration-backup-' })

    assert.equal(createTagIdMigrationBackup, createDatabaseMigrationBackup)
    const current = fixture('no-destructive-migration', {
      kind: 'current',
      version: DATABASE_SCHEMA_VERSION
    })
    assert.equal(createDatabaseMigrationBackup(current.db, current.sourcePath), null)
    assert.deepEqual(readdirSync(current.root), ['app.db'])

    for (const [kind, version] of [
      ['v3', 0],
      ['v6', 5],
      ['v8', 7]
    ]) {
      const item = fixture(`legacy-${kind}`, { kind, version })
      assert.equal(createDatabaseMigrationBackup(item.db, item.sourcePath), item.backupPath)
      verifyBackup(item)
      assert.deepEqual(readdirSync(item.root).sort(), [basename(item.backupPath), 'app.db'].sort())
    }

    // The source main file deliberately omits the committed WAL-only user row.
    const wal = fixture('committed-wal')
    wal.db.pragma('journal_mode = WAL')
    wal.db.pragma('wal_autocheckpoint = 0')
    wal.db.pragma('wal_checkpoint(TRUNCATE)')
    wal.db.prepare('INSERT INTO preserved_user_data VALUES (2, ?)').run('committed only in WAL')
    assert.ok(statSync(`${wal.sourcePath}-wal`).size > 0)
    const rawMain = join(wal.root, 'main-file-only.db')
    copyFileSync(wal.sourcePath, rawMain)
    const rawMainDb = openDatabase(rawMain, { readonly: true, fileMustExist: true })
    assert.equal(
      rawMainDb.prepare('SELECT value FROM preserved_user_data WHERE id = 2').get(),
      undefined
    )
    rawMainDb.close()
    assert.equal(createDatabaseMigrationBackup(wal.db, wal.sourcePath), wal.backupPath)
    verifyBackup(wal)
    const walBackup = openDatabase(wal.backupPath, { readonly: true, fileMustExist: true })
    assert.equal(
      walBackup.prepare('SELECT value FROM preserved_user_data WHERE id = 2').get().value,
      'committed only in WAL'
    )
    walBackup.close()

    const quoted = fixture("quote's-path")
    assert.equal(createDatabaseMigrationBackup(quoted.db, quoted.sourcePath), quoted.backupPath)
    verifyBackup(quoted)

    // Old backups remain plain SQLite files; a byte-identical verified snapshot
    // can be reused without touching the old file or requiring a new manifest.
    const reusable = fixture('existing-old-format')
    reusable.db.exec(`VACUUM INTO '${reusable.backupPath.replaceAll("'", "''")}'`)
    const existingDigest = digest(reusable.backupPath)
    const existingStat = statSync(reusable.backupPath)
    assert.equal(
      createDatabaseMigrationBackup(reusable.db, reusable.sourcePath),
      reusable.backupPath
    )
    assert.equal(digest(reusable.backupPath), existingDigest)
    assert.equal(statSync(reusable.backupPath).mtimeMs, existingStat.mtimeMs)
    assert.equal(statSync(reusable.backupPath).ino, existingStat.ino)
    verifyBackup(reusable)
    assert.deepEqual(
      readdirSync(reusable.root).sort(),
      ['app.db', basename(reusable.backupPath)].sort()
    )

    for (const [name, content] of [
      ['empty-existing', Buffer.alloc(0)],
      ['corrupt-existing', Buffer.from('not sqlite data')]
    ]) {
      const item = fixture(name)
      writeFileSync(item.backupPath, content)
      assertRejectedWithCandidate(item, 'MIGRATION_BACKUP_INVALID')
      assert.deepEqual(readFileSync(item.backupPath), content)
    }

    const unrelated = fixture('unrelated-valid-existing')
    const unrelatedDb = openDatabase(unrelated.backupPath)
    unrelatedDb.exec(`CREATE TABLE preserved_user_data(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO preserved_user_data VALUES (1, 'another database');
      CREATE TABLE app_settings(window_name TEXT, type TEXT, key TEXT, value TEXT);
      INSERT INTO app_settings VALUES ('month','dock','dock_reveal_handle_positions','{"right":0.8}');
      PRAGMA user_version = 7`)
    unrelatedDb.close()
    const unrelatedDigest = digest(unrelated.backupPath)
    assertRejectedWithCandidate(unrelated, 'MIGRATION_BACKUP_CONFLICT')
    assert.equal(digest(unrelated.backupPath), unrelatedDigest)
    const otherCopy = openDatabase(unrelated.backupPath, { readonly: true, fileMustExist: true })
    assert.equal(
      otherCopy.prepare('SELECT value FROM preserved_user_data').get().value,
      'another database'
    )
    otherCopy.close()

    const directory = fixture('directory-existing')
    mkdirSync(directory.backupPath)
    const sentinel = join(directory.backupPath, 'preserved.txt')
    writeFileSync(sentinel, 'directory must survive')
    assertRejectedWithCandidate(directory, 'MIGRATION_BACKUP_INVALID')
    assert.equal(readFileSync(sentinel, 'utf8'), 'directory must survive')

    const linked = fixture('hardlink-existing')
    const linkedOriginal = join(linked.root, 'external-owned-backup.db')
    linked.db.exec(`VACUUM INTO '${linkedOriginal.replaceAll("'", "''")}'`)
    linkSync(linkedOriginal, linked.backupPath)
    const linkedDigest = digest(linkedOriginal)
    assert.ok(statSync(linked.backupPath).nlink > 1)
    assert.throws(() => createDatabaseMigrationBackup(linked.db, linked.sourcePath), {
      code: 'MIGRATION_BACKUP_INVALID'
    })
    assertUntouched(linked)
    assert.equal(digest(linkedOriginal), linkedDigest)
    assert.equal(digest(linked.backupPath), linkedDigest)
    assert.equal(
      retainedCandidates(linked.root, linked.sourcePath, linked.backupPath).filter(
        (path) => path !== linkedOriginal
      ).length,
      1
    )
    // Release only the link created by this successful control case. The first
    // failed attempt remains untouched; runner evidence must contain no links.
    unlinkSync(linked.backupPath)
    assert.equal(statSync(linkedOriginal).nlink, 1)
    assert.equal(digest(linkedOriginal), linkedDigest)

    const junction = fixture('junction-existing')
    const junctionTarget = join(junction.root, 'external-owned-directory')
    mkdirSync(junctionTarget)
    writeFileSync(join(junctionTarget, 'preserved.txt'), 'junction target must survive')
    symlinkSync(junctionTarget, junction.backupPath, 'junction')
    assert.equal(lstatSync(junction.backupPath).isSymbolicLink(), true)
    assertRejectedWithCandidate(junction, 'MIGRATION_BACKUP_INVALID')
    assert.equal(
      readFileSync(join(junctionTarget, 'preserved.txt'), 'utf8'),
      'junction target must survive'
    )
    rmdirSync(junction.backupPath)
    assert.equal(
      readFileSync(join(junctionTarget, 'preserved.txt'), 'utf8'),
      'junction target must survive'
    )

    for (const suffix of ['-wal', '-shm', '-journal']) {
      const item = fixture(`sidecar${suffix}`)
      item.db.exec(`VACUUM INTO '${item.backupPath.replaceAll("'", "''")}'`)
      const before = digest(item.backupPath)
      const sidecar = `${item.backupPath}${suffix}`
      writeFileSync(sidecar, 'preserved sidecar')
      assertRejectedWithCandidate(item, 'MIGRATION_BACKUP_INVALID')
      assert.equal(digest(item.backupPath), before)
      assert.equal(readFileSync(sidecar, 'utf8'), 'preserved sidecar')
    }

    const walHeader = fixture('existing-wal-header')
    walHeader.db.exec(`VACUUM INTO '${walHeader.backupPath.replaceAll("'", "''")}'`)
    const walHeaderBytes = readFileSync(walHeader.backupPath)
    walHeaderBytes[18] = 2
    walHeaderBytes[19] = 2
    writeFileSync(walHeader.backupPath, walHeaderBytes)
    assertRejectedWithCandidate(walHeader, 'MIGRATION_BACKUP_INVALID')
    assert.deepEqual(readFileSync(walHeader.backupPath), walHeaderBytes)
    for (const suffix of ['-wal', '-shm', '-journal']) {
      assert.equal(existsSync(`${walHeader.backupPath}${suffix}`), false)
    }

    const mismatch = fixture('source-mismatch')
    const otherSource = join(mismatch.root, 'different.db')
    writeFileSync(otherSource, 'not the connection main file')
    assert.throws(() => createDatabaseMigrationBackup(mismatch.db, otherSource), {
      code: 'MIGRATION_BACKUP_SOURCE_MISMATCH'
    })
    assertUntouched(mismatch)
    assert.equal(readFileSync(otherSource, 'utf8'), 'not the connection main file')
    assert.equal(existsSync(mismatch.backupPath), false)
    assert.equal(
      readdirSync(mismatch.root).some((name) => name.startsWith('.migration-backup-')),
      false
    )

    // Simulate a case-folded path alias while retaining two real file identities;
    // no Windows case-sensitive directory setting is changed for this control.
    const identityMismatch = fixture('source-identity-mismatch')
    const differentIdentity = join(identityMismatch.root, 'different-identity.db')
    copyFileSync(identityMismatch.sourcePath, differentIdentity)
    assert.notEqual(statSync(identityMismatch.sourcePath).ino, statSync(differentIdentity).ino)
    const otherBytes = readFileSync(differentIdentity)
    const originalRealpathNative = fs.realpathSync.native
    fs.realpathSync.native = (path, ...args) =>
      originalRealpathNative(
        String(path) === differentIdentity ? identityMismatch.sourcePath : path,
        ...args
      )
    try {
      assert.throws(() => createDatabaseMigrationBackup(identityMismatch.db, differentIdentity), {
        code: 'MIGRATION_BACKUP_SOURCE_MISMATCH'
      })
    } finally {
      fs.realpathSync.native = originalRealpathNative
    }
    assertUntouched(identityMismatch)
    assert.deepEqual(readFileSync(differentIdentity), otherBytes)
    assert.equal(existsSync(identityMismatch.backupPath), false)
    assert.equal(
      readdirSync(identityMismatch.root).some((name) => name.startsWith('.migration-backup-')),
      false
    )

    const memorySource = openDatabase(':memory:')
    memorySource.exec(`CREATE TABLE note_tags(note_id INTEGER, tag_name TEXT);
      INSERT INTO note_tags VALUES (1, 'memory must not pretend to be disk')`)
    assert.throws(() => createDatabaseMigrationBackup(memorySource, mismatch.sourcePath), {
      code: 'MIGRATION_BACKUP_SOURCE_MISMATCH'
    })
    assert.equal(
      memorySource.prepare('SELECT tag_name FROM note_tags').get().tag_name,
      'memory must not pretend to be disk'
    )
    assert.equal(
      readdirSync(mismatch.root).some((name) => name.startsWith('.migration-backup-')),
      false
    )

    const invalidCandidate = fixture('candidate-corrupt')
    const originalExec = invalidCandidate.db.exec
    invalidCandidate.db.exec = function (sql) {
      const result = originalExec.call(this, sql)
      const match = /^VACUUM INTO '((?:[^']|'')+)'\s*$/i.exec(sql)
      if (match) writeFileSync(match[1].replaceAll("''", "'"), 'interrupted candidate bytes')
      return result
    }
    try {
      const candidate = assertRejectedWithCandidate(invalidCandidate, 'MIGRATION_BACKUP_INVALID')
      assert.equal(readFileSync(candidate, 'utf8'), 'interrupted candidate bytes')
      assert.equal(existsSync(invalidCandidate.backupPath), false)
    } finally {
      invalidCandidate.db.exec = originalExec
    }

    for (const [name, statement] of [
      ['candidate-wrong-version', 'PRAGMA user_version = 99'],
      ['candidate-wrong-structure', 'DROP TABLE app_settings']
    ]) {
      const item = fixture(name)
      const exec = item.db.exec
      item.db.exec = function (sql) {
        const result = exec.call(this, sql)
        const match = /^VACUUM INTO '((?:[^']|'')+)'\s*$/i.exec(sql)
        if (match) {
          const candidateDb = openDatabase(match[1].replaceAll("''", "'"))
          try {
            candidateDb.exec(statement)
            assert.deepEqual(candidateDb.pragma('integrity_check'), [{ integrity_check: 'ok' }])
          } finally {
            candidateDb.close()
          }
        }
        return result
      }
      try {
        assertRejectedWithCandidate(item, 'MIGRATION_BACKUP_INVALID')
        assert.equal(existsSync(item.backupPath), false)
      } finally {
        item.db.exec = exec
      }
    }

    const failedVacuum = fixture('vacuum-write-failed')
    const vacuumError = Object.assign(new Error('injected VACUUM destination write failure'), {
      code: 'ENOSPC'
    })
    const originalVacuumExec = failedVacuum.db.exec
    failedVacuum.db.exec = function (sql) {
      const match = /^VACUUM INTO '((?:[^']|'')+)'\s*$/i.exec(sql)
      if (!match) return originalVacuumExec.call(this, sql)
      writeFileSync(match[1].replaceAll("''", "'"), 'partial candidate from failed write')
      throw vacuumError
    }
    try {
      const candidate = assertRejectedWithCandidate(failedVacuum, 'ENOSPC')
      assert.equal(readFileSync(candidate, 'utf8'), 'partial candidate from failed write')
      assert.equal(existsSync(failedVacuum.backupPath), false)
    } finally {
      failedVacuum.db.exec = originalVacuumExec
    }

    const changedWhileHashing = fixture('candidate-changes-during-hash')
    const readPaths = new Map()
    let mutatedCandidate
    withFsMethods(
      {
        openSync(original, ...args) {
          const fd = original(...args)
          readPaths.set(fd, String(args[0]))
          return fd
        },
        readSync(original, fd, buffer, offset, length, position) {
          const bytes = original(fd, buffer, offset, length, position)
          const path = readPaths.get(fd)
          if (!mutatedCandidate && path && basename(path) === 'snapshot.db' && length > 100) {
            mutatedCandidate = path
            writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from([0x41])]))
          }
          return bytes
        }
      },
      () => {
        const candidate = assertRejectedWithCandidate(
          changedWhileHashing,
          'MIGRATION_BACKUP_INVALID'
        )
        assert.equal(
          candidate,
          mutatedCandidate,
          'the full-file hash observed an actual file change'
        )
      }
    )
    assert.equal(existsSync(changedWhileHashing.backupPath), false)

    const failedFlush = fixture('fsync-failed')
    const flushError = Object.assign(new Error('injected candidate fsync failure'), { code: 'EIO' })
    let flushCalls = 0
    withFsyncHook(
      () => {
        flushCalls += 1
        throw flushError
      },
      () => {
        const candidate = assertRejectedWithCandidate(failedFlush, 'EIO')
        verifyBackup({ ...failedFlush, backupPath: candidate })
      }
    )
    assert.equal(flushCalls, 1)
    assert.equal(existsSync(failedFlush.backupPath), false)

    // A different owned writer wins after the final absence observation and
    // before the real no-replace native publication. Neither writer is lost.
    const raceDifferent = fixture('race-different-existing')
    let raceWinnerDigest
    withPublicationRace(
      raceDifferent,
      (candidatePath) => {
        copyFileSync(candidatePath, raceDifferent.backupPath, fs.constants.COPYFILE_EXCL)
        const winner = openDatabase(raceDifferent.backupPath)
        winner
          .prepare('UPDATE preserved_user_data SET value = ? WHERE id = 1')
          .run('different writer owns this valid backup')
        winner.close()
        raceWinnerDigest = digest(raceDifferent.backupPath)
      },
      () => {
        const candidate = assertRejectedWithCandidate(raceDifferent, 'MIGRATION_BACKUP_CONFLICT')
        verifyBackup({ ...raceDifferent, backupPath: candidate })
      }
    )
    assert.equal(digest(raceDifferent.backupPath), raceWinnerDigest)

    const raceSame = fixture('race-same-existing')
    let sameWinnerDigest
    withPublicationRace(
      raceSame,
      (path) => {
        assert.equal(basename(path), 'snapshot.db')
        copyFileSync(path, raceSame.backupPath, fs.constants.COPYFILE_EXCL)
        sameWinnerDigest = digest(raceSame.backupPath)
      },
      () => {
        assert.equal(
          createDatabaseMigrationBackup(raceSame.db, raceSame.sourcePath),
          raceSame.backupPath
        )
      }
    )
    verifyBackup(raceSame)
    assert.equal(digest(raceSame.backupPath), sameWinnerDigest)
    assert.equal(
      retainedCandidates(raceSame.root, raceSame.sourcePath, raceSame.backupPath).length,
      0
    )

    const publishBlocked = fixture('native-publish-blocked')
    const kernel = koffi.load('kernel32.dll')
    const createFile = kernel.func(
      'uintptr_t CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, uintptr_t)'
    )
    const closeHandle = kernel.func('int CloseHandle(uintptr_t)')
    const lastError = kernel.func('uint32_t GetLastError()')
    let heldHandle
    try {
      withFsyncHook(
        ({ path, flush }) => {
          assert.equal(basename(path), 'snapshot.db')
          flush()
          // GENERIC_READ, SHARE_READ|SHARE_WRITE, OPEN_EXISTING; deliberately no
          // SHARE_DELETE. This owned handle makes the actual Windows move fail.
          heldHandle = createFile(toNamespacedPath(path), 0x80000000, 3, null, 3, 0x80, 0n)
          const error = lastError()
          assert.notEqual(BigInt(heldHandle), 0xffffffffffffffffn, `CreateFileW failed ${error}`)
        },
        () => {
          const candidate = assertRejectedWithCandidate(
            publishBlocked,
            'MIGRATION_BACKUP_PUBLISH_FAILED'
          )
          verifyBackup({ ...publishBlocked, backupPath: candidate })
        }
      )
    } finally {
      if (heldHandle !== undefined && BigInt(heldHandle) !== 0xffffffffffffffffn) {
        assert.equal(closeHandle(heldHandle), 1, 'the test closes its own blocking handle')
      }
    }
    assert.equal(existsSync(publishBlocked.backupPath), false)

    const cleanupDirectory = fixture('published-stage-cleanup-failed')
    const originalWarn = console.warn
    const cleanupWarnings = []
    console.warn = (...args) => cleanupWarnings.push(args.map(String).join(' '))
    try {
      let directoryFailures = 0
      withFsMethods(
        {
          rmdirSync(original, path, ...args) {
            if (basename(String(path)).startsWith('.migration-backup-')) {
              directoryFailures += 1
              throw Object.assign(new Error('injected owned empty-directory cleanup failure'), {
                code: 'EACCES'
              })
            }
            return original(path, ...args)
          }
        },
        () => {
          assert.equal(
            createDatabaseMigrationBackup(cleanupDirectory.db, cleanupDirectory.sourcePath),
            cleanupDirectory.backupPath
          )
        }
      )
      assert.equal(directoryFailures, 1)
      verifyBackup(cleanupDirectory)
      assertUntouched(cleanupDirectory)
      const remainingStages = readdirSync(cleanupDirectory.root).filter((name) =>
        name.startsWith('.migration-backup-')
      )
      assert.equal(remainingStages.length, 1)
      assert.deepEqual(readdirSync(join(cleanupDirectory.root, remainingStages[0])), [])

      const cleanupReuse = fixture('reused-candidate-cleanup-failed')
      cleanupReuse.db.exec(`VACUUM INTO '${cleanupReuse.backupPath.replaceAll("'", "''")}'`)
      const keptDigest = digest(cleanupReuse.backupPath)
      let unlinkFailures = 0
      withFsMethods(
        {
          unlinkSync(original, path, ...args) {
            if (basename(String(path)) === 'snapshot.db') {
              unlinkFailures += 1
              throw Object.assign(new Error('injected redundant candidate cleanup failure'), {
                code: 'EACCES'
              })
            }
            return original(path, ...args)
          }
        },
        () => {
          assert.equal(
            createDatabaseMigrationBackup(cleanupReuse.db, cleanupReuse.sourcePath),
            cleanupReuse.backupPath
          )
        }
      )
      assert.equal(unlinkFailures, 1)
      assert.equal(digest(cleanupReuse.backupPath), keptDigest)
      verifyBackup(cleanupReuse)
      assertUntouched(cleanupReuse)
      const redundant = retainedCandidates(
        cleanupReuse.root,
        cleanupReuse.sourcePath,
        cleanupReuse.backupPath
      )
      assert.equal(redundant.length, 1)
      assert.equal(digest(redundant[0]), keptDigest)
      assert.ok(cleanupWarnings.length >= 2, 'cleanup failures must report the retained paths')
      assert.ok(cleanupWarnings.some((message) => message.includes(cleanupDirectory.root)))
      assert.ok(cleanupWarnings.some((message) => message.includes(cleanupReuse.root)))
    } finally {
      console.warn = originalWarn
    }

    completed = true
  } catch (error) {
    failure = error
    exitCode = 1
    console.error(error)
  } finally {
    for (const connection of connections) {
      if (!connection.open) continue
      try {
        connection.close()
      } catch (error) {
        cleanupErrors.push(error.message)
        exitCode = 1
      }
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
