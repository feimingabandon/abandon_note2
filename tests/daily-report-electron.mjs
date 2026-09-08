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

function dateKey(timestamp) {
  const date = new Date(timestamp)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
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
    (window) => !window.isDestroyed() && /\/index\.html(?:$|[?#])/.test(window.webContents.getURL())
  )
}

const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-report-e2e-'))
let exitCode = 0

async function verifyDynamicDatePicker(listWindow) {
  await waitUntil(
    () => listWindow.webContents.executeJavaScript(`!document.querySelector('.date-picker-panel')`),
    '前一个日期面板尚未完成收起动画'
  )
  const originalBounds = listWindow.getBounds()
  listWindow.setSize(720, 540)
  await waitUntil(() => listWindow.getBounds().height === 540, '日期面板测试窗口尺寸未就绪')
  await listWindow.webContents.executeJavaScript(
    `document.querySelector('.date-picker__trigger[aria-label="选择报表结束日期"]').click()`
  )
  await waitUntil(
    () =>
      listWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.date-picker-panel__calendar'))`
      ),
    '结束日期面板未打开'
  )
  // 在当前日期附近找一个五行、下月六行的组合，避免依赖运行当天的月份。
  const target = new Date()
  target.setDate(1)
  const rowsInMonth = (date) =>
    Math.max(
      5,
      Math.ceil(
        (((date.getDay() + 6) % 7) +
          new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()) /
          7
      )
    )
  let steps = 0
  while (steps < 12) {
    const next = new Date(target.getFullYear(), target.getMonth() + 1, 1)
    if (rowsInMonth(target) === 5 && rowsInMonth(next) === 6) break
    target.setMonth(target.getMonth() + 1)
    steps += 1
  }
  assert.ok(steps < 12, '未找到相邻的五行和六行月份')
  async function waitForMonth(date) {
    const firstKey = dateKey(date)
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(`(() => {
        const calendar = document.querySelector('.date-picker-panel__calendar')
        return Boolean(calendar?.querySelector('[aria-label="${firstKey}"]:not(.is-other)')) &&
          calendar.querySelectorAll('button').length === ${rowsInMonth(date) * 7} &&
          !calendar.getAnimations().some((animation) => animation.playState === 'running')
      })()`),
      `日期选择器没有完成 ${firstKey} 的切月`
    ).catch(async (error) => {
      console.error(
        await listWindow.webContents.executeJavaScript(`(() => {
        const calendar = document.querySelector('.date-picker-panel__calendar')
        return { title: document.querySelector('.date-picker-panel__header')?.textContent,
          count: calendar?.querySelectorAll('button').length,
          first: calendar?.querySelector('button:not(.is-other)')?.getAttribute('aria-label'),
          animations: calendar?.getAnimations().map((item) => item.playState) }
      })()`)
      )
      throw error
    })
  }
  const cursor = new Date()
  cursor.setDate(1)
  await waitForMonth(cursor)
  for (let index = 0; index < steps; index += 1) {
    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.date-picker-panel [aria-label="下个月"]').click()`
    )
    cursor.setMonth(cursor.getMonth() + 1)
    await waitForMonth(cursor)
  }
  const five = await listWindow.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.date-picker-panel')
    const trigger = document.querySelector('.date-picker__trigger[aria-label="选择报表结束日期"]').parentElement
    const rect = trigger.getBoundingClientRect()
    const height = panel.offsetHeight
    const desiredTop = window.innerHeight - height - rect.height - 7 - 20
    trigger.style.transform = 'translateY(' + (desiredTop - rect.top) + 'px)'
    window.dispatchEvent(new Event('resize'))
    return { height, viewport: window.innerHeight }
  })()`)
  assert.ok(five.height + 50 < five.viewport, '测试窗口必须容得下完整日期面板')
  await waitUntil(
    () =>
      listWindow.webContents.executeJavaScript(
        `Math.abs(document.querySelector('.date-picker-panel').getBoundingClientRect().bottom - (window.innerHeight - 20)) < 2`
      ),
    '五行面板未定位到靠近窗口底部的位置'
  )
  await listWindow.webContents.executeJavaScript(
    `document.querySelector('.date-picker-panel [aria-label="下个月"]').click()`
  )
  cursor.setMonth(cursor.getMonth() + 1)
  await waitForMonth(cursor)
  const six = await waitUntil(
    () =>
      listWindow.webContents.executeJavaScript(`(() => {
      const rect = document.querySelector('.date-picker-panel').getBoundingClientRect()
      const footer = document.querySelector('.date-picker-panel__footer').getBoundingClientRect()
      return rect.bottom <= window.innerHeight - 11 && rect.top >= 11 && footer.bottom <= window.innerHeight - 11
        ? { height: rect.height, top: rect.top } : null
    })()`),
    '切到六行后面板或今天按钮超出窗口，未按实际高度重新定位'
  )
  assert.ok(six.height > five.height + 25, '测试必须实际增加一行日期')
  await listWindow.webContents.executeJavaScript(
    `document.querySelector('.date-picker-panel [aria-label="上个月"]').click()`
  )
  cursor.setMonth(cursor.getMonth() - 1)
  await waitForMonth(cursor)
  await waitUntil(
    () =>
      listWindow.webContents.executeJavaScript(
        `Math.abs(document.querySelector('.date-picker-panel').getBoundingClientRect().bottom - (window.innerHeight - 20)) < 2`
      ),
    '切回五行后没有恢复触发器下方的位置'
  )
  await listWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('.date-picker__trigger[aria-label="选择报表结束日期"]').parentElement.style.removeProperty('transform')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })()`)
  await waitUntil(
    () => listWindow.webContents.executeJavaScript(`!document.querySelector('.date-picker-panel')`),
    '日期面板未正常关闭'
  )
  listWindow.setBounds(originalBounds)
  process.stderr.write('date picker 5/6/5 viewport positioning passed\n')
}

