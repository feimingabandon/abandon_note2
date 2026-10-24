import { readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain } from 'electron'
import { dismissStartupShortcutNotice } from './helpers/startup-shortcut-notice.mjs'

const ipcTrace = []
let earlierDelayMs = 0
let failEarlierOnce = false
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) =>
  originalHandle(channel, async (event, ...args) => {
    if (/^notes:(query-pinned|query-recent|query-earlier|count-active)$/.test(channel)) {
      ipcTrace.push({ ms: Date.now(), channel, limit: args[0]?.limit, offset: args[0]?.offset })
    }
    if (channel === 'notes:query-earlier' && args[0]?.limit > 0) {
      await wait(earlierDelayMs)
      if (failEarlierOnce) {
        failEarlierOnce = false
        throw new Error('Injected earlier snapshot failure')
      }
    }
    return listener(event, ...args)
  })

const require = createRequire(import.meta.url)
const recorder = createAssertionRecorder({
  suite: 'tests/note-list-refresh-electron.mjs',
  mode: 'electron-ready-real-app-list-refresh',
  metadata: {
    realWindows: true,
    realDiskDatabase: true,
    delayedAndFailedIPC: true,
    mainProcessRestart: false
  }
})
const { assert } = recorder
const profile = prepareTestProfile({ prefix: 'abandon-note-list-refresh-' })
const userData = profile.directory
let current,
  completed = false,
  failure = null,
  shuttingDown = false,
  reachedWillQuit = false,
  cleanupTimeout = null
let evidence = { status: 'incomplete' }
const cleanupErrors = [],
  verifiedScenarios = []
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const report = (message) => process.stderr.write(`[list-refresh] ${message}\n`)

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

function listWindow() {
  return BrowserWindow.getAllWindows().find(
    (win) => !win.isDestroyed() && /\/index\.html(?:$|[?#])/.test(win.webContents.getURL())
  )
}

function seedSettings() {
  const db = new Database(join(userData, 'app.db'))
  db.exec(`CREATE TABLE app_settings (
    window_name TEXT NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
    remark TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER,
    PRIMARY KEY (window_name, key)
  )`)
  const insert = db.prepare(
    'INSERT INTO app_settings (window_name, type, key, value) VALUES (?, ?, ?, ?)'
  )
  insert.run('application', 'application', 'active_view', 'list')
  insert.run('application', 'remote', 'receive_notices', 'false')
  insert.run('application', 'remote', 'upload_device_info', 'false')
  insert.run('application', 'onboarding', 'first_use_notice_version', '1')
  insert.run('main', 'system', 'blur_enabled', 'false')
  db.close()
}

async function requestShutdown(error = null) {
  if (shuttingDown) return
  shuttingDown = true
  failure = error
  process.exitCode = error ? 1 : 0
  clearTimeout(testTimeout)
  try {
    const root = process.env.ABANDON_TEST_EVIDENCE_DIR || userData
    const summary = {
      completed,
      error: error?.stack || null,
      scope:
        'Timeline refresh, retained DOM/scroll, history paging, failures, collapse and mode cancellation',
      ipcTrace,
      verifiedScenarios,
      counts: recorder.report({ cleanup: { status: 'preserved' } }).assertions
    }
    if (current && !current.isDestroyed()) {
      summary.finalUrl = current.webContents.getURL()
      let captureTimeout
      const image = await Promise.race([
        current.webContents.capturePage(),
        new Promise((_, reject) => {
          captureTimeout = setTimeout(() => reject(new Error('Final screenshot timed out')), 3000)
        })
      ]).finally(() => clearTimeout(captureTimeout))
      const png = image.toPNG()
      writeFileSync(join(root, 'note-list-refresh-final.png'), png, { flag: 'wx' })
      summary.screenshotSha256 = createHash('sha256').update(png).digest('hex')
    }
    writeFileSync(join(root, 'note-list-refresh-evidence.json'), JSON.stringify(summary, null, 2), {
      flag: 'wx'
    })
    evidence = {
      status: 'complete',
      artifacts: [
        'note-list-refresh-evidence.json',
        ...(summary.screenshotSha256 ? ['note-list-refresh-final.png'] : [])
      ],
      scope: 'GUI assertions and final screenshot; product logger closes through real quit'
    }
  } catch (captureError) {
    evidence = { status: 'failed', error: captureError.stack || captureError.message }
    process.exitCode = 1
  }
  // Clear only these test windows; main's normal before-quit still disposes services/DB/native.
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
        scope: 'Main before-quit, windows and process; runner removes owned profile after exit'
      }
    })
  } catch (reportError) {
    console.error(reportError)
    process.exitCode = 1
  }
})

