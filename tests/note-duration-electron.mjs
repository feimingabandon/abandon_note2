import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'

const WAIT_STEP_MS = 25
const require = createRequire(import.meta.url)
const report = (message) => process.stderr.write(`[duration-e2e] ${message}\n`)

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

async function waitUntil(predicate, message, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(WAIT_STEP_MS)
  }
  throw new Error(message)
}

function seedLegacyListDatabase(userDataPath) {
  mkdirSync(userDataPath, { recursive: true })
  const db = new Database(join(userDataPath, 'app.db'))
  const now = Date.now()
  const future = now + 3 * 24 * 60 * 60 * 1000
  db.exec(`
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
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_type TEXT NOT NULL DEFAULT 'one_time' CHECK(note_type IN ('one_time')),
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'initialized'
        CHECK(status IN ('initialized','in_progress','completed')),
      is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN (0, 1)),
      is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
      notify_enabled INTEGER NOT NULL DEFAULT 0 CHECK(notify_enabled IN (0, 1)),
      effective_at INTEGER NOT NULL,
      finished_at INTEGER,
      remind_again_at INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE note_tags (
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      tag_name TEXT NOT NULL REFERENCES tags(name) ON DELETE CASCADE,
      PRIMARY KEY (note_id, tag_name)
    );
    PRAGMA user_version = 0;
  `)
  db.prepare(
    `INSERT INTO notes (
       content, status, effective_at, finished_at, created_at, updated_at
     ) VALUES ('旧库单日便签', 'initialized', ?, ?, ?, ?)`
  ).run(future, now, now, now)
  db.prepare('INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)').run(
    '旧库标签',
    '#007aff',
    now
  )
  db.prepare('INSERT INTO note_tags (note_id, tag_name) VALUES (1, ?)').run('旧库标签')
  const insertSetting = db.prepare(`
    INSERT INTO app_settings
      (window_name, type, key, value, remark, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', ?, ?)
  `)
  insertSetting.run('application', 'application', 'active_view', 'list', now, now)
  insertSetting.run('application', 'remote', 'receive_notices', 'false', now, now)
  insertSetting.run('application', 'remote', 'upload_device_info', 'false', now, now)
  insertSetting.run('main', 'system', 'blur_enabled', 'false', now, now)
  db.close()
}

