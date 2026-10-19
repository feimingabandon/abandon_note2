import { readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'

const results = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/note-three-view-rules-ui-electron.mjs',
  mode: 'real-app-three-view-note-create-edit-and-calendar-defaults',
  prefix: 'abandon-three-view-note-rules-',
  timeoutMs: 240000,
  metadata: {
    realRendererAndPreload: true,
    realDiskDatabase: true,
    domControlInput: true,
    nativePointerInput: true,
    nativePointerScope:
      'Chromium sendInputEvent for date cells, popup confirmation and text editor resize',
    views: ['list', 'month', 'week'],
    productionProfileTouched: false,
    wallClockWaitingForAppointments: false
  }
})
const { assert } = results
app.setPath('userData', results.root)
app.commandLine.appendSwitch('disable-gpu')
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
const seed = new Database(join(results.root, 'app.db'))
createDatabaseSchema(seed)
const put = seed.prepare('INSERT INTO app_settings(window_name,type,key,value) VALUES(?,?,?,?)')
for (const row of [
  ['application', 'application', 'active_view', 'list'],
  ['application', 'remote', 'receive_notices', 'false'],
  ['application', 'remote', 'upload_device_info', 'false'],
  ['application', 'onboarding', 'first_use_notice_version', '1'],
  ...['main', 'month', 'week'].map((view) => [view, 'system', 'blur_enabled', 'false'])
])
  put.run(...row)
seed.close()

let window
let currentView = 'list'
const scenarios = []
const pickerEvidence = []
const pickerScreenshots = []
const calendarEvidence = []
const editorEvidence = []
const checkedEditors = new Set()
const capturedTimePickers = new Set()
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const js = (code) => window.webContents.executeJavaScript(code)
async function until(predicate, label) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await wait(40)
  }
  assert.fail(label)
}
async function click(selector) {
  await js(
    `(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing '+${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});node.click()})()`
  )
  await wait(180)
}
async function fill(selector, value) {
  // Keep focus in the input: calendar quick entry intentionally commits/closes
  // on focusout, so synthetic blur would test a different user operation.
  await js(
    `(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing input');node.focus();node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}))})()`
  )
  await wait(40)
}
async function choose(selector, value) {
  await click(selector)
  const option = `.sel-option[data-value="${value}"]`
  await until(
    () => js(`!!document.querySelector(${JSON.stringify(option)})`),
    'select option exists'
  )
  assert.equal(
    await js(`document.querySelector(${JSON.stringify(option)}).disabled`),
    false,
    'requested option is allowed'
  )
  await click(option)
}
function localParts(timestamp) {
  const date = new Date(timestamp)
  const pad = (value) => String(value).padStart(2, '0')
  return {
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    timestamp: Math.floor(timestamp / 1000) * 1000
  }
}
function dayTimestamp(offset, hour = 0, minute = 1) {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  date.setHours(hour, minute, 0, 0)
  return date.getTime()
}

async function assertPickerConfirmReachable(
  label,
  panelSelector = '.dt-panel-wrap',
  actionSelector = '.dt-btn--confirm'
) {
  const state = await js(`(()=>{
    const panel=document.querySelector(${JSON.stringify(panelSelector)}),button=panel?.querySelector(${JSON.stringify(actionSelector)});
    if(!panel || !button)return null;
    const bounds=panel.getBoundingClientRect(),rect=button.getBoundingClientRect();
    const point={x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};
    const body=panel.querySelector('.dt-panel-scroll'),footer=panel.querySelector('.dt-footer');
    const bodyBounds=body?.getBoundingClientRect();
    const items=Array.from(panel.querySelectorAll('.dt-calendar .dt-cell,.dt-shortcuts .dt-sc-chip'));
    return {panel:{left:bounds.left,right:bounds.right,top:bounds.top,bottom:bounds.bottom},
      button:{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom},point,
      viewport:{width:innerWidth,height:innerHeight},scrollTop:panel.scrollTop,
      bodyScrollTop:panel.querySelector('.dt-panel-scroll,.time-picker__scroll')?.scrollTop||0,
      calendar:body?{scrollHeight:body.scrollHeight,clientHeight:body.clientHeight,
        requiredHeight:body.scrollHeight+(footer?.getBoundingClientRect().height||0)+4,
        days:panel.querySelectorAll('.dt-calendar .dt-cell').length,
        shortcuts:panel.querySelectorAll('.dt-shortcuts .dt-sc-chip').length,
        allItemsVisible:items.every(item=>{const itemBounds=item.getBoundingClientRect();return itemBounds.width>0 && itemBounds.height>0 && itemBounds.top>=bodyBounds.top-1 && itemBounds.bottom<=bodyBounds.bottom+1})}:null,
      enabled:!button.disabled && !button.closest('[inert]'),
      hit:button.contains(document.elementFromPoint(point.x,point.y))};
  })()`)
  assert.ok(state, label + ': date/time panel and confirmation exist')
  assert.ok(
    state.enabled &&
      state.hit &&
      state.button.left >= Math.max(0, state.panel.left) - 1 &&
      state.button.right <= Math.min(state.viewport.width, state.panel.right) + 1 &&
      state.button.top >= Math.max(0, state.panel.top) - 1 &&
      state.button.bottom <= Math.min(state.viewport.height, state.panel.bottom) + 1,
    label + ': confirmation is visible and hit-testable without scrolling: ' + JSON.stringify(state)
  )
  if (state.calendar && state.calendar.requiredHeight <= state.viewport.height - 16) {
    assert.ok(
      state.calendar.scrollHeight <= state.calendar.clientHeight + 1,
      label +
        ': full calendar fits the viewport without unnecessary body scrolling: ' +
        JSON.stringify(state)
    )
    assert.equal(state.calendar.days, 42, label + ': all six calendar weeks are rendered')
    assert.equal(
      state.calendar.allItemsVisible,
      true,
      label + ': all date rows and available shortcuts are visible together'
    )
  }
  pickerEvidence.push({ label, ...state })
  return state.point
}

