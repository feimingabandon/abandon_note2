import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import ExcelJS from 'exceljs'
import { app, BrowserWindow, dialog } from 'electron'
import { verifyDatePickerKeyboard } from './helpers/date-picker-keyboard.mjs'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'

const require = createRequire(import.meta.url)
const excelRequire = createRequire(require.resolve('exceljs/package.json'))
const JSZip = excelRequire('jszip')
const WAIT_STEP_MS = 25
const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/daily-report-electron.mjs',
  mode: 'electron-real-app-daily-report-selected-range-txt-xlsx-export',
  prefix: 'abandon-note-report-e2e-',
  timeoutMs: 90000,
  metadata: {
    actualApp: true,
    realSqlite: true,
    actualPreloadAndIpc: true,
    actualFileExports: ['txt', 'xlsx'],
    actualTagFilters: ['multiple-tags-or', 'uncategorized', 'clear-all', 'manual-selection'],
    tagLayoutBackgrounds: 'real css settings; complex wallpaper uses test-only body background',
    systemSaveDialog: 'controlled-response-only',
    rendererApiMocked: false,
    clipboardAccess: false,
    assertionCounterScope:
      'suite lifecycle.assert calls only; date-picker helper has independent assertions',
    actualWindowsSaveDialogInteraction: false,
    actualExcelApplication: false
  }
})
const { assert } = lifecycle
const testUserData = lifecycle.root
const testEvidenceRoot = process.env.ABANDON_TEST_EVIDENCE_DIR || testUserData
const exportDirectory = join(testEvidenceRoot, 'daily-report-exports')
const originalShowSaveDialog = dialog.showSaveDialog
const plannedExports = []
const saveDialogCalls = []
const keyboardHelperCompleted = []
let activeWindow = null
let failureUi = null
let exportReadback = null
let seedEvidence = null
let tagFilterEvidence = null
const tagLayoutCaptures = []
const datePickerPositionEvidence = []

function restoreSaveDialog() {
  dialog.showSaveDialog = originalShowSaveDialog
}

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

function localDateFields(timestamp) {
  const date = new Date(timestamp)
  return [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds()
  ]
}

function floatingDateFields(date) {
  return [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds()
  ]
}

function expectedDateCell(fields, format) {
  const [year, month, day, hour, minute, second, millisecond] = fields
  return {
    fields,
    format,
    // These real-app fixtures use modern dates in Excel's 1900 system.
    serial: Date.UTC(year, month - 1, day, hour, minute, second, millisecond) / 86400000 + 25569
  }
}

function seedListView(userDataPath) {
  mkdirSync(userDataPath, { recursive: true })
  const db = new Database(join(userDataPath, 'app.db'))
  try {
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
  } finally {
    db.close()
  }
}

