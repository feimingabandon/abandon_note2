import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'

const WAIT_STEP_MS = 25
const require = createRequire(import.meta.url)
const report = (message) => process.stderr.write(`[historical-note-move-e2e] ${message}\n`)

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

function localDate(offsetDays, hour = 9) {
  const date = new Date()
  date.setHours(hour, 0, 0, 0)
  date.setDate(date.getDate() + offsetDays)
  return date
}

function dateKey(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function seedMonthView(userDataPath) {
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
  insert.run('application', 'application', 'active_view', 'month', now, now)
  insert.run('application', 'remote', 'receive_notices', 'false', now, now)
  insert.run('application', 'remote', 'upload_device_info', 'false', now, now)
  insert.run('application', 'onboarding', 'first_use_notice_version', '1', now, now)
  insert.run('month', 'system', 'blur_enabled', 'false', now, now)
  insert.run('week', 'system', 'blur_enabled', 'false', now, now)
  database.close()
}

function getViewWindow(mode) {
  return BrowserWindow.getAllWindows().find(
    (window) =>
      !window.isDestroyed() &&
      new RegExp(`/${mode}\\.html(?:$|[?#])`).test(window.webContents.getURL())
  )
}

async function waitForView(mode) {
  const viewWindow = await waitUntil(() => getViewWindow(mode), `${mode} 视图没有创建`)
  await waitUntil(
    () =>
      viewWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.view-switcher__trigger[data-active-view="${mode}"]'))`
      ),
    `${mode} 视图尚未渲染完成`
  )
  return viewWindow
}

async function chooseView(viewWindow, mode) {
  await viewWindow.webContents.executeJavaScript(
    `document.querySelector('.view-switcher__trigger').click()`
  )
  await waitUntil(
    () =>
      viewWindow.webContents.executeJavaScript(
        `Boolean(document.querySelector('.view-switcher__menu [data-view="${mode}"]'))`
      ),
    `视图菜单中没有 ${mode}`
  )
  await viewWindow.webContents.executeJavaScript(
    `document.querySelector('.view-switcher__menu [data-view="${mode}"]').click()`
  )
}

async function openMovePanel(viewWindow) {
  let idleSince = 0
  await waitUntil(async () => {
    const idle = await viewWindow.webContents.executeJavaScript(`(() => {
        const toolbar = document.querySelector('.month-toolbar')
        const trigger = document.querySelector('.historical-note-move__trigger')
        return Boolean(trigger) && !trigger.disabled && !toolbar?.classList.contains('is-busy')
      })()`)
    if (!idle) {
      idleSince = 0
      return false
    }
    if (!idleSince) idleSince = Date.now()
    return Date.now() - idleSince >= 120
  }, '未完成便签移动按钮长时间不可用')
  await viewWindow.webContents.executeJavaScript(`(() => {
    const trigger = document.querySelector('.historical-note-move__trigger')
    if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click()
  })()`)
  const keyframes = await waitUntil(
    () =>
      viewWindow.webContents.executeJavaScript(`(() => {
        const panel = document.querySelector('.historical-note-move__panel')
        const animation = panel?.getAnimations().find((item) => {
          const frames = item.effect?.getKeyframes() || []
          const first = String(frames[0]?.clipPath || '')
          const last = String(frames.at(-1)?.clipPath || '')
          return first.includes('100%') && !last.includes('100%')
        })
        return animation
          ? animation.effect.getKeyframes().map((frame) => String(frame.clipPath || ''))
          : null
      })()`),
    '未完成便签移动面板没有播放卷帘展开动画'
  )
  return keyframes
}

async function closeMovePanel(viewWindow) {
  await viewWindow.webContents.executeJavaScript(
    `document.querySelector('.historical-note-move__trigger').click()`
  )
  const keyframes = await waitUntil(
    () =>
      viewWindow.webContents.executeJavaScript(`(() => {
        const panel = document.querySelector('.historical-note-move__panel')
        const animation = panel?.getAnimations().find((item) => {
          const frames = item.effect?.getKeyframes() || []
          const first = String(frames[0]?.clipPath || '')
          const last = String(frames.at(-1)?.clipPath || '')
          return !first.includes('100%') && last.includes('100%')
        })
        return animation
          ? animation.effect.getKeyframes().map((frame) => String(frame.clipPath || ''))
          : null
      })()`),
    '未完成便签移动面板没有播放卷帘收起动画'
  )
  await waitUntil(
    () =>
      viewWindow.webContents.executeJavaScript(
        `!document.querySelector('.historical-note-move__panel')`
      ),
    '未完成便签移动面板没有完成收起'
  )
  return keyframes
}

