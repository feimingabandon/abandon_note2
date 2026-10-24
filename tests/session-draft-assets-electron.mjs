import { app, BrowserWindow, ipcMain } from 'electron'
import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { createSettingsWriteSource } from '../src/main/settings/settings-write-source.js'
import { createSessionDraftAssetsRuntime } from '../src/main/drafts/session-draft-assets-runtime.js'
import { registerDraftAssetsIpc } from '../src/main/ipc/register-draft-assets-ipc.js'
import { readSessionDraftAssetPayload } from '../src/main/drafts/session-draft-assets.js'
import { createElectronGuiResultLifecycle } from './helpers/electron-gui-result-lifecycle.mjs'
import { waitForFixtureFrame } from './helpers/electron-fixture-frame.mjs'

const require = createRequire(import.meta.url)
const { buildSync } = require('esbuild')
const lifecycle = createElectronGuiResultLifecycle({
  app,
  BrowserWindow,
  suite: 'tests/session-draft-assets-electron.mjs',
  mode: 'electron-session-draft-assets-production-ports',
  prefix: 'abandon-draft-ports-',
  timeoutMs: 90000,
  metadata: {
    production: [
      'asset core',
      'runtime',
      'IPC registrar',
      'private preload client',
      'settings document source'
    ],
    scope:
      'direct source imports, real sandboxed contextBridge and disk; no application entry or renderer forms',
    consumer: 'fixed main-only callback, not a note create/save command',
    recovery: 'simulated prior session with real files; not process termination or power loss',
    input: 'programmatic API lifecycle, no native keyboard or focus claim'
  }
})
const { assert, root } = lifecycle
app.setPath('userData', root)
const assetRoot = join(root, 'session-draft-assets')
const fixtureFile = join(root, 'ports.html')
const childFile = join(root, 'child.html')
const preloadFile = join(root, 'ports-preload.cjs')
const events = [],
  registered = new Set(),
  activeGates = new Set()
const diagnosticErrors = []
const frameEvidence = {}
let window, extraWindow, runtime, previousRuntime, unregister
let phase = 'startup',
  settingsWritesSealed = false,
  ioGate,
  denyUnlink = false
let source
const startedAt = Date.now(),
  deadlineAt = startedAt + 75000
const q = JSON.stringify
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sample = {
  base64: Buffer.from('owned-draft-port-bytes').toString('base64'),
  ext: 'png',
  name: 'port.png'
}
const publicOwner = (lease, key) => ({
  sessionId: lease.sessionId,
  key,
  ownerId: lease.ownerId,
  generation: lease.generation
})
function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function held() {
  const gate = { entered: deferred(), release: deferred(), captured: false }
  activeGates.add(gate)
  return gate
}
function release(gate) {
  gate.release.resolve()
  activeGates.delete(gate)
  if (ioGate === gate) ioGate = null
}
async function until(read, label) {
  while (Date.now() < deadlineAt) {
    const value = await read()
    if (value) return value
    await new Promise((done) => setTimeout(done, 10))
  }
  throw new Error(phase + ': ' + label)
}
const js = (code) => window.webContents.executeJavaScript(code)
const current = () =>
  runtime.captureDocument(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
    source.captureCurrent()
  )