function getListWindow() {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && /\/index\.html(?:$|[?#])/.test(window.webContents.getURL())
  )
}

async function dismissStartupShortcutNotice(listWindow) {
  // Another running copy may own F1/F2. Use the actual startup notice rather
  // than changing shortcut settings or interacting with other applications.
  const pending = await listWindow.webContents.executeJavaScript(
    'window.api.getShortcutStartupNotice()'
  )
  if (!pending.length) return
  await waitUntil(
    () =>
      listWindow.webContents.executeJavaScript(`(() => {
        const notice = document.querySelector('[aria-label="快捷键启用提示"]')
        return [...(notice?.querySelectorAll('button') || [])].some(button =>
          button.textContent.trim() === '稍后处理' && !button.disabled
        )
      })()`),
    '真实启动快捷键提示没有显示稍后处理按钮'
  )
  const dismissed = await listWindow.webContents.executeJavaScript(`(() => {
    const notice = document.querySelector('[aria-label="快捷键启用提示"]')
    const button = [...(notice?.querySelectorAll('button') || [])].find(item =>
      item.textContent.trim() === '稍后处理'
    )
    if (!button || button.disabled) return false
    button.click()
    return true
  })()`)
  assert.equal(dismissed, true, '必须通过真实稍后处理按钮关闭启动快捷键提示')
  await waitUntil(
    () =>
      listWindow.webContents.executeJavaScript(
        `!document.querySelector('[aria-label="快捷键启用提示"]')`
      ),
    '启动快捷键提示没有彻底退出，不能打开日报'
  )
}

async function verifyDynamicDatePicker(listWindow) {
  // This geometry fixture deliberately translates its trigger outside the form.
  // Relax only that fixture's clipping; real filter scrolling is checked below
  // with the production styles in verifyTagReportLayout.
  const filterStyle = await listWindow.webContents.executeJavaScript(`(() => {
    const filters = document.querySelector('.daily-report__filters')
    const style = filters.getAttribute('style')
    filters.style.overflow = 'visible'
    filters.style.maxHeight = 'none'
    return style
  })()`)
  await waitUntil(
    () => listWindow.webContents.executeJavaScript(`!document.querySelector('.date-picker-panel')`),
    '前一个日期面板尚未完成收起动画'
  )
  const originalBounds = listWindow.getBounds()
  listWindow.setSize(720, 540)
  await waitUntil(() => listWindow.getBounds().height === 540, '日期面板测试窗口尺寸未就绪')
  await waitUntil(
    () => listWindow.webContents.executeJavaScript('innerHeight === 540'),
    '窄窗口渲染视口未完成尺寸更新'
  )
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
  // In a compact window neither side can fit six rows. The complete panel must stay
  // in the viewport, and its real scrollport must make the Today control reachable.
  await listWindow.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.date-picker-panel')
    const trigger = document.querySelector('.date-picker__trigger[aria-label="选择报表结束日期"]').parentElement
    const rect = trigger.getBoundingClientRect()
    const desiredTop = innerHeight - panel.offsetHeight - rect.height - 7 - 20
    trigger.style.transform = 'translateY(' + (desiredTop - rect.top) + 'px)'
    window.dispatchEvent(new Event('resize'))
  })()`)
  await waitUntil(
    () =>
      listWindow.webContents.executeJavaScript(
        `Math.abs(document.querySelector('.date-picker-panel').getBoundingClientRect().bottom - (innerHeight - 20)) < 2`
      ),
    '窄窗口五行面板未靠近底部，无法覆盖六行滚动场景'
  )
  await listWindow.webContents.executeJavaScript(
    `document.querySelector('.date-picker-panel [aria-label="下个月"]').click()`
  )
  cursor.setMonth(cursor.getMonth() + 1)
  await waitForMonth(cursor)
  await waitUntil(
    () =>
      listWindow.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('.date-picker-panel')
      const rect = panel.getBoundingClientRect()
      return rect.top >= 8 - 1 && rect.bottom <= innerHeight - 8 + 1 &&
        panel.scrollHeight > panel.clientHeight + 1
    })()`),
    '窄窗口六行面板没有保持视口边界与可滚动内容'
  )
  datePickerPositionEvidence.push({
    phase: 'compact-six-rows',
    ...(await readDatePickerGeometry(listWindow))
  })
  await listWindow.webContents.executeJavaScript(`(() => {
    const today = document.querySelector('.date-picker-panel__footer button')
    today.focus({ preventScroll: true })
    today.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
  })()`)
  await waitUntil(
    () =>
      listWindow.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('.date-picker-panel')
      const today = panel.querySelector('.date-picker-panel__footer button')
      const panelRect = panel.getBoundingClientRect()
      const buttonRect = today.getBoundingClientRect()
      return document.activeElement === today && panel.scrollTop > 0 &&
        buttonRect.top >= panelRect.top + 1 && buttonRect.bottom <= panelRect.bottom - 1 &&
        buttonRect.top >= 8 - 1 && buttonRect.bottom <= innerHeight - 8 + 1
    })()`),
    '窄窗口滚动后今天按钮不可见或无法获得焦点'
  )
  datePickerPositionEvidence.push({
    phase: 'compact-today-reachable',
    ...(await readDatePickerGeometry(listWindow))
  })
  await listWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('.date-picker-panel').scrollTop = 0
    document.querySelector('.date-picker__trigger[aria-label="选择报表结束日期"]').parentElement.style.removeProperty('transform')
    document.querySelector('.date-picker-panel [aria-label="上个月"]').click()
  })()`)
  cursor.setMonth(cursor.getMonth() - 1)
  await waitForMonth(cursor)
  // A 5-row panel below and a 6-row panel above need room on both sides of the anchor.
  listWindow.setSize(720, 780)
  await waitUntil(() => listWindow.getBounds().height === 780, '翻转场景窗口尺寸未就绪')
  await waitUntil(
    () => listWindow.webContents.executeJavaScript('innerHeight === 780'),
    '翻转场景渲染视口未完成尺寸更新'
  )
  const five = await listWindow.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.date-picker-panel')
    const trigger = document.querySelector('.date-picker__trigger[aria-label="选择报表结束日期"]').parentElement
    const rect = trigger.getBoundingClientRect()
    const height = panel.offsetHeight
    const desiredTop = window.innerHeight - height - rect.height - 7 - 20
    trigger.style.transform = 'translateY(' + (desiredTop - rect.top) + 'px)'
    window.dispatchEvent(new Event('resize'))
    return { height, viewport: window.innerHeight, triggerHeight: rect.height,
      availableAbove: desiredTop - 6 - 8,
      availableBelow: height + 13,
      rowHeight: panel.querySelector('.date-picker-panel__day').getBoundingClientRect().height }
  })()`)
  assert.ok(five.height + 50 < five.viewport, '测试窗口必须容得下完整日期面板')
  assert.ok(
    five.availableAbove > five.height + five.rowHeight &&
      five.availableAbove > five.availableBelow &&
      five.availableBelow < five.height + five.rowHeight,
    '测试必须给六行面板足够的上方空间，同时只允许五行面板放在下方'
  )
  await waitUntil(
    () =>
      listWindow.webContents.executeJavaScript(
        `Math.abs(document.querySelector('.date-picker-panel').getBoundingClientRect().bottom - (window.innerHeight - 20)) < 2`
      ),
    '五行面板未定位到靠近窗口底部的位置'
  )
  datePickerPositionEvidence.push({
    phase: 'five-rows',
    ...(await readDatePickerGeometry(listWindow))
  })
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
      const panel = document.querySelector('.date-picker-panel')
      return rect.bottom <= window.innerHeight - 8 + 1 && rect.top >= 8 - 1 &&
        footer.bottom <= rect.bottom - 1 && panel.scrollHeight <= panel.clientHeight + 1 &&
        getComputedStyle(panel).getPropertyValue('--popover-placement').trim() === 'top'
        ? { height: rect.height, top: rect.top } : null
    })()`),
    '切到六行后面板或今天按钮超出窗口，未按实际高度重新定位'
  )
  datePickerPositionEvidence.push({
    phase: 'six-rows',
    ...(await readDatePickerGeometry(listWindow))
  })
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
  datePickerPositionEvidence.push({
    phase: 'five-rows-restored',
    ...(await readDatePickerGeometry(listWindow))
  })
  await listWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('.date-picker__trigger[aria-label="选择报表结束日期"]').parentElement.style.removeProperty('transform')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })()`)
  await waitUntil(
    () => listWindow.webContents.executeJavaScript(`!document.querySelector('.date-picker-panel')`),
    '日期面板未正常关闭'
  )
  listWindow.setBounds(originalBounds)
  await listWindow.webContents.executeJavaScript(`(() => {
    const filters = document.querySelector('.daily-report__filters')
    const style = ${JSON.stringify(filterStyle)}
    if (style === null) filters.removeAttribute('style')
    else filters.setAttribute('style', style)
  })()`)
  process.stderr.write('date picker 5/6/5 viewport positioning passed\n')
}

async function readDatePickerGeometry(listWindow) {
  return listWindow.webContents.executeJavaScript(`(() => {
    const rect = element => element?.getBoundingClientRect().toJSON() ?? null
    const panel = document.querySelector('.date-picker-panel')
    const trigger = document.querySelector('.date-picker__trigger[aria-label="选择报表结束日期"]')?.parentElement
    const style = panel && getComputedStyle(panel)
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      trigger: rect(trigger), panel: rect(panel),
      footer: rect(panel?.querySelector('.date-picker-panel__footer')),
      calendar: rect(panel?.querySelector('.date-picker-panel__calendar')),
      title: panel?.querySelector('.date-picker-panel__header')?.textContent.trim(),
      dayCount: panel?.querySelectorAll('.date-picker-panel__day').length,
      scrollHeight: panel?.scrollHeight, clientHeight: panel?.clientHeight,
      scrollTop: panel?.scrollTop, inlineStyle: panel?.getAttribute('style'),
      placement: style?.getPropertyValue('--popover-placement').trim(),
      maxHeight: style?.maxHeight, overflowY: style?.overflowY,
      animations: panel?.getAnimations({ subtree: true }).map(animation => animation.playState)
    }
  })()`)
}

function installControlledSaveDialog() {
  dialog.showSaveDialog = async (parent, options) => {
    const next = plannedExports.shift()
    assert.ok(next, '报表出现未计划的系统保存对话框')
    assert.equal(parent?.id, activeWindow?.id, '保存对话框必须属于真实列表窗口')
    assert.equal(options.title, '导出便签报表')
    assert.equal(options.defaultPath, `Abandon报表-${next.rangeLabel}.${next.format}`)
    assert.deepEqual(
      options.filters,
      next.format === 'xlsx'
        ? [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
        : [{ name: '文本文件', extensions: ['txt'] }]
    )
    saveDialogCalls.push({
      parentId: parent.id,
      format: next.format,
      defaultPath: options.defaultPath,
      filePath: next.filePath,
      selectedContents: next.selectedContents
    })
    return { canceled: false, filePath: next.filePath }
  }
}

async function readPreviewSelection(listWindow) {
  return listWindow.webContents.executeJavaScript(`(() =>
    [...document.querySelectorAll('.daily-report-note')].map(note => ({
      content: note.querySelector('.daily-report-note__content').textContent,
      tag: note.querySelector('.daily-report-note__tag')?.textContent.trim(),
      checked: note.querySelector('input').checked
    }))
  )()`)
}

async function selectOnlyReportNote(listWindow, selectedContent, excludedContent) {
  const preview = await readPreviewSelection(listWindow)
  assert.deepEqual(
    preview.map((note) => note.content).sort(),
    ['今天的报表便签', '昨天的报表便签'].sort()
  )
  assert.ok(
    preview.every((note) => note.checked),
    '两日预览应最初选中所有便签'
  )
  const changed = await listWindow.webContents.executeJavaScript(`(() => {
    const excluded = [...document.querySelectorAll('.daily-report-note')].find(note =>
      note.querySelector('.daily-report-note__content').textContent === ${JSON.stringify(excludedContent)}
    )
    if (!excluded?.querySelector('input').checked) return false
    excluded.querySelector('input').click()
    return true
  })()`)
  assert.equal(changed, true, '必须通过真实复选框取消另一条便签')
  await waitUntil(async () => {
    const selected = await readPreviewSelection(listWindow)
    return (
      selected
        .filter((note) => note.checked)
        .map((note) => note.content)
        .join() === selectedContent
    )
  }, '报表选中范围没有更新到唯一目标便签')
  assert.deepEqual(
    (await readPreviewSelection(listWindow))
      .filter((note) => note.checked)
      .map((note) => note.content),
    [selectedContent]
  )
}

async function selectReportFormat(listWindow, label) {
  const changed = await listWindow.webContents.executeJavaScript(`(() => {
    const format = [...document.querySelectorAll('.daily-report__formats .daily-report__format')].find(item =>
      item.textContent.trim() === ${JSON.stringify(label)}
    )
    if (!format) return false
    format.click()
    return true
  })()`)
  assert.equal(changed, true, `未找到真实 ${label} 格式按钮`)
  await waitUntil(
    () =>
      listWindow.webContents.executeJavaScript(`(() => {
      const format = [...document.querySelectorAll('.daily-report__formats .daily-report__format')].find(item =>
        item.textContent.trim() === ${JSON.stringify(label)}
      )
      return format?.getAttribute('aria-checked') === 'true'
    })()`),
    `${label} 格式没有实际选中`
  )
}

async function exportFromReportButton(listWindow, plan) {
  plannedExports.push(plan)
  const callsBefore = saveDialogCalls.length
  const label = plan.format === 'xlsx' ? '导出 Excel' : '导出 TXT'
  const clicked = await listWindow.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('.daily-report')?.closest('.app-modal-card')
    const button = [...(card?.querySelectorAll('button') || [])].find(item =>
      item.textContent.trim() === ${JSON.stringify(label)}
    )
    if (!button || button.disabled) return false
    button.click()
    return true
  })()`)
  assert.equal(clicked, true, `真实 ${label} 操作不可用`)
  const successMessage = await waitUntil(
    () =>
      listWindow.webContents.executeJavaScript(`(() => {
      const card = document.querySelector('.confirm-card[aria-label="导出成功"]')
      return card?.classList.contains('active') ? card.querySelector('.confirm-message').textContent : null
    })()`),
    `${label} 没有显示真实导出成功反馈`
  )
  assert.ok(successMessage.includes(plan.fileName), '成功反馈没有对应实际保存的文件名')
  assert.equal(saveDialogCalls.length, callsBefore + 1, '一个用户导出只能产生一次保存对话框')
  assert.equal(plannedExports.length, 0, '计划的保存路径未被实际 IPC 使用')
  return readFileSync(plan.filePath)
}

