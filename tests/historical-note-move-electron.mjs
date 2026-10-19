import { readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'
import {
  addCalendarDays,
  localDateKey,
  localMidnightTimestamp
} from '../src/shared/calendar/calendar-date-rules.js'

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/historical-note-move-electron.mjs',
  mode: 'electron-ready-real-app-historical-move',
  prefix: 'abandon-note-historical-move-',
  metadata: {
    realWindows: true,
    diskDatabase: true,
    runtimeAppBootstrap: true,
    realQuickCreateControls: true,
    quickCreateDates: ['today', 'history', 'future'],
    rendererApiMocked: false,
    nativePointerInput: false,
    mainProcessRestart: false
  },
  timeoutMs: 120000
})
const { assert, root } = lifecycle
const today = localDateKey()
const yesterday = addCalendarDays(today, -1)
const past = localMidnightTimestamp(yesterday) + 60_000
const future = localMidnightTimestamp(addCalendarDays(today, 1)) + 60_000
const trigger = '.historical-note-move__trigger'
const quickToggle = '[data-quick-create-until-completed]'
let current
let currentMode = 'month'
const scenarios = []
const quickCreateEvidence = []
const transitionEvidence = []
const captures = []
let failureDiagnostics = null
const js = (source) => current.webContents.executeJavaScript(source)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The normal business scenarios keep the actual handlers. Only the later
// animation scenarios control preview response timing and row counts; they
// never create or move their fixture IDs in the isolated profile database.
let controlledPreview = false
let moveCommandCalls = 0
const pendingPreviews = []
const originalHandle = ipcMain.handle
ipcMain.handle = function (channel, handler) {
  if (channel === 'notes:preview-historical-move') {
    return originalHandle.call(this, channel, (...args) => {
      if (!controlledPreview) return handler(...args)
      const request = args[1] || {}
      const scope =
        request.scope === 'all'
          ? 'all'
          : request.startDateKey === request.endDateKey
            ? 'yesterday'
            : 'recent3'
      return new Promise((resolve) => pendingPreviews.push({ scope, request, resolve }))
    })
  }
  if (channel === 'notes:move-historical-to-today') {
    return originalHandle.call(this, channel, (...args) => {
      moveCommandCalls += 1
      if (controlledPreview) throw new Error('Controlled preview must not submit a move')
      return handler(...args)
    })
  }
  return originalHandle.call(this, channel, handler)
}

function previewFixture(scope, request = {}) {
  const count = { yesterday: 1, recent3: 3, all: 5 }[scope]
  const index = ['yesterday', 'recent3', 'all'].indexOf(scope)
  const notes = Array.from({ length: count }, (_, row) => ({
    id: 900001 + index * 100 + row,
    content: `${scope} 范围过渡便签 ${row + 1}${scope === 'all' ? '\n保留第二行，检查结果区真实高度' : ''}`,
    dateKey: addCalendarDays(yesterday, -(scope === 'all' ? row * 2 : row)),
    durationKind: 'single_day',
    durationDays: 1,
    canMove: true,
    disabledReason: ''
  }))
  return {
    scope: request.scope || (scope === 'all' ? 'all' : 'range'),
    targetDateKey: today,
    startDateKey: request.startDateKey || null,
    endDateKey: request.endDateKey || yesterday,
    count,
    movableCount: count,
    disabledCount: 0,
    limit: 50,
    offset: 0,
    hasMore: false,
    notes
  }
}

async function pendingPreview(scope) {
  await until(
    () => pendingPreviews.some((item) => item.scope === scope),
    scope + ' preview IPC pending'
  )
  const index = pendingPreviews.findIndex((item) => item.scope === scope)
  return pendingPreviews.splice(index, 1)[0]
}

function releasePreview(request) {
  request.resolve(previewFixture(request.scope, request.request))
}

function restorePreviewControl() {
  controlledPreview = false
  for (const request of pendingPreviews.splice(0)) releasePreview(request)
  ipcMain.handle = originalHandle
}
async function until(predicate, label) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if (await predicate()) {
      assert.ok(true, label)
      return
    }
    await wait(30)
  }
  assert.fail(label)
}
const stable = () =>
  js(
    "Boolean(document.querySelector('.month-day-cell')) && !document.querySelector('.month-toolbar')?.classList.contains('is-busy')"
  )
const modal = () =>
  js(`Boolean(document.querySelector('[role="dialog"][aria-label="便签延续与移动"]'))`)
const click = (selector) =>
  js(
    `(() => { const target=document.querySelector(${JSON.stringify(selector)}); target.focus(); target.click() })()`
  )
