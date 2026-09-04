import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'

const WAIT_STEP_MS = 25
const require = createRequire(import.meta.url)
const report = (message) => process.stderr.write(`[month-context-menu] ${message}\n`)

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

function seedMonthView(userDataPath) {
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
  insert.run('application', 'application', 'active_view', 'month', now, now)
  insert.run('application', 'remote', 'receive_notices', 'false', now, now)
  insert.run('application', 'remote', 'upload_device_info', 'false', now, now)
  insert.run('application', 'onboarding', 'first_use_notice_version', '1', now, now)
  insert.run('month', 'system', 'blur_enabled', 'false', now, now)
  db.close()
}

function getMonthWindow() {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && /\/month\.html(?:$|[?#])/.test(window.webContents.getURL())
  )
}

const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-month-context-menu-'))

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
  seedMonthView(testUserData)

  require(resolve('out', 'main', 'index.js'))
  const mainChunk = readdirSync(resolve('out', 'main', 'chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk, '未找到构建后的主进程分块')
  require(resolve('out', 'main', 'chunks', mainChunk))
  app.once('ready', () => void runContextMenuTests())
} catch (error) {
  report(`setup failed: ${error?.stack || error}`)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}

async function openDayMenu(monthWindow, selector) {
  await monthWindow.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)})
    if (!target) throw new Error('未找到日期格右键目标')
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + Math.min(10, rect.width / 2),
      clientY: rect.top + Math.min(10, rect.height / 2)
    }))
  })()`)
  await waitUntil(
    () =>
      monthWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.month-cell-context-menu-shell'))`
      ),
    '日期格右键没有打开菜单'
  )
}

async function openNoteMenu(monthWindow, noteId) {
  await monthWindow.webContents.executeJavaScript(`(() => {
    const target = document.querySelector('.month-event-bar[data-note-id="${noteId}"]')
    if (!target) throw new Error('未找到便签横条右键目标')
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    }))
  })()`)
  await waitUntil(
    () =>
      monthWindow.webContents.executeJavaScript(
        `document.querySelector('.month-cell-context-menu-shell')?.getAttribute('aria-label') === '便签操作'`
      ),
    '便签横条右键没有打开便签操作菜单'
  )
}

async function clickMenuItem(monthWindow, label) {
  await monthWindow.webContents.executeJavaScript(`(() => {
    const button = Array.from(document.querySelectorAll('.month-cell-context-menu button')).find(
      (item) => item.textContent.trim() === ${JSON.stringify(label)}
    )
    if (!button) throw new Error('右键菜单缺少操作：${label}')
    button.click()
  })()`)
}

