import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'

const require = createRequire(import.meta.url)
const WAIT_STEP_MS = 25

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

async function waitUntil(predicate, message, timeoutMs = 8000) {
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
  insert.run('application', 'application', 'active_view', 'list', now, now)
  insert.run('application', 'remote', 'receive_notices', 'false', now, now)
  insert.run('application', 'remote', 'upload_device_info', 'false', now, now)
  insert.run('application', 'onboarding', 'first_use_notice_version', '1', now, now)
  insert.run('main', 'system', 'blur_enabled', 'false', now, now)
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

const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-quarterly-template-e2e-'))
let exitCode = 0

async function runQuarterlyTemplateTest() {
  try {
    const listWindow = await waitUntil(() => getListWindow(), '列表主窗口没有启动', 10000)
    await waitUntil(() => listWindow.isVisible(), '列表主窗口没有显示')
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.titlebar-btn-template'))`
        ),
      '列表导航栏没有循环模板入口'
    )

    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.titlebar-btn-template').click()`
    )
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `document.querySelector('.app-template-panel')?.classList.contains('active')`
        ),
      '循环模板工作区没有打开'
    )
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `(() => {
            const box = document.querySelector('.app-template-panel .tcp-box')
            if (!box) return false
            const rect = box.getBoundingClientRect()
            return rect.left + 44 < window.innerWidth && rect.right > 0
          })()`
        ),
      '循环模板新建区域没有进入可见范围'
    )
    const createBoxTarget = await listWindow.webContents.executeJavaScript(`(() => {
      const rect = document.querySelector('.app-template-panel .tcp-box').getBoundingClientRect()
      const point = {
        x: Math.round(Math.max(rect.left + 44, Math.min(rect.right, window.innerWidth) - 20)),
        y: Math.round((rect.top + rect.bottom) / 2)
      }
      const target = document.elementFromPoint(point.x, point.y)
      return {
        point,
        rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        target: { tagName: target?.tagName || null, className: target?.className || null },
        inCreateBox: Boolean(target?.closest('.tcp-box'))
      }
    })()`)
    assert.equal(
      createBoxTarget.inCreateBox,
      true,
      `整框点击坐标必须命中新建循环模板区域: ${JSON.stringify(createBoxTarget)}`
    )
    listWindow.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...createBoxTarget.point
    })
    listWindow.webContents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      ...createBoxTarget.point
    })
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `document.querySelector('.app-template-panel .tcp-content')?.classList.contains('visible')`
        ),
      '循环模板新建表单没有展开'
    )

    const frequencyCount = await listWindow.webContents.executeJavaScript(
      `document.querySelectorAll('.app-template-panel .tfs-segments button').length`
    )
    assert.equal(frequencyCount, 5, '模板频率必须包含天、周、月、季、年五项')
    await listWindow.webContents.executeJavaScript(`(() => {
      const button = Array.from(document.querySelectorAll('.app-template-panel .tfs-segments button'))
        .find((node) => node.textContent.trim() === '季')
      button.click()
    })()`)
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.app-template-panel .tfs-quarter-months'))`
        ),
      '自然季度规则面板没有显示'
    )

    const defaults = await listWindow.webContents.executeJavaScript(`(() => ({
      quarterMonth: document.querySelector('.app-template-panel .tfs-quarter-months button.active')?.textContent.trim(),
      days: Array.from(document.querySelectorAll('.app-template-panel .tfs-panel .tfs-monthdays button.active'),
        (node) => Number(node.textContent.trim()))
    }))()`)
    assert.equal(defaults.quarterMonth, '第 3 月')
    assert.deepEqual(defaults.days, [31])

    await listWindow.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('.app-template-panel .tfs-quarter-months button')[1].click()
      const day15 = Array.from(document.querySelectorAll('.app-template-panel .tfs-panel .tfs-monthdays button'))
        .find((node) => node.textContent.trim() === '15')
      day15.click()
      const textarea = document.querySelector('.app-template-panel .tf-root textarea')
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setValue.call(textarea, '自然季度集成测试')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.app-template-panel .tf-preview strong.is-time'))`
        ),
      '自然季度下一次生成时间没有通过 IPC 完成预览'
    )
    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.app-template-panel .tf-submit').click()`
    )
    const saved = await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(`window.api.listTemplates({ state: 'all' }).then(
          (items) => items.find((item) => item.content === '自然季度集成测试') || null
        )`),
      '自然季度模板没有保存到数据库'
    )
    const rule = JSON.parse(saved.recurrence_rule)
    assert.equal(rule.frequency, 'quarterly')
    assert.equal(rule.month_of_quarter, 2)
    assert.deepEqual(rule.days_of_month, [15, 31])
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `document.querySelector('.app-template-panel .tp-list')?.textContent.includes('每季度次月 15、31 日')`
        ),
      '模板卡片没有显示自然季度摘要'
    )

    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.tc-card[data-template-id="${Number(saved.id)}"] .tc-more').click()`
    )
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `Boolean(Array.from(document.querySelectorAll('.tc-menu button')).find((node) => node.textContent.trim() === '修改'))`
        ),
      '季度模板操作菜单没有打开'
    )
    await listWindow.webContents.executeJavaScript(`(() => {
      const edit = Array.from(document.querySelectorAll('.tc-menu button'))
        .find((node) => node.textContent.trim() === '修改')
      edit.click()
    })()`)
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.tp-edit-dialog .tfs-quarter-months'))`
        ),
      '修改季度模板时没有恢复季度规则面板'
    )
    const editValues = await listWindow.webContents.executeJavaScript(`(() => ({
      frequency: document.querySelector('.tp-edit-dialog .tfs-segments button.active')?.textContent.trim(),
      quarterMonth: document.querySelector('.tp-edit-dialog .tfs-quarter-months button.active')?.textContent.trim(),
      days: Array.from(document.querySelectorAll('.tp-edit-dialog .tfs-panel .tfs-monthdays button.active'),
        (node) => Number(node.textContent.trim()))
    }))()`)
    assert.equal(editValues.frequency, '季')
    assert.equal(editValues.quarterMonth, '第 2 月')
    assert.deepEqual(editValues.days, [15, 31])

    process.stderr.write('quarterly template integration passed\n')
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
        // Crashpad 可能在进程退出前短暂占用隔离目录，不覆盖真实测试结果。
      }
      process.exit(exitCode)
    })
    app.quit()
  }
}

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
  app.once('ready', () => void runQuarterlyTemplateTest())
} catch (error) {
  console.error(error)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}
