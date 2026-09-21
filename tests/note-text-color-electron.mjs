import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'

const require = createRequire(import.meta.url)
const report = (message) => process.stderr.write(`[note-text-color-e2e] ${message}\n`)
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))

app.commandLine.appendSwitch('disable-gpu')

async function waitUntil(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(25)
  }
  throw new Error(message)
}

function seedListView(userDataPath) {
  mkdirSync(userDataPath, { recursive: true })
  const database = new Database(join(userDataPath, 'app.db'))
  database.exec(`
    CREATE TABLE app_settings (
      window_name TEXT NOT NULL,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      remark TEXT DEFAULT '',
      created_at INTEGER,
      updated_at INTEGER,
      PRIMARY KEY (window_name, key)
    );
  `)
  const insert = database.prepare(`
    INSERT INTO app_settings
      (window_name, type, key, value, remark, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', ?, ?)
  `)
  const now = Date.now()
  insert.run('application', 'application', 'active_view', 'list', now, now)
  insert.run('application', 'remote', 'receive_notices', 'false', now, now)
  insert.run('application', 'remote', 'upload_device_info', 'false', now, now)
  insert.run('application', 'onboarding', 'first_use_notice_version', '1', now, now)
  insert.run('main', 'system', 'blur_enabled', 'false', now, now)
  database.close()
}