async function closeExportSuccess(listWindow) {
  const closed = await listWindow.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('.confirm-card[aria-label="导出成功"]')
    const button = [...(card?.querySelectorAll('button') || [])].find(item => item.textContent.trim() === '关闭')
    if (!button) return false
    button.click()
    return true
  })()`)
  assert.equal(closed, true, '导出成功对话框没有关闭按钮')
  await waitUntil(
    () =>
      listWindow.webContents.executeJavaScript(
        `!document.querySelector('.confirm-card[aria-label="导出成功"]') && !document.querySelector('.daily-report')`
      ),
    '导出后的报表与成功模态没有正常完成退出'
  )
}

async function reopenTwoDayReport(listWindow, previousDateKey) {
  await listWindow.webContents.executeJavaScript(
    `document.querySelector('.titlebar-btn-daily-report[title="导出便签报表"]').click()`
  )
  await waitUntil(
    () =>
      listWindow.webContents.executeJavaScript(
        `document.querySelector('.daily-report__selected-summary')?.textContent.trim() === '已选择 1 条'`
      ),
    '重新打开的单日报表没有加载今天便签'
  )
  await listWindow.webContents.executeJavaScript(
    `document.querySelector('[aria-label="选择报表开始日期"]').click()`
  )
  await waitUntil(
    () =>
      listWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.date-picker-panel__day[aria-label="${previousDateKey}"]'))`
      ),
    '重新打开的开始日期面板未就绪'
  )
  await listWindow.webContents.executeJavaScript(
    `document.querySelector('.date-picker-panel__day[aria-label="${previousDateKey}"]').click()`
  )
  await waitUntil(
    () =>
      listWindow.webContents.executeJavaScript(
        `document.querySelector('.daily-report__selected-summary')?.textContent.trim() === '已选择 2 条' && !document.querySelector('.date-picker-panel')`
      ),
    '重新打开的两日预览没有加载两条便签'
  )
}

