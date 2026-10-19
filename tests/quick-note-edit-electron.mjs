import { mkdirSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, screen } from 'electron'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'
import { dismissStartupShortcutNotice } from './helpers/startup-shortcut-notice.mjs'

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/quick-note-edit-electron.mjs',
  mode: 'real-app-native-double-click-quick-edit-list-month-week',
  prefix: 'abandon-note-quick-edit-',
  timeoutMs: 180000,
  metadata: {
    realRendererAndPreload: true,
    realDiskDatabase: true,
    nativePointerInput: true,
    domControlInput: true,
    views: ['list', 'month', 'week']
  }
})
const { assert } = lifecycle

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
    if (value) {
      assert.ok(value, message)
      return value
    }
    await wait(WAIT_STEP_MS)
  }
  assert.fail(message)
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

async function prepareCalendarEventViewport(window) {
  await waitUntil(() => window.isVisible(), '日历视图没有显示')
  // Compact calendars may intentionally expose counts without any event lanes.
  // These cases exercise painted bars; keep the window inside the work area.
  const bounds = window.getBounds()
  const { workArea } = screen.getDisplayMatching(bounds)
  const width = Math.min(workArea.width - 48, Math.max(bounds.width, 960))
  const height = Math.min(workArea.height - 48, Math.max(bounds.height, 720))
  const targetBounds = {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height
  }
  window.setBounds(targetBounds)
  await waitUntil(() => {
    const actual = window.getBounds()
    return Object.entries(targetBounds).every(([key, value]) => actual[key] === value)
  }, '日历横条场景没有进入工作区内的测试尺寸')
  await window.webContents.executeJavaScript(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
  )
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
  await window.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block: 'center'})`
  )
  await wait(250)
  const point = await window.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)})
    if (!target) return null
    const text = target.querySelector('.nl-card-text, .month-event-bar__text') || target
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode()) && !node.data.trim()) {}
    const range = document.createRange()
    if (node?.length) { const start = Array.from(node.data).findIndex(c => c.trim()); range.setStart(node, start); range.setEnd(node, start + 1) }
    const rect = node?.length ? range.getBoundingClientRect() : target.getBoundingClientRect()
    return {x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2)}
  })()`)
  if (!point) return false
  window.focus()
  window.webContents.focus()
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  for (const clickCount of [1, 2]) {
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount, ...point })
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount, ...point })
    await wait(50)
  }
  return true
}