async function pointerClick(selector, label) {
  const point = await js(`(()=>{
    const target=document.querySelector(${JSON.stringify(selector)});
    if(!target)return null;
    const rect=target.getBoundingClientRect(),x=Math.round(rect.left+rect.width/2),y=Math.round(rect.top+rect.height/2);
    return {x,y,hit:target.contains(document.elementFromPoint(x,y)),enabled:!target.disabled && !target.closest('[inert]')};
  })()`)
  assert.ok(point?.hit && point.enabled, label + ': native pointer target is exposed')
  window.focus()
  window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    x: point.x,
    y: point.y
  })
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    x: point.x,
    y: point.y
  })
  await wait(80)
}

async function verifyCompactBody(scope, label) {
  if (checkedEditors.has(label)) return
  const selector = scope + ' .rt-textarea'
  const handleSelector = scope + ' .rt-resize'
  const controls = await js(`({
    textareas:document.querySelectorAll(${JSON.stringify(selector)}).length,
    resizeHandles:document.querySelectorAll(${JSON.stringify(handleSelector)}).length
  })`)
  assert.equal(controls.textareas, 1, label + ': exactly one body textarea exists at ' + selector)
  assert.equal(
    controls.resizeHandles,
    1,
    label + ': exactly one body resize handle exists at ' + handleSelector
  )
  const initial = await js(`(()=>{
    const textarea=document.querySelector(${JSON.stringify(selector)}),css=getComputedStyle(textarea);
    const pixels=name=>Number.parseFloat(css[name])||0;
    return {value:textarea.value,inlineHeight:textarea.style.height,scrollTop:textarea.scrollTop,rows:textarea.rows,
      height:textarea.getBoundingClientRect().height,scale:Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      lineHeight:pixels('lineHeight'),padding:pixels('paddingTop')+pixels('paddingBottom'),border:pixels('borderTopWidth')+pixels('borderBottomWidth')};
  })()`)
  const expected = Math.max(
    72 * initial.scale,
    2 * initial.lineHeight + initial.padding + initial.border
  )
  assert.equal(initial.rows, 2, label + ': default body has two rows')
  assert.ok(
    Math.abs(initial.height - expected) <= 2,
    label +
      ': compact height follows two text lines, padding and the 72rem lower bound: ' +
      JSON.stringify({ initial, expected })
  )
  await capturePicker(`body-${label}-compact.png`)
  const multiline = '第一行正文\n第二行正文\n第三行继续输入\n第四行仍可编辑\n第五行不会丢失'
  await fill(selector, multiline)
  const typed = await js(
    `(()=>{const textarea=document.querySelector(${JSON.stringify(selector)});return {value:textarea.value,scrollHeight:textarea.scrollHeight,clientHeight:textarea.clientHeight,height:textarea.getBoundingClientRect().height}})()`
  )
  assert.equal(typed.value, multiline, label + ': compact body still accepts all five lines')
  assert.ok(
    typed.scrollHeight > typed.clientHeight + 1,
    label + ': longer content scrolls inside the compact body'
  )
  assert.ok(
    Math.abs(typed.height - initial.height) <= 1,
    label + ': multiline input keeps the chosen compact height'
  )
  await js(
    `document.querySelector(${JSON.stringify(handleSelector)}).scrollIntoView({block:'center'})`
  )
  await wait(80)
  const handle = await js(
    `(()=>{const node=document.querySelector(${JSON.stringify(handleSelector)}),rect=node.getBoundingClientRect();const x=Math.round(rect.left+rect.width/2),y=Math.round(rect.top+rect.height/2);return {x,y,hit:node.contains(document.elementFromPoint(x,y))}})()`
  )
  assert.equal(handle.hit, true, label + ': resize handle is exposed for a native drag')
  window.focus()
  window.webContents.sendInputEvent({ type: 'mouseMove', x: handle.x, y: handle.y })
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    x: handle.x,
    y: handle.y
  })
  window.webContents.sendInputEvent({ type: 'mouseMove', x: handle.x, y: handle.y + 48 })
  await wait(100)
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    x: handle.x,
    y: handle.y + 48
  })
  await wait(80)
  const enlarged = await js(
    `(()=>{const textarea=document.querySelector(${JSON.stringify(selector)});return {height:textarea.getBoundingClientRect().height,value:textarea.value}})()`
  )
  assert.ok(
    enlarged.height >= initial.height + 30,
    label + ': native resize grows the compact body'
  )
  assert.equal(enlarged.value, multiline, label + ': resizing preserves every content line')
  await fill(selector, initial.value)
  await js(
    `(()=>{const textarea=document.querySelector(${JSON.stringify(selector)});textarea.style.height=${JSON.stringify(initial.inlineHeight)};textarea.scrollTop=${initial.scrollTop};textarea.dispatchEvent(new Event('scroll'))})()`
  )
  editorEvidence.push({ label, initial, expected, typed, enlarged })
  checkedEditors.add(label)
}

async function pickDateTime(trigger, timestamp) {
  const value = localParts(timestamp)
  await click(trigger)
  await until(
    () => js(`!!document.querySelector('.dt-panel-wrap .dt-header-input')`),
    'date picker opened'
  )
  await wait(200)
  await assertPickerConfirmReachable(currentView + ' initial date/time popup')
  await fill('.dt-panel-wrap .dt-header-field:first-child .dt-header-input', value.day)
  await fill('.dt-panel-wrap .dt-header-field:last-child .dt-header-input', value.time)
  await assertPickerConfirmReachable(currentView + ' edited date/time popup')
  // The native pointer moves focus and commits the typed clock on blur. Do not
  // scroll the confirmation into view or invoke its hidden DOM click handler.
  await pointerClick('.dt-panel-wrap .dt-btn--confirm', 'confirm typed date/time')
  await until(() => js(`!document.querySelector('.dt-panel-wrap')`), 'date picker committed')
  return value.timestamp
}