const getNote = (id) => js(`window.api.getNote(${id})`)
async function create(content, options = {}) {
  return js(`window.api.createNote(${JSON.stringify({ content, effectiveAt: past, ...options })})`)
}
async function open() {
  await until(stable, 'calendar settled before opening')
  assert.equal(await js(`document.querySelector('${trigger}').title`), '便签延续与移动')
  assert.equal(
    await js(`document.querySelector('${trigger}').getAttribute('aria-label')`),
    '便签延续与移动'
  )
  await click(trigger)
  await until(modal, 'move dialog opened')
  await until(
    () =>
      js(
        "Boolean(document.querySelector('[data-move-preview]')) && document.querySelector('[data-move-results-viewport]')?.dataset.state==='ready'"
      ),
    'move preview loaded'
  )
  assert.equal(await js("document.querySelector('.month-scene').inert"), true)
}
async function close() {
  await until(
    () =>
      js(
        `!document.querySelector('#historical-move-auto-toggle')?.disabled && !document.querySelector('${quickToggle}')?.disabled`
      ),
    'independent setting saves settled before closing'
  )
  await until(
    () =>
      js(
        `Boolean(document.activeElement?.closest('[role="dialog"][aria-label="便签延续与移动"]'))`
      ),
    'keyboard focus entered move dialog'
  )
  current.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESCAPE' })
  current.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESCAPE' })
  await until(async () => !(await modal()), 'Escape closes move dialog')
  await until(
    () => js(`document.activeElement === document.querySelector('${trigger}')`),
    'focus restored to move trigger'
  )
}
function seedSettings() {
  const db = new Database(join(root, 'app.db'))
  db.exec(`CREATE TABLE app_settings (window_name TEXT NOT NULL, type TEXT NOT NULL,
    key TEXT NOT NULL, value TEXT, remark TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER,
    PRIMARY KEY(window_name,key))`)
  const insert = db.prepare('INSERT INTO app_settings(window_name,type,key,value) VALUES(?,?,?,?)')
  insert.run('application', 'application', 'active_view', 'month')
  insert.run('application', 'remote', 'receive_notices', 'false')
  insert.run('application', 'remote', 'upload_device_info', 'false')
  insert.run('application', 'onboarding', 'first_use_notice_version', '1')
  for (const view of ['month', 'week']) insert.run(view, 'system', 'blur_enabled', 'false')
  db.close()
}
async function switchView(mode) {
  await js(`window.api.switchMainView('${mode}')`)
  await until(
    () =>
      BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes(`/${mode}.html`)),
    `${mode} page loaded`
  )
  current = BrowserWindow.getAllWindows().find((w) =>
    w.webContents.getURL().includes(`/${mode}.html`)
  )
  currentMode = mode
  await until(stable, `${mode} calendar ready`)
}

function persistedQuickNote(content) {
  const db = new Database(join(root, 'app.db'), { readonly: true })
  try {
    return db.prepare('SELECT * FROM notes WHERE content = ?').get(content)
  } finally {
    db.close()
  }
}

function assertQuickSettingOnDisk(enabled) {
  const db = new Database(join(root, 'app.db'), { readonly: true })
  try {
    assert.equal(
      db
        .prepare(
          "SELECT value FROM app_settings WHERE window_name = 'application' AND key = 'quick_create_until_completed'"
        )
        .get()?.value,
      enabled ? '1' : '0',
      'quick duration preference must persist in the shared application setting'
    )
  } finally {
    db.close()
  }
}

async function expectQuickSetting(enabled, label) {
  await until(
    () =>
      js(`(async () => {
        const toggle = document.querySelector('${quickToggle}')
        const snapshot = await window.api.getSettingsSnapshot()
        return Boolean(toggle && !toggle.disabled && toggle.getAttribute('role') === 'switch' &&
          toggle.getAttribute('aria-checked') === '${enabled}' &&
          snapshot.values.notes.quickCreateUntilCompleted === ${enabled})
      })()`),
    label
  )
  assert.equal(
    await js(
      `document.getElementById(document.querySelector('${quickToggle}').getAttribute('aria-labelledby'))?.textContent.trim()`
    ),
    '快捷新建默认持续到完成',
    'the quick-create switch must have its own accessible label'
  )
}

async function setQuickSetting(enabled) {
  const before = await js('window.api.getSettingsSnapshot().then(s => s.values.notes)')
  assert.equal(before.quickCreateUntilCompleted, !enabled, 'the real switch must change state')
  await click(quickToggle)
  await expectQuickSetting(enabled, `quick duration setting saved as ${enabled}`)
  assertQuickSettingOnDisk(enabled)
  assert.equal(
    await js('window.api.getSettingsSnapshot().then(s => s.values.notes.autoMoveToToday)'),
    before.autoMoveToToday,
    'the quick duration switch must not change automatic movement'
  )
}

async function reachQuickDate(key) {
  const selector = `.month-day-cell[data-date="${key}"][aria-disabled="false"]`
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) break
    const range = await js(
      `Array.from(document.querySelectorAll('.month-day-cell[aria-disabled="false"]')).map(cell => cell.dataset.date).sort()`
    )
    assert.ok(range.length > 0, 'calendar must expose active dates for quick creation')
    const before = key < range[0]
    const label =
      currentMode === 'week' ? (before ? '上一周' : '下一周') : before ? '上个月' : '下个月'
    await click(`.month-toolbar__month-arrow[aria-label="${label}"]`)
    await until(
      () =>
        js(`!document.querySelector('.month-toolbar.is-busy') &&
        JSON.stringify(Array.from(document.querySelectorAll('.month-day-cell[aria-disabled="false"]')).map(cell => cell.dataset.date).sort()) !== ${JSON.stringify(JSON.stringify(range))}`),
      'calendar navigated to the quick-create date'
    )
  }
  await until(
    () => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),
    `${currentMode} quick-create date ${key} is available`
  )
  await click(selector)
  return selector
}

