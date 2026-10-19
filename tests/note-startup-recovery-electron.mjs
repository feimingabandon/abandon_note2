import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow } from 'electron'
import { createDatabaseSchema } from '../src/main/db/db-schema.js'
import { clearDb, setDb } from '../src/main/db/db-connection.js'
import { createTemplate } from '../src/main/db/db-templates.js'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'

const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/note-startup-recovery-electron.mjs',
  mode: 'real-app-startup-persisted-note-and-template-backlog-recovery',
  prefix: 'abandon-note-startup-recovery-',
  metadata: {
    realRendererAndPreload: true,
    realDiskDatabase: true,
    mainProcessBootstrap: true,
    persistedBacklogFixtures: true,
    mainProcessRestart: false,
    naturalOsResume: false,
    naturalMidnightWait: false,
    repeatedPublicSchedulerRetry: true,
    systemNotificationDelivery: false
  }
})
const { assert, root } = lifecycle
const databasePath = join(root, 'app.db')
const now = Date.now()
const date = new Date(now)
const day = (offset) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset).getTime()
const today = day(0)
const createdAt = day(-10) + 60000
const ordinary = {}
const dailyTemplates = []
const oldInstances = []
let noMatchTemplate, expiredTemplate, window, reader
const noteSql = 'SELECT id,content,status,effective_at,finished_at,is_deleted FROM notes'
const dailyRule = { frequency: 'daily', interval: 1, time_of_day: '00:00' }
const newTemplate = (content, recurrenceRule = dailyRule, endAt = null) =>
  createTemplate({ content, recurrenceRule, endAt }, createdAt)

function seed() {
  const db = new Database(databasePath)
  try {
    db.pragma('foreign_keys = ON')
    createDatabaseSchema(db)
    setDb(db)
    const setting = db.prepare(
      'INSERT OR REPLACE INTO app_settings (window_name,type,key,value) VALUES (?,?,?,?)'
    )
    for (const row of [
      ['application', 'application', 'active_view', 'list'],
      ['application', 'remote', 'receive_notices', 'false'],
      ['application', 'remote', 'upload_device_info', 'false'],
      ['application', 'onboarding', 'first_use_notice_version', '1'],
      ['main', 'system', 'blur_enabled', 'false']
    ])
      setting.run(...row)
    // These rows represent valid appointments committed before this process
    // starts. Future-only creation validation must not prevent persisted backlog.
    const insert = db.prepare(`INSERT INTO notes
      (content,status,effective_at,finished_at,is_deleted,from_template,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`)
    const insertRow = (values, timestamp = createdAt) =>
      Number(insert.run(...values, timestamp, timestamp).lastInsertRowid)
    for (const [key, effectiveAt, deleted] of [
      ['due', now - 60000, 0],
      ['future', now + 86400000, 0],
      ['deleted', now - 60000, 1]
    ])
      ordinary[key] = insertRow([
        `startup-${key}`,
        'initialized',
        effectiveAt,
        createdAt,
        deleted,
        0
      ])
    for (const status of ['in_progress', 'completed']) {
      const template = newTemplate(`startup-daily-${status}`)
      const oldAt = template.next_run_at
      const oldId = insertRow(
        [`startup-old-${status}`, status, oldAt, oldAt + 60000, 0, 1],
        oldAt + 60000
      )
      db.prepare(
        `UPDATE note_templates SET last_generated_note_id=?, last_generated_at=?, next_run_at=?, updated_at=? WHERE id=?`
      ).run(oldId, oldAt, day(-8), oldAt + 60000, template.id)
      dailyTemplates.push(template.id)
      oldInstances.push(db.prepare(`${noteSql} WHERE id=?`).get(oldId))
    }
    noMatchTemplate = newTemplate('startup-no-today-node', {
      frequency: 'weekly',
      days_of_week: [((date.getDay() + 5) % 7) + 1],
      time_of_day: '00:00'
    }).id
    expiredTemplate = newTemplate('startup-expired', dailyRule, day(-1)).id
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM note_templates WHERE next_run_at < ?').get(today).n,
      4
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM note_reminders').get().n, 0)
  } finally {
    clearDb()
    db.close()
  }
}

