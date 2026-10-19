import { readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const recorder = createAssertionRecorder({
  suite: 'tests/calendar-workspace-electron.mjs',
  mode: 'electron-ready-real-app-calendar-workspace',
  metadata: {
    realWindows: true,
    realDiskDatabase: true,
    sameDocumentProductionClear: true,
    simulatedWeatherAtIpc: true,
    nativePointerInput: false,
    mainProcessRestart: false
  }
})
const { assert } = recorder
const profile = prepareTestProfile({ prefix: 'abandon-note-calendar-workspace-' })
const userData = profile.directory
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const trace = []
const scenarios = []
const calendarLayouts = []
const gates = []
let rendererWeather = false
function hold(channel, transform = (data) => data) {
  let release
  const gate = { channel, transform, hit: false, released: false }
  gate.promise = new Promise((done) => {
    release = done
  })
  gate.release = () => {
    gate.released = true
    release()
  }
  gates.push(gate)
  return gate
}
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) =>
  originalHandle(channel, async (event, ...args) => {
    const relevant = [
      'calendar:get-month',
      'calendar:get-week',
      'get-settings-snapshot',
      'weather:get-forecast'
    ].includes(channel)
    if (relevant) trace.push({ channel, args, phase: 'start' })
    let result
    if (channel === 'weather:get-forecast') {
      result = {
        fetchedAt: Date.now(),
        timezone: 'Asia/Shanghai',
        days: [],
        location: { name: '模拟IPC天气' }
      }
    } else {
      result = await listener(event, ...args)
      if (channel === 'get-settings-snapshot' && rendererWeather) {
        result = {
          ...result,
          values: {
            ...result.values,
            weather: { enabled: true, location: { name: '模拟IPC地区' } }
          }
        }
      }
    }
    const gate = gates.find((entry) => entry.channel === channel && !entry.hit)
    if (gate) {
      gate.hit = true
      await gate.promise
      result = gate.transform(result)
    }
    if (relevant) trace.push({ channel, args, phase: 'complete' })
    return result
  })

let current,
  completed = false,
  failure = null,
  shuttingDown = false,
  reachedWillQuit = false,
  cleanupTimeout
let evidence = { status: 'incomplete' }
const cleanupErrors = []
async function until(predicate, message) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await predicate()) {
      assert.ok(true, message)
      return
    }
    await wait(30)
  }
  assert.fail(message)
}
const js = (source) => current.webContents.executeJavaScript(source)
const queryStarts = (channel) =>
  trace.filter((entry) => entry.channel === channel && entry.phase === 'start')
const stableCalendar = () =>
  js(
    "Boolean(document.querySelector('.month-day-cell')) && !document.querySelector('.month-toolbar')?.classList.contains('is-busy')"
  )
const clearWorkspace = () => js('window.__clearEditingDrafts()')
const rememberRoot = () =>
  js(
    "window.__calendarOldRoot=document.querySelector('.month-workspace'); window.__calendarOrigin=performance.timeOrigin; true"
  )
const newRootIsSameDocument = () =>
  js(
    "performance.timeOrigin===window.__calendarOrigin && !window.__calendarOldRoot.isConnected && document.querySelector('.month-workspace')!==window.__calendarOldRoot"
  )
