import { createRequire, syncBuiltinESMExports } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'
import { waitForFixtureFrame } from './helpers/electron-fixture-frame.mjs'
import { createOwnedDraftAssetIo } from './helpers/owned-draft-asset-io.mjs'

const results = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/session-draft-assets-product-electron.mjs',
  mode: 'electron-session-draft-assets-real-product',
  prefix: 'abandon-draft-product-',
  timeoutMs: 90000,
  destroyWindowsBeforeQuit: false,
  metadata: {
    application: 'built production main/preload/renderer with owned SQLite and files',
    input: 'DOM file/input/click events; no physical keyboard or mouse claim',
    faults:
      'one held asset write, exact owned unlink denial, SQLite trigger, held submit reply and real concurrent note update',
    boundaries: ['same startup reload', 'no installation, power loss or native capture-input proof']
  }
})
const { assert, root } = results
app.setPath('userData', root)
process.env.ABANDON_INTEGRATION_TEST = '1'
process.env.ABANDON_INTEGRATION_APP_ROOT = process.cwd()
process.env.ABANDON_INTEGRATION_NATIVE_DLL = resolve('native_blur/build/bin/blur_engine.dll')
const dbFile = join(root, 'app.db'),
  assetRoot = join(root, 'session-draft-assets')
const seed = new Database(dbFile)
seed.exec(`CREATE TABLE app_settings (window_name TEXT NOT NULL,type TEXT NOT NULL,key TEXT NOT NULL,
  value TEXT,remark TEXT DEFAULT '',created_at INTEGER,updated_at INTEGER,PRIMARY KEY(window_name,key))`)
const insert = seed.prepare('INSERT INTO app_settings(window_name,type,key,value) VALUES(?,?,?,?)')
for (const [scope, type, key, value] of [
  ['application', 'application', 'active_view', 'list'],
  ['application', 'remote', 'receive_notices', 'false'],
  ['application', 'remote', 'upload_device_info', 'false'],
  ['application', 'onboarding', 'first_use_notice_version', '1'],
  ...['screenshot', 'screenshot_copy', 'clipboard_pin', 'toggle_pins', 'view_visibility'].map(
    (key) => ['application', 'shortcuts', key, '']
  ),
  ...['main', 'month', 'week'].map((scope) => [scope, 'system', 'blur_enabled', 'false'])
])
  insert.run(scope, type, key, value)
seed.close()
const require = createRequire(import.meta.url)
const filesystem = require('node:fs/promises')
const originalHandle = ipcMain.handle
const metrics = { writes: 0, reads: 0, deniedUnlinks: 0, heldResponses: 0 }
const scenarios = [],
  evidence = {}
let window,
  hooks,
  writeGate,
  replyGate,
  denyUnlink = false,
  businessCompleted = false
let rejectNextReply = false
function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const assetIo = createOwnedDraftAssetIo({
  filesystem,
  assetRoot,
  metrics,
  async beforeWrite() {
    const gate = writeGate
    if (gate) {
      writeGate = null
      gate.entered.resolve()
      await gate.release.promise
    }
  },
  denyUnlink: () => denyUnlink
})
Object.assign(filesystem, assetIo.io)
syncBuiltinESMExports()
ipcMain.handle = function (channel, handler) {
  return originalHandle.call(
    this,
    channel,
    channel === 'draft-assets:submit-note'
      ? async (...args) => {
          const result = await handler(...args)
          if (rejectNextReply) {
            rejectNextReply = false
            throw new Error('Controlled lost committed response')
          }
          const gate = replyGate
          if (gate) {
            replyGate = null
            metrics.heldResponses++
            gate.entered.resolve(result)
            await gate.release.promise
          }
          return result
        }
      : handler
  )
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const js = (code) => window.webContents.executeJavaScript(code)
async function until(read, label) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await wait(20)
  }
  assert.fail(label)
}
function database(operation) {
  const db = new Database(dbFile)
  try {
    return operation(db)
  } finally {
    db.close()
  }
}
const noteCount = (content) =>
  database(
    (db) => db.prepare('SELECT COUNT(*) AS count FROM notes WHERE content=?').get(content).count
  )
const journals = () =>
  js(
    `Object.keys(localStorage).filter(k=>k.startsWith('abandon:editing-draft:v3:')).map(k=>({key:k,value:JSON.parse(localStorage.getItem(k))}))`
  )