async function verifySidebarDoubleClick(window, selector) {
  await window.webContents.executeJavaScript(`(() => {
    const toggle = document.querySelector('.month-toolbar__day-panel-toggle')
    if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click()
  })()`)
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(
        `Boolean(document.querySelector(${JSON.stringify(selector)}))`
      ),
    '日期侧栏便签未显示'
  )
  assert.equal(await dispatchDoubleClick(window, selector), true)
  await waitUntil(
    () =>
      window.webContents.executeJavaScript(
        `document.activeElement?.matches('.quick-note-editor textarea') === true`
      ),
    '日期侧栏正文双击未进入编辑'
  )
  assert.equal(
    await window.webContents.executeJavaScript(
      `Boolean(document.querySelector('[data-note-text-color-popover]'))`
    ),
    false
  )
  await window.webContents.executeJavaScript(
    `document.querySelector('.quick-note-editor').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  )
  await waitUntil(
    () => window.webContents.executeJavaScript(`!document.querySelector('.quick-note-editor')`),
    '侧栏编辑器未关闭'
  )
  await window.webContents.executeJavaScript(
    `document.querySelector('.month-toolbar__day-panel-toggle').click()`
  )
  await wait(350)
}

function businessState(note) {
  return {
    status: note.status,
    effective_at: note.effective_at,
    finished_at: note.finished_at,
    duration_kind: note.duration_kind,
    duration_days: note.duration_days,
    notify_enabled: note.notify_enabled,
    reminder_channels: note.reminder_channels
  }
}

async function quickEdit(window, { selector, content, renderedContent, noteId }) {
  const before = await window.webContents.executeJavaScript(`window.api.getNote(${Number(noteId)})`)
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
    document.body.dispatchEvent(
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
  const after = await window.webContents.executeJavaScript(`window.api.getNote(${Number(noteId)})`)
  assert.equal(after.content, content, '快捷正文已经持久化')
  assert.deepEqual(
    businessState(after),
    businessState(before),
    '快捷正文修改保留状态、精确时间、持续方式和提醒'
  )
}

const testUserData = lifecycle.root

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
  void lifecycle.finish({ error })
}

async function runQuickNoteEditTest() {
  let activeWindow
  const checkedViews = []
  try {
    const listWindow = await waitForView('list')
    activeWindow = listWindow
    await dismissStartupShortcutNotice(listWindow)
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

    await listWindow.webContents.executeJavaScript(`(() => {
      window.__unexpectedColorPopovers = 0
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node.nodeType === 1 && (node.matches('[data-note-text-color-popover]') || node.querySelector('[data-note-text-color-popover]'))) window.__unexpectedColorPopovers++
        }
      }).observe(document.body, { childList: true, subtree: true })
    })()`)
    await quickEdit(listWindow, {
      noteId,
      selector: cardSelector,
      content: '列表失焦保存正文',
      renderedContent: `document.querySelector(${JSON.stringify(
        `${cardSelector} .nl-card-text`
      )})?.textContent.trim() === '列表失焦保存正文'`
    })

    for (const minimal of [true, false]) {
      await listWindow.webContents.executeJavaScript(
        `window.api.setSettingValue('listAppearance.minimalMode', ${minimal})`
      )
      await wait(150)
      await listWindow.webContents.executeJavaScript(
        `(async () => { const note = await window.api.getNote(${noteId}); return window.api.setNoteTextColor({ id: ${noteId}, start: 0, end: 2, color: '#ff3b30', expectedContent: note.content, expectedColorRanges: note.content_color_ranges }) })()`
      )
      await wait(200)
      await quickEdit(listWindow, {
        noteId,
        selector: cardSelector,
        content: minimal ? '极简双击编辑正文' : '列表双击编辑正文',
        renderedContent: `document.querySelector(${JSON.stringify(cardSelector + ' .nl-card-text')})?.textContent.trim() === '${minimal ? '极简双击编辑正文' : '列表双击编辑正文'}'`
      })
    }
    assert.equal(
      await listWindow.webContents.executeJavaScript('window.__unexpectedColorPopovers'),
      0,
      '双击期间不应闪出颜色面板'
    )

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
      document.body.dispatchEvent(
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
    assert.ok(
      await listWindow.webContents.executeJavaScript('window.getSelection().toString().trim()'),
      '关闭双击编辑后应保留原生选词'
    )
    await listWindow.webContents.executeJavaScript(
      `window.api.setSettingValue('interaction.doubleClickQuickEdit', true)`
    )
    await wait(100)
    checkedViews.push('list')

    await chooseView(listWindow, 'month')
    const monthWindow = await waitForView('month')
    activeWindow = monthWindow
    await prepareCalendarEventViewport(monthWindow)
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
      noteId,
      selector: eventSelector,
      content: '月视图失焦保存正文',
      renderedContent: `document.querySelector(${JSON.stringify(
        `${eventSelector} .month-event-bar__text`
      )})?.textContent.trim() === '月视图失焦保存正文'`
    })

    await verifySidebarDoubleClick(monthWindow, cardSelector)
    checkedViews.push('month')

    await chooseView(monthWindow, 'week')
    const weekWindow = await waitForView('week')
    activeWindow = weekWindow
    await prepareCalendarEventViewport(weekWindow)
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector(${JSON.stringify(eventSelector)}))`
        ),
      '便签没有出现在周视图'
    )
    await quickEdit(weekWindow, {
      noteId,
      selector: eventSelector,
      content: '周视图失焦保存正文',
      renderedContent: `document.querySelector(${JSON.stringify(
        `${eventSelector} .month-event-bar__text`
      )})?.textContent.trim() === '周视图失焦保存正文'`
    })

    await verifySidebarDoubleClick(weekWindow, cardSelector)
    checkedViews.push('week')

    assert.equal(
      await weekWindow.webContents.executeJavaScript(
        `window.api.getNote(${Number(noteId)}).then((note) => note.content)`
      ),
      '周视图失焦保存正文',
      '最终正文没有写入数据库'
    )
    report(
      'native double-click: list/minimal/colored text/month/week/sidebar, no color popup flash, disabled native selection, blur-save and validation passed'
    )
    await lifecycle.finish({ completed: true, window: activeWindow, summary: { checkedViews } })
  } catch (error) {
    report(`failed: ${error?.stack || error}`)
    await lifecycle.finish({ error, window: activeWindow, summary: { checkedViews } })
  }
}
