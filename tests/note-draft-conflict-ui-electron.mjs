import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'

const results = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/note-draft-conflict-ui-electron.mjs',
  mode: 'real-app-note-editor-time-state-reminders-and-conflict',
  prefix: 'abandon-draft-conflict-ui-',
  timeoutMs: 180000,
  metadata: {
    realRendererAndPreload: true,
    realDiskDatabase: true,
    domControlInput: true,
    nativePointerInput: false,
    reminderFixturesSeededInOwnedDatabase: true
  }
})
const { assert } = results
app.setPath('userData', results.root)
app.commandLine.appendSwitch('disable-gpu')
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
const db = new Database(join(results.root, 'app.db'))
db.exec(`CREATE TABLE app_settings (
  window_name TEXT NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
  remark TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER,
  PRIMARY KEY (window_name, key))`)
const insert = db.prepare('INSERT INTO app_settings (window_name,type,key,value) VALUES (?,?,?,?)')
for (const [scope, type, key, value] of [
  ['application', 'application', 'active_view', 'list'],
  ['application', 'remote', 'receive_notices', 'false'],
  ['application', 'remote', 'upload_device_info', 'false'],
  ['application', 'onboarding', 'first_use_notice_version', '1'],
  ['main', 'system', 'blur_enabled', 'false']
])
  insert.run(scope, type, key, value)
db.close()

let window
const scenarios = []
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const js = (code) => window.webContents.executeJavaScript(code)
async function until(predicate, label) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) {
      assert.ok(value, label)
      return value
    }
    await wait(30)
  }
  assert.fail(label)
}

async function click(selector) {
  await js(
    `(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('missing control');node.scrollIntoView({block:'nearest'});node.click()})()`
  )
  await wait(180)
}

async function fill(selector, value) {
  await js(
    `(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.focus();node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('input',{bubbles:true}));node.blur()})()`
  )
  await wait(40)
}

function localParts(timestamp) {
  const date = new Date(timestamp)
  const pad = (part) => String(part).padStart(2, '0')
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return { day, time, text: `${day} ${time}`, timestamp: Math.floor(timestamp / 1000) * 1000 }
}

const effectiveTrigger = '.ne-root .ne-field-row .dt-trigger'
const finishedTrigger = '.ne-root .note-state-fields__completion .dt-trigger'
const pendingTrigger = '.ne-root .ne-pending-reminder .dt-trigger'
async function pickDateTime(trigger, timestamp) {
  const value = localParts(timestamp)
  await click(trigger)
  await until(
    () => js(`Boolean(document.querySelector('.dt-panel-wrap .dt-header-input'))`),
    'date/time panel opened'
  )
  await fill('.dt-panel-wrap .dt-header-field:first-child .dt-header-input', value.day)
  await fill('.dt-panel-wrap .dt-header-field:last-child .dt-header-input', value.time)
  await click('.dt-panel-wrap .dt-btn--confirm')
  await until(() => js(`!document.querySelector('.dt-panel-wrap')`), 'date/time panel closed')
  assert.equal(
    await js(`document.querySelector(${JSON.stringify(trigger)})?.textContent.trim()`),
    value.text,
    'picker commits the chosen date and time'
  )
  return value.timestamp
}

async function openEditor(id) {
  await until(
    () => js(`Boolean(document.querySelector('.nl-card[data-note-id="${id}"]'))`),
    'note card is listed'
  )
  await js(
    `(()=>{const node=document.querySelector('.nl-card[data-note-id="${id}"]');node.scrollIntoView({block:'center'});node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:180}))})()`
  )
  await until(
    () => js(`Boolean(document.querySelector('.nl-context-menu'))`),
    'note context menu opened'
  )
  await js(
    `Array.from(document.querySelectorAll('.nl-context-menu button')).find(button=>button.textContent.trim()==='修改').click()`
  )
  await until(
    () => js(`Boolean(document.querySelector('.app-editor.ne-root textarea'))`),
    'full editor opened'
  )
  await wait(300)
}

