import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { getNoteById, updateNote } from '../src/main/db/db-notes.js'
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
let comparisonWindow = null

app.once('ready', () => void runTests())

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))
}

async function waitUntil(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await wait(25)
  }
  throw new Error(message)
}

async function createWindowsZOrderInspector() {
  if (process.platform !== 'win32') return null
  const { default: koffi } = await import('koffi')
  const user32 = koffi.load('user32.dll')
  const getWindow = user32.func('intptr_t GetWindow(intptr_t hWnd, uint32_t command)')
  const nativeHandle = (window) => {
    const buffer = window.getNativeWindowHandle()
    return process.arch === 'x64' ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0))
  }
  return {
    isAbove(upper, lower) {
      const lowerHandle = nativeHandle(lower)
      let candidate = getWindow(nativeHandle(upper), 2)
      while (candidate) {
        if (BigInt(candidate) === BigInt(lowerHandle)) return true
        candidate = getWindow(candidate, 2)
      }
      return false
    }
  }
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
          alwaysOnTop: true
        }),
        stickyRepository: repository,
        saveContent: ({ stickyId, noteId: sourceNoteId, content, updatedAt }) =>
          database.transaction(() => {
            const updatedNote = updateNote(sourceNoteId, { content })
            if (!updatedNote) throw new Error('来源便签不存在或已被删除')
            if (!updateDesktopStickyRecord(stickyId, { content, updatedAt })) {
              throw new Error('便利贴记录不存在')
            }
            return updatedNote
          })(),
        preloadPath: join(workspaceRoot, 'out', 'preload', 'sticky.js'),
        rendererFile: join(workspaceRoot, 'out', 'renderer', 'sticky.html')
      })

    service = createService()
    service.initialize()
    const created = await service.create({ noteId })
    assert.equal(service.list().length, 1)
    assert.equal(countDesktopStickyRecords(), 1)
    let entry = service.registry.get(created.id)
    assert.equal(entry.window.isAlwaysOnTop(), true, '新建便利贴应默认置顶')
    const zOrderInspector = await createWindowsZOrderInspector()
    if (zOrderInspector) {
      comparisonWindow = new BrowserWindow({ show: false, x: 240, y: 180, width: 360, height: 320 })
      await comparisonWindow.loadURL('data:text/html,<body>main-window-level</body>')
      comparisonWindow.setAlwaysOnTop(true, 'pop-up-menu')
      comparisonWindow.show()
      entry.window.show()
      entry.window.focus()
      await waitUntil(
        () => zOrderInspector.isAbove(entry.window, comparisonWindow),
        '置顶便利贴无法升到同为置顶状态的主窗口上方'
      )
      comparisonWindow.destroy()
      comparisonWindow = null
    }

    await entry.window.webContents.executeJavaScript(
      `document.querySelector('[data-action="pin"]').click()`
    )
    await waitUntil(
      () => !entry.window.isAlwaysOnTop() && !listDesktopStickyRecords()[0].pinned,
      '便利贴没有取消置顶'
    )
    await entry.window.webContents.executeJavaScript(
      `document.querySelector('[data-action="pin"]').click()`
    )
    await waitUntil(
      () => entry.window.isAlwaysOnTop() && listDesktopStickyRecords()[0].pinned,
      '便利贴没有恢复置顶'
    )

    entry.window.show()
    entry.window.focus()
    await wait(100)
    assert.deepEqual(
      await entry.window.webContents.executeJavaScript(`(() => {
        const content = document.querySelector('[data-content]')
        content.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        return {
          editable: content.getAttribute('contenteditable'),
          focused: document.activeElement === content
        }
      })()`),
      { editable: 'plaintext-only', focused: true },
      '双击正文没有进入纯文本编辑状态'
    )
    await entry.window.webContents.executeJavaScript(`(() => {
      const content = document.querySelector('[data-content]')
      content.textContent = '双击编辑并失焦保存后的正文'
      document.querySelector('.sticky-drag-area').dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true })
      )
    })()`)
    await waitUntil(
      () => getNoteById(noteId)?.content === '双击编辑并失焦保存后的正文',
      '双击编辑没有同步到来源便签'
    )
    assert.equal(
      await entry.window.webContents.executeJavaScript(
        `document.querySelector('[data-message][data-type="success"]')?.textContent`
      ),
      '便签已保存',
      '双击编辑保存后没有显示成功提醒'
    )
    assert.equal(
      listDesktopStickyRecords()[0].content,
      '双击编辑并失焦保存后的正文',
      '双击编辑没有更新便利贴快照'
    )
    assert.equal(
      await entry.window.webContents.executeJavaScript(
        `document.querySelector('[data-content]').getAttribute('contenteditable')`
      ),
      null,
      '点击正文外部后没有退出编辑'
    )

    await entry.window.webContents.executeJavaScript(`(() => {
      const content = document.querySelector('[data-content]')
      content.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      content.textContent = '   '
      const close = document.querySelector('[data-action="close"]')
      close.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      close.click()
    })()`)
    await waitUntil(
      () =>
        entry.window.webContents
          .executeJavaScript(`document.querySelector('[data-message]')?.hidden === false`)
          .catch(() => false),
      '保存失败时没有显示错误并阻止关闭'
    )
    assert.equal(entry.window.isDestroyed(), false, '正文保存失败时不得关闭便利贴')
    assert.equal(getNoteById(noteId)?.content, '双击编辑并失焦保存后的正文')
    assert.equal(
      await entry.window.webContents.executeJavaScript(
        `document.querySelector('[data-content]').textContent`
      ),
      '双击编辑并失焦保存后的正文',
      '保存失败后没有恢复已提交正文'
    )

    service.dispose()
    assert.equal(countDesktopStickyRecords(), 1, '应用退出不得删除便利贴记录')
    await wait(250)

    service = createService()
    service.initialize()
    assert.equal(service.getRecoverableCount(), 1)
    assert.equal(await service.restoreMissing({ source: 'electron-test' }), 1)
    assert.equal(service.list().length, 1)
    assert.equal(service.list()[0].id, created.id)
    entry = service.registry.get(created.id)
    assert.equal(entry.window.isAlwaysOnTop(), true, '恢复后的便利贴没有保持置顶')
    assert.equal(entry.content, '双击编辑并失焦保存后的正文', '恢复后的便利贴正文不是最新值')

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
    if (comparisonWindow && !comparisonWindow.isDestroyed()) comparisonWindow.destroy()
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