function seedSettings() {
  const db = new Database(join(userData, 'app.db'))
  db.exec(
    `CREATE TABLE app_settings (window_name TEXT NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, value TEXT, remark TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER, PRIMARY KEY (window_name,key))`
  )
  const insert = db.prepare(
    'INSERT INTO app_settings (window_name,type,key,value) VALUES (?,?,?,?)'
  )
  insert.run('application', 'application', 'active_view', 'month')
  insert.run('application', 'remote', 'receive_notices', 'false')
  insert.run('application', 'remote', 'upload_device_info', 'false')
  insert.run('application', 'onboarding', 'first_use_notice_version', '1')
  for (const mode of ['month', 'week']) insert.run(mode, 'system', 'blur_enabled', 'false')
  db.close()
}
async function requestShutdown(error = null) {
  if (shuttingDown) return
  shuttingDown = true
  failure = error
  process.exitCode = error ? 1 : 0
  clearTimeout(testTimeout)
  for (const gate of gates) gate.release()
  try {
    const root = process.env.ABANDON_TEST_EVIDENCE_DIR || userData
    const summary = {
      completed,
      error: error?.stack || null,
      scenarios,
      calendarLayouts,
      trace,
      gates: gates.map(({ channel, hit, released }) => ({ channel, hit, released })),
      counts: recorder.report({ cleanup: { status: 'preserved' } }).assertions
    }
    if (current && !current.isDestroyed()) {
      let captureTimeout
      const screenshot = await Promise.race([
        current.webContents.capturePage(),
        new Promise((_, reject) => {
          captureTimeout = setTimeout(() => reject(new Error('Final screenshot timed out')), 3000)
        })
      ]).finally(() => clearTimeout(captureTimeout))
      const png = screenshot.toPNG()
      writeFileSync(join(root, 'calendar-workspace-final.png'), png, { flag: 'wx' })
      summary.screenshotSha256 = createHash('sha256').update(png).digest('hex')
    }
    writeFileSync(
      join(root, 'calendar-workspace-evidence.json'),
      JSON.stringify(summary, null, 2),
      { flag: 'wx' }
    )
    evidence = {
      status: 'complete',
      artifacts: [
        'calendar-workspace-evidence.json',
        ...readdirSync(root).filter(
          (name) => name.startsWith('calendar-layout-') && name.endsWith('.png')
        ),
        ...(summary.screenshotSha256 ? ['calendar-workspace-final.png'] : [])
      ],
      scope:
        'Actual windows/DB, production same-document clear; delayed responses and weather simulated at IPC'
    }
  } catch (captureError) {
    evidence = { status: 'failed', error: captureError.stack || captureError.message }
    process.exitCode = 1
  }
  cleanupTimeout = setTimeout(() => app.exit(1), 12000)
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed()) window.destroy()
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError.message)
      process.exitCode = 1
    }
  }
  app.quit()
}
app.once('will-quit', () => {
  reachedWillQuit = true
})
app.once('quit', (_event, code) => {
  clearTimeout(cleanupTimeout)
  const windowsClosed = BrowserWindow.getAllWindows().every((window) => window.isDestroyed())
  const cleanupComplete = reachedWillQuit && windowsClosed && cleanupErrors.length === 0
  try {
    recorder.finish({
      completed,
      error: failure,
      evidence,
      profileOwnership: profile.ownership,
      cleanup: {
        status:
          cleanupComplete && profile.ownership === 'runner'
            ? 'complete'
            : cleanupComplete
              ? 'preserved'
              : 'failed',
        reachedWillQuit,
        windowsClosed,
        errors: cleanupErrors,
        exitCode: code,
        preservedProfile: profile.ownership === 'script' || failure ? userData : undefined,
        scope:
          'Normal main before-quit/windows/process; runner removes its owned profile after exit'
      }
    })
  } catch (reportError) {
    console.error(reportError)
    process.exitCode = 1
  }
})