async function chooseState(value) {
  await click('.ne-root .note-state-fields .sel-trigger')
  await until(
    () => js(`Boolean(document.querySelector('.sel-option[data-value="${value}"]'))`),
    'state options opened'
  )
  assert.equal(
    await js(`document.querySelector('.sel-option[data-value="${value}"]').disabled`),
    false,
    'chosen state is legal'
  )
  await click(`.sel-option[data-value="${value}"]`)
}

async function saveEditor() {
  await until(
    () => js(`!document.querySelector('.ne-root .ne-submit').disabled`),
    'editor save enabled'
  )
  await click('.ne-root .ne-submit')
  await until(() => js(`!document.querySelector('.app-editor.ne-root')`), 'editor saved and closed')
}

const getNote = (id) => js(`window.api.getNote(${id})`)
const createNote = (options) => js(`window.api.createNote(${JSON.stringify(options)})`)

// This fixture represents an already snoozed in-progress reminder. Every tested
// change is then submitted by the actual renderer controls and authorized IPC.
function seedPendingReminder(id, dueAt) {
  const fixture = new Database(join(results.root, 'app.db'))
  const reminderId = randomUUID()
  const timestamp = Date.now()
  try {
    fixture
      .prepare('UPDATE notes SET reminder_channels=2, notify_enabled=0, updated_at=? WHERE id=?')
      .run(timestamp, id)
    fixture
      .prepare(
        'INSERT INTO note_reminders(id,note_id,due_at,created_at,updated_at) VALUES(?,?,?,?,?)'
      )
      .run(reminderId, id, dueAt, timestamp, timestamp)
  } finally {
    fixture.close()
  }
  return reminderId
}

function reminderState(id) {
  const fixture = new Database(join(results.root, 'app.db'), { readonly: true })
  try {
    return fixture.prepare('SELECT state FROM note_reminders WHERE id=?').get(id)?.state
  } finally {
    fixture.close()
  }
}

