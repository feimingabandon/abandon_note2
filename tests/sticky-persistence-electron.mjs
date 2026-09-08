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
  updateDesktopStickyContentsByNoteId,
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
        getNoteById: (id) => (id === noteId ? getNoteById(id) : null),
        getDefaultAppearance: () => ({
          fontSize: 16,
          backgroundColor: '#FFF2A8',
          cornerRadius: 0,
          alwaysOnTop: true
        }),
        stickyRepository: repository,
        saveContent: ({ noteId: sourceNoteId, content, expectedContent, updatedAt }) =>
          database.transaction(() => {
            const currentNote = getNoteById(sourceNoteId)
            if (!currentNote) throw new Error('来源便签不存在或已被删除')
            if (currentNote.content !== expectedContent) {
              updateDesktopStickyContentsByNoteId(sourceNoteId, currentNote.content, updatedAt)
              return { conflict: true, content: currentNote.content }
            }
            const updatedNote = updateNote(sourceNoteId, { content })
            if (!updatedNote) throw new Error('来源便签不存在或已被删除')
            if (updateDesktopStickyContentsByNoteId(sourceNoteId, content, updatedAt) < 1) {
              throw new Error('便利贴记录不存在')
            }
            return { conflict: false, note: updatedNote }
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
    const saveContent = service.saveContent
    service.saveContent = () => {
      throw new Error('SQLITE_FULL injected')
    }
    await entry.window.webContents.executeJavaScript(`(() => {
      const content = document.querySelector('[data-content]')
      content.textContent = '双击编辑并失焦保存后的正文'
      document.querySelector('.sticky-drag-area').dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true })
      )
    })()`)
    await waitUntil(
      () =>
        entry.window.webContents.executeJavaScript(`(() => {
        const content = document.querySelector('[data-content]')
        return content.textContent === '双击编辑并失焦保存后的正文' &&
          content.getAttribute('contenteditable') === 'plaintext-only' &&
          document.querySelector('[data-message]').textContent.includes('SQLITE_FULL')
      })()`),
      '数据库保存失败后没有保留草稿并恢复编辑'
    )
    assert.equal(getNoteById(noteId).content, '真实 Electron 便利贴恢复测试')
    service.saveContent = saveContent
    await entry.window.webContents.executeJavaScript(
      `document.querySelector('[data-content]').dispatchEvent(new FocusEvent('blur'))`
    )
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
      '   ',
      '保存失败后没有保留未提交正文'
    )
    await entry.window.webContents.executeJavaScript(
      `document.querySelector('[data-content]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    )
    assert.equal(
      await entry.window.webContents.executeJavaScript(
        `document.querySelector('[data-content]').textContent`
      ),
      '双击编辑并失焦保存后的正文',
      '明确取消后没有恢复已提交正文'
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

    const firstDuplicate = await service.create({ noteId })
    const secondDuplicate = await service.create({ noteId })
    const firstDuplicateEntry = service.registry.get(firstDuplicate.id)
    const secondDuplicateEntry = service.registry.get(secondDuplicate.id)
    const duplicateOriginalContent = getNoteById(noteId).content
    secondDuplicateEntry.window.show()
    secondDuplicateEntry.window.focus()
    await wait(100)
    await secondDuplicateEntry.window.webContents.executeJavaScript(`(() => {
      const content = document.querySelector('[data-content]')
      content.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      content.textContent = '第二张尚未保存的草稿'
    })()`)
    const duplicateUpdate = service.updateContentForSender(firstDuplicateEntry.webContentsId, {
      content: '同源便利贴同步后的正文',
      expectedContent: duplicateOriginalContent
    })
    assert.deepEqual(duplicateUpdate, {
      content: '同源便利贴同步后的正文',
      conflict: false
    })
    await wait(50)
    assert.equal(
      await secondDuplicateEntry.window.webContents.executeJavaScript(
        `document.querySelector('[data-content]').textContent`
      ),
      '第二张尚未保存的草稿',
      '同源同步不应覆盖正在编辑的草稿'
    )
    await secondDuplicateEntry.window.webContents.executeJavaScript(`(() => {
      const content = document.querySelector('[data-content]')
      content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })()`)
    await waitUntil(
      () =>
        secondDuplicateEntry.window.webContents.executeJavaScript(
          `document.querySelector('[data-content]').textContent === '同源便利贴同步后的正文'`
        ),
      '取消草稿后没有显示同源便利贴的最新正文'
    )

    await secondDuplicateEntry.window.webContents.executeJavaScript(`(() => {
      const content = document.querySelector('[data-content]')
      content.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      content.textContent = '第二张发生冲突的草稿'
    })()`)
    assert.deepEqual(
      service.updateContentForSender(firstDuplicateEntry.webContentsId, {
        content: '第一张再次更新后的正文',
        expectedContent: '同源便利贴同步后的正文'
      }),
      { content: '第一张再次更新后的正文', conflict: false }
    )
    await wait(50)
    await secondDuplicateEntry.window.webContents.executeJavaScript(
      `document.querySelector('[data-content]').dispatchEvent(new FocusEvent('blur'))`
    )
    await waitUntil(
      () =>
        secondDuplicateEntry.window.webContents.executeJavaScript(`(() => {
          const content = document.querySelector('[data-content]')
          return content.dataset.editing === 'true' &&
            content.textContent === '第二张发生冲突的草稿' &&
            document.querySelector('[data-message]').textContent.includes('尚未保存')
        })()`),
      '过期编辑被拒绝后没有保留草稿并重新进入编辑状态'
    )
    assert.equal(
      getNoteById(noteId).content,
      '第一张再次更新后的正文',
      '过期编辑覆盖了来源便签的新正文'
    )
    await secondDuplicateEntry.window.webContents.executeJavaScript(
      `document.querySelector('[data-content]').dispatchEvent(new FocusEvent('blur'))`
    )
    await waitUntil(
      () => getNoteById(noteId).content === '第二张发生冲突的草稿',
      '用户重新确认后没有保存保留的草稿'
    )
    assert.ok(
      listDesktopStickyRecords().every((record) => record.content === '第二张发生冲突的草稿'),
      '同源便利贴的持久化快照没有原子同步'
    )
    assert.deepEqual(
      service.updateContentForSender(secondDuplicateEntry.webContentsId, {
        content: '基于过期正文的覆盖',
        expectedContent: duplicateOriginalContent
      }),
      { content: '第二张发生冲突的草稿', conflict: true }
    )
    assert.equal(
      getNoteById(noteId).content,
      '第二张发生冲突的草稿',
      '过期便利贴覆盖了来源便签的新正文'
    )
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
