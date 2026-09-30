import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain } from 'electron'

const ipcTrace = []
let delayedTagId = null
let failTagOnce = null
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) =>
  originalHandle(channel, async (event, ...args) => {
    if (/^notes:(query-tag-groups|query-tag-group|count-active)$/.test(channel)) {
      ipcTrace.push({
        ms: Date.now(),
        channel,
        limit: args[0]?.limit,
        offset: args[0]?.offset,
        tagId: args[0]?.tagId
      })
    }
    if (channel === 'notes:query-tag-group') {
      if (args[0]?.tagId === delayedTagId) await wait(500)
      if (args[0]?.tagId === failTagOnce) {
        failTagOnce = null
        throw new Error('Injected tag snapshot failure')
      }
    }
    return listener(event, ...args)
  })

const require = createRequire(import.meta.url)
const profile = mkdtempSync(join(tmpdir(), 'abandon-note-tag-refresh-'))
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const report = (message) => process.stderr.write(`[tag-refresh] ${message}\n`)

async function until(predicate, message) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await wait(30)
  }
  throw new Error(message)
}

function listWindow() {
  return BrowserWindow.getAllWindows().find(
    (win) => !win.isDestroyed() && /\/index\.html(?:$|[?#])/.test(win.webContents.getURL())
  )
}

function seedSettings() {
  const db = new Database(join(profile, 'app.db'))
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

async function run() {
  let win
  try {
    await until(() => listWindow(), '列表窗口未启动')
    win = listWindow()
    win.setSize(600, 780)
    const js = (code) => win.webContents.executeJavaScript(code)
    const expectUI = (code, message) => until(() => js(code), message)
    await expectUI(`Boolean(document.querySelector('.nl-timeline'))`, '时间线未渲染')
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

    const secondary = await js(`(async () => {
      const tag = await window.api.createTag('另一个标签', '#54a865')
      for(let i=0;i<12;i++) {
        const n = await window.api.createNote({content:'第二组便签 ' + i})
        await window.api.setNoteTagIds(n.id, [tag.id])
      }
      return tag.id
    })()`)
    await js(
      "window.api.setSettingValue('listFilter', {listMode:'tag-group',tagIds:[],statusFilter:[]})"
    )
    await expectUI("Boolean(document.querySelector('.nl-tag-group-toggle'))", '标签模式未加载')
    await wait(600) // 等批量造数的变更通知及首次模式切换全部收敛后再分页。
    async function openAndLoadGroup(id, total) {
      await js('document.querySelector(\'[aria-controls="nl-tag-group-' + id + '"]\').click()')
      await expectUI(
        "document.querySelectorAll('#nl-tag-group-" + id + " .nl-card').length === 10",
        '标签首批未加载'
      )
      await wait(350)
      for (let count = 10; count < total; ) {
        count = Math.min(count + 20, total)
        await js("document.querySelector('#nl-tag-group-" + id + " .nl-tag-group-more').click()")
        await expectUI(
          "document.querySelectorAll('#nl-tag-group-" + id + " .nl-card').length === " + count,
          '标签后续分页未加载'
        )
      }
    }
    await openAndLoadGroup(data.tagId, 41)
    await openAndLoadGroup(secondary, 12)
    await wait(600)
    const results = []
    async function measure(name, scrollId, trigger, expectedCount = 53) {
      await js(
        scrollId
          ? 'document.querySelector(\'.nl-card[data-note-id="' + scrollId + '"]\').scrollIntoView()'
          : "document.querySelector('.nl-tag-groups').scrollTop = 0"
      )
      await wait(600)
      await js(`(() => {
        const list = document.querySelector('.nl-tag-groups')
        const initialCards = [...list.querySelectorAll('.nl-card')]
        const started = performance.now()
        const trace = { samples: [], animations: [], active: true }
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
        trace.stop = () => { trace.active = false; observer.disconnect(); Element.prototype.animate = original; return {samples:trace.samples, animations:trace.animations, retainedNodes:initialCards.every(node => node.isConnected)} }
      })()`)
      ipcTrace.length = 0
      const started = Date.now()
      await trigger()
      await wait(1900)
      const visual = await js('window.__jitterProbe.stop()')
      const requests = ipcTrace.map((item) => ({ ...item, ms: item.ms - started }))
      results.push({ name, requests, ...visual })
      writeFileSync(
        resolve('tmp/note-list-tag-refresh-evidence.json'),
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
        name + ': 刷新不能清空或截断卡片'
      )
      assert.ok(
        visual.samples.every((sample) => new Set(sample.ids).size === expectedCount),
        name + ': 不得重复卡片'
      )
      assert.ok(visual.retainedNodes, name + ': 已有卡片应保留 DOM 节点')
      const tops = visual.samples.map((sample) => sample.scrollTop)
      assert.ok(Math.max(...tops) - Math.min(...tops) <= 1, name + ': 滚动位置不应跳动')
      assert.equal(
        requests.filter((item) => item.channel === 'notes:query-tag-groups').length,
        1,
        name + ': 应合并为一次刷新'
      )
      assert.equal(
        visual.animations.filter((item) => item.frames?.[0]?.opacity === 0).length,
        0,
        name + ': 已有卡片不得重复入场'
      )
      assert.equal(
        new Set(visual.animations.map((item) => item.id)).size,
        visual.animations.length,
        name + ': 每张卡片至多一次移动动画'
      )
      return visual
    }
    await measure('tag-complete', data.old[30], () =>
      js(
        'document.querySelector(\'.nl-card[data-note-id="' +
          data.old[28] +
          '"] .sr-control\').click()'
      )
    )
    await measure('tag-reopen', data.old[30], () =>
      js(
        'document.querySelector(\'.nl-card[data-note-id="' +
          data.old[28] +
          '"] .sr-control\').click()'
      )
    )
    await measure('tag-complete-first-visible', data.old[29], () =>
      js(
        'document.querySelector(\'.nl-card[data-note-id="' +
          data.old[29] +
          '"] .sr-control\').click()'
      )
    )
    const contentEdit = await measure('tag-edit-completed', data.old[30], () =>
      js('window.api.updateNote(' + data.todayDone + ", {content:'仅改已完成正文'})")
    )
    assert.equal(contentEdit.animations.length, 0, '仅修改正文不应触发列表移动动画')
    delayedTagId = data.tagId
    await measure('tag-edit-slow-query', data.old[30], () =>
      js('window.api.updateNote(' + data.todayDone + ", {content:'慢查询改正文'})")
    )
    delayedTagId = null
    await js(`(async () => {
      const now = new Date()
      for(let i=0;i<100;i++) {
        const n = await window.api.createNote({content:'分页诊断 ' + i, effectiveAt:new Date(now.getFullYear(),now.getMonth(),now.getDate()-5,0,0,i).getTime()})
        await window.api.setNoteTagIds(n.id, [${data.tagId}])
      }
    })()`)
    await wait(800)
    for (const count of [61, 81, 101, 121, 141]) {
      await js(
        "document.querySelector('#nl-tag-group-" + data.tagId + " .nl-tag-group-more').click()"
      )
      await expectUI(
        "document.querySelectorAll('#nl-tag-group-" +
          data.tagId +
          " .nl-card').length === " +
          count,
        '长标签组加载数量不符'
      )
    }
    await measure(
      'tag-edit-over-100',
      data.old[30],
      () => js('window.api.updateNote(' + data.todayDone + ", {content:'长标签组改正文'})"),
      153
    )
    assert.equal(
      await js("document.querySelectorAll('#nl-tag-group-" + data.tagId + " .nl-card').length"),
      141
    )
    assert.deepEqual(
      ipcTrace
        .filter((item) => item.channel === 'notes:query-tag-group' && item.tagId === data.tagId)
        .map((item) => [item.limit, item.offset]),
      [
        [100, 0],
        [41, 100]
      ]
    )

    failTagOnce = secondary
    await measure(
      'tag-failed-snapshot-retains-cards',
      data.old[30],
      () => js('window.api.updateNote(' + data.todayDone + ", {content:'失败时保留旧卡片'})"),
      153
    )

    async function startDelayedRefresh(content) {
      delayedTagId = data.tagId
      ipcTrace.length = 0
      await js(
        'window.api.updateNote(' + data.todayDone + ', {content:' + JSON.stringify(content) + '})'
      )
      await until(
        () =>
          ipcTrace.some(
            (item) => item.channel === 'notes:query-tag-group' && item.tagId === data.tagId
          ),
        '未开始慢查询'
      )
    }
    await startDelayedRefresh('等待期间用户主动滚动')
    await js(
      'document.querySelector(\'.nl-card[data-note-id="' + data.old[24] + '"]\').scrollIntoView()'
    )
    const manuallyScrolledTop = await js("document.querySelector('.nl-tag-groups').scrollTop")
    await wait(1500)
    assert.equal(
      await js("document.querySelector('.nl-tag-groups').scrollTop"),
      manuallyScrolledTop,
      '刷新应保留等待期间的最新滚动位置'
    )

    await startDelayedRefresh('等待期间收起标签组')
    await js(
      'document.querySelector(\'[aria-controls="nl-tag-group-' + data.tagId + '"]\').click()'
    )
    await wait(1500)
    assert.equal(
      await js("Boolean(document.querySelector('#nl-tag-group-" + data.tagId + "'))"),
      false,
      '旧查询不得重新展开收起的标签组'
    )
    await js(
      'document.querySelector(\'[aria-controls="nl-tag-group-' + data.tagId + '"]\').click()'
    )
    await expectUI(
      "document.querySelectorAll('#nl-tag-group-" + data.tagId + " .nl-card').length > 0",
      '收起后仍可展开'
    )
    await wait(500)

    await startDelayedRefresh('刷新期间请求下一页')
    await js(
      "document.querySelector('#nl-tag-group-" + data.tagId + " .nl-tag-group-more').click()"
    )
    await wait(1500)
    assert.equal(
      await js("document.querySelectorAll('#nl-tag-group-" + data.tagId + " .nl-card').length"),
      120,
      '后台快照先返回也应保留仍在请求中的下一页'
    )

    await js('document.querySelector(\'[aria-controls="nl-tag-group-' + secondary + '"]\').click()')
    await startDelayedRefresh('清除收起组的旧分页缓存')
    await wait(1500)
    await startDelayedRefresh('刷新期间首次展开另一组')
    await js('document.querySelector(\'[aria-controls="nl-tag-group-' + secondary + '"]\').click()')
    await wait(1500)
    assert.equal(
      await js("document.querySelectorAll('#nl-tag-group-" + secondary + " .nl-card').length"),
      10,
      '后台刷新不得覆盖首次展开意图或清空刚加载的首批'
    )

    await js(
      'document.querySelector(\'.nl-card[data-note-id="' + data.old[30] + '"]\').scrollIntoView()'
    )
    await startDelayedRefresh('等待期间切换模式')
    await js(
      "window.api.setSettingValue('listFilter', {listMode:'timeline',tagIds:[],statusFilter:[]})"
    )
    await expectUI(
      "document.querySelectorAll('.nl-timeline .nl-card').length === 28",
      '时间线未恢复'
    )
    await js("document.querySelector('.nl-timeline').scrollTop = 0")
    await wait(1500)
    assert.equal(
      await js("document.querySelector('.nl-timeline').scrollTop"),
      0,
      '过期标签请求不得改变新模式滚动位置'
    )
    report(
      'PASS atomic tag refresh, completion anchor, >100 retention, failure, user scroll, collapse and mode cancellation'
    )
    app.exit(0)
  } catch (error) {
    if (win && !win.isDestroyed()) {
      report(
        await win.webContents.executeJavaScript(
          `document.querySelector('.note-list')?.innerText || document.body.innerText`
        )
      )
    }
    report(error?.stack || String(error))
    app.exit(1)
  }
}

try {
  app.setPath('userData', profile)
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
  app.exit(1)
}
