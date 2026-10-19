import { readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createAssertionRecorder, prepareTestProfile } from './helpers/test-result-recorder.cjs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain } from 'electron'

const ipcTrace = []
let pageDelay = 0,
  failNormal = false
let refreshGate = null
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
function holdNextRefreshDelivery() {
  let release
  const gate = {
    claimed: false,
    snapshotReady: false,
    promise: new Promise((done) => {
      release = done
    })
  }
  gate.release = release
  refreshGate = gate
  return gate
}
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) =>
  originalHandle(channel, async (event, ...args) => {
    let gate = null
    if (channel === 'notes:query-custom-normal') {
      ipcTrace.push({ channel, ...args[0] })
      if (args[0]?.offset === 0 && refreshGate && !refreshGate.claimed) {
        gate = refreshGate
        gate.claimed = true
      }
      if (args[0]?.offset > 0) await wait(pageDelay)
      if (failNormal) {
        failNormal = false
        throw new Error('Injected custom snapshot failure')
      }
    }
    const result = await listener(event, ...args)
    if (gate) {
      // SQLite has already produced the real snapshot; hold only the IPC delivery.
      gate.snapshotReady = true
      await gate.promise
      if (refreshGate === gate) refreshGate = null
    }
    return result
  })
const recorder = createAssertionRecorder({
  suite: 'tests/note-list-custom-electron.mjs',
  mode: 'electron-ready-real-app-custom-list',
  metadata: {
    realWindows: true,
    realDiskDatabase: true,
    syntheticDraggableCallback: true,
    nativePointerDrag: false,
    controlledRefreshDelay: 'offset-zero-real-SQLite-result-IPC-delivery-only',
    mainProcessRestart: false
  }
})
const { assert } = recorder
const profile = prepareTestProfile({ prefix: 'abandon-note-custom-' })
const userData = profile.directory
let current,
  completed = false,
  failure = null,
  shuttingDown = false,
  reachedWillQuit = false,
  cleanupTimeout = null
let evidence = { status: 'incomplete' }
const cleanupErrors = [],
  verifiedScenarios = [],
  fixtureObservations = []
const report = (message) => process.stdout.write('[custom-list] ' + message + '\n')
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

