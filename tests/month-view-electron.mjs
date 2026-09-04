import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, powerMonitor, screen } from 'electron'
import koffi from 'koffi'

const WAIT_STEP_MS = 25
const require = createRequire(import.meta.url)
const report = (message) => process.stderr.write(`[month-e2e] ${message}\n`)

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

async function waitUntil(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(WAIT_STEP_MS)
  }
  throw new Error(message)
}

async function openToolbarPicker(monthWindow) {
  await waitUntil(
    () =>
      monthWindow.webContents.executeJavaScript(
        `!document.querySelector('.month-toolbar')?.classList.contains('is-busy')`
      ),
    '月历切换动画结束后年月标题仍不可用'
  )
  await monthWindow.webContents.executeJavaScript(`(() => {
    const title = document.querySelector('.month-toolbar__title')
    if (title.getAttribute('aria-expanded') !== 'true') title.click()
  })()`)
  await waitUntil(
    () =>
      monthWindow.webContents.executeJavaScript(
        `document.querySelector('.month-toolbar__title')?.getAttribute('aria-expanded') === 'true' && Boolean(document.querySelector('.month-toolbar__picker'))`
      ),
    '点击年月标题后没有展开年月选择面板'
  )
}

async function setToolbarYear(monthWindow, value) {
  await openToolbarPicker(monthWindow)
  await monthWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.month-toolbar__picker input')
    input.value = '${value}'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
}

async function chooseToolbarMonth(monthWindow, value) {
  await openToolbarPicker(monthWindow)
  await monthWindow.webContents.executeJavaScript(
    `document.querySelector('.month-toolbar__month-option[data-value="${value}"]').click()`
  )
}

async function setDayPanelOpen(monthWindow, open) {
  await waitUntil(
    () =>
      monthWindow.webContents.executeJavaScript(
        `document.querySelector('.month-toolbar__day-panel-toggle')?.disabled === false`
      ),
    '月视图工具栏日期列表开关长时间不可用'
  )
  await monthWindow.webContents.executeJavaScript(`(() => {
    const toggle = document.querySelector('.month-toolbar__day-panel-toggle')
    if (!toggle) throw new Error('月视图工具栏缺少日期列表开关')
    if (toggle.getAttribute('aria-expanded') !== '${open}') toggle.click()
  })()`)
  await waitUntil(
    () =>
      monthWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.month-day-panel')) === ${open} && document.querySelector('.month-toolbar__day-panel-toggle')?.getAttribute('aria-expanded') === '${open}'`
      ),
    open ? '工具栏按钮没有展开日期侧栏' : '工具栏按钮没有收起日期侧栏'
  )
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
  // 集成测试不访问远程服务，也不创建启用状态的 BlurOverlay。
  insert.run('application', 'remote', 'receive_notices', 'false', now, now)
  insert.run('application', 'remote', 'upload_device_info', 'false', now, now)
  insert.run('application', 'onboarding', 'first_use_notice_version', '1', now, now)
  insert.run('month', 'system', 'blur_enabled', 'false', now, now)
  insert.run('month', 'ui', 'settings_panel_size', '57', now, now)
  db.close()
}

