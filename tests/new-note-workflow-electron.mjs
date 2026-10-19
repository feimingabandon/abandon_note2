import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'

const stage = process.env.NEW_NOTE_WORKFLOW_STAGE
const restart = stage === 'restart'
const profile = stage
  ? { directory: process.env.NEW_NOTE_WORKFLOW_PROFILE, ownership: 'parent' }
  : prepareTestProfile({ prefix: 'abandon-new-note-workflow-' })
const recorder = createAssertionRecorder({
  suite: 'tests/new-note-workflow-electron.mjs',
  mode: stage ? 'real-app-new-note-' + stage : 'real-app-new-note-session-and-layout',
  metadata: {
    mainProcessRestart: true,
    realRendererAndPreload: true,
    diskDatabase: true,
    injectedCreateFailure: true,
    injectedSaveFailure: true,
    syntheticScreenshotDelivery: true,
    nativeScreenshotInput: false,
    windowsDpiChanged: false
  }
})
const { assert } = recorder
const evidence = process.env.ABANDON_TEST_EVIDENCE_DIR || resolve('tmp/new-note-workflow-evidence')
mkdirSync(evidence, { recursive: true })
app.setPath('userData', profile.directory)
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
if (stage === 'workflow') {
  const db = new Database(join(profile.directory, 'app.db'))
  createDatabaseSchema(db)
  const put = db.prepare('INSERT INTO app_settings(window_name,type,key,value) VALUES(?,?,?,?)')
  for (const row of [
    ['application', 'application', 'active_view', 'list'],
    ['application', 'remote', 'receive_notices', 'false'],
    ['application', 'remote', 'upload_device_info', 'false'],
    ['application', 'onboarding', 'first_use_notice_version', '1'],
    ...['main', 'month', 'week'].map((v) => [v, 'system', 'blur_enabled', 'false'])
  ])
    put.run(...row)
  db.close()
}
let failCreate = false
let failSave = false
const originalHandle = ipcMain.handle
ipcMain.handle = function (channel, handler) {
  return originalHandle.call(
    this,
    channel,
    ['notes:create-with-assets', 'notes:save-draft'].includes(channel)
      ? (...args) => {
          if (channel === 'notes:create-with-assets' && failCreate)
            throw Error('workflow injected create failure')
          if (channel === 'notes:save-draft' && failSave)
            throw Error('workflow injected save failure')
          return handler(...args)
        }
      : handler
  )
}
let win
let completed = false
let failure
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const remarkFixture = '备注保留换行与较长内容\n' + '窄窗口备注自动换行验证'.repeat(8)
const themes = [
  ['white', '255 255 255', '#1d1d1f', ''],
  ['black', '0 0 0', '#ffffff', ''],
  [
    'complex-fixture',
    '255 255 255',
    '#1d1d1f',
    'repeating-linear-gradient(35deg,#e08335 0 22px,#122d50 22px 40px,#63a683 40px 68px)'
  ]
]
async function js(code) {
  try {
    return await win.webContents.executeJavaScript(code)
  } catch (error) {
    console.error('[workflow renderer script]', code)
    throw error
  }
}
async function until(fn, label) {
  const end = Date.now() + 15000
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await pause(60)
  }
  throw Error(label)
}
async function click(selector) {
  // Form controls can be below the internal scroll viewport at large font sizes.
  await js(
    `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'})`
  )
  await pause(80)
  await js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await pause(350)
}
async function fill(selector, value) {
  await js(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`
  )
  await pause(80)
}
async function set(id, value) {
  await js(`window.api.setSettingValue(${JSON.stringify(id)},${JSON.stringify(value)})`)
  await pause(180)
}
async function scheduleTomorrow() {
  await click('.nnp-root .dt-trigger')
  await js(`[...document.querySelectorAll('.dt-sc-chip')].find(b=>b.textContent==='明天').click()`)
  await click('.dt-btn--confirm')
}
async function choose(selector, label) {
  await click(selector)
  await until(
    () =>
      js(
        `!![...document.querySelectorAll('.sel-option')].find(e=>e.querySelector('.sel-option-label')?.textContent.trim()===${JSON.stringify(label)})`
      ),
    'option ' + label
  )
  await js(
    `[...document.querySelectorAll('.sel-option')].find(e=>e.querySelector('.sel-option-label')?.textContent.trim()===${JSON.stringify(label)}).click()`
  )
  await pause(180)
}
async function view(mode) {
  await js(`window.api.switchMainView(${JSON.stringify(mode)})`)
  await until(
    () => js(`!!document.querySelector('${mode === 'list' ? '.nnp-root' : '.month-workspace'}')`),
    'view ' + mode
  )
  await pause(450)
}
async function keepDraftAndView(mode) {
  // The IPC promise remains pending while the real renderer asks for confirmation.
  await js(`void window.api.switchMainView(${JSON.stringify(mode)})`)
  await until(
    () => js(`!!document.querySelector('.confirm-card.active[aria-label="保留草稿后继续？"]')`),
    'remark draft requires view-switch confirmation'
  )
  await js(
    `[...document.querySelectorAll('.confirm-card.active button')].find(b=>b.textContent.trim()==='保留并切换').click()`
  )
  await until(
    () =>
      win.webContents.getURL().includes('/' + (mode === 'list' ? 'index' : mode) + '.html') &&
      js(`!!document.querySelector('${mode === 'list' ? '.nnp-root' : '.month-workspace'}')`),
    'view retains remark draft: ' + mode
  )
  await pause(450)
}
async function openList() {
  await until(
    () => js(`['open','collapsed'].includes(document.querySelector('.ab-root').dataset.phase)`),
    'list panel transition settled'
  )
  if (await js(`document.querySelector('.ab-root').dataset.phase==='collapsed'`))
    await click('.ab-box:not(.ab-box--search) .ab-box-btn')
  await until(
    () => js(`document.querySelector('.ab-root').dataset.phase==='open'`),
    'list panel open'
  )
  await pause(600)
}
async function closeList() {
  await click('.ab-box:not(.ab-box--search) .ab-box-btn')
  await until(
    () => js(`document.querySelector('.ab-root').dataset.phase==='collapsed'`),
    'list panel closed'
  )
}
async function openCalendar() {
  if (!(await js(`!!document.querySelector('.month-day-panel__create')`)))
    await click('.month-toolbar__day-panel-toggle')
  await click('.month-day-panel__create')
  await until(() => js(`!!document.querySelector('.month-creator')`), 'calendar creator')
  await pause(250)
}
async function state(scope) {
  return js(
    `(()=>{const p=document.querySelector(${JSON.stringify(scope)});return {content:p.querySelector('.colored-text-editor textarea').value,remark:p.querySelector('.note-remark-field textarea').value,duration:p.querySelector('.note-duration-field .sel-label').textContent.trim(),days:p.querySelector('.number-stepper input')?.value,pinned:p.querySelector('[aria-label="置顶"]').getAttribute('aria-checked'),tag:p.querySelector('.ts-chip.selected')?.title||null,reminder:p.querySelector('.reminder-channels__trigger').textContent.trim(),images:p.querySelectorAll('.ip-thumb').length,colors:p.querySelectorAll('.colored-text-editor__mirror span[style]').length}})()`
  )
}
async function layout(scope, name) {
  const problems = await js(`(()=>{const p=document.querySelector(${JSON.stringify(scope)}),out=[];
    for(const r of p.querySelectorAll('.note-state-fields__row,.note-duration-field,.reminder-channels__row,.note-remark-field,.tfs-inline-rule,.tf-row,.tf-preview,.month-creator__row,.month-creator > header div')){if(r.getBoundingClientRect().width&&r.scrollWidth>r.clientWidth+2)out.push(r.className+' horizontal overflow')}
    for(const e of p.querySelectorAll('.note-remark-field textarea')){const box=e.getBoundingClientRect(),parent=e.parentElement.getBoundingClientRect();if(!box.width)continue;if(box.left<parent.left-1||box.right>parent.right+1)out.push('remark textarea outside field');if(e.scrollWidth>e.clientWidth+2)out.push('remark textarea horizontal overflow');const label=e.labels?.[0];if(!label)out.push('remark textarea has no associated label');else {const range=document.createRange();range.selectNodeContents(label);for(const t of range.getClientRects())if(t.left<parent.left-1||t.right>parent.right+1)out.push('remark label outside field')}}
    for(const b of p.querySelectorAll('.titlebar-style-selector button,.dock-reveal-mode-selector button,.tfs-segments button,.tfs-choice-grid button,.base-btn')){const box=b.getBoundingClientRect();if(!box.width)continue;const walker=document.createTreeWalker(b,NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode()){if(!n.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(n);for(const t of range.getClientRects())if(t.left<box.left-1||t.right>box.right+1||t.top<box.top-1||t.bottom>box.bottom+1)out.push(b.textContent.trim()+' text outside target')}}
    for(const e of p.querySelectorAll('.note-duration-field .sel-label,.reminder-channels__trigger > span')){const target=e.closest('button'),box=target.getBoundingClientRect();if(!box.width)continue;const range=document.createRange();range.selectNodeContents(e);for(const t of range.getClientRects())if(t.left<box.left-1||t.right>box.right+1||t.top<box.top-1||t.bottom>box.bottom+1)out.push(e.textContent.trim()+' clipped control label')}
    const ctx=document.createElement('canvas').getContext('2d');for(const input of p.querySelectorAll('.number-stepper input,.fsi-input')){if(!input.getBoundingClientRect().width)continue;const s=getComputedStyle(input);ctx.font=s.font;const available=input.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight);if(ctx.measureText(input.value).width>available+1)out.push(input.getAttribute('aria-label')+' clipped numeric input')}
    return out})()`)
  assert.deepEqual(problems, [], name)
}
async function save(scope, content) {
  await fill(scope + ' .colored-text-editor textarea', content)
  await click(scope + ' [data-diagnostic-action="note.create"]')
  await until(
    () =>
      js(
        scope === '.nnp-root'
          ? `document.querySelector('.nnp-root .colored-text-editor textarea').value==='' && document.querySelector('.nnp-root .note-remark-field textarea').value==='' && document.querySelector('.nnp-submit').textContent.includes('创建便签')`
          : `!document.querySelector(${JSON.stringify(scope)})`
      ),
    'creation completed'
  )
  // Vue keeps a deleted thumbnail in the DOM during its exit animation.
  await until(
    () => js(`!document.querySelector(${JSON.stringify(scope + ' .ip-thumb')})`),
    'attachments cleared'
  )
}
async function capture(name) {
  writeFileSync(join(evidence, name + '.png'), (await win.webContents.capturePage()).toPNG())
}
async function remarkAppearance(scope, name) {
  await until(
    () => js(`!document.querySelector('.msg-toast')`),
    'toast cleared before visual checks'
  )
  for (const [theme, bg, text, background] of themes) {
    await set('css.bgColor', bg)
    await set('css.textColor', text)
    await js(
      `document.querySelector('.app-bg').style.backgroundImage=${JSON.stringify(background)}; document.querySelector(${JSON.stringify(scope + ' .note-remark-field')}).scrollIntoView({block:'center'})`
    )
    await pause(250)
    await layout(scope, name + ' remark theme ' + theme)
    await capture(name + '-remark-' + theme + '-150')
  }
  await js(`document.querySelector('.app-bg').style.removeProperty('background-image')`)
}
async function openEditor(id) {
  await until(
    () => js(`!!document.querySelector('.nl-card[data-note-id="${id}"]')`),
    'created note card'
  )
  await js(
    `(()=>{const card=document.querySelector('.nl-card[data-note-id="${id}"]');card.scrollIntoView({block:'center'});card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:180}))})()`
  )
  await until(() => js(`!!document.querySelector('.nl-context-menu')`), 'context menu')
  await js(
    `[...document.querySelectorAll('.nl-context-menu button')].find(b=>b.textContent.trim()==='修改').click()`
  )
  await until(
    () => js(`!!document.querySelector('.ne-root .note-remark-field textarea')`),
    'editor'
  )
}
async function saveEditor() {
  await until(() => js(`!document.querySelector('.ne-submit').disabled`), 'editor save enabled')
  await click('.ne-submit')
  await until(() => js(`!document.querySelector('.ne-root')`), 'editor saved and closed')
}
async function run() {
  try {
    win = await until(
      () =>
        BrowserWindow.getAllWindows().find((w) =>
          /\/(index|month|week)\.html/.test(w.webContents.getURL())
        ),
      'main window'
    )
    await until(() => js(`!!document.querySelector('.titlebar-btn-settings')`), 'renderer')
    await js('document.fonts.ready.then(()=>true)')
    if (await js(`!!document.querySelector('[aria-label="快捷键启用提示"] .app-modal-close')`))
      await click('[aria-label="快捷键启用提示"] .app-modal-close')
    if (restart) {
      await view('list')
      await openList()
      const reset = await state('.nnp-root')
      assert.equal(reset.duration, '仅当天')
      assert.equal(reset.pinned, 'false')
      assert.equal(reset.tag, null)
      assert.equal(reset.content, '')
      assert.equal(reset.remark, '', 'restart discards the previous launch remark draft')
      assert.equal(reset.images, 0)
      assert.equal(
        await js(
          `Object.keys(localStorage).filter(k=>k.startsWith('abandon:new-note-preferences:')).length`
        ),
        0
      )
      await scheduleTomorrow()
      assert.equal(
        (await state('.nnp-root')).reminder,
        '不提醒',
        'restart restores default reminder'
      )
      await js('window.__clearEditingDrafts()')
      completed = true
      app.quit()
      return
    }
    const imagePng = nativeImage
      .createFromBitmap(Buffer.from([255, 255, 255, 255]), { width: 1, height: 1 })
      .toPNG()
    win.setContentSize(720, 900)
    await openList()
    assert.equal((await state('.nnp-root')).duration, '仅当天')
    await fill('.nnp-root .note-remark-field textarea', '列表纯备注草稿\n等待补充正文')
    assert.equal(await js(`document.querySelector('.nnp-submit').disabled`), true)
    assert.equal(
      await js(`window.__prepareEditingDrafts().dirty`),
      true,
      'a remark alone is protected without allowing an empty note to be created'
    )
    await keepDraftAndView('month')
    await openCalendar()
    assert.equal(
      (await state('.month-creator')).remark,
      '',
      'list remark is not a creation preference'
    )
    await fill('.month-creator .note-remark-field textarea', '日历纯备注草稿')
    assert.equal(
      await js(
        `document.querySelector('.month-creator [data-diagnostic-action="note.create"]').disabled`
      ),
      true,
      'calendar remark alone cannot create an empty note'
    )
    await click('.month-creator [aria-label="关闭新建便签"]')
    await until(
      () => js(`!!document.querySelector('.confirm-card.active[aria-label="放弃新建便签？"]')`),
      'closing a remark-only calendar draft requires confirmation'
    )
    await click('.confirm-card.active .confirm-actions button:first-child')
    assert.equal((await state('.month-creator')).remark, '日历纯备注草稿')
    await keepDraftAndView('list')
    await openList()
    assert.equal((await state('.nnp-root')).remark, '列表纯备注草稿\n等待补充正文')
    assert.equal((await state('.nnp-root')).content, '')
    await fill('.nnp-root .note-remark-field textarea', '')
    assert.equal(await js(`window.__prepareEditingDrafts().dirty`), false)
    await view('month')
    await openCalendar()
    assert.equal((await state('.month-creator')).remark, '日历纯备注草稿')
    await fill('.month-creator .note-remark-field textarea', '')
    assert.equal(await js(`window.__prepareEditingDrafts().dirty`), false)
    await click('.month-creator [aria-label="关闭新建便签"]')
    await view('list')
    await openList()
    const tag = await js(`window.api.createTag('worktag','#0071e3')`)
    await until(
      () => js(`!!document.querySelector('.nnp-root .ts-chip[title="worktag"]')`),
      'tag loaded'
    )
    await choose('.nnp-root .note-duration-field .sel-trigger', '指定天数')
    await fill('.nnp-root .number-stepper input', '365')
    await click('.nnp-root [aria-label="置顶"]')
    await click('.nnp-root .ts-chip[title="worktag"]')
    await scheduleTomorrow()
    await click('.nnp-root .reminder-channels__trigger')
    await click('.reminder-channels__option[data-channel="2"]')
    await js(
      `document.querySelector('.reminder-channels__panel').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`
    )
    await js(
      `(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(imagePng.toString('base64'))}),c=>c.charCodeAt(0)),transfer=new DataTransfer();transfer.items.add(new File([bytes],'workflow.png',{type:'image/png'}));const input=document.querySelector('.nnp-root input[type="file"]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`
    )
    await until(
      () =>
        js(
          `document.querySelectorAll('.nnp-root .ip-thumb').length===1 && !document.querySelector('.nnp-submit').disabled`
        ),
      'image ready'
    )
    await fill('.nnp-root textarea', 'retain on failure')
    const firstRemark = '列表创建的备注\n失败后也应保留第二行'
    await fill('.nnp-root .note-remark-field textarea', firstRemark)
    await js(
      `(()=>{const e=document.querySelector('.nnp-root textarea');e.setSelectionRange(0,6);e.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowRight',shiftKey:true,bubbles:true}))})()`
    )
    await click('.nl-text-color-popover__swatch')
    const before = await state('.nnp-root')
    assert.equal(before.colors, 1, 'fixture applies a real text color')
    failCreate = true
    await click('.nnp-submit')
    await until(
      () => js(`!document.querySelector('.nnp-submit').disabled`),
      'failed create released'
    )
    assert.deepEqual(
      await state('.nnp-root'),
      before,
      'failed create retains all fields and attachment'
    )
    failCreate = false
    await save('.nnp-root', 'first scheduled note')
    const retained = await state('.nnp-root')
    assert.equal(retained.content, '')
    assert.equal(retained.remark, '', 'successful creation clears the remark for the next note')
    assert.equal(retained.images, 0)
    assert.equal(retained.colors, 0, 'text color ranges clear with content')
    assert.equal(retained.duration, '指定天数')
    assert.equal(retained.days, '365')
    assert.equal(retained.pinned, 'true')
    assert.equal(retained.tag, 'worktag')
    assert.equal(
      retained.reminder,
      '软件内弹窗',
      'explicit future time remains for continuous entry'
    )
    assert.equal(
      await js(`document.querySelector('.ab-root').dataset.phase`),
      'open',
      'successful creation keeps list panel open'
    )
    assert.equal(
      await js(`document.activeElement===document.querySelector('.nnp-root textarea')`),
      true,
      'next note can be entered immediately'
    )
    assert.equal(
      await js(`window.__prepareEditingDrafts().dirty`),
      false,
      'remembered options alone are not an unsaved note'
    )
    await openList()
    win.hide()
    await pause(120)
    win.show()
    assert.equal(
      (await state('.nnp-root')).days,
      '365',
      'hiding the window retains this launch options'
    )
    await scheduleTomorrow()
    assert.equal(
      (await state('.nnp-root')).reminder,
      '软件内弹窗',
      'valid new schedule restores reminder preference'
    )
    await click('.nnp-root .dt-clear-btn')
    await save('.nnp-root', 'second immediate note')
    const db = new Database(join(profile.directory, 'app.db'), { readonly: true })
    const first = db.prepare('SELECT * FROM notes WHERE content=?').get('first scheduled note')
    const second = db.prepare('SELECT * FROM notes WHERE content=?').get('second immediate note')
    assert.equal(first.reminder_channels, 2)
    assert.equal(second.reminder_channels, 0)
    assert.equal(second.duration_days, 365)
    assert.equal(second.is_pinned, 1)
    assert.equal(first.remark, firstRemark, 'list creation persists the multiline remark')
    assert.equal(second.remark, '', 'continuous entry never inherits the previous remark')
    db.close()

    // Synthetic delivery reuses the actual screenshot draft and persistence path;
    // native screenshot selection and keyboard input are outside this suite.
    const screenshotScope = '.app-modal-card[aria-label="截图新建便签"] .nnp-root'
    const screenshotRemark = '截图新建备注\n没有正文也保留图片和备注'
    win.webContents.send('screenshot:delivery', {
      sessionId: 'new-note-remark-workflow',
      deliveryId: randomUUID(),
      action: 'note',
      dataUrl: `data:image/png;base64,${imagePng.toString('base64')}`,
      size: imagePng.length
    })
    await until(
      () =>
        js(
          `!!document.querySelector(${JSON.stringify(screenshotScope + ' .ip-thumb')}) && !document.querySelector(${JSON.stringify(screenshotScope + ' .nnp-submit')}).disabled`
        ),
      'screenshot draft image imported through real delivery receiver'
    )
    assert.equal((await state(screenshotScope)).remark, '')
    await fill(screenshotScope + ' .note-remark-field textarea', screenshotRemark)
    await save(screenshotScope, '')
    const screenshotDb = new Database(join(profile.directory, 'app.db'), { readonly: true })
    const screenshotNote = screenshotDb
      .prepare('SELECT * FROM notes WHERE remark=?')
      .get(screenshotRemark)
    assert.ok(screenshotNote, 'screenshot form saves its remark')
    assert.equal(screenshotNote.content, '')
    assert.equal(
      screenshotDb
        .prepare('SELECT COUNT(*) AS count FROM note_attachments WHERE note_id=?')
        .get(screenshotNote.id).count,
      1,
      'image-only screenshot note retains its attachment with the remark'
    )
    screenshotDb.close()
    await choose('.nnp-root .note-state-fields .sel-trigger', '已完成')
    await click('.nnp-root .note-state-fields__completion .dt-trigger')
    await click('.dt-panel-wrap .dt-btn--now')
    await click('.nnp-root .note-state-fields__completion .dt-trigger')
    await click('.dt-panel-wrap .dt-btn--confirm')
    assert.equal(
      await js(
        `document.querySelector('.note-state-fields__completion .dt-label').textContent.trim()`
      ),
      '保存时完成'
    )
    // The explicit "now" action must survive time spent entering each subsequent note.
    await pause(1200)
    await save('.nnp-root', 'complete immediately one')
    await pause(1200)
    await save('.nnp-root', 'complete immediately two')
    const completedDb = new Database(join(profile.directory, 'app.db'), { readonly: true })
    for (const content of ['complete immediately one', 'complete immediately two']) {
      const note = completedDb.prepare('SELECT * FROM notes WHERE content=?').get(content)
      assert.equal(note.status, 'completed')
      assert.equal(
        note.finished_at,
        note.effective_at,
        'one commit timestamp resolves both now intentions'
      )
      assert.equal(note.reminder_channels, 0)
    }
    completedDb.close()
    assert.equal(
      await js(
        `document.querySelector('.nnp-root .note-state-fields .sel-label').textContent.trim()`
      ),
      '已完成',
      'completion choice remains for consecutive notes'
    )
    await choose('.nnp-root .note-state-fields .sel-trigger', '进行中')
    for (const mode of ['month', 'week']) {
      await view(mode)
      win.setContentSize(720, 900)
      await openCalendar()
      const inherited = await state('.month-creator')
      assert.equal(inherited.remark, '', mode + ' starts without another note remark')
      assert.equal(inherited.duration, mode === 'month' ? '指定天数' : '持续到完成')
      if (mode === 'month') assert.equal(inherited.days, '365')
      assert.equal(inherited.pinned, 'true')
      assert.equal(inherited.tag, 'worktag')
      assert.equal(
        await js(`window.__prepareEditingDrafts().dirty`),
        false,
        'empty inherited calendar form is clean'
      )
      await choose('.month-creator .note-duration-field .sel-trigger', '持续到完成')
      const calendarRemark = mode + ' 备注\n保留多行'
      await fill('.month-creator .colored-text-editor textarea', mode + ' note')
      await fill('.month-creator .note-remark-field textarea', calendarRemark)
      const calendarBefore = await state('.month-creator')
      failCreate = true
      await click('.month-creator [data-diagnostic-action="note.create"]')
      await until(
        () =>
          js(
            `!document.querySelector('.month-creator [data-diagnostic-action="note.create"]').disabled`
          ),
        mode + ' failed create released'
      )
      assert.deepEqual(
        await state('.month-creator'),
        calendarBefore,
        mode + ' failure retains the remark'
      )
      failCreate = false
      await save('.month-creator', mode + ' note')
      const calendarDb = new Database(join(profile.directory, 'app.db'), { readonly: true })
      assert.equal(
        calendarDb.prepare('SELECT remark FROM notes WHERE content=?').get(mode + ' note').remark,
        calendarRemark,
        mode + ' creation persists the remark'
      )
      calendarDb.close()
      await openCalendar()
      assert.equal((await state('.month-creator')).duration, '持续到完成')
      assert.equal(
        (await state('.month-creator')).remark,
        '',
        mode + ' next note has an empty remark'
      )
      await click('.month-creator [aria-label="关闭新建便签"]')
      assert.equal(await js(`!!document.querySelector('.confirm-card')`), false)
      const otherDate = await js(
        `document.querySelector('.month-day-cell:not(.is-today)[aria-disabled="false"]').dataset.date`
      )
      await click(`.month-day-cell[data-date="${otherDate}"]`)
      await openCalendar()
      assert.equal(
        await js(
          `document.querySelector('.month-creator .time-picker__trigger').textContent.trim()`
        ),
        '00:01',
        'different calendar date has its own default time'
      )
      await choose('.month-creator .note-duration-field .sel-trigger', '指定天数')
      await fill('.month-creator .number-stepper input', '365')
      await set('appearance.uiScale', 1.5)
      await set('css.fontSizeBase', 28)
      await fill('.month-creator .note-remark-field textarea', remarkFixture)
      for (const width of [720, 496, 400, 240]) {
        win.setContentSize(width, 900)
        await pause(500)
        await layout('.month-creator', mode + ' form ' + width)
      }
      win.setContentSize(496, 900)
      await js(
        `document.querySelector('.month-creator .note-duration-field').scrollIntoView({block:'center'})`
      )
      await pause(300)
      await capture(mode + '-fixed-days-150')
      await remarkAppearance('.month-creator', mode)
      await fill('.month-creator .note-remark-field textarea', '')
      await choose('.month-creator .note-duration-field .sel-trigger', '持续到完成')
      await click('.month-creator [aria-label="关闭新建便签"]')
      win.setContentSize(720, 900)
      await click('.titlebar-btn-settings')
      await layout('.settings-panel', mode + ' settings sidebar')
      await js(
        `document.querySelector('.dock-reveal-mode-selector').scrollIntoView({block:'center'})`
      )
      await pause(250)
      await capture(mode + '-dock-settings-150')
      await click('.panel-close-btn')
    }
    await view('list')
    await openList()
    assert.equal((await state('.nnp-root')).duration, '持续到完成')
    await js(`window.api.deleteTag(${tag.id})`)
    await until(async () => !(await state('.nnp-root')).tag, 'deleted preference tag removed')
    await choose('.nnp-root .note-duration-field .sel-trigger', '指定天数')
    await fill('.nnp-root .number-stepper input', '365')
    await set('appearance.uiScale', 1.5)
    await set('css.fontSizeBase', 22)
    await fill('.nnp-root .note-remark-field textarea', remarkFixture)
    for (const width of [496, 400, 300, 240]) {
      win.setContentSize(width, 900)
      await pause(500)
      await layout('.nnp-root', 'list form ' + width)
    }
    win.setContentSize(496, 900)
    await js(`document.querySelector('.note-duration-field').scrollIntoView({block:'center'})`)
    await pause(300)
    await capture('list-fixed-days-150')
    await remarkAppearance('.nnp-root', 'list')
    await fill('.nnp-root .note-remark-field textarea', '')
    await closeList()
    await click('.titlebar-btn-settings')
    for (const width of [496, 300, 240]) {
      win.setContentSize(width, 900)
      await pause(500)
      await layout('.settings-panel', 'list settings ' + width)
    }
    win.setContentSize(496, 900)
    for (const [name, bg, text, background] of themes) {
      await set('css.bgColor', bg)
      await set('css.textColor', text)
      await js(
        `document.querySelector('.app-bg').style.backgroundImage=${JSON.stringify(background)}`
      )
      await js(
        `document.querySelector('.titlebar-style-selector').scrollIntoView({block:'center'})`
      )
      await pause(300)
      await layout('.settings-panel', 'settings theme ' + name)
      await capture('settings-' + name + '-150')
    }
    await js(`document.querySelector('.app-bg').style.removeProperty('background-image')`)
    await click('.panel-close-btn')
    win.setContentSize(720, 900)
    await openEditor(second.id)
    assert.equal((await state('.ne-root')).remark, '')
    await fill('.ne-root .note-remark-field textarea', remarkFixture)
    failSave = true
    await click('.ne-submit')
    await until(
      () => js(`!document.querySelector('.ne-submit').disabled`),
      'failed editor save released'
    )
    assert.equal(
      (await state('.ne-root')).remark,
      remarkFixture,
      'failed full edit keeps its remark draft'
    )
    assert.equal(
      await js(`window.api.getNote(${second.id}).then(note=>note.remark)`),
      '',
      'failed full edit does not commit its remark'
    )
    failSave = false
    for (const width of [496, 300, 240]) {
      win.setContentSize(width, 900)
      await pause(500)
      await layout('.ne-root', 'editor ' + width)
    }
    win.setContentSize(400, 900)
    await js(
      `document.querySelector('.ne-root .note-duration-field').scrollIntoView({block:'center'})`
    )
    await capture('editor-fixed-days-150')
    await remarkAppearance('.ne-root', 'editor')
    await saveEditor()
    assert.equal(
      await js(`window.api.getNote(${second.id}).then(note=>note.remark)`),
      remarkFixture
    )
    assert.equal(
      await js(`window.api.getNote(${second.id}).then(note=>note.content)`),
      second.content
    )
    await openEditor(second.id)
    assert.equal(
      (await state('.ne-root')).remark,
      remarkFixture,
      'full edit loads the saved remark'
    )
    await fill('.ne-root .note-remark-field textarea', '')
    await saveEditor()
    assert.equal(
      await js(`window.api.getNote(${second.id}).then(note=>note.remark)`),
      '',
      'full edit can clear its remark'
    )
    win.setContentSize(496, 900)
    await click('.titlebar-btn-template')
    await until(() => js(`!!document.querySelector('.tcp-box')`), 'template page')
    await click('.tcp-box')
    await until(() => js(`!!document.querySelector('.tcp-content.visible')`), 'template form')
    for (const width of [496, 300, 240]) {
      win.setContentSize(width, 900)
      await pause(500)
      await layout('.tcp-content .tf-root', 'template ' + width)
    }
    assert.equal(
      await js(`getComputedStyle(document.querySelector('.tfs-segments')).display`),
      'none',
      'narrow frequency segments yield to select'
    )
    assert.notEqual(
      await js(`getComputedStyle(document.querySelector('.tfs-compact-frequency')).display`),
      'none'
    )
    for (const label of ['周', '月', '季', '年']) {
      await choose('.tfs-compact-frequency .sel-trigger', label)
      await pause(400)
      await layout('.tcp-content .tf-root', 'narrow template frequency ' + label)
    }
    win.setContentSize(400, 900)
    await js(`document.querySelector('.tf-time-range').scrollIntoView({block:'center'})`)
    await capture('template-time-range-150')
    await js('window.__clearEditingDrafts()')
    await click('.titlebar-btn-template')
    await openList()
    await fill('.nnp-root .note-remark-field textarea', '重启前未保存的备注')
    assert.equal(await js(`window.__prepareEditingDrafts().dirty`), true)
    completed = true
    app.quit()
    await until(
      () => js(`!!document.querySelector('.confirm-card.active[aria-label="保留草稿后继续？"]')`),
      'quit protects the unsaved remark'
    )
    await js(
      `[...document.querySelectorAll('.confirm-card.active button')].find(b=>b.textContent.trim()==='保留并退出').click()`
    )
  } catch (error) {
    failure = error
    console.error(error)
    if (win && !win.isDestroyed()) await capture('failure').catch(() => {})
    if (win && !win.isDestroyed()) await js('window.__clearEditingDrafts?.()').catch(() => {})
    app.quit()
  }
}
// This coordinator never loads the product renderer. Both product processes run
// in sequence against the same profile, so Chromium storage is reopened only
// after the first process has shut down normally.
async function runStages() {
  try {
    for (const name of ['workflow', 'restart']) {
      const resultFile = join(evidence, `stage-${name}-${randomUUID()}.json`)
      const env = {
        ...process.env,
        NEW_NOTE_WORKFLOW_STAGE: name,
        NEW_NOTE_WORKFLOW_PROFILE: profile.directory,
        ABANDON_TEST_RESULT_FILE: resultFile,
        ABANDON_TEST_RUN_TOKEN: randomUUID(),
        ABANDON_TEST_USER_DATA: profile.directory,
        ABANDON_TEST_EVIDENCE_DIR: evidence
      }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(process.execPath, [resolve('tests/new-note-workflow-electron.mjs')], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      child.stdout.on('data', (data) => process.stderr.write(data))
      child.stderr.on('data', (data) => process.stderr.write(data))
      const code = await new Promise((resolveExit, reject) => {
        child.once('error', reject)
        child.once('exit', resolveExit)
      })
      assert.equal(code, 0, name + ' product process exited successfully')
      const result = JSON.parse(readFileSync(resultFile, 'utf8'))
      assert.equal(result.mode, 'real-app-new-note-' + name)
      assert.equal(result.completed, true, name + ' business checks completed')
      assert.ok(result.assertions.total > 0)
      assert.equal(result.assertions.failed, 0)
    }
    completed = true
  } catch (error) {
    failure = error
    console.error(error)
  }
  app.quit()
}
app.once('will-quit', () => {
  ipcMain.handle = originalHandle
  const cleanup =
    profile.ownership === 'script'
      ? {
          status: 'preserved',
          directory: profile.directory,
          reason:
            'Standalone evidence profile; Chromium owns its cache until process exit. Managed runs clean it in the runner.'
        }
      : { status: 'complete' }
  recorder.finish({
    completed,
    cleanup,
    evidence: { status: failure ? 'failed' : 'complete' },
    error: failure
  })
  process.exitCode = completed && !failure ? 0 : 1
})
setTimeout(() => {
  console.error('NEW_NOTE_WORKFLOW_TIMEOUT')
  app.exit(2)
}, 300000).unref()
app.once('ready', () => void (stage ? run() : runStages()))
const require = createRequire(import.meta.url)
if (stage) {
  require(resolve('out/main/index.js'))
  require(
    resolve(
      'out/main/chunks',
      readdirSync(resolve('out/main/chunks')).find((n) => /^index-[\w-]+\.js$/.test(n))
    )
  )
}
