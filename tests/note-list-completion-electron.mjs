import { readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'
import { dismissStartupShortcutNotice } from './helpers/startup-shortcut-notice.mjs'

const require = createRequire(import.meta.url)
const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/note-list-completion-electron.mjs',
  mode: 'electron-legacy-window-fixture',
  prefix: 'abandon-note-list-completion-',
  timeoutMs: 150000,
  metadata: { realWindows: true, productMainProcess: true, diskDatabase: true }
})
const { assert } = lifecycle
const profile = lifecycle.root
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const report = (message) => process.stderr.write(`[list-completion] ${message}\n`)

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
    await dismissStartupShortcutNotice(win)
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
    await expectUI(
      `document.querySelectorAll('.nl-timeline .nl-card').length === 16`,
      '默认展开首批应显示最近/置顶 6 条和更早 10 条'
    )
    assert.equal(
      await js(
        `document.querySelector('.nl-group-chevron').classList.contains('nl-group-chevron--collapsed')`
      ),
      false
    )
    const groupIds = (label) =>
      js(`(() => {
      const group = [...document.querySelectorAll('.nl-group')].find(g => g.querySelector('.nl-group-label')?.textContent === ${JSON.stringify(label)})
      return [...(group?.querySelectorAll('.nl-card') || [])].map(c => Number(c.dataset.noteId))
    })()`)
    const complete = async (id) => {
      await js(`document.querySelector('.nl-card[data-note-id="${id}"] .sr-control').click()`)
      await expectUI(
        `window.api.getNote(${id}).then(n => n.status === 'completed')`,
        '完成状态未持久化'
      )
      await wait(1250)
    }
    await complete(data.today)
    assert.deepEqual(await groupIds('今天'), [data.todayOther, data.todayDone, data.today])
    await complete(data.yesterday)
    assert.deepEqual(await groupIds('昨天'), [data.yesterdayOther, data.yesterday])
    assert.equal((await groupIds('今天')).includes(data.yesterday), false)
    await complete(data.pinned)
    assert.equal((await groupIds('今天')).at(-1), data.pinned)
    assert.deepEqual(await groupIds('置顶'), [])
    await js(
      `document.querySelector('.nl-card[data-note-id="${data.pinned}"] .sr-control').click()`
    )
    await until(async () => (await groupIds('置顶')).includes(data.pinned), '重新进行未恢复置顶')
    assert.equal(await js(`window.api.getNote(${data.pinned}).then(n => n.is_pinned)`), 1)
    report('PASS today/yesterday completion, existing completed order, pin restoration')

    await complete(data.old.at(-1))
    await expectUI(
      `!document.querySelector('.nl-timeline .nl-card[data-note-id="${data.old.at(-1)}"]')`,
      '更早完成项应移到未加载的组末尾'
    )
    const scrollMore = async (count) => {
      await js(
        `(() => { const el = document.querySelector('.nl-timeline'); el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); })()`
      )
      await expectUI(
        `document.querySelectorAll('.nl-timeline .nl-card').length === ${count}`,
        '滚动追加数量错误'
      )
    }
    await scrollMore(36)
    await scrollMore(41)
    assert.equal(
      await js(
        `Number([...document.querySelectorAll('.nl-timeline .nl-card')].at(-1)?.dataset.noteId)`
      ),
      data.old.at(-1)
    )
    assert.equal(
      await js(
        `new Set([...document.querySelectorAll('.nl-timeline .nl-card')].map(c => c.dataset.noteId)).size`
      ),
      41
    )
    await js(`document.querySelector('.nl-group-label-row--earlier').click()`)
    await expectUI(
      `document.querySelectorAll('.nl-timeline .nl-card').length === 6`,
      '收起更早未移除卡片'
    )
    await js(`document.querySelector('.nl-group-label-row--earlier').click()`)
    await expectUI(
      `document.querySelectorAll('.nl-timeline .nl-card').length === 16`,
      '重新展开未恢复首批 10 条'
    )
    report('PASS earlier default open, completion across pages, 10/20 pagination, collapse/reopen')

    await js(
      `window.api.setSettingValue('listFilter', { listMode: 'tag-group', tagIds: [], statusFilter: [] })`
    )
    await expectUI(`Boolean(document.querySelector('.nl-tag-group-toggle'))`, '标签模式未加载')
    await js(`document.querySelector('.nl-tag-group-toggle').click()`)
    const taggedIds = () =>
      js(
        `[...document.querySelectorAll('.nl-tag-groups .nl-card')].map(c => Number(c.dataset.noteId))`
      )
    await until(async () => (await taggedIds()).length === 10, '标签首批应为 10 条')
    await complete(data.todayOther)
    await until(
      async () => !(await taggedIds()).includes(data.todayOther),
      '标签完成项未移到整个组末尾'
    )
    for (const count of [30, 41]) {
      await js(`document.querySelector('.nl-tag-group-more').click()`)
      await until(async () => (await taggedIds()).length === count, '标签更多分页数量错误')
    }
    assert.equal((await taggedIds()).at(-1), data.todayOther)
    assert.equal(new Set(await taggedIds()).size, 41)
    await js(
      `document.querySelector('.nl-tag-groups .nl-card[data-note-id="${data.todayOther}"] .sr-control').click()`
    )
    await until(
      async () => (await taggedIds()).indexOf(data.todayOther) < 10,
      '标签重新进行未回到未完成区域'
    )
    await js(
      `window.api.setSettingValue('listFilter', { listMode: 'timeline', tagIds: [], statusFilter: ['in_progress'] })`
    )
    await expectUI(`Boolean(document.querySelector('.nl-timeline'))`, '未切回时间线')
    await complete(data.todayOther)
    await expectUI(
      `!document.querySelector('.nl-timeline .nl-card[data-note-id="${data.todayOther}"]')`,
      '状态筛选未移除已完成项'
    )
    report('PASS tag completion/reopen, whole-group pagination, status filtering')
    win.webContents.reload()
    await expectUI(
      `Boolean(document.querySelector('.nl-group-chevron')) && !document.querySelector('.nl-group-chevron--collapsed')`,
      '重载后更早应默认展开'
    )
    report('PASS reload; all completion-list UI checks passed')
    await verifyResetDuringModeExit(win)
    await verifyCalendarStatusViews(win)
    await lifecycle.finish({ completed: true, window: win })
  } catch (error) {
    if (win && !win.isDestroyed()) {
      report(
        await win.webContents.executeJavaScript(
          `document.querySelector('.note-list')?.innerText || document.body.innerText`
        )
      )
    }
    report(error?.stack || String(error))
    await lifecycle.finish({ error, window: win })
  }
}