async function runContextMenuTests() {
  try {
    const monthWindow = await waitUntil(() => getMonthWindow(), '月视图未按 active_view 启动')
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelectorAll('.month-day-cell').length === 42`
        ),
      '月视图日期格没有完成渲染'
    )

    const initialBounds = monthWindow.getBounds()
    monthWindow.setBounds({ ...initialBounds, width: 360 })
    await waitUntil(
      () => monthWindow.webContents.executeJavaScript(`window.innerWidth <= 360`),
      '月视图没有进入窄窗口工具栏测试尺寸'
    )
    const narrowToolbar = await monthWindow.webContents.executeJavaScript(`(() => {
      const leading = document.querySelector('.month-toolbar__leading').getBoundingClientRect()
      const navigation = document.querySelector('.month-toolbar__navigation').getBoundingClientRect()
      const trailing = document.querySelector('.month-toolbar__trailing').getBoundingClientRect()
      const toggleLabel = document.querySelector('.month-toolbar__day-panel-toggle span')
      return {
        controlsSeparated: leading.right <= trailing.left,
        navigationOnSecondRow:
          navigation.top >= Math.max(leading.bottom, trailing.bottom) - 1,
        toggleLabelHidden: getComputedStyle(toggleLabel).display === 'none'
      }
    })()`)
    assert.deepEqual(
      narrowToolbar,
      {
        controlsSeparated: true,
        navigationOnSecondRow: true,
        toggleLabelHidden: true
      },
      '窄窗口下工具栏控件发生重叠或没有切换为紧凑双行布局'
    )
    monthWindow.setBounds(initialBounds)
    await waitUntil(
      () => monthWindow.webContents.executeJavaScript(`window.innerWidth > 420`),
      '月视图没有恢复专项测试窗口尺寸'
    )

    const dates = await monthWindow.webContents.executeJavaScript(`(() => {
      const today = new Date()
      const todayKey = [
        today.getFullYear(),
        String(today.getMonth() + 1).padStart(2, '0'),
        String(today.getDate()).padStart(2, '0')
      ].join('-')
      const cells = Array.from(document.querySelectorAll('.month-day-cell'))
      return {
        todayKey,
        firstVisibleKey: cells[0]?.dataset.date || '',
        pastKey: cells.find((cell) => cell.dataset.date < todayKey)?.dataset.date || '',
        futureOutsideKey:
          cells.find((cell) => cell.classList.contains('is-outside') && cell.dataset.date > todayKey)
            ?.dataset.date || ''
      }
    })()`)
    let movedToPreviousMonth = false
    if (!dates.pastKey) {
      movedToPreviousMonth = true
      await monthWindow.webContents.executeJavaScript(
        `document.querySelector('.month-toolbar__navigation [aria-label="上个月"]').click()`
      )
      await waitUntil(
        () =>
          monthWindow.webContents.executeJavaScript(
            `document.querySelector('.month-day-cell')?.dataset.date !== ${JSON.stringify(dates.firstVisibleKey)} && !document.querySelector('.month-toolbar').classList.contains('is-busy')`
          ),
        '专项测试没有切换到包含过去日期的月份'
      )
      dates.pastKey = await monthWindow.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.month-day-cell')).find((cell) => cell.dataset.date < ${JSON.stringify(dates.todayKey)})?.dataset.date || ''`
      )
    }
    assert.ok(dates.pastKey, '测试月份可见范围内缺少过去日期')
    assert.ok(dates.futureOutsideKey, '测试月份可见范围内缺少未来跨月日期')

    await openDayMenu(monthWindow, `.month-day-cell[data-date="${dates.pastKey}"]`)
    assert.deepEqual(
      await monthWindow.webContents.executeJavaScript(`(() => {
        const button = document.querySelector('.month-cell-context-menu button')
        return { label: button?.textContent.trim(), disabled: button?.disabled }
      })()`),
      { label: '新建便签…', disabled: false },
      '过去日期的右键新建入口应允许历史补录'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-cell-context-menu button').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-creator'))`
        ),
      '过去日期的右键新建入口没有打开历史补录表单'
    )
    const [pastYear, pastMonth, pastDay] = dates.pastKey.split('-').map(Number)
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `document.querySelector('.month-creator > header span')?.textContent.trim()`
      ),
      `${pastYear}年${pastMonth}月${pastDay}日`,
      '历史补录表单没有保留右键日期'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-creator > header button').click()`
    )
    await waitUntil(
      () => monthWindow.webContents.executeJavaScript(`!document.querySelector('.month-creator')`),
      '历史补录表单没有关闭'
    )
    if (movedToPreviousMonth) {
      await monthWindow.webContents.executeJavaScript(
        `document.querySelector('.month-toolbar__today').click()`
      )
      await waitUntil(
        () =>
          monthWindow.webContents.executeJavaScript(
            `Boolean(document.querySelector('.month-day-cell[data-date="${dates.todayKey}"]')) && !document.querySelector('.month-toolbar').classList.contains('is-busy')`
          ),
        '专项测试没有回到当前月份'
      )
    }

    await openDayMenu(
      monthWindow,
      `.month-day-cell[data-date="${dates.futureOutsideKey}"] .month-day-cell__quick-activate`
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `document.querySelector('.month-cell-context-menu button')?.disabled`
      ),
      false,
      '未来跨月日期必须允许从底部区域右键新建'
    )
    await clickMenuItem(monthWindow, '新建便签…')
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-creator'))`
        ),
      '未来跨月日期没有打开完整新建面板'
    )
    assert.ok(
      await monthWindow.webContents.executeJavaScript(
        `document.querySelector('.month-creator header')?.textContent.includes('${Number(dates.futureOutsideKey.slice(5, 7))}月${Number(dates.futureOutsideKey.slice(8, 10))}日')`
      ),
      '完整新建面板没有使用右键格子的真实日期'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-creator > header button').click()`
    )
    await waitUntil(
      () => monthWindow.webContents.executeJavaScript(`!document.querySelector('.month-creator')`),
      '完整新建面板没有关闭'
    )

    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-cell[data-date="${dates.todayKey}"] .month-day-cell__quick-activate').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.activeElement?.matches('.month-day-cell__quick-create input')`
        ),
      '快速输入框没有进入编辑状态'
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `!document.querySelector('.month-cell-context-menu-shell')`
        ),
      '上一个日期菜单没有完成离场'
    )
    await monthWindow.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.month-day-cell[data-date="${dates.todayKey}"] .month-day-cell__quick-create input')
      input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })()`)
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.month-cell-context-menu-shell'))`
      ),
      false,
      '正在编辑的快速输入框不应触发日期格右键菜单'
    )
    await openDayMenu(
      monthWindow,
      `.month-day-cell[data-date="${dates.todayKey}"] .month-day-cell__header`
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `document.querySelector('.month-cell-context-menu button')?.textContent.trim()`
      ),
      '新建便签…',
      '快速输入框以外的日期格顶部仍应触发新建菜单'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`
    )

    const noteId = await monthWindow.webContents.executeJavaScript(
      `(async () => (await window.api.createNote({ content: '右键菜单跨日便签', durationDays: 10 })).id)()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelectorAll('.month-event-bar[data-note-id="${noteId}"]').length >= 1`
        ),
      '测试便签没有进入日期格'
    )
    await openNoteMenu(monthWindow, noteId)
    assert.deepEqual(
      await monthWindow.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.month-cell-context-menu button'), (button) => button.textContent.trim())`
      ),
      ['切换为已完成', '修改便签', '删除便签'],
      '进行中便签的右键菜单操作不完整'
    )
    await monthWindow.webContents.executeJavaScript(`window.api.completeNote(${noteId})`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-cell-context-menu button')?.textContent.trim() === '重新进行'`
        ),
      '便签状态被外部刷新后，已打开的右键菜单没有同步最新状态'
    )
    await clickMenuItem(monthWindow, '重新进行')
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-event-bar[data-note-id="${noteId}"]')?.classList.contains('is-in_progress')`
        ),
      '同步最新状态后的右键操作没有重新进行便签'
    )
    await wait(1050)
    await openNoteMenu(monthWindow, noteId)
    await clickMenuItem(monthWindow, '切换为已完成')
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-event-bar[data-note-id="${noteId}"]')?.classList.contains('is-completed')`
        ),
      '右键状态操作没有将便签切换为已完成'
    )

    await openDayMenu(
      monthWindow,
      `.month-day-cell[data-date="${dates.todayKey}"] .month-day-cell__header`
    )
    await clickMenuItem(monthWindow, '预览当日全部便签')
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-day-preview'))`
        ),
      '预览菜单没有打开当日全部便签浮动窗'
    )
    const previewState = await monthWindow.webContents.executeJavaScript(`(() => {
      const preview = document.querySelector('.month-day-preview')
      const cell = document.querySelector('.month-day-cell[data-date="${dates.todayKey}"]')
      const previewRect = preview.getBoundingClientRect()
      const cellRect = cell.getBoundingClientRect()
      return {
        headerActions: Array.from(preview.querySelectorAll('header button'), (button) => button.getAttribute('aria-label')),
        noteTexts: Array.from(preview.querySelectorAll('.month-day-preview__note p'), (node) => node.textContent.trim()),
        fullyVisible:
          previewRect.left >= 0 &&
          previewRect.top >= 0 &&
          previewRect.right <= window.innerWidth &&
          previewRect.bottom <= window.innerHeight,
        besideCell: previewRect.right <= cellRect.left || previewRect.left >= cellRect.right,
        hasModalScrim: Boolean(document.querySelector('.month-modal-overlay, .confirm-overlay.active'))
      }
    })()`)
    assert.deepEqual(
      previewState.headerActions,
      ['展开左侧操作列表', '关闭预览'],
      '预览窗顶部必须只保留展开列表和关闭操作'
    )
    assert.ok(previewState.noteTexts.includes('右键菜单跨日便签'), '预览窗没有显示当天完整便签')
    assert.equal(previewState.fullyVisible, true, '预览窗没有完整限制在窗口可视范围内')
    assert.equal(previewState.besideCell, true, '预览窗没有优先显示在日期格左侧或右侧')
    assert.equal(previewState.hasModalScrim, false, '当日便签预览不得显示蒙层')

    const previewScrollState = await monthWindow.webContents.executeJavaScript(`(async () => {
      const list = document.querySelector('.month-day-preview__list')
      list.style.height = '24px'
      list.style.flex = '0 0 24px'
      list.scrollTop = list.scrollHeight
      await new Promise((resolve) => setTimeout(resolve, 60))
      return {
        visible: Boolean(document.querySelector('.month-day-preview')),
        scrolled: list.scrollTop > 0
      }
    })()`)
    assert.deepEqual(
      previewScrollState,
      { visible: true, scrolled: true },
      '预览列表内部滚动不得关闭预览窗'
    )

    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-preview button[aria-label="关闭预览"]').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(`!document.querySelector('.month-day-preview')`),
      '预览窗右上角关闭按钮没有生效'
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `document.activeElement?.matches('.month-day-cell[data-date="${dates.todayKey}"]')`
      ),
      true,
      '关闭预览后焦点没有回到对应日期格'
    )

    await openDayMenu(
      monthWindow,
      `.month-day-cell[data-date="${dates.todayKey}"] .month-day-cell__header`
    )
    await clickMenuItem(monthWindow, '预览当日全部便签')
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-day-preview'))`
        ),
      '第二次没有打开当日便签预览'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-preview button[aria-label="展开左侧操作列表"]').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-day-panel')) && !document.querySelector('.month-day-preview')`
        ),
      '预览窗左上角按钮没有打开对应日期的左侧操作列表'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-panel__collapse').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(`!document.querySelector('.month-day-panel')`),
      '专项测试没有收起日期侧栏'
    )

    await openNoteMenu(monthWindow, noteId)
    await clickMenuItem(monthWindow, '修改便签')
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('[data-modal-layer="month-note-editor"]'))`
        ),
      '右键修改没有打开现有编辑器'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-editor-dialog > header button').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `!document.querySelector('[data-modal-layer="month-note-editor"]')`
        ),
      '编辑器没有关闭'
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.activeElement?.matches('.month-event-bar[data-note-id="${noteId}"]')`
        ),
      '从右键菜单关闭编辑器后焦点没有回到原便签横条'
    )

    const currentFirstVisibleKey = await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-cell')?.dataset.date || ''`
    )
    await monthWindow.webContents.executeJavaScript(`(() => {
      window.__periodChangePresenceCloneCount = 0
      window.__periodChangeNativeAnimate = Element.prototype.animate
      Element.prototype.animate = function (keyframes, options) {
        if (this.hasAttribute?.('data-calendar-presence-clone')) {
          window.__periodChangePresenceCloneCount += 1
        }
        return window.__periodChangeNativeAnimate.call(this, keyframes, options)
      }
      document.querySelector('.month-toolbar__navigation [aria-label="下个月"]').click()
    })()`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-day-cell')?.dataset.date !== ${JSON.stringify(currentFirstVisibleKey)} && !document.querySelector('.month-toolbar').classList.contains('is-busy')`
        ),
      '专项测试没有切换到下个月'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__today').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-day-cell')?.dataset.date === ${JSON.stringify(currentFirstVisibleKey)} && !document.querySelector('.month-toolbar').classList.contains('is-busy')`
        ),
      '专项测试没有从下个月回到当前月份'
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(`window.__periodChangePresenceCloneCount`),
      0,
      '切换月份时不应生成脱离整月退场动画的便签横条克隆'
    )
    await monthWindow.webContents.executeJavaScript(`(() => {
      Element.prototype.animate = window.__periodChangeNativeAnimate
      delete window.__periodChangeNativeAnimate
    })()`)

    await monthWindow.webContents.executeJavaScript(`(() => {
      window.__removedEventAnimationOutcomes = []
      const nativeAnimate = Element.prototype.animate
      Element.prototype.animate = function (keyframes, options) {
        const animation = nativeAnimate.call(this, keyframes, options)
        if (this.hasAttribute?.('data-calendar-presence-clone')) {
          animation.finished.then(
            () => window.__removedEventAnimationOutcomes.push('finished'),
            () => window.__removedEventAnimationOutcomes.push('cancelled')
          )
        }
        return animation
      }
    })()`)
    await openNoteMenu(monthWindow, noteId)
    await clickMenuItem(monthWindow, '删除便签')
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.confirm-card')?.getAttribute('aria-label') === '删除便签？'`
        ),
      '逻辑删除没有进入确认步骤'
    )
    await monthWindow.webContents.executeJavaScript(`(() => {
      const button = Array.from(document.querySelectorAll('.confirm-actions button')).find(
        (item) => item.textContent.trim() === '删除'
      )
      button.click()
    })()`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelectorAll('.month-event-bar[data-note-id="${noteId}"]').length === 0`
        ),
      '逻辑删除后跨日便签横条仍然存在'
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `window.__removedEventAnimationOutcomes.length > 0`
        ),
      '逻辑删除后的横条退出动画没有结束'
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `window.__removedEventAnimationOutcomes.includes('cancelled')`
      ),
      false,
      '逻辑删除后的广播刷新提前取消了横条退出动画'
    )

    const verificationDb = new Database(join(testUserData, 'app.db'))
    const deletedRecord = verificationDb
      .prepare('SELECT is_deleted FROM notes WHERE id = ?')
      .get(noteId)
    verificationDb.close()
    assert.equal(deletedRecord?.is_deleted, 1, '右键删除没有执行逻辑删除')

    report('focused context-menu interaction passed')
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