function listWindow() {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && /\/index\.html(?:$|[?#])/.test(window.webContents.getURL())
  )
}

async function selectText(window, cardSelector, start, end) {
  return window.webContents.executeJavaScript(`(() => {
    const root = document.querySelector(${JSON.stringify(`${cardSelector} .nl-card-text`)})
    if (!root) return false
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node
    let offset = 0
    let startNode = null
    let endNode = null
    let startOffset = 0
    let endOffset = 0
    while ((node = walker.nextNode())) {
      const next = offset + node.data.length
      if (!startNode && ${start} >= offset && ${start} <= next) {
        startNode = node
        startOffset = ${start} - offset
      }
      if (!endNode && ${end} >= offset && ${end} <= next) {
        endNode = node
        endOffset = ${end} - offset
      }
      offset = next
    }
    if (!startNode || !endNode) return false
    const range = document.createRange()
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
    return selection.toString()
  })()`)
}

async function selectTextareaText(window, selector, start, end) {
  return window.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector(${JSON.stringify(selector)})
    if (!textarea) return false
    textarea.focus()
    textarea.setSelectionRange(${start}, ${end})
    const rect = textarea.getBoundingClientRect()
    textarea.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      button: 0,
      clientX: rect.left + Math.min(80, rect.width / 2),
      clientY: rect.top + Math.min(28, rect.height / 2)
    }))
    return textarea.value.slice(${start}, ${end})
  })()`)
}

const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-text-color-'))

try {
  app.setPath('userData', testUserData)
  process.env.ABANDON_INTEGRATION_TEST = '1'
  process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
  process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve(
    'native_blur',
    'build',
    'bin',
    'blur_engine.dll'
  )
  seedListView(testUserData)
  require(resolve('out', 'main', 'index.js'))
  const mainChunk = readdirSync(resolve('out', 'main', 'chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk, '未找到构建后的主进程分块')
  require(resolve('out', 'main', 'chunks', mainChunk))
  app.once('ready', () => void run())
} catch (error) {
  report(`setup failed: ${error?.stack || error}`)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}

async function run() {
  try {
    const window = await waitUntil(listWindow, '列表窗口没有创建')
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(document.querySelector('.view-switcher__trigger[data-active-view="list"]'))`
        ),
      '列表窗口尚未渲染完成'
    )
    const noteId = await window.webContents.executeJavaScript(`(async () => {
      const note = await window.api.createNote({ content: '今天完成报告' })
      return note.id
    })()`)
    const cardSelector = `.nl-card[data-note-id="${noteId}"]`
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(document.querySelector(${JSON.stringify(cardSelector)}))`
        ),
      '新建便签没有显示'
    )

    assert.equal(await selectText(window, cardSelector, 2, 4), '完成')
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(document.querySelector('.nl-text-color-popover'))`
        ),
      '选择正文后没有显示颜色浮窗'
    )
    await window.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="设置文字颜色 #ff3b30"]').click()`
    )
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(`window.api.getNote(${noteId}).then((note) =>
          note.content_color_ranges.length === 1 && note.content_color_ranges[0].text === '完成'
        )`),
      '第一段颜色没有持久化'
    )

    assert.equal(await selectText(window, cardSelector, 4, 6), '报告')
    await window.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="设置文字颜色 #007aff"]').click()`
    )
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(`window.api.getNote(${noteId}).then((note) =>
          note.content_color_ranges.length === 2
        )`),
      '同一便签没有保存多段颜色'
    )

    const shifted = await window.webContents.executeJavaScript(
      `window.api.updateNote(${noteId}, { content: '请在今天完成报告' })`
    )
    assert.deepEqual(
      shifted.content_color_ranges.map(({ start, end, text, color }) => ({
        start,
        end,
        text,
        color
      })),
      [
        { start: 4, end: 6, text: '完成', color: '#ff3b30' },
        { start: 6, end: 8, text: '报告', color: '#007aff' }
      ]
    )
    const changed = await window.webContents.executeJavaScript(
      `window.api.updateNote(${noteId}, { content: '请在今天完成周报' })`
    )
    assert.deepEqual(
      changed.content_color_ranges.map(({ text, color }) => ({ text, color })),
      [{ text: '完成', color: '#ff3b30' }]
    )

    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `document.querySelector(${JSON.stringify(`${cardSelector} .nl-card-text`)})?.textContent === '请在今天完成周报'`
        ),
      '正文修改后卡片没有刷新'
    )
    assert.equal(await selectText(window, cardSelector, 4, 6), '完成')
    await window.webContents.executeJavaScript(`(() => {
      const button = Array.from(document.querySelectorAll('.nl-text-color-popover__actions button'))
        .find((item) => item.textContent.includes('清除本便签全部颜色'))
      button.click()
    })()`)
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(document.querySelector('.confirm-card[aria-label="清除全部文字颜色？"]'))`
        ),
      '统一清除没有打开确认框'
    )
    await window.webContents.executeJavaScript(
      `document.querySelector('.confirm-card[aria-label="清除全部文字颜色？"] .confirm-actions button:last-child').click()`
    )
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `window.api.getNote(${noteId}).then((note) => note.content_color_ranges.length === 0)`
        ),
      '统一清除没有删除全部颜色'
    )

    await window.webContents.executeJavaScript(`(() => {
      const card = document.querySelector(${JSON.stringify(cardSelector)})
      const rect = card.getBoundingClientRect()
      card.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 24,
        clientY: rect.top + 24
      }))
    })()`)
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(document.querySelector('.nl-context-menu button'))`
        ),
      '便签右键菜单没有打开'
    )
    await window.webContents.executeJavaScript(`(() => {
      const button = Array.from(document.querySelectorAll('.nl-context-menu button'))
        .find((item) => item.textContent.trim() === '修改')
      button.click()
    })()`)
    const editorSelector = '.app-editor .colored-text-editor__textarea'
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(document.querySelector(${JSON.stringify(editorSelector)}))`
        ),
      '完整修改编辑器没有打开'
    )
    assert.equal(await selectTextareaText(window, editorSelector, 0, 2), '请在')
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(document.querySelector('.nl-text-color-popover'))`
        ),
      '修改编辑器选区没有显示颜色浮窗'
    )
    await window.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="设置文字颜色 #af52de"]').click()`
    )
    assert.deepEqual(
      await window.webContents.executeJavaScript(
        `window.api.getNote(${noteId}).then((note) => note.content_color_ranges)`
      ),
      [],
      '修改编辑器内设色应在点击保存前保持为草稿'
    )
    await window.webContents.executeJavaScript(
      `document.querySelector('.app-editor .ne-submit').click()`
    )
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(`window.api.getNote(${noteId}).then((note) =>
          note.content_color_ranges.some((range) => range.text === '请在' && range.color === '#af52de')
        )`),
      '修改编辑器的颜色草稿没有保存'
    )

    await window.webContents.executeJavaScript(
      `document.querySelector('.ab-inline-hint--new').click()`
    )
    const createSelector = '.nnp-root .colored-text-editor__textarea'
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(document.querySelector(${JSON.stringify(createSelector)}))`
        ),
      '列表完整新建编辑器没有打开'
    )
    await window.webContents.executeJavaScript(`(() => {
      const textarea = document.querySelector(${JSON.stringify(createSelector)})
      textarea.value = '新建彩色便签'
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    assert.equal(await selectTextareaText(window, createSelector, 2, 4), '彩色')
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(document.querySelector('.nl-text-color-popover'))`
        ),
      '新建编辑器选区没有显示颜色浮窗'
    )
    await window.webContents.executeJavaScript(
      `document.querySelector('button[aria-label="设置文字颜色 #34c759"]').click()`
    )
    await window.webContents.executeJavaScript(`document.querySelector('.nnp-submit').click()`)
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(`window.api.queryRecentNotes({ cutoffTime: 0 }).then(
          (notes) => notes.some((note) => note.content === '新建彩色便签' &&
            note.content_color_ranges.some((range) => range.text === '彩色' && range.color === '#34c759'))
        )`),
      '新建便签没有原子保存局部颜色'
    )

    report(
      'list selection, full edit/create drafts, persistence, relocation, deletion and clear-all passed'
    )
    app.exit(0)
  } catch (error) {
    report(`failed: ${error?.stack || error}`)
    app.exit(1)
  }
}

app.on('will-quit', () => {
  try {
    rmSync(testUserData, { recursive: true, force: true })
  } catch {
    // Electron 退出时可能仍短暂占用临时数据库，不覆盖测试结果。
  }
})