async function waitForPreview(viewWindow, expectedCount, expectedText) {
  let lastState = null
  try {
    return await waitUntil(async () => {
      const state = await viewWindow.webContents.executeJavaScript(`(() => ({
      text: document.querySelector('[data-move-preview]')?.textContent.trim() || '',
      actionDisabled: document.querySelector('[data-move-action]')?.disabled,
      actionText: document.querySelector('[data-move-action]')?.textContent.trim() || '',
      activePreset: document.querySelector('.historical-note-move__presets .is-active')?.dataset.preset || '',
      selectionText: document.querySelector('[data-move-selection-count]')?.textContent.trim() || '',
      selectedNoteIds: Array.from(
        document.querySelectorAll('.historical-note-move__note-option input:checked'),
        (input) => Number(input.closest('[data-note-id]')?.dataset.noteId)
      ),
      groups: Array.from(document.querySelectorAll('.historical-note-move__note-group'), (group) => ({
        dateKey: group.querySelector('time')?.getAttribute('datetime') || '',
        notes: Array.from(
          group.querySelectorAll('.historical-note-move__note-option > span:last-child'),
          (note) => note.textContent.trim()
        )
      }))
    }))()`)
      lastState = state
      const renderedNoteCount = state.groups.reduce((total, group) => total + group.notes.length, 0)
      return state.text.includes(`${expectedCount} 条`) &&
        state.text.includes(expectedText) &&
        renderedNoteCount === expectedCount
        ? state
        : null
    }, `移动预览没有显示“${expectedText}”范围的 ${expectedCount} 条便签`)
  } catch (error) {
    throw new Error(`${error.message}；最后状态：${JSON.stringify(lastState)}`)
  }
}