async function confirmCalendarTime(trigger) {
  await click(trigger)
  await until(
    () => js(`!!document.querySelector('.time-picker__panel .time-picker__done')`),
    'calendar creation time popup opened'
  )
  await wait(200)
  await assertPickerConfirmReachable(
    currentView + ' initial time popup',
    '.time-picker__panel',
    '.time-picker__done'
  )
  if (!capturedTimePickers.has(currentView)) {
    await capturePicker(`time-picker-${currentView}-initial.png`)
    capturedTimePickers.add(currentView)
  }
  await pointerClick('.time-picker__panel .time-picker__done', 'confirm calendar creation time')
  await until(
    () => js(`!document.querySelector('.time-picker__panel')`),
    'calendar creation time committed'
  )
}
async function switchView(mode) {
  if (mode !== currentView) {
    await click('.view-switcher__trigger')
    await until(
      () => js(`!!document.querySelector('.view-switcher__menu [data-view="${mode}"]')`),
      'view switch option'
    )
    await click(`.view-switcher__menu [data-view="${mode}"]`)
  }
  const page = mode === 'list' ? 'index' : mode
  window = await until(
    () =>
      BrowserWindow.getAllWindows().find(
        (target) =>
          !target.isDestroyed() &&
          new RegExp('/' + page + '\\.html(?:$|[?#])').test(target.webContents.getURL())
      ),
    mode + ' window'
  )
  await until(
    () => js(`!!document.querySelector('.view-switcher__trigger[data-active-view="${mode}"]')`),
    mode + ' renderer ready'
  )
  if (mode !== 'list') {
    await until(
      () =>
        js(
          `document.querySelectorAll('.month-day-cell[aria-disabled="false"]').length>=7 && !document.querySelector('.month-toolbar.is-busy')`
        ),
      mode + ' calendar loaded'
    )
  }
  currentView = mode
  window.setContentSize(900, 940)
  await wait(250)
}
async function selectDate(key) {
  const selector = `.month-day-cell[data-date="${key}"][aria-disabled="false"]`
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await js(`!!document.querySelector(${JSON.stringify(selector)})`)) break
    const range = await js(
      `Array.from(document.querySelectorAll('.month-day-cell[aria-disabled="false"]')).map(node=>node.dataset.date).sort()`
    )
    assert.ok(range.length, 'calendar has navigable days')
    const before = key < range[0]
    const label =
      currentView === 'week' ? (before ? '上一周' : '下一周') : before ? '上个月' : '下个月'
    await click(`.month-toolbar__month-arrow[aria-label="${label}"]`)
    await until(
      () =>
        js(
          `!document.querySelector('.month-toolbar.is-busy') && JSON.stringify(Array.from(document.querySelectorAll('.month-day-cell[aria-disabled="false"]')).map(node=>node.dataset.date).sort())!==${JSON.stringify(JSON.stringify(range))}`
        ),
      'calendar navigation settled'
    )
  }
  await until(
    () => js(`!!document.querySelector(${JSON.stringify(selector)})`),
    'target date reachable'
  )
  await click(selector)
  if (!(await js(`!!document.querySelector('.month-day-panel')`)))
    await click('.month-toolbar__day-panel-toggle')
  await until(
    () =>
      js(
        `document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-selected')==='true' && !!document.querySelector('.month-day-panel__create')`
      ),
    'selected date and sidebar ready'
  )
}
const scopeForView = () => (currentView === 'list' ? '.nnp-root' : '.month-creator')
async function openCreator(offset) {
  if (currentView === 'list') {
    await until(
      () => js(`['open','collapsed'].includes(document.querySelector('.ab-root')?.dataset.phase)`),
      'list transition settled'
    )
    if (await js(`document.querySelector('.ab-root').dataset.phase==='collapsed'`))
      await click('.ab-box:not(.ab-box--search) .ab-box-btn')
    await until(
      () => js(`document.querySelector('.ab-root').dataset.phase==='open'`),
      'list creator open'
    )
    const trigger = '.nnp-root .dt-trigger'
    if (offset === 0) {
      if (await js(`!!document.querySelector('.nnp-root .dt-clear-btn')`))
        await click('.nnp-root .dt-clear-btn')
    } else await pickDateTime(trigger, dayTimestamp(offset))
  } else {
    await selectDate(localParts(dayTimestamp(offset)).day)
    await click('.month-day-panel__create')
    await until(
      () => js(`!!document.querySelector('.month-creator textarea')`),
      'calendar detailed creator open'
    )
    // Completing an unchanged non-today clock preserves the existing fixed-day
    // scenario. Today's untouched immediate intent remains covered separately.
    if (offset !== 0) await confirmCalendarTime('.month-creator .time-picker__trigger')
  }
  await wait(220)
  await verifyCompactBody(scopeForView(), currentView + '-new')
}
function persisted(content) {
  const db = new Database(join(results.root, 'app.db'), { readonly: true })
  try {
    const notes = db.prepare('SELECT * FROM notes WHERE content=?').all(content)
    assert.equal(notes.length, 1, 'one committed note for ' + content)
    return notes[0]
  } finally {
    db.close()
  }
}
async function saveNew(content) {
  const scope = scopeForView()
  await fill(scope + ' textarea', content)
  await click(scope + ' [data-diagnostic-action="note.create"]')
  await until(
    () =>
      js(
        currentView === 'list'
          ? `document.querySelector('.nnp-root textarea')?.value==='' && document.querySelector('.nnp-submit').textContent.includes('创建便签')`
          : `!document.querySelector('.month-creator')`
      ),
    'detailed create completed'
  )
  assert.equal(
    await js(`!!document.querySelector('.month-creator')`),
    false,
    'calendar dialog is closed after create'
  )
  if (currentView === 'list')
    assert.equal(
      await js(`document.querySelector('.ab-root').dataset.phase`),
      'open',
      'list creator stays open'
    )
  return persisted(content)
}
async function setBasicNewPreferences() {
  const scope = scopeForView()
  await choose(scope + ' .note-state-fields .sel-trigger', 'in_progress')
  await choose(scope + ' .note-duration-field .sel-trigger', 'single_day')
  if (
    await js(
      `document.querySelector(${JSON.stringify(scope + ' [aria-label="置顶"]')}).getAttribute('aria-checked')==='true'`
    )
  )
    await click(scope + ' [aria-label="置顶"]')
  const selected = await js(
    `document.querySelector(${JSON.stringify(scope + ' .ts-chip.selected')})?.title || ''`
  )
  if (selected) await click(scope + ' .ts-chip[title="' + selected + '"]')
}
async function enablePopupReminder(scope) {
  assert.equal(
    await js(
      `document.querySelector(${JSON.stringify(scope + ' .reminder-channels__trigger')}).disabled`
    ),
    false,
    'future reminder control enabled'
  )
  await click(scope + ' .reminder-channels__trigger')
  if (
    await js(
      `document.querySelector('.reminder-channels__option[data-channel="2"]').getAttribute('aria-checked')!=='true'`
    )
  )
    await click('.reminder-channels__option[data-channel="2"]')
  await js(
    `document.querySelector('.reminder-channels__panel').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`
  )
  await until(
    () => js(`!document.querySelector('.reminder-channels__panel')`),
    'reminder popup closed'
  )
}
async function noteCard(id, effectiveAt) {
  if (currentView !== 'list') await selectDate(localParts(effectiveAt).day)
  const selector = `.nl-card[data-note-id="${id}"]`
  await until(
    () => js(`!!document.querySelector(${JSON.stringify(selector)})`),
    currentView + ' shows persisted note ' + id
  )
  return selector
}
async function openEditor(note) {
  const selector = await noteCard(note.id, note.effective_at)
  await js(
    `(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'center'});const rect=node.getBoundingClientRect();node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+15,clientY:rect.top+15}))})()`
  )
  await until(() => js(`!!document.querySelector('.nl-context-menu')`), 'card menu opened')
  await js(
    `[...document.querySelectorAll('.nl-context-menu button')].find(node=>node.textContent.trim()==='修改').click()`
  )
  await until(
    () => js(`!!document.querySelector('.ne-root textarea')`),
    currentView + ' complete editor opened'
  )
  await wait(250)
  await verifyCompactBody('.ne-root', currentView + '-edit')
}
async function saveEditor() {
  await until(
    () => js(`!document.querySelector('.ne-root .ne-submit').disabled`),
    'changed editor is saveable'
  )
  await click('.ne-root .ne-submit')
  await until(() => js(`!document.querySelector('.ne-root')`), 'complete editor saved')
}
const getNote = (id) => js(`window.api.getNote(${id})`)
async function verifyAcrossViews(note, tagName) {
  for (const mode of ['list', 'month', 'week']) {
    await switchView(mode)
    const selector = await noteCard(note.id, note.effective_at)
    const shown = await js(
      `(()=>{const card=document.querySelector(${JSON.stringify(selector)});return {content:card.querySelector('.nl-card-text')?.textContent,completed:card.classList.contains('nl-card--completed'),pending:card.classList.contains('nl-card--initialized')}})()`
    )
    assert.equal(shown.content, note.content, mode + ' has current committed content')
    assert.equal(shown.completed, note.status === 'completed', mode + ' completed state matches')
    assert.equal(shown.pending, note.status === 'initialized', mode + ' pending state matches')
    await openEditor(note)
    assert.equal(
      await js(`document.querySelector('.ne-root textarea').value`),
      note.content,
      mode + ' editor reads same note'
    )
    assert.equal(
      await js(
        `document.querySelector('.ne-root .note-duration-field .sel-label').textContent.trim()`
      ),
      '指定天数',
      mode + ' duration is shared'
    )
    assert.equal(
      await js(`document.querySelector('.ne-root .number-stepper input').value`),
      '3',
      mode + ' duration days are shared'
    )
    assert.equal(
      await js(
        `document.querySelector('.ne-root [aria-label="置顶"]').getAttribute('aria-checked')`
      ),
      'true',
      mode + ' pin is shared'
    )
    assert.equal(
      await js(`document.querySelector('.ne-root .ts-chip.selected')?.title`),
      tagName,
      mode + ' tag is shared'
    )
    await click('.ne-root .ne-dismiss')
    await until(
      () => js(`!document.querySelector('.ne-root')`),
      'unchanged editor closes without dirty prompt'
    )
  }
}
async function verifyQuickDefaults(offset, mode) {
  const key = localParts(dayTimestamp(offset)).day
  await selectDate(key)
  const cell = `.month-day-cell[data-date="${key}"]`
  await click(cell + ' .month-day-cell__quick-activate')
  await until(
    () =>
      js(
        `!!document.querySelector(${JSON.stringify(cell + ' .month-day-cell__quick-create input')})`
      ),
    'quick entry opened'
  )
  const content = mode + ' quick ' + offset
  await fill(cell + ' .month-day-cell__quick-create input', content)
  await click(cell + ' .month-day-cell__quick-create button')
  await until(
    () =>
      js(
        `document.querySelector(${JSON.stringify(cell + ' .month-day-cell__quick-create input')})?.value===''`
      ),
    'quick entry clears and stays open'
  )
  const note = persisted(content)
  assert.equal(
    note.status,
    offset > 0 ? 'initialized' : 'in_progress',
    'quick date derives its own status'
  )
  assert.equal(localParts(note.effective_at).day, key, 'quick entry belongs to selected date')
  assert.equal(note.duration_kind, 'single_day', 'quick entry does not inherit detailed duration')
  assert.equal(note.duration_days, 1)
  assert.equal(note.reminder_channels, 0, 'quick entry does not inherit reminders')
  assert.equal(note.is_pinned, 0, 'quick entry does not inherit pin')
  assert.deepEqual(
    await js(`window.api.getNoteTags(${note.id})`),
    [],
    'quick entry does not inherit tags'
  )
  // Non-completed records retain the legacy state timestamp in this column;
  // only completed status makes it an actual completion time in the UI.
  assert.equal(
    note.finished_at,
    note.created_at,
    'fresh quick entry stores its own state timestamp'
  )
  const card = await noteCard(note.id, note.effective_at)
  assert.equal(
    await js(`!!document.querySelector(${JSON.stringify(card + ' .nl-card-time--finished')})`),
    false,
    'quick entry does not display inherited completion'
  )
  scenarios.push(
    mode + ' quick date ' + offset + ': minimal defaults, persistence and continuous input'
  )
}