async function verifyActualFileExports(listWindow, todayTimestamp, yesterdayTimestamp) {
  const todayKey = dateKey(todayTimestamp)
  const yesterdayKey = dateKey(yesterdayTimestamp)
  const rangeLabel = `${yesterdayKey}至${todayKey}`
  const formatDate = (timestamp) => {
    const date = new Date(timestamp)
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
  }
  const header = `便签报表 ${formatDate(yesterdayTimestamp)} 至 ${formatDate(todayTimestamp)}`
  const today = new Date(todayTimestamp)
  const pad = (value) => String(value).padStart(2, '0')
  const todayTime = `${todayKey} ${pad(today.getHours())}:${pad(today.getMinutes())}`
  const txtPlan = {
    format: 'txt',
    rangeLabel,
    fileName: 'daily-report-selected-today.txt',
    filePath: join(exportDirectory, 'daily-report-selected-today.txt'),
    selectedContents: ['今天的报表便签']
  }
  await selectOnlyReportNote(listWindow, '今天的报表便签', '昨天的报表便签')
  await selectReportFormat(listWindow, 'TXT')
  const txt = await exportFromReportButton(listWindow, txtPlan)
  assert.deepEqual([...txt.subarray(0, 3)], [0xef, 0xbb, 0xbf], '真实 TXT 导出应包含 UTF-8 BOM')
  assert.equal(
    txt.toString('utf8'),
    `\uFEFF${header}\n\n【进行中】\n1. 今天的报表便签\n   标签：未分类\n   生效时间：${todayTime}\n`,
    'TXT 必须只有勾选的今天便签，保留实际两日范围和中文内容'
  )
  await closeExportSuccess(listWindow)
  await reopenTwoDayReport(listWindow, yesterdayKey)
  await selectOnlyReportNote(listWindow, '昨天的报表便签', '今天的报表便签')
  await selectReportFormat(listWindow, 'Excel')
  const xlsxPlan = {
    format: 'xlsx',
    rangeLabel,
    fileName: 'daily-report-selected-yesterday.xlsx',
    filePath: join(exportDirectory, 'daily-report-selected-yesterday.xlsx'),
    selectedContents: ['昨天的报表便签']
  }
  const xlsx = await exportFromReportButton(listWindow, xlsxPlan)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(xlsx)
  assert.equal(workbook.subject, header)
  const sheet = workbook.getWorksheet('便签报表')
  assert.ok(sheet, '真实 XLSX 文件没有便签报表工作表')
  assert.deepEqual(sheet.getRow(1).values.slice(1), [
    '便签内容',
    '标签',
    '当前状态',
    '是否完成',
    '生效时间',
    '结束日期',
    '持续天数',
    '完成时间',
    '是否置顶'
  ])
  assert.equal(sheet.rowCount, 2, 'XLSX 必须只有表头和唯一选中的昨天便签')
  const row = sheet.getRow(2)
  assert.equal(row.getCell(1).value, '昨天的报表便签')
  assert.equal(row.getCell(2).value, '未分类')
  assert.equal(row.getCell(3).value, '进行中')
  assert.equal(row.getCell(4).value, '否')
  const expectedDateCells = {
    E2: {
      ...expectedDateCell(localDateFields(yesterdayTimestamp), 'yyyy-mm-dd hh:mm'),
      sourceTimestamp: yesterdayTimestamp
    },
    F2: {
      ...expectedDateCell([...yesterdayKey.split('-').map(Number), 0, 0, 0, 0], 'yyyy-mm-dd'),
      sourceDateKey: yesterdayKey
    }
  }
  assert.ok(row.getCell(5).value instanceof Date)
  assert.deepEqual(floatingDateFields(row.getCell(5).value), expectedDateCells.E2.fields)
  assert.ok(row.getCell(6).value instanceof Date)
  assert.deepEqual(floatingDateFields(row.getCell(6).value), expectedDateCells.F2.fields)
  assert.equal(row.getCell(7).value, 1)
  assert.equal(row.getCell(8).value, null)
  assert.equal(row.getCell(9).value, '否')
  // Inspect the bytes actually written by UI -> preload -> IPC -> SQLite export.
  // JSZip only opens the container; ExcelJS's Date round trip is insufficient.
  const zip = await JSZip.loadAsync(xlsx)
  const xmlFiles = {
    worksheet: 'xl/worksheets/sheet1.xml',
    styles: 'xl/styles.xml',
    workbook: 'xl/workbook.xml'
  }
  const xml = {}
  for (const [name, path] of Object.entries(xmlFiles)) {
    xml[name] = await zip.file(path).async('string')
    writeFileSync(join(testEvidenceRoot, `daily-report-xlsx-${name}.xml`), xml[name], {
      flag: 'wx'
    })
  }
  assert.equal(/<workbookPr\b[^>]*\bdate1904="(?:1|true)"/.test(xml.workbook), false)
  const rawCells = new Map(
    [...xml.worksheet.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((cell) => [
      cell[1].match(/\br="([^"]*)"/)?.[1],
      {
        raw: (cell[2] ?? '').match(/<v>([^<]*)<\/v>/)?.[1] ?? null,
        type: cell[1].match(/\bt="([^"]*)"/)?.[1] ?? 'n'
      }
    ])
  )
  const rawDateCells = {}
  for (const [reference, expected] of Object.entries(expectedDateCells)) {
    const actual = rawCells.get(reference)
    assert.equal(actual?.type, 'n', `${reference} must contain a numeric Excel date`)
    assert.ok(actual.raw !== null && Number.isFinite(Number(actual.raw)))
    assert.ok(Math.abs(Number(actual.raw) - expected.serial) < 1e-9, reference)
    assert.equal(sheet.getCell(reference).numFmt, expected.format)
    rawDateCells[reference] = actual
  }
  assert.equal(rawCells.get('H2')?.raw ?? null, null)
  assert.deepEqual(
    readdirSync(exportDirectory).sort(),
    [txtPlan.fileName, xlsxPlan.fileName].sort()
  )
  exportReadback = {
    range: { startDateKey: yesterdayKey, endDateKey: todayKey },
    seed: seedEvidence,
    txt: {
      file: `daily-report-exports/${txtPlan.fileName}`,
      sha256: createHash('sha256').update(txt).digest('hex'),
      selectedContents: txtPlan.selectedContents,
      text: txt.toString('utf8')
    },
    xlsx: {
      file: `daily-report-exports/${xlsxPlan.fileName}`,
      sha256: createHash('sha256').update(xlsx).digest('hex'),
      selectedContents: xlsxPlan.selectedContents,
      subject: workbook.subject,
      rowCount: sheet.rowCount,
      row: row.values.slice(1),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offsetMinutes: new Date(yesterdayTimestamp).getTimezoneOffset(),
      expectedDateCells,
      rawDateCells
    },
    saveDialogCalls,
    boundary:
      'real UI/preload/IPC/SQLite/export-files; only OS save dialog response is controlled; no clipboard'
  }
  writeFileSync(
    join(testEvidenceRoot, 'daily-report-export-readback.json'),
    JSON.stringify(exportReadback, null, 2),
    { flag: 'wx' }
  )
}

async function waitForReportContents(listWindow, contents, message) {
  const expected = [...contents].sort()
  const preview = await waitUntil(async () => {
    const busy = await listWindow.webContents.executeJavaScript(
      `document.querySelector('.daily-report__list')?.getAttribute('aria-busy')`
    )
    if (busy !== 'false') return null
    const current = await readPreviewSelection(listWindow)
    return JSON.stringify(current.map((note) => note.content).sort()) === JSON.stringify(expected)
      ? current
      : null
  }, message)
  assert.deepEqual(preview.map((note) => note.content).sort(), expected, message)
  return preview
}

async function openTodayReport(listWindow, contents) {
  await listWindow.webContents.executeJavaScript(
    `document.querySelector('.titlebar-btn-daily-report[title="导出便签报表"]').click()`
  )
  return waitForReportContents(listWindow, contents, '重新打开日报应重置为今天、全部标签')
}

