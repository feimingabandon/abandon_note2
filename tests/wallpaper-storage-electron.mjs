import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { app, nativeImage } from 'electron'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import { createNotesSchema } from '../src/main/db/db-schema.js'
import {
  cleanupPendingWallpaperFiles,
  deleteWallpaperVersion,
  listWallpaperRecords,
  resolveWallpaperPath,
  saveWallpaperVersion,
  setWallpaperStorageFaultInjectorForTests
} from '../src/main/db/db-wallpapers.js'

async function expectStorageFault(point, operation) {
  setWallpaperStorageFaultInjectorForTests((currentPoint) => {
    if (currentPoint === point) throw new Error(`injected:${point}`)
  })
  try {
    await assert.rejects(operation, new RegExp(`injected:${point}`))
  } finally {
    setWallpaperStorageFaultInjectorForTests(null)
  }
}

app.once('ready', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'abandon-wallpaper-test-'))
  let db = null
  let exitCode = 0

  try {
    app.setPath('userData', tempRoot)
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    createNotesSchema(db)
    db.exec(`
      CREATE TABLE app_settings (
        window_name TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY (window_name, key)
      )
    `)
    setDb(db)

    // 2x2 PNG；足以验证原图哈希去重、双文件落盘、引用计数删除和启动清理。
    const bitmap = Buffer.from([
      255, 80, 60, 255, 60, 180, 255, 255, 80, 220, 120, 255, 245, 210, 70, 255
    ])
    const png = nativeImage
      .createFromBitmap(bitmap, { width: 2, height: 2, scaleFactor: 1 })
      .toPNG()
      .toString('base64')
    const payload = {
      original: { base64: png, ext: 'png' },
      cropped: { base64: png, ext: 'png' },
      crop: { x: 0, y: 0, width: 2, height: 2, scale: 1 }
    }
    const first = await saveWallpaperVersion(payload)
    const second = await saveWallpaperVersion(payload)

    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM wallpaper_sources').get().count, 1)
    assert.equal(listWallpaperRecords().length, 2)
    assert.equal(first.original_path, second.original_path)
    assert.equal(existsSync(resolveWallpaperPath(first.original_path)), true)
    assert.equal(existsSync(resolveWallpaperPath(first.cropped_path)), true)

    const alternateBitmap = Buffer.from([
      30, 40, 50, 255, 70, 80, 90, 255, 110, 120, 130, 255, 150, 160, 170, 255
    ])
    const alternatePng = nativeImage
      .createFromBitmap(alternateBitmap, { width: 2, height: 2, scaleFactor: 1 })
      .toPNG()
      .toString('base64')
    const alternatePayload = {
      ...payload,
      original: { base64: alternatePng, ext: 'png' }
    }

    await expectStorageFault('save:after-stage-original', () =>
      saveWallpaperVersion(alternatePayload)
    )
    await expectStorageFault('save:after-first-rename', () =>
      saveWallpaperVersion(alternatePayload)
    )
    await expectStorageFault('save:before-wallpaper-insert', () => saveWallpaperVersion(payload))
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM wallpaper_sources').get().count, 1)
    assert.equal(listWallpaperRecords().length, 2)

    await expectStorageFault('delete:after-first-rename', () => deleteWallpaperVersion(first.id))
    assert.equal(listWallpaperRecords().length, 2)
    assert.equal(existsSync(resolveWallpaperPath(first.cropped_path)), true)
    await expectStorageFault('delete:before-wallpaper-delete', () =>
      deleteWallpaperVersion(first.id)
    )
    assert.equal(listWallpaperRecords().length, 2)
    assert.equal(existsSync(resolveWallpaperPath(first.cropped_path)), true)

    setWallpaperStorageFaultInjectorForTests((point) => {
      if (point === 'delete:final-cleanup') throw new Error('injected:delete:final-cleanup')
    })
    await deleteWallpaperVersion(first.id)
    setWallpaperStorageFaultInjectorForTests(null)
    assert.equal(listWallpaperRecords().length, 1)
    assert.equal(existsSync(resolveWallpaperPath(first.cropped_path)), false)
    assert.equal(existsSync(resolveWallpaperPath(first.original_path)), true)
    assert.equal(
      (await readdir(join(tempRoot, 'wallpapers', '.staging'), { withFileTypes: true })).some(
        (entry) => entry.isDirectory()
      ),
      true
    )
    await cleanupPendingWallpaperFiles()
    assert.equal((await readdir(join(tempRoot, 'wallpapers', '.staging'))).length, 0)

    await expectStorageFault('delete:before-source-delete', () => deleteWallpaperVersion(second.id))
    assert.equal(listWallpaperRecords().length, 1)
    assert.equal(existsSync(resolveWallpaperPath(second.cropped_path)), true)
    assert.equal(existsSync(resolveWallpaperPath(second.original_path)), true)

    db.prepare('INSERT INTO app_settings (window_name, key, value) VALUES (?, ?, ?)').run(
      'main',
      'active_wallpaper_id',
      String(second.id)
    )
    db.prepare('INSERT INTO app_settings (window_name, key, value) VALUES (?, ?, ?)').run(
      'main',
      'wallpaper_enabled',
      'false'
    )
    await deleteWallpaperVersion(second.id, { clearSelectionForWindow: 'main' })
    assert.equal(existsSync(resolveWallpaperPath(first.original_path)), false)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM wallpaper_sources').get().count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM app_settings').get().count, 0)

    // 同一原图的并发保存只能创建一个 source；随后并发删除最后两个版本时，
    // 也必须只在最后一个引用消失后清理原图。
    const [concurrentFirst, concurrentSecond] = await Promise.all([
      saveWallpaperVersion(payload),
      saveWallpaperVersion(payload)
    ])
    const concurrentOriginalPath = resolveWallpaperPath(concurrentFirst.original_path)
    assert.equal(concurrentFirst.original_path, concurrentSecond.original_path)
    assert.equal(existsSync(concurrentOriginalPath), true)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM wallpaper_sources').get().count, 1)
    assert.equal(listWallpaperRecords().length, 2)

    await Promise.all([
      deleteWallpaperVersion(concurrentFirst.id),
      deleteWallpaperVersion(concurrentSecond.id)
    ])
    assert.equal(listWallpaperRecords().length, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM wallpaper_sources').get().count, 0)
    assert.equal(existsSync(concurrentOriginalPath), false)

    await cleanupPendingWallpaperFiles()
    console.log('wallpaper storage integration tests passed')
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    setWallpaperStorageFaultInjectorForTests(null)
    clearDb()
    db?.close()
    await rm(tempRoot, { recursive: true, force: true })
    app.exit(exitCode)
  }
})