async function runDailyReportTest() {
  try {
    const listWindow = await waitUntil(getListWindow, '列表主窗口没有按隔离设置启动', 10000)
    await waitUntil(() => listWindow.isVisible(), '列表主窗口渲染就绪后没有显示')
    const now = Date.now()
    const previousDay = new Date()
    previousDay.setHours(9, 0, 0, 0)
    previousDay.setDate(previousDay.getDate() - 1)
    const db = new Database(join(testUserData, 'app.db'))
    const insert = db.prepare(`
      INSERT INTO notes (
        content, status, is_deleted, is_pinned, notify_enabled, effective_at,
        duration_days, finished_at, sort_order, created_at, updated_at
      ) VALUES (?, 'in_progress', 0, 0, 0, ?, 1, ?, 0, ?, ?)
    `)
    insert.run('今天的报表便签', now, now, now, now)
    insert.run(
      '昨天的报表便签',
      previousDay.getTime(),
      previousDay.getTime(),
      previousDay.getTime(),
      previousDay.getTime()
    )
    db.close()
    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.titlebar-btn-daily-report[title="导出便签报表"]').click()`
    )
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.daily-report'))`
        ),
      '便签报表弹窗没有打开'
    )

    const initial = await waitUntil(async () => {
      const state = await listWindow.webContents.executeJavaScript(`(() => ({
        datePickers: document.querySelectorAll('.daily-report__date-range .date-picker').length,
        selected: document.querySelector('.daily-report__selected-summary')?.textContent.trim(),
        formats: [...document.querySelectorAll('.daily-report__format')].map((item) => ({
          text: item.textContent.trim(),
          checked: item.getAttribute('aria-checked')
        }))
      }))()`)
      return state.selected === '已选择 1 条' ? state : null
    }, '单日报表预览没有加载今天的便签')
    assert.equal(initial.datePickers, 2, '报表弹窗没有开始和结束两个日期选择器')
    assert.deepEqual(
      initial.formats.map((item) => item.text),
      ['TXT', 'Excel']
    )
    assert.equal(initial.formats[0].checked, 'true', 'TXT 没有保持为默认导出格式')

    await listWindow.webContents.executeJavaScript(`(() => {
      document.querySelector('[aria-label="选择报表开始日期"]').click()
    })()`)
    const previousDateKey = dateKey(previousDay.getTime())
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.date-picker-panel__day[aria-label="${previousDateKey}"]'))`
        ),
      '开始日期选择面板没有打开'
    )
    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.date-picker-panel__day[aria-label="${previousDateKey}"]').click()`
    )
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `document.querySelector('.daily-report__selected-summary')?.textContent.trim() === '已选择 2 条'`
        ),
      '两日报表预览没有同时加载两条便签'
    )

    await listWindow.webContents.executeJavaScript(`(() => {
      const excel = [...document.querySelectorAll('.daily-report__format')].find(
        (item) => item.textContent.trim() === 'Excel'
      )
      excel.click()
    })()`)
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(`(() => {
          const excel = [...document.querySelectorAll('.daily-report__format')].find(
            (item) => item.textContent.trim() === 'Excel'
          )
          const exportButton = [...document.querySelectorAll('button')].find(
            (item) => item.textContent.trim() === '导出 Excel'
          )
          return excel?.getAttribute('aria-checked') === 'true' && Boolean(exportButton)
        })()`),
      '选择 Excel 后导出操作没有切换'
    )

    await verifyDynamicDatePicker(listWindow)
    process.stderr.write('daily report range dialog integration passed\n')
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
  app.once('ready', () => void runDailyReportTest())
} catch (error) {
  console.error(error)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}