async function fill(text, scope = '.nnp-root') {
  await js(
    `(()=>{const n=document.querySelector(${JSON.stringify(scope + ' textarea')});n.value=${JSON.stringify(text)};n.dispatchEvent(new Event('input',{bubbles:true}))})()`
  )
  await js('window.__prepareEditingDrafts()')
}
async function attach(png, scope = '.nnp-root') {
  await js(
    `(()=>{const transfer=new DataTransfer();const bytes=Uint8Array.from(atob(${JSON.stringify(png)}),c=>c.charCodeAt(0));transfer.items.add(new File([bytes],'owned.png',{type:'image/png'}));const input=document.querySelector(${JSON.stringify(scope + ' input[type=file]')});input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`
  )
}
async function settledImage(scope = '.nnp-root') {
  await until(
    () =>
      js(
        `(()=>{const root=document.querySelector(${JSON.stringify(scope)});return root?.querySelectorAll('.ip-thumb').length===1&&!root.querySelector('.ip-thumb--loading')})()`
      ),
    'staged image appears'
  )
  await until(
    async () => (await js('window.__prepareEditingDrafts()')).blocked === false,
    'draft images settle'
  )
}
async function submit() {
  await js(`document.querySelector('.nnp-root .nnp-submit').click()`)
}
async function reload() {
  const loaded = new Promise((done) => window.webContents.once('did-finish-load', done))
  window.webContents.reload()
  await loaded
  await until(() => js(`Boolean(document.querySelector('.nnp-root textarea'))`), 'list remounted')
}
async function openEditor(id) {
  const card = `.nl-card[data-note-id="${id}"]`
  await until(
    () => js(`Boolean(document.querySelector(${JSON.stringify(card)}))`),
    'edit target is listed'
  )
  await js(`(() => {
    const node=document.querySelector(${JSON.stringify(card)});
    node.scrollIntoView({block:'center'});
    node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:180}));
  })()`)
  await until(
    () => js(`Boolean(document.querySelector('.nl-context-menu'))`),
    'edit context menu opens'
  )
  await js(
    `Array.from(document.querySelectorAll('.nl-context-menu button')).find(button=>button.textContent.trim()==='修改').click()`
  )
  await until(
    () => js(`Boolean(document.querySelector('.app-editor.ne-root textarea'))`),
    'full editor mounts'
  )
  await until(
    async () => !(await js('window.__prepareEditingDrafts()')).blocked,
    'full editor finishes its draft restoration'
  )
}
async function switchView(mode, preserveDraft = false) {
  const previousSource = (await js('window.api.getSettingsSnapshot()')).source
  const windowId = window.id
  assert.equal(
    await js(`window.api.switchMainView(${JSON.stringify(mode)})`),
    true,
    'view request is admitted'
  )
  if (preserveDraft) {
    await until(
      () =>
        js(
          `Boolean(document.querySelector('.confirm-card.active[aria-label="保留草稿后继续？"]'))`
        ),
      'image edit asks to preserve the draft before navigation'
    )
    await js(
      `Array.from(document.querySelectorAll('.confirm-card.active button')).find(button=>button.textContent.trim()==='保留并切换').click()`
    )
  }
  const filename = mode === 'list' ? 'index' : mode
  await until(() => {
    const navigation = hooks.navigationState()
    return (
      window.webContents.getURL().endsWith('/' + filename + '.html') &&
      navigation.mode === mode &&
      !navigation.switching &&
      !navigation.pendingReady
    )
  }, mode + ' navigation reaches its real renderer-ready terminal')
  await until(
    () =>
      js(
        `Boolean(document.querySelector('.titlebar-btn-settings')) && typeof window.__prepareEditingDrafts==='function'`
      ),
    mode + ' document is interactive'
  )
  const source = (await js('window.api.getSettingsSnapshot()')).source
  assert.equal(window.id, windowId, 'navigation retains the actual BrowserWindow')
  assert.notEqual(source.token, previousSource.token, 'navigation creates a new source document')
  assert.equal(source.scope, mode === 'list' ? 'main' : mode, 'new document has the target scope')
  return {
    source,
    previousSource,
    windowId,
    url: window.webContents.getURL(),
    navigation: hooks.navigationState()
  }
}
async function imageEditState(id) {
  const record = (await journals()).find((entry) => entry.value.key === 'note:' + id)
  assert.ok(record, 'image edit has a metadata journal')
  const image = record.value.data.attachments.addedImages[0]
  const runtime = hooks.draftAssetState()
  const asset = runtime.assets.find((entry) => entry.assetId === image?.assetId)
  assert.ok(asset, 'journal still names a real owned asset')
  return {
    journal: record,
    asset,
    runtime,
    assetFileSha256: createHash('sha256').update(readFileSync(asset.path)).digest('hex'),
    note: await js(`window.api.getNote(${id})`),
    editorContent: await js(`document.querySelector('.ne-root textarea')?.value ?? null`)
  }
}
async function imageEditConflictState(record) {
  return js(
    `window.api.draftAssets.noteState(${JSON.stringify(record.value.owner)},${JSON.stringify(record.value.handoff.requestId)})`
  )
}
async function imageEditCombination(png) {
  const chain = { stages: {} }
  evidence.imageEditCombination = chain
  const localContent = 'combined-image-edit-local-draft'
  const externalContent = 'combined-image-edit-newer-external'
  const created = await js(`window.api.createNote({content:'combined-image-edit-original'})`)
  chain.noteId = created.id
  await openEditor(created.id)
  await fill(localContent, '.ne-root')
  await attach(png, '.ne-root')
  await settledImage('.ne-root')
  const prepared = await js('window.__prepareEditingDrafts()')
  assert.deepEqual(
    prepared,
    { dirty: true, blocked: false },
    'image edit is safely journalled before navigation'
  )
  const staged = await imageEditState(created.id)
  chain.stages.staged = staged
  assert.equal(
    staged.journal.value.data.attachments.addedImages.length,
    1,
    'one image belongs to the edit draft'
  )
  assert.equal(staged.runtime.assetCount, 1, 'combination starts with one actual staged asset')
  assert.equal(
    staged.journal.value.data.initialVersion,
    staged.note.editVersion,
    'journal retains the editor base version'
  )
  assert.equal(staged.journal.value.handoff, null, 'staging has not submitted the edit')
  const image = staged.journal.value.data.attachments.addedImages[0]
  const expectedSha256 = createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex')
  assert.equal(image.sha256, expectedSha256, 'staged metadata names the original PNG bytes')
  for (const forbidden of ['base64', 'data:image', 'blob:', 'capability', assetRoot])
    assert.equal(
      JSON.stringify(staged.journal).includes(forbidden),
      false,
      'edit journal is metadata only: ' + forbidden
    )
  const writesAfterStage = metrics.writes

  chain.toMonth = await switchView('month', true)
  const away = await imageEditState(created.id)
  chain.stages.away = away
  assert.deepEqual(
    away.journal.value.owner,
    staged.journal.value.owner,
    'successful cross-view navigation retains the public owner'
  )
  assert.deepEqual(
    away.journal.value.data.attachments,
    staged.journal.value.data.attachments,
    'successful navigation preserves the same image metadata'
  )
  assert.equal(
    away.assetFileSha256,
    staged.assetFileSha256,
    'successful navigation preserves the actual staged file'
  )
  assert.equal(away.editorContent, null, 'the old editor really left with its document')

  // The existing public mutation creates a real new database version while the
  // image draft is safely retained in a different production view.
  await js(`window.api.updateNote(${created.id},{content:${JSON.stringify(externalContent)}})`)
  const external = await js(`window.api.getNote(${created.id})`)
  chain.externalNote = external
  assert.equal(
    external.content,
    externalContent,
    'external update is committed in the real database'
  )
  assert.notEqual(
    external.editVersion,
    staged.note.editVersion,
    'external update changes the edit version'
  )
  chain.toList = await switchView('list')
  await openEditor(created.id)
  await settledImage('.ne-root')
  const returned = await imageEditState(created.id)
  chain.stages.returned = returned
  assert.equal(returned.editorContent, localContent, 'returning to the editor restores local text')
  assert.deepEqual(
    returned.journal.value.owner,
    staged.journal.value.owner,
    'replacement document rebinds the same public owner and generation'
  )
  assert.deepEqual(
    returned.journal.value.data.attachments,
    staged.journal.value.data.attachments,
    'returning restores the same image asset'
  )
  assert.equal(
    returned.journal.value.data.initialVersion,
    staged.note.editVersion,
    'restoration never silently rebases the draft version'
  )

  await js(`document.querySelector('.ne-root .ne-submit').click()`)
  await until(
    () =>
      js(
        `Array.from(document.querySelectorAll('.msg-toast')).some(node=>node.textContent.includes('便签已发生变化')) && !document.querySelector('.ne-root .ne-submit').disabled`
      ),
    'real version conflict explains failure and unlocks the original draft'
  )
  await until(() => {
    const state = hooks.draftAssetState()
    const current = state.assets.find((entry) => entry.assetId === image.assetId)
    return (
      state.runtime.pending === 0 &&
      current?.pins === 0 &&
      current.readPins === 0 &&
      !current.handoffReserved
    )
  }, 'failed image handoff releases its reservations and read pins')
  const failed = await imageEditState(created.id)
  chain.stages.conflict = failed
  assert.ok(
    failed.journal.value.handoff?.requestId,
    'failed submission identity remains journalled'
  )
  chain.failedReceipt = await imageEditConflictState(failed.journal)
  assert.equal(
    chain.failedReceipt.status,
    'failed',
    'fixed note command records the actual failed result'
  )
  assert.equal(
    chain.failedReceipt.error.code,
    'DRAFT_NOTE_CONFLICT',
    'failure is specifically the database version conflict'
  )
  assert.equal(failed.editorContent, localContent, 'conflict preserves local text')
  assert.equal(
    failed.note.content,
    externalContent,
    'conflict does not overwrite newer database text'
  )
  assert.equal(
    failed.note.editVersion,
    external.editVersion,
    'conflict does not change the database version'
  )
  assert.equal(
    failed.note.attachments.length,
    0,
    'conflict does not commit the draft image as an attachment'
  )
  assert.deepEqual(
    failed.journal.value.owner,
    staged.journal.value.owner,
    'failed handoff preserves the active image owner'
  )
  assert.deepEqual(
    failed.journal.value.data.attachments,
    staged.journal.value.data.attachments,
    'failed handoff preserves original asset metadata'
  )
  assert.equal(failed.asset.status, 'ready', 'failed handoff leaves the image usable')
  assert.equal(
    failed.assetFileSha256,
    staged.assetFileSha256,
    'failed handoff preserves the staged file bytes'
  )
  assert.equal(
    failed.journal.value.handoff.payload.expectedVersion,
    staged.note.editVersion,
    'failed request retains its original expected version'
  )

  chain.sourceBeforeReload = (await js('window.api.getSettingsSnapshot()')).source
  await reload()
  chain.sourceAfterReload = (await js('window.api.getSettingsSnapshot()')).source
  assert.notEqual(
    chain.sourceAfterReload.token,
    chain.sourceBeforeReload.token,
    'same-startup reload replaces the source document'
  )
  assert.equal(
    await js(`Boolean(document.querySelector('.ne-root'))`),
    false,
    'reload does not auto-open or replay the failed editor'
  )
  await openEditor(created.id)
  await settledImage('.ne-root')
  const recovered = await imageEditState(created.id)
  chain.stages.recovered = recovered
  assert.equal(
    recovered.editorContent,
    localContent,
    'reopening after reload restores failed local text'
  )
  assert.deepEqual(
    recovered.journal.value.owner,
    staged.journal.value.owner,
    'reload rebinds the same owner and generation'
  )
  assert.deepEqual(
    recovered.journal.value.data.attachments,
    staged.journal.value.data.attachments,
    'reload restores the same asset identity and checksum'
  )
  assert.equal(
    recovered.journal.value.data.initialVersion,
    staged.note.editVersion,
    'recovery retains the original base version'
  )
  assert.deepEqual(
    recovered.journal.value.handoff,
    failed.journal.value.handoff,
    'recovery keeps the failed request instead of replaying or relabelling it'
  )
  chain.recoveredReceipt = await imageEditConflictState(recovered.journal)
  assert.deepEqual(
    chain.recoveredReceipt,
    chain.failedReceipt,
    'recovery observes the same terminal conflict'
  )
  assert.equal(
    recovered.note.content,
    externalContent,
    'recovery preserves the newer database content'
  )
  assert.equal(
    recovered.note.editVersion,
    external.editVersion,
    'recovery does not mutate the database version'
  )
  assert.equal(recovered.note.attachments.length, 0, 'recovery does not auto-commit attachments')
  assert.equal(
    recovered.assetFileSha256,
    staged.assetFileSha256,
    'recovery preserves the original staged file'
  )
  assert.equal(
    metrics.writes,
    writesAfterStage,
    'navigation, conflict and restoration do not restage image bytes'
  )
  await until(
    () => js(`document.querySelector('.ne-root .ip-thumb__img')?.naturalWidth===2`),
    'restored image thumbnail decodes under the production CSP'
  )
  await js(`document.querySelector('.ne-root .ip-thumb__img').click()`)
  await until(
    () => js(`document.querySelector('.ipv-image')?.naturalWidth===2`),
    'restored original image preview decodes'
  )
  await js(`document.querySelector('.ipv-btn--close').click()`)
  await until(
    () => js(`!document.querySelector('.ipv-overlay')`),
    'restored original preview closes'
  )
  chain.originalRead = await js(`(async () => {
    const payload=await window.api.draftAssets.preview(${JSON.stringify(recovered.journal.value.owner)},${JSON.stringify(image.assetId)});
    const digest=await crypto.subtle.digest('SHA-256',payload.bytes);
    return {size:payload.size,metadataSha256:payload.sha256,actualSha256:Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')};
  })()`)
  assert.equal(
    chain.originalRead.actualSha256,
    expectedSha256,
    'recovered asset returns the exact original PNG bytes'
  )
  assert.equal(
    chain.originalRead.metadataSha256,
    expectedSha256,
    'original read metadata agrees with its bytes'
  )
  await until(() => {
    const state = hooks.draftAssetState()
    const current = state.assets.find((entry) => entry.assetId === image.assetId)
    return state.runtime.pending === 0 && current?.readPins === 0 && current.pins === 0
  }, 'recovered original read releases its resource pins')
  assert.deepEqual(
    await js('window.__prepareEditingDrafts()'),
    { dirty: true, blocked: false },
    'recovered failed draft stays editable and safely retained'
  )
  scenarios.push(
    'one image edit survives successful cross-view navigation, real version conflict and same-startup reload without losing its owner, assets or failed request'
  )

  // Evidence above retains the failed draft. Cleanup is explicit and limited to
  // this owned profile, before the existing independent normal-quit scenario.
  await js('window.api.clearNoteData()')
  await until(
    async () =>
      !(await js('window.__prepareEditingDrafts()')).dirty &&
      (await js(
        `!document.querySelector('.ne-root') && Boolean(document.querySelector('.nnp-root input[type=file]'))`
      )),
    'owned combination cleanup closes the editor and invalidates its draft'
  )
  assert.equal(
    hooks.draftAssetState().assetCount,
    0,
    'owned combination cleanup releases the image'
  )
  assert.equal(
    existsSync(staged.asset.path),
    false,
    'owned combination cleanup removes its exact staged file'
  )
  assert.equal(
    await js(`window.api.getNote(${created.id})`),
    null,
    'owned combination cleanup removes its test note'
  )
  chain.cleanup = {
    assetCount: hooks.draftAssetState().assetCount,
    stagedFileExists: existsSync(staged.asset.path)
  }
}
async function finalFrame() {
  const frame = waitForFixtureFrame({
    webContents: window.webContents,
    name: 'product-draft-final',
    marker: [49, 131, 223],
    palette: 'white',
    viewport: await js('({width:innerWidth,height:innerHeight})')
  })
  try {
    await js(
      `(()=>{const marker=document.createElement('div');marker.style.cssText='position:fixed;left:0;top:154px;width:24px;height:24px;background:rgb(49,131,223);z-index:10000';const patch=document.createElement('div');patch.style.cssText='position:fixed;left:calc(5vw - 8px);top:calc(20vh - 8px);width:16px;height:16px;background:white;z-index:10000';document.body.append(marker,patch)})()`
    )
    await frame.ready
    assert.ok(frame.trace.selected, 'the final product generation is actually presented')
  } finally {
    frame.close()
    evidence.frame = frame.trace
    writeFileSync(
      join(process.env.ABANDON_TEST_EVIDENCE_DIR || root, 'product-frame.json'),
      JSON.stringify(frame.trace, null, 2),
      { flag: 'wx' }
    )
  }
}
async function run() {
  let activeWrite, activeReply
  try {
    window = await until(
      () =>
        BrowserWindow.getAllWindows().find((target) =>
          /\/index\.html(?:$|[?#])/.test(target.webContents.getURL())
        ),
      'main product window'
    )
    hooks = globalThis.__ABANDON_WINDOW_TEST_HOOKS__
    await until(
      () =>
        js(
          `Boolean(document.querySelector('.nnp-root input[type=file]'))&&typeof window.__prepareEditingDrafts==='function'`
        ),
      'real form/preload ready'
    )
    await js('window.api.clearNoteData()')
    const png = nativeImage
      .createFromBitmap(
        Buffer.from([210, 60, 80, 255, 80, 180, 60, 255, 60, 80, 210, 255, 240, 210, 60, 255]),
        { width: 2, height: 2 }
      )
      .toPNG()
      .toString('base64')

    const legacyImages = [
      png,
      nativeImage
        .createFromBitmap(Buffer.alloc(16, 128), { width: 2, height: 2 })
        .toPNG()
        .toString('base64')
    ]
    const legacy = await js(`(() => {
      const session=window.api.runtimeCapabilities.editingDraftSessionId;
      const key='abandon:editing-draft:v2:'+session+':new:list';
      const foreignKey='abandon:editing-draft:v2:00000000-0000-4000-8000-000000000001:new:list';
      const foreignRaw=JSON.stringify({updatedAt:1,data:{content:'preserve other launch'}});
      const data={content:'legacy-product-images',remark:'legacy remark',attachments:{
        addedImages:${JSON.stringify(legacyImages)}.map((base64,index)=>({base64,ext:'png',name:'legacy-'+index+'.png',size:atob(base64).length})),
        deletedImageIds:[]
      }};
      const raw=JSON.stringify({updatedAt:Date.now(),data});
      localStorage.setItem(key,raw);
      localStorage.setItem(foreignKey,foreignRaw);
      return {key,raw,foreignKey,foreignRaw};
    })()`)
    await reload()
    await until(
      () =>
        js(
          `document.querySelector('.nnp-root textarea')?.value==='legacy-product-images' && document.querySelectorAll('.nnp-root .ip-thumb__img').length===2`
        ),
      'legacy text and both image assets restore in the same launch'
    )
    await until(
      async () => !(await js('window.__prepareEditingDrafts()')).blocked,
      'legacy migration finishes'
    )
    assert.equal(
      await js(`localStorage.getItem(${JSON.stringify(legacy.key)})`),
      null,
      'only a completed migration removes its legacy original'
    )
    assert.equal(
      await js(`localStorage.getItem(${JSON.stringify(legacy.foreignKey)})`),
      legacy.foreignRaw
    )
    const migrated = (await journals()).find((record) => record.value.key === 'new:list')
    assert.equal(migrated.value.data.attachments.addedImages.length, 2)
    assert.equal(JSON.stringify(migrated).includes(png), false)
    assert.ok(
      migrated.value.data.attachments.addedImages.every(
        (image) => image.assetId && !Object.hasOwn(image, 'base64')
      )
    )
    assert.equal(hooks.draftAssetState().assetCount, 2)
    assert.equal(noteCount('legacy-product-images'), 0, 'migration does not submit SQL')
    await reload()
    await until(
      () => js(`document.querySelectorAll('.nnp-root .ip-thumb__img').length===2`),
      'migrated assets survive another reload'
    )
    await until(
      async () => !(await js('window.__prepareEditingDrafts()')).blocked,
      'migrated form is ready'
    )
    assert.equal(
      hooks.draftAssetState().assetCount,
      2,
      'reload does not duplicate migrated image files'
    )
    await submit()
    await until(
      () => noteCount('legacy-product-images') === 1,
      'migrated draft explicitly commits once'
    )
    const migratedNote = database((db) =>
      db.prepare('SELECT id,remark FROM notes WHERE content=?').get('legacy-product-images')
    )
    assert.equal(migratedNote.remark, 'legacy remark')
    assert.equal(
      database(
        (db) =>
          db
            .prepare('SELECT COUNT(*) AS count FROM note_attachments WHERE note_id=?')
            .get(migratedNote.id).count
      ),
      2
    )
    await until(
      () => js(`document.querySelector('.nnp-root textarea')?.value===''`),
      'migrated create clears its form'
    )
    scenarios.push(
      'legacy v2 text and two Base64 images migrate once, survive reload and commit only on explicit save'
    )
    evidence.legacyMigration = { imageCount: 2, foreignRecordPreserved: true }
    await js('window.api.clearNoteData()')
    assert.equal(
      await js(`localStorage.getItem(${JSON.stringify(legacy.foreignKey)})`),
      legacy.foreignRaw
    )

    activeWrite = { entered: deferred(), release: deferred() }
    writeGate = activeWrite
    await attach(png)
    await activeWrite.entered.promise
    assert.ok(metrics.writes > 0, 'the held write is an actual owned FileHandle payload write')
    assert.equal(
      (await js('window.__prepareEditingDrafts()')).blocked,
      true,
      'accepted image work blocks leaving'
    )
    await js(`(() => {
      window.__draftProductSwitchFinished=false;
      window.__draftProductStopSwitch=window.api.onMainViewSwitchFinished(() => {
        window.__draftProductSwitchFinished=true;
        window.__draftProductStopSwitch?.();
        window.__draftProductStopSwitch=null;
      });
    })()`)
    // This IPC acknowledges queueing; the later event completes its guarded request.
    assert.equal(await js(`window.api.switchMainView('month')`), true, 'view request is admitted')
    await until(
      () => js('window.__draftProductSwitchFinished'),
      'busy page view-switch request completes'
    )
    assert.match(window.webContents.getURL(), /index\.html/, 'busy page cannot navigate away')
    assert.equal((await js('window.__prepareEditingDrafts()')).blocked, true)
    activeWrite.release.resolve()
    await settledImage()
    await until(
      () => js(`document.querySelector('.nnp-root .ip-thumb__img')?.naturalWidth === 2`),
      'the product CSP allows its Blob thumbnail to decode'
    )
    await js(`document.querySelector('.nnp-root .ip-thumb__img').click()`)
    await until(
      () => js(`document.querySelector('.ipv-image')?.naturalWidth === 2`),
      'the actual original image preview decodes under the product CSP'
    )
    assert.ok(metrics.reads > 0, 'opening the original preview reads the owned payload')
    assert.equal(await js(`document.querySelector('.ipv-image').src.startsWith('blob:')`), true)
    await js(`document.querySelector('.ipv-btn--close').click()`)
    await until(() => js(`!document.querySelector('.ipv-overlay')`), 'the image preview closes')
    scenarios.push(
      'real file selection has synchronous busy admission and blocks navigation until staged'
    )

    const writesBeforeText = metrics.writes,
      readsBeforeText = metrics.reads
    for (let index = 0; index < 20; index++) await fill('draft-product-' + index)
    assert.equal(metrics.writes, writesBeforeText, 'text edits never rewrite staged image bytes')
    assert.equal(metrics.reads, readsBeforeText, 'text edits never reread staged image bytes')
    const beforeReload = await journals()
    const form = beforeReload.find((record) => record.value.key === 'new:list')
    assert.ok(form?.value.owner?.ownerId, 'journal stores the resumable public owner')
    assert.equal(form.value.data.attachments.addedImages.length, 1)
    assert.ok(form.value.data.attachments.addedImages[0].assetId)
    for (const forbidden of ['base64', 'data:image', 'blob:', 'capability', assetRoot])
      assert.equal(
        JSON.stringify(beforeReload).includes(forbidden),
        false,
        'journal contains metadata only: ' + forbidden
      )
    await reload()
    await until(
      () => js(`document.querySelector('.nnp-root textarea')?.value==='draft-product-19'`),
      'text restored in the same launch'
    )
    await settledImage()
    assert.equal(hooks.draftAssetState().assetCount, 1)
    scenarios.push(
      'twenty edits preserve metadata-only persistence; reload rebinds the same image owner'
    )

    database((db) =>
      db.exec(
        `CREATE TRIGGER draft_product_failure BEFORE INSERT ON notes WHEN NEW.content='draft-product-19' BEGIN SELECT RAISE(ABORT,'controlled draft SQL failure'); END`
      )
    )
    await submit()
    await until(
      async () => (await journals()).some((record) => record.value.handoff?.requestId),
      'failed attempt identity persisted'
    )
    await until(
      () => js(`!document.querySelector('.nnp-root .nnp-submit').disabled`),
      'SQL failure releases submit busy'
    )
    assert.equal(noteCount('draft-product-19'), 0)
    assert.equal(hooks.draftAssetState().assetCount, 1, 'failed SQL retains original image')
    database((db) => db.exec('DROP TRIGGER draft_product_failure'))
    denyUnlink = true
    await submit()
    await until(
      () => noteCount('draft-product-19') === 1,
      'explicit retry commits exactly one note'
    )
    await until(
      () => js(`document.querySelector('.nnp-root textarea')?.value===''`),
      'committed create clears its form despite cleanup denial'
    )
    assert.ok(metrics.deniedUnlinks > 0)
    const stored = database((db) =>
      db
        .prepare(
          `SELECT a.file_path FROM note_attachments a JOIN notes n ON n.id=a.note_id WHERE n.content=?`
        )
        .all('draft-product-19')
    )
    assert.equal(stored.length, 1)
    assert.equal(
      createHash('sha256')
        .update(readFileSync(join(root, stored[0].file_path)))
        .digest('hex'),
      createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex')
    )
    denyUnlink = false
    scenarios.push(
      'real SQL rollback preserves assets; explicit retry succeeds once despite postcommit unlink failure'
    )

    await fill('draft-product-unconfirmed')
    rejectNextReply = true
    await submit()
    await until(
      () => noteCount('draft-product-unconfirmed') === 1,
      'original request committed before its response is lost'
    )
    await until(
      () => js(`!document.querySelector('.nnp-root .nnp-submit').disabled`),
      'original result can be queried with the save control'
    )
    assert.equal(
      await js(`document.querySelector('.nnp-root .nnp-body').inert`),
      true,
      'unconfirmed save locks fields and image controls so later edits cannot be discarded with the old result'
    )
    await submit()
    await until(
      () => js(`document.querySelector('.nnp-root textarea')?.value===''`),
      'query acknowledges the original committed result'
    )
    assert.equal(noteCount('draft-product-unconfirmed'), 1)
    scenarios.push(
      'a lost response in the current document locks editing while the save control queries the original result'
    )

    await fill('draft-product-response-lost')
    activeReply = { entered: deferred(), release: deferred() }
    replyGate = activeReply
    await submit()
    const committed = await activeReply.entered.promise
    assert.equal(committed.value.status, 'committed')
    assert.equal(noteCount('draft-product-response-lost'), 1)
    await reload()
    await until(
      () => js(`document.querySelector('.nnp-root textarea')?.value===''`),
      'known committed request is acknowledged without rehydrating old form'
    )
    await until(
      async () => (await js('window.__prepareEditingDrafts()')).dirty === false,
      'recovered commit leaves a clean form'
    )
    activeReply.release.resolve()
    assert.equal(
      noteCount('draft-product-response-lost'),
      1,
      'lost response does not replay the committed create'
    )
    assert.equal(metrics.heldResponses, 1)
    scenarios.push(
      'reload with a lost committed IPC reply recovers one original result without repeating SQL'
    )

    await attach(png)
    await settledImage()
    await fill('draft-product-clear')
    await js('window.api.clearNoteData()')
    await until(
      async () => (await js('window.__prepareEditingDrafts()')).dirty === false,
      'clear invalidates mounted journals'
    )
    assert.equal(hooks.draftAssetState().assetCount, 0)
    assert.equal(
      database((db) => db.prepare('SELECT COUNT(*) AS count FROM notes').get().count),
      0
    )
    assert.equal(
      (await journals()).some((record) => record.value.data?.content),
      false
    )
    scenarios.push(
      'business clear removes SQL and owned assets while preventing mounted forms from recreating drafts'
    )
    await imageEditCombination(png)
    await attach(png)
    await settledImage()
    await fill('draft-product-quit-owned')
    evidence.quitEntryAssetCount = hooks.draftAssetState().assetCount
    assert.equal(evidence.quitEntryAssetCount, 1, 'normal quit begins with an owned unsaved asset')
    await finalFrame()
    businessCompleted = true
    await results.finish({
      completed: true,
      window,
      summary: { scenarios, metrics, evidence },
      restore
    })
    await until(
      () =>
        js(
          `Boolean(document.querySelector('.confirm-card.active[aria-label="保留草稿后继续？"]'))`
        ),
      'normal quit asks the product draft confirmation'
    )
    await js(
      `Array.from(document.querySelectorAll('.confirm-card.active button')).find(button=>button.textContent.trim()==='保留并退出').click()`
    )
  } catch (error) {
    activeWrite?.release.resolve()
    activeReply?.release.resolve()
    console.error(error)
    await results.finish({ error, window, summary: { scenarios, metrics, evidence }, restore })
  }
}
function restore() {
  writeGate = null
  replyGate = null
  denyUnlink = false
  rejectNextReply = false
  Object.assign(filesystem, assetIo.original)
  ipcMain.handle = originalHandle
  syncBuiltinESMExports()
}
app.prependListener('quit', () => {
  if (!businessCompleted) return
  try {
    assert.equal(
      hooks.shutdownState().stages['draft-assets'].status,
      'complete',
      'normal product quit completes the draft asset ledger stage'
    )
    assert.equal(hooks.draftAssetState().assetCount, 0)
    assert.deepEqual(
      readdirSync(assetRoot).filter((name) => name.endsWith('.asset')),
      []
    )
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
})
app.once('ready', () => void run())
require(resolve('out/main/index.js'))
const chunk = readdirSync(resolve('out/main/chunks')).find((name) =>
  /^index-[\w-]+\.js$/.test(name)
)
assert.ok(chunk, 'built main entry chunk exists')
require(resolve('out/main/chunks', chunk))