async function run() {
  try {
    window = await until(
      () =>
        BrowserWindow.getAllWindows().find((win) => /\/index\.html/.test(win.webContents.getURL())),
      'list window opened'
    )
    window.setContentSize(720, 900)
    await until(
      () => js(`Boolean(document.querySelector('.view-switcher__trigger'))`),
      'renderer ready'
    )
    if (
      await js(`Boolean(document.querySelector('[aria-label="快捷键启用提示"] .app-modal-close'))`)
    )
      await click('[aria-label="快捷键启用提示"] .app-modal-close')

    const precisionNow = Date.now()
    const precise = await createNote({
      content: 'completed precise original',
      status: 'completed',
      effectiveAt: Math.floor((precisionNow - 40000) / 1000) * 1000 + 123,
      finishedAt: Math.floor((precisionNow - 20000) / 1000) * 1000 + 789
    })
    await openEditor(precise.id)
    await fill('.ne-root textarea', 'completed precise body changed')
    await saveEditor()
    const preciseSaved = await getNote(precise.id)
    assert.equal(preciseSaved.status, 'completed', 'content edit preserves completed status')
    assert.equal(
      preciseSaved.effective_at,
      precise.effective_at,
      'content edit preserves exact effective milliseconds'
    )
    assert.equal(
      preciseSaved.finished_at,
      precise.finished_at,
      'content edit preserves exact completion milliseconds'
    )
    scenarios.push('completed content-only edit retains exact business times')

    await openEditor(precise.id)
    const correctedFinished = await pickDateTime(finishedTrigger, Date.now() - 10000)
    await saveEditor()
    const corrected = await getNote(precise.id)
    assert.equal(
      corrected.finished_at,
      correctedFinished,
      'actual completion picker corrects a historical completion time'
    )
    assert.equal(
      corrected.effective_at,
      precise.effective_at,
      'completion correction leaves the start time intact'
    )
    assert.equal(corrected.status, 'completed')
    scenarios.push('historical completion corrected using the date/time control')

    await openEditor(precise.id)
    await click(finishedTrigger)
    await click('.dt-panel-wrap .dt-btn--now')
    assert.equal(
      await js(`document.querySelector(${JSON.stringify(finishedTrigger)}).textContent.trim()`),
      '保存时完成',
      'explicit completion now remains a relative save intention'
    )
    await wait(1200)
    await saveEditor()
    const completedNow = await getNote(precise.id)
    assert.equal(
      completedNow.finished_at,
      completedNow.updated_at,
      'completion now uses commit time'
    )
    assert.equal(
      completedNow.effective_at,
      precise.effective_at,
      'completion leaves start unchanged'
    )
    scenarios.push('completion now resolves when the full edit commits')

    const progress = await createNote({
      content: 'progress with pending reminder',
      effectiveAt: Date.now() - 3600_000
    })
    const oldRound = seedPendingReminder(progress.id, Date.now() + 3600_000)
    await openEditor(progress.id)
    assert.equal(
      await js(`document.querySelector(${JSON.stringify(pendingTrigger)})?.disabled`),
      false,
      'existing later reminder is editable'
    )
    const future = await pickDateTime(effectiveTrigger, Date.now() + 3600_000)
    assert.equal(
      await js(
        `document.querySelector('.ne-root .note-state-fields .sel-label').textContent.trim()`
      ),
      '未开始',
      'moving start to future derives pending state'
    )
    assert.equal(
      await js(`Boolean(document.querySelector('.ne-root .ne-pending-reminder'))`),
      false,
      'old later reminder is not edited as the new appointment'
    )
    await click('.ne-root .note-state-fields .sel-trigger')
    await until(
      () => js(`document.querySelectorAll('.sel-option[data-value]').length===3`),
      'all three state options displayed'
    )
    assert.deepEqual(
      await js(
        `Array.from(document.querySelectorAll('.sel-option')).map(node=>({value:node.dataset.value,disabled:node.disabled}))`
      ),
      [
        { value: 'initialized', disabled: false },
        { value: 'in_progress', disabled: true },
        { value: 'completed', disabled: true }
      ],
      'future start permits only pending'
    )
    await click('.ne-root .note-state-fields .sel-trigger')
    await saveEditor()
    const rescheduled = await getNote(progress.id)
    assert.equal(rescheduled.status, 'initialized')
    assert.equal(rescheduled.effective_at, future)
    assert.equal(rescheduled.pending_reminder, null, 'rescheduling cancels the old later reminder')
    assert.equal(reminderState(oldRound), 'cancelled', 'cancelled reminder remains auditable')
    scenarios.push('progress moved to future; legal options and old reminder cancellation verified')

    await openEditor(precise.id)
    const completedFuture = await pickDateTime(effectiveTrigger, Date.now() + 7200_000)
    assert.equal(
      await js(`document.querySelector('.ne-root .note-state-fields__hint').textContent.trim()`),
      '保存后将取消完成，改为未开始。',
      'completed-to-future explicitly explains the status change'
    )
    assert.equal(
      await js(`Boolean(document.querySelector('.note-state-fields__completion'))`),
      false
    )
    await saveEditor()
    const completedRescheduled = await getNote(precise.id)
    assert.equal(completedRescheduled.status, 'initialized')
    assert.equal(completedRescheduled.effective_at, completedFuture)
    assert.equal(
      completedRescheduled.finished_at,
      null,
      'future appointment clears previous completion'
    )
    assert.equal(
      completedRescheduled.reminder_channels,
      0,
      'old completed reminder settings are not revived'
    )
    scenarios.push('completed-to-future explains and cancels completion')

    await openEditor(progress.id)
    const pastEffective = await pickDateTime(effectiveTrigger, Date.now() - 86400_000)
    assert.equal(
      await js(
        `document.querySelector('.ne-root .note-state-fields .sel-label').textContent.trim()`
      ),
      '进行中',
      'moving pending start to past defaults to progress'
    )
    await chooseState('completed')
    const pastFinished = await pickDateTime(finishedTrigger, Date.now() - 3600_000)
    await saveEditor()
    const backfilled = await getNote(progress.id)
    assert.equal(backfilled.status, 'completed')
    assert.equal(backfilled.effective_at, pastEffective)
    assert.equal(backfilled.finished_at, pastFinished)
    assert.equal(backfilled.reminder_channels, 0)
    assert.equal(backfilled.pending_reminder, null)
    scenarios.push('pending appointment corrected to historical completed note')

    const later = await createNote({
      content: 'history correction with later reminder',
      effectiveAt: Date.now() - 3600_000
    })
    const laterRound = seedPendingReminder(later.id, Date.now() + 7200_000)
    await openEditor(later.id)
    const historicalEffective = await pickDateTime(effectiveTrigger, Date.now() - 86400_000)
    assert.equal(
      await js(`document.querySelector(${JSON.stringify(pendingTrigger)})?.disabled`),
      false,
      'historical start correction still permits later-reminder edit'
    )
    const laterDue = await pickDateTime(pendingTrigger, Date.now() + 10800_000)
    await saveEditor()
    const laterSaved = await getNote(later.id)
    assert.equal(laterSaved.status, 'in_progress')
    assert.equal(laterSaved.effective_at, historicalEffective)
    assert.equal(laterSaved.pending_reminder.id, laterRound)
    assert.equal(
      laterSaved.pending_reminder.due_at,
      laterDue,
      'history and later reminder commit together'
    )
    assert.equal(laterSaved.reminder_channels, 2)
    scenarios.push('in-progress history correction and later-reminder edit saved together')

    const legacy = await createNote({
      content: 'legacy completed missing time',
      status: 'completed',
      effectiveAt: Date.now() - 3600_000
    })
    const legacyDb = new Database(join(results.root, 'app.db'))
    legacyDb.prepare('UPDATE notes SET finished_at=NULL WHERE id=?').run(legacy.id)
    legacyDb.close()
    await openEditor(legacy.id)
    assert.equal(
      await js(`document.querySelector(${JSON.stringify(finishedTrigger)}).textContent.trim()`),
      '请补充完成时间',
      'missing legacy completion never formats as 1970'
    )
    assert.match(
      await js(`document.querySelector('.ne-root .note-state-fields').textContent`),
      /不会自动补为现在/
    )
    await fill('.ne-root textarea', 'legacy completed repaired explicitly')
    await click('.ne-root .ne-submit')
    await until(
      () =>
        js(
          `Boolean(document.querySelector('.ne-root')) && !document.querySelector('.ne-root .ne-submit').disabled`
        ),
      'invalid legacy save keeps editor open'
    )
    assert.equal(
      (await getNote(legacy.id)).finished_at,
      null,
      'missing legacy completion is not silently populated'
    )
    const repairedFinished = await pickDateTime(finishedTrigger, Date.now() - 10000)
    await saveEditor()
    assert.equal(
      (await getNote(legacy.id)).finished_at,
      repairedFinished,
      'explicit completion repairs missing legacy time'
    )
    scenarios.push('legacy missing completion requires an explicit time')

    const conflict = await createNote({ content: 'original conflict fixture' })
    await openEditor(conflict.id)
    await fill('.ne-root textarea', 'unsaved local draft')
    await js(`window.api.updateNote(${conflict.id},{content:'newer external content'})`)
    await click('.ne-root .ne-submit')
    await until(
      () =>
        js(
          `Array.from(document.querySelectorAll('.msg-toast')).some(node=>node.textContent.includes('便签已发生变化'))`
        ),
      'version conflict explained'
    )
    assert.equal(
      await js(`document.querySelector('.app-editor textarea')?.value`),
      'unsaved local draft',
      'conflict retains local draft'
    )
    assert.equal(
      (await getNote(conflict.id)).content,
      'newer external content',
      'conflict preserves the newer database content'
    )
    assert.equal(
      await js(`document.querySelector('.app-editor .ne-submit').disabled`),
      false,
      'conflict re-enables saving'
    )
    scenarios.push('original version conflict preserves newer data and unsaved draft')

    console.log(
      'Full note editor: time/state/reminder rules, completion precision and conflict protection passed'
    )
    await results.finish({ completed: true, window, summary: { scenarios } })
  } catch (error) {
    console.error(error)
    await results.finish({ error, window, summary: { scenarios } })
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