async function verifyResetDuringModeExit(win) {
  const js = (code) => win.webContents.executeJavaScript(code)
  const expectUI = (code, message) => until(() => js(code), message)
  const trace = {
    scope: 'real mode button and paused production WAAPI departure; real settings reset'
  }
  try {
    await js(
      "window.api.setSettingValue('listFilter',{listMode:'timeline',tagIds:[],statusFilter:[]})"
    )
    await expectUI(
      "Boolean(document.querySelector('.nl-timeline .nl-card'))",
      'reset test needs visible cards'
    )
    await js("document.querySelector('.sg-root').dispatchEvent(new PointerEvent('pointerenter'))")
    await expectUI(
      "!document.querySelector('.nl-mode-toggle').disabled",
      'mode trigger did not expand'
    )
    await js("document.querySelector('.nl-mode-toggle').click()")
    await expectUI("Boolean(document.querySelector('.nl-mode-option'))", 'mode picker did not open')
    trace.departure = await js(`(() => {
      const original = Element.prototype.animate;
      window.__modeExitAnimations = [];
      Element.prototype.animate = function(frames, options) {
        const animation = original.call(this, frames, options);
        if (this.classList.contains('nl-card') && options?.duration === 160 && frames?.[1]?.opacity === 0) {
          animation.pause(); animation.currentTime = 80;
          window.__modeExitAnimations.push({animation, element:this});
        }
        return animation;
      };
      try {
        [...document.querySelectorAll('.nl-mode-option')].find(el=>el.textContent.trim()==='自定义').click();
      } finally { Element.prototype.animate = original; }
      return window.__modeExitAnimations.map(({animation,element})=>({
        id:animation.id, state:animation.playState, currentTime:animation.currentTime,
        opacity:Number(getComputedStyle(element).opacity)
      }));
    })()`)
    assert.ok(trace.departure.length > 0, 'the actual mode action starts visible card departure')
    assert.ok(
      trace.departure.every(
        (item) =>
          item.id === 'nl-presence-exit' &&
          item.state === 'paused' &&
          item.currentTime === 80 &&
          item.opacity > 0 &&
          item.opacity < 1
      ),
      'the real animation is held at an intermediate frame'
    )
    await js('document.querySelector(\'.titlebar-btn-settings[title="设置"]\').click()')
    await expectUI(
      "Boolean(document.querySelector('.settings-panel.active'))",
      'reset settings did not open'
    )
    await js(
      "[...document.querySelectorAll('.settings-panel.active button')].find(el=>el.textContent.trim()==='恢复默认设置').click()"
    )
    await expectUI(
      'Boolean(document.querySelector(\'.confirm-card.active[aria-label="恢复默认设置"]\'))',
      'reset confirmation did not open'
    )
    await js(
      "[...document.querySelectorAll('.confirm-card.active[aria-label=\"恢复默认设置\"] button')].find(el=>el.textContent.trim()==='恢复').click()"
    )
    await expectUI(
      "[...document.querySelectorAll('.msg-text')].some(el=>el.textContent==='已恢复默认设置'||el.textContent.startsWith('默认设置已保存'))",
      'reset did not report saved defaults'
    )
    trace.afterReset = await js(`(async () => ({
      mode:document.querySelector('.nl-mode-toggle').textContent.trim(),
      persisted:(await window.api.getSettingsSnapshot()).values.listFilter.listMode,
      animations:window.__modeExitAnimations.map(({animation})=>animation.playState)
    }))()`)
    assert.equal(trace.afterReset.mode, '时间线')
    assert.equal(trace.afterReset.persisted, 'timeline')
    assert.ok(
      trace.afterReset.animations.every((state) => state === 'idle'),
      'reset cancels the old paused departure'
    )
    await js("document.querySelector('.settings-panel.active .panel-close-btn').click()")
    await expectUI(
      "!document.querySelector('.settings-panel')",
      'reset settings did not finish leaving'
    )
    const notice = '[aria-label="欢迎使用 Abandon 便签"]'
    await expectUI(
      `Boolean(document.querySelector(${JSON.stringify(notice)}))`,
      'reset first-use notice did not open'
    )
    await js(`(() => {
      const dialog = document.querySelector(${JSON.stringify(notice)});
      const button = [...dialog.querySelectorAll('.app-modal-footer button')]
        .find(el => el.textContent.includes('已阅读') && !el.disabled);
      if (!button) throw new Error('First-use acknowledgment is unavailable');
      button.click();
    })()`)
    await expectUI(
      `!document.querySelector(${JSON.stringify(notice)}) && !document.querySelector('.app-scene')?.inert`,
      'reset first-use notice did not finish leaving and release the scene'
    )
    trace.firstUseAfterReset = await js(`(async () => ({
      noticeVersion:(await window.api.getSettingsSnapshot()).values.onboarding.noticeVersion,
      inert:document.querySelector('.app-scene').inert
    }))()`)
    assert.ok(trace.firstUseAfterReset.noticeVersion > 0, 'real acknowledgment was saved')
    assert.equal(trace.firstUseAfterReset.inert, false, 'reset scene is interactive again')
    assert.equal(
      await js("document.querySelector('.nl-mode-toggle').textContent.trim()"),
      '时间线',
      'old animation finally cannot restore custom mode'
    )
    assert.equal(
      await js('window.api.getSettingsSnapshot().then(s=>s.values.listFilter.listMode)'),
      'timeline'
    )
  } finally {
    await js('window.__modeExitAnimations?.forEach(({animation})=>animation.cancel())')
    writeFileSync(
      join(process.env.ABANDON_TEST_EVIDENCE_DIR || profile, 'sort-reset-trace.json'),
      JSON.stringify(trace, null, 2),
      { flag: 'wx' }
    )
  }
}

