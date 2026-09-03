import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'

const WAIT_STEP_MS = 25
const require = createRequire(import.meta.url)
const report = (message) => process.stderr.write(`[week-day-panel] ${message}\n`)

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

async function waitUntil(predicate, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(WAIT_STEP_MS)
  }
  throw new Error(message)
}

function seedWeekView(userDataPath) {
  mkdirSync(userDataPath, { recursive: true })
  const db = new Database(join(userDataPath, 'app.db'))
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
  `)
  const insert = db.prepare(`
    INSERT INTO app_settings
      (window_name, type, key, value, remark, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', ?, ?)
  `)
  const now = Date.now()
  insert.run('application', 'application', 'active_view', 'week', now, now)
  insert.run('application', 'remote', 'receive_notices', 'false', now, now)
  insert.run('application', 'remote', 'upload_device_info', 'false', now, now)
  insert.run('application', 'onboarding', 'first_use_notice_version', '1', now, now)
  insert.run('month', 'system', 'blur_enabled', 'false', now, now)
  db.close()
}

function getWeekWindow() {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && /\/week\.html(?:$|[?#])/.test(window.webContents.getURL())
  )
}

const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-week-day-panel-'))

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
  seedWeekView(testUserData)

  require(resolve('out', 'main', 'index.js'))
  const mainChunk = readdirSync(resolve('out', 'main', 'chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk, '未找到构建后的主进程分块')
  require(resolve('out', 'main', 'chunks', mainChunk))
  app.once('ready', () => void runWeekDayPanelTests())
} catch (error) {
  report(`setup failed: ${error?.stack || error}`)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}

async function runWeekDayPanelTests() {
  try {
    const weekWindow = await waitUntil(() => getWeekWindow(), '周视图未按 active_view 启动')
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `document.querySelectorAll('.month-day-cell').length === 7`
        ),
      '周视图日期格没有完成渲染'
    )

    const initial = await weekWindow.webContents.executeJavaScript(`(() => {
      const navigation = document.querySelector('.month-toolbar__navigation').getBoundingClientRect()
      const today = document.querySelector('.month-toolbar__today').getBoundingClientRect()
      const refresh = document.querySelector('.month-toolbar__refresh').getBoundingClientRect()
      const toggle = document.querySelector('.month-toolbar__day-panel-toggle')
      const toggleRect = toggle.getBoundingClientRect()
      return {
        toggleExpanded: toggle.getAttribute('aria-expanded'),
        actionsLeftOfNavigation:
          today.right <= navigation.left && refresh.right <= navigation.left,
        toggleRightOfNavigation: toggleRect.left >= navigation.right,
        selectedKey: document.querySelector('.month-day-cell.is-selected')?.dataset.date || ''
      }
    })()`)
    assert.deepEqual(
      {
        toggleExpanded: initial.toggleExpanded,
        actionsLeftOfNavigation: initial.actionsLeftOfNavigation,
        toggleRightOfNavigation: initial.toggleRightOfNavigation
      },
      {
        toggleExpanded: 'false',
        actionsLeftOfNavigation: true,
        toggleRightOfNavigation: true
      },
      '周视图工具栏没有同步月视图的操作位置和日期列表开关'
    )

    const targetKey = await weekWindow.webContents.executeJavaScript(`(() => {
      const cell = Array.from(document.querySelectorAll('.month-day-cell')).find(
        (item) => item.dataset.date !== ${JSON.stringify(initial.selectedKey)}
      )
      if (!cell) throw new Error('没有找到其他可选日期')
      cell.click()
      return cell.dataset.date
    })()`)
    assert.notEqual(targetKey, initial.selectedKey, '专项测试没有选择到另一日期')
    assert.equal(
      await weekWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.month-day-panel'))`
      ),
      false,
      '周视图点击日期不应自动展开日期列表'
    )

    await weekWindow.webContents.executeJavaScript(`(() => {
      const cell = document.querySelector('.month-day-cell[data-date="${targetKey}"]')
      const rect = cell.getBoundingClientRect()
      cell.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      }))
    })()`)
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `document.querySelector('.month-cell-context-menu-shell')?.getAttribute('aria-label') === '日期操作'`
        ),
      '周视图日期格没有打开右键菜单'
    )
    assert.deepEqual(
      await weekWindow.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.month-cell-context-menu [role="menuitem"]'), (button) => button.textContent.trim())`
      ),
      ['新建便签…', '预览当日全部便签'],
      '周视图日期右键菜单没有同步完整新建和当日预览入口'
    )
    await weekWindow.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.month-cell-context-menu [role="menuitem"]')).find((button) => button.textContent.includes('预览当日全部便签')).click()`
    )
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `document.querySelector('.month-day-preview')?.getAttribute('aria-label') === '${targetKey} 全部便签预览'`
        ),
      '周视图右键菜单没有打开当日便签预览'
    )
    assert.equal(
      await weekWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.month-day-panel'))`
      ),
      false,
      '周视图当日预览不应自动展开日期列表'
    )
    await weekWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-preview [aria-label="展开左侧操作列表"]').click()`
    )
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-day-panel'))`
        ),
      '周视图当日预览没有展开日期列表'
    )
    const [targetYear, targetMonth, targetDay] = targetKey.split('-').map(Number)
    assert.match(
      await weekWindow.webContents.executeJavaScript(
        `document.querySelector('.month-day-panel__identity strong')?.textContent.trim() || ''`
      ),
      new RegExp(`^${targetMonth}月${targetDay}日`),
      `周视图日期列表没有显示所选日期 ${targetYear}-${targetMonth}-${targetDay}`
    )

    await weekWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__day-panel-toggle').click()`
    )
    await waitUntil(
      () => weekWindow.webContents.executeJavaScript(`!document.querySelector('.month-day-panel')`),
      '周视图工具栏没有收起预览打开的日期列表'
    )
    await weekWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-cell[data-date="${initial.selectedKey}"] .month-day-cell__quick-activate').click()`
    )
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `document.activeElement?.matches('.month-day-cell[data-date="${initial.selectedKey}"] .month-day-cell__quick-create input')`
        ),
      '周视图日期格没有打开快速新建输入框'
    )
    assert.equal(
      await weekWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.month-day-panel, .month-creator'))`
      ),
      false,
      '周视图快速新建不应顺带打开日期列表或完整新建器'
    )
    await weekWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`
    )
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `!document.querySelector('.month-day-cell__quick-create.is-active')`
        ),
      '周视图快速新建输入框没有在点击外部后收起'
    )
    await weekWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-cell[data-date="${targetKey}"]').click()`
    )

    await weekWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__day-panel-toggle').click()`
    )
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-day-panel')) && document.querySelector('.month-toolbar__day-panel-toggle')?.getAttribute('aria-expanded') === 'true'`
        ),
      '周视图工具栏没有展开日期列表'
    )
    assert.equal(
      await weekWindow.webContents
        .executeJavaScript(
          `document.querySelector('.month-day-panel__identity strong')?.textContent.trim() || ''`
        )
        .then((text) => text.startsWith(`${targetMonth}月${targetDay}日`)),
      true,
      '周视图工具栏展开后没有保留所选日期'
    )

    await weekWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-cell[data-date="${targetKey}"]').click()`
    )
    assert.equal(
      await weekWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.month-day-panel'))`
      ),
      true,
      '周视图重复点击日期不应收起日期列表'
    )

    await weekWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__day-panel-toggle').click()`
    )
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `!document.querySelector('.month-day-panel') && document.querySelector('.month-toolbar__day-panel-toggle')?.getAttribute('aria-expanded') === 'false'`
        ),
      '周视图工具栏没有收起日期列表'
    )

    report('focused week day-panel interaction passed')
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