async function scrollToCustomBottom(label) {
  const state = await current.webContents.executeJavaScript(`(()=>{
    const el=document.querySelector('.nl-custom'),previous=el.scrollTop;
    el.scrollTop=el.scrollHeight-el.clientHeight;
    const source=Math.abs(el.scrollTop-previous)>1?'native-scroll':'same-position-event';
    // A changed scrollTop already schedules a browser scroll event. Do not inject a second one.
    if(source==='same-position-event')el.dispatchEvent(new Event('scroll'));
    return {source,previous,scrollTop:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,
      cards:document.querySelectorAll('.nl-custom .nl-card').length}
  })()`)
  fixtureObservations.push({ label, ...state })
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
  refreshGate?.release()
  failure = error
  process.exitCode = error ? 1 : 0
  clearTimeout(testTimeout)
  try {
    const root = process.env.ABANDON_TEST_EVIDENCE_DIR || userData
    const summary = {
      completed,
      error: error?.stack || null,
      scope: 'Custom paging, refresh and synthetic callback sorting persistence',
      ipcTrace,
      verifiedScenarios,
      fixtureObservations,
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
      writeFileSync(join(root, 'note-list-custom-final.png'), png, { flag: 'wx' })
      summary.screenshotSha256 = createHash('sha256').update(png).digest('hex')
    }
    writeFileSync(join(root, 'note-list-custom-evidence.json'), JSON.stringify(summary, null, 2), {
      flag: 'wx'
    })
    evidence = {
      status: 'complete',
      artifacts: [
        'note-list-custom-evidence.json',
        ...(summary.screenshotSha256 ? ['note-list-custom-final.png'] : [])
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
  try {
    await until(() => listWindow(), 'list ready')
    current = listWindow()
    current.setSize(600, 780)
    const js = (s) => current.webContents.executeJavaScript(s)
    const expectUI = (s, label) => until(() => js(s), label)
    await expectUI("Boolean(document.querySelector('.nl-timeline'))", 'initial timeline')
    const fixture = await js(
      `(async()=>{ const pins=[],normal=[]; for(let i=0;i<2;i++) pins.push((await window.api.createNote({content:'Pinned '+i,isPinned:1})).id); for(let i=0;i<60;i++) normal.push((await window.api.createNote({content:'Normal '+i})).id); return {pins,normal} })()`
    )
    await js(
      "window.api.setSettingValue('listFilter',{listMode:'custom',tagIds:[],statusFilter:[]})"
    )
    await expectUI(
      "document.querySelectorAll('.nl-custom .nl-card').length===12",
      'initial custom page'
    )
    // Existing custom-mode repair may trigger a second foreground snapshot.
    await wait(300)
    await expectUI(
      "document.querySelectorAll('.nl-custom .nl-card').length===12",
      'custom repair settled'
    )
    const pinnedBefore = await js(
      "Array.from(document.querySelectorAll('.nl-custom .nl-zone:first-child .nl-card'),e=>Number(e.dataset.noteId))"
    )
    const normalSelector = '.nl-custom .nl-zone:nth-child(2) .nl-card'
    const normalCountLabel = () =>
      js(
        "document.querySelector('.nl-custom .nl-zone:nth-child(2) .nl-group-count')?.textContent.replace(/\\s/g,'')"
      )
    assert.equal(await normalCountLabel(), '·60条')
    const before = await js(
      `Array.from(document.querySelectorAll('${normalSelector}'),e=>Number(e.dataset.noteId))`
    )
    assert.equal(before.length, 10)
    const changed = await js(
      `(async()=>{ const zone=document.querySelector('.nl-custom .nl-zone:nth-child(2) .nl-dropzone'); const key=Object.getOwnPropertyNames(zone).find(name=>/^Sortable/.test(name)); const sortable=zone[key]; if(!sortable?.options)throw Error('Sortable callback unavailable'); const item=zone.querySelector('.nl-card'); const event={item,from:zone,to:zone,oldIndex:0,newIndex:9}; sortable.options.onStart(event); zone.appendChild(item); sortable.options.onUpdate(event); sortable.options.onEnd(event); await Promise.resolve(); return true })()`
    )
    assert.equal(changed, true)
    const expected = [...before.slice(1), before[0]]
    await wait(250)
    report(
      JSON.stringify({
        before,
        expected,
        dom: await js(
          `Array.from(document.querySelectorAll('${normalSelector}'),e=>Number(e.dataset.noteId))`
        ),
        db: await js(
          `window.api.queryCustomNormal({statuses:['initialized','in_progress','completed'],tagIds:null,limit:10,offset:0}).then(r=>r.notes.map(n=>({id:n.id,slot:n.sort_order})))`
        )
      })
    )
    await until(
      async () =>
        JSON.stringify(
          await js(
            `window.api.queryCustomNormal({statuses:['initialized','in_progress','completed'],tagIds:null,limit:10,offset:0}).then(r=>r.notes.map(n=>n.id))`
          )
        ) === JSON.stringify(expected),
      'database sort persistence'
    )
    assert.deepEqual(
      await js(
        `Array.from(document.querySelectorAll('${normalSelector}'),e=>Number(e.dataset.noteId))`
      ),
      expected
    )
    assert.deepEqual(
      await js(
        "Array.from(document.querySelectorAll('.nl-custom .nl-zone:first-child .nl-card'),e=>Number(e.dataset.noteId))"
      ),
      pinnedBefore
    )
    verifiedScenarios.push(
      'synthetic callback reorder persists existing normal slots without altering pinned zone'
    )
    for (const count of [22, 42]) {
      await scrollToCustomBottom('initial page ' + count)
      await expectUI(
        "document.querySelectorAll('.nl-custom .nl-card').length===" + count,
        'custom page ' + count
      )
    }
    assert.equal(await normalCountLabel(), '·60条')
    verifiedScenarios.push('normal count shows all matching normal notes rather than loaded cards')
    await js(`window.api.updateNote(${fixture.pins[0]},{content:'Preserve loaded custom range'})`)
    await wait(400)
    assert.equal(await js("document.querySelectorAll('.nl-custom .nl-card').length"), 42)
    failNormal = true
    await js(
      `window.api.updateNote(${fixture.pins[0]},{content:'Failed custom refresh keeps previous cards'})`
    )
    await until(() => !failNormal, 'injected snapshot failure consumed')
    await wait(150)
    assert.equal(await js("document.querySelectorAll('.nl-custom .nl-card').length"), 42)
    verifiedScenarios.push('paging and anchored/failed snapshot retain loaded cards')
    // The next fixture inserts new rows while the old range stays scrollable. Keep it away from
    // the 80px paging threshold, so refresh restoration cannot auto-page past an expected count.
    await js(
      `new Promise(done=>{document.querySelector('.nl-custom').scrollTop=0;requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)))})`
    )
    fixtureObservations.push({
      label: 'before expanded fixture',
      cards: await js("document.querySelectorAll('.nl-custom .nl-card').length"),
      scrollTop: await js("document.querySelector('.nl-custom').scrollTop")
    })
    await js(
      `(async()=>{for(let i=0;i<90;i++)await window.api.createNote({content:'Additional normal '+i})})()`
    )
    await expectUI(
      "document.querySelector('.nl-custom .nl-zone:nth-child(2) .nl-group-count')?.textContent.replace(/\\s/g,'')==='·150条'",
      'expanded normal fixture total'
    )
    await wait(300)
    for (const count of [62, 82, 102, 122]) {
      await scrollToCustomBottom('expanded page ' + count)
      await expectUI(
        "document.querySelectorAll('.nl-custom .nl-card').length===" + count,
        'custom expanded page ' + count
      )
    }
    // Stay above the automatic next-page threshold while reading the end of the loaded range.
    await js(
      "(()=>{const el=document.querySelector('.nl-custom');el.scrollTop=el.scrollHeight-el.clientHeight-160})()"
    )
    await wait(250)
    const readingAnchor = await js(`(()=>{
      const el=document.querySelector('.nl-custom'),rect=el.getBoundingClientRect();
      const cards=Array.from(document.querySelectorAll('${normalSelector}'));
      const card=cards.filter(item=>{const r=item.getBoundingClientRect();return r.bottom>rect.top&&r.top<rect.bottom}).at(-1);
      if(!card)throw Error('No visible custom reading anchor');
      return {id:Number(card.dataset.noteId),index:cards.indexOf(card),offset:card.getBoundingClientRect().top-rect.top,scrollTop:el.scrollTop,lastId:Number(cards.at(-1).dataset.noteId)}
    })()`)
    assert.ok(readingAnchor.index >= 100, 'reading anchor is beyond the first database page')
    ipcTrace.length = 0
    await js(
      `window.api.updateNote(${fixture.pins[0]},{content:'Refresh over 100 loaded normal cards'})`
    )
    await until(() => ipcTrace.some((query) => query.offset === 100), 'second refresh page started')
    await wait(400)
    assert.equal(await js("document.querySelectorAll('.nl-custom .nl-card').length"), 122)
    assert.equal(await normalCountLabel(), '·150条')
    const afterAnchor = await js(`(()=>{
      const el=document.querySelector('.nl-custom'),rect=el.getBoundingClientRect();
      const cards=Array.from(document.querySelectorAll('${normalSelector}'));
      const card=cards.find(item=>Number(item.dataset.noteId)===${readingAnchor.id});
      return {offset:card?card.getBoundingClientRect().top-rect.top:null,scrollTop:el.scrollTop,lastId:Number(cards.at(-1).dataset.noteId)}
    })()`)
    assert.notEqual(afterAnchor.offset, null, 'reading anchor remains in the refreshed range')
    assert.ok(
      Math.abs(afterAnchor.offset - readingAnchor.offset) <= 1,
      'reading anchor keeps its viewport position'
    )
    assert.ok(
      Math.abs(afterAnchor.scrollTop - readingAnchor.scrollTop) <= 1,
      'loaded range refresh keeps scroll position'
    )
    assert.equal(afterAnchor.lastId, readingAnchor.lastId, 'last loaded normal card is retained')
    assert.deepEqual(
      ipcTrace.map(({ limit, offset }) => ({ limit, offset })),
      [
        { limit: 100, offset: 0 },
        { limit: 20, offset: 100 }
      ]
    )
    verifiedScenarios.push(
      '120 loaded normal cards refresh in capped pages and retain the final reading anchor and total 150'
    )
    ipcTrace.length = 0
    const quietGate = holdNextRefreshDelivery()
    try {
      await js(`window.api.updateNote(${fixture.pins[0]},{content:'Quiet refresh paging gate'})`)
      await until(() => quietGate.snapshotReady, 'quiet refresh real snapshot held')
      await scrollToCustomBottom('quiet refresh held')
      await wait(180)
      assert.deepEqual(
        ipcTrace.map(({ offset }) => offset),
        [0],
        'quiet refresh blocks the old 120 offset'
      )
    } finally {
      quietGate.release()
    }
    await until(
      () => ipcTrace.some(({ offset }) => offset === 100),
      'quiet refresh rebuilt second capped page'
    )
    await wait(400)
    await scrollToCustomBottom('quiet refresh resumed')
    await expectUI(
      `document.querySelectorAll('${normalSelector}').length===140`,
      'latest range resumes at offset 120'
    )
    assert.deepEqual(
      ipcTrace.map(({ offset }) => offset),
      [0, 100, 120]
    )
    assert.equal(
      await js(
        `(()=>{const ids=Array.from(document.querySelectorAll('${normalSelector}'),el=>el.dataset.noteId);return new Set(ids).size===ids.length})()`
      ),
      true
    )
    verifiedScenarios.push(
      'quiet refresh blocks old-offset DOM scroll requests and resumes with 140 unique normal cards'
    )

    await js(
      "(()=>{const el=document.querySelector('.nl-custom');el.scrollTop=el.scrollHeight-el.clientHeight-380})()"
    )
    await wait(180)
    ipcTrace.length = 0
    const readingGate = holdNextRefreshDelivery()
    let latestAnchor
    try {
      await js(
        `window.api.updateNote(${fixture.pins[0]},{content:'Latest reading anchor after query wait'})`
      )
      await until(() => readingGate.snapshotReady, 'reading refresh real snapshot held')
      latestAnchor = await js(`(()=>{
        const el=document.querySelector('.nl-custom');el.scrollTop-=180;el.dispatchEvent(new Event('scroll'));
        const rect=el.getBoundingClientRect(),cards=Array.from(document.querySelectorAll('${normalSelector}'));
        const card=cards.find(item=>item.getBoundingClientRect().bottom>rect.top);
        return {id:Number(card.dataset.noteId),offset:card.getBoundingClientRect().top-rect.top,scrollTop:el.scrollTop}
      })()`)
      await wait(100)
      assert.deepEqual(
        ipcTrace.map(({ offset }) => offset),
        [0],
        'reading movement cannot page before refresh delivery'
      )
    } finally {
      readingGate.release()
    }
    await until(
      () => ipcTrace.some(({ offset }) => offset === 100),
      'reading refresh rebuilt its range'
    )
    await wait(400)
    const latestAfter = await js(`(()=>{
      const el=document.querySelector('.nl-custom'),rect=el.getBoundingClientRect();
      const card=Array.from(document.querySelectorAll('${normalSelector}')).find(item=>Number(item.dataset.noteId)===${latestAnchor.id});
      return {offset:card?.getBoundingClientRect().top-rect.top,scrollTop:el.scrollTop}
    })()`)
    assert.ok(
      Math.abs(latestAfter.offset - latestAnchor.offset) <= 1,
      'refresh preserves the anchor moved while awaiting the query'
    )
    assert.ok(
      Math.abs(latestAfter.scrollTop - latestAnchor.scrollTop) <= 1,
      'refresh does not restore the earlier scroll position'
    )
    verifiedScenarios.push(
      'quiet refresh restores the latest real DOM reading anchor captured after waiting for SQLite IPC delivery'
    )

    ipcTrace.length = 0
    // replayListRefresh captures the position at click time. Start at the top so its own
    // restoration does not auto-fill every new page before the explicit resume assertion.
    await js(
      `new Promise(done=>{document.querySelector('.nl-custom').scrollTop=0;requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)))})`
    )
    fixtureObservations.push({
      label: 'manual before click',
      cards: await js("document.querySelectorAll('.nl-custom .nl-card').length"),
      scrollTop: await js("document.querySelector('.nl-custom').scrollTop")
    })
    const manualGate = holdNextRefreshDelivery()
    try {
      await js("document.querySelector('.sg-btn--taiji').click()")
      await until(() => manualGate.snapshotReady, 'manual taiji refresh real snapshot held')
      assert.equal(
        await js("Boolean(document.querySelector('.nl-custom'))"),
        true,
        'manual quiet refresh retains its scroll container'
      )
      await scrollToCustomBottom('manual refresh held')
      await wait(180)
      assert.deepEqual(
        ipcTrace.map(({ offset }) => offset),
        [0],
        'manual quiet refresh blocks the old 140 offset'
      )
      await js(
        `new Promise(done=>{document.querySelector('.nl-custom').scrollTop=0;requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)))})`
      )
      fixtureObservations.push({
        label: 'manual before release',
        cards: await js("document.querySelectorAll('.nl-custom .nl-card').length"),
        scrollTop: await js("document.querySelector('.nl-custom').scrollTop")
      })
    } finally {
      manualGate.release()
    }
    await expectUI(
      `document.querySelectorAll('${normalSelector}').length===20`,
      'manual refresh starts a new normal range'
    )
    await wait(400)
    assert.equal(
      await js(`document.querySelectorAll('${normalSelector}').length`),
      20,
      'manual refreshed range stays at its exact initial page before scrolling'
    )
    await scrollToCustomBottom('manual refresh resumed')
    await expectUI(
      `document.querySelectorAll('${normalSelector}').length===40`,
      'manual refreshed range admits the next real scroll page'
    )
    assert.equal(ipcTrace[0].limit, 20)
    assert.deepEqual(
      ipcTrace.map(({ offset }) => offset),
      [0, 20],
      'one real resume scroll admits exactly offset 20'
    )
    assert.deepEqual(
      ipcTrace.map(({ offset }) => offset),
      ipcTrace.map((_, index) => index * 20),
      'manual pages use only offsets belonging to the refreshed range'
    )
    assert.equal(
      await js(
        `(()=>{const ids=Array.from(document.querySelectorAll('${normalSelector}'),el=>el.dataset.noteId);return new Set(ids).size===ids.length})()`
      ),
      true
    )
    verifiedScenarios.push(
      'actual taiji manual quiet refresh blocks old offsets, then scroll paging follows the new contiguous range without duplicates'
    )
    pageDelay = 500
    ipcTrace.length = 0
    await scrollToCustomBottom('pending page before mode switch')
    await until(() => ipcTrace.some((x) => x.offset > 0), 'pending custom page started')
    await js(
      "window.api.setSettingValue('listFilter',{listMode:'timeline',tagIds:[],statusFilter:[]})"
    )
    await wait(800)
    assert.equal(
      await js(
        "Boolean(document.querySelector('.nl-timeline'))&&!document.querySelector('.nl-custom')"
      ),
      true
    )
    verifiedScenarios.push('pending custom page cannot restore the prior mode')
    completed = true
    await requestShutdown()
  } catch (error) {
    report(error.stack || String(error))
    await requestShutdown(error)
  }
}
const testTimeout = setTimeout(
  () => void requestShutdown(new Error('Custom list timed out')),
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