async function capturePicker(name) {
  const path = join(process.env.ABANDON_TEST_EVIDENCE_DIR || results.root, name)
  writeFileSync(path, (await window.webContents.capturePage()).toPNG())
  pickerScreenshots.push(path)
}

async function calendarCoverage(noteId) {
  return js(`Array.from(document.querySelectorAll('.month-week__events .month-event-bar[data-note-id="${noteId}"]')).flatMap(bar=>{
    const dates=Array.from(bar.closest('.month-week').querySelectorAll('.month-week__cells > .month-day-cell')).map(day=>day.dataset.date);
    const start=Number.parseInt(bar.style.gridColumnStart,10)-1;
    const span=Number((bar.style.gridColumnEnd.match(/[0-9]+/)||['1'])[0]);
    return dates.slice(start,start+span);
  })`)
}

async function verifyTodayOutline(mode) {
  const todayKey = localParts(Date.now()).day
  await selectDate(todayKey)
  const otherKey = await js(
    `Array.from(document.querySelectorAll('.month-day-cell[aria-disabled="false"]')).find(day=>day.dataset.date!==${JSON.stringify(todayKey)})?.dataset.date`
  )
  assert.ok(otherKey, mode + ' another visible date exists for selection styling')
  const readStyles = () =>
    js(`(()=>{
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
    const context=canvas.getContext('2d',{willReadFrequently:true});
    const rgba=color=>{context.clearRect(0,0,1,1);context.fillStyle=color;context.fillRect(0,0,1,1);return Array.from(context.getImageData(0,0,1,1).data)};
    const style=date=>{const node=document.querySelector('.month-day-cell[data-date="'+date+'"]'),css=getComputedStyle(node);return {selected:node.classList.contains('is-selected'),background:css.backgroundColor,rgba:rgba(css.borderColor),todayBorder:css.getPropertyValue('--calendar-today-border').trim(),border:css.borderColor,borderWidth:css.borderWidth,shadow:css.boxShadow}};
    return {today:style(${JSON.stringify(todayKey)}),other:style(${JSON.stringify(otherKey)})};
  })()`)
  const transparent = (color) =>
    color === 'transparent' ||
    /rgba\([^)]*,\s*0(?:\.0+)?\)/.test(color) ||
    /\/\s*0(?:\.0+)?\)/.test(color)
  const todaySelected = await readStyles()
  assert.equal(todaySelected.today.selected, true, mode + ' today can be selected')
  assert.equal(
    transparent(todaySelected.today.background),
    true,
    mode + ' selected today keeps a transparent background'
  )
  assert.equal(
    transparent(todaySelected.other.background),
    true,
    mode + ' ordinary date has no fill'
  )
  await selectDate(otherKey)
  const otherSelected = await readStyles()
  assert.equal(
    otherSelected.today.selected,
    false,
    mode + ' today is independently marked when another date is selected'
  )
  assert.equal(
    transparent(otherSelected.today.background),
    true,
    mode + ' unselected today keeps a transparent background'
  )
  assert.equal(otherSelected.other.selected, true)
  assert.equal(
    transparent(otherSelected.other.background),
    true,
    mode + ' selected ordinary date still has no fill'
  )
  assert.notEqual(
    otherSelected.other.border,
    todaySelected.other.border,
    mode + ' selected date keeps its distinct border'
  )
  assert.notEqual(
    otherSelected.other.shadow,
    'none',
    mode + ' selection inset edge remains visible'
  )
  for (const today of [todaySelected.today, otherSelected.today]) {
    assert.deepEqual(today.rgba, [255, 69, 58, 255], mode + ' today keeps its red outline')
    assert.equal(today.borderWidth, '1px', mode + ' today outline does not change cell geometry')
    assert.equal(today.todayBorder, '#ff453a')
  }
  assert.notEqual(
    todaySelected.today.shadow,
    'none',
    mode + ' selected today retains its selection inset'
  )
  const todayPoint = await js(
    `(()=>{const r=document.querySelector('.month-day-cell[data-date="${todayKey}"]').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+8)}})()`
  )
  window.webContents.sendInputEvent({ type: 'mouseMove', ...todayPoint })
  await wait(240)
  const hovered = await readStyles()
  assert.deepEqual(
    hovered.today.rgba,
    otherSelected.today.rgba,
    mode + ' hover preserves today red outline'
  )
  assert.equal(transparent(hovered.today.background), true, mode + ' hover keeps today transparent')
  const previous = await js('window.api.getSettingsSnapshot().then(snapshot=>snapshot.values.css)')
  const previousBackgroundImage = await js(
    `document.querySelector('.app-bg').style.backgroundImage`
  )
  if (
    await js(
      `document.querySelector('.month-toolbar__day-panel-toggle')?.getAttribute('aria-expanded')==='true'`
    )
  )
    await click('.month-toolbar__day-panel-toggle')
  await until(
    () => js(`!document.querySelector('.month-day-panel')`),
    mode + ' calendar screenshot has no sidebar'
  )
  const backgrounds = []
  for (const [name, bg, fg, image] of [
    ['white', '255 255 255', '#111111', 'none'],
    ['black', '0 0 0', '#ffffff', 'none'],
    [
      'complex',
      '24 32 42',
      '#ffffff',
      'repeating-linear-gradient(35deg,#174159 0px,#583a50 40px,#326f40 90px)'
    ]
  ]) {
    await js(
      `(async()=>{await window.api.setSettingValue('css.bgColor',${JSON.stringify(bg)});await window.api.setSettingValue('css.textColor',${JSON.stringify(fg)});document.querySelector('.app-bg').style.backgroundImage=${JSON.stringify(image)}})()`
    )
    await wait(220)
    await until(
      () => js(`!document.querySelector('.msg-toast')`),
      mode + ' ' + name + ' calendar screenshot waits for Toast to disappear naturally'
    )
    const styles = await readStyles()
    assert.deepEqual(
      styles.today.rgba,
      otherSelected.today.rgba,
      mode + ' ' + name + ' background preserves the red today outline'
    )
    assert.equal(
      styles.other.selected,
      true,
      mode + ' ' + name + ' selected ordinary date remains selected'
    )
    assert.notEqual(
      styles.other.shadow,
      'none',
      mode + ' ' + name + ' selected ordinary date keeps its inset edge'
    )
    backgrounds.push({ name, bg, fg, image, styles })
    await capturePicker(`calendar-${mode}-today-${name}.png`)
  }
  calendarEvidence.push({ mode, todayKey, otherKey, todaySelected, otherSelected, backgrounds })
  await js(
    `(async()=>{await window.api.setSettingValue('css.bgColor',${JSON.stringify(previous.bgColor)});await window.api.setSettingValue('css.textColor',${JSON.stringify(previous.textColor)});document.querySelector('.app-bg').style.backgroundImage=${JSON.stringify(previousBackgroundImage)}})()`
  )
  scenarios.push(mode + ' transparent today red outline persists with hover and date selection')
}