function getMonthWindow() {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && /\/month\.html(?:$|[?#])/.test(window.webContents.getURL())
  )
}

const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-month-e2e-'))
let exitCode = 0
let originalCursor = null

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
  report('seeded isolated database')

  // bootstrap 使用异步 require 加载构建分块。测试需要在同一主进程里立即进入
  // 真实初始化代码，所以先加载 bootstrap，再同步加载其唯一主进程分块；异步任务
  // 随后再次 require 时会命中 CommonJS 缓存，不会重复初始化。
  require(resolve('out', 'main', 'index.js'))
  report('loaded built bootstrap')
  const mainChunk = readdirSync(resolve('out', 'main', 'chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk, '未找到构建后的主进程分块')
  require(resolve('out', 'main', 'chunks', mainChunk))
  report('loaded built main chunk')
  // Electron 会等入口模块求值结束后才发 ready；不能在顶层 await app.whenReady()，
  // 否则 ESM 顶层等待与 ready 事件会互相阻塞。
  app.once('ready', () => void runMonthViewTests())
} catch (error) {
  report(`setup failed: ${error?.stack || error}`)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}

async function runMonthViewTests() {
  try {
    report('electron app ready')

    const monthWindow = await waitUntil(
      () => getMonthWindow(),
      '月视图主窗口未按持久化的 active_view 启动',
      10000
    )
    report('month window created')
    await waitUntil(() => monthWindow.isVisible(), '月视图渲染就绪后没有显示')

    const display = screen.getDisplayMatching(monthWindow.getBounds())
    const workArea = display.workArea
    const expectedBounds = {
      x: workArea.x + Math.round((workArea.width - Math.round(workArea.width * 0.7)) / 2),
      y: workArea.y + Math.round((workArea.height - Math.round(workArea.height * 0.7)) / 2),
      width: Math.round(workArea.width * 0.7),
      height: Math.round(workArea.height * 0.7)
    }
    assert.deepEqual(
      monthWindow.getBounds(),
      expectedBounds,
      '月视图首次窗口必须为工作区 70% 并居中'
    )
    const layoutTestBounds = {
      x: workArea.x + Math.round((workArea.width - Math.min(expectedBounds.width, 720)) / 2),
      y: workArea.y + Math.round((workArea.height - Math.min(expectedBounds.height, 540)) / 2),
      width: Math.min(expectedBounds.width, 720),
      height: Math.min(expectedBounds.height, 540)
    }
    monthWindow.setBounds(layoutTestBounds)
    await waitUntil(
      () =>
        monthWindow.getBounds().width === layoutTestBounds.width &&
        monthWindow.getBounds().height === layoutTestBounds.height,
      '月视图没有进入可重复的小屏布局测试尺寸'
    )

    const initialUi = await monthWindow.webContents.executeJavaScript(`(() => ({
    title: document.querySelector('.app-titlebar-title')?.textContent?.trim() || '',
    calendarCellCount: document.querySelectorAll('.month-day-cell').length,
    calendarRole: document.querySelector('.month-grid')?.getAttribute('role'),
    calendarRowCount: document.querySelector('.month-grid')?.getAttribute('aria-rowcount'),
    calendarColumnCount: document.querySelector('.month-grid')?.getAttribute('aria-colcount'),
    weekdayText: Array.from(document.querySelectorAll('.month-grid__weekdays span'), (node) => node.textContent.trim()),
    dayPanelVisible: Boolean(document.querySelector('.month-day-panel')),
    settingsButton: Boolean(document.querySelector('.month-titlebar-btn[title="设置"]')),
    helpButton: Boolean(document.querySelector('.month-titlebar-btn[aria-controls="help-workspace"]')),
    templateButton: Array.from(document.querySelectorAll('button')).some((button) =>
      /模板|循环/.test(button.title || button.textContent || '')
    ),
    controlCount: document.querySelectorAll('.traffic-lights .light').length,
    dayPanelToggle: document.querySelector('.month-toolbar__day-panel-toggle')?.getAttribute('aria-expanded'),
    dayPanelToggleLayout: (() => {
      const toggle = document.querySelector('.month-toolbar__day-panel-toggle')
      const navigation = document.querySelector('.month-toolbar__navigation')
      const today = document.querySelector('.month-toolbar__today')
      const refresh = document.querySelector('.month-toolbar__refresh')
      const weekdays = document.querySelector('.month-grid__weekdays')
      if (!toggle || !navigation || !today || !refresh || !weekdays) return null
      const toggleRect = toggle.getBoundingClientRect()
      const navigationRect = navigation.getBoundingClientRect()
      const todayRect = today.getBoundingClientRect()
      const refreshRect = refresh.getBoundingClientRect()
      const weekdaysRect = weekdays.getBoundingClientRect()
      return {
        text: toggle.textContent.trim(),
        controls: toggle.getAttribute('aria-controls'),
        actionsLeftOfNavigation:
          todayRect.right <= navigationRect.left && refreshRect.right <= navigationRect.left,
        rightOfNavigation: toggleRect.left >= navigationRect.right,
        aboveGrid: toggleRect.bottom <= weekdaysRect.top
      }
    })(),
    refreshButton: Boolean(document.querySelector('.month-toolbar__refresh')),
    persistentJumpControls: Boolean(document.querySelector('.month-toolbar__jump'))
  }))()`)
    assert.equal(initialUi.title, '', '月视图窗口标题栏不应重复显示“月视图”')
    assert.equal(initialUi.calendarCellCount, 42, '月视图必须固定渲染 7 列 6 行')
    assert.deepEqual(
      [initialUi.calendarRole, initialUi.calendarRowCount, initialUi.calendarColumnCount],
      ['grid', '7', '7'],
      '月历必须提供完整的七行七列网格语义'
    )
    assert.deepEqual(initialUi.weekdayText, [
      '周一',
      '周二',
      '周三',
      '周四',
      '周五',
      '周六',
      '周日'
    ])
    assert.equal(initialUi.dayPanelVisible, false, '日期侧栏首次进入必须默认折叠')
    assert.equal(initialUi.settingsButton, true)
    assert.equal(initialUi.helpButton, true, '月视图必须开放帮助中心入口')
    assert.equal(initialUi.templateButton, true, '月视图必须开放循环模板入口')
    assert.equal(initialUi.controlCount, 3, '月视图应复用关闭、窗口层级、锁定三个窗口控制')
    assert.equal(
      initialUi.dayPanelToggle,
      'false',
      '月视图工具栏左侧必须提供收起状态的日期列表开关'
    )
    assert.deepEqual(
      initialUi.dayPanelToggleLayout,
      {
        text: '日期列表',
        controls: 'month-day-panel',
        actionsLeftOfNavigation: true,
        rightOfNavigation: true,
        aboveGrid: true
      },
      '今天和刷新必须位于月份导航左侧，日期列表开关必须位于右侧、日期格上方'
    )
    assert.equal(initialUi.refreshButton, true, '今天按钮旁必须提供刷新按钮')
    assert.equal(initialUi.persistentJumpControls, false, '工具栏右侧不得常驻年月选择控件')

    await setDayPanelOpen(monthWindow, true)
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `document.querySelector('.month-day-cell.is-selected')?.classList.contains('is-today')`
      ),
      true,
      '当前月未选择日期时从工具栏打开列表必须默认选中今天'
    )
    await setDayPanelOpen(monthWindow, false)

    const adjacentMonthState = await monthWindow.webContents.executeJavaScript(`(() => {
      const pad = (value) => String(value).padStart(2, '0')
      const now = new Date()
      const today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
      const cells = Array.from(document.querySelectorAll('.month-day-cell.is-outside'))
      const target = cells.find((cell) => cell.dataset.date > today) || cells.at(-1)
      return {
        count: cells.length,
        key: target?.dataset.date || '',
        ariaDisabled: target?.getAttribute('aria-disabled'),
        title: document.querySelector('.month-toolbar__title').textContent
      }
    })()`)
    assert.ok(adjacentMonthState.count > 0, '月视图必须保留前后月份补位日期')
    assert.ok(adjacentMonthState.key, '月视图没有找到可交互的相邻月份日期')
    assert.equal(adjacentMonthState.ariaDisabled, 'false', '相邻月份日期不得继续使用禁用语义')

    await monthWindow.webContents.executeJavaScript(`window.api.createNoteWithAssets({
      options: {
        content: '相邻月份数据测试',
        effectiveAt: new Date('${adjacentMonthState.key}T09:00:00').getTime(),
        durationDays: 1
      },
      images: [],
      tagIds: []
    })`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-event-bar[data-preview="相邻月份数据测试"]'))`
        ),
      '相邻月份日期没有加载并渲染真实便签数据'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-cell[data-date="${adjacentMonthState.key}"]').click()`
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.month-day-panel'))`
      ),
      false,
      '点击相邻月份日期不得隐式打开日期侧栏'
    )
    await setDayPanelOpen(monthWindow, true)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('.month-day-panel .nl-card-text')).some((node) => node.textContent === '相邻月份数据测试')`
        ),
      '工具栏展开日期侧栏后没有显示已选相邻月份日期的数据'
    )
    const adjacentMonthSelected = await monthWindow.webContents.executeJavaScript(`(() => ({
      title: document.querySelector('.month-toolbar__title').textContent,
      selected: document.querySelector('.month-day-cell[data-date="${adjacentMonthState.key}"]')?.classList.contains('is-selected')
    }))()`)
    assert.equal(
      adjacentMonthSelected.title,
      adjacentMonthState.title,
      '点击补位日期不得自动切换月份'
    )
    assert.equal(adjacentMonthSelected.selected, true, '相邻月份日期必须支持正常选中状态')
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-cell[data-date="${adjacentMonthState.key}"]').click()`
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.month-day-panel'))`
      ),
      true,
      '重复点击相邻月份日期不得收起日期侧栏'
    )
    await setDayPanelOpen(monthWindow, false)

    const zOrderMenuState = await monthWindow.webContents.executeJavaScript(`(async () => {
      const trigger = document.querySelector('.traffic-lights .light-pin')
      trigger.click()
      await new Promise((resolve) => setTimeout(resolve, 40))
      return {
        popup: trigger.getAttribute('aria-haspopup'),
        expanded: trigger.getAttribute('aria-expanded'),
        menuRect: (() => {
          const rect = document.querySelector('.z-order-menu').getBoundingClientRect()
          return { width: rect.width, height: rect.height }
        })(),
        animationFrames: (() => {
          const animation = document.querySelector('.z-order-menu').getAnimations()[0]
          return animation?.effect?.getKeyframes().map((frame) => ({
            clipPath: frame.clipPath || '',
            transform: frame.transform || '',
            opacity: frame.opacity ?? ''
          })) || []
        })(),
        descriptions: document.querySelectorAll('.z-order-option-description').length,
        options: Array.from(document.querySelectorAll('.z-order-option'), (option) => ({
          text: option.querySelector('.z-order-option-label')?.textContent.trim(),
          role: option.getAttribute('role'),
          checked: option.getAttribute('aria-checked'),
          height: option.getBoundingClientRect().height,
          checkLeft: option.querySelector('.z-order-option-check')?.getBoundingClientRect().left,
          labelLeft: option.querySelector('.z-order-option-label')?.getBoundingClientRect().left
        }))
      }
    })()`)
    assert.equal(zOrderMenuState.popup, 'menu')
    assert.equal(zOrderMenuState.expanded, 'true')
    assert.deepEqual(
      zOrderMenuState.options.map((option) => option.text),
      ['始终置顶', '正常层级', '始终置底']
    )
    assert.equal(
      zOrderMenuState.options.every((option) => option.role === 'menuitemradio'),
      true,
      '窗口层级菜单必须暴露互斥单选语义'
    )
    assert.equal(zOrderMenuState.options[0].checked, 'true')
    assert.equal(zOrderMenuState.descriptions, 0, 'macOS 风格层级菜单不应保留双行说明文字')
    assert.equal(zOrderMenuState.animationFrames.length, 2, '窗口层级菜单必须启动统一下拉动效')
    assert.equal(
      zOrderMenuState.animationFrames[0].clipPath.includes('100%'),
      true,
      '窗口层级菜单应从顶部向下裁剪展开'
    )
    assert.equal(
      zOrderMenuState.animationFrames.some(
        (frame) => Boolean(frame.transform) || frame.opacity !== ''
      ),
      false,
      '窗口层级菜单不应继续使用位移、缩放或淡入动画'
    )
    assert.ok(zOrderMenuState.menuRect.width <= 200, '窗口层级菜单应保持 macOS 式紧凑宽度')
    assert.ok(zOrderMenuState.menuRect.height <= 130, '窗口层级菜单不应继续使用三行大卡片布局')
    assert.equal(
      zOrderMenuState.options.every(
        (option) => option.height <= 38 && option.checkLeft < option.labelLeft
      ),
      true,
      '菜单项应使用左侧勾选槽和紧凑单行布局'
    )

    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.z-order-option[data-mode="normal"]').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.light-pin')?.title === '窗口层级：正常层级' && Array.from(document.querySelectorAll('.msg-text')).some((node) => node.textContent.includes('正常层级'))`
        ),
      '切换正常层级后没有同步按钮状态和成功消息'
    )

    await wait(550)
    const rapidZOrderResults = await monthWindow.webContents.executeJavaScript(
      `Promise.all([window.api.setWindowZOrderMode('bottom'), window.api.setWindowZOrderMode('top')])`
    )
    assert.equal(rapidZOrderResults[0].mode, 'bottom')
    assert.equal(rapidZOrderResults[0].changed, true)
    assert.equal(rapidZOrderResults[1].throttled, true, '主进程必须拦截快速重复层级切换')
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.light-pin')?.title === '窗口层级：始终置底' && Array.from(document.querySelectorAll('.msg-text')).some((node) => node.textContent.includes('始终置底'))`
        ),
      '始终置底没有广播到月视图导航栏或显示消息'
    )
    await wait(550)
    await monthWindow.webContents.executeJavaScript(`window.api.setWindowZOrderMode('top')`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.light-pin')?.title === '窗口层级：始终置顶'`
        ),
      '测试结束前没有恢复始终置顶'
    )

    const rapidLockResults = await monthWindow.webContents.executeJavaScript(`(async () => {
      const button = document.querySelector('.traffic-lights .light-lock')
      button.click()
      button.click()
      await new Promise((resolve) => setTimeout(resolve, 80))
      return {
        title: button.title,
        messages: Array.from(document.querySelectorAll('.msg-text'), (node) => node.textContent)
      }
    })()`)
    assert.equal(rapidLockResults.title, '正在切换锁定状态')
    assert.equal(
      rapidLockResults.messages.some((message) => message.includes('主窗口已锁定')),
      true,
      '锁定成功后必须显示消息'
    )
    assert.equal(monthWindow.isMovable(), false, '快速双击锁定不能立即反向解锁')
    await wait(550)
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.traffic-lights .light-lock').click()`
    )
    await waitUntil(() => monthWindow.isMovable(), '测试结束前没有解除全局窗口锁定')

    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-titlebar-btn[aria-controls="template-workspace"]').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-template-panel')?.classList.contains('active') && document.querySelector('.month-template-panel')?.textContent.includes('循环模板')`
        ),
      '月视图循环模板工作区没有完成打开'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-template-panel .tcp-button').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-template-panel .tcp-content')?.classList.contains('visible')`
        ),
      '月视图循环模板新建表单没有完成展开'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-titlebar-btn[aria-controls="template-workspace"]').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `!document.querySelector('.month-template-wrapper')`
        ),
      '月视图循环模板工作区没有完成关闭'
    )

    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-titlebar-btn[aria-controls="help-workspace"]').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-help-panel')?.classList.contains('active') && document.querySelector('.month-help-panel')?.textContent.includes('月视图')`
        ),
      '月视图帮助中心没有完成打开'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-titlebar-btn[aria-controls="help-workspace"]').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(`!document.querySelector('.month-help-wrapper')`),
      '月视图帮助中心没有完成关闭'
    )

    const postHelpUi = await monthWindow.webContents.executeJavaScript(`(() => ({
      url: location.href,
      monthRoot: Boolean(document.querySelector('.month-root')),
      monthContent: Boolean(document.querySelector('.month-content')),
      toolbar: Boolean(document.querySelector('.month-toolbar')),
      bodyText: document.body.textContent.slice(0, 160)
    }))()`)
    assert.equal(
      postHelpUi.toolbar,
      true,
      `关闭帮助后月历工具栏必须仍然存在：${JSON.stringify(postHelpUi)}`
    )

    const initialToolbarLayout = await monthWindow.webContents.executeJavaScript(`(() => {
      const elements = {
        toolbar: document.querySelector('.month-toolbar'),
        previous: document.querySelector('[aria-label="上个月"]'),
        title: document.querySelector('.month-toolbar__title'),
        next: document.querySelector('[aria-label="下个月"]'),
        arrowIcon: document.querySelector('[aria-label="上个月"] .month-toolbar__arrow-icon')
      }
      const missing = Object.entries(elements).filter(([, element]) => !element).map(([name]) => name)
      if (missing.length) return { missing }
      const toolbar = elements.toolbar.getBoundingClientRect()
      const previous = elements.previous.getBoundingClientRect()
      const title = elements.title.getBoundingClientRect()
      const next = elements.next.getBoundingClientRect()
      return {
        missing,
        toolbarCenter: toolbar.left + toolbar.width / 2,
        titleCenter: title.left + title.width / 2,
        previousRight: previous.right,
        titleLeft: title.left,
        titleRight: title.right,
        nextLeft: next.left,
        previousCenterY: previous.top + previous.height / 2,
        titleCenterY: title.top + title.height / 2,
        nextCenterY: next.top + next.height / 2,
        arrowIconHeight: elements.arrowIcon.getBoundingClientRect().height
      }
    })()`)
    assert.deepEqual(initialToolbarLayout.missing, [], '月历工具栏布局元素必须完整')
    assert.ok(
      Math.abs(initialToolbarLayout.titleCenter - initialToolbarLayout.toolbarCenter) < 1,
      '年月标题必须以当前日历工具栏为中轴居中'
    )
    assert.ok(
      initialToolbarLayout.previousRight <= initialToolbarLayout.titleLeft &&
        initialToolbarLayout.titleRight <= initialToolbarLayout.nextLeft,
      '上个月和下个月按钮必须分别位于年月标题两侧'
    )
    assert.ok(
      Math.abs(initialToolbarLayout.previousCenterY - initialToolbarLayout.titleCenterY) < 1 &&
        Math.abs(initialToolbarLayout.nextCenterY - initialToolbarLayout.titleCenterY) < 1,
      '年月标题和左右月份箭头必须沿同一水平中轴垂直居中'
    )
    assert.ok(initialToolbarLayout.arrowIconHeight >= 16, '月份导航箭头必须保持清晰尺寸')

    const motionTarget = await monthWindow.webContents.executeJavaScript(`(() => {
      const title = document.querySelector('.month-toolbar__title').textContent
      const [, yearText, monthText] = title.match(/(\\d+)\\s*年\\s*(\\d+)\\s*月/)
      const year = Number(yearText)
      const month = Number(monthText)
      const body = document.querySelector('.month-workspace__calendar-body')
      const nativeAnimate = body.animate.bind(body)
      window.__monthMotionFrames = []
      body.animate = (keyframes, options) => {
        window.__monthMotionFrames.push(keyframes.map((frame) => ({ ...frame })))
        return nativeAnimate(keyframes, options)
      }
      document.querySelector('[aria-label="下个月"]').click()
      return {
        originalYear: year,
        originalMonth: month,
        originalTitle: year + '年' + month + '月',
        nextTitle: month === 12 ? year + 1 + '年1月' : year + '年' + (month + 1) + '月'
      }
    })()`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `window.__monthMotionFrames.length >= 2 && !document.querySelector('.month-toolbar').classList.contains('is-busy')`
        ),
      '切换到下个月时没有完成退出和进入动画'
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `document.querySelector('.month-toolbar__title').textContent.trim()`
      ),
      motionTarget.nextTitle
    )
    const forwardMotion = await monthWindow.webContents.executeJavaScript(
      `window.__monthMotionFrames.slice(0, 2)`
    )
    assert.match(forwardMotion[0].at(-1).transform, /translateX\(-7%\)/)
    assert.match(forwardMotion[1][0].transform, /translateX\(7%\)/)

    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('[aria-label="上个月"]').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `window.__monthMotionFrames.length >= 4 && !document.querySelector('.month-toolbar').classList.contains('is-busy')`
        ),
      '切换到上个月时没有完成退出和进入动画'
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `document.querySelector('.month-toolbar__title').textContent.trim()`
      ),
      motionTarget.originalTitle
    )
    const backwardMotion = await monthWindow.webContents.executeJavaScript(
      `window.__monthMotionFrames.slice(2, 4)`
    )
    assert.match(backwardMotion[0].at(-1).transform, /translateX\(7%\)/)
    assert.match(backwardMotion[1][0].transform, /translateX\(-7%\)/)

    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__title').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-toolbar__month-option[data-value="9"]'))`
        ),
      '年月选择面板没有展开以验证月份位数切换'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__month-option[data-value="9"]').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-toolbar__title').textContent.trim() === '${motionTarget.originalYear}年9月' && !document.querySelector('.month-toolbar').classList.contains('is-busy')`
        ),
      '没有切换到 9 月以验证标题宽度'
    )
    const septemberTitleWidth = await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__title').getBoundingClientRect().width`
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__month-option[data-value="10"]').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-toolbar__title').textContent.trim() === '${motionTarget.originalYear}年10月' && !document.querySelector('.month-toolbar').classList.contains('is-busy')`
        ),
      '没有从 9 月切换到 10 月以验证标题宽度'
    )
    const octoberTitleWidth = await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__title').getBoundingClientRect().width`
    )
    assert.ok(
      Math.abs(septemberTitleWidth - octoberTitleWidth) < 0.5,
      '9 月与 10 月必须共享固定标题宽度，避免数字过渡期间裁切和挤压'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__month-option[data-value="${motionTarget.originalMonth}"]').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-toolbar__title').textContent.trim() === '${motionTarget.originalTitle}' && !document.querySelector('.month-toolbar').classList.contains('is-busy')`
        ),
      '标题宽度验证后没有恢复原月份'
    )

    const sameMonthMotionStart = await monthWindow.webContents.executeJavaScript(`(() => {
      const start = window.__monthMotionFrames.length
      document.querySelector('.month-toolbar__month-option.is-active').click()
      return start
    })()`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-toolbar__title').getAttribute('aria-expanded') === 'true'`
        ),
      '重复选择当前月份后年月面板被错误关闭'
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(`window.__monthMotionFrames.length`),
      sameMonthMotionStart,
      '重复选择当前月份不得播放整月换页动画'
    )

    const backdropResult = await monthWindow.webContents.executeJavaScript(`(async () => {
      const cell = Array.from(document.querySelectorAll('.month-day-cell:not(.is-outside)')).at(-1)
      const rect = cell.getBoundingClientRect()
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      const targetClass = target?.className || ''
      target?.click()
      await Promise.resolve()
      const targetDuringLeave = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2
      )
      return {
        targetClass,
        targetDuringLeaveClass: targetDuringLeave?.className || '',
        pickerLeaving: Boolean(document.querySelector('.month-toolbar__picker')),
        panelVisible: Boolean(document.querySelector('.month-day-panel'))
      }
    })()`)
    assert.match(backdropResult.targetClass, /month-toolbar__picker-backdrop/)
    assert.match(backdropResult.targetDuringLeaveClass, /month-toolbar__picker-backdrop/)
    assert.equal(backdropResult.pickerLeaving, true, '年月面板离场期间应继续保留防穿透遮罩')
    assert.equal(backdropResult.panelVisible, false, '点击年月面板外部不得穿透并打开日期侧栏')
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-toolbar__title').getAttribute('aria-expanded') === 'false'`
        ),
      '点击年月面板外部后面板没有关闭'
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `!document.querySelector('.month-toolbar__picker') && !document.querySelector('.month-toolbar__picker-backdrop')`
        ),
      '年月面板离场结束后没有移除面板和防穿透遮罩'
    )

    const todayMotionState = await monthWindow.webContents.executeJavaScript(`(() => {
      const bodyStart = window.__monthMotionFrames.length
      const cell = document.querySelector('.month-day-cell.is-today')
      const nativeAnimate = cell.animate.bind(cell)
      window.__todayCellMotionFrames = []
      cell.animate = (keyframes, options) => {
        window.__todayCellMotionFrames.push(keyframes.map((frame) => ({ ...frame })))
        return nativeAnimate(keyframes, options)
      }
      document.querySelector('.month-toolbar__today').click()
      return { bodyStart }
    })()`)
    await waitUntil(
      () => monthWindow.webContents.executeJavaScript(`window.__todayCellMotionFrames.length > 0`),
      '点击当前月份的今天按钮没有播放日期格聚焦动画'
    )
    const todayMotion = await monthWindow.webContents.executeJavaScript(
      `window.__todayCellMotionFrames[0]`
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(`window.__monthMotionFrames.length`),
      todayMotionState.bodyStart,
      '当前月点击今天不得移动或缩放整块月历'
    )
    assert.match(todayMotion[1].transform, /scale\(0\.975\)/)

    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `!document.querySelector('.month-toolbar__refresh').disabled`
        ),
      '今天聚焦动画结束后刷新按钮仍不可用'
    )
    const refreshMotionState = await monthWindow.webContents.executeJavaScript(`(() => {
      const bodyStart = window.__monthMotionFrames.length
      window.__refreshContentMotionFrames = []
      document.querySelectorAll('.month-week__events').forEach((element) => {
        const nativeAnimate = element.animate.bind(element)
        element.animate = (keyframes, options) => {
          window.__refreshContentMotionFrames.push({
            keyframes: keyframes.map((frame) => ({ ...frame })),
            options: { ...options }
          })
          return nativeAnimate(keyframes, options)
        }
      })
      document.querySelector('.month-toolbar__refresh').click()
      return { bodyStart }
    })()`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `window.__refreshContentMotionFrames.length >= 12 && !document.querySelector('.month-toolbar__refresh').disabled`
        ),
      '刷新按钮没有完成旧数据淡出和新数据淡入动画'
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(`window.__monthMotionFrames.length`),
      refreshMotionState.bodyStart,
      '刷新当前月不得移动或缩放整块月历'
    )
    const refreshMotion = await monthWindow.webContents.executeJavaScript(
      `({ outgoing: window.__refreshContentMotionFrames[0], incoming: window.__refreshContentMotionFrames[6] })`
    )
    assert.equal(refreshMotion.outgoing.keyframes[0].opacity, 1)
    assert.ok(
      refreshMotion.outgoing.keyframes.at(-1).opacity > 0.45,
      '刷新旧内容不得完全消失或形成空白闪烁'
    )
    assert.match(refreshMotion.outgoing.keyframes.at(-1).filter, /blur/)
    assert.equal(refreshMotion.outgoing.options.duration, 220)
    assert.ok(refreshMotion.incoming.keyframes[0].opacity > 0.45)
    assert.equal(refreshMotion.incoming.keyframes.at(-1).opacity, 1)
    assert.equal(refreshMotion.incoming.keyframes.at(-1).filter, 'blur(0)')
    assert.equal(refreshMotion.incoming.options.duration, 380)

    const outsideCell = await monthWindow.webContents.executeJavaScript(`(() => {
      const cell = document.querySelector('.month-day-cell.is-outside')
      return {
        tabIndex: cell.tabIndex,
        ariaDisabled: cell.getAttribute('aria-disabled'),
        hasCreate: Boolean(cell.querySelector('.month-day-cell__quick-activate'))
      }
    })()`)
    assert.deepEqual(
      outsideCell,
      { tabIndex: -1, ariaDisabled: 'false', hasCreate: true },
      '非当前月份日期格必须保留完整的点击和新建交互'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-cell.is-outside').click()`
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.month-day-panel'))`
      ),
      false,
      '点击非当前月份日期格不得打开日期侧栏'
    )
    await setDayPanelOpen(monthWindow, true)
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-cell.is-outside').click()`
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.month-day-panel'))`
      ),
      true,
      '日期侧栏展开后点击非当前月份日期不得将其收起'
    )
    await setDayPanelOpen(monthWindow, false)

    // 日期侧栏由工具栏展开，拖动调宽、持久化后重载仍恢复宽度；展开状态不持久化。
    const resizeDateKey = await monthWindow.webContents.executeJavaScript(`(() => {
      const cell = document.querySelectorAll('.month-day-cell')[8]
      cell.click()
      return cell.dataset.date
    })()`)
    await setDayPanelOpen(monthWindow, true)
    const initialPanelRatio = await waitUntil(async () => {
      const ratio = await monthWindow.webContents.executeJavaScript(`(() => {
          const panel = document.querySelector('.month-day-panel').getBoundingClientRect()
          const body = document.querySelector('.month-workspace__body').getBoundingClientRect()
          return panel.width / body.width
        })()`)
      return Math.abs(ratio - 0.25) < 0.015 ? ratio : false
    }, '日期侧栏没有稳定到默认宽度')
    assert.ok(Math.abs(initialPanelRatio - 0.25) < 0.015, '日期侧栏默认宽度必须为 25%')
    const openedToolbarLayout = await monthWindow.webContents.executeJavaScript(`(() => {
      const calendar = document.querySelector('.month-workspace__calendar').getBoundingClientRect()
      const title = document.querySelector('.month-toolbar__title').getBoundingClientRect()
      return {
        calendarCenter: calendar.left + calendar.width / 2,
        titleCenter: title.left + title.width / 2
      }
    })()`)
    assert.ok(
      Math.abs(openedToolbarLayout.titleCenter - openedToolbarLayout.calendarCenter) < 1,
      '日期侧栏展开后年月标题必须在剩余日历区域内自然居中'
    )
    assert.ok(
      openedToolbarLayout.titleCenter > initialToolbarLayout.titleCenter,
      '日期侧栏展开后年月标题必须自然向右移动'
    )

    const resizeGeometry = await monthWindow.webContents.executeJavaScript(`(() => {
      const handle = document.querySelector('.month-day-panel__resize').getBoundingClientRect()
      const body = document.querySelector('.month-workspace__body').getBoundingClientRect()
      return {
        startX: Math.round(handle.left + handle.width / 2),
        y: Math.round(handle.top + handle.height / 2),
        targetX: Math.round(body.left + body.width * 0.42)
      }
    })()`)
    await monthWindow.webContents.executeJavaScript(`(() => {
      const handle = document.querySelector('.month-day-panel__resize')
      const options = {
        bubbles: true,
        cancelable: true,
        pointerId: 41,
        pointerType: 'mouse',
        button: 0,
        buttons: 1,
        clientY: ${resizeGeometry.y}
      }
      handle.dispatchEvent(new PointerEvent('pointerdown', {
        ...options,
        clientX: ${resizeGeometry.startX}
      }))
      window.dispatchEvent(new PointerEvent('pointermove', {
        ...options,
        clientX: ${resizeGeometry.targetX}
      }))
      window.dispatchEvent(new PointerEvent('pointerup', {
        ...options,
        button: 0,
        buttons: 0,
        clientX: ${resizeGeometry.targetX}
      }))
    })()`)
    await waitUntil(async () => {
      const result = await monthWindow.webContents.executeJavaScript(
        `window.api.getSettingsSnapshot()
          .then((snapshot) => ({ size: snapshot.values.ui.dayPanelSize, error: '' }))
          .catch((error) => ({ size: null, error: error?.message || String(error) }))`
      )
      if (result.error) throw new Error(`读取日期侧栏设置失败：${result.error}`)
      const size = result.size
      return Math.abs(size - 42) < 1.5
    }, '拖动日期侧栏后没有保存百分比宽度')

    const reloadFinished = new Promise((resolveReload) => {
      monthWindow.webContents.once('did-finish-load', resolveReload)
    })
    monthWindow.webContents.reload()
    await reloadFinished
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelectorAll('.month-day-cell').length === 42`
        ),
      '月视图重载后日历没有恢复'
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.month-day-panel'))`
      ),
      false,
      '日期侧栏展开状态不得跨重载记忆'
    )
    await setDayPanelOpen(monthWindow, true)
    await wait(320)
    const restoredPanelRatio = await monthWindow.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('.month-day-panel').getBoundingClientRect()
      const body = document.querySelector('.month-workspace__body').getBoundingClientRect()
      return panel.width / body.width
    })()`)
    assert.ok(Math.abs(restoredPanelRatio - 0.42) < 0.02, '日期侧栏没有恢复持久化宽度')

    const narrowHeaderLayout = await monthWindow.webContents.executeJavaScript(`(async () => {
      const panel = document.querySelector('.month-day-panel')
      const originalWidth = panel.style.width
      panel.style.width = '50%'
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)

      const cell = document.querySelector('.month-day-cell:not(.is-outside) .month-day-cell__lunar')?.closest('.month-day-cell')
      const header = cell.querySelector('.month-day-cell__header')
      const label = cell.querySelector('.month-day-cell__lunar')
      const badges = cell.querySelector('.month-day-cell__badges')
      label.textContent = '中国人民抗日战争胜利纪念日/国家公祭日'
      badges.innerHTML = '<span class="month-day-cell__holiday is-off">休</span><span class="month-day-cell__today">今</span>'
      await new Promise(requestAnimationFrame)

      const headerRect = header.getBoundingClientRect()
      const numberRect = cell.querySelector('.month-day-cell__number').getBoundingClientRect()
      const badgesRect = badges.getBoundingClientRect()
      const children = Array.from(badges.children, (node) => node.getBoundingClientRect())
      const columnGap = Number.parseFloat(getComputedStyle(header).columnGap) || 0
      const rootRem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 1
      const minimumBadgeSize = Math.min(15, rootRem * 16)
      const labelWidth = label.getBoundingClientRect().width
      const fixedHeaderWidth = numberRect.width + badgesRect.width + columnGap * 2
      const result = {
        headerFits: header.scrollWidth <= header.clientWidth + 0.5,
        labelEllipsized: label.scrollWidth > label.clientWidth,
        labelSlotValid: labelWidth > 0 || headerRect.width <= fixedHeaderWidth + 0.5,
        badgesInside: badgesRect.left >= headerRect.left - 0.5 && badgesRect.right <= headerRect.right + 0.5,
        badgesVisible: children.every(
          (rect) => rect.width >= minimumBadgeSize - 0.5 && rect.height >= minimumBadgeSize - 0.5
        )
      }
      panel.style.width = originalWidth
      return result
    })()`)
    assert.equal(narrowHeaderLayout.headerFits, true, '侧栏最大宽度下日期格顶部不得横向溢出')
    assert.equal(narrowHeaderLayout.labelEllipsized, true, '长节日名称必须在窄日期格中省略')
    assert.equal(
      narrowHeaderLayout.labelSlotValid,
      true,
      '窄日期格有剩余空间时仍应为节日文字保留弹性槽'
    )
    assert.equal(narrowHeaderLayout.badgesInside, true, '“休 / 今”徽标不得被长节日名称挤出日期格')
    assert.equal(narrowHeaderLayout.badgesVisible, true, '窄日期格中的状态徽标必须保持可见尺寸')

    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-cell[data-date="${resizeDateKey}"]').click()`
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.month-day-panel'))`
      ),
      true,
      '重复点击同一日期不得收起日期侧栏'
    )
    await setDayPanelOpen(monthWindow, false)
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-cell[data-date="${resizeDateKey}"]').click()`
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.month-day-panel'))`
      ),
      false,
      '日期侧栏收起后点击日期不得重新展开'
    )
    await setDayPanelOpen(monthWindow, true)

    await openToolbarPicker(monthWindow)
    const jumpYear = await monthWindow.webContents.executeJavaScript(`(() => {
      const body = document.querySelector('.month-workspace__calendar-body')
      const nativeAnimate = body.animate.bind(body)
      window.__pickerMonthMotionFrames = []
      body.animate = (keyframes, options) => {
        window.__pickerMonthMotionFrames.push(keyframes.map((frame) => ({ ...frame })))
        return nativeAnimate(keyframes, options)
      }
      const input = document.querySelector('.month-toolbar__picker input')
      const target = Number(input.value) < 2100 ? Number(input.value) + 1 : Number(input.value) - 1
      input.value = String(target)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return target
    })()`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(`(() => {
          const picker = document.querySelector('.month-toolbar__picker')
          const input = picker?.querySelector('input')
          return Boolean(picker?.inert && input?.disabled)
        })()`),
      '年月切换期间没有同时禁止鼠标和键盘继续修改选择器'
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-toolbar__title')?.textContent?.includes('${jumpYear}年') && window.__pickerMonthMotionFrames.length >= 2 && !document.querySelector('.month-toolbar').classList.contains('is-busy')`
        ),
      '直接输入年份没有完成年月跳转'
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `document.querySelector('.month-toolbar__title').getAttribute('aria-expanded')`
      ),
      'true',
      '修改年份并播放月历切换动画后选择面板必须保持展开'
    )

    await setToolbarYear(monthWindow, 1900)
    await chooseToolbarMonth(monthWindow, 1)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-toolbar__title')?.textContent?.includes('1900年1月')`
        ),
      '无法跳转到最小月份边界'
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `document.querySelector('.month-toolbar__navigation button[aria-label="上个月"]').disabled`
      ),
      true,
      '1900 年 1 月必须禁用上个月'
    )

    await setToolbarYear(monthWindow, 2100)
    await chooseToolbarMonth(monthWindow, 12)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-toolbar__title')?.textContent?.includes('2100年12月')`
        ),
      '无法跳转到最大月份边界'
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `document.querySelector('.month-toolbar__navigation button[aria-label="下个月"]').disabled`
      ),
      true,
      '2100 年 12 月必须禁用下个月'
    )

    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__title').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-toolbar__title').getAttribute('aria-expanded') === 'false'`
        ),
      '再次点击年月标题没有关闭选择面板'
    )

    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `!document.querySelector('.month-toolbar__today')?.disabled && !document.querySelector('.month-toolbar').classList.contains('is-busy')`
        ),
      '月份切换动画结束后今天按钮仍不可用'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__today').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-day-cell.is-today.is-selected'))`
        ),
      '今天按钮没有回到并选中今天'
    )
    const todayPresentation = await monthWindow.webContents.executeJavaScript(`(() => {
      const cell = document.querySelector('.month-day-cell.is-today')
      const number = cell?.querySelector('.month-day-cell__number')
      const marker = cell?.querySelector('.month-day-cell__today')
      return {
        markerText: marker?.textContent?.trim() || '',
        markerBackground: marker ? getComputedStyle(marker).backgroundColor : '',
        numberBackground: number ? getComputedStyle(number).backgroundColor : ''
      }
    })()`)
    assert.equal(todayPresentation.markerText, '今', '今天必须在日期格顶部右侧显示“今”徽标')
    assert.equal(
      todayPresentation.markerBackground,
      'rgb(10, 132, 255)',
      '今天徽标必须使用蓝色背景'
    )
    assert.equal(
      todayPresentation.numberBackground,
      'rgba(0, 0, 0, 0)',
      '今天的日期数字不应继续使用蓝色圆形背景'
    )

    // 同周连续、跨周拆段与每日便签总数。切到下个月后再造测试数据，
    // 避免当前日期越过固定网格下标时把 09:00 误变成过去时间。
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `(() => { const now = new Date(); const title = document.querySelector('.month-toolbar__title').textContent; return title.includes(now.getFullYear() + '年' + (now.getMonth() + 1) + '月') && !document.querySelector('.month-toolbar').classList.contains('is-busy') })()`
        ),
      '今天按钮没有完成当前月份切换'
    )
    const calendarBeforeSeed = await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__title').textContent`
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__navigation button[aria-label="下个月"]').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `(() => { const title = document.querySelector('.month-toolbar__title').textContent; const match = title.match(/(\\d+)年(\\d+)月/); const firstActive = document.querySelector('.month-day-cell:not(.is-outside)')?.dataset.date; if (!match || !firstActive || title === ${JSON.stringify(calendarBeforeSeed)} || document.querySelector('.month-toolbar').classList.contains('is-busy')) return false; return firstActive.startsWith(match[1] + '-' + String(match[2]).padStart(2, '0')) })()`
        ),
      '月历测试数据没有切换到未来月份'
    )
    const seededCalendar = await monthWindow.webContents.executeJavaScript(`(async () => {
      const cells = Array.from(document.querySelectorAll('.month-day-cell'))
      const keys = cells.map((cell) => cell.dataset.date)
      const isActive = (index) => Boolean(cells[index] && !cells[index].classList.contains('is-outside'))
      const sameWeekCandidates = cells.flatMap((_cell, index) =>
        isActive(index) && index % 7 <= 4 && isActive(index + 2) ? [index] : []
      )
      const crossWeekCandidates = cells.flatMap((_cell, index) =>
        isActive(index) && index % 7 >= 4 && isActive(index + 6) ? [index] : []
      )
      let sameWeekIndex = -1
      let crossWeekIndex = -1
      for (const candidate of crossWeekCandidates) {
        const nonOverlapping = sameWeekCandidates.find(
          (index) => index > candidate + 6 || index + 2 < candidate
        )
        if (nonOverlapping >= 0) {
          sameWeekIndex = nonOverlapping
          crossWeekIndex = candidate
          break
        }
      }
      const overflowIndex = crossWeekIndex + 5
      if (sameWeekIndex < 0 || crossWeekIndex < 0 || !isActive(overflowIndex)) {
        throw new Error('未来月份没有找到稳定的同周与跨周测试日期')
      }
      const timestamp = (key) => new Date(key + 'T09:00:00').getTime()
      const create = (content, key, durationDays = 1) => window.api.createNoteWithAssets({
        options: { content, effectiveAt: timestamp(key), durationDays },
        images: [],
        tagIds: []
      })
      await create('同周连续测试', keys[sameWeekIndex], 3)
      await create('跨周连续测试', keys[crossWeekIndex], 7)
      for (let index = 1; index <= 9; index += 1) {
        await create('溢出测试-' + index, keys[overflowIndex], 1)
      }
      return {
        sameWeekKey: keys[sameWeekIndex],
        crossWeekKey: keys[crossWeekIndex],
        overflowKey: keys[overflowIndex]
      }
    })()`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelectorAll('.month-event-bar[data-preview="同周连续测试"]').length === 1`
        ),
      '同周多日便签没有渲染为单个连续横条'
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `document.querySelectorAll('.month-event-bar[data-preview="跨周连续测试"]').length`
      ),
      2,
      '跨周多日便签必须按自然周拆成两段'
    )
    const sameWeekSpan = await monthWindow.webContents.executeJavaScript(`(() => {
      const bar = document.querySelector('.month-event-bar[data-preview="同周连续测试"]')
      const style = getComputedStyle(bar)
      return { start: style.gridColumnStart, end: style.gridColumnEnd }
    })()`)
    assert.equal(sameWeekSpan.end, 'span 3', '同周横条必须连续跨过三个日期格及其间隙')
    const eventBarLayout = await monthWindow.webContents.executeJavaScript(`(() => {
      const first = document.querySelector('.month-event-bar')
      const currentLane = Number(first.style.getPropertyValue('--event-lane')) || 0
      const second = first.cloneNode(true)
      second.style.setProperty('--event-lane', String(currentLane + 1))
      second.setAttribute('aria-hidden', 'true')
      first.parentElement.append(second)
      const firstRect = first.getBoundingClientRect()
      const secondRect = second.getBoundingClientRect()
      const text = first.querySelector('.month-event-bar__text')
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 1
      const result = {
        gapInRem: (secondRect.top - firstRect.bottom) / rem,
        textAlign: getComputedStyle(text).textAlign,
        whiteSpace: getComputedStyle(text).whiteSpace,
        textOverflow: getComputedStyle(text).textOverflow
      }
      second.remove()
      return result
    })()`)
    assert.ok(
      eventBarLayout.gapInRem >= 2 && eventBarLayout.gapInRem <= 4,
      '便签横条之间只应保留必要间距'
    )
    assert.equal(eventBarLayout.textAlign, 'left', '便签摘要必须左对齐')
    assert.equal(eventBarLayout.whiteSpace, 'nowrap', '日期格摘要不得换行')
    assert.equal(eventBarLayout.textOverflow, 'ellipsis', '过长摘要必须使用省略号')

    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-event-bar[data-preview="同周连续测试"]').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-event-tooltip')?.textContent?.trim() === '同周连续测试'`
        ),
      '点击便签横条没有显示全文浮层'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-day-cell[data-date="${seededCalendar.overflowKey}"] .month-day-cell__count')?.textContent?.includes('10')`
        ),
      '日期格没有显示覆盖当天的便签总数'
    )
    const countBadge = await monthWindow.webContents.executeJavaScript(`(() => {
      const cell = document.querySelector('.month-day-cell[data-date="${seededCalendar.overflowKey}"]')
      const badge = cell.querySelector('.month-day-cell__count')
      const activate = cell.querySelector('.month-day-cell__quick-activate')
      const quickCreate = cell.querySelector('.month-day-cell__quick-create')
      const cellRect = cell.getBoundingClientRect()
      const badgeRect = badge.getBoundingClientRect()
      const activateRect = activate.getBoundingClientRect()
      const quickCreateRect = quickCreate.getBoundingClientRect()
      return {
        text: badge.textContent.trim(),
        rightGap: cellRect.right - badgeRect.right,
        bottomGap: cellRect.bottom - badgeRect.bottom,
        hasOverflowDots: Boolean(cell.querySelector('.month-day-cell__overflow')),
        activateCoversFooter:
          activateRect.left <= quickCreateRect.left &&
          activateRect.right >= badgeRect.right &&
          Math.abs(activateRect.bottom - cellRect.bottom) <= 1,
        createOpacity: getComputedStyle(quickCreate).opacity,
        createLeftGap: quickCreateRect.left - cellRect.left,
        createBottomGap: cellRect.bottom - quickCreateRect.bottom
      }
    })()`)
    assert.equal(countBadge.text, '10', '便签数量徽标必须只显示总数数字')
    assert.ok(
      countBadge.rightGap > 0 && countBadge.bottomGap > 0,
      '便签数量徽标必须位于日期格右下角'
    )
    assert.equal(countBadge.hasOverflowDots, false, '日期格底部不得继续显示溢出三个点')
    assert.equal(
      countBadge.activateCoversFooter,
      true,
      '快速新建热区必须覆盖左侧加号、中间空白和右侧数量'
    )
    assert.equal(countBadge.createOpacity, '1', '日期格快速新建加号必须常显，不得依赖悬停')
    assert.ok(
      countBadge.createLeftGap > 0 && countBadge.createBottomGap > 0,
      '快速新建变形轮廓必须从日期格左下角开始'
    )
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.month-day-cell__more, .month-overflow'))`
      ),
      false,
      '月视图不应再显示溢出下拉框'
    )

    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `!document.querySelector('.month-toolbar__today')?.disabled && !document.querySelector('.month-toolbar').classList.contains('is-busy')`
        ),
      '月历测试数据完成后今天按钮仍不可用'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__today').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `(() => { const now = new Date(); const title = document.querySelector('.month-toolbar__title').textContent; return title.includes(now.getFullYear() + '年' + (now.getMonth() + 1) + '月') && !document.querySelector('.month-toolbar').classList.contains('is-busy') })()`
        ),
      '月历测试数据断言后没有回到今天'
    )

    const pastCreateState = await monthWindow.webContents.executeJavaScript(`(() => {
      const today = new Date()
      const key = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-')
      const past = Array.from(document.querySelectorAll('.month-day-cell:not(.is-outside)')).find((cell) => cell.dataset.date < key)
      const create = past?.querySelector('.month-day-cell__quick-activate')
      return { key: past?.dataset.date || '', ariaDisabled: create?.getAttribute('aria-disabled') || '' }
    })()`)
    assert.ok(pastCreateState.key, '当前月份缺少可用于历史补录的过去日期')
    assert.equal(pastCreateState.ariaDisabled, '', '过去日期的快速新建入口不应再禁用')

    const historicalQuickContent = `历史补录-${Date.now()}`
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-cell[data-date="${pastCreateState.key}"] .month-day-cell__quick-activate').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.activeElement?.matches('.month-day-cell[data-date="${pastCreateState.key}"] .month-day-cell__quick-create input')`
        ),
      '过去日期快速新建没有进入历史补录输入状态'
    )
    await monthWindow.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.month-day-cell[data-date="${pastCreateState.key}"] .month-day-cell__quick-create input')
      input.value = ${JSON.stringify(historicalQuickContent)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.closest('form').requestSubmit()
    })()`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-event-bar[data-preview=${JSON.stringify(historicalQuickContent)}]'))`
        ),
      '历史补录成功后没有显示在所选过去日期'
    )
    const historicalQuickNote = await monthWindow.webContents.executeJavaScript(`(async () => {
      const bar = document.querySelector('.month-event-bar[data-preview=${JSON.stringify(historicalQuickContent)}]')
      return window.api.getNote(Number(bar.dataset.noteId))
    })()`)
    const historicalDate = new Date(historicalQuickNote.effective_at)
    const historicalDateKey = [
      historicalDate.getFullYear(),
      String(historicalDate.getMonth() + 1).padStart(2, '0'),
      String(historicalDate.getDate()).padStart(2, '0')
    ].join('-')
    assert.equal(historicalDateKey, pastCreateState.key)
    assert.equal(historicalDate.getHours(), 0)
    assert.equal(historicalDate.getMinutes(), 1)
    assert.equal(historicalQuickNote.status, 'in_progress')
    assert.equal(historicalQuickNote.notify_enabled, 0)
    assert.ok(Math.abs(historicalQuickNote.created_at - Date.now()) < 10_000)
    assert.equal(historicalQuickNote.updated_at, historicalQuickNote.created_at)
    await monthWindow.webContents.executeJavaScript(
      `window.api.deleteNote(${Number(historicalQuickNote.id)})`
    )

    const scheduleEditResult = await monthWindow.webContents.executeJavaScript(`(async () => {
      let nearFutureError = ''
      try {
        await window.api.createNote({
          content: '不应创建的临近预约',
          effectiveAt: Date.now() + 30 * 1000
        })
      } catch (error) {
        nearFutureError = error.message
      }
      const created = await window.api.createNote({
        content: '历史补录保存边界',
        effectiveAt: Date.now() + 10 * 60 * 1000,
        notifyEnabled: true
      })
      const save = (note, effectiveAt, notifyEnabled = true) => window.api.saveNoteDraft({
        id: note.id,
        fields: {
          content: note.content,
          status: note.status,
          effectiveAt,
          durationDays: note.duration_days,
          notifyEnabled,
          isPinned: Boolean(note.is_pinned)
        },
        tagIds: [],
        addedImages: [],
        deletedImageIds: []
      })
      try {
        const backfillAt = Date.now() - 2 * 24 * 60 * 60 * 1000
        const backfilled = await save(created, backfillAt)
        const correctedAt = backfillAt - 60 * 60 * 1000
        const corrected = await save(backfilled, correctedAt)
        let futureError = ''
        try {
          await save(corrected, Date.now() + 10 * 60 * 1000)
        } catch (error) {
          futureError = error.message
        }
        const completed = await window.api.completeNote(corrected.id)
        let completedError = ''
        try {
          await save(completed, correctedAt - 60 * 60 * 1000, false)
        } catch (error) {
          completedError = error.message
        }
        return {
          created,
          backfilled,
          corrected,
          backfillAt,
          correctedAt,
          nearFutureError,
          futureError,
          completedError
        }
      } finally {
        await window.api.deleteNote(created.id)
      }
    })()`)
    assert.equal(scheduleEditResult.created.status, 'initialized')
    assert.equal(scheduleEditResult.created.notify_enabled, 1)
    assert.match(scheduleEditResult.nearFutureError, /2 分钟之后/)
    assert.equal(scheduleEditResult.backfilled.status, 'in_progress')
    assert.equal(scheduleEditResult.backfilled.effective_at, scheduleEditResult.backfillAt)
    assert.equal(scheduleEditResult.backfilled.notify_enabled, 0)
    assert.equal(scheduleEditResult.backfilled.created_at, scheduleEditResult.created.created_at)
    assert.ok(scheduleEditResult.backfilled.updated_at >= scheduleEditResult.created.updated_at)
    assert.equal(
      scheduleEditResult.backfilled.finished_at,
      scheduleEditResult.backfilled.updated_at
    )
    assert.equal(scheduleEditResult.corrected.status, 'in_progress')
    assert.equal(scheduleEditResult.corrected.effective_at, scheduleEditResult.correctedAt)
    assert.equal(scheduleEditResult.corrected.notify_enabled, 0)
    assert.equal(
      scheduleEditResult.corrected.finished_at,
      scheduleEditResult.backfilled.finished_at
    )
    assert.match(scheduleEditResult.futureError, /只能修正为当前或过去时间/)
    assert.match(scheduleEditResult.completedError, /已完成便签的生效时间不可修改/)

    // 日期侧栏保留完整属性新建器；日期格底部改为不遮挡日历的快速创建器。
    const todayKey = await monthWindow.webContents.executeJavaScript(`(() => {
      const date = new Date()
      return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
    })()`)
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-cell[data-date="${todayKey}"]').click()`
    )
    await setDayPanelOpen(monthWindow, true)
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-panel__create').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-creator'))`
        ),
      '日期侧栏新建按钮没有打开完整新建器'
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.activeElement?.matches('.month-creator textarea')`
        ),
      '月视图新建弹窗没有把初始焦点移入正文输入框'
    )
    const creatorLayering = await monthWindow.webContents.executeJavaScript(`(() => {
      const scene = document.querySelector('.month-scene')
      const creator = document.querySelector('.month-creator')
      return {
        backgroundBlurred: scene.classList.contains('is-ui-background-blurred'),
        creatorOutsideBlurredScene: !scene.contains(creator)
      }
    })()`)
    assert.deepEqual(
      creatorLayering,
      { backgroundBlurred: true, creatorOutsideBlurredScene: true },
      '新建弹窗必须位于模糊背景层之外，不能连同自身一起被模糊'
    )
    const creatorAccessibility = await monthWindow.webContents.executeJavaScript(`(() => {
      const help = document.querySelector('.month-creator .setting-help-btn')
      return {
        activeTag: document.activeElement?.tagName,
        activeInsideCreator: document.querySelector('.month-creator')?.contains(document.activeElement),
        activeIsTextarea: document.activeElement?.matches('.month-creator textarea'),
        helpTag: help?.tagName,
        helpExpanded: help?.getAttribute('aria-expanded')
      }
    })()`)
    assert.deepEqual(
      creatorAccessibility,
      {
        activeTag: 'TEXTAREA',
        activeInsideCreator: true,
        activeIsTextarea: true,
        helpTag: 'BUTTON',
        helpExpanded: 'false'
      },
      '月视图新建弹窗必须接管初始焦点，帮助入口必须具备按钮语义'
    )
    const creatorParity = await monthWindow.webContents.executeJavaScript(`(() => ({
      screenshot: Boolean(document.querySelector('.month-creator .sp-btn')),
      dropzone: Boolean(document.querySelector('.month-creator .ip-dropzone')),
      imageLabel: Array.from(document.querySelectorAll('.month-creator__field > label')).some(
        (label) => label.textContent.trim().startsWith('图片')
      )
    }))()`)
    assert.deepEqual(
      creatorParity,
      { screenshot: true, dropzone: true, imageLabel: true },
      '月视图新建器必须复用列表的截图、点击和拖拽图片入口'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-creator .setting-help-btn').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.help-tooltip'))`
        ),
      '月视图新建器的帮助浮层没有显示'
    )
    const helpLayering = await monthWindow.webContents.executeJavaScript(`(() => ({
      tooltip: Number.parseInt(getComputedStyle(document.querySelector('.help-tooltip')).zIndex, 10),
      modal: Number.parseInt(getComputedStyle(document.querySelector('.month-modal-overlay')).zIndex, 10)
    }))()`)
    assert.ok(helpLayering.tooltip > helpLayering.modal, '帮助浮层必须显示在月视图新建面板之上')
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-creator > header button').click()`
    )
    await waitUntil(
      () => monthWindow.webContents.executeJavaScript(`!document.querySelector('.month-creator')`),
      '空白完整新建器没有关闭'
    )
    await setDayPanelOpen(monthWindow, false)
    await monthWindow.webContents.executeJavaScript(`(() => {
      window.__calendarEventPresenceFrames = []
      const nativeAnimate = Element.prototype.animate
      Element.prototype.animate = function (keyframes, options) {
        if (this.matches?.('.month-event-bar, [data-calendar-presence-clone]')) {
          window.__calendarEventPresenceFrames.push({
            preview: this.dataset.preview || '',
            clone: this.hasAttribute('data-calendar-presence-clone'),
            keyframes: keyframes.map((frame) => ({ ...frame })),
            options: { ...options }
          })
        }
        return nativeAnimate.call(this, keyframes, options)
      }
    })()`)
    await monthWindow.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('.month-day-cell[data-date="${todayKey}"] .month-day-cell__quick-activate')
      trigger.focus()
      trigger.click()
    })()`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.activeElement?.matches('.month-day-cell[data-date="${todayKey}"] .month-day-cell__quick-create input')`
        ),
      '快速新建器没有立即把焦点移入输入框'
    )
    await wait(320)
    const quickCreatorState = await monthWindow.webContents.executeJavaScript(`(() => {
      const cell = document.querySelector('.month-day-cell[data-date="${todayKey}"]')
      const creator = cell.querySelector('.month-day-cell__quick-create')
      const action = creator.querySelector('button')
      const input = creator.querySelector('input')
      const cellRect = cell.getBoundingClientRect()
      const creatorRect = creator.getBoundingClientRect()
      const actionRect = action.getBoundingClientRect()
      return {
        active: creator.classList.contains('is-active'),
        ready: creator.classList.contains('is-ready'),
        expanded: creatorRect.width > cellRect.width * 0.7,
        actionAtRight: cellRect.right - actionRect.right < 10,
        placeholder: input.placeholder,
        modalVisible: Boolean(document.querySelector('.month-creator')),
        backgroundBlurred: document.querySelector('.month-scene').classList.contains('is-ui-background-blurred')
      }
    })()`)
    assert.deepEqual(
      quickCreatorState,
      {
        active: true,
        ready: true,
        expanded: true,
        actionAtRight: true,
        placeholder: '新建便签',
        modalVisible: false,
        backgroundBlurred: false
      },
      '日期格快速新建器没有完成原位展开，或错误触发了模态遮罩'
    )
    await monthWindow.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('.month-day-cell[data-date="${todayKey}"] .month-day-cell__quick-create button')
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
      button.click()
    })()`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('.msg-text')).some((node) => node.textContent === '请输入便签内容')`
        ),
      '快速新建空内容没有给出输入提示'
    )
    await monthWindow.webContents.executeJavaScript(`(async () => {
      const input = document.querySelector('.month-day-cell[data-date="${todayKey}"] .month-day-cell__quick-create input')
      input.value = '今天立即便签'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(requestAnimationFrame)
      const button = document.querySelector('.month-day-cell[data-date="${todayKey}"] .month-day-cell__quick-create button')
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
      button.click()
    })()`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-event-bar[data-preview="今天立即便签"]'))`
        ),
      '快速创建成功后日期格没有立即增加便签横条'
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `window.__calendarEventPresenceFrames.some((item) => item.preview === '今天立即便签' && item.keyframes[0]?.opacity === 0 && item.keyframes[0]?.translate === '0 4px')`
        ),
      '新增便签横条没有播放局部进入动画'
    )
    const quickCreateAfterSuccess = await monthWindow.webContents.executeJavaScript(`(() => ({
      active: document.querySelector('.month-day-cell[data-date="${todayKey}"] .month-day-cell__quick-create')?.classList.contains('is-active'),
      value: document.querySelector('.month-day-cell[data-date="${todayKey}"] .month-day-cell__quick-create input')?.value,
      focused: document.activeElement?.matches('.month-day-cell[data-date="${todayKey}"] .month-day-cell__quick-create input')
    }))()`)
    assert.deepEqual(
      quickCreateAfterSuccess,
      { active: true, value: '', focused: true },
      '快速创建成功后必须清空正文并保持展开和输入焦点'
    )
    const quickCreatorCloseMotion = await monthWindow.webContents.executeJavaScript(`(async () => {
      const creator = document.querySelector('.month-day-cell[data-date="${todayKey}"] .month-day-cell__quick-create')
      const action = creator.querySelector('button')
      const toolbar = document.querySelector('.month-toolbar')
      const startLeft = action.getBoundingClientRect().left
      toolbar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      toolbar.click()
      await new Promise(requestAnimationFrame)
      const animations = creator.getAnimations()
      await new Promise((resolve) => setTimeout(resolve, 140))
      const middleLeft = action.getBoundingClientRect().left
      await Promise.allSettled(animations.map((animation) => animation.finished))
      const endLeft = action.getBoundingClientRect().left
      return {
        animationCount: animations.length,
        startLeft,
        middleLeft,
        endLeft,
        active: creator.classList.contains('is-active')
      }
    })()`)
    assert.ok(quickCreatorCloseMotion.animationCount > 0, '快速新建器失焦收起时没有启动反向动画')
    assert.ok(
      quickCreatorCloseMotion.middleLeft < quickCreatorCloseMotion.startLeft &&
        quickCreatorCloseMotion.middleLeft > quickCreatorCloseMotion.endLeft,
      '快速新建器收起过程中，新建按钮没有从右向左移动'
    )
    assert.equal(quickCreatorCloseMotion.active, false, '反向动画结束后快速新建器仍处于展开状态')
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `!document.querySelector('.month-day-cell[data-date="${todayKey}"] .month-day-cell__quick-create.is-active')`
        ),
      '快速新建器在点击外部后没有收起'
    )
    await monthWindow.webContents.executeJavaScript(`(() => {
      const cell = document.querySelector('.month-day-cell[data-date="${todayKey}"]')
      if (!cell.classList.contains('is-selected')) cell.click()
      if (!document.querySelector('.month-day-panel')) {
        document.querySelector('.month-toolbar__day-panel-toggle').click()
      }
    })()`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('.month-day-panel .nl-card-text')).some((node) => node.textContent === '今天立即便签')`
        ),
      '今天默认时间创建的便签没有进入当日侧栏'
    )
    const immediateStatus = await monthWindow.webContents.executeJavaScript(`(() => {
      const card = Array.from(document.querySelectorAll('.month-day-panel .nl-card')).find((item) => item.querySelector('.nl-card-text')?.textContent === '今天立即便签')
      return card?.className
    })()`)
    assert.match(
      immediateStatus || '',
      /nl-card--in_progress/,
      '今天未调整时间必须创建为立即进行中'
    )

    await monthWindow.webContents.executeJavaScript(`(() => {
      const card = Array.from(document.querySelectorAll('.month-day-panel .nl-card')).find((item) => item.querySelector('.nl-card-text')?.textContent === '今天立即便签')
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 180 }))
    })()`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.nl-context-menu'))`
        ),
      '日期侧栏便签操作菜单没有打开'
    )
    await monthWindow.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.nl-context-menu button')).find((button) => button.textContent.trim() === '修改').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-editor-dialog'))`
        ),
      '日期侧栏修改按钮没有复用便签编辑器'
    )
    await monthWindow.webContents.executeJavaScript(`(async () => {
      const textarea = document.querySelector('.month-editor-dialog textarea')
      textarea.value = '今天立即便签-已修改'
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(requestAnimationFrame)
      document.querySelector('.month-editor-dialog .ne-submit').click()
    })()`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `!document.querySelector('.month-editor-dialog')`
        ),
      '月视图编辑保存后没有关闭'
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('.month-day-panel .nl-card-text')).some((node) => node.textContent === '今天立即便签-已修改')`
        ),
      '月视图编辑结果没有刷新到日期侧栏'
    )
    await monthWindow.webContents.executeJavaScript(`(() => {
      const card = Array.from(document.querySelectorAll('.month-day-panel .nl-card')).find((item) => item.querySelector('.nl-card-text')?.textContent === '今天立即便签-已修改')
      card.querySelector('.sr-control[aria-label="标记完成"]').click()
    })()`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('.month-day-panel .nl-card')).some((item) => item.classList.contains('nl-card--completed') && item.querySelector('.nl-card-text')?.textContent === '今天立即便签-已修改')`
        ),
      '月视图没有完成便签或完成态没有保留在日期范围中'
    )

    await monthWindow.webContents.executeJavaScript(`(() => {
      const card = Array.from(document.querySelectorAll('.month-day-panel .nl-card')).find((item) => item.querySelector('.nl-card-text')?.textContent === '今天立即便签-已修改')
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 180 }))
    })()`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('.nl-context-menu button')).some((button) => button.textContent.trim() === '置顶')`
        ),
      '共享便签卡片没有提供置顶操作'
    )
    await monthWindow.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.nl-context-menu button')).find((button) => button.textContent.trim() === '置顶').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(Array.from(document.querySelectorAll('.month-day-panel .nl-card')).find((item) => item.querySelector('.nl-card-text')?.textContent === '今天立即便签-已修改')?.querySelector('.nl-card-icon[aria-label="已置顶"]'))`
        ),
      '月视图置顶便签后没有更新共享卡片状态'
    )

    await monthWindow.webContents.executeJavaScript(`(() => {
      const card = Array.from(document.querySelectorAll('.month-day-panel .nl-card')).find((item) => item.querySelector('.nl-card-text')?.textContent === '今天立即便签-已修改')
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 180 }))
    })()`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.nl-context-menu'))`
        ),
      '日期侧栏删除前没有打开便签操作菜单'
    )
    await monthWindow.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.nl-context-menu button')).find((button) => button.textContent.trim() === '删除').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('[data-modal-layer="confirm"]'))`
        ),
      '月视图删除操作没有请求确认'
    )
    await monthWindow.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('[data-modal-layer="confirm"]')
      Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent.trim() === '删除').click()
    })()`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `!Array.from(document.querySelectorAll('.month-day-panel .nl-card-text')).some((node) => node.textContent === '今天立即便签-已修改')`
        ),
      '删除后便签仍留在月视图日期侧栏'
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `!document.querySelector('.month-event-bar[data-preview="今天立即便签-已修改"]') && window.__calendarEventPresenceFrames.some((item) => item.clone && item.preview === '今天立即便签-已修改' && item.keyframes.at(-1)?.opacity === 0)`
        ),
      '删除便签后日期格横条没有播放局部退出动画'
    )

    // 左侧当日列表新建未来便签，默认使用选中日期 + 当前时间。
    let futureKey = await monthWindow.webContents.executeJavaScript(`(() => {
      const today = '${todayKey}'
      return Array.from(document.querySelectorAll('.month-day-cell:not(.is-outside)')).find((cell) => cell.dataset.date > today)?.dataset.date
    })()`)
    if (!futureKey) {
      await waitUntil(
        () =>
          monthWindow.webContents.executeJavaScript(
            `!document.querySelector('.month-toolbar').classList.contains('is-busy') && !document.querySelector('.month-toolbar__navigation button[aria-label="下个月"]').disabled`
          ),
        '月末测试切换前月份导航仍处于忙碌状态'
      )
      const monthBeforeFutureNavigation = await monthWindow.webContents.executeJavaScript(
        `document.querySelector('.month-toolbar__title').textContent`
      )
      await monthWindow.webContents.executeJavaScript(
        `document.querySelector('.month-toolbar__navigation button[aria-label="下个月"]').click()`
      )
      await waitUntil(
        () =>
          monthWindow.webContents.executeJavaScript(
            `document.querySelector('.month-toolbar__title').textContent !== ${JSON.stringify(monthBeforeFutureNavigation)} && !document.querySelector('.month-toolbar').classList.contains('is-busy') && Array.from(document.querySelectorAll('.month-day-cell:not(.is-outside)')).some((cell) => cell.dataset.date > '${todayKey}')`
          ),
        '月末测试切换到下个月后没有可用的未来日期'
      )
      futureKey = await monthWindow.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.month-day-cell:not(.is-outside)')).find((cell) => cell.dataset.date > '${todayKey}')?.dataset.date`
      )
    }
    assert.ok(futureKey, '当前 42 格中应至少有一个未来日期')
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-cell[data-date="${futureKey}"]').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-day-panel__header strong')?.textContent?.length > 0`
        ),
      '选择未来日期后日期侧栏没有更新'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-panel__create').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-creator'))`
        ),
      '日期侧栏新建入口没有打开统一新建器'
    )
    await monthWindow.webContents.executeJavaScript(`(async () => {
      const textarea = document.querySelector('.month-creator textarea')
      textarea.value = '未来日期便签'
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(requestAnimationFrame)
      document.querySelector('.month-creator footer .is-primary').click()
    })()`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('.month-day-panel .nl-card-text')).some((node) => node.textContent === '未来日期便签')`
        ),
      '日期侧栏新建的未来便签没有落在选中日期'
    )

    const appleTitlebar = await monthWindow.webContents.executeJavaScript(`(() => {
    const titlebar = document.querySelector('.app-titlebar')
    const group = document.querySelector('.titlebar-actions-group')
    const settings = document.querySelector('.month-titlebar-btn[title="设置"]')
    const help = document.querySelector('.month-titlebar-btn[aria-controls="help-workspace"]')
    const settingsRect = settings.getBoundingClientRect()
    const helpRect = help.getBoundingClientRect()
    return {
      titlebarClass: titlebar.className,
      groupClass: group.className,
      settingsLeft: settingsRect.left,
      helpLeft: helpRect.left,
      settingsWidth: settingsRect.width,
      settingsHeight: settingsRect.height,
      settingsRadius: getComputedStyle(settings).borderRadius,
      settingsBackground: getComputedStyle(settings).backgroundColor
    }
  })()`)
    assert.match(appleTitlebar.titlebarClass, /app-titlebar--apple/)
    assert.match(appleTitlebar.groupClass, /titlebar-actions-group--apple/)
    assert.ok(
      Math.abs(appleTitlebar.settingsWidth - appleTitlebar.settingsHeight) < 0.1,
      'Apple 风格的月视图业务按钮必须为圆形'
    )
    assert.equal(appleTitlebar.settingsRadius, '50%')
    assert.equal(appleTitlebar.settingsBackground, 'rgb(0, 113, 227)')
    assert.ok(
      appleTitlebar.settingsLeft < appleTitlebar.helpLeft,
      'Apple 风格应保持设置、帮助的 DOM 顺序'
    )

    await monthWindow.webContents.executeJavaScript(
      `window.api.setSettingValue('appearance.titlebarStyle', 'microsoft')`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.app-titlebar')?.classList.contains('app-titlebar--microsoft')`
        ),
      '月视图没有切换到 Microsoft 导航栏风格'
    )
    await wait(250)
    const microsoftTitlebar = await monthWindow.webContents.executeJavaScript(`(() => {
    const group = document.querySelector('.titlebar-actions-group')
    const settings = document.querySelector('.month-titlebar-btn[title="设置"]')
    const help = document.querySelector('.month-titlebar-btn[aria-controls="help-workspace"]')
    const icon = settings.querySelector('.btn-icon')
    const settingsRect = settings.getBoundingClientRect()
    return {
      groupClass: group.className,
      titleExists: Boolean(document.querySelector('.app-titlebar-title')),
      settingsLeft: settingsRect.left,
      helpLeft: help.getBoundingClientRect().left,
      settingsWidth: settingsRect.width,
      settingsHeight: settingsRect.height,
      settingsBackground: getComputedStyle(settings).backgroundColor,
      iconOpacity: getComputedStyle(icon).opacity
    }
  })()`)
    assert.match(microsoftTitlebar.groupClass, /titlebar-actions-group--microsoft/)
    assert.equal(microsoftTitlebar.titleExists, false, 'Microsoft 风格也不得重复显示月视图标题')
    assert.ok(
      microsoftTitlebar.settingsWidth > microsoftTitlebar.settingsHeight,
      'Microsoft 风格的月视图业务按钮必须使用 Fluent 矩形尺寸'
    )
    assert.equal(microsoftTitlebar.settingsBackground, 'rgba(0, 0, 0, 0)')
    assert.equal(microsoftTitlebar.iconOpacity, '0.72')
    assert.ok(
      microsoftTitlebar.settingsLeft < microsoftTitlebar.helpLeft,
      'Microsoft 风格不得反转设置和帮助按钮的顺序'
    )

    await monthWindow.webContents.executeJavaScript(
      `window.api.setSettingValue('appearance.titlebarStyle', 'apple')`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.app-titlebar')?.classList.contains('app-titlebar--apple')`
        ),
      '月视图没有恢复 Apple 导航栏风格'
    )

    assert.equal(monthWindow.isAlwaysOnTop(), true, '月视图应恢复默认置顶状态')
    await monthWindow.webContents.executeJavaScript(`(async () => {
      document.querySelector('.light-pin').click()
      await new Promise((resolve) => setTimeout(resolve, 40))
      document.querySelector('.z-order-option[data-mode="normal"]').click()
    })()`)
    await waitUntil(() => !monthWindow.isAlwaysOnTop(), '月视图正常层级没有取消置顶')
    await wait(550)
    await monthWindow.webContents.executeJavaScript(`(async () => {
      document.querySelector('.light-pin').click()
      await new Promise((resolve) => setTimeout(resolve, 40))
      document.querySelector('.z-order-option[data-mode="top"]').click()
    })()`)
    await waitUntil(() => monthWindow.isAlwaysOnTop(), '月视图始终置顶没有作用于主窗口')

    await wait(550)
    await monthWindow.webContents.executeJavaScript(`document.querySelector('.light-lock').click()`)
    await waitUntil(() => !monthWindow.isMovable(), '月视图锁定按钮没有禁用窗口移动')
    await wait(550)
    await monthWindow.webContents.executeJavaScript(`document.querySelector('.light-lock').click()`)
    await waitUntil(() => monthWindow.isMovable(), '月视图解锁按钮没有恢复窗口移动')

    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-titlebar-btn[title="设置"]').click()`
    )
    const openingSettingsWidthRatio = await waitUntil(async () => {
      const state = await monthWindow.webContents.executeJavaScript(`(() => {
          const panel = document.querySelector('.settings-panel--month')
          return {
            active: Boolean(panel?.classList.contains('active')),
            widthRatio: panel ? panel.getBoundingClientRect().width / window.innerWidth : 0
          }
        })()`)
      return state.active ? state.widthRatio : null
    }, '月视图设置面板没有从右侧打开')
    assert.ok(
      Math.abs(openingSettingsWidthRatio - 0.57) < 0.01,
      '月视图设置面板进场首帧没有使用保存宽度'
    )
    await wait(400)
    const settingsUi = await monthWindow.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.settings-panel--month')
    const rect = panel.getBoundingClientRect()
    const sectionTitles = Array.from(panel.querySelectorAll('.section-title'), (node) =>
      node.textContent.replace(/\\s+/g, ' ').trim()
    )
    return {
      widthRatio: rect.width / window.innerWidth,
      rightGap: window.innerWidth - rect.right,
      heightRatio: rect.height / window.innerHeight,
      resizeCursor: getComputedStyle(panel.querySelector('.drag-indicator')).cursor,
      sectionTitles,
      text: panel.textContent
    }
  })()`)
    assert.ok(Math.abs(settingsUi.widthRatio - 0.57) < 0.01, '月视图设置面板没有保持保存宽度')
    assert.ok(Math.abs(settingsUi.rightGap) < 1, '月视图设置面板必须贴住窗口右边缘')
    assert.ok(Math.abs(settingsUi.heightRatio - 1) < 0.01, '月视图设置面板必须占满窗口高度')
    assert.equal(settingsUi.resizeCursor, 'ew-resize', '月视图设置面板左边缘必须支持横向调宽')
    for (const title of [
      '基础样式',
      '窗口模糊玻璃与外观',
      'CSS 玻璃全局基准',
      '系统设置',
      '远程服务与隐私',
      '关于',
      '调度器诊断'
    ]) {
      assert.ok(
        settingsUi.sectionTitles.some((actualTitle) => actualTitle.startsWith(title)),
        `月视图设置缺少“${title}”板块`
      )
    }
    assert.equal(
      settingsUi.sectionTitles.includes('便利贴'),
      false,
      '月视图设置不应显示列表便签外观'
    )
    assert.equal(
      settingsUi.sectionTitles.includes('灵动岛'),
      false,
      '设置页面不应提供灵动岛宽高设置'
    )
    assert.match(settingsUi.text, /设置主页面壁纸/, '月视图必须保留独立壁纸设置')
    assert.match(settingsUi.text, /窗口边框/, '月视图必须提供当前视图的窗口边框开关')
    assert.match(settingsUi.text, /查看全部通知/)
    assert.match(settingsUi.text, /恢复默认设置/)
    assert.match(settingsUi.text, /清空便签数据/)

    const borderToggleInitial = await monthWindow.webContents.executeJavaScript(`(() => {
      const item = Array.from(document.querySelectorAll('.settings-panel--month .setting-item')).find(
        (node) => node.querySelector('.setting-label')?.textContent.includes('窗口边框')
      )
      return {
        found: Boolean(item),
        enabled: item?.querySelector('.switch')?.classList.contains('on') ?? null,
        cssWidth: getComputedStyle(document.documentElement).getPropertyValue('--window-border-width').trim(),
        renderedWidth: getComputedStyle(document.querySelector('.month-root'), '::after').borderTopWidth
      }
    })()`)
    assert.equal(borderToggleInitial.found, true)
    assert.equal(borderToggleInitial.enabled, false, '窗口边框应默认关闭以保持当前外观')
    assert.equal(borderToggleInitial.cssWidth, '0px')
    assert.equal(borderToggleInitial.renderedWidth, '0px')

    await monthWindow.webContents.executeJavaScript(`(() => {
      const item = Array.from(document.querySelectorAll('.settings-panel--month .setting-item')).find(
        (node) => node.querySelector('.setting-label')?.textContent.includes('窗口边框')
      )
      item.querySelector('.switch').click()
    })()`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `getComputedStyle(document.querySelector('.month-root'), '::after').borderTopWidth === '1px'`
        ),
      '开启窗口边框后没有立即绘制 1px 内侧边线'
    )
    await wait(350)
    assert.equal(
      await monthWindow.webContents.executeJavaScript(
        `window.api.getSettingsSnapshot().then((snapshot) => snapshot.values.css.windowBorder)`
      ),
      true,
      '窗口边框设置没有持久化到当前月视图'
    )

    await monthWindow.webContents.executeJavaScript(`(() => {
      const item = Array.from(document.querySelectorAll('.settings-panel--month .setting-item')).find(
        (node) => node.querySelector('.setting-label')?.textContent.includes('窗口边框')
      )
      item.querySelector('.switch').click()
    })()`)
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `getComputedStyle(document.querySelector('.month-root'), '::after').borderTopWidth === '0px'`
        ),
      '关闭窗口边框后没有移除内侧边线'
    )
    await wait(350)

    // 关闭设置，避免其全屏 Teleport 层影响后续窗口鼠标离开验证。
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.settings-panel--month .panel-close-btn').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `!document.querySelector('.settings-panel--month')`
        ),
      '月视图设置面板没有完成关闭动画'
    )
    monthWindow.setBounds(expectedBounds)
    await waitUntil(() => {
      const bounds = monthWindow.getBounds()
      return bounds.width === expectedBounds.width && bounds.height === expectedBounds.height
    }, '原生贴边测试前月视图没有恢复默认窗口尺寸')

    const user32 = koffi.load('user32.dll')
    const setCursorPos = user32.func('int SetCursorPos(int X, int Y)')
    const nativeDll = koffi.load(resolve('native_blur', 'build', 'bin', 'blur_engine.dll'))
    const getEdgeStatusJson = nativeDll.func('WindowMotion_GetEdgeMonitorStatusJson', 'str', [])
    const getEdgeStatus = () => JSON.parse(getEdgeStatusJson())
    originalCursor = screen.getCursorScreenPoint()
    assert.equal(setCursorPos(workArea.x + workArea.width - 2, workArea.y + workArea.height - 2), 1)

    monthWindow.setPosition(expectedBounds.x, workArea.y + 10)
    await waitUntil(
      () => monthWindow.getBounds().y === workArea.y,
      '月视图移入顶端 20px 阈值后没有吸附到工作区顶端'
    )
    await monthWindow.webContents.executeJavaScript(`window.api.windowHover(false)`)
    await waitUntil(
      () => monthWindow.getBounds().y + monthWindow.getBounds().height <= workArea.y,
      '月视图没有完整滑出工作区顶部'
    )
    const armedStatus = await waitUntil(() => {
      const status = getEdgeStatus()
      return status.workerAlive && ['armed', 'waiting-outside'].includes(status.state) && status
    }, '月视图顶部贴边后没有启动原生边缘监视器')
    assert.equal(armedStatus.side, -2, '月视图必须使用 DLL 顶部监视器')
    assert.equal(armedStatus.pollIntervalMs, 50, '月视图原生鼠标检测周期必须为 50ms')
    assert.equal(
      BrowserWindow.getAllWindows().filter((window) => window !== monthWindow).length,
      0,
      'Windows 原生贴边隐藏不得创建 Electron 触发窗口'
    )

    const topTriggerX = expectedBounds.x + Math.floor(expectedBounds.width / 2)
    assert.equal(setCursorPos(topTriggerX, workArea.y), 1)
    await waitUntil(
      () => monthWindow.getBounds().y === workArea.y,
      'DLL 没有在真实鼠标触顶后将月视图滑回可见位置'
    )
    await waitUntil(() => getEdgeStatus().state === 'stopped', '月视图恢复后没有停止原生边缘监视器')

    const outsideWindow = {
      x: workArea.x + workArea.width - 2,
      y: workArea.y + workArea.height - 2
    }
    const hideFromVisibleTop = async (message) => {
      assert.equal(setCursorPos(outsideWindow.x, outsideWindow.y), 1)
      await monthWindow.webContents.executeJavaScript(`window.api.windowHover(false)`)
      await waitUntil(
        () => monthWindow.getBounds().y + monthWindow.getBounds().height <= workArea.y,
        message
      )
    }
    const showFromTopTrigger = async (message) => {
      assert.equal(setCursorPos(topTriggerX, workArea.y), 1)
      await waitUntil(() => monthWindow.getBounds().y === workArea.y, message)
      await waitUntil(
        () => getEdgeStatus().state === 'stopped',
        `${message}：原生边缘监视器没有停止`
      )
    }

    // 锁屏会将隐藏窗口故障开放地恢复到可见边缘；解锁后必须重建
    // dockSide，否则后续鼠标离开不会再隐藏。
    await hideFromVisibleTop('锁屏回归测试前月视图没有隐藏')
    powerMonitor.emit('lock-screen')
    await waitUntil(
      () => monthWindow.getBounds().y === workArea.y,
      '锁屏后月视图没有恢复到可见边缘'
    )
    powerMonitor.emit('unlock-screen')
    await wait(100)
    await hideFromVisibleTop('解锁后月视图丢失了贴边隐藏状态')
    await showFromTopTrigger('解锁回归测试后月视图没有滑回')

    // DPI、分辨率、任务栏工作区与显示器增删共用同一处拓扑恢复逻辑。
    screen.emit('display-metrics-changed', {}, display, ['workArea'])
    await wait(400)
    await hideFromVisibleTop('显示器指标变化后月视图丢失了贴边隐藏状态')
    await showFromTopTrigger('显示器变化回归测试后月视图没有滑回')

    // 关闭到托盘会清理贴边会话；通知、托盘菜单和第二实例都进入
    // openMainWindow，重新显示时应按当前几何恢复贴边方向。
    await monthWindow.webContents.executeJavaScript(`window.api.closeWindow()`)
    await waitUntil(() => !monthWindow.isVisible(), '月视图没有正常关闭到托盘')
    app.emit('second-instance', {}, [])
    await waitUntil(
      () => monthWindow.isVisible() && monthWindow.getBounds().y === workArea.y,
      '第二实例唤醒没有恢复顶部贴边窗口'
    )
    await hideFromVisibleTop('托盘/第二实例唤醒后月视图丢失了贴边隐藏状态')
    await showFromTopTrigger('托盘唤醒回归测试后月视图没有滑回')

    // 月视图配置只允许 top。靠近底部并离开鼠标后，不得再次创建触发条或滑出屏幕。
    const bottomY = workArea.y + workArea.height - expectedBounds.height
    monthWindow.setPosition(expectedBounds.x, bottomY)
    await wait(300)
    await monthWindow.webContents.executeJavaScript(`window.api.windowHover(false)`)
    await wait(700)
    assert.equal(getEdgeStatus().state, 'stopped', '月视图底部不得启动原生边缘监视器')
    assert.equal(monthWindow.getBounds().y, bottomY, '月视图底部不得自动隐藏')

    report(
      'month view integration passed: calendar grid, panel persistence, multi-day layout, daily counts, CRUD, navbar, settings, native top dock and dock-state recovery'
    )
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    if (originalCursor) {
      try {
        const user32 = koffi.load('user32.dll')
        const setCursorPos = user32.func('int SetCursorPos(int X, int Y)')
        setCursorPos(originalCursor.x, originalCursor.y)
      } catch {
        exitCode = 1
      }
    }
    process.exitCode = exitCode
    app.releaseSingleInstanceLock()
    app.once('quit', () => {
      try {
        rmSync(testUserData, { recursive: true, force: true })
      } catch {
        // Crashpad 可能直到进程完全退出才释放最后一个句柄；测试结果不应被临时目录清理覆盖。
      }
      process.exit(exitCode)
    })
    app.quit()
  }
}