const io = {
  async writeFile(...args) {
    const result = await fs.writeFile(...args)
    const gate = ioGate
    if (gate && !gate.captured) {
      gate.captured = true
      gate.entered.resolve()
      await gate.release.promise
    }
    return result
  },
  async unlink(path) {
    if (denyUnlink)
      throw Object.assign(new Error(`EACCES: unlink '${path}'`), {
        code: 'EACCES',
        path,
        syscall: 'unlink'
      })
    return fs.unlink(path)
  }
}
const logger = {
  error: (...args) => {
    diagnosticErrors.push(args)
    events.push({
      phase,
      event: 'main-error',
      text: args.map((value) => value?.stack || String(value)).join(' ')
    })
  },
  warn: (...args) => events.push({ phase, event: 'main-warning', text: args.map(String).join(' ') })
}
const managedIpc = {
  handle(channel, handler) {
    registered.add(channel)
    ipcMain.handle(channel, async (event, ...args) => {
      const entry = { phase, event: 'ipc', channel, pending: true }
      events.push(entry)
      try {
        const result = await handler(event, ...args)
        entry.ok = result?.ok
        entry.code = result?.error?.code
        return result
      } finally {
        entry.pending = false
      }
    })
  },
  removeHandler(channel) {
    registered.delete(channel)
    ipcMain.removeHandler(channel)
  }
}
async function reload() {
  const loaded = new Promise((resolve, reject) => {
    const fail = (_event, code, description, _url, main) => {
      if (main) {
        clean()
        reject(new Error(`${code}: ${description}`))
      }
    }
    const done = () => {
      clean()
      resolve()
    }
    const clean = () => {
      window.webContents.removeListener('did-fail-load', fail)
      window.webContents.removeListener('did-finish-load', done)
    }
    window.webContents.on('did-fail-load', fail)
    window.webContents.once('did-finish-load', done)
  })
  window.webContents.reload()
  await loaded
}
async function prepareEvidenceFrame() {
  const viewport = await js('({width:innerWidth,height:innerHeight})')
  const marker = [49, 131, 223]
  const paint = waitForFixtureFrame({
    webContents: window.webContents,
    name: 'production-draft-ports-final',
    marker,
    palette: 'white',
    viewport
  })
  frameEvidence.trace = paint.trace
  let timer, failure
  const expired = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Production ports final frame was not presented within 2000ms')),
      2000
    )
  })
  const presented = Promise.race([paint.ready, expired])
  presented.catch(() => {})
  try {
    frameEvidence.before = await js(`(() => {
      const marker=document.createElement('div');marker.style.cssText='position:fixed;left:0;top:154px;width:24px;height:24px;background:rgb(${marker.join(',')});z-index:100';
      const cue=document.createElement('div');cue.style.cssText='position:fixed;left:24px;top:154px;width:1px;height:1px;z-index:100';
      const palette=document.createElement('div');palette.style.cssText='position:fixed;left:calc(5vw - 8px);top:calc(20vh - 8px);width:16px;height:16px;background:white;z-index:100';
      document.body.append(marker,cue,palette);
      const state={active:true,raf:null,ticks:0};window.__portsFrame=state;
      const tick=()=>{if(!state.active)return;cue.style.background=(++state.ticks%2)?'black':'white';state.raf=requestAnimationFrame(tick)};
      state.raf=requestAnimationFrame(tick);
      return {visibility:document.visibilityState,focused:document.hasFocus()};
    })()`)
    await presented
    assert.ok(
      paint.trace.selected,
      'new fixture generation must be actually presented before final screenshot'
    )
  } catch (error) {
    failure = error
  } finally {
    clearTimeout(timer)
    paint.close()
    try {
      frameEvidence.stopped = await js(
        `(() => { const s=window.__portsFrame;if(s){s.active=false;cancelAnimationFrame(s.raf);s.raf=null}return {active:s?.active,scheduled:s?.raf!=null,ticks:s?.ticks,visibility:document.visibilityState}; })()`
      )
      assert.equal(frameEvidence.stopped.active, false)
      assert.equal(frameEvidence.stopped.scheduled, false)
    } catch (error) {
      frameEvidence.stopError = error.stack || error.message
      failure ||= error
    }
    try {
      writeFileSync(
        join(process.env.ABANDON_TEST_EVIDENCE_DIR || root, 'ports-frame-evidence.json'),
        JSON.stringify(frameEvidence, null, 2),
        { flag: 'wx' }
      )
    } catch (error) {
      failure ||= error
    }
  }
  if (failure) throw failure
}
async function run() {
  source = createSettingsWriteSource({
    getMainWindow: () => window,
    getActiveWindowName: () => 'main',
    getActiveRendererLocation: () => ({ type: 'file', value: fixtureFile }),
    assertCanWrite: () => {
      if (settingsWritesSealed) throw new Error('settings writes sealed by fixture')
    }
  })
  ipcMain.handle('settings:write-context', (event) => source.issue(event))
  buildSync({
    stdin: {
      contents: `import { contextBridge, ipcRenderer } from 'electron';
        import { createSettingsClient } from './src/preload/settings-client.js';
        import { createDraftAssetsClient } from './src/preload/draft-assets-client.js';
        const settings = createSettingsClient(ipcRenderer);
        const client = createDraftAssetsClient({ invoke: settings.invoke.bind(settings) });
        const attempt = async call => { try { return { ok: true, value: await call() } } catch(error) { return { ok:false, code:error.code, message:error.message } } };
        contextBridge.exposeInMainWorld('draftPort', {
          openOwner: (key,resume) => client.openOwner(key,resume),
          stage: (owner,image) => client.stage(owner,image),
          preview: (owner,id) => client.preview(owner,id),
          release: (owner,ids) => client.release(owner,ids),
          operationState: (owner,id) => client.operationState(owner,id),
          waitHandoff: (owner,id) => client.waitHandoff(owner,id),
          cancelOwner: owner => client.cancelOwner(owner),
          dispose: () => client.dispose(),
          tryOpen: (key,resume) => attempt(() => client.openOwner(key,resume)),
          tryStage: (owner,image) => attempt(() => client.stage(owner,image)),
          tryPreview: (owner,id) => attempt(() => client.preview(owner,id)),
          invalidSource: () => ipcRenderer.invoke('draft-assets:open-owner', {key:'invalid-source'}, {token:'invalid',scope:'main'})
        });`,
      resolveDir: process.cwd(),
      sourcefile: 'draft-ports-fixture-preload.js'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: preloadFile
  })
  writeFileSync(childFile, '<!doctype html><title>Untrusted subframe probe</title>')
  writeFileSync(
    fixtureFile,
    '<!doctype html><title>Draft asset production ports</title><h1>Production draft asset ports</h1><p>Direct source fixture; renderer form integration follows in E5.4.2.</p><iframe src="child.html"></iframe><pre id="status">Running isolated lifecycle verification</pre>'
  )
  const consumerGate = held()
  let consumerCalls = 0
  const options = {
    root: assetRoot,
    sessionId: randomUUID(),
    settingsWriteSource: source,
    io,
    consumeAssets: async (descriptors) => {
      consumerCalls++
      const bytes = await readSessionDraftAssetPayload(descriptors[0])
      consumerGate.captured = true
      consumerGate.entered.resolve()
      await consumerGate.release.promise
      return { size: bytes.length, sha256: hash(bytes) }
    }
  }
  runtime = createSessionDraftAssetsRuntime(options)
  await runtime.initialize()
  unregister = registerDraftAssetsIpc({
    ipcMain: managedIpc,
    runtime,
    logger
  })
  window = new BrowserWindow({
    width: 900,
    height: 600,
    show: true,
    frame: false,
    webPreferences: {
      preload: preloadFile,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      backgroundThrottling: false
    }
  })
  window.removeMenu()
  const painted = new Promise((resolve) => window.once('ready-to-show', resolve))
  await window.loadFile(fixtureFile)
  await painted
  phase = 'unused-owner-recovery-after-lost-opening-binding'
  const unrecorded = await js("window.draftPort.openOwner('ports:unrecorded-opening')")
  // Drop the entire document/preload map without persisting or passing a resume receipt.
  await reload()
  const recoveredEmpty = await js("window.draftPort.openOwner('ports:unrecorded-opening')")
  assert.equal(
    recoveredEmpty.ownerId,
    unrecorded.ownerId,
    'an unused owner is recovered across a real document replacement'
  )
  assert.equal(JSON.stringify(recoveredEmpty).includes('capability'), false)
  const recoveredAsset = await js(`window.draftPort.stage(${q(recoveredEmpty)},${q(sample)})`)
  assert.equal(
    (await js(`window.draftPort.preview(${q(recoveredEmpty)},${q(recoveredAsset.assetId)})`))
      .sha256,
    recoveredAsset.sha256
  )
  await js(`window.draftPort.release(${q(recoveredEmpty)},${q([recoveredAsset.assetId])})`)
  assert.equal(await js(`window.draftPort.cancelOwner(${q(recoveredEmpty)})`), true)
  phase = 'document-identity-and-private-capability'
  const owner = await js("window.draftPort.openOwner('ports:main')")
  assert.equal(JSON.stringify(owner).includes('capability'), false)
  assert.equal(JSON.stringify(owner).includes(assetRoot), false)
  assert.deepEqual(await js("window.draftPort.openOwner('ports:main')"), owner)
  settingsWritesSealed = true
  const asset = await js(`window.draftPort.stage(${q(owner)},${q(sample)})`)
  assert.equal(asset.size, Buffer.from(sample.base64, 'base64').length)
  assert.equal(JSON.stringify(asset).includes('path'), false)
  const preview = await js(`window.draftPort.preview(${q(owner)},${q(asset.assetId)})`)
  assert.equal(Buffer.from(preview.bytes).toString(), 'owned-draft-port-bytes')
  assert.equal((await js('window.draftPort.invalidSource()')).ok, false)
  assert.equal((await js("window.frames[0].draftPort.tryOpen('ports:subframe')")).ok, false)
  extraWindow = new BrowserWindow({
    show: false,
    webPreferences: { preload: preloadFile, sandbox: true, contextIsolation: true }
  })
  extraWindow.removeMenu()
  await extraWindow.loadFile(childFile)
  assert.equal(
    (
      await extraWindow.webContents.executeJavaScript(
        "window.draftPort.tryOpen('ports:other-window')"
      )
    ).ok,
    false
  )
  extraWindow.destroy()
  extraWindow = null
  const heldWrite = held()
  ioGate = heldWrite
  phase = 'committed-reload-invalidates-old-document'
  const beforeOldStage = events.length
  await js(
    `void window.draftPort.tryStage(${q(owner)},${q(sample)}).then(result=>{window.oldResult=result});true`
  )
  await until(() => heldWrite.captured, 'stage did not reach actual owned IO')
  await reload()
  const rebound = await js(`window.draftPort.openOwner('ports:main',${q(owner)})`)
  assert.deepEqual(rebound, owner)
  release(heldWrite)
  const reloadOwner = Symbol('reload-observation')
  await runtime.sealAndDrain(reloadOwner)
  assert.equal(runtime.resume(reloadOwner), true)
  const expiredStage = events
    .slice(beforeOldStage)
    .find((entry) => entry.channel === 'draft-assets:stage')
  await until(() => expiredStage && !expiredStage.pending, 'old IPC response did not settle')
  assert.equal(expiredStage.ok, false)
  assert.equal(expiredStage.code, 'DRAFT_DOCUMENT_EXPIRED')
  assert.equal(
    (await js(`window.draftPort.preview(${q(rebound)},${q(asset.assetId)})`)).sha256,
    asset.sha256
  )
  assert.equal(
    runtime.snapshot().assets.length,
    1,
    'late old stage must not add a second retained asset'
  )
  phase = 'clear-sql-failure-keeps-admitted-stage'
  const secondWrite = held()
  ioGate = secondWrite
  await js(
    `void window.draftPort.tryStage(${q(rebound)},${q(sample)}).then(result=>{window.admittedResult=result});true`
  )
  await until(() => secondWrite.captured, 'admitted stage did not reach IO')
  const clearOwner = Symbol('business-clear')
  let drained = false
  const drain = runtime.sealAndDrain(clearOwner).then(() => {
    drained = true
  })
  assert.equal((await js(`window.draftPort.tryStage(${q(rebound)},${q(sample)})`)).ok, false)
  assert.equal(drained, false)
  release(secondWrite)
  await drain
  await until(
    () => js('Boolean(window.admittedResult)'),
    'admitted renderer response did not settle'
  )
  assert.equal((await js('window.admittedResult')).ok, true)
  // A failed SQL clear never calls clearAfterCommit. Resume must preserve owners.
  assert.equal(runtime.resume(clearOwner), true)
  assert.equal(runtime.snapshot().assets.length, 2)
  assert.equal(
    (await js(`window.draftPort.preview(${q(rebound)},${q(asset.assetId)})`)).sha256,
    asset.sha256
  )
  const unknown = join(assetRoot, 'unknown-user-file.txt')
  await fs.writeFile(unknown, 'retain unknown bytes')
  phase = 'committed-clear-owned-cleanup-failure-and-explicit-recovery'
  const committedClearOwner = Symbol('committed-clear')
  await runtime.sealAndDrain(committedClearOwner)
  denyUnlink = true
  const failure = await runtime.clearAfterCommit(committedClearOwner).then(
    () => null,
    (error) => error
  )
  assert.ok(failure)
  assert.match(failure.message, /EACCES|清理|清空/)
  assert.equal(runtime.snapshot().assets.length, 2)
  denyUnlink = false
  await runtime.clearAfterCommit(committedClearOwner)
  assert.equal(runtime.snapshot().assets.length, 0)
  assert.equal(runtime.resume(committedClearOwner), true)
  assert.equal(await fs.readFile(unknown, 'utf8'), 'retain unknown bytes')
  phase = 'new-session-reclaims-only-proven-old-ownership'
  const abandonedOwner = await js("window.draftPort.openOwner('ports:abandoned')")
  await js(`window.draftPort.stage(${q(abandonedOwner)},${q(sample)})`)
  previousRuntime = runtime
  await previousRuntime.sealAndDrain(Symbol('simulated-prior-session'))
  runtime = createSessionDraftAssetsRuntime({ ...options, sessionId: randomUUID() })
  await runtime.initialize()
  assert.equal(await fs.readFile(unknown, 'utf8'), 'retain unknown bytes')
  const remaining = await fs.readdir(assetRoot)
  assert.deepEqual(remaining, ['unknown-user-file.txt'])
  unregister()
  unregister = registerDraftAssetsIpc({ ipcMain: managedIpc, runtime, logger })
  phase = 'fixed-main-consumer-pin-drains-on-dispose'
  const document = current()
  const lease = runtime.openOwner(document, 'ports:main-consumer')
  const sourceAsset = await runtime.stage(document, lease, sample)
  const operation = runtime.beginHandoff(document, lease, [sourceAsset.assetId])
  const waiting = runtime.waitHandoff(document, lease, operation)
  const waitResult = waiting.then(
    (value) => ({ value }),
    (error) => ({ error: error.message })
  )
  await until(() => consumerGate.captured, 'fixed main consumer did not start')
  assert.equal(consumerCalls, 1)
  assert.equal(runtime.snapshot().assets[0].pins, 1)
  let disposed = false
  const disposing = runtime.dispose().then(() => {
    disposed = true
  })
  const metadata = publicOwner(lease, 'ports:main-consumer')
  assert.equal((await js(`window.draftPort.tryOpen('ports:stopped',${q(null)})`)).ok, false)
  assert.equal(disposed, false)
  release(consumerGate)
  await disposing
  const consumed = await waitResult
  assert.equal(consumed.error, undefined)
  assert.equal(consumed.value.size, Buffer.from(sample.base64, 'base64').length)
  assert.equal(consumerCalls, 1)
  assert.equal(runtime.snapshot().assets.length, 0)
  assert.equal(await fs.readFile(unknown, 'utf8'), 'retain unknown bytes')
  assert.equal(JSON.stringify(metadata).includes('capability'), false)
  await js('window.draftPort.dispose()')
  assert.equal((await js("window.draftPort.tryOpen('ports:disposed-client')")).ok, false)
  phase = 'complete'
  await js(
    "document.getElementById('status').textContent='Production source ports verified; application integration remains E5.4.2'"
  )
  await prepareEvidenceFrame()
  await finish()
}
let closing = false
const businessTimer = setTimeout(
  () => void finish(new Error(phase + ': 75000ms business deadline exceeded')),
  75000
)
async function finish(error = null) {
  if (closing) return
  closing = true
  clearTimeout(businessTimer)
  for (const gate of activeGates) release(gate)
  await lifecycle.finish({
    completed: !error,
    error,
    window,
    summary: {
      phase,
      startedAt,
      deadlineAt,
      events,
      diagnostics: diagnosticErrors.length,
      frameEvidence
    },
    restore: async () => {
      denyUnlink = false
      for (const gate of activeGates) release(gate)
      await runtime?.dispose()
      await previousRuntime?.dispose()
      unregister?.()
      ipcMain.removeHandler('settings:write-context')
      source?.stop()
      extraWindow?.destroy()
      assert.equal(activeGates.size, 0)
      // The first registrar records removal; subsequent registration is also disposed.
      assert.equal(registered.size, 0)
    }
  })
}
void app
  .whenReady()
  .then(run)
  .catch((error) => {
    console.error(error)
    void finish(error)
  })
