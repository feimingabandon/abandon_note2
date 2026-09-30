import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'

const root = mkdtempSync(join(tmpdir(), 'abandon-reminders-e2e-'))
const evidence = resolve('docs/testing/evidence/note-reminders')
mkdirSync(evidence, { recursive: true })
app.setPath('userData', root)
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
const seed = new Database(join(root, 'app.db'))
seed.exec(`CREATE TABLE app_settings (window_name TEXT NOT NULL,type TEXT NOT NULL,key TEXT NOT NULL,
  value TEXT,remark TEXT DEFAULT '',created_at INTEGER,updated_at INTEGER,PRIMARY KEY(window_name,key));`)
const put = seed.prepare('INSERT INTO app_settings(window_name,type,key,value) VALUES (?,?,?,?)')
for (const row of [
  ['application', 'application', 'active_view', 'list'],
  ['application', 'remote', 'receive_notices', 'false'],
  ['application', 'remote', 'upload_device_info', 'false'],
  ['application', 'onboarding', 'first_use_notice_version', '1'],
  ...['main', 'month', 'week'].map((scope) => [scope, 'system', 'blur_enabled', 'false'])
])
  put.run(...row)
seed.close()

const wait = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(fn, label) {
  const end = Date.now() + 15000
  while (Date.now() < end) {
    const result = await fn()
    if (result) return result
    await wait(40)
  }
  throw new Error('Timed out: ' + label)
}
const report = (s) => process.stdout.write('[reminders-e2e] ' + s + '\n')
let main, db
const js = (code) =>
  main.webContents.executeJavaScript(code).catch((error) => {
    throw new Error(`${error.message}\nScript: ${code}`)
  })
