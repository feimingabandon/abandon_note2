import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'

const WAIT_STEP_MS = 25
const require = createRequire(import.meta.url)
const report = (message) => process.stderr.write(`[quick-note-edit-e2e] ${message}\n`)

app.commandLine.appendSwitch('disable-gpu')

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

async function waitUntil(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(WAIT_STEP_MS)
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
  insert.run('month', 'system', 'blur_enabled', 'false', now, now)
  database.close()
}

function getViewWindow(mode) {
  const fileName = mode === 'list' ? 'index' : mode
  return BrowserWindow.getAllWindows().find(
    (window) =>
      !window.isDestroyed() &&
      new RegExp(`/${fileName}\\.html(?:$|[?#])`).test(window.webContents.getURL())
  )
}

async function waitForView(mode) {
  const window = await waitUntil(() => getViewWindow(mode), `${mode} 主视图没有创建`)
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(
        `Boolean(document.querySelector('.view-switcher__trigger[data-active-view="${mode}"]'))`
      ),
    `${mode} 主视图尚未渲染完成`
  )
  return window
}

async function chooseView(window, mode) {
  await window.webContents.executeJavaScript(
    `document.querySelector('.view-switcher__trigger').click()`
  )
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(
        `Boolean(document.querySelector('.view-switcher__menu [data-view="${mode}"]'))`
      ),
    `视图菜单中没有 ${mode}`
  )
  await window.webContents.executeJavaScript(
    `document.querySelector('.view-switcher__menu [data-view="${mode}"]').click()`
  )
}

async function dispatchDoubleClick(window, selector) {
  return window.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)})
    if (!target) return false
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(new MouseEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      detail: 2,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    }))
    return true
  })()`)
}

async function quickEdit(window, { selector, content, renderedContent }) {
  assert.equal(await dispatchDoubleClick(window, selector), true, `找不到双击目标：${selector}`)
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(
        `document.activeElement?.matches('.quick-note-editor textarea') === true`
      ),
    '双击后没有聚焦快速正文编辑器'
  )
  await window.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector('.quick-note-editor textarea')
    textarea.value = ${JSON.stringify(content)}
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('.app-titlebar, .month-toolbar, body').dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    )
  })()`)
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(
        `!document.querySelector('.quick-note-editor') && Array.from(document.querySelectorAll('.msg-toast'), (node) => node.textContent.trim()).some((text) => text.includes('便签已保存'))`
      ),
    '失焦保存后没有关闭编辑器并显示成功提醒'
  )
  await waitUntil(
    () => window.webContents.executeJavaScript(renderedContent),
    '保存后的正文没有刷新到当前视图'
  )
}

const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-quick-edit-'))

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
  app.once('ready', () => void runQuickNoteEditTest())
} catch (error) {
  report(`setup failed: ${error?.stack || error}`)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}

async function runQuickNoteEditTest() {
  try {
    const listWindow = await waitForView('list')
    const noteId = await listWindow.webContents.executeJavaScript(`(async () => {
      const note = await window.api.createNote({ content: '列表快速编辑原文' })
      return note.id
    })()`)
    const cardSelector = `.nl-card[data-note-id="${noteId}"]`
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector(${JSON.stringify(cardSelector)}))`
        ),
      '新建便签没有出现在列表'
    )

    await quickEdit(listWindow, {
      selector: cardSelector,
      content: '列表失焦保存正文',
      renderedContent: `document.querySelector(${JSON.stringify(
        `${cardSelector} .nl-card-text`
      )})?.textContent.trim() === '列表失焦保存正文'`
    })

    assert.equal(await dispatchDoubleClick(listWindow, cardSelector), true)
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `document.activeElement?.matches('.quick-note-editor textarea') === true`
        ),
      '空正文校验前没有打开快速编辑器'
    )
    await listWindow.webContents.executeJavaScript(`(() => {
      const textarea = document.querySelector('.quick-note-editor textarea')
      textarea.value = ''
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('.app-titlebar').dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      )
      textarea.dispatchEvent(new FocusEvent('focusout', {
        bubbles: true,
        relatedTarget: document.body
      }))
    })()`)
    await wait(100)
    assert.deepEqual(
      await listWindow.webContents.executeJavaScript(`(() => ({
        editorVisible: Boolean(document.querySelector('.quick-note-editor')),
        warningCount: Array.from(document.querySelectorAll('.msg-toast')).filter(
          (node) => node.textContent.trim().includes('请输入便签内容')
        ).length
      }))()`),
      { editorVisible: true, warningCount: 1 },
      '空正文的一次外部操作应只显示一条警告并保留编辑器'
    )
    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.quick-note-editor')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`
    )
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(`!document.querySelector('.quick-note-editor')`),
      '空正文校验后无法使用 Escape 取消编辑'
    )

    await listWindow.webContents.executeJavaScript(
      `window.api.setSettingValue('interaction.doubleClickQuickEdit', false)`
    )
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `window.api.getSettingsSnapshot().then((snapshot) => snapshot.values.interaction.doubleClickQuickEdit === false)`
        ),
      '双击快速编辑设置没有关闭'
    )
    await wait(100)
    assert.equal(await dispatchDoubleClick(listWindow, cardSelector), true)
    await wait(300)
    assert.equal(
      await listWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.quick-note-editor'))`
      ),
      false,
      '关闭设置后列表仍打开快速编辑器'
    )
    await listWindow.webContents.executeJavaScript(
      `window.api.setSettingValue('interaction.doubleClickQuickEdit', true)`
    )
    await wait(100)

    await chooseView(listWindow, 'month')
    const monthWindow = await waitForView('month')
    const eventSelector = `.month-event-bar[data-note-id="${noteId}"]`
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector(${JSON.stringify(eventSelector)}))`
        ),
      '便签没有出现在月视图'
    )
    await monthWindow.webContents.executeJavaScript(`(() => {
      const bar = document.querySelector(${JSON.stringify(eventSelector)})
      bar.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
      document.querySelector('.month-toolbar').dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      )
    })()`)
    await wait(300)
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.month-event-tooltip'))`
      ),
      false,
      '点击外部后，延迟的单击计时器不应重新打开全文浮层'
    )
    await quickEdit(monthWindow, {
      selector: eventSelector,
      content: '月视图失焦保存正文',
      renderedContent: `document.querySelector(${JSON.stringify(
        `${eventSelector} .month-event-bar__text`
      )})?.textContent.trim() === '月视图失焦保存正文'`
    })

    await chooseView(monthWindow, 'week')
    const weekWindow = await waitForView('week')
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector(${JSON.stringify(eventSelector)}))`
        ),
      '便签没有出现在周视图'
    )
    await quickEdit(weekWindow, {
      selector: eventSelector,
      content: '周视图失焦保存正文',
      renderedContent: `document.querySelector(${JSON.stringify(
        `${eventSelector} .month-event-bar__text`
      )})?.textContent.trim() === '周视图失焦保存正文'`
    })

    assert.equal(
      await weekWindow.webContents.executeJavaScript(
        `window.api.getNote(${Number(noteId)}).then((note) => note.content)`
      ),
      '周视图失焦保存正文',
      '最终正文没有写入数据库'
    )
    report(
      'list/month/week double-click edit, blur-save, validation guard, tooltip cancellation, toast and shared setting passed'
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