async function recordPresetHeightChange(viewWindow, preset) {
  await wait(320)
  return viewWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const panel = document.querySelector('.historical-note-move__panel')
    const button = document.querySelector('[data-preset="${preset}"]')
    const indicator = document.querySelector('[data-move-preset-indicator]')
    if (!panel || !button || !indicator) {
      reject(new Error('记录高度变化时缺少浮层或快捷选项'))
      return
    }
    const samples = {
      heights: [],
      indicatorLefts: [],
      dateMotionObserved: false,
      previewMotionObserved: false,
      dateDirectionObserved: false,
      previewDirectionObserved: false
    }
    const sample = () => {
      samples.heights.push(panel.getBoundingClientRect().height)
      samples.indicatorLefts.push(indicator.getBoundingClientRect().left)
      const dateValues = Array.from(document.querySelectorAll('[data-date-range-value]'))
      const previewPages = Array.from(document.querySelectorAll('[data-move-preview-page]'))
      samples.dateMotionObserved ||= dateValues.length > 1 && dateValues.some(
        (element) => getComputedStyle(element).transform !== 'none'
      )
      samples.previewMotionObserved ||= previewPages.length > 1 && previewPages.some(
        (element) => getComputedStyle(element).transform !== 'none'
      )
      samples.dateDirectionObserved ||= dateValues.some(
        (element) => Array.from(element.classList).some((name) => name.includes('drp-value-'))
      )
      samples.previewDirectionObserved ||= previewPages.some(
        (element) => Array.from(element.classList).some((name) => name.includes('historical-note-move-'))
      )
    }
    sample()
    const timer = setInterval(sample, 16)
    button.click()
    setTimeout(() => {
      clearInterval(timer)
      sample()
      resolve(samples)
    }, 520)
  })`)
}

function assertHeightTransition(samples, direction) {
  const from = samples[0]
  const to = samples.at(-1)
  if (direction === 'expand') assert.ok(to > from + 20, '更多预览内容没有增加浮层高度')
  else assert.ok(to < from - 20, '更少预览内容没有降低浮层高度')
  const lower = Math.min(from, to) + 1
  const upper = Math.max(from, to) - 1
  assert.ok(
    samples.some((height) => height > lower && height < upper),
    '浮层高度在起点和终点之间没有出现过渡帧'
  )
}

function assertIndicatorTransition(samples, direction) {
  const from = samples[0]
  const to = samples.at(-1)
  if (direction === 'forward') assert.ok(to > from + 20, '快捷选中块没有向右移动')
  else assert.ok(to < from - 20, '快捷选中块没有向左移动')
  const lower = Math.min(from, to) + 1
  const upper = Math.max(from, to) - 1
  assert.ok(
    samples.some((left) => left > lower && left < upper),
    '快捷选中块在起点和终点之间没有出现滑动帧'
  )
}

function assertSelectionContentMotion(samples) {
  assert.equal(samples.dateMotionObserved, true, '日期范围文字没有出现移动过渡帧')
  assert.equal(samples.previewMotionObserved, true, '统计和便签预览没有出现移动过渡帧')
  assert.equal(samples.dateDirectionObserved, true, '日期范围文字没有应用方向过渡类')
  assert.equal(samples.previewDirectionObserved, true, '统计和便签预览没有应用方向过渡类')
}

const testUserData = mkdtempSync(join(tmpdir(), 'abandon-note-historical-move-'))

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
  app.once('ready', () => void runHistoricalNoteMoveTest())
} catch (error) {
  report(`setup failed: ${error?.stack || error}`)
  rmSync(testUserData, { recursive: true, force: true })
  app.exit(1)
}

async function runHistoricalNoteMoveTest() {
  try {
    const monthWindow = await waitForView('month')
    const dates = {
      today: dateKey(localDate(0)),
      yesterday: dateKey(localDate(-1)),
      recentThirdDay: dateKey(localDate(-3)),
      old: dateKey(localDate(-6))
    }
    const timestamps = {
      yesterday: localDate(-1).getTime(),
      recentThirdDay: localDate(-3).getTime(),
      old: localDate(-6).getTime()
    }
    const notes = await monthWindow.webContents.executeJavaScript(`(async () => {
      const yesterday = await window.api.createNote({
        content: '昨天继续做',
        effectiveAt: ${timestamps.yesterday},
        durationDays: 2
      })
      const recent = await window.api.createNote({
        content: '三天范围继续做',
        effectiveAt: ${timestamps.recentThirdDay}
      })
      const old = await window.api.createNote({
        content: '更早继续做',
        effectiveAt: ${timestamps.old}
      })
      const completed = await window.api.createNote({
        content: '昨天已经完成',
        effectiveAt: ${timestamps.yesterday}
      })
      await window.api.completeNote(completed.id)
      return {
        yesterdayId: yesterday.id,
        recentId: recent.id,
        oldId: old.id,
        completedId: completed.id,
        completedEffectiveAt: completed.effective_at
      }
    })()`)

    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-event-bar[data-note-id="${notes.yesterdayId}"]'))`
        ),
      '昨天的进行中便签没有出现在月视图'
    )

    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__day-panel-toggle').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.month-day-panel'))`
        ),
      '日期列表没有打开'
    )

    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.month-toolbar__title').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelector('.month-toolbar__title')?.getAttribute('aria-expanded') === 'true'`
        ),
      '年月选择器没有打开'
    )
    const openingKeyframes = await openMovePanel(monthWindow)
    assert.ok(openingKeyframes[0].includes('100%'), '浮层展开没有从顶部卷帘揭示')
    assert.ok(!openingKeyframes.at(-1).includes('100%'), '浮层展开没有完整展开到末帧')
    await wait(320)
    const closingKeyframes = await closeMovePanel(monthWindow)
    assert.ok(!closingKeyframes[0].includes('100%'), '浮层收起没有从完整状态开始')
    assert.ok(closingKeyframes.at(-1).includes('100%'), '浮层收起没有向顶部卷回')
    await openMovePanel(monthWindow)

    const initial = await waitForPreview(monthWindow, 1, dates.yesterday)
    assert.equal(initial.actionDisabled, false, '有可移动便签时执行按钮不应禁用')
    assert.deepEqual(initial.groups, [{ dateKey: dates.yesterday, notes: ['昨天继续做'] }])
    assert.deepEqual(initial.selectedNoteIds, [notes.yesterdayId], '预览完成后应默认全选便签')
    assert.equal(initial.selectionText, '已选 1 / 1 条')
    const initialUi = await monthWindow.webContents.executeJavaScript(`(() => ({
      triggerLabel: document.querySelector('.historical-note-move__trigger')?.getAttribute('aria-label'),
      activePreset: document.querySelector('.historical-note-move__presets .is-active')?.dataset.preset,
      rangeText: document.querySelector('.historical-note-move__range .drp-trigger')?.textContent.trim(),
      titlePickerOpen: document.querySelector('.month-toolbar__title')?.getAttribute('aria-expanded')
    }))()`)
    assert.equal(initialUi.triggerLabel, '将历史未完成便签移至今天')
    assert.equal(initialUi.activePreset, 'yesterday', '每次打开应默认选择昨天')
    assert.equal(initialUi.rangeText, `${dates.yesterday} — ${dates.yesterday}`)
    assert.equal(initialUi.titlePickerOpen, 'false', '打开移动面板时应关闭年月选择器')

    const expansionFrames = await recordPresetHeightChange(monthWindow, 'all')
    const monthAllPreview = await waitForPreview(monthWindow, 3, '全部历史')
    assertHeightTransition(expansionFrames.heights, 'expand')
    assertIndicatorTransition(expansionFrames.indicatorLefts, 'forward')
    assertSelectionContentMotion(expansionFrames)
    assert.deepEqual(
      new Set(monthAllPreview.selectedNoteIds),
      new Set([notes.yesterdayId, notes.recentId, notes.oldId]),
      '切换日期范围后应重新默认全选'
    )
    const selectionBarSurface = await monthWindow.webContents.executeJavaScript(`(() => {
      const bar = document.querySelector('.historical-note-move__selection-bar')
      const panel = document.querySelector('.historical-note-move__panel')
      return {
        bar: bar ? getComputedStyle(bar).backgroundColor : '',
        panel: panel ? getComputedStyle(panel).backgroundColor : ''
      }
    })()`)
    assert.equal(
      selectionBarSurface.bar,
      selectionBarSurface.panel,
      '吸顶选择栏应使用与浮层一致的实心表面，避免滚动内容透出'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('[data-move-clear-selection]').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(`(() => {
          const selected = document.querySelectorAll('.historical-note-move__note-option input:checked').length
          const action = document.querySelector('[data-move-action]')
          return selected === 0 && action?.disabled && action.textContent.includes('请选择')
        })()`),
      '取消全选没有清空选择并禁用移动操作'
    )
    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('[data-move-select-all]').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `document.querySelectorAll('.historical-note-move__note-option input:checked').length === 3`
        ),
      '全选没有恢复全部便签选择'
    )
    const collapseFrames = await recordPresetHeightChange(monthWindow, 'yesterday')
    await waitForPreview(monthWindow, 1, dates.yesterday)
    assertHeightTransition(collapseFrames.heights, 'collapse')
    assertIndicatorTransition(collapseFrames.indicatorLefts, 'backward')
    assertSelectionContentMotion(collapseFrames)

    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.historical-note-move__range .drp-trigger').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(`Boolean(document.querySelector('.drp-panel'))`),
      '手动日期范围面板没有打开'
    )
    const todayDisabled = await monthWindow.webContents.executeJavaScript(`(() => {
      const today = document.querySelector('.drp-day.is-today')
      return { exists: Boolean(today), disabled: today?.disabled }
    })()`)
    assert.deepEqual(todayDisabled, { exists: true, disabled: true }, '手动范围不得选择今天')
    await monthWindow.webContents.executeJavaScript(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `!document.querySelector('.drp-panel') && Boolean(document.querySelector('.historical-note-move__panel'))`
        ),
      'Escape 没有只关闭内层日期范围面板'
    )

    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('.historical-note-move__range .drp-trigger').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(`Boolean(document.querySelector('.drp-panel'))`),
      '手动日期范围面板没有重新打开'
    )
    await monthWindow.webContents.executeJavaScript(`(() => {
      const start = document.querySelector('.drp-day[aria-label="${dates.recentThirdDay}"]')
      const end = document.querySelector('.drp-day[aria-label="${dates.yesterday}"]')
      if (!start || !end) throw new Error('手动范围日期不在当前日历中')
      start.click()
      end.click()
      document.querySelector('.drp-done').click()
    })()`)
    const customPreview = await waitForPreview(monthWindow, 2, dates.recentThirdDay)
    assert.deepEqual(customPreview.groups, [
      { dateKey: dates.yesterday, notes: ['昨天继续做'] },
      { dateKey: dates.recentThirdDay, notes: ['三天范围继续做'] }
    ])
    const customRangeUi = await monthWindow.webContents.executeJavaScript(`(() => ({
      activePresetCount: document.querySelectorAll('.historical-note-move__presets .is-active').length,
      rangeText: document.querySelector('.historical-note-move__range .drp-trigger')?.textContent.trim()
    }))()`)
    assert.equal(customRangeUi.activePresetCount, 0, '手动范围不应继续标记某个快捷选项')
    assert.equal(
      customRangeUi.rangeText,
      `${dates.recentThirdDay} — ${dates.yesterday}`,
      '手动范围没有应用所选起止日期'
    )

    const visualQaDirectory = process.env.ABANDON_HISTORICAL_MOVE_VISUAL_QA_DIR
    if (visualQaDirectory) {
      mkdirSync(visualQaDirectory, { recursive: true })
      await waitUntil(
        () =>
          monthWindow.webContents.executeJavaScript(
            `!document.querySelector('.drp-panel') && Boolean(document.querySelector('[data-move-note-list]'))`
          ),
        '视觉检查前日期选择器没有完成收起'
      )
      await wait(160)
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
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await monthWindow.webContents.executeJavaScript(`(() => {
            const root = document.documentElement
            const surface = document.querySelector('.month-root')
            root.style.setProperty('--bg-color', '${scenario.background}')
            root.style.setProperty('--text-color', '${scenario.text}')
            root.style.setProperty('--window-opacity', '${scenario.name === 'complex' ? '0.78' : '1'}')
            surface.style.backgroundImage = '${scenario.image}'
            surface.style.backgroundSize = 'cover'
          })()`)
          await wait(80)
          const applied = await monthWindow.webContents.executeJavaScript(
            `document.documentElement.style.getPropertyValue('--bg-color').trim() === '${scenario.background}'`
          )
          if (applied) break
        }
        writeFileSync(
          join(visualQaDirectory, `historical-move-${scenario.name}.png`),
          (await monthWindow.capturePage()).toPNG()
        )
      }
    }

    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('[data-preset="all"]').click()`
    )
    await waitForPreview(monthWindow, 3, '全部历史')
    await monthWindow.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-note-id="${notes.recentId}"] input').click()
      document.querySelector('[data-note-id="${notes.oldId}"] input').click()
    })()`)
    const selectiveMoveUi = await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(`(() => {
          const selectedNoteIds = Array.from(
            document.querySelectorAll('.historical-note-move__note-option input:checked'),
            (input) => Number(input.closest('[data-note-id]').dataset.noteId)
          )
          const actionText = document.querySelector('[data-move-action]')?.textContent.trim() || ''
          return selectedNoteIds.length === 1 ? { selectedNoteIds, actionText } : null
        })()`),
      '逐条取消选择后，选择数量没有更新'
    )
    assert.deepEqual(selectiveMoveUi.selectedNoteIds, [notes.yesterdayId])
    assert.equal(selectiveMoveUi.actionText, '将 1 条未完成便签移至今天')

    await monthWindow.webContents.executeJavaScript(
      `document.querySelector('[data-move-action]').click()`
    )
    await waitUntil(
      () =>
        monthWindow.webContents.executeJavaScript(
          `!document.querySelector('.historical-note-move__panel') && window.api.getNote(${notes.yesterdayId}).then((note) => {
            const date = new Date(note.effective_at)
            const pad = (value) => String(value).padStart(2, '0')
            return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-') === '${dates.today}'
          })`
        ),
      '昨天的未完成便签没有移到今天'
    )
    const afterYesterdayMove = await monthWindow.webContents.executeJavaScript(`(async () => ({
      selectedDate: document.querySelector('.month-day-cell.is-selected')?.dataset.date,
      dayPanelOpen: Boolean(document.querySelector('.month-day-panel')),
      movedVisible: Boolean(document.querySelector('.month-event-bar[data-note-id="${notes.yesterdayId}"]')),
      completedEffectiveAt: (await window.api.getNote(${notes.completedId})).effective_at,
      recentEffectiveAt: (await window.api.getNote(${notes.recentId})).effective_at,
      oldEffectiveAt: (await window.api.getNote(${notes.oldId})).effective_at
    }))()`)
    assert.equal(afterYesterdayMove.selectedDate, dates.today, '移动后月视图应定位今天')
    assert.equal(afterYesterdayMove.dayPanelOpen, true, '移动后不应改变日期列表原有开关状态')
    assert.equal(afterYesterdayMove.movedVisible, true, '移动后的便签没有刷新到今天')
    assert.equal(
      afterYesterdayMove.completedEffectiveAt,
      notes.completedEffectiveAt,
      '已完成便签不应被移动'
    )
    assert.equal(
      afterYesterdayMove.recentEffectiveAt,
      timestamps.recentThirdDay,
      '未选便签不应被移动'
    )
    assert.equal(afterYesterdayMove.oldEffectiveAt, timestamps.old, '未选便签不应被移动')

    await chooseView(monthWindow, 'week')
    const weekWindow = await waitForView('week')
    await openMovePanel(weekWindow)
    await waitForPreview(weekWindow, 0, dates.yesterday)

    await weekWindow.webContents.executeJavaScript(
      `document.querySelector('[data-preset="recent3"]').click()`
    )
    const recentPreview = await waitForPreview(weekWindow, 1, dates.recentThirdDay)
    assert.equal(recentPreview.actionDisabled, false)
    assert.deepEqual(recentPreview.groups, [
      { dateKey: dates.recentThirdDay, notes: ['三天范围继续做'] }
    ])
    await weekWindow.webContents.executeJavaScript(
      `document.querySelector('[data-move-action]').click()`
    )
    await waitUntil(
      () =>
        weekWindow.webContents.executeJavaScript(
          `!document.querySelector('.historical-note-move__panel') && window.api.getNote(${notes.recentId}).then((note) => {
            const date = new Date(note.effective_at)
            const pad = (value) => String(value).padStart(2, '0')
            return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-') === '${dates.today}'
          })`
        ),
      '最近3天的未完成便签没有移到今天'
    )

    await openMovePanel(weekWindow)
    const reopenedPreset = await weekWindow.webContents.executeJavaScript(
      `document.querySelector('.historical-note-move__presets .is-active')?.dataset.preset`
    )
    assert.equal(reopenedPreset, 'yesterday', '重新打开后没有恢复默认“昨天”')
    await weekWindow.webContents.executeJavaScript(
      `document.querySelector('[data-preset="all"]').click()`
    )
    const allPreview = await waitForPreview(weekWindow, 1, '全部历史')
    assert.deepEqual(allPreview.groups, [{ dateKey: dates.old, notes: ['更早继续做'] }])
    const oldNoteDate = await weekWindow.webContents.executeJavaScript(
      `window.api.getNote(${notes.oldId}).then((note) => note.effective_at)`
    )
    assert.equal(oldNoteDate, timestamps.old, '只预览全部历史时不应提前移动便签')

    await closeMovePanel(weekWindow)
    const automaticNotes = await weekWindow.webContents.executeJavaScript(`(async () => {
      const ordinary = await window.api.createNote({ content: '自动移动普通便签', effectiveAt: ${timestamps.yesterday} })
      const multi = await window.api.createNote({ content: '自动移动排除跨日', effectiveAt: ${timestamps.yesterday}, durationDays: 2 })
      const recurring = await window.api.createNote({ content: '自动移动排除循环', effectiveAt: ${timestamps.yesterday} })
      return { ordinary: ordinary.id, multi: multi.id, recurring: recurring.id }
    })()`)
    // 模拟已生成且模板已删除的循环实例，验证永久来源标记也参与实际 IPC 移动筛选。
    const fixtureDb = new Database(join(testUserData, 'app.db'))
    fixtureDb
      .prepare('UPDATE notes SET from_template = 1 WHERE id = ?')
      .run(automaticNotes.recurring)
    fixtureDb.close()
    await openMovePanel(weekWindow)
    await waitForPreview(weekWindow, 3, dates.yesterday)
    assert.equal(
      await weekWindow.webContents.executeJavaScript(
        `document.querySelector('#automatic-note-move').getAttribute('aria-checked')`
      ),
      'false',
      '自动移动默认应关闭'
    )

    async function toggleAutomatic(viewWindow, enabled) {
      await waitUntil(
        () =>
          viewWindow.webContents.executeJavaScript(
            `Boolean(document.querySelector('#automatic-note-move')) && !document.querySelector('#automatic-note-move').disabled`
          ),
        '自动移动开关没有就绪'
      )
      await viewWindow.webContents.executeJavaScript(
        `document.querySelector('#automatic-note-move').click()`
      )
      await waitUntil(
        () =>
          viewWindow.webContents.executeJavaScript(`(async () => {
        const toggle = document.querySelector('#automatic-note-move')
        const settings = await window.api.getSettingsSnapshot()
        return toggle?.getAttribute('aria-checked') === '${enabled}' && !toggle.disabled && settings.values.notes.autoMoveYesterday === ${enabled}
      })()`),
        '自动移动开关没有保存'
      )
    }

    await toggleAutomatic(weekWindow, true)
    await wait(400)
    await waitForPreview(weekWindow, 2, dates.yesterday)
    const automaticResult = await weekWindow.webContents.executeJavaScript(`(async () => ({
      ordinary: (await window.api.getNote(${automaticNotes.ordinary})).effective_at,
      multi: (await window.api.getNote(${automaticNotes.multi})).effective_at,
      recurring: (await window.api.getNote(${automaticNotes.recurring})).effective_at
    }))()`)
    assert.equal(dateKey(new Date(automaticResult.ordinary)), dates.today)
    assert.equal(automaticResult.multi, timestamps.yesterday)
    assert.equal(automaticResult.recurring, timestamps.yesterday)
    await closeMovePanel(weekWindow)
    await chooseView(weekWindow, 'month')
    const returnedMonth = await waitForView('month')
    await openMovePanel(returnedMonth)
    await waitUntil(
      () =>
        returnedMonth.webContents.executeJavaScript(
          `document.querySelector('#automatic-note-move')?.getAttribute('aria-checked') === 'true'`
        ),
      '月视图没有继承周视图保存的自动移动开关'
    )
    await toggleAutomatic(returnedMonth, false)
    const lateNote = await returnedMonth.webContents.executeJavaScript(
      `window.api.createNote({ content: '关闭期间补录', effectiveAt: ${timestamps.yesterday} })`
    )
    // 唤醒会真正触发调度器；关闭时不可移动补录数据。
    const { powerMonitor } = await import('electron')
    powerMonitor.emit('resume')
    assert.equal(
      await returnedMonth.webContents.executeJavaScript(
        `window.api.getNote(${lateNote.id}).then(note => note.effective_at)`
      ),
      timestamps.yesterday
    )
    await toggleAutomatic(returnedMonth, true)
    assert.equal(
      dateKey(
        new Date(
          await returnedMonth.webContents.executeJavaScript(
            `window.api.getNote(${lateNote.id}).then(note => note.effective_at)`
          )
        )
      ),
      dates.today,
      '同日重新开启应补检查'
    )
    await wait(400)
    await waitForPreview(returnedMonth, 2, dates.yesterday)
    // 让每日检查尚未执行的状态进入真实唤醒链路。
    const resumedNote = await returnedMonth.webContents.executeJavaScript(
      `window.api.createNote({ content: '唤醒补检查', effectiveAt: ${timestamps.yesterday} })`
    )
    const resumeDb = new Database(join(testUserData, 'app.db'))
    resumeDb
      .prepare(
        "DELETE FROM app_settings WHERE window_name = 'application' AND key = 'auto_move_last_date'"
      )
      .run()
    resumeDb.close()
    powerMonitor.emit('resume')
    await waitUntil(
      () =>
        returnedMonth.webContents.executeJavaScript(
          `window.api.getNote(${resumedNote.id}).then(note => note.effective_at >= ${localDate(0, 0).getTime()})`
        ),
      '开启后的系统唤醒没有补检查'
    )
    await wait(400)
    await waitForPreview(returnedMonth, 2, dates.yesterday)
    if (visualQaDirectory) {
      await wait(320)
      writeFileSync(
        join(visualQaDirectory, 'automatic-move-enabled.png'),
        (await returnedMonth.capturePage()).toPNG()
      )
    }

    report(
      'month/week manual moves, automatic exclusions, immediate toggle, shared settings and resume passed'
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
    // Electron 退出时可能仍短暂占用隔离数据库，不覆盖测试结果。
  }
})