async function run() {
  let win
  try {
    await until(() => listWindow(), '列表窗口未启动')
    win = current = listWindow()
    win.setSize(600, 780)
    const js = (code) => win.webContents.executeJavaScript(code)
    const expectUI = (code, message) => until(() => js(code), message)
    await expectUI(`Boolean(document.querySelector('.nl-timeline'))`, '时间线未渲染')
    await dismissStartupShortcutNotice(win)
    await expectUI("!document.querySelector('.app-scene').inert", '启动场景仍被模态占用')
    const data = await js(`(async () => {
      const now = new Date()
      const at = (days, seconds) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 0, 0, seconds).getTime()
      const tag = await window.api.createTag('完成排序测试', '#3984db')
      const add = async (content, day, seconds, pinned = false) => {
        const note = await window.api.createNote({ content, effectiveAt: at(day, seconds), isPinned: pinned ? 1 : 0 })
        await window.api.setNoteTagIds(note.id, [tag.id])
        return note.id
      }
      const todayDone = await add('今天已完成', 0, 0)
      await window.api.completeNote(todayDone)
      const today = await add('今天待完成', 0, 2)
      const todayOther = await add('今天保留进行中', 0, 1)
      const yesterday = await add('昨天待完成', -1, 2)
      const yesterdayOther = await add('昨天保留进行中', -1, 1)
      const pinned = await add('置顶待完成', 0, 3, true)
      const old = []
      for (let i = 0; i < 35; i++) old.push(await add('更早分页 ' + i, -4, i))
      return { tagId: tag.id, todayDone, today, todayOther, yesterday, yesterdayOther, pinned, old }
    })()`)

    win.webContents.reload()
    await expectUI("document.querySelectorAll('.nl-timeline .nl-card').length === 16", '首批未加载')
    await dismissStartupShortcutNotice(win)
    await expectUI("!document.querySelector('.app-scene').inert", '重载场景仍被模态占用')
    for (const count of [36, 41]) {
      await js(
        "(() => { const el = document.querySelector('.nl-timeline'); el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); })()"
      )
      await expectUI(
        "document.querySelectorAll('.nl-timeline .nl-card').length === " + count,
        '分页未加载'
      )
    }
    await wait(600)
    const results = []
    async function measure(name, scrollId, trigger, expectedCount = 41) {
      await expectUI("!document.querySelector('.app-scene').inert", name + ': 场景不可交互')
      await js(
        scrollId
          ? 'document.querySelector(\'.nl-card[data-note-id="' + scrollId + '"]\').scrollIntoView()'
          : "document.querySelector('.nl-timeline').scrollTop = 0"
      )
      await wait(600)
      await js(`(() => {
        const list = document.querySelector('.nl-timeline')
        const started = performance.now()
        const trace = { samples: [], animations: [], active: true }
        const initialCards = [...list.querySelectorAll('.nl-card')]
        window.__jitterProbe = trace
        let last = ''
        function sample(kind) {
          const ids = [...list.querySelectorAll('.nl-card')].map(c => Number(c.dataset.noteId))
          const value = { kind, ms: Math.round(performance.now() - started), count: ids.length, scrollTop: Math.round(list.scrollTop), height: list.scrollHeight, ids }
          const key = JSON.stringify([ids, value.scrollTop, value.height])
          if (last !== key) { trace.samples.push(value); last = key }
        }
        const original = Element.prototype.animate
        Element.prototype.animate = function(frames, options) {
          if (this.matches('.nl-card[data-note-id]')) {
            trace.animations.push({ms: Math.round(performance.now()-started), id: Number(this.dataset.noteId), frames, options})
          }
          return original.call(this, frames, options)
        }
        const observer = new MutationObserver(() => sample('mutation'))
        observer.observe(list, {childList:true, subtree:true})
        function frame() { if (trace.active) { sample('frame'); requestAnimationFrame(frame) } }
        sample('start')
        requestAnimationFrame(frame)
        trace.stop = () => {
          trace.active = false
          observer.disconnect()
          Element.prototype.animate = original
          return {samples:trace.samples, animations:trace.animations, retainedNodes:initialCards.every(node => node.isConnected)}
        }
      })()`)
      ipcTrace.length = 0
      const started = Date.now()
      await trigger()
      await wait(2400)
      const visual = await js('window.__jitterProbe.stop()')
      const requests = ipcTrace.map((item) => ({ ...item, ms: item.ms - started }))
      results.push({ name, requests, ...visual })
      writeFileSync(
        resolve('tmp/note-list-refresh-evidence.json'),
        JSON.stringify(results, null, 2)
      )
      report(
        JSON.stringify({
          name,
          queries: requests,
          samples: visual.samples.map(({ kind, ms, count, scrollTop, height }) => ({
            kind,
            ms,
            count,
            scrollTop,
            height
          })),
          animationCalls: visual.animations.length,
          entryAnimations: visual.animations.filter((a) => a.frames?.[0]?.opacity === 0).length,
          movementAnimations: visual.animations.filter((a) => a.frames?.[0]?.opacity === undefined)
            .length
        })
      )
      assert.ok(
        visual.samples.every((sample) => sample.count === expectedCount),
        name + ': 刷新中不能清空历史卡片'
      )
      assert.ok(
        visual.samples.every((sample) => new Set(sample.ids).size === expectedCount),
        name + ': 分页不能产生重复卡片'
      )
      assert.ok(visual.retainedNodes, name + ': 历史卡片应保留原 DOM 节点')
      const tops = visual.samples.map((sample) => sample.scrollTop)
      assert.ok(Math.max(...tops) - Math.min(...tops) <= 1, name + ': 滚动位置不应跳动')
      assert.equal(
        requests.filter((item) => item.channel === 'notes:query-pinned').length,
        1,
        name + ': 本地回调与广播应合并为一次刷新'
      )
      assert.equal(
        visual.animations.filter((item) => item.frames?.[0]?.opacity === 0).length,
        0,
        name + ': 已存在卡片不得重新播放入场'
      )
      const animationIds = visual.animations.map((item) => item.id)
      assert.equal(
        new Set(animationIds).size,
        animationIds.length,
        name + ': 每张卡片至多执行一次移动动画'
      )
      return visual
    }
    await measure('complete-today', null, () =>
      js(
        'document.querySelector(\'.nl-card[data-note-id="' +
          data.today +
          '"] .sr-control\').click()'
      )
    )
    await measure('complete-first-visible-earlier', data.old[28], () =>
      js(
        'document.querySelector(\'.nl-card[data-note-id="' +
          data.old[28] +
          '"] .sr-control\').click()'
      )
    )
    await measure('edit-completed-earlier', data.old[30], () =>
      js('window.api.updateNote(' + data.old[28] + ", {content:'仅修改更早的已完成便签正文'})")
    )
    // 完成/重新进行置顶项时，慢查询期间也不能先换组、随后再排序。
    earlierDelayMs = 500
    const pinnedGroup = () =>
      js(
        `document.querySelector('.nl-card[data-note-id="${data.pinned}"]')?.closest('.nl-group')?.querySelector('.nl-group-label')?.textContent`
      )
    for (const [from, to] of [
      ['置顶', '今天'],
      ['今天', '置顶']
    ]) {
      ipcTrace.length = 0
      await js(
        `document.querySelector('.nl-card[data-note-id="${data.pinned}"] .sr-control').click()`
      )
      await until(
        () => ipcTrace.some((item) => item.channel === 'notes:query-earlier' && item.limit > 0),
        '置顶状态未请求新快照'
      )
      assert.equal(await pinnedGroup(), from, '快照就绪前不应提前换组')
      await until(async () => (await pinnedGroup()) === to, '快照就绪后应完成换组')
      await wait(400)
      assert.equal(ipcTrace.filter((item) => item.channel === 'notes:query-pinned').length, 1)
    }
    earlierDelayMs = 250
    await measure('concurrent-completions-slow-query', data.old[30], () =>
      js(`(() => {
      for (const id of ${JSON.stringify([data.old[27], data.old[26]])}) document.querySelector('.nl-card[data-note-id="' + id + '"] .sr-control').click()
    })()`)
    )
    await js(`(async () => {
      const now = new Date()
      for (let i = 0; i < 100; i++) await window.api.createNote({content:'额外历史 ' + i, effectiveAt:new Date(now.getFullYear(), now.getMonth(), now.getDate()-5, 0, 0, i).getTime()})
    })()`)
    await wait(800)
    for (const count of [61, 81, 101, 121, 141]) {
      await js(
        "(() => { const el = document.querySelector('.nl-timeline'); el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); })()"
      )
      await expectUI(
        "document.querySelectorAll('.nl-timeline .nl-card').length === " + count,
        '长列表分页未加载'
      )
    }
    await measure(
      'refresh-over-100-loaded',
      data.old[30],
      () => js(`window.api.updateNote(${data.old[28]}, {content:'长列表刷新仍保留原范围'})`),
      141
    )
    failEarlierOnce = true
    await measure(
      'failed-snapshot-retains-cards',
      data.old[30],
      () => js(`window.api.updateNote(${data.old[28]}, {content:'查询失败后保留已有界面'})`),
      141
    )
    earlierDelayMs = 500
    ipcTrace.length = 0
    await js(`window.api.updateNote(${data.old[28]}, {content:'查询中主动收起'})`)
    await until(
      () => ipcTrace.some((item) => item.channel === 'notes:query-earlier' && item.limit > 0),
      '未进入历史查询'
    )
    await js("document.querySelector('.nl-group-label-row--earlier').click()")
    await wait(800)
    await expectUI(
      "document.querySelectorAll('.nl-timeline .nl-card').length === 6 && Boolean(document.querySelector('.nl-group-chevron--collapsed'))",
      '过期响应不应重新展开历史分组'
    )
    await js("document.querySelector('.nl-group-label-row--earlier').click()")
    await expectUI(
      "document.querySelectorAll('.nl-timeline .nl-card').length === 16",
      '收起后应可重新展开首批'
    )
    ipcTrace.length = 0
    await js(`window.api.updateNote(${data.old[28]}, {content:'查询中切换模式'})`)
    await until(
      () => ipcTrace.some((item) => item.channel === 'notes:query-earlier' && item.limit > 0),
      '未进入切换前查询'
    )
    await js(
      "window.api.setSettingValue('listFilter', {listMode:'custom', tagIds:[], statusFilter:[]})"
    )
    await wait(800)
    await expectUI(
      "Boolean(document.querySelector('.nl-custom')) && !document.querySelector('.nl-timeline')",
      '过期查询不能覆盖新模式'
    )
    await js(
      "window.api.setSettingValue('listFilter', {listMode:'timeline', tagIds:[], statusFilter:[]})"
    )
    const todayCard = `.nl-card[data-note-id="${data.today}"]`
    await expectUI(
      `document.querySelector('${todayCard}')?.closest('.nl-group')?.querySelector('.nl-group-label')?.textContent.trim() === '今天'`,
      '跨午夜验证前应恢复今天分组'
    )
    await wait(800)
    ipcTrace.length = 0
    // Change only the renderer wall clock, then use the real visibility wake-up
    // path. No note mutation, explicit reload, or direct component refresh.
    try {
      await js(`(() => {
        window.__realDateForMidnightTest = window.Date
        const RealDate = window.Date
        const now = new RealDate()
        const nextDay = new RealDate(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 1).getTime()
        window.Date = class extends RealDate {
          constructor(...args) { super(...(args.length ? args : [nextDay])) }
          static now() { return nextDay }
        }
        document.dispatchEvent(new Event('visibilitychange'))
      })()`)
      await expectUI(
        `document.querySelector('${todayCard}')?.closest('.nl-group')?.querySelector('.nl-group-label')?.textContent.trim() === '昨天'`,
        '跨午夜应自动将今天便签移入昨天分组'
      )
      await expectUI(
        `Array.from(document.querySelectorAll('${todayCard} .nl-card-time')).length === 2 && Array.from(document.querySelectorAll('${todayCard} .nl-card-time')).every(node => node.textContent.includes('昨天'))`,
        '跨午夜应同时更新普通卡片的生效及完成时间'
      )
      assert.ok(
        ipcTrace.some((item) => item.channel === 'notes:query-recent'),
        '日期变化应通过真实 IPC 自动刷新查询边界'
      )
      const ids = await js(
        "Array.from(document.querySelectorAll('.nl-timeline .nl-card'), node => node.dataset.noteId)"
      )
      assert.equal(new Set(ids).size, ids.length, '跨午夜刷新不能重复便签')
      verifiedScenarios.push('automatic-midnight-timeline-and-card-label-refresh')
    } finally {
      await js(`(() => {
        window.Date = window.__realDateForMidnightTest || window.Date
        delete window.__realDateForMidnightTest
        document.dispatchEvent(new Event('visibilitychange'))
      })()`)
    }
    report(
      'PASS stable card/scroll lifecycle, one refresh/animation, slow queries, concurrent completion, >100 retention, failure/collapse/mode cancellation, automatic midnight refresh'
    )
    assert.ok(
      await js(
        "!document.querySelector('.app-scene').inert && !document.querySelector('[role=dialog]')"
      ),
      '最终刷新场景可交互且未被模态遮挡'
    )
    completed = true
    await requestShutdown()
  } catch (error) {
    if (win && !win.isDestroyed()) {
      report(
        await win.webContents.executeJavaScript(
          `document.querySelector('.note-list')?.innerText || document.body.innerText`
        )
      )
    }
    report(error?.stack || String(error))
    await requestShutdown(error)
  }
}

const testTimeout = setTimeout(() => {
  void requestShutdown(new Error('List refresh timed out'))
}, 150000)

try {
  app.setPath('userData', userData)
  process.env.ABANDON_INTEGRATION_TEST = '1'
  process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
  process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
  seedSettings()
  require(resolve('out/main/index.js'))
  const mainChunk = readdirSync(resolve('out/main/chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(mainChunk, '缺少主进程构建')
  require(resolve('out/main/chunks', mainChunk))
  app.once('ready', () => void run())
} catch (error) {
  report(error?.stack || String(error))
  void requestShutdown(error)
}