async function verifyCalendarStatusViews(win) {
  const js = (code) => win.webContents.executeJavaScript(code)
  const expectUI = (code, message) => until(() => js(code), message)
  const traces = []
  try {
    for (const mode of ['month', 'week']) {
      await globalThis.__ABANDON_WINDOW_TEST_HOOKS__.switchMainViewFromTray(mode)
      await until(
        () =>
          win.webContents.getURL().endsWith('/' + mode + '.html') &&
          js("Boolean(document.querySelector('.month-toolbar__day-panel-toggle:not(:disabled)'))"),
        mode + ' workspace did not become ready'
      )
      await dismissStartupShortcutNotice(win)
      await expectUI(
        "Boolean(document.querySelector('.month-scene')) && !document.querySelector('.month-scene').inert && !document.querySelector('[role=dialog]')",
        mode + ': a product modal still owns the calendar scene'
      )
      const note = await js(
        `window.api.createNote({content:${JSON.stringify('E6.2 ' + mode + ' status')},effectiveAt:Date.now()-1000})`
      )
      assert.ok(note?.id, mode + ': status note created')
      await expectUI(
        `Boolean(document.querySelector('.month-event-bar[data-note-id="${note.id}"]'))`,
        mode + ': note did not enter the calendar'
      )
      await js(
        "(()=>{const b=document.querySelector('.month-toolbar__day-panel-toggle');if(b.getAttribute('aria-expanded')!=='true')b.click()})()"
      )
      const card = `.month-day-panel .nl-card[data-note-id="${note.id}"]`
      await expectUI(
        `Boolean(document.querySelector(${JSON.stringify(card)}))`,
        mode + ': today card missing from day panel'
      )
      const interactions = []
      async function clickStatus(action) {
        const selector = JSON.stringify(card + ' .sr-control')
        await js(`document.querySelector(${selector}).scrollIntoView({block:'center'})`)
        const state = `(() => {
          const control = document.querySelector(${selector});
          const rect = control?.getBoundingClientRect();
          const hit = rect && document.elementFromPoint(rect.x + rect.width/2, rect.y + rect.height/2);
          return {
            inert:Boolean(control?.closest('[inert]')),
            enabled:Boolean(control && !control.disabled),
            hit:Boolean(hit && control.contains(hit)),
            visible:Boolean(rect?.width > 0 && rect?.height > 0)
          };
        })()`
        await expectUI(
          `(() => {const s = ${state}; return !s.inert && s.enabled && s.hit && s.visible})()`,
          mode + ': ' + action + ' control is not exposed to the user'
        )
        interactions.push({ action, ...(await js(state)) })
        assert.ok(
          interactions.at(-1).hit && !interactions.at(-1).inert,
          mode + ': ' + action + ' reaches the unobscured status control'
        )
        await js(`document.querySelector(${selector}).click()`)
      }
      await clickStatus('complete')
      await expectUI(
        `document.querySelector(${JSON.stringify(card)})?.classList.contains('nl-card--status-playing')`,
        mode + ': completion animation did not start'
      )
      await expectUI(
        `(()=>{const c=document.querySelector(${JSON.stringify(card)});return c?.classList.contains('nl-card--completed')&&!c.classList.contains('nl-card--status-playing')})()`,
        mode + ': completion did not finish'
      )
      const completed = await js(`window.api.getNote(${note.id})`)
      assert.equal(completed.status, 'completed', mode + ': completed status persisted')
      await clickStatus('reopen')
      await expectUI(
        `document.querySelector(${JSON.stringify(card)})?.classList.contains('nl-card--status-playing')`,
        mode + ': reopen animation did not start'
      )
      await expectUI(
        `(()=>{const c=document.querySelector(${JSON.stringify(card)});return c?.classList.contains('nl-card--in_progress')&&!c.classList.contains('nl-card--status-playing')})()`,
        mode + ': reopen did not finish'
      )
      const reopened = await js(`window.api.getNote(${note.id})`)
      assert.equal(reopened.status, 'in_progress', mode + ': reopened status persisted')
      assert.equal(
        reopened.effective_at,
        note.effective_at,
        mode + ': status action preserves effective time'
      )
      traces.push({
        mode,
        id: note.id,
        completed: completed.status,
        reopened: reopened.status,
        effectiveAt: reopened.effective_at,
        interactions
      })
    }
  } finally {
    writeFileSync(
      join(process.env.ABANDON_TEST_EVIDENCE_DIR || profile, 'calendar-status-traces.json'),
      JSON.stringify(traces, null, 2),
      { flag: 'wx' }
    )
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
  void lifecycle.finish({ error })
}