async function toggleReportTag(listWindow, name) {
  const opened = await listWindow.webContents.executeJavaScript(`(() => {
    const more = document.querySelector('.daily-report__tag-picker .ts-more')
    if (!more) return false
    more.click()
    return true
  })()`)
  assert.equal(opened, true, '日报必须复用真实标签选择器的更多入口')
  await waitUntil(
    () =>
      listWindow.webContents.executeJavaScript(`(() =>
      [...document.querySelectorAll('.ts-panel .ts-panel-select')].some(button =>
        button.title === ${JSON.stringify(name)}
      ))()`),
    `标签更多面板没有读取当前标签 ${name}`
  )
  const clicked = await listWindow.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('.ts-panel .ts-panel-select')].find(item =>
      item.title === ${JSON.stringify(name)}
    )
    if (!button) return false
    button.click()
    document.querySelector('.daily-report__tag-picker .ts-more').click()
    return true
  })()`)
  assert.equal(clicked, true, `必须通过真实标签按钮选择 ${name}`)
  await waitUntil(
    () => listWindow.webContents.executeJavaScript(`!document.querySelector('.ts-panel')`),
    '标签面板没有完成退出'
  )
}

async function selectReportContents(listWindow, contents) {
  const selected = await listWindow.webContents.executeJavaScript(`(() => {
    const wanted = new Set(${JSON.stringify(contents)})
    const notes = [...document.querySelectorAll('.daily-report-note')]
    for (const note of notes) {
      const content = note.querySelector('.daily-report-note__content').textContent
      const checkbox = note.querySelector('input')
      if (checkbox.checked !== wanted.has(content)) checkbox.click()
    }
    return notes.filter(note => note.querySelector('input').checked).map(note =>
      note.querySelector('.daily-report-note__content').textContent
    )
  })()`)
  assert.deepEqual(selected.sort(), [...contents].sort(), '筛选后的导出范围必须来自真实复选框')
  await waitUntil(
    () =>
      listWindow.webContents.executeJavaScript(
        `document.querySelector('.daily-report__selected-summary')?.textContent.trim() === '已选择 ${contents.length} 条'`
      ),
    '筛选后的手动勾选计数未同步'
  )
}

async function verifyTagFilteredExports(listWindow, timestamp) {
  await closeExportSuccess(listWindow)
  const tagNames = ['报表工作', '报表生活', '报表其他']
  const tags = await listWindow.webContents.executeJavaScript(`(async () => {
    const tags = []
    for (const name of ${JSON.stringify(tagNames)}) {
      tags.push(await window.api.createTag(name))
    }
    return tags
  })()`)
  assert.deepEqual(
    tags.map((tag) => tag.name),
    tagNames,
    '真实标签 IPC 必须写入隔离数据库'
  )
  assert.ok(tags.every((tag) => Number.isSafeInteger(tag.id) && tag.id > 0))
  const [workTag, lifeTag, otherTag] = tags
  const fixtures = [
    { content: '标签筛选·保留工作便签', tagId: workTag.id },
    { content: '标签筛选·手动取消工作便签', tagId: workTag.id },
    { content: '标签筛选·生活便签', tagId: lifeTag.id },
    { content: '标签筛选·其他标签便签', tagId: otherTag.id },
    { content: '标签筛选·导出前移出标签', tagId: workTag.id }
  ]
  const [kept, omitted, life, other, moved] = fixtures
  const untagged = '今天的报表便签'
  const allContents = [untagged, ...fixtures.map((note) => note.content)]
  const db = new Database(join(testUserData, 'app.db'))
  try {
    db.transaction(() => {
      const insert = db.prepare(`
        INSERT INTO notes (
          content, status, is_deleted, is_pinned, notify_enabled, effective_at,
          duration_days, finished_at, sort_order, created_at, updated_at
        ) VALUES (?, 'in_progress', 0, 0, 0, ?, 1, ?, 0, ?, ?)
      `)
      const bind = db.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)')
      for (const note of fixtures) {
        note.id = Number(
          insert.run(note.content, timestamp, timestamp, timestamp, timestamp).lastInsertRowid
        )
        bind.run(note.id, note.tagId)
      }
    })()
  } finally {
    db.close()
  }
  const listedTags = await listWindow.webContents.executeJavaScript('window.api.listTags()')
  assert.ok(tags.every((tag) => listedTags.some((listed) => listed.id === tag.id)))
  const filters = {}
  filters.all = await openTodayReport(listWindow, allContents)
  assert.ok(
    filters.all.every((note) => note.checked),
    '全部标签预览应默认全部勾选'
  )

  await toggleReportTag(listWindow, workTag.name)
  const workContents = [kept.content, omitted.content, moved.content]
  filters.work = await waitForReportContents(
    listWindow,
    workContents,
    '单标签筛选没有查询真实关联表'
  )
  assert.ok(filters.work.every((note) => note.tag === `标签：${workTag.name}`))
  await toggleReportTag(listWindow, lifeTag.name)
  filters.or = await waitForReportContents(
    listWindow,
    [...workContents, life.content],
    '多个标签应采用 OR，不能要求同一便签同时拥有多个标签'
  )
  await listWindow.webContents.executeJavaScript(
    `document.querySelector('.daily-report__tag-untagged').click()`
  )
  filters.mixed = await waitForReportContents(
    listWindow,
    [...workContents, life.content, untagged],
    '未分类应能与多个正数标签并选，且不能混入其他标签'
  )
  await listWindow.webContents.executeJavaScript(
    `document.querySelector('.daily-report__tag-all').click()`
  )
  filters.cleared = await waitForReportContents(
    listWindow,
    allContents,
    '全部按钮必须同时清除正数标签及未分类筛选'
  )
  await listWindow.webContents.executeJavaScript(
    `document.querySelector('.daily-report__tag-untagged').click()`
  )
  filters.uncategorized = await waitForReportContents(
    listWindow,
    [untagged],
    '仅选未分类应排除所有存在标签关联的便签'
  )
  assert.equal(filters.uncategorized[0].tag, '标签：未分类')
  await toggleReportTag(listWindow, workTag.name)
  await waitForReportContents(
    listWindow,
    [...workContents, untagged],
    '未分类与单标签并选没有刷新真实预览'
  )
  await selectReportContents(listWindow, [kept.content, moved.content, untagged])
  const intermediateWorkName = '报表工作已改'
  await listWindow.webContents.executeJavaScript(
    `window.api.updateTag(${workTag.id}, { name: ${JSON.stringify(intermediateWorkName)}, color: '#3478f6' })`
  )
  await waitUntil(async () => {
    const current = await readPreviewSelection(listWindow)
    return current.some(
      (note) => note.content === kept.content && note.tag === `标签：${intermediateWorkName}`
    )
  }, '真实 tagsChanged 事件没有刷新打开的报表标签')
  const selectionAfterTagEvent = await readPreviewSelection(listWindow)
  assert.deepEqual(
    selectionAfterTagEvent
      .filter((note) => note.checked)
      .map((note) => note.content)
      .sort(),
    [kept.content, moved.content, untagged].sort(),
    '仅标签名称变化不得撤销手动取消勾选或重新全选'
  )
  const stalePreview = await readPreviewSelection(listWindow)
  assert.equal(stalePreview.find((note) => note.content === omitted.content)?.checked, false)

  // Mutate only the owned test database, without a notes-changed broadcast. The
  // real renderer must send its stale selection and the main process must requery.
  const renamedWorkTag = '报表工作新名'
  const changedDb = new Database(join(testUserData, 'app.db'))
  let currentTagRows
  try {
    changedDb.transaction(() => {
      assert.equal(
        changedDb
          .prepare('UPDATE note_tags SET tag_id = ? WHERE note_id = ?')
          .run(otherTag.id, moved.id).changes,
        1
      )
      assert.equal(
        changedDb.prepare('UPDATE tags SET name = ? WHERE id = ?').run(renamedWorkTag, workTag.id)
          .changes,
        1
      )
    })()
    currentTagRows = changedDb
      .prepare(
        `
      SELECT nt.note_id, t.id, t.name FROM note_tags nt
      JOIN tags t ON t.id = nt.tag_id ORDER BY nt.note_id, t.id
    `
      )
      .all()
  } finally {
    changedDb.close()
  }
  assert.ok(
    (await readPreviewSelection(listWindow)).some(
      (note) => note.content === moved.content && note.checked
    ),
    '标签变动场景必须实际保留已失效的选中预览，才能验证导出重新筛选'
  )
  const expectedContents = [kept.content, untagged]
  const todayKey = dateKey(timestamp)
  const xlsxPlan = {
    format: 'xlsx',
    rangeLabel: todayKey,
    fileName: 'daily-report-tag-filtered.xlsx',
    filePath: join(exportDirectory, 'daily-report-tag-filtered.xlsx'),
    selectedContents: expectedContents
  }
  await selectReportFormat(listWindow, 'Excel')
  const xlsx = await exportFromReportButton(listWindow, xlsxPlan)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(xlsx)
  const sheet = workbook.getWorksheet('便签报表')
  assert.ok(sheet, '标签筛选真实 XLSX 缺少便签报表工作表')
  assert.deepEqual(sheet.getRow(1).values.slice(1, 3), ['便签内容', '标签'])
  assert.equal(sheet.rowCount, 3, '标签筛选、当前关联与手动勾选应共同收敛为两条导出记录')
  const rows = [sheet.getRow(2).values.slice(1), sheet.getRow(3).values.slice(1)]
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row[0], row[1]])), {
    [kept.content]: renamedWorkTag,
    [untagged]: '未分类'
  })

  await closeExportSuccess(listWindow)
  await openTodayReport(listWindow, allContents)
  await toggleReportTag(listWindow, renamedWorkTag)
  await listWindow.webContents.executeJavaScript(
    `document.querySelector('.daily-report__tag-untagged').click()`
  )
  filters.afterTagChange = await waitForReportContents(
    listWindow,
    [kept.content, omitted.content, untagged],
    '重新打开后的真实预览应使用最新标签名称及关联'
  )
  await selectReportContents(listWindow, expectedContents)
  await selectReportFormat(listWindow, 'TXT')
  const txtPlan = {
    format: 'txt',
    rangeLabel: todayKey,
    fileName: 'daily-report-tag-filtered.txt',
    filePath: join(exportDirectory, 'daily-report-tag-filtered.txt'),
    selectedContents: expectedContents
  }
  const txt = await exportFromReportButton(listWindow, txtPlan)
  assert.deepEqual([...txt.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  const text = txt.toString('utf8')
  for (const content of expectedContents) assert.equal(text.split(content).length - 1, 1)
  for (const note of [omitted, life, other, moved]) assert.equal(text.includes(note.content), false)
  assert.equal((text.match(/标签：/g) || []).length, 2)
  assert.ok(text.includes(`标签：${renamedWorkTag}`))
  assert.ok(text.includes('标签：未分类'))
  tagFilterEvidence = {
    tags,
    fixtures,
    filters,
    selectionAfterTagEvent,
    stalePreview,
    currentTagRows,
    xlsx: {
      file: `daily-report-exports/${xlsxPlan.fileName}`,
      sha256: createHash('sha256').update(xlsx).digest('hex'),
      rows
    },
    txt: {
      file: `daily-report-exports/${txtPlan.fileName}`,
      sha256: createHash('sha256').update(txt).digest('hex'),
      text
    },
    boundary: 'real SQLite/renderer controls/preload/IPC/files; no renderer API replacement'
  }
  await closeExportSuccess(listWindow)
  await openTodayReport(listWindow, allContents)
  await toggleReportTag(listWindow, renamedWorkTag)
  await toggleReportTag(listWindow, lifeTag.name)
  await listWindow.webContents.executeJavaScript(
    `document.querySelector('.daily-report__tag-untagged').click()`
  )
  await waitForReportContents(
    listWindow,
    [kept.content, omitted.content, life.content, untagged],
    '局部外观验收必须保留真实多选标签与未分类结果'
  )
}

async function readTagReportLayout(listWindow) {
  return listWindow.webContents.executeJavaScript(`(() => {
    const report = document.querySelector('.daily-report')
    const card = report?.closest('.app-modal-card')
    const list = report?.querySelector('.daily-report__list')
    const rect = element => element?.getBoundingClientRect().toJSON() ?? null
    const describe = element => {
      if (!element) return null
      const box = element.getBoundingClientRect()
      const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return { rect: box.toJSON(), enabled: !element.disabled,
        hit: target === element || element.contains(target) }
    }
    const exportButton = [...(card?.querySelectorAll('button') || [])].find(button =>
      /^导出 (TXT|Excel)$/.test(button.textContent.trim())
    )
    return {
      viewport: { width: innerWidth, height: innerHeight },
      card: rect(card), tags: rect(report?.querySelector('.daily-report__tags')),
      picker: rect(report?.querySelector('.daily-report__tag-picker')),
      all: describe(report?.querySelector('.daily-report__tag-all')),
      untagged: describe(report?.querySelector('.daily-report__tag-untagged')),
      more: describe(report?.querySelector('.daily-report__tag-picker .ts-more')),
      export: describe(exportButton), close: describe(card?.querySelector('.app-modal-close')),
      horizontalOverflow: Boolean(card && card.scrollWidth > card.clientWidth + 1),
      list: list && { height: list.clientHeight, scrollHeight: list.scrollHeight,
        scrollTop: list.scrollTop, overflowY: getComputedStyle(list).overflowY },
      controlsAnimating: [...report.querySelectorAll('button')].some(button =>
        button.getAnimations().some(animation => animation.playState === 'running')
      ),
      contentColor: getComputedStyle(report.querySelector('.daily-report-note__content')).color
    }
  })()`)
}

function assertTagControlsFit(layout) {
  assert.ok(
    layout.card.left >= 0 &&
      layout.card.top >= 0 &&
      layout.card.right <= layout.viewport.width + 1 &&
      layout.card.bottom <= layout.viewport.height + 1,
    `报表卡片应位于视口内：${JSON.stringify(layout)}`
  )
  assert.equal(layout.horizontalOverflow, false, '标签行不得造成卡片横向溢出')
  for (const name of ['tags', 'picker']) {
    const box = layout[name]
    assert.ok(
      box && box.left >= layout.card.left - 1 && box.right <= layout.card.right + 1,
      `${name} 不得超出报表卡片`
    )
  }
  for (const name of ['all', 'untagged', 'more', 'export', 'close']) {
    const control = layout[name]
    assert.ok(
      control &&
        control.enabled &&
        control.rect.width > 0 &&
        control.rect.height > 0 &&
        control.rect.left >= layout.card.left - 1 &&
        control.rect.right <= layout.card.right + 1 &&
        control.rect.top >= layout.card.top - 1 &&
        control.rect.bottom <= layout.card.bottom + 1 &&
        control.hit,
      `${name} 必须位于卡片内且可命中：${JSON.stringify(control)}`
    )
  }
}

async function verifyTagReportLayout(listWindow) {
  const originalBounds = listWindow.getBounds()
  const original = await listWindow.webContents.executeJavaScript(`(async () => ({
    settings: (await window.api.getSettingsSnapshot()).values,
    bodyBackground: document.body.style.background
  }))()`)
  const layouts = []
  try {
    listWindow.setSize(850, 760)
    await listWindow.webContents.executeJavaScript(
      `window.api.setSettingValue('appearance.uiScale', 1)`
    )
    for (const [name, background, foreground] of [
      ['white', '255 255 255', '#111111'],
      ['black', '0 0 0', '#eeeeee'],
      ['complex', '224 232 239', '#17202a']
    ]) {
      const backdrop =
        name === 'complex'
          ? 'repeating-linear-gradient(35deg,#31577f 0px,#31577f 70px,#dcb36e 70px,#dcb36e 140px,#9c6065 140px,#9c6065 210px)'
          : `rgb(${background})`
      await listWindow.webContents.executeJavaScript(`(async () => {
        await window.api.setSettingValue('css.bgColor', ${JSON.stringify(background)})
        await window.api.setSettingValue('css.textColor', ${JSON.stringify(foreground)})
        // Test-only backdrop; the report and controls retain their production tokens.
        document.body.style.background = ${JSON.stringify(backdrop)}
      })()`)
      const expectedColor = foreground
        .slice(1)
        .match(/../g)
        .map((part) => parseInt(part, 16))
        .join(', ')
      await waitUntil(async () => {
        const layout = await readTagReportLayout(listWindow)
        return layout.contentColor === `rgb(${expectedColor})` && !layout.controlsAnimating
          ? layout
          : null
      }, `${name} 主题没有同步到打开的报表`)
      const layout = await readTagReportLayout(listWindow)
      assertTagControlsFit(layout)
      layouts.push({ name, background, foreground, backdrop, layout })
      const file = `tag-report-${name}.png`
      writeFileSync(
        join(testEvidenceRoot, file),
        (await listWindow.webContents.capturePage()).toPNG()
      )
      tagLayoutCaptures.push(file)
    }
    listWindow.setSize(620, 650)
    await listWindow.webContents.executeJavaScript(
      `window.api.setSettingValue('appearance.uiScale', 1.5)`
    )
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(
          `innerWidth === 620 && parseFloat(getComputedStyle(document.documentElement).fontSize) === 1.5`
        ),
      '窄窗 150% 的真实界面缩放尚未应用'
    )
    await listWindow.webContents.executeJavaScript(`(() => {
      const filters = document.querySelector('.daily-report__filters')
      const tags = document.querySelector('.daily-report__tags')
      filters.scrollTop += tags.getBoundingClientRect().top - filters.getBoundingClientRect().top - 8
    })()`)
    const narrow = await readTagReportLayout(listWindow)
    writeFileSync(
      join(testEvidenceRoot, 'tag-report-narrow-layout.json'),
      JSON.stringify(narrow, null, 2)
    )
    writeFileSync(
      join(testEvidenceRoot, 'tag-report-narrow-before-check.png'),
      (await listWindow.webContents.capturePage()).toPNG()
    )
    assertTagControlsFit(narrow)
    assert.ok(
      narrow.list.height > 0 && narrow.list.scrollHeight > narrow.list.height,
      '窄窗必须保留可见且实际需要滚动的便签列表'
    )
    const scrolled = await listWindow.webContents.executeJavaScript(`(() => {
      const list = document.querySelector('.daily-report__list')
      list.scrollTop = list.scrollHeight
      return { top: list.scrollTop, max: list.scrollHeight - list.clientHeight }
    })()`)
    assert.ok(
      scrolled.top > 0 && Math.abs(scrolled.top - scrolled.max) <= 1,
      '150% 窄窗中真实列表必须能滚动到末尾'
    )
    layouts.push({ name: 'narrow-150', layout: narrow, scrolled })
    const narrowFile = 'tag-report-narrow-150.png'
    writeFileSync(
      join(testEvidenceRoot, narrowFile),
      (await listWindow.webContents.capturePage()).toPNG()
    )
    tagLayoutCaptures.push(narrowFile)
    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.daily-report__tag-picker .ts-more').click()`
    )
    const panel = await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(`(() => {
        const panel = document.querySelector('.ts-panel')
        if (!panel || !panel.querySelector('.ts-panel-select')) return null
        const box = panel.getBoundingClientRect()
        if (Number(getComputedStyle(panel).opacity) < 0.99 ||
          panel.getAnimations().some(animation => animation.playState === 'running')) return null
        return box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1
          ? { rect: box.toJSON(), count: panel.querySelectorAll('.ts-panel-select').length,
            overflow: panel.scrollWidth > panel.clientWidth + 1 } : null
      })()`),
      '150% 窄窗的真实更多标签面板没有完整避让到视口内'
    )
    assert.equal(panel.overflow, false)
    assert.ok(panel.count >= 3, '更多面板必须能读取全部真实标签')
    layouts.push({ name: 'narrow-150-more', panel })
    const moreFile = 'tag-report-narrow-150-more.png'
    writeFileSync(
      join(testEvidenceRoot, moreFile),
      (await listWindow.webContents.capturePage()).toPNG()
    )
    tagLayoutCaptures.push(moreFile)
    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.daily-report__tag-picker .ts-more').click()`
    )
    await waitUntil(
      () => listWindow.webContents.executeJavaScript(`!document.querySelector('.ts-panel')`),
      '窄窗标签面板没有关闭'
    )
    const reachable = await listWindow.webContents.executeJavaScript(`(() => {
      const card = document.querySelector('.daily-report').closest('.app-modal-card')
      const button = [...card.querySelectorAll('button')].find(item => item.textContent.trim() === '导出 TXT')
      button.focus()
      return document.activeElement === button && !button.disabled
    })()`)
    assert.equal(reachable, true, '150% 窄窗的导出按钮必须可聚焦且可用')
    await listWindow.webContents.executeJavaScript(
      `document.querySelector('.daily-report').closest('.app-modal-card').querySelector('.app-modal-close').click()`
    )
    await waitUntil(
      () => listWindow.webContents.executeJavaScript(`!document.querySelector('.daily-report')`),
      '150% 窄窗的真实关闭操作不可达'
    )
    tagFilterEvidence.layout = {
      settings: 'real setSettingValue IPC',
      wallpaper: 'test-only document.body.style.background; production report styles unchanged',
      captures: tagLayoutCaptures,
      layouts
    }
  } finally {
    await listWindow.webContents.executeJavaScript(`(async () => {
      await window.api.setSettingValue('appearance.uiScale', ${JSON.stringify(original.settings.appearance.uiScale)})
      await window.api.setSettingValue('css.bgColor', ${JSON.stringify(original.settings.css.bgColor)})
      await window.api.setSettingValue('css.textColor', ${JSON.stringify(original.settings.css.textColor)})
      document.body.style.background = ${JSON.stringify(original.bodyBackground)}
    })()`)
    listWindow.setBounds(originalBounds)
  }
  writeFileSync(
    join(testEvidenceRoot, 'daily-report-tag-filter-readback.json'),
    JSON.stringify(tagFilterEvidence, null, 2),
    { flag: 'wx' }
  )
}