async function createQuickNote(offset, durationKind, label) {
  const key = addCalendarDays(today, offset)
  const cell = await reachQuickDate(key)
  const input = `${cell} .month-day-cell__quick-create input`
  if (!(await js(`Boolean(document.querySelector(${JSON.stringify(input)}))`))) {
    await click(`${cell} .month-day-cell__quick-activate`)
  }
  await until(
    () => js(`Boolean(document.querySelector(${JSON.stringify(input)}))`),
    'the real date-cell quick input opened'
  )
  const content = `${currentMode} ${label} ${offset}`
  await js(`(() => {
    const input = document.querySelector(${JSON.stringify(input)})
    input.focus()
    input.value = ${JSON.stringify(content)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  const beforeSubmit = Date.now()
  await click(`${cell} .month-day-cell__quick-create button[type="submit"]`)
  await until(
    () => Boolean(persistedQuickNote(content)),
    'quick creation committed one note through the real preload and database'
  )
  const afterSubmit = Date.now()
  await until(
    () => js(`document.querySelector(${JSON.stringify(input)})?.value === ''`),
    'quick creation cleared its draft for continuous entry'
  )
  const note = persistedQuickNote(content)
  assert.equal(
    note.duration_kind,
    durationKind,
    'quick creation uses the current shared preference'
  )
  assert.equal(note.duration_days, 1)
  assert.equal(note.status, offset > 0 ? 'initialized' : 'in_progress')
  assert.equal(localDateKey(note.effective_at), key, 'the chosen effective date must be retained')
  if (offset === 0) {
    assert.ok(
      note.effective_at >= beforeSubmit && note.effective_at <= afterSubmit,
      'today quick creation must keep its immediate effective-time semantics'
    )
  } else {
    assert.equal(
      note.effective_at,
      localMidnightTimestamp(key) + 60_000,
      'non-today quick creation keeps the existing 00:01 effective time'
    )
    if (offset > 0)
      assert.ok(note.effective_at > afterSubmit, 'future quick notes must remain scheduled')
  }
  assert.equal(note.reminder_channels, 0, 'the duration preference must not enable reminders')
  assert.equal(note.is_pinned, 0, 'the duration preference must not pin quick-created notes')
  assert.deepEqual(await js(`window.api.getNoteTags(${note.id})`), [])
  assert.equal((await getNote(note.id)).duration_kind, durationKind)
  quickCreateEvidence.push({ mode: currentMode, offset, label, beforeSubmit, afterSubmit, note })
  return note
}

async function assertQuickNotesUnchanged(notes, label) {
  for (const original of notes) {
    const actual = await getNote(original.id)
    assert.equal(actual.duration_kind, original.duration_kind, label + ': duration kind')
    assert.equal(actual.effective_at, original.effective_at, label + ': effective timestamp')
    assert.equal(actual.status, original.status, label + ': scheduled/active status')
  }
}

async function verifyQuickCreateUntilCompleted() {
  await expectQuickSetting(false, 'new global quick-duration preference defaults off')
  await click('#historical-move-auto-toggle')
  await until(
    () =>
      js('window.api.getSettingsSnapshot().then(s => s.values.notes.autoMoveToToday === false)'),
    'automatic movement can be disabled independently before quick-create scenarios'
  )
  await expectQuickSetting(
    false,
    'automatic movement does not enable the quick-duration preference'
  )
  await close()
  const baseline = await createQuickNote(0, 'single_day', '默认单日')
  await open()
  await setQuickSetting(true)
  await close()
  const extended = []
  for (const offset of [0, -1, 1]) {
    extended.push(await createQuickNote(offset, 'until_completed', '默认持续到完成'))
  }
  assert.equal(
    (await getNote(baseline.id)).duration_kind,
    'single_day',
    'enabling the preference cannot rewrite an existing note'
  )
  await switchView('week')
  await open()
  await expectQuickSetting(true, 'month enabling is synchronized to the newly loaded week view')
  assertQuickSettingOnDisk(true)
  assert.equal(
    await js('window.api.getSettingsSnapshot().then(s => s.values.notes.autoMoveToToday)'),
    false
  )
  await close()
  for (const offset of [0, -1, 1]) {
    extended.push(await createQuickNote(offset, 'until_completed', '共享持续到完成'))
  }

  const movable = await create('双开关下仅当天便签可移动')
  await open()
  const historicalExtended = extended.filter(
    (note) => localDateKey(note.effective_at) === yesterday
  )
  for (const note of historicalExtended) {
    await until(
      () => js(`Boolean(document.querySelector('li[data-note-id="${note.id}"] input:disabled'))`),
      'quick-created historical until-completed note remains visible and unavailable for moving'
    )
    assert.ok(
      await js(
        `document.querySelector('li[data-note-id="${note.id}"] [data-move-disabled-reason]')?.textContent.trim().length > 0`
      )
    )
  }
  await click('[data-move-select-all]')
  const selected = await js(
    "Array.from(document.querySelectorAll('li[data-note-id] input:checked')).map(input => Number(input.closest('[data-note-id]').dataset.noteId))"
  )
  assert.deepEqual(
    selected,
    [movable.id],
    'with quick extension enabled only historical single-day notes can be selected for movement'
  )
  await click('#historical-move-auto-toggle')
  await until(
    () => js('window.api.getSettingsSnapshot().then(s => s.values.notes.autoMoveToToday === true)'),
    'automatic movement and quick extension can both remain enabled'
  )
  await until(
    async () => localDateKey((await getNote(movable.id)).effective_at) === today,
    'enabling automatic movement still moves the independent single-day note'
  )
  await expectQuickSetting(true, 'automatic movement must leave the quick-extension preference on')
  await assertQuickNotesUnchanged(
    extended,
    'both switches enabled preserve existing until-completed notes'
  )
  await setQuickSetting(false)
  await close()
  const subsequentWeek = await createQuickNote(0, 'single_day', '关闭后恢复单日')
  await switchView('month')
  await open()
  await expectQuickSetting(false, 'week disabling is synchronized to the newly loaded month view')
  assertQuickSettingOnDisk(false)
  assert.equal(
    await js("document.querySelector('#historical-move-auto-toggle').getAttribute('aria-checked')"),
    'true'
  )
  assert.equal(
    await js('window.api.getSettingsSnapshot().then(s => s.values.notes.autoMoveToToday)'),
    true
  )
  await close()
  const subsequentMonth = await createQuickNote(1, 'single_day', '关闭后未来单日')
  await assertQuickNotesUnchanged(
    extended,
    'disabling the preference changes only subsequent quick creation'
  )
  assert.equal((await getNote(baseline.id)).duration_kind, 'single_day')
  quickCreateEvidence.push({
    baseline,
    extended,
    movedSingleDay: await getNote(movable.id),
    subsequentWeek,
    subsequentMonth
  })
  await open()
  scenarios.push(
    'default-off quick duration persists globally; real month/week creation preserves today/history/future effective times and status; both switches keep until-completed history immovable; disabling affects only later quick notes'
  )
}

const resultState = () =>
  js(`(()=>{
    const viewport=document.querySelector('[data-move-results-viewport]');
    const content=document.querySelector('[data-move-results]');
    const dialog=viewport?.closest('[role="dialog"]');
    if(!viewport || !content || !dialog)return null;
    return {state:viewport.dataset.state,height:dialog.getBoundingClientRect().height,
      resultsHeight:viewport.getBoundingClientRect().height,
      ids:Array.from(content.querySelectorAll('[data-note-id]')).map(row=>Number(row.dataset.noteId)),
      inert:content.inert,hidden:content.getAttribute('aria-hidden'),
      actionDisabled:document.querySelector('[data-move-action]').disabled,
      selection:document.querySelector('[data-move-selection-count]')?.textContent.trim(),
      enabledOldInputs:content.querySelectorAll('[data-note-id] input:not(:disabled)').length};
  })()`)

async function captureEvidence(name) {
  const path = join(process.env.ABANDON_TEST_EVIDENCE_DIR || root, name)
  writeFileSync(path, (await current.webContents.capturePage()).toPNG())
  captures.push(path)
}

async function captureFailureDiagnostics() {
  if (!current || current.isDestroyed()) return
  failureDiagnostics = await js(`(()=>{
    const recording=window.__historicalMoveMotion;
    if(recording)recording.stopped=true;
    const viewport=document.querySelector('[data-move-results-viewport]');
    const content=document.querySelector('[data-move-results]');
    const dialog=viewport?.closest('[role="dialog"]');
    const size=selector=>{const target=dialog?.querySelector(selector);return target?Number.parseFloat(getComputedStyle(target).fontSize):null};
    return {preset:document.querySelector('[data-move-preset][aria-pressed="true"]')?.dataset.movePreset,
      quickCreate:document.querySelector('[data-quick-create-until-completed]')?.outerHTML,
      viewportState:viewport?.dataset.state,viewportBusy:viewport?.getAttribute('aria-busy'),
      dialogHeight:dialog?.getBoundingClientRect().height,dialogInlineHeight:dialog?.style.height,
      dialogComputedHeight:dialog?getComputedStyle(dialog).height:null,
      resultsHeight:viewport?.getBoundingClientRect().height,contentHeight:content?.getBoundingClientRect().height,
      resultIds:Array.from(content?.querySelectorAll('[data-note-id]')||[]).map(row=>Number(row.dataset.noteId)),
      contentInert:content?.inert,actionDisabled:document.querySelector('[data-move-action]')?.disabled,
      fonts:{title:size('h2'),automatic:size('#historical-move-auto-label'),content:size('.historical-note-move__content'),
        helper:size('#historical-move-auto-help'),metadata:size('.historical-note-move__note-meta .historical-note-move__hint')},
      currentAnimations:(dialog?.getAnimations()||[]).map(animation=>({state:animation.playState,time:Number(animation.currentTime),
        timing:animation.effect?.getTiming(),keyframes:animation.effect?.getKeyframes()})),
      frames:recording?.frames||[]};
  })()`)
  const name = 'historical-move-failure-diagnostics.json'
  writeFileSync(
    join(process.env.ABANDON_TEST_EVIDENCE_DIR || root, name),
    JSON.stringify(failureDiagnostics, null, 2)
  )
  failureDiagnostics.artifact = name
}

async function sampleTransitions() {
  await js(`(()=>{
    const recording={frames:[],stopped:false};window.__historicalMoveMotion=recording;
    function sample(time){
      const viewport=document.querySelector('[data-move-results-viewport]'),dialog=viewport?.closest('[role="dialog"]');
      if(dialog){
        const heightAnimations=dialog.getAnimations().flatMap(animation=>{
          const keyframes=animation.effect?.getKeyframes()||[];
          if(!keyframes.some(frame=>Object.hasOwn(frame,'height')))return [];
          return [{state:animation.playState,time:Number(animation.currentTime),duration:Number(animation.effect.getTiming().duration),
            from:Number.parseFloat(keyframes[0].height),to:Number.parseFloat(keyframes.at(-1).height)}];
        });
        recording.frames.push({time,state:viewport.dataset.state,height:dialog.getBoundingClientRect().height,heightAnimations,
          ids:Array.from(document.querySelectorAll('[data-move-results] [data-note-id]')).map(row=>Number(row.dataset.noteId))});
      }
      if(!recording.stopped)requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  })()`)
}

async function stopSampling() {
  return js(
    `(()=>{const recording=window.__historicalMoveMotion;recording.stopped=true;return recording.frames})()`
  )
}

async function waitForFixture(scope) {
  const expected = previewFixture(scope).notes.map((note) => note.id)
  await until(async () => {
    const state = await resultState()
    return state?.state === 'ready' && JSON.stringify(state.ids) === JSON.stringify(expected)
  }, scope + ' latest fixture visible and transition settled')
  return resultState()
}

async function verifyRangeTransition(scope, { captureMidpoint = false } = {}) {
  const before = await resultState()
  const moveCallsBefore = moveCommandCalls
  await sampleTransitions()
  await click(`[data-move-preset="${scope}"]`)
  const request = await pendingPreview(scope)
  await wait(90)
  const pending = await resultState()
  assert.equal(pending.state, 'loading', scope + ' delayed response exposes loading state')
  assert.deepEqual(pending.ids, before.ids, scope + ' keeps the old cards during IPC delay')
  assert.ok(
    Math.abs(pending.height - before.height) <= 1.5,
    scope + ' delayed IPC keeps dialog height'
  )
  assert.ok(
    Math.abs(pending.resultsHeight - before.resultsHeight) <= 1.5,
    scope + ' delayed IPC keeps results height'
  )
  assert.equal(pending.inert, true, scope + ' old results are inert while loading')
  assert.equal(pending.hidden, 'true', scope + ' stale results are excluded from accessibility')
  assert.equal(pending.actionDisabled, true, scope + ' stale selection cannot submit')
  assert.equal(pending.enabledOldInputs, 0, scope + ' stale note checkboxes cannot be selected')
  await js(`(()=>{
    document.querySelector('[data-move-action]').dispatchEvent(new MouseEvent('click',{bubbles:true}));
    document.querySelector('[data-move-results] input')?.dispatchEvent(new Event('change',{bubbles:true}));
  })()`)
  assert.equal(
    moveCommandCalls,
    moveCallsBefore,
    scope + ' loading guard blocks even a dispatched submit'
  )
  assert.equal(
    (await resultState()).selection,
    pending.selection,
    scope + ' loading guard preserves the invalidated selection'
  )
  releasePreview(request)
  if (captureMidpoint) {
    await until(
      () =>
        js(`(()=>{
        const viewport=document.querySelector('[data-move-results-viewport]'),dialog=viewport.closest('[role="dialog"]');
        const height=dialog.getBoundingClientRect().height;
        return dialog.getAnimations().some(animation=>{
          const frames=animation.effect?.getKeyframes()||[],from=Number.parseFloat(frames[0]?.height),to=Number.parseFloat(frames.at(-1)?.height);
          return animation.playState==='running' && Math.abs(to-from)>20 && height>Math.min(from,to)+2 && height<Math.max(from,to)-2;
        });
      })()`),
      'range change reaches an actual animated intermediate height'
    )
    await captureEvidence('historical-move-range-transition-midpoint.png')
  }
  const settled = await waitForFixture(scope)
  await wait(90)
  const final = await resultState()
  const frames = await stopSampling()
  assert.ok(
    Math.abs(final.height - before.height) > 20,
    scope + ' fixture creates a meaningful height change'
  )
  const low = Math.min(before.height, final.height)
  const high = Math.max(before.height, final.height)
  assert.ok(
    frames.some(
      (frame) =>
        frame.height > low + 2 &&
        frame.height < high - 2 &&
        frame.heightAnimations.some(
          (animation) =>
            animation.state === 'running' &&
            animation.time > 0 &&
            animation.time < animation.duration
        )
    ),
    scope + ' height animation actually runs through an intermediate rendered height'
  )
  assert.ok(
    frames.every((frame) => frame.height >= low - 2 && frame.height <= high + 2),
    scope + ' transition never collapses or overshoots its endpoints'
  )
  assert.ok(
    Math.abs(settled.height - final.height) <= 1,
    scope + ' final height remains stable after ready'
  )
  assert.ok(
    frames.slice(-3).every((frame) => Math.abs(frame.height - final.height) <= 1),
    scope + ' final rendered frames agree with the settled height'
  )
  assert.equal(final.inert, false, scope + ' latest results regain interaction')
  assert.equal(
    final.enabledOldInputs,
    final.ids.length,
    scope + ' latest movable rows regain selection'
  )
  transitionEvidence.push({ scope, before, pending, final, frames })
  return final
}

async function verifyCompactTypographyAndRangeMotion() {
  await close()
  await js("window.api.setSettingValue('notes.autoMoveToToday',false)")
  current.setContentSize(1050, 1000)
  controlledPreview = true
  await until(stable, 'calendar settled before controlled range scenarios')
  await click(trigger)
  await until(modal, 'controlled range dialog opened')
  releasePreview(await pendingPreview('yesterday'))
  const yesterdayState = await waitForFixture('yesterday')
  await until(
    () =>
      js(
        "document.querySelector('#historical-move-auto-toggle')?.getAttribute('aria-checked')==='false'"
      ),
    'compact typography screenshot uses automatic move off'
  )
  const fonts = await js(`(()=>{
    const dialog=document.querySelector('[data-move-results-viewport]').closest('[role="dialog"]');
    const size=selector=>Number.parseFloat(getComputedStyle(dialog.querySelector(selector)).fontSize);
    const rootStyle=getComputedStyle(document.documentElement);
    return {title:size('h2'),automatic:size('#historical-move-auto-label'),content:size('.historical-note-move__content'),
      helper:size('#historical-move-auto-help'),metadata:size('.historical-note-move__note-meta .historical-note-move__hint'),
      base:Number.parseFloat(rootStyle.getPropertyValue('--font-size-base'))*Number.parseFloat(rootStyle.fontSize)};
  })()`)
  assert.ok(
    Number.isFinite(fonts.base) && fonts.content < fonts.base,
    'historical results use a local compact size below the application base'
  )
  assert.ok(
    fonts.title > fonts.automatic && fonts.title > fonts.content,
    'dialog title leads the compact type hierarchy'
  )
  assert.ok(
    fonts.automatic > fonts.helper &&
      fonts.content > fonts.helper &&
      fonts.content > fonts.metadata,
    'note content and automatic heading remain above helper and metadata text'
  )
  await captureEvidence('historical-move-compact-100.png')
  transitionEvidence.push({ typography: fonts })
  await verifyRangeTransition('recent3', { captureMidpoint: true })
  await verifyRangeTransition('all')
  await verifyRangeTransition('recent3')
  await verifyRangeTransition('yesterday')

  // Interrupt an active expansion, then deliver the two later requests in
  // reverse order. A stale response must never replace the final yesterday.
  await sampleTransitions()
  await click('[data-move-preset="all"]')
  releasePreview(await pendingPreview('all'))
  await until(
    () =>
      js(`(()=>{
      const viewport=document.querySelector('[data-move-results-viewport]'),dialog=viewport.closest('[role="dialog"]');
      return viewport.dataset.state==='transitioning' && dialog.getAnimations().some(animation=>animation.playState==='running' && animation.effect?.getKeyframes().some(frame=>Object.hasOwn(frame,'height')) && Number(animation.currentTime)>0);
    })()`),
    'height expansion is running before rapid reversal'
  )
  const interrupted = await resultState()
  await click('[data-move-preset="recent3"]')
  const stale = await pendingPreview('recent3')
  await click('[data-move-preset="yesterday"]')
  const latest = await pendingPreview('yesterday')
  releasePreview(latest)
  await waitForFixture('yesterday')
  releasePreview(stale)
  await wait(400)
  const final = await waitForFixture('yesterday')
  const frames = await stopSampling()
  assert.ok(
    Math.abs(final.height - yesterdayState.height) <= 1.5,
    'rapid reversal restores the same yesterday height'
  )
  assert.ok(
    frames.every(
      (frame) => frame.height >= Math.min(yesterdayState.height, interrupted.height) - 2
    ),
    'rapid reversal never collapses below the visible smaller result'
  )
  assert.deepEqual(
    final.ids,
    previewFixture('yesterday').notes.map((note) => note.id),
    'late older-scope response cannot replace latest rows'
  )
  assert.equal(
    final.actionDisabled,
    false,
    'latest result selection becomes usable after interruption'
  )
  transitionEvidence.push({ scope: 'rapid-reversal', interrupted, final, frames })
  await close()
  controlledPreview = false
  current.setSize(1050, 780)
  await open()
  scenarios.push(
    'compact hierarchy, delayed previews preserve cards and size, four bidirectional real height transitions, interrupted reversal rejects stale responses'
  )
}
async function run() {
  try {
    await until(
      () =>
        BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes('/month.html')),
      'production month window opened'
    )
    current = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes('/month.html')
    )
    current.setSize(1050, 780)
    await until(stable, 'production calendar ready')
    // Other running copies may own the global shortcuts on this desktop.
    await wait(150)
    if (await js(`!!document.querySelector('[aria-label="快捷键启用提示"] .app-modal-close')`)) {
      await click('[aria-label="快捷键启用提示"] .app-modal-close')
      await until(
        () => js(`!document.querySelector('[aria-label="快捷键启用提示"]')`),
        'startup shortcut conflict notice dismissed'
      )
    }
    const single = await create('历史单日，可移动')
    const fixed = await create('指定天数，不可移动', {
      durationKind: 'fixed_days',
      durationDays: 3
    })
    const untilCompleted = await create('持续到完成，不可移动', { durationKind: 'until_completed' })
    const completed = await create('历史已完成，不展示', {
      status: 'completed',
      finishedAt: past + 60000
    })
    const scheduled = await create('未来预约，不移动', { effectiveAt: future })
    assert.equal(
      await js('window.api.getSettingsSnapshot().then(s => s.values.notes.autoMoveToToday)'),
      false
    )
    await click('[aria-label="上个月"]')
    await until(
      () => js(`!document.querySelector('.month-day-cell[data-date="${today}"]')`),
      'view moved outside the source and target dates'
    )
    await open()
    await until(
      () => js(`Boolean(document.querySelector('li[data-note-id="${single.id}"]'))`),
      'historical candidates loaded'
    )
    const rows = await js(`Array.from(document.querySelectorAll('li[data-note-id]')).map(row => ({
      id: Number(row.dataset.noteId), disabled: row.querySelector('input').disabled,
      checked: row.querySelector('input').checked,
      reason: row.querySelector('[data-move-disabled-reason]')?.textContent.trim() || '' }))`)
    assert.deepEqual(
      rows.map((row) => row.id).sort((a, b) => a - b),
      [single.id, fixed.id, untilCompleted.id].sort((a, b) => a - b)
    )
    assert.equal(rows.find((row) => row.id === single.id).checked, true)
    for (const id of [fixed.id, untilCompleted.id]) {
      assert.equal(rows.find((row) => row.id === id).disabled, true)
      assert.equal(rows.find((row) => row.id === id).checked, false)
      assert.ok(rows.find((row) => row.id === id).reason.length > 0)
    }
    await click('[data-move-clear-selection]')
    assert.equal(await js("document.querySelector('[data-move-action]').disabled"), true)
    await click('[data-move-select-all]')
    assert.equal(
      await js("Array.from(document.querySelectorAll('li[data-note-id] input:checked')).length"),
      1
    )
    scenarios.push(
      'all modes shown; disabled reasons readable; select all excludes unavailable notes'
    )

    await click('[data-move-action]')
    await until(
      async () => localDateKey((await getNote(single.id)).effective_at) === today,
      'manual move updates original note'
    )
    await until(async () => !(await modal()), 'dialog closed after move')
    assert.equal((await getNote(single.id)).created_at, single.created_at)
    assert.equal((await getNote(single.id)).finished_at, single.finished_at)
    for (const note of [fixed, untilCompleted, completed, scheduled])
      assert.equal((await getNote(note.id)).effective_at, note.effective_at)
    await until(stable, 'calendar settled after moving and locating today')
    await click('[aria-label="展开日期列表"]')
    await until(
      () => js(`Boolean(document.querySelector('#month-day-panel [data-note-id="${single.id}"]'))`),
      'moved note appears in today list even when calendar lanes overflow'
    )
    await click('[aria-label="收起日期列表"]')
    await open()
    await until(
      () => js("document.querySelector('[data-move-action]').disabled"),
      'zero movable keeps dialog available'
    )
    await close()
    scenarios.push(
      'manual date move preserves other fields and unavailable notes; zero movable still opens'
    )

    await switchView('week')
    const automatic = await create('自动移动昨天的单日')
    await open()
    await until(
      () => js(`Boolean(document.querySelector('li[data-note-id="${automatic.id}"]'))`),
      'week preview loaded'
    )
    await click('#historical-move-auto-toggle')
    await until(
      () => js('window.api.getSettingsSnapshot().then(s => s.values.notes.autoMoveToToday)'),
      'auto move saved'
    )
    await until(
      async () => localDateKey((await getNote(automatic.id)).effective_at) === today,
      'enabling immediately moves yesterday'
    )
    await until(
      () => js(`!document.querySelector('li[data-note-id="${automatic.id}"]')`),
      'open preview refreshes after automatic move'
    )
    await until(
      () =>
        js(
          "Boolean(document.querySelector('[data-move-preview]')) && document.querySelector('[data-move-action]').disabled"
        ),
      'automatic preview reload completed with zero movable'
    )
    assert.equal((await getNote(fixed.id)).effective_at, past)
    assert.equal((await getNote(untilCompleted.id)).effective_at, past)
    assert.equal((await getNote(scheduled.id)).effective_at, future)
    await close()
    await switchView('month')
    await open()
    await until(
      () =>
        js(
          "document.querySelector('#historical-move-auto-toggle')?.getAttribute('aria-checked') === 'true'"
        ),
      'auto move shared across month and week'
    )
    const disk = new Database(join(root, 'app.db'), { readonly: true })
    try {
      assert.equal(
        disk
          .prepare(
            "SELECT value FROM app_settings WHERE window_name='application' AND key='auto_move_to_today'"
          )
          .get()?.value,
        '1'
      )
    } finally {
      disk.close()
    }
    scenarios.push(
      'week enabling runs production command immediately; setting and changed preview shared with month'
    )

    await verifyQuickCreateUntilCompleted()
    await verifyCompactTypographyAndRangeMotion()
    for (const [name, bg, fg] of [
      ['white', '#ffffff', '#111111'],
      ['black', '#000000', '#eeeeee'],
      ['complex', '#e0e8ef', '#17202a']
    ]) {
      const channels = bg
        .slice(1)
        .match(/../g)
        .map((value) => parseInt(value, 16))
        .join(' ')
      await js(`window.api.setSettingValue('css.bgColor', '${channels}')`)
      await js(`window.api.setSettingValue('css.textColor', '${fg}')`)
      assert.equal(
        await js('window.api.getSettingsSnapshot().then(s => s.values.css.bgColor)'),
        channels
      )
      await js(
        `document.body.style.background=${JSON.stringify(name === 'complex' ? 'repeating-linear-gradient(35deg,#31577f 0px,#31577f 70px,#dcb36e 70px,#dcb36e 140px,#9c6065 140px,#9c6065 210px)' : bg)}`
      )
      await wait(100)
      const path = join(
        process.env.ABANDON_TEST_EVIDENCE_DIR || root,
        `historical-move-${name}.png`
      )
      writeFileSync(path, (await current.webContents.capturePage()).toPNG())
      captures.push(path)
    }
    current.setSize(620, 550)
    await js("window.api.setSettingValue('appearance.uiScale', 1.5)")
    await wait(200)
    const bounds = await js(`(() => { const dialog=document.querySelector('[role=dialog]');
      const rect=dialog.getBoundingClientRect(); const action=document.querySelector('[data-move-action]');
      const close=dialog.querySelector('button[aria-label]'); return { left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,
        width:innerWidth,height:innerHeight,action:!!action,close:!!close,scroll:dialog.scrollWidth<=dialog.clientWidth+1 } })()`)
    assert.ok(
      bounds.left >= 0 &&
        bounds.right <= bounds.width + 1 &&
        bounds.top >= 0 &&
        bounds.bottom <= bounds.height + 1
    )
    assert.equal(bounds.scroll, true)
    assert.ok(bounds.action && bounds.close)
    const quickBounds = await js(`(() => {
      const toggle = document.querySelector('[data-quick-create-until-completed]')
      toggle.scrollIntoView({ block: 'nearest' })
      const rect = toggle.getBoundingClientRect()
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return { rect: rect.toJSON(), width: innerWidth, height: innerHeight,
        enabled: !toggle.disabled, hit: target === toggle || toggle.contains(target),
        label: document.getElementById(toggle.getAttribute('aria-labelledby'))?.textContent.trim() }
    })()`)
    assert.ok(
      quickBounds.rect.left >= 0 &&
        quickBounds.rect.top >= 0 &&
        quickBounds.rect.right <= quickBounds.width + 1 &&
        quickBounds.rect.bottom <= quickBounds.height + 1 &&
        quickBounds.enabled &&
        quickBounds.hit,
      'the independent quick-duration switch remains reachable at 150% in a narrow window'
    )
    assert.equal(quickBounds.label, '快捷新建默认持续到完成')
    quickCreateEvidence.push({ narrow150: quickBounds })
    writeFileSync(
      join(process.env.ABANDON_TEST_EVIDENCE_DIR || root, 'historical-move-narrow.png'),
      (await current.webContents.capturePage()).toPNG()
    )
    scenarios.push(
      'white black and complex backgrounds captured; narrow 150% modal stays in viewport'
    )
    await lifecycle.finish({
      completed: true,
      window: current,
      summary: { scenarios, captures, transitionEvidence, quickCreateEvidence },
      restore: restorePreviewControl
    })
  } catch (error) {
    console.error(error)
    try {
      await captureFailureDiagnostics()
    } catch (diagnosticError) {
      console.error('Historical move diagnostics unavailable:', diagnosticError.message)
    }
    if (current && !current.isDestroyed())
      console.error(
        'UI state',
        await js(
          `({ active:document.activeElement?.outerHTML?.slice(0,600), trigger:document.querySelector('${trigger}')?.outerHTML, inert:document.querySelector('${trigger}')?.closest('[inert]')?.className, dialogs:Array.from(document.querySelectorAll('[role=dialog]')).map(el=>el.getAttribute('aria-label')) })`
        )
      )
    await lifecycle.finish({
      error,
      window: current,
      summary: { scenarios, captures, transitionEvidence, quickCreateEvidence, failureDiagnostics },
      restore: restorePreviewControl
    })
  }
}
try {
  app.setPath('userData', root)
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
  void lifecycle.finish({ error, summary: { scenarios }, restore: restorePreviewControl })
}