const readNote = (id) => js(`window.api.getNote(${id})`)
async function setDateTime(window, selector, timestamp) {
  const run = (code) => window.webContents.executeJavaScript(code)
  const date = new Date(timestamp)
  const pad = (n) => String(n).padStart(2, '0')
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  await run(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await until(() => run('!!document.querySelector(".dt-panel-wrap")'), 'date picker opens')
  for (const [placeholder, value] of [
    ['YYYY-MM-DD', day],
    ['HH:mm:ss', time]
  ]) {
    await run(
      `(() => { const input = document.querySelector('input[placeholder="${placeholder}"]'); input.focus(); input.value=${JSON.stringify(value)}; input.dispatchEvent(new Event('input',{bubbles:true})); input.blur(); })()`
    )
  }
  await run('document.querySelector(".dt-btn--confirm").click()')
  await until(() => run('!document.querySelector(".dt-panel-wrap")'), 'date picker confirms')
}
async function setChannels(window, selector, mask) {
  const run = (code) =>
    window.webContents.executeJavaScript(code).catch((error) => {
      throw new Error(`${error.message}\nChannel script: ${code}`)
    })
  await run(`(() => {
    window.__channelInputTrace = [];
    if(window.__channelInputTraceInstalled) return;
    window.__channelInputTraceInstalled=true;
    for(const type of ['scroll','focusin','pointerdown']) document.addEventListener(type,event=>{
      window.__channelInputTrace.push({type,target:event.target.className || event.target.nodeName,expanded:document.querySelector('.app-editor-dialog .reminder-channels__trigger')?.getAttribute('aria-expanded')});
      if(window.__channelInputTrace.length>15) window.__channelInputTrace.shift();
    },true);
  })()`)
  const trigger = selector + ' .reminder-channels__trigger'
  await run(`document.querySelector(${JSON.stringify(trigger)}).scrollIntoView({block:'center'})`)
  await wait(250)
  await clickVisible(window, trigger)
  await until(() => run('!!document.querySelector(".reminder-channels__panel")'), 'channel menu')
  await wait(250)
  for (const bit of [1, 2, 4]) {
    const option = `.reminder-channels__option[data-channel="${bit}"]`
    const checked = await run(
      `document.querySelector(${JSON.stringify(option)}).getAttribute('aria-checked') === 'true'`
    )
    if (checked !== Boolean(mask & bit)) await clickVisible(window, option)
    assert.equal(
      await run(`document.querySelector(${JSON.stringify(option)}).getAttribute('aria-checked')`),
      String(Boolean(mask & bit)),
      JSON.stringify(await run('window.__channelInputTrace'))
    )
  }
  assert.equal(
    await run(`document.querySelector(${JSON.stringify(trigger)}).getAttribute('aria-expanded')`),
    'true',
    'multi-select stays open'
  )
  pressKey(window, 'Escape')
  await until(() => run('!document.querySelector(".reminder-channels__panel")'), 'menu closes')
  assert.equal(
    await run(`document.activeElement === document.querySelector(${JSON.stringify(trigger)})`),
    true,
    'Escape restores focus'
  )
}
async function clickVisible(window, selector) {
  let point
  try {
    await until(async () => {
      point = await window.webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return {clickable:false,error:'Missing control'};
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
    const hit=document.elementFromPoint(x,y);
    return {x,y,clickable:x>=0 && y>=0 && x<innerWidth && y<innerHeight && element.contains(hit),hit:hit?.outerHTML.slice(0,700),rect:rect.toJSON(),panel:document.querySelector('.reminder-channels__panel')?.getBoundingClientRect().toJSON(),background:getComputedStyle(element.closest('.reminder-channels__panel') || element).backgroundColor,trace:window.__channelInputTrace};
      })()`)
      return point.clickable
    }, 'clickable control: ' + selector)
  } catch {
    writeFileSync(
      join(evidence, 'channels-click-failure.png'),
      (await window.webContents.capturePage()).toPNG()
    )
    throw new Error('Control not clickable: ' + selector + ' ' + JSON.stringify(point))
  }
  const coordinates = { x: point.x, y: point.y }
  window.webContents.sendInputEvent({ type: 'mouseMove', ...coordinates })
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...coordinates
  })
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...coordinates
  })
  await wait(60)
}
function pressKey(window, keyCode, modifiers = []) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  if (keyCode === 'Return')
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
}
async function checkChannelMenu(window) {
  const run = (code) => window.webContents.executeJavaScript(code)
  const trigger = '.nnp-root .reminder-channels__trigger'
  const closed = () =>
    until(() => run('!document.querySelector(".reminder-channels__panel")'), 'channel menu closes')
  // Native key events must change focus/selection without closing the parent form.
  pressKey(window, 'Up')
  await until(() => run('document.activeElement?.dataset.channel === "4"'), 'Up opens on last item')
  pressKey(window, 'Home')
  await until(
    () => run('document.activeElement?.dataset.channel === "1"'),
    'Home selects first item'
  )
  pressKey(window, 'Down')
  await until(() => run('document.activeElement?.dataset.channel === "2"'), 'Down moves one item')
  pressKey(window, 'Space')
  await until(
    () => run('document.activeElement?.getAttribute("aria-checked") === "false"'),
    'Space toggles selection'
  )
  pressKey(window, 'Return')
  await until(
    () => run('document.activeElement?.getAttribute("aria-checked") === "true"'),
    'Enter toggles selection'
  )
  pressKey(window, 'Tab')
  await closed()
  assert.equal(
    await run('!!document.activeElement?.closest(".nnp-root")'),
    true,
    'Tab returns to form'
  )
  assert.equal(await run('!!document.activeElement?.closest(".reminder-channels__panel")'), false)
  await run(`document.querySelector(${JSON.stringify(trigger)}).focus()`)
  pressKey(window, 'Down')
  await until(
    () => run('document.activeElement?.dataset.channel === "1"'),
    'Down opens on first item'
  )
  pressKey(window, 'Escape')
  await closed()

  const bounds = window.getBounds()
  const savedStyles = await run(
    '({root:document.documentElement.getAttribute("style"),body:document.body.getAttribute("style")})'
  )
  const geometries = []
  for (const [name, width, height, background, text, fontSize] of [
    ['white', 480, 720, '255 255 255', '#171717', 18],
    ['black', 480, 720, '0 0 0', '#f5f5f5', 18],
    ['wallpaper', 480, 720, '240 245 255', '#182235', 18],
    ['narrow-large-text', 360, 540, '255 255 255', '#171717', 24]
  ]) {
    window.setSize(width, height)
    // Bounds persistence broadcasts the settings snapshot after a 500ms debounce.
    // Let that finish before applying temporary visual-test theme values.
    await wait(750)
    await run(
      `document.documentElement.style.setProperty('--bg-color',${JSON.stringify(background)});document.documentElement.style.setProperty('--text-color',${JSON.stringify(text)});document.documentElement.style.setProperty('--font-size-base','${fontSize}rem');document.body.style.background=${JSON.stringify(name === 'wallpaper' ? 'repeating-linear-gradient(35deg,#8da68a 0px,#e7b672 50px,#729ab0 100px)' : `rgb(${background})`)}`
    )
    await run(`document.querySelector(${JSON.stringify(trigger)}).scrollIntoView({block:'center'})`)
    await wait(300)
    await clickVisible(window, trigger)
    await until(
      () => run('!!document.querySelector(".reminder-channels__panel")'),
      'visual channel menu'
    )
    await wait(350)
    const rect = await run(
      `(() => { const panel=document.querySelector('.reminder-channels__panel');const r=panel.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,fontSize:getComputedStyle(panel).fontSize,rem:parseFloat(getComputedStyle(document.documentElement).fontSize),background:getComputedStyle(panel).backgroundColor} })()`
    )
    assert.ok(
      rect.left >= 0 && rect.top >= 0 && rect.right <= rect.width && rect.bottom <= rect.height,
      name + ' menu stays in viewport'
    )
    assert.ok(rect.scrollWidth <= rect.width, name + ' no horizontal overflow')
    assert.equal(
      await run(
        `(() => {const label=document.querySelector(${JSON.stringify(trigger + ' > span')});return label.scrollWidth <= label.clientWidth})()`
      ),
      true,
      name + ' summary remains fully readable'
    )
    assert.ok(
      Math.abs(parseFloat(rect.fontSize) - fontSize * rect.rem * 0.8) < 0.1,
      name + ' configured font size applied: ' + JSON.stringify(rect)
    )
    geometries.push({ name, ...rect })
    writeFileSync(
      join(evidence, 'channels-' + name + '.png'),
      (await window.webContents.capturePage()).toPNG()
    )
    await clickVisible(window, '.reminder-channels__option[data-channel="4"]')
    await clickVisible(window, '.reminder-channels__option[data-channel="4"]')
    pressKey(window, 'Escape')
    await closed()
    if (name === 'white')
      writeFileSync(
        join(evidence, 'channels-collapsed.png'),
        (await window.webContents.capturePage()).toPNG()
      )
  }
  writeFileSync(join(evidence, 'channels-geometry.json'), JSON.stringify(geometries, null, 2))
  await run(
    `document.documentElement.setAttribute('style',${JSON.stringify(savedStyles.root || '')});document.body.setAttribute('style',${JSON.stringify(savedStyles.body || '')})`
  )
  window.setBounds(bounds)
  await wait(300)
  await run(`document.querySelector(${JSON.stringify(trigger)}).scrollIntoView({block:'center'})`)
  await wait(200)
  await clickVisible(window, trigger)
  await wait(300)
  await clickVisible(window, '.nnp-root .reminder-channels__label')
  await closed()
  report(
    'channel menu: real multi-select, all summaries, keyboard, outside close, 360px/large text and three backgrounds'
  )
}
async function checkChannelMenuScroll(window) {
  const run = (code) => window.webContents.executeJavaScript(code)
  const trigger = '.app-editor-dialog .reminder-channels__trigger'
  const savedBounds = window.getBounds()
  const geometries = []
  const state = () =>
    run(`(() => {
    const trigger = document.querySelector('${trigger}');
    const scroll = document.querySelector('.app-editor-dialog .ne-body');
    return {
      trigger: trigger.getBoundingClientRect().toJSON(),
      scroll: scroll.getBoundingClientRect().toJSON(),
      panel: document.querySelector('.reminder-channels__panel')?.getBoundingClientRect().toJSON(),
      expanded: trigger.getAttribute('aria-expanded'),
      focusRestored: document.activeElement === trigger,
      scrollTop: scroll.scrollTop, viewportHeight: innerHeight
    };
  })()`)
  const open = async () => {
    await run(`document.querySelector('${trigger}').scrollIntoView({block:'center'})`)
    await wait(250)
    await clickVisible(window, trigger)
    await until(
      () => run('!!document.querySelector(".reminder-channels__panel")'),
      'scroll menu opens'
    )
    await wait(350)
    assert.equal((await state()).expanded, 'true')
  }
  for (const height of [400, 300]) {
    window.setSize(480, height)
    await wait(800)
    await open()
    const before = await state()
    await run(`document.querySelector('.nnp-body').dispatchEvent(new Event('scroll'))`)
    await wait(80)
    assert.equal((await state()).expanded, 'true', 'background scrolling keeps menu open')
    await run(`document.querySelector('.app-editor-dialog .ne-body').scrollTop += 8`)
    await wait(100)
    const moved = await state()
    assert.equal(moved.expanded, 'true', 'visible anchor keeps menu open')
    assert.ok(moved.trigger.top < before.trigger.top, 'form really scrolled')
    assert.ok(moved.panel.top < before.panel.top, 'menu follows its visible anchor')
    // At 300px, End scrolls the menu itself to reveal the last option.
    pressKey(window, 'End')
    await wait(100)
    assert.equal((await state()).expanded, 'true', 'menu-internal scrolling keeps menu open')
    assert.equal(await run('document.activeElement?.dataset.channel'), '4')
    for (const direction of ['top', 'bottom']) {
      if (direction === 'bottom') await open()
      const anchor = await state()
      const point = { x: Math.round(anchor.scroll.left + 8), y: Math.round(anchor.scroll.top + 35) }
      window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
      for (let i = 0; i < 8; i++) {
        window.webContents.sendInputEvent({
          type: 'mouseWheel',
          ...point,
          deltaX: 0,
          deltaY: direction === 'top' ? 120 : -120,
          canScroll: true
        })
        await wait(200)
      }
      await until(
        () => run('!document.querySelector(".reminder-channels__panel")'),
        'hidden anchor closes menu'
      )
      await wait(400)
      const hidden = await state()
      assert.equal(hidden.expanded, 'false')
      assert.equal(
        hidden.focusRestored,
        true,
        'closing keeps focus in the editor without scrolling back'
      )
      assert.ok(
        hidden.trigger.top >= hidden.scroll.bottom || hidden.trigger.bottom <= hidden.scroll.top,
        'anchor remains outside the scrollport'
      )
      geometries.push({ height, direction, ...hidden })
      writeFileSync(
        join(evidence, `channels-scroll-hidden-${height}-${direction}.png`),
        (await window.webContents.capturePage()).toPNG()
      )
    }
    await open()
    assert.equal(
      await run(
        'document.querySelectorAll(".reminder-channels__option[aria-checked=true]").length'
      ),
      3,
      'scroll dismissal preserves selection'
    )
    pressKey(window, 'Escape')
    await until(
      () => run('!document.querySelector(".reminder-channels__panel")'),
      'reopened menu closes'
    )
  }
  writeFileSync(
    join(evidence, 'channels-scroll-geometry.json'),
    JSON.stringify(geometries, null, 2)
  )
  window.setBounds(savedBounds)
  await wait(800)
  report(
    'channel scrolling: visible anchor follows, clipped anchor closes, focus/selection preserved, background/menu scroll ignored'
  )
}
async function openEditor(content) {
  await until(
    () =>
      js(
        `Array.from(document.querySelectorAll('.nl-card')).some(n => n.textContent.includes(${JSON.stringify(content)}))`
      ),
    'note card visible'
  )
  await js(
    `Array.from(document.querySelectorAll('.nl-card')).find(n => n.textContent.includes(${JSON.stringify(content)})).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:120}))`
  )
  await until(() => js('!!document.querySelector(".nl-context-menu")'), 'context menu')
  await js(
    "Array.from(document.querySelectorAll('.nl-context-menu button')).find(n => n.textContent.trim()==='修改').click()"
  )
  await until(() => js('!!document.querySelector(".app-editor-dialog textarea")'), 'editor visible')
}
let errors = []
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (details) => {
    if (contents.isDestroyed()) return
    if (/reminder\.html/.test(contents.getURL()) && details.level === 'error')
      errors.push(details.message)
  })
})

async function run() {
  try {
    main = await until(
      () =>
        BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/index.html')),
      'main'
    )
    await until(() => js('!!window.api && !!document.querySelector(".app-scene")'), 'renderer')
    await until(() => globalThis.__ABANDON_WINDOW_TEST_HOOKS__?.getReminderService(), 'service')
    const service = globalThis.__ABANDON_WINDOW_TEST_HOOKS__.getReminderService()
    db = new Database(join(root, 'app.db'))
    const now = Date.now()
    const create = (content, mask) =>
      js(
        `window.api.createNote({content:${JSON.stringify(content)},effectiveAt:${now + 180000},reminderChannels:${mask}})`
      )
    const a = await create('提醒 A：稍后时间不改变生效日期', 6)
    const b = await create('提醒 B：同一小窗，多条提醒互不清除', 6)
    assert.equal(a.reminder_channels, 6)
    assert.equal(b.reminder_channels, 6)
    // Run the real minute scheduler immediately using its registered retry entry.
    db.prepare('UPDATE notes SET effective_at = ? WHERE id IN (?,?)').run(now - 1000, a.id, b.id)
    main.hide()
    const wasFocused = main.isFocused()
    await js('window.api.retryScheduler()')
    const popup = await until(
      () =>
        BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes('/reminder.html')
        ),
      'popup'
    )
    const pjs = (code) => popup.webContents.executeJavaScript(code)
    await until(
      () => pjs('document.querySelectorAll(".reminder-card").length === 2'),
      'both reminders'
    )
    assert.equal(main.isVisible(), false, 'popup must not reveal main')
    assert.equal(popup.isFocused(), false, 'automatic reminder must not grab focus')
    assert.equal(wasFocused, false)
    const rows = await pjs('window.reminderAPI.getState()')
    const roundA = rows.reminders.find((r) => r.noteId === a.id)
    const roundB = rows.reminders.find((r) => r.noteId === b.id)
    report('hidden main → independent inactive popup, two rounds')

    for (const [name, background, textColor] of [
      ['white', '255 255 255', '#111111'],
      ['black', '0 0 0', '#f5f5f5'],
      ['wallpaper', '236 244 255', '#172437']
    ]) {
      await pjs(
        `document.documentElement.style.setProperty('--bg-color',${JSON.stringify(background)});document.documentElement.style.setProperty('--text-color',${JSON.stringify(textColor)});document.body.style.backgroundImage=${JSON.stringify(name === 'wallpaper' ? 'linear-gradient(135deg, #8aabc1, #e8b987, #629c88)' : 'none')}`
      )
      await wait(100)
      writeFileSync(
        join(evidence, 'popup-' + name + '.png'),
        (await popup.webContents.capturePage()).toPNG()
      )
    }
    await pjs("document.body.style.backgroundImage='none'")
    const aBefore = db.prepare('SELECT * FROM notes WHERE id = ?').get(a.id)
    const nextTime = Date.now() + 600000
    const first = await pjs(
      `window.reminderAPI.action({id:${JSON.stringify(roundA.id)},action:'snooze',dueAt:${nextTime}})`
    )
    assert.equal(first.created, true)
    const second = service.nativeAction({ id: roundA.id, action: 'snooze', minutes: 30 })
    assert.equal(second.created, false)
    assert.equal(second.dueAt, nextTime)
    app.emit('second-instance', {}, [
      'electron.exe',
      `abandon-note://notification/snooze?round=${roundA.id}&minutes=60`
    ])
    assert.equal(
      db
        .prepare("SELECT due_at FROM note_reminders WHERE note_id=? AND state='scheduled'")
        .get(a.id).due_at,
      nextTime
    )
    assert.equal(
      db.prepare('SELECT effective_at FROM notes WHERE id = ?').get(a.id).effective_at,
      aBefore.effective_at
    )
    await until(
      () => pjs('document.querySelectorAll(".reminder-card").length === 1'),
      'A removed only'
    )
    assert.deepEqual([...service.tray.ids], [roundB.id])
    report('popup + native actions share first-wins transaction, B remains visible and blinking')

    await pjs(`window.reminderAPI.action({id:${JSON.stringify(roundB.id)},action:'dismiss'})`)
    await until(() => !popup.isVisible(), 'dismiss hides popup')
    assert.equal(
      db.prepare('SELECT state FROM note_reminders WHERE id=?').get(roundB.id).state,
      'active'
    )
    service.showAll()
    await until(() => popup.isVisible(), 'tray reopen')
    assert.equal(service.tray.timer, null, 'tray reopen acknowledges visual blinking')
    await pjs('window.reminderAPI.hide()')

    // Actual preload/IPC editor save, including channels and cancelling a pending task.
    const apiNames = await js('Object.keys(window.api)')
    assert.ok(apiNames.includes('getNote'))
    let note = await readNote(a.id)
    assert.equal(note.pending_reminder.due_at, nextTime)
    const edit = {
      id: note.id,
      expectedVersion: note.editVersion,
      fields: {
        content: note.content,
        status: note.status,
        effectiveAt: note.effective_at,
        reminderChannels: 2,
        pendingReminder: {
          id: note.pending_reminder.id,
          expectedDueAt: nextTime,
          dueAt: nextTime + 60000
        }
      },
      tagIds: [],
      addedImages: [],
      deletedImageIds: []
    }
    note = await js(`window.api.saveNoteDraft(${JSON.stringify(edit)})`)
    assert.equal(note.reminder_channels, 2)
    assert.equal(note.pending_reminder.due_at, nextTime + 60000)
    const pendingId = note.pending_reminder.id
    db.prepare('UPDATE note_reminders SET due_at=? WHERE id=?').run(Date.now() - 1, pendingId)
    service.tick()
    await until(() => popup.isVisible(), 'snooze fires')
    assert.match(
      service.nativeAction({ id: roundA.id, action: 'snooze', minutes: 10 }).error,
      /这轮提醒已处理/
    )
    await pjs(
      `window.reminderAPI.action({id:${JSON.stringify(pendingId)},action:'snooze',minutes:5})`
    )
    note = await readNote(a.id)
    assert.ok(note.pending_reminder)
    await js(`window.api.completeNote(${a.id})`)
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM note_reminders WHERE note_id=? AND state IN ('active','scheduled')"
        )
        .get(a.id).n,
      0
    )
    report('real editor IPC, repeat snooze, stale callback rejection and completion cancellation')

    main.show()
    main.focus()
    await js('document.querySelector(".ab-box-btn[title=新建]").click()')
    await until(() => js('!!document.querySelector(".nnp-root textarea")'), 'new note form')
    assert.equal(
      await js('document.querySelector(".nnp-root .reminder-channels__trigger").disabled'),
      true
    )
    assert.equal(
      await js(
        'document.querySelector(".nnp-root .reminder-channels__trigger").textContent.trim()'
      ),
      '无需提醒'
    )
    assert.match(
      await js('document.querySelector(".nnp-root .reminder-channels__reason").textContent'),
      /设置未来生效时间/
    )
    await setDateTime(main, '.nnp-root .dt-trigger', Date.now() + 86400000)
    for (const [mask, summary] of [
      [1, '系统提醒'],
      [2, '软件内弹窗'],
      [4, '托盘闪烁'],
      [0, '不提醒'],
      [3, '系统、弹窗'],
      [5, '系统、托盘'],
      [6, '弹窗、托盘'],
      [7, '全部三种']
    ]) {
      await setChannels(main, '.nnp-root', mask)
      assert.equal(
        await js(
          'document.querySelector(".nnp-root .reminder-channels__trigger").textContent.trim()'
        ),
        summary
      )
    }
    await checkChannelMenu(main)
    await js(
      `(() => { const input=document.querySelector('.nnp-root textarea'); input.value='UI 多选提醒验收'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`
    )
    await js('document.querySelector(".nnp-submit").click()')
    const uiNote = await until(
      () => db.prepare("SELECT * FROM notes WHERE content='UI 多选提醒验收'").get(),
      'created through form'
    )
    assert.equal(uiNote.reminder_channels, 7)
    await until(
      () => js('!document.querySelector(".nnp-submit.is-success, .nnp-submit.is-creating")'),
      'create form finishes success state'
    )
    await openEditor('UI 多选提醒验收')
    await checkChannelMenuScroll(main)
    await setChannels(main, '.app-editor-dialog', 6)
    await js(
      'document.querySelector(".app-editor-dialog .reminder-channels").scrollIntoView({block:"center"})'
    )
    await wait(350)
    writeFileSync(
      join(evidence, 'editor-channels.png'),
      (await main.webContents.capturePage()).toPNG()
    )
    await js('document.querySelector(".ne-submit").click()')
    await until(() => js('!document.querySelector(".app-editor-dialog")'), 'editor saved')
    assert.equal((await readNote(uiNote.id)).reminder_channels, 6)
    report('new/edit forms save multiple channels; immediate create disables initial reminders')

    // Real custom picker and keyboard action in a narrow independent window.
    service.showAll()
    popup.setSize(360, 520)
    await until(
      () => pjs('!!document.querySelector(".reminder-custom .dt-trigger")'),
      'custom controls'
    )
    await pjs('document.querySelector(".reminder-actions button").click()')
    service.refresh()
    assert.equal(
      await pjs('!!document.querySelector(".reminder-custom")'),
      false,
      'background refresh must not reopen a dismissed time chooser'
    )
    service.nativeAction({ id: roundB.id, action: 'custom' })
    await until(
      () => pjs('!!document.querySelector(".reminder-custom")'),
      'explicit custom action reopens chooser'
    )
    await setDateTime(popup, '.reminder-custom .dt-trigger', Date.now() + 120000)
    assert.equal(await pjs('document.documentElement.scrollWidth <= innerWidth'), true)
    writeFileSync(
      join(evidence, 'popup-narrow-custom.png'),
      (await popup.webContents.capturePage()).toPNG()
    )
    await pjs('document.querySelector(".reminder-confirm").focus()')
    popup.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    popup.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    popup.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await until(
      () =>
        db.prepare("SELECT id FROM note_reminders WHERE note_id=? AND state='scheduled'").get(b.id),
      'keyboard custom snooze'
    )
    main.show()
    main.focus()
    await openEditor('提醒 B')
    assert.equal(await js('!!document.querySelector(".ne-pending-reminder")'), true)
    await js('document.querySelector(".ne-reminder-cancel input").click()')
    await js('document.querySelector(".ne-submit").click()')
    await until(
      () => js('!document.querySelector(".app-editor-dialog")'),
      'pending cancellation saved'
    )
    assert.equal((await readNote(b.id)).pending_reminder, null)
    report('custom date input + Enter at 360px; editor cancels snooze without changing note status')

    await js('document.querySelector(".titlebar-btn-template").click()')
    await until(() => js('!!document.querySelector(".tcp-button")'), 'template panel')
    await js('document.querySelector(".tcp-button").click()')
    await until(() => js('!!document.querySelector(".tf-root textarea")'), 'template form')
    await setChannels(main, '.tf-root', 6)
    await js(
      `(() => {const input=document.querySelector('.tf-root textarea');input.value='UI 循环多方式验收';input.dispatchEvent(new Event('input',{bubbles:true}));})()`
    )
    await until(
      () => js('document.querySelector(".tf-submit")?.disabled === false'),
      'template valid'
    )
    await js('document.querySelector(".tf-submit").click()')
    const template = await until(
      () => db.prepare("SELECT * FROM note_templates WHERE content='UI 循环多方式验收'").get(),
      'template saved'
    )
    assert.equal(template.reminder_channels, 6)
    report('template multi-channel form saved')

    for (const mode of ['month', 'week']) {
      await js(`window.api.switchMainView('${mode}')`)
      main = await until(
        () =>
          BrowserWindow.getAllWindows().find(
            (w) => !w.isDestroyed() && w.webContents.getURL().includes('/' + mode + '.html')
          ),
        mode + ' window'
      )
      await until(
        () => js('document.querySelector(".month-toolbar__day-panel-toggle")?.disabled === false'),
        'calendar ready'
      )
      const previousFirstDate = await js('document.querySelector(".month-day-cell").dataset.date')
      await js(
        `document.querySelector('button[aria-label="${mode === 'month' ? '下个月' : '下一周'}"]').click()`
      )
      await until(
        () =>
          js(
            `document.querySelector('.month-day-cell')?.dataset.date !== ${JSON.stringify(previousFirstDate)} && document.querySelector('.month-toolbar__day-panel-toggle')?.disabled === false`
          ),
        'calendar navigation finished'
      )
      await js(
        `(() => {const d=new Date();const key=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');const cell=Array.from(document.querySelectorAll('.month-day-cell')).find(n=>n.dataset.date>key);if(!cell)throw new Error('No future calendar cell');cell.click()})()`
      )
      await js(
        `(() => { const toggle=document.querySelector('.month-toolbar__day-panel-toggle'); if(toggle.getAttribute('aria-expanded')!=='true')toggle.click(); })()`
      )
      await until(() => js('!!document.querySelector(".month-day-panel__create")'), 'day panel')
      await js('document.querySelector(".month-day-panel__create").click()')
      await until(
        () => js('!!document.querySelector(".month-creator textarea")'),
        'calendar creator'
      )
      await setChannels(main, '.month-creator', 5)
      await js(
        `(() => {const input=document.querySelector('.month-creator textarea');input.value='UI ${mode} 多选验收';input.dispatchEvent(new Event('input',{bubbles:true}));})()`
      )
      await js('document.querySelector(".month-creator footer .is-primary").click()')
      const created = await until(
        () => db.prepare('SELECT * FROM notes WHERE content=?').get('UI ' + mode + ' 多选验收'),
        'calendar saved'
      )
      assert.equal(created.reminder_channels, 5)
      await until(() => js('!document.querySelector(".month-creator")'), 'creator closed')
    }
    report('template, month and week forms persist channel combinations')

    // Only the reminder renderer is authorized for reminder actions.
    const denied = await main.webContents.executeJavaScript(`window.api.getNote(${b.id})`)
    assert.equal(denied.id, b.id)
    assert.equal(await pjs('typeof window.api'), 'undefined')
    assert.equal(await pjs('typeof require'), 'undefined')
    const stranger = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: resolve('out/preload/reminder.js'),
        sandbox: true,
        contextIsolation: true
      }
    })
    await stranger.loadURL('about:blank')
    assert.match(
      await stranger.webContents.executeJavaScript(
        "window.reminderAPI.getState().then(()=> 'unexpected success',e=>e.message)"
      ),
      /无权访问便签提醒/
    )
    stranger.destroy()
    assert.deepEqual(errors, [])
    service.dispose()
    assert.ok(popup.isDestroyed())
    assert.equal(service.tray.timer, null)
    report('REMINDERS_ELECTRON_OK')
    db.close()
    app.exit(0)
  } catch (error) {
    process.stderr.write(
      String(error.stack || error) + '\nRenderer errors: ' + JSON.stringify(errors) + '\n'
    )
    db?.close()
    app.exit(1)
  }
}
setTimeout(() => {
  process.stderr.write('REMINDERS_ELECTRON_TIMEOUT\n')
  app.exit(1)
}, 90000)
app.once('ready', () => void run())
const require = createRequire(import.meta.url)
require(resolve('out/main/index.js'))
const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
  /^index-[\w-]+\.js$/.test(name)
)
require(resolve('out/main/chunks', chunk))