async function verifyNativeDateSelection() {
  await switchView('month')
  const previous = await js(
    'window.api.getSettingsSnapshot().then(snapshot=>({css:snapshot.values.css,scale:snapshot.values.appearance.uiScale}))'
  )
  const backgrounds = await js(
    `({body:document.body.style.background,image:document.querySelector('.app-bg').style.backgroundImage})`
  )
  await js(
    `(async()=>{await window.api.setSettingValue('css.fontSizeBase',20);await window.api.setSettingValue('appearance.uiScale',1)})()`
  )
  window.setContentSize(1199, 835)
  await wait(250)
  const sourceTime = dayTimestamp(-3, 9, 0)
  const targetTime = dayTimestamp(-2, 9, 0)
  const source = localParts(sourceTime)
  const target = localParts(targetTime)
  const content = '日期格真实点击回归\n保留完整编辑器正文与备注'
  const note = await js(
    `window.api.createNote(${JSON.stringify({ content, remark: '检查生效日期选择、确认和保存。', effectiveAt: sourceTime, durationKind: 'single_day', status: 'in_progress' })})`
  )
  await selectDate(source.day)
  await until(
    async () => JSON.stringify(await calendarCoverage(note.id)) === JSON.stringify([source.day]),
    'seed single-day note appears only on its original calendar date'
  )
  await openEditor(note)
  await click('.ne-root .ne-field-row .dt-trigger')
  await until(
    () => js(`!!document.querySelector('.dt-panel-wrap .dt-header-input')`),
    '1199x835 editor date/time popup opened'
  )
  await wait(200)
  await assertPickerConfirmReachable('1199x835 base20 initial complete editor')
  const index = await js(`(()=>{
    const header=document.querySelector('.dt-panel-wrap .dt-header-field:first-child input').value.slice(0,7);
    const target=${JSON.stringify(target.day)},isOther=target.slice(0,7)!==header;
    return Array.from(document.querySelectorAll('.dt-panel-wrap .dt-calendar .dt-cell')).findIndex(cell=>
      cell.classList.contains('is-other')===isOther && cell.textContent.trim()===String(Number(target.slice(-2))));
  })()`)
  assert.ok(index >= 0, 'target date is present in the actual picker grid')
  const dateCell = `.dt-panel-wrap .dt-calendar .dt-cell:nth-child(${index + 1})`
  // Date rows belong to the scrollable body. Confirmation stays outside it and
  // is checked before and after this intentional calendar-content scroll.
  await js(`document.querySelector(${JSON.stringify(dateCell)}).scrollIntoView({block:'nearest'})`)
  await pointerClick(dateCell, 'native calendar date cell')
  await until(
    () =>
      js(
        `document.querySelector('.dt-panel-wrap .dt-header-field:first-child input')?.value===${JSON.stringify(target.day)}`
      ),
    'native day click updates the displayed date draft'
  )
  await assertPickerConfirmReachable('after native day selection and calendar-content scroll')
  assert.equal(
    await js(`document.querySelector('.ne-root .ne-field-row .dt-label').textContent.trim()`),
    localParts(note.effective_at).day + ' ' + localParts(note.effective_at).time,
    'selected day stays a draft until explicit confirmation'
  )

  for (const [name, bg, fg, image] of [
    ['white', '255 255 255', '#111111', 'none'],
    ['black', '0 0 0', '#ffffff', 'none'],
    [
      'complex',
      '24 32 42',
      '#ffffff',
      'repeating-linear-gradient(35deg,#174159 0px,#583a50 40px,#326f40 90px)'
    ]
  ]) {
    await js(
      `(async()=>{await window.api.setSettingValue('css.bgColor',${JSON.stringify(bg)});await window.api.setSettingValue('css.textColor',${JSON.stringify(fg)});document.querySelector('.app-bg').style.backgroundImage=${JSON.stringify(image)}})()`
    )
    await wait(220)
    await assertPickerConfirmReachable('1199x835 base20 ' + name)
    await capturePicker(`datetime-picker-editor-${name}-100.png`)
  }
  await pointerClick(
    '.dt-panel-wrap .dt-btn--confirm',
    'native confirmation after calendar selection'
  )
  await until(
    () => js(`!document.querySelector('.dt-panel-wrap')`),
    'native calendar selection confirmed'
  )
  assert.equal(
    await js(`document.querySelector('.ne-root .ne-field-row .dt-label').textContent.trim()`),
    target.day + ' ' + target.time,
    'native confirmation applies the selected target to the editor draft'
  )
  window.setContentSize(360, 560)
  await js("window.api.setSettingValue('appearance.uiScale',1.5)")
  await wait(300)
  // Resizing can correctly hide the original anchor and dismiss its popup.
  // Expose the trigger first, then audit a fresh popup in the smaller viewport.
  await click('.ne-root .ne-field-row .dt-trigger')
  await until(
    () => js(`!!document.querySelector('.dt-panel-wrap .dt-btn--confirm')`),
    'narrow editor date/time popup reopened from its visible trigger'
  )
  await wait(200)
  await assertPickerConfirmReachable('360x560 editor at 150 percent')
  await capturePicker('datetime-picker-editor-narrow-150.png')
  await pointerClick(
    '.dt-panel-wrap .dt-btn--confirm',
    'narrow native confirmation keeps the target'
  )
  await until(
    () => js(`!document.querySelector('.dt-panel-wrap')`),
    'narrow unchanged date/time confirmed'
  )
  window.setContentSize(1199, 835)
  await js("window.api.setSettingValue('appearance.uiScale',1)")
  await wait(220)
  await saveEditor()
  const saved = persisted(content)
  assert.equal(
    saved.effective_at,
    target.timestamp,
    'SQLite persists the selected calendar date and original clock'
  )
  assert.equal(saved.duration_kind, 'single_day')
  assert.equal(saved.content, note.content)
  assert.equal(saved.remark, note.remark)
  assert.equal(saved.created_at, note.created_at)
  await until(async () => {
    const dates = await calendarCoverage(note.id)
    return dates.length === 1 && dates[0] === target.day
  }, 'calendar bar leaves the old day and renders only on the selected target day')
  assert.equal(
    (await calendarCoverage(note.id)).includes(source.day),
    false,
    'old date no longer contains the moved single-day bar'
  )
  await selectDate(source.day)
  await until(
    () => js(`!document.querySelector('.month-day-panel .nl-card[data-note-id="${note.id}"]')`),
    'old date sidebar no longer contains the edited note'
  )
  await selectDate(target.day)
  await until(
    () => js(`!!document.querySelector('.month-day-panel .nl-card[data-note-id="${note.id}"]')`),
    'target date sidebar shows the saved note'
  )
  await js(
    `(async()=>{await window.api.setSettingValue('css.fontSizeBase',${JSON.stringify(previous.css.fontSizeBase)});await window.api.setSettingValue('appearance.uiScale',${JSON.stringify(previous.scale)});await window.api.setSettingValue('css.bgColor',${JSON.stringify(previous.css.bgColor)});await window.api.setSettingValue('css.textColor',${JSON.stringify(previous.css.textColor)});document.body.style.background=${JSON.stringify(backgrounds.body)};document.querySelector('.app-bg').style.backgroundImage=${JSON.stringify(backgrounds.image)}})()`
  )
  scenarios.push(
    '1199x835/base20 native date-cell and fixed confirmation: SQLite, original-day removal, target-day calendar and sidebar, three themes and narrow150'
  )
}