function getListWindow() {
  return BrowserWindow.getAllWindows().find(
    (window) =>
      !window.isDestroyed() &&
      /\/index\.html(?:$|[?#])/.test(window.webContents.getURL()) &&
      !/\/sticky\.html(?:$|[?#])/.test(window.webContents.getURL())
  )
}

const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-duration-e2e-'))
let exitCode = 0

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
  seedLegacyListDatabase(testUserData)
  process.argv.push('abandon-note://notification/open?id=1')
  require(resolve('out', 'main', 'index.js'))
  const mainChunk = readdirSync(resolve('out', 'main', 'chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk, '未找到构建后的主进程分块')
  require(resolve('out', 'main', 'chunks', mainChunk))
  app.once('ready', () => void runTests())
} catch (error) {
  report(`setup failed: ${error?.stack || error}`)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}

async function runTests() {
  try {
    const window = await waitUntil(() => getListWindow(), '列表主窗口未启动', 10000)
    await waitUntil(() => window.isVisible(), '列表主窗口未显示')

    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(document.querySelector('.app-editor-dialog textarea')?.value.includes('旧库单日便签'))`
        ),
      '冷启动通知没有定位并打开对应便签'
    )
    assert.equal(
      await window.webContents.executeJavaScript(
        `document.activeElement === document.querySelector('.app-editor-dialog textarea')`
      ),
      true,
      '通知打开编辑器后焦点必须进入正文'
    )
    await window.webContents.executeJavaScript(
      `document.querySelector('.app-editor-close').click()`
    )
    await waitUntil(
      () => window.webContents.executeJavaScript(`!document.querySelector('.app-editor-dialog')`),
      '通知打开的编辑器无法关闭'
    )

    const migrated = await window.webContents.executeJavaScript(`window.api.getNote(1)`)
    assert.equal(migrated.duration_days, 1, '旧库便签必须自动补为持续 1 天')
    assert.equal(migrated.tags[0]?.name, '旧库标签', 'V0 旧库标签关联迁移失败')
    assert.equal(
      existsSync(join(testUserData, 'app-v0-before-v3.db')),
      true,
      'V0 旧库在标签 ID 迁移前必须创建备份'
    )

    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(Array.from(document.querySelectorAll('.nl-card')).find((card) => card.textContent.includes('旧库单日便签')))`
        ),
      '旧库便签未进入列表'
    )

    await window.webContents.executeJavaScript(`window.api.createTag('空层级测试', '#ff9500')`)
    await window.webContents.executeJavaScript(`document.querySelector('.sg-btn--tags').click()`)
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `document.querySelector('.nl-tags .ts-more')?.textContent.includes('2')`
        ),
      '标签筛选面板没有载入新增标签'
    )
    await window.webContents.executeJavaScript(
      `document.querySelector('.nl-tags .ts-more').click()`
    )
    await waitUntil(
      () => window.webContents.executeJavaScript(`Boolean(document.querySelector('.ts-panel'))`),
      '标签下拉面板未打开'
    )
    await window.webContents.executeJavaScript(`(() => {
      const row = Array.from(document.querySelectorAll('.ts-panel-row')).find((node) => node.textContent.includes('空层级测试'))
      row.querySelector('.ts-panel-select').click()
    })()`)
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(document.querySelector('[data-presence-clone]'))`
        ),
      '标签筛选没有生成便签退场副本'
    )
    const filterLayers = await window.webContents.executeJavaScript(`(() => ({
      presence: Number.parseInt(getComputedStyle(document.querySelector('[data-presence-clone]')).zIndex, 10),
      popover: Number.parseInt(getComputedStyle(document.querySelector('.ts-panel')).zIndex, 10)
    }))()`)
    assert.ok(
      filterLayers.presence < filterLayers.popover,
      `便签退场层必须低于标签面板层，实际为 ${filterLayers.presence} / ${filterLayers.popover}`
    )
    await window.webContents.executeJavaScript(`(() => {
      const row = Array.from(document.querySelectorAll('.ts-panel-row')).find((node) => node.textContent.includes('空层级测试'))
      row.querySelector('.ts-panel-select').click()
    })()`)
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(Array.from(document.querySelectorAll('.nl-card:not([data-presence-clone])')).find((card) => card.textContent.includes('旧库单日便签')))`
        ),
      '取消标签筛选后便签没有恢复'
    )
    await window.webContents.executeJavaScript(
      `document.querySelector('.nl-tags .ts-more').click()`
    )

    await window.webContents.executeJavaScript(`(() => {
      const card = Array.from(document.querySelectorAll('.nl-card')).find((node) => node.textContent.includes('旧库单日便签'))
      card.querySelector('.sr-control[title="提前开始"]').click()
    })()`)
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(document.querySelector('.confirm-card.active'))`
        ),
      '单日便签提前执行未弹出确认框'
    )
    const ordinaryConfirmText = await window.webContents.executeJavaScript(
      `document.querySelector('.confirm-message').textContent`
    )
    assert.doesNotMatch(ordinaryConfirmText, /持续 \d+ 天/)
    await window.webContents.executeJavaScript(`(() => {
      const cancel = Array.from(document.querySelectorAll('.confirm-actions button')).find((node) => node.textContent.trim() === '取消')
      cancel.click()
    })()`)
    await waitUntil(
      () => window.webContents.executeJavaScript(`!document.querySelector('.confirm-card')`),
      '提前执行确认框未关闭'
    )

    await window.webContents.executeJavaScript(
      `document.querySelector('.ab-box-btn[title="新建"]').click()`
    )
    await waitUntil(
      () => window.webContents.executeJavaScript(`Boolean(document.querySelector('.nnp-body'))`),
      '新建便签面板未展开'
    )
    assert.equal(
      await window.webContents.executeJavaScript(
        `Boolean(document.querySelector('.nnp-body .note-duration-field'))`
      ),
      false,
      '未选生效时间时不应显示持续天数'
    )

    await window.webContents.executeJavaScript(
      `document.querySelector('.nnp-body .dt-trigger').click()`
    )
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(`Boolean(document.querySelector('.dt-panel-wrap'))`),
      '生效时间选择器未打开'
    )
    assert.equal(
      await window.webContents.executeJavaScript(
        `document.querySelectorAll('.dt-panel-wrap .dt-header-input')[1].value`
      ),
      '00:01:00',
      '列表新建便签打开生效时间面板时必须默认到当天 00:01'
    )
    await window.webContents.executeJavaScript(`(() => {
      const shortcut = Array.from(document.querySelectorAll('.dt-sc-chip')).find((node) => node.textContent.trim() === '明天')
      shortcut.click()
      document.querySelector('.dt-btn--confirm').click()
    })()`)
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `document.querySelector('.note-duration-field')?.classList.contains('note-duration-enter-active')`
        ),
      '持续天数显示时未执行展开动画'
    )
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(document.querySelector('.note-duration-field:not(.note-duration-enter-active)'))`
        ),
      '持续天数展开动画未完成'
    )
    assert.equal(
      await window.webContents.executeJavaScript(
        `document.querySelector('.note-duration-field input').value`
      ),
      '1',
      '持续天数默认值必须为 1'
    )

    await window.webContents.executeJavaScript(
      `document.querySelector('.nnp-body .dt-clear-btn').click()`
    )
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `document.querySelector('.note-duration-field')?.classList.contains('note-duration-leave-active')`
        ),
      '持续天数隐藏时未执行收起动画'
    )
    await waitUntil(
      () => window.webContents.executeJavaScript(`!document.querySelector('.note-duration-field')`),
      '持续天数收起动画未完成'
    )

    await window.webContents.executeJavaScript(
      `document.querySelector('.nnp-body .dt-trigger').click()`
    )
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(`Boolean(document.querySelector('.dt-panel-wrap'))`),
      '生效时间选择器未再次打开'
    )
    await window.webContents.executeJavaScript(`(() => {
      const shortcut = Array.from(document.querySelectorAll('.dt-sc-chip')).find((node) => node.textContent.trim() === '明天')
      shortcut.click()
      document.querySelector('.dt-btn--confirm').click()
    })()`)
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(document.querySelector('.note-duration-field:not(.note-duration-enter-active)'))`
        ),
      '持续天数重新展开动画未完成'
    )

    await window.webContents.executeJavaScript(`(() => {
      const textarea = document.querySelector('.nnp-body .rt-textarea')
      textarea.value = '月视图跨日便签'
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      const duration = document.querySelector('.note-duration-field input')
      duration.value = '3'
      duration.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await waitUntil(
      () => window.webContents.executeJavaScript(`!document.querySelector('.nnp-submit').disabled`),
      '新建便签按钮未启用'
    )
    await window.webContents.executeJavaScript(`document.querySelector('.nnp-submit').click()`)
    const created = await waitUntil(
      () =>
        window.webContents.executeJavaScript(`window.api.searchNotes({
          search: '月视图跨日便签',
          statuses: [],
          tagIds: [],
          includeDeleted: false,
          sort: 'effective',
          limit: 20,
          offset: 0
        }).then((result) => result.notes?.[0] || null)`),
      '新建便签未持久化'
    )
    assert.equal(created.duration_days, 3, '新建便签未保存持续天数')

    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(Array.from(document.querySelectorAll('.nl-card')).find((card) => card.textContent.includes('月视图跨日便签')))`
        ),
      '新建便签未进入列表'
    )
    await window.webContents.executeJavaScript(`(() => {
      const card = Array.from(document.querySelectorAll('.nl-card')).find((node) => node.textContent.includes('月视图跨日便签'))
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 180 }))
    })()`)
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(`Boolean(document.querySelector('.nl-context-menu'))`),
      '便签操作菜单未打开'
    )
    await window.webContents.executeJavaScript(`(() => {
      const edit = Array.from(document.querySelectorAll('.nl-context-menu button')).find((node) => node.textContent.trim() === '修改')
      edit.click()
    })()`)
    await waitUntil(
      () => window.webContents.executeJavaScript(`Boolean(document.querySelector('.ne-root'))`),
      '便签修改器未打开'
    )
    assert.equal(
      await window.webContents.executeJavaScript(
        `document.querySelector('.ne-root .note-duration-field input').value`
      ),
      '3',
      '修改器未读取持续天数'
    )
    await window.webContents.executeJavaScript(`(() => {
      const duration = document.querySelector('.ne-root .note-duration-field input')
      duration.value = '5'
      duration.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await waitUntil(
      () => window.webContents.executeJavaScript(`!document.querySelector('.ne-submit').disabled`),
      '修改便签保存按钮未启用'
    )
    await window.webContents.executeJavaScript(`document.querySelector('.ne-submit').click()`)
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `window.api.getNote(${created.id}).then((note) => note.duration_days === 5)`
        ),
      '修改器未保存持续天数'
    )

    await waitUntil(
      () => window.webContents.executeJavaScript(`!document.querySelector('.app-editor-overlay')`),
      '便签修改器未关闭'
    )
    await window.webContents.executeJavaScript(`(() => {
      const card = Array.from(document.querySelectorAll('.nl-card')).find((node) => node.textContent.includes('月视图跨日便签'))
      card.querySelector('.sr-control[title="提前开始"]').click()
    })()`)
    await waitUntil(
      () =>
        window.webContents.executeJavaScript(
          `Boolean(document.querySelector('.confirm-card.active'))`
        ),
      '多日便签提前执行未弹出确认框'
    )
    const confirmText = await window.webContents.executeJavaScript(
      `document.querySelector('.confirm-message').textContent`
    )
    assert.match(confirmText, /持续 5 天/)
    assert.match(confirmText, /日历视图/)

    report(
      'legacy migration, animated duration field, create, edit and early-start confirmation passed'
    )
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    process.exitCode = exitCode
    app.releaseSingleInstanceLock()
    app.once('quit', () => {
      try {
        rmSync(testUserData, { recursive: true, force: true })
      } catch {
        // Crashpad 可能在进程完全退出前仍持有临时目录句柄。
      }
      process.exit(exitCode)
    })
    app.quit()
  }
}