async function verifyCalendarLayout(mode) {
  const originalBounds = current.getBounds()
  const originalScale = await js(
    'window.api.getSettingsSnapshot().then(snapshot=>snapshot.values.appearance.uiScale)'
  )
  const readLayout = () =>
    js(`(() => {
    const canvas = document.querySelector('.month-workspace__calendar-body')
    const grid = canvas.querySelector('.month-grid')
    const rows = Array.from(grid.querySelectorAll('.month-week'))
    const rect = element => {
      const box = element.getBoundingClientRect()
      return { top: box.top, bottom: box.bottom, height: box.height }
    }
    const reference = document.createElement('div')
    reference.className = 'scroll-y'
    document.body.append(reference)
    const readScrollbar = element => {
      const style = getComputedStyle(element)
      const thumb = getComputedStyle(element, '::-webkit-scrollbar-thumb')
      return { width: style.scrollbarWidth, color: style.scrollbarColor,
        gutter: style.scrollbarGutter,
        drawnWidth: getComputedStyle(element, '::-webkit-scrollbar').width,
        thumbColor: thumb.backgroundColor, thumbRadius: thumb.borderTopLeftRadius,
        buttonDisplay: getComputedStyle(element, '::-webkit-scrollbar-button').display }
    }
    const scrollbar = readScrollbar(reference)
    reference.remove()
    return { clientHeight: canvas.clientHeight, scrollHeight: canvas.scrollHeight,
      scale: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      scrollbar: readScrollbar(canvas), sharedScrollbar: scrollbar,
      rows: rows.map(row => {
        const cell = row.querySelector('.month-day-cell')
        return { cell: rect(cell), header: rect(cell.querySelector('.month-day-cell__header')),
          footer: rect(cell.querySelector('.month-day-cell__quick-activate')) }
      }) }
  })()`)
  try {
    for (const scale of [0.9, 1, 1.5]) {
      await js(`window.api.setSettingValue('appearance.uiScale', ${scale})`)
      await until(
        () =>
          js(`Number.parseFloat(getComputedStyle(document.documentElement).fontSize) === ${scale}`),
        `${mode} UI scale ${scale} applied`
      )
      for (const height of [
        478,
        900,
        ...(mode === 'month' ? [300] : []),
        ...(scale === 1.5 ? [240] : [])
      ]) {
        current.setContentSize(1344, height)
        await wait(250)
        const layout = await readLayout()
        calendarLayouts.push({ mode, scale, requestedHeight: height, ...layout })
        if (mode === 'week') assert.equal(layout.rows.length, 1)
        else
          assert.ok([5, 6].includes(layout.rows.length), 'month uses its actual five or six rows')
        assert.deepEqual(layout.scrollbar, layout.sharedScrollbar, `${mode} uses shared scrollbar`)
        assert.equal(
          layout.scrollbar.width,
          'auto',
          `${mode} Chromium custom scrollbar remains enabled`
        )
        assert.equal(layout.scrollbar.drawnWidth, '6px', `${mode} scrollbar stays narrow`)
        assert.equal(layout.scrollbar.thumbRadius, '6px', `${mode} scrollbar thumb stays rounded`)
        assert.equal(
          layout.scrollbar.buttonDisplay,
          'none',
          `${mode} scrollbar has no native arrows`
        )
        assert.notEqual(
          layout.scrollbar.thumbColor,
          'rgba(0, 0, 0, 0)',
          `${mode} scrollbar uses theme colors`
        )
        for (const row of layout.rows) {
          assert.ok(row.header.top >= row.cell.top, `${mode} date header stays in its cell`)
          assert.ok(
            row.header.bottom <= row.footer.top + 0.5,
            `${mode} header/footer never overlap`
          )
          assert.ok(
            row.footer.bottom <= row.cell.bottom + 0.5,
            `${mode} create area stays in its cell`
          )
        }
        const overflows = layout.scrollHeight > layout.clientHeight + 1
        if (height !== 478 || mode === 'week' || scale === 1.5) {
          assert.equal(
            overflows,
            height === 240 || (mode === 'month' && height !== 900),
            `${mode} at ${height}px / ${scale} scrolls only when date rows do not fit`
          )
        }
        if (height === 240) {
          await js(`document.querySelector('.month-workspace__calendar-body').scrollTop = 10000`)
          const scrolled = await js(`(() => {
            const canvas = document.querySelector('.month-workspace__calendar-body')
            const footer = canvas.querySelector('.month-week:last-child .month-day-cell__quick-activate')
            return { top: canvas.scrollTop, footerBottom: footer.getBoundingClientRect().bottom,
              canvasBottom: canvas.getBoundingClientRect().bottom }
          })()`)
          assert.ok(scrolled.top > 0, `${mode} compact canvas remains scrollable`)
          assert.ok(
            scrolled.footerBottom <= scrolled.canvasBottom + 1,
            `${mode} last create area reachable`
          )
        }
        if (height === 478 && scale === 1) {
          const root = process.env.ABANDON_TEST_EVIDENCE_DIR || userData
          writeFileSync(
            join(root, `calendar-layout-${mode}-${layout.rows.length}-rows.png`),
            (await current.webContents.capturePage()).toPNG()
          )
        }
      }
    }
    scenarios.push(`${mode} actual window layout: 90/100/150 percent, tall/short, shared scrollbar`)
    await js("window.api.setSettingValue('appearance.uiScale', 1)")
    current.setContentSize(1344, 478)
    await wait(250)
    await js("document.querySelector('.month-workspace__calendar-body').scrollTop = 0")
    // 绘制背景仅用于视觉验收，不修改用户壁纸或日历组件。
    const originalTheme = await js(`(() => {
      const root = document.documentElement.style
      return { background: document.body.style.background,
        text: root.getPropertyValue('--text-color'), bg: root.getPropertyValue('--bg-color') }
    })()`)
    try {
      for (const [name, background, text, bg] of [
        ['white', '#fff', '#1d1d1f', '255 255 255'],
        ['black', '#000', '#f5f5f7', '0 0 0'],
        [
          'wallpaper',
          'linear-gradient(125deg, #ef9c90, #a8cbe8 45%, #efdfb9 70%, #b08598)',
          '#1d1d1f',
          '255 255 255'
        ]
      ]) {
        await js(`document.body.style.background = ${JSON.stringify(background)};
          document.documentElement.style.setProperty('--text-color', ${JSON.stringify(text)});
          document.documentElement.style.setProperty('--bg-color', ${JSON.stringify(bg)});`)
        await wait(100)
        const layout = await readLayout()
        assert.deepEqual(
          layout.scrollbar,
          layout.sharedScrollbar,
          `${mode} ${name} theme scrollbar`
        )
        const root = process.env.ABANDON_TEST_EVIDENCE_DIR || userData
        writeFileSync(
          join(root, `calendar-layout-${mode}-${layout.rows.length}-rows-${name}.png`),
          (await current.webContents.capturePage()).toPNG()
        )
      }
    } finally {
      await js(`document.body.style.background = ${JSON.stringify(originalTheme.background)};
        document.documentElement.style.setProperty('--text-color', ${JSON.stringify(originalTheme.text)});
        document.documentElement.style.setProperty('--bg-color', ${JSON.stringify(originalTheme.bg)});`)
    }
  } finally {
    await js(`window.api.setSettingValue('appearance.uiScale', ${originalScale})`)
    current.setBounds(originalBounds)
    await wait(250)
  }
}