async function until(read, message) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const result = await read()
    if (result) {
      assert.ok(result, message)
      return result
    }
    await new Promise((done) => setTimeout(done, 25))
  }
  assert.fail(message)
}
const js = (code) => window.webContents.executeJavaScript(code)
const getNote = (id) => js(`window.api.getNote(${id})`)
const rows = () => reader.prepare(`${noteSql} ORDER BY id`).all()

async function run() {
  let summary = {}
  try {
    window = await until(
      () =>
        BrowserWindow.getAllWindows().find(
          (target) =>
            !target.isDestroyed() && /\/index\.html(?:$|[?#])/.test(target.webContents.getURL())
        ),
      'real list window created'
    )
    await until(
      () => js('Boolean(window.api && document.querySelector(".view-switcher__trigger"))'),
      'real renderer and preload ready'
    )
    await until(
      () => js('window.api.getSchedulerHealth()').catch(() => null),
      'startup scheduler registered'
    )
    reader = new Database(databasePath, { readonly: true })
    await until(
      async () => (await getNote(ordinary.due)).status === 'in_progress',
      'startup activates persisted due appointment'
    )
    const due = await getNote(ordinary.due)
    assert.equal(due.effective_at, now - 60000)
    assert.equal((await getNote(ordinary.future)).status, 'initialized')
    assert.equal(await getNote(ordinary.deleted), null)
    assert.equal(
      reader.prepare('SELECT status FROM notes WHERE id=?').get(ordinary.deleted).status,
      'initialized'
    )
    const templates = await js('window.api.listTemplates()')
    for (const id of dailyTemplates) {
      const template = templates.find((item) => item.id === id)
      assert.equal(template.last_generated_at, today)
      assert.ok(template.next_run_at > now)
      const generated = await getNote(template.last_generated_note_id)
      assert.equal(generated.effective_at, today)
      assert.equal(generated.status, 'in_progress')
      assert.equal(generated.duration_kind, 'single_day')
      assert.equal(generated.reminder_channels, 0)
      assert.equal(
        reader.prepare('SELECT COUNT(*) AS n FROM notes WHERE content=?').get(template.content).n,
        1
      )
    }
    for (const old of oldInstances)
      assert.deepEqual(reader.prepare(`${noteSql} WHERE id=?`).get(old.id), old)
    const noMatch = templates.find((item) => item.id === noMatchTemplate)
    assert.equal(noMatch.last_generated_note_id, null)
    assert.ok(noMatch.next_run_at > now)
    const expired = templates.find((item) => item.id === expiredTemplate)
    assert.equal(expired.last_generated_note_id, null)
    assert.equal(expired.is_paused, 1)
    assert.equal(expired.next_run_at, null)
    assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM note_reminders').get().n, 0)
    const afterStartup = rows()
    for (let round = 0; round < 2; round++) {
      const health = await js('window.api.retryScheduler()')
      assert.equal(health.status, 'running')
      for (const name of ['activationTask', 'noteGenerationTask']) {
        const task = health.tasks.find((item) => item.name === name)
        assert.equal(task.failures, 0)
        assert.equal(task.disabled, false)
      }
      assert.deepEqual(
        rows(),
        afterStartup,
        'repeated real scheduler rounds cannot duplicate recovered notes'
      )
    }
    summary = { ordinary, templates, afterStartup }
    reader.close()
    reader = null
    await lifecycle.finish({ completed: true, window, summary })
  } catch (error) {
    if (reader?.open) reader.close()
    console.error(error)
    await lifecycle.finish({ error, window, summary })
  }
}

try {
  app.setPath('userData', root)
  app.commandLine.appendSwitch('disable-gpu')
  process.env.ABANDON_INTEGRATION_TEST = '1'
  process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
  process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
  seed()
  app.once('ready', () => void run())
  const require = createRequire(import.meta.url)
  require(resolve('out/main/index.js'))
  const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
    /^index-[\w-]+\.js$/.test(name)
  )
  assert.ok(chunk, 'built main entry exists')
  require(resolve('out/main/chunks', chunk))
} catch (error) {
  console.error(error)
  void lifecycle.finish({ error })
}
