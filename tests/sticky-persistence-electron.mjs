import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { app } from 'electron'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import {
  countDesktopStickyRecords,
  deleteAllDesktopStickyRecords,
  deleteDesktopStickyRecord,
  hasDesktopStickyRecord,
  insertDesktopStickyRecord,
  listDesktopStickyRecords,
  updateDesktopStickyRecord
} from '../src/main/db/db-desktop-stickies.js'
import { ElectronStickyService } from '../src/main/sticky/ElectronStickyService.js'

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testRoot = mkdtempSync(join(tmpdir(), 'abandon-sticky-persistence-'))
app.setPath('userData', testRoot)
app.on('window-all-closed', () => {})

let database = null
let service = null

app.once('ready', () => void runTests())

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))
}

async function runTests() {
  let exitCode = 0
  try {
    database = new Database(':memory:')
    database.pragma('foreign_keys = ON')
    createDatabaseSchema(database)
    setDb(database)
    const timestamp = Date.now()
    const noteId = Number(
      database
        .prepare(
          `INSERT INTO notes
           (content, status, effective_at, created_at, updated_at)
           VALUES (?, 'in_progress', ?, ?, ?)`
        )
        .run('真实 Electron 便利贴恢复测试', timestamp, timestamp, timestamp).lastInsertRowid
    )
    const repository = {
      list: listDesktopStickyRecords,
      count: countDesktopStickyRecords,
      exists: hasDesktopStickyRecord,
      insert: insertDesktopStickyRecord,
      update: updateDesktopStickyRecord,
      delete: deleteDesktopStickyRecord,
      deleteAll: deleteAllDesktopStickyRecords
    }
    const createService = () =>
      new ElectronStickyService({
        getMainWindow: () => null,
        getNoteById: (id) =>
          id === noteId ? { id, content: '真实 Electron 便利贴恢复测试' } : null,
        getDefaultAppearance: () => ({
          fontSize: 16,
          backgroundColor: '#FFF2A8',
          cornerRadius: 0,
          alwaysOnTop: false
        }),
        stickyRepository: repository,
        preloadPath: join(workspaceRoot, 'out', 'preload', 'sticky.js'),
        rendererFile: join(workspaceRoot, 'out', 'renderer', 'sticky.html')
      })

    service = createService()
    service.initialize()
    const created = await service.create({ noteId })
    assert.equal(service.list().length, 1)
    assert.equal(countDesktopStickyRecords(), 1)

    service.dispose()
    assert.equal(countDesktopStickyRecords(), 1, '应用退出不得删除便利贴记录')
    await wait(250)

    service = createService()
    service.initialize()
    assert.equal(service.getRecoverableCount(), 1)
    assert.equal(await service.restoreMissing({ source: 'electron-test' }), 1)
    assert.equal(service.list().length, 1)
    assert.equal(service.list()[0].id, created.id)

    assert.equal(service.close(created.id), true)
    assert.equal(countDesktopStickyRecords(), 0, '用户明确关闭后必须删除便利贴记录')

    await service.create({ noteId })
    await service.create({ noteId })
    service.dispose()
    assert.equal(countDesktopStickyRecords(), 2)

    service = createService()
    service.initialize()
    const interruptedRestoration = service.restoreMissing({ source: 'electron-close-all-race' })
    assert.equal(service.closeAll(), true)
    assert.equal(await interruptedRestoration, 0)
    assert.equal(service.list().length, 0)
    assert.equal(countDesktopStickyRecords(), 0, '关闭全部不得让恢复队列重新打开已删除记录')
    console.log('sticky persistence electron test passed')
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    service?.dispose()
    clearDb()
    database?.close()
    try {
      rmSync(testRoot, { recursive: true, force: true })
    } catch {
      // Electron 子进程完全退出前可能仍短暂持有临时目录。
    }
    app.exit(exitCode)
  }
}