async function run() {
  try {
    await until(
      () =>
        BrowserWindow.getAllWindows().some((window) =>
          /\/month\.html(?:$|[?#])/.test(window.webContents.getURL())
        ),
      'actual month window opened'
    )
    current = BrowserWindow.getAllWindows().find((window) =>
      /\/month\.html(?:$|[?#])/.test(window.webContents.getURL())
    )
    current.setSize(1050, 780)
    await until(stableCalendar, 'month calendar ready')
    await verifyCalendarLayout('month')
    const note = await js(
      "window.api.createNote({content:'Calendar workspace disk fixture',effectiveAt:Date.now()})"
    )
    await until(
      () => js(`Boolean(document.querySelector('.month-event-bar[data-note-id="${note.id}"]'))`),
      'created real calendar note visible'
    )
    const disk = new Database(join(userData, 'app.db'), { readonly: true })
    try {
      assert.equal(
        disk.prepare('SELECT content FROM notes WHERE id=?').get(note.id)?.content,
        'Calendar workspace disk fixture'
      )
    } finally {
      disk.close()
    }
    scenarios.push('actual month snapshot and disk-persisted note')

    const previousTitle = await js(
      "document.querySelector('.month-toolbar__title').getAttribute('title')"
    )
    const navigation = hold('calendar:get-month')
    trace.length = 0
    await js('document.querySelector(\'[aria-label="下个月"]\').click()')
    await until(() => navigation.hit, 'monthly navigation query pending')
    assert.equal(await js('document.querySelector(\'[aria-label="下个月"]\').disabled'), true)
    await js('document.querySelector(\'[aria-label="下个月"]\').click()')
    await wait(100)
    assert.equal(queryStarts('calendar:get-month').length, 1)
    navigation.release()
    await until(stableCalendar, 'monthly navigation settled')
    assert.notEqual(
      await js("document.querySelector('.month-toolbar__title').getAttribute('title')"),
      previousTitle
    )
    await verifyCalendarLayout('month')
    await js('document.querySelector(\'[aria-label="定位到今天"]\').click()')
    await until(stableCalendar, 'returned to current month')
    scenarios.push('month busy UI rejects another target')

    const preview = '.month-toolbar__recurring-preview-toggle'
    await js(`document.querySelector('${preview}').click()`)
    await until(
      () =>
        js(
          `document.querySelector('${preview}').getAttribute('aria-checked')==='true' && !document.querySelector('${preview}').disabled`
        ),
      'preview setting persisted and refreshed'
    )
    assert.ok(
      queryStarts('calendar:get-month').some(
        (entry) => entry.args[0].includeRecurringPreviews === true
      )
    )
    assert.equal(
      await js(
        'window.api.getSettingsSnapshot().then(snapshot=>snapshot.values.calendar.recurringPreviewEnabled)'
      ),
      true
    )
    scenarios.push('shared preview persistence and actual calendar IPC options')

    await rememberRoot()
    const staleCalendar = hold('calendar:get-month', (data) => ({
      ...data,
      notes: [...data.notes, { ...note, id: -999, content: 'STALE CALENDAR RESPONSE' }]
    }))
    trace.length = 0
    await clearWorkspace()
    await until(() => staleCalendar.hit, 'old remounted calendar query pending')
    await clearWorkspace()
    await until(stableCalendar, 'fresh same-document calendar ready')
    assert.equal(await newRootIsSameDocument(), true)
    assert.equal(queryStarts('calendar:get-month').length, 2)
    staleCalendar.release()
    await wait(250)
    assert.equal(await js("document.body.textContent.includes('STALE CALENDAR RESPONSE')"), false)
    assert.equal(queryStarts('calendar:get-month').length, 2)
    assert.equal(
      await js(`Boolean(document.querySelector('.month-event-bar[data-note-id="${note.id}"]'))`),
      true
    )
    scenarios.push('production same-document clear: delayed old calendar result')

    await rememberRoot()
    const staleSettings = hold('get-settings-snapshot')
    trace.length = 0
    await clearWorkspace()
    await until(() => staleSettings.hit, 'old remounted settings pending')
    await clearWorkspace()
    await until(stableCalendar, 'fresh calendar while old settings pending')
    assert.equal(await newRootIsSameDocument(), true)
    assert.equal(queryStarts('calendar:get-month').length, 1)
    staleSettings.release()
    await wait(250)
    assert.equal(queryStarts('calendar:get-month').length, 1)
    // A templates broadcast must produce one refresh, not a late old subscription.
    current.webContents.send('templates:changed', {})
    await until(
      () => queryStarts('calendar:get-month').length === 2,
      'one live templates subscription refreshed'
    )
    await until(stableCalendar, 'broadcast refresh settled')
    await wait(150)
    assert.equal(queryStarts('calendar:get-month').length, 2)
    scenarios.push(
      'production same-document clear: no query/subscription after delayed old settings'
    )

    rendererWeather = true
    const weather = hold('weather:get-forecast')
    trace.length = 0
    await clearWorkspace()
    await until(() => weather.hit, 'simulated weather IPC pending')
    await until(stableCalendar, 'local calendar ready before weather resolves')
    rendererWeather = false
    await clearWorkspace()
    await until(stableCalendar, 'new disabled-weather calendar ready')
    weather.release()
    await wait(150)
    assert.equal(await js("document.body.textContent.includes('模拟IPC天气')"), false)
    scenarios.push('simulated weather IPC cannot delay local ready or restore disposed weather')

    const monthOrigin = await js('performance.timeOrigin')
    await js("window.api.switchMainView('week')")
    await until(
      () =>
        BrowserWindow.getAllWindows().some((window) =>
          /\/week\.html(?:$|[?#])/.test(window.webContents.getURL())
        ),
      'actual week page loaded'
    )
    current = BrowserWindow.getAllWindows().find((window) =>
      /\/week\.html(?:$|[?#])/.test(window.webContents.getURL())
    )
    await until(stableCalendar, 'week calendar ready')
    await verifyCalendarLayout('week')
    assert.notEqual(await js('performance.timeOrigin'), monthOrigin)
    const beforeWeek = queryStarts('calendar:get-week').at(-1).args[0].anchorDate
    const weekNavigation = hold('calendar:get-week')
    trace.length = 0
    await js('document.querySelector(\'[aria-label="下一周"]\').click()')
    await until(() => weekNavigation.hit, 'first week query pending')
    await js(
      'document.querySelector(\'[aria-label="下一周"]\').click(); document.querySelector(\'[aria-label="下一周"]\').click()'
    )
    weekNavigation.release()
    await until(
      () => queryStarts('calendar:get-week').length === 2,
      'latest pending week query continued'
    )
    await until(stableCalendar, 'latest pending week settled')
    const expected = new Date(beforeWeek + 'T12:00:00')
    expected.setDate(expected.getDate() + 21)
    const expectedKey = `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, '0')}-${String(expected.getDate()).padStart(2, '0')}`
    assert.equal(queryStarts('calendar:get-week').at(-1).args[0].anchorDate, expectedKey)
    assert.ok(
      queryStarts('calendar:get-week').every(
        (entry) => entry.args[0].includeRecurringPreviews === true
      )
    )
    scenarios.push(
      'separate month-to-week navigation; week latest pending and shared preview choice'
    )
    completed = true
    await requestShutdown()
  } catch (error) {
    console.error(error)
    await requestShutdown(error)
  }
}
const testTimeout = setTimeout(
  () => void requestShutdown(new Error('Calendar workspace timed out')),
  90000
)
try {
  app.setPath('userData', userData)
  process.env.ABANDON_INTEGRATION_TEST = '1'
  process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
  process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
  seedSettings()
  const require = createRequire(import.meta.url)
  require(resolve('out/main/index.js'))
  const mainChunk = readdirSync(resolve('out/main/chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk)
  require(resolve('out/main/chunks', mainChunk))
  app.once('ready', () => void run())
} catch (error) {
  void requestShutdown(error)
}
