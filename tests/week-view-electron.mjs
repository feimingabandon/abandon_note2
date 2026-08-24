import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, screen } from 'electron'

const WAIT_STEP_MS = 25
const require = createRequire(import.meta.url)
const report = (message) => process.stderr.write(`[week-e2e] ${message}\n`)

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
  // 周视图第一次启动应继承月视图的窗口、侧栏与外观设置。
  insert.run('month', 'geometry', 'pos_x', '110', now, now)
  insert.run('month', 'geometry', 'pos_y', '120', now, now)
  // GitHub Windows runner 的工作区约为 1024x720；尺寸过大时约束后的 y=20
  // 会恰好命中贴边阈值，并在 show 时被正常吸附到 y=0，干扰本用例的继承断言。
  insert.run('month', 'geometry', 'width', '900', now, now)
  insert.run('month', 'geometry', 'height', '600', now, now)
  insert.run('month', 'ui', 'day_panel_size', '33', now, now)
  insert.run('month', 'appearance', 'titlebar_style', 'microsoft', now, now)
  insert.run('month', 'system', 'blur_enabled', 'false', now, now)
  db.close()
}

function getWeekWindow() {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && /\/week\.html(?:$|[?#])/.test(window.webContents.getURL())
  )
}

function addDays(dateKey, amount) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + amount))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-week-e2e-'))

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
  report('seeded isolated database')

  require(resolve('out', 'main', 'index.js'))
  const mainChunk = readdirSync(resolve('out', 'main', 'chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk, '未找到构建后的主进程分块')
  require(resolve('out', 'main', 'chunks', mainChunk))
  app.once('ready', () => void runWeekViewTests())
} catch (error) {
  report(`setup failed: ${error?.stack || error}`)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}

async function runWeekViewTests() {
  try {
    const weekWindow = await waitUntil(() => getWeekWindow(), '周视图未按 active_view 启动')
    await waitUntil(() => weekWindow.isVisible(), '周视图渲染就绪后没有显示')

    const display = screen.getDisplayMatching(weekWindow.getBounds())
    const expectedInherited = { x: 110, y: 120, width: 900, height: 600 }
    const constrainedExpected = {
      width: Math.min(expectedInherited.width, display.workArea.width),
      height: Math.min(expectedInherited.height, display.workArea.height),
      x: Math.max(
        display.workArea.x,
        Math.min(
          expectedInherited.x,
          display.workArea.x +
            display.workArea.width -
            Math.min(expectedInherited.width, display.workArea.width)
        )
      ),
      y: Math.max(
        display.workArea.y,
        Math.min(
          expectedInherited.y,
          display.workArea.y +
            display.workArea.height -
            Math.min(expectedInherited.height, display.workArea.height)
        )
      )
    }
    assert.deepEqual(
      weekWindow.getBounds(),
      constrainedExpected,
      '周视图首次启动未继承月视图窗口几何'
    )

    const initial = await weekWindow.webContents.executeJavaScript(`(() => ({
      cells: Array.from(document.querySelectorAll('.month-day-cell'), (cell) => cell.dataset.date),
      rowCount: document.querySelector('.month-grid')?.getAttribute('aria-rowcount'),
      label: document.querySelector('.month-grid')?.getAttribute('aria-label'),
      selected: document.querySelector('.month-day-cell.is-selected')?.dataset.date || '',
      title: document.querySelector('.month-toolbar__title')?.textContent?.trim() || '',
      previousLabel: document.querySelector('.month-toolbar__navigation button:first-child')?.getAttribute('aria-label'),
      nextLabel: document.querySelector('.month-toolbar__navigation button:nth-of-type(3)')?.getAttribute('aria-label'),
      templateButton: Boolean(document.querySelector('.month-titlebar-btn[aria-controls="template-workspace"]')),
      helpButton: Boolean(document.querySelector('.month-titlebar-btn[aria-controls="help-workspace"]')),
      microsoftTitlebar: document.querySelector('.app-titlebar')?.classList.contains('app-titlebar--microsoft'),
      today: (() => {
        const now = new Date()
        return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-')
      })()
    }))()`)
    assert.equal(initial.cells.length, 7, '周视图必须只渲染周一至周日7格')
    assert.equal(initial.rowCount, '2', '周历网格语义应为表头加一周共2行')
    assert.equal(initial.label, '周历')
    assert.equal(initial.previousLabel, '上一周')
    assert.equal(initial.nextLabel, '下一周')
    assert.equal(initial.templateButton, true, '周视图必须开放循环模板入口')
    assert.equal(initial.helpButton, true, '周视图必须开放帮助中心入口')
    assert.equal(initial.selected, initial.today, '周视图初始选中日期应为今天')
    assert.equal(initial.microsoftTitlebar, true, '周视图首次启动未继承月视图导航栏风格')
    assert.match(initial.title, /年.*月.*日—.*日/)

    await weekWindow.webContents.executeJavaScript(
      `document.querySelector('.month-titlebar-btn[aria-controls="template-workspace"]').click()`
    )
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `document.querySelector('.month-template-panel')?.classList.contains('active') && document.querySelector('.month-template-panel')?.textContent.includes('循环模板')`
        ),
      '周视图循环模板工作区没有完成打开'
    )
    await weekWindow.webContents.executeJavaScript(
      `document.querySelector('.month-template-panel .tcp-button').click()`
    )
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `document.querySelector('.month-template-panel .tcp-content')?.classList.contains('visible')`
        ),
      '周视图循环模板新建表单没有完成展开'
    )
    await weekWindow.webContents.executeJavaScript(
      `document.querySelector('.month-titlebar-btn[aria-controls="template-workspace"]').click()`
    )
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(`!document.querySelector('.month-template-wrapper')`),
      '周视图循环模板工作区没有完成关闭'
    )

    await weekWindow.webContents.executeJavaScript(
      `document.querySelector('.month-titlebar-btn[aria-controls="help-workspace"]').click()`
    )
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `document.querySelector('.month-help-panel')?.classList.contains('active') && document.querySelector('.month-help-panel')?.textContent.includes('周视图')`
        ),
      '周视图帮助中心没有完成打开'
    )
    await weekWindow.webContents.executeJavaScript(
      `document.querySelector('.month-titlebar-btn[aria-controls="help-workspace"]').click()`
    )
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(`!document.querySelector('.month-help-wrapper')`),
      '周视图帮助中心没有完成关闭'
    )

    const inheritedSnapshot = await weekWindow.webContents.executeJavaScript(
      `window.api.getSettingsSnapshot()`
    )
    assert.equal(inheritedSnapshot.values.ui.dayPanelSize, 33, '周视图未继承月视图侧栏宽度')

    const visualQaDirectory = process.env.ABANDON_WEEK_VISUAL_QA_DIR
    if (visualQaDirectory) {
      mkdirSync(visualQaDirectory, { recursive: true })
      const scenarios = [
        { name: 'white', background: '255 255 255', text: '#111111', image: 'none' },
        { name: 'black', background: '5 5 5', text: '#f4f4f4', image: 'none' },
        {
          name: 'complex',
          background: '38 68 93',
          text: '#ffffff',
          image:
            'linear-gradient(135deg, #172a3a 0 24%, #bd6b45 24% 48%, #2e806e 48% 72%, #e4c46a 72% 100%)'
        }
      ]
      for (const scenario of scenarios) {
        await weekWindow.webContents.executeJavaScript(`(() => {
          const root = document.documentElement
          const surface = document.querySelector('.month-root')
          root.style.setProperty('--bg-color', '${scenario.background}')
          root.style.setProperty('--text-color', '${scenario.text}')
          root.style.setProperty('--window-opacity', '${scenario.name === 'complex' ? '0.78' : '1'}')
          surface.style.backgroundImage = '${scenario.image}'
          surface.style.backgroundSize = 'cover'
        })()`)
        await wait(80)
        writeFileSync(
          join(visualQaDirectory, `week-${scenario.name}.png`),
          (await weekWindow.capturePage()).toPNG()
        )
      }
      await weekWindow.webContents.executeJavaScript(`(() => {
        const root = document.documentElement
        const surface = document.querySelector('.month-root')
        root.style.setProperty('--bg-color', '38 68 93')
        root.style.setProperty('--text-color', '#ffffff')
        root.style.setProperty('--window-opacity', '0.78')
        surface.style.backgroundImage = ${JSON.stringify(
          'linear-gradient(135deg, #172a3a 0 24%, #bd6b45 24% 48%, #2e806e 48% 72%, #e4c46a 72% 100%)'
        )}
        document.querySelector('.month-toolbar__title').click()
      })()`)
      await waitUntil(
        () =>
          weekWindow.webContents.executeJavaScript(
            `Boolean(document.querySelector('.month-toolbar__date-picker-days'))`
          ),
        '视觉检查时日期选择器未打开'
      )
      await wait(80)
      writeFileSync(
        join(visualQaDirectory, 'week-complex-picker.png'),
        (await weekWindow.capturePage()).toPNG()
      )
      await weekWindow.webContents.executeJavaScript(
        `document.querySelector('.month-toolbar__title').click()`
      )
      await waitUntil(
        () =>
          weekWindow.webContents.executeJavaScript(
            `!document.querySelector('.month-toolbar__picker') && !document.querySelector('.month-toolbar__picker-backdrop')`
          ),
        '视觉检查后的日期选择器没有完成收起'
      )
    }

    // 展开侧栏后切换下一周，选中的星期与侧栏展开状态都必须保留。
    const sourceKey = initial.cells[2]
    await weekWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-cell[data-date="${sourceKey}"]').click()`
    )
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-day-panel'))`
        ),
      '点击日期后未展开日期侧栏'
    )
    await weekWindow.webContents.executeJavaScript(`(() => {
      const body = document.querySelector('.month-workspace__calendar-body')
      const nativeAnimate = body.animate.bind(body)
      window.__weekMotionFrames = []
      body.animate = (keyframes, options) => {
        window.__weekMotionFrames.push(keyframes.map((frame) => ({ ...frame })))
        return nativeAnimate(keyframes, options)
      }
      document.querySelector('.month-toolbar__navigation button[aria-label="下一周"]').click()
    })()`)
    const expectedNextSelection = addDays(sourceKey, 7)
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `document.querySelector('.month-day-cell.is-selected')?.dataset.date === '${expectedNextSelection}' && !document.querySelector('.month-toolbar')?.classList.contains('is-busy')`
        ),
      '切换下一周后没有保留选中的星期'
    )
    assert.equal(
      await weekWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.month-day-panel'))`
      ),
      true,
      '切周后日期侧栏不应收起'
    )
    const forwardMotion = await weekWindow.webContents.executeJavaScript(
      `window.__weekMotionFrames.slice(0, 2)`
    )
    assert.match(forwardMotion[0].at(-1).transform, /translateX\(-7%\)/)
    assert.match(forwardMotion[1][0].transform, /translateX\(7%\)/)

    // 动画尚未结束时连续点击两次，目标必须从待切换周继续累加到 +14 天。
    const rapidStartKey = await weekWindow.webContents.executeJavaScript(
      `document.querySelector('.month-day-cell.is-selected').dataset.date`
    )
    await weekWindow.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('.month-toolbar__navigation button[aria-label="下一周"]')
      button.click()
      button.click()
    })()`)
    const rapidExpected = addDays(rapidStartKey, 14)
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `document.querySelector('.month-day-cell.is-selected')?.dataset.date === '${rapidExpected}' && !document.querySelector('.month-toolbar')?.classList.contains('is-busy')`
        ),
      '快速连续切周没有累计到最后目标周'
    )

    // 标题日期选择器应能直接选择目标年月和日期，并跳转到该日期所在的周。
    await weekWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__title').click()`
    )
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-toolbar__date-picker-days'))`
        ),
      '周标题没有打开日期选择器'
    )
    await weekWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__date-picker-period').click()`
    )
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-toolbar__date-picker-month[data-value="2"]'))`
        ),
      '日期选择器没有提供直接年月选择面板'
    )
    await weekWindow.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('input[aria-label="日期选择年份"]')
      input.value = '2028'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('.month-toolbar__date-picker-month[data-value="2"]').click()
    })()`)
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-toolbar__date-option[aria-label^="2028-02-"]'))`
        ),
      '日期选择器没有直接跳到指定年月'
    )
    const chosenKey = await weekWindow.webContents.executeJavaScript(`(() => {
      const target = document.querySelector('.month-toolbar__date-option[aria-label="2028-02-16"]')
      target.click()
      return target.getAttribute('aria-label')
    })()`)
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `document.querySelector('.month-day-cell.is-selected')?.dataset.date === '${chosenKey}' && !document.querySelector('.month-toolbar')?.classList.contains('is-busy')`
        ),
      '日期选择器没有定位到目标日期所在周'
    )

    // 同一周内重新选择当前日期只关闭面板，不应播放整周换页动画。
    const sameWeekMotionStart = await weekWindow.webContents.executeJavaScript(
      `window.__weekMotionFrames.length`
    )
    await weekWindow.webContents.executeJavaScript(`(() => {
      document.querySelector('.month-toolbar__title').click()
    })()`)
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-toolbar__date-option.is-selected'))`
        ),
      '重新打开日期选择器失败'
    )
    await weekWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__date-option.is-selected').click()`
    )
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `document.querySelector('.month-toolbar__title').getAttribute('aria-expanded') === 'false'`
        ),
      '重新选择当前日期后日期面板未关闭'
    )
    assert.equal(
      await weekWindow.webContents.executeJavaScript(`window.__weekMotionFrames.length`),
      sameWeekMotionStart,
      '同周重选当前日期不得播放整周换页动画'
    )

    // 独立设置：修改周侧栏宽度后只写 week scope，month 原值不变。
    await weekWindow.webContents.executeJavaScript(
      `(async () => { await window.api.setSettingValue('ui.dayPanelSize', 41); return true })()`
    )
    const db = new Database(join(testUserData, 'app.db'))
    const weekSize = db
      .prepare(
        "SELECT value FROM app_settings WHERE window_name = 'week' AND key = 'day_panel_size'"
      )
      .pluck()
      .get()
    const monthSize = db
      .prepare(
        "SELECT value FROM app_settings WHERE window_name = 'month' AND key = 'day_panel_size'"
      )
      .pluck()
      .get()
    const inheritedMarker = db
      .prepare(
        "SELECT value FROM app_settings WHERE window_name = 'application' AND key = 'week_settings_initialized'"
      )
      .pluck()
      .get()
    db.close()
    assert.equal(weekSize, '41')
    assert.equal(monthSize, '33')
    assert.equal(inheritedMarker, 'true')

    report('all week view assertions passed')
    app.exit(0)
  } catch (error) {
    report(`failed: ${error?.stack || error}`)
    app.exit(1)
  }
}

app.on('will-quit', () => {
  rmSync(testUserData, { recursive: true, force: true })
})