async function verifyTemplateDateActions() {
  await click('.titlebar-btn-template')
  await until(
    () => js(`!!document.querySelector('.tcp-box')`),
    'template workspace opened for shared picker audit'
  )
  await click('.tcp-box')
  await until(
    () => js(`!!document.querySelector('.tcp-content.visible .tf-root')`),
    'template creation form opened without saving'
  )
  await verifyCompactBody('.tcp-content .tf-root', 'template-new')
  for (const [index, name] of [
    [1, 'start'],
    [2, 'end']
  ]) {
    await click(`.tcp-content .tf-time-range > .tf-row:nth-child(${index}) .dt-trigger`)
    await until(
      () => js(`!!document.querySelector('.dt-panel-wrap .dt-btn--confirm')`),
      'template ' + name + ' popup opened'
    )
    await wait(200)
    await assertPickerConfirmReachable('template ' + name + ' initial confirmation')
    await capturePicker(`datetime-picker-template-${name}-100.png`)
    await pointerClick(
      '.dt-panel-wrap .dt-btn--confirm',
      'template ' + name + ' native confirmation'
    )
    await until(
      () => js(`!document.querySelector('.dt-panel-wrap')`),
      'template ' + name + ' popup closed'
    )
  }
  await js('window.__clearEditingDrafts?.()')
  await click('.titlebar-btn-template')
  await until(
    () => js(`!document.querySelector('.tcp-box')`),
    'template workspace closed without submitting'
  )
  scenarios.push(
    'template start/end shared date popup confirmations visible and native-clickable; no template saved'
  )
}
async function run() {
  try {
    window = await until(
      () =>
        BrowserWindow.getAllWindows().find((target) =>
          /\/index\.html(?:$|[?#])/.test(target.webContents.getURL())
        ),
      'initial list window'
    )
    await switchView('list')
    if (await js(`!!document.querySelector('[aria-label="快捷键启用提示"] .app-modal-close')`))
      await click('[aria-label="快捷键启用提示"] .app-modal-close')
    const tag = await js(`window.api.createTag('threeview','#0071e3')`)
    const completedNotes = []
    for (const mode of ['list', 'month', 'week']) {
      console.log('[three-view-rules] ' + mode + ' detailed create and full edit')
      await switchView(mode)
      await openCreator(0)
      const scope = scopeForView()
      if (mode === 'list') {
        assert.equal(
          await js(
            `document.querySelector('.nnp-root .note-state-fields .sel-label').textContent.trim()`
          ),
          '进行中',
          'fresh launch defaults to progress'
        )
        assert.equal(
          await js(
            `document.querySelector('.nnp-root .note-duration-field .sel-label').textContent.trim()`
          ),
          '仅当天',
          'fresh launch defaults to single day'
        )
      }
      await setBasicNewPreferences()
      const today = await saveNew(mode + ' detailed immediate')
      assert.equal(today.status, 'in_progress', mode + ' default today creates in progress')
      assert.equal(
        today.effective_at,
        today.created_at,
        mode + ' untouched today time is one immediate commit'
      )
      assert.equal(today.duration_kind, 'single_day')
      assert.equal(today.reminder_channels, 0, mode + ' immediate note has no start reminder')
      scenarios.push(mode + ' detailed current-day immediate creation')

      await openCreator(-1)
      await choose(scope + ' .note-state-fields .sel-trigger', 'completed')
      const historicalFinish = await pickDateTime(
        scope + ' .note-state-fields__completion .dt-trigger',
        dayTimestamp(-1, 12, 0)
      )
      const history = await saveNew(mode + ' detailed historical completed')
      assert.equal(history.status, 'completed', mode + ' historical creation can be completed')
      assert.equal(history.effective_at, dayTimestamp(-1))
      assert.equal(history.finished_at, historicalFinish)
      assert.equal(history.reminder_channels, 0, mode + ' no retroactive start reminder')
      scenarios.push(mode + ' detailed historical completion with actual time')

      await openCreator(1)
      assert.equal(
        await js(
          `document.querySelector(${JSON.stringify(scope + ' .note-state-fields .sel-label')}).textContent.trim()`
        ),
        '未开始',
        mode + ' future forces pending despite remembered completed choice'
      )
      await click(scope + ' .note-state-fields .sel-trigger')
      assert.deepEqual(
        await js(
          `Array.from(document.querySelectorAll('.sel-option')).map(node=>({value:node.dataset.value,disabled:node.disabled}))`
        ),
        [
          { value: 'initialized', disabled: false },
          { value: 'in_progress', disabled: true },
          { value: 'completed', disabled: true }
        ],
        mode + ' future allows only pending'
      )
      await click(scope + ' .note-state-fields .sel-trigger')
      await choose(scope + ' .note-duration-field .sel-trigger', 'fixed_days')
      await fill(scope + ' .number-stepper input', '3')
      await click(scope + ' [aria-label="置顶"]')
      await until(
        () =>
          js(`!!document.querySelector(${JSON.stringify(scope + ' .ts-chip[title="threeview"]')})`),
        'tag loaded in detailed creator'
      )
      await click(scope + ' .ts-chip[title="threeview"]')
      await enablePopupReminder(scope)
      const future = await saveNew(mode + ' detailed future pending')
      assert.equal(future.status, 'initialized')
      assert.equal(localParts(future.effective_at).day, localParts(dayTimestamp(1)).day)
      assert.equal(
        future.finished_at,
        future.created_at,
        'fresh pending record retains legacy state timestamp'
      )
      assert.equal(future.reminder_channels, 2)
      assert.equal(future.duration_kind, 'fixed_days')
      assert.equal(future.duration_days, 3)
      assert.equal(future.is_pinned, 1)
      assert.deepEqual(
        (await js(`window.api.getNoteTags(${future.id})`)).map((item) => item.id),
        [tag.id]
      )
      scenarios.push(mode + ' detailed future appointment, state restrictions and rich settings')

      // Exercise the full editor from each view's real NoteCard context menu.
      await openEditor(future)
      assert.equal(
        await js(`!!document.querySelector('.ne-root .note-state-fields__completion')`),
        false,
        mode + ' pending editor hides the completion field'
      )
      await fill('.ne-root textarea', mode + ' pending body correction')
      await saveEditor()
      const pendingBodyEdited = await getNote(future.id)
      assert.equal(
        pendingBodyEdited.status,
        'initialized',
        mode + ' body-only edit retains pending'
      )
      assert.equal(
        pendingBodyEdited.effective_at,
        future.effective_at,
        mode + ' body-only edit retains exact start time'
      )
      assert.equal(
        pendingBodyEdited.finished_at,
        future.finished_at,
        mode + ' body-only edit retains exact legacy state timestamp'
      )
      assert.equal(
        pendingBodyEdited.reminder_channels,
        2,
        mode + ' body-only edit retains appointment reminder'
      )
      await openEditor(pendingBodyEdited)
      const backfilledStart = await pickDateTime(
        '.ne-root .ne-field-row .dt-trigger',
        dayTimestamp(-1)
      )
      await choose('.ne-root .note-state-fields .sel-trigger', 'completed')
      const backfilledFinish = await pickDateTime(
        '.ne-root .note-state-fields__completion .dt-trigger',
        dayTimestamp(-1, 13, 0)
      )
      await fill('.ne-root textarea', mode + ' future corrected to history')
      await saveEditor()
      const backfilled = await getNote(future.id)
      assert.equal(backfilled.status, 'completed', mode + ' edit future to historical completed')
      assert.equal(backfilled.effective_at, backfilledStart)
      assert.equal(backfilled.finished_at, backfilledFinish)
      assert.equal(
        backfilled.reminder_channels,
        0,
        mode + ' edit does not back-send start reminder'
      )
      assert.equal(backfilled.duration_days, 3, mode + ' editing business times preserves duration')
      assert.equal(backfilled.is_pinned, 1)
      completedNotes.push(backfilled)

      await openEditor(today)
      await choose('.ne-root .note-state-fields .sel-trigger', 'completed')
      await saveEditor()
      const finished = await getNote(today.id)
      assert.equal(
        finished.effective_at,
        today.effective_at,
        mode + ' complete retains original start'
      )
      assert.equal(finished.finished_at, finished.updated_at, mode + ' complete uses commit time')
      await openEditor(finished)
      await choose('.ne-root .note-state-fields .sel-trigger', 'in_progress')
      await saveEditor()
      const reopened = await getNote(today.id)
      assert.equal(reopened.status, 'in_progress')
      assert.equal(reopened.finished_at, null, mode + ' reopen clears completion')
      assert.equal(reopened.effective_at, today.effective_at)
      await openEditor(reopened)
      const futureStart = await pickDateTime(
        '.ne-root .ne-field-row .dt-trigger',
        dayTimestamp(1, 12, 0)
      )
      assert.equal(
        await js(`!!document.querySelector('.ne-root .note-state-fields__completion')`),
        false,
        mode + ' rescheduled pending editor has no completion field'
      )
      await saveEditor()
      const moved = await getNote(today.id)
      assert.equal(
        moved.status,
        'initialized',
        mode + ' in-progress edit to future derives pending'
      )
      assert.equal(moved.effective_at, futureStart)
      assert.equal(
        moved.finished_at,
        moved.updated_at,
        mode + ' progress-to-pending records the state change timestamp'
      )
      scenarios.push(
        mode + ' full editor: pending to history, complete, reopen and future reschedule'
      )

      if (mode !== 'list') {
        console.log('[three-view-rules] ' + mode + ' quick creation defaults')
        for (const offset of [-1, 0, 1]) await verifyQuickDefaults(offset, mode)
        await verifyTodayOutline(mode)
      }
    }
    console.log('[three-view-rules] cross-view committed data consistency')
    for (const note of completedNotes) await verifyAcrossViews(note, 'threeview')
    scenarios.push(
      'all three source views: committed edits/temporal state/duration/pin/tag agree in all three destination views'
    )
    await verifyNativeDateSelection()
    await verifyTemplateDateActions()
    await js('window.__clearEditingDrafts?.()')
    console.log(
      'Three-view ordinary-note creation, full editing, quick defaults and shared persistence passed'
    )
    await results.finish({
      completed: true,
      window,
      summary: { scenarios, pickerEvidence, pickerScreenshots, calendarEvidence, editorEvidence }
    })
  } catch (error) {
    console.error(error)
    if (window && !window.isDestroyed()) await js('window.__clearEditingDrafts?.()').catch(() => {})
    await results.finish({
      error,
      window,
      summary: { scenarios, pickerEvidence, pickerScreenshots, calendarEvidence, editorEvidence }
    })
  }
}

app.once('ready', () => void run())
const require = createRequire(import.meta.url)
require(resolve('out/main/index.js'))
const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
  /^index-[\w-]+\.js$/.test(name)
)
assert.ok(chunk, 'built main entry chunk exists')
require(resolve('out/main/chunks', chunk))