async function runDailyReportTest() {
  let completed = false
  let failure = null
  try {
    const listWindow = await waitUntil(getListWindow, '列表主窗口没有按隔离设置启动', 10000)
    activeWindow = listWindow
    await waitUntil(() => listWindow.isVisible(), '列表主窗口渲染就绪后没有显示')
    await dismissStartupShortcutNotice(listWindow)
    const now = Date.now()
    const previousDay = new Date()
    previousDay.setHours(9, 0, 0, 0)
    previousDay.setDate(previousDay.getDate() - 1)
    const outsideDay = new Date(previousDay)
    outsideDay.setDate(outsideDay.getDate() - 1)
    const db = new Database(join(testUserData, 'app.db'))
    try {
      const insert = db.prepare(`
      INSERT INTO notes (
        content, status, is_deleted, is_pinned, notify_enabled, effective_at,
        duration_days, finished_at, sort_order, created_at, updated_at
      ) VALUES (?, 'in_progress', 0, 0, 0, ?, 1, ?, 0, ?, ?)
    `)
      const today = insert.run('今天的报表便签', now, now, now, now)
      const yesterday = insert.run(
        '昨天的报表便签',
        previousDay.getTime(),
        previousDay.getTime(),
        previousDay.getTime(),
        previousDay.getTime()
      )
      const outside = insert.run(
        '范围外的报表便签',
        outsideDay.getTime(),
        outsideDay.getTime(),
        outsideDay.getTime(),
        outsideDay.getTime()
      )
      seedEvidence = {
        today: { id: Number(today.lastInsertRowid), effectiveAt: now },
        yesterday: { id: Number(yesterday.lastInsertRowid), effectiveAt: previousDay.getTime() },
        outsideRange: { id: Number(outside.lastInsertRowid), effectiveAt: outsideDay.getTime() }
      }
    } finally {
      db.close()
    }
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
        formats: [...document.querySelectorAll('.daily-report__formats .daily-report__format')].map((item) => ({
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
    for (const label of ['选择报表开始日期', '选择报表结束日期']) {
      await verifyDatePickerKeyboard(
        listWindow,
        `.date-picker__trigger[aria-label="${label}"]`,
        '.daily-report'
      )
      keyboardHelperCompleted.push(label)
    }

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
      const excel = [...document.querySelectorAll('.daily-report__formats .daily-report__format')].find(
        (item) => item.textContent.trim() === 'Excel'
      )
      excel.click()
    })()`)
    await waitUntil(
      () =>
        listWindow.webContents.executeJavaScript(`(() => {
          const excel = [...document.querySelectorAll('.daily-report__formats .daily-report__format')].find(
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
    await verifyActualFileExports(listWindow, now, previousDay.getTime())
    process.stderr.write('daily report selected-range TXT and XLSX readback passed\n')
    await verifyTagFilteredExports(listWindow, now)
    await verifyTagReportLayout(listWindow)
    process.stderr.write(
      'daily report real tag filters, current-tag exports and local layout passed\n'
    )
    listWindow.show()
    listWindow.focus()
    listWindow.webContents.invalidate()
    await waitUntil(() => listWindow.isFocused(), '最终导出证据窗口未进入前台')
    await listWindow.webContents.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
    )
    completed = true
  } catch (error) {
    console.error(error)
    failure = error
    if (activeWindow && !activeWindow.isDestroyed()) {
      failureUi = await activeWindow.webContents
        .executeJavaScript(
          `(() => ({
        dateTriggers: [...document.querySelectorAll('.daily-report__date-range .date-picker__trigger')].map(item => ({
          label: item.getAttribute('aria-label'), text: item.textContent.trim()
        })),
        selectedSummary: document.querySelector('.daily-report__selected-summary')?.textContent.trim(),
        notes: [...document.querySelectorAll('.daily-report-note')].map(note => ({
          content: note.querySelector('.daily-report-note__content')?.textContent,
          checked: note.querySelector('input')?.checked
        })),
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map(item => ({
          label: item.getAttribute('aria-label'), text: item.textContent.trim().slice(0, 1800)
        }))
      }))()`
        )
        .catch((collectionError) => ({ collectionError: collectionError.message }))
      failureUi.datePickerGeometry = await readDatePickerGeometry(activeWindow).catch(
        (collectionError) => ({ collectionError: collectionError.message })
      )
    }
  } finally {
    await lifecycle.finish({
      completed,
      error: failure,
      window: activeWindow,
      restore: restoreSaveDialog,
      summary: {
        failureUi,
        seedEvidence,
        saveDialogCalls,
        exportReadback,
        tagFilterEvidence,
        tagLayoutCaptures,
        datePickerPositionEvidence,
        expectedExportArtifacts: [
          'daily-report-exports/daily-report-selected-today.txt',
          'daily-report-exports/daily-report-selected-yesterday.xlsx',
          'daily-report-export-readback.json',
          'daily-report-exports/daily-report-tag-filtered.xlsx',
          'daily-report-exports/daily-report-tag-filtered.txt',
          'daily-report-tag-filter-readback.json',
          'tag-report-white.png',
          'tag-report-black.png',
          'tag-report-complex.png',
          'tag-report-narrow-150.png',
          'tag-report-narrow-150-more.png'
        ],
        presentExportArtifacts: [
          'daily-report-exports/daily-report-selected-today.txt',
          'daily-report-exports/daily-report-selected-yesterday.xlsx',
          'daily-report-export-readback.json',
          'daily-report-exports/daily-report-tag-filtered.xlsx',
          'daily-report-exports/daily-report-tag-filtered.txt',
          'daily-report-tag-filter-readback.json',
          'tag-report-white.png',
          'tag-report-black.png',
          'tag-report-complex.png',
          'tag-report-narrow-150.png',
          'tag-report-narrow-150-more.png'
        ].filter((file) => existsSync(join(testEvidenceRoot, file))),
        datePickerHelper: {
          completedTriggers: keyboardHelperCompleted,
          assertionCounterScope:
            'independent helper strict assertions excluded from recorder totals'
        }
      }
    })
  }
}

try {
  mkdirSync(exportDirectory)
  installControlledSaveDialog()
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
  void lifecycle.finish({ error, restore: restoreSaveDialog })
}
